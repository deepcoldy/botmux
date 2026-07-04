// test/tunnel-client-ip-family.test.ts
// 隧道客户端的协议族逻辑：绑定里的 ipFamily 透传给控制/数据连接；
// 连续连不上时隔次换协议族试探，换族连通即采纳并落盘为新默认。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { FakeWebSocket } = vi.hoisted(() => {
  // vi.hoisted 在模块 import 初始化前执行，引用不到 node:events —— 手写极简事件类
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

const setPlatformIpFamily = vi.fn();
vi.mock('../src/platform/binding.js', () => ({
  setPlatformTeams: vi.fn(),
  setPlatformIpFamily: (...a: unknown[]) => setPlatformIpFamily(...a),
  clearPlatformBinding: vi.fn(),
}));

import { startPlatformTunnelClient } from '../src/platform/tunnel-client.js';

function makeOpts(ipFamily?: 4 | 6) {
  return {
    binding: { platformUrl: 'https://platform.test', machineId: 'm-1', machineToken: 'tok', ipFamily },
    getDashboardPort: () => 7891,
    getDashboardToken: () => 'dt',
    getVersion: () => '0.0.0-test',
    log: vi.fn(),
  };
}

describe('tunnel-client 协议族', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeWebSocket.instances.length = 0;
    setPlatformIpFamily.mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('绑定里的 ipFamily 透传给控制连接', () => {
    const handle = startPlatformTunnelClient(makeOpts(6));
    expect(FakeWebSocket.instances[0].opts.family).toBe(6);
    handle.stop();
  });

  it('连续 3 次连不上后隔次换协议族；换族连通即落盘并用于数据流', async () => {
    const handle = startPlatformTunnelClient(makeOpts());
    const inst = FakeWebSocket.instances;
    // 前 3 次按默认协议族拨，全部连不上（close 且从未 open）
    for (let i = 0; i < 3; i++) {
      expect(inst[i].opts.family).toBeUndefined();
      inst[i].emit('close');
      await vi.advanceTimersByTimeAsync(1000 * 2 ** i); // 重连退避 1s/2s/4s
    }
    // 第 4 次：换 IPv6 试探
    expect(inst.length).toBe(4);
    expect(inst[3].opts.family).toBe(6);
    inst[3].readyState = FakeWebSocket.OPEN;
    inst[3].emit('open');
    expect(setPlatformIpFamily).toHaveBeenCalledWith(6);
    // 数据流跟随已采纳的协议族
    inst[3].emit('message', JSON.stringify({ type: 'open-stream', streamId: 's-1' }));
    const dials = inst.slice(4);
    expect(dials.length).toBeGreaterThan(0);
    expect(dials.every((d) => d.opts.family === 6)).toBe(true);
    handle.stop();
  });

  it('已固定 IPv6 但连不上时，试探切回 IPv4', async () => {
    const handle = startPlatformTunnelClient(makeOpts(6));
    const inst = FakeWebSocket.instances;
    for (let i = 0; i < 3; i++) {
      expect(inst[i].opts.family).toBe(6);
      inst[i].emit('close');
      await vi.advanceTimersByTimeAsync(1000 * 2 ** i);
    }
    expect(inst[3].opts.family).toBe(4);
    inst[3].readyState = FakeWebSocket.OPEN;
    inst[3].emit('open');
    expect(setPlatformIpFamily).toHaveBeenCalledWith(4);
    handle.stop();
  });

  it('连上后正常掉线不计入失败，不触发换族', async () => {
    const handle = startPlatformTunnelClient(makeOpts());
    const inst = FakeWebSocket.instances;
    for (let i = 0; i < 5; i++) {
      inst[i].readyState = FakeWebSocket.OPEN;
      inst[i].emit('open'); // 每次都连得上
      inst[i].emit('close'); // 然后掉线
      await vi.advanceTimersByTimeAsync(1000); // 连上过 → 退避回到最小 1s
    }
    expect(inst.every((s) => s.opts.family === undefined)).toBe(true);
    expect(setPlatformIpFamily).not.toHaveBeenCalled();
    handle.stop();
  });
});
