/**
 * CLI-side client for the Workflow v3 session relay.
 *
 * Used only when the CLI runs inside an isolation boundary that masks the
 * host mutation path: a Linux bwrap sandbox (BOTMUX_SEND_RELAY outbox) or a
 * macOS read-isolated session (per-session capability carve-out file).
 * Isolation is detected marker-first (a visible live process-tree marker
 * always wins → host path), and only then by the worker-published rotating
 * capability file — see readWorkflowSessionRelayContext.
 *
 * Identity is NOT claimed here: the daemon re-derives caller/chat/bot from
 * its own live session record keyed by the verified capability. Env values
 * are used only to route the request (which daemon to dial).
 */

import {
  readManagedOriginCapability,
} from '../../core/managed-origin-capability.js';
import { findAncestorSessionContext } from '../../core/session-marker.js';
import type { WorkflowDaemonMutation, WorkflowDaemonMutationResponse } from './daemon-ipc-client.js';
import { WorkflowDaemonMutationTransportError } from './daemon-ipc-client.js';
import { V3_SESSION_RUN_MUTATION_ROUTE_PREFIX } from './session-relay.js';

export interface WorkflowSessionRelayContext {
  sessionId: string;
  capability: string;
  turnId?: string;
  dispatchAttempt?: number;
  /** Routing hints only — never identity. */
  larkAppId?: string;
  ipcPortFallback?: number;
}

/**
 * Detect an isolated session and load its per-turn capability.
 *
 * Detection follows the same precedence as resolveSessionContext
 * (core/session-marker.ts): a visible live process-tree marker means the host
 * path is available and MUST be used — capability files can survive a SIGKILL
 * or a later config change that disables isolation, so file existence alone
 * would permanently hijack a healthy host session onto the relay. Only when no
 * marker is visible (bwrap masks the marker dir + unshares pids; Seatbelt
 * denies it) is the capability file consulted, and host sessions without one
 * still return null.
 */
export function readWorkflowSessionRelayContext(options: {
  env: NodeJS.ProcessEnv;
  dataDir: string;
  startPid?: number;
  /** Test seams. */
  readClaim?: typeof readManagedOriginCapability;
  findMarker?: typeof findAncestorSessionContext;
}): WorkflowSessionRelayContext | null {
  const sessionId = options.env.BOTMUX_SESSION_ID?.trim();
  if (!sessionId) return null;
  const findMarker = options.findMarker ?? findAncestorSessionContext;
  const marker = findMarker(options.dataDir, options.startPid ?? process.ppid);
  if (marker?.sessionId) return null;
  const readClaim = options.readClaim ?? readManagedOriginCapability;
  const relayDir = options.env.BOTMUX_SEND_RELAY?.trim();
  const claim = readClaim(options.dataDir, sessionId, relayDir || undefined);
  if (!claim) return null;
  const portRaw = Number(options.env.BOTMUX_DAEMON_IPC_PORT);
  const ipcPortFallback = Number.isSafeInteger(portRaw) && portRaw > 0 ? portRaw : undefined;
  const larkAppId = options.env.BOTMUX_LARK_APP_ID?.trim();
  return {
    sessionId,
    capability: claim.capability,
    ...(claim.turnId ? { turnId: claim.turnId } : {}),
    ...(claim.dispatchAttempt !== undefined ? { dispatchAttempt: claim.dispatchAttempt } : {}),
    ...(larkAppId ? { larkAppId } : {}),
    ...(ipcPortFallback !== undefined ? { ipcPortFallback } : {}),
  };
}

/**
 * POST one relayed mutation. Loopback + capability-in-body, mirroring the
 * `/api/asks` client: the daemon admits the route through its narrow
 * capability aperture and fail-closes inside the handler.
 */
export async function postWorkflowSessionRunMutation(input: {
  context: WorkflowSessionRelayContext;
  runId: string;
  mutation: WorkflowDaemonMutation;
  body?: Record<string, unknown>;
  /** Resolve the owning daemon's ipcPort from discovery (host-visible only). */
  resolveIpcPort?: (larkAppId: string | undefined) => number | undefined;
  fetchImpl?: typeof fetch;
}): Promise<WorkflowDaemonMutationResponse> {
  const discovered = input.resolveIpcPort?.(input.context.larkAppId);
  const ipcPort = discovered ?? input.context.ipcPortFallback;
  if (!ipcPort) {
    throw new WorkflowDaemonMutationTransportError(
      '找不到目标 daemon 端口（daemon 发现目录不可见且缺少 BOTMUX_DAEMON_IPC_PORT）；请确认 daemon 在线',
    );
  }
  const path = `${V3_SESSION_RUN_MUTATION_ROUTE_PREFIX}/${encodeURIComponent(input.runId)}/${input.mutation}`;
  const requestBody = JSON.stringify({
    ...(input.body ?? {}),
    sessionId: input.context.sessionId,
    originCapability: input.context.capability,
    ...(input.context.turnId ? { originTurnId: input.context.turnId } : {}),
    ...(input.context.dispatchAttempt !== undefined
      ? { originDispatchAttempt: input.context.dispatchAttempt }
      : {}),
  });
  const fetchImpl = input.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(`http://127.0.0.1:${ipcPort}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: requestBody,
    });
  } catch (err) {
    throw new WorkflowDaemonMutationTransportError(
      `无法连接 daemon (port=${ipcPort}): ${err instanceof Error ? err.message : String(err)}`,
      err,
    );
  }
  const bodyRaw = await response.text();
  return { ok: response.ok, status: response.status, bodyRaw };
}
