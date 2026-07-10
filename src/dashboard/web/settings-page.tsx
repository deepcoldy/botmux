import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { DropdownMenu, FieldTitle, LoadingState, dropdownLabel } from './dashboard-components.js';
import { useT } from './react-hooks.js';
import { mountReactPage, type PageDisposer } from './react-mount.js';
import { store } from './store.js';

interface MaintenanceTaskCfg { enabled?: boolean; time?: string }
interface MaintenanceCfg { autoUpdate?: MaintenanceTaskCfg; autoRestart?: MaintenanceTaskCfg }

interface DashboardSettings {
  publicReadOnly: boolean;
  openTerminalInFeishu: boolean;
  chatBotDiscovery: boolean;
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

interface InstallEntry { binPath: string; root: string; kind: 'npm-global' | 'source-checkout' | 'unknown' }
interface NodeCheck { version: string; major: number; required: number; ok: boolean }
interface UpdateStatus {
  current: string;
  latest: string | null;
  behind: boolean;
  localDevInstall: boolean;
  node: NodeCheck;
  installs: { entries: InstallEntry[]; multiple: boolean };
}
interface ReleaseNote { version: string; name: string; body: string; url: string; publishedAt: string | null }

type StatusMessage = { text: string; cls?: string } | null;

function parseSettings(s: any): DashboardSettings {
  return {
    publicReadOnly: s?.publicReadOnly === true,
    openTerminalInFeishu: s?.openTerminalInFeishu === true,
    chatBotDiscovery: s?.chatBotDiscovery !== false,
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
      store.setScheduleTimeZone(saved.effectiveScheduleTimeZone);
      setSettingsMsg({ text: tr('settings.saved'), cls: 'hint-ok' });
    } catch (e) {
      if (!mountedRef.current) return;
      setSettings(before);
      setSettingsMsg({ text: `${tr('settings.saveFailed')}: ${e instanceof Error ? e.message : String(e)}`, cls: 'hint-warn-inline' });
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
    if (s.installs.multiple) {
      const paths = s.installs.entries.map(e => `• ${e.binPath} (${installKindLabel(e.kind, tr)})`).join('\n');
      if (!window.confirm(tr('update.confirmMultiInstall', { paths }))) return;
    }
    const confirmMsg = s.latest ? tr('update.confirmUpdate', { version: `v${s.latest}` }) : tr('update.confirmUpdateNoVer');
    if (!window.confirm(confirmMsg)) return;
    setUpBusy(true);
    setUpMsg({ text: tr('update.updating') });
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
  const autoUpdateDisabled = !canWrite || settings.localDevInstall;
  const autoRestartDisabled = !canWrite || settings.maintenance.autoUpdate?.enabled !== true;

  const saveBoolean = (key: 'publicReadOnly' | 'openTerminalInFeishu' | 'chatBotDiscovery' | 'remoteAccess', value: boolean) => {
    void props.onSave(key, { [key]: value }, s => ({ ...s, [key]: value }));
  };
  const repoModeOptions = useMemo(() => [
    { value: 'all' as const, label: tr('settings.repoPickerModeAll') },
    { value: 'repos' as const, label: tr('settings.repoPickerModeRepos') },
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
        </SettingsBlock>
        <SettingsBlock title={tr('settings.sectionExperimental')}>
          <ToggleRow
            title={tr('settings.chatBotDiscovery')}
            help={tr('settings.chatBotDiscoveryHelp')}
            checked={settings.chatBotDiscovery}
            disabled={dis || savingKey === 'chatBotDiscovery'}
            onChange={value => saveBoolean('chatBotDiscovery', value)}
          />
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
          titleExtra={settings.localDevInstall ? <span className="settings-title-note">{tr('settings.autoUpdateLocalDev')}</span> : null}
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
    const updateDisabled = s.localDevInstall || props.busy;
    inner = (
      <>
        <p className="update-version">
          <span>{tr('update.current')}: <strong>v{s.current}</strong></span>{' '}
          <UpdateBadge status={s} />
        </p>
        {!s.node.ok ? <p className="hint-warn">{tr('update.nodeWarn', { version: s.node.version, required: s.node.required })}</p> : null}
        {s.installs.multiple ? <MultiInstallWarning entries={s.installs.entries} /> : null}
        <div className="update-actions">
          <button type="button" data-up="check" disabled={props.busy} onClick={props.onCheck}>{tr('update.btnCheck')}</button>
          <button type="button" data-up="changelog" disabled={props.busy} onClick={props.onToggleChangelog}>
            {props.changelogOpen ? tr('update.btnChangelogHide') : tr('update.btnChangelog')}
          </button>
          <button type="button" className="page-primary-action" data-up="update" disabled={updateDisabled} onClick={props.onUpdate}>{tr('update.btnUpdate')}</button>
          <button type="button" data-up="restart" disabled={props.busy} onClick={props.onRestart}>{tr('update.btnRestart')}</button>
        </div>
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
      titleExtra={props.status?.localDevInstall ? <span className="settings-title-note">{tr('update.localDev')}</span> : null}
    >
      {inner}
    </SettingsBlock>
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
