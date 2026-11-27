import { existsSync } from 'node:fs';
import { isValidPluginId } from '../ids.js';
import { readPluginCardActionToken } from '../card-actions/auth.js';
import { parseValidTcpPort, readPluginServiceState } from '../service-manager.js';
import { readPluginProcesses, type PluginProcessInfo } from '../supervisor-client.js';
import {
  pluginServiceName,
  pluginSupervisorDesiredPath,
  pluginSupervisorStatePath,
  readPluginSupervisorDesired,
  type PluginSupervisorDesired,
} from '../supervisor-store.js';
import { pidAlive } from '../../fleet-supervisor.js';
import { isLinuxZombie, readFleetDurableProcessIdentity } from '../../../utils/process-identity.js';
import type { PluginServiceState } from '../types.js';

export interface PluginLoopbackTarget {
  ok: true;
  host: '127.0.0.1';
  port: number;
  token: string;
  pid: number;
  processStart: string;
}

export type PluginLoopbackTargetResult =
  | PluginLoopbackTarget
  | {
      ok: false;
      status: 503;
      error: 'plugin_service_unavailable' | 'plugin_service_token_unavailable';
    };

export function samePluginLoopbackTarget(a: PluginLoopbackTarget, b: PluginLoopbackTarget): boolean {
  return a.host === b.host
    && a.port === b.port
    && a.token === b.token
    && a.pid === b.pid
    && a.processStart === b.processStart;
}

export interface ResolvePluginLoopbackTargetDeps {
  readServiceState?: (pluginId: string) => PluginServiceState | undefined;
  readProcesses?: () => PluginProcessInfo[];
  readDesired?: () => PluginSupervisorDesired;
  hasSupervisorFiles?: () => boolean;
  readToken?: (pluginId: string) => string;
  isPidAlive?: (pid: number) => boolean;
  isZombie?: (pid: number) => boolean;
  readProcessStart?: (pid: number) => string | undefined;
  forbiddenPorts?: () => ReadonlySet<number>;
}

/**
 * Resolve a live, authenticated loopback target (`127.0.0.1:<port>` + bearer
 * token + verified OS process birth identity) for an installed plugin service
 * without holding `withPluginServiceLock`.
 *
 * Two evidence modes:
 * - Supervisor files present: the authoritative inputs are the host-written
 *   `desired` spec (port, running flag) and the LIVE supervisor process table
 *   (pid + birth identity). The dashboard-cached `service.json` is only a
 *   status projection there — a transiently-unreadable birth identity can make
 *   it record `unknown`, and gating on that stale row would keep the proxy 503
 *   even after the live process recovers, so it is NOT consulted in this mode.
 * - No supervisor files: `service.json` is the sole durable evidence and stays
 *   strictly validated (online + live non-zombie pid + matching birth identity).
 *
 * Fail-closed invariants:
 * - Rejects invalid/missing ports (`1..65535`) in either mode.
 * - Rejects self-proxy / daemon IPC / session preview ports in `forbiddenPorts`.
 * - Supervisor mode additionally requires `desired.services[pluginId].running`,
 *   rejects cross-plugin port collisions, and requires a live `online` proc
 *   whose non-empty `configHash` explicitly matches the desired spec hash (no
 *   `undefined === undefined` pass) and which carries a verified `processStart`.
 * - Requires a valid host-managed loopback bearer token (`readToken`).
 */
export function resolveRunningPluginServiceTarget(
  pluginId: string,
  deps: ResolvePluginLoopbackTargetDeps = {},
): PluginLoopbackTargetResult {
  if (!isValidPluginId(pluginId)) {
    return { ok: false, status: 503, error: 'plugin_service_unavailable' };
  }
  const readState = deps.readServiceState ?? readPluginServiceState;
  const serviceState = readState(pluginId);

  const hasSupervisor = deps.hasSupervisorFiles
    ? deps.hasSupervisorFiles()
    : (existsSync(pluginSupervisorStatePath()) || existsSync(pluginSupervisorDesiredPath()));

  const forbidden = deps.forbiddenPorts?.();
  let pid: number;
  let processStart: string;
  let port: number;

  if (hasSupervisor) {
    // Authoritative: desired spec + live process table. A stale/unknown row in
    // the service.json cache must not block recovery once the proc is verified.
    try {
      const desired = (deps.readDesired ?? readPluginSupervisorDesired)();
      const desiredEntry = Object.hasOwn(desired.services, pluginId)
        ? desired.services[pluginId]
        : undefined;
      if (!desiredEntry || desiredEntry.running !== true) {
        return { ok: false, status: 503, error: 'plugin_service_unavailable' };
      }
      const desiredPort = parseValidTcpPort(desiredEntry.spec?.external?.env?.PORT);
      if (desiredPort === undefined) {
        return { ok: false, status: 503, error: 'plugin_service_unavailable' };
      }
      // Generation binding: production always writes a non-empty sha256
      // configHash into both the desired spec and the live proc row. Require an
      // explicit match so a desired config/port update cannot pair with a still
      // running OLD process during the supervisor restart window — otherwise the
      // host bearer token could be dialed to the wrong listener on the new port.
      // Missing hashes fail closed (no `undefined === undefined` pass).
      const desiredHash = desiredEntry.spec?.external?.configHash;
      if (typeof desiredHash !== 'string' || !desiredHash) {
        return { ok: false, status: 503, error: 'plugin_service_unavailable' };
      }
      if (forbidden?.has(desiredPort)) {
        return { ok: false, status: 503, error: 'plugin_service_unavailable' };
      }
      for (const [otherId, otherEntry] of Object.entries(desired.services)) {
        if (otherId !== pluginId && otherEntry.running === true) {
          const otherPort = parseValidTcpPort(otherEntry.spec?.external?.env?.PORT);
          if (otherPort === desiredPort) {
            return { ok: false, status: 503, error: 'plugin_service_unavailable' };
          }
        }
      }
      const processes = (deps.readProcesses ?? readPluginProcesses)();
      const proc = processes.find(item => item.name === pluginServiceName(pluginId));
      if (
        !proc
        || proc.status !== 'online'
        || typeof proc.pid !== 'number'
        || !Number.isSafeInteger(proc.pid)
        || proc.pid <= 0
        || typeof proc.processStart !== 'string'
        || !proc.processStart
        || typeof proc.configHash !== 'string'
        || !proc.configHash
        || proc.configHash !== desiredHash
      ) {
        return { ok: false, status: 503, error: 'plugin_service_unavailable' };
      }
      pid = proc.pid;
      processStart = proc.processStart;
      port = desiredPort;
    } catch {
      return { ok: false, status: 503, error: 'plugin_service_unavailable' };
    }
  } else {
    // service.json is the only durable evidence: keep every strict check.
    const legacyPort = parseValidTcpPort(serviceState?.port);
    if (
      !serviceState
      || serviceState.pluginId !== pluginId
      || serviceState.status !== 'online'
      || legacyPort === undefined
    ) {
      return { ok: false, status: 503, error: 'plugin_service_unavailable' };
    }
    if (forbidden?.has(legacyPort)) {
      return { ok: false, status: 503, error: 'plugin_service_unavailable' };
    }
    const aliveFn = deps.isPidAlive ?? pidAlive;
    const zombieFn = deps.isZombie ?? isLinuxZombie;
    const startFn = deps.readProcessStart
      ?? ((pid: number) => readFleetDurableProcessIdentity(pid, serviceState.processStart));
    if (
      typeof serviceState.pid !== 'number'
      || !Number.isSafeInteger(serviceState.pid)
      || serviceState.pid <= 0
      || typeof serviceState.processStart !== 'string'
      || !serviceState.processStart
      || !aliveFn(serviceState.pid)
      || zombieFn(serviceState.pid)
      || startFn(serviceState.pid) !== serviceState.processStart
    ) {
      return { ok: false, status: 503, error: 'plugin_service_unavailable' };
    }
    pid = serviceState.pid;
    processStart = serviceState.processStart;
    port = legacyPort;
  }

  let token: string;
  try {
    token = (deps.readToken ?? readPluginCardActionToken)(pluginId);
  } catch {
    return { ok: false, status: 503, error: 'plugin_service_token_unavailable' };
  }
  if (!token) {
    return { ok: false, status: 503, error: 'plugin_service_token_unavailable' };
  }

  return { ok: true, host: '127.0.0.1', port, token, pid, processStart };
}
