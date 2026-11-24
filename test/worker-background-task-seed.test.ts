/**
 * A worker that re-attached to a surviving Claude CLI rebuilds its background
 * tasks from the transcript, and its turn_terminal reports how many still run.
 */
import { afterAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ActiveTurnAuthority } from '../src/core/active-turn-authority.js';
import { TurnTerminalDeduper } from '../src/services/turn-terminal-deduper.js';
import { BackgroundTaskTracker, type TranscriptEvent } from '../src/services/claude-transcript.js';
import { scanJsonlFromOffset } from '../src/services/jsonl-cursor.js';
import { loadWorkerFunction } from './helpers/worker-function-harness.js';

const dir = mkdtempSync(join(tmpdir(), 'bmx-bgseed-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const CLI_STARTED = Date.parse('2026-11-24T10:00:00.000Z');
const iso = (offsetMs: number) => new Date(CLI_STARTED + offsetMs).toISOString();

const prompt = (offsetMs: number): TranscriptEvent => ({
  type: 'user', uuid: `p${offsetMs}`, timestamp: iso(offsetMs), isSidechain: false,
  message: { role: 'user', content: 'run the workflow' },
} as TranscriptEvent);
const workflowLaunch = (offsetMs: number): TranscriptEvent => ({
  type: 'user', uuid: `l${offsetMs}`, timestamp: iso(offsetMs), isSidechain: false,
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'launched' }] },
  toolUseResult: { status: 'async_launched', taskId: 'wf1', taskType: 'local_workflow', runId: 'run1' },
} as TranscriptEvent);
const finalAnswer = (offsetMs: number): TranscriptEvent => ({
  type: 'assistant', uuid: `a${offsetMs}`, timestamp: iso(offsetMs), isSidechain: false,
  message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'started' }] },
} as TranscriptEvent);
const turnDuration = (offsetMs: number): TranscriptEvent => ({
  type: 'system', subtype: 'turn_duration', uuid: `d${offsetMs}`, timestamp: iso(offsetMs), isSidechain: false,
} as TranscriptEvent);
const workflowDone = (offsetMs: number): TranscriptEvent => ({
  type: 'queue-operation', operation: 'enqueue', timestamp: iso(offsetMs),
  content: '<task-notification>\n<task-id>wf1</task-id>\n<status>completed</status>\n<summary>s</summary>\n</task-notification>',
} as TranscriptEvent);

function seed(events: TranscriptEvent[], liveCliStartedAtMs: number | undefined) {
  const path = join(dir, `${Math.random().toString(36).slice(2)}.jsonl`);
  writeFileSync(path, events.map(ev => JSON.stringify(ev)).join('\n') + '\n');
  const tracker = new BackgroundTaskTracker();
  const scope: Record<string, any> = {
    lastInitConfig: { cliId: 'claude-code' },
    bridgeLiveCliStartedAtMs: liveCliStartedAtMs,
    bridgeJsonlPath: path,
    existsSyncSafe: () => true,
    scanJsonlFromOffset,
    backgroundTaskTracker: tracker,
    refreshBackgroundWait: () => {},
    log: vi.fn(),
  };
  loadWorkerFunction<() => void>('seedBackgroundTasksFromTranscript', scope)();
  return tracker;
}

describe('re-attach background task seed', () => {
  const launchedAndEnded = [prompt(1_000), workflowLaunch(2_000), finalAnswer(3_000), turnDuration(3_100)];

  it('finds a Workflow launched after the CLI started, which is still running', () => {
    const tracker = seed(launchedAndEnded, CLI_STARTED);
    expect(tracker.pending(CLI_STARTED + 10_000)).toBe(1);
    expect(tracker.backgroundWait(CLI_STARTED + 10_000)).toBe(1);
  });

  it('finds a launch followed by many megabytes of later conversation', () => {
    const filler = Array.from({ length: 40 }, (_, i) => ({
      ...finalAnswer(2_100 + i),
      message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'text', text: 'x'.repeat(256 * 1024) }] },
    } as TranscriptEvent));
    const tracker = seed([prompt(1_000), workflowLaunch(2_000), ...filler, finalAnswer(3_000), turnDuration(3_100)], CLI_STARTED);
    expect(tracker.backgroundWait(CLI_STARTED + 10_000)).toBe(1);
  });

  it('ignores a launch that predates the CLI process', () => {
    expect(seed(launchedAndEnded, CLI_STARTED + 2_500).pending(CLI_STARTED + 10_000)).toBe(0);
  });

  it('finds nothing once the Workflow reported its completion', () => {
    expect(seed([...launchedAndEnded, workflowDone(5_000)], CLI_STARTED).pending(CLI_STARTED + 10_000)).toBe(0);
  });

  it('leaves a worker that did not re-attach alone', () => {
    expect(seed(launchedAndEnded, undefined).pending(CLI_STARTED + 10_000)).toBe(0);
  });
});

describe('turn_terminal background task count', () => {
  function terminalFor(status: 'completed' | 'failed', running: number) {
    const scope: Record<string, any> = {
      sessionId: 'sid',
      currentBotmuxTurnId: undefined,
      currentBotmuxDispatchAttempt: undefined,
      queuedTypeAheadTurns: [],
      retiredTurnIds: new Set<string>(),
      activeTurnAuthority: new ActiveTurnAuthority(),
      emittedTurnTerminals: new TurnTerminalDeduper(),
      submitFailureChains: new Map(),
      cliSpawnGeneration: 1,
      cancelSubmitFailureChainForTerminal: vi.fn(),
      turnExecutionClock: { settle: () => ({ completedAtMs: 1000, durationMs: 5 }), forget: vi.fn() },
      codexBridgeQueue: { dropPendingTurn: () => false },
      terminalReleasesDurableTurn: () => false,
      remoteRunnerRecoveredTurnInFlight: false,
      flushPending: vi.fn(),
      queueMicrotask: (fn: () => void) => fn(),
      syncQueuedTurnsFromMarkerDisk: () => false,
      crossPrincipalIsolationOn: () => false,
      backgroundTaskTracker: { backgroundWait: () => running },
      send: vi.fn(),
      log: vi.fn(),
    };
    scope.markTurnRetired = (turnId?: string) => { if (turnId) scope.retiredTurnIds.add(turnId); };
    for (const name of [
      'turnAuthorityIdentity', 'adoptActiveTurnWhenIsolationOff', 'activeTurnBlocks', 'markActiveTurnStarted',
      'releaseActiveTurnAuthority', 'releaseTerminatedActiveTurnAuthority', 'retireTerminatedQueuedTurn',
      'advanceQueuedTypeAheadTurn', 'emitTurnTerminal', 'dropQueuedTurnRecord', 'turnTerminalEmitted',
      'retireTerminatedMarkerTurn',
    ]) scope[name] = loadWorkerFunction(name, scope);
    scope.emitTurnTerminal('om_t', status, status === 'failed' ? 'provider_x' : undefined, 1);
    return scope.send.mock.calls.map((call: any[]) => call[0]).find((m: any) => m.type === 'turn_terminal');
  }

  it('reports the running background tasks on a completed turn', () => {
    expect(terminalFor('completed', 2)).toMatchObject({ status: 'completed', backgroundTasks: 2 });
  });

  it('omits the count when nothing runs or the turn did not complete', () => {
    expect(terminalFor('completed', 0)).not.toHaveProperty('backgroundTasks');
    expect(terminalFor('failed', 2)).not.toHaveProperty('backgroundTasks');
  });
});
