/**
 * Keeps the「本轮回顾」panel (im/lark/turn-recap-card.ts) on the last card of
 * a session's latest turn in step with the CLI's own recap of that turn.
 *
 * Facts, in any order:
 *   - a turn starts (every entry point that takes over the last reply card,
 *     core/reply-card-turn-start.ts) → the previous card keeps its panel as
 *     written (a recap is history), it just stops being updated;
 *   - the turn's last card has settled → remembered as the card the panel
 *     goes on; nothing is written to it yet. In a Claude Code session the
 *     worker is asked (once per turn) to let the CLI write its away summary
 *     (services/away-summary-focus.ts);
 *   - the CLI writes its own recap (Claude Code's away summary, minutes into
 *     an idle session) → the panel goes on that card, or is updated in place
 *     when a later summary of the same turn arrives.
 * A turn the CLI never recaps gets no panel. A late fact for an older turn is
 * ignored. State lives in this process: after a daemon restart a card keeps
 * its panel but no longer gets updates.
 *
 * Writes for one session run one at a time. A legacy card's read-back and the
 * write that depends on it hold that card's write lock (core/card-element-writes.ts),
 * shared with the「下一步」row, so the panel is placed against the card as it
 * is when it lands.
 */
import { createHash } from 'node:crypto';
import type { DaemonSession } from './types.js';
import { nextCardSequence, withCardWriteLock } from './card-element-writes.js';
import { renderRecapMarkdown } from '../services/turn-recap.js';
import {
  buildRecapElement,
  isDuplicateElementIdError,
  recapPlacement,
  type RecapPlacement,
} from '../im/lark/turn-recap-card.js';

export type RecapCard =
  | { kind: 'legacy'; messageId: string }
  /** The unified reply card re-renders from its record. */
  | { kind: 'unified'; publish(markdown: string): Promise<void> };

type InsertPlacement = Extract<RecapPlacement, { kind: 'insert' }>['placement'];

export interface RecapIo {
  /** Bot switch for the panel, read at use time. */
  enabled(ds: DaemonSession): boolean;
  /** Whether this session's CLI can be asked to write its away summary
   * (Claude Code sessions); asked only with the panel switch on. */
  awaySummaryWanted(ds: DaemonSession): boolean;
  /** Asks the session's worker to let the CLI write its away summary of `turnId`. */
  requestAwaySummary(ds: DaemonSession, turnId: string): void;
  locale(ds: DaemonSession): 'zh' | 'en';
  readCard(ds: DaemonSession, messageId: string): Promise<string | undefined>;
  cardId(ds: DaemonSession, messageId: string): Promise<string>;
  insert(ds: DaemonSession, cardId: string, messageId: string, placement: InsertPlacement,
    element: Record<string, unknown>, sequence: number, uuid: string): Promise<void>;
  replace(ds: DaemonSession, cardId: string, messageId: string,
    element: Record<string, unknown>, sequence: number, uuid: string): Promise<void>;
  now(): number;
  warn(message: string): void;
  /** One line per decision that changes (or keeps off) a card. */
  info?(message: string): void;
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
  cli?: { turnId: string; text: string };
  /** The turn the worker was last asked to let the CLI recap. */
  awaySummaryRequested?: string;
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

export function noteRecapTurnStarted(ds: DaemonSession, turnId: string): void {
  const state = stateFor(ds);
  if (state.turnId === turnId) return;
  state.turnId = turnId;
  state.card = undefined;
  if (state.cli?.turnId !== turnId) state.cli = undefined;
  // The previous card keeps its panel; it is simply no longer this turn's.
  state.shown = undefined;
}

/** The turn's last reply card has settled: the card its panel goes on once
 * the CLI recaps the turn (at once, when that recap is already here). */
export function noteRecapCard(ds: DaemonSession, turnId: string, card: RecapCard, io: RecapIo): void {
  const state = stateFor(ds);
  const latest = latestTurn(ds, state);
  if (latest !== undefined && latest !== turnId) {
    io.info?.(`[recap] ${ds.session.sessionId.slice(0, 8)}: card of ${turnId.slice(0, 16)} ignored: the session's latest turn is ${latest.slice(0, 16)}`);
    return;
  }
  state.turnId = turnId;
  state.card = card;
  if (state.awaySummaryRequested !== turnId && state.cli?.turnId !== turnId
    && io.enabled(ds) && io.awaySummaryWanted(ds)) {
    state.awaySummaryRequested = turnId;
    io.requestAwaySummary(ds, turnId);
    io.info?.(`[recap] ${ds.session.sessionId.slice(0, 8)}: asked the worker to let the CLI recap ${turnId.slice(0, 16)}`);
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
  io.info?.(`[recap] ${ds.session.sessionId.slice(0, 8)}: CLI recap for ${turnId.slice(0, 16)} (${trimmed.length} chars)${state.card ? '' : '; its card has not settled yet'}`);
  reconcile(ds, io);
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
  // No panel until the CLI has recapped this turn.
  const markdown = renderRecapMarkdown(state.cli?.turnId === turnId ? state.cli.text : undefined);
  if (!markdown) return;
  const previous = state.shown && state.shown.turnId === turnId && sameCard(state.shown.card, card) ? state.shown : undefined;
  if (previous?.confirmed && previous.markdown === markdown) return;
  if (card.kind === 'unified') {
    // Recorded before the write: an unacknowledged write may still land.
    const shown: Shown = { turnId, card, markdown, confirmed: false };
    state.shown = shown;
    await card.publish(markdown);
    shown.confirmed = true;
    io.info?.(`[recap] ${ds.session.sessionId.slice(0, 8)}: panel shown for ${turnId.slice(0, 16)}`);
    return;
  }
  const { messageId } = card;
  const element = buildRecapElement(markdown, io.locale(ds));
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
  io.info?.(`[recap] ${ds.session.sessionId.slice(0, 8)}: ${written
    ? `panel ${previous?.confirmed ? 'updated' : 'placed'} on ${messageId}`
    : `${messageId} cannot take the panel (gone, or not an editable reply card)`} for ${turnId.slice(0, 16)}`);
}
