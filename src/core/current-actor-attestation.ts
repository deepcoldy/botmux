import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';

import { CURRENT_ACTOR_SCHEMA, normalizeActorEmail, type CurrentActorDocument } from '../cli/current-actor.js';
import { resolveVerifiedUserIdentity } from '../im/lark/identity-cache.js';
import { collectSessionLineagePids } from './preview-port-owner.js';
import { larkTransportEnabled, type DaemonSession } from './types.js';

const TCP_ESTABLISHED_STATE = '01';

export interface ProcessIdentity {
  pid: number;
  procStart: string;
}

export type LoopbackPeerResolution =
  | { ok: true; peer: ProcessIdentity }
  | { ok: false; reason: 'platform_unsupported' | 'not_loopback' | 'socket_unavailable' | 'peer_unresolved' };

function readProcStart(pid: number, procRoot: string): string | undefined {
  if (!Number.isSafeInteger(pid) || pid <= 1) return undefined;
  try {
    const raw = readFileSync(join(procRoot, String(pid), 'stat'), 'utf8');
    const closeParen = raw.lastIndexOf(')');
    if (closeParen < 0) return undefined;
    const fields = raw.slice(closeParen + 2).trim().split(/\s+/);
    return /^\d+$/.test(fields[19] ?? '') ? fields[19] : undefined;
  } catch { /* use the hardened ps fallback below when procfs is unavailable */ }
  if (procRoot !== '/proc') return undefined;
  const ps = ['/usr/bin/ps', '/bin/ps'].find(existsSync);
  if (!ps) return undefined;
  try {
    const started = execFileSync(ps, ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8', timeout: 2_000, stdio: ['ignore', 'pipe', 'ignore'],
      env: { PATH: '/usr/bin:/bin', LANG: 'C' },
    }).trim();
    return started || undefined;
  } catch {
    return undefined;
  }
}

export function snapshotProcessIdentities(
  cliPid: number,
  procRoot = '/proc',
): string[] | undefined {
  if (procRoot === '/proc' && process.platform !== 'linux') return undefined;
  const lineage = collectSessionLineagePids(procRoot, [cliPid]);
  if (!lineage || lineage.size === 0) return undefined;
  const identities: string[] = [];
  for (const pid of lineage) {
    const raw = readProcStart(pid, procRoot);
    if (raw) identities.push(`${pid}:${raw}`);
  }
  return identities.length > 0 ? identities.sort() : undefined;
}

function isLoopbackAddress(address: string | undefined): boolean {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

function peerSocketInodes(procRoot: string, clientPort: number, serverPort: number): Set<string> | undefined {
  const out = new Set<string>();
  let tableRead = false;
  for (const relative of ['net/tcp', 'net/tcp6']) {
    let text: string;
    try {
      text = readFileSync(join(procRoot, relative), 'utf8');
      tableRead = true;
    } catch {
      continue;
    }
    for (const line of text.split('\n')) {
      const fields = line.trim().split(/\s+/);
      if (fields.length < 10 || fields[3] !== TCP_ESTABLISHED_STATE) continue;
      const localPort = Number.parseInt(fields[1]?.split(':').at(-1) ?? '', 16);
      const remotePort = Number.parseInt(fields[2]?.split(':').at(-1) ?? '', 16);
      if (localPort !== clientPort || remotePort !== serverPort) continue;
      if (/^\d+$/.test(fields[9])) out.add(fields[9]);
    }
  }
  return tableRead ? out : undefined;
}

/** Resolve the process that owns the client half of one live loopback TCP request. */
export function resolveLoopbackPeerProcesses(input: {
  remoteAddress?: string;
  remotePort?: number;
  localPort?: number;
  procRoot?: string;
}): LoopbackPeerResolution {
  const procRoot = input.procRoot ?? '/proc';
  if (!isLoopbackAddress(input.remoteAddress)) return { ok: false, reason: 'not_loopback' };
  if (procRoot === '/proc' && process.platform !== 'linux') {
    return { ok: false, reason: 'platform_unsupported' };
  }
  if (!Number.isSafeInteger(input.remotePort) || !input.remotePort
    || !Number.isSafeInteger(input.localPort) || !input.localPort) {
    return { ok: false, reason: 'socket_unavailable' };
  }
  const inodes = peerSocketInodes(procRoot, input.remotePort, input.localPort);
  if (!inodes || inodes.size !== 1) return { ok: false, reason: 'peer_unresolved' };
  const inode = [...inodes][0];
  const needle = `socket:[${inode}]`;
  let entries: string[];
  try { entries = readdirSync(procRoot); } catch { return { ok: false, reason: 'peer_unresolved' }; }
  const peers: ProcessIdentity[] = [];
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    let fds: string[];
    try { fds = readdirSync(join(procRoot, entry, 'fd')); } catch { continue; }
    let ownsSocket = false;
    for (const fd of fds) {
      try {
        if (readlinkSync(join(procRoot, entry, 'fd', fd)) === needle) {
          ownsSocket = true;
          break;
        }
      } catch { /* process/fd raced away */ }
    }
    if (!ownsSocket) continue;
    const procStart = readProcStart(pid, procRoot);
    if (procStart) peers.push({ pid, procStart });
  }
  return peers.length === 1
    ? { ok: true, peer: peers[0] }
    : { ok: false, reason: 'peer_unresolved' };
}

function peerBelongsToCurrentTurn(input: {
  peer: ProcessIdentity;
  cliPid: number;
  procRoot: string;
  preexistingProcessIdentities: ReadonlySet<string>;
}): boolean {
  if (input.procRoot === '/proc' && process.platform !== 'linux') return false;
  let pid = input.peer.pid;
  for (let depth = 0; depth < 32 && pid > 1; depth++) {
    if (pid === input.cliPid) return true;
    try {
      const raw = readFileSync(join(input.procRoot, String(pid), 'stat'), 'utf8');
      const fields = raw.slice(raw.lastIndexOf(')') + 2).trim().split(/\s+/);
      const parent = Number(fields[1]);
      const started = fields[19];
      if (!Number.isSafeInteger(parent) || !/^\d+$/.test(started ?? '')
        || input.preexistingProcessIdentities.has(`${pid}:${started}`)) return false;
      pid = parent;
    } catch {
      return false;
    }
  }
  return false;
}

export type CurrentActorDaemonResult =
  | { ok: true; document: CurrentActorDocument }
  | { ok: false; error: 'current_actor_unverified' };

/** Daemon-owned authorization and identity lookup for the current live turn. */
export async function resolveDaemonCurrentActor(input: {
  sessionId: string;
  peer: ProcessIdentity;
  findSession: (sessionId: string) => DaemonSession | undefined;
  resolveIdentity?: typeof resolveVerifiedUserIdentity;
  procRoot?: string;
}): Promise<CurrentActorDaemonResult> {
  const ds = input.findSession(input.sessionId);
  const turnId = ds?.managedTurnOrigin?.turnId;
  const generation = ds?.workerGeneration;
  const attestation = ds?.localProcessAttestation;
  const cliPid = attestation?.cliPid;
  const cliProcStart = attestation?.cliProcStart;
  const processIdentities = ds?.managedTurnOrigin?.preexistingProcessIdentities;
  const workerPid = ds?.worker?.pid;
  const workerProcStart = workerPid ? readProcStart(workerPid, input.procRoot ?? '/proc') : undefined;
  if (!ds || ds.session.status !== 'active'
    || !larkTransportEnabled({ chatId: ds.chatId, apiOnly: ds.initConfig?.apiOnly })
    || !turnId || generation === undefined
    || !workerPid || !workerProcStart || ds.worker?.killed === true
    || attestation?.workerGeneration !== generation
    || !cliPid || !cliProcStart
    || !processIdentities || processIdentities.length === 0
    || readProcStart(cliPid, input.procRoot ?? '/proc') !== cliProcStart) {
    return { ok: false, error: 'current_actor_unverified' };
  }
  const procRoot = input.procRoot ?? '/proc';
  const preexistingProcessIdentities = new Set(processIdentities);
  if (!peerBelongsToCurrentTurn({
      peer: input.peer, cliPid, procRoot,
      preexistingProcessIdentities,
    })
    || readProcStart(input.peer.pid, input.procRoot ?? '/proc') !== input.peer.procStart) {
    return { ok: false, error: 'current_actor_unverified' };
  }
  const senderOpenId = ds.managedTurnOrigin?.callerOpenId;
  const liveCapability = ds.managedTurnOrigin?.capability;
  if (!senderOpenId?.startsWith('ou_') || !liveCapability) {
    return { ok: false, error: 'current_actor_unverified' };
  }

  const frozen = {
    ds, turnId, generation, senderOpenId, capability: liveCapability,
    workerPid, workerProcStart, processIdentities: [...processIdentities],
  };
  const identity = await (input.resolveIdentity ?? resolveVerifiedUserIdentity)(ds.larkAppId, senderOpenId);
  if (!identity || identity.type !== 'user' || identity.openId !== senderOpenId) {
    return { ok: false, error: 'current_actor_unverified' };
  }
  let email: string;
  try { email = normalizeActorEmail(identity.email); }
  catch { return { ok: false, error: 'current_actor_unverified' }; }

  const current = input.findSession(input.sessionId);
  const currentSender = current?.managedTurnOrigin?.callerOpenId;
  if (current !== frozen.ds || current?.session.status !== 'active'
    || current.workerGeneration !== frozen.generation
    || current.worker?.pid !== frozen.workerPid
    || current.worker?.killed === true
    || current.localProcessAttestation?.workerGeneration !== frozen.generation
    || current.localProcessAttestation?.cliPid !== cliPid
    || current.localProcessAttestation?.cliProcStart !== cliProcStart
    || current.managedTurnOrigin?.turnId !== frozen.turnId
    || current.managedTurnOrigin?.capability !== frozen.capability
    || JSON.stringify(current.managedTurnOrigin?.preexistingProcessIdentities)
      !== JSON.stringify(frozen.processIdentities)
    || currentSender !== frozen.senderOpenId
    || readProcStart(frozen.workerPid, input.procRoot ?? '/proc') !== frozen.workerProcStart
    || readProcStart(cliPid, input.procRoot ?? '/proc') !== cliProcStart
    || readProcStart(input.peer.pid, input.procRoot ?? '/proc') !== input.peer.procStart
    || !peerBelongsToCurrentTurn({
      peer: input.peer, cliPid, procRoot,
      preexistingProcessIdentities: new Set(frozen.processIdentities),
    })) {
    return { ok: false, error: 'current_actor_unverified' };
  }

  return {
    ok: true,
    document: {
      schema: CURRENT_ACTOR_SCHEMA,
      status: 'verified',
      actor: { email },
    },
  };
}
