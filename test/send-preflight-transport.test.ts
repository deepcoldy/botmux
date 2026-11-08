import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSyncTsScript } from './helpers/ts-runner.js';
import { seedPersistedSessionRows } from './helpers/session-store-disk.js';

const fixture = fileURLToPath(new URL('./fixtures/send-reply-card-capture.ts', import.meta.url));

function httpRequests(stdout: string): string[] {
  return stdout.split('\n').filter(line => line.startsWith('CAPTURE_HTTP='));
}

describe('real send preflight leaves no transport or state side effects', () => {
  it('rejects multi-path attachments before any HTTP call', () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-send-preflight-http-'));
    try {
      const a = join(dir, 'a.sql');
      const b = join(dir, 'b.sql');
      writeFileSync(a, 'a');
      writeFileSync(b, 'b');
      const result = spawnSyncTsScript(fixture, ['send', '--files', a, b, '--no-mention'], {
        env: {
          PATH: process.env.PATH,
          HOME: dir,
          SESSION_DATA_DIR: join(dir, 'data'),
          BOTS_CONFIG: join(dir, 'bots.json'),
          BOTMUX_TEST_CAPTURE_HTTP: '1',
        },
        encoding: 'utf8',
        timeout: 30_000,
      });
      expect(result.status).toBe(2);
      expect(result.stderr).toContain('额外路径');
      expect(httpRequests(result.stdout)).toEqual([]);
      const dataDir = join(dir, 'data');
      expect(existsSync(dataDir) ? readdirSync(dataDir) : []).not.toContain('.botmux-cli-pids');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects unknown flags and exact -- before help without HTTP', () => {
    for (const args of [['send', '--version'], ['send', '--help', '--']]) {
      const dir = mkdtempSync(join(tmpdir(), 'botmux-send-preflight-http-'));
      try {
        const result = spawnSyncTsScript(fixture, args, {
          env: {
            PATH: process.env.PATH,
            HOME: dir,
            SESSION_DATA_DIR: join(dir, 'data'),
            BOTS_CONFIG: join(dir, 'bots.json'),
            BOTMUX_TEST_CAPTURE_HTTP: '1',
          },
          encoding: 'utf8',
          timeout: 30_000,
        });
        expect(result.status).toBe(2);
        expect(httpRequests(result.stdout)).toEqual([]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it.each([
    ['blank lone dash', ['send', '--no-mention', '--response-kind', 'final', '-']],
    ['blank implicit stdin', ['send', '--no-mention', '--response-kind', 'final']],
  ])('keeps marker, ledger, relay outbox and HTTP inert for %s', (_name, args) => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-send-preflight-side-effects-'));
    try {
      const app = 'cli_test';
      const sessionId = 's';
      const dataDir = join(dir, 'data');
      const sessionDir = join(dataDir, '.botmux-cli-pids');
      mkdirSync(sessionDir, { recursive: true });
      writeFileSync(join(dir, 'bots.json'), JSON.stringify([{ larkAppId: app, larkAppSecret: 'test-secret', cliId: 'pi' }]));
      seedPersistedSessionRows(dataDir, app, {
        [sessionId]: {
          sessionId,
          status: 'active',
          cliId: 'pi',
          larkAppId: app,
          chatId: 'oc_test',
          rootMessageId: 'om_root',
          scope: 'thread',
          chatType: 'group',
          workingDir: dir,
        },
      });
      const markerPath = join(sessionDir, String(process.pid));
      const marker = JSON.stringify({ sessionId, turnId: 'turn1', queuedTurnId: 'turn2' });
      writeFileSync(markerPath, marker);
      const ledgerDir = join(dataDir, 'turn-send-ledger', sessionId);
      mkdirSync(ledgerDir, { recursive: true });
      writeFileSync(join(ledgerDir, 'sentinel.json'), 'ledger-before');
      const ledgerId = createHash('sha256').update(JSON.stringify([app, sessionId, 'turn1'])).digest('hex').slice(0, 32);
      writeFileSync(join(ledgerDir, `${ledgerId}.json`), JSON.stringify({
        version: 1,
        larkAppId: app,
        sessionId,
        turnId: 'turn1',
        final: { fingerprint: 'test', messageId: 'om_turn_1', deliveredAtMs: 1 },
      }));
      const relayDir = join(dir, 'relay');
      mkdirSync(relayDir, { recursive: true });
      const ledgerSnapshot = () => readdirSync(ledgerDir).sort().map(name => [name, readFileSync(join(ledgerDir, name), 'utf8')]);
      const ledgerBefore = ledgerSnapshot();

      const result = spawnSyncTsScript(fixture, args, {
        env: {
          PATH: process.env.PATH,
          HOME: dir,
          SESSION_DATA_DIR: dataDir,
          BOTS_CONFIG: join(dir, 'bots.json'),
          BOTMUX_SESSION_ID: sessionId,
          BOTMUX_LARK_APP_ID: app,
          BOTMUX_SEND_RELAY: relayDir,
          BOTMUX_TEST_CAPTURE_HTTP: '1',
        },
        input: '   ',
        encoding: 'utf8',
        timeout: 30_000,
      });
      // Check the side effects first: a regression that moves the guard past
      // the marker/ledger/relay/transport must fail on the state assertion,
      // not be masked by the process exit code.
      const status = result.status;
      expect(httpRequests(result.stdout)).toEqual([]);
      expect(ledgerSnapshot()).toEqual(ledgerBefore);
      expect(readdirSync(relayDir)).toEqual([]);
      expect(readFileSync(markerPath, 'utf8')).toBe(marker);
      expect(status).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('dry-run preflight also never calls HTTP', () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-send-preflight-http-'));
    try {
      const result = spawnSyncTsScript(fixture, ['send', '--dry-run', '--no-mention', '-'], {
        env: {
          PATH: process.env.PATH,
          HOME: dir,
          SESSION_DATA_DIR: join(dir, 'data'),
          BOTS_CONFIG: join(dir, 'bots.json'),
          BOTMUX_TEST_CAPTURE_HTTP: '1',
        },
        input: 'BODY',
        encoding: 'utf8',
        timeout: 30_000,
      });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('"dryRun": true');
      expect(httpRequests(result.stdout)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
