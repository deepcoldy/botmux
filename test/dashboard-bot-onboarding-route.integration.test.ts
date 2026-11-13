import { randomInt } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { spawnSyncTsEvalWithRepoImports } from './helpers/ts-runner.js';

describe('Dashboard bot onboarding HTTP route', () => {
  it('defaults legacy requests to web, forwards explicit modes, and rejects unknown modes', () => {
    const home = mkdtempSync(join(tmpdir(), 'botmux-onboarding-route-'));
    const botmuxDir = join(home, '.botmux');
    const dataDir = join(botmuxDir, 'data');
    const botsPath = join(botmuxDir, 'bots.json');
    try {
      mkdirSync(dataDir, { recursive: true });
      writeFileSync(botsPath, '[]');
      writeFileSync(join(botmuxDir, '.data-dir'), dataDir, { mode: 0o600 });

      const child = spawnSyncTsEvalWithRepoImports(`
        import { readFileSync } from 'node:fs';
        import { homedir } from 'node:os';
        import { join } from 'node:path';
        import { loopbackFetch } from './src/core/loopback-fetch.js';
        import { loadOrCreatePersistedToken } from './src/dashboard/auth.js';
        import { BotOnboardingManager } from './src/dashboard/bot-onboarding.js';

        // Stop at the HTTP-to-manager boundary so no test sends a registration request.
        const startedModes = [];
        BotOnboardingManager.prototype.start = function (input) {
          startedModes.push(input.registrationMode);
          return { id: 'test-job', done: Promise.resolve() };
        };
        BotOnboardingManager.prototype.get = id => ({ id, status: 'starting' });

        const botmuxDir = join(homedir(), '.botmux');
        const token = loadOrCreatePersistedToken(join(botmuxDir, '.dashboard-token'));
        await import('./src/index-dashboard.js');

        let port;
        const deadline = Date.now() + 10_000;
        while (!port && Date.now() < deadline) {
          try { port = Number(readFileSync(join(botmuxDir, '.dashboard-port'), 'utf8')); }
          catch { await new Promise(resolve => setTimeout(resolve, 20)); }
        }
        if (!port) throw new Error('dashboard did not publish its port');

        const origin = 'http://127.0.0.1:' + port;
        const responses = [];
        for (const registrationMode of [undefined, 'sdk', 'web', 'compat', 'unknown']) {
          const response = await loopbackFetch(origin + '/api/bot-onboarding/start', {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              cookie: 'botmux_dashboard_token=' + token,
              origin,
            },
            body: JSON.stringify({ cliId: 'mira', workingDir: homedir(), registrationMode }),
            signal: AbortSignal.timeout(3_000),
          });
          responses.push({ status: response.status, body: await response.json() });
        }
        console.log('ONBOARDING_RESULTS=' + JSON.stringify({ startedModes, responses }));
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
          BOTS_CONFIG: botsPath,
          BOTMUX_DASHBOARD_PORT: String(randomInt(20_000, 40_000)),
          BOTMUX_DASHBOARD_HOST: '127.0.0.1',
          BOTMUX_DASHBOARD_PUBLIC_READONLY: 'false',
        },
      });
      expect(child.error).toBeUndefined();
      expect(child.status, String(child.stderr)).toBe(0);
      const prefix = 'ONBOARDING_RESULTS=';
      const line = String(child.stdout).split('\n').find(line => line.startsWith(prefix));
      expect(line, String(child.stdout)).toBeDefined();
      const accepted = { status: 202, body: { job: { id: 'test-job' } } };
      expect(JSON.parse(line!.slice(prefix.length))).toMatchObject({
        startedModes: ['web', 'sdk', 'web', 'compat'],
        responses: [
          accepted, accepted, accepted, accepted,
          { status: 400, body: { ok: false, error: 'invalid_registration_mode' } },
        ],
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
