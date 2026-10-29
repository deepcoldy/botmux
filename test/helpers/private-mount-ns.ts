/**
 * Run a TS snippet (repo imports allowed) in its own mount + PID namespace:
 * `setpriv --pdeathsig KILL unshare --mount --propagation private --pid --fork
 *  --mount-proc --kill-child`.
 *
 * WHY: a test that mounts for real (a scratch overlay with `lowerdir=/`, its
 * per-submount overlays, fuse-overlayfs daemons) and is killed before its
 * `finally` — a timeout kill, a cancelled run — used to leave all of it in the
 * HOST mount table, where every later scratch session wrapped it again. Inside
 * the namespace nothing reaches the host:
 *  - mounts are private both ways (none propagates out, none from elsewhere in);
 *  - when the test runner dies, `unshare` gets SIGKILL (pdeathsig), which kills
 *    the namespace's init (--kill-child); the kernel then kills every process
 *    in the PID namespace, fuse daemons included, and the mount namespace is
 *    freed with every mount in it.
 * The fresh /proc (--mount-proc) is what lets the product's own
 * `bwrap --unshare-user --proc /proc` start inside — so a snippet can run the
 * container argv prepareScratchSandbox returns, not just build it. (A wrapping
 * `bwrap --unshare-pid --proc`, like isolate-run's, refuses that nested proc
 * mount; this one works nested inside isolate-run too.)
 *
 * Root only: without a user namespace an unprivileged process gets no mount
 * rights, and with one the snippet would no longer exercise the root code path
 * (kernel overlay, tmpfs slot) the daemon runs.
 */
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { resolve } from 'node:path';
import { tsEvalArgs, tsRunnerPrefix } from './ts-runner.js';

const quote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

function spawnInPrivateMountNs(
  command: readonly string[],
  opts: { env?: NodeJS.ProcessEnv; tmpfs?: readonly string[]; timeoutMs?: number },
): SpawnSyncReturns<string> {
  // Scratch tmpfs upper slots live under /var/tmp/botmux-scratch: keep them off the host's.
  const prologue = ['/var/tmp', ...(opts.tmpfs ?? [])]
    .map(dir => `mount -t tmpfs -o mode=755 tmpfs ${quote(dir)} || exit 125`)
    .concat(`cd ${quote(resolve('.'))} || exit 125`, 'exec "$@"')
    .join('; ');
  return spawnSync('setpriv', [
    '--pdeathsig', 'KILL',
    'unshare', '--mount', '--propagation', 'private', '--pid', '--fork', '--mount-proc', '--kill-child',
    '/bin/sh', '-c', prologue, 'private-mount-ns', ...command,
  ], {
    encoding: 'utf8',
    env: opts.env ?? process.env,
    timeout: opts.timeoutMs ?? 120_000,
    killSignal: 'SIGKILL',
    maxBuffer: 64 * 1024 * 1024,
  });
}

let available: boolean | undefined;

/** Can this host give a snippet a private mount + PID namespace with mount rights? */
export function privateMountNsAvailable(): boolean {
  if (available !== undefined) return available;
  available = process.platform === 'linux' && process.getuid?.() === 0
    && spawnSync('sh', ['-c', 'command -v setpriv && command -v unshare && command -v bwrap'], { stdio: 'ignore' }).status === 0
    && spawnInPrivateMountNs(['true'], { timeoutMs: 20_000 }).status === 0;
  return available;
}

/**
 * Run `source` (an ES module; `./src/...js` imports resolve against the repo
 * root) inside a private mount + PID namespace and return its output.
 * `tmpfs` dirs get a fresh tmpfs inside the namespace only.
 */
export function runInPrivateMountNs(
  source: string,
  opts: { env?: NodeJS.ProcessEnv; tmpfs?: readonly string[]; timeoutMs?: number } = {},
): SpawnSyncReturns<string> {
  const { command, prefixArgs } = tsRunnerPrefix();
  const { args } = tsEvalArgs(source);
  return spawnInPrivateMountNs([command, ...prefixArgs, ...args], opts);
}

/** The snippet's result: the last stdout line that parses as JSON. */
export function lastJsonLine<T>(run: SpawnSyncReturns<string>): T {
  const lines = (run.stdout ?? '').trim().split('\n').reverse();
  for (const line of lines) {
    try { return JSON.parse(line) as T; } catch { /* log line */ }
  }
  throw new Error(`no JSON result (exit ${run.status}, signal ${run.signal})\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}`);
}
