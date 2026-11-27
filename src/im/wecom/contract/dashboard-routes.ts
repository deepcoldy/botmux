/**
 * Wire contract of the routes the Dashboard serves for a WeCom gateway — the
 * opposite direction of ./gateway-control.ts, whose routes the gateway serves.
 * The Dashboard's handler (src/dashboard/wecom/terminal-access.ts) and the
 * gateway's caller (src/im/wecom/gateway/bridge/terminal-mint.ts) share these
 * declarations; nothing here sends a request.
 *
 * Authentication is the server's business, not the contract's: the Dashboard
 * accepts these routes only from a literal loopback peer with a
 * daemon-internal HMAC signature (dashboard/daemon-internal-auth.ts) under the
 * Dashboard secret.
 *
 * Types and constants only: src/core depends on this directory, so nothing
 * here may import process code.
 */

/**
 * Routes the Dashboard serves for a gateway. Every route is POST. Typed as plain
 * strings (not `as const`), like the gateway's control paths.
 */
export const WECOM_DASHBOARD_ROUTE_PATHS: Readonly<Record<'terminalMint', string>> = {
  /** Gateway: one short-lived terminal link for a card's terminal / write-link button. */
  terminalMint: '/__wecom/terminal-mint',
};

/** The channel principal a native terminal link is bound to. */
export interface NativeTerminalIdentity {
  provider: 'wecom';
  connectionId: string;
  botId: string;
  userId: string;
}

/** One native terminal request: who asks, for which session and turn, to read or to write. */
export interface NativeTerminalRequest {
  identity: NativeTerminalIdentity;
  sessionId: string;
  triggerId: string;
  permission: 'read' | 'write';
}

/**
 * `terminalMint` request body: the request alone. The Dashboard builds the link
 * on its own address (dashboard/wecom/terminal-access.ts); a field in the body
 * naming one, as earlier gateways sent (`baseUrl`), is ignored.
 */
export type WecomTerminalMintRequest = NativeTerminalRequest;

/**
 * `terminalMint` response body. HTTP 200 with `ok: true` carries the link; a
 * request the Dashboard refuses answers 403 with `ok: false`
 * (`native_terminal_rejected`), and a failed signature or a non-loopback peer
 * answers its own status with `ok: false`.
 */
export type WecomTerminalMintResponse =
  | { ok: true; url: string; expiresAt: number }
  | { ok: false; error?: string };
