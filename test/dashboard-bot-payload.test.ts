import { describe, expect, it } from 'vitest';
import { botDefaultsPayload, botSummaryPayload } from '../src/dashboard/bot-payload.js';

describe('dashboard bot payload helpers', () => {
  it('includes authoritative cliId in group roster bot summaries', () => {
    expect(botSummaryPayload({
      larkAppId: 'cli_traex',
      botName: 'TraeX',
      botAvatarUrl: 'https://example.test/avatar.png',
      cliId: 'traex',
    })).toEqual({
      larkAppId: 'cli_traex',
      botName: 'TraeX',
      botAvatarUrl: 'https://example.test/avatar.png',
      cliId: 'traex',
    });
  });

  it('includes authoritative cliId in /api/bots success and error rows', () => {
    const daemon = { larkAppId: 'cli_traex', botName: 'TraeX', cliId: 'traex', model: 'glm-5.1' };
    expect(botDefaultsPayload(daemon, { defaultOncall: { enabled: false } })).toMatchObject({
      larkAppId: 'cli_traex',
      botName: 'TraeX',
      cliId: 'traex',
      model: 'glm-5.1',
      online: true,
      defaultOncall: { enabled: false },
    });
    expect(botDefaultsPayload(daemon, undefined, 'http_503')).toMatchObject({
      larkAppId: 'cli_traex',
      botName: 'TraeX',
      cliId: 'traex',
      model: 'glm-5.1',
      online: true,
      error: 'http_503',
    });
  });

  it('passes through resident/dormant/logical session counts for the bot card', () => {
    const daemon = { larkAppId: 'app_a', botName: 'BotA', cliId: 'codex' };
    expect(botDefaultsPayload(daemon, {
      logicalSessionCount: 83,
      residentSessionCount: 29,
      dormantSessionCount: 54,
    })).toMatchObject({
      logicalSessionCount: 83,
      residentSessionCount: 29,
      dormantSessionCount: 54,
    });
    expect(botDefaultsPayload(daemon, {})).toMatchObject({
      logicalSessionCount: 0,
      residentSessionCount: 0,
      dormantSessionCount: 0,
    });
  });

  it('projects Codex App clean history mode as an explicit default-off boolean', () => {
    const daemon = { larkAppId: 'app_codex', botName: 'Codex', cliId: 'codex-app' };
    expect(botDefaultsPayload(daemon, {})).toMatchObject({ codexAppCleanInput: false });
    expect(botDefaultsPayload(daemon, { codexAppCleanInput: true }))
      .toMatchObject({ codexAppCleanInput: true });
  });

  it('derives agentSelectionKey from cliId + wrapperCli so the 修改CLI dropdown highlights wrapper gateways', () => {
    // 裸 CLI：选择键 = cliId。
    expect(botDefaultsPayload(
      { larkAppId: 'app_a', botName: 'BotA', cliId: 'claude-code' },
      { defaultOncall: { enabled: false } },
    )).toMatchObject({ cliId: 'claude-code', agentSelectionKey: 'claude-code' });

    // wrapper 网关：选择键 = 对应的 aiden×/ttadk×/cjadk× 选项键（而非裸 cliId），
    // 否则前端下拉高亮回落到裸 cliId，重载后 wrapper 丢失、再保存被剥掉。
    expect(botDefaultsPayload(
      { larkAppId: 'app_a', botName: 'BotA', cliId: 'claude-code', wrapperCli: 'aiden x claude' },
      { defaultOncall: { enabled: false } },
    )).toMatchObject({
      cliId: 'claude-code',
      wrapperCli: 'aiden x claude',
      agentSelectionKey: 'aiden-x-claude',
    });
    expect(botDefaultsPayload(
      { larkAppId: 'app_a', botName: 'BotA', cliId: 'codex', wrapperCli: 'ttadk codex' },
      { defaultOncall: { enabled: false } },
    )).toMatchObject({ agentSelectionKey: 'ttadk-x-codex' });
    expect(botDefaultsPayload(
      { larkAppId: 'app_a', botName: 'BotA', cliId: 'codex', wrapperCli: 'cjadk codex' },
      { defaultOncall: { enabled: false } },
    )).toMatchObject({ agentSelectionKey: 'cjadk-x-codex' });

    // 无 cliId（配置缺失）→ 不下发 agentSelectionKey，前端回落默认 claude-code。
    expect(botDefaultsPayload({ larkAppId: 'app_a' }, {}))
      .not.toHaveProperty('agentSelectionKey');
  });

  it('passes through displayName / larkBotName and normalizes missing to null', () => {
    const daemon = { larkAppId: 'app_a', botName: '小助手', cliId: 'codex' };
    expect(botDefaultsPayload(daemon, { displayName: '小助手', larkBotName: 'Claude' })).toMatchObject({
      displayName: '小助手',
      larkBotName: 'Claude',
    });
    // Unset custom name / probe not landed yet → both null.
    expect(botDefaultsPayload(daemon, {})).toMatchObject({ displayName: null, larkBotName: null });
    expect(botDefaultsPayload(daemon, { displayName: 42, larkBotName: {} })).toMatchObject({
      displayName: null,
      larkBotName: null,
    });
  });

  it('passes through defaultWorkingDir (string) and normalizes missing to null', () => {
    const daemon = { larkAppId: 'app_a', botName: 'BotA', cliId: 'codex' };
    expect(botDefaultsPayload(daemon, { defaultWorkingDir: '/root/iserver/botmux' })).toMatchObject({
      defaultWorkingDir: '/root/iserver/botmux',
    });
    // Missing / non-string → null (the "off" or "oncall" modes carry no defaultWorkingDir).
    expect(botDefaultsPayload(daemon, {}).defaultWorkingDir).toBeNull();
    expect(botDefaultsPayload(daemon, { defaultWorkingDir: 123 }).defaultWorkingDir).toBeNull();
  });

  it('defaults auto grant request cards on and preserves explicit off', () => {
    const daemon = { larkAppId: 'app_a', botName: 'BotA', cliId: 'codex' };
    expect(botDefaultsPayload(daemon, {})).toMatchObject({
      autoGrantRequestCards: true,
    });
    expect(botDefaultsPayload(daemon, { autoGrantRequestCards: false })).toMatchObject({
      autoGrantRequestCards: false,
    });
  });

  it('passes substituteMode through for bot defaults', () => {
    const daemon = { larkAppId: 'app_a', botName: 'BotA', cliId: 'codex' };
    const substituteMode = {
      enabled: true,
      targets: [{ userId: 'u_alice', name: 'Alice' }],
      disclosure: 'prefix',
    };
    expect(botDefaultsPayload(daemon, { substituteMode })).toMatchObject({
      substituteMode,
    });
    expect(botDefaultsPayload(daemon, {})).toMatchObject({
      substituteMode: null,
    });
  });

  it('projects dashboard summary range for /api/bots', () => {
    const daemon = { larkAppId: 'app_a', botName: 'BotA', cliId: 'codex' };
    expect(botDefaultsPayload(daemon, {})).toMatchObject({
      summaryRange: {
        limit: 50,
        sinceHours: 24,
      },
    });
    expect(botDefaultsPayload(daemon, {
      summaryRange: { limit: 12, sinceHours: 6 },
    })).toMatchObject({
      summaryRange: {
        limit: 12,
        sinceHours: 6,
      },
    });
    expect(botDefaultsPayload(daemon, {
      contentTriggers: [{
        name: 'dashboard-default-summary-trigger',
        enabled: true,
        scope: 'both',
        match: { type: 'keyword', pattern: '本次问题已解决', caseSensitive: false },
        history: {
          topic: { mode: 'current-thread' },
          regularGroup: { mode: 'recent-messages', limit: 0, sinceHours: 0 },
        },
        action: { type: 'start-or-wake-session', prompt: 'summary' },
      }],
    })).toMatchObject({
      summaryRange: {
        limit: 0,
        sinceHours: 0,
      },
    });
  });
});
