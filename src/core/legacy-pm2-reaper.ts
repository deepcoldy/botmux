/**
 * Legacy pm2 reaper — a one-shot, self-contained cleanup for machines UPGRADING
 * from a pm2-based botmux to the built-in supervisor. botmux used to run its
 * multi-bot fleet under a dedicated pm2 God daemon (PM2_HOME=~/.botmux/pm2).
 * After the migration nothing spawns pm2, but an upgrading host may still have a
 * live pm2 God holding the OLD botmux daemon processes — which would double-run
 * alongside the new supervisor's daemons. `botmux start`/`restart` calls this to
 * detect that stale God and stop it, so the operator never has to `pm2 kill`
 * by hand (the chosen migration UX: auto-detect-and-stop, not just warn).
 *
 * SELF-CONTAINED by design: it does NOT import any of the removed pm2-* guard
 * modules. It shells out to the pm2 CLI directly, and is FAIL-SAFE — if pm2 is
 * not installed (the normal case for a fresh install, and always for the
 * compiled single binary), every step no-ops and the fleet comes up clean.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

/** A botmux core process name managed by the old pm2 ecosystem. */
function isBotmuxPm2Name(name: unknown): boolean {
  return typeof name === 'string'
    && (name === 'botmux' || (name.startsWith('botmux-') && !name.startsWith('botmux-plugin-')));
}

/** Resolve the pm2 CLI path, or null when pm2 isn't installed here. Prefers the
 *  package-bundled pm2 (if this build still has it on disk), else PATH `pm2`. */
function resolvePm2Bin(pkgRoot: string): string | null {
  const bundled = join(pkgRoot, 'node_modules', 'pm2', 'bin', 'pm2');
  if (existsSync(bundled)) return bundled;
  // Fall back to a PATH lookup; spawnSync with the bare name resolves via PATH.
  // We can't easily test-probe without running it, so return 'pm2' and let the
  // caller's spawnSync fail-safe (ENOENT → treated as "no pm2") handle absence.
  return 'pm2';
}

interface Pm2God {
  home: string;
  pid: number;
}

/**
 * Read a pm2 God's pid from its PM2_HOME/pm2.pid, if the God is alive.
 *
 * `pm2.pid` is the cheap, authoritative signal when present — but it is NOT
 * always there. MEASURED on this dev box: a God had been supervising 50 botmux
 * daemons for ~15 hours with NO pm2.pid in its PM2_HOME (only rpc.sock/pub.sock,
 * pids/, and the logs). pm2 writes that file at daemon launch and removes it on
 * shutdown, so a God whose file was cleaned up, rotated away, or never written by
 * an older pm2 is invisible to a pid-file-only probe.
 *
 * That miss is not benign: the reaper exists so `botmux start/restart` can stop a
 * pre-migration God before the new supervisor starts its OWN daemons. A silent
 * no-op here means both fleets run at once — every bot doubled, two processes
 * answering the same Feishu events.
 *
 * So fall back to the God's RPC socket, which is what the pm2 CLI itself connects
 * through. `pm2 jlist` succeeds against exactly this God with no pid file at all
 * (verified). We return pid 0 for a socket-only God: reaping drives everything
 * through the pm2 CLI (`delete`/`kill`), none of which needs the pid — it is only
 * reported for logging.
 */
function liveGodAt(home: string): Pm2God | null {
  const pidFile = join(home, 'pm2.pid');
  if (existsSync(pidFile)) {
    let pid = 0;
    try { pid = parseInt(readFileSync(pidFile, 'utf-8').trim(), 10); } catch { pid = 0; }
    if (Number.isSafeInteger(pid) && pid > 1) {
      try {
        process.kill(pid, 0);
        return { home, pid };
      } catch { /* stale pid file — fall through to the socket probe */ }
    }
  }
  // No usable pid file. A live God still owns its RPC socket; if that exists,
  // treat the God as present and let the pm2 CLI decide (a truly dead God's
  // `jlist` fails, which the caller already handles).
  if (existsSync(join(home, 'rpc.sock'))) return { home, pid: 0 };
  return null;
}

/** Parse `pm2 jlist` stdout (may be prefixed by log lines) into the app array. */
function parseJlist(stdout: string): Array<{ name?: unknown }> {
  try {
    const parsed = JSON.parse(stdout);
    if (Array.isArray(parsed)) return parsed;
  } catch { /* pm2 sometimes prefixes JSON with log lines; scan for the array */ }
  for (let start = stdout.lastIndexOf('['); start >= 0; start = stdout.lastIndexOf('[', start - 1)) {
    try {
      const parsed = JSON.parse(stdout.slice(start).trim());
      if (Array.isArray(parsed)) return parsed;
    } catch { /* try an earlier '[' */ }
  }
  return [];
}

export interface LegacyPm2ReapResult {
  /** True if a live legacy God was found and we attempted to reap it. */
  found: boolean;
  /** Bot process names we deleted from the God (best-effort). */
  deleted: string[];
  /** True if the God itself was killed. */
  killed: boolean;
  /** Human-readable note for logging (never throws). */
  note: string;
}

/**
 * Detect and stop a legacy botmux pm2 God, if one is live. Best-effort and
 * never throws: any pm2 invocation failure (including pm2 not installed) is
 * swallowed and reported in the result. Checks both the botmux-dedicated
 * PM2_HOME and the pm2 default (~/.pm2) since older installs used either.
 *
 * @param configDir  ~/.botmux (the botmux config dir).
 * @param pkgRoot    package root, to locate a bundled pm2 binary if present.
 * @param log        optional logger for progress lines.
 */
export function reapLegacyPm2(configDir: string, pkgRoot: string, log: (m: string) => void = () => {}): LegacyPm2ReapResult {
  const result: LegacyPm2ReapResult = { found: false, deleted: [], killed: false, note: '' };
  // The botmux-dedicated PM2_HOME is exclusively ours → safe to `pm2 kill` its
  // God. The shared default (~/.pm2) may host the user's OTHER apps, so there we
  // only `pm2 delete` botmux rows and NEVER `pm2 kill` (that would take down
  // every unrelated app the user runs under the default pm2).
  const homes: Array<{ home: string; exclusive: boolean }> = [
    { home: join(configDir, 'pm2'), exclusive: true },
    { home: join(homedir(), '.pm2'), exclusive: false },
  ];
  const pm2 = resolvePm2Bin(pkgRoot);
  if (!pm2) { result.note = 'pm2 not installed; nothing to reap'; return result; }

  for (const { home, exclusive } of homes) {
    const god = liveGodAt(home);
    if (!god) continue;
    const env = { ...process.env, PM2_HOME: home };

    // List botmux rows this God manages.
    const jlist = spawnSync(pm2, ['jlist'], { env, encoding: 'utf-8', timeout: 15_000 });
    if (jlist.error || jlist.status !== 0) {
      // Only a God actually holding botmux rows is "found" for our purposes; an
      // unreachable jlist at the shared home isn't necessarily a botmux concern.
      if (exclusive) {
        result.found = true;
        result.note = `pm2 jlist failed at ${home}: ${jlist.error?.message ?? `exit ${jlist.status}`}`;
        log(result.note);
      }
      continue;
    }
    const apps = parseJlist(jlist.stdout || '');
    const botmuxNames = apps.map((a) => a?.name).filter(isBotmuxPm2Name) as string[];

    // The shared default home is only our concern if it actually holds botmux
    // rows; a God with no botmux rows there belongs entirely to the user.
    if (!exclusive && botmuxNames.length === 0) continue;

    result.found = true;
    log(`legacy pm2 God detected (PM2_HOME=${home}, pid ${god.pid > 0 ? god.pid : 'unknown (no pm2.pid; detected via rpc.sock)'}, ${botmuxNames.length} botmux row(s)${exclusive ? '' : ', shared home'}); reaping`);

    // Delete each botmux row (best-effort, one at a time so one failure doesn't
    // abort the rest).
    for (const name of botmuxNames) {
      const del = spawnSync(pm2, ['delete', name], { env, encoding: 'utf-8', timeout: 15_000 });
      if (!del.error && del.status === 0) { result.deleted.push(name); log(`  pm2 delete ${name}`); }
      else log(`  pm2 delete ${name} failed: ${del.error?.message ?? `exit ${del.status}`}`);
    }

    // Kill the God ONLY when the home is exclusively botmux's. Never kill the
    // shared default God — deleting the botmux rows is enough there.
    if (exclusive) {
      const kill = spawnSync(pm2, ['kill'], { env, encoding: 'utf-8', timeout: 15_000 });
      if (!kill.error && kill.status === 0) { result.killed = true; log(`  pm2 kill (God at ${home})`); }
      else log(`  pm2 kill failed at ${home}: ${kill.error?.message ?? `exit ${kill.status}`}`);
    } else {
      log(`  left shared pm2 God at ${home} running (only botmux rows removed)`);
    }
  }

  if (!result.found) result.note = 'no live legacy pm2 God found';
  else if (!result.note) result.note = `reaped legacy pm2 (deleted ${result.deleted.length}, killed=${result.killed})`;
  return result;
}
