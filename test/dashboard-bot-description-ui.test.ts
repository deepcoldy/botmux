import { describe, expect, it } from 'vitest';
import {
  descriptionPreview,
  descriptionsFromSnapshot,
  localeLabel,
  mergeDescriptionDrafts,
  orderedDescriptionDrafts,
  truncateDescription,
} from '../src/dashboard/web/bot-description.js';

const loaded = {
  primaryLang: 'zh_cn',
  languages: [
    { lang: 'zh_cn', description: '中文' },
    { lang: 'en_us', description: 'English' },
  ],
};

describe('dashboard bot description helpers', () => {
  it('orders primary first and returns its preview', () => {
    expect(orderedDescriptionDrafts(loaded).map(row => row.lang)).toEqual(['zh_cn', 'en_us']);
    expect(descriptionPreview(loaded)).toBe('中文');
  });

  it('sorts non-primary locales by locale code after the primary language', () => {
    expect(orderedDescriptionDrafts({
      primaryLang: 'en_us',
      languages: [
        { lang: 'zh_cn', description: '中文' },
        { lang: 'ja_jp', description: '日本語' },
        { lang: 'en_us', description: 'English' },
      ],
    }).map(row => row.lang)).toEqual(['en_us', 'ja_jp', 'zh_cn']);
  });

  it('creates editable drafts from a loaded snapshot', () => {
    expect(descriptionsFromSnapshot(loaded)).toEqual({
      zh_cn: '中文',
      en_us: 'English',
    });
  });

  it('reapplies drafts only when the language set is unchanged', () => {
    expect(mergeDescriptionDrafts(loaded, { zh_cn: '草稿', en_us: 'Draft' })).toEqual({
      ok: true,
      descriptions: { zh_cn: '草稿', en_us: 'Draft' },
    });
    expect(mergeDescriptionDrafts(
      { primaryLang: 'zh_cn', languages: [{ lang: 'zh_cn', description: '中文' }] },
      { zh_cn: '草稿', en_us: 'Draft' },
    )).toEqual({ ok: false, reason: 'languages_changed', descriptions: { zh_cn: '中文' } });
  });

  it('truncates by Unicode code point rather than UTF-16 code unit', () => {
    expect(truncateDescription('🙂'.repeat(121))).toBe('🙂'.repeat(120));
  });

  it('uses friendly locale labels with locale-code fallback', () => {
    expect(localeLabel('zh_cn')).toBe('简体中文');
    expect(localeLabel('en_us')).toBe('English');
    expect(localeLabel('xx_yy')).toBe('xx_yy');
  });

  it('returns an empty preview before descriptions are loaded', () => {
    expect(descriptionPreview(null)).toBe('');
  });
});
