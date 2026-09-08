// Dashboard-side `.env` loading, narrowed to an ALLOWLIST.
//
// ~/.botmux/.env is a general-purpose operator file: besides botmux settings it
// routinely holds unrelated credentials (LARK_APP_SECRET for the legacy
// single-bot mode, GITHUB_TOKEN, model API keys, whatever the host's tooling
// wants). index-dashboard.ts used to dotenv-load that file WHOLESALE into
// process.env, and the dashboard process is the worst place in the fleet for
// that: it forks debug-terminal shells, `botmux start-bot/stop-bot` children,
// a global npm/pnpm/bun install (whose lifecycle scripts run with the inherited
// env), herdr plugin installs, and it starts plugin PM2 services — every one of
// those inherited the whole file. A secret that has no consumer in the
// dashboard must therefore never enter its process.env at all.
//
// So the entry loads the file into a side object and copies over ONLY the keys
// the dashboard actually consumes (this module's allowlist). Everything else —
// especially credentials — stays in the file. The per-boundary redaction
// (redactChildEnv / stripDashboardH5Env) remains the second layer for the keys
// the dashboard legitimately holds, most importantly the H5 login family.
//
// Adding a key here is a deliberate act: it means "the dashboard process reads
// this, and every child it forks may see it unless a boundary strips it".
import { config as dotenvConfig } from 'dotenv';
import { DAEMON_ENV_KEYS } from '../cli/daemon-lifecycle-env.js';
import { DASHBOARD_H5_ENV_PREFIX } from './child-env.js';

/**
 * Keys the dashboard process reads from ~/.botmux/.env, beyond
 * {@link DAEMON_ENV_KEYS} (which is folded in below: every key pinned into the
 * shared fleet env is by definition a setting the dashboard may resolve,
 * and a foreground/manual `dist/index-dashboard.js` has only the file).
 *
 * Each entry names its consumer inside the dashboard process, so a future
 * reader can verify — or delete — it:
 *  - SESSION_DATA_DIR → config.session.dataDir. The dashboard shares
 *    pairings/federations/memberships with the daemons under {dataDir}/*.json;
 *    a wrong value silently splits the store (cli.ts also bakes it).
 *  - CLI_ID / BACKEND_TYPE → config.daemon.cliId / config.daemon.backendType,
 *    the fleet-wide fallback the dashboard applies to a bot that pins neither
 *    (VC-meeting consumer isolation verdict, adapter capability probes).
 *  - BOTMUX_SCHEDULE_TIMEZONE → utils/timezone scheduleTimeZone(). The settings
 *    payload advertises `effectiveScheduleTimeZone`; dropping the env override
 *    here would make the UI report a zone the daemons do not fire in.
 *  - FEISHU_USER_ACCESS_TOKEN → utils/user-token resolveUserToken(), used by
 *    dashboard/feed-groups.ts. A credential, kept for the same reason as the H5
 *    APP_SECRET below: the dashboard is a real consumer. Not a licence to add
 *    other credentials — a key belongs here only with a named consumer.
 *  - BOTMUX_DASHBOARD_DEV_RELOAD → dashboard.ts dev-reload switch.
 *  - proxy family → outbound HTTPS from the dashboard itself (npm registry
 *    version/rollback lookups, hd2d asset download) on hosts without direct
 *    internet. These are forwarded to CLI children by design elsewhere
 *    (PROXY_ENV_KEYS), so allowing them adds no new exposure.
 */
export const DASHBOARD_ENV_ALLOWLIST = [
  ...DAEMON_ENV_KEYS,
  'SESSION_DATA_DIR',
  'CLI_ID',
  'BACKEND_TYPE',
  'BOTMUX_SCHEDULE_TIMEZONE',
  'FEISHU_USER_ACCESS_TOKEN',
  'BOTMUX_DASHBOARD_DEV_RELOAD',
  'http_proxy', 'https_proxy', 'HTTP_PROXY', 'HTTPS_PROXY',
  'no_proxy', 'NO_PROXY', 'all_proxy', 'ALL_PROXY',
] as const;

const ALLOWED: ReadonlySet<string> = new Set<string>(DASHBOARD_ENV_ALLOWLIST);

/**
 * True for a key the dashboard may take from ~/.botmux/.env.
 *
 * The Feishu H5 login family is matched by PREFIX, not by name: the dashboard
 * is that family's single consumer (resolveDashboardH5AuthConfig), and a knob
 * added tomorrow must work the day it ships — the same prefix rule
 * stripDashboardH5Env() uses to remove it everywhere else, so the two cannot
 * drift into "loaded here, not stripped there".
 */
export function isDashboardEnvKey(key: string): boolean {
  return key.startsWith(DASHBOARD_H5_ENV_PREFIX) || ALLOWED.has(key);
}

/**
 * Load `envPath` and merge ONLY {@link isDashboardEnvKey} keys into `target`
 * (default process.env).
 *
 * Semantics kept identical to the previous wholesale `dotenvConfig({ path })`
 * for allowlisted keys — a value already present in `target` wins, so the
 * deterministic fleet snapshot (resolveDaemonEnv → DAEMON_ENV_KEYS) still
 * outranks the file. The difference is everything else in the file: it is
 * parsed into a private object and dropped.
 *
 * A missing/unreadable file is a no-op (dotenv reports it in `result.error`;
 * the dashboard has always treated an absent .env as "no settings").
 */
export function loadDashboardEnvFile(
  envPath: string,
  target: NodeJS.ProcessEnv = process.env,
): void {
  // `processEnv` (dotenv ≥16.4) makes dotenv populate THIS object instead of
  // process.env, so non-allowlisted secrets are never in the process at all —
  // not even for the microtask between load and delete.
  const fileEnv: NodeJS.ProcessEnv = {};
  const before = new Set(Object.keys(target));
  dotenvConfig({ path: envPath, processEnv: fileEnv });
  // Belt for the day dotenv drops/renames `processEnv`: anything that appeared
  // in `target` across the call can only have come from the file, so a
  // non-allowlisted newcomer is removed. Keys that already existed are never
  // touched — deleting an inherited PATH/HOME because the file happens to
  // mention it would be far worse than the leak this guards.
  for (const key of Object.keys(target)) {
    if (before.has(key) || isDashboardEnvKey(key)) continue;
    delete target[key];
  }
  for (const [key, value] of Object.entries(fileEnv)) {
    if (value === undefined) continue;
    if (!isDashboardEnvKey(key)) continue;
    if (target[key] !== undefined) continue; // dotenv never overrides an existing var
    target[key] = value;
  }
}
