/**
 * delegated-grant：grantDelegateBots 里的 bot @ 本 bot 时，同条消息被点名的人自动获得本群 talk 授权。
 * Run: pnpm vitest run test/delegated-grant.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@larksuiteoapi/node-sdk', () => {
  class FakeClient { constructor(public opts: Record<string, unknown>) {} }
  return { Client: FakeClient };
});

const replyMock = vi.fn(async () => 'om_reply');
// 默认所有目标都判为真人；以 ou_bot 结尾的 id 判为 bot（验证结果卡不用 <at> 唤醒 bot）。
const isHumanMock = vi.fn(async (_larkAppId: string, openId: string) => !openId.endsWith('bot'));
vi.mock('../src/im/lark/client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/im/lark/client.js')>();
  return {
    ...actual,
    replyMessage: (...a: any[]) => replyMock(...a),
    isHumanOpenId: (...a: any[]) => isHumanMock(...(a as [string, string])),
  };
});

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyDelegatedGrants, isGrantDelegateSender } from '../src/im/lark/delegated-grant.js';
import { registerBot, getBot, loadBotConfigs } from '../src/bot-registry.js';
import { canTalk, canOperate } from '../src/im/lark/event-dispatcher.js';
import { DEFAULT_GRANT_QUOTA } from '../src/services/grant-policy.js';

const PLATFORM_BOT = 'ou_platform';

/** 平台开场卡的事件形态：interactive 内容里的 at 只是 @_user_N 占位，真实身份在 mentions[]。 */
function kickoffCard(extraMentions: Array<{ open_id: string; name: string }> = [{ open_id: 'ou_req', name: '提需求的人' }]) {
  return {
    message_id: 'om_kickoff', chat_id: 'oc_room', message_type: 'interactive',
    content: JSON.stringify({ title: '本次测试结果存疑', elements: [[{ tag: 'at', user_id: '@_user_1' }]] }),
    mentions: [
      { key: '@_user_1', id: { open_id: 'ou_bot' }, name: 'crossdev' },
      ...extraMentions.map((m, i) => ({ key: `@_user_${i + 2}`, id: { open_id: m.open_id }, name: m.name })),
    ],
  };
}

let dir: string;
beforeEach(() => {
  replyMock.mockClear();
  isHumanMock.mockClear();
  dir = mkdtempSync(join(tmpdir(), 'botmux-delegated-grant-'));
  process.env.BOTS_CONFIG = join(dir, 'bots.json');
  process.env.SESSION_DATA_DIR = dir;
  writeFileSync(process.env.BOTS_CONFIG, JSON.stringify([
    {
      larkAppId: 'bd', larkAppSecret: 's', cliId: 'claude-code',
      allowedUsers: ['ou_owner'],
      grantDelegateBots: [` ${PLATFORM_BOT} `, '', 'cli_platform_app'],
    },
  ], null, 2), 'utf-8');
  loadBotConfigs().forEach(c => registerBot(c));
  const bot = getBot('bd');
  bot.botOpenId = 'ou_bot';
  bot.resolvedAllowedUsers = ['ou_owner'];
});
afterEach(() => {
  delete process.env.BOTS_CONFIG;
  delete process.env.SESSION_DATA_DIR;
  rmSync(dir, { recursive: true, force: true });
});

describe('grantDelegateBots config', () => {
  it('trims entries and drops blanks', () => {
    expect(getBot('bd').config.grantDelegateBots).toEqual([PLATFORM_BOT, 'cli_platform_app']);
  });

  it('matches by open_id or app_id', () => {
    expect(isGrantDelegateSender('bd', [PLATFORM_BOT])).toBe(true);
    expect(isGrantDelegateSender('bd', [undefined, 'cli_platform_app'])).toBe(true);
    expect(isGrantDelegateSender('bd', ['ou_stranger_bot', undefined])).toBe(false);
  });
});

describe('applyDelegatedGrants', () => {
  it('grants the person the delegate bot @-mentioned: talk only, default limits, result card replied', async () => {
    expect(canTalk('bd', 'oc_room', 'ou_req')).toBe(false);

    const granted = await applyDelegatedGrants('bd', kickoffCard(), { chatType: 'group', senderIds: [PLATFORM_BOT] });

    expect(granted).toEqual(['ou_req']);
    expect(canTalk('bd', 'oc_room', 'ou_req')).toBe(true);
    expect(canTalk('bd', 'oc_other', 'ou_req')).toBe(false);   // 只限本群
    expect(canOperate('bd', 'oc_room', 'ou_req')).toBe(false);  // 不授管理权
    expect(getBot('bd').config.quotaState?.['chat:oc_room:ou_req']?.limit).toBe(DEFAULT_GRANT_QUOTA);

    expect(replyMock).toHaveBeenCalledTimes(1);
    const [, messageId, content, msgType] = replyMock.mock.calls[0]!;
    expect(messageId).toBe('om_kickoff');
    expect(msgType).toBe('interactive');
    expect(content).toContain('<at id=ou_req></at>');
  });

  it('uses the bot owner\'s configured /grant defaults', async () => {
    getBot('bd').config.messageQuota = { defaultLimit: 50 };
    getBot('bd').config.grantDefaultDurationMs = 24 * 60 * 60 * 1000;
    const before = Date.now();

    await applyDelegatedGrants('bd', kickoffCard(), { chatType: 'group', senderIds: [PLATFORM_BOT] });

    expect(getBot('bd').config.quotaState?.['chat:oc_room:ou_req']?.limit).toBe(50);
    const expiresAt = getBot('bd').config.grantExpiryState?.['chat:oc_room:ou_req']?.expiresAt ?? 0;
    expect(expiresAt).toBeGreaterThanOrEqual(before + 24 * 60 * 60 * 1000);
  });

  it('ignores bots that are not configured as delegates', async () => {
    const granted = await applyDelegatedGrants('bd', kickoffCard(), { chatType: 'group', senderIds: ['ou_stranger_bot'] });
    expect(granted).toEqual([]);
    expect(canTalk('bd', 'oc_room', 'ou_req')).toBe(false);
    expect(replyMock).not.toHaveBeenCalled();
  });

  it('does nothing outside group chats', async () => {
    const granted = await applyDelegatedGrants('bd', kickoffCard(), { chatType: 'p2p', senderIds: [PLATFORM_BOT] });
    expect(granted).toEqual([]);
    expect(replyMock).not.toHaveBeenCalled();
  });

  it('skips people who can already talk, the sender itself and @all — no write, no reply', async () => {
    const msg = kickoffCard([
      { open_id: 'ou_owner', name: 'owner' },
      { open_id: PLATFORM_BOT, name: '搜索机器人' },
      { open_id: 'all', name: '所有人' },
    ]);
    const granted = await applyDelegatedGrants('bd', msg, { chatType: 'group', senderIds: [PLATFORM_BOT] });
    expect(granted).toEqual([]);
    expect(getBot('bd').config.chatGrants?.['oc_room']).toBeUndefined();
    expect(replyMock).not.toHaveBeenCalled();
  });

  it('grants every other mentioned person in one go and replies once', async () => {
    const msg = kickoffCard([
      { open_id: 'ou_req', name: '提出存疑' },
      { open_id: 'ou_trigger', name: '触发人' },
    ]);
    const granted = await applyDelegatedGrants('bd', msg, { chatType: 'group', senderIds: [PLATFORM_BOT] });
    expect(granted).toEqual(['ou_req', 'ou_trigger']);
    expect(replyMock).toHaveBeenCalledTimes(1);
  });

  it('ignores a delegate bot that is itself on the block list', async () => {
    // 黑名单是 sender 维度的全局否决：拉黑委托 bot 之后，即使 bots.json 里还留着它的
    // grantDelegateBots 条目，它也不能替别人开门（否则拉黑只拦它自己说话，拦不住
    // 它给别人发本群 talk 授权）。
    getBot('bd').resolvedBlockedUsers = [PLATFORM_BOT];
    const granted = await applyDelegatedGrants('bd', kickoffCard(), { chatType: 'group', senderIds: [PLATFORM_BOT] });
    expect(granted).toEqual([]);
    expect(canTalk('bd', 'oc_room', 'ou_req')).toBe(false);
    expect(replyMock).not.toHaveBeenCalled();
  });

  it('never grants blocked mention targets and stays silent', async () => {
    getBot('bd').resolvedBlockedUsers = ['ou_blocked'];
    const msg = kickoffCard([{ open_id: 'ou_blocked', name: '黑名单' }]);
    const granted = await applyDelegatedGrants('bd', msg, { chatType: 'group', senderIds: [PLATFORM_BOT] });
    expect(granted).toEqual([]);
    expect(canTalk('bd', 'oc_room', 'ou_blocked')).toBe(false);
    expect(getBot('bd').config.chatGrants?.['oc_room']).toBeUndefined();
    expect(replyMock).not.toHaveBeenCalled();
  });

  it('grants mentioned bots talk-only but renders them as plain text (no @ wake)', async () => {
    const msg = kickoffCard([
      { open_id: 'ou_needhuman', name: '提需求的人' },
      { open_id: 'ou_otherbot', name: 'OtherBot' },
    ]);
    const granted = await applyDelegatedGrants('bd', msg, { chatType: 'group', senderIds: [PLATFORM_BOT] });
    expect(granted.sort()).toEqual(['ou_needhuman', 'ou_otherbot']);
    expect(canTalk('bd', 'oc_room', 'ou_otherbot')).toBe(true);
    expect(canOperate('bd', 'oc_room', 'ou_otherbot')).toBe(false);
    const content = replyMock.mock.calls[0]![2] as string;
    expect(content).toContain('<at id=ou_needhuman></at>');
    expect(content).not.toContain('<at id=ou_otherbot>');
    expect(content).toContain('OtherBot');
  });

  it('re-notifies when an expired grant is refreshed by another kickoff card', async () => {
    const card = kickoffCard();
    expect(await applyDelegatedGrants('bd', card, { chatType: 'group', senderIds: [PLATFORM_BOT] })).toEqual(['ou_req']);
    expect(replyMock).toHaveBeenCalledTimes(1);
    // 过期后 chatGrants 行仍保留（hasChatGrant 因有效期返 false），但人已不能对话：
    // 委托 bot 再次点名 = 重新授权，必须重置有效期并再发一次结果卡，不能静默续期。
    getBot('bd').config.grantExpiryState!['chat:oc_room:ou_req'] = { expiresAt: 1 };
    expect(canTalk('bd', 'oc_room', 'ou_req')).toBe(false);

    replyMock.mockClear();
    expect(await applyDelegatedGrants('bd', card, { chatType: 'group', senderIds: [PLATFORM_BOT] })).toEqual(['ou_req']);
    expect(replyMock).toHaveBeenCalledTimes(1);
    const expiresAt = getBot('bd').config.grantExpiryState?.['chat:oc_room:ou_req']?.expiresAt ?? 0;
    expect(expiresAt).toBeGreaterThan(Date.now());
  });

  it('grants mentions positioned before a /grant token in text messages (position-free)', async () => {
    // 委托语义没有命令词：不能复用 /grant「命令词之后才算目标」的位置过滤，
    // 否则正文中出现 /grant 字样时，排在它前面的被点名者会被静默漏掉。
    const msg = {
      message_id: 'om_text', chat_id: 'oc_room', message_type: 'text',
      content: JSON.stringify({ text: '@_user_2 你看下，@_user_1 可用 /grant 自行加人' }),
      mentions: [
        { key: '@_user_1', id: { open_id: 'ou_bot' }, name: 'crossdev' },
        { key: '@_user_2', id: { open_id: 'ou_req' }, name: '提需求的人' },
      ],
    };
    const granted = await applyDelegatedGrants('bd', msg, { chatType: 'group', senderIds: [PLATFORM_BOT] });
    expect(granted).toEqual(['ou_req']);
  });
});
