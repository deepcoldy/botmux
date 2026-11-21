import { appendFileSync, mkdtempSync, rmSync } from 'node:fs';
import { statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadWorkerFunction } from './helpers/worker-function-harness.js';
import { BridgeTurnQueue, isHeldInCliQueue, makeFingerprint, normaliseForFingerprint } from '../src/services/bridge-turn-queue.js';
import { drainTranscript, splitTranscriptEventsByCutoff, type TranscriptEvent } from '../src/services/claude-transcript.js';

// The worker events that end a hold: Claude back at its prompt, a transcript
// switch, and a restore from the turn journal (the old CLI's queue is gone).
const TEXT = '<user_message>continue the task in this topic</user_message>';
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function heldQueue(markAt = Date.now()): BridgeTurnQueue {
  const queue = new BridgeTurnQueue();
  queue.mark('t1', makeFingerprint(TEXT), markAt, normaliseForFingerprint(TEXT));
  queue.ingest([{ type: 'queue-operation', operation: 'enqueue', timestamp: new Date(markAt + 1_000).toISOString(), content: TEXT } as unknown as TranscriptEvent]);
  expect(isHeldInCliQueue(queue.peek()[0])).toBe(true);
  return queue;
}

describe('worker events that end a queue hold', () => {
  it('Claude returning to its prompt', () => {
    const bridgeQueue = heldQueue();
    const stop = new Error('stop after the bridge step');
    const scope: Record<string, unknown> = {
      idleDetector: undefined, traexFirstPromptViewportRejects: () => false,
      remoteRunnerRecoveredTurnInFlight: false, bareShellLaunchBlocked: false,
      currentInputDeliveryQuarantine: () => undefined, currentPostTerminalInputFence: () => undefined,
      isPromptReady: false, stopStructuredStartGraceRecheck: () => {}, isCodexAppCliId: () => false,
      lastInitConfig: { cliId: 'claude-code' }, cliRestartInProgress: false, replacementSpawnInProgress: false,
      probeStartupBlocker: () => false, stopBusyPatternIdleProbe: () => {}, readyGate: { shouldHold: () => false },
      awaitingPostSessionStartPromptEvidence: false, isSettlingFirstFlush: false,
      freshnessInputQueue: { onPromptReady: () => 'proceed' }, spawnArgvTurnStartGateHolds: () => false,
      backgroundTaskTracker: { pendingTurnAgents: () => 0 },
      hasStructuredLifecycleBlock: () => false, structuredRejectedReadyEvidenceGeneration: undefined,
      queuedTurnAdvanceConsumedForPrompt: undefined, decideQueuedReadyTransition: () => ({}),
      ptyOutputGeneration: { snapshot: () => 0 }, durableTurnInFlight: false,
      preserveActiveTurnAuthorityForReady: false, queuedTypeAheadTurns: [], releaseActiveTurnAuthority: () => {},
      promptReadyEdges: 0, judgeClaudeBridgeTurn: () => {}, bridgeQueue,
      settleSessionRenameOnPrompt: () => { throw stop; },
      log: () => {},
    };
    // markPromptReady runs the interactive native-fork hold before reaching the
    // rename settle below; load the real gate pair (not a stub) so the sliced
    // function keeps its production semantics. forkSession is unset here, so the
    // predicate returns false without touching backend/cliAdapter.
    scope.nativeSessionForkPending = loadWorkerFunction('nativeSessionForkPending', scope);
    scope.holdForNativeSessionFork = loadWorkerFunction('holdForNativeSessionFork', scope);
    // The cold-resume stale-turn release is a first-prompt-only early gate;
    // this scope never sets awaitingFirstPrompt, so the real function returns
    // at its first guard without touching any queue state.
    scope.releaseInterruptedStructuredBridgeOnFirstPrompt
      = loadWorkerFunction('releaseInterruptedStructuredBridgeOnFirstPrompt', scope);
    expect(() => loadWorkerFunction<() => void>('markPromptReady', scope)()).toThrow(stop);
    expect(isHeldInCliQueue(bridgeQueue.peek()[0])).toBe(false);
  });

  it('a transcript switch', () => {
    const bridgeQueue = heldQueue();
    const scope: Record<string, unknown> = {
      disarmProvisionalExitWatch: () => {}, bridgeQueue, bridgeTranscriptGeneration: 0,
    };
    loadWorkerFunction<() => void>('beginNewBridgeTranscriptGeneration', scope)();
    expect(isHeldInCliQueue(bridgeQueue.peek()[0])).toBe(false);
  });

  it('restoring turns from the journal after a worker restart', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bridge-hold-restore-'));
    roots.push(dir);
    const path = join(dir, 'aaaaaaaa-1111-4222-8333-444444444444.jsonl');
    const markTimeMs = Date.now() - 60_000;
    appendFileSync(path, JSON.stringify({ type: 'queue-operation', operation: 'enqueue', timestamp: new Date(markTimeMs + 1_000).toISOString(), content: TEXT }) + '\n');
    const bridgeQueue = new BridgeTurnQueue();
    const entry = {
      turnId: 't1', fingerprint: makeFingerprint(TEXT), markTimeMs, contentNormalized: normaliseForFingerprint(TEXT),
    };
    const scope: Record<string, unknown> = {
      bridgeRestoreGate: { mayRestoreOnThisBaseline: () => true }, bridgeTurnJournalFilePath: () => join(dir, 'journal'),
      bridgeJsonlPath: path, readBridgeTurnJournal: () => [entry], selectRestorableBridgeTurns: (e: unknown[]) => e,
      writeBridgeTurnJournal: () => {}, statSync,
      planBridgeTurnRecovery: () => ({ kind: 'recover', fromOffset: 0, recoveryBytes: 1 }),
      drainTranscript, splitTranscriptEventsByCutoff, rememberTurnLinkRefMode: () => {},
      bridgeQueue, bridgeOffset: 0, bridgeBaselineDone: false, observeModelFallbackEvents: () => {}, log: () => {},
    };
    expect(loadWorkerFunction<() => boolean>('tryRestoreInterruptedBridgeTurns', scope)()).toBe(true);
    const restored = bridgeQueue.peek()[0];
    expect(restored.cliQueuedAtMs).toBeDefined(); // the replayed enqueue was seen
    expect(isHeldInCliQueue(restored)).toBe(false); // but proves nothing for the new CLI
  });
});
