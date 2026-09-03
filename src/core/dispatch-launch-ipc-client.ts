import type { OnlineDaemonInfo } from '../utils/daemon-discovery.js';
import { loopbackFetchImpl } from './loopback-fetch.js';
import {
  DISPATCH_LAUNCH_IPC_HEADERS,
  DISPATCH_LAUNCH_IPC_ROUTE_PREFIX,
  dispatchLaunchIpcHeaders,
  generateDispatchLaunchIpcNonce,
  loadDispatchLaunchIpcSecret,
  verifyDispatchLaunchIpcResponseSignature,
  type DispatchLaunchIpcTarget,
} from './dispatch-launch-ipc-auth.js';
import type { DispatchLaunchIpcMutation } from './dispatch-launch-ipc-body.js';

export interface DispatchLaunchIpcResponse {
  ok: boolean;
  status: number;
  bodyRaw: string;
}

export class DispatchLaunchIpcTransportError extends Error {
  constructor(message: string, public readonly causeValue?: unknown) {
    super(message);
    this.name = 'DispatchLaunchIpcTransportError';
  }
}

export function dispatchLaunchIpcTarget(
  daemon: Pick<OnlineDaemonInfo, 'larkAppId' | 'ipcPort' | 'bootInstanceId' | 'dispatchLaunchIpcProtocol'>,
): DispatchLaunchIpcTarget {
  if (daemon.dispatchLaunchIpcProtocol !== 'v1' || !daemon.bootInstanceId) {
    throw new DispatchLaunchIpcTransportError(
      `daemon ${daemon.larkAppId} does not advertise dispatch launch IPC v1`,
    );
  }
  return {
    larkAppId: daemon.larkAppId,
    ipcPort: daemon.ipcPort,
    bootInstanceId: daemon.bootInstanceId,
  };
}

export function dispatchLaunchIpcPath(dispatchId: string, action?: DispatchLaunchIpcMutation): string {
  if (!/^dl_[0-9a-f]{32}$/.test(dispatchId)) {
    throw new DispatchLaunchIpcTransportError('invalid dispatch launch id');
  }
  const base = `${DISPATCH_LAUNCH_IPC_ROUTE_PREFIX}/${encodeURIComponent(dispatchId)}`;
  return action ? `${base}/${action}` : base;
}

/** One authenticated attempt. Callers reconcile an uncertain response through GET query. */
export async function requestDispatchLaunchIpc(input: {
  daemon: Pick<OnlineDaemonInfo, 'larkAppId' | 'ipcPort' | 'bootInstanceId' | 'dispatchLaunchIpcProtocol'>;
  dispatchId: string;
  action?: DispatchLaunchIpcMutation;
  body?: unknown;
  secret?: string;
  secretPath?: string;
  fetchImpl?: typeof fetch;
  timestamp?: string;
  nonce?: string;
}): Promise<DispatchLaunchIpcResponse> {
  const target = dispatchLaunchIpcTarget(input.daemon);
  const secret = input.secret ?? loadDispatchLaunchIpcSecret(input.secretPath);
  const pathWithQuery = dispatchLaunchIpcPath(input.dispatchId, input.action);
  const method = input.action ? 'POST' : 'GET';
  const bodyRaw = input.action ? JSON.stringify(input.body ?? {}) : '';
  const nonce = input.nonce ?? generateDispatchLaunchIpcNonce();
  const headers = dispatchLaunchIpcHeaders({
    secret, method, pathWithQuery, bodyRaw, target,
    timestamp: input.timestamp, nonce,
  });
  let response: Response;
  try {
    response = await (input.fetchImpl ?? loopbackFetchImpl)(
      `http://127.0.0.1:${target.ipcPort}${pathWithQuery}`,
      {
        method,
        headers: { 'content-type': 'application/json', ...headers },
        ...(input.action ? { body: bodyRaw } : {}),
      },
    );
  } catch (error) {
    throw new DispatchLaunchIpcTransportError(
      `cannot connect to dispatch launch daemon on port ${target.ipcPort}`, error,
    );
  }
  const responseBodyRaw = await response.text();
  if (!verifyDispatchLaunchIpcResponseSignature({
    secret, requestNonce: nonce, method, pathWithQuery, status: response.status,
    body: responseBodyRaw, target,
    signature: response.headers.get(DISPATCH_LAUNCH_IPC_HEADERS.responseSignature) ?? undefined,
  })) {
    throw new DispatchLaunchIpcTransportError('dispatch launch daemon response authentication failed');
  }
  return { ok: response.ok, status: response.status, bodyRaw: responseBodyRaw };
}
