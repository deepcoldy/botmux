import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { FleetProcessIdentityRuntime } from '../src/core/fleet-process-identity.js';
import type { FleetProcState } from '../src/core/fleet-supervisor-policy.js';
import { wecomFleetMemberName } from '../src/im/wecom/contract/fleet-member.js';
import { wecomBotRoot } from '../src/im/wecom/config/runtime.js';
import {
  findExternalWecomInstance,
  gatherWecomInstanceFacts,
} from '../src/im/wecom/config/fleet-external-instance.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);

/** A WeCom root, a fake process table (pid → birth identity) and fleet rows. */
function world() {
  const root = mkdtempSync(join(tmpdir(), 'wecom-external-'));
  dirs.push(root);
  const births = new Map<number, string>();
  const runtime: FleetProcessIdentityRuntime = {
    readIdentity: pid => births.get(pid),
    readCommandLine: () => undefined,
    readPidNamespace: () => undefined,
    pidExists: pid => births.has(pid),
  };
  const rows = new Map<string, FleetProcState>();
  const write = (path: string, value: unknown) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value));
  };
  return {
    root,
    births,
    rows,
    member(configId: string, pid: number, status: FleetProcState['status'] = 'online') {
      births.set(pid, `s${pid}`);
      rows.set(wecomFleetMemberName(configId), {
        name: wecomFleetMemberName(configId), appId: '', pid, status, generation: 1, restarts: 0,
        lastExitCode: null, startedAt: 'T', processStart: `s${pid}`,
      });
    },
    /** An online member whose row carries no birth identity (the supervisor could not read it); its pid is alive. */
    memberWithoutBirth(configId: string, pid: number) {
      births.set(pid, `s${pid}`);
      rows.set(wecomFleetMemberName(configId), {
        name: wecomFleetMemberName(configId), appId: '', pid, status: 'online', generation: 1, restarts: 0,
        lastExitCode: null, startedAt: 'T',
      });
    },
    lock(holder: unknown) {
      write(join(wecomBotRoot('bot-x', root), 'instance.lock'), holder);
    },
    runtimeRecord(configId: string, pid: number, phase = 'running') {
      write(join(wecomBotRoot('bot-x', root), 'runtime.json'), {
        version: 1, configId, pid, processStart: `s${pid}`, instanceId: 'i', connection: 'connected', phase, updatedAt: Date.now(),
      });
    },
    legacyJob(configId: string, pid: number) {
      write(join(root, 'dashboard-jobs', `${configId}.json`), { version: 1, configId, pid, processStart: `s${pid}` });
    },
    verdict(connections = [{ configId: A, botId: 'bot-x' }]) {
      return findExternalWecomInstance(gatherWecomInstanceFacts({ root, configId: A, botId: 'bot-x', connections, rows, runtime }));
    },
  };
}

describe('is the bot already run outside the fleet?', () => {
  it('no: nothing holds it', () => {
    expect(world().verdict()).toEqual({ kind: 'none' });
  });

  it('no: the connection\'s own fleet member runs it (its lock and runtime record included)', () => {
    const w = world();
    w.member(A, 300);
    w.lock({ pid: 300, procStart: 's300' });
    w.runtimeRecord(A, 300);
    expect(w.verdict()).toEqual({ kind: 'none' });
  });

  it('no: the connection\'s own member row carries no birth identity, so its gateway\'s runtime record is not a terminal\'s', () => {
    const w = world();
    w.memberWithoutBirth(A, 300);
    w.lock({ pid: 300, procStart: 's300' });
    w.runtimeRecord(A, 300);
    expect(w.verdict()).toEqual({ kind: 'none' });
  });

  it('cannot tell: another configuration of the same bot is online in the fleet without a birth identity', () => {
    const w = world();
    w.memberWithoutBirth(B, 600);
    expect(w.verdict([{ configId: A, botId: 'bot-x' }, { configId: B, botId: 'bot-x' }]))
      .toEqual({ kind: 'unverifiable', source: 'same_bot', pid: 600, configId: B });
  });

  it('yes: a live process outside the fleet holds the bot\'s instance lock', () => {
    const w = world();
    w.births.set(400, 's400');
    w.lock({ pid: 400, procStart: 's400' });
    expect(w.verdict()).toEqual({ kind: 'external', source: 'instance_lock', pid: 400 });
  });

  it('no: the lock\'s recorded holder is gone, or its pid is another process now', () => {
    const w = world();
    w.lock({ pid: 400, procStart: 's400' });
    expect(w.verdict()).toEqual({ kind: 'none' });
    w.births.set(400, 'someone-else');
    expect(w.verdict()).toEqual({ kind: 'none' });
  });

  it('a holder recorded without a start time: unverifiable while its pid exists, nobody once it does not', () => {
    const w = world();
    w.lock('400');
    expect(w.verdict()).toEqual({ kind: 'none' });
    w.births.set(400, 's400');
    expect(w.verdict()).toEqual({ kind: 'unverifiable', source: 'instance_lock', pid: 400 });
  });

  it('yes: this configuration\'s gateway runs in a terminal (a live runtime record that is not the fleet member)', () => {
    const w = world();
    w.births.set(500, 's500');
    w.runtimeRecord(A, 500);
    w.lock({ pid: 500, procStart: 's500' });
    expect(w.verdict()).toEqual({ kind: 'external', source: 'terminal_gateway', pid: 500 });
  });

  it('yes: another configuration of the same bot runs it as a fleet member', () => {
    const w = world();
    w.member(B, 600);
    expect(w.verdict([{ configId: A, botId: 'bot-x' }, { configId: B, botId: 'bot-x' }]))
      .toEqual({ kind: 'external', source: 'same_bot', pid: 600, configId: B });
    // A configuration of another bot does not count.
    expect(w.verdict([{ configId: A, botId: 'bot-x' }, { configId: B, botId: 'bot-y' }])).toEqual({ kind: 'none' });
  });

  it('yes: another configuration of the same bot runs it in a terminal', () => {
    const w = world();
    w.births.set(700, 's700');
    w.runtimeRecord(B, 700);
    expect(w.verdict()).toEqual({ kind: 'external', source: 'same_bot', pid: 700, configId: B });
  });

  it('yes: an older Dashboard\'s gateway for this connection is still alive', () => {
    const w = world();
    w.births.set(800, 's800');
    w.legacyJob(A, 800);
    expect(w.verdict()).toEqual({ kind: 'external', source: 'legacy_gateway' });
  });
});
