import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const app = readFileSync(new URL('../src/dashboard/web/app.tsx', import.meta.url), 'utf-8');
const dashboard = readFileSync(new URL('../src/dashboard.ts', import.meta.url), 'utf-8');
const pluginPage = readFileSync(new URL('../src/dashboard/web/plugin-page.tsx', import.meta.url), 'utf-8');
const css = readFileSync(new URL('../src/dashboard/web/style.css', import.meta.url), 'utf-8');

describe('dashboard plugin pin UI', () => {
  it('loads only pinned plugin dashboards into the main sidebar', () => {
    expect(app).toContain("fetch('/api/plugins/dashboard')");
    expect(app).toContain('entry.pinned === true');
    expect(app).toContain('pinnedPluginNavItems');
    expect(app).toContain('sidebar-plugin-item');
  });

  it('keeps Pin separate from plugin enablement on each plugin card', () => {
    expect(pluginPage).toContain('data-plugin-pin=');
    expect(pluginPage).toContain('Pin 到侧栏');
    expect(pluginPage).toContain('/pin`');
    expect(pluginPage).toContain('PLUGIN_PINS_CHANGED_EVENT');
    expect(css).toContain('.plugin-card-controls');
    expect(css).toContain('.sidebar-nav a.sidebar-plugin-item');
  });

  it('separates global enablement from per-Bot additions', () => {
    expect(pluginPage).toContain('function PluginGlobalSetting(');
    expect(pluginPage).toContain('<strong>全局启用</strong>');
    expect(pluginPage).toContain('function PluginBotSettings(');
    expect(pluginPage).toContain('!enabledGlobal && !globalTogglePending');
    expect(pluginPage).toContain('plugin-enable-list');
    expect(pluginPage).toContain('bots.map(bot =>');
    expect(pluginPage).toContain('onChange={event => props.onToggle(props.scope, event.currentTarget.checked)}');
    expect(pluginPage).not.toContain('botSource');
    expect(pluginPage).not.toContain('继承全局');
    expect(pluginPage).not.toContain('独立设置');
    expect(pluginPage).not.toContain('data-plugin-scope');
    expect(pluginPage).not.toContain('配置范围');
    expect(css).toContain('.plugin-global-setting');
    expect(css).toContain('.plugin-enable-panel');
    expect(css).toMatch(/\.plugin-enable-list \.plugin-enable-row\s*\{[^}]*padding:\s*11px 24px/s);
    expect(dashboard).toContain('onlineByAppId.get(bot.larkAppId)?.botName');
    expect(pluginPage).toContain('hint={`当前${enabledState}`}');
    expect(pluginPage).not.toContain('`当前${enabledState}，跟随全局设置`');
    expect(pluginPage).not.toContain('`当前${enabledState}，由该 Bot 独立设置`');
  });

  it('collapses cards to key status and capability information', () => {
    expect(pluginPage).toContain('const [expanded, setExpanded] = useState(false);');
    expect(pluginPage).toContain('data-plugin-expand={plugin.id}');
    expect(pluginPage).toContain("expanded ? '收起详情' : '展开详情'");
    expect(pluginPage).toContain('function PluginCapabilitySummary(');
    expect(pluginPage).toContain("className={`bd-card plugin-card${expanded ? ' is-expanded' : ' is-collapsed'}`}");
    expect(pluginPage).toContain('{expanded ? (');
    expect(css).toContain('.plugin-card-summary');
    expect(css).toContain('.plugin-capability-summary');
  });

  it('uses React state to update plugin cards without rebuilding the page DOM', () => {
    expect(pluginPage).toContain('function PluginManagementPage(');
    expect(pluginPage).toContain('useState<PluginManagementPayload | null>');
    expect(pluginPage).toContain('setPayload(next);');
    expect(pluginPage).toContain('key={plugin.id}');
    expect(pluginPage).toContain('function PluginCard(');
    expect(pluginPage).toContain('const [activeTab, setActiveTab] = useState(');
    expect(pluginPage).toContain('data-plugin-summary-enabled');
    expect(pluginPage).not.toContain('innerHTML');
    expect(pluginPage).not.toContain('dangerouslySetInnerHTML');
  });

  it('keeps dependency and mutation failures on the page in a modal', () => {
    expect(pluginPage).toContain('data-plugin-feedback-dialog');
    expect(pluginPage).toContain('setFeedback({');
    expect(pluginPage).toContain("enabled ? '无法启用插件' : '无法禁用插件'");
    expect(pluginPage).not.toContain('插件设置保存失败：');
    expect(css).toContain('.plugin-feedback-dialog::backdrop');
  });
});
