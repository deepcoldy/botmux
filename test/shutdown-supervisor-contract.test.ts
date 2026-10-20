import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  BOT_TURN_MUTATION_SHUTDOWN_ACQUIRE_TIMEOUT_MS,
  DAEMON_SHUTDOWN_MAX_MS,
  DAEMON_SHUTDOWN_OVERHEAD_MS,
  DAEMON_WORKER_EXIT_GRACE_MS,
  DEFAULT_FLEET_DAEMON_EXIT_WAIT_MS,
  DEFAULT_REMOTE_SHUTDOWN_DRAIN_TIMEOUT_MS,
  deriveShutdownBudgets,
  FLEET_DAEMON_EXIT_WAIT_MS,
  FLEET_DAEMON_KILL_TIMEOUT_MS,
  FLEET_SUCCESSOR_SETTLE_MS,
  MAX_REMOTE_SHUTDOWN_DRAIN_TIMEOUT_MS,
  MIN_REMOTE_SHUTDOWN_DRAIN_TIMEOUT_MS,
  parseRemoteShutdownDrainTimeoutMs,
  REMOTE_ADMISSION_RESTORE_TIMEOUT_MS,
  REMOTE_SHUTDOWN_BATCH_PERSIST_TIMEOUT_MS,
  REMOTE_SHUTDOWN_DRAIN_TIMEOUT_MS,
  REMOTE_SHUTDOWN_FINAL_OUTPUT_DRAIN_TIMEOUT_MS,
  REMOTE_SHUTDOWN_INITIAL_SNAPSHOT_TIMEOUT_MS,
} from '../src/core/shutdown-budgets.js';
import { PM2_GRACEFUL_EXIT_CODE } from '../src/pm2-graceful-exit.js';
import { FLEET_GRACEFUL_EXIT_CODE } from '../src/core/fleet-supervisor-policy.js';
import { spawnSyncTsEvalWithRepoImports } from './helpers/ts-runner.js';

const cli = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');

// Contract for the built-in fleet supervisor (pm2-retired). The fleet lifecycle
// (start/stop/restart/status/logs/start-bot/stop-bot) runs under the supervisor;
// pm2 survives only as (a) the legacy-God reaper on upgrade, (b) an unrelated
// plugin-service / desktop feature, (c) the graceful-exit sentinel. The shutdown
// budgets are asserted through their exported module; only the fleet-lock caller
// contract is checked in cli.ts source (see the guard comment below).
describe('graceful shutdown supervisor contract', () => {
  it('keeps a nonzero daemon-only graceful sentinel, shared by pm2 and the supervisor policy', () => {
    // The daemon exits with a nonzero sentinel on a clean shutdown so a supervisor
    // (pm2 historically, our FleetSupervisor now) can tell "shut down cleanly, do
    // NOT restart" from a crash. Signal death maps to 0 under pm2, hence nonzero.
    expect(PM2_GRACEFUL_EXIT_CODE).toBeGreaterThan(0);
    expect(PM2_GRACEFUL_EXIT_CODE).toBeLessThan(256);
    // The built-in supervisor's policy uses the SAME sentinel, so a daemon's clean
    // exit suppresses a restart identically whether pm2 or the supervisor owns it.
    expect(FLEET_GRACEFUL_EXIT_CODE).toBe(PM2_GRACEFUL_EXIT_CODE);
  });

  it('keeps the outer daemon shutdown budget within bounds', () => {
    expect(REMOTE_SHUTDOWN_DRAIN_TIMEOUT_MS).toBe(DEFAULT_REMOTE_SHUTDOWN_DRAIN_TIMEOUT_MS);
    expect(DAEMON_SHUTDOWN_MAX_MS).toBe(
      BOT_TURN_MUTATION_SHUTDOWN_ACQUIRE_TIMEOUT_MS
      + REMOTE_SHUTDOWN_INITIAL_SNAPSHOT_TIMEOUT_MS
      + REMOTE_SHUTDOWN_DRAIN_TIMEOUT_MS
      + REMOTE_SHUTDOWN_FINAL_OUTPUT_DRAIN_TIMEOUT_MS
      + REMOTE_SHUTDOWN_BATCH_PERSIST_TIMEOUT_MS
      + Math.max(REMOTE_ADMISSION_RESTORE_TIMEOUT_MS, DAEMON_WORKER_EXIT_GRACE_MS)
      + DAEMON_SHUTDOWN_OVERHEAD_MS,
    );
    expect(DAEMON_SHUTDOWN_MAX_MS).toBeLessThanOrEqual(48_000);
    expect(FLEET_DAEMON_KILL_TIMEOUT_MS).toBe(49_000);
    expect(FLEET_DAEMON_EXIT_WAIT_MS).toBe(DEFAULT_FLEET_DAEMON_EXIT_WAIT_MS);
  });

  it('strictly parses the provider-neutral remote drain override', () => {
    expect(parseRemoteShutdownDrainTimeoutMs(undefined)).toBe(
      DEFAULT_REMOTE_SHUTDOWN_DRAIN_TIMEOUT_MS,
    );
    expect(parseRemoteShutdownDrainTimeoutMs(String(MIN_REMOTE_SHUTDOWN_DRAIN_TIMEOUT_MS))).toBe(
      MIN_REMOTE_SHUTDOWN_DRAIN_TIMEOUT_MS,
    );
    expect(parseRemoteShutdownDrainTimeoutMs(String(MAX_REMOTE_SHUTDOWN_DRAIN_TIMEOUT_MS))).toBe(
      MAX_REMOTE_SHUTDOWN_DRAIN_TIMEOUT_MS,
    );
    for (const value of ['', '0', '11999', '12.5', ' 12000', '12000 ', '+12000', '01']) {
      expect(() => parseRemoteShutdownDrainTimeoutMs(value), value).toThrow();
    }
    expect(() => parseRemoteShutdownDrainTimeoutMs('86400001')).toThrow();
  });

  it('derives every outer wait budget from a widened remote drain', () => {
    const widenedDrainMs = 3_660_000;
    const budgets = deriveShutdownBudgets(widenedDrainMs);
    expect(budgets.daemonShutdownMaxMs).toBe(widenedDrainMs + 36_000);
    expect(budgets.fleetDaemonKillTimeoutMs).toBe(budgets.daemonShutdownMaxMs + 1_000);
    expect(budgets.fleetDaemonExitWaitMs).toBeGreaterThan(
      budgets.fleetDaemonKillTimeoutMs + FLEET_SUCCESSOR_SETTLE_MS,
    );
    expect(budgets.fleetDaemonExitWaitMs).toBeGreaterThan(DEFAULT_FLEET_DAEMON_EXIT_WAIT_MS);
  });

  it('applies the override to module-level daemon, supervisor, and CLI budgets', () => {
    const child = spawnSyncTsEvalWithRepoImports(`
      import {
        REMOTE_SHUTDOWN_DRAIN_TIMEOUT_MS,
        DAEMON_SHUTDOWN_MAX_MS,
        FLEET_DAEMON_KILL_TIMEOUT_MS,
        FLEET_DAEMON_EXIT_WAIT_MS,
      } from './src/core/shutdown-budgets.js';
      process.stdout.write(JSON.stringify({
        REMOTE_SHUTDOWN_DRAIN_TIMEOUT_MS,
        DAEMON_SHUTDOWN_MAX_MS,
        FLEET_DAEMON_KILL_TIMEOUT_MS,
        FLEET_DAEMON_EXIT_WAIT_MS,
      }));
    `, {
      cwd: process.cwd(),
      env: { ...process.env, BOTMUX_REMOTE_SHUTDOWN_DRAIN_TIMEOUT_MS: '3660000' },
      encoding: 'utf8',
    });
    expect(child.status, String(child.stderr)).toBe(0);
    expect(JSON.parse(String(child.stdout))).toEqual({
      REMOTE_SHUTDOWN_DRAIN_TIMEOUT_MS: 3_660_000,
      DAEMON_SHUTDOWN_MAX_MS: 3_696_000,
      FLEET_DAEMON_KILL_TIMEOUT_MS: 3_697_000,
      FLEET_DAEMON_EXIT_WAIT_MS: 3_701_500,
    });
  });

  // 源码结构护栏(K1)：fleet-runtime.ts 的 startFleetViaSupervisor / stopFleet / restartFleet
  // 以及 start-bot / stop-bot 的 supervisor 操作都约定「调用方必须已持有 fleet-mutation 文件锁」；
  // cli.ts 的启动路径也写明单 owner 互斥（避免两套 fleet 同时消费同一批飞书事件）靠的是
  // 「锁内存活检查 + supervisor 自身的 ownership claim」。这些命令函数不导出、没有行为 seam，
  // 只能在源码里核对：每个 fleet 变更调用点所在的顶层函数，都在调用前取得了异步的
  // withFileLock(PM2_FLEET_MUTATION_LOCK_TARGET, …)。来历见 6985de0cf5 的机群停启协议。
  it('performs every fleet mutation only inside the async fleet lock held by its caller', () => {
    const fleetOps = ['restartFleet', 'startBotViaSupervisor', 'startFleetViaSupervisor', 'stopBotViaSupervisor', 'stopFleet'];
    const callSite = new RegExp(`\\b(${fleetOps.join('|')})\\(`, 'g');
    const topLevelStarts = ['\nfunction ', '\nasync function ', '\nexport function ', '\nexport async function '];
    const seen = new Set<string>();
    for (const match of cli.matchAll(callSite)) {
      const head = cli.slice(0, match.index);
      const enclosing = head.slice(Math.max(...topLevelStarts.map(marker => head.lastIndexOf(marker))));
      expect(enclosing, `${match[1]} call in ${enclosing.slice(1, 80)}`)
        .toMatch(/\bwithFileLock\(PM2_FLEET_MUTATION_LOCK_TARGET\b/);
      seen.add(match[1]);
    }
    // Negative control: every fleet op is still called from cli.ts, so the loop above is not vacuous.
    expect([...seen].sort()).toEqual(fleetOps);
  });
});
