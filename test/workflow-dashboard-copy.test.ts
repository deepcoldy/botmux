/**
 * 基于历史创建 (design 2026-11-03 workflow-dashboard-orchestration §6, D6),
 * daemon side: the real draft service, run.json / journal / runtime
 * revisions, the Saved Workflow store and the real launch commit, on real
 * dirs. Fakes: Feishu (fakeLaunch), the clarify session, the Architect worker.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { WorkflowDraftError, WorkflowDraftService } from '../src/workflows/v3/draft-service.js';
import { readRunEnvelope } from '../src/workflows/v3/run-envelope.js';
import { listSavedWorkflowRevisions, loadCurrentSavedWorkflow } from '../src/workflows/v3/library-store.js';
import { listWorkflowDrafts } from '../src/workflows/v3/draft-store.js';
import {
  ALICE, BOTS, DOC, MAIN, OWNER, PI, SKETCHES, STEWARD,
  architectSettled, goalNode, makeService, specMarkdown,
} from './helpers/workflow-draft-fakes.js';
import { fakeLaunch } from './helpers/workflow-launch-fakes.js';
import { REVIEW, seedRun, treeDigest } from './helpers/workflow-copy-fakes.js';
import { publishRunEnvelopeOnce, makeAdHocRunEnvelope, artifactRef } from '../src/workflows/v3/run-envelope.js';
import { appendEvent } from '../src/workflows/v3/journal.js';

const FLEET = [...BOTS, { larkAppId: REVIEW, larkAppSecret: 's-rv', name: 'review', cliId: 'claude-code' }] as any[];
const ONLINE = [MAIN, DOC, REVIEW, STEWARD, PI];

let root: string;
let base: string;
let library: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'wf-copy-'));
  base = join(root, 'v3-runs');
  library = join(root, 'data');
  mkdirSync(base);
  mkdirSync(library);
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

async function code(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof WorkflowDraftError) return error.code;
    throw error;
  }
  return 'ok';
}

async function refusal(promise: Promise<unknown>): Promise<WorkflowDraftError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof WorkflowDraftError) return error;
    throw error;
  }
  throw new Error('expected a refusal');
}

function setup() {
  const launch = fakeLaunch(base);
  launch.setOnline(ONLINE);
  const h = makeService(base, { loadBots: () => FLEET, launch: launch.deps, libraryDataDir: library });
  h.setOnline(ONLINE);
  return { h, launch };
}

/** A draft through the Architect, confirmed, saved as a template by `initiator`. */
async function savedTemplate(h: ReturnType<typeof makeService>, opts: { initiator?: typeof OWNER; paramEdits?: unknown[] } = {}) {
  const initiator = opts.initiator ?? OWNER;
  const created = await h.service.create(initiator, { goal: '帮我出一份代码风险报告' });
  h.clarify.reply(`好的。\n<botmux-spec>\n${specMarkdown(SKETCHES)}\n</botmux-spec>`);
  await h.service.finalizeSpec(created.runId, initiator, {});
  await h.service.approveSpec(created.runId, initiator);
  await h.service.startArchitect(created.runId, initiator);
  await architectSettled(h.service, created.runId);
  const view = await h.service.view(created.runId);
  await h.service.approveFlow(created.runId, initiator, { flowSummarySha256: view.flow!.flowSummarySha256 });
  const preview = await h.service.previewTemplateSave(created.runId, initiator, { ...(opts.paramEdits ? { paramEdits: opts.paramEdits } : {}) });
  return h.service.saveAsTemplate(created.runId, initiator, {
    flowSummarySha256: preview.flowSummarySha256,
    requestKey: `req-${created.runId.slice(-8)}`,
    ...(opts.paramEdits ? { paramEdits: opts.paramEdits } : {}),
  });
}

/** A template run started through 拉群开始 (a real saved_definition run). */
async function startedTemplateRun(h: ReturnType<typeof makeService>, workflowId: string, params: Record<string, string>): Promise<string> {
  const draft = await h.service.createFromTemplate(OWNER, { workflowId, params });
  if (draft.template!.needsConfirmation) await h.service.approveFlow(draft.runId, OWNER, { flowSummarySha256: draft.flow!.flowSummarySha256 });
  await h.service.launch(draft.runId, OWNER, {});
  expect((await settled(h.service, draft.runId)).phase).toBe('started');
  return draft.runId;
}

async function settled(service: WorkflowDraftService, runId: string) {
  for (let i = 0; i < 400; i++) {
    const view = await service.view(runId);
    if (view.launch && !view.launch.running) return view;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`launch of ${runId} did not settle`);
}

const nodeBots = (nodes: Array<{ id: string; bot?: string }>) => Object.fromEntries(nodes.map((node) => [node.id, node.bot]));

describe('从运行复制（§6）', () => {
  it('a finished run: the final effective flow and the bots that ran it, at 待确认需求 with no session; the source untouched', async () => {
    const { h } = setup();
    const runDir = seedRun(base, 'src-261101-080000-000-aaaa0001', { revised: true, reassign: { nodeId: 'write', from: DOC, to: REVIEW } });
    const before = treeDigest(runDir);
    const draft = await h.service.createFromSource(ALICE, { source: { kind: 'run', runId: 'src-261101-080000-000-aaaa0001' } });
    expect(draft).toMatchObject({ phase: 'spec_ready', initiator: ALICE, orchestratorAppId: MAIN });
    expect(draft.copy).toMatchObject({
      source: { kind: 'run', runId: 'src-261101-080000-000-aaaa0001', unfinished: false, runStatus: 'succeeded', runtimeRevisions: 1 },
      prefilled: true,
    });
    // Revision 2 is in; the reassigned node carries the bot that ran it.
    expect(nodeBots(draft.copy!.prefillDag!.nodes)).toEqual({ inspect: MAIN, write: REVIEW, review: REVIEW });
    expect(draft.copy!.prefillDag!.runId).toBe(draft.runId);
    expect((draft.spec!.json as any)).toMatchObject({ runId: draft.runId, title: '代码风险报告', requirement: '出报告' });
    // No clarify session is copied; nothing was asked of the clarifier.
    expect(h.clarify.sessions.size).toBe(0);
    expect(draft.clarify).toMatchObject({ state: 'disconnected', pending: false });
    expect(treeDigest(runDir)).toEqual(before);
    // Listed with where it came from.
    expect(listWorkflowDrafts(base).find((item) => item.runId === draft.runId)?.copiedFrom)
      .toEqual({ kind: 'run', runId: 'src-261101-080000-000-aaaa0001', unfinished: false });
  });

  it('an unfinished run: the flow as of now (applied revision in, pending proposal out), marked as such; the source untouched', async () => {
    const { h } = setup();
    const runDir = seedRun(base, 'src-261101-080000-000-aaaa0002', { status: 'running', revised: true, pending: true });
    const before = treeDigest(runDir);
    const draft = await h.service.createFromSource(OWNER, { source: { kind: 'run', runId: 'src-261101-080000-000-aaaa0002' } });
    expect(draft.copy!.source).toMatchObject({ kind: 'run', unfinished: true, runStatus: 'running', runtimeRevisions: 1 });
    expect(draft.copy!.prefillDag!.nodes.map((node) => node.id)).toEqual(['inspect', 'write', 'review']);
    expect(draft.clarify.turns[0]!.text).toContain('尚未结束');
    // Confirming and editing the copy never reaches back into the source.
    await h.service.approveSpec(draft.runId, OWNER);
    expect(treeDigest(runDir)).toEqual(before);
  });

  it('确认需求 uses the copied flow — no Architect — and both confirmations are still needed; it commits as an ad-hoc run', async () => {
    const { h, launch } = setup();
    seedRun(base, 'src-261101-080000-000-aaaa0003', { revised: true });
    const draft = await h.service.createFromSource(OWNER, { source: { kind: 'run', runId: 'src-261101-080000-000-aaaa0003' } });
    // The first confirmation is not skipped.
    expect(await code(h.service.approveFlow(draft.runId, OWNER, { flowSummarySha256: `sha256:${'0'.repeat(64)}` }))).toBe('state_conflict');
    const approved = await h.service.approveSpec(draft.runId, OWNER);
    expect(approved.phase).toBe('dag_ready');
    expect(h.architect.calls).toHaveLength(0);
    expect(approved.specConfirmation?.confirmedByOpenId).toBe(OWNER.openId);
    expect(nodeBots(approved.flow!.dag.nodes)).toEqual({ inspect: MAIN, write: DOC, review: REVIEW });
    // Nor is the second.
    expect(await code(h.service.launch(draft.runId, OWNER, {}))).toBe('flow_changed');
    await h.service.approveFlow(draft.runId, OWNER, { flowSummarySha256: approved.flow!.flowSummarySha256 });
    await h.service.launch(draft.runId, OWNER, {});
    expect((await settled(h.service, draft.runId)).phase).toBe('started');
    const run = (readRunEnvelope(join(base, draft.runId), draft.runId) as any).envelope;
    expect(run.source.kind).toBe('ad_hoc');
    expect(run.authorization.kind).toBe('gate2');
    expect(run.authorization.flowConfirmation.confirmedByOpenId).toBe(OWNER.openId);
    expect(launch.starts).toEqual([draft.runId]);
  });

  it('someone else\'s run: the copier is the initiator; the source owner cannot write to the copy', async () => {
    const { h } = setup();
    seedRun(base, 'src-261101-080000-000-aaaa0004', { ownerOpenId: OWNER.openId });
    const draft = await h.service.createFromSource(ALICE, { source: { kind: 'run', runId: 'src-261101-080000-000-aaaa0004' } });
    expect(draft.initiator).toEqual(ALICE);
    expect(await code(h.service.approveSpec(draft.runId, OWNER))).toBe('not_initiator');
    expect((await h.service.approveSpec(draft.runId, ALICE)).phase).toBe('dag_ready');
  });

  it('a node bot that cannot run in the planned group does not block the copy: marked, swapped at 待确认流程, 确认流程 waits for it', async () => {
    const { h } = setup();
    seedRun(base, 'src-261101-080000-000-aaaa0005');
    // DOC ran `write`; its daemon is offline now.
    h.setOnline([MAIN, REVIEW]);
    const draft = await h.service.createFromSource(OWNER, { source: { kind: 'run', runId: 'src-261101-080000-000-aaaa0005' } });
    expect(draft.copy!.needsBot).toEqual([{ nodeId: 'write', larkAppId: DOC, why: expect.any(String), resolved: false }]);
    expect(nodeBots(draft.copy!.prefillDag!.nodes)).toEqual({ inspect: MAIN, write: DOC });
    const flow = await h.service.approveSpec(draft.runId, OWNER);
    expect(flow.phase).toBe('dag_ready');
    const refused = await refusal(h.service.approveFlow(draft.runId, OWNER, { flowSummarySha256: flow.flow!.flowSummarySha256 }));
    expect(refused.code).toBe('bot_not_on_roster');
    expect(refused.details.nodes).toEqual([{ nodeId: 'write', larkAppId: DOC, why: expect.any(String) }]);
    const swapped = await h.service.setNodeBot(draft.runId, OWNER, 'write', { larkAppId: REVIEW });
    expect(swapped.copy!.needsBot![0]!.resolved).toBe(true);
    await h.service.approveFlow(draft.runId, OWNER, { flowSummarySha256: swapped.flow!.flowSummarySha256 });
    expect((await h.service.view(draft.runId)).phase).toBe('flow_confirmed');
  });

  it('two nodes waiting for a new bot: swapping one is not refused because of the other', async () => {
    const { h } = setup();
    seedRun(base, 'src-261101-080000-000-aaaa0009', { reassign: { nodeId: 'inspect', from: MAIN, to: DOC } });
    h.setOnline([MAIN, REVIEW]);
    const draft = await h.service.createFromSource(OWNER, { source: { kind: 'run', runId: 'src-261101-080000-000-aaaa0009' } });
    expect(draft.copy!.needsBot!.map((item) => item.nodeId).sort()).toEqual(['inspect', 'write']);
    await h.service.approveSpec(draft.runId, OWNER);
    const one = await h.service.setNodeBot(draft.runId, OWNER, 'write', { larkAppId: REVIEW });
    expect(one.copy!.needsBot!.find((item) => item.nodeId === 'write')!.resolved).toBe(true);
    expect(await code(h.service.approveFlow(draft.runId, OWNER, { flowSummarySha256: one.flow!.flowSummarySha256 }))).toBe('bot_not_on_roster');
    const both = await h.service.setNodeBot(draft.runId, OWNER, 'inspect', { larkAppId: MAIN });
    expect((await h.service.approveFlow(draft.runId, OWNER, { flowSummarySha256: both.flow!.flowSummarySha256 })).phase).toBe('flow_confirmed');
  });

  it('a bot no longer in bots.json: the node waits on the orchestrating bot, marked; the flow is still shown and swappable', async () => {
    const { h } = setup();
    seedRun(base, 'src-261101-080000-000-aaaa0008');
    const gone = makeService(base, { loadBots: () => FLEET.filter((bot) => bot.larkAppId !== DOC), libraryDataDir: library });
    gone.setOnline([MAIN, REVIEW]);
    const draft = await gone.service.createFromSource(OWNER, { source: { kind: 'run', runId: 'src-261101-080000-000-aaaa0008' } });
    expect(draft.copy!.needsBot).toEqual([{ nodeId: 'write', larkAppId: DOC, why: '已不在本机 bots.json 里', placeholder: true, resolved: false }]);
    expect(nodeBots(draft.copy!.prefillDag!.nodes)).toEqual({ inspect: MAIN, write: MAIN });
    const flow = await gone.service.approveSpec(draft.runId, OWNER);
    expect(flow.flow).toBeDefined();
    // On the orchestrating bot only for now: still not confirmable as is.
    expect(await code(gone.service.approveFlow(draft.runId, OWNER, { flowSummarySha256: flow.flow!.flowSummarySha256 }))).toBe('bot_not_on_roster');
    const swapped = await gone.service.setNodeBot(draft.runId, OWNER, 'write', { larkAppId: REVIEW });
    expect((await gone.service.approveFlow(draft.runId, OWNER, { flowSummarySha256: swapped.flow!.flowSummarySha256 })).phase).toBe('flow_confirmed');
    void h;
  });

  it('a structurally invalid copy is still refused before anything is written', async () => {
    const { h } = setup();
    const runDir = seedRun(base, 'src-261101-080000-000-aaaa0006');
    // A template run whose parameter value empties a node goal: the copy's
    // DAG would not validate.
    void runDir;
    const saved = await savedTemplate(h, { paramEdits: [{ name: 'focus', type: 'string', nodeId: 'inspect', field: 'goal', text: 'inspect' }] });
    const templateRun = await startedTemplateRun(h, saved.workflowId, { focus: ' ' });
    const refused = await refusal(h.service.createFromSource(OWNER, { source: { kind: 'run', runId: templateRun } }));
    expect(refused.code).toBe('dag_invalid');
    const before = readdirSync(base).length;
    await code(h.service.createFromSource(OWNER, { source: { kind: 'run', runId: templateRun } }));
    expect(readdirSync(base).length).toBe(before);
  });

  it('only a known run; the orchestrator defaults to the source\'s and must be this daemon\'s', async () => {
    const { h } = setup();
    expect(await code(h.service.createFromSource(OWNER, { source: { kind: 'run', runId: 'nope-261101-080000-000-aaaa0009' } }))).toBe('unknown_run');
    expect(await code(h.service.createFromSource(OWNER, { source: { kind: 'run' } }))).toBe('bad_request');
    seedRun(base, 'src-261101-080000-000-aaaa0007');
    expect(await code(h.service.createFromSource(OWNER, { source: { kind: 'run', runId: 'src-261101-080000-000-aaaa0007' }, larkAppId: DOC }))).toBe('bot_mismatch');
    // Another bot's daemon asked without a larkAppId: not its source.
    const other = new WorkflowDraftService({ ...h.deps, appId: DOC });
    expect(await code(other.createFromSource(OWNER, { source: { kind: 'run', runId: 'src-261101-080000-000-aaaa0007' } }))).toBe('bot_mismatch');
    // ...but it may orchestrate a copy when it is chosen.
    const chosen = await other.createFromSource(OWNER, { source: { kind: 'run', runId: 'src-261101-080000-000-aaaa0007' }, larkAppId: DOC });
    expect(chosen.orchestratorAppId).toBe(DOC);
  });
});

describe('从模板版本复制（§6）', () => {
  const edits = [{ name: 'focus', type: 'string', nodeId: 'inspect', field: 'goal', text: 'inspect' }];

  it('any version, parameters kept as parameters; 拉群开始 refuses the markers, 存为模板 declares them again', async () => {
    const { h } = setup();
    const saved = await savedTemplate(h, { paramEdits: edits });
    const draft = await h.service.createFromSource(ALICE, { source: { kind: 'template', workflowId: saved.workflowId, revisionId: saved.revisionId } });
    expect(draft.copy).toMatchObject({
      source: { kind: 'template', workflowId: saved.workflowId, revisionId: saved.revisionId, humanVersion: 1, ownerOpenId: OWNER.openId, orchestratorAppId: MAIN },
      inputs: { focus: { type: 'string', required: true } },
      unresolved: { params: ['focus'], context: [] },
    });
    expect(draft.copy!.prefillDag!.nodes.find((node) => node.id === 'inspect')!.goal).toBe('${params.focus}');
    // The bots the template names.
    expect(nodeBots(draft.copy!.prefillDag!.nodes)).toEqual({ inspect: MAIN, write: DOC });
    const flow = await h.service.approveSpec(draft.runId, ALICE);
    await h.service.approveFlow(draft.runId, ALICE, { flowSummarySha256: flow.flow!.flowSummarySha256 });
    const refused = await refusal(h.service.launch(draft.runId, ALICE, {}));
    expect(refused.code).toBe('unresolved_params');
    expect(refused.details).toMatchObject({ params: ['focus'] });
    // Saved as a new template of the copier: the parameter is declared again.
    const preview = await h.service.previewTemplateSave(draft.runId, ALICE, {});
    expect(preview.inputs).toEqual({ focus: { type: 'string', required: true } });
    const copy = await h.service.saveAsTemplate(draft.runId, ALICE, { flowSummarySha256: preview.flowSummarySha256, requestKey: 'req-copy-0001' });
    expect(copy.created).toBe(true);
    const stored = await loadCurrentSavedWorkflow(library, copy.workflowId);
    expect(stored.metadata.owner.openId).toBe(ALICE.openId);
    expect(stored.revision.payload.inputs).toEqual({ focus: { type: 'string', required: true } });
  });

  it('replacing the markers with text (改节点文字) makes it launchable', async () => {
    const { h } = setup();
    const saved = await savedTemplate(h, { paramEdits: edits });
    const draft = await h.service.createFromSource(OWNER, { source: { kind: 'template', workflowId: saved.workflowId, revisionId: saved.revisionId } });
    await h.service.approveSpec(draft.runId, OWNER);
    const edited = await h.service.setNodeText(draft.runId, OWNER, 'inspect', { goal: '看 auth 模块的改动' });
    expect(edited.copy!.unresolved).toBeUndefined();
    await h.service.approveFlow(draft.runId, OWNER, { flowSummarySha256: edited.flow!.flowSummarySha256 });
    await h.service.launch(draft.runId, OWNER, {});
    expect((await settled(h.service, draft.runId)).phase).toBe('started');
  });

  it('追加为新版本 only to one\'s own template (I9): the owner may, someone else is refused', async () => {
    const { h } = setup();
    const saved = await savedTemplate(h);
    const source = { kind: 'template', workflowId: saved.workflowId, revisionId: saved.revisionId };
    const confirmedCopy = async (initiator: typeof OWNER) => {
      const draft = await h.service.createFromSource(initiator, { source });
      const flow = await h.service.approveSpec(draft.runId, initiator);
      await h.service.setNodeText(draft.runId, initiator, 'write', { completion: '列出每个风险的修法' });
      const view = await h.service.view(draft.runId);
      await h.service.approveFlow(draft.runId, initiator, { flowSummarySha256: view.flow!.flowSummarySha256 });
      void flow;
      return draft.runId;
    };
    const aliceCopy = await confirmedCopy(ALICE);
    expect(await code(h.service.previewTemplateSave(aliceCopy, ALICE, { workflowId: saved.workflowId }))).toBe('not_owner');
    const preview = await h.service.previewTemplateSave(aliceCopy, ALICE, {});
    expect(await code(h.service.saveAsTemplate(aliceCopy, ALICE, {
      flowSummarySha256: preview.flowSummarySha256, workflowId: saved.workflowId, expectedLatestRevision: saved.revisionId,
    }))).toBe('not_owner');
    expect(await listSavedWorkflowRevisions(library, saved.workflowId)).toHaveLength(1);

    const ownerCopy = await confirmedCopy(OWNER);
    const ownerPreview = await h.service.previewTemplateSave(ownerCopy, OWNER, { workflowId: saved.workflowId });
    const appended = await h.service.saveAsTemplate(ownerCopy, OWNER, {
      flowSummarySha256: ownerPreview.flowSummarySha256, workflowId: saved.workflowId, expectedLatestRevision: ownerPreview.target!.latestRevision,
    });
    expect(appended).toMatchObject({ workflowId: saved.workflowId, humanVersion: 2, created: false });
  });

  it('an unknown template or version', async () => {
    const { h } = setup();
    const saved = await savedTemplate(h);
    expect(await code(h.service.createFromSource(OWNER, { source: { kind: 'template', workflowId: `wf_${'1'.repeat(32)}`, revisionId: saved.revisionId } }))).toBe('template_not_found');
    expect(await code(h.service.createFromSource(OWNER, { source: { kind: 'template', workflowId: saved.workflowId, revisionId: `rev_${'2'.repeat(64)}` } }))).toBe('template_not_found');
  });
});

describe('复制后改什么（§6）', () => {
  async function copied(h: ReturnType<typeof makeService>) {
    seedRun(base, 'src-261101-080000-000-aaaa0011', { revised: true });
    return h.service.createFromSource(OWNER, { source: { kind: 'run', runId: 'src-261101-080000-000-aaaa0011' } });
  }

  it('改目标「只改文字」: the requirement changes, the copied flow stays — no Architect', async () => {
    const { h } = setup();
    const draft = await copied(h);
    const edited = await h.service.editCopyGoal(draft.runId, OWNER, { goal: '出一份只看安全问题的报告', mode: 'text_only' });
    expect(edited.phase).toBe('spec_ready');
    expect((edited.spec!.json as any).requirement).toBe('出一份只看安全问题的报告');
    expect(edited.copy).toMatchObject({ prefilled: true });
    expect(edited.copy!.goalEditedAt).toBeTruthy();
    const approved = await h.service.approveSpec(draft.runId, OWNER);
    expect(approved.phase).toBe('dag_ready');
    expect(h.architect.calls).toHaveLength(0);
    expect(approved.flow!.dag.nodes.map((node) => node.id)).toEqual(['inspect', 'write', 'review']);
  });

  it('改目标「按新目标重新编排」: straight to the Architect, or back to clarifying with a new session', async () => {
    const { h } = setup();
    const draft = await copied(h);
    const re = await h.service.editCopyGoal(draft.runId, OWNER, { goal: '重新规划成两步', mode: 'rearchitect' });
    expect(re.copy!.prefilled).toBe(false);
    const approved = await h.service.approveSpec(draft.runId, OWNER);
    expect(approved.phase).toBe('awaiting_architect');
    await h.service.startArchitect(draft.runId, OWNER);
    await architectSettled(h.service, draft.runId);
    expect(h.architect.calls).toHaveLength(1);
    expect((await h.service.view(draft.runId)).flow!.dag.nodes.map((node) => node.id)).toEqual(['inspect', 'write']);

    const other = await h.service.createFromSource(OWNER, { source: { kind: 'run', runId: 'src-261101-080000-000-aaaa0011' } });
    const clarifying = await h.service.editCopyGoal(other.runId, OWNER, { goal: '改成发周报', mode: 'reclarify' });
    expect(clarifying).toMatchObject({ phase: 'clarifying', goal: '改成发周报', clarify: { state: 'active', pending: true } });
    expect(clarifying.copy!.prefilled).toBe(false);
    const session = [...h.clarify.sessions.values()].at(-1)!;
    expect(session.prompts[0]).toContain('改成发周报');
    expect(session.prompts[0]).toContain('复制来的 spec');
    // From here it is an ordinary draft: a new spec, 确认需求 → Architect.
    h.clarify.reply(`好的。\n<botmux-spec>\n${specMarkdown(SKETCHES)}\n</botmux-spec>`);
    expect((await h.service.finalizeSpec(other.runId, OWNER, {})).ok).toBe(true);
    expect((await h.service.approveSpec(other.runId, OWNER)).phase).toBe('awaiting_architect');
  });

  it('退回改需求 drops the copied flow: the next 确认需求 orchestrates anew', async () => {
    const { h } = setup();
    const draft = await copied(h);
    await h.service.approveSpec(draft.runId, OWNER);
    const back = await h.service.reviseSpec(draft.runId, OWNER);
    expect(back.phase).toBe('clarifying');
    expect(back.copy!.prefilled).toBe(false);
    // No session yet: 「继续」 starts one with the spec so far.
    await h.service.continueClarify(draft.runId, OWNER);
    expect(h.clarify.sessions.size).toBe(1);
    h.clarify.reply(`好的。\n<botmux-spec>\n${specMarkdown(SKETCHES)}\n</botmux-spec>`);
    expect((await h.service.finalizeSpec(draft.runId, OWNER, {})).ok).toBe(true);
    expect((await h.service.approveSpec(draft.runId, OWNER)).phase).toBe('awaiting_architect');
  });

  it('改节点文字 voids the second confirmation; only on a copy, only at 待确认流程', async () => {
    const { h } = setup();
    const draft = await copied(h);
    expect(await code(h.service.setNodeText(draft.runId, OWNER, 'write', { goal: 'x' }))).toBe('state_conflict');
    const flow = await h.service.approveSpec(draft.runId, OWNER);
    await h.service.approveFlow(draft.runId, OWNER, { flowSummarySha256: flow.flow!.flowSummarySha256 });
    const edited = await h.service.setNodeText(draft.runId, OWNER, 'write', { goal: '写报告，按严重程度排序', completion: '每条风险给出修法' });
    expect(edited.phase).toBe('dag_ready');
    expect(edited.flowConfirmation).toBeUndefined();
    const node = edited.flow!.dag.nodes.find((item) => item.id === 'write')!;
    expect(node).toMatchObject({ goal: '写报告，按严重程度排序', override: { systemPromptAppend: '每条风险给出修法' } });
    const cleared = await h.service.setNodeText(draft.runId, OWNER, 'write', { completion: '' });
    expect(cleared.flow!.dag.nodes.find((item) => item.id === 'write')!.override).toBeUndefined();
    expect(await code(h.service.setNodeText(draft.runId, OWNER, 'nope', { goal: 'x' }))).toBe('unknown_node');
    expect(await code(h.service.setNodeText(draft.runId, ALICE, 'write', { goal: 'x' }))).toBe('not_initiator');
    // Past 待确认需求 the goal is not edited in place: nothing moves, nothing is written.
    const specBefore = (await h.service.view(draft.runId)).spec!.markdown;
    expect(await code(h.service.editCopyGoal(draft.runId, OWNER, { goal: 'x', mode: 'text_only' }))).toBe('state_conflict');
    expect(await code(h.service.editCopyGoal(draft.runId, OWNER, { goal: 'x', mode: 'reclarify' }))).toBe('state_conflict');
    const after = await h.service.view(draft.runId);
    expect(after.phase).toBe('dag_ready');
    expect(after.spec!.markdown).toBe(specBefore);

    // An ordinary draft is not a copy.
    const plain = await h.service.create(OWNER, { goal: '普通草稿' });
    expect(await code(h.service.editCopyGoal(plain.runId, OWNER, { goal: 'x', mode: 'text_only' }))).toBe('not_a_copy');
    expect(await code(h.service.setNodeText(plain.runId, OWNER, 'inspect', { goal: 'x' }))).toBe('not_a_copy');
  });

  it('a copied flow file changed behind the draft\'s back is not used', async () => {
    const { h } = setup();
    const draft = await copied(h);
    const path = join(base, draft.runId, 'copy.dag.json');
    // Still a valid DAG — only the digest tells.
    writeFileSync(path, readFileSync(path, 'utf-8').replace('"goal": "write"', '"goal": "删掉仓库"'));
    expect(await code(h.service.approveSpec(draft.runId, OWNER))).toBe('dag_invalid');
    const view = await h.service.view(draft.runId);
    expect(view.phase).toBe('spec_ready');
    expect(view.specConfirmation).toBeUndefined();
    expect(existsSync(join(base, draft.runId, 'dag.json'))).toBe(false);
  });
});

describe('复核修复（D6）', () => {
  const draftJson = (runId: string) => JSON.parse(readFileSync(join(base, runId, 'draft.json'), 'utf-8'));
  const edits = [{ name: 'focus', type: 'string', nodeId: 'inspect', field: 'goal', text: 'inspect' }];

  it('a run started from a template is copied as it ran: its parameter values are in, nothing left to resolve — it launches and saves', async () => {
    const { h } = setup();
    const saved = await savedTemplate(h, { paramEdits: edits });
    const templateRun = await startedTemplateRun(h, saved.workflowId, { focus: '看 auth 模块' });
    expect(readFileSync(join(base, templateRun, 'dag.json'), 'utf-8')).toContain('${params.focus}');
    const draft = await h.service.createFromSource(ALICE, { source: { kind: 'run', runId: templateRun } });
    expect(draft.copy!.unresolved).toBeUndefined();
    expect(draft.copy!.inputs).toBeUndefined();
    expect(draft.copy!.prefillDag!.nodes.find((node) => node.id === 'inspect')!.goal).toBe('看 auth 模块');
    const flow = await h.service.approveSpec(draft.runId, ALICE);
    await h.service.approveFlow(draft.runId, ALICE, { flowSummarySha256: flow.flow!.flowSummarySha256 });
    // 存模板 works (no undeclared parameter)...
    const preview = await h.service.previewTemplateSave(draft.runId, ALICE, {});
    expect(preview.inputs).toEqual({});
    await h.service.saveAsTemplate(draft.runId, ALICE, { flowSummarySha256: preview.flowSummarySha256, requestKey: 'req-tr-00001' });
    // ...and so does 拉群开始.
    await h.service.launch(draft.runId, ALICE, {});
    expect((await settled(h.service, draft.runId)).phase).toBe('started');
  });

  it('a host node input `$ref: params.x` takes the value itself', async () => {
    const { substituteParams } = await import('../src/workflows/v3/draft-copy.js');
    expect(substituteParams({ input: { to: { $ref: 'params.target' }, text: '发给 ${params.target}，${params.n} 份' } }, { target: ['a', 'b'], n: 3 }))
      .toEqual({ input: { to: ['a', 'b'], text: '发给 ["a","b"]，3 份' } });
    expect(substituteParams('保留 ${params.missing} 与 ${context.chatId}', {})).toBe('保留 ${params.missing} 与 ${context.chatId}');
  });

  it('a requirement changed after the copy (a hand-edited spec): 确认需求 orchestrates anew, and the page is told beforehand', async () => {
    const { h } = setup();
    seedRun(base, 'src-261101-080000-000-aaaa0021', { revised: true });
    const draft = await h.service.createFromSource(OWNER, { source: { kind: 'run', runId: 'src-261101-080000-000-aaaa0021' } });
    const finalized = await h.service.finalizeSpec(draft.runId, OWNER, { specMarkdown: specMarkdown(SKETCHES, { title: '完全不同的周报' }) });
    expect(finalized.ok).toBe(true);
    expect(finalized.draft.copy).toMatchObject({ prefilled: false, prefillStale: true });
    // 「只改文字」 afterwards does not bring the copied flow back.
    await h.service.editCopyGoal(draft.runId, OWNER, { goal: '再改一下目标', mode: 'text_only' });
    expect(draftJson(draft.runId).copy.prefill).toBeUndefined();
    const approved = await h.service.approveSpec(draft.runId, OWNER);
    expect(approved.phase).toBe('awaiting_architect');
    expect(draftJson(draft.runId).copy.prefill).toBeUndefined();
  });

  it('「只改文字」 moves the pin: the copied flow is still used', async () => {
    const { h } = setup();
    seedRun(base, 'src-261101-080000-000-aaaa0022', { revised: true });
    const draft = await h.service.createFromSource(OWNER, { source: { kind: 'run', runId: 'src-261101-080000-000-aaaa0022' } });
    const before = draftJson(draft.runId).copy.prefill.specSha256;
    await h.service.editCopyGoal(draft.runId, OWNER, { goal: '只看安全', mode: 'text_only' });
    expect(draftJson(draft.runId).copy.prefill.specSha256).not.toBe(before);
    expect((await h.service.approveSpec(draft.runId, OWNER)).phase).toBe('dag_ready');
  });

  it('a goal with a fenced block: 改目标 still works (the narrative does not read as a second spec block)', async () => {
    const { h } = setup();
    seedRun(base, 'src-261101-080000-000-aaaa0023');
    const draft = await h.service.createFromSource(OWNER, { source: { kind: 'run', runId: 'src-261101-080000-000-aaaa0023' } });
    const goal = '按这个格式出：\n```json\n{"a":1}\n```';
    const edited = await h.service.editCopyGoal(draft.runId, OWNER, { goal, mode: 'text_only' });
    expect((edited.spec!.json as any).requirement).toBe(goal);
  });

  it('a refused 按新目标重新编排 keeps the copied flow (both ways)', async () => {
    const { h } = setup();
    seedRun(base, 'src-261101-080000-000-aaaa0024');
    const draft = await h.service.createFromSource(OWNER, { source: { kind: 'run', runId: 'src-261101-080000-000-aaaa0024' } });
    const runDir = join(base, draft.runId);
    // A requirement that does not validate is refused before anything moves.
    const specPath = join(runDir, 'spec.json');
    const good = readFileSync(specPath, 'utf-8');
    writeFileSync(specPath, JSON.stringify({ ...JSON.parse(good), nodes: [] }));
    expect(await code(h.service.editCopyGoal(draft.runId, OWNER, { goal: '新目标', mode: 'rearchitect' }))).toBe('dag_invalid');
    writeFileSync(specPath, good);
    expect(draftJson(draft.runId).copy.prefill).toBeDefined();
    // The grill cannot be written (its temp file is blocked): the step that
    // moves it fails, for either way — the record keeps the copied flow.
    const blocked = join(runDir, 'grill.state.json.tmp');
    mkdirSync(blocked);
    for (const mode of ['rearchitect', 'reclarify'] as const) {
      await expect(h.service.editCopyGoal(draft.runId, OWNER, { goal: '新目标', mode })).rejects.toThrow();
      expect(draftJson(draft.runId).copy.prefill).toBeDefined();
    }
    rmSync(blocked, { recursive: true });
  });

  it('退回改需求 and 「按新目标重新编排 → 先澄清」 remove the copied flow from the record', async () => {
    const { h } = setup();
    seedRun(base, 'src-261101-080000-000-aaaa0025');
    const a = await h.service.createFromSource(OWNER, { source: { kind: 'run', runId: 'src-261101-080000-000-aaaa0025' } });
    await h.service.reviseSpec(a.runId, OWNER);
    expect(draftJson(a.runId).copy.prefill).toBeUndefined();
    const b = await h.service.createFromSource(OWNER, { source: { kind: 'run', runId: 'src-261101-080000-000-aaaa0025' } });
    await h.service.editCopyGoal(b.runId, OWNER, { goal: '新目标', mode: 'reclarify' });
    expect(draftJson(b.runId).copy.prefill).toBeUndefined();
  });

  it('parameter markers left in the spec alone also stop 拉群开始, and the page is told', async () => {
    const { h } = setup();
    seedRun(base, 'src-261101-080000-000-aaaa0026');
    const draft = await h.service.createFromSource(OWNER, { source: { kind: 'run', runId: 'src-261101-080000-000-aaaa0026' } });
    const spec = JSON.parse(specMarkdown(SKETCHES).match(/```json\n([\s\S]*?)\n```/)![1]!);
    spec.requirement = '出 ${params.focus} 的报告';
    await h.service.finalizeSpec(draft.runId, OWNER, { specMarkdown: `## 需求\n\n\`\`\`json\n${JSON.stringify(spec)}\n\`\`\`` });
    // A changed requirement: orchestrated anew (the Architect keeps the markers out of the DAG).
    await h.service.approveSpec(draft.runId, OWNER);
    await h.service.startArchitect(draft.runId, OWNER);
    await architectSettled(h.service, draft.runId);
    const flow = await h.service.view(draft.runId);
    expect(flow.copy!.unresolved).toEqual({ params: ['focus'], context: [] });
    await h.service.approveFlow(draft.runId, OWNER, { flowSummarySha256: flow.flow!.flowSummarySha256 });
    const refused = await refusal(h.service.launch(draft.runId, OWNER, {}));
    expect(refused.code).toBe('unresolved_params');
    expect(refused.details).toMatchObject({ params: ['focus'] });
  });
});

describe('§5.2 落点闸在 Dashboard 提交点（复制后启动）', () => {
  /** A run whose two nodes are both in the main topic. */
  function seedMainPlacementRun(runId: string, depends: boolean) {
    const runDir = join(base, runId);
    mkdirSync(runDir, { recursive: true });
    const nodes = [
      { id: 'a', type: 'goal', bot: MAIN, placement: 'main', goal: '任务甲', depends: [] as string[], inputs: [] },
      { id: 'b', type: 'goal', bot: DOC, placement: 'main', goal: '任务乙', depends: depends ? ['a'] : [], inputs: [] },
    ];
    writeFileSync(join(runDir, 'dag.json'), JSON.stringify({ schemaVersion: 2, runId, nodes }));
    writeFileSync(join(runDir, 'spec.json'), JSON.stringify({
      schemaVersion: 1, runId, title: '双主话题', requirement: '两个主话题节点',
      nodes: [
        { sketchId: 'a', goal: '任务甲', input_needs: [], expected_outputs: ['a.md'], acceptance: 'x', risk_gate: false, unknowns: [] },
        { sketchId: 'b', goal: '任务乙', input_needs: [], expected_outputs: ['b.md'], acceptance: 'x', risk_gate: false, unknowns: [], assignee: DOC },
      ],
    }));
    writeFileSync(join(runDir, 'bots.snapshot.json'), JSON.stringify({
      [MAIN]: { larkAppId: MAIN, cliId: 'claude-code', workingDir: '/source' },
      [DOC]: { larkAppId: DOC, cliId: 'claude-code', workingDir: '/source' },
    }));
    publishRunEnvelopeOnce(runDir, makeAdHocRunEnvelope({
      runId,
      createdAt: '2026-11-01T08:00:00.000Z',
      authorizedAt: '2026-11-01T08:01:00.000Z',
      chatBinding: { larkAppId: MAIN, chatId: 'oc_src', chatType: 'group', rootMessageId: 'om_src', ownerOpenId: OWNER.openId },
      artifacts: {
        dag: artifactRef(runDir, 'dag.json'),
        spec: artifactRef(runDir, 'spec.json'),
        botSnapshots: artifactRef(runDir, 'bots.snapshot.json'),
      },
    }));
    appendEvent(join(runDir, 'journal.ndjson'), { type: 'runStarted', runId });
    appendEvent(join(runDir, 'journal.ndjson'), { type: 'runSucceeded' });
    return runDir;
  }

  /** Copy → swap b onto the orchestrator → confirm → launch; returns the settled view. */
  async function copiedSwappedAndLaunched(runId: string, launch: ReturnType<typeof fakeLaunch>) {
    const draft = await h!.service.createFromSource(OWNER, { source: { kind: 'run', runId } });
    await h!.service.approveSpec(draft.runId, OWNER);
    const swapped = await h!.service.setNodeBot(draft.runId, OWNER, 'b', { larkAppId: MAIN });
    await h!.service.approveFlow(draft.runId, OWNER, { flowSummarySha256: swapped.flow!.flowSummarySha256 });
    await h!.service.launch(draft.runId, OWNER, {});
    const view = await settled(h!.service, draft.runId);
    return { runId: draft.runId, view };
  }

  let h: ReturnType<typeof makeService> | undefined;
  let launch: ReturnType<typeof fakeLaunch> | undefined;

  it('two same-bot unordered main nodes after a swap: 拉群开始 stops with 硬规则 2, run.json is not written', async () => {
    launch = fakeLaunch(base);
    launch.setOnline(ONLINE);
    h = makeService(base, { loadBots: () => FLEET, launch: launch.deps, libraryDataDir: library });
    h.setOnline(ONLINE);
    seedMainPlacementRun('src-261101-080000-000-dd000001', false);
    const { runId, view } = await copiedSwappedAndLaunched('src-261101-080000-000-dd000001', launch);
    expect(view.phase).not.toBe('started');
    expect(view.launch?.error).toMatchObject({ step: 'commit', code: 'placement_refused', retryable: false });
    expect(view.launch!.error!.message).toContain('硬规则 2');
    expect(existsSync(join(base, runId, 'run.json'))).toBe(false);
  });

  it('the same two nodes ordered by depends: the rule does not fire, the run starts', async () => {
    launch = fakeLaunch(base);
    launch.setOnline(ONLINE);
    h = makeService(base, { loadBots: () => FLEET, launch: launch.deps, libraryDataDir: library });
    h.setOnline(ONLINE);
    seedMainPlacementRun('src-261101-080000-000-dd000002', true);
    const { runId, view } = await copiedSwappedAndLaunched('src-261101-080000-000-dd000002', launch);
    expect(view.phase).toBe('started');
    expect(view.launch?.error).toBeUndefined();
    expect(existsSync(join(base, runId, 'run.json'))).toBe(true);
  });

  it('a main node with no usable main topic (rule 3): stopped just the same', async () => {
    launch = fakeLaunch(base);
    launch.setOnline(ONLINE);
    launch.setMainTopic({ available: false, why: '主会话不在这个 run 的主话题里' });
    h = makeService(base, { loadBots: () => FLEET, launch: launch.deps, libraryDataDir: library });
    h.setOnline(ONLINE);
    // A single main node on the orchestrator: only rule 3 can fire.
    const runId = 'src-261101-080000-000-dd000003';
    const runDir = join(base, runId);
    mkdirSync(runDir, { recursive: true });
    const nodes = [
      { id: 'a', type: 'goal', bot: MAIN, placement: 'main', goal: '任务甲', depends: [], inputs: [] },
    ];
    writeFileSync(join(runDir, 'dag.json'), JSON.stringify({ schemaVersion: 2, runId, nodes }));
    writeFileSync(join(runDir, 'spec.json'), JSON.stringify({
      schemaVersion: 1, runId, title: '单主话题', requirement: '一个主话题节点',
      nodes: [
        { sketchId: 'a', goal: '任务甲', input_needs: [], expected_outputs: ['a.md'], acceptance: 'x', risk_gate: false, unknowns: [] },
      ],
    }));
    writeFileSync(join(runDir, 'bots.snapshot.json'), JSON.stringify({
      [MAIN]: { larkAppId: MAIN, cliId: 'claude-code', workingDir: '/source' },
    }));
    publishRunEnvelopeOnce(runDir, makeAdHocRunEnvelope({
      runId,
      createdAt: '2026-11-01T08:00:00.000Z',
      authorizedAt: '2026-11-01T08:01:00.000Z',
      chatBinding: { larkAppId: MAIN, chatId: 'oc_src', chatType: 'group', rootMessageId: 'om_src', ownerOpenId: OWNER.openId },
      artifacts: {
        dag: artifactRef(runDir, 'dag.json'),
        spec: artifactRef(runDir, 'spec.json'),
        botSnapshots: artifactRef(runDir, 'bots.snapshot.json'),
      },
    }));
    appendEvent(join(runDir, 'journal.ndjson'), { type: 'runStarted', runId });
    appendEvent(join(runDir, 'journal.ndjson'), { type: 'runSucceeded' });
    const draft = await h.service.createFromSource(OWNER, { source: { kind: 'run', runId } });
    await h.service.approveSpec(draft.runId, OWNER);
    const view0 = await h.service.view(draft.runId);
    await h.service.approveFlow(draft.runId, OWNER, { flowSummarySha256: view0.flow!.flowSummarySha256 });
    await h.service.launch(draft.runId, OWNER, {});
    const settledView = await settled(h.service, draft.runId);
    expect(settledView.launch?.error).toMatchObject({ code: 'placement_refused' });
    expect(settledView.launch!.error!.message).toContain('硬规则 3');
    expect(existsSync(join(base, draft.runId, 'run.json'))).toBe(false);
  });
});

describe('§5.2 落点闸拒绝后的恢复路径', () => {
  it('refusal voids the second confirmation: back to dag_ready, swap → re-confirm → 继续 starts', async () => {
    const launch = fakeLaunch(base);
    launch.setOnline(ONLINE);
    const hh = makeService(base, { loadBots: () => FLEET, launch: launch.deps, libraryDataDir: library });
    hh.setOnline(ONLINE);
    // Same seed as the rule-2 case: a/b both main, unordered, distinct source bots.
    const runId = 'src-261101-080000-000-ee000001';
    const runDir = join(base, runId);
    mkdirSync(runDir, { recursive: true });
    const nodes = [
      { id: 'a', type: 'goal', bot: MAIN, placement: 'main', goal: '任务甲', depends: [] as string[], inputs: [] },
      { id: 'b', type: 'goal', bot: DOC, placement: 'main', goal: '任务乙', depends: [], inputs: [] },
    ];
    writeFileSync(join(runDir, 'dag.json'), JSON.stringify({ schemaVersion: 2, runId, nodes }));
    writeFileSync(join(runDir, 'spec.json'), JSON.stringify({
      schemaVersion: 1, runId, title: '双主话题', requirement: '两个主话题节点',
      nodes: [
        { sketchId: 'a', goal: '任务甲', input_needs: [], expected_outputs: ['a.md'], acceptance: 'x', risk_gate: false, unknowns: [] },
        { sketchId: 'b', goal: '任务乙', input_needs: [], expected_outputs: ['b.md'], acceptance: 'x', risk_gate: false, unknowns: [], assignee: DOC },
      ],
    }));
    writeFileSync(join(runDir, 'bots.snapshot.json'), JSON.stringify({
      [MAIN]: { larkAppId: MAIN, cliId: 'claude-code', workingDir: '/source' },
      [DOC]: { larkAppId: DOC, cliId: 'claude-code', workingDir: '/source' },
    }));
    publishRunEnvelopeOnce(runDir, makeAdHocRunEnvelope({
      runId,
      createdAt: '2026-11-01T08:00:00.000Z',
      authorizedAt: '2026-11-01T08:01:00.000Z',
      chatBinding: { larkAppId: MAIN, chatId: 'oc_src', chatType: 'group', rootMessageId: 'om_src', ownerOpenId: OWNER.openId },
      artifacts: {
        dag: artifactRef(runDir, 'dag.json'),
        spec: artifactRef(runDir, 'spec.json'),
        botSnapshots: artifactRef(runDir, 'bots.snapshot.json'),
      },
    }));
    appendEvent(join(runDir, 'journal.ndjson'), { type: 'runStarted', runId });
    appendEvent(join(runDir, 'journal.ndjson'), { type: 'runSucceeded' });

    const draft = await hh.service.createFromSource(OWNER, { source: { kind: 'run', runId } });
    await hh.service.approveSpec(draft.runId, OWNER);
    const swapped = await hh.service.setNodeBot(draft.runId, OWNER, 'b', { larkAppId: MAIN });
    await hh.service.approveFlow(draft.runId, OWNER, { flowSummarySha256: swapped.flow!.flowSummarySha256 });
    await hh.service.launch(draft.runId, OWNER, {});
    const stopped = await settled(hh.service, draft.runId);
    expect(stopped.launch?.error?.code).toBe('placement_refused');

    // The recovery state: back at 待确认流程 with no held confirmation.
    expect(stopped.phase).toBe('dag_ready');
    expect(stopped.flowConfirmation).toBeUndefined();
    expect(existsSync(join(base, draft.runId, 'run.json'))).toBe(false);
    // The group from the stopped launch is reused (no second launch record).

    // Fix it: put b on a different bot, re-confirm, then 继续.
    const fixed = await hh.service.setNodeBot(draft.runId, OWNER, 'b', { larkAppId: REVIEW });
    const reconfirmed = await hh.service.approveFlow(draft.runId, OWNER, { flowSummarySha256: fixed.flow!.flowSummarySha256 });
    // Re-confirmation puts the launch back underway — the 「继续」 entry must
    // exist (phase launching), otherwise the user is stuck at dag_ready with
    // the fixed flow and no resume button.
    expect(reconfirmed.phase).toBe('launching');
    await hh.service.continueLaunch(draft.runId, OWNER, {});
    const done = await settled(hh.service, draft.runId);
    expect(done.phase).toBe('started');
    expect(done.launch?.error).toBeUndefined();
    expect(existsSync(join(base, draft.runId, 'run.json'))).toBe(true);
  });

  it('a template run (needsConfirmation=false) whose revision already has two same-bot main nodes is refused at commit', async () => {
    const launch = fakeLaunch(base);
    launch.setOnline(ONLINE);
    const hh = makeService(base, { loadBots: () => FLEET, launch: launch.deps, libraryDataDir: library });
    hh.setOnline(ONLINE);
    // Build the violating flow via a copy + swap, confirm it, then save it as
    // a template (saving does not run the placement gate).
    const runId = 'src-261101-080000-000-ee000002';
    const runDir = join(base, runId);
    mkdirSync(runDir, { recursive: true });
    const nodes = [
      { id: 'a', type: 'goal', bot: MAIN, placement: 'main', goal: '任务甲', depends: [] as string[], inputs: [] },
      { id: 'b', type: 'goal', bot: DOC, placement: 'main', goal: '任务乙', depends: [], inputs: [] },
    ];
    writeFileSync(join(runDir, 'dag.json'), JSON.stringify({ schemaVersion: 2, runId, nodes }));
    writeFileSync(join(runDir, 'spec.json'), JSON.stringify({
      schemaVersion: 1, runId, title: '双主话题', requirement: '两个主话题节点',
      nodes: [
        { sketchId: 'a', goal: '任务甲', input_needs: [], expected_outputs: ['a.md'], acceptance: 'x', risk_gate: false, unknowns: [] },
        { sketchId: 'b', goal: '任务乙', input_needs: [], expected_outputs: ['b.md'], acceptance: 'x', risk_gate: false, unknowns: [], assignee: DOC },
      ],
    }));
    writeFileSync(join(runDir, 'bots.snapshot.json'), JSON.stringify({
      [MAIN]: { larkAppId: MAIN, cliId: 'claude-code', workingDir: '/source' },
      [DOC]: { larkAppId: DOC, cliId: 'claude-code', workingDir: '/source' },
    }));
    publishRunEnvelopeOnce(runDir, makeAdHocRunEnvelope({
      runId,
      createdAt: '2026-11-01T08:00:00.000Z',
      authorizedAt: '2026-11-01T08:01:00.000Z',
      chatBinding: { larkAppId: MAIN, chatId: 'oc_src', chatType: 'group', rootMessageId: 'om_src', ownerOpenId: OWNER.openId },
      artifacts: {
        dag: artifactRef(runDir, 'dag.json'),
        spec: artifactRef(runDir, 'spec.json'),
        botSnapshots: artifactRef(runDir, 'bots.snapshot.json'),
      },
    }));
    appendEvent(join(runDir, 'journal.ndjson'), { type: 'runStarted', runId });
    appendEvent(join(runDir, 'journal.ndjson'), { type: 'runSucceeded' });

    const copied = await hh.service.createFromSource(OWNER, { source: { kind: 'run', runId } });
    await hh.service.approveSpec(copied.runId, OWNER);
    const swapped = await hh.service.setNodeBot(copied.runId, OWNER, 'b', { larkAppId: MAIN });
    await hh.service.approveFlow(copied.runId, OWNER, { flowSummarySha256: swapped.flow!.flowSummarySha256 });
    const preview = await hh.service.previewTemplateSave(copied.runId, OWNER, {});
    const saved = await hh.service.saveAsTemplate(copied.runId, OWNER, {
      flowSummarySha256: preview.flowSummarySha256, requestKey: 'req-placement-tpl',
    });

    // Run that template as-is: the two same-bot unordered main nodes must be
    // refused at the template commit step, with no run.json.
    const tRun = await hh.service.createFromTemplate(OWNER, { workflowId: saved.workflowId, params: {} });
    await hh.service.launch(tRun.runId, OWNER, {});
    const stopped = await settled(hh.service, tRun.runId);
    expect(stopped.launch?.error?.code).toBe('placement_refused');
    expect(stopped.launch!.error!.message).toContain('硬规则 2');
    expect(existsSync(join(base, tRun.runId, 'run.json'))).toBe(false);
    expect(stopped.phase).toBe('dag_ready');

    // Recovery: swap b to a different bot (the run now commits as ad-hoc),
    // re-confirm, and 「继续」 the same (already built) group.
    const fixed = await hh.service.setNodeBot(tRun.runId, OWNER, 'b', { larkAppId: REVIEW });
    expect(fixed.phase).toBe('dag_ready');
    const reconfirmed = await hh.service.approveFlow(tRun.runId, OWNER, { flowSummarySha256: fixed.flow!.flowSummarySha256 });
    expect(reconfirmed.phase).toBe('launching');
    await hh.service.continueLaunch(tRun.runId, OWNER, {});
    const done = await settled(hh.service, tRun.runId);
    expect(done.phase).toBe('started');
    expect(existsSync(join(base, tRun.runId, 'run.json'))).toBe(true);
  });

  it('no mainTopic seam on the launch deps: fail closed (rule 3), never run', async () => {
    const launch = fakeLaunch(base);
    launch.setOnline(ONLINE);
    const deps = { ...launch.deps } as Partial<typeof launch.deps>;
    delete (deps as Record<string, unknown>).mainTopicAvailability;
    const hh = makeService(base, { loadBots: () => FLEET, launch: deps as typeof launch.deps, libraryDataDir: library });
    hh.setOnline(ONLINE);
    const runId = 'src-261101-080000-000-ee000003';
    const runDir = join(base, runId);
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, 'dag.json'), JSON.stringify({
      schemaVersion: 2, runId,
      nodes: [{ id: 'a', type: 'goal', bot: MAIN, placement: 'main', goal: '任务甲', depends: [], inputs: [] }],
    }));
    writeFileSync(join(runDir, 'spec.json'), JSON.stringify({
      schemaVersion: 1, runId, title: '单主话题', requirement: '一个主话题节点',
      nodes: [
        { sketchId: 'a', goal: '任务甲', input_needs: [], expected_outputs: ['a.md'], acceptance: 'x', risk_gate: false, unknowns: [] },
      ],
    }));
    writeFileSync(join(runDir, 'bots.snapshot.json'), JSON.stringify({
      [MAIN]: { larkAppId: MAIN, cliId: 'claude-code', workingDir: '/source' },
    }));
    publishRunEnvelopeOnce(runDir, makeAdHocRunEnvelope({
      runId,
      createdAt: '2026-11-01T08:00:00.000Z',
      authorizedAt: '2026-11-01T08:01:00.000Z',
      chatBinding: { larkAppId: MAIN, chatId: 'oc_src', chatType: 'group', rootMessageId: 'om_src', ownerOpenId: OWNER.openId },
      artifacts: {
        dag: artifactRef(runDir, 'dag.json'),
        spec: artifactRef(runDir, 'spec.json'),
        botSnapshots: artifactRef(runDir, 'bots.snapshot.json'),
      },
    }));
    appendEvent(join(runDir, 'journal.ndjson'), { type: 'runStarted', runId });
    appendEvent(join(runDir, 'journal.ndjson'), { type: 'runSucceeded' });

    const draft = await hh.service.createFromSource(OWNER, { source: { kind: 'run', runId } });
    await hh.service.approveSpec(draft.runId, OWNER);
    const view = await hh.service.view(draft.runId);
    await hh.service.approveFlow(draft.runId, OWNER, { flowSummarySha256: view.flow!.flowSummarySha256 });
    await hh.service.launch(draft.runId, OWNER, {});
    const stopped = await settled(hh.service, draft.runId);
    expect(stopped.launch?.error?.code).toBe('placement_refused');
    expect(stopped.launch!.error!.message).toContain('硬规则 3');
    expect(existsSync(join(base, draft.runId, 'run.json'))).toBe(false);
  });
});
