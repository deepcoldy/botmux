import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { spawnSyncTsScript } from './helpers/ts-runner.js';
import { seedPersistedSessionRows } from './helpers/session-store-disk.js';
import { CodexBridgeQueue } from '../src/services/codex-bridge-queue.js';
import { bridgeGateInputForTurn, structuredFallbackKind } from '../src/services/bridge-fallback-gate.js';

describe.skipIf(process.platform === 'win32')('real CLI delayed delivery receipts', () => {
  it.each([
    ['voice', false], ['doc-comment', false],
    ['text', true], ['voice', true], ['doc-comment', true], ['text-with-file', false],
  ] as const)('does not let an older %s final ACK hide an unanswered folded input (replay=%s)', (kind, replay) => {
    const root = mkdtempSync(join(tmpdir(), 'delayed-cli-send-'));
    try {
      const dataDir = join(root, 'data');
      const binDir = join(root, 'bin');
      mkdirSync(join(dataDir, '.botmux-cli-pids'), { recursive: true });
      mkdirSync(binDir);
      // Replace only the audio encoder; the real TTS/SDK/CLI paths still run.
      writeFileSync(join(binDir, 'opusenc'), [
        '#!/bin/sh', 'if [ "$1" = "--version" ]; then exit 0; fi',
        'for last do :; done', 'printf "test-opus" > "$last"', '',
      ].join('\n'), { mode: 0o755 });
      writeFileSync(join(root, 'bots.json'), JSON.stringify([{
        larkAppId: 'cli_test', larkAppSecret: 'secret', cliId: 'codex', replyCardMode: 'legacy',
        voice: { engine: 'openai', openai: { baseUrl: 'https://tts.example.test/v1', model: 'test' } },
      }]));
      writeFileSync(join(dataDir, '.botmux-cli-pids', String(process.pid)), JSON.stringify({
        sessionId: 'sid', turnId: 'old-input',
      }));
      seedPersistedSessionRows(dataDir, 'cli_test', { sid: {
        sessionId: 'sid', status: 'active', larkAppId: 'cli_test', cliId: 'codex',
        scope: 'chat', chatType: 'group', workingDir: root,
        chatId: kind === 'doc-comment' ? 'doc:doc_test:comment_test' : 'oc_chat',
        ...(kind === 'doc-comment' ? { docCommentTargets: { 'old-input': {
          fileToken: 'doc_test', fileType: 'docx', commentId: 'comment_test', turnId: 'old-input',
        } } } : {}),
      } });
      const attachment = join(root, 'answer.txt');
      writeFileSync(attachment, 'Attachment for the old input');
      const result = spawnSyncTsScript(fileURLToPath(new URL('./fixtures/send-delayed-receipt.ts', import.meta.url)), [
        'send', '--no-mention', '--response-kind', 'final',
        ...(kind === 'voice' ? ['--voice'] : []), 'Answer for the older input only.',
        ...(kind === 'text-with-file' ? ['--files', attachment] : []),
      ], {
        cwd: process.cwd(), encoding: 'utf8', timeout: 30_000,
        env: { PATH: [binDir, process.env.PATH].join(delimiter), HOME: root,
          SESSION_DATA_DIR: dataDir, BOTS_CONFIG: join(root, 'bots.json'),
          BOTMUX_SESSION_ID: 'sid', BOTMUX_LARK_APP_ID: 'cli_test',
          ...(replay ? { BOTMUX_TEST_REPLAY_FINAL: '1' } : {}),
          ...(kind === 'text-with-file' ? { BOTMUX_TEST_DELAY_ATTACHMENT: '1' } : {}),
        },
      });
      expect(result.status, String(result.stderr)).toBe(0);
      const clock = JSON.parse(String(result.stdout).split('\n')
        .find(line => line.startsWith('SEND_CLOCK='))!.slice('SEND_CLOCK='.length));
      const receipts = readFileSync(join(dataDir, 'turn-sends', 'sid.jsonl'), 'utf8')
        .trim().split('\n').map(line => JSON.parse(line));
      expect(receipts).toHaveLength(kind === 'text-with-file' ? 2 : 1);
      for (const receipt of receipts) {
        expect(receipt.responseKind).toBe('final');
        expect(receipt.sentAtMs).toBeLessThan(clock.nextInputAt);
      }
      expect(String(result.stdout).split('\n').filter(line => line.startsWith('PROVIDER_DELIVERY=')))
        .toHaveLength(kind === 'text-with-file' ? 2 : 1);
      if (replay) {
        expect(result.stdout).toContain('"replayed":true');
        const outcome = JSON.parse(String(result.stdout).split('\n')
          .find(line => line.startsWith('REPLAY_RESULT='))!.slice('REPLAY_RESULT='.length));
        expect(outcome).toEqual({ publisherReplayed: false, loserReplayed: true });
      }

      const queue = new CodexBridgeQueue(() => clock.startedAt);
      for (const [turnId, timestampMs] of [
        ['old-input', clock.startedAt - 10], ['new-input', clock.nextInputAt],
      ] as const) {
        queue.mark(turnId, turnId, timestampMs);
        queue.ingest([{ uuid: turnId, kind: 'user', text: turnId, timestampMs,
          sourceMessageId: turnId, sourceSessionId: 'provider', sourceTurnId: 'native' }]);
      }
      queue.ingest([{ uuid: 'terminal', kind: 'assistant_final', text: '',
        timestampMs: clock.startedAt + 80, sourceSessionId: 'provider', sourceTurnId: 'native' }]);
      const [turn] = queue.drainEmittable();
      const input = bridgeGateInputForTurn('sid', turn, {
        markTimeMs: turn.markTimeMs, isLocal: turn.isLocal, finalText: turn.finalText,
      });
      expect(input.supersededTurns).toEqual([{ turnId: 'old-input', dispatchAttempt: undefined }]);
      expect(structuredFallbackKind(input, undefined, receipts, false, true)).toBe('empty_completed');
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, 35_000);
});
