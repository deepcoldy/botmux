import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { spawnSyncTsScript } from './helpers/ts-runner.js';
import { seedPersistedSessionRows } from './helpers/session-store-disk.js';
import { TurnSendLedger } from '../src/services/turn-send-ledger.js';

const fixture = fileURLToPath(new URL('./fixtures/send-reply-card-capture.ts', import.meta.url));
const repo = fileURLToPath(new URL('..', import.meta.url));

function createFixture(topicUnavailablePolicy?: 'stop', session: Record<string, unknown> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'botmux-turn-idempotency-'));
  const dataDir = join(root, 'data');
  const sessionId = 'sid_turn_idempotency';
  const turnId = 'om_turn_idempotency';
  mkdirSync(join(dataDir, '.botmux-cli-pids'), { recursive: true });
  writeFileSync(join(dataDir, '.botmux-cli-pids', String(process.pid)), JSON.stringify({ sessionId, turnId }));
  writeFileSync(join(root, 'bots.json'), JSON.stringify([{
    larkAppId: 'cli_test', larkAppSecret: 'test-secret', cliId: 'codex', replyCardMode: 'legacy', topicUnavailablePolicy,
  }]));
  seedPersistedSessionRows(dataDir, 'cli_test', { [sessionId]: {
    sessionId, status: 'active', cliId: 'codex', larkAppId: 'cli_test',
    chatId: 'oc_test', rootMessageId: 'om_root', scope: 'thread', chatType: 'group', workingDir: root,
    ...session,
  } });
  const run = (
    kind: 'progress' | 'final' | 'auxiliary',
    content: string,
    extraArgs: string[] = [],
    topicState = 'live',
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
        BOTMUX_LARK_APP_ID: 'cli_test', ...(topicUnavailablePolicy ? { BOTMUX_TEST_TOPIC_STATE: topicState } : {}) },
      encoding: 'utf8', timeout: 30_000,
    });
    const requests = String(result.stdout).split('\n').filter(line => line.startsWith('CAPTURE_REPLY='));
    return { result, requests };
  };
  return { root, dataDir, sessionId, turnId, run };
}

describe('botmux send per-turn final idempotency', () => {
  it('does not reserve or publish when a thread source has no message identity', () => {
    const f = createFixture('stop', { rootMessageId: '' });
    try {
      const attempt = f.run('final', 'answer', ['--top-level']);
      expect(attempt.result.status).not.toBe(0);
      expect(String(attempt.result.stderr)).toContain('TOPIC_SEND_CHECK_FAILED');
      expect(attempt.requests).toHaveLength(0);
      // Official read/maintenance paths may create directories and a prune marker.
      // They must not create a reservation or delivery record for this refusal.
      expect(new TurnSendLedger(f.dataDir).inspect()).toEqual([]);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  }, 30_000);

  it.each([['--top-level'], ['--top-level', '--chat-id', 'oc_other'], ['--into', 'om_other']])(
    'does not erase a chat turn quote source with destination arguments %j', (...args) => {
      const f = createFixture('stop', { scope: 'chat', replyTargets: {
        om_turn_idempotency: { rootMessageId: 'om_quote', quoteOnly: true, updatedAt: new Date().toISOString() },
      } });
      try {
        const attempt = f.run('final', 'answer', args, 'deleted');
        expect(attempt.result.status).not.toBe(0);
        expect(String(attempt.result.stderr)).toContain('TOPIC_SEND_BLOCKED');
        expect(attempt.requests).toHaveLength(0);
        // Official read/maintenance paths may create directories and a prune marker.
        // They must not create a reservation or delivery record for this refusal.
        expect(new TurnSendLedger(f.dataDir).inspect()).toEqual([]);
      } finally { rmSync(f.root, { recursive: true, force: true }); }
    }, 30_000,
  );
  it('keeps the executing thread source when an explicit destination session is unthreaded', () => {
    const f = createFixture('stop');
    try {
      seedPersistedSessionRows(f.dataDir, 'cli_test', { sid_other: {
        sessionId: 'sid_other', status: 'active', cliId: 'codex', larkAppId: 'cli_test',
        chatId: 'oc_other', rootMessageId: 'om_other', scope: 'chat', chatType: 'group', workingDir: f.root,
      } });
      const attempt = f.run('final', 'answer', ['--session-id', 'sid_other', '--top-level'], 'deleted');
      expect(attempt.result.status).not.toBe(0);
      expect(String(attempt.result.stderr)).toContain('TOPIC_SEND_BLOCKED');
      expect(attempt.requests).toHaveLength(0);
      // Official read/maintenance paths may create directories and a prune marker.
      // They must not create a reservation or delivery record for this refusal.
      expect(new TurnSendLedger(f.dataDir).inspect()).toEqual([]);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  }, 30_000);

  it.each(['deleted', 'missing', 'unknown'])('returns the existing final without a new effect when the source is %s', state => {
    const f = createFixture('stop');
    try {
      const first = f.run('final', 'answer');
      expect(first.result.status, String(first.result.stderr)).toBe(0);
      expect(first.requests).toHaveLength(1);
      const recordPath = readdirLedger(f.dataDir);
      const original = readFileSync(recordPath, 'utf8');
      const retry = f.run('final', 'answer', [], state);
      expect(retry.result.status, String(retry.result.stderr)).toBe(0);
      expect(JSON.parse(String(retry.result.stdout).trim())).toMatchObject({
        messageId: 'om_separate_message', replayed: true,
      });
      expect(retry.requests).toHaveLength(0);
      expect(readFileSync(recordPath, 'utf8')).toBe(original);
      const restored = f.run('final', 'answer');
      expect(restored.result.status, String(restored.result.stderr)).toBe(0);
      expect(restored.requests).toHaveLength(0);
      expect(JSON.parse(String(restored.result.stdout).trim())).toMatchObject({ messageId: 'om_separate_message', replayed: true });
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  }, 40_000);

  it.each([{ args: [] }, { args: ['--top-level', '--chat-id', 'oc_other'] }])('does not reserve or send after source loss despite destination arguments $args', ({ args }) => {
    const f = createFixture('stop');
    try {
      const attempt = f.run('final', 'answer', args, 'deleted');
      expect(attempt.result.status).not.toBe(0);
      expect(String(attempt.result.stderr)).toContain('TOPIC_SEND_BLOCKED');
      expect(attempt.requests).toHaveLength(0);
      // Official read/maintenance paths may create directories and a prune marker.
      // They must not create a reservation or delivery record for this refusal.
      expect(new TurnSendLedger(f.dataDir).inspect()).toEqual([]);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  }, 30_000);

  it.each(['deleted', 'missing', 'unknown'])('retains an unknown provider checkpoint without sending when the source is %s', async state => {
    const f = createFixture('stop');
    try {
      const ledger = new TurnSendLedger(f.dataDir);
      const key = { larkAppId: 'cli_test', sessionId: f.sessionId, turnId: f.turnId };
      await expect(ledger.executeNonIdempotentSequence(key, 'final', 'original request', 1,
        async (_index, effects) => {
          effects.providerRequestStarted();
          throw new Error('unknown test provider response');
        }, 'original-target')).rejects.toThrow('unknown test provider response');
      const path = ledger.recordPath(key);
      const original = readFileSync(path, 'utf8');
      const before = ledger.inspect();
      expect(before).toHaveLength(1);
      const retry = f.run('final', 'answer', [], state);
      expect(retry.result.status).not.toBe(0);
      expect(String(retry.result.stderr)).toContain(state === 'deleted' ? 'TOPIC_SEND_BLOCKED' : 'TOPIC_SEND_CHECK_FAILED');
      expect(retry.requests).toEqual([]);
      expect(readFileSync(path, 'utf8')).toBe(original);
      expect(ledger.inspect()).toEqual(before);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  }, 40_000);

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

      const record = JSON.parse(readFileSync(readdirLedger(f.dataDir), 'utf8'));
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
      const recordPath = readdirLedger(f.dataDir);
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

/** Path of the single record the fixture's session wrote (per-session layout). */
function readdirLedger(dataDir: string): string {
  const root = join(dataDir, 'turn-send-ledger');
  const sessions = readdirSync(root).filter(name => !name.startsWith('.'));
  expect(sessions).toHaveLength(1);
  const sessionDir = join(root, sessions[0]!);
  return join(sessionDir, readdirSync(sessionDir).find(name => name.endsWith('.json'))!);
}
