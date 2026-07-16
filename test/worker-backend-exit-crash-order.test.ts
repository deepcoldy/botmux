/**
 * Crash-order regression for worker-owned backend replacement.
 *
 * worker.ts is a process entrypoint (it installs process IPC/signal handlers),
 * so this test pins the production callback wiring directly instead of
 * importing it into the Vitest host process. The identity fence must run before
 * any durable/current-backend state is changed or claude_exit is emitted.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const workerSource = readFileSync(new URL('../src/worker.ts', import.meta.url), 'utf8');

describe('worker backend exit crash ordering', () => {
  it('fences a delayed old-backend exit before it can clear the replacement backend or durable turn', () => {
    const start = workerSource.indexOf('const observedBackend = backend;');
    const end = workerSource.indexOf('\n\n  if (isPipeMode', start);

    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);

    const callback = workerSource.slice(start, end);
    const clearIntentional = callback.indexOf('if (intentionalRestart) intentionalRestartBackend = null;');
    const identityFence = callback.indexOf('if (backend !== observedBackend)');
    const revokeCapability = callback.indexOf('completeManagedTurnOriginRevocation(');
    const clearDurable = callback.indexOf('durableTurnInFlight = false;');
    const stashInflight = callback.indexOf('inflightInputs.onCliExit');
    const clearBackend = callback.indexOf('backend = null;');
    const emitExit = callback.indexOf("send({ type: 'claude_exit'");

    expect(clearIntentional).toBeGreaterThanOrEqual(0);
    expect(identityFence).toBeGreaterThan(clearIntentional);
    expect(callback.slice(identityFence, clearDurable)).toMatch(/return;/);
    expect(revokeCapability).toBeGreaterThan(identityFence);
    for (const mutation of [clearDurable, stashInflight, clearBackend, emitExit]) {
      expect(mutation).toBeGreaterThan(identityFence);
    }
  });

  it('drains a persisted reliable terminal before claiming cli_exit ambiguous', () => {
    const start = workerSource.indexOf('const observedBackend = backend;');
    const end = workerSource.indexOf('\n\n  if (isPipeMode', start);
    const callback = workerSource.slice(start, end);

    const reliable = callback.indexOf('cliAdapter?.reliableTurnTerminal === true');
    const claudeDrain = callback.indexOf('bridgeDrainAndMaybeEmit();', reliable);
    const structuredDrain = callback.indexOf('codexBridgeDrainAndMaybeEmit({ signalIdle: false });', reliable);
    const ambiguous = callback.indexOf("'ambiguous'", reliable);

    expect(reliable).toBeGreaterThanOrEqual(0);
    expect(claudeDrain).toBeGreaterThan(reliable);
    expect(structuredDrain).toBeGreaterThan(claudeDrain);
    expect(ambiguous).toBeGreaterThan(structuredDrain);
  });
});
