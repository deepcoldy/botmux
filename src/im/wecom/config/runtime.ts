import { createHash, randomUUID } from 'node:crypto';
import { isAbsolute, join } from 'node:path';
import { mkdirSync, readFileSync, unlinkSync } from 'node:fs';
import { atomicWriteFileSync } from '../../../utils/atomic-write.js';
import { fleetProcessIdentityRuntime, inspectFleetProcess, type FleetProcessIdentityRuntime } from '../../../core/fleet-process-identity.js';
import { wecomStateWriteErrorCode, type WecomStateWriteFailure } from '../contract/state-write-failure.js';
import type { WecomAdmissionEvent } from '../contract/dashboard-dto.js';
import type { WecomDiagnosticsDto } from '../contract/dashboard-dto.js';
import type { WecomInboundEvent } from '../protocol/types.js';
import { wecomConfigId, wecomRoot } from './discovery.js';

export type WecomConnectionState = 'unknown' | 'connecting' | 'connected' | 'reconnecting' | 'disconnected';

export interface WecomRuntimeRecord {
  version: 1;
  configId: string;
  pid: number;
  processStart: string;
  pidNamespace?: string;
  instanceId: string;
  control?: { port: number; instanceId: string };
  diagnostics?: WecomDiagnosticsDto;
  connection: WecomConnectionState;
  phase: 'starting' | 'running' | 'stopping' | 'stopped';
  updatedAt: number;
  /** The botmux version the writing gateway runs. Absent from records written before it was added. */
  botmuxVersion?: string;
  /**
   * The configuration file the gateway evaluated last (wecomFleetConfigHash of
   * its text) and what became of it: every change applied, a change only a
   * restart applies (config/restart-settings.ts), or handing the core settings
   * to the core failed and is retried. Written only by a gateway that manages
   * its core, and absent from records of earlier versions.
   */
  coreProfile?: WecomCoreProfileEvaluation;
  /**
   * The gateway's first failed write of its state document (state.json): from
   * then on it processes no message and does not recover by itself, while it
   * stays connected. Read through wecomStateWriteFailure. Absent from records
   * of earlier versions.
   */
  stateWriteFailure?: WecomStateWriteFailure;
}

/** The longest state directory a record may name for the Dashboard. */
const STATE_DIRECTORY_MAX_LENGTH = 1024;

/**
 * A record's `stateWriteFailure`, when it has a usable one, copied field by
 * field: a finite non-negative time and an absolute directory of bounded length
 * with no control character, or nothing; a malformed error code alone is
 * dropped.
 */
export function wecomStateWriteFailure(record: Pick<WecomRuntimeRecord, 'stateWriteFailure'>): WecomStateWriteFailure | undefined {
  const value = record.stateWriteFailure as { code?: unknown; at?: unknown; directory?: unknown } | undefined;
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const { at, directory } = value;
  if (typeof at !== 'number' || !Number.isFinite(at) || at < 0) {
    return undefined;
  }
  if (typeof directory !== 'string'
    || directory.length > STATE_DIRECTORY_MAX_LENGTH
    || !isAbsolute(directory)
    || /\p{Cc}/u.test(directory)) {
    return undefined;
  }
  const code = wecomStateWriteErrorCode(value.code);
  return { ...(code ? { code } : {}), at, directory };
}

export type WecomCoreProfileOutcome = 'applied' | 'restart_required' | 'retrying';

export interface WecomCoreProfileEvaluation {
  configHash: string;
  outcome: WecomCoreProfileOutcome;
}

/** A record's `coreProfile`, when it has a usable one. */
export function wecomCoreProfileEvaluation(record: Pick<WecomRuntimeRecord, 'coreProfile'>): WecomCoreProfileEvaluation | undefined {
  const value = record.coreProfile as Partial<WecomCoreProfileEvaluation> | undefined;
  return value
    && typeof value.configHash === 'string'
    && /^[a-f0-9]{64}$/.test(value.configHash)
    && ['applied', 'restart_required', 'retrying'].includes(value.outcome as string)
    ? { configHash: value.configHash, outcome: value.outcome as WecomCoreProfileOutcome }
    : undefined;
}

/** How often a running gateway rewrites its record, even with nothing new in it. */
export const WECOM_RUNTIME_REFRESH_MS = 3000;

/** A record not rewritten for this long no longer shows its gateway is alive:
 *  that gateway has missed several refreshes. */
export const WECOM_RUNTIME_EVIDENCE_MS = 10_000;

/** Whether `record` was rewritten recently enough to describe a live gateway. */
export function isFreshWecomRuntime(record: Pick<WecomRuntimeRecord, 'updatedAt'>, now: number): boolean {
  const age = now - record.updatedAt;
  return age >= 0 && age < WECOM_RUNTIME_EVIDENCE_MS;
}

export function wecomBotRoot(botId: string, root = wecomRoot()): string {
  return join(root, createHash('sha256').update(botId).digest('hex'));
}

export function readWecomRuntime(botId: string, root = wecomRoot()): WecomRuntimeRecord | undefined {
  try {
    const value = JSON.parse(readFileSync(join(wecomBotRoot(botId, root), 'runtime.json'), 'utf8'));
    if (value.version !== 1 || !Number.isSafeInteger(value.pid) || typeof value.processStart !== 'string'
      || !['unknown', 'connecting', 'connected', 'reconnecting', 'disconnected'].includes(value.connection)
      || !['starting', 'running', 'stopping', 'stopped'].includes(value.phase)
      || typeof value.updatedAt !== 'number'
      || typeof value.configId !== 'string') {
      return undefined;
    }
    return value;
  } catch {
    return undefined;
  }
}

export function inspectWecomProcess(
  record: { pid: number; processStart: string; pidNamespace?: string },
  runtime: FleetProcessIdentityRuntime = fleetProcessIdentityRuntime,
) {
  return inspectFleetProcess(record.pid, record.processStart, record.pidNamespace, () => false, runtime, false);
}

/**
 * Written only by the process that holds the bot's existing single-active lock.
 * `botmuxVersion`: the version that process runs, recorded for `botmux status`.
 */
export function createWecomRuntimePublisher(
  botId: string,
  configFile: string,
  options: { botmuxVersion?: string } = {},
) {
  const root = wecomBotRoot(botId);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const processStart = fleetProcessIdentityRuntime.readIdentity(process.pid);
  if (!processStart) {
    return {
      instanceId: '',
      inbound(_event: WecomInboundEvent) {},
      admission(_event: WecomAdmissionEvent) {},
      update(_update: Partial<Pick<WecomRuntimeRecord, 'connection' | 'phase' | 'control' | 'coreProfile'>>) {},
      stateWriteFailure(_failure: WecomStateWriteFailure) {},
      stop() {},
    };
  }
  const pidNamespace = fleetProcessIdentityRuntime.readPidNamespace(process.pid);
  const diagnostics: WecomDiagnosticsDto = {
    callbacks: 0,
    normalized: 0,
    invalid: 0,
    beforeAuth: 0,
    accepted: 0,
    denied: 0,
    duplicates: 0,
    busy: 0,
    commands: 0,
    unsupported: 0,
  };
  const record: WecomRuntimeRecord = {
    version: 1,
    diagnostics,
    instanceId: randomUUID(),
    configId: wecomConfigId(configFile),
    pid: process.pid,
    processStart,
    ...(pidNamespace ? { pidNamespace } : {}),
    connection: 'unknown',
    phase: 'starting',
    updatedAt: Date.now(),
    ...(options.botmuxVersion ? { botmuxVersion: options.botmuxVersion } : {}),
  };
  const write = () => {
    record.updatedAt = Date.now();
    try {
      atomicWriteFileSync(join(root, 'runtime.json'), JSON.stringify(record), { mode: 0o600, followTargetSymlink: false });
    } catch (error) {
      // This publisher holds the bot lock: invalidate its previous proof on write failure.
      try {
        unlinkSync(join(root, 'runtime.json'));
      } catch {
        /* expiry remains a second bound */
      }
      throw error;
    }
  };
  write();
  const interval = setInterval(() => {
    try {
      write();
    } catch {
      /* stale proof renders unknown; never claim a fresh connection */
    }
  }, WECOM_RUNTIME_REFRESH_MS);
  interval.unref();
  const safeWrite = () => {
    try {
      write();
    } catch {
      /* observations cannot alter dispatch */
    }
  };
  return {
    instanceId: record.instanceId,
    inbound(event: WecomInboundEvent) {
      if (event === 'callback_received') {
        diagnostics.callbacks++;
        diagnostics.lastCallbackAt = Date.now();
      } else if (event === 'normalized') {
        diagnostics.normalized++;
      } else if (event === 'invalid_message') {
        diagnostics.invalid++;
      } else if (event === 'callback_before_auth') {
        diagnostics.beforeAuth++;
      }
      safeWrite();
    },
    admission(event: WecomAdmissionEvent) {
      const counts = {
        accepted: 'accepted',
        denied: 'denied',
        duplicate: 'duplicates',
        busy: 'busy',
        command: 'commands',
        unsupported: 'unsupported',
      } as const;
      if (event.outcome !== 'halted') {
        diagnostics[counts[event.outcome]]++;
      }
      diagnostics.lastAdmission = event.outcome;
      diagnostics.lastAdmissionAt = Date.now();
      safeWrite();
    },
    update(update: Partial<Pick<WecomRuntimeRecord, 'connection' | 'phase' | 'control' | 'coreProfile'>>) {
      Object.assign(record, update);
      write();
    },
    /**
     * Record the gateway's failed state write. Never throws: by default this
     * record sits next to state.json, so the disk that refused that write
     * usually refuses this one too. The failure stays in the record and every
     * periodic rewrite retries it, so it shows once the disk takes writes again.
     */
    stateWriteFailure(failure: WecomStateWriteFailure) {
      record.stateWriteFailure = {
        ...(failure.code ? { code: failure.code } : {}),
        at: failure.at,
        directory: failure.directory,
      };
      safeWrite();
    },
    stop() {
      clearInterval(interval);
      record.phase = 'stopped';
      record.connection = 'disconnected';
      try {
        write();
      } catch {
        /* process identity still prevents stale liveness */
      }
    },
  };
}
