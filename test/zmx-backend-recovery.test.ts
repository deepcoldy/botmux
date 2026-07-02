import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fakePtys = vi.hoisted(() => [] as FakePty[]);

class FakePty {
  readonly writes: string[] = [];
  spawnArgs: string[] = [];
  killed = false;
  private dataCb: ((data: string) => void) | undefined;
  private exitCb: ((event: { exitCode: number; signal?: number }) => void) | undefined;

  write(data: string): void { this.writes.push(data); }
  resize(): void {}
  kill(): void { this.killed = true; }
  onData(cb: (data: string) => void): void { this.dataCb = cb; }
  onExit(cb: (event: { exitCode: number; signal?: number }) => void): void { this.exitCb = cb; }
  emitData(data: string): void { this.dataCb?.(data); }
  emitExit(exitCode: number, signal?: number): void { this.exitCb?.({ exitCode, signal }); }
}

vi.mock('node-pty', () => ({
  spawn: vi.fn((_file: string, args: string[]) => {
    const child = new FakePty();
    child.spawnArgs = args;
    fakePtys.push(child);
    return child;
  }),
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFileSync: vi.fn() };
});

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { ZmxBackend } from '../src/adapters/backend/zmx-backend.js';

const execFileSyncMock = vi.mocked(execFileSync);

function spawnBackend(): { backend: ZmxBackend; child: FakePty } {
  execFileSyncMock.mockReturnValueOnce('' as never); // --short: no pre-existing session
  execFileSyncMock.mockReturnValueOnce('' as never); // full list
  const backend = new ZmxBackend('bmx-test0001');
  backend.spawn('/bin/sh', ['-c', 'echo ready'], {
    cwd: '/tmp',
    cols: 80,
    rows: 24,
    env: { PATH: '/bin' },
  });
  return { backend, child: fakePtys.at(-1)! };
}

function launchMarkers(child: FakePty): { ready: string; completion: string; release: string } {
  const bootstrapPath = child.spawnArgs.at(-1);
  if (!bootstrapPath) throw new Error('missing ZMX bootstrap path');
  const bootstrap = readFileSync(bootstrapPath, 'utf8');
  const nonce = bootstrap.match(/botmux-zmx-ready=([0-9a-f]{32})/)?.[1];
  const release = bootstrap.match(/release_line" = '([0-9a-f]{32})'/)?.[1];
  if (!nonce || !bootstrap.includes(`botmux-zmx-started=${nonce}`)) {
    throw new Error('missing ZMX launch markers');
  }
  if (!release) throw new Error('missing ZMX private release token');
  const ready = `\x1b]5150;botmux-zmx-ready=${nonce}\x1b\\`;
  const completion = `\x1b]5150;botmux-zmx-started=${nonce}\x1b\\`;
  return { ready, completion, release };
}

describe('ZmxBackend recovery transport', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fakePtys.length = 0;
    execFileSyncMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps queued input FIFO and retries an inconclusive flush probe on a quiet attach', () => {
    const { backend, child } = spawnBackend();
    const markers = launchMarkers(child);
    backend.write('A');
    child.emitData(`ready:${markers.ready.slice(0, 19)}`);
    expect(child.writes).toEqual([]);
    child.emitData(`${markers.ready.slice(19)}${markers.completion}\n`);
    backend.write('B');

    // First post-attach probe is inconclusive, then the same silent attach is
    // confirmed live. No second data frame should be required to release input.
    execFileSyncMock.mockReturnValueOnce('' as never);
    execFileSyncMock.mockReturnValueOnce('  name=bmx-test0001\terr=Timeout\n' as never);
    execFileSyncMock.mockReturnValueOnce('bmx-test0001\n' as never);
    execFileSyncMock.mockReturnValueOnce('  name=bmx-test0001\tpid=42\tclients=1\n' as never);
    vi.advanceTimersByTime(150);
    expect(child.writes).toEqual([`${markers.release}\r`]);
    vi.advanceTimersByTime(300);
    expect(child.writes).toEqual([`${markers.release}\r`, 'AB']);
    backend.kill();
    vi.advanceTimersByTime(5 * 60_000);
  });

  it('strips the split fresh-ready marker before output and releases the bootstrap once', () => {
    const { backend, child } = spawnBackend();
    const markers = launchMarkers(child);
    const output: string[] = [];
    backend.onData(data => output.push(data));

    child.emitData(`zmx-prefix${markers.ready.slice(0, 11)}`);
    expect(output).toEqual([]);
    expect(child.writes).toEqual([]);

    child.emitData(`${markers.ready.slice(11)}${markers.completion.slice(0, 13)}`);
    expect(child.writes).toEqual([`${markers.release}\r`]);
    expect(output).toEqual([]);

    child.emitData(`${markers.completion.slice(13)}cli-suffix`);
    expect(output.join('')).toBe('zmx-prefixcli-suffix');
    expect(output.join('')).not.toContain(markers.ready);
    expect(output.join('')).not.toContain(markers.completion);

    child.emitData('later');
    expect(child.writes).toEqual([`${markers.release}\r`]);
    expect(output.join('')).toBe('zmx-prefixcli-suffixlater');
    backend.kill();
    vi.advanceTimersByTime(5 * 60_000);
  });

  it('quarantines until the unverified fresh session disappears, then exits once', () => {
    const { backend, child } = spawnBackend();
    const output: string[] = [];
    const exits: Array<[number | null, string | null]> = [];
    backend.onData(data => output.push(data));
    backend.onExit((code, signal) => exits.push([code, signal]));

    child.emitData('foreign session output');
    expect(child.writes).toEqual([]);
    expect(output).toEqual([]);

    execFileSyncMock.mockReturnValueOnce('' as never);
    execFileSyncMock.mockReturnValueOnce('' as never);
    vi.advanceTimersByTime(5_000);
    expect(exits).toEqual([]);
    expect(child.killed).toBe(true);
    expect(fakePtys).toHaveLength(1);

    vi.advanceTimersByTime(100);
    expect(exits).toEqual([[75, null]]);

    child.emitExit(0, 0);
    vi.advanceTimersByTime(10_000);
    expect(fakePtys).toHaveLength(1);
  });

  it('quarantines a crash-left bootstrap on reattach without forwarding output or input', () => {
    const original = spawnBackend();
    const markers = launchMarkers(original.child);
    original.backend.kill();

    execFileSyncMock.mockReturnValueOnce('bmx-test0001\n' as never);
    execFileSyncMock.mockReturnValueOnce(
      '  name=bmx-test0001\tpid=42\tclients=0\tcmd=/bin/sh /tmp/botmux-zmx-launch-x/bootstrap.sh\n' as never,
    );
    const reattached = new ZmxBackend('bmx-test0001', { isReattach: true });
    const output: string[] = [];
    const exits: Array<[number | null, string | null]> = [];
    reattached.onData(data => output.push(data));
    reattached.onExit((code, signal) => exits.push([code, signal]));
    reattached.spawn('/bin/sh', ['-c', 'echo resumed'], {
      cwd: '/tmp',
      cols: 80,
      rows: 24,
      env: { PATH: '/bin' },
    });
    const child = fakePtys.at(-1)!;

    reattached.write('hello\r');
    child.emitData(`\x1b[2J${markers.ready.slice(0, 17)}`);
    child.emitData(markers.ready.slice(17));
    expect(child.killed).toBe(true);
    expect(child.writes).toEqual([]);
    expect(output).toEqual([]);
    expect(exits).toEqual([]);

    execFileSyncMock.mockReturnValueOnce('' as never);
    execFileSyncMock.mockReturnValueOnce('' as never);
    vi.advanceTimersByTime(100);
    expect(exits).toEqual([[75, null]]);
    expect(fakePtys).toHaveLength(2);
    vi.advanceTimersByTime(5 * 60_000);
  });

  it('never kills an unverified same-name session when quarantine is destroyed', () => {
    const original = spawnBackend();
    const markers = launchMarkers(original.child);
    original.backend.kill();

    execFileSyncMock.mockReturnValueOnce('bmx-test0001\n' as never);
    execFileSyncMock.mockReturnValueOnce(
      '  name=bmx-test0001\tpid=42\tclients=0\tcmd=/bin/sh /tmp/botmux-zmx-launch-x/bootstrap.sh\n' as never,
    );
    const reattached = new ZmxBackend('bmx-test0001', { isReattach: true });
    reattached.spawn('/bin/sh', ['-c', 'echo resumed'], {
      cwd: '/tmp',
      cols: 80,
      rows: 24,
      env: { PATH: '/bin' },
    });
    const child = fakePtys.at(-1)!;
    execFileSyncMock.mockClear();

    child.emitData(markers.ready);
    expect(child.killed).toBe(true);
    reattached.destroySession();

    expect(execFileSyncMock.mock.calls.some(([, args]) =>
      Array.isArray(args) && args[0] === 'kill',
    )).toBe(false);
    vi.advanceTimersByTime(5 * 60_000);
  });

  it('normalizes node-pty signal 0 to a normal null exit signal', () => {
    const { backend, child } = spawnBackend();
    const markers = launchMarkers(child);
    child.emitData(markers.ready);
    child.emitData(markers.completion);
    const exits: Array<[number | null, string | null]> = [];
    backend.onExit((code, signal) => exits.push([code, signal]));
    execFileSyncMock.mockReturnValueOnce('' as never); // --short: target is truly gone
    execFileSyncMock.mockReturnValueOnce('' as never); // full list

    child.emitExit(0, 0);
    vi.advanceTimersByTime(50);
    expect(exits).toEqual([[0, null]]);
    vi.advanceTimersByTime(5 * 60_000);
  });
});
