/**
 * Team store: trust-boundary membership, keyed canonically by union_id but
 * matchable on any identifier.
 * Run: pnpm vitest run test/team-store.test.ts
 */
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach } from 'vitest';
import {
  DEFAULT_TEAM_ID, listTeams, getTeam, getDefaultTeam, ensureDefaultTeam,
  createTeam, addMember, removeMember, isMember, deleteTeam, listTeamsForMember,
} from '../src/services/team-store.js';

let dataDir: string;
beforeEach(() => { dataDir = mkdtempSync(join(tmpdir(), 'botmux-team-')); });

describe('team-store', () => {
  it('starts empty; getDefaultTeam synthesizes without persisting', () => {
    expect(listTeams(dataDir)).toEqual([]);
    const def = getDefaultTeam(dataDir);
    expect(def.id).toBe(DEFAULT_TEAM_ID);
    expect(def.members).toEqual([]);
    expect(existsSync(join(dataDir, 'teams.json'))).toBe(false); // read-only, not written
  });

  it('ensureDefaultTeam materializes and persists the default team', () => {
    const def = ensureDefaultTeam(dataDir);
    expect(def.id).toBe(DEFAULT_TEAM_ID);
    expect(existsSync(join(dataDir, 'teams.json'))).toBe(true);
    expect(listTeams(dataDir)).toHaveLength(1);
    // idempotent
    ensureDefaultTeam(dataDir);
    expect(listTeams(dataDir)).toHaveLength(1);
  });

  it('adds a member and matches membership by union_id', () => {
    ensureDefaultTeam(dataDir);
    addMember(dataDir, DEFAULT_TEAM_ID, { unionId: 'on_u1', name: '张三', addedBy: 'ou_admin' });
    expect(isMember(dataDir, DEFAULT_TEAM_ID, { unionId: 'on_u1' })).toBe(true);
    expect(isMember(dataDir, DEFAULT_TEAM_ID, { unionId: 'on_other' })).toBe(false);
  });

  it('matches membership on any identifier (open_id / email), and merges new fields', () => {
    ensureDefaultTeam(dataDir);
    addMember(dataDir, DEFAULT_TEAM_ID, { openId: 'ou_1', name: '李四' });
    // later we learn the union_id for the same person (matched by open_id)
    addMember(dataDir, DEFAULT_TEAM_ID, { openId: 'ou_1', unionId: 'on_u2', email: 'lisi@x.com' });
    const team = getTeam(dataDir, DEFAULT_TEAM_ID)!;
    expect(team.members).toHaveLength(1); // merged, not duplicated
    expect(team.members[0]).toMatchObject({ openId: 'ou_1', unionId: 'on_u2', email: 'lisi@x.com', name: '李四' });
    expect(isMember(dataDir, DEFAULT_TEAM_ID, { email: 'lisi@x.com' })).toBe(true);
  });

  it('empty identity never matches', () => {
    ensureDefaultTeam(dataDir);
    addMember(dataDir, DEFAULT_TEAM_ID, { unionId: 'on_u1' });
    expect(isMember(dataDir, DEFAULT_TEAM_ID, {})).toBe(false);
  });

  it('removeMember removes by any identifier', () => {
    ensureDefaultTeam(dataDir);
    addMember(dataDir, DEFAULT_TEAM_ID, { unionId: 'on_u1', openId: 'ou_1' });
    expect(removeMember(dataDir, DEFAULT_TEAM_ID, { openId: 'ou_1' })).toBe(true);
    expect(isMember(dataDir, DEFAULT_TEAM_ID, { unionId: 'on_u1' })).toBe(false);
    expect(removeMember(dataDir, DEFAULT_TEAM_ID, { openId: 'ou_1' })).toBe(false); // already gone
  });

  it('supports multiple explicit teams, isolated membership', () => {
    const a = createTeam(dataDir, 'A 团队');
    const b = createTeam(dataDir, 'B 团队');
    addMember(dataDir, a.id, { unionId: 'on_a' });
    addMember(dataDir, b.id, { unionId: 'on_b' });
    expect(isMember(dataDir, a.id, { unionId: 'on_a' })).toBe(true);
    expect(isMember(dataDir, a.id, { unionId: 'on_b' })).toBe(false);
    expect(listTeams(dataDir).map(t => t.name).sort()).toEqual(['A 团队', 'B 团队']);
  });

  it('addMember/isMember on a missing team are safe', () => {
    expect(addMember(dataDir, 'nope', { unionId: 'x' })).toBeNull();
    expect(isMember(dataDir, 'nope', { unionId: 'x' })).toBe(false);
  });

  it('deleteTeam removes the team; missing team returns false', () => {
    const a = createTeam(dataDir, 'A 团队');
    const b = createTeam(dataDir, 'B 团队');
    addMember(dataDir, a.id, { unionId: 'on_a' });
    expect(deleteTeam(dataDir, a.id)).toBe(true);
    expect(getTeam(dataDir, a.id)).toBeNull();
    expect(listTeams(dataDir).map(t => t.id)).toEqual([b.id]);
    expect(deleteTeam(dataDir, 'nope')).toBe(false);
  });

  it('listTeamsForMember returns only teams the identity belongs to', () => {
    const a = createTeam(dataDir, 'A');
    const b = createTeam(dataDir, 'B');
    createTeam(dataDir, 'C');
    addMember(dataDir, a.id, { unionId: 'on_1' });
    addMember(dataDir, b.id, { unionId: 'on_1' });
    addMember(dataDir, b.id, { unionId: 'on_2' });
    expect(listTeamsForMember(dataDir, { unionId: 'on_1' }).map(t => t.id).sort()).toEqual([a.id, b.id].sort());
    expect(listTeamsForMember(dataDir, { unionId: 'on_2' }).map(t => t.id)).toEqual([b.id]);
    expect(listTeamsForMember(dataDir, {})).toEqual([]);
  });
});
