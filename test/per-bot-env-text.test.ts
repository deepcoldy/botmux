import { describe, expect, it } from 'vitest';
import { nextPerBotEnv, parsePerBotEnvText } from '../src/core/per-bot-env.js';
import { createDashboardTranslator } from '../src/dashboard/web/i18n.js';

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
      // The continued `exec env … claude "$@"` is one logical line with
      // assignments; only `set -euo pipefail` is reported as skipped.
      ignoredLines: [2],
    });
  });

  it('rejects unterminated quotes and text without any assignment', () => {
    expect(parsePerBotEnvText('A=1\nB="oops')).toEqual({ ok: false, reason: 'invalid_env_line', line: 2 });
    expect(parsePerBotEnvText("A='x' junk")).toEqual({ ok: false, reason: 'invalid_env_line', line: 1 });
    expect(parsePerBotEnvText('hello world')).toEqual({ ok: false, reason: 'invalid_env_line', line: 1 });
  });

  it('keeps the backslash of unknown escapes inside double quotes', () => {
    expect(parsePerBotEnvText('REGEX="^\\d+$"\nWIN="C:\\Users\\x"\nQ="a\\"b\\\\c\\$d"'))
      .toMatchObject({ ok: true, env: { REGEX: '^\\d+$', WIN: 'C:\\Users\\x', Q: 'a"b\\c$d' } });
  });

  it('joins backslash continuations like the shell and rejects a dangling one', () => {
    expect(parsePerBotEnvText('TOKEN=abc\\\ndef')).toMatchObject({ ok: true, env: { TOKEN: 'abcdef' } });
    expect(parsePerBotEnvText('TOKEN=abc \\')).toEqual({ ok: false, reason: 'invalid_env_line', line: 1 });
  });

  it('splits words with shell quoting instead of swallowing them into one value', () => {
    expect(parsePerBotEnvText('A=1 B=2')).toMatchObject({ ok: true, env: { A: '1', B: '2' } });
    // A reserved assignment after a normal one is still seen (and later rejected).
    expect(parsePerBotEnvText('A=1 CLAUDE_CONFIG_DIR=/x')).toMatchObject({ ok: true, env: { A: '1', CLAUDE_CONFIG_DIR: '/x' } });
    expect(parsePerBotEnvText('TOKEN=abc; exec claude')).toEqual({ ok: false, reason: 'invalid_env_line', line: 1 });
    expect(parsePerBotEnvText('TOKEN=abc"def')).toEqual({ ok: false, reason: 'invalid_env_line', line: 1 });
    expect(parsePerBotEnvText('TOKEN=abc def')).toEqual({ ok: false, reason: 'invalid_env_line', line: 1 });
    expect(parsePerBotEnvText('"A=1"')).toEqual({ ok: false, reason: 'invalid_json' });
  });

  it('keeps dotenv `KEY = value` compatibility instead of silently skipping it', () => {
    expect(parsePerBotEnvText('TOKEN = secret\nA =1\nMODEL=x')).toMatchObject({ ok: true, env: { TOKEN: 'secret', A: '1', MODEL: 'x' }, ignoredLines: [] });
    expect(parsePerBotEnvText('TOKEN = a b')).toEqual({ ok: false, reason: 'invalid_env_line', line: 1 });
    expect(parsePerBotEnvText('MODEL=x\nTOKEN = a b c')).toEqual({ ok: false, reason: 'invalid_env_line', line: 2 });
    expect(parsePerBotEnvText('TOKEN ="" secret')).toEqual({ ok: false, reason: 'invalid_env_line', line: 1 });
    expect(parsePerBotEnvText('TOKEN =""\nEMPTY =')).toMatchObject({ ok: true, env: { TOKEN: '', EMPTY: '' } });
  });

  it('applies dotenv spacing compatibility after an export prefix and for `KEY= v`', () => {
    // Regression: `export A = 1` used to fall through to the "ignored" skip,
    // so saving `export A = 1\nB=2` stored only B.
    expect(parsePerBotEnvText('export A = 1\nB=2')).toMatchObject({ ok: true, env: { A: '1', B: '2' }, ignoredLines: [] });
    expect(parsePerBotEnvText('A= 1\nC= "x y"\nD=')).toMatchObject({ ok: true, env: { A: '1', C: 'x y', D: '' } });
    expect(parsePerBotEnvText('A= B=2')).toMatchObject({ ok: true, env: { A: '', B: '2' } });
    expect(parsePerBotEnvText('A= 1 2')).toEqual({ ok: false, reason: 'invalid_env_line', line: 1 });
    expect(parsePerBotEnvText('export A = 1 2')).toEqual({ ok: false, reason: 'invalid_env_line', line: 1 });
  });

  it('parses the editor placeholder example in every locale', () => {
    for (const locale of ['zh', 'en'] as const) {
      const r = parsePerBotEnvText(createDashboardTranslator(locale)('botDefaults.envPlaceholder'));
      expect(r, locale).toMatchObject({ ok: true });
      if (r.ok) expect(Object.keys(r.env), locale).toEqual(['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_MODEL']);
    }
  });

  it('accepts quoted NAME=value arguments of an env launcher', () => {
    expect(parsePerBotEnvText('env A=1 "TOKEN=secret" claude')).toMatchObject({ ok: true, env: { A: '1', TOKEN: 'secret' } });
  });

  it('treats a comment after an empty assignment as a comment', () => {
    expect(parsePerBotEnvText('TOKEN= # comment\nHASH=a#b')).toMatchObject({ ok: true, env: { TOKEN: '', HASH: 'a#b' } });
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
