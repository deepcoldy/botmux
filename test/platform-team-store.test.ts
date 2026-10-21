/**
 * platform-team-store: apply/rev/roster predicate + the team-groups mirror
 * (replace-by-prefix that must never touch legacy federation entries).
 * Run: pnpm vitest run test/platform-team-store.test.ts
 */
import { mkdtempSync } from 'node:fs';
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
  resolvePlatformTeamBotOwner,
} from '../src/services/platform-team-store.js';
import { recordTeamGroup, isTeamGroupChat, listTeamGroups } from '../src/services/team-groups-store.js';

let dataDir: string;
beforeEach(() => { dataDir = mkdtempSync(join(tmpdir(), 'botmux-pfteam-')); });

const payload = (rev: string, teams: unknown[]) => ({ rev, teams });
const team = (
  teamId: string,
  chatIds: string[],
  bots: Array<{ appId: string; unionId?: string; ownerUnionId?: string }>,
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
    expect(isTeamGroupChat(dataDir, 'oc_hall')).toBe(true);
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
    expect(isTeamGroupChat(dataDir, 'oc_hall1')).toBe(false);
    expect(isTeamGroupChat(dataDir, 'oc_hall1b')).toBe(true);
    expect(isTeamGroupChat(dataDir, 'oc_hall2')).toBe(false);
    expect(isPlatformTeamBot(dataDir, 'on_b')).toBe(false);
    expect(isPlatformTeamBot(dataDir, 'on_a')).toBe(true);
  });

  it('never touches legacy federation team-groups entries', () => {
    recordTeamGroup(dataDir, 'legacyTeam', 'oc_legacy');
    applyPlatformTeamSync(dataDir, payload('rev1', [team('t1', ['oc_hall'], [])]));
    applyPlatformTeamSync(dataDir, payload('rev2', [])); // machine left all platform teams
    expect(isTeamGroupChat(dataDir, 'oc_legacy')).toBe(true);
    expect(isTeamGroupChat(dataDir, 'oc_hall')).toBe(false);
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
      team('ok', ['oc_x'], [{ appId: '' }, { appId: 'cli_a', unionId: 'on_a' }]),
    ]));
    expect(applied?.teams).toHaveLength(1);
    expect(applied?.teams[0].bots).toEqual([{ appId: 'cli_a', unionId: 'on_a', name: undefined }]);
  });

  it('resolves a peer bot owner only inside the target bot team', () => {
    applyPlatformTeamSync(dataDir, payload('rev1', [
      team('t1', ['oc_hall'], [
        { appId: 'cli_target', unionId: 'on_target', ownerUnionId: 'on_targetowner' },
        { appId: 'cli_source', unionId: 'on_source_bot', ownerUnionId: 'on_sourceowner' },
      ], ['on_targetowner', 'on_sourceowner']),
    ]));
    expect(resolvePlatformTeamBotOwner(dataDir, 'cli_target', 'on_source_bot')).toEqual({
      status: 'resolved', ownerUnionId: 'on_sourceowner',
    });
  });

  it('fails closed for conflicting or non-member owner attribution', () => {
    applyPlatformTeamSync(dataDir, payload('rev1', [
      team('a', ['oc_a'], [
        { appId: 'cli_target', unionId: 'on_target' },
        { appId: 'cli_source_a', unionId: 'on_source', ownerUnionId: 'on_ownera' },
      ], ['on_ownera']),
      team('b', ['oc_b'], [
        { appId: 'cli_target', unionId: 'on_target' },
        { appId: 'cli_source_b', unionId: 'on_source', ownerUnionId: 'on_ownerb' },
      ], ['on_ownerb']),
      team('c', ['oc_c'], [
        { appId: 'cli_target', unionId: 'on_target' },
        { appId: 'cli_source_c', unionId: 'on_unowned', ownerUnionId: 'on_notmember' },
      ], []),
    ]));
    expect(resolvePlatformTeamBotOwner(dataDir, 'cli_target', 'on_source')).toEqual({ status: 'conflict' });
    expect(resolvePlatformTeamBotOwner(dataDir, 'cli_target', 'on_unowned')).toEqual({ status: 'missing' });
  });

  it('never accepts an owner from a team the target bot does not belong to', () => {
    // The source bot + owner pair is fully consistent inside "foreign", but
    // cli_target is only in "home". The same-team gate must keep a roster
    // entry scoped to another team from minting an owner for cli_target.
    applyPlatformTeamSync(dataDir, payload('rev1', [
      team('foreign', ['oc_f'], [
        { appId: 'cli_source', unionId: 'on_source_bot', ownerUnionId: 'on_sourceowner' },
      ], ['on_sourceowner']),
      team('home', ['oc_h'], [
        { appId: 'cli_target', unionId: 'on_target' },
      ], []),
    ]));
    expect(resolvePlatformTeamBotOwner(dataDir, 'cli_target', 'on_source_bot')).toEqual({ status: 'missing' });
  });

  it('rejects non-canonical target appId and source bot unionId prefixes', () => {
    // sanitizeTeam accepts arbitrary non-empty appId/unionId strings, so the
    // cli_ / on_ prefix gates inside the resolver are what keep such roster
    // rows from producing an owner attribution.
    applyPlatformTeamSync(dataDir, payload('rev1', [
      team('foreign-app', ['oc_fa'], [
        { appId: 'weird-app', unionId: 'on_source_bot', ownerUnionId: 'on_ownerfa' },
      ], ['on_ownerfa']),
      team('home', ['oc_h'], [
        { appId: 'cli_target', unionId: 'on_target' },
        { appId: 'cli_source', unionId: 'weird-bot-union', ownerUnionId: 'on_ownerh' },
      ], ['on_ownerh']),
    ]));
    expect(resolvePlatformTeamBotOwner(dataDir, 'weird-app', 'on_source_bot')).toEqual({ status: 'missing' });
    expect(resolvePlatformTeamBotOwner(dataDir, 'cli_target', 'weird-bot-union')).toEqual({ status: 'missing' });
  });

});
