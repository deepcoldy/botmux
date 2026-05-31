/**
 * Team-level roster builder for the platform UI.
 * Run: pnpm vitest run test/team-roster.test.ts
 */
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach } from 'vitest';
import { buildTeamRoster } from '../src/services/team-roster.js';
import { setBotCapability } from '../src/services/bot-profile-store.js';
import { setBotOwner } from '../src/services/bot-owner-store.js';
import { ensureDefaultTeam, addMember, DEFAULT_TEAM_ID } from '../src/services/team-store.js';

let dataDir: string;
beforeEach(() => { dataDir = mkdtempSync(join(tmpdir(), 'botmux-roster-')); });

function writeBotsInfo(entries: any[]) {
  writeFileSync(join(dataDir, 'bots-info.json'), JSON.stringify(entries));
}
function writeTeamRole(larkAppId: string) {
  mkdirSync(join(dataDir, 'team-roles'), { recursive: true });
  writeFileSync(join(dataDir, 'team-roles', `${larkAppId}.md`), '# role');
}

describe('buildTeamRoster', () => {
  it('empty when nothing recorded', () => {
    const r = buildTeamRoster(dataDir);
    expect(r.bots).toEqual([]);
    expect(r.team).toEqual({ id: DEFAULT_TEAM_ID, name: '默认团队', memberCount: 0 });
  });

  it('lists bots enriched with capability + hasTeamRole, and team member count', () => {
    writeBotsInfo([
      { larkAppId: 'cli_a', botOpenId: 'ou_a', botName: '后端Bot', cliId: 'codex' },
      { larkAppId: 'cli_b', botOpenId: 'ou_b', botName: null, cliId: 'claude-code' },
    ]);
    setBotCapability(dataDir, 'cli_a', '服务端排查');
    writeTeamRole('cli_a');
    ensureDefaultTeam(dataDir);
    addMember(dataDir, DEFAULT_TEAM_ID, { unionId: 'on_1', name: '张三' });

    const r = buildTeamRoster(dataDir);
    expect(r.team.memberCount).toBe(1);
    const a = r.bots.find(b => b.larkAppId === 'cli_a')!;
    expect(a).toEqual({ larkAppId: 'cli_a', name: '后端Bot', cliId: 'codex', capability: '服务端排查', hasTeamRole: true, owner: null });
    const b = r.bots.find(b => b.larkAppId === 'cli_b')!;
    expect(b).toEqual({ larkAppId: 'cli_b', name: 'claude-code', cliId: 'claude-code', capability: null, hasTeamRole: false, owner: null });
  });

  it('attaches owner (for grouping by person)', () => {
    writeBotsInfo([{ larkAppId: 'cli_a', botOpenId: 'ou_a', botName: '后端Bot', cliId: 'codex' }]);
    setBotOwner(dataDir, 'cli_a', { unionId: 'on_1', name: '张三' });
    const a = buildTeamRoster(dataDir).bots.find(b => b.larkAppId === 'cli_a')!;
    expect(a.owner).toEqual({ unionId: 'on_1', name: '张三' });
  });

  it('tolerates corrupt bots-info.json', () => {
    writeFileSync(join(dataDir, 'bots-info.json'), 'not json');
    expect(buildTeamRoster(dataDir).bots).toEqual([]);
  });

  it('liveBots is authoritative — shows running bots even when bots-info.json is empty', () => {
    // bots-info.json empty (e.g. probe lagged / write race) but daemons are running
    writeBotsInfo([]);
    const r = buildTeamRoster(dataDir, DEFAULT_TEAM_ID, undefined, [
      { larkAppId: 'cli_run1', botName: 'Run1' },
      { larkAppId: 'cli_run2', botName: 'Run2', cliId: 'codex' },
    ]);
    expect(r.bots.map(b => b.larkAppId).sort()).toEqual(['cli_run1', 'cli_run2']);
    expect(r.bots.find(b => b.larkAppId === 'cli_run2')!.cliId).toBe('codex');
  });

  it('liveBots=[] is authoritative (empty roster) — does NOT fall back to stale bots-info.json', () => {
    writeBotsInfo([{ larkAppId: 'cli_stale', botOpenId: null, botName: 'Stale', cliId: 'claude' }]);
    const r = buildTeamRoster(dataDir, DEFAULT_TEAM_ID, undefined, []); // registry empty
    expect(r.bots).toEqual([]); // not the stale bots-info entry
  });

  it('liveBots enriches cliId from bots-info.json by larkAppId', () => {
    writeBotsInfo([{ larkAppId: 'cli_a', botOpenId: null, botName: 'A-info', cliId: 'claude' }]);
    const r = buildTeamRoster(dataDir, DEFAULT_TEAM_ID, undefined, [{ larkAppId: 'cli_a', botName: 'A-live' }]);
    const a = r.bots.find(b => b.larkAppId === 'cli_a')!;
    expect(a.name).toBe('A-live');  // live name preferred
    expect(a.cliId).toBe('claude'); // cliId from bots-info (registry lacks it)
  });

  it('sorts to configOrder (bots.json order); unknown bots kept after in original order', () => {
    // bots-info.json registration order ≠ bots.json config order
    writeBotsInfo([
      { larkAppId: 'cli_c', botOpenId: null, botName: 'C', cliId: 'codex' },
      { larkAppId: 'cli_a', botOpenId: null, botName: 'A', cliId: 'claude' },
      { larkAppId: 'cli_x', botOpenId: null, botName: 'X', cliId: 'gemini' }, // not in config
      { larkAppId: 'cli_b', botOpenId: null, botName: 'B', cliId: 'coco' },
    ]);
    const r = buildTeamRoster(dataDir, DEFAULT_TEAM_ID, ['cli_a', 'cli_b', 'cli_c']);
    // a,b,c by config order; cli_x (unknown) falls to the end
    expect(r.bots.map(b => b.larkAppId)).toEqual(['cli_a', 'cli_b', 'cli_c', 'cli_x']);
    // no configOrder → unchanged bots-info order
    expect(buildTeamRoster(dataDir).bots.map(b => b.larkAppId)).toEqual(['cli_c', 'cli_a', 'cli_x', 'cli_b']);
  });
});
