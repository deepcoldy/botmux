import { describe, expect, it, vi } from 'vitest';
import { sanitizeDeviceStatusCommandResult } from '../../src/desktop/main/device-status.js';
import { createMainWindow } from '../../src/desktop/main/window.js';

type AttachWebviewHandler = (event: unknown, webPreferences: Record<string, unknown>) => void;
const { attachWebviewHandlers } = vi.hoisted(() => ({ attachWebviewHandlers: [] as AttachWebviewHandler[] }));

vi.mock('electron', () => {
  class BrowserWindow {
    webContents = {
      on: (event: string, handler: AttachWebviewHandler) => {
        if (event === 'will-attach-webview') attachWebviewHandlers.push(handler);
      },
      setWindowOpenHandler: () => {},
    };
    loadFile = () => Promise.resolve();
  }
  return {
    BrowserWindow,
    screen: { getPrimaryDisplay: () => ({ workAreaSize: { width: 1920, height: 1080 } }) },
    shell: { openExternal: () => {} },
  };
});

describe('desktop device status boundary', () => {
  it('accepts the exact enrolled public status shape', () => {
    const result = sanitizeDeviceStatusCommandResult({
      code: 0,
      stdout: JSON.stringify({
        schemaVersion: 1,
        enrolled: true,
        issuer: 'https://platform.example.test',
        deviceExp: 1_800_000_000_000,
        savedAt: '2026-07-22T06:00:00.000Z',
      }),
    });

    expect(result).toEqual({
      ok: true,
      status: {
        schemaVersion: 1,
        enrolled: true,
        issuer: 'https://platform.example.test',
        deviceExp: 1_800_000_000_000,
        savedAt: '2026-07-22T06:00:00.000Z',
      },
    });
  });

  it('accepts the exact unenrolled shape and rejects accidental credential fields', () => {
    expect(sanitizeDeviceStatusCommandResult({
      code: 0,
      stdout: JSON.stringify({ schemaVersion: 1, enrolled: false }),
    })).toEqual({
      ok: true,
      status: { schemaVersion: 1, enrolled: false },
    });
    expect(sanitizeDeviceStatusCommandResult({
      code: 0,
      stdout: JSON.stringify({ schemaVersion: 1, enrolled: false, accessToken: 'secret' }),
    })).toEqual({ ok: false, reason: 'invalid_response' });
    expect(sanitizeDeviceStatusCommandResult({
      code: 0,
      stdout: JSON.stringify({
        schemaVersion: 1,
        enrolled: true,
        issuer: 'https://platform.example.test',
        deviceExp: 1_800_000_000_000,
        savedAt: '2026-07-22T06:00:00.000Z',
        refreshToken: 'secret',
      }),
    })).toEqual({ ok: false, reason: 'invalid_response' });
  });

  it('fails closed on command errors, malformed/oversized output, and unsafe issuers', () => {
    expect(sanitizeDeviceStatusCommandResult({
      code: 1,
      stdout: '{"accessToken":"secret"}',
    })).toEqual({ ok: false, reason: 'command_failed' });
    expect(sanitizeDeviceStatusCommandResult({ code: 0, stdout: 'not-json' }))
      .toEqual({ ok: false, reason: 'invalid_response' });
    expect(sanitizeDeviceStatusCommandResult({ code: 0, stdout: ' '.repeat(4 * 1024 + 1) }))
      .toEqual({ ok: false, reason: 'invalid_response' });
    expect(sanitizeDeviceStatusCommandResult({
      code: 0,
      stdout: JSON.stringify({
        schemaVersion: 1,
        enrolled: true,
        issuer: 'http://platform.example.test',
        deviceExp: 1_800_000_000_000,
        savedAt: '2026-07-22T06:00:00.000Z',
      }),
    })).toEqual({ ok: false, reason: 'invalid_response' });
  });

  it('attaches dashboard webviews sandboxed, isolated, and without the privileged shell preload', () => {
    attachWebviewHandlers.length = 0;
    createMainWindow('/app/dist/desktop/preload.js', '/app/dist/desktop/renderer');
    expect(attachWebviewHandlers).toHaveLength(1);

    const webPreferences: Record<string, unknown> = {
      preload: '/app/dist/desktop/preload.js',
      nodeIntegration: true,
      contextIsolation: false,
      sandbox: false,
    };
    attachWebviewHandlers[0]({}, webPreferences);
    expect(webPreferences).toEqual({ nodeIntegration: false, contextIsolation: true, sandbox: true });
  });
});
