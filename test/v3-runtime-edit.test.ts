/**
 * Runtime flow edits end to end (design §13): the real daemon driver,
 * runtime, journal and state, a fake worker / fake bot transport, a fake
 * clock, and the real card handlers. Covers the §13.4 rows on live runs,
 * M1 turn classes, the M2 proposal flow, optimistic concurrency, crash
 * windows, Saved Workflow save, projections, and the old-run regression.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

// A drive that loops without yielding never lets a timer fire, so a test
// timeout cannot stop it. Every runtime tick takes the journal lock: an armed
// budget turns such a spin into a prompt, distinct failure.
const journalLockBudget = vi.hoisted(() => ({ remaining: undefined as number | undefined }));
vi.mock('../src/workflows/v3/journal.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/workflows/v3/journal.js')>();
  const guarded: typeof actual.withJournalMutationSync = (journalPath, fn) => {
    if (journalLockBudget.remaining !== undefined && --journalLockBudget.remaining < 0) {
      throw new Error('drive kept re-entering the journal lock (spinning)');
    }
    return actual.withJournalMutationSync(journalPath, fn);
  };
  return { ...actual, withJournalMutationSync: guarded };
});
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
  loadV3BotExecutedRun,
  requestV3Retry,
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
  recordV3RevisionCardMessage,
  v3RevisionWaitPath,
  type V3RunEditCaller,
} from '../src/workflows/v3/run-edit.js';
import { foldV3Revisions, v3RevisionDigest, v3RevisionFilePaths } from '../src/workflows/v3/dag-revision.js';
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
import { authorizeV3SessionRunEditRequest } from '../src/workflows/v3/session-relay.js';
import {
  grantV3RerunBudget,
  postV3RerunGrantCardOnce,
  resetV3RerunGrantCardsInFlight,
  v3RerunGrantCardPosted,
} from '../src/workflows/v3/run-edit.js';
import { appendMissingV3RevisionFollowUps, missingV3RevisionFollowUps } from '../src/workflows/v3/dag-revision.js';
import { handleV3BlockedAction } from '../src/im/lark/v3-blocked-card-handler.js';
import {
  buildV3BlockedCardForInfo,
  V3_BLOCKED_ASK_ANSWER_ACTION,
  V3_BLOCKED_RETRY_ACTION,
  v3BlockedCardNonce,
} from '../src/im/lark/v3-blocked-card.js';
import { blockedInfoFor } from '../src/workflows/v3/daemon-run.js';
import type { V3RerunBudgetBlock } from '../src/workflows/v3/dag-revision.js';
import { V3_REVISION_RERUN_GRANT_ACTION, v3RerunGrantCardNonce } from '../src/im/lark/v3-revision-card.js';
import { revisitBudgetStatus } from '../src/workflows/v3/core-control.js';
import { DEFAULT_REVISIT_BUDGET_PER_RUN } from '../src/workflows/v3/dag.js';

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
/** A turn the main bot opened for this run's own events: acts for the
 *  initiator but keeps the full M2 confirmation list (M2 乙). */
const mainBot: V3RunEditCaller = { openId: INITIATOR, origin: 'runEvent' };
const other: V3RunEditCaller = { openId: OTHER, origin: 'human' };

const bases: string[] = [];
const driveErrors: string[] = [];
/** Drives started through `runner()` that have not finished yet. A drive the
 *  runner kicks off on its own (coldAttach resuming a run) keeps writing into
 *  the run directory after the test body returns; removing the directory
 *  under it fails with ENOTEMPTY. */
let liveDrives = 0;
afterEach(async () => {
  journalLockBudget.remaining = undefined;
  resetV3RerunGrantCardsInFlight();
  // Let background drives finish before deleting their directories. A test
  // that deliberately leaves a worker hanging never finishes its drive, so
  // this only waits a bounded time; such a drive is parked, not writing.
  const settleBy = Date.now() + 3_000;
  while (liveDrives > 0 && Date.now() < settleBy) await new Promise((done) => setTimeout(done, 10));
  for (const base of bases.splice(0)) rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
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

function seedRun(
  base: string,
  runId: string,
  nodes: unknown[],
  nodeExecutor?: 'bot',
  opts: { ownerless?: boolean } = {},
): string {
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
    ...(opts.ownerless ? {} : { authorizedByOpenId: INITIATOR }),
    chatBinding: opts.ownerless ? { larkAppId: BINDING.larkAppId, chatId: BINDING.chatId, rootMessageId: BINDING.rootMessageId } : BINDING,
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
    onDriveBegin: () => { liveDrives += 1; },
    onDriveEnd: () => { liveDrives -= 1; },
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

  it('a turn the main bot opened for the run\'s events sends a confirmation-list change through the card', () => {
    const base = freshBase();
    seedRun(base, 'run-list', [goal('a', { humanGate: { prompt: 'ok?' } })]);
    expect(edit(base, 'run-list', [{ op: 'updateNode', nodeId: 'a', set: { humanGate: null } }], 1, mainBot))
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
      caller: mainBot,
      resolveNewBotSnapshot: (selector) => ({ larkAppId: selector, cliId: 'codex', workingDir: '/fresh' }) as never,
    });
    expect(out).toMatchObject({ kind: 'proposed', reasons: ['newBot'] });
    expect(existsSync(v3RevisionFilePaths(runDir, 2).bots)).toBe(true);
    expect(decideV3RevisionProposal({ baseDir: base, runId: 'run-newbot', revision: 2, decision: 'approve', by: INITIATOR }))
      .toMatchObject({ kind: 'approved' });
    // Approved once, it is in the run's scope: using it again needs no confirmation.
    expect(edit(base, 'run-newbot', [{ op: 'addNode', node: goal('b', { bot: 'cli_fresh' }) }], 2))
      .toMatchObject({ kind: 'applied' });
    const workers = fakeWorkers();
    const seen: string[] = [];
    await runner(base, async (req) => { seen.push(req.botSnapshot.larkAppId); return workers.runNode(req); }).drive('run-newbot');
    expect(seen).toEqual(['cli_fresh', 'cli_fresh']);
    // Saving the run keeps the bot the revision approved.
    expect(compileSavedWorkflowFromRun(runDir).runtimeRevisions).toBe(2);
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
      by: 'main_bot', auto: { reason: '' },
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

  it('a direct edit of the same node landing first makes the pending proposal stale; its later approval is refused', () => {
    const base = freshBase();
    const runDir = seedRun(base, 'run-race', [goal('a'), goal('b')]);
    edit(base, 'run-race', [{ op: 'updateNode', nodeId: 'a', set: { goal: 'from member' } }], 1, other);
    const direct = edit(base, 'run-race', [{ op: 'updateNode', nodeId: 'a', set: { goal: 'from initiator' } }], 1);
    expect(direct).toMatchObject({
      kind: 'applied', revision: 3, voidedProposals: [{ revision: 2, reason: 'stale' }], carriedProposals: [],
    });
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
    const patchBytes = `${JSON.stringify({ revision: 3, ops: [{ op: 'updateNode', nodeId: 'b', set: { goal: 'from elsewhere' } }] })}\n`;
    writeFileSync(v3RevisionFilePaths(runDir, 3).patch, patchBytes);
    appendEvent(join(runDir, 'journal.ndjson'), {
      type: 'dagRevised', revision: 3, baseRevision: 1,
      sha256: v3RevisionDigest(bytes), patchSha256: v3RevisionDigest(patchBytes), summary: '改 1 节点', by: INITIATOR,
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

// ─── Review regressions ─────────────────────────────────────────────────────

/** A bot-mode driver that records handoffs and posted gates. */
function botDriver(base: string, now: () => number = () => 1_000) {
  const dispatches: V3ExternalDispatchRequest[] = [];
  const gates: string[] = [];
  const deps: V3DaemonRunDeps = {
    baseDir: base,
    loadBots: () => [],
    makeRunNode: () => async () => { throw new Error('no ephemeral workers'); },
    postGateCard: async (_binding, gate) => { gates.push(gate.waitId); },
    postBlockedCard: async () => {},
    externalExecutor: {
      dispatch: async (req) => { dispatches.push(req); return { kind: 'sent', handoffMessageId: `om_${req.attemptId}` }; },
      probeAcceptance: async () => ({ status: 'notAccepted' }),
      stop: async () => {},
    },
    now,
  };
  return { deps, dispatches, gates };
}

/** The `action` of every button on a card (link buttons carry no value). */
function cardActions(card: unknown): string[] {
  const out: string[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (!node || typeof node !== 'object') return;
    const record = node as Record<string, unknown>;
    if (record.tag === 'button' && record.value && typeof record.value === 'object') {
      out.push(String((record.value as { action?: unknown }).action));
    }
    Object.values(record).forEach(walk);
  };
  walk(card);
  return out;
}

function blockAttempt(runDir: string, nodeId: string, instanceId: string, attemptId: string): void {
  appendEvent(join(runDir, 'journal.ndjson'), {
    type: 'nodeBlocked', nodeId, instanceId, attemptId, errorClass: 'workerError', errorCode: 'BOT_REPORTED_BLOCKED',
  });
}

describe('P1 — a passed gate never covers a changed blocked node', () => {
  async function blockedAfterApprovedGate(base: string, runId: string) {
    const runDir = seedRun(base, runId, [goal('g', { humanGate: { prompt: 'ship?' } })], 'bot');
    const driver = botDriver(base);
    await driveV3Run(runId, driver.deps);
    expect(resolveV3GateClick(base, runId, { waitId: 'g#001-gate', selected: 'approve', by: INITIATOR }))
      .toMatchObject({ kind: 'resolved', resolution: 'approved' });
    await driveV3Run(runId, driver.deps);
    expect(driver.dispatches).toHaveLength(1);
    blockAttempt(runDir, 'g', 'g#001', driver.dispatches[0]!.attemptId);
    await driveV3Run(runId, driver.deps);
    return { runDir, driver };
  }

  it('definition-only edit, then a plain retry: the new goal waits for a fresh gate', async () => {
    const base = freshBase();
    const { driver } = await blockedAfterApprovedGate(base, 'run-p1');
    expect(edit(base, 'run-p1', [{ op: 'updateNode', nodeId: 'g', set: { goal: 'DELETE PROD' } }], 1))
      .toMatchObject({ kind: 'applied' });
    expect(requestV3Retry(base, 'run-p1', { nodeId: 'g' })).toMatchObject({ kind: 'requested' });
    await driveV3Run('run-p1', driver.deps);
    expect(driver.gates).toEqual(['g#001-gate', 'g#002-gate']);
    expect(driver.dispatches).toHaveLength(1);
  });

  it('a confirmed approver change asks the new approvers before the retry runs', async () => {
    const base = freshBase();
    const { runDir, driver } = await blockedAfterApprovedGate(base, 'run-p1b');
    expect(edit(base, 'run-p1b', [{ op: 'updateNode', nodeId: 'g', set: { humanGate: { prompt: 'ship?', approvers: ['ou_security'] } } }], 1, mainBot))
      .toMatchObject({ kind: 'proposed', reasons: ['gateRelaxed'] });
    expect(decideV3RevisionProposal({ baseDir: base, runId: 'run-p1b', revision: 2, decision: 'approve', by: INITIATOR }))
      .toMatchObject({ kind: 'approved' });
    requestV3Retry(base, 'run-p1b', { nodeId: 'g' });
    await driveV3Run('run-p1b', driver.deps);
    expect(driver.gates.at(-1)).toBe('g#002-gate');
    expect(readWait(runDir, 'g#002-gate')?.approvers).toEqual(['ou_security']);
    expect(driver.dispatches).toHaveLength(1);
  });
});

describe('P2 — isolated main sessions reach status / edit through the relay', () => {
  const capability = 'c'.repeat(64);
  const relay = (base: string, runId: string, mutation: 'edit' | 'status', raw: Record<string, unknown> = {}, rootMessageId = BINDING.rootMessageId) =>
    authorizeV3SessionRunEditRequest({
      runId,
      mutation,
      raw: { sessionId: 'sess-main', originCapability: capability, ...raw },
      trustedHost: false,
      session: {
        receiver: false,
        liveOrigin: { capability, turnId: 'om_member_turn', dispatchAttempt: 1 },
        callerOpenId: OTHER,
        chatId: BINDING.chatId,
        larkAppId: BINDING.larkAppId,
        quoteTargetId: 'om_member_turn',
        rootMessageId,
      },
      selfLarkAppId: BINDING.larkAppId,
      baseDir: base,
    });

  it('derives the caller from the live session (never the body) and classifies it with M1', () => {
    const base = freshBase();
    seedRun(base, 'run-relay', [goal('a')]);
    expect(relay(base, 'run-relay', 'status')).toMatchObject({ ok: true, larkAppId: BINDING.larkAppId });
    const decision = relay(base, 'run-relay', 'edit', {
      patch: [{ op: 'updateNode', nodeId: 'a', set: { goal: 'member idea' } }],
      base: 1,
      caller: { openId: INITIATOR, origin: 'runEvent' },
    });
    if (!decision.ok || !decision.edit) throw new Error(JSON.stringify(decision));
    expect(decision.edit.caller).toEqual({ openId: OTHER, origin: 'human' });
    expect(applyV3RunEdit({
      baseDir: base, runId: 'run-relay', patch: decision.edit.patch, baseRevision: decision.edit.base,
      caller: decision.edit.caller, resolveNewBotSnapshot: noNewBots,
    })).toMatchObject({ kind: 'proposed', reasons: ['callerNotInitiator'] });
    expect(relay(base, 'run-relay', 'status', {}, 'om_other_topic')).toMatchObject({ ok: false, error: 'run_binding_mismatch' });
  });
});

describe('P2 — a rerun refused for revisit budget can be unlocked by the initiator', () => {
  it('posts a grant the initiator can click once; the same edit then applies', async () => {
    const base = freshBase();
    const runDir = seedRun(base, 'run-budget', [goal('a'), goal('b')]);
    const journalPath = join(runDir, 'journal.ndjson');
    const finish = (instanceId: string) => {
      const attemptId = `${instanceId}/attempts/001`;
      appendEvent(journalPath, { type: 'nodeDispatched', nodeId: 'a', instanceId, attemptId });
      appendEvent(journalPath, { type: 'nodeSucceeded', nodeId: 'a', instanceId, attemptId, manifestPath: join(runDir, 'm.json') });
    };
    finish('a#001');
    appendEvent(journalPath, { type: 'nodeDispatched', nodeId: 'b', instanceId: 'b#001', attemptId: 'b#001/attempts/001' });
    expect(edit(base, 'run-budget', [{ op: 'rerunNode', nodeId: 'a' }], 1)).toMatchObject({ kind: 'applied', revision: 2 });
    finish('a#002');
    // A turn the main bot opened itself does not lift a spent budget.
    const refused = edit(base, 'run-budget', [{ op: 'rerunNode', nodeId: 'a' }], 2, mainBot);
    expect(refused).toMatchObject({ kind: 'invalid', rerunBudget: { nodeId: 'a', tier: 'pair' } });
    const block = refused.kind === 'invalid' ? refused.rerunBudget! : undefined!;
    const { epoch, tier } = block;
    // One card per exhaustion: the bot re-submitting does not post again.
    const posts: string[] = [];
    const post = async () => { posts.push('card'); return `om_card_${posts.length}`; };
    expect(await postV3RerunGrantCardOnce({ baseDir: base, runId: 'run-budget', block, post })).toBe('posted');
    const again = edit(base, 'run-budget', [{ op: 'rerunNode', nodeId: 'a' }], 2, mainBot);
    expect(again.kind === 'invalid' && again.rerunBudget).toEqual(block);
    expect(await postV3RerunGrantCardOnce({ baseDir: base, runId: 'run-budget', block, post })).toBe('already');
    expect(posts).toHaveLength(1);

    expect(grantV3RerunBudget({ baseDir: base, runId: 'run-budget', nodeId: 'a', tier, epoch, by: OTHER })).toEqual({ kind: 'unauthorized' });
    const value = {
      action: V3_REVISION_RERUN_GRANT_ACTION, runId: 'run-budget', nodeId: 'a', tier, epoch,
      nonce: v3RerunGrantCardNonce('run-budget', 'a', tier, epoch),
    } as const;
    // The card value is bound to its exhaustion: a value whose nonce does not
    // match its run/node/tier/epoch is refused before anything is granted.
    const beforeForged = journal(runDir).length;
    for (const nonce of [v3RerunGrantCardNonce('run-budget', 'a', tier, epoch + 1), v3RerunGrantCardNonce('run-budget', 'a', 'run', epoch)]) {
      expect(await handleV3RevisionAction({ ...value, nonce }, INITIATOR, { baseDir: base, driveRun: () => {} }))
        .toMatchObject({ toast: expect.anything() });
    }
    expect(journal(runDir)).toHaveLength(beforeForged);
    expect(await handleV3RevisionAction(value, INITIATOR, { baseDir: base, driveRun: () => {} })).toMatchObject({ header: expect.anything() });
    // A second click cannot add a second rerun.
    expect(grantV3RerunBudget({ baseDir: base, runId: 'run-budget', nodeId: 'a', tier, epoch, by: INITIATOR })).toEqual({ kind: 'already-granted' });
    expect(edit(base, 'run-budget', [{ op: 'rerunNode', nodeId: 'a' }], 2)).toMatchObject({ kind: 'applied', revision: 3 });

    // Spent again → a NEW exhaustion. Until its card is out, the old card says
    // to have the bot re-submit; once posted, the old card points at it.
    finish('a#003');
    const second = edit(base, 'run-budget', [{ op: 'rerunNode', nodeId: 'a' }], 3, mainBot);
    const secondBlock = second.kind === 'invalid' ? second.rerunBudget! : undefined!;
    expect(secondBlock.epoch).not.toBe(epoch);
    expect(grantV3RerunBudget({ baseDir: base, runId: 'run-budget', nodeId: 'a', tier, epoch, by: INITIATOR }))
      .toEqual({ kind: 'expired', newerCardPosted: false });
    expect(await postV3RerunGrantCardOnce({ baseDir: base, runId: 'run-budget', block: secondBlock, post })).toBe('posted');
    expect(await handleV3RevisionAction(value, INITIATOR, { baseDir: base, driveRun: () => {} })).toMatchObject({ toast: expect.anything() });
    expect(grantV3RerunBudget({ baseDir: base, runId: 'run-budget', nodeId: 'a', tier, epoch, by: INITIATOR }))
      .toEqual({ kind: 'expired', newerCardPosted: true });
  });
});

describe('P3-1 — deleting a node waiting at its gate voids that gate', () => {
  it('the wait is voided and its card listed for freezing once the deletion takes effect', async () => {
    const base = freshBase();
    const runDir = seedRun(base, 'run-del-gate', [goal('g', { humanGate: { prompt: 'ok?' } }), goal('z')]);
    await runner(base, fakeWorkers().runNode).drive('run-del-gate');
    recordWaitCardMessage(runDir, 'g#001-gate', 'om_gate_card');
    expect(edit(base, 'run-del-gate', [{ op: 'removeNode', nodeId: 'g' }], 1, mainBot)).toMatchObject({ kind: 'proposed', reasons: ['gateRelaxed'] });
    expect(decideV3RevisionProposal({ baseDir: base, runId: 'run-del-gate', revision: 2, decision: 'approve', by: INITIATOR }))
      .toMatchObject({ kind: 'approved', voidedGates: [{ waitId: 'g#001-gate', cardMessageIds: ['om_gate_card'] }] });
    expect(readWait(runDir, 'g#001-gate')?.status).toBe('voided');
    expect(resolveV3GateClick(base, 'run-del-gate', { waitId: 'g#001-gate', selected: 'approve', by: INITIATOR }))
      .toEqual({ kind: 'already-settled', status: 'voided' });
    await runner(base, fakeWorkers().runNode).drive('run-del-gate');
    expect(journal(runDir).at(-1)).toMatchObject({ type: 'runSucceeded' });
  });
});

describe('P3-4 — a reassign / re-run lost between its two appends is reconciled', () => {
  async function blockedThenReassigned(base: string, runId: string) {
    const runDir = seedRun(base, runId, [goal('a')], 'bot');
    const driver = botDriver(base);
    await driveV3Run(runId, driver.deps);
    blockAttempt(runDir, 'a', 'a#001', driver.dispatches[0]!.attemptId);
    await driveV3Run(runId, driver.deps);
    edit(base, runId, [{ op: 'reassign', nodeId: 'a', bot: 'cli_other' }], 1);
    // Crash after the durable dagRevised: its dedicated events never landed.
    const journalPath = join(runDir, 'journal.ndjson');
    const lines = readFileSync(journalPath, 'utf-8').trimEnd().split('\n');
    const kept = lines.filter((line) => !/"type":"node(Reassigned|RetryRequested)"/.test(line));
    expect(kept.length).toBe(lines.length - 2);
    writeFileSync(journalPath, `${kept.join('\n')}\n`);
    expect(projectV3RunStatus(base, runId).runStatus).toBe('blocked');
    return { runDir, driver };
  }

  it('the next drive re-appends them and the node is handed to the new bot', async () => {
    const base = freshBase();
    const { runDir, driver } = await blockedThenReassigned(base, 'run-lost');
    await driveV3Run('run-lost', driver.deps);
    expect(journal(runDir).filter((event) => event.type === 'nodeRetryRequested')).toHaveLength(1);
    expect(driver.dispatches.at(-1)).toMatchObject({ attemptId: 'a#001/attempts/002', targetLarkAppId: 'cli_other' });
  });

  it('cold attach finishes them once and resumes the run', async () => {
    const base = freshBase();
    const { runDir } = await blockedThenReassigned(base, 'run-lost-cold');
    expect(reconcileV3RevisionProposals(base, BINDING.larkAppId)).toEqual([expect.objectContaining({ runId: 'run-lost-cold', resume: true })]);
    expect(reconcileV3RevisionProposals(base, BINDING.larkAppId)).toEqual([]);
    expect(journal(runDir).filter((event) => event.type === 'nodeReassigned')).toHaveLength(1);
    expect(projectV3RunStatus(base, 'run-lost-cold').runStatus).toBe('running');
  });
});

describe('P3-5 / P3-6 — who may leave a proposal pending', () => {
  it('a run without an authenticated initiator refuses runtime edits', () => {
    const base = freshBase();
    seedRun(base, 'run-ownerless', [goal('a')], undefined, { ownerless: true });
    expect(edit(base, 'run-ownerless', [{ op: 'updateNode', nodeId: 'a', set: { goal: 'x' } }], 1))
      .toMatchObject({ kind: 'rejected', reason: 'not-editable' });
  });

  it('another member cannot replace a pending proposal; the initiator can', () => {
    const base = freshBase();
    seedRun(base, 'run-pending', [goal('a', { humanGate: { prompt: 'ok?' } }), goal('b')]);
    expect(edit(base, 'run-pending', [{ op: 'updateNode', nodeId: 'b', set: { goal: 'first idea' } }], 1, other))
      .toMatchObject({ kind: 'proposed', revision: 2 });
    expect(edit(base, 'run-pending', [{ op: 'updateNode', nodeId: 'b', set: { goal: 'second idea' } }], 1, other))
      .toMatchObject({ kind: 'rejected', reason: 'proposal-pending' });
    expect(projectV3RunStatus(base, 'run-pending').pendingProposal?.revision).toBe(2);
    // The main bot (event turn) proposes in its place …
    expect(edit(base, 'run-pending', [{ op: 'updateNode', nodeId: 'a', set: { humanGate: null } }], 1, mainBot))
      .toMatchObject({ kind: 'proposed', revision: 3, voidedProposals: [{ revision: 2, reason: 'superseded' }] });
    // … and the initiator's own change of the same node takes effect, voiding what was pending.
    expect(edit(base, 'run-pending', [{ op: 'updateNode', nodeId: 'a', set: { goal: 'the initiator decides' } }], 1))
      .toMatchObject({ kind: 'applied', revision: 4, voidedProposals: [{ revision: 3, reason: 'stale' }] });
  });
});

describe('decision → edit → claim interleaving', () => {
  it('a revision landing after the tick decided is never overtaken: the claim re-decides on the new flow', async () => {
    const base = freshBase();
    const runDir = seedRun(base, 'run-race-claim', [
      goal('x'),
      goal('z', { bot: 'cli_other' }),
      goal('y', { depends: ['x'] }),
    ], 'bot');
    const driver = botDriver(base);
    await driveV3Run('run-race-claim', driver.deps);
    const byNode = Object.fromEntries(driver.dispatches.map((req) => [req.nodeId, req]));
    expect(Object.keys(byNode).sort()).toEqual(['x', 'z']);
    expect(recordExternalAccepted(runDir, { attemptId: byNode.z!.attemptId, sessionId: 'sess-z', acceptedAt: 1_000 }, { now: () => 1_000 }))
      .toMatchObject({ ok: true });
    writeJson(join(runDir, 'x-manifest.json'), { schemaVersion: 1, status: 'ok', summary: 'ok', files: [] });
    appendEvent(join(runDir, 'journal.ndjson'), {
      type: 'nodeSucceeded', nodeId: 'x', instanceId: 'x#001', attemptId: byNode.x!.attemptId, manifestPath: join(runDir, 'x-manifest.json'),
    });
    // The engine clock is read while reconciling z — after this tick read the
    // journal, before it claims y. The edit lands exactly there.
    let armed = true;
    const trapped = botDriver(base, () => {
      if (armed) {
        armed = false;
        expect(edit(base, 'run-race-claim', [{ op: 'updateNode', nodeId: 'y', set: { goal: 'y, revised' } }], 1))
          .toMatchObject({ kind: 'applied', revision: 2 });
      }
      return 1_000;
    });
    await driveV3Run('run-race-claim', trapped.deps);
    expect(armed).toBe(false);
    expect(trapped.dispatches).toEqual([expect.objectContaining({ nodeId: 'y', revision: 2, node: expect.objectContaining({ goal: 'y, revised' }) })]);
    expect(journal(runDir).find((event) => event.type === 'nodeDispatched' && event.nodeId === 'y')).toMatchObject({ revision: 2 });
  });
});

describe('editing a running bot node closes the old binding (no ghost slots)', () => {
  it('five edits of a running node: never more than one open external, and the run still finishes', async () => {
    const base = freshBase();
    const runDir = seedRun(base, 'run-ghost', [goal('a'), goal('b', { depends: ['a'] })], 'bot');
    const stops: string[] = [];
    const driver = botDriver(base);
    driver.deps.externalExecutor = {
      ...driver.deps.externalExecutor!,
      stop: async (req) => { stops.push(req.attemptId); },
    };
    await driveV3Run('run-ghost', driver.deps);
    for (let round = 1; round <= 5; round++) {
      expect(edit(base, 'run-ghost', [{ op: 'updateNode', nodeId: 'a', set: { goal: `a, take ${round}` } }], round))
        .toMatchObject({ kind: 'applied', revision: round + 1 });
      await driveV3Run('run-ghost', driver.deps);
      const open = openV3ExternalAttempts(journal(runDir));
      expect(open).toHaveLength(1);
      expect(open[0]).toMatchObject({ nodeId: 'a', instanceId: `a#00${round + 1}` });
    }
    // Every superseded attempt was stopped and closed by an obsolete drain.
    const drained = journal(runDir).filter((event) => event.type === 'nodeAttemptDrained' && event.reason === 'obsoleteAttempt');
    expect(drained.map((event) => (event as { attemptId: string }).attemptId)).toEqual(
      [1, 2, 3, 4, 5].map((n) => `a#00${n}/attempts/001`),
    );
    expect(stops).toEqual(drained.map((event) => (event as { attemptId: string }).attemptId));
    expect(driver.dispatches.at(-1)).toMatchObject({ instanceId: 'a#006', node: expect.objectContaining({ goal: 'a, take 5' }) });

    const settle = (nodeId: string) => {
      const attempt = openV3ExternalAttempts(journal(runDir))[0]!;
      expect(attempt.nodeId).toBe(nodeId);
      writeJson(join(runDir, `${nodeId}-manifest.json`), { schemaVersion: 1, status: 'ok', summary: 'ok', files: [] });
      appendEvent(join(runDir, 'journal.ndjson'), {
        type: 'nodeSucceeded', nodeId, instanceId: attempt.instanceId!, attemptId: attempt.attemptId,
        manifestPath: join(runDir, `${nodeId}-manifest.json`),
      });
    };
    settle('a');
    await driveV3Run('run-ghost', driver.deps);
    settle('b');
    await driveV3Run('run-ghost', driver.deps);
    expect(journal(runDir).at(-1)).toMatchObject({ type: 'runSucceeded' });
    expect(openV3ExternalAttempts(journal(runDir))).toEqual([]);
  });

  it('the ephemeral path closes the superseded worker before its replacement runs', async () => {
    const base = freshBase();
    const runDir = seedRun(base, 'run-ghost-eph', [goal('a')]);
    const workers = fakeWorkers(['a']);
    const driving = runner(base, workers.runNode).drive('run-ghost-eph');
    for (let round = 1; round <= 3; round++) {
      await vi.waitFor(() => expect(workers.calls).toHaveLength(round), { timeout: 5_000 });
      expect(edit(base, 'run-ghost-eph', [{ op: 'updateNode', nodeId: 'a', set: { goal: `a${round}` } }], round))
        .toMatchObject({ kind: 'applied' });
    }
    await vi.waitFor(() => expect(workers.calls).toHaveLength(4), { timeout: 5_000 });
    workers.releases.get(workers.calls[3]!.attemptId)!();
    await driving;
    const events = journal(runDir);
    expect(events.filter((event) => event.type === 'nodeAttemptDrained' && event.reason === 'obsoleteAttempt')).toHaveLength(3);
    expect(events.at(-1)).toMatchObject({ type: 'runSucceeded' });
  });
});

describe('the workflow-node layer reads the effective flow', () => {
  it('a bot run loads with its revised node contract, and refuses to load when a revision is tampered', () => {
    const base = freshBase();
    const runDir = seedRun(base, 'run-node-layer', [goal('a', { timeoutSec: 300 })], 'bot');
    expect(edit(base, 'run-node-layer', [{ op: 'updateNode', nodeId: 'a', set: { goal: 'revised contract' } }], 1))
      .toMatchObject({ kind: 'applied' });
    expect(loadV3BotExecutedRun(runDir)?.dag.nodes[0]?.goal).toBe('revised contract');
    writeFileSync(v3RevisionFilePaths(runDir, 2).dag, readFileSync(join(runDir, 'dag.json')));
    expect(loadV3BotExecutedRun(runDir)).toBeUndefined();
  });
});

// ─── Second review round ────────────────────────────────────────────────────

describe('round 2 — an ask answered after its node was revised is refused visibly', () => {
  it('the answer is not reported as delivered and no retry is recorded', async () => {
    const base = freshBase();
    const runDir = seedRun(base, 'run-ask', [goal('g', { humanGate: { prompt: 'ship?' } })], 'bot');
    const driver = botDriver(base);
    await driveV3Run('run-ask', driver.deps);
    resolveV3GateClick(base, 'run-ask', { waitId: 'g#001-gate', selected: 'approve', by: INITIATOR });
    await driveV3Run('run-ask', driver.deps);
    const attemptId = driver.dispatches[0]!.attemptId;
    appendEvent(join(runDir, 'journal.ndjson'), {
      type: 'nodeBlocked', nodeId: 'g', instanceId: 'g#001', attemptId, errorClass: 'workerError', errorCode: 'ASK_HUMAN',
      ask: { question: 'which region?', options: ['sg', 'us'] },
    });
    await driveV3Run('run-ask', driver.deps);
    expect(edit(base, 'run-ask', [{ op: 'updateNode', nodeId: 'g', set: { goal: 'ship to the new region list' } }], 1))
      .toMatchObject({ kind: 'applied' });
    const before = journal(runDir).length;

    expect(requestV3Retry(base, 'run-ask', { nodeId: 'g', answer: { selected: 'sg', by: INITIATOR } }))
      .toEqual({ kind: 'stale-run', reason: 'revised' });
    const card = await handleV3BlockedAction({
      action: V3_BLOCKED_ASK_ANSWER_ACTION, runId: 'run-ask', nodeId: 'g', attemptId, selected: 'sg',
      nonce: v3BlockedCardNonce('run-ask', 'g', attemptId),
    }, INITIATOR, { baseDir: base, driveRun: () => {} }) as { header?: unknown };
    expect(card.header).toBeDefined();
    expect(cardActions(card)).toEqual([V3_BLOCKED_RETRY_ACTION]);
    expect(journal(runDir)).toHaveLength(before);
    expect(existsSync(join(runDir, attemptId, 'answer.json'))).toBe(false);
    // A plain retry still works — through a fresh gate.
    expect(requestV3Retry(base, 'run-ask', { nodeId: 'g' })).toMatchObject({ kind: 'requested' });
    await driveV3Run('run-ask', driver.deps);
    expect(driver.gates.at(-1)).toBe('g#002-gate');
  });
});

describe('round 2 — lost follow-ups never resurrect or outlive the run', () => {
  async function lostRetry(base: string, runId: string) {
    const runDir = seedRun(base, runId, [goal('a'), goal('z', { bot: 'cli_other' })], 'bot');
    const driver = botDriver(base);
    await driveV3Run(runId, driver.deps);
    const a = driver.dispatches.find((req) => req.nodeId === 'a')!;
    blockAttempt(runDir, 'a', 'a#001', a.attemptId);
    edit(base, runId, [{ op: 'reassign', nodeId: 'a', bot: 'cli_other' }], 1);
    const journalPath = join(runDir, 'journal.ndjson');
    const lines = readFileSync(journalPath, 'utf-8').trimEnd().split('\n');
    writeFileSync(journalPath, `${lines.filter((line) => !/"type":"node(Reassigned|RetryRequested)"/.test(line)).join('\n')}\n`);
    return { runDir, driver };
  }

  it('a lost re-run of a node a later revision removed is not reconciled back to life', async () => {
    const base = freshBase();
    const { runDir, driver } = await lostRetry(base, 'run-lost-removed');
    expect(edit(base, 'run-lost-removed', [{ op: 'removeNode', nodeId: 'a' }], 2)).toMatchObject({ kind: 'applied' });
    await driveV3Run('run-lost-removed', driver.deps);
    const events = journal(runDir);
    expect(events.some((event) => event.type === 'nodeRetryRequested' || event.type === 'nodeReassigned')).toBe(false);
    expect(projectV3RunStatus(base, 'run-lost-removed').nodes.map((node) => node.id)).toEqual(['z']);
    // Even without the effective flow at hand, a removed node is owed nothing.
    expect(missingV3RevisionFollowUps(events)).toEqual([]);
    expect(driver.dispatches.filter((req) => req.nodeId === 'a')).toHaveLength(1);
  });

  it('a lost reassignment of a not-yet-started node a later revision removed is skipped', async () => {
    const base = freshBase();
    const runDir = seedRun(base, 'run-lost-pending', [goal('a'), goal('y', { depends: ['a'] })], 'bot');
    const driver = botDriver(base);
    await driveV3Run('run-lost-pending', driver.deps);
    blockAttempt(runDir, 'a', 'a#001', driver.dispatches[0]!.attemptId);
    expect(edit(base, 'run-lost-pending', [{ op: 'reassign', nodeId: 'y', bot: 'cli_other' }], 1)).toMatchObject({ kind: 'applied' });
    const journalPath = join(runDir, 'journal.ndjson');
    const lines = readFileSync(journalPath, 'utf-8').trimEnd().split('\n');
    writeFileSync(journalPath, `${lines.filter((line) => !/"type":"nodeReassigned"/.test(line)).join('\n')}\n`);
    expect(missingV3RevisionFollowUps(journal(runDir)).map((event) => event.type)).toEqual(['nodeReassigned']);
    expect(edit(base, 'run-lost-pending', [{ op: 'removeNode', nodeId: 'y' }], 2)).toMatchObject({ kind: 'applied' });
    // Cold attach and the drive both check against the effective flow.
    reconcileV3RevisionProposals(base, BINDING.larkAppId);
    expect(journal(runDir).some((event) => event.type === 'nodeReassigned')).toBe(false);
    await driveV3Run('run-lost-pending', driver.deps);
    expect(journal(runDir).some((event) => event.type === 'nodeReassigned')).toBe(false);
  });

  it('nothing is owed once the run is being cancelled', async () => {
    const base = freshBase();
    const { runDir } = await lostRetry(base, 'run-lost-cancel');
    expect(missingV3RevisionFollowUps(journal(runDir)).length).toBeGreaterThan(0);
    appendEvent(join(runDir, 'journal.ndjson'), { type: 'runCancelRequested', cancelRequestId: 'c1', by: INITIATOR });
    expect(missingV3RevisionFollowUps(journal(runDir))).toEqual([]);
  });
});

describe('round 2 — a gate whose wait was already decided is never re-dispatched in a loop', () => {
  it('the drive fails loudly instead of spinning', async () => {
    const base = freshBase();
    const runDir = seedRun(base, 'run-gate-spin', [goal('g', { humanGate: { prompt: 'ok?' } })]);
    const journalPath = join(runDir, 'journal.ndjson');
    appendEvent(journalPath, { type: 'gateDispatched', nodeId: 'g', instanceId: 'g#001', waitId: 'g#001-gate' });
    appendEvent(journalPath, {
      type: 'gateResolved', nodeId: 'g', instanceId: 'g#001', waitId: 'g#001-gate', resolution: 'approved', by: INITIATOR,
    });
    // Corrupt combination: approval dropped while the instance stays the same.
    appendEvent(journalPath, {
      type: 'dagRevised', revision: 2, baseRevision: 1, sha256: 's', patchSha256: 'p', summary: 'x', by: INITIATOR,
      effects: { regate: [{ nodeId: 'g', instanceId: 'g#001' }] },
    });
    const dag = JSON.parse(readFileSync(join(runDir, 'dag.json'), 'utf-8'));
    const bytes = `${JSON.stringify(dag, null, 2)}\n`;
    mkdirSync(join(runDir, 'dag-revisions'), { recursive: true });
    writeFileSync(v3RevisionFilePaths(runDir, 2).dag, bytes);
    writeFileSync(v3RevisionFilePaths(runDir, 2).patch, '{}\n');
    // Re-pin the event to the files just written.
    const lines = readFileSync(journalPath, 'utf-8').trimEnd().split('\n');
    const last = JSON.parse(lines.pop()!);
    last.sha256 = v3RevisionDigest(bytes);
    last.patchSha256 = v3RevisionDigest('{}\n');
    writeFileSync(journalPath, `${[...lines, JSON.stringify(last)].join('\n')}\n`);
    journalLockBudget.remaining = 200;
    await expect(driveV3Run('run-gate-spin', {
      baseDir: base, loadBots: () => [], makeRunNode: () => fakeWorkers().runNode, postGateCard: async () => {},
    })).rejects.toThrow(/already decided/);
  });
});

// ─── Third review round ─────────────────────────────────────────────────────

/** A run whose node `a` has spent its own (pair) rerun budget. */
function exhaustPair(base: string, runId: string, extra: string[] = []): { runDir: string; block: V3RerunBudgetBlock } {
  const runDir = seedRun(base, runId, [goal('a'), ...extra.map((id) => goal(id))]);
  const journalPath = join(runDir, 'journal.ndjson');
  const finish = (nodeId: string, instanceId: string) => {
    const attemptId = `${instanceId}/attempts/001`;
    appendEvent(journalPath, { type: 'nodeDispatched', nodeId, instanceId, attemptId });
    appendEvent(journalPath, { type: 'nodeSucceeded', nodeId, instanceId, attemptId, manifestPath: join(runDir, 'm.json') });
  };
  finish('a', 'a#001');
  for (const id of extra) finish(id, `${id}#001`);
  expect(edit(base, runId, [{ op: 'rerunNode', nodeId: 'a' }], 1)).toMatchObject({ kind: 'applied' });
  finish('a', 'a#002');
  const refused = edit(base, runId, [{ op: 'rerunNode', nodeId: 'a' }], 2, mainBot);
  if (refused.kind !== 'invalid' || !refused.rerunBudget) throw new Error(JSON.stringify(refused));
  return { runDir, block: refused.rerunBudget };
}

describe('round 3 — the rerun grant card is posted before it is recorded', () => {
  it('a failed post records nothing: the next refusal posts the card', async () => {
    const base = freshBase();
    const { block } = exhaustPair(base, 'run-card-fail');
    const posts: string[] = [];
    expect(await postV3RerunGrantCardOnce({
      baseDir: base, runId: 'run-card-fail', block, post: async () => { posts.push('x'); throw new Error('lark down'); },
    })).toBe('failed');
    expect(v3RerunGrantCardPosted(base, 'run-card-fail', block)).toBe(false);
    expect(await postV3RerunGrantCardOnce({
      baseDir: base, runId: 'run-card-fail', block, post: async () => { posts.push('ok'); return 'om_card'; },
    })).toBe('posted');
    expect(v3RerunGrantCardPosted(base, 'run-card-fail', block)).toBe(true);
    expect(await postV3RerunGrantCardOnce({
      baseDir: base, runId: 'run-card-fail', block, post: async () => { posts.push('dup'); return 'om_dup'; },
    })).toBe('already');
    expect(posts).toEqual(['x', 'ok']);
  });

  it('a crash while posting does not lock the card out; concurrent refusals share one post', async () => {
    const base = freshBase();
    const { block } = exhaustPair(base, 'run-card-crash');
    const posts: string[] = [];
    // The process dies inside the post (it never returns).
    void postV3RerunGrantCardOnce({
      baseDir: base, runId: 'run-card-crash', block, post: () => { posts.push('hung'); return new Promise<string>(() => {}); },
    });
    // While it is in flight, another refusal in the same process does not post twice.
    expect(await postV3RerunGrantCardOnce({
      baseDir: base, runId: 'run-card-crash', block, post: async () => { posts.push('dup'); return 'om_dup'; },
    })).toBe('already');
    // Restart: nothing in flight any more, nothing recorded → the card goes out.
    resetV3RerunGrantCardsInFlight();
    expect(await postV3RerunGrantCardOnce({
      baseDir: base, runId: 'run-card-crash', block, post: async () => { posts.push('after-restart'); return 'om_card'; },
    })).toBe('posted');
    expect(posts).toEqual(['hung', 'after-restart']);
  });
});

describe('round 3 — a grant that cannot lift this exhaustion leaves its card valid (ADV-B)', () => {
  it('another node\'s run-wide grant does not expire a pair-exhausted node\'s only card', async () => {
    const base = freshBase();
    const extra = ['b', 'n1', 'n2', 'n3', 'n4', 'n5', 'n6', 'n7'];
    const runId = 'run-adv-b';
    const { runDir } = exhaustPair(base, runId, extra);
    // Spend the run-wide budget (8) with reruns of other nodes.
    let rev = 2;
    for (const id of extra.slice(2)) {
      expect(edit(base, runId, [{ op: 'rerunNode', nodeId: id }], rev)).toMatchObject({ kind: 'applied' });
      rev++;
    }
    expect(edit(base, runId, [{ op: 'rerunNode', nodeId: 'n1' }], rev)).toMatchObject({ kind: 'applied' });
    rev++;
    const refA = edit(base, runId, [{ op: 'rerunNode', nodeId: 'a' }], rev, mainBot);
    const refB = edit(base, runId, [{ op: 'rerunNode', nodeId: 'b' }], rev, mainBot);
    if (refA.kind !== 'invalid' || refB.kind !== 'invalid') throw new Error('expected both refused');
    expect(refA.rerunBudget).toMatchObject({ tier: 'pair' });
    expect(refB.rerunBudget).toMatchObject({ tier: 'run' });
    const cardOf = (block: V3RerunBudgetBlock) => ({
      action: V3_REVISION_RERUN_GRANT_ACTION, runId, nodeId: block.nodeId, tier: block.tier, epoch: block.epoch,
      nonce: v3RerunGrantCardNonce(runId, block.nodeId, block.tier, block.epoch),
    } as const);
    // The initiator clicks b's card first (a run-wide grant) …
    expect(await handleV3RevisionAction(cardOf(refB.rerunBudget!), INITIATOR, { baseDir: base, driveRun: () => {} }))
      .toMatchObject({ header: expect.anything() });
    // … a is still refused on its own budget, for the SAME exhaustion …
    const stillA = edit(base, runId, [{ op: 'rerunNode', nodeId: 'a' }], rev, mainBot);
    expect(stillA.kind === 'invalid' && stillA.rerunBudget).toEqual(refA.rerunBudget);
    // … so a's only card still grants.
    const before = journal(runDir).length;
    expect(await handleV3RevisionAction(cardOf(refA.rerunBudget!), INITIATOR, { baseDir: base, driveRun: () => {} }))
      .toMatchObject({ header: expect.anything() });
    expect(journal(runDir).length).toBe(before + 1);
    expect(edit(base, runId, [{ op: 'rerunNode', nodeId: 'a' }], rev)).toMatchObject({ kind: 'applied' });
  });
});

/** A gated bot node `g`, gate passed, now blocked on a human ask. */
async function askBlocked(base: string, runId: string) {
  const runDir = seedRun(base, runId, [goal('g', { humanGate: { prompt: 'ship?' } })], 'bot');
  const driver = botDriver(base);
  const cards: string[] = [];
  driver.deps.postBlockedCard = async (_binding, info) => { cards.push(buildV3BlockedCardForInfo(runId, info)); };
  await driveV3Run(runId, driver.deps);
  resolveV3GateClick(base, runId, { waitId: 'g#001-gate', selected: 'approve', by: INITIATOR });
  await driveV3Run(runId, driver.deps);
  const attemptId = driver.dispatches[0]!.attemptId;
  appendEvent(join(runDir, 'journal.ndjson'), {
    type: 'nodeBlocked', nodeId: 'g', instanceId: 'g#001', attemptId, errorClass: 'workerError', errorCode: 'ASK_HUMAN',
    ask: { question: 'which region?', options: ['sg', 'us'] },
  });
  await driveV3Run(runId, driver.deps);
  const answer = (selected: string) => handleV3BlockedAction({
    action: V3_BLOCKED_ASK_ANSWER_ACTION, runId, nodeId: 'g', attemptId, selected,
    nonce: v3BlockedCardNonce(runId, 'g', attemptId),
  }, INITIATOR, { baseDir: base, driveRun: () => {} });
  const rerun = () => handleV3BlockedAction({
    action: V3_BLOCKED_RETRY_ACTION, runId, nodeId: 'g', attemptId, nonce: v3BlockedCardNonce(runId, 'g', attemptId),
  }, INITIATOR, { baseDir: base, driveRun: () => {} });
  return { runDir, driver, cards, attemptId, answer, rerun };
}

describe('round 3 — a grant card grants only the tier and exhaustion it was posted for', () => {
  it('a pair card cannot be reused for the run-wide tier; a later run-wide exhaustion has its own card', async () => {
    const base = freshBase();
    const runId = 'run-tiers';
    const extra = ['b', 'c', 'n1', 'n2', 'n3', 'n4', 'n5', 'n6', 'n7'];
    const { runDir, block: pairA } = exhaustPair(base, runId, extra);
    let rev = 2;
    for (const id of extra.slice(2)) {
      expect(edit(base, runId, [{ op: 'rerunNode', nodeId: id }], rev)).toMatchObject({ kind: 'applied' });
      rev++;
    }
    const refuse = (nodeId: string) => {
      const out = edit(base, runId, [{ op: 'rerunNode', nodeId }], rev, mainBot);
      if (out.kind !== 'invalid' || !out.rerunBudget) throw new Error(JSON.stringify(out));
      return out.rerunBudget;
    };
    const click = (block: V3RerunBudgetBlock) => handleV3RevisionAction({
      action: V3_REVISION_RERUN_GRANT_ACTION, runId, nodeId: block.nodeId, tier: block.tier, epoch: block.epoch,
      nonce: v3RerunGrantCardNonce(runId, block.nodeId, block.tier, block.epoch),
    }, INITIATOR, { baseDir: base, driveRun: () => {} });
    // a's own budget and the run-wide budget are both spent.
    expect(pairA.tier).toBe('pair');
    expect(await click(pairA)).toMatchObject({ header: expect.anything() });
    const runA = refuse('a');
    expect(runA.tier).toBe('run');
    // The pair card does not unlock the run-wide tier, even at the same epoch.
    const before = journal(runDir).length;
    expect(await click(pairA)).toMatchObject({ toast: expect.anything() });
    expect(journal(runDir)).toHaveLength(before);
    // b's run-wide card lifts it; b re-runs and spends the run-wide budget again.
    expect(await click(refuse('b'))).toMatchObject({ header: expect.anything() });
    expect(edit(base, runId, [{ op: 'rerunNode', nodeId: 'b' }], rev)).toMatchObject({ kind: 'applied' });
    rev++;
    // That second run-wide exhaustion gets its own card, which grants.
    const runC = refuse('c');
    expect(runC).toMatchObject({ tier: 'run' });
    expect(runC.epoch).not.toBe(runA.epoch);
    expect(await click(runC)).toMatchObject({ header: expect.anything() });
    expect(edit(base, runId, [{ op: 'rerunNode', nodeId: 'c' }], rev)).toMatchObject({ kind: 'applied' });
  });
});

describe('round 3 — a voided ask card offers the re-run (ADV-D)', () => {
  it('re-posted cards render voided; the button re-runs the node through a fresh gate', async () => {
    const base = freshBase();
    const { runDir, driver, cards, answer, rerun } = await askBlocked(base, 'run-adv-d');
    expect(cardActions(JSON.parse(cards.at(-1)!))).toContain(V3_BLOCKED_ASK_ANSWER_ACTION);
    expect(edit(base, 'run-adv-d', [{ op: 'updateNode', nodeId: 'g', set: { goal: 'ship to the new region list' } }], 1))
      .toMatchObject({ kind: 'applied' });
    const before = cards.length;
    await driveV3Run('run-adv-d', driver.deps);
    expect(cards.length).toBeGreaterThan(before);
    // No card announced after the edit can take an answer any more.
    for (const card of cards.slice(before)) expect(cardActions(JSON.parse(card))).toEqual([V3_BLOCKED_RETRY_ACTION]);
    expect(blockedInfoFor(journal(runDir), 'g').askVoided).toBe(true);
    // Answering is refused into the same voided state.
    expect(cardActions(await answer('sg'))).toEqual([V3_BLOCKED_RETRY_ACTION]);
    // Nothing starts by itself …
    for (let i = 0; i < 3; i++) await driveV3Run('run-adv-d', driver.deps);
    expect(driver.gates).toEqual(['g#001-gate']);
    // … until the re-run is clicked: then the new definition goes through its gate.
    expect(await rerun()).toMatchObject({ header: expect.anything() });
    await driveV3Run('run-adv-d', driver.deps);
    expect(driver.gates).toEqual(['g#001-gate', 'g#002-gate']);
  });
});

describe('round 3 — answering while a proposal touches the node (ADV-C)', () => {
  it('is refused and the card stays answerable; after a rejection the answer goes through', async () => {
    const base = freshBase();
    const { runDir, answer } = await askBlocked(base, 'run-adv-c-reject');
    expect(edit(base, 'run-adv-c-reject', [{ op: 'updateNode', nodeId: 'g', set: { goal: 'changed' } }], 1, other))
      .toMatchObject({ kind: 'proposed' });
    const before = journal(runDir).length;
    expect(await answer('sg')).toMatchObject({ toast: expect.anything() });
    expect(journal(runDir)).toHaveLength(before);
    expect(decideV3RevisionProposal({ baseDir: base, runId: 'run-adv-c-reject', revision: 2, decision: 'reject', by: INITIATOR }))
      .toMatchObject({ kind: 'rejected' });
    expect(await answer('sg')).toMatchObject({ header: expect.anything() });
    expect(journal(runDir).filter((event) => event.type === 'nodeRetryRequested')).toEqual([
      expect.objectContaining({ answer: expect.objectContaining({ by: INITIATOR }) }),
    ]);
  });

  it('after an approval the ask is voided and the node re-runs only through its gate', async () => {
    const base = freshBase();
    const { runDir, driver, answer, rerun } = await askBlocked(base, 'run-adv-c-approve');
    expect(edit(base, 'run-adv-c-approve', [{ op: 'updateNode', nodeId: 'g', set: { goal: 'changed' } }], 1, other))
      .toMatchObject({ kind: 'proposed' });
    expect(await answer('sg')).toMatchObject({ toast: expect.anything() });
    expect(decideV3RevisionProposal({ baseDir: base, runId: 'run-adv-c-approve', revision: 2, decision: 'approve', by: INITIATOR }))
      .toMatchObject({ kind: 'approved' });
    expect(cardActions(await answer('sg'))).toEqual([V3_BLOCKED_RETRY_ACTION]);
    expect(journal(runDir).some((event) => event.type === 'nodeRetryRequested')).toBe(false);
    await rerun();
    await driveV3Run('run-adv-c-approve', driver.deps);
    expect(driver.gates.at(-1)).toBe('g#002-gate');
  });
});

describe('round 3 — follow-up reconciliation never acts on an outdated flow', () => {
  /** Node y (not started, depends on blocked a) was reassigned; that event was lost. */
  async function lostPendingReassign(base: string, runId: string, more: unknown[] = []) {
    const runDir = seedRun(base, runId, [goal('a'), goal('y', { depends: ['a'] }), ...more], 'bot');
    const driver = botDriver(base);
    await driveV3Run(runId, driver.deps);
    blockAttempt(runDir, 'a', 'a#001', driver.dispatches.find((req) => req.nodeId === 'a')!.attemptId);
    return { runDir, driver };
  }
  const dropLostFollowUps = (runDir: string) => {
    const journalPath = join(runDir, 'journal.ndjson');
    const lines = readFileSync(journalPath, 'utf-8').trimEnd().split('\n');
    writeFileSync(journalPath, `${lines.filter((line) => !/"type":"nodeReassigned"/.test(line)).join('\n')}\n`);
  };

  it('a newer revision landing between the check and the locked write is not overridden', async () => {
    const base = freshBase();
    const { runDir } = await lostPendingReassign(base, 'run-race-follow');
    expect(edit(base, 'run-race-follow', [{ op: 'reassign', nodeId: 'y', bot: 'cli_other' }], 1)).toMatchObject({ kind: 'applied' });
    dropLostFollowUps(runDir);
    // The reconciler read the flow at revision 2 (y still in it) …
    const scope = { revision: 2, liveNodeIds: new Set(['a', 'y']) };
    expect(missingV3RevisionFollowUps(journal(runDir), scope.liveNodeIds)).toHaveLength(1);
    // … then, before it took the lock, revision 3 removed y.
    expect(edit(base, 'run-race-follow', [{ op: 'removeNode', nodeId: 'y' }], 2)).toMatchObject({ kind: 'applied' });
    expect(appendMissingV3RevisionFollowUps(join(runDir, 'journal.ndjson'), scope)).toEqual({ kind: 'stale' });
    expect(journal(runDir).some((event) => event.type === 'nodeReassigned')).toBe(false);
  });

  it('cold attach with a pending proposal finishes only the follow-ups of nodes still in the flow', async () => {
    const base = freshBase();
    const { runDir } = await lostPendingReassign(base, 'run-cold-combo', [goal('x', { depends: ['a'] })]);
    expect(edit(base, 'run-cold-combo', [
      { op: 'reassign', nodeId: 'y', bot: 'cli_other' },
      { op: 'reassign', nodeId: 'x', bot: 'cli_other' },
    ], 1)).toMatchObject({ kind: 'applied' });
    dropLostFollowUps(runDir);
    expect(edit(base, 'run-cold-combo', [{ op: 'removeNode', nodeId: 'y' }], 2)).toMatchObject({ kind: 'applied' });
    expect(edit(base, 'run-cold-combo', [{ op: 'updateNode', nodeId: 'x', set: { goal: 'member idea' } }], 3, other))
      .toMatchObject({ kind: 'proposed' });
    const recs = reconcileV3RevisionProposals(base, BINDING.larkAppId);
    expect(recs).toEqual([expect.objectContaining({ runId: 'run-cold-combo', resume: true, repost: [expect.objectContaining({ revision: 4 })] })]);
    expect(journal(runDir).filter((event) => event.type === 'nodeReassigned').map((event) => event.nodeId)).toEqual(['x']);
  });

  it('cold attach still reconciles proposals when the effective flow cannot be loaded, and says so', async () => {
    const base = freshBase();
    // Two runs owe a lost reassignment and have a broken applied revision;
    // one of them also has a pending proposal.
    const broken = async (runId: string, withProposal: boolean) => {
      const { runDir } = await lostPendingReassign(base, runId);
      expect(edit(base, runId, [{ op: 'reassign', nodeId: 'y', bot: 'cli_other' }], 1)).toMatchObject({ kind: 'applied' });
      dropLostFollowUps(runDir);
      if (withProposal) {
        expect(edit(base, runId, [{ op: 'updateNode', nodeId: 'y', set: { goal: 'member idea' } }], 2, other))
          .toMatchObject({ kind: 'proposed' });
      }
      // The applied revision's file no longer matches its digest.
      writeFileSync(v3RevisionFilePaths(runDir, 2).dag, readFileSync(join(runDir, 'dag.json')));
      return runDir;
    };
    const withProposal = await broken('run-cold-broken', true);
    const followUpsOnly = await broken('run-cold-broken-2', false);
    const reposted: number[] = [];
    const errors: Array<{ runId: string; message: string }> = [];
    await runner(base, fakeWorkers().runNode, {
      postRevisionCard: async (_binding, view) => { reposted.push(view.revision); },
      onError: (runId, err) => { errors.push({ runId, message: err instanceof Error ? err.message : String(err) }); },
    }).coldAttach(BINDING.larkAppId);
    expect(reposted).toEqual([3]);
    for (const runId of ['run-cold-broken', 'run-cold-broken-2']) {
      expect(errors.some((error) => error.runId === runId && /digest mismatch/.test(error.message))).toBe(true);
    }
    for (const runDir of [withProposal, followUpsOnly]) {
      expect(journal(runDir).some((event) => event.type === 'nodeReassigned')).toBe(false);
    }
  });
});

// ─── M2 乙: the initiator's own turn applies directly, except external actions ─

describe('M2 乙 — which turn needs the confirmation card', () => {
  const HOST = {
    id: 'send', type: 'host', executor: 'feishu-send', depends: [], inputs: [],
    input: { larkAppId: { $ref: 'context.larkAppId' }, chatId: { $ref: 'context.chatId' }, content: 'hi' },
    humanGate: { prompt: 'send?', options: ['approve', 'reject'], approveOptions: ['approve'] },
  };
  const newBotEdit = (base: string, runId: string, caller: V3RunEditCaller, revision = 1) => applyV3RunEdit({
    baseDir: base, runId, baseRevision: revision, caller,
    patch: [{ op: 'reassign', nodeId: 'a', bot: 'cli_fresh' }],
    resolveNewBotSnapshot: (selector) => ({ larkAppId: selector, cliId: 'codex', workingDir: '/fresh' }) as never,
  });
  /** Each confirmation-list change except the external action, on its own run. */
  const cases: Array<[string, unknown[], (base: string, runId: string, caller: V3RunEditCaller) => ReturnType<typeof edit>, string]> = [
    ['a bot outside the approved set', [goal('a')], (base, runId, caller) => newBotEdit(base, runId, caller), 'newBot'],
    ['removing a gate', [goal('a', { humanGate: { prompt: 'ok?' } })],
      (base, runId, caller) => edit(base, runId, [{ op: 'updateNode', nodeId: 'a', set: { humanGate: null } }], 1, caller), 'gateRelaxed'],
    ['a longer timeout', [goal('a', { timeoutSec: 600 })],
      (base, runId, caller) => edit(base, runId, [{ op: 'updateNode', nodeId: 'a', set: { timeoutSec: 3600 } }], 1, caller), 'budgetExpanded'],
    ['more than twice the approved nodes', [goal('a')],
      (base, runId, caller) => edit(base, runId, [
        { op: 'addNode', node: goal('b') }, { op: 'addNode', node: goal('c') },
      ], 1, caller), 'budgetExpanded'],
  ];

  it.each(cases)('the initiator\'s own turn: %s takes effect directly', (_label, nodes, apply) => {
    const base = freshBase();
    seedRun(base, 'run-direct', nodes);
    expect(apply(base, 'run-direct', initiator)).toMatchObject({ kind: 'applied' });
  });

  it.each(cases)('a turn the main bot opened for the run\'s events: %s still needs the card', (_label, nodes, apply, reason) => {
    const base = freshBase();
    seedRun(base, 'run-event-card', nodes);
    expect(apply(base, 'run-event-card', mainBot)).toMatchObject({ kind: 'proposed', reasons: [reason] });
  });

  it.each(cases)('anyone else\'s turn: %s is a proposal', (_label, nodes, apply, reason) => {
    const base = freshBase();
    seedRun(base, 'run-other-card', nodes);
    expect(apply(base, 'run-other-card', other)).toMatchObject({ kind: 'proposed', reasons: ['callerNotInitiator', reason] });
  });

  it('a bot the initiator brought in directly joins the approved scope and runs the node', async () => {
    const base = freshBase();
    const runDir = seedRun(base, 'run-direct-bot', [goal('a')]);
    expect(newBotEdit(base, 'run-direct-bot', initiator)).toMatchObject({ kind: 'applied', revision: 2 });
    expect(existsSync(v3RevisionFilePaths(runDir, 2).bots)).toBe(true);
    // Already approved now: the main bot's own turn may use it without a card.
    expect(edit(base, 'run-direct-bot', [{ op: 'addNode', node: goal('b', { bot: 'cli_fresh' }) }], 2, mainBot))
      .toMatchObject({ kind: 'applied' });
    const seen: string[] = [];
    await runner(base, async (req) => { seen.push(req.botSnapshot.larkAppId); return fakeWorkers().runNode(req); }).drive('run-direct-bot');
    expect(seen).toEqual(['cli_fresh', 'cli_fresh']);
  });

  it('an external action still needs the card, even in the initiator\'s own turn — and only it is listed', () => {
    const base = freshBase();
    seedRun(base, 'run-host', [goal('a')]);
    expect(edit(base, 'run-host', [{ op: 'addNode', node: HOST }], 1))
      .toMatchObject({ kind: 'proposed', reasons: ['hostNode'] });
    expect(projectV3RunStatus(base, 'run-host').pendingProposal?.reasons).toEqual(['hostNode']);
    // Together with a change that would otherwise apply directly.
    const both = applyV3RunEdit({
      baseDir: base, runId: 'run-host', baseRevision: 1, caller: initiator,
      patch: [{ op: 'addNode', node: HOST }, { op: 'reassign', nodeId: 'a', bot: 'cli_fresh' }],
      resolveNewBotSnapshot: (selector) => ({ larkAppId: selector, cliId: 'codex', workingDir: '/fresh' }) as never,
    });
    expect(both).toMatchObject({ kind: 'proposed', reasons: ['hostNode'] });
  });

  it('changing an existing external action in the initiator\'s own turn needs the card', () => {
    const base = freshBase();
    seedRun(base, 'run-host-change', [goal('a'), HOST]);
    expect(edit(base, 'run-host-change', [{ op: 'updateNode', nodeId: 'send', set: { input: { ...HOST.input, content: 'bye' } } }], 1))
      .toMatchObject({ kind: 'proposed', reasons: ['hostNode'] });
  });

  describe('redoing a finished node whose budget is spent', () => {
    function spentRun(base: string, runId: string, extra: unknown[] = []) {
      const runDir = seedRun(base, runId, [goal('a'), ...extra]);
      const journalPath = join(runDir, 'journal.ndjson');
      const finish = (instanceId: string) => {
        const attemptId = `${instanceId}/attempts/001`;
        appendEvent(journalPath, { type: 'nodeDispatched', nodeId: 'a', instanceId, attemptId });
        appendEvent(journalPath, { type: 'nodeSucceeded', nodeId: 'a', instanceId, attemptId, manifestPath: join(runDir, 'm.json') });
      };
      finish('a#001');
      expect(edit(base, runId, [{ op: 'rerunNode', nodeId: 'a' }], 1)).toMatchObject({ kind: 'applied', revision: 2 });
      finish('a#002');
      return runDir;
    }

    it('the initiator\'s own turn adds one more and applies — recorded as theirs, in the revision itself, with no grant card', () => {
      const base = freshBase();
      const runDir = spentRun(base, 'run-lift');
      const out = edit(base, 'run-lift', [{ op: 'rerunNode', nodeId: 'a' }], 2);
      expect(out).toMatchObject({ kind: 'applied', revision: 3 });
      expect(out).not.toHaveProperty('rerunBudget');
      const events = journal(runDir);
      expect(events.some((event) => event.type === 'revisitBudgetGranted')).toBe(false);
      expect(events.at(-1)).toMatchObject({
        type: 'dagRevised', revision: 3, by: INITIATOR, effects: { rerun: ['a'], budgetGrants: [{ nodeId: 'a', tier: 'pair' }] },
      });
      // Exactly the one revisit it used: spent again afterwards.
      expect(revisitBudgetStatus(events, 'a', 'a')).toMatchObject({ ok: false, tier: 'pair' });
    });

    it('the main bot\'s own turn is refused with the grant card instead', () => {
      const base = freshBase();
      const runDir = spentRun(base, 'run-lift-event');
      const before = journal(runDir).length;
      expect(edit(base, 'run-lift-event', [{ op: 'rerunNode', nodeId: 'a' }], 2, mainBot))
        .toMatchObject({ kind: 'invalid', rerunBudget: { nodeId: 'a', tier: 'pair' } });
      expect(journal(runDir)).toHaveLength(before);
    });

    it('a change of the initiator that waits for the card does not lift the budget', () => {
      const base = freshBase();
      const runDir = spentRun(base, 'run-lift-host');
      const before = journal(runDir).length;
      expect(edit(base, 'run-lift-host', [{ op: 'rerunNode', nodeId: 'a' }, { op: 'addNode', node: HOST }], 2))
        .toMatchObject({ kind: 'invalid', rerunBudget: { nodeId: 'a', tier: 'pair' } });
      expect(journal(runDir)).toHaveLength(before);
    });
  });
});

describe('rerun budget across one patch — every re-run of the patch is counted', () => {
  const RUN_LIMIT = DEFAULT_REVISIT_BUDGET_PER_RUN;
  /** Independent count over the journal's event shapes: run-wide revisits
   *  spent, and how many are allowed. */
  const runBudget = (events: StoredEvent[]) => {
    let used = 0;
    let granted = 0;
    for (const event of events) {
      if (event.type === 'nodeRevisitRequested') used++;
      if (event.type === 'revisitBudgetGranted' && event.sourceNodeId === undefined && event.toNodeId === undefined) granted++;
      if (event.type === 'dagRevised') {
        used += event.effects?.rerun?.length ?? 0;
        granted += (event.effects?.budgetGrants ?? []).filter((grant) => grant.tier === 'run').length;
      }
    }
    return { used, limit: RUN_LIMIT + granted };
  };
  const ids = (count: number, from = 0) => Array.from({ length: count }, (_, i) => `n${from + i}`);
  const reruns = (nodeIds: string[]) => nodeIds.map((nodeId) => ({ op: 'rerunNode', nodeId }));
  function doneRun(base: string, runId: string, nodeIds: string[]) {
    const runDir = seedRun(base, runId, nodeIds.map((id) => goal(id)));
    const finished = new Map<string, number>();
    const finish = (nodeId: string) => {
      const n = (finished.get(nodeId) ?? 0) + 1;
      finished.set(nodeId, n);
      const instanceId = `${nodeId}#${String(n).padStart(3, '0')}`;
      const attemptId = `${instanceId}/attempts/001`;
      appendEvent(join(runDir, 'journal.ndjson'), { type: 'nodeDispatched', nodeId, instanceId, attemptId });
      appendEvent(join(runDir, 'journal.ndjson'), { type: 'nodeSucceeded', nodeId, instanceId, attemptId, manifestPath: join(runDir, 'm.json') });
    };
    for (const id of nodeIds) finish(id);
    return { runDir, finish };
  }

  it('the main bot\'s own turn cannot re-run more nodes in one patch than the run-wide budget allows', () => {
    const base = freshBase();
    const { runDir } = doneRun(base, 'run-many', ids(RUN_LIMIT + 1));
    const before = journal(runDir).length;
    expect(edit(base, 'run-many', reruns(ids(RUN_LIMIT + 1)), 1, mainBot))
      .toMatchObject({ kind: 'invalid', rerunBudget: { tier: 'run' } });
    expect(journal(runDir)).toHaveLength(before);
    expect(edit(base, 'run-many', reruns(ids(RUN_LIMIT)), 1, mainBot)).toMatchObject({ kind: 'applied' });
    expect(runBudget(journal(runDir))).toEqual({ used: RUN_LIMIT, limit: RUN_LIMIT });
  });

  it('the initiator\'s own turn lifts one revisit per re-run it needs; a grant card click then unlocks exactly one more', async () => {
    const base = freshBase();
    const { runDir } = doneRun(base, 'run-lift-many', ids(RUN_LIMIT + 4));
    expect(edit(base, 'run-lift-many', reruns(ids(RUN_LIMIT)), 1)).toMatchObject({ kind: 'applied', revision: 2 });
    expect(edit(base, 'run-lift-many', reruns(ids(3, RUN_LIMIT)), 2)).toMatchObject({ kind: 'applied', revision: 3 });
    expect(runBudget(journal(runDir))).toEqual({ used: RUN_LIMIT + 3, limit: RUN_LIMIT + 3 });
    // The main bot's next re-run gets the card; one click is one more re-run.
    const last = `n${RUN_LIMIT + 3}`;
    const refused = edit(base, 'run-lift-many', reruns([last]), 3, mainBot);
    expect(refused).toMatchObject({ kind: 'invalid', rerunBudget: { nodeId: last, tier: 'run' } });
    const block = (refused as { rerunBudget: V3RerunBudgetBlock }).rerunBudget;
    expect(await postV3RerunGrantCardOnce({ baseDir: base, runId: 'run-lift-many', block, post: async () => 'om_grant' })).toBe('posted');
    expect(grantV3RerunBudget({ baseDir: base, runId: 'run-lift-many', nodeId: last, tier: block.tier, epoch: block.epoch, by: INITIATOR }))
      .toMatchObject({ kind: 'granted' });
    expect(edit(base, 'run-lift-many', reruns([last]), 3, mainBot)).toMatchObject({ kind: 'applied', revision: 4 });
    expect(runBudget(journal(runDir))).toEqual({ used: RUN_LIMIT + 4, limit: RUN_LIMIT + 4 });
  });

  it('one node named twice in a patch is one re-run, lifted once', () => {
    const base = freshBase();
    const { runDir, finish } = doneRun(base, 'run-twice', ['a']);
    expect(edit(base, 'run-twice', reruns(['a']), 1)).toMatchObject({ kind: 'applied', revision: 2 });
    finish('a');
    expect(edit(base, 'run-twice', reruns(['a', 'a']), 2)).toMatchObject({ kind: 'applied', revision: 3, changes: { rerun: ['a'] } });
    expect(journal(runDir).at(-1)).toMatchObject({
      type: 'dagRevised', effects: { rerun: ['a'], budgetGrants: [{ nodeId: 'a', tier: 'pair' }] },
    });
  });

  it('a node whose own and run-wide budgets are both spent gets both lifted, so neither is overspent', () => {
    const base = freshBase();
    const others = ids(RUN_LIMIT - 1);
    const { runDir, finish } = doneRun(base, 'run-both', ['a', ...others]);
    expect(edit(base, 'run-both', reruns(['a']), 1)).toMatchObject({ kind: 'applied', revision: 2 });
    expect(edit(base, 'run-both', reruns(others), 2)).toMatchObject({ kind: 'applied', revision: 3 });
    finish('a');
    expect(revisitBudgetStatus(journal(runDir), 'a', 'a')).toMatchObject({ ok: false, tier: 'pair' });
    expect(edit(base, 'run-both', reruns(['a']), 3)).toMatchObject({ kind: 'applied', revision: 4 });
    const events = journal(runDir);
    expect((events.at(-1) as Extract<StoredEvent, { type: 'dagRevised' }>).effects?.budgetGrants)
      .toEqual(expect.arrayContaining([{ nodeId: 'a', tier: 'pair' }, { nodeId: 'a', tier: 'run' }]));
    expect(runBudget(events)).toEqual({ used: RUN_LIMIT + 1, limit: RUN_LIMIT + 1 });
  });

  it('a grant card posted before the initiator\'s own lift expires once that lift took care of it — never a double grant', async () => {
    const base = freshBase();
    const { runDir, finish } = doneRun(base, 'run-old-card', ['a']);
    expect(edit(base, 'run-old-card', reruns(['a']), 1)).toMatchObject({ kind: 'applied', revision: 2 });
    finish('a');
    const refused = edit(base, 'run-old-card', reruns(['a']), 2, mainBot);
    const block = (refused as { rerunBudget: V3RerunBudgetBlock }).rerunBudget;
    expect(block).toMatchObject({ nodeId: 'a', tier: 'pair' });
    expect(await postV3RerunGrantCardOnce({ baseDir: base, runId: 'run-old-card', block, post: async () => 'om_old' })).toBe('posted');
    // The initiator re-runs it themselves before anyone taps the card.
    expect(edit(base, 'run-old-card', reruns(['a']), 2)).toMatchObject({ kind: 'applied', revision: 3 });
    expect(grantV3RerunBudget({ baseDir: base, runId: 'run-old-card', nodeId: 'a', tier: block.tier, epoch: block.epoch, by: INITIATOR }))
      .toMatchObject({ kind: 'expired' });
    expect(revisitBudgetStatus(journal(runDir), 'a', 'a')).toMatchObject({ ok: false, tier: 'pair' });
  });

  it('the lift is part of the revision line: no prefix of the edit\'s writes holds a lift without its revision', () => {
    const base = freshBase();
    const { runDir, finish } = doneRun(base, 'run-torn', ['a']);
    expect(edit(base, 'run-torn', reruns(['a']), 1)).toMatchObject({ kind: 'applied', revision: 2 });
    finish('a');
    const journalPath = join(runDir, 'journal.ndjson');
    const before = readFileSync(journalPath, 'utf-8').trimEnd().split('\n');
    expect(edit(base, 'run-torn', reruns(['a']), 2)).toMatchObject({ kind: 'applied', revision: 3 });
    const after = readFileSync(journalPath, 'utf-8').trimEnd().split('\n');
    const lifts = (events: StoredEvent[]) => events.reduce((n, event) =>
      n + (event.type === 'revisitBudgetGranted' ? 1 : 0) +
      (event.type === 'dagRevised' ? event.effects?.budgetGrants?.length ?? 0 : 0), 0);
    for (let cut = before.length; cut <= after.length; cut++) {
      writeFileSync(journalPath, `${after.slice(0, cut).join('\n')}\n`);
      const events = journal(runDir);
      const revised = events.some((event) => event.type === 'dagRevised' && event.revision === 3);
      expect({ cut, lifted: lifts(events) > 0 }).toEqual({ cut, lifted: revised });
    }
    // Crash before the revision landed: the main bot's own re-run still needs the card.
    writeFileSync(journalPath, `${before.join('\n')}\n`);
    expect(edit(base, 'run-torn', reruns(['a']), 2, mainBot)).toMatchObject({ kind: 'invalid', rerunBudget: { nodeId: 'a', tier: 'pair' } });
  });
});

describe('a direct revision while another change waits for confirmation', () => {
  const effectiveGoals = (runDir: string) => Object.fromEntries(
    loadEffectiveV3Dag(runDir, loadAuthorizedV3Run(runDir).dag, journal(runDir)).dag.nodes.map((node) => [node.id, node.goal]),
  );
  /** A member's proposal for `a`, its card posted as `om_card_2`. */
  function memberProposal(base: string, runId: string, nodes = [goal('a'), goal('b')], patch: unknown = [
    { op: 'updateNode', nodeId: 'a', set: { goal: 'from member' } },
  ]) {
    const runDir = seedRun(base, runId, nodes);
    expect(edit(base, runId, patch, 1, other)).toMatchObject({ kind: 'proposed', revision: 2 });
    recordV3RevisionCardMessage(runDir, 2, 'om_card_2');
    return runDir;
  }

  it('one that involves other nodes keeps waiting, carried onto the new version with its card', () => {
    const base = freshBase();
    const runDir = memberProposal(base, 'run-carry');
    const direct = edit(base, 'run-carry', [{ op: 'updateNode', nodeId: 'b', set: { goal: 'from initiator' } }], 1);
    expect(direct).toMatchObject({
      kind: 'applied', revision: 3, voidedProposals: [],
      carriedProposals: [{
        fromRevision: 2, revision: 4, cardMessageIds: ['om_card_2'],
        view: { revision: 4, baseRevision: 3, reasons: ['callerNotInitiator'], changes: { changed: ['a'] }, proposedBy: OTHER },
      }],
    });
    expect(projectV3RunStatus(base, 'run-carry')).toMatchObject({
      revision: 3,
      pendingProposal: { revision: 4, baseRevision: 3, touched: ['a'], reasons: ['callerNotInitiator'], by: OTHER },
    });
    expect(readV3RevisionWait(runDir, 4)).toMatchObject({ status: 'pending', cardMessageIds: ['om_card_2'] });
    // The initiator taps the card as it was first posted: that decides the carried version.
    expect(decideV3RevisionProposal({ baseDir: base, runId: 'run-carry', revision: 2, decision: 'approve', by: INITIATOR }))
      .toMatchObject({ kind: 'approved', revision: 4 });
    expect(effectiveGoals(runDir)).toEqual({ a: 'from member', b: 'from initiator' });
    expect(projectV3RunStatus(base, 'run-carry').revision).toBe(4);
  });

  it('the old card\'s button still works through the card handler', async () => {
    const base = freshBase();
    const runDir = memberProposal(base, 'run-carry-card');
    edit(base, 'run-carry-card', [{ op: 'updateNode', nodeId: 'b', set: { goal: 'from initiator' } }], 1);
    const drives: string[] = [];
    const card = await handleV3RevisionAction(
      { action: V3_REVISION_REJECT_ACTION, runId: 'run-carry-card', revision: 2, nonce: v3RevisionCardNonce('run-carry-card', 2) },
      INITIATOR,
      { baseDir: base, driveRun: (id) => { drives.push(id); } },
    );
    expect(JSON.stringify(card)).not.toContain('toast');
    expect(readV3RevisionWait(runDir, 4)).toMatchObject({ status: 'rejected', by: INITIATOR });
    expect(effectiveGoals(runDir)).toEqual({ a: 'do a', b: 'from initiator' });
    expect(drives).toEqual(['run-carry-card']);
  });

  it('a click that decided the old card first keeps its own result; the carried version gets a card of its own', () => {
    const base = freshBase();
    const runDir = memberProposal(base, 'run-carry-race');
    // The click's wait half landed just before the edit took the journal lock.
    writeJson(v3RevisionWaitPath(runDir, 2), { ...readV3RevisionWait(runDir, 2)!, status: 'approved', by: INITIATOR });
    const direct = edit(base, 'run-carry-race', [{ op: 'updateNode', nodeId: 'b', set: { goal: 'from initiator' } }], 1);
    expect(direct).toMatchObject({ kind: 'applied', carriedProposals: [{ fromRevision: 2, revision: 4, cardMessageIds: [] }] });
    expect(readV3RevisionWait(runDir, 4)).toMatchObject({ status: 'pending' });
    expect(readV3RevisionWait(runDir, 4)).not.toHaveProperty('cardMessageIds');
  });

  it('a proposal whose new node depends on a node the direct revision changed is voided', () => {
    const base = freshBase();
    memberProposal(base, 'run-carry-dep', [goal('a'), goal('b')], [{ op: 'addNode', node: goal('x', { depends: ['b'] }) }]);
    expect(edit(base, 'run-carry-dep', [{ op: 'updateNode', nodeId: 'b', set: { goal: 'from initiator' } }], 1))
      .toMatchObject({ kind: 'applied', voidedProposals: [{ revision: 2, reason: 'stale', cause: 'overlap' }], carriedProposals: [] });
    expect(projectV3RunStatus(base, 'run-carry-dep').pendingProposal).toBeUndefined();
  });

  it('a proposal the direct revision changed the meaning of (no longer the reasons on its card) is voided', () => {
    const base = freshBase();
    const runDir = seedRun(base, 'run-carry-reasons', [goal('a'), goal('b')]);
    const fresh = (selector: string) => ({ larkAppId: selector, cliId: 'codex', workingDir: '/fresh' }) as never;
    expect(applyV3RunEdit({
      baseDir: base, runId: 'run-carry-reasons', baseRevision: 1, caller: mainBot,
      patch: [{ op: 'reassign', nodeId: 'a', bot: 'cli_fresh' }], resolveNewBotSnapshot: fresh,
    })).toMatchObject({ kind: 'proposed', revision: 2, reasons: ['newBot'] });
    // The initiator brings the same bot in directly, for another node.
    expect(applyV3RunEdit({
      baseDir: base, runId: 'run-carry-reasons', baseRevision: 1, caller: initiator,
      patch: [{ op: 'reassign', nodeId: 'b', bot: 'cli_fresh' }], resolveNewBotSnapshot: fresh,
    })).toMatchObject({ kind: 'applied', revision: 3, voidedProposals: [{ revision: 2, cause: 'meaningChanged' }], carriedProposals: [] });
    expect(readV3RevisionWait(runDir, 2)).toMatchObject({ status: 'voided' });
  });

  it('a proposal that on the new version would need another reason (node total past twice the approved) is voided', () => {
    const base = freshBase();
    // Two approved nodes: up to four take effect without a budget reason.
    memberProposal(base, 'run-carry-budget', [goal('a'), goal('b')], [{ op: 'addNode', node: goal('x') }]);
    expect(projectV3RunStatus(base, 'run-carry-budget').pendingProposal?.reasons).toEqual(['callerNotInitiator']);
    // The initiator adds two unrelated nodes directly: four in effect, the proposal would make five.
    expect(edit(base, 'run-carry-budget', [{ op: 'addNode', node: goal('y') }, { op: 'addNode', node: goal('z') }], 1))
      .toMatchObject({ kind: 'applied', revision: 3, voidedProposals: [{ revision: 2, reason: 'stale', cause: 'meaningChanged' }], carriedProposals: [] });
  });

  it('a proposal the direct revision changed (one of its two new bots is now approved) is voided', () => {
    const base = freshBase();
    seedRun(base, 'run-carry-changes', [goal('a'), goal('b'), goal('c')]);
    const fresh = (selector: string) => ({ larkAppId: selector, cliId: 'codex', workingDir: '/fresh' }) as never;
    expect(applyV3RunEdit({
      baseDir: base, runId: 'run-carry-changes', baseRevision: 1, caller: other,
      patch: [{ op: 'reassign', nodeId: 'a', bot: 'cli_fresh' }, { op: 'reassign', nodeId: 'b', bot: 'cli_fresh_2' }],
      resolveNewBotSnapshot: fresh,
    })).toMatchObject({ kind: 'proposed', revision: 2, reasons: ['callerNotInitiator', 'newBot'] });
    // Same reasons on top of the new version, but its card would no longer list cli_fresh.
    expect(applyV3RunEdit({
      baseDir: base, runId: 'run-carry-changes', baseRevision: 1, caller: initiator,
      patch: [{ op: 'reassign', nodeId: 'c', bot: 'cli_fresh' }], resolveNewBotSnapshot: fresh,
    })).toMatchObject({ kind: 'applied', revision: 3, voidedProposals: [{ revision: 2, cause: 'meaningChanged' }], carriedProposals: [] });
  });

  it('a carry that cannot be written falls back to voiding the proposal; the direct revision stands', () => {
    const base = freshBase();
    const runDir = memberProposal(base, 'run-carry-io');
    // The carried version's file cannot be created.
    mkdirSync(v3RevisionFilePaths(runDir, 4).dag, { recursive: true });
    expect(edit(base, 'run-carry-io', [{ op: 'updateNode', nodeId: 'b', set: { goal: 'from initiator' } }], 1))
      .toMatchObject({ kind: 'applied', revision: 3, voidedProposals: [{ revision: 2, reason: 'stale', cause: 'carryFailed' }], carriedProposals: [] });
    expect(effectiveGoals(runDir)).toEqual({ a: 'do a', b: 'from initiator' });
    expect(projectV3RunStatus(base, 'run-carry-io').pendingProposal).toBeUndefined();
  });

  /** Finish `nodeIds` once each (a real, empty manifest). */
  function finishAll(runDir: string, nodeIds: string[]) {
    writeJson(join(runDir, 'm.json'), { schemaVersion: 1, status: 'ok', summary: 'ok', files: [] });
    for (const nodeId of nodeIds) {
      const instanceId = `${nodeId}#001`;
      const attemptId = `${instanceId}/attempts/001`;
      appendEvent(join(runDir, 'journal.ndjson'), { type: 'nodeDispatched', nodeId, instanceId, attemptId });
      appendEvent(join(runDir, 'journal.ndjson'), { type: 'nodeSucceeded', nodeId, instanceId, attemptId, manifestPath: join(runDir, 'm.json') });
    }
  }

  it('a re-run replaces the downstream instances: a proposal building on one of them overlaps and is voided', () => {
    const base = freshBase();
    const runDir = seedRun(base, 'run-carry-cone', [goal('a'), goal('b', { depends: ['a'] }), goal('c')]);
    finishAll(runDir, ['a', 'b']);
    expect(edit(base, 'run-carry-cone', [{ op: 'addNode', node: goal('x', { depends: ['b'] }) }], 1, other))
      .toMatchObject({ kind: 'proposed', revision: 2 });
    // Re-running a replaces b's instance, which the proposal's new node reads.
    expect(edit(base, 'run-carry-cone', [{ op: 'rerunNode', nodeId: 'a' }], 1))
      .toMatchObject({ kind: 'applied', voidedProposals: [{ revision: 2, cause: 'overlap' }], carriedProposals: [] });
  });

  it('judged on the journal the direct revision left: a proposal its re-runs ran out of budget for is voided, not carried dead', () => {
    const base = freshBase();
    const others = Array.from({ length: DEFAULT_REVISIT_BUDGET_PER_RUN }, (_, i) => `o${i}`);
    const runDir = seedRun(base, 'run-carry-budget-spent', ['c', ...others].map((id) => goal(id)));
    finishAll(runDir, ['c', ...others]);
    expect(edit(base, 'run-carry-budget-spent', [{ op: 'rerunNode', nodeId: 'c' }], 1, other))
      .toMatchObject({ kind: 'proposed', revision: 2 });
    expect(edit(base, 'run-carry-budget-spent', others.map((nodeId) => ({ op: 'rerunNode', nodeId })), 1))
      .toMatchObject({ kind: 'applied', voidedProposals: [{ revision: 2, cause: 'notApplicable' }], carriedProposals: [] });
  });

  it('the main bot\'s own proposal is carried as the main bot\'s: same reasons, same provenance', () => {
    const base = freshBase();
    const runDir = seedRun(base, 'run-carry-mainbot', [goal('a'), goal('b')]);
    expect(applyV3RunEdit({
      baseDir: base, runId: 'run-carry-mainbot', baseRevision: 1, caller: mainBot,
      patch: { ops: [{ op: 'reassign', nodeId: 'a', bot: 'cli_fresh' }], note: 'a keeps timing out on cli_worker' },
      resolveNewBotSnapshot: (selector) => ({ larkAppId: selector, cliId: 'codex', workingDir: '/fresh' }) as never,
    })).toMatchObject({ kind: 'proposed', revision: 2, reasons: ['newBot'] });
    expect(edit(base, 'run-carry-mainbot', [{ op: 'updateNode', nodeId: 'b', set: { goal: 'from initiator' } }], 1))
      .toMatchObject({ kind: 'applied', revision: 3, carriedProposals: [{ fromRevision: 2, revision: 4, view: { reasons: ['newBot'] } }] });
    expect(journal(runDir).find((event) => event.type === 'dagRevisionProposed' && event.revision === 4)).toMatchObject({
      by: 'main_bot', reasons: ['newBot'], auto: { reason: 'a keeps timing out on cli_worker' }, carriedFrom: 2,
    });
    expect(decideV3RevisionProposal({ baseDir: base, runId: 'run-carry-mainbot', revision: 2, decision: 'approve', by: INITIATOR }))
      .toMatchObject({ kind: 'approved', revision: 4 });
  });

  it('a carried version whose wait cannot be written is voided, and the old card freezes as void', () => {
    const base = freshBase();
    const runDir = memberProposal(base, 'run-carry-nowait');
    // Its wait file cannot be created: nobody could ever decide it.
    mkdirSync(v3RevisionWaitPath(runDir, 4), { recursive: true });
    expect(edit(base, 'run-carry-nowait', [{ op: 'updateNode', nodeId: 'b', set: { goal: 'from initiator' } }], 1)).toMatchObject({
      kind: 'applied', revision: 3, carriedProposals: [],
      voidedProposals: [{ revision: 2, cause: 'carryFailed', cardMessageIds: ['om_card_2'] }],
    });
    expect(projectV3RunStatus(base, 'run-carry-nowait').pendingProposal).toBeUndefined();
    expect(readV3RevisionWait(runDir, 2)).toMatchObject({ status: 'voided' });
    expect(readV3RevisionWait(runDir, 2)).not.toHaveProperty('carriedTo');
    expect(decideV3RevisionProposal({ baseDir: base, runId: 'run-carry-nowait', revision: 2, decision: 'approve', by: INITIATOR }))
      .toMatchObject({ kind: 'already-decided', status: 'voided' });
    expect(effectiveGoals(runDir)).toEqual({ a: 'do a', b: 'from initiator' });
  });

  it('the carry is one journal line: no crash point loses the proposal, and cold attach finishes the move', async () => {
    const base = freshBase();
    const runDir = memberProposal(base, 'run-carry-crash');
    const journalPath = join(runDir, 'journal.ndjson');
    const pendingWait = readV3RevisionWait(runDir, 2)!;
    const before = readFileSync(journalPath, 'utf-8').trimEnd().split('\n');
    edit(base, 'run-carry-crash', [{ op: 'updateNode', nodeId: 'b', set: { goal: 'from initiator' } }], 1);
    const after = readFileSync(journalPath, 'utf-8').trimEnd().split('\n');
    // Wherever the edit could have died, a proposal closed as superseded
    // always has the pending successor that superseded it.
    for (let cut = before.length; cut <= after.length; cut++) {
      writeFileSync(journalPath, `${after.slice(0, cut).join('\n')}\n`);
      const history = foldV3Revisions(journal(runDir));
      const superseded = history.records.filter((record) => record.rejected?.reason === 'superseded');
      for (const record of superseded) {
        expect({ cut, successor: history.records.some((next) => next.carriedFrom === record.revision && next.state === 'pending') })
          .toEqual({ cut, successor: true });
      }
    }
    // Died right after the carry line, before either wait moved.
    writeFileSync(journalPath, `${after.join('\n')}\n`);
    rmSync(v3RevisionWaitPath(runDir, 4));
    writeJson(v3RevisionWaitPath(runDir, 2), pendingWait);
    const moved: number[] = [];
    const reposted: number[] = [];
    const frozen: number[] = [];
    await runner(base, fakeWorkers().runNode, {
      moveRevisionCards: async (_binding, _runId, carried) => { moved.push(...carried.map((item) => item.revision)); },
      postRevisionCard: async (_binding, view) => { reposted.push(view.revision); },
      freezeRevisionCards: async (_binding, _runId, voided) => { frozen.push(...voided.map((item) => item.revision)); },
    }).coldAttach(BINDING.larkAppId);
    expect({ moved, reposted, frozen }).toEqual({ moved: [4], reposted: [], frozen: [] });
    expect(projectV3RunStatus(base, 'run-carry-crash').pendingProposal).toMatchObject({ revision: 4, baseRevision: 3, by: OTHER });
    expect(readV3RevisionWait(runDir, 2)).toMatchObject({ status: 'voided', carriedTo: 4 });
    expect(readV3RevisionWait(runDir, 4)).toMatchObject({ status: 'pending', cardMessageIds: ['om_card_2'] });
    // The old card now decides the carried version.
    expect(decideV3RevisionProposal({ baseDir: base, runId: 'run-carry-crash', revision: 2, decision: 'approve', by: INITIATOR }))
      .toMatchObject({ kind: 'approved', revision: 4 });
    expect(effectiveGoals(runDir)).toEqual({ a: 'from member', b: 'from initiator' });
  });

  it('a crash after the new wait was written but before the old one moved: cold attach finishes the move', () => {
    const base = freshBase();
    const runDir = memberProposal(base, 'run-carry-crash2');
    const pendingWait = readV3RevisionWait(runDir, 2)!;
    edit(base, 'run-carry-crash2', [{ op: 'updateNode', nodeId: 'b', set: { goal: 'from initiator' } }], 1);
    const { cardMessageIds: _taken, ...unmovedWait } = readV3RevisionWait(runDir, 4)!;
    writeJson(v3RevisionWaitPath(runDir, 4), unmovedWait);
    writeJson(v3RevisionWaitPath(runDir, 2), pendingWait);
    expect(reconcileV3RevisionProposals(base, BINDING.larkAppId)).toEqual([expect.objectContaining({
      runId: 'run-carry-crash2', repost: [], voided: [], moved: [expect.objectContaining({ fromRevision: 2, revision: 4, cardMessageIds: ['om_card_2'] })],
    })]);
    expect(readV3RevisionWait(runDir, 2)).toMatchObject({ status: 'voided', carriedTo: 4 });
  });
});
