import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, readlinkSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

import { CURRENT_ACTOR_SCHEMA, normalizeActorEmail, type CurrentActorDocument } from '../cli/current-actor.js';
import { resolveVerifiedUserIdentity } from '../im/lark/identity-cache.js';
import { collectSessionLineagePids } from './preview-port-owner.js';
import { larkTransportEnabled, type DaemonSession } from './types.js';
import { parseScheduledTurnId } from './scheduled-turn-provenance.js';
import {
  PROC_STAT_STARTTIME_INDEX,
  procStatFieldsAfterComm,
  procStatStartTimeDigits,
} from '../utils/proc-stat.js';
import { isLoopbackPeer } from '../utils/loopback-peers.js';
import { logger } from '../utils/logger.js';

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
    return procStatStartTimeDigits(readFileSync(join(procRoot, String(pid), 'stat'), 'utf8'));
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

/**
 * Socket-holder scan over the whole host, time-sliced and shared.
 *
 * Mapping a socket inode to its process means reading every process's fd
 * table: on a busy multi-user host that is ~2k processes and ~100k fds, a few
 * hundred milliseconds of synchronous syscalls (much more on slower hosts).
 * Done in one go it froze the daemon's event loop for that long on every
 * execution-identity request, so health checks, card updates and outbound
 * requests (the platform credential grant among them) all stalled behind it.
 *
 * The scan still has to cover the whole host: the peer must be the ONLY holder
 * of the socket (an fd passed to or inherited by another process makes the
 * caller ambiguous), and a registered background job may sit outside every
 * session's process tree. So instead of narrowing it, the scan
 *  - yields to the event loop every {@link PEER_SCAN_SLICE_MS} of work;
 *  - serves every request queued when a pass starts from that one pass
 *    (a later request waits for the next pass, which re-reads every table);
 *  - fails closed past {@link PEER_SCAN_BUDGET_MS}.
 */
export const PEER_SCAN_SLICE_MS = 4;
export const PEER_SCAN_BUDGET_MS = 5_000;

interface PeerScanJob {
  needle: string;
  /** Start time read at the moment the fd was seen (undefined: unreadable). */
  holders: Array<{ pid: number; procStart: string | undefined }>;
  resolve: (holders: PeerScanJob['holders'] | undefined) => void;
}

interface PeerScanQueue { jobs: PeerScanJob[]; running: boolean }
const peerScanQueues = new Map<string, PeerScanQueue>();

/** @internal test seam: slice/budget overrides (production uses the defaults). */
export interface PeerScanTuning { sliceMs?: number; budgetMs?: number; onYield?: () => void }

const yieldToEventLoop = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

type PeerScanOutcome = 'completed' | 'budget_exceeded' | 'scan_failed';

async function runPeerScanPass(procRoot: string, jobs: PeerScanJob[], tuning: PeerScanTuning): Promise<PeerScanOutcome> {
  const sliceMs = tuning.sliceMs ?? PEER_SCAN_SLICE_MS;
  const budgetMs = tuning.budgetMs ?? PEER_SCAN_BUDGET_MS;
  let entries: string[];
  try { entries = readdirSync(procRoot); } catch { return 'scan_failed'; }
  const byNeedle = new Map<string, PeerScanJob[]>();
  for (const job of jobs) {
    const list = byNeedle.get(job.needle);
    if (list) list.push(job); else byNeedle.set(job.needle, [job]);
  }
  const started = Date.now();
  let sliceStart = started;
  let sinceCheck = 0;
  /** Yield once the current slice is used up; false when the budget is gone.
   *  Checked per fd as well as per process: one process can hold tens of
   *  thousands of fds (seen: 73k), a few hundred ms on its own. */
  const keepGoing = async (): Promise<boolean> => {
    if (++sinceCheck < 64 && sliceMs > 0) return true;
    sinceCheck = 0;
    if (Date.now() - sliceStart < sliceMs) return true;
    tuning.onYield?.();
    await yieldToEventLoop();
    if (Date.now() - started > budgetMs) return false;
    sliceStart = Date.now();
    return true;
  };
  for (const entry of entries) {
    if (!await keepGoing()) return 'budget_exceeded';
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    // One listing per process is a single syscall batch (~50ms for the 73k-fd
    // outlier above); Bun's Dir.readSync buffers the whole listing too, so a
    // streamed read would not split it further.
    let fds: string[];
    try { fds = readdirSync(join(procRoot, entry, 'fd')); } catch { continue; }
    let matched: Set<string> | undefined;
    for (const fd of fds) {
      if (!await keepGoing()) return 'budget_exceeded';
      let link: string;
      try { link = readlinkSync(join(procRoot, entry, 'fd', fd)); } catch { continue; /* raced away */ }
      if (!byNeedle.has(link) || matched?.has(link)) continue;
      (matched ??= new Set()).add(link);
      // Pin the identity now: the scan spans many event-loop turns, and a pid
      // read only at the end could already belong to a different process.
      const procStart = readProcStart(pid, procRoot);
      for (const job of byNeedle.get(link)!) job.holders.push({ pid, procStart });
    }
  }
  return 'completed';
}

function scanSocketHolders(procRoot: string, inode: string, tuning: PeerScanTuning): Promise<PeerScanJob['holders'] | undefined> {
  let queue = peerScanQueues.get(procRoot);
  if (!queue) { queue = { jobs: [], running: false }; peerScanQueues.set(procRoot, queue); }
  const q = queue;
  const done = new Promise<PeerScanJob['holders'] | undefined>(resolve => {
    q.jobs.push({ needle: `socket:[${inode}]`, holders: [], resolve });
  });
  if (!q.running) {
    q.running = true;
    void (async () => {
      try {
        // A pass runs with the tuning of whichever request started it; requests
        // coalesced into that pass share it. Production callers never pass
        // scanTuning, so it only differs via the internal test seam.
        while (q.jobs.length > 0) {
          const jobs = q.jobs.splice(0);
          let outcome: PeerScanOutcome = 'scan_failed';
          try { outcome = await runPeerScanPass(procRoot, jobs, tuning); } catch { outcome = 'scan_failed'; }
          // One log line per batch, with a distinct reason: a procfs read error
          // is not a timeout, and N coalesced jobs must not log N identical lines.
          if (outcome !== 'completed') {
            const budget = tuning.budgetMs ?? PEER_SCAN_BUDGET_MS;
            logger.warn(outcome === 'budget_exceeded'
              ? `[current-actor] socket owner scan exceeded ${budget}ms; refusing ${jobs.length} request(s)`
              : `[current-actor] socket owner scan failed while reading procfs; refusing ${jobs.length} request(s)`);
          }
          for (const job of jobs) job.resolve(outcome === 'completed' ? job.holders : undefined);
        }
      } finally {
        q.running = false;
        if (q.jobs.length === 0) peerScanQueues.delete(procRoot);
      }
    })();
  }
  return done;
}

/** Resolve the process that owns the client half of one live loopback TCP request. */
export async function resolveLoopbackPeerProcesses(input: {
  remoteAddress?: string;
  remotePort?: number;
  localPort?: number;
  procRoot?: string;
  /** @internal test seam */
  scanTuning?: PeerScanTuning;
}): Promise<LoopbackPeerResolution> {
  const procRoot = input.procRoot ?? '/proc';
  // First ring: the peer address must be local (default loopback set, plus
  // BOTMUX_LOOPBACK_PEERS for hosts whose kernel reports a same-machine peer
  // as a LAN IP). This is NOT the trust boundary by itself: a remote peer can
  // never produce a client-side row in THIS host's /proc/net/tcp, so the
  // socket-inode → fd → process lineage resolution below still pins the peer
  // to a local process. Relaxing the address ring only stops a local peer with
  // a non-standard reported address from failing before that resolution.
  if (!isLoopbackPeer(input.remoteAddress)) return { ok: false, reason: 'not_loopback' };
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
  const holders = await scanSocketHolders(procRoot, inode, input.scanTuning ?? {});
  if (!holders) return { ok: false, reason: 'peer_unresolved' };
  // Exactly one holder, whose start time can be read: anything else is ambiguous.
  const [holder] = holders;
  if (holders.length !== 1 || !holder?.procStart) return { ok: false, reason: 'peer_unresolved' };
  return { ok: true, peer: { pid: holder.pid, procStart: holder.procStart } };
}

/** Codex keeps its native tool dispatcher alive across turns. It is part of
 * the attested engine, not an old user command. Never recognize it from argv
 * alone: require a direct attested Codex parent and the release sibling exe. */
function isNativeCodexToolHost(
  pid: number, parent: number, procRoot: string, trustedRootPids: ReadonlySet<number>,
): boolean {
  if (!trustedRootPids.has(parent)) return false;
  try {
    const parentExe = readlinkSync(join(procRoot, String(parent), 'exe'));
    const hostExe = readlinkSync(join(procRoot, String(pid), 'exe'));
    const cmdline = readFileSync(join(procRoot, String(pid), 'cmdline'), 'utf8');
    const argv = cmdline.endsWith('\0') ? cmdline.slice(0, -1).split('\0') : [];
    return basename(parentExe) === 'codex'
      && hostExe === join(dirname(parentExe), 'codex-code-mode-host')
      && argv.length === 1 && argv[0].length > 0;
  } catch {
    return false;
  }
}

function peerBelongsToCurrentTurn(input: {
  peer: ProcessIdentity;
  trustedRootPids: ReadonlySet<number>;
  procRoot: string;
  preexistingProcessIdentities: ReadonlySet<string>;
}): boolean {
  if (input.procRoot === '/proc' && process.platform !== 'linux') return false;
  let pid = input.peer.pid;
  for (let depth = 0; depth < 32 && pid > 1; depth++) {
    if (input.trustedRootPids.has(pid)) return true;
    try {
      const fields = procStatFieldsAfterComm(readFileSync(join(input.procRoot, String(pid), 'stat'), 'utf8'));
      if (!fields) return false;
      const parent = Number(fields[1]);
      const started = fields[PROC_STAT_STARTTIME_INDEX];
      if (!Number.isSafeInteger(parent) || !/^\d+$/.test(started ?? '')) return false;
      if (input.preexistingProcessIdentities.has(`${pid}:${started}`)) {
        // Only traverse the native dispatcher as an ancestor of a new tool.
        // It cannot itself claim this turn, nor can old tool descendants.
        if (pid === input.peer.pid
          || !isNativeCodexToolHost(pid, parent, input.procRoot, input.trustedRootPids)
          || readProcStart(pid, input.procRoot) !== started) return false;
      }
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

export interface CurrentTurnPeerAttestation {
  ds: DaemonSession;
  turnId: string;
  generation: number;
  dispatchAttempt?: number;
  callerOpenId: string;
  capability: string;
  cliPid?: number;
  cliProcStart?: string;
  enginePid?: number;
  engineProcStart?: string;
  workerPid: number;
  workerProcStart: string;
  expectedScheduledTurnId?: string;
  processIdentities: string[];
}

export type CurrentExecutionPeerAttestation = Omit<CurrentTurnPeerAttestation, 'callerOpenId'> & {
  callerOpenId?: string;
};

export interface CurrentTurnPeerAttestationInput {
  sessionId: string;
  peer: ProcessIdentity;
  findSession: (sessionId: string) => DaemonSession | undefined;
  procRoot?: string;
  expectedScheduledTurnId?: string;
}

/**
 * Prove that one resolved loopback peer belongs to the exact live turn of a
 * session, reading the caller/turn tuple straight from in-memory daemon state.
 * Shared by `/api/current-actor` and the agent authorization routes so the
 * host-session lineage proof (no rotating capability, no channel env) has a
 * single source of truth.
 */
export function attestCurrentExecutionLoopbackPeer(
  input: CurrentTurnPeerAttestationInput,
): CurrentExecutionPeerAttestation | null {
  const procRoot = input.procRoot ?? '/proc';
  const ds = input.findSession(input.sessionId);
  const turnId = ds?.managedTurnOrigin?.turnId;
  const generation = ds?.workerGeneration;
  const dispatchAttempt = ds?.managedTurnOrigin?.dispatchAttempt;
  const attestation = ds?.localProcessAttestation;
  const cliPid = attestation?.cliPid;
  const cliProcStart = attestation?.cliProcStart;
  const enginePid = attestation?.enginePid;
  const engineProcStart = attestation?.engineProcStart;
  const processIdentities = ds?.managedTurnOrigin?.preexistingProcessIdentities;
  const workerPid = ds?.worker?.pid;
  const workerProcStart = workerPid ? readProcStart(workerPid, procRoot) : undefined;
  const callerOpenId = ds?.managedTurnOrigin?.callerOpenId;
  const capability = ds?.managedTurnOrigin?.capability;
  const scheduledCaller = input.expectedScheduledTurnId
    ? ds?.scheduledTurnCallers?.get(input.expectedScheduledTurnId)
    : undefined;
  if (!ds || ds.session.status !== 'active'
    || !larkTransportEnabled({ chatId: ds.chatId, apiOnly: ds.initConfig?.apiOnly })
    || !turnId || generation === undefined
    || !workerPid || !workerProcStart || ds.worker?.killed === true
    || attestation?.workerGeneration !== generation
    || ((cliPid === undefined) !== (cliProcStart === undefined))
    || ((enginePid === undefined) !== (engineProcStart === undefined))
    || (cliPid === undefined && enginePid === undefined)
    || !processIdentities || processIdentities.length === 0
    || !capability
    || (dispatchAttempt !== undefined && (!Number.isSafeInteger(dispatchAttempt) || dispatchAttempt <= 0))
    || (cliPid !== undefined
      && readProcStart(cliPid, procRoot) !== cliProcStart)
    || (enginePid !== undefined
      && readProcStart(enginePid, procRoot) !== engineProcStart)) {
    return null;
  }
  if (input.expectedScheduledTurnId
    && (!parseScheduledTurnId(input.expectedScheduledTurnId)
      || turnId !== input.expectedScheduledTurnId
      || !scheduledCaller
      || scheduledCaller.requestUserOpenId !== callerOpenId)) {
    return null;
  }
  const preexistingProcessIdentities = new Set(processIdentities);
  // The worker reports both roots over its private IPC channel. Binding each
  // PID to its proc start time prevents PID reuse, while the descendant walk
  // keeps a tool process inside this exact live turn instead of trusting uid.
  // RPC tools can start before the viewer CLI exists, so the engine is an
  // independent root rather than a fallback identity claim.
  const trustedRootPids = new Set([
    ...(cliPid !== undefined ? [cliPid] : []),
    ...(enginePid !== undefined ? [enginePid] : []),
  ]);
  if (!peerBelongsToCurrentTurn({
      peer: input.peer, trustedRootPids, procRoot,
      preexistingProcessIdentities,
    })
    || readProcStart(input.peer.pid, procRoot) !== input.peer.procStart) {
    return null;
  }
  return {
    ds, turnId, generation, callerOpenId, capability,
    ...(dispatchAttempt !== undefined ? { dispatchAttempt } : {}),
    workerPid, workerProcStart, cliPid, cliProcStart, enginePid, engineProcStart,
    ...(input.expectedScheduledTurnId
      ? { expectedScheduledTurnId: input.expectedScheduledTurnId }
      : {}),
    processIdentities: [...processIdentities],
  };
}

/** Human identity remains a separate requirement for actor callers.
 * Machine-triggered executions can prove their lineage without it. */
export function attestCurrentTurnLoopbackPeer(
  input: CurrentTurnPeerAttestationInput,
): CurrentTurnPeerAttestation | null {
  const proof = attestCurrentExecutionLoopbackPeer(input);
  if (!proof || typeof proof.callerOpenId !== 'string' || !proof.callerOpenId.startsWith('ou_')) return null;
  return { ...proof, callerOpenId: proof.callerOpenId };
}

/** Re-run the peer attestation and confirm the live turn is byte-for-byte the
 *  one an earlier attestation froze, so an await in between cannot smuggle in a
 *  rotated turn, replaced worker, or changed sender. */
export function currentTurnPeerAttestationStable(
  frozen: CurrentExecutionPeerAttestation,
  input: CurrentTurnPeerAttestationInput,
): boolean {
  const again = attestCurrentExecutionLoopbackPeer(input);
  return !!again
    && again.ds === frozen.ds && again.turnId === frozen.turnId
    && again.generation === frozen.generation && again.callerOpenId === frozen.callerOpenId
    && again.dispatchAttempt === frozen.dispatchAttempt
    && again.capability === frozen.capability && again.cliPid === frozen.cliPid
    && again.cliProcStart === frozen.cliProcStart && again.workerPid === frozen.workerPid
    && again.workerProcStart === frozen.workerProcStart
    && again.enginePid === frozen.enginePid
    && again.engineProcStart === frozen.engineProcStart
    && again.expectedScheduledTurnId === frozen.expectedScheduledTurnId
    && JSON.stringify(again.processIdentities) === JSON.stringify(frozen.processIdentities);
}

/** Daemon-owned authorization and identity lookup for the current live turn. */
export async function resolveDaemonCurrentActor(input: {
  sessionId: string;
  peer: ProcessIdentity;
  findSession: (sessionId: string) => DaemonSession | undefined;
  resolveIdentity?: typeof resolveVerifiedUserIdentity;
  procRoot?: string;
  expectedScheduledTurnId?: string;
}): Promise<CurrentActorDaemonResult> {
  const procRoot = input.procRoot ?? '/proc';
  const attestInput = {
    sessionId: input.sessionId, peer: input.peer,
    findSession: input.findSession, procRoot,
    ...(input.expectedScheduledTurnId
      ? { expectedScheduledTurnId: input.expectedScheduledTurnId }
      : {}),
  };
  const frozen = attestCurrentTurnLoopbackPeer(attestInput);
  if (!frozen) return { ok: false, error: 'current_actor_unverified' };

  const identity = await (input.resolveIdentity ?? resolveVerifiedUserIdentity)(frozen.ds.larkAppId, frozen.callerOpenId);
  if (!identity || identity.type !== 'user' || identity.openId !== frozen.callerOpenId) {
    return { ok: false, error: 'current_actor_unverified' };
  }
  let email: string;
  try { email = normalizeActorEmail(identity.email); }
  catch { return { ok: false, error: 'current_actor_unverified' }; }

  if (!currentTurnPeerAttestationStable(frozen, attestInput)) {
    return { ok: false, error: 'current_actor_unverified' };
  }

  return {
    ok: true,
    document: {
      schema: CURRENT_ACTOR_SCHEMA,
      status: 'verified',
      actor: { email },
      // Both values are already in scope here and are the daemon's own state,
      // not anything the caller supplied: `ds.chatId` was read a few lines
      // above by the transport check, and `frozen.turnId` is the turn the
      // attestation just re-verified as byte-identical. Publishing them lets a
      // consumer record WHICH conversation and WHICH turn a human act came
      // from — without them, "this actor is verified" is true of every turn and
      // a consumer has no attested way to bind one act to one effect.
      chatId: frozen.ds.chatId,
      turnId: frozen.turnId,
    },
  };
}
