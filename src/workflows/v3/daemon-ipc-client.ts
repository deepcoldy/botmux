/** Shared client for authenticated Workflow v3 daemon mutations. */

import type { OnlineDaemonInfo } from '../../utils/daemon-discovery.js';
import {
  generateWorkflowDaemonIpcNonce,
  loadWorkflowDaemonIpcSecret,
  WORKFLOW_DAEMON_IPC_ROUTE_PREFIX,
  verifyWorkflowDaemonIpcResponse,
  workflowDaemonIpcHeaders,
  type WorkflowDaemonIpcTarget,
} from './daemon-ipc-auth.js';

export type WorkflowDaemonMutation = 'start' | 'cancel' | 'retry' | 'grant';

export interface WorkflowDaemonMutationResponse {
  ok: boolean;
  status: number;
  bodyRaw: string;
}

export class WorkflowDaemonMutationTransportError extends Error {
  constructor(message: string, public readonly causeValue?: unknown) {
    super(message);
    this.name = 'WorkflowDaemonMutationTransportError';
  }
}

export function workflowDaemonMutationTarget(
  daemon: Pick<
    OnlineDaemonInfo,
    'larkAppId' | 'ipcPort' | 'bootInstanceId' | 'workflowIpcProtocol'
  >,
): WorkflowDaemonIpcTarget {
  if (daemon.workflowIpcProtocol !== 'v1' || !daemon.bootInstanceId) {
    throw new WorkflowDaemonMutationTransportError(
      `daemon ${daemon.larkAppId} 未声明 Workflow IPC v1；请协调升级并重启全部 botmux 进程后重试`,
    );
  }
  return {
    larkAppId: daemon.larkAppId,
    ipcPort: daemon.ipcPort,
    bootInstanceId: daemon.bootInstanceId,
  };
}

export function workflowDaemonMutationPath(
  runId: string,
  mutation: WorkflowDaemonMutation,
): string {
  return `${WORKFLOW_DAEMON_IPC_ROUTE_PREFIX}/${encodeURIComponent(runId)}/${mutation}`;
}

/**
 * Serialize once, sign those exact bytes, and pass the same string to fetch.
 * Mutations are never transport-retried: a lost response must be reconciled by
 * the operation's durable/idempotent domain semantics, not by blind HTTP retry.
 */
export async function postWorkflowDaemonMutation(input: {
  daemon: Pick<
    OnlineDaemonInfo,
    'larkAppId' | 'ipcPort' | 'bootInstanceId' | 'workflowIpcProtocol'
  >;
  runId: string;
  mutation: WorkflowDaemonMutation;
  body?: Record<string, unknown>;
  secret?: string;
  secretPath?: string;
  fetchImpl?: typeof fetch;
  timestamp?: string;
  nonce?: string;
}): Promise<WorkflowDaemonMutationResponse> {
  const target = workflowDaemonMutationTarget(input.daemon);
  const secret = input.secret ?? loadWorkflowDaemonIpcSecret(input.secretPath);
  const pathWithQuery = workflowDaemonMutationPath(input.runId, input.mutation);
  const bodyRaw = JSON.stringify(input.body ?? {});
  const timestamp = input.timestamp ?? String(Date.now());
  const nonce = input.nonce ?? generateWorkflowDaemonIpcNonce();
  const headers = workflowDaemonIpcHeaders({
    secret,
    method: 'POST',
    pathWithQuery,
    bodyRaw,
    target,
    timestamp,
    nonce,
  });
  const fetchImpl = input.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(`http://127.0.0.1:${target.ipcPort}${pathWithQuery}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: bodyRaw,
    });
  } catch (err) {
    throw new WorkflowDaemonMutationTransportError(
      `无法连接 daemon (port=${target.ipcPort}): ${err instanceof Error ? err.message : String(err)}`,
      err,
    );
  }
  const responseBodyRaw = await response.text();
  const responseSignature = response.headers.get('x-botmux-workflow-ipc-response-signature');
  if (!verifyWorkflowDaemonIpcResponse({
    secret,
    requestNonce: nonce,
    method: 'POST',
    pathWithQuery,
    status: response.status,
    body: responseBodyRaw,
    target,
    signature: responseSignature,
  })) {
    throw new WorkflowDaemonMutationTransportError(
      'daemon 响应未通过 Workflow IPC v1 认证；daemon 可能刚重启，请先重试一次，' +
      '若持续出现再协调升级并重启全部 botmux 进程',
    );
  }
  return { ok: response.ok, status: response.status, bodyRaw: responseBodyRaw };
}
