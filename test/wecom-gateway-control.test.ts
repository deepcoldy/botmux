import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WecomBridge } from '../src/im/wecom/gateway/bridge.js';
import { startWecomGatewayControl } from '../src/im/wecom/gateway/gateway-control.js';
import { requestWecomSessionControl } from '../src/dashboard/wecom/gateway-control-client.js';
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
describe('企微网关本机控制鉴权', () => {
  it('全请求签名与实例绑定通过后才允许owner操作，错误secret/代次不可操作', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'wecom-control-'));
    cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
    const bridge = new WecomBridge({ botId: 'test', allowedUsers: ['user'], stateFile: join(directory, 'state.json'),
      transport: { reply: async () => {}, send: async () => {} },
      core: { trigger: async () => ({ ok: true, target: { kind: 'turn', sessionId: 'sid' }, triggerId: 'turn' }), result: async () => ({ ok: true, state: 'completed' }), interrupt: async () => {} } });
    await bridge.receive({ messageId: 'event', userId: 'user', conversationId: 'chat', chatType: 'single', text: 'test', attachments: [], replyContext: { requestId: 'event' } });
    await bridge.tick();
    const action = vi.fn(async () => ({ ok: true }));
    const server = await startWecomGatewayControl({ bridge, instanceId: 'instance', coreIdentity: 'core', secret: 'private-test-key', coreAction: action });
    cleanups.push(() => server.stop());
    const input = { port: server.port, instanceId: 'instance', coreIdentity: 'core', sessionId: 'sid', operation: 'close' as const, requestId: 'close', expectedGeneration: 'turn' };
    expect((await requestWecomSessionControl(input, 'wrong-key')).ok).toBe(false);
    expect((await requestWecomSessionControl({ ...input, instanceId: 'stale' }, 'private-test-key')).ok).toBe(false);
    expect((await requestWecomSessionControl({ ...input, coreIdentity: 'other' }, 'private-test-key')).ok).toBe(false);
    expect(action).not.toHaveBeenCalled();
    expect(await requestWecomSessionControl(input, 'private-test-key')).toEqual({ ok: true, status: 'completed' });
    expect(await requestWecomSessionControl(input, 'private-test-key')).toEqual({ ok: true, status: 'completed' });
    expect(action).toHaveBeenCalledTimes(1);
  });
});
