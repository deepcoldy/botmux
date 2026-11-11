import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import { readSecureHostFileSync, writeSecureHostFileSync } from '../platform/secure-host-file.js';
import type { TrustedCaller } from '../types.js';

const SCOPED_ID = /^[A-Za-z0-9_-]{1,128}$/u;
const GRANT_TTL_MS = 60 * 60_000;

function scopedId(value: unknown, prefix: string): value is string {
  return typeof value === 'string' && value.startsWith(prefix) && SCOPED_ID.test(value.slice(prefix.length));
}

function sessionId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256
    && !/[\x00-\x20\x7f]/u.test(value);
}

function validOwnerKey(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 256) return false;
  if (value.startsWith('union:')) return scopedId(value.slice(6), 'on_');
  const parts = value.split(':');
  return parts.length === 3 && parts[0] === 'app'
    && scopedId(parts[1], 'cli_') && scopedId(parts[2], 'ou_');
}

function ownerKeyMatchesSource(value: string, sourceApp: string): boolean {
  return value.startsWith('union:') || value.split(':')[1] === sourceApp;
}

function routeRevision(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
}

function clockValue(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function exactObject(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every(key => keys.includes(key));
}

function validSecret(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/** The key belongs to an observed human, never to a session's last-caller or
 * bot-owner fallback. open ids may only be compared within their issuing app. */
export function projectOwnerKey(identity: {
  larkAppId: string; ownerOpenId?: string; ownerUnionId?: string;
}): string | undefined {
  if (!scopedId(identity.larkAppId, 'cli_')) return undefined;
  // A malformed persisted cross-app identity must not downgrade to an
  // app-scoped identity and silently change the authority domain.
  if (identity.ownerUnionId !== undefined) {
    return scopedId(identity.ownerUnionId, 'on_') ? `union:${identity.ownerUnionId}` : undefined;
  }
  if (scopedId(identity.ownerOpenId, 'ou_')) {
    const key = `app:${identity.larkAppId}:${identity.ownerOpenId}`;
    return validOwnerKey(key) ? key : undefined;
  }
  return undefined;
}

export function projectCallerOwnerKey(caller: TrustedCaller | null | undefined): string | undefined {
  if (caller?.senderType !== 'user' || caller.source || !caller.requestLarkAppId) return undefined;
  return projectOwnerKey({
    larkAppId: caller.requestLarkAppId,
    ownerOpenId: caller.requestUserOpenId,
    ownerUnionId: caller.requestUserUnionId,
  });
}

export interface ProjectSourceGrant {
  domain: 'botmux.project-source-grant.v1';
  id: string;
  sourceSessionId: string;
  sourceLarkAppId: string;
  rootMessageId: string;
  routeRevision: number;
  ownerKey: string;
  targetChatId: string;
  coordinatorAppId: string;
  expiresAt: number;
}

const SOURCE_KEYS = ['sourceSessionId', 'sourceLarkAppId', 'rootMessageId', 'routeRevision', 'ownerKey'] as const;
const GRANT_KEYS = ['domain', 'id', ...SOURCE_KEYS, 'targetChatId', 'coordinatorAppId', 'expiresAt'] as const;

function validSource(raw: unknown): raw is Pick<ProjectSourceGrant, typeof SOURCE_KEYS[number]> {
  if (!exactObject(raw, SOURCE_KEYS)) return false;
  return sessionId(raw.sourceSessionId)
    && scopedId(raw.sourceLarkAppId, 'cli_')
    && scopedId(raw.rootMessageId, 'om_')
    && routeRevision(raw.routeRevision)
    && validOwnerKey(raw.ownerKey)
    && ownerKeyMatchesSource(raw.ownerKey, raw.sourceLarkAppId);
}

function validGrant(raw: unknown): raw is ProjectSourceGrant {
  if (!exactObject(raw, GRANT_KEYS)) return false;
  return raw.domain === 'botmux.project-source-grant.v1'
    && typeof raw.id === 'string' && /^[a-f0-9]{32}$/u.test(raw.id)
    && sessionId(raw.sourceSessionId)
    && scopedId(raw.sourceLarkAppId, 'cli_')
    && scopedId(raw.rootMessageId, 'om_')
    && routeRevision(raw.routeRevision)
    && validOwnerKey(raw.ownerKey)
    && ownerKeyMatchesSource(raw.ownerKey, raw.sourceLarkAppId)
    && scopedId(raw.targetChatId, 'oc_')
    && scopedId(raw.coordinatorAppId, 'cli_')
    && clockValue(raw.expiresAt);
}

function grantPath(dataDir: string, id: string): string {
  if (!/^[a-f0-9]{32}$/.test(id)) throw new Error('invalid_project_source_grant');
  return join(dataDir, '.dashboard-secret.project-source-grants', `${id}.json`);
}

function signature(secret: string, grant: ProjectSourceGrant): string {
  return createHmac('sha256', secret).update(JSON.stringify(grant)).digest('base64url');
}

/** Explicit source-owner consent. The source must already be in this project
 * chat: consent never moves it or grants transcript/terminal access. */
export function issueProjectSourceGrant(input: {
  dataDir: string; secret: string; callerOwnerKey?: string;
  source: Pick<ProjectSourceGrant, 'sourceSessionId' | 'sourceLarkAppId' | 'rootMessageId' | 'routeRevision' | 'ownerKey'>;
  targetChatId: string; coordinatorAppId: string; now?: number;
}): ProjectSourceGrant {
  const now = input.now ?? Date.now();
  if (!validSecret(input.secret) || !validSource(input.source)
    || !scopedId(input.targetChatId, 'oc_') || !scopedId(input.coordinatorAppId, 'cli_')
    || !clockValue(now) || !Number.isSafeInteger(now + GRANT_TTL_MS)) {
    throw new Error('invalid_project_source_grant');
  }
  if (!input.callerOwnerKey || input.callerOwnerKey !== input.source.ownerKey) {
    throw new Error('source_owner_authorization_required');
  }
  const grant: ProjectSourceGrant = {
    domain: 'botmux.project-source-grant.v1', id: randomUUID().replaceAll('-', ''),
    sourceSessionId: input.source.sourceSessionId,
    sourceLarkAppId: input.source.sourceLarkAppId,
    rootMessageId: input.source.rootMessageId,
    routeRevision: input.source.routeRevision,
    ownerKey: input.source.ownerKey,
    targetChatId: input.targetChatId, coordinatorAppId: input.coordinatorAppId,
    expiresAt: now + GRANT_TTL_MS,
  };
  writeSecureHostFileSync(grantPath(input.dataDir, grant.id), JSON.stringify({
    grant, signature: signature(input.secret, grant),
  }));
  return grant;
}

export function verifyProjectSourceGrant(input: {
  dataDir: string; secret: string; id: string;
  sourceSessionId: string; sourceLarkAppId: string; rootMessageId: string;
  routeRevision: number; targetChatId: string; coordinatorAppId: string; now?: number;
}): string | undefined {
  try {
    const now = input.now ?? Date.now();
    if (!validSecret(input.secret) || !clockValue(now)
      || !sessionId(input.sourceSessionId) || !scopedId(input.sourceLarkAppId, 'cli_')
      || !scopedId(input.rootMessageId, 'om_') || !routeRevision(input.routeRevision)
      || !scopedId(input.targetChatId, 'oc_') || !scopedId(input.coordinatorAppId, 'cli_')) return undefined;
    const stored = JSON.parse(readSecureHostFileSync(grantPath(input.dataDir, input.id), 8192) ?? '');
    if (!exactObject(stored, ['grant', 'signature']) || !validGrant(stored.grant)
      || typeof stored.signature !== 'string' || !/^[A-Za-z0-9_-]{43}$/u.test(stored.signature)) return undefined;
    const grant = stored.grant;
    const a = Buffer.from(signature(input.secret, grant), 'base64url');
    const b = Buffer.from(stored.signature, 'base64url');
    if (a.length !== b.length || !timingSafeEqual(a, b)
      || grant.domain !== 'botmux.project-source-grant.v1' || grant.id !== input.id
      || grant.expiresAt <= now
      || grant.sourceSessionId !== input.sourceSessionId || grant.sourceLarkAppId !== input.sourceLarkAppId
      || grant.rootMessageId !== input.rootMessageId || grant.routeRevision !== input.routeRevision
      || grant.targetChatId !== input.targetChatId || grant.coordinatorAppId !== input.coordinatorAppId) return undefined;
    return grant.ownerKey;
  } catch { return undefined; }
}
