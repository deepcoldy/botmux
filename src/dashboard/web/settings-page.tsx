import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { DropdownMenu, FieldTitle, LoadingState, dropdownLabel } from './dashboard-components.js';
import { VcConsumerProfilesGate } from './vc-consumer-profiles-section.js';
import { useT } from './react-hooks.js';
import { mountReactPage, type PageDisposer } from './react-mount.js';
import { store } from './store.js';
import { ui } from './ui.js';

interface MaintenanceTaskCfg { enabled?: boolean; time?: string }
interface MaintenanceCfg { autoUpdate?: MaintenanceTaskCfg; autoRestart?: MaintenanceTaskCfg }

interface DashboardSettings {
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
  vcMeetingAgent: {
    enabled: boolean;
    listenerBotAppId: string | null;
    listenerBotOptions: Array<{
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
  repoPickerMode: 'all' | 'repos';
  maintenance: MaintenanceCfg;
  localDevInstall: boolean;
  autoUpdateSupported: boolean;
  whiteboard: { enabled: boolean };
  remoteAccess: boolean;
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
  binPath: string;
  current: string | null;
  latest: string | null;
  updateAvailable: boolean;
  updateCommand: string;
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
  updateSupported: boolean;
  updateManager: 'npm' | 'pnpm' | 'yarn' | 'bun' | 'unknown';
  updateCommand: string | null;
  node: NodeCheck;
  installs: { entries: InstallEntry[]; multiple: boolean };
}
interface ReleaseNote { version: string; name: string; body: string; url: string; publishedAt: string | null }

type StatusMessage = { text: string; cls?: string } | null;

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
    vcMeetingAgent: {
      enabled: s?.vcMeetingAgent?.enabled !== false,
      listenerBotAppId: typeof s?.vcMeetingAgent?.listenerBotAppId === 'string' ? s.vcMeetingAgent.listenerBotAppId : null,
      listenerBotOptions: Array.isArray(s?.vcMeetingAgent?.listenerBotOptions) ? s.vcMeetingAgent.listenerBotOptions : [],
      larkCliVersion: s?.vcMeetingAgent?.larkCliVersion === undefined ? undefined : (s.vcMeetingAgent.larkCliVersion ?? null),
      larkCliMeetsRequirement: s?.vcMeetingAgent?.larkCliMeetsRequirement === true,
      larkCliMinVersion: typeof s?.vcMeetingAgent?.larkCliMinVersion === 'string' ? s.vcMeetingAgent.larkCliMinVersion : undefined,
    },
    repoPickerMode: s?.repoPickerMode === 'repos' ? 'repos' : 'all',
    maintenance: (s?.maintenance && typeof s.maintenance === 'object') ? s.maintenance : {},
    localDevInstall: s?.localDevInstall === true,
    autoUpdateSupported: s?.autoUpdateSupported !== false,
    whiteboard: { enabled: s?.whiteboard?.enabled === true },
    remoteAccess: s?.remoteAccess === true,
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
    if (canWrite) void fetchStatus();
  }, [canWrite, fetchStatus, settingsLoaded]);

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
      await fetch('/api/update/restart', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(updatePayload ? { update: updatePayload } : {}),
      });
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
      window.alert(tr('update.nodeTooOldAlert', { version: s.node.version, required: s.node.required }));
      return;
    }
    if (!s.updateSupported || !s.updateCommand) {
      window.alert(tr('update.unsupportedInstall'));
      return;
    }
    if (s.installs.multiple) {
      const paths = s.installs.entries.map(e => `• ${e.binPath} (${installKindLabel(e.kind, tr)})`).join('\n');
      if (!window.confirm(tr('update.confirmMultiInstall', { paths }))) return;
    }
    const confirmMsg = s.latest
      ? tr('update.confirmUpdate', { version: `v${s.latest}`, command: s.updateCommand })
      : tr('update.confirmUpdateNoVer', { command: s.updateCommand });
    if (!window.confirm(confirmMsg)) return;
    setUpBusy(true);
    setUpMsg({ text: tr('update.updating', { command: s.updateCommand }) });
    try {
      const r = await fetch('/api/update/run', { method: 'POST' });
      const body = await r.json().catch(() => ({}));
      if (!mountedRef.current) return;
      if (!r.ok || body.ok === false) {
        const detail = body?.detail ?? body?.error ?? `HTTP ${r.status}`;
        setUpBusy(false);
        setUpMsg({ text: tr('update.updateFailed', { detail }), cls: 'hint-warn-inline' });
        return;
      }
      if (body.changed) {
        setUpBusy(false);
        setUpMsg({ text: tr('update.updatedChanged', { old: `v${body.oldVersion}`, new: `v${body.newVersion}` }), cls: 'hint-ok' });
        if (window.confirm(tr('update.confirmRestart'))) {
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
      onRestart={() => { if (window.confirm(tr('update.confirmPlainRestart'))) void doRestart(null); }}
    />
  );

  const settingsBody = settings ? (
    <SettingsBody
      settings={settings}
      canWrite={canWrite}
      bound={bound}
      savingKey={savingKey}
      message={settingsMsg}
      updateBlock={updateBlock}
      feishuLoginQr={feishuLoginQr}
      onCloseFeishuLoginQr={() => setFeishuLoginQr(null)}
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
  updateBlock: ReactNode;
  feishuLoginQr: string | null;
  onCloseFeishuLoginQr(): void;
  onSave(key: string, payload: unknown, optimistic: (settings: DashboardSettings) => DashboardSettings): Promise<void>;
}) {
  const tr = useT();
  const { settings, canWrite, bound, savingKey } = props;
  const dis = !canWrite;
  const autoUpdate = taskUi(settings.maintenance, 'autoUpdate');
  const autoUpdateDisabled = !canWrite || settings.localDevInstall || !settings.autoUpdateSupported;
  const autoRestartDisabled = !canWrite || settings.maintenance.autoUpdate?.enabled !== true;

  const saveBoolean = (key: 'publicReadOnly' | 'openTerminalInFeishu' | 'enableLocalCliOpen' | 'chatBotDiscovery' | 'remoteAccess', value: boolean) => {
    void props.onSave(key, { [key]: value }, s => ({ ...s, [key]: value }));
  };
  const saveHerdrTraexPlugin = (patch: Partial<Pick<DashboardSettings['herdrTraexPlugin'], 'enabled' | 'source' | 'ref'>>) => {
    return props.onSave(
      'herdrTraexPlugin',
      { herdrTraexPlugin: patch },
      s => ({ ...s, herdrTraexPlugin: { ...s.herdrTraexPlugin, ...patch } }),
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
  const vcListenerOptions = useMemo(() => [
    { value: '', label: tr('settings.vcMeetingListenerBotAuto') },
    ...settings.vcMeetingAgent.listenerBotOptions.map(bot => {
      const label = bot.botName || bot.larkAppId;
      const detail = bot.cliId ? ` · ${bot.cliId}` : '';
      const suffixParts = [
        bot.vcMeetingAgentEnabled === true ? undefined : tr('settings.vcMeetingListenerBotDisabled'),
        bot.hasLarkCliProfile === true ? undefined : tr('settings.vcMeetingListenerBotNoProfile'),
      ].filter(Boolean);
      const suffix = suffixParts.length > 0 ? ` · ${suffixParts.join(' · ')}` : '';
      return { value: bot.larkAppId, label: `${label}${detail}${suffix}` };
    }),
  ], [settings.vcMeetingAgent.listenerBotOptions, tr]);

  return (
    <div className="settings-layout">
      {canWrite ? null : (
        <article className="bd-card settings-card settings-alert-card">
          <p className="hint-warn">{tr('settings.readOnlyVisitor')}</p>
        </article>
      )}
      <SettingsGroup className="settings-group-main">
        <SettingsBlock title={tr('settings.sectionAccess')}>
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
        </SettingsBlock>
        <SettingsBlock title={tr('settings.sectionCards')}>
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
        <SettingsBlock title={tr('settings.sectionExperimental')}>
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
        </SettingsBlock>
        <SettingsBlock title={tr('settings.sectionWhiteboard')}>
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
        <SettingsBlock title={tr('settings.sectionRepoPicker')}>
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
        <SettingsBlock title={tr('settings.sectionSchedule')}>
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
        <SettingsBlock className="settings-vc-block" title={tr('settings.sectionVcMeetingAgent')}>
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
          <div className="settings-field-row">
            <FieldTitle help={tr('settings.vcMeetingListenerBotHelp')}>{tr('settings.vcMeetingListenerBot')}</FieldTitle>
            <DropdownMenu
              className="settings-field-menu"
              ariaLabel={tr('settings.vcMeetingListenerBot')}
              disabled={dis || savingKey === 'vcMeetingAgent'}
              value={settings.vcMeetingAgent.listenerBotAppId ?? ''}
              label={dropdownLabel(vcListenerOptions, settings.vcMeetingAgent.listenerBotAppId ?? '')}
              options={vcListenerOptions}
              onChange={value => {
                const next = value || null;
                void props.onSave(
                  'vcMeetingAgent',
                  { vcMeetingAgent: { listenerBotAppId: next } },
                  s => ({ ...s, vcMeetingAgent: { ...s.vcMeetingAgent, listenerBotAppId: next } }),
                );
              }}
            />
          </div>
          <LarkCliStatus settings={settings.vcMeetingAgent} />
          <VcConsumerProfilesGate
            enabled={settings.vcMeetingAgent.enabled}
            canWrite={canWrite}
            listenerBotAppId={settings.vcMeetingAgent.listenerBotAppId}
            listenerBotOptions={settings.vcMeetingAgent.listenerBotOptions}
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
      <SettingsGroup className="settings-group-ops">
        <SettingsBlock
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
        {props.updateBlock}
      </SettingsGroup>
      <div className="settings-status-row">
        <span className={`oncall-status ${props.message?.cls ?? ''}`} data-settings-status>{props.message?.text ?? ''}</span>
      </div>
    </div>
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
}): JSX.Element {
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
  title: ReactNode;
  titleExtra?: ReactNode;
  children: ReactNode;
}): JSX.Element {
  const cls = ['settings-block', props.className].filter(Boolean).join(' ');
  return (
    <section className={cls}>
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
    const updateDisabled = s.localDevInstall || !s.updateSupported || props.busy;
    inner = (
      <>
        <p className="update-version">
          <span>{tr('update.current')}: <strong>v{s.current}</strong></span>{' '}
          <UpdateBadge status={s} />
        </p>
        {!s.node.ok ? <p className="hint-warn">{tr('update.nodeWarn', { version: s.node.version, required: s.node.required })}</p> : null}
        {!s.localDevInstall && !s.updateSupported ? <p className="hint-warn">{tr('update.unsupportedInstall')}</p> : null}
        {s.installs.multiple ? <MultiInstallWarning entries={s.installs.entries} /> : null}
        <div className="update-actions">
          <button type="button" data-up="check" disabled={props.busy} onClick={props.onCheck}>{tr('update.btnCheck')}</button>
          <button type="button" data-up="changelog" disabled={props.busy} onClick={props.onToggleChangelog}>
            {props.changelogOpen ? tr('update.btnChangelogHide') : tr('update.btnChangelog')}
          </button>
          <button type="button" className="page-primary-action" data-up="update" disabled={updateDisabled} onClick={props.onUpdate}>{tr('update.btnUpdate')}</button>
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
        ? <span className="settings-title-note">{tr('update.localDev')}</span>
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
          <li key={`${entry.cliId}:${entry.binPath}`} className={entry.updateAvailable ? 'is-behind' : ''}>
            <div className="cli-runtime-update-head">
              <span>Codex</span>
              {entry.updateAvailable && entry.latest ? (
                <span className="update-badge update-badge-new">
                  {tr('update.runtimeAvailable', { current: entry.current ?? '?', latest: entry.latest })}
                </span>
              ) : entry.latest ? (
                <span className="update-badge update-badge-ok">{tr('update.upToDate')}</span>
              ) : (
                <span className="hint-warn-inline">{tr('update.checkUnavailable')}</span>
              )}
            </div>
            <code>{entry.binPath}</code>
            {entry.updateAvailable ? (
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
