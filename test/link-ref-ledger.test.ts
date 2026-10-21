import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LinkRefLedger } from '../src/services/link-ref-ledger.js';
import { LINK_REF_RETENTION_MS, LinkRefError, type LinkRefCandidate, type LinkRefTurnKey } from '../src/services/link-ref-types.js';

const key: LinkRefTurnKey = { appId: 'app-a', sessionId: 'session-a', turnId: 'turn-a', dispatchAttempt: 1 };
const candidate = (originalUrl: string): LinkRefCandidate => ({ originalUrl, sourceType: 'tool' });

describe('LinkRefLedger', () => {
  let dataDir: string;
  let now: number;
  let sequence: number;
  let ledger: LinkRefLedger;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'botmux-link-ref-ledger-'));
    now = 1_000;
    sequence = 0;
    ledger = new LinkRefLedger(dataDir, {
      now: () => now,
      randomBytes: () => Buffer.alloc(16, ++sequence),
    });
  });

  afterEach(() => {
    ledger.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('creates immutable random refs and reuses byte-identical mappings', () => {
    ledger.openTurn(key);
    const originalUrl = 'https://example.test/p#Frag';
    const first = ledger.registerBatch(key, [candidate(originalUrl)]);
    const second = ledger.registerBatch(key, [candidate(originalUrl)]);

    expect(first.registered[0]?.refId).toMatch(/^lr_[0-9a-f]{32}$/);
    expect(second.registered[0]?.refId).toBe(first.registered[0]?.refId);
    expect(second.deduplicated).toBe(1);
    expect(ledger.resolveBatch(key, [first.registered[0]!.refId]).get(first.registered[0]!.refId)).toBe(originalUrl);
  });

  it('keeps byte-distinct query order, encoding, duplicate params, and fragments separate', () => {
    ledger.openTurn(key);
    const base = 'https://example.test/p';
    const urls = [
      base + '?b=2&a=1&a=',
      base + '?a=1&a=&b=2',
      base + '?a=%2F',
      base + '?a=/',
      base + '?a=1&a=1',
      `${base}#one`,
    ];
    const registered = ledger.registerBatch(key, urls.map(candidate)).registered;

    expect(new Set(registered.map((entry) => entry.refId)).size).toBe(urls.length);
    expect([...ledger.resolveBatch(key, registered.map((entry) => entry.refId)).values()]).toEqual(urls);
  });

  it('preserves mappings after close and reopen', () => {
    ledger.openTurn(key);
    const url = 'https://example.test/p';
    const refId = ledger.registerBatch(key, [candidate(url)]).registered[0]!.refId;
    ledger.close();
    ledger = new LinkRefLedger(dataDir, { now: () => now, randomBytes: () => Buffer.alloc(16, 9) });

    expect(ledger.resolveBatch(key, [refId]).get(refId)).toBe(url);
  });

  it.each([
    [{ ...key, appId: 'app-b' }, 'link_ref_identity_mismatch'],
    [{ ...key, sessionId: 'session-b' }, 'link_ref_identity_mismatch'],
    [{ ...key, turnId: 'turn-b' }, 'link_ref_identity_mismatch'],
    [{ ...key, dispatchAttempt: 2 }, 'link_ref_identity_mismatch'],
  ] as const)('rejects cross-identity resolution with %s', (otherKey, expectedCode) => {
    ledger.openTurn(key);
    const refId = ledger.registerBatch(key, [candidate('https://example.test/p')]).registered[0]!.refId;

    expect(() => ledger.resolveBatch(otherKey, [refId])).toThrowError(expect.objectContaining({ code: expectedCode }));
  });

  it('rejects unknown refs without exposing URL data', () => {
    ledger.openTurn(key);
    expect(() => ledger.resolveBatch(key, ['lr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa']))
      .toThrowError(expect.objectContaining({ code: 'link_ref_unknown' }));
  });

  it('settles turns, preserves reads, and expires them at the exact retention boundary', () => {
    ledger.openTurn(key);
    const url = 'https://example.test/p';
    const refId = ledger.registerBatch(key, [candidate(url)]).registered[0]!.refId;
    now = 2_000;
    ledger.settleTurn(key);

    expect(ledger.readTurn(key)).toEqual(expect.objectContaining({
      state: 'settled',
      settledAtMs: now,
      expiresAtMs: now + LINK_REF_RETENTION_MS,
    }));
    expect(ledger.resolveBatch(key, [refId]).get(refId)).toBe(url);
    expect(() => ledger.registerBatch(key, [candidate('https://example.test/later')]))
      .toThrowError(expect.objectContaining({ code: 'link_ref_turn_not_open' }));
    now += LINK_REF_RETENTION_MS;
    expect(() => ledger.resolveBatch(key, [refId])).toThrowError(expect.objectContaining({ code: 'link_ref_expired' }));
  });

  it('uses dispatch attempt zero as a distinct canonical identity', () => {
    const zero = { appId: 'app', sessionId: 'session', turnId: 'turn' };
    ledger.openTurn(zero);
    const refId = ledger.registerBatch(zero, [candidate('https://example.test/p')]).registered[0]!.refId;

    expect(ledger.readTurn(zero)?.dispatchAttempt).toBe(0);
    expect(() => ledger.resolveBatch({ ...zero, dispatchAttempt: 1 }, [refId]))
      .toThrowError(expect.objectContaining({ code: 'link_ref_identity_mismatch' }));
  });

  it('skips over-limit URLs while retaining earlier registrations and reusable mappings', () => {
    ledger.openTurn(key);
    const urls = Array.from({ length: 128 }, (_, index) => `https://example.test/${index}`);
    const first = ledger.registerBatch(key, urls.map(candidate));
    const later = ledger.registerBatch(key, [candidate(urls[0]!), candidate('https://example.test/overflow')]);

    expect(first.registered).toHaveLength(128);
    expect(later.registered).toHaveLength(1);
    expect(later.registered[0]?.originalUrl).toBe(urls[0]);
    expect(later.deduplicated).toBe(1);
    expect(later.filteredByLimit).toBe(1);
    expect(later.failure).toBe('link_ref_limit_exceeded');
  });

  it('skips a URL whose UTF-8 form exceeds 8 KiB', () => {
    ledger.openTurn(key);
    const tooLarge = `https://example.test/${'中'.repeat(3_000)}`;
    const result = ledger.registerBatch(key, [candidate(tooLarge)]);
    expect(result.registered).toEqual([]);
    expect(result.filteredByLimit).toBe(1);
  });

  it('skips the first distinct URL that exceeds the total 512 KiB capacity', () => {
    ledger.openTurn(key);
    const exactSizeUrl = (index: number) => {
      const prefix = `https://example.test/${index}/`;
      return prefix + 'x'.repeat(8 * 1024 - Buffer.byteLength(prefix));
    };
    const urls = Array.from({ length: 64 }, (_, index) => exactSizeUrl(index));
    expect(ledger.registerBatch(key, urls.map(candidate)).registered).toHaveLength(64);

    const overflow = ledger.registerBatch(key, [candidate('https://example.test/overflow')]);
    expect(overflow.registered).toEqual([]);
    expect(overflow.filteredByLimit).toBe(1);
    expect(overflow.failure).toBe('link_ref_limit_exceeded');
  });

  it('persists and clears pending drafts', () => {
    ledger.openTurn(key);
    ledger.savePendingDraft(key, 'draft {{botmux_link:lr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa}}');
    ledger.close();
    ledger = new LinkRefLedger(dataDir, { now: () => now });

    expect(ledger.readPendingDraft(key)).toContain('draft');
    ledger.clearPendingDraft(key);
    expect(ledger.readPendingDraft(key)).toBeUndefined();
  });

  it('prunes open inactivity and settled retention at exact boundaries', () => {
    const settledKey = { ...key, turnId: 'settled' };
    const openKey = { ...key, turnId: 'open' };
    ledger.openTurn(settledKey);
    ledger.openTurn(openKey);
    ledger.settleTurn(settledKey);

    expect(ledger.pruneExpired(now + LINK_REF_RETENTION_MS - 1)).toEqual({ expired: 0, removed: 0 });
    expect(ledger.pruneExpired(now + LINK_REF_RETENTION_MS)).toEqual({ expired: 1, removed: 2 });
    expect(ledger.readTurn(openKey)).toBeUndefined();
    expect(ledger.readTurn(settledKey)).toBeUndefined();
  });

  it('deletes only the exact app/session scope', () => {
    const appA = { ...key, appId: 'app-a', sessionId: 'shared' };
    const appB = { ...key, appId: 'app-b', sessionId: 'shared' };
    ledger.openTurn(appA);
    ledger.openTurn(appB);

    expect(ledger.deleteSession('app-a', 'shared')).toBe(1);
    expect(ledger.readTurn(appA)).toBeUndefined();
    expect(ledger.readTurn(appB)).toBeDefined();
  });

  it('exports stable typed errors', () => {
    expect(new LinkRefError('link_ref_unknown').code).toBe('link_ref_unknown');
  });
});
