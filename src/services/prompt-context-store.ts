/**
 * prompt-context-store.ts
 *
 * Per-turn sidecar for UserPromptSubmit hook 注入（#794 P1 方向 B）。
 *
 * daemon 在把 user turn 写入 PTY **之前**，把该轮的 envelope（reminder/whiteboard）
 * 写到这里；`botmux user-prompt-hook` 子进程被 Claude Code 唤起时，按 stdin 里
 * `prompt` 的内容指纹读回对应 sidecar，以 additionalContext 形式注入为该轮
 * system-reminder。
 *
 * 为什么用文件而不是 IPC：hook 子进程没有 daemon 通道，且可能跑在文件沙盒里。
 * SESSION_DATA_DIR 下的路径会被沙盒 allow-list 绑定（见 fs-policy.ts），纯文件读
 * 即可。任何读失败/未命中 → undefined（调用方空输出，fail-open）。
 *
 * 指纹策略（review 阻断 2 修复）：
 * - 主键 = 全量 sha256(normalise(text))：精确匹配，无前缀碰撞。
 * - 兜底 = 30 字符前缀：仅当全量未命中时（paste 模式污染尾部），扫描 sidecar
 *   按前缀匹配；恰好 1 个匹配才用，0 或 >1 都不注入（fail-safe）。
 * - 读后消费：成功读取后删除 sidecar，防止 stale 双注入（auto→off 切换后
 *   hook 仍触发时读到旧 sidecar）。
 * - inline 检测：prompt 含 <botmux_reminder> 说明是 inline 模式，不注入。
 * - 原子写：tmp + rename，避免 type-ahead 并发写导致 JSON 截断。
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config.js';
import { normaliseForFingerprint } from './claude-transcript.js';

/** sidecar 保留上限：超出按 mtime 淘汰最旧的。 */
const SIDECAR_MAX_FILES = 100;
/** sidecar 最长保留 24h（resume 后旧轮的 hook 不会重放，只有新轮才触发）。 */
const SIDECAR_TTL_MS = 24 * 60 * 60 * 1000;
/** 前缀兜底匹配长度：与 makeSubmitFingerprint 一致，足以覆盖 paste 污染前的完好区。 */
const PREFIX_FALLBACK_LEN = 30;

function sessionDir(sessionId: string): string {
  return join(config.session.dataDir, 'prompt-ctx', sessionId);
}

/** 全量指纹：normalise 后 sha256（hex）。主键，无前缀碰撞。 */
export function fingerprintPromptText(text: string): string {
  return createHash('sha256').update(normaliseForFingerprint(text), 'utf8').digest('hex');
}

/** 前缀指纹：normalise 后取前 N 字符。仅用于 paste 污染时的兜底匹配。 */
function prefixOf(text: string): string {
  return normaliseForFingerprint(text).slice(0, PREFIX_FALLBACK_LEN);
}

/**
 * daemon 侧：写 per-turn sidecar。best-effort——写失败只意味着该轮 hook no-op
 * （reminder 丢失），不允许影响消息主路径。原子写（tmp + rename）。
 */
export function writePromptContext(sessionId: string, ptyText: string, envelope: string): void {
  try {
    const dir = sessionDir(sessionId);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = join(dir, `${fingerprintPromptText(ptyText)}.json`);
    const tmp = `${file}.tmp-${process.pid}`;
    const payload = JSON.stringify({
      version: 1,
      envelope,
      prefix: prefixOf(ptyText),
      createdAt: Date.now(),
    }) + '\n';
    writeFileSync(tmp, payload, { mode: 0o600 });
    renameSync(tmp, file);
    pruneSidecars(dir, file);
  } catch { /* best-effort */ }
}

/**
 * hook 侧：按 prompt 内容指纹读回 envelope。
 *
 * 匹配策略：
 * 1. inline 检测：prompt 含 <botmux_reminder> → inline 模式，不注入（防双注入）。
 * 2. 全量指纹精确匹配。
 * 3. 未命中时前缀兜底：扫描 sidecar，前缀恰好 1 个匹配才用（paste 污染场景）。
 * 4. 读后消费：成功读取后删除 sidecar（防 stale 双注入）。
 *
 * 未命中/损坏/不可读 → undefined。
 */
export function readPromptContext(sessionId: string, prompt: string): string | undefined {
  // inline 模式的 prompt 已含 reminder，不注入（auto→off 切换后 hook 仍触发时防双注入）
  if (prompt.includes('<botmux_reminder>')) return undefined;
  try {
    const dir = sessionDir(sessionId);
    if (!existsSync(dir)) return undefined;

    // 1. 全量指纹精确匹配
    const exactFile = join(dir, `${fingerprintPromptText(prompt)}.json`);
    let file = existsSync(exactFile) ? exactFile : undefined;

    // 2. 前缀兜底（paste 污染：尾部软换行变字面量，全量指纹失配）
    if (!file) {
      const prefix = prefixOf(prompt);
      if (prefix) {
        const matches = readdirSync(dir)
          .filter((f) => f.endsWith('.json'))
          .filter((f) => {
            try {
              const meta = JSON.parse(readFileSync(join(dir, f), 'utf8'));
              return typeof meta?.prefix === 'string' && meta.prefix === prefix;
            } catch { return false; }
          });
        // 恰好 1 个匹配才用；0 或 >1（碰撞）都不注入，fail-safe
        if (matches.length === 1) file = join(dir, matches[0]);
      }
    }

    if (!file) return undefined;
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    const envelope = typeof parsed?.envelope === 'string' ? parsed.envelope : undefined;
    if (envelope) {
      // 3. 读后消费：删除 sidecar，防止后续轮次读到 stale 内容
      try { unlinkSync(file); } catch { /* */ }
    }
    return envelope;
  } catch {
    return undefined;
  }
}

/**
 * 淘汰过期/超量 sidecar。best-effort，任何异常静默。
 * currentFile 显式保护：刚写的文件即使 mtime 相同也不淘汰（review 阻断 3）。
 * 同 mtime 按文件名稳定排序，消除淘汰不确定性。
 */
function pruneSidecars(dir: string, currentFile: string): void {
  try {
    const now = Date.now();
    const files = readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => {
        const full = join(dir, f);
        return { f, full, mtime: statSync(full).mtimeMs };
      })
      .sort((a, b) => {
        // 新的在前；同 mtime 按文件名升序（确定性）
        if (b.mtime !== a.mtime) return b.mtime - a.mtime;
        return a.f < b.f ? -1 : a.f > b.f ? 1 : 0;
      });
    let kept = 0;
    for (const entry of files) {
      const isCurrent = entry.full === currentFile;
      const expired = now - entry.mtime > SIDECAR_TTL_MS;
      const overLimit = kept >= SIDECAR_MAX_FILES;
      if (!isCurrent && (expired || overLimit)) {
        try { unlinkSync(entry.full); } catch { /* */ }
      } else {
        kept++;
      }
    }
  } catch { /* best-effort */ }
}

/**
 * 会话关闭时删除整个 sidecar 目录（与 turn-sends marker 同生命周期）。
 * best-effort：目录不存在/权限问题都静默，避免影响关闭主路径。
 */
export function removePromptContextDir(sessionId: string): void {
  try {
    rmSync(sessionDir(sessionId), { recursive: true, force: true });
  } catch { /* best-effort */ }
}
