// 挂起前必须先把 transcript 桥里已就绪的 final_output drain + flush 出去。
//
// final_output（transcript 驱动）和 idle 的 screen_update（屏幕分析器驱动）是两个
// 互相独立的生产者，没有顺序保证。daemon 在 idle 边沿挂起时，这一轮的回复可能还躺在
// bridge 队列里：紧跟的 stopBridgeWatcher() 会 clearPending()，process.exit(0) 又会
// 掐断还没写出的 IPC —— 那条回复就此丢失。这条路对 deferred suspend、
// idle-worker-sweeper、host_overload_sweep 三条挂起路径都成立。
//
// ⚠️ 这是**接线测试，不是行为测试**。worker.ts 的 IPC handler 模块级副作用太重，
// 单测里无法独立驱动，所以按仓库既有惯例（见 worker-pipe-initial-screen-order.test.ts）
// 用源码断言钉住调用顺序与关键参数。它能挡住「顺序被改坏 / 参数被改回 / 兜底被删掉」，
// 挡不住「helper 内部逻辑写错但形状没变」—— 要覆盖后者需要把 flush helper 拆成可注入
// sendAndFlush/drain/timer 的独立模块，那是一次独立重构。
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const source = readFileSync(join(process.cwd(), 'src/worker.ts'), 'utf8');

const suspendCase = source.slice(
  source.indexOf("case 'suspend': {"),
  source.indexOf('process.exit(0);', source.indexOf("case 'suspend': {")),
);

const helper = source.slice(
  source.indexOf('async function flushBridgeOutputBeforeSuspend'),
  source.indexOf('const TRANSFER_DETACH_ACK_FLUSH_MS'),
);

describe("worker 'suspend' 前的输出 flush", () => {
  it('drains the transcript bridges before anything tears them down', () => {
    const flushIdx = suspendCase.indexOf('await flushBridgeOutputBeforeSuspend()');
    const stopBridgeIdx = suspendCase.indexOf('stopBridgeWatcher();');
    const destroyIdx = suspendCase.indexOf('backend?.destroySession');

    expect(flushIdx).toBeGreaterThan(-1);
    // stopBridgeWatcher() 会 bridgeQueue.clearPending()，drain 必须排在它前面。
    expect(stopBridgeIdx).toBeGreaterThan(flushIdx);
    // CLI 还活着的时候 drain，transcript 才是完整的。
    expect(destroyIdx).toBeGreaterThan(flushIdx);
    // 必须 await —— 漏掉 await 会让 process.exit(0) 直接越过整个 flush。
    expect(suspendCase).toContain('await flushBridgeOutputBeforeSuspend()');
  });

  it('covers both transcript bridges, with the codex one told not to signal idle', () => {
    // Claude 走 bridgeQueue，codex/grok/traex/pi/hermes/mtr 走 codexBridgeQueue。
    const claudeIdx = helper.indexOf('bridgeDrainAndMaybeEmit()');
    const codexIdx = helper.indexOf("codexBridgeDrainAndMaybeEmit({ signalIdle: false })");
    expect(claudeIdx).toBeGreaterThan(-1);
    // signalIdle:false 是精确断言：正在挂起的会话不该再制造一个 idle 信号。
    expect(codexIdx).toBeGreaterThan(-1);
  });

  it('puts the write barrier after both drains, not before', () => {
    const claudeIdx = helper.indexOf('bridgeDrainAndMaybeEmit()');
    const codexIdx = helper.indexOf('codexBridgeDrainAndMaybeEmit(');
    const barrierIdx = helper.indexOf("sendAndFlush({ type: 'suspend_ready'");

    expect(barrierIdx).toBeGreaterThan(-1);
    // 屏障排在 drain 之前就毫无意义 —— 它要保证的正是这两次 drain 发出的
    // final_output 已经落到管道上。
    expect(barrierIdx).toBeGreaterThan(claudeIdx);
    expect(barrierIdx).toBeGreaterThan(codexIdx);
  });

  it('bounds the barrier wait against the daemon kill backstop', () => {
    expect(helper).toContain('Promise.race');
    expect(helper).toContain('SUSPEND_OUTPUT_FLUSH_MS');
    // 预算必须留在 daemon 的 2s SIGTERM backstop 之内，且给后面的
    // destroySession + cleanup 留余量 —— 否则 flush 吃光预算、teardown 没跑完
    // 就被杀，backing session 和 CLI 留在那儿，挂起要回收的内存一点没回收。
    const budget = /const SUSPEND_OUTPUT_FLUSH_MS = (\d+)/.exec(source);
    expect(budget).not.toBeNull();
    expect(Number(budget![1])).toBeLessThan(2000);
  });

  it('isolates each drain so one broken transcript cannot block the suspend', () => {
    // 一个坏掉的 transcript 不能把会话钉在内存里 —— 挂起本身是内存回收手段。
    // 两个 drain 各自独立 try/catch：单个 `try`+`catch` 同时存在是挡不住
    // 「第一个 drain 抛异常带走第二个」的。
    const claudeGuarded = /try \{ bridgeDrainAndMaybeEmit\(\); \} catch/.test(helper);
    const codexGuarded = /try \{ codexBridgeDrainAndMaybeEmit\([^)]*\); \} catch/.test(helper);
    expect(claudeGuarded).toBe(true);
    expect(codexGuarded).toBe(true);
  });
});
