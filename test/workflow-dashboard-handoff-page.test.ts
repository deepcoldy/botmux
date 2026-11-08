/**
 * The draft page after a failed orchestrator model call: which bot, why (in
 * words), the two ways out (another orchestrating bot / its model settings),
 * the searchable pickers with the "最近一次调用模型失败" hint. Views come from
 * the real draft service (fake clarify session).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

vi.mock('../src/dashboard/web/confirm-modal.js', () => ({ confirm: async () => true }));

import type { WorkflowDraftView } from '../src/workflows/v3/draft-service.js';
import { readWorkflowDraft, writeWorkflowDraft, type WorkflowDraftInitiator } from '../src/workflows/v3/draft-store.js';
import { BotSearchPicker } from '../src/dashboard/web/bot-search-picker.js';
import { workflowOrchestratorBotOptions } from '../src/dashboard/workflow-drafts-api.js';
import { BOTS, DOC, MAIN, OWNER, STEWARD, makeService } from './helpers/workflow-draft-fakes.js';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const ALICE: WorkflowDraftInitiator = { openId: 'ou_alice', unionId: 'on_alice', source: 'dashboard-platform' };
const FLEET = BOTS.map((bot) => (bot.larkAppId === MAIN ? { ...bot, model: 'demo-model-x' } : bot));
const NAMES: Record<string, string> = { [MAIN]: '编排一号', [DOC]: '文档Bot', [STEWARD]: '管家Bot' };

let base: string;
beforeEach(() => { base = mkdtempSync(join(tmpdir(), 'wfd-handoff-page-')); });
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
    const answer = routes(url, body) ?? { ok: false, error: 'not_found' };
    return { ok: (answer as { ok?: boolean }).ok !== false, status: 200, json: async () => answer } as Response;
  });
  return sent;
}
const flush = async () => { for (let i = 0; i < 6; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
const text = (node: TestRenderer.ReactTestInstance): string => node.children.map((c) => typeof c === 'string' ? c : text(c)).join('');
const buttonByText = (renderer: TestRenderer.ReactTestRenderer, label: string) =>
  renderer.root.findAll((node) => node.type === 'button' && text(node) === label);

/** The orchestrator picker rows as the Dashboard serves them, with DOC's last model call failed. */
function botRows() {
  return workflowOrchestratorBotOptions(FLEET, () => true, (appId) => NAMES[appId] ?? appId, new Map([
    [DOC, { category: 'quota' as const, step: 'clarify_turn' as const, larkAppId: DOC, at: '2026-11-06T01:00:00.000Z' }],
  ]));
}

async function render(view: WorkflowDraftView, me: WorkflowDraftInitiator, answer: (url: string, body?: any) => unknown = () => undefined) {
  const { V3RunsPage } = await import('../src/dashboard/web/v3-components.js');
  const sent = stubBrowser(`#/workflows/drafts/${view.runId}`, (url, body) => {
    if (url === '/api/v3/orchestration/initiator') return { ok: true, initiator: body?.larkAppId === MAIN ? me : { ...me, openId: `${me.openId}_doc` } };
    if (url === '/api/v3/orchestration/bots') return { ok: true, bots: botRows() };
    if (url === `/api/v3/orchestration/drafts/${encodeURIComponent(view.runId)}`) return { ok: true, draft: view };
    return answer(url, body);
  });
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = TestRenderer.create(React.createElement(V3RunsPage)); });
  await flush();
  return { renderer, sent };
}

async function failedView(initiator: WorkflowDraftInitiator) {
  const h = makeService(base, { loadBots: () => FLEET });
  const { runId } = await h.service.create(initiator, { goal: '参考历史生成 workflow' });
  h.clarify.fail('provider_authentication_failed', 'worker reported terminal failure: provider_authentication_failed');
  return { h, runId, view: await h.service.view(runId) };
}

const failurePanel = (renderer: TestRenderer.ReactTestRenderer) =>
  renderer.root.find((node) => node.type === 'section' && String(node.props.className).includes('wfd-failure'));

describe('草稿页：编排失败的提示与出路', () => {
  it('哪个 Bot（显示名 + CLI）、原因分类作标题、配置了才显示模型、原始报错可展开、能看终端才给「打开终端」；两个出路', async () => {
    const { h, view } = await failedView(ALICE);
    const sessionId = [...h.clarify.sessions.keys()][0]!;
    expect(view.failure?.sessionId).toBe(sessionId);
    const { renderer, sent } = await render(view, ALICE, (url) => (
      url === `/api/sessions/${encodeURIComponent(sessionId)}/view-link` ? { ok: true, url: `/s/${sessionId}/?viewToken=v1`, expiresAt: 1 } : undefined
    ));
    const panel = failurePanel(renderer);
    const words = text(panel);
    expect(text(panel.find((node) => node.type === 'h2'))).toContain('模型凭据没有权限或鉴权失败');
    expect(words).toContain('编排一号（claude-code）');
    expect(words).toContain('demo-model-x');
    expect(words).toContain('provider_authentication_failed');
    const raw = panel.find((node) => node.type === 'details');
    expect(text(raw)).toContain('worker reported terminal failure: provider_authentication_failed');
    expect(sent.some((call) => call.url === `/api/sessions/${encodeURIComponent(sessionId)}/view-link`)).toBe(true);
    const links = panel.findAll((node) => node.type === 'a');
    const terminal = links.find((node) => text(node) === '打开终端查看');
    expect(terminal?.props.href).toContain(`/s/${sessionId}/?viewToken=v1`);
    expect(terminal?.props.target).toBe('_blank');
    const settings = links.find((node) => String(node.props.href).includes('#/bot-defaults?'))!;
    expect(settings.props.href).toContain(`bot=${MAIN}`);
    expect(buttonByText(renderer, '换一个编排 Bot 重试')).toHaveLength(1);
    act(() => { renderer.unmount(); });
  });

  it('没有查看终端权限（view-link 被拒）：不给终端链接；Bot 没配 model：不显示模型', async () => {
    const h = makeService(base, { loadBots: () => BOTS });
    const { runId } = await h.service.create(ALICE, { goal: 'g' });
    h.clarify.fail('provider_authentication_failed', 'worker reported terminal failure: provider_authentication_failed');
    const view = await h.service.view(runId);
    const { renderer, sent } = await render(view, ALICE, (url) => (url.endsWith('/view-link') ? { ok: false, error: 'forbidden' } : undefined));
    const panel = failurePanel(renderer);
    expect(sent.some((call) => call.url.endsWith('/view-link'))).toBe(true);
    expect(panel.findAll((node) => node.type === 'a' && text(node) === '打开终端查看')).toHaveLength(0);
    expect(panel.findAll((node) => node.type === 'dt').map(text)).not.toContain('模型');
    act(() => { renderer.unmount(); });
  });

  it('换编排 Bot：可搜索的选择器不含当前 Bot，管家不可选带原因，最近失败的带提示；选中先查发起人，确认发出 /orchestrator', async () => {
    const { view } = await failedView(ALICE);
    const moved = { ...view, orchestratorAppId: DOC };
    const { renderer, sent } = await render(view, ALICE, (url) => (url.endsWith('/orchestrator') ? { ok: true, draft: moved } : undefined));
    await act(async () => { buttonByText(renderer, '换一个编排 Bot 重试')[0]!.props.onClick(); });
    const picker = renderer.root.find((node) => node.type === BotSearchPicker && node.props.id === 'wfd-switch-bot');
    const options = picker.props.options as Array<{ larkAppId: string; disabledWhy?: string; hint?: string }>;
    expect(options.map((option) => option.larkAppId)).not.toContain(MAIN);
    expect(options.find((option) => option.larkAppId === STEWARD)?.disabledWhy).toBeTruthy();
    expect(options.find((option) => option.larkAppId === DOC)?.hint).toContain('最近一次调用模型失败');
    const confirmButton = () => buttonByText(renderer, '换成这个 Bot')[0]!;
    expect(confirmButton().props.disabled).toBe(true);
    await act(async () => { picker.props.onChange(DOC); });
    await flush();
    expect(sent.some((call) => call.url === '/api/v3/orchestration/initiator' && call.body?.larkAppId === DOC)).toBe(true);
    expect(confirmButton().props.disabled).toBe(false);
    await act(async () => { confirmButton().props.onClick(); });
    await flush();
    expect(sent.find((call) => call.url.endsWith(`/drafts/${encodeURIComponent(view.runId)}/orchestrator`))?.body)
      .toEqual({ larkAppId: DOC, baseVersion: view.version });
    expect(text(renderer.root)).toContain('编排 Bot 已换成 文档Bot');
    act(() => { renderer.unmount(); });
  });

  it('本机令牌登录的草稿：也给换编排 Bot', async () => {
    const { view } = await failedView(OWNER);
    const { renderer } = await render(view, OWNER);
    expect(buttonByText(renderer, '换一个编排 Bot 重试')).toHaveLength(1);
    expect(text(failurePanel(renderer))).not.toContain('本机令牌登录');
    act(() => { renderer.unmount(); });
  });

  it('交接记录：从哪个 Bot 到哪个 Bot、确认人改写到哪个应用下，不显示 open_id', async () => {
    const { view } = await failedView(ALICE);
    const handed = {
      ...view,
      handoffs: [{
        fromAppId: MAIN, toAppId: DOC, at: '2026-11-06T01:00:00.000Z',
        by: { source: 'dashboard-platform' as const, fromOpenId: 'ou_alice', toOpenId: 'ou_alice_doc', unionId: 'on_alice' },
        specConfirmation: { fromOpenId: 'ou_alice', toOpenId: 'ou_alice_doc' },
      }],
    };
    const { renderer } = await render(handed, ALICE);
    const history = renderer.root.find((node) => node.type === 'details' && String(node.props.className).includes('wfd-handoffs'));
    const words = text(history);
    expect(words).toContain('编排 Bot 从 编排一号 换成 文档Bot');
    expect(words).toContain('「确认需求」的确认人改为 文档Bot 应用下的发起人身份');
    expect(words).not.toMatch(/ou_|on_alice/);
    act(() => { renderer.unmount(); });
  });

  it('旧草稿（只有报错字符串）：原因按「未知」，只显示错误码', async () => {
    const { h, runId } = await failedView(ALICE);
    const runDir = join(base, runId);
    const old = readWorkflowDraft(runDir)!;
    delete old.failure;
    delete old.modelCalls;
    old.clarify.error = 'worker reported terminal failure: provider_authentication_failed';
    writeWorkflowDraft(runDir, old);
    const { renderer } = await render(await h.service.view(runId), ALICE);
    const words = text(failurePanel(renderer));
    expect(words).toContain('原因未知');
    expect(words).toContain('provider_authentication_failed');
    // The old string is the raw error now (masked, in the expandable block).
    expect(words).toContain('worker reported terminal failure');
    act(() => { renderer.unmount(); });
  });

  it('更换没做完（Dashboard 中途断了）：显示进行中的更换，「继续更换」再发 /orchestrator，「取消更换」发 cancel', async () => {
    const { h, runId } = await failedView(ALICE);
    h.setOnline([MAIN, DOC]);
    await h.service.prepareHandoff(runId, ALICE, { toLarkAppId: DOC });
    const view = await h.service.view(runId);
    const { renderer, sent } = await render(view, ALICE, () => ({ ok: true, draft: view }));
    expect(text(renderer.root)).toContain('正在把编排 Bot 换成 文档Bot');
    await act(async () => { buttonByText(renderer, '继续更换')[0]!.props.onClick(); });
    await flush();
    expect(sent.find((call) => call.url.endsWith('/orchestrator'))?.body).toMatchObject({ larkAppId: DOC });
    await act(async () => { buttonByText(renderer, '取消更换')[0]!.props.onClick(); });
    await flush();
    expect(sent.find((call) => call.url.endsWith('/handoff/cancel'))?.body).toEqual({});
    act(() => { renderer.unmount(); });
  });
});

describe('新建页：编排 Bot 选择器', () => {
  it('可搜索选择器：不能用的带原因不可选，最近一次调用模型失败的带提示仍可选', async () => {
    const { V3RunsPage } = await import('../src/dashboard/web/v3-components.js');
    stubBrowser('#/workflows/new', (url) => {
      if (url === '/api/settings') return { authed: true, settings: { workflow: { enabled: true, nodeExecutor: 'bot' } } };
      if (url === '/api/v3/orchestration/bots') return { ok: true, bots: botRows() };
      if (url === '/api/v3/orchestration/initiator') return { ok: true, initiator: ALICE };
      return undefined;
    });
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => { renderer = TestRenderer.create(React.createElement(V3RunsPage)); });
    await flush();
    const picker = renderer.root.find((node) => node.type === BotSearchPicker && node.props.id === 'wfd-bot');
    const options = picker.props.options as Array<{ larkAppId: string; disabledWhy?: string; hint?: string }>;
    expect(options.find((option) => option.larkAppId === STEWARD)?.disabledWhy).toBeTruthy();
    expect(options.find((option) => option.larkAppId === DOC)).toMatchObject({ hint: expect.stringContaining('额度') });
    expect(options.find((option) => option.larkAppId === DOC)?.disabledWhy).toBeUndefined();
    act(() => { renderer.unmount(); });
  });
});
