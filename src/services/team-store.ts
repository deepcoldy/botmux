/**
 * Team store: the trust boundary for multi-bot collaboration.
 *
 * A "team" is a set of people (members) who trust each other; within a team,
 * bots collaborate freely (discover, team up, hand off) without per-action
 * authorization. Team membership is what the platform login (pairing flow) and
 * the team Web UI gate on.
 *
 * Identity: members are keyed canonically by **union_id** (stable across apps
 * under the same Feishu developer/tenant — see docs/platform-design.md). We also
 * keep open_id / email / name when known so membership checks can match on any
 * identifier the caller has on hand.
 *
 * Deployment model: "one deployment = one implicit team" is the simplest case,
 * so a single default team is auto-materialized on first write. Explicit
 * multi-team support is the same shape, just more than one entry.
 *
 * Storage: `{dataDir}/teams.json`, atomic writes (unique tmp + rename).
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export const DEFAULT_TEAM_ID = 'default';

export interface TeamMember {
  unionId?: string;
  openId?: string;
  email?: string;
  name?: string;
  addedAt: number;
  addedBy?: string;
}

export interface Team {
  id: string;
  name: string;
  members: TeamMember[];
  createdAt: number;
  updatedAt: number;
}

interface FileShape {
  version: 1;
  teams: Team[];
}

/** Identifiers a membership check can match on. Match succeeds on ANY non-empty hit. */
export interface MemberIdentity {
  unionId?: string;
  openId?: string;
  email?: string;
}

function filePath(dataDir: string): string {
  return join(dataDir, 'teams.json');
}

function readFile(dataDir: string): FileShape {
  const fp = filePath(dataDir);
  if (!existsSync(fp)) return { version: 1, teams: [] };
  try {
    const parsed = JSON.parse(readFileSync(fp, 'utf-8'));
    if (parsed && Array.isArray(parsed.teams)) return { version: 1, teams: parsed.teams };
  } catch { /* corrupt — fall through */ }
  return { version: 1, teams: [] };
}

function writeFileAtomic(dataDir: string, data: FileShape): void {
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
  const fp = filePath(dataDir);
  const tmp = `${fp}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf-8');
  renameSync(tmp, fp);
}

/** All teams (empty array if none materialized yet). */
export function listTeams(dataDir: string): Team[] {
  return readFile(dataDir).teams;
}

/** A team by id, or null. */
export function getTeam(dataDir: string, teamId: string): Team | null {
  return readFile(dataDir).teams.find(t => t.id === teamId) ?? null;
}

/** All teams the given identity belongs to (matches any identifier). */
export function listTeamsForMember(dataDir: string, id: MemberIdentity): Team[] {
  if (!id.unionId && !id.openId && !id.email) return [];
  return readFile(dataDir).teams.filter(t => t.members.some(m => sameMember(m, id)));
}

/**
 * The default (implicit single-deployment) team. Read-only: returns the first
 * persisted team, else a synthesized empty default that is NOT written. Use
 * `ensureDefaultTeam` when you intend to persist.
 */
export function getDefaultTeam(dataDir: string): Team {
  const teams = readFile(dataDir).teams;
  const existing = teams.find(t => t.id === DEFAULT_TEAM_ID) ?? teams[0];
  if (existing) return existing;
  const now = Date.now();
  return { id: DEFAULT_TEAM_ID, name: '默认团队', members: [], createdAt: now, updatedAt: now };
}

/** Materialize (persist) the default team if no team exists yet; returns it. */
export function ensureDefaultTeam(dataDir: string, now: number = Date.now()): Team {
  const data = readFile(dataDir);
  if (data.teams.length > 0) return data.teams.find(t => t.id === DEFAULT_TEAM_ID) ?? data.teams[0];
  const team: Team = { id: DEFAULT_TEAM_ID, name: '默认团队', members: [], createdAt: now, updatedAt: now };
  data.teams.push(team);
  writeFileAtomic(dataDir, data);
  return team;
}

/** Delete a team entirely (members + the team entry). Returns true if removed.
 *  Bots/connectors live at the deployment level (not per-team), so they are
 *  unaffected — only the membership/trust boundary is dropped. */
export function deleteTeam(dataDir: string, teamId: string): boolean {
  const data = readFile(dataDir);
  const before = data.teams.length;
  data.teams = data.teams.filter(t => t.id !== teamId);
  if (data.teams.length === before) return false;
  writeFileAtomic(dataDir, data);
  return true;
}

/** Create a new explicit team. */
export function createTeam(dataDir: string, name: string, now: number = Date.now()): Team {
  const data = readFile(dataDir);
  const team: Team = { id: `team_${randomUUID().slice(0, 8)}`, name: name.trim() || '未命名团队', members: [], createdAt: now, updatedAt: now };
  data.teams.push(team);
  writeFileAtomic(dataDir, data);
  return team;
}

function sameMember(m: TeamMember, id: MemberIdentity): boolean {
  return (!!id.unionId && m.unionId === id.unionId)
    || (!!id.openId && m.openId === id.openId)
    || (!!id.email && m.email === id.email);
}

/**
 * Add (or merge) a member into a team. Dedupes by any matching identifier and
 * fills in newly-known fields. Returns the updated team, or null if no such team.
 */
export function addMember(dataDir: string, teamId: string, member: Omit<TeamMember, 'addedAt'> & { addedAt?: number }, now: number = Date.now()): Team | null {
  const data = readFile(dataDir);
  const team = data.teams.find(t => t.id === teamId);
  if (!team) return null;
  const existing = team.members.find(m => sameMember(m, member));
  if (existing) {
    existing.unionId ??= member.unionId;
    existing.openId ??= member.openId;
    existing.email ??= member.email;
    if (member.name) existing.name = member.name;
  } else {
    team.members.push({ ...member, addedAt: member.addedAt ?? now });
  }
  team.updatedAt = now;
  writeFileAtomic(dataDir, data);
  return team;
}

/** Remove a member matching any identifier. Returns true if removed. */
export function removeMember(dataDir: string, teamId: string, id: MemberIdentity, now: number = Date.now()): boolean {
  const data = readFile(dataDir);
  const team = data.teams.find(t => t.id === teamId);
  if (!team) return false;
  const before = team.members.length;
  team.members = team.members.filter(m => !sameMember(m, id));
  if (team.members.length === before) return false;
  team.updatedAt = now;
  writeFileAtomic(dataDir, data);
  return true;
}

/** Whether the given identity is a member of the team (matches any identifier). */
export function isMember(dataDir: string, teamId: string, id: MemberIdentity): boolean {
  if (!id.unionId && !id.openId && !id.email) return false;
  const team = getTeam(dataDir, teamId);
  if (!team) return false;
  return team.members.some(m => sameMember(m, id));
}
