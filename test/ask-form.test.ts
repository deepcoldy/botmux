import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseAskQuestions } from '../src/core/ask-questions.js';
import { parseAskQuestionsFile } from '../src/core/ask-args.js';
import { parseAskBody } from '../src/core/ask-api.js';
import { parseAskFormValues } from '../src/core/ask-form.js';
import { buildAskCard, handleAskCardAction } from '../src/im/lark/ask-card.js';
import { buildTurnReplyAskElements, turnReplyAskSummary } from '../src/im/lark/turn-reply-ask-elements.js';
import { _resetForTest, _getPending, registerAsk, setCardDispatcher, setCanTalkChecker, submitAsk, submitAskForm, submitCustomReply, submitAskFromDesktop, toggleAsk, registerHostAsk } from '../src/core/ask-broker.js';
import { createExplicitAskContinuation, explicitAskRecoveryRequest } from '../src/core/explicit-ask-continuation.js';
import type { AskQuestion, CreateAskInput, PendingAsk } from '../src/core/ask-types.js';

const questions: AskQuestion[] = [
  { prompt: 'AI introduced?', multiSelect: false, options: [{ key: 'yes', label: 'Yes' }, { key: 'no', label: 'No' }], defaultSelectedKeys: [] },
  { prompt: 'Effort (days)', multiSelect: false, options: [], input: { type: 'number', min: 0, max: 20 } },
  { prompt: 'Extra context', multiSelect: false, options: [], input: { type: 'text', required: false, maxLength: 50 } },
];
const values = { q0: 'no', q1: '0.5', q2: ' extra details ' };
const base: CreateAskInput = { larkAppId: 'cli_test', chatId: 'oc_test', rootMessageId: 'om_test', sessionId: 'session', questions, timeoutMs: 5000, originKind: 'explicit', answererOpenId: 'ou_requester' };
let sent: PendingAsk;
beforeEach(() => {
  vi.useFakeTimers(); _resetForTest();
  setCanTalkChecker((_app, _chat, id) => ['ou_requester', 'ou_other'].includes(id));
  setCardDispatcher({ send: async ask => { sent = ask; return { messageId: 'om_card' }; }, onSettle: () => {} });
});
afterEach(() => { _resetForTest(); vi.useRealTimers(); });
const args = () => ({ askId: sent.askId, nonce: sent.nonce, by: 'ou_requester' });

describe('form schema and callback validation', () => {
  it('round-trips file input through daemon parsing without dropping fields', () => {
    const parsed = parseAskQuestionsFile(JSON.stringify(questions));
    const body = parseAskBody({ ...base, questions: parsed });
    expect(body).not.toHaveProperty('error');
    expect((body as any).questions[1].input).toMatchObject({ type: 'number', min: 0, required: true });
    expect(parsed[1]).not.toHaveProperty('defaultSelectedKeys');
  });
  it('accepts 20 form questions but rejects 21 at both CLI and HTTP boundaries', () => {
    // Count the complete mixed form, not just its input fields.
    const twenty = [questions[1], ...Array.from({ length: 19 }, () => questions[0])];
    expect(parseAskQuestionsFile(JSON.stringify(twenty))).toHaveLength(20);
    expect(parseAskBody({ ...base, questions: twenty })).toHaveProperty('questions.length', 20);
    const tooMany = [...twenty, questions[0]];
    expect(parseAskQuestions(tooMany)).toBe('bad_input');
    expect(() => parseAskQuestionsFile(JSON.stringify(tooMany))).toThrow();
    expect(parseAskBody({ ...base, questions: tooMany })).toEqual({ error: 'bad_input' });
    // The form limit must not tighten the legacy choice-only contract.
    expect(parseAskQuestions(Array.from({ length: 21 }, () => questions[0]))).toHaveLength(21);
  });
  it.each([
    { type: 'password' }, { type: 'text', min: 1 }, { type: 'number', min: 2, max: 1 },
    { type: 'text', required: 'yes' }, { type: 'text', maxLength: 0 }, { type: 'text', maxLength: 9000 },
    { type: 'text', unknown: true }, { type: 'text', placeholder: 'x'.repeat(101) },
  ])('rejects malformed input schema %j', input => {
    expect(parseAskQuestions([{ ...questions[1], input }])).toBe('bad_input');
  });
  it('rejects ambiguous legacy-text/form batches and non-explicit origins', () => {
    expect(parseAskQuestions([...questions, { prompt: 'old', inputMode: 'text', options: [], multiSelect: false }])).toBe('bad_input');
    expect(parseAskBody({ ...base, originKind: 'hook', answererOpenId: undefined })).toEqual({ error: 'bad_input' });
    expect(parseAskBody({ ...base, answererOpenId: 'cli_bot' })).toEqual({ error: 'bad_answererOpenId' });
  });
  it('returns simultaneous choices, number text and optional comment', () => {
    expect(parseAskFormValues(questions, values)).toEqual({ answers: [['no'], [], []], inputs: [null, '0.5', ' extra details '] });
    expect(parseAskFormValues(questions, { q0: 'yes', q1: '0' })?.inputs).toEqual([null, '0', null]);
  });
  it.each([
    {}, { q0: 'no' }, { q0: 'unknown', q1: '0.5' }, { q0: ['no', 'no'], q1: '0.5' },
    { q0: 'no', q1: '0x10' }, { q0: 'no', q1: 'Infinity' }, { q0: 'no', q1: '-1' },
    { q0: 'no', q1: 0.5 }, { q0: 'no', q1: '21' }, { q0: 'no', q1: '1', q2: 'x'.repeat(51) },
    { ...values, q99: 'extra' }, { ...values, q01: 'alias' },
  ])('rejects missing/invalid/unknown form values %j', values => expect(parseAskFormValues(questions, values)).toBeNull());
  it('supports standalone text, optional fields and multiselect without inferred defaults', () => {
    const qs: AskQuestion[] = [{ prompt: 'Details', options: [], multiSelect: false, input: { type: 'text' } },
      { prompt: 'Checks', multiSelect: true, options: questions[0].options, defaultSelectedKeys: ['yes'] }];
    expect(parseAskFormValues(qs, { q0: 'keep details' })).toEqual({ answers: [[], []], inputs: ['keep details', null] });
    expect(parseAskFormValues(qs, { q0: 'keep details', q1: ['yes', 'no'] })?.answers[1]).toEqual(['yes', 'no']);
  });
});

describe('production broker and card callback', () => {
  it('rejects coerced input types and preserves text whitespace', () => {
    expect(parseAskQuestions([{ prompt: 'Text', options: [], multiSelect: false, input: { type: ['text'] } }])).toBe('bad_input');
    const qs: AskQuestion[] = [{ prompt: 'Text', options: [], multiSelect: false, input: { type: 'text' } }];
    expect(parseAskFormValues(qs, { q0: '  indent\n  second line  ' })?.inputs).toEqual(['  indent\n  second line  ']);
  });
  it('rejects all-blank optional input without inventing consent', () => {
    const optional: AskQuestion[] = [{ prompt: 'Note', options: [], multiSelect: false, input: { type: 'text', required: false } }];
    expect(parseAskFormValues(optional, {})).toBeNull();
    expect(parseAskFormValues(optional, { q0: '  ' })).toBeNull();
    expect(parseAskFormValues(optional, { q0: 'Stop' })).toEqual({ answers: [[]], inputs: ['Stop'] });
  });
  it('binds input validation to the original invocation and leaves that invocation usable', async () => {
    const input = { ...base, originKind: 'host_explicit', requestId: 'shape-bound' };
    const waiting = registerHostAsk(input); await vi.advanceTimersByTimeAsync(0);
    expect(await registerHostAsk({ ...input, questions: [questions[0], { ...questions[1], input: { type: 'number', min: 2, max: 20 } }, questions[2]] })).toMatchObject({ kind: 'invalidated' });
    expect(submitAskForm({ ...args(), values })).toBe('accepted');
    expect(await waiting).toMatchObject({ inputs: [null, '0.5', ' extra details '] });
  });
  it('rejects legacy toggles without mutating the form draft', async () => {
    const result = registerAsk(base); await vi.advanceTimersByTimeAsync(0);
    expect(toggleAsk({ ...args(), questionIndex: 0, key: 'yes' })).toBe('stale');
    expect(_getPending(sent.askId)?.selections).toEqual([[], [], []]);
    expect(submitAskForm({ ...args(), values })).toBe('accepted'); await result;
  });
  it.each(['ask_select', 'ask_toggle', 'ask_submit'])('rejects a stale %s callback before grant escalation or form repaint', async action => {
    const result = registerAsk(base); await vi.advanceTimersByTimeAsync(0);
    // A permission change makes the card-layer guard observable independently
    // of the broker's fallback: an obsolete control must not start a grant flow.
    setCanTalkChecker(() => false);
    const requestGrant = vi.fn();
    const callback = { operator: { open_id: 'ou_requester' }, action: {
      value: { action, ask_id: sent.askId, nonce: sent.nonce, question_index: '0', key: 'yes' },
    } };
    const stale = await handleAskCardAction({ ...callback, action: {
      value: { ...callback.action.value, ask_id: 'missing-ask' },
    } });
    const response = await handleAskCardAction(callback, { requestGrant });
    expect(response).toEqual(stale);
    expect(response).toEqual({ toast: { type: 'warning', content: expect.any(String) } });
    expect(requestGrant).not.toHaveBeenCalled();
    expect(_getPending(sent.askId)).toMatchObject({ settled: false, selections: [[], [], []] });
    setCanTalkChecker(() => true);
    await handleAskCardAction({ operator: callback.operator, action: {
      value: { action: 'ask_form_submit', ask_id: sent.askId, nonce: sent.nonce }, form_value: values,
    } });
    expect(await result).toMatchObject({ answers: [['no'], [], []], inputs: [null, '0.5', ' extra details '] });
  });
  it('does not settle invalid fields, then submits once with both kinds of answer', async () => {
    const result = registerAsk(base); await vi.advanceTimersByTimeAsync(0);
    expect(submitAskForm({ ...args(), values: { q0: 'no' } })).toBe('invalid_form');
    expect(_getPending(sent.askId)?.settled).toBe(false);
    expect(submitAskForm({ ...args(), values })).toBe('accepted');
    expect(await result).toMatchObject({ answers: [['no'], [], []], inputs: [null, '0.5', ' extra details '], by: 'ou_requester' });
    expect(submitAskForm({ ...args(), values })).toBe('already_settled');
  });
  it('enforces responder/nonce and blocks old option-only paths', async () => {
    const result = registerAsk(base); await vi.advanceTimersByTimeAsync(0);
    expect(submitAskForm({ ...args(), by: 'ou_other', values })).toBe('unauthorized');
    expect(submitAskForm({ ...args(), nonce: 'old', values })).toBe('stale');
    expect(submitAsk({ ...args(), selections: [['no'], [], []] })).toBe('stale');
    expect(submitAskFromDesktop({ askId: sent.askId, selections: [['no'], [], []] })).toBe('invalid_form');
    await vi.advanceTimersByTimeAsync(5100);
    expect(await result).toMatchObject({ kind: 'timedOut' });
    expect(submitAskForm({ ...args(), values })).toBe('already_settled');
  });
  it('chat text replaces the complete form, never merges default choices', async () => {
    const result = registerAsk({ ...base, questions: [{ ...questions[0], defaultSelectedKeys: ['yes'] }, ...questions.slice(1)] });
    await vi.advanceTimersByTimeAsync(0);
    expect(submitCustomReply({ askId: sent.askId, by: 'ou_requester', text: 'No, 0.5 days, extra note' })).toBe('accepted');
    expect(await result).toMatchObject({ answers: [[], [], []], comment: 'No, 0.5 days, extra note' });
    expect(await result).not.toHaveProperty('inputs');
  });
  it('invalid callback only toasts, valid callback renders terminal form without losing inputs', async () => {
    const result = registerAsk(base); await vi.advanceTimersByTimeAsync(0);
    const callback = (form_value: unknown) => ({ operator: { open_id: 'ou_requester' }, action: { value: { action: 'ask_form_submit', ask_id: sent.askId, nonce: sent.nonce }, form_value } });
    const invalid = await handleAskCardAction(callback({ q0: 'no' }) as any);
    expect(invalid).toHaveProperty('toast.type', 'warning'); expect(invalid).not.toHaveProperty('card');
    const card = await handleAskCardAction(callback(values) as any);
    expect(JSON.stringify(card)).toContain('0.5'); expect(JSON.stringify(card)).not.toContain('form_submit');
    await result;
  });
  it('does not request talk grants for someone other than the designated respondent', async () => {
    const result = registerAsk(base); await vi.advanceTimersByTimeAsync(0);
    const requestGrant = vi.fn();
    const response = await handleAskCardAction({ operator: { open_id: 'ou_other' }, action: { value: { action: 'ask_form_submit', ask_id: sent.askId, nonce: sent.nonce }, form_value: values } } as any, { requestGrant });
    expect(response).toHaveProperty('toast'); expect(requestGrant).not.toHaveBeenCalled();
    expect(_getPending(sent.askId)?.settled).toBe(false);
    expect(submitAskForm({ ...args(), values })).toBe('accepted'); await result;
  });
  it('bounds the terminal receipt without truncating returned answers', async () => {
    const qs: AskQuestion[] = Array.from({ length: 20 }, () => ({ prompt: 'Details', options: [], multiSelect: false, input: { type: 'text' } }));
    const waiting = registerAsk({ ...base, questions: qs }); await vi.advanceTimersByTimeAsync(0);
    const text = '汉'.repeat(1000);
    expect(submitAskForm({ ...args(), values: Object.fromEntries(qs.map((_, i) => [`q${i}`, text])) })).toBe('accepted');
    const result = await waiting;
    expect(result).toMatchObject({ inputs: qs.map(() => text) });
    expect(Buffer.byteLength(buildAskCard(sent, result), 'utf8')).toBeLessThan(28000);
    expect(JSON.stringify(result)).toContain(text);
  });
  it('uses Card 2.0 wire fields for defaults and the sole submit callback', async () => {
    const waiting = registerAsk({ ...base, questions: [{ ...questions[0], multiSelect: true, defaultSelectedKeys: ['yes'] }, ...questions.slice(1)] });
    await vi.advanceTimersByTimeAsync(0);
    const card = JSON.parse(buildAskCard(sent));
    const fields = card.body.elements.find((e: any) => e.tag === 'form').elements;
    const choice = fields.find((e: any) => e.tag === 'multi_select_static');
    expect(choice.selected_values).toEqual(['yes']);
    expect(choice).not.toHaveProperty('initial_options');
    expect(choice).not.toHaveProperty('behaviors');
    const submit = fields.find((e: any) => e.tag === 'button');
    expect(submit.form_action_type).toBe('submit');
    expect(submit.behaviors).toEqual([{ type: 'callback', value: { action: 'ask_form_submit', ask_id: sent.askId, nonce: sent.nonce } }]);
    expect(submit).not.toHaveProperty('action_type');
    expect(submitAskForm({ ...args(), values })).toBe('accepted'); await waiting;
  });
  it('uses one Card 2.0 form in standalone and inline paths with no toggle callbacks', async () => {
    const result = registerAsk(base); await vi.advanceTimersByTimeAsync(0);
    const card = JSON.parse(buildAskCard(sent));
    expect(card.schema).toBe('2.0');
    expect(card.body.elements.filter((e: any) => e.tag === 'form')).toHaveLength(1);
    expect(JSON.stringify(card)).toContain('select_static'); expect(JSON.stringify(card)).toContain('input');
    expect(JSON.stringify(card)).not.toContain('ask_toggle');
    expect(buildTurnReplyAskElements({ ask: sent } as any, 'zh')).toEqual(card.body.elements);
    submitAskForm({ ...args(), values }); const answer = await result;
    expect(turnReplyAskSummary({ ask: sent, result: answer } as any, 'zh')).toContain('0.5');
  });
  it('durably restores submitted mixed values and dispatches them only to the original task', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ask-form-receipt-'));
    try {
      const input = { ...base, originKind: 'host_explicit', requestId: 'original' };
      const deps = { dir, appId: base.larkAppId, register: registerAsk, canResume: () => true, dispatch: vi.fn(async () => true), onError: vi.fn(), now: () => Date.now() };
      const first = createExplicitAskContinuation(deps); const result = first.wait(input);
      await vi.advanceTimersByTimeAsync(0); submitAskForm({ ...args(), values }); const answer = await result;
      const restored = createExplicitAskContinuation({ ...deps, register: vi.fn() });
      expect(await restored.wait(input)).toEqual(answer);
      await expect(restored.wait({ ...input, questions: questions.map(q => q.input ? { ...q, input: { ...q.input, required: false } } : q) })).rejects.toThrow('identity conflict');
      await vi.advanceTimersByTimeAsync(6000); await restored.sweep(); await restored.sweep();
      expect(deps.dispatch).toHaveBeenCalledTimes(1);
      const [receipt, key] = deps.dispatch.mock.calls[0] as unknown as [any, string];
      const trigger = explicitAskRecoveryRequest(receipt, key, 'group');
      expect((trigger.envelope as any).payload.result.inputs).toEqual([null, '0.5', ' extra details ']);
      expect(trigger.target).toEqual({ kind: 'turn', sessionId: 'session' });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
