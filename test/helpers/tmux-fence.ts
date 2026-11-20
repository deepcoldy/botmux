import * as nodeFs from 'node:fs';
import * as nodeChildProcess from 'node:child_process';
import { delimiter, join } from 'node:path';

// Captured when this module is first evaluated — from the runners' setup /
// preload, before any test module runs. `bun test` mocks modules
// process-wide: a test that `mock.module('node:fs')`s a /proc/net/unix fixture
// would otherwise hand the end-of-run denial check that fixture as "denials",
// and a mocked spawnSync would silently skip the private-server cleanup.
const {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync,
  realpathSync, rmSync, statSync, writeFileSync,
} = { ...nodeFs };
const { spawnSync } = { ...nodeChildProcess };

/**
 * Test-wide tmux fence: no test may reach the HOST's tmux servers.
 *
 * WHY: the host's default server carried every live bot session, and tests
 * reached it three different ways (2026-10-19/20, ~10 outages):
 *   - an inherited TMUX (suite started inside a tmux pane) makes a client ignore
 *     TMUX_TMPDIR and talk to the caller's server (#2043 fixed the known tests);
 *   - a TMUX_TMPDIR pointing at a directory that does not exist is SILENTLY
 *     replaced by /tmp — tmux skips any entry of `$TMUX_TMPDIR:/tmp` whose
 *     realpath fails — so a test that forgot to mkdir its socket root drove,
 *     and finally `kill-server`ed, the host default server;
 *   - real-tmux tests that never set TMUX_TMPDIR at all.
 * Managed sessions now live on a dedicated `-L botmux` server, which sits in the
 * SAME host socket directory, so "a private label" is not isolation either.
 *
 * Two layers, shared by both runners (vitest setup files, `bun test` preload):
 *   1. env: every test file gets its own EXISTING, short TMUX_TMPDIR and loses
 *      TMUX / TMUX_PANE, so anything that inherits the environment is private;
 *   2. a `tmux` shim first on PATH that resolves the socket exactly like tmux
 *      (-S, -L, $TMUX, $TMUX_TMPDIR with the /tmp fallback) and refuses — exit 1
 *      plus a line in the deny log — any socket in a host socket directory. A
 *      non-empty deny log fails the run at teardown, even when the test itself
 *      swallowed the error.
 * Not covered: a child spawned with a hand-built env that drops PATH, or tmux
 * invoked by absolute path. Those still get layer 1 unless the env drops
 * TMUX_TMPDIR too.
 */

export interface TmuxFence {
  /** Short private root (socket paths are capped at ~104 bytes). */
  root: string;
  /** Directory holding the `tmux` shim, or null when the host has no tmux. */
  binDir: string | null;
  denyLog: string;
}

const FENCE_ROOT_PREFIX = '/tmp/bmxt-';

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function resolveRealTmux(pathValue: string | undefined, skipDir?: string): string | null {
  for (const dir of (pathValue ?? '').split(delimiter)) {
    if (!dir || dir === skipDir) continue;
    const candidate = join(dir, 'tmux');
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch { /* keep scanning */ }
  }
  return null;
}

/**
 * The REAL tmux binary behind the fence shim (null when the host has none).
 *
 * Only for comparisons that must observe tmux's own behaviour. The shim
 * refuses every host socket, so a case where tmux would legitimately answer
 * for a HOST socket (e.g. the /tmp fallback) can only be observed with the
 * real binary — and only with a probe that starts no server and addresses a
 * private, never-used label.
 */
export function realTmuxBinary(env: NodeJS.ProcessEnv = process.env): string | null {
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, 'tmux');
    try {
      if (!statSync(candidate).isFile()) continue;
      // Skip the fence shim itself: it refuses host sockets by design, so it
      // cannot answer questions about tmux's own behaviour.
      if (readFileSync(candidate, 'utf8').includes('refusing host tmux socket')) continue;
      return candidate;
    } catch { /* keep scanning */ }
  }
  return null;
}

function realDir(path: string): string | null {
  try { return realpathSync(path); } catch { return null; }
}

/** Socket directories that belong to the host, for the CURRENT uid.
 *
 *  /tmp is always a possible target (tmux falls back to it for a
 *  $TMUX_TMPDIR that does not name an existing directory), and every
 *  directory the raw value names stays host-owned even when tmux itself
 *  would ignore the whole value: the fence refuses more rather than less.
 *  What tmux would actually do with the value is decided by the shim below,
 *  which mirrors tmux exactly. */
export function hostTmuxSocketDirs(env: NodeJS.ProcessEnv = process.env): string[] {
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
  const bases = new Set<string>();
  const tmp = realDir('/tmp');
  if (tmp) bases.add(tmp);
  const raw = env.TMUX_TMPDIR ?? '';
  // The COMPLETE raw value first: tmux resolves it as ONE path, so a
  // directory whose NAME contains a colon is a real host root the shim may
  // land on. The colon-split entries below only add MORE conservative
  // refusals — they must never replace the whole-value registration.
  const whole = raw ? realDir(raw) : null;
  if (whole) bases.add(whole);
  for (const entry of raw.split(':')) {
    const resolved = entry ? realDir(entry) : null;
    if (resolved) bases.add(resolved);
  }
  return [...bases].map(base => join(base, `tmux-${uid}`));
}

/** POSIX sh shim: resolve the socket like tmux does, refuse host sockets. */
export function tmuxFenceShimScript(realTmux: string, hostDirs: readonly string[], denyLog: string): string {
  return `#!/bin/sh
# Generated by test/helpers/tmux-fence.ts — refuses host tmux sockets in tests.
set -f
REAL=${shellSingleQuote(realTmux)}
DENY_LOG=${shellSingleQuote(denyLog)}
HOST_DIRS=${shellSingleQuote(hostDirs.join('\n'))}
label=''
socket=''
expect=''
for a in "$@"; do
  if [ -n "$expect" ]; then
    case "$expect" in L) label=$a ;; S) socket=$a ;; esac
    expect=''
    continue
  fi
  case "$a" in
    --|-) break ;;
    -?*) ;;
    *) break ;;
  esac
  rest=\${a#-}
  while [ -n "$rest" ]; do
    c=\${rest%"\${rest#?}"}
    rest=\${rest#?}
    case "$c" in
      V) exec "$REAL" "$@" ;;
      c|f|L|S|T)
        if [ -n "$rest" ]; then
          case "$c" in L) label=$rest ;; S) socket=$rest ;; esac
          rest=''
        else
          expect=$c
        fi ;;
    esac
  done
done
if [ -z "$socket" ]; then
  if [ -z "$label" ] && [ -n "$TMUX" ] && [ "\${TMUX#,}" = "$TMUX" ]; then
    socket=\${TMUX%%,*}
  else
    [ -n "$label" ] || label=default
    # tmux resolves $TMUX_TMPDIR as ONE path and silently falls back to /tmp
    # when it does not name an existing directory. A colon separated value is
    # not a list for tmux — the whole string is one path that does not
    # resolve — so it must land on /tmp here too. tmux also realpath()s the
    # value, so resolve it the same way: a symlink to a host root must compare
    # as that root even before tmux-<uid> exists under it.
    if [ -n "$TMUX_TMPDIR" ] && [ -d "$TMUX_TMPDIR" ] \\
      && base=$(cd "$TMUX_TMPDIR" 2>/dev/null && pwd -P); then
      :
    else
      base=/tmp
    fi
    socket="$base/tmux-$(id -u)/$label"
  fi
fi
case "$socket" in */*) dir=\${socket%/*} ;; *) dir=. ;; esac
rdir=$(cd "$dir" 2>/dev/null && pwd -P) || rdir=$dir
old_ifs=$IFS
IFS='
'
for host in $HOST_DIRS; do
  if [ "$rdir" = "$host" ]; then
    IFS=$old_ifs
    printf '%s\\t%s\\t%s\\n' "$socket" "$PWD" "$*" >> "\${BOTMUX_TMUX_FENCE_LOG:-$DENY_LOG}"
    echo "botmux test tmux fence: refusing host tmux socket $socket (args: $*). Use a private TMUX_TMPDIR that EXISTS — tmux silently falls back to /tmp otherwise — or an explicit private -S path." >&2
    exit 1
  fi
done
IFS=$old_ifs
exec "$REAL" "$@"
`;
}

/** Create the per-run fence (vitest globalSetup / bun preload). */
export function createTmuxFence(env: NodeJS.ProcessEnv = process.env): TmuxFence {
  const root = mkdtempSync(FENCE_ROOT_PREFIX);
  const denyLog = join(root, 'denied.log');
  writeFileSync(denyLog, '');
  const realTmux = resolveRealTmux(env.PATH);
  if (!realTmux || process.platform === 'win32') return { root, binDir: null, denyLog };
  const binDir = join(root, 'bin');
  mkdirSync(binDir);
  const shim = join(binDir, 'tmux');
  writeFileSync(shim, tmuxFenceShimScript(realTmux, hostTmuxSocketDirs(env), denyLog));
  chmodSync(shim, 0o755);
  return { root, binDir, denyLog };
}

/**
 * Fence one test process: a fresh existing TMUX_TMPDIR under the run root, no
 * inherited TMUX, and the shim first on PATH. Per FILE (vitest forks one
 * process per file) so two files' `-L botmux` servers never meet.
 */
export function applyTmuxFenceEnv(fence: TmuxFence, env: NodeJS.ProcessEnv = process.env): { socketRoot: string; denyLog: string } {
  const socketRoot = mkdtempSync(join(fence.root, 'f-'));
  // Per-process deny log (outside the socket root) so a refusal is pinned on
  // the file that caused it; children that drop it fall back to the run log.
  const denyLog = `${socketRoot}.denied.log`;
  writeFileSync(denyLog, '');
  env.BOTMUX_TMUX_FENCE_LOG = denyLog;
  env.TMUX_TMPDIR = socketRoot;
  delete env.TMUX;
  delete env.TMUX_PANE;
  if (fence.binDir) {
    const parts = (env.PATH ?? '').split(delimiter).filter(part => part && part !== fence.binDir);
    env.PATH = [fence.binDir, ...parts].join(delimiter);
  }
  return { socketRoot, denyLog };
}

export function readTmuxFenceLog(path: string): string[] {
  try {
    return readFileSync(path, 'utf8').split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

/** Every refusal of the run: the run log plus each file's own log. */
export function readTmuxFenceDenials(fence: Pick<TmuxFence, 'root' | 'denyLog'>): string[] {
  let perFile: string[] = [];
  try { perFile = readdirSync(fence.root).filter(name => name.endsWith('.denied.log')); } catch { /* gone */ }
  return [fence.denyLog, ...perFile.map(name => join(fence.root, name))].flatMap(readTmuxFenceLog);
}

/** Kill every private server the run left behind, then drop the root. */
export function teardownTmuxFence(fence: TmuxFence): void {
  const realTmux = resolveRealTmux(process.env.PATH, fence.binDir ?? undefined);
  if (realTmux && existsSync(fence.root)) {
    const env = { ...process.env };
    delete env.TMUX;
    delete env.TMUX_PANE;
    for (const fileDir of readdirSync(fence.root)) {
      if (!fileDir.startsWith('f-')) continue;
      const fileRoot = join(fence.root, fileDir);
      let uidDirs: string[] = [];
      try { uidDirs = readdirSync(fileRoot).filter(name => name.startsWith('tmux-')); } catch { continue; }
      for (const uidDir of uidDirs) {
        let sockets: string[] = [];
        try { sockets = readdirSync(join(fileRoot, uidDir)); } catch { continue; }
        for (const socket of sockets) {
          // -S with a path INSIDE the private root: can never address a host server.
          spawnSync(realTmux, ['-S', join(fileRoot, uidDir, socket), 'kill-server'], { stdio: 'ignore', timeout: 3000, env });
        }
      }
    }
  }
  rmSync(fence.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

export function tmuxFenceDenialError(denials: readonly string[]): Error {
  return new Error(
    `tmux test fence refused ${denials.length} attempt(s) to reach a HOST tmux socket ` +
    '(socket\tcwd\targs):\n' + denials.join('\n'),
  );
}
