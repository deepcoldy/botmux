import { escapeHtml, t } from './ui.js';

interface MaintenanceTaskCfg { enabled?: boolean; time?: string }
interface MaintenanceCfg { autoUpdate?: MaintenanceTaskCfg; autoRestart?: MaintenanceTaskCfg }

interface DashboardSettings {
  publicReadOnly: boolean;
  openTerminalInFeishu: boolean;
  repoPickerMode: 'all' | 'repos';
  maintenance: MaintenanceCfg;
  localDevInstall: boolean;
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
}
