/**
 * worker.ts is a process entrypoint (installs IPC/signal handlers on import),
 * so — like worker-durable-expiry-order.test.ts — pin the exact wiring of
 * PR #507's two restart-race fixes by asserting source structure. The pure
 * decision they feed is executed in restart-followup-policy.test.ts; these
 * assertions guard the ordering/guards that a refactor could silently break.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

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

describe('bare-shell retry restart fencing', () => {
  it('validates and consumes the one-shot nonce before durable settle or restart', () => {
    const branch = restartCaseBranch();
    const retryGuard = branch.indexOf('if (msg.bareShellRetryNonce)');
    const nonceCheck = branch.indexOf('msg.bareShellRetryNonce === bareShellRetryNonce', retryGuard);
    const consume = branch.indexOf('bareShellRetryNonce = undefined', nonceCheck);
    const settle = branch.indexOf('settleDurableTurnForRestart({', consume);
    const restart = branch.indexOf('await restartCliProcess(', settle);

    expect(retryGuard).toBeGreaterThanOrEqual(0);
    expect(nonceCheck).toBeGreaterThan(retryGuard);
    expect(consume).toBeGreaterThan(nonceCheck);
    expect(settle).toBeGreaterThan(consume);
    expect(restart).toBeGreaterThan(settle);
    expect(branch.slice(restart, restart + 500)).toContain('preservePending: true');
  });

  it('does not report retry success until the bare-shell launch guard passes', () => {
    const readyStart = workerSource.indexOf('function markPromptReady()');
    const readyEnd = workerSource.indexOf('function persistCliSessionId', readyStart);
    const ready = workerSource.slice(readyStart, readyEnd);
    expect(ready).toContain('activeRestartAttemptId && !activeRestartRequiresBareShellCheck');

    const flushStart = workerSource.indexOf('async function flushPending()');
    const flushEnd = workerSource.indexOf('async function sendToPty', flushStart);
    const flush = workerSource.slice(flushStart, flushEnd);
    const guard = flush.indexOf('await detectBareShellLaunch()');
    const restartFence = flush.indexOf('if (cliRestartInProgress) return;', guard);
    const success = flush.indexOf("category: 'launch_guard_passed'", guard);
    const dequeue = flush.indexOf('freshnessInputQueue.takeNormal()', success);
    expect(guard).toBeGreaterThanOrEqual(0);
    expect(restartFence).toBeGreaterThan(guard);
    expect(success).toBeGreaterThan(restartFence);
    expect(dequeue).toBeGreaterThan(success);
  });

  it('does not offer a retry for an injection-only launch failure', () => {
    const injectionStart = workerSource.indexOf('async function flushPendingInjections()');
    const injectionEnd = workerSource.indexOf('async function handleTuiTextInput', injectionStart);
    const injectionFlush = workerSource.slice(injectionStart, injectionEnd);
    expect(injectionFlush).toContain('await detectBareShellLaunch(false)');

    const detectStart = workerSource.indexOf('async function detectBareShellLaunch(');
    const detectEnd = workerSource.indexOf('async function flushPending()', detectStart);
    const detect = workerSource.slice(detectStart, detectEnd);
    const retryableInput = detect.indexOf('const retryableInputPending = offerRetry');
    const plainOnly = detect.indexOf('if (!retryableInputPending)', retryableInput);
    const plainNotify = detect.indexOf("type: 'user_notify'", plainOnly);
    const returnFromPlain = detect.indexOf('return true;', plainNotify);
    const retryNonce = detect.indexOf('bareShellRetryNonce = randomBytes', returnFromPlain);
    const retryKind = detect.indexOf("kind: 'bare_shell_launch_failed'", retryNonce);
    expect(retryableInput).toBeGreaterThanOrEqual(0);
    expect(detect.slice(retryableInput, plainOnly)).toContain('pendingMessages.length > 0');
    expect(detect.slice(retryableInput, plainOnly)).toContain('pendingRawInputs.length > 0');
    expect(detect.slice(retryableInput, plainOnly)).toContain('pendingSessionRename !== null');
    expect(plainOnly).toBeGreaterThan(retryableInput);
    expect(plainNotify).toBeGreaterThan(plainOnly);
    expect(returnFromPlain).toBeGreaterThan(plainNotify);
    expect(retryNonce).toBeGreaterThan(returnFromPlain);
    expect(retryKind).toBeGreaterThan(retryNonce);
  });

  it('fails the correlated retry before issuing a fresh failure card', () => {
    const detectStart = workerSource.indexOf('async function detectBareShellLaunch(');
    const detectEnd = workerSource.indexOf('async function flushPending()', detectStart);
    const detect = workerSource.slice(detectStart, detectEnd);
    const failure = detect.indexOf("category: 'bare_shell_launch_failed'");
    const notification = detect.indexOf("kind: 'bare_shell_launch_failed'", failure);
    expect(failure).toBeGreaterThanOrEqual(0);
    expect(notification).toBeGreaterThan(failure);
  });
});
