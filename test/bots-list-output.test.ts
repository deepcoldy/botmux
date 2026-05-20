import { describe, expect, it } from 'vitest';

import {
  formatBotInfoEntriesForCli,
  formatChatBotsForCli,
} from '../src/cli/bots-list-output.js';

describe('botmux bots list CLI output mapping', () => {
  it('includes larkAppId and workflowBot for chat-member results', () => {
    const rows = formatChatBotsForCli([
      {
        larkAppId: 'cli_self',
        openId: 'ou_self',
        name: 'codex',
        displayName: 'Codex Loopy',
        source: 'configured',
      },
      {
        larkAppId: 'cli_peer',
        openId: 'ou_peer',
        name: 'claude',
        displayName: 'Claude Loopy',
        source: 'configured',
      },
      {
        larkAppId: '',
        openId: 'ou_external',
        name: 'external-loopy',
        displayName: 'External Loopy',
        source: 'introduce',
      },
    ], 'cli_self');

    expect(rows).toEqual([
      {
        name: 'Codex Loopy',
        openId: 'ou_self',
        isSelf: true,
        source: 'configured',
        larkAppId: 'cli_self',
        workflowBot: 'cli_self',
      },
      {
        name: 'Claude Loopy',
        openId: 'ou_peer',
        isSelf: false,
        source: 'configured',
        larkAppId: 'cli_peer',
        workflowBot: 'cli_peer',
      },
      {
        name: 'External Loopy',
        openId: 'ou_external',
        isSelf: false,
        source: 'introduce',
        larkAppId: '',
        workflowBot: null,
      },
    ]);
  });

  it('includes larkAppId and workflowBot for bots-info fallback rows', () => {
    const rows = formatBotInfoEntriesForCli([
      {
        larkAppId: 'cli_self',
        botOpenId: 'ou_self',
        botName: null,
        cliId: 'codex',
      },
      {
        larkAppId: 'cli_peer',
        botOpenId: 'ou_peer',
        botName: 'Claude Loopy',
        cliId: 'claude',
      },
      {
        larkAppId: 'cli_missing_openid',
        botOpenId: null,
        botName: 'Missing',
        cliId: 'codex',
      },
    ], 'cli_self');

    expect(rows).toEqual([
      {
        name: 'codex',
        openId: 'ou_self',
        isSelf: true,
        source: 'configured',
        larkAppId: 'cli_self',
        workflowBot: 'cli_self',
      },
      {
        name: 'Claude Loopy',
        openId: 'ou_peer',
        isSelf: false,
        source: 'configured',
        larkAppId: 'cli_peer',
        workflowBot: 'cli_peer',
      },
    ]);
  });
});
