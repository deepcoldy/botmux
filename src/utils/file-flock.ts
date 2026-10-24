/**
 * Advisory whole-file lock that interoperates with OTHER programs' flock(2).
 *
 * Some CLIs serialize their own state files through `flock(LOCK_EX)` on a
 * sibling `.lock` file — Grok Build does exactly that for
 * `~/.grok/trusted_folders.toml` (`trusted_folders.toml.lock`, verified with
 * strace on 1.0.70: flock(LOCK_EX) → write temp → rename → flock(LOCK_UN)).
 * Writing such a file without taking the same lock can silently lose an entry
 * the CLI (or another botmux daemon) is writing at the same moment.
 *
 * Node and Bun expose no flock binding, so a tiny helper process takes the lock
 * and holds it until we close its stdin; its stdin closing (normally, or because
 * this process died) is what releases the lock, so a crashed caller can never
 * leave a stale lock behind. `flock(1)` (util-linux, every mainstream Linux) is
 * preferred; `perl` (present on stock macOS, which lacks flock(1)) is the
 * fallback. Both call flock(2) on the same path, so they exclude the CLI too.
 */
import { spawn, type ChildProcess } from 'node:child_process';

export type FileLockResult<T> =
  | { acquired: true; value: T }
  | { acquired: false; reason: 'timeout' | 'unavailable' | 'error'; detail?: string };

const LOCKED_MARKER = 'botmux-flock-acquired';

/** Helper command lines, tried in order. Each prints LOCKED_MARKER once it
 *  holds an exclusive lock on argv lockPath, then blocks until stdin EOF. Exit
 *  code 1 means "could not acquire within the timeout". */
function lockHelperCandidates(lockPath: string, timeoutSec: string): Array<{ cmd: string; args: string[] }> {
  return [
    {
      cmd: 'flock',
      // `flock` exits 1 on -w timeout before running the command. `exec cat`
      // keeps the lock exactly as long as our stdin stays open. Explicit `sh`
      // rather than `-c`, which would run whatever $SHELL happens to be.
      args: ['-x', '-w', timeoutSec, lockPath, 'sh', '-c', `printf '%s\\n' ${LOCKED_MARKER}; exec cat >/dev/null`],
    },
    {
      cmd: 'perl',
      args: [
        '-e',
        [
          'use Fcntl qw(:flock O_RDWR O_CREAT); use Time::HiRes qw(time sleep);',
          'sysopen(my $fh, $ARGV[0], O_RDWR | O_CREAT, 0644) or exit 3;',
          'my $deadline = time + $ARGV[1];',
          'until (flock($fh, LOCK_EX | LOCK_NB)) { exit 1 if time >= $deadline; sleep 0.05; }',
          `$| = 1; print "${LOCKED_MARKER}\\n"; while (<STDIN>) {} exit 0;`,
        ].join(' '),
        lockPath,
        timeoutSec,
      ],
    },
  ];
}

type AcquireOutcome =
  | { kind: 'locked'; child: ChildProcess }
  | { kind: 'missing' }
  | { kind: 'timeout' }
  | { kind: 'error'; detail: string };

function acquireWith(cmd: string, args: string[], timeoutMs: number): Promise<AcquireOutcome> {
  return new Promise(resolve => {
    let settled = false;
    let stdout = '';
    const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'ignore'] });
    const finish = (outcome: AcquireOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(guard);
      if (outcome.kind !== 'locked') {
        // Only ever our own helper pid — never a pattern match.
        try { child.stdin?.destroy(); } catch { /* already closed */ }
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      }
      resolve(outcome);
    };
    // The helper enforces the timeout itself; this guard only covers a helper
    // that hangs before it even reaches flock (e.g. a stalled fork).
    const guard = setTimeout(() => finish({ kind: 'timeout' }), timeoutMs + 2_000);
    guard.unref?.();
    child.on('error', (err: NodeJS.ErrnoException) => {
      finish(err.code === 'ENOENT' ? { kind: 'missing' } : { kind: 'error', detail: err.message });
    });
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk;
      if (stdout.includes(LOCKED_MARKER)) finish({ kind: 'locked', child });
    });
    child.on('exit', code => {
      if (code === 1) finish({ kind: 'timeout' });
      // 127: `flock` itself found, but the shell it runs is not.
      else if (code === 127) finish({ kind: 'missing' });
      else finish({ kind: 'error', detail: `lock helper ${cmd} exited ${code}` });
    });
    // A helper that could not even open stdin is an error, not a lock.
    child.stdin?.on('error', () => { /* surfaced through exit */ });
  });
}

function release(child: ChildProcess): Promise<void> {
  return new Promise(resolve => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    const guard = setTimeout(() => {
      // Closing stdin did not end it — kill our own helper so the lock drops.
      child.kill('SIGKILL');
      resolve();
    }, 2_000);
    guard.unref?.();
    child.once('exit', () => {
      clearTimeout(guard);
      resolve();
    });
    child.stdin?.end();
  });
}

/**
 * Run `fn` while holding an exclusive flock(2) on `lockPath` (created if
 * missing). `fn` runs synchronously inside the critical section; the lock is
 * released (and the helper reaped) before this resolves, so a process the
 * caller starts next never races the helper for the lock.
 */
export async function withExclusiveFileLock<T>(
  lockPath: string,
  timeoutMs: number,
  fn: () => T,
): Promise<FileLockResult<T>> {
  const timeoutSec = (Math.max(0, timeoutMs) / 1000).toFixed(3);
  let lastError: string | undefined;
  for (const candidate of lockHelperCandidates(lockPath, timeoutSec)) {
    const outcome = await acquireWith(candidate.cmd, candidate.args, timeoutMs);
    if (outcome.kind === 'missing') continue;
    if (outcome.kind === 'timeout') return { acquired: false, reason: 'timeout' };
    if (outcome.kind === 'error') {
      lastError = outcome.detail;
      continue;
    }
    try {
      return { acquired: true, value: fn() };
    } finally {
      await release(outcome.child);
    }
  }
  return lastError
    ? { acquired: false, reason: 'error', detail: lastError }
    : { acquired: false, reason: 'unavailable' };
}
