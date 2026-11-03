import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { seedPersistedSessionRows } from './helpers/session-store-disk.js';
import { spawnSyncTsScript } from './helpers/ts-runner.js';

function run(args: string[], zeroPrompt = false) {
  const root = mkdtempSync(join(tmpdir(), 'dispatch-result-cli-'));
  const data = join(root, 'data'); mkdirSync(data);
  const bots = join(root, 'bots.json');
  writeFileSync(bots, JSON.stringify([
    { larkAppId: 'cli_source', larkAppSecret: 'test', cliId: 'claude-code', allowedUsers: [] },
    { larkAppId: 'cli_worker', larkAppSecret: 'test', cliId: 'codex', allowedUsers: [],
      promptInjection: zeroPrompt ? 'none' : 'default' },
  ]));
  seedPersistedSessionRows(data, 'cli_source', { source: {
    sessionId: 'source', larkAppId: 'cli_source', chatId: 'oc_task', rootMessageId: 'om_task',
    status: 'active', scope: 'thread', createdAt: new Date().toISOString(), title: 'test',
  } });
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !key.startsWith('BOTMUX_') && !['BOTS_CONFIG', 'SESSION_DATA_DIR'].includes(key)));
  try {
    return spawnSyncTsScript(resolve('src/cli.ts'), [
      'dispatch', '--session-id', 'source', '--title', 'task', '--brief', 'do task', ...args,
    ], { encoding: 'utf8', timeout: 20000, env: { ...env, HOME: root, USERPROFILE: root,
      BOTS_CONFIG: bots, SESSION_DATA_DIR: data } });
  } finally { rmSync(root, { recursive: true, force: true }); }
}

describe('dispatch result delivery CLI guards', () => {
  it('rejects an invalid enum before looking up a session or sending', () => {
    const result = run(['--bot-app', 'cli_worker', '--result-delivery', 'invalid']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('--result-delivery 必须是 relay|publish|publish-and-relay');
  });
  it.each(['publish', 'publish-and-relay'])('rejects %s for a legacy bot', delivery => {
    const result = run(['--bot', 'ou_legacy', '--result-delivery', delivery]);
    expect(result.status).toBe(1); expect(result.stderr).toContain('公开结果投递需要使用 --bot-app');
  });
  it('rejects publication for standby dispatch', () => {
    const result = run(['--bot-app', 'cli_worker', '--standby', '--repo', '/tmp', '--result-delivery', 'publish']);
    expect(result.status).toBe(1); expect(result.stderr).toContain('--bot-app 仅自动建立 talk-only chatGrant');
  });
  it('rejects publication to a zero-prompt target', () => {
    const result = run(['--bot-app', 'cli_worker', '--result-delivery', 'publish'], true);
    expect(result.status).toBe(1); expect(result.stderr).toContain('零注入模式使用自动回传');
  });
});
