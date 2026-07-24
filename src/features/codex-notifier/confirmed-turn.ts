import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import { atomicWriteFileSync } from '../../utils/atomic-write.js';
import { codexNotifierConfirmedTurnsDir } from './paths.js';

export const CODEX_NOTIFIER_CONFIRMED_TURN_TTL_MS = 7 * 24 * 60 * 60_000;
export const MAX_CODEX_NOTIFIER_CONFIRMED_TURNS = 2_048;
const CONFIRMED_TURN_FILE_PATTERN = /^[a-f0-9]{64}\.json$/;

export interface ConfirmedCodexTurn {
  sessionId: string;
  turnId: string;
  prompt: string;
}

function normalizedId(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  return value.trim().slice(0, 256);
}

function normalizedPrompt(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const prompt = value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!prompt) return undefined;
  return Array.from(prompt).slice(0, 300).join('');
}

function turnPath(dataDir: string, sessionId: string, turnId: string): string {
  const key = createHash('sha256').update(JSON.stringify([sessionId, turnId])).digest('hex');
  return join(codexNotifierConfirmedTurnsDir(dataDir), `${key}.json`);
}

/** 清理没有收到 Stop 的过期 turn，并限制本地用户提示词证明的保留数量。 */
export function pruneConfirmedCodexNotifierTurns(
  dataDir: string,
  options: {
    now?: number;
    ttlMs?: number;
    maxEntries?: number;
  } = {},
): number {
  const dir = codexNotifierConfirmedTurnsDir(dataDir);
  if (!existsSync(dir)) return 0;
  const now = options.now ?? Date.now();
  const ttlMs = options.ttlMs ?? CODEX_NOTIFIER_CONFIRMED_TURN_TTL_MS;
  const maxEntries = options.maxEntries ?? MAX_CODEX_NOTIFIER_CONFIRMED_TURNS;
  if (!Number.isFinite(now)
    || !Number.isSafeInteger(ttlMs)
    || ttlMs <= 0
    || !Number.isSafeInteger(maxEntries)
    || maxEntries <= 0) {
    throw new Error('codex_notifier_confirmed_turn_prune_options_invalid');
  }

  const files = readdirSync(dir)
    .filter(name => CONFIRMED_TURN_FILE_PATTERN.test(name))
    .flatMap(name => {
      try {
        const path = join(dir, name);
        const stat = statSync(path);
        return stat.isFile() ? [{ name, path, mtimeMs: stat.mtimeMs }] : [];
      } catch {
        return [];
      }
    })
    .sort((left, right) => right.mtimeMs - left.mtimeMs || left.name.localeCompare(right.name));

  let removed = 0;
  for (const [index, file] of files.entries()) {
    if (now - file.mtimeMs <= ttlMs && index < maxEntries) continue;
    try {
      unlinkSync(file.path);
      removed += 1;
    } catch {
      // 文件可能被并发 Stop 消费。
    }
  }
  return removed;
}

/** UserPromptSubmit 与 Stop 分属独立进程，用小文件持久化精确 turn 的用户来源证明。 */
export function confirmCodexNotifierTurn(
  dataDir: string,
  sessionIdValue: unknown,
  turnIdValue: unknown,
  promptValue: unknown,
): ConfirmedCodexTurn | undefined {
  const sessionId = normalizedId(sessionIdValue);
  const turnId = normalizedId(turnIdValue);
  const prompt = normalizedPrompt(promptValue);
  if (!sessionId || !turnId || !prompt) return undefined;
  const turn = { sessionId, turnId, prompt };
  const dir = codexNotifierConfirmedTurnsDir(dataDir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  atomicWriteFileSync(turnPath(dataDir, sessionId, turnId), `${JSON.stringify(turn)}\n`, {
    mode: 0o600,
    durable: true,
    followTargetSymlink: false,
  });
  pruneConfirmedCodexNotifierTurns(dataDir);
  return turn;
}

/** 读取精确 turn 的来源证明；损坏、错配或旧格式都按未确认处理。 */
export function readConfirmedCodexNotifierTurn(
  dataDir: string,
  sessionIdValue: unknown,
  turnIdValue: unknown,
): ConfirmedCodexTurn | undefined {
  const sessionId = normalizedId(sessionIdValue);
  const turnId = normalizedId(turnIdValue);
  if (!sessionId || !turnId) return undefined;
  const path = turnPath(dataDir, sessionId, turnId);
  try {
    if (Date.now() - statSync(path).mtimeMs > CODEX_NOTIFIER_CONFIRMED_TURN_TTL_MS) {
      try {
        unlinkSync(path);
      } catch {
        // 文件可能被并发清理。
      }
      return undefined;
    }
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    if (
      parsed?.sessionId !== sessionId
      || parsed?.turnId !== turnId
      || typeof parsed?.prompt !== 'string'
      || !parsed.prompt.trim()
    ) {
      return undefined;
    }
    const prompt = normalizedPrompt(parsed.prompt);
    return prompt ? { sessionId, turnId, prompt } : undefined;
  } catch {
    return undefined;
  }
}

/** Stop 已完成处理后移除证明；入队失败时保留，供同一 Stop 重试。 */
export function removeConfirmedCodexNotifierTurn(
  dataDir: string,
  sessionIdValue: unknown,
  turnIdValue: unknown,
): void {
  const sessionId = normalizedId(sessionIdValue);
  const turnId = normalizedId(turnIdValue);
  if (!sessionId || !turnId) return;
  try {
    unlinkSync(turnPath(dataDir, sessionId, turnId));
  } catch {
    // 文件不存在或已被并发 Stop 消费时无需处理。
  }
}
