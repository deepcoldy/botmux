/**
 * Platform-backed credential source for trigger-user CLI identity.
 *
 * Sits in front of the local per-person HOME resolution in
 * `turn-cli-identity.ts`. Given the turn's sender (an app-scoped open_id), it
 * resolves the tenant-stable union_id, asks the bound platform for a
 * short-lived grant, and converts the returned env variables into the same
 * {@link CliIdentity} shapes the wrapper already understands — so the
 * publication layer (turn stamping, per-session files, sandbox carve-outs) is
 * untouched.
 *
 * Who the credentials belong to is decided HERE, from the sender the daemon
 * saw, never from anything the CLI passes in.
 */
import { readPlatformBinding } from '../platform/binding.js';
import {
  requestCredentialGrant,
  platformCredentialsUrl,
  describeCredentialGrantFailure,
  type CredentialGrantResult,
  type CredentialGrantRequest,
} from '../platform/credential-grant-client.js';
import { resolveUnionIdFromOpenId } from '../im/lark/client.js';
import { logger } from '../utils/logger.js';
import type { BotConfig } from '../bot-registry.js';
import type { TriggerUserAuthTool } from '../services/trigger-user-auth.js';
import type { LarkCliIdentity, BytedCliIdentity } from './cli-identity.js';

export type PlatformIdentityResolution =
  | { state: 'granted'; identity: LarkCliIdentity | BytedCliIdentity; expiresAt: number }
  /** This machine is not bound to a platform; nothing was asked. */
  | { state: 'unbound' }
  /** The platform knows the person but has no usable credential for this tool
   *  (`consent` = they authorized, but not for this machine's team). */
  | { state: 'not_authorized'; authorizeUrl?: string; consent: boolean }
  /** The platform refused for a reason the person cannot fix by authorizing. */
  | { state: 'denied'; reason: 'not_teammate' | 'forbidden'; detail: string }
  /** Transient: platform unreachable / degraded / answered nonsense. */
  | { state: 'unavailable'; detail: string };

export interface ResolvePlatformIdentityArgs {
  botConfig: Pick<BotConfig, 'larkAppId'>;
  tool: TriggerUserAuthTool;
  /** The turn's sender, app-scoped. */
  openId: string;
  sessionId: string;
  turnId?: string;
}

interface Deps {
  readBinding: () => { platformUrl: string; machineToken: string; machineId: string } | null;
  resolveUnionId: (larkAppId: string, openId: string) => Promise<string | null>;
  requestGrant: (req: CredentialGrantRequest, opts: { binding: { platformUrl: string; machineToken: string; machineId: string } }) => Promise<CredentialGrantResult>;
  now: () => number;
}

const realDeps: Deps = {
  readBinding: () => {
    const b = readPlatformBinding();
    return b ? { platformUrl: b.platformUrl, machineToken: b.machineToken, machineId: b.machineId } : null;
  },
  // Resolved at call time, not module load: tests that stub the lark client
  // module with a fixed export set must still be able to import this file.
  resolveUnionId: (larkAppId, openId) => resolveUnionIdFromOpenId(larkAppId, openId),
  requestGrant: (req, opts) => requestCredentialGrant(req, opts),
  now: () => Date.now(),
};
let deps: Deps = realDeps;

/** @internal test-only */
export function __setPlatformCredentialDepsForTest(override: Partial<Deps> | null): void {
  deps = override ? { ...realDeps, ...override } : realDeps;
  unionIdCache.clear();
}

/** open_id → union_id is stable for a person within an app; cache it so a
 *  grant costs one round trip, not two. Negative answers are not cached: a
 *  contact-API blip must not pin a person as "unresolvable" for a day. */
const UNION_ID_TTL_MS = 24 * 60 * 60 * 1000;
/** Feishu union ids are `on_` + hex today; the bound keeps a path-safe shape
 *  without pinning the exact format. */
const UNION_ID_RE = /^[A-Za-z0-9_-]{4,128}$/;
const OPEN_ID_RE = /^ou_[A-Za-z0-9_-]{4,128}$/;
/** Seeded by every inbound message; bounded so a busy fleet cannot grow it forever. */
const UNION_ID_CACHE_MAX = 5000;
const unionIdCache = new Map<string, { unionId: string; at: number }>();

function rememberUnionId(key: string, unionId: string): void {
  unionIdCache.delete(key); // re-insert keeps recently seen people at the end
  unionIdCache.set(key, { unionId, at: deps.now() });
  if (unionIdCache.size <= UNION_ID_CACHE_MAX) return;
  // Over the cap: drop expired entries first, then the least recently used.
  const now = deps.now();
  for (const [k, v] of unionIdCache) {
    if (now - v.at >= UNION_ID_TTL_MS) unionIdCache.delete(k);
  }
  while (unionIdCache.size > UNION_ID_CACHE_MAX) {
    const oldest = unionIdCache.keys().next().value;
    if (oldest === undefined) break;
    unionIdCache.delete(oldest);
  }
}

/**
 * Record the union_id Feishu put on a verified inbound event for this app's
 * open_id. The contact API can only answer for people inside the bot app's
 * contact range (41050 "no user authority" otherwise), so a group member the
 * bot owner never added would be unresolvable — yet every message event
 * already carries `sender.sender_id.union_id`. Seeding from the event lets the
 * platform path work for anyone who talks to the bot. Only human senders are
 * recorded; malformed ids are ignored.
 *
 * The caller passes the raw event `data`; the identity comes from Feishu's
 * signed event, never from message text or anything the CLI controls.
 */
export function noteInboundSenderUnionId(larkAppId: string, data: unknown): void {
  const sender = (data as { sender?: { sender_type?: unknown; sender_id?: { open_id?: unknown; union_id?: unknown } } } | null)?.sender;
  if (!sender || sender.sender_type !== 'user') return;
  noteSenderUnionId(larkAppId, sender.sender_id?.open_id, sender.sender_id?.union_id);
}

/** Same as {@link noteInboundSenderUnionId} for a pair the daemon already holds
 *  from a trusted record (e.g. a schedule's host authority). */
export function noteSenderUnionId(larkAppId: string, openId: unknown, unionId: unknown): void {
  if (!larkAppId || typeof openId !== 'string' || !OPEN_ID_RE.test(openId)) return;
  // An open_id passes the generic shape check; never let one stand in for a union_id.
  if (typeof unionId !== 'string' || !UNION_ID_RE.test(unionId) || unionId.startsWith('ou_')) return;
  rememberUnionId(`${larkAppId}|${openId}`, unionId);
}

async function unionIdFor(larkAppId: string, openId: string): Promise<string | null> {
  const key = `${larkAppId}|${openId}`;
  const hit = unionIdCache.get(key);
  if (hit && deps.now() - hit.at < UNION_ID_TTL_MS) {
    // Keep the entry recently used without extending its lifetime.
    unionIdCache.delete(key);
    unionIdCache.set(key, hit);
    return hit.unionId;
  }
  let unionId: string | null = null;
  try { unionId = await deps.resolveUnionId(larkAppId, openId); } catch { unionId = null; }
  if (unionId && UNION_ID_RE.test(unionId)) {
    rememberUnionId(key, unionId);
    return unionId;
  }
  return null;
}

/**
 * Grant variables → identity. The client already enforces the per-tool
 * allow-list, but the identity file is the last stop before a wrapper execs a
 * tool, so re-check presence here and never publish a half-formed identity.
 *
 * Note `LARKSUITE_CLI_APP_ID` is the PLATFORM's Feishu app (the issuer of the
 * user token), deliberately not this bot's app id — the two differ by design.
 */
function toIdentity(tool: TriggerUserAuthTool, variables: Record<string, string>): LarkCliIdentity | BytedCliIdentity | null {
  const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
  if (tool === 'lark-cli') {
    const appId = variables.LARKSUITE_CLI_APP_ID;
    const userAccessToken = variables.LARKSUITE_CLI_USER_ACCESS_TOKEN;
    if (!nonEmpty(appId) || !nonEmpty(userAccessToken)) return null;
    return { tool, appId, userAccessToken };
  }
  const cloudJwt = variables.BYTEDCLI_USER_CLOUD_JWT;
  if (!nonEmpty(cloudJwt)) return null;
  const codeJwt = variables.BYTEDCLI_USER_CODE_JWT;
  return { tool, cloudJwt, ...(nonEmpty(codeJwt) ? { codeJwt } : {}) };
}

/** The platform page a refused person should open (null when unbound). */
export function platformAuthorizeUrl(): string | null {
  const binding = deps.readBinding();
  return binding ? platformCredentialsUrl({ binding }) : null;
}

/**
 * Resolve this turn's identity from the platform. Never throws.
 */
export async function resolvePlatformIdentity(args: ResolvePlatformIdentityArgs): Promise<PlatformIdentityResolution> {
  const binding = deps.readBinding();
  if (!binding) return { state: 'unbound' };

  const unionId = await unionIdFor(args.botConfig.larkAppId, args.openId);
  if (!unionId) {
    logger.warn(`[trigger-user-auth] platform grant skipped for ${args.tool}: could not resolve union_id for sender`);
    return { state: 'unavailable', detail: 'sender union_id unresolved' };
  }

  const result = await deps.requestGrant({
    tool: args.tool,
    unionId,
    appId: args.botConfig.larkAppId,
    sessionId: args.sessionId,
    ...(args.turnId ? { turnId: args.turnId } : {}),
  }, { binding });

  if (result.ok) {
    const identity = toIdentity(args.tool, result.value.variables);
    if (!identity) {
      logger.warn(`[trigger-user-auth] platform ${args.tool} grant malformed: required variable missing`);
      return { state: 'unavailable', detail: 'malformed grant' };
    }
    return { state: 'granted', identity, expiresAt: result.value.expiresAt };
  }
  const detail = describeCredentialGrantFailure(result);
  const pageUrl = platformCredentialsUrl({ binding }) ?? undefined;
  switch (result.reason) {
    case 'unbound':
      return { state: 'unbound' };
    case 'not_authorized':
      return { state: 'not_authorized', authorizeUrl: result.authorizeUrl ?? pageUrl, consent: false };
    case 'consent_missing':
      return { state: 'not_authorized', authorizeUrl: result.authorizeUrl ?? pageUrl, consent: true };
    case 'not_teammate':
      return { state: 'denied', reason: 'not_teammate', detail };
    case 'forbidden':
      logger.warn(`[trigger-user-auth] platform refused ${args.tool} grant: ${detail}`);
      return { state: 'denied', reason: 'forbidden', detail };
    default:
      logger.warn(`[trigger-user-auth] platform ${args.tool} grant unavailable: ${detail}`);
      return { state: 'unavailable', detail };
  }
}
