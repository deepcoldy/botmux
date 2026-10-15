/**
 * `handleCardAction` 的分发表与敏感动作元数据。
 *
 * handleCardAction 本体是一条很长的 if 链，其中几段「按 action 前缀 / 谓词转交给
 * 某个子 handler」的块逐字同构。这里把这些同构块收成表，本体只留一次查表；
 * 其余形态各异的 action 仍留在原 if 链里（不强行并表）。
 *
 * 顺序语义（与原 if 链逐点一致，改动前必读）：
 * - 前缀路由：所有前缀两两互不为前缀（`dash_settings_` / `dash_sessions_` /
 *   `group_sessions_` / `dash_schedules_` / `dash_groups_` / `issue_` /
 *   `dash_overview_`），所以「先匹配的先处理」与表内顺序无关；表序仍沿用原 if 链顺序。
 *   命中需要 `larkAppId` 存在（与原条件 `&& larkAppId` 一致），否则落空继续往下走。
 * - v3 路由：6 个谓词按原顺序逐个试，命中即返回；对应 deps 未接线时 run() 返回 undefined
 *   （与原 `if (!deps.xxx) return;` 一致）。它们在通用敏感动作权限门**之前**——
 *   v3 卡 value 没有 root_id/session_id，权限由各自 handler 的 binding 校验兜底。
 * - 敏感动作：只管「哪些 action 过 canOperate 门」以及门的两处例外（拒绝时给 toast、
 *   pendingRepo 阶段发起人放行）；门本身的判定流程仍在 card-handler.ts。
 */
import { localeForBot, type Locale } from '../../i18n/index.js';
import type { CardActionData, CardHandlerDeps } from './card-handler.js';
import {
  handleV3GateAction,
  isV3GateAction,
} from './v3-gate-card-handler.js';
import type { V3GateActionValue } from './v3-gate-card.js';
import {
  handleV3BlockedAction,
  isV3BlockedAction,
} from './v3-blocked-card-handler.js';
import type { V3BlockedActionValue, V3AskAnswerActionValue } from './v3-blocked-card.js';
import {
  handleV3LoopGrantAction,
  isV3LoopGrantAction,
} from './v3-loop-grant-card-handler.js';
import type { V3LoopGrantActionValue } from './v3-loop-grant-card.js';
import {
  handleV3RevisitGrantAction,
  isV3RevisitGrantAction,
} from './v3-revisit-grant-card-handler.js';
import type { V3RevisitGrantActionValue } from './v3-revisit-grant-card.js';
import {
  handleV3RunSaveAction,
  isV3RunSaveAction,
} from './v3-run-save-card-handler.js';
import type { V3RunSaveActionValue } from './v3-run-save-card.js';
import {
  handleV3DistillationAction,
  isV3DistillationAction,
} from './v3-distillation-card-handler.js';

// ─── 前缀 → handler（不依赖 session 的 dashboard / issue 卡片回调）──────────────

export interface CardPrefixRoute {
  /** action 以此前缀开头即命中。 */
  readonly prefix: string;
  handle(data: CardActionData, larkAppId: string): Promise<any>;
}

/** dashboard 系 handler 的统一依赖：Route B 客户端 + 该 bot 的渲染语言。 */
interface DashboardCardDeps {
  createClient: (larkAppId: string) => any;
  locale: Locale;
}

/**
 * dashboard 系卡片回调：先动态加载子 handler，再加载 daemon-internal-client-wrapper，
 * 最后取 bot 语言（顺序与原内联实现一致）。成功返回 `{ card }` 让飞书在同一次回调里
 * 替换卡片；慢路径兜底由 event-dispatcher 负责。
 */
function dashboardRoute(
  prefix: string,
  loadHandler: () => Promise<(data: CardActionData, larkAppId: string, deps: any) => Promise<any>>,
): CardPrefixRoute {
  return {
    prefix,
    async handle(data, larkAppId) {
      const handler = await loadHandler();
      const { createDaemonClientFor } = await import('../../daemon-internal-client-wrapper.js');
      const deps: DashboardCardDeps = {
        createClient: (appId: string) => createDaemonClientFor(appId),
        locale: localeForBot(larkAppId),
      };
      return handler(data, larkAppId, deps);
    },
  };
}

export const CARD_PREFIX_ROUTES: readonly CardPrefixRoute[] = [
  // `/dashboard settings`：成功只返回 `{ card }`，不带 toast。
  dashboardRoute('dash_settings_', async () => (await import('./settings-card.js')).handleSettingsCardAction),
  // `/dashboard sessions`：同上，一次回调渲染新列表。
  dashboardRoute('dash_sessions_', async () => (await import('./sessions-card.js')).handleSessionsCardAction),
  // 公开 `/sessions` 当前群回调：与 dash_sessions_ 分开——这张卡对普通命令操作者可用；
  // 已关闭会话的 resume 另在公开 handler 内部做管理员闸，其余动作只读导航。
  dashboardRoute('group_sessions_', async () => (await import('./group-sessions-card.js')).handleGroupSessionsCardAction),
  // `/dashboard schedules`
  dashboardRoute('dash_schedules_', async () => (await import('./schedules-card.js')).handleSchedulesCardAction),
  // `/dashboard groups`
  dashboardRoute('dash_groups_', async () => (await import('./groups-card.js')).handleGroupsCardAction),
  // `/issue` Issue Board：权限门（allowedUsers + invoker lock）在 handleIssueCardAction 里，
  // 每次回调都重跑；依赖形态与 dashboard 系不同，所以不走 dashboardRoute。
  {
    prefix: 'issue_',
    async handle(data, larkAppId) {
      const { handleIssueCardAction } = await import('./issue-command.js');
      const { buildIssueCommandDeps } = await import('./issue-command-deps.js');
      return handleIssueCardAction(data, larkAppId, buildIssueCommandDeps());
    },
  },
  // `/dashboard overview`：goto 按钮通过重新请求对应的专用 Route B 端点重建目标卡
  // （sessions-list / schedules-list / settings-snapshot）。不新增端点、不用 multi_url 跨卡跳转。
  dashboardRoute('dash_overview_', async () => (await import('./overview-card.js')).handleOverviewCardAction),
];

/** 命中前缀路由则返回它；`action` 非字符串或缺 `larkAppId` 一律不命中。 */
export function findCardPrefixRoute(action: unknown, larkAppId: string | undefined): CardPrefixRoute | undefined {
  if (typeof action !== 'string' || !larkAppId) return undefined;
  return CARD_PREFIX_ROUTES.find(route => action.startsWith(route.prefix));
}

// ─── v3 工作流卡片 ────────────────────────────────────────────────────────────

/** v3 卡片路由所需的回调上下文（均取自 handleCardAction 的局部量）。 */
export interface V3CardActionContext {
  value: any;
  operatorOpenId: string | undefined;
  larkAppId: string | undefined;
  cardMessageId: string | undefined;
  formValue: unknown;
  deps: CardHandlerDeps;
}

export interface V3CardRoute {
  readonly name: string;
  matches(action: unknown): boolean;
  /** 对应 deps 未接线时返回 undefined（调用方原样 return，与原 `if (!deps.xxx) return;` 一致）。 */
  run(ctx: V3CardActionContext): Promise<any> | undefined;
}

/** 原 if 链顺序：gate → blocked → revisit → loop → runSave → distillation。 */
export const V3_CARD_ROUTES: readonly V3CardRoute[] = [
  {
    name: 'gate',
    matches: isV3GateAction,
    run: ctx => ctx.deps.v3GateDeps
      && handleV3GateAction(ctx.value as unknown as V3GateActionValue, ctx.operatorOpenId, ctx.deps.v3GateDeps),
  },
  {
    name: 'blocked',
    matches: isV3BlockedAction,
    run: ctx => ctx.deps.v3BlockedDeps
      && handleV3BlockedAction(
        ctx.value as unknown as V3BlockedActionValue | V3AskAnswerActionValue,
        ctx.operatorOpenId,
        ctx.deps.v3BlockedDeps,
        ctx.formValue as any,
      ),
  },
  {
    name: 'revisitGrant',
    matches: isV3RevisitGrantAction,
    run: ctx => ctx.deps.v3RevisitGrantDeps
      && handleV3RevisitGrantAction(ctx.value as unknown as V3RevisitGrantActionValue, ctx.operatorOpenId, ctx.deps.v3RevisitGrantDeps),
  },
  {
    name: 'loopGrant',
    matches: isV3LoopGrantAction,
    run: ctx => ctx.deps.v3LoopGrantDeps
      && handleV3LoopGrantAction(ctx.value as unknown as V3LoopGrantActionValue, ctx.operatorOpenId, ctx.deps.v3LoopGrantDeps),
  },
  {
    name: 'runSave',
    matches: isV3RunSaveAction,
    run: ctx => ctx.deps.v3RunSaveDeps
      && handleV3RunSaveAction(
        ctx.value as unknown as V3RunSaveActionValue,
        ctx.operatorOpenId,
        ctx.larkAppId,
        ctx.deps.v3RunSaveDeps,
      ),
  },
  {
    name: 'distillation',
    matches: isV3DistillationAction,
    run: ctx => ctx.deps.v3DistillationDeps
      && handleV3DistillationAction(
        ctx.value,
        ctx.operatorOpenId,
        ctx.larkAppId,
        ctx.cardMessageId,
        ctx.deps.v3DistillationDeps,
      ),
  },
];

/** 按原 if 链顺序找第一个命中的 v3 路由；没有则 undefined，调用方继续往下走。 */
export function findV3CardRoute(action: unknown): V3CardRoute | undefined {
  return V3_CARD_ROUTES.find(route => route.matches(action));
}

// ─── 敏感动作（过 canOperate 门）─────────────────────────────────────────────

export interface SensitiveCardActionMeta {
  /**
   * 被门拒绝时给用户的 toast i18n key。缺省 = 静默 block（仅记日志）——这是既有设计，
   * test/card-handler-repo-select.test.ts 钉着；只有用户主动点的「取权 / 打开」类动作
   * 才破例给明确的「无操作权限」提示，否则人会以为按钮坏了。
   */
  readonly denyToastKey?: string;
  /**
   * pendingRepo 阶段，会话发起人（含 chat-granted 用户）可以不过 canOperate 放行——
   * 与 repo 下拉选择同款例外，否则被授权人连自己的首次会话都启动不了。
   * `worktree_toggle_mode` 故意不享受：它持久写 bot 级 worktreeMultiPicker（影响该 bot
   * 所有后续会话），属管理动作，必须走 canOperate。
   */
  readonly pendingRepoOwnerException?: true;
}

const NO_META: SensitiveCardActionMeta = {};

export const SENSITIVE_CARD_ACTIONS: ReadonlyMap<string, SensitiveCardActionMeta> = new Map<string, SensitiveCardActionMeta>([
  ['restart', NO_META],
  ['close', NO_META],
  ['resume', NO_META],
  ['skip_repo', { pendingRepoOwnerException: true }],
  ['repo_manual_submit', { pendingRepoOwnerException: true }],
  ['repo_worktree_submit', { pendingRepoOwnerException: true }],
  ['worktree_toggle_mode', NO_META],
  ['retry_last_task', NO_META],
  ['retry_turn', NO_META],
  ['get_write_link', { denyToastKey: 'card.action.write_link_no_permission' }],
  ['open_local_terminal', { denyToastKey: 'card.action.local_terminal_no_permission' }],
  ['open_local_cli', { denyToastKey: 'card.action.local_cli_no_permission' }],
  ['toggle_stream', NO_META],
  ['toggle_display', NO_META],
  ['export_text', NO_META],
  ['term_action', NO_META],
  ['refresh_screenshot', NO_META],
  ['takeover', NO_META],
  ['disconnect', NO_META],
  ['tui_keys', NO_META],
  ['tui_text_input', NO_META],
  // 已下线的 v2 workflow 卡：墓碑（见 card-handler.ts）排在这道门之后，所以仍先过权限门。
  ['wf_approve', NO_META],
  ['wf_reject', NO_META],
  ['wf_cancel', NO_META],
  ['stop_turn', NO_META],
  ['compact_session', NO_META],
  ['quote_confirm', NO_META],
  ['set_reasoning_effort', NO_META],
]);

/** 该 action 是否过 canOperate 门；非字符串 / 未登记一律 undefined。 */
export function sensitiveCardActionMeta(action: unknown): SensitiveCardActionMeta | undefined {
  return typeof action === 'string' ? SENSITIVE_CARD_ACTIONS.get(action) : undefined;
}
