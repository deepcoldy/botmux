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
import { describe, expect, it } from 'bun:test';
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

describe('worker.ts restart wiring', () => {
  const src = readFileSync(join(import.meta.dirname, '../src/worker.ts'), 'utf-8');
  const restart = src.slice(src.indexOf('async function restartCliProcess('));
  const teardownBlock = restart.slice(0, restart.indexOf('killCli({ preservePending: opts.preservePending })'));
  it('no longer swallows the teardown outcome', () => {
    // The exact laundering shape: a bare race against a sleep, discarded, inside an
    // empty catch. Asserted on source because the alternative is spinning up a real
    // worker process, and this decision has to be observable somewhere.
    expect(teardownBlock).not.toContain('catch { /* destroySession logs its own failure details */ }');
    expect(teardownBlock).toContain('classifyRestartTeardown');
    expect(teardownBlock).toContain("kind: 'rejected'");
    expect(teardownBlock).toContain("kind: 'timeout'");
  });

  it('gates killCli/respawn behind the verdict', () => {
    // killCli must be preceded by the refusal branch, or the fix is decorative.
    expect(teardownBlock).toContain('if (!teardownVerdict.mayRespawn)');
    const guard = teardownBlock.indexOf('if (!teardownVerdict.mayRespawn)');
    const ret = teardownBlock.indexOf('return;', guard);
    expect(guard).toBeGreaterThan(-1);
    expect(ret).toBeGreaterThan(guard);
  });

  it('never rolls back admission on the restart path', () => {
    // Rollback is not the legitimate exit from an uncertain teardown: it would
    // re-open writes on the very lineage we cannot prove is gone. Comments are
    // stripped first, so the note explaining this rule cannot satisfy (or break)
    // its own assertion.
    const code = teardownBlock
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .map(line => line.replace(/\/\/.*$/, ''))
      .join('\n');
    expect(code).not.toMatch(/abortDestroySession/);
    // The stripping must not have eaten the code we DO care about.
    expect(code).toContain('classifyRestartTeardown');
  });
});
