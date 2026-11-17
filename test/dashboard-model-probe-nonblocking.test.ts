import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { spawnSyncBunTsEvalWithRepoImports } from './helpers/ts-runner.js';

describe('Dashboard HTTP probe isolation', () => {
  it('serves a required configuration read while model executable discovery is still waiting', () => {
    const home = mkdtempSync(join(tmpdir(), 'botmux-model-probe-'));
    const dir = join(home, '.botmux');
    mkdirSync(join(dir, 'data'), { recursive: true });
    writeFileSync(join(dir, 'bots.json'), '[]');
    try {
      const child = spawnSyncBunTsEvalWithRepoImports(`
        import { mock } from 'bun:test';
        import { readFileSync } from 'node:fs';
        import { homedir } from 'node:os';
        import { join } from 'node:path';
        import { loopbackFetch } from './src/core/loopback-fetch.js';
        import { loadOrCreatePersistedToken } from './src/dashboard/auth.js';
        const registry = { ...await import('./src/adapters/cli/registry.js') };
        let begin;
        let lookups = 0;
        const started = new Promise(resolve => { begin = resolve; });
        let release;
        const lookup = new Promise(resolve => { release = resolve; });
        mock.module('./src/adapters/cli/registry.js', () => ({
          ...registry,
          resolveCommandAsync: async () => { lookups++; begin(); return lookup; },
          createCliAdapterSync: id => id === 'codex'
            ? { detectModels: async () => ['fixture-live-model'] }
            : {},
        }));
        const dir = join(homedir(), '.botmux');
        const token = loadOrCreatePersistedToken(join(dir, '.dashboard-token'));
        await import('./src/index-dashboard.js');
        let port;
        for (let n = 0; n < 500 && !port; n++) {
          try { port = Number(readFileSync(join(dir, '.dashboard-port'), 'utf8')); }
          catch { await new Promise(resolve => setTimeout(resolve, 20)); }
        }
        if (!port) throw new Error('dashboard_not_started');
        const request = path => loopbackFetch('http://127.0.0.1:' + port + path, {
          headers: { cookie: 'botmux_dashboard_token=' + token }, signal: AbortSignal.timeout(5000),
        });
        const slow = request('/api/cli-options/models?key=codex');
        await started;
        // Complete a real HTTP request BEFORE releasing executable discovery.
        const fast = await request('/api/cli-options?probe=none');
        if (fast.status !== 200) throw new Error('required_read_failed');
        await fast.json();
        release({ resolved: '/fixture/codex', inconclusive: false });
        const models = await slow;
        const result = await models.json();
        if (models.status !== 200 || result.models?.[0] !== 'fixture-live-model') throw new Error('probe_failed');
        const staticOnly = await request('/api/cli-options/models?key=claude-code');
        const staticResult = await staticOnly.json();
        if (staticOnly.status !== 200 || !staticResult.models?.includes('sonnet')) throw new Error('static_catalog_failed');
        if (lookups !== 1) throw new Error('static_only_cli_started_executable_discovery');
        console.log('HTTP_PROBE_NONBLOCKING_OK');
        process.exit(0);
      `, { env: { ...process.env, HOME: home, SESSION_DATA_DIR: join(dir, 'data'), BOTMUX_BOTS_CONFIG: join(dir, 'bots.json'), BOTMUX_DASHBOARD_PORT: '0' }, timeout: 30000 });
      expect(child.status, `${child.stderr}\n${child.stdout}`).toBe(0);
      const stdout = typeof child.stdout === 'string' ? child.stdout : Buffer.from(child.stdout ?? []).toString('utf8');
      expect(stdout).toContain('HTTP_PROBE_NONBLOCKING_OK');
    } finally { rmSync(home, { recursive: true, force: true }); }
  }, 45000);
});
