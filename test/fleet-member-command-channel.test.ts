import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  drainFleetCommands,
  enqueueFleetCommand,
  readFleetCommandResult,
  readFleetCommands,
  recordFleetCommandResult,
  withdrawFleetCommand,
  type FleetCommandResult,
} from '../src/core/fleet-command-queue.js';
import { fleetSupervisorStillRunning, signalFleetReconcile, submitFleetMemberCommand } from '../src/core/fleet-runtime.js';
import { writeFleetState } from '../src/core/fleet-state-store.js';
import type { FleetProcessIdentityRuntime } from '../src/core/fleet-process-identity.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-member-channel-'));
  dirs.push(dir);
  return dir;
}

function result(id: string, overrides: Partial<FleetCommandResult> = {}): FleetCommandResult {
  return { id, op: 'start-member', name: 'wecom-aaaaaaaaaaaa', ok: true, state: 'started', at: 'T', ...overrides } as FleetCommandResult;
}

describe('member ops on the command queue', () => {
  it('keeps every member op for one name, in order: each has a caller waiting for its own answer', () => {
    const path = join(tmp(), 'cmds.json');
    enqueueFleetCommand(path, { id: '1', op: 'start-member', name: 'wecom-aaaaaaaaaaaa', appId: '', botIndex: -1, at: 'T' });
    enqueueFleetCommand(path, { id: '2', op: 'start-bot', name: 'botmux-0', appId: 'cli_a', botIndex: 0, at: 'T' });
    enqueueFleetCommand(path, { id: '3', op: 'stop-member', name: 'wecom-aaaaaaaaaaaa', appId: '', botIndex: -1, at: 'T' });
    enqueueFleetCommand(path, { id: '3', op: 'stop-member', name: 'wecom-aaaaaaaaaaaa', appId: '', botIndex: -1, at: 'T' });

    expect(drainFleetCommands(path).map(c => [c.id, c.op, c.name])).toEqual([
      ['1', 'start-member', 'wecom-aaaaaaaaaaaa'],
      ['2', 'start-bot', 'botmux-0'],
      ['3', 'stop-member', 'wecom-aaaaaaaaaaaa'],
    ]);
    expect(readFleetCommands(path)).toEqual([]);
  });

  it('still collapses start-bot / stop-bot for one bot to the latest, as before', () => {
    const path = join(tmp(), 'cmds.json');
    enqueueFleetCommand(path, { id: '1', op: 'start-bot', name: 'botmux-0', appId: 'cli_a', botIndex: 0, at: 'T' });
    enqueueFleetCommand(path, { id: '2', op: 'start-member', name: 'wecom-aaaaaaaaaaaa', appId: '', botIndex: -1, at: 'T' });
    enqueueFleetCommand(path, { id: '3', op: 'stop-bot', name: 'botmux-0', appId: 'cli_a', botIndex: 0, at: 'T' });
    expect(drainFleetCommands(path).map(c => c.id)).toEqual(['2', '3']);
  });

  it('takes back one queued command by id and leaves the others', () => {
    const path = join(tmp(), 'cmds.json');
    expect(withdrawFleetCommand(path, 'x')).toBe(false);
    enqueueFleetCommand(path, { id: 'a', op: 'stop-member', name: 'wecom-aaaaaaaaaaaa', appId: '', botIndex: -1, at: 'T' });
    enqueueFleetCommand(path, { id: 'b', op: 'start-bot', name: 'botmux-0', appId: 'cli_a', botIndex: 0, at: 'T' });
    expect(withdrawFleetCommand(path, 'a')).toBe(true);
    expect(withdrawFleetCommand(path, 'a')).toBe(false);
    expect(readFleetCommands(path).map(c => c.id)).toEqual(['b']);
  });

  it('still drops an op it does not know', () => {
    const path = join(tmp(), 'cmds.json');
    writeFileSync(path, JSON.stringify({ commands: [
      { id: 'x', op: 'restart-everything', name: 'wecom-aaaaaaaaaaaa', appId: '', botIndex: -1, at: 'T' },
      { id: 'y', op: 'stop-member', name: 'wecom-aaaaaaaaaaaa', appId: '', botIndex: -1, at: 'T' },
    ] }));
    expect(readFleetCommands(path).map(c => c.id)).toEqual(['y']);
  });
});

describe('member command results', () => {
  it('returns the outcome recorded for an id, success or refusal', () => {
    const path = join(tmp(), 'results.json');
    expect(readFleetCommandResult(path, 'a')).toBeUndefined();
    recordFleetCommandResult(path, result('a'));
    recordFleetCommandResult(path, result('b', { ok: false, reason: 'unknown_member', message: 'nope' } as Partial<FleetCommandResult>));

    expect(readFleetCommandResult(path, 'a')).toMatchObject({ ok: true, state: 'started' });
    expect(readFleetCommandResult(path, 'b')).toMatchObject({ ok: false, reason: 'unknown_member', message: 'nope' });
  });

  it('keeps a bounded history, dropping the oldest first', () => {
    const path = join(tmp(), 'results.json');
    for (let i = 0; i < 200; i += 1) recordFleetCommandResult(path, result(`id-${i}`));
    expect(readFleetCommandResult(path, 'id-199')).toBeDefined();
    expect(readFleetCommandResult(path, 'id-0')).toBeUndefined();
  });

  it('ignores a damaged or foreign result instead of reporting it', () => {
    const path = join(tmp(), 'results.json');
    writeFileSync(path, JSON.stringify({ results: [
      { id: 'a', op: 'start-member', name: 'n', ok: true, state: 'teleported', at: 'T' },
      { id: 'b', op: 'start-bot', name: 'n', ok: true, state: 'started', at: 'T' },
    ] }));
    expect(readFleetCommandResult(path, 'a')).toBeUndefined();
    expect(readFleetCommandResult(path, 'b')).toBeUndefined();
    writeFileSync(path, '{ not json');
    expect(readFleetCommandResult(path, 'a')).toBeUndefined();
  });
});

describe('submitFleetMemberCommand / signalFleetReconcile without a supervisor', () => {
  it('reports fleet_down and enqueues nothing', () => {
    const root = tmp();
    const paths = {
      statePath: join(root, 'fleet-state.json'),
      commandPath: join(root, 'cmds.json'),
    };
    const outcome = submitFleetMemberCommand('start-member', 'wecom-aaaaaaaaaaaa', {
      idFactory: () => 'id-1',
      nowIso: () => 'T',
      paths,
    });
    expect(outcome).toMatchObject({ ok: false, reason: 'fleet_down', name: 'wecom-aaaaaaaaaaaa' });
    expect(readFleetCommands(paths.commandPath)).toEqual([]);
    expect(signalFleetReconcile(paths.statePath)).toBe(false);
  });

  it('takes its command back out of the queue when the supervisor cannot be signalled after all', () => {
    const root = tmp();
    const paths = { statePath: join(root, 'fleet-state.json'), commandPath: join(root, 'cmds.json') };
    writeFleetState(paths.statePath, {
      supervisorPid: 4242, supervisorStartedAt: 'T', supervisorProcessStart: 'S', supervisorCommand: 'sup', procs: [],
    });
    // The supervisor verifies while the command is enqueued, then its pid is
    // somebody else's by the time the signal would go out: no signal is sent.
    let identityReads = 0;
    const runtime: FleetProcessIdentityRuntime = {
      readIdentity: () => (++identityReads <= 2 ? 'S' : 'someone-else'),
      readCommandLine: () => 'sup',
      readPidNamespace: () => undefined,
      pidExists: () => true,
    };
    const outcome = submitFleetMemberCommand('stop-member', 'wecom-aaaaaaaaaaaa', {
      idFactory: () => 'id-1',
      nowIso: () => 'T',
      paths,
      identityRuntime: runtime,
    });
    expect(outcome).toMatchObject({ ok: false, reason: 'fleet_down' });
    expect(identityReads).toBeGreaterThan(2);
    expect(readFleetCommands(paths.commandPath)).toEqual([]);
  });
});

describe('is the supervisor a command was handed to still the one running?', () => {
  it('only while the same generation (pid, birth identity, command line) is there', () => {
    let birth = 'S';
    const runtime: FleetProcessIdentityRuntime = {
      readIdentity: () => birth,
      readCommandLine: () => 'sup',
      readPidNamespace: () => undefined,
      pidExists: () => true,
    };
    const handedTo = { pid: 4242, processStart: 'S', commandLine: 'sup' };
    expect(fleetSupervisorStillRunning(handedTo, runtime)).toBe(true);
    // A fleet restart put another supervisor on the same pid.
    birth = 'S2';
    expect(fleetSupervisorStillRunning(handedTo, runtime)).toBe(false);
  });
});
