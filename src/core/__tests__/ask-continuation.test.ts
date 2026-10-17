import { afterEach, beforeEach, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { _resetForTest, _getPending, setCardDispatcher, setCanTalkChecker, setAskPersistStore,
  registerContinuationAsk, reconcileAskContinuations, listAskContinuations, tryResolveAsk,
  restorePersistedAsks, invalidateAll, readContinuationAskFact } from '../ask-broker.js';
import { createAskPersistStore } from '../ask-persist-store.js';
import { createAskContinuationDispatcher, continuationRequest } from '../ask-continuation.js';
import { parseAskBody } from '../ask-api.js';
import type { CreateAskInput } from '../ask-types.js';
let directory: string, store: ReturnType<typeof createAskPersistStore>, cards: number;
const input: CreateAskInput = { larkAppId: 'app', sessionId: 'session', chatId: 'chat', rootMessageId: null,
  requestId: 'question-1', timeoutMs: 1000, questions: [{ prompt: 'Continue?', multiSelect: false,
    options: [{ key: 'yes', label: 'Yes' }, { key: 'no', label: 'No' }] }],
  continuation: { originTurnId: 'origin', originDispatchAttempt: 1, state: 'waiting' } };
function boot() { setAskPersistStore(store); setCanTalkChecker(() => true);
  setCardDispatcher({ async send() { cards++; return { messageId: 'card' }; } }); }
beforeEach(() => { _resetForTest(); directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ask-host-wait-'));
  store = createAskPersistStore(directory); cards = 0; boot(); });
afterEach(() => { _resetForTest(); fs.rmSync(directory, { recursive: true, force: true }); });
function answer(id: string) { const ask = _getPending(id)!;
  expect(tryResolveAsk({ askId: id, nonce: ask.nonce, selected: 'yes', by: 'owner' })).toBe('accepted'); }

it('acknowledges only the registration and keeps a late answer after the origin has ended', async () => {
  const registration = registerContinuationAsk(input);
  expect(registration).toMatchObject({ state: 'waiting_for_user', deliveryMode: 'continuation' });
  expect(registration).not.toHaveProperty('answers');
  await Promise.resolve(); invalidateAll('daemon shutdown');
  expect(store.list(Date.now() + 20 * 60_000)).toHaveLength(1);
  answer(registration.askId);
  expect(store.list()[0].answeredResult).toMatchObject({ kind: 'answered', answers: [['yes']] });
  expect(registerContinuationAsk(input)).toMatchObject({ askId: registration.askId, state: 'answer_received' });
  expect(cards).toBe(1);
});
it('restores a host wait and stashed answer with the original card and session', async () => {
  const registration = registerContinuationAsk(input); await Promise.resolve();
  _resetForTest(); boot(); expect(restorePersistedAsks(Date.now() + 20 * 60_000, 'app')).toBe(1);
  answer(registration.askId); _resetForTest(); boot(); restorePersistedAsks(Date.now() + 25 * 60 * 60_000, 'app');
  let delivered = 0;
  await reconcileAskContinuations('app', async data => { delivered++;
    expect(data).toMatchObject({ sessionId: 'session', continuation: { originTurnId: 'origin' } });
    return { state: 'committed', triggerId: 'successor' }; });
  await reconcileAskContinuations('app', async () => { throw new Error('must not redeliver'); });
  expect(delivered).toBe(1); expect(cards).toBe(1);
});
it('observes the same accepted native input after response loss, with one delivery claim', async () => {
  answer(registerContinuationAsk(input).askId);
  let submissions = 0, registered = false, committed = false;
  const dispatch = createAskContinuationDispatcher({
    observe: () => ({ status: 200, body: { ok: true, schemaVersion: 1, larkAppId: 'app', sessionId: 'session',
      state: registered ? 'registered' : 'unknown', registration: registered ? { triggerId: 'successor' } : undefined,
      inputCommitted: { state: committed ? 'observed' : 'unknown' } } }),
    submit: async request => { submissions++; expect(request.target.sessionId).toBe('session');
      expect(request.options?.asyncReturnSessionId).toBe(true); expect(request.options?.turnIdempotencyKey).toMatch(/^ask-answer:/); registered = true; throw new Error('response lost'); },
  });
  await Promise.all([reconcileAskContinuations('app', dispatch), reconcileAskContinuations('app', dispatch)]);
  expect(submissions).toBe(1); expect(store.list()[0].answeredResult).toBeDefined();
  await reconcileAskContinuations('app', dispatch); expect(listAskContinuations()[0].continuation.state).toBe('accepted');
  committed = true; await reconcileAskContinuations('app', dispatch);
  expect(listAskContinuations()[0].continuation.state).toBe('committed'); expect(submissions).toBe(1);
});
it('rejects a reused question key from a different execution', () => {
  registerContinuationAsk(input);
  expect(() => registerContinuationAsk({ ...input, continuation: { state: 'waiting', originTurnId: 'other' } })).toThrow(/identity_changed/);
});
it('requires opt-in and stable identity on the public Ask boundary', () => {
  const body = { ...input, continuation: undefined, deliveryMode: 'continuation' };
  expect(parseAskBody(body)).toMatchObject({ deliveryMode: 'continuation' });
  expect(parseAskBody({ ...body, requestId: undefined })).toEqual({ error: 'bad_requestId' });
  expect(parseAskBody({ ...body, deliveryMode: 'typo' })).toEqual({ error: 'bad_deliveryMode' });
});
it('does not publish or acknowledge a wait when durable storage is unavailable', () => {
  setAskPersistStore({ ...store, put() { throw new Error('disk failure'); } });
  expect(() => registerContinuationAsk(input)).toThrow(/disk failure/);
  expect(cards).toBe(0); expect(listAskContinuations()).toHaveLength(0);
});

it('recovers a card whose first send failed without abandoning the original wait', async () => {
  setCardDispatcher({ async send() { throw new Error('transport offline'); } });
  const registered = registerContinuationAsk(input); await new Promise(resolve => setTimeout(resolve, 0));
  expect(store.list()[0].continuation?.state).toBe('blocked');
  expect(store.list()[0].answeredResult).toBeUndefined();
  _resetForTest(); boot(); restorePersistedAsks(Date.now(), 'app');
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(store.list()[0].cardMessageId).toBe('card'); expect(cards).toBe(1);
  answer(registered.askId); expect(store.list()[0].answeredResult?.kind).toBe('answered');
});
it('a failed answer write is not acknowledged and can be retried on the same card', async () => {
  const registered = registerContinuationAsk(input); await Promise.resolve();
  const ask = _getPending(registered.askId)!;
  setAskPersistStore({ ...store, put() { throw new Error('answer disk failed'); } });
  expect(() => tryResolveAsk({ askId: ask.askId, nonce: ask.nonce, selected: 'yes', by: 'owner' })).toThrow(/disk/);
  expect(store.list()[0].answeredResult).toBeUndefined();
  setAskPersistStore(store); answer(ask.askId);
  expect(store.list()[0].answeredResult?.kind).toBe('answered');
});

it('projects a durable delivery failure and never resubmits a previously registered missing input', async () => {
  const states: string[] = [];
  setCardDispatcher({ async send() { return { messageId: 'card' }; }, onSettle(ask) { states.push(ask.continuation!.state); } });
  const id = registerContinuationAsk(input).askId; await Promise.resolve(); answer(id);
  await reconcileAskContinuations('app', async () => { throw new Error('readback offline'); });
  expect(states).toContain('blocked');
  await reconcileAskContinuations('app', async () => ({ state: 'accepted', triggerId: 'original' }));
  const dispatch = createAskContinuationDispatcher({ observe: () => ({ status: 200, body: { ok: true, state: 'unknown', sessionId: 'session', larkAppId: 'app' } }),
    submit: async () => { throw new Error('must not submit again'); } });
  await reconcileAskContinuations('app', dispatch);
  expect(listAskContinuations()[0].continuation).toMatchObject({ state: 'blocked', triggerId: 'original', reason: 'original_answer_input_unproven' });
});

it.each(['group', 'p2p'] as const)('preserves the source chat permission for %s continuations', async chatType => {
  answer(registerContinuationAsk({ ...input, chatType }).askId);
  await reconcileAskContinuations('app', async data => {
    expect(continuationRequest(data).options?.allowChatMessages).toBe(chatType === 'group');
    return { state: 'committed' };
  });
});

it('reads only the exact original durable Ask and retains its answer across read and restore', async () => {
  const registration=registerContinuationAsk(input); await Promise.resolve(); answer(registration.askId);
  const identity={larkAppId:input.larkAppId,sessionId:input.sessionId,requestId:input.requestId!,askId:registration.askId};
  const first=readContinuationAskFact(identity)!;
  expect(first.result).toMatchObject({kind:'answered',answers:[['yes']],by:'owner'});
  expect(first.questions).toEqual(input.questions); expect(first).not.toHaveProperty('nonce');
  for(const field of ['larkAppId','sessionId','requestId','askId']) expect(readContinuationAskFact({...identity,[field]:'other'})).toBeNull();
  first.questions[0].prompt='caller mutated its copy';
  _resetForTest();boot();restorePersistedAsks(Date.now(),'app');
  expect(readContinuationAskFact(identity)?.questions).toEqual(input.questions);
  expect(readContinuationAskFact(identity)?.result).toEqual(first.result);
  expect(store.list()).toHaveLength(1); expect(cards).toBe(1);
});
