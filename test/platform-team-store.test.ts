/**
 * platform-team-store: apply/rev/roster predicate + the team-groups mirror
 * (replace-by-prefix that must never touch legacy federation entries).
 * Run: pnpm vitest run test/platform-team-store.test.ts
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach } from 'vitest';

import {
  applyPlatformTeamSync,
  getPlatformTeamSyncRev,
  isPlatformTeamBot,
  isPlatformHallChat,
  isPlatformTeamMember,
  listPlatformTeams,
  PLATFORM_TEAM_PREFIX,
  isLegacyTeamGroupChat,
  isPlatformTeamBotTrustedBy,
  isTeamGroupChatFor,
} from '../src/services/platform-team-store.js';
import { recordTeamGroup, listTeamGroups } from '../src/services/team-groups-store.js';

let dataDir: string;
beforeEach(() => { dataDir = mkdtempSync(join(tmpdir(), 'botmux-pfteam-')); });

const payload = (rev: string, teams: unknown[]) => ({ rev, teams });
const team = (
  teamId: string,
  chatIds: string[],
  bots: Array<{ appId: string; unionId?: string; external?: unknown }>,
  memberUnionIds: string[] = [],
) => ({ teamId, teamName: teamId, groupChatIds: chatIds, bots, memberUnionIds });

describe('applyPlatformTeamSync', () => {
  it('persists rev + teams and answers the roster predicate', () => {
    expect(getPlatformTeamSyncRev(dataDir)).toBe('');
    const applied = applyPlatformTeamSync(dataDir, payload('rev1', [
      team('t1', ['oc_hall'], [{ appId: 'cli_a', unionId: 'on_a' }, { appId: 'cli_b' }]),
    ]));
    expect(applied?.rev).toBe('rev1');
    expect(getPlatformTeamSyncRev(dataDir)).toBe('rev1');
    expect(listPlatformTeams(dataDir)).toHaveLength(1);
    expect(isPlatformTeamBot(dataDir, 'on_a')).toBe(true);
    expect(isPlatformTeamBot(dataDir, 'on_unknown')).toBe(false);
    expect(isPlatformTeamBot(dataDir, undefined)).toBe(false);
  });

  it('mirrors group chats into team-groups under the platform prefix', () => {
    applyPlatformTeamSync(dataDir, payload('rev1', [team('t1', ['oc_hall'], [])]));
    const entry = listTeamGroups(dataDir).find(g => g.chatId === 'oc_hall');
    expect(entry?.teamId).toBe(`${PLATFORM_TEAM_PREFIX}t1`);
  });

  it('re-apply REPLACES platform entries (left team / dissolved hall drop out)', () => {
    applyPlatformTeamSync(dataDir, payload('rev1', [
      team('t1', ['oc_hall1'], [{ appId: 'cli_a', unionId: 'on_a' }]),
      team('t2', ['oc_hall2'], [{ appId: 'cli_b', unionId: 'on_b' }]),
    ]));
    // t2 gone, t1's hall rebuilt under a new chat id
    applyPlatformTeamSync(dataDir, payload('rev2', [
      team('t1', ['oc_hall1b'], [{ appId: 'cli_a', unionId: 'on_a' }]),
    ]));
    expect(listTeamGroups(dataDir).some(g => g.chatId === 'oc_hall1')).toBe(false);
    expect(listTeamGroups(dataDir).some(g => g.chatId === 'oc_hall1b')).toBe(true);
    expect(listTeamGroups(dataDir).some(g => g.chatId === 'oc_hall2')).toBe(false);
    expect(isPlatformTeamBot(dataDir, 'on_b')).toBe(false);
    expect(isPlatformTeamBot(dataDir, 'on_a')).toBe(true);
  });

  it('keeps the previous rev for heartbeat retry when the group mirror write fails', () => {
    applyPlatformTeamSync(dataDir, payload('rev1', [team('t1', ['oc_old'], [{ appId: 'cli_a', unionId: 'on_a' }])]));
    const mirrorPath = join(dataDir, 'team-groups.json');
    rmSync(mirrorPath, { force: true });
    mkdirSync(mirrorPath); // 真实写失败：atomic rename 不能用文件覆盖目录。

    expect(() => applyPlatformTeamSync(dataDir, payload('rev2', [team('t1', ['oc_new'], [{ appId: 'cli_b', unionId: 'on_b' }])]))).toThrow();
    expect(getPlatformTeamSyncRev(dataDir)).toBe('rev1');
    expect(listPlatformTeams(dataDir)[0].bots.map(b => b.appId)).toEqual(['cli_a']);

    rmSync(mirrorPath, { recursive: true, force: true });
    applyPlatformTeamSync(dataDir, payload('rev2', [team('t1', ['oc_new'], [{ appId: 'cli_b', unionId: 'on_b' }])]));
    expect(getPlatformTeamSyncRev(dataDir)).toBe('rev2');
    expect(listTeamGroups(dataDir).some(g => g.chatId === 'oc_new')).toBe(true);
  });

  it('never touches legacy federation team-groups entries', () => {
    recordTeamGroup(dataDir, 'legacyTeam', 'oc_legacy');
    applyPlatformTeamSync(dataDir, payload('rev1', [team('t1', ['oc_hall'], [])]));
    // 平台镜像不算旧版联邦团队群（不进 team-bots 学习闸）
    expect(isLegacyTeamGroupChat(dataDir, 'oc_hall')).toBe(false);
    expect(isLegacyTeamGroupChat(dataDir, 'oc_legacy')).toBe(true);
    applyPlatformTeamSync(dataDir, payload('rev2', [])); // machine left all platform teams
    expect(listTeamGroups(dataDir).some(g => g.chatId === 'oc_legacy')).toBe(true);
    expect(listTeamGroups(dataDir).some(g => g.chatId === 'oc_hall')).toBe(false);
  });

  it('isPlatformHallChat matches only the FIRST chatId per team (hall-first protocol)', () => {
    applyPlatformTeamSync(dataDir, payload('rev1', [team('t1', ['oc_hall_a', 'oc_team_group'], [])]));
    expect(isPlatformHallChat(dataDir, 'oc_hall_a')).toBe(true);
    // 非首位的团队群不是大厅——bot 互 @ 必须正常路由，不能被吞
    expect(isPlatformHallChat(dataDir, 'oc_team_group')).toBe(false);
    expect(isPlatformHallChat(dataDir, 'oc_other')).toBe(false);
    expect(isPlatformHallChat(dataDir, '')).toBe(false);
    expect(isPlatformHallChat(dataDir, undefined)).toBe(false);
    // 团队消失后不再命中（follow membership，无残留信任面）
    applyPlatformTeamSync(dataDir, payload('rev2', []));
    expect(isPlatformHallChat(dataDir, 'oc_hall_a')).toBe(false);
  });

  it('isPlatformTeamMember: member of a team this bot is in → true; scoped by team co-membership, not chat, talk-only', () => {
    applyPlatformTeamSync(dataDir, payload('rev1', [
      team('t1', ['oc_hall1', 'oc_group1'], [{ appId: 'cli_a', unionId: 'on_bot' }], ['on_alice', 'on_bob']),
      team('t2', ['oc_hall2'], [{ appId: 'cli_b', unionId: 'on_bot2' }], ['on_carol']),
    ]));
    // 成员与本 bot 同属一个团队 → true，任意群（含未登记的手动群）都免 grant，不再看 chatId
    expect(isPlatformTeamMember(dataDir, 'cli_a', 'on_alice')).toBe(true);
    expect(isPlatformTeamMember(dataDir, 'cli_a', 'on_bob')).toBe(true);
    // 跨团队不泄漏：t2 成员对 t1 的 bot cli_a → false；t1 成员对 t2 的 bot cli_b → false
    expect(isPlatformTeamMember(dataDir, 'cli_a', 'on_carol')).toBe(false);
    expect(isPlatformTeamMember(dataDir, 'cli_b', 'on_alice')).toBe(false);
    // t2 成员对 t2 的 bot cli_b → true（本队内）
    expect(isPlatformTeamMember(dataDir, 'cli_b', 'on_carol')).toBe(true);
    // 非成员 union（bot 自己的 union 不是 member）、非本队 bot、空值 → false
    expect(isPlatformTeamMember(dataDir, 'cli_a', 'on_bot')).toBe(false); // bot 不是 member
    expect(isPlatformTeamMember(dataDir, 'cli_unknown', 'on_alice')).toBe(false); // 本机不托管这个 bot
    expect(isPlatformTeamMember(dataDir, '', 'on_alice')).toBe(false);
    expect(isPlatformTeamMember(dataDir, 'cli_a', undefined)).toBe(false);
    // 团队消失 → 不再命中
    applyPlatformTeamSync(dataDir, payload('rev2', []));
    expect(isPlatformTeamMember(dataDir, 'cli_a', 'on_alice')).toBe(false);
  });

  it('rejects a payload without rev and sanitizes malformed teams', () => {
    expect(applyPlatformTeamSync(dataDir, { rev: '', teams: [] })).toBeNull();
    const applied = applyPlatformTeamSync(dataDir, payload('rev1', [
      null,
      { teamName: 'no-id' },
      team('ok', ['oc_x'], [{ appId: '' }, {
        appId: 'cli_a', unionId: 'on_a', ownerUnionId: 'on_untrusted',
      } as unknown as { appId: string; unionId?: string }]),
    ]));
    // Owner-looking fields remain untrusted platform metadata and are dropped;
    // credential attribution reads only the target Bot's local config.
    expect(applied?.teams).toHaveLength(1);
    expect(applied?.teams[0].bots).toEqual([{ appId: 'cli_a', unionId: 'on_a', name: undefined }]);
  });

});

describe('external roster entries', () => {
  it('keeps external: true, drops any other value, and does not treat its unverified union as non-human evidence', () => {
    applyPlatformTeamSync(dataDir, payload('rev-ext', [
      team('t1', ['oc_hall'], [
        { appId: 'cli_ext', unionId: 'on_ext', external: true },
        { appId: 'cli_odd', unionId: 'on_odd', external: 'yes' },
        { appId: 'cli_a', unionId: 'on_a' },
      ]),
    ]));
    const bots = listPlatformTeams(dataDir)[0].bots;
    expect(bots).toEqual([
      { appId: 'cli_ext', unionId: 'on_ext', name: undefined, external: true },
      { appId: 'cli_odd', unionId: 'on_odd', name: undefined },
      { appId: 'cli_a', unionId: 'on_a', name: undefined },
    ]);
    // 外部条目的 union 是成员手填的，可能是真人或另一个 app 的 union，不能证明 non-human。
    expect(isPlatformTeamBot(dataDir, 'on_ext')).toBe(false);
    expect(isPlatformTeamBot(dataDir, 'on_a')).toBe(true);
  });

  it('an external entry never makes a bot a team member for the human talk leg', () => {
    applyPlatformTeamSync(dataDir, payload('rev-ext2', [
      team('t1', [], [{ appId: 'cli_x', unionId: 'on_x', external: true }], ['on_member']),
    ]));
    expect(isPlatformTeamMember(dataDir, 'cli_x', 'on_member')).toBe(false);
  });
});

describe('legacy platform-team snapshots', () => {
  it('fails closed and requests a fresh sync instead of trusting a pre-external snapshot', () => {
    const legacy = payload('rev-legacy', [
      team('t1', ['oc_hall'], [
        { appId: 'cli_local', unionId: 'on_chosen' },
        { appId: 'pf1', unionId: 'on_external_receiver' },
        { appId: 'cli_a', unionId: 'on_a' },
      ], ['on_member']),
    ]);
    // 旧版 sanitizeTeam 的持久化形状：没有格式版本，也已丢掉 external:true。
    writeFileSync(join(dataDir, 'platform-team-sync.json'), JSON.stringify({ ...legacy, updatedAt: 1 }));

    expect(getPlatformTeamSyncRev(dataDir)).toBe('');
    expect(listPlatformTeams(dataDir)).toEqual([]);
    // 授权必须失效，但大厅路由元数据仍需 fail-closed 地吞掉 bot 消息。
    expect(isPlatformHallChat(dataDir, 'oc_hall')).toBe(true);
    expect(isPlatformTeamBot(dataDir, 'on_a')).toBe(false);
    expect(isPlatformTeamBotTrustedBy(dataDir, 'pf1', 'on_chosen', () => true, 'cli_local')).toBe(false);
    expect(isPlatformTeamMember(dataDir, 'pf1', 'on_member')).toBe(false);
    expect(isTeamGroupChatFor(dataDir, 'pf1', 'oc_hall')).toBe(false);

    applyPlatformTeamSync(dataDir, payload('rev-legacy', [
      team('t1', ['oc_hall'], [
        { appId: 'cli_local', unionId: 'on_chosen', external: true },
        { appId: 'pf1', unionId: 'on_external_receiver', external: true },
        { appId: 'cli_a', unionId: 'on_a' },
      ], ['on_member']),
    ]));
    expect(getPlatformTeamSyncRev(dataDir)).toBe('rev-legacy');
    expect(listPlatformTeams(dataDir)).toHaveLength(1);
    expect(isPlatformTeamBot(dataDir, 'on_a')).toBe(true);
    expect(isPlatformTeamBotTrustedBy(dataDir, 'pf1', 'on_chosen', () => true, 'cli_local')).toBe(false);
    expect(isPlatformTeamMember(dataDir, 'pf1', 'on_member')).toBe(false);
    expect(isTeamGroupChatFor(dataDir, 'pf1', 'oc_hall')).toBe(false);
  });
});
