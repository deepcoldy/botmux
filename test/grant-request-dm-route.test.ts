/**
 * 自助授权申请卡的投递路线（maybeSendGrantRequestCard）：
 * grantRequestToOwnerDm 默认关 → 与改动前完全一致（群内卡、p2p 不发卡）；开启后：会话里有管理员 → 卡片回复在原会话（原行为）；会话里没有管理员（p2p / 群里查不到管理员）
 * → 卡片改投主 owner 私聊 + 给申请人中性回执；私聊投递失败或 owner 维度超限时，
 * 群聊回落原会话卡片、p2p 撤 pending 静默。
 *
 * Run: bunx vitest run test/grant-request-dm-route.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let tempDir: string;

vi.mock('@larksuiteoapi/node-sdk', () => {
  class FakeClient { constructor(public opts: Record<string, unknown>) {} }
  return { Client: FakeClient };
});

vi.mock('../src/config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/config.js')>();
  return {
    ...actual,
    config: {
      ...actual.config,
      session: { ...actual.config.session, get dataDir() { return tempDir; } },
    },
  };
});

vi.mock('../src/im/lark/client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/im/lark/client.js')>();
  return {
    ...actual,
    replyMessage: vi.fn(async () => 'om_reply'),
    sendUserMessage: vi.fn(async () => 'om_dm'),
    getUserProfile: vi.fn(async () => ({ name: '访客甲' })),
    listChatMemberOpenIds: vi.fn(async () => [] as string[]),
    getChatName: vi.fn(async () => '值班群' as string | null),
  };
});

import { registerBot, __testOnly_resetBotRegistry } from '../src/bot-registry.js';
import { maybeSendGrantRequestCard } from '../src/im/lark/event-dispatcher.js';
import { isThrottled, OWNER_DM_MAX_PER_WINDOW, tryReserveOwnerDmSlot, _resetForTest as _resetGrantPending } from '../src/im/lark/grant-pending.js';
import { clearChatMemberCache } from '../src/im/lark/grant-owner.js';
import { replyMessage, sendUserMessage, listChatMemberOpenIds, getChatName } from '../src/im/lark/client.js';

const APP = 'dm_route_app';
const OWNER = 'ou_owner';
const REQUESTER = 'ou_requester';
const GROUP = 'oc_group_chat';
const P2P = 'oc_p2p_chat';

function registerRestrictedBot(extra: Record<string, unknown> = {}) {
  const bot = registerBot({
    larkAppId: APP,
    larkAppSecret: 's',
    cliId: 'claude-code',
    allowedUsers: [OWNER],
    grantRequestToOwnerDm: true,
    ...extra,
  });
  bot.resolvedAllowedUsers = [OWNER];
  bot.resolvedBlockedUsers = [];
  return bot;
}

const groupMsg = (id: string) => ({ message_id: id, chat_type: 'group' });
const p2pMsg = (id: string) => ({ message_id: id, chat_type: 'p2p' });

describe('maybeSendGrantRequestCard — grantRequestToOwnerDm off (default)', () => {
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'botmux-grant-dm-off-'));
    __testOnly_resetBotRegistry();
    _resetGrantPending();
    clearChatMemberCache();
    vi.mocked(replyMessage).mockClear();
    vi.mocked(sendUserMessage).mockReset().mockResolvedValue('om_dm');
    vi.mocked(listChatMemberOpenIds).mockReset().mockResolvedValue([REQUESTER]);
  });
  afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

  it('group without any admin → still the in-chat card @owner, no DM, no member lookup for a single admin', async () => {
    registerRestrictedBot({ grantRequestToOwnerDm: undefined });
    await maybeSendGrantRequestCard(APP, groupMsg('om_off_g'), GROUP, REQUESTER);
    expect(sendUserMessage).not.toHaveBeenCalled();
    expect(listChatMemberOpenIds).not.toHaveBeenCalled();
    expect(replyMessage).toHaveBeenCalledTimes(1);
    const [, , card, msgType] = vi.mocked(replyMessage).mock.calls[0] as any[];
    expect(msgType).toBe('interactive');
    expect(card).toContain(`<at id=${OWNER}></at>`);
  });

  it('p2p → no card anywhere, no reply, no pending (old silent behavior)', async () => {
    registerRestrictedBot({ grantRequestToOwnerDm: undefined });
    await maybeSendGrantRequestCard(APP, p2pMsg('om_off_p'), P2P, REQUESTER);
    expect(sendUserMessage).not.toHaveBeenCalled();
    expect(replyMessage).not.toHaveBeenCalled();
    expect(isThrottled(APP, P2P, REQUESTER)).toBe(false);
  });
});

describe('maybeSendGrantRequestCard — grantRequestToOwnerDm on', () => {
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'botmux-grant-dm-route-'));
    __testOnly_resetBotRegistry();
    _resetGrantPending();
    clearChatMemberCache();
    vi.mocked(replyMessage).mockClear();
    vi.mocked(sendUserMessage).mockReset().mockResolvedValue('om_dm');
    vi.mocked(listChatMemberOpenIds).mockReset().mockResolvedValue([]);
    vi.mocked(getChatName).mockReset().mockResolvedValue('值班群');
  });
  afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

  it('group with the owner present → in-chat card @owner, no DM (unchanged behavior)', async () => {
    registerRestrictedBot();
    vi.mocked(listChatMemberOpenIds).mockResolvedValue([OWNER, REQUESTER]);
    await maybeSendGrantRequestCard(APP, groupMsg('om_g1'), GROUP, REQUESTER);
    expect(sendUserMessage).not.toHaveBeenCalled();
    expect(replyMessage).toHaveBeenCalledTimes(1);
    const [, to, card, msgType] = vi.mocked(replyMessage).mock.calls[0] as any[];
    expect([to, msgType]).toEqual(['om_g1', 'interactive']);
    expect(card).toContain(`<at id=${OWNER}></at>`);
    expect(card).not.toContain('"delivery"');
  });

  it('group without any admin → card to owner DM with chat name, neutral ack in the group', async () => {
    registerRestrictedBot();
    vi.mocked(listChatMemberOpenIds).mockResolvedValue([REQUESTER]);
    await maybeSendGrantRequestCard(APP, groupMsg('om_g2'), GROUP, REQUESTER);
    expect(sendUserMessage).toHaveBeenCalledTimes(1);
    const [, to, card, msgType] = vi.mocked(sendUserMessage).mock.calls[0] as any[];
    expect([to, msgType]).toEqual([OWNER, 'interactive']);
    expect(card).toContain('值班群');
    expect(card).toContain('"delivery":"dm_group"');
    expect(card).toContain(`"chat_id":"${GROUP}"`);
    expect(replyMessage).toHaveBeenCalledTimes(1);
    const [, ackTo, ack, ackType] = vi.mocked(replyMessage).mock.calls[0] as any[];
    expect(ackTo).toBe('om_g2');
    expect(ackType ?? 'text').toBe('text');
    expect(ack).not.toContain(OWNER);
    expect(isThrottled(APP, GROUP, REQUESTER)).toBe(true);
  });

  it('group member lookup failure → in-chat card (fails to the old behavior)', async () => {
    registerRestrictedBot();
    vi.mocked(listChatMemberOpenIds).mockRejectedValue(new Error('missing scope'));
    await maybeSendGrantRequestCard(APP, groupMsg('om_g3'), GROUP, REQUESTER);
    expect(sendUserMessage).not.toHaveBeenCalled();
    expect(replyMessage).toHaveBeenCalledTimes(1);
    expect((vi.mocked(replyMessage).mock.calls[0] as any[])[3]).toBe('interactive');
  });

  it('group without admin + DM send failure → falls back to the in-chat card', async () => {
    registerRestrictedBot();
    vi.mocked(listChatMemberOpenIds).mockResolvedValue([REQUESTER]);
    vi.mocked(sendUserMessage).mockRejectedValue(new Error('dm failed'));
    await maybeSendGrantRequestCard(APP, groupMsg('om_g4'), GROUP, REQUESTER);
    expect(sendUserMessage).toHaveBeenCalledTimes(1);
    expect(replyMessage).toHaveBeenCalledTimes(1);
    const [, , card, msgType] = vi.mocked(replyMessage).mock.calls[0] as any[];
    expect(msgType).toBe('interactive');
    expect(card).not.toContain('"delivery"');
    expect(isThrottled(APP, GROUP, REQUESTER)).toBe(true);
  });

  it('p2p → card to owner DM without listing members; ack replies to the requester message', async () => {
    registerRestrictedBot();
    await maybeSendGrantRequestCard(APP, p2pMsg('om_p1'), P2P, REQUESTER);
    expect(listChatMemberOpenIds).not.toHaveBeenCalled();
    expect(getChatName).not.toHaveBeenCalled();
    const [, to, card] = vi.mocked(sendUserMessage).mock.calls[0] as any[];
    expect(to).toBe(OWNER);
    expect(card).toContain('"delivery":"dm_p2p"');
    expect(card).toContain('访客甲');
    expect(replyMessage).toHaveBeenCalledTimes(1);
    expect((vi.mocked(replyMessage).mock.calls[0] as any[])[1]).toBe('om_p1');
  });

  it('p2p DM failure → no reply to the requester, pending cleared for a later retry', async () => {
    registerRestrictedBot();
    vi.mocked(sendUserMessage).mockRejectedValue(new Error('dm failed'));
    await maybeSendGrantRequestCard(APP, p2pMsg('om_p2'), P2P, REQUESTER);
    expect(replyMessage).not.toHaveBeenCalled();
    expect(isThrottled(APP, P2P, REQUESTER)).toBe(false);
  });

  it('owner DM cap reached → p2p stays silent, group falls back to the in-chat card', async () => {
    registerRestrictedBot();
    for (let i = 0; i < OWNER_DM_MAX_PER_WINDOW; i++) tryReserveOwnerDmSlot(APP, OWNER);

    await maybeSendGrantRequestCard(APP, p2pMsg('om_p3'), P2P, REQUESTER);
    expect(sendUserMessage).not.toHaveBeenCalled();
    expect(replyMessage).not.toHaveBeenCalled();
    expect(isThrottled(APP, P2P, REQUESTER)).toBe(false);

    vi.mocked(listChatMemberOpenIds).mockResolvedValue([REQUESTER]);
    await maybeSendGrantRequestCard(APP, groupMsg('om_g5'), GROUP, REQUESTER);
    expect(sendUserMessage).not.toHaveBeenCalled();
    expect(replyMessage).toHaveBeenCalledTimes(1);
    expect((vi.mocked(replyMessage).mock.calls[0] as any[])[3]).toBe('interactive');
  });

  it('chat name lookup miss → DM card still sent with a short chat id placeholder', async () => {
    registerRestrictedBot();
    vi.mocked(listChatMemberOpenIds).mockResolvedValue([]);
    vi.mocked(getChatName).mockResolvedValue(null);
    await maybeSendGrantRequestCard(APP, groupMsg('om_g6'), GROUP, REQUESTER);
    const [, , card] = vi.mocked(sendUserMessage).mock.calls[0] as any[];
    expect(card).toContain(GROUP.slice(0, 10));
  });
});
