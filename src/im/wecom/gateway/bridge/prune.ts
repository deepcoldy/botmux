/**
 * Pruning of the bridge state document: what state.json no longer needs is
 * dropped, so it does not grow without bound. Runs at the end of a tick, on the
 * lane, at most once per WECOM_PRUNE_INTERVAL_MS; one prune changes memory only
 * and ends in a single save.
 *
 * What is kept, and why:
 *  - an undelivered task, always (dispatch, polling and delivery rely on it);
 *  - for every session, its latest task and its latest task with a turn id:
 *    the gateway cannot tell whether the core still has the session, and
 *    without a task the Dashboard no longer lists or controls it and the
 *    gateway answers `session_not_owned`;
 *  - a task with no `createdAt` (an earlier version's): stamping it would put
 *    its old card buttons back into their 24-hour window;
 *  - delivered tasks for WECOM_TASK_RETENTION_MS, or the `/summary` window if
 *    that is longer;
 *  - de-duplication records (handled messages, host controls, grant requests,
 *    ask cards, feedback webhook rows) for WECOM_DEDUPE_RETENTION_MS after
 *    they settled; anything still in flight (`pending`, `sending`, the ask
 *    card of a running task) is never touched;
 *  - session locks, routes, grants, peer receipts and everything else not
 *    named below are left as they are.
 *
 * Functions taking `this: WecomBridge` are WecomBridge methods: they run with
 * `this` bound to the bridge (the class in ../bridge.ts forwards to them).
 */
import { summaryRange } from '../native-platform.js';
import type { WecomBridge } from '../bridge.js';
import type { State, Task } from './types.js';

/** How long a delivered task is kept, at least (the `/summary` window may be longer). */
export const WECOM_TASK_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
/** How long a settled de-duplication record is kept. */
export const WECOM_DEDUPE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
/** The least time between two prunes. */
export const WECOM_PRUNE_INTERVAL_MS = 10 * 60 * 1000;

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

/**
 * Prune when due: the first tick of a process prunes, later ones once
 * WECOM_PRUNE_INTERVAL_MS has passed since the last prune. Never on a halted
 * or poisoned bridge. A failed save poisons the bridge like any other.
 */
export function pruneWhenDue(this: WecomBridge): void {
  if (this.halted || this.poisoned) {
    return;
  }
  const now = Date.now();
  const last = this.lastPruneAt;
  if (last !== undefined && now >= last && now - last < WECOM_PRUNE_INTERVAL_MS) {
    return;
  }
  this.lastPruneAt = now;
  let taskRetentionMs: number | undefined;
  try {
    taskRetentionMs = Math.max(WECOM_TASK_RETENTION_MS, summaryRange(this.policy()).sinceHours * 3_600_000);
  } catch {
    // Without the policy the /summary window is unknown: no task is dropped this time.
    taskRetentionMs = undefined;
  }
  pruneWecomState(this.state, now, taskRetentionMs);
  this.save();
}

/**
 * The keys of the tasks every session keeps: its latest, and its latest with a
 * turn id, by insertion order. A task belongs to the session it ran in and to
 * the one its request targeted, as the Dashboard and host control link them.
 * Readers that look at `sessionId` alone (card buttons, terminal links, owner
 * reminders) find the same latest task with a turn id: only the dispatch
 * (tick.ts) sets `sessionId`, together with `triggerId`, from the core's
 * answer, and the core answers a request for a session with that session.
 */
function sessionAnchors(tasks: State['tasks']): Set<string> {
  const latest = new Map<string, string>();
  for (const [key, task] of Object.entries(tasks)) {
    for (const sid of [task.sessionId, task.request?.target?.sessionId]) {
      if (!sid) {
        continue;
      }
      latest.set(`last:${sid}`, key);
      if (task.triggerId) {
        latest.set(`turn:${sid}`, key);
      }
    }
  }
  return new Set(latest.values());
}

function pruneTasks(state: State, now: number, retentionMs: number): void {
  const anchors = sessionAnchors(state.tasks);
  for (const [key, task] of Object.entries(state.tasks)) {
    if (task.delivered !== true || !finite(task.createdAt) || anchors.has(key)) {
      continue;
    }
    const settledAt = Math.max(task.createdAt, finite(task.completedAt) ? task.completedAt : 0);
    if (settledAt + retentionMs > now) {
      continue;
    }
    // Deleted in place: readers find "the latest" task by insertion order.
    delete state.tasks[key];
    if (state.native?.receipts) {
      delete state.native.receipts[key];
    }
  }
}

/**
 * Drop what is no longer needed, in memory. `taskRetentionMs` undefined keeps
 * every task. Tasks go first: compact actions and ask cards are judged by the
 * tasks that remain.
 */
export function pruneWecomState(state: State, now: number, taskRetentionMs: number | undefined): void {
  if (taskRetentionMs !== undefined) {
    pruneTasks(state, now, taskRetentionMs);
  }

  for (const [key, value] of Object.entries(state.seen ?? {})) {
    if (value === true) {
      // An earlier version's record: its time is unknown, so it is kept a full period from now.
      state.seen[key] = now;
    } else if (finite(value) && value + WECOM_DEDUPE_RETENTION_MS <= now) {
      delete state.seen[key];
    }
  }

  for (const [requestId, intent] of Object.entries(state.controls ?? {})) {
    if (intent.status === 'pending') {
      continue;
    }
    if (!finite(intent.at)) {
      intent.at = now;
    } else if (intent.at + WECOM_DEDUPE_RETENTION_MS <= now) {
      delete state.controls![requestId];
    }
  }

  const native = state.native;
  if (native) {
    if (native.actions) {
      const streams = new Set(Object.values(state.tasks).map(task => task.streamId));
      for (const [key, status] of Object.entries(native.actions)) {
        const card = /^compact:(.+)-(?:final|controls)$/.exec(key);
        if (card && status !== 'pending' && !streams.has(card[1])) {
          delete native.actions[key];
        }
      }
    }
    for (const [id, request] of Object.entries(native.requests ?? {})) {
      if (finite(request?.expiresAt) && request.expiresAt + WECOM_DEDUPE_RETENTION_MS <= now) {
        delete native.requests[id];
      }
    }
    delete native.conversationTypes;
    delete native.knownUsers;
  }

  if (state.nativeAsks) {
    const turns = new Map<string, Task[]>();
    const add = (sessionId: string | undefined, turnId: string | undefined, task: Task) => {
      if (sessionId && turnId) {
        const key = JSON.stringify([sessionId, turnId]);
        turns.set(key, [...turns.get(key) ?? [], task]);
      }
    };
    for (const task of Object.values(state.tasks)) {
      add(task.sessionId, task.triggerId, task);
      add(task.peer?.sessionId, task.peer?.triggerId, task);
    }
    for (const [key, row] of Object.entries(state.nativeAsks)) {
      const origin = row?.snapshot?.origin;
      if (!origin?.sessionId || !origin.turnId) {
        continue;
      }
      const owners = turns.get(JSON.stringify([origin.sessionId, origin.turnId])) ?? [];
      // A running task's ask is kept (dropping it sends the card again); a
      // finished one's serves the "提问已失效" answer for a while longer.
      const expired = owners.every(task => {
        const settledAt = task.completedAt ?? task.createdAt;
        return task.delivered === true && finite(settledAt) && settledAt + WECOM_DEDUPE_RETENTION_MS <= now;
      });
      if (expired) {
        delete state.nativeAsks[key];
      }
    }
  }

  for (const [key, row] of Object.entries(state.nativeFeedbackOutbox ?? {})) {
    if ((row.status === 'delivered' || row.status === 'failed')
      && finite(row.nextAttemptAt)
      && row.nextAttemptAt + WECOM_DEDUPE_RETENTION_MS <= now) {
      delete state.nativeFeedbackOutbox![key];
    }
  }
}
