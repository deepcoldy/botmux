import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSyncBunTsEvalWithRepoImports } from './helpers/ts-runner.js';

describe('dashboard implicit binary updates', () => {
  it('reports source over HTTP, skips older/equal releases and installs a newer release', () => {
    const root = mkdtempSync(join(tmpdir(), 'botmux-update-direction-'));
    const home = join(root, 'home');
    const botmuxDir = join(home, '.botmux');
    const dataDir = join(botmuxDir, 'data');
    mkdirSync(dataDir, { recursive: true });
    const botsConfig = join(botmuxDir, 'bots.json');
    writeFileSync(botsConfig, '[]');
    writeFileSync(join(botmuxDir, '.data-dir'), dataDir);
    try {
      const child = spawnSyncBunTsEvalWithRepoImports(`
        import { mock } from 'bun:test';
        import { readFileSync, writeFileSync } from 'node:fs';
        import { join } from 'node:path';
        import { homedir } from 'node:os';
        import { Readable } from 'node:stream';
        import { createHash } from 'node:crypto';
        import { loopbackFetch } from './src/core/loopback-fetch.js';
        import { loadOrCreatePersistedToken } from './src/dashboard/auth.js';
        import { updateAndRestartBotmux } from './src/dashboard/web/update-action.js';
        const botmuxDir = join(homedir(), '.botmux');
        const target = join(botmuxDir, 'candidate');
        writeFileSync(target, 'CURRENT');
        let lookups = 0;
        let downloads = 0;
        let version = '3.47.0';
        let source = 'configured-fallback';
        const diagnostics = { ...await import('./src/utils/install-diagnostics.js') };
        mock.module('./src/utils/install-diagnostics.js', () => ({
          ...diagnostics, resolveCurrentVersion: () => '3.48.0',
        }));
        const installInfo = { ...await import('./src/utils/install-info.js') };
        mock.module('./src/utils/install-info.js', () => ({ ...installInfo, isLocalDevInstall: () => false }));
        const updateCheck = { ...await import('./src/core/update-check.js') };
        mock.module('./src/core/update-check.js', () => ({
          ...updateCheck,
          fetchReleaseLatestVersion: async () => { lookups++; return { version, source }; },
        }));
        const binaryUpdate = { ...await import('./src/core/binary-self-update.js') };
        const apply = binaryUpdate.applyStandaloneUpdate;
        const payload = Buffer.alloc(1_100_000, 0x42);
        mock.module('./src/core/binary-self-update.js', () => ({
          ...binaryUpdate,
          currentUpdateStrategy: () => ({ kind: 'self-replace', target }),
          applyStandaloneUpdate: (resolved, request, deps) => apply(resolved, request, {
            ...deps,
            fetchStream: async () => { downloads++; return Readable.from([payload]); },
            fetchChecksum: async () => createHash('sha256').update(payload).digest('hex'),
            probeBinary: () => ({ status: 0, stdout: resolved }),
          }),
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
        const request = async (path, method = 'GET') => {
          const response = await loopbackFetch('http://127.0.0.1:' + port + path, {
            method, headers: { cookie: 'botmux_dashboard_token=' + token }, signal: AbortSignal.timeout(5_000),
          });
          return { status: response.status, body: await response.json() };
        };
        const fallback = await request('/api/update/status?refresh=1');
        const older = await request('/api/update/run', 'POST');
        const updatePaths = [];
        const updatePhases = [];
        const clientSkipped = await updateAndRestartBotmux(async (path, init) => {
          updatePaths.push(path);
          if (path === '/api/update/restart') throw new Error('skipped update must not request restart');
          return loopbackFetch('http://127.0.0.1:' + port + path, {
            ...init, headers: { ...init?.headers, cookie: 'botmux_dashboard_token=' + token },
            signal: AbortSignal.timeout(5_000),
          });
        }, phase => updatePhases.push(phase));
        version = '3.48.0';
        await request('/api/update/status?refresh=1');
        const equal = await request('/api/update/run', 'POST');
        const unchanged = readFileSync(target, 'utf8') === 'CURRENT';
        const skippedDownloads = downloads;
        // Manual refreshes must not advance automatic fallback backoff to 5m.
        const realNow = Date.now;
        const beforeRetry = lookups;
        Date.now = () => realNow() + 61_000;
        await request('/api/update/status');
        Date.now = realNow;
        const retriedAfterMinute = lookups === beforeRetry + 1;
        source = 'public'; version = '3.49.0';
        const publicStatus = await request('/api/update/status?refresh=1');
        const newer = await request('/api/update/run', 'POST');
        console.log('UPDATE_RESULTS=' + JSON.stringify({
          fallback, older, equal, unchanged, skippedDownloads, retriedAfterMinute,
          clientSkipped, updatePaths, updatePhases,
          publicStatus, newer, downloads, installed: readFileSync(target).equals(payload),
        }));
        process.exit(0);
      `, {
        cwd: process.cwd(), encoding: 'utf8', timeout: 25_000, killSignal: 'SIGKILL',
        env: { ...process.env, HOME: home, USERPROFILE: home, SESSION_DATA_DIR: dataDir,
          BOTS_CONFIG: botsConfig, BOTMUX_DASHBOARD_PORT: '0', BOTMUX_DASHBOARD_HOST: '127.0.0.1',
          BOTMUX_DASHBOARD_PUBLIC_READONLY: 'false' },
      });
      expect(child.error).toBeUndefined();
      expect(child.status, String(child.stderr)).toBe(0);
      const line = String(child.stdout).split('\n').find(line => line.startsWith('UPDATE_RESULTS='));
      expect(line, String(child.stdout)).toBeDefined();
      expect(JSON.parse(line!.slice('UPDATE_RESULTS='.length))).toMatchObject({
        fallback: { status: 200, body: { latest: '3.47.0', latestSource: 'configured-fallback', behind: false } },
        older: { status: 200, body: { ok: true, skipped: 'already_latest', newVersion: '3.48.0', changed: false, restartRequired: false } },
        equal: { status: 200, body: { ok: true, skipped: 'already_latest', changed: false, restartRequired: false } },
        unchanged: true, skippedDownloads: 0, retriedAfterMinute: true,
        clientSkipped: { oldVersion: '3.48.0', newVersion: '3.48.0', changed: false, restarted: false },
        updatePaths: ['/api/update/run'], updatePhases: ['updating'],
        publicStatus: { status: 200, body: { latest: '3.49.0', latestSource: 'public', behind: true } },
        newer: { status: 200, body: { ok: true, newVersion: '3.49.0', changed: true, restartRequired: true, source: 'github-release' } },
        downloads: 1, installed: true,
      });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
