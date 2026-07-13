import { describe, it, expect } from 'vitest';
import { sanitizePerBotEnv, isReservedPerBotEnvKey } from '../src/core/per-bot-env.js';

describe('sanitizePerBotEnv()', () => {
  it('keeps valid env keys and stringifies primitive values', () => {
    expect(
      sanitizePerBotEnv({
        ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic',
        ANTHROPIC_AUTH_TOKEN: 'glm-key',
        HTTPS_PROXY: 'http://127.0.0.1:7890',
        OPENAI_TIMEOUT_MS: 30000,
        FEATURE_FLAG: true,
        EMPTY_VALUE: '',
      }),
    ).toEqual({
      ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic',
      ANTHROPIC_AUTH_TOKEN: 'glm-key',
      HTTPS_PROXY: 'http://127.0.0.1:7890',
      OPENAI_TIMEOUT_MS: '30000',
      FEATURE_FLAG: 'true',
      EMPTY_VALUE: '',
    });
  });

  it('drops invalid env-var names and non-primitive values', () => {
    expect(
      sanitizePerBotEnv({
        '1BAD': 'x',
        'BAD-NAME': 'x',
        'has space': 'x',
        OK_LIST: ['x'],
        OK_OBJ: { nested: true },
        NULLISH: null,
        UNDEF: undefined,
        VALID_NAME: false,
      }),
    ).toEqual({ VALID_NAME: 'false' });
  });

  it('drops botmux-reserved keys (session routing / creds / managed flags)', () => {
    expect(
      sanitizePerBotEnv({
        BOTMUX_SESSION_ID: 'hijack',
        BOTMUX_CHAT_ID: 'x',
        BOTMUX: '0',
        LARK_APP_ID: 'cli_x',
        LARK_APP_SECRET: 's',
        CLAUDECODE: '1',
        CLAUDE_CONFIG_DIR: '/tmp/evil',
        CODEX_HOME: '/tmp/evil-codex',
        GROK_HOME: '/tmp/evil-grok',
        CLAUDE_CODE_RESUME_TOKEN_THRESHOLD: '1',
        CJADK_INTERACTIVE: '1',
        IS_SANDBOX: '1',
        SESSION_DATA_DIR: '/tmp',
        __OWNER_OPEN_ID: 'ou_x',
        // a legit key survives alongside the rejected ones
        ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic',
      }),
    ).toEqual({ ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic' });
  });

  it('returns an empty object for missing / non-object input', () => {
    expect(sanitizePerBotEnv(undefined)).toEqual({});
    expect(sanitizePerBotEnv(null)).toEqual({});
    expect(sanitizePerBotEnv([])).toEqual({});
    expect(sanitizePerBotEnv('ANTHROPIC_BASE_URL=x')).toEqual({});
    expect(sanitizePerBotEnv(42)).toEqual({});
  });
});

describe('isReservedPerBotEnvKey()', () => {
  it('flags botmux-reserved keys and prefixes', () => {
    for (const k of [
      'BOTMUX', 'BOTMUX_SESSION_ID', 'BOTMUX_ANYTHING',
      'LARK_APP_ID', 'LARK_APP_SECRET',
      'CLAUDECODE', 'CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_RESUME_TOKEN_THRESHOLD',
      'CODEX_HOME', 'GROK_HOME',
      'CJADK_INTERACTIVE', 'IS_SANDBOX', 'SESSION_DATA_DIR', '__OWNER_OPEN_ID',
    ]) {
      expect(isReservedPerBotEnvKey(k), k).toBe(true);
    }
  });

  it('allows ordinary provider/proxy keys', () => {
    for (const k of [
      'ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'OPENAI_BASE_URL',
      'OPENAI_API_KEY', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'MY_FLAG',
    ]) {
      expect(isReservedPerBotEnvKey(k), k).toBe(false);
    }
  });
});
