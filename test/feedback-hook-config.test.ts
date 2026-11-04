import { describe, expect, it } from 'vitest';
import { normalizeFeedbackHook } from '../src/services/feedback-hook-config.js';

describe('host feedback hook registration', () => {
  const input = {
    id: 'review-hook', version: 1, protocolVersion: 1, hostId: 'host-example',
    command: ['/usr/bin/example', '--mode', 'review'], cwd: '/srv/example',
    allowedBotAppIds: ['app-example'], allowedChatIds: ['chat-example'], allowedActionIds: ['review'],
    timeoutMs: 5000, concurrency: 1, envRefs: { EXAMPLE_TOKEN: 'review-token' },
  };
  it('registers an explicit host command disabled by default', () => {
    expect(normalizeFeedbackHook(input)).toEqual({ ...input, enabled: false });
  });
  it.each([
    { command: ['example'] }, { command: 'sh -c example' }, { cwd: '../other' },
    { command: ['/usr/bin/example', 'bad\u0000argument'] }, { enabled: 'true' },
    { concurrency: 0 }, { timeoutMs: -1 }, { timeoutMs: 1.5 },
    { allowedChatIds: [] }, { allowedBotAppIds: ['*'] }, { allowedActionIds: ['review', 'review'] },
    { envRefs: { PATH: '/tmp/bin' } }, { envRefs: { LD_PRELOAD: 'library' } },
    { envRefs: { NODE_OPTIONS: 'options' } }, { envRefs: { EXAMPLE_TOKEN: '../secret' } },
    { envRefs: { BUN_OPTIONS: 'options' } }, { envRefs: { BOTS_CONFIG: 'other-config' } },
    { envRefs: { LARK_APP_ID: 'other-app' } }, { envRefs: { LARK_APP_SECRET: 'other-secret' } },
    { envRefs: { SESSION_DATA_DIR: 'other-dir' } },
    { env: { TOKEN: 'plaintext' } }, { protocolVersion: 2 }, { version: 0 },
  ])('rejects unsafe or ambiguous registration %j', change => {
    expect(() => normalizeFeedbackHook({ ...input, ...change })).toThrow(/feedbackHook/);
  });
  it('copies command and permission lists', () => {
    const normalized = normalizeFeedbackHook(input);
    normalized.command.push('extra');
    normalized.allowedChatIds.push('other');
    expect(input.command).toHaveLength(3);
    expect(input.allowedChatIds).toEqual(['chat-example']);
  });
  it('preserves empty and whitespace arguments', () => {
    expect(normalizeFeedbackHook({ ...input, command: ['/usr/bin/printf', '%s', '', ' '] }).command)
      .toEqual(['/usr/bin/printf', '%s', '', ' ']);
  });
});
