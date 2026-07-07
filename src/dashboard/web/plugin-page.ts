import { escapeHtml } from './ui.js';

interface DashboardPluginEntry {
  pluginId: string;
  id: string;
  route: string;
  url: string;
  displayName?: string;
}

interface DashboardBotEntry {
  larkAppId: string;
  label: string;
  name?: string;
  cliId?: string;
  online: boolean;
  index: number;
}

interface PluginServiceDeclaration {
  mode?: 'manual' | 'lifecycle' | string;
}

interface PluginServiceReport {
  pluginId: string;
  action: string;
  mode?: 'manual' | 'lifecycle' | string;
  status?: string;
  pid?: number;
  port?: number;
  warning?: string;
  openUrl?: string;
  healthUrl?: string;
}

interface ManagedPlugin {
  id: string;
  packageName: string;
  version: string;
  source?: { type?: string; spec?: string };
  displayName?: string;
  hooks?: string[];
  capabilities?: string[];
  dependencies?: Record<string, string>;
  skillsCount?: number;
  mcpCount?: number;
  dashboard?: Array<{ id: string; route: string; entry: string; url: string }>;
  service?: PluginServiceDeclaration;
  serviceReport?: PluginServiceReport;
  enabledGlobal?: boolean;
  enabledBots?: string[];
}

interface PluginManagementPayload {
  plugins: ManagedPlugin[];
  bots: DashboardBotEntry[];
  globalPlugins: string[];
}

async function fetchPluginEntries(): Promise<DashboardPluginEntry[]> {
  const res = await fetch('/api/plugins/dashboard');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.json();
  return Array.isArray(body?.plugins) ? body.plugins : [];
}

async function fetchPluginManagement(): Promise<PluginManagementPayload> {
  const res = await fetch('/api/plugins');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.json();
  return {
    plugins: Array.isArray(body?.plugins) ? body.plugins : [],
    bots: Array.isArray(body?.bots) ? body.bots : [],
    globalPlugins: Array.isArray(body?.globalPlugins) ? body.globalPlugins : [],
  };
}

async function putPluginToggle(pluginId: string, scope: 'global' | 'bot', enabled: boolean, botId?: string): Promise<PluginManagementPayload> {
  const path = scope === 'global'
    ? `/api/plugins/${encodeURIComponent(pluginId)}/global`
    : `/api/plugins/${encodeURIComponent(pluginId)}/bots/${encodeURIComponent(botId ?? '')}`;
  const res = await fetch(path, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ enabled }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.json();
  return {
    plugins: Array.isArray(body?.plugins) ? body.plugins : [],
    bots: Array.isArray(body?.bots) ? body.bots : [],
    globalPlugins: Array.isArray(body?.globalPlugins) ? body.globalPlugins : [],
  };
}

async function postServiceAction(pluginId: string, action: 'start' | 'stop'): Promise<PluginManagementPayload> {
  const res = await fetch(`/api/plugins/${encodeURIComponent(pluginId)}/services/${action}`, { method: 'POST' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.json();
  return {
    plugins: Array.isArray(body?.plugins) ? body.plugins : [],
    bots: Array.isArray(body?.bots) ? body.bots : [],
    globalPlugins: Array.isArray(body?.globalPlugins) ? body.globalPlugins : [],
  };
}

function renderTags(values: readonly string[] | undefined): string {
  if (!values?.length) return '<span class="plugin-muted">-</span>';
  return values.map(value => `<span class="plugin-chip">${escapeHtml(value)}</span>`).join('');
}

function serviceLabel(report?: PluginServiceReport): string {
  if (!report) return 'unknown';
  if (report.status) return report.status;
  return report.action;
}

function serviceControlLabel(service: PluginServiceDeclaration): string | undefined {
  if (service.mode === 'manual' || service.mode === 'lifecycle') return 'Dashboard/CLI 可手动启停';
  return service.mode;
}

function serviceLifecycleLabel(service: PluginServiceDeclaration): string {
  if (service.mode === 'manual') return '不随 botmux start/stop/restart 自动启停';
  if (service.mode === 'lifecycle') return '随 botmux start 启动；stop/restart 需 --with-plugin 才处理';
  return '未知生命周期策略';
}

function serviceStatusClass(service: PluginServiceDeclaration, report?: PluginServiceReport): string {
  const label = serviceLabel(report);
  if (label === 'online' || label === 'started' || label === 'already-running') return 'plugin-status-ok';
  if (label === 'stopped' || label === 'not-running') return 'plugin-status-idle';
  if (label === 'failed') return 'plugin-status-bad';
  return 'plugin-status-muted';
}

function serviceOpenUrl(report?: PluginServiceReport): string | undefined {
  if (report?.openUrl) return report.openUrl;
  return undefined;
}

function serviceHealthUrl(report?: PluginServiceReport): string | undefined {
  if (report?.healthUrl) return report.healthUrl;
  return undefined;
}

function renderServiceRows(plugin: ManagedPlugin): string {
  const service = plugin.service;
  if (!service) return '<div class="plugin-muted">没有 host service 声明</div>';
  const report = plugin.serviceReport;
  const controllable = service.mode === 'manual' || service.mode === 'lifecycle';
  const label = serviceLabel(report);
    const control = serviceControlLabel(service);
    const lifecycle = serviceLifecycleLabel(service);
    const parts = [
      control ? `control=${control}` : '',
      `lifecycle=${lifecycle}`,
      report?.port ? `port=${report.port}` : '',
      report?.pid ? `pid=${report.pid}` : '',
    ].filter(Boolean);
    const healthUrl = serviceHealthUrl(report);
    const health = healthUrl
      ? `<a class="plugin-link" href="${escapeHtml(healthUrl)}" target="_blank" rel="noreferrer">health</a>`
      : '';
    const openUrl = serviceOpenUrl(report);
    const open = openUrl
      ? `<a class="plugin-link" href="${escapeHtml(openUrl)}" target="_blank" rel="noreferrer">open</a>`
      : '';
    const links = [open, health].filter(Boolean).join(' ');
    const warning = report?.warning
      ? `<div class="plugin-warning">${escapeHtml(report.warning)}</div>`
      : '';
    const actions = controllable
      ? `<div class="plugin-service-actions">
          <button type="button" class="btn-link" data-plugin-service="${escapeHtml(plugin.id)}" data-action="start">Start</button>
          <button type="button" class="btn-link" data-plugin-service="${escapeHtml(plugin.id)}" data-action="stop">Stop</button>
        </div>`
      : '<span class="plugin-muted">未知 service mode</span>';
    return `
      <div class="plugin-service-row">
        <div>
          <div class="plugin-service-title">
            <strong>${escapeHtml(plugin.id)}</strong>
            <span class="plugin-status ${serviceStatusClass(service, report)}">${escapeHtml(label)}</span>
          </div>
          <div class="plugin-service-meta">${escapeHtml(parts.join(' / ') || '-')} ${links}</div>
          ${warning}
        </div>
        ${actions}
      </div>
    `;
}

function renderBotToggles(plugin: ManagedPlugin, bots: DashboardBotEntry[]): string {
  if (bots.length === 0) return '<div class="plugin-muted">还没有 bots.json 配置，先通过 CLI 添加 bot 后再启用插件。</div>';
  const enabled = new Set(plugin.enabledBots ?? []);
  return `
    <div class="plugin-bot-grid">
      ${bots.map(bot => `
        <label class="toggle-row plugin-toggle-row">
          <input type="checkbox"
            data-plugin-toggle="bot"
            data-plugin-id="${escapeHtml(plugin.id)}"
            data-bot-id="${escapeHtml(bot.larkAppId)}"
            ${enabled.has(bot.larkAppId) ? 'checked' : ''}>
          <span class="switch"></span>
          <span class="toggle-tx">
            <strong>${escapeHtml(bot.label)}</strong>
            <small>${escapeHtml([bot.cliId, bot.online ? 'online' : 'offline', bot.larkAppId].filter(Boolean).join(' / '))}</small>
          </span>
        </label>
      `).join('')}
    </div>
  `;
}

function renderPluginCard(plugin: ManagedPlugin, bots: DashboardBotEntry[]): string {
  const title = plugin.displayName || plugin.id;
  const depIds = Object.keys(plugin.dependencies ?? {});
  const dashboardLinks = (plugin.dashboard ?? []).length > 0
    ? plugin.dashboard!.map(entry => `<a class="btn-link primary" href="${escapeHtml(entry.route)}">打开 ${escapeHtml(entry.id)}</a>`).join('')
    : '<span class="plugin-muted">无 dashboard 页面</span>';
  return `
    <article class="bd-card plugin-card" data-plugin-card="${escapeHtml(plugin.id)}">
      <header class="plugin-card-head">
        <div>
          <h2>${escapeHtml(title)}</h2>
          <p><code>${escapeHtml(plugin.id)}</code> · ${escapeHtml(plugin.packageName)}@${escapeHtml(plugin.version)}</p>
        </div>
        <label class="toggle-row plugin-global-toggle">
          <input type="checkbox"
            data-plugin-toggle="global"
            data-plugin-id="${escapeHtml(plugin.id)}"
            ${plugin.enabledGlobal ? 'checked' : ''}>
          <span class="switch"></span>
          <span class="toggle-tx">
            <strong>全局默认</strong>
            <small>对所有 bot 生效</small>
          </span>
        </label>
      </header>
      <div class="plugin-card-body">
        <section class="plugin-section">
          <h3>Bot 启用</h3>
          ${renderBotToggles(plugin, bots)}
        </section>
        <section class="plugin-section">
          <h3>接入能力</h3>
          <div class="plugin-meta-grid">
            <div><span>hooks</span><p>${renderTags(plugin.hooks)}</p></div>
            <div><span>capabilities</span><p>${renderTags(plugin.capabilities)}</p></div>
            <div><span>static</span><p>${renderTags([`skills:${plugin.skillsCount ?? 0}`, `mcp:${plugin.mcpCount ?? 0}`, `dashboard:${plugin.dashboard?.length ?? 0}`])}</p></div>
            <div><span>dependencies</span><p>${renderTags(depIds)}</p></div>
          </div>
        </section>
        <section class="plugin-section">
          <h3>Dashboard</h3>
          <div class="plugin-dashboard-links">${dashboardLinks}</div>
        </section>
        <section class="plugin-section">
          <h3>Service</h3>
          <div class="plugin-service-list">${renderServiceRows(plugin)}</div>
        </section>
      </div>
    </article>
  `;
}

function renderPluginManagementHtml(payload: PluginManagementPayload): string {
  const count = payload.plugins.length;
  return `
    <section class="page plugin-management-page">
      <div class="page-heading">
        <div>
          <h1>插件</h1>
          <p>管理已安装插件的全局默认启用、bot 级启用、dashboard 页面和 host service 状态。</p>
        </div>
        <button type="button" class="btn-link" data-plugin-refresh>刷新</button>
      </div>
      <div class="plugin-summary-grid">
        <div class="bd-card plugin-summary-card"><span>已安装</span><strong>${count}</strong></div>
        <div class="bd-card plugin-summary-card"><span>Bot</span><strong>${payload.bots.length}</strong></div>
        <div class="bd-card plugin-summary-card"><span>全局默认</span><strong>${payload.globalPlugins.length}</strong></div>
      </div>
      ${count === 0
        ? '<div class="bd-card empty">暂无已安装插件。用 <code>botmux plugin install</code> 安装后会出现在这里。</div>'
        : `<div class="plugin-card-list">${payload.plugins.map(plugin => renderPluginCard(plugin, payload.bots)).join('')}</div>`}
    </section>
  `;
}

function wirePluginManagement(root: HTMLElement): void {
  async function refresh(next?: PluginManagementPayload) {
    const payload = next ?? await fetchPluginManagement();
    root.innerHTML = renderPluginManagementHtml(payload);
    wirePluginManagement(root);
  }

  root.querySelector<HTMLButtonElement>('[data-plugin-refresh]')?.addEventListener('click', async () => {
    root.innerHTML = `<section class="page"><div class="empty">Refreshing plugins...</div></section>`;
    await refresh();
  });

  for (const input of root.querySelectorAll<HTMLInputElement>('input[data-plugin-toggle]')) {
    input.addEventListener('change', async () => {
      const pluginId = input.dataset.pluginId ?? '';
      const scope = input.dataset.pluginToggle === 'global' ? 'global' : 'bot';
      const botId = input.dataset.botId;
      const enabled = input.checked;
      root.querySelectorAll<HTMLInputElement | HTMLButtonElement>('[data-plugin-toggle], [data-plugin-service], [data-plugin-refresh]')
        .forEach(el => { el.disabled = true; });
      try {
        const next = await putPluginToggle(pluginId, scope, enabled, botId);
        await refresh(next);
      } catch (err) {
        input.checked = !enabled;
        root.innerHTML = `<section class="page"><div class="bd-card empty">插件设置保存失败：${escapeHtml(err instanceof Error ? err.message : String(err))}</div></section>`;
      }
    });
  }

  for (const button of root.querySelectorAll<HTMLButtonElement>('button[data-plugin-service]')) {
    button.addEventListener('click', async () => {
      const pluginId = button.dataset.pluginService ?? '';
      const action = button.dataset.action === 'stop' ? 'stop' : 'start';
      root.querySelectorAll<HTMLInputElement | HTMLButtonElement>('[data-plugin-toggle], [data-plugin-service], [data-plugin-refresh]')
        .forEach(el => { el.disabled = true; });
      try {
        const next = await postServiceAction(pluginId, action);
        await refresh(next);
      } catch (err) {
        root.innerHTML = `<section class="page"><div class="bd-card empty">Service ${escapeHtml(action)} 失败：${escapeHtml(err instanceof Error ? err.message : String(err))}</div></section>`;
      }
    });
  }
}

async function renderPluginManagementPage(root: HTMLElement): Promise<void> {
  root.innerHTML = `<section class="page"><div class="empty">Loading plugins...</div></section>`;
  try {
    const payload = await fetchPluginManagement();
    root.innerHTML = renderPluginManagementHtml(payload);
    wirePluginManagement(root);
  } catch (err) {
    root.innerHTML = `<section class="page"><div class="bd-card empty">插件列表加载失败：${escapeHtml(err instanceof Error ? err.message : String(err))}</div></section>`;
  }
}

export async function renderPluginPage(root: HTMLElement): Promise<void> {
  const hash = location.hash || '#/plugins';
  if (hash === '#/plugins' || hash.startsWith('#/plugins?')) {
    await renderPluginManagementPage(root);
    return;
  }
  root.innerHTML = `<section class="page"><div class="empty">Loading plugin...</div></section>`;
  const entries = await fetchPluginEntries();
  const entry = entries.find(item => hash === item.route || hash.startsWith(`${item.route}/`) || hash.startsWith(`${item.route}?`));
  if (!entry) {
    root.innerHTML = `<section class="page"><div class="empty">Plugin page not found: ${escapeHtml(hash)}</div></section>`;
    return;
  }
  const title = entry.displayName || entry.pluginId;
  root.innerHTML = `
    <section class="page plugin-page">
      <div class="page-head">
        <div>
          <h1>${escapeHtml(title)}</h1>
          <p>${escapeHtml(entry.pluginId)} / ${escapeHtml(entry.id)}</p>
        </div>
      </div>
      <iframe
        title="${escapeHtml(title)}"
        src="${escapeHtml(entry.url)}"
        style="width:100%;height:calc(100vh - 180px);min-height:520px;border:1px solid var(--border);border-radius:8px;background:var(--surface);"
      ></iframe>
    </section>
  `;
}
