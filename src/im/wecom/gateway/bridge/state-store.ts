/**
 * Persistence and serialisation for the bridge state document: `save()` rewrites
 * state.json (a failed write poisons the bridge), `enqueue()` is the single lane
 * that network-bound work runs on, and the start-up helpers read state.json and
 * clear write intermediates a killed process left behind.
 *
 * Functions taking `this: WecomBridge` are WecomBridge methods: they run with
 * `this` bound to the bridge (the class in ../bridge.ts forwards to them), so they
 * share its state and lane.
 */
import { lstatSync, mkdirSync, readFileSync, readdirSync, unlinkSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { atomicWriteFileSync, isAtomicWriteTempName } from '../../../../utils/atomic-write.js';
import {
  describeWecomStateWriteFailure,
  wecomStateWriteErrorCode,
  type WecomStateWriteFailure,
} from '../../contract/state-write-failure.js';
import type { WecomBridge } from '../bridge.js';
import type { State } from './types.js';

/**
 * state.json exists but is not a JSON object (cut short, empty, or another
 * value). The message never carries any of the file's text: the state holds
 * user messages, and this line goes to the gateway log.
 */
export class WecomStateFileUnreadableError extends Error {
  constructor() {
    super('企微状态文件内容不完整或已损坏，无法读取；原文件保持不变，请检查磁盘或从备份恢复后重启此连接');
    this.name = 'WecomStateFileUnreadableError';
  }
}

/** The parsed state document; throws WecomStateFileUnreadableError when it is not a JSON object. */
export function readWecomStateFile(stateFile: string): State {
  const text = readFileSync(stateFile, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // The parser's own message can quote the text it failed on.
    throw new WecomStateFileUnreadableError();
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new WecomStateFileUnreadableError();
  }
  return parsed as State;
}

/**
 * Write the state document, unless it is exactly what the last successful write
 * put on disk (an idle tick then touches nothing). The write is atomic and
 * durable: a unique temp file next to state.json, fsynced, renamed over it, and
 * the directory fsynced. A state.json that is a symlink is replaced, never
 * written through. Synchronous, so a caller's "save, then send" order holds.
 *
 * Any failure poisons the bridge (nothing more is processed until a restart) and
 * is rethrown. The first one is logged once — its cause, error code and the
 * state directory, never the error's own message — and reported once to
 * `onStateWriteFailure`, whose failure (thrown or rejected) changes nothing here.
 */
export function save(this: WecomBridge): void {
  try {
    const data = JSON.stringify(this.state);
    if (data === this.savedState) {
      return;
    }
    mkdirSync(dirname(this.options.stateFile), { recursive: true, mode: 0o700 });
    atomicWriteFileSync(this.options.stateFile, data, { mode: 0o600, durable: true, followTargetSymlink: false });
    this.savedState = data;
  } catch (error) {
    const first = !this.poisoned;
    const failure: WecomStateWriteFailure | undefined = first
      ? {
        ...withCode(wecomStateWriteErrorCode((error as NodeJS.ErrnoException | undefined)?.code)),
        at: Date.now(),
        directory: dirname(this.options.stateFile),
      }
      : undefined;
    if (failure) {
      (this.options.log ?? (line => console.error(line)))(stateWriteFailureLine(failure, errorKind(error)));
    }
    this.poisoned = true;
    if (failure) {
      try {
        const reported = this.options.onStateWriteFailure?.(failure);
        if (reported) {
          void Promise.resolve(reported).catch(() => {});
        }
      } catch { /* reporting the failure never changes what it does */ }
    }
    throw error;
  }
}

function withCode(code: string | undefined): { code?: string } {
  return code ? { code } : {};
}

/** The class name of an error, when it is a plain identifier (it goes to the gateway log). */
function errorKind(error: unknown): string | undefined {
  const name = error instanceof Error ? error.name : undefined;
  return typeof name === 'string' && /^[A-Za-z][A-Za-z0-9]{0,39}$/.test(name) ? name : undefined;
}

/**
 * The gateway log's line for a failed state write: what went wrong, the error
 * code, the state directory, and what to do before restarting the connection.
 * A failure without a code has no cause to name, and the Dashboard sends its
 * reader to this line: it carries the kind of the error instead.
 */
function stateWriteFailureLine(failure: WecomStateWriteFailure, kind: string | undefined): string {
  const { cause, code, reason, action } = describeWecomStateWriteFailure(failure.code);
  // `other` already names the code in its reason.
  const shownCode = code && cause !== 'other' ? `（${code}）` : '';
  const shownKind = cause === 'unknown' && kind ? `（错误类型 ${kind}）` : '';
  const todo = cause === 'unknown' ? '排查后重启此连接' : `${action}，然后重启此连接`;
  return `[wecom] 状态文件写入失败${shownCode}：${reason}${shownKind}，状态目录 ${failure.directory}。`
    + `网关已停止处理消息；${todo}`;
}

export function enqueue<T>(this: WecomBridge, fn: () => Promise<T>): Promise<T> {
  return this.serial.run(() => {
    // Judged when the task starts, not when it is queued: a write that failed
    // while it waited stops it too.
    if (this.poisoned) {
      throw new Error('状态写入失败，请修复磁盘后重启企微网关');
    }
    return fn();
  });
}

/**
 * How long a write intermediate must have been left unmodified before start-up
 * removes it. The instance lock is per BotID, while the state directory comes
 * from configuration: two connections misconfigured onto one directory must not
 * lose a write in progress to each other's start-up.
 */
export const WECOM_STALE_TEMP_AGE_MS = 60_000;

/**
 * Remove the write intermediates of `stateFile` a killed process left in its
 * directory: `<name>.<pid>.<8 hex>.tmp` (atomic-write) and the fixed
 * `<name>.tmp` of earlier versions, once last modified more than
 * WECOM_STALE_TEMP_AGE_MS ago (a modification time in the future is never
 * stale). Regular files only (lstat: a symlink or a directory is left alone);
 * any error is ignored, it never blocks a start. Call it holding the
 * connection's instance lock, before the bridge exists.
 */
export function removeStaleWecomStateTemps(stateFile: string): void {
  const directory = dirname(stateFile);
  const name = basename(stateFile);
  let entries: string[];
  try {
    entries = readdirSync(directory);
  } catch {
    return;
  }
  for (const entry of entries) {
    const intermediate = entry === `${name}.tmp` || (entry.startsWith(`${name}.`) && isAtomicWriteTempName(entry));
    if (!intermediate) {
      continue;
    }
    try {
      const path = join(directory, entry);
      const stat = lstatSync(path);
      if (stat.isFile() && stat.mtimeMs < Date.now() - WECOM_STALE_TEMP_AGE_MS) {
        unlinkSync(path);
      }
    } catch { /* best effort */ }
  }
}
