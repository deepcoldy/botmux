/**
 * prepareScratchSandboxDetailed hands back WHY it refused, on real mounts, and
 * a real worker turns that reason into the user-facing notice with its fix.
 * Every scenario runs inside a private mount + PID namespace
 * (helpers/private-mount-ns.ts), so nothing mounted here reaches the host mount
 * table even if the run is killed. Root only; everything else skips.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { lastJsonLine, privateMountNsAvailable, runInPrivateMountNs } from './helpers/private-mount-ns.js';
import { tsEvalArgs, tsRunnerPrefix } from './helpers/ts-runner.js';
import { scratchFailureNotice } from '../src/adapters/backend/scratch-capability.js';

const runtime = privateMountNsAvailable();

// Outside /tmp: scratch treats /tmp as container-owned. The base gets a
// namespace-private tmpfs, so on the host it stays an empty dir.
const bases: string[] = [];
function freshBase(): string {
  const base = mkdtempSync(join(resolve('.'), '.scratch-fail-'));
  bases.push(base);
  return base;
}
afterEach(() => {
  for (const base of bases.splice(0)) rmdirSync(base);
});

const PRELUDE = `
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { prepareScratchSandboxDetailed } from './src/adapters/backend/scratch-sandbox.js';
import { mountsAtOrUnder } from './src/adapters/backend/sandbox.js';
const tmpfs = (dir) => {
  mkdirSync(dir, { recursive: true });
  const r = spawnSync('mount', ['-t', 'tmpfs', '-o', 'size=4m', 'tmpfs', dir], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error('mount ' + dir + ': ' + r.stderr);
};
const unmountAll = (dir) => { for (const mp of mountsAtOrUnder(dir) ?? []) spawnSync('umount', ['-l', mp]); };
const outcome = (r) => (r.ok ? { ok: true } : { ok: false, reason: r.failure.reason, recordedStorage: r.failure.recordedStorage });
`;

describe.skipIf(!runtime)('scratch prepare failure reasons (real mounts, private namespace)', () => {
  it('a recorded tmpfs session whose upper slot is gone reports tmpfs-upper-lost', () => {
    const base = freshBase();
    const run = runInPrivateMountNs(`${PRELUDE}
const base = ${JSON.stringify(base)};
const work = join(base, 'work'); tmpfs(work);
const dataDir = join(base, 'data'); tmpfs(dataDir);
const opts = { sessionId: 'sid-tmpfs', dataDir, storage: 'tmpfs', chdir: work, home: base, cliBin: '/bin/true', cliArgs: [] };
const first = outcome(prepareScratchSandboxDetailed(opts));
// Reboot: every mount of the session and its RAM slot is gone, the marker stays.
unmountAll(join(dataDir, 'sandboxes', 'sid-tmpfs'));
unmountAll('/var/tmp/botmux-scratch');
const afterReboot = outcome(prepareScratchSandboxDetailed(opts));
console.log(JSON.stringify({ first, afterReboot }));
`, { tmpfs: [base] });
    const result = lastJsonLine<{ first: unknown; afterReboot: unknown }>(run);
    expect(result.first, run.stderr).toEqual({ ok: true });
    expect(result.afterReboot, run.stderr).toEqual({ ok: false, reason: 'tmpfs-upper-lost' });
  });

  it('a session re-prepared with another storage reports the storage it was created with', () => {
    const base = freshBase();
    const run = runInPrivateMountNs(`${PRELUDE}
const base = ${JSON.stringify(base)};
const work = join(base, 'work'); tmpfs(work);
const dataDir = join(base, 'data'); tmpfs(dataDir);
const opts = { sessionId: 'sid-disk', dataDir, storage: 'disk', chdir: work, home: base, cliBin: '/bin/true', cliArgs: [] };
const first = outcome(prepareScratchSandboxDetailed(opts));
const switched = outcome(prepareScratchSandboxDetailed({ ...opts, storage: 'tmpfs' }));
console.log(JSON.stringify({ first, switched }));
`, { tmpfs: [base] });
    const result = lastJsonLine<{ first: unknown; switched: unknown }>(run);
    expect(result.first, run.stderr).toEqual({ ok: true });
    expect(result.switched, run.stderr).toEqual({ ok: false, reason: 'storage-conflict', recordedStorage: 'disk' });
  });

  it('a non-root daemon: tmpfs reports tmpfs-needs-root, and the probe said so beforehand', () => {
    const base = freshBase();
    // The daemon side, run as nobody: probe first, then a real tmpfs prepare.
    const child = `
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { probeScratchCapability } from './src/adapters/backend/scratch-capability.js';
import { prepareScratchSandboxDetailed } from './src/adapters/backend/scratch-sandbox.js';
const base = ${JSON.stringify(join(base, 'nobody'))};
const work = join(base, 'work'); mkdirSync(work, { recursive: true });
const dataDir = join(base, 'data'); mkdirSync(dataDir, { recursive: true });
const probe = probeScratchCapability().storages.tmpfs;
const r = prepareScratchSandboxDetailed({ sessionId: 'sid-nonroot', dataDir, storage: 'tmpfs', chdir: work, home: base, cliBin: '/bin/true', cliArgs: [] });
console.log(JSON.stringify({ uid: process.getuid(), probe, prepared: r.ok ? 'ok' : r.failure.reason }));
`;
    const { command, prefixArgs } = tsRunnerPrefix();
    const argv = [command, ...prefixArgs, ...tsEvalArgs(child).args];
    const run = runInPrivateMountNs(`${PRELUDE}
import { chownSync } from 'node:fs';
const home = join(${JSON.stringify(base)}, 'nobody');
mkdirSync(home, { recursive: true });
chownSync(home, 65534, 65534);
const r = spawnSync('setpriv', ['--reuid', '65534', '--regid', '65534', '--clear-groups', ...${JSON.stringify(argv)}],
  { encoding: 'utf8', env: { ...process.env, HOME: home, TMPDIR: home }, timeout: 60_000 });
process.stderr.write(r.stderr ?? '');
console.log((r.stdout ?? '').trim().split('\\n').pop());
`, { tmpfs: [base] });
    const result = lastJsonLine<{ uid: number; probe: { usable: string; problems: string[] }; prepared: string }>(run);
    expect(result.uid, run.stderr).toBe(65534);
    expect(result.probe).toEqual({ usable: 'no', problems: ['tmpfs-needs-root'] });
    expect(result.prepared, run.stderr).toBe('tmpfs-needs-root');
  });

  it('a real worker tells the user the reason and its fix instead of a generic failure', () => {
    const base = freshBase();
    // The worker talks to its parent only: no live daemon / bot identity leaks in.
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(BOTMUX_|LARK_)/.test(key)));
    const run = runInPrivateMountNs(`${PRELUDE}
import { writeFileSync } from 'node:fs';
import { spawnNodeTsScript } from './test/helpers/ts-runner.js';
const base = ${JSON.stringify(base)};
const work = join(base, 'work');
mkdirSync(work);
const dataDir = join(base, 'botmux', 'data');
// A session recorded as a disk scratch session, now configured for tmpfs.
const tree = join(dataDir, 'sandboxes', 'storage-switched');
mkdirSync(join(tree, 'root'), { recursive: true });
writeFileSync(join(tree, 'scratch.json'), JSON.stringify({ v: 1, sid: 'storage-switched', storage: 'disk', lower: '/',
  merged: join(tree, 'root'), upper: join(tree, 'upper'), work: join(tree, 'work'), subs: [], createdAt: 1 }));
const messages = [];
const worker = spawnNodeTsScript('src/worker.ts', [], {
  env: { ...process.env, HOME: join(base, 'home'), SESSION_DATA_DIR: dataDir, BOTMUX_SANDBOX: 'scratch', BOTMUX_NO_CLAIM: '1' },
  stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
});
worker.on('message', m => messages.push(m));
worker.send({ type: 'init', sessionId: 'storage-switched', chatId: 'oc_fixture', rootMessageId: 'om_fixture', workingDir: work,
  cliId: 'claude-code', cliPathOverride: '/bin/true', backendType: 'pty', prompt: '', larkAppId: 'app_test', larkAppSecret: 'fixture-secret' });
const deadline = Date.now() + 45_000;
while (Date.now() < deadline && !messages.some(m => m.type === 'ready' || m.type === 'error')) await new Promise(r => setTimeout(r, 100));
worker.kill('SIGKILL');
console.log(JSON.stringify({ errors: messages.filter(m => m.type === 'error').map(m => m.message), ready: messages.some(m => m.type === 'ready') }));
`, { tmpfs: [base], env, timeoutMs: 90_000 });
    const result = lastJsonLine<{ errors: string[]; ready: boolean }>(run);
    expect(result.ready).toBe(false);
    expect(result.errors, run.stderr).toEqual([scratchFailureNotice({ reason: 'storage-conflict', recordedStorage: 'disk' })]);
  }, 120_000);
});
