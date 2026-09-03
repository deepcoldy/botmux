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
 * modules. When a pm2 CLI is reachable it drives pm2 directly; when it is NOT
 * (the compiled single binary bundles no pm2, and a source install may have none
 * on PATH) it falls back to the God's own `pids/` records and signals those
 * processes itself. Either way it is FAIL-SAFE — a fresh install with no legacy
 * God no-ops entirely — but it never reports success it cannot back up: see
 * `unresolved` on the result.
 *
 * PROCESS AND SOCKET FACTS COME FROM `/proc` ON LINUX, not from `ps`/`lsof`. We
 * ship a musl (Alpine) binary where both are BusyBox applets with different
 * semantics — `ps` rejects `-p`, and `lsof` ignores its path argument entirely —
 * which silently disabled every guard here. `/proc` is a kernel interface that
 * behaves identically under glibc and musl. macOS keeps the `ps`/`lsof` paths.
 * See `cmdlineOf`, `isAlive` and `rpcSocketHeld` for the measurements.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { isStandaloneBinary } from './self-spawn.js';

/** A botmux core process name managed by the old pm2 ecosystem. */
function isBotmuxPm2Name(name: unknown): boolean {
  return typeof name === 'string'
    && (name === 'botmux' || (name.startsWith('botmux-') && !name.startsWith('botmux-plugin-')));
}

/**
 * Resolve the pm2 CLI path, or null when pm2 isn't usable here.
 *
 * COMPILED BINARY: `pkgRoot` is derived from `__dirname`, which for the
 * standalone build lives in the virtual `/$bunfs/` — so the bundled probe below
 * resolves to a path that does not exist on disk (MEASURED with a probe binary:
 * PKG_ROOT came out as `/private`). That is the documented `__dirname` hazard in
 * CLAUDE.md. Returning a bare `'pm2'` there was actively harmful: it looks like
 * a resolved CLI, every subsequent spawn fails ENOENT, the failures are
 * swallowed as "best effort", and the legacy God survives a `botmux restart` —
 * both fleets then answer the same Feishu events. So report null and let the
 * caller use the CLI-less fallback.
 */
function resolvePm2Bin(pkgRoot: string): string | null {
  const bundled = join(pkgRoot, 'node_modules', 'pm2', 'bin', 'pm2');
  if (existsSync(bundled)) return bundled;
  // No bundled pm2. A PATH lookup is only meaningful for a source/npm install;
  // the compiled binary ships no pm2 and must not pretend otherwise.
  if (isStandaloneBinary()) return null;
  // Probe PATH rather than returning a hopeful 'pm2': knowing now whether the
  // CLI exists lets the caller pick the fallback instead of discovering it
  // through a chain of swallowed ENOENTs.
  //
  // PM2_HOME IS MANDATORY HERE, even though this only asks for a version.
  // `pm2 --version` is NOT read-only: it DAEMONIZES a God (MEASURED — "Spawning
  // PM2 daemon with pm2_home=… / PM2 Successfully daemonized"). Inheriting the
  // ambient env would create that God in whatever home the caller happens to
  // point at: ~/.botmux/pm2 (which this reaper then "finds and kills" — it would
  // report a legacy fleet on a machine that never had one) or the SHARED ~/.pm2
  // that the rest of this module takes pains never to touch. Every other pm2
  // invocation in the repo passes an explicit PM2_HOME; this one must too.
  // A throwaway dir keeps any God the probe spawns isolated and disposable.
  const probeHome = join(tmpdir(), `botmux-pm2-probe-${process.pid}`);
  const probe = spawnSync('pm2', ['--version'], {
    encoding: 'utf-8', timeout: 15_000,
    env: { ...process.env, PM2_HOME: probeHome },
  });
  // Stop and remove whatever the probe may have started, so it never outlives
  // this call. Best-effort: a leftover temp dir is harmless either way.
  if (!probe.error) {
    spawnSync('pm2', ['kill'], { encoding: 'utf-8', timeout: 15_000, env: { ...process.env, PM2_HOME: probeHome } });
  }
  try { rmSync(probeHome, { recursive: true, force: true }); } catch { /* best effort */ }
  if (probe.error || probe.status !== 0) return null;
  return 'pm2';
}

/** A pm2-era botmux daemon process, recovered from PM2_HOME/pids/. */
interface LegacyProc {
  /** pm2 app name, e.g. `botmux-0` (the pid file's basename). */
  name: string;
  pid: number;
}

/**
 * Recover the legacy fleet's processes from `PM2_HOME/pids/` — the CLI-less path.
 *
 * pm2 writes one `pids/<name>.pid` per app, and those files are the same records
 * `pm2` itself would report. Reading them directly is what makes reaping possible
 * with no pm2 binary anywhere (the compiled-binary case).
 *
 * Each pid is verified against its own cmdline before being returned. A pid file
 * can outlive its process and the number may have been recycled into something
 * unrelated, so signalling on the file's word alone would eventually kill a
 * bystander. Only processes that still look like a pm2-era botmux daemon
 * (`dist/index-daemon.js` / `index-dashboard.js`) are eligible.
 */
function legacyProcsFromPidsDir(home: string): LegacyProc[] {
  let entries: string[];
  try { entries = readdirSync(join(home, 'pids')); } catch { return []; }
  const out: LegacyProc[] = [];
  for (const file of entries) {
    if (!file.endsWith('.pid')) continue;
    const name = file.slice(0, -'.pid'.length);
    if (!isBotmuxPm2Name(name.replace(/-\d+$/, '')) && !isBotmuxPm2Name(name)) continue;
    let pid = 0;
    try { pid = parseInt(readFileSync(join(home, 'pids', file), 'utf-8').trim(), 10); } catch { continue; }
    if (!Number.isSafeInteger(pid) || pid <= 1) continue;
    if (!isAlive(pid)) continue;                      // already gone (or a zombie)
    if (!looksLikeLegacyBotmuxDaemon(pid)) continue;  // pid reuse guard
    out.push({ name, pid });
  }
  return out;
}

/** Does `pid`'s command line still look like a pm2-era botmux daemon? Guards
 *  against pid reuse before we signal anything. Unreadable cmdline → false
 *  (fail closed: never signal what we cannot identify). */
function looksLikeLegacyBotmuxDaemon(pid: number): boolean {
  const cmd = cmdlineOf(pid);
  return cmd.includes('index-daemon') || cmd.includes('index-dashboard');
}

/** Is `pid` actually a pm2 God daemon? Same pid-reuse guard as above: the pid
 *  comes from a file that may be stale, and this one gets SIGKILL. pm2 titles
 *  its God process "PM2 ... God Daemon". */
function looksLikePm2God(pid: number): boolean {
  return /PM2\b.*God Daemon/i.test(cmdlineOf(pid));
}

/**
 * `pid`'s command line, or '' when it cannot be read.
 *
 * LINUX READS `/proc`, NOT `ps`. The daemon runs on Linux and we ship a musl
 * (Alpine) binary, where `ps` is a BusyBox applet that does not support `-p`:
 * MEASURED in node:22-alpine, `ps -p <pid> -o command=` exits 1 with no output.
 * Every caller of this function treats '' as "cannot identify" and fails closed,
 * so on musl the pid-reuse guards rejected EVERY process — `legacyProcsFromPidsDir`
 * always came back empty and the whole CLI-less reap silently no-opped. `/proc` is
 * a kernel interface, identical under glibc and musl (verified in both), and needs
 * no subprocess at all.
 *
 * `/proc/<pid>/cmdline` is NUL-separated; join with spaces so the substring checks
 * above read like a command line. A ZOMBIE has an EMPTY cmdline (verified) — which
 * is the correct answer here: we must not signal something we cannot identify.
 */
function cmdlineOf(pid: number): string {
  if (process.platform === 'linux') {
    try {
      const raw = readFileSync(`/proc/${pid}/cmdline`, 'utf-8');
      return raw.replace(/\0+$/, '').split('\0').join(' ').trim();
    } catch { return ''; }   // no such pid, or unreadable → cannot identify
  }
  // macOS/BSD: no /proc. `ps` there is the real thing and supports -p.
  const ps = spawnSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf-8', timeout: 5_000 });
  if (ps.error || ps.status !== 0) return '';
  return (ps.stdout || '').trim();
}

/** Stop `procs` with SIGTERM, then SIGKILL whatever is still up. Returns the
 *  names actually confirmed down, so the caller never over-reports success. */
function stopProcs(procs: LegacyProc[], log: (m: string) => void): string[] {
  for (const { name, pid } of procs) {
    try { process.kill(pid, 'SIGTERM'); log(`  SIGTERM ${name} (pid ${pid})`); } catch { /* already gone */ }
  }
  // Give them a moment to exit on their own before escalating.
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline && procs.some(({ pid }) => isAlive(pid))) {
    try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100); } catch { break; }
  }
  for (const { name, pid } of procs) {
    if (!isAlive(pid)) continue;
    try { process.kill(pid, 'SIGKILL'); log(`  SIGKILL ${name} (pid ${pid})`); } catch { /* raced */ }
  }
  return procs.filter(({ pid }) => !isAlive(pid)).map(({ name }) => name);
}

/** Is `pid` a live process we should still act on?
 *
 *  `kill(pid, 0)` alone is NOT enough: it succeeds for a ZOMBIE (exited, but its
 *  parent has not reaped it), so a process we just killed can still look alive
 *  and make the reaper report failure — MEASURED in this suite, where the killed
 *  daemons stayed "alive" for the full escalation window. It matters in
 *  production too: when the pm2 God dies before its children, they are zombies
 *  until init adopts and reaps them. A zombie holds no ports, no sqlite handle,
 *  and consumes no Feishu events — for our purposes it is down.
 *
 *  LINUX READS `/proc` for the same reason as `cmdlineOf`: BusyBox `ps` rejects
 *  `-p`, so on musl this fell through to the `kill(0)` answer and called every
 *  zombie alive. MEASURED in node:22-alpine on a real zombie (a `sh` parent that
 *  never wait()s): `kill(pid,0)` → true, `ps -p -o stat=` → exit 1, while
 *  `/proc/<pid>/stat` → 'Z'. */
function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); } catch { return false; }
  if (process.platform === 'linux') {
    const state = procState(pid);
    if (state === null) return true;   // unreadable → keep the kill(0) answer
    if (state === '') return false;    // no longer in /proc → gone
    return state !== 'Z';              // zombie → effectively down
  }
  const ps = spawnSync('ps', ['-p', String(pid), '-o', 'stat='], { encoding: 'utf-8', timeout: 5_000 });
  // If ps cannot tell us, fall back to the kill(0) answer (true) rather than
  // claiming a live process is gone.
  if (ps.error || ps.status !== 0) return true;
  const stat = (ps.stdout || '').trim();
  if (!stat) return false;             // no longer in the table → gone
  return !stat.startsWith('Z');        // 'Z'/'Z+' → zombie → effectively down
}

/**
 * The process state character from `/proc/<pid>/stat` ('R'/'S'/'Z'/…), '' when the
 * pid is gone, or null when /proc could not be read at all.
 *
 * Parsing note: state is field 3, but field 2 (`comm`) is wrapped in parentheses
 * and MAY ITSELF CONTAIN spaces and parentheses, so a naive `split(' ')[2]` is
 * wrong for a process whose name is e.g. `(my app)`. Scan past the LAST ')'.
 */
function procState(pid: number): string | null {
  let raw: string;
  try { raw = readFileSync(`/proc/${pid}/stat`, 'utf-8'); }
  catch (err) {
    // ENOENT means the pid is genuinely gone; anything else (EACCES, /proc not
    // mounted) is "cannot tell" and must not be read as "gone".
    return (err as NodeJS.ErrnoException)?.code === 'ENOENT' ? '' : null;
  }
  const close = raw.lastIndexOf(')');
  if (close < 0) return null;                       // unexpected shape → cannot tell
  return raw.slice(close + 1).trim().split(/\s+/)[0] || null;
}

/**
 * Delete a stopped God's leftover records so detection cannot resurrect it.
 *
 * Both files this removes are what `liveGodAt` reads, and a successful reap
 * invalidates both — but nothing else deletes them on the CLI-less path:
 *
 *  • `rpc.sock` outlives even a real `pm2 kill` (MEASURED right after this reaper
 *    first stopped a live fleet), so an existence-only probe reported the dead God
 *    as live on every later command.
 *  • `pm2.pid` is removed by `pm2 kill`, but the signal path has no pm2 to do it.
 *    MEASURED: the file kept naming the God we had just killed, and since it was a
 *    ZOMBIE at that moment `kill(pid, 0)` still succeeded — so `status` reported a
 *    live God and re-running `restart` could never clear the warning.
 *
 * Either way the operator is told to run a migration that already completed, with
 * no way to make the message stop. Called only after the God is confirmed down,
 * and each file is re-checked here so one that is genuinely still in use (a pid
 * that is live, a socket someone holds) is never removed.
 */
function removeStaleGodRecords(home: string, log: (m: string) => void): void {
  const sock = join(home, 'rpc.sock');
  if (existsSync(sock) && !rpcSocketHeld(sock)) {
    try { rmSync(sock, { force: true }); log(`  removed orphaned rpc.sock at ${home}`); }
    catch { /* best effort: a leftover record only costs a stale warning */ }
  }
  const pidFile = join(home, 'pm2.pid');
  if (!existsSync(pidFile)) return;
  let pid = 0;
  try { pid = parseInt(readFileSync(pidFile, 'utf-8').trim(), 10); } catch { pid = 0; }
  // A live pid means something owns this file now (a fresh God, or pid reuse) —
  // leave it alone. Unreadable/garbage counts as stale.
  if (Number.isSafeInteger(pid) && pid > 1 && isAlive(pid)) return;
  try { rmSync(pidFile, { force: true }); log(`  removed stale pm2.pid at ${home}`); }
  catch { /* best effort */ }
}

export interface Pm2God {
  home: string;
  /** The God's pid, or 0 when it was found via its RPC socket alone (no pidfile). */
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
 *
 * The socket's EXISTENCE is not enough, though: `pm2 kill` removes pm2.pid but
 * leaves rpc.sock behind — MEASURED right after this reaper first stopped a real
 * fleet. An existence-only probe then reports the dead God as live on every
 * subsequent command, so `status` keeps telling the operator to run a migration
 * that already completed, and re-running it can never clear the warning. So probe
 * whether a process actually HOLDS the socket.
 *
 * The pid check goes through `isAlive`, not a bare `kill(pid, 0)`, for the same
 * reason: right after a reap the God is a ZOMBIE until its parent reaps it, and
 * `kill(pid, 0)` succeeds for a zombie — MEASURED, that alone made a
 * just-killed God read as live and put the stale warning back.
 *
 * EXPORTED because `status`/`logs` print an operator-facing "legacy pm2 still
 * running" warning off the same question. They used to answer it with their own
 * copy of this logic, which drifted: the warning outlived a successful reap. One
 * detector means the warning and the reaper cannot disagree.
 */
export function liveGodAt(home: string): Pm2God | null {
  const pidFile = join(home, 'pm2.pid');
  if (existsSync(pidFile)) {
    let pid = 0;
    try { pid = parseInt(readFileSync(pidFile, 'utf-8').trim(), 10); } catch { pid = 0; }
    if (Number.isSafeInteger(pid) && pid > 1 && isAlive(pid)) return { home, pid };
    // Stale or zombie pid → fall through to the socket probe.
  }
  // No usable pid file. A live God still owns its RPC socket — but only a socket
  // a process is actually HOLDING proves that. See the note above on orphans.
  if (rpcSocketHeld(join(home, 'rpc.sock'))) return { home, pid: 0 };
  return null;
}

/**
 * Is a live pm2 God actually holding this RPC socket?
 *
 * Distinguishes a real God from the orphaned `rpc.sock` that `pm2 kill` leaves
 * behind. `existsSync` cannot: MEASURED on a socket whose listener was SIGKILLed,
 * the file survives and `statSync().isSocket()` is still true (verified under both
 * glibc and musl).
 *
 * LINUX READS `/proc/net/unix`, NOT `lsof`. `lsof <path>` looks like the right
 * tool but is wrong on two counts here:
 *
 *  • On Alpine `lsof` EXISTS as a BusyBox applet that IGNORES the path argument
 *    entirely — it dumps every open file and exits 0. MEASURED in node:22-alpine:
 *    `lsof -- /tmp/does-not-exist.sock` → exit 0 with a full dump, so the
 *    `status === 0 && stdout` test was UNCONDITIONALLY true and an orphan read as
 *    held. That put the stale "legacy pm2 still running" warning right back on
 *    musl — the very thing this detector exists to prevent.
 *  • `lsof` is not always installed at all (MEASURED: absent in debian:12-slim),
 *    which fails closed into the same permanent warning.
 *
 * `/proc/net/unix` is the kernel's own list of bound unix sockets: a socket a
 * process holds appears with its path; an orphaned FILE does not. Verified against
 * a real SIGKILLed listener (the exact shape `pm2 kill` leaves) under BOTH glibc
 * and musl. No subprocess, no external tool, ~microseconds instead of ~1.5s.
 *
 * Fails CLOSED when `/proc/net/unix` cannot be read: we keep the existence-only
 * answer, so a live socket-only God is never missed (the hazard `f2c9f7b5` fixed).
 * The cost is only a stale warning, never a double-run.
 */
function rpcSocketHeld(sockPath: string): boolean {
  if (!existsSync(sockPath)) return false;
  if (process.platform === 'linux') {
    const bound = boundUnixSocketPaths();
    if (bound === null) return true;              // cannot tell → fail closed
    return bound.has(sockPath);
  }
  // macOS/BSD: no /proc/net/unix. Real lsof there honours the path argument.
  const r = spawnSync('lsof', ['--', sockPath], { encoding: 'utf-8', timeout: 5_000 });
  if (r.error) return true;                       // no lsof → fail closed
  if (r.status === 0 && (r.stdout || '').trim()) return true;
  return false;                                   // exit 1 / empty → orphan
}

/**
 * Paths of all bound unix sockets, per `/proc/net/unix`, or null if unreadable.
 *
 * Format is a header line plus one row per socket; the PATH is the last field and
 * is absent for unnamed sockets. A path may contain spaces, so take everything
 * after the 7th whitespace-separated field rather than the last token. Abstract
 * sockets start with '@' and are not filesystem paths — they can never match a
 * `rpc.sock` file, so they are simply kept as-is and never compared equal.
 */
function boundUnixSocketPaths(): Set<string> | null {
  let raw: string;
  try { raw = readFileSync('/proc/net/unix', 'utf-8'); } catch { return null; }
  const out = new Set<string>();
  const lines = raw.split('\n');
  for (const line of lines) {
    if (!line || line.startsWith('Num')) continue;   // header
    // Num RefCount Protocol Flags Type St Inode Path  → 7 fields then the path.
    const m = /^\s*\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+(.+)$/.exec(line);
    if (m) out.add(m[1].trim());
  }
  return out;
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
  /**
   * True when a legacy fleet may STILL be running after this call — i.e. we found
   * a God in the botmux-exclusive home and could not confirm its daemons are
   * down. Distinct from `!killed`, which is also the normal, correct outcome for
   * the SHARED ~/.pm2 home (whose God is deliberately left alive).
   *
   * Callers use this to warn the operator before starting a second fleet: a
   * silent failure here means two fleets consuming the same Feishu events and
   * the same session sqlite.
   */
  unresolved: boolean;
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
  const result: LegacyPm2ReapResult = { found: false, deleted: [], killed: false, unresolved: false, note: '' };
  // The botmux-dedicated PM2_HOME is exclusively ours → safe to `pm2 kill` its
  // God. The shared default (~/.pm2) may host the user's OTHER apps, so there we
  // only `pm2 delete` botmux rows and NEVER `pm2 kill` (that would take down
  // every unrelated app the user runs under the default pm2).
  const homes: Array<{ home: string; exclusive: boolean }> = [
    { home: join(configDir, 'pm2'), exclusive: true },
    { home: join(homedir(), '.pm2'), exclusive: false },
  ];
  const pm2 = resolvePm2Bin(pkgRoot);

  for (const { home, exclusive } of homes) {
    const god = liveGodAt(home);
    if (!god) continue;

    // ── No usable pm2 CLI: reap from the God's own pid files ─────────────────
    // This is the compiled-binary path (no bundled pm2, none on PATH). Skipped
    // for the SHARED home: signalling processes there without pm2's roster risks
    // touching the user's unrelated apps, and we must never kill that God.
    if (!pm2) {
      if (!exclusive) {
        log(`no pm2 CLI; leaving shared pm2 God at ${home} alone`);
        continue;
      }
      result.found = true;
      const procs = legacyProcsFromPidsDir(home);
      if (procs.length === 0) {
        // A live God we cannot prove anything about. Say so plainly rather than
        // reporting success — the caller must be able to tell the old fleet may
        // still be consuming the same Feishu events.
        result.unresolved = true;
        result.note = `no pm2 CLI available and no reapable botmux pids under ${home}; `
          + 'legacy pm2 God may still be running';
        log(result.note);
        continue;
      }
      log(`legacy pm2 God detected (PM2_HOME=${home}, pid ${god.pid > 0 ? god.pid : 'unknown'}, `
        + `${procs.length} botmux proc(s) from pids/); no pm2 CLI — reaping by signal`);

      // ORDER MATTERS: stop the God FIRST. Restarting dead children is exactly
      // what a pm2 God does, so killing the daemons while it is still alive just
      // makes it respawn them — MEASURED with a compiled probe binary: the daemon
      // was SIGTERMed, came back, and the reaper still reported it deleted.
      if (god.pid > 0 && isAlive(god.pid) && looksLikePm2God(god.pid)) {
        result.killed = stopProcs([{ name: 'pm2 God', pid: god.pid }], log).length > 0;
        if (result.killed) removeStaleGodRecords(home, log);
        if (!result.killed) {
          // A God we could not stop will undo everything below. Don't touch the
          // daemons: leaving the old fleet whole and reporting it is safer than a
          // half-killed fleet that keeps flapping.
          result.unresolved = true;
          result.note = `could not stop legacy pm2 God (pid ${god.pid}) at ${home}; `
            + 'left its daemons alone to avoid a respawn loop';
          log(result.note);
          continue;
        }
      } else if (god.pid <= 0) {
        // Socket-only God: no pid to signal and no CLI to ask it to stop. It may
        // respawn whatever we kill, so treat the outcome as unproven.
        result.unresolved = true;
        log('  God pid unknown (no pm2.pid) and no pm2 CLI — cannot stop the God itself');
      }

      // God is down (or unidentifiable but pidless) → now the daemons stay down.
      result.deleted.push(...stopProcs(procs, log));
      const stillUp = procs.filter(({ pid }) => isAlive(pid));
      if (stillUp.length > 0) {
        result.unresolved = true;
        result.note = `${stillUp.length} legacy botmux proc(s) survived SIGKILL at ${home}`;
        log(result.note);
      }
      continue;
    }

    const env = { ...process.env, PM2_HOME: home };

    // List botmux rows this God manages.
    const jlist = spawnSync(pm2, ['jlist'], { env, encoding: 'utf-8', timeout: 15_000 });
    if (jlist.error || jlist.status !== 0) {
      // Only a God actually holding botmux rows is "found" for our purposes; an
      // unreachable jlist at the shared home isn't necessarily a botmux concern.
      if (exclusive) {
        result.found = true;
        result.unresolved = true;
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
      if (!kill.error && kill.status === 0) {
        result.killed = true; log(`  pm2 kill (God at ${home})`);
        removeStaleGodRecords(home, log);
      }
      else { result.unresolved = true; log(`  pm2 kill failed at ${home}: ${kill.error?.message ?? `exit ${kill.status}`}`); }
    } else {
      log(`  left shared pm2 God at ${home} running (only botmux rows removed)`);
    }
  }

  if (!result.found) result.note = 'no live legacy pm2 God found';
  else if (!result.note) result.note = `reaped legacy pm2 (deleted ${result.deleted.length}, killed=${result.killed})`;
  return result;
}
