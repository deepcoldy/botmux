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
  'card.dashboard.sessions.jump_page',
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
  // ─── sessions card (PR3 slice 2b) — locate / terminal / resume ──────
  'card.dashboard.sessions.btn.locate',
  'card.dashboard.sessions.btn.terminal',
  'card.dashboard.sessions.btn.resume',
  'card.dashboard.sessions.locate.success',
  'card.dashboard.sessions.locate_failed',
  'card.dashboard.sessions.resume_failed',
  'card.dashboard.sessions.confirm.resume.title',
  'card.dashboard.sessions.confirm.resume.text',
  'card.dashboard.sessions.terminal.disabled.noPort',
  'card.dashboard.sessions.resume.disabled.onlyClosed',

  // ─── schedules card (PR3 slice 1) ───────────────────────────────────
  'card.dashboard.schedules.title',
  'card.dashboard.schedules.count_summary',
  'card.dashboard.schedules.empty',
  'card.dashboard.schedules.refresh',
  'card.dashboard.schedules.prev',
  'card.dashboard.schedules.next',
  'card.dashboard.schedules.jump_page',
  'card.dashboard.schedules.bot_label',
  'card.dashboard.schedules.next_label',
  'card.dashboard.schedules.last_label',
  'card.dashboard.schedules.repeat_label',
  'card.dashboard.schedules.dm_sent',
  'card.dashboard.schedules.dm_failed',
  'card.dashboard.schedules.list_failed',

  // ─── schedules card (PR3 slice 2a) — detail card + pause/resume ─────
  'card.dashboard.schedules.row_detail',
  'card.dashboard.schedules.detail.title',
  'card.dashboard.schedules.detail.name_label',
  'card.dashboard.schedules.detail.enabled_label',
  'card.dashboard.schedules.detail.kind_label',
  'card.dashboard.schedules.detail.display_label',
  'card.dashboard.schedules.detail.delivery_label',
  'card.dashboard.schedules.detail.owner_label',
  'card.dashboard.schedules.detail.next_label',
  'card.dashboard.schedules.detail.last_label',
  'card.dashboard.schedules.detail.status_label',
  'card.dashboard.schedules.detail.repeat_label',
  'card.dashboard.schedules.detail.prompt_label',
  'card.dashboard.schedules.detail.next_runs_header',
  'card.dashboard.schedules.detail.enabled.active',
  'card.dashboard.schedules.detail.enabled.paused',
  'card.dashboard.schedules.btn.pause',
  'card.dashboard.schedules.btn.resume',
  'card.dashboard.schedules.btn.use_new_topic',
  'card.dashboard.schedules.btn.use_origin',
  'card.dashboard.schedules.btn.back',
  'card.dashboard.schedules.delivery.origin',
  'card.dashboard.schedules.delivery.new_topic',
  'card.dashboard.schedules.delivery.local',
  'card.dashboard.schedules.pause.disabled.alreadyPaused',
  'card.dashboard.schedules.resume.disabled.alreadyEnabled',
  'card.dashboard.schedules.delivery.disabled.local',
  'card.dashboard.schedules.delivery.disabled.alreadyOrigin',
  'card.dashboard.schedules.delivery.disabled.alreadyNewTopic',
  'card.dashboard.schedules.pause_failed',
  'card.dashboard.schedules.resume_failed',
  'card.dashboard.schedules.delivery_failed',
  'card.dashboard.schedules.schedule_not_found',

  // ─── workflows card (PR3 slice 1) ───────────────────────────────────
  'card.dashboard.workflows.title',
  'card.dashboard.workflows.count_summary',
  'card.dashboard.workflows.empty',
  'card.dashboard.workflows.refresh',
  'card.dashboard.workflows.prev',
  'card.dashboard.workflows.next',
  'card.dashboard.workflows.jump_page',
  'card.dashboard.workflows.progress_label',
  'card.dashboard.workflows.started_label',
  'card.dashboard.workflows.updated_label',
  'card.dashboard.workflows.dm_sent',
  'card.dashboard.workflows.dm_failed',
  'card.dashboard.workflows.list_failed',

  // ─── workflows card (PR3 slice 2a) — detail card + cancel action ────
  'card.dashboard.workflows.row_detail',
  'card.dashboard.workflows.detail.title',
  'card.dashboard.workflows.detail.workflow_label',
  'card.dashboard.workflows.detail.run_label',
  'card.dashboard.workflows.detail.status_label',
  'card.dashboard.workflows.detail.started_label',
  'card.dashboard.workflows.detail.updated_label',
  'card.dashboard.workflows.detail.finished_label',
  'card.dashboard.workflows.detail.elapsed_label',
  'card.dashboard.workflows.detail.progress_label',
  'card.dashboard.workflows.detail.chat_label',
  'card.dashboard.workflows.detail.nodes_header',
  'card.dashboard.workflows.btn.cancel',
  'card.dashboard.workflows.btn.back',
  'card.dashboard.workflows.confirm.cancel.title',
  'card.dashboard.workflows.confirm.cancel.text',
  'card.dashboard.workflows.cancel.disabled.alreadyTerminal',
  'card.dashboard.workflows.cancel.disabled.noOwner',
  'card.dashboard.workflows.cancel_failed',
  'card.dashboard.workflows.workflow_not_found',

  // ─── groups card (PR3 slice 1) ──────────────────────────────────────
  'card.dashboard.groups.title',
  'card.dashboard.groups.count_summary',
  'card.dashboard.groups.empty',
  'card.dashboard.groups.refresh',
  'card.dashboard.groups.prev',
  'card.dashboard.groups.next',
  'card.dashboard.groups.jump_page',
  'card.dashboard.groups.coverage_label',
  'card.dashboard.groups.joined_ratio',
  'card.dashboard.groups.unnamed',
  'card.dashboard.groups.status.in',
  'card.dashboard.groups.status.out',
  'card.dashboard.groups.status.unknown',
  'card.dashboard.groups.status.error',
  'card.dashboard.groups.dm_sent',
  'card.dashboard.groups.dm_failed',
  'card.dashboard.groups.list_failed',
  'card.dashboard.groups.row_manage',
  'card.dashboard.groups.detail.title',
  'card.dashboard.groups.role.title',
  'card.dashboard.groups.role_configured',
  'card.dashboard.groups.role_empty',
  'card.dashboard.groups.current_role',
  'card.dashboard.groups.current_role_empty',
  'card.dashboard.groups.edit_role',
  'card.dashboard.groups.role_placeholder',
  'card.dashboard.groups.oncall_enabled',
  'card.dashboard.groups.oncall_disabled',
  'card.dashboard.groups.owner_bot',
  'card.dashboard.groups.working_dir_placeholder',
  'card.dashboard.groups.btn.add_bot',
  'card.dashboard.groups.btn.leave_bot',
  'card.dashboard.groups.btn.oncall_bind',
  'card.dashboard.groups.btn.oncall_unbind',
  'card.dashboard.groups.btn.role',
  'card.dashboard.groups.btn.role_save',
  'card.dashboard.groups.btn.role_delete',
  'card.dashboard.groups.btn.back',
  'card.dashboard.groups.confirm.leave.title',
  'card.dashboard.groups.confirm.leave.text',
  'card.dashboard.groups.chat_not_found',
  'card.dashboard.groups.bot_not_found',
  'card.dashboard.groups.action_failed',
  'card.dashboard.groups.action_not_allowed',
  'card.dashboard.groups.working_dir_required',
  'card.dashboard.groups.role_required',

  // ─── overview card (PR3 slice 1) ────────────────────────────────────
  'card.dashboard.overview.title',
  'card.dashboard.overview.sessions_section',
  'card.dashboard.overview.sessions_summary',
  'card.dashboard.overview.schedules_section',
  'card.dashboard.overview.schedules_summary',
  'card.dashboard.overview.settings_section',
  'card.dashboard.overview.settings_summary',
  'card.dashboard.overview.groups_section',
  'card.dashboard.overview.workflows_section',
  'card.dashboard.overview.refresh',
  'card.dashboard.overview.goto_sessions',
  'card.dashboard.overview.goto_schedules',
  'card.dashboard.overview.goto_settings',
  'card.dashboard.overview.goto_groups',
  'card.dashboard.overview.goto_workflows',
  'card.dashboard.overview.back_button',
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

describe('PR3 dashboard i18n key symmetry', () => {
  it('card.dashboard.* key sets are symmetric between zh and en', () => {
    const dashboardKeys = (messages: Record<string, string>): string[] =>
      Object.keys(messages).filter(key => key.startsWith('card.dashboard.')).sort();
    expect(dashboardKeys(zhMessages).filter(key => !dashboardKeys(enMessages).includes(key))).toEqual([]);
    expect(dashboardKeys(enMessages).filter(key => !dashboardKeys(zhMessages).includes(key))).toEqual([]);
  });
});

describe('PR3 zh dashboard copy sanity', () => {
  it('overview workflow entry uses Chinese module labels', () => {
    expect(zhMessages['card.dashboard.overview.workflows_section']).toBe('🌀 工作流');
    expect(zhMessages['card.dashboard.overview.goto_workflows']).toBe('📂 工作流');
  });

  it('zh dashboard dictionary does not expose English module names in UI labels', () => {
    const allowedEnglish = [
      // Product / permission terms kept as-is in the Chinese UI.
      'Dashboard',
      'CLI',
      'Web',
      'ACK',
      'Oncall',
      'Role',
      'HH:MM',
      // Command syntax marker users may type; command words are stripped
      // only when they appear in explicit `/dashboard ...` snippets below.
      '/dashboard',
      'beta',
    ];
    const allowedPlaceholders = new Set([
      'active',
      'autoUpdateLabel',
      'bot',
      'chat',
      'closed',
      'dir',
      'done',
      'enabled',
      'errors',
      'expr',
      'failed',
      'idle',
      'joined',
      'kind',
      'module',
      'name',
      'n',
      'openTerminalLabel',
      'page',
      'paused',
      'prompt',
      'publicReadOnlyLabel',
      'reason',
      'rel',
      'repeat',
      'running',
      'scheduleId',
      'status',
      'time',
      'title',
      'total',
      'totalPages',
      'workflowId',
      'workingDir',
      'runId',
    ]);
    const forbiddenWords = new Set([
      'Workflows',
      'Workflow',
      'Sessions',
      'Session',
      'Schedules',
      'Schedule',
      'Groups',
      'Group',
      'Settings',
      'settings',
      'workingDir',
      'chatBinding',
    ]);
    const commandWords = [
      'overview',
      'sessions',
      'schedules',
      'settings',
      'groups',
      'workflows',
      'help',
    ];

    for (const [key, value] of Object.entries(zhMessages)) {
      if (!key.startsWith('card.dashboard.')) continue;
      let scrubbed = value;
      scrubbed = scrubbed.replace(/`\/dashboard(?:\s+[a-z]+)?`/g, '');
      for (const word of commandWords) {
        scrubbed = scrubbed.replaceAll(`\`${word}\``, '');
      }
      for (const word of allowedEnglish) {
        scrubbed = scrubbed.replaceAll(word, '');
      }
      scrubbed = scrubbed.replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, (match, name) => (
        allowedPlaceholders.has(name) ? '' : match
      ));
      for (const word of forbiddenWords) {
        expect(scrubbed, `${key} should not expose ${word} in zh copy: ${value}`).not.toContain(word);
      }
    }
  });
});
