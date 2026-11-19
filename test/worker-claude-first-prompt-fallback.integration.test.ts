/**
 * A Claude whose prompt never settles on screen — a status clock keeps it busy
 * until the first turn — so the worker finds the prompt only through the
 * first-prompt timeout's screen probe. The turn that follows must still be
 * seen starting and finishing (#2212): the probe's ready used to leave the idle
 * detector's busy edge disarmed, the whole first turn read as idle, and no
 * prompt_ready followed it.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  backgroundTurn,
  claudeHarnessRunnable as runnable,
  cleanUpClaudeHarnesses,
  promptReadyCount,
  setupFakeClaude as setup,
} from './helpers/claude-worker-harness.js';

afterEach(cleanUpClaudeHarnesses);

describe.skipIf(!runnable)('Claude prompt found only by the first-prompt timeout', () => {
  it('the next turns are seen starting and finishing, and their replies are forwarded', async () => {
    const h = setup({ turnMs: 1_000, startupTicker: true });
    const g = h.startWorker();
    await g.waitFor(() => promptReadyCount(g) > 0, 'the first-prompt timeout to find the prompt');
    // The scenario holds only if that ready came from the fallback probe.
    expect(g.logs.join('')).toMatch(/first-prompt-timeout idle probe: busy marker absent/);

    await backgroundTurn(h, g, 'R1 after the fallback ready');
    await backgroundTurn(h, g, 'R2 in steady state');
  }, 150_000);
});
