/**
 * HcBackend against a fake hc: the synchronous CLI calls and the framed client
 * are stand-ins, the ScreenMirror, key encoding, labels and pane launch file
 * are real.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HcClient, HcError, type HcChannelClose, type HcChunkInfo } from '../src/adapters/backend/hc/client.js';
import { killHcTerminal } from '../src/adapters/backend/hc/cli-ops.js';
import { ensureHcCore } from '../src/adapters/backend/hc/core.js';
import { HC_MIRROR_SCROLLBACK_LINES } from '../src/adapters/backend/hc/screen-mirror.js';
import { HC_STARTUP_RETRY_DELAYS_MS, hcCallSync, sleepHcStartupRetry, startHcCoreSync } from '../src/adapters/backend/hc/sync-rpc.js';
import type { HcEnd, HcEvent, HcSnapshot, HcTerminalRecord } from '../src/adapters/backend/hc/types.js';
import { HcBackend } from '../src/adapters/backend/hc-backend.js';
import type { SpawnOpts } from '../src/adapters/backend/types.js';

vi.mock('../src/adapters/backend/hc/sync-rpc.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/adapters/backend/hc/sync-rpc.js')>(),
  prepareHcSyncCore: vi.fn(() => ({ bin: '/fake/hc', env: {}, socket: '/tmp/fake-hc/herdr-core/botmux.sock' })),
  startHcCoreSync: vi.fn(() => ({ version: '0.1.19', pid: 1 })),
  hcCallSync: vi.fn(),
  sleepHcStartupRetry: vi.fn(),
}));
vi.mock('../src/adapters/backend/hc/client.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/adapters/backend/hc/client.js')>(),
  HcClient: { connect: vi.fn() },
}));
vi.mock('../src/adapters/backend/hc/core.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/adapters/backend/hc/core.js')>(),
  ensureHcCore: vi.fn(),
}));
vi.mock('../src/adapters/backend/hc/cli-ops.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/adapters/backend/hc/cli-ops.js')>(),
  killHcTerminal: vi.fn(() => ({ result: 'killed', address: 't1' })),
}));

const SID = '0123abcd-0000-4000-8000-000000000001';
const OTHER_SID = '9999ffff-0000-4000-8000-000000000002';
const TARGET = { backendType: 'hc' as const, sessionName: 'bmx-0123abcd', hcSession: 'botmux', socket: '/tmp/fake-hc/herdr-core/botmux.sock' };
const PAINT_HEAD = '\x18\x1b[!p\x1b[?2026l';
const LIVE: HcChunkInfo = { paint: false, firstPaint: false, paintDone: false };
const FIRST_PAINT_DONE: HcChunkInfo = { paint: true, firstPaint: true, paintDone: true };
const REPAINT_DONE: HcChunkInfo = { paint: true, firstPaint: false, paintDone: true };

const connectMock = vi.mocked(HcClient.connect);
const callSyncMock = vi.mocked(hcCallSync);
const ensureCoreMock = vi.mocked(ensureHcCore);
const killMock = vi.mocked(killHcTerminal);
const retrySleepMock = vi.mocked(sleepHcStartupRetry);

function record(over: Partial<HcTerminalRecord> = {}): HcTerminalRecord {
  return {
    address: 't1', name: TARGET.sessionName, labels: { botmux: '1', botmux_sid: SID }, argv: [], cwd: '/',
    keep: false, state: 'live', pid: 4242, exit_code: null, signal: null, reason: null, created_ms: 0,
    finished_ms: null, screen: 'exact', cols: 100, rows: 30, title: '', parent: null, ...over,
  };
}

class FakeStream {
  readonly written: string[] = [];
  readonly resized: Array<[number, number]> = [];
  closed = false;
  accepts = true;
  private dataCb: ((chunk: Buffer, info: HcChunkInfo) => void) | null = null;
  private closeCb: ((info: HcChannelClose) => void) | null = null;
  onData(cb: (chunk: Buffer, info: HcChunkInfo) => void): () => void { this.dataCb = cb; return () => {}; }
  onClose(cb: (info: HcChannelClose) => void): () => void { this.closeCb = cb; return () => {}; }
  writeAutomatic(bytes: string): boolean {
    if (this.closed || !this.accepts) return false;
    this.written.push(bytes);
    return true;
  }
  resize(cols: number, rows: number): boolean { this.resized.push([cols, rows]); return true; }
  close(): void { this.closed = true; }
  paint(screen: string, trailer = ''): void {
    this.dataCb!(Buffer.from(`${PAINT_HEAD}${screen}\x1b[?9001l${trailer}`), FIRST_PAINT_DONE);
  }
  /** The paint hc sends in place of output it dropped. */
  repaint(screen: string, trailer = ''): void {
    this.dataCb!(Buffer.from(`${PAINT_HEAD}${screen}\x1b[?9001l${trailer}`), REPAINT_DONE);
  }
  /** `bytes` as latin1, so a test can split a UTF-8 sequence. */
  live(bytes: string): void { this.dataCb!(Buffer.from(bytes, 'latin1'), LIVE); }
  end(end: HcEnd): void { this.closeCb!({ kind: 'ended', end }); }
}

class FakeSub {
  closed = false;
  eventCb: ((event: HcEvent) => void) | null = null;
  constructor(readonly snapshot: HcSnapshot) {}
  onEvent(cb: (event: HcEvent) => void): () => void { this.eventCb = cb; return () => {}; }
  onMissed(): () => void { return () => {}; }
  onClose(): () => void { return () => {}; }
  close(): void { this.closed = true; }
  emit(type: string, data: Record<string, unknown> | null): void { this.eventCb!({ type, terminal: 't1', data, seq: 1 }); }
}

class FakeClient {
  readonly version = '0.1.19';
  closed = false;
  readonly calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  attachParams: Record<string, unknown> | null = null;
  subscribeParams: Record<string, unknown> | null = null;
  stream: FakeStream | null = null;
  sub: FakeSub | null = null;
  private disconnectCb: ((info: { error: HcError }) => void) | null = null;
  constructor(public terminal: HcTerminalRecord | null = record()) {}
  hasFeature(name: string): boolean { return name === 'automatic_input'; }
  async call(method: string, params: Record<string, unknown>): Promise<unknown> {
    this.calls.push({ method, params });
    if (method === 'terminal.get') {
      if (!this.terminal) throw new HcError('rpc', 'no such terminal', { kind: 'not_found' });
      return this.terminal;
    }
    return {};
  }
  async subscribe(params: Record<string, unknown>): Promise<FakeSub> {
    this.subscribeParams = params;
    this.sub = new FakeSub({ seq: 0, terminals: this.terminal ? [this.terminal] : [] });
    return this.sub;
  }
  async attach(params: Record<string, unknown>): Promise<FakeStream> {
    this.attachParams = params;
    this.stream = new FakeStream();
    return this.stream;
  }
  onDisconnect(cb: (info: { error: HcError }) => void): () => void { this.disconnectCb = cb; return () => {}; }
  close(): void { this.closed = true; }
  drop(): void { this.disconnectCb!({ error: new HcError('disconnected', 'core went away') }); }
  methods(): string[] { return this.calls.map(c => c.method); }
}

let launchDir: string;
let clients: FakeClient[];
let syncCalls: Array<{ method: string; params: Record<string, unknown> }>;
let syncAnswers: Record<string, () => ReturnType<typeof hcCallSync>>;

const backends: HcBackend[] = [];

function backendFor(opts: ConstructorParameters<typeof HcBackend>[1]): HcBackend {
  const backend = new HcBackend(TARGET, opts);
  backends.push(backend);
  return backend;
}

function queueClient(client = new FakeClient()): FakeClient {
  clients.push(client);
  return client;
}

function spawnOpts(over: Partial<SpawnOpts> = {}): SpawnOpts {
  return { cwd: '/tmp', cols: 100, rows: 30, env: { PATH: '/usr/bin:/bin', HOME: '/root' }, paneLaunchDir: launchDir, ...over };
}

async function attached(client: FakeClient): Promise<FakeStream> {
  await vi.waitFor(() => {
    if (!client.stream) throw new Error('not attached yet');
  });
  return client.stream!;
}

function runParams(): Record<string, unknown> {
  const run = syncCalls.find(c => c.method === 'terminal.run');
  expect(run).toBeDefined();
  return run!.params;
}

beforeEach(() => {
  vi.clearAllMocks();
  launchDir = mkdtempSync(join(tmpdir(), 'hc-backend-test-'));
  clients = [];
  syncCalls = [];
  syncAnswers = {
    'terminal.run': () => ({ ok: true, value: record() }),
    'terminal.get': () => ({ ok: true, value: record() }),
    'terminal.kill': () => ({ ok: true, value: record({ state: 'finished', reason: 'killed', signal: 1 }) }),
    'terminal.rm': () => ({ ok: true, value: {} }),
  };
  callSyncMock.mockImplementation((_core, method, params) => {
    syncCalls.push({ method, params: params as Record<string, unknown> });
    return syncAnswers[method]!();
  });
  connectMock.mockImplementation(async () => {
    const next = clients.shift();
    if (!next) throw new HcError('unreachable', 'no core');
    return next as unknown as HcClient;
  });
  ensureCoreMock.mockRejectedValue(new Error('no core'));
});

afterEach(() => {
  for (const backend of backends.splice(0)) backend.kill();
  vi.useRealTimers();
  rmSync(launchDir, { recursive: true, force: true });
});

describe('spawn', () => {
  it('runs the pane launcher under the owner labels, keeping per-bot env values out of the run request', () => {
    queueClient();
    const backend = backendFor({ sessionId: SID });
    backend.spawn('/usr/bin/claude', ['--resume'], spawnOpts({
      cwd: 'relative/dir',
      env: { PATH: '/usr/bin:/bin', XDG_CONFIG_HOME: '/home/u/.config' },
      injectEnv: { BOT_TOKEN: 'tok-s3cret' },
    }));
    const params = runParams();
    expect(params).toMatchObject({
      name: TARGET.sessionName,
      cwd: join(process.cwd(), 'relative/dir'),
      size: { cols: 100, rows: 30 },
      labels: { botmux: '1', botmux_sid: SID },
      no_parent: true,
      no_notify: true,
    });
    for (const key of ['keep', 'rm', 'caller', 'parent', 'env']) expect(params).not.toHaveProperty(key);
    const argv = params.argv as string[];
    expect(argv.slice(0, 4)).toEqual(['/usr/bin/env', '-u', 'XDG_STATE_HOME', 'XDG_CONFIG_HOME=/home/u/.config']);
    expect(JSON.stringify(params)).not.toContain('tok-s3cret');
    const launchFile = argv.find(arg => arg.startsWith(launchDir))!;
    expect(readFileSync(launchFile, 'utf8')).toContain('tok-s3cret');
    expect(backend.isReattach).toBe(false);
    expect(backend.getChildPid()).toBe(4242);
    backend.kill();
  });

  it('gives a strict pane no XDG restore and no shell rcfile', () => {
    queueClient();
    const backend = backendFor({ sessionId: SID });
    backend.spawn('/usr/bin/claude', [], spawnOpts({ strictEnv: true }));
    expect((runParams().argv as string[])[0]).toBe('/bin/sh');
    backend.kill();
  });

  it('records the codex instance binding as a label and refuses a reattach whose label differs', () => {
    queueClient();
    const env = { PATH: '/usr/bin', BOTMUX_CODEX_INSTANCE_BINDING: 'a'.repeat(64) };
    const fresh = backendFor({ sessionId: SID });
    fresh.spawn('/usr/bin/codex', [], spawnOpts({ env }));
    expect(runParams().labels).toMatchObject({ botmux_codex_instance: 'a'.repeat(64) });
    fresh.kill();

    syncAnswers['terminal.get'] = () => ({ ok: true, value: record({ labels: { botmux: '1', botmux_sid: SID, botmux_codex_instance: 'b'.repeat(64) } }) });
    const reattach = backendFor({ sessionId: SID, isReattach: true });
    expect(() => reattach.spawn('/usr/bin/codex', [], spawnOpts({ env }))).toThrow(/instance identity mismatch/);
  });

  it('refuses an unverified strict reattach before touching hc', () => {
    const backend = backendFor({ sessionId: SID, isReattach: true });
    expect(() => backend.spawn('/usr/bin/claude', [], spawnOpts({ strictEnv: true }))).toThrow(/strict hc reattach/);
    expect(startHcCoreSync).not.toHaveBeenCalled();
    expect(syncCalls).toEqual([]);
  });

  it('reports a taken name and discards the launch file when the run is refused', () => {
    syncAnswers['terminal.run'] = () => ({ ok: false, kind: 'name_taken', message: 'name taken' });
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const backend = backendFor({ sessionId: SID });
    expect(() => backend.spawn('/usr/bin/claude', [], spawnOpts())).toThrow(/已被一个运行中的终端占用/);
    stdout.mockRestore();
    expect(syncCalls.map(c => c.method)).toEqual(['terminal.run']);
    expect(readdirSync(launchDir)).toEqual([]);
    expect(backend.retireSessionCreatedBySpawn()).toBe(false);
  });

  it('adopts the terminal a run without a reply created instead of starting the CLI again', () => {
    queueClient();
    syncAnswers['terminal.run'] = () => ({ ok: false, kind: null, message: 'timed out' });
    syncAnswers['terminal.get'] = () => ({ ok: true, value: record({ labels: runParams().labels as Record<string, string> }) });
    const backend = backendFor({ sessionId: SID });
    backend.spawn('/usr/bin/claude', [], spawnOpts());
    expect(syncCalls.map(c => c.method)).toEqual(['terminal.run', 'terminal.get']);
    expect(syncCalls[1]!.params).toEqual({ terminal: TARGET.sessionName });
    expect(backend.getChildPid()).toBe(4242);
    expect(retrySleepMock).not.toHaveBeenCalled();
    backend.kill();
  });

  it('runs again, under the same run label, while no terminal of the unanswered run exists', () => {
    queueClient();
    const runs: Array<() => ReturnType<typeof hcCallSync>> = [
      () => ({ ok: false, kind: 'unavailable', message: 'core restarting' }),
      () => ({ ok: false, kind: null, message: 'timed out' }),
      () => ({ ok: true, value: record() }),
    ];
    syncAnswers['terminal.run'] = () => runs.shift()!();
    syncAnswers['terminal.get'] = () => ({ ok: false, kind: 'not_found', message: 'not found' });
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const backend = backendFor({ sessionId: SID });
    backend.spawn('/usr/bin/claude', [], spawnOpts());
    stderr.mockRestore();
    const ran = syncCalls.filter(c => c.method === 'terminal.run').map(c => c.params);
    expect(ran).toHaveLength(3);
    expect(ran[1]).toEqual(ran[0]);
    expect(ran[2]).toEqual(ran[0]);
    expect(retrySleepMock.mock.calls).toEqual(HC_STARTUP_RETRY_DELAYS_MS.map(ms => [ms]));
    expect(backend.isPaneAlive()).toBe(true);
    backend.kill();
  });

  it('gives up when the retried run finds the name held by a terminal that is not its own', () => {
    const runs: Array<() => ReturnType<typeof hcCallSync>> = [
      () => ({ ok: false, kind: null, message: 'timed out' }),
      () => ({ ok: false, kind: 'name_taken', message: 'name taken' }),
    ];
    syncAnswers['terminal.run'] = () => runs.shift()!();
    syncAnswers['terminal.get'] = () => ({ ok: true, value: record() });
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const backend = backendFor({ sessionId: SID });
    expect(() => backend.spawn('/usr/bin/claude', [], spawnOpts())).toThrow(/已被一个运行中的终端占用/);
    stdout.mockRestore();
    stderr.mockRestore();
    expect(syncCalls.map(c => c.method)).toEqual(['terminal.run', 'terminal.get', 'terminal.run', 'terminal.get']);
    expect(readdirSync(launchDir)).toEqual([]);
  });
});

describe('reattach spawn', () => {
  it('attaches to the live terminal only when its labels name this session', async () => {
    const client = queueClient();
    const backend = backendFor({ sessionId: SID, isReattach: true });
    backend.spawn('/usr/bin/claude', [], spawnOpts());
    expect(syncCalls.map(c => c.method)).toEqual(['terminal.get']);
    expect(syncCalls[0]!.params).toEqual({ terminal: TARGET.sessionName });
    await attached(client);
    expect(client.attachParams).toMatchObject({ terminal: 't1', cols: 100, rows: 30 });
    backend.kill();
  });

  it("refuses another session's terminal and leaves it alone", () => {
    syncAnswers['terminal.get'] = () => ({ ok: true, value: record({ labels: { botmux: '1', botmux_sid: OTHER_SID } }) });
    const backend = backendFor({ sessionId: SID, isReattach: true });
    const exit = vi.fn();
    backend.onExit(exit);
    expect(() => backend.spawn('/usr/bin/claude', [], spawnOpts())).toThrow(new RegExp(OTHER_SID));
    expect(syncCalls.map(c => c.method)).toEqual(['terminal.get']);
    expect(exit).not.toHaveBeenCalled();
    expect(connectMock).not.toHaveBeenCalled();
  });

  it('reports a vanished terminal as lost with its core', () => {
    syncAnswers['terminal.get'] = () => ({ ok: false, kind: 'not_found', message: 'not found' });
    const backend = backendFor({ sessionId: SID, isReattach: true });
    const exit = vi.fn();
    backend.onExit(exit);
    expect(() => backend.spawn('/usr/bin/claude', [], spawnOpts())).toThrow();
    expect(exit).toHaveBeenCalledWith(1, null);
    expect(backend.exitedBecauseServerReplaced()).toBe(true);
  });

  it('reports a finished terminal with its exit status and removes the record', () => {
    syncAnswers['terminal.get'] = () => ({ ok: true, value: record({ state: 'finished', reason: 'exited', exit_code: 7, pid: null }) });
    const backend = backendFor({ sessionId: SID, isReattach: true });
    backend.spawn('/usr/bin/claude', [], spawnOpts());
    expect(syncCalls.map(c => [c.method, c.params.terminal])).toEqual([['terminal.get', TARGET.sessionName], ['terminal.rm', 't1']]);
    const exit = vi.fn();
    backend.onExit(exit);
    expect(exit).toHaveBeenCalledWith(7, null);
    expect(backend.exitedBecauseServerReplaced()).toBe(false);
    expect(connectMock).not.toHaveBeenCalled();
    expect(backend.write('x')).toBe(false);
    expect(backend.isPaneAlive()).toBe(false);
  });

  it('counts a program that died with its holder as replaced by the server', () => {
    syncAnswers['terminal.get'] = () => ({ ok: true, value: record({ state: 'finished', reason: 'holder_lost' }) });
    const backend = backendFor({ sessionId: SID, isReattach: true });
    backend.spawn('/usr/bin/claude', [], spawnOpts());
    expect(backend.exitedBecauseServerReplaced()).toBe(true);
  });
});

describe('screen and output', () => {
  it('hands what a fresh program drew before the attach to onData as a capture, never the raw paint, then forwards live output', async () => {
    const client = queueClient();
    const backend = backendFor({ sessionId: SID });
    const data: string[] = [];
    const resync = vi.fn();
    backend.onData(chunk => data.push(chunk));
    backend.onScreenResync(resync);
    backend.spawn('/usr/bin/claude', [], spawnOpts());
    const stream = await attached(client);
    expect(client.attachParams).toMatchObject({ terminal: 't1', cols: 100, rows: 30, history: HC_MIRROR_SCROLLBACK_LINES });
    expect(client.attachParams!.observe).not.toBe(true);
    expect(client.subscribeParams).toEqual({ terminal: 't1' });

    stream.paint('hello from hc');
    expect(resync).not.toHaveBeenCalled();
    expect(data).toEqual([backend.captureCurrentScreen()]);
    expect(data[0]).toContain('hello from hc');
    expect(data[0]).not.toContain('\x1b[!p');
    expect(backend.captureViewport()).toContain('hello from hc');
    data.length = 0;

    stream.live('\r\nmore \xe4\xb8');
    stream.live('\xad output');
    expect(data.join('')).toBe('\r\nmore 中 output');
    expect(backend.captureCurrentScreen()).toContain('more 中 output');
    expect(backend.captureInputState()?.viewport).toContain('more 中 output');
    backend.kill();
  });

  it('forwards only the status reports of a blank first paint', async () => {
    const client = queueClient();
    const backend = backendFor({ sessionId: SID });
    const data: string[] = [];
    backend.onData(chunk => data.push(chunk));
    backend.spawn('/usr/bin/claude', [], spawnOpts());
    (await attached(client)).paint('\x1b[H\x1b[2J', '\x1b]7501;state=idle\x1b\\');
    expect(data).toEqual(['\x1b]7501;state=idle\x1b\\']);
    backend.kill();
  });

  it('answers captures empty until the first paint, then hands the screen over through onScreenResync', async () => {
    const client = queueClient();
    const backend = backendFor({ sessionId: SID, isReattach: true });
    const resync = vi.fn();
    backend.onScreenResync(resync);
    backend.spawn('/usr/bin/claude', [], spawnOpts());
    expect(backend.captureCurrentScreen()).toBe('');
    expect(backend.captureInputState()).toBeNull();
    const viewport = backend.captureViewportAsync();
    const stream = await attached(client);
    stream.paint('restored screen');
    expect(resync).toHaveBeenCalledTimes(1);
    expect(resync.mock.calls[0]![0]).toContain('restored screen');
    await expect(viewport).resolves.toContain('restored screen');
    backend.kill();
  });

  it('follows a size another viewer takes and reports it', async () => {
    const client = queueClient();
    const backend = backendFor({ sessionId: SID });
    const sizes = vi.fn();
    backend.onPaneSizeChange(sizes);
    backend.spawn('/usr/bin/claude', [], spawnOpts());
    const stream = await attached(client);
    stream.paint('x');
    client.sub!.emit('size', { cols: 80, rows: 24 });
    expect(sizes).toHaveBeenCalledWith({ cols: 80, rows: 24 });
    expect(backend.getPaneSize()).toEqual({ cols: 80, rows: 24 });
    client.sub!.emit('size', { cols: 80, rows: 24 });
    expect(sizes).toHaveBeenCalledTimes(1);

    backend.resize(120, 40);
    expect(stream.resized).toEqual([[120, 40]]);
    expect(backend.getPaneSize()).toEqual({ cols: 120, rows: 40 });
    backend.kill();
  });

  it('keeps its latest size when the core acknowledges an earlier request late', async () => {
    const client = queueClient();
    const backend = backendFor({ sessionId: SID });
    const sizes = vi.fn();
    backend.onPaneSizeChange(sizes);
    backend.spawn('/usr/bin/claude', [], spawnOpts());
    (await attached(client)).paint('x');
    backend.resize(120, 40);
    backend.resize(90, 20);
    client.sub!.emit('size', { cols: 120, rows: 40 });
    expect(backend.getPaneSize()).toEqual({ cols: 90, rows: 20 });
    client.sub!.emit('size', { cols: 90, rows: 20 });
    expect(sizes).not.toHaveBeenCalled();
    expect(backend.getPaneSize()).toEqual({ cols: 90, rows: 20 });

    client.sub!.emit('size', { cols: 120, rows: 40 });
    expect(sizes).toHaveBeenCalledWith({ cols: 120, rows: 40 });
    backend.kill();
  });

  it('passes a repaint of dropped output on, with only the status reports the worker has not heard', async () => {
    const client = queueClient();
    const backend = backendFor({ sessionId: SID });
    const data: string[] = [];
    backend.onData(chunk => data.push(chunk));
    backend.spawn('/usr/bin/claude', [], spawnOpts());
    const stream = await attached(client);
    stream.paint('x', '\x1b]7501;state=working\x1b\\');
    stream.live('\x1b]7501;state=idle\x1b\\');
    data.length = 0;
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    stream.repaint('repainted', '\x1b]7501;state=idle\x1b\\');
    expect(data.join('')).toContain('repainted');
    expect(data.join('')).not.toContain('7501');
    expect(backend.captureViewport()).toContain('repainted');
    data.length = 0;
    stream.repaint('again', '\x1b]7501;state=working\x1b\\');
    stderr.mockRestore();
    expect(data.at(-1)).toBe('\x1b]7501;state=working\x1b\\');
    backend.kill();
  });
});

describe('input', () => {
  it('holds input written before the first paint and delivers it in order after it', async () => {
    const client = queueClient();
    const backend = backendFor({ sessionId: SID });
    backend.spawn('/usr/bin/claude', [], spawnOpts());
    expect(backend.write('a')).toBe(true);
    expect(backend.sendSpecialKeys('Enter')).toBe(true);
    const stream = await attached(client);
    expect(stream.written).toEqual([]);
    stream.paint('');
    expect(stream.written).toEqual(['a', '\r']);
    backend.kill();
  });

  it("encodes input sent before a reattach's first paint for the modes that paint restores", async () => {
    const client = queueClient();
    const backend = backendFor({ sessionId: SID, isReattach: true });
    backend.spawn('/usr/bin/claude', [], spawnOpts());
    const stream = await attached(client);
    expect(backend.sendSpecialKeys('Up')).toBe(true);
    expect(backend.pasteText('one\ntwo')).toBe(true);
    stream.paint('\x1b[?1h\x1b[?2004hprompt');
    expect(stream.written).toEqual(['\x1bOA', '\x1b[200~one\rtwo\x1b[201~']);
    backend.kill();
  });

  it("encodes keys and pastes for the program's current modes", async () => {
    const client = queueClient();
    const backend = backendFor({ sessionId: SID });
    backend.spawn('/usr/bin/claude', [], spawnOpts());
    const stream = await attached(client);
    stream.paint('');
    backend.sendSpecialKeys('Up', 'C-c');
    backend.pasteText('one\ntwo');
    stream.live('\x1b[?1h\x1b[?2004h');
    backend.sendSpecialKeys('Up');
    backend.pasteText('one\ntwo');
    backend.submitBracketedPaste('hi');
    backend.sendLines(['l1', 'l2'], 'M-Enter');
    expect(stream.written).toEqual([
      '\x1b[A\x03',
      'one\rtwo',
      '\x1bOA',
      '\x1b[200~one\rtwo\x1b[201~',
      '\x1b[200~hi\x1b[201~\r',
      'l1\x1b\rl2',
    ]);
    expect(backend.sendLines([], 'M-Enter')).toBe(false);
    backend.kill();
  });

  it('says false when the input provably did not arrive', async () => {
    const client = queueClient();
    const backend = backendFor({ sessionId: SID });
    backend.spawn('/usr/bin/claude', [], spawnOpts());
    const stream = await attached(client);
    stream.paint('');
    stream.accepts = false;
    expect(backend.write('x')).toBe(false);
    stream.accepts = true;
    client.drop();
    expect(backend.write('x')).toBe(false);
    expect(backend.sendSpecialKeys('Enter')).toBe(false);
    backend.kill();
    expect(backend.write('x')).toBe(false);
    expect(backend.submitBracketedPaste('x')).toBe(false);
  });
});

describe('exit', () => {
  async function running(): Promise<{ backend: HcBackend; client: FakeClient; stream: FakeStream }> {
    const client = queueClient();
    const backend = backendFor({ sessionId: SID });
    backend.spawn('/usr/bin/claude', [], spawnOpts());
    const stream = await attached(client);
    stream.paint('x');
    return { backend, client, stream };
  }

  it('reports the exit code once, replays it to late listeners and removes the record', async () => {
    const { backend, client, stream } = await running();
    const early = vi.fn();
    backend.onExit(early);
    stream.end({ reason: 'exited', exit_code: 3, signal: null, finished_ms: 1 });
    client.sub!.emit('finished', { reason: 'exited', exit_code: 3, signal: null, finished_ms: 1 });
    const late = vi.fn();
    backend.onExit(late);
    expect(early.mock.calls).toEqual([[3, null]]);
    expect(late.mock.calls).toEqual([[3, null]]);
    expect(backend.exitedBecauseServerReplaced()).toBe(false);
    expect(backend.getChildPid()).toBeNull();
    expect(backend.isPaneAlive()).toBe(false);
    expect(backend.captureCurrentScreen()).toBe('');
    await vi.waitFor(() => expect(client.closed).toBe(true));
    expect(client.calls.filter(c => c.method === 'terminal.rm').map(c => c.params)).toEqual([{ terminal: 't1' }]);
  });

  it('reports a signal death without a code', async () => {
    const { backend, client } = await running();
    const exit = vi.fn();
    backend.onExit(exit);
    client.sub!.emit('finished', { reason: 'signaled', exit_code: null, signal: 9, finished_ms: 1 });
    expect(exit).toHaveBeenCalledWith(null, '9');
  });

  it.each(['holder_lost', 'stopped_by_restart', 'server_stop', 'host_shutdown'])('counts %s as the server going away', async reason => {
    const { backend, stream } = await running();
    stream.end({ reason, exit_code: null, signal: 1, finished_ms: 1 });
    expect(backend.exitedBecauseServerReplaced()).toBe(true);
  });

  it('ends when someone else removes the terminal', async () => {
    const { backend, client } = await running();
    const exit = vi.fn();
    backend.onExit(exit);
    client.sub!.emit('removed', {});
    expect(exit).toHaveBeenCalledWith(1, null);
  });

  it('kill() detaches without ending the terminal or reporting an exit', async () => {
    const { backend, client, stream } = await running();
    const exit = vi.fn();
    backend.onExit(exit);
    backend.kill();
    expect(stream.closed).toBe(true);
    expect(client.closed).toBe(true);
    expect(client.methods()).not.toContain('terminal.kill');
    expect(killMock).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
    expect(backend.isPaneAlive()).toBe(false);
    expect(backend.exitedBecauseServerReplaced()).toBe(false);
  });

  it('destroySession() ends the terminal through the label-checked kill', async () => {
    const { backend } = await running();
    const env = { PATH: '/usr/bin' };
    const owned = backendFor({ sessionId: SID, env });
    owned.destroySession();
    expect(killMock).toHaveBeenCalledWith(TARGET, SID, { env });
    backend.kill();
  });
});

describe('reconnect', () => {
  it('resyncs from the new paint, and replays the status reports it carries', async () => {
    const first = queueClient();
    const backend = backendFor({ sessionId: SID });
    const data: string[] = [];
    const resync = vi.fn();
    backend.onData(chunk => data.push(chunk));
    backend.onScreenResync(resync);
    backend.spawn('/usr/bin/claude', [], spawnOpts());
    (await attached(first)).paint('before restart', '\x1b]7501;state=working\x1b\\');
    expect(data.at(-1)).toBe('\x1b]7501;state=working\x1b\\');
    data.length = 0;

    const second = queueClient();
    first.drop();
    expect(backend.captureCurrentScreen()).toBe('');
    expect(backend.isPaneAlive()).toBe(true);
    const stream = await attached(second);
    expect(second.methods()).toEqual(['terminal.get']);
    stream.paint('after restart', '\x1b]7501;state=idle\x1b\\');
    expect(resync).toHaveBeenCalledTimes(1);
    expect(resync.mock.calls[0]![0]).toContain('after restart');
    expect(data).toEqual(['\x1b]7501;state=idle\x1b\\']);
    expect(backend.captureViewport()).toContain('after restart');
    stream.live('!');
    expect(data.at(-1)).toBe('!');
    backend.kill();
  });

  async function reconnected(current: FakeClient): Promise<{ client: FakeClient; stream: FakeStream }> {
    const client = queueClient();
    current.drop();
    return { client, stream: await attached(client) };
  }

  it('does not replay a status the worker already heard, painted or live', async () => {
    const first = queueClient();
    const backend = backendFor({ sessionId: SID });
    const data: string[] = [];
    backend.onData(chunk => data.push(chunk));
    backend.spawn('/usr/bin/claude', [], spawnOpts());
    const stream = await attached(first);
    stream.paint('x', '\x1b]7501;state=working\x1b\\');
    stream.live('\x1b]75');
    stream.live('01;state=idle:app=demo\x1b\\');
    data.length = 0;
    (await reconnected(first)).stream.paint('y', '\x1b]7501;state=idle:app=demo:title=\x1b\\');
    expect(data).toEqual([]);
    backend.kill();
  });

  it('tells the worker which records changed or went away while it heard nothing', async () => {
    const first = queueClient();
    const backend = backendFor({ sessionId: SID });
    const data: string[] = [];
    backend.onData(chunk => data.push(chunk));
    backend.spawn('/usr/bin/claude', [], spawnOpts());
    (await attached(first)).paint('x', [
      '\x1b]7501;state=working\x1b\\',
      '\x1b]7501;state=working:id=sub1\x1b\\',
      '\x1b]7501;state=blocked:id=sub2:kind=permission\x1b\\',
    ].join(''));
    data.length = 0;
    const second = await reconnected(first);
    second.stream.paint('y', '\x1b]7501;state=working\x1b\\\x1b]7501;state=idle:id=sub2\x1b\\');
    expect(data).toEqual(['\x1b]7501;state=clear:id=sub1\x1b\\\x1b]7501;state=idle:id=sub2\x1b\\']);
    data.length = 0;
    (await reconnected(second.client)).stream.paint('z');
    expect(data).toEqual(['\x1b]7501;state=clear\x1b\\']);
    backend.kill();
  });

  it('ends as replaced, touching nothing, when the name now holds another session', async () => {
    const first = queueClient();
    const backend = backendFor({ sessionId: SID });
    const exit = vi.fn();
    backend.onExit(exit);
    backend.spawn('/usr/bin/claude', [], spawnOpts());
    await attached(first);
    const second = queueClient(new FakeClient(record({ labels: { botmux: '1', botmux_sid: OTHER_SID } })));
    first.drop();
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1, null));
    expect(backend.exitedBecauseServerReplaced()).toBe(true);
    expect(second.methods()).toEqual(['terminal.get']);
    expect(second.attachParams).toBeNull();
    expect(second.closed).toBe(true);
  });

  it('ends as replaced when the core lost the terminal', async () => {
    const first = queueClient();
    const backend = backendFor({ sessionId: SID });
    backend.spawn('/usr/bin/claude', [], spawnOpts());
    await attached(first);
    queueClient(new FakeClient(null));
    first.drop();
    await vi.waitFor(() => expect(backend.exitedBecauseServerReplaced()).toBe(true));
  });

  it('gives up after the core stays unreachable for the outage window', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const first = queueClient();
    const backend = backendFor({ sessionId: SID });
    const exit = vi.fn();
    backend.onExit(exit);
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    backend.spawn('/usr/bin/claude', [], spawnOpts());
    await vi.advanceTimersByTimeAsync(0);
    await attached(first);
    first.drop();
    await vi.advanceTimersByTimeAsync(55_000);
    expect(exit).not.toHaveBeenCalled();
    expect(ensureCoreMock).toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10_000);
    stderr.mockRestore();
    expect(exit).toHaveBeenCalledWith(1, null);
    expect(backend.exitedBecauseServerReplaced()).toBe(true);
  });
});

describe('retireSessionCreatedBySpawn', () => {
  it('ends and removes the terminal this spawn created, by address', () => {
    queueClient();
    const backend = backendFor({ sessionId: SID });
    backend.spawn('/usr/bin/claude', [], spawnOpts());
    backend.kill();
    syncCalls.length = 0;
    expect(backend.retireSessionCreatedBySpawn()).toBe(true);
    expect(syncCalls.map(c => [c.method, c.params.terminal])).toEqual([
      ['terminal.get', 't1'], ['terminal.kill', 't1'], ['terminal.rm', 't1'],
    ]);
    expect(readdirSync(launchDir)).toEqual([]);
    expect(backend.retireSessionCreatedBySpawn()).toBe(false);
  });

  it('leaves the address alone once it holds another terminal', () => {
    queueClient();
    const backend = backendFor({ sessionId: SID });
    backend.spawn('/usr/bin/claude', [], spawnOpts());
    backend.kill();
    syncAnswers['terminal.get'] = () => ({ ok: true, value: record({ labels: { botmux: '1', botmux_sid: OTHER_SID } }) });
    syncCalls.length = 0;
    expect(backend.retireSessionCreatedBySpawn()).toBe(false);
    expect(syncCalls.map(c => c.method)).toEqual(['terminal.get']);
  });

  it('never retires a terminal it reattached to', () => {
    queueClient();
    const backend = backendFor({ sessionId: SID, isReattach: true });
    backend.spawn('/usr/bin/claude', [], spawnOpts());
    backend.kill();
    syncCalls.length = 0;
    expect(backend.retireSessionCreatedBySpawn()).toBe(false);
    expect(syncCalls).toEqual([]);
  });
});
