import { config } from '../config.js';

/**
 * Builds the public URL for a session's web terminal. When the per-daemon
 * reverse proxy (terminal-proxy.ts) is up, URLs go through it under
 * `/s/{sessionId}` so users only forward one port. If the proxy failed to bind,
 * we fall back to the worker's own port so links never go dead — the proxy is
 * an enhancement, not a hard dependency. externalHost is read live (not
 * snapshotted) so cards stay correct across network changes.
 */

interface TerminalUrlSession {
  session: { sessionId: string; webPort?: number | null };
  workerPort: number | null;
  workerToken: string | null;
}

let proxyPort = 0;
let proxyReady = false;

/** Marks the proxy live on `port`. Called only after a successful bind. */
export function setTerminalProxyPort(port: number): void {
  proxyPort = port;
  proxyReady = true;
}

/** Bound proxy port, or 0 when the proxy is not available. */
export function getTerminalProxyPort(): number {
  return proxyReady ? proxyPort : 0;
}

/** Test/edge helper: revert to the no-proxy (direct-port) state. */
export function resetTerminalProxy(): void {
  proxyPort = 0;
  proxyReady = false;
}

export function buildTerminalUrl(ds: TerminalUrlSession, opts: { write?: boolean } = {}): string {
  const base = proxyReady
    ? `http://${config.web.externalHost}:${proxyPort}/s/${ds.session.sessionId}`
    : `http://${config.web.externalHost}:${ds.workerPort ?? ds.session.webPort}`;
  if (opts.write && ds.workerToken) return `${base}?token=${ds.workerToken}`;
  return base;
}
