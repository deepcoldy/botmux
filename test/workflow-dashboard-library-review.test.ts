/**
 * Templates (D5): the three overlap classes CLAUDE.md asks for — a person
 * acting mid-way, a multi-step write left half done, and a template that
 * moved while a run of it was being prepared — on the real draft service,
 * library store and run.json schema. Fakes: Feishu (fakeLaunch), clarify
 * session, Architect worker, clock.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { WorkflowDraftError, WorkflowDraftService } from '../src/workflows/v3/draft-service.js';
import { readWorkflowDraft, writeWorkflowDraft } from '../src/workflows/v3/draft-store.js';
import { readGrillState, writeGrillState } from '../src/workflows/v3/grill-state.js';
import { readRunEnvelope, artifactRef, makeAdHocRunEnvelope, publishRunEnvelopeOnce } from '../src/workflows/v3/run-envelope.js';
import { appendEvent } from '../src/workflows/v3/journal.js';
import { readSavedWorkflowMetadata, savedWorkflowMetadataPath } from '../src/workflows/v3/library-store.js';
import { canonicalJsonStringify } from '../src/utils/canonical-json.js';
import { BOTS, DOC, MAIN, OWNER, PI, SKETCHES, STEWARD, architectSettled, goalNode, makeService, specMarkdown } from './helpers/workflow-draft-fakes.js';
import { fakeLaunch } from './helpers/workflow-launch-fakes.js';

const REVIEW = 'cli_review';
const FLEET = [...BOTS, { larkAppId: REVIEW, larkAppSecret: 's-rv', name: 'review', cliId: 'claude-code' }] as any[];
const ONLINE = [MAIN, DOC, REVIEW, STEWARD, PI];

let root: string;
let base: string;
let library: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'wf-lib-review-'));
  base = join(root, 'v3-runs');
  library = join(root, 'data');
  mkdirSync(base);
  mkdirSync(library);
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

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
  const h = makeService(base, { loadBots: () => FLEET, launch: launch.deps, libraryDataDir: library });
  h.setOnline(ONLINE);
  return { h, launch };
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function seedFinishedRun(runId: string): void {
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
  appendEvent(join(runDir, 'journal.ndjson'), { type: 'runSucceeded' });
}

async function settled(service: WorkflowDraftService, runId: string) {
  for (let i = 0; i < 400; i++) {
    const view = await service.view(runId);
    if (view.launch && !view.launch.running) return view;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`launch of ${runId} did not settle`);
}

async function templateFromRun(h: ReturnType<typeof makeService>, suffix: string) {
  const runId = `src-261101-080000-000-cccc${suffix}`;
  seedFinishedRun(runId);
  return h.service.saveRunAsTemplate(runId, OWNER, { requestKey: `req-review-${suffix}` });
}

describe('多步写入只完成一半', () => {
  it('template run.json published but its record lost: 「继续」 replays the same commit, bytes unchanged, then starts', async () => {
    const { h, launch } = setup();
    const saved = await templateFromRun(h, '0001');
    const draft = await h.service.createFromTemplate(OWNER, { workflowId: saved.workflowId });
    launch.failNext('startRun', new Error('boom'));
    await h.service.launch(draft.runId, OWNER, {});
    expect((await settled(h.service, draft.runId)).launch).toMatchObject({ state: 'paused', error: { step: 'start' } });
    const runDir = join(base, draft.runId);
    const runJson = readFileSync(join(runDir, 'run.json'), 'utf-8');
    const snapshot = readFileSync(join(runDir, 'definition.snapshot.json'), 'utf-8');
    // As if the process died right after publishing run.json (before the
    // record and the grill transition).
    const record = readWorkflowDraft(runDir)!;
    delete record.launch!.commit;
    writeWorkflowDraft(runDir, record);
    writeGrillState(runDir, { ...readGrillState(runDir)!, status: 'dag_ready' });
    const next = new WorkflowDraftService({ ...h.deps });
    next.recoverInterrupted();
    await next.continueLaunch(draft.runId, OWNER);
    expect((await settled(next, draft.runId)).phase).toBe('started');
    expect(readFileSync(join(runDir, 'run.json'), 'utf-8')).toBe(runJson);
    expect(readFileSync(join(runDir, 'definition.snapshot.json'), 'utf-8')).toBe(snapshot);
    expect(launch.starts).toEqual([draft.runId]);
  });

  it('a run.json of another initiator in the same dir is never taken as this commit', async () => {
    const { h, launch } = setup();
    const saved = await templateFromRun(h, '0008');
    const draft = await h.service.createFromTemplate(OWNER, { workflowId: saved.workflowId });
    launch.failNext('startRun', new Error('boom'));
    await h.service.launch(draft.runId, OWNER, {});
    await settled(h.service, draft.runId);
    const runDir = join(base, draft.runId);
    const env = JSON.parse(readFileSync(join(runDir, 'run.json'), 'utf-8'));
    const foreign = {
      ...env,
      chatBinding: { ...env.chatBinding, ownerOpenId: 'ou_someone' },
      authorization: { ...env.authorization, initiator: { ...env.authorization.initiator, openId: 'ou_someone' } },
    };
    rmSync(join(runDir, 'run.json'));
    writeFileSync(join(runDir, 'run.json'), `${canonicalJsonStringify(foreign)}\n`);
    const record = readWorkflowDraft(runDir)!;
    delete record.launch!.commit;
    writeWorkflowDraft(runDir, record);
    await h.service.continueLaunch(draft.runId, OWNER);
    expect((await settled(h.service, draft.runId)).launch).toMatchObject({ state: 'paused', error: { step: 'commit', code: 'template_unavailable' } });
    expect(launch.starts).toEqual([]);
  });

  it('a run.json that is not this template run\'s is never overwritten', async () => {
    const { h, launch } = setup();
    const saved = await templateFromRun(h, '0002');
    const draft = await h.service.createFromTemplate(OWNER, { workflowId: saved.workflowId });
    launch.failNext('startRun', new Error('boom'));
    await h.service.launch(draft.runId, OWNER, {});
    await settled(h.service, draft.runId);
    const runDir = join(base, draft.runId);
    const env = JSON.parse(readFileSync(join(runDir, 'run.json'), 'utf-8'));
    // Same draft dir, but a run.json bound to some other topic.
    const foreign = { ...env, chatBinding: { ...env.chatBinding, rootMessageId: 'om_other' } };
    rmSync(join(runDir, 'run.json'));
    writeFileSync(join(runDir, 'run.json'), `${canonicalJsonStringify(foreign)}\n`);
    const record = readWorkflowDraft(runDir)!;
    delete record.launch!.commit;
    writeWorkflowDraft(runDir, record);
    await h.service.continueLaunch(draft.runId, OWNER);
    const stopped = await settled(h.service, draft.runId);
    expect(stopped.launch).toMatchObject({ state: 'paused', error: { step: 'commit', code: 'template_unavailable' } });
    expect(JSON.parse(readFileSync(join(runDir, 'run.json'), 'utf-8')).chatBinding.rootMessageId).toBe('om_other');
    expect(launch.starts).toEqual([]);
  });

  it('dag.json edited after the run was prepared: refused at commit, nothing published', async () => {
    const { h } = setup();
    const saved = await templateFromRun(h, '0003');
    const draft = await h.service.createFromTemplate(OWNER, { workflowId: saved.workflowId });
    const runDir = join(base, draft.runId);
    const dag = JSON.parse(readFileSync(join(runDir, 'dag.json'), 'utf-8'));
    dag.nodes[0].goal = '改过的目标';
    writeJson(join(runDir, 'dag.json'), dag);
    // The page sees it before anything is launched.
    expect((await h.service.view(draft.runId)).phase).toBe('dag_ready');
    expect(await code(h.service.launch(draft.runId, OWNER, {}))).toBe('flow_changed');
    expect(readRunEnvelope(runDir, draft.runId).kind).toBe('missing');
  });
});

describe('模板运行的主 Bot 会话（迁入主话题）', () => {
  it('died while moving it in: the next process binds the same session, never opens a second', async () => {
    const { h, launch } = setup();
    const saved = await templateFromRun(h, '0011');
    const draft = await h.service.createFromTemplate(OWNER, { workflowId: saved.workflowId });
    launch.hangBefore('bindSession');
    await h.service.launch(draft.runId, OWNER, {});
    for (let i = 0; i < 400 && launch.count('bindSession') === 0; i++) await new Promise((r) => setTimeout(r, 5));
    expect(readWorkflowDraft(join(base, draft.runId))!.launch!.migrate).toMatchObject({ status: 'binding' });
    const next = new WorkflowDraftService({ ...h.deps });
    next.recoverInterrupted();
    await next.continueLaunch(draft.runId, OWNER);
    expect((await settled(next, draft.runId)).phase).toBe('started');
    expect(h.clarify.sessions.size).toBe(1);
    const [sessionId] = [...h.clarify.sessions.keys()];
    expect(launch.binds.map((b) => b.sessionId)).toEqual([sessionId]);
    expect(h.clarify.sessions.get(sessionId!)!.closed).toBe(false);
  });

  it('a bind that failed leaves the session the topic\'s: 「放弃」 keeps it open (D4 rule)', async () => {
    const { h, launch } = setup();
    const saved = await templateFromRun(h, '0012');
    const draft = await h.service.createFromTemplate(OWNER, { workflowId: saved.workflowId });
    launch.failNext('bindSession', new Error('worker busy'));
    await h.service.launch(draft.runId, OWNER, {});
    expect((await settled(h.service, draft.runId)).launch).toMatchObject({ state: 'paused', error: { step: 'migrate', code: 'bind_failed' } });
    await h.service.abandonLaunch(draft.runId, OWNER);
    const [sessionId] = [...h.clarify.sessions.keys()];
    expect(h.clarify.sessions.get(sessionId!)!.closed).toBe(false);
  });
});

describe('人工中途干预', () => {
  it('stopped at the live check, a bot swapped on a template run: 确认流程 again, then it starts as an ad-hoc run', async () => {
    const { h, launch } = setup();
    const saved = await templateFromRun(h, '0004');
    const draft = await h.service.createFromTemplate(OWNER, { workflowId: saved.workflowId });
    launch.uninvitable.add(DOC);
    await h.service.launch(draft.runId, OWNER, {});
    const stopped = await settled(h.service, draft.runId);
    expect(stopped.launch).toMatchObject({ state: 'paused', error: { step: 'check' } });
    const swapped = await h.service.setNodeBot(draft.runId, OWNER, 'write', { larkAppId: REVIEW });
    expect(swapped.template).toMatchObject({ needsConfirmation: true, swapped: true });
    expect(await code(h.service.continueLaunch(draft.runId, OWNER))).toBe('flow_changed');
    await h.service.approveFlow(draft.runId, OWNER, { flowSummarySha256: swapped.flow!.flowSummarySha256 });
    await h.service.continueLaunch(draft.runId, OWNER);
    expect((await settled(h.service, draft.runId)).phase).toBe('started');
    const run = (readRunEnvelope(join(base, draft.runId), draft.runId) as any).envelope;
    expect(run.source.kind).toBe('ad_hoc');
    expect(launch.granted(launch.onlyChat().chatId, MAIN).some((id) => id.endsWith(REVIEW))).toBe(true);
  });

  it('two tabs saving the same dialog at once land on one template', async () => {
    const { h } = setup();
    seedFinishedRun('src-261101-080000-000-cccc0005');
    const save = () => h.service.saveRunAsTemplate('src-261101-080000-000-cccc0005', OWNER, { requestKey: 'req-same-dialog' });
    const [a, b] = await Promise.all([save(), save()]);
    expect(a.workflowId).toBe(b.workflowId);
    expect([a.created, b.created].sort()).toEqual([false, true]);
    expect(readdirSync(join(library, 'workflow-library')).filter((name) => name.startsWith('wf_'))).toEqual([a.workflowId]);
  });
});

describe('模板在准备运行与拉群之间变了', () => {
  it('archived meanwhile: the launch stops before run.json; a newer publish still runs the pinned version', async () => {
    const { h, launch } = setup();
    const saved = await templateFromRun(h, '0006');
    const draft = await h.service.createFromTemplate(OWNER, { workflowId: saved.workflowId });
    // Archive by hand (the Dashboard has no archive entry; the owner's CLI does).
    const metadataPath = savedWorkflowMetadataPath(library, saved.workflowId);
    const metadata = await readSavedWorkflowMetadata(library, saved.workflowId);
    writeFileSync(metadataPath, `${canonicalJsonStringify({ ...metadata, status: 'archived' })}\n`);
    await h.service.launch(draft.runId, OWNER, {});
    const stopped = await settled(h.service, draft.runId);
    expect(stopped.launch).toMatchObject({ state: 'paused', error: { step: 'commit', code: 'template_unavailable' } });
    expect(readRunEnvelope(join(base, draft.runId), draft.runId).kind).toBe('missing');
    writeFileSync(metadataPath, `${canonicalJsonStringify(metadata)}\n`);
    await h.service.continueLaunch(draft.runId, OWNER);
    expect((await settled(h.service, draft.runId)).phase).toBe('started');
    expect((readRunEnvelope(join(base, draft.runId), draft.runId) as any).envelope.source.revisionId).toBe(saved.revisionId);
    expect(launch.starts).toEqual([draft.runId]);
  });

  it('a form built from an older version is refused, not run silently', async () => {
    const { h } = setup();
    const saved = await templateFromRun(h, '0007');
    expect(await code(h.service.createFromTemplate(OWNER, { workflowId: saved.workflowId, expectedRevisionId: `rev_${'0'.repeat(64)}` }))).toBe('save_conflict');
    expect(readdirSync(base).filter((name) => !name.startsWith('src-'))).toEqual([]);
  });
});
