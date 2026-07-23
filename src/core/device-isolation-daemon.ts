/**
 * Daemon half of the one-way device-credential isolation transaction.
 *
 * The host coordinator writes the marker, but only the daemon can prove that
 * every CLI it owns has stopped.  A short spawn freeze closes the inventory
 * race; private worker IPC supplies process identities that the CLI cannot
 * forge; backend-native teardown handles detached multiplexer sessions.
 */
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import type { BackendType, SessionProbe } from '../adapters/backend/types.js';
import { deviceCredentialIsolationMarkerPath } from '../adapters/cli/read-isolation.js';
import { config } from '../config.js';
import { readSecureHostFileSync } from '../platform/secure-host-file.js';
import { logger } from '../utils/logger.js';
import {
  acquireDeviceIsolationFreeze,
  bindDeviceIsolationFreezeInventoryGeneration,
  DEVICE_ISOLATION_ACTIVATION_VERSION,
  releaseDeviceIsolationFreeze,
  requireDeviceIsolationFreeze,
  type DeviceIsolationFreezeLease,
} from './device-isolation-activation.js';
import {
  killPersistentSession,
  persistentSessionName,
  probePersistentSession,
} from './persistent-backend.js';
import { readProcessStartIdentity } from './session-marker.js';
import type { DaemonSession } from './types.js';
import { killWorker, listActiveSessions } from './worker-pool.js';

export const DEVICE_ISOLATION_PREPARE_PATH = '/api/device-isolation/activation/prepare';
export const DEVICE_ISOLATION_COMMIT_PATH = '/api/device-isolation/activation/commit';
export const DEVICE_ISOLATION_RELEASE_PATH = '/api/device-isolation/activation/release';

type LocalPersistentBackend = 'tmux' | 'herdr' | 'zellij';
type InventoryBackend = BackendType | 'unknown';
type ProcessIdentity = { pid: number; procStart: string };

export type DeviceIsolationBlocker =
  | 'adopted_session'
  | 'unknown_backend'
  | 'unattested_worker'
  | 'stale_attestation'
  | 'process_identity_unavailable'
  | 'backend_probe_unknown'
  | 'backend_inconsistent';

export interface DeviceIsolationRuntimeSession {
  sessionId: string;
  adopted: boolean;
  /** Backend stamped by daemon-owned state, if this session predates no stamp. */
  frozenBackend?: BackendType;
  workerPresent: boolean;
  workerGeneration?: number;
  worker?: ProcessIdentity;
  attestation?: {
    backendType: BackendType;
    credentialIsolated: boolean;
    cli?: ProcessIdentity;
    workerGeneration?: number;
  };
  /** Opaque production handle. It is deliberately excluded from generation. */
  source?: DaemonSession;
}

export interface DeviceIsolationInventoryEntry {
  sessionId: string;
  backendType: InventoryBackend;
  disposition: 'blocked' | 'owned_local' | 'safe_remote' | 'quiescent';
  credentialIsolated?: boolean;
  worker?: ProcessIdentity;
  cli?: ProcessIdentity;
  workerGeneration?: number;
  persistent?: {
    backendType: LocalPersistentBackend;
    name: string;
    probe: SessionProbe;
  };
  blocker?: DeviceIsolationBlocker;
}

export interface DeviceIsolationInventory {
  generation: string;
  entries: DeviceIsolationInventoryEntry[];
  blockers: Array<{ sessionId: string; blocker: DeviceIsolationBlocker }>;
}

export interface DeviceIsolationDaemonIdentity {
  larkAppId: string;
  bootInstanceId: string;
}

export interface DeviceIsolationDaemonDependencies {
  now: () => number;
  listSessions: () => DeviceIsolationRuntimeSession[];
  processStart: (pid: number) => string | undefined;
  processExists: (pid: number) => boolean;
  signalProcess: (pid: number, signal: NodeJS.Signals) => void;
  probePersistent: (backendType: LocalPersistentBackend, name: string) => SessionProbe;
  killPersistent: (backendType: LocalPersistentBackend, name: string) => void;
  closeWorker: (session: DeviceIsolationRuntimeSession) => void;
  readMarker: () => string | null;
  sleep: (ms: number) => Promise<void>;
  dataDir: () => string;
}

export type DeviceIsolationDaemonResult = {
  status: 200 | 409 | 423 | 503;
  body: Record<string, unknown>;
};

interface ActivationTransaction {
  lease: DeviceIsolationFreezeLease;
  inventory: DeviceIsolationInventory;
  phase: 'prepared' | 'committed';
  pendingMarkerSha256?: string;
}

let daemonIdentity: DeviceIsolationDaemonIdentity | null = null;
let transaction: ActivationTransaction | null = null;

function isPersistentBackend(value: InventoryBackend): value is LocalPersistentBackend {
  return value === 'tmux' || value === 'herdr' || value === 'zellij';
}

function isLocalBackend(value: InventoryBackend): value is Exclude<BackendType, 'riff'> {
  return value === 'pty' || isPersistentBackend(value);
}

function safeProcessExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

function defaultRuntimeSessions(): DeviceIsolationRuntimeSession[] {
  return listActiveSessions().map((ds) => {
    const workerPresent = !!ds.worker && !ds.worker.killed;
    const workerPid = workerPresent ? ds.worker?.pid : undefined;
    const workerStart = workerPid ? readProcessStartIdentity(workerPid) : undefined;
    const attestation = ds.localProcessAttestation;
    const cli = attestation?.cliPid && attestation.cliProcStart
      ? { pid: attestation.cliPid, procStart: attestation.cliProcStart }
      : undefined;
    return {
      sessionId: ds.session.sessionId,
      adopted: !!(ds.adoptedFrom || ds.initConfig?.adoptMode || ds.session.adoptedFrom),
      frozenBackend: ds.initConfig?.backendType ?? ds.session.backendType,
      workerPresent,
      ...(ds.workerGeneration !== undefined ? { workerGeneration: ds.workerGeneration } : {}),
      ...(workerPid && workerStart ? { worker: { pid: workerPid, procStart: workerStart } } : {}),
      ...(attestation ? {
        attestation: {
          backendType: attestation.backendType,
          credentialIsolated: attestation.credentialIsolated,
          ...(cli ? { cli } : {}),
          ...(attestation.workerGeneration !== undefined
            ? { workerGeneration: attestation.workerGeneration }
            : {}),
        },
      } : {}),
      source: ds,
    };
  });
}

const defaultDependencies: DeviceIsolationDaemonDependencies = {
  now: () => Date.now(),
  listSessions: defaultRuntimeSessions,
  processStart: readProcessStartIdentity,
  processExists: safeProcessExists,
  signalProcess: (pid, signal) => { process.kill(pid, signal); },
  probePersistent: probePersistentSession,
  killPersistent: killPersistentSession,
  closeWorker: (session) => {
    if (!session.source) throw new Error('missing daemon session handle');
    killWorker(session.source);
  },
  readMarker: () => readSecureHostFileSync(
    deviceCredentialIsolationMarkerPath(homedir()),
    4 * 1024,
  ),
  sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
  dataDir: () => config.session.dataDir,
};

let dependencies: DeviceIsolationDaemonDependencies = defaultDependencies;

function resolvedBackend(session: DeviceIsolationRuntimeSession): InventoryBackend {
  return session.frozenBackend ?? session.attestation?.backendType ?? 'unknown';
}

function blockerEntry(
  session: DeviceIsolationRuntimeSession,
  backendType: InventoryBackend,
  blocker: DeviceIsolationBlocker,
): DeviceIsolationInventoryEntry {
  return {
    sessionId: session.sessionId,
    backendType,
    disposition: 'blocked',
    ...(session.worker ? { worker: session.worker } : {}),
    ...(session.attestation?.cli ? { cli: session.attestation.cli } : {}),
    ...(session.workerGeneration !== undefined
      ? { workerGeneration: session.workerGeneration }
      : {}),
    blocker,
  };
}

function classifySession(session: DeviceIsolationRuntimeSession): DeviceIsolationInventoryEntry {
  const backendType = resolvedBackend(session);
  if (session.adopted) return blockerEntry(session, backendType, 'adopted_session');
  if (backendType === 'unknown') return blockerEntry(session, backendType, 'unknown_backend');
  if (
    session.frozenBackend
    && session.attestation
    && session.frozenBackend !== session.attestation.backendType
  ) {
    return blockerEntry(session, backendType, 'backend_inconsistent');
  }
  if (backendType === 'riff') {
    return {
      sessionId: session.sessionId,
      backendType,
      disposition: 'safe_remote',
      ...(session.workerGeneration !== undefined
        ? { workerGeneration: session.workerGeneration }
        : {}),
    };
  }

  const persistent = isPersistentBackend(backendType)
    ? {
      backendType,
      name: persistentSessionName(backendType, session.sessionId),
      probe: dependencies.probePersistent(backendType, persistentSessionName(backendType, session.sessionId)),
    }
    : undefined;

  if (!session.workerPresent) {
    if (!persistent || persistent.probe === 'missing') {
      return {
        sessionId: session.sessionId,
        backendType,
        disposition: 'quiescent',
        ...(persistent ? { persistent } : {}),
      };
    }
    if (persistent.probe === 'unknown') {
      return { ...blockerEntry(session, backendType, 'backend_probe_unknown'), persistent };
    }
    // A detached pane may still be executing a legacy unconfined CLI, but the
    // daemon no longer has a private-IPC attestation for its exact process.
    return { ...blockerEntry(session, backendType, 'unattested_worker'), persistent };
  }

  if (!session.attestation) {
    return {
      ...blockerEntry(session, backendType, 'unattested_worker'),
      ...(persistent ? { persistent } : {}),
    };
  }
  if (!session.worker || !session.attestation.cli) {
    return {
      ...blockerEntry(session, backendType, 'process_identity_unavailable'),
      ...(persistent ? { persistent } : {}),
    };
  }
  if (
    session.workerGeneration === undefined
    || session.attestation.workerGeneration !== session.workerGeneration
  ) {
    return {
      ...blockerEntry(session, backendType, 'stale_attestation'),
      ...(persistent ? { persistent } : {}),
    };
  }
  if (
    dependencies.processStart(session.worker.pid) !== session.worker.procStart
    || dependencies.processStart(session.attestation.cli.pid) !== session.attestation.cli.procStart
  ) {
    return {
      ...blockerEntry(session, backendType, 'stale_attestation'),
      ...(persistent ? { persistent } : {}),
    };
  }
  if (persistent?.probe === 'unknown') {
    return { ...blockerEntry(session, backendType, 'backend_probe_unknown'), persistent };
  }
  if (persistent?.probe === 'missing') {
    return { ...blockerEntry(session, backendType, 'backend_inconsistent'), persistent };
  }

  return {
    sessionId: session.sessionId,
    backendType,
    disposition: 'owned_local',
    credentialIsolated: session.attestation.credentialIsolated,
    worker: session.worker,
    cli: session.attestation.cli,
    workerGeneration: session.workerGeneration,
    ...(persistent ? { persistent } : {}),
  };
}

function generationFor(entries: readonly DeviceIsolationInventoryEntry[]): string {
  return createHash('sha256').update(JSON.stringify(entries), 'utf8').digest('hex');
}

export function buildDeviceIsolationInventory(): DeviceIsolationInventory {
  const entries = dependencies.listSessions()
    .map(classifySession)
    .sort((a, b) => a.sessionId.localeCompare(b.sessionId));
  return {
    generation: generationFor(entries),
    entries,
    blockers: entries.flatMap(entry => entry.blocker
      ? [{ sessionId: entry.sessionId, blocker: entry.blocker }]
      : []),
  };
}

function sha256(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex');
}

function validNonce(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{32,128}$/.test(value);
}

function validLeaseId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9-]{8,128}$/.test(value);
}

function validDigest(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

function validVersion(value: unknown): boolean {
  return value === DEVICE_ISOLATION_ACTIVATION_VERSION;
}

function stableError(status: 409 | 423 | 503, error: string): DeviceIsolationDaemonResult {
  return { status, body: { ok: false, error } };
}

function baseResponse(
  lease: DeviceIsolationFreezeLease,
  inventoryGeneration: string,
): DeviceIsolationDaemonResult {
  if (!daemonIdentity) return stableError(503, 'daemon_identity_unavailable');
  const procStart = dependencies.processStart(process.pid);
  const dataDir = dependencies.dataDir();
  if (!procStart || !dataDir) return stableError(503, 'daemon_identity_unavailable');
  return {
    status: 200,
    body: {
      ok: true,
      activationVersion: DEVICE_ISOLATION_ACTIVATION_VERSION,
      nonce: lease.nonce,
      leaseId: lease.leaseId,
      daemon: {
        larkAppId: daemonIdentity.larkAppId,
        bootInstanceId: daemonIdentity.bootInstanceId,
        pid: process.pid,
        procStart,
        dataDir,
      },
      inventoryGeneration,
      expiresAt: lease.expiresAt,
    },
  };
}

function markerState(raw: string): 'pending' | 'active' | 'invalid' {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (parsed.version !== 1 || typeof parsed.enabledAt !== 'string') return 'invalid';
    if (new Date(parsed.enabledAt).toISOString() !== parsed.enabledAt) return 'invalid';
    // Legacy v1 markers without state are deliberately pending: they enforce
    // isolation for new workers but cannot prove the daemon transaction ended.
    if (parsed.state === undefined || parsed.state === 'pending') return 'pending';
    if (
      parsed.state === 'active'
      && typeof parsed.activatedAt === 'string'
      && new Date(parsed.activatedAt).toISOString() === parsed.activatedAt
    ) return 'active';
    return 'invalid';
  } catch {
    return 'invalid';
  }
}

function readAndMatchMarker(
  expectedSha256: string,
  expectedState: 'pending' | 'active',
): DeviceIsolationDaemonResult | { raw: string } {
  try {
    const raw = dependencies.readMarker();
    if (raw === null || sha256(raw) !== expectedSha256 || markerState(raw) !== expectedState) {
      return stableError(409, 'marker_mismatch');
    }
    return { raw };
  } catch {
    return stableError(503, 'marker_unavailable');
  }
}

function currentTransaction(input: {
  nonce: string;
  leaseId: string;
}): ActivationTransaction | null {
  const lease = requireDeviceIsolationFreeze({
    nonce: input.nonce,
    leaseId: input.leaseId,
    now: dependencies.now(),
  });
  if (
    !lease
    || !transaction
    || transaction.lease.nonce !== input.nonce
    || transaction.lease.leaseId !== input.leaseId
  ) return null;
  transaction.lease = lease;
  return transaction;
}

function processIdentityGone(identity: ProcessIdentity): 'gone' | 'alive' | 'unknown' {
  const current = dependencies.processStart(identity.pid);
  if (current !== undefined) return current === identity.procStart ? 'alive' : 'gone';
  return dependencies.processExists(identity.pid) ? 'unknown' : 'gone';
}

function signalExact(identity: ProcessIdentity, signal: NodeJS.Signals): void {
  if (processIdentityGone(identity) !== 'alive') return;
  try { dependencies.signalProcess(identity.pid, signal); } catch { /* verified below */ }
}

async function quiesceOwnedSessions(
  prepared: DeviceIsolationInventory,
  lease: DeviceIsolationFreezeLease,
): Promise<'ok' | 'lease_expired' | 'teardown_failed'> {
  const sessions = new Map(dependencies.listSessions().map(session => [session.sessionId, session]));
  const targets = prepared.entries.filter(entry => entry.disposition === 'owned_local');
  try {
    for (const target of targets) {
      const session = sessions.get(target.sessionId);
      if (!session) return 'teardown_failed';
      dependencies.closeWorker(session);
      if (target.persistent) {
        dependencies.killPersistent(target.persistent.backendType, target.persistent.name);
      }
    }
  } catch {
    return 'teardown_failed';
  }

  const startedAt = dependencies.now();
  let escalatedTerm = false;
  let escalatedKill = false;
  while (dependencies.now() - startedAt <= 4_000) {
    if (!requireDeviceIsolationFreeze({ nonce: lease.nonce, leaseId: lease.leaseId, now: dependencies.now() })) {
      return 'lease_expired';
    }
    let clean = true;
    let unknown = false;
    for (const target of targets) {
      for (const identity of [target.cli, target.worker]) {
        if (!identity) continue;
        const state = processIdentityGone(identity);
        if (state === 'alive') clean = false;
        if (state === 'unknown') unknown = true;
      }
      if (target.persistent) {
        const probe = dependencies.probePersistent(
          target.persistent.backendType,
          target.persistent.name,
        );
        if (probe === 'unknown') unknown = true;
        if (probe === 'exists') {
          clean = false;
          try {
            dependencies.killPersistent(target.persistent.backendType, target.persistent.name);
          } catch { /* verified by the next probe */ }
        }
      }
    }
    if (clean && !unknown) return 'ok';
    const elapsed = dependencies.now() - startedAt;
    if (!escalatedTerm && elapsed >= 250) {
      escalatedTerm = true;
      for (const target of targets) {
        if (target.cli) signalExact(target.cli, 'SIGTERM');
        if (target.worker) signalExact(target.worker, 'SIGTERM');
      }
    }
    if (!escalatedKill && elapsed >= 1_250) {
      escalatedKill = true;
      for (const target of targets) {
        if (target.cli) signalExact(target.cli, 'SIGKILL');
        if (target.worker) signalExact(target.worker, 'SIGKILL');
      }
    }
    await dependencies.sleep(50);
  }
  return 'teardown_failed';
}

export function setDeviceIsolationDaemonIdentity(
  identity: DeviceIsolationDaemonIdentity | null,
): void {
  daemonIdentity = identity && identity.larkAppId && identity.bootInstanceId
    ? { ...identity }
    : null;
}

export function prepareDeviceIsolationActivation(body: unknown): DeviceIsolationDaemonResult {
  const input = body as Record<string, unknown> | null;
  if (!input || !validVersion(input.activationVersion) || !validNonce(input.nonce)) {
    return stableError(409, 'invalid_request');
  }
  if (!daemonIdentity || !dependencies.processStart(process.pid) || !dependencies.dataDir()) {
    return stableError(503, 'daemon_identity_unavailable');
  }

  const acquired = acquireDeviceIsolationFreeze({
    nonce: input.nonce,
    inventoryGeneration: 'pending',
    now: dependencies.now(),
  });
  if (!acquired.ok) return stableError(423, 'activation_busy');

  if (
    acquired.reused
    && transaction
    && transaction.lease.leaseId === acquired.lease.leaseId
    && transaction.lease.nonce === input.nonce
  ) {
    const response = baseResponse(acquired.lease, transaction.inventory.generation);
    if (response.status === 200) {
      response.body.phase = transaction.phase;
      response.body.inventory = transaction.inventory.entries;
    }
    return response;
  }

  let inventory: DeviceIsolationInventory;
  try {
    inventory = buildDeviceIsolationInventory();
  } catch {
    releaseDeviceIsolationFreeze({
      nonce: input.nonce,
      leaseId: acquired.lease.leaseId,
      now: dependencies.now(),
    });
    return stableError(503, 'inventory_unavailable');
  }
  if (inventory.blockers.length > 0) {
    releaseDeviceIsolationFreeze({
      nonce: input.nonce,
      leaseId: acquired.lease.leaseId,
      now: dependencies.now(),
    });
    transaction = null;
    return {
      status: 409,
      body: { ok: false, error: 'activation_blocked', blockers: inventory.blockers },
    };
  }
  const bound = bindDeviceIsolationFreezeInventoryGeneration({
    nonce: input.nonce,
    leaseId: acquired.lease.leaseId,
    inventoryGeneration: inventory.generation,
    now: dependencies.now(),
  });
  if (!bound) return stableError(409, 'lease_expired');
  transaction = { lease: bound, inventory, phase: 'prepared' };
  const response = baseResponse(bound, inventory.generation);
  if (response.status === 200) {
    response.body.phase = 'prepared';
    response.body.inventory = inventory.entries;
  }
  return response;
}

export async function commitDeviceIsolationActivation(body: unknown): Promise<DeviceIsolationDaemonResult> {
  const input = body as Record<string, unknown> | null;
  if (
    !input
    || !validVersion(input.activationVersion)
    || !validNonce(input.nonce)
    || !validLeaseId(input.leaseId)
    || !validDigest(input.markerSha256)
  ) return stableError(409, 'invalid_request');
  const active = currentTransaction({ nonce: input.nonce, leaseId: input.leaseId });
  if (!active) return stableError(409, 'lease_mismatch');
  if (active.phase === 'committed') {
    if (active.pendingMarkerSha256 !== input.markerSha256) {
      return stableError(409, 'marker_mismatch');
    }
    const response = baseResponse(active.lease, active.inventory.generation);
    if (response.status === 200) response.body.phase = 'committed';
    return response;
  }
  const marker = readAndMatchMarker(input.markerSha256, 'pending');
  if ('status' in marker) return marker;

  let current: DeviceIsolationInventory;
  try { current = buildDeviceIsolationInventory(); }
  catch { return stableError(503, 'inventory_unavailable'); }
  if (current.generation !== active.inventory.generation) {
    return stableError(409, 'inventory_changed');
  }
  const quiesced = await quiesceOwnedSessions(active.inventory, active.lease);
  if (quiesced === 'lease_expired') return stableError(409, 'lease_expired');
  if (quiesced !== 'ok') return stableError(503, 'teardown_unverified');

  let after: DeviceIsolationInventory;
  try { after = buildDeviceIsolationInventory(); }
  catch { return stableError(503, 'inventory_unavailable'); }
  if (
    after.blockers.length > 0
    || after.entries.some(entry => entry.disposition === 'owned_local')
  ) return stableError(409, 'unsafe_local_process');

  active.phase = 'committed';
  active.pendingMarkerSha256 = input.markerSha256;
  active.inventory = after;
  const rebound = bindDeviceIsolationFreezeInventoryGeneration({
    nonce: input.nonce,
    leaseId: input.leaseId,
    inventoryGeneration: after.generation,
    now: dependencies.now(),
  });
  if (!rebound) return stableError(409, 'lease_expired');
  active.lease = rebound;
  const response = baseResponse(rebound, after.generation);
  if (response.status === 200) response.body.phase = 'committed';
  return response;
}

export function releaseDeviceIsolationActivation(body: unknown): DeviceIsolationDaemonResult {
  const input = body as Record<string, unknown> | null;
  if (
    !input
    || !validVersion(input.activationVersion)
    || !validNonce(input.nonce)
    || !validLeaseId(input.leaseId)
  ) return stableError(409, 'invalid_request');
  const active = currentTransaction({ nonce: input.nonce, leaseId: input.leaseId });
  if (!active) return stableError(409, 'lease_mismatch');

  if (input.abort === true) {
    if (active.phase === 'committed') return stableError(409, 'activation_committed');
    if (!releaseDeviceIsolationFreeze({
      nonce: input.nonce,
      leaseId: input.leaseId,
      now: dependencies.now(),
    })) {
      return stableError(409, 'lease_mismatch');
    }
    transaction = null;
    const response = baseResponse(active.lease, active.inventory.generation);
    if (response.status === 200) response.body.aborted = true;
    return response;
  }

  if (active.phase !== 'committed') return stableError(409, 'activation_not_committed');
  if (!validDigest(input.markerSha256)) return stableError(409, 'invalid_request');
  // Commit binds the PENDING marker. The host switches it to ACTIVE only after
  // every daemon committed, so release intentionally accepts a different hash
  // while requiring the exact bytes supplied here to parse as ACTIVE.
  const marker = readAndMatchMarker(input.markerSha256, 'active');
  if ('status' in marker) return marker;

  let current: DeviceIsolationInventory;
  try { current = buildDeviceIsolationInventory(); }
  catch { return stableError(503, 'inventory_unavailable'); }
  if (
    current.blockers.length > 0
    || current.entries.some(entry => entry.disposition === 'owned_local')
  ) return stableError(409, 'unsafe_local_process');
  if (!releaseDeviceIsolationFreeze({
    nonce: input.nonce,
    leaseId: input.leaseId,
    now: dependencies.now(),
  })) {
    return stableError(409, 'lease_mismatch');
  }
  transaction = null;
  const response = baseResponse(active.lease, current.generation);
  if (response.status === 200) response.body.released = true;
  return response;
}

/** Test seams keep process and backend destruction out of unit tests. */
export function setDeviceIsolationDaemonDependenciesForTest(
  overrides: Partial<DeviceIsolationDaemonDependencies> | null,
): void {
  dependencies = overrides ? { ...defaultDependencies, ...overrides } : defaultDependencies;
}

export function resetDeviceIsolationDaemonForTest(): void {
  transaction = null;
  daemonIdentity = null;
  dependencies = defaultDependencies;
}

export function logDeviceIsolationActivationError(error: unknown): void {
  logger.warn('[device-isolation] activation handler failed closed', error);
}
