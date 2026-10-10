import { beforeEach, expect, it, vi } from 'vitest';
import { createGroupIdleCloseSweeper, isGroupIdleCloseCandidate } from '../src/core/group-idle-close-sweeper.js';
import { __testOnly_resetBotTurnMutationGates, withBotTurnAdmission } from '../src/core/bot-turn-mutation-gate.js';
import type { DaemonSession } from '../src/core/types.js';

const now = Date.parse('2026-10-08T12:00:00Z');
const hour = 3_600_000;
const settings = { enabled: true, duration: 2, unit: 'hours' as const };
function session(id = 'a'): DaemonSession {
  return {
    session: { sessionId: id, status: 'active', lastMessageAt: new Date(now - 2 * hour).toISOString() },
    larkAppId: 'app-a', chatId: 'oc_a', chatType: 'group', scope: 'thread',
    worker: { killed: false }, workerReady: true, lastScreenStatus: 'idle',
    lastMessageAt: now - 2 * hour, hasHistory: true,
  } as DaemonSession;
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
function setup(rows = [session()]) {
  const deps = {
    larkAppId: 'app-a', sessions: new Map(rows.map(ds => [ds.session.sessionId, ds])),
    getSettings: vi.fn(() => settings), isTransferring: vi.fn(() => false),
    close: vi.fn(async () => ({ ok: true, alreadyClosed: false, outcome: 'closed' } as any)),
    now: () => now, log: vi.fn(),
  };
  return { deps, sweep: createGroupIdleCloseSweeper(deps) };
}
beforeEach(() => __testOnly_resetBotTurnMutationGates());

it('uses exact hour/day boundaries and latest persisted or runtime interaction', () => {
  const ds = session();
  expect(isGroupIdleCloseCandidate(ds, undefined, now)).toBe(false);
  expect(isGroupIdleCloseCandidate(ds, { ...settings, enabled: false }, now)).toBe(false);
  expect(isGroupIdleCloseCandidate(ds, settings, now - 1)).toBe(false);
  expect(isGroupIdleCloseCandidate(ds, settings, now)).toBe(true);
  expect(isGroupIdleCloseCandidate(ds, { ...settings, unit: 'days' }, now)).toBe(false);
  ds.session.lastMessageAt = new Date(now).toISOString();
  expect(isGroupIdleCloseCandidate(ds, settings, now)).toBe(false);
  ds.session.lastMessageAt = 'invalid';
  ds.lastMessageAt = NaN;
  expect(isGroupIdleCloseCandidate(ds, settings, now)).toBe(false);
});

it.each([
  { lastScreenStatus: 'working' }, { lastScreenStatus: 'analyzing' }, { lastScreenStatus: 'starting' },
  { workerReady: false }, { pendingRepo: true }, { worktreeCreating: true },
  { pendingRawInput: 'input' }, { pendingFollowUpInput: {} }, { pendingFollowUps: ['input'] },
  { cascadeInFlight: true }, { cascadeDeferred: [{}] },
  { tuiPromptCardId: 'card' }, { tuiPromptOptions: [{}] }, { agentAttention: {} },
  { finalOutputDeliveriesInFlight: new Set([Promise.resolve()]) }, { initialStartPending: true },
  { adoptedFrom: {} }, { usageLimit: {} }, { chatType: 'p2p' },
])('retains sessions that own work or need attention: %j', patch => {
  expect(isGroupIdleCloseCandidate(Object.assign(session(), patch), settings, now)).toBe(false);
});

it.each([
  { locked: true }, { adoptedFrom: {} }, { queued: true }, { queuedActivationPending: true },
  { queuedActivationTail: [{}] }, { principalLaneQueuedTurns: [{}] }, { pendingRepoSetup: {} },
  { status: 'closed' },
])('retains protected persisted states: %j', patch => {
  const ds = session();
  Object.assign(ds.session, patch);
  expect(isGroupIdleCloseCandidate(ds, settings, now)).toBe(false);
});

it.each(['pty', 'tmux', 'zmx', 'remote-runner'])('supports idle and dormant sessions across %s backends', backendType => {
  const ds = session();
  ds.initConfig = { backendType } as any;
  expect(isGroupIdleCloseCandidate(ds, settings, now)).toBe(true);
  ds.worker = null;
  ds.lastScreenStatus = undefined;
  ds.session.suspendedColdResume = true;
  expect(isGroupIdleCloseCandidate(ds, settings, now)).toBe(true);
  ds.hasHistory = false;
  expect(isGroupIdleCloseCandidate(ds, settings, now)).toBe(false);
});

it('only closes matching bot/group sessions, skipping transfers', async () => {
  const a = session('a'), b = session('b'), c = session('c');
  b.larkAppId = 'app-b';
  c.chatId = 'oc_b';
  const { deps, sweep } = setup([a, b, c]);
  deps.getSettings.mockImplementation(chatId => chatId === 'oc_a' ? settings : undefined as any);
  deps.isTransferring.mockReturnValue(true);
  await sweep();
  expect(deps.close).not.toHaveBeenCalled();
  deps.isTransferring.mockReturnValue(false);
  await sweep();
  expect(deps.close).toHaveBeenCalledExactlyOnceWith('a', 'group idle auto-close');
});

it.each(['message', 'disabled', 'replaced'])('rechecks %s after admitted input drains', async change => {
  const ds = session();
  const { deps, sweep } = setup([ds]);
  const entered = deferred(), release = deferred();
  const admission = withBotTurnAdmission('app-a', async () => { entered.resolve(); await release.promise; });
  await entered.promise;
  const tick = sweep();
  expect(deps.close).not.toHaveBeenCalled();
  if (change === 'message') ds.lastMessageAt = now;
  if (change === 'disabled') deps.getSettings.mockReturnValue({ ...settings, enabled: false });
  if (change === 'replaced') deps.sessions.set('a', session());
  release.resolve();
  await Promise.all([admission, tick]);
  expect(deps.close).not.toHaveBeenCalled();
});

it('coalesces ticks and rechecks later candidates after each asynchronous close', async () => {
  const a = session('a'), b = session('b');
  const { deps, sweep } = setup([a, b]);
  const entered = deferred(), release = deferred();
  deps.close.mockImplementation(async () => { entered.resolve(); await release.promise; return { ok: true, alreadyClosed: false } as any; });
  const first = sweep();
  await entered.promise;
  await sweep();
  b.lastMessageAt = now;
  release.resolve();
  await first;
  expect(deps.close).toHaveBeenCalledOnce();
});

it('does not report refused closes as success and continues after a failure', async () => {
  const { deps, sweep } = setup([session('a'), session('b'), session('c')]);
  deps.close.mockRejectedValueOnce(new Error('close failed')).mockResolvedValueOnce({ ok: false } as any);
  await sweep();
  expect(deps.close).toHaveBeenCalledTimes(3);
  expect(deps.log.mock.calls.flat().filter(message => message.includes('closed session'))).toEqual(['[group-idle-close] closed session c']);
});
