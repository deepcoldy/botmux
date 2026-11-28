import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter, once } from 'node:events';
import { connect, type Socket } from 'node:net';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { runWecomCommand } from '../src/im/wecom/gateway/command.js';
import { readWecomRuntime } from '../src/im/wecom/config/runtime.js';
import { WECOM_GATEWAY_CONTROL_PATHS } from '../src/im/wecom/contract/gateway-control.js';
import { spawnTsEval } from './helpers/ts-runner.js';
import { releaseWecomCorePorts, reserveWecomCorePort } from './helpers/wecom-core-port.js';

/**
 * A gateway shutdown drains the in-flight dispatch tick and the control
 * server's in-flight requests before it finishes stopping its core and exits.
 * Both waits are bounded: a control request that never finishes, or a dispatch
 * hung on an unresponsive core, must not keep the gateway (and its core) alive
 * past the gateway's shutdown budget — a supervisor SIGKILLs it after that.
 */

const SECRET_ENV = 'DRAIN_WECOM_SECRET';
const roots: string[] = [];
const children: ChildProcess[] = [];
const sockets: Socket[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const socket of sockets.splice(0)) {
    socket.destroy();
  }
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await once(child, 'exit');
    }
  }
  await releaseWecomCorePorts();
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

class FakeSocket extends EventEmitter {
  sent: Array<{ cmd?: string }> = [];
  send(data: string, callback?: (error?: Error) => void) {
    const frame = JSON.parse(data);
    this.sent.push(frame);
    callback?.();
    queueMicrotask(() => this.emit('message', Buffer.from(JSON.stringify({ headers: frame.headers, errcode: 0 }))));
  }
  terminate() {
    this.emit('close');
  }
  frame(value: unknown) {
    this.emit('message', Buffer.from(JSON.stringify(value)));
  }
}

describe('WeCom gateway shutdown drain', () => {
  it('stops the core and exits within the drain bound while a dispatch and a control request hang', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wecom-drain-'));
    roots.push(root);
    const port = await reserveWecomCorePort();
    const botId = `drain-${process.pid}`;
    const file = join(root, 'config.json');
    writeFileSync(file, JSON.stringify({
      botId,
      secretEnv: SECRET_ENV,
      coreUrl: `http://127.0.0.1:${port}`,
      allowedUsers: ['alice'],
      stateDir: root,
      managedCore: { botId: 'local_drain', cli: 'codex', backend: 'pty', port, workingDirectory: root, stateDir: join(root, 'core-state') },
    }));
    vi.stubEnv(SECRET_ENV, 'fake-secret');
    const dispatched = join(root, 'core-saw-a-request');
    // A core that becomes ready, then accepts every API request and never answers it.
    const hungCore = [
      "const { createServer } = await import('node:net');",
      "const { writeFileSync } = await import('node:fs');",
      `createServer(() => writeFileSync(${JSON.stringify(dispatched)}, 'x')).listen(Number(process.env.BOTMUX_API_PORT), '127.0.0.1', () => {`,
      "  console.log('[core-only] listening on 127.0.0.1:'+process.env.BOTMUX_API_PORT+' (bot '+process.env.BOTMUX_API_ONLY_BOT+', cli '+process.env.BOTMUX_CORE_CLI+')');",
      '});',
    ].join('\n');
    let socket: FakeSocket | undefined;
    let core: ChildProcess | undefined;
    const drainBudgetMs = 500;
    const running = runWecomCommand(['--config', file], {
      drainBudgetMs,
      socketFactory: () => {
        socket = new FakeSocket();
        return socket as never;
      },
      coreSpawn: (_command: string, _args: string[], options: SpawnOptions) => {
        core = spawnTsEval(hungCore, options);
        children.push(core);
        return core;
      },
    });
    await vi.waitFor(() => expect(socket?.listenerCount('open')).toBe(1), { timeout: 30_000, interval: 20 });
    socket!.emit('open');
    await vi.waitFor(() => expect(socket!.sent.some(frame => frame.cmd === 'aibot_subscribe')).toBe(true));

    // 1. A message whose dispatch hangs on the unresponsive core.
    socket!.frame({
      cmd: 'aibot_msg_callback',
      headers: { req_id: 'callback' },
      body: { msgid: 'm1', chattype: 'single', from: { userid: 'alice' }, msgtype: 'text', text: { content: 'task' } },
    });
    await vi.waitFor(() => expect(existsSync(dispatched)).toBe(true), { timeout: 30_000, interval: 50 });
    // 2. A control request that never finishes its body.
    const control = readWecomRuntime(botId)?.control;
    expect(control).toBeDefined();
    const hung = connect({ host: '127.0.0.1', port: control!.port });
    sockets.push(hung);
    // The gateway drops this connection at the end of its drain: a reset is the expected outcome.
    hung.on('error', () => undefined);
    await once(hung, 'connect');
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
    // Give the control server time to start handling the request (headers parsed,
    // waiting for the rest of the body) — an unparsed connection would just be idle.
    await new Promise(done => setTimeout(done, 300));
    // events.once would reject on the expected reset; only the close matters here.
    const hungClosed = new Promise<void>(done => hung.once('close', () => done()));

    const stopAt = Date.now();
    socket!.frame({ cmd: 'aibot_event_callback', body: { event: { eventtype: 'disconnected_event' } } });
    const code = await running;
    const elapsed = Date.now() - stopAt;

    expect(code).not.toBe(0);
    expect(core!.exitCode !== null || core!.signalCode !== null).toBe(true);
    // Drain bound plus the core's own (immediate) exit, with room for a loaded
    // machine; an unbounded control drain never returns at all.
    expect(elapsed).toBeLessThan(drainBudgetMs + 8_000);
    await hungClosed;
  }, 90_000);
});
