import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'bun:test';
import {
  installWorkerIpcPreload,
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
});
