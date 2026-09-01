import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'bun:test';
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
    const first = upsertConnector(sample(), dir);
    expect(first.createdAt).toBe('2026-05-24T00:00:00.000Z');
    expect(getConnector('conn_test', dir)?.name).toBe('Generic alerts');

    // `updatedAt` is `new Date().toISOString()` — MILLISECOND resolution. Two
    // upserts in the same millisecond legitimately produce the same stamp, so
    // asserting they differ was really asserting "the machine is slow enough".
    // Node happened to always cross a millisecond boundary here; bun does not, and
    // the assertion failed with both values equal. The bug is in the test, not in
    // the store: pin the clock so the two writes are provably in different
    // milliseconds, which is what the assertion means to check.
    const laterMs = Date.parse('2026-05-24T00:00:00.000Z') + 1_000;
    const realNow = Date.now;
    Date.now = () => laterMs;
    let second: ReturnType<typeof upsertConnector>;
    try {
      second = upsertConnector({ ...first, name: 'Renamed' }, dir);
    } finally {
      Date.now = realNow;
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
