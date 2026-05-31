/**
 * Aggregated cross-deployment roster (HUB side): the hub's own local bots
 * ([[team-roster]]) merged with every member deployment's advertised bots
 * ([[federation-store]]), each tagged with the deployment it belongs to so the
 * UI can group by deployment (local first, then remote by name).
 *
 * Pure read from `{dataDir}` files — testable, no Lark API.
 */
import { buildTeamRoster, type LiveBot } from './team-roster.js';
import { listFederatedDeployments } from './federation-store.js';
import { getDeploymentIdentity } from './deployment-identity.js';
import { getTeam, getDefaultTeam, DEFAULT_TEAM_ID } from './team-store.js';

/** A federated deployment is considered stale (likely offline) if it hasn't
 *  synced within this window — its bots are flagged so the UI can de-emphasize them. */
export const FEDERATION_STALE_MS = 5 * 60 * 1000;

export interface AggregatedRosterBot {
  larkAppId: string;
  name: string;
  cliId: string;
  capability: string | null;
  hasTeamRole: boolean;
  /** Tenant-stable bot id (kept now so P2 拉群 by union_id needs no schema change). */
  botUnionId?: string;
  /** Owner (person) of this bot — union_id is tenant-stable, used to pull the
   *  owner into a federated group regardless of app scope. */
  owner?: { unionId?: string; name?: string };
  deployment: { id: string; name: string; local: boolean; stale: boolean };
}

export interface AggregatedDeployment {
  id: string;
  name: string;
  local: boolean;
  botCount: number;
  lastSeenAt?: number;
  /** true when a remote deployment hasn't synced within FEDERATION_STALE_MS. */
  stale: boolean;
}

export interface AggregatedRoster {
  team: { id: string; name: string; memberCount: number };
  deployments: AggregatedDeployment[];
  bots: AggregatedRosterBot[];
}

/** Hub's local bots + all member deployments' bots, tagged + grouped by deployment. */
export function buildFederatedRoster(dataDir: string, teamId: string = DEFAULT_TEAM_ID, configOrder?: string[], now: number = Date.now(), liveBots?: LiveBot[]): AggregatedRoster {
  const team = getTeam(dataDir, teamId) ?? getDefaultTeam(dataDir);
  const localId = getDeploymentIdentity(dataDir);
  const local = buildTeamRoster(dataDir, teamId, configOrder, liveBots);

  const deployments: AggregatedDeployment[] = [
    { id: localId.deploymentId, name: localId.name, local: true, botCount: local.bots.length, stale: false },
  ];
  const bots: AggregatedRosterBot[] = local.bots.map(b => ({
    larkAppId: b.larkAppId,
    name: b.name,
    cliId: b.cliId,
    capability: b.capability,
    hasTeamRole: b.hasTeamRole,
    owner: b.owner ? { unionId: b.owner.unionId, name: b.owner.name } : undefined,
    deployment: { id: localId.deploymentId, name: localId.name, local: true, stale: false },
  }));

  for (const dep of listFederatedDeployments(dataDir, teamId)) {
    const stale = now - dep.lastSeenAt > FEDERATION_STALE_MS;
    deployments.push({ id: dep.deploymentId, name: dep.name, local: false, botCount: dep.bots.length, lastSeenAt: dep.lastSeenAt, stale });
    for (const b of dep.bots) {
      bots.push({
        larkAppId: b.larkAppId,
        name: b.botName,
        cliId: b.cliId,
        capability: b.capability ?? null,
        hasTeamRole: !!b.hasTeamRole,
        botUnionId: b.botUnionId,
        owner: (b.ownerUnionId || b.ownerName) ? { unionId: b.ownerUnionId, name: b.ownerName } : undefined,
        deployment: { id: dep.deploymentId, name: dep.name, local: false, stale },
      });
    }
  }

  return { team: { id: team.id, name: team.name, memberCount: team.members.length }, deployments, bots };
}
