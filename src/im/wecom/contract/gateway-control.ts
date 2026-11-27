/**
 * Wire contract of the WeCom gateway's loopback control server
 * (src/im/wecom/gateway/gateway-control.ts): the routes it serves and the
 * request / response shapes its callers send and read. The server, the
 * Dashboard client (src/dashboard/wecom/gateway-control-client.ts) and the
 * other callers share these declarations; nothing here sends a request.
 *
 * Authentication is the server's business, not the contract's: every route
 * requires a literal loopback peer, a daemon-internal HMAC signature
 * (dashboard/daemon-internal-auth.ts) and the gateway's current instance id.
 *
 * The routes the Dashboard serves for the gateway are in ./dashboard-routes.ts.
 */
import type { NativeTerminalRequest } from './dashboard-routes.js';

/**
 * Routes of the gateway control server. Every route is POST. Typed as plain
 * strings (not `as const`) so the server can test `req.url` against a list.
 */
export const WECOM_GATEWAY_CONTROL_PATHS: Readonly<Record<'sessionControl' | 'peer' | 'terminalAuthorize', string>> = {
  /** Dashboard: one session control operation (WecomSessionControlRequest). */
  sessionControl: '/__wecom/session-control',
  /** Another gateway: a native peer request. Not bound to a core identity. */
  peer: '/__wecom/peer',
  /** Dashboard: authorize one native terminal browser. Not bound to a core identity. */
  terminalAuthorize: '/__wecom/terminal-authorize',
};

/** Session control operations the gateway accepts on `sessionControl`. */
export type WecomSessionOperation = 'interrupt' | 'close' | 'archive' | 'delete' | 'restart' | 'resume' | 'suspend';

/**
 * `sessionControl` response body: HTTP 200 when `ok`, 409 otherwise.
 *
 * `rejected` is a definite refusal: the core answered that the session is no
 * longer active (`error: 'session_not_active'`), so nothing happened and the
 * gateway holds no lock on it. `uncertain` means the outcome is not known.
 */
export interface WecomControlResult {
  ok: boolean;
  status: 'completed' | 'uncertain' | 'pending' | 'rejected';
  error?: string;
}

/** `sessionControl` request body. */
export interface WecomSessionControlRequest {
  instanceId: string;
  coreIdentity: string;
  sessionId: string;
  operation: WecomSessionOperation;
  requestId: string;
  expectedGeneration?: string;
  expectedCoreBootId?: string;
}

/** `terminalAuthorize` request body: one native terminal request, addressed to the gateway instance. */
export interface WecomTerminalAuthorizeRequest extends NativeTerminalRequest {
  instanceId: string;
  /** The Dashboard sends it; this route does not check it (see the paths above). */
  coreIdentity?: string;
}

/**
 * `terminalAuthorize` response body (HTTP 200): whether the gateway allows the
 * request right now, and the epoch of the state that decision was made under —
 * a later answer with another epoch means the decision may have changed.
 */
export interface WecomTerminalAuthorization {
  allowed: boolean;
  epoch: string;
}
