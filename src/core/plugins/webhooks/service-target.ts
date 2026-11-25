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
import { isLinuxZombie, readDurableProcessIdentity } from '../../../utils/process-identity.js';
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
 * Fail-closed invariants:
 * - Rejects missing/offline `service.json` or invalid port (`1..65535`).
 * - Rejects self-proxy / daemon IPC / session preview ports in `forbiddenPorts`.
 * - When plugin supervisor state/desired files exist:
 *   - Requires `desired.services[pluginId]?.running === true` (with `Object.hasOwn`).
 *   - Requires `desiredEntry.spec.external.env.PORT` to be present and equal to `port`.
 *   - Rejects cross-plugin port collisions across running desired services.
 *   - Requires a live `online` supervisor proc with a non-empty verified `processStart`.
 * - When no supervisor files exist, unconditionally requires a live non-zombie
 *   `serviceState.pid` matching a non-empty `serviceState.processStart`.
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
  const port = parseValidTcpPort(serviceState?.port);
  if (!serviceState || serviceState.pluginId !== pluginId || serviceState.status !== 'online' || port === undefined) {
    return { ok: false, status: 503, error: 'plugin_service_unavailable' };
  }

  const forbidden = deps.forbiddenPorts?.();
  if (forbidden?.has(port)) {
    return { ok: false, status: 503, error: 'plugin_service_unavailable' };
  }

  const hasSupervisor = deps.hasSupervisorFiles
    ? deps.hasSupervisorFiles()
    : (existsSync(pluginSupervisorStatePath()) || existsSync(pluginSupervisorDesiredPath()));

  let pid: number;
  let processStart: string;

  if (hasSupervisor) {
    try {
      const desired = (deps.readDesired ?? readPluginSupervisorDesired)();
      const desiredEntry = Object.hasOwn(desired.services, pluginId)
        ? desired.services[pluginId]
        : undefined;
      if (!desiredEntry || desiredEntry.running !== true) {
        return { ok: false, status: 503, error: 'plugin_service_unavailable' };
      }
      const desiredPort = parseValidTcpPort(desiredEntry.spec?.external?.env?.PORT);
      if (desiredPort === undefined || desiredPort !== port) {
        return { ok: false, status: 503, error: 'plugin_service_unavailable' };
      }
      for (const [otherId, otherEntry] of Object.entries(desired.services)) {
        if (otherId !== pluginId && otherEntry.running === true) {
          const otherPort = parseValidTcpPort(otherEntry.spec?.external?.env?.PORT);
          if (otherPort === port) {
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
      ) {
        return { ok: false, status: 503, error: 'plugin_service_unavailable' };
      }
      pid = proc.pid;
      processStart = proc.processStart;
    } catch {
      return { ok: false, status: 503, error: 'plugin_service_unavailable' };
    }
  } else {
    const aliveFn = deps.isPidAlive ?? pidAlive;
    const zombieFn = deps.isZombie ?? isLinuxZombie;
    const startFn = deps.readProcessStart ?? readDurableProcessIdentity;
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
