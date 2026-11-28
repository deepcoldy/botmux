import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WecomBridge } from '../src/im/wecom/gateway/bridge.js';
import { WecomDashboardConfig } from '../src/dashboard/wecom/config.js';
import { commitWecomConfiguration, parseWecomConfig, type WecomConfig } from '../src/im/wecom/config/config.js';
import { wecomConfigId } from '../src/im/wecom/config/discovery.js';
import { atomicWriteFileSync } from '../src/utils/atomic-write.js';
import type { TriggerRequest } from '../src/services/trigger-types.js';
import type { WecomInboundMessage } from '../src/im/wecom/protocol/types.js';
import type { WecomProgress } from '../src/im/wecom/gateway/presentation.js';

const roots: string[] = [];
afterEach(() => { vi.useRealTimers(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const message = (messageId: string): WecomInboundMessage => ({ messageId, userId: 'alice', conversationId: 'alice', chatType: 'single', text: 'execute task', replyContext: { requestId: messageId }, attachments: [] });
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'wecom-config-live-policy-')); roots.push(root);
  const file = join(root, 'config.json'), stateFile = join(root, 'bridge.json');
  const initial: WecomConfig = { botId: 'fixture', secretEnv: 'FAKE_SECRET', coreUrl: 'http://127.0.0.1:19234', allowedUsers: ['alice', 'bob'],
    role: { content: 'role-before-edit', injectMode: 'every' }, managedCore: { cli: 'codex', backend: 'pty', workingDirectory: root, port: 19234, botId: 'local_parity', stateDir: join(root, 'core') } };
  await commitWecomConfiguration({ file, previous: undefined, config: initial });
  const read = () => parseWecomConfig(JSON.parse(readFileSync(file, 'utf8')));
  const dashboard = new WecomDashboardConfig(root), id = wecomConfigId(file);
  const patch = async (change: Record<string, unknown>) => dashboard.patch(id, { revision: dashboard.get(id).revision, ...change });
  const trigger = vi.fn(async (_request: TriggerRequest) => ({ ok: true, triggerId: 'turn', target: { kind: 'turn' as const, sessionId: 'owned-session' } }));
  const result = vi.fn(async () => ({ ok: true, state: 'completed' as 'completed' | 'running', output: { content: 'private-result' } }));
  const interrupt = vi.fn(async () => {});
  const progress = vi.fn(async (_sessionId: string, _turnId: string): Promise<WecomProgress | undefined> => undefined);
  const reply = vi.fn(async (_message: WecomInboundMessage, _text: string, _options?: { streamId?: string; finish?: boolean }) => {});
  const send = vi.fn(async (_conversation: string, _text: string) => {});
  const create = () => new WecomBridge({ botId: initial.botId, allowedUsers: initial.allowedUsers, stateFile,
    policy: () => { const config = read(); return { ...config.message, commandTriggers: config.commandTriggers, allowedUsers: config.allowedUsers, blockedUsers: config.blockedUsers, role: config.role, senderTag: config.managedCore?.botConfig?.senderTag as boolean | undefined }; },
    core: { trigger, result, interrupt, progress }, transport: { reply, send } });
  return { root, file, stateFile, read, patch, dashboard, id, trigger, result, interrupt, progress, reply, send, create };
}
describe('WeCom live configuration policy for admitted and later requests', () => {
  it('freezes an admitted command template and applies live excluded-chat policy only to later requests', async () => {
    const f = await fixture(), bridge = f.create();
    await f.patch({ commandTriggers: { enabled: true, commands: [{ cmd: '/solve', prompt: 'Inspect {args}' }], chats: ['group-a'] } });
    await bridge.receive({ ...message('templated'), chatType: 'group', conversationId: 'group-a', text: '/solve Stored Case' });
    await f.patch({ commandTriggers: { enabled: false, commands: [{ cmd: '/solve', prompt: 'changed' }] } });
    await bridge.tick(); expect(f.trigger.mock.calls[0][0].envelope.rawText).toContain('Inspect Stored Case');
    await f.patch({ commandTriggers: { enabled: true, commands: [{ cmd: '/solve', prompt: 'changed' }], chats: ['group-a'], excludedChats: ['group-a'] } });
    await bridge.receive({ ...message('excluded'), chatType: 'group', conversationId: 'group-a', text: '/solve denied' }); await bridge.tick();
    await f.create().receive({ ...message('templated'), chatType: 'group', conversationId: 'group-a', text: '/solve Stored Case' }); await f.create().tick();
    expect(f.trigger).toHaveBeenCalledTimes(1);
  });
  it('keeps an old configuration quiet until progress disclosure is explicitly enabled', async () => {
    const f = await fixture(); f.result.mockResolvedValue({ ok: true, state: 'running', output: { content: '' } });
    f.progress.mockResolvedValue({ turnId: 'turn', workerGeneration: 1, entries: [{ kind: 'thinking', text: 'private thought' }, { kind: 'tool_call', name: 'Read', args: 'private tool argument' }] });
    const bridge = f.create(); await bridge.receive(message('old-config')); await bridge.tick();
    expect(f.reply.mock.calls.flatMap(call => call[1]).join('\n')).not.toContain('private thought');
    expect(f.reply.mock.calls.flatMap(call => call[1]).join('\n')).not.toContain('private tool argument');
    const defaults = f.dashboard.get(f.id).botConfig;
    expect(defaults).toMatchObject({ disableStreamingCard: true, cotEnabled: false, replyCardShowTools: false });
    await f.patch({ botConfig: { replyCardMode: 'unified', disableStreamingCard: false, cotEnabled: true, replyCardShowTools: true } });
    f.reply.mockClear(); await bridge.tick();
    expect(f.reply.mock.calls.flatMap(call => call[1]).join('\n')).toContain('private thought');
    expect(f.reply.mock.calls.flatMap(call => call[1]).join('\n')).toContain('private tool argument');
  });
  it('accepts the shared custom-runtime save payload and clears its downgrade shadow when reset', async () => {
    const f = await fixture();
    await f.patch({ botConfig: { cliRuntime: { id: 'fixture-runtime', executable: '/tmp/fixture-runtime', update: { provider: 'none' } } } });
    expect(f.read().managedCore?.botConfig).toMatchObject({ cliRuntime: { executable: '/tmp/fixture-runtime' }, cliPathOverride: '/tmp/fixture-runtime' });
    await f.patch({ botConfig: { cliRuntime: null } });
    expect(f.read().managedCore?.botConfig).not.toHaveProperty('cliRuntime'); expect(f.read().managedCore?.botConfig).not.toHaveProperty('cliPathOverride');
  });
  it('makes a persisted blacklist deny an otherwise permitted native user', async () => {
    const f = await fixture();
    await f.patch({ blockedUsers: ['alice'] });
    await f.create().receive(message('denied')); await f.create().tick();
    expect(f.trigger).not.toHaveBeenCalled(); expect(f.reply).not.toHaveBeenCalled();
  });
  it('rechecks authority after a running result poll and interrupts the revoked turn immediately', async () => {
    const f = await fixture(); vi.useFakeTimers();
    f.result.mockImplementationOnce(async () => { await new Promise(done => setTimeout(done, 10_000)); return { ok: true, state: 'running', output: { content: '' } }; });
    const bridge = f.create(); await bridge.receive(message('admitted')); f.reply.mockClear();
    const ticking = bridge.tick(); await vi.advanceTimersByTimeAsync(1);
    await f.patch({ allowedUsers: ['bob'] });
    await vi.advanceTimersByTimeAsync(10_000); await ticking;
    expect(f.interrupt).toHaveBeenCalledWith('owned-session', 'turn');
    expect(f.progress).not.toHaveBeenCalled();
    expect(f.reply).not.toHaveBeenCalled(); expect(f.send).not.toHaveBeenCalled();
  });
  it('freezes admitted role instructions while later turns use newly committed role and sender policy', async () => {
    const f = await fixture(), bridge = f.create(); await bridge.receive(message('first'));
    await f.patch({ role: { content: 'role-after-edit', injectMode: 'once' }, botConfig: { senderTag: false } });
    await bridge.tick();
    expect(f.trigger.mock.calls[0][0].instruction).toContain('role-before-edit');
    expect(f.trigger.mock.calls[0][0].instruction).not.toContain('role-after-edit');
    await bridge.receive(message('second')); await bridge.tick();
    expect(f.trigger.mock.calls[1][0].instruction).not.toContain('role-after-edit');
    expect(f.trigger.mock.calls[1][0].envelope.rawText).toBe('execute task');
    await bridge.receive({ ...message('restart'), text: '/restart' });
    await bridge.receive(message('third')); await bridge.tick();
    expect(f.trigger.mock.calls[2][0].instruction).toContain('role-after-edit');
  });
  it('keeps the prior complete configuration after a failed multi-field commit, then safely retries', async () => {
    const f = await fixture(), previous = readFileSync(f.file, 'utf8'), config = f.read();
    await expect(commitWecomConfiguration({ file: f.file, previous,
      config: { ...config, allowedUsers: ['bob'], role: { content: 'new role', injectMode: 'once' } },
      newSecret: 'fake-new-secret', write: (path, data, options) => { if (path === f.file) throw new Error('disk failure before rename'); atomicWriteFileSync(path, data, options); },
    })).rejects.toThrow('disk failure before rename');
    expect(readFileSync(f.file, 'utf8')).toBe(previous);
    expect(f.read().allowedUsers).toEqual(['alice', 'bob']);
    await f.patch({ allowedUsers: ['bob'], role: { content: 'new role', injectMode: 'once' } });
    expect(f.read().allowedUsers).toEqual(['bob']); expect(f.read().role?.content).toBe('new role');
    await expect(f.dashboard.patch(f.id, { revision: JSON.parse(JSON.stringify(f.dashboard.get(f.id))).revision, botConfig: { larkAppId: null } })).rejects.toThrow('invalid_core_bot_profile');
  });
  it('never redelivers a revoked result when periodic ticks overlap a slow poll and later reauthorization', async () => {
    const f = await fixture(); vi.useFakeTimers();
    f.result.mockImplementationOnce(async () => { await new Promise(done => setTimeout(done, 10_000)); return { ok: true, state: 'completed', output: { content: 'private-result' } }; });
    const bridge = f.create(); await bridge.receive(message('admitted')); f.reply.mockClear();
    const work: Promise<void>[] = [], timer = setInterval(() => { work.push(bridge.tick()); }, 1_000);
    await vi.advanceTimersByTimeAsync(2_000); await f.patch({ allowedUsers: ['bob'] });
    await vi.advanceTimersByTimeAsync(10_000); clearInterval(timer); await Promise.all(work);
    await f.patch({ allowedUsers: ['alice', 'bob'] });
    await f.create().tick();
    expect(f.trigger).toHaveBeenCalledTimes(1); expect(f.reply).not.toHaveBeenCalled(); expect(f.send).not.toHaveBeenCalled();
  });
  it('fails closed when policy becomes unreadable during an awaited result', async () => {
    const f = await fixture(); vi.useFakeTimers();
    f.result.mockImplementationOnce(async () => { await new Promise(done => setTimeout(done, 10_000)); return { ok: true, state: 'completed', output: { content: 'private-result' } }; });
    const bridge = f.create(); await bridge.receive(message('admitted')); f.reply.mockClear();
    const work = bridge.tick(); await vi.advanceTimersByTimeAsync(1);
    const previous = readFileSync(f.file, 'utf8'); writeFileSync(f.file, '{incomplete');
    await vi.advanceTimersByTimeAsync(10_000); await work;
    writeFileSync(f.file, previous); await f.create().tick();
    expect(f.reply).not.toHaveBeenCalled(); expect(f.send).not.toHaveBeenCalled();
  });
});
