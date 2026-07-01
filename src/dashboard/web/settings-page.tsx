import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useT } from './react-hooks.js';
import { mountReactPage, type PageDisposer } from './react-mount.js';

interface MaintenanceTaskCfg { enabled?: boolean; time?: string }
interface MaintenanceCfg { autoUpdate?: MaintenanceTaskCfg; autoRestart?: MaintenanceTaskCfg }

interface DashboardSettings {
  publicReadOnly: boolean;
  openTerminalInFeishu: boolean;
  chatBotDiscovery: boolean;
  repoPickerMode: 'all' | 'repos';
  maintenance: MaintenanceCfg;
  localDevInstall: boolean;
  whiteboard: { enabled: boolean };
  remoteAccess: boolean;
}

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
    repoPickerMode: s?.repoPickerMode === 'repos' ? 'repos' : 'all',
    maintenance: (s?.maintenance && typeof s.maintenance === 'object') ? s.maintenance : {},
    localDevInstall: s?.localDevInstall === true,
    whiteboard: { enabled: s?.whiteboard?.enabled === true },
    remoteAccess: s?.remoteAccess === true,
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
      if (!r.ok || body.ok === false) throw new Error(body?.error ?? `HTTP ${r.status}`);
      setSettings(parseSettings(body.settings));
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

  const settingsBody = settings ? (
    <SettingsBody
      settings={settings}
      canWrite={canWrite}
      bound={bound}
      savingKey={savingKey}
      message={settingsMsg}
      onSave={saveSettings}
    />
  ) : loadError ? (
    <p className="hint-warn">{tr('settings.loadFailed')}: {loadError}</p>
  ) : (
    <p className="empty">{tr('settings.loading')}</p>
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
    </section>
  );
}

function SettingsBody(props: {
  settings: DashboardSettings;
  canWrite: boolean;
  bound: boolean;
  savingKey: string | null;
  message: StatusMessage;
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

  return (
    <div className="settings-grid">
      <article className="bd-card settings-card">
        {canWrite ? null : <p className="hint-warn">{tr('settings.readOnlyVisitor')}</p>}
        <section className="bd-section">
          <h3 className="bd-section-title">{tr('settings.sectionAccess')}</h3>
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
        </section>
        <section className="bd-section">
          <h3 className="bd-section-title">{tr('settings.sectionCards')}</h3>
          <ToggleRow
            title={tr('settings.openTerminalInFeishu')}
            help={tr('settings.openTerminalInFeishuHelp')}
            checked={settings.openTerminalInFeishu}
            disabled={dis || savingKey === 'openTerminalInFeishu'}
            onChange={value => saveBoolean('openTerminalInFeishu', value)}
          />
        </section>
        <section className="bd-section">
          <h3 className="bd-section-title">{tr('settings.sectionExperimental')}</h3>
          <ToggleRow
            title={tr('settings.chatBotDiscovery')}
            help={tr('settings.chatBotDiscoveryHelp')}
            checked={settings.chatBotDiscovery}
            disabled={dis || savingKey === 'chatBotDiscovery'}
            onChange={value => saveBoolean('chatBotDiscovery', value)}
          />
        </section>
        <section className="bd-section">
          <h3 className="bd-section-title">本地白板</h3>
          <ToggleRow
            title="启用项目白板"
            help="默认关闭。开启只启用能力，不会立即创建白板；首次需要时才按群+项目 ensure。"
            checked={settings.whiteboard.enabled}
            disabled={dis || savingKey === 'whiteboard'}
            onChange={value => {
              void props.onSave('whiteboard', { whiteboard: { enabled: value } }, s => ({ ...s, whiteboard: { enabled: value } }));
            }}
          />
        </section>
        <section className="bd-section">
          <h3 className="bd-section-title">{tr('settings.sectionRepoPicker')}</h3>
          <label className="form-row">
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
            <small>{tr('settings.repoPickerModeHelp')}</small>
          </label>
        </section>
        <section className="bd-section">
          <h3 className="bd-section-title">{tr('settings.sectionMaintenance')}</h3>
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
              {tr('settings.maintenanceTime')}
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
        </section>
        <div className="actions settings-actions">
          <span className={`oncall-status ${props.message?.cls ?? ''}`} data-settings-status>{props.message?.text ?? ''}</span>
        </div>
      </article>
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
        <strong>{props.title}</strong>
        <small>{props.help}</small>
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
          <span>{tr('update.current')}: <strong>v{s.current}</strong></span>{' '}
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
    <div className="settings-grid">
      <article className="bd-card settings-card">
        <section className="bd-section">
          <h3 className="bd-section-title">{tr('update.section')}</h3>
          {inner}
        </section>
      </article>
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
