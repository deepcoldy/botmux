// 会话任务状态变了（记下本轮结果、举手）的进程内通知。daemon 用它把事件按群转给本机的管家。

export interface SessionTaskEvent {
  chatId: string;
  sessionId: string;
}

type Listener = (event: SessionTaskEvent) => void;

const listeners = new Set<Listener>();

export function onSessionTaskEvent(fn: Listener): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

export function emitSessionTaskEvent(event: SessionTaskEvent): void {
  if (!event.chatId) return;
  for (const fn of listeners) {
    try { fn(event); } catch { /* 接收方自己记日志；不影响产生事件的一轮 */ }
  }
}
