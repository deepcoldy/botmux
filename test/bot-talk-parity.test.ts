/**
 * 回归约束：**bot 路由闸不得再手抄一份 talk 源清单**。
 *
 * 这个文件存在的理由是一段病史：外部 bot @ 本 bot 的闸门曾经维护着一条与人侧
 * evaluateTalk 平行的 OR 链，于是每加一条 talk 放行源就漏一次——oncall 漏过、
 * 开放模式漏过、allowedChatGroups 又漏过（owner 整群 `/grant` 之后真人能说话、
 * 外部 bot 一 @ 仍弹授权卡）。现在 bot 侧只走 evaluateBotTalk = evaluateTalk +
 * 一条有文档的 bot 专属腿。
 *
 * 下面这张表按 `TALK_REASONS`（src 里的运行时枚举）逐条对齐：**加了新 talk 源却不在这里
 * 补一格，最后那个 exhaustiveness 用例就会红**。注意 tsconfig 的 include 只有 `src/**`，
 * 测试不过 tsc，所以这条约束必须落在运行时断言上，不能只靠 `Record<TalkReason, …>` 的类型。
 * 它逼你在加腿时回答一个问题：这条腿对 bot 生效吗？不生效的话，为什么？
 *
 * Run: pnpm vitest run test/bot-talk-parity.test.ts
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

// 只把 dataDir 指到临时目录，其余保持真实 config——event-dispatcher 的依赖链
// （worker-pool → session-manager）会读 config.daemon.*，裁剪版 mock 会在 import 期炸。
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
import { evaluateTalk, evaluateBotTalk, canRunDaemonCommand, TALK_REASONS, type TalkReason, type ChatKind } from '../src/im/lark/event-dispatcher.js';
import { recordTeamBot } from '../src/services/team-bots-store.js';
import { recordTeamGroup } from '../src/services/team-groups-store.js';
import { applyPlatformTeamSync } from '../src/services/platform-team-store.js';

const APP = 'parity_app';
const CHAT = 'oc_parity';
const SENDER = 'ou_sender';
/** bot 发送方的租户稳定 union（飞书按 sender_type 盖章过，见 evaluateBotTalk 契约）。 */
const SENDER_UNION = 'on_sender';
/** 真人成员的 union（teamMember 腿走 memberUnionId，不锁 bot）。 */
const MEMBER_UNION = 'on_member';

interface ParityCase {
  /** 布置「让这条腿命中」的最小状态。 */
  arrange: () => void;
  /** 人侧调用要不要传 chatType（仅 p2pOpen 腿读它）。 */
  chatType?: ChatKind;
  /** 人侧调用的 memberUnionId（teamMember 腿走它，真人 union；默认 undefined）。 */
  humanMemberUnionId?: string;
  /** 人侧 evaluateTalk 是否放行。 */
  human: boolean;
  /** bot 侧 evaluateBotTalk 是否放行。 */
  bot: boolean;
  /** 人/bot 都放行、但 bot 命中的是**另一条腿**时，bot 侧期望的 reason（如 teamMember
   *  场景：人走 teamMember、bot 走团队拉群 teamBot）。省略 = 与人侧同一条腿。 */
  botReason?: TalkReason;
  /** 人/bot 不一致时必须写明为什么——不允许「不小心」不一致。 */
  why?: string;
}

/** 让本 bot 进入「限制态」（配了 allowlist），否则一切都会先命中 open 腿。 */
function restricted(): void {
  const bot = getBot(APP);
  bot.config.allowedUsers = ['ou_owner'];
  bot.resolvedAllowedUsers = ['ou_owner'];
}

const CASES: Record<Exclude<TalkReason, 'none'>, ParityCase> = {
  allowedUser: {
    arrange: () => {
      restricted();
      getBot(APP).resolvedAllowedUsers = ['ou_owner', SENDER];
    },
    human: true, bot: true,
  },
  oncall: {
    arrange: () => {
      restricted();
      getBot(APP).config.oncallChats = [{ chatId: CHAT, workingDir: '/tmp' }];
    },
    human: true, bot: true,
  },
  peer: {
    arrange: () => {
      restricted();
      // 同部署兄弟 bot 的 cross-ref（bot-openids-<appId>.json：name → open_id）。
      writeFileSync(join(tempDir, `bot-openids-${APP}.json`), JSON.stringify({ Codex: SENDER }));
    },
    human: true, bot: true,
  },
  teamBot: {
    arrange: () => {
      restricted();
      recordTeamBot(tempDir, { unionId: SENDER_UNION, name: 'Codex' });
    },
    human: false, bot: true,
    why: 'teamBot 腿认的是 **bot-locked** union：人侧调用点恒不传 senderUnionId（daemon 只在 sender_type ∈ app|bot 时才传，见 threadTeamTrustUnionId），'
      + '否则恶意成员把真人 union 报成 bot 就能继承 bot 信任。所以人侧不命中不是 parity 缺口，而是这条腿的定义。',
  },
  teamMember: {
    // 平台团队成员（真人）腿走 memberUnionId：布置一个平台团队（CHAT 是其协作群、
    // MEMBER_UNION 是其成员），人侧传 memberUnionId=MEMBER_UNION → 命中 reason:'teamMember'。
    //
    // bot 侧同样放行，但走的是**另一条腿**：平台协作群会被镜像成团队拉群
    // （applyPlatformTeamSync → team-groups），故 evaluateBotTalk 经团队拉群腿命中
    // reason:'teamBot'（不看 union、不看成员名单）。这正是「团队群里人/bot 各免 grant，
    // 但各自命中自己那条腿」的真实语义——不是同一条腿的人/bot 对齐，故用 botReason 标注。
    arrange: () => {
      restricted();
      applyPlatformTeamSync(tempDir, {
        rev: 'rev-1',
        teams: [{ teamId: 'team-1', teamName: 'Team One', groupChatIds: [CHAT], memberUnionIds: [MEMBER_UNION], bots: [] }],
      });
    },
    humanMemberUnionId: MEMBER_UNION,
    human: true, bot: true,
    botReason: 'teamBot',
    why: '人走 teamMember 腿（memberUnionId 在团队成员名单里）；bot 走团队拉群腿（协作群即团队拉群）。'
      + '两条腿都是「团队群免 grant」，但 evaluateBotTalk 不接受 memberUnionId（bot 信任只认 bot-locked union / 团队群，绝不复用真人成员名单），故命中的 reason 不同。',
  },
  allowedChatGroup: {
    arrange: () => {
      restricted();
      getBot(APP).config.allowedChatGroups = [CHAT];
    },
    human: true, bot: true,
  },
  open: {
    // 开放模式：完全不配 allowlist（不调 restricted()）。
    arrange: () => {},
    human: true, bot: true,
  },
  chatGrant: {
    arrange: () => {
      restricted();
      getBot(APP).config.chatGrants = { [CHAT]: [SENDER] };
    },
    human: true, bot: true,
  },
  globalGrant: {
    arrange: () => {
      restricted();
      getBot(APP).config.globalGrants = [SENDER];
    },
    human: true, bot: true,
  },
  p2pOpen: {
    arrange: () => {
      restricted();
      getBot(APP).config.p2pOpen = true;
    },
    chatType: 'p2p',
    human: true, bot: false,
    why: 'evaluateBotTalk 不传 chatType → p2pOpen 腿 fail-closed。飞书里 bot 之间不存在私聊，开着只是白扩边界。',
  },
};

describe('bot talk parity — bot 闸门与人侧 evaluateTalk 同源', () => {
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'botmux-parity-'));
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

  for (const [reason, c] of Object.entries(CASES) as Array<[TalkReason, ParityCase]>) {
    it(`talk 源 "${reason}"：人=${c.human ? '放行' : '拦截'} / bot=${c.bot ? '放行' : '拦截'}`, () => {
      c.arrange();
      // 人侧：union 走 memberUnionId 腿（不进 bot-trust）。
      const human = evaluateTalk(APP, CHAT, SENDER, undefined, c.humanMemberUnionId, c.chatType);
      // bot 侧：union 是飞书盖章的 bot 发送方 union。
      const forBot = evaluateBotTalk(APP, CHAT, SENDER, SENDER_UNION);

      expect(human.allowed).toBe(c.human);
      expect(forBot.allowed).toBe(c.bot);
      if (c.human && c.bot) {
        if (c.botReason) {
          // 人/bot 各命中自己那条腿（如 teamMember 场景）：分别锁各自的 reason。
          expect(human.reason).toBe(reason);
          expect(forBot.reason).toBe(c.botReason);
        } else {
          // 同源的硬证据：不只是都放行，连判定理由都必须是同一条腿。
          expect(forBot.reason).toBe(human.reason);
          expect(forBot.reason).toBe(reason);
        }
      } else if (c.human) {
        // 人侧单独放行（bot 侧刻意不命中的腿）：仍锁住人侧命中的确实是这条腿本身。
        expect(human.reason).toBe(reason);
      }
      if (c.human !== c.bot || c.botReason) {
        expect(c.why, `talk 源 "${reason}" 人/bot 判定或命中腿不一致，必须在 CASES 里写明 why`).toBeTruthy();
      }
    });
  }

  it('穷尽性：每一条 talk 源都必须在上表里表态（新增 talk 源忘了补格子 → 这里红）', () => {
    // 这条断言是「人/bot 判定不再双写」这个约束的真正执行者。TALK_REASONS 是 src 里的
    // 运行时枚举，加一条腿而不在 CASES 里说明它对 bot 的行为，这里立刻失败。
    expect(Object.keys(CASES).sort())
      .toEqual(TALK_REASONS.filter(r => r !== 'none').slice().sort());
  });

  it('bot 专属腿：团队拉群里未知 bot 免 /grant，但真人**不**因此获得 talk', () => {
    // evaluateBotTalk 唯一比人侧多的一条腿。它不能下沉进 evaluateTalk——那会让
    // 团队群里任何真人都自动过 canTalk，绕开 teamMember 腿的成员校验。
    restricted();
    recordTeamGroup(tempDir, 'team-1', CHAT);

    expect(evaluateBotTalk(APP, CHAT, SENDER, SENDER_UNION)).toEqual({ allowed: true, reason: 'teamBot' });
    expect(evaluateTalk(APP, CHAT, SENDER, undefined, undefined, 'group').allowed).toBe(false);
  });

  it('bot 专属腿不看 union：sender 事件没带 union_id 时仍放行（拉群首次接触）', () => {
    // 回归点：gate 前那次 recordTeamBot 被 `senderUnionId &&` 短路，
    // evaluateTalk 的 teamBot 腿必然落空——此时只剩这条 chat 维度的腿兜底。
    restricted();
    recordTeamGroup(tempDir, 'team-1', CHAT);

    expect(evaluateBotTalk(APP, CHAT, SENDER, undefined).allowed).toBe(true);
  });

  it('团队拉群之外，未知 bot 仍被拦下（交给 /grant 卡）', () => {
    restricted();
    expect(evaluateBotTalk(APP, CHAT, SENDER, SENDER_UNION)).toEqual({ allowed: false, reason: 'none' });
  });
});

describe('canRunDaemonCommand — bot 发送方走 evaluateBotTalk（daemon 命令闸同源）', () => {
  // 回归 PR #685 复审抓到的 P2：本 PR 把 dispatcher 外层闸 + quota 复查收敛到
  // evaluateBotTalk，但 daemon 命令在 quota 复查**之前**先走 canRunDaemonCommand，
  // 其降权到 canTalk 的那段若仍用人侧谓词，「团队拉群 + 外部 bot 无 union_id」就会
  // 能 talk 却执行不了降权命令（/status）。canRunDaemonCommand 的 botSender 形参必须
  // 让 bot 分支走 evaluateBotTalk，与外层同源。
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'botmux-crd-'));
    const bot = registerBot({ larkAppId: APP, larkAppSecret: 's', cliId: 'claude-code', allowedUsers: [] });
    // 受限 bot（配了 allowlist）+ /status 降到 canTalk
    bot.config.allowedUsers = ['ou_owner'];
    bot.resolvedAllowedUsers = ['ou_owner'];
    bot.config.canTalkDaemonCommands = ['/status'];
    // 团队拉群（bot 免 /grant 的信任根）
    recordTeamGroup(tempDir, 'team-1', CHAT);
  });
  afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

  it('团队拉群 + 外部 bot 无 union_id：botSender=true → /status 放行', () => {
    // evaluateBotTalk 的团队拉群腿命中（不看 union）；canRunDaemonCommand 走它才对齐。
    expect(evaluateBotTalk(APP, CHAT, SENDER, undefined).allowed).toBe(true);
    expect(
      canRunDaemonCommand(APP, CHAT, SENDER, undefined, '/status', undefined, 'group', true),
    ).toBe(true);
  });

  it('反向锁：不传 botSender（人侧谓词）→ 同一条 /status 被拒（就是复审复现的分叉）', () => {
    // 人侧 canTalk 无 union → teamBot 腿落空、团队拉群腿不属于人侧 → 拒。
    // 证明放行确实来自 botSender 这条分派，而不是把闸整体放宽。
    expect(
      canRunDaemonCommand(APP, CHAT, SENDER, undefined, '/status', undefined, 'group'),
    ).toBe(false);
  });

  it('bot 发送方但命令不在 canTalkDaemonCommands 名单 → 仍按 canOperate 拒', () => {
    // botSender 只影响「降权到 canTalk」这一段；名单外命令仍要 canOperate。
    expect(
      canRunDaemonCommand(APP, CHAT, SENDER, undefined, '/restart', undefined, 'group', true),
    ).toBe(false);
  });

  it('团队拉群之外的 bot + /status → 仍拒（botSender 不放宽授权本身）', () => {
    const otherChat = 'oc_not_team';
    expect(
      canRunDaemonCommand(APP, otherChat, SENDER, undefined, '/status', undefined, 'group', true),
    ).toBe(false);
  });
});
