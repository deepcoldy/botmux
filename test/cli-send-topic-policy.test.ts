/** Drives the actual CLI; SDK transport captures all lookups and writes. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { spawnSyncTsScript } from './helpers/ts-runner.js';
import { seedPersistedSessionRows } from './helpers/session-store-disk.js';
const fixture = fileURLToPath(new URL('./fixtures/send-reply-card-capture.ts', import.meta.url));
const repo = fileURLToPath(new URL('..', import.meta.url));
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'cli-topic-policy-'));
  const data = join(root, 'data');
  mkdirSync(join(data, '.botmux-cli-pids'), { recursive: true });
  writeFileSync(join(data, '.botmux-cli-pids', String(process.pid)), JSON.stringify({ sessionId: 'sid', turnId: 'om_turn' }));
  writeFileSync(join(root, 'bots.json'), JSON.stringify([{
    larkAppId: 'cli_test', larkAppSecret: 'test', cliId: 'codex', replyCardMode: 'legacy', topicUnavailablePolicy: 'stop',
  }]));
  seedPersistedSessionRows(data, 'cli_test', { sid: {
    sessionId: 'sid', status: 'active', cliId: 'codex', larkAppId: 'cli_test', chatId: 'oc_test',
    rootMessageId: 'om_root', scope: 'thread', chatType: 'group', workingDir: root,
  } });
  return {
    close: () => rmSync(root, { recursive: true, force: true }),
    run: (states: Record<string, string>, args: string[] = []) => {
      const result = spawnSyncTsScript(fixture, ['send', '--no-mention', '--response-kind', 'final', ...args, 'result'], {
        cwd: repo, encoding: 'utf8', timeout: 30000,
        env: { PATH: process.env.PATH, HOME: root, BOTS_CONFIG: join(root, 'bots.json'), SESSION_DATA_DIR: data,
          BOTMUX_SESSION_ID: 'sid', BOTMUX_TURN_ID: 'om_turn', BOTMUX_LARK_APP_ID: 'cli_test',
          BOTMUX_TEST_TOPIC_STATES: JSON.stringify(states) },
      });
      const stdout = String(result.stdout);
      return { ...result, writes: stdout.split('\n').filter(line => line.startsWith('CAPTURE_REPLY=')),
        lookups: stdout.split('\n').filter(line => line.startsWith('CAPTURE_TOPIC=')).map(line => JSON.parse(line.slice(14))) };
    },
  };
}
describe('CLI topic unavailable policy', () => {
  it.each([
    ['withdrawn source', { om_root: 'withdrawn' }, []],
    ['withdrawn source with top-level override', { om_root: 'withdrawn' }, ['--top-level']],
    ['withdrawn explicit target', { om_root: 'live', om_other: 'withdrawn' }, ['--into', 'om_other']],
    ['lookup throws', { om_root: 'error' }, []],
    ['withdrawal provider code', { om_root: 'withdrawn-code' }, []],
    ['withdrawn after preflight', { om_root: 'withdraw-after-preflight' }, []],
  ] as const)('refuses %s with no provider send', (_label, states, args) => {
    const f = setup();
    try {
      const result = f.run(states, [...args]);
      expect(result.status, String(result.stderr)).toBe(2);
      expect(result.writes).toEqual([]);
      expect(String(result.stderr)).toContain('botmux send refused: TOPIC_SEND_');
      expect(String(result.stderr)).not.toContain('at assertSendTopicsAvailable');
    } finally { f.close(); }
  }, 40000);
  it('checks preflight and the send fence once each, then replays without querying', () => {
    const f = setup();
    try {
      const first = f.run({ om_root: 'live' });
      expect(first.status, String(first.stderr)).toBe(0);
      expect(first.writes).toHaveLength(1);
      expect(first.lookups.filter(item => item.id === 'om_root')).toHaveLength(2);
      const replay = f.run({ om_root: 'error' });
      expect(replay.status, String(replay.stderr)).toBe(0);
      expect(replay.lookups).toEqual([]); expect(replay.writes).toEqual([]);
      expect(String(replay.stdout)).toContain('"replayed":true');
    } finally { f.close(); }
  }, 40000);
});
