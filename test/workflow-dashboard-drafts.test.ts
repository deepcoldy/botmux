/**
 * Dashboard workflow drafts, daemon side (design 2026-11-03
 * workflow-dashboard-orchestration §4.2–4.4, §4.6, §9, D2).
 *
 * Real draft service over the real grill state machine, host operations,
 * spec/DAG validation, roster and flow summary, on a real run dir. Fakes:
 * the clarify session, the Architect worker (behind the real architect
 * runner), timers and the daemon registry.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readGrillState, transition } from '../src/workflows/v3/grill-state.js';
import { cmdWorkflowHost } from '../src/workflows/v3/host.js';
import { listRuns } from '../src/workflows/v3/ops-projection.js';
import { buildV3BotRoster } from '../src/workflows/v3/bot-assignment.js';
import { WorkflowDraftError, WorkflowDraftService } from '../src/workflows/v3/draft-service.js';
import { listWorkflowDrafts, readWorkflowDraft, writeWorkflowDraft } from '../src/workflows/v3/draft-store.js';
import { parseDraftClarifyOutput } from '../src/workflows/v3/draft-clarify.js';
import {
  ALICE, BOTS, DOC, MAIN, NAMES, OFFLINE, OWNER, PI, SKETCHES, STEWARD,
  architectSettled, makeService, specMarkdown,
} from './helpers/workflow-draft-fakes.js';

let base: string;
beforeEach(() => { base = mkdtempSync(join(tmpdir(), 'wf-drafts-')); });
afterEach(() => { rmSync(base, { recursive: true, force: true }); });

async function code(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof WorkflowDraftError) return error.code;
    throw error;
  }
  return 'ok';
}

const specBlock = (sketches: unknown[] = SKETCHES) => `好的，需求够了。\n<botmux-spec>\n${specMarkdown(sketches)}\n</botmux-spec>`;

/** A draft in spec_ready (the model wrote a valid spec; daemon finalized). */
async function specReady(h: ReturnType<typeof makeService>) {
  const created = await h.service.create(OWNER, { goal: '帮我出一份代码风险报告' });
  h.clarify.reply(specBlock());
  const out = await h.service.finalizeSpec(created.runId, OWNER, {});
  expect(out.ok).toBe(true);
  return created.runId;
}

async function dagReady(h: ReturnType<typeof makeService>) {
  const runId = await specReady(h);
  await h.service.approveSpec(runId, OWNER);
  await h.service.startArchitect(runId, OWNER);
  await architectSettled(h.service, runId);
  const view = await h.service.view(runId);
  expect(view.phase).toBe('dag_ready');
  return { runId, view };
}

describe('draft birth and listing', () => {
  it('a draft is a grill run without a chat binding or run.json, with its own record and clarify session', async () => {
    const h = makeService(base);
    const view = await h.service.create(OWNER, { goal: '帮我出一份代码风险报告' });
    const runDir = join(base, view.runId);
    expect(view.runId).toMatch(/^run-\d{6}-\d{6}-\d{3}-[0-9a-f]{8}$/);
    expect(readGrillState(runDir)).toMatchObject({ status: 'grilling' });
    expect(readGrillState(runDir)?.chatBinding).toBeUndefined();
    expect(existsSync(join(runDir, 'run.json'))).toBe(false);
    expect(readWorkflowDraft(runDir)).toMatchObject({ orchestratorAppId: MAIN, initiator: OWNER, version: expect.any(Number) });
    expect(view).toMatchObject({ phase: 'clarifying', clarify: { state: 'active', pending: true } });
    const kickoff = [...h.clarify.sessions.values()][0]!.prompts[0]!;
    expect(kickoff).toContain('帮我出一份代码风险报告');
    expect(kickoff).toContain(view.runId);
  });

  it('the draft list shows drafts only; the run list and run lookup do not see them', async () => {
    const h = makeService(base);
    const view = await h.service.create(OWNER, { goal: 'g' });
    expect(listWorkflowDrafts(base).map((draft) => [draft.runId, draft.phase, draft.orchestratorAppId]))
      .toEqual([[view.runId, 'clarifying', MAIN]]);
    expect(listRuns(base)).toEqual([]);
  });

  it('once run.json exists the dir is a run, not a draft', async () => {
    const h = makeService(base);
    const view = await h.service.create(OWNER, { goal: 'g' });
    writeFileSync(join(base, view.runId, 'run.json'), '{}');
    expect(listWorkflowDrafts(base)).toEqual([]);
    expect(await code(h.service.view(view.runId))).toBe('unknown_draft');
    expect(await code(h.service.abandon(view.runId, OWNER))).toBe('unknown_draft');
  });

  it('the steward bot cannot be the orchestrator', async () => {
    const h = makeService(base, { appId: STEWARD });
    const refused = h.service.create(OWNER, { goal: 'g' });
    await expect(refused).rejects.toMatchObject({ code: 'orchestrator_ineligible', message: '管家 Bot 不能当编排 Bot' });
    // The refusal is side-effect free: birthRun is never called, so not even a
    // grill-only dir appears (such a dir is invisible to both lists, so the
    // list assertions alone would not pin the guard's position).
    expect(readdirSync(base)).toEqual([]);
    expect(listWorkflowDrafts(base)).toEqual([]);
    expect(h.clarify.sessions.size).toBe(0);
  });

  it('an orchestrator that cannot run workflow nodes cannot orchestrate', async () => {
    const h = makeService(base, { appId: PI });
    expect(await code(h.service.create(OWNER, { goal: 'g' }))).toBe('orchestrator_ineligible');
    expect(readdirSync(base)).toEqual([]);
    expect(listWorkflowDrafts(base)).toEqual([]);
  });

  it('the CLI host commands refuse a draft; only the Dashboard path advances it', async () => {
    const h = makeService(base);
    const runId = await specReady(h);
    await expect(cmdWorkflowHost('approve-spec', [runId, '--base-dir', base], { resolveChatBinding: () => undefined }))
      .rejects.toThrow(/Dashboard 草稿/);
    expect(readGrillState(join(base, runId))?.status).toBe('spec_ready');
  });
});

describe('clarify session', () => {
  it('one round trip: the reply, its question block and a spec candidate are committed to the draft', async () => {
    const h = makeService(base);
    const { runId } = await h.service.create(OWNER, { goal: 'g' });
    h.clarify.reply('先确认范围。\n```botmux-question\n{"question":"看哪个仓库？","options":["主仓","全部"],"recommended":"主仓"}\n```');
    const view = await h.service.view(runId);
    expect(view.clarify.pending).toBe(false);
    expect(view.clarify.turns.at(-1)).toMatchObject({
      role: 'assistant', text: '先确认范围。',
      question: { question: '看哪个仓库？', options: ['主仓', '全部'], recommended: '主仓' },
    });
    await h.service.sendMessage(runId, OWNER, { text: '主仓' });
    expect(await code(h.service.sendMessage(runId, OWNER, { text: '再来一条' }))).toBe('clarify_turn_running');
    h.clarify.reply(specBlock());
    const after = await h.service.view(runId);
    expect(after.clarify.turns.map((turn) => turn.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(after.clarify.specCandidate?.markdown).toContain('"sketchId": "inspect"');
    // Talking does not move the state machine: only the finalize route does.
    expect(after.grillStatus).toBe('grilling');
  });

  it('parses the last question block and the last complete spec section', () => {
    const out = parseDraftClarifyOutput('a\n```botmux-question\n{"question":"q1"}\n```\nb\n```botmux-question\nnot json\n```\n<botmux-spec>\nX\n</botmux-spec>');
    expect(out).toMatchObject({ question: { question: 'q1', options: [] }, specMarkdown: 'X' });
    expect(out.text).not.toContain('botmux-question');
  });

  it('a session that cannot be resumed is reported, and 「继续」 starts a new one with the spec so far and recent turns', async () => {
    const h = makeService(base);
    const { runId } = await h.service.create(OWNER, { goal: '目标甲' });
    h.clarify.reply('第一问：范围？');
    await h.service.view(runId);
    h.clarify.lose('sess-1');
    expect(await code(h.service.sendMessage(runId, OWNER, { text: '主仓' }))).toBe('session_disconnected');
    expect((await h.service.view(runId)).clarify.state).toBe('disconnected');

    const resumed = await h.service.continueClarify(runId, OWNER);
    expect(resumed.clarify).toMatchObject({ state: 'active', pending: true });
    const sessions = [...h.clarify.sessions.entries()];
    expect(sessions).toHaveLength(2);
    expect(sessions[0]![1].closed).toBe(true);
    const prompt = sessions[1]![1].prompts[0]!;
    expect(prompt).toContain('目标甲');
    expect(prompt).toContain('第一问：范围？');
  });

  it('30 minutes without a message closes the process and keeps the record; the next message resumes', async () => {
    const h = makeService(base);
    const { runId } = await h.service.create(OWNER, { goal: 'g' });
    h.clarify.reply('问题');
    await h.service.view(runId);
    h.advance(29 * 60_000);
    expect(await h.service.sweepIdleClarify()).toEqual([]);
    h.advance(2 * 60_000);
    expect(await h.service.sweepIdleClarify()).toEqual([runId]);
    expect(h.clarify.suspended).toEqual(['sess-1']);
    expect((await h.service.view(runId)).clarify.state).toBe('suspended');
    await h.service.sendMessage(runId, OWNER, { text: '答' });
    const view = await h.service.view(runId);
    expect(view.clarify).toMatchObject({ state: 'active', pending: true });
    expect(h.clarify.sessions.size).toBe(1);
    // A turn still running is never cut off by the sweep, however long it takes.
    h.advance(60 * 60_000);
    expect(await h.service.sweepIdleClarify()).toEqual([]);
    expect(h.clarify.suspended).toEqual(['sess-1']);
  });
});

describe('spec and the first confirmation', () => {
  it('no spec from the model yet → no_spec', async () => {
    const h = makeService(base);
    const { runId } = await h.service.create(OWNER, { goal: 'g' });
    expect(await code(h.service.finalizeSpec(runId, OWNER, {}))).toBe('no_spec');
  });

  it('an invalid spec returns its problems, changes nothing, and can be relayed to the model as the next turn', async () => {
    const h = makeService(base);
    const { runId } = await h.service.create(OWNER, { goal: 'g' });
    h.clarify.reply(specBlock([{ sketchId: 'x', goal: '', expected_outputs: [], acceptance: '', risk_gate: 'no' }]));
    const out = await h.service.finalizeSpec(runId, OWNER, { relayProblems: true });
    expect(out.ok).toBe(false);
    expect(out.problems!.length).toBeGreaterThan(0);
    expect(out.draft.grillStatus).toBe('grilling');
    expect(existsSync(join(base, runId, 'spec.md'))).toBe(false);
    const relayed = [...h.clarify.sessions.values()][0]!.prompts.at(-1)!;
    expect(relayed).toContain(out.problems![0]!);
    expect(out.draft.clarify.turns.at(-1)).toMatchObject({ role: 'system' });
  });

  it('a manual edit that does not validate leaves the finalized spec exactly as it was', async () => {
    const h = makeService(base);
    const runId = await specReady(h);
    const before = readFileSync(join(base, runId, 'spec.md'), 'utf-8');
    const out = await h.service.finalizeSpec(runId, OWNER, { specMarkdown: 'no json block' });
    expect(out.ok).toBe(false);
    expect(readFileSync(join(base, runId, 'spec.md'), 'utf-8')).toBe(before);
    expect(out.draft.grillStatus).toBe('spec_ready');
    // A valid edit re-validates in place.
    const edited = await h.service.finalizeSpec(runId, OWNER, { specMarkdown: specMarkdown([SKETCHES[0]]) });
    expect(edited.ok).toBe(true);
    expect((edited.draft.spec!.json as any).nodes).toHaveLength(1);
  });

  it('a confirmation record left by a crash before the grill moved on is dropped by the next spec change', async () => {
    const h = makeService(base);
    const runId = await specReady(h);
    const runDir = join(base, runId);
    const draft = readWorkflowDraft(runDir)!;
    // approve-spec wrote its record, then the process died before spec_ready → spec_approved.
    writeWorkflowDraft(runDir, { ...draft, specConfirmation: { confirmedByOpenId: OWNER.openId, confirmedAt: draft.updatedAt, specSha256: `sha256:${'1'.repeat(64)}` } });
    const edited = await h.service.finalizeSpec(runId, OWNER, { specMarkdown: specMarkdown([SKETCHES[0]]) });
    expect(edited.ok).toBe(true);
    expect(edited.draft.specConfirmation).toBeUndefined();
    expect(edited.draft.phase).toBe('spec_ready');
  });

  it('approve-spec only from spec_ready, records who and what, and a second click is a deterministic conflict', async () => {
    const h = makeService(base);
    const { runId } = await h.service.create(OWNER, { goal: 'g' });
    expect(await code(h.service.approveSpec(runId, OWNER))).toBe('state_conflict');
    h.clarify.reply(specBlock());
    await h.service.finalizeSpec(runId, OWNER, {});
    const results = await Promise.all([code(h.service.approveSpec(runId, OWNER)), code(h.service.approveSpec(runId, OWNER))]);
    expect(results.sort()).toEqual(['ok', 'state_conflict']);
    const view = await h.service.view(runId);
    expect(view).toMatchObject({ phase: 'awaiting_architect', specConfirmation: { confirmedByOpenId: OWNER.openId } });
    expect(view.specConfirmation!.specSha256).toBe(view.spec!.sha256);
  });

  it('only the initiator writes, and only through the same login path', async () => {
    const h = makeService(base);
    const runId = await specReady(h);
    expect(await code(h.service.approveSpec(runId, ALICE))).toBe('not_initiator');
    expect(await code(h.service.approveSpec(runId, { ...OWNER, source: 'dashboard-platform', unionId: 'on_owner' }))).toBe('not_initiator');
    expect(await code(h.service.sendMessage(runId, ALICE, { text: 'x' }))).toBe('not_initiator');
    expect(await code(h.service.abandon(runId, ALICE))).toBe('not_initiator');
    expect((await h.service.view(runId)).phase).toBe('spec_ready');
  });

  it('a stale baseVersion is refused', async () => {
    const h = makeService(base);
    const runId = await specReady(h);
    const { version } = await h.service.view(runId);
    expect(await code(h.service.approveSpec(runId, OWNER, { baseVersion: version - 1 }))).toBe('version_conflict');
    expect(await code(h.service.approveSpec(runId, OWNER, { baseVersion: version }))).toBe('ok');
  });
});

describe('Architect background task', () => {
  it('runs from 待编排 with the planned-group roster: steward and offline bots out, static exclusions out', async () => {
    const h = makeService(base);
    h.setOnline([MAIN, DOC, STEWARD, PI]);
    const runId = await specReady(h);
    expect(await code(h.service.startArchitect(runId, OWNER))).toBe('state_conflict');
    await h.service.approveSpec(runId, OWNER);
    const started = await h.service.startArchitect(runId, OWNER);
    expect(started.phase).toBe('architect_running');
    await architectSettled(h.service, runId);
    const roster = h.architect.calls[0]!.botAssignment!.roster;
    expect(roster.bots.map((bot) => bot.larkAppId)).toEqual([MAIN, DOC]);
    expect(Object.fromEntries(roster.excluded.map((entry) => [entry.larkAppId, entry.why]))).toMatchObject({
      [OFFLINE]: expect.stringContaining('daemon 不在线'),
      [STEWARD]: expect.stringContaining('管家'),
      [PI]: expect.stringContaining('CLI pi'),
    });
    const view = await h.service.view(runId);
    expect(view).toMatchObject({ phase: 'dag_ready', architect: { state: 'succeeded', attempt: 1 } });
    expect(view.flow!.roster.bots.map((bot) => bot.larkAppId)).toEqual([MAIN, DOC]);
    expect(view.flow!.plan.rows.map((row) => [row.nodeId, row.larkAppId, row.reason])).toEqual([
      ['inspect', MAIN, '默认交给主 Bot'], ['write', DOC, '用户点名文档Bot'],
    ]);
  });

  it('while it runs every other write is refused; elapsed time is shown', async () => {
    const h = makeService(base);
    h.architect.mode = 'hang';
    const runId = await specReady(h);
    await h.service.approveSpec(runId, OWNER);
    await h.service.startArchitect(runId, OWNER);
    h.advance(90_000);
    const view = await h.service.view(runId);
    expect(view.architect).toMatchObject({ state: 'running', elapsedMs: 90_000 });
    expect(await code(h.service.startArchitect(runId, OWNER))).toBe('architect_running');
    expect(await code(h.service.reviseSpec(runId, OWNER))).toBe('architect_running');
    expect(await code(h.service.delete(runId, OWNER))).toBe('architect_running');
    await h.service.cancelArchitect(runId, OWNER);
    await architectSettled(h.service, runId);
  });

  it('cancel → back to 待编排 as cancelled', async () => {
    const h = makeService(base);
    h.architect.mode = 'hang';
    const runId = await specReady(h);
    await h.service.approveSpec(runId, OWNER);
    await h.service.startArchitect(runId, OWNER);
    expect(await code(h.service.cancelArchitect(runId, ALICE))).toBe('not_initiator');
    await h.service.cancelArchitect(runId, OWNER);
    await architectSettled(h.service, runId);
    const view = await h.service.view(runId);
    expect(view).toMatchObject({ phase: 'awaiting_architect', grillStatus: 'spec_approved', architect: { state: 'cancelled' } });
    expect(await code(h.service.cancelArchitect(runId, OWNER))).toBe('state_conflict');
  });

  it('timeout (fake clock) → back to 待编排 with the error', async () => {
    const h = makeService(base);
    h.architect.mode = 'hang';
    const runId = await specReady(h);
    await h.service.approveSpec(runId, OWNER);
    await h.service.startArchitect(runId, OWNER);
    expect(h.timers.pending()).toBe(1);
    await vi.waitFor(() => expect(h.architect.calls).toHaveLength(1));
    h.timers.fire();
    await architectSettled(h.service, runId);
    const view = await h.service.view(runId);
    expect(view).toMatchObject({ phase: 'awaiting_architect', architect: { state: 'timed_out' } });
    expect(view.architect!.problems![0]).toContain('超时');
    expect(h.architect.calls[0]!.timeoutMs).toBe(10 * 60_000);
  });

  it('failure → back to 待编排 with the problems; it can run again', async () => {
    const h = makeService(base);
    h.architect.mode = 'fail';
    const runId = await specReady(h);
    await h.service.approveSpec(runId, OWNER);
    await h.service.startArchitect(runId, OWNER);
    await architectSettled(h.service, runId);
    expect((await h.service.view(runId))).toMatchObject({ phase: 'awaiting_architect', architect: { state: 'failed' } });
    h.architect.mode = 'ok';
    await h.service.startArchitect(runId, OWNER);
    await architectSettled(h.service, runId);
    expect((await h.service.view(runId))).toMatchObject({ phase: 'dag_ready', architect: { state: 'succeeded', attempt: 2 } });
  });

  it('a DAG using a bot outside the roster is sent back (the roster check of hostArchitect)', async () => {
    const h = makeService(base);
    h.architect.nodes = [{ id: 'inspect', type: 'goal', goal: 'x', depends: [], inputs: [], bot: STEWARD }];
    const runId = await specReady(h);
    await h.service.approveSpec(runId, OWNER);
    await h.service.startArchitect(runId, OWNER);
    await architectSettled(h.service, runId);
    const view = await h.service.view(runId);
    expect(view).toMatchObject({ phase: 'awaiting_architect', architect: { state: 'failed' } });
    expect(view.problems!.join('\n')).toContain(STEWARD);
  });

  it('daemon restart: a draft left 编排中 goes back to 待编排 with an error (other bots\' drafts untouched)', async () => {
    const h = makeService(base);
    const runId = await specReady(h);
    await h.service.approveSpec(runId, OWNER);
    const runDir = join(base, runId);
    // The previous process died mid-run: grill architect_running, task recorded running.
    transition(runDir, 'architect_running');
    const draft = readWorkflowDraft(runDir)!;
    writeWorkflowDraft(runDir, { ...draft, architect: { state: 'running', attempt: 1, startedAt: draft.updatedAt } });
    const other = makeService(base, { appId: DOC });
    expect(other.service.recoverInterrupted()).toEqual([]);
    const fresh = makeService(base);
    expect(fresh.service.recoverInterrupted()).toEqual([runId]);
    const view = await fresh.service.view(runId);
    expect(view).toMatchObject({ phase: 'awaiting_architect', grillStatus: 'spec_approved', architect: { state: 'interrupted' } });
    expect(view.problems![0]).toContain('daemon 重启');
  });

  it('daemon restart right after the Architect reached 待确认流程: that attempt counts as succeeded', async () => {
    const h = makeService(base);
    const runId = await specReady(h);
    await h.service.approveSpec(runId, OWNER);
    await h.service.startArchitect(runId, OWNER);
    await architectSettled(h.service, runId);
    const runDir = join(base, runId);
    const draft = readWorkflowDraft(runDir)!;
    writeWorkflowDraft(runDir, { ...draft, architect: { ...draft.architect!, state: 'running' } });
    const fresh = makeService(base);
    expect(fresh.service.recoverInterrupted()).toEqual([runId]);
    expect(await fresh.service.view(runId)).toMatchObject({ phase: 'dag_ready', architect: { state: 'succeeded' } });
  });

  it('「重新编排」 from 待确认流程 passes the extra note without touching the confirmed spec', async () => {
    const h = makeService(base);
    const { runId } = await dagReady(h);
    const specBefore = readFileSync(join(base, runId, 'spec.md'), 'utf-8');
    await h.service.startArchitect(runId, OWNER, { note: '把 write 拆成两步' });
    await architectSettled(h.service, runId);
    const second = h.architect.calls[1]!;
    expect(readFileSync(second.specPath, 'utf-8')).toContain('把 write 拆成两步');
    expect(readFileSync(join(base, runId, 'spec.md'), 'utf-8')).toBe(specBefore);
    expect((await h.service.view(runId)).architect).toMatchObject({ state: 'succeeded', attempt: 2, note: '把 write 拆成两步' });
  });
});

describe('node bots and the second confirmation', () => {
  it('a node can only go to a roster bot; the DAG is rewritten and re-validated; a replaced named bot shows ⚠️', async () => {
    const h = makeService(base);
    const { runId } = await dagReady(h);
    expect(await code(h.service.setNodeBot(runId, OWNER, 'write', { larkAppId: STEWARD }))).toBe('bot_not_on_roster');
    expect(await code(h.service.setNodeBot(runId, OWNER, 'write', { larkAppId: OFFLINE }))).toBe('bot_not_on_roster');
    expect(await code(h.service.setNodeBot(runId, OWNER, 'nope', { larkAppId: MAIN }))).toBe('unknown_node');
    expect(await code(h.service.setNodeBot(runId, ALICE, 'write', { larkAppId: MAIN }))).toBe('not_initiator');
    const view = await h.service.setNodeBot(runId, OWNER, 'write', { larkAppId: MAIN });
    expect(view.nodeBots).toMatchObject({ write: { larkAppId: MAIN, previousLarkAppId: DOC } });
    const dag = JSON.parse(readFileSync(readGrillState(join(base, runId))!.dagPath!, 'utf-8'));
    expect(dag.nodes.find((node: any) => node.id === 'write').bot).toBe(MAIN);
    const row = view.flow!.plan.rows.find((candidate) => candidate.nodeId === 'write')!;
    expect(row).toMatchObject({ larkAppId: MAIN, missedAssignee: { assignee: DOC } });
    expect(view.flow!.flowSummary.nodes.find((node) => node.nodeId === 'write')!.missedAssignee).toBe(DOC);
  });

  it('confirms exactly the summary shown; records summary, its digest, dag and spec digests; a second confirm is a conflict', async () => {
    const h = makeService(base);
    const { runId, view } = await dagReady(h);
    const shown = view.flow!.flowSummarySha256;
    expect(await code(h.service.approveFlow(runId, OWNER, { flowSummarySha256: `sha256:${'0'.repeat(64)}` }))).toBe('flow_changed');
    expect(await code(h.service.approveFlow(runId, ALICE, { flowSummarySha256: shown }))).toBe('not_initiator');
    const results = await Promise.all([
      code(h.service.approveFlow(runId, OWNER, { flowSummarySha256: shown })),
      code(h.service.approveFlow(runId, OWNER, { flowSummarySha256: shown })),
    ]);
    expect(results.sort()).toEqual(['already_confirmed', 'ok']);
    const confirmed = await h.service.view(runId);
    expect(confirmed.phase).toBe('flow_confirmed');
    expect(confirmed.flowConfirmation).toMatchObject({
      confirmedByOpenId: OWNER.openId,
      flowSummarySha256: shown,
      dagSha256: confirmed.flow!.dagSha256,
      specSha256: confirmed.spec!.sha256,
      valid: true,
    });
    expect(confirmed.flowConfirmation!.flowSummary).toEqual(confirmed.flow!.flowSummary);
  });

  it('changing a node bot voids the second confirmation (E5)', async () => {
    const h = makeService(base);
    const { runId, view } = await dagReady(h);
    await h.service.approveFlow(runId, OWNER, { flowSummarySha256: view.flow!.flowSummarySha256 });
    const changed = await h.service.setNodeBot(runId, OWNER, 'write', { larkAppId: MAIN });
    expect(changed.phase).toBe('dag_ready');
    expect(changed.flowConfirmation).toBeUndefined();
  });

  it('a DAG change the summary does not show (topology) still voids the confirmation on read', async () => {
    const h = makeService(base);
    const { runId, view } = await dagReady(h);
    await h.service.approveFlow(runId, OWNER, { flowSummarySha256: view.flow!.flowSummarySha256 });
    const dagPath = readGrillState(join(base, runId))!.dagPath!;
    const dag = JSON.parse(readFileSync(dagPath, 'utf-8'));
    dag.nodes[1].depends = ['inspect'];
    writeFileSync(dagPath, JSON.stringify(dag));
    const after = await h.service.view(runId);
    expect(after.flow!.flowSummarySha256).toBe(view.flow!.flowSummarySha256);
    expect(after.flowConfirmation!.valid).toBe(false);
    expect(after.phase).toBe('dag_ready');
    expect(listWorkflowDrafts(base)[0]!.phase).toBe('dag_ready');
    // and it can be confirmed again
    expect(await code(h.service.approveFlow(runId, OWNER, { flowSummarySha256: after.flow!.flowSummarySha256 }))).toBe('ok');
  });

  it('an edit undone byte for byte still voids the confirmation (flow revision)', async () => {
    const h = makeService(base);
    const { runId, view } = await dagReady(h);
    const dagPath = readGrillState(join(base, runId))!.dagPath!;
    const original = readFileSync(dagPath);
    await h.service.approveFlow(runId, OWNER, { flowSummarySha256: view.flow!.flowSummarySha256 });
    const confirmedRecord = readWorkflowDraft(join(base, runId))!.flowConfirmation!;
    await h.service.setNodeBot(runId, OWNER, 'write', { larkAppId: MAIN });
    await h.service.setNodeBot(runId, OWNER, 'write', { larkAppId: DOC });
    writeFileSync(dagPath, original);
    const after = await h.service.view(runId);
    expect(after.flow!.dagSha256).toBe(view.flow!.dagSha256);
    expect(after.flow!.flowSummarySha256).toBe(view.flow!.flowSummarySha256);
    expect(after.flowRevision).toBeGreaterThan(view.flowRevision);
    expect(after.phase).toBe('dag_ready');
    // Even a confirmation record that survived (e.g. written back by a stale
    // writer) does not hold for a later flow revision.
    const runDir = join(base, runId);
    const draft = readWorkflowDraft(runDir)!;
    writeWorkflowDraft(runDir, { ...draft, flowConfirmation: confirmedRecord });
    const stale = await h.service.view(runId);
    expect(stale.flowConfirmation!.valid).toBe(false);
    expect(stale.phase).toBe('dag_ready');
  });

  it('「退回改需求」 from 待确认流程 → clarifying; both confirmations and node choices are gone', async () => {
    const h = makeService(base);
    const { runId, view } = await dagReady(h);
    await h.service.setNodeBot(runId, OWNER, 'write', { larkAppId: MAIN });
    const shown = (await h.service.view(runId)).flow!.flowSummarySha256;
    await h.service.approveFlow(runId, OWNER, { flowSummarySha256: shown });
    void view;
    const back = await h.service.reviseSpec(runId, OWNER);
    expect(back).toMatchObject({ phase: 'clarifying', grillStatus: 'grilling' });
    expect(back.specConfirmation).toBeUndefined();
    expect(back.flowConfirmation).toBeUndefined();
    expect(back.nodeBots).toBeUndefined();
    expect(await code(h.service.approveFlow(runId, OWNER, { flowSummarySha256: shown }))).toBe('state_conflict');
  });
});

describe('abandon and delete', () => {
  it('abandon closes the clarify session; afterwards only delete works; an active draft cannot be deleted', async () => {
    const h = makeService(base);
    const { runId } = await h.service.create(OWNER, { goal: 'g' });
    expect(await code(h.service.delete(runId, OWNER))).toBe('draft_not_stale');
    const abandoned = await h.service.abandon(runId, OWNER);
    expect(abandoned).toMatchObject({ phase: 'abandoned', clarify: { state: 'closed' } });
    expect(h.clarify.sessions.get('sess-1')!.closed).toBe(true);
    expect(await code(h.service.sendMessage(runId, OWNER, { text: 'x' }))).toBe('draft_abandoned');
    expect(listWorkflowDrafts(base)[0]!.phase).toBe('abandoned');
    expect(await code(h.service.delete(runId, ALICE))).toBe('not_initiator');
    await h.service.delete(runId, OWNER);
    expect(existsSync(join(base, runId))).toBe(false);
    expect(await code(h.service.view(runId))).toBe('unknown_draft');
  });

  it('abandon during the Architect aborts it', async () => {
    const h = makeService(base);
    h.architect.mode = 'hang';
    const runId = await specReady(h);
    await h.service.approveSpec(runId, OWNER);
    await h.service.startArchitect(runId, OWNER);
    await h.service.abandon(runId, OWNER);
    await architectSettled(h.service, runId);
    expect(await h.service.view(runId)).toMatchObject({ phase: 'abandoned', architect: { state: 'cancelled' } });
  });

  it('a draft with no activity for 30 days is stale and deletable', async () => {
    const h = makeService(base);
    const { runId } = await h.service.create(OWNER, { goal: 'g' });
    h.advance(30 * 24 * 60 * 60_000 + 1);
    expect((await h.service.view(runId)).stale).toBe(true);
    await h.service.delete(runId, OWNER);
    expect(existsSync(join(base, runId))).toBe(false);
    expect(h.clarify.sessions.get('sess-1')!.closed).toBe(true);
  });
});

describe('roster rule shared with the Feishu entry', () => {
  it('buildV3BotRoster leaves a steward out (the orchestrator itself stays)', async () => {
    const probe = {
      isConfigured: () => true, isDaemonOnline: () => true,
      inChat: async () => 'yes' as const, opensTopicSessions: async () => 'yes' as const, ensureGrant: async () => {},
    };
    const nameOf = (appId: string) => NAMES[appId] ?? appId;
    const roster = await buildV3BotRoster({ orchestratorAppId: MAIN, bots: BOTS, probe, nameOf });
    expect(roster.bots.map((bot) => bot.larkAppId)).not.toContain(STEWARD);
    expect(roster.excluded.find((entry) => entry.larkAppId === STEWARD)?.why).toContain('管家');
    const asSteward = await buildV3BotRoster({ orchestratorAppId: STEWARD, bots: BOTS, probe, nameOf });
    expect(asSteward.bots[0]).toMatchObject({ larkAppId: STEWARD, main: true });
  });
});

it('WorkflowDraftService is exported for the daemon wiring', () => {
  expect(typeof WorkflowDraftService).toBe('function');
});
