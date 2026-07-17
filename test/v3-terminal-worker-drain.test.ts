import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';

import { describe, expect, it } from 'vitest';

import { validateDag } from '../src/workflows/v3/dag.js';
import { appendEvent, readJournal, type StoredEvent, type V3Event } from '../src/workflows/v3/journal.js';
import { runWorkflow, type V3RuntimeDeps } from '../src/workflows/v3/runtime.js';
import { decideNext } from '../src/workflows/v3/orchestrator.js';
import { materialize } from '../src/workflows/v3/state.js';
import {
  armV3AttemptWorkerFence,
  activateV3AttemptWorkerFence,
  closeV3ArmedFenceWithoutSpawn,
  readV3AttemptWorkerFence,
} from '../src/workflows/v3/worker-fence.js';
import { readProcessStartIdentity } from '../src/core/session-marker.js';
import type { BotSnapshot, Manifest, RunNode, RunNodeRequest } from '../src/workflows/v3/contract.js';

const resolveBotSnapshot = (): BotSnapshot => ({
  larkAppId: 'cli_test',
  cliId: 'claude-code',
  workingDir: '/tmp',
});

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

function stored(ts: number, event: V3Event): StoredEvent {
  return { ...event, ts } as StoredEvent;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 300; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('condition did not become true');
}

function manifestPath(req: RunNodeRequest, manifest: Manifest): string {
  writeFileSync(req.env.BOTMUX_GOAL_MANIFEST_PATH!, JSON.stringify(manifest));
  return req.env.BOTMUX_GOAL_MANIFEST_PATH!;
}

function ok(req: RunNodeRequest): { status: 'ok'; manifestPath: string } {
  return {
    status: 'ok',
    manifestPath: manifestPath(req, {
      schemaVersion: 1,
      status: 'ok',
      summary: `done ${req.node.id}`,
      files: [{
        name: 'out', path: 'out.md', kind: 'markdown', bytes: 1,
        sha256: 'a'.repeat(64), mime: 'text/markdown',
      }],
    }),
  };
}

function fail(
  req: RunNodeRequest,
  retryable: boolean,
): { status: 'fail'; manifestPath: string } {
  return {
    status: 'fail',
    manifestPath: manifestPath(req, {
      schemaVersion: 1,
      status: 'fail',
      summary: `failed ${req.node.id}`,
      error: { code: 'E_TEST', message: 'controlled failure', retryable },
      files: [],
    }),
  };
}

const validateManifest: V3RuntimeDeps['validateManifest'] = async (path) => ({
  ok: true,
  manifest: JSON.parse(await import('node:fs/promises').then(({ readFile }) => readFile(path, 'utf-8'))) as Manifest,
});

function runtimeOptions(baseDir: string) {
  return {
    baseDir,
    globalConcurrency: 4,
    perBotConcurrency: 4,
    perCliConcurrency: 4,
  };
}

describe('v3 non-cancel terminal worker quiescence', () => {
  it('an unsolicited worker cancellation fails once instead of auto-retrying forever', async () => {
    const base = mkdtempSync(join(tmpdir(), 'v3-unsolicited-worker-cancel-'));
    try {
      const dag = validateDag({
        runId: 'unsolicited-worker-cancel',
        nodes: [{ id: 'node', type: 'goal', goal: 'work' }],
      });
      let calls = 0;
      const outcome = await runWorkflow(dag, {
        runNode: async (req) => {
          calls++;
          return { status: 'cancelled', manifestPath: req.env.BOTMUX_GOAL_MANIFEST_PATH! };
        },
        validateManifest,
        resolveBotSnapshot,
      }, runtimeOptions(base));
      expect(outcome).toMatchObject({ reason: 'terminal', runStatus: 'failed' });
      expect(calls).toBe(1);
      expect(readJournal(join(base, dag.runId, 'journal.ndjson'))).toContainEqual(expect.objectContaining({
        type: 'nodeFailed', errorCode: 'WORKER_CANCELLED_WITHOUT_RUN_REQUEST',
      }));
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it.each([
    {
      verdict: stored(3, { type: 'nodeFailed', nodeId: 'root', instanceId: 'root#001', attemptId: 'root#001/attempts/001', errorClass: 'workerError' }),
      expected: { kind: 'completeRunFailed', failedNodeId: 'root' },
    },
    {
      verdict: stored(3, { type: 'nodeBlocked', nodeId: 'root', instanceId: 'root#001', attemptId: 'root#001/attempts/001', errorClass: 'resultInvalid' }),
      expected: { kind: 'completeRunBlocked', blockedNodeId: 'root' },
    },
  ])('$verdict.type root still wins after a peer drain reset', ({ verdict, expected }) => {
    const dag = validateDag({
      runId: `sweep-${verdict.type}`,
      nodes: [
        { id: 'root', type: 'goal', goal: 'terminal root' },
        { id: 'peer', type: 'goal', goal: 'drained peer' },
      ],
    });
    const events: StoredEvent[] = [
      stored(1, { type: 'runStarted', runId: dag.runId }),
      stored(2, { type: 'nodeDispatched', nodeId: 'root', instanceId: 'root#001', attemptId: 'root#001/attempts/001' }),
      verdict,
      stored(4, { type: 'nodeDispatched', nodeId: 'peer', instanceId: 'peer#001', attemptId: 'peer#001/attempts/001' }),
      stored(5, { type: 'nodeAttemptDrained', nodeId: 'peer', instanceId: 'peer#001', attemptId: 'peer#001/attempts/001', reason: 'terminalPeer' }),
    ];
    const snap = materialize(events);
    expect(snap.nodes.get('peer')?.status).toBe('pending');
    expect(decideNext(dag, snap.nodes, snap.loops, snap.edges, snap.instances)).toEqual([expected]);
  });

  it('fail-fast does not publish runFailed before a peer outer close', async () => {
    const base = mkdtempSync(join(tmpdir(), 'v3-terminal-fail-drain-'));
    const peerStarted = deferred();
    const peerClose = deferred();
    let peerAborted = false;
    let driveSettled = false;
    let drive: Promise<Awaited<ReturnType<typeof runWorkflow>>> | undefined;
    try {
      const dag = validateDag({
        runId: 'terminal-fail-drain',
        nodes: [
          { id: 'fatal', type: 'goal', goal: 'fail' },
          { id: 'peer', type: 'goal', goal: 'wait' },
        ],
      });
      const runNode: RunNode = async (req) => {
        if (req.node.id === 'peer') {
          peerStarted.resolve();
          req.cancelSignal?.addEventListener('abort', () => { peerAborted = true; }, { once: true });
          await peerClose.promise;
          return { status: 'cancelled', manifestPath: req.env.BOTMUX_GOAL_MANIFEST_PATH! };
        }
        await peerStarted.promise;
        return fail(req, false);
      };
      const journalPath = join(base, dag.runId, 'journal.ndjson');
      drive = runWorkflow(
        dag,
        { runNode, validateManifest, resolveBotSnapshot },
        runtimeOptions(base),
      );
      void drive.finally(() => { driveSettled = true; });

      await waitFor(() => readJournal(journalPath).some((event) => event.type === 'nodeFailed' && event.nodeId === 'fatal'));
      await waitFor(() => peerAborted);
      expect(readJournal(journalPath).some((event) => event.type === 'runFailed')).toBe(false);
      expect(driveSettled).toBe(false);

      peerClose.resolve();
      await expect(drive).resolves.toMatchObject({ reason: 'terminal', runStatus: 'failed' });
      const events = readJournal(journalPath);
      const drainedAt = events.findIndex((event) => event.type === 'nodeAttemptDrained' && event.nodeId === 'peer');
      const terminalAt = events.findIndex((event) => event.type === 'runFailed');
      expect(drainedAt).toBeGreaterThan(-1);
      expect(terminalAt).toBeGreaterThan(drainedAt);
    } finally {
      peerClose.resolve();
      if (drive) await Promise.allSettled([drive]);
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('a rejected blocking gate also drains a live worker before runFailed', async () => {
    const base = mkdtempSync(join(tmpdir(), 'v3-gate-reject-drain-'));
    const peerStarted = deferred();
    const peerClose = deferred();
    let peerAborted = false;
    let drive: Promise<Awaited<ReturnType<typeof runWorkflow>>> | undefined;
    try {
      const dag = validateDag({
        runId: 'gate-reject-drain',
        nodes: [
          { id: 'approval', type: 'goal', goal: 'gated', humanGate: { prompt: 'approve?' } },
          { id: 'peer', type: 'goal', goal: 'wait' },
        ],
      });
      const journalPath = join(base, dag.runId, 'journal.ndjson');
      drive = runWorkflow(dag, {
        runNode: async (req) => {
          peerStarted.resolve();
          req.cancelSignal?.addEventListener('abort', () => { peerAborted = true; }, { once: true });
          await peerClose.promise;
          return { status: 'cancelled', manifestPath: req.env.BOTMUX_GOAL_MANIFEST_PATH! };
        },
        validateManifest,
        resolveBotSnapshot,
        resolveGate: async () => {
          await peerStarted.promise;
          return { resolution: 'rejected' as const, by: 'ou_reviewer' };
        },
      }, runtimeOptions(base));

      await waitFor(() => readJournal(journalPath).some((event) =>
        event.type === 'gateResolved' && event.resolution === 'rejected'));
      await waitFor(() => peerAborted);
      expect(readJournal(journalPath).some((event) => event.type === 'runFailed')).toBe(false);

      peerClose.resolve();
      await expect(drive).resolves.toMatchObject({ reason: 'terminal', runStatus: 'failed' });
      const events = readJournal(journalPath);
      expect(events.findIndex((event) => event.type === 'nodeAttemptDrained' && event.nodeId === 'peer'))
        .toBeLessThan(events.findIndex((event) => event.type === 'runFailed'));
    } finally {
      peerClose.resolve();
      if (drive) await Promise.allSettled([drive]);
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('suspend mode does not return a gate while a peer worker is still open', async () => {
    const base = mkdtempSync(join(tmpdir(), 'v3-gate-suspend-drain-'));
    const peerStarted = deferred();
    const peerClose = deferred();
    let settled = false;
    let drive: Promise<Awaited<ReturnType<typeof runWorkflow>>> | undefined;
    try {
      const dag = validateDag({
        runId: 'gate-suspend-drain',
        nodes: [
          { id: 'approval', type: 'goal', goal: 'gated', humanGate: { prompt: 'approve?' } },
          { id: 'peer', type: 'goal', goal: 'work' },
        ],
      });
      drive = runWorkflow(dag, {
        runNode: async (req) => {
          peerStarted.resolve();
          await peerClose.promise;
          return ok(req);
        },
        validateManifest,
        resolveBotSnapshot,
      }, { ...runtimeOptions(base), gateMode: 'suspend' as const });
      void drive.finally(() => { settled = true; });

      await peerStarted.promise;
      await new Promise((resolve) => setImmediate(resolve));
      expect(settled).toBe(false);

      peerClose.resolve();
      await expect(drive).resolves.toMatchObject({
        reason: 'awaitingGate',
        pendingWaits: [expect.objectContaining({ nodeId: 'approval' })],
      });
    } finally {
      peerClose.resolve();
      if (drive) await Promise.allSettled([drive]);
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('a durable cancel that lands during terminal drain wins the journal race', async () => {
    const base = mkdtempSync(join(tmpdir(), 'v3-terminal-drain-cancel-race-'));
    const peerStarted = deferred();
    const peerClose = deferred();
    let peerAborted = false;
    let drive: Promise<Awaited<ReturnType<typeof runWorkflow>>> | undefined;
    try {
      const dag = validateDag({
        runId: 'terminal-drain-cancel-race',
        nodes: [
          { id: 'fatal', type: 'goal', goal: 'fail' },
          { id: 'peer', type: 'goal', goal: 'wait' },
        ],
      });
      const runNode: RunNode = async (req) => {
        if (req.node.id === 'peer') {
          peerStarted.resolve();
          req.cancelSignal?.addEventListener('abort', () => { peerAborted = true; }, { once: true });
          await peerClose.promise;
          return { status: 'cancelled', manifestPath: req.env.BOTMUX_GOAL_MANIFEST_PATH! };
        }
        await peerStarted.promise;
        return fail(req, false);
      };
      const journalPath = join(base, dag.runId, 'journal.ndjson');
      drive = runWorkflow(
        dag,
        { runNode, validateManifest, resolveBotSnapshot },
        runtimeOptions(base),
      );
      await waitFor(() => peerAborted);
      appendEvent(journalPath, {
        type: 'runCancelRequested', cancelRequestId: 'cancel-during-drain', by: 'ou_user',
      });
      peerClose.resolve();

      await expect(drive).resolves.toMatchObject({ reason: 'terminal', runStatus: 'cancelled' });
      const events = readJournal(journalPath);
      expect(events.some((event) => event.type === 'runFailed')).toBe(false);
      expect(events.filter((event) => event.type === 'runCancelled')).toHaveLength(1);
    } finally {
      peerClose.resolve();
      if (drive) await Promise.allSettled([drive]);
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('blocked drains peers to pending; retry dispatches a fresh attempt', async () => {
    const base = mkdtempSync(join(tmpdir(), 'v3-terminal-block-drain-'));
    const peerStarted = deferred();
    const peerClose = deferred();
    let firstDrive: Promise<Awaited<ReturnType<typeof runWorkflow>>> | undefined;
    try {
      const dag = validateDag({
        runId: 'terminal-block-drain',
        nodes: [
          { id: 'blocker', type: 'goal', goal: 'block' },
          { id: 'peer', type: 'goal', goal: 'wait' },
        ],
      });
      const attempts: string[] = [];
      const runNode: RunNode = async (req) => {
        attempts.push(req.attemptId);
        if (req.node.id === 'peer' && req.attemptId.endsWith('/001')) {
          peerStarted.resolve();
          await peerClose.promise;
          return { status: 'cancelled', manifestPath: req.env.BOTMUX_GOAL_MANIFEST_PATH! };
        }
        if (req.node.id === 'blocker' && req.attemptId.endsWith('/001')) {
          await peerStarted.promise;
          const selfReported = fail(req, true);
          // An intact worker reports semantic blockage via an ok process result
          // plus a valid status:fail manifest.
          return { ...selfReported, status: 'ok' as const };
        }
        return ok(req);
      };
      const deps = { runNode, validateManifest, resolveBotSnapshot } satisfies V3RuntimeDeps;
      const journalPath = join(base, dag.runId, 'journal.ndjson');
      firstDrive = runWorkflow(dag, deps, runtimeOptions(base));

      await waitFor(() => readJournal(journalPath).some((event) => event.type === 'nodeBlocked'));
      expect(readJournal(journalPath).some((event) => event.type === 'runBlocked')).toBe(false);
      peerClose.resolve();
      await expect(firstDrive).resolves.toMatchObject({ reason: 'terminal', runStatus: 'blocked' });

      const blockedEvent = readJournal(journalPath).find(
        (event) => event.type === 'nodeBlocked' && event.nodeId === 'blocker',
      );
      if (!blockedEvent || blockedEvent.type !== 'nodeBlocked') throw new Error('missing blocker event');
      appendEvent(journalPath, {
        type: 'nodeRetryRequested',
        nodeId: 'blocker',
        instanceId: blockedEvent.instanceId,
        previousAttemptId: blockedEvent.attemptId,
        nextAttemptId: `${blockedEvent.instanceId ?? 'blocker'}/attempts/002`,
      });

      await expect(runWorkflow(dag, deps, runtimeOptions(base)))
        .resolves.toMatchObject({ reason: 'terminal', runStatus: 'succeeded' });
      expect(attempts).toContain('peer#001/attempts/002');
      expect(attempts).toContain('blocker#001/attempts/002');
    } finally {
      peerClose.resolve();
      if (firstDrive) await Promise.allSettled([firstDrive]);
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('reattaches a blocking gate after an unrelated blocked node is retried', async () => {
    const base = mkdtempSync(join(tmpdir(), 'v3-blocked-gate-reattach-'));
    const abandonedGate = deferred<{ resolution: 'approved'; by: string }>();
    try {
      const dag = validateDag({
        runId: 'blocked-gate-reattach',
        nodes: [
          { id: 'approval', type: 'goal', goal: 'gated work', humanGate: { prompt: 'approve?' } },
          { id: 'blocker', type: 'goal', goal: 'may block' },
        ],
      });
      let gateCalls = 0;
      const attempts: string[] = [];
      const deps: V3RuntimeDeps = {
        runNode: async (req) => {
          attempts.push(req.attemptId);
          if (req.node.id === 'blocker' && req.attemptId.endsWith('/001')) {
            return { ...fail(req, true), status: 'ok' as const };
          }
          return ok(req);
        },
        validateManifest,
        resolveBotSnapshot,
        resolveGate: () => {
          gateCalls++;
          return gateCalls === 1
            ? abandonedGate.promise
            : Promise.resolve({ resolution: 'approved' as const, by: 'ou_retry' });
        },
      };
      const journalPath = join(base, dag.runId, 'journal.ndjson');

      await expect(runWorkflow(dag, deps, runtimeOptions(base)))
        .resolves.toMatchObject({ reason: 'terminal', runStatus: 'blocked' });
      expect(gateCalls).toBe(1);
      expect(materialize(readJournal(journalPath)).nodes.get('approval')?.status).toBe('gateWaiting');

      const blocked = readJournal(journalPath).find(
        (event) => event.type === 'nodeBlocked' && event.nodeId === 'blocker',
      );
      if (!blocked || blocked.type !== 'nodeBlocked') throw new Error('missing blocker event');
      appendEvent(journalPath, {
        type: 'nodeRetryRequested',
        nodeId: 'blocker',
        instanceId: blocked.instanceId,
        previousAttemptId: blocked.attemptId,
        nextAttemptId: `${blocked.instanceId ?? 'blocker'}/attempts/002`,
      });

      await expect(runWorkflow(dag, deps, runtimeOptions(base)))
        .resolves.toMatchObject({ reason: 'terminal', runStatus: 'succeeded' });
      expect(gateCalls).toBe(2);
      expect(attempts).toContain('blocker#001/attempts/002');
      expect(attempts).toContain('approval#001/attempts/001');

      // The resolver abandoned by the first drive may still settle in an
      // embedded caller. Its ownership token was revoked, so it cannot append
      // a late second gate resolution after the retry completed.
      abandonedGate.resolve({ resolution: 'approved', by: 'ou_stale' });
      await new Promise((resolve) => setImmediate(resolve));
      expect(readJournal(journalPath).filter((event) => event.type === 'gateResolved')).toHaveLength(1);
    } finally {
      abandonedGate.resolve({ resolution: 'approved', by: 'ou_cleanup' });
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('repairs a pre-barrier runBlocked peer so a later retry uses attempt 002', async () => {
    const base = mkdtempSync(join(tmpdir(), 'v3-old-blocked-peer-retry-'));
    try {
      const dag = validateDag({
        runId: 'old-blocked-peer-retry',
        nodes: [
          { id: 'blocker', type: 'goal', goal: 'blocked root' },
          { id: 'peer', type: 'goal', goal: 'old peer' },
        ],
      });
      const runDir = join(base, dag.runId);
      const journalPath = join(runDir, 'journal.ndjson');
      const peerAttempt = 'peer#001/attempts/001';
      const peerDir = join(runDir, peerAttempt);
      mkdirSync(peerDir, { recursive: true });
      appendEvent(journalPath, { type: 'runStarted', runId: dag.runId });
      appendEvent(journalPath, { type: 'nodeDispatched', nodeId: 'blocker', instanceId: 'blocker#001', attemptId: 'blocker#001/attempts/001' });
      appendEvent(journalPath, { type: 'nodeBlocked', nodeId: 'blocker', instanceId: 'blocker#001', attemptId: 'blocker#001/attempts/001', errorClass: 'resultInvalid' });
      appendEvent(journalPath, { type: 'nodeDispatched', nodeId: 'peer', instanceId: 'peer#001', attemptId: peerAttempt });
      const armed = armV3AttemptWorkerFence({ attemptDir: peerDir, runId: dag.runId, attemptId: peerAttempt });
      closeV3ArmedFenceWithoutSpawn(peerDir, armed, 'setup_failed');
      appendEvent(journalPath, { type: 'nodeWorkerFenceArmed', nodeId: 'peer', instanceId: 'peer#001', attemptId: peerAttempt });
      appendEvent(journalPath, { type: 'runBlocked', blockedNodeId: 'blocker' });

      const attempts: string[] = [];
      const runNode: RunNode = async (req) => { attempts.push(req.attemptId); return ok(req); };
      const deps = { runNode, validateManifest, resolveBotSnapshot } satisfies V3RuntimeDeps;
      await expect(runWorkflow(dag, deps, runtimeOptions(base)))
        .resolves.toMatchObject({ reason: 'terminal', runStatus: 'blocked' });
      expect(attempts).toEqual([]);
      expect(materialize(readJournal(journalPath)).nodes.get('peer')?.status).toBe('pending');

      appendEvent(journalPath, {
        type: 'nodeRetryRequested',
        nodeId: 'blocker',
        instanceId: 'blocker#001',
        previousAttemptId: 'blocker#001/attempts/001',
        nextAttemptId: 'blocker#001/attempts/002',
      });
      await expect(runWorkflow(dag, deps, runtimeOptions(base)))
        .resolves.toMatchObject({ reason: 'terminal', runStatus: 'succeeded' });
      expect(attempts).toContain('blocker#001/attempts/002');
      expect(attempts).toContain('peer#001/attempts/002');
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('early-release success waits for the loser outer close', async () => {
    const base = mkdtempSync(join(tmpdir(), 'v3-terminal-early-drain-'));
    const loserStarted = deferred();
    const loserClose = deferred();
    let loserAborted = false;
    let drive: Promise<Awaited<ReturnType<typeof runWorkflow>>> | undefined;
    try {
      const dag = validateDag({
        runId: 'terminal-early-drain',
        nodes: [
          { id: 'winner', type: 'goal', goal: 'win' },
          { id: 'loser', type: 'goal', goal: 'wait' },
          { id: 'merge', type: 'goal', goal: 'merge', depends: ['winner', 'loser'], triggerRule: 'one_success' },
        ],
      });
      const runNode: RunNode = async (req) => {
        if (req.node.id === 'loser') {
          loserStarted.resolve();
          req.cancelSignal?.addEventListener('abort', () => { loserAborted = true; }, { once: true });
          await loserClose.promise;
          return { status: 'cancelled', manifestPath: req.env.BOTMUX_GOAL_MANIFEST_PATH! };
        }
        if (req.node.id === 'winner') await loserStarted.promise;
        return ok(req);
      };
      const journalPath = join(base, dag.runId, 'journal.ndjson');
      drive = runWorkflow(
        dag,
        { runNode, validateManifest, resolveBotSnapshot },
        runtimeOptions(base),
      );

      await waitFor(() => readJournal(journalPath).some((event) => event.type === 'nodeSucceeded' && event.nodeId === 'merge'));
      await waitFor(() => loserAborted);
      expect(readJournal(journalPath).some((event) => event.type === 'runSucceeded')).toBe(false);

      loserClose.resolve();
      await expect(drive).resolves.toMatchObject({ reason: 'terminal', runStatus: 'succeeded' });
      const events = readJournal(journalPath);
      expect(events.findIndex((event) => event.type === 'nodeAttemptDrained' && event.nodeId === 'loser'))
        .toBeLessThan(events.findIndex((event) => event.type === 'runSucceeded'));
    } finally {
      loserClose.resolve();
      if (drive) await Promise.allSettled([drive]);
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('does not dispatch revisit replacements before a superseded live peer closes', async () => {
    const base = mkdtempSync(join(tmpdir(), 'v3-revisit-peer-drain-'));
    const oldPeerStarted = deferred();
    const oldPeerClose = deferred();
    let oldPeerAborted = false;
    let drive: Promise<Awaited<ReturnType<typeof runWorkflow>>> | undefined;
    try {
      const dag = validateDag({
        runId: 'revisit-peer-drain',
        nodes: [
          { id: 'A', type: 'goal', goal: 'root' },
          { id: 'B', type: 'goal', goal: 'slow peer', depends: ['A'] },
          { id: 'C', type: 'goal', goal: 'review', depends: ['A'], revisitTo: ['A'] },
        ],
      });
      const runNode: RunNode = async (req) => {
        if (req.node.id === 'B' && req.attemptId.startsWith('B#001')) {
          oldPeerStarted.resolve();
          req.cancelSignal?.addEventListener('abort', () => { oldPeerAborted = true; }, { once: true });
          await oldPeerClose.promise;
          return { status: 'cancelled', manifestPath: req.env.BOTMUX_GOAL_MANIFEST_PATH! };
        }
        if (req.node.id === 'C' && req.attemptId.startsWith('C#001')) {
          await oldPeerStarted.promise;
          const result = JSON.stringify({ status: 'revisit', revisitTo: 'A', reason: 'refresh root' });
          writeFileSync(join(req.outputDir, 'result.json'), result);
          return {
            status: 'ok',
            manifestPath: manifestPath(req, {
              schemaVersion: 1,
              status: 'ok',
              summary: 'revisit',
              files: [{
                name: 'result', path: 'result.json', kind: 'json', bytes: Buffer.byteLength(result),
                sha256: 'b'.repeat(64), mime: 'application/json',
              }],
            }),
          };
        }
        return ok(req);
      };
      const journalPath = join(base, dag.runId, 'journal.ndjson');
      drive = runWorkflow(
        dag,
        { runNode, validateManifest, resolveBotSnapshot },
        runtimeOptions(base),
      );

      await waitFor(() => readJournal(journalPath).some((event) =>
        event.type === 'nodeInstanceSuperseded' && event.instanceId === 'B#001'));
      await waitFor(() => oldPeerAborted);
      expect(readJournal(journalPath).some((event) =>
        event.type === 'nodeDispatched' && event.instanceId === 'A#002')).toBe(false);

      oldPeerClose.resolve();
      await expect(drive).resolves.toMatchObject({ reason: 'terminal', runStatus: 'succeeded' });
      const events = readJournal(journalPath);
      const drainedAt = events.findIndex((event) =>
        event.type === 'nodeAttemptDrained' && event.instanceId === 'B#001');
      const replacementAt = events.findIndex((event) =>
        event.type === 'nodeDispatched' && event.instanceId === 'A#002');
      expect(drainedAt).toBeGreaterThan(-1);
      expect(replacementAt).toBeGreaterThan(drainedAt);
    } finally {
      oldPeerClose.resolve();
      if (drive) await Promise.allSettled([drive]);
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('structured-loop fail-fast also waits for every body peer close', async () => {
    const base = mkdtempSync(join(tmpdir(), 'v3-loop-terminal-drain-'));
    const peerStarted = deferred();
    const peerClose = deferred();
    let peerAborted = false;
    let drive: Promise<Awaited<ReturnType<typeof runWorkflow>>> | undefined;
    try {
      const dag = validateDag({
        runId: 'loop-terminal-drain',
        nodes: [{
          id: 'fix',
          type: 'loop',
          maxIterations: 1,
          body: {
            nodes: [
              {
                id: 'fatal', type: 'goal', goal: 'fail',
                resultSchema: {
                  type: 'object',
                  properties: { passed: { type: 'boolean' } },
                  required: ['passed'],
                },
              },
              { id: 'peer', type: 'goal', goal: 'wait' },
            ],
          },
          exit: { node: 'fatal', when: { path: 'result.passed', equals: true } },
          output: { from: 'fatal' },
        }],
      });
      const runNode: RunNode = async (req) => {
        if (req.node.id.endsWith('.peer')) {
          peerStarted.resolve();
          req.cancelSignal?.addEventListener('abort', () => { peerAborted = true; }, { once: true });
          await peerClose.promise;
          return { status: 'cancelled', manifestPath: req.env.BOTMUX_GOAL_MANIFEST_PATH! };
        }
        await peerStarted.promise;
        return fail(req, false);
      };
      const journalPath = join(base, dag.runId, 'journal.ndjson');
      drive = runWorkflow(
        dag,
        { runNode, validateManifest, resolveBotSnapshot },
        runtimeOptions(base),
      );

      await waitFor(() => readJournal(journalPath).some((event) =>
        event.type === 'nodeFailed' && event.nodeId.endsWith('.fatal')));
      await waitFor(() => peerAborted);
      expect(readJournal(journalPath).some((event) => event.type === 'runFailed')).toBe(false);

      peerClose.resolve();
      await expect(drive).resolves.toMatchObject({ reason: 'terminal', runStatus: 'failed' });
    } finally {
      peerClose.resolve();
      if (drive) await Promise.allSettled([drive]);
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('recovers a crashed structured-loop body with attempt 002 before completing the loop', async () => {
    const base = mkdtempSync(join(tmpdir(), 'v3-loop-orphan-recovery-'));
    try {
      const dag = validateDag({
        runId: 'loop-orphan-recovery',
        nodes: [{
          id: 'fix',
          type: 'loop',
          maxIterations: 1,
          body: {
            nodes: [{
              id: 'verify',
              type: 'goal',
              goal: 'verify the result',
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
      const runDir = join(base, dag.runId);
      const journalPath = join(runDir, 'journal.ndjson');
      const bodyNodeId = 'fix.i001.verify';
      const orphanAttemptId = `${bodyNodeId}/attempts/001`;
      const orphanAttemptDir = join(runDir, orphanAttemptId);
      mkdirSync(orphanAttemptDir, { recursive: true });

      appendEvent(journalPath, { type: 'runStarted', runId: dag.runId });
      appendEvent(journalPath, { type: 'loopStarted', loopId: 'fix' });
      appendEvent(journalPath, { type: 'loopIterationStarted', loopId: 'fix', iteration: 1 });
      appendEvent(journalPath, {
        type: 'nodeDispatched',
        nodeId: bodyNodeId,
        attemptId: orphanAttemptId,
        loop: { loopId: 'fix', iteration: 1, bodyNodeId: 'verify' },
      });
      const armed = armV3AttemptWorkerFence({
        attemptDir: orphanAttemptDir,
        runId: dag.runId,
        attemptId: orphanAttemptId,
      });
      closeV3ArmedFenceWithoutSpawn(orphanAttemptDir, armed, 'setup_failed');
      appendEvent(journalPath, {
        type: 'nodeWorkerFenceArmed',
        nodeId: bodyNodeId,
        attemptId: orphanAttemptId,
      });

      const dispatched: string[] = [];
      const runNode: RunNode = async (req) => {
        dispatched.push(req.attemptId);
        const result = JSON.stringify({ passed: true });
        writeFileSync(join(req.outputDir, 'result.json'), result);
        return {
          status: 'ok',
          manifestPath: manifestPath(req, {
            schemaVersion: 1,
            status: 'ok',
            summary: 'verification passed',
            files: [{
              name: 'result',
              path: 'result.json',
              kind: 'json',
              bytes: Buffer.byteLength(result),
              sha256: 'c'.repeat(64),
              mime: 'application/json',
            }],
          }),
        };
      };

      await expect(runWorkflow(
        dag,
        { runNode, validateManifest, resolveBotSnapshot },
        runtimeOptions(base),
      )).resolves.toMatchObject({ reason: 'terminal', runStatus: 'succeeded' });

      expect(dispatched).toEqual([`${bodyNodeId}/attempts/002`]);
      const events = readJournal(journalPath);
      const drainedAt = events.findIndex((event) =>
        event.type === 'nodeAttemptDrained' &&
        event.nodeId === bodyNodeId &&
        event.attemptId === orphanAttemptId &&
        event.reason === 'orphanRecovery');
      const replacementAt = events.findIndex((event) =>
        event.type === 'nodeDispatched' &&
        event.nodeId === bodyNodeId &&
        event.attemptId === `${bodyNodeId}/attempts/002`);
      expect(drainedAt).toBeGreaterThan(-1);
      expect(replacementAt).toBeGreaterThan(drainedAt);
      expect(events).toContainEqual(expect.objectContaining({
        type: 'loopIterationDecision',
        loopId: 'fix',
        iteration: 1,
        decision: 'exit',
      }));
      expect(events.at(-1)).toMatchObject({ type: 'runSucceeded' });
      expect(readV3AttemptWorkerFence(orphanAttemptDir, {
        runId: dag.runId,
        attemptId: orphanAttemptId,
      })).toBeNull();
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('does not let a late blocking-gate callback mutate a committed terminal', async () => {
    const base = mkdtempSync(join(tmpdir(), 'v3-terminal-stale-gate-'));
    const gate = deferred<{ resolution: 'approved'; by: string }>();
    try {
      const dag = validateDag({
        runId: 'terminal-stale-gate',
        nodes: [
          { id: 'fatal', type: 'goal', goal: 'fail' },
          { id: 'approval', type: 'goal', goal: 'wait for human', humanGate: { prompt: 'approve?' } },
        ],
      });
      const journalPath = join(base, dag.runId, 'journal.ndjson');
      await expect(runWorkflow(dag, {
        runNode: async (req) => fail(req, false),
        validateManifest,
        resolveBotSnapshot,
        resolveGate: () => gate.promise,
      }, runtimeOptions(base))).resolves.toMatchObject({ reason: 'terminal', runStatus: 'failed' });

      gate.resolve({ resolution: 'approved', by: 'ou_late' });
      await new Promise((resolve) => setImmediate(resolve));
      expect(readJournal(journalPath).some((event) => event.type === 'gateResolved')).toBe(false);
    } finally {
      gate.resolve({ resolution: 'approved', by: 'ou_cleanup' });
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('blocks after two automatic orphan recoveries instead of redispatching forever', async () => {
    const base = mkdtempSync(join(tmpdir(), 'v3-orphan-recovery-cap-'));
    try {
      const dag = validateDag({
        runId: 'orphan-recovery-cap',
        nodes: [{ id: 'peer', type: 'goal', goal: 'recover' }],
      });
      const runDir = join(base, dag.runId);
      const journalPath = join(runDir, 'journal.ndjson');
      appendEvent(journalPath, { type: 'runStarted', runId: dag.runId });
      for (const n of [1, 2]) {
        const attemptId = `peer#001/attempts/00${n}`;
        appendEvent(journalPath, { type: 'nodeDispatched', nodeId: 'peer', instanceId: 'peer#001', attemptId });
        appendEvent(journalPath, { type: 'nodeAttemptDrained', nodeId: 'peer', instanceId: 'peer#001', attemptId, reason: 'orphanRecovery' });
      }
      const attemptId = 'peer#001/attempts/003';
      const attemptDir = join(runDir, attemptId);
      mkdirSync(attemptDir, { recursive: true });
      appendEvent(journalPath, { type: 'nodeDispatched', nodeId: 'peer', instanceId: 'peer#001', attemptId });
      const armed = armV3AttemptWorkerFence({ attemptDir, runId: dag.runId, attemptId });
      closeV3ArmedFenceWithoutSpawn(attemptDir, armed, 'setup_failed');
      appendEvent(journalPath, { type: 'nodeWorkerFenceArmed', nodeId: 'peer', instanceId: 'peer#001', attemptId });

      let runNodeCalled = false;
      await expect(runWorkflow(dag, {
        runNode: async () => { runNodeCalled = true; throw new Error('must not dispatch'); },
        validateManifest,
        resolveBotSnapshot,
      }, runtimeOptions(base))).resolves.toMatchObject({ reason: 'terminal', runStatus: 'blocked' });

      expect(runNodeCalled).toBe(false);
      const events = readJournal(journalPath);
      expect(events).toContainEqual(expect.objectContaining({
        type: 'nodeBlocked',
        nodeId: 'peer',
        attemptId,
        errorCode: 'ORPHAN_RECOVERY_EXHAUSTED',
      }));
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('cleans an open attempt from a pre-barrier terminal history without changing the verdict', async () => {
    const base = mkdtempSync(join(tmpdir(), 'v3-old-terminal-drain-'));
    try {
      const dag = validateDag({
        runId: 'old-terminal-drain',
        nodes: [
          { id: 'fatal', type: 'goal', goal: 'failed already' },
          { id: 'peer', type: 'goal', goal: 'old peer' },
        ],
      });
      const runDir = join(base, dag.runId);
      const journalPath = join(runDir, 'journal.ndjson');
      const attemptId = 'peer#001/attempts/001';
      const attemptDir = join(runDir, attemptId);
      mkdirSync(attemptDir, { recursive: true });
      appendEvent(journalPath, { type: 'runStarted', runId: dag.runId });
      appendEvent(journalPath, { type: 'nodeDispatched', nodeId: 'peer', instanceId: 'peer#001', attemptId });
      const armed = armV3AttemptWorkerFence({ attemptDir, runId: dag.runId, attemptId });
      closeV3ArmedFenceWithoutSpawn(attemptDir, armed, 'setup_failed');
      appendEvent(journalPath, { type: 'nodeWorkerFenceArmed', nodeId: 'peer', instanceId: 'peer#001', attemptId });
      appendEvent(journalPath, { type: 'runFailed', failedNodeId: 'fatal' });

      let runNodeCalled = false;
      await expect(runWorkflow(dag, {
        runNode: async () => { runNodeCalled = true; throw new Error('must not dispatch'); },
        validateManifest,
        resolveBotSnapshot,
      }, runtimeOptions(base))).resolves.toMatchObject({ reason: 'terminal', runStatus: 'failed', failedNodeId: 'fatal' });

      expect(runNodeCalled).toBe(false);
      expect(readJournal(journalPath).filter((event) => event.type === 'runFailed')).toHaveLength(1);
      expect(readJournal(journalPath)).toContainEqual(expect.objectContaining({
        type: 'nodeAttemptDrained', attemptId, reason: 'orphanRecovery',
      }));
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('signals an externally-owned peer and waits for its real process close on terminal recovery', async () => {
    if (process.platform !== 'linux') return;
    const base = mkdtempSync(join(tmpdir(), 'v3-old-terminal-live-peer-'));
    let child: ChildProcess | undefined;
    try {
      const dag = validateDag({
        runId: 'old-terminal-live-peer',
        nodes: [
          { id: 'fatal', type: 'goal', goal: 'failed already' },
          { id: 'peer', type: 'goal', goal: 'old live peer' },
        ],
      });
      const runDir = join(base, dag.runId);
      const journalPath = join(runDir, 'journal.ndjson');
      const attemptId = 'peer#001/attempts/001';
      const attemptDir = join(runDir, attemptId);
      mkdirSync(attemptDir, { recursive: true });
      child = spawn(process.execPath, ['-e', "process.on('SIGINT',()=>process.exit(0));setInterval(()=>{},1000)"], {
        stdio: 'ignore',
      });
      if (!child.pid) throw new Error('child pid unavailable');
      await waitFor(() => readProcessStartIdentity(child!.pid!) !== undefined);
      const armed = armV3AttemptWorkerFence({ attemptDir, runId: dag.runId, attemptId });
      activateV3AttemptWorkerFence({ attemptDir, armed, workerPid: child.pid });
      appendEvent(journalPath, { type: 'runStarted', runId: dag.runId });
      appendEvent(journalPath, { type: 'nodeDispatched', nodeId: 'peer', instanceId: 'peer#001', attemptId });
      appendEvent(journalPath, { type: 'nodeWorkerFenceArmed', nodeId: 'peer', instanceId: 'peer#001', attemptId });
      appendEvent(journalPath, { type: 'runFailed', failedNodeId: 'fatal' });

      let runNodeCalled = false;
      await expect(runWorkflow(dag, {
        runNode: async () => { runNodeCalled = true; throw new Error('must not dispatch'); },
        validateManifest,
        resolveBotSnapshot,
      }, runtimeOptions(base))).resolves.toMatchObject({ runStatus: 'failed' });

      expect(runNodeCalled).toBe(false);
      expect(readV3AttemptWorkerFence(attemptDir, { runId: dag.runId, attemptId })).toBeNull();
      expect(readJournal(journalPath)).toContainEqual(expect.objectContaining({
        type: 'nodeAttemptDrained', attemptId, reason: 'orphanRecovery',
      }));
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      rmSync(base, { recursive: true, force: true });
    }
  });
});
