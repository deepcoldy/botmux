#!/usr/bin/env node
// Fleet supervisor entry (the `__supervisor` self-re-exec target, and the Node
// `dist/index-supervisor.js` script). Replaces pm2's God daemon: it owns the
// long-lived process that spawns + monitors every bot's daemon. Boot persistence
// stays with systemd/launchd, which run `botmux start` → this supervisor.
//
// Same boot hygiene as index-daemon: scrub any session-scoped env a parent may
// have leaked, so children don't inherit a stale identity.

import { config as dotenvConfig } from 'dotenv';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { existsSync, readFileSync } from 'node:fs';
import { installStdioEpipeGuard } from './utils/stdio-epipe-guard.js';
import { scrubClaudeSessionMarkerEnv, scrubSessionCliHomeEnv, scrubWorkflowWorkerEnv } from './utils/child-env.js';

installStdioEpipeGuard();

const configDir = join(homedir(), '.botmux');
const globalEnv = join(configDir, '.env');
dotenvConfig({ path: existsSync(globalEnv) ? globalEnv : '.env' });

// A supervisor is never a session (mirror index-daemon): scrub leaked identity.
for (const k of ['BOTMUX_SESSION_ID', 'BOTMUX_LARK_APP_ID', 'BOTMUX_CHAT_ID', 'BOTMUX_CHAT_TYPE', 'BOTMUX_ROOT_MESSAGE_ID', 'BOTMUX_OWNER_OPEN_ID', '__OWNER_OPEN_ID']) {
  delete process.env[k];
}
scrubSessionCliHomeEnv(process.env);
scrubClaudeSessionMarkerEnv(process.env);
scrubWorkflowWorkerEnv(process.env);

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
