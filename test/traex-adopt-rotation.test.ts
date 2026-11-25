import { appendFileSync, existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { CodexBridgeQueue } from '../src/services/codex-bridge-queue.js';
import { splitCodexEventsByCutoff } from '../src/services/codex-transcript.js';
import { drainTraexRollout, splitTraexAdoptEvents, traexSessionIdFromRolloutPath } from '../src/services/traex-transcript.js';
import { bindTraexSessionFromCorrelatedInput, traexTerminalIdentityGeneration, traexTerminalSessionIsBound } from '../src/services/traex-terminal-session.js';
import { loadWorkerFunction } from './helpers/worker-function-harness.js';

afterEach(() => vi.useRealTimers());

it('retains an in-flight adopted task, then keeps immediate and delayed local resumes behind their own history watermark', async () => {
  vi.useFakeTimers();
  const adoption = Date.now();
  const ids = ['00000000-0000-7000-8000-000000000001', '00000000-0000-7000-8000-000000000002', '00000000-0000-7000-8000-000000000003'];
  const root = mkdtempSync(join(tmpdir(), 'traex-adopt-rotation-'));
  try {
    const paths = ids.map(id => join(root, `rollout-${id}.jsonl`));
    const line = (at: number, payload: object) => JSON.stringify({ timestamp: new Date(at).toISOString(), type: 'event_msg', payload }) + '\n';
    writeFileSync(paths[0]!, line(adoption - 60000, { type: 'user_message', message: 'running before adoption', turn_id: 'inflight' }));
    const terminal = { cliPid: 43212, write: vi.fn() };
    const queue = new CodexBridgeQueue(() => Date.now());
    let available = new Map([[ids[0]!, paths[0]!]]);
    const scope: Record<string, any> = {
      lastInitConfig: { cliId: 'traex', adoptMode: true, workingDir: root }, backend: terminal,
      currentTraexObservedPid: () => 43212,
      codexBridgeQueue: queue, structuredBridgeIs: (id: string) => id === 'traex',
      resolveFileBridgePath: (_id: string, hint: any) => available.get(hint.sessionId),
      persistCliSessionId: vi.fn(), codexBridgeStartTimer: vi.fn(),
      nativeSessionForkPending: () => false, codexSubagentLimitTracker: { clear() {} },
      existsSync, statSync, structuredBridgeIngestPath: drainTraexRollout, splitCodexEventsByCutoff, splitTraexAdoptEvents,
      codexAdoptJournalPath: () => undefined, structuredBridgeJournalPath: () => undefined,
      OrcaBackend: class {}, log: vi.fn(), publishActiveRuntime: vi.fn(), fsWatch: () => ({ close() {} }),
      checkpointStructuredBridgeRecovery: vi.fn(), pruneExpiredStructuredHeadsAndEmit: vi.fn(),
      maybeEmitCodexAdoptPreamble: vi.fn(), idleDetector: { fireIdle: vi.fn() },
      codexBridgeFallbackActive: () => true, codexBridgeUsesSplitLiveAttach: () => true,
      traexHistorySidOwnedByCurrentPid: (id: string) => traexTerminalSessionIsBound(terminal, id),
      traexSessionIdFromRolloutPath, codexBridgeIngest: vi.fn(), emitReadyCodexTurns: vi.fn(),
    };
    for (const name of ['codexBridgeAttach', 'codexBridgeDetachFile', 'setupAdoptFileBridge', 'codexBridgeNotifyCliSessionId']) {
      scope[name] = loadWorkerFunction(name, scope);
    }
    scope.setupAdoptFileBridge({ cliId: 'traex', adoptMode: true, adoptCliPid: 43212, workingDir: root }, { attach: 'split-live' });
    expect(scope.codexBridgeRolloutPath).toBeUndefined();
    await vi.advanceTimersByTimeAsync(10000);
    appendFileSync(paths[0]!, line(Date.now(), { type: 'task_complete', turn_id: 'inflight', last_agent_message: 'finished after adoption' }));
    bindTraexSessionFromCorrelatedInput(terminal, 43212, ids[0]!, traexTerminalIdentityGeneration(terminal));
    scope.codexBridgeNotifyCliSessionId(ids[0]);
    expect(scope.codexBridgeRolloutPath).toBe(paths[0]);
    expect(queue.drainEmittable()).toEqual([expect.objectContaining({ finalText: 'finished after adoption' })]);

    writeFileSync(paths[1]!, line(adoption - 30000, { type: 'user_message', message: 'old input', turn_id: 'old' })
      + line(adoption - 29000, { type: 'task_complete', turn_id: 'old', last_agent_message: 'old completed answer' }));
    available.set(ids[1]!, paths[1]!);
    bindTraexSessionFromCorrelatedInput(terminal, 43212, ids[1]!, traexTerminalIdentityGeneration(terminal));
    scope.codexBridgeNotifyCliSessionId(ids[1]);
    expect(scope.codexBridgeRolloutPath).toBe(paths[1]);
    expect(queue.drainEmittable()).toEqual([]);

    await vi.advanceTimersByTimeAsync(30000);
    const rotation = Date.now();
    writeFileSync(paths[2]!, line(adoption + 20000, { type: 'user_message', message: 'before local resume', turn_id: 'other-old' })
      + line(adoption + 21000, { type: 'task_complete', turn_id: 'other-old', last_agent_message: 'must not replay' }));
    bindTraexSessionFromCorrelatedInput(terminal, 43212, ids[2]!, traexTerminalIdentityGeneration(terminal));
    scope.codexBridgeNotifyCliSessionId(ids[2], { adoptRotationStartMs: rotation });
    expect(scope.codexBridgeRolloutPath).toBeUndefined();
    expect(scope.codexAdoptStartMs).toBe(rotation);
    await vi.advanceTimersByTimeAsync(5000);
    available = new Map([[ids[2]!, paths[2]!]]);
    scope.codexBridgeNotifyCliSessionId(ids[2]);
    expect(scope.codexBridgeRolloutPath).toBe(paths[2]);
    expect(scope.codexBridgeOffset).toBe(statSync(paths[2]!).size);
    expect(queue.drainEmittable()).toEqual([]);

    const offset = scope.codexBridgeOffset;
    appendFileSync(paths[2]!, line(Date.now() + 1000, { type: 'user_message', message: 'after local resume', turn_id: 'new' })
      + line(Date.now() + 2000, { type: 'task_complete', turn_id: 'new', last_agent_message: 'new completed answer' }));
    queue.ingest(drainTraexRollout(paths[2]!, offset).events);
    expect(queue.drainEmittable()).toEqual([expect.objectContaining({ finalText: 'new completed answer', sourceTurnId: 'new' })]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it('splits an immediate rotation attach so the next ingest cannot replay the retired session', async () => {
  vi.useFakeTimers();
  const now = Date.now();
  const ids = ['00000000-0000-7000-8000-000000000011', '00000000-0000-7000-8000-000000000012'];
  const root = mkdtempSync(join(tmpdir(), 'traex-adopt-immediate-rotation-'));
  try {
    const paths = ids.map(id => join(root, `rollout-${id}.jsonl`));
    const line = (at: number, payload: object) => JSON.stringify({ timestamp: new Date(at).toISOString(), type: 'event_msg', payload }) + '\n';
    writeFileSync(paths[0]!, line(now - 60000, { type: 'user_message', message: 'first session input', turn_id: 't1' })
      + line(now - 50000, { type: 'task_complete', turn_id: 't1', last_agent_message: 'first session answer' }));
    // The new session's rollout already exists when the rotation is reported.
    writeFileSync(paths[1]!, line(now - 40000, { type: 'user_message', message: 'resumed session input', turn_id: 't2' })
      + line(now - 30000, { type: 'task_complete', turn_id: 't2', last_agent_message: 'resumed session answer' }));
    const terminal = { cliPid: 43212, write: vi.fn() };
    const queue = new CodexBridgeQueue(() => Date.now());
    queue.setLocalTurns(true, now);
    const available = new Map(ids.map((id, i) => [id, paths[i]!]));
    const scope: Record<string, any> = {
      lastInitConfig: { cliId: 'traex', adoptMode: true, workingDir: root }, backend: terminal,
      currentTraexObservedPid: () => 43212,
      codexBridgeQueue: queue, structuredBridgeIs: (id: string) => id === 'traex',
      resolveFileBridgePath: (_id: string, hint: any) => available.get(hint.sessionId),
      persistCliSessionId: vi.fn(), codexBridgeStartTimer: vi.fn(),
      nativeSessionForkPending: () => false, codexSubagentLimitTracker: { clear() {} },
      existsSync, statSync, structuredBridgeIngestPath: drainTraexRollout, splitCodexEventsByCutoff, splitTraexAdoptEvents,
      codexAdoptJournalPath: () => undefined, structuredBridgeJournalPath: () => undefined,
      OrcaBackend: class {}, log: vi.fn(), publishActiveRuntime: vi.fn(), fsWatch: () => ({ close() {} }),
      checkpointStructuredBridgeRecovery: vi.fn(), pruneExpiredStructuredHeadsAndEmit: vi.fn(),
      maybeEmitCodexAdoptPreamble: vi.fn(), idleDetector: { fireIdle: vi.fn() },
      codexBridgeFallbackActive: () => true, codexBridgeUsesSplitLiveAttach: () => true,
      traexHistorySidOwnedByCurrentPid: (id: string) => traexTerminalSessionIsBound(terminal, id),
      traexSessionIdFromRolloutPath, codexBridgeIngest: vi.fn(), emitReadyCodexTurns: vi.fn(),
    };
    for (const name of ['codexBridgeAttach', 'codexBridgeDetachFile', 'setupAdoptFileBridge', 'codexBridgeNotifyCliSessionId']) {
      scope[name] = loadWorkerFunction(name, scope);
    }
    bindTraexSessionFromCorrelatedInput(terminal, 43212, ids[0]!, traexTerminalIdentityGeneration(terminal));
    scope.setupAdoptFileBridge({ cliId: 'traex', adoptMode: true, adoptCliPid: 43212, workingDir: root, cliSessionId: ids[0]! }, { attach: 'split-live' });
    expect(scope.codexBridgeRolloutPath).toBe(paths[0]);
    queue.drainEmittable();

    bindTraexSessionFromCorrelatedInput(terminal, 43212, ids[1]!, traexTerminalIdentityGeneration(terminal));
    scope.codexBridgeNotifyCliSessionId(ids[1], { adoptRotationStartMs: now });
    expect(scope.codexBridgeRolloutPath).toBe(paths[1]);
    // split-live baselines the existing rollout to EOF; a fresh-empty attach
    // would leave the offset at 0 and make every tick re-read retired bytes.
    expect(scope.codexBridgeOffset).toBe(statSync(paths[1]!).size);
    expect(queue.drainEmittable()).toEqual([]);

    // A fresh-empty attach would leave the offset at 0, so the next tick would
    // re-read the retired session's completed answer as a live local turn.
    const nextTickEvents = drainTraexRollout(paths[1]!, scope.codexBridgeOffset).events;
    queue.ingest(nextTickEvents);
    expect(queue.drainEmittable()).toEqual([]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it('settles an already-completed Lark rotation from its literal write watermark', () => {
  vi.useFakeTimers();
  const notifiedAt = Date.now();
  const writeAt = notifiedAt - 10_000;
  const adoptedAt = notifiedAt - 60_000;
  const ids = ['00000000-0000-7000-8000-000000000021', '00000000-0000-7000-8000-000000000022'];
  const root = mkdtempSync(join(tmpdir(), 'traex-adopt-late-receipt-'));
  try {
    const paths = ids.map(id => join(root, `rollout-${id}.jsonl`));
    writeFileSync(paths[0]!, '');
    const line = (at: number, payload: object) => JSON.stringify({ timestamp: new Date(at).toISOString(), type: 'event_msg', payload }) + '\n';
    writeFileSync(paths[1]!,
      line(writeAt, { type: 'user_message', message: 'Lark task B', turn_id: 'turn-b' })
      + line(writeAt + 100, { type: 'task_complete', turn_id: 'turn-b', last_agent_message: 'answer B' }));
    const terminal = { cliPid: 43212, write: vi.fn() };
    const queue = new CodexBridgeQueue(() => Date.now());
    const available = new Map(ids.map((id, index) => [id, paths[index]!]));
    const scope: Record<string, any> = {
      lastInitConfig: { cliId: 'traex', adoptMode: true, workingDir: root }, backend: terminal,
      currentTraexObservedPid: () => 43212,
      codexBridgeQueue: queue, structuredBridgeIs: (id: string) => id === 'traex',
      resolveFileBridgePath: (_id: string, hint: any) => available.get(hint.sessionId),
      persistCliSessionId: vi.fn(), codexBridgeStartTimer: vi.fn(),
      nativeSessionForkPending: () => false, codexSubagentLimitTracker: { clear() {} },
      existsSync, statSync, structuredBridgeIngestPath: drainTraexRollout, splitCodexEventsByCutoff, splitTraexAdoptEvents,
      codexAdoptJournalPath: () => undefined, structuredBridgeJournalPath: () => undefined,
      OrcaBackend: class {}, log: vi.fn(), publishActiveRuntime: vi.fn(), fsWatch: () => ({ close() {} }),
      checkpointStructuredBridgeRecovery: vi.fn(), pruneExpiredStructuredHeadsAndEmit: vi.fn(),
      maybeEmitCodexAdoptPreamble: vi.fn(), idleDetector: { fireIdle: vi.fn() },
      codexBridgeFallbackActive: () => true, codexBridgeUsesSplitLiveAttach: () => true,
      traexHistorySidOwnedByCurrentPid: (id: string) => traexTerminalSessionIsBound(terminal, id),
      traexSessionIdFromRolloutPath, codexBridgeIngest: vi.fn(), emitReadyCodexTurns: vi.fn(),
    };
    for (const name of ['codexBridgeAttach', 'codexBridgeDetachFile', 'setupAdoptFileBridge', 'codexBridgeNotifyCliSessionId']) {
      scope[name] = loadWorkerFunction(name, scope);
    }
    scope.setupAdoptFileBridge({ cliId: 'traex', adoptMode: true, adoptCliPid: 43212, workingDir: root, cliSessionId: ids[0]! }, { attach: 'split-live' }, adoptedAt);
    queue.mark('om-b', 'Lark task B', writeAt);
    bindTraexSessionFromCorrelatedInput(terminal, 43212, ids[1]!, traexTerminalIdentityGeneration(terminal));
    scope.codexBridgeNotifyCliSessionId(ids[1], { adoptRotationStartMs: writeAt });
    queue.confirmPendingTurn('om-b');
    expect(queue.drainEmittable()).toEqual([
      expect.objectContaining({ turnId: 'om-b', finalText: 'answer B', sourceTurnId: 'turn-b' }),
    ]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
