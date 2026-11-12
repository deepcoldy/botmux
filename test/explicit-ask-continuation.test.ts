import { validateTriggerRequest } from '../src/services/trigger-types.js';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createExplicitAskContinuation, explicitAskRecoveryRequest, explicitAskOriginIsLive, waitForExplicitAskResult } from '../src/core/explicit-ask-continuation.js';
import { registerHostAsk, setCardDispatcher, setAskPersistStore, setCanTalkChecker,
  restorePersistedAsks, tryResolveAsk, getAskSnapshot, releaseExplicitAskHandoff, invalidateExplicitAsk,
  setExplicitAskSessionChecker, submitAskFromDesktop, _resetForTest } from '../src/core/ask-broker.js';
import { createAskPersistStore } from '../src/core/ask-persist-store.js';
import type { AskResult, CreateAskInput, PendingAsk } from '../src/core/ask-types.js';
import { replyCardAskTarget } from '../src/core/turn-reply-ask.js';
import { TurnReplyCardStore } from '../src/services/turn-reply-card.js';
import { config } from '../src/config.js';
import * as botRegistry from '../src/bot-registry.js';
import type { DaemonSession } from '../src/core/types.js';
const dirs: string[] = [];
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); _resetForTest(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const input = { larkAppId: 'app', chatId: 'chat', rootMessageId: null, sessionId: 'session',
  requestId: 'request', originKind: 'host_explicit', timeoutMs: 3600000,
  questions: [{ prompt: '确认方案 revision 4？', options: [{ key: 'yes', label: '确认' }, { key: 'no', label: '拒绝' }], multiSelect: false }] } satisfies CreateAskInput & { requestId: string };
const answer: AskResult = { kind: 'answered', answers: [['yes']], by: 'human', comment: null, timedOut: false };
function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'explicit-ask-')); dirs.push(dir);
  let clock = 10000;
  let resumable = true;
  const register = vi.fn(async () => answer);
  const dispatch = vi.fn(async () => true);
  const onError = vi.fn();
  const deps = { dir, appId: 'app', register, dispatch, onError, now: () => clock, canResume: () => resumable };
  return { deps, manager: createExplicitAskContinuation(deps), register, dispatch, onError,
    tick: () => { clock += 6000; }, advance: (ms: number) => { clock += ms; },
    setResumable: (value: boolean) => { resumable = value; } };
}
describe('explicit Ask durable continuation', () => {
  it.each([false, true])('trusted desktop obeys zero-only close cancellation without the talk gate (restored: %s)', async restored => {
    vi.useFakeTimers();
    const fixture = setup();
    const store = createAskPersistStore(join(fixture.deps.dir, 'broker'));
    const cards: PendingAsk[] = [];
    let live = true;
    const wire = () => {
      setAskPersistStore(store);
      setCanTalkChecker(() => false);
      setExplicitAskSessionChecker(() => live);
      setCardDispatcher({ send: async ask => { cards.push(ask); return { messageId: ask.askId }; } });
    };
    wire();
    const deps = { ...fixture.deps, register: registerHostAsk, releaseHandoff: releaseExplicitAskHandoff };
    let manager = createExplicitAskContinuation(deps);
    const closedInput = { ...input, timeoutMs: 0 };
    const liveInput = { ...closedInput, requestId: 'live' };
    const finiteInput = { ...input, requestId: 'finite', timeoutMs: 10_000 };
    void manager.wait(closedInput); void manager.wait(liveInput); void manager.wait(finiteInput);
    await vi.advanceTimersByTimeAsync(0);
    if (restored) {
      _resetForTest(); wire();
      expect(restorePersistedAsks(Date.now(), 'app')).toBe(3);
      manager = createExplicitAskContinuation(deps);
    }
    expect(submitAskFromDesktop({ askId: cards[1]!.askId, selections: [['yes']] })).toBe('accepted');
    live = false;
    expect(submitAskFromDesktop({ askId: cards[0]!.askId, selections: [['yes']] })).toBe('already_settled');
    expect(submitAskFromDesktop({ askId: cards[2]!.askId, selections: [['yes']] })).toBe('accepted');
    await expect(manager.wait(closedInput)).resolves.toMatchObject({ kind: 'invalidated', timedOut: false });
    await expect(manager.wait(liveInput)).resolves.toMatchObject({ kind: 'answered', by: 'desktop' });
    await expect(manager.wait(finiteInput)).resolves.toMatchObject({ kind: 'answered', by: 'desktop' });
  });

  it('reconnect and acknowledgement preserve the original production-derived inline target and backend facts', async () => {
    vi.useFakeTimers();
    const fixture = setup();
    const previousDir = config.session.dataDir;
    config.session.dataDir = fixture.deps.dir;
    vi.spyOn(botRegistry, 'getBot').mockReturnValue({ config: {
      larkAppId: 'app', cliId: 'claude-code', sandbox: false,
    } } as ReturnType<typeof botRegistry.getBot>);
    try {
      const key = { larkAppId: 'app', sessionId: 'session', turnId: 'om_original' };
      new TurnReplyCardStore(fixture.deps.dir).prepareSync(key, { mode: 'unified', chatId: 'chat', rootId: 'om_root' });
      const session = { larkAppId: 'app', chatId: 'chat', replyCardRunningTurnId: key.turnId,
        session: { sessionId: 'session', rootMessageId: 'om_root', scope: 'thread',
          cliId: 'claude-code', sandbox: false, workerGeneration: 1 } } as DaemonSession;
      const semanticInput = { ...input, rootMessageId: 'om_root', timeoutMs: 0 };
      const originalTarget = replyCardAskTarget(session, semanticInput, { originTurnId: key.turnId });
      expect(originalTarget).toMatchObject({ turnId: key.turnId });
      const persistedTarget = JSON.parse(JSON.stringify(originalTarget));
      const originalInput = { ...semanticInput, replyCardTarget: originalTarget, backendSurvivesRestart: false };
      const store = createAskPersistStore(join(fixture.deps.dir, 'broker'));
      const cards: PendingAsk[] = [];
      const wire = () => {
        setAskPersistStore(store); setCanTalkChecker(() => true);
        setCardDispatcher({ send: async ask => { cards.push(ask); return { messageId: 'card' }; } });
      };
      wire();
      void createExplicitAskContinuation({ ...fixture.deps, register: registerHostAsk }).wait(originalInput);
      await vi.advanceTimersByTimeAsync(0);
      _resetForTest(); wire();
      expect(restorePersistedAsks(Date.now(), 'app')).toBe(1);
      session.replyCardRunningTurnId = undefined;
      const reconnectTarget = replyCardAskTarget(session, semanticInput, { originTurnId: key.turnId });
      expect(reconnectTarget).toBeUndefined();
      const reconnectInput = { ...semanticInput, replyCardTarget: reconnectTarget, backendSurvivesRestart: true };
      const registrations: CreateAskInput[] = [];
      const recovered = createExplicitAskContinuation({ ...fixture.deps, register: ask => {
        registrations.push(ask); return registerHostAsk(ask);
      }, releaseHandoff: releaseExplicitAskHandoff });
      const waiting = recovered.wait(reconnectInput);
      void waiting.catch(() => {});
      expect(registrations[0]).toMatchObject({ replyCardTarget: persistedTarget, backendSurvivesRestart: false });
      expect(tryResolveAsk({ askId: cards[0]!.askId, nonce: cards[0]!.nonce, selected: 'yes', by: 'human' })).toBe('accepted');
      await expect(waiting).resolves.toEqual(answer);
      expect(recovered.acknowledge(reconnectInput)).toEqual(answer);
      const receipt = readdirSync(fixture.deps.dir).filter(name => name.endsWith('.json'))
        .map(name => JSON.parse(readFileSync(join(fixture.deps.dir, name), 'utf8')))[0];
      expect(receipt).toMatchObject({ acknowledged: true,
        input: { replyCardTarget: persistedTarget, backendSurvivesRestart: false } });
      expect(cards).toHaveLength(1);
    } finally { config.session.dataDir = previousDir; }
  });

  it('semantic receipt identity ignores object key order but retains question, responder, scope and waiting policy', async () => {
    const fixture = setup();
    const original = { ...input, answererOpenId: 'ou_author', questions: [{ ...input.questions[0],
      defaultSelectedKeys: ['yes'], allowCustom: false }] };
    await fixture.manager.wait(original);
    const reordered = { ...original, questions: [{ allowCustom: false, defaultSelectedKeys: ['yes'],
      multiSelect: false, options: [{ label: '确认', key: 'yes' }, { label: '拒绝', key: 'no' }],
      prompt: original.questions[0]!.prompt, input: undefined }] };
    await expect(fixture.manager.wait(reordered)).resolves.toEqual(answer);
    expect(fixture.manager.acknowledge(reordered)).toEqual(answer);
    for (const changed of [
      { timeoutMs: 0 }, { answererOpenId: 'ou_other' }, { chatId: 'other' }, { rootMessageId: 'om_other' },
      { originKind: 'hook' }, { questions: [{ ...original.questions[0], prompt: 'revision 5' }] },
      { questions: [{ ...original.questions[0], defaultSelectedKeys: ['no'] }] },
      { questions: [{ ...original.questions[0], allowCustom: true }] },
      { questions: [{ ...original.questions[0], options: [...original.questions[0]!.options].reverse() }] },
      { deliveryTarget: { kind: 'document-author' as const, openId: 'ou_author',
        turnId: 'comment-turn', fileToken: 'doc', commentId: 'comment' } },
    ]) {
      await expect(fixture.manager.wait({ ...original, ...changed })).rejects.toThrow('identity conflict');
      expect(fixture.manager.acknowledge({ ...original, ...changed })).toBeUndefined();
    }
  });

  it('no-deadline restore before delivery re-sends the same card and never starts a timeout', async () => {
    vi.useFakeTimers();
    const fixture = setup();
    const store = createAskPersistStore(join(fixture.deps.dir, 'broker'));
    const cards: PendingAsk[] = [];
    setAskPersistStore(store);
    setCanTalkChecker(() => true);
    setCardDispatcher({ send: async ask => { cards.push(ask); return new Promise(() => {}); } });
    const noDeadline = { ...input, timeoutMs: 0 };
    void createExplicitAskContinuation({ ...fixture.deps, register: registerHostAsk }).wait(noDeadline);
    await vi.advanceTimersByTimeAsync(30 * 24 * 3600_000);
    expect(store.list()[0]).toMatchObject({ deadlineAt: 0, timeoutMs: 0 });
    expect(store.list()[0]?.cardMessageId).toBeUndefined();
    _resetForTest();
    setAskPersistStore(store);
    setCanTalkChecker(() => true);
    setCardDispatcher({ send: async ask => { cards.push(ask); return { messageId: 'card' }; } });
    expect(restorePersistedAsks(Date.now(), 'app')).toBe(1);
    const recovered = createExplicitAskContinuation({ ...fixture.deps, register: registerHostAsk,
      releaseHandoff: releaseExplicitAskHandoff });
    const waiting = recovered.wait(noDeadline);
    await vi.advanceTimersByTimeAsync(30 * 24 * 3600_000);
    expect(cards).toHaveLength(2);
    expect(cards[1]).toMatchObject({ askId: cards[0]!.askId, nonce: cards[0]!.nonce,
      dispatchUuid: cards[0]!.dispatchUuid, deadlineAt: 0 });
    expect(vi.getTimerCount()).toBe(0);
    expect(tryResolveAsk({ askId: cards[0]!.askId, nonce: cards[0]!.nonce, selected: 'yes', by: 'human' })).toBe('accepted');
    await expect(waiting).resolves.toEqual(answer);
  });

  it('a closed or rebound no-deadline session invalidates its own restored card and retains a non-approval receipt', async () => {
    vi.useFakeTimers();
    const fixture = setup();
    const store = createAskPersistStore(join(fixture.deps.dir, 'broker'));
    const cards: PendingAsk[] = [];
    const wire = () => {
      setAskPersistStore(store);
      setCanTalkChecker(() => true);
      setCardDispatcher({ send: async ask => { cards.push(ask); return { messageId: ask.askId }; } });
    };
    wire();
    const noDeadline = { ...input, timeoutMs: 0 };
    void createExplicitAskContinuation({ ...fixture.deps, register: registerHostAsk }).wait(noDeadline);
    const otherSession = { ...noDeadline, sessionId: 'other-session' };
    const unrelated = registerHostAsk(otherSession);
    await Promise.resolve();
    const original = cards[0]!;
    _resetForTest(); wire();
    expect(restorePersistedAsks(Date.now(), 'app')).toBe(2);
    const recovered = createExplicitAskContinuation({ ...fixture.deps, register: registerHostAsk,
      shouldInvalidate: () => true, invalidate: invalidateExplicitAsk, releaseHandoff: releaseExplicitAskHandoff });
    await recovered.sweep();
    expect(getAskSnapshot(original.askId)?.result).toMatchObject({ kind: 'invalidated' });
    // The closed session never reconnects: the sweep itself must commit the
    // non-approval receipt and release the broker handoff.
    await vi.advanceTimersByTimeAsync(0);
    const receipts = readdirSync(fixture.deps.dir).filter(file => /^[a-f0-9]{64}\.json$/.test(file))
      .map(file => JSON.parse(readFileSync(join(fixture.deps.dir, file), 'utf8')));
    expect(receipts).toEqual([expect.objectContaining({ result: expect.objectContaining({ kind: 'invalidated', timedOut: false }) })]);
    expect(store.list()).toHaveLength(1);
    await expect(recovered.wait(noDeadline)).resolves.toMatchObject({ kind: 'invalidated', timedOut: false });
    expect(tryResolveAsk({ askId: original.askId, nonce: original.nonce, selected: 'yes', by: 'human' })).toBe('already_settled');
    expect(store.list()).toHaveLength(1);
    const otherCard = cards[1]!;
    expect(tryResolveAsk({ askId: otherCard.askId, nonce: otherCard.nonce, selected: 'yes', by: 'human' })).toBe('accepted');
    expect(fixture.dispatch).not.toHaveBeenCalled();
    void unrelated;
  });

  it.each([0, 10_000])('explicit reconnect honors no deadline or the original finite budget (%s)', async timeoutMs => {
    let clock = 0;
    const requests: Record<string, unknown>[] = [];
    const body = { timeoutMs, originKind: 'explicit', requestId: 'stable' };
    const retryable = Object.assign(new Error('daemon restarting'), { retryable: true });
    const post = async (request: Record<string, unknown>) => {
      requests.push(request);
      if (requests.length <= 2) throw retryable;
      return answer;
    };
    const waiting = waitForExplicitAskResult(body, post, {
      now: () => clock, sleep: async () => { clock += 90_000; },
    });
    if (timeoutMs === 0) {
      await expect(waiting).resolves.toEqual(answer);
      expect(requests).toEqual([body, body, body]);
    } else {
      await expect(waiting).rejects.toThrow('daemon restarting');
      expect(requests).toEqual([body, body]);
    }
  });

  it('no-deadline persistence rejects zero markers on hooks and inconsistent explicit records', () => {
    const fixture = setup();
    const store = createAskPersistStore(join(fixture.deps.dir, 'broker'));
    const record = {
      v: 2 as const, askKey: 'no-deadline', requestId: 'stable', askId: 'ask', nonce: 'nonce',
      larkAppId: 'app', sessionId: 'session', chatId: 'chat', rootMessageId: null,
      questions: input.questions, selections: [[]], createdAt: 1000,
      originKind: 'host_explicit', timeoutMs: 0, deadlineAt: 0,
    };
    store.put(record);
    expect(store.list(30 * 24 * 3600_000)).toHaveLength(1);
    for (const changed of [{ originKind: 'hook' }, { deadlineAt: 1000 }, { timeoutMs: undefined }]) {
      store.put({ ...record, ...changed });
      expect(store.list()).toHaveLength(0);
    }
  });

  it.each([false, true])('no-deadline Ask restores and reconnects to one card, with a late single-consumption answer (answer before reconnect: %s)', async answerBeforeReconnect => {
    vi.useFakeTimers();
    const fixture = setup();
    const noDeadline = { ...input, timeoutMs: 0 };
    const store = createAskPersistStore(join(fixture.deps.dir, 'broker'));
    const cards: PendingAsk[] = [];
    const wire = () => {
      setAskPersistStore(store);
      setCanTalkChecker(() => true);
      setCardDispatcher({ send: async ask => { cards.push(ask); return { messageId: 'card' }; } });
    };
    wire();
    const first = createExplicitAskContinuation({ ...fixture.deps, register: registerHostAsk });
    void first.wait(noDeadline);
    await Promise.resolve();
    const original = cards[0]!;
    await vi.advanceTimersByTimeAsync(30 * 24 * 3600_000);
    expect(store.list()[0]).toMatchObject({ timeoutMs: 0, deadlineAt: 0 });
    expect(store.list()[0]?.answeredResult).toBeUndefined();
    _resetForTest(); wire();
    expect(restorePersistedAsks(Date.now(), 'app')).toBe(1);
    await vi.advanceTimersByTimeAsync(30 * 24 * 3600_000);
    if (answerBeforeReconnect) {
      expect(tryResolveAsk({ askId: original.askId, nonce: original.nonce, selected: 'yes', by: 'human' })).toBe('accepted');
      await vi.advanceTimersByTimeAsync(30 * 24 * 3600_000);
      _resetForTest(); wire();
      expect(restorePersistedAsks(Date.now(), 'app')).toBe(1);
    }
    const restored = createExplicitAskContinuation({ ...fixture.deps, register: registerHostAsk,
      releaseHandoff: releaseExplicitAskHandoff });
    const waiting = restored.wait(noDeadline);
    if (!answerBeforeReconnect) {
      await vi.advanceTimersByTimeAsync(30 * 24 * 3600_000);
      expect(tryResolveAsk({ askId: original.askId, nonce: original.nonce, selected: 'yes', by: 'human' })).toBe('accepted');
    }
    await expect(waiting).resolves.toEqual(answer);
    expect(await restored.wait(noDeadline)).toEqual(answer);
    expect(cards).toHaveLength(1);
    expect(store.list()).toHaveLength(0);
    fixture.tick();
    await restored.sweep(); await restored.sweep();
    expect(fixture.dispatch).toHaveBeenCalledTimes(1);
  });

  it.each(['group', 'p2p'] as const)('production recovery builder respects %s transport permission', chatType => {
    const request = explicitAskRecoveryRequest({ version: 1, input, result: answer }, 'ask-stable-key', chatType);
    expect(validateTriggerRequest(request).ok).toBe(true);
    expect(request.target).toEqual({ kind: 'turn', sessionId: 'session' });
    expect(request.options!.allowChatMessages).toBe(chatType === 'group');
    expect(request.options!.steer).toBeUndefined();
    expect(request.instruction).toContain('solution revision');
    expect(request.instruction).toContain('timeout or invalidation is not approval');
  });

  it('normal acknowledged result never dispatches; duplicate request returns same result', async () => {
    const t = setup();
    expect(await t.manager.wait(input)).toEqual(answer);
    expect(t.manager.acknowledge(input)).toEqual(answer);
    t.tick(); await t.manager.sweep();
    const rebooted = createExplicitAskContinuation(t.deps);
    expect(await rebooted.wait(input)).toEqual(answer);
    await rebooted.sweep();
    expect(t.register).toHaveBeenCalledTimes(1); expect(t.dispatch).not.toHaveBeenCalled();
  });
  it.each(['acknowledged', 'delivered'] as const)('keeps a %s receipt for late reconnects, then deletes it', async state => {
    const t = setup(); const day = 24 * 3600000;
    await t.manager.wait(input);
    if (state === 'acknowledged') t.manager.acknowledge(input);
    else { t.tick(); await t.manager.sweep(); expect(t.dispatch).toHaveBeenCalledTimes(1); }
    t.advance(day); await t.manager.sweep();
    expect(readdirSync(t.deps.dir)).toHaveLength(1);
    expect(await createExplicitAskContinuation(t.deps).wait(input)).toEqual(answer);
    t.advance(30 * day); await t.manager.sweep();
    expect(readdirSync(t.deps.dir)).toEqual([]);
    expect(t.register).toHaveBeenCalledTimes(1); expect(t.dispatch).toHaveBeenCalledTimes(state === 'delivered' ? 1 : 0);
  });
  it('never deletes an answer that was neither acknowledged nor delivered', async () => {
    const t = setup(); await t.manager.wait(input); t.setResumable(false);
    t.advance(30 * 24 * 3600000); await t.manager.sweep();
    expect(readdirSync(t.deps.dir)).toHaveLength(1);
    t.setResumable(true); await t.manager.sweep();
    expect(t.dispatch).toHaveBeenCalledTimes(1);
  });
  it('matches origin, attempt and worker generation against live daemon authority', () => {
    const receipt = { version: 1 as const, input, result: answer,
      origin: { turnId: 'turn-1', dispatchAttempt: 2, workerGeneration: 3 } };
    const live = { workerAlive: true, turnId: 'turn-1', dispatchAttempt: 2, workerGeneration: 3 };
    expect(explicitAskOriginIsLive(receipt, live)).toBe(true);
    expect(explicitAskOriginIsLive(receipt, { ...live, terminal: true })).toBe(false);
    expect(explicitAskOriginIsLive(receipt, { ...live, turnId: 'turn-2' })).toBe(false);
    expect(explicitAskOriginIsLive(receipt, { ...live, dispatchAttempt: 3 })).toBe(false);
    expect(explicitAskOriginIsLive(receipt, { ...live, workerGeneration: 4 })).toBe(false);
    expect(explicitAskOriginIsLive(receipt, { ...live, workerAlive: false })).toBe(false);
    expect(explicitAskOriginIsLive(receipt, undefined)).toBe(false);
    expect(explicitAskOriginIsLive({ version: 1, input, result: answer }, undefined)).toBe(true);
  });
  it('does not accept stdout acknowledgement after the originating turn ended', async () => {
    const t = setup();
    const origin = { turnId: 'turn-1', workerGeneration: 3 };
    await t.manager.wait(input, origin);
    expect(t.manager.acknowledge(input, receipt => {
      expect(receipt.origin).toEqual(origin);
      return false;
    })).toEqual(answer);
    t.tick();
    const rebooted = createExplicitAskContinuation(t.deps);
    await rebooted.sweep(); await rebooted.sweep();
    expect(t.dispatch).toHaveBeenCalledTimes(1);
    expect(t.dispatch.mock.calls[0]![0].origin).toEqual(origin);
  });
  it('accepts acknowledgement while the originating turn is live', async () => {
    const t = setup();
    await t.manager.wait(input, { turnId: 'turn-1', workerGeneration: 3 });
    expect(t.manager.acknowledge(input, () => true)).toEqual(answer);
    t.tick(); await t.manager.sweep();
    expect(t.dispatch).not.toHaveBeenCalled();
  });
  it('lost result/CLI death resumes the original session once across restart', async () => {
    const t = setup(); await t.manager.wait(input); t.tick();
    const rebooted = createExplicitAskContinuation(t.deps);
    await rebooted.sweep(); await rebooted.sweep();
    expect(t.dispatch).toHaveBeenCalledTimes(1);
    expect(t.dispatch.mock.calls[0]![0].input.sessionId).toBe('session');
  });
  it('retains a document answer for reconnect without dispatching an unbound recovery turn', async () => {
    const t = setup();
    const documentInput = { ...input, chatId: 'doc:fixture:comment', answererOpenId: 'ou_author',
      deliveryTarget: { kind: 'document-author' as const, openId: 'ou_author',
        turnId: 'comment-turn', fileToken: 'fixture', commentId: 'comment' } };
    await t.manager.wait(documentInput);
    t.tick();
    const rebooted = createExplicitAskContinuation(t.deps);
    await rebooted.sweep();
    expect(t.dispatch).not.toHaveBeenCalled();
    expect(await rebooted.wait(documentInput)).toEqual(answer);
    expect(rebooted.acknowledge(documentInput)).toEqual(answer);
    expect(t.register).toHaveBeenCalledTimes(1);
    expect(() => explicitAskRecoveryRequest({ version: 1, input: documentInput, result: answer }, 'key', 'group'))
      .toThrow(/document.*recovery/i);
  });
  it('failed/ambiguous dispatch retries with identical key; concurrent sweeps serialize', async () => {
    const t = setup(); t.dispatch.mockResolvedValueOnce(false);
    await t.manager.wait(input); t.tick();
    await Promise.all([t.manager.sweep(), t.manager.sweep()]);
    await t.manager.sweep();
    expect(t.dispatch).toHaveBeenCalledTimes(2);
    expect(t.dispatch.mock.calls[0]![1]).toBe(t.dispatch.mock.calls[1]![1]);
  });
  it('busy, closed or rebound session retains evidence without dispatch', async () => {
    const t = setup(); await t.manager.wait(input); t.tick(); t.setResumable(false);
    await t.manager.sweep(); expect(t.dispatch).not.toHaveBeenCalled();
    t.setResumable(true); await t.manager.sweep(); expect(t.dispatch).toHaveBeenCalledTimes(1);
  });
  it('a mention is presentation: it reaches the card but not the receipt, so a reconnect whose lookup flipped still joins', async () => {
    const t = setup();
    t.register.mockImplementationOnce(() => new Promise<AskResult>(() => {}));
    void t.manager.wait(input, undefined, { mentionedOpenId: 'ou_human' });
    expect(t.register).toHaveBeenCalledWith(expect.objectContaining({ mentionedOpenId: 'ou_human' }));
    const rebooted = createExplicitAskContinuation(t.deps);
    expect(await rebooted.wait(input)).toEqual(answer);
    expect(JSON.stringify(readdirSync(t.deps.dir).map(f => readFileSync(join(t.deps.dir, f), 'utf8')))).not.toContain('ou_human');
  });
  it('old revision/scope cannot reuse or acknowledge an existing invocation', async () => {
    const t = setup(); await t.manager.wait(input);
    const changed = { ...input, questions: [{ ...input.questions[0], prompt: 'revision 5' }] };
    await expect(t.manager.wait(changed)).rejects.toThrow('identity conflict');
    expect(t.manager.acknowledge(changed)).toBeUndefined();
  });
  it('timeout stays a timeout in the recovered receipt; no synthesized approval', async () => {
    const t = setup(); const timeout: AskResult = { kind: 'timedOut', selected: null, by: null, comment: null, timedOut: true };
    t.register.mockResolvedValue(timeout as typeof answer);
    expect(await t.manager.wait(input)).toEqual(timeout); t.tick(); await t.manager.sweep();
    expect(t.dispatch.mock.calls[0]![0].result).toEqual(timeout);
  });
  it('a restart past the original deadline times out without re-sending or resetting the card', async () => {
    const t = setup(); let card: PendingAsk | undefined; let sends = 0;
    const store = createAskPersistStore(join(t.deps.dir, 'broker'));
    const wire = () => {
      setCanTalkChecker(() => true);
      setCardDispatcher({ send: async ask => { sends++; card = ask; return { messageId: 'card' }; } });
      setAskPersistStore(store);
    };
    wire(); const manager = createExplicitAskContinuation({ ...t.deps, register: registerHostAsk });
    void manager.wait({ ...input, timeoutMs: 1000 });
    await vi.waitFor(() => expect(card).toBeDefined());
    const deadline = store.list()[0]!.deadlineAt;
    _resetForTest(); wire();
    vi.spyOn(Date, 'now').mockReturnValue(deadline + 1000);
    expect(store.list()).toHaveLength(1);
    restorePersistedAsks(Date.now(), 'app');
    const restored = createExplicitAskContinuation({ ...t.deps, register: registerHostAsk });
    expect(await restored.wait({ ...input, timeoutMs: 1000 })).toMatchObject({ kind: 'timedOut', timedOut: true });
    expect(sends).toBe(1);
  });

  it('missing durable handoff fails closed instead of issuing another confirmation', async () => {
    const t = setup();
    const pending = new Promise<AskResult>(() => {});
    const first = createExplicitAskContinuation({ ...t.deps, register: () => pending });
    void first.wait(input);
    const restored = createExplicitAskContinuation({ ...t.deps, hasHandoff: () => false });
    expect(await restored.wait(input)).toMatchObject({ kind: 'invalidated' });
    expect(t.register).not.toHaveBeenCalled();
  });

  it.each([1, 2])('retains the answer across %s crashes between broker settlement and receipt fsync', async crashes => {
    const t = setup(); let card: PendingAsk | undefined;
    const store = createAskPersistStore(join(t.deps.dir, 'broker'));
    const wire = () => {
      setCanTalkChecker(() => true);
      setCardDispatcher({ send: async ask => { card = ask; return { messageId: 'card' }; } });
      setAskPersistStore(store);
    };
    wire();
    const crash = async (ask: CreateAskInput) => { await registerHostAsk(ask); throw new Error('crash before receipt commit'); };
    const first = createExplicitAskContinuation({ ...t.deps, register: crash });
    const waiting = first.wait(input);
    await vi.waitFor(() => expect(card).toBeDefined());
    expect(tryResolveAsk({ askId: card!.askId, nonce: card!.nonce, selected: 'yes', by: 'human' })).toBe('accepted');
    await expect(waiting).rejects.toThrow('crash');
    expect(store.list(Date.now() + 25 * 3600000)[0]!.answeredResult).toEqual(answer);
    if (crashes === 2) {
      _resetForTest(); wire(); restorePersistedAsks(Date.now(), 'app');
      const second = createExplicitAskContinuation({ ...t.deps, register: crash });
      await expect(second.wait(input)).rejects.toThrow('crash');
      expect(store.list()[0]!.answeredResult).toEqual(answer);
    }
    _resetForTest(); wire(); restorePersistedAsks(Date.now(), 'app');
    const recovered = createExplicitAskContinuation({ ...t.deps, register: registerHostAsk, releaseHandoff: releaseExplicitAskHandoff });
    expect(await recovered.wait(input)).toEqual(answer);
    expect(store.list()).toHaveLength(0);
    t.tick(); await recovered.sweep(); expect(t.dispatch).toHaveBeenCalledTimes(1);
  });
  it('real broker restores the same card identity and receives the click after daemon restart', async () => {
    const t = setup(); let card: PendingAsk | undefined;
    setCanTalkChecker(() => true);
    setCardDispatcher({ send: async ask => { card = ask; return { messageId: 'card' }; }, onSettle: async () => {} });
    setAskPersistStore(createAskPersistStore(join(t.deps.dir, 'broker')));
    const manager = createExplicitAskContinuation({ ...t.deps, register: registerHostAsk });
    void manager.wait(input);
    await vi.waitFor(() => expect(card).toBeDefined());
    const original = card!;
    _resetForTest();
    setCanTalkChecker(() => true);
    setCardDispatcher({ send: async ask => { card = ask; return { messageId: 'card' }; }, onSettle: async () => {} });
    setAskPersistStore(createAskPersistStore(join(t.deps.dir, 'broker')));
    restorePersistedAsks(Date.now(), 'app');
    const restored = createExplicitAskContinuation({ ...t.deps, register: registerHostAsk });
    await restored.sweep();
    expect(tryResolveAsk({ askId: original.askId, nonce: original.nonce, selected: 'yes', by: 'human' })).toBe('accepted');
    expect(await restored.wait(input)).toEqual(answer);
    t.tick(); await restored.sweep(); expect(t.dispatch).toHaveBeenCalledTimes(1);
  });
});
