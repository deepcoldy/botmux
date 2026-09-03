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
    // 一个真正的 ready 必须**同时**包含「redirect 白名单已写上」：这是 ok:true 结果
    // 里的必填字段，缺了它 bot 一点授权就 20029。
    redirectConfigured: true,
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

  it('无变更短路（publishSkipped）不算 warning：versionId 空、scopeCount 0 都是预期结果', () => {
    // 一次「配置本就齐全、无变更 → 有意跳过发版」的健康自检：versionId 必空、
    // importedScopeCount 必为 0。若把这两者仍计入 warning，会把纯健康结果误报成
    // ready_with_warnings（PR #1044 复审提到的次要问题）。
    expect(classifySetupOpenPlatformOutcome(
      success({ versionId: undefined, scopeCount: 0, publishSkipped: true }),
    ).status).toBe('ready');
    // publishSkipped 不豁免真正的 warning：白名单没写上仍要报 warning。
    expect(classifySetupOpenPlatformOutcome(
      success({ versionId: undefined, scopeCount: 0, publishSkipped: true, redirectConfigured: false }),
    ).status).toBe('ready_with_warnings');
  });

  it('🔴 版本没真提交（versionWarning）不许报成 ready —— 否则 CLI 是假绿灯', () => {
    // 这次线上事故的形态：`publish/commit` 回 code=0，版本却仍停在未提交草稿态。
    // scope 都写进清单了，但版本没发布 ⟹ 权限一项都不生效。daemon 自愈路径自己
    // warn + DM 了，而 CLI / scripted JSON 走 classify…，若这里不计入 warning，
    // 用户看到的是「✅ 完成 / 已提交发布版本 v1」的**假绿灯**，然后干等。
    expect(classifySetupOpenPlatformOutcome(
      success({ versionWarning: '版本 v1 提交后回读仍是「未提交审核」草稿' }),
    ).status).toBe('ready_with_warnings');
    // 反面：两者都没有时仍是纯 ready（别把正常路径顺手拖成 warning）
    expect(classifySetupOpenPlatformOutcome(success()).status).toBe('ready');
  });

  it('redirect 白名单没写上时不许报成纯 ready', () => {
    // 权限、事件、发版全绿也没用：白名单缺条目 = authorize 硬失败 20029
    //（群聊模式 p2pMode=group / 会话群标签 / `/login` 全都授权不了）。
    expect(classifySetupOpenPlatformOutcome(success({ redirectConfigured: false })).status)
      .toBe('ready_with_warnings');
    expect(classifySetupOpenPlatformOutcome(
      success({ redirectConfigured: false, redirectWarning: '写入 redirect 白名单失败: code=1' }),
    ).status).toBe('ready_with_warnings');
    // 读不到现值 → 零写入的降级路径同样带 warning，一样不能算 ready。
    expect(classifySetupOpenPlatformOutcome(
      success({ redirectWarning: '读不到开放平台现有 redirect 白名单，本次未写入' }),
    ).status).toBe('ready_with_warnings');
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
