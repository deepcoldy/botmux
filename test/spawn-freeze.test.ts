import { mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  activeSpawnFreezeFor,
  clearSpawnFreeze,
  deferSpawnDuringFreeze,
  SpawnFreezeConflictError,
  deferredSpawnCount,
  forgetDeferredSpawn,
  readActiveSpawnFreeze,
  resetSpawnFreezeStateForTest,
  shouldAnnounceSpawnFreeze,
  SPAWN_FREEZE_FILENAME,
  SPAWN_FREEZE_HARD_CAP_MS,
  SPAWN_FREEZE_MTIME_SKEW_MS,
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
  // force: several tests deliberately replace an in-effect declaration.
  writeSpawnFreeze(declaration, deps(dir), { force: true });
  stampMtime(dir, mtimeMs);
}

/** Write WITHOUT force (the conflict check runs), then normalize mtime: the
 *  harness clock (`NOW`) is far in the past, so a real write time would read as
 *  a future mtime and be refused. */
function writeUnforced(dir: string, declaration: SpawnFreezeDeclaration, mtimeMs = NOW): void {
  writeSpawnFreeze(declaration, deps(dir));
  stampMtime(dir, mtimeMs);
}

function stampMtime(dir: string, mtimeMs: number): void {
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

  it('refuses a future mtime instead of clamping it (a clamp would never expire)', () => {
    const dir = freshDir();
    // `touch -t 2099…` on the declaration would otherwise re-anchor the hard cap
    // on every read — a permanent, un-expiring freeze.
    writeDeclaration(dir, { reason: 'stuck', deadline: Number.MAX_SAFE_INTEGER, pid: 1 },
      NOW + SPAWN_FREEZE_MTIME_SKEW_MS + 1_000);
    expect(readActiveSpawnFreeze(deps(dir))).toBeNull();
    // Inside the skew tolerance it is still honored (clock drift is not an attack).
    writeDeclaration(dir, { reason: 'ok', deadline: NOW + 60_000 }, NOW + 1_000);
    expect(readActiveSpawnFreeze(deps(dir))).not.toBeNull();
  });

  it('refuses a symlinked declaration (it would borrow another file\'s mtime)', () => {
    const dir = freshDir();
    const target = join(dir, 'freeze-target.json');
    writeFileSync(target, JSON.stringify({ reason: 'stuck', deadline: Number.MAX_SAFE_INTEGER, pid: 1 }));
    utimesSync(target, new Date(NOW + 10 * 365 * 24 * 3_600_000), new Date(NOW + 10 * 365 * 24 * 3_600_000));
    symlinkSync(target, join(dir, SPAWN_FREEZE_FILENAME));
    expect(readActiveSpawnFreeze(deps(dir))).toBeNull();
  });

  it('clears idempotently', () => {
    const dir = freshDir();
    writeDeclaration(dir, { reason: 'cred-refresh', deadline: NOW + 60_000 });
    expect(clearSpawnFreeze(deps(dir))).toBe('cleared');
    expect(clearSpawnFreeze(deps(dir))).toBe('absent');
    expect(readActiveSpawnFreeze(deps(dir))).toBeNull();
  });

  it('refuses to clobber an in-effect declaration unless forced', () => {
    const dir = freshDir();
    // Two overlapping maintenance scripts would otherwise disarm each other:
    // the later write erases the earlier scope, the earlier cleanup deletes the
    // later freeze.
    writeDeclaration(dir, { reason: 'first', deadline: NOW + 60_000, pid: 111 });
    expect(() => writeSpawnFreeze({ reason: 'second', deadline: NOW + 60_000 }, deps(dir)))
      .toThrow(SpawnFreezeConflictError);
    expect(readActiveSpawnFreeze(deps(dir))!.reason).toBe('first');
    // --force is the explicit takeover…
    writeDeclaration(dir, { reason: 'second', deadline: NOW + 60_000 });
    expect(readActiveSpawnFreeze(deps(dir))!.reason).toBe('second');
    // …and an EXPIRED declaration is not a conflict at all: an abandoned file
    // must never block the next maintenance window.
    writeDeclaration(dir, { reason: 'stale', deadline: NOW - 1 });
    writeUnforced(dir, { reason: 'third', deadline: NOW + 60_000 });
    expect(readActiveSpawnFreeze(deps(dir))!.reason).toBe('third');
  });

  it('lets the same owner update its own window, and stays atomic against a racer', () => {
    const dir = freshDir();
    writeDeclaration(dir, { reason: 'cred-refresh', deadline: NOW + 60_000, pid: 111 });
    // Extending / amending your own declaration must not require --force.
    writeUnforced(dir, { reason: 'cred-refresh', deadline: NOW + 120_000, pid: 111 });
    expect(readActiveSpawnFreeze(deps(dir))!.deadline).toBe(NOW + 120_000);
    // A different owner is still refused.
    expect(() => writeSpawnFreeze({ reason: 'other', deadline: NOW + 60_000, pid: 222 }, deps(dir)))
      .toThrow(SpawnFreezeConflictError);
    // …and an ownerless declaration is not the same owner as a pid-bearing one.
    expect(() => writeSpawnFreeze({ reason: 'other', deadline: NOW + 60_000 }, deps(dir)))
      .toThrow(SpawnFreezeConflictError);
    // Two ownerless declarations are two owners, not one — otherwise every
    // anonymous writer replaces every other one (10 concurrent writers all won).
    clearSpawnFreeze(deps(dir));
    writeDeclaration(dir, { reason: 'anon-1', deadline: NOW + 60_000 });
    expect(() => writeSpawnFreeze({ reason: 'anon-2', deadline: NOW + 60_000 }, deps(dir)))
      .toThrow(SpawnFreezeConflictError);
    expect(readActiveSpawnFreeze(deps(dir))!.reason).toBe('anon-1');
  });

  it('releases only its own declaration when an owner pid is given', () => {
    const dir = freshDir();
    writeDeclaration(dir, { reason: 'theirs', deadline: NOW + 60_000, pid: 4242 });
    // A script's EXIT trap must not delete somebody else's freeze.
    expect(clearSpawnFreeze(deps(dir), { ownerPid: 777 })).toBe('not_owner');
    expect(readActiveSpawnFreeze(deps(dir))).not.toBeNull();
    expect(clearSpawnFreeze(deps(dir), { ownerPid: 4242 })).toBe('cleared');

    // An owner must still be able to clean up its own EXPIRED declaration.
    writeDeclaration(dir, { reason: 'mine', deadline: NOW - 1, pid: 4242 });
    expect(clearSpawnFreeze(deps(dir), { ownerPid: 4242 })).toBe('cleared');

    // No pid recorded → no ownership claim to respect.
    writeDeclaration(dir, { reason: 'ownerless', deadline: NOW + 60_000 });
    expect(clearSpawnFreeze(deps(dir), { ownerPid: 999 })).toBe('cleared');
  });
});

describe('deferred spawns', () => {
  it('parks the first spawn and FOLDS later turns into it, replaying one merged opening', async () => {
    const dir = freshDir();
    writeDeclaration(dir, { reason: 'cred-refresh', deadline: NOW + 60_000 });
    const d = deps(dir);

    const replays: Array<{ session: string; folded: string[] }> = [];
    const record = (session: string) => (foldedTurns: { content: string }[]) =>
      replays.push({ session, folded: foldedTurns.map(t => t.content) });

    // First turn parks.
    expect(deferSpawnDuringFreeze(
      { sessionId: 's1', hasPayload: true, foldTurn: { content: 'first' }, replay: record('s1') }, d))
      .toMatchObject({ disposition: 'parked' });
    // A second turn for the same session must NOT queue a second fork (replaying
    // two forks would kill and replace the first new worker). Instead it is
    // FOLDED into the parked spawn — retained, not dropped.
    expect(deferSpawnDuringFreeze(
      { sessionId: 's1', hasPayload: true, foldTurn: { content: 'second' }, replay: record('s1-again') }, d))
      .toMatchObject({ disposition: 'folded' });
    // A third turn folds too.
    expect(deferSpawnDuringFreeze(
      { sessionId: 's1', hasPayload: true, foldTurn: { content: 'third' }, replay: record('s1-more') }, d))
      .toMatchObject({ disposition: 'folded' });
    // A different session parks independently.
    expect(deferSpawnDuringFreeze(
      { sessionId: 's2', hasPayload: true, foldTurn: { content: 'other' }, replay: record('s2') }, d))
      .toMatchObject({ disposition: 'parked' });
    // Only two entries — one per session; folds do not add entries.
    expect(deferredSpawnCount()).toBe(2);
    expect(replays).toEqual([]);

    // Still frozen → the poll must not release anything.
    await waitForPolls();
    expect(replays).toEqual([]);

    clearSpawnFreeze(d);
    await waitForPolls();
    expect(deferredSpawnCount()).toBe(0);
    // s1 replayed exactly once (the parked entry), handed the two folded turns
    // in arrival order; s2 replayed with nothing folded.
    const s1 = replays.find(r => r.session === 's1');
    const s2 = replays.find(r => r.session === 's2');
    expect(replays).toHaveLength(2);
    expect(s1?.folded).toEqual(['second', 'third']);
    expect(s2?.folded).toEqual([]);
  });

  it('hands the parked replay the full folded payloads (structured sidecar, not just text)', async () => {
    const dir = freshDir();
    writeDeclaration(dir, { reason: 'cred-refresh', deadline: NOW + 60_000 });
    const d = deps(dir);

    // A codex-app turn carries its user text in codexAppInput.text (which that
    // CLI reads INSTEAD of .content). The fold must keep the whole payload so
    // the sidecar of a later turn is not silently lost.
    let received: Array<{ content: string; codexAppInput?: { text: string } }> = [];
    deferSpawnDuringFreeze(
      { sessionId: 's1', hasPayload: true, foldTurn: { content: 'open', codexAppInput: { text: 'open-text' } },
        replay: (folded) => { received = folded as typeof received; } }, d);
    expect(deferSpawnDuringFreeze(
      { sessionId: 's1', hasPayload: true, foldTurn: { content: 'more', codexAppInput: { text: 'more-text' } },
        replay: () => {} }, d))
      .toMatchObject({ disposition: 'folded' });

    clearSpawnFreeze(d);
    await waitForPolls();
    // The parked replay gets the folded turn's whole payload, sidecar included.
    expect(received).toEqual([{ content: 'more', codexAppInput: { text: 'more-text' } }]);
  });

  it('releases each session against its own scope', async () => {
    const dir = freshDir();
    writeDeclaration(dir, { reason: 'rebuild', deadline: NOW + 60_000, scope: { larkAppIds: ['cli_a'] } });
    const d = deps(dir);

    const replays: string[] = [];
    expect(deferSpawnDuringFreeze({ sessionId: 's1', larkAppId: 'cli_a', hasPayload: true, foldTurn: { content: 'a' }, replay: () => replays.push('a') }, d))
      .toMatchObject({ disposition: 'parked' });
    // Out of scope: never deferred in the first place.
    expect(deferSpawnDuringFreeze({ sessionId: 's2', larkAppId: 'cli_b', hasPayload: true, foldTurn: { content: 'b' }, replay: () => replays.push('b') }, d)).toBeNull();
    expect(deferredSpawnCount()).toBe(1);

    clearSpawnFreeze(d);
    await waitForPolls();
    expect(replays).toEqual(['a']);
  });

  it('lets a real turn supersede a parked promptless spawn, but never the reverse', async () => {
    const dir = freshDir();
    writeDeclaration(dir, { reason: 'claude-update', deadline: NOW + 60_000 });
    const d = deps(dir);

    const replays: Array<{ tag: string; folded: string[] }> = [];
    const record = (tag: string) => (foldedTurns: { content: string }[]) =>
      replays.push({ tag, folded: foldedTurns.map(t => t.content) });
    // A warm-up / re-attach parks (some of those exist so a queued raw command
    // reaches a ready CLI — skipping them outright would strand it)…
    expect(deferSpawnDuringFreeze({ sessionId: 's1', hasPayload: false, replay: record('warmup') }, d))
      .toMatchObject({ disposition: 'parked' });
    // …but the first real turn takes the slot from it (displaces, not folds —
    // the warm-up carried no user content worth keeping).
    expect(deferSpawnDuringFreeze({ sessionId: 's1', hasPayload: true, foldTurn: { content: 'real' }, replay: record('real') }, d))
      .toMatchObject({ disposition: 'superseded' });
    // A later promptless spawn must NOT displace the real turn, and folds
    // nothing — it just waits on what is parked (no notice for a warm-up).
    expect(deferSpawnDuringFreeze({ sessionId: 's1', hasPayload: false, replay: record('warmup2') }, d))
      .toMatchObject({ disposition: 'waiting' });
    expect(deferredSpawnCount()).toBe(1);

    clearSpawnFreeze(d);
    await waitForPolls();
    // Only the real turn's replay ran, with nothing folded onto it.
    expect(replays).toEqual([{ tag: 'real', folded: [] }]);
  });

  it('a promptless spawn behind another promptless one just waits (no fold, no displace)', async () => {
    const dir = freshDir();
    writeDeclaration(dir, { reason: 'claude-update', deadline: NOW + 60_000 });
    const d = deps(dir);

    const replays: string[] = [];
    expect(deferSpawnDuringFreeze({ sessionId: 's1', hasPayload: false, replay: () => replays.push('warmup1') }, d))
      .toMatchObject({ disposition: 'parked' });
    // A second warm-up must not add an entry, fold, or displace — it waits.
    expect(deferSpawnDuringFreeze({ sessionId: 's1', hasPayload: false, replay: () => replays.push('warmup2') }, d))
      .toMatchObject({ disposition: 'waiting' });
    expect(deferredSpawnCount()).toBe(1);

    clearSpawnFreeze(d);
    await waitForPolls();
    // The first parked warm-up replays; the second was never queued.
    expect(replays).toEqual(['warmup1']);
  });

  it('drops a parked spawn when its session is closed', async () => {
    const dir = freshDir();
    writeDeclaration(dir, { reason: 'cred-refresh', deadline: NOW + 60_000 });
    const d = deps(dir);

    const replays: string[] = [];
    deferSpawnDuringFreeze({ sessionId: 's1', hasPayload: true, foldTurn: { content: 's1' }, replay: () => replays.push('s1') }, d);
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
    expect(deferSpawnDuringFreeze({ sessionId: 's1', hasPayload: true, foldTurn: { content: 's1' }, replay: () => replays.push('s1') }, d))
      .toMatchObject({ disposition: 'parked' });

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
    expect(shouldAnnounceSpawnFreeze(first, 'anchor-1')).toBe(true);
    expect(shouldAnnounceSpawnFreeze(first, 'anchor-1')).toBe(false);
    // A different session in the same group has its own anchor and must still be
    // told — keying by chat id would silence whoever is waiting in it.
    expect(shouldAnnounceSpawnFreeze(first, 'anchor-2')).toBe(true);
    // "parked" and "folded" are different messages, one each — the first turn's
    // "held, continues after release" vs a later turn's "also received".
    expect(shouldAnnounceSpawnFreeze(first, 'anchor-1', 'folded')).toBe(true);
    expect(shouldAnnounceSpawnFreeze(first, 'anchor-1', 'folded')).toBe(false);

    // A NEW declaration is a new window: the same chat is told again.
    writeDeclaration(dir, { reason: 'claude-update', deadline: NOW + 400_000, notify: true });
    const second = readActiveSpawnFreeze(deps(dir))!;
    expect(second.freezeId).not.toBe(first.freezeId);
    expect(shouldAnnounceSpawnFreeze(second, 'anchor-1')).toBe(true);

    writeDeclaration(dir, { reason: 'quiet', deadline: NOW + 60_000 });
    const quiet = readActiveSpawnFreeze(deps(dir))!;
    expect(shouldAnnounceSpawnFreeze(quiet, 'anchor-1')).toBe(false);
    expect(shouldAnnounceSpawnFreeze(quiet, 'anchor-1', 'folded')).toBe(false);
  });
});
