import type { DaemonSession } from './types.js';
import type { Session } from '../types.js';

export type SessionReplyTarget =
  | { mode: 'plain'; chatId: string }
  | { mode: 'thread'; rootMessageId: string }
  | { mode: 'quote'; rootMessageId: string };

/** Per-turn reply-target entry persisted in `Session.replyTargets` (keyed by
 *  turnId, so the key is not repeated inside the value). */
export interface ReplyTargetEntry {
  rootMessageId: string;
  updatedAt: string;
  quoteOnly?: boolean;
  substitute?: boolean;
}

/** Bound on `Session.replyTargets`: chat-scope sessions are long-lived and a
 *  busy substitute group could otherwise grow the map without limit. 32 keeps
 *  every plausibly-still-in-flight turn (queue depth is far smaller) while the
 *  oldest entries fall off. Evicted turns degrade to the single-slot
 *  currentReplyTarget path — same behavior as before the map existed. */
const REPLY_TARGETS_MAX = 32;

/** The reply target for a SPECIFIC turn: exact per-turn entry first, then the
 *  single-slot currentReplyTarget (which only remembers the latest turn — with
 *  queued/concurrent turns an earlier turn would otherwise lose its anchor). */
export function pickTurnReplyTarget(
  s: Pick<Session, 'replyTargets' | 'currentReplyTarget'>,
  currentTurnId: string | undefined,
): { rootMessageId: string; turnId: string; quoteOnly?: boolean; substitute?: boolean } | undefined {
  if (currentTurnId) {
    const entry = s.replyTargets?.[currentTurnId];
    if (entry?.rootMessageId) {
      return { rootMessageId: entry.rootMessageId, turnId: currentTurnId, quoteOnly: entry.quoteOnly, substitute: entry.substitute };
    }
  }
  return s.currentReplyTarget;
}

/** Whether `turnId` is a substitute (avatar-style) turn. With no turn context,
 *  falls back to the latest-accepted turn's flag — callers that have a turnId
 *  (screen updates, turn reactions) get an exact per-turn answer so a queued
 *  normal turn doesn't inherit a substitute turn's card-off (or vice versa). */
export function isSubstituteTurn(
  ds: Pick<DaemonSession, 'session' | 'currentReplyTarget'>,
  turnId?: string,
): boolean {
  const slot = ds.currentReplyTarget ?? ds.session.currentReplyTarget;
  if (turnId) {
    const entry = ds.session.replyTargets?.[turnId];
    if (entry) return entry.substitute === true;
    // With explicit turn context, the single slot only speaks for ITS OWN
    // turn. A rootless normal turn leaves no map entry (begin cleared the
    // slot) — it must not inherit a later substitute turn's flag after that
    // turn overwrote the slot (and vice versa).
    return !!slot && slot.turnId === turnId && slot.substitute === true;
  }
  return slot?.substitute === true;
}

export function resolveSessionReplyTarget(
  ds: Pick<DaemonSession, 'scope' | 'chatId' | 'session' | 'currentReplyTarget'>,
  turnId?: string,
): SessionReplyTarget {
  if (ds.scope === 'chat') {
    // Exact per-turn anchor first: survives a later turn overwriting the
    // single slot while this turn is still executing/queued.
    const turnEntry = turnId ? ds.session.replyTargets?.[turnId] : undefined;
    if (turnEntry?.rootMessageId) {
      return turnEntry.quoteOnly
        ? { mode: 'quote', rootMessageId: turnEntry.rootMessageId }
        : { mode: 'thread', rootMessageId: turnEntry.rootMessageId };
    }
    const target = ds.currentReplyTarget ?? ds.session.currentReplyTarget;
    if (target?.rootMessageId && !!turnId && target.turnId === turnId) {
      return target.quoteOnly
        ? { mode: 'quote', rootMessageId: target.rootMessageId }
        : { mode: 'thread', rootMessageId: target.rootMessageId };
    }
    return { mode: 'plain', chatId: ds.chatId };
  }
  return { mode: 'thread', rootMessageId: ds.session.rootMessageId };
}

export function resolveSendTarget(opts: {
  into?: string;
  topLevel: boolean;
  chatScope: boolean;
  chatId: string;
  rootMessageId: string;
  replyTargetRootId?: string;
  replyTargetTurnId?: string;
  replyTargetQuoteOnly?: boolean;
  currentTurnId?: string;
}): SessionReplyTarget {
  if (opts.into) return { mode: 'thread', rootMessageId: opts.into };
  if (opts.topLevel) return { mode: 'plain', chatId: opts.chatId };
  if (opts.chatScope) {
    if (opts.replyTargetRootId && opts.replyTargetTurnId && opts.replyTargetTurnId === opts.currentTurnId) {
      return opts.replyTargetQuoteOnly
        ? { mode: 'quote', rootMessageId: opts.replyTargetRootId }
        : { mode: 'thread', rootMessageId: opts.replyTargetRootId };
    }
    return { mode: 'plain', chatId: opts.chatId };
  }
  return { mode: 'thread', rootMessageId: opts.rootMessageId };
}

export function beginReplyTargetTurn(
  ds: DaemonSession,
  replyRootId: string | undefined,
  turnId: string,
  nowIso = new Date().toISOString(),
  opts?: { quoteOnly?: boolean; substitute?: boolean },
): void {
  if (ds.scope !== 'chat') return;
  if (replyRootId) {
    const aliases = { ...(ds.replyThreadAliases ?? ds.session.replyThreadAliases ?? {}) };
    aliases[replyRootId] = {
      createdAt: aliases[replyRootId]?.createdAt ?? nowIso,
      lastUsedAt: nowIso,
    };
    const target = { rootMessageId: replyRootId, turnId, updatedAt: nowIso, quoteOnly: opts?.quoteOnly, substitute: opts?.substitute };
    ds.replyThreadAliases = aliases;
    ds.currentReplyTarget = target;
    ds.session.replyThreadAliases = aliases;
    ds.session.currentReplyTarget = target;
    // Per-turn map alongside the single slot: a later turn's begin no longer
    // strands this turn's anchor (session-only field — persisted by the
    // sessionStore.updateSession the daemon calls right after every begin,
    // same lifecycle as docCommentTargets).
    const targets = { ...(ds.session.replyTargets ?? {}) };
    targets[turnId] = { rootMessageId: replyRootId, updatedAt: nowIso, quoteOnly: opts?.quoteOnly, substitute: opts?.substitute };
    const keys = Object.keys(targets);
    if (keys.length > REPLY_TARGETS_MAX) {
      keys
        .sort((a, b) => (targets[a].updatedAt < targets[b].updatedAt ? -1 : 1))
        .slice(0, keys.length - REPLY_TARGETS_MAX)
        .forEach(k => { delete targets[k]; });
    }
    ds.session.replyTargets = targets;
    return;
  }
  ds.currentReplyTarget = undefined;
  ds.session.currentReplyTarget = undefined;
}

/**
 * Effective turnId for a daemon-side message. Callers that know their turn
 * (worker final_output, placeholder cards) pass it explicitly and the
 * stale-turn gate in resolveSessionReplyTarget stays authoritative. Callers
 * with NO turn context of their own (the worker's first streaming card,
 * crash notices) fall back to the session's current reply-target turn — in a
 * shared fold-back topic they then follow the conversation into the thread
 * instead of leaking to the chat top level.
 */
export function fallbackTurnId(
  ds: Pick<DaemonSession, 'session' | 'currentReplyTarget'>,
  turnId: string | undefined,
): string | undefined {
  return turnId ?? (ds.currentReplyTarget ?? ds.session.currentReplyTarget)?.turnId;
}

export function syncReplyTargetState(ds: DaemonSession, s?: Session): void {
  const source = s ?? ds.session;
  ds.replyThreadAliases = source.replyThreadAliases;
  ds.currentReplyTarget = source.currentReplyTarget;
}
