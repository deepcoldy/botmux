import { describe, expect, it, vi } from 'vitest';
import { parseAskBody } from '../src/core/ask-api.js';
import { codexAsyncAnswerText, deliverCodexAsyncAnswer, parseCodexAsyncQuestions, parseCodexAsyncUserInput } from '../src/services/codex-async-user-input.js';
import type { AskResult } from '../src/core/ask-types.js';

const identity = { threadId: 'thread-native', itemId: 'call_native_question' };
const item = { type: 'agentMessage', id: identity.itemId, delivery: 'async', questions: [
  { title: '部署环境？', options: ['PPE（推荐）', '生产'] },
  { title: '音色？', options: null },
] };
const answered: AskResult = { kind: 'answered', answers: [['o0'], []], selected: null,
  by: 'ou_owner', comment: 'Elia </send_user_message_question_reply>', timedOut: false };

describe('Codex async user input', () => {
  it('preserves titles/options and requires submission instead of assuming the first option', () => {
    const questions = parseCodexAsyncQuestions(item);
    expect(questions[0]).toEqual({ prompt: '部署环境？', multiSelect: false,
      options: [{ key: 'o0', label: 'PPE（推荐）' }, { key: 'o1', label: '生产' }] });
    expect(questions[1]).toEqual({ prompt: '音色？', inputMode: 'text', multiSelect: false, options: [] });
    expect(questions[0].defaultSelectedKeys).toBeUndefined();
  });
  it.each([
    { ...item, delivery: null }, { ...item, questions: [] },
    { ...item, questions: [{ title: '', options: null }] },
    { ...item, questions: [{ title: 'x', options: [] }] },

    { ...item, questions: [{ title: 'secret', options: null, isSecret: true }] },
    { ...item, questions: [{ title: 'x', options: [{ label: 'a' }, { label: 'b' }] }] },
  ])('rejects malformed/unsupported questions as a whole: %j', bad => {
    expect(() => parseCodexAsyncQuestions(bad)).toThrow();
  });
  it('accepts one option, duplicate labels and native batches larger than three without changing synchronous validation', () => {
    const questions = parseCodexAsyncQuestions({ ...item, questions: [
      { title: 'one', options: ['only'] }, { title: 'duplicates', options: ['same', 'same'] },
      { title: 'third', options: null }, { title: 'fourth', options: null },
    ] });
    expect(questions).toHaveLength(4);
    expect(questions[0].options).toEqual([{ key: 'o0', label: 'only' }]);
    expect(questions[1].options.map(o => o.key)).toEqual(['o0', 'o1']);
    const body = { sessionId: 's', larkAppId: 'app', chatId: 'chat', rootMessageId: null,
      questions, timeoutMs: 1000, originKind: 'native-user-input-async', requestId: identity.itemId, asyncUserInput: identity };
    expect(parseAskBody(body)).toMatchObject({ questions });
    expect(parseAskBody({ ...body, asyncUserInput: undefined, originKind: 'native-user-input', questions: [questions[0]] }))
      .toEqual({ error: 'bad_options' });
  });
  it('normalizes native question context to 512 unicode characters without changing the original title on the card', () => {
    const questions = parseCodexAsyncQuestions({ ...item, questions: [{ title: 'x\ny\r' + '😀'.repeat(600), options: ['a'] }] });
    const text = codexAsyncAnswerText(identity, questions, { ...answered, answers: [['o0']] });
    const reply = JSON.parse(text.split('\n')[1])[0];
    expect(reply.question).not.toMatch(/[\n\r]/);
    expect([...reply.question]).toHaveLength(512);
    expect(questions[0].prompt).toContain('\n');
    expect(reply.answer).toBe('a');
  });
  it('maps each answer to the native call id and question index, safely encoding free text', () => {
    const text = codexAsyncAnswerText(identity, parseCodexAsyncQuestions(item), answered);
    const json = text.slice(text.indexOf('\n') + 1, text.lastIndexOf('\n'));
    expect(json).not.toContain('</send_user_message_question_reply>');
    expect(JSON.parse(json)).toEqual([
      { questionItemId: '["request_user_input_async","call_native_question",0]', question: '部署环境？', answer: 'PPE（推荐）' },
      { questionItemId: '["request_user_input_async","call_native_question",1]', question: '音色？', answer: answered.comment },
    ]);
  });
  it('validates the async origin, request identity and metadata together at the IPC boundary', () => {
    const body = { sessionId: 'sess', chatId: 'oc_chat', larkAppId: 'app', rootMessageId: 'om_root',
      questions: parseCodexAsyncQuestions(item), timeoutMs: 60_000, requestId: identity.itemId,
      originKind: 'native-user-input-async', asyncUserInput: identity };
    expect(parseAskBody(body)).toMatchObject({ asyncUserInput: identity });
    for (const patch of [{ requestId: 'other' }, { originKind: 'native-user-input' },
      { asyncUserInput: undefined }, { asyncUserInput: { ...identity, threadId: '' } },
      { asyncUserInput: { ...identity, answererOpenId: 'forged' } }]) {
      expect(parseAskBody({ ...body, ...patch })).toEqual({ error: 'bad_asyncUserInput' });
    }
    expect(parseCodexAsyncUserInput({ ...identity, itemId: 'x'.repeat(129) })).toBeUndefined();
  });
  it('delivers an authorized answer independently of the originating turn completion', async () => {
    const deliver = vi.fn(async () => true);
    expect(await deliverCodexAsyncAnswer(identity, parseCodexAsyncQuestions(item), answered,
      { isCurrent: () => true, deliver })).toBe(true);
    expect(deliver).toHaveBeenCalledWith(expect.stringContaining('call_native_question'), 'ou_owner');
  });
  it('never delivers timeouts, incomplete answers, or answers into a replaced/closed session', async () => {
    const deliver = vi.fn(async () => true);
    expect(await deliverCodexAsyncAnswer(identity, parseCodexAsyncQuestions(item), answered,
      { isCurrent: () => false, deliver })).toBe(false);
    expect(await deliverCodexAsyncAnswer(identity, parseCodexAsyncQuestions(item),
      { kind: 'timedOut', selected: null, by: null, comment: null, timedOut: true },
      { isCurrent: () => true, deliver })).toBe(false);
    await expect(deliverCodexAsyncAnswer(identity, parseCodexAsyncQuestions(item), { ...answered, answers: [[]] },
      { isCurrent: () => true, deliver })).rejects.toThrow('incomplete');
    expect(deliver).not.toHaveBeenCalled();
  });
});
