import { describe, expect, it } from 'vitest';
import {
  blocksSetupBotStart,
  classifySetupOpenPlatformOutcome,
  scriptedSetupOpenPlatformReuseOnly,
  setupOpenPlatformOutcomeJson,
  setupOpenPlatformRetryCommand,
} from '../src/setup/open-platform-outcome.js';
import type { OpenPlatformAutomationResult } from '../src/setup/open-platform-automation.js';

function success(overrides: Partial<Extract<OpenPlatformAutomationResult, { ok: true }>> = {}) {
  return {
    ok: true as const,
    sessionFile: '/tmp/session.json',
    sessionSource: 'botmux_cache' as const,
    cookieCount: 2,
    scopeCount: 3,
    skippedScopeCount: 0,
    subscribedEventCount: 2,
    missingVcEvents: [],
    eventModeReady: true,
    versionId: 'v1',
    ...overrides,
  };
}

describe('classifySetupOpenPlatformOutcome', () => {
  it('distinguishes ready and warning-bearing success', () => {
    expect(classifySetupOpenPlatformOutcome(success()).status).toBe('ready');
    expect(classifySetupOpenPlatformOutcome(success({ scopeWarning: 'partial scope grant' })).status)
      .toBe('ready_with_warnings');
    expect(classifySetupOpenPlatformOutcome(success({ scopeCount: 0 })).status)
      .toBe('ready_with_warnings');
    expect(classifySetupOpenPlatformOutcome(success({ skippedScopeCount: 1 })).status)
      .toBe('ready_with_warnings');
    expect(classifySetupOpenPlatformOutcome(success({ versionId: undefined })).status)
      .toBe('ready_with_warnings');
  });

  it('keeps Lark compatibility manual without treating it as a Feishu failure', () => {
    const outcome = classifySetupOpenPlatformOutcome({
      ok: false,
      reason: 'unsupported_brand',
      message: 'only feishu is automated',
    });
    expect(outcome.status).toBe('manual');
    expect(blocksSetupBotStart(outcome)).toBe(false);
  });

  it('blocks bot start for critical Feishu automation failures and serializes details', () => {
    const outcome = classifySetupOpenPlatformOutcome({
      ok: false,
      reason: 'api_error',
      message: 'event callback missing',
      sessionFile: '/tmp/session.json',
      eventModeReady: false,
    });
    expect(outcome.status).toBe('failed');
    expect(blocksSetupBotStart(outcome)).toBe(true);
    expect(setupOpenPlatformOutcomeJson(outcome)).toEqual({
      status: 'failed',
      reason: 'api_error',
      message: 'event callback missing',
      sessionFile: '/tmp/session.json',
      eventModeReady: false,
    });
    expect(setupOpenPlatformRetryCommand('cli_x', outcome)).toBe('botmux setup configure cli_x');
  });

  it('does not offer a deterministic retry loop for manual Lark setup', () => {
    const outcome = classifySetupOpenPlatformOutcome({
      ok: false,
      reason: 'unsupported_brand',
      message: 'only feishu is automated',
    });
    expect(setupOpenPlatformRetryCommand('cli_lark', outcome)).toBeUndefined();
  });

  it('adds --switch-account when a cached web session cannot make progress', () => {
    const outcome = classifySetupOpenPlatformOutcome({
      ok: false,
      reason: 'invalid_session',
      message: 'cache expired',
    });
    expect(setupOpenPlatformRetryCommand('cli_x', outcome))
      .toBe('botmux setup configure cli_x --switch-account');
  });

  it('keeps every scripted JSON automation path QR-free by default', () => {
    expect(scriptedSetupOpenPlatformReuseOnly({
      json: true,
      createApp: false,
      compatibilityMode: false,
      brand: 'feishu',
    })).toBe(true);
    expect(scriptedSetupOpenPlatformReuseOnly({
      json: false,
      createApp: true,
      compatibilityMode: false,
      brand: 'feishu',
    })).toBe(true);
    expect(scriptedSetupOpenPlatformReuseOnly({
      json: false,
      createApp: false,
      compatibilityMode: false,
      brand: 'feishu',
    })).toBe(false);
    expect(scriptedSetupOpenPlatformReuseOnly({
      json: true,
      createApp: false,
      compatibilityMode: false,
      brand: 'lark',
    })).toBe(false);
  });
});
