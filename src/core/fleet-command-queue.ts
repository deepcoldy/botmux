/**
 * Fleet command queue — the CLI→live-supervisor control channel for single-bot
 * operations (start-bot / stop-bot). The supervisor is a separate long-lived
 * process that OWNS every daemon child (it spawned them, holds their handles,
 * receives their exit events, and auto-restarts crashes). So a CLI `start-bot` /
 * `stop-bot` cannot spawn or kill a supervised daemon directly — a CLI-spawned
 * daemon would be an orphan the supervisor never tracks, and a CLI kill would
 * just trip the supervisor's crash-restart. Instead the CLI enqueues a command
 * here and signals the supervisor (SIGHUP); the supervisor drains the queue and
 * performs the spawn/stop itself, so the operation stays within its ownership.
 *
 * The queue file is small and append-only-ish: the CLI adds a command, the
 * supervisor removes commands it has consumed. Both sides go through the same
 * file lock + atomic write the rest of botmux uses. Each command carries a
 * unique id so the CLI can confirm consumption if it needs to.
 */

import { existsSync, readFileSync } from 'node:fs';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { withFileLockSync } from '../utils/file-lock.js';

export type FleetCommandOp = 'start-bot' | 'stop-bot';

export interface FleetCommand {
  /** Unique id (caller-supplied) so consumption can be confirmed. */
  id: string;
  op: FleetCommandOp;
  /** Target bot's stable process name (botmux-<index>). */
  name: string;
  /** Target bot's larkAppId. */
  appId: string;
  /** 0-based bot index the daemon reads via BOTMUX_BOT_INDEX. */
  botIndex: number;
  /** ISO enqueue time (caller-supplied; scripts have no Date in this codebase). */
  at: string;
}

interface FleetCommandFile {
  commands: FleetCommand[];
}

/** Tolerant parse of the command file — missing/partial file → empty queue. */
function coerce(raw: unknown): FleetCommandFile {
  if (!raw || typeof raw !== 'object') return { commands: [] };
  const list = (raw as { commands?: unknown }).commands;
  if (!Array.isArray(list)) return { commands: [] };
  const commands: FleetCommand[] = [];
  for (const c of list) {
    if (!c || typeof c !== 'object') continue;
    const q = c as Record<string, unknown>;
    if (
      typeof q.id !== 'string' ||
      (q.op !== 'start-bot' && q.op !== 'stop-bot') ||
      typeof q.name !== 'string' ||
      typeof q.appId !== 'string' ||
      !Number.isSafeInteger(q.botIndex)
    ) continue;
    commands.push({
      id: q.id,
      op: q.op,
      name: q.name,
      appId: q.appId,
      botIndex: q.botIndex as number,
      at: typeof q.at === 'string' ? q.at : '',
    });
  }
  return { commands };
}

/** Read the pending command queue (empty when absent/unparseable). */
export function readFleetCommands(path: string): FleetCommand[] {
  if (!existsSync(path)) return [];
  try {
    return coerce(JSON.parse(readFileSync(path, 'utf-8'))).commands;
  } catch {
    return [];
  }
}

/**
 * Append one command under the file lock. De-dupes by id (idempotent re-enqueue)
 * and collapses a redundant same-op command for the same bot name (the last one
 * wins) so a repeated start-bot/stop-bot can't pile up. A start-bot cancels any
 * pending stop-bot for the same name and vice-versa — the latest intent wins.
 */
export function enqueueFleetCommand(path: string, cmd: FleetCommand): void {
  withFileLockSync(path, () => {
    const cur = readFleetCommands(path);
    // Drop any pending command for the SAME bot name (either op) — the newest
    // command supersedes stale intent for that bot. Also drop an exact id dup.
    const kept = cur.filter((c) => c.name !== cmd.name && c.id !== cmd.id);
    kept.push(cmd);
    atomicWriteFileSync(path, JSON.stringify({ commands: kept }, null, 2), { mode: 0o600 });
  });
}

/**
 * Atomically take ALL pending commands (returns them, leaves an empty queue).
 * The supervisor calls this on SIGHUP so a command is executed at most once even
 * if a second SIGHUP races in mid-drain.
 */
export function drainFleetCommands(path: string): FleetCommand[] {
  return withFileLockSync(path, () => {
    const cur = readFleetCommands(path);
    if (cur.length > 0) {
      atomicWriteFileSync(path, JSON.stringify({ commands: [] }, null, 2), { mode: 0o600 });
    }
    return cur;
  });
}
