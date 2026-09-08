import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const remote = vi.hoisted(() => ({
  description: '[botmux:manager=cli_manager]', mode: 'group', fail: false, reads: 0,
}));
vi.mock('@larksuiteoapi/node-sdk', () => ({
  Client: class {
    request = async () => {
      remote.reads++;
      if (remote.fail) throw new Error('offline');
      return { code: 0, data: {
        description: remote.description, chat_mode: remote.mode,
        user_count: 3, bot_count: 2, name: 'Group',
      } };
    };
  },
  Domain: { Feishu: 'feishu', Lark: 'lark' },
  LoggerLevel: { info: 2 },
}));

import { registerBot } from '../src/bot-registry.js';
import { config } from '../src/config.js';
import { checkGroupMessageAccess, canOperate, __resetChatStatsForTest } from '../src/im/lark/event-dispatcher.js';

const APP = 'cli_manager';
const CHAT = 'oc_managed';
const OWNER = 'ou_owner';

function record(app = APP, chat = CHAT, enabled = true) {
  const root = join(config.session.dataDir, 'chat-managers');
  mkdirSync(root, { recursive: true });
  const key = createHash('sha256').update(`${app}\0${chat}`).digest('hex');
  writeFileSync(join(root, `${key}.json`), JSON.stringify({
    schemaVersion: 1, larkAppId: app, chatId: chat, enabled,
    originalName: 'Group', managedName: 'Group · Manager',
  }));
}

function message(mentions: string[] = [], thread = false) {
  return {
    chat_id: CHAT, chat_type: 'group', message_id: 'om_input',
    ...(thread ? { root_id: 'om_root', thread_id: 'omt_thread' } : {}),
    message_type: 'text', content: JSON.stringify({ text: 'hello' }),
    mentions: mentions.map((id, i) => ({ key: `@_user_${i}`, id: { open_id: id } })),
  };
}

describe('chat manager addressing through the real permission gate', () => {
  beforeEach(() => {
    remote.description = `[botmux:manager=${APP}]`;
    remote.mode = 'group'; remote.fail = false; remote.reads = 0;
    __resetChatStatsForTest();
    for (const app of [APP, 'cli_other']) {
      const bot = registerBot({ larkAppId: app, larkAppSecret: 'test', cliId: 'codex', allowedUsers: [OWNER] });
      bot.botOpenId = `ou_${app}`;
      bot.resolvedAllowedUsers = [OWNER];
    }
    record();
  });

  it('lets the designated manager answer an authorized unmentioned group message', async () => {
    expect(await checkGroupMessageAccess(APP, message(), CHAT, OWNER)).toBe('allowed');
  });

  it('does not grant talk or operate permission to an unauthorized sender', async () => {
    expect(await checkGroupMessageAccess(APP, message(), CHAT, 'ou_stranger')).toBe('ignore');
    expect(await checkGroupMessageAccess(APP, message([`ou_${APP}`]), CHAT, 'ou_stranger')).toBe('not_allowed');
    expect(canOperate(APP, CHAT, 'ou_stranger')).toBe(false);
  });

  it('yields when only another bot or human is mentioned', async () => {
    expect(await checkGroupMessageAccess(APP, message(['ou_other']), CHAT, OWNER)).toBe('ignore');
  });

  it('still responds when explicitly mentioned together with another member', async () => {
    expect(await checkGroupMessageAccess(APP, message([`ou_${APP}`, 'ou_other']), CHAT, OWNER)).toBe('allowed');
  });

  it('does not treat @all as a redirect', async () => {
    expect(await checkGroupMessageAccess(APP, message(['all']), CHAT, OWNER)).toBe('allowed');
  });

  it('does not activate a bot merely because its app ID was put in the description', async () => {
    record(APP, CHAT, false);
    expect(await checkGroupMessageAccess(APP, message(), CHAT, OWNER)).toBe('ignore');
  });

  it('stops the old manager after a cross-machine handover without a daemon restart', async () => {
    expect(await checkGroupMessageAccess(APP, message(), CHAT, OWNER)).toBe('allowed');
    remote.description = '[botmux:manager=cli_other]';
    record('cli_other');
    expect(await checkGroupMessageAccess(APP, message(), CHAT, OWNER)).toBe('ignore');
    expect(await checkGroupMessageAccess('cli_other', message(), CHAT, OWNER)).toBe('allowed');
  });

  it('fails closed when the shared claim cannot be read', async () => {
    remote.fail = true;
    expect(await checkGroupMessageAccess(APP, message(['all']), CHAT, OWNER)).toBe('ignore');
  });

  it('does not claim messages inside independent topics or topic-mode groups', async () => {
    expect(await checkGroupMessageAccess(APP, message([], true), CHAT, OWNER)).toBe('ignore');
    remote.mode = 'topic';
    expect(await checkGroupMessageAccess(APP, message(), CHAT, OWNER)).toBe('ignore');
  });

  it('does not change another group', async () => {
    expect(await checkGroupMessageAccess(APP, message(), 'oc_other_group', OWNER)).toBe('ignore');
  });
});
