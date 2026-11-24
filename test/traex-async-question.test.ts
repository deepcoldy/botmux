import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { TraexQuestionBridge } from '../src/core/traex-question-bridge.js';
import {
  parseTraexQuestionPage, traexPendingAsyncQuestionVisible, traexQuestionAskQuestion,
  nextTraexQuestionStep, traexQuestionStepAllowed, traexQuestionSignature, traexQuestionState,
} from '../src/utils/traex-question-page.js';
import { loadWorkerFunction } from './helpers/worker-function-harness.js';
import type { AskQuestion, AskResult } from '../src/core/ask-types.js';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/traex-question/${name}`, import.meta.url), 'utf8');
const CHOICE = fixture('traex-0.216.0-async-choice.txt');
const TEXT = fixture('traex-0.216.0-async-text.txt');
const CUSTOM = fixture('traex-0.216.0-async-custom.txt');
const PENDING = 'previous output\n\n  ? 2 questions\n    shift+← to answer\n\n❯ \n  model · Context 90% left';
const result = (keys: string[], custom?: string): AskResult => ({ kind: 'answered', answers: [keys], by: 'ou_test',
  comment: custom ?? null, timedOut: false });

describe('recorded TRAE 0.216 asynchronous question layouts', () => {
  it('reads the native batch position and preserves choice labels', () => {
    const page = parseTraexQuestionPage(CHOICE)!;
    expect(page).toMatchObject({ delivery: 'async', index: 1, total: 2, prompt: 'Pick probe label', highlighted: 1 });
    expect(traexQuestionAskQuestion(page).options.map(o => o.label)).toEqual(['Alpha', 'Beta']);
    expect(nextTraexQuestionStep(page, { kind: 'options', numbers: [2] })).toEqual({ kind: 'key', key: 'Down', final: false });
    expect(nextTraexQuestionStep(page, { kind: 'options', numbers: [1] })).toEqual({ kind: 'key', key: 'Enter', final: true });
    expect(traexQuestionStepAllowed(page, { kind: 'key', key: '1', final: true })).toBe(false);
  });

  it('reads native text-only input and custom Other text without treating them as labels', () => {
    const text = parseTraexQuestionPage(TEXT)!;
    expect(traexQuestionAskQuestion(text)).toMatchObject({ prompt: 'Type probe text', inputMode: 'text', options: [] });
    expect(nextTraexQuestionStep(text, { kind: 'custom', text: 'answer' })).toEqual({ kind: 'paste', text: 'answer' });
    const custom = parseTraexQuestionPage(CUSTOM)!;
    expect(custom).toMatchObject({ notesOpen: true, notesText: 'CLEAR_ME' });
    expect(traexQuestionAskQuestion(custom).options.map(o => o.label)).toEqual(['Alpha', 'Beta']);
    expect(nextTraexQuestionStep(custom, { kind: 'custom', text: 'other text' }).kind).toBe('fail');
    expect(traexQuestionStepAllowed(custom, { kind: 'key', key: 'Tab', final: false })).toBe(false);
  });

  it('requires both the pending shortcut and the real composer', () => {
    expect(traexPendingAsyncQuestionVisible(PENDING)).toBe(true);
    expect(traexPendingAsyncQuestionVisible(PENDING.replace('shift+←', 'alt/⌥+↑'))).toBe(true);
    expect(traexPendingAsyncQuestionVisible(PENDING.replace('❯ ', 'menu'))).toBe(false);
    expect(traexPendingAsyncQuestionVisible(CHOICE)).toBe(false);
    expect(parseTraexQuestionPage(`${CHOICE}\n❯ real composer`)).toBeUndefined();
  });
});

beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); });

/** Native 0.216 widgets: Other is inline text, arrows select, Enter sends only
 * the current question and clears pending questions, C-u only clears text. */
function harness() {
  const questions = [{ title: 'Pick probe label', options: ['Alpha', 'Beta'], selected: 1, text: '' },
    { title: 'Type probe text', options: [] as string[], selected: 1, text: '' }];
  const state = { lifetime: 1, enabled: true, shown: false, index: 0, refuseEnter: false, captures: 0 };
  const inputs: string[] = [];
  const delivered: string[][] = [];
  const asks: Array<{ question: AskQuestion; pageDelivery?: string; signal: AbortSignal; answer(result: AskResult): void }> = [];
  const notices: string[] = [];
  const screen = () => {
    if (!questions.length) return '❯ \n  model · Context 90% left';
    if (!state.shown) return PENDING.replace('2 questions', `${questions.length} ${questions.length === 1 ? 'question' : 'questions'}`);
    const q = questions[state.index]!;
    return ['─'.repeat(160), '', ...(questions.length > 1 ? [`  ${state.index + 1} of ${questions.length}`] : []),
      `  ${q.title}`, '', ...(q.options.length ? [...q.options, q.text || 'Other'].map((label, i) =>
        `  ${q.selected === i + 1 ? '›' : ' '} ${i + 1}. ${label}`) : [`  ${q.text || 'Type your answer'}`]), '',
      `  enter submit  |  ctrl+] skip  |  alt/⌥+↓ main prompt${questions.length > 1 ? '  |  shift+← next question' : ''}`].join('\n');
  };
  const bridge = new TraexQuestionBridge({
    now: () => Date.now(), setTimer: (fn, ms) => setTimeout(fn, ms), clearTimer: h => clearTimeout(h as ReturnType<typeof setTimeout>),
    enabled: () => state.enabled, lifetime: () => state.lifetime, mayOpenPending: () => !!questions.length,
    capture: async () => { state.captures++; return screen(); },
    openPending: async () => { inputs.push('M-Up'); state.shown = true; return true; },
    ask: (question, signal, page) => new Promise(resolve => { asks.push({ question, pageDelivery: page?.delivery, signal, answer: resolve }); }),
    writeKey: async key => {
      inputs.push(key);
      const q = questions[state.index];
      if (!q) return false;
      if (key === 'Down') q.selected = Math.min(q.selected + 1, q.options.length + 1);
      if (key === 'Up') q.selected = Math.max(q.selected - 1, 1);
      if (key === 'C-u') q.text = '';
      if (key === 'Enter') {
        if (state.refuseEnter) return false;
        delivered.push([q.text || q.options[q.selected - 1]!]);
        questions.length = 0;
      }
      return true;
    },
    paste: async text => { inputs.push(`paste:${text}`); questions[state.index]!.text += text; return true; },
    notify: key => notices.push(key), log: () => {},
  });
  return { bridge, questions, state, screen, inputs, delivered, asks, notices };
}

describe('asynchronous question cards and physical delivery', () => {
  it('opens a folded question once and submits only the displayed native question', async () => {
    const h = harness(); h.bridge.kick();
    await vi.advanceTimersByTimeAsync(1200);
    expect(h.asks).toHaveLength(1);
    expect(h.asks[0]!.pageDelivery).toBe('async');
    expect(h.inputs).toEqual(['M-Up']);
    h.asks[0]!.answer(result(['2']));
    await vi.advanceTimersByTimeAsync(1200);
    expect(h.delivered).toEqual([['Beta']]);
    expect(h.asks).toHaveLength(1);
    expect(h.inputs.filter(x => x === 'Enter')).toHaveLength(1);
    expect(h.inputs).not.toContain('Tab');
    expect(h.notices).toEqual([]);
    h.bridge.dispose();
  });

  it('submits the original native text question through the card custom answer', async () => {
    const h = harness(); h.questions.shift(); h.bridge.kick();
    await vi.advanceTimersByTimeAsync(1200);
    expect(h.asks[0]!.question.inputMode).toBe('text');
    h.asks[0]!.answer(result([], 'plain text'));
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.delivered).toEqual([['plain text']]);
    expect(h.inputs.filter(x => x === 'Enter')).toHaveLength(1);
    h.bridge.dispose();
  });

  it('reopens a collapsed card only when answered and refuses a different question', async () => {
    const h = harness(); h.questions.pop(); h.bridge.kick();
    await vi.advanceTimersByTimeAsync(1200);
    h.state.shown = false;
    await vi.advanceTimersByTimeAsync(1200);
    expect(h.inputs).toEqual(['M-Up']);
    h.questions[0]!.title = 'a different question';
    h.asks[0]!.answer(result(['1']));
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.delivered).toEqual([]);
    expect(h.inputs).not.toContain('Enter');
    expect(h.notices).toContain('worker.traex_question.not_written');
    h.bridge.dispose();
  });

  it('clears only its own custom input after a refused submit without using Tab', async () => {
    const h = harness(); h.questions.pop(); h.bridge.kick();
    await vi.advanceTimersByTimeAsync(1200);
    h.state.refuseEnter = true;
    h.asks[0]!.answer(result([], 'OWN_TEXT'));
    await vi.advanceTimersByTimeAsync(1500);
    expect(h.inputs).toContain('C-u');
    expect(h.inputs).not.toContain('Tab');
    expect(h.questions[0]!.text).toBe('');
    expect(h.delivered).toEqual([]);
    h.bridge.dispose();
  });

  it('does not drive a replacement CLI with a late card answer', async () => {
    const h = harness(); h.bridge.kick(); await vi.advanceTimersByTimeAsync(1200);
    h.state.lifetime++;
    h.asks[0]!.answer(result(['2'])); await vi.advanceTimersByTimeAsync(1000);
    expect(h.delivered).toEqual([]);
    expect(h.inputs).toEqual(['M-Up']);
    h.bridge.dispose();
  });
});

describe('worker serialization guards for native question controls', () => {
  it('rechecks the native block after the authoritative capture', async () => {
    let unblock!: (s: string) => void;
    const backend = { sendSpecialKeys: vi.fn() };
    let blocked = true;
    const scope: Record<string, any> = { backend, cliLifetimeNonce: 1, cliRestartInProgress: false,
      nativeSessionForkPending: () => false, traexQuestionBridgeActive: () => true,
      traexQuestionBlockReported: () => blocked, traexPendingAsyncQuestionVisible,
      traexQuestionCapture: () => new Promise<string>(r => { unblock = r; }),
      runAfterAmbiguousSubmissionWrites: (_: any, fn: any) => fn(), log: vi.fn(),
      adapterInputHandle: () => backend, readinessTrackedInput: (v: any) => v, invalidatePromptReadinessEvidence: vi.fn() };
    scope.traexQuestionMayOpenPending = loadWorkerFunction('traexQuestionMayOpenPending', scope);
    const open = loadWorkerFunction<() => Promise<boolean>>('traexQuestionOpenPending', scope);
    const running = open(); blocked = false; unblock(PENDING);
    expect(await running).toBe(false);
    expect(backend.sendSpecialKeys).not.toHaveBeenCalled();
  });

  it('can reopen a verified async card or a resumed persistent CLI without replayed OSC', async () => {
    const backend = { sendSpecialKeys: vi.fn(() => true) };
    const scope: Record<string, any> = { backend, cliLifetimeNonce: 1, cliRestartInProgress: false,
      nativeSessionForkPending: () => false, traexQuestionBridgeActive: () => true,
      traexQuestionBlockReported: () => false, traexPendingAsyncQuestionVisible,
      traexQuestionCapture: async () => PENDING, runAfterAmbiguousSubmissionWrites: (_: any, fn: any) => fn(),
      lastInitConfig: { resume: false }, cliOutlivesWorker: false, lastSpawnEffectiveResume: false,
      log: vi.fn(), adapterInputHandle: () => backend, readinessTrackedInput: (v: any) => v,
      invalidatePromptReadinessEvidence: vi.fn() };
    scope.traexQuestionMayOpenPending = loadWorkerFunction('traexQuestionMayOpenPending', scope);
    const open = loadWorkerFunction<(page?: any) => Promise<boolean>>('traexQuestionOpenPending', scope);
    expect(await open()).toBe(false);
    expect(await open(parseTraexQuestionPage(TEXT))).toBe(true);
    scope.lastInitConfig.resume = true; scope.cliOutlivesWorker = true; scope.lastSpawnEffectiveResume = true;
    expect(await open()).toBe(true);
    expect(backend.sendSpecialKeys).toHaveBeenCalledTimes(2);
  });

  it('rejects a question changed while its physical write was queued', async () => {
    const expected = parseTraexQuestionPage(TEXT)!;
    const write = vi.fn(() => true);
    let release!: () => void;
    let screen = TEXT;
    const backend = {};
    const scope: Record<string, any> = { backend, cliLifetimeNonce: 1, cliRestartInProgress: false,
      nativeSessionForkPending: () => false, traexQuestionBridgeActive: () => true,
      traexQuestionCapture: async () => screen, parseTraexQuestionPage, traexQuestionSignature, traexQuestionState,
      runAfterAmbiguousSubmissionWrites: (_: any, fn: any) => new Promise<void>(r => { release = r; }).then(fn),
      log: vi.fn(), invalidatePromptReadinessEvidence: vi.fn() };
    const send = loadWorkerFunction<(write: any, page: any) => Promise<boolean>>('traexQuestionWrite', scope);
    const running = send(write, expected); screen = TEXT.replace('Type probe text', 'new question'); release();
    expect(await running).toBe(false);
    expect(write).not.toHaveBeenCalled();
  });
});
