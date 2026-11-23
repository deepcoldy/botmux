/**
 * Keeps the「下一步」row (im/lark/next-step-card.ts) on the last card of a
 * session's latest turn in step with the CLI's prompt suggestion.
 *
 * Three facts drive it, in any order:
 *   - a turn starts (daemon beginNewTurn)        → the previous row goes away
 *   - the turn's last card has settled           → the row may be placed there
 *     (legacy: after its footer receipt PATCH; unified: after its terminal)
 *   - the worker reports the suggestion on screen → place, or update in place
 * A late fact for an older turn is ignored: with type-ahead the next turn can
 * already be admitted, and its card — not the older one — is the last card.
 *
 * All Lark writes for one session run one at a time, and a row is recorded as
 * possibly shown before its write is sent, so a removal queued by a new turn
 * always lands after an insert still in flight — or one whose outcome is unknown. State is in memory:
 * after a daemon restart an earlier row is not removed when the next turn
 * starts (its signed button still expires and still checks permissions).
 */
import { createHash } from 'node:crypto';
import type { DaemonSession } from './types.js';
import { serializeCardWrite } from './card-element-writes.js';
import {
  buildNextStepElement,
  nextStepPlacement,
  type NextStepButton,
  type NextStepPlacement,
} from '../im/lark/next-step-card.js';

export type NextStepCard =
  | { kind: 'legacy'; messageId: string }
  /** The unified reply card re-renders from its record; `publish` persists the
   * row there (or clears it with undefined) and PATCHes the card. */
  | { kind: 'unified'; publish(next: NextStepButton | undefined): Promise<void> };

type InsertPlacement = Extract<NextStepPlacement, { kind: 'insert' }>['placement'];

export interface NextStepIo {
  /** Bot-level switch, read at use time. */
  enabled(ds: DaemonSession): boolean;
  locale(ds: DaemonSession): 'zh' | 'en';
  /** Signed card-click token that sends `prompt` to this session. */
  issue(ds: DaemonSession, prompt: string, responseToTurnId?: string): { payload: string; sig: string } | undefined;
  requestSuggestion?(ds: DaemonSession, turnId: string, dispatchAttempt?: number): boolean;
  /** The sent card's current JSON (user_card_content), or undefined. */
  readCard(ds: DaemonSession, messageId: string): Promise<string | undefined>;
  cardId(ds: DaemonSession, messageId: string): Promise<string>;
  insert(ds: DaemonSession, cardId: string, messageId: string, placement: InsertPlacement,
    element: Record<string, unknown>, sequence: number, uuid: string): Promise<void>;
  replace(ds: DaemonSession, cardId: string, messageId: string,
    element: Record<string, unknown>, sequence: number, uuid: string): Promise<void>;
  remove(ds: DaemonSession, cardId: string, messageId: string, sequence: number, uuid: string): Promise<void>;
  now(): number;
  warn(message: string): void;
  /** One line per decision that changes (or keeps off) a card. */
  info?(message: string): void;
}

interface Shown {
  turnId: string;
  card: NextStepCard;
  text: string;
  cardId?: string;
  /** The write was acknowledged. An unacknowledged one may still have landed
   * (a timeout after commit), so it is removed like a confirmed one. */
  confirmed: boolean;
}

/** A row whose removal failed, retried on later passes. */
interface Leftover {
  shown: Shown;
  attempts: number;
}

interface State {
  /** Newest turn this session admitted (or settled, when no start was seen). */
  turnId?: string;
  /** That turn's last card, once settled. */
  card?: NextStepCard;
  suggestion?: { turnId: string; text: string; editable: boolean };
  requestedTurnId?: string;
  /** The row this module may have put on a card and not removed yet. */
  shown?: Shown;
  leftovers: Leftover[];
  chain: Promise<void>;
}

const LEFTOVER_ATTEMPTS = 3;

const states = new WeakMap<DaemonSession, State>();

function stateFor(ds: DaemonSession): State {
  let state = states.get(ds);
  if (!state) {
    state = { leftovers: [], chain: Promise.resolve() };
    states.set(ds, state);
  }
  return state;
}

function writeUuid(messageId: string, operation: string, sequence: number): string {
  return `nxs_${createHash('sha256').update(`${messageId}\0${operation}\0${sequence}`).digest('hex').slice(0, 40)}`;
}

function sameCard(a: NextStepCard | undefined, b: NextStepCard | undefined): boolean {
  if (!a || !b) return false;
  if (a.kind === 'legacy' && b.kind === 'legacy') return a.messageId === b.messageId;
  return a === b;
}

/** The turn a late fact must match. After a daemon restart this module has
 * no state yet; the session's own lineage anchor then decides, so a replayed
 * older terminal cannot claim the session ahead of the newer turn. */
function latestTurn(ds: DaemonSession, state: State): string | undefined {
  return state.turnId ?? ds.currentTurnId;
}

function tag(ds: DaemonSession): string {
  return `[next-step] ${ds.session.sessionId.slice(0, 8)}`;
}

function short(id: string): string {
  return id.slice(0, 16);
}

export function noteNextStepTurnStarted(ds: DaemonSession, turnId: string, io: NextStepIo): void {
  const state = stateFor(ds);
  if (state.turnId === turnId) return;
  state.turnId = turnId;
  state.card = undefined;
  if (state.suggestion?.turnId !== turnId) state.suggestion = undefined;
  if (state.shown || state.leftovers.length) reconcile(ds, io);
}

export function noteNextStepCard(ds: DaemonSession, turnId: string, card: NextStepCard, io: NextStepIo, dispatchAttempt?: number): void {
  const state = stateFor(ds);
  const latest = latestTurn(ds, state);
  if (latest !== undefined && latest !== turnId) {
    io.info?.(`${tag(ds)}: card of ${short(turnId)} ignored: the session's latest turn is ${short(latest)}`);
    return;
  }
  state.turnId = turnId;
  state.card = card;
  if (io.enabled(ds) && state.requestedTurnId !== turnId
    && io.requestSuggestion?.(ds, turnId, dispatchAttempt)) {
    state.requestedTurnId = turnId;
  }
  reconcile(ds, io);
}

/** Daemon-side staleness gate for a worker-generated editable suggestion.
 * The producing turn must still be the session's current turn, whose latest
 * terminal is a completed one for the same turn and dispatch attempt.
 * CLI-native (non-editable) suggestions bypass it: their own latest-turn check
 * in noteNextStepSuggestion is the contract for that path. */
export function editableSuggestionIsCurrent(
  facts: {
    currentTurnId?: string;
    lastTurnTerminalTurnId?: string;
    lastTurnTerminalStatus?: string;
    lastTurnTerminalDispatchAttempt?: number;
  },
  msg: { turnId?: string; dispatchAttempt?: number },
): boolean {
  return facts.currentTurnId === msg.turnId
    && facts.lastTurnTerminalStatus === 'completed'
    && facts.lastTurnTerminalTurnId === msg.turnId
    && facts.lastTurnTerminalDispatchAttempt === msg.dispatchAttempt;
}

export function noteNextStepSuggestion(ds: DaemonSession, turnId: string | undefined, text: string, io: NextStepIo, editable = false): void {
  const trimmed = text.trim();
  if (!turnId || !trimmed) return;
  const state = stateFor(ds);
  const latest = latestTurn(ds, state);
  if (latest !== undefined && latest !== turnId) {
    io.info?.(`${tag(ds)}: suggestion of ${short(turnId)} ignored: the session's latest turn is ${short(latest)}`);
    return;
  }
  if (state.suggestion?.turnId === turnId && state.suggestion.text === trimmed && state.suggestion.editable === editable) return;
  state.turnId = turnId;
  state.suggestion = { turnId, text: trimmed, editable };
  reconcile(ds, io);
}

/** Resolves once every write queued so far for this session has settled. */
export function nextStepIdle(ds: DaemonSession): Promise<void> {
  return states.get(ds)?.chain ?? Promise.resolve();
}

function reconcile(ds: DaemonSession, io: NextStepIo): void {
  const state = stateFor(ds);
  state.chain = state.chain
    .then(() => apply(ds, state, io))
    .catch(error => io.warn(`[next-step] ${ds.session.sessionId.slice(0, 8)}: ${error instanceof Error ? error.message : String(error)}`));
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function removeRow(ds: DaemonSession, shown: Shown, io: NextStepIo): Promise<void> {
  if (shown.card.kind === 'unified') {
    await shown.card.publish(undefined);
    io.info?.(`${tag(ds)}: row of ${short(shown.turnId)} removed`);
    return;
  }
  const { messageId } = shown.card;
  const cardId = shown.cardId ?? await io.cardId(ds, messageId);
  await serializeCardWrite(messageId, io.now, sequence =>
    io.remove(ds, cardId, messageId, sequence, writeUuid(messageId, 'remove', sequence)));
  io.info?.(`${tag(ds)}: row of ${short(shown.turnId)} removed from ${messageId}`);
}

/** Removal targets only the card it was placed on, so a failure never blocks
 * placing the row on the next card; it is retried on later passes. */
async function removeShown(ds: DaemonSession, state: State, io: NextStepIo, attempts = 0): Promise<void> {
  const shown = state.shown!;
  state.shown = undefined;
  try {
    await removeRow(ds, shown, io);
  } catch (error) {
    io.warn(`[next-step] ${ds.session.sessionId.slice(0, 8)}: removal failed: ${describe(error)}`);
    if (attempts + 1 < LEFTOVER_ATTEMPTS) state.leftovers.push({ shown, attempts: attempts + 1 });
  }
}

async function retryLeftovers(ds: DaemonSession, state: State, io: NextStepIo): Promise<void> {
  const pending = state.leftovers.splice(0);
  for (const leftover of pending) {
    try {
      await removeRow(ds, leftover.shown, io);
    } catch (error) {
      io.warn(`[next-step] ${ds.session.sessionId.slice(0, 8)}: removal retry failed: ${describe(error)}`);
      if (leftover.attempts + 1 < LEFTOVER_ATTEMPTS) state.leftovers.push({ ...leftover, attempts: leftover.attempts + 1 });
    }
  }
}

async function apply(ds: DaemonSession, state: State, io: NextStepIo): Promise<void> {
  await retryLeftovers(ds, state, io);
  const turnId = state.turnId;
  const card = state.card;
  const desired = io.enabled(ds) && card && turnId !== undefined && state.suggestion?.turnId === turnId
    ? state.suggestion.text : undefined;
  if (state.shown && (!desired || state.shown.turnId !== turnId || !sameCard(state.shown.card, card))) {
    await removeShown(ds, state, io);
  }
  if (!desired || !card || turnId === undefined) return;
  if (state.shown?.confirmed && state.shown.text === desired) return;
  const editable = state.suggestion?.editable === true;
  const token = editable ? io.issue(ds, desired, turnId) : io.issue(ds, desired);
  if (!token) {
    io.warn(`${tag(ds)}: no button token for ${short(turnId)}; row not shown`);
    return;
  }
  const next: NextStepButton = { text: desired, ...token, ...(editable ? { editable: true } : {}) };
  if (card.kind === 'unified') {
    // Recorded before the write: the record may be persisted (and replayed by
    // recovery) even when its PATCH fails, so the next turn must clear it.
    state.shown = { turnId, card, text: desired, confirmed: false };
    await card.publish(next);
    state.shown.confirmed = true;
    io.info?.(`${tag(ds)}: row shown for ${short(turnId)}`);
    return;
  }
  const { messageId } = card;
  const element = buildNextStepElement(next, io.locale(ds));
  const cardId = state.shown?.cardId ?? await io.cardId(ds, messageId);
  let placement: NextStepPlacement | undefined;
  if (state.shown?.confirmed) {
    placement = { kind: 'present' };
  } else {
    // First write, or one whose outcome is unknown: the card says whether it landed.
    const json = await io.readCard(ds, messageId);
    placement = json ? nextStepPlacement(json) : undefined;
    // Not a card this can edit (gone, not schema 2.0): show nothing.
    if (!placement) {
      io.info?.(`${tag(ds)}: ${messageId} cannot take the row (gone, or not an editable reply card)`);
      return;
    }
  }
  // Recorded before the write, for the same reason as above.
  state.shown = { turnId, card, text: desired, cardId, confirmed: false };
  const write = placement;
  await serializeCardWrite(messageId, io.now, sequence => write.kind === 'present'
    ? io.replace(ds, cardId, messageId, element, sequence, writeUuid(messageId, 'replace', sequence))
    : io.insert(ds, cardId, messageId, write.placement, element, sequence, writeUuid(messageId, 'insert', sequence)));
  state.shown.confirmed = true;
  io.info?.(`${tag(ds)}: row ${write.kind === 'present' ? 'updated' : 'placed'} on ${messageId} for ${short(turnId)}`);
}
