import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InstalledSkillsLibrary, RemoveSkillsDialog, SkillsInstallPanel, SkillsPage } from '../src/dashboard/web/skills-page.js';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe('dashboard skills install panel', () => {
  function renderInstallPanel(props: Partial<React.ComponentProps<typeof SkillsInstallPanel>> = {}): TestRenderer.ReactTestRenderer {
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(React.createElement(SkillsInstallPanel, {
        installSource: '',
        installPath: '',
        installRef: '',
        installFullDepth: false,
        installStatus: null,
        installBusy: false,
        onInstallSourceChange: vi.fn(),
        onInstallPathChange: vi.fn(),
        onInstallRefChange: vi.fn(),
        onInstallFullDepthChange: vi.fn(),
        onInstall: vi.fn(),
        onOpenNativeDiscovery: vi.fn(),
        ...props,
      }));
    });
    return renderer;
  }

  it('separates remote source scanning from local native skill discovery', () => {
    const renderer = renderInstallPanel();
    const root = renderer.root;

    const sourceControl = root.findByProps({ className: 'skills-source-control' });
    expect(sourceControl.findAllByProps({ 'data-action': 'discover-native-skills' })).toHaveLength(0);
    expect(root.findAllByProps({ 'data-action': 'scan-source-skills' })).toHaveLength(0);
    expect(root.findAllByProps({ 'data-action': 'open-native-skill-discovery' })).toHaveLength(1);
    expect(root.findAllByProps({ 'data-action': 'install' })).toHaveLength(1);
    expect(root.findAllByProps({ 'data-install': 'path' })).toHaveLength(1);
    expect(root.findAllByProps({ 'data-install': 'ref' })).toHaveLength(1);
  });

  it('folds path/ref/scan-depth into advanced options and keeps the install action in the footer', () => {
    // The source address is the primary input; path, ref and scan depth only
    // matter for specific source kinds (and the backend already retries with a
    // deep scan on its own), so they live in a collapsed <details>. Asserting
    // containment rather than exact depth keeps this robust to wrapper markup.
    //
    // NOTE: compare TestInstances via `===` inside expect(), never
    // `expect(a).toBe(b)` — on failure vitest serializes both cyclic React
    // trees to build a diff and exhausts the worker's heap.
    const renderer = renderInstallPanel();
    const root = renderer.root;
    const installGrid = root.findByProps({ className: 'skills-install-grid' });
    const advanced = root.findByProps({ 'data-install-advanced': true });

    for (const marker of ['path', 'ref', 'full-depth'] as const) {
      const field = root.findByProps({ 'data-install': marker });
      expect(advanced.findAllByProps({ 'data-install': marker })).toHaveLength(1);
      expect(field !== undefined).toBe(true);
    }

    // The advanced block itself, and the install action, hang off the grid.
    expect(installGrid.findAllByProps({ 'data-install-advanced': true })).toHaveLength(1);
    const install = installGrid.findByProps({ 'data-action': 'install' });
    expect(String(install.props.className)).toContain('primary');
    expect(advanced.findAllByProps({ 'data-action': 'install' })).toHaveLength(0);
  });

  it('keeps source examples in an accessible help popover instead of the primary form', () => {
    const renderer = renderInstallPanel();
    const root = renderer.root;

    expect(root.findAllByProps({ 'data-action': 'use-source-example' })).toHaveLength(0);
    expect(root.findAllByProps({ 'data-source-help-popover': true })).toHaveLength(0);

    const trigger = root.findByProps({ 'data-action': 'toggle-source-help' });
    expect(trigger.props['aria-expanded']).toBe(false);
    expect(trigger.props['aria-haspopup']).toBe('dialog');
    act(() => { trigger.props.onClick(); });

    const popover = root.findByProps({ 'data-source-help-popover': true });
    expect(popover.props.role).toBe('dialog');
    expect(root.findByProps({ 'data-action': 'toggle-source-help' }).props['aria-expanded']).toBe(true);
    const rendered = JSON.stringify(renderer.toJSON());
    expect(rendered).toContain('GitHub / Git');
    expect(rendered).toContain('本机 CLI Skill 目录');
    expect(rendered).toContain('npm_config_registry=');
    expect(rendered).toContain('agentbuddy@latest skill add skills.example.com/team/health');

    act(() => { root.findByProps({ 'data-action': 'close-source-help' }).props.onClick(); });
    expect(root.findAllByProps({ 'data-source-help-popover': true })).toHaveLength(0);
  });

  it('keeps multi-skill install selection inside the install confirmation dialog', () => {
    const renderer = renderInstallPanel({
      installSource: 'https://github.com/acme/skills',
      installSelectionOpen: true,
      installCandidates: [
        { name: 'deploy', path: 'skills/deploy', description: 'Deploy services' },
        { name: 'review', path: 'skills/review', description: 'Review code' },
      ],
      selectedInstallSkills: new Set(['deploy', 'review']),
      onToggleInstallSkill: vi.fn(),
      onSelectAllInstallSkills: vi.fn(),
      onConfirmInstallSelection: vi.fn(),
      onCloseInstallSelection: vi.fn(),
    });
    const root = renderer.root;

    expect(root.findAllByProps({ 'data-action': 'scan-source-skills' })).toHaveLength(0);
    expect(root.findAllByProps({ 'data-action': 'install' })).toHaveLength(1);
    expect(root.findAllByProps({ 'data-install-selection-dialog': true })).toHaveLength(1);
    expect(root.findAllByProps({ 'data-action': 'confirm-install-selection' })).toHaveLength(1);
    expect(root.findAllByProps({ 'data-action': 'toggle-all-source-skills' })).toHaveLength(1);
    expect(root.findAllByProps({ className: 'skills-candidate-row' })).toHaveLength(2);
  });

  it('echoes the recognized source type and deploy-host requirements before installation', () => {
    const renderer = renderInstallPanel({
      installSource: 'npm_config_registry="https://registry.example.com" npx -y agentbuddy@latest skill add skills.example.com/team/health',
    });
    const root = renderer.root;

    expect(root.findAllByProps({ 'data-source-hint': 'agentbuddy' })).toHaveLength(1);
    expect(JSON.stringify(renderer.toJSON())).toContain('已识别：Agentbuddy 安装命令');
    expect(JSON.stringify(renderer.toJSON())).toContain('部署机已配置 Agentbuddy CLI');
  });

  it('renders source-specific troubleshooting after a failed scan or install', () => {
    const renderer = renderInstallPanel({
      installSource: 'https://github.com/acme/private-skills',
      installStatus: { ok: false, text: '安装失败' },
    });
    const diagnostic = renderer.root.findByProps({ 'data-install-diagnostic': 'github' });

    expect(diagnostic.findByType('strong').props.children).toBe('安装失败排查');
    expect(diagnostic.findByType('span').props.children).toContain('私有仓库');
  });
});

describe('installed Skills library', () => {
  function renderLibrary(props: Partial<React.ComponentProps<typeof InstalledSkillsLibrary>> = {}): TestRenderer.ReactTestRenderer {
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(React.createElement(InstalledSkillsLibrary, {
        skills: [
          { name: 'deploy-api', displayName: 'Deploy API', description: 'Publish backend services', tags: ['release'] },
          { name: 'deploy-web', displayName: 'Deploy Web', description: 'Publish frontend assets' },
          { name: 'review', displayName: 'Code Review', description: 'Review pull requests' },
        ],
        busySkill: null,
        removingNames: new Set(),
        status: null,
        onUpdate: vi.fn(),
        onRequestRemove: vi.fn(),
        ...props,
      }));
    });
    return renderer;
  }

  it('filters immediately across name, display name, description, and tags, with a distinct no-results state', () => {
    const renderer = renderLibrary();
    const root = renderer.root;
    const search = root.findByProps({ 'data-action': 'search-installed-skills' });

    act(() => search.props.onChange({ currentTarget: { value: 'backend' } }));
    expect(root.findAllByProps({ 'data-skill': 'deploy-api' })).toHaveLength(1);
    expect(root.findAllByProps({ 'data-skill': 'deploy-web' })).toHaveLength(0);

    act(() => search.props.onChange({ currentTarget: { value: 'release' } }));
    expect(root.findAllByProps({ 'data-skill': 'deploy-api' })).toHaveLength(1);

    act(() => search.props.onChange({ currentTarget: { value: 'calendar' } }));
    expect(root.findAllByProps({ 'data-empty': 'search' })).toHaveLength(1);
    act(() => root.findByProps({ 'data-action': 'clear-installed-search-empty' }).props.onClick());
    expect(root.findAllByProps({ 'data-skill': 'review' })).toHaveLength(1);
  });

  it('selects only the current filtered results and preserves hidden selections when the query changes', () => {
    const onRequestRemove = vi.fn();
    const renderer = renderLibrary({ onRequestRemove });
    const root = renderer.root;
    const search = root.findByProps({ 'data-action': 'search-installed-skills' });

    act(() => search.props.onChange({ currentTarget: { value: 'deploy' } }));
    act(() => root.findByProps({ 'data-action': 'select-installed-skills' }).props.onClick());
    expect(root.findByProps({ className: 'skills-select-all-results' }).findByType('span').children.join('')).toBe('全选 2 个搜索结果');
    const selectAll = root.findByProps({ className: 'skills-select-all-results' }).findByType('input');
    act(() => selectAll.props.onChange());

    act(() => search.props.onChange({ currentTarget: { value: 'review' } }));
    expect(root.findByProps({ className: 'skills-bulk-action-bar' }).findByType('small').children.join('')).toContain('2');
    act(() => root.findByProps({ 'data-action': 'remove-selected-skills' }).props.onClick());

    expect(onRequestRemove).toHaveBeenCalledTimes(1);
    expect(new Set(onRequestRemove.mock.calls[0][0])).toEqual(new Set(['deploy-api', 'deploy-web']));
  });

  it('keeps the search query when selection mode is cancelled and routes single removal through the parent', () => {
    const onRequestRemove = vi.fn();
    const renderer = renderLibrary({ onRequestRemove });
    const root = renderer.root;
    const search = root.findByProps({ 'data-action': 'search-installed-skills' });

    act(() => search.props.onChange({ currentTarget: { value: 'review' } }));
    act(() => root.findByProps({ 'data-action': 'select-installed-skills' }).props.onClick());
    act(() => root.findByProps({ 'data-action': 'cancel-installed-selection' }).props.onClick());
    expect(root.findByProps({ 'data-action': 'search-installed-skills' }).props.value).toBe('review');

    act(() => root.findByProps({ 'data-action': 'remove-skill' }).props.onClick());
    expect(onRequestRemove).toHaveBeenCalledWith(['review']);
    expect(root.findAllByProps({ 'data-skill': 'review' })).toHaveLength(1);
  });

  it('labels an unfiltered selection as all installed Skills rather than the current page', () => {
    const renderer = renderLibrary();
    const root = renderer.root;

    act(() => root.findByProps({ 'data-action': 'select-installed-skills' }).props.onClick());

    expect(root.findByProps({ className: 'skills-select-all-results' }).findByType('span').children.join('')).toBe('全选全部 3 个');
  });

  it('adds Bot-reference risk only in the second confirmation and keeps affected Bot names', () => {
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(React.createElement(RemoveSkillsDialog, {
        names: ['apple-design'],
        references: [{ name: 'apple-design', bots: ['设计 Bot', '开发 Bot'], packs: [] }],
        busy: false,
        error: null,
        onCancel: vi.fn(),
        onConfirm: vi.fn(),
      }));
    });
    const root = renderer.root;

    expect(root.findByType('h3').children.join('')).toBe('仍要删除“apple-design”？');
    expect(root.findAllByType('p').map(node => node.children.join('')).join(' ')).toContain('它正被 2 个 Bot 引用');
    expect(root.findAllByType('button').map(node => node.children.join(''))).toContain('仍要删除');
    expect(root.findByType('li').findByType('span').children.join('')).toBe('设计 Bot, 开发 Bot');
    expect(root.findAllByType('ul')).toHaveLength(1);
  });

  it('shows pack references in the forced removal confirmation', () => {
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(React.createElement(RemoveSkillsDialog, {
        names: ['apple-design'],
        references: [{ name: 'apple-design', bots: [], packs: ['design-pack'] }],
        busy: false,
        error: null,
        onCancel: vi.fn(),
        onConfirm: vi.fn(),
      }));
    });

    const text = JSON.stringify(renderer.toJSON());
    expect(text).toContain('1 个 Skill Pack 引用');
    expect(text).toContain('design-pack');
  });
});

describe('dashboard native discovery dialog plugin-cache warning', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function flush() {
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
  }

  it('warns on versioned plugin cache sources and defaults to copy mode while keeping stable native roots on link mode', async () => {
    const cacheSkillPath = '/Users/me/.claude/plugins/cache/claude-plugins-official/superpowers/7.0.0/skills/writing-skills';
    const stableSkillPath = '/Users/me/.claude/skills/deploy';
    const postPayloads: any[] = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (u === '/api/skills/install-local-links' && init?.method === 'POST') {
        postPayloads.push(JSON.parse(String(init.body ?? '{}')));
        return { ok: true, status: 200, json: async () => ({ ok: true, installed: [] }) };
      }
      if (u.startsWith('/api/skills')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            skills: [],
            nativeSkillGroups: [
              {
                cliId: 'claude-code',
                rootDir: '/Users/me/.claude/plugins/cache/claude-plugins-official/superpowers/7.0.0/skills',
                label: 'superpowers (plugin)',
                skills: [{ name: 'writing-skills', rootDir: cacheSkillPath }],
              },
              {
                cliId: 'claude-code',
                rootDir: '/Users/me/.claude/skills',
                skills: [{ name: 'deploy', rootDir: stableSkillPath }],
              },
            ],
            trustProjectSkills: 'off',
            delivery: 'auto',
          }),
        };
      }
      if (u.startsWith('/api/bots')) return { ok: true, status: 200, json: async () => ({ bots: [] }) };
      if (u.startsWith('/api/skill-packs')) return { ok: true, status: 200, json: async () => ({ packs: [] }) };
      return { ok: false, status: 404, json: async () => ({ error: 'not_found' }) };
    });
    vi.stubGlobal('fetch', fetchMock);

    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => { renderer = TestRenderer.create(React.createElement(SkillsPage)); });
    await flush();

    const root = renderer.root;
    await act(async () => {
      root.findByProps({ 'data-action': 'open-native-skill-discovery' }).props.onClick();
    });

    // First active tab is the versioned plugin cache group: warning is shown and copy mode is recommended (checked).
    expect(root.findAllByProps({ 'data-discovery-cache-warning': true })).toHaveLength(1);
    const copyToggle = root.findByProps({ 'data-discovery-copy-mode': true });
    expect(copyToggle.props.checked).toBe(true);

    const cacheCheckbox = root.findAllByProps({ 'data-discovered-skill': true })
      .find(node => node.props.value === cacheSkillPath)!;
    await act(async () => {
      cacheCheckbox.props.onChange({ currentTarget: { checked: true } });
    });
    await act(async () => {
      await root.findByProps({ 'data-action': 'register-discovered-skills' }).props.onClick();
    });
    await flush();

    expect(postPayloads[0]).toEqual({ sources: [cacheSkillPath], mode: 'copy' });

    // Reopen and switch to the stable ~/.claude/skills group: no cache warning, submits link mode without `mode`.
    await act(async () => {
      root.findByProps({ 'data-action': 'open-native-skill-discovery' }).props.onClick();
    });
    const stableTab = root.findAllByProps({ role: 'tab' })
      .find(node => String(node.props['data-discovery-tab'] ?? '').includes('/Users/me/.claude/skills'))!;
    await act(async () => { stableTab.props.onClick(); });
    expect(root.findAllByProps({ 'data-discovery-cache-warning': true })).toHaveLength(0);

    const stableCheckbox = root.findAllByProps({ 'data-discovered-skill': true })
      .find(node => node.props.value === stableSkillPath)!;
    await act(async () => {
      stableCheckbox.props.onChange({ currentTarget: { checked: true } });
    });
    await act(async () => {
      await root.findByProps({ 'data-action': 'register-discovered-skills' }).props.onClick();
    });
    await flush();

    expect(postPayloads[1]).toEqual({ sources: [stableSkillPath] });
  });
});

