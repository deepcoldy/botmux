/**
 * Templates (D5), the review round: a committed template run whose template
 * went away, the I13 confirmation recorded in run.json, gate loosening and
 * the published-version comparison (I10), a newer version after the run was
 * prepared, plain template-rule errors, an append retried with its request
 * key, and a confirmation voided by a bots.json change. Real draft service,
 * library store and run.json schema; fakes for Feishu, clarify, Architect.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Runs right after the commit step's library read (the archive window). */
const hooks = vi.hoisted(() => ({ afterRevisionRead: undefined as undefined | (() => void) }));
vi.mock('../src/workflows/v3/library-store.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/workflows/v3/library-store.js')>();
  return {
    ...real,
    readSavedWorkflowRevision: async (...args: Parameters<typeof real.readSavedWorkflowRevision>) => {
      const revision = await real.readSavedWorkflowRevision(...args);
      const hook = hooks.afterRevisionRead;
      hooks.afterRevisionRead = undefined;
      hook?.();
      return revision;
    },
  };
});

import { WorkflowDraftError, WorkflowDraftService } from '../src/workflows/v3/draft-service.js';
import { readWorkflowDraft, writeWorkflowDraft } from '../src/workflows/v3/draft-store.js';
import { readGrillState, writeGrillState } from '../src/workflows/v3/grill-state.js';
import {
  artifactRef,
  loadAuthorizedV3Run,
  makeAdHocRunEnvelope,
  makeSavedDefinitionRunEnvelope,
  publishRunEnvelopeOnce,
  readRunEnvelope,
  validateRunEnvelope,
} from '../src/workflows/v3/run-envelope.js';
import { appendEvent } from '../src/workflows/v3/journal.js';
import { listSavedWorkflowRevisions, readSavedWorkflowMetadata, savedWorkflowMetadataPath } from '../src/workflows/v3/library-store.js';
import { compareSavedWorkflowGates } from '../src/workflows/v3/library-schema.js';
import { loadSavedWorkflowDetailView } from '../src/workflows/v3/library-catalog.js';
import { canonicalJsonStringify } from '../src/utils/canonical-json.js';
import { v3FlowSummarySha256 } from '../src/workflows/v3/flow-summary.js';
import { ALICE, BOTS, DOC, MAIN, OWNER, PI, SKETCHES, STEWARD, architectSettled, goalNode, makeService, specMarkdown } from './helpers/workflow-draft-fakes.js';
import { fakeLaunch } from './helpers/workflow-launch-fakes.js';

const REVIEW = 'cli_review';
const ONLINE = [MAIN, DOC, REVIEW, STEWARD, PI];
const GATE = { prompt: '发出前确认？', approvers: ['ou_lead', 'ou_sec'] };

let root: string;
let base: string;
let library: string;
let fleet: any[];
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'wf-lib-fix-'));
  base = join(root, 'v3-runs');
  library = join(root, 'data');
  mkdirSync(base);
  mkdirSync(library);
  fleet = [...BOTS, { larkAppId: REVIEW, larkAppSecret: 's-rv', name: 'review', cliId: 'claude-code' }];
});
afterEach(() => {
  hooks.afterRevisionRead = undefined;
  rmSync(root, { recursive: true, force: true });
});

async function code(promise: Promise<unknown>): Promise<string> {
  try { await promise; } catch (error) {
    if (error instanceof WorkflowDraftError) return error.code;
    throw error;
  }
  return 'ok';
}

function setup() {
  const launch = fakeLaunch(base);
  launch.setOnline(ONLINE);
  const h = makeService(base, { loadBots: () => fleet, launch: launch.deps, libraryDataDir: library });
  h.setOnline(ONLINE);
  return { h, launch };
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function seedFinishedRun(runId: string, opts: { status?: 'succeeded' | 'failed' } = {}): void {
  const runDir = join(base, runId);
  mkdirSync(runDir, { recursive: true });
  writeJson(join(runDir, 'dag.json'), { schemaVersion: 2, runId, nodes: [goalNode('inspect', MAIN), { ...goalNode('write', DOC), depends: ['inspect'] }] });
  writeJson(join(runDir, 'spec.json'), { schemaVersion: 1, runId, title: '代码风险报告', requirement: '出报告', nodes: SKETCHES.map(({ assignee: _a, ...sketch }) => sketch) });
  writeJson(join(runDir, 'bots.snapshot.json'), {
    [MAIN]: { larkAppId: MAIN, cliId: 'claude-code', workingDir: '/source' },
    [DOC]: { larkAppId: DOC, cliId: 'claude-code', workingDir: '/source' },
  });
  publishRunEnvelopeOnce(runDir, makeAdHocRunEnvelope({
    runId, createdAt: '2026-11-01T08:00:00.000Z', authorizedAt: '2026-11-01T08:01:00.000Z',
    chatBinding: { larkAppId: MAIN, chatId: 'oc_src', chatType: 'group', rootMessageId: 'om_src', ownerOpenId: OWNER.openId },
    artifacts: { dag: artifactRef(runDir, 'dag.json'), spec: artifactRef(runDir, 'spec.json'), botSnapshots: artifactRef(runDir, 'bots.snapshot.json') },
  }));
  appendEvent(join(runDir, 'journal.ndjson'), { type: 'runStarted', runId });
  appendEvent(join(runDir, 'journal.ndjson'), opts.status === 'failed' ? { type: 'runFailed', failedNodeId: 'write' } : { type: 'runSucceeded' });
}

async function draftAtFlow(h: ReturnType<typeof makeService>, nodes: unknown[], opts: { confirm?: boolean } = {}): Promise<string> {
  h.architect.nodes = nodes;
  const created = await h.service.create(OWNER, { goal: '帮我出一份代码风险报告' });
  h.clarify.reply(`好的。\n<botmux-spec>\n${specMarkdown(SKETCHES)}\n</botmux-spec>`);
  expect((await h.service.finalizeSpec(created.runId, OWNER, {})).ok).toBe(true);
  await h.service.approveSpec(created.runId, OWNER);
  await h.service.startArchitect(created.runId, OWNER);
  await architectSettled(h.service, created.runId);
  if (opts.confirm !== false) {
    const view = await h.service.view(created.runId);
    await h.service.approveFlow(created.runId, OWNER, { flowSummarySha256: view.flow!.flowSummarySha256 });
  }
  return created.runId;
}

async function saveDraft(h: ReturnType<typeof makeService>, runId: string, extra: Record<string, unknown> = {}) {
  const preview = await h.service.previewTemplateSave(runId, OWNER, { ...(extra.workflowId ? { workflowId: extra.workflowId } : {}) });
  return h.service.saveAsTemplate(runId, OWNER, {
    flowSummarySha256: preview.flowSummarySha256,
    ...(extra.workflowId ? { expectedLatestRevision: preview.target!.latestRevision } : {}),
    requestKey: 'req-fix-00001',
    ...extra,
  });
}

async function settled(service: WorkflowDraftService, runId: string) {
  for (let i = 0; i < 400; i++) {
    const view = await service.view(runId);
    if (view.launch && !view.launch.running) return view;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`launch of ${runId} did not settle`);
}

const NODES = [goalNode('inspect', MAIN), goalNode('write', DOC)];
const GATED = [goalNode('inspect', MAIN), { ...goalNode('write', DOC), humanGate: GATE }];

describe('P2-1 run.json written, its record lost, the template gone', () => {
  for (const what of ['archived', 'deleted'] as const) {
    it(`${what}: 「继续」 replays the commit from the run directory and starts; bytes unchanged`, async () => {
      const { h, launch } = setup();
      seedFinishedRun('src-261101-080000-000-dddd0001');
      const saved = await h.service.saveRunAsTemplate('src-261101-080000-000-dddd0001', OWNER, { requestKey: 'req-fix-run01' });
      const draft = await h.service.createFromTemplate(OWNER, { workflowId: saved.workflowId });
      launch.failNext('startRun', new Error('boom'));
      await h.service.launch(draft.runId, OWNER, {});
      await settled(h.service, draft.runId);
      const runDir = join(base, draft.runId);
      const runJson = readFileSync(join(runDir, 'run.json'), 'utf-8');
      const record = readWorkflowDraft(runDir)!;
      delete record.launch!.commit;
      writeWorkflowDraft(runDir, record);
      writeGrillState(runDir, { ...readGrillState(runDir)!, status: 'dag_ready' });
      if (what === 'archived') {
        const metadata = await readSavedWorkflowMetadata(library, saved.workflowId);
        writeFileSync(savedWorkflowMetadataPath(library, saved.workflowId), `${canonicalJsonStringify({ ...metadata, status: 'archived' })}\n`);
      } else {
        rmSync(join(library, 'workflow-library'), { recursive: true, force: true });
      }
      const next = new WorkflowDraftService({ ...h.deps });
      next.recoverInterrupted();
      await next.continueLaunch(draft.runId, OWNER);
      const done = await settled(next, draft.runId);
      expect(done.phase).toBe('started');
      expect(done.launch!.commit).toBeDefined();
      expect(readFileSync(join(runDir, 'run.json'), 'utf-8')).toBe(runJson);
      expect(launch.starts).toEqual([draft.runId]);
    });
  }

  it('archived between the library read and the commit: caught inside the lock, nothing published', async () => {
    const { h } = setup();
    seedFinishedRun('src-261101-080000-000-dddd0002');
    const saved = await h.service.saveRunAsTemplate('src-261101-080000-000-dddd0002', OWNER, { requestKey: 'req-fix-run02' });
    const draft = await h.service.createFromTemplate(OWNER, { workflowId: saved.workflowId });
    const metadata = await readSavedWorkflowMetadata(library, saved.workflowId);
    let armed = false;
    // Arm on the launch's first read of the revision at the commit step.
    const service = new WorkflowDraftService({
      ...h.deps,
      launch: {
        ...h.deps.launch!,
        grant: async (...args) => {
          const out = await h.deps.launch!.grant(...args);
          if (!armed) {
            armed = true;
            hooks.afterRevisionRead = () => {
              writeFileSync(savedWorkflowMetadataPath(library, saved.workflowId), `${canonicalJsonStringify({ ...metadata, status: 'archived' })}\n`);
            };
          }
          return out;
        },
      },
    });
    await service.launch(draft.runId, OWNER, {});
    const stopped = await settled(service, draft.runId);
    expect(stopped.launch).toMatchObject({ state: 'paused', error: { step: 'commit', code: 'template_unavailable' } });
    expect(readRunEnvelope(join(base, draft.runId), draft.runId).kind).toBe('missing');
  });
});

describe('P3-c / P3-d 重放的记录与产物不一致', () => {
  async function committedThenLost(h: ReturnType<typeof makeService>, launch: ReturnType<typeof fakeLaunch>, workflowId: string) {
    const draft = await h.service.createFromTemplate(OWNER, { workflowId });
    launch.failNext('startRun', new Error('boom'));
    await h.service.launch(draft.runId, OWNER, {});
    await settled(h.service, draft.runId);
    const runDir = join(base, draft.runId);
    const record = readWorkflowDraft(runDir)!;
    delete record.launch!.commit;
    writeWorkflowDraft(runDir, record);
    writeGrillState(runDir, { ...readGrillState(runDir)!, status: 'dag_ready' });
    return { runId: draft.runId, runDir };
  }

  it('the replayed record keeps the confirmation digest run.json carries, and never stands a DAG digest in for a summary', async () => {
    const { h, launch } = setup();
    const saved = await saveDraft(h, await draftAtFlow(h, NODES));
    const { runId, runDir } = await committedThenLost(h, launch, saved.workflowId);
    const run = (readRunEnvelope(runDir, runId) as any).envelope;
    // bots.json lost DOC: the flow cannot be summarised any more.
    fleet = fleet.filter((bot) => bot.larkAppId !== DOC);
    const next = new WorkflowDraftService({ ...h.deps });
    await next.continueLaunch(runId, OWNER);
    expect((await settled(next, runId)).phase).toBe('started');
    const commit = readWorkflowDraft(runDir)!.launch!.commit!;
    expect(commit.flowSummarySha256).toBe(run.authorization.flowConfirmation.flowSummarySha256);
    expect(commit.flowSummarySha256).not.toBe(commit.dagSha256);

    seedFinishedRun('src-261101-080000-000-dddd0008');
    fleet = [...BOTS, { larkAppId: REVIEW, larkAppSecret: 's-rv', name: 'review', cliId: 'claude-code' }];
    const fromRun = await h.service.saveRunAsTemplate('src-261101-080000-000-dddd0008', OWNER, { requestKey: 'req-fix-run08' });
    const plain = await committedThenLost(h, launch, fromRun.workflowId);
    fleet = fleet.filter((bot) => bot.larkAppId !== DOC);
    await next.continueLaunch(plain.runId, OWNER);
    expect((await settled(next, plain.runId)).phase).toBe('started');
    expect(readWorkflowDraft(plain.runDir)!.launch!.commit!.flowSummarySha256).toBeUndefined();
  });

  it('an artifact no longer matching run.json stops at commit as template_unavailable, with a reason, nothing started', async () => {
    const { h, launch } = setup();
    seedFinishedRun('src-261101-080000-000-dddd0009');
    const saved = await h.service.saveRunAsTemplate('src-261101-080000-000-dddd0009', OWNER, { requestKey: 'req-fix-run09' });
    const { runId, runDir } = await committedThenLost(h, launch, saved.workflowId);
    writeJson(join(runDir, 'params.resolved.json'), { params: { injected: true }, context: {} });
    await h.service.continueLaunch(runId, OWNER);
    const stopped = await settled(h.service, runId);
    expect(stopped.launch).toMatchObject({ state: 'paused', error: { step: 'commit', code: 'template_unavailable', message: expect.stringContaining('对不上') } });
    expect(launch.starts).toEqual([]);
  });
});

describe('I13（11-05）：草稿来源版本直接运行，保存时的确认写进 run.json', () => {
  it('another person runs a draft-born version directly: run.json records the saved confirmation as is; a run-born one records none', async () => {
    const { h } = setup();
    const saved = await saveDraft(h, await draftAtFlow(h, NODES));
    const provenance = (await listSavedWorkflowRevisions(library, saved.workflowId))[0]!.payload.provenance as any;
    const draft = await h.service.createFromTemplate(ALICE, { workflowId: saved.workflowId });
    expect(draft.phase).toBe('flow_confirmed');
    await h.service.launch(draft.runId, ALICE, {});
    expect((await settled(h.service, draft.runId)).phase).toBe('started');
    const runDir = join(base, draft.runId);
    const run = (readRunEnvelope(runDir, draft.runId) as any).envelope;
    expect(run.authorization.initiator).toEqual({ openId: ALICE.openId, unionId: ALICE.unionId, source: 'dashboard-platform' });
    expect(run.authorization.flowConfirmation).toEqual({
      confirmedByOpenId: OWNER.openId,
      confirmedAt: provenance.confirmation.confirmedAt,
      flowSummary: provenance.confirmation.flowSummary,
      flowSummarySha256: provenance.confirmation.flowSummarySha256,
    });
    expect(() => loadAuthorizedV3Run(runDir, { allowedSources: ['saved_definition'] })).not.toThrow();

    // The recorded confirmation must be the snapshot's: another time, or
    // none at all, does not load.
    const reload = (authorization: Record<string, unknown>) => {
      rmSync(join(runDir, 'run.json'));
      publishRunEnvelopeOnce(runDir, validateRunEnvelope({ ...run, authorization }) as any);
      return () => loadAuthorizedV3Run(runDir, { allowedSources: ['saved_definition'] });
    };
    expect(reload({ ...run.authorization, flowConfirmation: { ...run.authorization.flowConfirmation, confirmedAt: '2026-01-01T00:00:00.000Z' } }))
      .toThrow(/does not match the confirmation of its definition snapshot/);
    const { flowConfirmation: _dropped, ...without } = run.authorization;
    expect(reload(without)).toThrow(/does not match the confirmation of its definition snapshot/);

    seedFinishedRun('src-261101-080000-000-dddd0003');
    const fromRun = await h.service.saveRunAsTemplate('src-261101-080000-000-dddd0003', OWNER, { requestKey: 'req-fix-run03' });
    const plain = await h.service.createFromTemplate(OWNER, { workflowId: fromRun.workflowId });
    await h.service.launch(plain.runId, OWNER, {});
    expect((await settled(h.service, plain.runId)).phase).toBe('started');
    const plainDir = join(base, plain.runId);
    const plainRun = (readRunEnvelope(plainDir, plain.runId) as any).envelope;
    expect(plainRun.authorization.flowConfirmation).toBeUndefined();
    // A confirmation on a version that carries none does not load either.
    rmSync(join(plainDir, 'run.json'));
    publishRunEnvelopeOnce(plainDir, validateRunEnvelope({ ...plainRun, authorization: { ...plainRun.authorization, flowConfirmation: run.authorization.flowConfirmation } }) as any);
    expect(() => loadAuthorizedV3Run(plainDir, { allowedSources: ['saved_definition'] })).toThrow(/does not match the confirmation/);
  });

  it('schema: on published_revision the confirmer is the version\'s (not the initiator), named, and its digest is the canonical summary\'s', () => {
    const runId = 'tmpl-261105-100000-000-eeee0001';
    const runDir = join(base, runId);
    mkdirSync(runDir);
    for (const name of ['dag.json', 'spec.json', 'bots.snapshot.json', 'params.resolved.json', 'definition.snapshot.json']) writeJson(join(runDir, name), { name });
    const summary = { version: 1 as const, nodes: [{ nodeId: 'a', larkAppId: MAIN }], unplacedAssignees: [], sideEffects: [], gateDigest: `sha256:${'a'.repeat(64)}` };
    const confirmation = { confirmedByOpenId: 'ou_saver', confirmedAt: '2026-11-05T10:00:00.000Z', flowSummary: summary, flowSummarySha256: v3FlowSummarySha256(summary) };
    const build = (over: Record<string, unknown> = {}) => ({
      runId,
      workflowId: `wf_${'1'.repeat(32)}`,
      revisionId: `rev_${'2'.repeat(64)}`,
      humanVersion: 1,
      createdAt: '2026-11-05T10:00:00.000Z',
      authorizedAt: '2026-11-05T10:00:00.000Z',
      chatBinding: { larkAppId: MAIN, chatId: 'oc_x', chatType: 'group' as const, rootMessageId: 'om_x', ownerOpenId: OWNER.openId },
      nodeExecutor: 'bot' as const,
      initiator: { openId: OWNER.openId, source: 'dashboard-local' as const },
      flowConfirmation: confirmation,
      artifacts: {
        dag: artifactRef(runDir, 'dag.json'), spec: artifactRef(runDir, 'spec.json'), botSnapshots: artifactRef(runDir, 'bots.snapshot.json'),
        resolvedParams: artifactRef(runDir, 'params.resolved.json'), definitionSnapshot: artifactRef(runDir, 'definition.snapshot.json'),
      },
      ...over,
    });
    // The initiator need not be the confirmer, nor the run bot-executed (a
    // Feishu ephemeral `/workflow run`).
    expect((makeSavedDefinitionRunEnvelope(build() as any).authorization as any).flowConfirmation.confirmedByOpenId).toBe('ou_saver');
    expect(() => makeSavedDefinitionRunEnvelope(build({ nodeExecutor: undefined, initiator: undefined }) as any)).not.toThrow();
    const { confirmedByOpenId: _c, ...anonymous } = confirmation;
    expect(() => makeSavedDefinitionRunEnvelope(build({ flowConfirmation: anonymous }) as any)).toThrow(/is required on a published_revision run/);
    expect(() => makeSavedDefinitionRunEnvelope(build({ flowConfirmation: { ...confirmation, flowSummarySha256: `sha256:${'b'.repeat(64)}` } }) as any)).toThrow(/canonical flowSummary/);
    // gate2 keeps the D1 rule: only the initiator confirms.
    const adHoc = {
      runId, createdAt: '2026-11-05T10:00:00.000Z', authorizedAt: '2026-11-05T10:00:00.000Z', authorizedByOpenId: OWNER.openId,
      chatBinding: { larkAppId: MAIN, chatId: 'oc_x', rootMessageId: 'om_x', ownerOpenId: OWNER.openId },
      nodeExecutor: 'bot' as const, initiator: { openId: OWNER.openId, source: 'dashboard-local' as const }, flowConfirmation: confirmation,
      artifacts: { dag: artifactRef(runDir, 'dag.json'), spec: artifactRef(runDir, 'spec.json'), botSnapshots: artifactRef(runDir, 'bots.snapshot.json') },
    };
    expect(() => makeAdHocRunEnvelope(adHoc as any)).toThrow(/only the initiator confirms/);
    expect(() => makeAdHocRunEnvelope({ ...adHoc, nodeExecutor: undefined, initiator: undefined } as any)).toThrow(/requires nodeExecutor/);
  });
});

describe('I10 人工确认的放宽与发布版比较', () => {
  it('more people may approve = loosened (cleared, or someone added); fewer named approvers narrows and is not', () => {
    const at = (gate: Record<string, unknown>) => ({ schemaVersion: 2 as const, nodes: [goalNode('inspect', MAIN), { ...goalNode('write', DOC), humanGate: gate }] as any });
    const before = at(GATE);
    expect(compareSavedWorkflowGates(before, at({ prompt: GATE.prompt })).loosened)
      .toEqual([{ nodeId: 'write', reason: 'approvers_cleared', items: ['ou_lead', 'ou_sec'] }]);
    expect(compareSavedWorkflowGates(before, at({ ...GATE, approvers: ['ou_lead', 'ou_sec', 'ou_new'] })).loosened)
      .toEqual([{ nodeId: 'write', reason: 'approvers_added', items: ['ou_new'] }]);
    // Removing a named approver narrows who may approve: changed, not loosened.
    expect(compareSavedWorkflowGates(before, at({ ...GATE, approvers: ['ou_lead'] }))).toMatchObject({ loosened: [], changed: ['write'] });
    // Naming approvers where anyone could approve narrows too.
    expect(compareSavedWorkflowGates(at({ prompt: GATE.prompt }), before)).toMatchObject({ loosened: [], changed: ['write'] });
    expect(compareSavedWorkflowGates(before, at({ ...GATE, prompt: '再看看？' }))).toMatchObject({ loosened: [], changed: ['write'] });
  });

  it('more options that count as approval = loosened; approver / approve-option order is no change', () => {
    const at = (gate: Record<string, unknown>) => ({ schemaVersion: 2 as const, nodes: [goalNode('inspect', MAIN), { ...goalNode('write', DOC), humanGate: gate }] as any });
    const options = { prompt: 'ok?', options: ['approve', 'approve_with_notes', 'reject'], approvers: ['ou_lead', 'ou_sec'] };
    const before = at({ ...options, approveOptions: ['approve'] });
    expect(compareSavedWorkflowGates(before, at({ ...options, approveOptions: ['approve', 'approve_with_notes'] })).loosened)
      .toEqual([{ nodeId: 'write', reason: 'approve_options_added', items: ['approve_with_notes'] }]);
    // Fewer approve options narrows: a change only.
    expect(compareSavedWorkflowGates(at({ ...options, approveOptions: ['approve', 'approve_with_notes'] }), before)).toMatchObject({ loosened: [], changed: ['write'] });
    expect(compareSavedWorkflowGates(
      at({ ...options, approvers: ['ou_sec', 'ou_lead'], approveOptions: ['approve_with_notes', 'approve'] }),
      at({ ...options, approvers: ['ou_lead', 'ou_sec'], approveOptions: ['approve', 'approve_with_notes'] }),
    )).toMatchObject({ loosened: [], changed: [] });
  });

  it('appending after an unpublished latest compares with the published version too and shows the stricter warning', async () => {
    const { h } = setup();
    const first = await saveDraft(h, await draftAtFlow(h, GATED));
    // v2: a failed run's flow (no gate), saved as an unpublished version.
    seedFinishedRun('src-261101-080000-000-dddd0004', { status: 'failed' });
    const p2 = await h.service.previewRunSave('src-261101-080000-000-dddd0004', OWNER, { workflowId: first.workflowId, allowDraft: true });
    const v2 = await h.service.saveRunAsTemplate('src-261101-080000-000-dddd0004', OWNER, {
      workflowId: first.workflowId, expectedLatestRevision: p2.target!.latestRevision, allowDraft: true, requestKey: 'req-fix-run04',
    });
    expect(v2.published).toBe(false);
    const ungated = await draftAtFlow(h, NODES);
    const preview = await h.service.previewTemplateSave(ungated, OWNER, { workflowId: first.workflowId });
    // Both shown: against the latest (v2) nothing is removed; against the published v1 the gate is.
    expect(preview.target!.gateComparisons.map((c) => [c.base.kind, c.base.humanVersion, c.gates.removed])).toEqual([
      ['previous', 2, []],
      ['published', 1, ['write']],
    ]);
    // The history of a pending version names the published one too.
    seedFinishedRun('src-261101-080000-000-dddd0007', { status: 'failed' });
    const p3 = await h.service.previewRunSave('src-261101-080000-000-dddd0007', OWNER, { workflowId: first.workflowId, allowDraft: true });
    await h.service.saveRunAsTemplate('src-261101-080000-000-dddd0007', OWNER, {
      workflowId: first.workflowId, expectedLatestRevision: p3.target!.latestRevision, allowDraft: true, requestKey: 'req-fix-run07',
    });
    const detail = await loadSavedWorkflowDetailView(library, first.workflowId);
    const v3 = detail.versions.find((v) => v.humanVersion === 3)!;
    expect(v3.gateComparisons.map((c) => [c.base.kind, c.base.humanVersion, c.gates.removed])).toEqual([
      ['previous', 2, []],
      ['published', 1, ['write']],
    ]);
  });
});

describe('P3-4 准备运行后发布了新版本', () => {
  it('the template run shows the newer version and still commits the prepared one', async () => {
    const { h } = setup();
    seedFinishedRun('src-261101-080000-000-dddd0005');
    const saved = await h.service.saveRunAsTemplate('src-261101-080000-000-dddd0005', OWNER, { requestKey: 'req-fix-run05' });
    const draft = await h.service.createFromTemplate(OWNER, { workflowId: saved.workflowId });
    expect(draft.template!.newerPublished).toBeUndefined();
    seedFinishedRun('src-261101-080000-000-dddd0006');
    const p = await h.service.previewRunSave('src-261101-080000-000-dddd0006', OWNER, { workflowId: saved.workflowId });
    await h.service.saveRunAsTemplate('src-261101-080000-000-dddd0006', OWNER, { workflowId: saved.workflowId, expectedLatestRevision: p.target!.latestRevision, requestKey: 'req-fix-run06' });
    const view = await h.service.view(draft.runId);
    expect(view.template!.newerPublished).toMatchObject({ humanVersion: 2 });
    await h.service.launch(draft.runId, OWNER, {});
    expect((await settled(h.service, draft.runId)).phase).toBe('started');
    expect((readRunEnvelope(join(base, draft.runId), draft.runId) as any).envelope.source).toMatchObject({ revisionId: saved.revisionId, humanVersion: 1 });
  });
});

describe('P3-5 / P3-6 / 确认被 bots.json 变化作废', () => {
  it('a flow that breaks the template rules is a 4xx template_invalid, not an internal error', async () => {
    const { h } = setup();
    const runId = await draftAtFlow(h, [{ ...goalNode('inspect', MAIN), override: { systemPromptAppend: '看 ${x}' } }, goalNode('write', DOC)]);
    const error = await h.service.previewTemplateSave(runId, OWNER, {}).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WorkflowDraftError);
    expect(error).toMatchObject({ code: 'template_invalid', status: 422, retryable: false });
  });

  it('an append retried with its request key returns the version it wrote, also after the latest moved', async () => {
    const { h } = setup();
    const first = await saveDraft(h, await draftAtFlow(h, NODES));
    const other = await draftAtFlow(h, GATED);
    const preview = await h.service.previewTemplateSave(other, OWNER, { workflowId: first.workflowId });
    const save = () => h.service.saveAsTemplate(other, OWNER, {
      flowSummarySha256: preview.flowSummarySha256, workflowId: first.workflowId,
      expectedLatestRevision: preview.target!.latestRevision, requestKey: 'req-append-0001',
    });
    const [a, b] = await Promise.all([save(), save()]);
    expect(a.revisionId).toBe(b.revisionId);
    expect(await save()).toMatchObject({ revisionId: a.revisionId, humanVersion: 2 });
    expect(await listSavedWorkflowRevisions(library, first.workflowId)).toHaveLength(2);
    // Another request with the same stale view is still refused.
    expect(await code(h.service.saveAsTemplate(other, OWNER, {
      flowSummarySha256: preview.flowSummarySha256, workflowId: first.workflowId,
      expectedLatestRevision: preview.target!.latestRevision, requestKey: 'req-append-0002',
    }))).toBe('save_conflict');
    // The same request key with other content is not answered with the old version.
    const swapped = await h.service.setNodeBot(other, OWNER, 'inspect', { larkAppId: REVIEW });
    await h.service.approveFlow(other, OWNER, { flowSummarySha256: swapped.flow!.flowSummarySha256 });
    const changed = await h.service.previewTemplateSave(other, OWNER, { workflowId: first.workflowId });
    expect(await code(h.service.saveAsTemplate(other, OWNER, {
      flowSummarySha256: changed.flowSummarySha256, workflowId: first.workflowId,
      expectedLatestRevision: changed.target!.latestRevision, requestKey: 'req-append-0001',
    }))).toBe('save_conflict');
    expect(await listSavedWorkflowRevisions(library, first.workflowId)).toHaveLength(2);
  });

  it('a new template retried with the same request key: a changed summary or name is a conflict, not the old one', async () => {
    const { h } = setup();
    const runId = await draftAtFlow(h, NODES);
    const first = await h.service.previewTemplateSave(runId, OWNER, {});
    const saved = await h.service.saveAsTemplate(runId, OWNER, { flowSummarySha256: first.flowSummarySha256, requestKey: 'req-new-00001', displayName: '风险报告' });
    // The very same request again: the same template.
    expect(await h.service.saveAsTemplate(runId, OWNER, { flowSummarySha256: first.flowSummarySha256, requestKey: 'req-new-00001', displayName: '风险报告' }))
      .toMatchObject({ workflowId: saved.workflowId, created: false });
    // Only the name differs.
    expect(await code(h.service.saveAsTemplate(runId, OWNER, { flowSummarySha256: first.flowSummarySha256, requestKey: 'req-new-00001', displayName: '另一个名字' })))
      .toBe('save_conflict');
    // Only the confirmed summary differs: the same DAG, but a bot changed CLI
    // (bots.json), so the flow was confirmed again with another summary.
    fleet = fleet.map((bot) => (bot.larkAppId === DOC ? { ...bot, cliId: 'codex' } : bot));
    const reread = await h.service.view(runId);
    await h.service.approveFlow(runId, OWNER, { flowSummarySha256: reread.flow!.flowSummarySha256 });
    const second = await h.service.previewTemplateSave(runId, OWNER, {});
    expect(second.flowSummarySha256).not.toBe(first.flowSummarySha256);
    expect(await code(h.service.saveAsTemplate(runId, OWNER, { flowSummarySha256: second.flowSummarySha256, requestKey: 'req-new-00001', displayName: '风险报告' })))
      .toBe('save_conflict');
    const revisions = await listSavedWorkflowRevisions(library, saved.workflowId);
    expect(revisions).toHaveLength(1);
    expect((revisions[0]!.payload.provenance as any).confirmation.flowSummarySha256).toBe(first.flowSummarySha256);
    expect((await readSavedWorkflowMetadata(library, saved.workflowId)).displayName).toBe('风险报告');
  });

  it('a new template from a run retried with the same request key and another name is a conflict', async () => {
    const { h } = setup();
    seedFinishedRun('src-261101-080000-000-dddd0010');
    const saved = await h.service.saveRunAsTemplate('src-261101-080000-000-dddd0010', OWNER, { requestKey: 'req-new-00002', displayName: '周报' });
    expect(await h.service.saveRunAsTemplate('src-261101-080000-000-dddd0010', OWNER, { requestKey: 'req-new-00002', displayName: '周报' }))
      .toMatchObject({ workflowId: saved.workflowId, created: false });
    expect(await code(h.service.saveRunAsTemplate('src-261101-080000-000-dddd0010', OWNER, { requestKey: 'req-new-00002', displayName: '月报' }))).toBe('save_conflict');
    expect(await listSavedWorkflowRevisions(library, saved.workflowId)).toHaveLength(1);
    expect((await readSavedWorkflowMetadata(library, saved.workflowId)).displayName).toBe('周报');
  });

  it('a confirmation voided by a bots.json change: saving with the new summary is refused', async () => {
    const { h } = setup();
    const runId = await draftAtFlow(h, NODES);
    const before = await h.service.previewTemplateSave(runId, OWNER, {});
    // DOC changes CLI: the summary's node → bot (CLI) row changes.
    fleet = fleet.map((bot) => (bot.larkAppId === DOC ? { ...bot, cliId: 'codex' } : bot));
    const view = await h.service.view(runId);
    expect(view.flow!.flowSummarySha256).not.toBe(before.flowSummarySha256);
    expect(await code(h.service.saveAsTemplate(runId, OWNER, { flowSummarySha256: view.flow!.flowSummarySha256, requestKey: 'req-fix-00009' }))).toBe('flow_changed');
    expect(await code(h.service.previewTemplateSave(runId, OWNER, {}))).toBe('flow_changed');
  });
});
