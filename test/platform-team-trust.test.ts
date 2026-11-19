/**
 * Platform-team trust through the auth gates: isTrustedTeamBotSender /
 * canOperate / evaluateTalk must honour the platform roster (union_id) at
 * parity with legacy federation team trust — 双模式都免 /grant.
 * Run: pnpm vitest run test/platform-team-trust.test.ts
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@larksuiteoapi/node-sdk', () => {
  class FakeClient { constructor(public opts: Record<string, unknown>) {} }
  return { Client: FakeClient };
});

import { config } from '../src/config.js';
import { registerBot } from '../src/bot-registry.js';
import { canOperate, evaluateBotTalk, evaluateTalk, isTrustedTeamBotSender, learnTeamBotFromGroupMessage } from '../src/im/lark/event-dispatcher.js';
import { applyPlatformTeamSync } from '../src/services/platform-team-store.js';
import { isTeamBot, recordTeamBot } from '../src/services/team-bots-store.js';
import { recordTeamGroup } from '../src/services/team-groups-store.js';

let dataDir: string;
const prevBotsConfig = process.env.BOTS_CONFIG;
/** 本机 bots.json（同机判定的来源）。默认只有本 bot pf1。 */
function writeLocalBots(appIds: string[]): void {
  writeFileSync(process.env.BOTS_CONFIG!, JSON.stringify(
    appIds.map(larkAppId => ({ larkAppId, larkAppSecret: 's', cliId: 'claude-code', allowedUsers: ['ou_owner'] })),
  ), 'utf-8');
}
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'botmux-pftrust-'));
  config.session.dataDir = dataDir;
  process.env.BOTS_CONFIG = join(dataDir, 'bots.json');
  writeLocalBots(['pf1']);
  const bot = registerBot({ larkAppId: 'pf1', larkAppSecret: 's', cliId: 'claude-code', allowedUsers: ['ou_owner'] });
  bot.resolvedAllowedUsers = ['ou_owner'];
});
afterEach(() => {
  if (prevBotsConfig === undefined) delete process.env.BOTS_CONFIG;
  else process.env.BOTS_CONFIG = prevBotsConfig;
});

function seedPlatformTeam(): void {
  applyPlatformTeamSync(dataDir, {
    rev: 'r1',
    teams: [{
      teamId: 't1', teamName: 'T1', groupChatIds: ['oc_hall', 'oc_group'],
      // 本 bot pf1 也在团队 bots roster 里 —— teamMember 腿现在锚在「本 bot ∈ 同队 bots」，
      // 不再看 chatId。cli_peer 是同队的另一个 bot（teamBot 腿用）。
      bots: [{ appId: 'cli_peer', unionId: 'on_peer', name: 'Peer' }, { appId: 'pf1', unionId: 'on_pf1', name: 'Self' }],
      memberUnionIds: ['on_teammate'],
    }],
  });
}

describe('isTrustedTeamBotSender (platform mode)', () => {
  it('trusts a platform roster bot by union_id in ANY chat', () => {
    seedPlatformTeam();
    expect(isTrustedTeamBotSender(dataDir, 'pf1', 'oc_random', 'on_peer')).toBe(true);
    expect(isTrustedTeamBotSender(dataDir, 'pf1', 'oc_random', 'on_stranger')).toBe(false);
  });

  it('trusts first contact inside the mirrored 大厅/团队群', () => {
    seedPlatformTeam();
    // union_id not in roster yet (fresh bot, not yet echoed) but the hall is trusted
    expect(isTrustedTeamBotSender(dataDir, 'pf1', 'oc_hall', 'on_fresh')).toBe(true);
  });
});

describe('canOperate (platform mode)', () => {
  it('grants operate to a platform roster bot by union_id', () => {
    seedPlatformTeam();
    expect(canOperate('pf1', 'oc_random', 'ou_scoped', 'on_peer')).toBe(true);
    expect(canOperate('pf1', 'oc_random', 'ou_scoped', 'on_human')).toBe(false);
  });
});

describe('evaluateTalk teamBot leg (quota gate end-to-end hole fix)', () => {
  it('allows a platform roster bot on a RESTRICTED receiver', () => {
    seedPlatformTeam();
    const ev = evaluateTalk('pf1', 'oc_random', 'ou_peer_scoped', 'on_peer');
    expect(ev.allowed).toBe(true);
    expect(ev.reason).toBe('teamBot');
  });

  it('allows a LEGACY learned team bot too (parity across 两条路)', () => {
    recordTeamBot(dataDir, { unionId: 'on_legacy', name: 'Legacy' });
    const ev = evaluateTalk('pf1', 'oc_random', 'ou_legacy_scoped', 'on_legacy');
    expect(ev.allowed).toBe(true);
    expect(ev.reason).toBe('teamBot');
  });

  it('still denies unknown senders without union_id backing', () => {
    expect(evaluateTalk('pf1', 'oc_random', 'ou_x', 'on_unknown').allowed).toBe(false);
    expect(evaluateTalk('pf1', 'oc_random', 'ou_x').allowed).toBe(false);
  });
});

describe('evaluateTalk teamMember leg (human 免grant, talk-only, team-co-membership-scoped)', () => {
  it('allows a team member (human) TALK when sender & bot share a platform team, via memberUnionId', () => {
    seedPlatformTeam();
    // 人的 union 走第 5 参 memberUnionId，不进 bot-trust（第 4 参）
    const ev = evaluateTalk('pf1', 'oc_group', 'ou_tp', undefined, 'on_teammate');
    expect(ev.allowed).toBe(true);
    expect(ev.reason).toBe('teamMember');
  });

  it('is NOT chat-scoped: same member allowed in ANY chat, incl. 未登记的手动/原生 invite 群', () => {
    seedPlatformTeam();
    // oc_random 不在 groupChatIds 里（手动建群 / 原生 invite 场景）——照样免 grant
    const ev = evaluateTalk('pf1', 'oc_random', 'ou_tp', undefined, 'on_teammate');
    expect(ev.allowed).toBe(true);
    expect(ev.reason).toBe('teamMember');
  });

  it('member union in the bot-trust slot must NOT grant operate (talk-only leg)', () => {
    seedPlatformTeam();
    // 就算把成员 union 塞进 bot-trust 参，canOperate 也不认（不是 bot、不是 memberleg）
    expect(canOperate('pf1', 'oc_group', 'ou_tp', 'on_teammate')).toBe(false);
  });

  it('a member union fed into the bot-trust slot does NOT fire teamBot', () => {
    seedPlatformTeam();
    // 第 4 参是 bot-locked：喂成员 union 进去不应命中 teamBot（它不在 bots roster）
    const ev = evaluateTalk('pf1', 'oc_random', 'ou_tp', 'on_teammate');
    expect(ev.allowed).toBe(false);
  });
});

// 平台 roster 是按机器下发的（owner 所在的全部团队）。本机 owner 同时在 T1、T2：
// pf1 只在 T1；cli_remote 只在 T2、跑在别的机器上；cli_local 只在 T2、但配置在本机。
// 以前「本机任一团队里有它」就放行 → 别的机器上 T2 的 bot 能驱动只在 T1 的 pf1。
describe('platform roster trust is scoped to the RECEIVING bot (same team or same machine)', () => {
  function seedTwoTeams(): void {
    applyPlatformTeamSync(dataDir, {
      rev: 'r2',
      teams: [
        { teamId: 't1', teamName: 'T1', groupChatIds: ['oc_t1_hall'], bots: [{ appId: 'pf1', unionId: 'on_pf1' }, { appId: 'cli_peer', unionId: 'on_peer' }], memberUnionIds: [] },
        { teamId: 't2', teamName: 'T2', groupChatIds: ['oc_t2_hall'], bots: [{ appId: 'cli_remote', unionId: 'on_remote' }, { appId: 'cli_local', unionId: 'on_local' }], memberUnionIds: [] },
      ],
    });
  }

  it('a remote bot from a team the receiver is NOT in gets neither talk nor operate', () => {
    seedTwoTeams();
    expect(evaluateTalk('pf1', 'oc_public', 'ou_remote', 'on_remote').allowed).toBe(false);
    expect(evaluateBotTalk('pf1', 'oc_public', 'ou_remote', 'on_remote').allowed).toBe(false);
    expect(isTrustedTeamBotSender(dataDir, 'pf1', 'oc_public', 'on_remote')).toBe(false);
    expect(canOperate('pf1', 'oc_public', 'ou_remote', 'on_remote')).toBe(false);
  });

  it('a remote bot on the SAME team as the receiver keeps talk + operate', () => {
    seedTwoTeams();
    const ev = evaluateBotTalk('pf1', 'oc_public', 'ou_peer', 'on_peer');
    expect(ev).toMatchObject({ allowed: true, reason: 'teamBot' });
    expect(canOperate('pf1', 'oc_public', 'ou_peer', 'on_peer')).toBe(true);
  });

  it('a bot configured on THIS machine stays trusted even from another team', () => {
    seedTwoTeams();
    writeLocalBots(['pf1', 'cli_local']);
    expect(evaluateBotTalk('pf1', 'oc_public', 'ou_local', 'on_local')).toMatchObject({ allowed: true, reason: 'teamBot' });
    expect(canOperate('pf1', 'oc_public', 'ou_local', 'on_local')).toBe(true);
    // 同机放行只看发送方自己的 appId：别的机器上的 T2 队友不沾光
    expect(canOperate('pf1', 'oc_public', 'ou_remote', 'on_remote')).toBe(false);
  });

  it('an unreadable bots.json fails closed for the same-machine leg only', () => {
    seedTwoTeams();
    writeFileSync(process.env.BOTS_CONFIG!, '{ not json', 'utf-8');
    expect(canOperate('pf1', 'oc_public', 'ou_local', 'on_local')).toBe(false);
    expect(canOperate('pf1', 'oc_public', 'ou_peer', 'on_peer')).toBe(true);
  });

  it('a remote other-team bot speaking in a platform team group is NOT learned into machine-wide team trust', () => {
    seedTwoTeams();
    writeLocalBots(['pf1', 'cli_local']);
    // cli_local（T2，本机）所在的 T2 团队群里，别的机器上的 T2 bot 发了一句话
    expect(learnTeamBotFromGroupMessage(dataDir, 'oc_t2_hall', 'on_remote')).toBe(false);
    expect(isTeamBot(dataDir, 'on_remote')).toBe(false);
    expect(canOperate('pf1', 'oc_public', 'ou_remote', 'on_remote')).toBe(false);
    expect(evaluateBotTalk('pf1', 'oc_public', 'ou_remote', 'on_remote').allowed).toBe(false);
  });

  it('legacy federation 拉群 groups still teach teammates', () => {
    recordTeamGroup(dataDir, 'legacy-team', 'oc_legacy');
    expect(learnTeamBotFromGroupMessage(dataDir, 'oc_legacy', 'on_legacy_mate')).toBe(true);
    expect(evaluateTalk('pf1', 'oc_public', 'ou_legacy_mate', 'on_legacy_mate')).toMatchObject({ allowed: true, reason: 'teamBot' });
  });

  it('first contact inside a platform team group only counts for bots on THAT team', () => {
    seedTwoTeams();
    // pf1 只在 T1：T2 群里来的陌生 bot 不能因为「这是团队群」就免授权
    expect(evaluateBotTalk('pf1', 'oc_t2_hall', 'ou_fresh', 'on_fresh').allowed).toBe(false);
    // T1 自己的团队群照旧放行首次接触
    expect(evaluateBotTalk('pf1', 'oc_t1_hall', 'ou_fresh', 'on_fresh')).toMatchObject({ allowed: true, reason: 'teamBot' });
    // 旧版联邦团队群按群放行，不变
    recordTeamGroup(dataDir, 'legacy-team', 'oc_legacy');
    expect(evaluateBotTalk('pf1', 'oc_legacy', 'ou_fresh', 'on_fresh').allowed).toBe(true);
  });

  it('the receiving bot need not be on any team to trust a same-machine roster bot', () => {
    applyPlatformTeamSync(dataDir, {
      rev: 'r3',
      teams: [{ teamId: 't2', teamName: 'T2', groupChatIds: [], bots: [{ appId: 'cli_local', unionId: 'on_local' }, { appId: 'cli_remote', unionId: 'on_remote' }], memberUnionIds: [] }],
    });
    writeLocalBots(['pf1', 'cli_local']);
    expect(evaluateTalk('pf1', 'oc_public', 'ou_local', 'on_local').allowed).toBe(true);
    expect(evaluateTalk('pf1', 'oc_public', 'ou_remote', 'on_remote').allowed).toBe(false);
  });
});
