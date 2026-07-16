import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { validateDag } from '../src/workflows/v3/dag.js';
import { appendEvent, readJournal, type StoredEvent, type V3Event } from '../src/workflows/v3/journal.js';
import { runWorkflow, type V3RuntimeDeps } from '../src/workflows/v3/runtime.js';
import { materialize } from '../src/workflows/v3/state.js';
import type { BotSnapshot, RunNode } from '../src/workflows/v3/contract.js';
import {
  activateV3AttemptWorkerFence,
  armV3AttemptWorkerFence,
  closeV3ArmedFenceWithoutSpawn,
  readV3AttemptWorkerFence,
} from '../src/workflows/v3/worker-fence.js';
import { readProcessStartIdentity } from '../src/core/session-marker.js';

const resolveBotSnapshot = (): BotSnapshot => ({
  larkAppId: 'cli_test',
  cliId: 'claude-code',
  workingDir: '/tmp',
});

function cancelLoopDag(runId: string) {
  return validateDag({
    runId,
    nodes: [{
      id: 'fix',
      type: 'loop',
      maxIterations: 2,
      body: {
        nodes: [{
          id: 'verify',
          type: 'goal',
          goal: 'verify',
          resultSchema: {
            type: 'object',
            properties: { passed: { type: 'boolean' } },
            required: ['passed'],
          },
        }],
      },
      exit: { node: 'verify', when: { path: 'result.passed', equals: true } },
      output: { from: 'verify' },
    }],
  });
}

function stored(ts: number, event: V3Event): StoredEvent {
  return { ...event, ts } as StoredEvent;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('condition did not become true');
}

describe('v3 run cancellation — journal cut semantics', () => {
  it('first request wins, pre-cut success stays committed, and late worker settles are ignored', () => {
    const events: StoredEvent[] = [
      stored(1, { type: 'runStarted', runId: 'cancel-cut' }),
      stored(2, { type: 'nodeDispatched', nodeId: 'done-first', attemptId: 'done-first/attempts/001' }),
      stored(3, {
        type: 'nodeSucceeded',
        nodeId: 'done-first',
        attemptId: 'done-first/attempts/001',
        manifestPath: '/tmp/done-first.json',
      }),
      stored(4, { type: 'nodeDispatched', nodeId: 'in-flight', attemptId: 'in-flight/attempts/001' }),
      stored(5, { type: 'runCancelRequested', cancelRequestId: 'cancel-first', by: 'ou_first' }),
      // Both are stale relative to the durable cut and must not revive/fail the run.
      stored(6, {
        type: 'nodeSucceeded',
        nodeId: 'in-flight',
        attemptId: 'in-flight/attempts/001',
        manifestPath: '/tmp/late.json',
      }),
      stored(7, { type: 'runCancelRequested', cancelRequestId: 'cancel-second', by: 'ou_second' }),
      stored(8, {
        type: 'nodeCancelled',
        nodeId: 'in-flight',
        attemptId: 'in-flight/attempts/001',
        reason: 'runCancelled',
        cancelRequestId: 'cancel-first',
      }),
      stored(9, { type: 'runCancelled', cancelRequestId: 'cancel-second', by: 'ou_second' }),
      stored(10, { type: 'runCancelled', cancelRequestId: 'cancel-first', by: 'ou_first' }),
      stored(11, {
        type: 'nodeFailed',
        nodeId: 'in-flight',
        attemptId: 'in-flight/attempts/001',
        errorClass: 'workerError',
        message: 'late failure',
      }),
    ];

    const snap = materialize(events);
    expect(snap.runStatus).toBe('cancelled');
    expect(snap.cancelRequestId).toBe('cancel-first');
    expect(snap.cancelRequestedBy).toBe('ou_first');
    expect(snap.nodes.get('done-first')?.status).toBe('done');
    expect(snap.nodes.get('in-flight')?.status).toBe('cancelled');
  });

  it('a true run terminal committed before cancel wins', () => {
    const snap = materialize([
      stored(1, { type: 'runStarted', runId: 'terminal-first' }),
      stored(2, { type: 'runSucceeded' }),
      stored(3, { type: 'runCancelRequested', cancelRequestId: 'too-late', by: 'ou_user' }),
      stored(4, { type: 'runCancelled', cancelRequestId: 'too-late', by: 'ou_user' }),
    ]);

    expect(snap.runStatus).toBe('succeeded');
    expect(snap.cancelRequestId).toBeUndefined();
  });
});

describe('runWorkflow — durable cancellation convergence', () => {
  it('recovers a journal-running attempt only after its durable no-spawn fence proves closure', async () => {
    const base = mkdtempSync(join(tmpdir(), 'v3-cancel-fence-closed-'));
    try {
      const dag = validateDag({
        runId: 'cancel-fence-closed',
        nodes: [{ id: 'active', type: 'goal', goal: 'wait', depends: [], inputs: [] }],
      });
      const runDir = join(base, dag.runId);
      const attemptId = 'active/attempts/001';
      const attemptDir = join(runDir, attemptId);
      mkdirSync(attemptDir, { recursive: true });
      const armed = armV3AttemptWorkerFence({ attemptDir, runId: dag.runId, attemptId });
      closeV3ArmedFenceWithoutSpawn(attemptDir, armed, 'setup_failed');
      const journalPath = join(runDir, 'journal.ndjson');
      appendEvent(journalPath, { type: 'runStarted', runId: dag.runId });
      appendEvent(journalPath, { type: 'nodeDispatched', nodeId: 'active', attemptId });
      appendEvent(journalPath, { type: 'nodeWorkerFenceArmed', nodeId: 'active', attemptId });
      appendEvent(journalPath, {
        type: 'runCancelRequested', cancelRequestId: 'cancel-fenced', by: 'other-daemon',
      });
      const runNode = vi.fn<RunNode>();

      await expect(runWorkflow(dag, {
        runNode,
        validateManifest: async () => ({ ok: false, problems: ['unexpected'] }),
        resolveBotSnapshot,
      }, { baseDir: base })).resolves.toMatchObject({ runStatus: 'cancelled' });

      expect(runNode).not.toHaveBeenCalled();
      expect(readV3AttemptWorkerFence(attemptDir, { runId: dag.runId, attemptId })).toBeNull();
      expect(materialize(readJournal(journalPath)).nodes.get('active')?.status).toBe('cancelled');
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('repairs a self-owned armed recovery fence after the discovered worker vanished', async () => {
    if (process.platform !== 'linux') return;
    const base = mkdtempSync(join(tmpdir(), 'v3-cancel-fence-self-armed-'));
    try {
      const dag = validateDag({
        runId: 'cancel-fence-self-armed',
        nodes: [{ id: 'active', type: 'goal', goal: 'wait', depends: [], inputs: [] }],
      });
      const runDir = join(base, dag.runId);
      const attemptId = 'active/attempts/001';
      const attemptDir = join(runDir, attemptId);
      mkdirSync(attemptDir, { recursive: true });
      armV3AttemptWorkerFence({ attemptDir, runId: dag.runId, attemptId });
      const journalPath = join(runDir, 'journal.ndjson');
      appendEvent(journalPath, { type: 'runStarted', runId: dag.runId });
      appendEvent(journalPath, { type: 'nodeDispatched', nodeId: 'active', attemptId });
      appendEvent(journalPath, { type: 'nodeWorkerFenceArmed', nodeId: 'active', attemptId });
      appendEvent(journalPath, {
        type: 'runCancelRequested', cancelRequestId: 'cancel-self-armed', by: 'other-daemon',
      });

      await expect(runWorkflow(dag, {
        runNode: vi.fn<RunNode>(),
        validateManifest: async () => ({ ok: false, problems: ['unexpected'] }),
        resolveBotSnapshot,
      }, { baseDir: base })).resolves.toMatchObject({ runStatus: 'cancelled' });

      expect(readV3AttemptWorkerFence(attemptDir, { runId: dag.runId, attemptId })).toBeNull();
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('signals and waits for an externally-owned active worker before runCancelled', async () => {
    const base = mkdtempSync(join(tmpdir(), 'v3-cancel-fence-active-'));
    let child: ChildProcess | undefined;
    try {
      const dag = validateDag({
        runId: 'cancel-fence-active',
        nodes: [{ id: 'active', type: 'goal', goal: 'wait', depends: [], inputs: [] }],
      });
      const runDir = join(base, dag.runId);
      const attemptId = 'active/attempts/001';
      const attemptDir = join(runDir, attemptId);
      mkdirSync(attemptDir, { recursive: true });
      child = spawn(process.execPath, ['-e', "process.on('SIGINT',()=>process.exit(0));setInterval(()=>{},1000)"], {
        stdio: 'ignore',
      });
      if (!child.pid) throw new Error('child pid unavailable');
      await waitFor(() => readProcessStartIdentity(child!.pid!) !== undefined);
      const armed = armV3AttemptWorkerFence({ attemptDir, runId: dag.runId, attemptId });
      activateV3AttemptWorkerFence({ attemptDir, armed, workerPid: child.pid });
      const journalPath = join(runDir, 'journal.ndjson');
      appendEvent(journalPath, { type: 'runStarted', runId: dag.runId });
      appendEvent(journalPath, { type: 'nodeDispatched', nodeId: 'active', attemptId });
      appendEvent(journalPath, { type: 'nodeWorkerFenceArmed', nodeId: 'active', attemptId });
      appendEvent(journalPath, {
        type: 'runCancelRequested', cancelRequestId: 'cancel-external-worker', by: 'other-daemon',
      });

      await expect(runWorkflow(dag, {
        runNode: vi.fn<RunNode>(),
        validateManifest: async () => ({ ok: false, problems: ['unexpected'] }),
        resolveBotSnapshot,
      }, { baseDir: base })).resolves.toMatchObject({ runStatus: 'cancelled' });
      if (child.exitCode === null && child.signalCode === null) await once(child, 'exit');
      expect(materialize(readJournal(journalPath)).runStatus).toBe('cancelled');
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('drains an early-release loser fence even though its node is already cancelled', async () => {
    const base = mkdtempSync(join(tmpdir(), 'v3-cancel-fence-early-release-'));
    let child: ChildProcess | undefined;
    try {
      const dag = validateDag({
        runId: 'cancel-fence-early-release',
        nodes: [
          { id: 'loser', type: 'goal', goal: 'wait', depends: [], inputs: [] },
          { id: 'winner', type: 'goal', goal: 'done', depends: [], inputs: [] },
        ],
      });
      const runDir = join(base, dag.runId);
      const attemptId = 'loser/attempts/001';
      const attemptDir = join(runDir, attemptId);
      mkdirSync(attemptDir, { recursive: true });
      child = spawn(process.execPath, ['-e', "process.on('SIGINT',()=>process.exit(0));setInterval(()=>{},1000)"], {
        stdio: 'ignore',
      });
      if (!child.pid) throw new Error('child pid unavailable');
      await waitFor(() => readProcessStartIdentity(child!.pid!) !== undefined);
      const armed = armV3AttemptWorkerFence({ attemptDir, runId: dag.runId, attemptId });
      activateV3AttemptWorkerFence({ attemptDir, armed, workerPid: child.pid });
      const journalPath = join(runDir, 'journal.ndjson');
      appendEvent(journalPath, { type: 'runStarted', runId: dag.runId });
      appendEvent(journalPath, { type: 'nodeDispatched', nodeId: 'loser', attemptId });
      appendEvent(journalPath, { type: 'nodeWorkerFenceArmed', nodeId: 'loser', attemptId });
      appendEvent(journalPath, {
        type: 'nodeCancelled', nodeId: 'loser', attemptId,
        reason: 'earlyReleaseLoser', byNodeId: 'winner',
      });
      appendEvent(journalPath, {
        type: 'runCancelRequested', cancelRequestId: 'cancel-after-early-release', by: 'other-daemon',
      });

      await expect(runWorkflow(dag, {
        runNode: vi.fn<RunNode>(),
        validateManifest: async () => ({ ok: false, problems: ['unexpected'] }),
        resolveBotSnapshot,
      }, { baseDir: base })).resolves.toMatchObject({ runStatus: 'cancelled' });

      if (child.exitCode === null && child.signalCode === null) await once(child, 'exit');
      expect(readV3AttemptWorkerFence(attemptDir, { runId: dag.runId, attemptId })).toBeNull();
      expect(materialize(readJournal(journalPath)).runStatus).toBe('cancelled');
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('drains a superseded instance fence before publishing runCancelled', async () => {
    const base = mkdtempSync(join(tmpdir(), 'v3-cancel-fence-superseded-'));
    let child: ChildProcess | undefined;
    try {
      const dag = validateDag({
        runId: 'cancel-fence-superseded',
        nodes: [{ id: 'edit', type: 'goal', goal: 'wait', depends: [], inputs: [] }],
      });
      const runDir = join(base, dag.runId);
      const instanceId = 'edit#001';
      const attemptId = `${instanceId}/attempts/001`;
      const attemptDir = join(runDir, attemptId);
      mkdirSync(attemptDir, { recursive: true });
      child = spawn(process.execPath, ['-e', "process.on('SIGINT',()=>process.exit(0));setInterval(()=>{},1000)"], {
        stdio: 'ignore',
      });
      if (!child.pid) throw new Error('child pid unavailable');
      await waitFor(() => readProcessStartIdentity(child!.pid!) !== undefined);
      const armed = armV3AttemptWorkerFence({ attemptDir, runId: dag.runId, attemptId });
      activateV3AttemptWorkerFence({ attemptDir, armed, workerPid: child.pid });
      const journalPath = join(runDir, 'journal.ndjson');
      appendEvent(journalPath, { type: 'runStarted', runId: dag.runId });
      appendEvent(journalPath, { type: 'nodeDispatched', nodeId: 'edit', instanceId, attemptId });
      appendEvent(journalPath, { type: 'nodeWorkerFenceArmed', nodeId: 'edit', instanceId, attemptId });
      appendEvent(journalPath, {
        type: 'nodeInstanceSuperseded', nodeId: 'edit', instanceId, byNodeId: 'edit', reason: 'refresh',
      });
      appendEvent(journalPath, {
        type: 'runCancelRequested', cancelRequestId: 'cancel-after-supersede', by: 'other-daemon',
      });

      await expect(runWorkflow(dag, {
        runNode: vi.fn<RunNode>(),
        validateManifest: async () => ({ ok: false, problems: ['unexpected'] }),
        resolveBotSnapshot,
      }, { baseDir: base })).resolves.toMatchObject({ runStatus: 'cancelled' });

      if (child.exitCode === null && child.signalCode === null) await once(child, 'exit');
      expect(readV3AttemptWorkerFence(attemptDir, { runId: dag.runId, attemptId })).toBeNull();
      expect(materialize(readJournal(journalPath)).instances.get(instanceId)?.status).toBe('superseded');
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('requires two separated empty Linux scans before closing a legacy attempt without a fence', async () => {
    if (process.platform !== 'linux') return;
    const base = mkdtempSync(join(tmpdir(), 'v3-cancel-legacy-empty-'));
    try {
      const dag = validateDag({
        runId: 'cancel-legacy-empty',
        nodes: [{ id: 'active', type: 'goal', goal: 'wait', depends: [], inputs: [] }],
      });
      const runDir = join(base, dag.runId);
      const attemptId = 'active/attempts/001';
      mkdirSync(join(runDir, attemptId), { recursive: true });
      const journalPath = join(runDir, 'journal.ndjson');
      appendEvent(journalPath, { type: 'runStarted', runId: dag.runId });
      appendEvent(journalPath, { type: 'nodeDispatched', nodeId: 'active', attemptId });
      appendEvent(journalPath, {
        type: 'runCancelRequested', cancelRequestId: 'cancel-legacy-empty-request', by: 'other-daemon',
      });

      let settled = false;
      const promise = runWorkflow(dag, {
        runNode: vi.fn<RunNode>(),
        validateManifest: async () => ({ ok: false, problems: ['unexpected'] }),
        resolveBotSnapshot,
      }, { baseDir: base });
      void promise.then(
        () => { settled = true; },
        () => { settled = true; },
      );

      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(settled).toBe(false);
      await expect(promise).resolves.toMatchObject({ runStatus: 'cancelled' });
      expect(materialize(readJournal(journalPath)).nodes.get('active')?.status).toBe('cancelled');
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('cancels an idle structured-loop composite without waiting for a nonexistent worker fence', async () => {
    const base = mkdtempSync(join(tmpdir(), 'v3-cancel-loop-control-'));
    try {
      const dag = cancelLoopDag('cancel-loop-control');
      const runDir = join(base, dag.runId);
      mkdirSync(runDir, { recursive: true });
      const journalPath = join(runDir, 'journal.ndjson');
      appendEvent(journalPath, { type: 'runStarted', runId: dag.runId });
      appendEvent(journalPath, { type: 'loopStarted', loopId: 'fix' });
      appendEvent(journalPath, {
        type: 'runCancelRequested', cancelRequestId: 'cancel-loop-control-request', by: 'other-daemon',
      });
      const runNode = vi.fn<RunNode>();

      await expect(runWorkflow(dag, {
        runNode,
        validateManifest: async () => ({ ok: false, problems: ['unexpected'] }),
        resolveBotSnapshot,
      }, { baseDir: base })).resolves.toMatchObject({ runStatus: 'cancelled' });

      expect(runNode).not.toHaveBeenCalled();
      expect(materialize(readJournal(journalPath)).nodes.get('fix')?.status).toBe('cancelled');
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('cancels a structured loop and waits for its active body worker to settle', async () => {
    const base = mkdtempSync(join(tmpdir(), 'v3-cancel-loop-body-'));
    try {
      const dag = cancelLoopDag('cancel-loop-body');
      let dispatched = false;
      let aborted = false;
      const runNode: RunNode = async (req) => {
        dispatched = true;
        return await new Promise((resolve) => {
          const cancel = (): void => {
            aborted = true;
            resolve({ status: 'cancelled', manifestPath: req.env.BOTMUX_GOAL_MANIFEST_PATH! });
          };
          if (req.cancelSignal?.aborted) cancel();
          else req.cancelSignal?.addEventListener('abort', cancel, { once: true });
        });
      };
      const promise = runWorkflow(dag, {
        runNode,
        validateManifest: async () => ({ ok: false, problems: ['unexpected'] }),
        resolveBotSnapshot,
      }, { baseDir: base });

      await waitFor(() => dispatched);
      const journalPath = join(base, dag.runId, 'journal.ndjson');
      appendEvent(journalPath, {
        type: 'runCancelRequested', cancelRequestId: 'cancel-loop-body-request', by: 'other-daemon',
      });

      await expect(promise).resolves.toMatchObject({ runStatus: 'cancelled' });
      expect(aborted).toBe(true);
      const snap = materialize(readJournal(journalPath));
      expect(snap.nodes.get('fix')?.status).toBe('cancelled');
      expect(snap.nodes.get('fix.i001.verify')?.status).toBe('cancelled');
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('observes a durable cancel appended by another daemon while a worker is active', async () => {
    const base = mkdtempSync(join(tmpdir(), 'v3-cancel-external-'));
    try {
      const dag = validateDag({
        runId: 'cancel-external',
        nodes: [{ id: 'active', type: 'goal', goal: 'wait', depends: [], inputs: [] }],
      });
      let dispatched = false;
      let aborted = false;
      const runNode: RunNode = async (req) => {
        dispatched = true;
        return await new Promise((resolve) => {
          const cancel = (): void => {
            aborted = true;
            resolve({ status: 'cancelled', manifestPath: req.env.BOTMUX_GOAL_MANIFEST_PATH! });
          };
          if (req.cancelSignal?.aborted) cancel();
          else req.cancelSignal?.addEventListener('abort', cancel, { once: true });
        });
      };
      const promise = runWorkflow(
        dag,
        {
          runNode,
          validateManifest: async () => ({ ok: false, problems: ['must not validate'] }),
          resolveBotSnapshot,
        },
        { baseDir: base },
      );
      await waitFor(() => dispatched);
      appendEvent(join(base, dag.runId, 'journal.ndjson'), {
        type: 'runCancelRequested',
        cancelRequestId: 'cancel-other-daemon',
        by: 'other-daemon',
      });

      await expect(promise).resolves.toMatchObject({ runStatus: 'cancelled' });
      expect(aborted).toBe(true);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('aborts the active worker, cancels it neutrally, and never dispatches downstream work', async () => {
    const base = mkdtempSync(join(tmpdir(), 'v3-cancel-active-'));
    try {
      const dag = validateDag({
        runId: 'cancel-active',
        nodes: [
          { id: 'active', type: 'goal', goal: 'wait', depends: [], inputs: [] },
          { id: 'downstream', type: 'goal', goal: 'must never run', depends: ['active'], inputs: [] },
        ],
      });
      const controller = new AbortController();
      const dispatched: string[] = [];
      let activeSignalAborted = false;
      const validateManifest = vi.fn(async () => ({ ok: false, problems: ['must not validate cancelled attempt'] }));
      const runNode: RunNode = async (req) => {
        dispatched.push(req.node.id);
        return await new Promise((resolve) => {
          const cancel = (): void => {
            activeSignalAborted = true;
            resolve({ status: 'cancelled', manifestPath: req.env.BOTMUX_GOAL_MANIFEST_PATH! });
          };
          if (req.cancelSignal?.aborted) cancel();
          else req.cancelSignal?.addEventListener('abort', cancel, { once: true });
        });
      };
      const promise = runWorkflow(
        dag,
        { runNode, validateManifest, resolveBotSnapshot },
        { baseDir: base, cancelSignal: controller.signal },
      );

      await waitFor(() => dispatched.includes('active'));
      controller.abort({ kind: 'test-cancel' });

      await expect(promise).resolves.toMatchObject({
        reason: 'terminal',
        runStatus: 'cancelled',
      });
      expect(activeSignalAborted).toBe(true);
      expect(dispatched).toEqual(['active']);
      expect(validateManifest).not.toHaveBeenCalled();

      const events = readJournal(join(base, dag.runId, 'journal.ndjson'));
      expect(events.filter((event) => event.type === 'runCancelRequested')).toHaveLength(1);
      expect(events.filter((event) => event.type === 'runCancelled')).toHaveLength(1);
      const drainedAt = events.findIndex((event) =>
        event.type === 'nodeAttemptDrained' && event.nodeId === 'active');
      const cancelledAt = events.findIndex((event) =>
        event.type === 'nodeCancelled' && event.nodeId === 'active');
      const runCancelledAt = events.findIndex((event) => event.type === 'runCancelled');
      expect(drainedAt).toBeGreaterThan(-1);
      expect(cancelledAt).toBeGreaterThan(drainedAt);
      expect(runCancelledAt).toBeGreaterThan(cancelledAt);
      expect(events.some((event) => event.type === 'nodeDispatched' && event.nodeId === 'downstream')).toBe(false);
      expect(events.some((event) => event.type === 'nodeSucceeded' || event.type === 'nodeFailed')).toBe(false);
      expect(events.filter((event) => event.type === 'nodeCancelled').map((event) => event.nodeId).sort())
        .toEqual(['active', 'downstream']);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('cancels a suspended human gate without dispatching its worker', async () => {
    const base = mkdtempSync(join(tmpdir(), 'v3-cancel-gate-'));
    try {
      const dag = validateDag({
        runId: 'cancel-gate',
        nodes: [{
          id: 'deploy',
          type: 'goal',
          goal: 'deploy',
          depends: [],
          inputs: [],
          humanGate: { prompt: 'approve?' },
        }],
      });
      const runNode = vi.fn<RunNode>();
      const deps: V3RuntimeDeps = {
        runNode,
        validateManifest: async () => ({ ok: false, problems: ['unexpected'] }),
        resolveBotSnapshot,
      };

      const first = await runWorkflow(dag, deps, { baseDir: base, gateMode: 'suspend' });
      expect(first.reason).toBe('awaitingGate');
      const journalPath = join(base, dag.runId, 'journal.ndjson');
      appendEvent(journalPath, {
        type: 'runCancelRequested',
        cancelRequestId: 'cancel-gate-request',
        by: 'ou_user',
      });

      const second = await runWorkflow(dag, deps, { baseDir: base, gateMode: 'suspend' });
      expect(second).toMatchObject({ reason: 'terminal', runStatus: 'cancelled' });
      expect(runNode).not.toHaveBeenCalled();
      const snap = materialize(readJournal(journalPath));
      expect(snap.runStatus).toBe('cancelled');
      expect(snap.nodes.get('deploy')?.status).toBe('cancelled');
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('accepts cancellation after a blocked settle and does not retry the worker', async () => {
    const base = mkdtempSync(join(tmpdir(), 'v3-cancel-blocked-'));
    try {
      const dag = validateDag({
        runId: 'cancel-blocked',
        nodes: [{ id: 'blocked', type: 'goal', goal: 'block', depends: [], inputs: [] }],
      });
      const runNode = vi.fn<RunNode>(async (req) => ({
        status: 'ok',
        manifestPath: req.env.BOTMUX_GOAL_MANIFEST_PATH!,
      }));
      const deps: V3RuntimeDeps = {
        runNode,
        validateManifest: async () => ({ ok: false, problems: ['invalid manifest'] }),
        resolveBotSnapshot,
      };

      const first = await runWorkflow(dag, deps, { baseDir: base });
      expect(first).toMatchObject({ reason: 'terminal', runStatus: 'blocked' });
      expect(runNode).toHaveBeenCalledTimes(1);

      const journalPath = join(base, dag.runId, 'journal.ndjson');
      appendEvent(journalPath, {
        type: 'runCancelRequested',
        cancelRequestId: 'cancel-blocked-request',
        by: 'ou_user',
      });
      const second = await runWorkflow(dag, deps, { baseDir: base });

      expect(second).toMatchObject({ reason: 'terminal', runStatus: 'cancelled' });
      expect(runNode).toHaveBeenCalledTimes(1);
      const snap = materialize(readJournal(journalPath));
      expect(snap.runStatus).toBe('cancelled');
      // The node's blocked settle committed before the cancellation cut and is
      // retained for audit; cancel changes the run terminal, not history.
      expect(snap.nodes.get('blocked')?.status).toBe('blocked');
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
