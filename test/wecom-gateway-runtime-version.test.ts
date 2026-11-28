/**
 * A running gateway records the botmux version it runs in its runtime record
 * (read by `botmux status`), and a record written before that field existed
 * still reads as a record.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runWecomCommand } from '../src/im/wecom/gateway/command.js';
import { readWecomRuntime, wecomBotRoot } from '../src/im/wecom/config/runtime.js';
import { botmuxVersion } from '../src/utils/install-info.js';

const SECRET_ENV = 'RUNTIME_VERSION_WECOM_SECRET';
const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
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
}

describe('the version in a gateway\'s runtime record', () => {
  it('is the botmux version the gateway runs', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wecom-runtime-version-'));
    roots.push(root);
    const botId = `runtime-version-${process.pid}`;
    const file = join(root, 'config.json');
    writeFileSync(file, JSON.stringify({
      botId,
      secretEnv: SECRET_ENV,
      coreUrl: 'http://127.0.0.1:1',
      allowedUsers: ['alice'],
      stateDir: root,
    }));
    vi.stubEnv(SECRET_ENV, 'fake-secret');
    // What a compiled release reports as its version (install-info.ts).
    vi.stubEnv('BOTMUX_BAKED_VERSION', '7.7.7-runtime-test');
    let socket: FakeSocket | undefined;
    const running = runWecomCommand(['--config', file], {
      socketFactory: () => {
        socket = new FakeSocket();
        return socket as never;
      },
    });
    await vi.waitFor(() => expect(socket?.listenerCount('open')).toBe(1), { timeout: 30_000, interval: 20 });
    socket!.emit('open');
    await vi.waitFor(() => expect(readWecomRuntime(botId)?.phase).toBe('running'), { timeout: 15_000, interval: 20 });
    expect(botmuxVersion()).toBe('7.7.7-runtime-test');
    expect(readWecomRuntime(botId)?.botmuxVersion).toBe('7.7.7-runtime-test');

    socket!.frame({ cmd: 'aibot_event_callback', body: { event: { eventtype: 'disconnected_event' } } });
    await running;
  }, 60_000);

  it('reads a record written before the version was recorded', () => {
    const root = mkdtempSync(join(tmpdir(), 'wecom-runtime-old-'));
    roots.push(root);
    const dir = wecomBotRoot('bot-old', root);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'runtime.json'), JSON.stringify({
      version: 1, configId: 'a'.repeat(64), pid: 1234, processStart: 'birth', instanceId: 'i',
      connection: 'connected', phase: 'running', updatedAt: 1,
    }));
    const record = readWecomRuntime('bot-old', root);
    expect(record?.pid).toBe(1234);
    expect(record?.botmuxVersion).toBeUndefined();
  });
});
