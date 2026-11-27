import { afterEach, describe, expect, it } from 'vitest';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readWecomFleetDesiredState,
  setWecomFleetDesiredState,
  setWecomFleetDesiredStopped,
  updateWecomFleetDesiredState,
  wecomDesiredStateOf,
  wecomFleetDesiredStatePath,
  WecomFleetDesiredStateUnavailableError,
} from '../src/im/wecom/config/fleet-desired-state.js';
import { spawnTsEvalWithRepoImports } from './helpers/ts-runner.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function root(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wecom-desired-'));
  dirs.push(dir);
  return join(dir, 'wecom');
}

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const C = 'c'.repeat(64);
const at = (iso: string) => () => new Date(iso);

function okSnapshot(wecomRoot: string) {
  const snapshot = readWecomFleetDesiredState(wecomRoot);
  if (snapshot.status !== 'ok') throw new Error(`unexpected ${snapshot.status}`);
  return snapshot;
}

describe('WeCom fleet desired state', () => {
  it('tells "never recorded" apart from "stopped"', () => {
    const wecomRoot = root();
    expect(wecomDesiredStateOf(okSnapshot(wecomRoot), A)).toBe('unrecorded'); // no file at all

    setWecomFleetDesiredState(A, 'stopped', { root: wecomRoot, now: at('2026-11-17T00:00:00.000Z') });
    setWecomFleetDesiredState(B, 'running', { root: wecomRoot, now: at('2026-11-17T00:00:01.000Z') });
    const snapshot = okSnapshot(wecomRoot);
    expect(wecomDesiredStateOf(snapshot, A)).toBe('stopped');
    expect(wecomDesiredStateOf(snapshot, B)).toBe('running');
    expect(wecomDesiredStateOf(snapshot, C)).toBe('unrecorded');
    expect(snapshot.connections.get(B)).toEqual({ desired: 'running', updatedAt: '2026-11-17T00:00:01.000Z' });
  });

  it('writes the documented file shape, owner-only', () => {
    const wecomRoot = root();
    setWecomFleetDesiredState(A, 'running', { root: wecomRoot, now: at('2026-11-17T00:00:00.000Z') });
    const path = wecomFleetDesiredStatePath(wecomRoot);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
      version: 1,
      connections: { [A]: { desired: 'running', updatedAt: '2026-11-17T00:00:00.000Z' } },
    });
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('a later write keeps the other connections', () => {
    const wecomRoot = root();
    setWecomFleetDesiredState(A, 'running', { root: wecomRoot });
    setWecomFleetDesiredState(B, 'running', { root: wecomRoot });
    setWecomFleetDesiredState(A, 'stopped', { root: wecomRoot });
    const snapshot = okSnapshot(wecomRoot);
    expect([...snapshot.connections.keys()].sort()).toEqual([A, B]);
    expect(wecomDesiredStateOf(snapshot, A)).toBe('stopped');
    expect(wecomDesiredStateOf(snapshot, B)).toBe('running');
  });

  it.each([
    ['not JSON', '{"version":1,'],
    ['an unknown version', JSON.stringify({ version: 2, connections: {} })],
    ['a non-object connections map', JSON.stringify({ version: 1, connections: [] })],
    ['an invalid desired value', JSON.stringify({ version: 1, connections: { [A]: { desired: 'paused', updatedAt: 'x' } } })],
    ['a key that is not a connection id', JSON.stringify({ version: 1, connections: { nope: { desired: 'running', updatedAt: 'x' } } })],
  ])('reports a file with %s as unavailable, and refuses to overwrite it', (_label, text) => {
    const wecomRoot = root();
    mkdirSync(wecomRoot, { recursive: true });
    const path = wecomFleetDesiredStatePath(wecomRoot);
    writeFileSync(path, text);

    expect(readWecomFleetDesiredState(wecomRoot).status).toBe('unavailable');
    expect(() => setWecomFleetDesiredState(B, 'running', { root: wecomRoot }))
      .toThrow(WecomFleetDesiredStateUnavailableError);
    expect(readFileSync(path, 'utf8')).toBe(text);
  });

  it('rejects an invalid connection id without writing', () => {
    const wecomRoot = root();
    setWecomFleetDesiredState(A, 'running', { root: wecomRoot });
    const before = readFileSync(wecomFleetDesiredStatePath(wecomRoot), 'utf8');
    expect(() => setWecomFleetDesiredState('../x', 'running', { root: wecomRoot })).toThrow('wecom_fleet_desired_invalid_connection_id');
    expect(() => updateWecomFleetDesiredState(map => { map.set('short', { desired: 'running', updatedAt: 'x' }); }, { root: wecomRoot }))
      .toThrow('wecom_fleet_desired_invalid_connection_id');
    expect(readFileSync(wecomFleetDesiredStatePath(wecomRoot), 'utf8')).toBe(before);
  });

  it('a batch update is one write: either every change lands or none does', () => {
    const wecomRoot = root();
    setWecomFleetDesiredState(A, 'running', { root: wecomRoot });
    const before = readFileSync(wecomFleetDesiredStatePath(wecomRoot), 'utf8');
    expect(() => updateWecomFleetDesiredState(map => {
      map.set(B, { desired: 'stopped', updatedAt: 'x' });
      throw new Error('migration step failed');
    }, { root: wecomRoot })).toThrow('migration step failed');
    expect(readFileSync(wecomFleetDesiredStatePath(wecomRoot), 'utf8')).toBe(before);

    updateWecomFleetDesiredState(map => {
      map.set(B, { desired: 'stopped', updatedAt: 'x' });
      map.set(C, { desired: 'running', updatedAt: 'x' });
    }, { root: wecomRoot });
    const snapshot = okSnapshot(wecomRoot);
    expect(wecomDesiredStateOf(snapshot, B)).toBe('stopped');
    expect(wecomDesiredStateOf(snapshot, C)).toBe('running');
  });
});

describe('WeCom fleet desired state: a gateway\'s stop reason', () => {
  const fileOf = (wecomRoot: string) => JSON.parse(readFileSync(wecomFleetDesiredStatePath(wecomRoot), 'utf8'));

  it('round-trips a stop recorded by the gateway with its reason', () => {
    const wecomRoot = root();
    setWecomFleetDesiredStopped(A, 'replaced', { root: wecomRoot, now: at('2026-11-17T00:00:00.000Z') });

    expect(okSnapshot(wecomRoot).connections.get(A)).toStrictEqual({
      desired: 'stopped',
      updatedAt: '2026-11-17T00:00:00.000Z',
      reason: 'replaced',
    });
    expect(fileOf(wecomRoot).connections[A]).toStrictEqual({
      desired: 'stopped',
      updatedAt: '2026-11-17T00:00:00.000Z',
      reason: 'replaced',
    });
  });

  it('reads a reason it does not know, or one on a running record, as no reason — and the file stays usable', () => {
    const wecomRoot = root();
    mkdirSync(wecomRoot, { recursive: true });
    writeFileSync(wecomFleetDesiredStatePath(wecomRoot), JSON.stringify({
      version: 1,
      connections: {
        [A]: { desired: 'stopped', updatedAt: 'x', reason: 'reason_from_a_newer_version' },
        [B]: { desired: 'running', updatedAt: 'x', reason: 'replaced' },
        [C]: { desired: 'stopped', updatedAt: 'x', reason: 42 },
      },
    }));

    const snapshot = okSnapshot(wecomRoot);
    expect(snapshot.connections.get(A)).toStrictEqual({ desired: 'stopped', updatedAt: 'x' });
    expect(snapshot.connections.get(B)).toStrictEqual({ desired: 'running', updatedAt: 'x' });
    expect(snapshot.connections.get(C)).toStrictEqual({ desired: 'stopped', updatedAt: 'x' });
  });

  it('starting the connection clears the reason', () => {
    const wecomRoot = root();
    setWecomFleetDesiredStopped(A, 'authentication_failed', { root: wecomRoot });
    setWecomFleetDesiredState(A, 'running', { root: wecomRoot, now: at('2026-11-17T00:00:01.000Z') });
    expect(fileOf(wecomRoot).connections[A]).toStrictEqual({ desired: 'running', updatedAt: '2026-11-17T00:00:01.000Z' });
  });

  it('an operator\'s plain stop clears the reason', () => {
    const wecomRoot = root();
    setWecomFleetDesiredStopped(A, 'instance_busy', { root: wecomRoot });
    setWecomFleetDesiredState(A, 'stopped', { root: wecomRoot, now: at('2026-11-17T00:00:02.000Z') });
    expect(fileOf(wecomRoot).connections[A]).toStrictEqual({ desired: 'stopped', updatedAt: '2026-11-17T00:00:02.000Z' });
  });

  it('writing one connection keeps the other connections\' reasons', () => {
    const wecomRoot = root();
    setWecomFleetDesiredStopped(A, 'replaced', { root: wecomRoot });
    setWecomFleetDesiredStopped(B, 'not_configured', { root: wecomRoot });
    setWecomFleetDesiredState(C, 'running', { root: wecomRoot });
    setWecomFleetDesiredState(A, 'running', { root: wecomRoot });

    const snapshot = okSnapshot(wecomRoot);
    expect(snapshot.connections.get(B)?.reason).toBe('not_configured');
    expect(snapshot.connections.get(A)?.reason).toBeUndefined();
  });

  it('refuses to write a reason outside the list, or on a running record', () => {
    const wecomRoot = root();
    setWecomFleetDesiredState(A, 'running', { root: wecomRoot });
    const before = readFileSync(wecomFleetDesiredStatePath(wecomRoot), 'utf8');

    expect(() => setWecomFleetDesiredStopped(A, 'network_blip' as never, { root: wecomRoot })).toThrow('wecom_fleet_desired_invalid_reason');
    expect(() => updateWecomFleetDesiredState(map => {
      map.set(B, { desired: 'running', updatedAt: 'x', reason: 'replaced' });
    }, { root: wecomRoot })).toThrow('wecom_fleet_desired_invalid_reason');
    expect(readFileSync(wecomFleetDesiredStatePath(wecomRoot), 'utf8')).toBe(before);
  });

  it('a file written before reasons existed reads and rewrites exactly as before', () => {
    const wecomRoot = root();
    mkdirSync(wecomRoot, { recursive: true });
    const legacy = {
      version: 1,
      connections: {
        [A]: { desired: 'running', updatedAt: '2026-11-01T00:00:00.000Z' },
        [B]: { desired: 'stopped', updatedAt: '2026-11-02T00:00:00.000Z' },
      },
    };
    writeFileSync(wecomFleetDesiredStatePath(wecomRoot), JSON.stringify(legacy));

    expect([...okSnapshot(wecomRoot).connections]).toStrictEqual(Object.entries(legacy.connections));
    setWecomFleetDesiredState(C, 'running', { root: wecomRoot, now: at('2026-11-03T00:00:00.000Z') });
    expect(readFileSync(wecomFleetDesiredStatePath(wecomRoot), 'utf8')).toBe(`${JSON.stringify({
      version: 1,
      connections: { ...legacy.connections, [C]: { desired: 'running', updatedAt: '2026-11-03T00:00:00.000Z' } },
    }, null, 2)}\n`);
  });
});

describe('WeCom fleet desired state: a conditional stop', () => {
  it('writes only while the record is still the expected one, and says what it found otherwise', () => {
    const wecomRoot = root();
    setWecomFleetDesiredState(A, 'running', { root: wecomRoot, now: at('2026-11-18T00:00:00.000Z') });
    const seen = okSnapshot(wecomRoot).connections.get(A);
    setWecomFleetDesiredState(A, 'running', { root: wecomRoot, now: at('2026-11-18T00:00:01.000Z') });
    const before = readFileSync(wecomFleetDesiredStatePath(wecomRoot));

    const refused = setWecomFleetDesiredStopped(A, 'replaced', { root: wecomRoot, expected: { record: seen } });

    expect(refused).toEqual({ written: false, current: { desired: 'running', updatedAt: '2026-11-18T00:00:01.000Z' } });
    expect(readFileSync(wecomFleetDesiredStatePath(wecomRoot))).toEqual(before);
    const current = okSnapshot(wecomRoot).connections.get(A);
    const written = setWecomFleetDesiredStopped(A, 'replaced', { root: wecomRoot, expected: { record: current } });
    expect(written).toMatchObject({ written: true, record: { desired: 'stopped', reason: 'replaced' } });
    expect(okSnapshot(wecomRoot).connections.get(A)).toMatchObject({ desired: 'stopped', reason: 'replaced' });
    // "No record" is a record too: expected absent, found absent.
    expect(setWecomFleetDesiredStopped(B, 'instance_busy', { root: wecomRoot, expected: { record: undefined } }).written).toBe(true);
  });

  it('stamps a write when it lands, not when it started waiting for the lock', async () => {
    const wecomRoot = root();
    mkdirSync(wecomRoot, { recursive: true });
    const marker = join(wecomRoot, '..', 'holding');
    const moduleUrl = new URL('../src/im/wecom/config/fleet-desired-state.js', import.meta.url).href;
    // Another process records `running` while holding the file's lock for 1.5 s.
    const holder = spawnTsEvalWithRepoImports(`
      const m = await import(${JSON.stringify(moduleUrl)});
      const { writeFileSync } = await import('node:fs');
      m.updateWecomFleetDesiredState(map => {
        writeFileSync(${JSON.stringify(marker)}, '');
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500);
        map.set(${JSON.stringify(A)}, { desired: 'running', updatedAt: new Date().toISOString() });
      }, { root: ${JSON.stringify(wecomRoot)} });
    `, { stdio: 'ignore' });
    const deadline = Date.now() + 15_000;
    while (!existsSync(marker) && Date.now() < deadline) {
      await new Promise(done => setTimeout(done, 20));
    }

    const began = Date.now();
    setWecomFleetDesiredStopped(A, 'replaced', { root: wecomRoot });
    await once(holder, 'exit');

    // It waited out the holder (about 1.5 s) and replaced the holder's record: its
    // time is when it landed, never earlier than the record it replaced.
    const record = okSnapshot(wecomRoot).connections.get(A);
    expect(record).toMatchObject({ desired: 'stopped', reason: 'replaced' });
    expect(Date.parse(record!.updatedAt) - began).toBeGreaterThanOrEqual(1_000);
  }, 30_000);
});
