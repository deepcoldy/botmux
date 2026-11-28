import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseWecomConfig } from '../src/im/wecom/gateway/command.js';
import { WecomBridge, type WecomCore } from '../src/im/wecom/gateway/bridge.js';
import { WecomHttpCore } from '../src/im/wecom/gateway/core-client.js';
import { splitWecomText } from '../src/im/wecom/gateway/text-chunks.js';
import type { WecomInboundMessage } from '../src/im/wecom/protocol/types.js';
import type { TriggerRequest } from '../src/services/trigger-types.js';
import { blockWecomStateWrites } from './helpers/wecom-state-writes.js';
const directories: string[] = [];
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'wecom-bridge-')); directories.push(dir);
  const stateFile = join(dir, 'state.json');
  const transport = { reply: vi.fn(async (_message: WecomInboundMessage, _text: string, _options?: {streamId?: string; finish?: boolean}) => {}), send: vi.fn(async (_conversationId: string, _text: string) => {}) };
  let counter = 0;
  const core: WecomCore = {
    trigger: vi.fn(async (_request: TriggerRequest) => ({ ok: true, triggerId: `t${++counter}`, target: { kind: 'turn', sessionId: `s${counter}` } })),
    result: vi.fn(async () => ({ ok: true, state: 'completed', output: { content: 'answer' } })),
    interrupt: vi.fn(async () => {}),
  };
  const create = (allowedUsers = ['alice', 'bob']) => new WecomBridge({ botId: 'bot', stateFile, allowedUsers, transport, core });
  return { create, core, transport, stateFile };
}
function message(messageId: string, userId = 'alice', text = 'hello'): WecomInboundMessage {
  return { messageId, userId, conversationId: 'group', chatType: 'group', text, attachments: [], replyContext: { requestId: `req-${messageId}` } };
}
describe('企微持久文字桥接', () => {
  it('按真实用户隔离续聊并抑制跨重启入站重投', async () => {
    const f = fixture(); let bridge = f.create();
    await bridge.receive(message('1')); await bridge.tick();
    bridge = f.create();
    await bridge.receive(message('1')); await bridge.tick();
    expect(f.core.trigger).toHaveBeenCalledTimes(1);
    await bridge.receive(message('2')); await bridge.tick();
    expect(vi.mocked(f.core.trigger).mock.calls[1][0].target.sessionId).toBe('s1');
    expect(vi.mocked(f.core.trigger).mock.calls[1][0].options?.turnIdempotencyKey).toBeTruthy();
    await bridge.receive(message('3', 'bob')); await bridge.tick();
    expect(vi.mocked(f.core.trigger).mock.calls[2][0].target.sessionId).toBeUndefined();
  });
  it('未授权消息和附件都不能派发，撤销ACL后隔离恢复任务', async () => {
    const f = fixture(); const bridge = f.create();
    await bridge.receive(message('u', 'mallory'));
    await bridge.receive({ ...message('image'), attachments: [{ type: 'image', url: 'https://example.invalid/image' }] });
    await bridge.tick(); expect(f.core.trigger).not.toHaveBeenCalled();
    await bridge.receive(message('1'));
    await f.create(['bob']).tick(); expect(f.core.trigger).not.toHaveBeenCalled();
    await f.create().tick(); expect(f.core.trigger).not.toHaveBeenCalled();
  });
  it('首次派发前停止已落盘任务，重启也不执行', async () => {
    const f = fixture(); const bridge = f.create();
    await bridge.receive(message('1'));
    await bridge.receive(message('stop', 'alice', '/stop'));
    await f.create().tick();
    expect(f.core.trigger).not.toHaveBeenCalled();
    expect(f.transport.reply).toHaveBeenLastCalledWith(expect.objectContaining({ messageId: '1' }), expect.any(String), expect.objectContaining({ finish: true }));
  });
  it('托管core的持久身份改变时拒绝把旧任务带到新core', async () => {
    const f = fixture();
    const create = (coreIdentity: string) => new WecomBridge({ botId: 'bot', allowedUsers: ['alice'], stateFile: f.stateFile, core: f.core, transport: f.transport, coreIdentity });
    await create('core-A').receive(message('1'));
    expect(() => create('core-B')).toThrow(/不属于当前专用 core/);
    expect(f.core.trigger).not.toHaveBeenCalled();
    await create('core-A').tick(); expect(f.core.trigger).toHaveBeenCalledTimes(1);
  });
  it('身份验证码即使在授权成功后被重投，也不作为CLI任务执行', async () => {
    const f = fixture(); const bridge = f.create();
    await bridge.receive(message('verified-code-replay', 'alice', `BOTMUX-ID-${'A'.repeat(32)}`));
    await bridge.tick(); expect(f.core.trigger).not.toHaveBeenCalled();
    expect(Object.keys(JSON.parse(readFileSync(f.stateFile, 'utf8')).tasks)).toHaveLength(0);
  });
  it('HTTP响应丢失后重启重用完全相同的幂等请求', async () => {
    const f = fixture(); const bridge = f.create();
    vi.mocked(f.core.trigger).mockRejectedValueOnce(new Error('lost response'));
    await bridge.receive(message('1')); await bridge.tick();
    await f.create().tick();
    const requests = vi.mocked(f.core.trigger).mock.calls.map(call => call[0]);
    expect(requests).toHaveLength(2); expect(requests[1]).toEqual(requests[0]);
    expect(requests[0].options?.idempotencyKey).toBeTruthy();
  });
  it('结束同一流；旧回调失败时主动投递，失败后重启只重试结果', async () => {
    const f = fixture(); const bridge = f.create();
    await bridge.receive(message('1'));
    const initialOptions = f.transport.reply.mock.calls[0][2];
    f.transport.reply.mockRejectedValue(new Error('expired')); f.transport.send.mockRejectedValueOnce(new Error('offline'));
    await bridge.tick();
    expect(f.transport.reply).toHaveBeenCalledWith(expect.anything(), 'answer', { streamId: initialOptions?.streamId, finish: true });
    await f.create().tick();
    expect(f.core.trigger).toHaveBeenCalledTimes(1); expect(f.core.result).toHaveBeenCalledTimes(1);
    // The group fallback names the requester ahead of the answer it carries.
    expect(f.transport.send).toHaveBeenLastCalledWith('group', expect.stringMatching(/alice[\s\S]*answer$/));
    await f.create().tick(); expect(f.transport.send).toHaveBeenCalledTimes(2);
  });
  it('单条任务故障不阻塞其他用户，周期重入不会重复派发', async () => {
    const f = fixture(); const bridge = f.create();
    vi.mocked(f.core.trigger).mockRejectedValueOnce(new Error('alice offline'));
    await bridge.receive(message('1')); await bridge.receive(message('2', 'bob'));
    await bridge.tick();
    expect(f.transport.reply).toHaveBeenCalledWith(expect.objectContaining({ userId: 'bob' }), 'answer', expect.objectContaining({ finish: true }));
    await Promise.all([bridge.tick(), bridge.tick()]);
    expect(f.core.trigger).toHaveBeenCalledTimes(3);
    expect(Object.values(JSON.parse(readFileSync(f.stateFile, 'utf8')).tasks).every((task: any) => task.delivered)).toBe(true);
  });
  it('运行中的停止精确定位trigger，restart不能越过活动任务', async () => {
    const f = fixture(); const bridge = f.create();
    vi.mocked(f.core.result).mockResolvedValue({ ok: true, state: 'running' });
    await bridge.receive(message('1')); await bridge.tick();
    await bridge.receive(message('stop', 'alice', '/stop'));
    expect(f.core.interrupt).toHaveBeenCalledWith('s1', 't1');
    await bridge.receive(message('restart', 'alice', '/restart'));
    await bridge.receive(message('2')); await bridge.tick();
    expect(f.core.trigger).toHaveBeenCalledTimes(1);
  });
});
describe('企微配置与长结果', () => {
  it('配置要求真实userid和凭据环境变量，并拒绝远程core', () => {
    const valid = { botId: 'bot', secretEnv: 'WECOM_SECRET', allowedUsers: ['alice'], coreUrl: 'http://127.0.0.1:12345' };
    expect(parseWecomConfig(valid)).toEqual(valid);
    expect(() => parseWecomConfig({ ...valid, allowedUsers: ['*'] })).toThrow(/allowedUsers/);
    expect(() => parseWecomConfig({ ...valid, allowedUsers: [] })).toThrow(/allowedUsers/);
    expect(() => parseWecomConfig({ ...valid, coreUrl: 'http://example.com' })).toThrow(/coreUrl/);
  });
  // Mutation: dropping the try around `new URL` in validateWecomCoreUrl lets a TypeError through and turns this red.
  it('refuses a coreUrl that is not a URL at all with the same error as any other unusable coreUrl', () => {
    const valid = { botId: 'bot', secretEnv: 'WECOM_SECRET', allowedUsers: ['alice'], coreUrl: 'http://127.0.0.1:12345' };
    const managedCore = { cli: 'codex', backend: 'pty', port: 12345, botId: 'local_bot', workingDirectory: '/srv/work', stateDir: '/srv/core' };
    const errorOf = (run: () => unknown): Error => {
      try {
        run();
      } catch (error) {
        return error as Error;
      }
      throw new Error('accepted');
    };
    const remote = errorOf(() => parseWecomConfig({ ...valid, coreUrl: 'http://example.com' }));
    for (const coreUrl of ['not a url', 'http://', '127.0.0.1:12345']) {
      for (const config of [{ ...valid, coreUrl }, { ...valid, coreUrl, managedCore }]) {
        const error = errorOf(() => parseWecomConfig(config));
        expect(error, coreUrl).not.toBeInstanceOf(TypeError);
        expect(error.message, coreUrl).toBe(remote.message);
      }
      expect(errorOf(() => new WecomHttpCore(coreUrl)).message, coreUrl).toBe(remote.message);
    }
    // Valid values parse as before, the managed core's port still checked against the coreUrl's.
    expect(parseWecomConfig({ ...valid, managedCore })).toEqual({ ...valid, managedCore });
    expect(parseWecomConfig({ ...valid, coreUrl: 'http://127.0.0.1', managedCore: { ...managedCore, port: 80 } }).coreUrl).toBe('http://127.0.0.1');
    expect(() => parseWecomConfig({ ...valid, managedCore: { ...managedCore, port: 12346 } })).toThrow(/托管 core 配置无效/);
  });
  it('UTF8分片保持字符完整，并在投递一半失败后从确认位置恢复', async () => {
    const content = '文字🙂'.repeat(7000);
    const parts = splitWecomText(content);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every(part => Buffer.byteLength(part) <= 4096)).toBe(true);
    expect(parts.map(part => part.replace(/^\[\d+\/\d+\]\n/, '')).join('')).toBe(content);
    const f = fixture();
    vi.mocked(f.core.result).mockResolvedValue({ ok: true, state: 'completed', output: { content } });
    const bridge = f.create(); await bridge.receive(message('1'));
    f.transport.reply.mockRejectedValue(new Error('stream expired'));
    f.transport.send.mockResolvedValueOnce().mockRejectedValueOnce(new Error('offline'));
    await bridge.tick();
    await f.create().tick();
    // One send per part, in order, resuming at the part whose send failed; each names the requester ahead of its part.
    const resent = [parts[0], parts[1], ...parts.slice(1)];
    const sent = f.transport.send.mock.calls.map(call => String(call[1]));
    expect(sent.map((text, i) => text.endsWith(resent[i]!) && text.slice(0, -resent[i]!.length).includes('alice'))).toEqual(resent.map(() => true));
    expect(f.core.result).toHaveBeenCalledTimes(1);
  });
  it('派发响应丢失后停止，恢复原任务标识再中断', async () => {
    const f = fixture(); const bridge = f.create();
    vi.mocked(f.core.trigger).mockRejectedValueOnce(new Error('response lost'));
    await bridge.receive(message('1')); await bridge.tick();
    await bridge.receive(message('stop', 'alice', '/stop'));
    await f.create().tick();
    expect(f.core.interrupt).toHaveBeenCalledWith('s1', 't1');
    expect(vi.mocked(f.core.trigger).mock.calls[1][0]).toEqual(vi.mocked(f.core.trigger).mock.calls[0][0]);
  });
});
describe('企微core HTTP边界', () => {
  it('只允许本机独立服务，503可重试且精确查询turn', async () => {
    expect(() => new WecomHttpCore('https://example.com')).toThrow(/coreUrl/);
    const request = vi.fn().mockResolvedValueOnce(new Response('{}', { status: 503 }))
      .mockResolvedValue(new Response(JSON.stringify({ ok: true, state: 'running' })));
    const core = new WecomHttpCore('http://127.0.0.1:12345', request);
    await expect(core.result('s/1', 't?1')).rejects.toThrow('503');
    await core.result('s/1', 't?1');
    expect(request.mock.calls[1][0]).toBe('http://127.0.0.1:12345/api/sessions/s%2F1/trigger-result?triggerId=t%3F1');
  });
});

describe('企微宿主管理串行状态owner', () => {
  it('关闭先解除路由，重复请求不重复关闭，下一消息创建新会话', async () => {
    const f = fixture(); const bridge = f.create();
    await bridge.receive(message('1')); await bridge.tick();
    const action = vi.fn(async () => ({ ok: true }));
    const request = { sessionId: 's1', operation: 'close' as const, requestId: 'close-1', expectedGeneration: 't1' };
    expect(await bridge.controlSession(request, action)).toEqual({ ok: true, status: 'completed' });
    expect(await f.create().controlSession(request, action)).toEqual({ ok: true, status: 'completed' });
    expect(action).toHaveBeenCalledTimes(1);
    await f.create().receive(message('2')); await f.create().tick();
    expect(vi.mocked(f.core.trigger).mock.calls[1][0].target.sessionId).toBeUndefined();
  });
  it('暂停和恢复保留上下文，暂停期间不接纳新任务', async () => {
    const f = fixture(); const bridge = f.create(); await bridge.receive(message('1')); await bridge.tick();
    const action = vi.fn(async () => ({ ok: true }));
    await bridge.controlSession({ sessionId: 's1', operation: 'suspend', requestId: 'suspend' }, action);
    await bridge.receive(message('2')); await bridge.tick();
    expect(f.core.trigger).toHaveBeenCalledTimes(1);
    await bridge.controlSession({ sessionId: 's1', operation: 'resume', requestId: 'resume' }, action);
    await bridge.receive(message('3')); await bridge.tick();
    expect(vi.mocked(f.core.trigger).mock.calls[1][0].target.sessionId).toBe('s1');
  });
  it('长结果查询中关闭抑制旧结果并且不复活旧路由', async () => {
    const f = fixture(); let release!: (value: { ok: true; state: 'completed'; output: { content: string } }) => void;
    vi.mocked(f.core.result).mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const bridge = f.create(); await bridge.receive(message('1')); const tick = bridge.tick();
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    const close = bridge.controlSession({ sessionId: 's1', operation: 'close', requestId: 'close' }, async () => ({ ok: true }));
    release({ ok: true, state: 'completed', output: { content: 'should-not-deliver' } });
    await tick; await close;
    expect(f.transport.reply.mock.calls.some(call => call[1] === 'should-not-deliver')).toBe(false);
    await bridge.receive(message('2')); await bridge.tick();
    expect(vi.mocked(f.core.trigger).mock.calls[1][0].target.sessionId).toBeUndefined();
  });
  it('core控制失败不重放且旧会话保持隔离', async () => {
    const f = fixture(); const bridge = f.create(); await bridge.receive(message('1')); await bridge.tick();
    const action = vi.fn(async () => { throw new Error('ambiguous'); });
    const request = { sessionId: 's1', operation: 'restart' as const, requestId: 'restart' };
    expect(await bridge.controlSession(request, action)).toEqual({ ok: false, status: 'uncertain' });
    const restored = f.create(); await restored.controlSession(request, action);
    await restored.receive(message('2')); await restored.tick();
    expect(action).toHaveBeenCalledTimes(1); expect(f.core.trigger).toHaveBeenCalledTimes(1);
  });
  it('拒绝非owner会话、过时代次和处理中重启', async () => {
    const f = fixture(); const bridge = f.create(); const action = vi.fn(async () => ({ ok: true }));
    await expect(bridge.controlSession({ sessionId: 'foreign', operation: 'close', requestId: 'x' }, action)).rejects.toThrow('session_not_owned');
    await bridge.receive(message('1'));
    vi.mocked(f.core.result).mockResolvedValue({ ok: true, state: 'running' }); await bridge.tick();
    await expect(bridge.controlSession({ sessionId: 's1', operation: 'close', requestId: 'y', expectedGeneration: 'old' }, action)).rejects.toThrow('stale_generation');
    await expect(bridge.controlSession({ sessionId: 's1', operation: 'restart', requestId: 'z' }, action)).rejects.toThrow('session_busy');
    expect(action).not.toHaveBeenCalled();
  });
});


describe('企微宿主管理崩溃窗口', () => {
  it('core成功后状态落盘失败，重启仍保持旧route隔离且不重放core动作', async () => {
    const f = fixture(); const bridge = f.create(); await bridge.receive(message('1')); await bridge.tick();
    let unblock = () => {};
    const action = vi.fn(async () => { unblock = blockWecomStateWrites(f.stateFile); return { ok: true }; });
    const request = { sessionId: 's1', operation: 'close' as const, requestId: 'close-disk' };
    await expect(bridge.controlSession(request, action)).rejects.toMatchObject({ code: 'EISDIR' });
    unblock();
    const restored = f.create();
    expect(await restored.controlSession(request, action)).toEqual({ ok: false, status: 'uncertain' });
    await restored.receive(message('2')); await restored.tick();
    expect(action).toHaveBeenCalledTimes(1);
    expect(vi.mocked(f.core.trigger).mock.calls[1][0].target.sessionId).toBeUndefined();
  });
  it('管理RPC等待期间暂停入站，完成重启后仍续聊原sid', async () => {
    const f = fixture(); const bridge = f.create(); await bridge.receive(message('1')); await bridge.tick();
    let release!: (result: { ok: boolean }) => void;
    const action = vi.fn(() => new Promise<{ ok: boolean }>(resolve => { release = resolve; }));
    const restart = bridge.controlSession({ sessionId: 's1', operation: 'restart', requestId: 'restart-wait' }, action);
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    // Simulate process death while the RPC is outstanding, using the committed state.
    const recovered = f.create(); await recovered.receive(message('2')); await recovered.tick();
    expect(f.core.trigger).toHaveBeenCalledTimes(1);
    release({ ok: true }); await restart;
    await bridge.receive(message('3')); await bridge.tick();
    expect(vi.mocked(f.core.trigger).mock.calls[1][0].target.sessionId).toBe('s1');
  });
});


describe('企微管理与续聊派发交叠', () => {
  it('续聊trigger未返回时关闭仍隔离冻结目标，回包不能复活旧sid', async () => {
    const f = fixture(); const bridge = f.create(); await bridge.receive(message('1')); await bridge.tick();
    let release!: (response: { ok: true; triggerId: string; target: { kind: 'turn'; sessionId: string } }) => void;
    vi.mocked(f.core.trigger).mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    await bridge.receive(message('2')); const tick = bridge.tick();
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    const action = vi.fn(async () => ({ ok: true }));
    await expect(bridge.controlSession({ sessionId: 's1', operation: 'restart', requestId: 'busy' }, action)).rejects.toThrow('session_busy');
    const close = bridge.controlSession({ sessionId: 's1', operation: 'close', requestId: 'close-pending', expectedGeneration: 't1' }, action);
    release({ ok: true, triggerId: 'continuation', target: { kind: 'turn', sessionId: 's1' } });
    await tick; await close;
    expect(f.core.result).toHaveBeenCalledTimes(1);
    await bridge.receive(message('3')); await bridge.tick();
    expect(vi.mocked(f.core.trigger).mock.calls[2][0].target.sessionId).toBeUndefined();
  });
});
