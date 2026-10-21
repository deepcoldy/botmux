/**
 * 申请卡节流期间给真人申请人的一次性提示（maybeSendGrantRequestCard 的 notifyThrottledRequester）：
 * 卡已送达、还在等管理员处理 / 刚被拒绝的 10 分钟里，同一个人再找 bot 不再发卡，回一句原因；
 * 同一张卡 / 同一次拒绝只回一次。bot 发送方（不传该选项）、黑名单、关了 autoGrantRequestCards
 * （文档写明的静默拦截）仍然不回话。
 *
 * Run: bunx vitest run test/grant-request-throttle-notice.test.ts
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
import {
  isThrottled,
  markDenied,
  markPendingDelivered,
  openPending,
  openPendingMulti,
  clearPending,
  claimThrottleNotice,
  _resetForTest as _resetGrantPending,
  _simulateRestartForTest,
} from '../src/im/lark/grant-pending.js';
import { clearChatMemberCache } from '../src/im/lark/grant-owner.js';
import { replyMessage, sendUserMessage, listChatMemberOpenIds } from '../src/im/lark/client.js';
import { localeForBot, t } from '../src/i18n/index.js';

const APP = 'throttle_notice_app';
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
    ...extra,
  });
  bot.resolvedAllowedUsers = [OWNER];
  bot.resolvedBlockedUsers = [];
  return bot;
}

const groupMsg = (id: string) => ({ message_id: id, chat_type: 'group' });
const p2pMsg = (id: string) => ({ message_id: id, chat_type: 'p2p' });
const asHuman = { notifyThrottledRequester: true };
const pendingText = () => t('card.grant.request_still_pending', undefined, localeForBot(APP));
const deniedText = () => t('card.grant.request_recently_denied', undefined, localeForBot(APP));
const replies = () => vi.mocked(replyMessage).mock.calls as any[][];

describe('maybeSendGrantRequestCard — notice while the request is throttled', () => {
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'botmux-grant-throttle-notice-'));
    __testOnly_resetBotRegistry();
    _resetGrantPending();
    clearChatMemberCache();
    vi.mocked(replyMessage).mockReset().mockResolvedValue('om_reply');
    vi.mocked(sendUserMessage).mockReset().mockResolvedValue('om_dm');
    vi.mocked(listChatMemberOpenIds).mockReset().mockResolvedValue([OWNER, REQUESTER]);
  });
  afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

  it('group: card first, one "still pending" reply for that card, then silence', async () => {
    registerRestrictedBot();
    await maybeSendGrantRequestCard(APP, groupMsg('om_1'), GROUP, REQUESTER, undefined, asHuman);
    expect(replies()).toHaveLength(1);
    expect(replies()[0]![3]).toBe('interactive');

    await maybeSendGrantRequestCard(APP, groupMsg('om_2'), GROUP, REQUESTER, undefined, asHuman);
    expect(replies()).toHaveLength(2);
    expect(replies()[1]!.slice(0, 3)).toEqual([APP, 'om_2', pendingText()]);
    expect(replies()[1]![3] ?? 'text').toBe('text');

    await maybeSendGrantRequestCard(APP, groupMsg('om_3'), GROUP, REQUESTER, undefined, asHuman);
    expect(replies()).toHaveLength(2);
    expect(isThrottled(APP, GROUP, REQUESTER)).toBe(true);
  });

  it('callers without the option (bot senders) stay silent while throttled', async () => {
    registerRestrictedBot();
    await maybeSendGrantRequestCard(APP, groupMsg('om_b1'), GROUP, REQUESTER);
    await maybeSendGrantRequestCard(APP, groupMsg('om_b2'), GROUP, REQUESTER);
    expect(replies()).toHaveLength(1);
    expect(replies()[0]![3]).toBe('interactive');
  });

  it('denied: one "not approved" reply per denial', async () => {
    registerRestrictedBot();
    await maybeSendGrantRequestCard(APP, groupMsg('om_d1'), GROUP, REQUESTER, undefined, asHuman);
    expect(markDenied(APP, GROUP, REQUESTER)).toBe(true);

    await maybeSendGrantRequestCard(APP, groupMsg('om_d2'), GROUP, REQUESTER, undefined, asHuman);
    await maybeSendGrantRequestCard(APP, groupMsg('om_d3'), GROUP, REQUESTER, undefined, asHuman);
    expect(replies()).toHaveLength(2);
    expect(replies()[1]!.slice(0, 3)).toEqual([APP, 'om_d2', deniedText()]);
  });

  it('a later card gets its own reminder', async () => {
    registerRestrictedBot();
    await maybeSendGrantRequestCard(APP, groupMsg('om_n1'), GROUP, REQUESTER, undefined, asHuman);
    await maybeSendGrantRequestCard(APP, groupMsg('om_n2'), GROUP, REQUESTER, undefined, asHuman);
    // 授权后额度用尽被收回 / 管理员处置后重新申请：pending 清掉，下一条消息发新卡。
    clearPending(APP, GROUP, REQUESTER);
    await maybeSendGrantRequestCard(APP, groupMsg('om_n3'), GROUP, REQUESTER, undefined, asHuman);
    await maybeSendGrantRequestCard(APP, groupMsg('om_n4'), GROUP, REQUESTER, undefined, asHuman);
    expect(replies().map(c => [c[1], c[3] ?? 'text'])).toEqual([
      ['om_n1', 'interactive'],
      ['om_n2', 'text'],
      ['om_n3', 'interactive'],
      ['om_n4', 'text'],
    ]);
  });

  it('card not yet confirmed delivered → no reminder (it may still fail and be withdrawn)', async () => {
    registerRestrictedBot();
    openPending(APP, GROUP, REQUESTER, 3, undefined, 60_000);
    await maybeSendGrantRequestCard(APP, groupMsg('om_inflight'), GROUP, REQUESTER, undefined, asHuman);
    expect(replies()).toHaveLength(0);
  });

  it('a failed reminder is not counted, the next message retries it', async () => {
    registerRestrictedBot();
    await maybeSendGrantRequestCard(APP, groupMsg('om_f1'), GROUP, REQUESTER, undefined, asHuman);
    vi.mocked(replyMessage).mockRejectedValueOnce(new Error('send failed'));
    await maybeSendGrantRequestCard(APP, groupMsg('om_f2'), GROUP, REQUESTER, undefined, asHuman);
    await maybeSendGrantRequestCard(APP, groupMsg('om_f3'), GROUP, REQUESTER, undefined, asHuman);
    expect(replies().map(c => c[1])).toEqual(['om_f1', 'om_f2', 'om_f3']);
    expect(replies()[2]![2]).toBe(pendingText());
  });

  it('a late failure of an older reminder does not erase the mark of a newer card', () => {
    registerRestrictedBot();
    markPendingDelivered(APP, GROUP, [REQUESTER], openPending(APP, GROUP, REQUESTER, 3, undefined, 60_000));
    const older = claimThrottleNotice(APP, GROUP, REQUESTER);
    expect(older?.reason).toBe('pending');
    clearPending(APP, GROUP, REQUESTER);
    markPendingDelivered(APP, GROUP, [REQUESTER], openPending(APP, GROUP, REQUESTER, 3, undefined, 60_000));
    const newer = claimThrottleNotice(APP, GROUP, REQUESTER);
    expect(newer?.reason).toBe('pending');

    older!.release();
    expect(claimThrottleNotice(APP, GROUP, REQUESTER)).toBeNull();
    newer!.release();
    expect(claimThrottleNotice(APP, GROUP, REQUESTER)?.reason).toBe('pending');
  });

  it('autoGrantRequestCards=false stays silent, even with a delivered owner /grant card pending', async () => {
    registerRestrictedBot({ autoGrantRequestCards: false });
    const nonce = openPendingMulti(APP, GROUP, [REQUESTER], 3, undefined, 60_000);
    markPendingDelivered(APP, GROUP, [REQUESTER], nonce);
    await maybeSendGrantRequestCard(APP, groupMsg('om_off'), GROUP, REQUESTER, undefined, asHuman);
    expect(replies()).toHaveLength(0);
    expect(sendUserMessage).not.toHaveBeenCalled();
  });

  it('blocked requester stays silent', async () => {
    const bot = registerRestrictedBot();
    await maybeSendGrantRequestCard(APP, groupMsg('om_k1'), GROUP, REQUESTER, undefined, asHuman);
    bot.resolvedBlockedUsers = [REQUESTER];
    await maybeSendGrantRequestCard(APP, groupMsg('om_k2'), GROUP, REQUESTER, undefined, asHuman);
    expect(replies()).toHaveLength(1);
  });

  it('p2p with owner-DM forwarding: ack on the first message, reminder on the next', async () => {
    registerRestrictedBot({ grantRequestToOwnerDm: true });
    await maybeSendGrantRequestCard(APP, p2pMsg('om_p1'), P2P, REQUESTER, undefined, asHuman);
    await maybeSendGrantRequestCard(APP, p2pMsg('om_p2'), P2P, REQUESTER, undefined, asHuman);
    await maybeSendGrantRequestCard(APP, p2pMsg('om_p3'), P2P, REQUESTER, undefined, asHuman);
    expect(sendUserMessage).toHaveBeenCalledTimes(1);
    expect(replies().map(c => c[1])).toEqual(['om_p1', 'om_p2']);
    expect(replies()[1]![2]).toBe(pendingText());
  });

  it('after a daemon restart the persisted card still throttles and reminds at most once more', async () => {
    registerRestrictedBot();
    await maybeSendGrantRequestCard(APP, groupMsg('om_r1'), GROUP, REQUESTER, undefined, asHuman);
    await maybeSendGrantRequestCard(APP, groupMsg('om_r2'), GROUP, REQUESTER, undefined, asHuman);
    _simulateRestartForTest();
    await maybeSendGrantRequestCard(APP, groupMsg('om_r3'), GROUP, REQUESTER, undefined, asHuman);
    await maybeSendGrantRequestCard(APP, groupMsg('om_r4'), GROUP, REQUESTER, undefined, asHuman);
    expect(replies().map(c => [c[1], c[3] ?? 'text'])).toEqual([
      ['om_r1', 'interactive'],
      ['om_r2', 'text'],
      ['om_r3', 'text'],
    ]);
  });
});
