/**
 * collab.preflight 跨 daemon 只读预检（design 2026-11-20-dm-collab-group §7.1）。
 *
 * 复用 dispatch-launch IPC v1 的双向认证（同一 host secret、同一 nonce 防重放、同一
 * bootInstanceId audience、同一 loopback-only 传输），但路由前缀独立、身份字段用
 * initId/sourceMessageId/configVersion（不硬套 dispatchId）。首期只查能力 + 目标 appId
 * 匹配 + 协议版本 + workingDir 可接受，不建会话、不扣费。
 *
 * 能力判定 durable-turn-output-receipt-v1 由 handler 现场判定（读 bot 的 backendType），
 * 不进描述符布尔。
 */
import {
  DISPATCH_LAUNCH_IPC_HEADERS,
  dispatchLaunchIpcHeaders,
  generateDispatchLaunchIpcNonce,
  loadDispatchLaunchIpcSecret,
  verifyDispatchLaunchIpcResponseSignature,
  type DispatchLaunchIpcTarget,
} from './dispatch-launch-ipc-auth.js';
import { dispatchLaunchIpcTarget } from './dispatch-launch-ipc-client.js';
import type { OnlineDaemonInfo } from '../utils/daemon-discovery.js';
import { loopbackFetchImpl } from './loopback-fetch.js';

export const COLLAB_IPC_ROUTE_PREFIX = '/__collab-ipc/v1';
export const COLLAB_IPC_PROTOCOL_VERSION = 1;
export const COLLAB_IPC_DURABLE_TURN_OUTPUT_RECEIPT = 'durable-turn-output-receipt-v1';

export interface CollabPreflightRequestV1 {
  schemaVersion: 1;
  initId: string;
  sourceMessageId: string;
  configVersion: string;
  targetLarkAppId: string;
}

export type CollabPreflightResponseV1 =
  | { ok: true; protocolVersion: number; capabilities: string[]; workingDirAccepted: boolean }
  | { ok: false; errorCode: string; message: string };

/** initId 格式：sha256 的 64 hex（PR-1 collabInitId 产出）。 */
const INIT_ID_RE = /^[0-9a-f]{64}$/;

/** 目标 appId 非空且无 CR/LF/NUL（与 dispatch target 同一条身份边界）。 */
function validAppId(appId: string): boolean {
  return Boolean(appId) && !/[\r\n\0]/.test(appId);
}

/** Parse only canonical JSON（HMAC 认证的字节只有一种语义）。 */
export function parseCollabPreflightRequest(bodyRaw: string):
  | { ok: true; req: CollabPreflightRequestV1 }
  | { ok: false; error: 'bad_json' | 'bad_body' } {
  if (!bodyRaw) return { ok: false, error: 'bad_json' };
  let parsed: unknown;
  try { parsed = JSON.parse(bodyRaw); } catch { return { ok: false, error: 'bad_json' }; }
  if (JSON.stringify(parsed) !== bodyRaw) return { ok: false, error: 'bad_json' };
  const r = parsed as Record<string, unknown>;
  if (
    r.schemaVersion !== 1
    || typeof r.initId !== 'string' || !INIT_ID_RE.test(r.initId)
    || typeof r.sourceMessageId !== 'string' || !r.sourceMessageId
    || typeof r.configVersion !== 'string' || !r.configVersion
    || typeof r.targetLarkAppId !== 'string' || !validAppId(r.targetLarkAppId)
  ) {
    return { ok: false, error: 'bad_body' };
  }
  return {
    ok: true,
    req: {
      schemaVersion: 1,
      initId: r.initId,
      sourceMessageId: r.sourceMessageId,
      configVersion: r.configVersion,
      targetLarkAppId: r.targetLarkAppId,
    },
  };
}

/**
 * 能力判定：PTY 家族（缺省/pty）与 TmuxBackend 能持久提供执行终态 + delivered
 * messageId，声明 durable-turn-output-receipt-v1。其余 backend（herdr/zellij/zmx/riff/
 * mojo/remote-runner/orca/hc）不声明，配 afterAgentTurn 在 S0 拒绝。
 */
export function declaresDurableTurnOutputReceipt(backendType: string | undefined): boolean {
  return backendType === undefined || backendType === 'pty' || backendType === 'tmux';
}

/** `POST /__collab-ipc/v1/:initId/preflight`。 */
export function collabPreflightPath(initId: string): string {
  return `${COLLAB_IPC_ROUTE_PREFIX}/${encodeURIComponent(initId)}/preflight`;
}

export class CollabPreflightTransportError extends Error {
  constructor(message: string, public readonly causeValue?: unknown) {
    super(message);
    this.name = 'CollabPreflightTransportError';
  }
}

/**
 * 客户端：向 peer daemon 发 collab.preflight。网络/超时/认证失败 → 未就绪（fail-closed）。
 * peer 离线 ≠ 群成员仍在可用。
 */
export async function preflightCollabPeer(
  daemon: Pick<OnlineDaemonInfo, 'larkAppId' | 'ipcPort' | 'bootInstanceId' | 'dispatchLaunchIpcProtocol'>,
  req: CollabPreflightRequestV1,
  opts: { secret?: string; secretPath?: string; fetchImpl?: typeof fetch; timestamp?: string; nonce?: string } = {},
): Promise<CollabPreflightResponseV1> {
  let target: DispatchLaunchIpcTarget;
  try {
    target = dispatchLaunchIpcTarget(daemon);
  } catch (err) {
    return { ok: false, errorCode: 'PEER_NOT_READY', message: err instanceof Error ? err.message : String(err) };
  }
  let secret: string;
  try {
    secret = opts.secret ?? loadDispatchLaunchIpcSecret(opts.secretPath);
  } catch {
    return { ok: false, errorCode: 'IPC_SECRET_UNAVAILABLE', message: 'loopback IPC secret unavailable' };
  }
  const pathWithQuery = collabPreflightPath(req.initId);
  const method = 'POST';
  const bodyRaw = JSON.stringify(req);
  const nonce = opts.nonce ?? generateDispatchLaunchIpcNonce();
  const headers = dispatchLaunchIpcHeaders({ secret, method, pathWithQuery, bodyRaw, target, timestamp: opts.timestamp, nonce });
  let response: Response;
  try {
    response = await (opts.fetchImpl ?? loopbackFetchImpl)(
      `http://127.0.0.1:${target.ipcPort}${pathWithQuery}`,
      { method, headers: { 'content-type': 'application/json', ...headers }, body: bodyRaw },
    );
  } catch (err) {
    return { ok: false, errorCode: 'PEER_OFFLINE', message: err instanceof Error ? err.message : String(err) };
  }
  let respBody: string;
  try {
    respBody = await response.text();
  } catch {
    return { ok: false, errorCode: 'RESPONSE_READ_FAILED', message: 'failed to read response body' };
  }
  const respSignature = response.headers.get(DISPATCH_LAUNCH_IPC_HEADERS.responseSignature);
  const signatureValid = verifyDispatchLaunchIpcResponseSignature({
    secret, requestNonce: nonce, method, pathWithQuery, status: response.status, body: respBody, target, signature: respSignature ?? undefined,
  });
  if (!signatureValid) {
    return { ok: false, errorCode: 'RESPONSE_SIGNATURE_INVALID', message: 'response signature mismatch' };
  }
  let parsed: unknown;
  try { parsed = JSON.parse(respBody); } catch { return { ok: false, errorCode: 'BAD_RESPONSE', message: 'response not JSON' }; }
  const r = parsed as Record<string, unknown>;
  if (r.ok === true) {
    return {
      ok: true,
      protocolVersion: typeof r.protocolVersion === 'number' ? r.protocolVersion : COLLAB_IPC_PROTOCOL_VERSION,
      capabilities: Array.isArray(r.capabilities) ? r.capabilities.filter((c): c is string => typeof c === 'string') : [],
      workingDirAccepted: r.workingDirAccepted === true,
    };
  }
  return {
    ok: false,
    errorCode: typeof r.errorCode === 'string' ? r.errorCode : 'PEER_REJECTED',
    message: typeof r.message === 'string' ? r.message : 'peer rejected preflight',
  };
}
