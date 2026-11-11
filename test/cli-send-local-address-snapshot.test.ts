import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { spawnSyncTsScript } from './helpers/ts-runner.js';
import { seedPersistedSessionRows } from './helpers/session-store-disk.js';

const fixture = fileURLToPath(new URL('./fixtures/send-reply-card-capture.ts', import.meta.url));

// A Riff/Mojo sandbox has no daemon registry and its bots.json may be a stale
// copy: `botmux send` there takes hideLocalAddresses from the snapshot the
// worker froze into the session env when it was forked.
describe('botmux send in an env-only (remote) session', () => {
  function sendInRemoteSession(snapshot: '1' | '0' | undefined, staleBotsJsonValue?: boolean) {
    const root = mkdtempSync(join(tmpdir(), 'botmux-remote-local-address-'));
    try {
      const dataDir = join(root, 'data');
      mkdirSync(join(dataDir, '.botmux-cli-pids'), { recursive: true });
      writeFileSync(join(dataDir, '.botmux-cli-pids', String(process.pid)), JSON.stringify({ sessionId: 'riff-sid', turnId: 'om_turn' }));
      writeFileSync(join(root, 'bots.json'), JSON.stringify([{ larkAppId: 'cli_riff', larkAppSecret: 'secret', cliId: 'riff',
        replyCardMode: 'legacy', ...(staleBotsJsonValue === undefined ? {} : { hideLocalAddresses: staleBotsJsonValue }) }]));
      const result = spawnSyncTsScript(fixture, ['send', '--no-mention', '--response-kind', 'progress',
        '日志在 /opt/app/logs/error.log，服务 http://localhost:3000/health'], {
        cwd: process.cwd(), encoding: 'utf8', timeout: 30_000,
        env: { ...process.env, HOME: root, SESSION_DATA_DIR: dataDir, BOTS_CONFIG: join(root, 'bots.json'),
          BOTMUX_LARK_APP_ID: 'cli_riff', BOTMUX_LARK_APP_SECRET: 'secret',
          BOTMUX_SESSION_ID: 'riff-sid', BOTMUX_CHAT_ID: 'oc_source',
          BOTMUX_ROOT_MESSAGE_ID: 'om_source', BOTMUX_SESSION_SCOPE: 'thread', BOTMUX_TURN_ID: 'om_turn',
          BOTMUX_HIDE_LOCAL_ADDRESSES: snapshot },
      });
      const replies = result.stdout.split('\n').filter(line => line.startsWith('CAPTURE_REPLY='))
        .map(line => JSON.stringify(JSON.parse(line.slice('CAPTURE_REPLY='.length)).body));
      return { result, sent: replies.join('\n') };
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  it('replaces host addresses when the snapshot says the bot turned it on', () => {
    const { result, sent } = sendInRemoteSession('1', false);
    expect(result.status, result.stderr).toBe(0);
    expect(sent).toContain('日志在');
    expect(sent).not.toContain('/opt/app/logs');
    expect(sent).not.toContain('localhost:3000');
  });

  it.each([['0', true], [undefined, undefined]] as const)('sends host addresses as written with snapshot %s', (snapshot, stale) => {
    const { result, sent } = sendInRemoteSession(snapshot, stale);
    expect(result.status, result.stderr).toBe(0);
    expect(sent).toContain('/opt/app/logs/error.log');
    expect(sent).toContain('http://localhost:3000/health');
  });
});

// Any sandboxed session of a bot leaves its send-cred file in BOT_HOME, and
// `botmux send` then registers the bot from it. In a host session bots.json is
// still readable and is the live setting; only an isolated sandbox, where it is
// denied, falls back to the worker's snapshot.
describe('botmux send for a bot that has a send-cred file', () => {
  function send(opts: { botsJson: 'on' | 'off' | 'missing'; snapshot: '1' | '0' | undefined }) {
    const root = mkdtempSync(join(tmpdir(), 'botmux-cred-local-address-'));
    try {
      const dataDir = join(root, 'data');
      const botsPath = join(root, 'bots.json');
      if (opts.botsJson !== 'missing') {
        writeFileSync(botsPath, JSON.stringify([{ larkAppId: 'cli_cred', larkAppSecret: 'secret', cliId: 'claude-code',
          replyCardMode: 'legacy', ...(opts.botsJson === 'on' ? { hideLocalAddresses: true } : {}) }]));
      }
      mkdirSync(join(root, 'bots', 'cli_cred'), { recursive: true });
      writeFileSync(join(root, 'bots', 'cli_cred', 'send-cred.json'), JSON.stringify({ larkAppId: 'cli_cred', larkAppSecret: 'secret' }));
      seedPersistedSessionRows(dataDir, 'cli_cred', { sid_cred: {
        sessionId: 'sid_cred', larkAppId: 'cli_cred', status: 'active', cliId: 'claude-code', chatId: 'oc_cred',
        rootMessageId: 'om_root', scope: 'thread', chatType: 'group', workingDir: root,
      } });
      const result = spawnSyncTsScript(fixture, ['send', '--no-mention', '--response-kind', 'progress',
        '日志在 /opt/app/logs/error.log，服务 http://localhost:3000/health'], {
        cwd: process.cwd(), encoding: 'utf8', timeout: 30_000,
        env: { PATH: process.env.PATH, HOME: root, SESSION_DATA_DIR: dataDir, BOTS_CONFIG: botsPath,
          BOTMUX_SESSION_ID: 'sid_cred', BOTMUX_TURN_ID: 'om_turn', BOTMUX_LARK_APP_ID: 'cli_cred', BOTMUX_DAEMON_IPC_PORT: '49501',
          ...(opts.snapshot === undefined ? {} : { BOTMUX_HIDE_LOCAL_ADDRESSES: opts.snapshot }) },
      });
      const sent = String(result.stdout).split('\n').filter(line => line.startsWith('CAPTURE_REPLY='))
        .map(line => JSON.stringify(JSON.parse(line.slice('CAPTURE_REPLY='.length)).body)).join('\n');
      return { result, sent };
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
  const replaced = (sent: string) => !sent.includes('/opt/app/logs') && !sent.includes('localhost:3000');

  it.each([
    ['bots.json on, snapshot off', { botsJson: 'on', snapshot: '0' }, true],
    ['bots.json on, pane from before the snapshot existed', { botsJson: 'on', snapshot: undefined }, true],
    ['bots.json off, snapshot on', { botsJson: 'off', snapshot: '1' }, false],
    ['sandbox (bots.json out of reach), snapshot on', { botsJson: 'missing', snapshot: '1' }, true],
    ['sandbox (bots.json out of reach), snapshot off', { botsJson: 'missing', snapshot: '0' }, false],
  ] as const)('%s', (_label, opts, expectReplaced) => {
    const { result, sent } = send(opts);
    expect(result.status, String(result.stderr)).toBe(0);
    expect(sent).toContain('日志在');
    expect(replaced(sent)).toBe(expectReplaced);
  });
});
