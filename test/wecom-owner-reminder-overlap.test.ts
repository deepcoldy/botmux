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

const roots: string[] = [];
afterEach(() => { vi.useRealTimers(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const message = (id = 'one', userId = 'alice'): WecomInboundMessage => ({ messageId: id, userId, conversationId: 'group', chatType: 'group', text: 'task', attachments: [], replyContext: { requestId: id } });
function fixture() {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-16T12:00:00Z'));
  const root = mkdtempSync(join(tmpdir(), 'wecom-owner-reminder-')); roots.push(root); const stateFile = join(root, 'bridge.json');
  let policy: WecomBridgePolicy = { allowedUsers: ['alice', 'bob'], sessionOwnerReminder: { enabled: true, text: 'owner nudge', intervalMinutes: 1, states: ['idle'] } };
  let running = false;
  const ds = { session: { sessionId: 'sid', status: 'active', workerGeneration: 1 }, workerGeneration: 1, initConfig: { apiOnly: true }, worker: { killed: false }, lastScreenStatus: 'idle', lastMessageAt: Date.now(), asyncTriggerResults: new Map(), replyExecutionStarts: new Map() } as unknown as DaemonSession;
  const core: WecomCore = { trigger: vi.fn(async request => { const turnId = `turn-${request.source.requestId}`; ds.latestAsyncTriggerId = turnId; ds.principalLaneRunningTurn = { turnId, workerGeneration: ds.workerGeneration! }; ds.asyncTriggerResults!.set(turnId, { status: 'pending', createdAt: Date.now() }); ds.lastMessageAt = Date.now(); return { ok: true, triggerId: turnId, target: { kind: 'turn', sessionId: 'sid' } }; }),
    result: vi.fn(async () => { ds.lastScreenStatus = running ? 'working' : 'idle'; if (!running) ds.asyncTriggerResults!.get(ds.latestAsyncTriggerId!)!.status = 'completed'; return { ok: true, state: running ? 'running' : 'completed', output: { content: 'answer' } }; }),
    progress: vi.fn(async (_sid, turnId) => projectCoreOnlyProgress(ds, turnId)), reminderState: vi.fn(async (_sid, turnId) => projectCoreOnlyReminderState(ds, turnId)), interrupt: vi.fn(async () => {}) };
  const send = vi.fn(async (_recipient: string, _text: string) => {}), reply = vi.fn(async () => {});
  const create = () => new WecomBridge({ botId: 'bot', allowedUsers: ['alice'], policy: () => policy, core, stateFile, transport: { send, reply } });
  const state = () => JSON.parse(readFileSync(stateFile, 'utf8'));
  return { core, ds, send, create, state, stateFile, change: (next: Partial<WecomBridgePolicy>) => { policy = { ...policy, ...next }; }, run: () => { running = true; ds.lastScreenStatus = 'working'; } };
}
// A held core read signals `reached` once the tick is waiting on it, so what the test does next lands mid-await under either test runner.
describe('WeCom owner and long-task reminders overlapping awaited state', () => {
  it('keeps the authenticated shared-session creator as owner after another member continues', async () => {
    const f = fixture(); f.change({ sessionMode: { p2pMode: 'chat', regularGroupReplyMode: 'chat', regularGroupMentionMode: 'never' } });
    const bridge = f.create(); await bridge.receive(message()); await bridge.tick(); await bridge.receive(message('bob-turn', 'bob')); await bridge.tick();
    expect(f.state().sessionOwners.sid.userId).toBe('alice'); await vi.advanceTimersByTimeAsync(60_000); await f.create().tick();
    expect(f.send).toHaveBeenCalledExactlyOnceWith('alice', expect.stringContaining('owner nudge'));
  });
  it('does not retry an owner cycle with an uncertain native ACK after process restart', async () => {
    const f = fixture(), bridge = f.create(); await bridge.receive(message()); await bridge.tick(); await vi.advanceTimersByTimeAsync(60_000);
    f.send.mockRejectedValueOnce(new WecomDeliveryUncertainError('fake ACK lost after write')); await bridge.tick(); await f.create().tick();
    expect(f.send).toHaveBeenCalledTimes(1); await vi.advanceTimersByTimeAsync(60_000); await f.create().tick(); expect(f.send).toHaveBeenCalledTimes(2);
  });
  it('requires a current native execution proof instead of using old admission time', async () => {
    const f = fixture(); f.run(); f.change({ sessionOwnerReminder: { enabled: false, text: '', intervalMinutes: 1, states: ['idle'] }, longTaskReminder: { enabled: true, thresholdMinutes: 1, intervalMinutes: 2 } });
    const bridge = f.create(); await bridge.receive(message()); await bridge.tick(); await vi.advanceTimersByTimeAsync(120_000); await bridge.tick();
    expect(f.send).not.toHaveBeenCalled();
    f.ds.replyExecutionStarts!.set(JSON.stringify(['turn-one', null]), { startedAtMs: Date.now() - 120_000, workerGeneration: 2 });
    await bridge.tick(); expect(f.send).not.toHaveBeenCalled();
    f.ds.replyExecutionStarts!.set(JSON.stringify(['turn-one', null]), { startedAtMs: Date.now(), workerGeneration: 1 });
    await vi.advanceTimersByTimeAsync(60_000); await bridge.tick(); expect(f.send).toHaveBeenCalledTimes(1);
  });
  it('does not publish an idle-owner reminder after a suspend intent is committed during the state wait', async () => {
    const f = fixture(), bridge = f.create(); await bridge.receive(message()); await bridge.tick(); await vi.advanceTimersByTimeAsync(60_000);
    let release!: () => void; const reached = new Promise<void>(entered => { vi.mocked(f.core.reminderState!).mockImplementationOnce(async (_sid, turnId) => { await new Promise<void>(done => { release = done; entered(); }); return projectCoreOnlyReminderState(f.ds, turnId); }); });
    const ticking = bridge.tick(); await reached;
    const suspend = bridge.controlSession({ sessionId: 'sid', operation: 'suspend', requestId: 'suspend-during-notice' }, async () => ({ ok: true }));
    release(); await ticking; await suspend;
    expect(f.send).not.toHaveBeenCalled();
  });
  it('never replays an owner cycle when sending succeeded but its final ledger save failed', async () => {
    const f = fixture(), bridge = f.create(); await bridge.receive(message()); await bridge.tick(); await vi.advanceTimersByTimeAsync(60_000);
    let unblock = () => {}; f.send.mockImplementationOnce(async () => { unblock = blockWecomStateWrites(f.stateFile); });
    await expect(bridge.tick()).rejects.toMatchObject({ code: 'EISDIR' }); expect(f.send).toHaveBeenCalledTimes(1);
    unblock(); await f.create().tick(); expect(f.send).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000); await f.create().tick(); expect(f.send).toHaveBeenCalledTimes(2);
  });
  it('clears an owner wait after mid-query revocation and starts a new interval after reauthorization', async () => {
    const f = fixture(), bridge = f.create(); await bridge.receive(message()); await bridge.tick(); await vi.advanceTimersByTimeAsync(60_000);
    let release!: () => void; const reached = new Promise<void>(entered => { vi.mocked(f.core.reminderState!).mockImplementationOnce(async (_sid, turnId) => { await new Promise<void>(done => { release = done; entered(); }); return projectCoreOnlyReminderState(f.ds, turnId); }); });
    const ticking = bridge.tick(); await reached; f.change({ blockedUsers: ['alice'] }); release(); await ticking;
    expect(f.send).not.toHaveBeenCalled(); f.change({ blockedUsers: [] }); await f.create().tick();
    expect(f.send).not.toHaveBeenCalled(); await vi.advanceTimersByTimeAsync(60_000); await f.create().tick();
    expect(f.send).toHaveBeenCalledExactlyOnceWith('alice', expect.stringContaining('owner nudge'));
  });
  it('clears the long-task cycle when stop arrives during an awaited progress read', async () => {
    const f = fixture(); f.change({ sessionOwnerReminder: { enabled: false, intervalMinutes: 1, text: '', states: ['idle'] }, longTaskReminder: { enabled: true, thresholdMinutes: 1, intervalMinutes: 2 } }); f.run();
    const bridge = f.create(); await bridge.receive(message()); await bridge.tick();
    f.ds.replyExecutionStarts!.set(JSON.stringify(['turn-one', null]), { startedAtMs: Date.now(), workerGeneration: 1 }); await vi.advanceTimersByTimeAsync(60_000);
    let release!: () => void; const reached = new Promise<void>(entered => { vi.mocked(f.core.progress!).mockImplementationOnce(async (_sid, turnId) => { await new Promise<void>(done => { release = done; entered(); }); return projectCoreOnlyProgress(f.ds, turnId); }); });
    const ticking = bridge.tick(); await reached; const stopping = bridge.receive({ ...message('stop'), text: '/stop' }); release(); await ticking; await stopping;
    expect(f.send).not.toHaveBeenCalled(); expect((Object.values(f.state().tasks)[0] as any).longReminder).toBeUndefined();
  });
  it('uses the current reminder text and interval after an awaited proof', async () => {
    const f = fixture(), bridge = f.create(); await bridge.receive(message()); await bridge.tick(); await vi.advanceTimersByTimeAsync(60_000);
    let release!: () => void; const reached = new Promise<void>(entered => { vi.mocked(f.core.reminderState!).mockImplementationOnce(async (_sid, turnId) => { await new Promise<void>(done => { release = done; entered(); }); return projectCoreOnlyReminderState(f.ds, turnId); }); });
    const ticking = bridge.tick(); await reached; f.change({ sessionOwnerReminder: { enabled: true, intervalMinutes: 2, text: 'new nudge', states: ['idle'] } }); release(); await ticking;
    expect(f.send).not.toHaveBeenCalled(); await vi.advanceTimersByTimeAsync(60_000); await bridge.tick();
    expect(f.send).toHaveBeenCalledExactlyOnceWith('alice', expect.stringContaining('new nudge'));
  });
});
