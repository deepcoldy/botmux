/**
 * platform-team-store: apply/rev/roster predicate + the team-groups mirror
 * (replace-by-prefix that must never touch legacy federation entries).
 * Run: pnpm vitest run test/platform-team-store.test.ts
 */
import { mkdirSync, mkdtempSync } from 'node:fs';
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
} from '../src/services/platform-team-store.js';
import { recordTeamGroup, isTeamGroupChat, listTeamGroups } from '../src/services/team-groups-store.js';

let dataDir: string;
beforeEach(() => { dataDir = mkdtempSync(join(tmpdir(), 'botmux-pfteam-')); });

const payload = (rev: string, teams: unknown[]) => ({ rev, teams });
const team = (
  teamId: string,
  chatIds: string[],
  bots: Array<{ appId: string; unionId?: string }>,
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

  it('preserves optional per-bot version and A2A capability facts', () => {
    applyPlatformTeamSync(dataDir, payload('rev-ready', [{
      teamId: 't1',
      teamName: 'team',
      groupChatIds: ['oc_goal'],
      memberUnionIds: [],
      bots: [{
        appId: 'cli_remote',
        unionId: 'on_remote',
        name: 'relay-loopy',
        botmuxVersion: '2.109.0-canary.0',
        a2aCapabilities: ['delivery-envelope:v1', 'dispatch-repo:v1', '', 42],
      }],
    }]));
    expect(listPlatformTeams(dataDir)[0]?.bots[0]).toEqual({
      appId: 'cli_remote',
      unionId: 'on_remote',
      name: 'relay-loopy',
      botmuxVersion: '2.109.0-canary.0',
      a2aCapabilities: ['delivery-envelope:v1', 'dispatch-repo:v1'],
    });
  });

  it('preserves an explicit empty capability set instead of degrading it to unknown', () => {
    applyPlatformTeamSync(dataDir, payload('rev-empty-capabilities', [{
      teamId: 't1',
      teamName: 'team',
      groupChatIds: ['oc_goal'],
      memberUnionIds: [],
      bots: [{ appId: 'cli_legacy', a2aCapabilities: [] }],
    }]));
    expect(listPlatformTeams(dataDir)[0]?.bots[0]).toEqual({
      appId: 'cli_legacy',
      unionId: undefined,
      name: undefined,
      a2aCapabilities: [],
    });
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

  it('publishes the new rev only after the team-group trust mirror succeeds', () => {
    // Force the mirror write to fail. The rev is the heartbeat commit marker;
    // it must stay old/empty so the platform retries the full snapshot.
    mkdirSync(join(dataDir, 'team-groups.json'));
    expect(() => applyPlatformTeamSync(dataDir, payload('rev1', [team('t1', ['oc_hall'], [])]))).toThrow();
    expect(getPlatformTeamSyncRev(dataDir)).toBe('');
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
});
