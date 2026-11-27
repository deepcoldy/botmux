import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { wecomConfigId } from '../src/im/wecom/config/discovery.js';
import {
  readWecomFleetDesiredState,
  setWecomFleetDesiredState,
  setWecomFleetDesiredStopped,
  updateWecomFleetDesiredState,
  wecomFleetDesiredStatePath,
} from '../src/im/wecom/config/fleet-desired-state.js';
import { listWecomFleetConnections } from '../src/im/wecom/config/fleet-members.js';
import type { FleetProcessAttestation, FleetProcessIdentityRuntime } from '../src/core/fleet-process-identity.js';
import {
  LEGACY_GATEWAY_MIGRATION_MAX_WAIT_MS,
  migrateLegacyDashboardGateways,
  type LegacyGatewayMigrationDeps,
  type LegacyMigrationStep,
} from '../src/cli/wecom/legacy-gateway-migration.js';
import { hasLegacyDashboardJobs } from '../src/cli/wecom/legacy-dashboard-jobs.js';
import { wecomBotRoot } from '../src/im/wecom/config/runtime.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * A fake process table. `onTerm` decides what a process does on SIGTERM:
 *  - 'exit-with-core': exits after `exitDelayMs`, taking its core with it (an
 *    old gateway's normal shutdown);
 *  - 'exit': exits after `exitDelayMs`;
 *  - 'ignore': only SIGKILL ends it.
 * Nothing here sends a real signal.
 */
interface FakeProcess {
  start: string;
  ppid: number;
  alive: boolean;
  onTerm: 'exit-with-core' | 'exit' | 'ignore';
  exitDelayMs: number;
  core?: number;
  /** Not even SIGKILL ends it (stuck in the kernel). */
  unkillable?: boolean;
}

class World {
  clock = 0;
  readonly procs = new Map<number, FakeProcess>();
  readonly signals: Array<{ pid: number; signal: NodeJS.Signals; at: number }> = [];
  private readonly pending: Array<{ at: number; run: () => void }> = [];
  identityReadable = true;
  /** Pids whose identity cannot be read at all (they still exist). */
  readonly unreadable = new Set<number>();
  /** Pids whose start time reads, but whose durable birth identity does not. */
  readonly durableUnreadable = new Set<number>();

  /** The start time a core descriptor stores (readProcessStartIdentity). */
  startTime(pid: number): string | undefined {
    return !this.unreadable.has(pid) && this.procs.get(pid)?.alive ? this.procs.get(pid)!.start : undefined;
  }

  spawn(pid: number, proc: Partial<FakeProcess> & { start: string }): void {
    this.procs.set(pid, { ppid: 1, alive: true, onTerm: 'exit', exitDelayMs: 100, ...proc });
  }

  private exit(pid: number): void {
    const proc = this.procs.get(pid);
    if (!proc || !proc.alive) return;
    proc.alive = false;
    for (const child of this.procs.values()) if (child.ppid === pid) child.ppid = 1;
  }

  readonly runtime: FleetProcessIdentityRuntime = {
    readIdentity: pid => (this.identityReadable && !this.unreadable.has(pid) && !this.durableUnreadable.has(pid)
      && this.procs.get(pid)?.alive
      ? this.procs.get(pid)!.start
      : undefined),
    readCommandLine: () => 'x',
    readPidNamespace: () => undefined,
    pidExists: pid => !!this.procs.get(pid)?.alive,
  };

  signal = (target: FleetProcessAttestation, signal: NodeJS.Signals): boolean => {
    const proc = this.procs.get(target.pid);
    if (!proc?.alive || proc.start !== target.processStart) return false;
    this.signals.push({ pid: target.pid, signal, at: this.clock });
    if (signal === 'SIGKILL') {
      if (!proc.unkillable) this.exit(target.pid);
    } else if (proc.onTerm !== 'ignore') {
      this.pending.push({
        at: this.clock + proc.exitDelayMs,
        run: () => {
          if (proc.onTerm === 'exit-with-core' && proc.core) this.exit(proc.core);
          this.exit(target.pid);
        },
      });
    }
    return true;
  };

  async sleep(ms: number): Promise<void> {
    this.clock += ms;
    for (const event of this.pending.filter(e => e.at <= this.clock)) {
      this.pending.splice(this.pending.indexOf(event), 1);
      event.run();
    }
  }
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'wecom-migration-'));
  dirs.push(root);
  return {
    root,
    world: new World(),
    warnings: [] as string[],
    infos: [] as string[],
    steps: [] as LegacyMigrationStep[],
    writes: [] as string[][],
  };
}

type Fixture = ReturnType<typeof fixture>;

/** A registered managed-core connection; returns its id and core state dir. */
function addConnection(f: Fixture, name: string, extra: Record<string, unknown> = {}): { configId: string; file: string; stateDir: string } {
  const file = join(f.root, name, 'config.json');
  const stateDir = join(f.root, name, 'core-state');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({
    botId: `bot-${name}`,
    coreUrl: 'http://127.0.0.1:18080',
    allowedUsers: ['u'],
    managedCore: { botId: `local_${name}`, cli: 'codex', backend: 'pty', workingDirectory: f.root, port: 18080, stateDir },
    ...extra,
  }));
  const registry = join(f.root, 'config-registry.json');
  const paths: string[] = existsSync(registry) ? JSON.parse(readFileSync(registry, 'utf8')).paths : [];
  writeFileSync(registry, JSON.stringify({ version: 1, paths: [...paths, file] }));
  return { configId: wecomConfigId(file), file, stateDir };
}

/** When the old Dashboard started the gateways (job createdAt), and times around it. */
const JOB_CREATED = Date.parse('2026-11-10T08:00:00.000Z');
const BEFORE_JOB = () => new Date(JOB_CREATED - 60_000);
const AFTER_JOB = () => new Date(JOB_CREATED + 60_000);

function writeJob(f: Fixture, configId: string, gatewayPid: number, start: string, createdAt: number | null = JOB_CREATED): string {
  const path = join(f.root, 'dashboard-jobs', `${configId}.json`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({
    version: 1, configId, botKey: 'k', launchId: 'l', pid: gatewayPid, processStart: start,
    ...(createdAt === null ? {} : { createdAt }),
  }));
  return path;
}

function writeCoreDescriptor(stateDir: string, botId: string, pid: number, start: string): void {
  mkdirSync(join(stateDir, 'dashboard-daemons'), { recursive: true });
  writeFileSync(join(stateDir, 'dashboard-daemons', `${botId}.json`), JSON.stringify({ pid, processStartIdentity: start, ipcPort: 18080 }));
}

/** An old Dashboard gateway (pid g) serving core (pid c), with its job file. */
function legacyGateway(
  f: Fixture, name: string, g: number, c: number,
  onTerm: FakeProcess['onTerm'] = 'exit-with-core', createdAt: number | null = JOB_CREATED,
  extra: Record<string, unknown> = {},
) {
  const conn = addConnection(f, name, extra);
  f.world.spawn(g, { start: `g${g}`, onTerm, core: c, exitDelayMs: 1_000 });
  f.world.spawn(c, { start: `c${c}`, ppid: g, onTerm: 'exit', exitDelayMs: 500 });
  writeCoreDescriptor(conn.stateDir, `local_${name}`, c, `c${c}`);
  const job = writeJob(f, conn.configId, g, `g${g}`, createdAt);
  return { ...conn, job };
}

function deps(f: Fixture, overrides: Partial<LegacyGatewayMigrationDeps> = {}): LegacyGatewayMigrationDeps {
  return {
    root: f.root,
    listConnections: () => listWecomFleetConnections(f.root),
    readDesired: () => {
      const snapshot = readWecomFleetDesiredState(f.root);
      if (snapshot.status !== 'ok') throw new Error(snapshot.reason);
      return snapshot.connections;
    },
    markRunning: ids => {
      f.writes.push([...ids]);
      updateWecomFleetDesiredState(map => {
        for (const id of ids) map.set(id, { desired: 'running', updatedAt: 'T' });
      }, { root: f.root });
    },
    runtime: f.world.runtime,
    readStartIdentity: pid => f.world.startTime(pid),
    readParentPid: pid => f.world.procs.get(pid)?.ppid,
    readBootId: () => undefined,
    isZombie: () => false,
    signal: f.world.signal,
    now: () => f.world.clock,
    sleep: ms => f.world.sleep(ms),
    warn: line => f.warnings.push(line),
    info: line => f.infos.push(line),
    afterStep: step => f.steps.push(step),
    ...overrides,
  };
}

function desiredOf(f: Fixture, configId: string) {
  const snapshot = readWecomFleetDesiredState(f.root);
  if (snapshot.status !== 'ok') throw new Error('unavailable');
  return snapshot.connections.get(configId);
}

describe('handing old Dashboard gateways to the fleet', () => {
  it('records running, stops the gateway, sees its core go, and forgets the job', async () => {
    const f = fixture();
    const a = legacyGateway(f, 'a', 100, 101);
    const summary = await migrateLegacyDashboardGateways(deps(f));
    expect(desiredOf(f, a.configId)?.desired).toBe('running');
    expect(f.world.procs.get(100)!.alive).toBe(false);
    expect(f.world.procs.get(101)!.alive).toBe(false);
    expect(existsSync(a.job)).toBe(false);
    expect(summary.migrated).toEqual([a.configId]);
    // The gateway took its core down itself; the core got no signal from us.
    expect(f.world.signals.map(s => [s.pid, s.signal])).toEqual([[100, 'SIGTERM']]);
  });

  it('overrides a recorded stop, reason included: only an older Dashboard leaves such a process', async () => {
    const f = fixture();
    const a = legacyGateway(f, 'a', 100, 101);
    setWecomFleetDesiredStopped(a.configId, 'replaced', { root: f.root, now: BEFORE_JOB });
    await migrateLegacyDashboardGateways(deps(f));
    expect(desiredOf(f, a.configId)).toEqual({ desired: 'running', updatedAt: 'T' });
  });

  it('kills a gateway that ignores SIGTERM, then stops the core it left behind, within the bound', async () => {
    const f = fixture();
    const a = legacyGateway(f, 'a', 100, 101, 'ignore');
    await migrateLegacyDashboardGateways(deps(f));
    expect(f.world.signals.map(s => [s.pid, s.signal])).toEqual([[100, 'SIGTERM'], [100, 'SIGKILL'], [101, 'SIGTERM']]);
    expect(f.world.procs.get(101)!.alive).toBe(false);
    expect(existsSync(a.job)).toBe(false);
    expect(f.world.clock).toBeLessThanOrEqual(LEGACY_GATEWAY_MIGRATION_MAX_WAIT_MS);
  });

  it('stops several connections in parallel, still within the bound', async () => {
    const f = fixture();
    legacyGateway(f, 'a', 100, 101, 'ignore');
    legacyGateway(f, 'b', 200, 201, 'ignore');
    legacyGateway(f, 'c', 300, 301, 'ignore');
    const summary = await migrateLegacyDashboardGateways(deps(f));
    expect(summary.migrated).toHaveLength(3);
    expect(f.world.clock).toBeLessThanOrEqual(LEGACY_GATEWAY_MIGRATION_MAX_WAIT_MS);
  });

  it('journals the core in the job file before the first signal', async () => {
    const f = fixture();
    const a = legacyGateway(f, 'a', 100, 101);
    let journaled: unknown;
    const d = deps(f);
    await migrateLegacyDashboardGateways({
      ...d,
      signal: (target, signal) => {
        if (journaled === undefined) journaled = JSON.parse(readFileSync(a.job, 'utf8')).migration?.core;
        return d.signal(target, signal);
      },
    });
    expect(journaled).toEqual({ pid: 101, processStart: 'c101' });
  });

  it('never signals a pid whose process is not the recorded one, and only drops that job', async () => {
    const f = fixture();
    const conn = addConnection(f, 'a');
    f.world.spawn(100, { start: 'someone-else' });
    const job = writeJob(f, conn.configId, 100, 'g100');
    const summary = await migrateLegacyDashboardGateways(deps(f));
    expect(f.world.signals).toEqual([]);
    expect(f.world.procs.get(100)!.alive).toBe(true);
    expect(existsSync(job)).toBe(false);
    expect(summary.forgotten).toEqual([conn.configId]);
    // No live gateway → no record (no record = not a member).
    expect(existsSync(wecomFleetDesiredStatePath(f.root))).toBe(false);
  });

  it('leaves a process whose identity cannot be read alone, with a warning, and keeps its job', async () => {
    const f = fixture();
    const a = legacyGateway(f, 'a', 100, 101);
    f.world.identityReadable = false;
    await migrateLegacyDashboardGateways(deps(f));
    expect(f.world.signals).toEqual([]);
    expect(existsSync(a.job)).toBe(true);
    expect(f.warnings).toHaveLength(1);
    expect(existsSync(wecomFleetDesiredStatePath(f.root))).toBe(false);
  });

  it('does not stop a core that is not the gateway\'s child, even after killing the gateway', async () => {
    const f = fixture();
    const a = legacyGateway(f, 'a', 100, 101, 'ignore');
    f.world.procs.get(101)!.ppid = 999;
    await migrateLegacyDashboardGateways(deps(f));
    expect(f.world.signals.some(s => s.pid === 101)).toBe(false);
    expect(f.world.procs.get(101)!.alive).toBe(true);
    expect(existsSync(a.job)).toBe(false);
  });

  it('touches nothing when the running intent cannot be recorded', async () => {
    const f = fixture();
    const a = legacyGateway(f, 'a', 100, 101);
    const summary = await migrateLegacyDashboardGateways(deps(f, { markRunning: () => { throw new Error('locked'); } }));
    expect(f.world.signals).toEqual([]);
    expect(existsSync(a.job)).toBe(true);
    expect(summary.remaining).toEqual([a.configId]);
    expect(f.warnings).toHaveLength(1);
  });

  it('ignores job files of connections that are not registered', async () => {
    const f = fixture();
    addConnection(f, 'a');
    f.world.spawn(100, { start: 'g100' });
    const job = writeJob(f, 'e'.repeat(64), 100, 'g100');
    await migrateLegacyDashboardGateways(deps(f));
    expect(f.world.signals).toEqual([]);
    expect(existsSync(job)).toBe(true);
  });

  it('warns and changes nothing when the registry cannot be read', async () => {
    const f = fixture();
    const a = legacyGateway(f, 'a', 100, 101);
    writeFileSync(join(f.root, 'config-registry.json'), 'garbage');
    await migrateLegacyDashboardGateways(deps(f));
    expect(f.world.signals).toEqual([]);
    expect(existsSync(a.job)).toBe(true);
    expect(f.warnings).toHaveLength(1);
  });

  it('costs nothing more than the directory check on a host with no job files', async () => {
    const f = fixture();
    expect(hasLegacyDashboardJobs(f.root)).toBe(false);
    let listed = false;
    const d = deps(f, { listConnections: () => { listed = true; return []; } });
    expect(await migrateLegacyDashboardGateways(d)).toEqual({ migrated: [], keptStopped: [], forgotten: [], orphansStopped: [], remaining: [] });
    // An emptied jobs directory (every job handled) does not read the registry either.
    mkdirSync(join(f.root, 'dashboard-jobs'));
    expect(hasLegacyDashboardJobs(f.root)).toBe(true);
    expect(await migrateLegacyDashboardGateways(d)).toEqual({ migrated: [], keptStopped: [], forgotten: [], orphansStopped: [], remaining: [] });
    expect(listed).toBe(false);
    expect(f.warnings).toEqual([]);
  });
});

describe('a process that will not go', () => {
  it('keeps the job of a core that outlives SIGKILL, so the next run checks it again', async () => {
    const f = fixture();
    const a = legacyGateway(f, 'a', 100, 101, 'ignore');
    Object.assign(f.world.procs.get(101)!, { onTerm: 'ignore', unkillable: true });
    const summary = await migrateLegacyDashboardGateways(deps(f));
    expect(existsSync(a.job)).toBe(true);
    expect(summary.remaining).toEqual([a.configId]);
    expect(summary.migrated).toEqual([]);
    expect(f.world.clock).toBeLessThanOrEqual(LEGACY_GATEWAY_MIGRATION_MAX_WAIT_MS);
  });
});

describe('an interrupted migration finishes on the next run', () => {
  for (const step of ['recorded', 'gateways-stopped', 'cores-stopped'] as const) {
    it(`after "${step}"`, async () => {
      const f = fixture();
      // A gateway that ignores SIGTERM leaves its core behind, so every step has work.
      const a = legacyGateway(f, 'a', 100, 101, 'ignore');
      const interrupted = deps(f, { afterStep: s => { if (s === step) throw new Error(`killed after ${s}`); } });
      await expect(migrateLegacyDashboardGateways(interrupted)).rejects.toThrow(`killed after ${step}`);
      expect(existsSync(a.job)).toBe(true);
      expect(desiredOf(f, a.configId)?.desired).toBe('running');

      const summary = await migrateLegacyDashboardGateways(deps(f));
      expect(f.world.procs.get(100)!.alive).toBe(false);
      expect(f.world.procs.get(101)!.alive).toBe(false);
      expect(existsSync(a.job)).toBe(false);
      expect(desiredOf(f, a.configId)?.desired).toBe('running');
      expect(summary.remaining).toEqual([]);
      // No process is signalled again once it is gone.
      const perPid = (pid: number) => f.world.signals.filter(s => s.pid === pid).map(s => s.signal);
      expect(perPid(101).filter(s => s === 'SIGTERM').length).toBeLessThanOrEqual(1);
    });
  }

  it('after the gateway was killed but before its core was checked: the journaled core is stopped', async () => {
    const f = fixture();
    const a = legacyGateway(f, 'a', 100, 101, 'ignore');
    await expect(migrateLegacyDashboardGateways(deps(f, {
      afterStep: s => { if (s === 'gateways-stopped') throw new Error('killed'); },
    }))).rejects.toThrow('killed');
    // The core descriptor is gone by now (nothing else would name the core).
    rmSync(join(a.stateDir, 'dashboard-daemons'), { recursive: true });
    expect(f.world.procs.get(101)!.alive).toBe(true);
    await migrateLegacyDashboardGateways(deps(f));
    expect(f.world.procs.get(101)!.alive).toBe(false);
    expect(existsSync(a.job)).toBe(false);
  });
});

describe('a record a person made after the old gateway was started', () => {
  it('keeps a later stop, still stops the gateway and its core, and reports it apart from migrated', async () => {
    const f = fixture();
    const a = legacyGateway(f, 'a', 100, 101, 'ignore');
    setWecomFleetDesiredState(a.configId, 'stopped', { root: f.root, now: AFTER_JOB });
    const before = readFileSync(wecomFleetDesiredStatePath(f.root), 'utf8');
    const summary = await migrateLegacyDashboardGateways(deps(f));
    expect(readFileSync(wecomFleetDesiredStatePath(f.root), 'utf8')).toBe(before);
    expect(f.writes).toEqual([]);
    expect(f.world.procs.get(100)!.alive).toBe(false);
    expect(f.world.procs.get(101)!.alive).toBe(false);
    expect(existsSync(a.job)).toBe(false);
    expect(summary.keptStopped).toEqual([a.configId]);
    expect(summary.migrated).toEqual([]);
    expect(f.infos).toHaveLength(1);
  });

  it('does not take a later stop the fleet gateway recorded itself (with a reason) for a person\'s intent', async () => {
    // The fleet member for the connection hit this old gateway's instance lock
    // and stopped itself as instance_busy: that record says nothing a person wants.
    for (const reason of ['instance_busy', 'replaced'] as const) {
      const f = fixture();
      const a = legacyGateway(f, 'a', 100, 101);
      setWecomFleetDesiredState(a.configId, 'running', { root: f.root, now: AFTER_JOB });
      setWecomFleetDesiredStopped(a.configId, reason, { root: f.root, now: AFTER_JOB });
      const summary = await migrateLegacyDashboardGateways(deps(f));
      expect(f.writes).toEqual([[a.configId]]);
      expect(desiredOf(f, a.configId)).toMatchObject({ desired: 'running' });
      expect(desiredOf(f, a.configId)?.reason).toBeUndefined();
      expect(summary.migrated).toEqual([a.configId]);
      expect(summary.keptStopped).toEqual([]);
    }
  });

  it('a stop recorded at the very time the job was written counts as later', async () => {
    const f = fixture();
    const a = legacyGateway(f, 'a', 100, 101);
    setWecomFleetDesiredState(a.configId, 'stopped', { root: f.root, now: () => new Date(JOB_CREATED) });
    expect((await migrateLegacyDashboardGateways(deps(f))).keptStopped).toEqual([a.configId]);
  });

  it('does not rewrite a later running record, and migrates as usual', async () => {
    const f = fixture();
    const a = legacyGateway(f, 'a', 100, 101);
    setWecomFleetDesiredState(a.configId, 'running', { root: f.root, now: AFTER_JOB });
    const summary = await migrateLegacyDashboardGateways(deps(f));
    expect(f.writes).toEqual([]);
    expect(desiredOf(f, a.configId)).toEqual({ desired: 'running', updatedAt: AFTER_JOB().toISOString() });
    expect(summary.migrated).toEqual([a.configId]);
    expect(existsSync(a.job)).toBe(false);
  });

  it('records running over an older record, or when either time cannot be read', async () => {
    const f = fixture();
    const older = legacyGateway(f, 'a', 100, 101);
    setWecomFleetDesiredState(older.configId, 'stopped', { root: f.root, now: BEFORE_JOB });
    const noJobTime = legacyGateway(f, 'b', 200, 201, 'exit-with-core', null);
    setWecomFleetDesiredState(noJobTime.configId, 'stopped', { root: f.root, now: AFTER_JOB });
    const badRecordTime = legacyGateway(f, 'c', 300, 301);
    updateWecomFleetDesiredState(map => {
      map.set(badRecordTime.configId, { desired: 'stopped', updatedAt: 'not a time' });
    }, { root: f.root });
    const summary = await migrateLegacyDashboardGateways(deps(f));
    for (const conn of [older, noJobTime, badRecordTime]) expect(desiredOf(f, conn.configId)?.desired).toBe('running');
    expect(summary.keptStopped).toEqual([]);
  });

  it('writes once, only the connections that need running, alongside one that stays stopped', async () => {
    const f = fixture();
    const kept = legacyGateway(f, 'a', 100, 101);
    setWecomFleetDesiredState(kept.configId, 'stopped', { root: f.root, now: AFTER_JOB });
    const fresh = legacyGateway(f, 'b', 200, 201);
    const summary = await migrateLegacyDashboardGateways(deps(f));
    expect(f.writes).toEqual([[fresh.configId]]);
    expect(desiredOf(f, kept.configId)?.desired).toBe('stopped');
    expect(summary).toMatchObject({ migrated: [fresh.configId], keptStopped: [kept.configId] });
  });

  it('stops nobody when the needed write fails, the kept-stopped connection included', async () => {
    const f = fixture();
    const kept = legacyGateway(f, 'a', 100, 101);
    setWecomFleetDesiredState(kept.configId, 'stopped', { root: f.root, now: AFTER_JOB });
    legacyGateway(f, 'b', 200, 201);
    await migrateLegacyDashboardGateways(deps(f, { markRunning: () => { throw new Error('locked'); } }));
    expect(f.world.signals).toEqual([]);
  });

  for (const step of ['recorded', 'gateways-stopped', 'cores-stopped'] as const) {
    it(`an interrupted run after "${step}" never turns the kept stop into running`, async () => {
      const f = fixture();
      const a = legacyGateway(f, 'a', 100, 101, 'ignore');
      setWecomFleetDesiredState(a.configId, 'stopped', { root: f.root, now: AFTER_JOB });
      await expect(migrateLegacyDashboardGateways(deps(f, {
        afterStep: s => { if (s === step) throw new Error('killed'); },
      }))).rejects.toThrow('killed');
      await migrateLegacyDashboardGateways(deps(f));
      expect(desiredOf(f, a.configId)?.desired).toBe('stopped');
      expect(f.writes).toEqual([]);
      expect(f.world.procs.get(100)!.alive).toBe(false);
      expect(f.world.procs.get(101)!.alive).toBe(false);
      expect(existsSync(a.job)).toBe(false);
    });
  }
});

describe('more than one connection, and processes that cannot be dealt with', () => {
  it('records both connections as running when two old gateways are alive', async () => {
    const f = fixture();
    const a = legacyGateway(f, 'a', 100, 101);
    const b = legacyGateway(f, 'b', 200, 201);
    const summary = await migrateLegacyDashboardGateways(deps(f));
    expect(desiredOf(f, a.configId)?.desired).toBe('running');
    expect(desiredOf(f, b.configId)?.desired).toBe('running');
    expect(summary.migrated.sort()).toEqual([a.configId, b.configId].sort());
    for (const pid of [100, 101, 200, 201]) expect(f.world.procs.get(pid)!.alive).toBe(false);
  });

  it('keeps the job and reports the connection remaining when the old core\'s identity cannot be read', async () => {
    const f = fixture();
    const a = legacyGateway(f, 'a', 100, 101, 'ignore');
    const summary = await migrateLegacyDashboardGateways(deps(f, {
      // The core loses its readable identity once its gateway is gone.
      afterStep: step => { if (step === 'gateways-stopped') f.world.unreadable.add(101); },
    }));
    expect(f.world.signals.some(s => s.pid === 101)).toBe(false);
    expect(existsSync(a.job)).toBe(true);
    expect(summary.remaining).toEqual([a.configId]);
    expect(summary.migrated).toEqual([]);
  });

  it('leaves the core alone and keeps the job when the old gateway outlives SIGKILL', async () => {
    const f = fixture();
    const a = legacyGateway(f, 'a', 100, 101, 'ignore');
    f.world.procs.get(100)!.unkillable = true;
    const summary = await migrateLegacyDashboardGateways(deps(f));
    expect(f.world.signals.filter(s => s.pid === 101)).toEqual([]);
    expect(f.world.procs.get(101)!.alive).toBe(true);
    expect(existsSync(a.job)).toBe(true);
    expect(summary.remaining).toEqual([a.configId]);
  });
});

/**
 * A gateway the old Dashboard started that is already gone (pid g, not in the
 * process table), and its core c still running, orphaned (parent 1), on the
 * configured port, with no live holder of the bot's instance lock.
 */
function orphanedCore(f: Fixture, name: string, g: number, c: number) {
  const conn = addConnection(f, name);
  f.world.spawn(c, { start: `c${c}`, ppid: 1, onTerm: 'exit', exitDelayMs: 500 });
  writeCoreDescriptor(conn.stateDir, `local_${name}`, c, `c${c}`);
  const job = writeJob(f, conn.configId, g, `g${g}`);
  const lock = join(wecomBotRoot(`bot-${name}`, f.root), 'instance.lock');
  const descriptor = join(conn.stateDir, 'dashboard-daemons', `local_${name}.json`);
  return { ...conn, job, lock, descriptor };
}

function writeLock(path: string, holder: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof holder === 'string' ? holder : JSON.stringify(holder));
}

describe('an old gateway already gone, its core still running', () => {
  it('stops the orphan by its birth identity, records nothing, and reports it apart', async () => {
    const f = fixture();
    const a = orphanedCore(f, 'a', 100, 101);
    const summary = await migrateLegacyDashboardGateways(deps(f));
    expect(f.world.signals.map(s => [s.pid, s.signal])).toEqual([[101, 'SIGTERM']]);
    expect(f.world.procs.get(101)!.alive).toBe(false);
    expect(existsSync(a.job)).toBe(false);
    expect(existsSync(wecomFleetDesiredStatePath(f.root))).toBe(false);
    expect(f.writes).toEqual([]);
    expect(summary.orphansStopped).toEqual([a.configId]);
    expect(summary.forgotten).toEqual([]);
    expect(f.infos).toHaveLength(1);
    expect(f.warnings).toEqual([]);
  });

  it('journals the orphan before signalling it', async () => {
    const f = fixture();
    const a = orphanedCore(f, 'a', 100, 101);
    let journaled: unknown;
    const d = deps(f);
    await migrateLegacyDashboardGateways({
      ...d,
      signal: (target, signal) => {
        journaled ??= JSON.parse(readFileSync(a.job, 'utf8')).migration;
        return d.signal(target, signal);
      },
    });
    expect(journaled).toMatchObject({ core: { pid: 101, processStart: 'c101' }, orphan: true });
  });

  it('still stops it while an old live lock record names a dead or different process', async () => {
    for (const holder of [{ pid: 4242, procStart: 'x' }, { pid: 101, procStart: 'not-the-core-start' }, '4242']) {
      const f = fixture();
      const a = orphanedCore(f, 'a', 100, 101);
      writeLock(a.lock, holder);
      const summary = await migrateLegacyDashboardGateways(deps(f));
      expect(summary.orphansStopped).toEqual([a.configId]);
    }
  });

  it('keeps an existing desired-state record as it is', async () => {
    for (const desired of ['running', 'stopped'] as const) {
      const f = fixture();
      const a = orphanedCore(f, 'a', 100, 101);
      setWecomFleetDesiredState(a.configId, desired, { root: f.root, now: AFTER_JOB });
      const before = readFileSync(wecomFleetDesiredStatePath(f.root), 'utf8');
      const summary = await migrateLegacyDashboardGateways(deps(f));
      expect(readFileSync(wecomFleetDesiredStatePath(f.root), 'utf8')).toBe(before);
      expect(summary.orphansStopped).toEqual([a.configId]);
      expect(f.world.procs.get(101)!.alive).toBe(false);
    }
  });

  it('handles a live old gateway and an orphan in one run, with one write for the live one only', async () => {
    const f = fixture();
    const live = legacyGateway(f, 'a', 100, 101);
    const orphan = orphanedCore(f, 'b', 200, 201);
    const summary = await migrateLegacyDashboardGateways(deps(f));
    expect(f.writes).toEqual([[live.configId]]);
    expect(desiredOf(f, orphan.configId)).toBeUndefined();
    expect(summary).toMatchObject({ migrated: [live.configId], orphansStopped: [orphan.configId] });
    for (const pid of [100, 101, 201]) expect(f.world.procs.get(pid)!.alive).toBe(false);
  });

  it('touches no process when the core is already gone, and only drops the job', async () => {
    const cases: Array<[string, (a: ReturnType<typeof orphanedCore>, f: Fixture) => void]> = [
      ['no descriptor', a => rmSync(a.descriptor)],
      ['descriptor pid gone', (_a, f) => { f.world.procs.get(101)!.alive = false; }],
      ['descriptor pid now another process', (_a, f) => { f.world.procs.set(101, { start: 'someone-else', ppid: 1, alive: true, onTerm: 'exit', exitDelayMs: 1 }); }],
    ];
    for (const [label, setUp] of cases) {
      const f = fixture();
      const a = orphanedCore(f, 'a', 100, 101);
      setUp(a, f);
      const summary = await migrateLegacyDashboardGateways(deps(f));
      expect(f.world.signals, label).toEqual([]);
      expect(existsSync(a.job), label).toBe(false);
      expect(summary.forgotten, label).toEqual([a.configId]);
      expect(f.warnings, label).toEqual([]);
    }
  });

  it('does not look for a process for an external core', async () => {
    const f = fixture();
    const file = join(f.root, 'ext', 'config.json');
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ botId: 'bot-ext', coreUrl: 'http://127.0.0.1:18080', allowedUsers: ['u'] }));
    writeFileSync(join(f.root, 'config-registry.json'), JSON.stringify({ version: 1, paths: [file] }));
    const job = writeJob(f, wecomConfigId(file), 100, 'g100');
    let parentsRead = 0;
    const summary = await migrateLegacyDashboardGateways(deps(f, { readParentPid: () => { parentsRead += 1; return 1; } }));
    expect(parentsRead).toBe(0);
    expect(existsSync(job)).toBe(false);
    expect(summary.forgotten).toHaveLength(1);
  });

  it('signals nothing, keeps the job and warns when any piece of evidence cannot be shown', async () => {
    const cases: Array<[string, (a: ReturnType<typeof orphanedCore>, f: Fixture) => void]> = [
      ['descriptor unparsable', a => writeFileSync(a.descriptor, '{ broken')],
      ['core start time unreadable', (_a, f) => f.world.unreadable.add(101)],
      ['core birth identity unreadable', (_a, f) => f.world.durableUnreadable.add(101)],
      ['parent is the recorded gateway pid', (_a, f) => { f.world.procs.get(101)!.ppid = 100; }],
      ['port differs from the configuration', a => writeFileSync(a.descriptor, JSON.stringify({ pid: 101, processStartIdentity: 'c101', ipcPort: 18081 }))],
      ['instance lock held by a live process', (a, f) => { f.world.spawn(500, { start: 's500' }); writeLock(a.lock, { pid: 500, procStart: 's500' }); }],
      ['instance lock holder cannot be verified', (a, f) => { f.world.spawn(500, { start: 's500' }); writeLock(a.lock, '500'); }],
    ];
    for (const [label, setUp] of cases) {
      const f = fixture();
      const a = orphanedCore(f, 'a', 100, 101);
      setUp(a, f);
      const summary = await migrateLegacyDashboardGateways(deps(f));
      expect(f.world.signals, label).toEqual([]);
      expect(f.world.procs.get(101)!.alive, label).toBe(true);
      expect(existsSync(a.job), label).toBe(true);
      expect(summary.remaining, label).toEqual([a.configId]);
      expect(summary.orphansStopped, label).toEqual([]);
      expect(f.warnings, label).toHaveLength(1);
    }
  });

  it('treats the job as stale when the core is the child of the live gateway holding the lock', async () => {
    // A terminal gateway runs the same configuration: the core is its own.
    const f = fixture();
    const a = orphanedCore(f, 'a', 100, 101);
    f.world.spawn(600, { start: 's600' });
    f.world.procs.get(101)!.ppid = 600;
    writeLock(a.lock, { pid: 600, procStart: 's600' });
    const summary = await migrateLegacyDashboardGateways(deps(f));
    expect(f.world.signals).toEqual([]);
    expect(f.world.procs.get(101)!.alive).toBe(true);
    expect(f.world.procs.get(600)!.alive).toBe(true);
    expect(existsSync(a.job)).toBe(false);
    expect(summary.forgotten).toEqual([a.configId]);
    expect(summary.remaining).toEqual([]);
    expect(f.warnings).toEqual([]);
  });

  it('keeps the job without advising a kill while a gateway runs the bot but the core is not its child', async () => {
    for (const [label, parent] of [['another parent', 1], ['parent unreadable', undefined]] as const) {
      const f = fixture();
      const a = orphanedCore(f, 'a', 100, 101);
      f.world.spawn(600, { start: 's600' });
      writeLock(a.lock, { pid: 600, procStart: 's600' });
      const summary = await migrateLegacyDashboardGateways(deps(f, {
        readParentPid: pid => (pid === 101 ? parent : f.world.procs.get(pid)?.ppid),
      }));
      expect(f.world.signals, label).toEqual([]);
      expect(existsSync(a.job), label).toBe(true);
      expect(summary.remaining, label).toEqual([a.configId]);
      expect(f.warnings, label).toHaveLength(1);
      expect(f.warnings[0], label).toContain('600');
      expect(f.warnings[0], label).not.toContain('kill');
    }
  });

  it('keeps the job of an orphan that outlives SIGKILL', async () => {
    const f = fixture();
    const a = orphanedCore(f, 'a', 100, 101);
    Object.assign(f.world.procs.get(101)!, { onTerm: 'ignore', unkillable: true });
    const summary = await migrateLegacyDashboardGateways(deps(f));
    expect(existsSync(a.job)).toBe(true);
    expect(summary.remaining).toEqual([a.configId]);
    expect(summary.orphansStopped).toEqual([]);
  });
});

describe('an interrupted orphan stop finishes on the next run', () => {
  /** Signal, then die right after sending `which`. */
  const dyingAfter = (f: Fixture, which: NodeJS.Signals) => {
    const d = deps(f);
    return deps(f, {
      signal: (target, signal) => {
        const sent = d.signal(target, signal);
        if (signal === which) throw new Error(`killed after ${which}`);
        return sent;
      },
    });
  };

  // The next run finds the orphan already gone: it only drops the job, and does
  // not claim to have stopped a core it never signalled.
  for (const which of ['SIGTERM', 'SIGKILL'] as const) {
    it(`after ${which} was sent`, async () => {
      const f = fixture();
      const a = orphanedCore(f, 'a', 100, 101);
      if (which === 'SIGKILL') f.world.procs.get(101)!.onTerm = 'ignore';
      await expect(migrateLegacyDashboardGateways(dyingAfter(f, which))).rejects.toThrow(`killed after ${which}`);
      expect(existsSync(a.job)).toBe(true);
      await f.world.sleep(1_000);
      const signalsBefore = f.world.signals.length;
      const summary = await migrateLegacyDashboardGateways(deps(f));
      expect(f.world.procs.get(101)!.alive).toBe(false);
      expect(existsSync(a.job)).toBe(false);
      expect(f.world.signals.length).toBe(signalsBefore);
      expect(summary).toMatchObject({ orphansStopped: [], forgotten: [a.configId] });
      expect(existsSync(wecomFleetDesiredStatePath(f.root))).toBe(false);
    });
  }

  it('after the core exited but before the job was deleted', async () => {
    const f = fixture();
    const a = orphanedCore(f, 'a', 100, 101);
    await expect(migrateLegacyDashboardGateways(deps(f, {
      afterStep: s => { if (s === 'cores-stopped') throw new Error('killed'); },
    }))).rejects.toThrow('killed');
    expect(f.world.procs.get(101)!.alive).toBe(false);
    const summary = await migrateLegacyDashboardGateways(deps(f));
    expect(existsSync(a.job)).toBe(false);
    expect(summary).toMatchObject({ orphansStopped: [], forgotten: [a.configId] });
  });

  it('a journaled orphan whose pid now belongs to an unrelated process is neither signalled nor reported stopped', async () => {
    const f = fixture();
    const a = orphanedCore(f, 'a', 100, 101);
    await expect(migrateLegacyDashboardGateways(deps(f, {
      afterStep: s => { if (s === 'gateways-stopped') throw new Error('killed'); },
    }))).rejects.toThrow('killed');
    // Journaled, never signalled; then the core went and its pid was reused.
    f.world.procs.set(101, { start: 'unrelated', ppid: 1, alive: true, onTerm: 'exit', exitDelayMs: 1 });
    f.infos.length = 0;
    const summary = await migrateLegacyDashboardGateways(deps(f));
    expect(f.world.signals).toEqual([]);
    expect(f.world.procs.get(101)!.alive).toBe(true);
    expect(summary).toMatchObject({ orphansStopped: [], forgotten: [a.configId] });
    expect(f.infos).toEqual([]);
  });

  it('never signals the pid once it belongs to an unrelated process', async () => {
    const f = fixture();
    const a = orphanedCore(f, 'a', 100, 101);
    await expect(migrateLegacyDashboardGateways(dyingAfter(f, 'SIGTERM'))).rejects.toThrow('killed after SIGTERM');
    await f.world.sleep(1_000);
    // The orphan exited and its pid was reused before the next run.
    f.world.procs.set(101, { start: 'unrelated', ppid: 1, alive: true, onTerm: 'exit', exitDelayMs: 1 });
    const signalsBefore = f.world.signals.length;
    await migrateLegacyDashboardGateways(deps(f));
    expect(f.world.signals.length).toBe(signalsBefore);
    expect(f.world.procs.get(101)!.alive).toBe(true);
    expect(existsSync(a.job)).toBe(false);
  });
});

describe('evidence that must be shown before an orphan is stopped', () => {
  const keptWithWarning = (f: Fixture, a: ReturnType<typeof orphanedCore>, summary: Awaited<ReturnType<typeof migrateLegacyDashboardGateways>>) => {
    expect(f.world.signals).toEqual([]);
    expect(f.world.procs.get(101)!.alive).toBe(true);
    expect(existsSync(a.job)).toBe(true);
    expect(summary.remaining).toEqual([a.configId]);
    expect(f.warnings).toHaveLength(1);
  };

  it('does not confirm when the core\'s parent cannot be read', async () => {
    const f = fixture();
    const a = orphanedCore(f, 'a', 100, 101);
    const summary = await migrateLegacyDashboardGateways(deps(f, {
      readParentPid: pid => (pid === 101 ? undefined : f.world.procs.get(pid)?.ppid),
    }));
    keptWithWarning(f, a, summary);
  });

  it('does not confirm a port when neither the descriptor nor the configuration has one', async () => {
    const f = fixture();
    const a = orphanedCore(f, 'a', 100, 101);
    const config = JSON.parse(readFileSync(a.file, 'utf8'));
    delete config.managedCore.port;
    writeFileSync(a.file, JSON.stringify(config));
    writeFileSync(a.descriptor, JSON.stringify({ pid: 101, processStartIdentity: 'c101' }));
    keptWithWarning(f, a, await migrateLegacyDashboardGateways(deps(f)));
  });

  it('does not read an instance lock it cannot open as "no holder"', async () => {
    const f = fixture();
    const a = orphanedCore(f, 'a', 100, 101);
    mkdirSync(a.lock, { recursive: true });
    keptWithWarning(f, a, await migrateLegacyDashboardGateways(deps(f)));
  });

  it('counts a lock holder recorded under another boot as no holder', async () => {
    const f = fixture();
    const a = orphanedCore(f, 'a', 100, 101);
    // Same pid and start time by coincidence, but the record is from an earlier boot.
    f.world.spawn(500, { start: 's500' });
    writeLock(a.lock, { pid: 500, procStart: 's500', bootId: 'boot-before' });
    const summary = await migrateLegacyDashboardGateways(deps(f, { readBootId: () => 'boot-now' }));
    expect(summary.orphansStopped).toEqual([a.configId]);
    expect(f.world.procs.get(500)!.alive).toBe(true);
  });

  it('does not confirm when the core\'s birth identity reads once and then cannot be verified', async () => {
    const f = fixture();
    const a = orphanedCore(f, 'a', 100, 101);
    let reads = 0;
    const flaky = {
      ...f.world.runtime,
      readIdentity: (pid: number) => (pid === 101 && ++reads >= 3 ? undefined : f.world.runtime.readIdentity(pid)),
    };
    keptWithWarning(f, a, await migrateLegacyDashboardGateways(deps(f, { runtime: flaky })));
  });
});

describe('a resumed migration of a gateway that was alive when it started', () => {
  it('is reported as migrated (not an orphan, not forgotten) once its journaled core is stopped', async () => {
    const f = fixture();
    const a = legacyGateway(f, 'a', 100, 101, 'ignore');
    await expect(migrateLegacyDashboardGateways(deps(f, {
      afterStep: s => { if (s === 'gateways-stopped') throw new Error('killed'); },
    }))).rejects.toThrow('killed');
    expect(f.world.procs.get(101)!.alive).toBe(true);
    f.infos.length = 0;
    const summary = await migrateLegacyDashboardGateways(deps(f));
    expect(f.world.procs.get(101)!.alive).toBe(false);
    expect(summary).toMatchObject({ migrated: [a.configId], orphansStopped: [], forgotten: [] });
    expect(f.infos).toHaveLength(1);
  });

  it('keeps reporting a resumed kept-stopped connection as kept stopped', async () => {
    const f = fixture();
    const a = legacyGateway(f, 'a', 100, 101, 'ignore');
    setWecomFleetDesiredState(a.configId, 'stopped', { root: f.root, now: AFTER_JOB });
    await expect(migrateLegacyDashboardGateways(deps(f, {
      afterStep: s => { if (s === 'gateways-stopped') throw new Error('killed'); },
    }))).rejects.toThrow('killed');
    const summary = await migrateLegacyDashboardGateways(deps(f));
    expect(summary).toMatchObject({ keptStopped: [a.configId], migrated: [], forgotten: [] });
    expect(desiredOf(f, a.configId)?.desired).toBe('stopped');
  });
});

describe('an old gateway whose identity cannot be verified', () => {
  it('is left alone with a warning and its job kept, even when nothing else names a process', async () => {
    const f = fixture();
    // No managed core at all: nothing but the gateway's own identity decides.
    const file = join(f.root, 'ext', 'config.json');
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ botId: 'bot-ext', coreUrl: 'http://127.0.0.1:18080', allowedUsers: ['u'] }));
    writeFileSync(join(f.root, 'config-registry.json'), JSON.stringify({ version: 1, paths: [file] }));
    f.world.spawn(100, { start: 'g100' });
    f.world.unreadable.add(100);
    const job = writeJob(f, wecomConfigId(file), 100, 'g100');
    const summary = await migrateLegacyDashboardGateways(deps(f));
    expect(f.world.signals).toEqual([]);
    expect(existsSync(job)).toBe(true);
    expect(summary).toEqual({ migrated: [], keptStopped: [], forgotten: [], orphansStopped: [], remaining: [] });
    expect(f.warnings).toHaveLength(1);
  });
});

describe('a credential the old gateway takes from its own environment', () => {
  it('leaves the old gateway running when the fleet\'s environment lacks the variable', async () => {
    const f = fixture();
    const a = legacyGateway(f, 'a', 100, 101, 'exit-with-core', JOB_CREATED, { secretEnv: 'PROBE_WECOM_SECRET' });
    for (const env of [{}, { PROBE_WECOM_SECRET: '' }]) {
      f.warnings.length = 0;
      const summary = await migrateLegacyDashboardGateways(deps(f, { env }));
      expect(f.world.signals).toEqual([]);
      expect(f.world.procs.get(100)!.alive).toBe(true);
      expect(existsSync(a.job)).toBe(true);
      expect(existsSync(wecomFleetDesiredStatePath(f.root))).toBe(false);
      expect(summary.remaining).toEqual([a.configId]);
      expect(f.warnings).toHaveLength(1);
      expect(f.warnings[0]).toContain('PROBE_WECOM_SECRET');
    }
  });

  it('migrates it as usual when the variable is there', async () => {
    const f = fixture();
    const a = legacyGateway(f, 'a', 100, 101, 'exit-with-core', JOB_CREATED, { secretEnv: 'PROBE_WECOM_SECRET' });
    const summary = await migrateLegacyDashboardGateways(deps(f, { env: { PROBE_WECOM_SECRET: 'set' } }));
    expect(summary.migrated).toEqual([a.configId]);
    expect(f.world.procs.get(100)!.alive).toBe(false);
  });
});

describe('a core descriptor from an earlier boot', () => {
  const BOOT = Date.parse('2026-11-18T08:00:00.000Z');
  const bootDeps = (f: Fixture, writtenAt: number | undefined, boot: ReturnType<NonNullable<LegacyGatewayMigrationDeps['readBootTime']>>) =>
    deps(f, { readBootTime: () => boot, fileWrittenAt: () => writtenAt });

  it('never leads to a signal, even when today a process has its pid and start time (Linux, injected; not run on Linux)', async () => {
    const f = fixture();
    const a = orphanedCore(f, 'a', 100, 101);
    const summary = await migrateLegacyDashboardGateways(bootDeps(f, BOOT - 3_600_000, { kind: 'known', ms: BOOT }));
    expect(f.world.signals).toEqual([]);
    expect(f.world.procs.get(101)!.alive).toBe(true);
    expect(summary).toMatchObject({ orphansStopped: [], forgotten: [a.configId] });
  });

  it('is not trusted when this boot\'s start or the descriptor\'s write time cannot be read', async () => {
    for (const [writtenAt, boot] of [[BOOT + 60_000, { kind: 'unknown' }], [undefined, { kind: 'known', ms: BOOT }]] as const) {
      const f = fixture();
      const a = orphanedCore(f, 'a', 100, 101);
      f.warnings.length = 0;
      const summary = await migrateLegacyDashboardGateways(bootDeps(f, writtenAt, boot));
      expect(f.world.signals).toEqual([]);
      expect(existsSync(a.job)).toBe(true);
      expect(summary.remaining).toEqual([a.configId]);
      expect(f.warnings).toHaveLength(1);
    }
  });

  it('still lets an orphan of this boot be stopped', async () => {
    const f = fixture();
    const a = orphanedCore(f, 'a', 100, 101);
    const summary = await migrateLegacyDashboardGateways(bootDeps(f, BOOT + 60_000, { kind: 'known', ms: BOOT }));
    expect(summary.orphansStopped).toEqual([a.configId]);
    expect(f.world.procs.get(101)!.alive).toBe(false);
  });
});

describe('when this boot began', () => {
  it('is read from /proc/stat btime on Linux, and not needed elsewhere', async () => {
    const { readBootTime } = await import('../src/cli/wecom/legacy-gateway-migration.js');
    expect(readBootTime('linux', () => 'cpu  1 2 3\nbtime 1795000000\nprocesses 9\n')).toEqual({ kind: 'known', ms: 1_795_000_000_000 });
    expect(readBootTime('linux', () => 'cpu  1 2 3\n')).toEqual({ kind: 'unknown' });
    expect(readBootTime('linux', () => { throw new Error('EACCES'); })).toEqual({ kind: 'unknown' });
    expect(readBootTime('darwin', () => { throw new Error('never read'); })).toEqual({ kind: 'not-needed' });
  });
});
