import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import {
  buildAttemptDeeplinkEnricher,
  buildWorkflowProgressCard,
  buildWorkflowStartingCard,
  workflowRunDetailUrl,
  type WorkflowProgressCardTerminalLink,
} from '../src/im/lark/workflow-progress-card.js';
import { EventLog, type EventDraft } from '../src/workflows/events/append.js';
import { replay, type Snapshot } from '../src/workflows/events/replay.js';

function emptySnapshot(over: Partial<Snapshot['run']> = {}): Snapshot {
  return {
    run: {
      runId: 'run-x',
      status: 'pending',
      workflowId: 'wf-demo',
      ...over,
    },
    nodes: new Map(),
    activities: new Map(),
    outputs: new Map(),
    lastSeq: 0,
    danglingActivities: [],
    danglingEffectAttempted: [],
  } as unknown as Snapshot;
}

describe('workflow-progress-card', () => {
  it('starting card contains runId + workflowId + ⏳ starting badge', () => {
    const json = buildWorkflowStartingCard({
      runId: 'run-1234567890-abcdef',
      workflowId: 'cancel-dogfood',
    });
    expect(json).toContain('cancel-dogfood');
    expect(json).toContain('run-1234567890');
    expect(json).toContain('⏳ starting');
    // Detail button must always be present.
    expect(json).toContain('Web 详情');
  });

  it('running card shows the 🏃 progress section listing parallel nodes', () => {
    const snap = emptySnapshot({ status: 'running' });
    snap.nodes.set('root', { nodeId: 'root', status: 'succeeded', retryCount: 0, activityId: 'run-x::work::root' });
    snap.nodes.set('branch_x', { nodeId: 'branch_x', status: 'running', retryCount: 0, activityId: 'run-x::work::branch_x' });
    snap.nodes.set('branch_y', { nodeId: 'branch_y', status: 'running', retryCount: 0, activityId: 'run-x::work::branch_y' });
    snap.nodes.set('join', { nodeId: 'join', status: 'idle', retryCount: 0 });
    snap.activities.set('run-x::work::branch_x', {
      activityId: 'run-x::work::branch_x',
      attempts: [],
      status: 'running',
      currentAttemptId: 'run-x::work::branch_x::1',
      ownerNodeId: 'branch_x',
    });
    snap.activities.set('run-x::work::branch_y', {
      activityId: 'run-x::work::branch_y',
      attempts: [],
      status: 'running',
      currentAttemptId: 'run-x::work::branch_y::1',
      ownerNodeId: 'branch_y',
    });

    const json = buildWorkflowProgressCard(snap);
    const parsed = JSON.parse(json);
    expect(parsed.header.template).toBe('blue');
    expect(parsed.header.title.content).toContain('🔄');
    expect(json).toContain('🏃 进行中** (2)');
    // nodeIds contain `_` which the card escapes for lark_md italics safety.
    // Walk parsed elements so we don't have to count JSON backslashes.
    const allText = parsed.elements
      .flatMap((el: any) => [el?.text?.content, ...(el?.fields ?? []).map((f: any) => f?.text?.content)])
      .filter(Boolean)
      .join('\n');
    expect(allText).toMatch(/branch.+x/);
    expect(allText).toMatch(/branch.+y/);
    expect(json).toContain('1 / 4');
  });

  it('waiting card shows the ⏸ 等待审批 section with orange template', () => {
    const snap = emptySnapshot({ status: 'waiting' });
    snap.nodes.set('finalize', {
      nodeId: 'finalize',
      status: 'waiting',
      retryCount: 0,
      activityId: 'run-x::work::finalize',
    });
    snap.activities.set('run-x::work::finalize', {
      activityId: 'run-x::work::finalize',
      attempts: [],
      status: 'waiting',
      currentAttemptId: 'run-x::work::finalize::1',
      ownerNodeId: 'finalize',
    });

    const json = buildWorkflowProgressCard(snap);
    const parsed = JSON.parse(json);
    expect(parsed.header.template).toBe('orange');
    expect(json).toContain('⏸ 等待审批');
    expect(json).toContain('finalize');
  });

  it('failed run renders failure summary + red template', () => {
    const snap = emptySnapshot({
      status: 'failed',
      failedNodeId: 'analyze',
      rootCauseEventId: 'run-x-4',
    });
    snap.nodes.set('analyze', { nodeId: 'analyze', status: 'failed', retryCount: 0 });
    const json = buildWorkflowProgressCard(snap);
    const parsed = JSON.parse(json);
    expect(parsed.header.template).toBe('red');
    expect(json).toContain('💥 失败摘要');
    expect(json).toContain('analyze');
  });

  it('cancelled run renders cancel origin + grey template', () => {
    const snap = emptySnapshot({
      status: 'cancelled',
      cancelOriginEventId: 'run-x-9',
    });
    snap.nodes.set('only', { nodeId: 'only', status: 'cancelled', retryCount: 0 });
    const json = buildWorkflowProgressCard(snap);
    const parsed = JSON.parse(json);
    expect(parsed.header.template).toBe('grey');
    expect(json).toContain('🛑 已取消');
  });

  it('succeeded run has green template + no progress/waiting sections', () => {
    const snap = emptySnapshot({ status: 'succeeded' });
    snap.nodes.set('a', { nodeId: 'a', status: 'succeeded', retryCount: 0 });
    snap.nodes.set('b', { nodeId: 'b', status: 'succeeded', retryCount: 0 });
    const json = buildWorkflowProgressCard(snap);
    const parsed = JSON.parse(json);
    expect(parsed.header.template).toBe('green');
    expect(json).not.toContain('🏃 进行中');
    expect(json).not.toContain('⏸ 等待审批');
    expect(json).toContain('2 / 2');
  });

  it('enrichWithTerminalLink hook adds link when defined, omits when undefined', () => {
    const snap = emptySnapshot({ status: 'running' });
    snap.nodes.set('only', {
      nodeId: 'only',
      status: 'running',
      retryCount: 0,
      activityId: 'run-x::work::only',
    });
    snap.activities.set('run-x::work::only', {
      activityId: 'run-x::work::only',
      attempts: [],
      status: 'running',
      currentAttemptId: 'run-x::work::only::1',
      ownerNodeId: 'only',
    });
    const calls: Array<[string, string]> = [];
    const hook = (activityId: string, attemptId: string): WorkflowProgressCardTerminalLink | undefined => {
      calls.push([activityId, attemptId]);
      return { kind: 'live-terminal', url: 'http://dash/term/abc' };
    };
    const json = buildWorkflowProgressCard(snap, { enrichWithTerminalLink: hook });
    expect(calls).toEqual([['run-x::work::only', 'run-x::work::only::1']]);
    expect(json).toContain('查看当前终端');
    expect(json).toContain('http://dash/term/abc');
  });

  it('enrichWithTerminalLink throwing does not crash the build (codex boundary 1)', () => {
    const snap = emptySnapshot({ status: 'running' });
    snap.nodes.set('only', {
      nodeId: 'only',
      status: 'running',
      retryCount: 0,
      activityId: 'run-x::work::only',
    });
    snap.activities.set('run-x::work::only', {
      activityId: 'run-x::work::only',
      attempts: [],
      status: 'running',
      currentAttemptId: 'run-x::work::only::1',
      ownerNodeId: 'only',
    });
    const json = buildWorkflowProgressCard(snap, {
      enrichWithTerminalLink: () => {
        throw new Error('codex slice 2 not ready');
      },
    });
    // Renders without the link rather than throwing.
    expect(json).toContain('only');
    expect(json).not.toContain('查看当前终端');
    expect(json).not.toContain('查看执行日志');
  });

  // ─── Integration: EventLog → replay → card (codex round 1 blocker) ───
  //
  // Even when the fanout watcher's drain hasn't fired yet (e.g. cleanup
  // raced the final terminal event), the daemon's
  // `updateWorkflowProgressCard(runId)` path replays the EventLog from
  // disk and rebuilds the card.  These two tests prove that pipeline
  // resolves to the expected succeeded/cancelled card body — so the
  // pre-cleanup `await updateWorkflowProgressCard(runId)` we added to
  // `driveWorkflowRun` / `cancelWorkflowRunOnDaemon` / `startRunningCancel`
  // patches the right state even if the watcher never gets to fire.
  describe('terminal patch path: replay-from-disk renders terminal card', () => {
    const RUN_ID = 'run-progress-terminal-test';
    let baseDir: string;
    let log: EventLog;

    beforeEach(() => {
      baseDir = mkdtempSync(join(tmpdir(), 'wf-progress-card-'));
      log = new EventLog(RUN_ID, baseDir);
    });
    afterEach(() => {
      rmSync(baseDir, { recursive: true, force: true });
    });

    const runCreated: EventDraft = {
      runId: RUN_ID,
      type: 'runCreated',
      actor: 'scheduler',
      payload: {
        workflowId: 'wf-progress',
        revisionId: 'rev-001',
        inputRef: { outputHash: 'sha256:' + 'c'.repeat(64), outputBytes: 64, outputSchemaVersion: 1 },
        initiator: 'tester',
      },
    };

    it('runSucceeded log → buildWorkflowProgressCard yields green ✅ card', async () => {
      await log.append(runCreated);
      await log.append({ runId: RUN_ID, type: 'runStarted', actor: 'scheduler', payload: {} });
      await log.append({
        runId: RUN_ID,
        type: 'runSucceeded',
        actor: 'scheduler',
        payload: { outputRef: { outputHash: 'sha256:' + 'd'.repeat(64), outputBytes: 32, outputSchemaVersion: 1 } },
      });
      const snapshot = replay(await log.readAll());
      expect(snapshot.run.status).toBe('succeeded');

      const json = buildWorkflowProgressCard(snapshot);
      const parsed = JSON.parse(json);
      expect(parsed.header.template).toBe('green');
      expect(parsed.header.title.content).toContain('✅');
      expect(json).toContain('wf-progress');
    });

    it('runCanceled log → buildWorkflowProgressCard yields grey 🛑 card', async () => {
      await log.append(runCreated);
      await log.append({
        runId: RUN_ID,
        type: 'runCanceled',
        actor: 'scheduler',
        payload: { cancelOriginEventId: `${RUN_ID}-cancel-1` },
      });
      const snapshot = replay(await log.readAll());
      expect(snapshot.run.status).toBe('cancelled');

      const json = buildWorkflowProgressCard(snapshot);
      const parsed = JSON.parse(json);
      expect(parsed.header.template).toBe('grey');
      expect(parsed.header.title.content).toContain('🛑');
      expect(json).toContain('🛑 已取消');
    });

    // codex round 1 blocker on slice 3: subagent runtime now writes
    // `activityRunning` between attemptCreated and activitySucceeded
    // (runtime.ts slice 3 round 1).  Replay this real event sequence and
    // verify the enricher emits the "查看当前终端" link with the right
    // attemptId — guards against the regression where the link never
    // showed up because activity.status stayed `pending` for the whole
    // attempt lifetime.
    it('subagent runtime event sequence (attemptCreated + activityRunning) → enricher emits link', async () => {
      const ACTIVITY_ID = `${RUN_ID}::work::n1`;
      const ATTEMPT_ID = `${ACTIVITY_ID}::1`;
      const INPUT_REF = { outputHash: 'sha256:' + 'e'.repeat(64), outputBytes: 32, outputSchemaVersion: 1 };

      await log.append(runCreated);
      await log.append({ runId: RUN_ID, type: 'runStarted', actor: 'scheduler', payload: {} });
      await log.append({
        runId: RUN_ID,
        type: 'attemptCreated',
        actor: 'scheduler',
        payload: {
          nodeId: 'n1',
          activityId: ACTIVITY_ID,
          attemptId: ATTEMPT_ID,
          attemptNumber: 1,
          inputRef: INPUT_REF,
        },
      });
      await log.append({
        runId: RUN_ID,
        type: 'activityRunning',
        actor: 'scheduler',
        payload: {
          activityId: ACTIVITY_ID,
          attemptId: ATTEMPT_ID,
          leaseId: `lease-${ATTEMPT_ID}`,
        },
      });
      const snapshot = replay(await log.readAll());
      // Sanity: replay projected both node and activity into 'running'.
      expect(snapshot.activities.get(ACTIVITY_ID)?.status).toBe('running');
      expect(snapshot.nodes.get('n1')?.status).toBe('running');

      const json = buildWorkflowProgressCard(snapshot, {
        enrichWithTerminalLink: buildAttemptDeeplinkEnricher(RUN_ID, snapshot),
      });
      // Link present with the running attempt's URL-encoded attemptId.
      expect(json).toContain('查看当前终端');
      expect(json).toContain(encodeURIComponent(ATTEMPT_ID));
    });
  });

  it('inline rows cap at maxInlineRows with "+N more" trailer', () => {
    const snap = emptySnapshot({ status: 'running' });
    for (let i = 0; i < 10; i++) {
      const id = `n${i}`;
      snap.nodes.set(id, {
        nodeId: id,
        status: 'running',
        retryCount: 0,
        activityId: `run-x::work::${id}`,
      });
      snap.activities.set(`run-x::work::${id}`, {
        activityId: `run-x::work::${id}`,
        attempts: [],
        status: 'running',
        ownerNodeId: id,
      });
    }
    const json = buildWorkflowProgressCard(snap, { maxInlineRows: 4 });
    expect(json).toContain('🏃 进行中** (10)');
    expect(json).toContain('+6 more');
  });

  // ─── Slice 3: buildAttemptDeeplinkEnricher ─────────────────────────────
  //
  // Default enricher used by daemon.ts to wire the card-row link to the
  // dashboard `#/workflows/<runId>?attempt=<attemptId>` deeplink (slice 2
  // contract).  Only `running` activities get a link — anything else
  // returns undefined so users don't click into a Run Detail page that
  // has no terminal sidecar to render.  HostExecutor `effectAttempting`
  // also skips because it has no subagent worker.
  describe('buildAttemptDeeplinkEnricher (slice 3 default hook)', () => {
    const RUN_ID = 'run-slice3-enricher';

    function snapWithActivity(status: 'pending' | 'acquired' | 'running' | 'waiting' | 'effectAttempting' | 'succeeded' | 'failed' | 'cancelled' | 'timedOut'): Snapshot {
      const snap = emptySnapshot({ runId: RUN_ID, status: 'running' });
      snap.activities.set('run-x::work::n1', {
        activityId: 'run-x::work::n1',
        attempts: [],
        status,
        currentAttemptId: 'run-x::work::n1::1',
        ownerNodeId: 'n1',
      });
      return snap;
    }

    it('returns live-terminal link when activity is running', () => {
      const hook = buildAttemptDeeplinkEnricher(RUN_ID, snapWithActivity('running'));
      const link = hook('run-x::work::n1', 'run-x::work::n1::1');
      expect(link).toBeDefined();
      expect(link?.kind).toBe('live-terminal');
      expect(link?.url).toBe(`${workflowRunDetailUrl(RUN_ID)}?attempt=${encodeURIComponent('run-x::work::n1::1')}`);
    });

    it.each([
      'pending',
      'acquired',
      'waiting',
      'effectAttempting',
      'succeeded',
      'failed',
      'cancelled',
      'timedOut',
    ] as const)(
      'returns undefined when activity status is %s (no live web port)',
      (status) => {
        const hook = buildAttemptDeeplinkEnricher(RUN_ID, snapWithActivity(status));
        expect(hook('run-x::work::n1', 'run-x::work::n1::1')).toBeUndefined();
      },
    );

    it('returns undefined when activity is missing from snapshot', () => {
      const snap = emptySnapshot({ runId: RUN_ID, status: 'running' });
      const hook = buildAttemptDeeplinkEnricher(RUN_ID, snap);
      expect(hook('run-x::work::nope', 'run-x::work::nope::1')).toBeUndefined();
    });

    it('URL encodes `::` in attemptId so deeplink survives URL parse', () => {
      const hook = buildAttemptDeeplinkEnricher(RUN_ID, snapWithActivity('running'));
      const link = hook('run-x::work::n1', 'run-x::work::n1::1');
      // `:` itself is fine in hash query strings, but encodeURIComponent
      // turns it into `%3A` — verify the encoding is applied so the
      // dashboard's URLSearchParams parses the `attempt` param cleanly.
      expect(link?.url).toContain('%3A%3A');
    });

    it('integrates with buildWorkflowProgressCard: running row gets the live-terminal link, waiting row does not', () => {
      const snap = emptySnapshot({ runId: RUN_ID, status: 'running' });
      snap.nodes.set('runner', { nodeId: 'runner', status: 'running', retryCount: 0, activityId: 'run-x::work::runner' });
      snap.nodes.set('gate', { nodeId: 'gate', status: 'waiting', retryCount: 0, activityId: 'run-x::work::gate' });
      snap.activities.set('run-x::work::runner', {
        activityId: 'run-x::work::runner', attempts: [], status: 'running',
        currentAttemptId: 'run-x::work::runner::1', ownerNodeId: 'runner',
      });
      snap.activities.set('run-x::work::gate', {
        activityId: 'run-x::work::gate', attempts: [], status: 'waiting',
        currentAttemptId: 'run-x::work::gate::1', ownerNodeId: 'gate',
      });

      const json = buildWorkflowProgressCard(snap, {
        enrichWithTerminalLink: buildAttemptDeeplinkEnricher(RUN_ID, snap),
      });
      // Running row → 查看当前终端 link present.
      expect(json).toContain('查看当前终端');
      // The deeplink must target the running attempt, NOT the gate
      // attempt (gate is waiting → enricher returns undefined).
      expect(json).toContain(encodeURIComponent('run-x::work::runner::1'));
      expect(json).not.toContain(encodeURIComponent('run-x::work::gate::1'));
    });
  });

  // ─── v0.2 loop iteration section (Step 4) ───────────────────────────────
  //
  // Active loop blocks surface a `🔁 循环节点` section so the operator can
  // see "we're on iteration N/M" at a glance.  Settled loops are hidden
  // (the outer card already shows the run-level terminal state).

  describe('loop iteration section', () => {
    function snapshotWithLoop(over: {
      status?: Snapshot['run']['status'];
      loopId?: string;
      iteration?: number;
      maxIterations?: number;
      loopStatus?: 'running' | 'succeeded' | 'failed' | 'cancelled';
      iterStatus?: 'running' | 'approved' | 'rejected' | 'failed' | 'cancelled';
    } = {}): Snapshot {
      const snap = emptySnapshot({ status: over.status ?? 'running' });
      // Inject a `loops` Map onto the empty snapshot.  Tests live close
      // to the replay shape; this mirrors what `replay()` returns once
      // loopStarted / loopIterationStarted have processed.
      const loopId = over.loopId ?? 'review-loop';
      const iteration = over.iteration ?? 1;
      const maxIterations = over.maxIterations ?? 3;
      const loopStatus = over.loopStatus ?? 'running';
      const iterStatus = over.iterStatus ?? 'running';
      (snap as unknown as { loops: Map<string, unknown> }).loops = new Map([
        [
          loopId,
          {
            loopId,
            status: loopStatus,
            iteration,
            maxIterations,
            iterations: Array.from({ length: iteration }, (_, i) => ({
              iteration: i + 1,
              status: i === iteration - 1 ? iterStatus : 'rejected',
              bodyActivityIds: [],
            })),
          },
        ],
      ]);
      return snap;
    }

    it('renders 🔁 循环节点 section with iteration N/M while loop running', () => {
      const snap = snapshotWithLoop({
        loopId: 'review-loop',
        iteration: 2,
        maxIterations: 3,
        iterStatus: 'running',
      });
      const json = buildWorkflowProgressCard(snap);
      expect(json).toContain('🔁 循环节点** (1)');
      expect(json).toContain('iteration 2/3');
      expect(json).toContain('running');
      expect(json).toContain('review-loop');
    });

    it('does NOT render loop section when run is terminal', () => {
      const snap = snapshotWithLoop({
        status: 'succeeded',
        loopStatus: 'succeeded',
        iteration: 1,
        iterStatus: 'approved',
      });
      const json = buildWorkflowProgressCard(snap);
      expect(json).not.toContain('🔁 循环节点');
    });

    it('does NOT render loop section when loop itself is finalized', () => {
      // run still nominally running (parallel branches?) but the only
      // loop in the def has succeeded — collectLoopRows excludes
      // non-running loops.
      const snap = snapshotWithLoop({
        status: 'running',
        loopStatus: 'succeeded',
        iteration: 1,
      });
      const json = buildWorkflowProgressCard(snap);
      expect(json).not.toContain('🔁 循环节点');
    });

    it('clamps iteration to 1 in the gap between startLoop and startLoopIteration', () => {
      // The orchestrator emits startLoop on tick N and
      // startLoopIteration on tick N+1.  The card might render in
      // between (iteration === 0); clamp to 1 so the user doesn't see
      // "iteration 0/3".
      const snap = emptySnapshot({ status: 'running' });
      (snap as unknown as { loops: Map<string, unknown> }).loops = new Map([
        [
          'review-loop',
          {
            loopId: 'review-loop',
            status: 'running',
            iteration: 0, // startLoop fired, startLoopIteration not yet
            maxIterations: 3,
            iterations: [],
          },
        ],
      ]);
      const json = buildWorkflowProgressCard(snap);
      expect(json).toContain('iteration 1/3');
    });

    it('handles workflow with no loops (loops field absent)', () => {
      // Backward-compat: emptySnapshot doesn't set `loops` at all;
      // collectLoopRows must treat that as "no loops" without throwing.
      const snap = emptySnapshot({ status: 'running' });
      const json = buildWorkflowProgressCard(snap);
      expect(json).not.toContain('🔁 循环节点');
      // sanity — the rest of the card still renders
      expect(json).toContain('Web 详情');
    });
  });
});
