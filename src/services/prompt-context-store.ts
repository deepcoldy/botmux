/**
 * prompt-context-store.ts
 *
 * Per-turn sidecar for UserPromptSubmit hook 注入（#794 P1 方向 B）。
 *
 * daemon 在把 user turn 写入 PTY **之前**，把该轮的 envelope（reminder/whiteboard）
 * 写到这里；`botmux user-prompt-hook` 子进程被 Claude Code 唤起时，按 stdin 里
 * `prompt` 的内容指纹，经 daemon IPC 向宿主 **claim/pop** 对应 envelope，以
 * additionalContext 形式注入为该轮 system-reminder。
 *
 * 为什么 claim/pop 在宿主侧（review HIGH-1/HIGH-2 修复）：
 * - HIGH-1：同一会话两轮内容相同的消息，旧实现以 `sha256(text)` 为文件名，后写
 *   覆盖前写，两个 hook 各读一次只有一轮 envelope 存活。现按 (fingerprint, nonce)
 *   存多条，claim 时按写入顺序 FIFO 弹出，每轮各自交付。
 * - HIGH-2：`prompt-ctx/<sid>` 在沙箱里是 read-only bind（fs-policy.ts），hook
 *   子进程在沙箱内 unlink 必 EROFS 且被吞，「读后消费」形同虚设。消费（unlink）
 *   改到宿主侧 daemon 执行，沙箱内只读不写；也绝不把目录改可写（那会给沙箱里的
 *   模型伪造 sidecar、向后续真 turn 注入高优先级 additionalContext 的能力）。
 *
 * 为什么用文件而不是纯内存：hook 子进程没有 daemon 通道时（旧路径/降级）仍可兜底，
 * 且 daemon 重启后未消费的 sidecar 不丢（24h TTL 兜底）。claim 走 daemon IPC，
 * 任何读失败/未命中 → undefined（调用方空输出，fail-open）。
 *
 * 指纹策略：
 * - 主键 = 全量 sha256(normalise(text))：精确匹配，无前缀碰撞。
 * - 兜底 = 30 字符前缀：仅当全量未命中时（paste 模式污染尾部），扫描 sidecar
 *   按前缀匹配；恰好 1 个匹配才用，0 或 >1 都不注入（fail-safe）。
 * - inline 检测：见 looksLikeInlineEnvelope（hook 客户端在 claim 前调用）。
 * - 原子写：tmp + rename，避免 type-ahead 并发写导致 JSON 截断。
 */
import { createHash, randomBytes } from 'node:crypto';
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

/** 进程内单调计数器：同一毫秒内的多次写入也能按 nonce 稳定排序（FIFO）。 */
let writeCounter = 0;

function sessionDir(sessionId: string): string {
  return join(config.session.dataDir, 'prompt-ctx', sessionId);
}

/** 全量指纹：normalise 后 sha256（hex）。主键，无前缀碰撞。 */
export function fingerprintPromptText(text: string): string {
  return createHash('sha256').update(normaliseForFingerprint(text), 'utf8').digest('hex');
}

/** 前缀指纹：normalise 后取前 N 字符。仅用于 paste 污染时的兜底匹配。 */
export function prefixOf(text: string): string {
  return normaliseForFingerprint(text).slice(0, PREFIX_FALLBACK_LEN);
}

/**
 * 判断 prompt 是否为 inline 模式的 envelope（reminder 在 <user_message> 之前）。
 *
 * hook 客户端在 claim 前调用：inline 模式不注入（防双注入）。
 *
 * 收严（review 绕过项）：旧实现取第一个 `<user_message>` 之前的文本再
 * `.includes('<botmux_reminder>')`，但 role/persona 文案是原样拼进 prompt 不转义的
 * （session-manager.ts renderRoleContextBlock），在 role 里塞一个伪造的
 * `<user_message>` 就能让切片在真 `<botmux_reminder>` 之前截断，绕过检测。
 *
 * 现改为：`<botmux_reminder>` 存在，且**其后**还有 `<user_message>` 块——证明
 * reminder 处于「user_message 之前」的 inline 位置，而不是用户正文里的字面量。
 * role 里伪造 `<user_message>` 不再能截断（真 reminder 之后仍有真 user_message）。
 */
export function looksLikeInlineEnvelope(prompt: string): boolean {
  const reminderIdx = prompt.indexOf('<botmux_reminder>');
  if (reminderIdx < 0) return false;
  return prompt.indexOf('<user_message>', reminderIdx) >= 0;
}

/**
 * daemon 侧：写 per-turn sidecar。best-effort——写失败只意味着该轮 hook no-op
 * （reminder 丢失），不允许影响消息主路径。原子写（tmp + rename）。
 *
 * 文件名带 nonce：同一 fingerprint（同正文）的多轮各自一条，claim 时 FIFO 弹出
 * （review HIGH-1：旧实现同名覆盖会丢一轮）。
 */
export function writePromptContext(sessionId: string, ptyText: string, envelope: string): void {
  try {
    const dir = sessionDir(sessionId);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const nonce = `${Date.now().toString(36)}-${(writeCounter++).toString(36)}-${randomBytes(3).toString('hex')}`;
    const file = join(dir, `${fingerprintPromptText(ptyText)}.${nonce}.json`);
    const tmp = `${file}.tmp-${process.pid}`;
    const payload = JSON.stringify({
      version: 2,
      envelope,
      prefix: prefixOf(ptyText),
      fingerprint: fingerprintPromptText(ptyText),
      createdAt: Date.now(),
    }) + '\n';
    writeFileSync(tmp, payload, { mode: 0o600 });
    renameSync(tmp, file);
    pruneSidecars(dir, file);
  } catch { /* best-effort */ }
}

/**
 * 宿主侧（daemon）claim/pop：按 fingerprint 取该会话最旧的一条未消费 envelope，
 * **先删文件再返回内容**（原子消费）。沙箱内 hook 经 IPC 调这里，不在沙箱里 unlink。
 *
 * 匹配策略：
 * 1. 全量指纹精确匹配：同 fingerprint 的多条按写入顺序（createdAt → 文件名）FIFO。
 * 2. 未命中时前缀兜底：扫描 sidecar，prefix 恰好 1 个匹配才用（paste 污染场景）。
 *
 * 未命中/损坏/不可读 → undefined。任何异常都不抛（fail-open）。
 */
export function claimPromptContext(
  sessionId: string,
  fingerprint: string,
  prefix?: string,
): string | undefined {
  try {
    const dir = sessionDir(sessionId);
    if (!existsSync(dir)) return undefined;

    // 1. 全量指纹精确匹配：同 fingerprint 的多条 FIFO
    const exactMatches = readdirSync(dir)
      .filter((f) => f.startsWith(`${fingerprint}.`) && f.endsWith('.json'))
      .map((f) => {
        const full = join(dir, f);
        try {
          const parsed = JSON.parse(readFileSync(full, 'utf8'));
          return {
            full,
            envelope: typeof parsed?.envelope === 'string' ? parsed.envelope : undefined,
            createdAt: typeof parsed?.createdAt === 'number' ? parsed.createdAt : 0,
          };
        } catch { return undefined; }
      })
      .filter((m): m is { full: string; envelope: string; createdAt: number } => !!m && !!m.envelope)
      .sort((a, b) => (a.createdAt !== b.createdAt ? a.createdAt - b.createdAt : a.full < b.full ? -1 : a.full > b.full ? 1 : 0));

    if (exactMatches.length > 0) return popSidecar(exactMatches[0].full, exactMatches[0].envelope);

    // 2. 前缀兜底（paste 污染：尾部软换行变字面量，全量指纹失配）
    if (prefix) {
      const matches = readdirSync(dir)
        .filter((f) => f.endsWith('.json'))
        .map((f) => {
          const full = join(dir, f);
          try {
            const parsed = JSON.parse(readFileSync(full, 'utf8'));
            return typeof parsed?.prefix === 'string' && parsed.prefix === prefix
              && typeof parsed?.envelope === 'string'
              ? { full, envelope: parsed.envelope as string }
              : undefined;
          } catch { return undefined; }
        })
        .filter((m): m is { full: string; envelope: string } => !!m);
      // 恰好 1 个匹配才用；0 或 >1（碰撞）都不注入，fail-safe
      if (matches.length === 1) return popSidecar(matches[0].full, matches[0].envelope);
    }

    return undefined;
  } catch {
    return undefined;
  }
}

/** 原子消费：先 unlink（宿主侧，沙箱外）再返回 envelope。unlink 失败则不返回
 * （避免同一 envelope 被多次 claim）。 */
function popSidecar(file: string, envelope: string): string | undefined {
  try {
    unlinkSync(file);
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
