import { createElement, useState, type ReactElement } from 'react';
import TestRenderer, { act, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDashboardTranslator } from '../src/dashboard/web/i18n.js';
import { NAV_ITEMS } from '../src/dashboard/web/nav-items.js';
import { FeatureCatalogModal, WorkspaceGuideBanner, type AutoActiveInfo } from '../src/dashboard/web/workspace-catalog.js';
import {
  CORE_NAV_IDS, WORKSPACE_PRESETS, applyWorkspacePreset, filterSidebarItemsForWorkspace, loadWorkspacePersonalization,
  pinCapability, resolveEffectivePinnedIds, unpinCapability, type WorkspaceMode,
} from '../src/dashboard/web/workspace-personalization.js';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const tr = createDashboardTranslator('en');
const emptyStorage = { getItem: () => null, setItem: () => {} };
const defaults = () => loadWorkspacePersonalization(emptyStorage);
const autoActiveInfo: AutoActiveInfo = new Map([['schedules', { active: true, count: 3 }]]);
let renderer: ReactTestRenderer | undefined;

function mount(element: ReactElement) {
  act(() => { renderer = TestRenderer.create(element); });
  return renderer!.root;
}

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
});

function click(node: ReactTestInstance) {
  act(() => node.props.onClick());
}

function CatalogFixture({ authed = true, onNavigate }: { authed?: boolean; onNavigate?: (href: string) => void }) {
  const [state, setState] = useState(defaults);
  const [open, setOpen] = useState(true);
  const permittedItems = NAV_ITEMS.filter(item => authed || !item.manage);
  const visible = filterSidebarItemsForWorkspace(permittedItems, state, autoActiveInfo.keys());
  if (!open) return null;
  return createElement(FeatureCatalogModal, {
    state, permittedItems, autoActiveInfo, visibleCount: visible.length, shortcut: '⌘K', tr,
    onClose: () => setOpen(false),
    onMode: mode => setState({ ...state, mode }),
    onPreset: preset => setState(applyWorkspacePreset(state, preset, autoActiveInfo.keys())),
    onTogglePin: id => setState(state.mode === 'focused' && visible.some(item => item.id === id)
      ? unpinCapability(state, id) : pinCapability(state, id)),
    onNavigate: href => onNavigate?.(href),
  });
}

const cards = (root: ReactTestInstance) => root.findAll(node => node.type === 'div' && !!node.props['data-capability-id']);
const card = (root: ReactTestInstance, id: string) => cards(root).find(node => node.props['data-capability-id'] === id)!;
const action = (root: ReactTestInstance, name: string) => root.findByProps({ 'data-action': name });

describe('workspace capability catalog', () => {
  it('shows all permitted capabilities, the active schedule badge and live preset selection', () => {
    const root = mount(createElement(CatalogFixture));
    expect(root.findByType('dialog').props).toMatchObject({ role: 'dialog', 'aria-modal': 'true' });
    expect(cards(root)).toHaveLength(19);
    expect(card(root, 'schedules').findByProps({ className: 'wc-badge is-active' }).children).toEqual(['In use · 3']);
    expect(root.findByProps({ 'data-preset-id': 'minimal' }).props['aria-pressed']).toBe(true);
    for (const preset of WORKSPACE_PRESETS.filter(entry => entry.id !== 'minimal')) {
      const button = root.findByProps({ 'data-preset-id': preset.id });
      click(button);
      expect(button.props['aria-pressed']).toBe(true);
      for (const id of preset.pinnedIds) expect(action(card(root, id), 'toggle-pin-capability').props['aria-pressed']).toBe(true);
    }
    click(action(root, 'workspace-reset-minimal'));
    expect(root.findByProps({ 'data-preset-id': 'minimal' }).props['aria-pressed']).toBe(true);
    expect(action(card(root, 'schedules'), 'toggle-pin-capability').props['aria-pressed']).toBe(false);
  });

  it('filters by intent across languages, pins, unpins, and navigates on explore', () => {
    const onNavigate = vi.fn();
    const root = mount(createElement(CatalogFixture, { onNavigate }));
    const search = root.findByProps({ 'data-input': 'workspaceCatalogSearch' });
    act(() => search.props.onChange({ currentTarget: { value: '告警' } }));
    expect(cards(root).map(node => node.props['data-capability-id'])).toEqual(['message-listeners', 'monitoring']);
    const monitoring = card(root, 'monitoring');
    const pin = action(monitoring, 'toggle-pin-capability');
    click(pin);
    expect(pin.props['aria-pressed']).toBe(true);
    click(pin);
    expect(pin.props['aria-pressed']).toBe(false);
    click(action(monitoring, 'open-capability'));
    expect(onNavigate).toHaveBeenCalledWith('#/monitoring');
    expect(renderer!.toJSON()).toBeNull();
  });

  it('switches modes and pins from full mode by returning to focused mode', () => {
    const root = mount(createElement(CatalogFixture));
    const mode = (mode: WorkspaceMode) => root.findByProps({ className: 'wc-mode' }).findAllByType('button')
      .find(node => node.children.includes(tr(`workspace.mode.${mode}`)))!;
    click(mode('all'));
    expect(mode('all').props['aria-pressed']).toBe(true);
    expect(card(root, 'skills').findByProps({ className: 'wc-badge' }).children).toEqual([tr('workspace.badge.all')]);
    click(mode('focused'));
    expect(mode('focused').props['aria-pressed']).toBe(true);
    click(mode('all'));
    click(action(card(root, 'skills'), 'toggle-pin-capability'));
    expect(mode('focused').props['aria-pressed']).toBe(true);
    expect(action(card(root, 'skills'), 'toggle-pin-capability').props['aria-pressed']).toBe(true);
  });

  it('omits management capabilities even when searched by name', () => {
    const root = mount(createElement(CatalogFixture, { authed: false }));
    expect(card(root, 'monitoring')).toBeDefined();
    expect(card(root, 'skills')).toBeUndefined();
    const search = root.findByProps({ 'data-input': 'workspaceCatalogSearch' });
    act(() => search.props.onChange({ currentTarget: { value: 'webhook' } }));
    expect(cards(root)).toHaveLength(0);
  });

  it.each(['escape', 'backdrop'])('dismisses through the native dialog on %s', method => {
    const root = mount(createElement(CatalogFixture));
    const dialog = root.findByType('dialog');
    act(() => {
      if (method === 'escape') dialog.props.onCancel({ preventDefault: vi.fn() });
      else {
        const target = {};
        dialog.props.onClick({ target, currentTarget: target });
      }
    });
    expect(renderer!.toJSON()).toBeNull();
  });
});

function GuideFixture({ id, mode = 'focused' }: { id: string; mode?: WorkspaceMode }) {
  const [state, setState] = useState(() => ({ ...defaults(), mode }));
  return createElement(WorkspaceGuideBanner, {
    item: NAV_ITEMS.find(item => item.id === id),
    state,
    isPinned: resolveEffectivePinnedIds(state, []).has(id),
    tr,
    onPin: capId => setState(pinCapability(state, capId)),
    onDismiss: capId => setState({ ...state, dismissedGuideIds: [capId] }),
  });
}

describe('workspace guide', () => {
  it('pins a hidden page, keeps the first-use guide and offers a direct action', () => {
    const root = mount(createElement(GuideFixture, { id: 'monitoring' }));
    expect(root.findByType('a').props.href).toBe('#/monitor-room');
    click(action(root, 'pin-guide-capability'));
    expect(root.findAllByProps({ 'data-action': 'pin-guide-capability' })).toHaveLength(0);
    expect(root.findByProps({ 'data-guide-id': 'monitoring' })).toBeDefined();
    click(root.findByProps({ 'aria-label': tr('workspace.guide.dismiss') }));
    expect(renderer!.toJSON()).toBeNull();
  });

  it('allows dismissing the guide while the page is still unpinned', () => {
    const root = mount(createElement(GuideFixture, { id: 'skills' }));
    expect(action(root, 'pin-guide-capability')).toBeDefined();
    click(root.findByProps({ 'aria-label': tr('workspace.guide.dismiss') }));
    expect(renderer!.toJSON()).toBeNull();
  });

  it.each(CORE_NAV_IDS)('does not render a guide on core page %s', id => {
    mount(createElement(GuideFixture, { id }));
    expect(renderer!.toJSON()).toBeNull();
  });

  it('does not render a guide in full mode', () => {
    mount(createElement(GuideFixture, { id: 'monitoring', mode: 'all' }));
    expect(renderer!.toJSON()).toBeNull();
  });
});
