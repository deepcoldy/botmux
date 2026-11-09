/**
 * Dashboard 工作流编排页面的纯逻辑（design 2026-11-03
 * workflow-dashboard-orchestration §4.1–4.4、§4.6、E13，D3）：路由解析、草稿
 * 视图到流程图 / 流程摘要的投影、按钮可用性。React 组件在
 * workflow-draft-page.tsx，接口在 workflow-draft-api.ts。
 */
import type { RunNodeView, RunView } from '../../workflows/v3/ops-projection.js';
import type { V3Dag, V3Node } from '../../workflows/v3/dag.js';
import type { WorkflowDraftProjectCandidate, WorkflowDraftProjectOptions, WorkflowDraftView } from '../../workflows/v3/draft-service.js';
import type { WorkflowDraftInitiator, WorkflowDraftPhase, WorkflowDraftQuestion, WorkflowDraftTurn } from '../../workflows/v3/draft-store.js';
import type { WorkflowOrchestratorBotOption } from '../workflow-drafts-api.js';
import type { V3Gate2BotPlanRow, V3RosterBot, V3RosterExclusion } from '../../workflows/v3/bot-assignment.js';
import { extractFailureCode, maskFailureText, type WorkflowDraftFailureCategory, type WorkflowDraftFailureStep } from '../../workflows/v3/draft-failure.js';
import type { WorkflowDraftFailureSummary, WorkflowDraftHandoffRecord } from '../../workflows/v3/draft-store.js';
import { botDefaultsHref } from './bot-defaults.js';

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
    // 换编排 Bot
    'handoff_pending',
    // 项目
    'project_required', 'project_not_allowed',
  ]);
  return known.has(code) ? `workflow.draft.err.${code}` : undefined;
}

// ─── 编排 Bot 下拉框（§4.1）──────────────────────────────────────────────

export interface OrchestratorOptionState {
  larkAppId: string;
  label: string;
  name: string;
  cliId?: string;
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
    const base = { larkAppId: bot.larkAppId, label, name: bot.name, ...(bot.cliId ? { cliId: bot.cliId } : {}) };
    if (bot.unavailable) {
      return { ...base, disabledReason: { key: `workflow.draft.unavailable.${bot.unavailable.code}`, fallback: bot.unavailable.why } };
    }
    const check = checks.get(bot.larkAppId);
    if (check?.state === 'failed' && !check.retryable) {
      return { ...base, disabledReason: { key: draftErrorKey(check.error) ?? check.error, fallback: check.error } };
    }
    return base;
  });
}

/** `project`: what {@link projectForRequest} gave; `null` = not chosen yet. */
export function canStartDraft(input: { goal: string; bot?: WorkflowOrchestratorBotOption; check?: InitiatorCheck; project: string | null; busy: boolean }): boolean {
  return !input.busy && !!input.bot && !input.bot.unavailable && input.check?.state === 'ok' && input.project !== null && input.goal.trim().length > 0;
}

// ─── 项目（新建 / 运行模板 / 复制）─────────────────────────────────────────

/** 编排 Bot 的项目选项：默认目录，或要选的候选。 */
export type ProjectOptionsCheck =
  | { state: 'checking' }
  | { state: 'ok'; options: WorkflowDraftProjectOptions }
  | { state: 'failed'; error: string; message?: string; retryable: boolean };

/** The projects answer, or `null` when it is not one (the form then cannot be sent). */
export function readProjectOptions(value: unknown): WorkflowDraftProjectOptions | null {
  const options = value as { kind?: unknown; dir?: unknown; candidates?: unknown } | null | undefined;
  if (options?.kind === 'default' && typeof options.dir === 'string' && options.dir) return { kind: 'default', dir: options.dir };
  if (options?.kind !== 'pick' || !Array.isArray(options.candidates)) return null;
  const candidates = (options.candidates as Array<Partial<WorkflowDraftProjectCandidate> | null>)
    .filter((candidate): candidate is WorkflowDraftProjectCandidate => typeof candidate?.path === 'string' && !!candidate.path && typeof candidate.name === 'string');
  return { kind: 'pick', candidates };
}

/**
 * The `project` sent with a new draft: the default dir the page shows (if it
 * changed meanwhile the daemon refuses rather than clarifying somewhere else),
 * or the picked candidate. `null` = nothing to send yet.
 */
export function projectForRequest(check: ProjectOptionsCheck | undefined, picked: string): string | null {
  if (check?.state !== 'ok') return null;
  if (check.options.kind === 'default') return check.options.dir;
  return check.options.candidates.some((candidate) => candidate.path === picked) ? picked : null;
}

/** The daemon refused the project the page sent (its default dir or its
 *  candidates changed since the form loaded them): load the choices again. */
export function projectChoicesStale(error: string): boolean {
  return error === 'project_required' || error === 'project_not_allowed';
}

/** 下拉里的一项：和飞书仓库选择卡一样的名字、分支、worktree 标记，再带上路径。 */
export function projectOptionLabel(candidate: WorkflowDraftProjectCandidate): string {
  const branch = candidate.branch ? ` (${candidate.branch})` : '';
  const worktree = candidate.type === 'worktree' ? ' [worktree]' : '';
  return `${candidate.name}${branch}${worktree} · ${candidate.path}`;
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
  /** 可搜索选择器用：显示名、CLI、主 Bot 标记分开给。 */
  name: string;
  cliId?: string;
  suffix?: string;
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
      name: bot.name,
      cliId: bot.cli,
      ...(bot.main && mainSuffix ? { suffix: mainSuffix } : {}),
    })),
    ...roster.excluded.map((entry) => ({ larkAppId: entry.larkAppId, label: entry.name, name: entry.name, disabledWhy: entry.why })),
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

// ─── 编排失败：哪个 Bot、什么原因、出路 ─────────────────────────────────

/** 页面要说的那次失败：daemon 记下的结构化原因，或（旧草稿）从报错字符串里只取错误码。 */
export interface DraftFailureDisplay {
  category: WorkflowDraftFailureCategory;
  code?: string;
  step: WorkflowDraftFailureStep;
  larkAppId: string;
  cliId?: string;
  /** Bot 配置（bots.json）里写了 model 才有；没配不推导、不显示。 */
  model?: string;
  at?: string;
  /** 原始报错（daemon 已脱敏、截断；旧草稿取报错字符串，页面再脱敏一次）。 */
  detail?: string;
  /** 终端输出的最后一段（纯文本，已脱敏、截断）。 */
  terminalTail?: string;
  /** 出错的澄清会话：页面用现有的只读终端链接（view-link）打开它。 */
  sessionId?: string;
  /** 旧草稿：只有字符串 error，原因按「未知」。 */
  legacy: boolean;
}

/** 页面上原始报错的长度上限（与 daemon 记录的上限一致）。 */
const FAILURE_DETAIL_MAX = 2000;

/** 旧草稿里的报错原文：页面自己脱敏、截断后再显示。 */
function legacyDetail(text: string | undefined): string | undefined {
  const masked = text ? maskFailureText(text).trim() : '';
  if (!masked) return undefined;
  return masked.length <= FAILURE_DETAIL_MAX ? masked : `${masked.slice(0, FAILURE_DETAIL_MAX - 1)}…`;
}

/** 不算失败、页面另有说法的澄清报错（会话断开有「继续」，发送超时有系统消息）。 */
const ROUTINE_CLARIFY_ERRORS = new Set(['会话已断开', '发送超时']);

/**
 * 要展示的失败，只在还能补救的阶段（澄清 / 待确认需求 / 待编排）：
 *   - daemon 记下的 `failure`；
 *   - 旧草稿只有 `clarify.error`：原因「未知」，错误码取字符串里的码（不显示原文）；
 *   - 旧草稿 Architect 失败：超时按「超时」，其余「未知」。换编排 Bot 之前那次
 *     Architect 是原来那个 Bot 跑的，不算到新 Bot 头上（新 Bot 自己失败会另记 `failure`）。
 */
export function draftFailureOf(
  view: Pick<WorkflowDraftView, 'phase' | 'orchestratorAppId' | 'clarify' | 'failure' | 'architect' | 'handoffs'>,
): DraftFailureDisplay | undefined {
  if (!['clarifying', 'spec_ready', 'awaiting_architect'].includes(view.phase)) return undefined;
  if (view.failure) {
    // 一次澄清失败只在澄清阶段说；编排失败只在待编排说。
    const architectStep = view.failure.step === 'architect';
    if (architectStep !== (view.phase === 'awaiting_architect')) return undefined;
    return { ...view.failure, legacy: false };
  }
  if (view.phase === 'awaiting_architect') {
    const state = view.architect?.state;
    if (state !== 'failed' && state !== 'timed_out') return undefined;
    const movedAt = view.handoffs?.at(-1)?.at;
    if (movedAt && view.architect!.startedAt <= movedAt) return undefined;
    const problems = view.architect?.problems ?? [];
    const code = problems.map((problem) => extractFailureCode(problem)).find((found) => !!found);
    const detail = legacyDetail(problems.join('\n'));
    return {
      category: state === 'timed_out' ? 'timeout' : 'unknown', ...(code ? { code } : {}), ...(detail ? { detail } : {}),
      step: 'architect', larkAppId: view.orchestratorAppId, legacy: true,
    };
  }
  const error = view.clarify.error;
  if (!error || ROUTINE_CLARIFY_ERRORS.has(error) || view.clarify.pending) return undefined;
  const code = extractFailureCode(error);
  const detail = legacyDetail(error);
  return {
    category: 'unknown', ...(code ? { code } : {}), ...(detail ? { detail } : {}),
    step: 'clarify_turn', larkAppId: view.orchestratorAppId, legacy: true,
  };
}

/** 失败原因的文案键与参数（bot = 显示名，带 CLI）。模型不进这句话，另起一行且只在配置了时显示。 */
export function draftFailureMessage(
  failure: Pick<DraftFailureDisplay, 'category' | 'cliId'>,
  botName: string,
): { key: string; params: Record<string, string> } {
  return { key: `workflow.draft.failure.cause.${failure.category}`, params: { bot: draftFailureBotLabel(failure, botName) } };
}

/** 「显示名（CLI）」，CLI 不知道就只有显示名。 */
export function draftFailureBotLabel(failure: Pick<DraftFailureDisplay, 'cliId'>, botName: string): string {
  return failure.cliId ? `${botName}（${failure.cliId}）` : botName;
}

/** 失败面板的事实行：哪个 Bot；Bot 配置里有 model 才有「模型」这一行。 */
export function draftFailureFacts(
  failure: Pick<DraftFailureDisplay, 'cliId' | 'model'>,
  botName: string,
): Array<{ key: 'bot' | 'model'; value: string }> {
  return [
    { key: 'bot', value: draftFailureBotLabel(failure, botName) },
    ...(failure.model ? [{ key: 'model' as const, value: failure.model }] : []),
  ];
}

/** 终端从哪儿看：有澄清会话就取它的只读终端链接（现有 view-link，按登录身份鉴权）；
 *  另有 daemon 留下的终端输出片段就直接显示。 */
export function draftFailureTerminal(
  failure: Pick<DraftFailureDisplay, 'sessionId' | 'terminalTail'>,
): { sessionId?: string; tail?: string } {
  return {
    ...(failure.sessionId ? { sessionId: failure.sessionId } : {}),
    ...(failure.terminalTail ? { tail: failure.terminalTail } : {}),
  };
}

/** 排查用的一行：错误码（已是码形，截到 64 字符）。 */
export function draftFailureCodeLine(failure: Pick<DraftFailureDisplay, 'code'>): string | undefined {
  return failure.code ? failure.code.slice(0, 64) : undefined;
}

/** 去改这个 Bot 的模型配置：Bot 配置页该 Bot 的模型设置处。 */
export function botModelSettingsHref(larkAppId: string): string {
  return botDefaultsHref({ bot: larkAppId, section: 'agent', field: 'botDefaults.agentModel' });
}

/** 这个阶段能不能换编排 Bot（还没拉群；澄清中、待确认需求、编排失败）。daemon 再校验。 */
export function canSwitchOrchestrator(
  view: Pick<WorkflowDraftView, 'phase' | 'architect' | 'template' | 'launch' | 'clarify' | 'handoff'>,
): boolean {
  // 平台登录和本机令牌登录都可以换（本机令牌登录：新发起人 = 新 Bot 的 owner）。
  if (view.template || view.launch || view.clarify.pending) return false;
  if (view.phase === 'clarifying' || view.phase === 'spec_ready') return true;
  return view.phase === 'awaiting_architect'
    && !!view.architect && ['failed', 'timed_out', 'interrupted', 'cancelled'].includes(view.architect.state);
}

/** 下拉项旁的预检提示：「最近一次调用模型失败：<原因>（时间）」的参数。 */
export function recentFailureHint(failure: WorkflowDraftFailureSummary | undefined): { key: string; at: string } | undefined {
  if (!failure) return undefined;
  return { key: `workflow.draft.failure.short.${failure.category}`, at: formatDraftTime(failure.at) };
}

/** 交接记录一条：何时、从哪个 Bot 到哪个 Bot、谁（登录方式）、确认人是否改写。
 *  页面不显示 open_id，确认人只说改写到了哪个 Bot 的应用下。 */
export function handoffHistoryRows(
  handoffs: ReadonlyArray<Omit<WorkflowDraftHandoffRecord, 'token'>> | undefined,
  nameOf: (larkAppId: string) => string,
): Array<{ at: string; from: string; to: string; source?: WorkflowDraftInitiator['source']; confirmerRewritten?: true }> {
  return (handoffs ?? []).map((entry) => ({
    at: formatDraftTime(entry.at),
    from: nameOf(entry.fromAppId),
    to: nameOf(entry.toAppId),
    ...(entry.by ? { source: entry.by.source } : {}),
    ...(entry.specConfirmation ? { confirmerRewritten: true as const } : {}),
  }));
}
