import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as sessionStore from '../src/services/session-store.js';
import { activeSessionKey, type DaemonSession } from '../src/core/types.js';
import type { Session } from '../src/types.js';
import { loadWorkerPoolFunction } from './helpers/worker-pool-function-harness.js';

// Execute the production closure with the real SQLite store. The pool still
// owns this host lifetime internally, so the transitional harness supplies only
// registry/logging dependencies, without copying the receipt mutation.
describe('Mojo notice receipt persistence', () => {
  const registry = new Map<string, DaemonSession>();
  const scope = { sessionStore, activeSessionKey, activeSessionsRegistry: registry,
    logger: { warn: vi.fn() }, tag: (ds: DaemonSession) => ds.session.sessionId };
  const canForkRegisteredSession = loadWorkerPoolFunction<(ds: DaemonSession) => boolean>('canForkRegisteredSession', scope);
  const markDelivered = loadWorkerPoolFunction<(
    ds: DaemonSession, session: Session,
    flag: 'mojoQuarantineNoticePending' | 'mojoLegacyPinNoticePending',
    identity: (session: Session) => string, expectedIdentity: string, expectedGeneration: number | undefined,
  ) => void>('markMojoNoticeDelivered', { ...scope, canForkRegisteredSession });
  let row: Session;
  let ds: DaemonSession;

  beforeEach(() => {
    // config already points inside the unit HOME fence. Each test uses its own
    // app store to avoid open connections or state leaking between cases.
    sessionStore.init(`notice-receipt-${crypto.randomUUID()}`);
    row = sessionStore.createSession('oc_example', 'om_example', 'receipt', 'group', 'thread');
    Object.assign(row, { workerGeneration: 1, mojoQuarantinedLineage: 'prior-lineage',
      mojoQuarantineNoticePending: true, mojoLegacyPinNoticePending: true });
    sessionStore.updateSession(row);
    ds = { session: row, chatId: row.chatId, larkAppId: 'example-app', scope: 'thread', workerGeneration: 1 } as DaemonSession;
    registry.set(activeSessionKey(ds), ds);
  });
  afterEach(() => {
    registry.clear();
    sessionStore.init('notice-receipt-disposed'); // Close the preceding SQLite connection.
  });

  const identity = (session: Session): string => session.mojoQuarantinedLineage ?? '';
  const complete = (): void => markDelivered(ds, row, 'mojoQuarantineNoticePending', identity, 'prior-lineage', 1);

  it('clears only the delivered receipt and survives a store reload', () => {
    complete();
    const fresh = sessionStore.getSessionFresh(row.sessionId)!;
    expect(fresh.mojoQuarantineNoticePending).toBe(false);
    expect(fresh.mojoLegacyPinNoticePending).toBe(true);
    expect(fresh.workerGeneration).toBe(1);
    expect(fresh.mojoQuarantinedLineage).toBe('prior-lineage');
  });

  it.each(['generation', 'lineage', 'closed'])('preserves a durable successor after a late completion (%s)', kind => {
    const successor = { ...row };
    if (kind === 'generation') successor.workerGeneration = 2;
    if (kind === 'lineage') successor.mojoQuarantinedLineage = 'successor-lineage';
    if (kind === 'closed') successor.status = 'closed';
    sessionStore.updateSession(successor);
    complete();
    const fresh = sessionStore.getSessionFresh(row.sessionId)!;
    expect(fresh.mojoQuarantineNoticePending).toBe(true);
    expect(fresh.workerGeneration).toBe(successor.workerGeneration);
    expect(fresh.mojoQuarantinedLineage).toBe(successor.mojoQuarantinedLineage);
    expect(fresh.status).toBe(successor.status);
  });

  it.each(['registry', 'session'])('does not persist for a replaced host owner (%s)', kind => {
    if (kind === 'registry') registry.set(activeSessionKey(ds), { ...ds });
    else ds.session = { ...row };
    complete();
    expect(sessionStore.getSessionFresh(row.sessionId)!.mojoQuarantineNoticePending).toBe(true);
  });
});
