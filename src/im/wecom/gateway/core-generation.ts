/**
 * Which managed core belongs to which gateway generation.
 *
 * A gateway that dies without running its shutdown (SIGKILL, OOM kill) leaves
 * its dedicated core running: nothing signals the core, and it keeps the fixed
 * core port and its state directory. Every later start of the same connection
 * then fails on that port until someone kills the core by hand — under fleet
 * supervision that is an endless restart loop.
 *
 * The gateway therefore records the birth identity of each core it spawns, in a
 * per-configuration file under its bot's directory. That directory is only
 * written by the holder of the bot's instance lock, so the record always comes
 * from a gateway of this bot. The next generation (holding the same lock)
 * reclaims the recorded core only when it can prove all of:
 *   - the record belongs to this configuration (configId);
 *   - the gateway that wrote it is gone (its own birth identity is stale);
 *   - the recorded core is still that very process: birth identity sampled
 *     twice and a core-only entry on its command line, so a reused pid is never
 *     signalled;
 *   - the core's own descriptor (`<stateDir>/dashboard-daemons/<bot>.json`),
 *     when it names that pid, carries the same start identity and port.
 * Whatever it cannot prove is left alone and surfaces as a retryable error.
 *
 * The descriptor alone cannot be the proof: it says which core serves a port,
 * not which gateway started it, and two configurations may (by hand-editing)
 * share one managed core. Reclaiming on the descriptor alone would let two such
 * gateways kill each other's core in turn under supervision.
 */
import { readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteFileSync } from '../../../utils/atomic-write.js';
import { isLinuxZombie, readProcessStartIdentity } from '../../../utils/process-identity.js';
import {
  fleetProcessIdentityRuntime,
  inspectFleetProcess,
  signalAttestedFleetProcess,
  type FleetProcessAttestation,
  type FleetProcessIdentityRuntime,
} from '../../../core/fleet-process-identity.js';

interface ProcessBirth {
  pid: number;
  processStart: string;
  pidNamespace?: string;
}

export interface WecomCoreGeneration {
  version: 1;
  configId: string;
  /** The gateway that spawned the core. */
  gateway: ProcessBirth;
  core: ProcessBirth;
  coreBotId: string;
  port: number;
  stateDir: string;
  spawnedAt: number;
}

export function wecomCoreGenerationFile(botRoot: string, configId: string): string {
  return join(botRoot, `managed-core-${configId}.json`);
}

function isBirth(value: unknown): value is ProcessBirth {
  const birth = value as Partial<ProcessBirth> | undefined;
  return !!birth
    && Number.isSafeInteger(birth.pid)
    && (birth.pid as number) > 1
    && typeof birth.processStart === 'string'
    && birth.processStart.length > 0
    && (birth.pidNamespace === undefined || typeof birth.pidNamespace === 'string');
}

export function readWecomCoreGeneration(file: string): WecomCoreGeneration | undefined {
  try {
    const value = JSON.parse(readFileSync(file, 'utf8')) as Partial<WecomCoreGeneration>;
    if (value.version !== 1
      || typeof value.configId !== 'string'
      || !isBirth(value.gateway)
      || !isBirth(value.core)
      || typeof value.coreBotId !== 'string'
      || !Number.isInteger(value.port)
      || typeof value.stateDir !== 'string') {
      return undefined;
    }
    return value as WecomCoreGeneration;
  } catch {
    return undefined;
  }
}

function birthOf(pid: number, runtime: FleetProcessIdentityRuntime): ProcessBirth | undefined {
  const processStart = runtime.readIdentity(pid);
  if (!processStart) {
    return undefined;
  }
  const pidNamespace = runtime.readPidNamespace(pid);
  return { pid, processStart, ...(pidNamespace ? { pidNamespace } : {}) };
}

/**
 * Record the core this gateway just spawned. Returns false when either birth
 * identity cannot be read or the file cannot be written; the core still runs,
 * it just cannot be reclaimed automatically if this gateway is killed.
 */
export function recordWecomCoreGeneration(input: {
  file: string;
  configId: string;
  corePid: number;
  coreBotId: string;
  port: number;
  stateDir: string;
  runtime?: FleetProcessIdentityRuntime;
}): boolean {
  const runtime = input.runtime ?? fleetProcessIdentityRuntime;
  const gateway = birthOf(process.pid, runtime);
  const core = birthOf(input.corePid, runtime);
  if (!gateway || !core) {
    return false;
  }
  const record: WecomCoreGeneration = {
    version: 1,
    configId: input.configId,
    gateway,
    core,
    coreBotId: input.coreBotId,
    port: input.port,
    stateDir: input.stateDir,
    spawnedAt: Date.now(),
  };
  try {
    atomicWriteFileSync(input.file, JSON.stringify(record), { mode: 0o600, followTargetSymlink: false });
    return true;
  } catch {
    return false;
  }
}

/** Drop the record once its core has exited. Leaves a newer generation's record alone. */
export function forgetWecomCoreGeneration(file: string, corePid: number): void {
  const record = readWecomCoreGeneration(file);
  if (record && record.core.pid !== corePid) {
    return;
  }
  try {
    unlinkSync(file);
  } catch {
    /* already gone; a stale record is discarded by the next reclaim */
  }
}

/** A previous core could not be proven gone or reclaimed. Retryable by design. */
export class WecomCoreReclaimError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WecomCoreReclaimError';
  }
}

/** `node|bun <build>/index-core-only.{js,ts}` or `<binary> __core-only`. */
export function isWecomCoreCommandLine(commandLine: string): boolean {
  return /(?:^|[\s"'])__core-only(?:$|[\s"'])/.test(commandLine)
    || /(?:^|[\s"'\\/])index-core-only\.(?:js|ts)(?:$|[\s"'])/.test(commandLine);
}

interface CoreDescriptor {
  pid?: unknown;
  processStartIdentity?: unknown;
  ipcPort?: unknown;
}

function readCoreDescriptor(stateDir: string, coreBotId: string): CoreDescriptor | undefined {
  try {
    return JSON.parse(readFileSync(join(stateDir, 'dashboard-daemons', `${coreBotId}.json`), 'utf8')) as CoreDescriptor;
  } catch {
    return undefined;
  }
}

export interface ReclaimWecomCoreOptions {
  file: string;
  configId: string;
  /** SIGTERM → SIGKILL window, the core's own graceful shutdown budget. */
  graceMs: number;
  /** How long a SIGKILLed core may take to disappear before reclaim fails. */
  killWaitMs: number;
  signal?: AbortSignal;
  runtime?: FleetProcessIdentityRuntime;
  /** Start identity in the form the core descriptor stores (see daemon.ts). */
  readStartIdentity?: (pid: number) => string | undefined;
  pollMs?: number;
  log?: (line: string) => void;
}

/**
 * Stop the core a previous gateway generation of this configuration left
 * behind. Resolves `none` when there is nothing recorded, `stale` when the
 * recorded core is already gone, `reclaimed` after it has been stopped. Throws
 * WecomCoreReclaimError when the record cannot be proven safe to act on, or the
 * core outlives SIGKILL.
 */
export async function reclaimWecomCoreGeneration(
  options: ReclaimWecomCoreOptions,
): Promise<'none' | 'stale' | 'reclaimed'> {
  const runtime = options.runtime ?? fleetProcessIdentityRuntime;
  const readStartIdentity = options.readStartIdentity ?? readProcessStartIdentity;
  const log = options.log ?? (line => console.error(line));
  const record = readWecomCoreGeneration(options.file);
  if (!record || record.configId !== options.configId) {
    return 'none';
  }

  const gateway = inspectFleetProcess(
    record.gateway.pid,
    record.gateway.processStart,
    record.gateway.pidNamespace,
    () => true,
    runtime,
    false,
  );
  if (gateway.status === 'exact') {
    throw new WecomCoreReclaimError(`上一代网关（pid ${record.gateway.pid}）仍在运行，不回收它的 core`);
  }
  if (gateway.status === 'unverifiable') {
    throw new WecomCoreReclaimError(`无法核验上一代网关（pid ${record.gateway.pid}）是否已退出`);
  }

  const core = inspectFleetProcess(
    record.core.pid,
    record.core.processStart,
    record.core.pidNamespace,
    isWecomCoreCommandLine,
    runtime,
    true,
  );
  if (core.status === 'stale') {
    forgetWecomCoreGeneration(options.file, record.core.pid);
    return 'stale';
  }
  if (core.status === 'unverifiable') {
    throw new WecomCoreReclaimError(`无法核验上一代 core（pid ${record.core.pid}）的进程身份`);
  }

  const descriptor = readCoreDescriptor(record.stateDir, record.coreBotId);
  if (descriptor && descriptor.pid === record.core.pid) {
    const start = readStartIdentity(record.core.pid);
    if (!start || start !== descriptor.processStartIdentity || descriptor.ipcPort !== record.port) {
      throw new WecomCoreReclaimError(`上一代 core（pid ${record.core.pid}）与它的描述符不一致，未回收`);
    }
  }

  const attestation = core.attestation;
  log(`[wecom] 回收上一代网关遗留的 core（pid ${attestation.pid}）`);
  if (!signalAttestedFleetProcess(attestation, 'SIGTERM', runtime)) {
    forgetWecomCoreGeneration(options.file, record.core.pid);
    return 'stale';
  }
  const pollMs = options.pollMs ?? 200;
  if (!await waitGone(attestation, options.graceMs, pollMs, runtime, options.signal)) {
    log(`[wecom] 上一代 core（pid ${attestation.pid}）未在宽限期内退出，强制结束`);
    signalAttestedFleetProcess(attestation, 'SIGKILL', runtime);
    if (!await waitGone(attestation, options.killWaitMs, pollMs, runtime, options.signal)) {
      throw new WecomCoreReclaimError(`上一代 core（pid ${attestation.pid}）在强制结束后仍未退出`);
    }
  }
  forgetWecomCoreGeneration(options.file, record.core.pid);
  log(`[wecom] 上一代 core（pid ${attestation.pid}）已退出`);
  return 'reclaimed';
}

function isGone(target: FleetProcessAttestation, runtime: FleetProcessIdentityRuntime): boolean {
  if (!runtime.pidExists(target.pid)) {
    return true;
  }
  return runtime.readIdentity(target.pid) !== target.processStart || isLinuxZombie(target.pid);
}

async function waitGone(
  target: FleetProcessAttestation,
  timeoutMs: number,
  pollMs: number,
  runtime: FleetProcessIdentityRuntime,
  signal?: AbortSignal,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    if (signal?.aborted) {
      throw new Error('企微 core 启动已取消');
    }
    if (isGone(target, runtime)) {
      return true;
    }
    if (Date.now() >= deadline) {
      return false;
    }
    await new Promise(done => setTimeout(done, Math.min(pollMs, Math.max(1, deadline - Date.now()))));
  }
}
