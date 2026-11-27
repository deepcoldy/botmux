import { describe, expect, it } from 'vitest';
import { appRunnerSilenceDisposition } from '../src/services/runner-final-outcome.js';
import { BRIDGE_NOTHING_TO_SEND_SENTINEL } from '../src/services/bridge-fallback-gate.js';

/**
 * An app-runner final (codex-app, mir, mira, dsh) that is only the
 * nothing-to-send sentinel must reach the core as positive silence evidence in
 * a native gateway core — otherwise its async result never settles and the
 * gateway polls `running` for ever. Every other process keeps sending no flag.
 */
const base = { finalContent: BRIDGE_NOTHING_TO_SEND_SENTINEL, status: 'completed' as const };

describe('appRunnerSilenceDisposition', () => {
  it('flags a bare sentinel final in a native gateway core', () => {
    expect(appRunnerSilenceDisposition({ ...base, nativeGatewayCore: true })).toBe('nothing_to_send');
    expect(appRunnerSilenceDisposition({ ...base, finalContent: `\n${BRIDGE_NOTHING_TO_SEND_SENTINEL}\n\n`, nativeGatewayCore: true })).toBe('nothing_to_send');
  });

  it('never flags outside a native gateway core', () => {
    for (const finalContent of [BRIDGE_NOTHING_TO_SEND_SENTINEL, '', 'answer']) {
      for (const status of ['completed', 'failed', 'cancelled'] as const) {
        expect(appRunnerSilenceDisposition({ finalContent, status, nativeGatewayCore: false })).toBeUndefined();
      }
    }
  });

  it('a final with an answer, an empty final or an unfinished turn is not silence', () => {
    const native = { ...base, nativeGatewayCore: true };
    expect(appRunnerSilenceDisposition({ ...native, finalContent: `answer\n\n${BRIDGE_NOTHING_TO_SEND_SENTINEL}` })).toBeUndefined();
    expect(appRunnerSilenceDisposition({ ...native, finalContent: '' })).toBeUndefined();
    expect(appRunnerSilenceDisposition({ ...native, status: 'failed' })).toBeUndefined();
    expect(appRunnerSilenceDisposition({ ...native, status: 'cancelled' })).toBeUndefined();
  });
});
