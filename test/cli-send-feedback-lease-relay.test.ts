/**
 * End to end through the real `botmux send` (direct provider path) when the
 * CLI's sandbox denies the shared lease directory (EPERM): the feedback send
 * lease is taken by the origin session's daemon before the provider effect and
 * released after it, or the send stops before any effect. A read-isolated pane
 * reaches the same relay with its capability instead of the host secret; its
 * owning-root locator lives under the real OS home, so this test drives the
 * relay from a session-marker origin.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { spawnSyncTsScript } from './helpers/ts-runner.js';
import { seedPersistedSessionRows } from './helpers/session-store-disk.js';

const fixture = fileURLToPath(new URL('./fixtures/send-reply-card-capture.ts', import.meta.url));
const repo = fileURLToPath(new URL('..', import.meta.url));
const sessionId = 'sid_lease_relay';
const turnId = 'om_lease_relay_turn';

function runSandboxedSend(daemon: 'ok' | 'refuse') {
  const root = mkdtempSync(join(tmpdir(), 'botmux-send-lease-relay-'));
  const dataDir = join(root, 'data');
  try {
    mkdirSync(join(dataDir, '.botmux-cli-pids'), { recursive: true });
    writeFileSync(join(dataDir, '.botmux-cli-pids', String(process.pid)), JSON.stringify({ sessionId, turnId }));
    writeFileSync(join(root, 'bots.json'), JSON.stringify([{
      larkAppId: 'cli_test', larkAppSecret: 'test-secret', cliId: 'codex', replyCardMode: 'legacy',
    }]));
    seedPersistedSessionRows(dataDir, 'cli_test', { [sessionId]: {
      sessionId, status: 'active', cliId: 'codex', larkAppId: 'cli_test',
      chatId: 'oc_test', rootMessageId: 'om_root', scope: 'thread', chatType: 'group', workingDir: root,
    } });
    const result = spawnSyncTsScript(fixture, ['send', '--no-mention', '--response-kind', 'progress', 'lease relayed'], {
      cwd: repo,
      env: {
        PATH: process.env.PATH,
        HOME: root,
        SESSION_DATA_DIR: dataDir,
        BOTS_CONFIG: join(root, 'bots.json'),
        BOTMUX_SESSION_ID: sessionId,
        BOTMUX_TURN_ID: turnId,
        BOTMUX_LARK_APP_ID: 'cli_test',
        BOTMUX_DAEMON_IPC_PORT: '7951',
        BOTMUX_TEST_FEEDBACK_LEASE_DAEMON: daemon,
      },
      encoding: 'utf8',
      timeout: 30_000,
    });
    const lines = String(result.stdout).split('\n');
    const captured = lines.filter(line => line.startsWith('CAPTURE_LEASE=') || line.startsWith('CAPTURE_REPLY='));
    return {
      result,
      order: captured.map(line => line.startsWith('CAPTURE_REPLY=') ? 'provider' : JSON.parse(line.slice('CAPTURE_LEASE='.length)).body.action),
      leases: lines.filter(line => line.startsWith('CAPTURE_LEASE=')).map(line => JSON.parse(line.slice('CAPTURE_LEASE='.length))),
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('botmux send feedback lease when the CLI sandbox denies the lease directory', () => {
  it('has the origin daemon hold the lease across the provider effect', () => {
    const { result, order, leases } = runSandboxedSend('ok');
    expect(result.status, String(result.stderr)).toBe(0);
    expect(order).toEqual(['acquire', 'provider', 'release']);
    const [acquire, release] = leases;
    expect(acquire.path).toBe(`/api/sessions/${sessionId}/feedback-send-lease`);
    expect(typeof acquire.body.processId).toBe('number');
    expect(release.path).toBe(acquire.path);
    expect(release.body.processId).toBe(acquire.body.processId);
    expect(release.body.lease).toBe(`${acquire.body.processId}-0123abcd.json`);
  }, 35_000);

  it('stops before the provider effect when the daemon refuses the lease', () => {
    const { result, order } = runSandboxedSend('refuse');
    expect(result.status).not.toBe(0);
    expect(String(result.stderr)).toContain('feedback_storage_maintenance');
    expect(order).toEqual(['acquire']);
  }, 35_000);
});
