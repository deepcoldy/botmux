/**
 * Unit tests for idempotency-store: the at-most-once dispatch lease
 * (reserved → attempting → terminal) with fail-closed I/O, CAS transitions,
 * older-boot takeover, requestHash conflict, and reconcile enumeration.
 *
 * Uses a real temp dir + vi.mock to redirect config.session.dataDir, mirroring
 * async-trigger-store.test.ts.
 *
 * Run:  pnpm vitest run test/idempotency-store.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readdirSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';

let tempDir: string;

vi.mock('../src/config.js', () => ({
  config: { session: { get dataDir() { return tempDir; } } },
}));
vi.mock('../src/utils/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  claim, transition, takeover, lookup, compareAndRemove, listAllForOwner, compareAndRemoveByPath,
  IdempotencyConflictError,
  type IdempotencyRecord,
} from '../src/services/idempotency-store.js';

const base = (over: Partial<Parameters<typeof claim>[0]> = {}) => ({
  ownerLarkAppId: 'cli_a', sessionId: 'sess-1', triggerId: 'trg_1',
  requestHash: 'sha256:h1', ownerBootId: 'boot-1', key: 'k1', now: 1000, ...over,
});

beforeEach(() => { tempDir = mkdtempSync(join(tmpdir(), 'idem-store-')); });
afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

describe('claim', () => {
  it('wins a fresh key with a reserved lease', () => {
    const res = claim(base());
    expect(res.kind).toBe('won');
    expect(res.record.state).toBe('reserved');
    expect(res.record.revision).toBe(1);
    expect(lookup('cli_a', 'k1')?.sessionId).toBe('sess-1');
  });

  it('returns existing (same payload) on a second claim — no overwrite', () => {
    claim(base({ sessionId: 'sess-first', triggerId: 'trg_first' }));
    const res = claim(base({ sessionId: 'sess-second', triggerId: 'trg_second', now: 2000 }));
    expect(res.kind).toBe('existing');
    expect(res.record.sessionId).toBe('sess-first');
    expect(res.record.triggerId).toBe('trg_first');
  });

  it('throws IdempotencyConflictError on same key + different requestHash', () => {
    claim(base({ requestHash: 'sha256:AAA' }));
    expect(() => claim(base({ requestHash: 'sha256:BBB' }))).toThrow(IdempotencyConflictError);
  });

  it('cross-owner: same key under two bots are independent', () => {
    claim(base({ ownerLarkAppId: 'cli_a', sessionId: 'sess-a' }));
    claim(base({ ownerLarkAppId: 'cli_b', sessionId: 'sess-b' }));
    expect(lookup('cli_a', 'k1')?.sessionId).toBe('sess-a');
    expect(lookup('cli_b', 'k1')?.sessionId).toBe('sess-b');
  });

  it('FAIL-CLOSED: a corrupt existing record throws (never treated as absent)', () => {
    claim(base());
    // Corrupt the single stored file (now under an owner subdir).
    const idemRoot = join(tempDir, 'idempotency');
    const ownerSub = readdirSync(idemRoot).find(n => !n.endsWith('.json'))!; // sha256(owner) dir
    const files = readdirSync(join(idemRoot, ownerSub)).filter(f => f.endsWith('.json'));
    expect(files.length).toBe(1);
    writeFileSync(join(idemRoot, ownerSub, files[0]), '{ not json', 'utf-8');
    expect(() => claim(base())).toThrow();
    expect(() => lookup('cli_a', 'k1')).toThrow();
  });
});

describe('transition (CAS)', () => {
  it('advances reserved → attempting and bumps revision', () => {
    const { record } = claim(base()) as { record: IdempotencyRecord };
    const next = transition('cli_a', 'k1', record, { state: 'attempting', now: 2000 });
    expect(next.state).toBe('attempting');
    expect(next.revision).toBe(2);
    expect(lookup('cli_a', 'k1')?.state).toBe('attempting');
  });

  it('rejects a stale-revision writer (CAS conflict)', () => {
    const { record } = claim(base()) as { record: IdempotencyRecord };
    transition('cli_a', 'k1', record, { state: 'attempting', now: 2000 }); // rev→2
    // Second writer still holding rev-1 record must fail (no valid re-transition
    // of a stale snapshot; the store has only reserved|attempting).
    expect(() => transition('cli_a', 'k1', record, { state: 'attempting', now: 3000 }))
      .toThrow(/CAS conflict/);
  });
});

describe('takeover (older-boot reserved) — returns won|existing', () => {
  it('WON: replaces an older-boot reserved lease with a fresh one', () => {
    const { record } = claim(base({ ownerBootId: 'boot-OLD' })) as { record: IdempotencyRecord };
    const res = takeover({
      ownerLarkAppId: 'cli_a', key: 'k1', expect: record,
      sessionId: 'sess-NEW', triggerId: 'trg_NEW', requestHash: 'sha256:h1',
      ownerBootId: 'boot-NEW', now: 5000,
    });
    expect(res.kind).toBe('won');
    expect(res.record.sessionId).toBe('sess-NEW');
    expect(res.record.ownerBootId).toBe('boot-NEW');
    expect(res.record.state).toBe('reserved');
    expect(lookup('cli_a', 'k1')?.sessionId).toBe('sess-NEW');
  });

  it('EXISTING: does NOT seize if the lease advanced to attempting under us', () => {
    const { record } = claim(base({ ownerBootId: 'boot-OLD' })) as { record: IdempotencyRecord };
    transition('cli_a', 'k1', record, { state: 'attempting', now: 2000 }); // rev2 attempting
    const res = takeover({
      ownerLarkAppId: 'cli_a', key: 'k1', expect: record, // stale rev1 reserved
      sessionId: 'sess-NEW', triggerId: 'trg_NEW', requestHash: 'sha256:h1', ownerBootId: 'boot-NEW', now: 5000,
    });
    expect(res.kind).toBe('existing');
    expect(res.record.state).toBe('attempting');
    expect(res.record.sessionId).toBe('sess-1'); // original, not seized
  });

  it('EXISTING: a stale rev1 cannot clobber a fresh winner rev1 (the codex race)', () => {
    // old claim → remove → fresh winner claim(rev1); takeover(expect=old rev1) must NOT win.
    const { record: oldRec } = claim(base({ ownerBootId: 'boot-OLD', sessionId: 'sess-OLD' })) as { record: IdempotencyRecord };
    compareAndRemove('cli_a', 'k1', oldRec);
    const { record: freshWinner } = claim(base({ ownerBootId: 'boot-FRESH', sessionId: 'sess-FRESH' })) as { record: IdempotencyRecord };
    expect(freshWinner.revision).toBe(1); // revision restarts from 1
    const res = takeover({
      ownerLarkAppId: 'cli_a', key: 'k1', expect: oldRec, // same rev1, but different identity
      sessionId: 'sess-STALE', triggerId: 'trg_STALE', requestHash: 'sha256:h1', ownerBootId: 'boot-OLD', now: 9000,
    });
    expect(res.kind).toBe('existing');
    expect(lookup('cli_a', 'k1')?.sessionId).toBe('sess-FRESH'); // winner intact
  });

  it('conflict: takeover with a different payload throws', () => {
    const { record } = claim(base({ ownerBootId: 'boot-OLD', requestHash: 'sha256:AAA' })) as { record: IdempotencyRecord };
    expect(() => takeover({
      ownerLarkAppId: 'cli_a', key: 'k1', expect: record,
      sessionId: 'sess-NEW', triggerId: 'trg_NEW', requestHash: 'sha256:BBB', ownerBootId: 'boot-NEW', now: 5000,
    })).toThrow(IdempotencyConflictError);
  });
});

describe('reconcile enumeration (owner-partitioned)', () => {
  it('listAllForOwner returns every stored lease for that owner with its file path', () => {
    claim(base({ key: 'k1', sessionId: 's1' }));
    claim(base({ key: 'k2', sessionId: 's2' }));
    const all = listAllForOwner('cli_a');
    expect(all.length).toBe(2);
    expect(all.map(a => a.record.sessionId).sort()).toEqual(['s1', 's2']);
    expect(all.every(a => a.file.endsWith('.json'))).toBe(true);
  });

  it('listAllForOwner returns ONLY the queried owner (cross-bot partition)', () => {
    claim(base({ ownerLarkAppId: 'cli_a', key: 'k', sessionId: 'sa' }));
    claim(base({ ownerLarkAppId: 'cli_b', key: 'k', sessionId: 'sb' }));
    expect(listAllForOwner('cli_a').map(a => a.record.sessionId)).toEqual(['sa']);
    expect(listAllForOwner('cli_b').map(a => a.record.sessionId)).toEqual(['sb']);
  });

  it('compareAndRemoveByPath drops a lease only if the on-disk record still matches the snapshot', () => {
    claim(base());
    const { file, record } = listAllForOwner('cli_a')[0];
    // Stale snapshot (advanced to attempting under us) → must NOT delete the fence;
    // returns changed(current=the attempting record) so the caller can reclassify.
    transition('cli_a', 'k1', record, { state: 'attempting', now: 5000 }); // rev2 attempting
    const stale = compareAndRemoveByPath(file, record); // record is the rev1 reserved snapshot
    expect(stale.kind).toBe('changed');
    if (stale.kind === 'changed') {
      expect(stale.current.state).toBe('attempting');
      // SAME immutable identity (owner/session/trigger/requestHash/boot), only
      // state+revision advanced → sameIdentity true (a crossed fence I own).
      expect(stale.sameIdentity).toBe(true);
    }
    expect(lookup('cli_a', 'k1')?.state).toBe('attempting'); // fence preserved (codex repro)
    // Exact match → removed.
    const current = lookup('cli_a', 'k1')!;
    expect(compareAndRemoveByPath(file, current).kind).toBe('removed');
    expect(lookup('cli_a', 'k1')).toBeUndefined();
    // Absent now → absent (not an error, not a phantom removed).
    expect(compareAndRemoveByPath(file, current).kind).toBe('absent');
  });

  it('compareAndRemoveByPath: a DIFFERENT-identity winner (takeover) → changed + sameIdentity=false', () => {
    // codex #776 round-6 findings #2/#3: the caller must not mistake a wholly
    // different winner (new session/trigger/boot via takeover) for its own
    // advanced fence. sameIdentity=false is the discriminator.
    const { record: snap } = claim(base({ ownerBootId: 'boot-OLD', sessionId: 'sess-old', triggerId: 'trg-old' })) as { record: IdempotencyRecord };
    const { file } = listAllForOwner('cli_a')[0];
    // Takeover replaces the slot with a new session/trigger/boot (same key+hash).
    takeover({ ownerLarkAppId: 'cli_a', key: 'k1', expect: snap, sessionId: 'sess-new', triggerId: 'trg-new', requestHash: 'sha256:h1', ownerBootId: 'boot-NEW', now: 9000 });
    const res = compareAndRemoveByPath(file, snap); // snap is the OLD reserved identity
    expect(res.kind).toBe('changed');
    if (res.kind === 'changed') {
      expect(res.sameIdentity).toBe(false);       // different winner, not my advance
      expect(res.current.sessionId).toBe('sess-new');
    }
    // The winner is NOT deleted by the stale snapshot's CAS.
    expect(lookup('cli_a', 'k1')?.sessionId).toBe('sess-new');
  });

  it('compareAndRemoveByPath THROWS on a lock-internal corrupt re-read (never folds to a success)', () => {
    claim(base());
    const { file, record } = listAllForOwner('cli_a')[0];
    writeFileSync(file, '{ corrupt after snapshot', 'utf-8'); // corrupted between list and CAS
    expect(() => compareAndRemoveByPath(file, record)).toThrow();
    // The corrupt fence is left intact for the human / next reconcile — not deleted.
    expect(() => lookup('cli_a', 'k1')).toThrow();
  });

  it('listAllForOwner throwOnCorrupt: OWN corrupt lease throws (fail-closed)', () => {
    claim(base({ key: 'good', sessionId: 'sg' }));
    // Drop a corrupt file inside THIS owner's subdir.
    const ownerSub = createHash('sha256').update('cli_a').digest('hex');
    writeFileSync(join(tempDir, 'idempotency', ownerSub, 'deadbeef.json'), '{ corrupt', 'utf-8');
    expect(() => listAllForOwner('cli_a', { throwOnCorrupt: true })).toThrow(/unreadable idempotency lease/);
    // Without throwOnCorrupt it skips + keeps the good one.
    const all = listAllForOwner('cli_a');
    expect(all.map(a => a.record.sessionId)).toEqual(['sg']);
  });

  it('FINDING #4: a FOREIGN owner corrupt lease does NOT block this owner (no cross-bot startup DoS)', () => {
    claim(base({ ownerLarkAppId: 'cli_a', key: 'k', sessionId: 'sa' }));
    // Another bot's corrupt lease lives under ITS OWN owner subdir.
    const foreignSub = createHash('sha256').update('cli_FOREIGN').digest('hex');
    mkdirSync(join(tempDir, 'idempotency', foreignSub), { recursive: true });
    writeFileSync(join(tempDir, 'idempotency', foreignSub, 'garbage.json'), '{ not json', 'utf-8');
    // cli_a's owner-scoped strict enumeration never even opens the foreign subdir.
    expect(() => listAllForOwner('cli_a', { throwOnCorrupt: true })).not.toThrow();
    expect(listAllForOwner('cli_a', { throwOnCorrupt: true }).map(a => a.record.sessionId)).toEqual(['sa']);
  });
});

describe('compareAndRemove + weird keys', () => {
  it('compareAndRemove deletes only the exact expected lease; idempotent (discriminated result)', () => {
    const { record } = claim(base()) as { record: IdempotencyRecord };
    // Stale expectation (wrong revision) → changed (on-disk still the rev1 reserved).
    const stale = compareAndRemove('cli_a', 'k1', { ...record, revision: 99 });
    expect(stale.kind).toBe('changed');
    // Same immutable identity, only the (stale) revision differs → sameIdentity true.
    if (stale.kind === 'changed') expect(stale.sameIdentity).toBe(true);
    expect(lookup('cli_a', 'k1')).toBeDefined();
    // Exact match → removed.
    expect(compareAndRemove('cli_a', 'k1', record).kind).toBe('removed');
    expect(lookup('cli_a', 'k1')).toBeUndefined();
    expect(compareAndRemove('cli_a', 'k1', record).kind).toBe('absent'); // already gone
  });

  it('tolerates path-traversal / NUL key bytes via hashed filename', () => {
    const nasty = '../../etc/passwd\0/x';
    claim(base({ key: nasty, sessionId: 'sn' }));
    expect(lookup('cli_a', nasty)?.sessionId).toBe('sn');
  });
});
