import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HcClient, type HcChannelClose, type HcStream, type HcSubscription } from '../src/adapters/backend/hc/client.js';
import type { HcEvent, HcTerminalRecord } from '../src/adapters/backend/hc/types.js';
import { STREAM_WINDOW } from '../src/adapters/backend/hc/wire.js';

const MIN_VERSION = [0, 1, 19];

/** Through the fence shim only: it refuses to run without the private env. */
function hc(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.env.BOTMUX_HC_BIN!, args, { encoding: 'utf8', timeout: 30_000 });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function usableHc(): boolean {
  if (!process.env.BOTMUX_HC_TEST_BIN || !process.env.BOTMUX_HC_BIN || process.platform === 'win32') return false;
  const r = hc(['--version']);
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(r.stdout);
  if (r.status !== 0 || !m) return false;
  const version = m.slice(1).map(Number);
  for (let i = 0; i < MIN_VERSION.length; i++) {
    if (version[i] !== MIN_VERSION[i]) return version[i]! > MIN_VERSION[i]!;
  }
  return true;
}

async function until(cond: () => boolean, what: string, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

function within<T>(promise: Promise<T>, what: string, ms = 10_000): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

interface Capture {
  paint: string;
  live: string;
  liveBytes: number;
  painted: Promise<void>;
  closed: Promise<HcChannelClose>;
}

/** Keeps all paint bytes but only the tail of live output, so floods stay cheap. */
function capture(stream: HcStream, keep = 4096): Capture {
  let painted!: () => void;
  const out: Capture = {
    paint: '',
    live: '',
    liveBytes: 0,
    painted: new Promise<void>(resolve => { painted = resolve; }),
    closed: new Promise<HcChannelClose>(resolve => stream.onClose(resolve)),
  };
  stream.onData((chunk, info) => {
    if (info.paint) {
      out.paint += chunk.toString('latin1');
      if (info.firstPaint && info.paintDone) painted();
      return;
    }
    out.liveBytes += chunk.length;
    out.live = (out.live + chunk.toString('latin1')).slice(-keep);
  });
  return out;
}

function watch(sub: HcSubscription): HcEvent[] {
  const events: HcEvent[] = [];
  sub.onEvent(event => events.push(event));
  return events;
}

describe.skipIf(!usableHc())('HcClient against a private herdr-core', () => {
  const labels = { botmux_test: 'hc-client-real' };
  let cwd: string;
  let socketPath: string;
  let started = false;
  let client: HcClient;

  function run(name: string, script: string, size = { cols: 100, rows: 30 }): Promise<HcTerminalRecord> {
    return client.call<HcTerminalRecord>('terminal.run', {
      argv: ['sh', '-c', script], name, cwd, size, labels, no_parent: true, no_notify: true,
    });
  }

  beforeAll(async () => {
    const runtime = process.env.XDG_RUNTIME_DIR;
    const session = process.env.HC_SESSION;
    if (!runtime || !session || runtime.startsWith('/run/user/')) {
      throw new Error(`refusing to start hc outside the test fence (XDG_RUNTIME_DIR=${runtime}, HC_SESSION=${session})`);
    }
    socketPath = join(runtime, 'herdr-core', `${session}.sock`);
    cwd = mkdtempSync('/tmp/hcc-real-');
    const start = hc(['server', 'start']);
    started = true;
    if (start.status !== 0) throw new Error(`hc server start failed: ${start.stderr || start.stdout}`);
    client = await HcClient.connect(socketPath);
  }, 60_000);

  afterAll(() => {
    client?.close();
    if (started) {
      const stop = hc(['server', 'stop']);
      expect(stop.status).toBe(0);
    }
    if (cwd) rmSync(cwd, { recursive: true, force: true });
  }, 60_000);

  it('speaks generation 1 with automatic input', () => {
    expect(client.hello.generation).toBe(1);
    expect(client.hasFeature('attach')).toBe(true);
    expect(client.hasFeature('automatic_input')).toBe(true);
  });

  it('paints, takes automatic input from a viewer that does not lead the size, and reports exit 7 twice', async () => {
    const record = await run('exit7', 'printf ready; read x; echo got:$x; exit 7');
    expect(record).toMatchObject({ state: 'live', cols: 100, rows: 30, labels });
    const sub = await client.subscribe({ terminal: 'exit7' });
    const events = watch(sub);
    const stream = await client.attach({ terminal: 'exit7', cols: 100, rows: 30 });
    const out = capture(stream);
    await within(out.painted, 'the first paint');
    expect(out.paint.startsWith('\x18')).toBe(true);
    await until(() => (out.paint + out.live).includes('ready'), 'the ready prompt');

    const other = await HcClient.connect(socketPath);
    try {
      const leader = await other.attach({ terminal: 'exit7', cols: 90, rows: 20 });
      leader.onData(() => {});
      await until(() => events.some(e => e.type === 'size' && e.data?.cols === 90 && e.data?.rows === 20), 'the new size leader');

      expect(stream.writeAutomatic('hello\r')).toBe(true);
      const close = await within(out.closed, 'the exit');
      expect(close).toMatchObject({ kind: 'ended', end: { reason: 'exited', exit_code: 7, signal: null } });
      expect(out.live).toContain('got:hello');
      await until(() => events.some(e => e.type === 'finished'), 'the finished event');
      expect(events.find(e => e.type === 'finished')!.data).toMatchObject({ reason: 'exited', exit_code: 7, signal: null });
    } finally {
      other.close();
      sub.close();
    }
  }, 30_000);

  it('keeps a stream flowing through more than a mebibyte of output', async () => {
    await run('flood', 'read go; yes 0123456789abcdefghijklmnopqrstuvwxyz | head -n 40000; printf FLOOD-END; exit 3');
    const stream = await client.attach({ terminal: 'flood', cols: 100, rows: 30 });
    const out = capture(stream);
    await within(out.painted, 'the first paint');
    stream.writeAutomatic('\r');
    const close = await within(out.closed, 'the end of the flood', 20_000);
    expect(close).toMatchObject({ kind: 'ended', end: { reason: 'exited', exit_code: 3 } });
    expect(out.liveBytes).toBeGreaterThan(1 << 20);
    expect(out.liveBytes).toBeGreaterThan(4 * STREAM_WINDOW);
    expect(out.live).toContain('FLOOD-END');
  }, 30_000);

  it('resizes the terminal from the viewer', async () => {
    await run('resize', 'read x; stty size; exit 0', { cols: 80, rows: 24 });
    const sub = await client.subscribe({ terminal: 'resize' });
    const events = watch(sub);
    const stream = await client.attach({ terminal: 'resize', cols: 80, rows: 24 });
    const out = capture(stream);
    await within(out.painted, 'the first paint');
    try {
      expect(stream.resize(120, 40)).toBe(true);
      await until(() => events.some(e => e.type === 'size' && e.data?.cols === 120 && e.data?.rows === 40), 'the size event');
      const record = await client.call<HcTerminalRecord>('terminal.get', { terminal: 'resize' });
      expect([record.cols, record.rows]).toEqual([120, 40]);
      stream.writeAutomatic('\r');
      await within(out.closed, 'the exit');
      expect(out.live).toContain('40 120');
    } finally {
      sub.close();
    }
  }, 30_000);

  it('detaches without ending the program, repaints on reattach, and reports a kill', async () => {
    await run('detach', 'printf still-here; exec sleep 300');
    const first = await client.attach({ terminal: 'detach', cols: 100, rows: 30 });
    const firstOut = capture(first);
    await within(firstOut.painted, 'the first paint');
    first.close();
    expect(await firstOut.closed).toEqual({ kind: 'detached' });
    expect((await client.call<HcTerminalRecord>('terminal.get', { terminal: 'detach' })).state).toBe('live');

    const again = await client.attach({ terminal: 'detach', cols: 100, rows: 30 });
    const againOut = capture(again);
    await within(againOut.painted, 'the paint on reattach');
    await until(() => (againOut.paint + againOut.live).includes('still-here'), 'the earlier output');
    await client.call('terminal.kill', { terminal: 'detach' });
    const close = await within(againOut.closed, 'the kill');
    expect(close).toMatchObject({ kind: 'ended', end: { reason: 'killed', exit_code: null } });
  }, 30_000);
});
