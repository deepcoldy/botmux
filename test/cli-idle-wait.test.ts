/**
 * runtime 级联的等待原语（core/cli-idle-wait.ts）：只读 ds 上 worker 上报的两样证据。
 * Run: bun run vitest run test/cli-idle-wait.test.ts
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { __testOnly_setCascadeTiming, waitForCliIdle, waitForCommandSettled, type CliIdleView } from '../src/core/cli-idle-wait.js';

function view(over: Partial<CliIdleView> = {}): CliIdleView {
  return { worker: { killed: false }, cliReady: true, cliReadyGeneration: 1, lastScreenStatus: 'idle', ...over };
}
const tick = (ms: number) => new Promise(r => setTimeout(r, ms));

beforeEach(() => {
  __testOnly_setCascadeTiming({ idleTimeoutMs: 300, busyGraceMs: 60, pollMs: 5 });
});

describe('waitForCliIdle', () => {
  it('空闲立即返回；worker 没了返回 gone；一直忙返回 timeout', async () => {
    expect(await waitForCliIdle(view())).toBe('idle');
    expect(await waitForCliIdle(view({ worker: null }))).toBe('gone');
    expect(await waitForCliIdle(view({ lastScreenStatus: 'working' }))).toBe('timeout');
  });
  it('提示符从未就绪时等到 prompt_ready 才算空闲', async () => {
    const ds = view({ cliReady: false, cliReadyGeneration: 0 });
    const p = waitForCliIdle(ds);
    await tick(20);
    ds.cliReady = true; ds.cliReadyGeneration = 1;
    expect(await p).toBe('idle');
  });
  it('limited / stalled 立即返回 blocked，不白等上限；analyzing 算忙', async () => {
    expect(await waitForCliIdle(view({ lastScreenStatus: 'limited' }))).toBe('blocked');
    expect(await waitForCliIdle(view({ lastScreenStatus: 'stalled' }))).toBe('blocked');
    expect(await waitForCommandSettled(view({ lastScreenStatus: 'limited' }), 1)).toBe('blocked');
    expect(await waitForCliIdle(view({ lastScreenStatus: 'analyzing' }))).toBe('timeout');
  });
  it('屏幕从 working 回到 idle 即空闲；未知状态按空闲', async () => {
    const ds = view({ lastScreenStatus: 'working' });
    const p = waitForCliIdle(ds);
    await tick(20);
    ds.lastScreenStatus = 'idle';
    expect(await p).toBe('idle');
    expect(await waitForCliIdle(view({ lastScreenStatus: undefined }))).toBe('idle');
  });
});

describe('waitForCommandSettled', () => {
  it('发送后代际递增 → settled（这是 /compact 这类真忙命令的正常路径）', async () => {
    const ds = view({ cliReadyGeneration: 3 });
    const p = waitForCommandSettled(ds, 3);
    await tick(10); ds.lastScreenStatus = 'working';
    await tick(30); ds.cliReadyGeneration = 4; ds.lastScreenStatus = 'idle';
    expect(await p).toBe('settled');
  });
  it('宽限窗内既没忙也没新 prompt_ready → 视为瞬时命令已完成', async () => {
    const ds = view({ cliReadyGeneration: 3 });
    const t0 = Date.now();
    expect(await waitForCommandSettled(ds, 3)).toBe('settled');
    expect(Date.now() - t0).toBeGreaterThanOrEqual(50);
  });
  it('忙起来之后只靠屏幕回到 idle 也算 settled（prompt_ready 没来的兜底）', async () => {
    const ds = view({ cliReadyGeneration: 3, lastScreenStatus: 'working' });
    const p = waitForCommandSettled(ds, 3);
    await tick(20); ds.lastScreenStatus = 'idle';
    expect(await p).toBe('settled');
  });
  it('一直忙 → timeout；worker 没了 → gone', async () => {
    expect(await waitForCommandSettled(view({ lastScreenStatus: 'working' }), 1)).toBe('timeout');
    const ds = view({ lastScreenStatus: 'working' });
    const p = waitForCommandSettled(ds, 1);
    await tick(20); ds.worker = null;
    expect(await p).toBe('gone');
  });
});
