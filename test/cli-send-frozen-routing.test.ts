import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { Session } from '../src/types.js';
import type { DaemonSession } from '../src/core/types.js';
import { beginReplyTargetTurn } from '../src/core/reply-target.js';
import { spawnSyncTsScript } from './helpers/ts-runner.js';
import { seedPersistedSessionRows } from './helpers/session-store-disk.js';

const fixture = fileURLToPath(new URL('./fixtures/send-reply-card-capture.ts', import.meta.url));
const repo = fileURLToPath(new URL('..', import.meta.url));

function setup(cliId: string) {
  const root = mkdtempSync(join(tmpdir(), 'cli-frozen-routing-'));
  const data = join(root, 'data');
  mkdirSync(join(data, '.botmux-cli-pids'), { recursive: true });
  writeFileSync(join(root, 'bots.json'), JSON.stringify([{ larkAppId: 'cli_test', larkAppSecret: 'test', cliId, replyCardMode: 'legacy' }]));
  const firstFile = join(root, 'first.txt');
  const secondFile = join(root, 'second.txt');
  writeFileSync(firstFile, 'first');
  writeFileSync(secondFile, 'second');
  const session = { sessionId: 'sid', status: 'active', cliId, larkAppId: 'cli_test', chatId: 'oc_test',
    rootMessageId: 'oc_test', scope: 'chat', chatType: 'group', workingDir: root } as Session;
  const view = { session, scope: 'chat', chatId: 'oc_test' } as DaemonSession;
  for (let index = 0; index <= 40; index += 1) {
    const turnId = `om_turn_${index}`;
    session.quoteTargetId = turnId;
    beginReplyTargetTurn(view, index === 0 ? 'om_topic_a' : 'om_topic_b', turnId,
      new Date(index * 1000).toISOString(), { inThread: true });
  }
  const run = (turnId: string, kind: string, withFiles = false) => {
    seedPersistedSessionRows(data, 'cli_test', { sid: session });
    writeFileSync(join(data, '.botmux-cli-pids', String(process.pid)), JSON.stringify({ sessionId: 'sid', turnId }));
    const result = spawnSyncTsScript(fixture, ['send', '--no-mention', '--response-kind', kind,
      ...(withFiles ? ['--files', firstFile, '--files', secondFile] : []), 'visible reply'], {
      cwd: repo, encoding: 'utf8', timeout: 30000,
      env: { PATH: process.env.PATH, HOME: root, BOTS_CONFIG: join(root, 'bots.json'), SESSION_DATA_DIR: data,
        BOTMUX_SESSION_ID: 'sid', BOTMUX_TURN_ID: turnId, BOTMUX_LARK_APP_ID: 'cli_test' },
    });
    const writes = String(result.stdout).split('\n').filter(line => line.startsWith('CAPTURE_REPLY='))
      .map(line => JSON.parse(line.slice('CAPTURE_REPLY='.length)));
    return { ...result, writes };
  };
  return { session, run, close: () => rmSync(root, { recursive: true, force: true }) };
}

describe('CLI shared-session frozen routing on the provider boundary', () => {
  it.each(['traex', 'claude-code'])('keeps %s progress, final and both files in their original topic across CLI reloads', cliId => {
    const fixtureRun = setup(cliId);
    try {
      const otherTopic = fixtureRun.run('om_turn_40', 'progress');
      expect(otherTopic.status, String(otherTopic.stderr)).toBe(0);
      expect(otherTopic.writes.length).toBeGreaterThan(0);
      for (const write of otherTopic.writes) {
        expect(write.path).toBe('/open-apis/im/v1/messages/om_topic_b/reply');
        expect(write.body.reply_in_thread).toBe(true);
      }
      const progress = fixtureRun.run('om_turn_0', 'progress');
      const final = fixtureRun.run('om_turn_0', 'final', true);
      for (const result of [progress, final]) {
        expect(result.status, String(result.stderr)).toBe(0);
        expect(result.writes.length).toBeGreaterThan(0);
        for (const write of result.writes) {
          expect(write.path).toBe('/open-apis/im/v1/messages/om_topic_a/reply');
          expect(write.body.reply_in_thread).toBe(true);
        }
      }
      expect(final.writes.filter(write => write.body.msg_type === 'file')).toHaveLength(2);
    } finally { fixtureRun.close(); }
  }, 90000);

  it('fails before every provider write when the exact persisted topic target is unavailable', () => {
    const fixtureRun = setup('traex');
    try {
      delete fixtureRun.session.turnReplyContexts?.om_turn_0;
      const result = fixtureRun.run('om_turn_0', 'final', true);
      expect(result.status).toBe(2);
      expect(String(result.stderr)).toContain('REPLY_TARGET_MISSING');
      expect(result.writes).toEqual([]);
    } finally { fixtureRun.close(); }
  }, 40000);
});
