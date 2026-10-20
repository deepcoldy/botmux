import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import * as pool from '../src/core/worker-pool.js';
import * as store from '../src/services/session-store.js';
import * as permissions from '../src/im/lark/event-dispatcher.js';
import * as manager from '../src/core/session-manager.js';
import { recoverFailedTurn, parseFailedTurnRecoveryRequest, noteFailedTurnRecoveryInput,
  failedTurnCaller, recordLimitedFailedTurn, clearLimitedFailedTurn, recordFailedTurnTerminal } from '../src/core/failed-turn-recovery.js';
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
  ds = { session: { sessionId: 'old', larkAppId: 'cli_app', status: 'active', cliId: 'codex', chatId: 'oc_chat',
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
    expect(target.session.larkAppId).toBe('cli_app');
    expect(target.session.ownerOpenId).toBe('ou_owner_b');
    expect(target.session.failedTurnRecovery?.caller.requestUserOpenId).toBe('ou_user_a');
    expect(pool.forkWorker).toHaveBeenCalledWith(target, { content: 'new:original task' }, expect.objectContaining({ resume: false, atMostOnce: true }), expect.anything());
    expect(order.indexOf('persist')).toBeLessThan(order.indexOf('close'));
    expect(order.indexOf('close')).toBeLessThan(order.indexOf('fork'));
    expect(await recoverFailedTurn('old', { ...request, mode: 'fresh' })).toEqual(result);
    expect(pool.closeSessionForBackgroundCleanup).toHaveBeenCalledTimes(1);
  });
  it('preserves the frozen CLI, sandbox and routing posture without sharing mutable configuration', async () => {
    const posture = {
      cliId: 'claude-code', cliConfigDir: '/tmp/claude-profile', agentFrozen: true,
      cliRuntime: { id: 'test', update: { mode: 'manual' } }, cliPathOverride: '/tmp/cli',
      wrapperCli: 'claude-code', cliLaunchMode: 'code', backendType: 'tmux',
      model: 'recorded-model', modelBackendVariant: 'max', reasoningEffort: 'medium',
      serviceTier: 'priority', sandbox: 'scratch', autoWorktreeFallbackDir: '/tmp/work',
      sandboxScratch: { storage: 'tmpfs', tmpfsSizeMb: 128, denyPaths: ['/private'], network: false },
      sandboxPaths: { readWrite: ['/tmp/work'], deny: ['/secret'] },
      sandboxHidePaths: ['/hidden'], sandboxReadonlyPaths: ['/readonly'], sandboxNetwork: false,
      sandboxNetworkPolicy: { version: 1, public: { mode: 'block' }, private: { mode: 'block' } },
    };
    Object.assign(ds.session, structuredClone(posture), {
      larkThreadId: 'omt_original', creatorOpenId: 'ou_creator', lastCallerOpenId: 'ou_last_caller',
    });
    await recoverFailedTurn('old', { ...request, mode: 'fresh' });
    const child = [...registry.values()][0].session;
    expect(child).toMatchObject(posture);
    expect(child).toMatchObject({ larkAppId: 'cli_app', larkThreadId: 'omt_original',
      creatorOpenId: 'ou_creator', lastCallerOpenId: 'ou_last_caller' });
    for (const field of ['cliRuntime', 'sandboxScratch', 'sandboxPaths', 'sandboxNetworkPolicy']) {
      expect(child[field]).not.toBe(ds.session[field]);
    }
    expect(child.cliSessionId).toBeUndefined();
  });
  it.each(['adopt', 'adopt-mode', 'remote', 'principal-lane', 'retired-workspace'])(
    'refuses unsupported lifecycle ownership before close or dispatch (%s)', async kind => {
      if (kind === 'adopt') ds.adoptedFrom = { tmuxTarget: 'other-pane' };
      if (kind === 'adopt-mode') ds.initConfig = { adoptMode: true };
      if (kind === 'remote') ds.session.backendType = 'mojo';
      if (kind === 'principal-lane') ds.session.principalLane = { principalKey: 'other' };
      if (kind === 'retired-workspace') ds.session.workspaceRetirement = { state: 'retiring' };
      expect(await recoverFailedTurn('old', { ...request, mode: 'fresh' }))
        .toEqual({ ok: false, error: 'recovery_unsupported' });
      expect(pool.closeSessionForBackgroundCleanup).not.toHaveBeenCalled();
      expect(pool.forkWorker).not.toHaveBeenCalled();
      expect(pool.sendWorkerInput).not.toHaveBeenCalled();
    });
  it('rejects a failure frozen under another app without closing or dispatching', async () => {
    ds.session.lastFailedTurn.trustedCaller = { ...caller, requestLarkAppId: 'cli_other' };
    expect(await recoverFailedTurn('old', { ...request, mode: 'fresh' }))
      .toEqual({ ok: false, error: 'original_actor_unavailable' });
    expect(pool.closeSessionForBackgroundCleanup).not.toHaveBeenCalled();
    expect(pool.forkWorker).not.toHaveBeenCalled();
  });
  it.each(['quota-cleared', 'not-limited', 'screen-recovered'])(
    'does not replay a temporary quota snapshot after native self-recovery (%s)', async kind => {
      ds.session.lastFailedTurn.limitedSnapshot = true;
      ds.usageLimit = { limited: true, kind: 'rate' };
      ds.lastScreenStatus = 'limited';
      if (kind === 'quota-cleared') ds.usageLimit = undefined;
      if (kind === 'not-limited') ds.usageLimit.limited = false;
      if (kind === 'screen-recovered') ds.lastScreenStatus = 'idle';
      expect(await recoverFailedTurn('old', request)).toEqual({ ok: false, error: 'failure_changed' });
      expect(pool.sendWorkerInput).not.toHaveBeenCalled();
      expect(pool.closeSessionForBackgroundCleanup).not.toHaveBeenCalled();
    });
  it('still admits a currently limited snapshot, and retains its receipt after the limit clears', async () => {
    ds.session.lastFailedTurn.limitedSnapshot = true;
    ds.usageLimit = { limited: true, kind: 'rate' }; ds.lastScreenStatus = 'limited';
    const accepted = await recoverFailedTurn('old', request);
    expect(accepted).toMatchObject({ ok: true, state: 'accepted' });
    ds.usageLimit = undefined; ds.lastScreenStatus = 'idle';
    expect(await recoverFailedTurn('old', request)).toEqual(accepted);
    expect(pool.sendWorkerInput).toHaveBeenCalledTimes(1);
  });
  it('removes an unclaimed quota snapshot when the native screen recovers', async () => {
    ds.session.lastFailedTurn.limitedSnapshot = true;
    clearLimitedFailedTurn(ds);
    expect(ds.session.lastFailedTurn).toBeUndefined();
    expect(rows.get('old').lastFailedTurn).toBeUndefined();
    expect(await recoverFailedTurn('old', request)).toEqual({ ok: false, error: 'failure_changed' });
    expect(pool.sendWorkerInput).not.toHaveBeenCalled();
  });
  it('only clears the quota observation for the completed native turn', () => {
    ds.session.lastFailedTurn.limitedSnapshot = true;
    clearLimitedFailedTurn(ds, 'other-turn');
    expect(ds.session.lastFailedTurn).toBeDefined();
    clearLimitedFailedTurn(ds, request.turnId);
    expect(ds.session.lastFailedTurn).toBeUndefined();
  });
  it('expires provisional quota observations on current-generation native completion', () => {
    ds.session.workerGeneration = 4;
    ds.session.lastFailedTurn.limitedSnapshot = true;
    recordFailedTurnTerminal(ds, { turnId: request.turnId, status: 'completed' },
      { workerGeneration: 3, caller, silent: false });
    expect(ds.session.lastFailedTurn).toBeDefined();
    recordFailedTurnTerminal(ds, { turnId: request.turnId, status: 'completed' },
      { workerGeneration: 4, caller, silent: false });
    expect(ds.session.lastFailedTurn).toBeUndefined();
  });
  it('replaces an unclaimed quota observation with the real failed terminal', () => {
    ds.session.lastFailedTurn.limitedSnapshot = true;
    ds.lastUserPrompt = 'actual prompt'; ds.lastCliInput = 'actual wrapped input';
    recordFailedTurnTerminal(ds, { turnId: request.turnId, status: 'failed', errorCode: 'rate_limited' },
      { workerGeneration: 1, caller, silent: false });
    expect(ds.session.lastFailedTurn).toMatchObject({ userPrompt: 'actual prompt', trustedCaller: caller });
    expect(ds.session.lastFailedTurn.limitedSnapshot).toBeUndefined();
    clearLimitedFailedTurn(ds);
    expect(ds.session.lastFailedTurn).toBeDefined();
  });
  it.each(['failed', 'completed'])('keeps a claimed recovery fence across late terminal events (%s)', status => {
    ds.session.workerGeneration = 1;
    ds.session.lastFailedTurn.limitedSnapshot = true;
    ds.session.lastFailedTurn.recovery = { ...request, turnId: 'recovery', sessionId: 'old', state: 'attempting' };
    ds.lastCliInput = 'late input';
    recordFailedTurnTerminal(ds, { turnId: request.turnId, status }, { workerGeneration: 1, caller, silent: false });
    expect(ds.session.lastFailedTurn.recovery.state).toBe('attempting');
    expect(store.updateSession).not.toHaveBeenCalled();
  });
  it('retains real failed terminals when a later screen changes', () => {
    clearLimitedFailedTurn(ds);
    expect(ds.session.lastFailedTurn?.turnId).toBe(request.turnId);
    expect(store.updateSession).not.toHaveBeenCalled();
  });
  it.each(['attempting', 'accepted', 'dispatch_unknown', 'cancelled'])(
    'retains claimed quota snapshots and durable receipts (%s)', state => {
      ds.session.lastFailedTurn.limitedSnapshot = true;
      ds.session.lastFailedTurn.recovery = { requestId: request.requestId, mode: request.mode,
        turnId: 'recovery', sessionId: 'old', state };
      clearLimitedFailedTurn(ds, request.turnId);
      expect(ds.session.lastFailedTurn?.recovery?.state).toBe(state);
      expect(store.updateSession).not.toHaveBeenCalled();
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
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('scheduled recovery refused');
    expect(result.state).toBe('accepted');
    expect(result.turnId).toMatch(/^schedule:abcdef12:/);
    expect(pool.prepareFailedTurnRecoveryIdentity).toHaveBeenCalledWith(ds, expect.stringMatching(/^schedule:abcdef12:/));
    expect(isSilentScheduledTurn(ds, result.turnId)).toBe(true);
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
    expect(ds.session.lastFailedTurn).toMatchObject({ trustedCaller: caller, errorCode: 'rate_limited', originalTurnId: request.turnId, limitedSnapshot: true });
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
  it.each(['interactive', 'recovery', 'schedule'])(
    'does not replace an explicit cross-app caller with a reply-target guess (%s)', source => {
      const foreign = { ...caller, requestLarkAppId: 'cli_other' };
      if (source === 'interactive') ds.activeInteractiveTurn = { turnId: request.turnId, caller: foreign };
      if (source === 'recovery') ds.session.failedTurnRecovery = { turnId: request.turnId, caller: foreign };
      if (source === 'schedule') ds.scheduledTurnCallers = new Map([[request.turnId, foreign]]);
      expect(failedTurnCaller(ds, request.turnId)).toBeUndefined();
    });
  it.each([undefined, 'cli_other'])('does not attach an unbound reply target to the live app (%s)', appId => {
    ds.session.larkAppId = appId;
    expect(failedTurnCaller(ds, request.turnId)).toBeUndefined();
  });
  it('rejects caller, input and scope overrides from clients', () => {
    expect(parseFailedTurnRecoveryRequest(request)).toEqual(request);
    for (const extra of [{ caller }, { instruction: 'other task' }, { larkAppId: 'other' }, { trustedCaller: caller }]) {
      expect(parseFailedTurnRecoveryRequest({ ...request, ...extra })).toBeUndefined();
    }
  });
});
