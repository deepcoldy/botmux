/**
 * Where botmux keeps its OWN tmux (the prebuilt one installed by the one-click
 * upgrade on hosts whose tmux no package manager owns), and the check `tmuxEnv`
 * uses to put it first on PATH.
 *
 * Dependency-light on purpose: ensure-tmux.ts imports this on every tmux
 * spawn, and the installer (tmux-prebuilt.ts) imports ensure-tmux.ts.
 *
 * Layout (`<root>` = `~/.botmux/tools/tmux`):
 *   releases/<id>/bin/tmux        the executable (its basename stays `tmux`)
 *   releases/<id>/manifest.json   what botmux installed there, with hashes
 *   current -> releases/<id>      relative symlink, swapped atomically
 */
import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export function managedTmuxRoot(home: string = homedir()): string {
  return join(home, '.botmux', 'tools', 'tmux');
}

/** `<root>/current/bin`: the PATH entry for the managed tmux. */
export function managedTmuxBinDir(root: string = managedTmuxRoot()): string {
  return join(root, 'current', 'bin');
}

/**
 * Test / probe environments (vitest + e2e tmux fence, scripts/fenced-run.ts)
 * must keep resolving tmux through their PATH shim: a real host-installed
 * managed tmux put in front of it would bypass the fence.
 */
function fenced(env: NodeJS.ProcessEnv): boolean {
  return !!env.BOTMUX_TMUX_FENCE_LOG || env.BOTMUX_FENCED_RUN === '1';
}

/**
 * How long either verification result is trusted. Failures are retried after
 * this instead of hammering a broken binary; successes expire too, because a
 * managed copy can stop running WITHOUT its stat identity changing — a
 * dependency library removed by `apt autoremove`, a noexec remount, or
 * `chmod -x` leave inode/size/mtime untouched. A permanent success cache would
 * keep such a broken copy in front of the user's working tmux until the
 * daemon restarted. Re-verification is one ~2ms `tmux -V` per process per TTL.
 */
const VERIFY_CACHE_TTL_MS = 60_000;
const VERIFY_TIMEOUT_MS = 8_000;
const verified = new Map<string, { key: string; ok: boolean; at: number }>();

export function resetManagedTmuxVerificationForTests(): void {
  verified.clear();
}

/**
 * Does the installed binary actually run here and answer the release its
 * manifest records? Installed copies can break later without botmux touching
 * them (a library removed by `apt autoremove`, a HOME shared with a host that
 * cannot run it, a noexec remount, a truncated file): such a copy must never
 * shadow the user's working tmux. Cached per binary identity with a bounded
 * TTL, so each process pays one `tmux -V` per installed binary per TTL — and
 * a copy that breaks after a successful verification is dropped at the next
 * TTL boundary rather than shadowing the fallback until a daemon restart.
 */
function verifiedRunnable(root: string, bin: string): boolean {
  let key: string;
  try {
    const st = statSync(bin);
    key = `${st.dev}:${st.ino}:${st.size}:${st.mtimeMs}`;
  } catch {
    return false;
  }
  const cached = verified.get(root);
  const now = Date.now();
  if (cached && cached.key === key && now - cached.at < VERIFY_CACHE_TTL_MS) return cached.ok;
  let ok = false;
  let detail = '';
  try {
    const out = execFileSync(bin, ['-V'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: VERIFY_TIMEOUT_MS,
      env: { PATH: '/usr/bin:/bin', LANG: 'C' },
    });
    let expected: string | undefined;
    try {
      const manifest = JSON.parse(readFileSync(join(root, 'current', 'manifest.json'), 'utf8'));
      if (typeof manifest?.release === 'string') expected = manifest.release;
    } catch { /* checked by the installer; here only the answer matters */ }
    const m = /^tmux (\S+)/.exec(String(out).trim());
    ok = !!m && (!expected || m[1] === expected);
    if (!ok) detail = `tmux -V answered ${JSON.stringify(String(out).trim().slice(0, 80))}`;
  } catch (err) {
    const e = err as { stderr?: unknown; message?: string };
    detail = String(e.stderr ?? '').trim().slice(0, 160) || e.message || 'failed to run';
  }
  if (!ok && (!cached || cached.key !== key || cached.ok)) {
    process.stderr.write(`[tmux-managed] not using ${bin}: ${detail}\n`);
  }
  verified.set(root, { key, ok, at: now });
  return ok;
}

/**
 * The managed bin dir when botmux has installed its own tmux AND it runs here,
 * else undefined (callers then use whatever tmux PATH finds). Ownership is
 * proven with hashes by the installer before anything is ever replaced.
 */
export function managedTmuxBinDirIfInstalled(
  root: string = managedTmuxRoot(),
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (fenced(env) || fenced(process.env)) return undefined;
  try {
    if (!lstatSync(join(root, 'current')).isSymbolicLink()) return undefined;
    const bin = managedTmuxBinDir(root);
    return verifiedRunnable(root, join(bin, 'tmux')) ? bin : undefined;
  } catch {
    return undefined;
  }
}
