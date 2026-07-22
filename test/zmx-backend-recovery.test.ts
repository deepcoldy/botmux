import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync, writeFileSync, writeSync } from 'node:fs';

const childMocks = vi.hoisted(() => {
  class FakeStream {
    private readonly listeners = new Map<string, Array<(value: any) => void>>();

    on(event: string, cb: (value: any) => void): this {
      const callbacks = this.listeners.get(event) ?? [];
      callbacks.push(cb);
      this.listeners.set(event, callbacks);
      return this;
    }

    emit(event: string, value: any): void {
      for (const cb of this.listeners.get(event) ?? []) cb(value);
    }
  }

  class FakeChild {
    readonly stdout = new FakeStream();
    readonly stderr = new FakeStream();
    killed = false;
    onDisconnect: (() => void) | null = null;
    private disconnected = false;
    private readonly onceListeners = new Map<string, (a: any, b?: any) => void>();

    constructor(readonly kind: 'tail' | 'history') {}

    once(event: string, cb: (a: any, b?: any) => void): this {
      this.onceListeners.set(event, cb);
      return this;
    }

    kill(): boolean {
      this.killed = true;
      this.disconnect();
      return true;
    }

    emitData(value: Buffer | string): void {
      this.stdout.emit('data', value);
    }

    emitClose(code: number | null = 0, signal: NodeJS.Signals | null = null): void {
      this.disconnect();
      this.onceListeners.get('close')?.(code, signal);
    }

    private disconnect(): void {
      if (this.disconnected) return;
      this.disconnected = true;
      this.onDisconnect?.();
    }
  }

  return {
    FakeChild,
    execFile: vi.fn(),
    execFileSync: vi.fn(),
    spawn: vi.fn(),
    spawnSync: vi.fn(),
    children: [] as FakeChild[],
  };
});

const fsMocks = vi.hoisted(() => ({
  readFileSync: vi.fn(),
  actualReadFileSync: null as null | ((...args: any[]) => any),
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFile: childMocks.execFile,
    execFileSync: childMocks.execFileSync,
    spawn: childMocks.spawn,
    spawnSync: childMocks.spawnSync,
  };
});

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  fsMocks.actualReadFileSync = actual.readFileSync as (...args: any[]) => any;
  return {
    ...actual,
    readFileSync: fsMocks.readFileSync,
  };
});

import { ZmxBackend } from '../src/adapters/backend/zmx-backend.js';

const SESSION = 'bmx-test0001';
const SESSION_ID = 'test0001-1111-2222-3333-444444444444';
const PRIVATE_VALUE = 'provider-secret';

interface FakeZmxState {
  exists: boolean;
  pid: number;
  clients: number;
  command: string;
  transport: string;
  sessionId: string;
  launchPid: number;
  history: string;
  historyStderr: string;
  sendInputs: Buffer[];
  failSendAt: number | null;
  deferHistory: boolean;
  readyPath: string | null;
}

let state: FakeZmxState;
const backends: ZmxBackend[] = [];

function zmxList(): string {
  if (!state.exists) return '';
  return `  name=${SESSION}\tpid=${state.pid}\tclients=${state.clients}\tcmd=${state.command}\n`;
}

function extractShellAssignment(script: string, name: string): string {
  const match = script.match(new RegExp(`^${name}='([^']*)'$`, 'm'));
  if (!match) throw new Error(`missing ${name} in bootstrap`);
  return match[1]!;
}

function makeBackend(opts: { reattach?: boolean } = {}): ZmxBackend {
  const backend = new ZmxBackend(SESSION, {
    ownsSession: true,
    isReattach: opts.reattach ?? false,
    sessionId: SESSION_ID,
  });
  backends.push(backend);
  return backend;
}

function spawnBackend(backend = makeBackend()): ZmxBackend {
  backend.spawn('/bin/sh', ['-c', 'echo ready'], {
    cwd: '/tmp',
    cols: 80,
    rows: 24,
    env: { PATH: '/bin', BOTMUX_SESSION_ID: SESSION_ID },
    injectEnv: { PROVIDER_TEST_TOKEN: PRIVATE_VALUE },
  });
  return backend;
}

function tailChildren(): InstanceType<typeof childMocks.FakeChild>[] {
  return childMocks.children.filter(child => child.kind === 'tail');
}

function historyChildren(): InstanceType<typeof childMocks.FakeChild>[] {
  return childMocks.children.filter(child => child.kind === 'history');
}

async function settleAtCurrentTime(): Promise<void> {
  // Labels are read through async execFile, then history through a child
  // process. Drain both promise/microtask boundaries before advancing timers
  // that their completion may have scheduled at the current fake time.
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
  await vi.advanceTimersByTimeAsync(0);
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
}

async function advanceAndSettle(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
  await settleAtCurrentTime();
}

describe('ZmxBackend history-authoritative transport', () => {
  beforeEach(() => {
    // Keep Date.now real: fresh-ready/tail handshakes use synchronous
    // Atomics.wait polling. Freezing Date would turn a regression into a hung
    // test instead of letting its real deadline expire.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    state = {
      exists: false,
      pid: process.ppid,
      clients: 0,
      command: '',
      transport: '',
      sessionId: '',
      launchPid: process.pid,
      history: '',
      historyStderr: '',
      sendInputs: [],
      failSendAt: null,
      deferHistory: false,
      readyPath: null,
    };
    backends.length = 0;
    childMocks.children.length = 0;
    childMocks.execFile.mockReset();
    childMocks.execFileSync.mockReset();
    childMocks.spawn.mockReset();
    childMocks.spawnSync.mockReset();
    fsMocks.readFileSync.mockReset();
    fsMocks.readFileSync.mockImplementation((...args: any[]) => fsMocks.actualReadFileSync!(...args));

    childMocks.execFileSync.mockImplementation((_file: string, argv: string[], options?: any) => {
      if (_file === '/usr/bin/ps') {
        const pid = Number(argv.at(-1));
        return pid === state.launchPid ? `${state.pid}\n` : '';
      }
      const [command, ...args] = argv;
      if (command === 'list' && args[0] === '--short') return state.exists ? `${SESSION}\n` : '';
      if (command === 'list') return zmxList();
      if (command === 'get') {
        if (args[1] === 'botmux.transport') return state.transport;
        if (args[1] === 'botmux.session') return state.sessionId;
        if (args[1] === 'botmux.launch_pid') return `${state.launchPid}\n`;
        return `botmux.transport=${state.transport}\nbotmux.session=${state.sessionId}\nbotmux.launch_pid=${state.launchPid}\n`;
      }
      if (command === 'set') {
        for (const assignment of args.slice(1)) {
          const [key, value = ''] = assignment.split('=', 2);
          if (key === 'botmux.transport') state.transport = value;
          if (key === 'botmux.session') state.sessionId = value;
          if (key === 'botmux.launch_pid') state.launchPid = Number(value);
        }
        return '';
      }
      if (command === 'send') {
        state.sendInputs.push(Buffer.from(options?.input ?? ''));
        return state.failSendAt === state.sendInputs.length
          ? `session ${SESSION} is unresponsive\n`
          : '';
      }
      if (command === 'kill') {
        state.exists = false;
        state.clients = 0;
        return '';
      }
      throw new Error(`unexpected zmx command: ${argv.join(' ')}`);
    });

    childMocks.execFile.mockImplementation((_file: string, argv: string[], _options: unknown, callback: Function) => {
      const child = { kill: vi.fn() };
      const [command] = argv;
      queueMicrotask(() => {
        if (command !== 'get') {
          callback(new Error(`unexpected async zmx command: ${argv.join(' ')}`), '', '');
          return;
        }
        callback(
          null,
          `botmux.transport=${state.transport}\nbotmux.session=${state.sessionId}\nbotmux.launch_pid=${state.launchPid}\n`,
          '',
        );
      });
      return child;
    });

    childMocks.spawnSync.mockImplementation((_file: string, argv: string[]) => {
      const bootstrapPath = argv.at(-1)!;
      const bootstrap = readFileSync(bootstrapPath, 'utf8');
      const readyPath = extractShellAssignment(bootstrap, 'ready_path');
      const cliPidPath = extractShellAssignment(bootstrap, 'cli_pid_path');
      const readyNonce = extractShellAssignment(bootstrap, 'ready_nonce');
      state.readyPath = readyPath;
      state.exists = true;
      state.command = `/bin/sh ${bootstrapPath}`;
      writeFileSync(cliPidPath, `${state.launchPid}\n`, { mode: 0o600 });
      writeFileSync(readyPath, `${readyNonce}\n`, { mode: 0o600 });
      return {
        pid: 99,
        status: 0,
        signal: null,
        stdout: Buffer.alloc(0),
        stderr: Buffer.alloc(0),
      } as any;
    });

    childMocks.spawn.mockImplementation((_file: string, argv: string[], options?: any) => {
      const kind = argv[0] === 'tail' ? 'tail' : 'history';
      const child = new childMocks.FakeChild(kind);
      childMocks.children.push(child);
      if (kind === 'tail') {
        state.clients += 1;
        child.onDisconnect = () => { state.clients = Math.max(0, state.clients - 1); };
      } else {
        const fd = options?.stdio?.[1];
        if (typeof fd !== 'number') throw new Error('history stdout must be a private file descriptor');
        writeSync(fd, Buffer.from(state.history, 'utf8'));
        if (state.historyStderr) child.stderr.emit('data', state.historyStderr);
        if (!state.deferHistory) queueMicrotask(() => child.emitClose(0, null));
      }
      return child as any;
    });
  });

  afterEach(() => {
    for (const backend of backends) backend.kill();
    vi.useRealTimers();
  });

  it('waits through transient empty and mismatched fresh-ready reads', () => {
    let readyReads = 0;
    fsMocks.readFileSync.mockImplementation((path: unknown, ...args: any[]) => {
      if (state.readyPath && String(path) === state.readyPath) {
        readyReads += 1;
        if (readyReads === 1) return '';
        if (readyReads === 2) return 'stale-ready-nonce\n';
      }
      return fsMocks.actualReadFileSync!(path, ...args);
    });

    expect(() => spawnBackend()).not.toThrow();
    expect(readyReads).toBe(3);
  });

  it('uses tail only as a change signal and publishes Unicode from history', async () => {
    state.history = '你好😀曛\n';
    const backend = spawnBackend();
    const output: string[] = [];
    const resyncs: string[] = [];
    backend.onData(data => output.push(data));
    backend.onScreenResync(snapshot => resyncs.push(snapshot));

    const tail = tailChildren()[0]!;
    tail.emitData('tail-bytes-that-must-never-reach-worker\n');
    expect(output).toEqual([]);
    expect(resyncs).toEqual([]);

    await settleAtCurrentTime();
    expect(output).toEqual([]);
    expect(resyncs).toEqual(['你好😀曛\r\n']);
    expect(resyncs.join('')).not.toContain('tail-bytes');
    expect(backend.captureCurrentScreen()).toBe('你好😀曛\r\n');
  });

  it('safety-polls pure Chinese output even when tail emits no data', async () => {
    const backend = spawnBackend();
    const output: string[] = [];
    backend.onData(data => output.push(data));
    await settleAtCurrentTime();

    state.history = '纯中文没有 tail 事件：你好曛😀\n';
    await advanceAndSettle(250);

    expect(output).toEqual(['纯中文没有 tail 事件：你好曛😀\r\n']);
  });

  it('re-syncs an unchanged history snapshot when tail reports activity', async () => {
    state.history = 'same screen\n';
    const backend = spawnBackend();
    const resyncs: string[] = [];
    backend.onScreenResync(snapshot => resyncs.push(snapshot));
    await settleAtCurrentTime();

    tailChildren()[0]!.emitData(Buffer.from([0xe6, 0x9b, 0x9b]));
    await advanceAndSettle(50);

    expect(resyncs).toEqual(['same screen\r\n', 'same screen\r\n']);
  });

  it('emits only an authoritative prefix delta and re-syncs a rewritten history', async () => {
    state.history = 'first\n';
    const backend = spawnBackend();
    const output: string[] = [];
    const resyncs: string[] = [];
    backend.onData(data => output.push(data));
    backend.onScreenResync(snapshot => resyncs.push(snapshot));
    await settleAtCurrentTime();

    state.history = 'first\nsecond\n';
    tailChildren()[0]!.emitData('hint');
    await advanceAndSettle(50);
    expect(output).toEqual(['second\r\n']);
    expect(resyncs).toEqual(['first\r\n']);

    state.history = 'rewritten\n';
    tailChildren()[0]!.emitData('hint');
    await advanceAndSettle(50);
    expect(resyncs).toEqual(['first\r\n', 'rewritten\r\n']);
  });

  it('coalesces tail triggers behind one in-flight history capture', async () => {
    state.history = 'one\n';
    state.deferHistory = true;
    const backend = spawnBackend();
    const output: string[] = [];
    backend.onData(data => output.push(data));
    await settleAtCurrentTime();
    expect(historyChildren()).toHaveLength(1);

    for (let i = 0; i < 10; i += 1) tailChildren()[0]!.emitData('hint');
    expect(historyChildren()).toHaveLength(1);

    state.history = 'one\ntwo\n';
    state.deferHistory = false;
    historyChildren()[0]!.emitClose(0, null);
    await settleAtCurrentTime();
    // The ten triggers merge into exactly one follow-up capture, rather than
    // spawning one `zmx history` process per tail chunk. The follow-up retains
    // a short debounce so a large transcript cannot starve concurrent send.
    expect(historyChildren()).toHaveLength(1);
    await advanceAndSettle(50);
    expect(historyChildren()).toHaveLength(2);
    await settleAtCurrentTime();
    expect(output).toEqual(['two\r\n']);
  });

  it('settleCurrentScreen waits for a capture that starts after the in-flight sample', async () => {
    state.history = 'before\n';
    state.deferHistory = true;
    const backend = spawnBackend();
    const output: string[] = [];
    backend.onData(data => output.push(data));
    await settleAtCurrentTime();
    expect(historyChildren()).toHaveLength(1);

    const settled = backend.settleCurrentScreen();
    state.history = 'before\nfinal pure 中文曛😀\n';
    state.deferHistory = false;
    historyChildren()[0]!.emitClose(0, null);
    await settleAtCurrentTime();

    expect(historyChildren()).toHaveLength(1);
    await advanceAndSettle(50);
    expect(historyChildren()).toHaveLength(2);
    await expect(settled).resolves.toBe(true);
    expect(output).toEqual(['final pure 中文曛😀\r\n']);
  });

  it('keeps settle pending when its own capture is dirtied and waits for the follow-up', async () => {
    state.history = 'before\n';
    const backend = spawnBackend();
    const output: string[] = [];
    backend.onData(data => output.push(data));
    await settleAtCurrentTime();
    expect(historyChildren()).toHaveLength(1);

    state.deferHistory = true;
    const settled = backend.settleCurrentScreen();
    let didSettle = false;
    void settled.then(() => { didSettle = true; });
    await settleAtCurrentTime();
    expect(historyChildren()).toHaveLength(2);

    // Output arrives after capture A started. The tail payload is only a wake
    // signal, but it must latch a mandatory capture B before settle resolves.
    state.history = 'before\nafter capture start 中文曛😀\n';
    tailChildren()[0]!.emitData('dirty');
    state.deferHistory = false;
    historyChildren()[1]!.emitClose(0, null);
    await settleAtCurrentTime();
    expect(didSettle).toBe(false);

    await advanceAndSettle(50);
    expect(historyChildren()).toHaveLength(3);
    await expect(settled).resolves.toBe(true);
    expect(output).toEqual(['after capture start 中文曛😀\r\n']);
  });

  it('rejects an ambiguous empty history without clearing cache or consuming resync obligations', async () => {
    state.history = 'authoritative nonempty\n';
    const backend = spawnBackend();
    const resyncs: string[] = [];
    backend.onScreenResync(snapshot => resyncs.push(snapshot));
    await settleAtCurrentTime();
    expect(backend.captureCurrentScreen()).toBe('authoritative nonempty\r\n');
    expect(resyncs).toEqual(['authoritative nonempty\r\n']);

    state.history = '';
    const rejected = backend.settleCurrentScreen();
    (backend as any).requestHistoryCapture(0, true, true);
    await settleAtCurrentTime();

    await expect(rejected).resolves.toBe(false);
    expect(backend.captureCurrentScreen()).toBe('authoritative nonempty\r\n');
    expect((backend as any).tailActivitySinceCapture).toBe(true);
    expect((backend as any).forceResyncOnNextSnapshot).toBe(true);

    state.history = 'authoritative nonempty\n';
    const recovered = backend.settleCurrentScreen();
    await settleAtCurrentTime();

    await expect(recovered).resolves.toBe(true);
    expect(resyncs).toEqual([
      'authoritative nonempty\r\n',
      'authoritative nonempty\r\n',
    ]);
    expect((backend as any).tailActivitySinceCapture).toBe(false);
    expect((backend as any).forceResyncOnNextSnapshot).toBe(false);
  });

  it('returns false on a rejected single-frame send without emitting a generic compensation frame', () => {
    const backend = spawnBackend();

    state.failSendAt = 1;
    expect(backend.sendText('short input')).toBe(false);
    expect(state.sendInputs).toHaveLength(1);
    expect(state.sendInputs[0]!.subarray(0, -1).toString()).toBe('short input');

    state.sendInputs.length = 0;
    state.failSendAt = 1;
    expect(backend.sendSpecialKeys('Enter')).toBe(false);
    expect(state.sendInputs).toHaveLength(1);
    expect(state.sendInputs[0]!.subarray(0, -1).toString()).toBe('\r');
  });

  it('rejects input above 64 KiB before sending any prefix', () => {
    const backend = spawnBackend();

    expect(() => backend.sendText('x'.repeat((64 * 1024) + 1))).toThrow(/超过 65536 字节安全上限/);
    expect(state.sendInputs).toEqual([]);
  });

  it('closes bracketed paste and cancels even when its first frame is rejected ambiguously', () => {
    const backend = spawnBackend();
    state.failSendAt = 1;

    expect(() => backend.pasteText('short paste')).toThrow(/粘贴发送失败/);
    expect(state.sendInputs).toHaveLength(2);
    expect(state.sendInputs[0]!.subarray(0, 6).toString()).toBe('\x1b[200~');
    expect(state.sendInputs[1]!.toString()).toBe('\x1b[201~\x03\n');
  });

  it('closes bracketed paste and cancels a partial multi-frame send', () => {
    const backend = spawnBackend();
    state.failSendAt = 2;

    expect(() => backend.pasteText('x'.repeat(2_000))).toThrow(/粘贴发送失败/);
    expect(state.sendInputs).toHaveLength(3);
    expect(state.sendInputs[0]!.subarray(0, 6).toString()).toBe('\x1b[200~');
    expect(state.sendInputs[2]!.toString()).toBe('\x1b[201~\x03\n');
  });

  it('serves captureCurrentScreen from the cache without spawning history', async () => {
    state.history = 'cached 你好😀\n';
    const backend = spawnBackend();
    await settleAtCurrentTime();
    const capturesBefore = historyChildren().length;

    expect(backend.captureCurrentScreen()).toBe('cached 你好😀\r\n');
    expect(backend.captureViewport()).toBe('cached 你好😀\r\n');
    expect(historyChildren()).toHaveLength(capturesBefore);
  });

  it('preserves a same-name session whose complete UUID label belongs elsewhere', () => {
    state.exists = true;
    state.command = '/usr/bin/vim';
    state.transport = 'tail-send-v1';
    state.sessionId = 'test0001-9999-8888-7777-666666666666';
    const backend = makeBackend({ reattach: true });

    expect(() => spawnBackend(backend)).toThrow(/另一个完整 botmux session/);
    backend.destroySession();
    expect(state.exists).toBe(true);
    expect(childMocks.execFileSync.mock.calls.some(([, argv]) => argv[0] === 'kill')).toBe(false);
  });
});
