/**
 * 工作流草稿的「项目」：澄清会话在哪个目录里跑。编排 Bot 有默认目录就在那里；没有就必须
 * 从和飞书仓库选择卡同一份的候选里选一个，存进 draft.json，「继续」和换编排 Bot 都沿用；不再
 * 退回 daemon 自己的进程目录。
 *
 * Real draft service, draft store and grill state machine. Fakes: the clarify
 * session (records where it was asked to start), the bot's project list, the
 * Architect worker and timers.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DRAFT_PROJECT_OFFER_TTL_MS, WorkflowDraftError, type WorkflowDraftProjectCandidate, type WorkflowDraftProjects } from '../src/workflows/v3/draft-service.js';
import { readWorkflowDraft, writeWorkflowDraft } from '../src/workflows/v3/draft-store.js';
import { DEFAULT_PROJECT, DOC, OWNER, makeService } from './helpers/workflow-draft-fakes.js';

let base: string;
beforeEach(() => { base = mkdtempSync(join(tmpdir(), 'wf-draft-project-')); });
afterEach(() => { rmSync(base, { recursive: true, force: true }); });

const WEB = '/work/projects/web-portal';
const BILLING = '/work/projects/billing-service-wt';
const CANDIDATES: WorkflowDraftProjectCandidate[] = [
  { path: WEB, name: 'web-portal', type: 'repo', branch: 'main' },
  { path: BILLING, name: 'billing-service', type: 'worktree', branch: 'feat/invoice' },
];
/** Where the daemon itself runs: a draft must never clarify here. */
const DAEMON_CWD = '/root/.botmux';

const noDefault = (extra: Partial<WorkflowDraftProjects> = {}): WorkflowDraftProjects =>
  ({ defaultDir: () => undefined, candidates: () => CANDIDATES, ...extra });

async function code(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof WorkflowDraftError) return error.code;
    throw error;
  }
  return 'ok';
}

const record = (runId: string) => readWorkflowDraft(join(base, runId))!;

/** The session drops; the page then offers 「继续」. */
async function disconnect(h: ReturnType<typeof makeService>, runId: string): Promise<void> {
  h.clarify.reply('先确认范围？');
  await h.service.view(runId);
  h.clarify.lose([...h.clarify.sessions.keys()].at(-1)!);
  expect(await code(h.service.sendMessage(runId, OWNER, { text: '主仓' }))).toBe('session_disconnected');
}

describe('编排 Bot 没设默认目录', () => {
  it('a draft without a project is refused, and nothing is left behind', async () => {
    const h = makeService(base, { projects: noDefault() });
    const refused = h.service.create(OWNER, { goal: '帮我出一份代码风险报告' });
    await expect(refused).rejects.toMatchObject({ code: 'project_required', status: 422 });
    expect(h.clarify.creates).toBe(0);
    expect(readdirSync(base)).toEqual([]);
  });

  it.each([
    ['a path the repo picker never offered', '/etc'],
    ['the scan root above the candidates', '/work/projects'],
    ['a candidate walked out of with ..', `${WEB}/../../../etc`],
    ['a candidate spelled differently', `${WEB}/`],
    ['the daemon\'s own dir', DAEMON_CWD],
  ])('%s is refused (%s)', async (_name, project) => {
    const h = makeService(base, { projects: noDefault() });
    expect(await code(h.service.create(OWNER, { goal: 'g', project }))).toBe('project_not_allowed');
    expect(h.clarify.creates).toBe(0);
    expect(readdirSync(base)).toEqual([]);
  });

  it('a project that is not a path string is a bad request', async () => {
    const h = makeService(base, { projects: noDefault() });
    for (const project of [42, '', ['/etc'], 'x'.repeat(4097)]) {
      expect(await code(h.service.create(OWNER, { goal: 'g', project }))).toBe('bad_request');
    }
  });

  it('a picked candidate: the clarify session starts there, draft.json keeps it, the page shows it', async () => {
    const h = makeService(base, { projects: noDefault() });
    const view = await h.service.create(OWNER, { goal: '帮我出一份代码风险报告', project: BILLING });
    expect(h.clarify.createInputs.map((input) => input.workingDir)).toEqual([BILLING]);
    expect(record(view.runId).projectDir).toBe(BILLING);
    expect(view.project).toEqual({ dir: BILLING, from: 'draft' });
  });

  it('「继续」 reopens in the draft\'s project; another project is refused', async () => {
    const h = makeService(base, { projects: noDefault() });
    const { runId } = await h.service.create(OWNER, { goal: 'g', project: BILLING });
    await disconnect(h, runId);
    expect(await code(h.service.continueClarify(runId, OWNER, { project: WEB }))).toBe('project_not_allowed');
    await h.service.continueClarify(runId, OWNER);
    expect(h.clarify.createInputs.map((input) => input.workingDir)).toEqual([BILLING, BILLING]);
  });

  it('a candidate the page was offered is taken though a re-scan under load now stops before it', async () => {
    let scanned = CANDIDATES;
    const h = makeService(base, { projects: noDefault({ candidates: () => scanned }) });
    h.service.projectOptions();
    scanned = CANDIDATES.slice(0, 1);
    const view = await h.service.create(OWNER, { goal: 'g', project: BILLING });
    expect(h.clarify.createInputs.map((input) => input.workingDir)).toEqual([BILLING]);
    expect(view.project).toEqual({ dir: BILLING, from: 'draft' });
    expect(await code(h.service.create(OWNER, { goal: 'g', project: '/etc' }))).toBe('project_not_allowed');
  });

  it('an offer expires: past it, a fresh scan decides again', async () => {
    let scanned = CANDIDATES;
    const h = makeService(base, { projects: noDefault({ candidates: () => scanned }) });
    h.service.projectOptions();
    scanned = CANDIDATES.slice(0, 1);
    h.advance(DRAFT_PROJECT_OFFER_TTL_MS - 1);
    await h.service.create(OWNER, { goal: 'g', project: BILLING });
    h.advance(1);
    expect(await code(h.service.create(OWNER, { goal: 'g', project: BILLING }))).toBe('project_not_allowed');
    expect(h.clarify.creates).toBe(1);
  });

  it('the options are the repo picker\'s candidates', () => {
    const h = makeService(base, { projects: noDefault() });
    expect(h.service.projectOptions()).toEqual({ kind: 'pick', candidates: CANDIDATES });
  });
});

describe('编排 Bot 有默认目录：和以前一样', () => {
  const scanned = (): never => { throw new Error('a bot with a default dir is never scanned'); };

  it('the draft clarifies in the default dir, with or without naming it', async () => {
    const h = makeService(base, { projects: { defaultDir: () => DEFAULT_PROJECT, candidates: scanned } });
    const plain = await h.service.create(OWNER, { goal: 'one' });
    const named = await h.service.create(OWNER, { goal: 'two', project: DEFAULT_PROJECT });
    expect(h.clarify.createInputs.map((input) => input.workingDir)).toEqual([DEFAULT_PROJECT, DEFAULT_PROJECT]);
    expect(record(plain.runId).projectDir).toBe(DEFAULT_PROJECT);
    expect(named.project).toEqual({ dir: DEFAULT_PROJECT, from: 'draft' });
    expect(h.service.projectOptions()).toEqual({ kind: 'default', dir: DEFAULT_PROJECT });
  });

  it('another project is refused, even one the repo picker would list', async () => {
    const h = makeService(base, { projects: { defaultDir: () => DEFAULT_PROJECT, candidates: () => CANDIDATES } });
    expect(await code(h.service.create(OWNER, { goal: 'g', project: WEB }))).toBe('project_not_allowed');
    expect(h.clarify.creates).toBe(0);
  });

  it('the project stays the draft\'s when the bot\'s default dir changes later', async () => {
    let dir = DEFAULT_PROJECT;
    const h = makeService(base, { projects: { defaultDir: () => dir, candidates: scanned } });
    const { runId } = await h.service.create(OWNER, { goal: 'g' });
    dir = '/work/elsewhere';
    await disconnect(h, runId);
    await h.service.continueClarify(runId, OWNER);
    expect(h.clarify.createInputs.map((input) => input.workingDir)).toEqual([DEFAULT_PROJECT, DEFAULT_PROJECT]);
  });
});

describe('换编排 Bot：项目跟着草稿走', () => {
  const DOC_OWNER = { openId: 'ou_doc_owner', source: 'dashboard-local' } as const;

  async function handOver(a: ReturnType<typeof makeService>, b: ReturnType<typeof makeService>, runId: string) {
    a.clarify.reply('好的。');
    await a.service.view(runId);
    const { token } = await a.service.prepareHandoff(runId, OWNER, { toLarkAppId: DOC });
    return b.service.acceptHandoff(runId, DOC_OWNER, { token });
  }

  it('the new bot\'s session opens in the draft\'s project, not in its own default dir', async () => {
    const a = makeService(base, { projects: noDefault() });
    const b = makeService(base, { appId: DOC, projects: { defaultDir: () => '/work/doc-home', candidates: () => [] } });
    const { runId } = await a.service.create(OWNER, { goal: 'g', project: WEB });
    const after = await handOver(a, b, runId);
    expect(after.orchestratorAppId).toBe(DOC);
    expect(b.clarify.createInputs.map((input) => input.workingDir)).toEqual([WEB]);
    expect(after.project).toEqual({ dir: WEB, from: 'draft' });
  });

  it('a draft from before projects keeps the old bot\'s default dir when the new bot has none', async () => {
    const a = makeService(base);
    const b = makeService(base, { appId: DOC, projects: noDefault() });
    const { runId } = await a.service.create(OWNER, { goal: 'g' });
    const { projectDir: _drop, ...legacy } = record(runId);
    writeWorkflowDraft(join(base, runId), legacy);
    await handOver(a, b, runId);
    expect(b.clarify.createInputs.map((input) => input.workingDir)).toEqual([DEFAULT_PROJECT]);
    expect(record(runId).projectDir).toBe(DEFAULT_PROJECT);
  });
});

describe('加项目之前建的草稿', () => {
  /** A draft as an older daemon wrote it: no project; its session runs wherever the daemon did. */
  async function legacyDraft() {
    let defaultDir: string | undefined = DEFAULT_PROJECT;
    const h = makeService(base, {
      projects: { defaultDir: () => defaultDir, candidates: () => CANDIDATES, sessionDir: () => DAEMON_CWD },
    });
    const { runId } = await h.service.create(OWNER, { goal: 'g' });
    const { projectDir: _drop, ...legacy } = record(runId);
    writeWorkflowDraft(join(base, runId), legacy);
    defaultDir = undefined;
    return { h, runId };
  }

  it('the page shows where its session actually runs, and that a project is still needed', async () => {
    const { h, runId } = await legacyDraft();
    expect((await h.service.view(runId)).project).toEqual({ dir: DAEMON_CWD, from: 'session', required: true });
  });

  it('「继续」 needs a project picked, then reopens there and keeps it', async () => {
    const { h, runId } = await legacyDraft();
    await disconnect(h, runId);
    expect(await code(h.service.continueClarify(runId, OWNER))).toBe('project_required');
    expect(await code(h.service.continueClarify(runId, OWNER, { project: '/etc' }))).toBe('project_not_allowed');
    await h.service.continueClarify(runId, OWNER, { project: WEB });
    expect(h.clarify.createInputs.at(-1)?.workingDir).toBe(WEB);
    expect(record(runId).projectDir).toBe(WEB);
    expect((await h.service.view(runId)).project).toEqual({ dir: WEB, from: 'draft' });
  });
});
