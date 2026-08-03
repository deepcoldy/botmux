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
  normalizeGroupNamePrefix,
  mergeDashboardConfig,
  mergeGlobalConfig,
  mergeMaintenanceConfig,
  parseMaintenancePatch,
  readGlobalConfig,
  setGlobalLocale,
  writeCodexNotifierConfig,
  writeHostOverloadAlertConfig,
} from '../global-config.js';
import {
  installCodexNotifierHook,
  isCodexNotifierHookInstalled,
} from '../features/codex-notifier/index.js';
import { isLocale } from '../i18n/types.js';
import { isLocalDevInstall } from '../utils/install-info.js';
import { isAutoUpdateSupportedInstall } from '../utils/global-install.js';
import { isValidTimeZone } from '../utils/timezone.js';

/**
 * Snapshot returned by `resolveDashboardSettings` — mirrors the existing
 * `ResolvedDashboardSettings` interface in `dashboard.ts:69-80`. We redeclare
 * it locally rather than reaching across that boundary because the applier
 * doesn't know how the host computes the snapshot (it just calls a closure).
 */
export interface ResolvedDashboardSettingsView {
  groupNamePrefix: string;
  publicReadOnly: boolean;
  openTerminalInFeishu: boolean;
  enableLocalCliOpen: boolean;
  localCliOpenMode: 'attach' | 'resume';
  chatBotDiscovery: boolean;
  herdrTraexPlugin: { enabled: boolean; source: string; ref: string; recommendedSource: string; recommendedRef: string };
  codexRpcInput: boolean;
  bypassCodexHookTrust: boolean;
  codexNotifier: {
    enabled: boolean;
    targetBotAppId: string | null;
    notifyWhen: 'locked_only' | 'always';
    platformSupported: boolean;
    hookInstalled: boolean;
    botOptions?: Array<{
      larkAppId: string;
      botName: string | null;
      cliId: string;
      recipientConfigured: boolean;
      recipientVerified: boolean;
      recipientHint: string | null;
    }>;
    targetDaemonOnline?: boolean;
    pendingCount?: number;
    workerOnline?: boolean;
    lastError?: { at: string; message: string; retryAt: string } | null;
  };
  hostOverloadAlert: {
    enabled: boolean;
    targetBotAppId: string | null;
    enterLoadRatio: number;
    enterMemUsedFrac: number;
    /** Bots eligible as the overload notifier (any non-apiOnly bot with a
     *  resolvable admin recipient). Unlike codexNotifier this is NOT codex-only. */
    botOptions?: Array<{
      larkAppId: string;
      botName: string | null;
      cliId: string;
      apiOnly: boolean;
      recipientConfigured: boolean;
      recipientVerified: boolean;
      recipientHint: string | null;
    }>;
    /** Whether the selected target bot's daemon is currently online (else the
     *  alert can't be delivered — the UI surfaces this). */
    targetDaemonOnline?: boolean;
  };
  noVisibleOutputHint: boolean;
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
  autoUpdateSupported?: boolean;
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
  /** Atomic write of dashboard-level fields. */
  mergeDashboardConfig: (patch: DashboardGlobalConfig) => DashboardGlobalConfig;
  /** Atomic write of global-level fields (repoPickerMode / scheduleTimeZone / …).
   *  Mirrors the real `mergeGlobalConfig`: a `null` value deletes that key. */
  mergeGlobalConfig: (patch: Partial<Record<keyof GlobalConfig, GlobalConfig[keyof GlobalConfig] | null>>) => void;
  /** Replace known notifier fields while preserving future sibling keys on disk. */
  writeCodexNotifierConfig: (config: import('../global-config.js').CodexNotifierGlobalConfig) => void;
  /** Replace known host-overload-alert fields while preserving future sibling keys. */
  writeHostOverloadAlertConfig: (config: import('../global-config.js').HostOverloadAlertGlobalConfig) => void;
  /** Atomic write of maintenance-level fields (autoUpdate / autoRestart). */
  mergeMaintenanceConfig: (patch: MaintenanceConfig) => MaintenanceConfig;
  /** Set global UI locale (null = clear). Fans out to daemons via IPC. */
  setGlobalLocale: (locale: 'zh' | 'en' | null) => void;
  /** Type-strict body validator for the maintenance segment. */
  parseMaintenancePatch: (body: unknown) => ParseMaintenanceResult;
  /** True iff the current install is a source-checkout (auto-update unavailable). */
  isLocalDevInstall: () => boolean;
  /** True iff the current global install is owned by a supported updater. */
  isAutoUpdateSupportedInstall: () => boolean;
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
  /** 校验通知 Bot；保存关闭态配置时只校验静态配置，启用时再要求 daemon 与收件人就绪。 */
  validateCodexNotifierTargetBotAppId?: (
    appId: string,
    options?: { requireReady?: boolean },
  ) => Promise<{ ok: true } | { ok: false; error: string }>;
  /** 校验过载告警通知 Bot：拒 unknown / apiOnly / 无可解析管理员收件人；启用时
   *  额外要求目标 daemon 在线(否则告警发不出)。复用管理员解析但无 codex-only 约束。 */
  validateHostOverloadAlertTargetBotAppId?: (
    appId: string,
    options?: { requireReady?: boolean },
  ) => Promise<{ ok: true } | { ok: false; error: string }>;
  /** Reconcile the stable core Hook command before enabling notification. */
  installCodexNotifierHook?: () => void;
  /** locked_only currently depends on macOS IORegistry. */
  isCodexNotifierPlatformSupported?: () => boolean;
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
    writeCodexNotifierConfig,
    writeHostOverloadAlertConfig,
    mergeMaintenanceConfig,
    setGlobalLocale,
    parseMaintenancePatch,
    isLocalDevInstall,
    isAutoUpdateSupportedInstall,
    resolveDashboardSettings,
    isLocale,
    reloadLocaleOnAllDaemons,
    installCodexNotifierHook: () => {
      installCodexNotifierHook();
      if (!isCodexNotifierHookInstalled()) throw new Error('codex_notifier_hook_not_executable');
    },
    isCodexNotifierPlatformSupported: () => process.platform === 'darwin',
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
  | 'invalid_groupNamePrefix'
  | 'invalid_publicReadOnly'
  | 'invalid_openTerminalInFeishu'
  | 'invalid_enableLocalCliOpen'
  | 'invalid_localCliOpenMode'
  | 'invalid_chatBotDiscovery'
  | 'invalid_herdrTraexPlugin'
  | 'invalid_herdrTraexPlugin_enabled'
  | 'invalid_herdrTraexPlugin_source'
  | 'invalid_herdrTraexPlugin_ref'
  | 'invalid_codexRpcInput'
  | 'invalid_bypassCodexHookTrust'
  | 'invalid_codexNotifier'
  | 'invalid_codexNotifier_enabled'
  | 'invalid_codexNotifier_targetBotAppId'
  | 'invalid_codexNotifier_notifyWhen'
  | 'codexNotifier_target_required'
  | 'codexNotifier_target_unknown'
  | 'codexNotifier_target_owner_missing'
  | 'codexNotifier_platform_unsupported'
  | 'codexNotifier_hook_install_failed'
  | 'codexNotifier_mixed_patch_unsupported'
  | 'invalid_hostOverloadAlert'
  | 'invalid_hostOverloadAlert_enabled'
  | 'invalid_hostOverloadAlert_targetBotAppId'
  | 'invalid_hostOverloadAlert_enterLoadRatio'
  | 'invalid_hostOverloadAlert_enterMemUsedFrac'
  | 'hostOverloadAlert_target_required'
  | 'hostOverloadAlert_target_unknown'
  | 'hostOverloadAlert_target_apiOnly'
  | 'hostOverloadAlert_target_owner_missing'
  | 'hostOverloadAlert_target_offline'
  | 'invalid_noVisibleOutputHint'
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
  | 'unsupported_install_no_autoupdate'
  | 'autoupdate_required'
  | 'empty_patch'
  | string;          // catch-all: parseMaintenancePatch error strings

function isValidHerdrPluginSource(value: string): boolean {
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/.test(value);
}

function isValidHerdrPluginRef(value: string): boolean {
  return !value.startsWith('-') && !/[\s\0]/.test(value);
}

/** 与 daemon 实际私聊收件人选择保持一致：只要求存在首个可用 open_id。 */
export function hasResolvedCodexNotifierRecipient(resolvedAllowedUsers: readonly string[] | undefined): boolean {
  return resolvedAllowedUsers?.some(user => typeof user === 'string' && user.startsWith('ou_')) === true;
}

function maskCodexNotifierRecipient(value: string | undefined): string | null {
  const normalized = value?.trim();
  if (!normalized) return null;
  if (normalized.length <= 12) return `${normalized.slice(0, 2)}***`;
  return `${normalized.slice(0, 8)}…${normalized.slice(-4)}`;
}

/** 收件人提示只取 daemon 实际会私聊的首个 open_id，不能展示未解析的原始账号。 */
export function resolveCodexNotifierRecipientView(
  configuredAllowedUsers: readonly string[] | undefined,
  resolvedAllowedUsers: readonly string[] | undefined,
): {
  recipientConfigured: boolean;
  recipientVerified: boolean;
  recipientHint: string | null;
} {
  const configured = configuredAllowedUsers?.some(user =>
    typeof user === 'string' && !!user.trim()) === true;
  const resolved = resolvedAllowedUsers?.find(user =>
    typeof user === 'string' && user.startsWith('ou_'));
  return {
    recipientConfigured: configured,
    recipientVerified: !!resolved,
    recipientHint: maskCodexNotifierRecipient(resolved),
  };
}

/**
 * Apply a parsed (object) settings patch. Returns success with the post-merge
 * snapshot, or an error code string on validation failure.
 *
 * Behaviour mirrors `dashboard.ts:460-498` exactly:
 *   - Validates dashboard toggles are booleans.
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
  if (
    Object.hasOwn(obj, 'codexNotifier')
    && Object.keys(obj).some(key => key !== 'codexNotifier')
  ) {
    return { ok: false, error: 'codexNotifier_mixed_patch_unsupported' };
  }

  let groupNamePrefixPatch: string | null | undefined;
  if ('groupNamePrefix' in obj) {
    if (typeof obj.groupNamePrefix !== 'string') {
      return { ok: false, error: 'invalid_groupNamePrefix' };
    }
    const rawPrefix = obj.groupNamePrefix;
    const groupNamePrefix = normalizeGroupNamePrefix(rawPrefix);
    if (rawPrefix !== '' && !groupNamePrefix) {
      return { ok: false, error: 'invalid_groupNamePrefix' };
    }
    groupNamePrefixPatch = groupNamePrefix ?? null;
  }

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
  if ('enableLocalCliOpen' in obj) {
    if (typeof obj.enableLocalCliOpen !== 'boolean') {
      return { ok: false, error: 'invalid_enableLocalCliOpen' };
    }
    patch.enableLocalCliOpen = obj.enableLocalCliOpen;
  }
  if ('localCliOpenMode' in obj) {
    if (obj.localCliOpenMode !== 'attach' && obj.localCliOpenMode !== 'resume') {
      return { ok: false, error: 'invalid_localCliOpenMode' };
    }
    patch.localCliOpenMode = obj.localCliOpenMode;
  }
  if ('chatBotDiscovery' in obj) {
    if (typeof obj.chatBotDiscovery !== 'boolean') {
      return { ok: false, error: 'invalid_chatBotDiscovery' };
    }
    patch.chatBotDiscovery = obj.chatBotDiscovery;
  }
  if ('herdrTraexPlugin' in obj) {
    const raw = obj.herdrTraexPlugin;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return { ok: false, error: 'invalid_herdrTraexPlugin' };
    }
    const h = raw as Record<string, unknown>;
    const current = deps.readGlobalConfig().dashboard?.herdrTraexPlugin ?? {};
    const next = { ...current };
    if ('enabled' in h) {
      if (typeof h.enabled !== 'boolean') return { ok: false, error: 'invalid_herdrTraexPlugin_enabled' };
      next.enabled = h.enabled;
    }
    if ('source' in h) {
      if (typeof h.source !== 'string') return { ok: false, error: 'invalid_herdrTraexPlugin_source' };
      const source = h.source.trim();
      if (source && !isValidHerdrPluginSource(source)) return { ok: false, error: 'invalid_herdrTraexPlugin_source' };
      if (source) next.source = source;
      else delete next.source;
    }
    if ('ref' in h) {
      if (typeof h.ref !== 'string') return { ok: false, error: 'invalid_herdrTraexPlugin_ref' };
      const ref = h.ref.trim();
      if (ref && !isValidHerdrPluginRef(ref)) return { ok: false, error: 'invalid_herdrTraexPlugin_ref' };
      if (ref) next.ref = ref;
      else delete next.ref;
    }
    patch.herdrTraexPlugin = next;
  }
  if ('codexRpcInput' in obj) {
    if (typeof obj.codexRpcInput !== 'boolean') {
      return { ok: false, error: 'invalid_codexRpcInput' };
    }
    patch.codexRpcInput = obj.codexRpcInput;
  }
  if ('bypassCodexHookTrust' in obj) {
    if (typeof obj.bypassCodexHookTrust !== 'boolean') {
      return { ok: false, error: 'invalid_bypassCodexHookTrust' };
    }
    patch.bypassCodexHookTrust = obj.bypassCodexHookTrust;
  }
  if ('noVisibleOutputHint' in obj) {
    if (typeof obj.noVisibleOutputHint !== 'boolean') {
      return { ok: false, error: 'invalid_noVisibleOutputHint' };
    }
    patch.noVisibleOutputHint = obj.noVisibleOutputHint;
  }

  let codexNotifierPatch: import('../global-config.js').CodexNotifierGlobalConfig | undefined;
  if ('codexNotifier' in obj) {
    const raw = obj.codexNotifier;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return { ok: false, error: 'invalid_codexNotifier' };
    }
    const incoming = raw as Record<string, unknown>;
    const next = { ...(deps.readGlobalConfig().codexNotifier ?? {}) };
    if ('enabled' in incoming) {
      if (typeof incoming.enabled !== 'boolean') {
        return { ok: false, error: 'invalid_codexNotifier_enabled' };
      }
      next.enabled = incoming.enabled;
    }
    if ('targetBotAppId' in incoming) {
      if (incoming.targetBotAppId === null || incoming.targetBotAppId === '') {
        delete next.targetBotAppId;
      } else if (typeof incoming.targetBotAppId === 'string' && incoming.targetBotAppId.trim()) {
        next.targetBotAppId = incoming.targetBotAppId.trim();
      } else {
        return { ok: false, error: 'invalid_codexNotifier_targetBotAppId' };
      }
    }
    if ('notifyWhen' in incoming) {
      if (incoming.notifyWhen !== 'locked_only' && incoming.notifyWhen !== 'always') {
        return { ok: false, error: 'invalid_codexNotifier_notifyWhen' };
      }
      next.notifyWhen = incoming.notifyWhen;
    }
    if (!('enabled' in incoming) && !('targetBotAppId' in incoming) && !('notifyWhen' in incoming)) {
      return { ok: false, error: 'invalid_codexNotifier' };
    }
    const shouldValidateCodexNotifierTarget = 'targetBotAppId' in incoming
      || ('enabled' in incoming && incoming.enabled === true);
    if (next.targetBotAppId && shouldValidateCodexNotifierTarget && deps.validateCodexNotifierTargetBotAppId) {
      const validation = await deps.validateCodexNotifierTargetBotAppId(next.targetBotAppId, {
        requireReady: next.enabled === true,
      });
      if (!validation.ok) return { ok: false, error: validation.error || 'codexNotifier_target_unknown' };
    }
    if (next.enabled === true) {
      if (!next.targetBotAppId) return { ok: false, error: 'codexNotifier_target_required' };
      const notifyWhen = next.notifyWhen === 'always' ? 'always' : 'locked_only';
      if (notifyWhen === 'locked_only' && deps.isCodexNotifierPlatformSupported?.() === false) {
        return { ok: false, error: 'codexNotifier_platform_unsupported' };
      }
    }
    codexNotifierPatch = next;
  }

  let hostOverloadAlertPatch: import('../global-config.js').HostOverloadAlertGlobalConfig | undefined;
  if ('hostOverloadAlert' in obj) {
    const raw = obj.hostOverloadAlert;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return { ok: false, error: 'invalid_hostOverloadAlert' };
    }
    const incoming = raw as Record<string, unknown>;
    const next = { ...(deps.readGlobalConfig().hostOverloadAlert ?? {}) };
    if ('enabled' in incoming) {
      if (typeof incoming.enabled !== 'boolean') {
        return { ok: false, error: 'invalid_hostOverloadAlert_enabled' };
      }
      next.enabled = incoming.enabled;
    }
    if ('targetBotAppId' in incoming) {
      if (incoming.targetBotAppId === null || incoming.targetBotAppId === '') {
        delete next.targetBotAppId;
      } else if (typeof incoming.targetBotAppId === 'string' && incoming.targetBotAppId.trim()) {
        next.targetBotAppId = incoming.targetBotAppId.trim();
      } else {
        return { ok: false, error: 'invalid_hostOverloadAlert_targetBotAppId' };
      }
    }
    if ('enterLoadRatio' in incoming) {
      if (incoming.enterLoadRatio === null || incoming.enterLoadRatio === undefined) {
        delete next.enterLoadRatio;
      } else if (typeof incoming.enterLoadRatio === 'number' && Number.isFinite(incoming.enterLoadRatio) && incoming.enterLoadRatio > 0) {
        next.enterLoadRatio = incoming.enterLoadRatio;
      } else {
        return { ok: false, error: 'invalid_hostOverloadAlert_enterLoadRatio' };
      }
    }
    if ('enterMemUsedFrac' in incoming) {
      if (incoming.enterMemUsedFrac === null || incoming.enterMemUsedFrac === undefined) {
        delete next.enterMemUsedFrac;
      } else if (
        typeof incoming.enterMemUsedFrac === 'number'
        && Number.isFinite(incoming.enterMemUsedFrac)
        && incoming.enterMemUsedFrac > 0
        && incoming.enterMemUsedFrac <= 1
      ) {
        next.enterMemUsedFrac = incoming.enterMemUsedFrac;
      } else {
        return { ok: false, error: 'invalid_hostOverloadAlert_enterMemUsedFrac' };
      }
    }
    if (!('enabled' in incoming) && !('targetBotAppId' in incoming)
      && !('enterLoadRatio' in incoming) && !('enterMemUsedFrac' in incoming)) {
      return { ok: false, error: 'invalid_hostOverloadAlert' };
    }
    // Validate the target when it's being set OR when enabling. On enable the
    // target daemon must be online (requireReady) or the alert can't be sent.
    const shouldValidateTarget = 'targetBotAppId' in incoming
      || ('enabled' in incoming && incoming.enabled === true);
    if (next.targetBotAppId && shouldValidateTarget && deps.validateHostOverloadAlertTargetBotAppId) {
      const validation = await deps.validateHostOverloadAlertTargetBotAppId(next.targetBotAppId, {
        requireReady: next.enabled === true,
      });
      if (!validation.ok) return { ok: false, error: (validation.error as ApplySettingsWriteError) || 'hostOverloadAlert_target_unknown' };
    }
    if (next.enabled === true && !next.targetBotAppId) {
      return { ok: false, error: 'hostOverloadAlert_target_required' };
    }
    hostOverloadAlertPatch = next;
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
    // Auto-update is global-package only; refuse enabling it on a source checkout.
    if (r.patch.autoUpdate?.enabled && deps.isLocalDevInstall()) {
      return { ok: false, error: 'local_dev_no_autoupdate' };
    }
    if (r.patch.autoUpdate?.enabled && !deps.isAutoUpdateSupportedInstall()) {
      return { ok: false, error: 'unsupported_install_no_autoupdate' };
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

  // 群名前缀等整份请求校验通过后再落盘，避免同一 PUT 的后续字段非法时
  // 返回失败却已经改变了 `/group` 的建群命名。
  if (groupNamePrefixPatch !== undefined) {
    deps.mergeGlobalConfig({ groupNamePrefix: groupNamePrefixPatch });
    touched = true;
  }

  // Hook 是 notifier 唯一的外部副作用；等整份请求完成校验后再安装和持久化，
  // 避免同一 PUT 的其他字段无效时返回失败却已经开启通知。
  if (codexNotifierPatch) {
    if (codexNotifierPatch.enabled === true) {
      try {
        deps.installCodexNotifierHook?.();
      } catch {
        return { ok: false, error: 'codexNotifier_hook_install_failed' };
      }
    }
    deps.writeCodexNotifierConfig(codexNotifierPatch);
    touched = true;
  }

  if (hostOverloadAlertPatch) {
    deps.writeHostOverloadAlertConfig(hostOverloadAlertPatch);
    touched = true;
  }

  if (!touched) return { ok: false, error: 'empty_patch' };
  return { ok: true, settings: deps.resolveDashboardSettings() };
}
