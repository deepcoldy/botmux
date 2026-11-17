import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const transport = vi.hoisted(() => ({ read: vi.fn(), create: vi.fn(), reply: vi.fn() }));
vi.mock('@larksuiteoapi/node-sdk', () => ({
  Client: class {
    constructor(readonly options: { appId: string }) {}
    request = (request: unknown) => transport.read(this.options.appId, request);
    im = { v1: { chatMembers: { create: (request: unknown) => transport.create(this.options.appId, request) } } };
  },
}));
vi.mock('../src/im/lark/client.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/im/lark/client.js')>(),
  replyMessage: (...args: unknown[]) => transport.reply(...args),
}));

import { __testOnly_resetBotRegistry, getBot, loadBotConfigs, registerBot } from '../src/bot-registry.js';
import { config } from '../src/config.js';
import { __testOnly_resetLarkGate } from '../src/im/lark/api-gate.js';
import { __testOnly_resetAllBotClients } from '../src/im/lark/client.js';
import { tryHandleInviteCommand } from '../src/im/lark/invite-command.js';

const INVITER = 'cli_inviter';
const TARGET = 'cli_target';
const OWNER = 'ou_owner';
let fixture: string;

function message() {
  return {
    message_id: 'om_invite', chat_id: 'oc_group', chat_type: 'group',
    content: JSON.stringify({ text: '@_user_1 /invite all' }),
    mentions: [{ key: '@_user_1', id: { open_id: 'ou_inviter' }, name: 'Inviter' }],
  };
}

beforeEach(() => {
  fixture = mkdtempSync(join(tmpdir(), 'invite-integration-'));
  vi.stubEnv('BOTS_CONFIG', join(fixture, 'bots.json'));
  vi.stubEnv('BOTMUX_LARK_QPS', '1000');
  vi.stubEnv('BOTMUX_LARK_GATE_RETRY_MAX_ATTEMPTS', '0');
  __testOnly_resetBotRegistry();
  __testOnly_resetAllBotClients();
  __testOnly_resetLarkGate();
  config.session.dataDir = fixture;
  writeFileSync(process.env.BOTS_CONFIG!, JSON.stringify([
    { larkAppId: INVITER, larkAppSecret: 'fake', cliId: 'codex', allowedUsers: [OWNER], inviteConfig: { agents: [TARGET] } },
    { larkAppId: TARGET, larkAppSecret: 'fake', cliId: 'claude-code' },
  ]));
  // Production has one registered bot per daemon; other bots only exist in bots.json.
  const bot = registerBot(loadBotConfigs().find(entry => entry.larkAppId === INVITER)!);
  bot.botOpenId = 'ou_inviter';
  bot.resolvedAllowedUsers = [OWNER];
  transport.read.mockReset().mockResolvedValue({ code: 0, data: { is_in_chat: false } });
  transport.create.mockReset().mockResolvedValue({ code: 0, data: {} });
  transport.reply.mockReset().mockResolvedValue('om_reply');
});

afterEach(() => {
  __testOnly_resetAllBotClients();
  __testOnly_resetBotRegistry();
  vi.unstubAllEnvs();
  rmSync(fixture, { recursive: true, force: true });
});

describe('/invite all with the production registry and membership client', () => {
  it('probes another daemon\'s configured bot and invites through the addressed bot', async () => {
    expect(() => getBot(TARGET)).toThrow();
    await tryHandleInviteCommand(INVITER, message(), OWNER);
    expect(transport.read).toHaveBeenCalledWith(TARGET, expect.objectContaining({
      url: '/open-apis/im/v1/chats/oc_group/members/is_in_chat',
    }));
    expect(transport.create).toHaveBeenCalledWith(INVITER, {
      path: { chat_id: 'oc_group' }, params: { member_id_type: 'app_id' }, data: { id_list: [TARGET] },
    });
    expect(() => getBot(TARGET)).toThrow();
  });

  it('skips an existing member without registering that bot locally', async () => {
    transport.read.mockResolvedValue({ code: 0, data: { is_in_chat: true } });
    await tryHandleInviteCommand(INVITER, message(), OWNER);
    expect(transport.read).toHaveBeenCalledOnce();
    expect(transport.create).not.toHaveBeenCalled();
    expect(() => getBot(TARGET)).toThrow();
  });

  it.each([
    { code: 99991672, msg: 'scope missing', data: { is_in_chat: false } },
    { code: 0, data: {} },
    { code: 0, data: { is_in_chat: 'false' } },
    { data: { is_in_chat: false } },
  ])('does not treat an unknown membership response as absence: %j', async response => {
    transport.read.mockResolvedValue(response);
    await tryHandleInviteCommand(INVITER, message(), OWNER);
    expect(transport.read).toHaveBeenCalledOnce();
    expect(transport.create).not.toHaveBeenCalled();
    expect(transport.reply).toHaveBeenCalledOnce();
  });

  it('does not invite after a transport failure and can retry after recovery', async () => {
    transport.read.mockRejectedValueOnce(new Error('membership unavailable'));
    await tryHandleInviteCommand(INVITER, message(), OWNER);
    expect(transport.create).not.toHaveBeenCalled();
    await tryHandleInviteCommand(INVITER, message(), OWNER);
    expect(transport.create).toHaveBeenCalledOnce();
  });
});
