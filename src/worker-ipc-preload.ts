import type { EventEmitter } from 'node:events';

export const WORKER_IPC_HANDLER_READY_EVENT = 'botmux:worker-ipc-handler-ready';

export type IpcHost = Pick<EventEmitter, 'emit' | 'prependListener' | 'removeListener' | 'once'> & {
  send?: (message: unknown) => unknown;
};

type PreloadState = {
  firstMessageSeen: boolean;
  waiters: Set<(seen: boolean) => void>;
};

const preloadStates = new WeakMap<object, PreloadState>();

function preloadState(host: IpcHost): PreloadState {
  const key = host as object;
  let state = preloadStates.get(key);
  if (!state) {
    state = { firstMessageSeen: false, waiters: new Set() };
    preloadStates.set(key, state);
  }
  return state;
}

export function waitForWorkerIpcPreloadMessage(
  host: IpcHost,
  timeoutMs: number,
): Promise<boolean> {
  const state = preloadState(host);
  if (state.firstMessageSeen) return Promise.resolve(true);
  return new Promise(resolve => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (seen: boolean): void => {
      if (timer) clearTimeout(timer);
      state.waiters.delete(finish);
      resolve(seen);
    };
    state.waiters.add(finish);
    timer = setTimeout(() => finish(false), timeoutMs);
    timer.unref?.();
  });
}

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
  const state = preloadState(host);
  let replaying = false;

  const bufferMessage = (raw: unknown): void => {
    if (replaying) return;
    state.firstMessageSeen = true;
    for (const waiter of [...state.waiters]) waiter(true);
    if (
      raw
      && typeof raw === 'object'
      && (raw as Record<string, unknown>).type === 'worker_ipc_probe'
    ) {
      host.send?.({ type: 'worker_ipc_ready' });
      return;
    }
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
