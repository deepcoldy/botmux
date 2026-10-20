/**
 * Deployment identity: a stable id + human-readable name for THIS botmux
 * deployment (one install = one owner). Used by federation so a hub can tell
 * member deployments apart and group their bots in the shared roster.
 *
 * Generated once and persisted to `{dataDir}/deployment-identity.json`; the name
 * defaults to the machine hostname and can be renamed by the owner.
 */
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { readJsonFileSoft } from '../utils/json-file.js';

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
  atomicWriteFileSync(filePath(dataDir), JSON.stringify(id, null, 2) + '\n', { followTargetSymlink: false });
}

/** Load (creating + persisting on first call) this deployment's identity. */
export function getDeploymentIdentity(dataDir: string): DeploymentIdentity {
  // 损坏 / 缺 deploymentId 的文件被隔离为 .corrupt-*（而不是被新生成的身份覆盖，
  // 连同 deploymentId 与已绑定的 owner 一并丢失），见 utils/json-file.ts。
  const p = readJsonFileSoft<Record<string, any> | null>(filePath(dataDir), {
    fallback: () => null,
    validate: (v): v is Record<string, any> =>
      !!v && typeof (v as Record<string, unknown>).deploymentId === 'string' && !!(v as Record<string, unknown>).deploymentId,
    label: 'deployment-identity',
  });
  if (p) {
    return {
      deploymentId: p.deploymentId,
      name: typeof p.name === 'string' && p.name ? p.name : 'botmux',
      ownerUnionId: typeof p.ownerUnionId === 'string' ? p.ownerUnionId : undefined,
      ownerName: typeof p.ownerName === 'string' ? p.ownerName : undefined,
    };
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
 *  naturally ("示例用户 的部署" instead of a hostname). Returns the updated identity. */
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
