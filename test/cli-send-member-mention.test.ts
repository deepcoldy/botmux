import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSyncTsScript } from './helpers/ts-runner.js';
import { seedPersistedSessionRows } from './helpers/session-store-disk.js';

function send(scenario: 'unique' | 'duplicate' | 'missing') {
  const dir = mkdtempSync(join(tmpdir(), 'botmux-member-mention-'));
  try {
    const botsPath = join(dir, 'bots.json');
    writeFileSync(botsPath, JSON.stringify([{
      larkAppId: 'cli_test', larkAppSecret: 'test', cliId: 'claude-code',
      allowArbitraryMention: true, allowedUsers: [], workingDir: dir,
    }]));
    seedPersistedSessionRows(join(dir, 'data'), 'cli_test', {
      'test-member-mention': {
        sessionId: 'test-member-mention', larkAppId: 'cli_test', chatId: 'oc_test',
        scope: 'chat', status: 'active', cliId: 'claude-code', workingDir: dir,
        ownerOpenId: 'ou_owner', createdAt: new Date(0).toISOString(),
      },
    });
    return spawnSyncTsScript(fileURLToPath(new URL('./fixtures/send-member-mention-capture.ts', import.meta.url)), [
      'send', '--mention', 'recipient@example.com:Recipient', 'Please review @Recipient',
    ], {
      env: {
        PATH: process.env.PATH, HOME: dir, SESSION_DATA_DIR: join(dir, 'data'), BOTS_CONFIG: botsPath,
        BOTMUX_LARK_APP_ID: 'cli_test',
        BOTMUX_SESSION_ID: 'test-member-mention', BOTMUX_CHAT_ID: 'oc_test', BOTMUX_SESSION_SCOPE: 'chat',
        TEST_MEMBER_SCENARIO: scenario,
      },
      encoding: 'utf8', timeout: 30_000,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('cmdSend member display-name fallback', () => {
  it('delivers a real mention when contact lookup misses but the chat name is unique', () => {
    const result = send('unique');
    expect(result.status, String(result.stderr)).toBe(0);
    const stdout = String(result.stdout);
    expect(stdout).toContain('CONTACT_LOOKUP=');
    expect(stdout).toContain('recipient@example.com');
    expect(stdout).toContain('MEMBER_LOOKUP=oc_test');
    const captured = stdout.split('\n').find(line => line.startsWith('CAPTURE_MESSAGE='));
    expect(captured, stdout).toBeTruthy();
    const message = JSON.parse(captured!.slice('CAPTURE_MESSAGE='.length));
    expect(message.receive_id).toBe('oc_test');
    expect(message.content).toContain('<at id=ou_recipient></at>');
    expect(message.content).not.toContain('ou_owner');
  });

  it.each(['duplicate', 'missing'] as const)('exits 2 without sending when the chat name is %s', scenario => {
    const result = send(scenario);
    expect(result.status, String(result.stderr)).toBe(2);
    expect(String(result.stdout)).toContain('CONTACT_LOOKUP=');
    expect(String(result.stdout)).toContain('MEMBER_LOOKUP=oc_test');
    expect(String(result.stderr)).toContain('无法解析这些标识为当前群唯一成员');
    expect(String(result.stdout)).not.toContain('CAPTURE_MESSAGE=');
  });
});
