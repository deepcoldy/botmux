import { describe, expect, it } from 'vitest';
import { matchesSubstituteKeywords } from '../src/services/substitute-keywords.js';

describe('substitute keyword matching', () => {
  it('keeps mention-only behavior when keywords are undefined', () => {
    expect(matchesSubstituteKeywords(undefined, {})).toBe(true);
  });

  it('keeps mention-only behavior when keywords are an empty array', () => {
    expect(matchesSubstituteKeywords([], {})).toBe(true);
  });

  it('matches any literal substring, ignoring case', () => {
    expect(matchesSubstituteKeywords(['独立卡', 'ONCALL'], {
      content: JSON.stringify({ text: '帮忙看下 oncall 的问题' }),
    })).toBe(true);
    expect(matchesSubstituteKeywords(['a.b'], { content: JSON.stringify({ text: 'axb' }) })).toBe(false);
  });

  it('ignores mention keys and labels anywhere in text', () => {
    expect(matchesSubstituteKeywords(['oncall', '_user_1'], {
      content: JSON.stringify({ text: '请 @_user_1 下午开会' }),
      mentions: [{ key: '@_user_1' }],
    })).toBe(false);
    expect(matchesSubstituteKeywords(['oncall'], {
      content: JSON.stringify({ text: '<at user_id="ou_sub">Oncall</at> 下午开会' }),
    })).toBe(false);
  });

  it('does not join words across a removed mention', () => {
    expect(matchesSubstituteKeywords(['oncall'], {
      content: JSON.stringify({ text: 'on@_user_1call' }), mentions: [{ key: '@_user_1' }],
    })).toBe(false);
  });

  it.each(['zh_cn', 'en_us', 'ja_jp', 'de_de', 'flat'])('matches visible rich text and links in %s posts', locale => {
    const post = { content: [[{ tag: 'at', user_id: 'ou_sub', user_name: 'Oncall' },
      { tag: 'text', text: '独' }, { tag: 'text', text: '立卡', style: ['bold'] },
      { tag: 'a', text: 'incident', href: 'https://example.com/hidden-keyword' }]] };
    const content = JSON.stringify(locale === 'flat' ? post : { [locale]: post });
    expect(matchesSubstituteKeywords(['独立卡'], { content })).toBe(true);
    expect(matchesSubstituteKeywords(['INCIDENT'], { content })).toBe(true);
    expect(matchesSubstituteKeywords(['oncall', 'hidden-keyword'], { content })).toBe(false);
  });

  it('matches and rejects keywords inside a non-English-locale post', () => {
    // Regression guard: a self-rolled zh_cn/en_us-only parser silently dropped
    // ja_jp posts (and the dispatcher hard-silences a keyword miss).
    const content = JSON.stringify({ ja_jp: { content: [[{ tag: 'text', text: 'oncall お願いします' }]] } });
    expect(matchesSubstituteKeywords(['oncall'], { content })).toBe(true);
    expect(matchesSubstituteKeywords(['incident'], { content })).toBe(false);
  });

  it('does not search quoted content or bridge paragraphs', () => {
    const content = JSON.stringify({ content: [
      [{ tag: 'text', text: 'on' }], [{ tag: 'text', text: 'call' }],
      [{ tag: 'quote', text: 'incident' }],
    ], quote: { text: 'incident' } });
    expect(matchesSubstituteKeywords(['oncall', 'incident'], { content })).toBe(false);
  });

  it.each(['broken', '{}', 'null'])('fails closed for missing or malformed body: %s', content => {
    expect(matchesSubstituteKeywords(['incident'], { content })).toBe(false);
  });
});
