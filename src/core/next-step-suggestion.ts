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
 * All Lark writes for one session run one at a time, so a removal queued by a
 * new turn always lands after an insert still in flight. State is in memory:
 * after a daemon restart an earlier row is not removed when the next turn
 * starts (its signed button still expires and still checks permissions).
 */
import { createHash } from 'node:crypto';
import type { DaemonSession } from './types.js';
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
  issue(ds: DaemonSession, prompt: string): { payload: string; sig: string } | undefined;
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
}

interface Shown {
  turnId: string;
  card: NextStepCard;
  text: string;
  cardId?: string;
}

interface State {
  /** Newest turn this session admitted (or settled, when no start was seen). */
  turnId?: string;
  /** That turn's last card, once settled. */
  card?: NextStepCard;
  suggestion?: { turnId: string; text: string };
  shown?: Shown;
  chain: Promise<void>;
}

const states = new WeakMap<DaemonSession, State>();

function stateFor(ds: DaemonSession): State {
  let state = states.get(ds);
  if (!state) {
    state = { chain: Promise.resolve() };
    states.set(ds, state);
  }
  return state;
}

/** CardKit requires a strictly increasing sequence per card across all of its
 * element writes. The footer receipt uses 1; a seconds clock keeps later
 * writes above it and increasing across daemon restarts, and the in-memory
 * floor separates writes within the same second. */
const SEQUENCE_EPOCH_MS = Date.UTC(2026, 0, 1);
const lastSequences = new Map<string, number>();
const LAST_SEQUENCES_MAX = 512;

export function nextCardSequence(messageId: string, now: number): number {
  const clock = Math.max(2, Math.floor((now - SEQUENCE_EPOCH_MS) / 1000));
  const sequence = Math.max(clock, (lastSequences.get(messageId) ?? 0) + 1);
  lastSequences.delete(messageId);
  lastSequences.set(messageId, sequence);
  while (lastSequences.size > LAST_SEQUENCES_MAX) lastSequences.delete(lastSequences.keys().next().value!);
  return sequence;
}

function writeUuid(messageId: string, operation: string, sequence: number): string {
  return `nxs_${createHash('sha256').update(`${messageId}\0${operation}\0${sequence}`).digest('hex').slice(0, 40)}`;
}

function sameCard(a: NextStepCard | undefined, b: NextStepCard | undefined): boolean {
  if (!a || !b) return false;
  if (a.kind === 'legacy' && b.kind === 'legacy') return a.messageId === b.messageId;
  return a === b;
}

export function noteNextStepTurnStarted(ds: DaemonSession, turnId: string, io: NextStepIo): void {
  const state = stateFor(ds);
  if (state.turnId === turnId) return;
  state.turnId = turnId;
  state.card = undefined;
  if (state.suggestion?.turnId !== turnId) state.suggestion = undefined;
  if (state.shown) reconcile(ds, io);
}

export function noteNextStepCard(ds: DaemonSession, turnId: string, card: NextStepCard, io: NextStepIo): void {
  const state = stateFor(ds);
  if (state.turnId !== undefined && state.turnId !== turnId) return;
  state.turnId = turnId;
  state.card = card;
  reconcile(ds, io);
}

export function noteNextStepSuggestion(ds: DaemonSession, turnId: string | undefined, text: string, io: NextStepIo): void {
  const trimmed = text.trim();
  if (!turnId || !trimmed) return;
  const state = stateFor(ds);
  if (state.turnId !== undefined && state.turnId !== turnId) return;
  if (state.suggestion?.turnId === turnId && state.suggestion.text === trimmed) return;
  state.turnId = turnId;
  state.suggestion = { turnId, text: trimmed };
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

async function removeShown(ds: DaemonSession, state: State, io: NextStepIo): Promise<void> {
  const shown = state.shown!;
  // Forget it first: a failed removal must not be retried onto a newer card,
  // and the token it carries still expires on its own.
  state.shown = undefined;
  if (shown.card.kind === 'unified') {
    await shown.card.publish(undefined);
    return;
  }
  const { messageId } = shown.card;
  const cardId = shown.cardId ?? await io.cardId(ds, messageId);
  const sequence = nextCardSequence(messageId, io.now());
  await io.remove(ds, cardId, messageId, sequence, writeUuid(messageId, 'remove', sequence));
}

async function apply(ds: DaemonSession, state: State, io: NextStepIo): Promise<void> {
  const turnId = state.turnId;
  const card = state.card;
  const desired = io.enabled(ds) && card && turnId !== undefined && state.suggestion?.turnId === turnId
    ? state.suggestion.text : undefined;
  if (state.shown && (!desired || state.shown.turnId !== turnId || !sameCard(state.shown.card, card))) {
    await removeShown(ds, state, io);
  }
  if (!desired || !card || turnId === undefined) return;
  if (state.shown?.text === desired) return;
  const token = io.issue(ds, desired);
  if (!token) return;
  const next: NextStepButton = { text: desired, ...token };
  if (card.kind === 'unified') {
    await card.publish(next);
    state.shown = { turnId, card, text: desired };
    return;
  }
  const { messageId } = card;
  const element = buildNextStepElement(next, io.locale(ds));
  const cardId = state.shown?.cardId ?? await io.cardId(ds, messageId);
  let placement: NextStepPlacement | undefined;
  if (state.shown) {
    placement = { kind: 'present' };
  } else {
    const json = await io.readCard(ds, messageId);
    placement = json ? nextStepPlacement(json) : undefined;
    // Not a card this can edit (gone, not schema 2.0): show nothing.
    if (!placement) return;
  }
  const sequence = nextCardSequence(messageId, io.now());
  if (placement.kind === 'present') {
    await io.replace(ds, cardId, messageId, element, sequence, writeUuid(messageId, 'replace', sequence));
  } else {
    await io.insert(ds, cardId, messageId, placement.placement, element, sequence, writeUuid(messageId, 'insert', sequence));
  }
  state.shown = { turnId, card, text: desired, cardId };
  // The turn may have moved on while this write was in flight.
  if (state.turnId !== turnId || !sameCard(state.card, card)) await removeShown(ds, state, io);
}

