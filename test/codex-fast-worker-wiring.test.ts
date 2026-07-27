import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const workerSource = readFileSync(new URL('../src/worker.ts', import.meta.url), 'utf8');
const workerPoolSource = readFileSync(new URL('../src/core/worker-pool.ts', import.meta.url), 'utf8');

describe('Codex Fast Mode worker wiring', () => {
  it('passes Session Fast Mode into the app-server executor and captures its resolved tier', () => {
    const start = workerSource.indexOf('async function engageCodexRpc(');
    const end = workerSource.indexOf('/** RPC panes have NO terminal input path', start);
    const region = workerSource.slice(start, end);

    expect(region).toContain('fastMode: cfg.fastMode === true');
    expect(region).toContain('cfg.fastServiceTier = engine.activeServiceTier');
  });

  it('passes the live app-server endpoint and thread to the viewer adapter', () => {
    const start = workerSource.indexOf('const args = cliAdapter.buildArgs({');
    const end = workerSource.indexOf('\n  });', start);
    const region = workerSource.slice(start, end);

    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(region.length).toBeLessThan(2_000);
    expect(region).toContain('remoteWsUrl');
    expect(region).toContain('remoteThreadId');
    expect(region).toContain('fastServiceTier: cfg.fastServiceTier');
  });

  it('queues typed runtime changes and ACKs only after restart config is updated', () => {
    expect(workerSource).toContain("case 'set_fast_mode':");
    expect(workerSource).toContain('pendingFastModeChanges.push(msg)');

    const applyStart = workerSource.indexOf('function publishFastModeExecutorState(');
    const applyEnd = workerSource.indexOf('\n}', applyStart);
    const apply = workerSource.slice(applyStart, applyEnd);
    expect(applyStart).toBeGreaterThan(-1);
    expect(apply.indexOf('lastInitConfig.fastMode =')).toBeGreaterThan(-1);
    expect(apply.indexOf("type: 'fast_mode_state'")).toBeGreaterThan(
      apply.indexOf('lastInitConfig.fastMode ='),
    );
    const commitStart = workerSource.indexOf('function commitFastModeChange(');
    const commitEnd = workerSource.indexOf('\n}', commitStart);
    const commit = workerSource.slice(commitStart, commitEnd);
    expect(commit.indexOf("type: 'fast_mode_result'")).toBeGreaterThan(
      commit.indexOf('publishFastModeExecutorState('),
    );
  });

  it('passes the resolved backend into every worker-side Fast capability gate', () => {
    const resolveStart = workerSource.indexOf('async function resolveWorkerFastServiceTier(');
    const resolveEnd = workerSource.indexOf('async function ensureConfiguredFastServiceTier(', resolveStart);
    expect(workerSource.slice(resolveStart, resolveEnd)).toContain('backendType: cfg.backendType');

    const runtimeStart = workerSource.indexOf('async function flushPendingFastModeChanges(): Promise<void>');
    const runtimeEnd = workerSource.indexOf('function markPromptReady(): void', runtimeStart);
    expect(workerSource.slice(runtimeStart, runtimeEnd)).toContain('backendType: lastInitConfig.backendType');
  });

  it('persists the concrete tier across daemon/worker restarts', () => {
    expect(workerPoolSource).toContain("fastServiceTier: agentCfg.cliId === 'codex' ? ds.session.fastServiceTier : undefined");
    expect(workerPoolSource).toContain("fastModeStateVersion: agentCfg.cliId === 'codex' ? ds.session.fastModeStateVersion : undefined");
    expect(workerPoolSource).toContain("case 'fast_mode_result':");
    expect(workerPoolSource).toContain("case 'fast_mode_state':");
    expect(workerPoolSource).toContain('ds.session.fastServiceTier = msg.serviceTier');
    expect(workerPoolSource).toContain('ds.session.fastModeStateVersion = 1');
  });

  it('reconciles an unconfirmed legacy Fast state in either direction exactly once', () => {
    const initStart = workerSource.indexOf("case 'init':");
    const initEnd = workerSource.indexOf('// Queue the initial prompt', initStart);
    const init = workerSource.slice(initStart, initEnd);
    expect(init).toContain('}) && fastModeStateNeedsReconciliation({');
    expect(init).toContain('enabled: msg.fastMode === true');
    expect(init).toContain('forceFreshPersistent: fastModeNeedsReconciliation && !codexRpcEngine');
    expect(init).toContain('pendingInitialFastModeConfirmation =');

    const spawnStart = workerSource.indexOf('async function spawnCli(');
    const spawnEnd = workerSource.indexOf('// The plugin set is stable', spawnStart);
    const spawn = workerSource.slice(spawnStart, spawnEnd);
    expect(spawn).toContain('opts.forceFreshPersistent');
    expect(spawn).toContain('killPersistentBackendTargetVerified');

    const readyStart = workerSource.indexOf('function markPromptReady(): void');
    const readyEnd = workerSource.indexOf('clearSessionRenameInFlight();', readyStart);
    const ready = workerSource.slice(readyStart, readyEnd);
    expect(ready).toContain('pendingInitialFastModeConfirmation');
    expect(ready).toContain('publishFastModeExecutorState');
  });

  it('bounds and cancels a native replacement without allowing a late prompt to commit it', () => {
    expect(workerSource).toContain("case 'cancel_fast_mode':");
    expect(workerSource).toContain('fastModeRestartWatchdog.arm(request.requestId');

    const abortStart = workerSource.indexOf('async function abortPendingNativeFastModeChange(');
    const abortEnd = workerSource.indexOf('\n}\n\n/** Apply one Fast Mode request', abortStart);
    const abort = workerSource.slice(abortStart, abortEnd);
    expect(abortStart).toBeGreaterThan(-1);
    expect(abortEnd).toBeGreaterThan(abortStart);
    expect(abort).toContain('pending.request.requestId !== requestId');
    expect(abort).toContain('pendingRestartFastModeAck = null');
    expect(abort).toContain('restorePendingFastModeConfig(pending)');
    expect(abort).toContain('await restartCliProcess(');
    expect(abort).toContain('rejectFastModeChange(');
    expect(abort).toContain('fastModeChangeInFlight = false');
    expect(abort).toContain('continueAfterFastModeChange()');

    const readyStart = workerSource.indexOf('function markPromptReady(): void');
    const readyEnd = workerSource.indexOf('clearSessionRenameInFlight();', readyStart);
    const ready = workerSource.slice(readyStart, readyEnd);
    expect(ready).toContain('fastModeRestartWatchdog.clear(pending.request.requestId)');
  });
});
