import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
  /** Configured schedule-task timezone override (IANA), or '' when unset ⇒ follow host. */
  scheduleTimeZone: string;
  /** Host's auto-detected local zone. */
  hostTimeZone: string;
  /** TRUE effective zone (env → config → host) from scheduleTimeZone(). Use this
   *  for "currently effective" / store sync — never reconstruct configured||host. */
  effectiveScheduleTimeZone: string;
}

/** A handful of common IANA zones offered as a datalist for the timezone field. */
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
    // Prefer the backend's true effective zone (includes env override); fall back
    // to configured||host only if an older backend didn't send it.
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
        if (body?.feishuLoginQr && typeof body.feishuLoginQr === 'string') {
          setFeishuLoginQr(body.feishuLoginQr);
        }
        throw new Error(body?.error ?? `HTTP ${r.status}`);
      }
      setFeishuLoginQr(null);
      const saved = parseSettings(body.settings);
      setSettings(saved);
      // Sync the shared store to the TRUE effective zone (env → config → host,
      // as computed by the backend) so this SPA's schedules/overview re-render
      // correctly — reconstructing configured||host here would drop an env
      // override. Other browsers pick it up via the schedule.timezone SSE event.
      store.setScheduleTimeZone(saved.effectiveScheduleTimeZone);
      setSettingsMsg({ text: tr('settings.saved'), cls: 'hint-ok' });
      setTimer(() => setSettingsMsg(current => (current?.cls === 'hint-ok' ? null : current)), 2400);
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

  const settingsBody = settings ? (
    <SettingsBody
      settings={settings}
      canWrite={canWrite}
      bound={bound}
      savingKey={savingKey}
      feishuLoginQr={feishuLoginQr}
      setFeishuLoginQr={setFeishuLoginQr}
      onSave={saveSettings}
    />
  ) : loadError ? (
    <p className="hint-warn st-banner">{tr('settings.loadFailed')}: {loadError}</p>
  ) : (
    <p className="empty st-banner">{tr('settings.loading')}</p>
  );

  return (
    <section className="page">
      <div className="page-heading">
        <div>
          <p className="eyebrow">{tr('nav.settings')}</p>
          <h1>{tr('settings.title')}</h1>
          <p>{tr('settings.subtitle')}</p>
        </div>
      </div>
      <div className="settings-grid">
        {settingsBody}
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
      </div>
      {settingsMsg ? (
        <div className={`st-status ${settingsMsg.cls ?? ''}`} data-settings-status role="status">{settingsMsg.text}</div>
      ) : null}
    </section>
  );
}

type SettingsSectionIcon =
  | 'access' | 'cards' | 'experimental' | 'meeting'
  | 'whiteboard' | 'repo' | 'maintenance' | 'update';

function SectionIcon(props: { name: SettingsSectionIcon }) {
  const shapes: Record<SettingsSectionIcon, React.ReactNode> = {
    access: (
      <>
        <path d="M8 1.7l5 1.9v4.1c0 3.2-2.1 5.6-5 6.6-2.9-1-5-3.4-5-6.6V3.6z" />
        <path d="M5.9 8l1.5 1.5 2.7-2.8" />
      </>
    ),
    cards: <path d="M2.2 3.2h11.6v7.4H8.3L5.1 13.2v-2.6H2.2z" />,
    experimental: (
      <>
        <path d="M6.1 1.8h3.8M7 1.8v4L3.1 12.4a1.35 1.35 0 001.2 2h7.4a1.35 1.35 0 001.2-2L9 5.8v-4" />
        <path d="M4.7 10.6h6.6" />
      </>
    ),
    meeting: (
      <>
        <rect x="1.6" y="4.1" width="8.9" height="7.8" rx="1.4" />
        <path d="M10.5 7.4l3.9-2.3v5.8l-3.9-2.3" />
      </>
    ),
    whiteboard: (
      <>
        <rect x="1.9" y="2.4" width="12.2" height="8.4" rx="1.2" />
        <path d="M4.7 8.2c1-.9 1.8-2.5 2.5-1.8.7.7-.5 2 .3 2.3.7.3 1.8-1.6 3.8-1.9" />
        <path d="M5.3 13.9h5.4M8 10.8v3.1" />
      </>
    ),
    repo: (
      <>
        <circle cx="4.3" cy="3.6" r="1.7" />
        <circle cx="4.3" cy="12.4" r="1.7" />
        <circle cx="11.9" cy="5.3" r="1.7" />
        <path d="M4.3 5.3v5.4M11.9 7c0 2.7-3.6 2.9-5.7 3.6" />
      </>
    ),
    maintenance: (
      <>
        <path d="M13.9 4.7a3.7 3.7 0 01-4.9 4.5l-4.4 4.4a1.6 1.6 0 01-2.2-2.2L6.8 7a3.7 3.7 0 014.5-4.9L8.9 4.5l2.6 2.6z" />
      </>
    ),
    update: (
      <>
        <path d="M13.5 6.2A5.8 5.8 0 103 10.9" />
        <path d="M13.7 2.5v3.9H9.8" />
        <path d="M8 5.6v4.6M6 8.3l2 1.9 2-1.9" />
      </>
    ),
  };
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {shapes[props.name]}
    </svg>
  );
}

function SectionCard(props: {
  icon: SettingsSectionIcon;
  title: string;
  saving?: boolean;
  children: React.ReactNode;
}) {
  return (
    <article className="bd-card st-card" data-saving={props.saving ? '' : undefined}>
      <header className="st-card-head">
        <span className="st-chip" aria-hidden="true"><SectionIcon name={props.icon} /></span>
        <h3>{props.title}</h3>
      </header>
      {props.children}
    </article>
  );
}

/** Long help copy defaults to a 2-line clamp; click toggles the full text
 *  (same interaction as bot-defaults' bd-help, without flipping the switch). */
function HelpText(props: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <small
      className={open ? 'open' : undefined}
      onClick={e => {
        e.preventDefault();
        e.stopPropagation();
        setOpen(v => !v);
      }}
    >
      {props.text}
    </small>
  );
}

function SettingsBody(props: {
  settings: DashboardSettings;
  canWrite: boolean;
  bound: boolean;
  savingKey: string | null;
  feishuLoginQr: string | null;
  setFeishuLoginQr: (v: string | null) => void;
  onSave(key: string, payload: unknown, optimistic: (settings: DashboardSettings) => DashboardSettings): Promise<void>;
}) {
  const tr = useT();
  const { settings, canWrite, bound, savingKey, feishuLoginQr, setFeishuLoginQr } = props;
  const dis = !canWrite;
  const autoUpdate = taskUi(settings.maintenance, 'autoUpdate');
  const autoUpdateDisabled = !canWrite || settings.localDevInstall;
  const autoRestartDisabled = !canWrite || settings.maintenance.autoUpdate?.enabled !== true;

  const saveBoolean = (key: 'publicReadOnly' | 'openTerminalInFeishu' | 'chatBotDiscovery' | 'remoteAccess', value: boolean) => {
    void props.onSave(key, { [key]: value }, s => ({ ...s, [key]: value }));
  };

  return (
    <>
      {canWrite ? null : <p className="hint-warn st-banner">{tr('settings.readOnlyVisitor')}</p>}

      <SectionCard
        icon="access"
        title={tr('settings.sectionAccess')}
        saving={savingKey === 'publicReadOnly' || savingKey === 'remoteAccess'}
      >
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
      </SectionCard>

      <SectionCard
        icon="meeting"
        title={tr('settings.sectionVcMeetingAgent')}
        saving={savingKey === 'vcMeetingAgent'}
      >
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
        <label className="st-field">
          <span>{tr('settings.vcMeetingListenerBot')}</span>
          <select
            value={settings.vcMeetingAgent.listenerBotAppId ?? ''}
            disabled={dis || savingKey === 'vcMeetingAgent'}
            onChange={e => {
              const value = e.currentTarget.value || null;
              void props.onSave(
                'vcMeetingAgent',
                { vcMeetingAgent: { listenerBotAppId: value } },
                s => ({ ...s, vcMeetingAgent: { ...s.vcMeetingAgent, listenerBotAppId: value } }),
              );
            }}
          >
            <option value="">{tr('settings.vcMeetingListenerBotAuto')}</option>
            {settings.vcMeetingAgent.listenerBotOptions.map(bot => {
              const label = bot.botName || bot.larkAppId;
              const detail = bot.cliId ? ` · ${bot.cliId}` : '';
              const suffixParts = [
                bot.vcMeetingAgentEnabled === true ? undefined : tr('settings.vcMeetingListenerBotDisabled'),
                bot.hasLarkCliProfile === true ? undefined : tr('settings.vcMeetingListenerBotNoProfile'),
              ].filter(Boolean);
              const suffix = suffixParts.length > 0 ? ` · ${suffixParts.join(' · ')}` : '';
              return (
                <option key={bot.larkAppId} value={bot.larkAppId}>
                  {label}{detail}{suffix}
                </option>
              );
            })}
          </select>
          <HelpText text={tr('settings.vcMeetingListenerBotHelp')} />
        </label>
        {typeof settings.vcMeetingAgent.larkCliVersion === 'string' ? (
          settings.vcMeetingAgent.larkCliMeetsRequirement ? (
            <p className="st-larkcli-ok">
              lark-cli {settings.vcMeetingAgent.larkCliVersion} ✓
            </p>
          ) : (
            <p className="st-larkcli-warn">
              ⚠️ lark-cli {settings.vcMeetingAgent.larkCliVersion} 版本过低，VC bot 入会需要 ≥ {settings.vcMeetingAgent.larkCliMinVersion}。请运行 <code>npm i -g @larksuite/cli@latest</code> 升级。
            </p>
          )
        ) : (
          <p className="st-larkcli-warn">
            ⚠️ 未检测到 lark-cli，请先安装：<code>npm i -g @larksuite/cli</code>
          </p>
        )}
        {feishuLoginQr ? (
          <div className="st-feishu-qr">
            <p className="st-feishu-qr-hint">需要飞书开放平台登录才能自动配置 VC 权限，请扫码：</p>
            <img src={feishuLoginQr} alt="飞书扫码登录" className="st-feishu-qr-img" />
            <button
              type="button"
              className="st-btn st-btn-ghost"
              onClick={() => setFeishuLoginQr(null)}
            >关闭</button>
          </div>
        ) : null}
      </SectionCard>

      <SectionCard
        icon="cards"
        title={tr('settings.sectionCards')}
        saving={savingKey === 'openTerminalInFeishu'}
      >
        <ToggleRow
          title={tr('settings.openTerminalInFeishu')}
          help={tr('settings.openTerminalInFeishuHelp')}
          checked={settings.openTerminalInFeishu}
          disabled={dis || savingKey === 'openTerminalInFeishu'}
          onChange={value => saveBoolean('openTerminalInFeishu', value)}
        />
      </SectionCard>

      <SectionCard
        icon="experimental"
        title={tr('settings.sectionExperimental')}
        saving={savingKey === 'chatBotDiscovery'}
      >
        <ToggleRow
          title={tr('settings.chatBotDiscovery')}
          help={tr('settings.chatBotDiscoveryHelp')}
          checked={settings.chatBotDiscovery}
          disabled={dis || savingKey === 'chatBotDiscovery'}
          onChange={value => saveBoolean('chatBotDiscovery', value)}
        />
      </SectionCard>

      <SectionCard
        icon="whiteboard"
        title={tr('settings.sectionWhiteboard')}
        saving={savingKey === 'whiteboard'}
      >
        <ToggleRow
          title={tr('settings.whiteboardEnable')}
          help={tr('settings.whiteboardEnableHelp')}
          checked={settings.whiteboard.enabled}
          disabled={dis || savingKey === 'whiteboard'}
          onChange={value => {
            void props.onSave('whiteboard', { whiteboard: { enabled: value } }, s => ({ ...s, whiteboard: { enabled: value } }));
          }}
        />
      </SectionCard>

      <SectionCard
        icon="repo"
        title={tr('settings.sectionRepoPicker')}
        saving={savingKey === 'repoPickerMode'}
      >
        <label className="st-field">
          <span>{tr('settings.repoPickerMode')}</span>
          <select
            value={settings.repoPickerMode}
            disabled={dis || savingKey === 'repoPickerMode'}
            onChange={e => {
              const value = e.currentTarget.value === 'repos' ? 'repos' : 'all';
              void props.onSave('repoPickerMode', { repoPickerMode: value }, s => ({ ...s, repoPickerMode: value }));
            }}
          >
            <option value="all">{tr('settings.repoPickerModeAll')}</option>
            <option value="repos">{tr('settings.repoPickerModeRepos')}</option>
          </select>
          <HelpText text={tr('settings.repoPickerModeHelp')} />
        </label>
      </SectionCard>

      <SectionCard
        icon="maintenance"
        title={tr('settings.sectionSchedule')}
        saving={savingKey === 'scheduleTimeZone'}
      >
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
      </SectionCard>

      <SectionCard
        icon="maintenance"
        title={tr('settings.sectionMaintenance')}
        saving={savingKey === 'autoUpdate' || savingKey === 'autoRestart'}
      >
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
        <div className="st-subrow">
          <label className="st-field">
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
        {settings.localDevInstall ? <p className="hint-warn">{tr('settings.autoUpdateLocalDev')}</p> : null}
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
      </SectionCard>
    </>
  );
}

export function TimeZoneRow(props: {
  value: string;
  host: string;
  /** TRUE effective zone (env → config → host) for the "currently effective"
   *  hint. Must come from the backend, not be reconstructed as value||host. */
  effective: string;
  disabled: boolean;
  onSave(tz: string | null): void;
}) {
  const tr = useT();
  const [draft, setDraft] = useState(props.value);
  // Re-sync when a save round-trips (or another client changes the value).
  useEffect(() => { setDraft(props.value); }, [props.value]);

  const commit = () => {
    const next = draft.trim();
    if (next === props.value.trim()) return; // unchanged — skip the PUT
    props.onSave(next === '' ? null : next); // empty ⇒ clear override, follow host
  };

  const effective = props.effective || props.value.trim() || props.host;
  return (
    <label className="form-row">
      <span>{tr('settings.scheduleTimeZone')}</span>
      <input
        type="text"
        list="tz-common"
        value={draft}
        placeholder={props.host}
        disabled={props.disabled}
        onChange={e => setDraft(e.currentTarget.value)}
        onBlur={commit}
        onKeyDown={e => {
          if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur(); }
        }}
      />
      <datalist id="tz-common">
        {COMMON_TIMEZONES.map(z => <option key={z} value={z} />)}
      </datalist>
      <small>{tr('settings.scheduleTimeZoneHelp', { host: props.host, effective })}</small>
    </label>
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
        <strong>{props.title}</strong>
        <HelpText text={props.help} />
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
    inner = <p className="empty">{tr('update.loading')}</p>;
  } else {
    const s = props.status;
    const updateDisabled = s.localDevInstall || props.busy;
    inner = (
      <>
        <p className="update-version">
          <span className="st-update-label">{tr('update.current')}</span>
          <strong className="st-update-ver">v{s.current}</strong>
          <UpdateBadge status={s} />
        </p>
        {!s.node.ok ? <p className="hint-warn">{tr('update.nodeWarn', { version: s.node.version, required: s.node.required })}</p> : null}
        {s.localDevInstall ? <p className="hint-warn">{tr('update.localDev')}</p> : null}
        {s.installs.multiple ? <MultiInstallWarning entries={s.installs.entries} /> : null}
        <div className="update-actions">
          <button type="button" data-up="check" disabled={props.busy} onClick={props.onCheck}>{tr('update.btnCheck')}</button>
          <button type="button" data-up="changelog" disabled={props.busy} onClick={props.onToggleChangelog}>
            {props.changelogOpen ? tr('update.btnChangelogHide') : tr('update.btnChangelog')}
          </button>
          <button type="button" className="primary" data-up="update" disabled={updateDisabled} onClick={props.onUpdate}>{tr('update.btnUpdate')}</button>
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
    <SectionCard icon="update" title={tr('update.section')}>
      {inner}
    </SectionCard>
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
  if (props.changelog === null) return <p className="empty">{tr('update.changelogLoading')}</p>;
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
