/** Owns one private user/network namespace and its userspace network link.
 * No namespace handle, filter path or parent control FD is exposed to the task.
 * A link failure closes the namespace process; no unfiltered fallback. */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { closeSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isStandaloneBinary, resolveEntrySpawn } from './core/self-spawn.js';
import { networkSocketFilter, type NetworkLaunchPlan } from './core/sandbox-network-launch.js';
import type { Readable, Writable } from 'node:stream';

const argv = process.argv.slice(isStandaloneBinary() ? 3 : 2);
const encoded = argv[0];
const inside = argv[1] === '--inside';
let children: ChildProcess[] = [];
const stop = () => { for (const child of children) { try { child.kill('SIGKILL'); } catch { /* exited */ } } };
process.once('exit', stop);
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.once(signal, () => { stop(); process.exit(128 + (signal === 'SIGINT' ? 2 : signal === 'SIGHUP' ? 1 : 15)); });
const waitExit = (child: ChildProcess) => new Promise<number>((resolve, reject) => { child.once('error', reject); child.once('exit', code => resolve(code ?? 1)); });
const ready = (child: ChildProcess, fd: number) => new Promise<void>((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('network namespace readiness timed out')), 10000);
  const stream = child.stdio[fd] as Readable;
  const done = (error?: Error) => { clearTimeout(timer); stream.removeListener('data', onData); child.removeListener('error', onError); child.removeListener('exit', onExit); error ? reject(error) : resolve(); };
  const onData = () => done();
  const onError = (error: Error) => done(error);
  const onExit = () => done(new Error('network namespace exited before readiness'));
  stream.once('data', onData); child.once('error', onError); child.once('exit', onExit);
});

async function main() {
  if (!encoded) throw new Error('missing network launch plan');
  const plan = JSON.parse(Buffer.from(encoded, 'base64').toString()) as NetworkLaunchPlan;
  if (process.platform !== 'linux') throw new Error('network runner requires Linux');
  if (inside) {
    // Network is down while the kernel policy is installed, before the link exists.
    const applied = spawnSync('/bin/sh', ['-c', 'printf \"%s\" \"$1\" | \"$2\" -f -', 'botmux-network-nft', plan.nftRules, plan.nft], { encoding: 'utf8', timeout: 5000 });
    if (applied.status !== 0) throw new Error(`cannot install private nftables policy: ${applied.stderr}`);
    // Keep blocking FD reads in a killable process, rather than a runtime IO
    // thread (which can block Node shutdown or fail to poll inherited Bun FDs).
    const supervisor = spawn('/bin/sh', ['-c', 'dd bs=1 count=1 <&4 2>/dev/null; exec cat <&4 >/dev/null'], {
      stdio: ['ignore', 'pipe', 'ignore', 'ignore', 4],
    });
    children = [supervisor];
    const parentReady = ready(supervisor, 1);
    supervisor.once('exit', () => { stop(); process.exit(1); });
    supervisor.once('error', () => { stop(); process.exit(1); });
    closeSync(4);
    writeSync(3, 'R'); closeSync(3);
    await parentReady;
    // slirp readiness does not wait for IPv6 router advertisements or DAD.
    // Configure its documented prefix explicitly, before starting any task.
    for (const args of [
      ['-6', 'addr', 'replace', 'fd00::100/64', 'dev', 'tap0', 'nodad'],
      ['-6', 'route', 'replace', 'default', 'via', 'fd00::2', 'dev', 'tap0'],
    ]) {
      const configured = spawnSync(plan.ip, args, { encoding: 'utf8', timeout: 5000 });
      if (configured.status !== 0) throw new Error(`cannot configure private IPv6 link: ${configured.stderr}`);
    }
    // Feed an immutable anonymous pipe; no mutable host filter file exists.
    const octal = [...networkSocketFilter()].map(byte => `\\${byte.toString(8).padStart(3, '0')}`).join('');
    const task = spawn('/bin/sh', ['-c', `exec 6<&0 || exit; printf '${octal}' | { exec "$@" 5<&0 0<&6 6<&-; }`, 'botmux-network-filter', plan.command, ...plan.args], { stdio: 'inherit' });
    children.push(task);
    return await waitExit(task);
  }
  const entry = resolveEntrySpawn('sandbox-network-runner', dirname(fileURLToPath(import.meta.url)));
  const ns = spawn(plan.unshare, ['--user', '--map-root-user', '--net', '--pid', '--fork', '--mount-proc', '--kill-child', entry.command, ...entry.args, encoded, '--inside'], {
    stdio: ['inherit', 'inherit', 'inherit', 'pipe', 'pipe'],
  });
  children = [ns];
  const nsExit = waitExit(ns);
  await ready(ns, 3);
  const link = spawn(plan.slirp, ['--configure', '--enable-ipv6', '--disable-host-loopback', '--disable-dns', '--ready-fd=3', '--exit-fd=4', String(ns.pid), 'tap0'], {
    stdio: ['ignore', 2, 2, 'pipe', 'pipe'],
  });
  children.push(link);
  const linkExit = waitExit(link);
  await ready(link, 3);
  (ns.stdio[4] as Writable).write('R');
  // If forwarding dies, kill the CLI lifetime instead of reporting it usable.
  return await Promise.race([nsExit, linkExit.then(() => { ns.kill('SIGKILL'); throw new Error('network forwarder exited'); })]);
}
main().then(code => { stop(); process.exit(code); }).catch(error => { console.error(`[sandbox-network] ${error.message}`); stop(); process.exit(1); });
