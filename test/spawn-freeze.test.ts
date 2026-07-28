import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  activeSpawnFreezeFor,
  clearSpawnFreeze,
  deferSpawnDuringFreeze,
  deferredSpawnCount,
  forgetDeferredSpawn,
  readActiveSpawnFreeze,
  resetSpawnFreezeStateForTest,
  shouldAnnounceSpawnFreeze,
  SPAWN_FREEZE_FILENAME,
  SPAWN_FREEZE_HARD_CAP_MS,
  spawnFreezeApplies,
  writeSpawnFreeze,
  type SpawnFreezeDeclaration,
} from '../src/core/spawn-freeze.js';

const NOW = 1_000_000_000_000;
const dirs: string[] = [];

function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'spawn-freeze-'));
  dirs.push(dir);
  return dir;
}

function deps(dir: string, now = NOW, processAlive: (pid: number) => boolean = () => true) {
  return { dataDir: () => dir, now: () => now, processAlive, pollMs: POLL_MS };
}

/** The replay path is `setInterval` → `setImmediate`; both are real timers here
 *  (a fake clock does not drive the immediate), so tests just wait a few of the
 *  injected poll intervals. */
const POLL_MS = 5;
const waitForPolls = (n = 3): Promise<void> => new Promise(r => setTimeout(r, POLL_MS * n));

/** Write raw content (possibly invalid) plus an explicit mtime. */
function writeRaw(dir: string, body: string, mtimeMs = NOW): void {
  const path = join(dir, SPAWN_FREEZE_FILENAME);
  writeFileSync(path, body);
  utimesSync(path, new Date(mtimeMs), new Date(mtimeMs));
}

function writeDeclaration(dir: string, declaration: SpawnFreezeDeclaration, mtimeMs = NOW): void {
  writeSpawnFreeze(declaration, deps(dir));
  const path = join(dir, SPAWN_FREEZE_FILENAME);
  utimesSync(path, new Date(mtimeMs), new Date(mtimeMs));
}

afterEach(() => {
  resetSpawnFreezeStateForTest();
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe('spawn freeze declaration', () => {
  it('applies while the deadline is in the future and lifts once it passes', () => {
    const dir = freshDir();
    writeDeclaration(dir, { reason: 'cred-refresh', deadline: NOW + 60_000 });
    expect(readActiveSpawnFreeze(deps(dir))).toMatchObject({
      reason: 'cred-refresh',
      effectiveUntil: NOW + 60_000,
      notify: false,
    });
    expect(readActiveSpawnFreeze(deps(dir, NOW + 60_001))).toBeNull();
  });

  it('lifts as soon as the declaring process is gone, long before the deadline', () => {
    const dir = freshDir();
    writeDeclaration(dir, { reason: 'claude-update', deadline: NOW + 300_000, pid: 4242 });
    expect(readActiveSpawnFreeze(deps(dir))).toMatchObject({ declaredByPid: 4242 });
    expect(readActiveSpawnFreeze(deps(dir, NOW, () => false))).toBeNull();
  });

  it('treats EPERM from the liveness probe as alive, not as a dead declarer', () => {
    const dir = freshDir();
    writeDeclaration(dir, { reason: 'cred-refresh', deadline: NOW + 60_000, pid: 1 });
    const eperm = (pid: number): boolean => {
      // Mirrors the production probe: process.kill(pid, 0) throwing EPERM means
      // the process exists but belongs to somebody else.
      expect(pid).toBe(1);
      const error = Object.assign(new Error('EPERM'), { code: 'EPERM' });
      try { throw error; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
    };
    expect(readActiveSpawnFreeze(deps(dir, NOW, eperm))).not.toBeNull();
  });

  it('caps an over-long declaration at the hard cap measured from mtime', () => {
    const dir = freshDir();
    // A declaration asking for a year, written 11 minutes ago: the cap has
    // already elapsed even though the deadline is far away.
    writeDeclaration(dir, { reason: 'oops', deadline: NOW + 365 * 24 * 3_600_000 }, NOW - 11 * 60_000);
    expect(readActiveSpawnFreeze(deps(dir))).toBeNull();
    // Same declaration written just now: capped, but still in effect.
    writeDeclaration(dir, { reason: 'oops', deadline: NOW + 365 * 24 * 3_600_000 }, NOW);
    expect(readActiveSpawnFreeze(deps(dir))).toMatchObject({
      effectiveUntil: NOW + SPAWN_FREEZE_HARD_CAP_MS,
    });
  });

  it.each([
    ['missing file', null],
    ['not json', 'definitely not json'],
    ['array', '[]'],
    ['no reason', JSON.stringify({ deadline: NOW + 60_000 })],
    ['blank reason', JSON.stringify({ reason: '   ', deadline: NOW + 60_000 })],
    ['reason too long', JSON.stringify({ reason: 'x'.repeat(121), deadline: NOW + 60_000 })],
    ['no deadline', JSON.stringify({ reason: 'x' })],
    ['deadline not a number', JSON.stringify({ reason: 'x', deadline: '999' })],
    ['fractional deadline', JSON.stringify({ reason: 'x', deadline: NOW + 0.5 })],
    ['negative pid', JSON.stringify({ reason: 'x', deadline: NOW + 60_000, pid: -1 })],
    ['notify not boolean', JSON.stringify({ reason: 'x', deadline: NOW + 60_000, notify: 'yes' })],
    ['scope not object', JSON.stringify({ reason: 'x', deadline: NOW + 60_000, scope: [] })],
    ['scope entry not string', JSON.stringify({ reason: 'x', deadline: NOW + 60_000, scope: { larkAppIds: [1] } })],
    ['oversized file', JSON.stringify({ reason: 'x'.repeat(100), deadline: NOW + 60_000, pad: 'p'.repeat(9000) })],
  ])('fails open on %s', (_label, body) => {
    const dir = freshDir();
    if (body !== null) writeRaw(dir, body);
    expect(readActiveSpawnFreeze(deps(dir))).toBeNull();
  });

  it('scopes to the declared bots, and an empty scope means fleet-wide', () => {
    const dir = freshDir();
    writeDeclaration(dir, { reason: 'rebuild', deadline: NOW + 60_000, scope: { larkAppIds: ['cli_a'] } });
    const scoped = readActiveSpawnFreeze(deps(dir))!;
    expect(spawnFreezeApplies(scoped, 'cli_a')).toBe(true);
    expect(spawnFreezeApplies(scoped, 'cli_b')).toBe(false);
    // A session with no known bot is never covered by a scoped freeze — it
    // cannot be proven in scope, and over-freezing is the worse failure.
    expect(spawnFreezeApplies(scoped, undefined)).toBe(false);
    expect(activeSpawnFreezeFor('cli_b', deps(dir))).toBeNull();

    writeDeclaration(dir, { reason: 'fleet', deadline: NOW + 60_000, scope: { larkAppIds: [] } });
    const fleet = readActiveSpawnFreeze(deps(dir))!;
    expect(fleet.larkAppIds).toBeUndefined();
    expect(spawnFreezeApplies(fleet, undefined)).toBe(true);
  });

  it('clears idempotently', () => {
    const dir = freshDir();
    writeDeclaration(dir, { reason: 'cred-refresh', deadline: NOW + 60_000 });
    expect(clearSpawnFreeze(deps(dir))).toBe(true);
    expect(clearSpawnFreeze(deps(dir))).toBe(false);
    expect(readActiveSpawnFreeze(deps(dir))).toBeNull();
  });
});

describe('deferred spawns', () => {
  it('queues only the first spawn per session and replays it on release', async () => {
    const dir = freshDir();
    writeDeclaration(dir, { reason: 'cred-refresh', deadline: NOW + 60_000 });
    const d = deps(dir);

    const replays: string[] = [];
    expect(deferSpawnDuringFreeze({ sessionId: 's1', replay: () => replays.push('first') }, d)).not.toBeNull();
    // A second turn for the same session must NOT queue a second fork: replaying
    // two forks would kill and replace the first new worker.
    expect(deferSpawnDuringFreeze({ sessionId: 's1', replay: () => replays.push('second') }, d)).not.toBeNull();
    expect(deferSpawnDuringFreeze({ sessionId: 's2', replay: () => replays.push('other') }, d)).not.toBeNull();
    expect(deferredSpawnCount()).toBe(2);
    expect(replays).toEqual([]);

    // Still frozen → the poll must not release anything.
    await waitForPolls();
    expect(replays).toEqual([]);

    clearSpawnFreeze(d);
    await waitForPolls();
    expect(replays.sort()).toEqual(['first', 'other']);
    expect(deferredSpawnCount()).toBe(0);
  });

  it('releases each session against its own scope', async () => {
    const dir = freshDir();
    writeDeclaration(dir, { reason: 'rebuild', deadline: NOW + 60_000, scope: { larkAppIds: ['cli_a'] } });
    const d = deps(dir);

    const replays: string[] = [];
    expect(deferSpawnDuringFreeze({ sessionId: 's1', larkAppId: 'cli_a', replay: () => replays.push('a') }, d)).not.toBeNull();
    // Out of scope: never deferred in the first place.
    expect(deferSpawnDuringFreeze({ sessionId: 's2', larkAppId: 'cli_b', replay: () => replays.push('b') }, d)).toBeNull();
    expect(deferredSpawnCount()).toBe(1);

    clearSpawnFreeze(d);
    await waitForPolls();
    expect(replays).toEqual(['a']);
  });

  it('drops a parked spawn when its session is closed', async () => {
    const dir = freshDir();
    writeDeclaration(dir, { reason: 'cred-refresh', deadline: NOW + 60_000 });
    const d = deps(dir);

    const replays: string[] = [];
    deferSpawnDuringFreeze({ sessionId: 's1', replay: () => replays.push('s1') }, d);
    forgetDeferredSpawn('s1');
    expect(deferredSpawnCount()).toBe(0);

    clearSpawnFreeze(d);
    await waitForPolls();
    expect(replays).toEqual([]);
  });

  it('replays when the deadline passes even if nobody releases the freeze', async () => {
    const dir = freshDir();
    writeDeclaration(dir, { reason: 'crashed-script', deadline: NOW + 2_000 });
    let now = NOW;
    const d = { dataDir: () => dir, now: () => now, processAlive: () => true, pollMs: POLL_MS };

    const replays: string[] = [];
    expect(deferSpawnDuringFreeze({ sessionId: 's1', replay: () => replays.push('s1') }, d)).not.toBeNull();

    now = NOW + 2_001;
    await waitForPolls();
    expect(replays).toEqual(['s1']);
  });
});

describe('freeze announcements', () => {
  it('announces once per chat per declaration, and stays silent without notify', () => {
    const dir = freshDir();
    writeDeclaration(dir, { reason: 'claude-update', deadline: NOW + 300_000, notify: true });
    const first = readActiveSpawnFreeze(deps(dir))!;
    expect(shouldAnnounceSpawnFreeze(first, 'chat-1')).toBe(true);
    expect(shouldAnnounceSpawnFreeze(first, 'chat-1')).toBe(false);
    expect(shouldAnnounceSpawnFreeze(first, 'chat-2')).toBe(true);

    // A NEW declaration is a new window: the same chat is told again.
    writeDeclaration(dir, { reason: 'claude-update', deadline: NOW + 400_000, notify: true });
    const second = readActiveSpawnFreeze(deps(dir))!;
    expect(second.freezeId).not.toBe(first.freezeId);
    expect(shouldAnnounceSpawnFreeze(second, 'chat-1')).toBe(true);

    writeDeclaration(dir, { reason: 'quiet', deadline: NOW + 60_000 });
    const quiet = readActiveSpawnFreeze(deps(dir))!;
    expect(shouldAnnounceSpawnFreeze(quiet, 'chat-1')).toBe(false);
  });
});
