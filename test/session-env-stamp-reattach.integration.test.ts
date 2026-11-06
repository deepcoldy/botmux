/**
 * A warm reattach keeps the FIRST launch's env fingerprint stamp: the worker
 * only writes sessions/<id>.env-stamp for a genuinely new CLI process
 * (spawnCli gate `if (!willReattachPersistent)`). A reattached pane still
 * runs the old CLI with the old environment, so re-stamping it with the
 * daemon's newest fingerprint would make the Dashboard drop its "still using
 * the old environment" marker.
 *
 * Uses the same fake-Claude tmux harness as the cold-resume suite: SIGKILL the
 * worker while its managed pane and CLI survive, then attach a new worker
 * that carries a DIFFERENT fingerprint.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  claudeHarnessRunnable as runnable,
  cleanUpClaudeHarnesses,
  promptReadyCount,
  setupFakeClaude as setup,
  type Generation,
  type Harness,
} from './helpers/claude-worker-harness.js';

afterEach(cleanUpClaudeHarnesses);

function stampPath(h: Harness): string {
  return join(h.root, 'data', 'sessions', `${h.sessionId}.env-stamp`);
}

describe.skipIf(!runnable)('session env stamp on a warm tmux reattach', () => {
  it('is written on the fresh launch and NOT overwritten on reattach', async () => {
    const h = setup({ turnMs: 1_000 });
    const first: Generation = h.startWorker({ envFingerprint: 'fp-fresh-launch' });
    await first.waitFor(() => promptReadyCount(first) > 0, 'the fresh CLI to be ready');
    await first.waitFor(
      () => existsSync(stampPath(h)) && readFileSync(stampPath(h), 'utf8') === 'fp-fresh-launch',
      'the fresh-launch fingerprint stamp to be written',
    );

    // SIGKILL the worker (its tmux pane and CLI survive), then attach a new
    // worker handed a NEWER fingerprint. It must reattach, not respawn.
    await first.kill();
    const reattached = h.startWorker({ resume: true, envFingerprint: 'fp-newer-config' });
    await reattached.waitFor(() => promptReadyCount(reattached) > 0, 'the re-attached CLI to be ready');
    expect(
      reattached.logs.some(line => line.includes('Re-attaching to existing tmux session')),
      reattached.logs.join('\n'),
    ).toBe(true);

    // The reattached process still carries the launch-time environment: the
    // stamp from the first launch survives even though init named a newer one.
    await new Promise(resolve => setTimeout(resolve, 1_000));
    expect(readFileSync(stampPath(h), 'utf8')).toBe('fp-fresh-launch');
  }, 90_000);
});
