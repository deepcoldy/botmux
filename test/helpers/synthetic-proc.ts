/**
 * A synthetic /proc for containment tests, so no case has to read the REAL
 * `/proc` to build its fixture.
 *
 * Why this exists: several containment tests used to seed their fake tree with
 *   readFileSync('/proc/sys/kernel/random/boot_id')
 * purely to make the recorded handle's bootId agree with what the scanner would
 * read back. That read is Linux-only, so the whole case died off Linux for a
 * reason that had nothing to do with the behaviour under test. The scanner reads
 * the boot id through the `procRoot` seam (see readBootId), so a fixture-local
 * id is just as valid and is platform independent.
 *
 * Everything here writes files only; nothing inspects the host.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** True on hosts where a real `/proc` and real process signalling exist. */
export const isLinux = process.platform === 'linux';

/**
 * A boot id that is stable within one fixture but not the host's.
 *
 * Handles record this and the scanner reads it back out of the same synthetic
 * tree, so identity checks pass without consulting the real kernel.
 */
export function syntheticBootId(seed = 'fixture'): string {
  const hex = [...seed].reduce((a, c) => (a * 33 + c.charCodeAt(0)) % 0xffffffff, 7)
    .toString(16).padStart(8, '0');
  return `${hex}-0000-4000-8000-000000000000`;
}

export interface SyntheticProcRoot {
  /** Path to pass as `procRoot` (or return from a `procRoot` getter override). */
  readonly path: string;
  /** The boot id written into this tree; record it on handles. */
  readonly bootId: string;
  /** Add one `/proc/<pid>` entry. */
  addProcess(spec: SyntheticProcess): void;
  /** Write a deliberately unparsable `stat`, to exercise a failing scan. */
  addUnparsableProcess(pid: number): void;
}

export interface SyntheticProcess {
  pid: number;
  /** Field 3 of stat: 'S' | 'R' | 'Z' ... Only a definite 'Z' is a zombie. */
  state?: string;
  ppid?: number;
  pgid?: number;
  /** Field 22 of stat; what pid-reuse detection compares against. */
  startTime?: number;
  /** comm, without parentheses. */
  name?: string;
  /** NUL-separated environ content; pass the tree nonce here to be claimed. */
  environ?: string;
}

/**
 * Create a synthetic proc tree under `parent` (a temp dir by default).
 *
 * The stat layout matches the real one where the code looks: pid, (comm), state,
 * ppid, pgid, then filler up to field 22 = starttime.
 */
export function syntheticProcRoot(
  opts: { parent?: string; name?: string; bootId?: string } = {},
): SyntheticProcRoot {
  const base = opts.parent
    ? join(opts.parent, opts.name ?? 'proc')
    : mkdtempSync(join(tmpdir(), 'synthetic-proc-'));
  mkdirSync(join(base, 'sys', 'kernel', 'random'), { recursive: true });
  const bootId = opts.bootId ?? syntheticBootId(opts.name ?? base);
  writeFileSync(join(base, 'sys', 'kernel', 'random', 'boot_id'), `${bootId}\n`);

  return {
    path: base,
    bootId,
    addProcess(spec: SyntheticProcess): void {
      const dir = join(base, String(spec.pid));
      mkdirSync(dir, { recursive: true });
      const filler = Array.from({ length: 16 }, () => '0').join(' ');
      const state = spec.state ?? 'S';
      const ppid = spec.ppid ?? 1;
      const pgid = spec.pgid ?? spec.pid;
      const startTime = spec.startTime ?? 4242;
      writeFileSync(
        join(dir, 'stat'),
        `${spec.pid} (${spec.name ?? 'root'}) ${state} ${ppid} ${pgid} ${filler} ${startTime}`,
      );
      writeFileSync(join(dir, 'environ'), spec.environ ?? '');
    },
    addUnparsableProcess(pid: number): void {
      const dir = join(base, String(pid));
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'stat'), 'garbage with no parens');
      writeFileSync(join(dir, 'environ'), '');
    },
  };
}
