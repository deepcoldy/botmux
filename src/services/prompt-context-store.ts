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
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config.js';
import { normaliseForFingerprint } from './claude-transcript.js';

/** sidecar 保留上限：超出按 mtime 淘汰最旧的。 */
const SIDECAR_MAX_FILES = 100;
/** sidecar 最长保留 24h（resume 后旧轮的 hook 不会重放，只有新轮才触发）。 */
const SIDECAR_TTL_MS = 24 * 60 * 60 * 1000;

function sessionDir(sessionId: string): string {
  return join(config.session.dataDir, 'prompt-ctx', sessionId);
}

/** 与 hook 子进程共享的指纹算法：空白折叠后全量 sha256（hex）。 */
export function fingerprintPromptText(text: string): string {
  return createHash('sha256').update(normaliseForFingerprint(text), 'utf8').digest('hex');
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
