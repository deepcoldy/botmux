import './helpers/require-fenced-data-dir.js';
import { mkdtempSync, mkdirSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { captureDshProcessIdentity } from '../src/services/dsh-process-attestation.js';
import { resolveDaemonCurrentExecution } from '../src/core/current-execution.js';

vi.mock('node:fs', async original => {
  const actual = await original<typeof import('node:fs')>();
  return { ...actual, readFileSync: vi.fn(actual.readFileSync), statSync: vi.fn(actual.statSync) };
});
const roots: string[] = [];
const originalReadFile = vi.mocked(readFileSync).getMockImplementation()!;
afterEach(() => {
  vi.mocked(readFileSync).mockImplementation(originalReadFile);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function proc(root: string, pid: number, parent: number, exe: string, args: string[], started = String(pid * 10)) {
  const dir = join(root, String(pid));
  mkdirSync(join(dir, 'fd'), { recursive: true });
  writeFileSync(join(dir, 'stat'), `${pid} (MainThread) ${['S', parent, ...Array(17).fill('0'), started].join(' ')}\n`);
  symlinkSync(exe, join(dir, 'exe'));
  writeFileSync(join(dir, 'cmdline'), args.join('\0') + '\0');
  symlinkSync('socket:[1001]', join(dir, 'fd', '0'));
  symlinkSync('socket:[1002]', join(dir, 'fd', '1'));
}

function fixture(source = false) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-attestation-')); roots.push(root);
  const executable = source ? '/bin/node' : '/bin/botmux';
  const args = [source ? '/repo/dist/dsh-runner.js' : '__dsh-runner', '--session-id', 's1', '--dsh-bin', '/npm/dsh.js', '--dsh-profile', 'botmux'];
  proc(root, 40, 1, '/bin/sh', ['sh']);
  proc(root, 50, 40, executable, [executable, ...args]);
  proc(root, 60, 50, '/bin/node', ['node', '/npm/dsh.js', '--profile', 'botmux']);
  const proofPath = '/tmp/botmux-dsh-attestation-test/proof (deleted)';
  symlinkSync(proofPath, join(root, '50/fd/9'));
  symlinkSync(proofPath, join(root, '60/fd/3'));
  vi.mocked(statSync).mockImplementation(((path: string) => {
    const target = readlinkSync(String(path));
    return { isFile: () => true, nlink: 0, mode: 0o100600, dev: 1, ino: target === proofPath ? 123 : 456 };
  }) as any);
  const capture = () => captureDshProcessIdentity(40, executable, args, root);
  const identity = { runnerPid: 50, runnerProcStart: '500', enginePid: 60, engineProcStart: '600' };
  return { root, args, executable, identity, capture };
}

describe('kernel-verified DSH process identity', () => {
  it.each([false, true])('proves a single RPC engine under the exact runner (source=%s)', source => {
    const { capture, identity } = fixture(source);
    expect(capture()).toEqual(identity);
  });

  it.each([
    { name: 'nodejs', exe: '/usr/bin/nodejs', engineArgs: ['node', '/npm/dsh.js', '--profile', 'botmux'] },
    { name: 'a replaced Node image', exe: '/usr/bin/node (deleted)', engineArgs: ['node', '/npm/dsh.js', '--profile', 'botmux'] },
    { name: 'a replaced native DSH image', exe: '/npm/dsh.js (deleted)', engineArgs: ['/npm/dsh.js', '--profile', 'botmux'] },
  ])('accepts $name with the same live engine identity', ({ exe, engineArgs }) => {
    const { root, capture, identity } = fixture();
    unlinkSync(join(root, '60/exe'));
    symlinkSync(exe, join(root, '60/exe'));
    writeFileSync(join(root, '60/cmdline'), engineArgs.join('\0') + '\0');
    expect(capture()).toEqual(identity);
  });

  it('ignores configuration discovery and model-created descendants', () => {
    const { root, capture, identity } = fixture();
    proc(root, 61, 50, '/bin/node', ['node', '/npm/dsh.js', '--profile', 'botmux', '--dump-config']);
    proc(root, 62, 60, '/bin/node', ['node', '/npm/dsh.js', '--profile', 'botmux']);
    symlinkSync('/tmp/botmux-dsh-attestation-test/proof (deleted)', join(root, '62/fd/3'));
    expect(capture()).toEqual(identity);
  });

  it('reattaches an existing engine after display, model or watchdog configuration changes', () => {
    const { root, args, executable, identity } = fixture();
    const newArgs = [...args, '--turn-timeout-ms', '30000', '--bot-name', 'Updated', '--model', 'next-model'];
    writeFileSync(join(root, '50/cmdline'), [executable, ...args, '--turn-timeout-ms', '15000', '--bot-name', 'Original', '--model', 'old-model'].join('\0') + '\0');
    expect(captureDshProcessIdentity(40, executable, newArgs, root)).toEqual(identity);
  });

  it.each(['--session-id', '--dsh-bin', '--dsh-profile', '--bridge-patch'])('rejects a changed or duplicated security contract: %s', flag => {
    const { root, args, executable } = fixture();
    expect(captureDshProcessIdentity(40, executable, [...args, flag, 'different'], root)).toBeUndefined();
    const changed = [...args];
    const index = changed.indexOf(flag);
    if (index >= 0) changed[index + 1] = 'different';
    else changed.push(flag, 'different');
    expect(captureDshProcessIdentity(40, executable, changed, root)).toBeUndefined();
  });

  it('rejects an engine reparented out of the backend during enumeration', () => {
    const { root, capture } = fixture();
    const path = join(root, '50/stat');
    let calls = 0;
    vi.mocked(readFileSync).mockImplementation(((p: string, encoding: string) => {
      const value = originalReadFile(p as any, encoding as any) as string;
      if (String(p) === path && ++calls > 2) return value.replace(' S 40 ', ' S 1 ');
      return value;
    }) as any);
    expect(capture()).toBeUndefined();
  });

  it.each(['session', 'exe', 'parent', 'fd', 'wrong-fd', 'argv', 'zombie', 'stdio'])('rejects an invalid %s proof', reason => {
    const { root, capture } = fixture();
    if (reason === 'session') writeFileSync(join(root, '50/cmdline'), ['botmux', '__dsh-runner', '--session-id', 's2'].join('\0') + '\0');
    if (reason === 'exe') { unlinkSync(join(root, '50/exe')); symlinkSync('/bin/fake', join(root, '50/exe')); }
    if (reason === 'parent') writeFileSync(join(root, '60/stat'), readFileSync(join(root, '60/stat'), 'utf8').replace(' S 50 ', ' S 40 '));
    if (reason === 'fd') unlinkSync(join(root, '60/fd/3'));
    if (reason === 'wrong-fd') { unlinkSync(join(root, '60/fd/3')); symlinkSync('/tmp/botmux-dsh-attestation-other/proof (deleted)', join(root, '60/fd/3')); }
    if (reason === 'argv') writeFileSync(join(root, '60/cmdline'), 'node\0/npm/dsh.js\0--profile\0other\0');
    if (reason === 'zombie') writeFileSync(join(root, '60/stat'), readFileSync(join(root, '60/stat'), 'utf8').replace(') S ', ') Z '));
    if (reason === 'stdio') { unlinkSync(join(root, '60/fd/0')); symlinkSync('/tmp/stdin', join(root, '60/fd/0')); }
    expect(capture()).toBeUndefined();
  });

  it.each(['runner', 'engine'])('rejects ambiguous %s identities', reason => {
    const { root, args, executable, capture } = fixture();
    if (reason === 'runner') proc(root, 51, 40, executable, [executable, ...args]);
    else {
      proc(root, 61, 50, '/bin/node', ['node', '/npm/dsh.js', '--profile', 'botmux']);
      symlinkSync('/tmp/botmux-dsh-attestation-test/proof (deleted)', join(root, '61/fd/3'));
    }
    expect(capture()).toBeUndefined();
  });

  it.each([40, 50, 60])('rejects PID %s reuse during capture', pid => {
    const { root, capture } = fixture();
    const path = join(root, String(pid), 'stat');
    const original = vi.mocked(readFileSync).getMockImplementation()!;
    let calls = 0;
    vi.mocked(readFileSync).mockImplementation(((p: string, encoding: string) => {
      const value = original(p as any, encoding as any) as string;
      if (String(p) === path && ++calls > 2) return value.replace(/\d+\n$/, '9999\n');
      return value;
    }) as any);
    expect(capture()).toBeUndefined();
  });

  it('allows fresh DSH tools across turns while rejecting pre-existing tools and stale engine roots', () => {
    const { root, identity, capture } = fixture();
    expect(capture()).toEqual(identity);
    proc(root, 90, 1, '/bin/botmux', ['botmux', '__worker']);
    proc(root, 100, 60, '/bin/sh', ['sh', '-c', 'botmux smp-workspace:resolve']);
    const ds: any = {
      session: { sessionId: 's1', status: 'active' }, worker: { pid: 90, killed: false, connected: true },
      chatId: 'oc_chat', larkAppId: 'cli_app', workerGeneration: 7, initConfig: { apiOnly: false },
      localProcessAttestation: { cliPid: 50, cliProcStart: '500', enginePid: 60, engineProcStart: '600', workerGeneration: 7 },
      managedTurnOrigin: { capability: 'ca'.repeat(32), turnId: 'turn2', preexistingProcessIdentities: ['40:400', '50:500', '60:600'] },
    };
    const request = () => resolveDaemonCurrentExecution({ sessionId: 's1', peer: { pid: 100, procStart: '1000' }, findSession: () => ds, procRoot: root });
    delete ds.localProcessAttestation.enginePid;
    delete ds.localProcessAttestation.engineProcStart;
    expect(request()).toBeNull(); // The reported DSH MainThread failure.
    Object.assign(ds.localProcessAttestation, { enginePid: 60, engineProcStart: '600' });
    expect(request()).toMatchObject({ status: 'verified', chatId: 'oc_chat', turnId: 'turn2' });
    ds.managedTurnOrigin.preexistingProcessIdentities.push('100:1000');
    ds.managedTurnOrigin.turnId = 'turn3';
    expect(request()).toBeNull();
    proc(root, 101, 60, '/bin/sh', ['sh', '-c', 'next tool']);
    expect(resolveDaemonCurrentExecution({ sessionId: 's1', peer: { pid: 101, procStart: '1010' }, findSession: () => ds, procRoot: root })).toMatchObject({ status: 'verified', turnId: 'turn3' });
    ds.localProcessAttestation.engineProcStart = 'old';
    expect(resolveDaemonCurrentExecution({ sessionId: 's1', peer: { pid: 101, procStart: '1010' }, findSession: () => ds, procRoot: root })).toBeNull();
  });
});
