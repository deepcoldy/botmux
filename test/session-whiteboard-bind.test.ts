import { describe, expect, it, vi } from 'vitest';
import {
  bindSessionWhiteboard,
  whiteboardBindFailedMessage,
} from '../src/services/session-whiteboard-bind.js';

describe('bindSessionWhiteboard', () => {
  it('does not write memory when persist fails', async () => {
    const session: { sessionId: string; whiteboardId?: string } = { sessionId: 's1' };
    const persist = vi.fn(async () => false);
    await expect(bindSessionWhiteboard(session, 'wb_new', persist)).resolves.toBe(false);
    expect(persist).toHaveBeenCalledWith(session, 'wb_new');
    expect(session.whiteboardId).toBeUndefined();
    expect(whiteboardBindFailedMessage('s1')).toContain('未能绑定到会话 s1');
  });

  it('leaves a prior binding alone when persist fails', async () => {
    const session = { sessionId: 's1', whiteboardId: 'wb_old' };
    await expect(bindSessionWhiteboard(session, 'wb_new', async () => false)).resolves.toBe(false);
    expect(session.whiteboardId).toBe('wb_old');
  });

  it('mirrors the id only after persist succeeds', async () => {
    const session: { sessionId: string; whiteboardId?: string } = { sessionId: 's1' };
    await expect(bindSessionWhiteboard(session, 'wb_new', async () => true)).resolves.toBe(true);
    expect(session.whiteboardId).toBe('wb_new');
  });
});
