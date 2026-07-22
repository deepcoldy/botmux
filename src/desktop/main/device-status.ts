import type {
  DesktopDevicePublicStatus,
  DesktopDeviceStatusResult,
} from '../shared/types.js';

// `botmux device status --json` is a tiny local status protocol. Cap its input
// before JSON.parse so a broken/hostile replacement CLI cannot make Electron
// retain arbitrary stdout in the renderer-facing result.
const MAX_DEVICE_STATUS_BYTES = 4 * 1024;

interface DeviceStatusCommandResult {
  code: number;
  stdout: string;
}

/**
 * Convert host-CLI output into the only device data Electron may expose.
 *
 * This is intentionally an exact allow-list, not a cast: if a buggy CLI adds
 * accessToken/refreshToken (or any future unreviewed field), main rejects the
 * whole response before it can cross IPC into the renderer/webview boundary.
 */
export function sanitizeDeviceStatusCommandResult(
  result: DeviceStatusCommandResult,
): DesktopDeviceStatusResult {
  if (result.code !== 0) return { ok: false, reason: 'command_failed' };
  if (Buffer.byteLength(result.stdout, 'utf8') > MAX_DEVICE_STATUS_BYTES) {
    return { ok: false, reason: 'invalid_response' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout.trim());
  } catch {
    return { ok: false, reason: 'invalid_response' };
  }
  const status = parsePublicStatus(parsed);
  return status
    ? { ok: true, status }
    : { ok: false, reason: 'invalid_response' };
}

function parsePublicStatus(value: unknown): DesktopDevicePublicStatus | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== 1 || typeof record.enrolled !== 'boolean') return null;
  if (!record.enrolled) {
    if (!hasExactKeys(record, ['schemaVersion', 'enrolled'])) return null;
    return { schemaVersion: 1, enrolled: false };
  }

  if (
    !hasExactKeys(record, ['schemaVersion', 'enrolled', 'issuer', 'deviceExp', 'savedAt'])
    ||
    typeof record.issuer !== 'string'
    || !isSafeIssuer(record.issuer)
    || typeof record.deviceExp !== 'number'
    || !Number.isSafeInteger(record.deviceExp)
    || record.deviceExp <= 0
    || typeof record.savedAt !== 'string'
    || !isCanonicalIsoDate(record.savedAt)
  ) return null;

  return {
    schemaVersion: 1,
    enrolled: true,
    issuer: record.issuer,
    deviceExp: record.deviceExp,
    savedAt: record.savedAt,
  };
}

function hasExactKeys(record: Record<string, unknown>, expected: string[]): boolean {
  const actual = Object.keys(record).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

/**
 * Keep this boolean predicate in lockstep with platform `normalizeDeviceIssuer`
 * (throwing validator). Desktop only sanitizes a public status DTO and must not
 * import the host credential module into the Electron main process.
 */
function isSafeIssuer(raw: string): boolean {
  if (raw.length === 0 || raw.length > 2048) return false;
  try {
    const url = new URL(raw);
    if (url.origin !== raw || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
      return false;
    }
    if (url.protocol === 'https:') return true;
    if (url.protocol !== 'http:') return false;
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    return host === 'localhost' || host === '127.0.0.1' || host === '::1';
  } catch {
    return false;
  }
}

function isCanonicalIsoDate(raw: string): boolean {
  if (raw.length > 64) return false;
  const millis = Date.parse(raw);
  return Number.isFinite(millis) && new Date(millis).toISOString() === raw;
}
