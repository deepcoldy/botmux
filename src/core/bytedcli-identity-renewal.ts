/**
 * Mid-turn renewal of locally minted bytedcli identities.
 *
 * A turn's identity is minted once when the turn is prepared, but a ByteCloud
 * JWT lives ~2 hours. A long job launched by one turn (a nightly batch, a
 * backfill) would otherwise start failing with 401 halfway through. The daemon
 * re-publishes the SAME person's identity for the SAME turn with fresh tokens
 * before they expire; it never changes whose identity a turn carries.
 *
 * Only identities minted from this machine's per-person bytedcli HOME are
 * tracked (platform grants have their own lifetime). An entry is dropped as
 * soon as the turn's published material is gone or was replaced by anything
 * other than what this module last wrote.
 */
import { logger } from '../utils/logger.js';
import { renewBytedcliJwts } from '../services/bytedcli-auth.js';
import {
  recallProvenIdentityContent,
  renderIdentityEnv,
  writeSessionIdentity,
  type BytedCliIdentity,
} from './cli-identity.js';

/** Renew once the soonest-expiring ByteCloud JWT has less than this left. */
export const BYTEDCLI_RENEW_BEFORE_EXPIRY_MS = 40 * 60_000;
/** How often the daemon sweeps tracked turns. */
export const BYTEDCLI_RENEWAL_SWEEP_MS = 5 * 60_000;

interface RenewalEntry {
  sessionDataDir: string;
  sessionId: string;
  credentialOpenId: string;
  identity: BytedCliIdentity & { turnId: string };
}

const entries = new Map<string, RenewalEntry>();

function entryKey(sessionDataDir: string, sessionId: string, turnId: string): string {
  return JSON.stringify([sessionDataDir, sessionId, turnId]);
}

function jwtExpiryMs(jwt: string | undefined): number | undefined {
  if (!jwt) return undefined;
  try {
    const exp = JSON.parse(Buffer.from(jwt.split('.')[1] ?? '', 'base64url').toString('utf8'))?.exp;
    return typeof exp === 'number' ? exp * 1_000 : undefined;
  } catch {
    return undefined;
  }
}

/** Soonest expiry among the ByteCloud JWTs a wrapper may select. */
export function bytedcliIdentityExpiryMs(identity: BytedCliIdentity): number | undefined {
  const expiries = [identity.cloudJwt, ...Object.values(identity.regionalCloudJwts ?? {})]
    .map(jwtExpiryMs)
    .filter((v): v is number => v !== undefined);
  return expiries.length ? Math.min(...expiries) : undefined;
}

/** Track a proven bytedcli identity just published from a local mint. */
export function trackBytedcliIdentityRenewal(entry: RenewalEntry): void {
  entries.set(entryKey(entry.sessionDataDir, entry.sessionId, entry.identity.turnId), {
    ...entry,
    identity: { ...entry.identity },
  });
}

/** Test/diagnostic hook. */
export function trackedBytedcliRenewalCount(): number {
  return entries.size;
}

export function forgetBytedcliIdentityRenewals(): void {
  entries.clear();
}

function stillPublished(entry: RenewalEntry): boolean {
  const current = recallProvenIdentityContent(entry.sessionDataDir, entry.sessionId, entry.identity.turnId, 'bytedcli');
  return current !== undefined && current === renderIdentityEnv(entry.identity);
}

const inFlight = new Set<string>();

/**
 * Renew every tracked identity close to expiry. Never throws; a failed renewal
 * keeps the current (still valid) tokens and is retried on the next sweep.
 */
export async function renewExpiringBytedcliIdentities(
  now: () => number = Date.now,
  renewBeforeMs: number = BYTEDCLI_RENEW_BEFORE_EXPIRY_MS,
): Promise<number> {
  let renewed = 0;
  for (const [key, entry] of [...entries]) {
    if (entries.get(key) !== entry) continue;
    if (inFlight.has(key)) continue;
    if (!stillPublished(entry)) { entries.delete(key); continue; }
    const expiresAt = bytedcliIdentityExpiryMs(entry.identity);
    if (expiresAt === undefined || expiresAt - now() > renewBeforeMs) continue;
    inFlight.add(key);
    try {
      const jwts = await renewBytedcliJwts(entry.credentialOpenId);
      if (!jwts) {
        logger.warn(`[bytedcli-renewal] could not renew ${entry.sessionId.slice(0, 8)}/${entry.identity.turnId.slice(0, 12)}; keeping current tokens`);
        continue;
      }
      // The turn may have ended or been republished while the CLI ran.
      if (entries.get(key) !== entry) continue;
      if (!stillPublished(entry)) { entries.delete(key); continue; }
      const identity: BytedCliIdentity & { turnId: string } = {
        tool: 'bytedcli',
        cloudJwt: jwts.cloudJwt,
        // Keep material the renewal could not refresh rather than drop it.
        ...(jwts.codeJwt ?? entry.identity.codeJwt ? { codeJwt: jwts.codeJwt ?? entry.identity.codeJwt } : {}),
        ...(jwts.regionalCloudJwts || entry.identity.regionalCloudJwts
          ? { regionalCloudJwts: { ...entry.identity.regionalCloudJwts, ...jwts.regionalCloudJwts } }
          : {}),
        turnId: entry.identity.turnId,
        ...(entry.identity.openId ? { openId: entry.identity.openId } : {}),
      };
      writeSessionIdentity(entry.sessionDataDir, entry.sessionId, identity, 'proven');
      entries.set(key, { ...entry, identity });
      renewed += 1;
      const next = bytedcliIdentityExpiryMs(identity);
      logger.info(`[bytedcli-renewal] renewed ${entry.sessionId.slice(0, 8)}/${entry.identity.turnId.slice(0, 12)}`
        + (next ? ` until ${new Date(next).toISOString()}` : ''));
    } catch (error) {
      logger.warn(`[bytedcli-renewal] renewal failed for ${entry.sessionId.slice(0, 8)}: `
        + `${error instanceof Error ? error.message : String(error)}`);
    } finally {
      inFlight.delete(key);
    }
  }
  return renewed;
}
