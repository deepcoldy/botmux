import { wecomEffectiveMessageQuota, type WecomNativeCoreConfig } from '../config/native-core-config.js';
import { createHash, randomUUID } from 'node:crypto';
import type { WecomInboundMessage } from '../protocol/types.js';

export interface NativeGrant {
  userId: string;
  scope: string;
  rights: 'talk' | 'operate';
  expiresAt: number;
  limit: number;
  used: number;
  revision: number;
  revoked?: boolean;
  /**
   * Written by earlier versions only: a grant a trusted peer delegated (`peer`,
   * `peerParents`) or one a delegated operator granted (`parent`). Neither
   * delegation exists any more, so such a grant is no longer live.
   */
  peer?: unknown;
  peerParents?: unknown;
  parent?: unknown;
}

export interface NativeGrantRequest {
  id: string;
  userId: string;
  scope: string;
  status: 'pending' | 'approved' | 'rejected';
  expiresAt: number;
  revision: string;
  notification?: 'intent' | 'sent' | 'uncertain';
}

export interface NativeCoreState {
  grants: Record<string, NativeGrant>;
  requests: Record<string, NativeGrantRequest>;
  receipts: Record<string, {
    grant: string;
    revision: number;
  }>;
  privateUsers: Record<string, true>;
  /** Written by earlier versions only (never read); no longer written, and a
   *  prune drops both (gateway/bridge/prune.ts). */
  conversationTypes?: Record<string, 'single' | 'group'>;
  knownUsers?: Record<string, true>;
  selectedRepos: Record<string, {
    name: string;
    directory: string;
    revision: string;
  }>;
  actions: Record<string, 'pending' | 'completed' | 'uncertain'>;
  peerReceipts?: Record<string, {
    hash: string;
    sourceId: string;
    sourceUser: string;
    sessionId?: string;
    triggerId?: string;
    status: 'pending' | 'accepted' | 'uncertain';
    request?: unknown;
  }>;
  epoch: number;
}

export const emptyNativeCoreState = (): NativeCoreState => ({
  grants: {},
  requests: {},
  receipts: {},
  privateUsers: {},
  selectedRepos: {},
  actions: {},
  epoch: 0,
});

export interface NativeAdmissionPolicy extends WecomNativeCoreConfig {
  allowedUsers: string[];
  blockedUsers?: string[];
}

export const nativePolicyRevision = (p: NativeAdmissionPolicy) => createHash('sha256')
  .update(JSON.stringify([
    p.allowedUsers,
    p.blockedUsers,
    // The slot of the retired `approverUsers` list, always empty now (its users
    // are allowed users). A configuration that never had one keeps its digest.
    undefined,
    p.grantDefaultDurationMs,
    p.messageQuotaDefaultLimit,
    // The slot of the retired `repositories` allow-list, always empty now. A
    // configuration that never had one keeps the digest it always had, so the
    // pending grant requests and selected repositories that carry it stay valid
    // across the upgrade.
    undefined,
  ]))
  .digest('hex');

export const nativeScope = (m: Pick<WecomInboundMessage, 'chatType' | 'conversationId'>) =>
  `${m.chatType}:${m.conversationId}`;

export const nativeGrantKey = (userId: string, scope: string) =>
  createHash('sha256').update(JSON.stringify([userId, scope])).digest('hex');

export function nativeCapability(
  state: NativeCoreState,
  policy: NativeAdmissionPolicy,
  message: Pick<WecomInboundMessage, 'userId' | 'chatType' | 'conversationId'>,
  now: number,
  checkQuota = true,
): 'operate' | 'talk' | 'denied' {
  if (policy.blockedUsers?.includes(message.userId)) {
    return 'denied';
  }
  if (policy.allowedUsers.includes(message.userId)) {
    return 'operate';
  }
  const grant = state.grants[nativeGrantKey(message.userId, nativeScope(message))];
  if (grant && nativeGrantLive(grant, now) && (!checkQuota || grant.used < grant.limit)) {
    return grant.rights;
  }
  return message.chatType === 'single' && policy.p2pOpen ? 'talk' : 'denied';
}

/** Allowed users approve requests and grant access; nobody else does. */
export function nativeCanApprove(p: NativeAdmissionPolicy, userId: string): boolean {
  return !p.blockedUsers?.includes(userId) && p.allowedUsers.includes(userId);
}

export function nativeGrant(
  state: NativeCoreState,
  p: NativeAdmissionPolicy,
  actor: string,
  userId: string,
  scope: string,
  rights: 'talk' | 'operate',
  now: number,
) {
  if (!nativeCanApprove(p, actor)) {
    throw new Error('wecom_grant_forbidden');
  }
  const key = nativeGrantKey(userId, scope);
  const old = state.grants[key];
  state.grants[key] = {
    userId,
    scope,
    rights,
    expiresAt: now + (p.grantDefaultDurationMs ?? 3600000),
    limit: wecomEffectiveMessageQuota(p.messageQuotaDefaultLimit),
    used: 0,
    revision: (old?.revision ?? 0) + 1,
  };
  return state.grants[key];
}

export function nativeReserve(
  state: NativeCoreState,
  p: NativeAdmissionPolicy,
  m: WecomInboundMessage,
  key: string,
  now: number,
): boolean {
  if (state.receipts[key]) {
    return nativeTaskAllowed(state, p, m, key, now);
  }
  if (nativeCapability(state, p, m, now) === 'denied') {
    return false;
  }
  const gkey = nativeGrantKey(m.userId, nativeScope(m));
  const grant = state.grants[gkey];
  if (!p.allowedUsers.includes(m.userId)
    && grant
    && nativeGrantLive(grant, now)) {
    if (grant.used >= grant.limit) {
      // Reached only in a private chat open to everyone (nativeCapability says
      // `talk` there). A talk grant whose quota is used up talks like anyone
      // else in it: no quota taken, no receipt. An operate grant does not: its
      // rights are judged by the grant, not its quota, wherever it is checked.
      return grant.rights === 'talk';
    }
    grant.used++;
    state.receipts[key] = { grant: gkey, revision: grant.revision };
  }
  return true;
}

export function nativeTaskAllowed(
  state: NativeCoreState,
  p: NativeAdmissionPolicy,
  m: WecomInboundMessage,
  key: string,
  now: number,
): boolean {
  const receipt = state.receipts[key];
  if (receipt) {
    const grant = state.grants[receipt.grant];
    return !p.blockedUsers?.includes(m.userId)
      && !!grant
      && nativeGrantLive(grant, now)
      && grant.revision === receipt.revision;
  }
  return nativeCapability(state, p, m, now, false) !== 'denied';
}

export function nativeRequestGrant(
  state: NativeCoreState,
  p: NativeAdmissionPolicy,
  m: WecomInboundMessage,
  now: number,
): NativeGrantRequest {
  const scope = nativeScope(m);
  const revision = nativePolicyRevision(p);
  const prior = Object.values(state.requests).find(r => r.userId === m.userId
    && r.scope === scope
    && r.status === 'pending'
    && r.expiresAt > now
    && r.revision === revision);
  if (prior) {
    return prior;
  }
  const request: NativeGrantRequest = {
    id: randomUUID(),
    userId: m.userId,
    scope,
    status: 'pending',
    expiresAt: now + 900000,
    revision,
  };
  state.requests[request.id] = request;
  return request;
}

export function nativeApproveRequest(
  state: NativeCoreState,
  p: NativeAdmissionPolicy,
  id: string,
  actor: string,
  now: number,
): boolean {
  const r = state.requests[id];
  if (!r
    || r.status !== 'pending'
    || r.expiresAt <= now
    || r.revision !== nativePolicyRevision(p)
    || !nativeCanApprove(p, actor)) {
    return false;
  }
  nativeGrant(state, p, actor, r.userId, r.scope, 'talk', now);
  r.status = 'approved';
  return true;
}

function nativeGrantLive(grant: NativeGrant, now: number): boolean {
  // A delegated grant of an earlier version (see NativeGrant) is not live.
  return !grant.revoked
    && grant.expiresAt > now
    && grant.peer === undefined
    && grant.peerParents === undefined
    && grant.parent === undefined;
}
