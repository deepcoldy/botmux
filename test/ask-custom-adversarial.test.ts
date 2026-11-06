import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, renameSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _resetForTest, applyAskForm, getAskSnapshot, invalidateAll, registerAsk, registerHostAsk,
  restorePersistedAsks, setAskPersistStore, setCanTalkChecker, setCardDispatcher } from '../src/core/ask-broker.js';
import { createAskPersistStore, type AskPersistStore } from '../src/core/ask-persist-store.js';
import { handleAskCardAction } from '../src/im/lark/ask-card.js';
import { turnReplyCardRequestBytes, TURN_REPLY_CARD_MAX_BYTES } from '../src/im/lark/turn-reply-card-size.js';
import type { CreateAskInput, PendingAsk } from '../src/core/ask-types.js';

const questions = ['q0', 'q1'].map(prompt => ({ prompt, multiSelect: true,
  options: [{ key: 'a', label: 'A' }, { key: 'b', label: 'B' }] }));
const input: CreateAskInput = { larkAppId: 'cli_adversarial', chatId: 'oc_test', rootMessageId: 'om_test',
  sessionId: 'sess_probe', requestId: 'req_probe', originKind: 'hook', backendSurvivesRestart: true,
  questions, timeoutMs: 10_000 };
let dir: string;
let store: AskPersistStore;
let sent: PendingAsk[];
function wire() {
  store = createAskPersistStore(dir);
  setAskPersistStore(store);
  setCanTalkChecker((_a, _c, by) => by === 'owner');
  setCardDispatcher({ async send(ask) { sent.push(ask); return { messageId: 'om_probe' }; } });
}
beforeEach(() => { vi.useFakeTimers(); dir = mkdtempSync(join(tmpdir(), 'ask-adversarial-')); sent = []; wire(); });
afterEach(() => { _resetForTest(); vi.useRealTimers(); rmSync(dir, { recursive: true, force: true }); });
async function start(host = false) {
  const promise = host ? registerHostAsk({ ...input, originKind: 'host_explicit' }) : registerAsk(input);
  await vi.advanceTimersByTimeAsync(0);
  const ask = sent[0];
  return { promise, args: { askId: ask.askId, nonce: ask.nonce, by: 'owner', revision: 0, fields: {} } };
}
function nodes(value: any): any[] { return value && typeof value === 'object' ? [value, ...Object.values(value).flatMap(nodes)] : []; }

describe('custom Ask independent adversarial probes', () => {
  it('does not resurrect cleared text when arming empty confirmation', async () => {
    const { args, promise } = await start();
    applyAskForm({ ...args, fields: { custom_0: 'old draft' }, toggle: { questionIndex: 1, key: 'a' } });
    applyAskForm({ ...args, revision: 1, toggle: { questionIndex: 1, key: 'a' } });
    const response: any = await handleAskCardAction({ operator: { open_id: 'owner' }, action: {
      value: { action: 'ask_submit', custom_form: 'v1', ask_id: args.askId, nonce: args.nonce, revision: '2' },
      form_value: { custom_0: '', custom_1: '' },
    } });
    const formInput = nodes(response).find(n => n.name === 'custom_0');
    expect(formInput.default_value).toBe('');
    const submit = nodes(response).find(n => n.name === 'submit_answers');
    await handleAskCardAction({ operator: { open_id: 'owner' }, action: {
      value: submit.value, form_value: { custom_0: formInput.default_value, custom_1: '' },
    } });
    expect(await promise).toMatchObject({ kind: 'answered', answers: [[], []] });
    expect(getAskSnapshot(args.askId)?.result).not.toHaveProperty('customAnswers');
  });

  it('keeps a valid eight-question draft within the card transport budget', async () => {
    const many = Array.from({ length: 8 }, (_, i) => ({ ...questions[0], prompt: `Question ${i}` }));
    void registerAsk({ ...input, questions: many });
    await vi.advanceTimersByTimeAsync(0);
    const ask = sent[0];
    const response: any = await handleAskCardAction({ operator: { open_id: 'owner' }, action: {
      value: { action: 'ask_toggle', custom_form: 'v1', ask_id: ask.askId, nonce: ask.nonce,
        revision: '0', question_index: '7', key: 'a' },
      form_value: Object.fromEntries(many.map((_, i) => [`custom_${i}`, '汉'.repeat(1000)])),
    } });
    const responseCard = response.card?.data;
    // Rejection with a toast is valid; committing a draft then emitting an unrenderable card is not.
    if (responseCard) expect(turnReplyCardRequestBytes(JSON.stringify(responseCard), ask.chatId)).toBeLessThanOrEqual(TURN_REPLY_CARD_MAX_BYTES);
    else expect(getAskSnapshot(ask.askId)?.customRevision).toBeUndefined();
  });

  it('rejects a reconnect that changes whether custom answers are permitted', async () => {
    const { args } = await start();
    applyAskForm({ ...args, fields: { custom_0: 'custom' }, toggle: { questionIndex: 1, key: 'a' } });
    applyAskForm({ ...args, revision: 1 });
    const replay = await registerAsk({ ...input, questions: input.questions.map(q => ({ ...q, allowCustom: false })) });
    expect(replay.kind).toBe('invalidated');
  });

  it('upgrades old callbacks atomically and recovers a lost first response with the current form', async () => {
    const { args } = await start();
    const legacyClick = (key: string) => handleAskCardAction({ operator: { open_id: 'owner' }, action: {
      value: { action: 'ask_toggle', ask_id: args.askId, nonce: args.nonce, question_index: '0', key },
    } });
    await legacyClick('a'); // first response can be lost after the draft commits
    const upgraded = getAskSnapshot(args.askId)!;
    const retry = await legacyClick('b');
    expect(upgraded.selections).toEqual(getAskSnapshot(args.askId)?.selections);
    // The old card client needs the current form in order to continue after a lost response.
    const submit = nodes(retry).find(n => n.name === 'submit_answers');
    expect(submit).toBeDefined();
    expect(Number(submit.value.revision)).toBe(getAskSnapshot(args.askId)?.customRevision);
  });

  it('manual invalidation after a saved draft prevents the delayed submit', async () => {
    const { args, promise } = await start();
    applyAskForm({ ...args, fields: { custom_0: 'draft' }, toggle: { questionIndex: 1, key: 'a' } });
    invalidateAll('operator cancelled');
    expect(await promise).toMatchObject({ kind: 'invalidated' });
    expect(applyAskForm({ ...args, revision: 1 })).toBe('already_settled');
    _resetForTest(); wire();
    expect(restorePersistedAsks(Date.now(), input.larkAppId)).toBe(0);
  });

  it('permission revocation during a draft denies the delayed submit without losing the draft', async () => {
    const { args, promise } = await start();
    applyAskForm({ ...args, fields: { custom_0: 'draft' }, toggle: { questionIndex: 1, key: 'a' } });
    setCanTalkChecker(() => false);
    expect(applyAskForm({ ...args, revision: 1, fields: { custom_0: 'changed' } })).toBe('unauthorized');
    expect(getAskSnapshot(args.askId)).toMatchObject({ settled: false, customAnswers: ['draft', null] });
    setCanTalkChecker((_a, _c, by) => by === 'owner');
    expect(applyAskForm({ ...args, revision: 1 })).toBe('accepted');
    expect(await promise).toMatchObject({ customAnswers: ['draft', null] });
  });

  it('a draft write failure does not publish half a new revision; retry commits once', async () => {
    const { args } = await start();
    // Make the real persistence directory unavailable; exercise the store's strict path too.
    const saved = `${dir}.saved`;
    renameSync(dir, saved);
    writeFileSync(dir, 'filesystem obstacle');
    try {
      expect(() => applyAskForm({ ...args, fields: { custom_0: 'draft' }, toggle: { questionIndex: 1, key: 'a' } })).toThrow();
      expect(getAskSnapshot(args.askId)).toMatchObject({ selections: [[], []] });
      expect(getAskSnapshot(args.askId)?.customRevision).toBeUndefined();
    } finally {
      unlinkSync(dir);
      renameSync(saved, dir);
    }
    expect(applyAskForm({ ...args, fields: { custom_0: 'draft' }, toggle: { questionIndex: 1, key: 'a' } })).toBe('toggled');
    _resetForTest(); wire(); restorePersistedAsks(Date.now(), input.larkAppId);
    expect(getAskSnapshot(args.askId)).toMatchObject({ customRevision: 1, customAnswers: ['draft', null], selections: [[], ['a']] });
  });

  it('durable draft written but response lost is replay-safe after restart', async () => {
    const { args } = await start();
    const put = store.put.bind(store);
    store.put = (record, options) => { put(record, options); throw new Error('after durable write'); };
    expect(() => applyAskForm({ ...args, fields: { custom_0: 'draft' }, toggle: { questionIndex: 1, key: 'a' } })).toThrow();
    _resetForTest(); wire(); restorePersistedAsks(Date.now(), input.larkAppId);
    expect(applyAskForm({ ...args, fields: { custom_0: 'draft' }, toggle: { questionIndex: 1, key: 'a' } })).toBe('draft_conflict');
    expect(getAskSnapshot(args.askId)).toMatchObject({ customRevision: 1, selections: [[], ['a']] });
    expect(applyAskForm({ ...args, revision: 1 })).toBe('accepted');
    expect(await registerAsk(input)).toMatchObject({ answers: [[], ['a']], customAnswers: ['draft', null] });
  });

  it('a failed explicit terminal write remains pending and deadline may win before retry', async () => {
    const { args, promise } = await start(true);
    const put = store.put.bind(store);
    store.put = (record, options) => { if (record.answeredResult?.kind === 'answered') throw new Error('answer fsync failure'); put(record, options); };
    expect(() => applyAskForm({ ...args, fields: { custom_0: 'final text' } })).toThrow();
    expect(getAskSnapshot(args.askId)?.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(10_001);
    expect(await promise).toMatchObject({ kind: 'timedOut' });
    expect(applyAskForm({ ...args, fields: { custom_0: 'retry' } })).toBe('already_settled');
  });
});
