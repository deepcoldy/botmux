import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _resetForTest, applyAskForm, getAskSnapshot, registerAsk, registerHostAsk, setCanTalkChecker,
  setCardDispatcher, setAskPersistStore, restorePersistedAsks } from '../src/core/ask-broker.js';
import { createAskPersistStore } from '../src/core/ask-persist-store.js';
import type { CreateAskInput, PendingAsk, AskResult } from '../src/core/ask-types.js';
import { handleAskCardAction, buildAskCard } from '../src/im/lark/ask-card.js';
import { buildTurnReplyAskElements, turnReplyAskSummary } from '../src/im/lark/turn-reply-ask-elements.js';
import { parseAskQuestions } from '../src/core/ask-questions.js';
import { codexUserInputAnswer } from '../src/services/codex-user-input.js';
import { codexAsyncAnswerText } from '../src/services/codex-async-user-input.js';
import claude from '../src/core/ask-hook/claude-code.js';
import opencode from '../src/core/ask-hook/opencode.js';
import dsh from '../src/core/ask-hook/dsh.js';
import { supportsAskCustomInput } from '../src/core/ask-custom-input.js';

const questions = ['环境', '测试范围'].map(prompt => ({ prompt, multiSelect: false,
  options: [{ key: 'a', label: 'A' }, { key: 'b', label: 'B' }], defaultSelectedKeys: ['a'] }));
const input: CreateAskInput = { larkAppId: 'cli_test', chatId: 'oc_test', rootMessageId: 'om_test',
  sessionId: 'session', requestId: 'request', originKind: 'hook', backendSurvivesRestart: true, questions, timeoutMs: 60_000 };
let sent: PendingAsk[];
let dir: string;
function wire() {
  setCardDispatcher({ async send(ask) { sent.push(ask); return { messageId: 'om_card' }; } });
  setCanTalkChecker((_a, _c, by) => by === 'ou_owner');
  setAskPersistStore(createAskPersistStore(dir));
}
beforeEach(() => { vi.useFakeTimers(); sent = []; dir = mkdtempSync(join(tmpdir(), 'ask-custom-')); wire(); });
afterEach(() => { _resetForTest(); vi.useRealTimers(); rmSync(dir, { recursive: true, force: true }); });
async function start(overrides: Partial<CreateAskInput> = {}) {
  const promise = registerAsk({ ...input, ...overrides });
  await vi.advanceTimersByTimeAsync(0);
  const ask = sent[0];
  return { ask, promise, args: { askId: ask.askId, nonce: ask.nonce, by: 'ou_owner', revision: 0, fields: {} } };
}
function descendants(value: any): any[] {
  return value && typeof value === 'object' ? [value, ...Object.values(value).flatMap(descendants)] : [];
}

describe('per-question custom form', () => {
  it('renders each option on its own row and the last other option alongside a single-line input', async () => {
    const { ask } = await start();
    const form = descendants(JSON.parse(buildAskCard(ask))).find(n => n.tag === 'form');
    const rows = form.elements.filter((n: any) => n.tag === 'column_set');
    expect(rows).toHaveLength(4);
    expect(rows[0].columns[0].elements.map((button: any) => button.text.content)).toEqual(['◉ A', '○ B']);
    expect(rows[1].columns).toHaveLength(2);
    expect(rows[1].columns[0].elements[0].text.content).toContain('○');
    expect(rows[1].columns[0].elements[0].value.custom_choice).toBe('true');
    expect(rows[1].columns[1].elements[0]).toMatchObject({ tag: 'input', name: 'custom_0' });
    expect(rows[1].columns[1].elements[0].input_type).not.toBe('multiline_text');
  });

  it('keeps eleven questions with 42 options within the verified card element budget', async () => {
    const counts = [3, 4, 4, 4, 4, 4, 4, 4, 3, 4, 4];
    const qs = counts.map((count, i) => ({ prompt: `问题 ${i + 1}`, multiSelect: false,
      options: Array.from({ length: count }, (_, j) => ({ key: `k${j}`, label: `选项${j}` })) }));
    const { ask } = await start({ questions: qs });
    const card = JSON.parse(buildAskCard(ask));
    const nodes = descendants(card);
    expect(nodes.filter(n => n.tag === 'button')).toHaveLength(42 + 11 + 1);
    expect(nodes.filter(n => n.tag === 'input')).toHaveLength(11);
    expect(nodes.filter(n => typeof n.tag === 'string')).toHaveLength(199);
  });

  it('selects other, persists its empty state, requires text and submits the custom answer', async () => {
    const { ask, promise } = await start();
    const initial = descendants(JSON.parse(buildAskCard(ask))).find(n => n.name === 'custom_option_0');
    const clicked: any = await handleAskCardAction({ operator: { open_id: 'ou_owner' }, action: {
      value: initial.value, form_value: { custom_0: '', custom_1: '' },
    } });
    expect(getAskSnapshot(ask.askId)).toMatchObject({ selections: [[], ['a']], customAnswers: ['', null] });
    const nodes = descendants(clicked.card.data);
    expect(nodes.find(n => n.name === 'custom_option_0').text.content).toContain('◉');
    const submit = nodes.find(n => n.name === 'submit_answers');
    const empty: any = await handleAskCardAction({ operator: { open_id: 'ou_owner' }, action: {
      value: submit.value, form_value: { custom_0: '', custom_1: '' },
    } });
    expect(empty.toast.type).toBe('warning');
    expect(getAskSnapshot(ask.askId)?.settled).toBe(false);
    await handleAskCardAction({ operator: { open_id: 'ou_owner' }, action: {
      value: submit.value, form_value: { custom_0: '指定社区', custom_1: '' },
    } });
    expect(await promise).toMatchObject({ answers: [[], ['a']], customAnswers: ['指定社区', null] });
  });

  it('captures text while toggling another question, then submits the mixed batch exactly once', async () => {
    const { ask, promise, args } = await start();
    const firstCard = JSON.parse(buildAskCard(ask));
    expect(firstCard.schema).toBe('2.0');
    const nodes = descendants(firstCard);
    expect(nodes.filter(n => n.tag === 'input').map(n => n.name)).toEqual(['custom_0', 'custom_1']);
    expect(nodes.filter(n => n.tag === 'button').every(n => n.action_type === 'form_submit')).toBe(true);
    const toggle = nodes.find(n => n.value?.question_index === '1' && n.value?.key === 'b');
    const response: any = await handleAskCardAction({ operator: { open_id: 'ou_owner' }, action: {
      value: toggle.value, form_value: { custom_0: '社区 C\n只用隔离数据', custom_1: '' },
    } });
    expect(getAskSnapshot(ask.askId)?.settled).toBe(false);
    const draft = descendants(response.card.data).find(n => n.name === 'custom_0');
    expect(draft.default_value).toBe('社区 C\n只用隔离数据');
    const submit = descendants(response.card.data).find(n => n.name === 'submit_answers');
    await handleAskCardAction({ operator: { open_id: 'ou_owner' }, action: {
      value: submit.value, form_value: { custom_0: draft.default_value, custom_1: '' },
    } });
    expect(await promise).toMatchObject({ kind: 'answered', answers: [[], ['b']], customAnswers: ['社区 C\n只用隔离数据', null], comment: null });
    expect(applyAskForm({ ...args, revision: 1, fields: { custom_0: 'overwrite' } })).toBe('already_settled');
  });

  it('switches a custom answer back to an option without clearing other text', async () => {
    const { args } = await start();
    expect(applyAskForm({ ...args, fields: { custom_0: 'first', custom_1: 'second' }, toggle: { questionIndex: 0, key: 'b' } })).toBe('toggled');
    expect(getAskSnapshot(args.askId)).toMatchObject({ customAnswers: [null, 'second'], selections: [['b'], ['a']] });
  });

  it('rejects unauthorized, cross-bot, wrong nonce and stale revision writes without changing the draft', async () => {
    const { args } = await start();
    expect(applyAskForm({ ...args, by: 'intruder', fields: { custom_0: 'bad' } })).toBe('unauthorized');
    expect(applyAskForm({ ...args, nonce: 'old', fields: { custom_0: 'bad' } })).toBe('stale');
    expect(applyAskForm({ ...args, fields: { custom_0: 'saved' }, toggle: { questionIndex: 1, key: 'b' } })).toBe('toggled');
    expect(applyAskForm({ ...args, fields: { custom_0: 'lost' } })).toBe('draft_conflict');
    const res: any = await handleAskCardAction({ operator: { open_id: 'ou_owner' }, action: { value: {
      action: 'ask_submit', ask_id: args.askId, nonce: args.nonce, custom_form: 'v1', revision: '1',
    }, form_value: { custom_0: 'bad' } } }, { larkAppId: 'other_bot' });
    expect(res.toast.type).toBe('warning');
    expect(getAskSnapshot(args.askId)).toMatchObject({ settled: false, customAnswers: ['saved', null], customRevision: 1 });
  });

  it.each([{ custom_2: 'foreign' }, { custom_0: ['bad'] }, { custom_0: 'x'.repeat(1001) }])('rejects malformed fields atomically: %j', async fields => {
    const { args } = await start();
    expect(applyAskForm({ ...args, fields, toggle: { questionIndex: 1, key: 'b' } })).toBe('invalid_custom');
    expect(getAskSnapshot(args.askId)?.selections).toEqual([['a'], ['a']]);
  });

  it('keeps incomplete or whitespace-only answers pending, and permits text-only questions', async () => {
    const { args, promise } = await start({ questions: [{ prompt: '输入', inputMode: 'text', options: [], multiSelect: false }, questions[1]] });
    expect(applyAskForm({ ...args, fields: { custom_0: '  ' } })).toBe('invalid_custom');
    expect(applyAskForm({ ...args, fields: { custom_0: '指定社区' } })).toBe('accepted');
    expect(await promise).toMatchObject({ answers: [[], ['a']], customAnswers: ['指定社区', null] });
  });

  it('restarts with drafts and revision intact, and hands a dormant mixed answer to its original claimant', async () => {
    const { args } = await start();
    applyAskForm({ ...args, fields: { custom_0: 'durable' }, toggle: { questionIndex: 1, key: 'b' } });
    _resetForTest(); wire(); restorePersistedAsks(Date.now(), input.larkAppId);
    expect(getAskSnapshot(args.askId)).toMatchObject({ customAnswers: ['durable', null], customRevision: 1 });
    expect(applyAskForm({ ...args, revision: 1 })).toBe('accepted');
    _resetForTest(); wire(); restorePersistedAsks(Date.now(), input.larkAppId);
    expect(await registerAsk(input)).toMatchObject({ answers: [[], ['b']], customAnswers: ['durable', null] });
    expect(sent).toHaveLength(1);
  });

  it('a timeout wins over a delayed submission; typing never extends its deadline', async () => {
    const { args, promise } = await start({ timeoutMs: 100 });
    await vi.advanceTimersByTimeAsync(90);
    applyAskForm({ ...args, fields: { custom_0: 'draft' }, toggle: { questionIndex: 1, key: 'b' } });
    await vi.advanceTimersByTimeAsync(11);
    expect(await promise).toMatchObject({ kind: 'timedOut' });
    expect(applyAskForm({ ...args, revision: 1 })).toBe('already_settled');
  });

  it('closed host approvals and disabled questions cannot acquire custom answers', async () => {
    expect(supportsAskCustomInput({ originKind: 'host_cross_principal_choice', questions })).toBe(false);
    const parsed = claude.parsePermissionRequest!({ hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'echo test' } })!;
    expect(supportsAskCustomInput({ originKind: 'hook', questions: parsed.questions })).toBe(false);
    const { args } = await start({ questions: [{ ...questions[0], allowCustom: false }, questions[1]] });
    expect(applyAskForm({ ...args, fields: { custom_0: 'yes' } })).toBe('invalid_custom');
    expect(parseAskQuestions([{ ...questions[0], allowCustom: false }])).toMatchObject([{ allowCustom: false }]);
    expect(typeof parseAskQuestions([{ ...questions[0], allowCustom: 'yes' }])).toBe('string');
  });

  it('inline and settled cards preserve per-question answers', async () => {
    const { ask } = await start();
    expect(descendants(buildTurnReplyAskElements({ ask } as any)).filter(n => n.tag === 'input')).toHaveLength(2);
    const result: AskResult = { kind: 'answered', answers: [[], ['b']], customAnswers: ['社区 C', null], comment: null, by: 'ou_owner', timedOut: false };
    expect(turnReplyAskSummary({ ask, result } as any)).toContain('社区 C');
    expect(JSON.stringify(JSON.parse(buildAskCard(ask, result)))).toContain('社区 C');
  });

  it('keeps question identity in native Codex and independent CLI answer adapters', () => {
    const result: Extract<AskResult, { kind: 'answered' }> = { kind: 'answered', answers: [[], ['b']], customAnswers: ['社区 C', null], by: 'ou_owner', comment: null, timedOut: false };
    expect(codexUserInputAnswer(questions.map((question, i) => ({ id: `q${i}`, question })), result)).toEqual({ answers: { q0: { answers: ['社区 C'] }, q1: { answers: ['b'] } } });
    const parsed = { questions, raw: { tool_input: { questions }, rawQuestions: [{ id: 'q0' }, { id: 'q1' }] } };
    const claudeOut = JSON.parse(claude.formatAnswer(result.answers, parsed, null, result.customAnswers));
    expect(claudeOut.hookSpecificOutput.updatedInput.answers).toEqual({ 环境: '社区 C', 测试范围: 'B' });
    expect(JSON.parse(opencode.formatAnswer(result.answers, parsed, null, result.customAnswers)).answers).toEqual([['社区 C'], ['B']]);
    expect(JSON.parse(dsh.formatAnswer(result.answers, parsed, null, result.customAnswers)).answers[0]).toMatchObject({ selected: [], custom: '社区 C' });
    expect(codexAsyncAnswerText({ itemId: 'item' } as any, questions, result)).toContain('社区 C');
  });
});
