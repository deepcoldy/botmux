import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSyncBunTsEvalWithRepoImports } from './helpers/ts-runner.js';

describe('dashboard update errors', () => {
  it('distinguishes lock infrastructure failures, contention and install failures, then accepts a retry', () => {
    const root = mkdtempSync(join(tmpdir(), 'botmux-dashboard-update-errors-'));
    const home = join(root, 'home');
    const botmuxDir = join(home, '.botmux');
    const dataDir = join(botmuxDir, 'data');
    const botsConfig = join(botmuxDir, 'bots.json');
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(botsConfig, '[]');
    writeFileSync(join(botmuxDir, '.data-dir'), dataDir, { mode: 0o600 });

    try {
      const child = spawnSyncBunTsEvalWithRepoImports(`
        import { mock } from 'bun:test';
        import { mkdirSync, readFileSync } from 'node:fs';
        import { dirname, join } from 'node:path';
        import { homedir } from 'node:os';
        import { FileLockTimeoutError, withFileLock } from './src/utils/file-lock.js';
        import { loopbackFetch } from './src/core/loopback-fetch.js';
        import { loadOrCreatePersistedToken } from './src/dashboard/auth.js';

        const botmuxDir = join(homedir(), '.botmux');
        const lockTarget = join(homedir(), 'update-lock', 'install');
        let installError = new Error('binary checksum mismatch');
        const installInfo = { ...await import('./src/utils/install-info.js') };
        mock.module('./src/utils/install-info.js', () => ({
          ...installInfo,
          isLocalDevInstall: () => false,
        }));
        const binaryUpdate = { ...await import('./src/core/binary-self-update.js') };
        mock.module('./src/core/binary-self-update.js', () => ({
          ...binaryUpdate,
          currentUpdateStrategy: () => ({ kind: 'self-replace', target: join(homedir(), 'botmux') }),
          replaceStandaloneBinary: async () => { if (installError) throw installError; },
        }));
        const updateCheck = { ...await import('./src/core/update-check.js') };
        mock.module('./src/core/update-check.js', () => ({
          ...updateCheck,
          fetchLatestVersion: async () => '3.41.0',
        }));
        const maintenance = { ...await import('./src/core/maintenance.js') };
        mock.module('./src/core/maintenance.js', () => ({
          ...maintenance,
          globalInstallUpdateLockTarget: () => lockTarget,
        }));

        const token = loadOrCreatePersistedToken(join(botmuxDir, '.dashboard-token'));
        await import('./src/index-dashboard.js');
        let port;
        const deadline = Date.now() + 10_000;
        while (!port && Date.now() < deadline) {
          try { port = Number(readFileSync(join(botmuxDir, '.dashboard-port'), 'utf8')); }
          catch { await new Promise(resolve => setTimeout(resolve, 20)); }
        }
        if (!port) throw new Error('dashboard did not publish its port');
        const update = async () => {
          const response = await loopbackFetch('http://127.0.0.1:' + port + '/api/update/run', {
            method: 'POST',
            headers: { cookie: 'botmux_dashboard_token=' + token },
            signal: AbortSignal.timeout(5_000),
          });
          return { status: response.status, body: await response.json() };
        };

        const infrastructureFailure = await update();
        mkdirSync(dirname(lockTarget));
        const contention = await withFileLock(lockTarget, update);
        const installFailure = await update();
        installError = new FileLockTimeoutError('nested-install.lock', 123, 20);
        const nestedTimeout = await update();
        installError = null;
        const recovered = await update();
        console.log('UPDATE_RESULTS=' + JSON.stringify({
          infrastructureFailure, contention, installFailure, nestedTimeout, recovered,
        }));
        process.exit(0);
      `, {
        cwd: process.cwd(),
        encoding: 'utf8',
        timeout: 25_000,
        killSignal: 'SIGKILL',
        env: {
          ...process.env,
          HOME: home,
          USERPROFILE: home,
          SESSION_DATA_DIR: dataDir,
          BOTS_CONFIG: botsConfig,
          BOTMUX_DASHBOARD_PORT: '7891',
          BOTMUX_DASHBOARD_HOST: '127.0.0.1',
          BOTMUX_DASHBOARD_PUBLIC_READONLY: 'false',
        },
      });
      expect(child.error).toBeUndefined();
      expect(child.status, String(child.stderr)).toBe(0);
      const line = String(child.stdout).split('\n').find(line => line.startsWith('UPDATE_RESULTS='));
      expect(line, String(child.stdout)).toBeDefined();
      expect(JSON.parse(line!.slice('UPDATE_RESULTS='.length))).toMatchObject({
        infrastructureFailure: {
          status: 500,
          body: { ok: false, error: 'install_failed', detail: expect.stringContaining('ENOENT') },
        },
        contention: { status: 409, body: { ok: false, error: 'update_in_flight' } },
        installFailure: {
          status: 500,
          body: { ok: false, error: 'install_failed', detail: 'binary checksum mismatch' },
        },
        nestedTimeout: {
          status: 500,
          body: {
            ok: false,
            error: 'install_failed',
            detail: 'file-lock timeout waiting for nested-install.lock (held by pid 123, age 20ms)',
          },
        },
        recovered: { status: 200, body: { ok: true, newVersion: '3.41.0', manager: 'binary' } },
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
