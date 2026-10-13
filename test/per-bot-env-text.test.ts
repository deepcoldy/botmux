import { describe, expect, it } from 'vitest';
import { nextPerBotEnv, parsePerBotEnvText } from '../src/core/per-bot-env.js';

describe('parsePerBotEnvText', () => {
  it('parses a JSON object and unwraps a Claude settings {"env":{…}} snippet', () => {
    expect(parsePerBotEnvText('{"A":"1","B":2}')).toEqual({ ok: true, format: 'json', env: { A: '1', B: 2 }, ignoredLines: [] });
    expect(parsePerBotEnvText('{"env":{"ANTHROPIC_BASE_URL":"http://x"}}'))
      .toMatchObject({ ok: true, format: 'json', env: { ANTHROPIC_BASE_URL: 'http://x' } });
    // env alongside other settings keys is NOT unwrapped (not a pure snippet).
    expect(parsePerBotEnvText('{"env":{"A":"1"},"model":"m"}'))
      .toMatchObject({ ok: true, env: { env: { A: '1' }, model: 'm' } });
    expect(parsePerBotEnvText('{"A":')).toEqual({ ok: false, reason: 'invalid_json' });
    expect(parsePerBotEnvText('  ')).toEqual({ ok: false, reason: 'empty' });
  });

  it('parses dotenv with export, quotes, escapes and comments', () => {
    const r = parsePerBotEnvText([
      '# provider',
      'ANTHROPIC_BASE_URL=http://160.0.0.1:8080',
      'export TOKEN="a b\\"c\\n"',
      "MODEL='claude-opus-5-5' # trailing",
      'PLAIN=v # comment',
      'HASH=a#b',
      'EMPTY=',
      'REF=$HOME/x',
      'A=1',
      'A=2',
    ].join('\n'));
    expect(r).toEqual({
      ok: true,
      format: 'dotenv',
      env: {
        ANTHROPIC_BASE_URL: 'http://160.0.0.1:8080',
        TOKEN: 'a b"c\n',
        MODEL: 'claude-opus-5-5',
        PLAIN: 'v',
        HASH: 'a#b',
        EMPTY: '',
        REF: '$HOME/x',
        A: '2',
      },
      ignoredLines: [],
    });
  });

  it('accepts an `exec env \\` launcher script and reports skipped lines', () => {
    const script = [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'exec env \\',
      "  ANTHROPIC_BASE_URL='http://160.191.8.131:8080' \\",
      "  ANTHROPIC_MODEL='claude-opus-5-5' \\",
      '  claude "$@"',
    ].join('\n');
    expect(parsePerBotEnvText(script)).toEqual({
      ok: true,
      format: 'dotenv',
      env: { ANTHROPIC_BASE_URL: 'http://160.191.8.131:8080', ANTHROPIC_MODEL: 'claude-opus-5-5' },
      ignoredLines: [2, 3, 6],
    });
  });

  it('rejects unterminated quotes and text without any assignment', () => {
    expect(parsePerBotEnvText('A=1\nB="oops')).toEqual({ ok: false, reason: 'invalid_env_line', line: 2 });
    expect(parsePerBotEnvText("A='x' junk")).toEqual({ ok: false, reason: 'invalid_env_line', line: 1 });
    expect(parsePerBotEnvText('hello world')).toEqual({ ok: false, reason: 'invalid_env_line', line: 1 });
  });
});

describe('nextPerBotEnv', () => {
  const prev = { A: '1', B: '2' };
  it('replace keeps only incoming; empty clears', () => {
    expect(nextPerBotEnv({ prev, incoming: { C: '3' }, mode: 'replace' })).toEqual({ C: '3' });
    expect(nextPerBotEnv({ prev, incoming: {}, mode: 'replace' })).toBeNull();
  });
  it('merge overrides same names, keeps the rest, applies removals', () => {
    expect(nextPerBotEnv({ prev, incoming: { B: 'x', C: '3' }, mode: 'merge' })).toEqual({ A: '1', B: 'x', C: '3' });
    expect(nextPerBotEnv({ prev, incoming: {}, mode: 'merge', remove: ['A'] })).toEqual({ B: '2' });
    expect(nextPerBotEnv({ prev, incoming: {}, mode: 'merge', remove: ['A', 'B'] })).toBeNull();
    expect(prev).toEqual({ A: '1', B: '2' });
  });
});
