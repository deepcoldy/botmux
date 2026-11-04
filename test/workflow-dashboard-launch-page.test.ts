/**
 * 拉群开始的页面（design 2026-11-03 workflow-dashboard-orchestration §4.5，
 * D4 接 D3 的占位）：群设置、8 步进度、停住的原因与「继续」、第 5 步就地换 Bot、
 * 孤儿群、群链接、转群主失败提示、放弃、已启动后跳运行详情。页面吃的视图都来自
 * 真实草稿服务（假飞书 + 假澄清会话 + 假 Architect）。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

const confirmAnswer = vi.hoisted(() => ({ value: true }));
vi.mock('../src/dashboard/web/confirm-modal.js', () => ({ confirm: async () => confirmAnswer.value }));

import {
  draftSections,
  launchControls,
  launchStepRows,
  parseLaunchMembersInput,
  startedRunHref,
} from '../src/dashboard/web/workflow-draft-model.js';
import { draftActionRequest } from '../src/dashboard/web/workflow-draft-api.js';
import type { WorkflowDraftView } from '../src/workflows/v3/draft-service.js';
import { BOTS, DOC, MAIN, OWNER, ALICE, PI, STEWARD, SKETCHES, architectSettled, makeService, specMarkdown } from './helpers/workflow-draft-fakes.js';
import { fakeLaunch } from './helpers/workflow-launch-fakes.js';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const REVIEW = 'cli_review';
const FLEET = [...BOTS, { larkAppId: REVIEW, larkAppSecret: 's-rv', name: 'review', cliId: 'claude-code' }] as any[];
const ONLINE = [MAIN, DOC, REVIEW, STEWARD, PI];

let base: string;
beforeEach(() => { base = mkdtempSync(join(tmpdir(), 'wfd-launch-page-')); });
afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(base, { recursive: true, force: true });
});

function setup() {
  const launch = fakeLaunch(base);
  launch.setOnline(ONLINE);
  const h = makeService(base, { loadBots: () => FLEET, launch: launch.deps });
  h.setOnline(ONLINE);
  return { h, launch };
}

async function confirmed(h: ReturnType<typeof makeService>): Promise<string> {
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

async function settled(h: ReturnType<typeof makeService>, runId: string): Promise<WorkflowDraftView> {
  for (let i = 0; i < 400; i++) {
    const view = await h.service.view(runId);
    if (view.launch && !view.launch.running) return view;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('launch did not settle');
}

/** A launch stopped at the live check: DOC cannot join the group. */
async function stoppedAtCheck() {
  const { h, launch } = setup();
  launch.uninvitable.add(DOC);
  const runId = await confirmed(h);
  await h.service.launch(runId, OWNER, {});
  return { h, launch, runId, view: await settled(h, runId) };
}

describe('拉群进度的状态（真实视图）', () => {
  it('停在第 5 步：前 4 步完成、第 5 步停住、之后未开始；发起人能继续、放弃、就地换 Bot；别人都不能', async () => {
    const { view } = await stoppedAtCheck();
    expect(view.phase).toBe('launching');
    expect(launchStepRows(view.launch!).map((row) => [row.key, row.status])).toEqual([
      ['intent', 'done'], ['group', 'done'], ['root', 'done'], ['migrate', 'done'],
      ['check', 'failed'], ['grant', 'pending'], ['commit', 'pending'], ['start', 'pending'],
    ]);
    expect(launchControls(view, true)).toEqual({ canContinue: true, canAbandon: true, needsReconfirm: false, canSwapBots: true, canResendRoot: false, canResendSummary: false });
    expect(launchControls(view, false)).toEqual({ canContinue: false, canAbandon: false, needsReconfirm: false, canSwapBots: false, canResendRoot: false, canResendSummary: false });
    // Only the launch panel from here on: no group setup, the flow stays visible.
    expect(draftSections(view)).toMatchObject({ groupSetup: false, launch: true, flow: true });
  });

  it('换 Bot 之后要先重新确认流程（「继续」不可点），确认后又能继续', async () => {
    const { h, runId } = await stoppedAtCheck();
    await h.service.setNodeBot(runId, OWNER, 'write', { larkAppId: REVIEW });
    const swapped = await h.service.view(runId);
    expect(launchControls(swapped, true)).toMatchObject({ canContinue: false, needsReconfirm: true, canSwapBots: false });
    await h.service.approveFlow(runId, OWNER, { flowSummarySha256: swapped.flow!.flowSummarySha256 });
    expect(launchControls(await h.service.view(runId), true)).toMatchObject({ canContinue: true, needsReconfirm: false });
  });

  it('进行中：当前步是「进行中」，什么都不能点；已启动：8 步全完成', async () => {
    const { h, launch } = setup();
    const runId = await confirmed(h);
    launch.hang('postRootCard');
    await h.service.launch(runId, OWNER, {});
    for (let i = 0; i < 200 && launch.count('postRootCard') === 0; i++) await new Promise((r) => setTimeout(r, 5));
    const running = await h.service.view(runId);
    expect(launchStepRows(running.launch!).find((row) => row.status === 'running')?.key).toBe('root');
    expect(launchControls(running, true)).toEqual({ canContinue: false, canAbandon: false, needsReconfirm: false, canSwapBots: false, canResendRoot: false, canResendSummary: false });

    const { h: h2 } = setup();
    const other = await confirmed(h2);
    await h2.service.launch(other, OWNER, {});
    const started = await settled(h2, other);
    expect(started.phase).toBe('started');
    expect(launchStepRows(started.launch!).every((row) => row.status === 'done')).toBe(true);
    expect(startedRunHref(other)).toBe(`#/workflows/${encodeURIComponent(other)}`);
  });

  it('额外成员：邮箱与 union_id 收下，open_id 单列（拒），其它认不出', () => {
    expect(parseLaunchMembersInput('a@x.com, on_b；ou_c\n  zzz a@x.com')).toEqual({
      members: ['a@x.com', 'on_b'], invalid: ['zzz'], openIds: ['ou_c'],
    });
  });

  it('写请求：拉群带群名、成员与版本；继续带版本；放弃不带', () => {
    expect(draftActionRequest('r-1', { kind: 'launch', groupName: '风险', extraMembers: ['a@x.com'] }, 7)).toEqual({
      path: '/api/v3/orchestration/drafts/r-1/launch', body: { groupName: '风险', extraMembers: ['a@x.com'], baseVersion: 7 },
    });
    expect(draftActionRequest('r-1', { kind: 'launch' }, 7).body).toEqual({ baseVersion: 7 });
    expect(draftActionRequest('r-1', { kind: 'launch-continue' }, 7)).toEqual({ path: '/api/v3/orchestration/drafts/r-1/launch/continue', body: { baseVersion: 7 } });
    expect(draftActionRequest('r-1', { kind: 'launch-abandon' }, 7)).toEqual({ path: '/api/v3/orchestration/drafts/r-1/launch/abandon', body: {} });
  });
});

describe('页面渲染', () => {
  const location = { hash: '' };
  function stubBrowser(hash: string, routes: (url: string) => unknown) {
    const sent: Array<{ url: string; body?: unknown }> = [];
    location.hash = hash;
    vi.stubGlobal('location', location);
    vi.stubGlobal('window', {
      setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms === 2000 ? 1e9 : ms),
      clearTimeout, setInterval: () => 0, clearInterval: () => {}, location,
    });
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      sent.push({ url, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
      const body = routes(url) ?? { ok: false, error: 'not_found' };
      return { ok: (body as { ok?: boolean }).ok !== false, status: 200, json: async () => body } as Response;
    });
    return sent;
  }
  const flush = async () => { for (let i = 0; i < 6; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
  const text = (node: TestRenderer.ReactTestInstance): string => node.children.map((c) => typeof c === 'string' ? c : text(c)).join('');

  async function render(view: WorkflowDraftView, me = OWNER, answer: (url: string) => unknown = () => ({ ok: true, draft: view })) {
    const { V3RunsPage } = await import('../src/dashboard/web/v3-components.js');
    const sent = stubBrowser(`#/workflows/drafts/${view.runId}`, (url) => {
      if (url === '/api/v3/orchestration/initiator') return { ok: true, initiator: me };
      if (url === '/api/v3/orchestration/bots') return { ok: true, bots: [] };
      if (url === `/api/v3/orchestration/drafts/${encodeURIComponent(view.runId)}`) return { ok: true, draft: view };
      if (url.startsWith('/api/v3/orchestration/drafts/')) return answer(url);
      return undefined;
    });
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => { renderer = TestRenderer.create(React.createElement(V3RunsPage)); });
    await flush();
    return { renderer, sent };
  }
  const buttonByText = (renderer: TestRenderer.ReactTestRenderer, label: string) =>
    renderer.root.findAll((node) => node.type === 'button' && text(node) === label);

  it('群设置：群名默认工作流标题；填成员后「拉群开始」带上它们；填 open_id 时按钮禁用并说明', async () => {
    const { h } = setup();
    const runId = await confirmed(h);
    const view = await h.service.view(runId);
    const { renderer, sent } = await render(view);
    const name = renderer.root.find((node) => node.type === 'input' && node.props.id === 'wfd-group-name');
    expect(name.props.value).toBe('代码风险报告');
    const members = renderer.root.find((node) => node.type === 'textarea' && node.props.id === 'wfd-group-members');
    await act(async () => { members.props.onChange({ target: { value: 'ou_foreign' } }); });
    expect(buttonByText(renderer, '拉群开始')[0]!.props.disabled).toBe(true);
    expect(renderer.root.findAll((node) => node.props.role === 'alert' && text(node).includes('ou_foreign')).length).toBe(1);
    await act(async () => { members.props.onChange({ target: { value: 'bob@example.com, on_carol' } }); });
    await act(async () => { name.props.onChange({ target: { value: '周报' } }); });
    const start = buttonByText(renderer, '拉群开始')[0]!;
    expect(start.props.disabled).toBe(false);
    await act(async () => { start.props.onClick(); });
    await flush();
    expect(sent.find((call) => call.url.endsWith('/launch'))?.body).toEqual({
      groupName: '周报', extraMembers: ['bob@example.com', 'on_carol'], baseVersion: view.version,
    });
    act(() => { renderer.unmount(); });
  });

  it('非发起人：「拉群开始」禁用', async () => {
    const { h } = setup();
    const runId = await confirmed(h);
    const { renderer } = await render(await h.service.view(runId), ALICE);
    expect(buttonByText(renderer, '拉群开始')[0]!.props.disabled).toBe(true);
    act(() => { renderer.unmount(); });
  });

  it('停在第 5 步：逐节点列原因，就地换 Bot 发出换 Bot 请求；「继续」与「放弃」各发对应请求', async () => {
    const { view } = await stoppedAtCheck();
    const { renderer, sent } = await render(view);
    const steps = renderer.root.find((node) => node.type === 'ol' && String(node.props.className).includes('wfd-launch-steps'));
    expect(steps.findAll((node) => node.type === 'li').map((li) => li.props['aria-current'] ?? null)).toEqual([null, null, null, null, 'step', null, null, null]);
    const problem = renderer.root.find((node) => node.type === 'li' && node.props.className === 'wfd-launch-problem');
    expect(text(problem)).toContain('不在群里');
    const select = problem.find((node) => node.type === 'select');
    expect(select.props.disabled).toBe(false);
    await act(async () => { select.props.onChange({ target: { value: REVIEW } }); });
    await flush();
    expect(sent.find((call) => call.url.endsWith('/nodes/write/bot'))?.body).toEqual({ larkAppId: REVIEW, baseVersion: view.version });

    await act(async () => { buttonByText(renderer, '继续')[0]!.props.onClick(); });
    await flush();
    expect(sent.find((call) => call.url.endsWith('/launch/continue'))?.body).toEqual({ baseVersion: view.version });

    await act(async () => { buttonByText(renderer, '放弃')[0]!.props.onClick(); });
    await flush();
    expect(sent.find((call) => call.url.endsWith('/launch/abandon'))?.body).toEqual({});
    // The group exists: its link is shown.
    expect(renderer.root.findAll((node) => node.type === 'a' && node.props.href === view.launch!.chat!.shareLink).length).toBe(1);
    act(() => { renderer.unmount(); });
  });

  it('转群主失败的提示、可能留下的孤儿群、进行中时没有「继续」「放弃」', async () => {
    const { h, launch } = setup();
    launch.noOwner.add(OWNER.openId);
    const runId = await confirmed(h);
    launch.hang('postRootCard');
    await h.service.launch(runId, OWNER, {});
    for (let i = 0; i < 200 && launch.count('postRootCard') === 0; i++) await new Promise((r) => setTimeout(r, 5));
    const view = await h.service.view(runId);
    const withOrphan: WorkflowDraftView = {
      ...view,
      launch: { ...view.launch!, orphanSuspects: [{ chatId: 'oc_lost', name: `旧 ${view.launch!.marker}`, note: '群名带同一个标记的另一个群' }] },
    };
    const { renderer } = await render(withOrphan);
    expect(renderer.root.findAll((node) => node.props.role === 'status' && text(node).includes('没能设成群主')).length).toBe(1);
    expect(text(renderer.root.find((node) => node.props.className === 'wfd-launch-orphans'))).toContain('oc_lost');
    expect(buttonByText(renderer, '继续')).toEqual([]);
    expect(buttonByText(renderer, '放弃')).toEqual([]);
    act(() => { renderer.unmount(); });
  });

  it('停在「根卡片未确认」：发起人看到重发按钮，确认后发出带 confirmedAbsent 的请求；别人看不到', async () => {
    const { h, launch } = setup();
    const runId = await confirmed(h);
    launch.hangBefore('postRootCard');
    await h.service.launch(runId, OWNER, {});
    for (let i = 0; i < 200 && launch.count('postRootCard') === 0; i++) await new Promise((r) => setTimeout(r, 5));
    const next = new (await import('../src/workflows/v3/draft-service.js')).WorkflowDraftService({ ...h.deps });
    next.recoverInterrupted();
    h.advance(56 * 60_000);
    await next.continueLaunch(runId, OWNER);
    let view = await next.view(runId);
    for (let i = 0; i < 200 && view.launch!.running; i++) { await new Promise((r) => setTimeout(r, 5)); view = await next.view(runId); }
    expect(view.launch!.error!.code).toBe('root_unverified');
    expect(launchControls(view, true)).toMatchObject({ canResendRoot: true, canContinue: true });

    const label = '我已在群里确认没有这张卡，重发';
    const asAlice = await render(view, ALICE);
    expect(buttonByText(asAlice.renderer, label)).toEqual([]);
    act(() => { asAlice.renderer.unmount(); });
    vi.unstubAllGlobals();

    const { renderer, sent } = await render(view);
    // Declining the "there may be two cards" confirmation sends nothing.
    confirmAnswer.value = false;
    await act(async () => { buttonByText(renderer, label)[0]!.props.onClick(); });
    await flush();
    expect(sent.some((call) => call.url.endsWith('/launch/resend-root'))).toBe(false);
    confirmAnswer.value = true;
    await act(async () => { buttonByText(renderer, label)[0]!.props.onClick(); });
    await flush();
    expect(sent.find((call) => call.url.endsWith('/launch/resend-root'))?.body).toEqual({ confirmedAbsent: true, baseVersion: view.version });
    act(() => { renderer.unmount(); });
  });

  it('已启动：跳到运行详情页', async () => {
    const { h } = setup();
    const runId = await confirmed(h);
    await h.service.launch(runId, OWNER, {});
    const started = await settled(h, runId);
    const { renderer } = await render(started);
    expect(location.hash).toBe(startedRunHref(runId));
    act(() => { renderer.unmount(); });
  });
});
