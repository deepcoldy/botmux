/**
 * A `sleep` executable that keeps working under ANY file name.
 *
 * Several fixtures copy sleep to a CLI's name (`traex`, `codex`, …) so that the
 * kernel's comm and `/proc/<pid>/exe` name that copy — which is what the code
 * under test reads — while the process just sits there. `/bin/sleep` cannot be
 * assumed to be such a binary.
 *
 * Ubuntu 26.04 (GitHub's `ubuntu-latest` since 2026-11) makes uutils
 * `rust-coreutils` the default coreutils. Its `/bin/sleep` is ONE ~11.8 MB
 * multicall binary (hard-linked ~116 times) that picks the utility from its own
 * executable name and refuses any other name: a copy named `traex` exits 1
 * within milliseconds ("coreutils: unknown program 'traex'"). Neither
 * `traex sleep 30` nor argv[0]=sleep gets around this, because it cross-checks
 * /proc/self/exe ("Security violation: Requested utility `sleep` does not match
 * executable name"). Fixtures built on such a copy then fail far from the
 * cause: "expected undefined to be defined", "timed out waiting for the probe
 * ownership binding". BusyBox behaves the same way.
 *
 * GNU sleep still ships on those hosts as `/usr/bin/gnusleep` (package
 * gnu-coreutils, Priority: required; coreutils-from-uutils pre-depends on it).
 *
 * The first candidate whose renamed copy runs `<copy> 0` with exit 0 wins. A
 * test that needs one skips with `reason` when there is none. Only host
 * binaries are probed, never the code under test, so a product regression
 * cannot turn into a skip here.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CANDIDATES = ['/bin/sleep', '/usr/bin/gnusleep'];

export type StandaloneSleep =
  | { path: string; reason?: undefined }
  | { path?: undefined; reason: string };

let cached: StandaloneSleep | undefined;

export function standaloneSleep(): StandaloneSleep {
  if (cached) return cached;
  const tried: string[] = [];
  const dir = mkdtempSync(join(tmpdir(), 'botmux-sleep-probe-'));
  try {
    for (const candidate of CANDIDATES) {
      if (!existsSync(candidate)) {
        tried.push(`${candidate}: absent`);
        continue;
      }
      // Deliberately not named like any coreutils utility.
      const copy = join(dir, `renamed-${tried.length}`);
      copyFileSync(candidate, copy);
      chmodSync(copy, 0o755);
      const run = spawnSync(copy, ['0'], { encoding: 'utf8', timeout: 5_000 });
      if (run.status === 0) return (cached = { path: candidate });
      const why = run.error?.message ?? run.stderr?.trim() ?? '';
      tried.push(`${candidate}: renamed copy exited ${run.status ?? run.signal}${why ? ` (${why})` : ''}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return (cached = { reason: `no sleep binary runs under a foreign file name — ${tried.join('; ')}` });
}
