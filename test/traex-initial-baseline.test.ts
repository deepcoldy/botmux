import { appendFileSync, existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { loadWorkerFunction } from './helpers/worker-function-harness.js';
import { baselineJsonlCursor } from '../src/services/jsonl-cursor.js';
import { drainTraexRollout, readLatestTraexRuntime } from '../src/services/traex-transcript.js';
import { CodexBridgeQueue } from '../src/services/codex-bridge-queue.js';
import { planBridgeTurnRecovery } from '../src/services/bridge-turn-journal.js';
import { splitCodexEventsByCutoff } from '../src/services/codex-transcript.js';

it.each([false, true])('keeps a live turn written before resumed PID discovery, with mark cursor=%s', cursorKnown => {
  const dir = mkdtempSync(join(tmpdir(), 'traex-initial-baseline-'));
  try {
    const path = join(dir, 'rollout-00000000-0000-7000-8000-000000000001.jsonl');
    const now = 946684900000;
    const event = (at: number, payload: object) => JSON.stringify({ timestamp: new Date(at).toISOString(), type: 'event_msg', payload }) + '\n';
    writeFileSync(path, event(now - 60000, { type: 'user_message', message: 'Old question', turn_id: 'old' })
      + event(now - 59000, { type: 'task_complete', turn_id: 'old', last_agent_message: 'Old answer', completed_at: (now - 59000) / 1000 }));
    const queue = new CodexBridgeQueue(() => now);
    queue.mark('om_live', 'New question', now, undefined,
      cursorKnown ? { jsonlPath: path, offsetAtMark: baselineJsonlCursor(path).newOffset } : undefined);
    appendFileSync(path, event(now, { type: 'user_message', message: 'New question', turn_id: 'new' })
      + event(now + 1000, { type: 'task_complete', turn_id: 'new', last_agent_message: 'New answer', completed_at: (now + 1000) / 1000 }));
    const scope: Record<string, any> = {
      lastInitConfig: { cliId: 'traex', adoptMode: false }, backend: {}, lastSpawnEffectiveResume: true,
      structuredBridgeIs: (id: string) => id === 'traex', codexBridgeRolloutPath: undefined,
      traexBridgePidProbeLastMs: 0, TRAEX_BRIDGE_PID_PROBE_INTERVAL_MS: 5000,
      currentTraexObservedPid: () => 10, traexSessionIdFromRolloutPath: () => 'owned',
      findTraexRolloutByPid: () => ({ path, cliSessionId: 'owned' }), persistCliSessionId: vi.fn(),
      codexBridgeNotifyCliSessionId: vi.fn(), codexBridgePendingSessionId: undefined,
      log: vi.fn(), nativeSessionForkPending: () => false, codexSubagentLimitTracker: { clear() {} },
      existsSync, statSync, scanRestartInterruption: vi.fn(), structuredBridgeJournalPath: () => undefined,
      codexAdoptJournalPath: () => undefined, baselineJsonlCursor, publishActiveRuntime: vi.fn(),
      readLatestTraexRuntime, fsWatch: () => ({ close() {} }), codexBridgeStartTimer: vi.fn(),
      checkpointStructuredBridgeRecovery: vi.fn(), codexBridgeQueue: queue, planBridgeTurnRecovery,
      splitCodexEventsByCutoff, structuredBridgeIngestPath: drainTraexRollout,
      emitReadyCodexTurns: vi.fn(), idleDetector: { fireIdle: vi.fn() },
    };
    scope.codexBridgeAttach = loadWorkerFunction('codexBridgeAttach', scope);
    loadWorkerFunction<() => void>('maybeFollowTraexSessionRotationViaPid', scope)();
    expect(scope.codexBridgeOffset).toBe(statSync(path).size);
    expect(queue.drainEmittable()).toEqual([expect.objectContaining({ turnId: 'om_live', finalText: 'New answer' })]);
    expect(scope.codexBridgeNotifyCliSessionId).not.toHaveBeenCalled();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
