#!/usr/bin/env node
// Fleet supervisor entry (the `__supervisor` self-re-exec target, and the Node
// `dist/index-supervisor.js` script). Replaces pm2's God daemon: it owns the
// long-lived process that spawns + monitors every bot's daemon. Boot persistence
// stays with systemd/launchd, which run `botmux start` → this supervisor.
//
// Same boot hygiene as index-daemon: scrub any session-scoped env a parent may
// have leaked, so children don't inherit a stale identity.

import { join } from 'node:path';
import { homedir } from 'node:os';
import { installStdioEpipeGuard } from './utils/stdio-epipe-guard.js';
import {
  scrubClaudeSessionMarkerEnv,
  scrubInvokerTerminalEnv,
  scrubSessionCliHomeEnv,
  scrubSessionTurnMarkerEnv,
  scrubWorkflowWorkerEnv,
  stripDashboardH5Env,
} from './utils/child-env.js';
import { scrubDetachedRestartEnvRefresh } from './core/restart-env-refresh.js';

installStdioEpipeGuard();

const configDir = join(homedir(), '.botmux');

// The supervisor deliberately does NOT wholesale-load ~/.botmux/.env: that file
// carries the Dashboard-only Feishu H5 login family, and the supervisor is not
// its consumer (the dashboard reloads it itself via index-dashboard.ts). Any
// INHERITED copy still has to go, because resolveFleetDaemonEnv() below spreads
// this process's env into every supervised member — an unstripped secret would
// sit in this long-lived process for its whole life and ride into every bot
// daemon (which then strips it again at its own boot).
//
// This also cuts the ambient-env inheritance path into the dashboard
// (supervisor is its parent; daemon is not). That's intentional: aligned
// with the long-standing scrubPm2CallerEnv convention on the pm2 path; the
// supervisor form never had this boundary before. The documented channel
// remains ~/.botmux/.env — the dashboard loads that file itself.
stripDashboardH5Env(process.env);
// A supervisor is never a session (mirror index-daemon): a `botmux
// start/restart` issued from inside a bot session leaks that session's
// identity/capabilities into this long-lived process, and
// resolveFleetDaemonEnv() bakes whatever remains here into every daemon
// child's starting env for the supervisor's whole lifetime. Match
// index-daemon.ts's boot scrub exactly (rather than a hand-picked subset of
// keys) so this boundary can't silently fall behind the next key added there.
scrubSessionTurnMarkerEnv(process.env);
scrubSessionCliHomeEnv(process.env);
scrubClaudeSessionMarkerEnv(process.env);
scrubWorkflowWorkerEnv(process.env);
scrubInvokerTerminalEnv(process.env);
process.env.TERM = 'xterm-256color';
scrubDetachedRestartEnvRefresh(process.env);

async function main(): Promise<void> {
  const { FleetSupervisor } = await import('./core/fleet-supervisor.js');
  const { fleetStatePath, fleetDistDir, fleetLogDir, fleetCommandPath, resolveFleetBots, resolveFleetMembers, resolveFleetDaemonEnv, fleetDaemonNodeArgs } = await import('./core/fleet-runtime.js');
  const { drainFleetCommands } = await import('./core/fleet-command-queue.js');
  const { logger } = await import('./utils/logger.js');

  // Every supervised member: the bot daemons from bots.json PLUS the dashboard.
  // The dashboard is always present (mirrors the old pm2 ecosystem, which always
  // pushed a botmux-dashboard app), so the supervisor stays up to run it even
  // with zero bots configured — that's exactly the state where an operator opens
  // the dashboard to add their first bot.
  const members = resolveFleetMembers();
  const botCount = resolveFleetBots().length;

  const supervisor = new FleetSupervisor({
    statePath: fleetStatePath(),
    distDir: fleetDistDir(),
    daemonEnv: resolveFleetDaemonEnv(),
    cwd: configDir,
    daemonNodeArgs: fleetDaemonNodeArgs(),
    logDir: fleetLogDir(),
    log: (m) => logger.info(`[supervisor] ${m}`),
  });

  let shuttingDown = false;
  const shutdown = async (sig: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`[supervisor] ${sig} → stopping fleet`);
    await supervisor.stopAll();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  // SIGHUP = "drain the single-bot command queue" (start-bot / stop-bot). The CLI
  // enqueues a command under the fleet lock then signals us; we own the daemon
  // children so we perform the spawn/stop. Serialized so overlapping SIGHUPs
  // (or one arriving mid-drain) can't interleave two drains.
  let draining = false;
  let drainAgain = false;
  const drain = async () => {
    if (shuttingDown) return;
    if (draining) { drainAgain = true; return; }
    draining = true;
    try {
      do {
        drainAgain = false;
        const commands = drainFleetCommands(fleetCommandPath());
        if (commands.length > 0) {
          logger.info(`[supervisor] SIGHUP → draining ${commands.length} command(s)`);
          await supervisor.drainCommands(commands);
        }
      } while (drainAgain);
    } finally {
      draining = false;
    }
  };
  process.on('SIGHUP', () => void drain());

  logger.info(`[supervisor] starting fleet: ${botCount} bot(s) + dashboard`);
  supervisor.start(members);
  // Keep the process alive supervising; children + timers hold the event loop.
}

main().catch((err) => {
  console.error(`[supervisor] fatal: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
