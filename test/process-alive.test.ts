import { afterEach, describe, expect, it, vi } from 'vitest';

import { pidExistsEpermAlive, pidIsSignalable, pidNotProvablyGone } from '../src/utils/process-alive.js';

// The three policies differ only in how kill(pid, 0) failures are read. The
// table below is the contract every migrated call site relied on.
const OUTCOMES: Array<{ name: string; failure?: { code?: string } | null; signalable: boolean; exists: boolean; notGone: boolean }> = [
  { name: 'signal delivered', signalable: true, exists: true, notGone: true },
  { name: 'EPERM (exists, not ours)', failure: { code: 'EPERM' }, signalable: false, exists: true, notGone: true },
  { name: 'ESRCH (gone)', failure: { code: 'ESRCH' }, signalable: false, exists: false, notGone: false },
  { name: 'EINVAL (unexpected errno)', failure: { code: 'EINVAL' }, signalable: false, exists: false, notGone: true },
  { name: 'error without a code', failure: {}, signalable: false, exists: false, notGone: true },
];

afterEach(() => { vi.restoreAllMocks(); });

describe('process-alive policies', () => {
  for (const outcome of OUTCOMES) {
    it(`${outcome.name}`, () => {
      const kill = vi.spyOn(process, 'kill').mockImplementation((() => {
        if (outcome.failure) throw Object.assign(new Error('kill failed'), outcome.failure);
        return true;
      }) as never);
      expect(pidIsSignalable(4321)).toBe(outcome.signalable);
      expect(pidExistsEpermAlive(4321)).toBe(outcome.exists);
      expect(pidNotProvablyGone(4321)).toBe(outcome.notGone);
      expect(kill).toHaveBeenCalledTimes(3);
      for (const call of kill.mock.calls) expect(call).toEqual([4321, 0]);
    });
  }

  it('agrees with the real kernel for this process and a surely-dead pid', () => {
    expect(pidIsSignalable(process.pid)).toBe(true);
    expect(pidExistsEpermAlive(process.pid)).toBe(true);
    expect(pidNotProvablyGone(process.pid)).toBe(true);
    const dead = 2_147_483_000; // far above any pid_max in use
    expect(pidIsSignalable(dead)).toBe(false);
    expect(pidExistsEpermAlive(dead)).toBe(false);
    expect(pidNotProvablyGone(dead)).toBe(false);
  });
});
