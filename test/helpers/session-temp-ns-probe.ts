/**
 * Run a snippet with its own `/tmp` (a fresh tmpfs) so a test can observe what
 * a FRESH host looks like: no `/tmp/bm<uid>` hub, nothing another test left
 * behind. Needed because the hub is keyed by uid, not by test, so every case
 * sharing the host /tmp would otherwise see its neighbours' state.
 *
 * Uses a user namespace when not root (`unshare --user --map-root-user`), so
 * the same probe runs on CI runners, and a mount + PID namespace either way
 * (`--pid --fork --mount-proc`) so a killed run cannot leave a mount behind.
 *
 * Falls back to "unavailable" rather than throwing: the probe is evidence for
 * a platform behaviour, and a host that cannot unshare cannot produce it.
 */
import { spawnSync } from 'node:child_process';

let available: boolean | undefined;

function canUnshare(): boolean {
  const probe = process.platform === 'linux'
    && spawnSync('sh', ['-c', 'command -v unshare && command -v setpriv'], { stdio: 'ignore' }).status === 0;
  if (!probe) return false;
  const userNs = process.getuid?.() !== 0 ? ['--user', '--map-root-user'] : [];
  return spawnSync('unshare', [...userNs, '--mount', '--pid', '--fork', '--mount-proc',
    '/bin/sh', '-c', 'mount -t tmpfs -o mode=755 tmpfs /tmp && test -d /tmp'], { stdio: 'ignore' }).status === 0;
}

/**
 * The uid a {@link runWithPrivateTmp} script sees INSIDE the namespace.
 *
 * Always 0, by construction of the two branches above: as root the helper adds
 * no user namespace at all (so the uid is the caller's, and this runs as root),
 * and as non-root it adds `--user --map-root-user`, which maps the caller to
 * namespace-root.
 *
 * Callers MUST build `/tmp/bm<uid>` paths with this value, never with
 * `process.getuid()`. The boot code inside the namespace computes its hub from
 * its OWN `getuid()`, which is 0; a host-uid path (1001 on a CI runner) names a
 * directory that code never looks at, so a test that plants or asserts on it
 * observes an untouched tree and reports a failure that has nothing to do with
 * the behaviour under test. Locally (root) the two agree and the bug is
 * invisible — the same blind spot as a TMPDIR that happens to differ from /tmp.
 */
export const NAMESPACE_UID = 0;

/** Can this host give a snippet a private /tmp? */
export function privateTmpAvailable(): boolean {
  if (available === undefined) available = canUnshare();
  return available;
}

/**
 * Run `script` (a POSIX sh script) with a fresh tmpfs mounted at /tmp.
 * `cwd` stays the repo so repo files are reachable; `env` is merged over the
 * caller's, and HOME should point somewhere disposable.
 *
 * `expose` lists paths (files or directories) that must stay VISIBLE inside the
 * namespace despite the tmpfs replacing /tmp. They are bind-mounted read-write
 * at the same path after the mount. Without this, a caller whose fixtures live
 * under the host's tmpdir loses them the moment /tmp is replaced — which is the
 * normal case on a CI runner AND in this repo's unit test setup (both put the
 * per-worker home under `os.tmpdir()`).
 */
export function runWithPrivateTmp(
  script: string,
  opts: { env?: NodeJS.ProcessEnv; timeoutMs?: number; expose?: readonly string[] } = {},
): { status: number | null; stdout: string; stderr: string } {
  const userNs = process.getuid?.() !== 0 ? ['--user', '--map-root-user'] : [];
  // Bind mounts need the paths to exist; a mount point for a FILE cannot be a
  // directory, so bind each exposed path onto itself by exact path.
  const binds = (opts.expose ?? []).map(p => `mount --bind ${quote(p)} ${quote(p)} || exit 125;`).join(' ');
  const result = spawnSync('unshare', [
    ...userNs, '--mount', '--propagation', 'private', '--pid', '--fork', '--mount-proc',
    '/bin/sh', '-c',
    // The uid check is not decoration: NAMESPACE_UID is a CONSTANT that callers
    // bake into paths, so if this helper's mapping ever changes the constant
    // would silently name the wrong directory again. Fail loudly instead.
    `mount -t tmpfs -o mode=755 tmpfs /tmp || exit 125; ${binds} `
    + `[ "$(id -u)" = "${NAMESPACE_UID}" ] || { echo "namespace uid $(id -u) != ${NAMESPACE_UID}" >&2; exit 126; }; `
    + `exec /bin/sh -c "$1"`,
    'private-tmp', script,
  ], {
    encoding: 'utf8',
    env: { ...process.env, ...opts.env },
    timeout: opts.timeoutMs ?? 120_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

const quote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;
