import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { connect, type Socket } from 'node:net';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { runWecomCommand } from '../src/im/wecom/gateway/command.js';
import { readWecomRuntime } from '../src/im/wecom/config/runtime.js';
import { wecomConfigId } from '../src/im/wecom/config/discovery.js';
import {
  readWecomFleetDesiredState,
  setWecomFleetDesiredState,
  wecomFleetDesiredStatePath,
} from '../src/im/wecom/config/fleet-desired-state.js';
import {
  WECOM_GATEWAY_DRAIN_BUDGET_MS,
  WECOM_GATEWAY_KILL_TIMEOUT_MS,
  WECOM_GATEWAY_SHUTDOWN_MAX_MS,
  WECOM_MANAGED_CORE_KILL_WAIT_MS,
  WECOM_MANAGED_CORE_STOP_GRACE_MS,
} from '../src/im/wecom/config/gateway-budgets.js';
import { WECOM_GATEWAY_CONTROL_PATHS } from '../src/im/wecom/contract/gateway-control.js';
import { WECOM_GATEWAY_NO_RESTART_EXIT_CODE } from '../src/im/wecom/contract/fleet-member.js';
import { FLEET_DAEMON_KILL_SLACK_MS } from '../src/core/shutdown-budgets.js';
import { spawnTsEvalWithRepoImports } from './helpers/ts-runner.js';
import { releaseWecomCorePorts, reserveWecomCorePort } from './helpers/wecom-core-port.js';

/**
 * A gateway's shutdown stops its core and drains its in-flight work at the
 * same time: the core is told to stop the moment the shutdown begins, and
 * after the drain the gateway waits for that same stop. The gateway's
 * shutdown budget (config/gateway-budgets.ts) — and with it the supervisor's
 * kill timeout and the fleet's stop wait under systemd's 90 s — counts on that.
 * Were the core only stopped once the drain is over, a shutdown would take the
 * drain plus the core's whole stop and run past the supervisor's SIGKILL.
 *
 * Real gateway code with production budgets; the WeCom socket and the core are
 * stand-ins (the core ignores SIGTERM). Once the gateway is up the clock is a
 * fake one, advanced from timer to timer, and a control request that never
 * sends its body keeps the drain busy for its whole budget.
 */

const SECRET_ENV = 'OVERLAP_WECOM_SECRET';
const cleanups: Array<() => unknown> = [];

afterEach(async () => {
  vi.useRealTimers();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  await releaseWecomCorePorts();
});

class FakeSocket extends EventEmitter {
  constructor(private readonly subscribeErrcode = 0) {
    super();
  }
  send(data: string, callback?: (error?: Error) => void) {
    const frame = JSON.parse(data);
    callback?.();
    const errcode = frame.cmd === 'aibot_subscribe' ? this.subscribeErrcode : 0;
    queueMicrotask(() => this.emit('message', Buffer.from(JSON.stringify({ headers: frame.headers, errcode }))));
  }
  terminate() {
    this.emit('close');
  }
}

let nextPid = 1_900_000_000;

/** A core child that ignores SIGTERM; on SIGKILL it goes (`exit`), or not even then (`stuck`). */
class FakeCore extends EventEmitter {
  readonly pid = nextPid++;
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly signals: Array<{ signal: string; at: number; desired: string }> = [];
  constructor(private readonly onSigkill: 'exit' | 'stuck', private readonly desiredNow: () => string, private readonly onSigterm: 'ignore' | 'exit' = 'ignore') {
    super();
  }
  kill(signal: NodeJS.Signals = 'SIGTERM') {
    this.signals.push({ signal, at: Date.now(), desired: this.desiredNow() });
    if ((signal === 'SIGKILL' && this.onSigkill === 'exit') || (signal === 'SIGTERM' && this.onSigterm === 'exit')) {
      queueMicrotask(() => this.die(signal));
    }
    return true;
  }
  die(signal: NodeJS.Signals | null, code: number | null = null) {
    if (this.exitCode !== null || this.signalCode !== null) return;
    this.exitCode = code;
    this.signalCode = signal;
    this.emit('exit', code, signal);
    this.stdout.end();
    this.stderr.end();
  }
}

type Event = 'SIGTERM' | 'uncaughtException';

async function startGateway(options: { onSigkill: 'exit' | 'stuck'; onSigterm?: 'ignore' | 'exit'; subscribeErrcode?: number }) {
  const root = mkdtempSync(join(tmpdir(), 'wecom-overlap-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const port = await reserveWecomCorePort();
  const botId = `overlap-${process.pid}-${nextPid}`;
  const file = join(root, 'config.json');
  writeFileSync(file, JSON.stringify({
    botId,
    secretEnv: SECRET_ENV,
    coreUrl: `http://127.0.0.1:${port}`,
    allowedUsers: ['alice'],
    stateDir: root,
    managedCore: { botId: 'local_overlap', cli: 'codex', backend: 'pty', port, workingDirectory: root, stateDir: join(root, 'core-state') },
  }));
  const configId = wecomConfigId(file);
  setWecomFleetDesiredState(configId, 'running');
  const desiredNow = () => {
    const snapshot = readWecomFleetDesiredState();
    const record = snapshot.status === 'ok' ? snapshot.connections.get(configId) : undefined;
    return record ? [record.desired, record.reason].filter(Boolean).join('/') : 'none';
  };
  vi.stubEnv(SECRET_ENV, 'fake-secret');
  vi.stubEnv('BOTMUX_WECOM_FLEET_MEMBER', 'wecom-overlap');
  const before = new Map((['SIGTERM', 'uncaughtException'] as const).map(event => [event, new Set(process.listeners(event))]));
  const run: { socket?: FakeSocket; core?: FakeCore; ended?: { code: number; at: number }; fatalExitAt?: number } = {};
  const running = runWecomCommand(['--config', file], {
    socketFactory: () => {
      run.socket = new FakeSocket(options.subscribeErrcode);
      return run.socket as never;
    },
    coreSpawn: () => {
      run.core = new FakeCore(options.onSigkill, desiredNow, options.onSigterm);
      return run.core as never;
    },
    fatalExit: () => {
      run.fatalExitAt ??= Date.now();
    },
  });
  void running.then(code => {
    run.ended = { code, at: Date.now() };
  });
  /** The gateway's own listener for `event` (installed while it runs). */
  const listener = (event: Event) => {
    const added = (process.listeners(event) as Array<(...args: unknown[]) => void>).filter(fn => !before.get(event)!.has(fn as never));
    expect(added).toHaveLength(1);
    return added[0];
  };
  cleanups.push(async () => {
    run.core?.die('SIGKILL');
    if (!run.ended) listener('SIGTERM')('SIGTERM');
    await running;
    vi.unstubAllEnvs();
  });
  const waitFor = (check: () => void) => vi.waitFor(check, { timeout: 30_000, interval: 20 });
  return {
    run, running, desiredNow, listener,
    async coreSpawned() {
      await waitFor(() => expect(run.core).toBeDefined());
    },
    coreReady() {
      run.core!.stdout.write(`[core-only] listening on 127.0.0.1:${port} (bot local_overlap, cli codex)\n`);
    },
    async socketOpening() {
      await waitFor(() => expect(run.socket?.listenerCount('open')).toBe(1));
    },
    async connect() {
      run.socket!.emit('open');
      await waitFor(() => expect(readWecomRuntime(botId)?.phase).toBe('running'));
    },
    /** A control request that never sends the rest of its body; resolves the drain's end time once dropped. */
    async holdDrain(): Promise<{ endedAt?: number }> {
      await waitFor(() => expect(readWecomRuntime(botId)?.control?.port).toBeGreaterThan(0));
      const hung: Socket = connect({ host: '127.0.0.1', port: readWecomRuntime(botId)!.control!.port });
      hung.on('error', () => undefined);
      cleanups.push(() => hung.destroy());
      await new Promise<void>(done => hung.once('connect', () => done()));
      hung.write([
        // A signed-request route: the server reads the whole body before it checks the
        // signature, so a body that never completes holds the request open.
        `POST ${WECOM_GATEWAY_CONTROL_PATHS.sessionControl} HTTP/1.1`,
        'Host: 127.0.0.1',
        `x-botmux-daemon-ts: ${Date.now()}`,
        'x-botmux-daemon-nonce: hung-control-request',
        `x-botmux-daemon-sig: ${'a'.repeat(64)}`,
        'x-botmux-daemon-appid: wecom-shutdown-test',
        'Content-Type: application/json',
        'Content-Length: 1000',
        '',
        '{"operation":',
      ].join('\r\n'));
      // Let the control server start reading the request (an idle connection would just be closed).
      await new Promise(done => setTimeout(done, 300));
      const drain: { endedAt?: number } = {};
      hung.once('close', () => {
        drain.endedAt = Date.now();
      });
      return drain;
    },
  };
}

/** Fake clock from here on: timers and Date. Timers made before keep their real clock. */
function fakeClock(): number {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'], shouldClearNativeTimers: true });
  return Date.now();
}

/**
 * A few milliseconds of real time for real I/O (the control connection, file
 * writes) to settle. Not a timer: `bun test` fakes every timer and clock once
 * fake timers are on — `setTimeout` captured beforehand, `performance.now()`,
 * `process.hrtime` alike — so a sleep or a deadline on any of them would never
 * end there. `Atomics.wait` blocks the thread for real milliseconds under
 * either runner; the event-loop turn after each one delivers what arrived.
 */
const realPause = new Int32Array(new SharedArrayBuffer(4));
async function settleRealIo() {
  for (let turn = 0; turn < 8; turn++) {
    await new Promise(next => setImmediate(next));
    Atomics.wait(realPause, 0, 0, 1);
  }
}

/**
 * Jump from timer to timer, letting real I/O settle before each jump, until
 * `done`. A shutdown takes a handful of jumps; the bound only ends a hang.
 */
async function advanceUntil(done: () => boolean) {
  for (let jump = 0; !done() && jump < 500; jump++) {
    await settleRealIo();
    if (!done() && vi.getTimerCount() > 0) await vi.advanceTimersToNextTimerAsync();
  }
  expect(done()).toBe(true);
}

describe('WeCom gateway shutdown: core stop alongside the drain', () => {
  it('tells the core to stop when a SIGTERM shutdown begins, before the drain ends, and waits for that one stop', async () => {
    const g = await startGateway({ onSigkill: 'exit' });
    await g.coreSpawned();
    g.coreReady();
    await g.socketOpening();
    await g.connect();
    const drain = await g.holdDrain();
    const t0 = fakeClock();
    g.listener('SIGTERM')('SIGTERM');
    await advanceUntil(() => g.run.ended !== undefined);

    const sigterms = g.run.core!.signals.filter(s => s.signal === 'SIGTERM');
    expect(sigterms).toHaveLength(1);
    expect(sigterms[0].at - t0).toBeLessThan(1_000);
    // The drain really was held for its whole budget, the core already stopping meanwhile.
    expect(drain.endedAt! - t0).toBeGreaterThanOrEqual(WECOM_GATEWAY_DRAIN_BUDGET_MS);
    expect(sigterms[0].at).toBeLessThan(drain.endedAt!);
    // It waited for the core (SIGKILL after the core's grace) and not one drain longer.
    expect(g.run.ended!.at - t0).toBeGreaterThanOrEqual(WECOM_MANAGED_CORE_STOP_GRACE_MS);
    expect(g.run.ended!.at - t0).toBeLessThanOrEqual(WECOM_GATEWAY_SHUTDOWN_MAX_MS);
    expect(g.run.ended!.code).toBe(0);
  });

  // Worst case of every way a shutdown begins while the core runs (or starts):
  // the drain held for its budget, a core that ignores SIGTERM and does not
  // even go on SIGKILL, so the gateway waits out the core's whole stop.
  const entries: Array<{ name: string; subscribeErrcode?: number; begin(g: Awaited<ReturnType<typeof startGateway>>): Promise<{ endedAt?: number } | undefined> }> = [
    {
      name: 'SIGTERM',
      async begin(g) {
        g.coreReady();
        await g.socketOpening();
        await g.connect();
        const drain = await g.holdDrain();
        fakeClock();
        g.listener('SIGTERM')('SIGTERM');
        return drain;
      },
    },
    {
      name: 'the platform hands the BotID to another client',
      async begin(g) {
        g.coreReady();
        await g.socketOpening();
        await g.connect();
        const drain = await g.holdDrain();
        fakeClock();
        g.run.socket!.emit('message', Buffer.from(JSON.stringify({
          cmd: 'aibot_event_callback', headers: { req_id: 'r' }, body: { event: { eventtype: 'disconnected_event' } },
        })));
        return drain;
      },
    },
    {
      name: 'the platform rejects the credentials',
      subscribeErrcode: 40_001,
      async begin(g) {
        g.coreReady();
        await g.socketOpening();
        const drain = await g.holdDrain();
        fakeClock();
        g.run.socket!.emit('open');
        return drain;
      },
    },
    {
      name: 'an uncaught exception (the fatal-error guard)',
      async begin(g) {
        g.coreReady();
        await g.socketOpening();
        await g.connect();
        const drain = await g.holdDrain();
        fakeClock();
        g.listener('uncaughtException')(new Error('gateway bug'));
        return drain;
      },
    },
    {
      name: 'SIGTERM while the core is still starting',
      async begin(g) {
        fakeClock();
        g.listener('SIGTERM')('SIGTERM');
        return undefined;
      },
    },
  ];

  it.each(entries)('$name: the core is told to stop at once, and the gateway is done within its shutdown budget', async entry => {
    const g = await startGateway({ onSigkill: 'stuck', subscribeErrcode: entry.subscribeErrcode });
    await g.coreSpawned();
    const drain = await entry.begin(g);
    const t0 = Date.now();
    await advanceUntil(() => g.run.ended !== undefined);
    // Under the fatal-error guard the process ends at the guard's exit.
    const end = (g.run.fatalExitAt ?? g.run.ended!.at) - t0;

    const sigterm = g.run.core!.signals.find(s => s.signal === 'SIGTERM');
    expect(sigterm!.at - t0).toBeLessThan(1_000);
    if (drain) expect(drain.endedAt! - t0).toBeGreaterThanOrEqual(WECOM_GATEWAY_DRAIN_BUDGET_MS);
    // The core's whole stop was waited for (nothing cut it short and orphaned the core) …
    expect(end).toBeGreaterThanOrEqual(WECOM_MANAGED_CORE_STOP_GRACE_MS + WECOM_MANAGED_CORE_KILL_WAIT_MS);
    // … and the gateway still ended inside its budget, with the supervisor's slack to spare.
    expect(end).toBeLessThanOrEqual(WECOM_GATEWAY_SHUTDOWN_MAX_MS);
    expect(end + FLEET_DAEMON_KILL_SLACK_MS).toBeLessThanOrEqual(WECOM_GATEWAY_KILL_TIMEOUT_MS);
  });
});

describe('WeCom gateway shutdown: the stop record does not hold up the core', () => {
  it('tells the core to stop before it records "stopped (replaced)", whose write may wait for the file\'s lock', async () => {
    // The core goes on SIGTERM: only the order matters here, in real time.
    const g = await startGateway({ onSigkill: 'exit', onSigterm: 'exit' });
    await g.coreSpawned();
    g.coreReady();
    await g.socketOpening();
    await g.connect();
    // Another process holds the desired-state file's lock for a while.
    const holder: ChildProcess = spawnTsEvalWithRepoImports(`
      const { withFileLock } = await import(${JSON.stringify(resolve('src/utils/file-lock.ts'))});
      await withFileLock(${JSON.stringify(wecomFleetDesiredStatePath())}, async () => {
        console.log('HELD');
        await new Promise(done => setTimeout(done, 1500));
      }, { maxWaitMs: 5000 });
    `, { env: process.env, stdio: ['ignore', 'pipe', 'inherit'] });
    cleanups.push(() => {
      if (holder.exitCode === null && holder.signalCode === null) holder.kill('SIGKILL');
    });
    await new Promise<void>(done => {
      let output = '';
      holder.stdout!.on('data', chunk => {
        output += chunk;
        if (output.includes('HELD')) done();
      });
    });
    const t0 = Date.now();
    g.run.socket!.emit('message', Buffer.from(JSON.stringify({
      cmd: 'aibot_event_callback', headers: { req_id: 'r' }, body: { event: { eventtype: 'disconnected_event' } },
    })));
    expect(await g.running).toBe(WECOM_GATEWAY_NO_RESTART_EXIT_CODE);

    const sigterm = g.run.core!.signals.find(s => s.signal === 'SIGTERM')!;
    expect(sigterm.desired).toBe('running');
    expect(sigterm.at - t0).toBeLessThan(500);
    expect(g.desiredNow()).toBe('stopped/replaced');
  }, 30_000);
});
