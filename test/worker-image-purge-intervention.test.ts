/** Executes the real worker repair, restart and input/stop handlers with a
 * controlled process-exit clock. Only backend, queue delivery and unrelated UI
 * boundaries are injected; no worker process or live services are started. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadWorkerFunction, loadWorkerMessageHandler } from './helpers/worker-function-harness.js';
import { purgeTraexToolImages, resolveTraexImagePurgeTarget } from '../src/services/traex-tool-image-recovery.js';
import { planPurgeRequest, runPurgeMaintenance, purgeOutcomeNotice, PurgeContinuationLease, PURGE_IMAGES_NOT_APPLIED } from '../src/services/image-purge-recovery.js';
import { waitForProcessQuiescence } from '../src/services/process-quiescence.js';
import { classifyRestartTeardown } from '../src/adapters/backend/destroy-result.js';
import { decideRestartFollowup, restartLaunchSettings } from '../src/core/restart-followup-policy.js';
import { restartSpendsFreshBudget } from '../src/core/restart-fresh-budget.js';

const SID = '00000000-0000-7000-8000-000000000001';
const image = { type: 'input_image', image_url: `traex-rollout-blob:v1:sha256:${'a'.repeat(64)}:image/png`, detail: 'original' };
const original = [
  { type: 'session_meta', payload: { id: SID } },
  { type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'done', output: [{ type: 'input_text', text: 'committed work' }, image] } },
].map(row => JSON.stringify(row) + '\n').join('');
const roots: string[] = [];
const isRemoteBackendType = () => false;
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(100_000); });
afterEach(() => {
  vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function harness() {
  const dir = mkdtempSync(join(tmpdir(), 'botmux-image-purge-intervention-')); roots.push(dir);
  const path = join(dir, `rollout-2026-11-25T00-00-00-${SID}.jsonl`); writeFileSync(path, original);
  const sent: any[] = []; const queued: string[] = []; const writes: string[] = [];
  let gone = false;
  const scope: Record<string, any> = {
    sessionId: SID, lastInitConfig: { cliId: 'traex', sessionId: SID, workingDir: dir },
    backend: { getChildPid: () => 4242 }, effectiveBackendType: 'pty', cliAdapter: { id: 'traex' },
    cliSpawnGeneration: 1, cliRestartEpoch: 0, cliRestartInProgress: false, replacementSpawnInProgress: false,
    rawInputRestartGate: false, tmuxRestartTimer: null, consecutiveInWorkerRestarts: 0,
    lastCliExitServerReplaced: false, intentionallyRetiredBackends: new WeakSet(),
    isPromptReady: true, closeRequested: false, currentBotmuxTurnId: 'om_failed',
    submitFailureChains: new Map(), inputDeliveryEvidence: new Map(), queuedActivationReceipts: new Map(),
    codexBridgeRolloutPath: path, lastResolvedSandboxMode: 'off', claudeProjectsRoot: undefined,
    traeSessionsRoot: () => dir, purgeTraexToolImages, resolveTraexImagePurgeTarget,
    planPurgeRequest, runPurgeMaintenance, purgeOutcomeNotice, PurgeContinuationLease, activeTranscriptImagePurge: undefined, waitForProcessQuiescence, PURGE_IMAGES_NOT_APPLIED,
    describePurgeReport: () => 'report', delay: (ms: number) => new Promise(resolve => setTimeout(resolve, ms)),
    pidNotProvablyGone: () => !gone, snapshotChildPids: () => () => [],
    classifyRestartTeardown, isRemoteBackendType, decideRestartFollowup, restartLaunchSettings, restartSpendsFreshBudget,
    stopOwnedSessionScope: vi.fn(), revokeManagedTurnOriginForRestart: vi.fn(),
    startScreenUpdates: vi.fn(), startStuckDetector: vi.fn(), adoptPendingLaunchConvergence: vi.fn(),
    codexRpcEligible: () => false, sandboxEnabled: () => false, traexAutoModelRuntimeEligible: () => false,
    prepareCodexNativeTitleGeneration: vi.fn(async () => {}), settleRestartAttemptOnReady: vi.fn(),
    releaseRawInputRestartGate: vi.fn(), sendFatalWorkerErrorAndExit: vi.fn(async () => {}),
    CliSpawnSupersededError: class extends Error {}, log: vi.fn(), send: (msg: any) => sent.push(msg), t: (key: string) => key,
    nativeSessionForkPending: () => false, failedTurnRewindInFlight: undefined, stopHeldFailedTurnRewind: () => false,
    isCriticalInterruptKey: (key: string) => key === 'ctrlc' || key === 'esc', workerSessionEventScope: undefined,
    cliInterruptGeneration: 0,
    runAfterAmbiguousSubmissionWrites: async (_target: unknown, action: () => Promise<boolean>) => action(),
    sendCriticalControlKey: async (_key: string, action: () => boolean) => action(),
    sendTermActionOnce: () => true, retireDoubaoBridgeTurnOnInterrupt: vi.fn(), scheduleOneShotAfterAction: vi.fn(),
    // Real worker message admission, injected queue/backend write boundary.
    applyWorkerLaunchModel: vi.fn(), applyRespawnConfigPatch: vi.fn(), respawnConfigPatchFromMessage: () => ({}),
    isOrdinaryImTurnId: () => false, activeTurnBlocks: () => false, isCodexAppCliId: () => false,
    tmuxScrolledHalfPages: 0, crashDiagnosticStopped: false, renderer: undefined,
    sendToPty: (content: string, turn: string) => { queued.push(turn); return true; },
    deferTurnInputCommitUntilSubmission: () => false, acknowledgeTurnInputCommitted: vi.fn(),
  };
  scope.killCli = vi.fn(() => { scope.backend = null; scope.isPromptReady = false; });
  scope.spawnCli = vi.fn(async () => { scope.backend = { replacement: true }; scope.isPromptReady = true; });
  scope.flushPending = vi.fn(async () => { if (!scope.cliRestartInProgress && scope.isPromptReady) writes.push(...queued.splice(0)); });
  scope.restartCliProcess = loadWorkerFunction('restartCliProcess', scope);
  scope.startTranscriptImagePurge = loadWorkerFunction('startTranscriptImagePurge', scope);
  const message = loadWorkerMessageHandler('message', scope);
  scope.handleTermAction = loadWorkerFunction('handleTermAction', scope);
  const stop = loadWorkerMessageHandler('term_action', scope);
  const interrupt = loadWorkerFunction('handleExactTurnInterrupt', scope);
  return { scope, path, dir, sent, queued, writes, message, stop, interrupt, gone: () => { gone = true; },
    start: () => scope.startTranscriptImagePurge('retry-1', undefined, () => scope.sendToPty('continue', 'retry-1'), true),
  };
}

describe('worker image purge intervention', () => {
  it.each(['ctrlc', 'esc'])('withholds %s-stopped repair during process exit wait and resumes the CLI', async key => {
    const h = harness(); h.start();
    expect(h.scope.backend).toBeNull(); expect(h.queued).toEqual([]);
    await h.stop({ type: 'term_action', key });
    h.gone(); await vi.advanceTimersByTimeAsync(600);
    expect(h.scope.sendFatalWorkerErrorAndExit).not.toHaveBeenCalled();
    expect(h.writes).toEqual([]);
    expect(h.sent.filter(msg => msg.type === 'turn_input_rejected')).toHaveLength(1);
    expect(h.scope.spawnCli).toHaveBeenCalledOnce();
    expect(readFileSync(h.path, 'utf8')).toBe(original);
  });
  it('keeps only newer input when it supersedes a held repair continuation', async () => {
    const h = harness(); h.start();
    await h.message({ type: 'message', turnId: 'om_new', content: 'stop the old task and do the new task' });
    expect(h.queued).toEqual(['om_new']);
    h.gone(); await vi.advanceTimersByTimeAsync(600);
    expect(h.scope.sendFatalWorkerErrorAndExit).not.toHaveBeenCalled();
    expect(h.writes).toEqual(['om_new']);
    expect(h.sent.filter(msg => msg.type === 'turn_input_rejected')).toHaveLength(1);
    expect(readFileSync(h.path, 'utf8')).toBe(original);
  });
  it('stops the bound retry before its turn becomes the backend active turn', async () => {
    const h = harness(); h.start();
    await h.interrupt('stop-request', 'retry-1');
    h.gone(); await vi.advanceTimersByTimeAsync(600);
    expect(h.writes).toEqual([]);
    expect(h.sent.filter(msg => msg.type === 'turn_input_rejected')).toHaveLength(1);
    expect(h.sent).toContainEqual(expect.objectContaining({ type: 'turn_interrupt_result', requestId: 'stop-request', delivered: true }));
    expect(readFileSync(h.path, 'utf8')).toBe(original);
  });
  it('withholds continuation after stop in the post-repair respawn delay', async () => {
    const h = harness(); h.start(); h.gone();
    await vi.advanceTimersByTimeAsync(25);
    expect(readFileSync(h.path, 'utf8')).not.toBe(original);
    await h.stop({ type: 'term_action', key: 'ctrlc' });
    await vi.advanceTimersByTimeAsync(600);
    expect(h.writes).toEqual([]); expect(h.scope.spawnCli).toHaveBeenCalledOnce();
    expect(h.sent.filter(msg => msg.type === 'turn_input_rejected')).toHaveLength(1);
    expect(readFileSync(join(h.dir, readdirSync(h.dir).find(name => name.includes('.botmux-tool-images-bak-'))!), 'utf8')).toBe(original);
  });
  it.each(['stop', 'new input'])('withholds after %s while replacement initialization is awaited', async intervention => {
    const h = harness(); let release!: () => void;
    h.scope.prepareCodexNativeTitleGeneration.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
    h.start(); h.gone(); await vi.advanceTimersByTimeAsync(600);
    expect(h.scope.backend).not.toBeNull(); expect(h.scope.cliRestartInProgress).toBe(true);
    if (intervention === 'stop') await h.stop({ type: 'term_action', key: 'ctrlc' });
    else await h.message({ type: 'message', turnId: 'om_new', content: 'new task' });
    release(); await vi.advanceTimersByTimeAsync(1);
    expect(h.writes).toEqual(intervention === 'stop' ? [] : ['om_new']);
    expect(h.sent.filter(msg => msg.type === 'turn_input_rejected')).toHaveLength(1);
    expect(h.scope.spawnCli).toHaveBeenCalledOnce();
  });
  it('withholds continuation once close supersedes the repair during the exit wait', async () => {
    const h = harness(); h.start(); h.scope.closeRequested = true;
    h.gone(); await vi.advanceTimersByTimeAsync(600);
    expect(h.writes).toEqual([]); expect(h.scope.spawnCli).not.toHaveBeenCalled();
    expect(h.sent.filter(msg => msg.type === 'turn_input_rejected')).toHaveLength(1);
  });
  it('rejects a second repair throughout the exit wait and respawn delay', async () => {
    const h = harness(); h.start();
    const second = vi.fn(); h.scope.startTranscriptImagePurge('retry-2', undefined, second, true);
    expect(h.sent.filter(msg => msg.type === 'turn_input_rejected').map(msg => msg.turnId)).toEqual(['retry-2']);
    h.gone(); await vi.advanceTimersByTimeAsync(600);
    expect(second).not.toHaveBeenCalled(); expect(h.writes).toEqual(['retry-1']);
    expect(h.scope.spawnCli).toHaveBeenCalledOnce();
  });
});
