import { join } from 'node:path';

/**
 * Per-session diagnostic trail for the dsh-tui ready channel.
 *
 * The writer is the generated dsh-tui wrapper plugin, which runs INSIDE the
 * file sandbox — so the path must be one the fs-policy grants readWrite. The
 * trail used to live at the shared `<SESSION_DATA_DIR>/dsh-tui-ready-signal.log`,
 * which the policy never allowed (deny-by-default for the data dir) and which was
 * not session-scoped either.
 *
 * Shape copied from `turn-sends/<sessionId>.jsonl`: a single per-session FILE
 * (not the directory, so no session can touch another's trail). The worker
 * pre-creates the file plus its parent at spawn — bwrap cannot bind a missing
 * source — and the writer truncates the file IN PLACE at the size cap, so the
 * bind keeps pointing at the same inode.
 *
 * `adapters/cli/fs-policy.ts` inlines the same `<dir>/<sessionId>.log` literal
 * (that module imports nothing by design); keep the two in sync.
 */
export const READY_SIGNAL_LOG_DIR_NAME = 'ready-signal';

/** Hard cap for ONE session's trail. Per process the writer additionally logs at
 *  most one event per (event, key), but a session may restart its TUI many
 *  times; truncating in place at this size keeps the file bounded regardless. */
export const READY_SIGNAL_LOG_MAX_BYTES = 64 * 1024;

export function readySignalLogDir(dataDir: string): string {
  return join(dataDir, READY_SIGNAL_LOG_DIR_NAME);
}

export function readySignalLogPath(dataDir: string, sessionId: string): string {
  return join(readySignalLogDir(dataDir), `${sessionId}.log`);
}
