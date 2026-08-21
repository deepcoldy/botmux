import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  pm2FleetMutationLockTarget,
  withPm2FleetMutationLock,
  withPm2FleetMutationLockSync,
} from '../src/cli/pm2-fleet-lock.js';

/**
 * BEHAVIOR tests (not source pins) for the ownership model: re-entrancy must
 * be scoped to the async call chain that actually holds the lock. A
 * process-global "held" flag would let an unrelated concurrent flow in the
 * same process (dashboard HTTP handlers) skip the file lock while another
 * flow holds it.
 */
describe('withPm2FleetMutationLock ownership', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'botmux-fleet-lock-'));
    vi.stubEnv('HOME', home);
    mkdirSync(join(home, '.botmux'), { recursive: true });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });

  it('nested calls within the holding chain short-circuit (async and sync)', async () => {
    const result = await withPm2FleetMutationLock(async () => {
      const inner = await withPm2FleetMutationLock(async () => 'inner-async');
      const innerSync = withPm2FleetMutationLockSync(() => 'inner-sync');
      return `${inner}/${innerSync}`;
    }, { maxWaitMs: 2_000 });
    expect(result).toBe('inner-async/inner-sync');
  });

  it('two INDEPENDENT concurrent chains in one process serialize on the file lock', async () => {
    // The dashboard scenario: chain A holds the lock and is suspended at an
    // await; chain B starts concurrently. B must NOT treat A's ownership as
    // its own — it has to queue on the file lock until A releases.
    const events: string[] = [];
    let releaseA!: () => void;
    const aInside = new Promise<void>(resolveInside => {
      void withPm2FleetMutationLock(async () => {
        events.push('A-enter');
        resolveInside();
        await new Promise<void>(resolve => { releaseA = resolve; });
        events.push('A-exit');
      }, { maxWaitMs: 5_000 });
    });
    await aInside;

    const b = withPm2FleetMutationLock(async () => {
      events.push('B-enter');
    }, { maxWaitMs: 5_000 });

    // Give B ample time to (incorrectly) enter if ownership were process-global.
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(events).toEqual(['A-enter']);

    releaseA();
    await b;
    expect(events).toEqual(['A-enter', 'A-exit', 'B-enter']);
  });

  it('a lock held by another live process makes an unrelated chain wait, then time out', async () => {
    // Simulate an external holder: a fresh lock file whose recorded pid is
    // alive (our own pid — file-lock treats a live same-pid holder as HELD,
    // never stale). A chain with no ownership context must queue and
    // eventually time out instead of stealing or skipping the lock.
    writeFileSync(`${pm2FleetMutationLockTarget()}.lock`, String(process.pid));
    await expect(
      withPm2FleetMutationLock(async () => 'must-not-run', { maxWaitMs: 400 }),
    ).rejects.toThrow(/file-lock timeout/);
  });
});
