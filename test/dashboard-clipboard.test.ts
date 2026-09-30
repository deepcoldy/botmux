import { afterEach, describe, expect, it, vi } from 'vitest';

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

  it('keeps the legacy textarea inside an open dialog when copying from a modal', async () => {
    const execCommand = vi.fn(() => true);
    const textarea = {
      value: '',
      style: { cssText: '' },
      setAttribute: vi.fn(),
      focus: vi.fn(),
      select: vi.fn(),
      remove: vi.fn(),
    };
    const bodyAppendChild = vi.fn();
    const dialogAppendChild = vi.fn();
    const dialog = { appendChild: dialogAppendChild };
    const anchor = { closest: vi.fn(() => dialog) };
    vi.stubGlobal('navigator', {});
    vi.stubGlobal('document', {
      body: { appendChild: bodyAppendChild },
      createElement: vi.fn(() => textarea),
      execCommand,
    });

    await expect(copyText('session-123', '复制', anchor as unknown as Element)).resolves.toBe(true);

    expect(anchor.closest).toHaveBeenCalledWith('dialog[open]');
    expect(dialogAppendChild).toHaveBeenCalledWith(textarea);
    expect(bodyAppendChild).not.toHaveBeenCalled();
    expect(textarea.select).toHaveBeenCalled();
    expect(execCommand).toHaveBeenCalledWith('copy');
    expect(textarea.remove).toHaveBeenCalled();
  });

  it('uses the focused modal dialog when no explicit anchor is passed', async () => {
    const execCommand = vi.fn(() => true);
    const textarea = {
      value: '',
      style: { cssText: '' },
      setAttribute: vi.fn(),
      focus: vi.fn(),
      select: vi.fn(),
      remove: vi.fn(),
    };
    const bodyAppendChild = vi.fn();
    const dialogAppendChild = vi.fn();
    const dialog = { appendChild: dialogAppendChild };
    class FakeElement {
      closest = vi.fn(() => dialog);
    }
    const activeElement = new FakeElement();
    vi.stubGlobal('navigator', {});
    vi.stubGlobal('Element', FakeElement);
    vi.stubGlobal('document', {
      body: { appendChild: bodyAppendChild },
      activeElement,
      createElement: vi.fn(() => textarea),
      execCommand,
    });

    await expect(copyText('session-456', '复制')).resolves.toBe(true);

    expect(activeElement.closest).toHaveBeenCalledWith('dialog[open]');
    expect(dialogAppendChild).toHaveBeenCalledWith(textarea);
    expect(bodyAppendChild).not.toHaveBeenCalled();
  });

  it('falls back to prompt when direct copy is unavailable', async () => {
    const prompt = vi.fn();
    vi.stubGlobal('navigator', {});
    vi.stubGlobal('window', { prompt });

    await expect(copyText('{"ok":true}', '复制')).resolves.toBe(false);

    expect(prompt).toHaveBeenCalledWith('复制', '{"ok":true}');
  });
});
