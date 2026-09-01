import { readFileSync } from 'node:fs';
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'bun:test';
import { BotPolicyCard, InstalledSkillsLibrary, RemoveSkillsDialog, SkillsInstallPanel } from '../src/dashboard/web/skills-page.js';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe('dashboard skills React hook safety', () => {
  it('keeps hook order stable when the same bot card flips between error and normal states', () => {
    const onSave = vi.fn();
    const normalBot = { larkAppId: 'app-a', botName: 'Codex Bot', skills: { include: ['skill:deploy'] } };
    const errorBot = { larkAppId: 'app-a', botName: 'Codex Bot', error: 'daemon offline', skills: null };
    const skills = [{ name: 'deploy' }, { name: 'review' }];

    let renderer!: TestRenderer.ReactTestRenderer;
    expect(() => {
      act(() => {
        renderer = TestRenderer.create(React.createElement(BotPolicyCard, {
          bot: errorBot,
          installedNames: new Set(['deploy', 'review']),
          skills,
          status: null,
          busyKey: null,
          onSave,
        }));
      });
      act(() => {
        renderer.update(React.createElement(BotPolicyCard, {
          bot: normalBot,
          installedNames: new Set(['deploy', 'review']),
          skills,
          status: null,
          busyKey: null,
          onSave,
        }));
      });
      act(() => {
        renderer.update(React.createElement(BotPolicyCard, {
          bot: errorBot,
          installedNames: new Set(['deploy', 'review']),
          skills,
          status: null,
          busyKey: null,
          onSave,
        }));
      });
    }).not.toThrow();

    expect(renderer.toJSON()).toMatchObject({ props: { 'data-appid': 'app-a' } });
  });

  it('uses one compact searchable multi-select and saves the complete priority selection', async () => {
    const onSave = vi.fn(async () => undefined);
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(React.createElement(BotPolicyCard, {
        bot: { larkAppId: 'app-a', botName: 'Codex Bot', skills: { include: ['skill:deploy'] } },
        installedNames: new Set(['deploy', 'review', 'release']),
        skills: [
          { name: 'deploy', description: 'Deploy services' },
          { name: 'release', description: 'Publish releases' },
          { name: 'review', description: 'Review code' },
        ],
        status: null,
        busyKey: null,
        onSave,
      }));
    });

    const root = renderer.root;
    expect(root.findAllByProps({ className: 'skills-chip-list' })).toHaveLength(0);
    expect(root.findAllByType('code')).toHaveLength(0);
    act(() => root.findByProps({ 'data-action': 'open-skill-picker' }).props.onClick());
    expect(root.findAllByProps({ role: 'option' })).toHaveLength(3);

    act(() => root.findByProps({ 'data-action': 'search-skills' }).props.onChange({ currentTarget: { value: 'review' } }));
    const filtered = root.findAllByProps({ role: 'option' });
    expect(filtered).toHaveLength(1);
    expect(filtered[0].props['data-skill-name']).toBe('review');
    act(() => filtered[0].props.onClick());

    await act(async () => root.findByProps({ 'data-action': 'save-skill-selection' }).props.onClick());
    expect(onSave).toHaveBeenCalledWith('app-a', ['deploy', 'review']);
  });

  it('constrains every bot card child to the card grid column', () => {
    const css = readFileSync(new URL('../src/dashboard/web/style.css', import.meta.url), 'utf8');

    expect(css).toMatch(/\.skills-bot-card\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/s);
    expect(css).toMatch(/\.skills-policy-panel\s*\{[^}]*min-width:\s*0/s);
    expect(css).toMatch(/\.skills-bot-head\s*\{[^}]*min-width:\s*0/s);
    expect(css).toMatch(/\.skills-multi-picker\s*\{[^}]*min-width:\s*0/s);
  });
});

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

  it('keeps long install candidate lists scrollable inside the bounded dialog body', () => {
    const css = readFileSync(new URL('../src/dashboard/web/style.css', import.meta.url), 'utf8');

    expect(css).toMatch(/\.skills-install-selection-body\s*>\s*\.skills-candidate-list\s*\{[^}]*min-height:\s*0;[^}]*max-height:\s*100%;[^}]*overflow-y:\s*auto;/s);
    expect(css).toMatch(/\.skills-install-selection-body\s*>\s*\.skills-candidate-list\s*\{[^}]*overscroll-behavior:\s*contain;[^}]*-webkit-overflow-scrolling:\s*touch;/s);
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
