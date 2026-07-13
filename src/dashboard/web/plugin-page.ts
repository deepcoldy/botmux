import { createElement } from 'react';
import { mountReactPage, type PageDisposer } from './react-mount.js';
import { PLUGIN_PINS_CHANGED_EVENT } from './plugin-events.js';
import { escapeHtml } from './ui.js';

interface DashboardPluginEntry {
  pluginId: string;
  id: string;
  route: string;
  url: string;
  displayName?: string;
  pinned?: boolean;
}

interface PluginServiceDeclaration {
  mode?: 'manual' | 'auto' | string;
}

interface PluginServiceReport {
  pluginId: string;
  action: string;
  mode?: 'manual' | 'auto' | string;
  status?: string;
  pid?: number;
  port?: number;
  warning?: string;
  openUrl?: string;
  healthUrl?: string;
}

interface PluginSkillContribution {
  name?: string;
  path?: string;
}

interface PluginMcpContribution {
  name?: string;
  transport?: string;
  command?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

interface PluginCliCommand {
  name: string;
  description?: string;
}

interface GatewayAdapterReport {
  cliId: string;
  state: 'installed' | 'unchanged' | 'configured' | 'removed' | 'absent' | 'adapter-required';
  configPath?: string;
  warning?: string;
}

interface GatewayServerDiagnostic {
  pluginId: string;
  serverName: string;
  status: 'connected' | 'failed';
  transport: string;
  error?: string;
  tools?: number;
  prompts?: number;
  resources?: number;
  sessionId?: string;
  generatedAt?: string;
}

interface ManagedPlugin {
  id: string;
  packageName: string;
  version: string;
  displayName?: string;
  contributions?: {
    skills?: PluginSkillContribution[];
    mcp?: PluginMcpContribution;
    dashboard?: Array<{ id: string; route: string; entry: string }>;
    cli?: { entry?: string; commands?: PluginCliCommand[] };
    service?: { entry?: string; mode?: string };
  };
  dependencies?: string[];
  skillsCount?: number;
  mcpCount?: number;
  dashboard?: Array<{ id: string; route: string; entry: string; url: string }>;
  service?: PluginServiceDeclaration;
  serviceReport?: PluginServiceReport;
  pinnedToSidebar?: boolean;
  enabledGlobal?: boolean;
  enabledByBot?: Record<string, boolean>;
  botSource?: Record<string, 'bot' | 'machine-default'>;
  gatewayAdapters?: GatewayAdapterReport[];
  mcpDiagnostics?: GatewayServerDiagnostic[];
}

interface PluginBotScope {
  id: string;
  name: string;
  source: 'bot' | 'machine-default';
  plugins: string[];
}

interface PluginManagementPayload {
  plugins: ManagedPlugin[];
  globalPlugins: string[];
  bots: PluginBotScope[];
  gatewayAdapters: GatewayAdapterReport[];
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
    globalPlugins: Array.isArray(body?.globalPlugins) ? body.globalPlugins : [],
    bots: Array.isArray(body?.bots) ? body.bots : [],
    gatewayAdapters: Array.isArray(body?.gatewayAdapters) ? body.gatewayAdapters : [],
  };
}

async function putPluginToggle(pluginId: string, enabled: boolean, scope: string): Promise<PluginManagementPayload> {
  const suffix = scope === 'global' ? 'global' : `bots/${encodeURIComponent(scope)}`;
  const res = await fetch(`/api/plugins/${encodeURIComponent(pluginId)}/${suffix}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ enabled }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(typeof body?.error === 'string' ? body.error : `HTTP ${res.status}`);
  return {
    plugins: Array.isArray(body?.plugins) ? body.plugins : [],
    globalPlugins: Array.isArray(body?.globalPlugins) ? body.globalPlugins : [],
    bots: Array.isArray(body?.bots) ? body.bots : [],
    gatewayAdapters: Array.isArray(body?.gatewayAdapters) ? body.gatewayAdapters : [],
  };
}

async function putPluginPin(pluginId: string, pinned: boolean): Promise<PluginManagementPayload> {
  const res = await fetch(`/api/plugins/${encodeURIComponent(pluginId)}/pin`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pinned }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.json();
  return {
    plugins: Array.isArray(body?.plugins) ? body.plugins : [],
    globalPlugins: Array.isArray(body?.globalPlugins) ? body.globalPlugins : [],
    bots: Array.isArray(body?.bots) ? body.bots : [],
    gatewayAdapters: Array.isArray(body?.gatewayAdapters) ? body.gatewayAdapters : [],
  };
}

async function postServiceAction(pluginId: string, action: 'start' | 'stop' | 'restart'): Promise<PluginManagementPayload> {
  const res = await fetch(`/api/plugins/${encodeURIComponent(pluginId)}/services/${action}`, { method: 'POST' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.json();
  return {
    plugins: Array.isArray(body?.plugins) ? body.plugins : [],
    globalPlugins: Array.isArray(body?.globalPlugins) ? body.globalPlugins : [],
    bots: Array.isArray(body?.bots) ? body.bots : [],
    gatewayAdapters: Array.isArray(body?.gatewayAdapters) ? body.gatewayAdapters : [],
  };
}

function renderTags(values: readonly string[] | undefined): string {
  if (!values?.length) return '<span class="plugin-muted">-</span>';
  return values.map(value => `<span class="plugin-chip">${escapeHtml(value)}</span>`).join('');
}

function renderInlineCode(value: string): string {
  return `<code class="plugin-inline-code">${escapeHtml(value)}</code>`;
}

function renderInfoRows(rows: Array<{ label: string; content: string }>): string {
  if (rows.length === 0) return '<div class="plugin-empty-state">暂无内容</div>';
  return `
    <div class="plugin-info-table">
      ${rows.map(row => `
        <div class="plugin-info-row">
          <span>${escapeHtml(row.label)}</span>
          <div>${row.content}</div>
        </div>
      `).join('')}
    </div>
  `;
}

function renderPanelHeading(title: string, description: string): string {
  return `
    <div class="plugin-tab-panel-head">
      <h3>${escapeHtml(title)}</h3>
      <p>${escapeHtml(description)}</p>
    </div>
  `;
}

function renderEmptyPanel(text: string): string {
  return `<div class="plugin-empty-state">${escapeHtml(text)}</div>`;
}

function serviceLabel(report?: PluginServiceReport): string {
  if (!report) return 'unknown';
  return report.status || report.action;
}

function serviceDisplayLabel(report?: PluginServiceReport): string {
  const label = serviceLabel(report);
  if (label === 'online' || label === 'started' || label === 'already-running') return '运行中';
  if (label === 'stopped' || label === 'not-running') return '已停止';
  if (label === 'failed') return '异常';
  return '未知';
}

function serviceLifecycleLabel(service: PluginServiceDeclaration): string {
  if (service.mode === 'manual') return '不随 botmux start/stop/restart 自动开关；仍可在这里手动启动、停止、重启';
  if (service.mode === 'auto') return 'botmux start/restart 后自动确保运行；默认 restart 不先停止，--with-plugin 才会先停再启动';
  return '未知生命周期策略';
}

function serviceModeLabel(service: PluginServiceDeclaration): string {
  if (service.mode === 'manual') return '手动开关';
  if (service.mode === 'auto') return '启动后确保运行';
  return '未知模式';
}

function serviceStatusClass(report?: PluginServiceReport): string {
  const label = serviceLabel(report);
  if (label === 'online' || label === 'started' || label === 'already-running') return 'plugin-status-ok';
  if (label === 'stopped' || label === 'not-running') return 'plugin-status-idle';
  if (label === 'failed') return 'plugin-status-bad';
  return 'plugin-status-muted';
}

function renderServiceAccess(plugin: ManagedPlugin): { openUrl: string; healthUrl: string } {
  const report = plugin.serviceReport;
  return {
    openUrl: report?.openUrl
      ? `<a class="plugin-link plugin-service-url" href="${escapeHtml(report.openUrl)}" target="_blank" rel="noreferrer">${escapeHtml(report.openUrl)}</a>`
      : '<span class="plugin-muted">暂无访问地址</span>',
    healthUrl: report?.healthUrl
      ? `<a class="plugin-link" href="${escapeHtml(report.healthUrl)}" target="_blank" rel="noreferrer">健康检查</a>`
      : '<span class="plugin-muted">无健康检查</span>',
  };
}

function renderServiceDetails(plugin: ManagedPlugin): string {
  const service = plugin.service;
  if (!service) {
    return `
      <div class="plugin-empty-state">这个插件没有需要单独启动的后台进程。</div>
    `;
  }
  const report = plugin.serviceReport;
  const warning = report?.warning ? `<div class="plugin-warning">${escapeHtml(report.warning)}</div>` : '';
  const { openUrl, healthUrl } = renderServiceAccess(plugin);
  return `
    ${renderInfoRows([
      {
        label: '状态',
        content: `<span class="plugin-status ${serviceStatusClass(report)}">${escapeHtml(serviceDisplayLabel(report))}</span>`,
      },
      { label: '模式', content: renderTags([serviceModeLabel(service)]) },
      { label: '生命周期', content: `<span>${escapeHtml(serviceLifecycleLabel(service))}</span>` },
      { label: '端口', content: report?.port ? renderInlineCode(String(report.port)) : '<span class="plugin-muted">未上报</span>' },
      { label: 'PID', content: report?.pid ? renderInlineCode(String(report.pid)) : '<span class="plugin-muted">未上报</span>' },
      { label: '访问地址', content: openUrl },
      { label: '健康检查', content: healthUrl },
    ])}
    ${warning}
  `;
}

function renderServiceActions(plugin: ManagedPlugin): string {
  if (!plugin.service) return '';
  const report = plugin.serviceReport;
  const { openUrl } = renderServiceAccess(plugin);
  return `
    <section class="plugin-action-group">
      <div class="plugin-action-head">
        <span>Service</span>
        <strong>${escapeHtml(serviceModeLabel(plugin.service))}</strong>
        <span class="plugin-status ${serviceStatusClass(report)}">${escapeHtml(serviceDisplayLabel(report))}</span>
      </div>
      <div class="plugin-action-meta">
        ${report?.port ? `<span>端口 ${escapeHtml(String(report.port))}</span>` : ''}
        ${report?.pid ? `<span>PID ${escapeHtml(String(report.pid))}</span>` : ''}
        ${openUrl}
      </div>
      <div class="plugin-service-actions">
        <button type="button" class="btn-link" data-plugin-service="${escapeHtml(plugin.id)}" data-action="start">启动</button>
        <button type="button" class="btn-link" data-plugin-service="${escapeHtml(plugin.id)}" data-action="stop">停止</button>
        <button type="button" class="btn-link" data-plugin-service="${escapeHtml(plugin.id)}" data-action="restart">重启</button>
      </div>
    </section>
  `;
}

function renderDashboardActions(plugin: ManagedPlugin): string {
  const entries = plugin.dashboard ?? [];
  if (entries.length === 0) return '';
  return `
    <section class="plugin-action-group">
      <div class="plugin-action-head">
        <span>Dashboard</span>
        <strong>${entries.length} 个页面</strong>
      </div>
      <div class="plugin-action-links">
        ${entries.map(entry => `<a class="btn-link primary" href="${escapeHtml(entry.route)}">打开 ${escapeHtml(entry.id)}</a>`).join('')}
      </div>
    </section>
  `;
}

function renderPluginActionArea(plugin: ManagedPlugin): string {
  const serviceActions = renderServiceActions(plugin);
  const dashboardActions = renderDashboardActions(plugin);
  if (!serviceActions && !dashboardActions) return '';
  return `
    <div class="plugin-action-area" aria-label="${escapeHtml(plugin.id)} 插件操作">
      <div class="plugin-action-title">
        <span>操作</span>
        <small>固定操作区，下面的 tab 只展示信息</small>
      </div>
      <div class="plugin-action-grid">${serviceActions}${dashboardActions}</div>
    </div>
  `;
}

function renderTabButton(tab: string, label: string, count: number, hint: string, active: boolean): string {
  return `
    <button type="button"
      class="plugin-tab-button ${active ? 'is-active' : ''}"
      role="tab"
      aria-selected="${active ? 'true' : 'false'}"
      data-plugin-tab="${escapeHtml(tab)}">
      <strong>${escapeHtml(String(count))}</strong>
      <span>${escapeHtml(label)}</span>
      <small>${escapeHtml(hint)}</small>
    </button>
  `;
}

function renderTabPanel(tab: string, active: boolean, content: string): string {
  return `
    <section class="plugin-tab-panel ${active ? 'is-active' : ''}"
      role="tabpanel"
      data-plugin-panel="${escapeHtml(tab)}">
      ${content}
    </section>
  `;
}

function renderSkillsPanel(plugin: ManagedPlugin, active: boolean): string {
  const skills = plugin.contributions?.skills ?? [];
  const rows = skills.map((skill) => {
    const label = skill.name || skill.path || 'skill';
    return {
      label,
      content: skill.path ? renderInlineCode(skill.path) : '<span class="plugin-muted">未声明路径</span>',
    };
  });
  const body = rows.length > 0
    ? renderInfoRows(rows)
    : renderEmptyPanel('这个插件没有提供 Skills。');
  return renderTabPanel('skills', active, `
    ${renderPanelHeading('Skills', '每次真正启动或重启 CLI 进程时，都会按当前 Bot 的有效插件集刷新这些技能；运行中的 CLI 不热更新。')}
    ${body}
  `);
}

function renderMcpPanel(plugin: ManagedPlugin, active: boolean): string {
  const servers = plugin.contributions?.mcp ? [plugin.contributions.mcp] : [];
  const rows = servers.map((server) => {
    const endpoint = server.transport === 'streamable-http'
      ? server.url || '-'
      : server.command?.join(' ') || '-';
    const envKeys = Object.keys(server.env ?? {});
    const headerKeys = Object.keys(server.headers ?? {});
    return {
      label: server.name || 'mcp',
      content: `
        <div class="plugin-info-stack">
          <div><span>${server.transport === 'streamable-http' ? '服务地址' : '启动命令'}</span>${renderInlineCode(endpoint)}</div>
          <div><span>传输</span>${renderTags([server.transport || 'stdio'])}</div>
          <div><span>环境变量</span>${renderTags(envKeys)}</div>
          ${headerKeys.length ? `<div><span>请求头</span>${renderTags(headerKeys)}</div>` : ''}
        </div>
      `,
    };
  });
  const body = rows.length > 0
    ? renderInfoRows(rows)
    : renderEmptyPanel('这个插件没有提供 MCP server。');
  const gatewayRows = (plugin.gatewayAdapters ?? []).map(adapter => ({
    label: adapter.cliId,
    content: `
      <div class="plugin-info-stack">
        <div><span>Gateway</span>${renderTags([adapter.state === 'configured' || adapter.state === 'unchanged' || adapter.state === 'installed' ? '已接入' : adapter.state === 'adapter-required' ? '待适配' : '未写入'])}</div>
        ${adapter.configPath ? `<div><span>配置目标</span>${renderInlineCode(adapter.configPath)}</div>` : ''}
        ${adapter.warning ? `<div class="plugin-warning">${escapeHtml(adapter.warning)}</div>` : ''}
      </div>
    `,
  }));
  const diagnosticRows = (plugin.mcpDiagnostics ?? []).map(item => ({
    label: item.serverName,
    content: `
      <div class="plugin-info-stack">
        <div><span>最近连接</span>${renderTags([item.status === 'connected' ? '正常' : '失败', item.transport])}</div>
        <div><span>能力数量</span>${renderTags([
          `Tools ${item.tools ?? 0}`,
          `Prompts ${item.prompts ?? 0}`,
          `Resources ${item.resources ?? 0}`,
        ])}</div>
        ${item.sessionId ? `<div><span>会话</span>${renderInlineCode(item.sessionId)}</div>` : ''}
        ${item.error ? `<div class="plugin-warning">${escapeHtml(item.error)}</div>` : ''}
      </div>
    `,
  }));
  return renderTabPanel('mcp', active, `
    ${renderPanelHeading('MCP', 'CLI 只连接一个 Botmux Gateway；每一代 CLI 进程按启动时清单连接这些下游 MCP。')}
    ${gatewayRows.length ? renderInfoRows(gatewayRows) : ''}
    ${diagnosticRows.length ? renderInfoRows(diagnosticRows) : ''}
    ${body}
  `);
}

function renderCliPanel(plugin: ManagedPlugin, active: boolean): string {
  const cli = plugin.contributions?.cli;
  const commands = cli?.commands ?? [];
  const rows: Array<{ label: string; content: string }> = [
    ...(cli?.entry ? [{ label: '入口文件', content: renderInlineCode(cli.entry) }] : []),
    ...commands.map(command => ({
      label: command.name,
      content: command.description
        ? `<span>${escapeHtml(command.description)}</span>`
        : '<span class="plugin-muted">无描述</span>',
    })),
  ];
  const body = rows.length > 0
    ? renderInfoRows(rows)
    : renderEmptyPanel('这个插件没有提供 CLI 命令。');
  return renderTabPanel('cli', active, `
    ${renderPanelHeading('CLI 命令', '启用插件后，这些命令会进入 botmux 的命令路由。')}
    ${body}
  `);
}

function renderDashboardPanel(plugin: ManagedPlugin, active: boolean): string {
  const entries = plugin.dashboard ?? [];
  const rows = entries.map(entry => ({
    label: entry.id,
    content: `
      <div class="plugin-info-stack">
        <div><span>路由</span>${renderInlineCode(entry.route)}</div>
        <div><span>入口</span>${renderInlineCode(entry.entry)}</div>
      </div>
    `,
  }));
  const body = rows.length > 0
    ? renderInfoRows(rows)
    : renderEmptyPanel('这个插件没有提供 Dashboard 页面。');
  return renderTabPanel('dashboard', active, `
    ${renderPanelHeading('Dashboard', '插件自己的可视化页面会在这里暴露入口。')}
    ${body}
  `);
}

function renderServicePanel(plugin: ManagedPlugin, active: boolean): string {
  return renderTabPanel('service', active, `
    ${renderPanelHeading('Service', '插件后台服务的声明、当前状态和访问地址。启动、停止、重启在上方操作区处理。')}
    ${renderServiceDetails(plugin)}
  `);
}

function renderPluginTabs(plugin: ManagedPlugin): string {
  const commands = plugin.contributions?.cli?.commands ?? [];
  const tabs = [
    { id: 'skills', label: 'Skills', count: plugin.skillsCount ?? 0, hint: '会话加载' },
    { id: 'mcp', label: 'MCP', count: plugin.mcpCount ?? 0, hint: 'Gateway 聚合' },
    { id: 'cli', label: 'CLI 命令', count: commands.length, hint: '命令路由' },
    { id: 'dashboard', label: 'Dashboard', count: plugin.dashboard?.length ?? 0, hint: '页面入口' },
    { id: 'service', label: 'Service', count: plugin.service ? 1 : 0, hint: plugin.service ? serviceModeLabel(plugin.service) : '无后台进程' },
  ];
  const activeTab = tabs.find(tab => tab.count > 0)?.id ?? 'skills';
  const isActive = (id: string) => id === activeTab;
  return `
    <div class="plugin-tabs">
      <div class="plugin-tab-list" role="tablist" aria-label="${escapeHtml(plugin.id)} 插件能力">
        ${tabs.map(tab => renderTabButton(tab.id, tab.label, tab.count, tab.hint, isActive(tab.id))).join('')}
      </div>
      <div class="plugin-tab-panels">
        ${renderSkillsPanel(plugin, isActive('skills'))}
        ${renderMcpPanel(plugin, isActive('mcp'))}
        ${renderCliPanel(plugin, isActive('cli'))}
        ${renderDashboardPanel(plugin, isActive('dashboard'))}
        ${renderServicePanel(plugin, isActive('service'))}
      </div>
    </div>
  `;
}

function pluginEnabledInScope(plugin: ManagedPlugin, scope: string): boolean {
  return scope === 'global' ? plugin.enabledGlobal === true : plugin.enabledByBot?.[scope] === true;
}

function renderPluginEnableRow(
  plugin: ManagedPlugin,
  scope: string,
  label: string,
  hint: string,
  sourceLabel: string,
): string {
  const enabled = pluginEnabledInScope(plugin, scope);
  return `
    <label class="toggle-row plugin-enable-row ${scope === 'global' ? 'plugin-enable-row-global' : ''}">
      <span class="plugin-enable-copy">
        <span class="plugin-enable-label">
          <strong>${escapeHtml(label)}</strong>
          <span class="plugin-enable-source">${escapeHtml(sourceLabel)}</span>
        </span>
        <small>${escapeHtml(hint)}</small>
      </span>
      <input type="checkbox"
        data-plugin-toggle="${escapeHtml(scope)}"
        data-plugin-id="${escapeHtml(plugin.id)}"
        ${enabled ? 'checked' : ''}>
      <span class="switch" aria-hidden="true"></span>
    </label>
  `;
}

function renderPluginEnableSettings(plugin: ManagedPlugin, bots: PluginBotScope[]): string {
  const enabledBotCount = bots.filter(bot => pluginEnabledInScope(plugin, bot.id)).length;
  const globalRow = renderPluginEnableRow(
    plugin,
    'global',
    '全局启用',
    '未单独配置插件列表的 Bot 会继承此设置',
    plugin.enabledGlobal ? '已启用' : '未启用',
  );
  const botRows = bots.map(bot => {
    const inherited = plugin.botSource?.[bot.id] === 'machine-default';
    const inheritedState = plugin.enabledGlobal ? '启用' : '未启用';
    return renderPluginEnableRow(
      plugin,
      bot.id,
      bot.name,
      inherited
        ? `当前继承全局${inheritedState}；修改后保存为该 Bot 的独立设置`
        : '该 Bot 使用独立插件列表',
      inherited ? '继承全局' : '独立设置',
    );
  }).join('');
  return `
    <section class="plugin-enable-panel" aria-label="${escapeHtml(plugin.displayName || plugin.id)} 启用设置">
      <div class="plugin-enable-panel-head">
        <div>
          <strong>启用设置</strong>
          <small>全局默认与各 Bot 设置集中展示；修改后，新启动的 CLI 会话生效。</small>
        </div>
        <span>${enabledBotCount}/${bots.length} 个 Bot 已启用</span>
      </div>
      <div class="plugin-enable-list">
        ${globalRow}
        ${botRows || '<div class="plugin-enable-empty">暂无已配置 Bot</div>'}
      </div>
    </section>
  `;
}

function renderPluginFeedbackDialog(): string {
  return `
    <dialog class="plugin-feedback-dialog" data-plugin-feedback-dialog>
      <article>
        <header>
          <span class="plugin-feedback-mark" aria-hidden="true">!</span>
          <div>
            <p>插件设置未保存</p>
            <h2 data-plugin-feedback-title>操作失败</h2>
          </div>
        </header>
        <p class="plugin-feedback-message" data-plugin-feedback-message></p>
        <footer>
          <button type="button" class="btn-link" data-plugin-feedback-close>知道了</button>
        </footer>
      </article>
    </dialog>
  `;
}

function renderPluginCard(plugin: ManagedPlugin, bots: PluginBotScope[]): string {
  const title = plugin.displayName || plugin.id;
  const depIds = plugin.dependencies ?? [];
  const enabledGlobal = plugin.enabledGlobal === true;
  const hasDashboard = (plugin.dashboard?.length ?? 0) > 0;
  return `
    <article class="bd-card plugin-card" data-plugin-card="${escapeHtml(plugin.id)}">
      <header class="plugin-card-head">
        <div class="plugin-title-block">
          <div class="plugin-title-row">
            <h2>${escapeHtml(title)}</h2>
            <span class="plugin-status ${enabledGlobal ? 'plugin-status-ok' : 'plugin-status-idle'}">${enabledGlobal ? '全局已启用' : '全局未启用'}</span>
          </div>
          <p>
            <code>${escapeHtml(plugin.id)}</code>
            <span>${escapeHtml(plugin.packageName)}@${escapeHtml(plugin.version)}</span>
            ${depIds.length > 0 ? `<span>依赖 ${depIds.map(dep => escapeHtml(dep)).join(', ')}</span>` : ''}
          </p>
        </div>
        ${hasDashboard ? `
          <div class="plugin-card-controls">
            <label class="toggle-row plugin-pin-toggle">
              <input type="checkbox"
                data-plugin-pin="${escapeHtml(plugin.id)}"
                ${plugin.pinnedToSidebar ? 'checked' : ''}>
              <span class="switch"></span>
              <span class="toggle-tx">
                <strong>Pin 到侧栏</strong>
                <small>${plugin.pinnedToSidebar ? '已固定，可从主菜单快速打开' : '固定后可从主菜单快速打开'}</small>
              </span>
            </label>
          </div>
        ` : ''}
      </header>
      ${renderPluginEnableSettings(plugin, bots)}
      ${renderPluginActionArea(plugin)}
      <div class="plugin-card-body">
        ${renderPluginTabs(plugin)}
      </div>
    </article>
  `;
}

function renderPluginManagementHtml(payload: PluginManagementPayload): string {
  const count = payload.plugins.length;
  const enabledGlobalCount = payload.plugins.filter(plugin => plugin.enabledGlobal === true).length;
  return `
    <section class="page plugin-management-page">
      <div class="page-heading">
        <div>
          <h1>插件</h1>
          <p>每张插件卡片直接展示全局与各 Bot 的启用设置。改动不会热插拔正在运行的 CLI；重启该 CLI 会话后，Skills 与 MCP 会一起刷新。</p>
        </div>
        <div class="plugin-heading-actions">
          <button type="button" class="btn-link" data-plugin-refresh>刷新</button>
        </div>
      </div>
      <div class="plugin-summary-grid">
        <div class="bd-card plugin-summary-card"><span>已安装</span><strong>${count}</strong></div>
        <div class="bd-card plugin-summary-card"><span>全局启用</span><strong>${enabledGlobalCount}</strong></div>
      </div>
      ${count === 0
        ? '<div class="bd-card empty">暂无已安装插件。用 <code>botmux plugin install</code> 安装后会出现在这里。</div>'
        : `<div class="plugin-card-list">${payload.plugins.map(plugin => renderPluginCard(plugin, payload.bots)).join('')}</div>`}
      ${renderPluginFeedbackDialog()}
    </section>
  `;
}

function setPluginControlsDisabled(root: HTMLElement, disabled: boolean): void {
  root.querySelectorAll<HTMLInputElement | HTMLButtonElement>('[data-plugin-toggle], [data-plugin-pin], [data-plugin-service], [data-plugin-refresh]')
    .forEach(el => { el.disabled = disabled; });
}

function showPluginFeedback(root: HTMLElement, title: string, message: string): void {
  const dialog = root.querySelector<HTMLDialogElement>('[data-plugin-feedback-dialog]');
  if (!dialog) return;
  const titleNode = dialog.querySelector<HTMLElement>('[data-plugin-feedback-title]');
  const messageNode = dialog.querySelector<HTMLElement>('[data-plugin-feedback-message]');
  if (titleNode) titleNode.textContent = title;
  if (messageNode) messageNode.textContent = message;
  if (!dialog.open) {
    try { dialog.showModal(); } catch { dialog.setAttribute('open', ''); }
  }
  dialog.querySelector<HTMLButtonElement>('[data-plugin-feedback-close]')?.focus();
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

  const feedbackDialog = root.querySelector<HTMLDialogElement>('[data-plugin-feedback-dialog]');
  feedbackDialog?.querySelector<HTMLButtonElement>('[data-plugin-feedback-close]')?.addEventListener('click', () => feedbackDialog.close());
  feedbackDialog?.addEventListener('click', (event) => {
    if (event.target === feedbackDialog) feedbackDialog.close();
  });

  for (const button of root.querySelectorAll<HTMLButtonElement>('button[data-plugin-tab]')) {
    button.addEventListener('click', () => {
      const tab = button.dataset.pluginTab;
      const card = button.closest<HTMLElement>('[data-plugin-card]');
      if (!tab || !card) return;
      for (const item of card.querySelectorAll<HTMLButtonElement>('button[data-plugin-tab]')) {
        const active = item === button;
        item.classList.toggle('is-active', active);
        item.setAttribute('aria-selected', active ? 'true' : 'false');
      }
      for (const panel of card.querySelectorAll<HTMLElement>('[data-plugin-panel]')) {
        panel.classList.toggle('is-active', panel.dataset.pluginPanel === tab);
      }
    });
  }

  for (const input of root.querySelectorAll<HTMLInputElement>('input[data-plugin-toggle]')) {
    input.addEventListener('change', async () => {
      const pluginId = input.dataset.pluginId ?? '';
      const scope = input.dataset.pluginToggle ?? 'global';
      const enabled = input.checked;
      setPluginControlsDisabled(root, true);
      try {
        const next = await putPluginToggle(pluginId, enabled, scope);
        await refresh(next);
      } catch (err) {
        input.checked = !enabled;
        setPluginControlsDisabled(root, false);
        showPluginFeedback(
          root,
          enabled ? '无法启用插件' : '无法禁用插件',
          err instanceof Error ? err.message : String(err),
        );
      }
    });
  }

  for (const input of root.querySelectorAll<HTMLInputElement>('input[data-plugin-pin]')) {
    input.addEventListener('change', async () => {
      const pluginId = input.dataset.pluginPin ?? '';
      const pinned = input.checked;
      setPluginControlsDisabled(root, true);
      try {
        const next = await putPluginPin(pluginId, pinned);
        window.dispatchEvent(new Event(PLUGIN_PINS_CHANGED_EVENT));
        await refresh(next);
      } catch (err) {
        input.checked = !pinned;
        setPluginControlsDisabled(root, false);
        showPluginFeedback(root, '无法更新侧栏固定', err instanceof Error ? err.message : String(err));
      }
    });
  }

  for (const button of root.querySelectorAll<HTMLButtonElement>('button[data-plugin-service]')) {
    button.addEventListener('click', async () => {
      const pluginId = button.dataset.pluginService ?? '';
      const action = button.dataset.action === 'stop' ? 'stop' : button.dataset.action === 'restart' ? 'restart' : 'start';
      setPluginControlsDisabled(root, true);
      try {
        const next = await postServiceAction(pluginId, action);
        await refresh(next);
      } catch (err) {
        setPluginControlsDisabled(root, false);
        showPluginFeedback(root, 'Service 操作失败', err instanceof Error ? err.message : String(err));
      }
    });
  }
}

async function renderPluginManagementPage(root: HTMLElement, isDisposed: () => boolean): Promise<void> {
  root.innerHTML = `<section class="page"><div class="empty">Loading plugins...</div></section>`;
  try {
    const payload = await fetchPluginManagement();
    if (isDisposed()) return;
    root.innerHTML = renderPluginManagementHtml(payload);
    wirePluginManagement(root);
  } catch (err) {
    if (isDisposed()) return;
    root.innerHTML = `<section class="page"><div class="bd-card empty">插件列表加载失败：${escapeHtml(err instanceof Error ? err.message : String(err))}</div></section>`;
  }
}

function pluginDashboardApi(pluginId: string) {
  return {
    async getServiceStatus() {
      const payload = await fetchPluginManagement();
      return payload.plugins.find(plugin => plugin.id === pluginId)?.serviceReport;
    },
    async startService() {
      return postServiceAction(pluginId, 'start');
    },
    async stopService() {
      return postServiceAction(pluginId, 'stop');
    },
    async restartService() {
      return postServiceAction(pluginId, 'restart');
    },
  };
}

export function renderPluginPage(root: HTMLElement): PageDisposer {
  let disposed = false;
  let disposePlugin: PageDisposer | null = null;
  const isDisposed = () => disposed;
  void (async () => {
    const hash = location.hash || '#/plugins';
    if (hash === '#/plugins' || hash.startsWith('#/plugins?')) {
      await renderPluginManagementPage(root, isDisposed);
      return;
    }
    root.innerHTML = `<section class="page"><div class="empty">Loading plugin...</div></section>`;
    const entries = await fetchPluginEntries();
    if (disposed) return;
    const entry = entries.find(item => hash === item.route || hash.startsWith(`${item.route}/`) || hash.startsWith(`${item.route}?`));
    if (!entry) {
      root.innerHTML = `<section class="page"><div class="empty">Plugin page not found: ${escapeHtml(hash)}</div></section>`;
      return;
    }
    const title = entry.displayName || entry.pluginId;
    root.innerHTML = `
      <section class="page plugin-page">
        <div class="plugin-dashboard-shell">
          <div class="plugin-dashboard-toolbar">
            <a class="btn-link plugin-dashboard-back" href="#/plugins">返回插件列表</a>
          </div>
          <div class="page-heading plugin-dashboard-heading">
            <div>
              <p class="plugin-dashboard-kicker">Plugin Dashboard</p>
              <h1>${escapeHtml(title)}</h1>
              <p><code>${escapeHtml(entry.pluginId)}</code><span>/</span><code>${escapeHtml(entry.id)}</code></p>
            </div>
          </div>
          <div class="plugin-dashboard-content" data-plugin-dashboard-root></div>
        </div>
      </section>
    `;
    try {
      const mod = await import(/* @vite-ignore */ entry.url);
      if (disposed) return;
      const Component = mod.default;
      if (typeof Component !== 'function') throw new Error('plugin_dashboard_default_export_not_function');
      const mount = root.querySelector<HTMLElement>('[data-plugin-dashboard-root]');
      if (!mount) throw new Error('plugin_dashboard_mount_not_found');
      disposePlugin = mountReactPage(mount, createElement(Component, { pluginId: entry.pluginId, api: pluginDashboardApi(entry.pluginId) }));
    } catch (err) {
      if (disposed) return;
      const mount = root.querySelector<HTMLElement>('[data-plugin-dashboard-root]');
      if (mount) {
        mount.innerHTML = `<div class="bd-card empty">插件 Dashboard 加载失败：${escapeHtml(err instanceof Error ? err.message : String(err))}</div>`;
      }
    }
  })();
  return () => {
    disposed = true;
    if (disposePlugin) disposePlugin();
  };
}
