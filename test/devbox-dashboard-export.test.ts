import { chmodSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  devboxDashboardBaseUrl,
  ensureDevboxDashboardExport,
} from '../src/platform/devbox-dashboard-export.js';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'botmux-devbox-export-'));
  chmodSync(dir, 0o700);
  return join(dir, 'cache.json');
}

const devboxEnv = {
  ARNOLD_WORKSPACE_ID: '103424',
  PORT_LIST: '10001,10002',
};

describe('ensureDevboxDashboardExport', () => {
  it('parses warning-prefixed private export output and persists a reusable cache', async () => {
    const cachePath = fixture();
    const runExport = vi.fn(async () => 'Warning: upgrade available\n{"short_url":"https://devbox.example.com","is_public":false}\n');

    await expect(ensureDevboxDashboardExport({
      port: 9001,
      remoteBaseConfigured: false,
      env: devboxEnv,
      cachePath,
      merlinCliPath: '/fake/merlin-cli',
      runExport,
    })).resolves.toBe('https://devbox.example.com');
    await expect(ensureDevboxDashboardExport({
      port: 9001,
      remoteBaseConfigured: false,
      env: devboxEnv,
      cachePath,
      merlinCliPath: '/fake/merlin-cli',
      runExport,
    })).resolves.toBe('https://devbox.example.com');

    expect(runExport).toHaveBeenCalledTimes(1);
    expect(devboxDashboardBaseUrl(cachePath, devboxEnv)).toBe('https://devbox.example.com');
    expect(readFileSync(cachePath, 'utf8')).not.toContain('token');
  });

  it('does not reuse a cache outside its workspace or after auto-export is disabled', async () => {
    const cachePath = fixture();
    await ensureDevboxDashboardExport({
      port: 9001,
      remoteBaseConfigured: false,
      env: devboxEnv,
      cachePath,
      merlinCliPath: '/fake/merlin-cli',
      runExport: async () => '{"short_url":"https://devbox.example.com","is_public":false}',
    });
    expect(devboxDashboardBaseUrl(cachePath, { ...devboxEnv, ARNOLD_WORKSPACE_ID: 'other' })).toBeNull();
    expect(devboxDashboardBaseUrl(cachePath, { ...devboxEnv, BOTMUX_DEVBOX_AUTO_EXPORT: '0' })).toBeNull();
  });

  it.each([
    ['ordinary host', { PORT_LIST: '10001' }, 9001],
    ['disabled', { ...devboxEnv, BOTMUX_DEVBOX_AUTO_EXPORT: '0' }, 9001],
    ['explicit remote base', devboxEnv, 9001, true],
    ['unsupported port', devboxEnv, 7891],
  ])('does not spawn on %s', async (_name, env, port, remoteBaseConfigured = false) => {
    const runExport = vi.fn();
    await expect(ensureDevboxDashboardExport({
      port,
      remoteBaseConfigured,
      env,
      cachePath: fixture(),
      merlinCliPath: '/fake/merlin-cli',
      runExport,
    })).resolves.toBeNull();
    expect(runExport).not.toHaveBeenCalled();
  });

  it.each([
    ['credentialed URL', '{"short_url":"https://user:pass@devbox.example.com","is_public":false}'],
    ['public export', '{"short_url":"https://devbox.example.com","is_public":true}'],
    ['malformed output', 'not json'],
  ])('fails closed for %s', async (_name, output) => {
    await expect(ensureDevboxDashboardExport({
      port: 9001,
      remoteBaseConfigured: false,
      env: devboxEnv,
      cachePath: fixture(),
      merlinCliPath: '/fake/merlin-cli',
      runExport: async () => output,
    })).resolves.toBeNull();
  });

  it('fails softly when the export runner rejects', async () => {
    await expect(ensureDevboxDashboardExport({
      port: 9001,
      remoteBaseConfigured: false,
      env: devboxEnv,
      cachePath: fixture(),
      merlinCliPath: '/fake/merlin-cli',
      runExport: async () => { throw new Error('timeout'); },
    })).resolves.toBeNull();
  });
});
