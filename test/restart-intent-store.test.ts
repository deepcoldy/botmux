import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  writeRestartIntentTo,
  consumeRestartIntentTo,
  writeManualIntentIfAbsentTo,
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

  it('consume returns null and deletes a stale intent (aborted restart left it behind)', () => {
    writeRestartIntentTo(dir, { kind: 'manual', at: iso(T0) });
    const got = consumeRestartIntentTo(dir, T0 + 11 * 60_000);
    expect(got).toBeNull();
    expect(existsSync(restartIntentPathIn(dir))).toBe(false);
  });

  it('consume returns null when absent (crash / pm2 auto-restart leaves no breadcrumb)', () => {
    expect(consumeRestartIntentTo(dir, T0)).toBeNull();
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
});
