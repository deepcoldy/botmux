import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FleetSupervisor,
  pidAlive,
  type FleetBotSpec,
  type FleetGroupResolution,
} from '../src/core/fleet-supervisor.js';
import type { FleetCommand, FleetCommandResult } from '../src/core/fleet-command-queue.js';
import { mutateFleetState, readFleetState } from '../src/core/fleet-state-store.js';
import type { FleetProcState } from '../src/core/fleet-supervisor-policy.js';
import { WECOM_GATEWAY_NO_RESTART_EXIT_CODE } from '../src/im/wecom/contract/fleet-member.js';

const dirs: string[] = [];
const supervisors: FleetSupervisor[] = [];
function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-members-'));
  dirs.push(dir);
  return dir;
}
afterEach(async () => {
  for (const sup of supervisors.splice(0)) await sup.stopAll();
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

function lines(path: string): string[] {
  return existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n').filter(Boolean) : [];
}

/** A long-lived child that appends `tag` to `marker` once per launch. */
function stayScript(marker: string, tag: string): string {
  return `require('fs').appendFileSync(${JSON.stringify(marker)}, ${JSON.stringify(tag)} + String.fromCharCode(10));`
    + `process.on('SIGTERM', () => process.exit(0)); setInterval(() => {}, 1000);`;
}

function member(name: string, marker: string, configHash = 'h1'): FleetBotSpec {
  return {
    name,
    appId: '',
    botIndex: -1,
    group: 'wecom',
    external: {
      command: process.execPath,
      args: ['-e', stayScript(marker, name)],
      killTimeoutMs: 2000,
      configHash,
      restartPolicy: {
        noRestartExitCodes: [WECOM_GATEWAY_NO_RESTART_EXIT_CODE],
        initialDelayMs: 20,
        maxDelayMs: 40,
        stableRunMs: 60_000,
      },
    },
  };
}

/** A fake dist whose bot daemon records each launch with its bot index. */
function fakeDist(root: string, marker: string): string {
  const dist = join(root, 'dist');
  mkdirSync(dist, { recursive: true });
  writeFileSync(join(dist, 'index-daemon.js'),
    `require('fs').appendFileSync(${JSON.stringify(marker)}, 'daemon:' + process.env.BOTMUX_BOT_INDEX + String.fromCharCode(10));`
    + `process.on('SIGTERM', () => process.exit(90)); setInterval(() => {}, 1000);`);
  return dist;
}

interface Harness {
  sup: FleetSupervisor;
  statePath: string;
  marker: string;
  results: FleetCommandResult[];
  group: { resolution: FleetGroupResolution; fail?: string };
  row(name: string): FleetProcState | undefined;
}

function harness(): Harness {
  const root = tmp();
  const statePath = join(root, 'fleet.json');
  const marker = join(root, 'launches');
  const results: FleetCommandResult[] = [];
  const group: Harness['group'] = { resolution: { members: [], indeterminate: [] } };
  const sup = new FleetSupervisor({
    statePath,
    distDir: fakeDist(root, marker),
    daemonEnv: {},
    cwd: root,
    log: () => {},
    resolveGroup: () => {
      if (group.fail) throw new Error(group.fail);
      return group.resolution;
    },
    onMemberCommandResult: (result) => { results.push(result); },
  });
  supervisors.push(sup);
  return {
    sup,
    statePath,
    marker,
    results,
    group,
    row: (name: string) => readFleetState(statePath)?.procs.find((p) => p.name === name),
  };
}

let nextId = 0;
/** A command enqueued now (after the harness supervisor started), unless `at` says otherwise. */
function command(op: FleetCommand['op'], name: string, payload: Partial<FleetCommand> = {}): FleetCommand {
  nextId += 1;
  return { id: `cmd-${nextId}`, op, name, appId: '', botIndex: -1, at: new Date(Date.now() + 1).toISOString(), ...payload };
}

describe('start-member / stop-member (live supervisor)', () => {
  it('refuses start-member for a name the fresh resolution does not list, spawning nothing from the payload', async () => {
    const h = harness();
    h.sup.start([]);
    // The payload looks like a perfectly good bot command; it must not be used.
    const cmd = command('start-member', 'wecom-123456789abc', { appId: 'cli_payload', botIndex: 0 });
    await h.sup.drainCommands([cmd]);
    await delay(300);

    expect(h.results).toEqual([expect.objectContaining({ id: cmd.id, ok: false, reason: 'unknown_member' })]);
    expect(readFleetState(h.statePath)?.procs ?? []).toEqual([]);
    expect(lines(h.marker)).toEqual([]);
  });

  it('starts a listed member from the resolved spec, then reports already-online', async () => {
    const h = harness();
    h.sup.start([]);
    h.group.resolution = { members: [member('wecom-aaaaaaaaaaaa', h.marker)], indeterminate: [] };

    const first = command('start-member', 'wecom-aaaaaaaaaaaa');
    await h.sup.drainCommands([first]);
    expect(h.results.at(-1)).toMatchObject({ id: first.id, ok: true, state: 'started' });
    expect(await waitFor(() => lines(h.marker).includes('wecom-aaaaaaaaaaaa'))).toBe(true);
    expect(h.row('wecom-aaaaaaaaaaaa')).toMatchObject({ status: 'online', configHash: 'h1' });

    const second = command('start-member', 'wecom-aaaaaaaaaaaa');
    await h.sup.drainCommands([second]);
    expect(h.results.at(-1)).toMatchObject({ id: second.id, ok: true, state: 'already-online' });
    expect(lines(h.marker)).toEqual(['wecom-aaaaaaaaaaaa']);
  });

  it('stop-member stops a member and the following reconcile does not bring it back', async () => {
    const h = harness();
    const spec = member('wecom-bbbbbbbbbbbb', h.marker);
    h.group.resolution = { members: [spec], indeterminate: [] };
    h.sup.start([spec]);
    expect(await waitFor(() => h.row(spec.name)?.status === 'online' && lines(h.marker).length === 1)).toBe(true);
    const pid = h.row(spec.name)!.pid;

    const stop = command('stop-member', spec.name);
    await h.sup.drainCommands([stop]);
    await h.sup.reconcileGroup('wecom');
    await delay(200);

    expect(h.results.at(-1)).toMatchObject({ id: stop.id, ok: true, state: 'stopped' });
    expect(pidAlive(pid)).toBe(false);
    expect(h.row(spec.name)).toMatchObject({ status: 'stopped', pid: 0 });
    expect(lines(h.marker)).toEqual([spec.name]);
  });

  it('stop-member still stops a member the resolution just dropped, and the reconcile removes its row', async () => {
    const h = harness();
    const spec = member('wecom-cccccccccccc', h.marker);
    h.group.resolution = { members: [spec], indeterminate: [] };
    h.sup.start([spec]);
    expect(await waitFor(() => h.row(spec.name)?.status === 'online')).toBe(true);
    const pid = h.row(spec.name)!.pid;

    h.group.resolution = { members: [], indeterminate: [] }; // desired state set to stopped
    const stop = command('stop-member', spec.name);
    await h.sup.drainCommands([stop]);
    expect(h.results.at(-1)).toMatchObject({ id: stop.id, ok: true, state: 'stopped' });
    expect(pidAlive(pid)).toBe(false);

    const reconcile = await h.sup.reconcileGroup('wecom');
    expect(reconcile).toMatchObject({ status: 'reconciled', removed: [spec.name] });
    expect(h.row(spec.name)).toBeUndefined();
  });

  it('refuses stop-member for a Feishu bot and leaves it running', async () => {
    const h = harness();
    h.sup.start([{ name: 'botmux-0', appId: 'cli_a', botIndex: 0 }]);
    expect(await waitFor(() => h.row('botmux-0')?.status === 'online')).toBe(true);
    const pid = h.row('botmux-0')!.pid;

    const stop = command('stop-member', 'botmux-0', { appId: 'cli_a', botIndex: 0 });
    await h.sup.drainCommands([stop]);
    await delay(200);

    expect(h.results.at(-1)).toMatchObject({ id: stop.id, ok: false, reason: 'unknown_member' });
    expect(h.row('botmux-0')).toMatchObject({ status: 'online', pid });
    expect(pidAlive(pid)).toBe(true);
  });

  // Unchanged behaviour the dashboard's "add bot" relies on: a start-bot for a
  // name this supervisor has never seen spawns a bot daemon from the payload.
  it('start-bot for an unseen name still falls back to a daemon built from the payload', async () => {
    const h = harness();
    h.sup.start([]);
    await h.sup.drainCommands([command('start-bot', 'botmux-new', { appId: 'cli_new', botIndex: 3 })]);

    expect(await waitFor(() => lines(h.marker).includes('daemon:3'))).toBe(true);
    expect(h.row('botmux-new')).toMatchObject({ status: 'online', appId: 'cli_new' });
    expect(h.results).toEqual([]);
  });

  it('refuses start-member and changes nothing when the group cannot be resolved', async () => {
    const h = harness();
    const spec = member('wecom-dddddddddddd', h.marker);
    h.group.resolution = { members: [spec], indeterminate: [] };
    h.sup.start([spec]);
    expect(await waitFor(() => h.row(spec.name)?.status === 'online')).toBe(true);
    const pid = h.row(spec.name)!.pid;

    h.group.fail = 'desired state unavailable';
    const start = command('start-member', 'wecom-eeeeeeeeeeee');
    await h.sup.drainCommands([start]);
    const reconcile = await h.sup.reconcileGroup('wecom');

    expect(h.results.at(-1)).toMatchObject({ id: start.id, ok: false, reason: 'resolve_failed' });
    expect(reconcile.status).toBe('skipped');
    expect(h.row(spec.name)).toMatchObject({ status: 'online', pid });
    expect(pidAlive(pid)).toBe(true);
  });

  it('stop-member for a listed member this supervisor never ran: already-stopped, and the reconcile does not start it', async () => {
    const h = harness();
    const spec = member('wecom-777777777777', h.marker);
    h.group.resolution = { members: [spec], indeterminate: [] };
    h.sup.start([]); // e.g. its connection was set to running without a start-member yet

    const stop = command('stop-member', spec.name);
    await h.sup.drainCommands([stop]);
    const reconcile = await h.sup.reconcileGroup('wecom');
    await delay(300);

    expect(h.results.at(-1)).toMatchObject({ id: stop.id, ok: true, state: 'already-stopped' });
    expect(reconcile).toMatchObject({ status: 'reconciled', started: [] });
    expect(h.row(spec.name)?.status).not.toBe('online');
    expect(lines(h.marker)).toEqual([]);
  });

  it('stop-member reports stopped for a running member and already-stopped once it is down', async () => {
    const h = harness();
    const spec = member('wecom-888888888888', h.marker);
    h.group.resolution = { members: [spec], indeterminate: [] };
    h.sup.start([spec]);
    expect(await waitFor(() => h.row(spec.name)?.status === 'online')).toBe(true);

    const first = command('stop-member', spec.name);
    const second = command('stop-member', spec.name);
    await h.sup.drainCommands([first]);
    await h.sup.drainCommands([second]);

    expect(h.results.map(r => [r.id, r.ok ? r.state : r.reason])).toEqual([
      [first.id, 'stopped'],
      [second.id, 'already-stopped'],
    ]);
  });

  it('refuses member commands while the supervisor is shutting down', async () => {
    const h = harness();
    const spec = member('wecom-999999999999', h.marker);
    h.group.resolution = { members: [spec], indeterminate: [] };
    h.sup.start([]);
    await h.sup.stopAll();

    await h.sup.drainCommands([command('start-member', spec.name), command('stop-member', spec.name)]);
    await delay(200);

    expect(h.results.map(r => (r.ok ? r.state : r.reason))).toEqual(['supervisor_stopping', 'supervisor_stopping']);
    expect(lines(h.marker)).toEqual([]);
  });
});

describe('reconcileGroup (live supervisor)', () => {
  it('starts a newly listed member and stops + removes one no longer listed', async () => {
    const h = harness();
    const leaving = member('wecom-111111111111', h.marker);
    const staying = member('wecom-222222222222', h.marker);
    const arriving = member('wecom-333333333333', h.marker);
    h.group.resolution = { members: [leaving, staying], indeterminate: [] };
    h.sup.start([leaving, staying]);
    expect(await waitFor(() => h.row(leaving.name)?.status === 'online' && h.row(staying.name)?.status === 'online')).toBe(true);
    const leavingPid = h.row(leaving.name)!.pid;
    const stayingPid = h.row(staying.name)!.pid;

    h.group.resolution = { members: [staying, arriving], indeterminate: [] };
    const result = await h.sup.reconcileGroup('wecom');

    expect(result).toMatchObject({ status: 'reconciled', started: [arriving.name], removed: [leaving.name] });
    expect(await waitFor(() => h.row(arriving.name)?.status === 'online')).toBe(true);
    expect(h.row(leaving.name)).toBeUndefined();
    expect(pidAlive(leavingPid)).toBe(false);
    expect(h.row(staying.name)).toMatchObject({ status: 'online', pid: stayingPid });
  });

  it('leaves an indeterminate member running and does not touch members outside the group', async () => {
    const h = harness();
    const unreadable = member('wecom-444444444444', h.marker);
    h.group.resolution = { members: [unreadable], indeterminate: [] };
    h.sup.start([{ name: 'botmux-0', appId: 'cli_a', botIndex: 0 }, unreadable]);
    expect(await waitFor(() => h.row(unreadable.name)?.status === 'online' && h.row('botmux-0')?.status === 'online')).toBe(true);
    const pids = [h.row(unreadable.name)!.pid, h.row('botmux-0')!.pid];

    h.group.resolution = { members: [], indeterminate: [unreadable.name] };
    const result = await h.sup.reconcileGroup('wecom');

    expect(result).toMatchObject({ status: 'reconciled', started: [], removed: [] });
    expect([h.row(unreadable.name)!.pid, h.row('botmux-0')!.pid]).toEqual(pids);
    expect(pids.every(pidAlive)).toBe(true);
  });

  it('does not restart a member parked errored by its no-restart exit', async () => {
    const h = harness();
    const parked: FleetBotSpec = {
      ...member('wecom-555555555555', h.marker),
      external: {
        ...member('wecom-555555555555', h.marker).external!,
        args: ['-e', `process.exit(${WECOM_GATEWAY_NO_RESTART_EXIT_CODE});`],
      },
    };
    h.group.resolution = { members: [parked], indeterminate: [] };
    h.sup.start([parked]);
    expect(await waitFor(() => h.row(parked.name)?.status === 'errored')).toBe(true);

    const result = await h.sup.reconcileGroup('wecom');
    await delay(200);
    expect(result).toMatchObject({ status: 'reconciled', started: [] });
    expect(h.row(parked.name)).toMatchObject({ status: 'errored', pid: 0 });
  });

  it('a refreshed spec is what the next policy restart uses', async () => {
    const h = harness();
    const v1 = member('wecom-666666666666', h.marker, 'h1');
    h.group.resolution = { members: [v1], indeterminate: [] };
    h.sup.start([v1]);
    expect(await waitFor(() => h.row(v1.name)?.status === 'online')).toBe(true);

    const v2 = member('wecom-666666666666', h.marker, 'h2');
    h.group.resolution = { members: [v2], indeterminate: [] };
    const result = await h.sup.reconcileGroup('wecom');
    expect(result).toMatchObject({ status: 'reconciled', updated: [v1.name], started: [] });
    expect(h.row(v1.name)!.configHash).toBe('h1'); // a refresh alone restarts nothing

    const pid = h.row(v1.name)!.pid;
    process.kill(pid, 'SIGKILL');
    expect(await waitFor(() => {
      const row = h.row(v1.name);
      return !!row && row.status === 'online' && row.pid !== pid;
    })).toBe(true);
    expect(h.row(v1.name)!.configHash).toBe('h2');
  });
});

describe('member ops left behind, and intents recorded after a command', () => {
  it('drops a member op enqueued before this supervisor started, without an answer, and still runs start-bot', async () => {
    const h = harness();
    const spec = member('wecom-a1a1a1a1a1a1', h.marker);
    h.group.resolution = { members: [spec], indeterminate: [] };
    const before = new Date(Date.now() - 60_000).toISOString();
    h.sup.start([spec]);
    expect(await waitFor(() => h.row(spec.name)?.status === 'online')).toBe(true);
    const pid = h.row(spec.name)!.pid;

    // A stop-member a previous supervisor never drained, next to a Feishu start-bot as old.
    await h.sup.drainCommands([
      command('stop-member', spec.name, { at: before }),
      command('start-bot', 'botmux-new', { appId: 'cli_new', botIndex: 3, at: before }),
    ]);

    expect(h.results).toEqual([]);
    expect(h.row(spec.name)).toMatchObject({ status: 'online', pid });
    expect(pidAlive(pid)).toBe(true);
    expect(await waitFor(() => lines(h.marker).includes('daemon:3'))).toBe(true);
  });

  it('treats a member op stamped in the very millisecond this supervisor started as older, and one a millisecond later as its own', async () => {
    const root = tmp();
    const marker = join(root, 'launches');
    const results: FleetCommandResult[] = [];
    const startedAt = Date.parse('2026-11-18T10:00:00.000Z');
    const spec = member('wecom-a3a3a3a3a3a3', marker);
    const sup = new FleetSupervisor({
      statePath: join(root, 'fleet.json'),
      distDir: fakeDist(root, marker),
      daemonEnv: {},
      cwd: root,
      log: () => {},
      now: () => startedAt,
      resolveGroup: () => ({ members: [spec], indeterminate: [] }),
      onMemberCommandResult: (result) => { results.push(result); },
    });
    supervisors.push(sup);
    sup.start([]);
    await sup.drainCommands([command('start-member', spec.name, { at: new Date(startedAt).toISOString() })]);
    expect(results).toEqual([]);
    const own = command('start-member', spec.name, { at: new Date(startedAt + 1).toISOString() });
    await sup.drainCommands([own]);
    expect(results).toEqual([expect.objectContaining({ id: own.id, ok: true, state: 'started' })]);
  });

  it('drops a member op whose enqueue time cannot be read', async () => {
    const h = harness();
    const spec = member('wecom-a2a2a2a2a2a2', h.marker);
    h.group.resolution = { members: [spec], indeterminate: [] };
    h.sup.start([]);
    await h.sup.drainCommands([command('start-member', spec.name, { at: '' })]);
    await delay(200);
    expect(h.results).toEqual([]);
    expect(lines(h.marker)).toEqual([]);
  });

  it('refuses a stop-member when running was recorded at or after it was enqueued, and carries out an older one', async () => {
    const h = harness();
    const spec = member('wecom-b1b1b1b1b1b1', h.marker);
    h.group.resolution = { members: [spec], indeterminate: [] };
    h.sup.start([spec]);
    expect(await waitFor(() => h.row(spec.name)?.status === 'online')).toBe(true);
    const pid = h.row(spec.name)!.pid;

    const stale = command('stop-member', spec.name);
    const enqueuedAt = Date.parse(stale.at);
    for (const recordedAt of [enqueuedAt + 5_000, enqueuedAt]) {
      h.group.resolution = {
        members: [spec],
        indeterminate: [],
        intents: new Map([[spec.name, { desired: 'running', recordedAt, automatic: false }]]),
      };
      await h.sup.drainCommands([{ ...stale, id: `${stale.id}-${recordedAt}` }]);
      expect(h.results.at(-1)).toMatchObject({ ok: false, reason: 'superseded' });
      expect(h.row(spec.name)).toMatchObject({ status: 'online', pid });
    }

    h.group.resolution = {
      members: [spec],
      indeterminate: [],
      intents: new Map([[spec.name, { desired: 'running', recordedAt: enqueuedAt - 1, automatic: false }]]),
    };
    const fresh = command('stop-member', spec.name);
    await h.sup.drainCommands([fresh]);
    expect(h.results.at(-1)).toMatchObject({ id: fresh.id, ok: true, state: 'stopped' });
    expect(pidAlive(pid)).toBe(false);
  });

  it('refuses a start-member when a person recorded a stop after it, but not when the gateway did', async () => {
    const h = harness();
    const spec = member('wecom-b2b2b2b2b2b2', h.marker);
    h.sup.start([]);
    const start = command('start-member', spec.name);
    const later = Date.parse(start.at) + 5_000;

    h.group.resolution = {
      members: [spec],
      indeterminate: [],
      intents: new Map([[spec.name, { desired: 'stopped', recordedAt: later, automatic: false }]]),
    };
    await h.sup.drainCommands([start]);
    await delay(200);
    expect(h.results.at(-1)).toMatchObject({ id: start.id, ok: false, reason: 'superseded' });
    expect(lines(h.marker)).toEqual([]);

    h.group.resolution = {
      members: [spec],
      indeterminate: [],
      intents: new Map([[spec.name, { desired: 'stopped', recordedAt: later, automatic: true }]]),
    };
    const again = command('start-member', spec.name);
    await h.sup.drainCommands([again]);
    expect(h.results.at(-1)).toMatchObject({ id: again.id, ok: true, state: 'started' });
    expect(await waitFor(() => lines(h.marker).includes(spec.name))).toBe(true);
  });

  it('does not call a member whose process is shutting itself down "already online", and starts nothing next to it', async () => {
    const h = harness();
    const spec = member('wecom-c1c1c1c1c1c1', h.marker);
    h.group.resolution = { members: [spec], indeterminate: [] };
    h.sup.start([spec]);
    expect(await waitFor(() => h.row(spec.name)?.status === 'online' && lines(h.marker).length === 1)).toBe(true);
    const pid = h.row(spec.name)!.pid;

    h.group.resolution = { members: [spec], indeterminate: [], shuttingDown: new Map([[spec.name, pid]]) };
    const start = command('start-member', spec.name);
    await h.sup.drainCommands([start]);
    await delay(200);
    expect(h.results.at(-1)).toMatchObject({ id: start.id, ok: false, reason: 'member_stopping' });
    expect(lines(h.marker)).toEqual([spec.name]);

    // An earlier generation's report (another pid) does not count.
    h.group.resolution = { members: [spec], indeterminate: [], shuttingDown: new Map([[spec.name, pid + 100_000]]) };
    const next = command('start-member', spec.name);
    await h.sup.drainCommands([next]);
    expect(h.results.at(-1)).toMatchObject({ id: next.id, ok: true, state: 'already-online' });
  });

  // The supervisor never starts a second process next to a live one it does not
  // own (the unowned-process guard in FleetSupervisor.spawnBot), so such a member
  // is neither answered "already online" nor started: the start-member is refused.
  it('refuses a start-member whose online row names a live process this supervisor did not spawn, starting nothing next to it', async () => {
    const h = harness();
    const spec = member('wecom-c2c2c2c2c2c2', h.marker);
    h.group.resolution = { members: [spec], indeterminate: [] };
    h.sup.start([]);
    // A row left online by an earlier supervisor, naming a live process (this test runner).
    mutateFleetState(h.statePath, (cur) => {
      cur.procs.push({
        name: spec.name, appId: '', pid: process.pid, status: 'online', generation: 1,
        restarts: 0, startedAt: new Date().toISOString(), lastExitCode: null,
      } as FleetProcState);
      return cur;
    });
    const start = command('start-member', spec.name);
    await h.sup.drainCommands([start]);
    await delay(300);
    expect(h.results.at(-1)).toMatchObject({ id: start.id, ok: false, reason: 'spawn_failed' });
    expect(lines(h.marker)).toEqual([]);
    expect(h.row(spec.name)!.pid).toBe(process.pid);
  });
});

describe('a start-member and the backoff restart of a gateway that exited retryably', () => {
  /** A member whose first launch exits with 1 (as a gateway whose stop was superseded
   *  by a person's `running` does), and later launches stay up. Backoff: 400 ms. */
  function retryingMember(name: string, marker: string): FleetBotSpec {
    const script = `const fs = require('fs'); const m = ${JSON.stringify(marker)};`
      + `const n = fs.existsSync(m) ? fs.readFileSync(m, 'utf8').split(String.fromCharCode(10)).filter(Boolean).length : 0;`
      + `fs.appendFileSync(m, ${JSON.stringify(name)} + String.fromCharCode(10));`
      + `if (n === 0) setTimeout(() => process.exit(1), 100);`
      + `process.on('SIGTERM', () => process.exit(0)); setInterval(() => {}, 1000);`;
    const base = member(name, marker);
    return {
      ...base,
      external: { ...base.external!, args: ['-e', script], restartPolicy: { ...base.external!.restartPolicy!, initialDelayMs: 400, maxDelayMs: 400 } },
    };
  }

  it('start-member during the backoff starts one generation, and the backoff timer does not start another', async () => {
    const h = harness();
    const spec = retryingMember('wecom-d1d1d1d1d1d1', h.marker);
    h.group.resolution = { members: [spec], indeterminate: [] };
    h.sup.start([spec]);
    expect(await waitFor(() => h.row(spec.name)?.status === 'launching')).toBe(true); // exited 1, backoff pending

    const start = command('start-member', spec.name);
    await h.sup.drainCommands([start]);
    expect(h.results.at(-1)).toMatchObject({ id: start.id, ok: true, state: 'started' });
    const pid = h.row(spec.name)!.pid;
    await delay(900); // well past the backoff
    expect(lines(h.marker)).toHaveLength(2);
    expect(h.row(spec.name)).toMatchObject({ status: 'online', pid });
  });

  it('start-member after the backoff already brought it back answers already-online and starts nothing', async () => {
    const h = harness();
    const spec = retryingMember('wecom-d2d2d2d2d2d2', h.marker);
    h.group.resolution = { members: [spec], indeterminate: [] };
    h.sup.start([spec]);
    expect(await waitFor(() => lines(h.marker).length === 2 && h.row(spec.name)?.status === 'online')).toBe(true);
    const pid = h.row(spec.name)!.pid;

    const start = command('start-member', spec.name);
    await h.sup.drainCommands([start]);
    await delay(600);
    expect(h.results.at(-1)).toMatchObject({ id: start.id, ok: true, state: 'already-online' });
    expect(lines(h.marker)).toHaveLength(2);
    expect(h.row(spec.name)).toMatchObject({ status: 'online', pid });
  });
});
