// src/core/schedule-follow-active.ts
//
// `botmux schedule add --follow-active`: a topic task whose landing point is
// re-resolved at every fire. Order of resolution:
//
//   1. The topic it last landed in (task.rootMessageId; the creation topic
//      until the first fire) is still OPEN — some bot holds an active session
//      under that root — AND a human has spoken in it: fire there. A person
//      who keeps a topic open keeps receiving there; nothing moves, even if
//      they spoke somewhere else more recently.
//   2. Otherwise fire into the topic in this chat where a HUMAN most recently
//      spoke. Only human input counts (Session.lastHumanMessageAt), never
//      lastMessageAt — a sentinel firing every 30 minutes would otherwise
//      keep its own topic "active" forever and follow itself. The lookup spans
//      every bot's session store: where the person is, is a property of the
//      person, not of the bot.
//   3. No open topic with human activity anywhere — but the last landing point
//      is still open (bot-only: e.g. the fresh topic this task opened itself,
//      or sessions created before lastHumanMessageAt existed): stay there.
//      Opening another topic would not bring the task closer to anyone.
//   4. Nothing open at all: open a fresh top-level topic for this fire (same
//      as `--new-topic`), and remember it as the new landing point.
//
// Step 1 deliberately requires human activity: a topic held open only by the
// task's own session must not pin the task (that is why step 3 sits AFTER
// step 2 — a bot-only landing point yields to any topic where a person is).
//
// Whatever step resolves becomes task.rootMessageId, so "the topic it last
// landed in" is always a real place the task has written to.
import * as sessionStore from '../services/session-store.js';
import * as scheduleStore from '../services/schedule-store.js';
import { logger } from '../utils/logger.js';
import type { ScheduledTask, Session } from '../types.js';

export type FollowActiveCandidate = Pick<Session, 'chatId' | 'rootMessageId' | 'scope' | 'lastHumanMessageAt'>;

function isThreadRootOf(chatId: string, s: FollowActiveCandidate): boolean {
  if (s.chatId !== chatId) return false;
  if (s.scope === 'chat') return false;
  if (!s.rootMessageId || s.rootMessageId === chatId) return false;
  return true;
}

function hasHumanActivity(s: FollowActiveCandidate): boolean {
  if (!s.lastHumanMessageAt) return false;
  return Number.isFinite(Date.parse(s.lastHumanMessageAt));
}

/**
 * "Open" predicate. `candidates` are the ACTIVE thread-scope sessions of the
 * chat (across bots); a root that still appears among them is open. A root
 * nobody holds a session for — never engaged, or every session `/close`d —
 * reads as closed: a fire there would land where no session is listening.
 */
export function isTopicOpen(
  chatId: string,
  rootMessageId: string | undefined,
  candidates: Iterable<FollowActiveCandidate>,
): boolean {
  if (!rootMessageId) return false;
  for (const s of candidates) {
    if (isThreadRootOf(chatId, s) && s.rootMessageId === rootMessageId) return true;
  }
  return false;
}

/**
 * Step 1 predicate: open (see isTopicOpen) AND some session under the root
 * has seen a human message. A topic only ever written by bots — the task's
 * own fresh topic, another sentinel's — is open but not human-held.
 */
export function isTopicHumanHeld(
  chatId: string,
  rootMessageId: string | undefined,
  candidates: Iterable<FollowActiveCandidate>,
): boolean {
  if (!rootMessageId) return false;
  for (const s of candidates) {
    if (isThreadRootOf(chatId, s) && s.rootMessageId === rootMessageId && hasHumanActivity(s)) return true;
  }
  return false;
}

/**
 * Step 2 selection: among thread-scope sessions of `chatId`, the root with the
 * newest human activity. Sessions without any human activity are ignored (a
 * topic only ever written by bots is not "where the person is"). Ties keep
 * the first candidate seen. Returns undefined when nothing qualifies.
 */
export function pickMostRecentHumanTopic(
  chatId: string,
  candidates: Iterable<FollowActiveCandidate>,
): string | undefined {
  let bestRoot: string | undefined;
  let bestAt = -Infinity;
  for (const s of candidates) {
    if (!isThreadRootOf(chatId, s)) continue;
    if (!hasHumanActivity(s)) continue;
    const at = Date.parse(s.lastHumanMessageAt!);
    if (at > bestAt) {
      bestAt = at;
      bestRoot = s.rootMessageId;
    }
  }
  return bestRoot;
}

export interface FollowActiveResolution {
  rootMessageId: string | undefined;
  /** 'retained': step 1 — the last landing point is open and a human spoke there.
   *  'active':   step 2 — a human-active topic elsewhere (the landing point is
   *              closed, or open but bot-only).
   *  'kept':     step 3 — no human-active topic anywhere; the landing point is
   *              still open (bot-only), so stay rather than open another.
   *  'fresh':    step 4 — nothing open; open a new topic.
   *  'unknown':  the session lookup failed; keep the last landing point
   *              rather than move on a reading we do not have. */
  source: 'retained' | 'active' | 'kept' | 'fresh' | 'unknown';
}

export type ListFollowActiveCandidates = (chatId: string) => Iterable<FollowActiveCandidate>;

/** Resolve where a follow-active task should land right now. Never throws. */
export function resolveFollowActiveRoot(
  task: Pick<ScheduledTask, 'chatId' | 'rootMessageId'>,
  listCandidates: ListFollowActiveCandidates = sessionStore.findActiveThreadSessionsByChat,
): FollowActiveResolution {
  let candidates: FollowActiveCandidate[];
  try {
    candidates = Array.from(listCandidates(task.chatId));
  } catch (err) {
    logger.warn(`[scheduler] follow-active lookup failed for chat ${task.chatId}: ${err instanceof Error ? err.message : String(err)}`);
    return { rootMessageId: task.rootMessageId, source: 'unknown' };
  }
  if (isTopicHumanHeld(task.chatId, task.rootMessageId, candidates)) {
    return { rootMessageId: task.rootMessageId, source: 'retained' };
  }
  const picked = pickMostRecentHumanTopic(task.chatId, candidates);
  if (picked) return { rootMessageId: picked, source: 'active' };
  if (isTopicOpen(task.chatId, task.rootMessageId, candidates)) {
    return { rootMessageId: task.rootMessageId, source: 'kept' };
  }
  return { rootMessageId: undefined, source: 'fresh' };
}

export type PersistFollowActiveLanding = (id: string, rootMessageId: string, appId?: string) => void;

const persistViaStore: PersistFollowActiveLanding = (id, rootMessageId, appId) => {
  scheduleStore.updateTask(id, { rootMessageId }, appId);
};

function isFollowActiveTopicTask(task: ScheduledTask): boolean {
  if (task.followActive !== true) return false;
  return task.executionPosition === undefined || task.executionPosition === 'topic';
}

/**
 * Fire-time hook. Returns the task to execute:
 *  - unchanged unless it is a follow-active topic task;
 *  - unchanged when its last landing point is retained (step 1), kept
 *    (step 3) or the lookup failed;
 *  - a copy carrying the human-active topic as rootMessageId (step 2), with
 *    that landing point persisted so the next fire starts from where this one
 *    actually landed;
 *  - a copy switched to `executionPosition: 'new-topic'` for THIS fire only
 *    (step 4). The stored task keeps 'topic' + followActive; the topic opened
 *    by the fire path is persisted via `recordFollowActiveFreshTopic` once its
 *    root message exists.
 * Tasks parked at top level / new-topic are left alone even if the flag is
 * still set.
 */
export function applyFollowActive(
  task: ScheduledTask,
  deps: { listCandidates?: ListFollowActiveCandidates; persist?: PersistFollowActiveLanding } = {},
): ScheduledTask {
  if (!isFollowActiveTopicTask(task)) return task;
  const resolved = resolveFollowActiveRoot(task, deps.listCandidates);
  if (resolved.source === 'fresh') {
    logger.info(`[scheduler] Task "${task.name}" (${task.id}) follow-active: nothing open in ${task.chatId}; opening a fresh topic (last landing point ${task.rootMessageId ?? 'none'})`);
    return { ...task, executionPosition: 'new-topic', scope: 'chat' };
  }
  if (!resolved.rootMessageId || resolved.rootMessageId === task.rootMessageId) return task;
  const persist = deps.persist ?? persistViaStore;
  try {
    persist(task.id, resolved.rootMessageId, task.larkAppId);
  } catch (err) {
    logger.warn(`[scheduler] follow-active: could not persist landing point for task ${task.id}: ${err instanceof Error ? err.message : String(err)}`);
  }
  logger.info(`[scheduler] Task "${task.name}" (${task.id}) follow-active → ${resolved.rootMessageId} (was ${task.rootMessageId ?? 'none'})`);
  return { ...task, rootMessageId: resolved.rootMessageId, scope: 'thread' };
}

/** True when `applyFollowActive(before)` produced `after` via step 4. */
export function followActiveOpenedFreshTopic(before: ScheduledTask, after: ScheduledTask): boolean {
  return isFollowActiveTopicTask(before) && after !== before && after.executionPosition === 'new-topic';
}

/**
 * Step 4 completion: the fire path has posted the seed of the fresh topic and
 * knows its root. Persist it as the task's landing point so the next fire
 * stays there under step 3 (or step 1 once the person replies in it). Never
 * throws — a failed persist only means the next fire re-resolves (and may
 * open one more topic).
 */
export function recordFollowActiveFreshTopic(
  task: ScheduledTask,
  rootMessageId: string,
  persist: PersistFollowActiveLanding = persistViaStore,
): void {
  try {
    persist(task.id, rootMessageId, task.larkAppId);
    logger.info(`[scheduler] Task "${task.name}" (${task.id}) follow-active: fresh topic ${rootMessageId} is now the landing point`);
  } catch (err) {
    logger.warn(`[scheduler] follow-active: could not persist fresh topic ${rootMessageId} for task ${task.id}: ${err instanceof Error ? err.message : String(err)}`);
  }
}
