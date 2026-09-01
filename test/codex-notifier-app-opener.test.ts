import { describe, expect, it, vi } from 'bun:test';
import {
  canOpenCodexAppThread,
  openCodexAppThread,
} from '../src/features/codex-notifier/index.js';

const THREAD_ID = '019f8d92-df7c-7572-83ca-b1e99f20204c';

describe('Codex App thread opener', () => {
  it('uses the fixed macOS launcher without a shell', async () => {
    const run = vi.fn(async () => undefined);

    expect(await openCodexAppThread(THREAD_ID, {
      platform: 'darwin',
      run,
    })).toEqual({ ok: true });
    expect(run).toHaveBeenCalledWith(
      '/usr/bin/open',
      ['-u', `codex://threads/${THREAD_ID}`],
      { timeout: 1_500, windowsHide: true, maxBuffer: 1024 },
    );
  });

  it('fails closed for an invalid thread id or unsupported platform', async () => {
    const run = vi.fn(async () => undefined);

    expect(await openCodexAppThread('not-a-uuid', {
      platform: 'darwin',
      run,
    })).toEqual({ ok: false, error: 'invalid_thread_id' });
    expect(await openCodexAppThread(THREAD_ID, {
      platform: 'linux',
      run,
    })).toEqual({ ok: false, error: 'unsupported_platform' });
    expect(run).not.toHaveBeenCalled();
    expect(canOpenCodexAppThread(THREAD_ID, 'darwin')).toBe(true);
    expect(canOpenCodexAppThread(THREAD_ID, 'linux')).toBe(false);
  });

  it('reports launcher failures without throwing through the card callback', async () => {
    const result = await openCodexAppThread(THREAD_ID, {
      platform: 'darwin',
      run: vi.fn(async () => {
        throw new Error('LaunchServices unavailable');
      }),
    });

    expect(result).toEqual({
      ok: false,
      error: 'open_failed',
      detail: 'LaunchServices unavailable',
    });
  });
});
