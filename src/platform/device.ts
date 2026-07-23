/**
 * Host-only desktop device credential storage.
 *
 * Device credentials are deliberately kept separate from platform.json: the
 * machine bearer identifies the daemon, while this file identifies a person on
 * a desktop device.  Callers must never serialize this object to stdout or a
 * renderer process; use {@link readDevicePublicStatus} for display purposes.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  readSecureHostFileSync,
  unlinkSecureHostFileSync,
  UnsafeHostAuthorityFileError,
  writeSecureHostFileSync,
} from './secure-host-file.js';
import { deviceCredentialFile } from './device-paths.js';

export const DEVICE_CREDENTIAL_SCHEMA_VERSION = 1 as const;

export interface DeviceCredentials {
  schemaVersion: typeof DEVICE_CREDENTIAL_SCHEMA_VERSION;
  /** HTTPS origin pinned when enrollment starts. */
  issuer: string;
  /** Short-lived signed bearer. Never expose outside the host process. */
  accessToken: string;
  /** Absolute access-token expiry supplied by the server, Unix epoch ms. */
  accessExpiresAt: number;
  /** Rotating opaque secret. Never expose outside the host process. */
  refreshToken: string;
  /** Absolute server-issued device expiry, represented as Unix epoch ms. */
  deviceExp: number;
  /** Local metadata only; ISO timestamp of the last atomic credential write. */
  savedAt: string;
  /**
   * Durable idempotency key for an in-flight refresh rotation. A failed or
   * interrupted request keeps this value so the next host process can replay
   * the same server operation instead of reusing the old refresh as a new one.
   */
  pendingRefreshRequestId?: string;
  /** Unix epoch ms when the current replay window began. */
  pendingRefreshStartedAt?: number;
  /** Ambiguous/unsafe refresh state: never send the stored refresh again. */
  refreshRecoveryRequired?: true;
}

export type DeviceCredentialWriteInput = Pick<
  DeviceCredentials,
  'issuer' | 'accessToken' | 'accessExpiresAt' | 'refreshToken' | 'deviceExp'
> & {
  pendingRefreshRequestId?: string;
  pendingRefreshStartedAt?: number;
  refreshRecoveryRequired?: true;
};

export type DevicePublicStatus =
  | {
      schemaVersion: typeof DEVICE_CREDENTIAL_SCHEMA_VERSION;
      enrolled: false;
    }
  | {
      schemaVersion: typeof DEVICE_CREDENTIAL_SCHEMA_VERSION;
      enrolled: true;
      issuer: string;
      deviceExp: number;
      savedAt: string;
    };

export interface DeviceCredentialPathOptions {
  /** Test/embedding seam. Defaults to os.homedir(). */
  homeDir?: string;
  /** Exact file override. Takes precedence over homeDir. */
  filePath?: string;
}

export interface WriteDeviceCredentialsOptions extends DeviceCredentialPathOptions {
  /** Test seam; defaults to the current wall clock. */
  now?: () => Date;
}

export class DeviceCredentialError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'invalid_issuer'
      | 'issuer_mismatch'
      | 'unsafe_file'
      | 'invalid_file',
  ) {
    super(message);
    this.name = 'DeviceCredentialError';
  }
}

export function deviceCredentialsPath(options: DeviceCredentialPathOptions = {}): string {
  return options.filePath
    ?? deviceCredentialFile(join(options.homeDir ?? homedir(), '.botmux'));
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1';
}

/**
 * Normalize and validate the credential issuer.
 *
 * Production enrollment is HTTPS-only. Loopback HTTP is accepted solely for
 * local development/self-tests; credentials are never sent over cleartext to
 * a non-loopback host. Paths, query strings, fragments and userinfo are
 * rejected so every request stays pinned to one unambiguous origin.
 */
export function normalizeDeviceIssuer(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new DeviceCredentialError('设备平台地址无效', 'invalid_issuer');
  }
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new DeviceCredentialError('设备平台地址必须是纯 origin，不能包含路径、查询、片段或用户信息', 'invalid_issuer');
  }
  const secure = url.protocol === 'https:';
  const localDevelopment = url.protocol === 'http:' && isLoopbackHostname(url.hostname);
  if (!secure && !localDevelopment) {
    throw new DeviceCredentialError('设备注册只允许 HTTPS（本机 loopback 开发除外）', 'invalid_issuer');
  }
  return url.origin;
}

function asCredentialFileError(error: unknown): never {
  if (error instanceof UnsafeHostAuthorityFileError) {
    throw new DeviceCredentialError(error.message, 'unsafe_file');
  }
  throw error;
}

function parseDeviceCredentials(raw: string): DeviceCredentials {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new DeviceCredentialError('device.json 已损坏或不是有效 JSON', 'invalid_file');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new DeviceCredentialError('device.json 结构无效', 'invalid_file');
  }
  const record = value as Record<string, unknown>;
  if (
    record.schemaVersion !== DEVICE_CREDENTIAL_SCHEMA_VERSION
    || typeof record.issuer !== 'string'
    || typeof record.accessToken !== 'string'
    || !record.accessToken
    || typeof record.accessExpiresAt !== 'number'
    || !Number.isSafeInteger(record.accessExpiresAt)
    || record.accessExpiresAt <= 0
    || typeof record.refreshToken !== 'string'
    || !record.refreshToken
    || typeof record.deviceExp !== 'number'
    || !Number.isSafeInteger(record.deviceExp)
    || record.deviceExp <= 0
    || record.accessExpiresAt > record.deviceExp
    || typeof record.savedAt !== 'string'
    || !record.savedAt
    || !Number.isFinite(Date.parse(record.savedAt))
    || new Date(record.savedAt).toISOString() !== record.savedAt
    || (record.pendingRefreshRequestId !== undefined && (
      typeof record.pendingRefreshRequestId !== 'string'
      || !/^[a-zA-Z0-9._:-]{16,128}$/.test(record.pendingRefreshRequestId)
    ))
    || (record.pendingRefreshStartedAt !== undefined && (
      typeof record.pendingRefreshStartedAt !== 'number'
      || !Number.isSafeInteger(record.pendingRefreshStartedAt)
      || record.pendingRefreshStartedAt <= 0
    ))
    || ((record.pendingRefreshRequestId === undefined) !== (record.pendingRefreshStartedAt === undefined))
    || (record.refreshRecoveryRequired !== undefined && record.refreshRecoveryRequired !== true)
    || (record.refreshRecoveryRequired === true && record.pendingRefreshRequestId !== undefined)
  ) {
    throw new DeviceCredentialError('device.json 缺少必要字段或字段类型无效', 'invalid_file');
  }
  const issuer = normalizeDeviceIssuer(record.issuer);
  if (issuer !== record.issuer) {
    throw new DeviceCredentialError('device.json 中的 issuer 不是规范化 origin', 'invalid_file');
  }
  return {
    schemaVersion: DEVICE_CREDENTIAL_SCHEMA_VERSION,
    issuer,
    accessToken: record.accessToken,
    accessExpiresAt: record.accessExpiresAt,
    refreshToken: record.refreshToken,
    deviceExp: record.deviceExp,
    savedAt: record.savedAt,
    ...(typeof record.pendingRefreshRequestId === 'string'
      ? { pendingRefreshRequestId: record.pendingRefreshRequestId }
      : {}),
    ...(typeof record.pendingRefreshStartedAt === 'number'
      ? { pendingRefreshStartedAt: record.pendingRefreshStartedAt }
      : {}),
    ...(record.refreshRecoveryRequired === true ? { refreshRecoveryRequired: true as const } : {}),
  };
}

export function readDeviceCredentials(
  options: DeviceCredentialPathOptions = {},
): DeviceCredentials | null {
  const filePath = deviceCredentialsPath(options);
  try {
    const raw = readSecureHostFileSync(filePath);
    return raw === null ? null : parseDeviceCredentials(raw);
  } catch (error) {
    asCredentialFileError(error);
  }
}

/**
 * Atomically replace the device credential pair with exact 0600 permissions.
 * If a credential already exists, its issuer is immutable until explicit
 * logout. This prevents a changed env/platform binding from exfiltrating the
 * rotating refresh token to another origin.
 */
export function writeDeviceCredentials(
  input: DeviceCredentialWriteInput,
  options: WriteDeviceCredentialsOptions = {},
): DeviceCredentials {
  const issuer = normalizeDeviceIssuer(input.issuer);
  if (
    !input.accessToken
    || !Number.isSafeInteger(input.accessExpiresAt)
    || input.accessExpiresAt <= 0
    || !input.refreshToken
    || !Number.isSafeInteger(input.deviceExp)
    || input.deviceExp <= 0
    || input.accessExpiresAt > input.deviceExp
  ) {
    throw new DeviceCredentialError('平台返回的设备凭证字段无效', 'invalid_file');
  }
  if (
    input.pendingRefreshRequestId !== undefined
    && !/^[a-zA-Z0-9._:-]{16,128}$/.test(input.pendingRefreshRequestId)
  ) {
    throw new DeviceCredentialError('设备续期 request ID 无效', 'invalid_file');
  }
  if (
    (input.pendingRefreshRequestId === undefined) !== (input.pendingRefreshStartedAt === undefined)
    || (input.pendingRefreshStartedAt !== undefined && (
      !Number.isSafeInteger(input.pendingRefreshStartedAt)
      || input.pendingRefreshStartedAt <= 0
    ))
    || (input.refreshRecoveryRequired !== undefined && input.refreshRecoveryRequired !== true)
    || (input.refreshRecoveryRequired === true && input.pendingRefreshRequestId !== undefined)
  ) {
    throw new DeviceCredentialError('设备续期恢复状态无效', 'invalid_file');
  }
  const filePath = deviceCredentialsPath(options);
  const current = readDeviceCredentials(options);
  if (current && current.issuer !== issuer) {
    throw new DeviceCredentialError(
      '已有设备凭证已固定到另一个平台；请先执行 botmux device logout，再重新注册',
      'issuer_mismatch',
    );
  }

  const credential: DeviceCredentials = {
    schemaVersion: DEVICE_CREDENTIAL_SCHEMA_VERSION,
    issuer,
    accessToken: input.accessToken,
    accessExpiresAt: input.accessExpiresAt,
    refreshToken: input.refreshToken,
    deviceExp: input.deviceExp,
    savedAt: (options.now ?? (() => new Date()))().toISOString(),
    ...(input.pendingRefreshRequestId
      ? { pendingRefreshRequestId: input.pendingRefreshRequestId }
      : {}),
    ...(input.pendingRefreshStartedAt !== undefined
      ? { pendingRefreshStartedAt: input.pendingRefreshStartedAt }
      : {}),
    ...(input.refreshRecoveryRequired === true ? { refreshRecoveryRequired: true as const } : {}),
  };
  try {
    writeSecureHostFileSync(filePath, `${JSON.stringify(credential, null, 2)}\n`);
  } catch (error) {
    asCredentialFileError(error);
  }
  return credential;
}

/** Delete only the local credential file. Server-side revocation is separate. */
export function clearDeviceCredentials(options: DeviceCredentialPathOptions = {}): boolean {
  const filePath = deviceCredentialsPath(options);
  try {
    return unlinkSecureHostFileSync(filePath);
  } catch (error) {
    asCredentialFileError(error);
  }
}

export function readDevicePublicStatus(
  options: DeviceCredentialPathOptions = {},
): DevicePublicStatus {
  const credential = readDeviceCredentials(options);
  if (!credential) {
    return { schemaVersion: DEVICE_CREDENTIAL_SCHEMA_VERSION, enrolled: false };
  }
  return {
    schemaVersion: DEVICE_CREDENTIAL_SCHEMA_VERSION,
    enrolled: true,
    issuer: credential.issuer,
    deviceExp: credential.deviceExp,
    savedAt: credential.savedAt,
  };
}
