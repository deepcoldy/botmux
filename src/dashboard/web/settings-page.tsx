import type React from 'react';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { DropdownMenu, FieldTitle, LoadingState, dropdownLabel } from './dashboard-components.js';
import { VcConsumerProfilesGate } from './vc-consumer-profiles-section.js';
import { useT } from './react-hooks.js';
import { mountReactPage, type PageDisposer } from './react-mount.js';
import { store } from './store.js';
import { updateResponseNeedsRestart } from './update-action.js';
import { ui } from './ui.js';
import { confirm } from './confirm-modal.js';
import { toast } from './toast.js';

interface MaintenanceTaskCfg { enabled?: boolean; time?: string }
interface MaintenanceCfg { autoUpdate?: MaintenanceTaskCfg; autoRestart?: MaintenanceTaskCfg }

interface DashboardSettings {
  groupNamePrefix: string;
  publicReadOnly: boolean;
  openTerminalInFeishu: boolean;
  enableLocalCliOpen: boolean;
  localCliOpenMode: 'attach' | 'resume';
  chatBotDiscovery: boolean;
  herdrTraexPlugin: {
    enabled: boolean;
    source: string;
    ref: string;
    recommendedSource: string;
    recommendedRef: string;
  };
  codexRpcInput: boolean;
  bypassCodexHookTrust: boolean;
  codexNotifier: {
    enabled: boolean;
    targetBotAppId: string | null;
    notifyWhen: 'locked_only' | 'always';
    platformSupported: boolean;
    hookInstalled: boolean;
    botOptions: Array<{
      larkAppId: string;
      botName: string | null;
      cliId: string;
      recipientConfigured: boolean;
      recipientVerified: boolean;
      recipientHint: string | null;
    }>;
    targetDaemonOnline: boolean;
    pendingCount: number;
    workerOnline: boolean;
    lastError: { at: string; message: string; retryAt: string } | null;
  };
  hostOverloadAlert: {
    enabled: boolean;
    targetBotAppId: string | null;
    enterLoadRatio: number;
    enterMemUsedFrac: number;
    botOptions: Array<{
      larkAppId: string;
      botName: string | null;
      cliId: string;
      apiOnly: boolean;
      recipientConfigured: boolean;
      recipientVerified: boolean;
      recipientHint: string | null;
    }>;
    targetDaemonOnline: boolean;
  };
  noVisibleOutputHint: boolean;
  vcMeetingAgent: {
    enabled: boolean;
    larkCliVersion?: string | null;
    larkCliMeetsRequirement?: boolean;
    larkCliMinVersion?: string;
  };
  repoPickerMode: 'all' | 'repos';
  maintenance: MaintenanceCfg;
  localDevInstall: boolean;
  autoUpdateSupported: boolean;
  whiteboard: { enabled: boolean };
  workflow: { enabled: boolean };
  remoteAccess: boolean;
  /** OAuth 回跳基址；'' = 未配置（退回 127.0.0.1 粘贴流程）。 */
  oauthRedirectBase: string;
  scheduleTimeZone: string;
  hostTimeZone: string;
  effectiveScheduleTimeZone: string;
}

const COMMON_TIMEZONES = [
  'Asia/Shanghai', 'Asia/Hong_Kong', 'Asia/Tokyo', 'Asia/Singapore', 'Asia/Kolkata',
  'UTC', 'Europe/London', 'Europe/Paris', 'Europe/Moscow',
  'America/Los_Angeles', 'America/New_York', 'America/Sao_Paulo', 'Australia/Sydney',
];

type InstallKind = 'npm-global' | 'pnpm-global' | 'yarn-global' | 'bun-global' | 'source-checkout' | 'unknown';
interface InstallEntry { binPath: string; root: string; kind: InstallKind }
interface NodeCheck { version: string; major: number; required: number; ok: boolean }
interface CliRuntimeUpdateStatus {
  cliId: 'codex';
  runtimeId: string;
  displayName: string;
  binPath: string;
  provider: 'internal' | 'auto' | 'self' | 'npm';
  managed: boolean;
  current: string | null;
  latest: string | null;
  updateAvailable: boolean;
  updateCommand: string | null;
  installTarget?: string;
  lastCheckedAt: number;
}
interface UpdateStatus {
  current: string;
  latest: string | null;
  behind: boolean;
  cliBehind: boolean;
  cliUpdates: CliRuntimeUpdateStatus[];
  localDevInstall: boolean;
  /** Local-dev checkout is a git worktree → self-update via git pull + build. */
  localDevUpdatable?: boolean;
  updateSupported: boolean;
  updateManager: 'npm' | 'pnpm' | 'yarn' | 'bun' | 'unknown';
  updateCommand: string | null;
  node: NodeCheck;
  installs: { entries: InstallEntry[]; multiple: boolean };
}
interface ReleaseNote { version: string; name: string; body: string; url: string; publishedAt: string | null }

type StatusMessage = { text: string; cls?: string } | null;

interface AutostartState {
  supported: boolean;
  enabled: boolean;
}

function parseAutostartState(value: unknown): AutostartState | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const state = value as Record<string, unknown>;
  return typeof state.supported === 'boolean' && typeof state.enabled === 'boolean'
    ? { supported: state.supported, enabled: state.enabled }
    : null;
}

/** Map a `herdrTraexInstall` result (returned by PUT /api/settings when the
 *  write triggered a live TraeX plugin install) to a settings status message. */
function traexInstallMessage(install: any, tr: (k: string) => string): StatusMessage {
  if (!install || typeof install !== 'object') return null;
  if (install.failed) {
    const step = install.failed.step === 'install'
      ? tr('settings.herdrTraexInstallStepInstall')
      : tr('settings.herdrTraexInstallStepAction');
    return { text: `${tr('settings.herdrTraexInstallFailed')}（${step}）: ${install.failed.reason ?? ''}`, cls: 'hint-warn-inline' };
  }
  if (install.skippedReason === 'plugin_unsupported') {
    const version = typeof install.herdrVersion === 'string' && install.herdrVersion ? ` (${install.herdrVersion})` : '';
    return { text: `${tr('settings.herdrTraexUnsupported')}${version}`, cls: 'hint-warn-inline' };
  }
  if (install.installed || install.actionInvoked) return { text: tr('settings.herdrTraexInstalled'), cls: 'hint-ok' };
  if (install.alreadyInstalled) return { text: tr('settings.herdrTraexAlreadyInstalled'), cls: 'hint-ok' };
  return null;
}

function parseSettings(s: any): DashboardSettings {
  return {
    groupNamePrefix: typeof s?.groupNamePrefix === 'string' ? s.groupNamePrefix : '',
    publicReadOnly: s?.publicReadOnly === true,
    openTerminalInFeishu: s?.openTerminalInFeishu === true,
    enableLocalCliOpen: s?.enableLocalCliOpen === true,
    localCliOpenMode: s?.localCliOpenMode === 'resume' ? 'resume' : 'attach',
    chatBotDiscovery: s?.chatBotDiscovery !== false,
    herdrTraexPlugin: {
      enabled: s?.herdrTraexPlugin?.enabled === true,
      source: typeof s?.herdrTraexPlugin?.source === 'string' ? s.herdrTraexPlugin.source : '',
      ref: typeof s?.herdrTraexPlugin?.ref === 'string' ? s.herdrTraexPlugin.ref : '',
      recommendedSource: typeof s?.herdrTraexPlugin?.recommendedSource === 'string' ? s.herdrTraexPlugin.recommendedSource : '',
      recommendedRef: typeof s?.herdrTraexPlugin?.recommendedRef === 'string' ? s.herdrTraexPlugin.recommendedRef : '',
    },
    codexRpcInput: s?.codexRpcInput === true,
    // default ON — only an explicit persisted false disables (matches server snapshot)
    bypassCodexHookTrust: s?.bypassCodexHookTrust !== false,
    codexNotifier: {
      enabled: s?.codexNotifier?.enabled === true,
      targetBotAppId: typeof s?.codexNotifier?.targetBotAppId === 'string'
        ? s.codexNotifier.targetBotAppId
        : null,
      notifyWhen: s?.codexNotifier?.notifyWhen === 'always' ? 'always' : 'locked_only',
      platformSupported: s?.codexNotifier?.platformSupported === true,
      hookInstalled: s?.codexNotifier?.hookInstalled === true,
      botOptions: Array.isArray(s?.codexNotifier?.botOptions) ? s.codexNotifier.botOptions : [],
      targetDaemonOnline: s?.codexNotifier?.targetDaemonOnline === true,
      pendingCount: Number.isSafeInteger(s?.codexNotifier?.pendingCount)
        ? Math.max(0, s.codexNotifier.pendingCount)
        : 0,
      workerOnline: s?.codexNotifier?.workerOnline === true,
      lastError: s?.codexNotifier?.lastError
        && typeof s.codexNotifier.lastError.message === 'string'
        ? s.codexNotifier.lastError
        : null,
    },
    hostOverloadAlert: {
      enabled: s?.hostOverloadAlert?.enabled === true,
      targetBotAppId: typeof s?.hostOverloadAlert?.targetBotAppId === 'string'
        ? s.hostOverloadAlert.targetBotAppId
        : null,
      enterLoadRatio: typeof s?.hostOverloadAlert?.enterLoadRatio === 'number'
        ? s.hostOverloadAlert.enterLoadRatio
        : 1.5,
      enterMemUsedFrac: typeof s?.hostOverloadAlert?.enterMemUsedFrac === 'number'
        ? s.hostOverloadAlert.enterMemUsedFrac
        : 0.92,
      botOptions: Array.isArray(s?.hostOverloadAlert?.botOptions) ? s.hostOverloadAlert.botOptions : [],
      targetDaemonOnline: s?.hostOverloadAlert?.targetDaemonOnline === true,
    },
    noVisibleOutputHint: s?.noVisibleOutputHint === true,
    vcMeetingAgent: {
      enabled: s?.vcMeetingAgent?.enabled !== false,
      larkCliVersion: s?.vcMeetingAgent?.larkCliVersion === undefined ? undefined : (s.vcMeetingAgent.larkCliVersion ?? null),
      larkCliMeetsRequirement: s?.vcMeetingAgent?.larkCliMeetsRequirement === true,
      larkCliMinVersion: typeof s?.vcMeetingAgent?.larkCliMinVersion === 'string' ? s.vcMeetingAgent.larkCliMinVersion : undefined,
    },
    repoPickerMode: s?.repoPickerMode === 'repos' ? 'repos' : 'all',
    maintenance: (s?.maintenance && typeof s.maintenance === 'object') ? s.maintenance : {},
    localDevInstall: s?.localDevInstall === true,
    autoUpdateSupported: s?.autoUpdateSupported !== false,
    whiteboard: { enabled: s?.whiteboard?.enabled === true },
    workflow: { enabled: s?.workflow?.enabled !== false },
    remoteAccess: s?.remoteAccess === true,
    oauthRedirectBase: typeof s?.oauthRedirectBase === 'string' ? s.oauthRedirectBase : '',
    scheduleTimeZone: typeof s?.scheduleTimeZone === 'string' ? s.scheduleTimeZone : '',
    hostTimeZone: typeof s?.hostTimeZone === 'string' && s.hostTimeZone ? s.hostTimeZone : 'UTC',
    effectiveScheduleTimeZone:
      typeof s?.effectiveScheduleTimeZone === 'string' && s.effectiveScheduleTimeZone
        ? s.effectiveScheduleTimeZone
        : (typeof s?.scheduleTimeZone === 'string' && s.scheduleTimeZone
            ? s.scheduleTimeZone
            : (typeof s?.hostTimeZone === 'string' && s.hostTimeZone ? s.hostTimeZone : 'UTC')),
  };
}

function taskUi(m: MaintenanceCfg, key: 'autoUpdate' | 'autoRestart'): { enabled: boolean; time: string } {
  const task = m?.[key] ?? {};
  return { enabled: task.enabled === true, time: typeof task.time === 'string' ? task.time : '04:00' };
}

function installKindLabel(kind: string, tr: ReturnType<typeof useT>): string {
  if (kind === 'npm-global') return tr('update.kindNpm');
  if (kind === 'pnpm-global') return tr('update.kindPnpm');
  if (kind === 'yarn-global') return tr('update.kindYarn');
  if (kind === 'bun-global') return tr('update.kindBun');
  if (kind === 'source-checkout') return tr('update.kindSource');
  return tr('update.kindUnknown');
}

function SettingsPage() {
  const tr = useT();
  const mountedRef = useRef(false);
  const timersRef = useRef<Set<number>>(new Set());
  const [settings, setSettings] = useState<DashboardSettings | null>(null);
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [canWrite, setCanWrite] = useState(true);
  const [bound, setBound] = useState(false);
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [settingsMsg, setSettingsMsg] = useState<StatusMessage>(null);
  const [feishuLoginQr, setFeishuLoginQr] = useState<string | null>(null);

  const [upStatus, setUpStatus] = useState<UpdateStatus | null>(null);
  const [upStatusError, setUpStatusError] = useState<string | null>(null);
  const [upChangelog, setUpChangelog] = useState<ReleaseNote[] | null>(null);
  const [upChangelogOpen, setUpChangelogOpen] = useState(false);
  const [upChangelogOk, setUpChangelogOk] = useState(true);
  const [upChangelogRateLimited, setUpChangelogRateLimited] = useState(false);
  const [upReleasesUrl, setUpReleasesUrl] = useState('');
  const [upBusy, setUpBusy] = useState(false);
  const [upMsg, setUpMsg] = useState<StatusMessage>(null);

  const [autostartState, setAutostartState] = useState<AutostartState | null>(null);
  const [autostartLoading, setAutostartLoading] = useState(false);
  const [autostartError, setAutostartError] = useState(false);
  const [autostartBusy, setAutostartBusy] = useState(false);
  const [autostartMsg, setAutostartMsg] = useState<StatusMessage>(null);

  const clearTimers = useCallback(() => {
    for (const id of timersRef.current) window.clearTimeout(id);
    timersRef.current.clear();
  }, []);

  const setTimer = useCallback((fn: () => void, ms: number): number => {
    const id = window.setTimeout(() => {
      timersRef.current.delete(id);
      fn();
    }, ms);
    timersRef.current.add(id);
    return id;
  }, []);

  const fetchStatus = useCallback(async () => {
    try {
      const r = await fetch('/api/update/status');
      const body = await r.json().catch(() => ({}));
      if (!mountedRef.current) return;
      if (!r.ok) {
        setUpStatus(null);
        setUpStatusError(body?.error ?? `HTTP ${r.status}`);
        return;
      }
      setUpStatus(body as UpdateStatus);
      setUpStatusError(null);
    } catch (e) {
      if (!mountedRef.current) return;
      setUpStatus(null);
      setUpStatusError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const fetchAutostart = useCallback(async () => {
    setAutostartLoading(true);
    try {
      const response = await fetch('/api/autostart', { cache: 'no-store' });
      const body = await response.json().catch(() => ({}));
      const state = response.ok ? parseAutostartState(body.state) : null;
      if (!state) throw new Error('invalid_state');
      if (!mountedRef.current) return;
      setAutostartState(state);
      setAutostartError(false);
    } catch {
      if (!mountedRef.current) return;
      setAutostartError(true);
    } finally {
      if (mountedRef.current) setAutostartLoading(false);
    }
  }, []);

  const loadSettings = useCallback(async () => {
    try {
      const r = await fetch('/api/settings');
      const body = await r.json().catch(() => ({}));
      if (!mountedRef.current) return;
      if (!r.ok) {
        setSettings(null);
        setLoadError(body?.error ?? `HTTP ${r.status}`);
        setSettingsLoaded(true);
        return;
      }
      setSettings(parseSettings(body.settings));
      setCanWrite(body.authed === true);
      setBound(body.bound === true);
      setLoadError(null);
      setSettingsLoaded(true);
    } catch (e) {
      if (!mountedRef.current) return;
      setSettings(null);
      setLoadError(e instanceof Error ? e.message : String(e));
      setSettingsLoaded(true);
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    void loadSettings();
    return () => {
      mountedRef.current = false;
      clearTimers();
    };
  }, [clearTimers, loadSettings]);

  useEffect(() => {
    if (!settingsLoaded) return;
    setUpBusy(false);
    setUpMsg(null);
    setUpChangelogOpen(false);
    setAutostartMsg(null);
    if (canWrite) {
      void fetchStatus();
      void fetchAutostart();
    }
  }, [canWrite, fetchAutostart, fetchStatus, settingsLoaded]);

  async function setAutostartEnabled(enabled: boolean): Promise<void> {
    if (!autostartState || autostartBusy) return;
    const before = autostartState;
    setAutostartBusy(true);
    setAutostartState({ ...before, enabled });
    setAutostartMsg({ text: tr('settings.autostartSaving') });
    try {
      const response = await fetch('/api/autostart', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled }),
      });
      const body = await response.json().catch(() => ({}));
      const state = response.ok ? parseAutostartState(body.state) : null;
      if (!state) throw new Error('save_failed');
      if (!mountedRef.current) return;
      setAutostartState(state);
      setAutostartMsg({ text: tr('settings.autostartSaved'), cls: 'hint-ok' });
    } catch {
      if (!mountedRef.current) return;
      setAutostartState(before);
      setAutostartMsg({ text: tr('settings.autostartSaveFailed'), cls: 'hint-warn-inline' });
      void fetchAutostart();
    } finally {
      if (mountedRef.current) setAutostartBusy(false);
    }
  }

  async function saveSettings(
    key: string,
    payload: unknown,
    optimistic: (settings: DashboardSettings) => DashboardSettings,
  ): Promise<void> {
    if (!settings) return;
    const before = settings;
    setSettings(optimistic(settings));
    setSavingKey(key);
    setSettingsMsg({ text: tr('settings.saving') });
    try {
      const r = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const body = await r.json().catch(() => ({}));
      if (!mountedRef.current) return;
      if (!r.ok || body.ok === false) {
        if (typeof body?.feishuLoginQr === 'string' && body.feishuLoginQr) setFeishuLoginQr(body.feishuLoginQr);
        throw new Error(body?.error ?? `HTTP ${r.status}`);
      }
      setFeishuLoginQr(null);
      const saved = parseSettings(body.settings);
      setSettings(saved);
      ui.publicReadOnly = saved.publicReadOnly;
      store.setScheduleTimeZone(saved.effectiveScheduleTimeZone);
      // If this write triggered a live TraeX plugin install, surface its result
      // instead of the generic "saved" toast.
      const traexMsg = traexInstallMessage(body.herdrTraexInstall, tr);
      setSettingsMsg(traexMsg ?? { text: tr('settings.saved'), cls: 'hint-ok' });
      // 成功轻反馈 1.5s 后淡出；错误/安装结果不自动清
      if (!traexMsg) {
        setTimer(() => { if (mountedRef.current) setSettingsMsg(null); }, 1500);
      }
    } catch (e) {
      if (!mountedRef.current) return;
      // The PUT may have committed before a proxy/browser timeout dropped its
      // response (TraeX installation can legitimately take minutes). Re-read
      // the server before deciding whether to roll back the optimistic state.
      let reconciled = false;
      try {
        const confirmedResponse = await fetch('/api/settings');
        const confirmedBody = await confirmedResponse.json().catch(() => ({}));
        if (mountedRef.current && confirmedResponse.ok && confirmedBody?.settings) {
          const confirmed = parseSettings(confirmedBody.settings);
          setSettings(confirmed);
          ui.publicReadOnly = confirmed.publicReadOnly;
          store.setScheduleTimeZone(confirmed.effectiveScheduleTimeZone);
          reconciled = true;
        }
      } catch { /* still offline: fall back to the pre-save snapshot */ }
      if (!mountedRef.current) return;
      if (!reconciled) setSettings(before);
      const detail = e instanceof Error ? e.message : String(e);
      setSettingsMsg({
        text: reconciled
          ? `${tr('settings.saveReconciled')}: ${detail}`
          : `${tr('settings.saveFailed')}: ${detail}`,
        cls: 'hint-warn-inline',
      });
    } finally {
      if (mountedRef.current) setSavingKey(null);
    }
  }

  async function loadChangelog(): Promise<void> {
    setUpChangelog(null);
    setUpChangelogOk(true);
    setUpChangelogRateLimited(false);
    try {
      const r = await fetch('/api/update/changelog');
      const body = await r.json().catch(() => ({}));
      if (!mountedRef.current) return;
      setUpReleasesUrl(typeof body?.releasesUrl === 'string' ? body.releasesUrl : '');
      if (!r.ok) {
        setUpChangelog([]);
        setUpChangelogOk(false);
      } else {
        setUpChangelog(Array.isArray(body.releases) ? body.releases : []);
        setUpChangelogOk(body.ok !== false);
        setUpChangelogRateLimited(body.rateLimited === true);
      }
    } catch {
      if (!mountedRef.current) return;
      setUpChangelog([]);
      setUpChangelogOk(false);
    }
  }

  function pollReconnect(): void {
    const start = Date.now();
    const tick = async (): Promise<void> => {
      if (!mountedRef.current) return;
      if (Date.now() - start > 90_000) {
        setUpBusy(false);
        setUpMsg({ text: tr('update.restartSlow'), cls: 'hint-warn-inline' });
        return;
      }
      try {
        const r = await fetch('/__health', { cache: 'no-store' });
        if (!mountedRef.current) return;
        if (r.ok) {
          location.reload();
          return;
        }
      } catch { /* still down; keep polling */ }
      if (mountedRef.current) setTimer(() => void tick(), 2000);
    };
    setTimer(() => void tick(), 3000);
  }

  async function doRestart(updatePayload: { oldVersion: string; newVersion: string } | null): Promise<void> {
    setUpBusy(true);
    setUpMsg({ text: tr('update.restarting') });
    try {
      const response = await fetch('/api/update/restart', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(updatePayload ? { update: updatePayload } : {}),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || body.ok === false) {
        // Local-dev drift/absence between run and restart: the built checkout is
        // gone or moved (e.g. a concurrent `use:here`). Surface an actionable
        // message and re-read status rather than a raw error code.
        if (body.error === 'update_target_unavailable' || body.error === 'update_target_drifted') {
          if (!mountedRef.current) return;
          setUpBusy(false);
          setUpMsg({ text: tr(`update.${body.error}`, { dir: String(body.dir ?? '') }), cls: 'hint-warn-inline' });
          void fetchStatus();
          return;
        }
        throw new Error(String(body.detail ?? body.error ?? `HTTP ${response.status}`));
      }
      if (!mountedRef.current) return;
    } catch (e) {
      if (!mountedRef.current) return;
      setUpBusy(false);
      setUpMsg({ text: tr('update.restartFailed', { detail: e instanceof Error ? e.message : String(e) }), cls: 'hint-warn-inline' });
      return;
    }
    pollReconnect();
  }

  async function doUpdate(): Promise<void> {
    const s = upStatus;
    if (!s) return;
    if (!s.node.ok) {
      toast(tr('update.nodeTooOldAlert', { version: s.node.version, required: s.node.required }), { kind: 'warning' });
      return;
    }
    const localDev = s.localDevInstall === true;
    if (localDev) {
      if (!s.localDevUpdatable) { toast(tr('update.localDev'), { kind: 'warning' }); return; }
    } else if (!s.updateSupported || !s.updateCommand) {
      toast(tr('update.unsupportedInstall'), { kind: 'warning' });
      return;
    }
    if (s.installs.multiple) {
      const paths = s.installs.entries.map(e => `• ${e.binPath} (${installKindLabel(e.kind, tr)})`).join('\n');
      if (!await confirm({ title: tr('update.confirmMultiInstallTitle'), message: tr('update.confirmMultiInstall', { paths }), confirmLabel: tr('update.btnContinue'), cancelLabel: tr('update.btnCancel') })) return;
    }
    const confirmMsg = localDev
      ? tr('update.confirmUpdateLocalDev')
      : s.latest
        ? tr('update.confirmUpdate', { version: `v${s.latest}`, command: s.updateCommand! })
        : tr('update.confirmUpdateNoVer', { command: s.updateCommand! });
    if (!await confirm({ title: tr('update.confirmUpdateTitle'), message: confirmMsg, confirmLabel: tr('update.btnRunUpdate'), cancelLabel: tr('update.btnCancel') })) return;
    setUpBusy(true);
    setUpMsg({ text: localDev ? tr('update.updatingLocalDev') : tr('update.updating', { command: s.updateCommand! }) });
    try {
      const r = await fetch('/api/update/run', { method: 'POST' });
      const body = await r.json().catch(() => ({}));
      if (!mountedRef.current) return;
      if (!r.ok || body.ok === false) {
        // Dirty worktree fails closed — surface the file list so the user can act.
        if (body?.error === 'dirty_worktree') {
          setUpBusy(false);
          setUpMsg({ text: tr('update.dirtyWorktree', { detail: String(body.detail ?? '') }), cls: 'hint-warn-inline' });
          return;
        }
        const detail = body?.detail ?? body?.error ?? `HTTP ${r.status}`;
        setUpBusy(false);
        setUpMsg({ text: tr('update.updateFailed', { detail }), cls: 'hint-warn-inline' });
        return;
      }
      // A restart is needed when the server says so (local-dev build always
      // regenerates dist/, even when HEAD didn't move) or when the version
      // changed (generic npm/pnpm/bun path, which sets no restartRequired).
      const needsRestart = updateResponseNeedsRestart(body);
      if (needsRestart) {
        setUpBusy(false);
        // `changed` reflects whether the source actually advanced; a build-only
        // local-dev update (HEAD unchanged) still needs a restart to apply.
        setUpMsg({
          text: body.changed
            ? tr('update.updatedChanged', { old: `v${body.oldVersion}`, new: `v${body.newVersion}` })
            : tr('update.builtNeedsRestart'),
          cls: 'hint-ok',
        });
        if (await confirm({ title: tr('update.confirmRestartTitle'), message: tr('update.confirmRestart'), confirmLabel: tr('update.btnRestartNow'), cancelLabel: tr('update.btnLater') })) {
          await doRestart({ oldVersion: body.oldVersion, newVersion: body.newVersion });
        } else if (mountedRef.current) {
          setUpMsg({ text: tr('update.noRestartHint'), cls: 'hint-ok' });
        }
      } else {
        setUpBusy(false);
        setUpMsg({ text: tr('update.alreadyLatestRun', { version: `v${body.newVersion}` }), cls: 'hint-ok' });
        await fetchStatus();
      }
    } catch (e) {
      if (!mountedRef.current) return;
      setUpBusy(false);
      setUpMsg({ text: tr('update.updateFailed', { detail: e instanceof Error ? e.message : String(e) }), cls: 'hint-warn-inline' });
    }
  }

  const autostartBlock = (
    <AutostartCard
      canWrite={canWrite}
      state={autostartState}
      loading={autostartLoading}
      error={autostartError}
      busy={autostartBusy}
      message={autostartMsg}
      onChange={enabled => { void setAutostartEnabled(enabled); }}
      onRetry={() => { void fetchAutostart(); }}
    />
  );

  const updateBlock = (
    <UpdateCard
      canWrite={canWrite}
      status={upStatus}
      statusError={upStatusError}
      changelog={upChangelog}
      changelogOpen={upChangelogOpen}
      changelogOk={upChangelogOk}
      changelogRateLimited={upChangelogRateLimited}
      releasesUrl={upReleasesUrl}
      busy={upBusy}
      message={upMsg}
      onCheck={() => {
        setUpStatus(null);
        setUpChangelog(null);
        setUpChangelogOpen(false);
        setUpMsg(null);
        setUpStatusError(null);
        void fetchStatus();
      }}
      onToggleChangelog={() => {
        const next = !upChangelogOpen;
        setUpChangelogOpen(next);
        if (next && upChangelog === null) void loadChangelog();
      }}
      onUpdate={() => void doUpdate()}
      onRestart={() => { void (async () => { if (await confirm({ title: tr('update.confirmRestartTitle'), message: tr('update.confirmPlainRestart'), confirmLabel: tr('update.btnRestartNow'), cancelLabel: tr('update.btnCancel') })) void doRestart(null); })(); }}
    />
  );

  const settingsBody = settings ? (
    <SettingsBody
      settings={settings}
      canWrite={canWrite}
      bound={bound}
      savingKey={savingKey}
      message={settingsMsg}
      autostartBlock={autostartBlock}
      updateBlock={updateBlock}
      feishuLoginQr={feishuLoginQr}
      onCloseFeishuLoginQr={() => setFeishuLoginQr(null)}
      onFeishuLoginQr={setFeishuLoginQr}
      onSave={saveSettings}
    />
  ) : loadError ? (
    <p className="hint-warn">{tr('settings.loadFailed')}: {loadError}</p>
  ) : (
    <LoadingState label={tr('settings.loading')} />
  );

  return (
    <section className="page settings-page">
      <div className="page-heading">
        <div>
          <p className="eyebrow">{tr('nav.settings')}</p>
          <h1>{tr('settings.title')}</h1>
        </div>
      </div>
      {settingsBody}
    </section>
  );
}

function SettingsBody(props: {
  settings: DashboardSettings;
  canWrite: boolean;
  bound: boolean;
  savingKey: string | null;
  message: StatusMessage;
  autostartBlock: ReactNode;
  updateBlock: ReactNode;
  feishuLoginQr: string | null;
  onCloseFeishuLoginQr(): void;
  /** per-bot 前置配置失败且需要重新登录开放平台时，把二维码顶到本页已有的扫码面板。 */
  onFeishuLoginQr(qr: string | null): void;
  onSave(key: string, payload: unknown, optimistic: (settings: DashboardSettings) => DashboardSettings): Promise<void>;
}) {
  const tr = useT();
  const { settings, canWrite, bound, savingKey } = props;
  const dis = !canWrite;
  const autoUpdate = taskUi(settings.maintenance, 'autoUpdate');
  const autoUpdateDisabled = !canWrite || settings.localDevInstall || !settings.autoUpdateSupported;
  const autoRestartDisabled = !canWrite || settings.maintenance.autoUpdate?.enabled !== true;

  const saveBoolean = (key: 'publicReadOnly' | 'openTerminalInFeishu' | 'enableLocalCliOpen' | 'chatBotDiscovery' | 'codexRpcInput' | 'bypassCodexHookTrust' | 'noVisibleOutputHint' | 'remoteAccess', value: boolean) => {
    void props.onSave(key, { [key]: value }, s => ({ ...s, [key]: value }));
  };
  const saveHerdrTraexPlugin = (patch: Partial<Pick<DashboardSettings['herdrTraexPlugin'], 'enabled' | 'source' | 'ref'>>) => {
    return props.onSave(
      'herdrTraexPlugin',
      { herdrTraexPlugin: patch },
      s => ({ ...s, herdrTraexPlugin: { ...s.herdrTraexPlugin, ...patch } }),
    );
  };
  const saveCodexNotifier = (patch: Partial<Pick<DashboardSettings['codexNotifier'], 'enabled' | 'targetBotAppId' | 'notifyWhen'>>) => {
    return props.onSave(
      'codexNotifier',
      { codexNotifier: patch },
      s => ({ ...s, codexNotifier: { ...s.codexNotifier, ...patch } }),
    );
  };
  const saveHostOverloadAlert = (patch: Partial<Pick<DashboardSettings['hostOverloadAlert'], 'enabled' | 'targetBotAppId' | 'enterLoadRatio' | 'enterMemUsedFrac'>>) => {
    return props.onSave(
      'hostOverloadAlert',
      { hostOverloadAlert: patch },
      s => ({ ...s, hostOverloadAlert: { ...s.hostOverloadAlert, ...patch } }),
    );
  };
  const repoModeOptions = useMemo(() => [
    { value: 'all' as const, label: tr('settings.repoPickerModeAll') },
    { value: 'repos' as const, label: tr('settings.repoPickerModeRepos') },
  ], [tr]);
  const localCliModeOptions = useMemo(() => [
    { value: 'attach' as const, label: tr('settings.localCliOpenModeAttach') },
    { value: 'resume' as const, label: tr('settings.localCliOpenModeResume') },
  ], [tr]);
  return (
    <div className="settings-layout">
      <SettingsNav tr={tr} />
      <div className="settings-content">
      {canWrite ? null : (
        <article className="bd-card settings-card settings-alert-card">
          <p className="hint-warn">{tr('settings.readOnlyVisitor')}</p>
        </article>
      )}
      <SettingsModule
        title={tr('settings.moduleGeneral')}
        description={tr('settings.moduleGeneralHelp')}
      >
      <SettingsGroup className="settings-group-main">
        <SettingsBlock id="settings-access" title={tr('settings.sectionAccess')}>
          <ToggleRow
            title={tr('settings.publicReadOnly')}
            help={tr('settings.publicReadOnlyHelp')}
            checked={settings.publicReadOnly}
            disabled={dis || savingKey === 'publicReadOnly'}
            onChange={value => saveBoolean('publicReadOnly', value)}
          />
          {bound ? (
            <ToggleRow
              title={tr('settings.remoteAccess')}
              help={tr('settings.remoteAccessHelp')}
              checked={settings.remoteAccess}
              disabled={dis || savingKey === 'remoteAccess'}
              onChange={value => saveBoolean('remoteAccess', value)}
            />
          ) : null}
          <OAuthRedirectBaseRow
            value={settings.oauthRedirectBase}
            disabled={dis || savingKey === 'oauthRedirectBase'}
            onSave={value => props.onSave(
              'oauthRedirectBase',
              { oauthRedirectBase: value },
              s => ({ ...s, oauthRedirectBase: value }),
            )}
          />
        </SettingsBlock>
        <SettingsBlock id="settings-cards" title={tr('settings.sectionCards')}>
          <ToggleRow
            title={tr('settings.openTerminalInFeishu')}
            help={tr('settings.openTerminalInFeishuHelp')}
            checked={settings.openTerminalInFeishu}
            disabled={dis || savingKey === 'openTerminalInFeishu'}
            onChange={value => saveBoolean('openTerminalInFeishu', value)}
          />
          <ToggleRow
            title={tr('settings.enableLocalCliOpen')}
            help={tr('settings.enableLocalCliOpenHelp')}
            checked={settings.enableLocalCliOpen}
            disabled={dis || savingKey === 'enableLocalCliOpen'}
            onChange={value => saveBoolean('enableLocalCliOpen', value)}
          />
          <div className="settings-field-row">
            <FieldTitle help={tr('settings.localCliOpenModeHelp')}>{tr('settings.localCliOpenMode')}</FieldTitle>
            <DropdownMenu
              className="settings-field-menu"
              ariaLabel={tr('settings.localCliOpenMode')}
              disabled={dis || !settings.enableLocalCliOpen || savingKey === 'localCliOpenMode'}
              value={settings.localCliOpenMode}
              label={dropdownLabel(localCliModeOptions, settings.localCliOpenMode)}
              options={localCliModeOptions}
              onChange={value => {
                void props.onSave('localCliOpenMode', { localCliOpenMode: value }, s => ({ ...s, localCliOpenMode: value }));
              }}
            />
          </div>
        </SettingsBlock>
        <SettingsBlock id="settings-group-creation" title={tr('settings.sectionGroupCreation')}>
          <GroupNamePrefixRow
            value={settings.groupNamePrefix}
            disabled={dis || savingKey === 'groupNamePrefix'}
            onSave={value => props.onSave(
              'groupNamePrefix',
              { groupNamePrefix: value },
              s => ({ ...s, groupNamePrefix: value }),
            )}
          />
        </SettingsBlock>
        <SettingsBlock id="settings-experimental" title={tr('settings.sectionExperimental')}>
          <ToggleRow
            title={tr('settings.chatBotDiscovery')}
            help={tr('settings.chatBotDiscoveryHelp')}
            checked={settings.chatBotDiscovery}
            disabled={dis || savingKey === 'chatBotDiscovery'}
            onChange={value => saveBoolean('chatBotDiscovery', value)}
          />
          <ToggleRow
            title={tr('settings.herdrTraexPlugin')}
            help={tr('settings.herdrTraexPluginHelp')}
            checked={settings.herdrTraexPlugin.enabled}
            disabled={dis || savingKey === 'herdrTraexPlugin'}
            onChange={value => saveHerdrTraexPlugin({ enabled: value })}
          />
          {settings.herdrTraexPlugin.enabled ? (
            <TraexPluginEditor
              value={settings.herdrTraexPlugin}
              disabled={dis || savingKey === 'herdrTraexPlugin'}
              onSave={patch => saveHerdrTraexPlugin(patch)}
            />
          ) : null}
          <ToggleRow
            title={tr('settings.codexRpcInput')}
            help={tr('settings.codexRpcInputHelp')}
            checked={settings.codexRpcInput}
            disabled={dis || savingKey === 'codexRpcInput'}
            onChange={value => saveBoolean('codexRpcInput', value)}
          />
          <ToggleRow
            title={tr('settings.bypassCodexHookTrust')}
            help={tr('settings.bypassCodexHookTrustHelp')}
            checked={settings.bypassCodexHookTrust}
            disabled={dis || savingKey === 'bypassCodexHookTrust'}
            onChange={value => saveBoolean('bypassCodexHookTrust', value)}
          />
          <CodexNotifierSettingsEditor
            value={settings.codexNotifier}
            disabled={dis}
            saving={savingKey === 'codexNotifier'}
            onSave={saveCodexNotifier}
          />
          <ToggleRow
            title={tr('settings.noVisibleOutputHint')}
            help={tr('settings.noVisibleOutputHintHelp')}
            checked={settings.noVisibleOutputHint}
            disabled={dis || savingKey === 'noVisibleOutputHint'}
            onChange={value => saveBoolean('noVisibleOutputHint', value)}
          />
        </SettingsBlock>
        <SettingsBlock id="settings-overload" title={tr('settings.sectionHostOverloadAlert')}>
          <HostOverloadAlertSettingsEditor
            value={settings.hostOverloadAlert}
            disabled={dis}
            saving={savingKey === 'hostOverloadAlert'}
            onSave={saveHostOverloadAlert}
          />
        </SettingsBlock>
        <SettingsBlock id="settings-whiteboard" title={tr('settings.sectionWhiteboard')}>
          <ToggleRow
            title={tr('settings.whiteboardEnable')}
            help={tr('settings.whiteboardEnableHelp')}
            checked={settings.whiteboard.enabled}
            disabled={dis || savingKey === 'whiteboard'}
            onChange={value => {
              void props.onSave('whiteboard', { whiteboard: { enabled: value } }, s => ({ ...s, whiteboard: { enabled: value } }));
            }}
          />
        </SettingsBlock>
        <SettingsBlock title={tr('settings.sectionWorkflow')}>
          <ToggleRow
            title={tr('settings.workflowEnable')}
            help={tr('settings.workflowEnableHelp')}
            checked={settings.workflow.enabled}
            disabled={dis || savingKey === 'workflow'}
            onChange={value => {
              void props.onSave('workflow', { workflow: { enabled: value } }, s => ({ ...s, workflow: { enabled: value } }));
            }}
          />
        </SettingsBlock>
        <SettingsBlock id="settings-repo-picker" title={tr('settings.sectionRepoPicker')}>
          <div className="settings-field-row">
            <FieldTitle help={tr('settings.repoPickerModeHelp')}>{tr('settings.repoPickerMode')}</FieldTitle>
            <DropdownMenu
              className="settings-field-menu"
              ariaLabel={tr('settings.repoPickerMode')}
              disabled={dis || savingKey === 'repoPickerMode'}
              value={settings.repoPickerMode}
              label={dropdownLabel(repoModeOptions, settings.repoPickerMode)}
              options={repoModeOptions}
              onChange={value => {
                void props.onSave('repoPickerMode', { repoPickerMode: value }, s => ({ ...s, repoPickerMode: value }));
              }}
            />
          </div>
        </SettingsBlock>
        <SettingsBlock id="settings-schedule" title={tr('settings.sectionSchedule')}>
          <TimeZoneRow
            value={settings.scheduleTimeZone}
            host={settings.hostTimeZone}
            effective={settings.effectiveScheduleTimeZone}
            disabled={dis || savingKey === 'scheduleTimeZone'}
            onSave={tz => {
              void props.onSave(
                'scheduleTimeZone',
                { scheduleTimeZone: tz },
                s => ({ ...s, scheduleTimeZone: tz ?? '' }),
              );
            }}
          />
        </SettingsBlock>
      </SettingsGroup>
      </SettingsModule>
      <SettingsModule
        className="settings-module-meeting"
        title={tr('settings.moduleMeeting')}
        description={tr('settings.moduleMeetingHelp')}
      >
      <SettingsGroup className="settings-group-meeting">
        <SettingsBlock id="settings-vc" className="settings-vc-block" title={tr('settings.sectionVcMeetingAgent')}>
          <ToggleRow
            title={tr('settings.vcMeetingAgent')}
            help={tr('settings.vcMeetingAgentHelp')}
            checked={settings.vcMeetingAgent.enabled}
            disabled={dis || savingKey === 'vcMeetingAgent'}
            onChange={value => {
              void props.onSave(
                'vcMeetingAgent',
                { vcMeetingAgent: { enabled: value } },
                s => ({ ...s, vcMeetingAgent: { ...s.vcMeetingAgent, enabled: value } }),
              );
            }}
          />
          <LarkCliStatus settings={settings.vcMeetingAgent} />
          <VcConsumerProfilesGate
            enabled={settings.vcMeetingAgent.enabled}
            canWrite={canWrite}
            onFeishuLoginQr={props.onFeishuLoginQr}
          />
          {props.feishuLoginQr ? (
            <div className="settings-feishu-login">
              <button
                type="button"
                className="settings-feishu-login-close"
                aria-label={tr('settings.feishuLoginClose')}
                title={tr('settings.feishuLoginClose')}
                onClick={props.onCloseFeishuLoginQr}
              />
              <p>{tr('settings.feishuLoginRequired')}</p>
              <img src={props.feishuLoginQr} alt={tr('settings.feishuLoginQrAlt')} />
            </div>
          ) : null}
        </SettingsBlock>
      </SettingsGroup>
      </SettingsModule>
      <SettingsModule
        title={tr('settings.moduleSystem')}
        description={tr('settings.moduleSystemHelp')}
      >
      <SettingsGroup className="settings-group-ops">
        {props.autostartBlock}
        <SettingsBlock
          id="settings-maintenance"
          title={tr('settings.sectionMaintenance')}
          titleExtra={settings.localDevInstall
            ? <span className="settings-title-note">{tr('settings.autoUpdateLocalDev')}</span>
            : !settings.autoUpdateSupported
              ? <span className="settings-title-note">{tr('settings.autoUpdateUnsupportedInstall')}</span>
              : null}
        >
          <div className="settings-maintenance-grid">
            <div className="settings-maintenance-update">
              <ToggleRow
                title={tr('settings.autoUpdate')}
                help={tr('settings.autoUpdateHelp')}
                checked={autoUpdate.enabled}
                disabled={autoUpdateDisabled || savingKey === 'autoUpdate'}
                onChange={value => {
                  const task = { enabled: value, time: autoUpdate.time };
                  void props.onSave('autoUpdate', { maintenance: { autoUpdate: task } }, s => ({
                    ...s,
                    maintenance: { ...s.maintenance, autoUpdate: task },
                  }));
                }}
              />
              <div className="maint-time">
                <label>
                  <span>{tr('settings.maintenanceTime')}</span>
                  <input
                    type="time"
                    value={autoUpdate.time}
                    disabled={autoUpdateDisabled || savingKey === 'autoUpdate'}
                    onChange={e => {
                      const task = { enabled: autoUpdate.enabled, time: e.currentTarget.value || '04:00' };
                      void props.onSave('autoUpdate', { maintenance: { autoUpdate: task } }, s => ({
                        ...s,
                        maintenance: { ...s.maintenance, autoUpdate: task },
                      }));
                    }}
                  />
                </label>
              </div>
            </div>
            <div className="settings-maintenance-restart">
              <ToggleRow
                title={tr('settings.autoRestart')}
                help={tr('settings.autoRestartHelp')}
                checked={settings.maintenance.autoRestart?.enabled === true}
                disabled={autoRestartDisabled || savingKey === 'autoRestart'}
                onChange={value => {
                  const task = { enabled: value };
                  void props.onSave('autoRestart', { maintenance: { autoRestart: task } }, s => ({
                    ...s,
                    maintenance: { ...s.maintenance, autoRestart: task },
                  }));
                }}
              />
            </div>
          </div>
        </SettingsBlock>
        <div id="settings-update">{props.updateBlock}</div>
      </SettingsGroup>
      </SettingsModule>
      <div className="settings-status-row">
        <span className={`oncall-status ${props.message?.cls ?? ''}`} data-settings-status>{props.message?.text ?? ''}</span>
      </div>
      </div>
    </div>
  );
}

function SettingsNav(props: { tr: ReturnType<typeof useT> }): React.JSX.Element {
  const tr = props.tr;
  const groups = [
    {
      label: tr('settings.moduleGeneral'),
      items: [
        { id: 'settings-access', label: tr('settings.sectionAccess') },
        { id: 'settings-cards', label: tr('settings.sectionCards') },
        { id: 'settings-group-creation', label: tr('settings.sectionGroupCreation') },
        { id: 'settings-experimental', label: tr('settings.sectionExperimental') },
        { id: 'settings-overload', label: tr('settings.sectionHostOverloadAlert') },
        { id: 'settings-whiteboard', label: tr('settings.sectionWhiteboard') },
        { id: 'settings-repo-picker', label: tr('settings.sectionRepoPicker') },
        { id: 'settings-schedule', label: tr('settings.sectionSchedule') },
      ],
    },
    {
      label: tr('settings.moduleMeeting'),
      items: [
        { id: 'settings-vc', label: tr('settings.sectionVcMeetingAgent') },
      ],
    },
    {
      label: tr('settings.moduleSystem'),
      items: [
        { id: 'settings-maintenance', label: tr('settings.sectionMaintenance') },
        { id: 'settings-update', label: tr('settings.sectionUpdate') },
      ],
    },
  ];
  return (
    <nav className="settings-nav" aria-label={tr('settings.title')}>
      {groups.map(group => (
        <div key={group.label} className="settings-nav-group">
          <p className="settings-nav-group-label">{group.label}</p>
          {group.items.map(item => (
            <button
              key={item.id}
              type="button"
              className="settings-nav-link"
              onClick={() => {
                document.getElementById(item.id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      ))}
    </nav>
  );
}

function SettingsModule(props: {
  className?: string;
  title: string;
  description: string;
  children: ReactNode;
}): React.JSX.Element {
  const cls = ['settings-module', props.className].filter(Boolean).join(' ');
  return (
    <section className={cls}>
      <header className="settings-module-heading">
        <h2>{props.title}</h2>
        <p>{props.description}</p>
      </header>
      {props.children}
    </section>
  );
}

function LarkCliStatus(props: { settings: DashboardSettings['vcMeetingAgent'] }) {
  const tr = useT();
  const version = props.settings.larkCliVersion;
  const ready = typeof version === 'string' && props.settings.larkCliMeetsRequirement === true;
  const text = ready
    ? tr('settings.larkCliReady', { version })
    : typeof version === 'string'
      ? tr('settings.larkCliOutdated', { version, minimum: props.settings.larkCliMinVersion ?? '-' })
      : tr('settings.larkCliMissing');

  return (
    <div className={`settings-lark-cli-status ${ready ? 'is-ready' : 'is-warning'}`}>
      <span aria-hidden="true" />
      <strong>{text}</strong>
      {ready ? null : <code>npm i -g @larksuite/cli@latest</code>}
    </div>
  );
}

function SettingsGroup(props: {
  className?: string;
  children: ReactNode;
}): React.JSX.Element {
  const cls = ['settings-group', props.className].filter(Boolean).join(' ');
  return (
    <section className={cls}>
      <article className="bd-card settings-group-card">
        {props.children}
      </article>
    </section>
  );
}

function SettingsBlock(props: {
  className?: string;
  id?: string;
  title: ReactNode;
  titleExtra?: ReactNode;
  children: ReactNode;
}): React.JSX.Element {
  const cls = ['settings-block', props.className].filter(Boolean).join(' ');
  return (
    <section className={cls} id={props.id}>
      <article className="bd-card settings-card">
        <div className="settings-block-title-row">
          <h2 className="bd-section-title">{props.title}</h2>
          {props.titleExtra ? <div className="settings-block-title-extra">{props.titleExtra}</div> : null}
        </div>
        {props.children}
      </article>
    </section>
  );
}

export function CodexNotifierSettingsEditor(props: {
  value: DashboardSettings['codexNotifier'];
  disabled: boolean;
  saving: boolean;
  onSave(
    patch: Partial<Pick<DashboardSettings['codexNotifier'], 'enabled' | 'targetBotAppId' | 'notifyWhen'>>,
  ): Promise<void> | void;
}) {
  const tr = useT();
  const [enableRequested, setEnableRequested] = useState(false);
  const autoEnableStartedRef = useRef(false);
  const botOptions = useMemo(() => [
    { value: '', label: tr('settings.codexNotifierTargetPlaceholder') },
    ...props.value.botOptions.map(bot => ({
      value: bot.larkAppId,
      label: [
        bot.botName || bot.larkAppId,
        bot.cliId,
      ].filter(Boolean).join(' · '),
    })),
  ], [props.value.botOptions, tr]);
  const timingOptions = useMemo(() => [
    { value: 'locked_only' as const, label: tr('settings.codexNotifierLockedOnly') },
    { value: 'always' as const, label: tr('settings.codexNotifierAlways') },
  ], [tr]);
  const selectedBot = props.value.botOptions
    .find(bot => bot.larkAppId === props.value.targetBotAppId);
  const enableBlocked = !props.value.targetBotAppId
    || selectedBot?.recipientConfigured !== true
    || selectedBot?.recipientVerified !== true
    || !props.value.targetDaemonOnline
    || (!props.value.platformSupported && props.value.notifyWhen === 'locked_only');
  const showDetails = props.value.enabled || enableRequested;
  const controlsDisabled = props.disabled || props.saving;

  useEffect(() => {
    if (!enableRequested || props.value.enabled || enableBlocked) {
      autoEnableStartedRef.current = false;
      return;
    }
    if (controlsDisabled || autoEnableStartedRef.current) return;
    autoEnableStartedRef.current = true;
    void props.onSave({ enabled: true });
  }, [
    controlsDisabled,
    enableBlocked,
    enableRequested,
    props.onSave,
    props.value.enabled,
  ]);

  useEffect(() => {
    if (props.value.enabled && enableRequested) setEnableRequested(false);
  }, [enableRequested, props.value.enabled]);

  const setEnabled = (enabled: boolean) => {
    if (!enabled) {
      autoEnableStartedRef.current = false;
      setEnableRequested(false);
      if (props.value.enabled) void props.onSave({ enabled: false });
      return;
    }
    if (enableBlocked) {
      setEnableRequested(true);
      return;
    }
    void props.onSave({ enabled: true });
  };

  return (
    <>
      <ToggleRow
        title={tr('settings.codexNotifier')}
        help={tr('settings.codexNotifierHelp')}
        checked={props.value.enabled || enableRequested}
        disabled={controlsDisabled}
        onChange={setEnabled}
      />
      {showDetails ? (
        <div className="settings-codex-notifier-details">
          {!props.value.enabled ? (
            <p className="settings-subfield-hint">{tr('settings.codexNotifierEnablePending')}</p>
          ) : null}
          <div className="settings-field-row">
            <FieldTitle help={tr('settings.codexNotifierTargetHelp')}>{tr('settings.codexNotifierTarget')}</FieldTitle>
            <DropdownMenu
              className="settings-field-menu"
              ariaLabel={tr('settings.codexNotifierTarget')}
              disabled={controlsDisabled}
              searchable
              value={props.value.targetBotAppId ?? ''}
              label={dropdownLabel(botOptions, props.value.targetBotAppId ?? '')}
              options={botOptions}
              onChange={value => { void props.onSave({ targetBotAppId: value || null }); }}
            />
          </div>
          {selectedBot?.recipientHint ? (
            <p className="settings-subfield-hint">
              {tr('settings.codexNotifierRecipient', { recipient: selectedBot.recipientHint })}
            </p>
          ) : null}
          <div className="settings-field-row">
            <FieldTitle help={tr('settings.codexNotifierNotifyWhenHelp')}>{tr('settings.codexNotifierNotifyWhen')}</FieldTitle>
            <DropdownMenu
              className="settings-field-menu"
              ariaLabel={tr('settings.codexNotifierNotifyWhen')}
              disabled={controlsDisabled}
              value={props.value.notifyWhen}
              label={dropdownLabel(timingOptions, props.value.notifyWhen)}
              options={timingOptions}
              onChange={value => { void props.onSave({ notifyWhen: value }); }}
            />
          </div>
          {!props.value.targetBotAppId ? (
            <p className="hint-warn-inline">{tr('settings.codexNotifierTargetRequired')}</p>
          ) : selectedBot?.recipientConfigured !== true ? (
            <p className="hint-warn-inline">{tr('settings.codexNotifierRecipientMissing')}</p>
          ) : !props.value.targetDaemonOnline ? (
            <p className="hint-warn-inline">
              {tr(props.value.enabled
                ? 'settings.codexNotifierDaemonOffline'
                : 'settings.codexNotifierTargetOffline')}
            </p>
          ) : selectedBot?.recipientVerified !== true ? (
            <p className="hint-warn-inline">{tr('settings.codexNotifierRecipientUnverified')}</p>
          ) : !props.value.platformSupported && props.value.notifyWhen === 'locked_only' ? (
            <p className="hint-warn-inline">{tr('settings.codexNotifierUnsupported')}</p>
          ) : props.value.enabled ? (
            !props.value.hookInstalled ? (
              <p className="hint-warn-inline">{tr('settings.codexNotifierHookPending')}</p>
            ) : !props.value.workerOnline ? (
              <p className="hint-warn-inline">{tr('settings.codexNotifierWorkerPending')}</p>
            ) : props.value.lastError ? (
              <p className="hint-warn-inline">
                {tr('settings.codexNotifierLastError', { error: props.value.lastError.message })}
              </p>
            ) : props.value.pendingCount > 0 ? (
              <p className="hint-warn-inline">
                {tr('settings.codexNotifierPending', { count: props.value.pendingCount })}
              </p>
            ) : null
          ) : null}
        </div>
      ) : null}
    </>
  );
}

export function HostOverloadAlertSettingsEditor(props: {
  value: DashboardSettings['hostOverloadAlert'];
  disabled: boolean;
  saving: boolean;
  onSave(
    patch: Partial<Pick<DashboardSettings['hostOverloadAlert'], 'enabled' | 'targetBotAppId' | 'enterLoadRatio' | 'enterMemUsedFrac'>>,
  ): Promise<void> | void;
}) {
  const tr = useT();
  const controlsDisabled = props.disabled || props.saving;
  const botOptions = useMemo(() => [
    { value: '', label: tr('settings.hostOverloadAlertTargetPlaceholder') },
    ...props.value.botOptions.map(bot => ({
      value: bot.larkAppId,
      label: [bot.botName || bot.larkAppId, bot.cliId].filter(Boolean).join(' · '),
    })),
  ], [props.value.botOptions, tr]);
  const selectedBot = props.value.botOptions.find(bot => bot.larkAppId === props.value.targetBotAppId);
  // Always show the target/threshold editor — even in the fresh default state
  // (disabled + no target). Gating it behind enabled||target would deadlock a
  // brand-new install: the dropdown would be hidden AND the toggle disabled
  // (see below), leaving no way to pick a target. The toggle stays disabled
  // until a target is chosen; the editor is how you choose one.
  // Local draft for the threshold inputs so typing doesn't fire a save per keystroke.
  const [loadDraft, setLoadDraft] = useState(String(props.value.enterLoadRatio));
  const [memDraft, setMemDraft] = useState(String(Math.round(props.value.enterMemUsedFrac * 100)));
  useEffect(() => { setLoadDraft(String(props.value.enterLoadRatio)); }, [props.value.enterLoadRatio]);
  useEffect(() => { setMemDraft(String(Math.round(props.value.enterMemUsedFrac * 100))); }, [props.value.enterMemUsedFrac]);

  const commitLoad = () => {
    const n = Number(loadDraft);
    if (Number.isFinite(n) && n > 0 && n !== props.value.enterLoadRatio) void props.onSave({ enterLoadRatio: n });
    else setLoadDraft(String(props.value.enterLoadRatio));
  };
  const commitMem = () => {
    const pct = Number(memDraft);
    const frac = pct / 100;
    if (Number.isFinite(pct) && pct > 0 && pct <= 100 && frac !== props.value.enterMemUsedFrac) void props.onSave({ enterMemUsedFrac: frac });
    else setMemDraft(String(Math.round(props.value.enterMemUsedFrac * 100)));
  };

  return (
    <>
      <ToggleRow
        title={tr('settings.hostOverloadAlert')}
        help={tr('settings.hostOverloadAlertHelp')}
        checked={props.value.enabled}
        disabled={controlsDisabled || (!props.value.enabled && !props.value.targetBotAppId)}
        onChange={value => { void props.onSave({ enabled: value }); }}
      />
      <div className="settings-codex-notifier-details">
          <div className="settings-field-row">
            <FieldTitle help={tr('settings.hostOverloadAlertTargetHelp')}>{tr('settings.hostOverloadAlertTarget')}</FieldTitle>
            <DropdownMenu
              className="settings-field-menu"
              ariaLabel={tr('settings.hostOverloadAlertTarget')}
              disabled={controlsDisabled}
              searchable
              value={props.value.targetBotAppId ?? ''}
              label={dropdownLabel(botOptions, props.value.targetBotAppId ?? '')}
              options={botOptions}
              onChange={value => { void props.onSave({ targetBotAppId: value || null }); }}
            />
          </div>
          {selectedBot?.recipientHint ? (
            <p className="settings-subfield-hint">
              {tr('settings.hostOverloadAlertRecipient', { recipient: selectedBot.recipientHint })}
            </p>
          ) : null}
          <div className="settings-field-row">
            <FieldTitle help={tr('settings.hostOverloadAlertEnterLoadHelp')}>{tr('settings.hostOverloadAlertEnterLoad')}</FieldTitle>
            <input
              type="number" min={0.1} step={0.1} className="settings-text-input"
              value={loadDraft} disabled={controlsDisabled}
              onChange={e => setLoadDraft(e.currentTarget.value)}
              onBlur={commitLoad}
              onKeyDown={e => { if (e.key === 'Enter') commitLoad(); }}
            />
          </div>
          <div className="settings-field-row">
            <FieldTitle help={tr('settings.hostOverloadAlertEnterMemHelp')}>{tr('settings.hostOverloadAlertEnterMem')}</FieldTitle>
            <input
              type="number" min={1} max={100} step={1} className="settings-text-input"
              value={memDraft} disabled={controlsDisabled}
              onChange={e => setMemDraft(e.currentTarget.value)}
              onBlur={commitMem}
              onKeyDown={e => { if (e.key === 'Enter') commitMem(); }}
            />
          </div>
          {!props.value.targetBotAppId ? (
            <p className="hint-warn-inline">{tr('settings.hostOverloadAlertTargetRequired')}</p>
          ) : selectedBot?.recipientConfigured !== true ? (
            <p className="hint-warn-inline">{tr('settings.hostOverloadAlertRecipientMissing')}</p>
          ) : !props.value.targetDaemonOnline ? (
            <p className="hint-warn-inline">{tr('settings.hostOverloadAlertTargetOffline')}</p>
          ) : selectedBot?.recipientVerified !== true ? (
            <p className="hint-warn-inline">{tr('settings.hostOverloadAlertRecipientUnverified')}</p>
          ) : null}
        </div>
    </>
  );
}

export function TimeZoneRow(props: {
  value: string;
  host: string;
  effective: string;
  disabled: boolean;
  onSave(tz: string | null): void;
}) {
  const tr = useT();
  const value = props.value.trim();
  const effective = props.effective || props.value.trim() || props.host;
  const timeZoneOptions = useMemo(() => {
    const zones = value && !COMMON_TIMEZONES.includes(value) ? [value, ...COMMON_TIMEZONES] : COMMON_TIMEZONES;
    return [
      { value: '', label: tr('settings.scheduleTimeZoneHost', { host: props.host }) },
      ...zones.map(zone => ({ value: zone, label: zone })),
    ];
  }, [props.host, tr, value]);

  return (
    <div className="settings-field-row settings-timezone-row">
      <FieldTitle help={tr('settings.scheduleTimeZoneHelp', { host: props.host, effective })}>
        {tr('settings.scheduleTimeZone')}
      </FieldTitle>
      <DropdownMenu
        className="settings-field-menu settings-timezone-menu"
        ariaLabel={tr('settings.scheduleTimeZone')}
        value={value}
        label={dropdownLabel(timeZoneOptions, value)}
        options={timeZoneOptions}
        disabled={props.disabled}
        onChange={next => props.onSave(next === '' ? null : next)}
      />
    </div>
  );
}

function ToggleRow(props: {
  title: string;
  help: string;
  checked: boolean;
  disabled: boolean;
  onChange(value: boolean): void;
}) {
  return (
    <label className="toggle-row">
      <input
        type="checkbox"
        checked={props.checked}
        disabled={props.disabled}
        onChange={e => props.onChange(e.currentTarget.checked)}
      />
      <span className="switch" aria-hidden="true" />
      <span className="toggle-tx">
        <strong><FieldTitle className="settings-toggle-title" help={props.help}>{props.title}</FieldTitle></strong>
      </span>
    </label>
  );
}

const GROUP_NAME_PREFIX_INPUT_MAX_LENGTH = 32;

export function GroupNamePrefixRow(props: {
  value: string;
  disabled: boolean;
  onSave(value: string): Promise<void> | void;
}) {
  const tr = useT();
  const [draft, setDraft] = useState(props.value);
  useEffect(() => setDraft(props.value), [props.value]);

  const hasVisibleContent = draft.trim().length > 0;
  const valid = draft === '' || hasVisibleContent;
  const dirty = draft !== props.value;
  const submit = () => {
    if (props.disabled || !dirty || !valid) return;
    void props.onSave(draft);
  };

  return (
    <div className="settings-subfield settings-group-prefix-editor">
      <div className="settings-field-row">
        <FieldTitle help={tr('settings.groupNamePrefixHelp')}>{tr('settings.groupNamePrefix')}</FieldTitle>
        <input
          className="settings-text-input"
          type="text"
          value={draft}
          maxLength={GROUP_NAME_PREFIX_INPUT_MAX_LENGTH}
          placeholder={tr('settings.groupNamePrefixPlaceholder')}
          disabled={props.disabled}
          onChange={event => setDraft(event.currentTarget.value)}
          onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); submit(); } }}
        />
      </div>
      <p className="settings-subfield-hint" data-group-name-prefix-preview>
        {hasVisibleContent
          ? tr('settings.groupNamePrefixPreview', { name: `${draft}${tr('settings.groupNamePrefixPreviewName')}` })
          : tr('settings.groupNamePrefixDisabled')}
      </p>
      <div className="actions">
        <button
          type="button"
          className="page-primary-action"
          disabled={props.disabled || !dirty || !valid}
          onClick={submit}
        >
          {tr('settings.groupNamePrefixSave')}
        </button>
      </div>
    </div>
  );
}

/** 从 `location.href` 取当前访问 origin。浏览器最清楚自己是从哪个地址打开的
 *  Dashboard —— 中心化平台的隧道会重写 Host 且不带 X-Forwarded-Host，服务端反而
 *  推不准（见 platform/binding.ts 的注释），所以「一键填入」这颗按钮的价值就在于
 *  用浏览器视角覆盖服务端视角。非浏览器宿主 / URL 解析失败时返回 ''。 */
export function currentBrowserOrigin(): string {
  try {
    if (typeof location === 'undefined' || !location?.href) return '';
    const origin = new URL(location.href).origin;
    // 只认 http(s) origin：opaque origin 会给出 'null'，本地打开的 file:// 页在
    // Chrome 下给出 'file://'——两者填进去都是废值，不如把按钮直接置灰。
    return isValidOAuthRedirectBase(origin) ? origin : '';
  } catch {
    return '';
  }
}

/** 与服务端 `normalizeOAuthRedirectBase` 同一套判定（http(s) origin，不带路径/
 *  query/fragment），只是提前到前端，避免用户点了保存才吃一个 error code。 */
export function isValidOAuthRedirectBase(raw: string): boolean {
  const value = raw.trim();
  if (!/^https?:\/\//i.test(value)) return false;
  try {
    const url = new URL(value.replace(/\/+$/, ''));
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    if (!url.hostname) return false;
    if (url.username || url.password || url.search || url.hash) return false;
    return url.pathname === '' || url.pathname === '/';
  } catch {
    return false;
  }
}

/** OAuth 回跳基址：配了之后授权链接回跳 `<base>/oauth/callback`，Dashboard 自动收下，
 *  用户不用再复制粘贴回调 URL。留空 = 退回 127.0.0.1 粘贴流程。 */
export function OAuthRedirectBaseRow(props: {
  value: string;
  disabled: boolean;
  onSave(value: string): Promise<void> | void;
}) {
  const tr = useT();
  const [draft, setDraft] = useState(props.value);
  useEffect(() => setDraft(props.value), [props.value]);

  // 与服务端同款归一：削尾斜杠。这样「保存的」和「看到的」是同一个串，也不会因为
  // 多一条斜杠让保存按钮永远亮着（服务端存的是削过的）。
  const trimmed = draft.trim().replace(/\/+$/, '');
  // 空串是合法输入（=清除配置），只有「填了但不是 http(s) origin」才拦。
  const valid = trimmed === '' || isValidOAuthRedirectBase(trimmed);
  const dirty = trimmed !== props.value.trim().replace(/\/+$/, '');
  const submit = () => {
    if (props.disabled || !dirty || !valid) return;
    void props.onSave(trimmed);
  };

  return (
    <div className="settings-subfield settings-oauth-redirect-base-editor">
      <div className="settings-field-row">
        <FieldTitle help={tr('settings.oauthRedirectBaseHelp')}>{tr('settings.oauthRedirectBase')}</FieldTitle>
        <input
          className="settings-text-input"
          type="text"
          data-input="oauthRedirectBase"
          value={draft}
          placeholder={tr('settings.oauthRedirectBasePlaceholder')}
          disabled={props.disabled}
          onChange={event => setDraft(event.currentTarget.value)}
          onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); submit(); } }}
        />
      </div>
      <p className="settings-subfield-hint" data-oauth-redirect-base-preview>
        {trimmed === ''
          ? tr('settings.oauthRedirectBaseUnset')
          : valid
            ? tr('settings.oauthRedirectBasePreview', { url: `${trimmed}/oauth/callback` })
            : tr('settings.oauthRedirectBaseInvalid')}
      </p>
      <div className="actions">
        <button
          type="button"
          data-action="oauth-redirect-base-use-current"
          disabled={props.disabled || !currentBrowserOrigin()}
          onClick={() => setDraft(currentBrowserOrigin())}
        >
          {tr('settings.oauthRedirectBaseUseCurrent')}
        </button>
        <button
          type="button"
          className="page-primary-action"
          data-action="oauth-redirect-base-save"
          disabled={props.disabled || !dirty || !valid}
          onClick={submit}
        >
          {tr('settings.oauthRedirectBaseSave')}
        </button>
      </div>
    </div>
  );
}

function TraexPluginEditor(props: {
  value: DashboardSettings['herdrTraexPlugin'];
  disabled: boolean;
  onSave(patch: { source: string; ref: string }): Promise<void>;
}) {
  const tr = useT();
  const [source, setSource] = useState(props.value.source);
  const [ref, setRef] = useState(props.value.ref);
  useEffect(() => {
    setSource(props.value.source);
    setRef(props.value.ref);
  }, [props.value.source, props.value.ref]);

  const normalizedSource = source.trim();
  const normalizedRef = ref.trim();
  const dirty = normalizedSource !== props.value.source.trim() || normalizedRef !== props.value.ref.trim();
  const submit = () => {
    if (props.disabled || !dirty) return;
    void props.onSave({ source: normalizedSource, ref: normalizedRef });
  };

  return (
    <div className="settings-subfield">
      <div className="settings-field-row">
        <FieldTitle help={tr('settings.herdrTraexPluginSourceHelp')}>{tr('settings.herdrTraexPluginSource')}</FieldTitle>
        <input
          className="settings-text-input"
          type="text"
          value={source}
          placeholder={tr('settings.herdrTraexPluginSourcePlaceholder')}
          disabled={props.disabled}
          onChange={event => setSource(event.currentTarget.value)}
          onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); submit(); } }}
        />
      </div>
      <div className="settings-field-row">
        <FieldTitle help={tr('settings.herdrTraexPluginRefHelp')}>{tr('settings.herdrTraexPluginRef')}</FieldTitle>
        <input
          className="settings-text-input"
          type="text"
          value={ref}
          placeholder={tr('settings.herdrTraexPluginRefPlaceholder')}
          disabled={props.disabled}
          onChange={event => setRef(event.currentTarget.value)}
          onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); submit(); } }}
        />
      </div>
      {normalizedSource ? null : (
        <p className="hint-warn-inline settings-subfield-hint">{tr('settings.herdrTraexPluginSourceRequired')}</p>
      )}
      {props.value.recommendedSource
        && (normalizedSource !== props.value.recommendedSource || normalizedRef !== props.value.recommendedRef) ? (
          <p className="settings-subfield-hint">
            {tr('settings.herdrTraexPluginRecommended')}{' '}
            <button
              type="button"
              className="settings-inline-link"
              disabled={props.disabled}
              onClick={() => {
                setSource(props.value.recommendedSource);
                setRef(props.value.recommendedRef);
              }}
            >
              {props.value.recommendedSource}{props.value.recommendedRef ? ` @ ${props.value.recommendedRef}` : ''}
            </button>
          </p>
        ) : null}
      <div className="actions">
        <button
          type="button"
          className="page-primary-action"
          disabled={props.disabled || !dirty}
          onClick={submit}
        >
          {tr('settings.herdrTraexPluginSave')}
        </button>
      </div>
    </div>
  );
}

function AutostartCard(props: {
  canWrite: boolean;
  state: AutostartState | null;
  loading: boolean;
  error: boolean;
  busy: boolean;
  message: StatusMessage;
  onChange(enabled: boolean): void;
  onRetry(): void;
}) {
  const tr = useT();
  let content: ReactNode;

  if (!props.canWrite) {
    content = <p className="hint-warn">{tr('settings.autostartLoginRequired')}</p>;
  } else if (props.loading && !props.state) {
    content = <LoadingState label={tr('settings.autostartLoading')} compact />;
  } else if (props.error && !props.state) {
    content = (
      <>
        <p className="hint-warn">{tr('settings.autostartLoadFailed')}</p>
        <div className="update-actions">
          <button type="button" onClick={props.onRetry}>{tr('settings.autostartRetry')}</button>
        </div>
      </>
    );
  } else if (props.state?.supported === false) {
    content = <p className="hint-warn">{tr('settings.autostartUnsupported')}</p>;
  } else if (props.state) {
    content = (
      <>
        <ToggleRow
          title={tr('settings.autostartToggle')}
          help={tr('settings.autostartHelp')}
          checked={props.state.enabled}
          disabled={props.busy}
          onChange={props.onChange}
        />
        {props.message ? (
          <p className={`oncall-status ${props.message.cls ?? ''}`} role="status" aria-live="polite">
            {props.message.text}
          </p>
        ) : null}
      </>
    );
  } else {
    content = null;
  }

  return <SettingsBlock title={tr('settings.sectionAutostart')}>{content}</SettingsBlock>;
}

function UpdateCard(props: {
  canWrite: boolean;
  status: UpdateStatus | null;
  statusError: string | null;
  changelog: ReleaseNote[] | null;
  changelogOpen: boolean;
  changelogOk: boolean;
  changelogRateLimited: boolean;
  releasesUrl: string;
  busy: boolean;
  message: StatusMessage;
  onCheck(): void;
  onToggleChangelog(): void;
  onUpdate(): void;
  onRestart(): void;
}) {
  const tr = useT();
  let inner: React.ReactNode;
  if (!props.canWrite) {
    inner = <p className="hint-warn">{tr('update.loginRequired')}</p>;
  } else if (props.statusError) {
    inner = (
      <>
        <p className="hint-warn">{tr('update.checkFailed')}: {props.statusError}</p>
        <div className="update-actions"><button type="button" data-up="check" onClick={props.onCheck}>{tr('update.btnCheck')}</button></div>
      </>
    );
  } else if (!props.status) {
    inner = <LoadingState label={tr('update.loading')} compact />;
  } else {
    const s = props.status;
    // Local-dev: enable the button only when the checkout is a git worktree we
    // can pull; the generic path still requires a supported package manager.
    const updateDisabled = props.busy || (s.localDevInstall
      ? !s.localDevUpdatable
      : !s.updateSupported);
    const updateLabel = s.localDevInstall ? tr('update.btnUpdateLocalDev') : tr('update.btnUpdate');
    inner = (
      <>
        <p className="update-version">
          <span>{tr('update.current')}: <strong>v{s.current}</strong></span>{' '}
          <UpdateBadge status={s} />
        </p>
        {!s.node.ok ? <p className="hint-warn">{tr('update.nodeWarn', { version: s.node.version, required: s.node.required })}</p> : null}
        {!s.localDevInstall && !s.updateSupported ? <p className="hint-warn">{tr('update.unsupportedInstall')}</p> : null}
        {s.localDevInstall ? <p className="hint">{s.localDevUpdatable ? tr('update.localDevUpdatable') : tr('update.localDev')}</p> : null}
        {s.installs.multiple ? <MultiInstallWarning entries={s.installs.entries} /> : null}
        <div className="update-actions">
          <button type="button" data-up="check" disabled={props.busy} onClick={props.onCheck}>{tr('update.btnCheck')}</button>
          <button type="button" data-up="changelog" disabled={props.busy} onClick={props.onToggleChangelog}>
            {props.changelogOpen ? tr('update.btnChangelogHide') : tr('update.btnChangelog')}
          </button>
          <button type="button" className="page-primary-action" data-up="update" disabled={updateDisabled} onClick={props.onUpdate}>{updateLabel}</button>
          <button type="button" data-up="restart" disabled={props.busy} onClick={props.onRestart}>{tr('update.btnRestart')}</button>
        </div>
        {s.cliUpdates?.length ? <CliRuntimeUpdates entries={s.cliUpdates} /> : null}
        {props.changelogOpen ? (
          <ChangelogPanel
            changelog={props.changelog}
            ok={props.changelogOk}
            rateLimited={props.changelogRateLimited}
            releasesUrl={props.releasesUrl}
          />
        ) : null}
        {props.message ? <p className={`oncall-status ${props.message.cls ?? ''}`}>{props.message.text}</p> : null}
      </>
    );
  }
  return (
    <SettingsBlock
      className="settings-update-block"
      title={tr('update.section')}
      titleExtra={props.status?.localDevInstall
        ? <span className="settings-title-note">{props.status.localDevUpdatable ? tr('update.localDevNote') : tr('update.localDev')}</span>
        : props.status && !props.status.updateSupported
          ? <span className="settings-title-note">{tr('update.unsupportedInstall')}</span>
          : null}
    >
      {inner}
    </SettingsBlock>
  );
}

function CliRuntimeUpdates(props: { entries: CliRuntimeUpdateStatus[] }) {
  const tr = useT();
  return (
    <div className="cli-runtime-updates">
      <strong>{tr('update.runtimeTitle')}</strong>
      <ul>
        {props.entries.map(entry => (
          <li key={`${entry.runtimeId}:${entry.binPath}`} className={entry.updateAvailable ? 'is-behind' : ''}>
            <div className="cli-runtime-update-head">
              <span>{entry.displayName}</span>
              {entry.updateAvailable && entry.latest ? (
                <span className="update-badge update-badge-new">
                  {tr('update.runtimeAvailable', { current: entry.current ?? '?', latest: entry.latest })}
                </span>
              ) : !entry.managed ? (
                <span className="hint-warn-inline">{tr('update.runtimeUnmanaged')}</span>
              ) : entry.latest ? (
                <span className="update-badge update-badge-ok">{tr('update.upToDate')}</span>
              ) : (
                <span className="hint-warn-inline">{tr('update.checkUnavailable')}</span>
              )}
            </div>
            <code>{entry.binPath}</code>
            {entry.updateAvailable && entry.updateCommand ? (
              <small>{tr('update.runtimeCommand')}: <code>{entry.updateCommand}</code></small>
            ) : null}
          </li>
        ))}
      </ul>
      <p className="settings-help">{tr('update.runtimeHelp')}</p>
    </div>
  );
}

function UpdateBadge(props: { status: UpdateStatus }) {
  const tr = useT();
  const s = props.status;
  if (!s.latest) return <span className="hint-warn-inline">{tr('update.checkUnavailable')}</span>;
  return s.behind
    ? <span className="update-badge update-badge-new">{tr('update.newAvailable', { version: `v${s.latest}` })}</span>
    : <span className="update-badge update-badge-ok">{tr('update.upToDate')}</span>;
}

function MultiInstallWarning(props: { entries: InstallEntry[] }) {
  const tr = useT();
  return (
    <div className="hint-warn">
      <p>{tr('update.multiInstallWarn')}</p>
      <ul className="update-install-list">
        {props.entries.map(e => (
          <li key={`${e.binPath}:${e.root}`}>
            <code>{e.binPath}</code>{' → '}{installKindLabel(e.kind, tr)} <small>{e.root}</small>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ChangelogPanel(props: {
  changelog: ReleaseNote[] | null;
  ok: boolean;
  rateLimited: boolean;
  releasesUrl: string;
}) {
  const tr = useT();
  if (props.changelog === null) return <LoadingState label={tr('update.changelogLoading')} compact />;
  if (!props.ok) {
    const reason = props.rateLimited ? tr('update.changelogRateLimited') : tr('update.changelogFailed');
    return (
      <p className="hint-warn-inline">
        {reason}
        {props.releasesUrl ? <> <a href={props.releasesUrl} target="_blank" rel="noopener">{tr('update.changelogViewOnGitHub')}</a></> : null}
      </p>
    );
  }
  if (props.changelog.length === 0) return <p className="empty">{tr('update.changelogEmpty')}</p>;
  return (
    <div className="update-changelog">
      {props.changelog.map(r => {
        const title = r.name && r.name !== `v${r.version}` ? r.name : '';
        const date = r.publishedAt ? new Date(r.publishedAt).toLocaleDateString() : '';
        return (
          <details className="update-release" open key={r.version}>
            <summary>
              <strong>v{r.version}</strong> {title} <small>{date}</small>{' '}
              <a href={r.url} target="_blank" rel="noopener">↗</a>
            </summary>
            <pre className="update-release-body">{r.body || ''}</pre>
          </details>
        );
      })}
    </div>
  );
}

export function renderSettingsPage(root: HTMLElement): PageDisposer {
  return mountReactPage(root, <SettingsPage />);
}
