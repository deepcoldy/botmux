import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// 源码结构护栏(K3)：worker 两处 spawn 路径把机器级开关投影进 pane env 的接线
// （Object.assign(mergedEnv/childEnv, paneSwitchEnv(...))）在 spawnCli 闭包里，
// 没有 spawn 级 seam；删掉任一行不会红任何行为测试，但会让 file-sandboxed CLI
// 读不到 ~/.botmux/config.json 时静默判「关」→ attemptAt 不写 → 卡片新鲜度判定
// (reportIsCurrent) 失效（--into 重派后旧「已完成」盖新任务）。映射逻辑本身由
// paneSwitchEnv 单测覆盖（global-config.test.ts），这里守的是「接线还在」。
describe('worker pane-switch env wiring (K3)', () => {
  const readWorker = (): string =>
    readFileSync(new URL('../src/worker.ts', import.meta.url), 'utf8');

  it('applies paneSwitchEnv at both spawn env assembly sites, exactly once each', () => {
    const worker = readWorker();
    // Any argument is tolerated (paneSwitchEnv(env) and the default-process
    // form are semantically identical); pinning the bare call shape would
    // redden harmless refactors. What matters is that BOTH env objects get it.
    const matches = worker
      .match(/Object\.assign\(\s*(?:mergedEnv|childEnv)\s*,\s*paneSwitchEnv\([^)]*\)\s*\)/g)
      ?? [];
    expect(matches).toHaveLength(2);
    expect(worker).toContain('Object.assign(mergedEnv, paneSwitchEnv()');
    expect(worker).toContain('Object.assign(childEnv, paneSwitchEnv()');

    // The switches must reach panes only via the single projection; a per-key
    // literal assignment would drift from the readers and silently drop the
    // card switch when the projection list changes.
    expect(worker).not.toContain('BOTMUX_DISPATCH_TASK_TREE_CARD_ENABLED = ');
    expect(worker).not.toContain('BOTMUX_DISPATCH_TASK_TREE_CARD_ENABLED=');
  });
});
