import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { spawnSyncTsScript } from './helpers/ts-runner.js';
import { t } from '../src/i18n/index.js';

// The real `botmux send` reads the spawn-time REPLY_DELIVERY_ENV snapshot of its
// pane to decide post-send output: in a send session (or a pane without the
// snapshot) it prints the standard `--response-kind final` guidance; in an
// auto-forward final reply (`transcript`) session it prints only the factual
// delivery receipt without any extra persuasion.
describe('botmux send post-send guidance follows the pane reply delivery', () => {
  function runSend(snapshot: 'transcript' | 'send' | undefined) {
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
      return String(result.stderr);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('BOTMUX_REPLY_DELIVERY=transcript emits only the factual receipt with no extra persuasion', () => {
    const stderr = runSend('transcript');
    expect(stderr).toContain('✓ 已发送');
    expect(stderr).not.toContain(t('ai.send.after_success_progress', undefined, 'zh'));
    expect(stderr).not.toContain('--response-kind final');
    expect(stderr).not.toContain('不必 send');
    expect(stderr).not.toContain('阶段小结');
    expect(stderr).not.toContain('自动发回飞书');
  });

  it.each(['send', undefined] as const)('BOTMUX_REPLY_DELIVERY=%s keeps the standard send-mode guidance', snapshot => {
    const stderr = runSend(snapshot);
    expect(stderr).toContain('✓ 已发送');
    expect(stderr).toContain(t('ai.send.after_success_progress', undefined, 'zh'));
  });
});
