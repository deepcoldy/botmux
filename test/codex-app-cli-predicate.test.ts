import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isCodexAppCliId, isCodexFamilyCliId } from '../src/adapters/cli/types.js';

const read = (rel: string): string => readFileSync(resolve(__dirname, '..', rel), 'utf8');

describe('isCodexAppCliId / isCodexFamilyCliId', () => {
  it('only recognizes the codex-app id (and tolerates absent ids)', () => {
    expect(isCodexAppCliId('codex-app')).toBe(true);
    expect(isCodexAppCliId('codex')).toBe(false);
    expect(isCodexAppCliId('claude-code')).toBe(false);
    expect(isCodexAppCliId(undefined)).toBe(false);
    expect(isCodexAppCliId(null)).toBe(false);
  });

  it('codex family = codex + codex-app, nothing else (traex shares the rollout shape but not CODEX_HOME)', () => {
    expect(isCodexFamilyCliId('codex')).toBe(true);
    expect(isCodexFamilyCliId('codex-app')).toBe(true);
    expect(isCodexFamilyCliId('traex')).toBe(false);
    expect(isCodexFamilyCliId(undefined)).toBe(false);
  });
});

describe('codex-app judgement lives behind the predicate in daemon / worker-pool / worker', () => {
  // 判定点一律走 isCodexAppCliId / isCodexFamilyCliId。字面量只允许出现在「赋值 / 拼接 id」里，
  // 不允许再次出现 `=== 'codex-app'` / `!== 'codex-app'` 形式的散落比较。
  const COMPARE = /[!=]==\s*'codex-app'/;
  for (const rel of ['src/worker.ts', 'src/core/worker-pool.ts', 'src/daemon.ts']) {
    it(`${rel} has no raw codex-app comparison`, () => {
      const offenders = read(rel)
        .split('\n')
        .map((line, i) => ({ line, n: i + 1 }))
        .filter(({ line }) => COMPARE.test(line) && !line.trimStart().startsWith('//') && !line.trimStart().startsWith('*'));
      expect(offenders.map(o => `${rel}:${o.n}: ${o.line.trim()}`)).toEqual([]);
    });
  }

  it('managed-origin validation keeps the deliberate OR of both cliId sources (fail-closed)', () => {
    // worker 侧：worker 当前 init 的 cliId 与会话库里的 cliId 任一为 Codex App 即按 ledger 精确校验。
    const worker = read('src/worker.ts');
    expect(worker).toMatch(/isCodexAppCliId\(lastInitConfig\?\.cliId\)\s*\|\|\s*isCodexAppCliId\(session\?\.cliId\)/);
    // daemon 侧两处内联（/api/send、hook 路径）：initConfig.cliId 与 session.cliId 同理。
    const daemon = read('src/daemon.ts');
    const hits = daemon.match(/isCodexAppCliId\(ds!?\.initConfig\?\.cliId\) \|\| isCodexAppCliId\(ds!?\.session\.cliId\)/g) ?? [];
    expect(hits).toHaveLength(2);
    // capability 直连 dispatch 的判定集中在 core/dispatch-output-sink.ts 一处（同样的 OR），
    // 由种子注册 / 投递路由的入口与写飞书栅栏、以及 dispatch-policy 路由共用。
    const sink = read('src/core/dispatch-output-sink.ts');
    expect(sink.match(/isCodexAppCliId\(ds\.initConfig\?\.cliId\) \|\| isCodexAppCliId\(ds\.session\.cliId\)/g) ?? [])
      .toHaveLength(1);
    expect(daemon.match(/isolatedDispatchOutputSinkAllowed\(ds\)/g) ?? []).toHaveLength(2);
    expect(daemon.match(/withIsolatedDispatchSinkFence\(/g) ?? []).toHaveLength(2);
    expect(read('src/core/dashboard-ipc-server.ts')).toContain('isolatedDispatchOutputSinkAllowed(ds)');
  });

  it('every session-level codex-app gate resolves the CLI snapshot-first (same priority as sessionCliId)', () => {
    // `/cli <id>` 的 pending snapshot（首次 fork 之前）才是会话将要跑的 CLI，session.cliId 此时为空、
    // bot 是默认值。clean-input 门、dispatch ledger 记账、tail-only 恢复分流若各自按
    // `session.cliId ?? bot`，就会对同一会话给出与 forkWorker / sendWorkerInput 相反的结论。
    // 行为由 session-lifecycle-start.test.ts 的「/cli-selected CLI before the first fork」覆盖；
    // 这里只钉「不许再回到不含 snapshot 的写法」。
    const pool = read('src/core/worker-pool.ts');
    expect(pool).not.toMatch(/isCodexAppCliId\(\s*ds\.session\.cliId\s*\?\?/);
    expect(pool).not.toMatch(/effectiveCliId = ds\.session\.cliId \?\? botCfg\.cliId;\s*\n\s*(?:return |if \()!?isCodexAppCliId/);
    expect(pool).toMatch(/const effectiveCliId = sessionCliId\(ds, botCfg\);\s*\n\s*return isCodexAppCliId\(effectiveCliId\)/);
    expect(pool).toMatch(/const effectiveCliId = sessionCliId\(ds, botCfg\);\s*\n\s*if \(!isCodexAppCliId\(effectiveCliId\) \|\| !turnId\) return undefined;/);
    expect(pool).toContain('isCodexAppCliId(sessionCliId(ds, getBot(ds.larkAppId).config))');

    const daemon = read('src/daemon.ts');
    // 冷启动 raw follow-up 与 queuedActivation 恢复：同一优先级，且不再是 session / bot 的 OR。
    expect(daemon).not.toMatch(/isCodexAppCliId\(ds\.session\.cliId\)\s*\|\|\s*isCodexAppCliId\(botCfg\.cliId\)/);
    expect(daemon).not.toMatch(/isCodexAppCliId\(ds\.session\.cliId \?\? dsBotCfgForFork\.cliId\)/);
    expect(daemon).toContain('isCodexAppCliId(ds.session.cliLaunchSnapshot?.cliId ?? ds.session.cliId ?? botCfg.cliId)');
    expect(daemon).toMatch(/isCodexAppCliId\(\s*ds\.session\.cliLaunchSnapshot\?\.cliId \?\? ds\.session\.cliId \?\? dsBotCfgForFork\.cliId,?\s*\)/);
  });
});
