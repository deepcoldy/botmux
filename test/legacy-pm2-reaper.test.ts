import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, chmodSync, readFileSync, existsSync, statSync, accessSync, constants as fsConstants } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:net';
import { reapLegacyPm2, liveGodAt } from '../src/core/legacy-pm2-reaper.js';
import { resolveNodeExecutable } from './helpers/ts-runner.js';

const dirs: string[] = [];
function tmp(): string { const d = mkdtempSync(join(tmpdir(), 'legacy-pm2-')); dirs.push(d); return d; }

// HERMETIC HOME: reapLegacyPm2 also scans homedir()/.pm2 (the shared default pm2
// home). On a machine whose real ~/.pm2 has a live pm2 God (e.g. CI/dev boxes
// running production pm2), leaving HOME unset would let that real God leak into
// every test. Point HOME at a fresh temp dir so the shared-home scan is empty
// unless a test explicitly populates it.
//
// CAVEAT, measured: on macOS `os.homedir()` ignores $HOME (it reads getpwuid()),
// so this override only isolates the reaper on Linux. The tests that must see a
// specific shared home therefore assert via the pm2 call log rather than relying
// on the override alone. Our real ~/.pm2 has no God, so the scan is inert here.
let savedHome: string | undefined;

// HERMETIC PATH: `bun run`/`npm test` prepend node_modules/.bin, where this repo's
// dev-dependency pm2 shim lives — so a bare `pm2` ALWAYS resolves under the test
// runner. That silently hid the production bug this suite now covers: the compiled
// binary has no bundled pm2 and no pm2 on PATH, and resolvePm2Bin's PATH fallback
// was never exercisable in a test.
//
// FILTER BY CAPABILITY, NOT BY NAME. Stripping segments literally named
// `node_modules/.bin` only makes pm2 unreachable when that is its ONLY source —
// true on CI, FALSE on any box with a global pm2. MEASURED on a dev box with pm2
// installed under a version manager: these tests failed 5/17 there while CI was
// green and the author saw 17/17 — three honest observations of the same suite.
// So drop every PATH segment that actually CONTAINS an executable pm2; tests that
// want a working pm2 plant one under pkgRoot instead.
let savedPath: string | undefined;
let savedPm2Home: string | undefined;
function pathWithoutPm2(rawPath: string): string {
  return rawPath
    .split(':')
    .filter((seg) => {
      if (!seg) return false;
      try { accessSync(join(seg, 'pm2'), fsConstants.X_OK); return false; } catch { return true; }
    })
    .join(':');
}
beforeEach(() => {
  savedHome = process.env.HOME;
  process.env.HOME = tmp();
  savedPath = process.env.PATH;
  process.env.PATH = pathWithoutPm2(savedPath ?? '');
  // A pm2 the probe could reach would daemonize a God in whatever PM2_HOME the
  // ambient env names — including this box's real ~/.botmux/pm2. Belt and braces
  // alongside the PATH filter above.
  savedPm2Home = process.env.PM2_HOME;
  delete process.env.PM2_HOME;
});
afterEach(() => {
  if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
  if (savedPath === undefined) delete process.env.PATH; else process.env.PATH = savedPath;
  if (savedPm2Home === undefined) delete process.env.PM2_HOME; else process.env.PM2_HOME = savedPm2Home;
  // Kill whole process groups first: a group leader's grandchildren are not in
  // `spawned` and would otherwise survive as orphans.
  for (const pid of groupLeaders.splice(0)) {
    try { process.kill(-pid, 'SIGKILL'); } catch { /* group already gone */ }
  }
  for (const p of spawned.splice(0)) { try { p.kill('SIGKILL'); } catch { /* already gone */ } }
  for (const s of servers.splice(0)) { try { s.close(); } catch { /* already closed */ } }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Write an executable fake `pm2` at <pkgRoot>/node_modules/pm2/bin/pm2 that
 *  records its args and emits scripted stdout per subcommand. */
function fakePm2(pkgRoot: string, opts: { jlist: string }): string {
  const binDir = join(pkgRoot, 'node_modules', 'pm2', 'bin');
  mkdirSync(binDir, { recursive: true });
  const logFile = join(pkgRoot, 'pm2-calls.log');
  const bin = join(binDir, 'pm2');
  // A tiny node shim: append the subcommand to the log, print jlist JSON for jlist.
  writeFileSync(bin, [
    '#!/usr/bin/env node',
    `const fs=require('fs');`,
    `const args=process.argv.slice(2);`,
    `fs.appendFileSync(${JSON.stringify(logFile)}, args.join(' ')+'\\n');`,
    `if(args[0]==='jlist'){process.stdout.write(${JSON.stringify(opts.jlist)});}`,
    `process.exit(0);`,
  ].join('\n'), { mode: 0o755 });
  chmodSync(bin, 0o755);
  return logFile;
}

/** Create a live pm2 God pidfile pointing at our own (alive) pid. */
function liveGodPidfile(home: string): void {
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, 'pm2.pid'), String(process.pid));
}

/** A live God that has NO pm2.pid — only its RPC socket, WITH a real listener.
 *  This is the shape MEASURED on the dev box: a God supervising 50 botmux daemons
 *  for ~15 hours with no pidfile in its PM2_HOME. The listener matters: detection
 *  now probes the socket rather than trusting its mere existence. */
function liveGodSocketOnly(home: string): void {
  mkdirSync(home, { recursive: true });
  listenOnUnixSocket(join(home, 'rpc.sock'));
}

/** An ORPHANED rpc.sock: the file is there but nothing listens.
 *
 *  `pm2 kill` removes pm2.pid but leaves this socket behind — MEASURED after a
 *  successful reap on this box. An existence-only probe then reports the dead God
 *  as live forever, so `status` keeps telling the operator to run a migration that
 *  already completed. */
function orphanGodSocket(home: string): void {
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, 'rpc.sock'), ''); // plain file: connect() must fail
}

/** Bind a real unix socket server at `p` and keep it for teardown. */
function listenOnUnixSocket(p: string): void {
  const srv = createServer(() => { /* accept and ignore */ });
  srv.listen(p);
  servers.push(srv);
}

/**
 * A REAL orphaned socket: a child process binds `home/rpc.sock`, then is SIGKILLed
 * so the socket FILE survives with no owner. This is exactly what `pm2 kill` leaves
 * behind, and it is a stronger fixture than a plain regular file — `statSync().
 * isSocket()` is still true here (MEASURED under both glibc and musl), so a probe
 * that merely checks "is this a socket file" cannot tell it from a live God.
 * Returns once the file exists and its creator is gone.
 */
function realOrphanGodSocket(home: string): void {
  mkdirSync(home, { recursive: true });
  const sock = join(home, 'rpc.sock');
  const child = spawn(process.execPath, ['-e',
    `const net=require('net');const s=net.createServer(()=>{});`
    + `s.listen(${JSON.stringify(sock)},()=>process.stdout.write('READY'));setTimeout(()=>{},60_000);`],
    { stdio: ['ignore', 'pipe', 'ignore'] });
  spawned.push(child);
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline && !existsSync(sock)) spinMs(25);
  child.kill('SIGKILL');
  // Wait for the owner to actually be gone, else we would be testing a live socket.
  const gone = Date.now() + 5_000;
  while (Date.now() < gone) {
    try { process.kill(child.pid!, 0); } catch { break; }
    spinMs(25);
  }
  spinMs(150);
}

// ── Fixtures for the CLI-less fallback ──────────────────────────────────────
const spawned: ChildProcess[] = [];
/** Pids spawned as process-group leaders (detached). Teardown signals the whole
 *  group so a fixture that forks grandchildren cannot leave orphans behind —
 *  an unbounded respawning fixture once exhausted this machine's processes. */
const groupLeaders: number[] = [];
/** Unix-socket servers standing in for a live God's RPC channel. */
const servers: Server[] = [];

/** Spawn `n` throwaway processes whose cmdline looks like a pm2-era botmux
 *  daemon (`.../dist/index-daemon.js`), so the reaper's cmdline check accepts
 *  them. They sleep until killed. */
function spawnSleepers(n: number): number[] {
  return spawnTagged(n, '/fake/dist/index-daemon.js');
}

/** Spawn a process whose cmdline has NOTHING to do with botmux — stands in for a
 *  recycled pid that a stale pids/ file now points at. */
function spawnBystander(): number {
  return spawnTagged(1, '/usr/local/share/totally-unrelated-service')[0];
}

function spawnTagged(n: number, tag: string, script = 'setTimeout(()=>{},60_000)',
                    opts: { group?: boolean } = {}): number[] {
  const pids: number[] = [];
  // bun test 下 process.execPath 是 bun，子进程起来比 Node 慢，reaper 同步读
  // /proc/cmdline 会拿到空串 → looksLikeLegacyBotmuxDaemon 失败 → deleted=[]。
  // 等 cmdline 真的带上 tag 再返回；解释器也钉成 Node，和 Linux daemon 一致。
  const runner = resolveNodeExecutable() ?? process.execPath;
  for (let i = 0; i < n; i++) {
    // The trailing arg only shapes the visible cmdline; the file need not exist
    // since the script itself comes from -e.
    const p = spawn(runner, ['-e', script, tag], { stdio: 'ignore', detached: !!opts.group });
    if (opts.group) groupLeaders.push(p.pid!);
    spawned.push(p);
    pids.push(p.pid!);
    waitForCmdline(p.pid!, tag);
  }
  return pids;
}

/** Block until /proc (or ps) shows `needle` in pid's argv. Empty cmdline is
 *  how the reaper fail-closes; returning early is what flakes deleted=[]. */
function waitForCmdline(pid: number, needle: string, ms = 2_000): void {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    let cmd = '';
    if (process.platform === 'linux') {
      try { cmd = readFileSync(`/proc/${pid}/cmdline`, 'utf-8').replace(/\0/g, ' '); } catch { /* not yet */ }
    } else {
      const ps = spawnSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf-8' });
      cmd = ps.stdout || '';
    }
    if (cmd.includes(needle) && alive(pid)) return;
    spinMs(20);
  }
  throw new Error(`pid ${pid} cmdline never contained ${JSON.stringify(needle)}`);
}

/** Block for `ms` without an async boundary — these tests drive a synchronous
 *  reaper and need real elapsed time for signals/respawns to land. */
function spinMs(ms: number): void {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* no SAB */ }
}

/** pm2 records one pid file per app as `pids/<name>-<id>.pid`. */
function writePm2AppPid(home: string, appName: string, pid: number): void {
  const dir = join(home, 'pids');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${appName}.pid`), String(pid));
}

/** Is `pid` still a running process? Mirrors the reaper's own liveness notion:
 *  `kill(pid, 0)` succeeds for a ZOMBIE too, and every process spawned here is
 *  our child — once killed it stays a zombie until vitest's loop reaps it, so a
 *  bare kill(0) would report our reaped daemons as still alive. */
function alive(pid: number): boolean {
  try { process.kill(pid, 0); } catch { return false; }
  const ps = spawnSync('ps', ['-p', String(pid), '-o', 'stat='], { encoding: 'utf-8' });
  const stat = (ps.stdout || '').trim();
  if (!stat) return false;
  return !stat.startsWith('Z');
}

describe('reapLegacyPm2', () => {
  it('no-ops fail-safe when there is no pm2 God pidfile (fresh install)', () => {
    const configDir = tmp();
    const pkgRoot = tmp();
    const r = reapLegacyPm2(configDir, pkgRoot);
    expect(r.found).toBe(false);
    expect(r.deleted).toEqual([]);
    expect(r.killed).toBe(false);
    expect(r.note).toContain('no live legacy pm2 God');
  });

  it('ignores a pidfile whose pid is not alive (dead God)', () => {
    const configDir = tmp();
    const pkgRoot = tmp();
    // pid 2147483646 is not a live process.
    mkdirSync(join(configDir, 'pm2'), { recursive: true });
    writeFileSync(join(configDir, 'pm2', 'pm2.pid'), '2147483646');
    const r = reapLegacyPm2(configDir, pkgRoot);
    expect(r.found).toBe(false);
  });

  it('detects a live God, deletes its botmux rows, and kills it', () => {
    const configDir = tmp();
    const pkgRoot = tmp();
    const jlist = JSON.stringify([
      { name: 'botmux' },
      { name: 'botmux-0' },
      { name: 'botmux-plugin-x' }, // plugin services are NOT botmux core → skip
      { name: 'some-other-app' },  // unrelated → skip
    ]);
    const logFile = fakePm2(pkgRoot, { jlist });
    liveGodPidfile(join(configDir, 'pm2'));

    const r = reapLegacyPm2(configDir, pkgRoot);
    expect(r.found).toBe(true);
    // Only the two core botmux rows are deleted (not plugin-x, not other-app).
    expect(r.deleted.sort()).toEqual(['botmux', 'botmux-0']);
    expect(r.killed).toBe(true);

    const calls = readFileSync(logFile, 'utf-8');
    expect(calls).toContain('jlist');
    expect(calls).toContain('delete botmux');
    expect(calls).toContain('delete botmux-0');
    expect(calls).not.toContain('delete botmux-plugin-x');
    expect(calls).not.toContain('delete some-other-app');
    expect(calls).toContain('kill');
  });

  // ── The gap that would have doubled the fleet ───────────────────────────────
  // The reaper's whole job is to stop a pre-migration God BEFORE the new
  // supervisor starts its own daemons. Detection used to require pm2.pid, and a
  // real God was found running 50 botmux daemons with no such file — so the
  // reaper silently no-opped and a `botmux restart` would have left both fleets
  // live, two processes answering the same Feishu events.
  it('treats an ORPHANED rpc.sock as no God (nothing listens on it)', () => {
    // MEASURED after this fix reaped the real fleet: `pm2 kill` removed pm2.pid but
    // left rpc.sock behind with no listener. An existence-only probe then reported
    // the dead God as live on EVERY subsequent command, so `status` kept telling
    // the operator to run a migration that had already completed — and running it
    // again could never clear the warning.
    const configDir = tmp();
    const pkgRoot = tmp();
    orphanGodSocket(join(configDir, 'pm2'));

    const r = reapLegacyPm2(configDir, pkgRoot, () => {});

    expect(r.found).toBe(false);
    expect(r.unresolved).toBe(false);
    expect(r.note).toContain('no live legacy pm2 God');
  });

  // ── The probe must judge OWNERSHIP, not socket-ness ─────────────────────────
  // The fixture above uses a plain file. This one uses a REAL socket whose listener
  // was SIGKILLed — production's actual shape. It is the case that broke on musl:
  // Alpine's `lsof` is a BusyBox applet that IGNORES its path argument and exits 0
  // with a full dump, so the old `status===0 && stdout` test was unconditionally
  // true and this orphan read as a live God. Reading /proc/net/unix (the kernel's
  // own list of BOUND sockets) answers it correctly on both libcs.
  it('treats a REAL orphaned socket (listener SIGKILLed) as no God', () => {
    const configDir = tmp();
    const home = join(configDir, 'pm2');
    realOrphanGodSocket(home);

    // The file is still a socket — this is what defeats an existence/type check.
    expect(existsSync(join(home, 'rpc.sock'))).toBe(true);
    expect(statSync(join(home, 'rpc.sock')).isSocket()).toBe(true);

    expect(liveGodAt(home)).toBeNull();
    const r = reapLegacyPm2(configDir, tmp(), () => {});
    expect(r.found).toBe(false);
    expect(r.unresolved).toBe(false);
  });

  it('still sees a God whose rpc.sock IS held by a live listener', () => {
    // The positive half: the probe must not answer "no God" for everything. Without
    // this, a probe that always said "orphan" would pass the test above and silently
    // reintroduce the double-run this module exists to prevent.
    const configDir = tmp();
    const home = join(configDir, 'pm2');
    liveGodSocketOnly(home);      // real listener bound to rpc.sock

    const god = liveGodAt(home);
    expect(god).not.toBeNull();
    expect(god?.pid).toBe(0);     // socket-only → pid unknown
  });

  it('does not let the pm2 PATH probe touch the ambient PM2_HOME', () => {
    // `pm2 --version` is NOT read-only: it DAEMONIZES a God (MEASURED: "Spawning
    // PM2 daemon with pm2_home=… / Successfully daemonized"). With the ambient env
    // inherited, the probe created one in the caller's PM2_HOME — including a real
    // ~/.botmux/pm2, which the reaper then "found and killed", reporting a legacy
    // fleet on a machine that never had one. Plant a pm2 on PATH that RECORDS the
    // PM2_HOME it was handed, and require it to be a throwaway.
    const configDir = tmp();
    const pkgRoot = tmp();          // no bundled pm2 → the PATH probe runs
    const binDir = tmp();
    const seen = join(binDir, 'seen-home.log');
    writeFileSync(join(binDir, 'pm2'), [
      '#!/usr/bin/env node',
      `require('fs').appendFileSync(${JSON.stringify(seen)}, (process.env.PM2_HOME ?? '<unset>')+'\\n');`,
      `process.exit(0);`,
    ].join('\n'), { mode: 0o755 });
    chmodSync(join(binDir, 'pm2'), 0o755);
    process.env.PATH = `${binDir}:${process.env.PATH ?? ''}`;

    const ambient = join(configDir, 'pm2');   // stands in for ~/.botmux/pm2
    process.env.PM2_HOME = ambient;
    reapLegacyPm2(configDir, pkgRoot, () => {});

    const homes = readFileSync(seen, 'utf-8').trim().split('\n').filter(Boolean);
    expect(homes.length).toBeGreaterThan(0);           // the probe really ran
    for (const h of homes) {
      expect(h).not.toBe(ambient);                     // never the caller's home
      expect(h).not.toBe('<unset>');                   // and never inherited-empty
    }
  });

  it('clears the God records so the warning cannot come back', () => {
    // Leaving the dead God's records on disk would re-trigger detection on the
    // next command. Reaping must clear the evidence it just invalidated — BOTH
    // files, since detection accepts either one:
    //
    //  • rpc.sock, which outlives even a real `pm2 kill`.
    //  • pm2.pid, which the CLI-less path has no pm2 to remove. MEASURED: it kept
    //    naming the God we had just killed, and a zombie answers kill(pid,0), so
    //    the second call still reported found — the warning came right back.
    const configDir = tmp();
    const pkgRoot = tmp();
    const home = join(configDir, 'pm2');
    mkdirSync(join(home, 'pids'), { recursive: true });
    const god = spawnTagged(1, 'PM2 v6.0.14: God Daemon (/fake)')[0];
    writeFileSync(join(home, 'pm2.pid'), String(god));
    orphanGodSocket(home);                 // socket that will outlive the God
    const daemon = spawnSleepers(1)[0];
    writePm2AppPid(home, 'botmux-0', daemon);

    const r = reapLegacyPm2(configDir, pkgRoot, () => {});

    expect(r.killed).toBe(true);
    expect(existsSync(join(home, 'rpc.sock'))).toBe(false); // cleaned up
    expect(existsSync(join(home, 'pm2.pid'))).toBe(false);  // ...and this one too
    // And a follow-up call must now find nothing at all — no `found`, and
    // crucially no `unresolved`, which is what drives the operator warning.
    const again = reapLegacyPm2(configDir, pkgRoot, () => {});
    expect(again.found).toBe(false);
    expect(again.unresolved).toBe(false);
    expect(again.note).toContain('no live legacy pm2 God');
  });

  it('does NOT delete a pm2.pid that still names a LIVE process', () => {
    // The cleanup above must not degenerate into "delete pm2.pid after any kill".
    // If the number in the file is live — a God that has started since, or a
    // recycled pid — removing the record would blind the next detection to a real
    // God, which is the double-run this whole module exists to prevent.
    //
    // Reachable on the pm2-CLI path: real `pm2 kill` removes pm2.pid itself, so
    // cleanup only ever sees a leftover, and here the leftover names this very
    // (live) test process. The socket, having no listener, must still go.
    const configDir = tmp();
    const pkgRoot = tmp();
    const home = join(configDir, 'pm2');
    fakePm2(pkgRoot, { jlist: JSON.stringify([{ name: 'botmux-0' }]) });
    liveGodPidfile(home);      // pm2.pid → our own pid, which stays alive
    orphanGodSocket(home);     // ...but nothing holds the socket

    const r = reapLegacyPm2(configDir, pkgRoot, () => {});

    expect(r.killed).toBe(true);
    expect(existsSync(join(home, 'rpc.sock'))).toBe(false); // orphan → removed
    expect(existsSync(join(home, 'pm2.pid'))).toBe(true);   // live pid → kept
  });

  it('still detects a socket-only God when something IS listening', () => {
    const configDir = tmp();
    const pkgRoot = tmp();
    const jlist = JSON.stringify([{ name: 'botmux-claude' }, { name: 'unrelated' }]);
    const logFile = fakePm2(pkgRoot, { jlist });
    liveGodSocketOnly(join(configDir, 'pm2'));

    const r = reapLegacyPm2(configDir, pkgRoot);
    expect(r.found).toBe(true);
    expect(r.deleted).toEqual(['botmux-claude']);
    expect(r.killed).toBe(true);
    const calls = readFileSync(logFile, 'utf-8');
    expect(calls).toContain('delete botmux-claude');
    expect(calls).not.toContain('delete unrelated');
    expect(calls).toContain('kill');
  });

  it('prefers a live pidfile over the socket probe (pid is reported)', () => {
    const configDir = tmp();
    const pkgRoot = tmp();
    fakePm2(pkgRoot, { jlist: JSON.stringify([{ name: 'botmux' }]) });
    const home = join(configDir, 'pm2');
    liveGodPidfile(home);
    liveGodSocketOnly(home); // both signals present
    const r = reapLegacyPm2(configDir, pkgRoot);
    expect(r.found).toBe(true);
    expect(r.deleted).toEqual(['botmux']);
  });

  it('falls back to the socket when the pidfile is STALE (dead pid, God alive)', () => {
    // pm2 can leave a stale pidfile behind. Before, a dead pid short-circuited to
    // null even though the God was reachable — same double-run hazard.
    const configDir = tmp();
    const pkgRoot = tmp();
    fakePm2(pkgRoot, { jlist: JSON.stringify([{ name: 'botmux-0' }]) });
    const home = join(configDir, 'pm2');
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, 'pm2.pid'), '2147483646'); // not a live process
    liveGodSocketOnly(home);
    const r = reapLegacyPm2(configDir, pkgRoot);
    expect(r.found).toBe(true);
    expect(r.deleted).toEqual(['botmux-0']);
  });

  it('still no-ops when a stale pidfile is the ONLY signal (no socket)', () => {
    // The negative half: without a socket there is no reachable God, so the
    // fallback must not invent one. Otherwise every fresh/torn-down install
    // would try to reap nothing on each start.
    const configDir = tmp();
    const pkgRoot = tmp();
    mkdirSync(join(configDir, 'pm2'), { recursive: true });
    writeFileSync(join(configDir, 'pm2', 'pm2.pid'), '2147483646');
    const r = reapLegacyPm2(configDir, pkgRoot);
    expect(r.found).toBe(false);
    expect(r.killed).toBe(false);
  });

  it('is best-effort: a jlist failure is swallowed, not thrown', () => {
    const configDir = tmp();
    const pkgRoot = tmp();
    // Fake pm2 that exits non-zero on jlist.
    const binDir = join(pkgRoot, 'node_modules', 'pm2', 'bin');
    mkdirSync(binDir, { recursive: true });
    const bin = join(binDir, 'pm2');
    writeFileSync(bin, '#!/usr/bin/env node\nprocess.exit(3);\n', { mode: 0o755 });
    chmodSync(bin, 0o755);
    liveGodPidfile(join(configDir, 'pm2'));

    // Must not throw; found:true (God was live) but nothing deleted/killed.
    const r = reapLegacyPm2(configDir, pkgRoot);
    expect(r.found).toBe(true);
    expect(r.deleted).toEqual([]);
    expect(r.note).toContain('jlist failed');
  });

  // ── CLI path: row deletion must precede `pm2 kill` ──────────────────────────
  // The CLI-less path has an explicit ordering test (the God must stop first there,
  // or it respawns what we reap). The CLI path needs the OPPOSITE order and had no
  // assertion at all: hoisting `pm2 kill` above the delete loop left the suite
  // fully green. `pm2 kill` tears the God down, so `pm2 delete <row>` afterwards
  // has nothing to talk to — the rows survive in the dump and a later pm2 would
  // resurrect them. Pin the sequence, not just the set of calls.
  it('deletes botmux rows BEFORE `pm2 kill` (killing first strands the rows)', () => {
    const configDir = tmp();
    const pkgRoot = tmp();
    const logFile = fakePm2(pkgRoot, { jlist: JSON.stringify([{ name: 'botmux' }, { name: 'botmux-0' }]) });
    liveGodPidfile(join(configDir, 'pm2'));

    const r = reapLegacyPm2(configDir, pkgRoot);
    expect(r.deleted.sort()).toEqual(['botmux', 'botmux-0']);

    // One line per invocation, in call order.
    const calls = readFileSync(logFile, 'utf-8').trim().split('\n');
    const killAt = calls.findIndex((c) => c.trim() === 'kill');
    const lastDeleteAt = calls.reduce((acc, c, i) => (c.startsWith('delete ') ? i : acc), -1);
    expect(killAt).toBeGreaterThan(-1);        // the God is killed
    expect(lastDeleteAt).toBeGreaterThan(-1);  // rows are deleted
    expect(lastDeleteAt).toBeLessThan(killAt); // ...and every delete lands FIRST
  });

  it('never `pm2 kill`s the SHARED ~/.pm2 God — only deletes botmux rows there', () => {
    // The shared default home may host the user's own apps; killing its God is
    // destructive. Simulate a live shared God (~/.pm2) via a fake HOME so the
    // reaper's homedir() resolves to our temp dir.
    const configDir = tmp(); // no exclusive botmux God here
    const pkgRoot = tmp();
    const fakeHome = tmp();
    const jlist = JSON.stringify([{ name: 'botmux-0' }, { name: 'users-own-app' }]);
    const logFile = fakePm2(pkgRoot, { jlist });
    liveGodPidfile(join(fakeHome, '.pm2'));

    const savedHome = process.env.HOME;
    process.env.HOME = fakeHome;
    let r;
    try {
      r = reapLegacyPm2(configDir, pkgRoot);
    } finally {
      if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
    }
    expect(r.found).toBe(true);
    expect(r.deleted).toEqual(['botmux-0']); // only the botmux row
    expect(r.killed).toBe(false);            // shared God is left running
    const calls = readFileSync(logFile, 'utf-8');
    expect(calls).toContain('delete botmux-0');
    expect(calls).not.toContain('delete users-own-app');
    expect(calls).not.toContain('kill'); // NEVER kill the shared God
  });

  // ── The gap that DID double the fleet (compiled binary) ─────────────────────
  // Every test above plants a fake pm2 under <pkgRoot>/node_modules, so they all
  // exercise the bundled-pm2 branch. The compiled single binary never has that
  // path: PKG_ROOT is derived from __dirname, which is inside the virtual
  // /$bunfs/ — MEASURED with a probe binary, PKG_ROOT resolved to `/private`, so
  // the bundled probe missed and resolvePm2Bin fell back to a PATH lookup for
  // `pm2`. With no pm2 on PATH, spawnSync fails ENOENT, the failure is swallowed,
  // and the God survives: `botmux restart` left BOTH fleets live, two processes
  // answering the same Feishu events, both holding the same session sqlite
  // (observed: "SessionStoreUnavailableError: disk I/O error" on the new fleet).
  //
  // The old fleet's pids are on disk the whole time (pm2 writes pids/<name>.pid),
  // so reaping never actually needed the pm2 CLI. These tests pin the fallback.
  it('reaps via pids/ when the pm2 CLI is unavailable (compiled-binary shape)', () => {
    const configDir = tmp();
    const pkgRoot = tmp(); // NO node_modules/pm2 here → mirrors the compiled binary
    const home = join(configDir, 'pm2');
    liveGodPidfile(home);
    // Two botmux daemons + one plugin row (must be left alone) + one unrelated.
    const daemons = spawnSleepers(2);
    const plugin = spawnSleepers(1)[0];
    writePm2AppPid(home, 'botmux-0', daemons[0]);
    writePm2AppPid(home, 'botmux-dashboard-7', daemons[1]);
    writePm2AppPid(home, 'botmux-plugin-x', plugin);

    const r = reapLegacyPm2(configDir, pkgRoot, () => {});

    expect(r.found).toBe(true);
    expect(r.deleted.sort()).toEqual(['botmux-0', 'botmux-dashboard-7']);
    // The core daemons must actually be gone — this is the whole point.
    for (const pid of daemons) expect(alive(pid)).toBe(false);
    // A plugin row is not core botmux; the reaper must not touch it.
    expect(alive(plugin)).toBe(true);
    // `killed` stays false here: the God pidfile points at this test process,
    // whose cmdline is not a pm2 God, so the identity guard refuses to signal it
    // (see the pid-reuse test below). Stopping the daemons is the load-bearing
    // half — they are what holds the ports, the sqlite, and the Feishu stream.
    expect(r.killed).toBe(false);
  });

  it('refuses to signal a "God" pid whose cmdline is not a pm2 God', () => {
    // The God pid also comes from a file that can be stale. It gets SIGTERM then
    // SIGKILL, so shooting a recycled pid here would take down an unrelated
    // process — verify the guard by pointing pm2.pid at a live non-God.
    const configDir = tmp();
    const pkgRoot = tmp();
    const home = join(configDir, 'pm2');
    const bystander = spawnBystander();
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, 'pm2.pid'), String(bystander));
    const daemon = spawnSleepers(1)[0];
    writePm2AppPid(home, 'botmux-0', daemon);

    const r = reapLegacyPm2(configDir, pkgRoot, () => {});

    expect(r.deleted).toEqual(['botmux-0']); // daemons still reaped
    expect(r.killed).toBe(false);            // but the fake God is spared
    expect(alive(bystander)).toBe(true);
  });

  it('does not report success when the God survives (no CLI, no reapable pids)', () => {
    // The dangerous direction: if we cannot prove the old fleet is down, the
    // caller must be able to tell — silently returning "handled" is what let a
    // double-run start. God is live, but there are no pids/ to work with.
    const configDir = tmp();
    const pkgRoot = tmp(); // no bundled pm2
    liveGodPidfile(join(configDir, 'pm2'));

    const r = reapLegacyPm2(configDir, pkgRoot, () => {});

    expect(r.found).toBe(true);
    expect(r.killed).toBe(false);
    expect(r.unresolved).toBe(true); // caller must warn: old fleet may be live
    expect(r.note).toMatch(/pm2 (CLI|not)/i);
  });

  it('does NOT mark the shared-home outcome unresolved (its God is spared by design)', () => {
    // `unresolved` drives an operator-facing warning, so it must not fire on the
    // normal shared-home path: there we deliberately never kill the God, and
    // `!killed` is the correct result rather than a failure.
    const configDir = tmp(); // no exclusive God
    const pkgRoot = tmp();
    const fakeHome = tmp();
    fakePm2(pkgRoot, { jlist: JSON.stringify([{ name: 'botmux-0' }, { name: 'users-own-app' }]) });
    liveGodPidfile(join(fakeHome, '.pm2'));

    const savedHome = process.env.HOME;
    process.env.HOME = fakeHome;
    let r;
    try { r = reapLegacyPm2(configDir, pkgRoot); }
    finally { if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome; }

    expect(r.found).toBe(true);
    expect(r.killed).toBe(false);      // by design
    expect(r.unresolved).toBe(false);  // ...and therefore NOT a problem to report
  });

  it('never signals a pid whose cmdline is not a botmux daemon (pid reuse)', () => {
    // pids/ files can outlive their process and the pid may have been recycled
    // into something unrelated. Killing by stale pid alone would shoot a
    // bystander, so the fallback must verify the process before signalling.
    const configDir = tmp();
    const pkgRoot = tmp();
    const home = join(configDir, 'pm2');
    liveGodPidfile(home);
    const bystander = spawnBystander();
    writePm2AppPid(home, 'botmux-0', bystander);

    const r = reapLegacyPm2(configDir, pkgRoot, () => {});

    expect(alive(bystander)).toBe(true);       // untouched
    expect(r.deleted).not.toContain('botmux-0');
  });

  it('kills the God itself when its cmdline confirms it is a pm2 God', () => {
    // The positive half of the guard above: a real God must actually be stopped,
    // otherwise it would restart the daemons we just reaped. pm2 titles its
    // daemon "PM2 <version>: God Daemon (<PM2_HOME>)".
    const configDir = tmp();
    const pkgRoot = tmp();
    const home = join(configDir, 'pm2');
    mkdirSync(home, { recursive: true });
    const god = spawnTagged(1, 'PM2 v6.0.14: God Daemon (/fake/.botmux/pm2)')[0];
    writeFileSync(join(home, 'pm2.pid'), String(god));
    const daemon = spawnSleepers(1)[0];
    writePm2AppPid(home, 'botmux-0', daemon);

    const r = reapLegacyPm2(configDir, pkgRoot, () => {});

    expect(r.deleted).toEqual(['botmux-0']);
    expect(r.killed).toBe(true);
    expect(alive(god)).toBe(false);
    expect(alive(daemon)).toBe(false);
  });

  it('stops the God BEFORE its daemons, so nothing gets respawned', () => {
    // Respawning dead children is a pm2 God's whole job. Reaping the daemons
    // first therefore accomplishes nothing — MEASURED with a compiled probe:
    // the daemon was SIGTERMed, the still-live God brought it back, and the
    // reaper reported it deleted. This God actually respawns, so the ordering is
    // load-bearing rather than stylistic.
    const configDir = tmp();
    const pkgRoot = tmp();
    const home = join(configDir, 'pm2');
    mkdirSync(join(home, 'pids'), { recursive: true });
    const pidFile = join(home, 'pids', 'botmux-0.pid');

    // A "God" that respawns its child when it dies, rewriting the pidfile — the
    // behavior that defeats the wrong order. Its cmdline carries the pm2 God
    // title so the identity guard accepts it.
    //
    // BOUNDED ON PURPOSE: an earlier version respawned without limit and, once
    // the God was killed, its orphaned children kept respawning — that runaway
    // exhausted this machine's process resources and took the shell down with it.
    // So: a hard respawn cap, a self-destruct timer in every process, and the
    // whole family in its own process group that teardown kills as a unit.
    const godScript = `
      const {spawn}=require('child_process');
      const fs=require('fs');
      const PIDFILE=${JSON.stringify(pidFile)};
      const MAX_RESPAWNS=3;               // hard cap — never an unbounded loop
      let respawns=0;
      function launch(){
        const child=spawn(process.execPath,
          ['-e','setTimeout(()=>process.exit(0),15000)','/fake/dist/index-daemon.js'],
          {stdio:'ignore'});
        fs.writeFileSync(PIDFILE,String(child.pid));
        child.on('exit',()=>{ if(respawns++ < MAX_RESPAWNS) setTimeout(launch,50); });
      }
      launch();
      setTimeout(()=>process.exit(0),15000);   // self-destruct even if unreaped
    `;
    // detached:true → new process group, so teardown can signal the whole family.
    const god = spawnTagged(1, 'PM2 v6.0.14: God Daemon (/fake)', godScript, { group: true })[0];
    // Wait for the God to publish its first child.
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && !existsSync(pidFile)) spinMs(50);
    expect(existsSync(pidFile)).toBe(true);
    const firstChild = parseInt(readFileSync(pidFile, 'utf-8').trim(), 10);
    expect(alive(firstChild)).toBe(true);
    writeFileSync(join(home, 'pm2.pid'), String(god));

    const r = reapLegacyPm2(configDir, pkgRoot, () => {});

    // Let any pending respawn fire; with the God dead first, none can.
    spinMs(400);
    expect(r.killed).toBe(true);
    expect(alive(god)).toBe(false);
    expect(r.unresolved).toBe(false);
    // Whatever child the pidfile now names must be down and stay down.
    const lastChild = parseInt(readFileSync(pidFile, 'utf-8').trim(), 10);
    expect(alive(lastChild)).toBe(false);
  });

  // ── liveGodAt, the detector `status`/`logs` share ───────────────────────────
  // The warning those commands print goes through this exact function. It is
  // tested directly because the reap path CANNOT expose the bug below: reaping
  // deletes the pidfile, so the zombie is never read back. Reverting this to a
  // bare `kill(pid, 0)` left the whole reap suite green — measured — while
  // `botmux status` would still have reported a God that no longer exists.
  it('does not call a ZOMBIE pid a live God (kill(pid,0) lies about zombies)', () => {
    const home = tmp();
    // A killed child stays a zombie until the runtime reaps it, and for that whole
    // window `kill(pid, 0)` succeeds — verified with a probe: stat 'Z', kill0 true.
    // That is precisely the state a God is in right after a successful reap.
    const god = spawnTagged(1, 'PM2 v6.0.14: God Daemon (/fake)')[0];
    writeFileSync(join(home, 'pm2.pid'), String(god));
    expect(liveGodAt(home)).not.toBeNull();   // alive → detected

    process.kill(god, 'SIGKILL');
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && alive(god)) spinMs(50);
    expect(alive(god)).toBe(false);           // now a zombie (or fully gone)

    expect(liveGodAt(home)).toBeNull();       // ...and must NOT be called a God
  });

  it('ignores a shared ~/.pm2 God that has NO botmux rows (belongs to the user)', () => {
    const configDir = tmp();
    const pkgRoot = tmp();
    const fakeHome = tmp();
    const jlist = JSON.stringify([{ name: 'users-own-app' }, { name: 'another-app' }]);
    fakePm2(pkgRoot, { jlist });
    liveGodPidfile(join(fakeHome, '.pm2'));

    const savedHome = process.env.HOME;
    process.env.HOME = fakeHome;
    let r;
    try {
      r = reapLegacyPm2(configDir, pkgRoot);
    } finally {
      if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
    }
    // No botmux rows in the shared home → not our concern → found stays false.
    expect(r.found).toBe(false);
    expect(r.deleted).toEqual([]);
    expect(r.killed).toBe(false);
  });
});
