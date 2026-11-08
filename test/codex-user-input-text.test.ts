import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseAskBody } from '../src/core/ask-api.js';
import { parseAskQuestions } from '../src/core/ask-questions.js';
import { _resetForTest, registerAsk, setCardDispatcher, setCanTalkChecker, submitAsk, submitCustomReply, applyAskForm } from '../src/core/ask-broker.js';
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
  it('renders mixed text/choice questions as one per-question form with a single final submit', async () => {
    const questions = parseCodexUserInputQuestions(params).map(q => q.question);
    const controller = new AbortController();
    const result = registerAsk({ sessionId: 'session', larkAppId: 'app', chatId: 'chat', rootMessageId: null,
      timeoutMs: 10000, questions, originKind: 'native-user-input' }, controller.signal);
    await Promise.resolve();
    const nodes = (v: unknown): any[] => v && typeof v === 'object' ? [v, ...Object.values(v).flatMap(nodes)] : [];
    // Standalone card is a full Card 2.0 document; the live reply card embeds a
    // list of elements — both must expose the same form controls.
    const standalone = JSON.parse(buildAskCard(cards[0]));
    const inline = { body: { elements: buildTurnReplyAskElements({ ask: cards[0] }) } };
    for (const card of [standalone, inline]) {
      const flat = JSON.stringify(card);
      // Every prompt and choice label stays visible (labels are separate buttons now).
      expect(flat).toContain('Which constraints matter?');
      expect(flat).toContain('Choose channel');
      expect(flat).toContain('Lark');
      expect(flat).toContain('Email');
      const all = nodes(card);
      // The text question is a form input; the batch settles through one submit.
      expect(all.some(n => n.tag === 'input' && n.name === 'custom_0')).toBe(true);
      expect(all.filter(n => n.tag === 'button' && n.value?.action === 'ask_submit')).toHaveLength(1);
      // No single-step select control: mixed batches cannot settle one question alone.
      expect(all.every(n => n.value?.action !== 'ask_select')).toBe(true);
    }
    controller.abort(); await result;
  });
  it('maps per-question custom text and a selected choice back to each native question id', async () => {
    const parsed = parseCodexUserInputQuestions(params);
    const questions = parsed.map(q => q.question);
    const promise = registerAsk({ sessionId: 'session', larkAppId: 'app', chatId: 'chat', rootMessageId: null,
      timeoutMs: 10000, questions, originKind: 'native-user-input' });
    await Promise.resolve();
    const ask = cards[0];
    // Text typed into question 0 survives a choice toggle on question 1 in the same form.
    expect(applyAskForm({ askId: ask.askId, nonce: ask.nonce, by: 'authorized', revision: 0,
      fields: { custom_0: 'Use staging data only', custom_1: '' },
      toggle: { questionIndex: 1, key: 'Lark' } })).toBe('toggled');
    expect(applyAskForm({ askId: ask.askId, nonce: ask.nonce, by: 'authorized', revision: 1,
      fields: { custom_0: 'Use staging data only', custom_1: '' } })).toBe('accepted');
    expect(codexUserInputAnswer(parsed, await promise)).toEqual({ answers: {
      requirements: { answers: ['Use staging data only'] }, channel: { answers: ['Lark'] },
    } });
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
