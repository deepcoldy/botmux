import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { spawnSyncTsScript } from './helpers/ts-runner.js';
import { seedPersistedSessionRows } from './helpers/session-store-disk.js';

const fixture = fileURLToPath(new URL('./fixtures/send-reply-card-capture.ts', import.meta.url));
const repo = fileURLToPath(new URL('..', import.meta.url));

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), 'botmux-turn-idempotency-'));
  const dataDir = join(root, 'data');
  const sessionId = 'sid_turn_idempotency';
  const turnId = 'om_turn_idempotency';
  mkdirSync(join(dataDir, '.botmux-cli-pids'), { recursive: true });
  writeFileSync(join(dataDir, '.botmux-cli-pids', String(process.pid)), JSON.stringify({ sessionId, turnId }));
  writeFileSync(join(root, 'bots.json'), JSON.stringify([{
    larkAppId: 'cli_test', larkAppSecret: 'test-secret', cliId: 'codex', replyCardMode: 'legacy',
  }]));
  seedPersistedSessionRows(dataDir, 'cli_test', { [sessionId]: {
    sessionId, status: 'active', cliId: 'codex', larkAppId: 'cli_test',
    chatId: 'oc_test', rootMessageId: 'om_root', scope: 'thread', chatType: 'group', workingDir: root,
  } });
  const run = (
    kind: 'progress' | 'final' | 'auxiliary',
    content: string,
    extraArgs: string[] = [],
  ) => {
    const hasAddressing = extraArgs.some(arg =>
      arg === '--mention' || arg.startsWith('--mention=')
      || arg === '--mention-back' || arg === '--no-mention');
    const result = spawnSyncTsScript(fixture, [
      'send', ...(hasAddressing ? [] : ['--no-mention']),
      '--response-kind', kind, ...extraArgs, content,
    ], {
      cwd: repo,
      env: { PATH: process.env.PATH, HOME: root, SESSION_DATA_DIR: dataDir,
        BOTS_CONFIG: join(root, 'bots.json'), BOTMUX_SESSION_ID: sessionId, BOTMUX_TURN_ID: turnId,
        BOTMUX_LARK_APP_ID: 'cli_test' },
      encoding: 'utf8', timeout: 30_000,
    });
    const requests = String(result.stdout).split('\n').filter(line => line.startsWith('CAPTURE_REPLY='));
    return { result, requests };
  };
  return { root, dataDir, sessionId, turnId, run };
}

describe('botmux send per-turn final idempotency', () => {
  it('reuses the original id for the same final and blocks final/progress changes', () => {
    const f = createFixture();
    try {
      const first = f.run('final', 'authoritative answer');
      expect(first.result.status, String(first.result.stderr)).toBe(0);
      expect(first.requests).toHaveLength(1);
      expect(String(first.result.stderr)).toContain('--response-kind auxiliary');

      const retry = f.run('final', 'authoritative answer');
      expect(retry.result.status, String(retry.result.stderr)).toBe(0);
      expect(retry.requests).toHaveLength(0);
      expect(JSON.parse(String(retry.result.stdout).trim())).toMatchObject({
        messageId: 'om_separate_message', replayed: true,
      });

      const changed = f.run('final', 'changed answer');
      expect(changed.result.status).toBe(2);
      expect(String(changed.result.stderr)).toContain('本次请求的目标、提及或附件与已投递请求不同');
      expect(String(changed.result.stderr)).toContain('--response-kind auxiliary');
      expect(changed.requests).toHaveLength(0);

      const progress = f.run('progress', 'late progress');
      expect(progress.result.status).toBe(2);
      expect(String(progress.result.stderr)).toContain('本轮 final 已完成');
      expect(String(progress.result.stderr)).toContain('--response-kind auxiliary');
      expect(progress.requests).toHaveLength(0);

      const record = JSON.parse(readFileSync(join(f.dataDir, 'turn-send-ledger',
        readdirLedger(f.dataDir)), 'utf8'));
      expect(record.final.messageId).toBe('om_separate_message');
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  }, 40_000);

  it('still permits an explicit auxiliary message after final', () => {
    const f = createFixture();
    try {
      expect(f.run('final', 'answer').result.status).toBe(0);
      const auxiliary = f.run('auxiliary', 'supplement');
      expect(auxiliary.result.status, String(auxiliary.result.stderr)).toBe(0);
      expect(auxiliary.requests).toHaveLength(1);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  }, 30_000);

  it.each([
    ['another chat', ['--top-level', '--chat-id', 'oc_other']],
    ['another mention target', ['--mention', 'ou_other:Other']],
    ['voice instead of text', ['--voice']],
  ] as const)('refuses the same final body sent with %s instead of replaying success', (_label, args) => {
    const f = createFixture();
    try {
      expect(f.run('final', 'same visible answer').result.status).toBe(0);

      const changed = f.run('final', 'same visible answer', [...args]);
      expect(changed.result.status).toBe(2);
      expect(String(changed.result.stderr)).toContain('本次请求的目标、提及或附件与已投递请求不同');
      expect(String(changed.result.stderr)).toContain('--response-kind auxiliary');
      expect(changed.requests).toHaveLength(0);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  }, 30_000);

  it('refuses the same final body with a new attachment instead of silently dropping it', () => {
    const f = createFixture();
    const attachment = join(f.root, 'supplement.md');
    writeFileSync(attachment, 'supplement');
    try {
      expect(f.run('final', 'same visible answer').result.status).toBe(0);

      const changed = f.run('final', 'same visible answer', ['--files', attachment]);
      expect(changed.result.status).toBe(2);
      expect(String(changed.result.stderr)).toContain('本次请求的目标、提及或附件与已投递请求不同');
      expect(String(changed.result.stderr)).toContain('--response-kind auxiliary');
      expect(changed.requests).toHaveLength(0);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  }, 30_000);

  it('opportunistically prunes completed records older than 30 days without touching the send', () => {
    const f = createFixture();
    try {
      expect(f.run('final', 'answer').result.status).toBe(0);
      const recordPath = join(f.dataDir, 'turn-send-ledger', readdirLedger(f.dataDir));
      const record = JSON.parse(readFileSync(recordPath, 'utf8'));
      record.final.deliveredAtMs = Date.now() - 31 * 24 * 60 * 60_000;
      writeFileSync(recordPath, JSON.stringify(record));
      // The first send legitimately wrote today's throttle marker. Removing it
      // simulates the next due maintenance window without waiting 24 hours.
      rmSync(join(f.dataDir, 'turn-send-ledger', '.completed-prune'), { force: true });

      const auxiliary = f.run('auxiliary', 'supplement');
      expect(auxiliary.result.status, String(auxiliary.result.stderr)).toBe(0);
      expect(auxiliary.requests).toHaveLength(1);
      expect(existsSync(recordPath)).toBe(false);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  }, 30_000);
});

function readdirLedger(dataDir: string): string {
  return readdirSync(join(dataDir, 'turn-send-ledger')).find(name => name.endsWith('.json'))!;
}
