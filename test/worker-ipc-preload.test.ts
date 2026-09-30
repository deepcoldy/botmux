import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  installWorkerIpcPreload,
  waitForWorkerIpcPreloadMessage,
  WORKER_IPC_HANDLER_READY_EVENT,
} from '../src/worker-ipc-preload.js';

class FakeIpcHost extends EventEmitter {
  send = vi.fn();
}

describe('worker IPC preload', () => {
  it('acknowledges and replays an ordinary cold-start init after the worker handler is ready', () => {
    const host = new FakeIpcHost();
    const handled = vi.fn();
    const init = {
      type: 'init',
      prompt: '排查问题',
      turnId: 'om_cold_start',
    };

    installWorkerIpcPreload(host);
    host.emit('message', init);
    expect(host.send).toHaveBeenCalledWith({
      type: 'turn_input_received',
      turnId: 'om_cold_start',
    });

    host.on('message', handled);
    host.emit(WORKER_IPC_HANDLER_READY_EVENT);
    expect(handled).toHaveBeenCalledTimes(1);
    expect(handled).toHaveBeenCalledWith(init);
  });

  it('buffers non-ordinary init without forging a delivery receipt', () => {
    const host = new FakeIpcHost();
    const handled = vi.fn();
    const init = {
      type: 'init',
      prompt: '接管会话',
      turnId: 'om_adopt',
      adoptMode: true,
    };

    installWorkerIpcPreload(host);
    host.emit('message', init);
    host.on('message', handled);
    host.emit(WORKER_IPC_HANDLER_READY_EVENT);

    expect(host.send).not.toHaveBeenCalled();
    expect(handled).toHaveBeenCalledWith(init);
  });

  it('stops intercepting messages after the worker handler is ready', () => {
    const host = new FakeIpcHost();
    const handled = vi.fn();
    installWorkerIpcPreload(host);
    host.on('message', handled);
    host.emit(WORKER_IPC_HANDLER_READY_EVENT);

    const followUp = { type: 'message', content: '继续', turnId: 'om_follow_up' };
    host.emit('message', followUp);

    expect(host.send).not.toHaveBeenCalled();
    expect(handled).toHaveBeenCalledTimes(1);
    expect(handled).toHaveBeenCalledWith(followUp);
  });

  it('releases the standalone bootstrap wait when the preload buffers its first message', async () => {
    const host = new FakeIpcHost();
    installWorkerIpcPreload(host);
    const firstMessage = waitForWorkerIpcPreloadMessage(host, 1_000);

    host.emit('message', { type: 'init', prompt: 'first', turnId: 'om_first' });

    await expect(firstMessage).resolves.toBe(true);
  });

  it('acknowledges a bootstrap probe without replaying it to the full Worker handler', async () => {
    const host = new FakeIpcHost();
    const handled = vi.fn();
    installWorkerIpcPreload(host);
    const firstMessage = waitForWorkerIpcPreloadMessage(host, 1_000);

    host.emit('message', { type: 'worker_ipc_probe' });
    await expect(firstMessage).resolves.toBe(true);
    expect(host.send).toHaveBeenCalledWith({ type: 'worker_ipc_ready' });

    host.on('message', handled);
    host.emit(WORKER_IPC_HANDLER_READY_EVENT);
    expect(handled).not.toHaveBeenCalled();
  });

  it('bounds the standalone bootstrap wait when no parent message arrives', async () => {
    const host = new FakeIpcHost();

    await expect(waitForWorkerIpcPreloadMessage(host, 5)).resolves.toBe(false);
  });

  it('boots compiled workers through the preload entry before the CLI graph', () => {
    const entry = readFileSync(resolve('src/standalone-entry.ts'), 'utf8');
    const build = readFileSync(resolve('scripts/build-bun-binary.mjs'), 'utf8');

    expect(entry).toContain("process.argv[2] === '__worker'");
    expect(entry).toContain('waitForWorkerIpcPreloadMessage');
    expect(entry.indexOf("await import('./worker-ipc-preload.js')"))
      .toBeLessThan(entry.indexOf("await import('./cli.js')"));
    expect(build).toContain("join(REPO_ROOT, 'dist', 'standalone-entry.js')");
  });
});
