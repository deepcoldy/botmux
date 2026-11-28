import React from 'react';
import TestRenderer, { act, type ReactTestInstance } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  classifyInstalledPluginSource,
  installedPluginSourceLabel,
  installPlanSourceLabel,
  isOfficialMarketPlugin,
  marketEntrySourceLabel,
  PluginManagementPage,
} from '../src/dashboard/web/plugin-page.js';
import type { PluginInstallPlan, PluginMarketEntry } from '../src/dashboard/plugin-market.js';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let renderer: TestRenderer.ReactTestRenderer | undefined;

function textOf(node: ReactTestInstance | string): string {
  if (typeof node === 'string') return node;
  return node.children.map(child => textOf(child as ReactTestInstance | string)).join('');
}

async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve();
  });
}

const officialGithubEntry: PluginMarketEntry = {
  id: 'github',
  package: '@botmux-ai/plugin-github',
  displayName: 'GitHub',
  description: '官方 GitHub 插件，支持 PR 与 Issue 协作',
  repo: 'https://github.com/botmux-ai/botmux-plugin-github',
  docs: 'https://github.com/botmux-ai/botmux-plugin-github#readme',
  categories: ['vcs'],
  compatibility: { botmux: '>=3.56.0' },
  official: true,
  distribution: {
    type: 'github-release',
    repo: 'botmux-ai/botmux-plugin-github',
    assetPattern: 'botmux-plugin-github-*.tgz',
  },
};

const officialByScopeEntry: PluginMarketEntry = {
  id: 'docs-helper',
  package: '@botmux-ai/plugin-docs-helper',
  displayName: 'Docs Helper',
  description: '基于包名前缀识别的官方插件',
  repo: 'https://github.com/botmux-ai/botmux-plugin-docs-helper',
  categories: ['docs'],
  compatibility: { botmux: '>=3.56.0' },
};

const communityEntry: PluginMarketEntry = {
  id: 'community-weather',
  package: 'botmux-plugin-weather',
  displayName: 'Weather',
  description: '社区天气插件',
  repo: 'https://github.com/someone/botmux-plugin-weather',
  categories: ['tools'],
  compatibility: { botmux: '>=3.56.0' },
  distribution: { type: 'npm' },
};

const sampleIntegrity = `sha512-${'A'.repeat(86)}==`;

beforeEach(() => {
  vi.stubGlobal('location', { hash: '#/plugins?view=market', href: 'http://127.0.0.1:9876/#/plugins?view=market', origin: 'http://127.0.0.1:9876' });
  vi.stubGlobal('window', { dispatchEvent: vi.fn(), location: (globalThis as any).location });
});

afterEach(() => {
  if (renderer) {
    act(() => { renderer!.unmount(); });
    renderer = undefined;
  }
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('plugin market helpers', () => {
  it('identifies official plugins, distribution labels and installed source classifications', () => {
    expect(isOfficialMarketPlugin(officialGithubEntry)).toBe(true);
    expect(isOfficialMarketPlugin(officialByScopeEntry)).toBe(true);
    expect(isOfficialMarketPlugin(communityEntry)).toBe(false);

    expect(marketEntrySourceLabel(officialGithubEntry)).toBe('GitHub Release');
    expect(marketEntrySourceLabel(communityEntry)).toBe('npm');
    expect(marketEntrySourceLabel(officialByScopeEntry)).toBe('npm');

    expect(installPlanSourceLabel({
      sourceType: 'github-release',
      releaseRepo: 'botmux-ai/botmux-plugin-github',
      releaseTag: 'v0.1.0',
    })).toBe('GitHub Release (botmux-ai/botmux-plugin-github@v0.1.0)');
    expect(installPlanSourceLabel({ sourceType: 'npm' })).toBe('npm');

    expect(classifyInstalledPluginSource({ source: { type: 'local', spec: '/tmp/p' } })).toBe('local');
    expect(classifyInstalledPluginSource({ source: { type: 'npm', spec: 'foo@1.0.0' } })).toBe('npm');
    expect(classifyInstalledPluginSource({
      source: { type: 'github-release', repo: 'botmux-ai/botmux-plugin-github', tag: 'v0.1.0', asset: 'p.tgz', integrity: sampleIntegrity },
    })).toBe('github-release');
    expect(installedPluginSourceLabel({
      source: { type: 'github-release', repo: 'botmux-ai/botmux-plugin-github', tag: 'v0.1.0' },
    })).toBe('GitHub Release (botmux-ai/botmux-plugin-github@v0.1.0)');
  });
});

describe('PluginManagementPage official market & one-click install experience', () => {
  it('shows official badges, distinguishes official vs community details, installs from card directly, and provides post-install quick jump', async () => {
    const installedPlugins: any[] = [
      {
        id: 'local-tool',
        packageName: '@local/tool',
        version: '1.0.0',
        displayName: 'Local Tool',
        source: { type: 'local', spec: '/tmp/local-tool' },
        stateHash: 'a'.repeat(64),
        enabledGlobal: false,
        enabledByBot: {},
      },
      {
        id: 'docs-helper',
        packageName: '@botmux-ai/plugin-docs-helper',
        version: '1.0.0',
        displayName: 'Docs Helper',
        source: { type: 'npm', spec: '@botmux-ai/plugin-docs-helper@1.0.0' },
        stateHash: 'b'.repeat(64),
        enabledGlobal: false,
        enabledByBot: {},
      },
    ];

    const marketCalls: Array<{ url: string; body?: unknown }> = [];
    const preparedPlan: PluginInstallPlan = {
      nonce: 'nonce-gh-1',
      id: 'github',
      packageName: '@botmux-ai/plugin-github',
      version: '0.1.0',
      integrity: sampleIntegrity,
      sourceType: 'github-release',
      downloadUrl: 'https://github.com/botmux-ai/botmux-plugin-github/releases/download/v0.1.0/botmux-plugin-github-0.1.0.tgz',
      releaseRepo: 'botmux-ai/botmux-plugin-github',
      releaseTag: 'v0.1.0',
      releaseAsset: 'botmux-plugin-github-0.1.0.tgz',
      expiresAt: Date.now() + 300_000,
      expectedState: null,
      expectedRevision: 'c'.repeat(64),
    };

    vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
      marketCalls.push({ url, body });

      if (url === '/api/plugins') {
        return new Response(JSON.stringify({
          plugins: installedPlugins,
          globalPlugins: [],
          bots: [{ id: 'cli_a', name: 'Dev Bot', plugins: [] }],
          gatewayAdapters: [],
        }));
      }
      if (url === '/api/plugins/market') {
        return new Response(JSON.stringify({
          items: [officialGithubEntry, officialByScopeEntry, communityEntry],
          stale: false,
          available: true,
        }));
      }
      if (url === '/api/plugins/market/prepare') {
        return new Response(JSON.stringify({ plan: preparedPlan }));
      }
      if (url === '/api/plugins/market/install') {
        installedPlugins.push({
          id: 'github',
          packageName: '@botmux-ai/plugin-github',
          version: '0.1.0',
          displayName: 'GitHub',
          source: {
            type: 'github-release',
            repo: 'botmux-ai/botmux-plugin-github',
            tag: 'v0.1.0',
            asset: 'botmux-plugin-github-0.1.0.tgz',
            integrity: sampleIntegrity,
          },
          dashboard: [{ id: 'settings', route: '#/plugins/github/settings', entry: 'dashboard/settings.js', url: '/plugins/github/dashboard/settings.js' }],
          stateHash: 'd'.repeat(64),
          enabledGlobal: false,
          enabledByBot: {},
        });
        return new Response(JSON.stringify({ ok: true, result: { id: 'github', version: '0.1.0' } }));
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }));

    await act(async () => {
      renderer = TestRenderer.create(React.createElement(PluginManagementPage));
    });
    await flush();

    // 1. Tab is upgraded to「插件市场」and active when hash has view=market.
    const marketTab = renderer!.root.find(node => node.type === 'button' && node.props['data-plugin-view'] === 'market');
    expect(textOf(marketTab)).toContain('插件市场');
    expect(marketTab.props['aria-selected']).toBe(true);

    // 2. Official badges appear on official:true and @botmux-ai/* entries, not on community entries.
    expect(renderer!.root.findAll(node => node.props['data-official-badge'] === 'github')).toHaveLength(1);
    expect(renderer!.root.findAll(node => node.props['data-official-badge'] === 'docs-helper')).toHaveLength(1);
    expect(renderer!.root.findAll(node => node.props['data-official-badge'] === 'community-weather')).toHaveLength(0);

    // 3. Installed market card shows「已安装」,「管理」and「检查更新」instead of「安装」.
    expect(renderer!.root.findAll(node => node.type === 'button' && node.props['data-market-manage'] === 'docs-helper')).toHaveLength(1);
    expect(renderer!.root.findAll(node => node.type === 'button' && node.props['data-market-update'] === 'docs-helper')).toHaveLength(1);
    expect(renderer!.root.findAll(node => node.type === 'button' && node.props['data-market-install'] === 'docs-helper')).toHaveLength(0);

    // 4. Detail dialog distinguishes Botmux 官方插件 vs 社区插件目录（非安全认证）.
    const officialDetailBtn = renderer!.root.find(node => node.type === 'button' && node.props['data-market-detail'] === 'github');
    await act(async () => { officialDetailBtn.props.onClick(); });
    const detailDialog = renderer!.root.find(node => node.type === 'dialog' && node.props['aria-label'] === 'GitHub');
    expect(textOf(detailDialog)).toContain('Botmux 官方插件');
    expect(textOf(detailDialog)).not.toContain('社区插件目录（非安全认证）');
    expect(textOf(detailDialog)).toContain('GitHub Release');

    const closeBtn = detailDialog.find(node => node.type === 'button' && node.props['aria-label'] === '关闭');
    await act(async () => { closeBtn.props.onClick(); });

    const communityDetailBtn = renderer!.root.find(node => node.type === 'button' && node.props['data-market-detail'] === 'community-weather');
    await act(async () => { communityDetailBtn.props.onClick(); });
    const communityDialog = renderer!.root.find(node => node.type === 'dialog' && node.props['aria-label'] === 'Weather');
    expect(textOf(communityDialog)).toContain('社区插件目录（非安全认证）');
    const closeCommunityBtn = communityDialog.find(node => node.type === 'button' && node.props['aria-label'] === '关闭');
    await act(async () => { closeCommunityBtn.props.onClick(); });

    // 5. Clicking primary「安装」directly on the uninstalled market card triggers prepare and opens confirm modal.
    const directInstallBtn = renderer!.root.find(node => node.type === 'button' && node.props['data-market-install'] === 'github');
    expect(textOf(directInstallBtn)).toBe('安装');
    await act(async () => { directInstallBtn.props.onClick(); });
    await flush();

    expect(marketCalls.some(c => c.url === '/api/plugins/market/prepare' && (c.body as any)?.id === 'github')).toBe(true);
    const confirmDialog = renderer!.root.find(node => node.type === 'dialog' && node.props['aria-label'] === '确认安装');
    const confirmText = textOf(confirmDialog);
    expect(confirmText).toContain('0.1.0');
    expect(confirmText).toContain('GitHub Release (botmux-ai/botmux-plugin-github@v0.1.0)');
    expect(confirmText).toContain(sampleIntegrity);

    // 6. Confirming installation installs the plugin and renders post-install guidance with quick jump.
    const confirmBtn = confirmDialog.find(node => node.type === 'button' && node.props['data-market-confirm-install']);
    await act(async () => { confirmBtn.props.onClick(); });
    await flush();

    expect(marketCalls.some(c => c.url === '/api/plugins/market/install' && (c.body as any)?.nonce === 'nonce-gh-1' && (c.body as any)?.confirm === true)).toBe(true);
    const noticeBanner = renderer!.root.find(node => node.props['data-plugin-notice']);
    expect(textOf(noticeBanner)).toContain('已安装 GitHub (v0.1.0)');
    const openSettingsLink = noticeBanner.find(node => node.type === 'a' && node.props['data-plugin-notice-settings'] === 'github');
    expect(openSettingsLink.props.href).toBe('#/plugins/github/settings');

    // 7. Clicking「前往启用 / 管理」switches to installed view and opens the installed plugin's management dialog.
    const quickJumpBtn = noticeBanner.find(node => node.type === 'button' && node.props['data-plugin-notice-open'] === 'github');
    await act(async () => { quickJumpBtn.props.onClick(); });
    await flush();

    const installedTab = renderer!.root.find(node => node.type === 'button' && node.props['data-plugin-view'] === 'installed');
    expect(installedTab.props['aria-selected']).toBe(true);
    const githubCard = renderer!.root.find(node => node.props['data-plugin-card'] === 'github');
    expect(githubCard).toBeDefined();
    // Management dialog is open with enable toggle controls directly accessible.
    expect(renderer!.root.findAll(node => node.type === 'input' && node.props['data-plugin-id'] === 'github' && node.props['data-plugin-toggle'] === 'global').length).toBeGreaterThan(0);

    // 8. Installed source filter supports local, npm, and github-release independently.
    const sourceSelect = renderer!.root.find(node => node.type === 'select' && node.props['aria-label'] === '安装来源');
    const optionValues = sourceSelect.findAll(node => node.type === 'option').map(opt => opt.props.value);
    expect(optionValues).toEqual(['all', 'local', 'npm', 'github-release']);

    await act(async () => { sourceSelect.props.onChange({ currentTarget: { value: 'github-release' } }); });
    expect(renderer!.root.findAll(node => node.props['data-plugin-card']).map(n => n.props['data-plugin-card'])).toEqual(['github']);

    await act(async () => { sourceSelect.props.onChange({ currentTarget: { value: 'local' } }); });
    expect(renderer!.root.findAll(node => node.props['data-plugin-card']).map(n => n.props['data-plugin-card'])).toEqual(['local-tool']);

    await act(async () => { sourceSelect.props.onChange({ currentTarget: { value: 'npm' } }); });
    expect(renderer!.root.findAll(node => node.props['data-plugin-card']).map(n => n.props['data-plugin-card'])).toEqual(['docs-helper']);
  });

  it('requires an exact catalog match for installed official badges', async () => {
    (globalThis as any).location.hash = '#/plugins';
    const installedPlugins: any[] = [
      {
        id: 'github', packageName: '@evil/different-package', version: '1.0.0', displayName: 'Local GitHub',
        source: { type: 'local', spec: '/tmp/local-github' }, stateHash: 'e'.repeat(64), enabledGlobal: false, enabledByBot: {},
      },
      {
        id: 'self-declared', packageName: '@botmux-ai/fake', version: '1.0.0', displayName: 'Self Declared',
        source: { type: 'local', spec: '/tmp/self-declared' }, stateHash: 'f'.repeat(64), enabledGlobal: false, enabledByBot: {},
      },
    ];
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url === '/api/plugins') {
        return new Response(JSON.stringify({ plugins: installedPlugins, globalPlugins: [], bots: [], gatewayAdapters: [] }));
      }
      if (url === '/api/plugins/market') {
        return new Response(JSON.stringify({ items: [officialGithubEntry], stale: false, available: true }));
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }));

    await act(async () => { renderer = TestRenderer.create(React.createElement(PluginManagementPage)); });
    await flush();
    expect(renderer!.root.findAll(node => node.props['data-official-badge'] === 'github')).toHaveLength(0);
    expect(renderer!.root.findAll(node => node.props['data-official-badge'] === 'self-declared')).toHaveLength(0);

    // The catalog itself remains the trust anchor for its own entries.
    const marketTab = renderer!.root.find(node => node.props['data-plugin-view'] === 'market');
    await act(async () => { marketTab.props.onClick(); });
    expect(renderer!.root.findAll(node => node.props['data-official-badge'] === 'github')).toHaveLength(1);
  });

  it('does not infer plan ownership from the package prefix after the catalog entry disappears', async () => {
    const plan: PluginInstallPlan = {
      nonce: 'nonce-plan-ownership', id: 'github', packageName: '@botmux-ai/plugin-github', version: '0.1.0',
      integrity: sampleIntegrity, sourceType: 'github-release',
      downloadUrl: 'https://github.com/botmux-ai/botmux-plugin-github/releases/download/v0.1.0/botmux-plugin-github-0.1.0.tgz',
      releaseRepo: 'botmux-ai/botmux-plugin-github', releaseTag: 'v0.1.0', releaseAsset: 'botmux-plugin-github-0.1.0.tgz',
      expiresAt: Date.now() + 300_000, expectedState: null, expectedRevision: 'a'.repeat(64),
    };
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url === '/api/plugins') {
        return new Response(JSON.stringify({ plugins: [], globalPlugins: [], bots: [], gatewayAdapters: [] }));
      }
      if (url === '/api/plugins/market') {
        return new Response(JSON.stringify({ items: [officialGithubEntry], stale: false, available: true }));
      }
      if (url === '/api/plugins/market/prepare') return new Response(JSON.stringify({ plan }));
      if (url === '/api/plugins/market/refresh') {
        return new Response(JSON.stringify({ items: [], stale: false, available: true }));
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }));

    await act(async () => { renderer = TestRenderer.create(React.createElement(PluginManagementPage)); });
    await flush();
    const install = renderer!.root.find(node => node.props['data-market-install'] === 'github');
    await act(async () => { install.props.onClick(); });
    await flush();
    const refresh = renderer!.root.find(node => node.props['data-plugin-refresh']);
    await act(async () => { refresh.props.onClick(); });
    await flush();

    const confirmDialog = renderer!.root.find(node => node.type === 'dialog' && node.props['aria-label'] === '确认安装');
    expect(confirmDialog.findAll(node => node.props.className === 'plugin-official-badge')).toHaveLength(0);
    expect(textOf(confirmDialog)).toContain('社区目录收录不代表安全认证');
    expect(textOf(confirmDialog)).not.toContain('Botmux 官方插件');
  });

  it('omits post-install quick actions when the refreshed plugin record is unavailable', async () => {
    let installed = false;
    const plan: PluginInstallPlan = {
      nonce: 'nonce-refresh-failure', id: 'github', packageName: '@botmux-ai/plugin-github', version: '0.1.0',
      integrity: sampleIntegrity, sourceType: 'github-release',
      downloadUrl: 'https://github.com/botmux-ai/botmux-plugin-github/releases/download/v0.1.0/botmux-plugin-github-0.1.0.tgz',
      releaseRepo: 'botmux-ai/botmux-plugin-github', releaseTag: 'v0.1.0', releaseAsset: 'botmux-plugin-github-0.1.0.tgz',
      expiresAt: Date.now() + 300_000, expectedState: null, expectedRevision: 'b'.repeat(64),
    };
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url === '/api/plugins') {
        return installed
          ? new Response(JSON.stringify({ error: 'refresh failed' }), { status: 500 })
          : new Response(JSON.stringify({ plugins: [], globalPlugins: [], bots: [], gatewayAdapters: [] }));
      }
      if (url === '/api/plugins/market') {
        return new Response(JSON.stringify({ items: [officialGithubEntry], stale: false, available: true }));
      }
      if (url === '/api/plugins/market/prepare') return new Response(JSON.stringify({ plan }));
      if (url === '/api/plugins/market/install') {
        installed = true;
        return new Response(JSON.stringify({ ok: true, result: { id: 'github', version: '0.1.0' } }));
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }));

    await act(async () => { renderer = TestRenderer.create(React.createElement(PluginManagementPage)); });
    await flush();
    const install = renderer!.root.find(node => node.props['data-market-install'] === 'github');
    await act(async () => { install.props.onClick(); });
    await flush();
    const confirm = renderer!.root.find(node => node.props['data-market-confirm-install']);
    await act(async () => { confirm.props.onClick(); });
    await flush();

    expect(installed).toBe(true);
    const notice = renderer!.root.find(node => node.props['data-plugin-notice']);
    expect(textOf(notice)).toContain('已安装 GitHub (v0.1.0)');
    expect(notice.findAll(node => node.props['data-plugin-notice-open'])).toHaveLength(0);
    expect(notice.findAll(node => node.props['data-plugin-notice-settings'])).toHaveLength(0);
  });
});
