/**
 * 同一 owner 的同机 Bot 可以对本 bot 执行管理命令（canOperate）。
 *
 * 身份：飞书盖章的 union_id 精确对上本机 bots.json 里唯一的兄弟应用（与跨部署团队 peer
 * 同一口径，不看名字 / cross-ref）。同一 owner：对方的每个管理员都是本 bot 的管理员，按各自
 * 发布的管理员 union_id 比（管理员在两边可以写成不同形态）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('@larksuiteoapi/node-sdk', () => {
  class FakeClient { constructor(public opts: Record<string, unknown>) {} }
  return { Client: FakeClient };
});

import { getBot, registerBot, loadBotConfigs } from '../src/bot-registry.js';
import { canOperate, canTalk, isTrustedSameOwnerSiblingBot, isVerifiedLocalSiblingBot } from '../src/im/lark/event-dispatcher.js';
import { computeBotAdminUnions, writeBotAdminUnions } from '../src/services/bot-admin-unions-store.js';
import { recordTeamBot } from '../src/services/team-bots-store.js';

const RECV = 'cli_recv';
const SIB = 'cli_sib';
const OTHER = 'cli_other';
/** 兄弟 bot 在本 bot（RECV）视角下的 open_id，以及它们各自的 bot union_id。 */
const SIB_OPEN = 'ou_sib_in_recv';
const SIB_UNION = 'on_sib_bot';
const OTHER_OPEN = 'ou_other_in_recv';
const OTHER_UNION = 'on_other_bot';

let dir: string;

function writeBots(entries: any[]): void {
  writeFileSync(process.env.BOTS_CONFIG!, JSON.stringify(entries, null, 2), 'utf-8');
}

/** 模拟某个 bot 的 daemon 用自己的凭证发布管理员 union_id。 */
async function publishAdmins(appId: string, raw: string[], unionOf: Record<string, string>): Promise<void> {
  const { snapshot } = await computeBotAdminUnions(
    raw,
    new Map(raw.map(r => [r, `ou_${appId}_${r}`])),
    async (ou) => unionOf[ou.replace(`ou_${appId}_`, '')],
  );
  writeBotAdminUnions(dir, appId, snapshot);
}

const BOTS = [
  // 本 bot 的 owner 写成邮箱，兄弟 bot 写成 on_ —— 同一个人，形态不同。
  { larkAppId: RECV, larkAppSecret: 's', cliId: 'claude-code', allowedUsers: ['me@example.com'] },
  { larkAppId: SIB, larkAppSecret: 's', cliId: 'claude-code', allowedUsers: ['on_me'] },
  { larkAppId: OTHER, larkAppSecret: 's', cliId: 'claude-code', allowedUsers: ['someone@example.com'] },
];

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'botmux-same-owner-'));
  process.env.BOTS_CONFIG = join(dir, 'bots.json');
  process.env.SESSION_DATA_DIR = dir;
  writeBots(BOTS);
  // 每个 daemon 只注册自己的 bot；兄弟只在 bots.json 里。
  const recv = registerBot(loadBotConfigs().find(c => c.larkAppId === RECV)!);
  recv.resolvedAllowedUsers = ['ou_me_in_recv'];
  // 兄弟 bot 自己学到的 union_id（bot-union-ids-store）。
  writeFileSync(join(dir, 'bot-union-ids.json'), JSON.stringify({
    [SIB]: { unionId: SIB_UNION, learnedAt: 1 },
    [OTHER]: { unionId: OTHER_UNION, learnedAt: 1 },
  }));
  // 本 bot 的 cross-ref 认识两个兄弟（talk 腿用）。
  writeFileSync(join(dir, `bot-openids-${RECV}.json`), JSON.stringify({ sib: SIB_OPEN, other: OTHER_OPEN }));
  await publishAdmins(RECV, ['me@example.com'], { 'me@example.com': 'on_me' });
  await publishAdmins(SIB, ['on_me'], {});
  await publishAdmins(OTHER, ['someone@example.com'], { 'someone@example.com': 'on_someone' });
});

afterEach(() => {
  delete process.env.BOTS_CONFIG;
  delete process.env.SESSION_DATA_DIR;
  rmSync(dir, { recursive: true, force: true });
});

describe('same-owner sibling bot can operate', () => {
  it('a sibling owned by the same person operates; a sibling of another owner stays talk-only', () => {
    expect(canOperate(RECV, 'oc_1', SIB_OPEN, SIB_UNION)).toBe(true);
    expect(canOperate(RECV, 'oc_1', OTHER_OPEN, OTHER_UNION)).toBe(false);
    // 对话权不变：两个兄弟都能对话（cross-ref peer 腿）。
    expect(canTalk(RECV, 'oc_1', OTHER_OPEN)).toBe(true);
  });

  it('a bot whose display name matches a sibling but whose identity is another app is not trusted', () => {
    // cross-ref 按名字学到「sib」= 这个 open_id（名字可被冒用），但飞书盖章的 union_id
    // 不属于 bots.json 里任何一个兄弟应用 → 不放行管理命令。
    writeFileSync(join(dir, `bot-openids-${RECV}.json`), JSON.stringify({ sib: 'ou_impostor' }));
    expect(canTalk(RECV, 'oc_1', 'ou_impostor')).toBe(true);
    expect(canOperate(RECV, 'oc_1', 'ou_impostor', 'on_impostor_bot')).toBe(false);
  });

  it('identity is the union_id, not the cross-ref: a cold (not yet learned) sibling still operates', () => {
    writeFileSync(join(dir, `bot-openids-${RECV}.json`), '{}');
    expect(canOperate(RECV, 'oc_1', 'ou_not_learned_yet', SIB_UNION)).toBe(true);
  });

  it('no union_id (human path / card clicks) never hits the sibling leg', () => {
    expect(canOperate(RECV, 'oc_1', SIB_OPEN)).toBe(false);
    expect(isTrustedSameOwnerSiblingBot(dir, RECV, undefined)).toBe(false);
  });

  it('two configured siblings that learned the same union_id are ambiguous → not trusted', async () => {
    // 两个都是同一个 owner：哪个都「够格」，但身份对不上唯一一个应用就不认。
    writeBots(BOTS.map(b => (b.larkAppId === OTHER ? { ...b, allowedUsers: ['on_me'] } : b)));
    await publishAdmins(OTHER, ['on_me'], {});
    expect(canOperate(RECV, 'oc_1', OTHER_OPEN, OTHER_UNION)).toBe(true);
    writeFileSync(join(dir, 'bot-union-ids.json'), JSON.stringify({
      [SIB]: { unionId: SIB_UNION, learnedAt: 1 },
      [OTHER]: { unionId: SIB_UNION, learnedAt: 1 },
    }));
    expect(canOperate(RECV, 'oc_1', SIB_OPEN, SIB_UNION)).toBe(false);
  });

  it('bots.json edits take effect on the next check (the parsed config is cached by content)', () => {
    expect(canOperate(RECV, 'oc_1', SIB_OPEN, SIB_UNION)).toBe(true);
    writeBots(BOTS.map(b => (b.larkAppId === SIB ? { ...b, apiOnly: true } : b)));
    expect(canOperate(RECV, 'oc_1', SIB_OPEN, SIB_UNION)).toBe(false);
    writeBots(BOTS);
    expect(canOperate(RECV, 'oc_1', SIB_OPEN, SIB_UNION)).toBe(true);
  });

  it('a sibling removed from bots.json, or marked apiOnly, is no longer a sibling', () => {
    writeBots(BOTS.filter(b => b.larkAppId !== SIB));
    expect(canOperate(RECV, 'oc_1', SIB_OPEN, SIB_UNION)).toBe(false);
    writeBots(BOTS.map(b => (b.larkAppId === SIB ? { ...b, apiOnly: true } : b)));
    expect(canOperate(RECV, 'oc_1', SIB_OPEN, SIB_UNION)).toBe(false);
  });

  it('owner changed but not yet republished (either side) → treated as a different owner', async () => {
    writeBots(BOTS.map(b => (b.larkAppId === SIB ? { ...b, allowedUsers: ['on_new_owner'] } : b)));
    expect(canOperate(RECV, 'oc_1', SIB_OPEN, SIB_UNION)).toBe(false);
    writeBots(BOTS);
    getBot(RECV).config.allowedUsers = ['new-owner@example.com'];
    expect(canOperate(RECV, 'oc_1', SIB_OPEN, SIB_UNION)).toBe(false);
  });

  it("one extra sibling admin this bot does not recognize is enough to refuse (order does not matter)", async () => {
    // 否则 bob（只是兄弟 bot 的管理员）就能借兄弟 bot 操作本 bot。
    for (const admins of [['on_me', 'on_bob'], ['on_bob', 'on_me']]) {
      writeBots(BOTS.map(b => (b.larkAppId === SIB ? { ...b, allowedUsers: admins } : b)));
      await publishAdmins(SIB, admins, {});
      expect(canOperate(RECV, 'oc_1', SIB_OPEN, SIB_UNION)).toBe(false);
    }
  });

  it('a sibling admin whose union_id could not be resolved makes the sibling untrusted', async () => {
    writeBots(BOTS.map(b => (b.larkAppId === SIB ? { ...b, allowedUsers: ['on_me', 'ou_unresolvable'] } : b)));
    await publishAdmins(SIB, ['on_me', 'ou_unresolvable'], {});
    expect(canOperate(RECV, 'oc_1', SIB_OPEN, SIB_UNION)).toBe(false);
  });

  it('a sibling without any effective admin (open mode / nothing resolved) is not trusted', async () => {
    writeBots(BOTS.map(b => (b.larkAppId === SIB ? { ...b, allowedUsers: [] } : b)));
    await publishAdmins(SIB, [], {});
    expect(canOperate(RECV, 'oc_1', SIB_OPEN, SIB_UNION)).toBe(false);
    writeBots(BOTS.map(b => (b.larkAppId === SIB ? { ...b, allowedUsers: ['gone@example.com'] } : b)));
    const { snapshot } = await computeBotAdminUnions(['gone@example.com'], new Map(), async () => undefined);
    writeBotAdminUnions(dir, SIB, snapshot);
    expect(canOperate(RECV, 'oc_1', SIB_OPEN, SIB_UNION)).toBe(false);
  });

  it('any of this bot\'s admins counts on the receiving side', async () => {
    getBot(RECV).config.allowedUsers = ['boss@example.com', 'me@example.com'];
    await publishAdmins(RECV, ['boss@example.com', 'me@example.com'], { 'boss@example.com': 'on_boss', 'me@example.com': 'on_me' });
    expect(canOperate(RECV, 'oc_1', SIB_OPEN, SIB_UNION)).toBe(true);
  });

  it('trustSameOwnerBots=false turns the sibling leg off', () => {
    getBot(RECV).config.trustSameOwnerBots = false;
    expect(canOperate(RECV, 'oc_1', SIB_OPEN, SIB_UNION)).toBe(false);
    expect(canTalk(RECV, 'oc_1', SIB_OPEN)).toBe(true);
  });

  it('a blocked sibling cannot operate', () => {
    getBot(RECV).resolvedBlockedUsers = [SIB_OPEN];
    expect(canOperate(RECV, 'oc_1', SIB_OPEN, SIB_UNION)).toBe(false);
  });

  it('the narrow /repo sibling exception still also requires the cross-ref hit (unchanged)', () => {
    // isVerifiedLocalSiblingBot 改为复用 resolveLocalSiblingBotByUnionId 后，原有的
    // 「cross-ref 也要认识这个 open_id」要求保持不变。
    expect(isVerifiedLocalSiblingBot(dir, RECV, OTHER_OPEN, OTHER_UNION)).toBe(true);
    expect(isVerifiedLocalSiblingBot(dir, RECV, 'ou_not_in_cross_ref', OTHER_UNION)).toBe(false);
    expect(isVerifiedLocalSiblingBot(dir, RECV, OTHER_OPEN, 'on_unknown_bot')).toBe(false);
  });

  it('team peer bots keep operating regardless of the switch (unchanged)', () => {
    recordTeamBot(dir, { unionId: 'on_team_bot' });
    expect(canOperate(RECV, 'oc_1', 'ou_team_in_recv', 'on_team_bot')).toBe(true);
    getBot(RECV).config.trustSameOwnerBots = false;
    expect(canOperate(RECV, 'oc_1', 'ou_team_in_recv', 'on_team_bot')).toBe(true);
  });
});
