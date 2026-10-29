/**
 * Real-mount behaviour of the Linux scratch submount handling, every scenario
 * inside a private mount + PID namespace (helpers/private-mount-ns.ts): nothing
 * this file mounts can outlive it in the host mount table, even when the run is
 * killed mid-test.
 *
 *  - a new scratch session never re-wraps an earlier session's overlays/binds
 *    (that made the host mount table grow geometrically per session), while a
 *    real data submount — and a user dir that merely looks like a scratch tree —
 *    is still overlaid copy-on-write;
 *  - over SCRATCH_SUBMOUNT_OVERLAY_LIMIT the excess is read-only (never the
 *    working dir's own mount), and a real worker tells the user once;
 *  - the orphan sweep reclaims a tree a prepare left mounted without its
 *    marker, and the fuse-overlayfs daemons serving it do not keep it "live".
 *
 * Root only (see the helper); everything else skips.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { lastJsonLine, privateMountNsAvailable, runInPrivateMountNs } from './helpers/private-mount-ns.js';
import { SCRATCH_SUBMOUNT_OVERLAY_LIMIT } from '../src/adapters/backend/scratch-sandbox.js';

const runtime = privateMountNsAvailable();
const hasFuseOverlay = spawnSync('sh', ['-c', 'command -v fuse-overlayfs'], { stdio: 'ignore' }).status === 0;

// Fixtures must sit OUTSIDE /tmp, /run, /var/tmp…: scratch never wraps
// submounts there, so a fixture under tmpdir() (often /tmp) would prove nothing.
// The base gets a namespace-private tmpfs, so on the host it stays an empty dir.
const bases: string[] = [];
function freshBase(): string {
  const base = mkdtempSync(join(resolve('.'), '.scratch-mounts-'));
  bases.push(base);
  return base;
}
afterEach(() => {
  for (const base of bases.splice(0)) rmdirSync(base);
});

/** Snippet prelude: tmpfs helper + mount counter, run inside the namespace. */
const PRELUDE = `
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
const mountinfo = () => readFileSync('/proc/self/mountinfo', 'utf8').split('\\n').filter(Boolean);
const tmpfs = (dir) => {
  mkdirSync(dir, { recursive: true });
  const r = spawnSync('mount', ['-t', 'tmpfs', '-o', 'size=2m', 'tmpfs', dir], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error('mount ' + dir + ': ' + r.stderr);
};
const metaSubs = (dataDir, sid) => JSON.parse(readFileSync(join(dataDir, 'sandboxes', sid, 'scratch.json'), 'utf8')).subs.map(s => s.mountpoint);
// The CLI a probe prepare launches: this runtime evaluating \`code\`, which
// prints one 'CONTAINER {json}' line from inside the sandbox.
const probeCli = (code) => ({ cliBin: process.execPath, cliArgs: ['-e', code] });
const runContainer = (sbx) => {
  const r = spawnSync(sbx.bin, sbx.args, { env: { ...process.env, ...sbx.env }, encoding: 'utf8', timeout: 60_000 });
  const line = (r.stdout ?? '').split('\\n').find(l => l.startsWith('CONTAINER '));
  if (!line) throw new Error('the container never ran its probe (exit ' + r.status + '): ' + r.stdout + r.stderr);
  return JSON.parse(line.slice('CONTAINER '.length));
};
`;

describe.skipIf(!runtime)('scratch submounts (real mounts, private namespace)', () => {
  it('a new session never re-wraps earlier sessions\' trees, and real data submounts stay copy-on-write', () => {
    const base = freshBase();
    const run = runInPrivateMountNs(`${PRELUDE}
import { prepareScratchSandbox } from './src/adapters/backend/scratch-sandbox.js';
const base = ${JSON.stringify(base)};
const userdata = join(base, 'userdata');
tmpfs(userdata);
writeFileSync(join(userdata, 'data.txt'), 'real');
// A user's own dir that merely LOOKS like a scratch tree (no subroots/marker).
const lookalike = join(base, 'lab', 'sandboxes', 'box', 'root');
tmpfs(lookalike);
const work = join(base, 'work');
tmpfs(work);
// Data dirs of bots with different BOTMUX_HOMEs, all on one data disk.
tmpfs(join(base, 'disk'));
const sessions = [];
const firstMerged = join(base, 'disk', 'a', 'data', 'sandboxes', 'sid-a', 'root');
// Inside the container: the data volume's content, a write to it, and what
// another session's (still mounted) full-root view looks like from here.
const cli = probeCli(\`const fs = require('fs'); const out = {};
out.data = fs.readFileSync(\${JSON.stringify(join(userdata, 'data.txt'))}, 'utf8');
try { fs.writeFileSync(\${JSON.stringify(join(userdata, 'cow.txt'))}, 'x'); out.wrote = true; } catch (e) { out.wrote = e.code; }
out.otherSessionEntries = fs.readdirSync(\${JSON.stringify(firstMerged)}).length;
console.log('CONTAINER ' + JSON.stringify(out));\`);
let last;
for (const name of ['a', 'b', 'c']) {
  const dataDir = join(base, 'disk', name, 'data');
  mkdirSync(dataDir, { recursive: true });
  const before = mountinfo().length;
  const sbx = prepareScratchSandbox({ sessionId: 'sid-' + name, dataDir, storage: 'tmpfs', chdir: work, home: base, ...cli });
  if (!sbx) throw new Error('prepare ' + name + ' failed');
  sessions.push({ added: mountinfo().length - before, subs: metaSubs(dataDir, 'sid-' + name) });
  last = sbx;
}
const container = runContainer(last);
console.log(JSON.stringify({
  userdata, lookalike, sessions, container,
  hostEntriesOfFirstView: readdirSync(firstMerged).length,
  inLastView: existsSync(join(last.mergedHostPath, userdata, 'cow.txt')),
  cowLeaked: existsSync(join(userdata, 'cow.txt')),
}));
`, { tmpfs: [base] });
    const result = lastJsonLine<{
      userdata: string; lookalike: string; cowLeaked: boolean; inLastView: boolean; hostEntriesOfFirstView: number;
      sessions: { added: number; subs: string[] }[];
      container: { data: string; wrote: boolean | string; otherSessionEntries: number };
    }>(run);
    const [a, b, c] = result.sessions;
    // No session wraps another's overlays or binds: each adds the same mounts.
    expect(b!.added, run.stderr).toBe(a!.added);
    expect(c!.added, run.stderr).toBe(a!.added);
    for (const session of result.sessions) {
      expect(session.subs.filter(p => /\/sandboxes\/sid-/.test(p))).toEqual([]);
      expect(session.subs).toContain(result.userdata);
      expect(session.subs).toContain(result.lookalike);
    }
    // In the container: the real volume reads and takes writes, which land in
    // the session's view and never on the volume itself.
    expect(result.container.data).toBe('real');
    expect(result.container.wrote).toBe(true);
    expect(result.inLastView).toBe(true);
    expect(result.cowLeaked).toBe(false);
    // Another session's full-root view is an empty dir in here (it is not on the host).
    expect(result.hostEntriesOfFirstView).toBeGreaterThan(0);
    expect(result.container.otherSessionEntries).toBe(0);
  });

  it('over the limit, the excess is read-only and the working dir\'s mount stays copy-on-write', () => {
    const base = freshBase();
    const run = runInPrivateMountNs(`${PRELUDE}
import { prepareScratchSandbox, SCRATCH_SUBMOUNT_OVERLAY_LIMIT } from './src/adapters/backend/scratch-sandbox.js';
const base = ${JSON.stringify(base)};
for (let i = 0; i < SCRATCH_SUBMOUNT_OVERLAY_LIMIT + 6; i++) tmpfs(join(base, 'many', 'm' + String(i).padStart(3, '0')));
// The DEEPEST mount of all: shallow-first alone would drop it to read-only.
const project = join(base, 'zz', 'deep', 'er', 'project');
tmpfs(project);
const work = join(project, 'work');
mkdirSync(work);
// HOME on its own volume, just as deep: the CLI writes there too.
const homeVolume = join(base, 'zz', 'home', 'vol', 'u');
tmpfs(homeVolume);
const dataDir = join(base, 'data');
tmpfs(dataDir);
// Inside the container: try a write on every volume.
const volumes = [...readdirSync(join(base, 'many')).map(n => join(base, 'many', n)), project, homeVolume];
const sbx = prepareScratchSandbox({
  sessionId: 'sid-limit', dataDir, storage: 'tmpfs', chdir: work, home: join(homeVolume, 'me'),
  ...probeCli(\`const fs = require('fs'); const out = {};
for (const v of \${JSON.stringify(volumes)}) { try { fs.writeFileSync(v + '/.w', 'x'); out[v] = 'W'; } catch (e) { out[v] = e.code; } }
console.log('CONTAINER ' + JSON.stringify(out));\`),
});
const container = sbx ? runContainer(sbx) : null;
const roBinds = [];
if (sbx) for (let i = 0; i + 2 < sbx.args.length; i++) {
  if (sbx.args[i] === '--ro-bind' && sbx.args[i + 1] === sbx.args[i + 2]) roBinds.push(sbx.args[i + 1]);
}
console.log(JSON.stringify({
  prepared: !!sbx, project, homeVolume,
  overlaid: sbx ? metaSubs(dataDir, 'sid-limit') : [],
  overflow: sbx?.submountOverflow ?? null,
  roBinds, container,
}));
`, { tmpfs: [base] });
    const result = lastJsonLine<{
      prepared: boolean; project: string; homeVolume: string; overlaid: string[]; roBinds: string[];
      overflow: { eligible: number; readOnly: string[] } | null;
      container: Record<string, string>;
    }>(run);
    expect(result.prepared, run.stderr).toBe(true);
    expect(result.overlaid).toHaveLength(SCRATCH_SUBMOUNT_OVERLAY_LIMIT);
    expect(result.overlaid).toContain(result.project);
    expect(result.overlaid).toContain(result.homeVolume);
    expect(result.overflow).not.toBeNull();
    expect(result.overflow!.readOnly.length).toBeGreaterThanOrEqual(6);
    expect(result.overflow!.eligible).toBe(result.overlaid.length + result.overflow!.readOnly.length);
    expect(result.overflow!.readOnly).not.toContain(result.project);
    // Read-only, not dropped: each one is bound into the container.
    for (const p of result.overflow!.readOnly) expect(result.roBinds).toContain(p);
    // In the container: the excess refuses writes; the rest — the working dir's
    // and HOME's volumes first — takes them.
    for (const [volume, outcome] of Object.entries(result.container)) {
      expect(outcome, volume).toBe(result.overflow!.readOnly.includes(volume) ? 'EROFS' : 'W');
    }
    expect(result.container[result.project]).toBe('W');
    expect(result.container[result.homeVolume]).toBe('W');
  });

  it('a real worker over the limit tells the user once, across CLI restarts', () => {
    const base = freshBase();
    // The worker talks to its parent only: no live daemon / bot identity leaks in.
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(BOTMUX_|LARK_)/.test(key)));
    const run = runInPrivateMountNs(`${PRELUDE}
import { SCRATCH_SUBMOUNT_OVERLAY_LIMIT } from './src/adapters/backend/scratch-sandbox.js';
import { spawnNodeTsScript } from './test/helpers/ts-runner.js';
const base = ${JSON.stringify(base)};
for (let i = 0; i < SCRATCH_SUBMOUNT_OVERLAY_LIMIT + 6; i++) tmpfs(join(base, 'many', 'm' + String(i).padStart(3, '0')));
const work = join(base, 'work');
mkdirSync(work);
// Not next to the data dir: its parent is the botmux home, whose files the
// sandbox masks (credential isolation) — a CLI there could not even start.
mkdirSync(join(base, 'bin'));
// The extensionless script sits under this repo (type: module): pin it to CommonJS.
writeFileSync(join(base, 'bin', 'package.json'), '{"type":"commonjs"}\\n');
const cli = join(base, 'bin', 'fake-claude');
const dataDir = join(base, 'botmux', 'data');
// The CLI reports from INSIDE the sandbox into the host-real relay outbox.
const many = join(base, 'many');
writeFileSync(cli, "#!/usr/bin/env node\\nconst fs = require('fs');\\nif (process.argv.includes('--version')) { console.log('2.1.0 (Claude Code)'); process.exit(0); }\\n"
  + "const out = { cwd: process.cwd(), volumes: {} };\\n"
  + "try { fs.writeFileSync('.cli-probe', 'x'); out.cwdWritable = true; } catch (e) { out.cwdWritable = e.code; }\\n"
  + "for (const n of fs.readdirSync(" + JSON.stringify(many) + ")) { try { fs.writeFileSync(" + JSON.stringify(many) + " + '/' + n + '/.w', 'x'); out.volumes[n] = 'W'; } catch (e) { out.volumes[n] = e.code; } }\\n"
  + "fs.writeFileSync(process.env.BOTMUX_SEND_RELAY + '/fake-cli-report.json', JSON.stringify(out));\\n"
  + "setInterval(() => {}, 1000);\\n", { mode: 0o755 });
const messages = [];
let logs = '';
const worker = spawnNodeTsScript('src/worker.ts', [], {
  env: { ...process.env, HOME: join(base, 'home'), SESSION_DATA_DIR: dataDir, BOTMUX_SANDBOX: 'scratch', BOTMUX_NO_CLAIM: '1' },
  stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
});
worker.on('message', m => messages.push(m));
worker.stdout.on('data', c => { logs += c; });
worker.stderr.on('data', c => { logs += c; });
const waitFor = async (pred, ms) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline && !pred()) await new Promise(r => setTimeout(r, 100));
  return pred();
};
worker.send({ type: 'init', sessionId: 'overflow-notice', chatId: 'oc_fixture', rootMessageId: 'om_fixture', workingDir: work,
  cliId: 'claude-code', cliPathOverride: cli, backendType: 'pty', prompt: '', larkAppId: 'app_test', larkAppSecret: 'fixture-secret' });
const ready = await waitFor(() => messages.some(m => m.type === 'ready' || m.type === 'error'), 45_000);
const tree = join(dataDir, 'sandboxes', 'overflow-notice');
const readJson = (file) => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; } };
// One generation's marker and the report its CLI wrote into that tree's outbox.
const generation = async (notCreatedAt) => {
  let meta = null;
  let report = null;
  await waitFor(() => {
    meta = readJson(join(tree, 'scratch.json'));
    report = readJson(join(tree, 'outbox', 'fake-cli-report.json'));
    return !!meta && meta.createdAt !== notCreatedAt && !!report;
  }, 60_000);
  return { meta, report };
};
const first = await generation(undefined);
// An operator restart tears the sandbox down and prepares it afresh: over the limit again.
worker.send({ type: 'restart', reason: 'operator', attemptId: 'restart-1' });
// (restart_result waits for a prompt this fake CLI never draws: the new
// generation's own marker and report are the proof.)
const second = await generation(first.meta?.createdAt);
const restarted = !!second.report;
await new Promise(r => setTimeout(r, 500));
worker.kill('SIGKILL');
console.log(JSON.stringify({
  ready, restarted,
  errors: messages.filter(m => m.type === 'error').map(m => m.message),
  prepares: [first, second].map(g => ({ createdAt: g.meta?.createdAt, overlaid: g.meta?.subs.length })),
  notices: messages.filter(m => m.type === 'user_notify').map(m => m.message),
  logTail: messages.filter(m => m.type === 'claude_exit').map(m => m.logTail).join('\\n---\\n'),
  reports: [first.report, second.report].filter(Boolean),
}));
`, { tmpfs: [base], env, timeoutMs: 150_000 });
    const result = lastJsonLine<{
      ready: boolean; restarted: boolean; errors: string[]; notices: string[];
      prepares: { createdAt: number; overlaid: number }[];
      reports: { cwdWritable: boolean | string; volumes: Record<string, string> }[];
      logTail: string;
    }>(run);
    expect(result.ready, run.stderr).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.restarted).toBe(true);
    // Two separate over-limit prepares (a fresh tree each time)…
    expect(result.prepares[1]!.createdAt).not.toBe(result.prepares[0]!.createdAt);
    expect(result.prepares.map(p => p.overlaid)).toEqual([SCRATCH_SUBMOUNT_OVERLAY_LIMIT, SCRATCH_SUBMOUNT_OVERLAY_LIMIT]);
    // …one notice.
    expect(result.notices).toHaveLength(1);
    expect(result.notices[0]).toContain(String(SCRATCH_SUBMOUNT_OVERLAY_LIMIT));
    // The CLI really ran in the sandbox, in both generations: its working dir
    // takes writes, and the volumes over the limit refuse them.
    expect(result.reports, result.logTail).toHaveLength(2);
    for (const report of result.reports) {
      expect(report.cwdWritable).toBe(true);
      const outcomes = Object.values(report.volumes);
      expect(outcomes.filter(o => o === 'EROFS').length).toBeGreaterThanOrEqual(6);
      expect(outcomes.filter(o => o !== 'EROFS' && o !== 'W')).toEqual([]);
    }
  }, 180_000);

  it('re-adopting a live tree exposes a newly appeared real mount read-only, never another session\'s tree', () => {
    const base = freshBase();
    const run = runInPrivateMountNs(`${PRELUDE}
import { prepareScratchSandbox } from './src/adapters/backend/scratch-sandbox.js';
const base = ${JSON.stringify(base)};
const work = join(base, 'work');
tmpfs(work);
tmpfs(join(base, 'disk'));
const opts = (name) => ({ sessionId: 'sid-' + name, dataDir: join(base, 'disk', name), storage: 'tmpfs', chdir: work, home: base, cliBin: '/bin/true', cliArgs: [] });
for (const name of ['live', 'other']) mkdirSync(join(base, 'disk', name), { recursive: true });
if (!prepareScratchSandbox(opts('live'))) throw new Error('prepare live');
// Since then: a real volume was mounted, and another data dir's session started.
const fresh = join(base, 'fresh-volume');
tmpfs(fresh);
if (!prepareScratchSandbox(opts('other'))) throw new Error('prepare other');
// Daemon restart: the live tree is still mounted and gets adopted.
const adopted = prepareScratchSandbox(opts('live'));
const roBinds = [];
if (adopted) for (let i = 0; i + 2 < adopted.args.length; i++) {
  if (adopted.args[i] === '--ro-bind' && adopted.args[i + 1] === adopted.args[i + 2]) roBinds.push(adopted.args[i + 1]);
}
const subs = JSON.parse(readFileSync(join(base, 'disk', 'live', 'sandboxes', 'sid-live', 'scratch.json'), 'utf8')).subs;
console.log(JSON.stringify({ adopted: !!adopted, fresh, roBinds, subsWithoutDir: subs.filter(s => s.dir === undefined).length, subs: subs.length }));
`, { tmpfs: [base] });
    const result = lastJsonLine<{ adopted: boolean; fresh: string; roBinds: string[]; subs: number; subsWithoutDir: number }>(run);
    expect(result.adopted, run.stderr).toBe(true);
    // The adopted marker keeps every sub-overlay's dir for the next re-mount.
    expect(result.subs).toBeGreaterThan(0);
    expect(result.subsWithoutDir).toBe(0);
    expect(result.roBinds).toContain(result.fresh);
    expect(result.roBinds.filter(p => p.includes('/sandboxes/'))).toEqual([]);
  });

  it('a disk session resumed after the host gained a mount keeps each mount\'s own writes', () => {
    const base = freshBase();
    const run = runInPrivateMountNs(`${PRELUDE}
import { prepareScratchSandbox } from './src/adapters/backend/scratch-sandbox.js';
import { mountsAtOrUnder } from './src/adapters/backend/sandbox.js';
const base = ${JSON.stringify(base)};
const [a, b, c] = ['a', 'b', 'c'].map(n => join(base, 'vol', n));
tmpfs(a); tmpfs(c);
const work = join(base, 'work');
tmpfs(work);
const dataDir = join(base, 'data');
tmpfs(dataDir);
const opts = { sessionId: 'sid-disk', dataDir, storage: 'disk', chdir: work, home: base, cliBin: '/bin/true', cliArgs: [] };
const sessionRoot = join(dataDir, 'sandboxes', 'sid-disk');
const reboot = () => { for (const mp of mountsAtOrUnder(sessionRoot)) spawnSync('umount', ['-l', mp]); };
const ls = (view, p) => spawnSync('ls', ['-A', join(view, p)], { encoding: 'utf8' }).stdout.trim().split('\\n').filter(Boolean);
const s1 = prepareScratchSandbox(opts);
if (!s1) throw new Error('prepare');
writeFileSync(join(s1.mergedHostPath, c, 'edit-on-c.txt'), 'x');
// Reboot; afterwards one more volume is mounted, sorting before c.
reboot();
tmpfs(b);
const s2 = prepareScratchSandbox(opts);
const afterGain = s2 ? { b: ls(s2.mergedHostPath, b), c: ls(s2.mergedHostPath, c) } : null;
// A marker written before sub dirs were recorded: the old index is still found.
reboot();
const metaFile = join(sessionRoot, 'scratch.json');
const meta = JSON.parse(readFileSync(metaFile, 'utf8'));
writeFileSync(metaFile, JSON.stringify({ ...meta, subs: meta.subs.filter(s => s.mountpoint !== b).map(s => ({ mountpoint: s.mountpoint })) }));
spawnSync('umount', [b]);
const s3 = prepareScratchSandbox(opts);
const legacy = s3 ? { c: ls(s3.mergedHostPath, c) } : null;
console.log(JSON.stringify({ afterGain, legacy }));
`, { tmpfs: [base] });
    const result = lastJsonLine<{ afterGain: { b: string[]; c: string[] } | null; legacy: { c: string[] } | null }>(run);
    expect(result.afterGain, run.stderr).toEqual({ b: [], c: ['edit-on-c.txt'] });
    expect(result.legacy, run.stderr).toEqual({ c: ['edit-on-c.txt'] });
  });

  it('a tree whose prepare died half-way: reclaimed by the next prepare, left alone while its preparer runs', () => {
    const base = freshBase();
    const run = runInPrivateMountNs(`${PRELUDE}
import { spawn } from 'node:child_process';
import { prepareScratchSandbox, sweepOrphanScratchSandboxes } from './src/adapters/backend/scratch-sandbox.js';
import { mountsAtOrUnder } from './src/adapters/backend/sandbox.js';
const base = ${JSON.stringify(base)};
const work = join(base, 'work');
tmpfs(work);
const dataDir = join(base, 'data');
tmpfs(dataDir);
const opts = { sessionId: 'sid-half', dataDir, storage: 'tmpfs', chdir: work, home: base, cliBin: '/bin/true', cliArgs: [] };
const sessionRoot = join(dataDir, 'sandboxes', 'sid-half');
const startOf = (pid) => readFileSync('/proc/' + pid + '/stat', 'utf8').slice(readFileSync('/proc/' + pid + '/stat', 'utf8').lastIndexOf(')') + 2).split(' ')[19];
const record = (owner) => writeFileSync(join(sessionRoot, 'preparing'), JSON.stringify(owner));
// Shape a prepare leaves when killed after mounting, before its marker.
const halfPrepared = (owner) => {
  if (!prepareScratchSandbox(opts)) throw new Error('prepare');
  rmSync(join(sessionRoot, 'scratch.json'));
  record(owner);
  const old = new Date(Date.now() - 3_600_000);
  utimesSync(sessionRoot, old, old);
};
// 1. Its preparer is still running (another process, mid-mount): the sweep and
//    a second prepare both leave it alone.
const preparer = spawn('sleep', ['60'], { stdio: 'ignore' });
await new Promise(r => setTimeout(r, 100));
halfPrepared({ pid: preparer.pid, start: startOf(preparer.pid) });
sweepOrphanScratchSandboxes(dataDir, new Set(), { slotRoot: join(base, 'no-slots') });
const whileRunning = { mounts: mountsAtOrUnder(sessionRoot).length, secondPrepare: !!prepareScratchSandbox(opts) };
const outcome = (sbx) => ({ prepared: !!sbx, marker: existsSync(join(sessionRoot, 'scratch.json')), preparingLeft: existsSync(join(sessionRoot, 'preparing')) });
// 2. The pid now belongs to another process (start time differs): residue.
record({ pid: preparer.pid, start: '1' });
const afterPidReuse = outcome(prepareScratchSandbox(opts));
// 3. The preparer is gone: the next prepare takes the residue down and builds afresh.
halfPrepared({ pid: preparer.pid, start: startOf(preparer.pid) });
preparer.kill('SIGKILL');
await new Promise(r => preparer.once('exit', r));
const afterOwnerDied = outcome(prepareScratchSandbox(opts));
// 4. The sweep reads a reused pid the same way: residue, reclaimed.
const other = spawn('sleep', ['60'], { stdio: 'ignore' });
await new Promise(r => setTimeout(r, 100));
halfPrepared({ pid: other.pid, start: '1' });
sweepOrphanScratchSandboxes(dataDir, new Set(), { slotRoot: join(base, 'no-slots') });
const sweptAfterPidReuse = { mounts: mountsAtOrUnder(sessionRoot).length, tree: existsSync(sessionRoot) };
other.kill('SIGKILL');
console.log(JSON.stringify({ whileRunning, afterPidReuse, afterOwnerDied, sweptAfterPidReuse }));
`, { tmpfs: [base] });
    const result = lastJsonLine<{
      whileRunning: { mounts: number; secondPrepare: boolean };
      afterPidReuse: { prepared: boolean; marker: boolean; preparingLeft: boolean };
      afterOwnerDied: { prepared: boolean; marker: boolean; preparingLeft: boolean };
      sweptAfterPidReuse: { mounts: number; tree: boolean };
    }>(run);
    expect(result.whileRunning.mounts, run.stderr).toBeGreaterThan(0);
    expect(result.whileRunning.secondPrepare).toBe(false);
    expect(result.afterPidReuse, run.stderr).toEqual({ prepared: true, marker: true, preparingLeft: false });
    expect(result.afterOwnerDied, run.stderr).toEqual({ prepared: true, marker: true, preparingLeft: false });
    expect(result.sweptAfterPidReuse).toEqual({ mounts: 0, tree: false });
  });

  it('a fresh session whose marker cannot be written fails closed and leaves nothing mounted', () => {
    const base = freshBase();
    const run = runInPrivateMountNs(`${PRELUDE}
import { prepareScratchSandbox } from './src/adapters/backend/scratch-sandbox.js';
import { mountsAtOrUnder } from './src/adapters/backend/sandbox.js';
const base = ${JSON.stringify(base)};
const work = join(base, 'work');
tmpfs(work);
const dataDir = join(base, 'data');
tmpfs(dataDir);
const sessionRoot = join(dataDir, 'sandboxes', 'sid-nomarker');
// A directory where the marker file goes: the atomic rename onto it fails.
mkdirSync(join(sessionRoot, 'scratch.json', 'blocker'), { recursive: true });
const sbx = prepareScratchSandbox({ sessionId: 'sid-nomarker', dataDir, storage: 'tmpfs', chdir: work, home: base, cliBin: '/bin/true', cliArgs: [] });
console.log(JSON.stringify({ prepared: !!sbx, mountsLeft: mountsAtOrUnder(sessionRoot).length }));
`, { tmpfs: [base] });
    const result = lastJsonLine<{ prepared: boolean; mountsLeft: number }>(run);
    expect(result, run.stderr).toEqual({ prepared: false, mountsLeft: 0 });
  });

  it('a recorded view left half-mounted is re-mounted from its marker, each mount with its own writes', () => {
    const base = freshBase();
    const run = runInPrivateMountNs(`${PRELUDE}
import { prepareScratchSandbox } from './src/adapters/backend/scratch-sandbox.js';
const base = ${JSON.stringify(base)};
const vol = join(base, 'vol');
tmpfs(vol);
const work = join(base, 'work');
tmpfs(work);
const out = {};
for (const storage of ['disk', 'tmpfs']) {
  const dataDir = join(base, storage + '-data');
  tmpfs(dataDir);
  const opts = { sessionId: 'sid-' + storage, dataDir, storage, chdir: work, home: base, cliBin: '/bin/true', cliArgs: [] };
  const s1 = prepareScratchSandbox(opts);
  if (!s1) throw new Error('prepare ' + storage);
  writeFileSync(join(s1.mergedHostPath, vol, 'edit.txt'), storage);
  // A re-mount or teardown that stopped half-way: this mount's bind is gone.
  spawnSync('umount', [join(s1.mergedHostPath, vol)]);
  const s2 = prepareScratchSandbox(opts);
  out[storage] = s2 ? spawnSync('ls', ['-A', join(s2.mergedHostPath, vol)], { encoding: 'utf8' }).stdout.trim() : null;
}
console.log(JSON.stringify(out));
`, { tmpfs: [base] });
    expect(lastJsonLine<Record<string, string | null>>(run), run.stderr).toEqual({ disk: 'edit.txt', tmpfs: 'edit.txt' });
  });

  it('a recorded session whose re-mount fails keeps its tree and its writes for the next attempt', () => {
    const base = freshBase();
    const run = runInPrivateMountNs(`${PRELUDE}
import { prepareScratchSandbox } from './src/adapters/backend/scratch-sandbox.js';
import { mountsAtOrUnder } from './src/adapters/backend/sandbox.js';
const base = ${JSON.stringify(base)};
const vol = join(base, 'vol');
tmpfs(vol);
const work = join(base, 'work');
tmpfs(work);
const dataDir = join(base, 'data');
tmpfs(dataDir);
const opts = { sessionId: 'sid-keep', dataDir, storage: 'disk', chdir: work, home: base, cliBin: '/bin/true', cliArgs: [] };
const sessionRoot = join(dataDir, 'sandboxes', 'sid-keep');
const s1 = prepareScratchSandbox(opts);
if (!s1) throw new Error('prepare');
writeFileSync(join(s1.mergedHostPath, vol, 'work.txt'), 'x');
for (const mp of mountsAtOrUnder(sessionRoot)) spawnSync('umount', ['-l', mp]); // reboot
// The cold resume fails after it re-mounted (a gateway socket that is not one).
const notSocket = join(base, 'not-a-socket');
writeFileSync(notSocket, '');
const failed = prepareScratchSandbox({ ...opts, mcpGatewaySocketPath: notSocket });
const afterFail = { prepared: !!failed, marker: existsSync(join(sessionRoot, 'scratch.json')), mounts: mountsAtOrUnder(sessionRoot).length };
const s3 = prepareScratchSandbox(opts);
console.log(JSON.stringify({ afterFail, resumed: s3 ? spawnSync('ls', ['-A', join(s3.mergedHostPath, vol)], { encoding: 'utf8' }).stdout.trim() : null }));
`, { tmpfs: [base] });
    const result = lastJsonLine<{ afterFail: { prepared: boolean; marker: boolean; mounts: number }; resumed: string | null }>(run);
    expect(result.afterFail, run.stderr).toEqual({ prepared: false, marker: true, mounts: 0 });
    expect(result.resumed).toBe('work.txt');
  });

  it('while another live process prepares a session, a second prepare and the close-time teardown stay out', () => {
    const base = freshBase();
    const run = runInPrivateMountNs(`${PRELUDE}
import { spawn } from 'node:child_process';
import { prepareScratchSandbox, teardownScratchSession } from './src/adapters/backend/scratch-sandbox.js';
import { mountsAtOrUnder } from './src/adapters/backend/sandbox.js';
const base = ${JSON.stringify(base)};
const work = join(base, 'work');
tmpfs(work);
const dataDir = join(base, 'data');
tmpfs(dataDir);
const opts = { sessionId: 'sid-busy', dataDir, storage: 'tmpfs', chdir: work, home: base, cliBin: '/bin/true', cliArgs: [] };
const sessionRoot = join(dataDir, 'sandboxes', 'sid-busy');
const stat = (pid) => readFileSync('/proc/' + pid + '/stat', 'utf8');
const startOf = (pid) => stat(pid).slice(stat(pid).lastIndexOf(')') + 2).split(' ')[19];
const other = spawn('sleep', ['60'], { stdio: 'ignore' });
await new Promise(r => setTimeout(r, 100));
const owner = JSON.stringify({ pid: other.pid, start: startOf(other.pid) });
// Before its first mount…
mkdirSync(sessionRoot, { recursive: true });
writeFileSync(join(sessionRoot, 'preparing'), owner);
const beforeMount = { prepared: !!prepareScratchSandbox(opts), recordKept: readFileSync(join(sessionRoot, 'preparing'), 'utf8') === owner };
rmSync(join(sessionRoot, 'preparing'));
// …and with the view up, mid-way to its marker.
if (!prepareScratchSandbox(opts)) throw new Error('prepare');
rmSync(join(sessionRoot, 'scratch.json'));
writeFileSync(join(sessionRoot, 'preparing'), owner);
teardownScratchSession('sid-busy', dataDir);
const afterTeardown = mountsAtOrUnder(sessionRoot).length;
other.kill('SIGKILL');
console.log(JSON.stringify({ beforeMount, afterTeardown }));
`, { tmpfs: [base] });
    const result = lastJsonLine<{ beforeMount: { prepared: boolean; recordKept: boolean }; afterTeardown: number }>(run);
    expect(result.beforeMount, run.stderr).toEqual({ prepared: false, recordKept: true });
    expect(result.afterTeardown).toBeGreaterThan(0);
  });

  it('a prepare that cannot record itself refuses before mounting anything; one of our own that failed is reclaimed', () => {
    const base = freshBase();
    const run = runInPrivateMountNs(`${PRELUDE}
import { prepareScratchSandbox } from './src/adapters/backend/scratch-sandbox.js';
import { mountsAtOrUnder } from './src/adapters/backend/sandbox.js';
const base = ${JSON.stringify(base)};
const work = join(base, 'work');
tmpfs(work);
const dataDir = join(base, 'data');
tmpfs(dataDir);
const opts = (sid) => ({ sessionId: sid, dataDir, storage: 'tmpfs', chdir: work, home: base, cliBin: '/bin/true', cliArgs: [] });
// A directory where the record goes: the atomic rename onto it fails.
mkdirSync(join(dataDir, 'sandboxes', 'sid-norecord', 'preparing', 'blocker'), { recursive: true });
const noRecord = { prepared: !!prepareScratchSandbox(opts('sid-norecord')), mounts: mountsAtOrUnder(join(dataDir, 'sandboxes', 'sid-norecord')).length };
// This process's own earlier attempt died half-way (marker never written).
const own = join(dataDir, 'sandboxes', 'sid-own');
if (!prepareScratchSandbox(opts('sid-own'))) throw new Error('prepare');
rmSync(join(own, 'scratch.json'));
const st = readFileSync('/proc/self/stat', 'utf8');
writeFileSync(join(own, 'preparing'), JSON.stringify({ pid: process.pid, start: st.slice(st.lastIndexOf(')') + 2).split(' ')[19] }));
const ownRetry = !!prepareScratchSandbox(opts('sid-own'));
console.log(JSON.stringify({ noRecord, ownRetry }));
`, { tmpfs: [base] });
    expect(lastJsonLine(run), run.stderr).toEqual({ noRecord: { prepared: false, mounts: 0 }, ownRetry: true });
  });

  it.skipIf(!hasFuseOverlay)('the orphan sweep reclaims a tree left mounted without its marker, fuse daemons included', () => {
    const base = freshBase();
    const run = runInPrivateMountNs(`${PRELUDE}
import { prepareScratchSandbox, sweepOrphanScratchSandboxes } from './src/adapters/backend/scratch-sandbox.js';
import { mountsAtOrUnder } from './src/adapters/backend/sandbox.js';
const base = ${JSON.stringify(base)};
const work = join(base, 'work');
tmpfs(work);
const dataDir = join(base, 'data');
tmpfs(dataDir);
// fuse-overlayfs for the main overlay and every submount (a non-root daemon's
// path, and the kernel-depth fallback): each daemon names the tree in its argv.
process.env.BOTMUX_SANDBOX_FUSE = '1';
const sbx = prepareScratchSandbox({ sessionId: 'sid-half', dataDir, storage: 'disk', chdir: work, home: base, cliBin: '/bin/true', cliArgs: [] });
if (!sbx) throw new Error('prepare failed');
// Running daemons only: the snippet is this namespace's PID 1 and does not
// reap orphans, so an exited daemon lingers as a zombie.
const fuseDaemons = () => readdirSync('/proc').filter(p => /^\\d+$/.test(p)).filter(p => {
  try {
    const stat = readFileSync('/proc/' + p + '/stat', 'utf8');
    return /\\(fuse-overlayfs\\) [^Z]/.test(stat);
  } catch { return false; }
}).length;
const sessionRoot = join(dataDir, 'sandboxes', 'sid-half');
// The prepare was killed after mounting, before writing its marker.
rmSync(join(sessionRoot, 'scratch.json'));
const old = new Date(Date.now() - 3_600_000);
utimesSync(sessionRoot, old, old);
const before = { mounts: mountsAtOrUnder(sessionRoot).length, fuse: fuseDaemons() };
sweepOrphanScratchSandboxes(dataDir, new Set(), { slotRoot: join(base, 'no-slots') });
const deadline = Date.now() + 5_000;
while (fuseDaemons() > 0 && Date.now() < deadline) spawnSync('sleep', ['0.1']);
console.log(JSON.stringify({
  before,
  after: { mounts: mountsAtOrUnder(sessionRoot)?.length ?? -1, fuse: fuseDaemons(), treeExists: existsSync(sessionRoot) },
}));
`, { tmpfs: [base] });
    const result = lastJsonLine<{
      before: { mounts: number; fuse: number };
      after: { mounts: number; fuse: number; treeExists: boolean };
    }>(run);
    expect(result.before.mounts, run.stderr).toBeGreaterThan(0);
    expect(result.before.fuse, run.stderr).toBeGreaterThan(0);
    expect(result.after, run.stderr).toEqual({ mounts: 0, fuse: 0, treeExists: false });
  });
});
