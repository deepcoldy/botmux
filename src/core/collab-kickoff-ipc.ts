/**
 * collab.kickoff 协议（PR-3a，§7.1）。
 *
 * 复用 dispatch-launch IPC 双向认证（同一 host secret + nonce 防重放 + bootInstanceId
 * audience），路由前缀复用 /__collab-ipc/v1，身份用 initId/kickoffId/sourceMessageId。
 * 四个 mutation：prepare / start / query(GET) / cancel。operation 状态机见 collab-kickoff-store。
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
import { COLLAB_IPC_ROUTE_PREFIX } from './collab-preflight-ipc.js';
import type { CollabKickoffOperationV1 } from './collab-kickoff-store.js';
import type { CollabArtifactSatisfiedBy } from './collab-artifact-ready.js';

export type CollabKickoffMutation = 'prepare' | 'start' | 'cancel';

const INIT_ID_RE = /^[0-9a-f]{64}$/;
const KICKOFF_ID_RE = /^[0-9a-f]{64}$/;

export interface CollabKickoffPrepareRequestV1 {
  schemaVersion: 1;
  initId: string;
  kickoffId: string;
  sourceMessageId: string;
  configVersion: string;
  targetLarkAppId: string;
  appId: string;
  prompt: string;
  dependencyProof?: { satisfiedBy?: CollabArtifactSatisfiedBy };
}

export interface CollabKickoffStartRequestV1 {
  schemaVersion: 1;
  initId: string;
  kickoffId: string;
  payloadHash: string;
  configVersion: string;
}

export type CollabKickoffResponseV1 =
  | { ok: true; operation: CollabKickoffOperationV1 }
  | { ok: false; errorCode: string; message: string };

export function collabKickoffPath(initId: string, kickoffId: string, action?: CollabKickoffMutation): string {
  const base = `${COLLAB_IPC_ROUTE_PREFIX}/${encodeURIComponent(initId)}/kickoff/${encodeURIComponent(kickoffId)}`;
  return action ? `${base}/${action}` : base;
}

/** Parse canonical JSON request body（prepare/start 共用结构校验入口）。 */
export function parseCollabKickoffRequest(bodyRaw: string):
  | { ok: true; req: CollabKickoffPrepareRequestV1 | CollabKickoffStartRequestV1 }
  | { ok: false; error: 'bad_json' | 'bad_body' } {
  if (!bodyRaw) return { ok: false, error: 'bad_json' };
  let parsed: unknown;
  try { parsed = JSON.parse(bodyRaw); } catch { return { ok: false, error: 'bad_json' }; }
  if (JSON.stringify(parsed) !== bodyRaw) return { ok: false, error: 'bad_json' };
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: false, error: 'bad_body' };
  const r = parsed as Record<string, unknown>;
  if (
    r.schemaVersion !== 1
    || typeof r.initId !== 'string' || !INIT_ID_RE.test(r.initId)
    || typeof r.kickoffId !== 'string' || !KICKOFF_ID_RE.test(r.kickoffId)
    || typeof r.configVersion !== 'string' || !r.configVersion
  ) {
    return { ok: false, error: 'bad_body' };
  }
  return { ok: true, req: r as unknown as CollabKickoffPrepareRequestV1 };
}

/** 客户端：向 peer daemon 发 collab.kickoff（prepare/start/cancel/query）。网络/认证失败 → 未就绪。 */
export async function requestCollabKickoff(
  daemon: Pick<OnlineDaemonInfo, 'larkAppId' | 'ipcPort' | 'bootInstanceId' | 'dispatchLaunchIpcProtocol'>,
  initId: string,
  kickoffId: string,
  action: CollabKickoffMutation | undefined,
  body: unknown,
  opts: { secret?: string; secretPath?: string; fetchImpl?: typeof fetch; timestamp?: string; nonce?: string } = {},
): Promise<CollabKickoffResponseV1> {
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
  const pathWithQuery = collabKickoffPath(initId, kickoffId, action);
  const method = action ? 'POST' : 'GET';
  const bodyRaw = action ? JSON.stringify(body ?? {}) : '';
  const nonce = opts.nonce ?? generateDispatchLaunchIpcNonce();
  const headers = dispatchLaunchIpcHeaders({ secret, method, pathWithQuery, bodyRaw, target, timestamp: opts.timestamp, nonce });
  let response: Response;
  try {
    response = await (opts.fetchImpl ?? loopbackFetchImpl)(
      `http://127.0.0.1:${target.ipcPort}${pathWithQuery}`,
      { method, headers: { 'content-type': 'application/json', ...headers }, ...(action ? { body: bodyRaw } : {}) },
    );
  } catch (err) {
    return { ok: false, errorCode: 'PEER_OFFLINE', message: err instanceof Error ? err.message : String(err) };
  }
  let respBody: string;
  try { respBody = await response.text(); } catch { return { ok: false, errorCode: 'RESPONSE_READ_FAILED', message: 'failed to read response body' }; }
  const respSignature = response.headers.get(DISPATCH_LAUNCH_IPC_HEADERS.responseSignature);
  const signatureValid = verifyDispatchLaunchIpcResponseSignature({
    secret, requestNonce: nonce, method, pathWithQuery, status: response.status, body: respBody, target, signature: respSignature ?? undefined,
  });
  if (!signatureValid) return { ok: false, errorCode: 'RESPONSE_SIGNATURE_INVALID', message: 'response signature mismatch' };
  let parsed: unknown;
  try { parsed = JSON.parse(respBody); } catch { return { ok: false, errorCode: 'BAD_RESPONSE', message: 'response not JSON' }; }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: false, errorCode: 'BAD_RESPONSE', message: 'response not object' };
  const r = parsed as Record<string, unknown>;
  if (r.ok !== true) {
    return { ok: false, errorCode: typeof r.errorCode === 'string' ? r.errorCode : 'PEER_REJECTED', message: typeof r.message === 'string' ? r.message : 'peer rejected' };
  }
  if (r.operation === null || typeof r.operation !== 'object') return { ok: false, errorCode: 'BAD_RESPONSE', message: 'operation missing' };
  return { ok: true, operation: r.operation as CollabKickoffOperationV1 };
}
