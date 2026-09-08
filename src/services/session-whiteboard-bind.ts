/**
 * Persist a session↔whiteboard binding, then mirror it on the in-memory row.
 * A failed persist must not pretend the session is bound — callers used to
 * discard the patch result and write `session.whiteboardId` anyway.
 */
export function whiteboardBindFailedMessage(sessionId: string): string {
  return `白板已创建，但未能绑定到会话 ${sessionId}（daemon 不可达或当前进程不能离线写）`;
}

export async function bindSessionWhiteboard<S extends { sessionId: string; whiteboardId?: string }>(
  session: S,
  whiteboardId: string,
  persist: (session: S, whiteboardId: string) => boolean | Promise<boolean>,
): Promise<boolean> {
  const bound = await persist(session, whiteboardId);
  if (!bound) return false;
  session.whiteboardId = whiteboardId;
  return true;
}
