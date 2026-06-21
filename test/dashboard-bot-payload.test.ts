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
});
