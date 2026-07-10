/**
 * Settings write applier — single source of truth for what
 * `PUT /api/settings` (`dashboard.ts:460-498`) used to do inline.
 *
 * Lives in `src/dashboard/` so both:
 *   - the existing browser-facing `PUT /api/settings` route
 *   - the new HMAC-gated `PUT /__daemon/settings-write` route
 * share the same validation + persistence path. Behaviour is byte-equivalent
 * to the original inline implementation; the only change is that all IO is
 * funnelled through `deps`, so tests don't touch `~/.botmux`.
 */

import type {
  DashboardGlobalConfig,
  GlobalConfig,
  MaintenanceConfig,
} from '../global-config.js';
import {
  mergeDashboardConfig,
  mergeGlobalConfig,
  mergeMaintenanceConfig,
  parseMaintenancePatch,
  readGlobalConfig,
  setGlobalLocale,
} from '../global-config.js';
import { isLocale } from '../i18n/types.js';
import { isLocalDevInstall } from '../utils/install-info.js';
import { isValidTimeZone } from '../utils/timezone.js';

/**
 * Snapshot returned by `resolveDashboardSettings` — mirrors the existing
 * `ResolvedDashboardSettings` interface in `dashboard.ts:69-80`. We redeclare
 * it locally rather than reaching across that boundary because the applier
 * doesn't know how the host computes the snapshot (it just calls a closure).
 */
export interface ResolvedDashboardSettingsView {
  publicReadOnly: boolean;
  openTerminalInFeishu: boolean;
  chatBotDiscovery: boolean;
  vcMeetingAgent: {
    enabled: boolean;
    listenerBotAppId?: string | null;
    listenerBotOptions?: Array<{
      larkAppId: string;
      botName?: string | null;
      cliId?: string;
      vcMeetingAgentEnabled?: boolean;
      hasLarkCliProfile?: boolean;
    }>;
    larkCliVersion?: string | null;
    larkCliMeetsRequirement?: boolean;
    larkCliMinVersion?: string;
  };
  maintenance: MaintenanceConfig;
  localDevInstall: boolean;
  remoteAccess?: boolean;
  /** Configured schedule-task timezone override (IANA), or null/absent when
   *  unset ⇒ the scheduler follows `hostTimeZone`. */
  scheduleTimeZone?: string | null;
  /** Host's auto-detected local zone. */
  hostTimeZone?: string;
  /** The TRUE effective zone (scheduleTimeZone(): env → config → host). The UI
   *  must use this for "currently effective", not configured||host. */
  effectiveScheduleTimeZone?: string;
}

export type ParseMaintenanceResult =
  | { ok: true; patch: MaintenanceConfig }
  | { ok: false; error: string };

/** All IO this helper needs — injected so tests use mocks, production wires real impls. */
export interface SettingsWriteApplierDeps {
  /** Snapshot of `~/.botmux/config.json`. Used to look up the persisted autoUpdate state when the incoming patch doesn't change it. */
  readGlobalConfig: () => GlobalConfig;
  /** Atomic write of dashboard-level fields (publicReadOnly / openTerminalInFeishu). */
  mergeDashboardConfig: (patch: DashboardGlobalConfig) => DashboardGlobalConfig;
  /** Atomic write of global-level fields (repoPickerMode / scheduleTimeZone / …).
   *  Mirrors the real `mergeGlobalConfig`: a `null` value deletes that key. */
  mergeGlobalConfig: (patch: Partial<Record<keyof GlobalConfig, GlobalConfig[keyof GlobalConfig] | null>>) => void;
  /** Atomic write of maintenance-level fields (autoUpdate / autoRestart). */
  mergeMaintenanceConfig: (patch: MaintenanceConfig) => MaintenanceConfig;
  /** Set global UI locale (null = clear). Fans out to daemons via IPC. */
  setGlobalLocale: (locale: 'zh' | 'en' | null) => void;
  /** Type-strict body validator for the maintenance segment. */
  parseMaintenancePatch: (body: unknown) => ParseMaintenanceResult;
  /** True iff the current install is a source-checkout (auto-update unavailable). */
  isLocalDevInstall: () => boolean;
  /** Returns the post-merge view the response body echoes back to the caller. */
  resolveDashboardSettings: () => ResolvedDashboardSettingsView;
  /** Validate locale string. */
  isLocale: (v: unknown) => v is 'zh' | 'en';
  /** Fan out locale reload to all online daemons. */
  reloadLocaleOnAllDaemons?: () => Promise<void>;
  /** Validate a global VC listener bot selection before mutating bot/global config. */
  validateVcMeetingListenerBotAppId?: (appId: string) => Promise<{ ok: true } | { ok: false; error: string }>;
  /** Sync per-bot meeting-listener config after validation passes or when clearing the selection. */
  syncVcMeetingListenerBotConfig?: (listenerBotAppId: string | null, previousListenerBotAppId?: string | null) => Promise<{ ok: true } | { ok: false; error: string; feishuLoginQr?: string }>;
}

/** Production deps wiring — call once per dashboard process. */
export function defaultSettingsWriteApplierDeps(
  resolveDashboardSettings: () => ResolvedDashboardSettingsView,
  reloadLocaleOnAllDaemons?: () => Promise<void>,
): SettingsWriteApplierDeps {
  return {
    readGlobalConfig,
    mergeDashboardConfig,
    mergeGlobalConfig,
    mergeMaintenanceConfig,
    setGlobalLocale,
    parseMaintenancePatch,
    isLocalDevInstall,
    resolveDashboardSettings,
    isLocale,
    reloadLocaleOnAllDaemons,
  };
}

export type ApplySettingsWriteResult =
  | { ok: true; settings: ResolvedDashboardSettingsView }
  | { ok: false; error: ApplySettingsWriteError; feishuLoginQr?: string };

/**
 * Discrete error codes — every one of these MUST match the strings the old
 * inline `PUT /api/settings` route returned, so callers (browser SPA, tests,
 * PR2 Route B) see the same wire vocabulary they had before.
 */
export type ApplySettingsWriteError =
  | 'invalid_publicReadOnly'
  | 'invalid_openTerminalInFeishu'
  | 'invalid_chatBotDiscovery'
  | 'invalid_repoPickerMode'
  | 'invalid_remoteAccess'
  | 'invalid_vcMeetingAgent'
  | 'invalid_vcMeetingAgent_enabled'
  | 'invalid_vcMeetingAgent_listenerBotAppId'
  | 'invalid_scheduleTimeZone'
  | 'invalid_whiteboard'
  | 'invalid_whiteboard_enabled'
  | 'invalid_lang'
  | 'invalid_maintenance' // ← never returned literally; surfaces parseMaintenancePatch's reason instead
  | 'local_dev_no_autoupdate'
  | 'autoupdate_required'
  | 'empty_patch'
  | string;          // catch-all: parseMaintenancePatch error strings

/**
 * Apply a parsed (object) settings patch. Returns success with the post-merge
 * snapshot, or an error code string on validation failure.
 *
 * Behaviour mirrors `dashboard.ts:460-498` exactly:
 *   - Validates `publicReadOnly` / `openTerminalInFeishu` are booleans.
 *   - Validates `repoPickerMode` is 'all' | 'repos'.
 *   - Validates `lang` is a valid locale or null.
 *   - Defers maintenance validation to `parseMaintenancePatch` (returns its error verbatim).
 *   - Forbids enabling `autoUpdate` on a local-dev install.
 *   - Forbids enabling `autoRestart` unless `autoUpdate` is (or is being) enabled.
 *   - Returns `empty_patch` when no fields changed.
 */
export async function applySettingsWrite(
  body: unknown,
  deps: SettingsWriteApplierDeps,
): Promise<ApplySettingsWriteResult> {
  const obj = body && typeof body === 'object' && !Array.isArray(body)
    ? body as Record<string, unknown>
    : {};

  const patch: DashboardGlobalConfig = {};
  if ('publicReadOnly' in obj) {
    if (typeof obj.publicReadOnly !== 'boolean') {
      return { ok: false, error: 'invalid_publicReadOnly' };
    }
    patch.publicReadOnly = obj.publicReadOnly;
  }
  if ('openTerminalInFeishu' in obj) {
    if (typeof obj.openTerminalInFeishu !== 'boolean') {
      return { ok: false, error: 'invalid_openTerminalInFeishu' };
    }
    patch.openTerminalInFeishu = obj.openTerminalInFeishu;
  }
  if ('chatBotDiscovery' in obj) {
    if (typeof obj.chatBotDiscovery !== 'boolean') {
      return { ok: false, error: 'invalid_chatBotDiscovery' };
    }
    patch.chatBotDiscovery = obj.chatBotDiscovery;
  }

  let touched = false;
  if (Object.keys(patch).length > 0) {
    deps.mergeDashboardConfig(patch);
    touched = true;
  }

  if ('repoPickerMode' in obj) {
    const v = obj.repoPickerMode;
    if (v !== 'all' && v !== 'repos') {
      return { ok: false, error: 'invalid_repoPickerMode' };
    }
    deps.mergeGlobalConfig({ repoPickerMode: v });
    touched = true;
  }

  if ('remoteAccess' in obj) {
    if (typeof obj.remoteAccess !== 'boolean') {
      return { ok: false, error: 'invalid_remoteAccess' };
    }
    deps.mergeGlobalConfig({ remoteAccess: obj.remoteAccess });
    touched = true;
  }

  if ('vcMeetingAgent' in obj) {
    const raw = obj.vcMeetingAgent;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return { ok: false, error: 'invalid_vcMeetingAgent' };
    }
    const vc = raw as Record<string, unknown>;
    const currentVcMeetingAgent = deps.readGlobalConfig().vcMeetingAgent ?? {};
    const next = { ...currentVcMeetingAgent };
    if ('enabled' in vc) {
      if (typeof vc.enabled !== 'boolean') {
        return { ok: false, error: 'invalid_vcMeetingAgent_enabled' };
      }
      next.enabled = vc.enabled;
    }
    if ('listenerBotAppId' in vc) {
      if (vc.listenerBotAppId === null || vc.listenerBotAppId === '') {
        if (deps.syncVcMeetingListenerBotConfig) {
          const synced = await deps.syncVcMeetingListenerBotConfig(null, currentVcMeetingAgent.listenerBotAppId ?? null);
          if (!synced.ok) return { ok: false, error: synced.error, feishuLoginQr: (synced as any).feishuLoginQr };
        }
        delete next.listenerBotAppId;
      } else if (typeof vc.listenerBotAppId === 'string' && vc.listenerBotAppId.trim()) {
        const listenerBotAppId = vc.listenerBotAppId.trim();
        if (deps.validateVcMeetingListenerBotAppId) {
          const validation = await deps.validateVcMeetingListenerBotAppId(listenerBotAppId);
          if (!validation.ok) return { ok: false, error: validation.error };
        }
        if (deps.syncVcMeetingListenerBotConfig) {
          const synced = await deps.syncVcMeetingListenerBotConfig(listenerBotAppId, currentVcMeetingAgent.listenerBotAppId ?? null);
          if (!synced.ok) return { ok: false, error: synced.error, feishuLoginQr: (synced as any).feishuLoginQr };
        }
        next.listenerBotAppId = listenerBotAppId;
      } else {
        return { ok: false, error: 'invalid_vcMeetingAgent_listenerBotAppId' };
      }
    }
    if (!('enabled' in vc) && !('listenerBotAppId' in vc)) {
      return { ok: false, error: 'invalid_vcMeetingAgent_enabled' };
    }
    deps.mergeGlobalConfig({ vcMeetingAgent: next });
    touched = true;
  }

  if ('scheduleTimeZone' in obj) {
    const v = obj.scheduleTimeZone;
    if (v === null || v === '') {
      // Clear the override → the scheduler falls back to the host local zone.
      deps.mergeGlobalConfig({ scheduleTimeZone: null });
      touched = true;
    } else if (typeof v === 'string' && isValidTimeZone(v.trim())) {
      deps.mergeGlobalConfig({ scheduleTimeZone: v.trim() });
      touched = true;
    } else {
      return { ok: false, error: 'invalid_scheduleTimeZone' };
    }
  }

  if ('whiteboard' in obj) {
    const raw = obj.whiteboard;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return { ok: false, error: 'invalid_whiteboard' };
    }
    const wb = raw as Record<string, unknown>;
    if (typeof wb.enabled !== 'boolean') {
      return { ok: false, error: 'invalid_whiteboard_enabled' };
    }
    deps.mergeGlobalConfig({ whiteboard: { enabled: wb.enabled } });
    touched = true;
  }

  if ('maintenance' in obj) {
    const r = deps.parseMaintenancePatch(obj.maintenance);
    if (!r.ok) return { ok: false, error: r.error };
    // Auto-update is npm-global only; refuse enabling it on a source checkout.
    if (r.patch.autoUpdate?.enabled && deps.isLocalDevInstall()) {
      return { ok: false, error: 'local_dev_no_autoupdate' };
    }
    // Auto-restart only applies an auto-update — it's meaningless without it.
    if (r.patch.autoRestart?.enabled) {
      const autoUpdateOn =
        r.patch.autoUpdate?.enabled
        ?? deps.readGlobalConfig().maintenance?.autoUpdate?.enabled
        ?? false;
      if (!autoUpdateOn) return { ok: false, error: 'autoupdate_required' };
    }
    deps.mergeMaintenanceConfig(r.patch);
    touched = true;
  }

  if ('lang' in obj) {
    const v = obj.lang;
    if (v !== null && !deps.isLocale(v)) {
      return { ok: false, error: 'invalid_lang' };
    }
    deps.setGlobalLocale(v === null ? null : v);
    if (deps.reloadLocaleOnAllDaemons) {
      await deps.reloadLocaleOnAllDaemons();
    }
    touched = true;
  }

  if (!touched) return { ok: false, error: 'empty_patch' };
  return { ok: true, settings: deps.resolveDashboardSettings() };
}
