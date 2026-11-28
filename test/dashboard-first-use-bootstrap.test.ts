import { describe, expect, it, vi } from 'vitest';
import { executeDashboardWithFirstUseBootstrap } from '../src/cli/dashboard-bootstrap.js';
import type { DashboardResult } from '../src/cli/dashboard-endpoint.js';

/** Host processes are visible (not a PID-namespace sandbox) unless a test says otherwise. */
const onHost = { hostProcessesHidden: () => false };

describe('首次未配置机器人的 Dashboard 启动', () => {
  it('正常supervisor启动后等待端点就绪，再使用既有鉴权接口创建登录链接', async () => {
    const start = vi.fn(async () => {});
    const endpoint = vi.fn<(...args: any[]) => Promise<DashboardResult>>()
      .mockResolvedValueOnce({ ok: false, reason: 'no-secret' })
      .mockResolvedValueOnce({ ok: false, reason: 'unreachable' })
      .mockResolvedValueOnce({ ok: false, reason: 'no-active-token' })
      .mockResolvedValueOnce({ ok: false, reason: 'no-active-token' })
      .mockResolvedValue({ ok: true, url: 'http://127.0.0.1:7891/?t=synthetic-token' });
    let clock = 0;
    const result = await executeDashboardWithFirstUseBootstrap([], endpoint, async () => null, {
      ...onHost, hasConfig: () => false, start, now: () => clock, sleep: async ms => { clock += ms; },
    });
    expect(start).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ kind: 'endpoint', result: { ok: true } });
    expect(endpoint.mock.calls.some(call => call[0] === '/__cli/ensure')).toBe(true);
    expect(endpoint.mock.calls[1]).toEqual(['/__cli/current']);
  });
  it.each([true, false])('已有可用面板不重复启动（配置存在=%s）', async hasConfig => {
    const start = vi.fn();
    await executeDashboardWithFirstUseBootstrap([], async () => ({ ok: true, url: 'http://dashboard.test' }), async () => null, { ...onHost, hasConfig: () => hasConfig, start });
    expect(start).not.toHaveBeenCalled();
  });
  it.each(['no-secret', 'unreachable'] as const)('已有机器人配置时保持原错误，不绕过正常fleet启动校验：%s', async reason => {
    const start = vi.fn();
    let clock = 0;
    const result = await executeDashboardWithFirstUseBootstrap([], async () => ({ ok: false, reason }), async () => null, {
      ...onHost, hasConfig: () => true, start, now: () => clock, sleep: async ms => { clock += ms; },
    });
    expect(start).not.toHaveBeenCalled();
    expect(result).toMatchObject({ kind: 'endpoint', result: { ok: false, reason } });
  });
  it.each(['auth-failed', 'wrong-service', 'http-error'] as const)('不因%s启动第二个服务或绕开鉴权', async reason => {
    const start = vi.fn();
    const result = await executeDashboardWithFirstUseBootstrap([], async () => ({ ok: false, reason }), async () => null, { ...onHost, hasConfig: () => false, start });
    expect(start).not.toHaveBeenCalled();
    expect(result).toMatchObject({ kind: 'endpoint', result: { ok: false, reason } });
  });
  it.each(['no-secret', 'unreachable'] as const)('看不到宿主进程的沙箱里未配置主机也不启动 supervisor，保持原失败：%s', async reason => {
    const start = vi.fn(async () => {});
    const endpoint = vi.fn(async (): Promise<DashboardResult> => ({ ok: false, reason }));
    let clock = 0;
    const result = await executeDashboardWithFirstUseBootstrap([], endpoint, async () => null, {
      hasConfig: () => false,
      hostProcessesHidden: () => true,
      start,
      now: () => clock,
      sleep: async ms => { clock += ms; },
    });
    expect(start).not.toHaveBeenCalled();
    expect(result).toMatchObject({ kind: 'endpoint', result: { ok: false, reason } });
  });
  it.each([{ args: ['--help'] }, { args: ['bogus'] }])('帮助/非法参数不启动服务：$args', async ({ args }) => {
    const start = vi.fn(); const endpoint = vi.fn();
    await executeDashboardWithFirstUseBootstrap(args, endpoint, async () => null, { ...onHost, hasConfig: () => false, start });
    expect(start).not.toHaveBeenCalled(); expect(endpoint).not.toHaveBeenCalled();
  });
  it('启动失败原样抛出，并对永远不就绪的服务有限等待', async () => {
    const endpoint = async (): Promise<DashboardResult> => ({ ok: false, reason: 'no-secret' });
    await expect(executeDashboardWithFirstUseBootstrap([], endpoint, async () => null, { ...onHost, hasConfig: () => false, start: async () => { throw new Error('spawn failed'); } })).rejects.toThrow('spawn failed');
    let clock = 0;
    const result = await executeDashboardWithFirstUseBootstrap([], endpoint, async () => null, {
      ...onHost, hasConfig: () => false, start: async () => {}, now: () => clock, sleep: async ms => { clock += ms; },
    });
    expect(result).toMatchObject({ kind: 'endpoint', result: { ok: false } });
    expect(clock).toBeGreaterThan(0);
  });
});
