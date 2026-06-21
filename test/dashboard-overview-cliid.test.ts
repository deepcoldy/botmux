import { describe, expect, it } from 'vitest';
import { __setGroupsSnapshotForTest, buildBotCards } from '../src/dashboard/web/overview.js';

describe('dashboard overview bot cards', () => {
  it('uses /api/groups cliId for a sessionless online bot', () => {
    __setGroupsSnapshotForTest({
      chats: [],
      bots: [{
        larkAppId: 'cli_traex',
        botName: 'TraeX',
        botAvatarUrl: 'https://example.test/avatar.png',
        cliId: 'traex',
      }],
    });

    expect(buildBotCards([])).toEqual([expect.objectContaining({
      larkAppId: 'cli_traex',
      botName: 'TraeX',
      cliId: 'traex',
      online: true,
    })]);
  });
});
