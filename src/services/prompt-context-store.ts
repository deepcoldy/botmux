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
 * 指纹对齐：两端都对「实际写入 PTY 的文本」做 normaliseForFingerprint（空白折叠）
 * 后再 sha256——容忍 tmux send-keys 逐行写入带来的空白差异，且不依赖写入/触发时序
 * （type-ahead 多轮排队时按内容取交集，而非按时间取最新）。
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config.js';
import { normaliseForFingerprint } from './claude-transcript.js';

/** sidecar 保留上限：超出按 mtime 淘汰最旧的。 */
const SIDECAR_MAX_FILES = 100;
/** sidecar 最长保留 24h（resume 后旧轮的 hook 不会重放，只有新轮才触发）。 */
const SIDECAR_TTL_MS = 24 * 60 * 60 * 1000;
/**
 * 指纹只取正常化文本的前缀，不取全串：
 * writeInput 逐行 send-keys 时，长行会把 Ink 顶进 paste 模式，此后 `\`+Enter
 * 软换行退化成字面量（见 claude-code.ts writeInput 注释），Claude 记到 prompt 里
 * 的尾部文本与 daemon 写入的 ptyText 不一致。全串 sha256 会因此失配 → sidecar
 * miss → 该轮 reminder 静默丢失。
 *
 * 前缀策略：paste 模式只污染「触发它的那行之后」的软换行，首行（含 <user_message>
 * 骨架）始终完好。30 字符前缀与久经考验的 makeSubmitFingerprint 同长，始终落在
 * 完好区内（首行短则前缀跨入第二行内容，污染在第二行之后的换行，仍完好）。
 * 同会话内前缀碰撞是 benign 的：envelope（reminder/whiteboard）是会话级稳定的。
 */
const FINGERPRINT_PREFIX_LEN = 30;

function sessionDir(sessionId: string): string {
  return join(config.session.dataDir, 'prompt-ctx', sessionId);
}

/** 与 hook 子进程共享的指纹算法：空白折叠后取前缀 sha256（hex）。 */
export function fingerprintPromptText(text: string): string {
  const prefix = normaliseForFingerprint(text).slice(0, FINGERPRINT_PREFIX_LEN);
  return createHash('sha256').update(prefix, 'utf8').digest('hex');
}

/**
 * daemon 侧：写 per-turn sidecar。best-effort——写失败只意味着该轮 hook no-op
 * （reminder 丢失），不允许影响消息主路径。
 */
export function writePromptContext(sessionId: string, ptyText: string, envelope: string): void {
  try {
    const dir = sessionDir(sessionId);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = join(dir, `${fingerprintPromptText(ptyText)}.json`);
    const payload = JSON.stringify({ version: 1, envelope, createdAt: Date.now() }) + '\n';
    writeFileSync(file, payload, { mode: 0o600 });
    pruneSidecars(dir);
  } catch { /* best-effort */ }
}

/**
 * hook 侧：按 prompt 内容指纹读回 envelope。未命中/损坏/不可读 → undefined。
 */
export function readPromptContext(sessionId: string, ptyText: string): string | undefined {
  try {
    const file = join(sessionDir(sessionId), `${fingerprintPromptText(ptyText)}.json`);
    if (!existsSync(file)) return undefined;
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    return typeof parsed?.envelope === 'string' ? parsed.envelope : undefined;
  } catch {
    return undefined;
  }
}

/** 淘汰过期/超量 sidecar。best-effort，任何异常静默。 */
function pruneSidecars(dir: string): void {
  try {
    const now = Date.now();
    const files = readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => ({ f, mtime: statSync(join(dir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    for (const [i, entry] of files.entries()) {
      if (i >= SIDECAR_MAX_FILES || now - entry.mtime > SIDECAR_TTL_MS) {
        try { unlinkSync(join(dir, entry.f)); } catch { /* */ }
      }
    }
  } catch { /* */ }
}

/**
 * 会话关闭时删除整个 sidecar 目录（与 turn-sends marker 同生命周期）。
 * best-effort：目录不存在/权限问题都静默，避免影响关闭主路径。
 */
export function removePromptContextDir(sessionId: string): void {
  try {
    rmSync(sessionDir(sessionId), { recursive: true, force: true });
  } catch { /* */ }
}
