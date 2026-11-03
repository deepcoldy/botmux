/**
 * restartCliProcess() must not respawn over an unproven teardown.
 *
 * The old code computed the teardown and threw it away:
 *
 *     try { await Promise.race([teardown, sleep(22_000)]); } catch {}
 *     killCli(...);   // respawned regardless
 *
 * so three distinct failures all read as "clean close": a resolved `ok: false`
 * (never inspected), a won timeout (which is precisely the signal that teardown is
 * unfinished), and a rejection (swallowed). Each one then produced a fresh backend
 * with a fresh env nonce, meaning a second credentialed lineage on top of a subtree
 * that may still be alive — and the old tree became unenumerable.
 *
 * These cases pin the DECISION (classifyRestartTeardown) plus the wiring in
 * worker.ts, because the decision used to be an inline `catch {}` that no test
 * could reach.
 *
 * Run:  pnpm vitest run test/mojo-restart-teardown-fence.test.ts
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { classifyRestartTeardown } from '../src/adapters/backend/destroy-result.js';

describe('classifyRestartTeardown', () => {
  it('allows the respawn only when teardown actually succeeded', () => {
    expect(classifyRestartTeardown({ kind: 'settled', raw: { ok: true } }, { remote: true }))
      .toEqual({ mayRespawn: true });
    // Local backends have no async teardown to be uncertain about.
    expect(classifyRestartTeardown({ kind: 'absent' }, { remote: false }))
      .toEqual({ mayRespawn: true });
    expect(classifyRestartTeardown({ kind: 'absent' }, { remote: true }))
      .toEqual({ mayRespawn: true });
  });

  it('refuses the respawn when the bounded wait timed out', () => {
    // The timeout used to win the race SILENTLY, which is the worst of the three:
    // it is the one outcome that positively indicates teardown is still running.
    const verdict = classifyRestartTeardown({ kind: 'timeout' }, { remote: true });
    expect(verdict.mayRespawn).toBe(false);
    expect(verdict.reason).toBe('restart_teardown_timeout');
    expect(verdict.recovery).toBe('uncertain');
  });

  it('refuses the respawn when teardown threw, and keeps the message', () => {
    const verdict = classifyRestartTeardown(
      { kind: 'rejected', error: new Error('cancel exploded') },
      { remote: true },
    );
    expect(verdict.mayRespawn).toBe(false);
    expect(verdict.reason).toContain('cancel exploded');
    expect(verdict.recovery).toBe('uncertain');
  });

  it('refuses the respawn on a resolved failure and preserves its recovery', () => {
    expect(classifyRestartTeardown(
      { kind: 'settled', raw: { ok: false, error: 'mojo_lineage_not_materialized', recovery: 'uncertain' } },
      { remote: true },
    )).toEqual({
      mayRespawn: false,
      reason: 'mojo_lineage_not_materialized',
      recovery: 'uncertain',
    });
    // A retryable failure is still a FAILURE here: the remote session was not torn
    // down, so respawning would leave two live lineages regardless of whether the
    // close could be retried.
    expect(classifyRestartTeardown(
      { kind: 'settled', raw: { ok: false, error: 'cancel not proven', recovery: 'retryable' } },
      { remote: true },
    )).toMatchObject({ mayRespawn: false, recovery: 'retryable' });
  });

  it('treats a missing or malformed REMOTE answer as unproven', () => {
    // Shares the close path's normalizer, so `{ ok: 'yes' }` cannot pass for success
    // here either.
    for (const raw of [undefined, null, {}, { ok: 'yes' }, 'done', 0]) {
      expect(classifyRestartTeardown({ kind: 'settled', raw }, { remote: true }), `raw=${String(raw)}`)
        .toMatchObject({ mayRespawn: false });
    }
    // ... while a legacy local void return still means success.
    expect(classifyRestartTeardown({ kind: 'settled', raw: undefined }, { remote: false }))
      .toEqual({ mayRespawn: true });
  });
});

describe('worker.ts restart teardown fence', () => {
  // 源码结构护栏(K2)：restartCliProcess 在 worker 闭包里，决策已抽成 classifyRestartTeardown
  // （上面的行为用例覆盖），但「verdict 必须先于 killCli/respawn 生效」只能在源码上看到——
  // 否则就要起真实 worker。守的不变量：teardown 未证实时拒绝 respawn（不然会在可能仍存活的
  // 凭证子树上再起一条带新 env nonce 的 lineage），且这条路径绝不回滚 admission（mojo 后端 #803）。
  it('refuses to respawn over an unproven teardown and never rolls admission back', () => {
    const src = readFileSync(join(import.meta.dirname, '../src/worker.ts'), 'utf-8');
    const restart = src.slice(src.indexOf('async function restartCliProcess('));
    const killCli = restart.search(
      /killCli\(\{\s*preservePending: opts\.preservePending,\s*preservePolicyCapability: true/,
    );
    expect(killCli).toBeGreaterThan(-1);
    // Comments stripped, so prose explaining the rule cannot satisfy (or break) it.
    const code = restart.slice(0, killCli)
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .map(line => line.replace(/\/\/.*$/, ''))
      .join('\n');
    const verdict = code.indexOf('classifyRestartTeardown(');
    const guard = code.search(/if \(!\w+\.mayRespawn\)/);
    expect(verdict).toBeGreaterThan(-1);
    expect(guard).toBeGreaterThan(verdict);
    expect(code.indexOf('return', guard)).toBeGreaterThan(guard);
    expect(code).not.toMatch(/abortDestroySession/);
  });
});
