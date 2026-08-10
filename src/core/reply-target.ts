import type { DaemonSession } from './types.js';
import type { FrozenSessionReplyContext, LarkMention, ReplyTargetEntry, Session, TurnParticipant } from '../types.js';

/** Merge participants by open_id, keeping the richest label (a later entry can
 *  fill a missing name / promote isBot). Order-stable on first appearance so a
 *  candidate list reads in arrival order. */
export function dedupeParticipants(list: TurnParticipant[]): TurnParticipant[] {
  const byId = new Map<string, TurnParticipant>();
  for (const p of list) {
    if (!p?.openId) continue;
    const prev = byId.get(p.openId);
    if (!prev) { byId.set(p.openId, { openId: p.openId, ...(p.name ? { name: p.name } : {}), ...(p.isBot !== undefined ? { isBot: p.isBot } : {}) }); continue; }
    if (!prev.name && p.name) prev.name = p.name;
    if (prev.isBot === undefined && p.isBot !== undefined) prev.isBot = p.isBot;
    if (p.isBot === true) prev.isBot = true; // a bot signal from any message wins
  }
  return [...byId.values()];
}

/** Pure core of a message's turn-window contribution (daemon wraps it with live
 *  deps). Its sender plus everyone it @-mentioned, excluding the answering bot
 *  (by `selfOpenId` OR `selfAppId` — a self @ often arrives in app_id form, so
 *  open_id alone would miss it and wrongly mark a plain 1v1 incomplete).
 *  `participants` holds ONLY executable receiver-scoped open_id candidates (so
 *  `botmux send` can hand them back as `--mention <open_id>`), each labelled bot
 *  (`isMentionBot` proves a known peer, or sender is a platform-stamped bot) /
 *  unknown (NOT provably human — `isMentionBot=false` does not prove a person; a
 *  third-party bot isn't in the cross-ref). Returns `incomplete: true` when a
 *  real, NON-self @-mention could not be reduced to a usable open_id (app_id /
 *  user_id / union_id form — parser leaves `openId` undefined): that counterpart
 *  is NOT listed as a candidate but forces the window ambiguous so the gate
 *  demands an explicit decision rather than risk a wrong single-target @. Sender
 *  name is best-effort — omitted when unknown. */
export function buildTurnParticipantsFrom(
  sender: { openId?: string; isBot?: boolean; name?: string },
  mentions: LarkMention[] | undefined,
  selfOpenId: string | undefined,
  isMentionBot: (openId: string) => boolean,
  selfAppId?: string,
): { participants: TurnParticipant[]; incomplete: boolean } {
  const out: TurnParticipant[] = [];
  let incomplete = false;
  // A candidate open_id must be a real receiver-scoped user/bot id (`ou_`).
  // Pseudo-ids like `all` (structured `{open_id:'all'}` OR post inline
  // `user_id:'all'`) and any non-`ou_` shape are NOT executable `--mention`
  // targets — never list them; mark the window incomplete instead. One check
  // here covers BOTH the text (structured mentions) and post-at lanes.
  const isExecutableOpenId = (id: string | undefined): id is string => !!id && id.startsWith('ou_');
  if (isExecutableOpenId(sender.openId)) {
    if (sender.openId !== selfOpenId) {
      out.push({
        openId: sender.openId,
        ...(sender.name ? { name: sender.name } : {}),
        ...(sender.isBot !== undefined ? { isBot: sender.isBot } : {}),
      });
    }
  } else {
    // A real inbound message whose sender has no executable open_id (e.g. an
    // app_id-only bot sender routed via realtime/message-listener). The sender
    // is never the answering bot, so it is an unaccountable counterpart.
    incomplete = true;
  }
  for (const m of mentions ?? []) {
    // The answering bot itself — matched by open_id OR app_id (a self @ frequently
    // arrives as an app_id-form mention with no open_id).
    if (m.openId && m.openId === selfOpenId) continue;
    if (selfAppId && m.appId === selfAppId) continue;
    if (!isExecutableOpenId(m.openId)) {
      // A NON-self @ we can't reduce to a `--mention <open_id>` candidate: an
      // app_id / user_id / union_id-form @ (openId undefined), `all`, or any
      // other pseudo-id. Don't fake it into the candidate list; mark the window
      // incomplete so the gate fails toward an explicit decision.
      incomplete = true;
      continue;
    }
    out.push({
      openId: m.openId,
      ...(m.name ? { name: m.name } : {}),
      ...(isMentionBot(m.openId) ? { isBot: true } : {}),
    });
  }
  return { participants: out, incomplete };
}

export type SessionReplyTarget =
  | { mode: 'plain'; chatId: string }
  | { mode: 'thread'; rootMessageId: string }
  | { mode: 'quote'; rootMessageId: string };

/** Bound on `Session.replyTargets`: long-lived sessions could otherwise grow
 * without limit. An evicted turn may use a legacy slot only when its turnId
 * still matches exactly; it never borrows a later turn's sender. */
export const REPLY_TARGETS_MAX = 32;

/** Prune `targets` down to REPLY_TARGETS_MAX oldest-first, IN PLACE, and return
 *  the new prune high-water mark = max(existing watermark, latest `updatedAt`
 *  among the entries actually evicted). Both replyTargets writers
 *  (beginReplyTargetTurn + trigger-final-suppression's inheritTriggerReplyAnchor)
 *  MUST route eviction through here so a pruned sibling can never silently
 *  under-count a turn's participant window — `botmux send` compares the returned
 *  watermark against the turn window to decide incompleteness. */
export function pruneReplyTargets(
  targets: Record<string, ReplyTargetEntry>,
  prevPrunedThrough: string | undefined,
): string | undefined {
  const keys = Object.keys(targets);
  if (keys.length <= REPLY_TARGETS_MAX) return prevPrunedThrough;
  const evict = keys
    .sort((a, b) => (targets[a].updatedAt < targets[b].updatedAt ? -1 : 1))
    .slice(0, keys.length - REPLY_TARGETS_MAX);
  let watermark = prevPrunedThrough;
  for (const k of evict) {
    const ts = targets[k].updatedAt;
    if (!watermark || watermark < ts) watermark = ts;
    delete targets[k];
  }
  return watermark;
}


export interface TurnReplyTarget extends Omit<ReplyTargetEntry, 'updatedAt'> {
  turnId: string;
  updatedAt?: string;
}

/** Reply context for one exact turn. The per-turn entry is authoritative. Old
 * persisted sessions may fall back to the single slots only when those slots
 * explicitly identify the requested turn. */
export function pickTurnReplyTarget(
  s: Pick<Session, 'replyTargets' | 'currentReplyTarget' | 'quoteTargetId' | 'quoteTargetSenderOpenId'>,
  currentTurnId: string | undefined,
): TurnReplyTarget | undefined {
  if (currentTurnId) {
    const entry = s.replyTargets?.[currentTurnId];
    // Legacy single-slot sender is trusted only when it explicitly names THIS
    // turn (quoteTargetId === currentTurnId), so it never borrows a later
    // turn's attribution.
    const legacySender = s.quoteTargetId === currentTurnId
      ? s.quoteTargetSenderOpenId
      : undefined;
    if (entry) {
      const senderOpenId = entry.senderOpenId ?? legacySender;
      return { ...entry, turnId: currentTurnId, ...(senderOpenId ? { senderOpenId } : {}) };
    }
    const slot = s.currentReplyTarget?.turnId === currentTurnId
      ? s.currentReplyTarget
      : undefined;
    if (slot || legacySender) {
      return { ...slot, turnId: currentTurnId, ...(legacySender ? { senderOpenId: legacySender } : {}) };
    }
    return undefined;
  }
  return s.currentReplyTarget;
}

/** Whether `turnId` is a chat-scope substitute turn that disables the
 * streaming card. Thread-scope substitute turns keep their normal card. With
 * no turn context, falls back to the latest-accepted chat turn's flag; callers
 * with a turnId get an exact per-turn answer so queued normal/substitute turns
 * cannot inherit each other's card state. */
export function isSubstituteTurn(
  ds: Pick<DaemonSession, 'scope' | 'session' | 'currentReplyTarget'>,
  turnId?: string,
): boolean {
  // Substitute (avatar-style) turns are a chat-scope-only concept: topic-group
  // substitute sessions are thread-scope and keep their normal streaming card.
  // Defense-in-depth alongside beginReplyTargetTurn NOT persisting the flag for
  // thread scope — a thread-scope session is never card-off via this path.
  if (ds.scope !== 'chat') return false;
  const slot = ds.currentReplyTarget ?? ds.session.currentReplyTarget;
  if (turnId) {
    const entry = ds.session.replyTargets?.[turnId];
    if (entry) return entry.substitute === true;
    // With explicit turn context, the single slot only speaks for ITS OWN
    // turn. It must not inherit a later turn's flag after that turn overwrote
    // the slot (and vice versa).
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
  opts?: { quoteOnly?: boolean; substitute?: boolean; senderOpenId?: string; participants?: TurnParticipant[]; participantsIncomplete?: boolean },
): void {
  // #597: the frozen per-turn dispatch context — the authoritative reply target
  // for THIS turn's Codex App dispatch (steer/queued/opening). Independent of the
  // mention-back participant record below; both are written per turn.
  const exactTarget: SessionReplyTarget = ds.scope === 'chat'
    ? replyRootId
      ? opts?.quoteOnly
        ? { mode: 'quote', rootMessageId: replyRootId }
        : { mode: 'thread', rootMessageId: replyRootId }
      : { mode: 'plain', chatId: ds.chatId }
    : { mode: 'thread', rootMessageId: ds.session.rootMessageId };
  const exactContexts = { ...(ds.session.turnReplyContexts ?? {}) };
  // Re-insertion keeps the newest turn at the end for deterministic bounding.
  delete exactContexts[turnId];
  exactContexts[turnId] = {
    target: exactTarget,
    ...(ds.session.quoteTargetId ? { quoteTargetId: ds.session.quoteTargetId } : {}),
    ...(ds.session.quoteTargetSenderOpenId
      ? { replyTargetSenderOpenId: ds.session.quoteTargetSenderOpenId }
      : {}),
    ...(ds.session.quoteTargetSenderIsBot !== undefined
      ? { replyTargetSenderIsBot: ds.session.quoteTargetSenderIsBot }
      : {}),
  };
  const overflow = Object.keys(exactContexts).length - 256;
  if (overflow > 0) {
    for (const staleTurnId of Object.keys(exactContexts).slice(0, overflow)) {
      delete exactContexts[staleTurnId];
    }
  }
  ds.session.turnReplyContexts = exactContexts;
  // #750: routing and sender are one atomic per-turn record. Thread-scope and
  // rootless chat turns may have no rootMessageId, but still require their
  // exact sender for --mention-back. Sender attribution (senderOpenId) and the
  // turn-window participant set are written in ANY scope — bot→bot handoff
  // happens in threads too. Everything else is chat-scope-only: quoteOnly/
  // substitute are chat-scope semantics (topic-group substitute keeps its
  // normal card; footer substitute addressing only applies to the shared
  // chat-scope session), and a thread-scope turn routes off
  // session.rootMessageId, never a per-turn root. So a thread entry carries
  // ONLY sender attribution + participants + updatedAt — no chat routing
  // metadata can leak in, or readers (isSubstituteTurn, footer isSubstitute)
  // would misread it.
  const isChatScope = ds.scope === 'chat';
  const targets = { ...(ds.session.replyTargets ?? {}) };
  targets[turnId] = {
    ...(isChatScope && replyRootId ? { rootMessageId: replyRootId } : {}),
    updatedAt: nowIso,
    ...(isChatScope ? { quoteOnly: opts?.quoteOnly, substitute: opts?.substitute } : {}),
    ...(opts?.senderOpenId ? { senderOpenId: opts.senderOpenId } : {}),
    ...(opts?.participants?.length ? { participants: dedupeParticipants(opts.participants) } : {}),
    ...(opts?.participantsIncomplete ? { participantsIncomplete: true } : {}),
  };
  ds.session.replyTargetsPrunedThrough = pruneReplyTargets(targets, ds.session.replyTargetsPrunedThrough);
  ds.session.replyTargets = targets;

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
    return;
  }
  ds.currentReplyTarget = undefined;
  ds.session.currentReplyTarget = undefined;
}

/** Resolve a turn's immutable inbound destination, falling back only for
 * legacy/non-Lark turns that predate the bounded registry. */
export function frozenReplyContextForTurn(
  ds: Pick<DaemonSession, 'scope' | 'chatId' | 'session' | 'currentReplyTarget'>,
  turnId?: string,
): FrozenSessionReplyContext {
  const frozen = turnId ? ds.session.turnReplyContexts?.[turnId] : undefined;
  return frozen ?? { target: resolveSessionReplyTarget(ds, turnId) };
}

/** Window within which sibling turn records are treated as the SAME turn for
 *  --mention-back ambiguity. Type-ahead follow-ups each land as their own
 *  per-turn record (distinct message_id), and the model may resolve
 *  BOTMUX_TURN_ID to whichever was processed last — so `botmux send` unions the
 *  participants of every record updated within this window of the resolved
 *  turn. Deliberate conservative approximation: uncertainty (an incomplete
 *  window, a pruned sibling, no window at all) fails toward explicit addressing,
 *  and erring wide can only over-suggest an explicit --mention, never wrongly
 *  auto-@ the wrong single counterpart. 90s comfortably spans a busy CLI batch
 *  while not bleeding into an unrelated later conversation. */
export const TURN_WINDOW_MS = 90_000;

export interface TurnWindow {
  /** Executable receiver-scoped open_id candidates in the window (deduped). */
  participants: TurnParticipant[];
  /** True when the set may be UNDER-counted — a non-open_id @ we couldn't
   *  resolve, a window-relevant sibling pruned by the bounded map, or the turn
   *  window itself is unknown. Callers must fail toward an explicit --mention. */
  incomplete: boolean;
}

/** The turn-window counterpart set for `currentTurnId`: the resolved turn's own
 *  participants unioned with those of any sibling turn record updated within
 *  TURN_WINDOW_MS (covers type-ahead follow-ups that folded into this model
 *  turn under different message_ids). `incomplete` is set when the set can't be
 *  proven complete — no anchor, a window record self-marked incomplete
 *  (unresolved @), or the prune watermark reaches into the window (a pruned
 *  sibling may have carried an unseen counterpart). */
export function collectTurnWindowParticipants(
  s: Pick<Session, 'replyTargets' | 'replyTargetsPrunedThrough'>,
  currentTurnId: string | undefined,
): TurnWindow {
  const map = s.replyTargets;
  if (!map || !currentTurnId) return { participants: [], incomplete: true };
  const anchor = map[currentTurnId];
  // No anchor record → we cannot bound the turn; a sender may still resolve from
  // legacy slots, so the caller must treat this as ambiguous (fail toward
  // explicit) rather than assume a lone counterpart.
  if (!anchor) return { participants: [], incomplete: true };
  const anchorMs = Date.parse(anchor.updatedAt);
  const collected: TurnParticipant[] = [];
  let incomplete = false;
  const windowLo = Number.isNaN(anchorMs) ? NaN : anchorMs - TURN_WINDOW_MS;
  for (const entry of Object.values(map)) {
    const ms = Date.parse(entry.updatedAt);
    // In-window if within ±TURN_WINDOW_MS of the anchor (a follow-up may be
    // stamped slightly before or after). Unparseable timestamps count as in.
    const inWindow = Number.isNaN(ms) || Number.isNaN(anchorMs) || Math.abs(ms - anchorMs) <= TURN_WINDOW_MS;
    if (!inWindow) continue;
    if (entry.participants) {
      collected.push(...entry.participants);
      if (entry.participantsIncomplete) incomplete = true;
    } else if (entry.senderOpenId) {
      // Pre-upgrade record (persisted before the participant set existed): it
      // knows its sender but never recorded mentions. Surface the sender as a
      // best-effort candidate AND mark incomplete — a hidden @-ed counterpart
      // may exist, so the gate must still fail toward an explicit decision.
      collected.push({ openId: entry.senderOpenId });
      incomplete = true;
    } else {
      // A window record with neither participants nor a sender we can name still
      // represents an in-flight turn we cannot fully account for.
      incomplete = true;
    }
  }
  // A prune whose watermark reaches into this window means an evicted sibling
  // could have carried a counterpart we can no longer see → under-count risk.
  const prunedMs = s.replyTargetsPrunedThrough ? Date.parse(s.replyTargetsPrunedThrough) : NaN;
  if (!Number.isNaN(prunedMs) && (Number.isNaN(windowLo) || prunedMs >= windowLo)) incomplete = true;
  return { participants: dedupeParticipants(collected), incomplete };
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
