/**
 * TRAE CLI native question page → Lark question card, for TraeX sessions on
 * the terminal path (no RPC input). The RPC path bridges the same tool through
 * `item/tool/requestUserInput` (services/codex-user-input.ts); on the terminal
 * path TRAE draws its own "Questions" panel instead (utils/traex-question-page.ts)
 * and nothing reached Lark — the turn looked "running" forever, and a reply
 * typed in the thread was pasted into the panel's notes field while its Enter
 * submitted the recommended option.
 *
 * One card per question on screen, through the same daemon ask broker the RPC
 * path uses (so a plain-text reply in the thread is taken as the card's custom
 * answer by the daemon, never typed into the terminal):
 *
 *  - observe: a question page seen twice, STABLE_MS apart, on fresh captures
 *    of the same CLI lifetime raises its card. A different question on screen
 *    withdraws it (the next one gets its own card); a screen without the page
 *    for GONE_MS withdraws it too (answered or interrupted in the terminal).
 *  - answer: the card's choice is entered one input at a time. Before every
 *    input the screen is captured again and re-parsed; the CLI lifetime and
 *    the question must be the ones the card was raised for, the next input is
 *    derived from the page as it is now (nextTraexQuestionStep) and must pass
 *    the page's allow-list (traexQuestionStepAllowed). Anything else — another
 *    CLI process, another question, notes someone else typed — drops the
 *    answer and says so; nothing is ever cleared or guessed.
 *
 * Pure apart from the injected deps (timers, capture, card, writes), so the
 * whole lifecycle runs under fake timers in tests.
 */
import type { AskQuestion, AskResult } from './ask-types.js';
import {
  isTraexQuestionConfirmPage,
  nextTraexQuestionStep,
  parseTraexQuestionPage,
  traexQuestionFlowVisible,
  traexQuestionAnswerFromAsk,
  traexQuestionAskQuestion,
  traexQuestionSignature,
  traexQuestionState,
  traexQuestionStepAllowed,
  type TraexQuestionAnswer,
  type TraexQuestionPage,
} from '../utils/traex-question-page.js';

/** Debounce for kicks from PTY chunks / OSC reports / screen ticks. */
export const TRAEX_QUESTION_KICK_MS = 150;
/** A page must look the same this long before its card goes out. */
export const TRAEX_QUESTION_STABLE_MS = 400;
/** Re-check cadence while a card is open or a page is settling. */
export const TRAEX_QUESTION_POLL_MS = 1_000;
/** A card whose page has been off screen this long is withdrawn. */
export const TRAEX_QUESTION_GONE_MS = 1_500;
/** How long one input may take to show on screen. */
export const TRAEX_QUESTION_STEP_TIMEOUT_MS = 2_500;
const STEP_POLL_MS = 100;
/** Longest input sequence an answer may need (4 options + Other). */
const MAX_STEPS = 16;
/** While a question that gets no further card is still on screen, look this
 *  often whether it has left (then it may be carded again). */
const SETTLED_WATCH_MS = 5_000;

export type TraexQuestionNoticeKey =
  | 'worker.traex_question.not_written'
  | 'worker.traex_question.write_failed'
  | 'worker.traex_question.notes_hidden'
  | 'worker.traex_question.not_confirmed'
  | 'worker.traex_question.card_unavailable'
  | 'worker.traex_question.card_expired'
  | 'worker.traex_question.unreadable';

/** Why an answer was not entered, as the user is told: someone else changed
 *  the page (`changed`), the notes row cannot be seen on this pane
 *  (`hidden`), or entering it failed (`failed`). */
type NotWrittenKind = 'changed' | 'hidden' | 'failed';
const NOT_WRITTEN_NOTICE: Readonly<Record<NotWrittenKind, TraexQuestionNoticeKey>> = {
  changed: 'worker.traex_question.not_written',
  hidden: 'worker.traex_question.notes_hidden',
  failed: 'worker.traex_question.write_failed',
};

export interface TraexQuestionBridgeDeps {
  now(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  /** A non-RPC TraeX terminal session whose screen may drive input. */
  enabled(): boolean;
  /** Current CLI lifetime: a card and its inputs belong to one CLI process. */
  lifetime(): number;
  /** Fresh authoritative screen of the current CLI; undefined when none. */
  capture(): Promise<string | undefined>;
  /** Raise the card and wait for it; aborting `signal` withdraws it. */
  ask(question: AskQuestion, signal: AbortSignal): Promise<AskResult>;
  /** One key / one bracketed paste into the current CLI; false = not written. */
  writeKey(key: string): Promise<boolean>;
  paste(text: string): Promise<boolean>;
  notify(key: TraexQuestionNoticeKey, params?: Record<string, string>): void;
  log(message: string): void;
}

interface OpenCard {
  page: TraexQuestionPage;
  signature: string;
  lifetime: number;
  controller: AbortController;
  answering: boolean;
  missingSince?: number;
}

type StepOutcome = 'advanced' | 'changed' | 'left' | 'timeout' | 'lost';

export class TraexQuestionBridge {
  private timer: unknown;
  private timerDueAt = 0;
  private observing = false;
  private rekick = false;
  private disposed = false;
  private card: OpenCard | undefined;
  private candidate: { signature: string; lifetime: number; since: number } | undefined;
  /** Questions that get no further card while they stay on screen: the card
   *  could not be raised, expired, or its answer could not be confirmed.
   *  Cleared once no question has been on screen for GONE_MS, so the same
   *  question asked again later is carded again. */
  private readonly settled = new Map<string, number>();
  private noPageSince: number | undefined;
  /** The question flow is on screen but its options cannot be read (e.g. a
   *  narrow pane wraps the labels): since when, and whether it was said. */
  private unreadable: { since: number; notified: boolean } | undefined;

  constructor(private readonly deps: TraexQuestionBridgeDeps) {}

  /** A card is out (or being answered) for the question on screen. */
  hasOpenCard(): boolean {
    return this.card !== undefined;
  }

  /** Look at the screen soon (debounced). Safe to call on every chunk; a
   *  kick sooner than the look already scheduled brings that look forward. */
  kick(delayMs = TRAEX_QUESTION_KICK_MS): void {
    if (this.disposed) return;
    if (this.observing) {
      this.rekick = true;
      return;
    }
    const dueAt = this.deps.now() + delayMs;
    if (this.timer !== undefined) {
      if (this.timerDueAt <= dueAt) return;
      this.deps.clearTimer(this.timer);
    }
    this.timerDueAt = dueAt;
    this.timer = this.deps.setTimer(() => {
      this.timer = undefined;
      void this.observe();
    }, delayMs);
  }

  /** The CLI was replaced or stopped: withdraw everything. */
  reset(reason: string): void {
    if (this.timer !== undefined) this.deps.clearTimer(this.timer);
    this.timer = undefined;
    this.rekick = false;
    this.candidate = undefined;
    this.settled.clear();
    this.noPageSince = undefined;
    this.unreadable = undefined;
    const card = this.card;
    this.card = undefined;
    if (card) {
      card.controller.abort();
      this.deps.log(`TraeX question card withdrawn: ${reason}`);
    }
  }

  dispose(): void {
    this.reset('worker stopping');
    this.disposed = true;
  }

  private async observe(): Promise<void> {
    this.observing = true;
    try {
      await this.observeOnce();
    } catch (error) {
      this.deps.log(`TraeX question observation failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.observing = false;
    }
    if (this.disposed) return;
    if (this.rekick) {
      this.rekick = false;
      this.kick();
    } else if (this.candidate) {
      this.kick(TRAEX_QUESTION_STABLE_MS);
    } else if ((this.card && !this.card.answering) || (this.unreadable && !this.unreadable.notified)) {
      this.kick(TRAEX_QUESTION_POLL_MS);
    } else if (this.settled.size > 0) {
      // Once the page has gone, confirm it quickly so a re-asked question is
      // carded again; while it stays, look only now and then.
      this.kick(this.noPageSince !== undefined ? TRAEX_QUESTION_POLL_MS : SETTLED_WATCH_MS);
    }
  }

  private async observeOnce(): Promise<void> {
    if (!this.deps.enabled()) {
      this.candidate = undefined;
      this.withdraw('the session can no longer take card answers');
      return;
    }
    const lifetime = this.deps.lifetime();
    if (this.card && this.card.lifetime !== lifetime) this.withdraw('the CLI was replaced');
    if (this.card?.answering) return;
    const screen = await this.deps.capture();
    // No capture, or the CLI changed under it: decide nothing this round.
    if (screen === undefined || this.deps.lifetime() !== lifetime || this.card?.answering) return;
    const page = parseTraexQuestionPage(screen);
    const now = this.deps.now();
    if (!page) {
      this.candidate = undefined;
      if (this.card) {
        this.card.missingSince ??= now;
        if (now - this.card.missingSince >= TRAEX_QUESTION_GONE_MS) this.withdraw('the question left the screen');
      }
      this.observeUnreadable(screen, now);
      if (!traexQuestionFlowVisible(screen)) {
        this.noPageSince ??= now;
        if (now - this.noPageSince >= TRAEX_QUESTION_GONE_MS) this.settled.clear();
      }
      return;
    }
    this.noPageSince = undefined;
    this.unreadable = undefined;
    const signature = traexQuestionSignature(page);
    if (this.card) {
      if (this.card.signature === signature) {
        this.card.missingSince = undefined;
        return;
      }
      this.withdraw('another question is on screen');
    }
    if (this.settled.get(signature) === lifetime) return;
    if (this.candidate?.signature !== signature || this.candidate.lifetime !== lifetime) {
      this.candidate = { signature, lifetime, since: now };
      return;
    }
    if (now - this.candidate.since < TRAEX_QUESTION_STABLE_MS) return;
    this.candidate = undefined;
    this.open(page, signature, lifetime);
  }

  /** The question page is on screen but its options cannot be read: no card
   *  can go out. Say so once per appearance, so the turn does not just look
   *  "running" with input held behind it. */
  private observeUnreadable(screen: string, now: number): void {
    if (!traexQuestionFlowVisible(screen) || isTraexQuestionConfirmPage(screen)) {
      this.unreadable = undefined;
      return;
    }
    this.unreadable ??= { since: now, notified: false };
    if (this.unreadable.notified || now - this.unreadable.since < TRAEX_QUESTION_STABLE_MS) return;
    this.unreadable.notified = true;
    this.deps.log('TraeX question page on screen but its options cannot be read — no card');
    this.deps.notify('worker.traex_question.unreadable');
  }

  private open(page: TraexQuestionPage, signature: string, lifetime: number): void {
    const card: OpenCard = { page, signature, lifetime, controller: new AbortController(), answering: false };
    this.card = card;
    this.deps.log(`TraeX question ${page.index}/${page.total} is on screen — raising its card`);
    let pending: Promise<AskResult>;
    try {
      pending = this.deps.ask(traexQuestionAskQuestion(page), card.controller.signal);
    } catch (error) {
      pending = Promise.reject(error);
    }
    pending.then(result => this.onResult(card, result), error => this.onError(card, error));
  }

  private withdraw(reason: string): void {
    const card = this.card;
    // An answer being entered checks lifetime and page before every input.
    if (!card || card.answering) return;
    this.card = undefined;
    card.controller.abort();
    this.deps.log(`TraeX question card withdrawn: ${reason}`);
  }

  private onError(card: OpenCard, error: unknown): void {
    if (this.card !== card || card.controller.signal.aborted) return;
    this.card = undefined;
    this.settled.set(card.signature, card.lifetime);
    const message = error instanceof Error ? error.message : String(error);
    this.deps.log(`TraeX question card could not be raised: ${message}`);
    this.deps.notify('worker.traex_question.card_unavailable', { reason: message.slice(0, 200) });
  }

  private onResult(card: OpenCard, result: AskResult): void {
    if (this.card !== card || card.controller.signal.aborted) return;
    if (result.kind !== 'answered') {
      this.card = undefined;
      this.settled.set(card.signature, card.lifetime);
      if (result.kind === 'timedOut') {
        this.deps.notify('worker.traex_question.card_expired');
      } else {
        // Not withdrawn by this bridge (that aborts first): the daemon ended it.
        this.deps.log(`TraeX question card ended without an answer (${result.reason})`);
        this.deps.notify('worker.traex_question.card_unavailable', { reason: result.reason.slice(0, 200) });
      }
      return;
    }
    const answer = traexQuestionAnswerFromAsk(card.page, result);
    if (typeof answer === 'string') {
      this.card = undefined;
      this.notWritten(card, answer, 'failed');
      this.kick();
      return;
    }
    card.answering = true;
    void this.enter(card, answer).finally(() => {
      if (this.card === card) this.card = undefined;
      this.kick();
    });
  }

  private notWritten(card: OpenCard, reason: string, kind: NotWrittenKind): void {
    this.deps.log(`TraeX question ${card.page.index}/${card.page.total}: card answer not entered — ${reason}`);
    this.deps.notify(NOT_WRITTEN_NOTICE[kind]);
  }

  /** Fresh page for `card`: the same question — or why not. The CLI
   *  lifetime is checked by the caller after this (its last) await. */
  private async freshPage(card: OpenCard): Promise<TraexQuestionPage | { reason: string; kind: NotWrittenKind }> {
    if (!this.deps.enabled() || this.deps.lifetime() !== card.lifetime) return { reason: 'the CLI was replaced', kind: 'changed' };
    const screen = await this.deps.capture();
    if (screen === undefined) return { reason: 'no screen capture', kind: 'failed' };
    const page = parseTraexQuestionPage(screen);
    if (!page) return { reason: 'the question is no longer on screen', kind: 'changed' };
    if (traexQuestionSignature(page) !== card.signature) return { reason: 'another question is on screen', kind: 'changed' };
    return page;
  }

  private async enter(card: OpenCard, answer: TraexQuestionAnswer): Promise<void> {
    // Set once this answer has opened the notes field (Tab) or typed into it:
    // an answer that stops halfway closes it again (Tab clears and closes it;
    // Esc would interrupt the turn once the notes are closed), so the page is
    // left as it was found and the next card's option still works.
    let notesOpenedHere = false;
    const stop = async (reason: string, kind: NotWrittenKind): Promise<void> => {
      if (notesOpenedHere) await this.closeOwnNotes(card, answer);
      this.notWritten(card, reason, kind);
    };
    for (let count = 0; count < MAX_STEPS; count++) {
      const page = await this.freshPage(card);
      if (!('index' in page)) return stop(page.reason, page.kind);
      const step = nextTraexQuestionStep(page, answer);
      if (step.kind === 'fail') return stop(step.reason, stepFailureKind(step.reason));
      if (!traexQuestionStepAllowed(page, step)) return stop('input not allowed on this page', 'failed');
      // The capture above was the last await: nothing may have replaced the
      // CLI between it and the write.
      if (!this.deps.enabled() || this.deps.lifetime() !== card.lifetime) return this.notWritten(card, 'the CLI was replaced', 'changed');
      const final = step.kind === 'key' && step.final;
      const written = step.kind === 'paste' ? await this.deps.paste(step.text) : await this.deps.writeKey(step.key);
      if (!written) return stop('the terminal did not take the input', 'failed');
      if (step.kind === 'paste' || (step.kind === 'key' && step.key === 'Tab')) notesOpenedHere = true;
      this.deps.log(`TraeX question ${page.index}/${page.total}: entered ${step.kind === 'paste' ? 'note text' : `key ${step.key}`}`);
      const outcome = await this.settle(card, traexQuestionState(page), final);
      if (outcome === 'advanced') {
        this.deps.log(`TraeX question ${page.index}/${page.total}: card answer entered`);
        return;
      }
      if (outcome === 'changed') continue;
      if (final) {
        // The submit went in; whether TRAE took it is unknown. No new card for
        // this question (that could answer it twice) — the terminal decides.
        this.settled.set(card.signature, card.lifetime);
        this.deps.log(`TraeX question ${page.index}/${page.total}: submit not confirmed (${outcome})`);
        this.deps.notify('worker.traex_question.not_confirmed');
        return;
      }
      if (outcome === 'left') return this.notWritten(card, 'the question left the screen mid-answer', 'changed');
      return stop(`input had no visible effect (${outcome})`, 'failed');
    }
    return stop('too many inputs', 'failed');
  }

  /** Close the notes field this answer opened — only when it still holds
   *  nothing but this answer's text (or cannot be seen), on this question. A
   *  slow Tab may only now take effect: give it the step timeout to show. */
  private async closeOwnNotes(card: OpenCard, answer: TraexQuestionAnswer): Promise<void> {
    let page = await this.freshPage(card);
    const deadline = this.deps.now() + TRAEX_QUESTION_STEP_TIMEOUT_MS;
    while ('index' in page && !page.notesOpen && this.deps.now() < deadline) {
      await new Promise<void>(resolve => { this.deps.setTimer(resolve, STEP_POLL_MS); });
      page = await this.freshPage(card);
    }
    if (!('index' in page) || !page.notesOpen) return;
    const other = page.options[page.options.length - 1]!.number;
    const ours = page.notesText === undefined || page.notesText === ''
      || (answer.kind === 'custom' && page.notesText.replace(/\s+/g, '') === answer.text.replace(/\s+/g, ''));
    if (page.highlighted !== other || !ours) return;
    if (!this.deps.enabled() || this.deps.lifetime() !== card.lifetime) return;
    if (await this.deps.writeKey('Tab')) this.deps.log(`TraeX question ${page.index}/${page.total}: closed the notes field this answer opened`);
  }

  /** Wait for one input to show: a final input moves TRAE off this question,
   *  any other changes pointer / ticks / notes on the same question. */
  private async settle(card: OpenCard, before: string, final: boolean): Promise<StepOutcome> {
    const deadline = this.deps.now() + TRAEX_QUESTION_STEP_TIMEOUT_MS;
    while (this.deps.now() < deadline) {
      await new Promise<void>(resolve => { this.deps.setTimer(resolve, STEP_POLL_MS); });
      if (this.deps.lifetime() !== card.lifetime) return 'lost';
      const screen = await this.deps.capture();
      if (screen === undefined) continue;
      const page = parseTraexQuestionPage(screen);
      if (!page || traexQuestionSignature(page) !== card.signature) return final ? 'advanced' : 'left';
      if (!final && traexQuestionState(page) !== before) return 'changed';
    }
    return 'timeout';
  }
}

/** How the user is told about a step the page refused (see NotWrittenKind). */
function stepFailureKind(reason: string): NotWrittenKind {
  if (reason === 'the notes field is not visible') return 'hidden';
  if (reason === 'invalid option') return 'failed';
  return 'changed';
}
