import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  descriptionPreview,
  descriptionsFromSnapshot,
  localeLabel,
  mergeDescriptionDrafts,
  orderedDescriptionDrafts,
  truncateDescription,
} from '../src/dashboard/web/bot-description.js';

const page = readFileSync(new URL('../src/dashboard/web/bot-defaults-page.tsx', import.meta.url), 'utf8');
const css = readFileSync(new URL('../src/dashboard/web/style.css', import.meta.url), 'utf8');
const i18n = readFileSync(new URL('../src/dashboard/web/i18n.ts', import.meta.url), 'utf8');

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

describe('dashboard bot description editor wiring', () => {
  it('loads descriptions on mount and opens the editor without a duplicate read', () => {
    expect(page).toContain(`useEffect(() => {
    void loadDescriptions();
  }, [loadDescriptions]);`);

    const openEditor = page.match(/const openEditor = useCallback\(\(\) => \{[\s\S]*?\n  \}, \[[^\]]*\]\);/)?.[0] ?? '';
    expect(openEditor).toContain('setOpen(true);');
    expect(openEditor).not.toContain('loadDescriptions');
  });

  it('wires the profile editor to the description API and draft helpers', () => {
    expect(page).toContain('function BotDescriptionControl');
    expect(page).toContain('data-action="edit-bot-description"');
    expect(page).toContain('/description`');
    expect(page).toContain('mergeDescriptionDrafts');
    expect(page).toContain('data-description-lang={row.lang}');
    expect(page).toContain('BOT_DESCRIPTION_MAX_CHARS');
    expect(page).toContain('truncateDescription(event.currentTarget.value)');
    expect(page).toContain('<BotDescriptionControl bot={bot} />');
  });

  it('captures textarea input before the React state updater runs', () => {
    expect(page).not.toContain('[row.lang]: truncateDescription(event.currentTarget.value)');
    expect(page).toContain('const nextValue = truncateDescription(event.currentTarget.value);');
    expect(page).toContain('[row.lang]: nextValue');
  });

  it('adds bounded profile-preview and editor-modal styles', () => {
    expect(css).toContain('.bot-defaults-page .bd-description-preview');
    expect(css).toContain('.bot-defaults-page .bd-description-modal');
    expect(css).toContain('.bot-defaults-page .bd-description-list');
    expect(css).toContain('.bot-defaults-page .bd-description-row');
  });

  it('ships Chinese and English copy for the description editor', () => {
    for (const key of [
      'descriptionTitle',
      'descriptionEdit',
      'descriptionSave',
      'descriptionPublishing',
      'descriptionPublished',
      'descriptionLanguagesChanged',
      'descriptionLoginReloaded',
    ]) {
      expect(i18n.match(new RegExp(`'botDefaults\\.${key}'`, 'g'))).toHaveLength(2);
    }
  });

  it('keeps shared Feishu login copy generic across profile and callback flows', () => {
    expect(i18n).toContain('用飞书 App 扫码并确认登录（登录态仅存本机');
    expect(i18n).toContain('Scan with the Feishu app and confirm to log in');
    expect(i18n).toContain('✓ Logged in — continuing…');
    expect(i18n).not.toContain('profile changes');
    expect(i18n).not.toContain('retrying the rename');
    expect(i18n).not.toContain('授权改名');
  });
});
