import { describe, expect, it } from 'vitest';
import { riffWorkerShutdownInputBlocker } from '../src/core/riff-worker-shutdown-readiness.js';

const idle = {
  initPromptMaterialized: true,
  isFlushing: false,
  pendingMessages: 0,
  pendingRawInputs: 0,
  pendingSessionRename: false,
  sessionRenameInFlight: false,
  commandLineWritesPending: 0,
};

describe('Riff worker shutdown input ownership', () => {
  it('allows the current backend task itself when no unsent worker input exists', () => {
    expect(riffWorkerShutdownInputBlocker(idle)).toBeNull();
  });

  it('refuses current-task detach when a follow-up is still in pendingMessages', () => {
    expect(riffWorkerShutdownInputBlocker({ ...idle, pendingMessages: 1 }))
      .toBe('messages=1');
  });

  it('accounts for every worker-owned pre-backend input surface', () => {
    expect(riffWorkerShutdownInputBlocker({
      initPromptMaterialized: false,
      isFlushing: true,
      pendingMessages: 2,
      pendingRawInputs: 1,
      pendingSessionRename: true,
      sessionRenameInFlight: true,
      commandLineWritesPending: 1,
    })).toBe(
      'init=materializing,flushing=1,messages=2,raw=1,rename=1,rename_inflight=1,command_writes=1',
    );
  });
});
