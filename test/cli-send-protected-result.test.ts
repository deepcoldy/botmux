import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ProtectedResultStore, type ProtectedResultContext } from '../src/services/protected-result-store.js';
import { seedPersistedSessionRows } from './helpers/session-store-disk.js';
import { spawnSyncTsScript } from './helpers/ts-runner.js';

const roots: string[] = [];
const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const context: ProtectedResultContext = { appId: 'cli_protected_test', pluginId: 'synthetic-reporter',
  sessionId: 'protected-session', turnId: 'om_protected_turn', ownerUnionId: 'on_requester', chatId: 'oc_test' };
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function run(input: {
  status?: 'pending' | 'unknown' | 'aborted' | 'delivered';
  kind?: 'final' | 'progress' | 'auxiliary'; recordKind?: 'final' | 'auxiliary';
  recordContext?: Partial<ProtectedResultContext>; hostRelay?: boolean; attachment?: boolean;
} = {}) {
  const root = mkdtempSync(join(tmpdir(), 'protected-cli-')); roots.push(root);
  const dataDir = join(root, 'data');
  mkdirSync(join(dataDir, '.botmux-cli-pids'), { recursive: true });
  writeFileSync(join(dataDir, '.botmux-cli-pids', String(process.pid)), JSON.stringify({ sessionId: context.sessionId, turnId: context.turnId }));
  const bots = join(root, 'bots.json');
  writeFileSync(bots, JSON.stringify([{ larkAppId: context.appId, larkAppSecret: 'synthetic-secret', cliId: 'codex', replyCardMode: 'legacy' }]));
  seedPersistedSessionRows(dataDir, context.appId, { [context.sessionId]: {
    sessionId: context.sessionId, status: 'active', cliId: 'codex', larkAppId: context.appId,
    chatId: context.chatId, rootMessageId: 'om_root', scope: 'thread', chatType: 'group', workingDir: root,
    ownerOpenId: 'ou_requester', pid: process.pid,
  } });
  const store = new ProtectedResultStore(dataDir);
  const recordContext = { ...context, responseKind: input.recordKind ?? 'final', ...input.recordContext };
  store.begin(recordContext, 'synthetic_delivery_001', createHash('sha256').update('synthetic').digest('hex'));
  const status = input.status ?? 'delivered';
  if (status === 'delivered') {
    store.update(recordContext, 'synthetic_delivery_001', { message: { kind: 'attachment', messageId: 'om_existing_attachment' } });
    store.update(recordContext, 'synthetic_delivery_001', { message: { kind: 'primary', messageId: 'om_existing_primary' } });
  }
  if (status !== 'pending') store.update(recordContext, 'synthetic_delivery_001', { status });
  const attachment = join(root, 'synthetic.txt'); writeFileSync(attachment, 'synthetic file');
  const result = spawnSyncTsScript(join(repoRoot, 'test/fixtures/send-reply-card-capture.ts'), [
    'send', '--no-mention', '--response-kind', input.kind ?? 'final',
    ...(input.attachment ? ['--files', attachment] : []), 'A replacement summary that must not be duplicated.',
  ], { cwd: repoRoot, encoding: 'utf8', timeout: 30_000, env: {
    PATH: process.env.PATH, HOME: root, SESSION_DATA_DIR: dataDir, BOTS_CONFIG: bots,
    BOTMUX_SESSION_ID: context.sessionId, BOTMUX_TURN_ID: context.turnId, BOTMUX_LARK_APP_ID: context.appId,
    BOTMUX_HOST_RELAY_AUTHORIZED: input.hostRelay ? '1' : '', BOTMUX_TEST_CAPTURE_HTTP: '1',
  } });
  const stdout = String(result.stdout);
  const capture = (prefix: string) => stdout.split('\n').filter(line => line.startsWith(prefix)).map(line => JSON.parse(line.slice(prefix.length)));
  return { code: result.status, stderr: String(result.stderr), stdout,
    replies: capture('CAPTURE_REPLY='), http: capture('CAPTURE_HTTP=') };
}

describe('protected result replay through the real send CLI', () => {
  it.each([false, true])('replays final without another card, attachment or provider request (hostRelay=%s)', hostRelay => {
    const result = run({ hostRelay, attachment: true });
    expect(result.code, result.stderr).toBe(0);
    expect(result.replies).toEqual([]);
    expect(result.http).toEqual([]);
    const receipt = result.stdout.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line))
      .find(value => value.protectedResult === true);
    expect(receipt).toMatchObject({ success: true, replayed: true, messageId: 'om_existing_primary',
      attachmentMessageIds: ['om_existing_attachment'], sessionId: context.sessionId });
  }, 40_000);

  it.each(['progress', 'auxiliary'] as const)('does not swallow an explicit %s message', kind => {
    const result = run({ kind });
    expect(result.code, result.stderr).toBe(0);
    expect(result.replies).toHaveLength(1);
    expect(result.stdout).not.toContain('"protectedResult":true');
  }, 40_000);

  it.each([{ appId: 'cli_other' }, { sessionId: 'other-session' }, { turnId: 'om_other_turn' }])(
    'does not borrow a completed result from another origin: %j', recordContext => {
      const result = run({ recordContext });
      expect(result.code, result.stderr).toBe(0);
      expect(result.replies).toHaveLength(1);
      expect(result.stdout).not.toContain('"protectedResult":true');
    }, 40_000,
  );

  it.each(['pending', 'unknown', 'aborted'] as const)('does not report an incomplete %s result as delivered', status => {
    const result = run({ status });
    expect(result.code, result.stderr).toBe(0);
    expect(result.replies).toHaveLength(1);
    expect(result.stdout).not.toContain('"protectedResult":true');
  }, 40_000);

  it('does not let a protected auxiliary delivery claim the final', () => {
    const result = run({ recordKind: 'auxiliary' });
    expect(result.code, result.stderr).toBe(0);
    expect(result.replies).toHaveLength(1);
    expect(result.stdout).not.toContain('"protectedResult":true');
  }, 40_000);
});
