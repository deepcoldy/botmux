import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

// Counting settings-file reads is the only way to pin the gate ORDER: on an
// ordinary host the verdict is null either way, so only the syscall is
// observable. Wraps the real implementation — nothing is stubbed out.
vi.mock('node:fs', () => {
  // `require` inside the factory, not the vitest-only `importOriginal` argument
  // (bun passes none) and not a top-level import (vitest hoists this call above
  // the imports, so a top-level namespace would be read before initialisation).
  const actual = require('node:fs') as typeof import('node:fs');
  return { ...actual, default: actual, readFileSync: vi.fn(actual.readFileSync) };
});

import {
  devboxDashboardBaseUrl,
  ensureDevboxDashboardExport,
  resetDevboxDashboardExportCaches,
} from '../src/platform/devbox-dashboard-export.js';

const readSpy = vi.mocked(readFileSync);

function tmpDir() {
  const dir = mkdtempSync(join(tmpdir(), 'botmux-devbox-export-'));
  chmodSync(dir, 0o700);
  return dir;
}

function fixture() {
  return join(tmpDir(), 'cache.json');
}

const devboxEnv = {
  ARNOLD_WORKSPACE_ID: '103424',
  PORT_LIST: '10001,10002',
};

beforeEach(() => {
  // The read-side memo and the export negative cache are process-wide.
  resetDevboxDashboardExportCaches();
});

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
    expect(devboxDashboardBaseUrl({ cachePath, env: devboxEnv, port: 9001 })).toBe('https://devbox.example.com');
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
    expect(devboxDashboardBaseUrl({
      cachePath,
      port: 9001,
      env: { ...devboxEnv, ARNOLD_WORKSPACE_ID: 'other' },
    })).toBeNull();
    expect(devboxDashboardBaseUrl({
      cachePath,
      port: 9001,
      env: { ...devboxEnv, BOTMUX_DEVBOX_AUTO_EXPORT: '0' },
    })).toBeNull();
  });

  // PORT_LIST is the only reason 10001 is exportable — the 9001–9010 window does
  // not cover it. Without this case, replacing the whole PORT_LIST branch with
  // `return false` left the suite green.
  it('exports a port that only PORT_LIST allows', async () => {
    const runExport = vi.fn(async () => '{"short_url":"https://devbox.example.com","is_public":false}');
    await expect(ensureDevboxDashboardExport({
      port: 10001,
      remoteBaseConfigured: false,
      env: devboxEnv,
      cachePath: fixture(),
      merlinCliPath: '/fake/merlin-cli',
      runExport,
    })).resolves.toBe('https://devbox.example.com');
    expect(runExport).toHaveBeenCalledWith('/fake/merlin-cli', 10001, expect.any(Number));
  });

  it.each([
    ['ordinary host', { PORT_LIST: '10001' }, 9001],
    ['disabled', { ...devboxEnv, BOTMUX_DEVBOX_AUTO_EXPORT: '0' }, 9001],
    ['explicit remote base', devboxEnv, 9001, true],
    ['unsupported port', devboxEnv, 7891],
    // `Number('') === 0`, so a trailing comma used to make port 0 exportable.
    ['port 0 against a trailing-comma PORT_LIST', { ...devboxEnv, PORT_LIST: '10001,' }, 0],
  ])('does not spawn on %s', async (_name, env, port, remoteBaseConfigured = false) => {
    const runExport = vi.fn();
    await expect(ensureDevboxDashboardExport({
      port,
      remoteBaseConfigured,
      env,
      cachePath: fixture(),
      envFilePath: join(tmpDir(), 'absent.env'),
      merlinCliPath: '/fake/merlin-cli',
      runExport,
    })).resolves.toBeNull();
    expect(runExport).not.toHaveBeenCalled();
  });

  it.each([
    ['credentialed URL', '{"short_url":"https://user:pass@devbox.example.com","is_public":false}'],
    ['public export', '{"short_url":"https://devbox.example.com","is_public":true}'],
    ['malformed output', 'not json'],
    // A later private object must not override an earlier public verdict.
    ['public result followed by a private-looking object',
      '{"short_url":"https://devbox.example.com","is_public":true}\n{"short_url":"https://evil.example.com","is_public":false}'],
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

  // merlin-cli's output shape is outside this repo's control and stderr is mixed
  // in, so a brace anywhere in a warning used to break the whole parse.
  it.each([
    ['a brace inside a warning', 'Warning: config {legacy} deprecated\n{"short_url":"https://devbox.example.com","is_public":false}'],
    ['a JSON log line', '{"level":"warn","msg":"x"}\n{"short_url":"https://devbox.example.com","is_public":false}'],
    ['trailing prose with braces', '{"short_url":"https://devbox.example.com","is_public":false}\nNote {see docs}'],
    ['a nested object in the result', '{"short_url":"https://devbox.example.com","is_public":false,"meta":{"ttl":3600}}'],
    ['a brace inside a JSON string value', '{"short_url":"https://devbox.example.com","is_public":false,"note":"a { brace"}'],
  ])('parses the export result despite %s', async (_name, output) => {
    await expect(ensureDevboxDashboardExport({
      port: 9001,
      remoteBaseConfigured: false,
      env: devboxEnv,
      cachePath: fixture(),
      merlinCliPath: '/fake/merlin-cli',
      runExport: async () => output,
    })).resolves.toBe('https://devbox.example.com');
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

  // A hanging merlin-cli pays the full timeout. Repeating that on every caller
  // in the same process is what made `start` overrun its own 6s budget.
  it('does not re-spawn after a failure inside the negative-cache window', async () => {
    const cachePath = fixture();
    const runExport = vi.fn(async () => { throw new Error('timeout'); });
    const call = () => ensureDevboxDashboardExport({
      port: 9001,
      remoteBaseConfigured: false,
      env: devboxEnv,
      cachePath,
      merlinCliPath: '/fake/merlin-cli',
      runExport,
    });
    await expect(call()).resolves.toBeNull();
    await expect(call()).resolves.toBeNull();
    expect(runExport).toHaveBeenCalledTimes(1);
  });

  // The negative cache has TWO write sites: the runner rejecting (above) and the
  // runner resolving with output that cannot be parsed. Only the first was
  // covered, so removing the second's write left the suite green.
  it('does not re-spawn after an unparseable exit-0 export inside the window', async () => {
    const cachePath = fixture();
    const runExport = vi.fn(async () => 'merlin-cli: unexpected output');
    const call = () => ensureDevboxDashboardExport({
      port: 9001,
      remoteBaseConfigured: false,
      env: devboxEnv,
      cachePath,
      merlinCliPath: '/fake/merlin-cli',
      runExport,
    });
    await expect(call()).resolves.toBeNull();
    await expect(call()).resolves.toBeNull();
    expect(runExport).toHaveBeenCalledTimes(1);
  });

  // An ordinary host has no ARNOLD_WORKSPACE_ID, so the read side is reached
  // constantly from the CSRF hot path and must not touch the filesystem there:
  // the Devbox gates are checked before the switch, which may read ~/.botmux/.env.
  it('does not read the settings file on a non-Devbox host', () => {
    const envFilePath = join(tmpDir(), '.env');
    // The file EXISTS and disables the feature, so a regression cannot pass by
    // swallowing ENOENT — reading it would be observable below.
    writeFileSync(envFilePath, 'BOTMUX_DEVBOX_AUTO_EXPORT=0\n');
    const cachePath = fixture();
    const reads = () => readSpy.mock.calls.filter(([p]) => p === envFilePath).length;

    for (const env of [{}, { ARNOLD_WORKSPACE_ID: 'ws' }, { PORT_LIST: '9001' }]) {
      resetDevboxDashboardExportCaches();
      readSpy.mockClear();
      expect(devboxDashboardBaseUrl({ cachePath, env, envFilePath, port: 9001 })).toBeNull();
      expect(reads()).toBe(0);
    }

    // On a real Devbox the switch IS consulted, which is what pins the ordering
    // as an optimization rather than a behaviour change: same null verdict, but
    // this time the file was actually read.
    resetDevboxDashboardExportCaches();
    readSpy.mockClear();
    expect(devboxDashboardBaseUrl({
      cachePath,
      env: devboxEnv,
      envFilePath,
      port: 9001,
    })).toBeNull();
    expect(reads()).toBe(1);
  });

  it('reads the disable switch from ~/.botmux/.env when the CLI never dotenv-loads it', async () => {
    const dir = tmpDir();
    const envFilePath = join(dir, '.env');
    writeFileSync(envFilePath, 'LARK_APP_SECRET=must-not-leak\nBOTMUX_DEVBOX_AUTO_EXPORT=0\n');
    const runExport = vi.fn();

    await expect(ensureDevboxDashboardExport({
      port: 9001,
      remoteBaseConfigured: false,
      env: devboxEnv,
      cachePath: join(dir, 'cache.json'),
      envFilePath,
      merlinCliPath: '/fake/merlin-cli',
      runExport,
    })).resolves.toBeNull();
    expect(runExport).not.toHaveBeenCalled();
    // Only that one key is consulted; nothing from the file enters process.env.
    expect(process.env.LARK_APP_SECRET).toBeUndefined();

    // An inline value still wins over the file, matching dotenv precedence.
    await expect(ensureDevboxDashboardExport({
      port: 9001,
      remoteBaseConfigured: false,
      env: { ...devboxEnv, BOTMUX_DEVBOX_AUTO_EXPORT: '1' },
      cachePath: join(dir, 'cache.json'),
      envFilePath,
      merlinCliPath: '/fake/merlin-cli',
      runExport: async () => '{"short_url":"https://devbox.example.com","is_public":false}',
    })).resolves.toBe('https://devbox.example.com');
  });
});

describe('devboxDashboardBaseUrl', () => {
  async function seedCache(port: number) {
    const cachePath = fixture();
    await ensureDevboxDashboardExport({
      port,
      remoteBaseConfigured: false,
      env: devboxEnv,
      cachePath,
      merlinCliPath: '/fake/merlin-cli',
      runExport: async () => `{"short_url":"https://tunnel-for-${port}.example.com","is_public":false}`,
    });
    return cachePath;
  }

  // The dashboard probes upward on EADDRINUSE, so a cache written for 9001 can
  // outlive the bind it was made for. The read side used to ignore the port
  // entirely and keep advertising (and trusting) that stale tunnel.
  it('rejects a cache written for a different dashboard port', async () => {
    const cachePath = await seedCache(9001);
    expect(devboxDashboardBaseUrl({ cachePath, env: devboxEnv, port: 9001 }))
      .toBe('https://tunnel-for-9001.example.com');
    expect(devboxDashboardBaseUrl({ cachePath, env: devboxEnv, port: 9002 })).toBeNull();
  });

  it('resolves the port from .dashboard-port when the caller does not pass one', async () => {
    const cachePath = await seedCache(9001);
    const portFilePath = join(tmpDir(), '.dashboard-port');

    writeFileSync(portFilePath, '9001\n');
    expect(devboxDashboardBaseUrl({ cachePath, env: devboxEnv, portFilePath }))
      .toBe('https://tunnel-for-9001.example.com');

    writeFileSync(portFilePath, '9002\n');
    expect(devboxDashboardBaseUrl({ cachePath, env: devboxEnv, portFilePath })).toBeNull();
  });

  it('falls back to BOTMUX_DASHBOARD_PORT when no port file exists', async () => {
    const cachePath = await seedCache(9002);
    const portFilePath = join(tmpDir(), 'absent-port');
    expect(devboxDashboardBaseUrl({
      cachePath,
      portFilePath,
      env: { ...devboxEnv, BOTMUX_DASHBOARD_PORT: '9002' },
    })).toBe('https://tunnel-for-9002.example.com');
    expect(devboxDashboardBaseUrl({
      cachePath,
      portFilePath,
      env: { ...devboxEnv, BOTMUX_DASHBOARD_PORT: '9001' },
    })).toBeNull();
  });
});
