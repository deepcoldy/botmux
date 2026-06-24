/**
 * Settings dashboard card.
 *
 * Consumes the settings DTO and emits a Feishu interactive card. The handler
 * chain is:
 *
 *   1. invoker lock: `action.value.invoker_open_id === operator.open_id`.
 *   2. per-bot admin gate: `operator.open_id` MUST be one of this bot's
 *      resolved `allowedUsers`, matching `/botconfig`. Each callback is
 *      scoped to the bot that received it; an admin of bot A cannot use
 *      bot B's `/dashboard *`.
 *   3. noop short-circuit: `dash_settings_noop` (current-value button in the
 *      segmented control) returns a toast WITHOUT calling the Route B client.
 *      Fail-safe for clients that don't suppress `disabled` callbacks.
 *   4. Sync handler:
 *        - await the Route B PUT/GET (resolves the admin's union_id via
 *          `resolveUserUnionId` first, since the server-side write API
 *          still requires `ownerUnionId` in the body),
 *        - return ONLY `{ card }` (no toast) on the success path so the
 *          event-dispatcher passes the rebuilt card body back to Lark in
 *          the SAME callback response. Toast + card together makes the
 *          Lark client render the toast and the card replacement in two
 *          separate passes, flashing the OLD card state during the gap;
 *          card-only avoids that. Errors/permission denials/noop still
 *          return a plain toast (they have no card to render).
 *
 * Write actions are never retried; toggling a setting twice is a real-world
 * effect.
 *
 * Sender identity (`unionId`) NEVER lands on `action.value`. The only field
 * the callback echoes from the original render is `invoker_open_id`, which
 * is the invoking admin's open_id (not the sender's union_id).
 */

import { isDashboardAdmin } from '../../dashboard/dashboard-admins.js';
import { composeSections, type SettingsCardDTO } from '../../dashboard/settings-card-model.js';
import type { DaemonClient } from '../../dashboard/daemon-internal-client.js';
import { type Locale, t } from '../../i18n/index.js';

import { resolveUserUnionId as defaultResolveUserUnionId } from './client.js';
import type { CardActionData } from './card-handler.js';

export const SETTINGS_ACTION_TOGGLE = 'dash_settings_toggle' as const;
export const SETTINGS_ACTION_SET_TIME = 'dash_settings_set_time' as const;
export const SETTINGS_ACTION_REFRESH = 'dash_settings_refresh' as const;
/** Current-value segmented-control buttons send noop as a fail-safe. */
export const SETTINGS_ACTION_NOOP = 'dash_settings_noop' as const;
/** Action emitted by "🔙 返回总览" on overview-origin settings cards. Same
 *  string as overview-card's OVERVIEW_ACTION_REFRESH (kept in sync; we don't
 *  import to avoid a circular dep). */
const BACK_TO_OVERVIEW_ACTION = 'dash_overview_refresh' as const;

const TIME_REGEX = /^([01]\d|2[0-3]):[0-5]\d$/;
const TOGGLE_FIELDS: ReadonlySet<string> = new Set([
  'publicReadOnly',
  'openTerminalInFeishu',
  'autoUpdate',
  'autoRestart',
]);

/** Builder opts intentionally exclude sender union identity. */
export interface BuildSettingsCardOpts {
  invokerOpenId: string;
  locale: Locale;
  canWrite: boolean;
  /** Overview drilldown nav state. `'overview'` → footer renders
   *  "🔙 返回总览" AND every action.value carries `origin=overview` so
   *  toggle/set_time/refresh rebuilds keep the return affordance.
   *  Settings is single-layer (no pages) → no `pageSize`. */
  origin?: 'overview';
}

/** Build a Feishu interactive card JSON string from the settings DTO. */
export function buildSettingsCard(dto: SettingsCardDTO, opts: BuildSettingsCardOpts): string {
  const elements: unknown[] = [];

  // Nav state — threaded into every action.value so the rebuild path keeps
  // 「🔙 返回总览」 affordance across toggle/set_time/refresh round-trips.
  // Empty values omitted → standalone cards stay byte-identical.
  const navFields: Record<string, string> = {};
  if (opts.origin === 'overview') navFields.origin = 'overview';

  // Header summary was dropped per user feedback: segmented controls already
  // make each toggle's state self-evident; a top-level summary becomes a second
  // explanation system that drifts as configuration grows. Section-internal
  // warnings (localDev, autoUpdate dependency) stay where the user reads them.

  if (dto.readOnlyHintKey) {
    elements.push({
      tag: 'div',
      text: { tag: 'lark_md', content: `⚠️ ${t(dto.readOnlyHintKey, undefined, opts.locale)}` },
    });
  }

  for (const section of dto.sections) {
    elements.push({ tag: 'hr' });
    elements.push({
      tag: 'div',
      text: { tag: 'lark_md', content: `**${t(section.titleKey, undefined, opts.locale)}**` },
    });

    for (const toggle of section.toggles) {
      elements.push(...buildSegmentedRow(toggle, opts, navFields));
    }

    if (section.hintKey) {
      elements.push({
        tag: 'note',
        elements: [
          { tag: 'lark_md', content: `ℹ️ ${t(section.hintKey, undefined, opts.locale)}` },
        ],
      });
    }
  }

  elements.push({ tag: 'hr' });

  // Refresh button — read-only, GET-only path. When the card was opened via
  // overview drilldown, append "🔙 返回总览" beside it; standalone settings
  // command omits the back button (no parent card to return to).
  const footerActions: unknown[] = [
    {
      tag: 'button',
      text: { tag: 'plain_text', content: t('card.dashboard.settings.refresh', undefined, opts.locale) },
      type: 'default',
      value: {
        action: SETTINGS_ACTION_REFRESH,
        invoker_open_id: opts.invokerOpenId,
        ...navFields,
      },
    },
  ];
  if (opts.origin === 'overview') {
    footerActions.push({
      tag: 'button',
      text: { tag: 'plain_text', content: t('card.dashboard.overview.back_button', undefined, opts.locale) },
      type: 'default',
      value: {
        action: BACK_TO_OVERVIEW_ACTION,
        invoker_open_id: opts.invokerOpenId,
      },
    });
  }
  elements.push({ tag: 'action', actions: footerActions });

  // Footer security note: the card is admin-private and refreshable.
  elements.push({
    tag: 'note',
    elements: [
      { tag: 'lark_md', content: t('card.dashboard.settings.footer.security', undefined, opts.locale) },
    ],
  });

  return JSON.stringify({
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: t('card.dashboard.settings.title', undefined, opts.locale) },
      template: 'blue',
    },
    elements,
  });
}

/**
 * Build a segmented control row for one toggle:
 *  - Current value button: `type: primary` + `disabled: true` + `✓ 已开启/已关闭`
 *    + carries `dash_settings_noop` action (belt-and-suspenders short-circuit).
 *  - Target value button: `type: default` + clickable + `dash_settings_toggle` action.
 *  - When the whole toggle is disabled (state.enabled=false): both buttons
 *    carry NO action, current still primary, target still default for clear
 *    visual; per-toggle `state.reasonKey` is surfaced as a note.
 *  - autoUpdate also renders a read-only "更新时间：HH:MM" line, AND when
 *    writable a form to update the time (carries the existing set_time
 *    action). The display line is present whether the toggle is disabled
 *    or not, so users always see the scheduled time.
 */
function buildSegmentedRow(
  toggle: SettingsCardDTO['sections'][number]['toggles'][number],
  opts: BuildSettingsCardOpts,
  navFields: Record<string, string>,
): unknown[] {
  const labelLine = {
    tag: 'div',
    text: {
      tag: 'lark_md',
      content:
        `${toggle.enabled ? '🟢' : '⚪'} **${t(toggle.labelKey, undefined, opts.locale)}**` +
        `\n<font color="grey">${t(toggle.hintKey, undefined, opts.locale)}</font>`,
    },
  };

  const enabled = toggle.enabled;
  const writable = toggle.state.enabled;

  const onText = t(
    enabled ? 'card.dashboard.settings.segment.on_current' : 'card.dashboard.settings.segment.on',
    undefined, opts.locale,
  );
  const offText = t(
    !enabled ? 'card.dashboard.settings.segment.off_current' : 'card.dashboard.settings.segment.off',
    undefined, opts.locale,
  );

  // ON button — primary+current when ON, default+target when OFF
  const onBtn: Record<string, unknown> = {
    tag: 'button',
    text: { tag: 'plain_text', content: onText },
    type: enabled ? 'primary' : 'default',
  };
  if (enabled || !writable) {
    // Current value (always primary) — `disabled` lets the client suppress the
    // callback, and the noop action is the fallback if it doesn't.
    onBtn.disabled = true;
    if (writable) {
      onBtn.value = { action: SETTINGS_ACTION_NOOP, invoker_open_id: opts.invokerOpenId, field: toggle.key, ...navFields };
    }
  } else {
    onBtn.value = {
      action: SETTINGS_ACTION_TOGGLE,
      invoker_open_id: opts.invokerOpenId,
      field: toggle.key,
      next_value: 'true',
      ...navFields,
    };
  }

  // OFF button — primary+current when OFF, default+target when ON
  const offBtn: Record<string, unknown> = {
    tag: 'button',
    text: { tag: 'plain_text', content: offText },
    type: !enabled ? 'primary' : 'default',
  };
  if (!enabled || !writable) {
    offBtn.disabled = true;
    if (writable) {
      offBtn.value = { action: SETTINGS_ACTION_NOOP, invoker_open_id: opts.invokerOpenId, field: toggle.key, ...navFields };
    }
  } else {
    offBtn.value = {
      action: SETTINGS_ACTION_TOGGLE,
      invoker_open_id: opts.invokerOpenId,
      field: toggle.key,
      next_value: 'false',
      ...navFields,
    };
  }

  const row: unknown[] = [
    labelLine,
    { tag: 'action', actions: [onBtn, offBtn] },
  ];

  // Surface only this toggle's precise disabled reason; do not fall back to a
  // generic key that would hide the actionable dependency.
  if (!writable && toggle.state.reasonKey) {
    row.push({
      tag: 'note',
      elements: [{ tag: 'lark_md', content: t(toggle.state.reasonKey, undefined, opts.locale) }],
    });
  }

  // autoUpdate always shows the schedule time (read-only when toggle blocked,
  // editable form when writable).
  if (toggle.time) {
    row.push({
      tag: 'div',
      text: {
        tag: 'lark_md',
        content: `<font color="grey">${t(
          'card.dashboard.settings.maintenance.time_display',
          { time: toggle.time.value }, opts.locale,
        )}</font>`,
      },
    });
    if (writable) {
      row.push({
        tag: 'form',
        name: `settings_time_${toggle.key}`,
        elements: [
          {
            tag: 'input',
            name: 'time',
            placeholder: { tag: 'plain_text', content: 'HH:MM' },
            default_value: toggle.time.value,
          },
          {
            tag: 'action',
            actions: [
              {
                tag: 'button',
                text: { tag: 'plain_text', content: t('card.dashboard.settings.save_time', undefined, opts.locale) },
                type: 'primary',
                form_action_type: 'submit',
                value: {
                  action: SETTINGS_ACTION_SET_TIME,
                  invoker_open_id: opts.invokerOpenId,
                  field: toggle.key,
                  ...navFields,
                },
              },
            ],
          },
        ],
      });
    }
  }

  return row;
}

/** ─── Handler ─────────────────────────────────────────────────────────── */

export interface SettingsCardHandlerDeps {
  /** Legacy owner test seam; prefer `getDashboardAdminOpenIds` for new tests. */
  getOwnerOpenId?: (larkAppId: string) => string | undefined;
  getDashboardAdminOpenIds?: (larkAppId: string) => ReadonlyArray<string> | undefined;
  /** Override the union_id resolver. Production omits; tests skip Lark contact API. */
  resolveUserUnionId?: (larkAppId: string, openId: string) => Promise<{ unionId?: string }>;
  /** Factory returning a Route B client for the given larkAppId. */
  createClient: (larkAppId: string) => DaemonClient;
  /** Override locale resolution; production uses the caller-supplied locale. */
  locale?: Locale;
}

async function resolveVerifiedOperatorUnionId(
  data: CardActionData,
  larkAppId: string,
  operatorOpenId: string,
  deps: Pick<SettingsCardHandlerDeps, 'resolveUserUnionId'>,
): Promise<string | undefined> {
  const verified = data.operator?.union_id;
  if (typeof verified === 'string') {
    return verified.startsWith('on_') ? verified : undefined;
  }
  const resolveUnion = deps.resolveUserUnionId ?? defaultResolveUserUnionId;
  try {
    const r = await resolveUnion(larkAppId, operatorOpenId);
    return typeof r.unionId === 'string' && r.unionId.startsWith('on_') ? r.unionId : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Lark card-callback result envelope. event-dispatcher pass-through expects
 * either `{ toast }`, `{ card }`, or both — see `event-dispatcher.ts:390-395`.
 *
 * The handler awaits GET/PUT inline. On the success path it returns ONLY
 * `{ card }` (no toast). Why card-only:
 *  - Lark's client renders toast and card replacement as two separate passes;
 *    users briefly see the old card state between them.
 *  - Card-only collapses that to a single pass — the card body itself
 *    (`✓ 已开启` / `✓ 已关闭`) is the feedback signal; users learn the
 *    write succeeded from the new state, not from a toast.
 * Error / permission denial / noop still return `{ toast }` (no card to
 * render anyway). Round-trip Route B PUT + card rebuild fits in ~30-80ms;
 * well inside the `event-dispatcher` 2.5s handler timeout
 * (`event-dispatcher.ts:365`).
 */
export interface SettingsCardHandlerResult {
  /** Optional — success path now returns ONLY a `card` to avoid the
   *  toast + card two-pass render that flashes the OLD state. Errors,
   *  permission denials, and noop still return a toast. */
  toast?: { type: 'info' | 'success' | 'error'; content: string };
  card?: { type: 'raw'; data: Record<string, unknown> };
}

export type PatchBuildResult =
  | { ok: true; value: unknown }
  | { ok: false; error: 'invalid_field' | 'invalid_value' | 'invalid_time' | 'invalid_action' };

/**
 * Build the dashboard settings patch from an action callback. Pure — caller
 * decides whether to PUT.
 *
 * Whitelisting: `next_value` MUST be the literal string
 * `'true'` or `'false'`. Anything else (`'yes'`, `'TRUE'`, undefined, an
 * object) returns `invalid_value` so an upstream callback drift cannot
 * silently flip a toggle.
 *
 * Time validation: HH:MM regex, no silent fallback to 04:00.
 */
export function buildPatchFromAction(
  action: string,
  value: Record<string, string>,
  formValue: Record<string, unknown>,
): PatchBuildResult {
  switch (action) {
    case SETTINGS_ACTION_TOGGLE: {
      const field = value.field;
      if (typeof field !== 'string' || !TOGGLE_FIELDS.has(field)) {
        return { ok: false, error: 'invalid_field' };
      }
      const raw = value.next_value;
      if (raw !== 'true' && raw !== 'false') {
        return { ok: false, error: 'invalid_value' };
      }
      const next = raw === 'true';
      if (field === 'publicReadOnly' || field === 'openTerminalInFeishu') {
        return { ok: true, value: { [field]: next } };
      }
      return { ok: true, value: { maintenance: { [field]: { enabled: next } } } };
    }
    case SETTINGS_ACTION_SET_TIME: {
      const time = formValue.time;
      if (typeof time !== 'string' || !TIME_REGEX.test(time)) {
        return { ok: false, error: 'invalid_time' };
      }
      return { ok: true, value: { maintenance: { autoUpdate: { time } } } };
    }
    default:
      return { ok: false, error: 'invalid_action' };
  }
}

function ackToast(textKey: string, locale: Locale): SettingsCardHandlerResult {
  return { toast: { type: 'info', content: t(textKey, undefined, locale) } };
}

function errorToast(textKey: string, params: Record<string, string> | undefined, locale: Locale): SettingsCardHandlerResult {
  return { toast: { type: 'error', content: t(textKey, params, locale) } };
}

/**
 * Build a `{ card }` envelope from a Route B settings response.
 *
 * Returning toast + card together makes Lark render spinner removal and card
 * replacement as separate passes, causing a stale-frame flash. Return only
 * the card; the new card state is the success signal.
 *
 * If the payload carries no settings (malformed response), fall back to a
 * generic success toast so the user gets *some* feedback. Error paths still
 * use error toasts — those don't have a card to render anyway.
 */
function successResult(
  payload: unknown,
  invokerOpenId: string,
  locale: Locale,
  fallbackToastKey: string,
  origin?: 'overview',
): SettingsCardHandlerResult {
  const settings = (payload as any)?.body?.settings ?? (payload as any)?.settings;
  if (!settings || typeof settings !== 'object') {
    return { toast: { type: 'success', content: t(fallbackToastKey, undefined, locale) } };
  }
  const dto = composeSections(settings, { canWrite: true });
  const cardJson = buildSettingsCard(dto, { invokerOpenId, locale, canWrite: true, origin });
  // No `toast` on the success path — the card body itself ("✓ 已开启" /
  // "✓ 已关闭") is the feedback. Returning toast + card together triggers
  // two separate render passes on the Lark client and flashes the OLD card
  // state during the gap.
  return {
    card: { type: 'raw', data: JSON.parse(cardJson) as Record<string, unknown> },
  };
}

/**
 * Dispatch a `dash_settings_*` action callback. Awaits the Route B
 * GET/PUT inline. Success path returns `{ card }` (card-only — see the
 * module docstring for why we drop the toast). Errors / permission
 * denials / noop return a plain `{ toast }`.
 */
export async function handleSettingsCardAction(
  data: CardActionData,
  larkAppId: string,
  deps: SettingsCardHandlerDeps,
): Promise<SettingsCardHandlerResult> {
  const locale: Locale = deps.locale ?? 'zh';
  const value = data.action?.value ?? {};
  const formValue = data.action?.form_value ?? {};
  const operatorOpenId = data.operator?.open_id;
  const action = value.action;

  // ─── 1) Invoker lock — fail-closed ──────────────────────────────────
  // Settings card is new — there is no legacy callback shape to keep
  // compatible. Reject any callback whose envelope is missing either side
  // of the invoker assertion, then reject when they disagree.
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

  // ─── 2) Per-bot admin gate ───────────────────────────────────────────
  // Match `/botconfig`: any resolved allowedUsers entry can act. The
  // invoker lock above still pins this specific card to the admin who
  // received it, and `action.value.*` identity fields are ignored.
  if (!isDashboardAdmin(larkAppId, operatorOpenId, deps)) {
    return ackToast('card.dashboard.settings.owner_only', locale);
  }

  // ─── Nav state (overview drilldown) ─────────────────────────────────
  // Threaded by buildSettingsCard onto every action.value; we parse here
  // so refresh / toggle / set_time rebuilds keep the「🔙 返回总览」 button.
  const navOrigin: 'overview' | undefined =
    (value as Record<string, unknown>).origin === 'overview' ? 'overview' : undefined;

  // ─── 3) Noop short-circuit ───────────────────────────────────────────
  // The current-value button in the segmented control is rendered with
  // `disabled: true` but ALSO carries `dash_settings_noop` as a fail-safe:
  // if any Lark client doesn't suppress disabled callbacks, we just toast
  // and skip the network entirely. This is the only path that returns a
  // success-typed toast without any side effect.
  if (action === SETTINGS_ACTION_NOOP) {
    return ackToast('card.dashboard.settings.toggle.disabled', locale);
  }

  // ─── 4a) Refresh — read-only path (NO PUT) ───────────────────────────
  // Inline await + return rebuilt card in the SAME response (card-only,
  // see successResult docstring for why we don't return a toast here).
  if (action === SETTINGS_ACTION_REFRESH) {
    try {
      const client = deps.createClient(larkAppId);
      const snap = await client.request({ method: 'GET', path: '/__daemon/settings-snapshot' });
      return successResult(snap, operatorOpenId, locale, 'card.dashboard.settings.refreshed', navOrigin);
    } catch (e) {
      return errorToast('card.dashboard.settings.snapshot_failed', { reason: (e as Error).message }, locale);
    }
  }

  // ─── 4b) Write path — toggle / set_time ─────────────────────────────
  const patch = buildPatchFromAction(action ?? '', value, formValue);
  if (!patch.ok) {
    return ackToast(`card.dashboard.settings.${patch.error}`, locale);
  }

  // Route B still expects `ownerUnionId` for global settings authorization.
  // Prefer Lark's verified callback field; only fall back to contact lookup
  // when Lark omitted it. Never read identity from action.value.
  const ownerUnionId = await resolveVerifiedOperatorUnionId(data, larkAppId, operatorOpenId, deps);
  if (!ownerUnionId) {
    return ackToast('card.dashboard.settings.owner_only', locale);
  }

  try {
    const client = deps.createClient(larkAppId);
    const r = await client.request({
      method: 'PUT',
      path: '/__daemon/settings-write',
      body: { patch: patch.value, ownerUnionId },
    });
    if ((r as any)?.status >= 400) {
      return errorToast(
        'card.dashboard.settings.save_failed',
        { reason: String((r as any)?.body?.error ?? `HTTP ${(r as any)?.status}`) },
        locale,
      );
    }
    return successResult(r, operatorOpenId, locale, 'card.dashboard.settings.saved', navOrigin);
  } catch (e) {
    return errorToast('card.dashboard.settings.save_failed', { reason: (e as Error).message }, locale);
  }
}
