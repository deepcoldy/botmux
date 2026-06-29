import { describe, expect, it } from 'vitest';
import { botDefaultsPayload, botSummaryPayload } from '../src/dashboard/bot-payload.js';

describe('dashboard bot payload helpers', () => {
  it('includes authoritative cliId in group roster bot summaries', () => {
    expect(botSummaryPayload({
      larkAppId: 'cli_traex',
      botOpenId: 'ou_traex',
      botName: 'TraeX',
      botAvatarUrl: 'https://example.test/avatar.png',
      cliId: 'traex',
    })).toEqual({
      larkAppId: 'cli_traex',
      botOpenId: 'ou_traex',
      botName: 'TraeX',
      botAvatarUrl: 'https://example.test/avatar.png',
      cliId: 'traex',
    });
  });

  it('includes authoritative cliId in /api/bots success and error rows', () => {
    const daemon = { larkAppId: 'cli_traex', botName: 'TraeX', cliId: 'traex' };
    expect(botDefaultsPayload(daemon, { defaultOncall: { enabled: false } })).toMatchObject({
      larkAppId: 'cli_traex',
      botName: 'TraeX',
      cliId: 'traex',
      online: true,
      defaultOncall: { enabled: false },
    });
    expect(botDefaultsPayload(daemon, undefined, 'http_503')).toMatchObject({
      larkAppId: 'cli_traex',
      botName: 'TraeX',
      cliId: 'traex',
      online: true,
      error: 'http_503',
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
