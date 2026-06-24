/**
 * Daemon-side wrapper around the PR2 `createDaemonClient` (PR3 C3).
 *
 * Daemons calling Route B (`/__daemon/*`) live in the same host as the
 * dashboard but use a separate process; they need a `DaemonClient` that:
 *   - signs with `~/.botmux/.dashboard-secret`
 *   - targets the port the dashboard is actually bound to (which may differ
 *     from the configured default when EADDRINUSE forces a probe upward),
 *     read from `~/.botmux/.dashboard-port`
 *   - reports the daemon's own larkAppId in the audit header
 *
 * Caching rationale (plan v3 B6): we do NOT cache the resulting client per
 * larkAppId. `createDaemonClient` is cheap (one secret file read + a closure)
 * and a cached instance would route to a stale port if the dashboard
 * process restarts on a different bound port. Per-request `create + sign +
 * fetch` is the safe default.
 *
 * Port parser strictness (plan v4 B4): we use `Number(raw.trim())` plus
 * `Number.isInteger` and a `1..65535` range check. `parseInt('7891abc', 10)`
 * silently returns `7891`, which would make a corrupt file indistinguishable
 * from the default — exactly the case the regression tests pin down.
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import {
  createDaemonClient as defaultCreateDaemonClient,
  type DaemonClient,
} from './dashboard/daemon-internal-client.js';

const DEFAULT_PORT_PATH = join(homedir(), '.botmux', '.dashboard-port');
const DEFAULT_PORT = 7891;
const MIN_TCP_PORT = 1;
const MAX_TCP_PORT = 65535;

/** Optional injection seam — tests provide alternate paths / factories. */
export interface ClientWrapperOptions {
  /** Override `.dashboard-port` location (tests point at tmp files). */
  portPath?: string;
  /** Override the underlying `createDaemonClient` factory (tests assert call count). */
  createClient?: typeof defaultCreateDaemonClient;
}

/**
 * Read `.dashboard-port` if present and parseable; otherwise return the
 * default 7891. Pure with respect to its `portPath` argument.
 */
export function resolveDashboardUrl(portPath: string = DEFAULT_PORT_PATH): string {
  let port = DEFAULT_PORT;
  if (existsSync(portPath)) {
    try {
      const raw = readFileSync(portPath, 'utf8').trim();
      const parsed = Number(raw);
      if (
        Number.isFinite(parsed) &&
        Number.isInteger(parsed) &&
        parsed >= MIN_TCP_PORT &&
        parsed <= MAX_TCP_PORT
      ) {
        port = parsed;
      }
    } catch {
      // Unreadable file — fall through to the default.
    }
  }
  return `http://127.0.0.1:${port}`;
}

/**
 * Build a fresh `DaemonClient` for the given larkAppId. New instance per
 * call by design — see the caching rationale in the module-level comment.
 */
export function createDaemonClientFor(
  larkAppId: string,
  opts: ClientWrapperOptions = {},
): DaemonClient {
  const create = opts.createClient ?? defaultCreateDaemonClient;
  return create({
    dashboardUrl: resolveDashboardUrl(opts.portPath),
    appId: larkAppId,
  });
}
