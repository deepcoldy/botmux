import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { spawnSyncBunTsEvalWithRepoImports } from './helpers/ts-runner.js';

it('installs a verified release without Git or shared dependency writes and restarts that binary only after confirmation', () => {
  const root = mkdtempSync(join(tmpdir(), 'dashboard-source-release-'));
  const home = join(root, 'home'), source = join(root, 'source'), shared = join(root, 'shared');
  const config = join(home, '.botmux'), data = join(config, 'data');
  mkdirSync(join(config, 'bin'), { recursive: true, mode: 0o700 });
  mkdirSync(data, { recursive: true, mode: 0o700 }); mkdirSync(source); mkdirSync(shared);
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', ...args], { cwd: source, stdio: 'ignore' });
  git('init'); writeFileSync(join(source, 'package.json'), '{"name":"botmux"}');
  writeFileSync(join(source, 'custom.txt'), 'committed customization'); git('add', '.'); git('commit', '-m', 'custom');
  writeFileSync(join(source, 'custom.txt'), 'uncommitted customization');
  writeFileSync(join(source, '.gitignore'), 'node_modules\n');
  symlinkSync(shared, join(source, 'node_modules')); writeFileSync(join(shared, 'sentinel'), 'live dependency');
  writeFileSync(join(config, 'bots.json'), '[]'); writeFileSync(join(config, '.data-dir'), data, { mode: 0o600 });
  writeFileSync(join(config, 'bin/botmux'), `#!/bin/sh\nexec "/bin/bun" "${source}/dist/cli.js" "$@"\n`);
  try {
    const child = spawnSyncBunTsEvalWithRepoImports(`
      import { mock } from 'bun:test';
      import { createHash } from 'node:crypto';
      import { readFileSync, writeFileSync } from 'node:fs';
      import { join } from 'node:path';
      import { homedir } from 'node:os';
      import { Readable } from 'node:stream';
      import { loopbackFetch } from './src/core/loopback-fetch.js';
      import { loadOrCreatePersistedToken } from './src/dashboard/auth.js';
      const config = join(homedir(), '.botmux');
      const sourceRoot = process.env.SOURCE_TEST_ROOT;
      const info = { ...await import('./src/utils/install-info.js') };
      mock.module('./src/utils/install-info.js', () => ({ ...info,
        isLocalDevInstall: () => true, botmuxInstallRoot: () => sourceRoot,
      }));
      const diagnostics = { ...await import('./src/utils/install-diagnostics.js') };
      mock.module('./src/utils/install-diagnostics.js', () => ({ ...diagnostics,
        resolveCurrentVersion: () => '3.59.27', resolveCurrentVersionAt: () => '3.59.27',
      }));
      let version = '3.59.27';
      const checks = { ...await import('./src/core/update-check.js') };
      mock.module('./src/core/update-check.js', () => ({ ...checks,
        fetchReleaseLatestVersion: async () => ({ version, source: 'public' }),
      }));
      const spawn = { ...await import('./src/dashboard/managed-spawn.js') };
      const gitSteps = [];
      mock.module('./src/dashboard/managed-spawn.js', () => ({ ...spawn,
        runLocalDevStep: async (_dir, command, args) => { gitSteps.push([command, args]); throw new Error('Git network timeout'); },
      }));
      const payload = Buffer.alloc(1_100_000, 0x42);
      let downloads = 0, checksumFails = true;
      const binary = { ...await import('./src/core/binary-self-update.js') };
      mock.module('./src/core/binary-self-update.js', () => ({ ...binary,
        applyStandaloneUpdate: (resolved, request, deps) => binary.applyStandaloneUpdate(resolved, request, {
          ...deps, fetchStream: async () => { downloads++; return Readable.from([payload]); },
          fetchChecksum: async () => checksumFails ? '0'.repeat(64) : createHash('sha256').update(payload).digest('hex'),
          probeBinary: () => ({ status: 0, stdout: resolved }),
        }),
      }));
      const maintenance = { ...await import('./src/core/maintenance.js') };
      const restarts = [];
      mock.module('./src/core/maintenance.js', () => ({ ...maintenance,
        verifyBinaryRestartTarget: pending => {
          if (!pending || typeof pending.target !== 'string' || pending.version !== version) throw new Error('invalid binary verifier request');
          return version;
        },
        spawnDetachedRestart: (...args) => { restarts.push(args); return { pid: 12345 }; },
      }));
      const token = loadOrCreatePersistedToken(join(config, '.dashboard-token'));
      const original = readFileSync(join(config, 'bin/botmux'), 'utf8');
      await import('./src/index-dashboard.js');
      let port;
      const deadline = Date.now() + 10_000;
      while (!port && Date.now() < deadline) {
        try { port = Number(readFileSync(join(config, '.dashboard-port'), 'utf8')); }
        catch { await new Promise(resolve => setTimeout(resolve, 20)); }
      }
      if (!port) throw new Error('dashboard did not start');
      async function request(path, body, auth = true, method = 'POST') {
        const response = await loopbackFetch('http://127.0.0.1:' + port + path, {
          method, headers: { ...(auth ? { cookie: 'botmux_dashboard_token=' + token } : {}),
            ...(body ? { 'content-type': 'application/json' } : {}) },
          ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(10_000),
        });
        const text = await response.text();
        try { return { status: response.status, body: JSON.parse(text) }; }
        catch {
          if (!response.ok) return { status: response.status, body: {} };
          throw new Error(path + ' status=' + response.status + ' body=' + text.slice(0, 120));
        }
      }
      const status = await request('/api/update/status', null, true, 'GET');
      const dirty = await request('/api/update/run');
      const unauthorized = await request('/api/update/run', { installRelease: true, version }, false);
      const invalid = await request('/api/update/run', { installRelease: true, version, forceLocal: true });
      const stale = await request('/api/update/run', { installRelease: true, version: '3.59.26' });
      const failed = await request('/api/update/run', { installRelease: true, version });
      const preservedAfterFailure = readFileSync(join(config, 'bin/botmux'), 'utf8') === original;
      checksumFails = false;
      const installed = await request('/api/update/run', { installRelease: true, version });
      const pending = await request('/api/update/status', null, true, 'GET');
      const originalBackup = readFileSync(installed.body.backupLauncher, 'utf8');
      const sourcePreserved = readFileSync(join(sourceRoot, 'custom.txt'), 'utf8') === 'uncommitted customization';
      const dependencyPreserved = readFileSync(join(sourceRoot, 'node_modules/sentinel'), 'utf8') === 'live dependency';
      const restartsBeforeConfirmation = restarts.length;
      const duplicate = await request('/api/update/run', { installRelease: true, version });
      const anotherUpdate = await request('/api/update/run');
      writeFileSync(join(config, 'bin/botmux'), original.replace('/bin/bun', '/different/bun'));
      const sourceRestored = await request('/api/update/status', null, true, 'GET');
      const installedAgain = await request('/api/update/run', { installRelease: true, version });
      const restarted = await request('/api/update/restart', { update: { oldVersion: '3.59.27', newVersion: '3.59.27' } });
      await new Promise(resolve => setTimeout(resolve, 25));
      console.log('SOURCE_RELEASE_RESULTS=' + JSON.stringify({
        status, dirty, unauthorized, invalid, stale, failed, preservedAfterFailure,
        installed, pending, downloads, gitSteps, sourcePreserved, dependencyPreserved,
        originalBackupMatches: originalBackup === original, restartsBeforeConfirmation, duplicate, anotherUpdate, sourceRestored, installedAgain,
        restarted, restartBinary: restarts[0]?.[3],
        installedBytesMatch: readFileSync(join(config, 'bin/botmux')).equals(payload),
      }));
      process.exit(0);
    `, { cwd: process.cwd(), encoding: 'utf8', timeout: 40_000, killSignal: 'SIGKILL', env: {
      ...process.env, HOME: home, USERPROFILE: home, SESSION_DATA_DIR: data,
      BOTS_CONFIG: join(config, 'bots.json'), SOURCE_TEST_ROOT: source,
      BOTMUX_DASHBOARD_PORT: '0', BOTMUX_DASHBOARD_HOST: '127.0.0.1', BOTMUX_DASHBOARD_PUBLIC_READONLY: 'false',
    } });
    expect(child.error).toBeUndefined();
    expect(child.status, String(child.stderr)).toBe(0);
    const line = String(child.stdout).split('\n').find(value => value.startsWith('SOURCE_RELEASE_RESULTS='));
    expect(line, String(child.stdout)).toBeDefined();
    expect(JSON.parse(line!.slice('SOURCE_RELEASE_RESULTS='.length))).toMatchObject({
      status: { status: 200, body: { sourceReleaseAvailable: true, localDevInstall: true } },
      dirty: { status: 409, body: { error: 'dirty_worktree' } },
      unauthorized: { status: 401 }, invalid: { status: 400 },
      stale: { status: 409, body: { error: 'source_release_version_changed' } },
      failed: { status: 500 }, preservedAfterFailure: true,
      installed: { status: 200, body: { ok: true, changed: true, newVersion: '3.59.27', restartRequired: true, sourceReleaseInstalled: true } },
      pending: { status: 200, body: { current: '3.59.27', localDevInstall: false, updateManager: 'binary', sourceReleasePending: true } },
      downloads: 3, gitSteps: [], sourcePreserved: true, dependencyPreserved: true,
      originalBackupMatches: true, restartsBeforeConfirmation: 0,
      duplicate: { status: 409, body: { error: 'source_release_restart_required' } },
      anotherUpdate: { status: 409, body: { error: 'source_release_restart_required' } },
      sourceRestored: { status: 200, body: { localDevInstall: true, sourceReleaseAvailable: true, sourceReleasePending: false } },
      installedAgain: { status: 200, body: { restartRequired: true } },
      restarted: { status: 202, body: { ok: true } },
      restartBinary: join(config, 'bin/botmux'), installedBytesMatch: true,
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 60_000);
