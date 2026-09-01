import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'bun:test';

const workerSource = readFileSync(new URL('../src/worker.ts', import.meta.url), 'utf8');

// NB: this file only asserts the WIRING shape of codexBridgeNotifyCliSessionId
// (a module-state-heavy worker-internal function that isn't unit-testable
// end-to-end without spawning a real worker). The behavioral guarantee behind
// the ownership gate — a foreign, shared-CODEX_HOME history sid is NOT in the
// pid's fd set and therefore cannot hijack the binding, while a real
// parent+sibling sid IS — is exercised against real subprocesses in
// codex-coco-pid-discovery.smoke.test.ts (findCodexRolloutSetByPid).
describe('Codex worker structured-bridge wiring', () => {
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
});
