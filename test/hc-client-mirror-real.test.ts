/**
 * The attach stream of HcClient feeding a ScreenMirror, as HcBackend wires
 * them: paint segments through writePaint, live bytes through write.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HcClient, type HcStream, type HcSubscription } from '../src/adapters/backend/hc/client.js';
import { ScreenMirror } from '../src/adapters/backend/hc/screen-mirror.js';
import type { HcEvent } from '../src/adapters/backend/hc/types.js';

/** Through the fence shim only: it refuses to run without the private env. */
function hc(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.env.BOTMUX_HC_BIN!, args, { encoding: 'utf8', timeout: 30_000 });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

const usableHc = process.platform === 'linux'
  && !!process.env.BOTMUX_HC_TEST_BIN
  && !!process.env.BOTMUX_HC_BIN
  && hc(['--version']).status === 0;

async function until(cond: () => boolean, what: string, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

interface Mirrored {
  mirror: ScreenMirror;
  painted: () => boolean;
  /** Paint segments that arrived after the stream's first paint. */
  laterPaints: () => number;
  live: () => string;
}

function mirrorStream(stream: HcStream, cols: number, rows: number): Mirrored {
  const mirror = new ScreenMirror({ cols, rows, scrollback: 1000 });
  let painted = false;
  let laterPaints = 0;
  let live = '';
  stream.onData((chunk, info) => {
    if (info.paint) {
      mirror.writePaint(chunk);
      if (info.firstPaint && info.paintDone) painted = true;
      if (!info.firstPaint) laterPaints++;
      return;
    }
    mirror.write(chunk);
    live += chunk.toString('utf8');
  });
  return { mirror, painted: () => painted, laterPaints: () => laterPaints, live: () => live };
}

function plain(ansi: string): string {
  return ansi.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
}

/**
 * Non-blank rows of history plus screen. hc's history paint pushes one blank
 * row past the replayed history (a CRLF and then `rows` LFs), so blank rows
 * differ between a mirror seeded later and one fed all along.
 */
function contentRows(mirror: ScreenMirror): string[] {
  return plain(mirror.captureCurrentScreen()).split('\r\n').filter(row => row !== '');
}

function watch(sub: HcSubscription): HcEvent[] {
  const events: HcEvent[] = [];
  sub.onEvent(event => events.push(event));
  return events;
}

describe.skipIf(!usableHc)('HcClient attach stream into ScreenMirror against a private herdr-core', () => {
  let cwd: string;
  let socketPath: string;
  let started = false;
  let client: HcClient;

  beforeAll(async () => {
    const runtime = process.env.XDG_RUNTIME_DIR;
    const session = process.env.HC_SESSION;
    if (!runtime || !session || runtime.startsWith('/run/user/')) {
      throw new Error(`refusing to start hc outside the test fence (XDG_RUNTIME_DIR=${runtime}, HC_SESSION=${session})`);
    }
    socketPath = join(runtime, 'herdr-core', `${session}.sock`);
    cwd = mkdtempSync('/tmp/hcm-real-');
    const start = hc(['server', 'start']);
    started = true;
    if (start.status !== 0) throw new Error(`hc server start failed: ${start.stderr || start.stdout}`);
    client = await HcClient.connect(socketPath);
  }, 60_000);

  afterAll(() => {
    client?.close();
    if (started) expect(hc(['server', 'stop']).status).toBe(0);
    if (cwd) rmSync(cwd, { recursive: true, force: true });
  }, 60_000);

  it('restores scrollback once from a history paint, and a reattach rebuilds the same screen', async () => {
    const lines = Array.from({ length: 120 }, (_, i) => `line-${i + 1}`);
    await client.call('terminal.run', {
      argv: ['sh', '-c', `for l in ${lines.join(' ')}; do echo $l; done; printf ready; read x; echo after-$x; exec sleep 300`],
      name: 'history', cwd, size: { cols: 100, rows: 30 }, no_parent: true, no_notify: true,
    });
    await until(() => {
      const r = hc(['--json', 'read', 'history']);
      return r.status === 0 && r.stdout.includes('ready');
    }, 'the program to print');

    const first = await client.attach({ terminal: 'history', cols: 100, rows: 30, history: 1000 });
    const a = mirrorStream(first, 100, 30);
    await until(a.painted, 'the first paint');

    expect(contentRows(a.mirror).filter(row => /^line-\d+$/.test(row))).toEqual(lines);
    expect(a.mirror.viewportText()).toContain('ready');

    expect(first.writeAutomatic('x\r')).toBe(true);
    await until(() => a.mirror.viewportText().includes('after-x'), 'the echoed input in the mirror');

    first.close();
    const again = await client.attach({ terminal: 'history', cols: 100, rows: 30, history: 1000 });
    const b = mirrorStream(again, 100, 30);
    await until(b.painted, 'the paint on reattach');
    expect(contentRows(b.mirror)).toEqual(contentRows(a.mirror));
    expect(b.mirror.captureViewport()).toBe(a.mirror.captureViewport());
    expect(b.mirror.captureInputState()).toEqual(a.mirror.captureInputState());

    again.close();
    a.mirror.dispose();
    b.mirror.dispose();
    await client.call('terminal.kill', { terminal: 'history' });
  }, 30_000);

  it('sends a typing viewer no repaint on resize: the mirror follows the size event and the program\'s redraw', async () => {
    await client.call('terminal.run', {
      argv: ['sh', '-c', 'trap "stty size" WINCH; printf ready; while :; do sleep 0.05; done'],
      name: 'winch', cwd, size: { cols: 100, rows: 30 }, no_parent: true, no_notify: true,
    });
    const sub = await client.subscribe({ terminal: 'winch' });
    const events = watch(sub);
    const stream = await client.attach({ terminal: 'winch', cols: 100, rows: 30 });
    const a = mirrorStream(stream, 100, 30);
    await until(a.painted, 'the first paint');
    await until(() => a.mirror.viewportText().includes('ready'), 'the ready prompt');

    const other = await HcClient.connect(socketPath);
    try {
      const leader = await other.attach({ terminal: 'winch', cols: 90, rows: 20 });
      leader.onData(() => {});
      await until(() => events.some(e => e.type === 'size' && e.data?.cols === 90 && e.data?.rows === 20), 'the size event');
      a.mirror.resize(90, 20);
      await until(() => a.live().includes('20 90'), 'the program\'s redraw at the new size');
      leader.close();

      expect(stream.resize(110, 35)).toBe(true);
      a.mirror.resize(110, 35);
      await until(() => a.live().includes('35 110'), 'the redraw at the viewer\'s own size');
      expect(a.laterPaints()).toBe(0);
      expect(a.mirror.size()).toEqual({ cols: 110, rows: 35 });
    } finally {
      other.close();
      sub.close();
      stream.close();
      a.mirror.dispose();
      await client.call('terminal.kill', { terminal: 'winch' });
    }
  }, 30_000);
});
