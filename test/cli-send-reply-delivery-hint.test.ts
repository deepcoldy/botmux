import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { spawnSyncTsScript } from './helpers/ts-runner.js';
import { t } from '../src/i18n/index.js';

// The real `botmux send` reads the spawn-time REPLY_DELIVERY_ENV snapshot of its
// pane to word the guidance printed after a successful send: a transcript
// session is pointed back at its forwarded final reply, a send session (or a
// pane started before the snapshot existed) at `--response-kind final`.
describe('botmux send post-send guidance follows the pane reply delivery', () => {
  it.each([
    ['transcript', 'ai.send.after_success_progress_transcript', 'ai.send.after_success_progress'],
    ['send', 'ai.send.after_success_progress', 'ai.send.after_success_progress_transcript'],
    [undefined, 'ai.send.after_success_progress', 'ai.send.after_success_progress_transcript'],
  ] as const)('BOTMUX_REPLY_DELIVERY=%s', (snapshot, expected, other) => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-send-delivery-hint-'));
    try {
      const result = spawnSyncTsScript(fileURLToPath(new URL('./fixtures/send-image-mode-capture.ts', import.meta.url)), [
        'send', '--no-mention', '--top-level', '进度：已完成一半',
      ], {
        env: {
          PATH: process.env.PATH, HOME: dir, SESSION_DATA_DIR: join(dir, 'data'), BOTS_CONFIG: join(dir, 'bots.json'),
          BOTMUX_LARK_APP_ID: 'cli_test', BOTMUX_LARK_APP_SECRET: 'test',
          BOTMUX_SESSION_ID: 'test-delivery-hint', BOTMUX_CHAT_ID: 'oc_test', BOTMUX_SESSION_SCOPE: 'chat',
          ...(snapshot ? { BOTMUX_REPLY_DELIVERY: snapshot } : {}),
        },
        encoding: 'utf8', timeout: 30_000,
      });
      expect(result.status, String(result.stderr)).toBe(0);
      const stderr = String(result.stderr);
      expect(stderr).toContain(t(expected, undefined, 'zh'));
      expect(stderr).not.toContain(t(other, undefined, 'zh'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
