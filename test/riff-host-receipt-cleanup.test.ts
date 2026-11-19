import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { sweepOrphanRiffHostReceiptDirs } from '../src/core/riff-host-receipt-cleanup.js';

const roots: string[] = [];
function root(): string {
  const directory = mkdtempSync(join(tmpdir(), 'riff-receipt-cleanup-'));
  roots.push(directory); return directory;
}
function receipt(data: string, session: string, age = 10 * 60_000): string {
  const directory = join(data, 'sessions', session, 'riff-host-operations');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeFileSync(join(directory, 'receipt.json'), 'private reply');
  const time = new Date(Date.now() - age); utimesSync(directory, time, time);
  return directory;
}
afterEach(() => { for (const directory of roots.splice(0)) rmSync(directory, { recursive: true, force: true }); });

describe('Riff receipt lifecycle cleanup', () => {
  it('removes a closed session while preserving every protected session, recent directory and live reference', async () => {
    const data = root(), closed = receipt(data, 'closed'), active = receipt(data, 'active');
    const recent = receipt(data, 'recent', 0), live = receipt(data, 'live');
    const removed = await sweepOrphanRiffHostReceiptDirs(data, new Set(['active']), {
      liveReferences: async () => new Set([live]),
    });
    expect(removed).toEqual([closed]);
    expect(existsSync(closed)).toBe(false);
    for (const kept of [active, recent, live]) expect(existsSync(kept)).toBe(true);
  });

  it('skips plain files beside session directories instead of failing the round', async () => {
    const data = root(), closed = receipt(data, 'closed');
    writeFileSync(join(data, 'sessions', 'closed.env-stamp'), 'stamp');
    const removed = await sweepOrphanRiffHostReceiptDirs(data, new Set(), { liveReferences: async () => new Set() });
    expect(removed).toEqual([closed]);
    expect(existsSync(join(data, 'sessions', 'closed.env-stamp'))).toBe(true);
  });

  it('reclaims every orphan directory when a plain file sits between them', async () => {
    const data = root(), first = receipt(data, 'alpha'), second = receipt(data, 'omega');
    writeFileSync(join(data, 'sessions', 'mid.env-stamp'), 'stamp');
    const removed = await sweepOrphanRiffHostReceiptDirs(data, new Set(), { liveReferences: async () => new Set() });
    expect(removed.sort()).toEqual([first, second].sort());
    expect(existsSync(join(data, 'sessions', 'mid.env-stamp'))).toBe(true);
  });

  it('preserves receipts when live-process evidence is unknown', async () => {
    const data = root(), closed = receipt(data, 'closed');
    expect(await sweepOrphanRiffHostReceiptDirs(data, new Set(), { liveReferences: async () => null })).toEqual([]);
    expect(existsSync(closed)).toBe(true);
  });

  it('does not follow session or receipt directory symlinks', async () => {
    const data = root(), external = root();
    const real = receipt(external, 'outside');
    mkdirSync(join(data, 'sessions', 'linked-receipts'), { recursive: true });
    symlinkSync(real, join(data, 'sessions', 'linked-receipts', 'riff-host-operations'));
    symlinkSync(join(external, 'sessions', 'outside'), join(data, 'sessions', 'linked-session'));
    expect(await sweepOrphanRiffHostReceiptDirs(data, new Set(), { liveReferences: async () => new Set() })).toEqual([]);
    expect(existsSync(real)).toBe(true);
  });

  it('rechecks a parent replaced during the live-process probe', async () => {
    const data = root(), external = root();
    receipt(data, 'closed');
    const moved = join(external, 'moved');
    const removed = await sweepOrphanRiffHostReceiptDirs(data, new Set(), { liveReferences: async () => {
      renameSync(join(data, 'sessions', 'closed'), moved);
      symlinkSync(moved, join(data, 'sessions', 'closed'));
      return new Set();
    } });
    expect(removed).toEqual([]);
    expect(existsSync(join(moved, 'riff-host-operations', 'receipt.json'))).toBe(true);
  });

  it('skips a candidate whose parent became a plain file during the probe and still removes later ones', async () => {
    const data = root(), later = receipt(data, 'b');
    receipt(data, 'a');
    const removed = await sweepOrphanRiffHostReceiptDirs(data, new Set(), { liveReferences: async () => {
      rmSync(join(data, 'sessions', 'a'), { recursive: true, force: true });
      writeFileSync(join(data, 'sessions', 'a'), 'replaced by a file');
      return new Set();
    } });
    expect(existsSync(join(data, 'sessions', 'a'))).toBe(true);
    expect(removed).toEqual([later]);
    expect(existsSync(later)).toBe(false);
  });
});
