import { describe, expect, it } from 'vitest';
import type { DesktopRuntimeState } from '../../src/desktop/shared/types.js';
import {
  buildRuntimeMeta,
  buildVersionLine,
  classifyEmptyDashboardView,
  emptyDashboardMessage,
  isRuntimeState,
  shouldAutoOpenZeroBotOnboarding,
  shouldKeepLoadedDashboardDuringDegradedState,
} from '../../src/desktop/renderer/runtime-state.js';
import {
  currentDashboardUrlFromSrc,
  dashboardRouteFromUrl,
  dashboardRouteMatches,
  normalizeDashboardRoute,
  routeDashboardUrl,
  withDesktopShellRoute,
} from '../../src/desktop/renderer/dashboard-url.js';

const t = (key: string, params?: Record<string, string | number>) => {
  const messages: Record<string, string> = {
    'runtimeSource.none': '未连接 CLI',
    'empty.notConfigured': '添加机器人后启动 CLI，即可加载控制台。',
    'empty.stopped': '启动 CLI 后加载控制台。',
    'empty.degraded': 'CLI 需要处理后才能加载控制台。',
    'empty.dashboardMissing': '控制台 URL 暂不可用。',
  };
  const template = messages[key] ?? key;
  return template.replace(/\{(\w+)\}/g, (_, name) => String(params?.[name] ?? `{${name}}`));
};

function runtimeState(overrides: Partial<DesktopRuntimeState> = {}): DesktopRuntimeState {
  return {
    status: 'running',
    appVersion: '2.94.0',
    runtimeVersion: '2.95.0',
    runtimeSource: 'global-cli',
    runtimeManaged: true,
    runtimePath: '/opt/homebrew/bin/botmux',
    botCount: 4,
    onlineDaemonCount: 2,
    attentionCount: 0,
    dashboardUrl: null,
    ...overrides,
  };
}

describe('desktop renderer runtime boundary', () => {
  it('keeps routine CLI source labels out of the footer while preserving missing-CLI hints', () => {
    expect(buildRuntimeMeta(runtimeState({ runtimeSource: 'global-cli' }), t)).toBe('');
    expect(buildRuntimeMeta(runtimeState({ runtimeSource: 'none' }), t)).toBe('未连接 CLI');
    expect(buildVersionLine(runtimeState())).toBe('App 2.94.0 / CLI 2.95.0');
    expect(buildVersionLine(runtimeState({ runtimeVersion: null }))).toBe('App 2.94.0 / CLI unknown');
  });

  it('centralizes dashboard-empty and degraded-keep rules around runtime state', () => {
    expect(emptyDashboardMessage(runtimeState({ status: 'not_configured', message: '先安装 CLI' }), t)).toBe('先安装 CLI');
    expect(emptyDashboardMessage(runtimeState({ status: 'stopped' }), t)).toBe('启动 CLI 后加载控制台。');
    expect(shouldKeepLoadedDashboardDuringDegradedState(runtimeState({
      status: 'degraded',
      message: 'Invalid fleet state',
    }))).toBe(true);
    expect(shouldKeepLoadedDashboardDuringDegradedState(runtimeState({
      status: 'degraded',
      message: '请升级或切换全局 botmux CLI，当前 CLI 与 Desktop 兼容协议不匹配',
    }))).toBe(false);
  });

  it('validates complete runtime state snapshots at the renderer IPC boundary', () => {
    expect(isRuntimeState(runtimeState())).toBe(true);
    expect(isRuntimeState({ ...runtimeState(), runtimeSource: 'unknown' })).toBe(false);
    expect(isRuntimeState({ ...runtimeState(), dashboardUrl: 123 })).toBe(false);
    expect(isRuntimeState({ ...runtimeState(), message: 123 })).toBe(false);
  });

  it('auto-opens 0-bot onboarding once per cold launch and classifies empty dashboard views cleanly', () => {
    const zeroBotRunning = runtimeState({ status: 'running', botCount: 0, onlineDaemonCount: 0 });
    expect(shouldAutoOpenZeroBotOnboarding(zeroBotRunning, {
      alreadyOpened: false,
      userNavigated: false,
      hasLoadedDashboard: false,
    })).toBe(true);
    expect(shouldAutoOpenZeroBotOnboarding(zeroBotRunning, {
      alreadyOpened: true,
      userNavigated: false,
      hasLoadedDashboard: false,
    })).toBe(false);
    expect(shouldAutoOpenZeroBotOnboarding(zeroBotRunning, {
      alreadyOpened: false,
      userNavigated: true,
      hasLoadedDashboard: false,
    })).toBe(false);
    expect(shouldAutoOpenZeroBotOnboarding(runtimeState({ status: 'running', botCount: 1 }), {
      alreadyOpened: false,
      userNavigated: false,
      hasLoadedDashboard: false,
    })).toBe(false);

    expect(classifyEmptyDashboardView(
      runtimeState({ status: 'not_configured', runtimeManaged: true, runtimeSource: 'bundled', botCount: 0 }),
      { bootstrappingZeroBot: true },
    ).kind).toBe('bootstrapping');
    expect(classifyEmptyDashboardView(
      runtimeState({ status: 'not_configured', runtimeManaged: true, runtimeSource: 'bundled', botCount: 0 }),
      { bootstrappingZeroBot: false },
    ).kind).toBe('onboarding_welcome');
    expect(classifyEmptyDashboardView(
      runtimeState({
        status: 'degraded',
        degradedReason: 'invalid_bots_json',
        runtimeManaged: false,
        runtimeSource: 'none',
        botCount: 0,
        onlineDaemonCount: 0,
        message: 'bots.json must contain a JSON array',
      }),
    )).toMatchObject({
      kind: 'config_error',
      detail: 'bots.json must contain a JSON array',
    });
    // Non-config 0-bot degraded states must NOT be misclassified as bots.json corruption.
    expect(classifyEmptyDashboardView(
      runtimeState({
        status: 'degraded',
        degradedReason: 'fleet_discovery',
        runtimeManaged: false,
        runtimeSource: 'bundled',
        botCount: 0,
        onlineDaemonCount: 0,
        message: 'Invalid fleet state',
      }),
    ).kind).toBe('degraded');
    expect(classifyEmptyDashboardView(
      runtimeState({
        status: 'degraded',
        degradedReason: 'external_unmanaged',
        runtimeManaged: false,
        runtimeSource: 'global-cli',
        botCount: 0,
        onlineDaemonCount: 0,
        message: '检测到由其他 botmux 安装启动的运行时',
      }),
    ).kind).toBe('degraded');
    expect(isRuntimeState({ ...runtimeState(), degradedReason: 'invalid_bots_json' })).toBe(true);
    expect(isRuntimeState({ ...runtimeState(), degradedReason: 'bogus_reason' })).toBe(false);
  });
});

describe('desktop renderer dashboard URL boundary', () => {
  it('normalizes dashboard hash routes without leaking desktop shell params into navigation matching', () => {
    expect(normalizeDashboardRoute('sessions')).toBe('#sessions');
    expect(normalizeDashboardRoute('#/settings?shell=desktop&locale=zh&runtimeVersion=2.95.0&tab=about')).toBe('#/settings?tab=about');
    expect(dashboardRouteFromUrl('http://127.0.0.1:7891/#/sessions?shell=desktop&locale=en')).toBe('#/sessions');
    expect(dashboardRouteMatches('#/sessions', '#/sessions/abc')).toBe(true);
    expect(dashboardRouteMatches('#/', '#/sessions')).toBe(false);
  });

  it('adds desktop shell, locale, and CLI version params to dashboard routes', () => {
    expect(withDesktopShellRoute('#/sessions?filter=open', { locale: 'en', runtimeVersion: '2.95.0' })).toBe(
      '#/sessions?filter=open&shell=desktop&locale=en&runtimeVersion=2.95.0',
    );
    expect(withDesktopShellRoute('#/', { locale: 'zh', runtimeVersion: null })).toBe('#/?shell=desktop&locale=zh');

    const routed = routeDashboardUrl('http://127.0.0.1:7891/?token=abc#/old', '#/bot-defaults', {
      locale: 'zh',
      runtimeVersion: '2.95.0',
    });
    expect(routed).toBe('http://127.0.0.1:7891/?token=abc#/bot-defaults?shell=desktop&locale=zh&runtimeVersion=2.95.0');
    expect(currentDashboardUrlFromSrc(routed)).toBe('http://127.0.0.1:7891/?token=abc');
    expect(currentDashboardUrlFromSrc('about:blank')).toBeNull();
  });
});
