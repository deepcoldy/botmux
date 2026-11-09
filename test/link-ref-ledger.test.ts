import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LinkRefLedger } from '../src/services/link-ref-ledger.js';
import { resolveOutboundLinkRefs } from '../src/services/link-ref-resolver.js';
import { openDatabaseSyncOrThrow } from '../src/services/sqlite-compat.js';
import { LINK_REF_MAX_URLS_PER_TURN, LINK_REF_RETENTION_MS, LinkRefError, type LinkRefCandidate, type LinkRefTurnKey } from '../src/services/link-ref-types.js';

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
      randomBytes: () => { const bytes = Buffer.alloc(16); bytes.writeUInt32BE(++sequence); return bytes; },
    });
  });

  afterEach(() => {
    ledger.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('preserves a registration-limit refusal across reopening, later successful writes, and settlement', () => {
    ledger.openTurn(key);
    const original = 'https://example.test/problem?id=1';
    const omitted = `https://example.test/problem?id=2&padding=${'x'.repeat(8 * 1024)}`;
    ledger.registerBatch(key, [candidate(original), candidate(omitted)]);
    ledger.registerBatch(key, [candidate('https://example.test/problem?id=3')]);
    ledger.close();
    ledger = new LinkRefLedger(dataDir, { now: () => now });
    ledger.settleTurn(key);

    expect(() => resolveOutboundLinkRefs(ledger, key, { text: omitted }, 'final'))
      .toThrowError(expect.objectContaining({ code: 'link_ref_limit_exceeded' }));
    expect(resolveOutboundLinkRefs(ledger, key, { text: original }, 'final').text).toBe(original);
    expect(ledger.readTurn(key)).toEqual(expect.objectContaining({ registrationLimited: true, state: 'settled' }));
  });

  it('refuses URL finals when every source exceeded registration capacity but permits a plain error report', () => {
    ledger.openTurn(key);
    const omitted = `https://example.test/problem?padding=${'x'.repeat(9_000)}`;
    ledger.registerBatch(key, [candidate(omitted)]);

    expect(() => resolveOutboundLinkRefs(ledger, key, { text: omitted }, 'final'))
      .toThrowError(expect.objectContaining({ code: 'link_ref_limit_exceeded' }));
    expect(resolveOutboundLinkRefs(ledger, key, { text: '查询结果超过链接校验容量' }, 'final').text)
      .toBe('查询结果超过链接校验容量');
  });

  it('rejects unregistered endpoints after overflow while preserving exact registered finals', () => {
    ledger.openTurn(key);
    const original = 'https://ops.example.test/help?id=1';
    const omitted = `https://detail.example.test/problem?id=2&padding=${'x'.repeat(9_000)}`;
    ledger.registerBatch(key, [candidate(original), candidate(omitted)]);

    for (const text of [omitted, 'https://detail.example.test/problem?id=999']) {
      expect(() => resolveOutboundLinkRefs(ledger, key, { text }, 'final'))
        .toThrowError(expect.objectContaining({ code: 'link_ref_limit_exceeded' }));
    }
    expect(resolveOutboundLinkRefs(ledger, key, { text: original }, 'final').text).toBe(original);
  });

  it('migrates a legacy ledger without resetting its existing turn or losing overflow evidence', () => {
    const legacy = join(dataDir, 'legacy');
    mkdirSync(join(legacy, 'link-refs'), { recursive: true });
    const db = openDatabaseSyncOrThrow(join(legacy, 'link-refs', 'link-refs.sqlite'));
    db.exec(`CREATE TABLE link_ref_turns (
      app_id TEXT NOT NULL, session_id TEXT NOT NULL, turn_id TEXT NOT NULL,
      dispatch_attempt INTEGER NOT NULL, mode TEXT NOT NULL, state TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL, last_activity_at_ms INTEGER NOT NULL,
      settled_at_ms INTEGER, expires_at_ms INTEGER NOT NULL, total_url_bytes INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(app_id, session_id, turn_id, dispatch_attempt)
    )`);
    db.prepare(`INSERT INTO link_ref_turns VALUES (?, ?, ?, ?, 'enabled', 'open', 100, 100, NULL, ?, 0)`)
      .run(key.appId, key.sessionId, key.turnId, key.dispatchAttempt!, now + LINK_REF_RETENTION_MS);
    db.close();
    ledger.close();
    ledger = new LinkRefLedger(legacy, { now: () => now });
    const original = 'https://example.test/legacy?id=1';
    ledger.registerBatch(key, [candidate(original), candidate(`https://example.test/legacy?padding=${'x'.repeat(9_000)}`)]);

    expect(ledger.readTurn(key)).toEqual(expect.objectContaining({ createdAtMs: 100, registrationLimited: true }));
    expect(resolveOutboundLinkRefs(ledger, key, { text: original }, 'final').text).toBe(original);
    ledger.close();
    ledger = new LinkRefLedger(legacy, { now: () => now });
    expect(ledger.listRegistered(key).map(entry => entry.originalUrl)).toEqual([original]);
    expect(ledger.readTurn(key)).toEqual(expect.objectContaining({ registrationLimited: true }));
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

  it('lists only byte-identical URLs registered for the exact turn identity', () => {
    const other = { ...key, turnId: 'turn-b' };
    ledger.openTurn(key);
    ledger.openTurn(other);
    ledger.registerBatch(key, [candidate('https://example.test/p')]);
    ledger.registerBatch(other, [candidate('https://example.test/other')]);

    expect(ledger.listRegistered(key).map(entry => entry.originalUrl))
      .toEqual(['https://example.test/p']);
    expect(ledger.listRegistered(other).map(entry => entry.originalUrl))
      .toEqual(['https://example.test/other']);
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
    const urls = Array.from({ length: LINK_REF_MAX_URLS_PER_TURN }, (_, index) => `https://example.test/${index}`);
    const first = ledger.registerBatch(key, urls.map(candidate));
    const later = ledger.registerBatch(key, [candidate(urls[0]!), candidate('https://example.test/overflow')]);

    expect(first.registered).toHaveLength(urls.length);
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
