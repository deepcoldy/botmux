/**
 * delegated-grant：同一 owner 的同机 Bot @ 本 bot 时，同条消息被点名的人自动获得本群 talk 授权。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@larksuiteoapi/node-sdk', () => {
  class FakeClient { constructor(public opts: Record<string, unknown>) {} }
  return { Client: FakeClient };
});

const replyMock = vi.fn(async (..._args: any[]) => 'om_reply');
// 默认所有目标都判为真人；以 bot 结尾的 id 判为 bot（验证结果卡不用 <at> 唤醒 bot）。
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
import { applyDelegatedGrants, resolveGrantDelegator } from '../src/im/lark/delegated-grant.js';
import { registerBot, getBot, loadBotConfigs } from '../src/bot-registry.js';
import { canTalk, canOperate } from '../src/im/lark/event-dispatcher.js';
import { DEFAULT_GRANT_QUOTA } from '../src/services/grant-policy.js';
import { computeBotAdminUnions, writeBotAdminUnions } from '../src/services/bot-admin-unions-store.js';
import { recordTeamBot } from '../src/services/team-bots-store.js';

const RECV = 'bd';
const SIB_OPEN = 'ou_sib_bot';
const SIB_UNION = 'on_sib_bot';
const OTHER_OPEN = 'ou_other_bot';
const OTHER_UNION = 'on_other_bot';
const SIB = { senderIds: [SIB_OPEN, 'cli_sib'], senderUnionId: SIB_UNION };
const OTHER_OWNER_SIB = { senderIds: [OTHER_OPEN, 'cli_other'], senderUnionId: OTHER_UNION };

/** 兄弟 bot 的开场卡：interactive 内容里的 at 只是 @_user_N 占位，真实身份在 mentions[]。 */
function kickoffCard(extraMentions: Array<{ open_id: string; name: string }> = [{ open_id: 'ou_req', name: '提需求的人' }]) {
  return {
    message_id: 'om_kickoff', chat_id: 'oc_room', message_type: 'interactive',
    content: JSON.stringify({ title: '开工', elements: [[{ tag: 'at', user_id: '@_user_1' }]] }),
    mentions: [
      { key: '@_user_1', id: { open_id: 'ou_self_bot' }, name: 'crossdev' },
      ...extraMentions.map((m, i) => ({ key: `@_user_${i + 2}`, id: { open_id: m.open_id }, name: m.name })),
    ],
  };
}

async function publishAdmins(dir: string, appId: string, raw: string[], unionOf: Record<string, string>): Promise<void> {
  const { snapshot } = await computeBotAdminUnions(raw, new Map(raw.map(r => [r, `ou_${r}`])), async ou => unionOf[ou.slice(3)]);
  writeBotAdminUnions(dir, appId, snapshot);
}

let dir: string;
beforeEach(async () => {
  replyMock.mockClear();
  isHumanMock.mockClear();
  dir = mkdtempSync(join(tmpdir(), 'botmux-delegated-grant-'));
  process.env.BOTS_CONFIG = join(dir, 'bots.json');
  process.env.SESSION_DATA_DIR = dir;
  writeFileSync(process.env.BOTS_CONFIG, JSON.stringify([
    { larkAppId: RECV, larkAppSecret: 's', cliId: 'claude-code', allowedUsers: ['owner@example.com'] },
    { larkAppId: 'cli_sib', larkAppSecret: 's', cliId: 'claude-code', allowedUsers: ['on_owner'] },
    { larkAppId: 'cli_other', larkAppSecret: 's', cliId: 'claude-code', allowedUsers: ['on_someone'] },
  ], null, 2), 'utf-8');
  writeFileSync(join(dir, 'bot-union-ids.json'), JSON.stringify({
    cli_sib: { unionId: SIB_UNION, learnedAt: 1 },
    cli_other: { unionId: OTHER_UNION, learnedAt: 1 },
  }));
  await publishAdmins(dir, RECV, ['owner@example.com'], { 'owner@example.com': 'on_owner' });
  await publishAdmins(dir, 'cli_sib', ['on_owner'], {});
  await publishAdmins(dir, 'cli_other', ['on_someone'], {});
  registerBot(loadBotConfigs().find(c => c.larkAppId === RECV)!);
  const bot = getBot(RECV);
  bot.botOpenId = 'ou_self_bot';
  bot.resolvedAllowedUsers = ['ou_owner'];
});
afterEach(() => {
  delete process.env.BOTS_CONFIG;
  delete process.env.SESSION_DATA_DIR;
  rmSync(dir, { recursive: true, force: true });
});

describe('resolveGrantDelegator', () => {
  it('only a same-owner sibling bot delegates; another owner\'s sibling, team peers and strangers do not', () => {
    expect(resolveGrantDelegator(RECV, SIB)).toBe('sameOwnerBot');
    expect(resolveGrantDelegator(RECV, OTHER_OWNER_SIB)).toBeUndefined();
    recordTeamBot(dir, { unionId: 'on_team_bot' });
    expect(resolveGrantDelegator(RECV, { senderIds: ['ou_team_bot'], senderUnionId: 'on_team_bot' })).toBeUndefined();
    expect(resolveGrantDelegator(RECV, { senderIds: ['ou_stranger_bot'] })).toBeUndefined();
  });

  it('trustSameOwnerBots=false turns delegation off', () => {
    getBot(RECV).config.trustSameOwnerBots = false;
    expect(resolveGrantDelegator(RECV, SIB)).toBeUndefined();
  });
});

describe('applyDelegatedGrants', () => {
  it('grants the person the sibling @-mentioned: talk only, this chat only, default limits, result card replied', async () => {
    expect(canTalk(RECV, 'oc_room', 'ou_req')).toBe(false);

    const granted = await applyDelegatedGrants(RECV, kickoffCard(), { chatType: 'group', ...SIB });

    expect(granted).toEqual(['ou_req']);
    expect(canTalk(RECV, 'oc_room', 'ou_req')).toBe(true);
    expect(canTalk(RECV, 'oc_other', 'ou_req')).toBe(false);
    expect(canOperate(RECV, 'oc_room', 'ou_req')).toBe(false);
    expect(getBot(RECV).config.quotaState?.['chat:oc_room:ou_req']?.limit).toBe(DEFAULT_GRANT_QUOTA);

    expect(replyMock).toHaveBeenCalledTimes(1);
    const [, messageId, content, msgType] = replyMock.mock.calls[0]!;
    expect(messageId).toBe('om_kickoff');
    expect(msgType).toBe('interactive');
    expect(content).toContain('<at id=ou_req></at>');
  });

  it("uses the bot owner's configured /grant defaults", async () => {
    getBot(RECV).config.messageQuota = { defaultLimit: 50 };
    getBot(RECV).config.grantDefaultDurationMs = 24 * 60 * 60 * 1000;
    const before = Date.now();

    await applyDelegatedGrants(RECV, kickoffCard(), { chatType: 'group', ...SIB });

    expect(getBot(RECV).config.quotaState?.['chat:oc_room:ou_req']?.limit).toBe(50);
    const expiresAt = getBot(RECV).config.grantExpiryState?.['chat:oc_room:ou_req']?.expiresAt ?? 0;
    expect(expiresAt).toBeGreaterThanOrEqual(before + 24 * 60 * 60 * 1000);
  });

  it("another owner's sibling grants nothing", async () => {
    const granted = await applyDelegatedGrants(RECV, kickoffCard(), { chatType: 'group', ...OTHER_OWNER_SIB });
    expect(granted).toEqual([]);
    expect(canTalk(RECV, 'oc_room', 'ou_req')).toBe(false);
    expect(replyMock).not.toHaveBeenCalled();
  });

  it('switch off → nothing granted', async () => {
    getBot(RECV).config.trustSameOwnerBots = false;
    const granted = await applyDelegatedGrants(RECV, kickoffCard(), { chatType: 'group', ...SIB });
    expect(granted).toEqual([]);
    expect(canTalk(RECV, 'oc_room', 'ou_req')).toBe(false);
    expect(replyMock).not.toHaveBeenCalled();
  });

  it('does nothing when the message does not @ this bot (checked in the function, not only at the call site)', async () => {
    const msg = { ...kickoffCard(), mentions: kickoffCard().mentions.filter(m => m.id.open_id !== 'ou_self_bot') };
    const granted = await applyDelegatedGrants(RECV, msg, { chatType: 'group', ...SIB });
    expect(granted).toEqual([]);
    expect(canTalk(RECV, 'oc_room', 'ou_req')).toBe(false);
    expect(replyMock).not.toHaveBeenCalled();
  });

  it('does nothing outside group chats', async () => {
    const granted = await applyDelegatedGrants(RECV, kickoffCard(), { chatType: 'p2p', ...SIB });
    expect(granted).toEqual([]);
    expect(replyMock).not.toHaveBeenCalled();
  });

  it('skips people who can already talk, the sender itself and @all — no write, no reply', async () => {
    const msg = kickoffCard([
      { open_id: 'ou_owner', name: 'owner' },
      { open_id: SIB_OPEN, name: '兄弟 bot 自己' },
      { open_id: 'all', name: '所有人' },
    ]);
    const granted = await applyDelegatedGrants(RECV, msg, { chatType: 'group', ...SIB });
    expect(granted).toEqual([]);
    expect(getBot(RECV).config.chatGrants?.['oc_room']).toBeUndefined();
    expect(replyMock).not.toHaveBeenCalled();
  });

  it('grants every other mentioned person in one go and replies once', async () => {
    const msg = kickoffCard([
      { open_id: 'ou_req', name: '提需求的人' },
      { open_id: 'ou_trigger', name: '触发人' },
    ]);
    const granted = await applyDelegatedGrants(RECV, msg, { chatType: 'group', ...SIB });
    expect(granted).toEqual(['ou_req', 'ou_trigger']);
    expect(replyMock).toHaveBeenCalledTimes(1);
  });

  it('a blocked sibling cannot open the door for others', async () => {
    getBot(RECV).resolvedBlockedUsers = [SIB_OPEN];
    const granted = await applyDelegatedGrants(RECV, kickoffCard(), { chatType: 'group', ...SIB });
    expect(granted).toEqual([]);
    expect(canTalk(RECV, 'oc_room', 'ou_req')).toBe(false);
    expect(replyMock).not.toHaveBeenCalled();
  });

  it('never grants blocked mention targets and stays silent', async () => {
    getBot(RECV).resolvedBlockedUsers = ['ou_blocked'];
    const msg = kickoffCard([{ open_id: 'ou_blocked', name: '黑名单' }]);
    const granted = await applyDelegatedGrants(RECV, msg, { chatType: 'group', ...SIB });
    expect(granted).toEqual([]);
    expect(getBot(RECV).config.chatGrants?.['oc_room']).toBeUndefined();
    expect(replyMock).not.toHaveBeenCalled();
  });

  it('mentioned bots get talk-only too but are rendered as plain text (no @ wake)', async () => {
    const msg = kickoffCard([
      { open_id: 'ou_needhuman', name: '提需求的人' },
      { open_id: 'ou_third_bot', name: 'ThirdBot' },
    ]);
    const granted = await applyDelegatedGrants(RECV, msg, { chatType: 'group', ...SIB });
    expect(granted.sort()).toEqual(['ou_needhuman', 'ou_third_bot']);
    expect(canOperate(RECV, 'oc_room', 'ou_third_bot')).toBe(false);
    const content = replyMock.mock.calls[0]![2] as string;
    expect(content).toContain('<at id=ou_needhuman></at>');
    expect(content).not.toContain('<at id=ou_third_bot>');
    expect(content).toContain('ThirdBot');
  });

  it('re-grants and re-notifies after an earlier delegated grant expired', async () => {
    const card = kickoffCard();
    expect(await applyDelegatedGrants(RECV, card, { chatType: 'group', ...SIB })).toEqual(['ou_req']);
    getBot(RECV).config.grantExpiryState!['chat:oc_room:ou_req'] = { expiresAt: 1 };
    expect(canTalk(RECV, 'oc_room', 'ou_req')).toBe(false);

    replyMock.mockClear();
    expect(await applyDelegatedGrants(RECV, card, { chatType: 'group', ...SIB })).toEqual(['ou_req']);
    expect(replyMock).toHaveBeenCalledTimes(1);
    expect(getBot(RECV).config.grantExpiryState?.['chat:oc_room:ou_req']?.expiresAt ?? 0).toBeGreaterThan(Date.now());
  });

  it('mentions are position-free: a /grant token in the text does not hide earlier mentions', async () => {
    const msg = {
      message_id: 'om_text', chat_id: 'oc_room', message_type: 'text',
      content: JSON.stringify({ text: '@_user_2 你看下，@_user_1 可用 /grant 自行加人' }),
      mentions: [
        { key: '@_user_1', id: { open_id: 'ou_self_bot' }, name: 'crossdev' },
        { key: '@_user_2', id: { open_id: 'ou_req' }, name: '提需求的人' },
      ],
    };
    const granted = await applyDelegatedGrants(RECV, msg, { chatType: 'group', ...SIB });
    expect(granted).toEqual(['ou_req']);
  });
});
