import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  cliAuthBind,
  loadDashboardSecret,
  signCliAuth,
} from '../dashboard/auth.js';

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

/** Trusted-host fetch wrapper for daemon IPC. */
export async function fetchDaemonIpc(
  port: number,
  path: string,
  init: RequestInit = {},
  secret?: string,
): Promise<Response> {
  const resolvedSecret = secret ?? loadDaemonIpcSecret();
  const method = init.method ?? 'GET';
  return fetch(`http://127.0.0.1:${port}${path}`, {
    ...init,
    headers: daemonIpcAuthHeaders({
      secret: resolvedSecret,
      port,
      method,
      path,
      headers: init.headers,
    }),
  });
}
