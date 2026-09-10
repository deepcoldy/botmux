import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { seedPersistedSessionRows } from './helpers/session-store-disk.js';
import { spawnSyncTsScript } from './helpers/ts-runner.js';

function run(fail: boolean, args: string[] = [], turnId = 'turn_a') {
  const root = mkdtempSync(join(tmpdir(), 'botmux-private-cli-'));
  const dataDir = join(root, 'data');
  try {
    mkdirSync(join(dataDir, 'roles', 'cli_test'), { recursive: true });
    writeFileSync(join(dataDir, 'roles', 'cli_test', 'oc_test.meta.json'), JSON.stringify({
      replyPrivately: true, privateReplyNotice: 'sent privately',
    }));
    mkdirSync(join(dataDir, '.botmux-cli-pids'), { recursive: true });
    writeFileSync(join(dataDir, '.botmux-cli-pids', String(process.pid)), JSON.stringify({ sessionId: 'session', turnId }));
    seedPersistedSessionRows(dataDir, 'cli_test', {
      session: {
        sessionId: 'session', larkAppId: 'cli_test', chatId: 'oc_test', chatType: 'group', scope: 'thread',
        rootMessageId: 'om_topic', title: 'test', status: 'active', createdAt: new Date(0).toISOString(),
        quoteTargetId: 'turn_b', quoteTargetSenderOpenId: 'ou_b',
        replyTargets: { turn_a: { senderOpenId: 'ou_a', updatedAt: new Date(0).toISOString() } },
      },
    });
    const result = spawnSyncTsScript(fileURLToPath(new URL('./fixtures/send-private-reply-capture.ts', import.meta.url)), [
      'send', 'answer', '--session-id', 'session', '--no-mention', ...args,
    ], {
      env: { PATH: process.env.PATH, HOME: root, SESSION_DATA_DIR: dataDir, BOTS_CONFIG: join(root, 'bots.json'),
        BOTMUX_SESSION_ID: 'session', TEST_PRIVATE_REPLY_FAIL: fail ? '1' : '0' },
      encoding: 'utf8', timeout: 30_000,
    });
    const deliveries = String(result.stdout).split('\n').filter(line => line.startsWith('DELIVERY='))
      .map(line => JSON.parse(line.slice('DELIVERY='.length)));
    return { ...result, deliveries };
  } finally { rmSync(root, { recursive: true, force: true }); }
}

describe('real CLI private delivery', () => {
  it.each([false, true])('delivers the answer with fallback=%s', fail => {
    const result = run(fail);
    expect(result.status, String(result.stderr)).toBe(0);
    expect(result.deliveries).toHaveLength(2);
    const [dm, group] = result.deliveries;
    expect(dm.body.receive_id).toBe('ou_a');
    expect(dm.body.content).toContain('answer');
    expect(group.url).toMatch(/\/im\/v1\/messages\/om_topic\/reply$/);
    expect(group.body.reply_in_thread).toBe(true);
    expect(group.body.content).toBe(fail ? dm.body.content : JSON.stringify({ text: 'sent privately' }));
  });

  it('returns an evicted turn to the topic without borrowing the last sender', () => {
    const result = run(false, [], 'evicted_turn');
    expect(result.status, String(result.stderr)).toBe(0);
    expect(result.deliveries).toHaveLength(1);
    expect(result.deliveries[0].url).toMatch(/\/im\/v1\/messages\/om_topic\/reply$/);
    expect(result.deliveries[0].body.content).toContain('answer');
  });

  it.each([['--into', 'om_other'], ['--chat-id', 'oc_other']])('rejects destination override %s before delivery', (...args) => {
    const result = run(false, args);
    expect(result.status, String(result.stderr)).toBe(2);
    expect(result.stderr).toContain('请移除 --into / --chat-id');
    expect(result.deliveries).toEqual([]);
  });
});
