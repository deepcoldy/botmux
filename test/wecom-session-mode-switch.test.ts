import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WecomBridge } from '../src/im/wecom/gateway/bridge.js';
import { WecomDashboardConfig } from '../src/dashboard/wecom/config.js';
import { parseWecomConfig } from '../src/im/wecom/config/config.js';
import { wecomConfigId } from '../src/im/wecom/config/discovery.js';
import type { TriggerRequest } from '../src/services/trigger-types.js';
import type { WecomInboundMessage } from '../src/im/wecom/protocol/types.js';
const roots: string[] = [];
afterEach(() => { vi.useRealTimers(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const mode = (group: 'user' | 'chat') => ({ p2pMode: 'chat', regularGroupReplyMode: group, regularGroupMentionMode: 'never' });
const message = (id: string, userId = 'alice', text = 'task'): WecomInboundMessage => ({ messageId: id, userId, conversationId: 'group', chatType: 'group', text, attachments: [], replyContext: { requestId: id } });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'wecom-session-mode-')); roots.push(root);
  const file = join(root, 'config.json'), stateFile = join(root, 'bridge.json');
  writeFileSync(file, JSON.stringify({ botId: 'native', secretEnv: 'FAKE_SECRET', allowedUsers: ['alice', 'bob', 'charlie'], coreUrl: 'http://127.0.0.1:19730',
    managedCore: { botId: 'local_route', cli: 'codex', backend: 'pty', workingDirectory: root, port: 19730, stateDir: join(root, 'core') } }));
  const service = new WecomDashboardConfig(root), id = wecomConfigId(file), read = () => parseWecomConfig(JSON.parse(readFileSync(file, 'utf8')));
  let running = true, count = 0;
  const trigger = vi.fn(async (request: TriggerRequest) => ({ ok: true, triggerId: `turn-${request.source.requestId}`, target: { kind: 'turn' as const, sessionId: request.target.sessionId ?? `sid-${++count}` } }));
  const interrupt = vi.fn(async (_sid: string, _turn: string) => {}), reply = vi.fn(async (_message: WecomInboundMessage, _text: string, _options?: { finish?: boolean }) => {});
  const create = () => new WecomBridge({ botId: 'native', allowedUsers: ['alice'], policy: () => { const config = read(); return { ...config.message, allowedUsers: config.allowedUsers, sessionMode: config.sessionMode, sessionModeEpoch: config.sessionModeEpoch }; }, stateFile,
    transport: { reply, send: async () => {} }, core: { trigger, result: async () => ({ ok: true, state: running ? 'running' : 'completed', output: { content: 'answer' } }), interrupt } });
  const change = (group: 'user' | 'chat') => service.patch(id, { revision: service.get(id).revision, sessionMode: mode(group) });
  return { service, id, read, trigger, interrupt, reply, create, change, finish: () => { running = false; }, state: () => JSON.parse(readFileSync(stateFile, 'utf8')) };
}
describe('WeCom native session-mode switches with in-flight routes', () => {
  it('lets each original actor stop their own in-flight per-user task after switching to shared mode', async () => {
    const f = fixture(), bridge = f.create(); await bridge.receive(message('alice-task')); await bridge.receive(message('bob-task', 'bob')); await bridge.tick();
    expect(f.trigger).toHaveBeenCalledTimes(2); await f.change('chat');
    await bridge.receive(message('stop-bob', 'bob', '/stop'));
    expect(f.interrupt).toHaveBeenCalledWith('sid-2', 'turn-bob-task');
    expect(f.interrupt).not.toHaveBeenCalledWith('sid-1', 'turn-alice-task');
  });
  it('keeps an old admitted route through a mode change and creates one shared route only after it settles', async () => {
    const f = fixture(), bridge = f.create(); await bridge.receive(message('old-user-task')); await bridge.tick(); await f.change('chat');
    await bridge.receive(message('busy-shared', 'bob')); await bridge.tick(); expect(f.trigger).toHaveBeenCalledTimes(1);
    f.finish(); await bridge.tick(); await bridge.receive(message('new-shared', 'bob')); await bridge.tick();
    expect(f.trigger.mock.calls[1][0].target.sessionId).toBeUndefined();
    await bridge.receive(message('shared-continuation', 'charlie')); await bridge.tick();
    expect(f.trigger.mock.calls[2][0].target.sessionId).toBe('sid-2');
    await f.create().receive(message('new-shared', 'bob')); await f.create().tick(); expect(f.trigger).toHaveBeenCalledTimes(3);
    const epoch = f.read().sessionModeEpoch; await f.change('user'); expect(f.read().sessionModeEpoch).not.toBe(epoch);
    await f.create().receive(message('new-per-user', 'alice')); await f.create().tick(); expect(f.trigger.mock.calls[3][0].target.sessionId).toBeUndefined();
  });
  it('rejects unsupported p2p group creation without changing the configuration', async () => {
    const f = fixture(), before = f.read();
    await expect(f.service.patch(f.id, { revision: f.service.get(f.id).revision, sessionMode: { ...mode('chat'), p2pMode: 'group' } })).rejects.toThrow('wecom_invalid_configuration');
    expect(f.read()).toEqual(before);
  });
});
