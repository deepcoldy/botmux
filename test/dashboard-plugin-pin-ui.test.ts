import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const app = readFileSync(new URL('../src/dashboard/web/app.tsx', import.meta.url), 'utf-8');
const dashboard = readFileSync(new URL('../src/dashboard.ts', import.meta.url), 'utf-8');
const pluginPage = readFileSync(new URL('../src/dashboard/web/plugin-page.ts', import.meta.url), 'utf-8');
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

  it('shows global and per-Bot enable settings inside every plugin card', () => {
    expect(pluginPage).toContain("'全局启用'");
    expect(pluginPage).toContain('plugin-enable-list');
    expect(pluginPage).toContain('bots.map(bot =>');
    expect(pluginPage).toContain("const scope = input.dataset.pluginToggle ?? 'global'");
    expect(pluginPage).not.toContain('data-plugin-scope');
    expect(pluginPage).not.toContain('配置范围');
    expect(css).toContain('.plugin-enable-panel');
    expect(css).toContain('.plugin-enable-row-global');
    expect(css).toMatch(/\.plugin-enable-list \.plugin-enable-row\s*\{[^}]*padding:\s*11px 24px/s);
    expect(dashboard).toContain('onlineByAppId.get(bot.larkAppId)?.botName');
  });

  it('keeps dependency and mutation failures on the page in a modal', () => {
    expect(pluginPage).toContain('data-plugin-feedback-dialog');
    expect(pluginPage).toContain('showPluginFeedback(');
    expect(pluginPage).toContain("enabled ? '无法启用插件' : '无法禁用插件'");
    expect(pluginPage).not.toContain('插件设置保存失败：');
    expect(css).toContain('.plugin-feedback-dialog::backdrop');
  });
});
