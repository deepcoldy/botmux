import { validateTriggerRequest } from '../src/services/trigger-types.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createExplicitAskContinuation, explicitAskRecoveryRequest } from '../src/core/explicit-ask-continuation.js';
import { registerHostAsk, setCardDispatcher, setAskPersistStore, setCanTalkChecker,
  restorePersistedAsks, tryResolveAsk, releaseExplicitAskHandoff, _resetForTest } from '../src/core/ask-broker.js';
import { createAskPersistStore } from '../src/core/ask-persist-store.js';
import type { AskResult, CreateAskInput, PendingAsk } from '../src/core/ask-types.js';
const dirs: string[] = [];
afterEach(() => { vi.restoreAllMocks(); _resetForTest(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
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
    tick: () => { clock += 6000; }, setResumable: (value: boolean) => { resumable = value; } };
}
describe('explicit Ask durable continuation', () => {
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
  it('lost result/CLI death resumes the original session once across restart', async () => {
    const t = setup(); await t.manager.wait(input); t.tick();
    const rebooted = createExplicitAskContinuation(t.deps);
    await rebooted.sweep(); await rebooted.sweep();
    expect(t.dispatch).toHaveBeenCalledTimes(1);
    expect(t.dispatch.mock.calls[0]![0].input.sessionId).toBe('session');
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
