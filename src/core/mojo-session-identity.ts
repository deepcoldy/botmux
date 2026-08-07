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
export function freezeMojoIdentityForSession(session: Session, larkAppId: string): void {
  const backendType = session.backendType;
  if (backendType !== 'mojo') return;
  if (session.mojoIdentity) return;

  let liveMojo: MojoConfig | undefined;
  try {
    liveMojo = getBot(larkAppId).config.mojo;
  } catch {
    // Bot deregistered — nothing to freeze from. Leave the row so a later
    // re-registration can migrate it.
    return;
  }

  const lineage = session.riffParentTaskId ?? session.mojoQuarantinedLineage;
  if (lineage) {
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
  sessionStore.updateSession(session);
}
