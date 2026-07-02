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
  listPlatformTeams,
  PLATFORM_TEAM_PREFIX,
} from '../src/services/platform-team-store.js';
import { recordTeamGroup, isTeamGroupChat, listTeamGroups } from '../src/services/team-groups-store.js';

let dataDir: string;
beforeEach(() => { dataDir = mkdtempSync(join(tmpdir(), 'botmux-pfteam-')); });

const payload = (rev: string, teams: unknown[]) => ({ rev, teams });
const team = (teamId: string, chatIds: string[], bots: Array<{ appId: string; unionId?: string }>) =>
  ({ teamId, teamName: teamId, groupChatIds: chatIds, bots });

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
