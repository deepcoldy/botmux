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
        const startedInputs = [];
        BotOnboardingManager.prototype.start = function (input) {
          startedInputs.push(input);
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
        for (const autoAvoidApproval of [true, false]) {
          const response = await loopbackFetch(origin + '/api/bot-onboarding/start', {
            method: 'POST',
            headers: { 'content-type': 'application/json', cookie: 'botmux_dashboard_token=' + token, origin },
            body: JSON.stringify({ cliId: 'mira', workingDir: homedir(), registrationMode: 'web', cloneSourceAppId: 'cli_source', autoAvoidApproval }),
            signal: AbortSignal.timeout(3_000),
          });
          responses.push({ status: response.status, body: await response.json() });
        }
        console.log('ONBOARDING_RESULTS=' + JSON.stringify({
          startedModes: startedInputs.map(input => input.registrationMode),
          startedAutoAvoidApproval: startedInputs.map(input => input.autoAvoidApproval),
          responses,
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
        startedModes: ['web', 'sdk', 'web', 'compat', 'web', 'web'],
        startedAutoAvoidApproval: [null, null, null, null, true, false],
        responses: [
          accepted, accepted, accepted, accepted,
          { status: 400, body: { ok: false, error: 'invalid_registration_mode' } },
          accepted, accepted,
        ],
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('validates manual App ID/Secret onboarding requests and fails closed on corrupt bots.json', () => {
    const home = mkdtempSync(join(tmpdir(), 'botmux-onboarding-manual-route-'));
    const botmuxDir = join(home, '.botmux');
    const dataDir = join(botmuxDir, 'data');
    const botsPath = join(botmuxDir, 'bots.json');
    try {
      mkdirSync(dataDir, { recursive: true });
      writeFileSync(botsPath, JSON.stringify([
        { larkAppId: 'cli_existing1', larkAppSecret: 's1', allowedUsers: ['first@example.com'] },
      ]));
      writeFileSync(join(botmuxDir, '.data-dir'), dataDir, { mode: 0o600 });

      const child = spawnSyncTsEvalWithRepoImports(`
        import { readFileSync, writeFileSync } from 'node:fs';
        import { homedir } from 'node:os';
        import { join } from 'node:path';
        import { loopbackFetch } from './src/core/loopback-fetch.js';
        import { loadOrCreatePersistedToken } from './src/dashboard/auth.js';
        import { BotOnboardingManager } from './src/dashboard/bot-onboarding.js';

        const startedInputs = [];
        BotOnboardingManager.prototype.start = function (input) {
          startedInputs.push({
            registrationMode: input.registrationMode,
            brand: input.brand,
            appId: input.appId,
            hasSecret: Boolean(input.appSecret),
            allowedUsers: input.allowedUsers,
          });
          return { id: 'manual-job', done: Promise.resolve() };
        };
        BotOnboardingManager.prototype.get = id => ({ id, status: 'starting', registrationMode: 'manual' });

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
        const post = async (bodyStr) => {
          const r = await loopbackFetch(origin + '/api/bot-onboarding/start', {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              cookie: 'botmux_dashboard_token=' + token,
              origin,
            },
            body: bodyStr,
            signal: AbortSignal.timeout(3_000),
          });
          return { status: r.status, body: await r.json() };
        };

        const results = {
          validManual: await post(JSON.stringify({
            cliId: 'mira',
            workingDir: homedir(),
            registrationMode: 'manual',
            brand: 'lark',
            appId: 'cli_newmanual99',
            appSecret: 'sec_99',
            owner: 'owner@example.com, +86 130-1111-2222',
          })),
          validSpaceMobileOnly: await post(JSON.stringify({
            cliId: 'mira',
            workingDir: homedir(),
            registrationMode: 'manual',
            appId: 'cli_newmanual93',
            appSecret: 'sec_93',
            owner: '+1 415 555 0123',
          })),
          validSpaceSplitIds: await post(JSON.stringify({
            cliId: 'mira',
            workingDir: homedir(),
            registrationMode: 'manual',
            appId: 'cli_newmanual92',
            appSecret: 'sec_92',
            owner: 'ou_alpha ou_beta',
          })),
          missingOwner: await post(JSON.stringify({
            cliId: 'mira',
            workingDir: homedir(),
            registrationMode: 'manual',
            appId: 'cli_newmanual98',
            appSecret: 'sec_98',
          })),
          badAppId: await post(JSON.stringify({
            cliId: 'mira',
            workingDir: homedir(),
            registrationMode: 'manual',
            appId: 'local_spoof',
            appSecret: 'sec_97',
            owner: 'owner@example.com',
          })),
          cloneBlocked: await post(JSON.stringify({
            cliId: 'mira',
            workingDir: homedir(),
            registrationMode: 'manual',
            cloneSourceAppId: 'cli_existing1',
            appId: 'cli_newmanual96',
            appSecret: 'sec_96',
            owner: 'owner@example.com',
          })),
          duplicateApp: await post(JSON.stringify({
            cliId: 'mira',
            workingDir: homedir(),
            registrationMode: 'manual',
            appId: 'cli_existing1',
            appSecret: 'sec_95',
            owner: 'owner@example.com',
          })),
          tooLarge: await post(JSON.stringify({ pad: 'x'.repeat(70 * 1024) })),
        };

        // Corrupt bots.json -> route must fail closed with invalid_bots_json and keep bytes intact.
        const corruptContent = '{ corrupted';
        writeFileSync(join(botmuxDir, 'bots.json'), corruptContent);
        results.corruptBotsJson = await post(JSON.stringify({
          cliId: 'mira',
          workingDir: homedir(),
          registrationMode: 'manual',
          appId: 'cli_newmanual95',
          appSecret: 'sec_94',
          owner: 'owner@example.com',
        }));
        results.corruptBytesPreserved = readFileSync(join(botmuxDir, 'bots.json'), 'utf8') === corruptContent;

        console.log('MANUAL_ROUTE_RESULTS=' + JSON.stringify({ startedInputs, results }));
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
      const prefix = 'MANUAL_ROUTE_RESULTS=';
      const line = String(child.stdout).split('\n').find(l => l.startsWith(prefix));
      expect(line, String(child.stdout)).toBeDefined();
      const parsed = JSON.parse(line!.slice(prefix.length));
      expect(parsed.startedInputs).toEqual([
        {
          registrationMode: 'manual',
          brand: 'lark',
          appId: 'cli_newmanual99',
          hasSecret: true,
          allowedUsers: ['owner@example.com', '+86 130-1111-2222'],
        },
        {
          registrationMode: 'manual',
          brand: 'feishu',
          appId: 'cli_newmanual93',
          hasSecret: true,
          allowedUsers: ['+1 415 555 0123'],
        },
        {
          registrationMode: 'manual',
          brand: 'feishu',
          appId: 'cli_newmanual92',
          hasSecret: true,
          allowedUsers: ['ou_alpha', 'ou_beta'],
        },
      ]);
      expect(parsed.results.validManual.status).toBe(202);
      expect(parsed.results.validSpaceMobileOnly.status).toBe(202);
      expect(parsed.results.validSpaceSplitIds.status).toBe(202);
      expect(parsed.results.missingOwner).toMatchObject({ status: 400, body: { ok: false, error: 'no_owner' } });
      expect(parsed.results.badAppId).toMatchObject({ status: 400, body: { ok: false, error: 'invalid_app_id' } });
      expect(parsed.results.cloneBlocked).toMatchObject({ status: 400, body: { ok: false, error: 'manual_clone_unsupported' } });
      expect(parsed.results.duplicateApp).toMatchObject({ status: 409, body: { ok: false, error: 'duplicate_app' } });
      expect(parsed.results.tooLarge).toMatchObject({ status: 413, body: { ok: false, error: 'payload_too_large' } });
      expect(parsed.results.corruptBotsJson).toMatchObject({ status: 400, body: { ok: false, error: 'invalid_bots_json' } });
      expect(parsed.results.corruptBytesPreserved).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
