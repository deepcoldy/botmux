/**
 * PR3 C5 i18n completeness — every key the /dashboard command group and the
 * settings card render at runtime MUST exist in BOTH `zh.ts` and `en.ts`.
 *
 * We assert this by directly importing the message dictionaries and using
 * `Object.prototype.hasOwnProperty`, NOT via `t(key, locale)`. The reason
 * (codex C5 blocker): `src/i18n/index.ts:81-84` falls back to the zh
 * dictionary when an en key is missing, then to the bare key string — so
 * a `t()`-based check passes silently even when en is incomplete.
 */

import { describe, expect, it } from 'vitest';

import { t } from '../src/i18n/index.js';
import { messages as zhMessages } from '../src/i18n/zh.js';
import { messages as enMessages } from '../src/i18n/en.js';

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
  'card.dashboard.dm_sent',
  'card.dashboard.dm_failed',

  // ─── sessions card (PR3 slice 1) ────────────────────────────────────
  'card.dashboard.sessions.title',
  'card.dashboard.sessions.count_summary',
  'card.dashboard.sessions.empty',
  'card.dashboard.sessions.refresh',
  'card.dashboard.sessions.prev',
  'card.dashboard.sessions.next',
  'card.dashboard.sessions.dm_sent',
  'card.dashboard.sessions.dm_failed',
  'card.dashboard.sessions.list_failed',

  // ─── sessions card (PR3 slice 2a) — detail card + close action ──────
  'card.dashboard.sessions.row_detail',
  'card.dashboard.sessions.detail.title',
  'card.dashboard.sessions.detail.status_label',
  'card.dashboard.sessions.detail.cli_label',
  'card.dashboard.sessions.detail.workingdir_label',
  'card.dashboard.sessions.detail.chat_label',
  'card.dashboard.sessions.detail.last_message_label',
  'card.dashboard.sessions.btn.close',
  'card.dashboard.sessions.btn.back',
  'card.dashboard.sessions.confirm.close.title',
  'card.dashboard.sessions.confirm.close.text',
  'card.dashboard.sessions.close_failed',
  'card.dashboard.sessions.session_not_found',
  'card.dashboard.sessions.close.disabled.alreadyClosed',
  'card.dashboard.sessions.close.disabled.starting',

  // ─── schedules card (PR3 slice 1) ───────────────────────────────────
  'card.dashboard.schedules.title',
  'card.dashboard.schedules.count_summary',
  'card.dashboard.schedules.empty',
  'card.dashboard.schedules.refresh',
  'card.dashboard.schedules.prev',
  'card.dashboard.schedules.next',
  'card.dashboard.schedules.next_label',
  'card.dashboard.schedules.last_label',
  'card.dashboard.schedules.repeat_label',
  'card.dashboard.schedules.dm_sent',
  'card.dashboard.schedules.dm_failed',
  'card.dashboard.schedules.list_failed',

  // ─── workflows card (PR3 slice 1) ───────────────────────────────────
  'card.dashboard.workflows.title',
  'card.dashboard.workflows.count_summary',
  'card.dashboard.workflows.empty',
  'card.dashboard.workflows.refresh',
  'card.dashboard.workflows.prev',
  'card.dashboard.workflows.next',
  'card.dashboard.workflows.progress_label',
  'card.dashboard.workflows.started_label',
  'card.dashboard.workflows.updated_label',
  'card.dashboard.workflows.dm_sent',
  'card.dashboard.workflows.dm_failed',
  'card.dashboard.workflows.list_failed',

  // ─── groups card (PR3 slice 1) ──────────────────────────────────────
  'card.dashboard.groups.title',
  'card.dashboard.groups.count_summary',
  'card.dashboard.groups.empty',
  'card.dashboard.groups.refresh',
  'card.dashboard.groups.prev',
  'card.dashboard.groups.next',
  'card.dashboard.groups.coverage_label',
  'card.dashboard.groups.unnamed',
  'card.dashboard.groups.status.in',
  'card.dashboard.groups.status.out',
  'card.dashboard.groups.status.unknown',
  'card.dashboard.groups.status.error',
  'card.dashboard.groups.dm_sent',
  'card.dashboard.groups.dm_failed',
  'card.dashboard.groups.list_failed',

  // ─── overview card (PR3 slice 1) ────────────────────────────────────
  'card.dashboard.overview.title',
  'card.dashboard.overview.sessions_section',
  'card.dashboard.overview.sessions_summary',
  'card.dashboard.overview.schedules_section',
  'card.dashboard.overview.schedules_summary',
  'card.dashboard.overview.settings_section',
  'card.dashboard.overview.settings_summary',
  'card.dashboard.overview.groups_placeholder',
  'card.dashboard.overview.workflows_placeholder',
  'card.dashboard.overview.refresh',
  'card.dashboard.overview.goto_sessions',
  'card.dashboard.overview.goto_schedules',
  'card.dashboard.overview.goto_settings',
  'card.dashboard.overview.dm_sent',
  'card.dashboard.overview.dm_failed',
  'card.dashboard.overview.overview_failed',
  'card.dashboard.overview.settings.publicReadOnly.on',
  'card.dashboard.overview.settings.publicReadOnly.off',
  'card.dashboard.overview.settings.openTerminal.feishu',
  'card.dashboard.overview.settings.openTerminal.browser',
  'card.dashboard.overview.settings.autoUpdate.localDev',
  'card.dashboard.overview.settings.autoUpdate.off',
  'card.dashboard.overview.settings.autoUpdate.on',
  'card.dashboard.overview.settings.autoUpdate.onWithRestart',

  // ─── settings card (C4) ─────────────────────────────────────────────
  'card.dashboard.settings.title',
  'card.dashboard.settings.refresh',
  'card.dashboard.settings.save_time',
  'card.dashboard.settings.toggle.on',
  'card.dashboard.settings.toggle.off',
  'card.dashboard.settings.toggle.disabled',
  'card.dashboard.settings.saving',
  'card.dashboard.settings.refreshing',
  'card.dashboard.settings.saved',
  'card.dashboard.settings.refreshed',
  'card.dashboard.settings.save_failed',
  'card.dashboard.settings.not_invoker',
  'card.dashboard.settings.owner_only',
  'card.dashboard.settings.invalid_field',
  'card.dashboard.settings.invalid_value',
  'card.dashboard.settings.invalid_time',
  'card.dashboard.settings.invalid_action',
  'card.dashboard.settings.snapshot_failed',
  'card.dashboard.settings.dm_sent',
  'card.dashboard.settings.dm_failed',

  // ─── PR3 UI revision (segmented control + header/footer) ───────────
  'card.dashboard.settings.segment.on',
  'card.dashboard.settings.segment.off',
  'card.dashboard.settings.segment.on_current',
  'card.dashboard.settings.segment.off_current',
  'card.dashboard.settings.maintenance.time_display',
  'card.dashboard.settings.footer.security',
  'settings.autoUpdate.disabled.localDev',
  'settings.autoRestart.disabled.needsAutoUpdate',

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

describe('PR3 i18n keys — zh dictionary directly', () => {
  it.each(REQUIRED_KEYS)('zh.ts has own property %s with truthy value', (key) => {
    expect(
      Object.prototype.hasOwnProperty.call(zhMessages, key),
      `zh.ts missing key ${key}`,
    ).toBe(true);
    expect(zhMessages[key], `zh.ts has empty value for ${key}`).toBeTruthy();
  });
});

describe('PR3 i18n keys — en dictionary directly', () => {
  it.each(REQUIRED_KEYS)('en.ts has own property %s with truthy value', (key) => {
    expect(
      Object.prototype.hasOwnProperty.call(enMessages, key),
      `en.ts missing key ${key}`,
    ).toBe(true);
    expect(enMessages[key], `en.ts has empty value for ${key}`).toBeTruthy();
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
