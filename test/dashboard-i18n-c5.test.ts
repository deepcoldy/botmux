/**
 * PR3 C5 i18n completeness — every key the /dashboard command group and the
 * settings card render at runtime MUST exist in both `zh.ts` and `en.ts`.
 * Missing locale falls back to "MISSING:<key>" which would silently leak.
 */

import { describe, expect, it } from 'vitest';

import { t } from '../src/i18n/index.js';

const REQUIRED_KEYS: string[] = [
  // ─── /dashboard command group (C1) ──────────────────────────────────
  'card.dashboard.owner_only',
  'card.dashboard.overview.not_implemented_yet',
  'card.dashboard.sessions.not_implemented_yet',
  'card.dashboard.workflows.not_implemented_yet',
  'card.dashboard.groups.not_implemented_yet',
  'card.dashboard.schedules.not_implemented_yet',
  'card.dashboard.settings.not_implemented_yet',  // still referenced if C4 dispatch ever falls back
  'card.dashboard.help.body',
  'card.dashboard.help.unknown_module',

  // ─── settings card (C4) ─────────────────────────────────────────────
  'card.dashboard.settings.title',
  'card.dashboard.settings.refresh',
  'card.dashboard.settings.save_time',
  'card.dashboard.settings.toggle.on',
  'card.dashboard.settings.toggle.off',
  'card.dashboard.settings.toggle.disabled',
  'card.dashboard.settings.saving',
  'card.dashboard.settings.refreshing',
  'card.dashboard.settings.not_invoker',
  'card.dashboard.settings.owner_only',
  'card.dashboard.settings.invalid_field',
  'card.dashboard.settings.invalid_value',
  'card.dashboard.settings.invalid_time',
  'card.dashboard.settings.invalid_action',
  'card.dashboard.settings.snapshot_failed',

  // ─── PR1 model DTO labelKey/hintKey/sectionTitle (consumed at card build) ─
  'settings.readOnlyVisitor',
  'settings.autoUpdateLocalDev',
  'settings.sectionAccess',
  'settings.sectionCards',
  'settings.sectionMaintenance',
  'settings.publicReadOnly',
  'settings.publicReadOnlyHelp',
  'settings.openTerminalInFeishu',
  'settings.openTerminalInFeishuHelp',
  'settings.autoUpdate',
  'settings.autoUpdateHelp',
  'settings.autoRestart',
  'settings.autoRestartHelp',
];

describe('PR3 i18n keys — zh', () => {
  it.each(REQUIRED_KEYS)('zh has %s', (key) => {
    const value = t(key, undefined, 'zh');
    expect(value, `zh.ts missing key ${key}`).toBeTruthy();
    expect(value.startsWith('MISSING:'), `zh.ts returns MISSING fallback for ${key}: ${value}`).toBe(false);
  });
});

describe('PR3 i18n keys — en', () => {
  it.each(REQUIRED_KEYS)('en has %s', (key) => {
    const value = t(key, undefined, 'en');
    expect(value, `en.ts missing key ${key}`).toBeTruthy();
    expect(value.startsWith('MISSING:'), `en.ts returns MISSING fallback for ${key}: ${value}`).toBe(false);
  });
});

describe('PR3 i18n placeholders', () => {
  it('snapshot_failed interpolates {reason}', () => {
    const zh = t('card.dashboard.settings.snapshot_failed', { reason: 'lark_5xx' }, 'zh');
    const en = t('card.dashboard.settings.snapshot_failed', { reason: 'lark_5xx' }, 'en');
    expect(zh).toContain('lark_5xx');
    expect(en).toContain('lark_5xx');
  });

  it('unknown_module interpolates {module}', () => {
    const zh = t('card.dashboard.help.unknown_module', { module: 'foo' }, 'zh');
    const en = t('card.dashboard.help.unknown_module', { module: 'foo' }, 'en');
    expect(zh).toContain('foo');
    expect(en).toContain('foo');
  });
});
