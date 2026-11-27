import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WecomBridge, type WecomBridgePolicy, type WecomCore } from '../src/im/wecom/gateway/bridge.js';
import { validateWecomMessageConfig } from '../src/im/wecom/config/message-config.js';
import type { WecomCardEvent, WecomInboundMessage, WecomTemplateCard } from '../src/im/wecom/protocol/types.js';
import { blockWecomStateWrites } from './helpers/wecom-state-writes.js';

const roots: string[] = [];
afterEach(() => { vi.useRealTimers(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const message = (id = 'first', text = 'execute task'): WecomInboundMessage => ({ messageId: id, userId: 'alice', conversationId: 'chat', chatType: 'group', text, attachments: [], replyContext: { requestId: id } });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'wecom-config-message-')); roots.push(root);
  const stateFile = join(root, 'bridge.json');
  let policy: WecomBridgePolicy = { allowedUsers: ['alice', 'bob'], cli: 'codex-app', replyCardMode: 'unified', disableStreamingCard: false, cotEnabled: true, replyCardShowTools: true, replyCardActions: true,
    feedback: validateWecomMessageConfig({ feedback: { enabled: true, allowReselect: true } }).feedback };
  let running = false;
  const core: WecomCore = { trigger: vi.fn(async request => ({ ok: true, triggerId: `turn-${request.source.requestId}`, target: { kind: 'turn', sessionId: 'sid' } })),
    result: vi.fn(async () => ({ ok: true, state: running ? 'running' : 'completed', output: { content: 'result' } })),
    progress: vi.fn(async (_sid, turnId) => ({ turnId, workerGeneration: 1, entries: [{ kind: 'text', text: 'progress' }] })),
    interrupt: vi.fn(async () => {}), close: vi.fn(async () => ({ ok: true })), slash: vi.fn(async () => {}) };
  const transport = { reply: vi.fn(async (_message: WecomInboundMessage, _text: string, _options?: { finish?: boolean; streamId?: string }) => {}),
    send: vi.fn(async (_chat: string, _text: string) => {}), sendCard: vi.fn(async (_chat: string, _card: WecomTemplateCard) => {}),
    updateCard: vi.fn(async (_event: WecomCardEvent, _card: WecomTemplateCard) => {}) };
  const create = () => new WecomBridge({ botId: 'bot', allowedUsers: ['alice'], policy: () => policy, core, transport, stateFile });
  const state = () => JSON.parse(readFileSync(stateFile, 'utf8'));
  const tasks = () => Object.values(state().tasks) as any[];
  const event = (key: string, overrides: Partial<WecomCardEvent> = {}): WecomCardEvent => ({ messageId: `callback-${key}`, botId: 'bot', userId: 'alice', conversationId: 'chat', chatType: 'group', requestId: 'ack', taskId: `${tasks()[0].streamId}-final`, eventKey: key, receivedAt: Date.now(), ...overrides });
  return { root, stateFile, core, transport, create, tasks, event, change: (patch: Partial<WecomBridgePolicy>) => { policy = { ...policy, ...patch }; }, running: () => { running = true; } };
}
describe('WeCom message configuration changes while turns are in flight', () => {
  it('submits allowed custom passthrough exactly once to the actor route and rejects it after live removal', async () => {
    const f = fixture(), bridge = f.create(); f.change({ customPassthroughCommands: ['/native-check'] });
    await bridge.receive(message()); await bridge.tick();
    const native = message('native-command', '/native-check preserve case');
    await bridge.receive(native); await f.create().receive(native);
    expect(f.core.slash).toHaveBeenCalledExactlyOnceWith('sid', '/native-check preserve case');
    f.change({ customPassthroughCommands: [] });
    await bridge.receive(message('removed', '/native-check denied'));
    expect(f.core.slash).toHaveBeenCalledTimes(1); expect(f.core.trigger).toHaveBeenCalledTimes(1);
  });
  it('applies a privacy policy changed while the progress API is awaiting', async () => {
    const f = fixture(); vi.useFakeTimers(); f.running();
    // `reached` settles once the tick is waiting on progress: the policy change below lands mid-await, under either test runner.
    const reached = new Promise<void>(entered => { vi.mocked(f.core.progress!).mockImplementationOnce(async (_sid, turnId) => { const wait = new Promise(done => setTimeout(done, 10_000)); entered(); await wait; return { turnId, workerGeneration: 1, entries: [{ kind: 'thinking', text: 'private thought' }, { kind: 'text', text: '/workspace/private-file' }] }; }); });
    const bridge = f.create(); await bridge.receive(message()); f.transport.reply.mockClear();
    const work = bridge.tick(); await reached;
    f.change({ cotEnabled: false, hideLocalAddresses: true, workingDirectory: '/workspace' });
    await vi.advanceTimersByTimeAsync(10_000); await work;
    expect(f.transport.reply).toHaveBeenCalled();
    expect(f.transport.reply.mock.calls.flatMap(call => call[1]).join('\n')).not.toContain('private thought');
    expect(f.transport.reply.mock.calls.flatMap(call => call[1]).join('\n')).not.toContain('/workspace/private-file');
  });
  it('retries a no-progress notice whose first send was explicitly rejected', async () => {
    const f = fixture(); vi.useFakeTimers(); f.running();
    f.change({ noProgressNotify: { enabled: true, timeoutMs: 10_000 } });
    vi.mocked(f.core.progress!).mockResolvedValue(undefined);
    const bridge = f.create(); await bridge.receive(message()); await bridge.tick();
    await vi.advanceTimersByTimeAsync(10_000);
    f.transport.send.mockRejectedValueOnce(new Error('not accepted by transport'));
    await bridge.tick(); await vi.advanceTimersByTimeAsync(2_000); await bridge.tick();
    expect(f.transport.send).toHaveBeenCalledTimes(2);
  });
  it.each(['bot', 'chat', 'chatType', 'user', 'old-turn'])('never accepts a callback from a different %s', async mismatch => {
    const f = fixture(), bridge = f.create(); await bridge.receive(message()); await bridge.tick();
    const event = f.event(mismatch === 'old-turn' ? 'action:close' : 'feedback:conclusive_usable');
    if (mismatch === 'bot') event.botId = 'other';
    if (mismatch === 'chat') event.conversationId = 'other';
    if (mismatch === 'chatType') event.chatType = 'single';
    if (mismatch === 'user') event.userId = 'bob';
    if (mismatch === 'old-turn') { await bridge.receive(message('second')); await bridge.tick(); }
    await bridge.receiveCardEvent(event);
    expect(f.tasks()[0].feedback).toBeUndefined(); expect(f.transport.updateCard).not.toHaveBeenCalled(); expect(f.core.close).not.toHaveBeenCalled();
  });
  it('lets an authorized requester record and reselect feedback on an earlier completed answer', async () => {
    const f = fixture(), bridge = f.create(); await bridge.receive(message()); await bridge.tick();
    await bridge.receiveCardEvent(f.event('feedback:conclusive_usable'));
    await bridge.receive(message('later')); await bridge.tick();
    await bridge.receiveCardEvent(f.event('feedback:incorrect', { messageId: 'historical-feedback' }));
    expect(f.tasks()[0].feedback.alice).toMatchObject({ key: 'incorrect', revision: 2 });
    expect(f.core.close).not.toHaveBeenCalled(); expect(f.core.interrupt).not.toHaveBeenCalled();
  });
  it('persists feedback before callback ACK and never reapplies an event after restart', async () => {
    const f = fixture(), bridge = f.create(); await bridge.receive(message()); await bridge.tick();
    f.transport.updateCard.mockRejectedValueOnce(new Error('ack response lost'));
    const event = f.event('feedback:conclusive_usable'); await bridge.receiveCardEvent(event);
    await f.create().receiveCardEvent(event);
    expect(f.tasks()[0].feedback.alice.revision).toBe(1); expect(f.transport.updateCard).toHaveBeenCalledTimes(1);
  });
  it('poisons failed feedback writes without acknowledging or losing the prior on-disk state', async () => {
    const f = fixture(), bridge = f.create(); await bridge.receive(message()); await bridge.tick();
    const event = f.event('feedback:conclusive_usable'); const unblock = blockWecomStateWrites(f.stateFile);
    await expect(bridge.receiveCardEvent(event)).rejects.toMatchObject({ code: 'EISDIR' });
    unblock(); expect(f.transport.updateCard).not.toHaveBeenCalled(); expect(f.tasks()[0].feedback).toBeUndefined();
    await bridge.receiveCardEvent(event);
    expect(f.transport.updateCard).not.toHaveBeenCalled();
    await f.create().receiveCardEvent(event);
    expect(f.tasks()[0].feedback.alice.revision).toBe(1);
  });
});
