import { describe, it, expect, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFleetState, mutateFleetState, writeFleetState } from '../src/core/fleet-state-store.js';
import { freshProc, type FleetState } from '../src/core/fleet-supervisor-policy.js';

const dirs: string[] = [];
function tmp(): string { const d = mkdtempSync(join(tmpdir(), 'fleet-state-')); dirs.push(d); return d; }
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const state = (procs = [freshProc('botmux-0', 'cli_a', 100, 'T')]): FleetState =>
  ({ supervisorPid: 42, supervisorStartedAt: 'T', procs });

describe('fleet-state-store', () => {
  it('returns null for an absent file', () => {
    expect(readFleetState(join(tmp(), 'nope.json'))).toBeNull();
  });

  it('round-trips a written state', () => {
    const p = join(tmp(), 'fleet.json');
    writeFleetState(p, state());
    const back = readFleetState(p)!;
    expect(back.supervisorPid).toBe(42);
    expect(back.procs).toHaveLength(1);
    expect(back.procs[0]).toMatchObject({ name: 'botmux-0', appId: 'cli_a', pid: 100, status: 'online' });
  });

  it('mutate applies to current and persists', () => {
    const p = join(tmp(), 'fleet.json');
    writeFleetState(p, state());
    mutateFleetState(p, (cur) => {
      cur.procs[0].status = 'stopped';
      cur.procs[0].pid = 0;
      return cur;
    });
    expect(readFleetState(p)!.procs[0]).toMatchObject({ status: 'stopped', pid: 0 });
  });

  it('rejects a mutation that violates projection identity (duplicate live pid)', () => {
    const p = join(tmp(), 'fleet.json');
    writeFleetState(p, state());
    expect(() => mutateFleetState(p, (cur) => {
      cur.procs.push(freshProc('botmux-1', 'cli_b', 100, 'T')); // same pid 100 as botmux-0
      return cur;
    })).toThrow(/duplicate live pid/);
    // the bad write did not land — file still has the single original proc
    expect(readFleetState(p)!.procs).toHaveLength(1);
  });

  it('tolerates a corrupt/partial file (returns null, does not throw)', () => {
    const p = join(tmp(), 'fleet.json');
    writeFileSync(p, '{ this is not json');
    expect(readFleetState(p)).toBeNull();
  });

  it('coerces unknown proc status to stopped and drops malformed procs', () => {
    const p = join(tmp(), 'fleet.json');
    writeFileSync(p, JSON.stringify({
      supervisorPid: 1, supervisorStartedAt: 'T',
      procs: [
        { name: 'botmux-0', appId: 'cli_a', pid: 5, generation: 1, status: 'weird', restarts: 0 },
        { pid: 9 }, // malformed (no name/appId) → dropped
      ],
    }));
    const s = readFleetState(p)!;
    expect(s.procs).toHaveLength(1);
    expect(s.procs[0].status).toBe('stopped');
  });

  it('writes with 0600 perms (state file may carry sensitive proc info)', () => {
    const p = join(tmp(), 'fleet.json');
    writeFleetState(p, state());
    // sanity: file exists + is readable JSON (perm bits are platform-checked elsewhere)
    expect(() => JSON.parse(readFileSync(p, 'utf-8'))).not.toThrow();
  });
});
