import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import {
  DEFAULT_REMOTE_SHUTDOWN_DRAIN_TIMEOUT_MS,
  FLEET_DAEMON_KILL_SLACK_MS,
  deriveShutdownBudgets,
} from '../src/core/shutdown-budgets.js';
import {
  WECOM_GATEWAY_DESIRED_STOP_WRITE_MS,
  WECOM_GATEWAY_DRAIN_BUDGET_MS,
  WECOM_GATEWAY_KILL_TIMEOUT_MS,
  WECOM_GATEWAY_SHUTDOWN_OVERHEAD_MS,
  WECOM_GATEWAY_SHUTDOWN_MAX_MS,
  WECOM_GATEWAY_SUPERVISED_LOCK_WAIT_MS,
  WECOM_MANAGED_CORE_KILL_WAIT_MS,
  WECOM_MANAGED_CORE_STOP_GRACE_MS,
} from '../src/im/wecom/config/gateway-budgets.js';
import { WECOM_FLEET_DESIRED_STATE_LOCK_WAIT_MS } from '../src/im/wecom/config/fleet-desired-state.js';
import { startWecomManagedCore } from '../src/im/wecom/gateway/managed-core.js';
import { spawnTsEval } from './helpers/ts-runner.js';
import { releaseWecomCorePorts, reserveWecomCorePort } from './helpers/wecom-core-port.js';

/**
 * The gateway gives its core the core's own complete shutdown budget before
 * SIGKILL (it used to be 5 s, cutting a daemon drain short), and the gateway's
 * own worst-case shutdown fits inside the kill timeout a supervisor gives it.
 */

const roots: string[] = [];
afterEach(async () => {
  await releaseWecomCorePorts();
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('WeCom gateway shutdown budgets', () => {
  it('lets the core use its whole daemon shutdown budget before SIGKILL', () => {
    const core = deriveShutdownBudgets(DEFAULT_REMOTE_SHUTDOWN_DRAIN_TIMEOUT_MS);
    expect(WECOM_MANAGED_CORE_STOP_GRACE_MS).toBeGreaterThan(core.daemonShutdownMaxMs);
  });

  // The core starts stopping when the shutdown begins and runs alongside the
  // stop record and the drain (wecom-gateway-shutdown-overlap.test.ts shows it),
  // so each of the two has to fit, with the overhead, on its own.
  it('fits the core\'s whole stop in the gateway\'s shutdown budget', () => {
    expect(WECOM_GATEWAY_SHUTDOWN_MAX_MS).toBeGreaterThanOrEqual(
      WECOM_MANAGED_CORE_STOP_GRACE_MS + WECOM_MANAGED_CORE_KILL_WAIT_MS + WECOM_GATEWAY_SHUTDOWN_OVERHEAD_MS,
    );
  });

  it('leaves the stop record at least the time its writer may wait for the file lock', () => {
    expect(WECOM_GATEWAY_DESIRED_STOP_WRITE_MS).toBeGreaterThanOrEqual(WECOM_FLEET_DESIRED_STATE_LOCK_WAIT_MS);
  });

  it('fits a no-restart stop record followed by the whole drain in that budget', () => {
    expect(WECOM_GATEWAY_SHUTDOWN_MAX_MS).toBeGreaterThanOrEqual(
      WECOM_GATEWAY_DESIRED_STOP_WRITE_MS + WECOM_GATEWAY_DRAIN_BUDGET_MS + WECOM_GATEWAY_SHUTDOWN_OVERHEAD_MS,
    );
  });

  it('gives a gateway the supervisor\'s kill slack beyond its shutdown budget before SIGKILL', () => {
    expect(WECOM_GATEWAY_KILL_TIMEOUT_MS).toBeGreaterThanOrEqual(WECOM_GATEWAY_SHUTDOWN_MAX_MS + FLEET_DAEMON_KILL_SLACK_MS);
  });

  it('waits for the lock at least until a previous generation is gone or killed', () => {
    expect(WECOM_GATEWAY_SUPERVISED_LOCK_WAIT_MS).toBeGreaterThan(WECOM_GATEWAY_KILL_TIMEOUT_MS);
  });

  it('does not SIGKILL a core that finishes its graceful shutdown after more than 5 s', async () => {
    const port = await reserveWecomCorePort();
    const root = mkdtempSync(join(tmpdir(), 'wecom-budget-'));
    roots.push(root);
    const config = {
      managedCore: { botId: 'local_wecom_budget', cli: 'codex', backend: 'pty' as const, workingDirectory: root, stateDir: join(root, 'state'), port },
    };
    let child: ChildProcess | undefined;
    const slowCore = `process.on('SIGTERM', () => setTimeout(() => process.exit(0), 5500)); console.log('[core-only] listening on 127.0.0.1:'+process.env.BOTMUX_API_PORT+' (bot '+process.env.BOTMUX_API_ONLY_BOT+', cli '+process.env.BOTMUX_CORE_CLI+')'); setInterval(()=>{},1000);`;

    const handle = await startWecomManagedCore(config, {
      spawn: (_command, _args, options) => {
        child = spawnTsEval(slowCore, options);
        return child;
      },
    });
    await handle.stop();

    expect({ code: child!.exitCode, signal: child!.signalCode }).toEqual({ code: 0, signal: null });
  }, 20_000);
});
