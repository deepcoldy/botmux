import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { sanitizeDeviceStatusCommandResult } from '../../src/desktop/main/device-status.js';

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

  it('keeps credentials in main: preload exposes status only and dashboard webviews get no preload', () => {
    const preload = readFileSync(new URL('../../src/desktop/preload.ts', import.meta.url), 'utf8');
    const windowMain = readFileSync(new URL('../../src/desktop/main/window.ts', import.meta.url), 'utf8');
    expect(preload).toContain("ipcRenderer.invoke('desktop:get-device-status')");
    expect(preload).not.toContain('accessToken');
    expect(preload).not.toContain('refreshToken');
    expect(windowMain).toContain('delete webPreferences.preload');
    expect(windowMain).toContain('webPreferences.sandbox = true');
  });
});
