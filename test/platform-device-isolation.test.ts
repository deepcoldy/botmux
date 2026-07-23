import {
  lstatSync,
  mkdtempSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  completeDeviceCredentialIsolationMarker,
  deviceCredentialIsolationSupported,
  ensureDeviceCredentialIsolationMarker,
  readDeviceCredentialIsolationMarker,
} from '../src/platform/device-isolation.js';

const roots: string[] = [];
function tempHome(): string {
  const root = mkdtempSync(join(tmpdir(), 'botmux-device-isolation-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('device credential isolation activation', () => {
  it('writes a durable one-way marker and leaves it in place on repeat', () => {
    const homeDir = tempHome();
    const first = ensureDeviceCredentialIsolationMarker({
      homeDir,
      now: () => new Date('2030-01-02T03:04:05.000Z'),
    });
    expect(first.created).toBe(true);
    expect(first.state).toBe('pending');
    if (process.platform !== 'win32') expect(lstatSync(first.path).mode & 0o777).toBe(0o600);
    expect(ensureDeviceCredentialIsolationMarker({ homeDir })).toMatchObject({
      created: false,
      state: 'pending',
    });
    completeDeviceCredentialIsolationMarker({
      homeDir,
      now: () => new Date('2030-01-02T03:04:06.000Z'),
    });
    expect(readDeviceCredentialIsolationMarker({ homeDir })).toMatchObject({
      state: 'active',
      enabledAt: '2030-01-02T03:04:05.000Z',
      activatedAt: '2030-01-02T03:04:06.000Z',
    });
    expect(ensureDeviceCredentialIsolationMarker({ homeDir }).state).toBe('active');
  });

  it('rejects unsupported hosts without probing a local mechanism', () => {
    expect(deviceCredentialIsolationSupported('win32')).toBe(false);
    expect(deviceCredentialIsolationSupported('freebsd')).toBe(false);
  });
});
