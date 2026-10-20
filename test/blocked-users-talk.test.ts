/**
 * blockedUsers 黑名单（P1c）：否决腿优先级矩阵。
 *
 * 被黑 ou_ 在**每一条**既有放行腿（oncall / allowedChatGroup / peer / teamBot /
 * teamMember / p2pOpen / open / chatGrant / globalGrant）下都必须被拒；owner/管理员
 * 即使被误写进黑名单也仍放行（allowedUser 腿在前，双保险）；被黑用户不弹授权申请卡。
 *
 * Run: bunx vitest run test/blocked-users-talk.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let tempDir: string;

vi.mock('@larksuiteoapi/node-sdk', () => {
  class FakeClient { constructor(public opts: Record<string, unknown>) {} }
  return { Client: FakeClient };
});

// 只把 dataDir 指到临时目录（peer cross-ref / team store 都按 dataDir 落盘）。
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

// 授权申请卡路径会 replyMessage / getUserProfile：钉成 mock，断言被黑用户不触发发卡。
// 其余 client 导出保留真实（evaluateTalk 链路不需要网络）。
vi.mock('../src/im/lark/client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/im/lark/client.js')>();
  return {
    ...actual,
    replyMessage: vi.fn(async () => 'om_sent'),
    getUserProfile: vi.fn(async () => ({ name: '某人' })),
  };
});

import { registerBot, getBot, __testOnly_resetBotRegistry } from '../src/bot-registry.js';
import {
  evaluateTalk,
  evaluateBotTalk,
  canTalk,
  canOperate,
  maybeSendGrantRequestCard,
} from '../src/im/lark/event-dispatcher.js';
import { recordTeamBot } from '../src/services/team-bots-store.js';
import { recordTeamGroup } from '../src/services/team-groups-store.js';
import { applyPlatformTeamSync } from '../src/services/platform-team-store.js';
import { isThrottled, _resetForTest as _resetGrantPending } from '../src/im/lark/grant-pending.js';
import { replyMessage } from '../src/im/lark/client.js';
import {
  requestGrantForAskClicker,
  type AskGrantRequestDeps,
} from '../src/im/lark/ask-grant-request.js';

const APP = 'blk_app';
const CHAT = 'oc_blk_chat';
const SENDER = 'ou_blocked';
const OWNER = 'ou_owner';
const SENDER_UNION = 'on_blocked_bot';
const MEMBER_UNION = 'on_blocked_member';

/** 注册一个限制态 bot：owner 在 allowedUsers，SENDER 在黑名单。 */
function registerBlockedBot() {
  const bot = registerBot({
    larkAppId: APP,
    larkAppSecret: 's',
    cliId: 'claude-code',
    allowedUsers: [OWNER],
  });
  bot.resolvedAllowedUsers = [OWNER];
  bot.resolvedBlockedUsers = [SENDER];
  return bot;
}

describe('blockedUsers 否决腿 × 既有放行腿优先级', () => {
  beforeEach(() => {
    __testOnly_resetBotRegistry();
    _resetGrantPending();
    tempDir = mkdtempSync(join(tmpdir(), 'botmux-blocked-'));
    vi.mocked(replyMessage).mockClear();
  });
  afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

  it('oncall 群内被黑用户被拒', () => {
    const bot = registerBlockedBot();
    bot.config.oncallChats = [{ chatId: CHAT, workingDir: '/tmp' }];
    expect(evaluateTalk(APP, CHAT, SENDER)).toEqual({ allowed: false, reason: 'blocked' });
    expect(canTalk(APP, CHAT, SENDER)).toBe(false);
  });

  it('allowedChatGroup 整群授权下放行被黑用户仍被拒', () => {
    const bot = registerBlockedBot();
    bot.config.allowedChatGroups = [CHAT];
    expect(evaluateTalk(APP, CHAT, SENDER).reason).toBe('blocked');
  });

  it('peer bot cross-ref 命中也不能解黑', () => {
    registerBlockedBot();
    writeFileSync(join(tempDir, `bot-openids-${APP}.json`), JSON.stringify({ Codex: SENDER }));
    expect(evaluateTalk(APP, CHAT, SENDER).reason).toBe('blocked');
  });

  it('teamBot union 腿（recordTeamBot + bot-locked union）不能复活被黑 bot', () => {
    registerBlockedBot();
    recordTeamBot(tempDir, { unionId: SENDER_UNION, name: 'Codex' });
    expect(evaluateTalk(APP, CHAT, SENDER, SENDER_UNION).reason).toBe('blocked');
    // evaluateBotTalk 独有的「团队拉群」chat 维度腿同样不能复活。
    recordTeamGroup(tempDir, 'team-1', CHAT);
    expect(evaluateBotTalk(APP, CHAT, SENDER, undefined)).toEqual({ allowed: false, reason: 'blocked' });
    expect(evaluateBotTalk(APP, CHAT, SENDER, SENDER_UNION)).toEqual({ allowed: false, reason: 'blocked' });
  });

  it('teamMember 平台团队成员腿不能解黑', () => {
    registerBlockedBot();
    applyPlatformTeamSync(tempDir, {
      rev: 'rev-1',
      teams: [{ teamId: 'team-1', teamName: 'Team One', groupChatIds: [CHAT], memberUnionIds: [MEMBER_UNION], bots: [{ appId: APP }] }],
    });
    expect(evaluateTalk(APP, CHAT, SENDER, undefined, MEMBER_UNION).reason).toBe('blocked');
  });

  it('p2pOpen 私聊全开放行腿不能解黑', () => {
    const bot = registerBlockedBot();
    bot.config.p2pOpen = true;
    expect(evaluateTalk(APP, CHAT, SENDER, undefined, undefined, 'p2p').reason).toBe('blocked');
  });

  it('open 模式（无任何白名单）下被黑用户仍被拒——黑名单是否决腿，不依赖限制态', () => {
    const bot = registerBot({ larkAppId: APP, larkAppSecret: 's', cliId: 'claude-code' });
    bot.resolvedBlockedUsers = [SENDER];
    expect(evaluateTalk(APP, CHAT, SENDER).reason).toBe('blocked');
    expect(canOperate(APP, CHAT, SENDER)).toBe(false);
  });

  it('chatGrant 不能解黑', () => {
    const bot = registerBlockedBot();
    bot.config.chatGrants = { [CHAT]: [SENDER] };
    expect(evaluateTalk(APP, CHAT, SENDER).reason).toBe('blocked');
  });

  it('globalGrant 不能解黑', () => {
    const bot = registerBlockedBot();
    bot.config.globalGrants = [SENDER];
    expect(evaluateTalk(APP, CHAT, SENDER).reason).toBe('blocked');
  });

  it('话题群语义：blocked 是 sender 维度，任意 oc_ chatId 下直接否决（不必真建话题群）', () => {
    const bot = registerBlockedBot();
    // 即使该 oc_ 同时是 oncall 群（群维度放行最强形态），sender 在黑名单即拒。
    bot.config.oncallChats = [{ chatId: 'oc_any_topic_chat', workingDir: '/tmp' }];
    expect(evaluateTalk(APP, 'oc_any_topic_chat', SENDER)).toEqual({ allowed: false, reason: 'blocked' });
  });

  it('无 senderOpenId 时不走否决腿（保持其它腿语义）', () => {
    registerBlockedBot();
    expect(evaluateTalk(APP, CHAT, undefined).reason).toBe('none');
  });
});

describe('blockedUsers × canOperate', () => {
  beforeEach(() => {
    __testOnly_resetBotRegistry();
    tempDir = mkdtempSync(join(tmpdir(), 'botmux-blocked-op-'));
  });
  afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

  it('被黑 ou_ 不能 operate', () => {
    registerBlockedBot();
    expect(canOperate(APP, CHAT, SENDER)).toBe(false);
  });

  it('被黑团队 bot 不能借 isTeamBot / isPlatformTeamBot union 腿复活 operate', () => {
    registerBlockedBot();
    recordTeamBot(tempDir, { unionId: SENDER_UNION, name: 'Codex' });
    expect(canOperate(APP, CHAT, SENDER, SENDER_UNION)).toBe(false);

    // 平台 roster 同款。
    applyPlatformTeamSync(tempDir, {
      rev: 'rev-2',
      teams: [{ teamId: 'team-2', teamName: 'Team Two', groupChatIds: [], memberUnionIds: [], bots: [{ appId: APP, unionId: SENDER_UNION }] }],
    });
    expect(canOperate(APP, CHAT, SENDER, SENDER_UNION)).toBe(false);
  });

  it('管理员（allowedUser）即使被误写进 resolvedBlockedUsers 仍可 talk/operate（allowedUser 腿优先）', () => {
    const bot = registerBlockedBot();
    // 误配置：owner 同时出现在两条名单里（写入口 setBotBlockedUsers 会拦，这里模拟绕过/历史脏数据）。
    bot.resolvedBlockedUsers = [SENDER, OWNER];
    expect(evaluateTalk(APP, CHAT, OWNER)).toEqual({ allowed: true, reason: 'allowedUser' });
    expect(canOperate(APP, CHAT, OWNER)).toBe(true);
  });
});

describe('被黑用户不弹授权申请卡', () => {
  beforeEach(() => {
    __testOnly_resetBotRegistry();
    _resetGrantPending();
    tempDir = mkdtempSync(join(tmpdir(), 'botmux-blocked-card-'));
    vi.mocked(replyMessage).mockClear();
  });
  afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

  it('maybeSendGrantRequestCard 对 blocked 静默：不发卡、不开 pending', async () => {
    registerBlockedBot();
    await maybeSendGrantRequestCard(APP, { message_id: 'om_1' }, CHAT, SENDER);
    expect(replyMessage).not.toHaveBeenCalled();
    expect(isThrottled(APP, CHAT, SENDER)).toBe(false);
  });

  it('阳性对照：非黑名单的无权限陌生人照常弹卡（证明静默确实来自 blocked 判定）', async () => {
    registerBlockedBot();
    await maybeSendGrantRequestCard(APP, { message_id: 'om_2' }, CHAT, 'ou_stranger');
    expect(replyMessage).toHaveBeenCalledTimes(1);
    expect(isThrottled(APP, CHAT, 'ou_stranger')).toBe(true);
  });

  it('ask 卡片点击路径：evaluateTalk 判 blocked → unavailable，不投递授权卡', () => {
    const deliverCard = vi.fn(async () => {});
    const deps: AskGrantRequestDeps = {
      getOwnerOpenId: () => OWNER,
      getBotConfig: () => ({}),
      evaluateTalk: () => ({ allowed: false, reason: 'blocked' }),
      deliverCard,
    };
    const outcome = requestGrantForAskClicker(
      { larkAppId: APP, chatId: CHAT, rootMessageId: null },
      SENDER,
      deps,
    );
    expect(outcome).toBe('unavailable');
    expect(deliverCard).not.toHaveBeenCalled();
    expect(isThrottled(APP, CHAT, SENDER)).toBe(false);
  });
});
