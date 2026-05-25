/**
 * Pure-function tests for `botmux ask` argument parsing. Covers:
 *  - --options CSV (key only / key=label / dedupe / empty key / count floor)
 *  - --timeout bounds and integer-only enforcement
 *  - missing env detection in §5 order
 *
 * Run:  pnpm vitest run test/ask-args.test.ts
 */
import { describe, expect, it } from 'vitest';

import {
  AskArgsError,
  findMissingAskEnv,
  normalizeAskDispatch,
  parseAskOptions,
  parseAskTimeoutSeconds,
} from '../src/core/ask-args.js';

describe('parseAskOptions', () => {
  it('parses bare keys with key==label', () => {
    expect(parseAskOptions('yes,no')).toEqual([
      { key: 'yes', label: 'yes' },
      { key: 'no', label: 'no' },
    ]);
  });

  it('parses key=label form, label can be CJK', () => {
    expect(parseAskOptions('yes=继续,no=回滚')).toEqual([
      { key: 'yes', label: '继续' },
      { key: 'no', label: '回滚' },
    ]);
  });

  it('mixes key-only and key=label entries', () => {
    expect(parseAskOptions('go,abort=取消')).toEqual([
      { key: 'go', label: 'go' },
      { key: 'abort', label: '取消' },
    ]);
  });

  it('treats further "=" as part of label (only first "=" splits)', () => {
    expect(parseAskOptions('go=继续=右,no=不')).toEqual([
      { key: 'go', label: '继续=右' },
      { key: 'no', label: '不' },
    ]);
  });

  it('trims whitespace around items and around key/label halves', () => {
    expect(parseAskOptions('  yes  ,  no = 不要 ')).toEqual([
      { key: 'yes', label: 'yes' },
      { key: 'no', label: '不要' },
    ]);
  });

  it('drops empty items between commas (trailing comma is forgiving)', () => {
    expect(parseAskOptions('yes,,no,')).toEqual([
      { key: 'yes', label: 'yes' },
      { key: 'no', label: 'no' },
    ]);
  });

  it('falls back label to key when "key=" has empty label half', () => {
    expect(parseAskOptions('yes=,no')).toEqual([
      { key: 'yes', label: 'yes' },
      { key: 'no', label: 'no' },
    ]);
  });

  it('rejects undefined / empty input', () => {
    expect(() => parseAskOptions(undefined)).toThrowError(AskArgsError);
    expect(() => parseAskOptions('')).toThrowError(/缺少 --options/);
    expect(() => parseAskOptions('   ')).toThrowError(/缺少 --options/);
  });

  it('rejects fewer than 2 items', () => {
    expect(() => parseAskOptions('onlyone')).toThrowError(/至少需要 2 项/);
  });

  it('rejects empty key like "=label"', () => {
    expect(() => parseAskOptions('=label,yes')).toThrowError(/key 不能为空/);
  });

  it('rejects duplicate keys (no silent dedupe)', () => {
    expect(() => parseAskOptions('yes,no,yes')).toThrowError(/重复 key: yes/);
  });

  it('tags errors with structured code for upstream mapping', () => {
    try {
      parseAskOptions('yes,yes');
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(AskArgsError);
      expect((err as AskArgsError).code).toBe('options_duplicate_key');
    }
  });
});

describe('parseAskTimeoutSeconds', () => {
  it('defaults to 300s when unset', () => {
    expect(parseAskTimeoutSeconds(undefined)).toBe(300_000);
    expect(parseAskTimeoutSeconds('')).toBe(300_000);
  });

  it('parses integer seconds into ms', () => {
    expect(parseAskTimeoutSeconds('600')).toBe(600_000);
    expect(parseAskTimeoutSeconds('  10  ')).toBe(10_000);
  });

  it('rejects non-integer / non-numeric input', () => {
    expect(() => parseAskTimeoutSeconds('abc')).toThrowError(/必须是整数秒数/);
    expect(() => parseAskTimeoutSeconds('1.5')).toThrowError(/必须是整数秒数/);
  });

  it('rejects values outside [10, 3600]', () => {
    expect(() => parseAskTimeoutSeconds('5')).toThrowError(/范围/);
    expect(() => parseAskTimeoutSeconds('7200')).toThrowError(/范围/);
  });

  it('accepts custom bounds', () => {
    expect(parseAskTimeoutSeconds('1', { default: 5, min: 1, max: 2 })).toBe(1000);
    expect(() =>
      parseAskTimeoutSeconds('3', { default: 5, min: 1, max: 2 }),
    ).toThrowError(/范围/);
  });
});

describe('normalizeAskDispatch', () => {
  it('canonical form: `ask buttons --options ...` keeps sub=buttons', () => {
    expect(normalizeAskDispatch(['buttons', '--options', 'yes,no', 'prompt'])).toEqual({
      sub: 'buttons',
      rest: ['--options', 'yes,no', 'prompt'],
    });
  });

  it('bare alias: `ask --options ...` routes to sub="" with all flags in rest', () => {
    expect(normalizeAskDispatch(['--options', 'yes,no', 'prompt'])).toEqual({
      sub: '',
      rest: ['--options', 'yes,no', 'prompt'],
    });
  });

  it('bare alias: `ask --json --options ...` (any leading flag triggers alias)', () => {
    expect(
      normalizeAskDispatch(['--json', '--options', 'yes,no', 'prompt']),
    ).toEqual({
      sub: '',
      rest: ['--json', '--options', 'yes,no', 'prompt'],
    });
  });

  it('empty tail (just `botmux ask`) routes to sub="" with no rest', () => {
    expect(normalizeAskDispatch([])).toEqual({ sub: '', rest: [] });
  });

  it('unknown subcommand passes through so cmdAsk can emit a useful error', () => {
    expect(normalizeAskDispatch(['text', '--options', 'a,b'])).toEqual({
      sub: 'text',
      rest: ['--options', 'a,b'],
    });
  });

  it('canonical form equivalence: bare alias and `buttons` produce same `rest`', () => {
    const bare = normalizeAskDispatch(['--options', 'yes,no', 'p']);
    const explicit = normalizeAskDispatch(['buttons', '--options', 'yes,no', 'p']);
    expect(bare.rest).toEqual(explicit.rest);
  });
});

describe('findMissingAskEnv', () => {
  it('returns null when all four env vars are present', () => {
    expect(
      findMissingAskEnv({
        BOTMUX_SESSION_ID: 'sess-1',
        BOTMUX_CHAT_ID: 'oc_1',
        BOTMUX_LARK_APP_ID: 'cli_1',
        BOTMUX_ROOT_MESSAGE_ID: 'om_1',
      }),
    ).toBeNull();
  });

  it('reports the first missing var in §5 order', () => {
    expect(
      findMissingAskEnv({
        BOTMUX_CHAT_ID: 'oc_1',
        BOTMUX_LARK_APP_ID: 'cli_1',
        BOTMUX_ROOT_MESSAGE_ID: 'om_1',
      }),
    ).toBe('BOTMUX_SESSION_ID');
    expect(
      findMissingAskEnv({
        BOTMUX_SESSION_ID: 'sess-1',
        BOTMUX_LARK_APP_ID: 'cli_1',
        BOTMUX_ROOT_MESSAGE_ID: 'om_1',
      }),
    ).toBe('BOTMUX_CHAT_ID');
  });

  it('treats blank/whitespace as missing', () => {
    expect(
      findMissingAskEnv({
        BOTMUX_SESSION_ID: '   ',
        BOTMUX_CHAT_ID: 'oc_1',
        BOTMUX_LARK_APP_ID: 'cli_1',
        BOTMUX_ROOT_MESSAGE_ID: 'om_1',
      }),
    ).toBe('BOTMUX_SESSION_ID');
  });
});
