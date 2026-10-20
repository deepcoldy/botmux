/**
 * p2pOpen：私聊对话全开（talk-only），管理权仍限 allowedUsers。
 * Run: pnpm vitest run test/p2p-open.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@larksuiteoapi/node-sdk', () => {
  class FakeClient { constructor(public opts: Record<string, unknown>) {} }
  return { Client: FakeClient };
});

import { registerBot, getBot } from '../src/bot-registry.js';
import { canTalk, canOperate, evaluateTalk } from '../src/im/lark/event-dispatcher.js';
import { handleCardAction } from '../src/im/lark/card-handler.js';
import { sessionKey } from '../src/core/types.js';
import { localeForBot, t } from '../src/i18n/index.js';

describe('p2pOpen', () => {
  beforeEach(() => {
    const bot = registerBot({ larkAppId: 'p1', larkAppSecret: 's', cliId: 'claude-code', allowedUsers: ['ou_owner'] });
    bot.resolvedAllowedUsers = ['ou_owner'];
    bot.config.allowedChatGroups = undefined;
    bot.config.chatGrants = undefined;
    bot.config.globalGrants = undefined;
    bot.config.p2pOpen = true;
  });

  it('陌生人在私聊里可以对话', () => {
    expect(canTalk('p1', 'oc_dm', 'ou_stranger', undefined, undefined, 'p2p')).toBe(true);
    expect(evaluateTalk('p1', 'oc_dm', 'ou_stranger', undefined, undefined, 'p2p').reason).toBe('p2pOpen');
  });

  it('但陌生人拿不到任何管理权（canOperate 不读 p2pOpen）', () => {
    expect(canOperate('p1', 'oc_dm', 'ou_stranger')).toBe(false);
    expect(canOperate('p1', 'oc_dm', 'ou_owner')).toBe(true);
  });

  it('p2pOpen 不放开群聊：同一个人在群里仍被挡', () => {
    expect(canTalk('p1', 'oc_group', 'ou_stranger', undefined, undefined, 'group')).toBe(false);
  });

  it('chatType 缺省时按原语义（不放行）——保证未接入 chatType 的调用点不 fail-open', () => {
    expect(canTalk('p1', 'oc_dm', 'ou_stranger')).toBe(false);
  });

  it('owner 不受影响：私聊仍可对话并操作', () => {
    expect(canTalk('p1', 'oc_dm', 'ou_owner', undefined, undefined, 'p2p')).toBe(true);
    expect(canOperate('p1', 'oc_dm', 'ou_owner')).toBe(true);
  });

  it('未配 p2pOpen 的 bot：私聊仍按白名单挡人（存量零影响）', () => {
    getBot('p1').config.p2pOpen = undefined;
    expect(canTalk('p1', 'oc_dm', 'ou_stranger', undefined, undefined, 'p2p')).toBe(false);
    expect(canTalk('p1', 'oc_dm', 'ou_owner', undefined, undefined, 'p2p')).toBe(true);
  });

  it('未配 p2pOpen 且三张名单全空 → 仍是既有的「开放模式」（存量语义，不在本 PR 改）', () => {
    const bot = registerBot({ larkAppId: 'p2', larkAppSecret: 's', cliId: 'claude-code' });
    bot.resolvedAllowedUsers = [];
    expect(canTalk('p2', 'oc_x', 'ou_anyone', undefined, undefined, 'group')).toBe(true);
    expect(canOperate('p2', 'oc_x', 'ou_anyone')).toBe(true);
  });

  // 最危险的配置：只写了 p2pOpen，忘了配 allowedUsers。p2pOpen 必须本身就算「已配权限边界」，
  // 否则会 fall through 到开放模式 —— 群聊被放开、陌生人还能 /restart /cd（提权），
  // 与 p2pOpen「只开私聊 talk」的语义完全相反。
  it('只配 p2pOpen、没配 allowedUsers：私聊开、群聊仍关、任何人都不能 operate（fail-closed）', () => {
    const bot = registerBot({ larkAppId: 'p3', larkAppSecret: 's', cliId: 'claude-code', p2pOpen: true });
    bot.resolvedAllowedUsers = [];
    expect(canTalk('p3', 'oc_dm', 'ou_anyone', undefined, undefined, 'p2p')).toBe(true);
    expect(canTalk('p3', 'oc_group', 'ou_anyone', undefined, undefined, 'group')).toBe(false);
    expect(canOperate('p3', 'oc_dm', 'ou_anyone')).toBe(false);
    expect(canOperate('p3', 'oc_group', 'ou_anyone')).toBe(false);
  });

  // /quote 的 confirm 按钮能触发真实 CLI turn（sendWorkerInput / forkWorker），所以点击时要现场复查权限：
  // 与命令入口同一个谓词 canRunDaemonCommand('/quote')、带上 ds.chatType（漏了它 p2pOpen 腿失效），
  // operator 缺失时 fail-closed。会话设成 busy：过了权限闸就停在「忙」提示，不会去拉话题、碰网络。
  describe('/quote confirm 点击时的权限复查', () => {
    const loc = () => localeForBot('p1');
    const quoteSession = (chatType: 'p2p' | 'group', chatId: string) => ({
      chatId, chatType, session: { sessionId: 'quote-session' },
      worker: { killed: false }, lastScreenStatus: 'working',
    });
    const clickConfirm = (ds: ReturnType<typeof quoteSession>, operatorOpenId: string | undefined, invokerOpenId?: string) => {
      const activeSessions = new Map([[sessionKey('om_quote_root', 'p1'), ds]]);
      return handleCardAction({
        ...(operatorOpenId ? { operator: { open_id: operatorOpenId } } : {}),
        action: { value: {
          action: 'quote_confirm', chat_id: ds.chatId, root_id: 'om_quote_root',
          container_id: 'omt_quoted', invoker_open_id: invokerOpenId,
        } },
      } as any, { activeSessions, sessionReply: vi.fn(), lastRepoScan: new Map() } as any, 'p1');
    };
    const toast = (key: string) => t(key, undefined, loc());

    it('operator 缺失或不是召唤者时 fail-closed', async () => {
      const ds = quoteSession('p2p', 'oc_dm');
      expect((await clickConfirm(ds, undefined))?.toast?.content).toBe(toast('card.quote.toast_not_invoker'));
      expect((await clickConfirm(ds, 'ou_stranger', 'ou_owner'))?.toast?.content).toBe(toast('card.quote.toast_not_invoker'));
    });

    it('/quote 交给 talk-only 时，私聊陌生人（p2pOpen）能通过复查——chatType 与命令名都传对了', async () => {
      getBot('p1').config.canTalkDaemonCommands = ['/quote'];
      const result = await clickConfirm(quoteSession('p2p', 'oc_dm'), 'ou_stranger', 'ou_stranger');
      expect(result?.toast?.content).toBe(toast('card.quote.toast_busy'));
    });

    it('/quote 没交给 talk-only、或在未放开的群里时，陌生人点确认被拒', async () => {
      expect((await clickConfirm(quoteSession('p2p', 'oc_dm'), 'ou_stranger', 'ou_stranger'))?.toast?.content)
        .toBe(toast('card.quote.toast_need_auth'));
      getBot('p1').config.canTalkDaemonCommands = ['/quote'];
      expect((await clickConfirm(quoteSession('group', 'oc_group'), 'ou_stranger', 'ou_stranger'))?.toast?.content)
        .toBe(toast('card.quote.toast_need_auth'));
      expect((await clickConfirm(quoteSession('group', 'oc_group'), 'ou_owner', 'ou_owner'))?.toast?.content)
        .toBe(toast('card.quote.toast_busy'));
    });
  });
});
