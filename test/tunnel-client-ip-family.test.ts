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

const CONTROL_DIAL_PARALLEL = 3;

function makeOpts(ipFamily?: 4 | 6) {
  return {
    binding: { platformUrl: 'https://platform.test', machineId: 'm-1', machineToken: 'tok', ipFamily },
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
    expect(FakeWebSocket.instances).toHaveLength(CONTROL_DIAL_PARALLEL);
    for (const inst of FakeWebSocket.instances) {
      expect(inst.opts.family).toBeUndefined();
    }
    handle.stop();
  });

  it('建连期 close 会计为失败并重连，重连时仍然不传 family', async () => {
    const handle = startPlatformTunnelClient(makeOpts());
    const inst = FakeWebSocket.instances;
    for (const sock of inst.slice(0, CONTROL_DIAL_PARALLEL)) {
      sock.emit('close');
    }
    await vi.advanceTimersByTimeAsync(1000);
    expect(inst).toHaveLength(CONTROL_DIAL_PARALLEL * 2);
    for (const sock of inst) {
      expect(sock.opts.family).toBeUndefined();
    }
    handle.stop();
  });

  it('数据流也不传 family', async () => {
    const handle = startPlatformTunnelClient(makeOpts());
    const inst = FakeWebSocket.instances;
    inst[0]!.readyState = FakeWebSocket.OPEN;
    inst[0]!.emit('open');
    inst[0]!.emit('message', JSON.stringify({ type: 'open-stream', streamId: 's-1' }));
    const dataDials = inst.slice(CONTROL_DIAL_PARALLEL);
    expect(dataDials.length).toBeGreaterThan(0);
    for (const d of dataDials) {
      expect(d.opts.family).toBeUndefined();
    }
    handle.stop();
  });

  it('绑定文件里有 ipFamily 也不影响（隧道忽略该字段）', () => {
    const handle = startPlatformTunnelClient(makeOpts(4));
    for (const inst of FakeWebSocket.instances) {
      expect(inst.opts.family).toBeUndefined();
    }
    handle.stop();
  });
});
