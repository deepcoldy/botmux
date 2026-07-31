import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
  renameSync: vi.fn(),
  actualReadFileSync: null as null | ((...args: any[]) => any),
  actualRenameSync: null as null | ((...args: any[]) => any),
}));

const durabilityMocks = vi.hoisted(() => ({
  fsyncDirectorySyncPortable: vi.fn(),
  actualFsyncDirectorySyncPortable: null as null | ((path: string) => void),
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
  fsMocks.actualRenameSync = actual.renameSync as (...args: any[]) => any;
  return {
    ...actual,
    readFileSync: fsMocks.readFileSync,
    renameSync: fsMocks.renameSync,
  };
});

vi.mock('../src/utils/fs-durability.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/utils/fs-durability.js')>();
  durabilityMocks.actualFsyncDirectorySyncPortable =
    actual.fsyncDirectorySyncPortable;
  return {
    ...actual,
    fsyncDirectorySyncPortable: durabilityMocks.fsyncDirectorySyncPortable,
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
  launchParentPid: number;
  launchCommand: string;
  gateNonce: string;
  history: string;
  historyStderr: string;
  sendInputs: Buffer[];
  sendTimes: number[];
  failSendAt: number | null;
  throwOnFailedSend: boolean;
  replaceOnFailedSend: boolean;
  failGetsAfterSend: number;
  failedGetAfterSendCount: number;
  deferHistory: boolean;
  readyPath: string | null;
  releasePath: string | null;
  cliPidPath: string | null;
  releaseBehavior: 'consume' | 'leave' | 'die';
}

let state: FakeZmxState;
const backends: ZmxBackend[] = [];
const recoveryStateDirs: string[] = [];

function zmxList(): string {
  if (!state.exists) return '';
  return `  name=${SESSION}\tpid=${state.pid}\tclients=${state.clients}\tcmd=${state.command}\n`;
}

function extractShellAssignment(script: string, name: string): string {
  const match = script.match(new RegExp(`^${name}='([^']*)'$`, 'm'));
  if (!match) throw new Error(`missing ${name} in bootstrap`);
  return match[1]!;
}

function makeBackend(opts: { reattach?: boolean; recoveryStateDir?: string } = {}): ZmxBackend {
  const backend = new ZmxBackend(SESSION, {
    ownsSession: true,
    isReattach: opts.reattach ?? false,
    sessionId: SESSION_ID,
    recoveryStateDir: opts.recoveryStateDir,
  });
  backends.push(backend);
  return backend;
}

function makeRecoveryStateDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'botmux-zmx-recovery-'));
  recoveryStateDirs.push(dir);
  return dir;
}

function recoveryStatePath(dir: string): string {
  const key = createHash('sha256').update(SESSION_ID).digest('hex');
  return join(dir, 'zmx-composer-recovery', `${key}.json`);
}

function readRecoveryState(dir: string): {
  version: number;
  sessionId: string;
  state: string;
} {
  return JSON.parse(readFileSync(recoveryStatePath(dir), 'utf8'));
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
      launchParentPid: process.ppid,
      launchCommand: '/bin/sh -c echo ready',
      gateNonce: '0123456789abcdef0123456789abcdef',
      history: '',
      historyStderr: '',
      sendInputs: [],
      sendTimes: [],
      failSendAt: null,
      throwOnFailedSend: false,
      replaceOnFailedSend: false,
      failGetsAfterSend: 0,
      failedGetAfterSendCount: 0,
      deferHistory: false,
      readyPath: null,
      releasePath: null,
      cliPidPath: null,
      releaseBehavior: 'consume',
    };
    backends.length = 0;
    childMocks.children.length = 0;
    childMocks.execFile.mockReset();
    childMocks.execFileSync.mockReset();
    childMocks.spawn.mockReset();
    childMocks.spawnSync.mockReset();
    fsMocks.readFileSync.mockReset();
    fsMocks.readFileSync.mockImplementation((...args: any[]) => {
      if (String(args[0]) === `/proc/${state.launchPid}/cmdline`) {
        return Buffer.from(`${state.launchCommand}\0`, 'utf8');
      }
      return fsMocks.actualReadFileSync!(...args);
    });
    fsMocks.renameSync.mockReset();
    fsMocks.renameSync.mockImplementation((...args: any[]) => {
      const result = fsMocks.actualRenameSync!(...args);
      const destination = String(args[1]);
      if (state.releasePath && destination === state.releasePath) {
        if (state.releaseBehavior === 'consume') {
          rmSync(destination, { force: true });
          state.launchCommand = '/bin/sh -c echo ready';
        } else if (state.releaseBehavior === 'die' && state.cliPidPath) {
          rmSync(state.cliPidPath, { force: true });
        }
      }
      return result;
    });
    durabilityMocks.fsyncDirectorySyncPortable.mockReset();
    durabilityMocks.fsyncDirectorySyncPortable.mockImplementation(
      (path: string) => durabilityMocks.actualFsyncDirectorySyncPortable!(path),
    );

    childMocks.execFileSync.mockImplementation((_file: string, argv: string[], options?: any) => {
      if (_file === '/usr/bin/ps' || _file === '/bin/ps') {
        const pid = Number(argv.at(-1));
        if (pid !== state.launchPid) return '';
        return argv.includes('command=')
          ? `${state.launchCommand}\n`
          : `${state.launchParentPid}\n`;
      }
      const [command, ...args] = argv;
      if (command === 'list' && args[0] === '--short') return state.exists ? `${SESSION}\n` : '';
      if (command === 'list') return zmxList();
      if (command === 'get') {
        if (state.failGetsAfterSend > 0 && state.sendInputs.length > 0) {
          state.failGetsAfterSend -= 1;
          state.failedGetAfterSendCount += 1;
          throw new Error(`zmx get ${SESSION} timed out`);
        }
        if (args[1] === 'botmux.transport') return state.transport;
        if (args[1] === 'botmux.session') return state.sessionId;
        if (args[1] === 'botmux.launch_pid') return `${state.launchPid}\n`;
        if (args[1] === 'botmux.gate_nonce') return `${state.gateNonce}\n`;
        return `botmux.transport=${state.transport}\nbotmux.session=${state.sessionId}\nbotmux.launch_pid=${state.launchPid}\nbotmux.gate_nonce=${state.gateNonce}\n`;
      }
      if (command === 'set') {
        for (const assignment of args.slice(1)) {
          const [key, value = ''] = assignment.split('=', 2);
          if (key === 'botmux.transport') state.transport = value;
          if (key === 'botmux.session') state.sessionId = value;
          if (key === 'botmux.launch_pid') state.launchPid = Number(value);
          if (key === 'botmux.gate_nonce') state.gateNonce = value;
        }
        return '';
      }
      if (command === 'send') {
        state.sendInputs.push(Buffer.from(options?.input ?? ''));
        state.sendTimes.push(Date.now());
        if (state.failSendAt === state.sendInputs.length) {
          if (state.replaceOnFailedSend) {
            state.sessionId = 'replacement-session-id';
          }
          if (state.throwOnFailedSend) {
            throw new Error(`zmx send ${SESSION} timed out`);
          }
          return `session ${SESSION} is unresponsive\n`;
        }
        return '';
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
          `botmux.transport=${state.transport}\nbotmux.session=${state.sessionId}\nbotmux.launch_pid=${state.launchPid}\nbotmux.gate_nonce=${state.gateNonce}\n`,
          '',
        );
      });
      return child;
    });

    childMocks.spawnSync.mockImplementation((_file: string, argv: string[]) => {
      const bootstrapPath = argv.at(-1)!;
      const bootstrap = readFileSync(bootstrapPath, 'utf8');
      const readyPath = extractShellAssignment(bootstrap, 'ready_path');
      const releasePath = extractShellAssignment(bootstrap, 'release_path');
      const cliPidPath = extractShellAssignment(bootstrap, 'cli_pid_path');
      const readyNonce = extractShellAssignment(bootstrap, 'ready_nonce');
      state.readyPath = readyPath;
      state.releasePath = releasePath;
      state.cliPidPath = cliPidPath;
      state.gateNonce = readyNonce;
      state.launchCommand =
        `sh -c gate botmux-zmx-private-release-gate-v1:${readyNonce}`;
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
    for (const dir of recoveryStateDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
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

  it('reports a fresh spawn only after the gate consumes the release token', () => {
    expect(() => spawnBackend()).not.toThrow();
    expect(state.releasePath).not.toBeNull();
    expect(existsSync(state.releasePath!)).toBe(false);
    expect(state.cliPidPath).not.toBeNull();
    expect(readFileSync(state.cliPidPath!, 'utf8').trim())
      .toBe(String(state.launchPid));
  });

  it('tears down an exact fresh session when the gate dies before release acknowledgement', () => {
    state.releaseBehavior = 'die';

    expect(() => spawnBackend())
      .toThrow(/CLI release 未被稳定 launch 子进程确认/);
    expect(state.exists).toBe(false);
    expect(childMocks.execFileSync.mock.calls.some(([, argv]) =>
      argv[0] === 'kill' && argv[1] === SESSION && argv[2] === '--force',
    )).toBe(true);
    expect(state.sendInputs).toEqual([]);
  });

  it('times out and tears down an exact fresh session when no gate consumes the release token', () => {
    state.releaseBehavior = 'leave';
    let now = Date.now();
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => {
      now += 1_000;
      return now;
    });
    try {
      expect(() => spawnBackend())
        .toThrow(/CLI release 未被稳定 launch 子进程确认/);
    } finally {
      nowSpy.mockRestore();
    }

    expect(state.exists).toBe(false);
    expect(childMocks.execFileSync.mock.calls.some(([, argv]) =>
      argv[0] === 'kill' && argv[1] === SESSION && argv[2] === '--force',
    )).toBe(true);
    expect(state.sendInputs).toEqual([]);
  });

  it('refuses to reattach a fully labelled generation that is still waiting at the private gate', () => {
    state.exists = true;
    state.command = '/bin/sh private-gate';
    state.transport = 'tail-send-v1';
    state.sessionId = SESSION_ID;
    state.launchParentPid = state.pid;
    state.launchCommand =
      `sh -c gate botmux-zmx-private-release-gate-v1:${state.gateNonce}`;

    const probe = ZmxBackend.probeManagedSession(SESSION, SESSION_ID);
    expect(probe).toMatchObject({
      state: 'unknown',
      reason: expect.stringMatching(/仍在等待私有启动门禁放行/),
    });

    expect(() => spawnBackend(makeBackend({ reattach: true })))
      .toThrow(/仍在等待私有启动门禁放行/);
    expect(() => ZmxBackend.killManagedSession(SESSION, SESSION_ID))
      .toThrow(/仍在等待私有启动门禁放行/);
    expect(state.exists).toBe(true);
    expect(childMocks.execFileSync.mock.calls.some(([, argv]) => argv[0] === 'kill'))
      .toBe(false);
    expect(state.sendInputs).toEqual([]);
  });

  it('does not trust fully stamped same-name pollution whose launch PID is not a child', () => {
    state.exists = true;
    state.pid = process.pid;
    state.command = '/usr/bin/foreign-agent';
    state.transport = 'tail-send-v1';
    state.sessionId = SESSION_ID;
    state.launchParentPid = process.ppid;
    state.launchCommand = '/usr/bin/foreign-agent';

    const probe = ZmxBackend.probeManagedSession(SESSION, SESSION_ID);
    expect(probe).toMatchObject({
      state: 'unknown',
      reason: expect.stringMatching(/launch PID 标签无效或已脱离 PTY root/),
    });
    expect(() => ZmxBackend.killManagedSession(SESSION, SESSION_ID))
      .toThrow(/launch PID 标签无效或已脱离 PTY root/);
    expect(state.exists).toBe(true);
    expect(childMocks.execFileSync.mock.calls.some(([, argv]) => argv[0] === 'kill'))
      .toBe(false);
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
    const fence = backend.captureAmbiguousSubmissionFence();

    state.failSendAt = 1;
    expect(backend.sendText('short input')).toBe(false);
    expect(state.sendInputs).toHaveLength(1);
    expect(state.sendInputs[0]!.subarray(0, -1).toString()).toBe('short input');

    state.failSendAt = null;
    expect(backend.cancelAmbiguousSubmission(fence)).toBe('recovery-unconfirmed');
    expect(backend.sendText('must remain blocked')).toBe(false);

    const controlBackend = spawnBackend(makeBackend({ reattach: true }));
    state.sendInputs.length = 0;
    state.failSendAt = 1;
    expect(controlBackend.sendSpecialKeys('Enter')).toBe(false);
    expect(state.sendInputs).toHaveLength(1);
    expect(state.sendInputs[0]!.subarray(0, -1).toString()).toBe('\r');
  });

  it('attempts cancellation and freezes a logical prompt whose later sendText fails ambiguously', () => {
    const backend = spawnBackend();
    const fence = backend.captureAmbiguousSubmissionFence();

    expect(backend.sendText('first confirmed chunk')).toBe(true);
    expect(backend.sendText('second confirmed chunk')).toBe(true);
    state.failSendAt = 3;
    expect(backend.sendText('ambiguous third chunk')).toBe(false);
    expect(state.sendInputs).toHaveLength(3);

    expect(backend.cancelAmbiguousSubmission(fence)).toBe('recovery-unconfirmed');
    expect(state.sendInputs).toHaveLength(4);
    expect(state.sendInputs[3]!.toString()).toBe('\x03\n');

    expect(backend.cancelAmbiguousSubmission(fence)).toBe('recovery-unconfirmed');
    expect(backend.sendText('must remain blocked')).toBe(false);
    expect(state.sendInputs).toHaveLength(4);
  });

  it.each([
    ['stdout rejection', false],
    ['timeout', true],
  ] as const)(
    'keeps cancellation debt after %s when the post-send identity probe is unknown',
    (_failureKind, throwOnFailedSend) => {
      const backend = spawnBackend();
      const fence = backend.captureAmbiguousSubmissionFence();

      state.failSendAt = 1;
      state.throwOnFailedSend = throwOnFailedSend;
      state.failGetsAfterSend = 1;
      expect(backend.sendText('ambiguous prompt')).toBe(false);
      expect(state.failedGetAfterSendCount).toBe(1);

      state.failSendAt = null;
      state.throwOnFailedSend = false;
      expect(backend.cancelAmbiguousSubmission(fence)).toBe('recovery-unconfirmed');
      expect(state.sendInputs.map(input => input.toString())).toEqual([
        'ambiguous prompt\n',
        '\x03\n',
      ]);
      expect(backend.sendText('must remain blocked')).toBe(false);
      expect(state.sendInputs).toHaveLength(2);
    },
  );

  it('keeps text blocked when both post-send and cancellation probes are unknown', () => {
    const backend = spawnBackend();
    const fence = backend.captureAmbiguousSubmissionFence();

    state.failSendAt = 1;
    state.failGetsAfterSend = 2;
    expect(backend.sendText('ambiguous prompt')).toBe(false);
    expect(backend.cancelAmbiguousSubmission(fence)).toBe('recovery-pending');
    expect(state.failedGetAfterSendCount).toBe(2);

    state.failSendAt = null;
    expect(backend.sendText('must not append')).toBe(false);
    expect(state.sendInputs.map(input => input.toString())).toEqual([
      'ambiguous prompt\n',
    ]);
  });

  it('remembers to close bracketed paste when the post-send probe is unknown', () => {
    const backend = spawnBackend();
    const fence = backend.captureAmbiguousSubmissionFence();

    state.failSendAt = 1;
    state.failGetsAfterSend = 1;
    expect(() => backend.pasteText('ambiguous paste')).toThrow(/粘贴发送失败/);
    expect(state.failedGetAfterSendCount).toBe(1);

    state.failSendAt = null;
    expect(backend.cancelAmbiguousSubmission(fence)).toBe('recovery-unconfirmed');
    expect(state.sendInputs).toHaveLength(2);
    expect(state.sendInputs[0]!.subarray(0, 6).toString()).toBe('\x1b[200~');
    expect(state.sendInputs[1]!.toString()).toBe('\x1b[201~\x03\n');
    expect(backend.sendText('must remain blocked')).toBe(false);
    expect(state.sendInputs).toHaveLength(2);
  });

  it('closes a possibly open paste before an explicit recovery Ctrl+C', () => {
    const backend = spawnBackend();

    state.failSendAt = 1;
    state.failGetsAfterSend = 1;
    expect(() => backend.pasteText('ambiguous paste')).toThrow(/粘贴发送失败/);

    state.failSendAt = null;
    expect(backend.sendSpecialKeys('C-c')).toBe(false);
    expect(state.sendInputs).toHaveLength(2);
    expect(state.sendInputs[1]!.toString()).toBe('\x1b[201~\x03\n');
    expect(() => backend.captureAmbiguousSubmissionFence())
      .toThrow(/recovery-unconfirmed/);
    expect(backend.sendText('must remain blocked')).toBe(false);
    expect(state.sendInputs).toHaveLength(2);
  });

  it('does not treat a combined control payload as recovery Ctrl+C', () => {
    const backend = spawnBackend();
    const fence = backend.captureAmbiguousSubmissionFence();

    state.failSendAt = 1;
    expect(backend.sendText('ambiguous prompt')).toBe(false);
    state.failSendAt = null;
    expect(backend.sendSpecialKeys('Enter', 'C-c')).toBe(false);
    expect(state.sendInputs).toHaveLength(1);

    expect(backend.cancelAmbiguousSubmission(fence)).toBe('recovery-unconfirmed');
    expect(state.sendInputs[1]!.toString()).toBe('\x03\n');
    expect(backend.sendText('must remain blocked')).toBe(false);
    expect(state.sendInputs).toHaveLength(2);
  });

  it.each([
    ['abnormal stdout', false],
    ['timeout', true],
  ] as const)(
    'poisons further input when partial-send recovery has %s',
    (_failureKind, throwOnFailedSend) => {
      const backend = spawnBackend();
      const fence = backend.captureAmbiguousSubmissionFence();

      state.failSendAt = 1;
      expect(backend.sendText('ambiguous prompt')).toBe(false);

      state.failSendAt = 2;
      state.throwOnFailedSend = throwOnFailedSend;
      expect(backend.cancelAmbiguousSubmission(fence)).toBe('recovery-unconfirmed');
      expect(state.sendInputs.map(input => input.toString())).toEqual([
        'ambiguous prompt\n',
        '\x03\n',
      ]);

      state.failSendAt = null;
      state.throwOnFailedSend = false;
      expect(backend.sendText('must not append')).toBe(false);
      expect(backend.sendSpecialKeys('C-c')).toBe(false);
      expect(backend.cancelAmbiguousSubmission(fence)).toBe('recovery-unconfirmed');
      expect(state.sendInputs.map(input => input.toString())).toEqual([
        'ambiguous prompt\n',
        '\x03\n',
      ]);
    },
  );

  it.each([
    ['abnormal stdout', false],
    ['timeout', true],
  ] as const)(
    'poisons an explicit recovery Ctrl+C after %s',
    (_failureKind, throwOnFailedSend) => {
      const backend = spawnBackend();
      const fence = backend.captureAmbiguousSubmissionFence();

      state.failSendAt = 1;
      expect(backend.sendText('ambiguous prompt')).toBe(false);

      state.failSendAt = 2;
      state.throwOnFailedSend = throwOnFailedSend;
      expect(backend.sendSpecialKeys('C-c')).toBe(false);
      expect(backend.cancelAmbiguousSubmission(fence)).toBe('recovery-unconfirmed');

      state.failSendAt = null;
      state.throwOnFailedSend = false;
      expect(backend.sendText('must not append')).toBe(false);
      expect(state.sendInputs.map(input => input.toString())).toEqual([
        'ambiguous prompt\n',
        '\x03\n',
      ]);
    },
  );

  it.each([
    ['pending debt', false],
    ['unconfirmed recovery', true],
  ] as const)(
    'restores %s as poison when a new worker reattaches',
    (_journalState, attemptRecovery) => {
      const recoveryStateDir = makeRecoveryStateDir();
      const first = spawnBackend(makeBackend({ recoveryStateDir }));
      const fence = first.captureAmbiguousSubmissionFence();

      state.failSendAt = 1;
      expect(first.sendText('ambiguous prompt')).toBe(false);
      if (attemptRecovery) {
        state.failSendAt = 2;
        expect(first.cancelAmbiguousSubmission(fence)).toBe('recovery-unconfirmed');
      }
      first.kill();

      state.failSendAt = null;
      const reattached = spawnBackend(makeBackend({
        reattach: true,
        recoveryStateDir,
      }));
      expect(reattached.sendText('must remain blocked')).toBe(false);
      expect(() => reattached.captureAmbiguousSubmissionFence())
        .toThrow(/recovery-unconfirmed/);
      expect(state.sendInputs.map(input => input.toString())).toEqual(
        attemptRecovery
          ? ['ambiguous prompt\n', '\x03\n']
          : ['ambiguous prompt\n'],
      );
    },
  );

  it('write-ahead arms before every chunk can return and a crash observer stays poisoned', () => {
    const recoveryStateDir = makeRecoveryStateDir();
    const first = spawnBackend(makeBackend({ recoveryStateDir }));
    const originalExecFileSync = childMocks.execFileSync.getMockImplementation()!;
    const observedStates: string[] = [];
    let crashObserver: ZmxBackend | undefined;
    childMocks.execFileSync.mockImplementation((...args: any[]) => {
      const result = originalExecFileSync(...args);
      if (args[1]?.[0] === 'send') {
        observedStates.push(readRecoveryState(recoveryStateDir).state);
        crashObserver ??= makeBackend({
          reattach: true,
          recoveryStateDir,
        });
      }
      return result;
    });

    try {
      expect(first.sendText('x'.repeat(2_049))).toBe(true);
    } finally {
      childMocks.execFileSync.mockImplementation(originalExecFileSync);
    }

    expect(observedStates).toEqual(['pending', 'pending', 'pending']);
    expect(readRecoveryState(recoveryStateDir)).toMatchObject({
      version: 1,
      sessionId: SESSION_ID,
      state: 'clean',
    });

    spawnBackend(crashObserver!);
    expect(crashObserver!.sendText('must remain blocked')).toBe(false);
    expect(() => crashObserver!.captureAmbiguousSubmissionFence())
      .toThrow(/recovery-unconfirmed/);
    expect(state.sendInputs).toHaveLength(3);
  });

  it('keeps one journal transaction pending across adapter chunks until logical confirmation', () => {
    const recoveryStateDir = makeRecoveryStateDir();
    const backend = spawnBackend(makeBackend({ recoveryStateDir }));
    const persistedStates: string[] = [];
    const persist = (backend as any).writeComposerRecoveryState.bind(backend);
    vi.spyOn(backend as any, 'writeComposerRecoveryState').mockImplementation(
      (nextState: string) => {
        persistedStates.push(nextState);
        return persist(nextState);
      },
    );

    const fence = backend.captureAmbiguousSubmissionFence();
    expect(readRecoveryState(recoveryStateDir).state).toBe('pending');
    expect(backend.sendText('first adapter chunk')).toBe(true);
    expect(readRecoveryState(recoveryStateDir).state).toBe('pending');

    const crashObserver = makeBackend({
      reattach: true,
      recoveryStateDir,
    });
    expect(() => crashObserver.captureAmbiguousSubmissionFence())
      .toThrow(/recovery-unconfirmed/);

    expect(backend.sendText('second adapter chunk')).toBe(true);
    expect(backend.sendSpecialKeys('Enter')).toBe(true);
    expect(readRecoveryState(recoveryStateDir).state).toBe('pending');
    expect(backend.confirmAmbiguousSubmission(fence)).toBeUndefined();
    expect(readRecoveryState(recoveryStateDir).state).toBe('clean');
    expect(persistedStates).toEqual(['pending', 'clean']);
  });

  it.each([
    ['abnormal stdout', false],
    ['timeout', true],
  ] as const)(
    'poisons a logical submission when its Enter has %s',
    (_failureKind, throwOnFailedSend) => {
      const recoveryStateDir = makeRecoveryStateDir();
      const backend = spawnBackend(makeBackend({ recoveryStateDir }));
      const fence = backend.captureAmbiguousSubmissionFence();

      expect(backend.sendText('fully typed prompt')).toBe(true);
      state.failSendAt = 2;
      state.throwOnFailedSend = throwOnFailedSend;
      expect(backend.sendSpecialKeys('Enter')).toBe(false);
      expect(backend.cancelAmbiguousSubmission(fence)).toBe('recovery-unconfirmed');

      state.failSendAt = null;
      state.throwOnFailedSend = false;
      expect(backend.sendText('must not append or replay')).toBe(false);
      expect(backend.sendSpecialKeys('C-c')).toBe(false);
      expect(state.sendInputs.map(input => input.toString())).toEqual([
        'fully typed prompt\n',
        '\r\n',
      ]);

      const reattached = makeBackend({
        reattach: true,
        recoveryStateDir,
      });
      expect(() => reattached.captureAmbiguousSubmissionFence())
        .toThrow(/recovery-unconfirmed/);
    },
  );

  it('does not inject Ctrl+C after a submit key landed but the adapter later threw', () => {
    const backend = spawnBackend();
    const fence = backend.captureAmbiguousSubmissionFence();

    expect(backend.sendText('possibly submitted prompt')).toBe(true);
    expect(backend.sendSpecialKeys('Enter')).toBe(true);
    expect(backend.cancelAmbiguousSubmission(fence)).toBe('recovery-unconfirmed');
    expect(state.sendInputs.map(input => input.toString())).toEqual([
      'possibly submitted prompt\n',
      '\r\n',
    ]);
    expect(backend.sendText('must remain blocked')).toBe(false);
  });

  it('does not touch ZMX when the write-ahead pending state cannot be persisted', () => {
    const recoveryStateDir = makeRecoveryStateDir();
    const backend = spawnBackend(makeBackend({ recoveryStateDir }));
    vi.spyOn(backend as any, 'writeComposerRecoveryState').mockReturnValueOnce(false);
    expect(() => backend.captureAmbiguousSubmissionFence())
      .toThrow(/recovery-unconfirmed/);
    expect(state.sendInputs).toEqual([]);
    expect(backend.sendSpecialKeys('Enter')).toBe(false);
    expect(state.sendInputs).toEqual([]);
  });

  it('keeps pending durable and poisons reattach when the success clear cannot persist', () => {
    const recoveryStateDir = makeRecoveryStateDir();
    const first = spawnBackend(makeBackend({ recoveryStateDir }));
    const persist = (first as any).writeComposerRecoveryState.bind(first);
    vi.spyOn(first as any, 'writeComposerRecoveryState').mockImplementation(
      (nextState: string) => nextState === 'clean' ? false : persist(nextState),
    );

    expect(first.sendText('transport accepted but journal clear failed')).toBe(false);
    expect(state.sendInputs).toHaveLength(1);
    expect(readRecoveryState(recoveryStateDir).state).toBe('pending');
    expect(() => first.captureAmbiguousSubmissionFence())
      .toThrow(/recovery-unconfirmed/);

    const reattached = spawnBackend(makeBackend({
      reattach: true,
      recoveryStateDir,
    }));
    expect(reattached.sendText('must remain blocked')).toBe(false);
    expect(state.sendInputs).toHaveLength(1);
  });

  it('fails closed on an unknown recovery journal schema version', () => {
    const recoveryStateDir = makeRecoveryStateDir();
    mkdirSync(join(recoveryStateDir, 'zmx-composer-recovery'), {
      recursive: true,
      mode: 0o700,
    });
    writeFileSync(
      recoveryStatePath(recoveryStateDir),
      `${JSON.stringify({
        version: 2,
        sessionId: SESSION_ID,
        state: 'clean',
      })}\n`,
      { mode: 0o600 },
    );

    const reattached = makeBackend({
      reattach: true,
      recoveryStateDir,
    });
    expect(() => reattached.captureAmbiguousSubmissionFence())
      .toThrow(/recovery-unconfirmed/);
    expect(state.sendInputs).toEqual([]);
  });

  it('clears a stale recovery journal only after creating a fresh session', () => {
    const recoveryStateDir = makeRecoveryStateDir();
    const first = spawnBackend(makeBackend({ recoveryStateDir }));
    const fence = first.captureAmbiguousSubmissionFence();

    state.failSendAt = 1;
    expect(first.sendText('ambiguous prompt')).toBe(false);
    state.failSendAt = 2;
    expect(first.cancelAmbiguousSubmission(fence)).toBe('recovery-unconfirmed');
    first.kill();

    state.exists = false;
    state.clients = 0;
    state.failSendAt = null;
    const fresh = spawnBackend(makeBackend({ recoveryStateDir }));
    expect(fresh.sendText('safe fresh prompt')).toBe(true);
    expect(state.sendInputs.at(-1)!.toString()).toBe('safe fresh prompt\n');
  });

  it('persists a clean fresh journal before publishing the CLI release token', () => {
    const recoveryStateDir = makeRecoveryStateDir();
    const backend = makeBackend({ recoveryStateDir });
    let releaseExistedAtReset = true;
    vi.spyOn(backend as any, 'resetAmbiguousRecoveryForFreshSession')
      .mockImplementation(() => {
        releaseExistedAtReset = state.releasePath
          ? existsSync(state.releasePath)
          : true;
        throw new Error('simulated journal reset failure');
      });

    expect(() => spawnBackend(backend)).toThrow(/simulated journal reset failure/);
    expect(releaseExistedAtReset).toBe(false);
    expect(state.exists).toBe(false);
    expect(childMocks.execFileSync.mock.calls.some(([, argv]) =>
      argv[0] === 'kill' && argv[1] === SESSION && argv[2] === '--force',
    )).toBe(true);
    expect(state.sendInputs).toEqual([]);
  });

  it.each([
    ['complete session identity', () => { state.sessionId = 'replacement-session-id'; }],
    ['PTY root PID', () => { state.pid += 1; }],
  ] as const)('does not tear down a pre-release same-name replacement with changed %s', (
    _replacementKind,
    replace,
  ) => {
    const recoveryStateDir = makeRecoveryStateDir();
    const backend = makeBackend({ recoveryStateDir });
    vi.spyOn(backend as any, 'resetAmbiguousRecoveryForFreshSession')
      .mockImplementation(() => {
        replace();
        throw new Error('simulated journal reset failure after replacement');
      });

    expect(() => spawnBackend(backend))
      .toThrow(/simulated journal reset failure after replacement/);
    expect(state.exists).toBe(true);
    expect(childMocks.execFileSync.mock.calls.some(([, argv]) => argv[0] === 'kill'))
      .toBe(false);
    expect(state.sendInputs).toEqual([]);
  });

  it('tears down an exact gate when protocol labels commit before zmx set times out', () => {
    const recoveryStateDir = makeRecoveryStateDir();
    const backend = makeBackend({ recoveryStateDir });
    const runZmx = childMocks.execFileSync.getMockImplementation()!;
    childMocks.execFileSync.mockImplementation((...args: any[]) => {
      const result = runZmx(...args);
      if (args[1]?.[0] === 'set') {
        throw Object.assign(new Error('simulated zmx set timeout after commit'), {
          code: 'ETIMEDOUT',
        });
      }
      return result;
    });

    expect(() => spawnBackend(backend))
      .toThrow(/simulated zmx set timeout after commit/);
    expect(state.exists).toBe(false);
    expect(childMocks.execFileSync.mock.calls.some(([, argv]) =>
      argv[0] === 'kill' && argv[1] === SESSION && argv[2] === '--force',
    )).toBe(true);
    expect(state.sendInputs).toEqual([]);
  });

  it.each([
    [
      'partial labels',
      () => {
        state.transport = 'tail-send-v1';
      },
    ],
    [
      'same-name replacement identity and PID',
      () => {
        state.transport = 'tail-send-v1';
        state.sessionId = 'replacement-session-id';
        state.pid += 1;
      },
    ],
  ] as const)('does not tear down %s after an ambiguous protocol stamp', (
    _failureKind,
    applyAmbiguousStamp,
  ) => {
    const recoveryStateDir = makeRecoveryStateDir();
    const backend = makeBackend({ recoveryStateDir });
    const runZmx = childMocks.execFileSync.getMockImplementation()!;
    childMocks.execFileSync.mockImplementation((...args: any[]) => {
      if (args[1]?.[0] === 'set') {
        applyAmbiguousStamp();
        throw Object.assign(new Error('simulated ambiguous zmx set failure'), {
          code: 'ETIMEDOUT',
        });
      }
      return runZmx(...args);
    });

    expect(() => spawnBackend(backend))
      .toThrow(/simulated ambiguous zmx set failure/);
    expect(state.exists).toBe(true);
    expect(childMocks.execFileSync.mock.calls.some(([, argv]) => argv[0] === 'kill'))
      .toBe(false);
    expect(state.sendInputs).toEqual([]);
  });

  it('fsyncs the recovery root only when first publishing the journal directory', () => {
    const recoveryStateDir = makeRecoveryStateDir();
    const backend = spawnBackend(makeBackend({ recoveryStateDir }));

    expect(durabilityMocks.fsyncDirectorySyncPortable)
      .toHaveBeenCalledTimes(1);
    expect(durabilityMocks.fsyncDirectorySyncPortable)
      .toHaveBeenCalledWith(recoveryStateDir);

    const fence = backend.captureAmbiguousSubmissionFence();
    expect(backend.cancelAmbiguousSubmission(fence)).toBeUndefined();
    expect(durabilityMocks.fsyncDirectorySyncPortable)
      .toHaveBeenCalledTimes(1);
  });

  it('does not publish the CLI release or write a WAL when recovery-root fsync fails', () => {
    const recoveryStateDir = makeRecoveryStateDir();
    let releaseExistedAtFsync = true;
    durabilityMocks.fsyncDirectorySyncPortable.mockImplementationOnce(() => {
      releaseExistedAtFsync = state.releasePath
        ? existsSync(state.releasePath)
        : true;
      throw Object.assign(new Error('simulated parent fsync failure'), {
        code: 'EIO',
      });
    });

    expect(() => spawnBackend(makeBackend({ recoveryStateDir })))
      .toThrow(/journal could not be reset/);
    expect(releaseExistedAtFsync).toBe(false);
    expect(existsSync(join(recoveryStateDir, 'zmx-composer-recovery')))
      .toBe(false);
    expect(existsSync(recoveryStatePath(recoveryStateDir))).toBe(false);
    expect(state.sendInputs).toEqual([]);
  });

  it('poisons a stale confirmation fence instead of committing the active generation', () => {
    const recoveryStateDir = makeRecoveryStateDir();
    const backend = spawnBackend(makeBackend({ recoveryStateDir }));
    const fence = backend.captureAmbiguousSubmissionFence();

    expect(backend.sendText('active prompt')).toBe(true);
    expect(backend.confirmAmbiguousSubmission(fence + 1))
      .toBe('recovery-unconfirmed');
    expect(readRecoveryState(recoveryStateDir).state).toBe('unconfirmed');
    expect(backend.sendText('must remain blocked')).toBe(false);
    expect(state.sendInputs.map(input => input.toString())).toEqual([
      'active prompt\n',
    ]);
  });

  it('poisons a stale cancellation fence without aborting the active generation', () => {
    const recoveryStateDir = makeRecoveryStateDir();
    const backend = spawnBackend(makeBackend({ recoveryStateDir }));
    const fence = backend.captureAmbiguousSubmissionFence();

    expect(backend.cancelAmbiguousSubmission(fence + 1))
      .toBe('recovery-unconfirmed');
    expect(readRecoveryState(recoveryStateDir).state).toBe('unconfirmed');
    expect(state.sendInputs).toEqual([]);
    expect(backend.sendSpecialKeys('C-c')).toBe(false);
    expect(state.sendInputs).toEqual([]);
  });

  it('keeps a successful-looking recovery Ctrl+C sticky and refuses later input', () => {
    const backend = spawnBackend();
    const fence = backend.captureAmbiguousSubmissionFence();

    state.failSendAt = 1;
    expect(backend.sendText('ambiguous prompt')).toBe(false);
    state.failSendAt = null;
    expect(backend.sendSpecialKeys('C-c')).toBe(false);
    expect(backend.cancelAmbiguousSubmission(fence)).toBe('recovery-unconfirmed');

    expect(state.sendInputs.map(input => input.toString())).toEqual([
      'ambiguous prompt\n',
      '\x03\n',
    ]);
    expect(backend.sendText('must remain blocked')).toBe(false);
    expect(backend.sendSpecialKeys('C-c')).toBe(false);
    expect(state.sendInputs).toHaveLength(2);
  });

  it('does not cancel a failed control key as though it were prompt text', () => {
    const backend = spawnBackend();
    const fence = backend.captureAmbiguousSubmissionFence();
    state.failSendAt = 1;

    expect(backend.sendSpecialKeys('Enter')).toBe(false);
    backend.cancelAmbiguousSubmission(fence);

    expect(state.sendInputs).toHaveLength(1);
    expect(state.sendInputs[0]!.toString()).toBe('\r\n');
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

  it('closes an explicit bracketed paste prefix delivered through sendText', () => {
    const backend = spawnBackend();
    state.failSendAt = 2;
    const ompStylePaste = `\x1b[200~${'中'.repeat(512)}\x1b[201~`;

    expect(backend.sendText(ompStylePaste)).toBe(false);
    expect(state.sendInputs).toHaveLength(3);
    expect(state.sendInputs[0]!.subarray(0, 6).toString()).toBe('\x1b[200~');
    expect(state.sendInputs[2]!.toString()).toBe('\x1b[201~\x03\n');
  });

  it.each([
    { failure: 'stdout rejection', throwOnFailedSend: false },
    { failure: 'thrown transport error', throwOnFailedSend: true },
  ])(
    'closes a possibly delivered sendText paste when its first frame has a $failure',
    ({ throwOnFailedSend }) => {
      const backend = spawnBackend();
      state.failSendAt = 1;
      state.throwOnFailedSend = throwOnFailedSend;
      const ompStylePaste = `\x1b[200~${'中'.repeat(512)}\x1b[201~`;

      expect(backend.sendText(ompStylePaste)).toBe(false);
      expect(state.sendInputs).toHaveLength(2);
      expect(state.sendInputs[0]!.subarray(0, 6).toString()).toBe('\x1b[200~');
      expect(state.sendInputs[1]!.toString()).toBe('\x1b[201~\x03\n');
    },
  );

  it('deduplicates logical recovery after frame recovery already injected Ctrl+C', () => {
    const backend = spawnBackend();
    const fence = backend.captureAmbiguousSubmissionFence();
    state.failSendAt = 1;
    const ompStylePaste = `\x1b[200~${'中'.repeat(512)}\x1b[201~`;

    expect(backend.sendText(ompStylePaste)).toBe(false);
    expect(state.sendInputs).toHaveLength(2);
    expect(state.sendInputs[1]!.toString()).toBe('\x1b[201~\x03\n');

    backend.cancelAmbiguousSubmission(fence);
    expect(state.sendInputs).toHaveLength(2);
  });

  it('does not start another paste generation after frame recovery is unconfirmed', () => {
    const backend = spawnBackend();
    const ompStylePaste = `\x1b[200~${'中'.repeat(512)}\x1b[201~`;

    state.failSendAt = 1;
    expect(backend.sendText(ompStylePaste)).toBe(false);
    state.failSendAt = 3;
    expect(backend.sendText(ompStylePaste)).toBe(false);

    expect(state.sendInputs).toHaveLength(2);
    expect(state.sendInputs[1]!.toString()).toBe('\x1b[201~\x03\n');
  });

  it('detects an opening paste marker split across an ambiguous chunk boundary', () => {
    const backend = spawnBackend();
    state.failSendAt = 2;
    const splitMarkerPaste = `${'x'.repeat(1_021)}\x1b[200~${'y'.repeat(1_021)}\x1b[201~`;

    expect(backend.sendText(splitMarkerPaste)).toBe(false);
    expect(state.sendInputs).toHaveLength(3);
    expect(state.sendInputs[0]!.subarray(-4).toString()).toBe('\x1b[2\n');
    expect(state.sendInputs[1]!.subarray(0, 3).toString()).toBe('00~');
    expect(state.sendInputs[2]!.toString()).toBe('\x1b[201~\x03\n');
  });

  it('keeps marker-dense maximum-size recovery analysis bounded', () => {
    const backend = spawnBackend();
    const closingMarker = '\x1b[201~';
    const markerDenseInput = closingMarker.repeat(
      Math.floor((64 * 1_024) / Buffer.byteLength(closingMarker)),
    );
    const startedAt = performance.now();

    expect(backend.sendText(markerDenseInput)).toBe(true);
    expect(performance.now() - startedAt).toBeLessThan(1_000);
    expect(state.sendInputs).toHaveLength(Math.ceil(Buffer.byteLength(markerDenseInput) / 1_024));
  });

  it('does not inject partial-send recovery into a replacement session', () => {
    const backend = spawnBackend();
    state.failSendAt = 2;
    state.replaceOnFailedSend = true;

    expect(() => backend.pasteText('x'.repeat(2_000))).toThrow(/粘贴发送失败/);
    expect(state.sendInputs).toHaveLength(2);
    expect(state.sendInputs[0]!.subarray(0, 6).toString()).toBe('\x1b[200~');
    expect(state.sendInputs).not.toContainEqual(Buffer.from('\x1b[201~\x03\n'));
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

  // zmx's `clients=` is an aggregate: a user's `zmx attach` and botmux's own
  // `tail` are indistinguishable. The old check required the count to RISE
  // above a pre-tail baseline, so a user detaching while our tail connected
  // left a net delta of 0 and a healthy session failed to restore.
  it('reattaches when a concurrent client detaches as our tail connects (net client delta 0)', () => {
    state.exists = true;
    state.command = '/bin/sh -c echo ready';
    state.transport = 'tail-send-v1';
    state.sessionId = SESSION_ID;
    // A user is attached at probe time — this was the old baseline.
    state.clients = 1;

    const inner = childMocks.spawn.getMockImplementation()!;
    childMocks.spawn.mockImplementation((file: string, argv: string[], options?: any) => {
      const child = inner(file, argv, options);
      // The user detached in the same window our tail attached: one client
      // leaves, one joins, so the count never exceeds the baseline.
      if (argv[0] === 'tail') state.clients = 1;
      return child;
    });

    const backend = makeBackend({ reattach: true });
    expect(() => spawnBackend(backend)).not.toThrow();
    expect(tailChildren()).toHaveLength(1);
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
