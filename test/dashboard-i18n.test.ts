import { describe, expect, it } from 'vitest';

import { createDashboardTranslator } from '../src/dashboard/web/i18n.js';

describe('dashboard i18n helpers', () => {
  it('renders English workflow labels with interpolation', () => {
    const t = createDashboardTranslator('en');
    expect(t('nav.workflowCatalog')).toBe('Catalog');
    expect(t('workflow.detail.approve')).toBe('Approve');
    expect(t('catalog.run')).toBe('Run');
    expect(t('workflow.list.loaded', { count: 2, time: '10:00:00' })).toBe('2 runs · refreshed 10:00:00');
  });

  it('renders Chinese workflow labels with interpolation', () => {
    const t = createDashboardTranslator('zh');
    expect(t('nav.workflowCatalog')).toBe('目录');
    expect(t('workflow.detail.approve')).toBe('通过');
    expect(t('catalog.run')).toBe('运行');
    expect(t('workflow.list.loaded', { count: 2, time: '10:00:00' })).toBe('2 个运行 · 刷新于 10:00:00');
  });

  it('renders RSS help as three structured lines in both locales', () => {
    const zh = createDashboardTranslator('zh')('monitoring.rssHelp').split('\n');
    const en = createDashboardTranslator('en')('monitoring.rssHelp').split('\n');

    expect(zh).toEqual([
      expect.stringContaining('Resident Set Size'),
      expect.stringContaining('重复计数'),
      expect.stringContaining('适合'),
    ]);
    expect(en).toEqual([
      expect.stringContaining('Resident Set Size'),
      expect.stringContaining('counted more than once'),
      expect.stringContaining('Best for'),
    ]);
  });

  it('renders runtime monitoring labels in both locales', () => {
    const keys = [
      'monitoring.runtimeTitle',
      'monitoring.runtimeSubtitle',
      'monitoring.runtimeHealth',
      'monitoring.runtimeHealthHint',
      'monitoring.resourcePressure',
      'monitoring.resourcePressureHint',
      'monitoring.sessionPressure',
      'monitoring.sessionPressureHint',
      'monitoring.botRuntime',
      'monitoring.botRuntimeHint',
      'monitoring.sampleHealth',
      'monitoring.sampleAge',
      'monitoring.sample.fresh',
      'monitoring.sample.stale',
      'monitoring.sample.unsupported',
      'monitoring.sample.unknown',
      'monitoring.daemonHealth',
      'monitoring.sessionHealth',
      'monitoring.offline',
      'monitoring.working',
      'monitoring.starting',
      'monitoring.waiting',
      'monitoring.idle',
      'monitoring.statusDistribution',
      'monitoring.longestRunning',
      'monitoring.longestWaiting',
      'monitoring.unattributedSessions',
      'monitoring.unattributedHint',
    ];

    const zh = createDashboardTranslator('zh');
    const en = createDashboardTranslator('en');
    for (const key of keys) {
      expect(zh(key), key).not.toBe(key);
      expect(en(key), key).not.toBe(key);
    }
    expect(en('monitoring.hostMemory')).toBe('Memory');
  });
});
