import { withHardTimeout } from '../platform/credential-grant-client.js';
import { readCliAuthEpoch } from '../services/cli-auth-epoch.js';
import type { TriggerUserAuthConfig } from '../services/trigger-user-auth.js';
import type { BotConfig } from '../bot-registry.js';
import { recallProvenIdentitySnapshot, writeSessionIdentity, type LarkCliIdentity, type ProvenIdentitySnapshot } from './cli-identity.js';
import { policyFromConfig } from './identity-policy.js';
import { getLarkToolDelegation } from './lark-tool-delegation.js';
import { activePlatformCredentialBindingKey, resolvePlatformIdentity, type PlatformIdentityResolution } from './platform-credential-source.js';
import { allowsPersonalIdentityForTurn } from './workflow-event-turn.js';

type PlatformLarkAuthority = Pick<Extract<PlatformIdentityResolution, { state: 'granted' }>, 'bindingKey' | 'unionId' | 'expiresAt'>;

interface LarkPublicationContext {
  sessionDataDir: string;
  sessionId: string;
  turnId: string;
  senderOpenId: string;
  botConfig: BotConfig;
  validateBeforeWrite?: () => boolean;
}

type LarkRenewalFailure = 'unavailable' | 'denied' | 'not_authorized' | 'consent_missing';

interface LarkPublication extends LarkPublicationContext, PlatformLarkAuthority {
  identity: LarkCliIdentity;
  snapshot: ProvenIdentitySnapshot;
  authEpoch: number;
  retryAfter: number;
  failure?: LarkRenewalFailure;
  inFlight?: { forced: boolean; promise: Promise<void> };
}

interface LarkRenewalContext {
  sessionDataDir: string;
  sessionId: string;
  turnId: string;
  speakerOpenId?: string;
  currentPolicy: () => TriggerUserAuthConfig | undefined;
  executionStillCurrent: () => boolean;
}

// Using the snapshot as the key ties the credential context to the lifetime of
// the exact publication; turn collection and revocation drop it together.
const publications = new WeakMap<ProvenIdentitySnapshot, LarkPublication>();
const REFRESH_BEFORE_MS = 5 * 60_000;
const RETRY_INTERVAL_MS = 10_000;

export function writeProvenPlatformLarkIdentity(
  context: LarkPublicationContext, identity: LarkCliIdentity, grant: PlatformLarkAuthority,
): void {
  const { sessionDataDir, sessionId, turnId, senderOpenId } = context;
  writeSessionIdentity(sessionDataDir, sessionId, identity, 'proven');
  const snapshot = recallProvenIdentitySnapshot(sessionDataDir, sessionId, turnId, 'lark-cli')!;
  publications.set(snapshot, {
    ...context, identity, snapshot, unionId: grant.unionId, bindingKey: grant.bindingKey, expiresAt: grant.expiresAt,
    authEpoch: readCliAuthEpoch(senderOpenId), retryAfter: 0,
  });
}

function currentPublication({ sessionDataDir, sessionId, turnId }: LarkRenewalContext): LarkPublication | undefined {
  const snapshot = recallProvenIdentitySnapshot(sessionDataDir, sessionId, turnId, 'lark-cli');
  return snapshot && publications.get(snapshot);
}

function larkPublicationStillAllowed(entry: LarkPublication, args: LarkRenewalContext): boolean {
  try {
    const { sessionDataDir, sessionId, turnId } = entry;
    if (args.speakerOpenId !== entry.senderOpenId || currentPublication(args) !== entry
      || getLarkToolDelegation(sessionDataDir, sessionId, turnId)
      || readCliAuthEpoch(entry.senderOpenId) !== entry.authEpoch
      || activePlatformCredentialBindingKey() !== entry.bindingKey
      || entry.validateBeforeWrite?.() === false || !args.executionStillCurrent()) return false;
    const policy = args.currentPolicy();
    const effective = policyFromConfig(policy);
    return allowsPersonalIdentityForTurn(turnId, policy)
      && effective.capabilities.has('lark-user') && effective.credentialSources['lark-user'] !== 'local';
  } catch {
    return false;
  }
}

/** An automatic re-authorization belongs to the original principal and publication. */
export function platformLarkAuthorization(args: LarkRenewalContext) {
  const entry = currentPublication(args);
  return entry && { unionId: entry.unionId, stillAllowed: () => larkPublicationStillAllowed(entry, args) };
}

async function renew(entry: LarkPublication, stillAllowed: () => boolean): Promise<void> {
  const { sessionDataDir, sessionId, turnId, botConfig, unionId } = entry;
  const grant = await resolvePlatformIdentity({ botConfig, tool: 'lark-cli', unionId, sessionId, turnId });
  if (!stillAllowed()) return;
  if (grant.state === 'not_authorized') {
    entry.failure = grant.consent ? 'consent_missing' : 'not_authorized';
    return;
  }
  if (grant.state === 'denied') {
    entry.failure = 'denied';
    return;
  }
  if (grant.state !== 'granted' || grant.bindingKey !== entry.bindingKey || grant.identity.tool !== 'lark-cli'
    || grant.identity.appId !== entry.identity.appId || grant.identity.userAccessToken === entry.identity.userAccessToken
    || grant.expiresAt <= Math.max(Date.now(), entry.expiresAt)) return;

  const identity = { ...entry.identity, userAccessToken: grant.identity.userAccessToken };
  writeSessionIdentity(sessionDataDir, sessionId, identity, 'proven');
  const snapshot = recallProvenIdentitySnapshot(sessionDataDir, sessionId, turnId, 'lark-cli')!;
  publications.delete(entry.snapshot);
  entry.snapshot = snapshot;
  entry.identity = identity;
  entry.expiresAt = grant.expiresAt;
  entry.failure = undefined;
  publications.set(snapshot, entry);
}

export async function refreshPlatformLarkGrant(
  args: LarkRenewalContext & { waitMs: number; force?: boolean },
): Promise<'untracked' | 'ready' | 'superseded' | LarkRenewalFailure> {
  const entry = currentPublication(args);
  if (!entry) return 'untracked';
  const stillAllowed = () => larkPublicationStillAllowed(entry, args);
  if (!stillAllowed()) return 'superseded';
  if (!entry.failure && entry.expiresAt > Date.now() + REFRESH_BEFORE_MS) return 'ready';

  const deadline = Date.now() + args.waitMs;
  while (true) {
    if (!entry.inFlight && Date.now() < deadline && (args.force || Date.now() >= entry.retryAfter)) {
      entry.inFlight = {
        forced: !!args.force,
        promise: renew(entry, stillAllowed).catch(() => {
          // Network failure leaves the current expiry and any explicit refusal intact.
        }).finally(() => {
          entry.retryAfter = Date.now() + RETRY_INTERVAL_MS;
          entry.inFlight = undefined;
        }),
      };
    }
    const attempt = entry.inFlight;
    const remaining = deadline - Date.now();
    if (attempt && remaining > 0) {
      // Only stop this wait; the grant is shared by other callers.
      await withHardTimeout(() => attempt.promise, remaining).catch(() => {});
    }
    if (!stillAllowed()) return 'superseded';
    const result = entry.failure ?? (entry.expiresAt > Date.now() ? 'ready' : 'unavailable');
    if (args.force && result !== 'ready' && attempt && !attempt.forced && !entry.inFlight && Date.now() < deadline) continue;
    return result;
  }
}
