import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FleetSupervisor, pidAlive, type FleetBotSpec } from '../src/core/fleet-supervisor.js';
import {
  decideExternalPolicyExit,
  externalRestartDelayMs,
  type ExternalRestartPolicy,
} from '../src/core/fleet-supervisor-policy.js';
import { readFleetState } from '../src/core/fleet-state-store.js';
import { WECOM_GATEWAY_NO_RESTART_EXIT_CODE } from '../src/im/wecom/contract/fleet-member.js';

const NO_RESTART = WECOM_GATEWAY_NO_RESTART_EXIT_CODE;

const dirs: string[] = [];
const supervisors: FleetSupervisor[] = [];
const strayPids: number[] = [];
function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-policy-'));
  dirs.push(dir);
  return dir;
}
afterEach(async () => {
  for (const sup of supervisors.splice(0)) await sup.stopAll();
  for (const pid of strayPids.splice(0)) {
    if (pid > 1) {
      try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
    }
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(fn: () => boolean, timeoutMs = 5000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fn()) return true;
    await delay(25);
  }
  return fn();
}

/** A child that records one line per launch, then behaves per `tail`. */
function memberScript(launches: string, tail: string): string {
  return `require('fs').appendFileSync(${JSON.stringify(launches)}, 'x' + String.fromCharCode(10)); ${tail}`;
}
const STAY_TAIL = `process.on('SIGTERM', () => process.exit(0)); setInterval(() => {}, 1000);`;

function launchCount(launches: string): number {
  return existsSync(launches) ? readFileSync(launches, 'utf8').trim().split('\n').filter(Boolean).length : 0;
}

function spec(name: string, script: string, restartPolicy?: ExternalRestartPolicy): FleetBotSpec {
  return {
    name,
    appId: '',
    botIndex: -1,
    external: { command: process.execPath, args: ['-e', script], killTimeoutMs: 2000, ...(restartPolicy ? { restartPolicy } : {}) },
  };
}

function supervisor(statePath: string, root: string, extra: Partial<ConstructorParameters<typeof FleetSupervisor>[0]> = {}): FleetSupervisor {
  const sup = new FleetSupervisor({
    statePath,
    distDir: root,
    daemonEnv: {},
    cwd: root,
    policy: { maxRestarts: 2, restartDelayMs: 20 },
    log: () => {},
    ...extra,
  });
  supervisors.push(sup);
  return sup;
}

const FAST: ExternalRestartPolicy = { noRestartExitCodes: [NO_RESTART], initialDelayMs: 20, maxDelayMs: 40, stableRunMs: 60_000 };

describe('ExternalRestartPolicy decisions (pure)', () => {
  const policy: ExternalRestartPolicy = { noRestartExitCodes: [NO_RESTART], initialDelayMs: 2_000, maxDelayMs: 60_000, stableRunMs: 300_000 };

  it('starts at the initial delay, doubles, and never exceeds the cap', () => {
    expect(externalRestartDelayMs(policy, 1)).toBe(policy.initialDelayMs);
    let previous = externalRestartDelayMs(policy, 1);
    for (let attempt = 2; attempt <= 40; attempt += 1) {
      const next = externalRestartDelayMs(policy, attempt);
      expect(next).toBe(Math.min(policy.maxDelayMs, previous * 2));
      expect(next).toBeLessThanOrEqual(policy.maxDelayMs);
      previous = next;
    }
    expect(previous).toBe(policy.maxDelayMs);
  });

  it('parks only on a listed code the member exited with itself', () => {
    expect(decideExternalPolicyExit({ restarts: 0, ranMs: 0 }, { code: NO_RESTART, signal: null }, policy))
      .toEqual({ action: 'park', reason: 'no_restart_exit_code' });
    expect(decideExternalPolicyExit({ restarts: 0, ranMs: 0 }, { code: null, signal: 'SIGKILL' }, policy).action).toBe('restart');
    expect(decideExternalPolicyExit({ restarts: 0, ranMs: 0 }, { code: 1, signal: null }, policy).action).toBe('restart');
  });

  it('continues a streak after a short run and starts a new one after a stable run', () => {
    const crash = { code: 1, signal: null } as const;
    expect(decideExternalPolicyExit({ restarts: 4, ranMs: policy.stableRunMs - 1 }, crash, policy))
      .toEqual({ action: 'restart', nextRestarts: 5, delayMs: externalRestartDelayMs(policy, 5) });
    expect(decideExternalPolicyExit({ restarts: 4, ranMs: policy.stableRunMs }, crash, policy))
      .toEqual({ action: 'restart', nextRestarts: 1, delayMs: policy.initialDelayMs });
  });
});

describe('FleetSupervisor with an ExternalRestartPolicy member (live)', () => {
  it('parks a member that exits with a no-restart code, without restarting it', async () => {
    const root = tmp();
    const statePath = join(root, 'fleet.json');
    const launches = join(root, 'launches');
    const sup = supervisor(statePath, root);
    sup.start([spec('wecom-aaaaaaaaaaaa', memberScript(launches, `process.exit(${NO_RESTART});`), FAST)]);

    expect(await waitFor(() => readFleetState(statePath)?.procs[0]?.status === 'errored')).toBe(true);
    await delay(300); // a wrong restart would have fired several times by now
    const proc = readFleetState(statePath)!.procs[0];
    expect(proc).toMatchObject({ status: 'errored', pid: 0, lastExitCode: NO_RESTART, restarts: 0 });
    expect(launchCount(launches)).toBe(1);
  });

  it('keeps restarting a crashing member past the fleet-wide max_restarts', async () => {
    const root = tmp();
    const statePath = join(root, 'fleet.json');
    const launches = join(root, 'launches');
    const sup = supervisor(statePath, root); // fleet-wide maxRestarts: 2
    sup.start([spec('wecom-bbbbbbbbbbbb', memberScript(launches, 'process.exit(1);'), FAST)]);

    expect(await waitFor(() => (readFleetState(statePath)?.procs[0]?.restarts ?? 0) >= 5, 8000)).toBe(true);
    expect(readFleetState(statePath)!.procs[0].status).not.toBe('errored');
    expect(launchCount(launches)).toBeGreaterThanOrEqual(5);
  });

  it('waits the backoff delay before restarting', async () => {
    const root = tmp();
    const statePath = join(root, 'fleet.json');
    const launches = join(root, 'launches');
    const sup = supervisor(statePath, root);
    const slow: ExternalRestartPolicy = { ...FAST, initialDelayMs: 5_000, maxDelayMs: 5_000 };
    sup.start([spec('wecom-cccccccccccc', memberScript(launches, 'process.exit(1);'), slow)]);

    expect(await waitFor(() => readFleetState(statePath)?.procs[0]?.status === 'launching')).toBe(true);
    await delay(500); // far past the fleet-wide 20 ms, far short of 5 s
    expect(readFleetState(statePath)!.procs[0]).toMatchObject({ status: 'launching', pid: 0, restarts: 1, lastExitCode: 1 });
    expect(launchCount(launches)).toBe(1);
  });

  it('starts a new backoff streak after a stable run', async () => {
    const root = tmp();
    const statePath = join(root, 'fleet.json');
    const launches = join(root, 'launches');
    let clock = 1_000_000;
    const sup = supervisor(statePath, root, { now: () => clock });
    const policy: ExternalRestartPolicy = { ...FAST, stableRunMs: 10_000 };
    sup.start([spec('wecom-dddddddddddd', memberScript(launches, STAY_TAIL), policy)]);

    const crashAndWait = async (expectedLaunches: number) => {
      const before = readFleetState(statePath)!.procs[0].pid;
      process.kill(before, 'SIGKILL');
      expect(await waitFor(() => {
        const proc = readFleetState(statePath)?.procs[0];
        return !!proc && proc.status === 'online' && proc.pid !== before && launchCount(launches) >= expectedLaunches;
      })).toBe(true);
    };
    expect(await waitFor(() => readFleetState(statePath)?.procs[0]?.status === 'online' && launchCount(launches) === 1)).toBe(true);
    await crashAndWait(2);
    await crashAndWait(3);
    expect(readFleetState(statePath)!.procs[0].restarts).toBe(2);

    clock += policy.stableRunMs; // the current generation has now been up for a stable run
    await crashAndWait(4);
    expect(readFleetState(statePath)!.procs[0].restarts).toBe(1);
    strayPids.push(readFleetState(statePath)!.procs[0].pid);
  });

  it('stopping a member during its backoff cancels the pending restart', async () => {
    const root = tmp();
    const statePath = join(root, 'fleet.json');
    const launches = join(root, 'launches');
    const sup = supervisor(statePath, root);
    const policy: ExternalRestartPolicy = { ...FAST, initialDelayMs: 300, maxDelayMs: 300 };
    sup.start([spec('wecom-eeeeeeeeeeee', memberScript(launches, 'process.exit(1);'), policy)]);

    expect(await waitFor(() => readFleetState(statePath)?.procs[0]?.status === 'launching')).toBe(true);
    await sup.stopOneBot('wecom-eeeeeeeeeeee');
    await delay(700);
    expect(readFleetState(statePath)!.procs[0]).toMatchObject({ status: 'stopped', pid: 0 });
    expect(launchCount(launches)).toBe(1);
  });

  // Control: the same exits, on a member without the option, take the
  // supervisor-wide path — the no-restart code is just a crash: max_restarts
  // fast restarts, then retries at the fleet-wide cooldown, never parked.
  it('a member without the option keeps the fleet-wide policy under the same exits', async () => {
    const root = tmp();
    const statePath = join(root, 'fleet.json');
    const launches = join(root, 'launches');
    const sup = supervisor(statePath, root, { policy: { maxRestarts: 2, restartDelayMs: 20, restartCooldownMs: 1_000 } });
    sup.start([spec('botmux-plugin-control', memberScript(launches, `process.exit(${NO_RESTART});`))]);

    // The first launch and its two fast restarts have exited; the cooldown is pending.
    expect(await waitFor(() => launchCount(launches) === 3 && readFleetState(statePath)?.procs[0]?.pid === 0)).toBe(true);
    expect(readFleetState(statePath)!.procs[0]).toMatchObject({ status: 'launching', restarts: 2, lastExitCode: NO_RESTART });
    await delay(250); // far past the fast delay, well short of the cooldown
    expect(launchCount(launches)).toBe(3);

    expect(await waitFor(() => launchCount(launches) >= 4)).toBe(true);
    expect(readFleetState(statePath)!.procs[0].status).not.toBe('errored');
  });

  it('an operator stop of a policy member is not treated as an exit to decide on', async () => {
    const root = tmp();
    const statePath = join(root, 'fleet.json');
    const launches = join(root, 'launches');
    const sup = supervisor(statePath, root);
    sup.start([spec('wecom-ffffffffffff', memberScript(launches, STAY_TAIL), FAST)]);
    expect(await waitFor(() => readFleetState(statePath)?.procs[0]?.status === 'online' && launchCount(launches) === 1)).toBe(true);
    const pid = readFleetState(statePath)!.procs[0].pid;

    await sup.stopOneBot('wecom-ffffffffffff');
    await delay(200);
    expect(readFleetState(statePath)!.procs[0]).toMatchObject({ status: 'stopped', pid: 0, restarts: 0 });
    expect(pidAlive(pid)).toBe(false);
    expect(launchCount(launches)).toBe(1);
  });
});
