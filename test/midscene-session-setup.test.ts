import { describe, expect, it, vi } from 'vitest';
import { buildSession, releaseAll } from './e2e-browser/session-setup.js';

interface Session {
  browser: string;
  page: string;
}

describe('Feishu E2E session setup', () => {
  it('releases what a failing setup step already built, then rethrows its error', async () => {
    // CI: openChat failed after the page had taken a chat lease.
    const released: Array<Partial<Session>> = [];
    const failure = new Error('title bar shows a topic');
    await expect(
      buildSession<Session>(
        {},
        async (s) => {
          s.browser = 'chromium';
          s.page = 'messenger';
          throw failure;
        },
        async (s) => {
          released.push({ ...s });
        },
      ),
    ).rejects.toBe(failure);
    expect(released).toEqual([{ browser: 'chromium', page: 'messenger' }]);
  });

  it('keeps the setup error when releasing the half-built session fails too', async () => {
    const failure = new Error('Messenger never loaded');
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(
      buildSession<Session>(
        {},
        async () => {
          throw failure;
        },
        async () => {
          throw new Error('browser already gone');
        },
      ),
    ).rejects.toBe(failure);
    error.mockRestore();
  });

  it('hands a complete session to the suite without releasing it', async () => {
    const release = vi.fn(async () => {});
    const session = await buildSession<Session>(
      {},
      async (s) => {
        s.browser = 'chromium';
        s.page = 'chat';
      },
      release,
    );
    expect(session).toEqual({ browser: 'chromium', page: 'chat' });
    expect(release).not.toHaveBeenCalled();
  });

  it('runs every teardown step even when one throws', async () => {
    const ran: string[] = [];
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    await releaseAll([
      () => ran.push('agent'),
      () => {
        ran.push('context');
        throw new Error('context already closed');
      },
      async () => {
        ran.push('video');
        throw new Error('no video');
      },
      () => ran.push('browser'),
    ]);
    expect(ran).toEqual(['agent', 'context', 'video', 'browser']);
    error.mockRestore();
  });
});
