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
      .match(/Object\.assign\(\s*(mergedEnv|childEnv)\s*,\s*paneSwitchEnv\([^)]*\)\s*\)/g)
      ?? [];
    // Exactly two apply sites overall, one per env object — so a duplicate of
    // one (dropping the other) is caught even though the total is still 2.
    expect(matches).toHaveLength(2);
    expect(matches.filter(m => m.includes('mergedEnv'))).toHaveLength(1);
    expect(matches.filter(m => m.includes('childEnv'))).toHaveLength(1);
    // Each matched text must contain BOTH closing parens (the inner
    // paneSwitchEnv(...) call and the outer Object.assign(...)); allowing only
    // whitespace between them. An endsWith(')') check alone cannot do this — a
    // fragment truncated right after the inner call's paren also ends in ')'.
    expect(matches.every(m => /\)\s*\)$/.test(m.trim()))).toBe(true);
    // Presence check stops at the opening paren so paneSwitchEnv(process.env)
    // (an equivalent explicit-arg rewrite) stays green; the regex above still
    // requires the call to close and the two target env objects to be present.
    expect(worker).toContain('Object.assign(mergedEnv, paneSwitchEnv(');
    expect(worker).toContain('Object.assign(childEnv, paneSwitchEnv(');

    // The switches must reach panes only via the projection; forbid a real
    // per-key assignment statement of the `env.KEY =` form (not a comment that
    // merely mentions the variable). Known limit: an inline
    // `Object.assign(childEnv, { KEY: 'true' })` bypass is a different shape and
    // is NOT caught here — the projection call asserts above remain the guard
    // for that route.
    expect(worker).not.toMatch(
      /^\s*(?:mergedEnv|childEnv)\.BOTMUX_DISPATCH_TASK_TREE_CARD_ENABLED\s*=/m,
    );
  });
});
