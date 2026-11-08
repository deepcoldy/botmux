import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSyncTsScript } from './helpers/ts-runner.js';
import { seedPersistedSessionRows } from './helpers/session-store-disk.js';

const fixture = fileURLToPath(new URL('./fixtures/send-reply-card-capture.ts', import.meta.url));

describe('managed sends from silent listener tasks', () => {
  it.each([
    ['default source', [], true],
    ['source through human session', ['--session-id', 'human'], true],
    ['source through target session', ['--session-id', 'target', '--chat-id', 'oc_test', '--top-level'], true],
    ['source through quote', ['--chat-id', 'oc_target', '--quote', 'om_source'], true],
    ['source through into', ['--chat-id', 'oc_target', '--into', 'om_source'], true],
    ['other group', ['--chat-id', 'oc_target', '--top-level'], false],
    ['chat override without top-level still targets source thread', ['--chat-id', 'oc_target'], true],
    ['other group through session', ['--session-id', 'target'], false],
    ['report source', ['report', '--top-level'], true],
    ['report source through into', ['report', '--into', 'om_human'], true],
    ['report source through session', ['report', '--session-id', 'human', '--top-level'], true],
    ['report other group', ['report', '--session-id', 'target', '--top-level'], false],
    ['card source', ['card', 'patch', '--message-id', 'om_human', '--card-json', '{"elements":[{"tag":"markdown","content":"progress"}]}'], true],
  ])('%s respects the frozen source group', (_label, args, blocked) => {
    const root = mkdtempSync(join(tmpdir(), 'botmux-listener-send-'));
    try {
      const dataDir = join(root, 'data');
      mkdirSync(join(dataDir, '.botmux-cli-pids'), { recursive: true });
      writeFileSync(join(dataDir, '.botmux-cli-pids', String(process.pid)), JSON.stringify({ sessionId: 'silent', turnId: 'om_turn' }));
      writeFileSync(join(root, 'bots.json'), JSON.stringify([{ larkAppId: 'cli_test', larkAppSecret: 'test', cliId: 'codex', replyCardMode: 'legacy', topicUnavailablePolicy: 'stop' }]));
      const common = { status: 'active', cliId: 'codex', larkAppId: 'cli_test', scope: 'thread', chatType: 'group', workingDir: root, ownerOpenId: 'ou_requester' };
      seedPersistedSessionRows(dataDir, 'cli_test', {
        silent: { ...common, sessionId: 'silent', chatId: 'oc_test', rootMessageId: 'ml:om_source', messageListenerRun: { sourceMessageId: 'om_source', replyMode: 'none' } },
        human: { ...common, sessionId: 'human', chatId: 'oc_test', rootMessageId: 'om_human' },
        target: { ...common, sessionId: 'target', chatId: 'oc_target', rootMessageId: 'om_target' },
      });
      const argv = args[0] === 'card' ? [...args] : args[0] === 'report' ? [...args, 'result'] : ['send', '--no-mention', '--response-kind', 'progress', ...args, 'result'];
      const result = spawnSyncTsScript(fixture, argv, {
        cwd: process.cwd(), encoding: 'utf8', timeout: 30_000,
        env: { ...process.env, HOME: root, SESSION_DATA_DIR: dataDir, BOTS_CONFIG: join(root, 'bots.json'),
          BOTMUX_SESSION_ID: 'silent', BOTMUX_TURN_ID: 'om_turn', BOTMUX_LARK_APP_ID: 'cli_test',
          BOTMUX_TEST_TOPIC_STATES: JSON.stringify({ 'ml:om_source': 'missing', om_source: 'live', om_human: 'live', om_target: 'live' }) },
      });
      const writes = result.stdout.split('\n').filter(line => line.startsWith('CAPTURE_REPLY='));
      if (blocked) {
        expect(writes).toEqual([]);
        expect(result.status).toBe(1);
        expect(result.stderr).toContain('silent_message_listener');
      } else {
        expect(result.status, result.stderr).toBe(0);
        expect(writes).toHaveLength(1);
        const write = JSON.parse(writes[0].slice('CAPTURE_REPLY='.length));
        expect(write.body.receive_id === 'oc_target' || write.path.endsWith('/om_target/reply')).toBe(true);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('other source-group write paths from silent listener tasks', () => {
  function spawnInSilentSession(args: string[], extraEnv: Record<string, string> = {}) {
    const root = mkdtempSync(join(tmpdir(), 'botmux-listener-send-'));
    try {
      const dataDir = join(root, 'data');
      mkdirSync(join(dataDir, '.botmux-cli-pids'), { recursive: true });
      writeFileSync(join(dataDir, '.botmux-cli-pids', String(process.pid)), JSON.stringify({ sessionId: 'silent', turnId: 'om_turn' }));
      writeFileSync(join(root, 'bots.json'), JSON.stringify([{ larkAppId: 'cli_test', larkAppSecret: 'test', cliId: 'codex', replyCardMode: 'legacy', topicUnavailablePolicy: 'stop' }]));
      const common = { status: 'active', cliId: 'codex', larkAppId: 'cli_test', scope: 'thread', chatType: 'group', workingDir: root, ownerOpenId: 'ou_requester' };
      seedPersistedSessionRows(dataDir, 'cli_test', {
        silent: { ...common, sessionId: 'silent', chatId: 'oc_test', rootMessageId: 'ml:om_source', messageListenerRun: { sourceMessageId: 'om_source', replyMode: 'none' } },
        human: { ...common, sessionId: 'human', chatId: 'oc_test', rootMessageId: 'om_human' },
        target: { ...common, sessionId: 'target', chatId: 'oc_target', rootMessageId: 'om_target' },
      });
      const result = spawnSyncTsScript(fixture, args, {
        cwd: process.cwd(), encoding: 'utf8', timeout: 30_000,
        env: { ...process.env, HOME: root, SESSION_DATA_DIR: dataDir, BOTS_CONFIG: join(root, 'bots.json'),
          // Mirror the worker freeze: a silent task's BOTMUX_CHAT_ID is its own
          // source chat, never an inherited ambient value.
          BOTMUX_CHAT_ID: 'oc_test',
          BOTMUX_SESSION_ID: 'silent', BOTMUX_TURN_ID: 'om_turn', BOTMUX_LARK_APP_ID: 'cli_test',
          BOTMUX_TEST_TOPIC_STATES: JSON.stringify({ 'ml:om_source': 'missing', om_source: 'live', om_human: 'live', om_target: 'live' }),
          ...extraEnv },
      });
      return { root, result };
    } catch (err) {
      rmSync(root, { recursive: true, force: true });
      throw err;
    }
  }

  it.each([
    ['dispatch default target', ['dispatch', '--title', '子项目', '--bot-app', 'cli_other', '--brief', '做个事']],
    ['dispatch into a source-group message', ['dispatch', '--into', 'om_human', '--bot-app', 'cli_other', '--brief', '继续']],
    ['dispatch tree refresh', ['dispatch', 'tree']],
    ['top-notice in the source group', ['top-notice', 'set', 'om_human', '--json']],
  ])('blocks %s before any Lark write', (_label, args) => {
    const { root, result } = spawnInSilentSession(args);
    try {
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('silent_message_listener');
      expect(result.stdout.split('\n').filter(line => line.startsWith('CAPTURE_REPLY='))).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  const chatRequests = (stdout: string) => stdout.split('\n')
    .filter(line => line.startsWith('CAPTURE_HTTP='))
    .map(line => JSON.parse(line.slice('CAPTURE_HTTP='.length)) as { method: string; path: string })
    .filter(request => request.path.includes('/im/v1/chats/'));

  it.each([
    ['top-notice through another source-group session', ['top-notice', 'set', 'om_human', '--session-id', 'human', '--json']],
    ['tabs add in the source group', ['tabs', 'add', 'https://example.com/doc', '--name', 'progress', '--json']],
    ['tabs update in the source group', ['tabs', 'update', 'tab_1', '--name', 'progress', '--json']],
    ['tabs remove through another source-group session', ['tabs', 'remove', 'tab_1', '--session-id', 'human', '--json']],
    ['tabs sort in the source group', ['tabs', 'sort', 'tab_2', 'tab_1', '--json']],
  ])('blocks %s before any chat write', (_label, args) => {
    const { root, result } = spawnInSilentSession(args, { BOTMUX_TEST_CAPTURE_HTTP: '1' });
    try {
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('silent_message_listener');
      expect(chatRequests(result.stdout)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([
    ['tabs list in the source group', ['tabs', 'list', '--json'], 'GET', 'oc_test'],
    ['tabs add in another group', ['tabs', 'add', 'https://example.com/doc', '--chat-id', 'oc_target', '--json'], 'POST', 'oc_target'],
  ])('lets %s reach Lark', (_label, args, method, chatId) => {
    const { root, result } = spawnInSilentSession(args, { BOTMUX_TEST_CAPTURE_HTTP: '1' });
    try {
      expect(result.stdout + result.stderr).not.toContain('silent_message_listener');
      const requests = chatRequests(result.stdout);
      expect(requests.some(request => request.method === method)).toBe(true);
      expect(requests.every(request => request.path.includes(`/chats/${chatId}/`))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('history reads use the real source message id and never send the ml: anchor to Lark', () => {
    const { root, result } = spawnInSilentSession(['history', '--limit', '5'],
      { BOTMUX_TEST_CAPTURE_HTTP: '1', BOTMUX_TEST_LIST_MESSAGES: '1' });
    try {
      expect(result.status, result.stderr).toBe(0);
      const queriedPaths = result.stdout.split('\n')
        .filter(line => line.startsWith('CAPTURE_HTTP='))
        .map(line => JSON.parse(line.slice('CAPTURE_HTTP='.length)).path as string);
      expect(queriedPaths.length).toBeGreaterThan(0);
      expect(queriedPaths.some(path => /ml(?::|%3a)/i.test(path))).toBe(false);
      expect(queriedPaths.some(path => path.includes('om_source'))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('riff/mojo env-mode silent tasks (no local session store)', () => {
  // The sandbox rebuilds SessionData from env only; the frozen listener
  // identity must be reconstructed from the ml: anchor, not silently dropped.
  function spawnRiffEnv(args: string[]) {
    const root = mkdtempSync(join(tmpdir(), 'botmux-riff-listener-'));
    try {
      const dataDir = join(root, 'data');
      mkdirSync(join(dataDir, '.botmux-cli-pids'), { recursive: true });
      writeFileSync(join(dataDir, '.botmux-cli-pids', String(process.pid)), JSON.stringify({ sessionId: 'riff-sid', turnId: 'om_turn' }));
      writeFileSync(join(root, 'bots.json'), JSON.stringify([{ larkAppId: 'cli_riff', larkAppSecret: 'secret', cliId: 'riff', replyCardMode: 'legacy' }]));
      // Deliberately NO seedPersistedSessionRows: riffModeSession must kick in.
      const result = spawnSyncTsScript(fixture, args, {
        cwd: process.cwd(), encoding: 'utf8', timeout: 30_000,
        env: { ...process.env, HOME: root, SESSION_DATA_DIR: dataDir, BOTS_CONFIG: join(root, 'bots.json'),
          BOTMUX_LARK_APP_ID: 'cli_riff', BOTMUX_LARK_APP_SECRET: 'secret',
          BOTMUX_SESSION_ID: 'riff-sid', BOTMUX_CHAT_ID: 'oc_source',
          BOTMUX_ROOT_MESSAGE_ID: 'ml:om_source', BOTMUX_SESSION_SCOPE: 'thread',
          BOTMUX_TURN_ID: 'om_turn',
          BOTMUX_TEST_CAPTURE_HTTP: '1', BOTMUX_TEST_LIST_MESSAGES: '1' },
      });
      return { root, result };
    } catch (err) {
      rmSync(root, { recursive: true, force: true });
      throw err;
    }
  }

  it.each([
    ['thread scope', ['history', '--limit', '5']],
    ['ambient scope', ['history', '--scope', 'ambient', '--limit', '5']],
  ])('history in %s reads the real source message id, never the ml: anchor', (_label, args) => {
    const { root, result } = spawnRiffEnv(args);
    try {
      expect(result.status, result.stderr).toBe(0);
      const queriedPaths = result.stdout.split('\n')
        .filter(line => line.startsWith('CAPTURE_HTTP='))
        .map(line => JSON.parse(line.slice('CAPTURE_HTTP='.length)).path as string);
      expect(queriedPaths.some(path => /ml(?::|%3a)/i.test(path))).toBe(false);
      expect(queriedPaths.some(path => path.includes('/messages/om_source'))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('still blocks a default send to the source group without a local session row', () => {
    const { root, result } = spawnRiffEnv(['send', '--no-mention', '--response-kind', 'progress', 'result']);
    try {
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('silent_message_listener');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
