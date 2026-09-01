/**
 * worker.ts is a process entrypoint (installs IPC/signal handlers on import),
 * so — like worker-durable-expiry-order.test.ts — pin the exact wiring of
 * PR #507's two restart-race fixes by asserting source structure. The pure
 * decision they feed is executed in restart-followup-policy.test.ts; these
 * assertions guard the ordering/guards that a refactor could silently break.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'bun:test';

const workerSource = readFileSync(new URL('../src/worker.ts', import.meta.url), 'utf8');

function restartCaseBranch(): string {
  const start = workerSource.indexOf("case 'restart': {");
  const end = workerSource.indexOf("case 'expire_durable_turn':", start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return workerSource.slice(start, end);
}

describe('worker restart P1 — drain reliable terminal before ambiguous emit', () => {
  it('the restart case delegates durable settle to settleDurableTurnForRestart with drain wired before emit', () => {
    const branch = restartCaseBranch();
    const call = branch.indexOf('settleDurableTurnForRestart({');
    expect(call).toBeGreaterThanOrEqual(0);
    const deps = branch.slice(call, branch.indexOf('});', call) + 3);
    // the settle orchestration (unit-tested in restart-followup-policy.test.ts)
    // enforces drain → re-check → emit; here just pin that the restart case
    // injects the right callbacks so a just-completed turn claims the deduper.
    const drain = deps.indexOf('drainReliableTerminalBeforeInterrupt()');
    const emit = deps.indexOf("emitTurnTerminal(currentBotmuxTurnId!, 'ambiguous'");
    const isStill = deps.indexOf('isStillInFlight:');
    expect(drain).toBeGreaterThanOrEqual(0);
    expect(emit).toBeGreaterThan(0);
    expect(isStill).toBeGreaterThan(0);
    // the drain callback is declared before the emitAmbiguous callback in deps.
    expect(emit).toBeGreaterThan(drain);
  });

  it('the shared drain helper is gated on reliableTurnTerminal (matches onExit)', () => {
    const fn = workerSource.indexOf('function drainReliableTerminalBeforeInterrupt');
    expect(fn).toBeGreaterThanOrEqual(0);
    const body = workerSource.slice(fn, fn + 600);
    expect(body).toContain("cliAdapter?.reliableTurnTerminal !== true");
    expect(body).toContain('bridgeDrainAndMaybeEmit()');
    expect(body).toContain('codexBridgeDrainAndMaybeEmit');
  });

  it('onExit reuses the same shared drain helper (no divergent duplicate)', () => {
    // Both the CLI onExit path and the restart IPC path must drain identically;
    // the shared helper is the single source, so onExit calls it too.
    const onExitAmbiguous = workerSource.indexOf("'ambiguous',\n        'cli_exit'");
    expect(onExitAmbiguous).toBeGreaterThan(0);
    const before = workerSource.slice(onExitAmbiguous - 400, onExitAmbiguous);
    expect(before).toContain('drainReliableTerminalBeforeInterrupt()');
  });
});

describe('worker restart P2 — merge guard + replacement-exit recovery (no spurious re-restart)', () => {
  it('retains a coalesced cwd update without replacing the active correlated restart attempt', () => {
    const branch = restartCaseBranch();
    const cwdUpdate = branch.indexOf('if (msg.updateWorkingDir && lastInitConfig)');
    const guard = branch.indexOf('if (cliRestartInProgress || tmuxRestartTimer)');
    const attempt = branch.indexOf('activeRestartAttemptId = msg.attemptId;', guard);
    const freshness = branch.indexOf("codexRunnerFreshness = 'restarting_fresh';", attempt);

    expect(cwdUpdate).toBeGreaterThanOrEqual(0);
    expect(guard).toBeGreaterThan(cwdUpdate);
    expect(attempt).toBeGreaterThan(guard);
    expect(freshness).toBeGreaterThan(attempt);
    // The in-flight branch exits before touching the correlated attempt. This
    // lets a role-switch cwd update join a manual restart without stealing its
    // eventual prompt-ready result.
    expect(branch.slice(guard, attempt)).toContain('break;');
  });

  it('the merge guard plainly breaks — it does NOT arm any "restart requested" flag', () => {
    const branch = restartCaseBranch();
    const guard = branch.indexOf('if (cliRestartInProgress || tmuxRestartTimer)');
    const brk = branch.indexOf('break;', guard);
    expect(guard).toBeGreaterThanOrEqual(0);
    expect(brk).toBeGreaterThan(guard);
    // Codex-2 regression guard: a source-carrying flag would misread a healthy
    // duplicate /restart as a crash and force a budget-burning re-restart.
    expect(workerSource).not.toContain('pendingRestartAfterInFlight');
    expect(workerSource).not.toContain('restartRequestedDuringInFlight');
  });

  it('the continuation feeds ONLY backend liveness + cwd into decideRestartFollowup', () => {
    const start = workerSource.indexOf('async function restartCliProcess');
    const end = workerSource.indexOf('// ─── HTTP', start);
    const body = workerSource.slice(start, end);
    const decide = body.indexOf('decideRestartFollowup({');
    expect(decide).toBeGreaterThan(0);
    const call = body.slice(decide, decide + 260);
    expect(call).toContain('backendAlive: !!backend');
    expect(call).toContain('currentWorkingDir: lastInitConfig?.workingDir');
    // recovery must NOT depend on any merged-request signal.
    expect(call).not.toContain('restartRequestedDuringInFlight');
  });
});
