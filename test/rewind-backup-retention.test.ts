/**
 * Retention of the backups left by /rewind and the failed-turn rewind (#3572):
 * backups written by the real cut (context-rewind.ts), in both places a cut
 * puts them — next to the transcript, and the daemon data dir's
 * rewind-backups/<sessionId>/ for a transcript in a CLI-writable tree — then
 * pruned by the real retention module on a real filesystem.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, lstatSync, lutimesSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { rewindClaudeTranscript, scanClaudeTranscriptCheckpoints, withOpenTranscript } from '../src/core/context-rewind.js';
import {
  REWIND_BACKUP_RETENTION,
  parseRewindBackupName,
  pruneRewindBackupDir,
  pruneRewindBackupsBeside,
  rewindBackupDirForSession,
  rewindBackupSuffix,
  registerRewindBackup,
  sweepRewindBackups,
  type RewindBackupKind,
} from '../src/core/rewind-backup-retention.js';

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;
const { minAgeMs, maxAgeMs, maxPerTranscript } = REWIND_BACKUP_RETENTION;
const NOW = Date.UTC(2026, 10, 18, 12, 0, 0);
const TRANSCRIPT = 'session.jsonl';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix = 'botmux-rewind-retention-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

/** A file whose mtime is `mtime` (default: a month before NOW, i.e. old). */
function oldFile(path: string, mtime = NOW - 30 * DAY): string {
  writeFileSync(path, 'x');
  utimesSync(path, mtime / 1000, mtime / 1000);
  return path;
}

/** A backup as a cut at `createdAt` names it, last written then. */
function seedBackup(dir: string, createdAt: number, kind: RewindBackupKind = 'full', transcript = TRANSCRIPT, mtime = createdAt): string {
  return oldFile(join(dir, `${transcript}${rewindBackupSuffix(createdAt, kind)}`), mtime);
}

const line = (record: unknown) => `${JSON.stringify(record)}\n`;
const turns = (n: number) => Array.from({ length: n }, (_, i) =>
  line({ type: 'user', uuid: `u${i}`, message: { role: 'user', content: `第 ${i} 轮` } })
  + line({ type: 'assistant', uuid: `a${i}`, message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } })).join('');

describe('the names a cut gives its backups', () => {
  it('are the ones the retention recognises, with their time and kind, in both places', () => {
    const projectDir = tempDir();
    const transcript = join(projectDir, TRANSCRIPT);
    writeFileSync(transcript, turns(3));
    // /rewind: the whole transcript, next to it.
    const [latest] = scanClaudeTranscriptCheckpoints(transcript, 10);
    const full = rewindClaudeTranscript(transcript, latest!.offset, NOW - 3 * DAY);
    expect(dirname(full.backupPath)).toBe(projectDir);
    expect(parseRewindBackupName(basename(full.backupPath))).toEqual({ transcript: TRANSCRIPT, createdAt: NOW - 3 * DAY, kind: 'full' });

    // Failed-turn rewind of a transcript in a CLI-writable tree: the cut bytes
    // only, in the daemon data dir.
    const dataDir = tempDir();
    const backupDir = rewindBackupDirForSession(dataDir, 'sess-1');
    mkdirSync(backupDir, { recursive: true });
    const removed = withOpenTranscript(transcript, { writableTreeRoot: projectDir, backupDir }, t => {
      const [last] = t.scan(10);
      return t.cut(last!.offset, NOW - 5 * HOUR, { backup: 'removed' });
    });
    expect(dirname(removed.backupPath)).toBe(backupDir);
    expect(parseRewindBackupName(basename(removed.backupPath))).toEqual({ transcript: TRANSCRIPT, createdAt: NOW - 5 * HOUR, kind: 'removed' });
  });

  it('nothing else passes for one', () => {
    for (const name of [
      TRANSCRIPT,
      `${TRANSCRIPT}.botmux-purge-bak-2026-01-01T00-00-00-000Z`,
      `${TRANSCRIPT}.rewind-2026-01-01T00-00-00-000Z.bak.tmp`,
      `${TRANSCRIPT}.rewind-2026-01-01T00-00-00-000Z.removed.bak.orig`,
      `${TRANSCRIPT}.rewind-2026-01-01T00-00-00-000Z.other.bak`,
      `${TRANSCRIPT}.rewind-2026-01-01T00:00:00.000Z.bak`,
      `${TRANSCRIPT}.rewind-garbage.bak`,
      `${TRANSCRIPT}.rewind-2026-13-01T00-00-00-000Z.bak`,
      `${TRANSCRIPT}.rewind-2026-02-30T00-00-00-000Z.bak`,
      'notes.txt.rewind-2026-01-01T00-00-00-000Z.bak',
      '.jsonl.rewind-2026-01-01T00-00-00-000Z.bak',
    ]) expect({ name, parsed: parseRewindBackupName(name) }).toEqual({ name, parsed: undefined });
  });
});

describe('pruneRewindBackupDir', () => {
  it('removes backups past the age limit and keeps the younger ones', async () => {
    const dir = tempDir();
    const expired = [seedBackup(dir, NOW - maxAgeMs - HOUR), seedBackup(dir, NOW - 30 * DAY, 'removed')];
    const kept = [seedBackup(dir, NOW - maxAgeMs + HOUR), seedBackup(dir, NOW - 2 * DAY, 'removed'), seedBackup(dir, NOW - 5 * 60_000)];
    expect((await pruneRewindBackupDir(dir, { now: NOW })).sort()).toEqual(expired.sort());
    for (const path of expired) expect(existsSync(path)).toBe(false);
    for (const path of kept) expect(existsSync(path)).toBe(true);
  });

  it('counts a backup from when it was last written, if that is later than its name says', async () => {
    const dir = tempDir();
    const touched = seedBackup(dir, NOW - 30 * DAY, 'full', TRANSCRIPT, NOW - DAY);
    expect(await pruneRewindBackupDir(dir, { now: NOW })).toEqual([]);
    expect(existsSync(touched)).toBe(true);
  });

  it('keeps the newest backups of each transcript and kind, and removes older ones once past the minimum age', async () => {
    const dir = tempDir();
    const extra = 2;
    // One per hour, from just past the minimum age back.
    const series = (kind: RewindBackupKind, transcript: string) => Array.from({ length: maxPerTranscript + extra },
      (_, i) => seedBackup(dir, NOW - minAgeMs - (i + 1) * HOUR, kind, transcript));
    const removedA = series('removed', TRANSCRIPT);
    const fullA = series('full', TRANSCRIPT);
    const removedB = series('removed', 'other.jsonl');
    const pruned = await pruneRewindBackupDir(dir, { now: NOW });
    // Each group loses exactly its oldest `extra`: a burst of one kind or of
    // one transcript never evicts another's.
    const oldest = (group: string[]) => group.slice(maxPerTranscript);
    expect(pruned.sort()).toEqual([...oldest(removedA), ...oldest(fullA), ...oldest(removedB)].sort());
    for (const group of [removedA, fullA, removedB]) {
      for (const path of group.slice(0, maxPerTranscript)) expect(existsSync(path)).toBe(true);
    }
  });

  it('removes nothing younger than the minimum age, however many there are', async () => {
    const dir = tempDir();
    const burst = Array.from({ length: maxPerTranscript * 2 }, (_, i) =>
      seedBackup(dir, NOW - minAgeMs + (i + 1) * 60_000, 'removed'));
    expect(await pruneRewindBackupDir(dir, { now: NOW })).toEqual([]);
    for (const path of burst) expect(existsSync(path)).toBe(true);
  });

  it('never removes the backup it is told to keep', async () => {
    const dir = tempDir();
    // A clock that went back: the backup just written looks older than all.
    const justWritten = seedBackup(dir, NOW - 30 * DAY, 'removed');
    expect(await pruneRewindBackupDir(dir, { now: NOW, keep: basename(justWritten) })).toEqual([]);
    expect(existsSync(justWritten)).toBe(true);
  });

  it('leaves alone every other file, links named like a backup and what they point to, and subdirectories', async () => {
    const dir = tempDir();
    const outside = tempDir();
    const strangers = [
      TRANSCRIPT,
      `${TRANSCRIPT}.botmux-purge-bak-2026-01-01T00-00-00-000Z`,
      `${TRANSCRIPT}.rewind-2026-01-01T00-00-00-000Z.bak.tmp`,
      `${TRANSCRIPT}.rewind-garbage.bak`,
      `${TRANSCRIPT}.rewind-2026-13-01T00-00-00-000Z.bak`,
      'notes.txt.rewind-2026-01-01T00-00-00-000Z.bak',
      'notes.bak',
    ].map(name => oldFile(join(dir, name)));
    // A link named like an expired backup, to an expired backup elsewhere.
    const target = seedBackup(outside, NOW - 30 * DAY);
    const link = join(dir, `${TRANSCRIPT}${rewindBackupSuffix(NOW - 20 * DAY, 'full')}`);
    symlinkSync(target, link);
    const dangling = join(dir, `${TRANSCRIPT}${rewindBackupSuffix(NOW - 21 * DAY, 'removed')}`);
    symlinkSync(join(outside, 'missing'), dangling);
    // The links themselves as old as their names say.
    for (const path of [link, dangling]) lutimesSync(path, (NOW - 20 * DAY) / 1000, (NOW - 20 * DAY) / 1000);
    // A directory named like a backup, an expired backup inside it.
    const subdir = join(dir, `${TRANSCRIPT}${rewindBackupSuffix(NOW - 22 * DAY, 'full')}`);
    mkdirSync(subdir);
    const nested = seedBackup(subdir, NOW - 30 * DAY);
    const expired = seedBackup(dir, NOW - 30 * DAY);

    expect(await pruneRewindBackupDir(dir, { now: NOW })).toEqual([expired]);
    for (const path of strangers) expect(readFileSync(path, 'utf8')).toBe('x');
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(lstatSync(dangling).isSymbolicLink()).toBe(true);
    expect(existsSync(target)).toBe(true);
    expect(existsSync(nested)).toBe(true);
  });

  it('touches nothing through a backup directory that is a link', async () => {
    const real = tempDir();
    const expired = seedBackup(real, NOW - 30 * DAY);
    const link = join(tempDir(), 'linked');
    symlinkSync(real, link);
    expect(await pruneRewindBackupDir(link, { now: NOW })).toEqual([]);
    expect(existsSync(expired)).toBe(true);
  });

  it('a backup dated ahead of the clock (written while it ran fast) takes no place among the newest and is not removed', async () => {
    const dir = tempDir();
    const ahead = Array.from({ length: maxPerTranscript }, (_, i) => seedBackup(dir, NOW + (30 + i) * DAY, 'removed'));
    const series = Array.from({ length: maxPerTranscript + 2 }, (_, i) => seedBackup(dir, NOW - minAgeMs - (i + 1) * HOUR, 'removed'));
    expect((await pruneRewindBackupDir(dir, { now: NOW })).sort()).toEqual(series.slice(maxPerTranscript).sort());
    for (const path of [...ahead, ...series.slice(0, maxPerTranscript)]) expect(existsSync(path)).toBe(true);
  });

  for (const withoutProc of [false, true]) {
    it(`removes nothing anywhere else when the directory is swapped for a link after it was opened${withoutProc ? ' (no /proc)' : ''}`, async () => {
      const base = tempDir();
      const dir = join(base, 'backups');
      mkdirSync(dir);
      seedBackup(dir, NOW - 30 * DAY);
      // Same names, elsewhere.
      const elsewhere = join(base, 'elsewhere');
      mkdirSync(elsewhere);
      const victim = seedBackup(elsewhere, NOW - 30 * DAY);
      await pruneRewindBackupDir(dir, {
        now: NOW,
        withoutProc,
        beforeRemove: () => {
          renameSync(dir, join(base, 'moved'));
          symlinkSync(elsewhere, dir);
        },
      });
      expect(existsSync(victim)).toBe(true);
    });
  }

  it('a directory that does not exist is nothing to do', async () => {
    expect(await pruneRewindBackupDir(join(tempDir(), 'missing'), { now: NOW })).toEqual([]);
  });
});

describe('sweepRewindBackups', () => {
  it('prunes every session directory under the data dir, and nothing reached through a link or outside it', async () => {
    const dataDir = tempDir();
    const a = rewindBackupDirForSession(dataDir, 'sess-a');
    const b = rewindBackupDirForSession(dataDir, 'sess-b');
    mkdirSync(a, { recursive: true });
    mkdirSync(b, { recursive: true });
    const expired = [seedBackup(a, NOW - 30 * DAY), seedBackup(b, NOW - 8 * DAY, 'removed')];
    const fresh = [seedBackup(a, NOW - DAY), seedBackup(b, NOW - 2 * HOUR, 'removed')];
    // A session entry that is a link to another directory of backups.
    const elsewhere = tempDir();
    const linkedAway = seedBackup(elsewhere, NOW - 30 * DAY);
    symlinkSync(elsewhere, rewindBackupDirForSession(dataDir, 'sess-link'));
    // A backup-named file directly under the root (not in a session's directory)
    // and one beside the root.
    const atRoot = seedBackup(dirname(a), NOW - 30 * DAY);
    const besideRoot = seedBackup(dataDir, NOW - 30 * DAY);

    expect((await sweepRewindBackups(dataDir, { now: NOW })).sort()).toEqual(expired.sort());
    for (const path of fresh) expect(existsSync(path)).toBe(true);
    for (const path of [linkedAway, atRoot, besideRoot]) expect(existsSync(path)).toBe(true);
  });

  it('removes a session directory only once it is empty and has not changed for the age limit', async () => {
    const dataDir = tempDir();
    const dirAt = (sessionId: string, changedAt: number) => {
      const dir = rewindBackupDirForSession(dataDir, sessionId);
      mkdirSync(dir, { recursive: true });
      utimesSync(dir, changedAt / 1000, changedAt / 1000);
      return dir;
    };
    const stale = dirAt('stale', NOW - maxAgeMs - HOUR);
    const recent = dirAt('recent', NOW - DAY);
    const stranger = join(dirAt('stranger', NOW - 30 * DAY), 'notes.txt');
    oldFile(stranger);
    utimesSync(dirname(stranger), (NOW - 30 * DAY) / 1000, (NOW - 30 * DAY) / 1000);
    // Emptied by this round: its directory just changed.
    const emptied = rewindBackupDirForSession(dataDir, 'emptied');
    mkdirSync(emptied, { recursive: true });
    seedBackup(emptied, NOW - 30 * DAY);
    utimesSync(emptied, (NOW - 30 * DAY) / 1000, (NOW - 30 * DAY) / 1000);

    await sweepRewindBackups(dataDir, { now: NOW });
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(recent)).toBe(true);
    expect(existsSync(stranger)).toBe(true);
    expect(readdirSync(emptied)).toEqual([]);
  });

  it('a backup root that is a link, or missing, is left alone', async () => {
    const dataDir = tempDir();
    expect(await sweepRewindBackups(dataDir, { now: NOW })).toEqual([]);
    const elsewhere = tempDir();
    mkdirSync(join(elsewhere, 'sess-a'));
    const expired = seedBackup(join(elsewhere, 'sess-a'), NOW - 30 * DAY);
    symlinkSync(elsewhere, dirname(rewindBackupDirForSession(dataDir, 'sess-a')));
    expect(await sweepRewindBackups(dataDir, { now: NOW })).toEqual([]);
    expect(existsSync(expired)).toBe(true);
  });
});

describe('backups next to a transcript, registered when a cut wrote them', () => {
  /** A transcript's directory with a backup a cut wrote there at `createdAt`, registered. */
  function registeredPlace(dataDir: string, createdAt: number) {
    const dir = tempDir();
    const backup = seedBackup(dir, createdAt);
    registerRewindBackup(backup, dataDir);
    return { dir, backup };
  }
  const markers = (dataDir: string) => {
    try { return readdirSync(join(dataDir, 'rewind-backup-places')); } catch { return []; }
  };
  const ageMarkers = (dataDir: string, at: number) => {
    for (const name of markers(dataDir)) utimesSync(join(dataDir, 'rewind-backup-places', name), at / 1000, at / 1000);
  };

  it('are reached by the periodic sweep even if that directory never sees another cut', async () => {
    const dataDir = tempDir();
    const { dir, backup } = registeredPlace(dataDir, NOW - 3 * DAY);
    const young = seedBackup(dir, NOW - DAY, 'removed');
    const stranger = oldFile(join(dir, TRANSCRIPT));
    expect(await sweepRewindBackups(dataDir, { now: NOW })).toEqual([]);
    // A week later.
    expect(await sweepRewindBackups(dataDir, { now: NOW + 5 * DAY })).toEqual([backup]);
    expect(existsSync(young)).toBe(true);
    expect(existsSync(stranger)).toBe(true);
  });

  it('a directory once registered is let go when it is gone, a link, or holds no backups any more', async () => {
    const dataDir = tempDir();
    const gone = registeredPlace(dataDir, NOW - 3 * DAY);
    rmSync(gone.dir, { recursive: true });
    const linked = registeredPlace(dataDir, NOW - 3 * DAY);
    const target = tempDir();
    const victim = seedBackup(target, NOW - 30 * DAY);
    rmSync(linked.dir, { recursive: true });
    symlinkSync(target, linked.dir);
    const emptied = registeredPlace(dataDir, NOW - 30 * DAY);
    const kept = registeredPlace(dataDir, NOW - DAY);
    ageMarkers(dataDir, NOW - 2 * HOUR);

    await sweepRewindBackups(dataDir, { now: NOW });
    expect(existsSync(emptied.backup)).toBe(false);
    expect(existsSync(victim)).toBe(true);
    // Only the place still holding a backup stays registered.
    expect(markers(dataDir)).toHaveLength(1);
    expect(existsSync(kept.backup)).toBe(true);
    await sweepRewindBackups(dataDir, { now: NOW + 8 * DAY });
    expect(existsSync(kept.backup)).toBe(false);
  });

  it('a place registered again within the hour stays registered though it holds no backups yet', async () => {
    const dataDir = tempDir();
    const { dir, backup } = registeredPlace(dataDir, NOW - 30 * DAY);
    rmSync(backup);
    expect(readdirSync(dir)).toEqual([]);
    await sweepRewindBackups(dataDir, { now: Date.now() });
    expect(markers(dataDir)).toHaveLength(1);
  });

  it('a cut that writes there while the registration is being withdrawn gets it back', async () => {
    const dataDir = tempDir();
    const { dir } = registeredPlace(dataDir, NOW - 30 * DAY);
    ageMarkers(dataDir, NOW - 2 * HOUR);
    let fresh = '';
    await sweepRewindBackups(dataDir, {
      now: NOW,
      // The cut wrote its backup and registered just before the withdrawal.
      afterUnregister: () => { fresh = seedBackup(dir, NOW - 5 * 60_000, 'removed'); },
    });
    expect(markers(dataDir)).toHaveLength(1);
    expect(await sweepRewindBackups(dataDir, { now: NOW + 8 * DAY })).toEqual([fresh]);
  });

  it.skipIf(process.getuid?.() === 0)('a registered directory that cannot be opened stays registered', async () => {
    const dataDir = tempDir();
    const { dir } = registeredPlace(dataDir, NOW - DAY);
    chmodSync(dir, 0o000);
    try {
      await sweepRewindBackups(dataDir, { now: NOW + 30 * DAY });
      expect(markers(dataDir)).toHaveLength(1);
    } finally {
      chmodSync(dir, 0o700);
    }
  });

  it('half-written registrations are cleared after an hour; other files are left alone', async () => {
    const dataDir = tempDir();
    const places = join(dataDir, 'rewind-backup-places');
    mkdirSync(places);
    const hash = 'a'.repeat(64);
    const stale = oldFile(join(places, `${hash}.4242.deadbeef.tmp`), Date.now() - 2 * HOUR);
    const writing = oldFile(join(places, `${hash}.4243.cafebabe.tmp`), Date.now());
    const strangers = [oldFile(join(places, 'notes.txt')), oldFile(join(places, 'other.4242.deadbeef.tmp'))];
    await sweepRewindBackups(dataDir);
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(writing)).toBe(true);
    for (const path of strangers) expect(existsSync(path)).toBe(true);
  });

  it('a registration whose name does not match where it points is not followed, and left alone', async () => {
    const dataDir = tempDir();
    const elsewhere = tempDir();
    const victim = seedBackup(elsewhere, NOW - 30 * DAY);
    mkdirSync(join(dataDir, 'rewind-backup-places'));
    const forged = join(dataDir, 'rewind-backup-places', '0'.repeat(64));
    writeFileSync(forged, elsewhere);
    await sweepRewindBackups(dataDir, { now: NOW });
    expect(existsSync(victim)).toBe(true);
    expect(existsSync(forged)).toBe(true);
  });

  it('backups in the data dir\'s own directories are not registered', () => {
    const dataDir = tempDir();
    const dir = rewindBackupDirForSession(dataDir, 'sess-a');
    mkdirSync(dir, { recursive: true });
    registerRewindBackup(seedBackup(dir, NOW), dataDir);
    expect(markers(dataDir)).toEqual([]);
  });
});

describe('pruneRewindBackupsBeside (after a cut)', () => {
  it('next to the transcript: prunes expired backups, keeps the new one and the transcript, registers the directory', async () => {
    const projectDir = tempDir();
    const dataDir = tempDir();
    const transcript = join(projectDir, TRANSCRIPT);
    writeFileSync(transcript, turns(3));
    const now = Date.now();
    const expired = seedBackup(projectDir, now - 30 * DAY, 'removed');
    const young = seedBackup(projectDir, now - DAY);
    const [latest] = scanClaudeTranscriptCheckpoints(transcript, 10);
    const cut = rewindClaudeTranscript(transcript, latest!.offset);
    const logs: string[] = [];
    await pruneRewindBackupsBeside(cut.backupPath, { dataDir, log: message => logs.push(message) });
    expect(existsSync(expired)).toBe(false);
    expect(readdirSync(projectDir).sort()).toEqual([TRANSCRIPT, basename(young), basename(cut.backupPath)].sort());
    expect(logs).toHaveLength(1);
    const [marker] = readdirSync(join(dataDir, 'rewind-backup-places'));
    expect(readFileSync(join(dataDir, 'rewind-backup-places', marker!), 'utf8')).toBe(resolve(projectDir));
  });

  it('leaves the backup it settles alone, however old it looks', async () => {
    const projectDir = tempDir();
    const transcript = join(projectDir, TRANSCRIPT);
    writeFileSync(transcript, turns(3));
    const [latest] = scanClaudeTranscriptCheckpoints(transcript, 10);
    // Written by a clock that ran far behind: dated, and last written, a month ago.
    const longAgo = Date.now() - 30 * DAY;
    const cut = rewindClaudeTranscript(transcript, latest!.offset, longAgo);
    utimesSync(cut.backupPath, longAgo / 1000, longAgo / 1000);
    await pruneRewindBackupsBeside(cut.backupPath);
    expect(existsSync(cut.backupPath)).toBe(true);
  });

  it('in the daemon data dir: prunes that session\'s directory only', async () => {
    const base = tempDir();
    const tree = join(base, 'tree');
    mkdirSync(tree);
    const transcript = join(tree, TRANSCRIPT);
    writeFileSync(transcript, turns(3));
    const dataDir = join(base, 'data');
    const backupDir = rewindBackupDirForSession(dataDir, 'sess-a');
    const otherSession = rewindBackupDirForSession(dataDir, 'sess-b');
    mkdirSync(backupDir, { recursive: true });
    mkdirSync(otherSession, { recursive: true });
    const now = Date.now();
    const expired = seedBackup(backupDir, now - 30 * DAY, 'removed');
    const otherExpired = seedBackup(otherSession, now - 30 * DAY, 'removed');
    const cut = withOpenTranscript(transcript, { writableTreeRoot: tree, backupDir }, t => {
      const [last] = t.scan(10);
      return t.cut(last!.offset, now, { backup: 'removed' });
    });
    await pruneRewindBackupsBeside(cut.backupPath, { dataDir });
    expect(existsSync(expired)).toBe(false);
    expect(readdirSync(backupDir)).toEqual([basename(cut.backupPath)]);
    expect(existsSync(otherExpired)).toBe(true);
    expect(readdirSync(tree)).toEqual([TRANSCRIPT]);
    expect(existsSync(join(dataDir, 'rewind-backup-places'))).toBe(false);
  });
});
