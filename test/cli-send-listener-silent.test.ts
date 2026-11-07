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
