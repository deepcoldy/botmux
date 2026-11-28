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

/**
 * `start-bot` / `stop-bot` address a Feishu bot and carry what is needed to
 * respawn its daemon. `start-member` / `stop-member` address a member of a
 * re-resolvable group (today: a WeCom connection) by name ONLY: the supervisor
 * re-resolves the group and takes the spec from that resolution, never from the
 * payload, and reports the outcome through the result file below.
 *
 * Upgrade window: a supervisor older than the member ops drops them unread (the
 * parse below is a whitelist), so a caller waiting for their result times out.
 */
export type FleetCommandOp = 'start-bot' | 'stop-bot' | 'start-member' | 'stop-member';

export type FleetMemberCommandOp = Extract<FleetCommandOp, 'start-member' | 'stop-member'>;

const FLEET_COMMAND_OPS: readonly FleetCommandOp[] = ['start-bot', 'stop-bot', 'start-member', 'stop-member'];

export function isFleetMemberCommandOp(op: FleetCommandOp): op is FleetMemberCommandOp {
  return op === 'start-member' || op === 'stop-member';
}

export interface FleetCommand {
  /** Unique id (caller-supplied) so consumption can be confirmed. */
  id: string;
  op: FleetCommandOp;
  /** Target's stable process name (botmux-<index>, or a group member's name). */
  name: string;
  /** Target bot's larkAppId ('' for a member op; never read for one). */
  appId: string;
  /** 0-based bot index the daemon reads via BOTMUX_BOT_INDEX (-1 for a member
   *  op; never read for one). */
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
      !FLEET_COMMAND_OPS.includes(q.op as FleetCommandOp) ||
      typeof q.name !== 'string' ||
      typeof q.appId !== 'string' ||
      !Number.isSafeInteger(q.botIndex)
    ) continue;
    commands.push({
      id: q.id,
      op: q.op as FleetCommandOp,
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
 *
 * A member op (start-member / stop-member) is only de-duped by id: every one is
 * kept, in order, because each has a caller waiting for ITS answer. Which intent
 * wins is decided by the supervisor, which checks each member op against the
 * desired state recorded after it was enqueued (see FleetSupervisor).
 */
export function enqueueFleetCommand(path: string, cmd: FleetCommand): void {
  withFileLockSync(path, () => {
    const cur = readFleetCommands(path);
    // Drop any pending command for the SAME bot name (either op) — the newest
    // command supersedes stale intent for that bot. Also drop an exact id dup.
    const kept = isFleetMemberCommandOp(cmd.op)
      ? cur.filter((c) => c.id !== cmd.id)
      : cur.filter((c) => c.name !== cmd.name && c.id !== cmd.id);
    kept.push(cmd);
    atomicWriteFileSync(path, JSON.stringify({ commands: kept }, null, 2), { mode: 0o600 });
  });
}

/**
 * Take back one command the supervisor has not drained yet (caller side: its
 * supervisor went away, or never answered). Returns true when the command was
 * still queued and is now gone, false when it was not there (already drained,
 * or never written). Other commands are left exactly as they are.
 */
export function withdrawFleetCommand(path: string, id: string): boolean {
  if (!existsSync(path)) return false;
  return withFileLockSync(path, () => {
    const cur = readFleetCommands(path);
    const kept = cur.filter((c) => c.id !== id);
    if (kept.length === cur.length) return false;
    atomicWriteFileSync(path, JSON.stringify({ commands: kept }, null, 2), { mode: 0o600 });
    return true;
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

/** Successful outcomes of a member op. */
export type FleetMemberCommandState = 'started' | 'already-online' | 'stopped' | 'already-stopped';

/**
 * Why a member op was not carried out.
 *  - unknown_member: the name is not a member of any re-resolvable group (for
 *    start-member: not in the fresh resolution, e.g. its connection is not
 *    configured to run). Nothing was spawned.
 *  - resolve_failed: the group could not be resolved (its configuration or
 *    desired-state file is unreadable/corrupt). Nothing was changed.
 *  - spawn_failed: the command could not be executed (ENOENT/EACCES…), or no
 *    child was spawned because a live process the supervisor does not own
 *    still holds the member's row.
 *  - stop_failed: the child did not confirm its exit within the stop budget.
 *  - supervisor_stopping: the supervisor is shutting down.
 *  - superseded: an intent recorded after this command was enqueued says the
 *    opposite (`running` for a stop-member, a person's `stopped` for a
 *    start-member). Nothing was changed.
 *  - member_stopping: start-member found the member's process shutting itself
 *    down (it will exit shortly). Nothing was started; ask again once it exited.
 */
export type FleetMemberCommandFailure =
  | 'unknown_member' | 'resolve_failed' | 'spawn_failed' | 'stop_failed' | 'supervisor_stopping'
  | 'superseded' | 'member_stopping';

export type FleetCommandResult =
  | { id: string; op: FleetMemberCommandOp; name: string; ok: true; state: FleetMemberCommandState; at: string }
  | { id: string; op: FleetMemberCommandOp; name: string; ok: false; reason: FleetMemberCommandFailure; message: string; at: string };

/** Results kept in the file; older ones are dropped first. A caller waits for
 *  its own id right after enqueueing, so only recent results matter. */
const MAX_FLEET_COMMAND_RESULTS = 64;

const MEMBER_STATES: readonly FleetMemberCommandState[] = ['started', 'already-online', 'stopped', 'already-stopped'];
const MEMBER_FAILURES: readonly FleetMemberCommandFailure[] = [
  'unknown_member', 'resolve_failed', 'spawn_failed', 'stop_failed', 'supervisor_stopping',
  'superseded', 'member_stopping',
];

/** Tolerant whitelist parse of the result file — missing/partial → no results. */
function coerceResults(raw: unknown): FleetCommandResult[] {
  if (!raw || typeof raw !== 'object') return [];
  const list = (raw as { results?: unknown }).results;
  if (!Array.isArray(list)) return [];
  const results: FleetCommandResult[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    if (typeof r.id !== 'string' || typeof r.name !== 'string' || typeof r.at !== 'string') continue;
    if (r.op !== 'start-member' && r.op !== 'stop-member') continue;
    if (r.ok === true && MEMBER_STATES.includes(r.state as FleetMemberCommandState)) {
      results.push({ id: r.id, op: r.op, name: r.name, ok: true, state: r.state as FleetMemberCommandState, at: r.at });
    } else if (r.ok === false && MEMBER_FAILURES.includes(r.reason as FleetMemberCommandFailure)) {
      results.push({
        id: r.id,
        op: r.op,
        name: r.name,
        ok: false,
        reason: r.reason as FleetMemberCommandFailure,
        message: typeof r.message === 'string' ? r.message : '',
        at: r.at,
      });
    }
  }
  return results;
}

function readFleetCommandResults(path: string): FleetCommandResult[] {
  if (!existsSync(path)) return [];
  try {
    return coerceResults(JSON.parse(readFileSync(path, 'utf-8')));
  } catch {
    return [];
  }
}

/** Record the outcome of one member op (supervisor side). Same lock + atomic
 *  write as the queue; a result for the same id replaces the older one. */
export function recordFleetCommandResult(path: string, result: FleetCommandResult): void {
  withFileLockSync(path, () => {
    const kept = readFleetCommandResults(path).filter((r) => r.id !== result.id);
    kept.push(result);
    const bounded = kept.slice(-MAX_FLEET_COMMAND_RESULTS);
    atomicWriteFileSync(path, JSON.stringify({ results: bounded }, null, 2), { mode: 0o600 });
  });
}

/** The recorded outcome of the command with this id, if the supervisor has
 *  finished it (caller side). */
export function readFleetCommandResult(path: string, id: string): FleetCommandResult | undefined {
  return readFleetCommandResults(path).find((r) => r.id === id);
}
