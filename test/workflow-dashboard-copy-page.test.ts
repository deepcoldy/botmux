/**
 * 基于历史创建的页面（design 2026-11-03 workflow-dashboard-orchestration §6，
 * D6）：运行详情页 / 模板详情页的「复制为新工作流」发出的请求、复制出的草稿页
 * （复制自、未结束提示、改目标的两个选项、确认需求后直达流程图）、开关关时没有
 * 入口。页面吃的视图来自真实的草稿服务、模板库与来源 run。
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

vi.mock('../src/dashboard/web/confirm-modal.js', () => ({ confirm: async () => true }));

import { draftSections } from '../src/dashboard/web/workflow-draft-model.js';
import { canEditCopyGoal, canEditCopyNodes, copyGoalMode } from '../src/dashboard/web/workflow-copy-model.js';
import { copyRequest, draftActionRequest } from '../src/dashboard/web/workflow-draft-api.js';
import { loadSavedWorkflowDetailView } from '../src/workflows/v3/library-catalog.js';
import { ui } from '../src/dashboard/web/ui.js';
import { BotSearchPicker } from '../src/dashboard/web/bot-search-picker.js';
import { BOTS, DEFAULT_PROJECT, DOC, MAIN, OWNER, PI, SKETCHES, STEWARD, architectSettled, makeService, specMarkdown } from './helpers/workflow-draft-fakes.js';
import { REVIEW, seedRun } from './helpers/workflow-copy-fakes.js';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const FLEET = [...BOTS, { larkAppId: REVIEW, larkAppSecret: 's-rv', name: 'review', cliId: 'claude-code' }] as any[];
const RUN = 'src-261101-080000-000-aaaa0001';

let root: string;
let base: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'wfc-page-'));
  base = join(root, 'v3-runs');
  mkdirSync(base);
});
afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(root, { recursive: true, force: true });
});

function service() {
  const h = makeService(base, { loadBots: () => FLEET, libraryDataDir: root });
  h.setOnline([MAIN, DOC, REVIEW, STEWARD, PI]);
  return h;
}

async function templateWithTwoVersions(h: ReturnType<typeof makeService>) {
  const confirmed = async () => {
    const created = await h.service.create(OWNER, { goal: '帮我出一份代码风险报告' });
    h.clarify.reply(`好的。\n<botmux-spec>\n${specMarkdown(SKETCHES)}\n</botmux-spec>`);
    await h.service.finalizeSpec(created.runId, OWNER, {});
    await h.service.approveSpec(created.runId, OWNER);
    await h.service.startArchitect(created.runId, OWNER);
    await architectSettled(h.service, created.runId);
    const view = await h.service.view(created.runId);
    await h.service.approveFlow(created.runId, OWNER, { flowSummarySha256: view.flow!.flowSummarySha256 });
    return created.runId;
  };
  const first = await confirmed();
  const p1 = await h.service.previewTemplateSave(first, OWNER, {});
  const saved = await h.service.saveAsTemplate(first, OWNER, { flowSummarySha256: p1.flowSummarySha256, requestKey: 'req-page-001' });
  const second = await confirmed();
  const p2 = await h.service.previewTemplateSave(second, OWNER, { workflowId: saved.workflowId });
  await h.service.saveAsTemplate(second, OWNER, { flowSummarySha256: p2.flowSummarySha256, workflowId: saved.workflowId, expectedLatestRevision: p2.target!.latestRevision });
  return loadSavedWorkflowDetailView(root, saved.workflowId);
}

describe('页面的纯逻辑', () => {
  it('复制请求：来源原样带上，选了编排 Bot 才带 larkAppId；改目标的两个选项映射到三种模式', () => {
    expect(copyRequest({ kind: 'run', runId: RUN })).toEqual({ path: '/api/v3/orchestration/drafts/from-source', body: { source: { kind: 'run', runId: RUN } } });
    expect(copyRequest({ kind: 'template', workflowId: 'wf_a', revisionId: 'rev_b' }, DOC).body)
      .toEqual({ source: { kind: 'template', workflowId: 'wf_a', revisionId: 'rev_b' }, larkAppId: DOC });
    expect(copyGoalMode({ kind: 'text_only' })).toBe('text_only');
    expect(copyGoalMode({ kind: 'reorchestrate', reclarify: true })).toBe('reclarify');
    expect(copyGoalMode({ kind: 'reorchestrate', reclarify: false })).toBe('rearchitect');
    expect(draftActionRequest('r1', { kind: 'copy-goal', goal: 'g', mode: 'text_only' }, 4))
      .toEqual({ path: '/api/v3/orchestration/drafts/r1/copy/goal', body: { goal: 'g', mode: 'text_only', baseVersion: 4 } });
    expect(draftActionRequest('r1', { kind: 'node-text', nodeId: 'loop.a', completion: '' }, 2))
      .toEqual({ path: '/api/v3/orchestration/drafts/r1/nodes/loop.a/text', body: { completion: '', baseVersion: 2 } });
  });

  it('复制的草稿：没开过会话时不显示对话面板；改目标只在待确认需求、改节点只在流程阶段', async () => {
    const h = service();
    seedRun(base, RUN, { status: 'running', revised: true });
    const copied = await h.service.createFromSource(OWNER, { source: { kind: 'run', runId: RUN } });
    expect(draftSections(copied)).toMatchObject({ copy: true, chat: false, spec: true, architect: false, flow: false });
    expect(canEditCopyGoal(copied, true)).toBe(true);
    expect(canEditCopyGoal(copied, false)).toBe(false);
    expect(canEditCopyNodes(copied, true)).toBe(false);
    const flow = await h.service.approveSpec(copied.runId, OWNER);
    expect(draftSections(flow)).toMatchObject({ copy: true, chat: false, flow: true });
    expect(canEditCopyGoal(flow, true)).toBe(false);
    expect(canEditCopyNodes(flow, true)).toBe(true);
    const back = await h.service.reviseSpec(copied.runId, OWNER);
    expect(draftSections(back).chat).toBe(true);
  });
});

describe('页面渲染', () => {
  const location = { hash: '' };
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
      if (url === '/api/v3/orchestration/initiator') return { ok: true, status: 200, json: async () => ({ ok: true, initiator: OWNER }) } as Response;
      if (url === '/api/v3/orchestration/bots') {
        return { ok: true, status: 200, json: async () => ({ ok: true, bots: [{ larkAppId: MAIN, name: '主Bot', cliId: 'claude-code', online: true }, { larkAppId: DOC, name: '文档Bot', cliId: 'claude-code', online: true }] }) } as Response;
      }
      if (url.startsWith('/api/v3/orchestration/projects?')) {
        return { ok: true, status: 200, json: async () => ({ ok: true, project: { kind: 'default', dir: DEFAULT_PROJECT } }) } as Response;
      }
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

  const runView = { runId: RUN, runStatus: 'running', nodes: [] };

  it('运行详情页：「复制为新工作流」（未结束也有）发出来源，复制好跳到新草稿', async () => {
    ui.authed = true;
    const { renderer, sent } = await renderPage(`#/workflows/${RUN}`, (url) => {
      if (url === `/api/v3/runs/${RUN}`) return runView;
      if (url.endsWith('/drafts/from-source')) return { ok: true, draft: { runId: 'copy-1' } };
      return undefined;
    });
    await act(async () => { buttons(renderer, '复制为新工作流')[0]!.props.onClick(); });
    await flush();
    const dialog = renderer.root.find((node) => node.props.role === 'dialog');
    expect(text(dialog)).toContain('两道确认');
    await act(async () => { buttons(renderer, '复制')[0]!.props.onClick(); });
    await flush();
    expect(sent.find((call) => call.url.endsWith('/drafts/from-source'))?.body).toEqual({ source: { kind: 'run', runId: RUN }, project: DEFAULT_PROJECT });
    expect(location.hash).toBe('#/workflows/drafts/copy-1');
    act(() => { renderer.unmount(); });
  });

  it('模板详情页：标题区复制当前版本，版本历史里复制更早的版本；可以换编排 Bot', async () => {
    const detail = await templateWithTwoVersions(service());
    const older = detail.versions.find((version) => version.revisionId !== detail.current.revisionId)!;
    const { renderer, sent } = await renderPage(`#/workflows/library/${detail.entry.workflowId}`, (url) => {
      if (url.endsWith(`/library/${detail.entry.workflowId}`)) return { ok: true, template: detail };
      if (url.endsWith('/drafts/from-source')) return { ok: true, draft: { runId: 'copy-2' } };
      return undefined;
    });
    expect(text(renderer.root)).not.toMatch(/ou_/);
    await act(async () => { buttons(renderer, '复制此版本')[0]!.props.onClick(); });
    await flush();
    const picker = renderer.root.find((node) => node.type === BotSearchPicker && node.props.id === 'wfc-bot');
    expect(text(picker)).toContain('与来源相同（主Bot）');
    await act(async () => { picker.props.onChange(DOC); });
    await act(async () => { buttons(renderer, '复制')[0]!.props.onClick(); });
    await flush();
    expect(sent.find((call) => call.url.endsWith('/drafts/from-source'))?.body)
      .toEqual({ source: { kind: 'template', workflowId: detail.entry.workflowId, revisionId: older.revisionId }, larkAppId: DOC, project: DEFAULT_PROJECT });
    act(() => { renderer.unmount(); });
  });

  it('开关关：运行详情页没有「复制为新工作流」，也不发复制请求', async () => {
    const { renderer, sent } = await renderPage(`#/workflows/${RUN}`, (url) => (url === `/api/v3/runs/${RUN}` ? runView : undefined), { enabled: false, nodeExecutor: 'bot' });
    expect(buttons(renderer, '复制为新工作流')).toHaveLength(0);
    expect(sent.some((call) => call.url.includes('/orchestration/drafts'))).toBe(false);
    act(() => { renderer.unmount(); });
  });

  it('复制的草稿页：复制自、未结束提示、预填流程；改目标「按新目标重新编排」发出对应模式；确认需求后直达流程图', async () => {
    const h = service();
    seedRun(base, RUN, { status: 'running', revised: true });
    const copied = await h.service.createFromSource(OWNER, { source: { kind: 'run', runId: RUN } });
    let current = copied;
    const { renderer, sent } = await renderPage(`#/workflows/drafts/${copied.runId}`, (url) => {
      if (url.endsWith(`/drafts/${copied.runId}`)) return { ok: true, draft: current };
      if (url.endsWith('/copy/goal')) return { ok: true, draft: current };
      if (url.endsWith('/approve-spec')) return { ok: true, draft: current };
      return undefined;
    });
    const page = text(renderer.root);
    expect(page).toContain(`复制自运行 ${RUN}`);
    expect(page).toContain('来源 run 尚未结束，复制的是复制时的版本');
    expect(page).toContain('确认需求后直接使用复制来的流程（3 个节点）');
    expect(page).not.toMatch(/ou_/);
    // No empty chat panel for a copy without a session.
    expect(renderer.root.findAll((node) => node.props.id === 'wfd-chat-title')).toHaveLength(0);

    const goal = renderer.root.find((node) => node.type === 'textarea' && node.props.id === 'wfc-goal-text');
    await act(async () => { goal.props.onChange({ target: { value: '只看安全问题' } }); });
    const reorchestrate = renderer.root.findAll((node) => node.type === 'input' && node.props.name === 'wfc-mode')[1]!;
    await act(async () => { reorchestrate.props.onChange(); });
    const direct = renderer.root.findAll((node) => node.type === 'input' && node.props.name === 'wfc-sub')[1]!;
    await act(async () => { direct.props.onChange(); });
    await act(async () => { buttons(renderer, '应用')[0]!.props.onClick(); });
    await flush();
    expect(sent.find((call) => call.url.endsWith('/copy/goal'))?.body).toEqual({ goal: '只看安全问题', mode: 'rearchitect', baseVersion: copied.version });

    // 确认需求: the daemon answers 待确认流程 — the page shows the flow and starts no Architect.
    current = await h.service.approveSpec(copied.runId, OWNER);
    await act(async () => { buttons(renderer, '确认需求')[0]!.props.onClick(); });
    await flush();
    expect(sent.some((call) => call.url.endsWith('/architect'))).toBe(false);
    expect(renderer.root.findAll((node) => node.props.id === 'wfd-flow-title')).toHaveLength(1);
    act(() => { renderer.unmount(); });
  });
});

describe('复核修复的页面（D6）', () => {
  const text = (node: TestRenderer.ReactTestInstance): string => node.children.map((c) => typeof c === 'string' ? c : text(c)).join('');
  const flush = async () => { for (let i = 0; i < 8; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
  async function render(view: unknown) {
    const location = { hash: `#/workflows/drafts/${(view as { runId: string }).runId}` };
    vi.stubGlobal('location', location);
    vi.stubGlobal('window', { setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms === 2000 ? 1e9 : ms), clearTimeout, setInterval: () => 0, clearInterval: () => {}, location });
    vi.stubGlobal('sessionStorage', { getItem: () => null, setItem: () => {} });
    vi.stubGlobal('fetch', async (url: string) => {
      const body = url === '/api/settings' ? { settings: { workflow: { enabled: true, nodeExecutor: 'bot' } } }
        : url === '/api/v3/orchestration/initiator' ? { ok: true, initiator: OWNER }
          : url === '/api/v3/orchestration/bots' ? { ok: true, bots: [] }
            : url.includes('/drafts/') ? { ok: true, draft: view } : { ok: false, error: 'not_found' };
      return { ok: (body as { ok?: boolean }).ok !== false, status: 200, json: async () => body } as Response;
    });
    const { V3RunsPage } = await import('../src/dashboard/web/v3-components.js');
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => { renderer = TestRenderer.create(React.createElement(V3RunsPage)); });
    await flush();
    return renderer;
  }

  it('节点需换 Bot：草稿页列出原因，流程图上标出；需求改过时提示将重新编排', async () => {
    const h = service();
    seedRun(base, RUN);
    h.setOnline([MAIN, REVIEW]);
    const copied = await h.service.createFromSource(OWNER, { source: { kind: 'run', runId: RUN } });
    const flow = await h.service.approveSpec(copied.runId, OWNER);
    const renderer = await render(flow);
    const page = text(renderer.root);
    expect(page).toContain('这些节点要换执行 Bot');
    expect(page).toContain('⚠️ 需换执行 Bot');
    act(() => { renderer.unmount(); });

    seedRun(base, 'src-261101-080000-000-aaaa0031');
    const other = await h.service.createFromSource(OWNER, { source: { kind: 'run', runId: 'src-261101-080000-000-aaaa0031' } });
    const edited = await h.service.finalizeSpec(other.runId, OWNER, { specMarkdown: specMarkdown(SKETCHES, { title: '另一份需求' }) });
    const stale = await render(edited.draft);
    expect(text(stale.root)).toContain('确认需求后将按新需求重新编排');
    const textOnly = stale.root.findAll((node) => node.type === 'input' && node.props.name === 'wfc-mode')[0]!;
    expect(textOnly.props.disabled).toBe(true);
    act(() => { stale.unmount(); });
  });
});

describe('复制对话框：选过别的 Bot 后回到「与来源相同」', () => {
  const text = (node: TestRenderer.ReactTestInstance): string => node.children.map((c) => typeof c === 'string' ? c : text(c)).join('');
  const flush = async () => { for (let i = 0; i < 8; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };

  async function dialog(bots: unknown[], sourceOrchestratorAppId: string) {
    const sent: Array<{ url: string; body?: unknown }> = [];
    vi.stubGlobal('window', { setTimeout, clearTimeout, location: { hash: '' } });
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      sent.push({ url, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
      if (url === '/api/v3/orchestration/bots') return { ok: true, status: 200, json: async () => ({ ok: true, bots }) } as Response;
      if (url.startsWith('/api/v3/orchestration/projects?')) return { ok: true, status: 200, json: async () => ({ ok: true, project: { kind: 'default', dir: DEFAULT_PROJECT } }) } as Response;
      return { ok: true, status: 200, json: async () => ({ ok: true, draft: { runId: 'copy-9' } }) } as Response;
    });
    const { CopyWorkflowDialog } = await import('../src/dashboard/web/workflow-copy.js');
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(React.createElement(CopyWorkflowDialog, {
        source: { kind: 'run', runId: RUN }, sourceOrchestratorAppId, onClose: () => {}, onCopied: () => {},
      }));
    });
    await flush();
    const picker = () => renderer.root.find((node) => node.type === BotSearchPicker && node.props.id === 'wfc-bot');
    const resets = () => renderer.root.findAll((node) => node.type === 'button' && String(node.props.className ?? '').includes('btn-link') && text(node).startsWith('与来源相同'));
    const submit = async () => {
      await act(async () => { renderer.root.findAll((node) => node.type === 'button' && text(node) === '复制')[0]!.props.onClick(); });
      await flush();
      return sent.filter((call) => call.url.endsWith('/drafts/from-source')).at(-1)?.body;
    };
    return { renderer, picker, resets, submit };
  }

  it.each([
    ['the source bot is offline (its option cannot be picked)', [
      { larkAppId: MAIN, name: '主Bot', cliId: 'claude-code', online: false, unavailable: { code: 'offline', why: 'daemon 不在线' } },
      { larkAppId: DOC, name: '文档Bot', cliId: 'claude-code', online: true },
    ]],
    ['the source bot is not in the list at all', [
      { larkAppId: DOC, name: '文档Bot', cliId: 'claude-code', online: true },
    ]],
  ])('%s', async (_name, bots) => {
    const d = await dialog(bots, MAIN);
    expect(text(d.picker())).toContain('与来源相同');
    expect(d.resets()).toHaveLength(0);
    await act(async () => { d.picker().props.onChange(DOC); });
    expect(d.resets()).toHaveLength(1);
    await act(async () => { d.resets()[0]!.props.onClick(); });
    expect(text(d.picker())).toContain('与来源相同');
    expect(await d.submit()).toEqual({ source: { kind: 'run', runId: RUN }, project: DEFAULT_PROJECT });
    act(() => { d.renderer.unmount(); });
  });
});
