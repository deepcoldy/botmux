// test/tunnel-client-ip-family.test.ts
// 隧道客户端不再强制单协议族：WebSocket 构造始终不传 family，
// 让 Node 内置 happy-eyeballs 自动选最优路径（IPv4/IPv6 谁先到用谁）。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { FakeWebSocket } = vi.hoisted(() => {
  class FakeWebSocket {
    static OPEN = 1;
    static instances: FakeWebSocket[] = [];
    readyState = 0;
    url: string;
    opts: { family?: number };
    private listeners = new Map<string, Array<(...a: unknown[]) => void>>();
    constructor(url: string, opts: { family?: number }) {
      this.url = url;
      this.opts = opts || {};
      FakeWebSocket.instances.push(this);
    }
    on(ev: string, fn: (...a: unknown[]) => void): this {
      const arr = this.listeners.get(ev) || [];
      arr.push(fn);
      this.listeners.set(ev, arr);
      return this;
    }
    emit(ev: string, ...args: unknown[]): void {
      for (const fn of [...(this.listeners.get(ev) || [])]) fn(...args);
    }
    send(): void {}
    close(): void {}
    terminate(): void {}
  }
  return { FakeWebSocket };
});
vi.mock('ws', () => ({ WebSocket: FakeWebSocket, createWebSocketStream: vi.fn() }));

vi.mock('../src/platform/binding.js', () => ({
  setPlatformTeams: vi.fn(),
  clearPlatformBinding: vi.fn(),
}));

import { startPlatformTunnelClient } from '../src/platform/tunnel-client.js';

function makeOpts() {
  return {
    binding: { platformUrl: 'https://platform.test', machineId: 'm-1', machineToken: 'tok' },
    getDashboardPort: () => 7891,
    getDashboardToken: () => 'dt',
    getVersion: () => '0.0.0-test',
    log: vi.fn(),
  };
}

describe('tunnel-client 不强制协议族', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeWebSocket.instances.length = 0;
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('控制连接不传 family，让 happy-eyeballs 自动选路', () => {
    const handle = startPlatformTunnelClient(makeOpts());
    expect(FakeWebSocket.instances.length).toBeGreaterThan(0);
    for (const inst of FakeWebSocket.instances) {
      expect(inst.opts.family).toBeUndefined();
    }
    handle.stop();
  });

  it('重连时仍然不传 family', async () => {
    const handle = startPlatformTunnelClient(makeOpts());
    const inst = FakeWebSocket.instances;
    // 第一次拨号失败 → 触发重连
    inst[0].emit('close');
    await vi.advanceTimersByTimeAsync(2000);
    // 第二次拨号也不传 family
    expect(FakeWebSocket.instances.length).toBeGreaterThan(1);
    for (const s of FakeWebSocket.instances) {
      expect(s.opts.family).toBeUndefined();
    }
    handle.stop();
  });

  it('数据流也不传 family', async () => {
    const handle = startPlatformTunnelClient(makeOpts());
    const inst = FakeWebSocket.instances;
    // 让控制连接握手成功
    inst[0].readyState = FakeWebSocket.OPEN;
    inst[0].emit('open');
    // 平台下发 open-stream
    inst[0].emit('message', JSON.stringify({ type: 'open-stream', streamId: 's-1' }));
    const dataDials = FakeWebSocket.instances.slice(1);
    expect(dataDials.length).toBeGreaterThan(0);
    for (const d of dataDials) {
      expect(d.opts.family).toBeUndefined();
    }
    handle.stop();
  });

  it('绑定文件里有 ipFamily 也不影响（隧道忽略该字段）', () => {
    const opts = makeOpts();
    (opts.binding as Record<string, unknown>).ipFamily = 4;
    const handle = startPlatformTunnelClient(opts);
    for (const inst of FakeWebSocket.instances) {
      expect(inst.opts.family).toBeUndefined();
    }
    handle.stop();
  });
});
