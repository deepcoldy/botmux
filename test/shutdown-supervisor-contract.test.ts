import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  BOT_TURN_MUTATION_SHUTDOWN_ACQUIRE_TIMEOUT_MS,
  DAEMON_SHUTDOWN_MAX_MS,
  DAEMON_SHUTDOWN_OVERHEAD_MS,
  DAEMON_WORKER_EXIT_GRACE_MS,
  REMOTE_ADMISSION_RESTORE_TIMEOUT_MS,
  REMOTE_SHUTDOWN_BATCH_PERSIST_TIMEOUT_MS,
  REMOTE_SHUTDOWN_DRAIN_TIMEOUT_MS,
  REMOTE_SHUTDOWN_INITIAL_SNAPSHOT_TIMEOUT_MS,
} from '../src/core/shutdown-budgets.js';
import { DAEMON_GRACEFUL_EXIT_CODE } from '../src/core/supervisor-shutdown-protocol.js';
import { PM2_GRACEFUL_EXIT_CODE } from '../src/pm2-graceful-exit.js';
import { FLEET_GRACEFUL_EXIT_CODE } from '../src/core/fleet-supervisor-policy.js';

const cli = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');
const daemon = readFileSync(new URL('../src/daemon.ts', import.meta.url), 'utf8');
const dashboard = readFileSync(new URL('../src/dashboard.ts', import.meta.url), 'utf8');
const ipcServer = readFileSync(new URL('../src/core/dashboard-ipc-server.ts', import.meta.url), 'utf8');

// Contract for the built-in fleet supervisor (pm2-retired). The fleet lifecycle
// (start/stop/restart/status/logs/start-bot/stop-bot) runs under the supervisor;
// pm2 survives only as (a) the legacy-God reaper on upgrade, (b) an unrelated
// plugin-service / desktop feature, (c) the graceful-exit sentinel. These text
// assertions pin the migrated command shapes + the unchanged daemon-side
// graceful-shutdown ordering.
describe('graceful shutdown supervisor contract', () => {
  it('keeps a nonzero daemon-only graceful sentinel, shared by pm2 and the supervisor policy', () => {
    // The daemon exits with a nonzero sentinel on a clean shutdown so a supervisor
    // (pm2 historically, our FleetSupervisor now) can tell "shut down cleanly, do
    // NOT restart" from a crash. Signal death maps to 0 under pm2, hence nonzero.
    expect(DAEMON_GRACEFUL_EXIT_CODE).toBeGreaterThan(0);
    expect(DAEMON_GRACEFUL_EXIT_CODE).toBeLessThan(256);
    expect(DAEMON_GRACEFUL_EXIT_CODE).toBe(PM2_GRACEFUL_EXIT_CODE);
    // The built-in supervisor's policy uses the SAME sentinel, so a daemon's clean
    // exit suppresses a restart identically whether pm2 or the supervisor owns it.
    expect(FLEET_GRACEFUL_EXIT_CODE).toBe(DAEMON_GRACEFUL_EXIT_CODE);

    const shutdownStart = daemon.indexOf(
      'const shutdown = async (suppressPm2Restart: boolean) => {',
    );
    const shutdownEnd = daemon.indexOf("process.on('SIGTERM'", shutdownStart);
    const shutdown = daemon.slice(shutdownStart, shutdownEnd);
    expect(shutdown).toContain(
      'process.exit(gracefulProcessExitCode(suppressPm2Restart));',
    );
    expect(shutdown).not.toContain('process.exit(0);');
    expect(daemon).toContain("process.on('SIGINT', () => { shutdown(false)");
    expect(daemon).toContain('shutdown: () => shutdown(true)');
    expect(dashboard).toContain("process.on('SIGTERM', () => shutdown(true));");
    expect(dashboard).toContain("process.on('SIGINT', () => shutdown(false));");
  });

  it('keeps the outer daemon shutdown budget within bounds', () => {
    expect(DAEMON_SHUTDOWN_MAX_MS).toBe(
      BOT_TURN_MUTATION_SHUTDOWN_ACQUIRE_TIMEOUT_MS
      + REMOTE_SHUTDOWN_INITIAL_SNAPSHOT_TIMEOUT_MS
      + REMOTE_SHUTDOWN_DRAIN_TIMEOUT_MS
      + REMOTE_SHUTDOWN_BATCH_PERSIST_TIMEOUT_MS
      + Math.max(REMOTE_ADMISSION_RESTORE_TIMEOUT_MS, DAEMON_WORKER_EXIT_GRACE_MS)
      + DAEMON_SHUTDOWN_OVERHEAD_MS,
    );
    expect(DAEMON_SHUTDOWN_MAX_MS).toBeLessThanOrEqual(28_000);
  });

  // ─── Migrated fleet commands (supervisor, not pm2) ──────────────────────────

  it('public stop signals the supervisor and waits, under the fleet lock', () => {
    // Post-pm2: cmdStop signals the single supervisor (which SIGTERMs every daemon
    // + finalizes state) and waits for it to exit — all under the fleet lock. No
    // pm2 jlist/stop/delete per-row dance.
    const start = cli.indexOf('async function cmdStop()');
    const end = cli.indexOf('async function cmdRestart()', start);
    const stop = cli.slice(start, end);
    const lock = stop.indexOf('withFileLock(PM2_FLEET_MUTATION_LOCK_TARGET');
    const call = stop.indexOf('stopFleet()', lock);
    expect(lock).toBeGreaterThanOrEqual(0);
    expect(call).toBeGreaterThan(lock);
    expect(stop).not.toContain("runPm2(['stop'");
    expect(stop).not.toContain("runPm2(['delete'");
    expect(stop).not.toContain("pm2Capture(['jlist'])");
    expect(stop).not.toContain('signalAndAwaitBotmuxProcesses');
    expect(stop).toContain("result.action === 'timeout'");
    expect(stop).toContain('stopPluginServicesForCli(undefined, { autoOnly: true })');
  });

  it('restart stages intent, restarts the supervisor, verifies health, then commits the breadcrumb', () => {
    // consume staged intent → write attempt breadcrumb → restartFleet() (stop old
    // supervisor + start fresh) → waitFleetOnline() health gate → commit only if
    // healthy; any failure removes the attempt (no false restart summary).
    const start = cli.indexOf('async function cmdRestart()');
    const end = cli.indexOf('export type StartBotLiveResult', start);
    const restart = cli.slice(start, end);
    const consume = restart.indexOf('consumeRestartIntentTo(');
    const writeIntent = restart.indexOf('writeRestartAttemptIntentTo(', consume);
    const restartFleet = restart.indexOf('restartFleet()', writeIntent);
    const health = restart.indexOf('waitFleetOnline(', restartFleet);
    const removeOnFail = restart.indexOf('removeRestartIntentAttemptTo(', health);
    const commit = restart.indexOf('commitRestartIntentAttemptTo(', health);
    expect(consume).toBeGreaterThanOrEqual(0);
    expect(writeIntent).toBeGreaterThan(consume);
    expect(restartFleet).toBeGreaterThan(writeIntent);
    expect(health).toBeGreaterThan(restartFleet);
    expect(removeOnFail).toBeGreaterThan(health);
    expect(commit).toBeGreaterThan(health);
    expect(restart).toContain('withFileLock(PM2_FLEET_MUTATION_LOCK_TARGET');
    expect(restart).not.toContain('runBoundedPm2StartTransaction(');
    expect(restart).not.toContain('rollbackPm2StartAttempt(');
    expect(restart).not.toContain("runPm2(['start'");
    expect(restart).not.toContain('ecosystemConfig(');
    expect(restart).toContain('health.healthy');
  });

  it('idempotent start is a supervisor no-op when a live supervisor already owns the fleet', () => {
    const start = cli.indexOf('async function cmdStart()');
    const end = cli.indexOf('/**\n * Wipe stale dashboard-daemon descriptors', start);
    const region = cli.slice(start, end);
    expect(region).toContain('startFleetViaSupervisor()');
    expect(region).toContain("result.action === 'already-running'");
    expect(region).not.toContain('readAndAssertConfiguredFleetOnline(');
    expect(region).not.toContain('runBoundedPm2StartTransaction(');
  });

  it('every fleet surface (start/stop/restart/start-bot/stop-bot) is supervisor-managed, not pm2', () => {
    const cmdStart = cli.slice(
      cli.indexOf('async function cmdStart()'),
      cli.indexOf('/**\n * Wipe stale dashboard-daemon descriptors'),
    );
    const cmdRestart = cli.slice(
      cli.indexOf('async function cmdRestart()'),
      cli.indexOf('export type StartBotLiveResult'),
    );
    const startBot = cli.slice(
      cli.indexOf('async function ensureBotDaemonStarted('),
      cli.indexOf('/**\n * `botmux start-bot'),
    );
    const stopBot = cli.slice(
      cli.indexOf('async function ensureBotDaemonStopped('),
      cli.indexOf('/**\n * Bring a SINGLE bot'),
    );
    expect(cmdStart).toContain('startFleetViaSupervisor()');
    expect(cmdRestart).toContain('restartFleet()');
    expect(startBot).toContain('startBotViaSupervisor(');
    expect(stopBot).toContain('stopBotViaSupervisor(');
    for (const [label, region] of [['start', cmdStart], ['restart', cmdRestart], ['start-bot', startBot], ['stop-bot', stopBot]] as const) {
      expect(region, label).not.toContain('runBoundedPm2StartTransaction(');
      expect(region, label).not.toContain('ecosystemConfig(');
      expect(region, label).not.toContain("runPm2(['start'");
    }
  });

  it('start-bot keeps the activation-readiness gate and only runs under the fleet lock', () => {
    const start = cli.indexOf('async function ensureBotDaemonStarted(');
    const end = cli.indexOf('/**\n * `botmux start-bot', start);
    const region = cli.slice(start, end);
    expect(region).toContain('withFileLock(PM2_FLEET_MUTATION_LOCK_TARGET');
    expect(region).toContain('activationPending');
    expect(region).toContain('is still deactivating');
    expect(region).toContain('conflicting activation markers');
    expect(region).toContain('startBotViaSupervisor(');
  });

  it('serializes every fleet mutation surface on one async fleet lock', () => {
    const regions = [
      ['start', 'async function cmdStart()', '/**\n * Wipe stale dashboard-daemon descriptors'],
      ['stop', 'async function cmdStop()', 'async function cmdRestart()'],
      ['restart', 'async function cmdRestart()', 'export type StartBotLiveResult'],
      ['start-bot', 'async function ensureBotDaemonStarted(', '/**\n * `botmux start-bot'],
      ['stop-bot', 'async function ensureBotDaemonStopped(', '/**\n * Bring a SINGLE bot'],
    ] as const;
    for (const [label, startMarker, endMarker] of regions) {
      const start = cli.indexOf(startMarker);
      const end = cli.indexOf(endMarker, start);
      const region = cli.slice(start, end);
      expect(start, label).toBeGreaterThanOrEqual(0);
      expect(end, label).toBeGreaterThan(start);
      expect(region, label).toContain('withFileLock(PM2_FLEET_MUTATION_LOCK_TARGET');
      expect(region, label).not.toContain('withFileLockSync(PM2_FLEET_MUTATION_LOCK_TARGET');
    }
  });

  it('reaps a legacy pm2 God via the self-contained reaper (not the deleted guard chain)', () => {
    // cleanupLegacyPm2 now delegates to reapLegacyPm2 — no pm2 jlist/projection
    // helper chain in cli.ts anymore.
    const start = cli.indexOf('function cleanupLegacyPm2(');
    const end = cli.indexOf('async function cmdStop()', start);
    const legacy = cli.slice(start, end);
    expect(legacy).toContain('reapLegacyPm2(CONFIG_DIR, PKG_ROOT');
    expect(legacy).not.toContain('listPm2GodDaemonPids(');
    expect(legacy).not.toContain('deleteAllBotmuxProcesses(');
    expect(legacy).not.toContain('bootstrapDeleteAllBotmuxProcesses(');
    // The whole pm2 guard chain is gone from cli.ts.
    expect(cli).not.toContain('function runPm2(');
    expect(cli).not.toContain('function ecosystemConfig(');
    expect(cli).not.toContain('function signalAndAwaitBotmuxProcesses(');
    expect(cli).not.toContain('function cmdInternalPm2StartExact(');
    expect(cli).not.toContain("case '__pm2-start-exact'");
  });

  // ─── Daemon-side graceful shutdown (unchanged by the pm2→supervisor migration)

  it('takes one Riff snapshot, batch-persists, then generation-checks and commits before service stop', () => {
    const start = daemon.indexOf(
      'const shutdown = async (suppressPm2Restart: boolean) => {',
    );
    const stop = daemon.indexOf('scheduler.stopScheduler();', start);
    const boundedGate = daemon.indexOf('tryWithBotTurnMutation(', start);
    const initialUnique = daemon.indexOf(
      'collectUniqueDaemonShutdownSessions(activeSessions.values())',
      boundedGate,
    );
    const prepareAll = daemon.indexOf('prepareRemoteFleetForShutdown(remoteCandidates', initialUnique);
    const persistAll = daemon.indexOf('persistPreparedRemoteShutdownFleet(remotePrepared', prepareAll);
    const currentUnique = daemon.indexOf(
      'collectUniqueDaemonShutdownSessions(activeSessions.values())',
      initialUnique + 1,
    );
    const secondCheck = daemon.indexOf('const remoteGenerationMismatch', persistAll);
    const commitAll = daemon.indexOf('commitPreparedRemoteShutdown(ds, result)', secondCheck);
    const teardownUnique = daemon.indexOf(
      'for (const ds of currentShutdownFleet.sessions)',
      commitAll,
    );
    expect(boundedGate).toBeGreaterThan(start);
    expect(initialUnique).toBeGreaterThan(boundedGate);
    expect(prepareAll).toBeGreaterThan(initialUnique);
    expect(persistAll).toBeGreaterThan(prepareAll);
    expect(currentUnique).toBeGreaterThan(persistAll);
    expect(secondCheck).toBeGreaterThan(currentUnique);
    expect(commitAll).toBeGreaterThan(secondCheck);
    expect(teardownUnique).toBeGreaterThan(commitAll);
    expect(stop).toBeGreaterThan(commitAll);
    expect(daemon.slice(start, stop)).toContain('abortRemoteShutdownFleet(');
    expect(daemon.slice(start, stop)).toContain('canAbortVerifiedExitedRemotePreparation(');
  });

  it('publishes shutdown capability only after both signal handlers are installed', () => {
    const descStart = daemon.indexOf('const desc: DaemonDescriptor = {');
    const firstDescriptorWrite = daemon.indexOf('writeDaemonDescriptor(desc);', descStart);
    const sigtermHandler = daemon.indexOf("process.on('SIGTERM'", firstDescriptorWrite);
    const sigintHandler = daemon.indexOf("process.on('SIGINT'", sigtermHandler);
    const capabilityCommit = daemon.indexOf(
      'desc.supervisorShutdownProtocol = SUPERVISOR_SHUTDOWN_PROTOCOL;',
      sigintHandler,
    );
    const ipcHandlerReady = daemon.indexOf('setSupervisorShutdownHandler({', sigintHandler);
    const attestedWrite = daemon.indexOf('writeDaemonDescriptor(desc);', capabilityCommit);

    expect(descStart).toBeGreaterThanOrEqual(0);
    expect(firstDescriptorWrite).toBeGreaterThan(descStart);
    expect(daemon.slice(descStart, firstDescriptorWrite))
      .not.toContain('supervisorShutdownProtocol: SUPERVISOR_SHUTDOWN_PROTOCOL');
    expect(sigtermHandler).toBeGreaterThan(firstDescriptorWrite);
    expect(sigintHandler).toBeGreaterThan(sigtermHandler);
    expect(ipcHandlerReady).toBeGreaterThan(sigintHandler);
    expect(capabilityCommit).toBeGreaterThan(ipcHandlerReady);
    expect(attestedWrite).toBeGreaterThan(capabilityCommit);
  });

  it('keeps supervisor shutdown host-authenticated and exact boot/birth bound', () => {
    const route = ipcServer.slice(
      ipcServer.indexOf("ipcRoute('POST', SUPERVISOR_SHUTDOWN_ROUTE"),
      ipcServer.indexOf('export async function readJsonBody',
        ipcServer.indexOf("ipcRoute('POST', SUPERVISOR_SHUTDOWN_ROUTE")),
    );
    expect(route).toContain('isTrustedHostIpcRequest(req)');
    expect(route).toContain('isExactSupervisorShutdownRequest(registration, body)');
    expect(route).toContain('jsonRes(res, 202');
    expect(route.indexOf('jsonRes(res, 202')).toBeLessThan(route.indexOf('registration.shutdown()'));
  });
});
