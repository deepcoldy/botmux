import { describe, expect, it } from 'vitest';

import { getLang, setLang, t } from '../src/dashboard/web/i18n.js';

describe('dashboard i18n helpers', () => {
  it('renders English workflow labels with interpolation', () => {
    setLang('en');
    expect(getLang()).toBe('en');
    expect(t('nav.workflowCatalog')).toBe('Catalog');
    expect(t('workflow.detail.approve')).toBe('Approve');
    expect(t('catalog.run')).toBe('Run');
    expect(t('workflow.list.loaded', { count: 2, time: '10:00:00' })).toBe('2 runs · refreshed 10:00:00');
  });

  it('renders Chinese workflow labels with interpolation', () => {
    setLang('zh');
    expect(getLang()).toBe('zh');
    expect(t('nav.workflowCatalog')).toBe('目录');
    expect(t('workflow.detail.approve')).toBe('通过');
    expect(t('catalog.run')).toBe('运行');
    expect(t('workflow.list.loaded', { count: 2, time: '10:00:00' })).toBe('2 个运行 · 刷新于 10:00:00');
  });
});
