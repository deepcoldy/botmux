import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter, once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { runWecomCommand } from '../src/im/wecom/gateway/command.js';
import { readWecomRuntime, wecomBotRoot } from '../src/im/wecom/config/runtime.js';
import { spawnTsEval } from './helpers/ts-runner.js';
import { releaseWecomCorePorts, reserveWecomCorePort } from './helpers/wecom-core-port.js';

/**
 * The runtime record is evidence for the Dashboard, not part of starting: a
 * gateway that cannot rewrite it while starting (full disk, a path that turned
 * into a directory) still connects, and the record catches up once it can be
 * written again.
 */

const SECRET_ENV = 'RUNTIME_RECORD_FAILURE_WECOM_SECRET';
const roots: string[] = [];
const children: ChildProcess[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
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

describe('a gateway whose runtime record cannot be written while it starts', () => {
  // Mutation: an unguarded runtime.update({ control }) in command.ts ends the start there and turns this red.
  it('still connects, and publishes its control endpoint once the record is writable again', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wecom-runtime-record-'));
    roots.push(root);
    const port = await reserveWecomCorePort();
    const botId = `runtime-record-${process.pid}`;
    const file = join(root, 'config.json');
    writeFileSync(file, JSON.stringify({
      botId,
      secretEnv: SECRET_ENV,
      coreUrl: `http://127.0.0.1:${port}`,
      allowedUsers: ['alice'],
      stateDir: root,
      managedCore: { botId: 'local_record', cli: 'codex', backend: 'pty', port, workingDirectory: root, stateDir: join(root, 'core-state') },
    }));
    vi.stubEnv(SECRET_ENV, 'fake-secret');
    const record = join(wecomBotRoot(botId), 'runtime.json');
    // A core that becomes ready and never answers an API request.
    const core = [
      "const { createServer } = await import('node:net');",
      "createServer(() => {}).listen(Number(process.env.BOTMUX_API_PORT), '127.0.0.1', () => {",
      "  console.log('[core-only] listening on 127.0.0.1:'+process.env.BOTMUX_API_PORT+' (bot '+process.env.BOTMUX_API_ONLY_BOT+', cli '+process.env.BOTMUX_CORE_CLI+')');",
      '});',
    ].join('\n');
    let socket: FakeSocket | undefined;
    let settled = false;
    const running = runWecomCommand(['--config', file], {
      drainBudgetMs: 500,
      socketFactory: () => {
        socket = new FakeSocket();
        return socket as never;
      },
      coreSpawn: (_command: string, _args: string[], options: SpawnOptions) => {
        // From here on every write of the record fails: its path is now a directory.
        rmSync(record, { force: true });
        mkdirSync(join(record, 'blocked'), { recursive: true });
        const child = spawnTsEval(core, options);
        children.push(child);
        return child;
      },
    }).finally(() => {
      settled = true;
    });
    await vi.waitFor(() => expect(socket !== undefined || settled).toBe(true), { timeout: 30_000, interval: 20 });
    expect(settled).toBe(false);
    expect(socket).toBeDefined();
    socket!.emit('open');
    await vi.waitFor(() => expect(socket!.sent.some(frame => frame.cmd === 'aibot_subscribe')).toBe(true));

    rmSync(record, { recursive: true, force: true });
    await vi.waitFor(() => expect(readWecomRuntime(botId)?.control?.port).toEqual(expect.any(Number)), { timeout: 15_000, interval: 50 });

    socket!.frame({ cmd: 'aibot_event_callback', body: { event: { eventtype: 'disconnected_event' } } });
    await running;
  }, 90_000);
});
