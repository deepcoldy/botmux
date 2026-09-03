import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  cliAuthBind,
  loadDashboardSecret,
  signCliAuth,
} from '../dashboard/auth.js';
import { loopbackFetch, type LoopbackFetchInit } from './loopback-fetch.js';

const DEFAULT_SECRET_PATH = join(homedir(), '.botmux', '.dashboard-secret');

/**
 * Build a route- and port-bound authorization header for the daemon's
 * loopback HTTP server.  Loopback is connectivity, not identity: Linux bwrap
 * sessions normally retain the host network namespace so an untrusted CLI can
 * also dial 127.0.0.1.  The shared dashboard secret is masked from file
 * sandboxes, while trusted dashboard/daemon/host-CLI callers can read it.
 */
export function daemonIpcAuthHeaders(input: {
  secret: string;
  port: number;
  method: string;
  path: string;
  headers?: HeadersInit;
}): Headers {
  const pathname = new URL(input.path, `http://127.0.0.1:${input.port}`).pathname;
  const auth = signCliAuth(
    input.secret,
    cliAuthBind(input.method, pathname, input.port),
  );
  const headers = new Headers(input.headers);
  headers.set('X-Botmux-Cli-Ts', auth.ts);
  headers.set('X-Botmux-Cli-Nonce', auth.nonce);
  headers.set('X-Botmux-Cli-Auth', auth.sig);
  return headers;
}

/** Read the host-only daemon IPC secret. Sandboxed callers fail closed because
 * ~/.botmux is masked by the bwrap plan. */
export function loadDaemonIpcSecret(secretPath = DEFAULT_SECRET_PATH): string {
  const secret = loadDashboardSecret(secretPath);
  if (!secret) throw new Error(`daemon IPC secret is missing or empty: ${secretPath}`);
  return secret;
}

/** Trusted-host fetch wrapper for daemon IPC.
 *
 * ⚠️ Uses {@link loopbackFetch}, never the global `fetch`: under Bun the global
 * one routes 127.0.0.1 through `$http_proxy` whenever `no_proxy` does not name
 * that literal address (CIDR and `localhost` do not count), and the corporate
 * proxy answers an nginx HTML 403. Verified against this wrapper with a real Bun
 * process and a stand-in proxy: global fetch → 403 from the proxy;
 * `loopbackFetch` → straight to the daemon. See src/core/loopback-fetch.ts.
 */
export async function fetchDaemonIpc(
  port: number,
  path: string,
  init: RequestInit = {},
  secret?: string,
): Promise<Response> {
  const resolvedSecret = secret ?? loadDaemonIpcSecret();
  const method = init.method ?? 'GET';
  return loopbackFetch(`http://127.0.0.1:${port}${path}`, {
    method,
    body: init.body as LoopbackFetchInit['body'],
    signal: init.signal ?? undefined,
    headers: daemonIpcAuthHeaders({
      secret: resolvedSecret,
      port,
      method,
      path,
      headers: init.headers,
    }),
  });
}
