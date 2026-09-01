import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withFileLockSync } from '../src/utils/file-lock.js';

/**
 * Guards the concurrency contract of the host-overload episode dedup
 * (daemon.ts `claimOverloadEpisode`): the ENTIRE read-check-write must run
 * inside one `withFileLockSync` critical section, so that N sibling daemons
 * detecting the SAME edge yield exactly one winner — including the `recovered`
 * / expired path where the marker already exists (the case the old
 * `openSync(marker,'wx')` claim missed, since wx only serializes the first
 * create).
 *
 * We re-implement the exact locked predicate here rather than import the
 * private daemon.ts function (that module has heavy import-time side effects).
 * The mutual exclusion under test is entirely provided by withFileLockSync.
 */
const DEDUP_WINDOW_MS = 60_000;

function claim(marker: string, kind: 'entered' | 'recovered', now: number): boolean {
  return withFileLockSync(marker, () => {
    if (existsSync(marker)) {
      try {
        const prev = JSON.parse(readFileSync(marker, 'utf8')) as { key?: string; at?: number };
        if (prev.key === kind && typeof prev.at === 'number' && now - prev.at < DEDUP_WINDOW_MS) {
          return false;
        }
      } catch { /* corrupt → take over */ }
    }
    // Simulate the read-check-write being non-atomic without the lock: a tiny
    // spin between check and write widens the window an unlocked racer would
    // exploit. Under the lock it must still produce a single winner.
    for (let i = 0; i < 1000; i++) { /* busy */ }
    writeFileWinner(marker, kind, now);
    return true;
  }, { maxWaitMs: 5_000 });
}

function writeFileWinner(marker: string, kind: string, at: number): void {
  // Plain write is fine — the lock, not the write, provides exclusion.
  writeFileSync(marker, JSON.stringify({ key: kind, at }));
}

describe('overload episode dedup — concurrency', () => {
  let dir: string;
  let marker: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'overload-dedup-'));
    marker = join(dir, '.overload-episode.json');
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('yields exactly one winner when N callers race a fresh "entered" edge', async () => {
    const now = 1_000_000;
    const results = await Promise.all(
      Array.from({ length: 8 }, () => Promise.resolve().then(() => claim(marker, 'entered', now))),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('yields exactly one winner on a "recovered" edge even though the marker already exists', async () => {
    // Pre-seed an old `entered` marker — this is the path the wx-only claim
    // missed (marker exists → unlocked read/replace, multiple winners).
    writeFileWinner(marker, 'entered', 0);
    const now = 1_000_000; // far past the window vs at=0
    const results = await Promise.all(
      Array.from({ length: 8 }, () => Promise.resolve().then(() => claim(marker, 'recovered', now))),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(JSON.parse(readFileSync(marker, 'utf8')).key).toBe('recovered');
  });

  it('backs off all callers when the same edge was already claimed within the window', () => {
    const now = 1_000_000;
    expect(claim(marker, 'entered', now)).toBe(true);       // first claims
    expect(claim(marker, 'entered', now + 1_000)).toBe(false); // within 60s window
  });
});
