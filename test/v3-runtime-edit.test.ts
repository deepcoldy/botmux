/**
 * Runtime flow edits end to end (design §13): the real daemon driver,
 * runtime, journal and state, a fake worker / fake bot transport, a fake
 * clock, and the real card handlers. Covers the §13.4 rows on live runs,
 * M1 turn classes, the M2 proposal flow, optimistic concurrency, crash
 * windows, Saved Workflow save, projections, and the old-run regression.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  artifactRef,
  makeAdHocRunEnvelope,
  publishRunEnvelopeOnce,
} from '../src/workflows/v3/run-envelope.js';
import {
  createV3GateRunner,
  driveV3Run,
  resolveV3GateClick,
  type V3DaemonRunDeps,
} from '../src/workflows/v3/daemon-run.js';
import { appendEvent, readJournal, type StoredEvent } from '../src/workflows/v3/journal.js';
import type { RunNode, RunNodeRequest } from '../src/workflows/v3/contract.js';
import type {
  V3ExternalDispatchRequest,
  V3ExternalNodeExecutor,
  V3ExternalStopRequest,
} from '../src/workflows/v3/external-executor.js';
import { classifyExternalAttempt, recordExternalAccepted } from '../src/workflows/v3/external-control.js';
import { openV3ExternalAttempts } from '../src/workflows/v3/external-attempt-ledger.js';
import {
  applyV3RunEdit,
  decideV3RevisionProposal,
  projectV3RunStatus,
  readV3RevisionWait,
  reconcileV3RevisionProposals,
  v3RevisionWaitPath,
  type V3RunEditCaller,
} from '../src/workflows/v3/run-edit.js';
import { v3RevisionFilePaths } from '../src/workflows/v3/dag-revision.js';
import { readWait, recordWaitCardMessage } from '../src/workflows/v3/human-gate.js';
import {
  authorizeV3RunEditCommand,
  authorizeV3RunEditForCurrentTuple,
  V3DaemonCommandAuthorityError,
} from '../src/workflows/v3/cli-daemon-command-authority.js';
import { compileSavedWorkflowFromRun } from '../src/workflows/v3/library-materialize.js';
import { projectRun } from '../src/workflows/v3/ops-projection.js';
import { projectV3Progress } from '../src/workflows/v3/progress-projection.js';
import { loadAuthorizedV3Run } from '../src/workflows/v3/run-envelope.js';
import { loadEffectiveV3Dag } from '../src/workflows/v3/dag-revision.js';
import { handleV3GateAction } from '../src/im/lark/v3-gate-card-handler.js';
import { V3_GATE_APPROVE_ACTION, v3GateCardNonce } from '../src/im/lark/v3-gate-card.js';
import { handleV3RevisionAction } from '../src/im/lark/v3-revision-card-handler.js';
import {
  V3_REVISION_APPROVE_ACTION,
  V3_REVISION_REJECT_ACTION,
  v3RevisionCardNonce,
} from '../src/im/lark/v3-revision-card.js';
import { parseWorkflowDaemonMutationBody } from '../src/workflows/v3/daemon-ipc-body.js';

const INITIATOR = 'ou_initiator';
const OTHER = 'ou_other_member';
const BINDING = {
  larkAppId: 'cli_owner',
  chatId: 'oc_chat',
  rootMessageId: 'om_root',
  ownerOpenId: INITIATOR,
};
const BOTS = {
  cli_worker: { larkAppId: 'cli_worker', cliId: 'claude-code', workingDir: '/frozen/work' },
  cli_other: { larkAppId: 'cli_other', cliId: 'claude-code', workingDir: '/frozen/work' },
};
const initiator: V3RunEditCaller = { openId: INITIATOR, origin: 'human' };
const other: V3RunEditCaller = { openId: OTHER, origin: 'human' };

const bases: string[] = [];
const driveErrors: string[] = [];
afterEach(() => {
  for (const base of bases.splice(0)) rmSync(base, { recursive: true, force: true });
  driveErrors.splice(0);
});

function freshBase(): string {
  const base = mkdtempSync(join(tmpdir(), 'v3-runtime-edit-'));
  bases.push(base);
  return base;
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function goal(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { id, type: 'goal', goal: `do ${id}`, bot: 'cli_worker', depends: [], inputs: [], ...extra };
}

function seedRun(base: string, runId: string, nodes: unknown[], nodeExecutor?: 'bot'): string {
  const runDir = join(base, runId);
  mkdirSync(runDir, { recursive: true });
  writeJson(join(runDir, 'dag.json'), { schemaVersion: 2, runId, nodes });
  writeJson(join(runDir, 'spec.json'), {
    schemaVersion: 1,
    runId,
    title: 'edited flow',
    requirement: 'finish the work',
    nodes: [{
      sketchId: 'a', goal: 'do it', input_needs: [], expected_outputs: ['out'],
      acceptance: 'done', risk_gate: false, unknowns: [],
    }],
  });
  writeJson(join(runDir, 'bots.snapshot.json'), BOTS);
  publishRunEnvelopeOnce(runDir, makeAdHocRunEnvelope({
    runId,
    createdAt: '2026-11-03T08:00:00.000Z',
    authorizedAt: '2026-11-03T08:01:00.000Z',
    authorizedByOpenId: INITIATOR,
    chatBinding: BINDING,
    artifacts: {
      dag: artifactRef(runDir, 'dag.json'),
      spec: artifactRef(runDir, 'spec.json'),
      botSnapshots: artifactRef(runDir, 'bots.snapshot.json'),
    },
    ...(nodeExecutor ? { nodeExecutor } : {}),
  }));
  // The run has started (edits target running runs); drives resume it.
  appendEvent(join(runDir, 'journal.ndjson'), {
    type: 'runStarted', runId, ...(nodeExecutor ? { nodeExecutor } : {}),
  });
  return runDir;
}

const noNewBots = (selector: string): never => {
  throw new Error(`unknown bot ${selector}`);
};

function edit(base: string, runId: string, patch: unknown, baseRevision: number, caller = initiator) {
  return applyV3RunEdit({ baseDir: base, runId, patch, baseRevision, caller, resolveNewBotSnapshot: noNewBots });
}

/** A fake worker: nodes listed in `hold` block until aborted or released;
 *  everything else writes an ok manifest. Records the goal it was given. */
function fakeWorkers(hold: string[] = []) {
  const calls: Array<{ nodeId: string; attemptId: string; goal: string }> = [];
  const releases = new Map<string, () => void>();
  const runNode: RunNode = async (req: RunNodeRequest) => {
    calls.push({ nodeId: req.node.id, attemptId: req.attemptId, goal: req.node.goal });
    const manifestPath = join(req.attemptDir, 'manifest.json');
    if (hold.includes(req.node.id)) {
      const outcome = await new Promise<'release' | 'abort'>((resolve) => {
        releases.set(req.attemptId, () => resolve('release'));
        if (req.cancelSignal?.aborted) resolve('abort');
        else req.cancelSignal?.addEventListener('abort', () => resolve('abort'), { once: true });
      });
      if (outcome === 'abort') return { status: 'cancelled', manifestPath };
    }
    writeJson(manifestPath, { schemaVersion: 1, status: 'ok', summary: 'ok', files: [] });
    return { status: 'ok', manifestPath };
  };
  return { runNode, calls, releases };
}

function runner(base: string, runNode: RunNode, extra: Partial<Parameters<typeof createV3GateRunner>[0]> = {}) {
  return createV3GateRunner({
    baseDir: base,
    loadBots: () => [],
    makeRunNode: () => runNode,
    validateManifest: async () => ({ ok: true, manifest: { schemaVersion: 1, status: 'ok', summary: '', files: [] } }),
    postCard: async () => {},
    onError: (runId, err) => { driveErrors.push(`${runId}: ${err instanceof Error ? err.message : String(err)}`); },
    ...extra,
  });
}

function journal(runDir: string): StoredEvent[] {
  return readJournal(join(runDir, 'journal.ndjson'));
}

function statusOf(runDir: string, nodeId: string): string | undefined {
  return projectRun('x', runDir).nodes.find((node) => node.id === nodeId)?.status;
}

describe('running node changed (ephemeral worker)', () => {
  it('drains the live attempt and re-dispatches a fresh instance with the new definition', async () => {
    const base = freshBase();
    const runDir = seedRun(base, 'run-a', [goal('a'), goal('b', { depends: ['a'] })]);
    const workers = fakeWorkers(['a']);
    const driving = runner(base, workers.runNode).drive('run-a');
    await vi.waitFor(() => expect(workers.calls).toHaveLength(1), { timeout: 5_000 });

    const out = edit(base, 'run-a', [{ op: 'updateNode', nodeId: 'a', set: { goal: 'do a, the new way' } }], 1);
    expect(out).toMatchObject({ kind: 'applied', revision: 2 });
    // The hold is only for the first attempt; the fresh instance completes.
    workers.releases.clear();
    await vi.waitFor(() => expect(workers.calls.length).toBeGreaterThanOrEqual(2), { timeout: 5_000 });
    workers.releases.get(workers.calls[1]!.attemptId)?.();
    await driving;

    expect(workers.calls.map((call) => [call.nodeId, call.attemptId, call.goal])).toEqual([
      ['a', 'a#001/attempts/001', 'do a'],
      ['a', 'a#002/attempts/001', 'do a, the new way'],
      ['b', 'b#001/attempts/001', 'do b'],
    ]);
    const events = journal(runDir);
    expect(events).toContainEqual(expect.objectContaining({
      type: 'nodeAttemptDrained', attemptId: 'a#001/attempts/001', reason: 'obsoleteAttempt',
    }));
    expect(events.find((event) => event.type === 'nodeDispatched' && event.instanceId === 'a#002'))
      .toMatchObject({ revision: 2 });
    expect(readFileSync(join(runDir, 'a#002', 'attempts', '001', 'goal.txt'), 'utf-8')).toContain('the new way');
    expect(events.at(-1)).toMatchObject({ type: 'runSucceeded' });
    expect(driveErrors).toEqual([]);
  });
});

describe('running node changed (bot executor)', () => {
  class Transport implements V3ExternalNodeExecutor {
    dispatches: V3ExternalDispatchRequest[] = [];
    stops: V3ExternalStopRequest[] = [];
    async dispatch(req: V3ExternalDispatchRequest) {
      this.dispatches.push(req);
      return { kind: 'sent' as const, handoffMessageId: `om_${req.attemptId}` };
    }
    async probeAcceptance() { return { status: 'notAccepted' as const }; }
    async stop(req: V3ExternalStopRequest) { this.stops.push(req); }
  }

  it('reassign within the approved bots stops the old turn, rejects its late submission and hands off anew', async () => {
    const base = freshBase();
    const runDir = seedRun(base, 'run-bot', [goal('a')], 'bot');
    const transport = new Transport();
    const deps: V3DaemonRunDeps = {
      baseDir: base,
      loadBots: () => [],
      makeRunNode: () => async () => { throw new Error('no ephemeral workers in bot mode'); },
      postGateCard: async () => {},
      externalExecutor: transport,
      now: () => 1_000,
    };
    await driveV3Run('run-bot', deps);
    expect(transport.dispatches).toHaveLength(1);
    const first = openV3ExternalAttempts(journal(runDir))[0]!;

    expect(edit(base, 'run-bot', [{ op: 'reassign', nodeId: 'a', bot: 'cli_other' }], 1))
      .toMatchObject({ kind: 'applied', revision: 2 });
    expect(classifyExternalAttempt(journal(runDir), first.attemptId)).toMatchObject({ ok: false, reason: 'superseded' });

    await driveV3Run('run-bot', deps);
    expect(transport.stops).toEqual([expect.objectContaining({ attemptId: first.attemptId, reason: 'obsolete' })]);
    expect(transport.dispatches[1]).toMatchObject({
      instanceId: 'a#002',
      targetLarkAppId: 'cli_other',
      revision: 2,
      reassignedFrom: 'cli_worker',
      revisedBy: { revision: 2 },
    });
  });
});

describe('blocked node edited (bot executor)', () => {
  it('reassign retries it on the new bot through nodeRetryRequested; a definition-only change leaves it blocked', async () => {
    const base = freshBase();
    const runDir = seedRun(base, 'run-blocked', [goal('a')], 'bot');
    const dispatches: V3ExternalDispatchRequest[] = [];
    const deps: V3DaemonRunDeps = {
      baseDir: base,
      loadBots: () => [],
      makeRunNode: () => async () => { throw new Error('no ephemeral workers'); },
      postGateCard: async () => {},
      postBlockedCard: async () => {},
      externalExecutor: {
        dispatch: async (req) => { dispatches.push(req); return { kind: 'sent', handoffMessageId: `om_${req.attemptId}` }; },
        probeAcceptance: async () => ({ status: 'notAccepted' }),
        stop: async () => {},
      },
      now: () => 1_000,
    };
    await driveV3Run('run-blocked', deps);
    const attemptId = dispatches[0]!.attemptId;
    appendEvent(join(runDir, 'journal.ndjson'), {
      type: 'nodeBlocked', nodeId: 'a', instanceId: 'a#001', attemptId, errorClass: 'workerError', errorCode: 'BOT_REPORTED_BLOCKED',
    });
    await driveV3Run('run-blocked', deps);
    expect(projectV3RunStatus(base, 'run-blocked').runStatus).toBe('blocked');

    expect(edit(base, 'run-blocked', [{ op: 'updateNode', nodeId: 'a', set: { goal: 'clearer a' } }], 1))
      .toMatchObject({ kind: 'applied', revision: 2 });
    await driveV3Run('run-blocked', deps);
    expect(projectV3RunStatus(base, 'run-blocked').runStatus).toBe('blocked');
    expect(dispatches).toHaveLength(1);

    expect(edit(base, 'run-blocked', [{ op: 'reassign', nodeId: 'a', bot: 'cli_other' }], 2))
      .toMatchObject({ kind: 'applied', revision: 3 });
    expect(journal(runDir).at(-1)).toMatchObject({
      type: 'nodeRetryRequested', nodeId: 'a', instanceId: 'a#001', previousAttemptId: attemptId, nextAttemptId: 'a#001/attempts/002',
    });
    await driveV3Run('run-blocked', deps);
    expect(dispatches[1]).toMatchObject({
      attemptId: 'a#001/attempts/002', targetLarkAppId: 'cli_other', revision: 3, node: expect.objectContaining({ goal: 'clearer a' }),
    });
  });
});

describe('bot executor reads the effective node contract', () => {
  it('an accepted handoff of a revised node gets the revised timeout', async () => {
    const base = freshBase();
    const runDir = seedRun(base, 'run-bot-timeout', [goal('a'), goal('b', { depends: ['a'] })], 'bot');
    expect(edit(base, 'run-bot-timeout', [{ op: 'updateNode', nodeId: 'a', set: { timeoutSec: 120 } }], 1))
      .toMatchObject({ kind: 'applied' });
    const dispatches: V3ExternalDispatchRequest[] = [];
    await driveV3Run('run-bot-timeout', {
      baseDir: base,
      loadBots: () => [],
      makeRunNode: () => async () => { throw new Error('no ephemeral workers'); },
      postGateCard: async () => {},
      externalExecutor: {
        dispatch: async (req) => { dispatches.push(req); return { kind: 'sent', handoffMessageId: 'om_h' }; },
        probeAcceptance: async () => ({ status: 'notAccepted' }),
        stop: async () => {},
      },
      now: () => 10_000,
    });
    expect(dispatches[0]).toMatchObject({ nodeId: 'a', revision: 2, timeoutSec: 120 });
    const attemptId = dispatches[0]!.attemptId;
    expect(recordExternalAccepted(runDir, { attemptId, sessionId: 'sess', acceptedAt: 10_000 }, { now: () => 10_000 }))
      .toMatchObject({ ok: true, deadlineAt: 10_000 + 120_000 });
  });
});

describe('gate waiting node changed', () => {
  it('voids the pending gate (frozen card) and asks again under the new definition', async () => {
    const base = freshBase();
    const runDir = seedRun(base, 'run-gate', [goal('g', { humanGate: { prompt: 'ship it?' } })]);
    const posted: string[] = [];
    const workers = fakeWorkers();
    await runner(base, workers.runNode, {
      postCard: async (_binding, gate) => { posted.push(gate.waitId); },
    }).drive('run-gate');
    expect(posted).toEqual(['g#001-gate']);
    recordWaitCardMessage(runDir, 'g#001-gate', 'om_gate_card');

    const out = edit(base, 'run-gate', [{ op: 'updateNode', nodeId: 'g', set: { goal: 'ship the fixed build' } }], 1);
    expect(out.kind === 'applied' && out.voidedGates).toEqual([
      expect.objectContaining({ waitId: 'g#001-gate', cardMessageIds: ['om_gate_card'] }),
    ]);
    expect(readWait(runDir, 'g#001-gate')?.status).toBe('voided');

    // A late click on the old card cannot approve the new definition.
    expect(resolveV3GateClick(base, 'run-gate', { waitId: 'g#001-gate', selected: 'approve', by: INITIATOR }))
      .toEqual({ kind: 'already-settled', status: 'voided' });
    const frozen = await handleV3GateAction({
      action: V3_GATE_APPROVE_ACTION, runId: 'run-gate', waitId: 'g#001-gate', nodeId: 'g',
      nonce: v3GateCardNonce('run-gate', 'g#001-gate'),
    }, INITIATOR, { baseDir: base, driveRun: () => {} }) as { header?: unknown; elements?: Array<{ tag: string; actions?: Array<{ value?: unknown }> }> };
    expect(frozen.header).toBeDefined();
    expect(frozen.elements?.some((element) => element.actions?.some((action) => action.value !== undefined))).toBe(false);

    await runner(base, workers.runNode, {
      postCard: async (_binding, gate) => { posted.push(gate.waitId); },
    }).drive('run-gate');
    expect(posted).toEqual(['g#001-gate', 'g#002-gate']);
    expect(workers.calls).toEqual([]);
  });
});

describe('M1 turn classes and M2 confirmation', () => {
  it('another member\'s edit becomes a proposal; touched nodes wait while the rest of the run continues', async () => {
    const base = freshBase();
    const runDir = seedRun(base, 'run-prop', [goal('a'), goal('b')]);
    const out = edit(base, 'run-prop', [{ op: 'updateNode', nodeId: 'b', set: { goal: 'b, rewritten' } }], 1, other);
    expect(out).toMatchObject({ kind: 'proposed', revision: 2, reasons: ['callerNotInitiator'] });
    expect(readV3RevisionWait(runDir, 2)?.status).toBe('pending');

    const workers = fakeWorkers();
    const outcome = await driveV3Run('run-prop', {
      baseDir: base, loadBots: () => [], makeRunNode: () => workers.runNode, postGateCard: async () => {},
      validateManifest: async () => ({ ok: true, manifest: { schemaVersion: 1, status: 'ok', summary: '', files: [] } }),
    });
    expect(workers.calls.map((call) => call.nodeId)).toEqual(['a']);
    expect(outcome).toMatchObject({ reason: 'awaitingGate', pendingWaits: [], pendingRevision: 2 });
    expect(projectV3RunStatus(base, 'run-prop')).toMatchObject({
      revision: 1,
      pendingProposal: { revision: 2, touched: ['b'], reasons: ['callerNotInitiator'] },
    });

    const value = { action: V3_REVISION_APPROVE_ACTION, runId: 'run-prop', revision: 2, nonce: v3RevisionCardNonce('run-prop', 2) } as const;
    const driven: string[] = [];
    const denied = await handleV3RevisionAction(value, OTHER, { baseDir: base, driveRun: (id) => driven.push(id) });
    expect(denied).toMatchObject({ toast: expect.anything() });
    expect(readV3RevisionWait(runDir, 2)?.status).toBe('pending');

    const approved = await handleV3RevisionAction(value, INITIATOR, { baseDir: base, driveRun: (id) => driven.push(id) });
    expect(approved).toMatchObject({ header: expect.anything() });
    expect(driven).toEqual(['run-prop']);
    expect(journal(runDir).filter((event) => event.type.startsWith('dagRevision') || event.type === 'dagRevised'))
      .toEqual([
        expect.objectContaining({ type: 'dagRevisionProposed', revision: 2 }),
        expect.objectContaining({ type: 'dagRevised', revision: 2, approval: { by: INITIATOR, proposedBy: OTHER } }),
        expect.objectContaining({ type: 'dagRevisionApproved', revision: 2, by: INITIATOR }),
      ]);

    await driveV3Run('run-prop', {
      baseDir: base, loadBots: () => [], makeRunNode: () => workers.runNode, postGateCard: async () => {},
      validateManifest: async () => ({ ok: true, manifest: { schemaVersion: 1, status: 'ok', summary: '', files: [] } }),
    });
    expect(workers.calls.map((call) => [call.nodeId, call.goal])).toEqual([['a', 'do a'], ['b', 'b, rewritten']]);
  });

  it('a pending proposal keeps a finished run from declaring success until the initiator decides', async () => {
    const base = freshBase();
    const runDir = seedRun(base, 'run-hold', [goal('a')]);
    const workers = fakeWorkers(['a']);
    const driving = runner(base, workers.runNode).drive('run-hold');
    await vi.waitFor(() => expect(workers.calls).toHaveLength(1), { timeout: 5_000 });
    expect(edit(base, 'run-hold', [{ op: 'addNode', node: goal('c', { depends: ['a'] }) }], 1, other))
      .toMatchObject({ kind: 'proposed' });
    workers.releases.get(workers.calls[0]!.attemptId)!();
    await driving;
    expect(journal(runDir).some((event) => event.type === 'runSucceeded')).toBe(false);
    expect(decideV3RevisionProposal({ baseDir: base, runId: 'run-hold', revision: 2, decision: 'approve', by: INITIATOR }))
      .toMatchObject({ kind: 'approved' });
    await runner(base, workers.runNode).drive('run-hold');
    expect(workers.calls.map((call) => call.nodeId)).toEqual(['a', 'c']);
    expect(journal(runDir).at(-1)).toMatchObject({ type: 'runSucceeded' });
  });

  it('a rejected proposal releases the held nodes on the old flow', async () => {
    const base = freshBase();
    seedRun(base, 'run-rej', [goal('a')]);
    edit(base, 'run-rej', [{ op: 'updateNode', nodeId: 'a', set: { goal: 'other a' } }], 1, other);
    const rejected = await handleV3RevisionAction(
      { action: V3_REVISION_REJECT_ACTION, runId: 'run-rej', revision: 2, nonce: v3RevisionCardNonce('run-rej', 2) },
      INITIATOR,
      { baseDir: base, driveRun: () => {} },
    );
    expect(rejected).toMatchObject({ header: expect.anything() });
    const workers = fakeWorkers();
    await runner(base, workers.runNode).drive('run-rej');
    expect(workers.calls.map((call) => call.goal)).toEqual(['do a']);
    expect(projectV3RunStatus(base, 'run-rej').revision).toBe(1);
  });

  it('even the initiator\'s confirmation-list change goes through the card', () => {
    const base = freshBase();
    seedRun(base, 'run-list', [goal('a', { humanGate: { prompt: 'ok?' } })]);
    expect(edit(base, 'run-list', [{ op: 'updateNode', nodeId: 'a', set: { humanGate: null } }], 1))
      .toMatchObject({ kind: 'proposed', reasons: ['gateRelaxed'] });
  });

  it('a new bot is resolved, pinned in a sidecar, and used only after approval', async () => {
    const base = freshBase();
    const runDir = seedRun(base, 'run-newbot', [goal('a')]);
    const out = applyV3RunEdit({
      baseDir: base,
      runId: 'run-newbot',
      patch: [{ op: 'reassign', nodeId: 'a', bot: 'cli_fresh' }],
      baseRevision: 1,
      caller: initiator,
      resolveNewBotSnapshot: (selector) => ({ larkAppId: selector, cliId: 'codex', workingDir: '/fresh' }) as never,
    });
    expect(out).toMatchObject({ kind: 'proposed', reasons: ['newBot'] });
    expect(existsSync(v3RevisionFilePaths(runDir, 2).bots)).toBe(true);
    expect(decideV3RevisionProposal({ baseDir: base, runId: 'run-newbot', revision: 2, decision: 'approve', by: INITIATOR }))
      .toMatchObject({ kind: 'approved' });
    const workers = fakeWorkers();
    const seen: string[] = [];
    await runner(base, async (req) => { seen.push(req.botSnapshot.larkAppId); return workers.runNode(req); }).drive('run-newbot');
    expect(seen).toEqual(['cli_fresh']);
  });

  it('a turn woken by this run\'s own events edits directly, recorded as the main bot', () => {
    const base = freshBase();
    const runDir = seedRun(base, 'run-event', [goal('a')]);
    const authority = authorizeV3RunEditCommand({
      runId: 'run-event',
      baseDir: base,
      dataDir: base,
      resolveProvenance: () => ({
        sessionId: 's1', turnId: 'wake-1', callerOpenId: OTHER,
        larkAppId: BINDING.larkAppId, chatId: BINDING.chatId, rootMessageId: BINDING.rootMessageId,
        workflowRunEvent: { runId: 'run-event' },
      }),
    });
    expect(authority).toMatchObject({ origin: 'runEvent', callerOpenId: OTHER });
    const out = edit(base, 'run-event', [{ op: 'updateNode', nodeId: 'a', set: { goal: 'retry smarter' } }], 1, {
      openId: authority.callerOpenId,
      origin: authority.origin,
    });
    expect(out).toMatchObject({ kind: 'applied' });
    expect(journal(runDir).find((event) => event.type === 'dagRevised')).toMatchObject({
      by: OTHER, auto: { by: 'main_bot' },
    });
    expect(projectRun('run-event', runDir).revision?.history[0]).toMatchObject({ by: 'mainBot' });

    // A wake-up never lends its turn to another run.
    expect(() => authorizeV3RunEditForCurrentTuple({
      runId: 'run-event',
      baseDir: base,
      current: {
        callerOpenId: OTHER, larkAppId: BINDING.larkAppId, chatId: BINDING.chatId,
        rootMessageId: BINDING.rootMessageId, workflowRunEvent: { runId: 'some-other-run' },
      },
    })).toThrow(V3DaemonCommandAuthorityError);
  });

  it('status/edit require the run\'s main session, not ownership', () => {
    const base = freshBase();
    seedRun(base, 'run-auth', [goal('a')]);
    const current = { callerOpenId: OTHER, larkAppId: BINDING.larkAppId, chatId: BINDING.chatId, rootMessageId: BINDING.rootMessageId };
    expect(authorizeV3RunEditForCurrentTuple({ runId: 'run-auth', baseDir: base, current }).callerOpenId).toBe(OTHER);
    for (const wrong of [
      { ...current, rootMessageId: 'om_another_topic' },
      { ...current, chatId: 'oc_elsewhere' },
      { ...current, larkAppId: 'cli_someone' },
    ]) {
      expect(() => authorizeV3RunEditForCurrentTuple({ runId: 'run-auth', baseDir: base, current: wrong }))
        .toThrow(V3DaemonCommandAuthorityError);
    }
    expect(() => authorizeV3RunEditCommand({ runId: 'run-auth', baseDir: base, dataDir: base, resolveProvenance: () => null }))
      .toThrow(V3DaemonCommandAuthorityError);
  });

  it('the IPC body keeps the authenticated caller and refuses anything else', () => {
    const body = JSON.stringify({ patch: { ops: [] }, base: 2, caller: { openId: OTHER, origin: 'human' } });
    expect(parseWorkflowDaemonMutationBody('edit', body)).toMatchObject({ ok: true, body: { value: { base: 2 } } });
    for (const bad of [
      { patch: {}, base: 0, caller: { openId: OTHER, origin: 'human' } },
      { patch: {}, base: 2, caller: { openId: OTHER, origin: 'admin' } },
      { patch: {}, base: 2, caller: { openId: OTHER, origin: 'human' }, extra: 1 },
    ]) {
      expect(parseWorkflowDaemonMutationBody('edit', JSON.stringify(bad)).ok).toBe(false);
    }
  });
});

describe('optimistic concurrency and crash windows', () => {
  it('a stale base is a conflict: nothing is written and the current revision is reported', () => {
    const base = freshBase();
    const runDir = seedRun(base, 'run-cc', [goal('a'), goal('b')]);
    expect(edit(base, 'run-cc', [{ op: 'updateNode', nodeId: 'a', set: { goal: 'x' } }], 1)).toMatchObject({ kind: 'applied', revision: 2 });
    const before = journal(runDir).length;
    expect(edit(base, 'run-cc', [{ op: 'updateNode', nodeId: 'b', set: { goal: 'y' } }], 1))
      .toEqual({ kind: 'conflict', currentRevision: 2 });
    expect(journal(runDir)).toHaveLength(before);
    expect(existsSync(v3RevisionFilePaths(runDir, 3).dag)).toBe(false);
  });

  it('revision files written but the event never landed: invisible, and the number is safely reused', () => {
    const base = freshBase();
    const runDir = seedRun(base, 'run-crash', [goal('a')]);
    mkdirSync(join(runDir, 'dag-revisions'), { recursive: true });
    writeFileSync(v3RevisionFilePaths(runDir, 2).dag, '{"torn":');
    expect(projectV3RunStatus(base, 'run-crash').revision).toBe(1);
    expect(edit(base, 'run-crash', [{ op: 'updateNode', nodeId: 'a', set: { goal: 'z' } }], 1))
      .toMatchObject({ kind: 'applied', revision: 2 });
    const loaded = loadAuthorizedV3Run(runDir);
    expect(loadEffectiveV3Dag(runDir, loaded.dag, journal(runDir)).dag.nodes[0]?.goal).toBe('z');
  });

  it('a direct edit landing first makes the pending proposal stale; its later approval is refused', () => {
    const base = freshBase();
    const runDir = seedRun(base, 'run-race', [goal('a'), goal('b')]);
    edit(base, 'run-race', [{ op: 'updateNode', nodeId: 'a', set: { goal: 'from member' } }], 1, other);
    const direct = edit(base, 'run-race', [{ op: 'updateNode', nodeId: 'b', set: { goal: 'from initiator' } }], 1);
    expect(direct).toMatchObject({ kind: 'applied', revision: 3, voidedProposals: [{ revision: 2, reason: 'stale' }] });
    expect(decideV3RevisionProposal({ baseDir: base, runId: 'run-race', revision: 2, decision: 'approve', by: INITIATOR }))
      .toMatchObject({ kind: 'already-decided', status: 'voided' });
    expect(journal(runDir).some((event) => event.type === 'dagRevised' && event.revision === 2)).toBe(false);
  });

  it('approval re-validates against the flow as it is now (journal moved on without a stale verdict)', () => {
    const base = freshBase();
    const runDir = seedRun(base, 'run-race2', [goal('a'), goal('b')]);
    edit(base, 'run-race2', [{ op: 'updateNode', nodeId: 'a', set: { goal: 'from member' } }], 1, other);
    // Another writer's revision 3 committed but crashed before recording the
    // proposal's stale verdict.
    const third = JSON.parse(readFileSync(v3RevisionFilePaths(runDir, 2).dag, 'utf-8')) as { nodes: Array<{ goal?: string }> };
    third.nodes[1]!.goal = 'from elsewhere';
    const bytes = `${JSON.stringify(third, null, 2)}\n`;
    writeFileSync(v3RevisionFilePaths(runDir, 3).dag, bytes);
    const { createHash } = require('node:crypto') as typeof import('node:crypto');
    appendEvent(join(runDir, 'journal.ndjson'), {
      type: 'dagRevised', revision: 3, baseRevision: 1,
      sha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}`, patchSha256: 'sha256:x', summary: '改 1 节点', by: INITIATOR,
    });
    expect(decideV3RevisionProposal({ baseDir: base, runId: 'run-race2', revision: 2, decision: 'approve', by: INITIATOR }))
      .toMatchObject({ kind: 'stale' });
    expect(projectV3RunStatus(base, 'run-race2').revision).toBe(3);
  });

  it('approval refuses a proposal whose pinned revision file changed after it was shown', () => {
    const base = freshBase();
    const runDir = seedRun(base, 'run-pinned', [goal('a'), goal('b')]);
    edit(base, 'run-pinned', [{ op: 'updateNode', nodeId: 'a', set: { goal: 'shown to the initiator' } }], 1, other);
    const shown = JSON.parse(readFileSync(v3RevisionFilePaths(runDir, 2).dag, 'utf-8')) as { nodes: Array<{ goal?: string }> };
    shown.nodes[1]!.goal = 'slipped in afterwards';
    writeFileSync(v3RevisionFilePaths(runDir, 2).dag, `${JSON.stringify(shown, null, 2)}\n`);
    expect(decideV3RevisionProposal({ baseDir: base, runId: 'run-pinned', revision: 2, decision: 'approve', by: INITIATOR }))
      .toMatchObject({ kind: 'stale' });
    expect(projectV3RunStatus(base, 'run-pinned').revision).toBe(1);
  });

  it('restart with a pending proposal re-posts its card; a lost wait file is recreated', async () => {
    const base = freshBase();
    const runDir = seedRun(base, 'run-cold', [goal('a')]);
    edit(base, 'run-cold', [{ op: 'updateNode', nodeId: 'a', set: { goal: 'm' } }], 1, other);
    rmSync(v3RevisionWaitPath(runDir, 2));
    const reposted: number[] = [];
    await runner(base, fakeWorkers().runNode, {
      postRevisionCard: async (_binding, view) => { reposted.push(view.revision); },
    }).coldAttach(BINDING.larkAppId);
    expect(reposted).toEqual([2]);
    expect(readV3RevisionWait(runDir, 2)).toMatchObject({ status: 'pending', view: { changes: { changed: ['a'] } } });
    expect(reconcileV3RevisionProposals(base, 'cli_not_the_owner')).toEqual([]);
  });

  it('an approval whose journal half was lost is finished on restart', () => {
    const base = freshBase();
    const runDir = seedRun(base, 'run-heal', [goal('a')]);
    edit(base, 'run-heal', [{ op: 'updateNode', nodeId: 'a', set: { goal: 'healed' } }], 1, other);
    const wait = readV3RevisionWait(runDir, 2)!;
    writeJson(v3RevisionWaitPath(runDir, 2), { ...wait, status: 'approved', by: INITIATOR });
    expect(reconcileV3RevisionProposals(base, BINDING.larkAppId)).toEqual([
      expect.objectContaining({ runId: 'run-heal', resume: true }),
    ]);
    expect(projectV3RunStatus(base, 'run-heal').revision).toBe(2);
  });

  it('a tampered revision file fails the run closed', async () => {
    const base = freshBase();
    const runDir = seedRun(base, 'run-tamper', [goal('a'), goal('b')]);
    edit(base, 'run-tamper', [{ op: 'removeNode', nodeId: 'b' }], 1);
    writeFileSync(v3RevisionFilePaths(runDir, 2).dag, readFileSync(join(runDir, 'dag.json')));
    await expect(driveV3Run('run-tamper', {
      baseDir: base, loadBots: () => [], makeRunNode: () => fakeWorkers().runNode, postGateCard: async () => {},
    })).rejects.toThrow(/digest mismatch/);
  });
});

describe('save, projections and the old-run regression', () => {
  it('saving an edited run keeps the final effective flow and reports the edit count', async () => {
    const base = freshBase();
    const runDir = seedRun(base, 'run-save', [goal('a')]);
    const workers = fakeWorkers(['a']);
    const driving = runner(base, workers.runNode).drive('run-save');
    await vi.waitFor(() => expect(workers.calls).toHaveLength(1), { timeout: 5_000 });
    expect(edit(base, 'run-save', [{ op: 'addNode', node: goal('b', { depends: ['a'] }) }], 1))
      .toMatchObject({ kind: 'applied' });
    workers.releases.get(workers.calls[0]!.attemptId)!();
    await driving;
    expect(journal(runDir).at(-1)).toMatchObject({ type: 'runSucceeded' });

    const compiled = compileSavedWorkflowFromRun(runDir);
    expect(compiled.runtimeRevisions).toBe(1);
    expect(compiled.revision.dagTemplate.nodes.map((node) => node.id)).toEqual(['a', 'b']);
  });

  it('progress and dashboard project the effective flow, history, marks and the pending proposal', () => {
    const base = freshBase();
    const runDir = seedRun(base, 'run-view', [goal('a'), goal('b')]);
    edit(base, 'run-view', [{ op: 'addNode', node: goal('c') }, { op: 'updateNode', nodeId: 'a', set: { goal: 'a2' } }], 1);
    edit(base, 'run-view', [{ op: 'removeNode', nodeId: 'b' }, { op: 'addNode', node: goal('d') }], 2, other);

    const loaded = loadAuthorizedV3Run(runDir);
    const events = journal(runDir);
    const progress = projectV3Progress({
      envelope: loaded.envelope,
      dag: loadEffectiveV3Dag(runDir, loaded.dag, events).dag,
      events,
    });
    expect(progress.counts.total).toBe(3);
    expect(progress.revision).toMatchObject({ current: 2, edits: 1, pending: 3 });

    const view = projectRun('run-view', runDir);
    expect(view.revision).toMatchObject({
      current: 2,
      pending: { revision: 3 },
      history: [
        expect.objectContaining({ revision: 2, state: 'applied', by: 'initiator', confirmed: false }),
        expect.objectContaining({ revision: 3, state: 'pending', by: 'other' }),
      ],
    });
    const nodes = Object.fromEntries(view.nodes.map((node) => [node.id, node]));
    expect(nodes.a).toMatchObject({ revisionMark: 'changed' });
    expect(nodes.c).toMatchObject({ revisionMark: 'added' });
    expect(nodes.b).toMatchObject({ pendingChange: 'remove' });
    expect(nodes.d).toMatchObject({ pendingChange: 'add', status: 'pending' });
  });

  it('a run that is never edited keeps its journal and projections exactly as before', async () => {
    const base = freshBase();
    const runDir = seedRun(base, 'run-old', [goal('a'), goal('b', { depends: ['a'] })]);
    await runner(base, fakeWorkers().runNode).drive('run-old');
    const events = journal(runDir);
    expect(events.filter((event) => event.type === 'nodeDispatched').every((event) => !('revision' in event))).toBe(true);
    expect(events.some((event) => event.type.startsWith('dagRevision') || event.type === 'dagRevised')).toBe(false);
    expect(existsSync(join(runDir, 'dag-revisions'))).toBe(false);
    expect(projectRun('run-old', runDir).revision).toBeUndefined();
    expect(projectRun('run-old', runDir).nodes.every((node) => !node.revisionMark && !node.pendingChange)).toBe(true);
    const loaded = loadAuthorizedV3Run(runDir);
    expect(projectV3Progress({ envelope: loaded.envelope, dag: loaded.dag, events }).revision).toBeUndefined();
    expect(compileSavedWorkflowFromRun(runDir).runtimeRevisions).toBe(0);
    expect(statusOf(runDir, 'b')).toBe('done');
  });
});
