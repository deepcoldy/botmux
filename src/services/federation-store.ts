/**
 * Federation store (HUB side): which remote deployments have joined each team,
 * and the bots they last advertised. The hub aggregates these with its own local
 * roster so every member sees a shared cross-deployment roster.
 *
 * A deployment registers once via an invite (→ teamId) and is issued a long-lived
 * `syncToken` (high-entropy, never logged) used for subsequent sync/roster pulls.
 *
 * Storage: `{dataDir}/federations.json`, atomic writes. Single dashboard writer
 * (same assumption as invite-store): register/sync are read-modify-write.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';

export interface FederatedBot {
  larkAppId: string;
  botName: string;
  cliId: string;
  /** Tenant-stable bot id (used by P2 拉群 to add the bot cross-app). */
  botUnionId?: string;
  capability?: string | null;
  hasTeamRole?: boolean;
  /** Owner (the person) of this bot, tenant-stable union_id — so 拉群 can pull
   *  the owner into the group by union_id (open_id is app-scoped, union_id not). */
  ownerUnionId?: string;
  ownerName?: string;
  botmuxVersion?: string;
  a2aCapabilities?: string[];
}

export interface FederatedDeployment {
  deploymentId: string;
  name: string;
  syncToken: string;
  bots: FederatedBot[];
  joinedAt: number;
  lastSeenAt: number;
  /** The spoke deployment's OWNER (the person), tenant-stable union_id. Hub uses
   *  this — derived from syncToken — as the trusted operator identity when this
   *  spoke initiates 拉群 (so the operator is pulled into the group). */
  ownerUnionId?: string;
  ownerName?: string;
  /** Spoke's dashboard base URL — so this hub can call back to delegate 拉群
   *  (hub→spoke) when no local online bot can be the group creator. */
  callbackUrl?: string;
  /** Token the SPOKE issued to THIS hub at join; the hub presents it on
   *  delegate calls so the spoke can verify the request is from its hub. */
  delegationToken?: string;
}

interface FileShape {
  version: 1;
  /** teamId → member deployments */
  teams: Record<string, FederatedDeployment[]>;
}

function filePath(dataDir: string): string {
  return join(dataDir, 'federations.json');
}

function readFile(dataDir: string): FileShape {
  const fp = filePath(dataDir);
  if (!existsSync(fp)) return { version: 1, teams: {} };
  try {
    const parsed = JSON.parse(readFileSync(fp, 'utf-8'));
    if (parsed && typeof parsed.teams === 'object' && parsed.teams) return { version: 1, teams: parsed.teams };
  } catch { /* corrupt — fall through */ }
  return { version: 1, teams: {} };
}

function writeFileAtomic(dataDir: string, data: FileShape): void {
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
  const fp = filePath(dataDir);
  const tmp = `${fp}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf-8');
  renameSync(tmp, fp);
}

export interface RegisterInput {
  deploymentId: string;
  name: string;
  bots: FederatedBot[];
  ownerUnionId?: string;
  ownerName?: string;
  callbackUrl?: string;
  delegationToken?: string;
}

/**
 * Register a NEW remote deployment under a team and issue a fresh syncToken.
 *
 * NOT idempotent on purpose: `deploymentId` is public (it appears in the roster),
 * so re-registering an existing id must NOT hand back its long-lived syncToken —
 * otherwise anyone with an invite could claim another deployment's token by
 * guessing its id. A duplicate returns `{ created: false }` with NO token; the
 * caller surfaces `deployment_already_joined`. Ongoing bot refresh is via
 * `syncDeployment` (syncToken), not this. Re-binding/rotation is a future
 * explicit reset proving the old syncToken.
 */
export function registerDeployment(dataDir: string, teamId: string, input: RegisterInput, now: number = Date.now()): { syncToken: string; created: boolean } {
  const data = readFile(dataDir);
  const list = data.teams[teamId] ?? (data.teams[teamId] = []);
  if (list.some(d => d.deploymentId === input.deploymentId)) return { syncToken: '', created: false };
  const syncToken = randomBytes(24).toString('base64url');
  list.push({ deploymentId: input.deploymentId, name: input.name, syncToken, bots: input.bots, joinedAt: now, lastSeenAt: now, ownerUnionId: input.ownerUnionId, ownerName: input.ownerName, callbackUrl: input.callbackUrl, delegationToken: input.delegationToken });
  writeFileAtomic(dataDir, data);
  return { syncToken, created: true };
}

/** Resolve a syncToken to its {teamId, deployment}, or null. */
export function getDeploymentByToken(dataDir: string, syncToken: string): { teamId: string; deployment: FederatedDeployment } | null {
  if (!syncToken) return null;
  const data = readFile(dataDir);
  for (const [teamId, list] of Object.entries(data.teams)) {
    const deployment = list.find(d => d.syncToken === syncToken);
    if (deployment) return { teamId, deployment };
  }
  return null;
}

/** Refresh a deployment's advertised bots + heartbeat, by syncToken. Returns true if found. */
export function syncDeployment(dataDir: string, syncToken: string, bots: FederatedBot[], owner?: { ownerUnionId?: string; ownerName?: string; name?: string }, now: number = Date.now()): boolean {
  const data = readFile(dataDir);
  for (const list of Object.values(data.teams)) {
    const deployment = list.find(d => d.syncToken === syncToken);
    if (deployment) {
      deployment.bots = bots;
      deployment.lastSeenAt = now;
      // Owner + name can change after join (e.g. binding adopts the owner's
      // Feishu name) — keep them fresh on sync, only overwriting when sent.
      if (owner?.ownerUnionId !== undefined) deployment.ownerUnionId = owner.ownerUnionId;
      if (owner?.ownerName !== undefined) deployment.ownerName = owner.ownerName;
      if (owner?.name) deployment.name = owner.name; // non-empty only → roster grouping follows the owner's Feishu name
      writeFileAtomic(dataDir, data);
      return true;
    }
  }
  return false;
}

/** Member deployments of a team (empty if none). */
export function listFederatedDeployments(dataDir: string, teamId: string): FederatedDeployment[] {
  return readFile(dataDir).teams[teamId] ?? [];
}

/** Remove a deployment from a team (leave/kick). Returns true if removed. */
export function removeDeployment(dataDir: string, teamId: string, deploymentId: string): boolean {
  const data = readFile(dataDir);
  const list = data.teams[teamId];
  if (!list) return false;
  const before = list.length;
  data.teams[teamId] = list.filter(d => d.deploymentId !== deploymentId);
  if (data.teams[teamId].length === before) return false;
  writeFileAtomic(dataDir, data);
  return true;
}

/** Remove the deployment owning a syncToken (spoke-initiated leave/revoke). Returns true if removed. */
export function removeDeploymentByToken(dataDir: string, syncToken: string): boolean {
  if (!syncToken) return false;
  const data = readFile(dataDir);
  for (const list of Object.values(data.teams)) {
    const idx = list.findIndex(d => d.syncToken === syncToken);
    if (idx >= 0) { list.splice(idx, 1); writeFileAtomic(dataDir, data); return true; }
  }
  return false;
}

/** Drop all federation records for a team (e.g. when the team is deleted). */
export function removeTeamFederation(dataDir: string, teamId: string): void {
  const data = readFile(dataDir);
  if (data.teams[teamId]) {
    delete data.teams[teamId];
    writeFileAtomic(dataDir, data);
  }
}
