import { createHash } from 'node:crypto';

export const PRINCIPAL_WORKSPACE_GROUP_KEY_VERSION = 2 as const;
const PRINCIPAL_WORKSPACE_GROUP_DOMAIN = 'botmux.principal-workspace.group';

export type PrincipalWorkspaceGroupPhase = 'active' | 'closing' | 'closed' | 'quarantined';
export type PrincipalWorkspaceMemberPhase = 'active' | 'closing' | 'closed' | 'quarantined';

export interface PrincipalWorkspaceGroup {
  version: 1;
  groupId: string;
  groupKeyVersion: typeof PRINCIPAL_WORKSPACE_GROUP_KEY_VERSION;
  larkAppId: string;
  canonicalCwd: string;
  phase: PrincipalWorkspaceGroupPhase;
  revision: number;
  lastLeaseGeneration: number;
  createdAt: string;
  updatedAt: string;
  quarantineReason?: string;
}

export interface PrincipalWorkspaceMember {
  version: 1;
  sourceSessionId: string;
  laneId: string;
  sessionId: string;
  groupId: string;
  workspaceEpoch: number;
  membershipPhase: PrincipalWorkspaceMemberPhase;
  revision: number;
  createdAt: string;
  updatedAt: string;
  quarantineReason?: string;
}

function lengthPrefixed(value: string): Buffer {
  const bytes = Buffer.from(value, 'utf8');
  const length = Buffer.allocUnsafe(4);
  length.writeUInt32BE(bytes.length, 0);
  return Buffer.concat([length, bytes]);
}

/** Exact compatibility function for the already-persisted v1 source-local id. */
export function legacyPrincipalWorkspaceGroupId(
  sourceSessionId: string,
  canonicalCwd: string,
  workspaceEpoch: number,
): string {
  return `principal-workspace:${createHash('sha256')
    .update(`${sourceSessionId}\0${canonicalCwd}\0${workspaceEpoch}`)
    .digest('hex').slice(0, 24)}`;
}

/** Shared v2 identity. The app-scoped store is the ownership boundary; paths
 * to the database/data directory are intentionally not part of the hash. */
export function principalWorkspaceGroupIdV2(larkAppId: string, canonicalCwd: string): string {
  const hash = createHash('sha256');
  hash.update(lengthPrefixed(PRINCIPAL_WORKSPACE_GROUP_DOMAIN));
  const version = Buffer.allocUnsafe(4);
  version.writeUInt32BE(PRINCIPAL_WORKSPACE_GROUP_KEY_VERSION, 0);
  hash.update(version);
  for (const [name, value] of [
    ['larkAppId', larkAppId],
    ['canonicalCwd', canonicalCwd],
  ] as const) {
    hash.update(lengthPrefixed(name));
    hash.update(lengthPrefixed(value));
  }
  return `principal-workspace:v2:${hash.digest('hex')}`;
}

export function validPrincipalWorkspaceGroupIdentity(args: {
  sourceSessionId: string;
  larkAppId: string;
  canonicalCwd: string;
  workspaceEpoch: number;
  workspaceGroupId: string;
  workspaceGroupKeyVersion?: unknown;
  workspaceGroupKeyVersionPresent: boolean;
}): { ok: true; version: 1 | 2 } | { ok: false; error: string } {
  if (!args.workspaceGroupKeyVersionPresent) {
    return args.workspaceGroupId === legacyPrincipalWorkspaceGroupId(
      args.sourceSessionId, args.canonicalCwd, args.workspaceEpoch,
    ) ? { ok: true, version: 1 } : { ok: false, error: 'legacy_workspace_group_id_mismatch' };
  }
  if (args.workspaceGroupKeyVersion !== PRINCIPAL_WORKSPACE_GROUP_KEY_VERSION) {
    return { ok: false, error: 'invalid_workspace_group_key_version' };
  }
  return args.workspaceGroupId === principalWorkspaceGroupIdV2(args.larkAppId, args.canonicalCwd)
    ? { ok: true, version: 2 }
    : { ok: false, error: 'workspace_group_id_mismatch' };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function nonempty(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 4096;
}

function timestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

export function parsePrincipalWorkspaceGroup(value: unknown):
  | { ok: true; value: PrincipalWorkspaceGroup }
  | { ok: false; error: string } {
  const candidate = record(value);
  if (!candidate || candidate.version !== 1) return { ok: false, error: 'invalid_group_version' };
  if (!nonempty(candidate.groupId)
      || candidate.groupKeyVersion !== PRINCIPAL_WORKSPACE_GROUP_KEY_VERSION
      || !nonempty(candidate.larkAppId)
      || !nonempty(candidate.canonicalCwd)
      || candidate.groupId !== principalWorkspaceGroupIdV2(candidate.larkAppId, candidate.canonicalCwd)) {
    return { ok: false, error: 'invalid_group_identity' };
  }
  if (!['active', 'closing', 'closed', 'quarantined'].includes(String(candidate.phase))) {
    return { ok: false, error: 'invalid_group_phase' };
  }
  if (!Number.isSafeInteger(candidate.revision) || Number(candidate.revision) < 1
      || !Number.isSafeInteger(candidate.lastLeaseGeneration)
      || Number(candidate.lastLeaseGeneration) < 0
      || !timestamp(candidate.createdAt) || !timestamp(candidate.updatedAt)
      || (candidate.quarantineReason !== undefined && typeof candidate.quarantineReason !== 'string')) {
    return { ok: false, error: 'invalid_group_metadata' };
  }
  return { ok: true, value: candidate as unknown as PrincipalWorkspaceGroup };
}

export function parsePrincipalWorkspaceMember(value: unknown):
  | { ok: true; value: PrincipalWorkspaceMember }
  | { ok: false; error: string } {
  const candidate = record(value);
  if (!candidate || candidate.version !== 1
      || !nonempty(candidate.sourceSessionId) || !nonempty(candidate.laneId)
      || !nonempty(candidate.sessionId) || !nonempty(candidate.groupId)) {
    return { ok: false, error: 'invalid_member_identity' };
  }
  if (!Number.isSafeInteger(candidate.workspaceEpoch) || Number(candidate.workspaceEpoch) < 1
      || !['active', 'closing', 'closed', 'quarantined'].includes(String(candidate.membershipPhase))
      || !Number.isSafeInteger(candidate.revision) || Number(candidate.revision) < 1
      || !timestamp(candidate.createdAt) || !timestamp(candidate.updatedAt)
      || (candidate.quarantineReason !== undefined && typeof candidate.quarantineReason !== 'string')) {
    return { ok: false, error: 'invalid_member_metadata' };
  }
  return { ok: true, value: candidate as unknown as PrincipalWorkspaceMember };
}
