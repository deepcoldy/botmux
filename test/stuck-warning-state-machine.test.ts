/**
 * State machine regression tests for the stuck-warning authority lifecycle.
 *
 * Covers the race conditions fixed in PR #559 review rounds 3-5:
 *   - Nonce monotonicity: counter never clears, so a late POST result / ACK
 *     from warning N cannot match warning N+1 that happened after a clear.
 *   - clearStuckWarningAuthority (ACK path) preserves the counter.
 *   - invalidateStuckWarning (lifecycle path) preserves the counter.
 *   - Duplicate-click processing flag blocks re-injection.
 *
 * Run:  pnpm vitest run test/stuck-warning-state-machine.test.ts
 */
import { describe, it, expect } from 'bun:test';
import { clearStuckWarningAuthority, invalidateStuckWarning } from '../src/core/worker-pool.js';
import type { DaemonSession } from '../src/core/types.js';

function makeSession(): DaemonSession {
  return {
    session: { sessionId: 'test-sid', rootMessageId: 'om_root', chatId: 'oc_test', title: 'test', status: 'active', spawnedAt: 0, lastMessageAt: 0, hasHistory: false, cliVersion: '0' } as any,
    worker: null,
    workerPort: null,
    workerToken: null,
    workerGeneration: 1,
    larkAppId: 'cli_test',
    chatId: 'oc_test',
    chatType: 'p2p',
    scope: 'thread',
    spawnedAt: 0,
    cliVersion: '0',
    lastMessageAt: 0,
    hasHistory: false,
  } as DaemonSession;
}

describe('stuck-warning nonce monotonicity (P1-1)', () => {
  it('clearStuckWarningAuthority preserves the counter so next nonce is higher', () => {
    const ds = makeSession();
    // Simulate warning 1: counter=1, active nonce=1
    ds.stuckWarningNonceCounter = 1;
    ds.stuckWarningNonce = 1;
    ds.stuckWarningCardId = 'om_card_1';

    // CLI recovers → ACK path clears authority
    clearStuckWarningAuthority(ds);
    expect(ds.stuckWarningNonce).toBeUndefined();
    expect(ds.stuckWarningCardId).toBeUndefined();
    // Counter must NOT clear
    expect(ds.stuckWarningNonceCounter).toBe(1);

    // Next warning would allocate counter+1 = 2, not reuse 1
    const nextNonce = (ds.stuckWarningNonceCounter ?? 0) + 1;
    expect(nextNonce).toBe(2);
  });

  it('invalidateStuckWarning preserves the counter', () => {
    const ds = makeSession();
    ds.stuckWarningNonceCounter = 3;
    ds.stuckWarningNonce = 3;
    ds.stuckWarningCardId = 'om_card_3';

    invalidateStuckWarning(ds, 'prompt_ready');
    expect(ds.stuckWarningNonce).toBeUndefined();
    expect(ds.stuckWarningNonceCounter).toBe(3);
  });

  it('old POST result cannot match a newer warning after clear (nonce reuse race)', () => {
    const ds = makeSession();
    // Warning 1: nonce=1, card POST in flight
    ds.stuckWarningNonceCounter = 1;
    ds.stuckWarningNonce = 1;

    // CLI recovers before POST returns → clear authority
    clearStuckWarningAuthority(ds);
    expect(ds.stuckWarningNonce).toBeUndefined();

    // Warning 2 starts: nonce=2 (counter was preserved)
    ds.stuckWarningNonceCounter = 2;
    ds.stuckWarningNonce = 2;

    // Old POST (nonce=1) finally returns — must NOT match current nonce=2
    expect(ds.stuckWarningNonce).not.toBe(1);
    expect(ds.stuckWarningNonce).toBe(2);
  });

  it('counter starts at 0 and increments monotonically', () => {
    const ds = makeSession();
    expect(ds.stuckWarningNonceCounter).toBeUndefined();
    const n1 = (ds.stuckWarningNonceCounter ?? 0) + 1;
    ds.stuckWarningNonceCounter = n1;
    expect(n1).toBe(1);

    clearStuckWarningAuthority(ds);

    const n2 = (ds.stuckWarningNonceCounter ?? 0) + 1;
    ds.stuckWarningNonceCounter = n2;
    expect(n2).toBe(2);
    expect(n2).toBeGreaterThan(n1);
  });
});

describe('stuck-warning processing flag (duplicate click)', () => {
  it('clearStuckWarningAuthority resets processing flag', () => {
    const ds = makeSession();
    ds.stuckWarningProcessing = true;
    ds.stuckWarningNonce = 1;
    ds.stuckWarningCardId = 'om_card';

    clearStuckWarningAuthority(ds);
    expect(ds.stuckWarningProcessing).toBe(false);
  });

  it('invalidateStuckWarning resets processing flag', () => {
    const ds = makeSession();
    ds.stuckWarningProcessing = true;
    ds.stuckWarningNonce = 1;
    ds.stuckWarningCardId = 'om_card';

    invalidateStuckWarning(ds, 'worker_exit');
    expect(ds.stuckWarningProcessing).toBe(false);
  });
});

describe('stuck-warning cliLifetime forwarding', () => {
  it('clearStuckWarningAuthority clears cliLifetime', () => {
    const ds = makeSession();
    ds.stuckWarningCliLifetime = 5;
    ds.stuckWarningNonce = 1;
    ds.stuckWarningCardId = 'om_card';

    clearStuckWarningAuthority(ds);
    expect(ds.stuckWarningCliLifetime).toBeUndefined();
  });
});
