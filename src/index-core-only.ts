#!/usr/bin/env node
// Core-only (headless / apiOnly) entrypoint. A SINGLE-PROCESS botmux daemon that
// serves the HTTP control API on 127.0.0.1:<BOTMUX_API_PORT> with NO Feishu
// credentials, NO bots.json, and NO pm2/dashboard sibling. Designed for riff's
// sandbox: the in-sandbox task-runner spawns this, waits for the ready line (or
// GET /healthz → 200), then drives codex via POST /api/trigger + poll
// /api/sessions/:id/trigger-result | /insight. Same daemon IPC contract; the
// trusted-host HMAC stays ON, with ONLY those riff-facing routes (+ /healthz)
// allowlisted as no-HMAC — every other IPC route still requires it (see daemon.ts).
//
// vs `botmux start` (the fleet path): that spawns pm2 + dashboard + a daemon per
// bot and BLOCKS on a missing larkAppSecret. Core-only skips all of it — one
// process, one synthetic apiOnly bot, fixed port, bind-or-fail.
import { config as dotenvConfig } from 'dotenv';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { existsSync, mkdirSync } from 'node:fs';
import { installStdioEpipeGuard } from './utils/stdio-epipe-guard.js';
import { scrubClaudeSessionMarkerEnv, scrubSessionCliHomeEnv } from './utils/child-env.js';

installStdioEpipeGuard();

const globalEnv = join(homedir(), '.botmux', '.env');
dotenvConfig({ path: existsSync(globalEnv) ? globalEnv : '.env' });

// Same boot-env hygiene as index-daemon: a daemon is never a session, so scrub
// any session-scoped vars that a parent (e.g. a botmux session that spawned us)
// might have leaked, or hook-runner / worker isolation would misbehave.
for (const k of ['BOTMUX_SESSION_ID', 'BOTMUX_LARK_APP_ID', 'BOTMUX_CHAT_ID', 'BOTMUX_CHAT_TYPE', 'BOTMUX_ROOT_MESSAGE_ID', 'BOTMUX_OWNER_OPEN_ID', '__OWNER_OPEN_ID']) {
  delete process.env[k];
}
scrubSessionCliHomeEnv(process.env);
scrubClaudeSessionMarkerEnv(process.env);

// Mark this process core-only BEFORE any config/daemon module loads: bot-registry
// synthesizes the apiOnly bot on this flag, and daemon.ts reads it for the
// fixed-port / no-probe / core-only-public-route / loopback IPC decisions.
process.env.BOTMUX_CORE_ONLY = '1';
// Strip BOTS_CONFIG entirely (codex P1): the config PARSER already ignores it for
// identity, but the raw env is inherited by every forked worker — an agent could
// `cat $BOTS_CONFIG` to read a real fleet.json (sibling secrets) if it points
// inside the working dir. Delete it here, AFTER dotenv, so neither the daemon nor
// any worker fork ever sees it. Its sole legitimate consumer (loadBotConfigs) is
// deliberately bypassed by the synthetic apiOnly config in core-only.
delete process.env.BOTS_CONFIG;
// Confine the worker HTTP (xterm/web terminal) to loopback (codex P1-4/P1-3): the
// daemon's terminal proxy is already forced to 127.0.0.1 for core-only, but the
// per-worker web server reads BOTMUX_WORKER_HTTP_HOST (default 0.0.0.0) from the
// env it inherits. Freeze it to loopback UNCONDITIONALLY — a parent/dotenv value
// of 0.0.0.0 must NOT survive and re-expose the worker on all interfaces. (A
// future intentional exposure would be a separate explicit danger switch.)
process.env.BOTMUX_WORKER_HTTP_HOST = '127.0.0.1';
delete process.env.BOTMUX_WORKER_HOST; // legacy alias — must not shadow the freeze
// Freeze the ADVERTISED web-terminal host to loopback too (form C). The line
// above confines where the worker web server BINDS; this confines the host
// baked into the read-only terminal URL that buildTerminalUrl() advertises.
// Without it, config.web.externalHost falls back to getWebExternalHost() →
// getLocalIp() (a LAN IP like 10.x.x.x), so the URL handed to riff would point
// at an interface the proxy doesn't even listen on (proxy is 127.0.0.1-only in
// core-only) — an in-sandbox VNC browser opening that URL would fail to connect.
// core-only is single-tenant loopback, so the terminal is only ever reached via
// 127.0.0.1; freeze the advertised host to match the bind. WEB_EXTERNAL_HOST is
// the env getWebExternalHost() reads first (config.ts:30), so this wins.
process.env.WEB_EXTERNAL_HOST = '127.0.0.1';


// Freeze a DEDICATED state root (codex P1): core-only must never inherit an
// ambient SESSION_DATA_DIR — a managed turn that spawns `serve --api-only`
// carries the host's SESSION_DATA_DIR, and the daemon would then read the real
// fleet's sessions and point its pid/descriptor/schedule-watcher/recovery/
// sandbox-sweep at that shared store. The SYNTHETIC identity was authoritative
// (bot-registry) but STORAGE authority was still parent-controlled. Overwrite
// SESSION_DATA_DIR authoritatively BEFORE any config module reads it:
//   • explicit BOTMUX_CORE_STATE_DIR (a deliberate core-only knob) wins, else
//   • a per-bot dedicated default ~/.botmux/core-only/<botId>/data — isolated
//     from the fleet's ~/.botmux/data and from any sibling core-only bot.
// The ambient SESSION_DATA_DIR value is discarded either way.
{
  const coreBotId = process.env.BOTMUX_API_ONLY_BOT || 'local_riff';
  const explicitStateDir = process.env.BOTMUX_CORE_STATE_DIR?.trim();
  const frozenStateDir = explicitStateDir
    ? explicitStateDir
    : join(homedir(), '.botmux', 'core-only', coreBotId, 'data');
  process.env.SESSION_DATA_DIR = frozenStateDir;
  // The fleet's ~/.botmux/data always pre-exists; a dedicated core-only root may
  // not. Create it (recursive, idempotent) so the daemon can write pid/descriptor/
  // sessions there from the first boot.
  try { mkdirSync(frozenStateDir, { recursive: true }); } catch { /* daemon will surface a real failure */ }
}

function fail(msg: string): never {
  console.error(`[core-only] ${msg}`);
  process.exit(1);
}

async function main() {
  const portRaw = process.env.BOTMUX_API_PORT;
  const port = Number(portRaw);
  if (!portRaw || !Number.isInteger(port) || port < 1 || port > 65535) {
    fail(`BOTMUX_API_PORT must be a valid port (1-65535); got: ${portRaw ?? '(unset)'}`);
  }

  {
    const { readGlobalConfig } = await import('./global-config.js');
    const { setDefaultLocale } = await import('./i18n/index.js');
    const cfg = readGlobalConfig();
    if (cfg.lang) setDefaultLocale(cfg.lang);
  }

  const { startDaemon } = await import('./daemon.js');
  const { logger } = await import('./utils/logger.js');

  logger.info(`Starting botmux core-only service on 127.0.0.1:${port}...`);
  // startDaemon() with no bot index → uses loadBotConfigs()[0], which
  // bot-registry synthesizes as a single apiOnly bot in core-only mode.
  // The ready line + fixed-port bind happen inside startDaemon (daemon.ts).
  await startDaemon();
}

main().catch((err) => {
  // Surface the exact bind failure (e.g. EADDRINUSE on the fixed port) so riff's
  // launcher sees WHY it never got the ready line, instead of a generic hang.
  console.error(`[core-only] fatal: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
