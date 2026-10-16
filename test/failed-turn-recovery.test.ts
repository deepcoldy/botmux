import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import * as pool from '../src/core/worker-pool.js';
import * as store from '../src/services/session-store.js';
import * as permissions from '../src/im/lark/event-dispatcher.js';
import * as manager from '../src/core/session-manager.js';
import { recoverFailedTurn, parseFailedTurnRecoveryRequest, noteFailedTurnRecoveryInput,
  failedTurnCaller, recordLimitedFailedTurn } from '../src/core/failed-turn-recovery.js';
import type { DaemonSession } from '../src/core/types.js';
import { isSilentScheduledTurn } from '../src/core/silent-schedule-turns.js';

const caller = { requestUserOpenId: 'ou_user_a', requestLarkAppId: 'cli_app', senderType: 'user' as const };
const request = { turnId: 'om_failed', failedAt: '2026-10-16T00:00:00.000Z', requestId: 'retry-1', mode: 'retry' as const };
let ds: any;
let registry: Map<string, DaemonSession>;
let rows: Map<string, any>;
let order: string[];

beforeEach(() => {
  order = [];
  ds = { session: { sessionId: 'old', status: 'active', cliId: 'codex', chatId: 'oc_chat',
    rootMessageId: 'om_root', scope: 'thread', title: 'task', ownerOpenId: 'ou_owner_b',
    replyTargets: { om_failed: { senderOpenId: 'ou_user_a', participants: [{ openId: 'ou_user_a', isBot: false }], updatedAt: request.failedAt } },
    lastFailedTurn: { turnId: request.turnId, failedAt: request.failedAt, status: 'failed',
      userPrompt: 'original task', cliInput: 'original wrapped input', retryCount: 0, trustedCaller: caller } },
    larkAppId: 'cli_app', chatId: 'oc_chat', chatType: 'group', scope: 'thread',
    workingDir: '/tmp/work', hasHistory: true, lastMessageAt: Date.parse(request.failedAt) - 1000,
    lastScreenStatus: 'idle', worker: { killed: false }, cliVersion: 'test',
    currentReplyTarget: { turnId: request.turnId } };
  registry = new Map([['om_root:cli_app', ds]]);
  rows = new Map([['old', ds.session]]);
  vi.spyOn(pool, 'findActiveBySessionId').mockImplementation(id => [...registry.values()].find(x => x.session.sessionId === id));
  vi.spyOn(pool, 'getActiveSessionsRegistry').mockReturnValue(registry);
  vi.spyOn(store, 'getOwnedSession').mockImplementation(id => rows.get(id));
  vi.spyOn(store, 'updateSession').mockImplementation(row => {
    order.push('persist');
    // Real SQLite persistence refreshes nested row objects after every write.
    Object.assign(row, structuredClone(row));
    rows.set(row.sessionId, row);
  });
  vi.spyOn(store, 'closeSession').mockImplementation(id => { rows.get(id).status = 'closed'; });
  vi.spyOn(pool, 'closeSessionForBackgroundCleanup').mockImplementation(async id => {
    order.push('close'); rows.get(id).status = 'closed'; registry.clear();
    return { ok: true, outcome: 'closed', alreadyClosed: false, known: true } as any;
  });
  vi.spyOn(store, 'createSession').mockImplementation((chat, root, title, chatType, scope) => {
    const row = { sessionId: 'new', status: 'active', chatId: chat, rootMessageId: root, title, chatType, scope, createdAt: request.failedAt } as any;
    rows.set('new', row); return row;
  });
  vi.spyOn(pool, 'setActiveSessionIfActive').mockImplementation((map, key, value) => { map.set(key, value); return true; });
  vi.spyOn(pool, 'sendWorkerInput').mockImplementation(() => { order.push('send'); return true; });
  vi.spyOn(pool, 'forkWorker').mockImplementation((_target, _input, _resume, options) => {
    order.push('fork'); options?.onAdmission?.('accepted'); return true;
  });
  vi.spyOn(permissions, 'canTalk').mockReturnValue(true);
  vi.spyOn(pool, 'prepareFailedTurnRecoveryIdentity').mockResolvedValue(undefined);
  vi.spyOn(manager, 'rememberLastCliInput').mockImplementation(() => undefined);
  vi.spyOn(manager, 'buildFollowUpCliInput').mockImplementation((prompt, id) => ({ content: `${id}:${prompt}` }));
});
afterEach(() => vi.restoreAllMocks());

describe('controlled failed-turn recovery', () => {
  it('replays exact input once with original user A, never the owner B', async () => {
    const first = await recoverFailedTurn('old', request);
    expect(first).toMatchObject({ ok: true, state: 'accepted', sessionId: 'old', originalTurnId: 'om_failed' });
    expect(pool.sendWorkerInput).toHaveBeenCalledWith(ds, { content: 'original wrapped input' }, expect.stringMatching(/^bmx-recovery-/),
      { trustedCaller: { ...caller, source: 'failed_turn_recovery' }, atMostOnce: true });
    expect(order.indexOf('persist')).toBeLessThan(order.indexOf('send'));
    expect(await recoverFailedTurn('old', request)).toEqual(first);
    expect(pool.sendWorkerInput).toHaveBeenCalledTimes(1);
    expect(ds.session.failedTurnRecovery.caller).toEqual(caller);
    expect(failedTurnCaller(ds, first.ok ? first.turnId : '')).toEqual(caller);
    expect(await recoverFailedTurn('old', { ...request, requestId: 'other' })).toEqual({ ok: false, error: 'failure_already_claimed' });
  });
  it('rebuilds a clean native conversation in the original topic with fresh prompt context', async () => {
    ds.session.cliSessionId = 'poisoned-native';
    const result = await recoverFailedTurn('old', { ...request, mode: 'fresh' });
    expect(result).toMatchObject({ ok: true, state: 'accepted', sessionId: 'new' });
    const target = [...registry.values()][0];
    expect(target.session.cliSessionId).toBeUndefined();
    expect(target.session.rootMessageId).toBe('om_root');
    expect(target.session.ownerOpenId).toBe('ou_owner_b');
    expect(target.session.failedTurnRecovery?.caller.requestUserOpenId).toBe('ou_user_a');
    expect(pool.forkWorker).toHaveBeenCalledWith(target, { content: 'new:original task' }, expect.objectContaining({ resume: false, atMostOnce: true }), expect.anything());
    expect(order.indexOf('persist')).toBeLessThan(order.indexOf('close'));
    expect(order.indexOf('close')).toBeLessThan(order.indexOf('fork'));
    expect(await recoverFailedTurn('old', { ...request, mode: 'fresh' })).toEqual(result);
    expect(pool.closeSessionForBackgroundCleanup).toHaveBeenCalledTimes(1);
  });
  it.each(['reply', 'clock', 'queue', 'active', 'working', 'native-recovery'])('rejects newer or owned input before any close (%s)', async kind => {
    if (kind === 'reply') ds.currentReplyTarget.turnId = 'om_new';
    if (kind === 'clock') ds.lastMessageAt = Date.parse(request.failedAt) + 1;
    if (kind === 'queue') ds.session.queuedActivationTail = [{}];
    if (kind === 'active') ds.activeInteractiveTurn = { turnId: 'om_new' };
    if (kind === 'working') ds.lastScreenStatus = 'working';
    if (kind === 'native-recovery') ds.session.ordinaryTurnRecovery = { status: 'backoff' };
    expect(await recoverFailedTurn('old', { ...request, mode: 'fresh' })).toEqual({ ok: false, error: 'newer_input' });
    expect(pool.closeSessionForBackgroundCleanup).not.toHaveBeenCalled(); expect(pool.forkWorker).not.toHaveBeenCalled();
  });
  it('cancels an obsolete replay when input arrives while teardown awaits', async () => {
    let release!: () => void;
    vi.mocked(pool.closeSessionForBackgroundCleanup).mockImplementation(async () => {
      await new Promise<void>(resolve => { release = resolve; });
      ds.session.status = 'closed'; registry.clear();
      return { ok: true, outcome: 'closed', alreadyClosed: false, known: true } as any;
    });
    const result = recoverFailedTurn('old', { ...request, mode: 'fresh' });
    await vi.waitFor(() => expect(pool.closeSessionForBackgroundCleanup).toHaveBeenCalled());
    noteFailedTurnRecoveryInput('cli_app', 'om_root', 'om_new'); release();
    expect(await result).toMatchObject({ ok: true, state: 'cancelled' });
    expect(store.createSession).not.toHaveBeenCalled(); expect(pool.forkWorker).not.toHaveBeenCalled();
  });
  it.each(['retry', 'fresh'] as const)('cancels input arriving during normal identity publication without a phantom active turn (%s)', async mode => {
    vi.mocked(pool.prepareFailedTurnRecoveryIdentity).mockImplementation(async () => {
      noteFailedTurnRecoveryInput('cli_app', 'om_root', 'om_new');
    });
    expect(await recoverFailedTurn('old', { ...request, mode })).toMatchObject({ ok: true, state: 'cancelled' });
    expect(pool.sendWorkerInput).not.toHaveBeenCalled(); expect(pool.forkWorker).not.toHaveBeenCalled();
    if (mode === 'retry') expect(ds.activeInteractiveTurn).toBeUndefined();
    else expect(registry.size).toBe(0);
  });
  it('retains scheduled creator provenance and prepares the normal scheduled authority', async () => {
    ds.session.lastFailedTurn.trustedCaller = { ...caller, source: 'schedule_creator', taskId: 'abcdef12' };
    ds.session.lastFailedTurn.silent = true;
    const result = await recoverFailedTurn('old', request);
    expect(result).toMatchObject({ ok: true, state: 'accepted', turnId: expect.stringMatching(/^schedule:abcdef12:/) });
    expect(pool.prepareFailedTurnRecoveryIdentity).toHaveBeenCalledWith(ds, expect.stringMatching(/^schedule:abcdef12:/));
    if (result.ok) expect(isSilentScheduledTurn(ds, result.turnId)).toBe(true);
    expect(pool.sendWorkerInput).toHaveBeenCalledWith(ds, expect.anything(), expect.anything(), expect.objectContaining({ trustedCaller: { ...caller, source: 'schedule_creator', taskId: 'abcdef12' } }));
  });
  it('preserves clean Codex App task text and local image references on fresh recovery', async () => {
    ds.session.lastFailedTurn.codexAppInput = { text: 'original image task', clientUserMessageId: 'old-client-id', localImages: [{ path: '/tmp/image.png' }] };
    await recoverFailedTurn('old', { ...request, mode: 'fresh' });
    expect(pool.forkWorker).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ codexAppInput: { text: 'original image task', localImages: [{ path: '/tmp/image.png' }] } }), expect.anything(), expect.anything());
  });
  it('coalesces simultaneous recovery and retains an unknown dispatch fence', async () => {
    vi.mocked(pool.sendWorkerInput).mockImplementation(() => { throw new Error('IPC unknown'); });
    const results = await Promise.all([recoverFailedTurn('old', request), recoverFailedTurn('old', request)]);
    expect(results[0]).toMatchObject({ ok: true, state: 'dispatch_unknown' });
    expect(results[1]).toMatchObject({ ok: false, error: 'recovery_in_progress' });
    expect(pool.sendWorkerInput).toHaveBeenCalledTimes(1);
    expect(await recoverFailedTurn('old', request)).toMatchObject({ ok: true, state: 'dispatch_unknown' });
    expect(pool.sendWorkerInput).toHaveBeenCalledTimes(1);
  });
  it('refuses recovery after original user access is revoked', async () => {
    vi.mocked(permissions.canTalk).mockReturnValue(false);
    expect(await recoverFailedTurn('old', request)).toEqual({ ok: false, error: 'original_actor_no_longer_allowed' });
    expect(pool.sendWorkerInput).not.toHaveBeenCalled();
  });
  it('never substitutes an owner for a failure without a principal snapshot', async () => {
    delete ds.session.lastFailedTurn.trustedCaller;
    expect(await recoverFailedTurn('old', request)).toEqual({ ok: false, error: 'original_actor_unavailable' });
    expect(pool.sendWorkerInput).not.toHaveBeenCalled();
  });
  it('fails closed before dispatch when the claim cannot be persisted', async () => {
    vi.mocked(store.updateSession).mockImplementation(() => { throw new Error('disk unavailable'); });
    await expect(recoverFailedTurn('old', { ...request, mode: 'fresh' })).rejects.toThrow('disk unavailable');
    expect(pool.closeSessionForBackgroundCleanup).not.toHaveBeenCalled(); expect(pool.forkWorker).not.toHaveBeenCalled();
  });
  it('does not start beside a residual process from a failed close', async () => {
    vi.mocked(pool.closeSessionForBackgroundCleanup).mockResolvedValue({ ok: true, outcome: 'closed_with_residual' } as any);
    expect(await recoverFailedTurn('old', { ...request, mode: 'fresh' })).toMatchObject({ ok: true, state: 'dispatch_unknown' });
    expect(pool.forkWorker).not.toHaveBeenCalled();
  });
  it('retains a write-ahead fence across daemon restart without redispatch', async () => {
    ds.session.lastFailedTurn.recovery = { requestId: request.requestId, mode: request.mode, turnId: 'bmx-recovery-prior', sessionId: 'old', state: 'attempting' };
    registry.clear();
    expect(await recoverFailedTurn('old', request)).toMatchObject({ ok: true, state: 'attempting' });
    expect(pool.sendWorkerInput).not.toHaveBeenCalled();
  });
  it('captures limited input once from the active user, not the session owner', () => {
    delete ds.session.lastFailedTurn;
    ds.activeInteractiveTurn = { turnId: request.turnId, caller };
    ds.lastUserPrompt = 'task'; ds.lastCliInput = 'wrapped';
    ds.usageLimit = { limited: true, kind: 'rate' };
    recordLimitedFailedTurn(ds, request.turnId);
    expect(ds.session.lastFailedTurn).toMatchObject({ trustedCaller: caller, errorCode: 'rate_limited', originalTurnId: request.turnId });
    const first = ds.session.lastFailedTurn;
    recordLimitedFailedTurn(ds, request.turnId);
    expect(ds.session.lastFailedTurn).toBe(first);
  });
  it('rejects bot/unknown attribution and does not infer a human from an owner', () => {
    ds.session.replyTargets = {}; delete ds.session.lastFailedTurn.trustedCaller;
    expect(failedTurnCaller(ds, request.turnId)).toBeUndefined();
    ds.activeInteractiveTurn = { turnId: request.turnId, caller: { ...caller, senderType: 'bot' } };
    expect(failedTurnCaller(ds, request.turnId)).toBeUndefined();
  });
  it('rejects caller, input and scope overrides from clients', () => {
    expect(parseFailedTurnRecoveryRequest(request)).toEqual(request);
    for (const extra of [{ caller }, { instruction: 'other task' }, { larkAppId: 'other' }, { trustedCaller: caller }]) {
      expect(parseFailedTurnRecoveryRequest({ ...request, ...extra })).toBeUndefined();
    }
  });
});
