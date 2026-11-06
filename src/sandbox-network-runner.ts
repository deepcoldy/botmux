/** Owns one private user/network namespace and its userspace network link.
 * No namespace handle, filter path or parent control FD is exposed to the task.
 * A link failure closes the namespace process; no unfiltered fallback. */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { closeSync, writeSync } from 'node:fs';
import { Socket } from 'node:net';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isStandaloneBinary, resolveEntrySpawn } from './core/self-spawn.js';
import { networkSocketFilter, type NetworkLaunchPlan } from './core/sandbox-network-launch.js';
import {
  materializeProtectedHttpLoopbackArgs,
  startProtectedLocalServiceLoopbackBridge,
  startProtectedHttpEgressLoopbackBridge,
  type ProtectedHttpEgressLoopbackBridge,
  type ProtectedLocalServicePeerResolver,
} from './core/protected-http-egress-loopback.js';
import type { Readable, Writable } from 'node:stream';
import type { ProcessIdentity } from './core/current-actor-attestation.js';
import { mapPidNamespacePeerToHost, resolvePidNamespaceRoot } from './core/pid-namespace-peer.js';

const argv = process.argv.slice(isStandaloneBinary() ? 3 : 2);
const encoded = argv[0];
const inside = argv[1] === '--inside';
let children: ChildProcess[] = [];
let protectedHttpBridge: ProtectedHttpEgressLoopbackBridge | undefined;
let localServiceBridges: ProtectedHttpEgressLoopbackBridge[] = [];
let closePeerResolver: (() => void) | undefined;
const stop = () => {
  for (const child of children) { try { child.kill('SIGKILL'); } catch { /* exited */ } }
  void protectedHttpBridge?.close();
  protectedHttpBridge = undefined;
  for (const bridge of localServiceBridges) void bridge.close();
  localServiceBridges = [];
  closePeerResolver?.();
  closePeerResolver = undefined;
};
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

// fd5 is reserved for bwrap's seccomp program and fd6 temporarily preserves
// task stdin while the filter pipe is wired. Keep the private broker separate.
const PEER_REQUEST_FD = 7;
const PEER_RESPONSE_FD = 8;
const MAX_PEER_BROKER_LINE = 4096;
const MAX_PENDING_PEER_REQUESTS = 64;

function processIdentity(value: unknown): ProcessIdentity | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some(key => key !== 'pid' && key !== 'procStart')
    || !Number.isSafeInteger(record.pid) || Number(record.pid) <= 1
    || typeof record.procStart !== 'string' || !/^\d{1,64}$/.test(record.procStart)) return null;
  return { pid: Number(record.pid), procStart: record.procStart };
}

function namespacePeerResolver(): ProtectedLocalServicePeerResolver {
  let nextId = 1;
  let buffer = '';
  let closed = false;
  const pending = new Map<number, {
    resolve: (peer: ProcessIdentity | null) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  const requests = new Socket({ fd: PEER_REQUEST_FD, readable: false, writable: true });
  // Bun does not reliably poll a readable socket inherited on a numbered FD.
  // Drain it in a killable helper and consume the helper's ordinary stdout pipe,
  // matching the readiness/control-FD pattern below.
  const responseReader = spawn('/bin/sh', ['-c', `exec cat <&${PEER_RESPONSE_FD}`], {
    stdio: ['ignore', 'pipe', 'ignore', 'ignore', 'ignore', 'ignore', 'ignore', 'ignore', PEER_RESPONSE_FD],
  });
  children.push(responseReader);
  closeSync(PEER_RESPONSE_FD);
  const responses = responseReader.stdout!;
  responses.setEncoding('utf8');
  const failAll = () => {
    if (closed) return;
    closed = true;
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.resolve(null);
    }
    pending.clear();
  };
  responses.on('data', raw => {
    buffer += raw;
    if (Buffer.byteLength(buffer) > MAX_PEER_BROKER_LINE * MAX_PENDING_PEER_REQUESTS) {
      failAll();
      responses.destroy();
      return;
    }
    for (;;) {
      const newline = buffer.indexOf('\n');
      if (newline < 0) break;
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!line || Buffer.byteLength(line) > MAX_PEER_BROKER_LINE) {
        failAll();
        responses.destroy();
        return;
      }
      let parsed: Record<string, unknown>;
      try { parsed = JSON.parse(line) as Record<string, unknown>; } catch {
        failAll();
        responses.destroy();
        return;
      }
      if (!parsed || Array.isArray(parsed)
        || Object.keys(parsed).some(key => key !== 'id' && key !== 'peer')
        || !Number.isSafeInteger(parsed.id)) {
        failAll();
        responses.destroy();
        return;
      }
      const id = Number(parsed.id);
      const entry = pending.get(id);
      if (!entry) continue;
      const peer = parsed.peer === null ? null : processIdentity(parsed.peer);
      if (parsed.peer !== null && !peer) {
        failAll();
        responses.destroy();
        return;
      }
      pending.delete(id);
      clearTimeout(entry.timer);
      entry.resolve(peer);
    }
  });
  responses.once('error', failAll);
  responses.once('end', failAll);
  responseReader.once('error', failAll);
  responseReader.once('exit', failAll);
  requests.once('error', failAll);
  closePeerResolver = () => {
    failAll();
    requests.destroy();
    responseReader.kill('SIGKILL');
    responses.destroy();
  };
  return peer => new Promise(resolve => {
    if (closed || pending.size >= MAX_PENDING_PEER_REQUESTS || !processIdentity(peer)) {
      resolve(null);
      return;
    }
    const id = nextId++;
    if (!Number.isSafeInteger(nextId)) nextId = 1;
    const timer = setTimeout(() => {
      pending.delete(id);
      resolve(null);
    }, 2_000).unref();
    pending.set(id, { resolve, timer });
    try {
      requests.write(`${JSON.stringify({ id, ...peer })}\n`, error => {
        if (!error) return;
        const entry = pending.get(id);
        if (!entry) return;
        pending.delete(id);
        clearTimeout(entry.timer);
        entry.resolve(null);
      });
    } catch {
      pending.delete(id);
      clearTimeout(timer);
      resolve(null);
    }
  });
}

function startNamespacePeerBroker(
  namespaceProcess: ChildProcess,
  namespaceRoot: ProcessIdentity,
): void {
  const stdio = namespaceProcess.stdio as unknown as Array<Readable | Writable | null | undefined>;
  const requests = stdio[PEER_REQUEST_FD] as Readable;
  const responses = stdio[PEER_RESPONSE_FD] as Writable;
  let buffer = '';
  const fail = () => { try { namespaceProcess.kill('SIGKILL'); } catch { /* exited */ } };
  requests.on('data', raw => {
    buffer += raw.toString();
    if (Buffer.byteLength(buffer) > MAX_PEER_BROKER_LINE * MAX_PENDING_PEER_REQUESTS) return fail();
    for (;;) {
      const newline = buffer.indexOf('\n');
      if (newline < 0) break;
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!line || Buffer.byteLength(line) > MAX_PEER_BROKER_LINE) return fail();
      let parsed: Record<string, unknown>;
      try { parsed = JSON.parse(line) as Record<string, unknown>; } catch { return fail(); }
      if (!parsed || Array.isArray(parsed)
        || Object.keys(parsed).some(key => !['id', 'pid', 'procStart'].includes(key))
        || !Number.isSafeInteger(parsed.id)) return fail();
      const peer = processIdentity({ pid: parsed.pid, procStart: parsed.procStart });
      if (!peer) return fail();
      const mapped = mapPidNamespacePeerToHost({ namespaceRoot, peer });
      if (!responses.write(`${JSON.stringify({ id: parsed.id, peer: mapped })}\n`)) {
        requests.pause();
        responses.once('drain', () => requests.resume());
      }
    }
  });
  requests.once('error', fail);
  responses.once('error', fail);
}

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
    let taskArgs = plan.args;
    const resolveProcessPeer = plan.localServiceBridges?.some(bridge => bridge.attestProcessPeer)
      ? namespacePeerResolver()
      : undefined;
    for (const bridgePlan of plan.localServiceBridges ?? []) {
      localServiceBridges.push(resolveProcessPeer
        ? await startProtectedLocalServiceLoopbackBridge(bridgePlan, resolveProcessPeer)
        : await startProtectedLocalServiceLoopbackBridge(bridgePlan));
    }
    if (plan.protectedHttpBridge) {
      protectedHttpBridge = await startProtectedHttpEgressLoopbackBridge(plan.protectedHttpBridge);
      taskArgs = materializeProtectedHttpLoopbackArgs(
        plan.args,
        plan.protectedHttpBridge.placeholderOrigin,
        protectedHttpBridge.origin,
        plan.protectedHttpBridgeArgsOffset,
      );
    }
    // Feed an immutable anonymous pipe; no mutable host filter file exists.
    const octal = [...networkSocketFilter()].map(byte => `\\${byte.toString(8).padStart(3, '0')}`).join('');
    const task = spawn('/bin/sh', ['-c', `exec 6<&0 || exit; printf '${octal}' | { exec "$@" 5<&0 0<&6 6<&- 7<&- 8<&-; }`, 'botmux-network-filter', plan.command, ...taskArgs], { stdio: 'inherit' });
    children.push(task);
    return await waitExit(task);
  }
  const entry = resolveEntrySpawn('sandbox-network-runner', dirname(fileURLToPath(import.meta.url)));
  const ns = spawn(plan.unshare, ['--user', '--map-root-user', '--net', '--pid', '--fork', '--mount-proc', '--kill-child', entry.command, ...entry.args, encoded, '--inside'], {
    stdio: ['inherit', 'inherit', 'inherit', 'pipe', 'pipe', 'ignore', 'ignore', 'pipe', 'pipe'],
  });
  children = [ns];
  const nsExit = waitExit(ns);
  await ready(ns, 3);
  if (plan.localServiceBridges?.some(bridge => bridge.attestProcessPeer)) {
    const namespaceRoot = ns.pid ? resolvePidNamespaceRoot(ns.pid) : null;
    if (!namespaceRoot) throw new Error('cannot resolve private PID namespace root');
    startNamespacePeerBroker(ns, namespaceRoot);
  }
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
