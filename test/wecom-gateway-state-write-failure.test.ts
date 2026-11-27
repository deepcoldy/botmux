/**
 * The `botmux wecom` gateway whose state document cannot be written: the
 * failure reaches its runtime record (what the Dashboard reads), the poisoned
 * gateway still shuts down on the fleet's SIGTERM, and the next start — the
 * restart — processes messages again, its record without the failure.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runWecomCommand } from '../src/im/wecom/gateway/command.js';
import { readWecomRuntime, wecomBotRoot } from '../src/im/wecom/config/runtime.js';
import { blockWecomStateWrites } from './helpers/wecom-state-writes.js';

const SECRET_ENV = 'STATE_WRITE_FAILURE_WECOM_SECRET';
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.unstubAllEnvs();
});

/** Fake WeCom long connection: acknowledges every frame. */
class FakeSocket extends EventEmitter {
  sent: Array<{ cmd?: string; headers?: unknown }> = [];
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
  text(id: string, user = 'alice') {
    this.frame({
      cmd: 'aibot_msg_callback',
      headers: { req_id: id },
      body: { msgid: id, chattype: 'single', from: { userid: user }, msgtype: 'text', text: { content: 'hello' } },
    });
  }
}

const waitFor = (check: () => void) => vi.waitFor(check, { timeout: 15_000, interval: 20 });

/** Start the gateway on `file`; resolves once it is connected and running. */
async function startGateway(file: string, botId: string) {
  const before = new Set(process.listeners('SIGTERM'));
  let socket: FakeSocket | undefined;
  let ended: number | undefined;
  const running = runWecomCommand(['--config', file], {
    socketFactory: () => {
      socket = new FakeSocket();
      return socket as never;
    },
  });
  void running.then(code => {
    ended = code;
  });
  await vi.waitFor(() => expect(socket?.listenerCount('open')).toBe(1), { timeout: 30_000, interval: 20 });
  socket!.emit('open');
  await waitFor(() => expect(readWecomRuntime(botId)?.phase).toBe('running'));
  const added = process.listeners('SIGTERM').filter(listener => !before.has(listener));
  expect(added).toHaveLength(1);
  const sigterm = added[0] as (signal: string) => void;
  let stopped = false;
  const stop = async () => {
    if (!stopped) {
      stopped = true;
      sigterm('SIGTERM');
    }
    return running;
  };
  cleanups.push(async () => {
    await stop();
  });
  return { socket: socket!, stop, ended: () => ended };
}

describe('a gateway whose state document cannot be written', () => {
  it('reports the failure in its runtime record, stops on SIGTERM, and processes again once restarted', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wecom-gateway-state-write-'));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const botId = `state-write-gateway-${process.pid}`;
    cleanups.push(() => rmSync(wecomBotRoot(botId), { recursive: true, force: true }));
    const file = join(root, 'config.json');
    writeFileSync(file, JSON.stringify({
      botId,
      secretEnv: SECRET_ENV,
      coreUrl: 'http://127.0.0.1:1',
      allowedUsers: ['alice', 'bob'],
      stateDir: root,
    }));
    vi.stubEnv(SECRET_ENV, 'fake-secret');
    const stateFile = join(root, 'state.json');

    const tasks = () => existsSync(stateFile) ? Object.keys(JSON.parse(readFileSync(stateFile, 'utf8')).tasks ?? {}) : [];

    const first = await startGateway(file, botId);
    // One task saved before the disk goes bad: the restart continues it.
    first.socket.text('m0');
    await waitFor(() => expect(tasks()).toHaveLength(1));
    const saved = tasks();
    expect(readWecomRuntime(botId)?.stateWriteFailure).toBeUndefined();
    const unblock = blockWecomStateWrites(stateFile);
    first.socket.text('m1');
    await waitFor(() => expect(readWecomRuntime(botId)?.stateWriteFailure).toEqual({
      code: 'EISDIR', at: expect.any(Number), directory: root,
    }));
    // Still connected: the record does not claim otherwise.
    expect(readWecomRuntime(botId)).toMatchObject({ phase: 'running', connection: 'connected' });

    expect(await first.stop()).toBe(0);
    expect(readWecomRuntime(botId)?.phase).toBe('stopped');

    unblock();
    expect(tasks()).toEqual(saved);
    // The gateway takes its credential out of the environment once read.
    vi.stubEnv(SECRET_ENV, 'fake-secret');
    const second = await startGateway(file, botId);
    expect(readWecomRuntime(botId)?.stateWriteFailure).toBeUndefined();
    // Another conversation: alice's saved task still holds hers.
    second.socket.text('m2', 'bob');
    // The task saved before the failure is still there, next to the new one.
    await waitFor(() => expect(tasks()).toHaveLength(2));
    expect(tasks()).toEqual(expect.arrayContaining(saved));
    expect(second.ended()).toBeUndefined();
    expect(await second.stop()).toBe(0);
  }, 90_000);
});
