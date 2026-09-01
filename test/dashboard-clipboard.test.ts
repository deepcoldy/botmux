import { afterEach, describe, expect, it, vi } from 'bun:test';

import { copyText } from '../src/dashboard/web/clipboard.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('dashboard clipboard helper', () => {
  it('copies via textarea when navigator.clipboard is unavailable', async () => {
    const prompt = vi.fn();
    const execCommand = vi.fn(() => true);
    const textarea = {
      value: '',
      style: { cssText: '' },
      setAttribute: vi.fn(),
      focus: vi.fn(),
      select: vi.fn(),
      remove: vi.fn(),
    };
    const appendChild = vi.fn();
    vi.stubGlobal('navigator', {});
    vi.stubGlobal('window', { prompt });
    vi.stubGlobal('document', {
      body: { appendChild },
      createElement: vi.fn(() => textarea),
      execCommand,
    });

    await expect(copyText('{"ok":true}', '复制')).resolves.toBe(true);

    expect(textarea.value).toBe('{"ok":true}');
    expect(appendChild).toHaveBeenCalledWith(textarea);
    expect(textarea.select).toHaveBeenCalled();
    expect(execCommand).toHaveBeenCalledWith('copy');
    expect(textarea.remove).toHaveBeenCalled();
    expect(prompt).not.toHaveBeenCalled();
  });

  it('falls back to prompt when direct copy is unavailable', async () => {
    const prompt = vi.fn();
    vi.stubGlobal('navigator', {});
    vi.stubGlobal('window', { prompt });

    await expect(copyText('{"ok":true}', '复制')).resolves.toBe(false);

    expect(prompt).toHaveBeenCalledWith('复制', '{"ok":true}');
  });
});
