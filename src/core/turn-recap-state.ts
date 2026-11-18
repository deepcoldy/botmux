/**
 * Keeps the「本轮回顾」panel (im/lark/turn-recap-card.ts) on the last card of
 * a session's latest turn in step with what is known about that turn.
 *
 * Facts, in any order:
 *   - a turn starts (every entry point that takes over the last reply card,
 *     core/reply-card-turn-start.ts) → the previous card keeps its panel as
 *     written (a recap is history), it just stops being updated;
 *   - the worker reports what the turn did (just before its terminal) → kept
 *     for that turn until the next one starts, so a repeated terminal finds
 *     the same material;
 *   - the turn's last card has settled → the panel goes on with those facts;
 *   - the CLI writes its own recap (Claude Code's away summary, a few minutes
 *     into an idle session) → the panel is updated in place;
 *   - with the model switch on, a card that stays idle for
 *     RECAP_MODEL_IDLE_MS without a CLI recap gets one written by a small
 *     model, at most once per turn (unless the chat hides a turn's
 *     activity); a new turn or the CLI's own recap cancels the wait, and an
 *     answer arriving after either is dropped.
 * A late fact for an older turn is ignored. State lives in this process: after
 * a daemon restart a card keeps its panel but no longer gets updates.
 *
 * Writes for one session run one at a time. A legacy card's read-back and the
 * write that depends on it hold that card's write lock (core/card-element-writes.ts),
 * shared with the「下一步」row, so the panel is placed against the card as it
 * is when it lands.
 */
import { createHash } from 'node:crypto';
import type { DaemonSession } from './types.js';
import { nextCardSequence, withCardWriteLock } from './card-element-writes.js';
import { renderRecapMarkdown, type RecapFacts, type RecapTurnInput } from '../services/turn-recap.js';
import {
  buildRecapElement,
  isDuplicateElementIdError,
  recapPlacement,
  type RecapPlacement,
} from '../im/lark/turn-recap-card.js';

/** Claude Code writes its away summary 3.1-5.0 minutes after a turn's last
 * reply (149 live samples). The optional model recap waits a little longer,
 * so it only runs for turns the CLI did not recap itself. */
export const RECAP_MODEL_IDLE_MS = 6 * 60_000;

export type RecapCard =
  | { kind: 'legacy'; messageId: string }
  /** The unified reply card re-renders from its record. */
  | { kind: 'unified'; publish(markdown: string): Promise<void> };

type InsertPlacement = Extract<RecapPlacement, { kind: 'insert' }>['placement'];

export interface RecapIo {
  /** Bot switch for the panel, read at use time. */
  enabled(ds: DaemonSession): boolean;
  /** Bot switch for the optional model recap (and whether this session may
   * make that call at all), read at use time. */
  modelEnabled(ds: DaemonSession): boolean;
  /** Whether this chat shows a turn's activity (files, commands) at all. */
  showFacts(ds: DaemonSession): boolean;
  locale(ds: DaemonSession): 'zh' | 'en';
  readCard(ds: DaemonSession, messageId: string): Promise<string | undefined>;
  cardId(ds: DaemonSession, messageId: string): Promise<string>;
  insert(ds: DaemonSession, cardId: string, messageId: string, placement: InsertPlacement,
    element: Record<string, unknown>, sequence: number, uuid: string): Promise<void>;
  replace(ds: DaemonSession, cardId: string, messageId: string,
    element: Record<string, unknown>, sequence: number, uuid: string): Promise<void>;
  /** One small-model recap of `prompt`, or undefined when none could be made. */
  modelRecap(ds: DaemonSession, prompt: string): Promise<string | undefined>;
  setTimer(run: () => void, ms: number): () => void;
  now(): number;
  warn(message: string): void;
}

/** What the panel knows about a turn when its card settles. */
export interface RecapCardInput {
  facts: RecapFacts;
  /** Undefined when the turn left nothing to recap. */
  modelPrompt?: string;
}

interface Shown {
  turnId: string;
  card: RecapCard;
  markdown: string;
  cardId?: string;
  confirmed: boolean;
}

interface State {
  turnId?: string;
  card?: RecapCard;
  input?: RecapCardInput;
  /** What the worker reported per turn, until the next turn starts. */
  reported: Map<string, RecapTurnInput>;
  cli?: { turnId: string; text: string };
  model?: { turnId: string; text: string };
  /** The turn a model recap was asked for: at most once per turn, whatever
   * became of the answer. */
  modelAttempted?: string;
  cancelModelTimer?: () => void;
  shown?: Shown;
  chain: Promise<void>;
}

const states = new WeakMap<DaemonSession, State>();

function stateFor(ds: DaemonSession): State {
  let state = states.get(ds);
  if (!state) {
    state = { reported: new Map(), chain: Promise.resolve() };
    states.set(ds, state);
  }
  return state;
}

function latestTurn(ds: DaemonSession, state: State): string | undefined {
  return state.turnId ?? ds.currentTurnId;
}

function sameCard(a: RecapCard | undefined, b: RecapCard | undefined): boolean {
  if (!a || !b) return false;
  if (a.kind === 'legacy' && b.kind === 'legacy') return a.messageId === b.messageId;
  return a === b;
}

function writeUuid(messageId: string, operation: string, sequence: number): string {
  return `rcp_${createHash('sha256').update(`${messageId}\0${operation}\0${sequence}`).digest('hex').slice(0, 40)}`;
}

function cancelModel(state: State): void {
  state.cancelModelTimer?.();
  state.cancelModelTimer = undefined;
}

function hasFacts(input: RecapCardInput | undefined): boolean {
  return !!input && (input.facts.files.length > 0 || input.facts.commands > 0 || input.modelPrompt !== undefined);
}

export function noteRecapTurnStarted(ds: DaemonSession, turnId: string): void {
  const state = stateFor(ds);
  if (state.turnId === turnId) return;
  cancelModel(state);
  state.turnId = turnId;
  state.card = undefined;
  state.input = undefined;
  for (const reported of [...state.reported.keys()]) if (reported !== turnId) state.reported.delete(reported);
  if (state.cli?.turnId !== turnId) state.cli = undefined;
  if (state.model?.turnId !== turnId) state.model = undefined;
  // The previous card keeps its panel; it is simply no longer this turn's.
  state.shown = undefined;
}

/** The worker's record of what `turnId` did, sent just before its terminal. */
export function noteRecapReported(ds: DaemonSession, turnId: string, input: RecapTurnInput): void {
  const state = stateFor(ds);
  const latest = latestTurn(ds, state);
  if (latest !== undefined && latest !== turnId) return;
  state.reported.set(turnId, input);
  while (state.reported.size > 4) state.reported.delete(state.reported.keys().next().value!);
}

/** What the worker reported for `turnId`, if anything. */
export function recapReported(ds: DaemonSession, turnId: string): RecapTurnInput | undefined {
  return states.get(ds)?.reported.get(turnId);
}

export function noteRecapCard(
  ds: DaemonSession,
  turnId: string,
  card: RecapCard,
  input: RecapCardInput,
  io: RecapIo,
): void {
  const state = stateFor(ds);
  const latest = latestTurn(ds, state);
  if (latest !== undefined && latest !== turnId) return;
  // A turn's material is taken once: a repeated terminal (or a replaced
  // worker reporting again) may know less than the first report did.
  const keep = state.turnId === turnId && hasFacts(state.input);
  state.turnId = turnId;
  state.card = card;
  if (!keep) state.input = input;
  if (state.input?.modelPrompt && !state.cli && !state.model && state.modelAttempted !== turnId && !state.cancelModelTimer
    && io.enabled(ds) && io.modelEnabled(ds)) {
    state.cancelModelTimer = io.setTimer(() => {
      state.cancelModelTimer = undefined;
      requestModelRecap(ds, state, turnId, io);
    }, RECAP_MODEL_IDLE_MS);
  }
  reconcile(ds, io);
}

export function noteCliRecap(ds: DaemonSession, turnId: string | undefined, text: string, io: RecapIo): void {
  const trimmed = text.trim();
  if (!turnId || !trimmed) return;
  const state = stateFor(ds);
  const latest = latestTurn(ds, state);
  if (latest !== undefined && latest !== turnId) return;
  if (state.cli?.turnId === turnId && state.cli.text === trimmed) return;
  state.turnId = turnId;
  state.cli = { turnId, text: trimmed };
  // The CLI recapped this turn itself: no model call for it.
  cancelModel(state);
  reconcile(ds, io);
}

function requestModelRecap(ds: DaemonSession, state: State, turnId: string, io: RecapIo): void {
  // A new turn or the CLI's own recap cancelled the timer; the switches are
  // read now, as they may have been turned off meanwhile. A chat that hides a
  // turn's activity gets no model recap either: the model reads that activity.
  const prompt = state.input?.modelPrompt;
  if (!prompt || !io.enabled(ds) || !io.modelEnabled(ds) || !io.showFacts(ds)) return;
  state.modelAttempted = turnId;
  void io.modelRecap(ds, prompt).then(text => {
    // A new turn, the CLI's own recap, or a switch turned off since.
    if (!text?.trim() || state.turnId !== turnId || state.cli || !io.enabled(ds) || !io.modelEnabled(ds)) return;
    state.model = { turnId, text: text.trim() };
    reconcile(ds, io);
  }, error => io.warn(`[recap] ${ds.session.sessionId.slice(0, 8)}: model recap failed: ${error instanceof Error ? error.message : String(error)}`));
}

/** Resolves once every write queued so far for this session has settled. */
export function recapIdle(ds: DaemonSession): Promise<void> {
  return states.get(ds)?.chain ?? Promise.resolve();
}

function reconcile(ds: DaemonSession, io: RecapIo): void {
  const state = stateFor(ds);
  state.chain = state.chain
    .then(() => apply(ds, state, io))
    .catch(error => io.warn(`[recap] ${ds.session.sessionId.slice(0, 8)}: ${error instanceof Error ? error.message : String(error)}`));
}

async function apply(ds: DaemonSession, state: State, io: RecapIo): Promise<void> {
  const turnId = state.turnId;
  const card = state.card;
  if (!card || turnId === undefined || !io.enabled(ds)) return;
  const locale = io.locale(ds);
  const markdown = renderRecapMarkdown({
    ...(state.cli?.turnId === turnId ? { cli: state.cli.text } : {}),
    ...(state.model?.turnId === turnId ? { model: state.model.text } : {}),
    ...(state.input && io.showFacts(ds) ? { facts: state.input.facts } : {}),
  }, locale);
  if (!markdown) return;
  const previous = state.shown && state.shown.turnId === turnId && sameCard(state.shown.card, card) ? state.shown : undefined;
  if (previous?.confirmed && previous.markdown === markdown) return;
  if (card.kind === 'unified') {
    // Recorded before the write: an unacknowledged write may still land.
    const shown: Shown = { turnId, card, markdown, confirmed: false };
    state.shown = shown;
    await card.publish(markdown);
    shown.confirmed = true;
    return;
  }
  const { messageId } = card;
  const element = buildRecapElement(markdown, locale);
  const cardId = previous?.cardId ?? await io.cardId(ds, messageId);
  const shown: Shown = { turnId, card, markdown, cardId, confirmed: false };
  state.shown = shown;
  const written = await withCardWriteLock(messageId, async () => {
    let placement: RecapPlacement | undefined;
    if (previous?.confirmed) {
      placement = { kind: 'present' };
    } else {
      // First write, or one whose outcome is unknown: the card says whether it
      // landed, and where the panel goes now.
      const json = await io.readCard(ds, messageId);
      placement = json ? recapPlacement(json) : undefined;
      if (!placement) return false;
    }
    const replace = () => {
      const sequence = nextCardSequence(messageId, io.now());
      return io.replace(ds, cardId, messageId, element, sequence, writeUuid(messageId, 'replace', sequence));
    };
    if (placement.kind === 'present') {
      await replace();
      return true;
    }
    const sequence = nextCardSequence(messageId, io.now());
    try {
      await io.insert(ds, cardId, messageId, placement.placement, element, sequence, writeUuid(messageId, 'insert', sequence));
    } catch (error) {
      // Already on the card (an earlier write's outcome was lost): update it.
      if (!isDuplicateElementIdError(error)) throw error;
      await replace();
    }
    return true;
  });
  if (written) shown.confirmed = true;
}
