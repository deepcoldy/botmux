/**
 * `nodeExecutor: "bot"` at the run-envelope / daemon-driver boundary:
 * the field is frozen in run.json, absent means today's ephemeral execution,
 * a bot-mode run fails closed without an injected transport, cold attach
 * resumes (never kills) open bot attempts, and the gate runner re-drives at
 * the engine deadline the runtime reports.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  artifactRef,
  loadAuthorizedV3Run,
  makeAdHocRunEnvelope,
  makeManualCliRunEnvelope,
  makeSavedDefinitionRunEnvelope,
  publishRunEnvelopeOnce,
  serializeRunEnvelope,
  validateRunEnvelope,
  RunEnvelopeValidationError,
} from '../src/workflows/v3/run-envelope.js';
import {
  createV3GateRunner,
  driveV3Run,
  reconcileV3PendingGates,
  type V3BlockedInfo,
  type V3DaemonRunDeps,
} from '../src/workflows/v3/daemon-run.js';
import { readJournal } from '../src/workflows/v3/journal.js';
import { openV3ExternalAttempts } from '../src/workflows/v3/external-attempt-ledger.js';
import type {
  V3ExternalDispatchRequest,
  V3ExternalNodeExecutor,
} from '../src/workflows/v3/external-executor.js';
import type { RunNode } from '../src/workflows/v3/contract.js';
import {
  reassignNode,
  recordExternalAccepted,
  reportExternalBlocked,
} from '../src/workflows/v3/external-control.js';
import { loadDag } from '../src/workflows/v3/dag-loader.js';

const BINDING = { larkAppId: 'cli_owner', chatId: 'oc_chat', rootMessageId: 'om_root' };
const CREATED_AT = '2026-11-01T08:00:00.000Z';
const AUTHORIZED_AT = '2026-11-01T08:01:00.000Z';

const bases: string[] = [];
afterEach(() => {
  for (const base of bases.splice(0)) rmSync(base, { recursive: true, force: true });
});

function freshBase(): string {
  const base = mkdtempSync(join(tmpdir(), 'v3-ext-daemon-'));
  bases.push(base);
  return base;
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

const WORK_NODE = { id: 'work', type: 'goal', goal: 'do the work', bot: 'cli_worker', depends: [], inputs: [] };

function seedAdHocArtifacts(runDir: string, runId: string, nodes: unknown[] = [WORK_NODE]) {
  mkdirSync(runDir, { recursive: true });
  writeJson(join(runDir, 'dag.json'), { runId, nodes });
  writeJson(join(runDir, 'spec.json'), {
    schemaVersion: 1,
    runId,
    title: 'external',
    requirement: 'do the work',
    nodes: [{
      sketchId: 'work', goal: 'do the work', input_needs: [], expected_outputs: ['out'],
      acceptance: 'done', risk_gate: false, unknowns: [],
    }],
  });
  writeJson(join(runDir, 'bots.snapshot.json'), {
    cli_worker: { larkAppId: 'cli_worker', cliId: 'claude-code', workingDir: '/frozen/work' },
  });
  return {
    dag: artifactRef(runDir, 'dag.json'),
    spec: artifactRef(runDir, 'spec.json'),
    botSnapshots: artifactRef(runDir, 'bots.snapshot.json'),
  };
}

function seedAdHocRun(base: string, runId: string, nodeExecutor?: 'bot', nodes?: unknown[]): string {
  const runDir = join(base, runId);
  publishRunEnvelopeOnce(runDir, makeAdHocRunEnvelope({
    runId,
    createdAt: CREATED_AT,
    authorizedAt: AUTHORIZED_AT,
    chatBinding: BINDING,
    artifacts: seedAdHocArtifacts(runDir, runId, nodes),
    ...(nodeExecutor ? { nodeExecutor } : {}),
  }));
  return runDir;
}

class RecordingExecutor implements V3ExternalNodeExecutor {
  readonly dispatches: V3ExternalDispatchRequest[] = [];
  async dispatch(req: V3ExternalDispatchRequest) {
    this.dispatches.push(req);
    return { kind: 'sent' as const, handoffMessageId: `om_${req.attemptId}` };
  }
  async probeAcceptance() {
    return { status: 'notAccepted' as const };
  }
  async stop() {}
}

function driverDeps(base: string, overrides: Partial<V3DaemonRunDeps> = {}) {
  const runNode = vi.fn<RunNode>(async () => {
    throw new Error('unexpected ephemeral worker');
  });
  const deps: V3DaemonRunDeps = {
    baseDir: base,
    loadBots: () => [],
    makeRunNode: () => runNode,
    postGateCard: async () => {},
    ...overrides,
  };
  return { deps, runNode };
}

describe('run.json nodeExecutor', () => {
  it('is accepted on ad-hoc and saved-definition envelopes and survives the strict load', () => {
    const base = freshBase();
    const runDir = seedAdHocRun(base, 'env-bot', 'bot');
    expect(loadAuthorizedV3Run(runDir).envelope).toMatchObject({ nodeExecutor: 'bot' });

    const savedDir = join(base, 'env-saved');
    const adHoc = seedAdHocArtifacts(savedDir, 'env-saved');
    writeJson(join(savedDir, 'params.resolved.json'), { params: {}, context: {} });
    writeJson(join(savedDir, 'definition.snapshot.json'), {
      workflowId: 'wf_0123456789abcdef0123456789abcdef', revisionId: `rev_${'a'.repeat(64)}`, humanVersion: 1,
    });
    const saved = makeSavedDefinitionRunEnvelope({
      runId: 'env-saved',
      workflowId: 'wf_0123456789abcdef0123456789abcdef',
      revisionId: `rev_${'a'.repeat(64)}`,
      humanVersion: 1,
      createdAt: CREATED_AT,
      authorizedAt: AUTHORIZED_AT,
      chatBinding: BINDING,
      nodeExecutor: 'bot',
      artifacts: {
        ...adHoc,
        resolvedParams: artifactRef(savedDir, 'params.resolved.json'),
        definitionSnapshot: artifactRef(savedDir, 'definition.snapshot.json'),
      },
    });
    expect(saved.nodeExecutor).toBe('bot');
  });

  it('is absent from envelopes that do not opt in, so their bytes are unchanged', () => {
    const base = freshBase();
    const runDir = seedAdHocRun(base, 'env-plain');
    const envelope = loadAuthorizedV3Run(runDir).envelope;
    expect('nodeExecutor' in envelope).toBe(false);
    expect(JSON.parse(serializeRunEnvelope(envelope))).not.toHaveProperty('nodeExecutor');
  });

  it('rejects unknown executor values and the field on local / legacy envelopes', () => {
    const base = freshBase();
    const runDir = join(base, 'env-strict');
    const artifacts = seedAdHocArtifacts(runDir, 'env-strict');
    const adHoc = makeAdHocRunEnvelope({ runId: 'env-strict', createdAt: CREATED_AT, authorizedAt: AUTHORIZED_AT, artifacts });
    expect(() => validateRunEnvelope({ ...adHoc, nodeExecutor: 'ephemeral' })).toThrow(RunEnvelopeValidationError);

    const manual = makeManualCliRunEnvelope({
      runId: 'env-strict',
      createdAt: CREATED_AT,
      authorizedAt: AUTHORIZED_AT,
      artifacts: { dag: artifacts.dag, botSnapshots: artifacts.botSnapshots },
    });
    expect(() => validateRunEnvelope({ ...manual, nodeExecutor: 'bot' })).toThrow(RunEnvelopeValidationError);
  });
});

describe('daemon driver — external executor injection point', () => {
  it('fails closed for a bot-mode run when no executor is injected, without spawning a worker', async () => {
    const base = freshBase();
    seedAdHocRun(base, 'drv-no-exec', 'bot');
    const { deps, runNode } = driverDeps(base);
    await expect(driveV3Run('drv-no-exec', deps)).rejects.toThrow(/external node executor/);
    expect(runNode).not.toHaveBeenCalled();
  });

  it('drives a bot-mode run through the injected executor and suspends', async () => {
    const base = freshBase();
    seedAdHocRun(base, 'drv-bot', 'bot');
    const executor = new RecordingExecutor();
    const { deps, runNode } = driverDeps(base, { externalExecutor: executor, now: () => 1_000 });
    const outcome = await driveV3Run('drv-bot', deps);
    expect(outcome.reason).toBe('awaitingExternal');
    expect(runNode).not.toHaveBeenCalled();
    expect(executor.dispatches).toEqual([
      expect.objectContaining({ nodeId: 'work', targetLarkAppId: 'cli_worker', chatBinding: BINDING }),
    ]);
  });

  it('keeps an envelope without nodeExecutor on ephemeral workers even when an executor is injected', async () => {
    const base = freshBase();
    seedAdHocRun(base, 'drv-plain');
    const executor = new RecordingExecutor();
    const { deps, runNode } = driverDeps(base, { externalExecutor: executor });
    await driveV3Run('drv-plain', deps).catch(() => undefined);
    expect(runNode).toHaveBeenCalledTimes(1);
    expect(executor.dispatches).toEqual([]);
  });

  it('cold attach resumes a run whose external attempt is still open', async () => {
    const base = freshBase();
    seedAdHocRun(base, 'drv-cold', 'bot');
    const { deps } = driverDeps(base, { externalExecutor: new RecordingExecutor(), now: () => 1_000 });
    await driveV3Run('drv-cold', deps);
    expect(openV3ExternalAttempts(readJournal(join(base, 'drv-cold', 'journal.ndjson')))).toHaveLength(1);

    const recoveries = reconcileV3PendingGates(base, BINDING.larkAppId);
    expect(recoveries).toEqual([expect.objectContaining({ runId: 'drv-cold', resume: true, repost: [] })]);
    expect(reconcileV3PendingGates(base, 'cli_someone_else')).toEqual([]);
  });

  it('the gate runner re-drives at the reported deadline, which then surfaces the blocked node', async () => {
    const base = freshBase();
    seedAdHocRun(base, 'drv-wake', 'bot');
    const clock = { t: 5_000 };
    const wakes: Array<{ wakeAt: number; wake: () => void }> = [];
    let blockedSeen: (info: V3BlockedInfo) => void = () => {};
    const blocked = new Promise<V3BlockedInfo>((resolve) => { blockedSeen = resolve; });
    const runner = createV3GateRunner({
      baseDir: base,
      loadBots: () => [],
      makeRunNode: () => async () => { throw new Error('unexpected ephemeral worker'); },
      externalExecutor: new RecordingExecutor(),
      now: () => clock.t,
      postCard: async () => {},
      postBlockedCard: async (_binding, info) => { blockedSeen(info); },
      scheduleWake: (_runId, wakeAt, wake) => { if (wakeAt !== undefined) wakes.push({ wakeAt, wake }); },
    });

    await runner.drive('drv-wake');
    expect(wakes).toHaveLength(1);
    const sent = readJournal(join(base, 'drv-wake', 'journal.ndjson'))
      .find((event) => event.type === 'nodeHandoffSent');
    expect(wakes[0]!.wakeAt).toBe(sent && sent.type === 'nodeHandoffSent' ? sent.acceptDeadlineAt : NaN);

    clock.t = wakes[0]!.wakeAt;
    wakes[0]!.wake();
    expect(await blocked).toMatchObject({ nodeId: 'work', errorCode: 'HANDOFF_NOT_ACCEPTED' });
  });
});

describe('daemon driver — review regressions', () => {
  it('P2-a G1: a gate beside an external node is announced once across accept and wake re-drives', async () => {
    const base = freshBase();
    const runDir = seedAdHocRun(base, 'rv-gate-cards', 'bot', [
      WORK_NODE,
      { id: 'deploy', type: 'goal', goal: 'deploy', bot: 'cli_worker', depends: [], inputs: [], humanGate: { prompt: 'deploy?' } },
    ]);
    const clock = { t: 5_000 };
    const posted: string[] = [];
    const wakes: Array<() => void> = [];
    const runner = createV3GateRunner({
      baseDir: base,
      loadBots: () => [],
      makeRunNode: () => async () => { throw new Error('unexpected ephemeral worker'); },
      externalExecutor: new RecordingExecutor(),
      now: () => clock.t,
      postCard: async (_binding, gate) => { posted.push(gate.waitId); },
      scheduleWake: (_runId, wakeAt, wake) => { if (wakeAt !== undefined) wakes.push(wake); },
    });
    await runner.drive('rv-gate-cards');
    const attemptId = openV3ExternalAttempts(readJournal(join(runDir, 'journal.ndjson')))[0]!.attemptId;
    expect(recordExternalAccepted(runDir, { attemptId, sessionId: 'sess' }, { dag: loadDag(join(runDir, 'dag.json')), now: () => clock.t }))
      .toMatchObject({ ok: true });
    await runner.drive('rv-gate-cards'); // acceptance notification re-drive
    await runner.drive('rv-gate-cards'); // engine-deadline wake
    expect(posted).toEqual(['deploy#001-gate']);
  });

  it('P2-a W1: a blocked outcome cancels the pending wake and is announced once', async () => {
    const base = freshBase();
    const runDir = seedAdHocRun(base, 'rv-blocked-cards', 'bot');
    const clock = { t: 5_000 };
    const blockedCards: V3BlockedInfo[] = [];
    const wakeCalls: Array<number | undefined> = [];
    const runner = createV3GateRunner({
      baseDir: base,
      loadBots: () => [],
      makeRunNode: () => async () => { throw new Error('unexpected ephemeral worker'); },
      externalExecutor: new RecordingExecutor(),
      now: () => clock.t,
      postCard: async () => {},
      postBlockedCard: async (_binding, info) => { blockedCards.push(info); },
      scheduleWake: (_runId, wakeAt) => { wakeCalls.push(wakeAt); },
    });
    await runner.drive('rv-blocked-cards');
    expect(wakeCalls.at(-1)).toEqual(expect.any(Number));
    const attemptId = openV3ExternalAttempts(readJournal(join(runDir, 'journal.ndjson')))[0]!.attemptId;
    expect(reportExternalBlocked(runDir, { attemptId, reason: 'cannot' })).toEqual({ ok: true });
    await runner.drive('rv-blocked-cards');
    expect(wakeCalls.at(-1)).toBeUndefined(); // the stale deadline wake is cancelled
    await runner.drive('rv-blocked-cards'); // what a stale wake would have caused
    expect(blockedCards.map((info) => [info.nodeId, info.errorCode])).toEqual([['work', 'BOT_REPORTED_BLOCKED']]);
  });

  it('R2: reassignment is refused for an envelope that does not pin nodeExecutor "bot"', async () => {
    const base = freshBase();
    const plainDir = seedAdHocRun(base, 'rv-plain-reassign');
    const { deps } = driverDeps(base);
    await driveV3Run('rv-plain-reassign', deps).catch(() => undefined);
    expect(await reassignNode(plainDir, { nodeId: 'work', toLarkAppId: 'cli_worker', by: 'ou' }))
      .toEqual({ kind: 'rejected', reason: 'not-bot-run' });
  });
});

