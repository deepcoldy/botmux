/**
 * Settings card builder + callback handlers (PR3 C4).
 *
 * Consumes the PR1 `composeSections` DTO and emits a Feishu interactive card
 * JSON. The handler chain is:
 *
 *   1. invoker lock: `action.value.invoker_open_id === operator.open_id`
 *      (plan §7 idiom — only the user who saw the card is allowed to mutate).
 *   2. verified union_id via C2 `resolveCardOperatorUnionId` → reject if absent
 *      or non-`on_`.
 *   3. global owner gate via PR2 `isAuthorizedForGlobalSettings` → 403.
 *   4. ACK-then-patch:
 *        - sync `ack` payload (Lark toast),
 *        - async write via PR2 Route B client,
 *        - async refresh card schema with the post-write snapshot.
 *
 * Write actions are NEVER retried — the C7 client retry policy already
 * disables non-GET retries, and toggling a setting twice is a real-world
 * effect.
 *
 * Sender identity (`unionId`) NEVER lands on `action.value`. The only field
 * the callback echoes from the original render is `invoker_open_id`, which
 * is `operator.open_id` (NOT `senderUnionId`).
 */

import { isAuthorizedForGlobalSettings } from '../../dashboard/settings-owner-resolver.js';
import type { SettingsCardDTO } from '../../dashboard/settings-card-model.js';
import type { DaemonClient } from '../../dashboard/daemon-internal-client.js';
import { type Locale, t } from '../../i18n/index.js';

import {
  resolveCardOperatorUnionId,
  type CardActionData,
  type ResolveCardOperatorUnionIdDeps,
} from './card-handler.js';

export const SETTINGS_ACTION_TOGGLE = 'dash_settings_toggle' as const;
export const SETTINGS_ACTION_SET_TIME = 'dash_settings_set_time' as const;
export const SETTINGS_ACTION_REFRESH = 'dash_settings_refresh' as const;

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

  if (dto.readOnlyHintKey) {
    elements.push({
      tag: 'div',
      text: { tag: 'lark_md', content: `⚠️ ${t(dto.readOnlyHintKey, undefined, opts.locale)}` },
    });
  }

  for (const section of dto.sections) {
    elements.push({
      tag: 'div',
      text: { tag: 'lark_md', content: `**${t(section.titleKey, undefined, opts.locale)}**` },
    });

    for (const toggle of section.toggles) {
      elements.push(...buildToggleRow(toggle, opts));
    }

    if (section.hintKey) {
      elements.push({
        tag: 'note',
        elements: [
          { tag: 'lark_md', content: `ℹ️ ${t(section.hintKey, undefined, opts.locale)}` },
        ],
      });
    }
    elements.push({ tag: 'hr' });
  }

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

  return JSON.stringify({
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: t('card.dashboard.settings.title', undefined, opts.locale) },
      template: 'blue',
    },
    elements,
  });
}

function buildToggleRow(
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

  // Disabled toggles are rendered without an action button — Lark can't react
  // to a static `disabled: true` schema field reliably across all clients.
  if (!toggle.state.enabled) {
    return [labelLine, {
      tag: 'note',
      elements: [{ tag: 'lark_md', content: toggle.state.reasonKey
        ? t(toggle.state.reasonKey, undefined, opts.locale)
        : t('card.dashboard.settings.toggle.disabled', undefined, opts.locale) }],
    }];
  }

  const toggleButton = {
    tag: 'button',
    text: {
      tag: 'plain_text',
      content: toggle.enabled
        ? t('card.dashboard.settings.toggle.on', undefined, opts.locale)
        : t('card.dashboard.settings.toggle.off', undefined, opts.locale),
    },
    type: toggle.enabled ? 'primary' : 'default',
    value: {
      action: SETTINGS_ACTION_TOGGLE,
      invoker_open_id: opts.invokerOpenId,
      field: toggle.key,
      next_value: toggle.enabled ? 'false' : 'true',
    },
  };

  const row: unknown[] = [labelLine, {
    tag: 'action',
    actions: [toggleButton],
  }];

  if (toggle.time) {
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

  return row;
}

/** ─── Handler ─────────────────────────────────────────────────────────── */

export interface SettingsCardHandlerDeps extends ResolveCardOperatorUnionIdDeps {
  /** Override for the global owner check. Production wires `isAuthorizedForGlobalSettings`. */
  isAuthorized?: (check: { senderUnionId: string }) => Promise<boolean>;
  /** Factory returning a Route B client for the given larkAppId. */
  createClient: (larkAppId: string) => DaemonClient;
  /** Card patch callback for ACK-then-patch — receives the post-write snapshot. */
  patchCard?: (data: CardActionData, larkAppId: string, payload: unknown) => Promise<void>;
  /** Async scheduler — production uses `setImmediate`; tests pass a sync runner. */
  scheduleAsync?: (fn: () => Promise<void>) => void;
  /** Override locale resolution; production uses the caller-supplied locale. */
  locale?: Locale;
}

/**
 * Lark card-callback result envelope. event-dispatcher pass-through expects
 * either `{ toast }`, `{ card }`, or both — see `event-dispatcher.ts:390-395`.
 * We return ONLY `{ toast }` because the actual card patch is performed
 * asynchronously via `deps.patchCard` (ACK-then-patch).
 */
export interface SettingsCardHandlerResult {
  toast: { type: 'info' | 'success' | 'error'; content: string };
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

const defaultScheduleAsync = (fn: () => Promise<void>): void => {
  void fn().catch(() => { /* logged inside fn */ });
};

/**
 * Dispatch a `dash_settings_*` action callback. Returns the synchronous ACK
 * payload; the network write happens asynchronously via `deps.scheduleAsync`.
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

  // ─── 2) Verified union_id via C2 helper ─────────────────────────────
  const identity = await resolveCardOperatorUnionId(data, larkAppId, {
    resolveUserUnionId: deps.resolveUserUnionId,
  });
  if (!identity.unionId) {
    return ackToast('card.dashboard.settings.owner_only', locale);
  }

  // ─── 3) Global owner gate ───────────────────────────────────────────
  const authoriser = deps.isAuthorized ?? isAuthorizedForGlobalSettings;
  const allowed = await authoriser({ senderUnionId: identity.unionId });
  if (!allowed) {
    return ackToast('card.dashboard.settings.owner_only', locale);
  }

  const schedule = deps.scheduleAsync ?? defaultScheduleAsync;

  // ─── 4a) Refresh — read-only path (NO PUT, no patch payload) ────────
  if (action === SETTINGS_ACTION_REFRESH) {
    schedule(async () => {
      const client = deps.createClient(larkAppId);
      const snap = await client.request({ method: 'GET', path: '/__daemon/settings-snapshot' });
      await deps.patchCard?.(data, larkAppId, snap);
    });
    return ackToast('card.dashboard.settings.refreshing', locale);
  }

  // ─── 4b) Write path — toggle / set_time ─────────────────────────────
  const patch = buildPatchFromAction(action ?? '', value, formValue);
  if (!patch.ok) {
    return ackToast(`card.dashboard.settings.${patch.error}`, locale);
  }

  schedule(async () => {
    const client = deps.createClient(larkAppId);
    // PR2 client default does NOT retry non-GET; do NOT opt in via retryUnsafeWrites.
    const r = await client.request({
      method: 'PUT',
      path: '/__daemon/settings-write',
      body: { patch: patch.value, ownerUnionId: identity.unionId },
    });
    await deps.patchCard?.(data, larkAppId, r);
  });
  return ackToast('card.dashboard.settings.saving', locale);
}
