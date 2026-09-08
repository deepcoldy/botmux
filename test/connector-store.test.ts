import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  deleteConnector,
  getConnector,
  listConnectors,
  newConnectorId,
  upsertConnector,
  type ConnectorDefinition,
} from '../src/services/connector-store.js';

function sample(id = 'conn_test'): ConnectorDefinition {
  const now = '2026-05-24T00:00:00.000Z';
  return {
    id,
    name: 'Generic alerts',
    enabled: true,
    verify: {
      type: 'hmac-sha256',
      secretRef: 'whsec_test',
      signatureHeader: 'x-botmux-signature',
      timestampHeader: 'x-botmux-timestamp',
      nonceHeader: 'x-botmux-nonce',
      toleranceSeconds: 300,
    },
    target: { mode: 'dynamic', kind: 'turn', botId: 'app1', allowChats: ['oc_1'] },
    promptEnvelope: {
      sourceName: 'generic',
      headerAllowlist: ['x-event-id'],
      includeRawText: false,
      maxBodyBytes: 262144,
    },
    loggingPolicy: { storePayload: false, storeHeaders: true, retentionDays: 14 },
    lifecycleExtractors: null,
    rateLimit: { windowSeconds: 60, maxRequests: 60 },
    createdAt: now,
    updatedAt: now,
  };
}

describe('connector-store', () => {
  it('upserts, reads, and deletes connector definitions', () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-connectors-'));

    /**
     * Both writes run under a PINNED clock, at two explicitly different instants.
     *
     * `updatedAt` is `new Date().toISOString()` — millisecond resolution. The original
     * test asserted `second.updatedAt !== first.updatedAt` while letting both writes
     * read the real clock, so it was really asserting "this machine is slow enough to
     * cross a millisecond boundary between two calls". Node happened to always win that
     * race; bun does not (measured: 2 failures in 10 runs).
     *
     * ⚠️ Two traps here, both measured rather than assumed:
     *   1. Patching `Date.now` does NOT work — `new Date()` reads the host clock and
     *      never calls it. A previous version of this fix did that and was INERT.
     *   2. Pinning to a SINGLE instant does not work either: both writes would then
     *      get the same stamp and the assertion would fail for the opposite reason.
     * So the clock is advanced explicitly between the two writes, which makes the
     * difference a property of the test rather than of the machine's speed.
     */
    const RealDate = Date;
    let clock = new RealDate('2026-05-24T00:00:00.000Z');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).Date = class extends RealDate {
      constructor(...args: ConstructorParameters<typeof RealDate>) {
        super(...(args.length === 0 ? [clock] : args) as ConstructorParameters<typeof RealDate>);
      }
    };

    let first: ReturnType<typeof upsertConnector>;
    let second: ReturnType<typeof upsertConnector>;
    try {
      first = upsertConnector(sample(), dir);
      expect(first.createdAt).toBe('2026-05-24T00:00:00.000Z');
      expect(getConnector('conn_test', dir)?.name).toBe('Generic alerts');

      clock = new RealDate('2026-05-24T00:00:05.000Z');   // provably a later instant
      second = upsertConnector({ ...first, name: 'Renamed' }, dir);
    } finally {
      (globalThis as any).Date = RealDate;
    }

    expect(second.createdAt).toBe(first.createdAt);
    expect(second.updatedAt).not.toBe(first.updatedAt);
    expect(listConnectors(dir)).toHaveLength(1);
    expect(getConnector('conn_test', dir)?.name).toBe('Renamed');

    expect(deleteConnector('conn_test', dir)).toBe(true);
    expect(deleteConnector('conn_test', dir)).toBe(false);
    expect(listConnectors(dir)).toEqual([]);
  });

  it('persists the public schema without secrets', () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-connectors-'));
    upsertConnector(sample('conn_public'), dir);
    const raw = JSON.parse(readFileSync(join(dir, 'connectors.json'), 'utf-8'));
    expect(raw.version).toBe(1);
    expect(raw.connectors[0].verify.secretRef).toBe('whsec_test');
    expect(JSON.stringify(raw)).not.toContain('plaintext');
  });

  it('mints prefixed connector ids', () => {
    expect(newConnectorId()).toMatch(/^conn_/);
  });
});
