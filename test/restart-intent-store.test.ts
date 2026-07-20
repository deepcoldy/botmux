import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  clearRestartIntentTo,
  writeRestartIntentTo,
  consumeRestartIntentTo,
  bindRestartLeaseTo,
  claimRestartLeaseTo,
  clearRestartLeaseTo,
  hasActiveRestartLeaseTo,
  writeManualIntentIfAbsentTo,
  writeRestartAttemptIntentTo,
  commitRestartIntentAttemptTo,
  claimRestartIntentForReportTo,
  hasPreparedRestartIntentTo,
  removeRestartIntentAttemptTo,
  restartIntentPathIn,
} from '../src/services/restart-intent-store.js';

const T0 = Date.parse('2026-06-07T04:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();

describe('restart-intent store', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'botmux-intent-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('consume returns a fresh intent and deletes the file (one report per restart)', () => {
    writeRestartIntentTo(dir, { kind: 'update', oldVersion: '2.64.0', newVersion: '2.65.0', at: iso(T0) });
    const got = consumeRestartIntentTo(dir, T0 + 5_000);
    expect(got).toMatchObject({ kind: 'update', oldVersion: '2.64.0', newVersion: '2.65.0' });
    expect(existsSync(restartIntentPathIn(dir))).toBe(false);
  });

  it('round-trips a rollback intent with its version delta', () => {
    writeRestartIntentTo(dir, { kind: 'rollback', oldVersion: '3.1.0', newVersion: '3.0.0', at: iso(T0) });
    expect(consumeRestartIntentTo(dir, T0 + 5_000)).toMatchObject({
      kind: 'rollback',
      oldVersion: '3.1.0',
      newVersion: '3.0.0',
    });
  });

  it('clears a rollback intent when restart launch fails', () => {
    writeRestartIntentTo(dir, { kind: 'rollback', oldVersion: '3.1.0', newVersion: '3.0.0', at: iso(T0) });
    clearRestartIntentTo(dir);
    expect(existsSync(restartIntentPathIn(dir))).toBe(false);
    expect(() => clearRestartIntentTo(dir)).not.toThrow();
  });

  it('consume returns null and deletes a stale intent (aborted restart left it behind)', () => {
    writeRestartIntentTo(dir, { kind: 'manual', at: iso(T0) });
    const got = consumeRestartIntentTo(dir, T0 + 11 * 60_000);
    expect(got).toBeNull();
    expect(existsSync(restartIntentPathIn(dir))).toBe(false);
  });

  it('consume returns null when absent (crash / pm2 auto-restart leaves no breadcrumb)', () => {
    expect(consumeRestartIntentTo(dir, T0)).toBeNull();
  });

  it('claims one cross-process restart lease and recovers after expiry or clear', () => {
    const first = claimRestartLeaseTo(dir, T0);
    expect(first).toEqual(expect.any(String));
    expect(hasActiveRestartLeaseTo(dir, T0 + 5_000)).toBe(true);
    expect(claimRestartLeaseTo(dir, T0 + 5_000)).toBeNull();

    const owned = claimRestartLeaseTo(dir, T0 + 61_000);
    expect(owned).toEqual(expect.any(String));
    expect(bindRestartLeaseTo(dir, owned!, process.pid, T0 + 61_000)).toBe(true);
    expect(hasActiveRestartLeaseTo(dir, T0 + 31 * 60_000)).toBe(true);
    clearRestartLeaseTo(dir, 'another-generation');
    expect(hasActiveRestartLeaseTo(dir, T0 + 31 * 60_000)).toBe(true);
    clearRestartLeaseTo(dir, owned!);
    expect(hasActiveRestartLeaseTo(dir, T0 + 31 * 60_000)).toBe(false);

    const dead = claimRestartLeaseTo(dir, T0 + 31 * 60_000);
    expect(bindRestartLeaseTo(dir, dead!, 99_999_999, T0 + 31 * 60_000)).toBe(true);
    expect(hasActiveRestartLeaseTo(dir, T0 + 31 * 60_000)).toBe(false);
  });

  it('writeManualIntentIfAbsent writes a manual intent when none exists', () => {
    writeManualIntentIfAbsentTo(dir, T0, iso(T0));
    expect(consumeRestartIntentTo(dir, T0 + 1_000)).toMatchObject({ kind: 'manual' });
  });

  it('writeManualIntentIfAbsent does NOT clobber an existing fresh richer intent', () => {
    writeRestartIntentTo(dir, { kind: 'update', oldVersion: '1', newVersion: '2', at: iso(T0) });
    writeManualIntentIfAbsentTo(dir, T0 + 1_000, iso(T0 + 1_000));
    expect(consumeRestartIntentTo(dir, T0 + 2_000)).toMatchObject({ kind: 'update' });
  });

  it('writeManualIntentIfAbsent overwrites a stale intent', () => {
    writeRestartIntentTo(dir, { kind: 'update', oldVersion: '1', newVersion: '2', at: iso(T0) });
    writeManualIntentIfAbsentTo(dir, T0 + 11 * 60_000, iso(T0 + 11 * 60_000));
    expect(consumeRestartIntentTo(dir, T0 + 11 * 60_000 + 1_000)).toMatchObject({ kind: 'manual' });
  });

  it('writes atomically (no .tmp leftover)', () => {
    writeRestartIntentTo(dir, { kind: 'manual', at: iso(T0) });
    expect(readdirSync(dir).filter(f => f.endsWith('.tmp'))).toEqual([]);
  });

  it('tolerates corrupt JSON (consume returns null and removes the file)', () => {
    writeFileSync(restartIntentPathIn(dir), '{bad json');
    expect(consumeRestartIntentTo(dir, T0)).toBeNull();
    expect(existsSync(restartIntentPathIn(dir))).toBe(false);
  });

  it('rolls back only the exact failed start attempt and preserves a newer writer', () => {
    writeRestartAttemptIntentTo(
      dir,
      { kind: 'manual', at: iso(T0) },
      T0,
      'attempt-old',
    );
    expect(removeRestartIntentAttemptTo(dir, 'attempt-old')).toBe(true);
    expect(existsSync(restartIntentPathIn(dir))).toBe(true);
    expect(consumeRestartIntentTo(dir, T0 + 500)).toBeNull();

    writeRestartAttemptIntentTo(
      dir,
      { kind: 'manual', at: iso(T0) },
      T0,
      'attempt-old',
    );
    writeRestartIntentTo(dir, {
      kind: 'update', oldVersion: '1', newVersion: '2', at: iso(T0 + 1_000),
    });
    // The newer writer is deferred behind the prepared fence. Aborting the
    // partial start keeps it non-consumable until a later verified restart.
    expect(consumeRestartIntentTo(dir, T0 + 1_500)).toBeNull();
    expect(removeRestartIntentAttemptTo(dir, 'attempt-old')).toBe(true);
    expect(consumeRestartIntentTo(dir, T0 + 2_000)).toBeNull();
    expect(hasPreparedRestartIntentTo(dir, T0 + 2_000)).toBe(false);

    writeRestartAttemptIntentTo(
      dir,
      { kind: 'manual', at: iso(T0 + 2_000) },
      T0 + 2_000,
      'attempt-new',
    );
    expect(commitRestartIntentAttemptTo(dir, 'attempt-new')).toBe(true);
    expect(consumeRestartIntentTo(dir, T0 + 3_000)).toMatchObject({
      kind: 'update', oldVersion: '1', newVersion: '2',
    });
  });

  it('does not expose a prepared restart until the exact attempt commits', () => {
    writeRestartAttemptIntentTo(
      dir,
      { kind: 'manual', at: iso(T0) },
      T0,
      'attempt-verified',
    );
    expect(hasPreparedRestartIntentTo(dir, T0 + 1_000)).toBe(true);
    expect(consumeRestartIntentTo(dir, T0 + 1_000)).toBeNull();
    expect(existsSync(restartIntentPathIn(dir))).toBe(true);

    expect(commitRestartIntentAttemptTo(dir, 'wrong-attempt')).toBe(false);
    expect(commitRestartIntentAttemptTo(dir, 'attempt-verified')).toBe(true);
    expect(hasPreparedRestartIntentTo(dir, T0 + 2_000)).toBe(false);
    expect(consumeRestartIntentTo(dir, T0 + 2_000)).toMatchObject({
      kind: 'manual',
      attemptId: 'attempt-verified',
      attemptState: 'committed',
    });
  });

  it('atomically claims a commit that lands after a prepared observation', () => {
    writeRestartAttemptIntentTo(
      dir,
      { kind: 'manual', at: iso(T0) },
      T0,
      'attempt-racy-commit',
    );
    expect(claimRestartIntentForReportTo(dir, T0 + 1_000)).toEqual({ state: 'prepared' });

    // This is the old consume(prepared)->commit->hasPrepared(false) gap. The
    // next operation now observes+claims committed under one lock.
    expect(commitRestartIntentAttemptTo(dir, 'attempt-racy-commit')).toBe(true);
    expect(claimRestartIntentForReportTo(dir, T0 + 1_001)).toMatchObject({
      state: 'claimed',
      intent: { attemptId: 'attempt-racy-commit', attemptState: 'committed' },
    });
    expect(existsSync(restartIntentPathIn(dir))).toBe(false);
  });

  it('expires an abandoned prepared attempt without ever reporting it', () => {
    writeRestartAttemptIntentTo(
      dir,
      { kind: 'manual', at: iso(T0) },
      T0,
      'attempt-crashed-cli',
    );
    expect(consumeRestartIntentTo(dir, T0 + 11 * 60_000)).toBeNull();
    expect(existsSync(restartIntentPathIn(dir))).toBe(false);
  });
});
