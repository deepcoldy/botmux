/**
 * 工作流模板页面（design 2026-11-03 workflow-dashboard-orchestration §5，D5）：
 * 列表筛选、详情与版本历史（少了 N 道人工确认）、运行表单（必填、类型、两道确认
 * 按来源区分）、保存确认框发出的请求。页面吃的视图来自真实的草稿服务与模板库。
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

vi.mock('../src/dashboard/web/confirm-modal.js', () => ({ confirm: async () => true }));

import {
  buildParamEdit,
  collectTemplateRunParams,
  filterTemplates,
  paramEditTargets,
  templateParamFields,
  templateRunState,
} from '../src/dashboard/web/workflow-library-model.js';
import { parseWorkflowsRoute } from '../src/dashboard/web/workflow-draft-model.js';
import { templateSaveRequest } from '../src/dashboard/web/workflow-library-api.js';
import { loadSavedWorkflowDetailView, listSavedWorkflowCatalogView } from '../src/workflows/v3/library-catalog.js';
import type { SavedWorkflowDetailView } from '../src/workflows/v3/library-catalog.js';
import { BOTS, DOC, MAIN, OWNER, PI, SKETCHES, STEWARD, architectSettled, goalNode, makeService, specMarkdown } from './helpers/workflow-draft-fakes.js';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const GATE = { stage: 'before', prompt: '发出前确认？' };

let root: string;
let base: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'wfl-page-'));
  base = join(root, 'v3-runs');
  mkdirSync(base);
});
afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(root, { recursive: true, force: true });
});

function service() {
  const h = makeService(base, { loadBots: () => BOTS, libraryDataDir: root });
  h.setOnline([MAIN, DOC, STEWARD, PI]);
  return h;
}

async function confirmedDraft(h: ReturnType<typeof makeService>, nodes: unknown[]): Promise<string> {
  h.architect.nodes = nodes;
  const created = await h.service.create(OWNER, { goal: '帮我出一份代码风险报告' });
  h.clarify.reply(`好的。\n<botmux-spec>\n${specMarkdown(SKETCHES)}\n</botmux-spec>`);
  await h.service.finalizeSpec(created.runId, OWNER, {});
  await h.service.approveSpec(created.runId, OWNER);
  await h.service.startArchitect(created.runId, OWNER);
  await architectSettled(h.service, created.runId);
  const view = await h.service.view(created.runId);
  await h.service.approveFlow(created.runId, OWNER, { flowSummarySha256: view.flow!.flowSummarySha256 });
  return created.runId;
}

/** Two versions: v1 gated at `write`, v2 without (I10). */
async function twoVersions(): Promise<SavedWorkflowDetailView> {
  const h = service();
  const first = await confirmedDraft(h, [goalNode('inspect', MAIN), { ...goalNode('write', DOC), humanGate: GATE }]);
  const p1 = await h.service.previewTemplateSave(first, OWNER, { paramEdits: [{ name: 'focus', type: 'string', nodeId: 'inspect', field: 'goal', text: 'inspect' }] });
  const saved = await h.service.saveAsTemplate(first, OWNER, {
    flowSummarySha256: p1.flowSummarySha256, requestKey: 'req-page-001',
    paramEdits: [{ name: 'focus', type: 'string', nodeId: 'inspect', field: 'goal', text: 'inspect' }],
  });
  const second = await confirmedDraft(h, [goalNode('inspect', MAIN), goalNode('write', DOC)]);
  const p2 = await h.service.previewTemplateSave(second, OWNER, { workflowId: saved.workflowId });
  await h.service.saveAsTemplate(second, OWNER, { flowSummarySha256: p2.flowSummarySha256, workflowId: saved.workflowId, expectedLatestRevision: p2.target!.latestRevision });
  return loadSavedWorkflowDetailView(root, saved.workflowId);
}

describe('模板页的纯逻辑', () => {
  it('路由：library 是列表，library/<id> 是详情', () => {
    expect(parseWorkflowsRoute('#/workflows/library')).toEqual({ kind: 'library' });
    expect(parseWorkflowsRoute('#/workflows/library/wf_abc')).toEqual({ kind: 'template', workflowId: 'wf_abc' });
    expect(parseWorkflowsRoute('#/workflows/library/wf_abc/x')).toEqual({ kind: 'library' });
  });

  it('列表按 Bot 和关键字筛；群范围模板只展示', async () => {
    const detail = await twoVersions();
    const { entries } = await listSavedWorkflowCatalogView(root);
    expect(filterTemplates(entries, { bot: MAIN })).toHaveLength(1);
    expect(filterTemplates(entries, { bot: DOC })).toHaveLength(0);
    expect(filterTemplates(entries, { keyword: '风险' })).toHaveLength(1);
    expect(filterTemplates(entries, { keyword: 'nothing' })).toHaveLength(0);
    expect(templateRunState(detail.entry)).toBe('runnable');
    expect(templateRunState({ ...detail.entry, scope: { kind: 'chat', chatId: 'oc_a' } })).toBe('chat_scope');
    expect(templateRunState({ ...detail.entry, runnable: false })).toBe('unpublished');
  });

  it('参数表单：必填未填、数字不是数字的先挡下；空着的不发', () => {
    const fields = templateParamFields({
      focus: { type: 'string', required: true },
      depth: { type: 'number', default: 2 },
      dry: { type: 'boolean', default: false },
    });
    expect(collectTemplateRunParams(fields, {})).toEqual({ params: {}, missing: ['focus'], invalid: [] });
    expect(collectTemplateRunParams(fields, { focus: 'auth', depth: 'deep' })).toEqual({ params: { focus: 'auth', depth: 'deep' }, missing: [], invalid: ['depth'] });
    expect(collectTemplateRunParams(fields, { focus: 'auth', dry: 'true' })).toEqual({ params: { focus: 'auth', dry: 'true' }, missing: [], invalid: [] });
  });

  it('「设为参数」只在节点目标、追加提示、宿主动作输入里出现；按选区算第几处', () => {
    const nodes = [
      { ...goalNode('a', MAIN), goal: '看 auth 和 auth 模块', humanGate: GATE, override: { systemPromptAppend: '只看 auth' } },
      { id: 'send', type: 'host', executor: 'feishu-send', depends: [], inputs: [], input: { text: '报告好了', chatId: { $ref: 'context.chatId' } } },
    ] as any[];
    const targets = paramEditTargets(nodes);
    expect(targets.map((t) => [t.nodeId, t.field, t.inputPath ?? null])).toEqual([
      ['a', 'goal', null], ['a', 'systemPromptAppend', null], ['send', 'input', ['text']],
    ]);
    const goal = targets[0]!;
    const second = goal.text.lastIndexOf('auth');
    const built = buildParamEdit(goal, { start: second, end: second + 4 }, { name: 'module', type: 'string', defaultText: '', description: '' });
    expect(built).toEqual({ ok: true, edit: { name: 'module', type: 'string', nodeId: 'a', field: 'goal', text: 'auth', occurrence: 1 } });
    expect(buildParamEdit(goal, { start: 0, end: 0 }, { name: 'm', type: 'string', defaultText: '', description: '' })).toMatchObject({ ok: false });
    expect(buildParamEdit(goal, { start: 2, end: 6 }, { name: '1bad', type: 'string', defaultText: '', description: '' })).toMatchObject({ ok: false });
    expect(buildParamEdit(goal, { start: 2, end: 6 }, { name: 'n', type: 'number', defaultText: 'x', description: '' })).toMatchObject({ ok: false });
  });

  it('保存请求：草稿带流程摘要哈希，追加带比较过的最新版本，新建带请求键', () => {
    expect(templateSaveRequest({ kind: 'draft', runId: 'r1' }, 'save', { flowSummarySha256: 'sha256:x', requestKey: 'k', displayName: 'n' }))
      .toEqual({ path: '/api/v3/orchestration/drafts/r1/template/save', body: { displayName: 'n', requestKey: 'k', flowSummarySha256: 'sha256:x' } });
    expect(templateSaveRequest({ kind: 'run', runId: 'r1' }, 'save', { workflowId: 'wf_1', expectedLatestRevision: 'rev_1', displayName: 'ignored', requestKey: 'k' }))
      .toEqual({ path: '/api/v3/orchestration/library/runs/r1/save', body: { workflowId: 'wf_1', expectedLatestRevision: 'rev_1', requestKey: 'k' } });
    expect(templateSaveRequest({ kind: 'run', runId: 'r1' }, 'preview', { allowDraft: true }))
      .toEqual({ path: '/api/v3/orchestration/library/runs/r1/save/preview', body: { allowDraft: true } });
  });
});

describe('页面渲染', () => {
  const location = { hash: '' };
  let me: { openId: string; source: string } = OWNER;
  function stubBrowser(hash: string, routes: (url: string, init?: RequestInit) => unknown, switches = { enabled: true, nodeExecutor: 'bot' }) {
    const sent: Array<{ url: string; body?: unknown }> = [];
    location.hash = hash;
    vi.stubGlobal('location', location);
    vi.stubGlobal('window', {
      setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms === 2000 ? 1e9 : ms),
      clearTimeout, setInterval: () => 0, clearInterval: () => {}, location,
    });
    vi.stubGlobal('sessionStorage', { getItem: () => null, setItem: () => {} });
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      sent.push({ url, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
      if (url === '/api/settings') return { ok: true, status: 200, json: async () => ({ settings: { workflow: switches } }) } as Response;
      if (url === '/api/v3/orchestration/initiator') return { ok: true, status: 200, json: async () => ({ ok: true, initiator: me }) } as Response;
      if (url === '/api/v3/orchestration/bots') return { ok: true, status: 200, json: async () => ({ ok: true, bots: [] }) } as Response;
      const body = routes(url, init) ?? { ok: false, error: 'not_found' };
      return { ok: (body as { ok?: boolean }).ok !== false, status: 200, json: async () => body } as Response;
    });
    return sent;
  }
  const flush = async () => { for (let i = 0; i < 8; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
  const text = (node: TestRenderer.ReactTestInstance): string => node.children.map((c) => typeof c === 'string' ? c : text(c)).join('');
  const buttons = (renderer: TestRenderer.ReactTestRenderer, label: string) =>
    renderer.root.findAll((node) => node.type === 'button' && text(node) === label);

  async function renderPage(hash: string, routes: (url: string, init?: RequestInit) => unknown, switches?: { enabled: boolean; nodeExecutor: string }) {
    const { V3RunsPage } = await import('../src/dashboard/web/v3-components.js');
    const sent = stubBrowser(hash, routes, switches);
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => { renderer = TestRenderer.create(React.createElement(V3RunsPage)); });
    await flush();
    return { renderer, sent };
  }

  it('页面不显示 open_id：列表与详情里 owner、保存人、确认人是「你」或「其他管理员」', async () => {
    const detail = await twoVersions();
    const { entries } = await listSavedWorkflowCatalogView(root);
    for (const [who, label] of [[OWNER, '你'], [{ openId: 'ou_someone_else', source: 'dashboard-local' }, '其他管理员']] as const) {
      me = who;
      const list = await renderPage('#/workflows/library', (url) => (url === '/api/v3/orchestration/library' ? { ok: true, templates: entries, unreadable: 0 } : undefined));
      const listText = text(list.renderer.root);
      expect(listText).not.toMatch(/ou_/);
      const row = list.renderer.root.find((node) => node.type === 'tbody').findAll((node) => node.type === 'tr')[0]!;
      expect(text(row)).toContain(label);
      act(() => { list.renderer.unmount(); });
      const page = await renderPage(`#/workflows/library/${detail.entry.workflowId}`, (url) =>
        url.endsWith(`/library/${detail.entry.workflowId}`) ? { ok: true, template: detail } : undefined);
      const pageText = text(page.renderer.root);
      expect(pageText).not.toMatch(/ou_/);
      expect(pageText).toContain(`保存人 ${label}`);
      expect(pageText).toContain(`${label} 于 `);
      act(() => { page.renderer.unmount(); });
    }
    me = OWNER;
  });

  it('详情：版本历史标出「比上一版少了 1 道人工确认」；参数说明；owner 与发起人分开说明', async () => {
    const detail = await twoVersions();
    const { renderer } = await renderPage(`#/workflows/library/${detail.entry.workflowId}`, (url) =>
      url.endsWith(`/library/${detail.entry.workflowId}`) ? { ok: true, template: detail } : undefined);
    const history = renderer.root.find((node) => node.type === 'ol' && node.props.className === 'wfl-versions');
    const rows = history.findAll((node) => node.type === 'li');
    expect(text(rows[0]!)).toContain('比上一版 v1：少了 1 道人工确认（write）');
    expect(text(rows[1]!)).not.toContain('人工确认');
    expect(text(renderer.root)).toContain('每次运行的发起人是点「运行」的人');
    act(() => { renderer.unmount(); });
  });

  it('运行：来源是草稿的版本也直接拉群，不经过确认流程（I13，11-05）', async () => {
    const detail = await twoVersions();
    const created = { runId: 'tmpl-run-1', version: 1, phase: 'flow_confirmed', title: detail.entry.displayName };
    const { renderer, sent } = await renderPage(`#/workflows/library/${detail.entry.workflowId}`, (url) => {
      if (url.endsWith(`/library/${detail.entry.workflowId}`)) return { ok: true, template: detail };
      if (url.endsWith(`/library/${detail.entry.workflowId}/run`)) return { ok: true, draft: created };
      if (url.endsWith('/launch')) return { ok: true, draft: { ...created, phase: 'launching' } };
      return undefined;
    });
    // v2 (the published one) has no parameters of its own; it is draft-born.
    expect(detail.entry.savedFromDraft).toBe(true);
    expect(text(renderer.root)).not.toContain('确认流程」');
    await act(async () => { buttons(renderer, '拉群开始')[0]!.props.onClick(); });
    await flush();
    expect(sent.find((call) => call.url.endsWith('/run'))?.body).toEqual({ params: {}, expectedRevisionId: detail.current.revisionId });
    expect(sent.find((call) => call.url.endsWith('/launch'))?.body).toEqual({ baseVersion: 1 });
    expect(location.hash).toBe('#/workflows/drafts/tmpl-run-1');
    act(() => { renderer.unmount(); });
  });

  it('运行：来源是已结束运行的版本，填好参数后建草稿并直接拉群', async () => {
    const detail = await twoVersions();
    const fromRun: SavedWorkflowDetailView = {
      ...detail,
      entry: { ...detail.entry, savedFromDraft: false },
      current: { ...detail.current, inputs: { focus: { type: 'string', required: true }, depth: { type: 'number', default: 2 } } },
    };
    const created = { runId: 'tmpl-run-2', version: 3, phase: 'flow_confirmed', title: detail.entry.displayName };
    const { renderer, sent } = await renderPage(`#/workflows/library/${detail.entry.workflowId}`, (url) => {
      if (url.endsWith(`/library/${detail.entry.workflowId}`)) return { ok: true, template: fromRun };
      if (url.endsWith('/run')) return { ok: true, draft: created };
      if (url.endsWith('/launch')) return { ok: true, draft: { ...created, phase: 'launching' } };
      return undefined;
    });
    await act(async () => { buttons(renderer, '拉群开始')[0]!.props.onClick(); });
    await flush();
    expect(sent.some((call) => call.url.endsWith('/run'))).toBe(false);
    const focus = renderer.root.find((node) => node.type === 'input' && node.props.id === 'wfl-param-focus');
    expect(focus.props['aria-invalid']).toBe(true);
    await act(async () => { focus.props.onChange({ target: { value: 'auth' } }); });
    const depth = renderer.root.find((node) => node.type === 'input' && node.props.id === 'wfl-param-depth');
    await act(async () => { depth.props.onChange({ target: { value: '3' } }); });
    await act(async () => { buttons(renderer, '拉群开始')[0]!.props.onClick(); });
    await flush();
    expect(sent.find((call) => call.url.endsWith('/run'))?.body).toEqual({ params: { focus: 'auth', depth: '3' }, expectedRevisionId: detail.current.revisionId });
    expect(sent.find((call) => call.url.endsWith('/launch'))?.body).toEqual({ baseVersion: 3 });
    act(() => { renderer.unmount(); });
  });

  it('群范围模板：只展示，没有运行按钮', async () => {
    const detail = await twoVersions();
    const chat: SavedWorkflowDetailView = { ...detail, entry: { ...detail.entry, scope: { kind: 'chat', chatId: 'oc_a' }, runnable: false } };
    const { renderer } = await renderPage(`#/workflows/library/${detail.entry.workflowId}`, (url) =>
      url.endsWith(`/library/${detail.entry.workflowId}`) ? { ok: true, template: chat } : undefined);
    expect(text(renderer.root)).toContain('群范围的模板只能在原群里用 /workflow run 运行');
    expect(buttons(renderer, '拉群开始')).toHaveLength(0);
    act(() => { renderer.unmount(); });
  });

  it('开关关：模板页不出现（落回运行列表），列表页没有「模板」入口', async () => {
    const detail = await twoVersions();
    const { renderer, sent } = await renderPage(`#/workflows/library/${detail.entry.workflowId}`, () => ({ ok: true, runs: [] }), { enabled: false, nodeExecutor: 'bot' });
    expect(sent.some((call) => call.url.startsWith('/api/v3/orchestration/library'))).toBe(false);
    expect(renderer.root.findAll((node) => node.type === 'a' && node.props.href === '#/workflows/library')).toHaveLength(0);
    act(() => { renderer.unmount(); });
  });

  it('保存确认框（草稿）：再显示一次流程摘要，保存带上它的哈希与请求键', async () => {
    const h = service();
    const runId = await confirmedDraft(h, [goalNode('inspect', MAIN), goalNode('write', DOC)]);
    const view = await h.service.view(runId);
    const preview = await h.service.previewTemplateSave(runId, OWNER, {});
    const { renderer, sent } = await renderPage(`#/workflows/drafts/${runId}`, (url) => {
      if (url.endsWith(`/drafts/${runId}`)) return { ok: true, draft: view };
      if (url.endsWith('/template/preview')) return { ok: true, preview };
      if (url.endsWith('/template/save')) return { ok: true, saved: { workflowId: 'wf_x', revisionId: 'rev_x', humanVersion: 1, created: true } };
      return undefined;
    });
    await act(async () => { buttons(renderer, '存为模板')[0]!.props.onClick(); });
    await flush();
    const dialog = renderer.root.find((node) => node.props.role === 'dialog');
    expect(text(dialog)).toContain('inspect → ');
    await act(async () => { buttons(renderer, '保存为新模板')[0]!.props.onClick(); });
    await flush();
    const body = sent.find((call) => call.url.endsWith('/template/save'))!.body as Record<string, unknown>;
    expect(body).toMatchObject({ flowSummarySha256: preview.flowSummarySha256, displayName: preview.displayName });
    expect(body.requestKey).toMatch(/^[a-z0-9]{24}$/);
    expect(text(renderer.root)).toContain('已保存为 v1');
    act(() => { renderer.unmount(); });
  });
});
