#!/usr/bin/env node
// Dedicated entry point for the `botmux-dashboard` process. The fleet supervisor
// spawns it as a supervised member (resolveDashboardSpec → the 'dashboard'
// entry; under the Bun single binary via the `__dashboard` self-spawn token).
// It exists so the dashboard can load ~/.botmux/.env ITSELF — in particular the
// Feishu H5 login family (BOTMUX_DASHBOARD_FEISHU_H5_*, APP_SECRET included),
// which is deliberately NOT included in the shared daemon env block
// (DAEMON_ENV_KEYS): included there, the secret would reach every bot daemon.
//
// The load is ALLOWLISTED (utils/dashboard-env.ts), not a wholesale dotenv:
// this process forks children that inherit its environment, so only keys with a
// named dashboard consumer are taken from the file.
import { join } from 'node:path';
import { homedir } from 'node:os';
import { existsSync } from 'node:fs';
import { installStdioEpipeGuard } from './utils/stdio-epipe-guard.js';
import {
  scrubClaudeSessionMarkerEnv,
  scrubInvokerTerminalEnv,
  scrubSessionCliHomeEnv,
  scrubSessionTurnMarkerEnv,
  scrubWorkflowWorkerEnv,
} from './utils/child-env.js';
import { loadDashboardEnvFile } from './utils/dashboard-env.js';

// Same pipe topology as the daemon: under pm2 the dashboard's stdout/stderr are
// pipes to the God daemon (→ dashboard-out/err.log). A broken pipe would
// surface as an unhandled 'error' and kill the dashboard, which registers no
// uncaughtException trap.
installStdioEpipeGuard();

// Load ~/.botmux/.env (same path logic as index-daemon.ts). This is the
// dashboard's ONLY channel for the H5 credential family and the fallback for
// any dashboard setting not included in the shared fleet env. Values already
// set still win, so the resolved DAEMON_ENV_KEYS snapshot keeps its deterministic
// resolveDaemonEnv semantics.
//
// ALLOWLISTED, not wholesale (see utils/dashboard-env.ts): that same file
// commonly holds credentials with no dashboard consumer — legacy
// LARK_APP_SECRET, GITHUB_TOKEN, model API keys — and this process forks debug
// shells, start/stop-bot children, a global npm/pnpm/bun install and herdr
// plugin installs, all of which inherit process.env. Only the keys the
// dashboard actually reads are merged in; the rest never enters the process.
const globalEnv = join(homedir(), '.botmux', '.env');
loadDashboardEnvFile(existsSync(globalEnv) ? globalEnv : '.env');

// The dashboard is never a session, but it is exposed to the same poisoning
// vector as the daemons: pm2 persists the env of whichever process ran `botmux
// restart` (and a stale dump.pm2 resurrect bypasses cli.ts pm2Env() entirely),
// so a restart issued from inside a botmux session would bake that session's
// identity into this long-lived process. Every key scrubbed here is one
// index-daemon.ts scrubs and has NO consumer anywhere in the dashboard's code
// (dashboard.ts + src/dashboard/**), while the dashboard DOES fork children
// that must not inherit it — debug terminals, start/stop-bot CLI runs, the
// detached update/restart driver. Per-key take:
//  - BOTMUX_SESSION_ID/BOTMUX_CHAT_ID/BOTMUX_CHAT_TYPE/BOTMUX_ROOT_MESSAGE_ID:
//    session routing identity; a leaked BOTMUX_SESSION_ID would make hook/CLI
//    gates in forked children mistake them for session context.
//  - BOTMUX_LARK_APP_ID: daemon-app identity. The dashboard is app-agnostic
//    (it aggregates every daemon over IPC) and its PM2 env block deliberately
//    sets no app id.
//  - BOTMUX_OWNER_OPEN_ID/__OWNER_OPEN_ID: app-scoped owner identity of the
//    issuing session; stale by definition here.
// Turn-scoped session identity and capabilities of the invoking bot session
// (routing ids, MCP gateway socket, sandbox verdicts, ...) — same canonical
// list index-daemon.ts scrubs. The hand-picked 7-key subset this used to be
// had fallen behind that list (e.g. BOTMUX_MCP_GATEWAY_SOCKET, IS_SANDBOX
// were never in it), silently letting a growing set of session-only values
// ride into every child this process forks (debug terminals, start/stop-bot
// CLI runs, the detached update/restart driver).
scrubSessionTurnMarkerEnv(process.env);
// CLAUDE_CONFIG_DIR / CODEX_HOME: per-session CLI data roots. No dashboard
// consumer; inherited into a debug-terminal CLI they redirect it into the
// leaking bot's home.
scrubSessionCliHomeEnv(process.env);
// Claude session-identity markers: inherited into a CLI forked from here (debug
// terminal) they mark it a nested child session → transcript saving OFF.
scrubClaudeSessionMarkerEnv(process.env);
// Workflow/goal worker identity: the dashboard is a workflow HOST surface,
// never a worker. dashboard.ts repeats this scrub at its own module top — kept
// there because a stale ecosystem/dump from an older install can still start
// dist/dashboard.js directly, bypassing this entry; doing it here as well keeps
// the new boundary complete without relying on that legacy call.
scrubWorkflowWorkerEnv(process.env);
// Invoker-terminal fingerprints (NO_COLOR=1 / CODEX_CI=1 / PAGER=cat from a
// non-interactive restart shell): inherited into a forked debug terminal they
// render it colorless. Re-pin TERM after, same constant index-daemon.ts uses.
scrubInvokerTerminalEnv(process.env);
process.env.TERM = 'xterm-256color';
// Deliberately NOT scrubbed, unlike index-daemon.ts: the Feishu H5 family
// (BOTMUX_DASHBOARD_FEISHU_H5_*). The dashboard process is its single
// legitimate consumer — delivering it is this entry point's purpose. The
// detached-restart / CLI-child boundaries strip it on the way out
// (detachedRestartEnv, redactChildEnv).

// CRITICAL: this MUST stay a dynamic import, and dashboard.ts itself must stay
// dotenv-free.
//  - dashboard.ts is a top-level side-effect module: importing it IS starting
//    it (servers listen during module evaluation; SIGTERM/SIGINT handlers are
//    registered at the end of the file; there is no main() to call).
//  - A static `import './dashboard.js'` would be hoisted: ESM evaluates static
//    dependencies BEFORE this module's body, so src/config.ts — which sits in
//    dashboard.ts's static import graph and reads process.env 36 times at
//    module level — would capture the environment from BEFORE the dotenv call
//    above. The same evaluation order is why "just add dotenv at the top of
//    dashboard.ts" cannot work: dashboard.ts's own static imports (config.ts
//    included) run before its first statement.
try {
  await import('./dashboard.js');
} catch (err) {
  console.error(`Fatal error: ${err}`);
  process.exit(1);
}
