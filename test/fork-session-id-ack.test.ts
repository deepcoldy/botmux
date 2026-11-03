import { describe, expect, it, vi } from 'vitest';
import { loadWorkerPoolMessageHandlers } from './helpers/worker-pool-message-harness.js';

function setup() {
  const ds = {
    session: { cliSessionId: 'parent', pendingForkSession: true, codexCleanupTarget: undefined },
    initConfig: { forkSession: true },
  };
  const update = vi.fn();
  const ownership = vi.fn();
  const handle = loadWorkerPoolMessageHandlers(['cli_session_id'], {
    ds, effectiveCliId: 'antigravity', isLocalCliOpenReady: () => false,
    sessionStore: { updateSession: update }, recordOwnershipForDaemonSession: ownership,
    managedAuxUiSuppressed: () => true,
  });
  return { ds, update, ownership, handle };
}

describe('fork identity acknowledgement', () => {
  it('an early observation of the parent cannot consume the persisted fork intent', () => {
    const h = setup();
    h.handle({ type: 'cli_session_id', cliSessionId: 'parent' });
    expect(h.ds.session.pendingForkSession).toBe(true);
    expect(h.ds.initConfig.forkSession).toBe(true);
    expect(h.update).not.toHaveBeenCalled();
    expect(h.ownership).not.toHaveBeenCalled();
  });

  it('acknowledges an independent child and permits normal same-id refreshes afterwards', () => {
    const h = setup();
    h.handle({ type: 'cli_session_id', cliSessionId: 'child' });
    expect(h.ds.session.cliSessionId).toBe('child');
    expect(h.ds.session.pendingForkSession).toBeUndefined();
    expect(h.ds.initConfig.forkSession).toBe(false);
    expect(h.update).toHaveBeenCalledTimes(1);
    h.handle({ type: 'cli_session_id', cliSessionId: 'child' });
    expect(h.update).toHaveBeenCalledTimes(2);
    expect(h.ownership).toHaveBeenCalledTimes(2);
  });
});
