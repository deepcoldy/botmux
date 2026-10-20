import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseAskQuestions } from '../src/core/ask-api.js';
import { parseAskQuestionsFile } from '../src/core/ask-args.js';
import { _resetForTest, getAskSnapshot, registerAsk, restorePersistedAsks, setAskPersistStore,
  setCanTalkChecker, setCardDispatcher, submitAsk, toggleAsk } from '../src/core/ask-broker.js';
import { createAskPersistStore } from '../src/core/ask-persist-store.js';
import { buildAskCard } from '../src/im/lark/ask-card.js';
import { buildTurnReplyAskElements } from '../src/im/lark/turn-reply-ask-elements.js';
import type { AskQuestion, PendingAsk } from '../src/core/ask-types.js';

const options = [{ key: 'a', label: 'A（推荐）' }, { key: 'b', label: 'B' }];
const question = (over: Partial<AskQuestion> = {}): AskQuestion => ({
  prompt: '覆盖范围？', multiSelect: false, options, defaultSelectedKeys: ['a'], ...over,
});
let sent: PendingAsk[];
let dir: string;
const wire = () => {
  setCardDispatcher({ async send(ask) { sent.push(ask); return { messageId: 'om_test' }; } });
  setCanTalkChecker((_a, _c, user) => user === 'ou_user');
};
const input = (questions = [question()]) => ({
  sessionId: 'session', chatId: 'oc_test', larkAppId: 'app', rootMessageId: 'om_root',
  questions, timeoutMs: 1000,
});
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };
beforeEach(() => {
  vi.useFakeTimers(); _resetForTest(); sent = []; wire();
  dir = mkdtempSync(join(tmpdir(), 'ask-defaults-'));
});
afterEach(() => { _resetForTest(); vi.useRealTimers(); rmSync(dir, { recursive: true, force: true }); });

describe('recommended answers stay drafts until submitted', () => {
  it('initial defaults render selected in both cards, and one human submission answers all questions', async () => {
    const qs = [question(), question({ multiSelect: true, defaultSelectedKeys: ['a', 'b'] })];
    const result = registerAsk(input(qs));
    await flush();
    const ask = getAskSnapshot(sent[0].askId)!;
    expect(ask).toMatchObject({ settled: false, selections: [['a'], ['a', 'b']] });
    const standalone = JSON.parse(buildAskCard(ask));
    const buttons = standalone.elements.flatMap((e: any) => e.actions ?? []);
    expect(buttons.filter((b: any) => b.value.action === 'ask_submit')).toHaveLength(1);
    expect(buttons.filter((b: any) => b.type === 'primary' && b.value.action === 'ask_toggle')).toHaveLength(3);
    const inline = JSON.stringify(buildTurnReplyAskElements({ ask }));
    expect(inline.match(/"action":"ask_submit"/g)).toHaveLength(1);
    expect(inline).not.toContain('ask_select');
    expect(submitAsk({ askId: ask.askId, nonce: ask.nonce, by: 'ou_user' })).toBe('accepted');
    expect(await result).toMatchObject({ answers: [['a'], ['a', 'b']], by: 'ou_user' });
    expect(submitAsk({ askId: ask.askId, nonce: ask.nonce, by: 'ou_user' })).toBe('already_settled');
  });

  it('single question with defaults requires submit; toggling is not an answer', async () => {
    const result = registerAsk(input()); await flush();
    const ask = sent[0];
    expect(buildAskCard(ask)).toContain('ask_submit');
    expect(buildAskCard(ask)).not.toContain('ask_select');
    expect(JSON.stringify(buildTurnReplyAskElements({ ask }))).toContain('ask_submit');
    expect(toggleAsk({ askId: ask.askId, nonce: ask.nonce, questionIndex: 0, key: 'b', by: 'ou_user' })).toBe('toggled');
    expect(getAskSnapshot(ask.askId)).toMatchObject({ settled: false, selections: [['b']] });
    expect(submitAsk({ askId: ask.askId, nonce: ask.nonce, by: 'ou_wrong' })).toBe('unauthorized');
    expect(submitAsk({ askId: ask.askId, nonce: 'old', by: 'ou_user' })).toBe('stale');
    expect(submitAsk({ askId: ask.askId, nonce: ask.nonce, by: 'ou_user' })).toBe('accepted');
    expect(await result).toMatchObject({ answers: [['b']] });
  });

  it('timeout never accepts default answers', async () => {
    const result = registerAsk(input()); await flush();
    await vi.advanceTimersByTimeAsync(1001);
    expect(await result).toMatchObject({ kind: 'timedOut', selected: null });
  });

  it('missing single answer cannot be submitted', async () => {
    void registerAsk(input([question({ defaultSelectedKeys: [] })])); await flush();
    const ask = sent[0];
    expect(submitAsk({ askId: ask.askId, nonce: ask.nonce, by: 'ou_user' })).toBe('stale');
    expect(getAskSnapshot(ask.askId)?.settled).toBe(false);
  });

  it('restart retains cancelled multi defaults and changed single choice', async () => {
    setAskPersistStore(createAskPersistStore(join(dir, 'asks')));
    const request = { ...input([question(), question({ multiSelect: true })]),
      requestId: 'stable', originKind: 'hook', backendSurvivesRestart: true };
    void registerAsk(request); await flush();
    const ask = sent[0];
    for (const [questionIndex, key] of [[0, 'b'], [1, 'a']] as const)
      toggleAsk({ askId: ask.askId, nonce: ask.nonce, by: 'ou_user', questionIndex, key });
    _resetForTest(); wire(); setAskPersistStore(createAskPersistStore(join(dir, 'asks')));
    restorePersistedAsks();
    expect(getAskSnapshot(ask.askId)?.selections).toEqual([['b'], []]);
    const result = registerAsk(request); await flush();
    expect(submitAsk({ askId: ask.askId, nonce: ask.nonce, by: 'ou_user' })).toBe('accepted');
    expect(await result).toMatchObject({ answers: [['b'], []] });
  });

  it('same request id cannot change recommended defaults', async () => {
    setAskPersistStore(createAskPersistStore(join(dir, 'asks')));
    const request = { ...input(), requestId: 'stable', originKind: 'hook', backendSurvivesRestart: true };
    void registerAsk(request); await flush();
    const result = await registerAsk({ ...request, questions: [question({ defaultSelectedKeys: ['b'] })] });
    expect(result.kind).toBe('invalidated');
    expect(sent).toHaveLength(1);
  });
});

describe('question file and API validation', () => {
  it.each([null, 'a', [1], ['missing'], ['a', 'a'], ['a', 'b']])('rejects invalid single defaults %j', defaults => {
    expect(parseAskQuestions([{ ...question(), defaultSelectedKeys: defaults }])).toBe('bad_defaultSelectedKeys');
  });
  it('accepts multi defaults, and file mode always requires submit', () => {
    const qs = [question({ multiSelect: true, defaultSelectedKeys: ['a', 'b'] })];
    expect(parseAskQuestionsFile(JSON.stringify(qs))).toEqual(qs);
    const legacy = { prompt: 'q', options, multiSelect: false };
    expect(parseAskQuestions([legacy])).toEqual([legacy]);
    expect(parseAskQuestionsFile(JSON.stringify([legacy]))).toEqual([{ ...legacy, defaultSelectedKeys: [] }]);
  });
  it.each(['bad json', '[]', '{}', '[null]'])('rejects malformed file %s', raw => {
    expect(() => parseAskQuestionsFile(raw)).toThrow();
  });
});
