import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('@larksuiteoapi/node-sdk', () => ({ Client: class {} }));
vi.mock('../src/im/lark/client.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/im/lark/client.js')>(),
  getChatMode: vi.fn(async () => 'group'),
}));

import { config } from '../src/config.js';
import { registerBot, __testOnly_resetBotRegistry } from '../src/bot-registry.js';
import { getChatMode } from '../src/im/lark/client.js';
import { recordTeamBot } from '../src/services/team-bots-store.js';
import { resolvePluginCardPrivileges } from '../src/core/plugins/card-actions/privileges.js';

describe('plugin card operator privileges', () => {
  let dataDir: string;
  let previousDataDir: string;

  beforeEach(() => {
    previousDataDir = config.session.dataDir;
    dataDir = mkdtempSync(join(tmpdir(), 'botmux-plugin-privileges-'));
    config.session.dataDir = dataDir;
    __testOnly_resetBotRegistry();
    const bot = registerBot({ larkAppId: 'cli_privileges', larkAppSecret: 'secret', cliId: 'codex', allowedUsers: ['ou_owner'] });
    bot.resolvedAllowedUsers = ['ou_owner'];
    bot.config.p2pOpen = true;
    vi.mocked(getChatMode).mockResolvedValue('group');
  });

  afterEach(() => {
    config.session.dataDir = previousDataDir;
    __testOnly_resetBotRegistry();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('gives a trusted team bot both operate and talk authority from its verified union', async () => {
    recordTeamBot(dataDir, { unionId: 'on_team_bot', name: 'TeamBot' });
    expect(await resolvePluginCardPrivileges('cli_privileges', {
      operator: { open_id: 'ou_team_bot', union_id: 'on_team_bot' },
      context: { open_chat_id: 'oc_group' },
    })).toEqual({ canOperate: true, canTalk: true });
  });

  it('allows p2pOpen talk only for the host-resolved private chat, not forged card values', async () => {
    const data = {
      operator: { open_id: 'ou_guest' }, context: { open_chat_id: 'oc_chat' },
      action: { value: { chat_type: 'p2p', canOperate: true, union_id: 'on_team_bot' } },
    };
    expect(await resolvePluginCardPrivileges('cli_privileges', data)).toEqual({ canOperate: false, canTalk: false });
    vi.mocked(getChatMode).mockResolvedValue('p2p');
    expect(await resolvePluginCardPrivileges('cli_privileges', data)).toEqual({ canOperate: false, canTalk: true });
    expect(getChatMode).toHaveBeenLastCalledWith('cli_privileges', 'oc_chat');
  });
});
