import { describe, expect, it } from 'vitest';
import { workerSubmitHarness } from './helpers/worker-submit-harness.js';
import { loadWorkerFunction } from './helpers/worker-function-harness.js';

describe('unconfirmed Web terminal wire state', () => {
  it('holds the queued input for the exact dirty CLI generation', async () => {
    const h = workerSubmitHarness();
    h.scope.cliLifetimeNonce = 'owned-runtime';
    h.scope.webTerminalDirtyTarget = {
      backend: h.scope.backend, lifetime: 'owned-runtime', generation: h.scope.cliSpawnGeneration,
    };
    const dirty = loadWorkerFunction<() => boolean>('webTerminalInputWireDirty', h.scope);
    expect(dirty()).toBe(true);
    await h.flush();
    expect(h.scope.cliAdapter.writeInput).not.toHaveBeenCalled();
    expect(h.scope.pendingMessages.map((item: { content: string }) => item.content)).toEqual(['payload']);
  });

  it.each(['backend', 'lifetime', 'generation'] as const)('does not apply an old dirty marker to a changed %s', field => {
    const backend = {};
    const scope: Record<string, unknown> = {
      backend, cliLifetimeNonce: 'owned', cliSpawnGeneration: 1,
      webTerminalDirtyTarget: { backend, lifetime: 'owned', generation: 1 },
    };
    const dirty = loadWorkerFunction<() => boolean>('webTerminalInputWireDirty', scope);
    expect(dirty()).toBe(true);
    if (field === 'backend') scope.backend = {};
    if (field === 'lifetime') scope.cliLifetimeNonce = 'replacement';
    if (field === 'generation') scope.cliSpawnGeneration = 2;
    expect(dirty()).toBe(false);
  });
});
