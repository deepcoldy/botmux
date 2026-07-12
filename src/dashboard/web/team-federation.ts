export interface RosterBot {
  larkAppId: string;
  name: string;
  cliId: string;
  capability: string | null;
  hasTeamRole: boolean;
  deployment: {
    id: string;
    name: string;
    local: boolean;
    stale: boolean;
  };
}

export interface RosterDeployment {
  id: string;
  name: string;
  local: boolean;
  botCount: number;
  stale: boolean;
}

export interface Team {
  kind: 'local' | 'remote';
  key: string;
  teamId: string;
  label: string;
  sub: string;
  ok: boolean;
  error?: string;
  hubUrl?: string;
  deployments: RosterDeployment[];
  bots: RosterBot[];
}

export interface TeamFilters {
  query: string;
  cliId: string;
  hasCapability: boolean;
  hasRole: boolean;
}

export type TeamApiResult<T = any> = DashboardApiResult<T>;

export interface HostedTeamsResponse {
  ok?: boolean;
  deployment?: {
    deploymentId?: string;
    ownerName?: string;
    ownerUnionId?: string;
  };
  suggestedHubUrl?: string;
  teams?: any[];
}

export interface RemoteRosterResponse {
  memberships?: any[];
}

export interface AutoBindCandidate {
  unionId: string;
  name?: string;
}

export interface AutoBindResponse {
  ok?: boolean;
  owner?: { name?: string; unionId?: string };
  needChoice?: boolean;
  candidates?: AutoBindCandidate[];
  error?: string;
}

export { jget, jpost, jput, jsend };

export async function fetchHostedTeams(): Promise<TeamApiResult<HostedTeamsResponse>> {
  return jget<HostedTeamsResponse>('/api/team/hosted');
}

export async function fetchRemoteRoster(): Promise<TeamApiResult<RemoteRosterResponse>> {
  return jget<RemoteRosterResponse>('/api/team/remote-roster');
}

export async function updateLocalBotCapability(larkAppId: string, capability: string): Promise<TeamApiResult> {
  return jput('/api/team/local-bots/' + encodeURIComponent(larkAppId) + '/capability', { capability });
}

export async function fetchLocalBotRole(larkAppId: string): Promise<TeamApiResult<{ role?: string | null }>> {
  return jget<{ role?: string | null }>('/api/team/local-bots/' + encodeURIComponent(larkAppId) + '/role');
}

export async function autoBindIdentity(unionId?: string): Promise<TeamApiResult<AutoBindResponse>> {
  return jpost<AutoBindResponse>('/api/team/identity/auto-bind', unionId ? { unionId } : undefined);
}

export async function removeHostedTeamMember(teamId: string, deploymentId: string): Promise<TeamApiResult> {
  return jsend('DELETE', `/api/team/hosted/${encodeURIComponent(teamId)}/members/${encodeURIComponent(deploymentId)}`);
}

export async function createFederatedGroup(teamId: string, name: string, larkAppIds: string[]): Promise<TeamApiResult> {
  return jpost('/api/team/federated-group', { name, larkAppIds, teamId });
}

export async function createRemoteGroup(hubUrl: string | undefined, teamId: string, name: string, larkAppIds: string[]): Promise<TeamApiResult> {
  return jpost('/api/team/remote-group', { hubUrl, teamId, name, larkAppIds });
}

export async function createHostedTeam(name: string): Promise<TeamApiResult> {
  return jpost('/api/team/hosted', { name });
}

export async function deleteHostedTeam(teamId: string): Promise<TeamApiResult> {
  return jsend('DELETE', '/api/team/hosted/' + encodeURIComponent(teamId));
}

export async function generateLocalInvite(teamId: string): Promise<TeamApiResult<{ code?: string }>> {
  return jpost<{ code?: string }>('/api/team/local-invite', { teamId });
}

export async function joinRemoteTeam(hubUrl: string, inviteCode: string): Promise<TeamApiResult> {
  return jpost('/api/team/join-remote', { hubUrl, inviteCode });
}

export function allTeams(localTeams: Team[], remoteTeams: Team[]): Team[] {
  return [...localTeams, ...remoteTeams];
}

export function pickedSet(map: Map<string, Set<string>>, key: string): Set<string> {
  let s = map.get(key);
  if (!s) {
    s = new Set();
    map.set(key, s);
  }
  return s;
}

export function botMatchesTeamFilters(bot: RosterBot, filters: TeamFilters): boolean {
  const q = filters.query.trim().toLowerCase();
  if (q && !((bot.name || '') + ' ' + (bot.cliId || '') + ' ' + (bot.capability || '')).toLowerCase().includes(q)) {
    return false;
  }
  if (filters.cliId && bot.cliId !== filters.cliId) return false;
  if (filters.hasCapability && !bot.capability) return false;
  if (filters.hasRole && !bot.hasTeamRole) return false;
  return true;
}

export function teamCliOptions(teams: Team[]): string[] {
  return Array.from(new Set(teams.flatMap(team => team.bots.map(bot => bot.cliId)).filter(Boolean))).sort();
}

export function mapHostedTeams(body: HostedTeamsResponse, tr: (key: string, params?: Record<string, string | number>) => string): Team[] {
  return (body.teams || []).map((team: any) => ({
    kind: 'local' as const,
    key: `local:${team.teamId}`,
    teamId: team.teamId,
    label: team.isDefault ? tr('team.myHostedTeam') : team.name,
    sub: '',
    ok: true,
    deployments: team.deployments || [],
    bots: team.bots || [],
  }));
}

export function mapRemoteTeams(body: RemoteRosterResponse, tr: (key: string, params?: Record<string, string | number>) => string): Team[] {
  const list = body.memberships || [];
  return list.map((membership: any) => {
    const deployments: RosterDeployment[] = membership.roster?.deployments || [];
    const hub = deployments.find(dep => dep.local);
    const label = hub?.name ? tr('team.remoteTeamLabel', { name: hub.name }) : (membership.teamName || membership.teamId);
    return {
      kind: 'remote' as const,
      key: `${membership.hubUrl}::${membership.teamId}`,
      teamId: membership.teamId,
      label,
      sub: membership.hubUrl,
      ok: !!membership.ok,
      error: membership.error,
      hubUrl: membership.hubUrl,
      deployments,
      bots: membership.roster?.bots || [],
    };
  });
}

export function updateTeamBotCapability(teams: Team[], larkAppId: string, capability: string): Team[] {
  return teams.map(team => ({
    ...team,
    bots: team.bots.map(bot => bot.larkAppId === larkAppId
      ? { ...bot, capability: capability.trim() || null }
      : bot),
  }));
}
import { jget, jpost, jput, jsend, type DashboardApiResult } from './dashboard-api.js';
