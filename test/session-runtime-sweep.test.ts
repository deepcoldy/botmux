import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSessionRuntimeSweeper } from '../src/core/session-runtime-sweep.js';
import { registerRewindBackup, rewindBackupDirForSession, rewindBackupSuffix } from '../src/core/rewind-backup-retention.js';
import { seedPersistedSessionRows } from './helpers/session-store-disk.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function dataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'botmux-runtime-sweep-'));
  roots.push(dir);
  return dir;
}

const row = (sessionId: string, status: 'active' | 'closed') => ({
  sessionId, chatId: 'oc_x', rootMessageId: `om_${sessionId}`, title: sessionId, status,
  createdAt: '2026-10-01T00:00:00.000Z',
});

// The sweeps themselves are stubbed: they default to the real ~/.cache and
// tmpdir() roots, which a test must never touch.
function harness(data: string, own: string[] = []) {
  const sweepScratch = vi.fn(async () => [] as string[]);
  const sweepGateway = vi.fn(async () => [] as string[]);
  const sweepRiffReceipts = vi.fn(async () => [] as string[]);
  const log = { info: vi.fn(), warn: vi.fn() };
  const sweep = createSessionRuntimeSweeper({
    dataDir: data,
    ownActiveSessionIds: () => own,
    liveReferences: async () => new Set(),
    sweepScratch,
    sweepGateway,
    sweepRiffReceipts,
    log,
  });
  return { sweep, sweepScratch, sweepGateway, sweepRiffReceipts, log };
}

describe('session runtime sweep (#1748)', () => {
  it('protects every bot’s active sessions plus this daemon’s unflushed ones', async () => {
    const data = dataDir();
    seedPersistedSessionRows(data, 'appA', { a1: row('a1', 'active'), a2: row('a2', 'closed') });
    seedPersistedSessionRows(data, 'appB', { b1: row('b1', 'active'), b2: row('b2', 'closed') });
    const { sweep, sweepScratch, sweepGateway, sweepRiffReceipts } = harness(data, ['mine-unflushed']);

    await sweep();

    const expected = ['a1', 'b1', 'mine-unflushed'];
    expect([...(sweepScratch.mock.calls[0]?.[1] as Set<string>)].sort()).toEqual(expected);
    expect([...(sweepGateway.mock.calls[0]?.[1] as Set<string>)].sort()).toEqual(expected);
    expect([...(sweepRiffReceipts.mock.calls[0]?.[1] as Set<string>)].sort()).toEqual(expected);
    expect(sweepScratch.mock.calls[0]?.[0]).toBe(data);
  });

  it('skips the whole round when one bot’s store cannot be read', async () => {
    const data = dataDir();
    seedPersistedSessionRows(data, 'appB', { b1: row('b1', 'active') });
    mkdirSync(join(data, 'session-stores', 'appA'), { recursive: true });
    writeFileSync(join(data, 'session-stores', 'appA', 'sessions.db'), 'this is not a database');
    const { sweep, sweepScratch, sweepGateway, sweepRiffReceipts, log } = harness(data);

    await sweep();

    expect(sweepScratch).not.toHaveBeenCalled();
    expect(sweepGateway).not.toHaveBeenCalled();
    expect(sweepRiffReceipts).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  it('never overlaps a round still in flight', async () => {
    const data = dataDir();
    const { sweep, sweepScratch } = harness(data);
    let release!: () => void;
    sweepScratch.mockImplementationOnce(() => new Promise<string[]>(resolve => { release = () => resolve([]); }));

    const first = sweep();
    await vi.waitFor(() => expect(sweepScratch).toHaveBeenCalledTimes(1));
    await sweep();
    expect(sweepScratch).toHaveBeenCalledTimes(1);
    release();
    await first;
    await sweep();
    expect(sweepScratch).toHaveBeenCalledTimes(2);
  });

  describe('rewind backups in the data dir (#3572)', () => {
    const DAY = 24 * 60 * 60_000;
    /** A backup a cut made `ageMs` ago into a session's backup directory. */
    function seedBackup(data: string, sessionId: string, ageMs: number): string {
      const dir = rewindBackupDirForSession(data, sessionId);
      mkdirSync(dir, { recursive: true });
      const at = Date.now() - ageMs;
      const path = join(dir, `native.jsonl${rewindBackupSuffix(at, 'removed')}`);
      writeFileSync(path, 'cut bytes');
      utimesSync(path, at / 1000, at / 1000);
      return path;
    }

    it('removes the expired ones of every session, and next to transcripts where a cut registered them, keeping the young ones', async () => {
      const data = dataDir();
      const expired = [seedBackup(data, 'a1', 30 * DAY), seedBackup(data, 'gone', 8 * DAY)];
      const young = [seedBackup(data, 'a1', 2 * DAY), seedBackup(data, 'gone', 10 * 60_000)];
      // A transcript's own directory, registered by a cut that wrote there.
      const projectDir = dataDir();
      const beside = join(projectDir, `native.jsonl${rewindBackupSuffix(Date.now() - 30 * DAY, 'full')}`);
      writeFileSync(beside, 'whole transcript');
      utimesSync(beside, (Date.now() - 30 * DAY) / 1000, (Date.now() - 30 * DAY) / 1000);
      registerRewindBackup(beside, data);
      expired.push(beside);
      const { sweep, log } = harness(data);

      await sweep();

      for (const path of expired) expect(existsSync(path)).toBe(false);
      for (const path of young) expect(existsSync(path)).toBe(true);
      expect(log.info).toHaveBeenCalledWith(expect.stringMatching(/3 rewind backup/));
    });

    it('still prunes them in a round skipped for want of the active sessions', async () => {
      const data = dataDir();
      mkdirSync(join(data, 'session-stores', 'appA'), { recursive: true });
      writeFileSync(join(data, 'session-stores', 'appA', 'sessions.db'), 'this is not a database');
      const expired = seedBackup(data, 'a1', 30 * DAY);
      const { sweep, sweepScratch } = harness(data);

      await sweep();

      expect(sweepScratch).not.toHaveBeenCalled();
      expect(existsSync(expired)).toBe(false);
    });
  });
});
