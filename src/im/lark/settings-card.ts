/**
 * Settings card builder + callback handlers (PR3 C4 + revision).
 *
 * Consumes the PR1 `composeSections` DTO and emits a Feishu interactive card
 * JSON. The handler chain is:
 *
 *   1. invoker lock: `action.value.invoker_open_id === operator.open_id`
 *      (plan §7 idiom — only the user who saw the card is allowed to mutate).
 *   2. per-bot owner gate (PR3 revision): `operator.open_id` MUST equal
 *      `bot-registry.getOwnerOpenId(larkAppId)`. The global union_id owner set
 *      is NOT consulted anymore — each callback is scoped to the bot that
 *      received it; A's owner cannot use B's `/dashboard *`.
 *   3. noop short-circuit: `dash_settings_noop` (current-value button in the
 *      segmented control) returns a toast WITHOUT calling the Route B client.
 *      Fail-safe for clients that don't suppress `disabled` callbacks.
 *   4. Sync handler (PR3 UI revision pass 2):
 *        - await the Route B PUT/GET (resolves the owner's union_id via
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
 * Write actions are NEVER retried — the C7 client retry policy already
 * disables non-GET retries, and toggling a setting twice is a real-world
 * effect.
 *
 * Sender identity (`unionId`) NEVER lands on `action.value`. The only field
 * the callback echoes from the original render is `invoker_open_id`, which
 * is the OWNER's open_id (not the sender's union_id).
 */

import { getOwnerOpenId as defaultGetOwnerOpenId } from '../../bot-registry.js';
import { composeSections, type SettingsCardDTO } from '../../dashboard/settings-card-model.js';
import type { DaemonClient } from '../../dashboard/daemon-internal-client.js';
import { type Locale, t } from '../../i18n/index.js';

import { resolveUserUnionId as defaultResolveUserUnionId } from './client.js';
import type { CardActionData } from './card-handler.js';

export const SETTINGS_ACTION_TOGGLE = 'dash_settings_toggle' as const;
export const SETTINGS_ACTION_SET_TIME = 'dash_settings_set_time' as const;
export const SETTINGS_ACTION_REFRESH = 'dash_settings_refresh' as const;
/**
 * PR3 UI revision (codex C4): segmented control sends a noop for the current
 * value button as a fail-safe — even if a Lark client doesn't respect
 * `disabled: true` and still fires the callback, the handler short-circuits.
 */
export const SETTINGS_ACTION_NOOP = 'dash_settings_noop' as const;

const TIME_REGEX = /^([01]\d|2[0-3]):[0-5]\d$/;
const TOGGLE_FIELDS: ReadonlySet<string> = new Set([
  'publicReadOnly',
  'openTerminalInFeishu',
  'autoUpdate',
  'autoRestart',
]);

/** v3 B5: builder opts intentionally exclude any sender identity. */
export interface BuildSettingsCardOpts {
  invokerOpenId: string;
  locale: Locale;
  canWrite: boolean;
}

/** Build a Feishu interactive card JSON string from the PR1 DTO. */
export function buildSettingsCard(dto: SettingsCardDTO, opts: BuildSettingsCardOpts): string {
  const elements: unknown[] = [];

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
      elements.push(...buildSegmentedRow(toggle, opts));
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

  // Refresh button — read-only, GET-only path.
  elements.push({
    tag: 'action',
    actions: [
      {
        tag: 'button',
        text: { tag: 'plain_text', content: t('card.dashboard.settings.refresh', undefined, opts.locale) },
        type: 'default',
        value: {
          action: SETTINGS_ACTION_REFRESH,
          invoker_open_id: opts.invokerOpenId,
        },
      },
    ],
  });

  // Footer security note (PR3 UI revision) — communicates that the card is
  // owner-private and ACK-refreshing, so users know clicks self-heal.
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
 * Build a segmented control row for one toggle (PR3 UI revision):
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
      onBtn.value = { action: SETTINGS_ACTION_NOOP, invoker_open_id: opts.invokerOpenId, field: toggle.key };
    }
  } else {
    onBtn.value = {
      action: SETTINGS_ACTION_TOGGLE,
      invoker_open_id: opts.invokerOpenId,
      field: toggle.key,
      next_value: 'true',
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
      offBtn.value = { action: SETTINGS_ACTION_NOOP, invoker_open_id: opts.invokerOpenId, field: toggle.key };
    }
  } else {
    offBtn.value = {
      action: SETTINGS_ACTION_TOGGLE,
      invoker_open_id: opts.invokerOpenId,
      field: toggle.key,
      next_value: 'false',
    };
  }

  const row: unknown[] = [
    labelLine,
    { tag: 'action', actions: [onBtn, offBtn] },
  ];

  // Per-toggle reason — surfaced ONLY when this specific toggle is disabled.
  // codex C4: autoRestart's reason cites the autoUpdate dependency; autoUpdate's
  // reason cites local-dev install. We never fall back to the generic key here.
  if (!writable && toggle.state.reasonKey) {
    row.push({
      tag: 'note',
      elements: [{ tag: 'lark_md', content: t(toggle.state.reasonKey, undefined, opts.locale) }],
    });
  }

  // autoUpdate always shows the schedule time (read-only when toggle blocked,
  // editable form when writable). Codex C4: even disabled, the JSON MUST
  // contain `04:00`.
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
  /** Override the per-bot owner lookup. Production omits and uses `bot-registry.getOwnerOpenId`. */
  getOwnerOpenId?: (larkAppId: string) => string | undefined;
  /** Override the union_id resolver. Production omits; tests skip Lark contact API. */
  resolveUserUnionId?: (larkAppId: string, openId: string) => Promise<{ unionId?: string }>;
  /** Factory returning a Route B client for the given larkAppId. */
  createClient: (larkAppId: string) => DaemonClient;
  /** Override locale resolution; production uses the caller-supplied locale. */
  locale?: Locale;
}

/**
 * Lark card-callback result envelope. event-dispatcher pass-through expects
 * either `{ toast }`, `{ card }`, or both — see `event-dispatcher.ts:390-395`.
 *
 * PR3 UI revision pass 2 (user feedback 2026-06-09): the handler awaits the
 * GET/PUT inline and returns BOTH `{ toast }` AND `{ card }` in the same
 * response so Lark's client renders them atomically. Why both:
 *  - `toast` → Lark client hides the button spinner and pops the toast.
 *  - `card` → Lark client patches the original card in-place to the post-
 *    write state at the same instant.
 * Returning only `{toast}` and patching out-of-band via `updateMessage`
 * produces a visible stale-render flash (a few frames where the OLD card
 * shows after the spinner dies, then the push arrives and re-renders).
 * Round-trip Route B PUT + card rebuild fits in ~30-80ms; well inside the
 * `event-dispatcher` 2.5s handler timeout (`event-dispatcher.ts:365`).
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
 * Whitelisting (plan v3 B3): `next_value` MUST be the literal string
 * `'true'` or `'false'`. Anything else (`'yes'`, `'TRUE'`, undefined, an
 * object) returns `invalid_value` so an upstream callback drift cannot
 * silently flip a toggle.
 *
 * Time validation (plan v2 B5): HH:MM regex, no silent fallback to 04:00.
 */
export function buildPatchFromAction(
  action: string,
  value: Record<string, string>,
  formValue: Record<string, string>,
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
 * Per codex 2026-06-09: returning toast + card together makes Lark's client
 * render the toast/spinner-removal and the card-replacement as two separate
 * passes — that's the stale-flash users see between the two passes. Drop
 * the toast and return ONLY the card; the card body itself carries the
 * "✓ 已开启 / ✓ 已关闭" signal so the user knows the write succeeded.
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
): SettingsCardHandlerResult {
  const settings = (payload as any)?.body?.settings ?? (payload as any)?.settings;
  if (!settings || typeof settings !== 'object') {
    return { toast: { type: 'success', content: t(fallbackToastKey, undefined, locale) } };
  }
  const dto = composeSections(settings, { canWrite: true });
  const cardJson = buildSettingsCard(dto, { invokerOpenId, locale, canWrite: true });
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

  // ─── 1) Invoker lock — fail-closed (B3) ─────────────────────────────
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

  // ─── 2) Per-bot owner gate (PR3 revision) ────────────────────────────
  // We no longer consult the global union_id owner set. Each callback is
  // scoped to the bot that received it: only THAT bot's owner can act.
  // `action.value.*` identity fields are still ignored (red line).
  const getOwnerOpenId = deps.getOwnerOpenId ?? defaultGetOwnerOpenId;
  const expectedOwner = getOwnerOpenId(larkAppId);
  if (!expectedOwner || operatorOpenId !== expectedOwner) {
    return ackToast('card.dashboard.settings.owner_only', locale);
  }

  // ─── 3) Noop short-circuit (PR3 UI revision, codex C4) ───────────────
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
      return successResult(snap, expectedOwner, locale, 'card.dashboard.settings.refreshed');
    } catch (e) {
      return errorToast('card.dashboard.settings.snapshot_failed', { reason: (e as Error).message }, locale);
    }
  }

  // ─── 4b) Write path — toggle / set_time ─────────────────────────────
  const patch = buildPatchFromAction(action ?? '', value, formValue);
  if (!patch.ok) {
    return ackToast(`card.dashboard.settings.${patch.error}`, locale);
  }

  // PR2 Route B's `PUT /__daemon/settings-write` still expects `ownerUnionId`
  // in the body for global-owner verification on the server side. The local
  // per-bot owner gate above already accepted this caller; we just need to
  // surface their union_id.
  const resolveUnion = deps.resolveUserUnionId ?? defaultResolveUserUnionId;
  let ownerUnionId: string | undefined;
  try {
    const r = await resolveUnion(larkAppId, expectedOwner);
    ownerUnionId = r.unionId;
  } catch { /* fail-closed: leave undefined → owner_only */ }
  if (!ownerUnionId || !ownerUnionId.startsWith('on_')) {
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
    return successResult(r, expectedOwner, locale, 'card.dashboard.settings.saved');
  } catch (e) {
    return errorToast('card.dashboard.settings.save_failed', { reason: (e as Error).message }, locale);
  }
}
