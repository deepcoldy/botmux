import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  BOT_TURN_MUTATION_SHUTDOWN_ACQUIRE_TIMEOUT_MS,
  DAEMON_SHUTDOWN_MAX_MS,
  DAEMON_SHUTDOWN_OVERHEAD_MS,
  DAEMON_WORKER_EXIT_GRACE_MS,
  FLEET_DAEMON_EXIT_WAIT_MS,
  FLEET_SUCCESSOR_SETTLE_MS,
  PM2_DAEMON_KILL_TIMEOUT_MS,
  PM2_DAEMON_RESTART_DELAY_MS,
  RIFF_ADMISSION_RESTORE_TIMEOUT_MS,
  RIFF_SHUTDOWN_BATCH_PERSIST_TIMEOUT_MS,
  RIFF_SHUTDOWN_DRAIN_TIMEOUT_MS,
  RIFF_SHUTDOWN_INITIAL_SNAPSHOT_TIMEOUT_MS,
} from '../src/core/shutdown-budgets.js';
import { DAEMON_GRACEFUL_EXIT_CODE } from '../src/core/supervisor-shutdown-protocol.js';

const cli = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');
const daemon = readFileSync(new URL('../src/daemon.ts', import.meta.url), 'utf8');
const fleetShutdown = readFileSync(new URL('../src/cli/fleet-shutdown.ts', import.meta.url), 'utf8');
const ipcServer = readFileSync(new URL('../src/core/dashboard-ipc-server.ts', import.meta.url), 'utf8');
const pm2Preflight = readFileSync(new URL('../src/cli/pm2-preflight.ts', import.meta.url), 'utf8');
const botsStore = readFileSync(new URL('../src/setup/bots-store.ts', import.meta.url), 'utf8');
const bundledPm2God = readFileSync(new URL('../node_modules/pm2/lib/God.js', import.meta.url), 'utf8');

describe('graceful shutdown supervisor contract', () => {
  it('uses a nonzero daemon-only graceful sentinel because PM2 maps signal death to zero', () => {
    expect(DAEMON_GRACEFUL_EXIT_CODE).toBeGreaterThan(0);
    expect(DAEMON_GRACEFUL_EXIT_CODE).toBeLessThan(256);
    expect(bundledPm2God).toContain('God.handleExit(clu, code || 0, signal);');

    const ecosystemStart = cli.indexOf('function ecosystemConfig(');
    const daemonPolicy = cli.slice(ecosystemStart, cli.indexOf('const apps:', ecosystemStart));
    const dashboardPolicy = cli.slice(
      cli.indexOf("name: 'botmux-dashboard'", ecosystemStart),
      cli.indexOf('const cfg = { apps };', ecosystemStart),
    );
    expect(daemonPolicy).toContain('stop_exit_codes: [DAEMON_GRACEFUL_EXIT_CODE]');
    expect(daemonPolicy).not.toContain('stop_exit_codes: [0]');
    expect(dashboardPolicy).toContain('stop_exit_codes: [0]');

    const shutdownStart = daemon.indexOf('const shutdown = async () => {');
    const shutdownEnd = daemon.indexOf("process.on('SIGTERM'", shutdownStart);
    const shutdown = daemon.slice(shutdownStart, shutdownEnd);
    expect(shutdown).toContain('process.exit(DAEMON_GRACEFUL_EXIT_CODE);');
    expect(shutdown).not.toContain('process.exit(0);');
    expect(cli).toContain('assertDaemonPm2GracefulExitPolicy(');
    expect(cli).toContain('`${operation}-handler-ready-pm2-policy`');

    const projectionStart = cli.indexOf('function toBotmuxPm2ProcessEntry(');
    const projectionEnd = cli.indexOf('function readVerifiedBotmuxPm2Projection(', projectionStart);
    const projection = cli.slice(projectionStart, projectionEnd);
    expect(projection).toContain(
      'stopExitCodes: normalizeRawPm2StopExitCodes(rawStopExitCodes)',
    );
    expect(projection).not.toContain('.map(code => parsePm2Integer(code))');
    expect(bundledPm2God).toContain(
      "stopExitCodes.map((strOrNum) => typeof strOrNum === 'string' ? parseInt(strOrNum, 10) : strOrNum)",
    );
    expect(bundledPm2God).toContain('proc.pm2_env.unstable_restarts >= max_restarts');
    expect(bundledPm2God).toContain('if (!stopping && !overlimit)');
    expect(fleetShutdown).toContain('isFleetEntryProvenTerminalAfterSignal(exactState)');
    expect(fleetShutdown).toContain('post-signal terminal proof');
    expect(fleetShutdown).toContain('latestTrackedPidByName.get(trackedEntry.name) === pid');
    expect(fleetShutdown).toContain('a later missing row is never success');
    expect(fleetShutdown).toContain('liveReplacementPublished');
    expect(fleetShutdown).toContain("replacement's own");
  });

  it('keeps outer supervisor budgets beyond both success and abort-restore paths', () => {
    expect(DAEMON_SHUTDOWN_MAX_MS).toBe(
      BOT_TURN_MUTATION_SHUTDOWN_ACQUIRE_TIMEOUT_MS
      + RIFF_SHUTDOWN_INITIAL_SNAPSHOT_TIMEOUT_MS
      + RIFF_SHUTDOWN_DRAIN_TIMEOUT_MS
      + RIFF_SHUTDOWN_BATCH_PERSIST_TIMEOUT_MS
      + Math.max(RIFF_ADMISSION_RESTORE_TIMEOUT_MS, DAEMON_WORKER_EXIT_GRACE_MS)
      + DAEMON_SHUTDOWN_OVERHEAD_MS,
    );
    expect(DAEMON_SHUTDOWN_MAX_MS).toBeLessThanOrEqual(28_000);
    expect(PM2_DAEMON_KILL_TIMEOUT_MS).toBeGreaterThan(DAEMON_SHUTDOWN_MAX_MS);
    expect(FLEET_DAEMON_EXIT_WAIT_MS).toBeGreaterThan(PM2_DAEMON_KILL_TIMEOUT_MS);
    expect(FLEET_SUCCESSOR_SETTLE_MS).toBeGreaterThan(PM2_DAEMON_RESTART_DELAY_MS);
    expect(FLEET_DAEMON_EXIT_WAIT_MS)
      .toBeGreaterThan(DAEMON_SHUTDOWN_MAX_MS + FLEET_SUCCESSOR_SETTLE_MS);
    expect(FLEET_DAEMON_EXIT_WAIT_MS)
      .toBeGreaterThan(PM2_DAEMON_KILL_TIMEOUT_MS + FLEET_SUCCESSOR_SETTLE_MS);
  });

  it('public stop signals and polls first, never deletes a possibly refusing entry', () => {
    const start = cli.indexOf('async function cmdStop()');
    const end = cli.indexOf('async function cmdRestart()', start);
    const stop = cli.slice(start, end);
    const signal = stop.indexOf("signalAndAwaitBotmuxProcesses(entries, 'stop')");
    const preMutationProjection = stop.indexOf(
      "readVerifiedBotmuxPm2Projection('stop-before-registry-mutation')",
      signal,
    );
    const pm2Stop = stop.indexOf("runPm2(['stop', String(entry.pmId)])", preMutationProjection);
    const justInTime = stop.indexOf(
      "revalidateExactQuiescentRowBeforeMutation(\n        'stop-immediately-before-registry-mutation'",
      preMutationProjection,
    );
    const exactStop = stop.indexOf(
      "runPm2(['stop', String(exact.pmId)]",
      justInTime,
    );

    expect(signal).toBeGreaterThanOrEqual(0);
    expect(preMutationProjection).toBeGreaterThan(signal);
    expect(pm2Stop).toBe(-1);
    expect(justInTime).toBeGreaterThan(preMutationProjection);
    expect(exactStop).toBeGreaterThan(justInTime);
    expect(stop).not.toContain("runPm2(['delete'");
    expect(stop).toContain('if (includePluginServices) await stopPluginServicesForCli');
    expect(stop).toContain('const stopErrors: string[] = []');
    expect(stop.indexOf("pm2Capture(['jlist'])", exactStop)).toBeGreaterThan(exactStop);
    expect(stop.indexOf("assertNoUnregisteredLiveDaemonDescriptors('stop-after-registry-mutation'", exactStop))
      .toBeGreaterThan(exactStop);
    expect(stop).toContain('PM2 registry mutation incomplete');
  });

  it('restart waits for the fleet decision before any PM2 delete', () => {
    const start = cli.indexOf('function deleteAllBotmuxProcesses(');
    const end = cli.indexOf('/**\n * One-time migration', start);
    const restart = cli.slice(start, end);
    const signal = restart.indexOf("signalAndAwaitBotmuxProcesses(entries, 'restart', home");
    const justInTime = restart.indexOf(
      "revalidateExactQuiescentRowBeforeMutation(\n        'restart-before-delete'",
      signal,
    );
    const remove = restart.indexOf("runPm2(['delete', String(exact.pmId)]", justInTime);
    expect(signal).toBeGreaterThanOrEqual(0);
    expect(justInTime).toBeGreaterThan(signal);
    expect(remove).toBeGreaterThan(justInTime);
    expect(restart).not.toContain("runPm2(['delete', ...exactIds]");
    expect(restart.indexOf("pm2Capture(['jlist'], home)", remove)).toBeGreaterThan(remove);
    expect(restart.indexOf("assertNoUnregisteredLiveDaemonDescriptors(\n      'restart-after-delete'", remove))
      .toBeGreaterThan(remove);
    expect(restart).toContain('PM2 delete left registry entries');
  });

  it('takes one Riff snapshot, batch-persists, then generation-checks and commits before service stop', () => {
    const start = daemon.indexOf('const shutdown = async () => {');
    const stop = daemon.indexOf('scheduler.stopScheduler();', start);
    const boundedGate = daemon.indexOf('tryWithBotTurnMutation(', start);
    const initialUnique = daemon.indexOf(
      'collectUniqueDaemonShutdownSessions(activeSessions.values())',
      boundedGate,
    );
    const prepareAll = daemon.indexOf('prepareRiffFleetForShutdown(riffCandidates', initialUnique);
    const persistAll = daemon.indexOf('persistPreparedRiffShutdownFleet(riffPrepared', prepareAll);
    const currentUnique = daemon.indexOf(
      'collectUniqueDaemonShutdownSessions(activeSessions.values())',
      initialUnique + 1,
    );
    const secondCheck = daemon.indexOf('const riffGenerationMismatch', persistAll);
    const commitAll = daemon.indexOf('commitPreparedRiffShutdown(ds, result)', secondCheck);
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
    expect(daemon.slice(start, stop)).toContain('abortRiffShutdownFleet(');
    expect(daemon.slice(start, stop)).toContain('canAbortVerifiedExitedRiffPreparation(');
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

  it('uses exact-id conditional PM2 start for proven-offline compensation, never public start/restart', () => {
    const start = cli.indexOf('startOffline: (offlineEntries, timeoutMs) =>');
    const end = cli.indexOf('\n    list,', start);
    const compensation = cli.slice(start, end);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(compensation).toContain('runExactPm2Starts(offlineEntries');
    expect(compensation).not.toContain("runPm2(['start'");
    expect(compensation).not.toContain("runPm2(['restart'");
  });

  it('serializes every core PM2 mutation surface on one async fleet lock', () => {
    const regions = [
      ['start', 'async function cmdStart()', '/**\n * Wipe stale dashboard-daemon descriptors'],
      ['stop', 'async function cmdStop()', 'async function cmdRestart()'],
      ['restart', 'async function cmdRestart()', '/**\n * Bring a SINGLE bot'],
      ['start-bot', 'async function ensureBotDaemonStarted(', '/**\n * `botmux start-bot'],
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

    const exactHelper = cli.slice(
      cli.indexOf('async function cmdInternalPm2StartExact('),
      cli.indexOf('function runExactPm2Starts(', cli.indexOf('async function cmdInternalPm2StartExact(')),
    );
    expect(exactHelper).toContain('BOTMUX_PM2_FLEET_LOCK_OWNER_PID');
    expect(exactHelper).toContain('PM2_FLEET_MUTATION_LOCK_TARGET}.lock');
    expect(exactHelper).toContain('lockPid !== process.ppid');
  });

  it('fails closed before PM2 mutation on duplicate Gods, stale preflight, or unregistered descriptors', () => {
    const duplicateStart = cli.indexOf('function listSingletonPm2GodDaemonPidsForMutation(');
    const duplicateEnd = cli.indexOf('function runPm2(', duplicateStart);
    const duplicate = cli.slice(duplicateStart, duplicateEnd);
    expect(duplicate).toContain('multiple PM2 God daemons');
    expect(duplicate).not.toContain("process.kill(pid, 'SIGTERM')");
    expect(duplicate).not.toContain("process.kill(pid, 'SIGKILL')");

    const preflightStart = cli.indexOf('function preflightNodeSanity(');
    const preflightEnd = cli.indexOf('async function cmdStart()', preflightStart);
    const preflight = cli.slice(preflightStart, preflightEnd);
    expect(preflight).toContain('assertLinuxPm2GodExecutableUsable(pm2Pid)');
    expect(preflight).toContain('listPm2GodDaemonPids(home)');
    expect(preflight).not.toContain("join(PM2_HOME, 'pm2.pid')");
    expect(preflight).not.toContain("runPm2(['kill']");
    expect(preflight).not.toContain("'SIGKILL'");
    expect(pm2Preflight).toContain('拒绝自动清理');

    for (const operation of ['start', 'stop', 'start-bot', 'restart-start']) {
      expect(cli).toContain(`assertNoUnregisteredLiveDaemonDescriptors('${operation}'`);
    }
  });

  it('publishes manual restart intent only after verified fleet retirement', () => {
    const start = cli.indexOf('async function cmdRestart()');
    const end = cli.indexOf('/**\n * Bring a SINGLE bot', start);
    const restart = cli.slice(start, end);
    const staged = restart.indexOf('consumeRestartIntentTo(');
    const preflight = restart.indexOf('assertNoDuplicatePm2GodDaemons()', staged);
    const retirement = restart.indexOf('deleteAllBotmuxProcesses()');
    const descriptorCheck = restart.indexOf(
      "assertNoUnregisteredLiveDaemonDescriptors('restart-start'",
      retirement,
    );
    const intent = restart.indexOf('writeRestartAttemptIntentTo(', descriptorCheck);
    const transaction = restart.indexOf("runBoundedPm2StartTransaction(\n      'restart-start'", intent);
    const newFleet = restart.indexOf("runPm2(['start', cfg]", transaction);
    const verify = restart.indexOf("'restart-after-launch'", newFleet);
    const compensate = restart.indexOf("rollbackPm2StartAttempt(\n          'restart-start'", verify);
    const rollback = restart.indexOf('removeRestartIntentAttemptTo(', compensate);
    const commit = restart.indexOf('commitRestartIntentAttemptTo(', rollback);
    expect(staged).toBeGreaterThanOrEqual(0);
    expect(preflight).toBeGreaterThan(staged);
    expect(retirement).toBeGreaterThanOrEqual(0);
    expect(descriptorCheck).toBeGreaterThan(retirement);
    expect(intent).toBeGreaterThan(descriptorCheck);
    expect(transaction).toBeGreaterThan(intent);
    expect(newFleet).toBeGreaterThan(transaction);
    expect(verify).toBeGreaterThan(newFleet);
    expect(compensate).toBeGreaterThan(verify);
    expect(rollback).toBeGreaterThan(compensate);
    expect(commit).toBeGreaterThan(rollback);
  });

  it('bounds and freshly verifies every public PM2 start surface with compensation', () => {
    expect(cli).toContain('const PM2_START_VERIFY_MIN_TIMEOUT_MS = 60_000;');
    expect(cli).toContain('pm2StartVerifyTimeoutMs(configuredNames.length)');
    const regions = [
      cli.slice(cli.indexOf('async function cmdStart()'), cli.indexOf('/**\n * Wipe stale dashboard-daemon descriptors')),
      cli.slice(cli.indexOf('async function cmdRestart()'), cli.indexOf('/**\n * Bring a SINGLE bot')),
      cli.slice(cli.indexOf('async function ensureBotDaemonStarted('), cli.indexOf('/**\n * `botmux start-bot')),
    ];
    for (const region of regions) {
      expect(region).toContain('runBoundedPm2StartTransaction(');
      expect(region).toContain('PM2_START_COMMAND_TIMEOUT_MS');
      expect(region).toContain('readAndAssertConfiguredFleetOnline(');
      expect(region).toContain('rollbackPm2StartAttempt(');
      expect(region).toContain('timeoutMs');
    }
  });

  it('holds one bots.json generation from ecosystem rendering through verification/rollback', () => {
    expect(botsStore).toContain('withFileLockSync(botsJsonPath');
    const regions = [
      cli.slice(cli.indexOf('async function cmdStart()'), cli.indexOf('/**\n * Wipe stale dashboard-daemon descriptors')),
      cli.slice(cli.indexOf('async function cmdRestart()'), cli.indexOf('/**\n * Bring a SINGLE bot')),
      cli.slice(cli.indexOf('async function ensureBotDaemonStarted('), cli.indexOf('/**\n * `botmux start-bot')),
    ];
    for (const region of regions) {
      expect(region).toContain('withFileLock(BOTS_JSON_FILE');
      expect(region).toContain('ecosystemConfig(');
      expect(region).toContain('configuredCoreProcessNames(');
      expect(region).toContain('assertBotsConfigSnapshotUnchanged(');
    }
  });

  it('admits start-bot only through the exact configured fleet classifier', () => {
    const start = cli.indexOf('async function ensureBotDaemonStarted(');
    const end = cli.indexOf('/**\n * `botmux start-bot', start);
    const region = cli.slice(start, end);
    expect(region).toContain('classifyStartBotFleetAdmission(');
    expect(region).toContain("admission.state === 'already-online'");
    const alreadyOnline = region.slice(
      region.indexOf("admission.state === 'already-online'"),
      region.indexOf("admission.state === 'fleet-down'"),
    );
    expect(alreadyOnline).toContain("'start-bot-already-online-ready'");
    expect(alreadyOnline).toContain('readAndAssertConfiguredFleetOnline(');
    expect(region).toContain("admission.state === 'fleet-down'");
    expect(region).toContain("'start-bot-after-launch'");
    expect(region).toContain('preflightNodeSanity()');
  });

  it('requires fresh handler-ready exact-set verification before idempotent start returns', () => {
    const start = cli.indexOf('async function cmdStart()');
    const end = cli.indexOf('/**\n * Wipe stale dashboard-daemon descriptors', start);
    const region = cli.slice(start, end);
    const liveBranch = region.slice(
      region.indexOf('if (liveEntries.length > 0)'),
      region.indexOf('const unprovenDormant'),
    );
    const verify = liveBranch.indexOf('readAndAssertConfiguredFleetOnline(');
    const ready = liveBranch.indexOf("'start-idempotent-ready'", verify);
    const returns = liveBranch.indexOf('return;', ready);
    expect(verify).toBeGreaterThanOrEqual(0);
    expect(ready).toBeGreaterThan(verify);
    expect(returns).toBeGreaterThan(ready);
    expect(liveBranch).not.toContain('assertConfiguredPm2FleetOnline(');
  });

  it('discovers legacy Gods from the process table and rechecks duplicate Gods before mutation', () => {
    const start = cli.indexOf('function cleanupLegacyPm2(');
    const end = cli.indexOf('async function cmdStop()', start);
    const legacy = cli.slice(start, end);
    expect(legacy).toContain('listPm2GodDaemonPids(legacyHome)');
    expect(legacy).not.toContain("join(legacyHome, 'pm2.pid')");
    expect(legacy).toContain('assertNoDuplicatePm2GodDaemons(legacyHome)');
    expect(legacy).toContain('preflightNodeSanity(legacyHome)');

    expect(cli).not.toContain("runPm2(['kill']");
  });

  it('exposes an explicit double-confirmed first-upgrade bootstrap without weakening normal shutdown', () => {
    const bootstrapStart = cli.indexOf('function bootstrapDeleteAllBotmuxProcesses(');
    const bootstrapEnd = cli.indexOf('/**\n * One-time migration', bootstrapStart);
    const bootstrap = cli.slice(bootstrapStart, bootstrapEnd);
    expect(bootstrap).toContain('readSupervisorProcessStartIdentity(entry.pid)');
    expect(bootstrap).toContain('current.pid !== original.pid');
    expect(bootstrap).toContain("runPm2(\n      ['delete', String(current.pmId)]");

    const restartStart = cli.indexOf('async function cmdRestart()');
    const restartEnd = cli.indexOf('/**\n * Bring a SINGLE bot', restartStart);
    const restart = cli.slice(restartStart, restartEnd);
    expect(restart).toContain("process.argv.includes('--bootstrap-shutdown-protocol')");
    expect(restart).toContain("process.argv.includes('--yes')");
    expect(restart).toContain("bootstrapDeleteAllBotmuxProcesses('restart')");
    expect(restart).toContain('else deleteAllBotmuxProcesses()');
    expect(cli).toContain('botmux restart --bootstrap-shutdown-protocol --yes');
  });

  it('rejects include-pm2 before breadcrumb/fleet mutation when a live God exists', () => {
    const start = cli.indexOf('async function cmdRestart()');
    const end = cli.indexOf('/**\n * Bring a SINGLE bot', start);
    const restart = cli.slice(start, end);
    const admission = restart.indexOf(
      'assertIncludePm2RestartAdmission(listPm2GodDaemonPids())',
    );
    const consume = restart.indexOf('consumeRestartIntentTo(');
    const retire = restart.indexOf('deleteAllBotmuxProcesses()');
    expect(admission).toBeGreaterThanOrEqual(0);
    expect(consume).toBeGreaterThan(admission);
    expect(retire).toBeGreaterThan(consume);
    expect(restart).not.toContain('killPm2GodDaemon');
    expect(cli).toContain('--include-pm2 仅允许“入场时没有 live PM2 God”的干净启动');
    expect(cli).not.toContain('--include-pm2 同时重启 PM2 God');
  });

  it('attests the whole daemon fleet then uses exact IPC batch/successor requests', () => {
    const start = cli.indexOf('function signalAndAwaitBotmuxProcesses(');
    const end = cli.indexOf('/** Compensate only rows owned', start);
    const helper = cli.slice(start, end);
    const preflight = helper.indexOf('`${operation}-shutdown-capability-preflight`');
    const fleet = helper.indexOf('signalAndAwaitFleet(', preflight);
    const batch = helper.indexOf('requestAttestedDaemonShutdownBatch(', fleet);
    const successor = helper.indexOf('requestAttestedDaemonShutdown(', fleet);
    expect(preflight).toBeGreaterThanOrEqual(0);
    expect(fleet).toBeGreaterThan(preflight);
    expect(batch).toBeGreaterThan(fleet);
    expect(successor).toBeGreaterThan(fleet);
    expect(helper).toContain('signalInitial: targets =>');
    expect(helper).toContain('processStartByPid');
    expect(cli).toContain("return isBotmuxCoreProcessName(name) && name !== 'botmux-dashboard'");
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
