import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  clearDeviceCredentials,
  DeviceCredentialError,
  deviceCredentialsPath,
  normalizeDeviceIssuer,
  readDeviceCredentials,
  readDevicePublicStatus,
  writeDeviceCredentials,
} from '../src/platform/device.js';

const roots: string[] = [];

function tempHome(): string {
  const root = mkdtempSync(join(tmpdir(), 'botmux-device-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('desktop device credential store', () => {
  it('atomically stores a pinned credential with 0600 mode and exposes only a safe status DTO', () => {
    const homeDir = tempHome();
    expect(deviceCredentialsPath({ homeDir })).toBe(
      join(homeDir, '.botmux', 'device-auth', 'device.json'),
    );
    const saved = writeDeviceCredentials({
      issuer: 'https://platform.example.test',
      accessToken: 'access-secret',
      accessExpiresAt: 1_800_000_000_000,
      refreshToken: 'refresh-secret',
      deviceExp: 1_900_000_000_000,
    }, {
      homeDir,
      now: () => new Date('2030-01-02T03:04:05.000Z'),
    });

    expect(saved).toMatchObject({
      issuer: 'https://platform.example.test',
      accessToken: 'access-secret',
      refreshToken: 'refresh-secret',
      savedAt: '2030-01-02T03:04:05.000Z',
    });
    if (process.platform !== 'win32') {
      expect(lstatSync(deviceCredentialsPath({ homeDir })).mode & 0o777).toBe(0o600);
    }
    expect(readDeviceCredentials({ homeDir })).toEqual(saved);

    const status = readDevicePublicStatus({ homeDir });
    expect(status).toEqual({
      schemaVersion: 1,
      enrolled: true,
      issuer: 'https://platform.example.test',
      deviceExp: 1_900_000_000_000,
      savedAt: '2030-01-02T03:04:05.000Z',
    });
    expect(JSON.stringify(status)).not.toContain('access-secret');
    expect(JSON.stringify(status)).not.toContain('refresh-secret');
  });

  it('pins issuer across refresh writes until explicit logout', () => {
    const homeDir = tempHome();
    writeDeviceCredentials({
      issuer: 'https://one.example.test',
      accessToken: 'a1',
      accessExpiresAt: 1_800_000_000_000,
      refreshToken: 'r1',
      deviceExp: 1_900_000_000_000,
    }, { homeDir });

    expect(() => writeDeviceCredentials({
      issuer: 'https://two.example.test',
      accessToken: 'a2',
      accessExpiresAt: 1_800_000_000_001,
      refreshToken: 'r2',
      deviceExp: 1_900_000_000_001,
    }, { homeDir })).toThrowError(DeviceCredentialError);
    expect(readDeviceCredentials({ homeDir })?.issuer).toBe('https://one.example.test');

    expect(clearDeviceCredentials({ homeDir })).toBe(true);
    expect(clearDeviceCredentials({ homeDir })).toBe(false);
    expect(readDevicePublicStatus({ homeDir })).toEqual({ schemaVersion: 1, enrolled: false });
  });

  it('accepts HTTPS and loopback development HTTP but rejects ambiguous or cleartext issuers', () => {
    expect(normalizeDeviceIssuer('https://platform.example.test/')).toBe('https://platform.example.test');
    expect(normalizeDeviceIssuer('http://127.0.0.1:8787')).toBe('http://127.0.0.1:8787');
    expect(() => normalizeDeviceIssuer('http://platform.example.test')).toThrow(/HTTPS/);
    expect(() => normalizeDeviceIssuer('https://platform.example.test/base')).toThrow(/纯 origin/);
    expect(() => normalizeDeviceIssuer('https://user:pass@platform.example.test')).toThrow(/纯 origin/);
  });

  it('fails closed on permissive files and symlinks', () => {
    if (process.platform === 'win32') return;
    const homeDir = tempHome();
    const filePath = deviceCredentialsPath({ homeDir });
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, '{}', { mode: 0o600 });
    chmodSync(filePath, 0o644);
    expect(() => readDeviceCredentials({ homeDir })).toThrow(/0600/);

    rmSync(filePath);
    const target = join(homeDir, 'target.json');
    writeFileSync(target, '{}', { mode: 0o600 });
    symlinkSync(target, filePath);
    expect(() => readDeviceCredentials({ homeDir })).toThrow(/符号链接/);
    expect(() => clearDeviceCredentials({ homeDir })).toThrow(/符号链接/);
  });
});
