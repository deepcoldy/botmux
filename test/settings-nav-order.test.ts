import React, { type ComponentProps } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AutostartCard, SettingsBody, SettingsNav, UpdateCard } from '../src/dashboard/web/settings-page.js';
import { SETTINGS_SECTIONS } from '../src/dashboard/web/settings-sections.js';
import { createDashboardTranslator } from '../src/dashboard/web/i18n.js';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => vi.unstubAllGlobals());

type Settings = ComponentProps<typeof SettingsBody>['settings'];

const settings: Settings = {
  groupNamePrefix: '',
  publicReadOnly: false,
  openTerminalInFeishu: false,
  enableLocalCliOpen: false,
  localCliOpenMode: 'attach',
  chatBotDiscovery: false,
  herdrTraexPlugin: { enabled: false, source: '', ref: '', recommendedSource: '', recommendedRef: '' },
  codexRpcInput: false,
  autoUpgradeCodexSessions: false,
  reapOrphanTmuxServers: false,
  bypassCodexHookTrust: false,
  hideCodexRateLimitModelNudge: false,
  cardBrandLabel: false,
  codexNotifier: {
    enabled: false, targetBotAppId: null, notifyWhen: 'always', platformSupported: true, hookInstalled: false,
    botOptions: [], targetDaemonOnline: false, pendingCount: 0, workerOnline: false, lastError: null,
  },
  hostOverloadAlert: { enabled: false, targetBotAppId: null, enterLoadRatio: 1.5, enterMemUsedFrac: 0.9, botOptions: [], targetDaemonOnline: false },
  noVisibleOutputHint: false,
  crossPrincipalInterruption: false,
  vcMeetingAgent: { enabled: false },
  repoPickerMode: 'all',
  maintenance: {},
  localDevInstall: false,
  autoUpdateSupported: true,
  whiteboard: { enabled: false },
  workflow: { enabled: true },
  sessionCleanup: { enabled: false, olderThanHours: 24, intervalMinutes: 60 },
  promptCache: null,
  multiTopic: { enabled: false },
  remoteAccess: false,
  oauthRedirectBase: '',
  httpProxy: '',
  scheduleTimeZone: '',
  hostTimeZone: 'UTC',
  effectiveScheduleTimeZone: 'UTC',
};

function renderSettingsPageParts() {
  // 会话环境变量编辑器挂载时会去读接口；这里只看区块顺序，给个空响应即可。
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 503, json: async () => ({ error: 'daemon_offline' }) }) as Response));
  const noop = () => {};
  const body = TestRenderer.create(React.createElement(SettingsBody, {
    settings,
    canWrite: true,
    bound: true,
    savingKey: null,
    message: null,
    autostartBlock: React.createElement(AutostartCard, {
      canWrite: false, state: null, loading: false, error: false, busy: false, message: null, onChange: noop, onRetry: noop,
    }),
    updateBlock: React.createElement(UpdateCard, {
      canWrite: false, status: null, statusError: null, changelog: null, changelogOpen: false, changelogOk: false,
      changelogRateLimited: false, releasesUrl: '', busy: false, message: null,
      onCheck: noop, onToggleChangelog: noop, onUpdate: noop, onRestart: noop,
    }),
    feishuLoginQr: null,
    onCloseFeishuLoginQr: noop,
    onFeishuLoginQr: noop,
    onSave: async () => {},
  }));
  return body;
}

const isBlock = (node: TestRenderer.ReactTestInstance) =>
  node.type === 'section' && String(node.props.className ?? '').split(' ').includes('settings-block') && !!node.props.id;
const text = (node: TestRenderer.ReactTestInstance): string =>
  node.children.map(child => typeof child === 'string' ? child : text(child)).join('');

describe('settings page navigation', () => {
  it('mirrors the page: same modules, same blocks, same order', async () => {
    let body!: TestRenderer.ReactTestRenderer;
    await act(async () => { body = renderSettingsPageParts(); });
    // 页面上真正渲染出来的模块与区块（SettingsBlock 的 DOM id），按渲染顺序。
    const pageModules = body.root.findAll(node => node.type === 'section' && String(node.props.className ?? '').split(' ').includes('settings-module'))
      .map(module => ({ label: text(module.find(node => node.type === 'header').find(node => node.type === 'h2')), ids: module.findAll(isBlock).map(node => node.props.id as string) }));
    const pageOrder = body.root.findAll(isBlock).map(node => node.props.id as string);
    act(() => body.unmount());

    const tr = createDashboardTranslator('zh');
    let nav!: TestRenderer.ReactTestRenderer;
    act(() => { nav = TestRenderer.create(React.createElement(SettingsNav, { tr })); });
    const navGroups = nav.root.findAll(node => node.type === 'div' && node.props.className === 'settings-nav-group').map(group => ({
      label: text(group.find(node => node.type === 'p')),
      ids: group.findAll(node => node.type === 'button').map(node => node.props['data-section'] as string),
    }));
    const labels = nav.root.findAll(node => node.type === 'button').map(text);
    act(() => nav.unmount());

    expect(pageOrder.length).toBeGreaterThan(10);
    expect(pageModules.flatMap(module => module.ids)).toEqual(pageOrder);
    expect(navGroups).toEqual(pageModules);
    expect(SETTINGS_SECTIONS.map(section => section.id)).toEqual(pageOrder);
    // 导航文字是译文，不是漏翻的 key。
    expect(labels.filter(label => /^[a-z]+\.[A-Za-z]/.test(label))).toEqual([]);
  });
});
