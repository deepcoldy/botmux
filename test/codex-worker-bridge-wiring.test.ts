import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const workerSource = readFileSync(new URL('../src/worker.ts', import.meta.url), 'utf8');

// NB: this file only asserts the WIRING shape of codexBridgeNotifyCliSessionId
// (a module-state-heavy worker-internal function that isn't unit-testable
// end-to-end without spawning a real worker). The behavioral guarantee behind
// the ownership gate — a foreign, shared-CODEX_HOME history sid is NOT in the
// pid's fd set and therefore cannot hijack the binding, while a real
// parent+sibling sid IS — is exercised against real subprocesses in
// codex-coco-pid-discovery.smoke.test.ts (findCodexRolloutSetByPid).
describe('Codex worker structured-bridge wiring', () => {
  it('follows same-session generations from both the ticker and session notifications', () => {
    const timer = workerSource.slice(workerSource.indexOf('function codexBridgeStartTimer'), workerSource.indexOf('function hermesBridgeAttach'));
    expect(timer).toContain('maybeFollowCodexRolloutRotation();');
    const notify = workerSource.slice(workerSource.indexOf('function codexBridgeNotifyCliSessionId'));
    expect(notify).toContain('maybeFollowCodexRolloutRotation(true);');
    const start = workerSource.indexOf('function maybeFollowCodexRolloutRotation');
    const rotation = workerSource.slice(start, workerSource.indexOf('\nfunction codexBridgeIngest', start));
    expect(rotation).toContain('rpcTranscriptIngestBlockedByAwaitingActivation');
    expect(rotation).toContain('codexSessionIdFromRolloutPath(next)?.toLowerCase() !== sid.toLowerCase()');
    expect(rotation).not.toContain('codexHistorySidOwnedByCurrentPid(');
    expect(rotation).toContain('codexBridgeQueue.absorb(codexConsumedRolloutEvents(');
    expect(rotation).toContain("codexBridgeAttach(next, 'fresh-empty')");
    expect(workerSource).toContain('result.events = codexEventsWithStableIds(path, result.events);');
  });
  it('reattaches an incorrectly discovered rollout after writeInput verifies the session id', () => {
    const start = workerSource.indexOf('function codexBridgeNotifyCliSessionId');
    const end = workerSource.indexOf('// Already attached — first-attach-wins for most CLIs.', start);
    const notify = workerSource.slice(start, end);
    const codexStart = notify.indexOf('if (structuredBridgeIsCodex())');
    const codex = notify.slice(codexStart);

    expect(codexStart).toBeGreaterThanOrEqual(0);
    expect(codex).toContain('codexSessionIdFromRolloutPath(codexBridgeRolloutPath)');
    expect(codex).toContain("resolveFileBridgePath('codex', { sessionId: cliSessionId })");
    expect(codex.indexOf('codexBridgeDetachFile();')).toBeLessThan(codex.indexOf('codexBridgeAttach(next, attachMode);'));
    expect(codex).toContain("codexBridgeUsesSplitLiveAttach() ? 'split-live' : 'fresh-empty'");
    expect(codex).toContain('codexBridgePendingSessionId = cliSessionId;');
  });

  it('gates the re-attach on pid rollout-fd ownership before detaching (rejects a foreign history sid)', () => {
    const start = workerSource.indexOf('function codexBridgeNotifyCliSessionId');
    const end = workerSource.indexOf('// Already attached — first-attach-wins for most CLIs.', start);
    const codex = workerSource.slice(start, end);

    const gate = codex.indexOf('codexHistorySidOwnedByCurrentPid(cliSessionId)');
    const detach = codex.indexOf('codexBridgeDetachFile();');
    const resolveNext = codex.indexOf("resolveFileBridgePath('codex'");

    // The ownership check must exist AND run before both the path resolution and
    // the detach, so a foreign sid returns early with the binding intact.
    expect(gate).toBeGreaterThan(0);
    expect(gate).toBeLessThan(resolveNext);
    expect(gate).toBeLessThan(detach);
    expect(codex).toContain('refusing history-only re-attach');

    // The ownership helper must use the fd-SET accessor (not the ambiguity-
    // collapsing single one, which returns undefined for the parent+sibling
    // case we must ALLOW) and delegate the pure membership decision to
    // codexHistorySidIsOwned (unit-tested in codex-transcript.test.ts).
    const helperStart = workerSource.indexOf('function codexHistorySidOwnedByCurrentPid');
    expect(helperStart).toBeGreaterThan(0);
    const helper = workerSource.slice(helperStart, workerSource.indexOf('\n}', helperStart));
    expect(helper).toContain('findCodexRolloutSetByPid(');
    expect(helper).toContain('codexHistorySidIsOwned(');
    expect(helper).not.toContain('findCodexRolloutByPid(');
  });

  it('also gates the INITIAL attach (unattached multi-fd adopt), not just re-attach', () => {
    // The multi-fd adopt case starts unattached (findCodexRolloutByPid → undefined),
    // so a foreign history sid would otherwise reach the generic initial-attach
    // tail with no ownership check. Assert the codex initial-attach guard exists
    // and that a rejected sid does NOT get pinned as pending (which would wedge
    // the bridge — poller pid-fallback stays ambiguous forever).
    const marker = "Codex INITIAL attach";
    const guardIdx = workerSource.indexOf(marker);
    expect(guardIdx).toBeGreaterThan(0);
    const guard = workerSource.slice(guardIdx, guardIdx + 1400);
    expect(guard).toContain('codexHistorySidOwnedByCurrentPid(cliSessionId)');
    // On refusal, clear pending (do not pin the foreign sid) + keep polling.
    expect(guard).toContain('codexBridgePendingSessionId = undefined;');
    expect(guard).toContain('codexBridgeStartTimer();');
  });

  it('antigravity ticker delegates the pending/rotation decision to the pure decideAntigravityTickerAction', () => {
    // Behaviour of the /new lazy-create race (pending B kept when pid returns
    // retired A; rotate when B's file appears; clear only on SID provenance)
    // is covered in test/antigravity-bridge-decision.test.ts. Here assert the
    // worker ticker routes through it and acts on each action kind.
    const anchor = workerSource.indexOf('Antigravity has no /adopt bridge');
    expect(anchor).toBeGreaterThan(0);
    const branchIdx = workerSource.lastIndexOf('if (structuredBridgeIsAntigravity()) {', anchor);
    const branch = workerSource.slice(branchIdx, branchIdx + 3200);
    expect(branch).toContain('decideAntigravityTickerAction({');
    expect(branch).toContain("action.kind === 'rotate'");
    expect(branch).toContain("action.kind === 'bind-initial'");
    expect(branch).toContain("action.kind === 'clear-pending'");
    expect(branch).toContain('flushAntigravityTrailingFinal: true');
  });

  it('releases the antigravity provisional final only from a guarded ready+not-busy quiet tick with no pending background task', () => {
    const fnStart = workerSource.indexOf('function maybeFlushAntigravityTrailingFinalOnQuietTick');
    expect(fnStart).toBeGreaterThan(0);
    const fnEnd = workerSource.indexOf('/** 将 Codex 的结构化 429', fnStart);
    const fn = workerSource.slice(fnStart, fnEnd);
    // Two-tick unchanged-offset latch…
    expect(fn).toContain('antigravityQuietCandidateKey');
    // …and BOTH screen conditions (ready marker present, busy marker absent).
    expect(fn).toContain('cliAdapter.busyPattern.test(busyProbeRegion(screen))');
    expect(fn).toContain('cliAdapter.readyPattern.test(stripAnsiScreenText(screen))');
    // …plus the transcript-level pending-task veto.
    expect(fn).toContain('antigravityBridgeState.hasPendingTask');
    expect(fn).toContain('codexBridgeIngest({ flushAntigravityTrailingFinal: true })');
    // The flush is driven from the 1s ticker.
    expect(workerSource).toContain('maybeFlushAntigravityTrailingFinalOnQuietTick();');
  });

  it('does not fire the idle detector from an antigravity transcript final (screen owns its turn boundary)', () => {
    const fnStart = workerSource.indexOf('function codexBridgeIngest');
    const fnEnd = workerSource.indexOf('function maybeFlushOmpTrailingFinalOnQuietTick', fnStart);
    const fn = workerSource.slice(fnStart, fnEnd);
    expect(fn).toContain('!structuredBridgeIsAntigravity()');
  });

  it('notifies the bridge when the antigravity pid observer resolves a conversation id', () => {
    const fnStart = workerSource.indexOf('function observeAntigravityCliSessionId');
    expect(fnStart).toBeGreaterThan(0);
    const fnEnd = workerSource.indexOf('const SUBMIT_DEFERRED_RECHECK_MS', fnStart);
    const fn = workerSource.slice(fnStart, fnEnd);
    expect(fn).toContain('if (codexBridgeFallbackActive()) codexBridgeNotifyCliSessionId(cid);');
  });

  it('spawnCli re-checks zero-prompt capability with the RESOLVED sandbox mode (env BOTMUX_SANDBOX=scratch is not on cfg)', () => {
    // The capability gate at config/command time cannot see the machine-wide
    // BOTMUX_SANDBOX switch (it is never materialised into cfg). spawnCli
    // resolves the real mode via resolveSandboxMode → sandboxMode; it must feed
    // that resolved value back into supportsZeroPromptInjection so a
    // zero-prompt cursor/antigravity under the scratch COW overlay throws
    // instead of silently dropping every reply.
    const anchor = workerSource.indexOf('const scratchRequested = sandboxMode === ');
    expect(anchor).toBeGreaterThan(0);
    // The re-check lives after the resolved mode is known in spawnCli.
    const region = workerSource.slice(anchor, anchor + 2000);
    expect(region).toContain("cfg.promptInjection === 'none' && !supportsZeroPromptInjection(cfg.cliId, {");
    expect(region).toContain('sandbox: sandboxMode');
    expect(region).toContain('backendType: effectiveBackendType');
  });

  it('resolves the real codex leaf under a sandbox launcher process', () => {
    const start = workerSource.indexOf('function resolveCodexOwnershipPid');
    expect(start).toBeGreaterThan(0);
    const body = workerSource.slice(start, workerSource.indexOf('\n}\n', start));
    expect(body).toContain("findLaunchedCliPid(candidatePid, 'codex'");
    // A direct native leaf (its own comm already identifies as codex) must
    // short-circuit BEFORE the descendant scan.
    expect(body).toContain('codexProcessIsNativeLeaf(candidatePid, filterExecutable)');
    expect(workerSource).toContain('lastSpawnCodexLauncherActive = codexLauncherActive;');
    const kicks = workerSource.match(/if \(cfg\.cliId === 'codex' && codexLauncherActive\) startCodexLauncherPidResolve\(/g) ?? [];
    expect(kicks.length).toBeGreaterThanOrEqual(2);
    // The retry loop gets the same leaf predicate (no 30× waste on direct
    // installs) and the configured custom executable name.
    expect(workerSource).toContain('isDirectLeaf: (lp) => codexProcessIsNativeLeaf(lp, codexFilterExecutable)');
    expect(workerSource).toContain("findLaunchedCliPid(lp, 'codex', 6, {}, codexFilterExecutable)");
  });
});
