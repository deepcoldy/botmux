import type { EventEmitter } from 'node:events';

export const WORKER_IPC_HANDLER_READY_EVENT = 'botmux:worker-ipc-handler-ready';

type IpcHost = Pick<EventEmitter, 'emit' | 'prependListener' | 'removeListener' | 'once'> & {
  send?: (message: unknown) => unknown;
};

function ordinaryColdStartTurnId(raw: unknown): string | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const message = raw as Record<string, unknown>;
  if (
    message.type !== 'init'
    || message.adoptMode === true
    || message.dispatchAttempt !== undefined
    || typeof message.prompt !== 'string'
    || message.prompt.length === 0
    || typeof message.turnId !== 'string'
    || !message.turnId.startsWith('om_')
  ) {
    return undefined;
  }
  return message.turnId;
}

/**
 * 完整 Worker 加载前暂存父进程消息，并为已由当前进程持有的首轮输入回执。
 * Worker 注册正式处理器后再按原顺序重放，保持后续提交确认语义不变。
 */
export function installWorkerIpcPreload(host: IpcHost): void {
  const bufferedMessages: unknown[] = [];
  let replaying = false;

  const bufferMessage = (raw: unknown): void => {
    if (replaying) return;
    bufferedMessages.push(raw);
    const turnId = ordinaryColdStartTurnId(raw);
    if (turnId) host.send?.({ type: 'turn_input_received', turnId });
  };

  host.prependListener('message', bufferMessage);
  host.once(WORKER_IPC_HANDLER_READY_EVENT, () => {
    host.removeListener('message', bufferMessage);
    replaying = true;
    for (const message of bufferedMessages) host.emit('message', message);
    bufferedMessages.length = 0;
    replaying = false;
  });
}

if (typeof process.send === 'function') installWorkerIpcPreload(process);
