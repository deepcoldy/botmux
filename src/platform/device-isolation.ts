/** Host-side activation marker for mandatory device isolation. */
import { homedir } from 'node:os';
import { probeHostCredentialIsolationMechanism } from '../adapters/backend/sandbox.js';
import {
  deviceCredentialIsolationMarkerPath,
} from '../adapters/cli/read-isolation.js';
import {
  readSecureHostFileSync,
  writeSecureHostFileSync,
} from './secure-host-file.js';

const DEVICE_ISOLATION_MARKER_VERSION = 1 as const;

interface DeviceIsolationMarker {
  version: typeof DEVICE_ISOLATION_MARKER_VERSION;
  /** pending still activates worker fail-closed masking, but cannot authorize
   * the first credential write until every daemon has quiesced legacy CLIs. */
  state: 'pending' | 'active';
  enabledAt: string;
  activatedAt?: string;
}

export class DeviceIsolationActivationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DeviceIsolationActivationError';
  }
}

export interface DeviceIsolationActivationOptions {
  homeDir?: string;
  now?: () => Date;
}

/** Probe before writing the one-way marker; unsupported hosts refuse enroll. */
export function deviceCredentialIsolationSupported(platform = process.platform): boolean {
  if (platform !== process.platform || (platform !== 'darwin' && platform !== 'linux')) return false;
  return probeHostCredentialIsolationMechanism().supported;
}

function parseDeviceIsolationMarker(raw: string): DeviceIsolationMarker {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const enabledAt = typeof parsed.enabledAt === 'string' ? parsed.enabledAt : '';
    const state = parsed.state === 'active' ? 'active' : 'pending';
    const activatedAt = typeof parsed.activatedAt === 'string' ? parsed.activatedAt : undefined;
    if (
      parsed.version !== DEVICE_ISOLATION_MARKER_VERSION
      || !enabledAt
      || new Date(enabledAt).toISOString() !== enabledAt
      || (parsed.state !== undefined && parsed.state !== 'pending' && parsed.state !== 'active')
      || (state === 'active' && (
        !activatedAt || new Date(activatedAt).toISOString() !== activatedAt
      ))
    ) throw new Error('invalid marker');
    return {
      version: DEVICE_ISOLATION_MARKER_VERSION,
      state,
      enabledAt,
      ...(activatedAt ? { activatedAt } : {}),
    };
  } catch {
    throw new DeviceIsolationActivationError(
      '设备凭证隔离 marker 已损坏；拒绝继续注册，请先修复宿主配置',
    );
  }
}

export function readDeviceCredentialIsolationMarker(
  options: Pick<DeviceIsolationActivationOptions, 'homeDir'> = {},
): DeviceIsolationMarker | null {
  const home = options.homeDir ?? homedir();
  const raw = readSecureHostFileSync(deviceCredentialIsolationMarkerPath(home), 4 * 1024);
  return raw === null ? null : parseDeviceIsolationMarker(raw);
}

/** Create the one-way PENDING marker durably. Pending already forces every new
 * local worker into credential isolation, but retries must still quiesce all
 * daemons before the marker may transition to ACTIVE. */
export function ensureDeviceCredentialIsolationMarker(
  options: DeviceIsolationActivationOptions = {},
): { created: boolean; path: string; state: 'pending' | 'active' } {
  const home = options.homeDir ?? homedir();
  const path = deviceCredentialIsolationMarkerPath(home);
  const current = readSecureHostFileSync(path, 4 * 1024);
  if (current !== null) {
    return { created: false, path, state: parseDeviceIsolationMarker(current).state };
  }
  const enabledAt = (options.now ?? (() => new Date()))().toISOString();
  writeSecureHostFileSync(path, `${JSON.stringify({
    version: DEVICE_ISOLATION_MARKER_VERSION,
    state: 'pending',
    enabledAt,
  }, null, 2)}\n`);
  return { created: true, path, state: 'pending' };
}

/** Mark a fully quiesced host ACTIVE. This is the only state that lets a later
 * enroll skip the daemon transaction. The marker itself remains one-way. */
export function completeDeviceCredentialIsolationMarker(
  options: DeviceIsolationActivationOptions = {},
): { path: string; state: 'active' } {
  const home = options.homeDir ?? homedir();
  const path = deviceCredentialIsolationMarkerPath(home);
  const currentRaw = readSecureHostFileSync(path, 4 * 1024);
  if (currentRaw === null) {
    throw new DeviceIsolationActivationError('设备凭证隔离 marker 尚未创建');
  }
  const current = parseDeviceIsolationMarker(currentRaw);
  if (current.state === 'active') return { path, state: 'active' };
  const activatedAt = (options.now ?? (() => new Date()))().toISOString();
  writeSecureHostFileSync(path, `${JSON.stringify({
    version: DEVICE_ISOLATION_MARKER_VERSION,
    state: 'active',
    enabledAt: current.enabledAt,
    activatedAt,
  }, null, 2)}\n`);
  const verified = readSecureHostFileSync(path, 4 * 1024);
  if (verified === null || parseDeviceIsolationMarker(verified).state !== 'active') {
    throw new DeviceIsolationActivationError('设备凭证隔离 marker ACTIVE 复验失败');
  }
  return { path, state: 'active' };
}
