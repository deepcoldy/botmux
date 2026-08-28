#!/usr/bin/env node
/**
 * musl (BusyBox) regression gate for the legacy-pm2 reaper's process/socket probes.
 *
 * WHY THIS EXISTS AS ITS OWN SCRIPT, run inside Alpine:
 *
 * The reaper identifies processes and sockets before it signals or deletes anything.
 * Those probes used to shell out to `ps -p` and `lsof <path>`, which behave
 * DIFFERENTLY under BusyBox — and every difference silently disabled a guard:
 *
 *   • `ps -p <pid> -o command=` → BusyBox exits 1 with no output ("unrecognized
 *     option: p"). Callers read '' as "cannot identify" and fail closed, so the
 *     pid-reuse guards rejected EVERY process: the CLI-less reap found nothing to
 *     do and a pre-migration fleet survived `botmux restart` untouched.
 *   • `lsof -- <path>` → BusyBox IGNORES the path argument, dumps all open files and
 *     exits 0. The "is this socket held?" test was therefore unconditionally true,
 *     so an orphaned rpc.sock read as a live God and the "legacy pm2 still running"
 *     warning could never be cleared.
 *
 * Neither failure is visible to `bun run test`: vitest runs on the glibc host where
 * both tools behave as expected, and the assertions pass. Reverting either probe to
 * its `ps`/`lsof` form leaves the unit suite fully green (MEASURED) while breaking
 * the musl binary we ship. This script is the only gate that can see it, which is
 * why it runs in the same Alpine container that builds the musl binary.
 *
 * It deliberately tests the SHIPPED module (dist/core/legacy-pm2-reaper.js) rather
 * than reimplementing the probes, so it cannot drift from the real logic.
 */
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, statSync, rmSync, accessSync, constants as fsConstants } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const distPath = process.argv[2] ?? 'dist/core/legacy-pm2-reaper.js';

// ENFORCE THE CLI-LESS PATH BEFORE IMPORTING ANYTHING.
//
// These checks exercise the fallback the compiled binary uses: no bundled pm2, no
// pm2 on PATH. If a pm2 IS reachable, `resolvePm2Bin` returns it and the reaper
// takes the pm2 CLI path instead — a different code path, whose (correct) results
// look like failures against the expectations below. MEASURED on a dev box with a
// global pm2: 3 checks "failed" with the reaper behaving perfectly, and `pm2 jlist`
// even daemonized a real God inside the fixture home.
//
// CI is Alpine with no pm2 so it never saw this, but a human running the script
// locally would — the same "isolation stated but not enforced" trap that made the
// unit suite fail 5/17 on exactly such a box. So drop every PATH segment that
// actually contains an executable pm2 (filter by capability, not by directory
// name), and clear PM2_HOME so nothing can touch a real pm2 home either.
process.env.PATH = (process.env.PATH ?? '')
  .split(':')
  .filter((seg) => {
    if (!seg) return false;
    try { accessSync(join(seg, 'pm2'), fsConstants.X_OK); return false; } catch { return true; }
  })
  .join(':');
delete process.env.PM2_HOME;

const { reapLegacyPm2, liveGodAt } = await import(pathToFileURL(distPath).href);

const spin = (ms) => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* no SAB */ } };
let failures = 0;
function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
}

// Report the environment so a green run cannot be mistaken for "ran on glibc".
const psWorks = spawnSync('ps', ['-p', String(process.pid), '-o', 'command='], { encoding: 'utf-8' }).status === 0;
console.log('environment:');
console.log(`  libc            : ${existsSync('/lib/ld-musl-x86_64.so.1') || existsSync('/lib/ld-musl-aarch64.so.1') ? 'musl' : 'glibc'}`);
console.log(`  ps -p supported : ${psWorks ? 'yes' : 'NO (BusyBox)'}`);
console.log(`  /proc readable  : ${existsSync('/proc/net/unix')}`);
// Say which path is under test: a reachable pm2 would silently switch the reaper to
// its CLI branch and make these expectations meaningless.
//
// PM2_HOME even here: `pm2 --version` DAEMONIZES a God rather than just printing a
// version, so an inherited env would create one in the caller's pm2 home — and with
// PM2_HOME unset (which this script does above) that home is the SHARED ~/.pm2 this
// repo takes pains never to touch. After the PATH filter this spawn should always
// ENOENT, so today the argument is unreachable; it is passed anyway because the cost
// is one line and the failure mode of being wrong is polluting a user's own pm2.
const pm2ProbeHome = join(tmpdir(), `botmux-musl-gate-probe-${process.pid}`);
const pm2Reachable = !spawnSync('pm2', ['--version'], {
  encoding: 'utf-8', env: { ...process.env, PM2_HOME: pm2ProbeHome },
}).error;
if (pm2Reachable) {
  // Stop and remove anything that probe may have started, so it never outlives us.
  spawnSync('pm2', ['kill'], { encoding: 'utf-8', env: { ...process.env, PM2_HOME: pm2ProbeHome } });
}
try { rmSync(pm2ProbeHome, { recursive: true, force: true }); } catch { /* best effort */ }
console.log(`  pm2 on PATH     : ${pm2Reachable ? 'YES — expectations below assume none' : 'no (CLI-less path under test)'}`);
if (psWorks) {
  // Not a failure — the script is also runnable on glibc for comparison — but say so
  // loudly, because the whole point is to exercise the BusyBox shapes.
  console.log('  NOTE: `ps -p` works here, so this run does not exercise the BusyBox path.');
}

// ── 1. An orphaned rpc.sock must NOT read as a live God ──────────────────────
// This is the case BusyBox `lsof` gets wrong. Build a REAL orphan: a child binds
// the socket and is then SIGKILLed, so the file survives with no owner — exactly
// what `pm2 kill` leaves behind.
console.log('orphaned rpc.sock (the shape `pm2 kill` leaves):');
{
  const home = mkdtempSync(join(tmpdir(), 'musl-sock-'));
  const sock = join(home, 'rpc.sock');
  const child = spawn(process.execPath, ['-e',
    `const net=require('net');const s=net.createServer(()=>{});`
    + `s.listen(${JSON.stringify(sock)},()=>process.stdout.write('READY'));setTimeout(()=>{},60000);`],
    { stdio: ['ignore', 'pipe', 'ignore'] });
  for (let i = 0; i < 200 && !existsSync(sock); i++) spin(25);
  check('fixture: socket bound', existsSync(sock), true);
  check('fixture: held socket reads as a God', liveGodAt(home) !== null, true);
  child.kill('SIGKILL');
  spin(500);
  // The file is still a socket — which is why an existence/type check cannot help.
  check('fixture: file survives the kill', existsSync(sock), true);
  check('fixture: still isSocket()', statSync(sock).isSocket(), true);
  check('orphan reads as NO God', liveGodAt(home), null);
  rmSync(home, { recursive: true, force: true });
}

// ── 2. The CLI-less reap must actually stop a legacy fleet ───────────────────
// This is the case BusyBox `ps` gets wrong: with cmdline unreadable, every pid in
// pids/ is rejected and the reap silently does nothing.
console.log('CLI-less reap of a live legacy fleet:');
{
  const configDir = mkdtempSync(join(tmpdir(), 'musl-cfg-'));
  const pkgRoot = mkdtempSync(join(tmpdir(), 'musl-pkg-'));   // no bundled pm2
  process.env.HOME = mkdtempSync(join(tmpdir(), 'musl-home-'));
  delete process.env.PM2_HOME;
  const home = join(configDir, 'pm2');
  mkdirSync(join(home, 'pids'), { recursive: true });
  const pidFile = join(home, 'pids', 'botmux-0.pid');

  // A God that respawns its child (bounded): if the reaper stops the daemon before
  // the God, the God brings it back and the last check below fails.
  const godScript = `
    const {spawn}=require('child_process'); const fs=require('fs');
    let n=0;
    function launch(){
      const c=spawn(process.execPath,['-e','setTimeout(()=>process.exit(0),20000)','/opt/app/dist/index-daemon.js'],{stdio:'ignore'});
      fs.writeFileSync(${JSON.stringify(pidFile)},String(c.pid));
      c.on('exit',()=>{ if(n++<3) setTimeout(launch,50); });
    }
    launch(); setTimeout(()=>process.exit(0),20000);
  `;
  const god = spawn(process.execPath, ['-e', godScript, 'PM2 v6.0.14: God Daemon (/fake/pm2)'],
    { stdio: 'ignore', detached: true });
  for (let i = 0; i < 200 && !existsSync(pidFile); i++) spin(25);
  writeFileSync(join(home, 'pm2.pid'), String(god.pid));

  const alive = (pid) => {
    try { process.kill(pid, 0); } catch { return false; }
    let raw = '';
    try { raw = readFileSync(`/proc/${pid}/stat`, 'utf-8'); } catch { return false; }
    const close = raw.lastIndexOf(')');
    const st = close < 0 ? '' : (raw.slice(close + 1).trim().split(/\s+/)[0] || '');
    return st !== '' && st !== 'Z';
  };
  check('fixture: god alive', alive(god.pid), true);

  const r = reapLegacyPm2(configDir, pkgRoot, () => {});
  spin(700);   // let any pending respawn fire

  check('found a legacy God', r.found, true);
  check('stopped the God', r.killed, true);
  check('reaped the daemon', r.deleted, ['botmux-0']);
  check('nothing left unresolved', r.unresolved, false);
  check('god is down', alive(god.pid), false);
  check('daemon stays down (no respawn)', alive(parseInt(readFileSync(pidFile, 'utf-8').trim(), 10)), false);
  check('stale pm2.pid cleaned', existsSync(join(home, 'pm2.pid')), false);
  // The permanent-false-warning half: a second call must be a clean no-op.
  const again = reapLegacyPm2(configDir, pkgRoot, () => {});
  check('second reap finds nothing', again.found, false);
  check('second reap is not unresolved', again.unresolved, false);

  try { process.kill(-god.pid, 'SIGKILL'); } catch { /* group already gone */ }
  for (const d of [configDir, pkgRoot, process.env.HOME]) rmSync(d, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed — the reaper's probes do not work on this libc.`);
  process.exit(1);
}
console.log('\nall checks passed');
