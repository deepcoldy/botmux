import { existsSync, readFileSync, statSync } from 'node:fs';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import type { WorkerConfig } from '../global-config.js';

export interface SessionScopeCapabilities {
  cleanupSupported: boolean;
  memoryControllerSupported: boolean;
  reason?: string;
}

type RunSync = (
  command: string,
  args: readonly string[],
) => Pick<SpawnSyncReturns<string>, 'status' | 'stdout' | 'stderr' | 'error'>;

export interface SessionScopeProbeOptions {
  platform?: NodeJS.Platform;
  run?: RunSync;
  exists?: (path: string) => boolean;
  readFile?: (path: string) => string;
}

export function userSystemdBusEnv(options: {
  platform?: NodeJS.Platform;
  uid?: number;
  isSocket?: (path: string) => boolean;
} = {}): Record<string, string> | undefined {
  if ((options.platform ?? process.platform) !== 'linux') return undefined;
  const uid = options.uid ?? process.getuid?.();
  if (uid === undefined || !Number.isSafeInteger(uid) || uid < 0) return undefined;
  const runtimeDir = `/run/user/${uid}`;
  const busPath = `${runtimeDir}/bus`;
  const isSocket = options.isSocket ?? (path => {
    try { return statSync(path).isSocket(); } catch { return false; }
  });
  if (!isSocket(busPath)) return undefined;
  return {
    XDG_RUNTIME_DIR: runtimeDir,
    DBUS_SESSION_BUS_ADDRESS: `unix:path=${busPath}`,
  };
}

function defaultRun(
  command: string,
  args: readonly string[],
): ReturnType<RunSync> {
  return spawnSync(command, [...args], {
    encoding: 'utf8',
    timeout: 5_000,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...userSystemdBusEnv() },
  });
}

function controllerDelegated(
  controlGroup: string,
  exists: (path: string) => boolean,
  readFile: (path: string) => string,
): boolean {
  // Deliberately require cgroup v2. On cgroup-v1/hybrid hosts an accepted
  // MemoryMax property can land only in name=systemd and provide no memory
  // containment; reporting that as enforceable would be a false guarantee.
  if (!exists('/sys/fs/cgroup/cgroup.controllers')) return false;
  const path = `/sys/fs/cgroup${controlGroup}`.replace(/\/+$/, '');
  try {
    const controllers = readFile(`${path}/cgroup.controllers`).trim().split(/\s+/);
    const enabled = readFile(`${path}/cgroup.subtree_control`).trim().split(/\s+/)
      .map(value => value.replace(/^\+/, ''));
    return controllers.includes('memory') && enabled.includes('memory');
  } catch {
    return false;
  }
}

function memoryControllerPlacementVerified(
  probeUnit: string,
  run: RunSync,
  exists: (path: string) => boolean,
  readFile: (path: string) => string,
): boolean {
  const unit = `${probeUnit}-memory.scope`;
  const limit = '16777216';
  try {
    // systemd-run --scope waits for its payload, so start the disposable probe
    // in a background shell, then inspect the live scope's ACTUAL ControlGroup.
    // The unit name is process-derived and contains no shell-controlled input.
    const started = run('sh', [
      '-c',
      'systemd-run --user --scope --quiet --collect --unit="$1" '
        + '--property=MemoryMax=16777216 sleep 5 >/dev/null 2>&1 &',
      'sh',
      unit,
    ]);
    if (started.status !== 0) return false;
    for (let attempt = 0; attempt < 20; attempt++) {
      const shown = run('systemctl', [
        '--user', 'show', unit, '--property=ControlGroup', '--value',
      ]);
      const controlGroup = shown.status === 0 ? shown.stdout.trim() : '';
      if (controlGroup) {
        const memoryMax = `/sys/fs/cgroup${controlGroup}/memory.max`;
        return exists(memoryMax) && readFile(memoryMax).trim() === limit;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
    return false;
  } catch {
    return false;
  } finally {
    run('systemctl', ['--user', 'stop', unit]);
  }
}

export function probeSessionScopeCapabilities(
  options: SessionScopeProbeOptions = {},
): SessionScopeCapabilities {
  if ((options.platform ?? process.platform) !== 'linux') {
    return {
      cleanupSupported: false,
      memoryControllerSupported: false,
      reason: 'user systemd scopes are available only on Linux',
    };
  }
  const run = options.run ?? defaultRun;
  const probeUnit = `botmux-scope-probe-${process.pid}`;
  const scope = run('systemd-run', [
    '--user', '--scope', '--quiet', '--collect', `--unit=${probeUnit}`, 'true',
  ]);
  if (scope.status !== 0) {
    const detail = scope.error?.message || scope.stderr?.trim() || `exit ${scope.status ?? 'unknown'}`;
    return {
      cleanupSupported: false,
      memoryControllerSupported: false,
      reason: `user systemd scope probe failed: ${detail}`,
    };
  }

  const manager = run('systemctl', ['--user', 'show', '--property=ControlGroup', '--value']);
  const controlGroup = manager.status === 0 ? manager.stdout.trim() : '';
  const exists = options.exists ?? existsSync;
  const readFile = options.readFile ?? (path => readFileSync(path, 'utf8'));
  const memoryControllerSupported = !!controlGroup
    && controllerDelegated(controlGroup, exists, readFile)
    && memoryControllerPlacementVerified(probeUnit, run, exists, readFile);
  return {
    cleanupSupported: true,
    memoryControllerSupported,
    ...(!memoryControllerSupported
      ? { reason: 'scope cleanup works, but a delegated cgroup-v2 memory controller was not verified' }
      : {}),
  };
}

let cachedCapabilities: { value: SessionScopeCapabilities; at: number } | undefined;

export function sessionScopeCapabilities(): SessionScopeCapabilities {
  if (cachedCapabilities && Date.now() - cachedCapabilities.at < 60_000) return cachedCapabilities.value;
  const value = probeSessionScopeCapabilities();
  cachedCapabilities = { value, at: Date.now() };
  return value;
}

export function sessionScopeUnitName(sessionId: string): string {
  const safe = sessionId.toLowerCase().replace(/[^a-z0-9_.-]/g, '-').slice(0, 96);
  return `botmux-session-${safe || 'unknown'}.scope`;
}

export interface ScopedCommand {
  bin: string;
  args: string[];
  unitName?: string;
  capabilities: SessionScopeCapabilities;
}

export function wrapCommandInSessionScope(
  sessionId: string,
  bin: string,
  args: readonly string[],
  workerConfig?: WorkerConfig,
  capabilities = sessionScopeCapabilities(),
  systemdEnv = userSystemdBusEnv(),
): ScopedCommand {
  if (!capabilities.cleanupSupported) return { bin, args: [...args], capabilities };
  const unitName = sessionScopeUnitName(sessionId);
  const scopeArgs = [
    '--user',
    '--scope',
    '--quiet',
    '--collect',
    `--unit=${unitName}`,
    '--property=KillMode=control-group',
  ];
  if (capabilities.memoryControllerSupported && workerConfig?.sessionMemoryMaxBytes !== undefined) {
    scopeArgs.push(`--property=MemoryMax=${workerConfig.sessionMemoryMaxBytes}`);
  }
  scopeArgs.push('--', bin, ...args);
  const envArgs = systemdEnv
    ? Object.entries(systemdEnv).map(([key, value]) => `${key}=${value}`)
    : [];
  return {
    // Put the bus address on the pane argv boundary. Persistent backends do not
    // all forward arbitrary caller env keys, and a long-lived tmux server may
    // have started before the login bus existed.
    bin: '/usr/bin/env',
    args: [...envArgs, 'systemd-run', ...scopeArgs],
    unitName,
    capabilities,
  };
}

export function stopSessionScope(
  sessionId: string,
  options: { platform?: NodeJS.Platform; run?: RunSync } = {},
): boolean {
  if ((options.platform ?? process.platform) !== 'linux') return false;
  const run = options.run ?? defaultRun;
  return run('systemctl', ['--user', 'stop', sessionScopeUnitName(sessionId)]).status === 0;
}

export function __testOnly_resetSessionScopeCapabilityCache(): void {
  cachedCapabilities = undefined;
}
