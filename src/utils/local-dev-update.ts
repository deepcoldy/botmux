/**
 * `botmux update` on a local-dev checkout: locate the checkout directory, then
 * git pull --ff-only → rebuild → restart from that same dir. Shared by the CLI
 * (`cmdUpgrade`, synchronous) and the dashboard (`/api/update/run`, async) so
 * the two never drift.
 *
 * The global `botmux` command runs through a thin wrapper at
 * `~/.botmux/bin/botmux`:
 *
 *   #!/bin/sh
 *   exec node "/path/to/checkout/dist/cli.js" "$@"
 *
 * Parsing the wrapper's `dist/cli.js` path (and walking up two levels) is the
 * most reliable way to find the checkout the user actually runs — more reliable
 * than the running process's own root, which under `pnpm daemon:restart` /
 * `switch:here` can be a different worktree than the one the wrapper points at.
 *
 * The pure helpers (string in, string out) resolve the checkout without
 * touching the filesystem, so they stay unit-testable; the thin I/O helpers
 * (read the wrapper, check the tree is clean) are shared side-effecting steps.
 */
import { execFileSync, type SpawnSyncReturns } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, posix, win32 } from 'node:path';
import { botmuxInstallRoot } from './install-info.js';

/**
 * Extract the botmux `dist/cli.js` path from a `~/.botmux/bin/botmux` wrapper's
 * text. The wrapper this repo generates has a fixed shape (see
 * scripts/claim-botmux-bin.mjs and the daemon):
 *
 *   #!/bin/sh
 *   exec node "<abs>/dist/cli.js" "$@"
 *
 * Match exactly that: a line that STARTS with `exec` (optional leading
 * whitespace only), a `node`/absolute-node-path command, then the quoted
 * absolute path ending in `dist/cli.js` (either separator, so Windows wrappers
 * work), then the trailing `"$@"`. Anchoring to line start + requiring `"$@"`
 * rejects a commented-out old command (`# old: exec node "…"`) or an `echo exec
 * node "…"` line that merely mentions the words. The captured path must also be
 * absolute (POSIX or Windows) — a relative target would resolve against the
 * shell's cwd at exec time but against the reader's cwd here, so the two could
 * name different checkouts; skip it. Returns null when no such line exists
 * (e.g. a hand-edited wrapper), letting callers fall back safely.
 */
export function parseWrapperCliEntry(wrapperText: string): string | null {
  // ^\s*exec  <node|/abs/node>  "<path…/dist/cli.js>"  "$@"
  const re = /^\s*exec\s+(?:\S*[\\/])?node(?:\.exe)?\s+"([^"]*[\\/]dist[\\/]cli\.js)"\s+"\$@"\s*$/;
  for (const line of wrapperText.split('\n')) {
    const match = line.match(re);
    if (match && (posix.isAbsolute(match[1]) || win32.isAbsolute(match[1]))) return match[1];
  }
  return null;
}

/**
 * Given the wrapper's `dist/cli.js` path, return the checkout root: two levels
 * up (`<root>/dist/cli.js` → `<root>`).
 */
export function checkoutDirFromCliEntry(cliEntry: string): string {
  return dirname(dirname(cliEntry));
}

/**
 * Resolve the checkout root directly from wrapper text, or null when the text
 * doesn't parse. Convenience composition of the two functions above.
 */
export function checkoutDirFromWrapperText(wrapperText: string): string | null {
  const cliEntry = parseWrapperCliEntry(wrapperText);
  return cliEntry ? checkoutDirFromCliEntry(cliEntry) : null;
}

/** Absolute path to the global thin wrapper written by `use:here` / daemon start. */
export function globalWrapperPath(): string {
  return join(homedir(), '.botmux', 'bin', 'botmux');
}

/** Is `dir` a botmux source checkout we may update: a git worktree whose
 *  package.json says it's botmux? Repo-identity guards against pulling/building
 *  an unrelated repo a hijacked wrapper path might point at. Deliberately does
 *  NOT require `dist/cli.js` — `bun run use:here` allows a fresh checkout without a
 *  build, and local-dev update is exactly what produces that dist. */
export function isBotmuxCheckout(dir: string): boolean {
  if (!existsSync(join(dir, '.git'))) return false;
  try {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf-8'));
    return pkg?.name === 'botmux';
  } catch {
    return false;
  }
}

/**
 * Locate the local-dev checkout to update: prefer the checkout the global
 * `botmux` wrapper points at (that's what the user actually runs), validated as
 * a botmux git worktree; otherwise fall back to this process's own install
 * root. Does NOT require the target to be built — the update builds it. The
 * caller still validates the result before running git.
 */
export function resolveLocalDevCheckoutDir(): string {
  try {
    const dir = checkoutDirFromWrapperText(readFileSync(globalWrapperPath(), 'utf-8'));
    if (dir && isBotmuxCheckout(dir)) return dir;
  } catch {
    // wrapper missing/unreadable → fall back to the running install root
  }
  return botmuxInstallRoot();
}

/** A checkout+HEAD pinned by a successful local-dev `/api/update/run`. */
export interface PendingLocalDevRestart {
  dir: string;
  /** Post-build HEAD sha of `dir`. */
  head: string;
}

export type LocalDevRestartDecision =
  /** Restart from `dir` (its cli.js exists and, if pinned, HEAD is unchanged). */
  | { action: 'restart'; dir: string }
  /** No pinned build and the live wrapper target has no cli.js — restart from
   *  the running process root instead (plain manual restart still works). */
  | { action: 'fallback-running-root' }
  /** A pinned build's target is gone / moved — fail closed, do not restart. */
  | { action: 'fail'; reason: 'update_target_unavailable' | 'update_target_drifted'; dir: string };

/**
 * Decide where a local-dev `/api/update/restart` should restart from. Pure over
 * injected probes so the run→restart handoff (including a wrapper flipped B→C by
 * a concurrent `use:here`) is unit-testable.
 *
 * - With a `pinned` plan (a preceding run built `pinned.dir`): require its
 *   cli.js to still exist AND HEAD to still equal the built HEAD; otherwise fail
 *   closed rather than restart a drifted/absent tree.
 * - Without a pinned plan (plain manual restart): use the live wrapper `target`
 *   if its cli.js exists, else fall back to the running root.
 */
export function resolveLocalDevRestartTarget(
  pinned: PendingLocalDevRestart | undefined,
  target: string,
  probes: { cliEntryExists: (dir: string) => boolean; headOf: (dir: string) => string },
): LocalDevRestartDecision {
  if (pinned) {
    if (!probes.cliEntryExists(pinned.dir)) {
      return { action: 'fail', reason: 'update_target_unavailable', dir: pinned.dir };
    }
    if (probes.headOf(pinned.dir) !== pinned.head) {
      return { action: 'fail', reason: 'update_target_drifted', dir: pinned.dir };
    }
    return { action: 'restart', dir: pinned.dir };
  }
  if (!probes.cliEntryExists(target)) return { action: 'fallback-running-root' };
  return { action: 'restart', dir: target };
}

/** Is `dir` a git worktree (has a `.git` dir or file)? */
export function isGitWorktree(dir: string): boolean {
  return existsSync(join(dir, '.git'));
}

/**
 * Read the porcelain working-tree status. Returns the trimmed output (empty =
 * clean). Throws if git is unavailable or the command fails — callers treat
 * that as "can't verify, abort" rather than "clean".
 */
export function gitPorcelainStatus(dir: string): string {
  return execFileSync('git', ['status', '--porcelain'], { cwd: dir, encoding: 'utf-8' }).trim();
}

/** Current HEAD commit sha of `dir` ('' if it can't be read). Used to decide
 *  whether a `git pull` actually advanced the checkout. */
export function gitHeadSha(dir: string): string {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf-8' }).trim();
  } catch {
    return '';
  }
}

/**
 * The ordered commands that make up a local-dev update, each in `dir`:
 *   1. git pull --ff-only  (fail closed on divergence/conflict — never merges)
 *   2. pnpm build          (dist/ is gitignored: a pull alone leaves stale code)
 * The restart is intentionally NOT here — the CLI and dashboard each apply it
 * through their own restart path (the dashboard reuses its lease + intent).
 */
export function localDevUpdateSteps(): Array<{ command: string; args: string[] }> {
  return [
    { command: 'git', args: ['pull', '--ff-only'] },
    { command: 'pnpm', args: ['build'] },
  ];
}

/** Format a spawnSync failure into a readable message. Shared by callers that
 *  run the steps synchronously with stdio inherited. */
export function describeSpawnFailure(
  command: string,
  args: string[],
  result: SpawnSyncReturns<Buffer>,
): string {
  if (result.error) return result.error.message;
  return `\`${command} ${args.join(' ')}\` 退出码 ${result.status ?? result.signal ?? 'unknown'}`;
}
