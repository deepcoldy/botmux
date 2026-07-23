/** Host coordinator for the first, one-way device-credential activation. */
import { createHash, randomBytes } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname } from 'node:path';
import { DEVICE_ISOLATION_ACTIVATION_VERSION } from '../core/device-isolation-activation.js';
import { resolveBotmuxDataDir } from '../core/data-dir.js';
import { fetchDaemonIpc } from '../core/daemon-ipc-auth.js';
import { readProcessStartIdentity } from '../core/session-marker.js';
import {
  listOnlineDaemons,
  type OnlineDaemonInfo,
} from '../utils/daemon-discovery.js';
import {
  deviceCredentialIsolationMarkerPath,
} from '../adapters/cli/read-isolation.js';
import {
  completeDeviceCredentialIsolationMarker,
  ensureDeviceCredentialIsolationMarker,
  readDeviceCredentialIsolationMarker,
  type DeviceIsolationActivationOptions,
} from './device-isolation.js';
import {
  readSecureHostFileSync,
  writeSecureHostFileSync,
} from './secure-host-file.js';

const PREPARE_PATH = '/api/device-isolation/activation/prepare';
const COMMIT_PATH = '/api/device-isolation/activation/commit';
const RELEASE_PATH = '/api/device-isolation/activation/release';
const RESPONSE_LIMIT_BYTES = 64 * 1024;
const REQUEST_TIMEOUT_MS = 12_000;

export class DeviceIsolationDaemonActivationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DeviceIsolationDaemonActivationError';
  }
}

interface ActivationDaemonIdentity {
  larkAppId: string;
  bootInstanceId: string;
  pid: number;
  procStart: string;
  dataDir: string;
}

interface ActivationResponse {
  ok: true;
  activationVersion: typeof DEVICE_ISOLATION_ACTIVATION_VERSION;
  nonce: string;
  leaseId: string;
  expiresAt: number;
  inventoryGeneration: string;
  daemon: ActivationDaemonIdentity;
}

interface PreparedDaemon {
  descriptor: OnlineDaemonInfo;
  response: ActivationResponse;
}

export interface DeviceIsolationActivationClientDependencies {
  listDaemons?: () => OnlineDaemonInfo[];
  fetchDaemon?: typeof fetchDaemonIpc;
  processStart?: (pid: number) => string | undefined;
  nonceFactory?: () => string;
  expectedDataDir?: string;
  now?: () => Date;
}

export interface ActivateDeviceIsolationOptions extends DeviceIsolationActivationOptions {
  dependencies?: DeviceIsolationActivationClientDependencies;
}

function markerDigest(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex');
}

async function boundedJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    size += part.value.byteLength;
    if (size > RESPONSE_LIMIT_BYTES) {
      await reader.cancel();
      throw new DeviceIsolationDaemonActivationError('daemon 激活响应过大');
    }
    chunks.push(part.value);
  }
  const raw = Buffer.concat(chunks.map(chunk => Buffer.from(chunk))).toString('utf8');
  try { return JSON.parse(raw); }
  catch { throw new DeviceIsolationDaemonActivationError('daemon 激活响应不是有效 JSON'); }
}

function parseActivationResponse(value: unknown): ActivationResponse {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new DeviceIsolationDaemonActivationError('daemon 激活响应结构无效');
  }
  const record = value as Record<string, unknown>;
  const daemon = record.daemon;
  if (
    record.ok !== true
    || record.activationVersion !== DEVICE_ISOLATION_ACTIVATION_VERSION
    || typeof record.nonce !== 'string'
    || typeof record.leaseId !== 'string'
    || !record.leaseId
    || typeof record.expiresAt !== 'number'
    || !Number.isSafeInteger(record.expiresAt)
    || typeof record.inventoryGeneration !== 'string'
    || !record.inventoryGeneration
    || !daemon
    || typeof daemon !== 'object'
    || Array.isArray(daemon)
  ) {
    throw new DeviceIsolationDaemonActivationError('daemon 激活响应缺少必要字段');
  }
  const identity = daemon as Record<string, unknown>;
  if (
    typeof identity.larkAppId !== 'string'
    || !identity.larkAppId
    || typeof identity.bootInstanceId !== 'string'
    || !identity.bootInstanceId
    || typeof identity.pid !== 'number'
    || !Number.isSafeInteger(identity.pid)
    || identity.pid <= 1
    || typeof identity.procStart !== 'string'
    || !identity.procStart
    || typeof identity.dataDir !== 'string'
    || !identity.dataDir
  ) {
    throw new DeviceIsolationDaemonActivationError('daemon 激活身份字段无效');
  }
  return {
    ok: true,
    activationVersion: DEVICE_ISOLATION_ACTIVATION_VERSION,
    nonce: record.nonce,
    leaseId: record.leaseId,
    expiresAt: record.expiresAt,
    inventoryGeneration: record.inventoryGeneration,
    daemon: identity as unknown as ActivationDaemonIdentity,
  };
}

function canonicalExistingDirectory(path: string): string {
  try { return realpathSync(path); }
  catch {
    throw new DeviceIsolationDaemonActivationError(`无法解析 daemon 数据目录：${path}`);
  }
}

function verifyDaemonIdentity(
  descriptor: OnlineDaemonInfo,
  response: ActivationResponse,
  input: { nonce: string; expectedDataDir: string; processStart: (pid: number) => string | undefined },
): void {
  const daemon = response.daemon;
  if (
    response.nonce !== input.nonce
    || descriptor.larkAppId !== daemon.larkAppId
    || !descriptor.bootInstanceId
    || descriptor.bootInstanceId !== daemon.bootInstanceId
    || descriptor.pid !== daemon.pid
    || input.processStart(daemon.pid) !== daemon.procStart
    || canonicalExistingDirectory(daemon.dataDir) !== input.expectedDataDir
  ) {
    throw new DeviceIsolationDaemonActivationError('daemon 激活响应与在线实例身份不匹配');
  }
}

async function postActivation(
  daemon: OnlineDaemonInfo,
  path: string,
  body: Record<string, unknown>,
  fetchDaemon: typeof fetchDaemonIpc,
): Promise<ActivationResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  timer.unref?.();
  try {
    const response = await fetchDaemon(daemon.ipcPort, path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const parsed = await boundedJson(response);
    if (!response.ok) {
      const code = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        && typeof (parsed as Record<string, unknown>).error === 'string'
        ? (parsed as Record<string, unknown>).error
        : `http_${response.status}`;
      throw new DeviceIsolationDaemonActivationError(`daemon 拒绝设备隔离激活：${code}`);
    }
    return parseActivationResponse(parsed);
  } catch (error) {
    if (error instanceof DeviceIsolationDaemonActivationError) throw error;
    throw new DeviceIsolationDaemonActivationError('无法完成 daemon 设备隔离握手');
  } finally {
    clearTimeout(timer);
  }
}

async function bestEffortRelease(
  prepared: readonly PreparedDaemon[],
  nonce: string,
  markerSha256: string,
  fetchDaemon: typeof fetchDaemonIpc,
): Promise<void> {
  await Promise.allSettled(prepared.map(({ descriptor, response }) => postActivation(
    descriptor,
    RELEASE_PATH,
    {
      activationVersion: DEVICE_ISOLATION_ACTIVATION_VERSION,
      nonce,
      leaseId: response.leaseId,
      abort: true,
      ...(markerSha256 ? { markerSha256 } : {}),
    },
    fetchDaemon,
  )));
}

/** Benign worker churn between prepare and commit changes inventory generation
 * and surfaces as inventory_changed. One automatic full retry absorbs that
 * without forcing the operator to re-run enroll. */
const MAX_ACTIVATION_INVENTORY_RETRIES = 1;

function isInventoryChangedActivationError(error: unknown): boolean {
  return error instanceof DeviceIsolationDaemonActivationError
    && /inventory_changed/.test(error.message);
}

/**
 * Establish the one-way marker without leaving a legacy local CLI capable of
 * reading the first grant journal/device token. Existing valid markers are a
 * completed security transition and are never removed or downgraded.
 */
export async function activateDeviceCredentialIsolation(
  options: ActivateDeviceIsolationOptions = {},
): Promise<{ activated: boolean; daemonCount: number; markerSha256: string }> {
  const homeDir = options.homeDir ?? homedir();
  const markerPath = deviceCredentialIsolationMarkerPath(homeDir);
  const existing = readSecureHostFileSync(markerPath, 4 * 1024);
  if (existing !== null) {
    const marker = readDeviceCredentialIsolationMarker(options);
    if (marker?.state === 'active') {
      return { activated: false, daemonCount: 0, markerSha256: markerDigest(existing) };
    }
    // PENDING (including a safe legacy marker without an explicit state) means
    // a prior attempt may have died after masking new workers but before every
    // old process was quiesced. Continue the full daemon transaction.
  }

  let lastError: unknown;
  for (let attempt = 0; attempt <= MAX_ACTIVATION_INVENTORY_RETRIES; attempt += 1) {
    try {
      return await runDeviceCredentialIsolationActivationAttempt(options, homeDir, markerPath);
    } catch (error) {
      lastError = error;
      if (attempt >= MAX_ACTIVATION_INVENTORY_RETRIES || !isInventoryChangedActivationError(error)) {
        throw error;
      }
      // Marker may remain PENDING after the failed attempt; that is intentional
      // and the next attempt continues the one-way transition from there.
    }
  }
  throw lastError;
}

async function runDeviceCredentialIsolationActivationAttempt(
  options: ActivateDeviceIsolationOptions,
  homeDir: string,
  markerPath: string,
): Promise<{ activated: boolean; daemonCount: number; markerSha256: string }> {
  const deps = options.dependencies ?? {};
  const daemons = (deps.listDaemons ?? listOnlineDaemons)();
  if (daemons.length === 0) {
    throw new DeviceIsolationDaemonActivationError(
      '未发现运行中的新版 botmux daemon；请先启动 daemon，再执行设备注册',
    );
  }
  if (daemons.some(daemon => !daemon.bootInstanceId || !daemon.pid)) {
    throw new DeviceIsolationDaemonActivationError('发现不支持设备隔离握手的旧 daemon；请先全部重启升级');
  }
  const nonce = (deps.nonceFactory ?? (() => randomBytes(32).toString('base64url')))();
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(nonce)) {
    throw new DeviceIsolationDaemonActivationError('设备隔离激活 nonce 无效');
  }
  const fetchDaemon = deps.fetchDaemon ?? fetchDaemonIpc;
  const processStart = deps.processStart ?? readProcessStartIdentity;
  const expectedDataDir = canonicalExistingDirectory(
    deps.expectedDataDir ?? resolveBotmuxDataDir({ env: {}, homeDir }),
  );
  const prepared: PreparedDaemon[] = [];
  let markerRaw = '';
  let markerSha256 = '';
  try {
    // Sequential collection makes partial failure cleanup deterministic. Every
    // successful prepare freezes that daemon before the next is contacted.
    for (const descriptor of daemons) {
      const response = await postActivation(descriptor, PREPARE_PATH, {
        activationVersion: DEVICE_ISOLATION_ACTIVATION_VERSION,
        nonce,
      }, fetchDaemon);
      prepared.push({ descriptor, response });
      verifyDaemonIdentity(descriptor, response, { nonce, expectedDataDir, processStart });
    }

    ensureDeviceCredentialIsolationMarker(options);
    markerRaw = readSecureHostFileSync(markerPath, 4 * 1024)
      ?? (() => { throw new DeviceIsolationDaemonActivationError('设备隔离 marker 写入后不可读'); })();
    // Rewrite and read back through the strict primitive so the commit is
    // crash-durable even when a pre-created marker came from an interrupted run.
    writeSecureHostFileSync(markerPath, markerRaw);
    markerRaw = readSecureHostFileSync(markerPath, 4 * 1024)
      ?? (() => { throw new DeviceIsolationDaemonActivationError('设备隔离 marker durable 复读失败'); })();
    markerSha256 = markerDigest(markerRaw);

    const commitResults = await Promise.allSettled(prepared.map(async (item) => {
      const committed = await postActivation(item.descriptor, COMMIT_PATH, {
        activationVersion: DEVICE_ISOLATION_ACTIVATION_VERSION,
        nonce,
        leaseId: item.response.leaseId,
        markerSha256,
      }, fetchDaemon);
      verifyDaemonIdentity(item.descriptor, committed, { nonce, expectedDataDir, processStart });
    }));
    const commitFailure = commitResults.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    if (commitFailure) throw commitFailure.reason;

    // All legacy processes are now gone. Only now may the one-way marker become
    // ACTIVE; an interrupted PENDING attempt can never short-circuit a retry.
    completeDeviceCredentialIsolationMarker(options);
    const finalRaw = readSecureHostFileSync(markerPath, 4 * 1024);
    if (finalRaw === null || readDeviceCredentialIsolationMarker(options)?.state !== 'active') {
      throw new DeviceIsolationDaemonActivationError('设备隔离 marker 最终复验失败');
    }
    markerSha256 = markerDigest(finalRaw);

    const releaseResults = await Promise.allSettled(prepared.map(async (item) => {
      const released = await postActivation(item.descriptor, RELEASE_PATH, {
        activationVersion: DEVICE_ISOLATION_ACTIVATION_VERSION,
        nonce,
        leaseId: item.response.leaseId,
        markerSha256,
      }, fetchDaemon);
      verifyDaemonIdentity(item.descriptor, released, { nonce, expectedDataDir, processStart });
    }));
    const releaseFailure = releaseResults.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    if (releaseFailure) throw releaseFailure.reason;
    return { activated: true, daemonCount: prepared.length, markerSha256 };
  } catch (error) {
    // A marker is one-way. If activation reached the write step, leave it in
    // place: future workers fail closed/isolate, while no grant or device secret
    // has yet been requested. Release is authenticated and best-effort; leases
    // also have a bounded server-side expiry.
    await bestEffortRelease(prepared, nonce, markerSha256, fetchDaemon);
    throw error;
  }
}
