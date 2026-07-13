import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type ReactNode,
} from 'react';
import { PLUGIN_PINS_CHANGED_EVENT } from './plugin-events.js';
import { mountReactPage, type PageDisposer } from './react-mount.js';

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
  gatewayAdapters?: GatewayAdapterReport[];
  mcpDiagnostics?: GatewayServerDiagnostic[];
}

interface PluginBotScope {
  id: string;
  name: string;
  plugins: string[];
}

interface PluginManagementPayload {
  plugins: ManagedPlugin[];
  globalPlugins: string[];
  bots: PluginBotScope[];
  gatewayAdapters: GatewayAdapterReport[];
}

interface PluginFeedback {
  title: string;
  message: string;
}

type PluginServiceAction = 'start' | 'stop' | 'restart';
type PendingToggles = ReadonlyMap<string, boolean>;
type PluginDashboardApi = ReturnType<typeof pluginDashboardApi>;
type PluginDashboardComponent = ComponentType<{ pluginId: string; api: PluginDashboardApi }>;

async function fetchPluginEntries(): Promise<DashboardPluginEntry[]> {
  const res = await fetch('/api/plugins/dashboard');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.json();
  return Array.isArray(body?.plugins) ? body.plugins : [];
}

function normalizePluginManagementPayload(body: any): PluginManagementPayload {
  return {
    plugins: Array.isArray(body?.plugins) ? body.plugins : [],
    globalPlugins: Array.isArray(body?.globalPlugins) ? body.globalPlugins : [],
    bots: Array.isArray(body?.bots) ? body.bots : [],
    gatewayAdapters: Array.isArray(body?.gatewayAdapters) ? body.gatewayAdapters : [],
  };
}

async function fetchPluginManagement(): Promise<PluginManagementPayload> {
  const res = await fetch('/api/plugins');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return normalizePluginManagementPayload(await res.json());
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
  return normalizePluginManagementPayload(body);
}

async function putPluginPin(pluginId: string, pinned: boolean): Promise<PluginManagementPayload> {
  const res = await fetch(`/api/plugins/${encodeURIComponent(pluginId)}/pin`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pinned }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return normalizePluginManagementPayload(await res.json());
}

async function postServiceAction(pluginId: string, action: PluginServiceAction): Promise<PluginManagementPayload> {
  const res = await fetch(`/api/plugins/${encodeURIComponent(pluginId)}/services/${action}`, { method: 'POST' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return normalizePluginManagementPayload(await res.json());
}

function Tags(props: { values?: readonly string[] }): JSX.Element {
  if (!props.values?.length) return <span className="plugin-muted">-</span>;
  return <>{props.values.map(value => <span className="plugin-chip" key={value}>{value}</span>)}</>;
}

function InlineCode(props: { children: ReactNode }): JSX.Element {
  return <code className="plugin-inline-code">{props.children}</code>;
}

function InfoRows(props: { rows: Array<{ label: string; content: ReactNode }> }): JSX.Element {
  if (props.rows.length === 0) return <div className="plugin-empty-state">暂无内容</div>;
  return (
    <div className="plugin-info-table">
      {props.rows.map((row, index) => (
        <div className="plugin-info-row" key={`${row.label}:${index}`}>
          <span>{row.label}</span>
          <div>{row.content}</div>
        </div>
      ))}
    </div>
  );
}

function PanelHeading(props: { title: string; description: string }): JSX.Element {
  return (
    <div className="plugin-tab-panel-head">
      <h3>{props.title}</h3>
      <p>{props.description}</p>
    </div>
  );
}

function EmptyPanel(props: { children: ReactNode }): JSX.Element {
  return <div className="plugin-empty-state">{props.children}</div>;
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

function ServiceAccessLink(props: { url?: string; health?: boolean }): JSX.Element {
  if (!props.url) return <span className="plugin-muted">{props.health ? '无健康检查' : '暂无访问地址'}</span>;
  return (
    <a
      className={`plugin-link${props.health ? '' : ' plugin-service-url'}`}
      href={props.url}
      target="_blank"
      rel="noreferrer"
    >
      {props.health ? '健康检查' : props.url}
    </a>
  );
}

function ServiceDetails(props: { plugin: ManagedPlugin }): JSX.Element {
  const { plugin } = props;
  if (!plugin.service) return <EmptyPanel>这个插件没有需要单独启动的后台进程。</EmptyPanel>;
  const report = plugin.serviceReport;
  const rows: Array<{ label: string; content: ReactNode }> = [
    {
      label: '状态',
      content: <span className={`plugin-status ${serviceStatusClass(report)}`}>{serviceDisplayLabel(report)}</span>,
    },
    { label: '模式', content: <Tags values={[serviceModeLabel(plugin.service)]} /> },
    { label: '生命周期', content: <span>{serviceLifecycleLabel(plugin.service)}</span> },
    { label: '端口', content: report?.port ? <InlineCode>{report.port}</InlineCode> : <span className="plugin-muted">未上报</span> },
    { label: 'PID', content: report?.pid ? <InlineCode>{report.pid}</InlineCode> : <span className="plugin-muted">未上报</span> },
    { label: '访问地址', content: <ServiceAccessLink url={report?.openUrl} /> },
    { label: '健康检查', content: <ServiceAccessLink url={report?.healthUrl} health /> },
  ];
  return (
    <>
      <InfoRows rows={rows} />
      {report?.warning ? <div className="plugin-warning">{report.warning}</div> : null}
    </>
  );
}

function ServiceActions(props: {
  plugin: ManagedPlugin;
  busy: boolean;
  onAction(action: PluginServiceAction): void;
}): JSX.Element | null {
  const { plugin } = props;
  if (!plugin.service) return null;
  const report = plugin.serviceReport;
  return (
    <section className="plugin-action-group">
      <div className="plugin-action-head">
        <span>Service</span>
        <strong>{serviceModeLabel(plugin.service)}</strong>
        <span className={`plugin-status ${serviceStatusClass(report)}`}>{serviceDisplayLabel(report)}</span>
      </div>
      <div className="plugin-action-meta">
        {report?.port ? <span>端口 {report.port}</span> : null}
        {report?.pid ? <span>PID {report.pid}</span> : null}
        <ServiceAccessLink url={report?.openUrl} />
      </div>
      <div className="plugin-service-actions">
        {(['start', 'stop', 'restart'] as const).map(action => (
          <button
            type="button"
            className="btn-link"
            data-plugin-service={plugin.id}
            data-action={action}
            disabled={props.busy}
            onClick={() => props.onAction(action)}
            key={action}
          >
            {action === 'start' ? '启动' : action === 'stop' ? '停止' : '重启'}
          </button>
        ))}
      </div>
    </section>
  );
}

function DashboardActions(props: { plugin: ManagedPlugin }): JSX.Element | null {
  const entries = props.plugin.dashboard ?? [];
  if (entries.length === 0) return null;
  return (
    <section className="plugin-action-group">
      <div className="plugin-action-head">
        <span>Dashboard</span>
        <strong>{entries.length} 个页面</strong>
      </div>
      <div className="plugin-action-links">
        {entries.map(entry => <a className="btn-link primary" href={entry.route} key={entry.id}>打开 {entry.id}</a>)}
      </div>
    </section>
  );
}

function PluginActionArea(props: {
  plugin: ManagedPlugin;
  busy: boolean;
  onServiceAction(action: PluginServiceAction): void;
}): JSX.Element | null {
  const hasService = Boolean(props.plugin.service);
  const hasDashboard = (props.plugin.dashboard?.length ?? 0) > 0;
  if (!hasService && !hasDashboard) return null;
  return (
    <div className="plugin-action-area" aria-label={`${props.plugin.id} 插件操作`}>
      <div className="plugin-action-title">
        <span>操作</span>
        <small>固定操作区，下面的 tab 只展示信息</small>
      </div>
      <div className="plugin-action-grid">
        <ServiceActions plugin={props.plugin} busy={props.busy} onAction={props.onServiceAction} />
        <DashboardActions plugin={props.plugin} />
      </div>
    </div>
  );
}

function TabPanel(props: { id: string; active: boolean; children: ReactNode }): JSX.Element {
  return (
    <section
      className={`plugin-tab-panel${props.active ? ' is-active' : ''}`}
      role="tabpanel"
      data-plugin-panel={props.id}
    >
      {props.children}
    </section>
  );
}

function SkillsPanel(props: { plugin: ManagedPlugin; active: boolean }): JSX.Element {
  const skills = props.plugin.contributions?.skills ?? [];
  const rows = skills.map(skill => ({
    label: skill.name || skill.path || 'skill',
    content: skill.path ? <InlineCode>{skill.path}</InlineCode> : <span className="plugin-muted">未声明路径</span>,
  }));
  return (
    <TabPanel id="skills" active={props.active}>
      <PanelHeading title="Skills" description="每次真正启动或重启 CLI 进程时，都会按当前 Bot 的有效插件集刷新这些技能；运行中的 CLI 不热更新。" />
      {rows.length > 0 ? <InfoRows rows={rows} /> : <EmptyPanel>这个插件没有提供 Skills。</EmptyPanel>}
    </TabPanel>
  );
}

function McpPanel(props: { plugin: ManagedPlugin; active: boolean }): JSX.Element {
  const plugin = props.plugin;
  const server = plugin.contributions?.mcp;
  const serverRows: Array<{ label: string; content: ReactNode }> = server ? [{
    label: server.name || 'mcp',
    content: (
      <div className="plugin-info-stack">
        <div>
          <span>{server.transport === 'streamable-http' ? '服务地址' : '启动命令'}</span>
          <InlineCode>{server.transport === 'streamable-http' ? server.url || '-' : server.command?.join(' ') || '-'}</InlineCode>
        </div>
        <div><span>传输</span><Tags values={[server.transport || 'stdio']} /></div>
        <div><span>环境变量</span><Tags values={Object.keys(server.env ?? {})} /></div>
        {Object.keys(server.headers ?? {}).length > 0
          ? <div><span>请求头</span><Tags values={Object.keys(server.headers ?? {})} /></div>
          : null}
      </div>
    ),
  }] : [];
  const gatewayRows = (plugin.gatewayAdapters ?? []).map(adapter => ({
    label: adapter.cliId,
    content: (
      <div className="plugin-info-stack">
        <div>
          <span>Gateway</span>
          <Tags values={[
            adapter.state === 'configured' || adapter.state === 'unchanged' || adapter.state === 'installed'
              ? '已接入'
              : adapter.state === 'adapter-required' ? '待适配' : '未写入',
          ]} />
        </div>
        {adapter.configPath ? <div><span>配置目标</span><InlineCode>{adapter.configPath}</InlineCode></div> : null}
        {adapter.warning ? <div className="plugin-warning">{adapter.warning}</div> : null}
      </div>
    ),
  }));
  const diagnosticRows = (plugin.mcpDiagnostics ?? []).map(item => ({
    label: item.serverName,
    content: (
      <div className="plugin-info-stack">
        <div><span>最近连接</span><Tags values={[item.status === 'connected' ? '正常' : '失败', item.transport]} /></div>
        <div><span>能力数量</span><Tags values={[`Tools ${item.tools ?? 0}`, `Prompts ${item.prompts ?? 0}`, `Resources ${item.resources ?? 0}`]} /></div>
        {item.sessionId ? <div><span>会话</span><InlineCode>{item.sessionId}</InlineCode></div> : null}
        {item.error ? <div className="plugin-warning">{item.error}</div> : null}
      </div>
    ),
  }));
  return (
    <TabPanel id="mcp" active={props.active}>
      <PanelHeading title="MCP" description="CLI 只连接一个 Botmux Gateway；每一代 CLI 进程按启动时清单连接这些下游 MCP。" />
      {gatewayRows.length > 0 ? <InfoRows rows={gatewayRows} /> : null}
      {diagnosticRows.length > 0 ? <InfoRows rows={diagnosticRows} /> : null}
      {serverRows.length > 0 ? <InfoRows rows={serverRows} /> : <EmptyPanel>这个插件没有提供 MCP server。</EmptyPanel>}
    </TabPanel>
  );
}

function CliPanel(props: { plugin: ManagedPlugin; active: boolean }): JSX.Element {
  const cli = props.plugin.contributions?.cli;
  const rows: Array<{ label: string; content: ReactNode }> = [
    ...(cli?.entry ? [{ label: '入口文件', content: <InlineCode>{cli.entry}</InlineCode> }] : []),
    ...(cli?.commands ?? []).map(command => ({
      label: command.name,
      content: command.description ? <span>{command.description}</span> : <span className="plugin-muted">无描述</span>,
    })),
  ];
  return (
    <TabPanel id="cli" active={props.active}>
      <PanelHeading title="CLI 命令" description="启用插件后，这些命令会进入 botmux 的命令路由。" />
      {rows.length > 0 ? <InfoRows rows={rows} /> : <EmptyPanel>这个插件没有提供 CLI 命令。</EmptyPanel>}
    </TabPanel>
  );
}

function DashboardPanel(props: { plugin: ManagedPlugin; active: boolean }): JSX.Element {
  const rows = (props.plugin.dashboard ?? []).map(entry => ({
    label: entry.id,
    content: (
      <div className="plugin-info-stack">
        <div><span>路由</span><InlineCode>{entry.route}</InlineCode></div>
        <div><span>入口</span><InlineCode>{entry.entry}</InlineCode></div>
      </div>
    ),
  }));
  return (
    <TabPanel id="dashboard" active={props.active}>
      <PanelHeading title="Dashboard" description="插件自己的可视化页面会在这里暴露入口。" />
      {rows.length > 0 ? <InfoRows rows={rows} /> : <EmptyPanel>这个插件没有提供 Dashboard 页面。</EmptyPanel>}
    </TabPanel>
  );
}

function ServicePanel(props: { plugin: ManagedPlugin; active: boolean }): JSX.Element {
  return (
    <TabPanel id="service" active={props.active}>
      <PanelHeading title="Service" description="插件后台服务的声明、当前状态和访问地址。启动、停止、重启在上方操作区处理。" />
      <ServiceDetails plugin={props.plugin} />
    </TabPanel>
  );
}

function PluginTabs(props: { plugin: ManagedPlugin }): JSX.Element {
  const commands = props.plugin.contributions?.cli?.commands ?? [];
  const tabs = useMemo(() => [
    { id: 'skills', label: 'Skills', count: props.plugin.skillsCount ?? 0, hint: '会话加载' },
    { id: 'mcp', label: 'MCP', count: props.plugin.mcpCount ?? 0, hint: 'Gateway 聚合' },
    { id: 'cli', label: 'CLI 命令', count: commands.length, hint: '命令路由' },
    { id: 'dashboard', label: 'Dashboard', count: props.plugin.dashboard?.length ?? 0, hint: '页面入口' },
    {
      id: 'service',
      label: 'Service',
      count: props.plugin.service ? 1 : 0,
      hint: props.plugin.service ? serviceModeLabel(props.plugin.service) : '无后台进程',
    },
  ], [commands.length, props.plugin.dashboard?.length, props.plugin.mcpCount, props.plugin.service, props.plugin.skillsCount]);
  const [activeTab, setActiveTab] = useState(() => tabs.find(tab => tab.count > 0)?.id ?? 'skills');
  return (
    <div className="plugin-tabs">
      <div className="plugin-tab-list" role="tablist" aria-label={`${props.plugin.id} 插件能力`}>
        {tabs.map(tab => (
          <button
            type="button"
            className={`plugin-tab-button${activeTab === tab.id ? ' is-active' : ''}`}
            role="tab"
            aria-selected={activeTab === tab.id}
            data-plugin-tab={tab.id}
            onClick={() => setActiveTab(tab.id)}
            key={tab.id}
          >
            <strong>{tab.count}</strong>
            <span>{tab.label}</span>
            <small>{tab.hint}</small>
          </button>
        ))}
      </div>
      <div className="plugin-tab-panels">
        <SkillsPanel plugin={props.plugin} active={activeTab === 'skills'} />
        <McpPanel plugin={props.plugin} active={activeTab === 'mcp'} />
        <CliPanel plugin={props.plugin} active={activeTab === 'cli'} />
        <DashboardPanel plugin={props.plugin} active={activeTab === 'dashboard'} />
        <ServicePanel plugin={props.plugin} active={activeTab === 'service'} />
      </div>
    </div>
  );
}

function toggleKey(pluginId: string, scope: string): string {
  return `${pluginId}:${scope}`;
}

function pluginEnabledInScope(plugin: ManagedPlugin, scope: string, pendingToggles: PendingToggles): boolean {
  const pending = pendingToggles.get(toggleKey(plugin.id, scope));
  if (pending !== undefined) return pending;
  if (scope === 'global') return plugin.enabledGlobal === true;
  return plugin.enabledByBot?.[scope] === true;
}

function PluginEnableRow(props: {
  plugin: ManagedPlugin;
  scope: string;
  label: string;
  hint: string;
  checked: boolean;
  busy: boolean;
  onToggle(scope: string, enabled: boolean): void;
}): JSX.Element {
  return (
    <label className="toggle-row plugin-enable-row">
      <span className="plugin-enable-copy">
        <strong>{props.label}</strong>
        <small>{props.hint}</small>
      </span>
      <input
        type="checkbox"
        data-plugin-toggle={props.scope}
        data-plugin-id={props.plugin.id}
        checked={props.checked}
        disabled={props.busy}
        onChange={event => props.onToggle(props.scope, event.currentTarget.checked)}
      />
      <span className="switch" aria-hidden="true"></span>
    </label>
  );
}

function PluginGlobalSetting(props: {
  plugin: ManagedPlugin;
  bots: PluginBotScope[];
  pendingToggles: PendingToggles;
  busy: boolean;
  onToggle(scope: string, enabled: boolean): void;
}): JSX.Element {
  const enabled = pluginEnabledInScope(props.plugin, 'global', props.pendingToggles);
  return (
    <label className="toggle-row plugin-global-setting">
      <span className="plugin-global-setting-copy">
        <strong>全局启用</strong>
        <small>{enabled
          ? `已对全部 ${props.bots.length} 个 Bot 启用`
          : '关闭时可展开卡片，按 Bot 单独启用'}</small>
      </span>
      <input
        type="checkbox"
        data-plugin-toggle="global"
        data-plugin-id={props.plugin.id}
        checked={enabled}
        disabled={props.busy}
        onChange={event => props.onToggle('global', event.currentTarget.checked)}
      />
      <span className="switch" aria-hidden="true"></span>
    </label>
  );
}

function PluginBotSettings(props: {
  plugin: ManagedPlugin;
  bots: PluginBotScope[];
  pendingToggles: PendingToggles;
  busy: boolean;
  onToggle(scope: string, enabled: boolean): void;
}): JSX.Element {
  const { plugin, bots, pendingToggles } = props;
  const enabledBotCount = bots.filter(bot => pluginEnabledInScope(plugin, bot.id, pendingToggles)).length;
  return (
    <section className="plugin-enable-panel" aria-label={`${plugin.displayName || plugin.id} 按 Bot 启用`}>
      <div className="plugin-enable-panel-head">
        <div>
          <strong>按 Bot 启用</strong>
          <small>全局关闭时，可为需要此插件的 Bot 单独开启；新启动的 CLI 会话生效。</small>
        </div>
        <span>{enabledBotCount}/{bots.length} 个 Bot 已启用</span>
      </div>
      <div className="plugin-enable-list">
        {bots.map(bot => {
          const checked = pluginEnabledInScope(plugin, bot.id, pendingToggles);
          const enabledState = checked ? '已启用' : '未启用';
          return (
            <PluginEnableRow
              plugin={plugin}
              scope={bot.id}
              label={bot.name}
              hint={`当前${enabledState}`}
              checked={checked}
              busy={props.busy}
              onToggle={props.onToggle}
              key={bot.id}
            />
          );
        })}
        {bots.length === 0 ? <div className="plugin-enable-empty">暂无已配置 Bot</div> : null}
      </div>
    </section>
  );
}

function PluginCapabilitySummary(props: {
  plugin: ManagedPlugin;
  globalEnabled: boolean;
  enabledBotCount: number;
  botCount: number;
}): JSX.Element {
  const commands = props.plugin.contributions?.cli?.commands ?? [];
  const capabilities = [
    { label: 'Skills', count: props.plugin.skillsCount ?? 0 },
    { label: 'MCP', count: props.plugin.mcpCount ?? 0 },
    { label: '命令', count: commands.length },
    { label: 'Dashboard', count: props.plugin.dashboard?.length ?? 0 },
  ].filter(item => item.count > 0);
  return (
    <div className="plugin-card-summary">
      <div className="plugin-capability-summary" aria-label="插件能力摘要">
        {capabilities.map(item => (
          <span className="plugin-capability-chip" key={item.label}><strong>{item.count}</strong>{item.label}</span>
        ))}
        {props.plugin.service ? (
          <span className={`plugin-capability-chip ${serviceStatusClass(props.plugin.serviceReport)}`}>
            Service {serviceDisplayLabel(props.plugin.serviceReport)}
          </span>
        ) : null}
        {capabilities.length === 0 && !props.plugin.service ? <span className="plugin-muted">未声明扩展能力</span> : null}
      </div>
      <span className="plugin-scope-summary">
        {props.globalEnabled
          ? `全部 ${props.botCount} 个 Bot`
          : `${props.enabledBotCount}/${props.botCount} 个 Bot 单独启用`}
      </span>
    </div>
  );
}

function FeedbackDialog(props: { feedback: PluginFeedback | null; onClose(): void }): JSX.Element {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (props.feedback && !dialog.open) {
      try { dialog.showModal(); } catch { dialog.setAttribute('open', ''); }
    } else if (!props.feedback && dialog.open) {
      dialog.close();
    }
  }, [props.feedback]);
  return (
    <dialog
      className="plugin-feedback-dialog"
      data-plugin-feedback-dialog
      ref={dialogRef}
      onClose={props.onClose}
      onClick={event => {
        if (event.target === event.currentTarget) props.onClose();
      }}
    >
      <article>
        <header>
          <span className="plugin-feedback-mark" aria-hidden="true">!</span>
          <div>
            <p>插件设置未保存</p>
            <h2 data-plugin-feedback-title>{props.feedback?.title ?? '操作失败'}</h2>
          </div>
        </header>
        <p className="plugin-feedback-message" data-plugin-feedback-message>{props.feedback?.message}</p>
        <footer><button type="button" className="btn-link" data-plugin-feedback-close onClick={props.onClose}>知道了</button></footer>
      </article>
    </dialog>
  );
}

function PluginCard(props: {
  plugin: ManagedPlugin;
  bots: PluginBotScope[];
  pendingToggles: PendingToggles;
  pendingPin?: boolean;
  busy: boolean;
  onToggle(scope: string, enabled: boolean): void;
  onPin(pinned: boolean): void;
  onServiceAction(action: PluginServiceAction): void;
}): JSX.Element {
  const { plugin } = props;
  const [expanded, setExpanded] = useState(false);
  const title = plugin.displayName || plugin.id;
  const depIds = plugin.dependencies ?? [];
  const enabledGlobal = pluginEnabledInScope(plugin, 'global', props.pendingToggles);
  const enabledBotCount = props.bots.filter(bot => pluginEnabledInScope(plugin, bot.id, props.pendingToggles)).length;
  const enabledAnywhere = enabledGlobal || enabledBotCount > 0;
  const globalTogglePending = props.pendingToggles.has(toggleKey(plugin.id, 'global'));
  const hasDashboard = (plugin.dashboard?.length ?? 0) > 0;
  const pinned = props.pendingPin ?? plugin.pinnedToSidebar === true;
  const detailsId = `plugin-details-${plugin.id}`;
  return (
    <article className={`bd-card plugin-card${expanded ? ' is-expanded' : ' is-collapsed'}`} data-plugin-card={plugin.id}>
      <header className="plugin-card-head">
        <div className="plugin-title-block">
          <div className="plugin-title-row">
            <h2>{title}</h2>
            <span className={`plugin-status ${enabledAnywhere ? 'plugin-status-ok' : 'plugin-status-idle'}`}>
              {enabledGlobal ? '全局已启用' : enabledBotCount > 0 ? `${enabledBotCount} 个 Bot 已启用` : '未启用'}
            </span>
          </div>
          <p>
            <code>{plugin.id}</code>
            <span>{plugin.packageName}@{plugin.version}</span>
            {depIds.length > 0 ? <span>依赖 {depIds.join(', ')}</span> : null}
          </p>
        </div>
        <button
          type="button"
          className="btn-link plugin-expand-button"
          data-plugin-expand={plugin.id}
          aria-expanded={expanded}
          aria-controls={detailsId}
          onClick={() => setExpanded(current => !current)}
        >
          {expanded ? '收起详情' : '展开详情'}
        </button>
      </header>
      <PluginGlobalSetting
        plugin={plugin}
        bots={props.bots}
        pendingToggles={props.pendingToggles}
        busy={props.busy}
        onToggle={props.onToggle}
      />
      <PluginCapabilitySummary
        plugin={plugin}
        globalEnabled={enabledGlobal}
        enabledBotCount={enabledBotCount}
        botCount={props.bots.length}
      />
      {expanded ? (
        <div className="plugin-card-expanded" id={detailsId}>
          {!enabledGlobal && !globalTogglePending ? (
            <PluginBotSettings
              plugin={plugin}
              bots={props.bots}
              pendingToggles={props.pendingToggles}
              busy={props.busy}
              onToggle={props.onToggle}
            />
          ) : null}
          {globalTogglePending ? <div className="plugin-settings-pending">正在更新全局设置...</div> : null}
          {hasDashboard ? (
            <div className="plugin-card-controls">
              <label className="toggle-row plugin-pin-toggle">
                <input
                  type="checkbox"
                  data-plugin-pin={plugin.id}
                  checked={pinned}
                  disabled={props.busy}
                  onChange={event => props.onPin(event.currentTarget.checked)}
                />
                <span className="switch"></span>
                <span className="toggle-tx">
                  <strong>Pin 到侧栏</strong>
                  <small>{pinned ? '已固定，可从主菜单快速打开' : '固定后可从主菜单快速打开'}</small>
                </span>
              </label>
            </div>
          ) : null}
          <PluginActionArea plugin={plugin} busy={props.busy} onServiceAction={props.onServiceAction} />
          <div className="plugin-card-body"><PluginTabs plugin={plugin} /></div>
        </div>
      ) : null}
    </article>
  );
}

function updateMap<K, V>(source: ReadonlyMap<K, V>, key: K, value: V | undefined): Map<K, V> {
  const next = new Map(source);
  if (value === undefined) next.delete(key);
  else next.set(key, value);
  return next;
}

function updateSet<T>(source: ReadonlySet<T>, value: T, present: boolean): Set<T> {
  const next = new Set(source);
  if (present) next.add(value);
  else next.delete(value);
  return next;
}

function PluginManagementPage(): JSX.Element {
  const [payload, setPayload] = useState<PluginManagementPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [busyPluginIds, setBusyPluginIds] = useState<Set<string>>(() => new Set());
  const [pendingToggles, setPendingToggles] = useState<Map<string, boolean>>(() => new Map());
  const [pendingPins, setPendingPins] = useState<Map<string, boolean>>(() => new Map());
  const [feedback, setFeedback] = useState<PluginFeedback | null>(null);

  const load = useCallback(async () => {
    setRefreshing(true);
    setError(null);
    try {
      setPayload(await fetchPluginManagement());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const setPluginBusy = useCallback((pluginId: string, busy: boolean) => {
    setBusyPluginIds(current => updateSet(current, pluginId, busy));
  }, []);

  const handleToggle = useCallback(async (pluginId: string, scope: string, enabled: boolean) => {
    const key = toggleKey(pluginId, scope);
    setPendingToggles(current => updateMap(current, key, enabled));
    setPluginBusy(pluginId, true);
    try {
      const next = await putPluginToggle(pluginId, enabled, scope);
      setPayload(next);
    } catch (err) {
      setFeedback({
        title: enabled ? '无法启用插件' : '无法禁用插件',
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setPendingToggles(current => updateMap(current, key, undefined));
      setPluginBusy(pluginId, false);
    }
  }, [setPluginBusy]);

  const handlePin = useCallback(async (pluginId: string, pinned: boolean) => {
    setPendingPins(current => updateMap(current, pluginId, pinned));
    setPluginBusy(pluginId, true);
    try {
      const next = await putPluginPin(pluginId, pinned);
      setPayload(next);
      window.dispatchEvent(new Event(PLUGIN_PINS_CHANGED_EVENT));
    } catch (err) {
      setFeedback({ title: '无法更新侧栏固定', message: err instanceof Error ? err.message : String(err) });
    } finally {
      setPendingPins(current => updateMap(current, pluginId, undefined));
      setPluginBusy(pluginId, false);
    }
  }, [setPluginBusy]);

  const handleServiceAction = useCallback(async (pluginId: string, action: PluginServiceAction) => {
    setPluginBusy(pluginId, true);
    try {
      const next = await postServiceAction(pluginId, action);
      setPayload(next);
    } catch (err) {
      setFeedback({ title: 'Service 操作失败', message: err instanceof Error ? err.message : String(err) });
    } finally {
      setPluginBusy(pluginId, false);
    }
  }, [setPluginBusy]);

  if (!payload && !error) return <section className="page"><div className="empty">Loading plugins...</div></section>;
  if (!payload) {
    return <section className="page"><div className="bd-card empty">插件列表加载失败：{error}</div></section>;
  }

  const enabledGlobalCount = payload.plugins.filter(plugin => pluginEnabledInScope(plugin, 'global', pendingToggles)).length;
  return (
    <section className="page plugin-management-page">
      <div className="page-heading">
        <div>
          <h1>插件</h1>
          <p>卡片默认展示启用范围与能力摘要；展开后可管理单个 Bot、Service 和详细能力。全局启用对所有 Bot 生效，改动在新启动的 CLI 会话中生效。</p>
        </div>
        <div className="plugin-heading-actions">
          <button type="button" className="btn-link" data-plugin-refresh disabled={refreshing} onClick={() => void load()}>
            {refreshing ? '刷新中...' : '刷新'}
          </button>
        </div>
      </div>
      <div className="plugin-summary-grid">
        <div className="bd-card plugin-summary-card"><span>已安装</span><strong>{payload.plugins.length}</strong></div>
        <div className="bd-card plugin-summary-card"><span>全局启用</span><strong data-plugin-summary-enabled>{enabledGlobalCount}</strong></div>
      </div>
      {payload.plugins.length === 0 ? (
        <div className="bd-card empty">暂无已安装插件。用 <code>botmux plugin install</code> 安装后会出现在这里。</div>
      ) : (
        <div className="plugin-card-list">
          {payload.plugins.map(plugin => (
            <PluginCard
              key={plugin.id}
              plugin={plugin}
              bots={payload.bots}
              pendingToggles={pendingToggles}
              pendingPin={pendingPins.get(plugin.id)}
              busy={busyPluginIds.has(plugin.id)}
              onToggle={(scope, enabled) => void handleToggle(plugin.id, scope, enabled)}
              onPin={pinned => void handlePin(plugin.id, pinned)}
              onServiceAction={action => void handleServiceAction(plugin.id, action)}
            />
          ))}
        </div>
      )}
      <FeedbackDialog feedback={feedback} onClose={() => setFeedback(null)} />
    </section>
  );
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

function PluginDashboardRoute(props: { hash: string }): JSX.Element {
  const [entry, setEntry] = useState<DashboardPluginEntry | null>(null);
  const [Component, setComponent] = useState<PluginDashboardComponent | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setEntry(null);
    setComponent(null);
    setError(null);
    void (async () => {
      try {
        const entries = await fetchPluginEntries();
        const matched = entries.find(item => (
          props.hash === item.route
          || props.hash.startsWith(`${item.route}/`)
          || props.hash.startsWith(`${item.route}?`)
        ));
        if (!matched) throw new Error(`Plugin page not found: ${props.hash}`);
        const mod = await import(/* @vite-ignore */ matched.url);
        if (typeof mod.default !== 'function') throw new Error('plugin_dashboard_default_export_not_function');
        if (cancelled) return;
        setEntry(matched);
        setComponent(() => mod.default as PluginDashboardComponent);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => { cancelled = true; };
  }, [props.hash]);

  const api = useMemo(() => entry ? pluginDashboardApi(entry.pluginId) : null, [entry]);
  if (error) return <section className="page"><div className="bd-card empty">插件 Dashboard 加载失败：{error}</div></section>;
  if (!entry || !Component || !api) return <section className="page"><div className="empty">Loading plugin...</div></section>;
  const title = entry.displayName || entry.pluginId;
  return (
    <section className="page plugin-page">
      <div className="plugin-dashboard-shell">
        <div className="plugin-dashboard-toolbar">
          <a className="btn-link plugin-dashboard-back" href="#/plugins">返回插件列表</a>
        </div>
        <div className="page-heading plugin-dashboard-heading">
          <div>
            <p className="plugin-dashboard-kicker">Plugin Dashboard</p>
            <h1>{title}</h1>
            <p><code>{entry.pluginId}</code><span>/</span><code>{entry.id}</code></p>
          </div>
        </div>
        <div className="plugin-dashboard-content" data-plugin-dashboard-root>
          <Component pluginId={entry.pluginId} api={api} />
        </div>
      </div>
    </section>
  );
}

function PluginRoutePage(): JSX.Element {
  const hash = location.hash || '#/plugins';
  if (hash === '#/plugins' || hash.startsWith('#/plugins?')) return <PluginManagementPage />;
  return <PluginDashboardRoute hash={hash} />;
}

export function renderPluginPage(root: HTMLElement): PageDisposer {
  return mountReactPage(root, <PluginRoutePage />);
}
