import { describe, expect, it, vi } from 'vitest';
import { loadWorkerPoolMessageHandlers } from './helpers/worker-pool-message-harness.js';

function setup() {
  const ds = {
    session: {
      cliSessionId: 'parent', pendingForkSession: true as boolean | undefined,
      codexCleanupTarget: undefined, projectRouteRevision: 1, projectImportPending: true,
    },
    initConfig: { forkSession: true },
  };
  const update = vi.fn();
  const ownership = vi.fn();
  const associationChanged = vi.fn();
  const handle = loadWorkerPoolMessageHandlers(['cli_session_id'], {
    ds, effectiveCliId: 'antigravity', isLocalCliOpenReady: () => false,
    sessionStore: { updateSession: update }, recordOwnershipForDaemonSession: ownership,
    noteProjectAssociationChanged: associationChanged,
    managedAuxUiSuppressed: () => true,
  });
  return { ds, update, ownership, associationChanged, handle };
}

describe('fork identity acknowledgement', () => {
  it('an early observation of the parent cannot consume the persisted fork intent', () => {
    const h = setup();
    h.handle({ type: 'cli_session_id', cliSessionId: 'parent' });
    expect(h.ds.session.pendingForkSession).toBe(true);
    expect(h.ds.initConfig.forkSession).toBe(true);
    expect(h.update).not.toHaveBeenCalled();
    expect(h.ownership).not.toHaveBeenCalled();
    expect(h.associationChanged).not.toHaveBeenCalled();
  });

  it('acknowledges an independent child and permits normal same-id refreshes afterwards', () => {
    const h = setup();
    h.handle({ type: 'cli_session_id', cliSessionId: 'child' });
    expect(h.ds.session.cliSessionId).toBe('child');
    expect(h.ds.session.pendingForkSession).toBeUndefined();
    expect(h.ds.initConfig.forkSession).toBe(false);
    expect(h.update).toHaveBeenCalledTimes(1);
    expect(h.associationChanged).toHaveBeenCalledExactlyOnceWith(h.ds.session);
    expect(h.ds.session.projectRouteRevision).toBe(1);
    h.handle({ type: 'cli_session_id', cliSessionId: 'child' });
    expect(h.update).toHaveBeenCalledTimes(2);
    expect(h.ownership).toHaveBeenCalledTimes(2);
    expect(h.associationChanged).toHaveBeenCalledTimes(1);
  });

  it('invalidates the association episode only when an acknowledged native session changes', () => {
    const h = setup();
    h.ds.session.pendingForkSession = undefined;
    h.ds.initConfig.forkSession = false;
    h.handle({ type: 'cli_session_id', cliSessionId: 'replacement' });
    expect(h.ds.session).toMatchObject({
      cliSessionId: 'replacement', projectRouteRevision: 2, projectImportPending: false,
    });
    expect(h.update).toHaveBeenCalledExactlyOnceWith(h.ds.session);
    expect(h.associationChanged).toHaveBeenCalledExactlyOnceWith(h.ds.session);
    h.handle({ type: 'cli_session_id', cliSessionId: 'replacement' });
    expect(h.ds.session.projectRouteRevision).toBe(2);
    expect(h.associationChanged).toHaveBeenCalledTimes(1);
    expect(h.ownership).toHaveBeenCalledTimes(2);
  });
});
