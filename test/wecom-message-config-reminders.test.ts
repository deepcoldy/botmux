import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WecomBridge, type WecomBridgePolicy, type WecomCore } from '../src/im/wecom/gateway/bridge.js';
import { WecomDeliveryUncertainError, type WecomInboundMessage } from '../src/im/wecom/protocol/types.js';
import { projectCoreOnlyProgress } from '../src/core/core-only-progress.js';
import { projectCoreOnlyReminderState } from '../src/core/core-only-reminder-state.js';
import type { DaemonSession } from '../src/core/types.js';
import { blockWecomStateWrites } from './helpers/wecom-state-writes.js';
const dirs: string[] = [];
afterEach(() => { vi.useRealTimers(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const message = (id = 'm', userId = 'alice'): WecomInboundMessage => ({ messageId: id, userId, conversationId: 'group', chatType: 'group', text: 'execute', attachments: [], replyContext: { requestId: id } });
function setup(patch: Partial<WecomBridgePolicy> = {}) {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-16T04:00:00Z'));
  const dir = mkdtempSync(join(tmpdir(), 'wecom-native-reminders-')); dirs.push(dir); const stateFile = join(dir, 'state.json');
  let policy: WecomBridgePolicy = { allowedUsers: ['alice','bob'], ...patch };
  let running = true;
  const ds = { session: { sessionId: 'sid', status: 'active', workerGeneration: 1 }, workerGeneration: 1, initConfig: { apiOnly: true }, worker: { killed: false }, lastScreenStatus: 'working', lastMessageAt: Date.now(), asyncTriggerResults: new Map(), replyExecutionStarts: new Map() } as unknown as DaemonSession;
  const core: WecomCore = { trigger: vi.fn(async req => { const turnId = `turn-${req.source.requestId}`; ds.latestAsyncTriggerId = turnId; ds.principalLaneRunningTurn = { turnId, workerGeneration: ds.workerGeneration! }; ds.asyncTriggerResults!.set(turnId, { status: 'pending', createdAt: Date.now() }); ds.lastMessageAt = Date.now(); return { ok: true, triggerId: turnId, target: { kind: 'turn', sessionId: 'sid' } }; }),
    result: vi.fn(async () => { if (!running) { ds.lastScreenStatus = 'idle'; ds.asyncTriggerResults!.get(ds.latestAsyncTriggerId!)!.status = 'completed'; } return { ok: true, state: running ? 'running' : 'completed', output: { content: 'answer' } }; }),
    progress: vi.fn(async (_sid, trigger) => projectCoreOnlyProgress(ds, trigger)), reminderState: vi.fn(async (_sid, trigger) => projectCoreOnlyReminderState(ds, trigger)), interrupt: vi.fn(async () => {}) };
  const transport = { reply: vi.fn(async (_message: WecomInboundMessage, _text: string, _options?: { streamId?: string; finish?: boolean }) => {}), send: vi.fn(async (_recipient: string, _text: string) => {}) };
  const create = () => new WecomBridge({ botId: 'bot', allowedUsers: ['alice'], stateFile, policy: () => policy, core, transport });
  const state = () => JSON.parse(readFileSync(stateFile, 'utf8'));
  const task = () => Object.values(state().tasks)[0] as any;
  const start = () => ds.replyExecutionStarts!.set(JSON.stringify([ds.latestAsyncTriggerId, null]), { startedAtMs: Date.now(), workerGeneration: ds.workerGeneration! });
  return { core, transport, ds, create, state, task, start, stateFile, set: (next: Partial<WecomBridgePolicy>) => { policy = { ...policy, ...next }; }, finish: () => { running = false; }, run: () => { running = true; } };
}
const long = { enabled: true, thresholdMinutes: 1, intervalMinutes: 2 };
const owner = { enabled: true, intervalMinutes: 1, text: 'please follow up', states: ['idle' as const, 'limited' as const] };
describe('Native long-task reminder execution clocks and durable cycles', () => {
  it('uses actual native execution start, repeats at its configured interval and clears at terminal', async () => {
    const f = setup({ longTaskReminder: long }), bridge = f.create(); await bridge.receive(message()); await bridge.tick();
    await vi.advanceTimersByTimeAsync(120000); await bridge.tick(); expect(f.transport.send).not.toHaveBeenCalled(); // queued, no execution proof
    f.start(); await vi.advanceTimersByTimeAsync(59999); await bridge.tick(); expect(f.transport.send).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); await bridge.tick(); expect(f.transport.send).toHaveBeenCalledTimes(1); expect(f.transport.send.mock.calls[0]).toEqual(['group', expect.stringContaining('1 分钟')]);
    await vi.advanceTimersByTimeAsync(119999); await f.create().tick(); expect(f.transport.send).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1); await bridge.tick(); expect(f.transport.send).toHaveBeenCalledTimes(2);
    f.finish(); await bridge.tick(); expect(f.task().longReminder).toBeUndefined(); await vi.advanceTimersByTimeAsync(300000); await bridge.tick(); expect(f.transport.send).toHaveBeenCalledTimes(2);
  });
  it('retries explicit rejection, retains uncertain cycle across restart and permits a later distinct cycle', async () => {
    const f = setup({ longTaskReminder: long }), bridge = f.create(); await bridge.receive(message()); await bridge.tick(); f.start();
    f.transport.send.mockRejectedValueOnce(new Error('negative ack')); await vi.advanceTimersByTimeAsync(60000); await bridge.tick();
    await vi.advanceTimersByTimeAsync(2000); await bridge.tick(); expect(f.transport.send).toHaveBeenCalledTimes(2);
    f.transport.send.mockRejectedValueOnce(new WecomDeliveryUncertainError('ack lost')); await vi.advanceTimersByTimeAsync(120000); await bridge.tick();
    await f.create().tick(); expect(f.transport.send).toHaveBeenCalledTimes(3); await vi.advanceTimersByTimeAsync(120000); await bridge.tick(); expect(f.transport.send).toHaveBeenCalledTimes(4);
  });
  it('rechecks config and ACL after awaiting progress and never sends from a replaced execution generation', async () => {
    const f = setup({ longTaskReminder: long }), bridge = f.create(); await bridge.receive(message()); await bridge.tick(); f.start(); await vi.advanceTimersByTimeAsync(60000);
    // `reached` settles once the tick is waiting on progress: the change below lands mid-await, under either test runner.
    let release!: (value: any) => void; const reached = new Promise<void>(entered => { vi.mocked(f.core.progress!).mockImplementationOnce(() => new Promise(resolve => { release = resolve; entered(); })); });
    const work = bridge.tick(); await reached; f.set({ longTaskReminder: { ...long, enabled: false } }); release(projectCoreOnlyProgress(f.ds, 'turn-m')); await work; expect(f.transport.send).not.toHaveBeenCalled();
    f.set({ longTaskReminder: long }); f.ds.workerGeneration = 2; f.ds.principalLaneRunningTurn = { turnId: 'turn-m', workerGeneration: 2 }; await bridge.tick(); expect(f.transport.send).not.toHaveBeenCalled();
    f.ds.workerGeneration = 1; f.ds.principalLaneRunningTurn = { turnId: 'turn-m', workerGeneration: 1 }; f.set({ blockedUsers: ['alice'] }); await bridge.tick(); expect(f.transport.send).not.toHaveBeenCalled();
  });
  it('poisons a half-write before transport and allows one clean retry only after restart', async () => {
    const f = setup({ longTaskReminder: long }), bridge = f.create(); await bridge.receive(message()); await bridge.tick(); f.start(); await vi.advanceTimersByTimeAsync(60000);
    const unblock = blockWecomStateWrites(f.stateFile); await expect(bridge.tick()).rejects.toMatchObject({ code: 'EISDIR' }); expect(f.transport.send).not.toHaveBeenCalled(); unblock();
    await f.create().tick(); expect(f.transport.send).toHaveBeenCalledTimes(1);
  });
});

describe('Native stable session owner reminders', () => {
  it('privately reminds the authenticated creator after shared-session activity by another user', async () => {
    const f = setup({ sessionOwnerReminder: owner, sessionMode: { p2pMode: 'chat', regularGroupReplyMode: 'chat', regularGroupMentionMode: 'never' } }), bridge = f.create();
    f.finish(); await bridge.receive(message()); await bridge.tick(); expect(f.state().sessionOwners.sid.userId).toBe('alice');
    await bridge.receive(message('bob-turn', 'bob')); await bridge.tick(); expect(f.state().sessionOwners.sid.userId).toBe('alice');
    await vi.advanceTimersByTimeAsync(60000); await bridge.tick(); expect(f.transport.send).toHaveBeenCalledWith('alice', expect.stringContaining('please follow up')); expect(f.transport.send.mock.calls.map(call => call[0])).not.toContain('bob');
    await f.create().tick(); expect(f.transport.send).toHaveBeenCalledTimes(1);
  });
  it('resets on activity/state/worker generation, applies text updates, and stops after mode epoch change', async () => {
    const f = setup({ sessionOwnerReminder: owner }), bridge = f.create(); f.finish(); await bridge.receive(message()); await bridge.tick();
    await vi.advanceTimersByTimeAsync(30000); f.ds.lastMessageAt = Date.now(); await bridge.tick(); await vi.advanceTimersByTimeAsync(30000); await bridge.tick(); expect(f.transport.send).not.toHaveBeenCalled();
    f.ds.lastScreenStatus = 'limited'; vi.mocked(f.core.result).mockResolvedValue({ ok: true, state: 'completed' }); await bridge.tick(); await vi.advanceTimersByTimeAsync(60000); f.set({ sessionOwnerReminder: { ...owner, text: 'updated follow up' } }); await bridge.tick(); expect(f.transport.send).toHaveBeenLastCalledWith('alice', expect.stringContaining('updated follow up'));
    f.set({ sessionModeEpoch: 'new-mode-generation' }); await vi.advanceTimersByTimeAsync(60000); await bridge.tick(); expect(f.transport.send).toHaveBeenCalledTimes(1);
  });
  it('rechecks owner ACL after the awaited state proof and never substitutes the latest speaker', async () => {
    const f = setup({ sessionOwnerReminder: owner }), bridge = f.create(); f.finish(); await bridge.receive(message()); await bridge.tick(); await vi.advanceTimersByTimeAsync(60000);
    let release!: (value: any) => void; const reached = new Promise<void>(entered => { vi.mocked(f.core.reminderState!).mockImplementationOnce(() => new Promise(resolve => { release = resolve; entered(); })); });
    const work = bridge.tick(); await reached; f.set({ blockedUsers: ['alice'] }); release(projectCoreOnlyReminderState(f.ds, 'turn-m')); await work;
    expect(f.transport.send).not.toHaveBeenCalled(); expect(f.state().ownerReminderCycles.sid).toBeUndefined();
  });
  it('keeps owner notification cycle after a lost ACK and retries only explicit failure', async () => {
    const f = setup({ sessionOwnerReminder: owner }), bridge = f.create(); f.finish(); await bridge.receive(message()); await bridge.tick();
    f.transport.send.mockRejectedValueOnce(new Error('negative ack')); await vi.advanceTimersByTimeAsync(60000); await bridge.tick(); await vi.advanceTimersByTimeAsync(2000); await bridge.tick(); expect(f.transport.send).toHaveBeenCalledTimes(2);
    f.transport.send.mockRejectedValueOnce(new WecomDeliveryUncertainError('lost ack')); await vi.advanceTimersByTimeAsync(60000); await bridge.tick(); await f.create().tick(); expect(f.transport.send).toHaveBeenCalledTimes(3);
  });
  // Quiet hours are judged on the process's local wall clock, so the clock is set in local time.
  // The 15-minute interval outlasts the 10-minute window: a deferral counted as a reminder would push the send to 22:15.
  it('holds a due reminder through quiet hours and sends it once on the first tick after they end', async () => {
    const f = setup({ sessionOwnerReminder: { ...owner, intervalMinutes: 15, quietHours: { enabled: true, start: '22:00', end: '22:10' } } }), bridge = f.create();
    vi.setSystemTime(new Date(2026, 10, 17, 21, 45)); f.finish(); await bridge.receive(message()); await bridge.tick();
    await vi.advanceTimersByTimeAsync(15 * 60000); await bridge.tick(); expect(f.transport.send).not.toHaveBeenCalled(); // 22:00, due
    const restarted = f.create(); await vi.advanceTimersByTimeAsync(9 * 60000); await restarted.tick(); expect(f.transport.send).not.toHaveBeenCalled(); // 22:09, after a restart
    await vi.advanceTimersByTimeAsync(60000); await restarted.tick(); await restarted.tick(); // 22:10
    expect(f.transport.send).toHaveBeenCalledTimes(1); expect(f.transport.send).toHaveBeenCalledWith('alice', expect.stringContaining('please follow up'));
  });
  it('sends inside the configured window when quiet hours are disabled', async () => {
    const f = setup({ sessionOwnerReminder: { ...owner, quietHours: { enabled: false, start: '22:00', end: '22:10' } } }), bridge = f.create();
    vi.setSystemTime(new Date(2026, 10, 17, 21, 59)); f.finish(); await bridge.receive(message()); await bridge.tick();
    await vi.advanceTimersByTimeAsync(60000); await bridge.tick(); expect(f.transport.send).toHaveBeenCalledTimes(1);
  });
});

it('supports real prelaunch pending-repo state without inventing a live worker generation', async () => {
  const f = setup({ sessionOwnerReminder: { ...owner, states: ['pending_repo'] } }), bridge = f.create();
  await bridge.receive(message()); await bridge.tick();
  f.ds.worker = undefined; f.ds.workerGeneration = undefined; f.ds.session.workerGeneration = undefined;
  f.ds.pendingRepo = {} as DaemonSession['pendingRepo'];
  const state = projectCoreOnlyReminderState(f.ds, 'turn-m'); expect(state).toMatchObject({ workerGeneration: 0, states: ['pending_repo'] });
  await bridge.tick(); await vi.advanceTimersByTimeAsync(60000); await bridge.tick(); expect(f.transport.send).toHaveBeenCalledWith('alice', expect.stringContaining('pending_repo'));
  f.ds.pendingRepo = undefined; expect(projectCoreOnlyReminderState(f.ds, 'turn-m')).toBeUndefined();
});

it('keeps execution generations isolated even when an old core progress response arrives later', async () => {
  const f = setup({ longTaskReminder: long }), bridge = f.create(); await bridge.receive(message()); await bridge.tick(); f.start();
  const stale = projectCoreOnlyProgress(f.ds, 'turn-m')!;
  f.ds.workerGeneration = 2; f.ds.principalLaneRunningTurn = { turnId: 'turn-m', workerGeneration: 2 };
  f.ds.replyExecutionStarts!.set(JSON.stringify(['turn-m', null]), { workerGeneration: 2, startedAtMs: Date.now() });
  await bridge.tick(); await vi.advanceTimersByTimeAsync(60000);
  vi.mocked(f.core.progress!).mockResolvedValueOnce(stale); await bridge.tick(); expect(f.transport.send).not.toHaveBeenCalled();
  await bridge.tick(); expect(f.transport.send).toHaveBeenCalledTimes(1);
});
