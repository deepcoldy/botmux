import { escapeHtml, t } from './ui.js';

interface MaintenanceTaskCfg { enabled?: boolean; time?: string }
interface MaintenanceCfg { autoUpdate?: MaintenanceTaskCfg; autoRestart?: MaintenanceTaskCfg }

interface DashboardSettings {
  publicReadOnly: boolean;
  openTerminalInFeishu: boolean;
  repoPickerMode: 'all' | 'repos';
  maintenance: MaintenanceCfg;
  localDevInstall: boolean;
  whiteboard: { enabled: boolean };
}

let settings: DashboardSettings | null = null;
let loadError: string | null = null;
// 只读访客（无有效 token 进来的 public-read 连接）看得到设置值但不能改——
// 开关直接禁用并给提示，而不是点了 401 再回滚。
let canWrite = true;

function parseSettings(s: any): DashboardSettings {
  return {
    publicReadOnly: s?.publicReadOnly === true,
    openTerminalInFeishu: s?.openTerminalInFeishu === true,
    repoPickerMode: s?.repoPickerMode === 'repos' ? 'repos' : 'all',
    maintenance: (s?.maintenance && typeof s.maintenance === 'object') ? s.maintenance : {},
    localDevInstall: s?.localDevInstall === true,
    whiteboard: { enabled: s?.whiteboard?.enabled === true },
  };
}

/** Current enabled/time for a task, with a sensible default time. */
function taskUi(m: MaintenanceCfg, key: 'autoUpdate' | 'autoRestart'): { enabled: boolean; time: string } {
  const task = m?.[key] ?? {};
  return { enabled: task.enabled === true, time: typeof task.time === 'string' ? task.time : '04:00' };
}

function pageHtml(): string {
  return `<section class="page">
    <div class="page-heading">
      <div>
        <p class="eyebrow">${t('nav.settings')}</p>
        <h1>${t('settings.title')}</h1>
        <p>${t('settings.subtitle')}</p>
      </div>
    </div>
    <div id="settings-body"></div>
    <div id="update-body"></div>
  </section>`;
}

// Auto-update drives the schedule: toggle + a daily HH:MM time.
function autoUpdateRow(disabled: boolean): string {
  const { enabled, time } = taskUi(settings!.maintenance, 'autoUpdate');
  const dis = disabled ? 'disabled' : '';
  return `<label class="toggle-row">
      <input type="checkbox" data-maint="autoUpdate" ${enabled ? 'checked' : ''} ${dis}>
      <span class="switch" aria-hidden="true"></span>
      <span class="toggle-tx"><strong>${t('settings.autoUpdate')}</strong>
      <small>${t('settings.autoUpdateHelp')}</small></span>
    </label>
    <div class="maint-time">
      <label>${t('settings.maintenanceTime')}
        <input type="time" data-maint-time="autoUpdate" value="${escapeHtml(time)}" ${dis}>
      </label>
    </div>`;
}

// Auto-restart is a dependent toggle (no time of its own): restart to apply an
// auto-update. Disabled unless auto-update is on.
function autoRestartRow(disabled: boolean): string {
  const enabled = settings!.maintenance.autoRestart?.enabled === true;
  const dis = disabled ? 'disabled' : '';
  return `<label class="toggle-row">
      <input type="checkbox" data-maint="autoRestart" ${enabled ? 'checked' : ''} ${dis}>
      <span class="switch" aria-hidden="true"></span>
      <span class="toggle-tx"><strong>${t('settings.autoRestart')}</strong>
      <small>${t('settings.autoRestartHelp')}</small></span>
    </label>`;
}

function renderSettingsBody(): string {
  if (loadError) {
    return `<p class="hint-warn">${t('settings.loadFailed')}: ${escapeHtml(loadError)}</p>`;
  }
  if (!settings) return `<p class="empty">${t('settings.loading')}</p>`;
  const dis = canWrite ? '' : 'disabled';
  const updDisabled = !canWrite || settings.localDevInstall;
  return `<div class="settings-grid">
    <article class="bd-card settings-card">
      ${canWrite ? '' : `<p class="hint-warn">${t('settings.readOnlyVisitor')}</p>`}
      <section class="bd-section">
        <h3 class="bd-section-title">${t('settings.sectionAccess')}</h3>
        <label class="toggle-row">
          <input type="checkbox" data-setting="publicReadOnly" ${settings.publicReadOnly ? 'checked' : ''} ${dis}>
          <span class="switch" aria-hidden="true"></span>
          <span class="toggle-tx"><strong>${t('settings.publicReadOnly')}</strong>
          <small>${t('settings.publicReadOnlyHelp')}</small></span>
        </label>
      </section>
      <section class="bd-section">
        <h3 class="bd-section-title">${t('settings.sectionCards')}</h3>
        <label class="toggle-row">
          <input type="checkbox" data-setting="openTerminalInFeishu" ${settings.openTerminalInFeishu ? 'checked' : ''} ${dis}>
          <span class="switch" aria-hidden="true"></span>
          <span class="toggle-tx"><strong>${t('settings.openTerminalInFeishu')}</strong>
          <small>${t('settings.openTerminalInFeishuHelp')}</small></span>
        </label>
      </section>
      <section class="bd-section">
        <h3 class="bd-section-title">本地白板</h3>
        <label class="toggle-row">
          <input type="checkbox" data-whiteboard-enabled ${settings.whiteboard.enabled ? 'checked' : ''} ${dis}>
          <span class="switch" aria-hidden="true"></span>
          <span class="toggle-tx"><strong>启用项目白板</strong>
          <small>默认关闭。开启只启用能力，不会立即创建白板；首次需要时才按群+项目 ensure。</small></span>
        </label>
      </section>
      <section class="bd-section">
        <h3 class="bd-section-title">${t('settings.sectionRepoPicker')}</h3>
        <label class="form-row">
          <span>${t('settings.repoPickerMode')}</span>
          <select data-select-setting="repoPickerMode" ${dis}>
            <option value="all" ${settings.repoPickerMode === 'all' ? 'selected' : ''}>${t('settings.repoPickerModeAll')}</option>
            <option value="repos" ${settings.repoPickerMode === 'repos' ? 'selected' : ''}>${t('settings.repoPickerModeRepos')}</option>
          </select>
          <small>${t('settings.repoPickerModeHelp')}</small>
        </label>
      </section>
      <section class="bd-section">
        <h3 class="bd-section-title">${t('settings.sectionMaintenance')}</h3>
        ${autoUpdateRow(updDisabled)}
        ${settings.localDevInstall ? `<p class="hint-warn">${t('settings.autoUpdateLocalDev')}</p>` : ''}
        ${autoRestartRow(!canWrite || settings.maintenance.autoUpdate?.enabled !== true)}
      </section>
      <div class="actions settings-actions">
        <span class="oncall-status" data-settings-status></span>
      </div>
    </article>
  </div>`;
}

// ─── Version & update card ──────────────────────────────────────────────────
// A separate card (next to Auto Maintenance) for the manual update flow:
// version check, changelog, update-to-latest (with node + multi-install
// preflight), and a standalone restart. Backed by the authed-only
// /api/update/* endpoints, so read-only visitors only see a login prompt.

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

let upStatus: UpdateStatus | null = null;
let upStatusError: string | null = null;
let upChangelog: ReleaseNote[] | null = null; // null = not loaded yet (loading)
let upChangelogOpen = false;
let upChangelogOk = true;                      // false = fetch failed (offline / rate-limited)
let upChangelogRateLimited = false;
let upReleasesUrl = '';
let upBusy = false;
let upMsg: { text: string; cls: string } | null = null;

function installKindLabel(kind: string): string {
  if (kind === 'npm-global') return t('update.kindNpm');
  if (kind === 'source-checkout') return t('update.kindSource');
  return t('update.kindUnknown');
}

function renderChangelogPanel(): string {
  if (upChangelog === null) return `<p class="empty">${t('update.changelogLoading')}</p>`;
  if (!upChangelogOk) {
    const reason = upChangelogRateLimited ? t('update.changelogRateLimited') : t('update.changelogFailed');
    const link = upReleasesUrl
      ? ` <a href="${escapeHtml(upReleasesUrl)}" target="_blank" rel="noopener">${t('update.changelogViewOnGitHub')}</a>`
      : '';
    return `<p class="hint-warn-inline">${reason}${link}</p>`;
  }
  if (upChangelog.length === 0) return `<p class="empty">${t('update.changelogEmpty')}</p>`;
  return `<div class="update-changelog">${upChangelog.map(r => {
    const title = r.name && r.name !== `v${r.version}` ? r.name : '';
    const date = r.publishedAt ? new Date(r.publishedAt).toLocaleDateString() : '';
    return `<details class="update-release" open>
      <summary><strong>v${escapeHtml(r.version)}</strong> ${escapeHtml(title)} <small>${escapeHtml(date)}</small>
        <a href="${escapeHtml(r.url)}" target="_blank" rel="noopener">↗</a></summary>
      <pre class="update-release-body">${escapeHtml(r.body || '')}</pre>
    </details>`;
  }).join('')}</div>`;
}

function renderUpdateCard(canWrite: boolean): string {
  let inner: string;
  if (!canWrite) {
    inner = `<p class="hint-warn">${t('update.loginRequired')}</p>`;
  } else if (upStatusError) {
    inner = `<p class="hint-warn">${t('update.checkFailed')}: ${escapeHtml(upStatusError)}</p>
      <div class="update-actions"><button type="button" data-up="check">${t('update.btnCheck')}</button></div>`;
  } else if (!upStatus) {
    inner = `<p class="empty">${t('update.loading')}</p>`;
  } else {
    const s = upStatus;
    const badge = s.latest
      ? (s.behind
          ? `<span class="update-badge update-badge-new">${t('update.newAvailable', { version: `v${s.latest}` })}</span>`
          : `<span class="update-badge update-badge-ok">${t('update.upToDate')}</span>`)
      : `<span class="hint-warn-inline">${t('update.checkUnavailable')}</span>`;
    const versionLine = `<p class="update-version"><span>${t('update.current')}: <strong>v${escapeHtml(s.current)}</strong></span> ${badge}</p>`;
    const warnings: string[] = [];
    if (!s.node.ok) warnings.push(`<p class="hint-warn">${t('update.nodeWarn', { version: s.node.version, required: s.node.required })}</p>`);
    if (s.localDevInstall) warnings.push(`<p class="hint-warn">${t('update.localDev')}</p>`);
    if (s.installs.multiple) {
      const list = s.installs.entries
        .map(e => `<li><code>${escapeHtml(e.binPath)}</code> → ${installKindLabel(e.kind)} <small>${escapeHtml(e.root)}</small></li>`)
        .join('');
      warnings.push(`<div class="hint-warn"><p>${t('update.multiInstallWarn')}</p><ul class="update-install-list">${list}</ul></div>`);
    }
    const updateDisabled = s.localDevInstall || upBusy;
    const buttons = `<div class="update-actions">
      <button type="button" data-up="check" ${upBusy ? 'disabled' : ''}>${t('update.btnCheck')}</button>
      <button type="button" data-up="changelog" ${upBusy ? 'disabled' : ''}>${upChangelogOpen ? t('update.btnChangelogHide') : t('update.btnChangelog')}</button>
      <button type="button" class="primary" data-up="update" ${updateDisabled ? 'disabled' : ''}>${t('update.btnUpdate')}</button>
      <button type="button" data-up="restart" ${upBusy ? 'disabled' : ''}>${t('update.btnRestart')}</button>
    </div>`;
    const changelog = upChangelogOpen ? renderChangelogPanel() : '';
    const msg = upMsg ? `<p class="oncall-status ${escapeHtml(upMsg.cls)}">${escapeHtml(upMsg.text)}</p>` : '';
    inner = versionLine + warnings.join('') + buttons + changelog + msg;
  }
  return `<div class="settings-grid">
    <article class="bd-card settings-card">
      <section class="bd-section">
        <h3 class="bd-section-title">${t('update.section')}</h3>
        ${inner}
      </section>
    </article>
  </div>`;
}

function mountUpdateCard(container: HTMLElement, canWrite: boolean): void {
  function rerender(): void {
    container.innerHTML = renderUpdateCard(canWrite);
    wire();
  }
  function setMsg(text: string, cls = ''): void { upMsg = { text, cls }; }

  async function fetchStatus(): Promise<void> {
    try {
      const r = await fetch('/api/update/status');
      const body = await r.json().catch(() => ({}));
      if (!r.ok) { upStatus = null; upStatusError = body?.error ?? `HTTP ${r.status}`; return; }
      upStatus = body as UpdateStatus;
      upStatusError = null;
    } catch (e: any) {
      upStatus = null; upStatusError = e?.message ?? String(e);
    }
  }

  async function loadChangelog(): Promise<void> {
    upChangelog = null; upChangelogOk = true; upChangelogRateLimited = false; rerender();
    try {
      const r = await fetch('/api/update/changelog');
      const body = await r.json().catch(() => ({}));
      upReleasesUrl = typeof body?.releasesUrl === 'string' ? body.releasesUrl : '';
      if (!r.ok) { upChangelog = []; upChangelogOk = false; }
      else {
        upChangelog = Array.isArray(body.releases) ? body.releases : [];
        upChangelogOk = body.ok !== false;
        upChangelogRateLimited = body.rateLimited === true;
      }
    } catch {
      upChangelog = []; upChangelogOk = false;
    }
    rerender();
  }

  function pollReconnect(): void {
    const start = Date.now();
    const tick = async (): Promise<void> => {
      if (Date.now() - start > 90_000) { upBusy = false; setMsg(t('update.restartSlow'), 'hint-warn-inline'); rerender(); return; }
      try {
        const r = await fetch('/__health', { cache: 'no-store' });
        if (r.ok) { location.reload(); return; }
      } catch { /* still down → keep polling */ }
      setTimeout(() => void tick(), 2000);
    };
    // Give the old dashboard a moment to actually go down before polling.
    setTimeout(() => void tick(), 3000);
  }

  async function doRestart(updatePayload: { oldVersion: string; newVersion: string } | null): Promise<void> {
    upBusy = true; setMsg(t('update.restarting')); rerender();
    try {
      await fetch('/api/update/restart', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(updatePayload ? { update: updatePayload } : {}),
      });
    } catch (e: any) {
      upBusy = false; setMsg(t('update.restartFailed', { detail: e?.message ?? e }), 'hint-warn-inline'); rerender(); return;
    }
    pollReconnect();
  }

  async function doUpdate(): Promise<void> {
    const s = upStatus;
    if (!s) return;
    if (!s.node.ok) { window.alert(t('update.nodeTooOldAlert', { version: s.node.version, required: s.node.required })); return; }
    if (s.installs.multiple) {
      const paths = s.installs.entries.map(e => `• ${e.binPath} (${installKindLabel(e.kind)})`).join('\n');
      if (!window.confirm(t('update.confirmMultiInstall', { paths }))) return;
    }
    const confirmMsg = s.latest ? t('update.confirmUpdate', { version: `v${s.latest}` }) : t('update.confirmUpdateNoVer');
    if (!window.confirm(confirmMsg)) return;
    upBusy = true; setMsg(t('update.updating')); rerender();
    try {
      const r = await fetch('/api/update/run', { method: 'POST' });
      const body = await r.json().catch(() => ({}));
      if (!r.ok || body.ok === false) {
        const detail = body?.detail ?? body?.error ?? `HTTP ${r.status}`;
        upBusy = false; setMsg(t('update.updateFailed', { detail }), 'hint-warn-inline'); rerender(); return;
      }
      if (body.changed) {
        upBusy = false;
        setMsg(t('update.updatedChanged', { old: `v${body.oldVersion}`, new: `v${body.newVersion}` }), 'hint-ok'); rerender();
        if (window.confirm(t('update.confirmRestart'))) {
          await doRestart({ oldVersion: body.oldVersion, newVersion: body.newVersion });
        } else {
          setMsg(t('update.noRestartHint'), 'hint-ok'); rerender();
        }
      } else {
        upBusy = false; setMsg(t('update.alreadyLatestRun', { version: `v${body.newVersion}` }), 'hint-ok');
        await fetchStatus(); rerender();
      }
    } catch (e: any) {
      upBusy = false; setMsg(t('update.updateFailed', { detail: e?.message ?? e }), 'hint-warn-inline'); rerender();
    }
  }

  function wire(): void {
    container.querySelectorAll<HTMLButtonElement>('button[data-up]').forEach(btn => {
      btn.addEventListener('click', () => {
        const act = btn.dataset.up;
        if (act === 'check') {
          upStatus = null; upChangelog = null; upChangelogOpen = false; upMsg = null; upStatusError = null;
          rerender(); void fetchStatus().then(rerender);
        } else if (act === 'changelog') {
          upChangelogOpen = !upChangelogOpen;
          if (upChangelogOpen && upChangelog === null) void loadChangelog();
          else rerender();
        } else if (act === 'update') {
          void doUpdate();
        } else if (act === 'restart') {
          if (window.confirm(t('update.confirmPlainRestart'))) void doRestart(null);
        }
      });
    });
  }

  rerender();
  if (canWrite) void fetchStatus().then(rerender);
}

async function fetchSettings(): Promise<void> {
  try {
    const r = await fetch('/api/settings');
    const body = await r.json().catch(() => ({}));
    if (!r.ok) {
      settings = null;
      loadError = body?.error ?? `HTTP ${r.status}`;
      return;
    }
    settings = parseSettings(body.settings);
    canWrite = body.authed === true;
    loadError = null;
  } catch (e: any) {
    settings = null;
    loadError = e?.message ?? String(e);
  }
}

export async function renderSettingsPage(root: HTMLElement): Promise<void> {
  root.innerHTML = pageHtml();
  const bodyEl = root.querySelector<HTMLElement>('#settings-body')!;

  function rerender(): void {
    bodyEl.innerHTML = renderSettingsBody();
    wireSettings();
  }

  function statusEl(): HTMLElement | null {
    return bodyEl.querySelector<HTMLElement>('[data-settings-status]');
  }

  async function putSettings(payload: unknown, revert: () => void, input: HTMLInputElement | HTMLSelectElement): Promise<void> {
    if (!settings) return;
    input.disabled = true;
    const st = statusEl();
    if (st) { st.textContent = t('settings.saving'); st.className = 'oncall-status'; }
    try {
      const r = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok || body.ok === false) throw new Error(body?.error ?? `HTTP ${r.status}`);
      settings = parseSettings(body.settings);
      if (st) { st.textContent = t('settings.saved'); st.classList.add('hint-ok'); }
    } catch (e: any) {
      revert();
      if (st) { st.textContent = `${t('settings.saveFailed')}: ${e?.message ?? e}`; st.classList.add('hint-warn-inline'); }
    } finally {
      input.disabled = false;
    }
  }

  function wireSettings(): void {
    // Flat boolean settings.
    bodyEl.querySelectorAll<HTMLInputElement>('input[data-setting]').forEach(input => {
      input.addEventListener('change', () => {
        const key = input.dataset.setting as 'publicReadOnly' | 'openTerminalInFeishu';
        const before = !input.checked;
        void putSettings({ [key]: input.checked }, () => { input.checked = before; }, input);
      });
    });
    bodyEl.querySelector<HTMLInputElement>('input[data-whiteboard-enabled]')?.addEventListener('change', (ev) => {
      const input = ev.currentTarget as HTMLInputElement;
      const before = !input.checked;
      void putSettings({ whiteboard: { enabled: input.checked } }, () => { input.checked = before; }, input);
    });
    bodyEl.querySelectorAll<HTMLSelectElement>('select[data-select-setting]').forEach(input => {
      input.addEventListener('change', () => {
        const key = input.dataset.selectSetting as 'repoPickerMode';
        const before = settings?.[key] ?? 'all';
        void putSettings({ [key]: input.value }, () => { input.value = before; }, input);
      });
    });
    // Maintenance: auto-update sends {enabled,time}; auto-restart is a toggle ({enabled}).
    const sendMaint = (key: 'autoUpdate' | 'autoRestart', input: HTMLInputElement, revert: () => void) => {
      const toggle = bodyEl.querySelector<HTMLInputElement>(`input[data-maint="${key}"]`);
      const enabled = toggle?.checked ?? false;
      let task: { enabled: boolean; time?: string };
      if (key === 'autoUpdate') {
        const timeEl = bodyEl.querySelector<HTMLInputElement>('input[data-maint-time="autoUpdate"]');
        task = { enabled, time: timeEl?.value || '04:00' };
      } else {
        task = { enabled };
      }
      void putSettings({ maintenance: { [key]: task } }, revert, input).then(() => rerender());
    };
    bodyEl.querySelectorAll<HTMLInputElement>('input[data-maint]').forEach(input => {
      input.addEventListener('change', () => {
        const key = input.dataset.maint as 'autoUpdate' | 'autoRestart';
        const before = !input.checked;
        sendMaint(key, input, () => { input.checked = before; });
      });
    });
    bodyEl.querySelectorAll<HTMLInputElement>('input[data-maint-time]').forEach(input => {
      input.addEventListener('change', () => {
        const key = input.dataset.maintTime as 'autoUpdate' | 'autoRestart';
        const before = input.defaultValue;
        sendMaint(key, input, () => { input.value = before; });
      });
    });
  }

  rerender();
  await fetchSettings();
  rerender();

  // Mount the version & update card (separate lifecycle from the settings PUT
  // form, so a maintenance toggle re-render doesn't wipe its loaded state).
  upBusy = false; upMsg = null; upChangelogOpen = false;
  const updateEl = root.querySelector<HTMLElement>('#update-body')!;
  mountUpdateCard(updateEl, canWrite);
}
