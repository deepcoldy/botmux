import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LongTaskExecution } from '../src/core/long-task-reminder.js';

vi.mock('../src/im/lark/client.js', () => ({
  sendMessage: vi.fn(async () => 'om_card'),
  replyMessage: vi.fn(async () => 'om_card'),
}));

/** Exact per-turn destination stays distinct from a later queued message. */
function task(mode: 'plain' | 'thread' | 'quote'): LongTaskExecution {
  return {
    executionKey: '["om_original",null]', turnId: 'om_original', startedAtMs: 0, workerGeneration: 1,
    session: {
      larkAppId: 'cli_test', scope: 'chat', chatId: 'oc_test',
      session: {
        title: '<at id=all> user task', rootMessageId: 'om_later',
        turnReplyContexts: { om_original: { target: mode === 'plain'
          ? { mode, chatId: 'oc_test' } : { mode, rootMessageId: 'om_original_root' } } },
      },
    },
  } as LongTaskExecution;
}

afterEach(() => { vi.clearAllMocks(); });

describe('long-task card transport', () => {
  it.each(['plain', 'thread', 'quote'] as const)('uses the original %s destination and provider fence', async mode => {
    /** Real delivery adapter, with only the remote provider calls stubbed. */
    const { sendLongTaskReminder } = await import('../src/services/long-task-reminder-notification.js');
    /** Provider spies expose wire arguments without issuing real Lark writes. */
    const { sendMessage, replyMessage } = await import('../src/im/lark/client.js');
    /** Late validation must be passed into Lark's actual provider retry gate. */
    const beforeWrite = vi.fn();
    await sendLongTaskReminder(task(mode), 12, 'dedupe-id', beforeWrite);
    if (mode === 'plain') {
      expect(sendMessage).toHaveBeenCalledWith('cli_test', 'oc_test', expect.any(String), 'interactive', 'dedupe-id', undefined, { beforeWrite, suppressHook: true });
      expect(replyMessage).not.toHaveBeenCalled();
    } else {
      expect(replyMessage).toHaveBeenCalledWith('cli_test', 'om_original_root', expect.any(String), 'interactive', mode === 'thread', 'dedupe-id', undefined, { beforeWrite, suppressHook: true });
      expect(sendMessage).not.toHaveBeenCalled();
    }
    /** User titles are plain text, so mention-like text cannot create mentions. */
    const { longTaskReminderCard } = await import('../src/services/long-task-reminder-notification.js');
    expect(JSON.parse(longTaskReminderCard(task(mode), 12)).elements[0].text)
      .toEqual({ tag: 'plain_text', content: '<at id=all> user task' });
  });
});

describe('long-task preferences persistence', () => {
  it('round-trips settings through disk and the registry without touching other fields', async () => {
    /** A private temporary bots.json prevents access to live bot credentials. */
    const dir = mkdtempSync(join(tmpdir(), 'botmux-long-task-'));
    /** Keep the real environment intact when the isolated store is released. */
    const previousPath = process.env.BOTS_CONFIG;
    /** Registry and atomic store share this fixture configuration path. */
    const configPath = join(dir, 'bots.json');
    process.env.BOTS_CONFIG = configPath;
    try {
      writeFileSync(configPath, JSON.stringify([{ larkAppId: 'cli_test', larkAppSecret: 'test-only', cliId: 'codex-app', brandLabel: 'keep-me' }]));
      /** Real registry loader proves the new field survives a configuration reload. */
      const registry = await import('../src/bot-registry.js');
      registry.loadBotConfigs().forEach(config => { registry.registerBot(config); });
      /** Exercise the actual file-lock and atomic read-modify-write service. */
      const { updateLongTaskReminderConfig } = await import('../src/services/long-task-reminder-config-store.js');
      /** Custom first and repeat times must remain independent after persistence. */
      const preferences = { enabled: true, thresholdMinutes: 12, intervalMinutes: 3 };
      expect(await updateLongTaskReminderConfig('cli_test', preferences)).toEqual({ ok: true, config: preferences });
      expect(registry.getBot('cli_test').config.longTaskReminder).toEqual(preferences);
      expect(JSON.parse(readFileSync(configPath, 'utf8'))[0]).toMatchObject({ brandLabel: 'keep-me', longTaskReminder: preferences });
      expect(registry.loadBotConfigs()[0].longTaskReminder).toEqual(preferences);
      expect(await updateLongTaskReminderConfig('cli_test', { ...preferences, intervalMinutes: 0 })).toMatchObject({ ok: false });
      expect(JSON.parse(readFileSync(configPath, 'utf8'))[0].longTaskReminder).toEqual(preferences);
    } finally {
      if (previousPath === undefined) {
        delete process.env.BOTS_CONFIG;
      } else {
        process.env.BOTS_CONFIG = previousPath;
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
