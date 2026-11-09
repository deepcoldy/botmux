/**
 * 「项目」在页面上：新建表单选完编排 Bot 后，有默认目录的直接显示、没有的必须选；草稿页
 * 头部在编排 Bot 旁边显示项目；加项目之前建的草稿显示澄清会话的实际目录，「继续」前
 * 要选项目。草稿视图来自真实的草稿服务（假的澄清会话）。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

vi.mock('../src/dashboard/web/confirm-modal.js', () => ({ confirm: async () => true }));

import type { WorkflowDraftProjectCandidate, WorkflowDraftView } from '../src/workflows/v3/draft-service.js';
import { readWorkflowDraft, writeWorkflowDraft } from '../src/workflows/v3/draft-store.js';
import { BotSearchPicker } from '../src/dashboard/web/bot-search-picker.js';
import { DEFAULT_PROJECT, DOC, MAIN, OWNER, makeService } from './helpers/workflow-draft-fakes.js';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const WEB = '/work/projects/web-portal';
const BILLING = '/work/projects/billing-service-wt';
const CANDIDATES: WorkflowDraftProjectCandidate[] = [
  { path: WEB, name: 'web-portal', type: 'repo', branch: 'main' },
  { path: BILLING, name: 'billing-service', type: 'worktree', branch: 'feat/invoice' },
];
const BOT_ROWS = [
  { larkAppId: MAIN, name: '有默认目录的Bot', cliId: 'claude-code', online: true },
  { larkAppId: DOC, name: '没设默认目录的Bot', cliId: 'claude-code', online: true },
];

let base: string;
beforeEach(() => { base = mkdtempSync(join(tmpdir(), 'wfd-project-page-')); });
afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(base, { recursive: true, force: true });
});

const location = { hash: '' };
function stubBrowser(hash: string, routes: (url: string, body?: any) => unknown) {
  const sent: Array<{ url: string; body?: any }> = [];
  location.hash = hash;
  vi.stubGlobal('location', location);
  vi.stubGlobal('window', {
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms === 2000 ? 1e9 : ms),
    clearTimeout, setInterval: () => 0, clearInterval: () => {}, location,
  });
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    sent.push({ url, ...(body ? { body } : {}) });
    const answer = url === '/api/settings' ? { settings: { workflow: { enabled: true, nodeExecutor: 'bot' } } }
      : url === '/api/v3/orchestration/initiator' ? { ok: true, initiator: OWNER }
        : url === '/api/v3/orchestration/bots' ? { ok: true, bots: BOT_ROWS }
          : url === `/api/v3/orchestration/projects?larkAppId=${MAIN}` ? { ok: true, project: { kind: 'default', dir: DEFAULT_PROJECT } }
            : url === `/api/v3/orchestration/projects?larkAppId=${DOC}` ? { ok: true, project: { kind: 'pick', candidates: CANDIDATES } }
              : routes(url, body) ?? { ok: false, error: 'not_found' };
    return { ok: (answer as { ok?: boolean }).ok !== false, status: 200, json: async () => answer } as Response;
  });
  return sent;
}
const flush = async () => { for (let i = 0; i < 6; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
const text = (node: TestRenderer.ReactTestInstance): string => node.children.map((c) => typeof c === 'string' ? c : text(c)).join('');

async function renderAt(hash: string, routes: (url: string, body?: any) => unknown = () => undefined) {
  const { V3RunsPage } = await import('../src/dashboard/web/v3-components.js');
  const sent = stubBrowser(hash, routes);
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = TestRenderer.create(React.createElement(V3RunsPage)); });
  await flush();
  return { renderer, sent };
}

describe('新建工作流：项目', () => {
  async function newForm(bot: string) {
    const page = await renderAt('#/workflows/new', (url) => (url === '/api/v3/orchestration/drafts' ? { ok: true, draft: { runId: 'new-1' } } : undefined));
    const picker = page.renderer.root.find((node) => node.type === BotSearchPicker && node.props.id === 'wfd-bot');
    await act(async () => { picker.props.onChange(bot); });
    await flush();
    const goal = page.renderer.root.find((node) => node.type === 'textarea' && node.props.id === 'wfd-goal');
    await act(async () => { goal.props.onChange({ target: { value: '帮我出一份代码风险报告' } }); });
    const start = () => page.renderer.root.find((node) => node.type === 'button' && text(node) === '开始');
    const projectSelect = () => page.renderer.root.findAll((node) => node.type === 'select' && node.props.id === 'wfd-project');
    return { ...page, start, projectSelect };
  }

  it('a bot without a default dir: the project must be picked from the repo picker\'s candidates before 开始', async () => {
    const form = await newForm(DOC);
    const [select] = form.projectSelect();
    expect(select!.props.required).toBe(true);
    expect(select!.props.value).toBe('');
    expect(select!.findAllByType('option').filter((option) => !option.props.disabled).map((option) => option.props.value)).toEqual([WEB, BILLING]);
    expect(text(select!)).toContain('billing-service (feat/invoice) [worktree]');
    expect(form.start().props.disabled).toBe(true);

    await act(async () => { select!.props.onChange({ target: { value: BILLING } }); });
    expect(form.start().props.disabled).toBe(false);
    await act(async () => { form.start().props.onClick(); });
    await flush();
    expect(form.sent.find((call) => call.url === '/api/v3/orchestration/drafts')?.body)
      .toEqual({ larkAppId: DOC, goal: '帮我出一份代码风险报告', project: BILLING });
    act(() => { form.renderer.unmount(); });
  });

  it('a bot with a default dir: 「项目：<目录>」 shown, nothing to pick, the draft goes there', async () => {
    const form = await newForm(MAIN);
    expect(form.projectSelect()).toHaveLength(0);
    const line = form.renderer.root.find((node) => node.props.id === 'wfd-project');
    expect(text(line)).toContain(`项目${DEFAULT_PROJECT}`);
    expect(form.start().props.disabled).toBe(false);
    await act(async () => { form.start().props.onClick(); });
    await flush();
    expect(form.sent.find((call) => call.url === '/api/v3/orchestration/drafts')?.body)
      .toEqual({ larkAppId: MAIN, goal: '帮我出一份代码风险报告', project: DEFAULT_PROJECT });
    act(() => { form.renderer.unmount(); });
  });

  it('switching to another bot drops the project picked for the first', async () => {
    const form = await newForm(DOC);
    await act(async () => { form.projectSelect()[0]!.props.onChange({ target: { value: WEB } }); });
    const picker = form.renderer.root.find((node) => node.type === BotSearchPicker && node.props.id === 'wfd-bot');
    await act(async () => { picker.props.onChange(MAIN); });
    await flush();
    await act(async () => { picker.props.onChange(DOC); });
    await flush();
    expect(form.projectSelect()[0]!.props.value).toBe('');
    expect(form.start().props.disabled).toBe(true);
    act(() => { form.renderer.unmount(); });
  });
});

describe('草稿页头部：项目', () => {
  const meta = (renderer: TestRenderer.ReactTestRenderer) =>
    text(renderer.root.find((node) => node.type === 'div' && node.props.className === 'wfd-meta'));

  async function renderDraft(view: WorkflowDraftView, routes?: (url: string, body?: any) => unknown) {
    return renderAt(`#/workflows/drafts/${view.runId}`, (url, body) =>
      (url === `/api/v3/orchestration/drafts/${encodeURIComponent(view.runId)}` ? { ok: true, draft: view } : routes?.(url, body)));
  }

  it('next to the orchestrating bot: the draft\'s project', async () => {
    const h = makeService(base, { projects: { defaultDir: () => undefined, candidates: () => CANDIDATES } });
    const view = await h.service.create(OWNER, { goal: 'g', project: WEB });
    const { renderer } = await renderDraft(view);
    expect(meta(renderer)).toContain(`项目${WEB}`);
    expect(meta(renderer)).not.toContain('实际目录');
    act(() => { renderer.unmount(); });
  });

  it('a draft from before projects: where its session actually runs; 「继续」 needs a project picked first', async () => {
    let defaultDir: string | undefined = DEFAULT_PROJECT;
    const h = makeService(base, {
      appId: DOC,
      projects: { defaultDir: () => defaultDir, candidates: () => CANDIDATES, sessionDir: () => '/root/.botmux' },
    });
    const { runId } = await h.service.create(OWNER, { goal: 'g' });
    const { projectDir: _drop, ...legacy } = readWorkflowDraft(join(base, runId))!;
    writeWorkflowDraft(join(base, runId), legacy);
    defaultDir = undefined;
    h.clarify.reply('先确认范围？');
    await h.service.view(runId);
    h.clarify.lose('sess-1');
    await h.service.sendMessage(runId, OWNER, { text: '主仓' }).catch(() => {});
    const view = await h.service.view(runId);

    const { renderer, sent } = await renderDraft(view, (url) => (url.endsWith('/clarify/continue') ? { ok: true, draft: view } : undefined));
    expect(meta(renderer)).toContain('项目/root/.botmux澄清会话的实际目录');
    const cont = () => renderer.root.find((node) => node.type === 'button' && text(node) === '继续');
    expect(cont().props.disabled).toBe(true);
    const select = renderer.root.find((node) => node.type === 'select' && node.props.id === 'wfd-continue-project');
    await act(async () => { select.props.onChange({ target: { value: WEB } }); });
    expect(cont().props.disabled).toBe(false);
    await act(async () => { cont().props.onClick(); });
    await flush();
    expect(sent.find((call) => call.url.endsWith('/clarify/continue'))?.body).toMatchObject({ project: WEB });
    act(() => { renderer.unmount(); });
  });
});

describe('daemon 不认页面送的项目（候选在表单打开后变了）：重新拉候选、清掉已选', () => {
  const REFUSED = { ok: false, error: 'project_not_allowed' };
  const projectFetches = (sent: Array<{ url: string }>) =>
    sent.filter((call) => call.url === `/api/v3/orchestration/projects?larkAppId=${DOC}`).length;
  const selectById = (renderer: TestRenderer.ReactTestRenderer, id: string) =>
    renderer.root.find((node) => node.type === 'select' && node.props.id === id);

  it('新建工作流', async () => {
    const { renderer, sent } = await renderAt('#/workflows/new', (url) => (url === '/api/v3/orchestration/drafts' ? REFUSED : undefined));
    const picker = renderer.root.find((node) => node.type === BotSearchPicker && node.props.id === 'wfd-bot');
    await act(async () => { picker.props.onChange(DOC); });
    await flush();
    const goal = renderer.root.find((node) => node.type === 'textarea' && node.props.id === 'wfd-goal');
    await act(async () => { goal.props.onChange({ target: { value: '帮我出一份代码风险报告' } }); });
    await act(async () => { selectById(renderer, 'wfd-project').props.onChange({ target: { value: BILLING } }); });
    expect(projectFetches(sent)).toBe(1);

    await act(async () => { renderer.root.find((node) => node.type === 'button' && text(node) === '开始').props.onClick(); });
    await flush();
    expect(text(renderer.root)).toContain('这个项目不在可选范围里');
    expect(projectFetches(sent)).toBe(2);
    expect(selectById(renderer, 'wfd-project').props.value).toBe('');
    expect(renderer.root.find((node) => node.type === 'button' && text(node) === '开始').props.disabled).toBe(true);
    act(() => { renderer.unmount(); });
  });

  it('老草稿点「继续」', async () => {
    let defaultDir: string | undefined = DEFAULT_PROJECT;
    const h = makeService(base, { appId: DOC, projects: { defaultDir: () => defaultDir, candidates: () => CANDIDATES } });
    const { runId } = await h.service.create(OWNER, { goal: 'g' });
    const { projectDir: _drop, ...legacy } = readWorkflowDraft(join(base, runId))!;
    writeWorkflowDraft(join(base, runId), legacy);
    defaultDir = undefined;
    h.clarify.reply('先确认范围？');
    await h.service.view(runId);
    h.clarify.lose('sess-1');
    await h.service.sendMessage(runId, OWNER, { text: '主仓' }).catch(() => {});
    const view = await h.service.view(runId);

    const { renderer, sent } = await renderAt(`#/workflows/drafts/${runId}`, (url) =>
      (url === `/api/v3/orchestration/drafts/${encodeURIComponent(runId)}` ? { ok: true, draft: view }
        : url.endsWith('/clarify/continue') ? REFUSED : undefined));
    await act(async () => { selectById(renderer, 'wfd-continue-project').props.onChange({ target: { value: WEB } }); });
    expect(projectFetches(sent)).toBe(1);
    await act(async () => { renderer.root.find((node) => node.type === 'button' && text(node) === '继续').props.onClick(); });
    await flush();
    expect(sent.find((call) => call.url.endsWith('/clarify/continue'))?.body).toMatchObject({ project: WEB });
    expect(projectFetches(sent)).toBe(2);
    expect(selectById(renderer, 'wfd-continue-project').props.value).toBe('');
    act(() => { renderer.unmount(); });
  });

  it('复制为新工作流', async () => {
    const sent = stubBrowser('', (url) => (url.endsWith('/drafts/from-source') ? REFUSED : undefined));
    const { CopyWorkflowDialog } = await import('../src/dashboard/web/workflow-copy.js');
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(React.createElement(CopyWorkflowDialog, {
        source: { kind: 'run', runId: 'run-src' }, sourceOrchestratorAppId: DOC, onClose: () => {}, onCopied: () => {},
      }));
    });
    await flush();
    await act(async () => { selectById(renderer, 'wfc-project').props.onChange({ target: { value: BILLING } }); });
    expect(projectFetches(sent)).toBe(1);
    await act(async () => { renderer.root.findAll((node) => node.type === 'button' && text(node) === '复制')[0]!.props.onClick(); });
    await flush();
    expect(sent.find((call) => call.url.endsWith('/drafts/from-source'))?.body).toMatchObject({ project: BILLING });
    expect(text(renderer.root)).toContain('这个项目不在可选范围里');
    expect(projectFetches(sent)).toBe(2);
    expect(selectById(renderer, 'wfc-project').props.value).toBe('');
    act(() => { renderer.unmount(); });
  });
});
