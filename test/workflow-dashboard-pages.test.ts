/**
 * Dashboard 工作流编排页面（design 2026-11-03 workflow-dashboard-orchestration
 * §4.1–4.4、§4.6、E13/E14，D3）：路由、入口、编排 Bot 下拉框、对话面板、
 * spec、流程图投影、流程摘要、草稿列表与写请求的形状。流程相关的用例吃的是
 * 真实草稿服务（假澄清会话 + 假 Architect）产出的视图。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

import {
  activeQuestion,
  assignableRows,
  autoFinalizeCandidate,
  canChat,
  canStartDraft,
  DRAFT_AUTO_FINALIZE_LIMIT,
  draftGraphView,
  draftRowActions,
  draftSections,
  executorBotChoices,
  flowConfirmState,
  flowSummarySections,
  needsContinue,
  orchestratorOptionStates,
  parseWorkflowsRoute,
  readWorkflowSwitches,
  sameDraftInitiator,
  specPreview,
  turnDisplayText,
  workflowEntryMode,
  type InitiatorCheck,
} from '../src/dashboard/web/workflow-draft-model.js';
import { buildGraphLayout, v3RunIdFromHash } from '../src/dashboard/web/v3-model.js';
import { draftActionRequest, postDraftAction, fetchInitiator, type DraftFetch } from '../src/dashboard/web/workflow-draft-api.js';
import {
  handleWorkflowOrchestratorBotsApi,
  workflowOrchestratorBotOptions,
  type WorkflowOrchestratorBotOption,
} from '../src/dashboard/workflow-drafts-api.js';
import type { WorkflowDraftView } from '../src/workflows/v3/draft-service.js';
import { BOTS, DOC, MAIN, OWNER, PI, ALICE, architectSettled, goalNode, makeService, specMarkdown } from './helpers/workflow-draft-fakes.js';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let baseDir: string;
beforeEach(() => { baseDir = mkdtempSync(join(tmpdir(), 'wfd-pages-')); });
afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(baseDir, { recursive: true, force: true });
});

/** A real draft at 待确认流程: clarify → spec → approve → Architect. */
async function dagReadyDraft(nodes?: unknown[]): Promise<{ view: WorkflowDraftView; harness: ReturnType<typeof makeService> }> {
  const harness = makeService(baseDir);
  if (nodes) harness.architect.nodes = nodes;
  const created = await harness.service.create(OWNER, { goal: '出一份代码风险报告' });
  harness.clarify.reply(`好的。\n<botmux-spec>\n${specMarkdown()}\n</botmux-spec>`);
  await harness.service.view(created.runId);
  const finalized = await harness.service.finalizeSpec(created.runId, OWNER, {});
  expect(finalized.ok).toBe(true);
  await harness.service.approveSpec(created.runId, OWNER);
  await harness.service.startArchitect(created.runId, OWNER);
  await architectSettled(harness.service, created.runId);
  const view = await harness.service.view(created.runId);
  expect(view.phase).toBe('dag_ready');
  return { view, harness };
}

describe('路由（E13）：new / drafts / library 排在运行详情之前', () => {
  it('解析各页面；以 new 开头的 runId 仍是运行详情', () => {
    expect(parseWorkflowsRoute('#/workflows')).toEqual({ kind: 'list' });
    expect(parseWorkflowsRoute('#/workflows/new')).toEqual({ kind: 'new' });
    expect(parseWorkflowsRoute('#/workflows/new?x=1')).toEqual({ kind: 'new' });
    expect(parseWorkflowsRoute('#/workflows/drafts/run-2611-ab%2Fc')).toEqual({ kind: 'draft', runId: 'run-2611-ab/c' });
    expect(parseWorkflowsRoute('#/workflows/drafts')).toEqual({ kind: 'list' });
    expect(parseWorkflowsRoute('#/workflows/library')).toEqual({ kind: 'library' });
    expect(parseWorkflowsRoute('#/workflows/new-feature-2611-a1b2c3d4')).toEqual({ kind: 'run', runId: 'new-feature-2611-a1b2c3d4' });
    expect(parseWorkflowsRoute('#/workflows/drafts-x')).toEqual({ kind: 'run', runId: 'drafts-x' });
  });

  it('运行详情的 runId 解析排除 new / drafts / library 三个段', () => {
    expect(v3RunIdFromHash('#/workflows/new')).toBeNull();
    expect(v3RunIdFromHash('#/workflows/drafts/run-1')).toBeNull();
    expect(v3RunIdFromHash('#/workflows/library')).toBeNull();
    expect(v3RunIdFromHash('#/workflows/run-1')).toBe('run-1');
    expect(v3RunIdFromHash('#/workflows/newsletter-1')).toBe('newsletter-1');
  });
});

describe('入口（§4.1）', () => {
  it('总开关关（或还没读到）时没有入口；只开总开关时只给提示', () => {
    expect(workflowEntryMode(null)).toBe('hidden');
    expect(workflowEntryMode(readWorkflowSwitches({ settings: { workflow: { enabled: false, nodeExecutor: 'bot' } } }))).toBe('hidden');
    expect(workflowEntryMode(readWorkflowSwitches({ settings: { workflow: { enabled: true, nodeExecutor: 'ephemeral' } } }))).toBe('needs-bot-executor');
    expect(workflowEntryMode(readWorkflowSwitches({ settings: { workflow: { enabled: true, nodeExecutor: 'bot' } } }))).toBe('ready');
    expect(readWorkflowSwitches({ settings: {} })).toBeNull();
  });

  it('编排 Bot 下拉框：静态原因与 daemon 不在线直接标出，发起人不能操作在查过后标出', () => {
    const bots: WorkflowOrchestratorBotOption[] = workflowOrchestratorBotOptions(
      [
        ...BOTS,
        { larkAppId: 'cli_nobypass', larkAppSecret: 's', cliId: 'claude-code', disableCliBypass: true },
        { larkAppId: 'cli_profile', larkAppSecret: 's', cliId: 'codex', codexProfile: 'p' },
      ] as any[],
      (appId) => appId !== 'cli_off',
      (appId) => `名字-${appId}`,
    );
    const byId = new Map(bots.map((bot) => [bot.larkAppId, bot]));
    expect(byId.get(MAIN)?.unavailable).toBeUndefined();
    expect(byId.get(PI)?.unavailable?.code).toBe('cli_unsupported');
    expect(byId.get('cli_off')?.unavailable?.code).toBe('daemon_offline');
    expect(byId.get('cli_nobypass')?.unavailable?.code).toBe('bypass_disabled');
    expect(byId.get('cli_profile')?.unavailable?.code).toBe('codex_profile');
    // The steward bot (fakes: cli_steward, steward.enabled) cannot orchestrate.
    expect(byId.get('cli_steward')?.unavailable?.code).toBe('steward');
    expect(byId.get(MAIN)?.name).toBe(`名字-${MAIN}`);

    const checks = new Map<string, InitiatorCheck>([
      [DOC, { state: 'failed', error: 'cannot_operate', retryable: false }],
      [MAIN, { state: 'failed', error: 'identity_lookup_failed', retryable: true }],
    ]);
    const states = new Map(orchestratorOptionStates(bots, checks).map((state) => [state.larkAppId, state]));
    expect(states.get(DOC)?.disabledReason?.key).toBe('workflow.draft.err.cannot_operate');
    // A transient failure does not rule the bot out.
    expect(states.get(MAIN)?.disabledReason).toBeUndefined();
    expect(states.get(PI)?.disabledReason?.key).toBe('workflow.draft.unavailable.cli_unsupported');
  });

  it('只有选了能用的 Bot、拿到发起人、写了目标才能开始', () => {
    const bot = { larkAppId: MAIN, name: 'm', cliId: 'claude-code', online: true };
    const ok: InitiatorCheck = { state: 'ok', initiator: OWNER };
    expect(canStartDraft({ goal: '目标', bot, check: ok, busy: false })).toBe(true);
    expect(canStartDraft({ goal: '  ', bot, check: ok, busy: false })).toBe(false);
    expect(canStartDraft({ goal: '目标', bot, check: { state: 'checking' }, busy: false })).toBe(false);
    expect(canStartDraft({ goal: '目标', bot: { ...bot, unavailable: { code: 'daemon_offline', why: 'x' } }, check: ok, busy: false })).toBe(false);
    expect(canStartDraft({ goal: '目标', bot, check: ok, busy: true })).toBe(false);
  });

  it('发起人只认 open_id 与登录方式都一致', () => {
    expect(sameDraftInitiator(OWNER, { ...OWNER })).toBe(true);
    expect(sameDraftInitiator(OWNER, { ...OWNER, source: 'dashboard-platform' })).toBe(false);
    expect(sameDraftInitiator(OWNER, ALICE)).toBe(false);
    expect(sameDraftInitiator(undefined, OWNER)).toBe(false);
  });
});

describe('编排 Bot 名单接口', () => {
  function call(deps: Partial<Parameters<typeof handleWorkflowOrchestratorBotsApi>[3]>, method = 'GET') {
    const res = { status: 0, body: '' as string, writeHead(status: number) { this.status = status; return this; }, setHeader() {}, end(body: string) { this.body = body; } } as any;
    const handled = handleWorkflowOrchestratorBotsApi({ method } as any, res, new URL('http://x/api/v3/orchestration/bots'), {
      canManageHost: true, featureEnabled: () => true, listBots: () => [], ...deps,
    });
    return { handled, status: res.status, body: res.body ? JSON.parse(res.body) : undefined };
  }

  it('只读、要管理登录、开关关时拒绝', () => {
    expect(call({ canManageHost: false }).status).toBe(401);
    expect(call({ featureEnabled: () => false }).body.error).toBe('feature_disabled');
    expect(call({}, 'POST').status).toBe(405);
    const ok = call({ listBots: () => [{ larkAppId: MAIN, name: 'm', cliId: 'claude-code', online: true }] });
    expect(ok.status).toBe(200);
    expect(ok.body.bots).toHaveLength(1);
  });
});

describe('澄清面板（§4.2）', () => {
  const turns = (list: Array<Partial<WorkflowDraftView['clarify']['turns'][number]>>) =>
    list.map((turn, i) => ({ role: 'assistant' as const, text: `t${i}`, at: `2026-11-05T10:0${i}:00.000Z`, ...turn }));

  it('只有最后一轮回复的问题块渲染成按钮', () => {
    const q = { question: '要几家？', options: ['3 家', '5 家'], recommended: '3 家' };
    expect(activeQuestion(turns([{ role: 'user' }, { question: q }]))?.question).toEqual(q);
    expect(activeQuestion(turns([{ question: q }, { role: 'user' }]))).toBeUndefined();
    // A system note after the question does not hide it.
    expect(activeQuestion(turns([{ question: q }, { role: 'system' }]))?.index).toBe(0);
    expect(activeQuestion(turns([{ question: q }, { role: 'user' }, {}]))).toBeUndefined();
  });

  it('只有发起人、在澄清或待确认需求、没有在回的一轮、会话没断时能发；断开时给「继续」', () => {
    const base = { phase: 'clarifying' as const, clarify: { state: 'active' as const, pending: false, turns: [] } };
    expect(canChat(base, true)).toBe(true);
    expect(canChat(base, false)).toBe(false);
    expect(canChat({ ...base, clarify: { ...base.clarify, pending: true } }, true)).toBe(false);
    expect(canChat({ ...base, phase: 'awaiting_architect' }, true)).toBe(false);
    const gone = { ...base, clarify: { ...base.clarify, state: 'disconnected' as const } };
    expect(canChat(gone, true)).toBe(false);
    expect(needsContinue(gone)).toBe(true);
    expect(needsContinue(base)).toBe(false);
  });

  it('带 spec 的回复在对话里只留占位', () => {
    expect(turnDisplayText({ text: '好的。\n<botmux-spec>\n## 需求\nx\n</botmux-spec>\n还有吗', hasSpec: true }, '〔spec〕')).toBe('好的。\n〔spec〕\n还有吗');
    expect(turnDisplayText({ text: '<botmux-spec>x</botmux-spec>' }, '〔spec〕')).toBe('<botmux-spec>x</botmux-spec>');
  });
});

describe('spec 与第一道确认（§4.3）', () => {
  it('新候选自动校验一次；同一候选不再自动校验；连续失败到上限后改手动', () => {
    const view = { phase: 'clarifying' as const, clarify: { state: 'active' as const, pending: false, turns: [], specCandidate: { markdown: 'm', triggerId: 'trg-1' } } };
    expect(autoFinalizeCandidate(view, new Set(), 0)).toBe('trg-1');
    expect(autoFinalizeCandidate(view, new Set(['trg-1']), 0)).toBeUndefined();
    expect(autoFinalizeCandidate(view, new Set(), DRAFT_AUTO_FINALIZE_LIMIT)).toBeUndefined();
    expect(autoFinalizeCandidate({ ...view, clarify: { ...view.clarify, pending: true } }, new Set(), 0)).toBeUndefined();
    // Already finalized (same text on disk): reloading the page does not re-validate.
    expect(autoFinalizeCandidate({ ...view, phase: 'spec_ready', spec: { markdown: 'm\n' } }, new Set(), 0)).toBeUndefined();
    expect(autoFinalizeCandidate({ ...view, phase: 'awaiting_architect' }, new Set(), 0)).toBeUndefined();
  });

  it('预览列出标题、目标、每个节点的要素与未定的点', () => {
    const preview = specPreview({ markdown: specMarkdown([
      { sketchId: 'a', goal: '调研', input_needs: ['名单'], expected_outputs: ['facts.md'], acceptance: '全', risk_gate: true, unknowns: ['几家：默认 3'], assignee: DOC },
    ]) })!;
    expect(preview.title).toBe('代码风险报告');
    expect(preview.requirement).toBe('出报告');
    expect(preview.nodes).toEqual([{ sketchId: 'a', goal: '调研', inputNeeds: ['名单'], expectedOutputs: ['facts.md'], acceptance: '全', riskGate: true, unknowns: ['几家：默认 3'], assignee: DOC }]);
    expect(specPreview({ markdown: '没有 json 块' })).toBeUndefined();
    expect(specPreview({ markdown: `${specMarkdown()}\n${specMarkdown()}` })).toBeUndefined();
  });
});

describe('流程图与第二道确认（§4.4），用真实草稿服务的视图', () => {
  it('DAG 投影成运行详情页流程图能画的视图：边、执行 Bot', async () => {
    const { view } = await dagReadyDraft([goalNode('inspect', MAIN), { ...goalNode('write', DOC), depends: ['inspect'] }]);
    const graph = draftGraphView(view.flow!.dag, view.flow!.plan.rows);
    const layout = buildGraphLayout(graph);
    expect(layout.nodes.map((box) => box.node.id)).toEqual(['inspect', 'write']);
    expect(layout.edges.map((edge) => `${edge.fromId}->${edge.toId}`)).toEqual(['inspect->write']);
    expect(graph.nodes.find((node) => node.id === 'write')?.bot?.larkAppId).toBe(DOC);
  });

  it('换 Bot 的下拉框只让选名单里能用的，不能用的带原因', async () => {
    const { view } = await dagReadyDraft();
    const choices = executorBotChoices(view.flow!.roster);
    const usable = choices.filter((choice) => !choice.disabledWhy).map((choice) => choice.larkAppId);
    expect(usable).toEqual(expect.arrayContaining([MAIN, DOC]));
    expect(usable).not.toContain(PI);
    expect(choices.find((choice) => choice.larkAppId === PI)?.disabledWhy).toBeTruthy();
  });

  it('流程摘要三部分；被点名的节点换走后标 ⚠️；确认后流程变了显示作废', async () => {
    const { view, harness } = await dagReadyDraft();
    let summary = flowSummarySections(view.flow!);
    expect(summary.nodes.map((row) => [row.nodeId, row.warning])).toEqual([['inspect', undefined], ['write', undefined]]);
    expect(summary.sideEffects).toEqual([]);
    expect(summary.gates).toEqual([]);

    const confirmed = await harness.service.approveFlow(view.runId, OWNER, { flowSummarySha256: view.flow!.flowSummarySha256 });
    expect(flowConfirmState(confirmed)).toBe('confirmed');
    expect(draftSections(confirmed).groupSetup).toBe(true);

    // The spec named DOC for `write`; moving it to MAIN is flagged and voids the confirmation.
    const changed = await harness.service.setNodeBot(view.runId, OWNER, 'write', { larkAppId: MAIN });
    summary = flowSummarySections(changed.flow!);
    expect(summary.nodes.find((row) => row.nodeId === 'write')?.warning).toContain(DOC);
    expect(changed.flowConfirmation).toBeUndefined();
    expect(flowConfirmState(changed)).toBe('none');
    // The page that showed the confirmation says it is void now.
    expect(flowConfirmState(changed, true)).toBe('void');
    expect(flowConfirmState({ phase: 'dag_ready', flowConfirmation: { ...confirmed.flowConfirmation!, valid: false } })).toBe('void');
  });

  it('人工确认清单列出每道 Gate 的位置与审批规则，对外动作列出宿主动作', async () => {
    const { view } = await dagReadyDraft([
      goalNode('inspect', MAIN),
      { ...goalNode('write', DOC), depends: ['inspect'], humanGate: { prompt: '发出去吗', approvers: [] } },
    ]);
    const summary = flowSummarySections(view.flow!);
    expect(summary.gates).toEqual([{ nodeId: 'write', prompt: '发出去吗', approverCount: 0, options: ['approve', 'reject'] }]);
  });

  it('点循环节点时能给循环里的每个子节点换 Bot', () => {
    const dag = { runId: 'r', nodes: [{ id: 'loop', type: 'loop', depends: [], inputs: [], body: { nodes: [] } }, { id: 'x', type: 'goal', depends: [], inputs: [] }] } as any;
    const rows = [
      { nodeId: 'loop.a', larkAppId: MAIN, name: 'm', main: true },
      { nodeId: 'loop.b', larkAppId: DOC, name: 'd', main: false },
      { nodeId: 'x', larkAppId: DOC, name: 'd', main: false },
    ];
    expect(assignableRows('loop', rows, dag).map((row) => row.nodeId)).toEqual(['loop.a', 'loop.b']);
    expect(assignableRows('x', rows, dag).map((row) => row.nodeId)).toEqual(['x']);
  });
});

describe('草稿列表（§4.6）', () => {
  it('30 天没动静标灰；只有发起人能删，且只删已放弃或标灰的', () => {
    expect(draftRowActions({ stale: true, phase: 'clarifying' }, true)).toEqual({ dimmed: true, canDelete: true });
    expect(draftRowActions({ stale: true, phase: 'clarifying' }, false)).toEqual({ dimmed: true, canDelete: false });
    expect(draftRowActions({ stale: false, phase: 'abandoned' }, true)).toEqual({ dimmed: false, canDelete: true });
    expect(draftRowActions({ stale: false, phase: 'dag_ready' }, true)).toEqual({ dimmed: false, canDelete: false });
  });
});

describe('写请求（D2 接口）', () => {
  it('每个写操作都带 JSON 对象请求体；确认流程带页面看到的摘要哈希', () => {
    const actions = [
      { kind: 'message', text: 'hi' }, { kind: 'continue' }, { kind: 'spec' }, { kind: 'approve-spec' },
      { kind: 'architect' }, { kind: 'architect-cancel' }, { kind: 'node-bot', nodeId: 'loop.a', larkAppId: DOC },
      { kind: 'approve-flow', flowSummarySha256: 'sha256:abc' }, { kind: 'revise-spec' }, { kind: 'abandon' }, { kind: 'delete' },
    ] as const;
    for (const action of actions) {
      const request = draftActionRequest('run 1', action, 7);
      expect(request.path.startsWith('/api/v3/orchestration/drafts/run%201/')).toBe(true);
      expect(typeof request.body).toBe('object');
    }
    expect(draftActionRequest('r', { kind: 'node-bot', nodeId: 'loop.a', larkAppId: DOC }, 3))
      .toEqual({ path: '/api/v3/orchestration/drafts/r/nodes/loop.a/bot', body: { larkAppId: DOC, baseVersion: 3 } });
    expect(draftActionRequest('r', { kind: 'approve-flow', flowSummarySha256: 'sha256:abc' }, 3).body)
      .toEqual({ flowSummarySha256: 'sha256:abc', baseVersion: 3 });
    // Abandon / cancel act on whatever the draft is now.
    expect(draftActionRequest('r', { kind: 'abandon' }, 3).body).toEqual({});
  });

  it('校验不过的 spec 是结果不是传输错误；initiator 用 POST 带 larkAppId', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetcher: DraftFetch = async (url, init) => {
      calls.push({ url, init });
      const body = url.endsWith('/spec') ? { ok: false, problems: ['缺 title'], draft: { runId: 'r' } } : { ok: true, initiator: OWNER };
      return { ok: true, status: 200, json: async () => body } as Response;
    };
    const spec = await postDraftAction('r', { kind: 'spec', relayProblems: true }, 2, fetcher);
    expect(spec.ok).toBe(false);
    if (!spec.ok) {
      expect(spec.error).toBe('spec_invalid');
      expect(spec.body.problems).toEqual(['缺 title']);
    }
    expect(JSON.parse(String(calls[0]!.init!.body))).toEqual({ relayProblems: true, baseVersion: 2 });
    const me = await fetchInitiator(MAIN, fetcher);
    expect(me.ok && me.initiator).toEqual(OWNER);
    expect(calls[1]!.init!.method).toBe('POST');
    expect(JSON.parse(String(calls[1]!.init!.body))).toEqual({ larkAppId: MAIN });
  });
});

describe('页面渲染', () => {
  function stubBrowser(hash: string, routes: (url: string, init?: RequestInit) => unknown) {
    const sent: Array<{ url: string; body?: unknown }> = [];
    vi.stubGlobal('location', { hash });
    vi.stubGlobal('window', {
      setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms === 2000 ? 1e9 : ms),
      clearTimeout, setInterval: () => 0, clearInterval: () => {}, location: { hash },
    });
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      sent.push({ url, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
      const body = routes(url, init) ?? { ok: false, error: 'not_found' };
      return { ok: (body as { ok?: boolean }).ok !== false, status: 200, json: async () => body } as Response;
    });
    return sent;
  }
  const flush = async () => { for (let i = 0; i < 6; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
  const text = (node: TestRenderer.ReactTestInstance): string => node.children.map((c) => typeof c === 'string' ? c : text(c)).join('');

  it('开关关时工作流页没有「新建工作流」也没有草稿分组；打开后才有', async () => {
    const { V3RunsPage } = await import('../src/dashboard/web/v3-components.js');
    for (const [enabled, expected] of [[false, false], [true, true]] as const) {
      const sent = stubBrowser('#/workflows', (url) => url === '/api/settings'
        ? { authed: true, settings: { workflow: { enabled, nodeExecutor: 'bot' } } }
        : url === '/api/v3/runs' ? { runs: [] } : url.startsWith('/api/v3/orchestration/drafts') ? { ok: true, drafts: [] } : { ok: true, bots: [] });
      let renderer!: TestRenderer.ReactTestRenderer;
      await act(async () => { renderer = TestRenderer.create(React.createElement(V3RunsPage)); });
      await flush();
      const links = renderer.root.findAll((node) => node.type === 'a' && node.props.href === '#/workflows/new');
      expect(links.length > 0).toBe(expected);
      expect(renderer.root.findAll((node) => node.props.className === 'overview-block wfd-drafts-section').length > 0).toBe(expected);
      expect(sent.some((call) => call.url.startsWith('/api/v3/orchestration/'))).toBe(expected);
      act(() => { renderer.unmount(); });
      vi.unstubAllGlobals();
    }
  });

  it('草稿页：问题块渲染成按钮，发起人点了作为下一轮发出；非发起人按钮禁用', async () => {
    const { V3RunsPage } = await import('../src/dashboard/web/v3-components.js');
    const harness = makeService(baseDir);
    const created = await harness.service.create(OWNER, { goal: '调研竞品' });
    harness.clarify.reply('先确认范围。\n```botmux-question\n{"question":"调研几家？","options":["3 家","5 家"],"recommended":"3 家"}\n```');
    const view = await harness.service.view(created.runId);

    for (const me of [OWNER, ALICE]) {
      const sent = stubBrowser(`#/workflows/drafts/${created.runId}`, (url) => {
        if (url === '/api/v3/orchestration/initiator') return { ok: true, initiator: me };
        if (url.endsWith('/messages')) return { ok: true, draft: view };
        if (url.startsWith('/api/v3/orchestration/drafts/')) return { ok: true, draft: view };
        return undefined;
      });
      let renderer!: TestRenderer.ReactTestRenderer;
      await act(async () => { renderer = TestRenderer.create(React.createElement(V3RunsPage)); });
      await flush();
      const options = renderer.root.findAll((node) => node.type === 'button' && String(node.props.className ?? '').includes('wfd-option'));
      expect(options.map((button) => text(button).replace(/推荐$/, ''))).toEqual(['3 家', '5 家']);
      expect(options.every((button) => button.props.disabled === (me !== OWNER))).toBe(true);
      if (me === OWNER) {
        await act(async () => { options[1]!.props.onClick(); });
        await flush();
        const message = sent.find((call) => call.url.endsWith('/messages'));
        expect(message?.body).toEqual({ text: '5 家', baseVersion: view.version });
      }
      act(() => { renderer.unmount(); });
      vi.unstubAllGlobals();
    }
  });
});
