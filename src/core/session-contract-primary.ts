import type { DurableSessionFacade } from '../services/durable-session-facade.js';
import type { DurableJson } from '../services/durable-coordination.js';
import type { SessionContractSnapshot } from '../services/session-contract-store.js';
import type { Session } from '../types.js';
import { successorPrimarySessionValue } from '../services/durable-session-primary.js';
import { sessionKey, storedSessionAnchorId } from './types.js';

const primaryFacades = new Map<string, { facade: DurableSessionFacade; fence(sessionId: string): void }>();
export function registerSessionContractPrimary(appId: string, facade: DurableSessionFacade, fence: (sessionId: string) => void): void {
  primaryFacades.set(appId, { facade, fence });
}
export function sessionContractPrimary(appId: string) { return primaryFacades.get(appId); }

/** Commit the contract checkpoint in the existing leased canonical Session
 * lane before allowing an IPC command or a user-visible state effect. */
export async function commitPrimarySessionContract(session: Session, snapshot: SessionContractSnapshot, expectedRevision: number): Promise<void> {
  const primary = primaryFacades.get(snapshot.session.ref.appId); if (!primary) return;
  const key = sessionKey(storedSessionAnchorId(session), snapshot.session.ref.appId);
  const checkpoint = { sessionRuntimeContract: snapshot, sessionLifecycle: snapshot.session.lifecycle,
    sessionContractRevision: snapshot.session.revision,
    status: snapshot.session.lifecycle === 'closed' ? 'closed' as const : 'active' as const };
  try {
    const written = await primary.facade.writeExactFromCurrent(key, current => {
      const value = current?.value as unknown as { type?: string; session?: Session } | undefined;
      if (value?.type !== 'botmux.session.primary' || value.session?.sessionId !== session.sessionId) {
        // In primary mode the /repo switch closes the predecessor and forks its
        // replacement on the same anchor without admitting any message, so the
        // lane still holds the closed predecessor when the replacement's first
        // checkpoint arrives. Only that first checkpoint (nothing committed yet)
        // of a live session may take its recorded predecessor's closed row over;
        // every other mismatch, including an active predecessor, still fences.
        const successor = expectedRevision === 0
          ? successorPrimarySessionValue(current, { ...session, ...checkpoint })
          : undefined;
        if (!successor) throw new Error('canonical_contract_session_changed');
        return successor;
      }
      const saved = value.session.sessionRuntimeContract;
      if ((saved?.session.revision ?? 0) !== expectedRevision) throw new Error('canonical_contract_revision_changed');
      return { ...value, session: { ...value.session, ...checkpoint } } as unknown as DurableJson;
    });
    if (written.kind !== 'written' && written.kind !== 'unchanged') throw new Error(`contract_primary_${written.kind}`);
  } catch (error) { primary.fence(session.sessionId); throw error; }
}
