/**
 * evaluateAskAnswerTalk 的分派回归 —— `botmux ask` 文字作答鉴权的生产分派谓词。
 *
 * 这个文件专门补 PR #685 delta 复审的 P3：ask 的「三组对照」原本只测 broker API +
 * 自制 mock checker，把 mock 换成任意实现都照样绿——只证明「broker 会透传 actor」，
 * 不证明「分派谓词把三条腿分对」。
 *
 * 这里直接对生产函数 evaluateAskAnswerTalk 喂**真实 team store 状态**断言三组分派：
 *  - 拉群无 union 的 bot → evaluateBotTalk 的团队群腿
 *  - 跨部署 union team bot → bot-locked senderUnionId
 *  - 平台 teamMember 真人 → evaluateTalk 的 memberUnionId 腿
 * 改坏本函数的分派逻辑（退回旧 evaluateTalk / 不认 actor.botSender）会立刻红。
 *
 * 覆盖边界：本文件咬的是**分派谓词本身**。daemon bootstrap 的 setAskCanTalkChecker
 * 只有一行转调本函数、submitCustomReply 的 actor 构造也未被这里机械覆盖——那两处靠
 * 人工核对保证（转调是一行，actor 构造在 handleThreadReply 内、由更上层的 sender 判定驱动）。
 *
 * Run: pnpm vitest run test/ask-answer-talk-dispatch.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'bun:test';
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

import { registerBot, getBot } from '../src/bot-registry.js';
import { evaluateAskAnswerTalk } from '../src/im/lark/event-dispatcher.js';
import { recordTeamBot } from '../src/services/team-bots-store.js';
import { recordTeamGroup } from '../src/services/team-groups-store.js';
import { applyPlatformTeamSync } from '../src/services/platform-team-store.js';

const APP = 'ask_dispatch_app';
const CHAT = 'oc_ask';
const OPEN = 'ou_answerer';
const BOT_UNION = 'on_teambot';
const MEMBER_UNION = 'on_teammember';

/** 受限态（配了 allowlist），否则一切先命中 open 腿，测不出分派差异。 */
function restricted(): void {
  const bot = getBot(APP);
  bot.config.allowedUsers = ['ou_owner'];
  bot.resolvedAllowedUsers = ['ou_owner'];
}

/** 布置一个平台团队：本 bot APP 在其 bots roster、MEMBER_UNION 是其成员（走 teamMember
 *  腿）。teamMember 腿现在锚在「本 bot ∈ 同队 bots」，不看 chatId，故 chatId 仅用于占位。 */
function recordPlatformTeamMember(chatId: string, memberUnionId: string): void {
  applyPlatformTeamSync(tempDir, {
    rev: 'rev-1',
    teams: [{ teamId: 'team-1', teamName: 'Team One', groupChatIds: [chatId], memberUnionIds: [memberUnionId], bots: [{ appId: APP }] }],
  });
}

describe('evaluateAskAnswerTalk — ask 文字作答鉴权的真实生产分派', () => {
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'botmux-ask-dispatch-'));
    const bot = registerBot({ larkAppId: APP, larkAppSecret: 's', cliId: 'claude-code', allowedUsers: [] });
    bot.resolvedAllowedUsers = [];
    bot.config.allowedUsers = [];
    bot.config.oncallChats = undefined;
    bot.config.allowedChatGroups = undefined;
    bot.config.chatGrants = undefined;
    bot.config.globalGrants = undefined;
    bot.config.p2pOpen = undefined;
  });
  afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

  it('分派①：团队拉群里无 union 的 bot（botSender=true，无 union）→ 放行（evaluateBotTalk 团队群腿）', () => {
    restricted();
    recordTeamGroup(tempDir, 'team-1', CHAT);
    expect(
      evaluateAskAnswerTalk(APP, CHAT, OPEN, 'group', { botSender: true, senderUnionId: undefined, memberUnionId: undefined }),
    ).toBe(true);
  });

  it('分派②：跨部署 union team bot（botSender=true，带 union）→ 放行（bot-locked union）', () => {
    restricted();
    recordTeamBot(tempDir, { unionId: BOT_UNION, name: 'Codex' });
    // 注意：不布置团队拉群，证明放行来自 union 腿而非 chat 腿。
    expect(
      evaluateAskAnswerTalk(APP, CHAT, OPEN, 'group', { botSender: true, senderUnionId: BOT_UNION, memberUnionId: undefined }),
    ).toBe(true);
  });

  it('分派③：平台 teamMember 真人（botSender=false，带 memberUnionId）→ 放行（evaluateTalk teamMember 腿）', () => {
    restricted();
    recordPlatformTeamMember(CHAT, MEMBER_UNION);
    expect(
      evaluateAskAnswerTalk(APP, CHAT, OPEN, 'group', { botSender: false, senderUnionId: undefined, memberUnionId: MEMBER_UNION }),
    ).toBe(true);
  });

  it('负向：普通未授权人（无 union / 非成员 / 非 bot）→ 拒', () => {
    restricted();
    expect(
      evaluateAskAnswerTalk(APP, CHAT, OPEN, 'group', { botSender: false, senderUnionId: undefined, memberUnionId: undefined }),
    ).toBe(false);
  });

  it('反向锁：无团队拉群时，teamMember 的 union 被当 bot（botSender=true）也不放行（bot 腿只认 team-bots 表/拉群）', () => {
    // 关键：用一个**没有**平台团队/拉群镜像的干净群，只把 MEMBER_UNION 当 bot union 喂进去。
    // 它不在 team-bots 表、当前群也不是团队拉群 → evaluateBotTalk 各腿全落空 → 拒。
    // 证明 botSender 分派不是「放宽」：bot 信任绝不复用真人成员名单。
    restricted();
    const cleanChat = 'oc_not_team';
    expect(
      evaluateAskAnswerTalk(APP, cleanChat, OPEN, 'group', { botSender: true, senderUnionId: MEMBER_UNION, memberUnionId: MEMBER_UNION }),
    ).toBe(false);
  });

  it('无 actor（卡片点击路径退化）：等价于纯 evaluateTalk(openId, chatType) —— teamMember 状态也不放行', () => {
    // 卡片点击不带 actor：senderUnionId / memberUnionId 都拿不到 → teamMember/teamBot 腿
    // 全落空。这正是改动前卡片点击的语义（回调事件无 union）。
    restricted();
    recordPlatformTeamMember(CHAT, MEMBER_UNION);
    recordTeamBot(tempDir, { unionId: BOT_UNION, name: 'Codex' });
    expect(evaluateAskAnswerTalk(APP, CHAT, OPEN, 'group')).toBe(false);
    expect(evaluateAskAnswerTalk(APP, CHAT, OPEN, 'group', undefined)).toBe(false);
  });

  it('open 模式（无 allowlist）：无 actor 也放行（人/bot 同权，与 evaluateTalk open 腿一致）', () => {
    // 不调 restricted()：没配任何 allowlist。
    expect(evaluateAskAnswerTalk(APP, CHAT, OPEN, 'group')).toBe(true);
    expect(evaluateAskAnswerTalk(APP, CHAT, OPEN, 'group', { botSender: true })).toBe(true);
  });
});
