/**
 * Settings card model (PR1) — pure projection of DashboardSettings + viewer
 * capability into a 3-section card DTO (access / cards / maintenance).
 *
 * Zero IO. Type-only imports. The input shape mirrors
 * `src/dashboard/web/settings-page.tsx` but is redeclared locally so the model
 * does not pull in browser-side jsdom assets.
 */

import type { ButtonState } from './card-model-types.js';

/** Single maintenance task: enabled flag + optional HH:MM time. */
export interface MaintenanceTaskCfgInput {
  enabled?: boolean;
  time?: string;
}

/** Maintenance section input — auto-update drives the schedule, auto-restart is dependent. */
export interface MaintenanceCfgInput {
  autoUpdate?: MaintenanceTaskCfgInput;
  autoRestart?: MaintenanceTaskCfgInput;
}

/** Raw dashboard settings as persisted in ~/.botmux/config.json's `dashboard` + `maintenance` segments. */
export interface DashboardSettingsInput {
  publicReadOnly: boolean;
  openTerminalInFeishu: boolean;
  maintenance: MaintenanceCfgInput;
  localDevInstall: boolean;
}

/** Optional viewer context — `canWrite=false` greys every toggle and surfaces a top-level hint. */
export interface ComposeOptions {
  /** True when the viewer has write capability (`/api/settings` PUT allowed). Defaults to true. */
  canWrite?: boolean;
}

export type SettingsSectionKey = 'access' | 'cards' | 'maintenance';

export type SettingsToggleKey =
  | 'publicReadOnly'
  | 'openTerminalInFeishu'
  | 'autoUpdate'
  | 'autoRestart';

/** A single toggle row inside a settings section. */
export interface SettingsToggleDTO {
  key: SettingsToggleKey;
  /** i18n label key — renderer translates via t(). */
  labelKey: string;
  /** i18n hint/help key — renderer translates via t(). */
  hintKey: string;
  /** Current on/off state. */
  enabled: boolean;
  /** UI disabled / enabled state (greyed when disabled). */
  state: ButtonState;
  /** Sub-control: HH:MM time field. Only `autoUpdate` emits this. */
  time?: { value: string; state: ButtonState };
}

/** A vertical section in the settings card — fixed order: access → cards → maintenance. */
export interface SettingsSectionDTO {
  key: SettingsSectionKey;
  titleKey: string;
  toggles: SettingsToggleDTO[];
  /** Optional banner shown below toggles (e.g. localDev warning under maintenance). */
  hintKey?: string;
}

/** The full settings card DTO. */
export interface SettingsCardDTO {
  sections: SettingsSectionDTO[];
  /** Top-level read-only banner, set when `canWrite=false`. */
  readOnlyHintKey?: string;
}

/** Auto-update is unavailable when running from a local-dev install (cannot self-update). */
export function shouldDisableAutoUpdate(settings: DashboardSettingsInput): boolean {
  return settings.localDevInstall === true;
}

/** Auto-restart depends on auto-update being explicitly enabled. */
export function shouldDisableAutoRestart(settings: DashboardSettingsInput): boolean {
  return settings.maintenance?.autoUpdate?.enabled !== true;
}

/** Coerce a maintenance time value into a valid HH:MM string; falls back to '04:00'. */
export function formatTimeForDisplay(time: string | undefined | null): string {
  if (typeof time !== 'string') return '04:00';
  const trimmed = time.trim();
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(trimmed)) return '04:00';
  return trimmed;
}

/** Build the full 3-section settings card DTO from raw settings + viewer caps. */
export function composeSections(
  settings: DashboardSettingsInput,
  opts?: ComposeOptions,
): SettingsCardDTO {
  const canWrite = opts?.canWrite !== false;
  const autoUpdateBlocked = shouldDisableAutoUpdate(settings);
  const autoRestartBlocked = shouldDisableAutoRestart(settings);

  const accessSection: SettingsSectionDTO = {
    key: 'access',
    titleKey: 'settings.sectionAccess',
    toggles: [
      {
        key: 'publicReadOnly',
        labelKey: 'settings.publicReadOnly',
        hintKey: 'settings.publicReadOnlyHelp',
        enabled: settings.publicReadOnly === true,
        state: { enabled: canWrite },
      },
    ],
  };

  const cardsSection: SettingsSectionDTO = {
    key: 'cards',
    titleKey: 'settings.sectionCards',
    toggles: [
      {
        key: 'openTerminalInFeishu',
        labelKey: 'settings.openTerminalInFeishu',
        hintKey: 'settings.openTerminalInFeishuHelp',
        enabled: settings.openTerminalInFeishu === true,
        state: { enabled: canWrite },
      },
    ],
  };

  const autoUpdateEnabledUi = canWrite && !autoUpdateBlocked;
  const autoRestartEnabledUi = canWrite && !autoRestartBlocked;
  const timeValue = formatTimeForDisplay(settings.maintenance?.autoUpdate?.time);

  // Per-toggle disabled reasons stay specific so the card can tell users what
  // dependency must change before a control becomes writable.
  const autoUpdateReasonKey = autoUpdateBlocked ? 'settings.autoUpdate.disabled.localDev' : undefined;
  const autoRestartReasonKey = autoRestartBlocked ? 'settings.autoRestart.disabled.needsAutoUpdate' : undefined;

  const maintenanceSection: SettingsSectionDTO = {
    key: 'maintenance',
    titleKey: 'settings.sectionMaintenance',
    toggles: [
      {
        key: 'autoUpdate',
        labelKey: 'settings.autoUpdate',
        hintKey: 'settings.autoUpdateHelp',
        enabled: settings.maintenance?.autoUpdate?.enabled === true,
        state: { enabled: autoUpdateEnabledUi, reasonKey: autoUpdateReasonKey },
        time: {
          value: timeValue,
          state: { enabled: autoUpdateEnabledUi, reasonKey: autoUpdateReasonKey },
        },
      },
      {
        key: 'autoRestart',
        labelKey: 'settings.autoRestart',
        hintKey: 'settings.autoRestartHelp',
        enabled: settings.maintenance?.autoRestart?.enabled === true,
        state: { enabled: autoRestartEnabledUi, reasonKey: autoRestartReasonKey },
      },
    ],
    hintKey: autoUpdateBlocked ? 'settings.autoUpdateLocalDev' : undefined,
  };

  return {
    sections: [accessSection, cardsSection, maintenanceSection],
    readOnlyHintKey: canWrite ? undefined : 'settings.readOnlyVisitor',
  };
}
