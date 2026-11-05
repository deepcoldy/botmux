/**
 * Dashboard 工作流编排页面的纯逻辑（design 2026-11-03
 * workflow-dashboard-orchestration §4.1–4.4、§4.6、E13，D3）：路由解析、草稿
 * 视图到流程图 / 流程摘要的投影、按钮可用性。React 组件在
 * workflow-draft-page.tsx，接口在 workflow-draft-api.ts。
 */
import type { RunNodeView, RunView } from '../../workflows/v3/ops-projection.js';
import type { V3Dag, V3Node } from '../../workflows/v3/dag.js';
import type { WorkflowDraftView } from '../../workflows/v3/draft-service.js';
import type { WorkflowDraftInitiator, WorkflowDraftPhase, WorkflowDraftQuestion, WorkflowDraftTurn } from '../../workflows/v3/draft-store.js';
import type { WorkflowOrchestratorBotOption } from '../workflow-drafts-api.js';
import type { V3Gate2BotPlanRow, V3RosterBot, V3RosterExclusion } from '../../workflows/v3/bot-assignment.js';

// ─── 路由（E13）──────────────────────────────────────────────────────────

export type WorkflowsRoute =
  | { kind: 'list' }
  | { kind: 'new' }
  | { kind: 'draft'; runId: string }
  | { kind: 'library' }
  | { kind: 'template'; workflowId: string }
  | { kind: 'run'; runId: string };

function decodeSegment(raw: string): string {
  try { return decodeURIComponent(raw); } catch { return raw; }
}

/**
 * `#/workflows…` 的页面。顺序就是路由表：新建、草稿、模板库（只排除，页面在
 * D5）、运行详情、列表。查询串（`?x=y`）不参与匹配。
 */
export function parseWorkflowsRoute(hash: string): WorkflowsRoute {
  const m = hash.match(/^#\/workflows(?:\/([^?#]*))?(?:[?#].*)?$/);
  if (!m || !m[1]) return { kind: 'list' };
  const segments = m[1].split('/');
  const head = segments[0]!;
  if (head === 'new') return segments.length === 1 ? { kind: 'new' } : { kind: 'list' };
  if (head === 'drafts') {
    const id = segments[1] ? decodeSegment(segments[1]) : '';
    return id && segments.length === 2 ? { kind: 'draft', runId: id } : { kind: 'list' };
  }
  if (head === 'library') {
    // D5: `library/<workflowId>` is one template; anything deeper is the list.
    const id = segments[1] ? decodeSegment(segments[1]) : '';
    return id && segments.length === 2 ? { kind: 'template', workflowId: id } : { kind: 'library' };
  }
  if (!head) return { kind: 'list' };
  // 运行详情：与原来的解析一致（整段都是 runId）。
  return { kind: 'run', runId: decodeSegment(m[1]) };
}

export function workflowDraftHref(runId: string): string {
  return `#/workflows/drafts/${encodeURIComponent(runId)}`;
}

// ─── 开关（§4.1、§10）────────────────────────────────────────────────────

export interface WorkflowSwitches {
  enabled: boolean;
  nodeExecutor: 'ephemeral' | 'bot';
}

/** 入口形态：开关关时完全没有新入口；只开总开关时入口只给提示。 */
export type WorkflowEntryMode = 'hidden' | 'needs-bot-executor' | 'ready';

export function workflowEntryMode(switches: WorkflowSwitches | null): WorkflowEntryMode {
  if (!switches?.enabled) return 'hidden';
  return switches.nodeExecutor === 'bot' ? 'ready' : 'needs-bot-executor';
}

/** /api/settings 的回应里取开关；读不出来按关处理（不出新入口）。 */
export function readWorkflowSwitches(body: unknown): WorkflowSwitches | null {
  const settings = (body as { settings?: { workflow?: unknown } } | null)?.settings;
  const workflow = settings?.workflow as { enabled?: unknown; nodeExecutor?: unknown } | undefined;
  if (!workflow || typeof workflow !== 'object') return null;
  return { enabled: workflow.enabled === true, nodeExecutor: workflow.nodeExecutor === 'bot' ? 'bot' : 'ephemeral' };
}

// ─── 发起人（§7.1）───────────────────────────────────────────────────────

/** 某个编排 Bot 视角下「我」是谁：initiator 接口的结果。 */
export type InitiatorCheck =
  | { state: 'checking' }
  | { state: 'ok'; initiator: WorkflowDraftInitiator }
  | { state: 'failed'; error: string; retryable: boolean };

export function sameDraftInitiator(a: WorkflowDraftInitiator | undefined, b: WorkflowDraftInitiator | undefined): boolean {
  return !!a && !!b && a.openId === b.openId && a.source === b.source;
}

/** 发起人身份的来源说明（页面标明）。 */
export function initiatorSourceKey(initiator: Pick<WorkflowDraftInitiator, 'source'>): string {
  return initiator.source === 'dashboard-local' ? 'workflow.draft.sourceLocal' : 'workflow.draft.sourcePlatform';
}

/** initiator / 草稿接口错误码 → 文案键；不认识的码原样显示。 */
export function draftErrorKey(code: string): string | undefined {
  const known = new Set([
    'feature_disabled', 'login_required', 'h5_login_unsupported', 'admin_required', 'platform_direct_unsupported',
    'platform_actor_missing', 'untrusted_caller', 'initiator_missing', 'owner_unavailable', 'initiator_not_visible',
    'identity_lookup_failed', 'cannot_operate', 'bot_mismatch', 'daemon_offline', 'daemon_proxy_failed',
    'not_initiator', 'draft_abandoned', 'version_conflict', 'state_conflict', 'busy', 'architect_running',
    'clarify_turn_running', 'session_disconnected', 'clarify_unavailable', 'no_spec', 'flow_changed',
    'already_confirmed', 'unknown_node', 'bot_not_on_roster', 'dag_invalid', 'draft_not_stale',
    'orchestrator_ineligible', 'unknown_draft', 'network_error', 'spec_invalid',
    'launch_running', 'launch_exists', 'no_launch', 'launch_unavailable', 'initiator_channel_unavailable', 'run_committed',
    'root_update_failed',
    'post_failed',
    // D5 模板
    'unknown_run', 'template_run', 'template_not_found', 'template_scope', 'template_not_published',
    'bad_params', 'template_invalid', 'not_owner', 'save_conflict', 'unsafe_literals', 'library_unavailable',
  ]);
  return known.has(code) ? `workflow.draft.err.${code}` : undefined;
}

// ─── 编排 Bot 下拉框（§4.1）──────────────────────────────────────────────

export interface OrchestratorOptionState {
  larkAppId: string;
  label: string;
  /** 不能选时的原因文案键或原文（已本地化由调用方处理）。 */
  disabledReason?: { key: string; fallback: string };
}

/**
 * 每个 Bot 能不能选：静态原因（CLI、bypass、Codex profile）、daemon 不在线来自
 * Dashboard；「发起人不能操作」（I1）来自选中后对该 Bot 的 initiator 检查，
 * 查过的记下来，下拉框里一并标出。
 */
export function orchestratorOptionStates(
  bots: readonly WorkflowOrchestratorBotOption[],
  checks: ReadonlyMap<string, InitiatorCheck>,
): OrchestratorOptionState[] {
  return bots.map((bot) => {
    const label = bot.cliId ? `${bot.name} · ${bot.cliId}` : bot.name;
    if (bot.unavailable) {
      return { larkAppId: bot.larkAppId, label, disabledReason: { key: `workflow.draft.unavailable.${bot.unavailable.code}`, fallback: bot.unavailable.why } };
    }
    const check = checks.get(bot.larkAppId);
    if (check?.state === 'failed' && !check.retryable) {
      return { larkAppId: bot.larkAppId, label, disabledReason: { key: draftErrorKey(check.error) ?? check.error, fallback: check.error } };
    }
    return { larkAppId: bot.larkAppId, label };
  });
}

export function canStartDraft(input: { goal: string; bot?: WorkflowOrchestratorBotOption; check?: InitiatorCheck; busy: boolean }): boolean {
  return !input.busy && !!input.bot && !input.bot.unavailable && input.check?.state === 'ok' && input.goal.trim().length > 0;
}

// ─── 状态（§4.6）─────────────────────────────────────────────────────────

export const DRAFT_PHASE_KEY: Record<WorkflowDraftPhase, string> = {
  clarifying: 'workflow.draft.phase.clarifying',
  spec_ready: 'workflow.draft.phase.spec_ready',
  awaiting_architect: 'workflow.draft.phase.awaiting_architect',
  architect_running: 'workflow.draft.phase.architect_running',
  dag_ready: 'workflow.draft.phase.dag_ready',
  flow_confirmed: 'workflow.draft.phase.flow_confirmed',
  abandoned: 'workflow.draft.phase.abandoned',
  committed: 'workflow.draft.phase.committed',
  launching: 'workflow.draft.phase.launching',
  started: 'workflow.draft.phase.started',
};

/** 复制来的草稿已经开过澄清会话（有对话，或会话不是「未开」）。 */
export function copyHasConversation(clarify: Pick<WorkflowDraftView['clarify'], 'turns' | 'state' | 'pending'>): boolean {
  return clarify.pending || clarify.state !== 'disconnected' || clarify.turns.some((turn) => turn.role !== 'system');
}

/** 页面上哪些区块要展示（按阶段累积，之前的区块保留可回看）。 */
export interface DraftSections {
  chat: boolean;
  spec: boolean;
  architect: boolean;
  flow: boolean;
  groupSetup: boolean;
  /** 拉群进度（D4）：一旦开始拉群就一直显示（含放弃、已启动）。 */
  launch: boolean;
  /** 运行模板（D5）：模板来源与参数；没有澄清、spec、编排。 */
  template: boolean;
  /** 「存为模板」（D5）：通过第二道确认、还没写 run.json 的普通草稿。 */
  saveTemplate: boolean;
  /** 复制来的草稿（D6）：来源、未结束提示、保留的参数、改目标。 */
  copy: boolean;
}

export function draftSections(
  view: Pick<WorkflowDraftView, 'phase' | 'clarify' | 'spec'> & { launch?: { commit?: unknown }; template?: unknown; copy?: unknown; flowConfirmation?: { valid: boolean } },
): DraftSections {
  const phase = view.phase;
  const past = (list: WorkflowDraftPhase[]) => list.includes(phase);
  if (view.template) {
    return {
      chat: false,
      spec: false,
      architect: false,
      flow: past(['dag_ready', 'flow_confirmed', 'launching']),
      groupSetup: phase === 'flow_confirmed' && !view.launch,
      launch: !!view.launch,
      template: true,
      saveTemplate: false,
      copy: false,
    };
  }
  return {
    template: false,
    saveTemplate: !!view.flowConfirmation?.valid && (phase === 'flow_confirmed' || phase === 'launching') && !view.launch?.commit,
    copy: !!view.copy,
    // A copy has no clarify session until one is opened (「按新目标重新编排」,
    // 「继续」, or back to clarifying): no empty chat panel before that.
    chat: !view.copy || phase === 'clarifying' || copyHasConversation(view.clarify),
    spec: !!view.clarify.specCandidate || !!view.spec?.markdown || !past(['clarifying', 'abandoned']),
    architect: past(['awaiting_architect', 'architect_running']),
    flow: past(['dag_ready', 'flow_confirmed', 'launching']),
    groupSetup: phase === 'flow_confirmed' && !view.launch,
    launch: !!view.launch,
  };
}

// ─── 拉群开始（§4.5，D4）────────────────────────────────────────────────

/** 额外成员输入框：逗号、分号、空白分隔；只收完整邮箱或 union_id（on_…）。
 *  `ou_` 直接拒（它只对签发它的应用有效），与 daemon 同一规则。 */
export function parseLaunchMembersInput(text: string): { members: string[]; invalid: string[]; openIds: string[] } {
  const items = [...new Set(text.split(/[\s,，;；]+/).map((item) => item.trim()).filter(Boolean))];
  const members: string[] = [];
  const invalid: string[] = [];
  const openIds: string[] = [];
  for (const item of items) {
    if (/^on_[A-Za-z0-9_-]{1,128}$/.test(item) || /^[^\s@<>"']{1,128}@[^\s@<>"']{1,128}\.[^\s@<>"']{1,64}$/.test(item)) members.push(item);
    else if (item.startsWith('ou_')) openIds.push(item);
    else invalid.push(item);
  }
  return { members, invalid, openIds };
}

export type LaunchStepKey = 'intent' | 'group' | 'root' | 'migrate' | 'check' | 'grant' | 'commit' | 'start';
export const LAUNCH_STEP_KEYS: readonly LaunchStepKey[] = ['intent', 'group', 'root', 'migrate', 'check', 'grant', 'commit', 'start'];
export type LaunchStepStatus = 'done' | 'running' | 'failed' | 'waiting' | 'pending';

export interface LaunchStepRow {
  key: LaunchStepKey;
  status: LaunchStepStatus;
  /** 这一步的补充事实（迁入没成功、按标记认回等），文案键。 */
  noteKey?: string;
}

type LaunchView = NonNullable<WorkflowDraftView['launch']>;

/** 记录里某一步（含 daemon 内部的细分步）对应页面上的哪一步。 */
function launchStepOf(step: string): LaunchStepKey {
  switch (step) {
    case 'members': case 'group': case 'join': return 'group';
    case 'root': return 'root';
    case 'migrate': case 'summary': return 'migrate';
    case 'check': return 'check';
    case 'grant': return 'grant';
    case 'commit': return 'commit';
    case 'start': case 'done': return 'start';
    default: return 'intent';
  }
}

/** 已落盘的事实推出哪几步做完了；`nextStep` 给出正在做（或停住）的那步。 */
function launchCurrentStep(launch: LaunchView): LaunchStepKey | 'done' {
  if (launch.start) return 'done';
  if (launch.nextStep !== 'unknown') {
    return launch.nextStep === 'done' ? 'done' : launchStepOf(launch.nextStep);
  }
  if (launch.error && launch.error.step !== 'interrupted') return launchStepOf(launch.error.step);
  return launch.commit ? 'start' : launch.check?.ok ? 'grant' : 'check';
}

/** 8 步的状态：之前的完成，当前的进行中 / 停住 / 等待，之后的未开始。 */
export function launchStepRows(launch: LaunchView): LaunchStepRow[] {
  const current = launchCurrentStep(launch);
  const index = current === 'done' ? LAUNCH_STEP_KEYS.length : LAUNCH_STEP_KEYS.indexOf(current);
  return LAUNCH_STEP_KEYS.map((key, i) => {
    let status: LaunchStepStatus;
    if (i < index) status = 'done';
    else if (i > index) status = 'pending';
    else if (launch.running) status = 'running';
    else if (launch.error || launch.state === 'paused') status = launch.error ? 'failed' : 'waiting';
    else status = launch.state === 'abandoned' ? 'pending' : 'waiting';
    const noteKey = key === 'group' && launch.chat?.recovered ? 'workflow.draft.launch.note.recovered'
      : key === 'migrate' && launch.migrate?.status === 'unavailable' ? 'workflow.draft.launch.note.migrateUnavailable'
        : key === 'migrate' && launch.migrate?.summaryError ? 'workflow.draft.launch.note.summaryFailed'
          : undefined;
    return { key, status, ...(noteKey ? { noteKey } : {}) };
  });
}

/** 页面上拉群区块能做什么（后端会再校验发起人与状态）。 */
/** The live check's problems, while they are about the current flow (a bot
 *  swapped since makes them stale: the next 「继续」 checks again). */
export function currentLaunchProblems(view: Pick<WorkflowDraftView, 'launch' | 'flowRevision'>): NonNullable<LaunchView['check']>['problems'] {
  const launch = view.launch;
  if (!launch?.check || launch.check.ok || launch.nextStep !== 'check' || launch.check.flowRevision !== view.flowRevision) return [];
  return launch.check.problems;
}

export function launchControls(
  view: Pick<WorkflowDraftView, 'phase' | 'launch' | 'flowConfirmation' | 'flowRevision'>,
  isInitiator: boolean,
): { canContinue: boolean; canAbandon: boolean; needsReconfirm: boolean; canSwapBots: boolean; canResendRoot: boolean; canResendSummary: boolean } {
  const launch = view.launch;
  if (!launch) return { canContinue: false, canAbandon: false, needsReconfirm: false, canSwapBots: false, canResendRoot: false, canResendSummary: false };
  const idle = !launch.running && launch.state !== 'abandoned' && launch.state !== 'started';
  // A bot swapped at step 5 voids the second confirmation: confirm the flow
  // first (the flow panel), then 「继续」.
  const needsReconfirm = idle && !launch.commit && view.phase === 'dag_ready';
  return {
    canContinue: isInitiator && idle && view.phase === 'launching',
    canAbandon: isInitiator && idle && !launch.commit,
    needsReconfirm,
    canSwapBots: isInitiator && idle && !launch.commit && currentLaunchProblems(view).length > 0,
    // Stopped because the root card could not be confirmed past Feishu's
    // dedup window: a person checked the group and found none.
    canResendRoot: isInitiator && idle && !launch.root && launch.error?.code === 'root_unverified',
    // The summary went unconfirmed (the launch went on, possibly started).
    canResendSummary: isInitiator && !launch.running && launch.state !== 'abandoned'
      && !!launch.migrate?.summaryUnverified && !launch.migrate.summaryMessageId,
  };
}

/** 停住的原因：按 code 取本地化文案，认不出的用 daemon 的原文。 */
export function launchErrorKey(code: string): string | undefined {
  const known = new Set([
    'members_invalid', 'members_unresolved', 'members_lookup_failed', 'list_chats_failed', 'create_group_failed',
    'initiator_not_joined', 'post_root_failed', 'bind_failed', 'bots_ineligible', 'revoke_failed', 'grant_failed',
    'flow_changed', 'daemon_restarted', 'internal_error', 'flow_unreadable', 'launch_loop',
    'recover_ambiguous', 'root_unverified', 'placement_refused',
  ]);
  return known.has(code) ? `workflow.draft.launchErr.${code}` : undefined;
}

/** 启动后去运行详情页。 */
export function startedRunHref(runId: string): string {
  return `#/workflows/${encodeURIComponent(runId)}`;
}

/** 对话面板能不能发消息：澄清或待确认需求、没有在回的这一轮、会话没断。 */
export function canChat(view: Pick<WorkflowDraftView, 'phase' | 'clarify'>, isInitiator: boolean): boolean {
  return isInitiator
    && (view.phase === 'clarifying' || view.phase === 'spec_ready')
    && !view.clarify.pending
    && view.clarify.state !== 'disconnected'
    && view.clarify.state !== 'closed';
}

/** 「会话已断开」时显示「继续」。 */
export function needsContinue(view: Pick<WorkflowDraftView, 'phase' | 'clarify'>): boolean {
  return (view.phase === 'clarifying' || view.phase === 'spec_ready')
    && !view.clarify.pending
    && view.clarify.state === 'disconnected';
}

/** 最后一轮回复带的问题块（只有它渲染成按钮；更早的只当文字）。 */
export function activeQuestion(turns: readonly WorkflowDraftTurn[]): { index: number; question: WorkflowDraftQuestion } | undefined {
  for (let i = turns.length - 1; i >= 0; i--) {
    const turn = turns[i]!;
    if (turn.role === 'system') continue;
    if (turn.role === 'user') return undefined;
    return turn.question ? { index: i, question: turn.question } : undefined;
  }
  return undefined;
}

/**
 * 模型给出新的 spec 时自动校验一次（§4.3：校验不过的问题列表显示在页面上，
 * 并作为下一轮发给模型）。每个候选只自动校验一次；连续失败到上限后改为
 * 手动点「重新校验」，免得模型和校验来回无止境。
 */
export const DRAFT_AUTO_FINALIZE_LIMIT = 3;

export function autoFinalizeCandidate(
  view: Pick<WorkflowDraftView, 'phase' | 'clarify' | 'spec'>,
  attempted: ReadonlySet<string>,
  consecutiveFailures: number,
): string | undefined {
  if (view.phase !== 'clarifying' && view.phase !== 'spec_ready') return undefined;
  const candidate = view.clarify.specCandidate;
  if (!candidate?.triggerId || view.clarify.pending) return undefined;
  if (attempted.has(candidate.triggerId) || consecutiveFailures >= DRAFT_AUTO_FINALIZE_LIMIT) return undefined;
  // 已经定稿过同一份文本（例如刷新页面后）不再校验。
  if (view.phase === 'spec_ready' && view.spec?.markdown?.trim() === candidate.markdown.trim()) return undefined;
  return candidate.triggerId;
}

/** 编辑框的初始文本：已定稿的 spec.md，否则模型最近一次给出的 spec。 */
export function specEditorText(view: Pick<WorkflowDraftView, 'phase' | 'clarify' | 'spec'>): string {
  const candidate = view.clarify.specCandidate?.markdown;
  if (view.phase === 'clarifying' && candidate) return candidate;
  return view.spec?.markdown ?? candidate ?? '';
}

// ─── spec 预览（§4.3）────────────────────────────────────────────────────

export interface SpecPreviewNode {
  sketchId: string;
  goal: string;
  inputNeeds: string[];
  expectedOutputs: string[];
  acceptance: string;
  riskGate: boolean;
  unknowns: string[];
  assignee?: string;
}

export interface SpecPreview {
  title: string;
  requirement: string;
  acceptance?: string;
  nonGoals: string[];
  nodes: SpecPreviewNode[];
}

const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
const str = (value: unknown): string => typeof value === 'string' ? value : '';

/** 从 spec.json 或 spec.md 里唯一的 ```json 块读预览；读不出来返回 undefined。 */
export function specPreview(source: { json?: unknown; markdown?: string }): SpecPreview | undefined {
  let raw = source.json;
  if (raw === undefined && source.markdown) {
    const blocks = [...source.markdown.matchAll(/```json\s*\n([\s\S]*?)\n```/g)];
    if (blocks.length !== 1) return undefined;
    try { raw = JSON.parse(blocks[0]![1]!); } catch { return undefined; }
  }
  if (!raw || typeof raw !== 'object') return undefined;
  const spec = raw as Record<string, unknown>;
  const nodes = Array.isArray(spec.nodes) ? spec.nodes : [];
  return {
    title: str(spec.title),
    requirement: str(spec.requirement),
    ...(str(spec.acceptance) ? { acceptance: str(spec.acceptance) } : {}),
    nonGoals: strings(spec.nonGoals),
    nodes: nodes.filter((n): n is Record<string, unknown> => !!n && typeof n === 'object').map((n) => ({
      sketchId: str(n.sketchId),
      goal: str(n.goal),
      inputNeeds: strings(n.input_needs),
      expectedOutputs: strings(n.expected_outputs),
      acceptance: str(n.acceptance),
      riskGate: n.risk_gate === true,
      unknowns: strings(n.unknowns),
      ...(str(n.assignee) ? { assignee: str(n.assignee) } : {}),
    })),
  };
}

// ─── 流程图（§4.4）───────────────────────────────────────────────────────

/** 草稿的 DAG 投影成运行详情页流程图组件吃的 RunView（全部待机）。 */
export function draftGraphView(dag: V3Dag, rows: readonly V3Gate2BotPlanRow[]): RunView {
  const rowOf = new Map(rows.map((row) => [row.nodeId, row]));
  const nodes: RunNodeView[] = dag.nodes.map((node) => {
    const row = rowOf.get(node.id);
    return {
      id: node.id,
      status: 'pending',
      depends: (node.depends ?? []).map((dep) => typeof dep === 'string' ? dep : dep.from),
      ...(node.goal ? { goal: node.goal } : {}),
      hasPtyLog: false,
      hasManifest: false,
      attempts: [],
      ...(node.type === 'loop' ? { isLoop: true } : {}),
      ...(node.type === 'host' && node.executor ? { host: { executor: node.executor } } : {}),
      ...(row ? { bot: { larkAppId: row.larkAppId, name: row.name, ...(row.cli ? { cliId: row.cli } : {}) } } : {}),
    };
  });
  return { runId: dag.runId, runStatus: 'running', nodes, generatedAt: 0 } as RunView;
}

/** 点中一个图上节点时能换 Bot 的任务节点：自身，或循环里的每个子节点。 */
export function assignableRows(nodeId: string, rows: readonly V3Gate2BotPlanRow[], dag: V3Dag): V3Gate2BotPlanRow[] {
  const node = dag.nodes.find((candidate) => candidate.id === nodeId);
  if (!node) return [];
  if (node.type === 'loop') return rows.filter((row) => row.nodeId.startsWith(`${node.id}.`));
  return rows.filter((row) => row.nodeId === nodeId);
}

export interface BotChoice {
  larkAppId: string;
  label: string;
  disabledWhy?: string;
}

/** 换执行 Bot 的下拉框：名单里能用的可选，不能用的列出原因（不可选）。 */
export function executorBotChoices(
  roster: { bots: readonly V3RosterBot[]; excluded: readonly V3RosterExclusion[] },
  mainSuffix = '',
): BotChoice[] {
  return [
    ...roster.bots.map((bot) => ({
      larkAppId: bot.larkAppId,
      label: `${bot.name} · ${bot.cli}${bot.main ? mainSuffix : ''}`,
    })),
    ...roster.excluded.map((entry) => ({ larkAppId: entry.larkAppId, label: entry.name, disabledWhy: entry.why })),
  ];
}

// ─── 流程摘要（§4.4）─────────────────────────────────────────────────────

export interface FlowSummaryGate {
  nodeId: string;
  prompt: string;
  /** 0 = 能操作主 Bot 的群成员都能批（I8）。 */
  approverCount: number;
  options: string[];
}

export interface FlowSummarySections {
  nodes: Array<{ nodeId: string; bot: string; cli?: string; reason?: string; warning?: string }>;
  unplaced: string[];
  sideEffects: Array<{ nodeId: string; kind: string }>;
  gates: FlowSummaryGate[];
}

function gatesOf(nodes: readonly V3Node[], prefix = ''): FlowSummaryGate[] {
  const out: FlowSummaryGate[] = [];
  for (const node of nodes) {
    if (node.humanGate) {
      out.push({
        nodeId: `${prefix}${node.id}`,
        prompt: node.humanGate.prompt,
        approverCount: node.humanGate.approvers?.length ?? 0,
        options: node.humanGate.options ?? ['approve', 'reject'],
      });
    }
    if (node.type === 'loop' && node.body?.nodes) out.push(...gatesOf(node.body.nodes, `${node.id}.`));
  }
  return out;
}

/**
 * 流程摘要的三部分（节点 → Bot + 理由 + ⚠️、对外动作、人工确认）。前两部分
 * 就是 daemon 算哈希的那份摘要；人工确认在摘要里只有哈希，位置和审批规则从
 * 同一份 DAG 读出来展示。
 */
export function flowSummarySections(flow: NonNullable<WorkflowDraftView['flow']>): FlowSummarySections {
  return {
    nodes: flow.plan.rows.map((row) => ({
      nodeId: row.nodeId,
      bot: row.name,
      ...(row.cli ? { cli: row.cli } : {}),
      ...(row.reason ? { reason: row.reason } : {}),
      ...(row.missedAssignee ? { warning: row.missedAssignee.why ? `${row.missedAssignee.assignee}：${row.missedAssignee.why}` : row.missedAssignee.assignee } : {}),
    })),
    unplaced: flow.plan.unplaced.map((entry) => `${entry.sketchId} → ${entry.assignee}${entry.why ? `：${entry.why}` : ''}`),
    sideEffects: flow.flowSummary.sideEffects,
    gates: gatesOf(flow.dag.nodes),
  };
}

/** 第二道确认的展示状态。 */
export type FlowConfirmState = 'none' | 'confirmed' | 'void';

/**
 * `seenConfirmed`: this page showed a valid confirmation earlier. The daemon
 * drops the record when the flow changes (E5), so a confirmation that
 * disappeared while the page was open is shown as void, not as never given.
 */
export function flowConfirmState(view: Pick<WorkflowDraftView, 'flowConfirmation' | 'phase'>, seenConfirmed = false): FlowConfirmState {
  if (!view.flowConfirmation) return seenConfirmed && view.phase === 'dag_ready' ? 'void' : 'none';
  return view.flowConfirmation.valid ? 'confirmed' : 'void';
}

// ─── 草稿列表（§4.6）─────────────────────────────────────────────────────

/** 30 天没动静的草稿标灰；发起人可以删除（已放弃的也能删）。 */
export function draftRowActions(draft: { stale: boolean; phase: WorkflowDraftPhase }, isInitiator: boolean): { dimmed: boolean; canDelete: boolean } {
  return { dimmed: draft.stale, canDelete: isInitiator && (draft.stale || draft.phase === 'abandoned') };
}

// ─── 对话面板 ────────────────────────────────────────────────────────────

const SPEC_SECTION_RE = /<botmux-spec>[\s\S]*?<\/botmux-spec>/g;

/** 一轮回复在对话里显示的文字：spec 正文挪到 spec 区，这里只留一句占位。 */
export function turnDisplayText(turn: Pick<WorkflowDraftTurn, 'text' | 'hasSpec'>, specPlaceholder: string): string {
  if (!turn.hasSpec) return turn.text;
  return turn.text.replace(SPEC_SECTION_RE, specPlaceholder).replace(/\n{3,}/g, '\n\n').trim();
}

/** `MM-DD HH:mm`（本地时区）。 */
export function formatDraftTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
