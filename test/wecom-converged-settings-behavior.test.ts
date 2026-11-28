/**
 * What the gateway does now that the WeCom-only settings that changed it are
 * gone (the Dashboard convergence of the WeCom-only tiles), through the real
 * bridge with an in-process transport and core:
 *  - a group message is handled whatever its first character (no "commands
 *    only" admission);
 *  - /help and /commands answer from the command table, as a template card or,
 *    without card support, as text with the same lines;
 *  - a task's reply goes back to the conversation it came from, and the
 *    terminal link of a card still reaches the clicker privately;
 *  - a state file an earlier version wrote (business data, first contacts,
 *    task fields of removed features) loads and is left as it is, and a click
 *    on an old business card changes nothing.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WecomBridge, type WecomBridgePolicy } from '../src/im/wecom/gateway/bridge.js';
import { parseWecomConfig } from '../src/im/wecom/config/config.js';
import { NATIVE_WECOM_COMMANDS } from '../src/im/wecom/gateway/native-commands.js';
import type { WecomCardEvent, WecomInboundMessage, WecomTemplateCard } from '../src/im/wecom/protocol/types.js';
import type { TerminalMintClient } from '../src/im/wecom/gateway/bridge/terminal-mint.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function harness(policy: WecomBridgePolicy, options: { cards?: boolean; state?: unknown; terminalMintClient?: TerminalMintClient } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'wecom-converged-'));
  dirs.push(root);
  const stateFile = join(root, 'state.json');
  if (options.state) writeFileSync(stateFile, JSON.stringify(options.state));
  const replies: Array<{ to: string; text: string; finish?: boolean }> = [];
  const sends: Array<{ to: string; text: string }> = [];
  const cards: Array<{ to: string; card: WecomTemplateCard }> = [];
  let failReplies = false;
  const transport = {
    reply: vi.fn(async (message: WecomInboundMessage, text: string, o?: { finish?: boolean }) => {
      if (failReplies && o?.finish !== false) throw new Error('callback expired');
      replies.push({ to: message.conversationId, text, finish: o?.finish });
    }),
    send: vi.fn(async (to: string, text: string) => { sends.push({ to, text }); }),
    ...(options.cards === false ? {} : {
      sendCard: vi.fn(async (to: string, card: WecomTemplateCard) => { cards.push({ to, card }); }),
      updateCard: vi.fn(async () => {}),
    }),
  };
  let done = false;
  const core = {
    trigger: vi.fn(async () => ({ ok: true, triggerId: 't1', target: { kind: 'turn' as const, sessionId: 's1' } })),
    result: vi.fn(async () => (done
      ? { ok: true, state: 'completed' as const, output: { content: 'the answer' } }
      : { ok: true, state: 'running' as const })),
    interrupt: vi.fn(async () => {}),
  };
  const bridge = new WecomBridge({
    botId: 'bot',
    connectionId: 'c'.repeat(64),
    allowedUsers: policy.allowedUsers,
    policy: () => policy,
    stateFile,
    transport,
    core,
    // No other WeCom connection on this host.
    peerRoot: root,
    ...(options.terminalMintClient ? { terminalMintClient: options.terminalMintClient } : {}),
  });
  return {
    bridge, stateFile, transport, core, replies, sends, cards,
    finish: () => { done = true; },
    failReplies: () => { failReplies = true; },
    state: () => JSON.parse(readFileSync(stateFile, 'utf8')),
  };
}

const groupMessage = (text: string, id = 'm1', userId = 'alice'): WecomInboundMessage =>
  ({ messageId: id, userId, conversationId: 'room', chatType: 'group', text, attachments: [], replyContext: { requestId: id } });
const privateMessage = (text: string, id = 'p1', userId = 'alice'): WecomInboundMessage =>
  ({ messageId: id, userId, conversationId: userId, chatType: 'single', text, attachments: [], replyContext: { requestId: id } });

describe('group messages', () => {
  // Mutation: restoring a "commands only" admission for group messages turns this red.
  it('handles a group message that does not start with /, also under a configuration that once asked for commands only', async () => {
    const config = parseWecomConfig({
      botId: 'bot', secretEnv: 'FAKE_WECOM_SECRET', coreUrl: 'http://127.0.0.1:19801', allowedUsers: ['alice'],
      native: { regularGroupMentionMode: 'command' },
    });
    for (const policy of [
      { ...config.native, allowedUsers: config.allowedUsers, disableStreamingCard: true },
      // A policy that still carries the retired switch changes nothing either.
      { allowedUsers: ['alice'], disableStreamingCard: true, regularGroupMentionMode: 'command' } as WecomBridgePolicy,
    ]) {
      const h = harness(policy);
      await h.bridge.receive(groupMessage('please look at the build'));
      await h.bridge.tick();
      expect(h.core.trigger).toHaveBeenCalledTimes(1);
      expect((h.core.trigger.mock.calls[0] as unknown as [{ envelope: { rawText: string } }])[0].envelope.rawText).toContain('please look at the build');
    }
  });
});

describe('/help and /commands', () => {
  /** The commands the help must list: the gateway's own and the shared ones it answers. */
  const expected = [
    ...Object.keys(NATIVE_WECOM_COMMANDS),
    '/status', '/stop', '/restart',
  ];
  const removed = ['/business', '/assist', '/delegate'];
  /** The command each help line starts with. */
  const commandsOf = (lines: string[]) => lines.map(line => /^\/[a-z-]+/.exec(line)?.[0]).filter((c): c is string => !!c);
  const cardLines = (card: WecomTemplateCard) => [
    ...(card.sub_title_text ?? '').split('\n'),
    ...(card.vertical_content_list ?? []).flatMap(item => (item.desc ?? '').split('\n')),
  ].filter(Boolean);

  // Mutation: dropping a command from the help data, or a hand-written list in either reply, turns this red.
  it('answers with a template card listing every command, within the platform limits, when cards can be sent', async () => {
    for (const text of ['/help', '/commands']) {
      const h = harness({ allowedUsers: ['alice'] });
      await h.bridge.receive(groupMessage(text));
      expect(h.replies).toEqual([]);
      expect(h.cards).toHaveLength(1);
      const { to, card } = h.cards[0]!;
      expect(to).toBe('room');
      const listed = commandsOf(cardLines(card));
      expect([...new Set(listed)].sort()).toEqual([...expected].sort());
      for (const command of removed) expect(listed).not.toContain(command);
      // WeCom template card limits: text fields up to 112 characters, at most four vertical items with titles up to 26.
      expect((card.sub_title_text ?? '').length).toBeLessThanOrEqual(112);
      expect((card.vertical_content_list ?? []).length).toBeLessThanOrEqual(4);
      for (const item of card.vertical_content_list ?? []) {
        expect(item.title.length).toBeLessThanOrEqual(26);
        expect((item.desc ?? '').length).toBeLessThanOrEqual(112);
      }
      // No jump to the admin console on the card any more.
      expect(card.jump_list).toBeUndefined();
    }
  });

  it('answers with the same lines as text when cards cannot be sent', async () => {
    const withCards = harness({ allowedUsers: ['alice'] });
    await withCards.bridge.receive(groupMessage('/help'));
    const h = harness({ allowedUsers: ['alice'] }, { cards: false });
    await h.bridge.receive(groupMessage('/help'));
    expect(h.replies).toHaveLength(1);
    const lines = h.replies[0]!.text.split('\n').filter(line => line.startsWith('/'));
    expect(lines).toEqual(cardLines(withCards.cards[0]!.card));
    for (const command of removed) expect(commandsOf(lines)).not.toContain(command);
  });
});

describe('where replies go', () => {
  // Mutation: answering a group task anywhere but its group (e.g. the requester) turns this red.
  it('answers a group task in its group, also when the callback reply fails and the answer goes out as a new message', async () => {
    const h = harness({ allowedUsers: ['alice'], disableStreamingCard: true });
    await h.bridge.receive(groupMessage('question'));
    await h.bridge.tick();
    h.finish();
    await h.bridge.tick();
    expect(h.replies).toEqual([expect.objectContaining({ to: 'room', text: expect.stringContaining('the answer') })]);
    expect(h.sends).toEqual([]);

    const failing = harness({ allowedUsers: ['alice'], disableStreamingCard: true });
    await failing.bridge.receive(groupMessage('question'));
    await failing.bridge.tick();
    failing.failReplies();
    failing.finish();
    await failing.bridge.tick();
    expect(failing.sends.length).toBeGreaterThan(0);
    expect(failing.sends.every(send => send.to === 'room')).toBe(true);
    expect(failing.sends.map(send => send.text).join('')).toContain('the answer');
  });

  it('answers a private task in the private chat', async () => {
    const h = harness({ allowedUsers: ['alice'], disableStreamingCard: true });
    await h.bridge.receive(privateMessage('question'));
    await h.bridge.tick();
    h.finish();
    await h.bridge.tick();
    expect(h.replies).toEqual([expect.objectContaining({ to: 'alice', text: expect.stringContaining('the answer') })]);
  });

  // Mutation: sending the link to the conversation of the card turns this red.
  it('sends the terminal link of a group task\'s card privately to the person who clicked it', async () => {
    const url = 'http://127.0.0.1:1/wecom-native-terminal/exchange?code=fixture';
    const mint: TerminalMintClient = { request: async () => ({ status: 200, body: { ok: true, url, expiresAt: Date.now() + 60_000 } }) as never };
    const h = harness({ allowedUsers: ['alice'], disableStreamingCard: true, replyCardActions: true }, { terminalMintClient: mint });
    await h.bridge.receive(groupMessage('question'));
    await h.bridge.tick();
    h.finish();
    await h.bridge.tick();
    const task = Object.values(h.state().tasks)[0] as { streamId: string; delivered: boolean };
    expect(task.delivered).toBe(true);
    const event: WecomCardEvent = {
      messageId: 'click-1', botId: 'bot', userId: 'alice', conversationId: 'room', chatType: 'group',
      requestId: 'click-1', taskId: `${task.streamId}-final`, eventKey: 'action:terminal', receivedAt: Date.now(),
    };
    await h.bridge.receiveCardEvent(event);
    const withLink = h.sends.filter(send => send.text.includes(url));
    expect(withLink).toEqual([{ to: 'alice', text: expect.any(String) }]);
    expect(h.replies.some(reply => reply.text.includes(url))).toBe(false);
  });
});

describe('a state file of an earlier version', () => {
  const earlier = {
    version: 1,
    botId: 'bot',
    routes: {},
    seen: {},
    firstContacts: { [('f').repeat(64)]: { messageId: 'old-message', at: 1 } },
    tasks: {
      old: {
        message: groupMessage('old question', 'old-message'),
        route: 'old-route',
        streamId: 'old',
        createdAt: 1,
        request: { source: { type: 'webhook', connectorId: 'wecom:bot', requestId: 'old-message' }, target: { kind: 'turn' }, envelope: { format: 'text', sourceName: 'x', trusted: false, rawText: 'old question' } },
        sessionId: 'old-session',
        triggerId: 'old-turn',
        result: 'old answer',
        delivered: true,
        deliveryPrivate: true,
        nativeDelivery: { capability: 'a'.repeat(64), expiresAt: 2, status: 'delivered' },
        nativeThinking: 'old thinking',
        styledCardAttempted: true,
        modelFinal: true,
        privateCloseAttempted: true,
        firstContactCommand: '/status',
        firstContactCommandStatus: 'completed',
        finalCardAttempted: true,
        controlsCardAttempted: true,
      },
    },
  };

  // Mutation: dropping or rewriting the retired data on load (or touching the business file) turns this red.
  it('loads, runs new turns, and leaves the retired business data and first contacts as they were', async () => {
    const h = harness({ allowedUsers: ['alice'], disableStreamingCard: true }, { state: earlier });
    const business = `${h.stateFile}.business`;
    const businessText = JSON.stringify({ version: 1, ledger: { items: { i1: { title: 'old item' } } }, steward: { chatId: 'old-chat' } });
    writeFileSync(business, businessText);
    await h.bridge.receive(groupMessage('a new question', 'm-new'));
    await h.bridge.tick();
    expect(h.core.trigger).toHaveBeenCalledTimes(1);
    h.finish();
    await h.bridge.tick();
    expect(h.replies.some(reply => reply.text.includes('the answer'))).toBe(true);
    const saved = h.state();
    expect(saved.firstContacts).toEqual(earlier.firstContacts);
    expect(saved.tasks.old).toMatchObject({ delivered: true, deliveryPrivate: true, firstContactCommand: '/status' });
    expect(existsSync(business) && readFileSync(business, 'utf8')).toBe(businessText);
    // Nothing more is posted for the old, delivered task.
    expect(JSON.stringify([...h.replies, ...h.sends])).not.toContain('old answer');
  });

  it('ignores a click on a card of the retired business features: no state change, nothing sent', async () => {
    const h = harness({ allowedUsers: ['alice'] }, { state: earlier });
    await h.bridge.receive(privateMessage('/status', 'seed'));
    const before = readFileSync(h.stateFile, 'utf8');
    const calls = () => [h.transport.reply, h.transport.send, h.transport.sendCard!, h.transport.updateCard!].map(fn => fn.mock.calls.length);
    const counted = calls();
    for (const eventKey of ['business:oncall:accept:f1', 'business:steward:decide:i1', 'assist:consent']) {
      await expect(h.bridge.receiveCardEvent({
        messageId: `biz-${eventKey}`, botId: 'bot', userId: 'alice', conversationId: 'room', chatType: 'group',
        requestId: 'biz', taskId: 'biz_form_f1', eventKey, receivedAt: Date.now(),
      })).resolves.toBeUndefined();
    }
    expect(readFileSync(h.stateFile, 'utf8')).toBe(before);
    expect(calls()).toEqual(counted);
  });
});
