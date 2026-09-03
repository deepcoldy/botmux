/**
 * Freezing the mojo control-plane identity onto a session row.
 *
 * Deliberately its OWN module rather than living in worker-pool: session-manager
 * needs it during restore and resume, and many tests mock worker-pool wholesale —
 * importing it from there made every one of those mocks incomplete, breaking ~40
 * unrelated tests. A small leaf module with no worker/spawn dependencies is also
 * far cheaper for those tests to pull in.
 */
import { getBot } from '../bot-registry.js';
import * as sessionStore from '../services/session-store.js';
import type { Session } from '../types.js';
import { logger } from '../utils/logger.js';
import { pickMojoSessionIdentity, type MojoConfig } from '../adapters/backend/mojo-types.js';

/**
 * Freeze (or quarantine) the mojo control-plane identity of ONE session row,
 * operating on the bare Session so it can run BEFORE the row is registered into
 * the active map.
 *
 * Ordering is the whole point: restoreActiveSessions runs with the dispatcher
 * already live, so a row that becomes visible before it is frozen can be woken —
 * or `/close`d — while still reading live bot config, which is how a lineage
 * created on tenant A could be paired with tenant B.
 *
 * Idempotent: a row that already carries an identity is left untouched.
 */
/**
 * Is this row a mojo session?
 *
 * Must NOT read `session.backendType` alone. forkWorker builds initMsg — and
 * therefore calls the freeze — BEFORE it stamps `backendType`/`cliId` onto the
 * row (worker-pool: sessionMojoConfig at initMsg construction vs. the stamp
 * after `worker.send`), and createSession() never writes those fields. So on the
 * one path EVERY new mojo session takes, both are still `undefined` and a
 * `!== 'mojo'` guard early-returns: the freeze silently no-ops, leaving the
 * "control plane edited after creation" window wide open and causing the next
 * restart to quarantine a lineage whose control plane was fully known.
 *
 * Precedence:
 *   - a STAMPED backendType is authoritative (a riff row stays untouched even if
 *     the bot has since been switched to mojo);
 *   - otherwise fall back to the live bot config, which is what decides the
 *     session's backend in the first place.
 */
function isMojoSessionRow(session: Session, larkAppId: string): boolean {
  if (session.backendType) return session.backendType === 'mojo';
  if (session.cliId === 'mojo') return true;
  try {
    const cfg = getBot(larkAppId).config;
    return cfg.backendType === 'mojo' || cfg.cliId === 'mojo';
  } catch {
    // Bot deregistered — cannot classify, so do nothing rather than freeze a row
    // that may not be mojo at all.
    return false;
  }
}

export function freezeMojoIdentityForSession(session: Session, larkAppId: string): void {
  if (!isMojoSessionRow(session, larkAppId)) return;

  // BACKFILL, before the early return below. A row quarantined by an earlier
  // build already has an identity, so it would return here and never get the
  // notice flag — the user would never learn their context was parked. Runs as
  // its own step so it is independent of whether a freeze is needed.
  if (session.mojoQuarantinedLineage
      && session.mojoQuarantineNoticePending === undefined) {
    session.mojoQuarantineNoticePending = true;
    sessionStore.updateSession(session);
    logger.info(
      `[mojo] session ${session.sessionId} was quarantined by an earlier build; `
      + 'queued the user-visible notice',
    );
  }

  if (session.mojoIdentity) return;

  let liveMojo: MojoConfig | undefined;
  try {
    liveMojo = getBot(larkAppId).config.mojo;
  } catch {
    // Bot deregistered — nothing to freeze from. Leave the row so a later
    // re-registration can migrate it.
    return;
  }

  // Only reached for an UNFROZEN row, where any lineage is unverifiable by
  // definition. Prefer the active slot; if a stale parked id is also present and
  // differs, keep both rather than silently overwriting an audit record.
  const active = session.riffParentTaskId;
  const alreadyParked = session.mojoQuarantinedLineage;
  const lineage = active ?? alreadyParked;
  if (lineage) {
    if (active && alreadyParked && active !== alreadyParked) {
      logger.warn(
        `[mojo] session ${session.sessionId} carries two unverifiable lineages `
        + `(active + previously parked); parking both for manual cleanup.`,
      );
      session.mojoQuarantinedLineage = `${alreadyParked},${active}`;
      session.riffParentTaskId = undefined;
      session.mojoQuarantineNoticePending = true;
      session.mojoIdentity = pickMojoSessionIdentity(liveMojo);
      session.mojoIdentityHostDefault = true;
      sessionStore.updateSession(session);
      return;
    }
    // Unverifiable: created before the identity existed, so nothing records which
    // control plane holds it. Park it instead of deleting — the id is the only
    // handle left for manual inspection/cleanup, and the user can be told.
    session.mojoQuarantinedLineage = lineage;
    session.riffParentTaskId = undefined;
    // Flag for a user-visible notice. This module runs during restore/resume where
    // there is no reply context, so the actual delivery happens on the next turn
    // (see deliverPendingMojoQuarantineNotice); a log line alone would leave the
    // user unaware that their context was parked.
    session.mojoQuarantineNoticePending = true;
    logger.warn(
      `[mojo] session ${session.sessionId} has a remote lineage but no frozen `
      + 'control plane; quarantined it (no automatic resume or cancel).',
    );
  }
  // Persist even an EMPTY snapshot: `{}` means "frozen with nothing configured"
  // and must stay distinguishable from `undefined` ("predates this field"),
  // otherwise the row is migrated again on every boot.
  session.mojoIdentity = pickMojoSessionIdentity(liveMojo);
  // Stamp the default era. An unstamped `{}` identity was frozen by a build
  // whose double-unset default was the CLOUD SANDBOX; sessionMojoConfig pins
  // those to localDaemon=false so an upgrade cannot silently move a live
  // session's tools onto the host (review F1).
  session.mojoIdentityHostDefault = true;
  sessionStore.updateSession(session);
}
