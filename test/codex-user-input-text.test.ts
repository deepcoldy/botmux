import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseAskBody } from '../src/core/ask-api.js';
import { parseAskQuestions } from '../src/core/ask-questions.js';
import { _resetForTest, registerAsk, setCardDispatcher, setCanTalkChecker, submitAsk, submitCustomReply } from '../src/core/ask-broker.js';
import type { PendingAsk } from '../src/core/ask-types.js';
import { buildAskCard } from '../src/im/lark/ask-card.js';
import { buildTurnReplyAskElements } from '../src/im/lark/turn-reply-ask-elements.js';
import { parseCodexUserInputQuestions, codexUserInputAnswer } from '../src/services/codex-user-input.js';
const params = { questions: [
  { id: 'requirements', question: 'Which constraints matter?', isSecret: false, options: null },
  { id: 'channel', question: 'Choose channel', options: [{ label: 'Lark' }, { label: 'Email' }] },
] };
let cards: PendingAsk[];
beforeEach(() => {
  _resetForTest(); cards = [];
  setCanTalkChecker((_app, _chat, user) => user === 'authorized');
  setCardDispatcher({ async send(ask) { cards.push(ask); return { messageId: 'text-card' }; } });
});
afterEach(() => _resetForTest());
describe('native text question cards', () => {
  it('validates text-only questions without weakening the choice-question contract', () => {
    const questions = parseCodexUserInputQuestions(params).map(q => q.question);
    expect(parseAskQuestions(questions)).toEqual(questions);
    expect(parseAskQuestions([{ prompt: 'Text?', multiSelect: false, options: [] }])).toBe('bad_options');
    expect(parseAskQuestions([{ ...questions[0], multiSelect: true }])).toBe('bad_inputMode');
    expect(parseAskQuestions([{ ...questions[0], defaultSelectedKeys: [] }])).toBe('bad_inputMode');
    const body = { sessionId: 'session', larkAppId: 'app', chatId: 'chat', rootMessageId: null, timeoutMs: 10000, questions };
    expect(parseAskBody(body)).toEqual(body);
  });
  it('renders both card formats without empty submit buttons and retains all question/choice text', async () => {
    const questions = parseCodexUserInputQuestions(params).map(q => q.question);
    const controller = new AbortController();
    const result = registerAsk({ sessionId: 'session', larkAppId: 'app', chatId: 'chat', rootMessageId: null,
      timeoutMs: 10000, questions, originKind: 'native-user-input' }, controller.signal);
    await Promise.resolve();
    const standalone = buildAskCard(cards[0]);
    const inline = JSON.stringify(buildTurnReplyAskElements({ ask: cards[0] }));
    for (const rendered of [standalone, inline]) {
      expect(rendered).toContain('Which constraints matter?'); expect(rendered).toContain('Lark / Email');
      expect(rendered).not.toContain('ask_submit'); expect(rendered).not.toContain('ask_select');
    }
    controller.abort(); await result;
  });
  it('requires an authorized text answer and maps it back under every native question id', async () => {
    const questions = parseCodexUserInputQuestions(params);
    const promise = registerAsk({ sessionId: 'session', larkAppId: 'app', chatId: 'chat', rootMessageId: null,
      timeoutMs: 10000, questions: questions.map(q => q.question), originKind: 'native-user-input' });
    await Promise.resolve();
    const ask = cards[0];
    expect(submitCustomReply({ askId: ask.askId, by: 'unauthorized', text: 'Go ahead' })).toBe('unauthorized');
    expect(submitAsk({ askId: ask.askId, nonce: ask.nonce, by: 'authorized' })).toBe('stale');
    expect(submitCustomReply({ askId: ask.askId, by: 'authorized', text: 'Preserve old data; use Lark' })).toBe('accepted');
    expect(codexUserInputAnswer(questions, await promise)).toEqual({ answers: {
      requirements: { answers: ['Preserve old data; use Lark'] }, channel: { answers: ['Preserve old data; use Lark'] },
    } });
  });
});
