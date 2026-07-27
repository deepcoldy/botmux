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
    const end = workerSource.indexOf('\\n  });', start);
    const region = workerSource.slice(start, end);

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

  it('persists the concrete tier across daemon/worker restarts', () => {
    expect(workerPoolSource).toContain("fastServiceTier: agentCfg.cliId === 'codex' ? ds.session.fastServiceTier : undefined");
    expect(workerPoolSource).toContain("fastModeStateVersion: agentCfg.cliId === 'codex' ? ds.session.fastModeStateVersion : undefined");
    expect(workerPoolSource).toContain("case 'fast_mode_result':");
    expect(workerPoolSource).toContain("case 'fast_mode_state':");
    expect(workerPoolSource).toContain('ds.session.fastServiceTier = msg.serviceTier');
    expect(workerPoolSource).toContain('ds.session.fastModeStateVersion = 1');
  });

  it('reconciles an unconfirmed legacy Fast pane exactly once', () => {
    const initStart = workerSource.indexOf("case 'init':");
    const initEnd = workerSource.indexOf('// Queue the initial prompt', initStart);
    const init = workerSource.slice(initStart, initEnd);
    expect(init).toContain('const fastModeNeedsReconciliation = msg.fastMode === true');
    expect(init).toContain('msg.fastModeStateVersion !== 1');
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
});
