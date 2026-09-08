import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';

const transport = vi.hoisted(() => ({
  name: 'Group', description: '', mode: 'group', writes: 0,
  callbacks: {} as Record<string, (data: any) => void>,
  replies: [] as string[],
}));
vi.mock('@larksuiteoapi/node-sdk', () => ({
  Client: class {
    request = async () => ({ code: 0, data: {
      name: transport.name, description: transport.description, chat_mode: transport.mode,
      user_count: 3, bot_count: 2, is_in_chat: true, items: [],
    } });
    im = { v1: {
      chat: { update: async ({ data }: any) => {
        transport.writes++; Object.assign(transport, data); return { code: 0 };
      } },
      message: { reply: async ({ data }: any) => {
        transport.replies.push(data.content); return { code: 0, data: { message_id: 'om_reply' } };
      } },
    } };
  },
  EventDispatcher: class {
    register(handlers: typeof transport.callbacks) { transport.callbacks = handlers; return this; }
  },
  WSClient: class {
    start = async () => {};
    getConnectionStatus = () => ({ state: 'connected' });
  },
  Domain: { Feishu: 'feishu', Lark: 'lark' }, LoggerLevel: { info: 2, warn: 3 },
}));
vi.mock('../src/im/lark/client.js', async (original) => ({
  ...await original<typeof import('../src/im/lark/client.js')>(),
  isHumanOpenId: async () => true,
  getUserProfile: async () => null,
}));

import { registerBot } from '../src/bot-registry.js';
import { config } from '../src/config.js';
import { startLarkEventDispatcher, rawMessageIngressAnchor } from '../src/im/lark/event-dispatcher.js';
import { serializeByAnchor } from '../src/utils/anchor-serializer.js';
import { isChatManager } from '../src/services/chat-manager.js';
import { tryHandleManagerCommand } from '../src/im/lark/manager-command.js';
import { normalizePassthroughCommand } from '../src/core/passthrough-commands.js';

const APP = 'cli_command';
const CHAT = 'oc_command';
const OWNER = 'ou_owner';
const SELF = 'ou_self';
const testRoot = config.session.dataDir;
let seq = 0;
const handlers = {
  handleNewTopic: vi.fn(async () => {}), handleThreadReply: vi.fn(async () => {}),
  handleCardAction: vi.fn(async () => {}), isSessionOwner: vi.fn(() => false),
};

async function deliver(text: string, opts: { sender?: string; mentions?: string[]; type?: string; thread?: boolean } = {}) {
  const event = {
    sender: { sender_type: 'user', sender_id: { open_id: opts.sender ?? OWNER } },
    message: {
      message_id: `om_manager_${++seq}`, chat_id: CHAT, chat_type: opts.type ?? 'group',
      message_type: 'text', content: JSON.stringify({ text }),
      ...(opts.thread ? { root_id: 'om_topic', thread_id: 'omt_topic' } : {}),
      mentions: (opts.mentions ?? [SELF]).map((id, i) => ({ key: `@_user_${i}`, name: id, id: { open_id: id } })),
    },
  };
  transport.callbacks['im.message.receive_v1'](event);
  // The production callback schedules its ingress with FIFO setImmediate.
  // Queue a fence after it, then wait for the canonical chat delivery as well.
  await new Promise<void>(resolve => setImmediate(resolve));
  await serializeByAnchor(rawMessageIngressAnchor(APP, event.message), async () => {}, 0);
  await serializeByAnchor(CHAT, async () => {}, 0);
}

describe('/manager through the registered Lark event handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    config.session.dataDir = mkdtempSync(join(testRoot, 'manager-command-'));
    config.daemon.forwardFollowupWaitMs = 0;
    Object.assign(transport, { name: 'Group', description: '', mode: 'group', writes: 0, replies: [] });
    const bot = registerBot({ larkAppId: APP, larkAppSecret: 'test', cliId: 'codex', displayName: 'Manager',
      allowedUsers: [OWNER], regularGroupReplyMode: 'chat', autoGrantRequestCards: false });
    bot.botOpenId = SELF; bot.resolvedAllowedUsers = [OWNER];
    bot.config.chatGrants = { [CHAT]: ['ou_guest'] };
    startLarkEventDispatcher(APP, 'test', handlers);
  });

  it('sets and clears without spawning a CLI session', async () => {
    await deliver('/manager set');
    expect(await isChatManager(APP, CHAT)).toBe(true);
    expect(transport.writes).toBe(1);
    expect(handlers.handleNewTopic).not.toHaveBeenCalled();
    expect(handlers.handleThreadReply).not.toHaveBeenCalled();
    await deliver('/manager clear');
    expect(await isChatManager(APP, CHAT)).toBe(false);
    expect(transport.name).toBe('Group');
  });

  it('ignores non-text messages safely and reserves the command against CLI passthrough', async () => {
    expect(await tryHandleManagerCommand(APP, { message_type: 'image', content: '{}' }, OWNER, true)).toBe(false);
    expect(normalizePassthroughCommand('/manager')).toBeNull();
  });

  it('uses the actual incoming sender, not a session owner, for mutations', async () => {
    await deliver('/manager set', { sender: 'ou_guest' });
    expect(transport.writes).toBe(0);
    expect(await isChatManager(APP, CHAT)).toBe(false);
    expect(handlers.handleNewTopic).not.toHaveBeenCalled();
    expect(handlers.handleThreadReply).not.toHaveBeenCalled();
  });

  it('lets a talk-authorized guest read status without granting management', async () => {
    await deliver('/manager status', { sender: 'ou_guest' });
    expect(transport.replies).toHaveLength(1);
    expect(transport.writes).toBe(0);
    expect(handlers.handleNewTopic).not.toHaveBeenCalled();
  });

  it('requires exactly one explicitly addressed bot for mutation', async () => {
    await deliver('/manager set', { mentions: [] });
    await deliver('/manager set', { mentions: [SELF, 'ou_other_bot'] });
    expect(transport.writes).toBe(0);
    expect(handlers.handleNewTopic).not.toHaveBeenCalled();
  });

  it('rejects DMs, native topics and invalid arguments without CLI fallback', async () => {
    await deliver('/manager set', { type: 'p2p' });
    await deliver('/manager set', { thread: true });
    await deliver('/manager set unexpected');
    transport.mode = 'topic';
    await deliver('/manager set');
    expect(transport.writes).toBe(0);
    expect(handlers.handleNewTopic).not.toHaveBeenCalled();
    expect(handlers.handleThreadReply).not.toHaveBeenCalled();
  });

  it('routes unmentioned messages only while the manager is enabled', async () => {
    await deliver('/manager set');
    await deliver('hello', { mentions: [] });
    expect(handlers.handleNewTopic).toHaveBeenCalledTimes(1);
    expect(handlers.handleNewTopic).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ scope: 'chat', anchor: CHAT }));
    await deliver('for someone else', { mentions: ['ou_other_bot'] });
    expect(handlers.handleNewTopic).toHaveBeenCalledTimes(1);
    await deliver('/manager clear');
    await deliver('no longer addressed', { mentions: [] });
    expect(handlers.handleNewTopic).toHaveBeenCalledTimes(1);
  });
});
