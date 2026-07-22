/**
 * Platform-neutral desktop enrollment protocol client.
 *
 * The platform origin is supplied at runtime by platform.json and is pinned by
 * device.ts. No deployment hostname belongs in the open-source client. Tokens
 * are carried only in an Authorization header or JSON request body; this module
 * never logs, formats, or places them in URLs.
 */
import { randomBytes } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { withFileLock } from '../utils/file-lock.js';
import {
  clearDeviceCredentials,
  DeviceCredentialError,
  deviceCredentialsPath,
  normalizeDeviceIssuer,
  readDeviceCredentials,
  writeDeviceCredentials,
  type DeviceCredentialPathOptions,
  type DeviceCredentials,
} from './device.js';
import {
  readSecureHostFileSync,
  unlinkSecureHostFileSync,
  writeSecureHostFileSync,
} from './secure-host-file.js';

export const DEVICE_ENROLL_ENDPOINTS = Object.freeze({
  begin: '/api/devices/enroll',
  poll: '/api/devices/enroll/poll',
  refresh: '/api/devices/refresh',
});

export interface DeviceEnrollEndpoints {
  begin: string;
  poll: string;
  refresh: string;
}

/**
 * Wire contract consumed by the open client. The closed-source server owns
 * implementation details but must return these fields before the CLI is
 * enabled end-to-end.
 */
export interface DeviceEnrollmentGrant {
  grantId: string;
  pollSecret: string;
  /** Absolute grant expiry as Unix epoch ms. */
  expiresAt: number;
  /** Server-requested minimum polling delay. Optional; Retry-After also works. */
  pollIntervalMs?: number;
}

export interface DeviceTokenPair {
  accessToken: string;
  /** Absolute access-token expiry as Unix epoch ms; used for proactive lease renewal. */
  accessExpiresAt: number;
  refreshToken: string;
  /** Absolute device expiry as Unix epoch ms. */
  deviceExp: number;
}

export type DeviceEnrollmentPoll =
  | { kind: 'pending'; retryAfterMs: number }
  | { kind: 'issued'; credentials: DeviceTokenPair }
  | { kind: 'denied' }
  | { kind: 'expired' };

export interface DeviceEnrollmentApi {
  readonly issuer: string;
  beginEnrollment(input: BeginDeviceEnrollmentInput): Promise<DeviceEnrollmentGrant>;
  waitForEnrollment(
    grant: DeviceEnrollmentGrant,
    options?: WaitForDeviceEnrollmentOptions,
  ): Promise<DeviceTokenPair>;
}

export interface BeginDeviceEnrollmentInput {
  machineToken: string;
  deviceName: string;
  deviceKind?: 'desktop-ide';
  signal?: AbortSignal;
}

export interface WaitForDeviceEnrollmentOptions {
  /** Local upper bound; server grant expiry can shorten it. Defaults to 5min. */
  timeoutMs?: number;
  signal?: AbortSignal;
  onPending?: () => void;
}

export interface RefreshDeviceOptions {
  /** Durable idempotency key; required by the safe stored-refresh path. */
  requestId: string;
  signal?: AbortSignal;
}

export interface StoredDeviceRefreshOptions extends DeviceCredentialPathOptions {
  signal?: AbortSignal;
  now?: () => Date;
  requestIdFactory?: () => string;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  createClient?: (issuer: string) => Pick<DeviceEnrollmentClient, 'issuer' | 'refresh'>;
}

export interface StoredDeviceMutationOptions extends DeviceCredentialPathOptions {
  now?: () => Date;
}

const REFRESH_REPLAY_WINDOW_MS = 60_000;
// Leave transport/scheduler jitter before the server's hard replay boundary.
const REFRESH_SAFE_REPLAY_WINDOW_MS = 50_000;
const REFRESH_RETRY_DELAYS_MS = [250, 750] as const;
const REFRESH_TRANSIENT_HTTP_STATUSES = new Set([408, 425, 429]);

export interface DeviceHttpRequest {
  url: string;
  method: 'POST';
  headers: Readonly<Record<string, string>>;
  body: unknown;
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface DeviceHttpResponse {
  status: number;
  body: unknown;
  /** Header names must be lowercase. */
  headers?: Readonly<Record<string, string | undefined>>;
}

export type DeviceHttpTransport = (request: DeviceHttpRequest) => Promise<DeviceHttpResponse>;

export interface DeviceEnrollmentClientOptions {
  transport?: DeviceHttpTransport;
  endpoints?: Partial<DeviceEnrollEndpoints>;
  timeoutMs?: number;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export class DeviceProtocolError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'network_error'
      | 'invalid_response'
      | 'request_rejected'
      | 'enrollment_timeout'
      | 'enrollment_denied'
      | 'enrollment_expired'
      | 'aborted',
    readonly status?: number,
    readonly serverCode?: DeviceProtocolServerCode,
    /** Parsed and bounded Retry-After delay for a transient HTTP response. */
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'DeviceProtocolError';
  }
}

export type DeviceProtocolServerCode =
  | 'bad_request'
  | 'invalid_refresh'
  | 'device_gone'
  | 'device_revoked'
  | 'device_expired'
  | 'recovery_required'
  | 'refresh_in_progress'
  | 'store_unavailable';

const DEVICE_PROTOCOL_SERVER_CODES = new Set<DeviceProtocolServerCode>([
  'bad_request',
  'invalid_refresh',
  'device_gone',
  'device_revoked',
  'device_expired',
  'recovery_required',
  'refresh_in_progress',
  'store_unavailable',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function parseBoundedRetryAfterMs(
  response: DeviceHttpResponse,
  nowMs: number,
  maxMs = REFRESH_SAFE_REPLAY_WINDOW_MS,
): number | undefined {
  const raw = response.headers?.['retry-after']?.trim();
  if (!raw) return undefined;
  if (/^\d+$/.test(raw)) {
    const seconds = Number(raw);
    if (!Number.isFinite(seconds)) return maxMs;
    return Math.min(maxMs, seconds * 1_000);
  }
  const retryAt = Date.parse(raw);
  if (!Number.isFinite(retryAt)) return undefined;
  return Math.min(maxMs, Math.max(0, retryAt - nowMs));
}

function rejected(
  response: DeviceHttpResponse,
  operation: string,
  nowMs = Date.now(),
): DeviceProtocolError {
  // Do not reflect response bodies: a misbehaving server/proxy may echo a
  // machine bearer, poll secret, or rotating refresh token in its details.
  const rawCode = isRecord(response.body) ? response.body.error : undefined;
  const candidate = typeof rawCode === 'string'
    && DEVICE_PROTOCOL_SERVER_CODES.has(rawCode as DeviceProtocolServerCode)
    ? rawCode as DeviceProtocolServerCode
    : undefined;
  // Status is part of the signed protocol contract. In particular, a proxy's
  // transient 429/5xx body must not trick the client into clearing or
  // permanently blocking a still-valid refresh credential.
  const serverCode = candidate && (
    (response.status === 400 && candidate === 'bad_request')
    || (response.status === 401 && (
      candidate === 'invalid_refresh'
      || candidate === 'device_gone'
      || candidate === 'device_revoked'
      || candidate === 'device_expired'
      || candidate === 'recovery_required'
    ))
    || (response.status === 409 && candidate === 'refresh_in_progress')
    || (response.status === 503 && candidate === 'store_unavailable')
  ) ? candidate : undefined;
  return new DeviceProtocolError(
    `${operation}被平台拒绝：HTTP ${response.status}`,
    'request_rejected',
    response.status,
    serverCode,
    response.status === 429 ? parseBoundedRetryAfterMs(response, nowMs) : undefined,
  );
}

function requiredString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function optionalFiniteNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function parseGrant(body: unknown): DeviceEnrollmentGrant {
  if (!isRecord(body)) {
    throw new DeviceProtocolError('平台注册响应结构无效', 'invalid_response');
  }
  const grantId = requiredString(body, 'grantId');
  const pollSecret = requiredString(body, 'pollSecret');
  const expiresAt = optionalFiniteNumber(body, 'expiresAt');
  if (!grantId || !pollSecret || expiresAt === undefined) {
    throw new DeviceProtocolError('平台注册响应缺少 grantId、pollSecret 或 expiresAt', 'invalid_response');
  }
  return {
    grantId,
    pollSecret,
    expiresAt,
    ...(optionalFiniteNumber(body, 'pollIntervalMs') !== undefined
      ? { pollIntervalMs: optionalFiniteNumber(body, 'pollIntervalMs') }
      : {}),
  };
}

function parseTokenPair(body: unknown): DeviceTokenPair {
  if (!isRecord(body)) {
    throw new DeviceProtocolError('平台凭证响应结构无效', 'invalid_response');
  }
  const accessToken = requiredString(body, 'accessToken');
  const accessExpiresAt = optionalFiniteNumber(body, 'accessExpiresAt');
  const refreshToken = requiredString(body, 'refreshToken');
  const deviceExp = optionalFiniteNumber(body, 'deviceExp');
  if (
    !accessToken
    || accessExpiresAt === undefined
    || !refreshToken
    || deviceExp === undefined
    || accessExpiresAt > deviceExp
  ) {
    throw new DeviceProtocolError('平台凭证响应缺少必要字段', 'invalid_response');
  }
  return { accessToken, accessExpiresAt, refreshToken, deviceExp };
}

function retryAfterMs(response: DeviceHttpResponse): number {
  const raw = response.headers?.['retry-after'];
  if (raw && /^\d+$/.test(raw.trim())) {
    return Math.min(10_000, Math.max(1_000, Number(raw) * 1_000));
  }
  if (isRecord(response.body)) {
    const fromBody = optionalFiniteNumber(response.body, 'retryAfterMs');
    if (fromBody !== undefined) return Math.min(10_000, Math.max(1_000, fromBody));
    const pollInterval = optionalFiniteNumber(response.body, 'pollIntervalMs');
    if (pollInterval !== undefined) return Math.min(10_000, Math.max(1_000, pollInterval));
  }
  return 2_000;
}

function abortError(): DeviceProtocolError {
  return new DeviceProtocolError('设备注册已取消', 'aborted');
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const finish = () => {
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(abortError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Small JSON transport with a bounded response and no redirect following.
 * Redirects are surfaced as a rejection so a bearer can never cross origins.
 */
export const nodeDeviceHttpTransport: DeviceHttpTransport = async (input) => {
  const url = new URL(input.url);
  const requestFn = url.protocol === 'https:' ? httpsRequest : httpRequest;
  const payload = Buffer.from(JSON.stringify(input.body), 'utf8');
  return await new Promise<DeviceHttpResponse>((resolve, reject) => {
    const req = requestFn({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || undefined,
      path: `${url.pathname}${url.search}`,
      method: input.method,
      timeout: input.timeoutMs,
      signal: input.signal,
      headers: {
        ...input.headers,
        'content-type': 'application/json',
        'content-length': String(payload.length),
        accept: 'application/json',
      },
    }, (response) => {
      const chunks: Buffer[] = [];
      let size = 0;
      response.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > 64 * 1024) {
          response.destroy(new Error('device response too large'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => {
        let body: unknown = {};
        const raw = Buffer.concat(chunks).toString('utf8');
        if (raw) {
          try {
            body = JSON.parse(raw);
          } catch {
            body = {};
          }
        }
        const headers: Record<string, string | undefined> = {};
        for (const [key, value] of Object.entries(response.headers)) {
          headers[key.toLowerCase()] = Array.isArray(value) ? value.join(', ') : value;
        }
        resolve({ status: response.statusCode ?? 0, body, headers });
      });
      response.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('device request timeout')));
    req.on('error', reject);
    req.end(payload);
  });
};

export class DeviceEnrollmentClient {
  readonly issuer: string;
  private readonly transport: DeviceHttpTransport;
  private readonly endpoints: DeviceEnrollEndpoints;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;

  constructor(issuer: string, options: DeviceEnrollmentClientOptions = {}) {
    this.issuer = normalizeDeviceIssuer(issuer);
    this.transport = options.transport ?? nodeDeviceHttpTransport;
    const requestedEndpoints = { ...DEVICE_ENROLL_ENDPOINTS, ...options.endpoints };
    this.endpoints = {
      begin: this.normalizeEndpoint(requestedEndpoints.begin),
      poll: this.normalizeEndpoint(requestedEndpoints.poll),
      refresh: this.normalizeEndpoint(requestedEndpoints.refresh),
    };
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? defaultSleep;
  }

  private normalizeEndpoint(endpoint: string): string {
    if (
      !endpoint.startsWith('/')
      || endpoint.startsWith('//')
      || endpoint.includes('\\')
      || endpoint.includes('?')
      || endpoint.includes('#')
    ) {
      throw new DeviceProtocolError('设备协议 endpoint 必须是同源绝对路径', 'invalid_response');
    }
    let resolved: URL;
    try {
      resolved = new URL(endpoint, `${this.issuer}/`);
    } catch {
      throw new DeviceProtocolError('设备协议 endpoint 无效', 'invalid_response');
    }
    if (
      resolved.origin !== this.issuer
      || resolved.username
      || resolved.password
      || resolved.search
      || resolved.hash
    ) {
      throw new DeviceProtocolError('设备协议 endpoint 必须保持同源', 'invalid_response');
    }
    return resolved.pathname;
  }

  private async post(
    path: string,
    body: unknown,
    headers: Readonly<Record<string, string>> = {},
    signal?: AbortSignal,
  ): Promise<DeviceHttpResponse> {
    if (signal?.aborted) throw abortError();
    try {
      const resolved = new URL(path, `${this.issuer}/`);
      // Defense in depth: endpoint configuration is validated in the
      // constructor, but a bearer must never leave the pinned issuer even if a
      // future refactor routes another path through this helper.
      if (resolved.origin !== this.issuer || resolved.username || resolved.password || resolved.hash) {
        throw new DeviceProtocolError('设备协议请求试图离开固定平台 origin', 'invalid_response');
      }
      return await this.transport({
        url: resolved.toString(),
        method: 'POST',
        headers,
        body,
        timeoutMs: this.timeoutMs,
        signal,
      });
    } catch (err) {
      if (signal?.aborted || (err instanceof DeviceProtocolError && err.code === 'aborted')) {
        throw abortError();
      }
      if (err instanceof DeviceProtocolError) throw err;
      // Raw socket errors can contain host details but never need to contain a
      // credential; still replace them with a stable, non-reflective message.
      throw new DeviceProtocolError('无法连接设备平台', 'network_error');
    }
  }

  async beginEnrollment(input: BeginDeviceEnrollmentInput): Promise<DeviceEnrollmentGrant> {
    if (!input.machineToken || !input.deviceName.trim()) {
      throw new DeviceProtocolError('缺少机器凭证或设备名', 'invalid_response');
    }
    const response = await this.post(
      this.endpoints.begin,
      {
        deviceKind: input.deviceKind ?? 'desktop-ide',
        deviceName: input.deviceName.trim(),
      },
      { authorization: `Bearer ${input.machineToken}` },
      input.signal,
    );
    if (response.status < 200 || response.status >= 300) throw rejected(response, '设备注册');
    return parseGrant(response.body);
  }

  async pollEnrollment(
    grant: Pick<DeviceEnrollmentGrant, 'grantId' | 'pollSecret'>,
    signal?: AbortSignal,
  ): Promise<DeviceEnrollmentPoll> {
    const response = await this.post(
      this.endpoints.poll,
      { grantId: grant.grantId, pollSecret: grant.pollSecret },
      {},
      signal,
    );
    if (response.status === 202 || response.status === 204) {
      return { kind: 'pending', retryAfterMs: retryAfterMs(response) };
    }
    if (response.status < 200 || response.status >= 300) throw rejected(response, '设备确认');
    if (isRecord(response.body)) {
      if (response.body.status === 'pending') {
        return { kind: 'pending', retryAfterMs: retryAfterMs(response) };
      }
      if (response.body.status === 'denied') return { kind: 'denied' };
      if (response.body.status === 'expired') return { kind: 'expired' };
      if (response.body.status === 'issued') {
        return { kind: 'issued', credentials: parseTokenPair(response.body) };
      }
    }
    // Compatibility with a staged server that returned the token pair without
    // an explicit status discriminator.
    return { kind: 'issued', credentials: parseTokenPair(response.body) };
  }

  async waitForEnrollment(
    grant: DeviceEnrollmentGrant,
    options: WaitForDeviceEnrollmentOptions = {},
  ): Promise<DeviceTokenPair> {
    const localDeadline = this.now() + (options.timeoutMs ?? 5 * 60_000);
    const deadline = Math.min(localDeadline, grant.expiresAt);
    let nextDelay = Math.min(10_000, Math.max(1_000, grant.pollIntervalMs ?? 2_000));
    while (this.now() < deadline) {
      const result = await this.pollEnrollment(grant, options.signal);
      if (result.kind === 'issued') return result.credentials;
      if (result.kind === 'denied') {
        throw new DeviceProtocolError('设备注册已被 owner 拒绝', 'enrollment_denied');
      }
      if (result.kind === 'expired') {
        throw new DeviceProtocolError('设备确认已过期，请重新执行注册', 'enrollment_expired');
      }
      options.onPending?.();
      nextDelay = Math.max(nextDelay, result.retryAfterMs);
      const remaining = deadline - this.now();
      if (remaining <= 0) break;
      await this.sleep(Math.min(nextDelay, remaining), options.signal);
    }
    throw new DeviceProtocolError('设备确认已超时，请重新执行注册', 'enrollment_timeout');
  }

  /**
   * Send one refresh attempt. The stored-credential coordinator performs
   * bounded same-key retries for ambiguous failures inside the replay window;
   * keeping retry policy outside this wire primitive also keeps direct callers
   * from accidentally retrying with a new key.
   */
  async refresh(refreshToken: string, options: RefreshDeviceOptions): Promise<DeviceTokenPair> {
    if (!refreshToken) throw new DeviceProtocolError('缺少 refresh token', 'invalid_response');
    if (!/^[a-zA-Z0-9._:-]{16,128}$/.test(options.requestId)) {
      throw new DeviceProtocolError('设备续期 request ID 无效', 'invalid_response');
    }
    const response = await this.post(
      this.endpoints.refresh,
      { refreshToken },
      { 'idempotency-key': options.requestId },
      options.signal,
    );
    if (response.status === 409) {
      throw new DeviceProtocolError(
        '设备续期请求无法安全重放；请重新注册，或先在平台确认设备是否已被吊销',
        'request_rejected',
        response.status,
        'refresh_in_progress',
      );
    }
    if (response.status < 200 || response.status >= 300) {
      throw rejected(response, '设备续期', this.now());
    }
    return parseTokenPair(response.body);
  }
}

export { DEVICE_ENROLLMENT_JOURNAL_FILE } from './device-paths.js';
import { DEVICE_ENROLLMENT_JOURNAL_FILE } from './device-paths.js';
const DEVICE_ENROLLMENT_JOURNAL_SCHEMA_VERSION = 1 as const;

interface DeviceEnrollmentJournal {
  schemaVersion: typeof DEVICE_ENROLLMENT_JOURNAL_SCHEMA_VERSION;
  issuer: string;
  grantId: string;
  pollSecret: string;
  expiresAt: number;
  pollIntervalMs?: number;
  deviceName: string;
  createdAt: number;
}

export interface StoredDeviceEnrollmentOptions extends StoredDeviceMutationOptions {
  client: DeviceEnrollmentApi;
  machineToken: string;
  deviceName: string;
  signal?: AbortSignal;
  onPending?: () => void;
  onGrantReady?: () => void;
}

export function deviceEnrollmentJournalPath(
  options: DeviceCredentialPathOptions = {},
): string {
  return join(dirname(deviceCredentialsPath(options)), DEVICE_ENROLLMENT_JOURNAL_FILE);
}

function parseDeviceEnrollmentJournal(raw: string): DeviceEnrollmentJournal {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new DeviceCredentialError('设备注册恢复日志已损坏', 'invalid_file');
  }
  if (!isRecord(value)) {
    throw new DeviceCredentialError('设备注册恢复日志结构无效', 'invalid_file');
  }
  const issuer = typeof value.issuer === 'string' ? normalizeDeviceIssuer(value.issuer) : '';
  if (
    value.schemaVersion !== DEVICE_ENROLLMENT_JOURNAL_SCHEMA_VERSION
    || issuer !== value.issuer
    || typeof value.grantId !== 'string'
    || !/^[a-zA-Z0-9._:-]{1,128}$/.test(value.grantId)
    || typeof value.pollSecret !== 'string'
    || value.pollSecret.length < 1
    || value.pollSecret.length > 512
    || typeof value.expiresAt !== 'number'
    || !Number.isSafeInteger(value.expiresAt)
    || value.expiresAt <= 0
    || (value.pollIntervalMs !== undefined && (
      typeof value.pollIntervalMs !== 'number'
      || !Number.isSafeInteger(value.pollIntervalMs)
      || value.pollIntervalMs <= 0
    ))
    || typeof value.deviceName !== 'string'
    || !value.deviceName
    || value.deviceName.length > 80
    || typeof value.createdAt !== 'number'
    || !Number.isSafeInteger(value.createdAt)
    || value.createdAt <= 0
    || value.createdAt > value.expiresAt
  ) {
    throw new DeviceCredentialError('设备注册恢复日志字段无效', 'invalid_file');
  }
  return {
    schemaVersion: DEVICE_ENROLLMENT_JOURNAL_SCHEMA_VERSION,
    issuer,
    grantId: value.grantId,
    pollSecret: value.pollSecret,
    expiresAt: value.expiresAt,
    ...(typeof value.pollIntervalMs === 'number' ? { pollIntervalMs: value.pollIntervalMs } : {}),
    deviceName: value.deviceName,
    createdAt: value.createdAt,
  };
}

function readDeviceEnrollmentJournal(
  options: DeviceCredentialPathOptions,
): DeviceEnrollmentJournal | null {
  const raw = readSecureHostFileSync(deviceEnrollmentJournalPath(options));
  return raw === null ? null : parseDeviceEnrollmentJournal(raw);
}

function writeDeviceEnrollmentJournal(
  journal: DeviceEnrollmentJournal,
  options: DeviceCredentialPathOptions,
): void {
  writeSecureHostFileSync(
    deviceEnrollmentJournalPath(options),
    `${JSON.stringify(journal, null, 2)}\n`,
  );
}

function clearDeviceEnrollmentJournal(options: DeviceCredentialPathOptions): boolean {
  return unlinkSecureHostFileSync(deviceEnrollmentJournalPath(options));
}

function sameGrant(
  left: Pick<DeviceEnrollmentJournal, 'grantId' | 'pollSecret'>,
  right: Pick<DeviceEnrollmentJournal, 'grantId' | 'pollSecret'>,
): boolean {
  return left.grantId === right.grantId && left.pollSecret === right.pollSecret;
}

/**
 * Crash-safe F1 enrollment coordinator.
 *
 * The grant/poll secret is durably journaled before polling. A later host
 * process resumes the same grant, and an issued response is installed together
 * with journal cleanup under the same device lock.
 */
export async function enrollStoredDeviceCredentials(
  options: StoredDeviceEnrollmentOptions,
): Promise<DeviceCredentials> {
  const pathOptions: DeviceCredentialPathOptions = {
    ...(options.homeDir !== undefined ? { homeDir: options.homeDir } : {}),
    ...(options.filePath !== undefined ? { filePath: options.filePath } : {}),
  };
  const filePath = deviceCredentialsPath(pathOptions);
  mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
  const now = () => (options.now ?? (() => new Date()))().getTime();

  let journal = await withFileLock(filePath, async () => {
    if (readDeviceCredentials(pathOptions)) {
      throw new DeviceCredentialError('本机已有 desktop device 凭证', 'invalid_file');
    }
    const existing = readDeviceEnrollmentJournal(pathOptions);
    if (!existing) return null;
    if (existing.expiresAt <= now()) {
      clearDeviceEnrollmentJournal(pathOptions);
      return null;
    }
    if (existing.issuer !== normalizeDeviceIssuer(options.client.issuer)) {
      throw new DeviceCredentialError(
        '未完成的设备注册已固定到另一个平台；请等待其过期或执行 logout 清理',
        'issuer_mismatch',
      );
    }
    return existing;
  }, { maxWaitMs: 15_000 });

  if (!journal) {
    const grant = await options.client.beginEnrollment({
      machineToken: options.machineToken,
      deviceName: options.deviceName,
      deviceKind: 'desktop-ide',
      signal: options.signal,
    });
    if (grant.expiresAt <= now()) {
      throw new DeviceProtocolError('平台返回的设备 grant 已过期', 'invalid_response');
    }
    const proposed: DeviceEnrollmentJournal = {
      schemaVersion: DEVICE_ENROLLMENT_JOURNAL_SCHEMA_VERSION,
      issuer: normalizeDeviceIssuer(options.client.issuer),
      grantId: grant.grantId,
      pollSecret: grant.pollSecret,
      expiresAt: grant.expiresAt,
      ...(grant.pollIntervalMs !== undefined ? { pollIntervalMs: grant.pollIntervalMs } : {}),
      deviceName: options.deviceName,
      createdAt: now(),
    };
    journal = await withFileLock(filePath, async () => {
      if (readDeviceCredentials(pathOptions)) {
        throw new DeviceCredentialError('并发设备注册已完成；未覆盖现有凭证', 'invalid_file');
      }
      const existing = readDeviceEnrollmentJournal(pathOptions);
      if (existing && existing.expiresAt > now()) {
        if (existing.issuer !== proposed.issuer) {
          throw new DeviceCredentialError('并发设备注册的平台不一致', 'issuer_mismatch');
        }
        return existing;
      }
      if (existing) clearDeviceEnrollmentJournal(pathOptions);
      writeDeviceEnrollmentJournal(proposed, pathOptions);
      return proposed;
    }, { maxWaitMs: 15_000 });
  }

  let credentials: DeviceTokenPair;
  options.onGrantReady?.();
  try {
    credentials = await options.client.waitForEnrollment({
      grantId: journal.grantId,
      pollSecret: journal.pollSecret,
      expiresAt: journal.expiresAt,
      ...(journal.pollIntervalMs !== undefined ? { pollIntervalMs: journal.pollIntervalMs } : {}),
    }, {
      signal: options.signal,
      onPending: options.onPending,
      timeoutMs: Math.max(1, journal.expiresAt - now()),
    });
  } catch (error) {
    if (
      error instanceof DeviceProtocolError
      && (error.code === 'enrollment_denied'
        || error.code === 'enrollment_expired'
        || error.code === 'enrollment_timeout')
    ) {
      await withFileLock(filePath, async () => {
        const latest = readDeviceEnrollmentJournal(pathOptions);
        if (latest && sameGrant(latest, journal!)) clearDeviceEnrollmentJournal(pathOptions);
      }, { maxWaitMs: 15_000 });
    }
    throw error;
  }

  return await withFileLock(filePath, async () => {
    const existingDevice = readDeviceCredentials(pathOptions);
    if (existingDevice) {
      // A concurrent poll of this same durable grant already installed the
      // server-identical token bytes. Preserve its local savedAt and finish.
      const latestJournal = readDeviceEnrollmentJournal(pathOptions);
      if (latestJournal && sameGrant(latestJournal, journal!)) {
        clearDeviceEnrollmentJournal(pathOptions);
      }
      return existingDevice;
    }
    const latestJournal = readDeviceEnrollmentJournal(pathOptions);
    if (!latestJournal || !sameGrant(latestJournal, journal!)) {
      throw new DeviceCredentialError('设备注册恢复日志已被另一个流程替换', 'invalid_file');
    }
    const stored = writeDeviceCredentials(
      { issuer: journal!.issuer, ...credentials },
      { ...pathOptions, ...(options.now ? { now: options.now } : {}) },
    );
    clearDeviceEnrollmentJournal(pathOptions);
    return stored;
  }, { maxWaitMs: 15_000 });
}

function refreshNowMs(options: Pick<StoredDeviceRefreshOptions, 'now'>): number {
  return (options.now ?? (() => new Date()))().getTime();
}

function generateRefreshRequestId(): string {
  // 128 random bits, encoded without padding for the HTTP header.
  return randomBytes(16).toString('base64url');
}

function refreshErrorIsAmbiguousRetryable(error: unknown): boolean {
  return error instanceof DeviceProtocolError && (
    error.code === 'network_error'
    || error.code === 'invalid_response'
    || (error.code === 'request_rejected' && (error.status ?? 0) >= 500)
    || (error.code === 'request_rejected'
      && error.status !== undefined
      && REFRESH_TRANSIENT_HTTP_STATUSES.has(error.status))
  );
}

function refreshErrorRequiresLocalClear(error: unknown): boolean {
  if (!(error instanceof DeviceProtocolError)) return false;
  // A status-bearing transport response takes precedence over an inconsistent
  // body/code supplied by a proxy or custom transport.
  if (error.status !== undefined && error.status !== 401) return false;
  return (
    error.serverCode === 'device_gone'
    || error.serverCode === 'device_revoked'
    || error.serverCode === 'device_expired'
    || error.serverCode === 'recovery_required'
  );
}

function refreshErrorRequiresRecoveryBlock(error: unknown): boolean {
  if (!(error instanceof DeviceProtocolError)) return false;
  if (error.status !== undefined && (
    error.status >= 500
    || error.status === 409
    || REFRESH_TRANSIENT_HTTP_STATUSES.has(error.status)
  )) return false;
  return (
    error.serverCode === 'invalid_refresh'
    || error.serverCode === 'bad_request'
    || (error.code === 'request_rejected'
      && error.status !== undefined
      && error.status >= 400
      && error.status < 500)
  );
}

function writeRefreshRecoveryRequired(
  current: DeviceCredentials,
  pathOptions: DeviceCredentialPathOptions,
  now?: () => Date,
): DeviceCredentials {
  return writeDeviceCredentials({
    issuer: current.issuer,
    accessToken: current.accessToken,
    accessExpiresAt: current.accessExpiresAt,
    refreshToken: current.refreshToken,
    deviceExp: current.deviceExp,
    refreshRecoveryRequired: true,
  }, { ...pathOptions, ...(now ? { now } : {}) });
}

async function refreshWithBoundedReplay(
  client: Pick<DeviceEnrollmentClient, 'refresh'>,
  current: DeviceCredentials,
  requestId: string,
  startedAt: number,
  options: StoredDeviceRefreshOptions,
): Promise<DeviceTokenPair> {
  const sleep = options.sleep ?? defaultSleep;
  let attempt = 0;
  while (true) {
    try {
      return await client.refresh(current.refreshToken, {
        requestId,
        signal: options.signal,
      });
    } catch (error) {
      const baseDelay = REFRESH_RETRY_DELAYS_MS[attempt];
      const delay = baseDelay === undefined
        ? undefined
        : Math.max(
            baseDelay,
            error instanceof DeviceProtocolError && error.status === 429
              ? (error.retryAfterMs ?? 0)
              : 0,
          );
      const retryDeadline = startedAt + REFRESH_SAFE_REPLAY_WINDOW_MS;
      if (
        delay === undefined
        || !refreshErrorIsAmbiguousRetryable(error)
        || options.signal?.aborted
        || refreshNowMs(options) + delay >= retryDeadline
      ) {
        throw error;
      }
      attempt += 1;
      await sleep(delay, options.signal);
    }
  }
}

/** Serialize logout with refresh/install so a completed refresh cannot revive it. */
export async function clearStoredDeviceCredentials(
  options: DeviceCredentialPathOptions = {},
): Promise<boolean> {
  const filePath = deviceCredentialsPath(options);
  mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
  return await withFileLock(
    filePath,
    async () => {
      const removed = clearDeviceCredentials(options);
      clearDeviceEnrollmentJournal(options);
      return removed;
    },
    { maxWaitMs: 45_000 },
  );
}

/**
 * Safely rotate the stored refresh token across host processes.
 *
 * The file lock covers the complete prewrite → HTTP → replacement sequence.
 * The idempotency key is persisted before any network I/O and is retained on
 * every failure, including process death, so the next call replays the exact
 * same server operation. A waiter that observed the old token returns the
 * winner's new credential instead of performing a second rotation.
 */
/** Max foreign-journal follow hops. Multi-process journal handoff should
 * converge in one hop; a small bound blocks theoretical refresh ping-pong. */
const MAX_FOREIGN_JOURNAL_DEPTH = 2;

export async function refreshStoredDeviceCredentials(
  options: StoredDeviceRefreshOptions = {},
  foreignJournalDepth = 0,
): Promise<DeviceCredentials> {
  const pathOptions: DeviceCredentialPathOptions = {
    ...(options.homeDir !== undefined ? { homeDir: options.homeDir } : {}),
    ...(options.filePath !== undefined ? { filePath: options.filePath } : {}),
  };
  const observed = readDeviceCredentials(pathOptions);
  if (!observed) {
    throw new DeviceCredentialError('本机没有 desktop device 凭证，请先注册', 'invalid_file');
  }
  const filePath = deviceCredentialsPath(pathOptions);
  const outcome = await withFileLock(filePath, async (): Promise<
    | { kind: 'credentials'; value: DeviceCredentials }
    | {
        kind: 'conflict';
        original: DeviceCredentials;
        requestId: string;
        error: DeviceProtocolError;
      }
  > => {
    const current = readDeviceCredentials(pathOptions);
    if (!current) {
      throw new DeviceCredentialError('本机设备凭证已被移除', 'invalid_file');
    }
    // Another caller completed a rotation while this process waited. Returning
    // its result is the cross-process single-flight outcome.
    if (current.refreshToken !== observed.refreshToken || current.issuer !== observed.issuer) {
      return { kind: 'credentials', value: current };
    }

    if (current.refreshRecoveryRequired) {
      throw new DeviceCredentialError(
        '设备续期状态需要人工恢复；请先确认平台设备状态，再 logout/re-enroll',
        'invalid_file',
      );
    }

    const requestId = current.pendingRefreshRequestId
      ?? (options.requestIdFactory ?? generateRefreshRequestId)();
    if (!/^[a-zA-Z0-9._:-]{16,128}$/.test(requestId)) {
      throw new DeviceProtocolError('设备续期 request ID 无效', 'invalid_response');
    }
    const startedAt = current.pendingRefreshStartedAt ?? refreshNowMs(options);
    if (current.pendingRefreshRequestId && (
      refreshNowMs(options) - startedAt >= REFRESH_SAFE_REPLAY_WINDOW_MS
      || refreshNowMs(options) - startedAt < 0
    )) {
      writeRefreshRecoveryRequired(current, pathOptions, options.now);
      throw new DeviceCredentialError(
        `设备续期丢响应已超过安全恢复窗口（服务端窗口 ${REFRESH_REPLAY_WINDOW_MS}ms）；已停止重发，请重新注册`,
        'invalid_file',
      );
    }
    if (!current.pendingRefreshRequestId) {
      writeDeviceCredentials({
        issuer: current.issuer,
        accessToken: current.accessToken,
        accessExpiresAt: current.accessExpiresAt,
        refreshToken: current.refreshToken,
        deviceExp: current.deviceExp,
        pendingRefreshRequestId: requestId,
        pendingRefreshStartedAt: startedAt,
      }, {
        ...pathOptions,
        ...(options.now ? { now: options.now } : {}),
      });
    }

    const client = (options.createClient ?? ((issuer: string) => new DeviceEnrollmentClient(issuer)))(
      current.issuer,
    );
    if (normalizeDeviceIssuer(client.issuer) !== current.issuer) {
      throw new DeviceCredentialError('设备续期客户端 issuer 与已固定平台不一致', 'issuer_mismatch');
    }
    try {
      const rotated = await refreshWithBoundedReplay(client, current, requestId, startedAt, options);
      return {
        kind: 'credentials',
        value: writeDeviceCredentials({ issuer: current.issuer, ...rotated }, {
          ...pathOptions,
          ...(options.now ? { now: options.now } : {}),
        }),
      };
    } catch (error) {
      if (refreshErrorRequiresLocalClear(error)) {
        clearDeviceCredentials(pathOptions);
      } else if (refreshErrorRequiresRecoveryBlock(error)) {
        writeRefreshRecoveryRequired(current, pathOptions, options.now);
      } else if (
        error instanceof DeviceProtocolError
        && (error.status === 409 || error.serverCode === 'refresh_in_progress')
      ) {
        return { kind: 'conflict', original: current, requestId, error };
      }
      throw error;
    }
  }, { maxWaitMs: 45_000 });

  if (outcome.kind === 'credentials') return outcome.value;

  // A 409 names a different idempotency key. Release our lock so a legitimate
  // older/local winner can publish its file, then inspect exactly once. Never
  // send the losing old refresh again: after the server replay window that
  // would become replay_expired and revoke the device.
  await (options.sleep ?? defaultSleep)(250, options.signal);
  const reread = await withFileLock(filePath, async (): Promise<
    | { kind: 'credentials'; value: DeviceCredentials }
    | { kind: 'foreign_journal' }
    | { kind: 'blocked'; error: DeviceProtocolError }
  > => {
    const latest = readDeviceCredentials(pathOptions);
    if (
      latest
      && (latest.refreshToken !== outcome.original.refreshToken
        || latest.issuer !== outcome.original.issuer)
    ) {
      return { kind: 'credentials', value: latest };
    }
    if (
      latest?.pendingRefreshRequestId
      && latest.pendingRefreshRequestId !== outcome.requestId
    ) {
      // A newer local process durably journaled the server-winning key but
      // crashed before publishing the response. The normal refresh path will
      // replay exactly that journal once and converge on the same token bytes.
      return { kind: 'foreign_journal' };
    }
    if (latest) writeRefreshRecoveryRequired(latest, pathOptions, options.now);
    return { kind: 'blocked', error: outcome.error };
  }, { maxWaitMs: 15_000 });
  if (reread.kind === 'credentials') return reread.value;
  if (reread.kind === 'foreign_journal') {
    if (foreignJournalDepth >= MAX_FOREIGN_JOURNAL_DEPTH) {
      // Prevent endless multi-process journal thrash from replaying forever.
      const latest = readDeviceCredentials(pathOptions);
      if (latest) writeRefreshRecoveryRequired(latest, pathOptions, options.now);
      throw new DeviceProtocolError(
        `设备续期 journal 切换超过 ${MAX_FOREIGN_JOURNAL_DEPTH} 次仍未收敛；已停止自动续期，请重新注册`,
        'invalid_response',
      );
    }
    return await refreshStoredDeviceCredentials(options, foreignJournalDepth + 1);
  }
  throw new DeviceProtocolError(
    '检测到不同续期密钥且本地没有可恢复的赢家日志；设备凭证可能泄露。已停止自动续期，请立即在设备管理页吊销并重新注册',
    reread.error.code,
    reread.error.status,
    reread.error.serverCode,
  );
}
