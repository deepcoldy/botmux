/**
 * How often one Dashboard connection list asks the process table about a
 * gateway: once per process, however many records name it — counted on the
 * injected process runtime, every call of which is a `ps` on macOS. The check
 * that catches a pid recycled between an inspection's two samples still holds,
 * and nothing carries over to the next list.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WecomDashboardManager } from '../src/dashboard/wecom/manager.js';
import { wecomConfigId } from '../src/im/wecom/config/discovery.js';
import { wecomBotRoot } from '../src/im/wecom/config/runtime.js';
import { setWecomFleetDesiredState } from '../src/im/wecom/config/fleet-desired-state.js';
import { wecomFleetMemberName } from '../src/im/wecom/contract/fleet-member.js';
import type { FleetProcessIdentityRuntime } from '../src/core/fleet-process-identity.js';
import type { FleetProcState } from '../src/core/fleet-supervisor-policy.js';

const NOW = 1_800_000_000_000;
const SUPERVISOR = 400;
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Connections (one per bot id given), a fleet state and a process table that counts identity reads by pid. */
function world(bots: string[]) {
  const root = mkdtempSync(join(tmpdir(), 'wecom-probes-'));
  roots.push(root);
  const files = bots.map((botId, index) => {
    const file = index === 0 ? join(root, 'config.json') : join(root, `custom-${index}`, 'config.json');
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, JSON.stringify({ botId, secretFile: join(root, 'unused'), coreUrl: 'http://127.0.0.1:19123', allowedUsers: ['u'] }));
    return file;
  });
  if (files.length > 1) {
    writeFileSync(join(root, 'config-registry.json'), JSON.stringify({ version: 1, paths: files.slice(1) }));
  }
  const ids = files.map(file => wecomConfigId(file));
  /** pid → the identity each successive read returns (the last one repeats). */
  const births = new Map<number, string[]>([[SUPERVISOR, ['supervisor-birth']]]);
  const hidden = new Set<number>();
  const identityReads = new Map<number, number>();
  const runtime: FleetProcessIdentityRuntime = {
    readIdentity(pid) {
      const count = (identityReads.get(pid) ?? 0) + 1;
      identityReads.set(pid, count);
      if (hidden.has(pid)) return undefined;
      const answers = births.get(pid);
      return answers?.[Math.min(count, answers.length) - 1];
    },
    readCommandLine: pid => (pid === SUPERVISOR ? 'fixture-supervisor' : undefined),
    readPidNamespace: () => undefined,
    pidExists: pid => births.has(pid),
  };
  const rows: FleetProcState[] = [];
  const manager = new WecomDashboardManager({
    root,
    runtime,
    now: () => NOW,
    readFleetState: () => ({
      supervisorPid: SUPERVISOR,
      supervisorStartedAt: 't',
      supervisorProcessStart: 'supervisor-birth',
      supervisorCommand: 'fixture-supervisor',
      procs: rows,
    } as any),
    runLifecycle: () => new Promise(() => {}),
  });
  return {
    root, ids, births, hidden, manager,
    reads: (pid: number) => identityReads.get(pid) ?? 0,
    resetReads: () => identityReads.clear(),
    /** The connection's gateway as the fleet runs it: member row online and the gateway's own runtime record. */
    running(index: number, pid: number) {
      births.set(pid, [`birth-${pid}`]);
      setWecomFleetDesiredState(ids[index], 'running', { root });
      rows.push({
        name: wecomFleetMemberName(ids[index]), appId: '', pid, generation: 1, status: 'online', restarts: 0,
        lastExitCode: null, startedAt: 't', processStart: `birth-${pid}`,
      } as FleetProcState);
      const dir = wecomBotRoot(bots[index], root);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'runtime.json'), JSON.stringify({
        version: 1, configId: ids[index], pid, processStart: `birth-${pid}`, instanceId: 'i', connection: 'connected', phase: 'running', updatedAt: NOW - 1_000,
      }));
    },
    /** Only the fleet member row, online (another configuration of a bot, say). */
    member(index: number, pid: number, birth = `birth-${pid}`) {
      births.set(pid, [birth]);
      rows.push({
        name: wecomFleetMemberName(ids[index]), appId: '', pid, generation: 1, status: 'online', restarts: 0,
        lastExitCode: null, startedAt: 't', processStart: birth,
      } as FleetProcState);
    },
    /** Only the bot's runtime record, written by the gateway of configuration `index`. */
    runtimeRecord(index: number, pid: number, birth: string) {
      const dir = wecomBotRoot(bots[index], root);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'runtime.json'), JSON.stringify({
        version: 1, configId: ids[index], pid, processStart: birth, instanceId: 'i', connection: 'connected', phase: 'running', updatedAt: NOW - 1_000,
      }));
    },
  };
}

const withoutId = (row: Record<string, unknown>) => ({ ...row, id: undefined });

describe('process probes of one WeCom connection list', () => {
  it('reads a running gateway\'s identity twice per list though its runtime record and fleet member both name it', async () => {
    const one = world(['bot-a']);
    one.running(0, 300);
    const [row] = await one.manager.list();
    expect(row).toMatchObject({ gateway: 'running', ownership: 'fleet' });
    expect(one.reads(300)).toBe(2);

    const three = world(['bot-a', 'bot-b', 'bot-c']);
    three.running(0, 301);
    three.running(1, 302);
    three.running(2, 303);
    const rows = await three.manager.list();
    expect(rows.map(item => item.gateway)).toEqual(['running', 'running', 'running']);
    expect([301, 302, 303].map(pid => three.reads(pid))).toEqual([2, 2, 2]);
  });

  it('reads afresh in the next list, so a gateway that stopped shows as stopped at once', async () => {
    const w = world(['bot-a']);
    w.running(0, 300);
    await w.manager.list();
    await w.manager.list();
    expect(w.reads(300)).toBe(4);

    w.births.delete(300);
    const [row] = await w.manager.list();
    expect(row.gateway).not.toBe('running');
  });

  it('still catches a pid recycled between an inspection\'s two samples', async () => {
    const recycled = world(['bot-a']);
    recycled.running(0, 300);
    // The first read sees the gateway; from the second on, another process owns the pid.
    recycled.births.set(300, ['birth-300', 'someone-else']);
    const [row] = await recycled.manager.list();

    const settledRecycle = world(['bot-a']);
    settledRecycle.running(0, 300);
    settledRecycle.births.set(300, ['someone-else']);
    const [expected] = await settledRecycle.manager.list();

    expect(row.gateway).not.toBe('running');
    expect(withoutId(row)).toEqual(withoutId(expected));
  });

  it('reads a pid afresh once its identity changed between two reads, then settles on the new identity', async () => {
    // Two configurations of one bot. The bot's runtime record still names the first configuration's
    // gateway; by the second read of that pid another process — the second configuration's member —
    // owns it.
    const w = world(['shared', 'shared']);
    w.runtimeRecord(0, 300, 'old-gateway');
    w.member(1, 300, 'new-gateway');
    w.births.set(300, ['old-gateway', 'new-gateway']);

    const rows = await w.manager.list();

    // The rows are what the new process alone shows (the pid owned by it from the start).
    const steady = world(['shared', 'shared']);
    steady.runtimeRecord(0, 300, 'old-gateway');
    steady.member(1, 300, 'new-gateway');
    const expected = await steady.manager.list();
    expect(rows.map(withoutId)).toEqual(expected.map(withoutId));
    // Two reads that disagreed (old, new) settle nothing: the member's inspection reads the pid
    // twice more itself. Those two agree, so the record's second inspection (for the second
    // configuration) is answered without reading again.
    expect(w.reads(300)).toBe(4);
  });

  it('inspects a sibling configuration\'s unverifiable member once for the whole list', async () => {
    // Two configurations of one bot; the other one's gateway is online but its identity cannot be read.
    const w = world(['shared', 'shared']);
    w.member(1, 600);
    w.hidden.add(600);
    const rows = await w.manager.list();
    expect(rows).toHaveLength(2);
    expect(w.reads(600)).toBe(1);
  });

  it('builds one connection\'s row from its own processes only, the same row the list shows', async () => {
    const w = world(['bot-a', 'bot-b', 'bot-c']);
    w.running(0, 301);
    w.running(1, 302);
    w.running(2, 303);
    const listed = await w.manager.list();
    w.resetReads();

    const row = await w.manager.connection(w.ids[1]);

    expect(row).toEqual(listed[1]);
    expect([301, 302, 303].map(pid => w.reads(pid))).toEqual([0, 2, 0]);
    expect(await w.manager.connection('f'.repeat(64))).toBeUndefined();
  });
});
