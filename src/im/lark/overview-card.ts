/**
 * Dashboard overview card.
 *
 * Sources from the shared overview endpoint and presents the same navigation
 * order as the Web Dashboard: sessions, groups, schedules, settings.
 * Drilldown buttons rebuild the target Feishu card in-place rather than using
 * external links, preserving invoker-lock and callback state.
 *
 * Non-200 Route B responses become error toasts, never empty cards. Successful
 * callbacks return card-only so Lark replaces the card in a single pass.
 */

import { isDashboardAdmin } from '../../dashboard/dashboard-admins.js';
import type { DaemonClient } from '../../dashboard/daemon-internal-client.js';
import type { DashboardSettingsInput } from '../../dashboard/settings-card-model.js';
import type { ScheduleCardTaskInput } from '../../dashboard/schedule-card-model.js';
import type { SessionRow } from '../../core/dashboard-rows.js';
import { type Locale, t } from '../../i18n/index.js';

import { buildSessionsCard } from './sessions-card.js';
import { buildSchedulesCard } from './schedules-card.js';
import { buildSettingsCard } from './settings-card.js';
import { buildGroupsCard } from './groups-card.js';
import { composeSections } from '../../dashboard/settings-card-model.js';
import type { GroupsBotInput, GroupsChatInput } from '../../dashboard/groups-card-model.js';
import {
  resolveWorkbenchButtonLinks,
  type WorkbenchButtonLinks,
} from '../../core/workbench-link.js';
import type { CardActionData } from './card-handler.js';

export const OVERVIEW_ACTION_REFRESH = 'dash_overview_refresh' as const;
export const OVERVIEW_ACTION_GOTO_SESSIONS = 'dash_overview_goto_sessions' as const;
export const OVERVIEW_ACTION_GOTO_SCHEDULES = 'dash_overview_goto_schedules' as const;
export const OVERVIEW_ACTION_GOTO_SETTINGS = 'dash_overview_goto_settings' as const;
export const OVERVIEW_ACTION_GOTO_GROUPS = 'dash_overview_goto_groups' as const;

/** Status set treated as active rather than falsely counted as idle. */
const ACTIVE_STATUSES: ReadonlySet<string> = new Set([
  'working',
  'analyzing',
  'stalled',
  'starting',
  'limited',
]);

/** Sessions count buckets the summary line surfaces. */
export interface SessionCounts {
  active: number;
  idle: number;
  closed: number;
}

/** Schedules count buckets the summary line surfaces. */
export interface ScheduleCounts {
  enabled: number;
  paused: number;
  /** Schedules whose last run errored — counted regardless of enabled state,
   *  to match the schedules list-card's ⚠️ semantics (see countSchedules
   *  docblock + `schedule-card-model.ts`). */
  errors: number;
}

/** Count session rows into (active / idle / closed) buckets. */
export function countSessions(rows: ReadonlyArray<SessionRow>): SessionCounts {
  let active = 0;
  let idle = 0;
  let closed = 0;
  for (const r of rows) {
    if (r.status === 'closed') closed += 1;
    else if (r.status === 'idle') idle += 1;
    else if (ACTIVE_STATUSES.has(r.status)) active += 1;
    else idle += 1; // unknown → idle bucket (matches list-card neutral default)
  }
  return { active, idle, closed };
}

/**
 * Count schedule rows into (enabled / paused / errors-in-last-run) buckets.
 *
 * `errors` counts every task whose last run failed, regardless of `enabled`.
 * This matches the schedules list-card semantics: `schedule-card-model.ts`
 * sets `errorIndicator = task.lastStatus === 'error'` independent of the
 * paused/enabled state, and `schedules-card.ts` paints the ⚠️ glyph
 * on any such row. Keeping the same definition prevents an undercount where
 * overview reads "上次错误 0" while drilling into schedules surfaces a
 * paused task with ⚠️.
 */
export function countSchedules(tasks: ReadonlyArray<ScheduleCardTaskInput>): ScheduleCounts {
  let enabled = 0;
  let paused = 0;
  let errors = 0;
  for (const t of tasks) {
    if (t.enabled) enabled += 1;
    else paused += 1;
    if (t.lastStatus === 'error') errors += 1;
  }
  return { enabled, paused, errors };
}

/**
 * Build the read-only settings summary line. Local helper — deliberately
 * separate from `settings-card.ts:successResult` (which projects through
 * `composeSections` and renders an interactive segmented card). The two
 * share input shape but never share output text, so a future change to one
 * cannot drift the other.
 */
export function buildSettingsSummary(
  settings: DashboardSettingsInput,
  locale: Locale,
): string {
  const publicReadOnlyLabel = t(
    settings.publicReadOnly === true
      ? 'card.dashboard.overview.settings.publicReadOnly.on'
      : 'card.dashboard.overview.settings.publicReadOnly.off',
    undefined,
    locale,
  );
  const openTerminalLabel = t(
    settings.openTerminalInFeishu === true
      ? 'card.dashboard.overview.settings.openTerminal.feishu'
      : 'card.dashboard.overview.settings.openTerminal.browser',
    undefined,
    locale,
  );

  let autoUpdateLabel: string;
  if (settings.localDevInstall === true) {
    autoUpdateLabel = t('card.dashboard.overview.settings.autoUpdate.localDev', undefined, locale);
  } else if (settings.maintenance?.autoUpdate?.enabled !== true) {
    autoUpdateLabel = t('card.dashboard.overview.settings.autoUpdate.off', undefined, locale);
  } else {
    const time = formatTime(settings.maintenance?.autoUpdate?.time);
    if (settings.maintenance?.autoRestart?.enabled === true) {
      autoUpdateLabel = t(
        'card.dashboard.overview.settings.autoUpdate.onWithRestart',
        { time },
        locale,
      );
    } else {
      autoUpdateLabel = t('card.dashboard.overview.settings.autoUpdate.on', { time }, locale);
    }
  }

  return t(
    'card.dashboard.overview.settings_summary',
    { publicReadOnlyLabel, openTerminalLabel, autoUpdateLabel },
    locale,
  );
}

function formatTime(time: string | undefined | null): string {
  if (typeof time !== 'string') return '04:00';
  const trimmed = time.trim();
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(trimmed)) return '04:00';
  return trimmed;
}

/**
 * Sanitize user/filesystem-supplied text for inclusion in lark_md. See
 * sessions-card.ts:escapeLarkMd for the escaping order rationale.
 */
function escapeLarkMd(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/([*_~`])/g, '\\$1');
}

export interface BuildOverviewCardOpts {
  invokerOpenId: string;
  locale: Locale;
  /**
   * 「打开工作台」入口的目标。缺省（读不到 dashboard 端口等）就整块不渲染，
   * 而不是渲染一个点了没反应的死链。链接怎么来的见 `core/workbench-link.ts`。
   *
   * ⚠️ 这条链接携带**长期 Dashboard token**，常驻不过期——这是产品 owner 拍板的
   * 决策反转（此前是 30 分钟短票，见 workbench-link.ts 顶部「为什么链接里是长期
   * token」）。自部署用户要的是一条能收藏的入口，泄漏风险由
   * `botmux dashboard rotate` 兜底。
   *
   * 正因为它是常驻凭证，**发出前的门禁一层都不能放宽**：命令入口在
   * `dashboard-command/owner-gate.ts` 拦，回调入口在下面 `handleOverviewCardAction`
   * 的 invoker-lock + `isDashboardAdmin` 拦，卡片是私信给发起人本人。
   */
  workbench?: { appLink: string; webUrl: string; credentialed: boolean };
}

export interface OverviewSnapshotInput {
  sessions: ReadonlyArray<SessionRow>;
  schedules: ReadonlyArray<ScheduleCardTaskInput>;
  settings: DashboardSettingsInput;
}

/** Build the overview card JSON. Pure (counts + projects + renders). */
export function buildOverviewCard(
  snapshot: OverviewSnapshotInput,
  opts: BuildOverviewCardOpts,
): string {
  const sessionCounts = countSessions(snapshot.sessions);
  const scheduleCounts = countSchedules(snapshot.schedules);
  const settingsSummary = buildSettingsSummary(snapshot.settings, opts.locale);

  const elements: unknown[] = [];

  // ─── 打开工作台 ──────────────────────────────────────────────────────
  // 排在最前面：这是新用户从飞书进 Web 工作台的唯一入口，排到会话/群组后面就
  // 等于没有。纯链接按钮，没有 callback，所以不经过 handleOverviewCardAction。
  // PC 用 appCenter AppLink（在飞书导航栏开标签页、可右键固定 → 常驻入口；
  // `mode=window` 那种独立窗口关掉就没了，配不上「常驻」），移动端不识别 mode，
  // 直接给网页 URL。缺链接时整块不渲染，不留死按钮。
  if (opts.workbench) {
    elements.push({
      tag: 'action',
      actions: [{
        tag: 'button',
        text: {
          tag: 'plain_text',
          content: t('card.dashboard.overview.open_workbench', undefined, opts.locale),
        },
        type: 'primary',
        multi_url: {
          url: opts.workbench.appLink,
          pc_url: opts.workbench.appLink,
          android_url: opts.workbench.webUrl,
          ios_url: opts.workbench.webUrl,
        },
      }],
    });

    // 这里**故意不再多渲染一行明文链接**（曾短暂上过一版，产品试用后撤下）：
    // 一整行 token 链接摊在卡片正文里太吵，且卡片是持久化载体（历史/转发/截图
    // 都留着），明文摊开只会把常驻凭证的暴露面放得更大。入口只留按钮一个，
    // token 只出现在按钮的 URL 里；owner 想拿到链接本体去收藏，走工作台
    // `⋯` 菜单里的「常驻链接」自取面板（dashboard/web/agent-workbench-appearance-menu.tsx）
    // 或终端 `botmux dashboard` 的第二行。别顺手把这行加回来。

    // 小字：带凭证时说清「入口常驻不过期 + 怀疑泄漏怎么自救」，这是常驻链接风险
    // 交换里用户那一侧的知情权；降级成无凭证链接时改说「需自行登录」，别吹不存在
    // 的能力。注意小字里只放 rotate 命令，不放链接本体（见上）。
    elements.push({
      tag: 'note',
      elements: [{
        tag: 'lark_md',
        content: t(
          opts.workbench.credentialed
            ? 'card.dashboard.overview.workbench.standing_hint'
            : 'card.dashboard.overview.workbench.login_required_hint',
          undefined,
          opts.locale,
        ),
      }],
    });
    elements.push({ tag: 'hr' });
  }

  // ─── Sessions section ────────────────────────────────────────────────
  elements.push({
    tag: 'div',
    text: {
      tag: 'lark_md',
      content:
        `**${t('card.dashboard.overview.sessions_section', undefined, opts.locale)}**` +
        `\n<font color="grey">${escapeLarkMd(
          t('card.dashboard.overview.sessions_summary', {
            active: String(sessionCounts.active),
            idle: String(sessionCounts.idle),
            closed: String(sessionCounts.closed),
          }, opts.locale),
        )}</font>`,
    },
  });
  elements.push({
    tag: 'action',
    actions: [{
      tag: 'button',
      text: {
        tag: 'plain_text',
        content: t('card.dashboard.overview.goto_sessions', undefined, opts.locale),
      },
      type: 'default',
      value: {
        action: OVERVIEW_ACTION_GOTO_SESSIONS,
        invoker_open_id: opts.invokerOpenId,
      },
    }],
  });

  elements.push({ tag: 'hr' });

  // ─── Groups section ──────────────────────────────────────────────────
  // overview-snapshot doesn't carry groups counts yet (would require a
  // server-side aggregator); the entry button is enough for navigation.
  elements.push({
    tag: 'div',
    text: {
      tag: 'lark_md',
      content: `**${t('card.dashboard.overview.groups_section', undefined, opts.locale)}**`,
    },
  });
  elements.push({
    tag: 'action',
    actions: [{
      tag: 'button',
      text: {
        tag: 'plain_text',
        content: t('card.dashboard.overview.goto_groups', undefined, opts.locale),
      },
      type: 'default',
      value: {
        action: OVERVIEW_ACTION_GOTO_GROUPS,
        invoker_open_id: opts.invokerOpenId,
      },
    }],
  });

  elements.push({ tag: 'hr' });

  // ─── Schedules section ───────────────────────────────────────────────
  elements.push({
    tag: 'div',
    text: {
      tag: 'lark_md',
      content:
        `**${t('card.dashboard.overview.schedules_section', undefined, opts.locale)}**` +
        `\n<font color="grey">${escapeLarkMd(
          t('card.dashboard.overview.schedules_summary', {
            enabled: String(scheduleCounts.enabled),
            paused: String(scheduleCounts.paused),
            errors: String(scheduleCounts.errors),
          }, opts.locale),
        )}</font>`,
    },
  });
  elements.push({
    tag: 'action',
    actions: [{
      tag: 'button',
      text: {
        tag: 'plain_text',
        content: t('card.dashboard.overview.goto_schedules', undefined, opts.locale),
      },
      type: 'default',
      value: {
        action: OVERVIEW_ACTION_GOTO_SCHEDULES,
        invoker_open_id: opts.invokerOpenId,
      },
    }],
  });

  elements.push({ tag: 'hr' });

  // ─── Settings section ────────────────────────────────────────────────
  elements.push({
    tag: 'div',
    text: {
      tag: 'lark_md',
      content:
        `**${t('card.dashboard.overview.settings_section', undefined, opts.locale)}**` +
        `\n<font color="grey">${escapeLarkMd(settingsSummary)}</font>`,
    },
  });
  elements.push({
    tag: 'action',
    actions: [{
      tag: 'button',
      text: {
        tag: 'plain_text',
        content: t('card.dashboard.overview.goto_settings', undefined, opts.locale),
      },
      type: 'default',
      value: {
        action: OVERVIEW_ACTION_GOTO_SETTINGS,
        invoker_open_id: opts.invokerOpenId,
      },
    }],
  });

  elements.push({ tag: 'hr' });

  // ─── Footer: refresh + shared security note ──────────────────────────
  elements.push({
    tag: 'action',
    actions: [{
      tag: 'button',
      text: {
        tag: 'plain_text',
        content: t('card.dashboard.overview.refresh', undefined, opts.locale),
      },
      type: 'default',
      value: {
        action: OVERVIEW_ACTION_REFRESH,
        invoker_open_id: opts.invokerOpenId,
      },
    }],
  });

  elements.push({
    tag: 'note',
    elements: [
      { tag: 'lark_md', content: t('card.dashboard.settings.footer.security', undefined, opts.locale) },
    ],
  });

  return JSON.stringify({
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: t('card.dashboard.overview.title', undefined, opts.locale) },
      template: 'blue',
    },
    elements,
  });
}

/** ─── Handler ─────────────────────────────────────────────────────────── */

export interface OverviewCardHandlerDeps {
  getOwnerOpenId?: (larkAppId: string) => string | undefined;
  getDashboardAdminOpenIds?: (larkAppId: string) => ReadonlyArray<string> | undefined;
  createClient: (larkAppId: string) => DaemonClient;
  locale?: Locale;
  /** Override `Date.now()` so tests are deterministic. */
  nowMs?: () => number;
  /** Override the workbench link resolution (reads dashboard port/token from
   *  disk in production). Tests inject a fixed value. */
  resolveWorkbench?: (larkAppId: string) => WorkbenchButtonLinks | undefined;
}

export interface OverviewCardHandlerResult {
  toast?: { type: 'info' | 'success' | 'error'; content: string };
  card?: { type: 'raw'; data: Record<string, unknown> };
}

function ackToast(textKey: string, locale: Locale): OverviewCardHandlerResult {
  return { toast: { type: 'info', content: t(textKey, undefined, locale) } };
}

function errorToast(
  textKey: string,
  params: Record<string, string> | undefined,
  locale: Locale,
): OverviewCardHandlerResult {
  return { toast: { type: 'error', content: t(textKey, params, locale) } };
}

/**
 * Shape of `/__daemon/overview-snapshot` response body. Locally redeclared
 * so the handler doesn't reach into Route B internals.
 */
interface OverviewSnapshotBody {
  sessions?: ReadonlyArray<SessionRow>;
  schedules?: ReadonlyArray<ScheduleCardTaskInput>;
  settings?: DashboardSettingsInput;
}

/**
 * Dispatch a `dash_overview_*` action callback. Uses the same fail-closed
 * identity pipeline as other dashboard cards; success returns `{ card }` only.
 *
 * Goto callbacks rebuild the TARGET module's card by re-fetching its own
 * dedicated endpoint (sessions-list / schedules-list / settings-snapshot)
 * — they intentionally do NOT mutate state. The user lands on the target
 * card in the SAME callback response (no `multi_url` cross-card jump).
 */
export async function handleOverviewCardAction(
  data: CardActionData,
  larkAppId: string,
  deps: OverviewCardHandlerDeps,
): Promise<OverviewCardHandlerResult> {
  const locale: Locale = deps.locale ?? 'zh';
  const value = (data.action?.value ?? {}) as Record<string, string>;
  const operatorOpenId = data.operator?.open_id;
  const action = value.action;

  // ─── 1) Invoker lock — fail-closed ──────────────────────────────────
  const invokerOpenId = value.invoker_open_id;
  if (typeof invokerOpenId !== 'string' || !invokerOpenId) {
    return ackToast('card.dashboard.settings.not_invoker', locale);
  }
  if (typeof operatorOpenId !== 'string' || !operatorOpenId) {
    return ackToast('card.dashboard.settings.not_invoker', locale);
  }
  if (invokerOpenId !== operatorOpenId) {
    return ackToast('card.dashboard.settings.not_invoker', locale);
  }

  // ─── 2) Per-bot admin gate ──────────────────────────────────────────
  if (!isDashboardAdmin(larkAppId, operatorOpenId, deps)) {
    return ackToast('card.dashboard.settings.owner_only', locale);
  }

  // ─── 3) Dispatch by action ──────────────────────────────────────────
  const client = deps.createClient(larkAppId);
  const nowMs = deps.nowMs ? deps.nowMs() : Date.now();

  if (action === OVERVIEW_ACTION_REFRESH) {
    // 刷新必须重新带上工作台入口，否则用户点一下「🔄 刷新」入口就消失了。
    // 这里已经过了 invoker-lock + isDashboardAdmin 两道门，才允许解析出带长期
    // token 的常驻链接（产品决策见 core/workbench-link.ts）。链接本身是稳定的，
    // 刷新拿到的与首次投递逐字相同——收藏过的那条不会因为刷新而对不上。
    const workbench = (deps.resolveWorkbench ?? resolveWorkbenchButtonLinks)(larkAppId);
    return rebuildOverview(client, operatorOpenId, locale, workbench);
  }

  if (action === OVERVIEW_ACTION_GOTO_SESSIONS) {
    // Re-use the same Route B endpoint that sessions-card refresh hits so
    // the cards stay byte-identical no matter which entrypoint reached them.
    let r: Awaited<ReturnType<DaemonClient['request']>>;
    try {
      r = await client.request({ method: 'GET', path: '/__daemon/sessions-list?scope=global' });
    } catch (e) {
      return errorToast('card.dashboard.sessions.list_failed', { reason: (e as Error).message }, locale);
    }
    if (r.status !== 200) {
      const reason = String((r.body as any)?.error ?? `http_${r.status}`);
      return errorToast('card.dashboard.sessions.list_failed', { reason }, locale);
    }
    const rows = ((r.body as { sessions?: ReadonlyArray<SessionRow> })?.sessions) ?? [];
    // Drilldown subcard — `origin: 'overview'` keeps the back affordance,
    // `scope: 'global'` keeps the global dashboard semantics across
    // refresh/page/detail/action round-trips.
    const cardJson = buildSessionsCard(
      rows,
      { invokerOpenId: operatorOpenId, locale, page: 1, origin: 'overview', scope: 'global' },
      nowMs,
    );
    return { card: { type: 'raw', data: JSON.parse(cardJson) as Record<string, unknown> } };
  }

  if (action === OVERVIEW_ACTION_GOTO_SCHEDULES) {
    let r: Awaited<ReturnType<DaemonClient['request']>>;
    try {
      // `/dashboard` is a global tool panel — schedules from any bot must
      // surface here, not just the caller's own.
      r = await client.request({ method: 'GET', path: '/__daemon/schedules-list?scope=global' });
    } catch (e) {
      return errorToast('card.dashboard.schedules.list_failed', { reason: (e as Error).message }, locale);
    }
    if (r.status !== 200) {
      const reason = String((r.body as any)?.error ?? `http_${r.status}`);
      return errorToast('card.dashboard.schedules.list_failed', { reason }, locale);
    }
    const tasks = ((r.body as { schedules?: ReadonlyArray<ScheduleCardTaskInput> })?.schedules) ?? [];
    // See sessions branch above for drilldown opts. `scope: 'global'` threads
    // global view semantics through refresh/page/detail/back/pause/resume.
    const cardJson = buildSchedulesCard(
      tasks,
      { invokerOpenId: operatorOpenId, locale, page: 1, origin: 'overview', scope: 'global' },
      nowMs,
    );
    return { card: { type: 'raw', data: JSON.parse(cardJson) as Record<string, unknown> } };
  }

  if (action === OVERVIEW_ACTION_GOTO_SETTINGS) {
    let r: Awaited<ReturnType<DaemonClient['request']>>;
    try {
      r = await client.request({ method: 'GET', path: '/__daemon/settings-snapshot' });
    } catch (e) {
      return errorToast('card.dashboard.settings.snapshot_failed', { reason: (e as Error).message }, locale);
    }
    if (r.status !== 200) {
      const reason = String((r.body as any)?.error ?? `http_${r.status}`);
      return errorToast('card.dashboard.settings.snapshot_failed', { reason }, locale);
    }
    const settings = (r.body as { settings?: DashboardSettingsInput })?.settings;
    if (!settings || typeof settings !== 'object') {
      return errorToast('card.dashboard.settings.snapshot_failed', { reason: 'malformed_body' }, locale);
    }
    const dto = composeSections(settings, { canWrite: true });
    // Drilldown settings — origin=overview so toggle/set_time/refresh
    // rebuilds keep the「🔙 返回总览」 button. Standalone settings command
    // (cli-handler) calls buildSettingsCard without `origin`.
    const cardJson = buildSettingsCard(
      dto,
      { invokerOpenId: operatorOpenId, locale, canWrite: true, origin: 'overview' },
    );
    return { card: { type: 'raw', data: JSON.parse(cardJson) as Record<string, unknown> } };
  }

  if (action === OVERVIEW_ACTION_GOTO_GROUPS) {
    let r: Awaited<ReturnType<DaemonClient['request']>>;
    try {
      r = await client.request({ method: 'GET', path: '/__daemon/groups-matrix?scope=global' });
    } catch (e) {
      return errorToast('card.dashboard.groups.list_failed', { reason: (e as Error).message }, locale);
    }
    if (r.status !== 200) {
      const reason = String((r.body as any)?.error ?? `http_${r.status}`);
      return errorToast('card.dashboard.groups.list_failed', { reason }, locale);
    }
    const body = (r.body as { chats?: ReadonlyArray<GroupsChatInput>; bots?: ReadonlyArray<GroupsBotInput> }) ?? {};
    const matrix = { chats: body.chats ?? [], bots: body.bots ?? [] };
    // Drilldown subcard — `origin` preserves return-to-overview;
    // `scope: 'global'` keeps full matrix semantics.
    const cardJson = buildGroupsCard(matrix, {
      invokerOpenId: operatorOpenId,
      locale,
      page: 1,
      origin: 'overview',
      scope: 'global',
    });
    return { card: { type: 'raw', data: JSON.parse(cardJson) as Record<string, unknown> } };
  }

  return ackToast('card.dashboard.settings.invalid_action', locale);
}

/** Fetch `overview-snapshot` and rebuild the overview card JSON. */
async function rebuildOverview(
  client: DaemonClient,
  invokerOpenId: string,
  locale: Locale,
  workbench?: WorkbenchButtonLinks,
): Promise<OverviewCardHandlerResult> {
  let r: Awaited<ReturnType<DaemonClient['request']>>;
  try {
    // `/dashboard` is global: overview-snapshot widens list modules under
    // `?scope=global` so first-open, refresh, and drilldown stay consistent.
    r = await client.request({ method: 'GET', path: '/__daemon/overview-snapshot?scope=global' });
  } catch (e) {
    return errorToast('card.dashboard.overview.overview_failed', { reason: (e as Error).message }, locale);
  }
  if (r.status !== 200) {
    const reason = String((r.body as any)?.error ?? `http_${r.status}`);
    return errorToast('card.dashboard.overview.overview_failed', { reason }, locale);
  }
  const body = r.body as OverviewSnapshotBody | undefined;
  if (!body || typeof body !== 'object' || !body.settings) {
    return errorToast('card.dashboard.overview.overview_failed', { reason: 'malformed_body' }, locale);
  }
  const cardJson = buildOverviewCard(
    {
      sessions: body.sessions ?? [],
      schedules: body.schedules ?? [],
      settings: body.settings,
    },
    { invokerOpenId, locale, workbench },
  );
  return { card: { type: 'raw', data: JSON.parse(cardJson) as Record<string, unknown> } };
}
