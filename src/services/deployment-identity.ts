/**
 * Deployment identity: a stable id + human-readable name for THIS botmux
 * deployment (one install = one owner). Used by federation so a hub can tell
 * member deployments apart and group their bots in the shared roster.
 *
 * Generated once and persisted to `{dataDir}/deployment-identity.json`; the name
 * defaults to the machine hostname and can be renamed by the owner.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';

export interface DeploymentIdentity {
  deploymentId: string;
  name: string;
  /** The owner's tenant-stable Feishu identity, bound once via /pair. Used as
   *  the "operator" when this deployment initiates 拉群 (so the operator is
   *  pulled into the group). Absent until bound. */
  ownerUnionId?: string;
  ownerName?: string;
}

function filePath(dataDir: string): string {
  return join(dataDir, 'deployment-identity.json');
}

function write(dataDir: string, id: DeploymentIdentity): void {
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
  const fp = filePath(dataDir);
  const tmp = `${fp}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(tmp, JSON.stringify(id, null, 2) + '\n', 'utf-8');
  renameSync(tmp, fp);
}

/** Load (creating + persisting on first call) this deployment's identity. */
export function getDeploymentIdentity(dataDir: string): DeploymentIdentity {
  const fp = filePath(dataDir);
  if (existsSync(fp)) {
    try {
      const p = JSON.parse(readFileSync(fp, 'utf-8'));
      if (p && typeof p.deploymentId === 'string' && p.deploymentId) {
        return {
          deploymentId: p.deploymentId,
          name: typeof p.name === 'string' && p.name ? p.name : 'botmux',
          ownerUnionId: typeof p.ownerUnionId === 'string' ? p.ownerUnionId : undefined,
          ownerName: typeof p.ownerName === 'string' ? p.ownerName : undefined,
        };
      }
    } catch { /* corrupt — regenerate */ }
  }
  const id: DeploymentIdentity = { deploymentId: `dep_${randomUUID().slice(0, 12)}`, name: hostname() || 'botmux' };
  write(dataDir, id);
  return id;
}

/** Rename this deployment (owner-facing label). Returns the updated identity. */
export function setDeploymentName(dataDir: string, name: string): DeploymentIdentity {
  const cur = getDeploymentIdentity(dataDir);
  const next: DeploymentIdentity = { ...cur, name: name.trim() || cur.name };
  write(dataDir, next);
  return next;
}

/** Bind the owner's Feishu identity (via /pair or auto-bind). Also adopts the
 *  owner's Feishu name as the DEPLOYMENT name — the deployment is shown to the
 *  team by its owner's real name (no custom labels), so the roster reads
 *  naturally ("申晗 的部署" instead of a hostname). Returns the updated identity. */
export function setDeploymentOwner(dataDir: string, owner: { unionId?: string; name?: string }): DeploymentIdentity {
  const cur = getDeploymentIdentity(dataDir);
  const next: DeploymentIdentity = {
    ...cur,
    ownerUnionId: owner.unionId || cur.ownerUnionId,
    ownerName: owner.name || cur.ownerName,
    name: owner.name || cur.name, // default the deployment label to the owner's Feishu name
  };
  write(dataDir, next);
  return next;
}
