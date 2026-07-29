import { describe, expect, it } from 'vitest';
import {
  FastModeApplyCancelledError,
  FastModeApplyTransaction,
} from '../src/core/fast-mode-apply-transaction.js';

describe('Fast Mode apply transaction', () => {
  it('rejects a native probe result that arrives after the exact request was cancelled', async () => {
    let resolveProbe!: (serviceTier: string) => void;
    const probe = new Promise<string>(resolve => {
      resolveProbe = resolve;
    });
    const transaction = new FastModeApplyTransaction('req-native-late');

    const guardedProbe = transaction.waitFor(probe);

    expect(transaction.cancel('req-other', 'daemon_timeout')).toBe(false);
    expect(transaction.cancel('req-native-late', 'daemon_timeout')).toBe(true);
    resolveProbe('priority');

    await expect(guardedProbe).rejects.toEqual(
      new FastModeApplyCancelledError('req-native-late', 'daemon_timeout'),
    );
    expect(transaction.signal.aborted).toBe(true);
  });
});
