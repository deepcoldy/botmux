import { describe, expect, it } from 'vitest';

import {
  composeSections,
  formatTimeForDisplay,
  shouldDisableAutoRestart,
  shouldDisableAutoUpdate,
  type ComposeOptions,
  type DashboardSettingsInput,
} from '../src/dashboard/settings-card-model.js';

function makeSettings(overrides: Partial<DashboardSettingsInput> = {}): DashboardSettingsInput {
  return {
    publicReadOnly: false,
    openTerminalInFeishu: false,
    maintenance: {},
    localDevInstall: false,
    ...overrides,
  };
}

describe('settings-card-model · composeSections', () => {
  it('emits exactly three sections in order (access → cards → maintenance) with the right toggle keys', () => {
    const dto = composeSections(makeSettings());
    expect(dto.sections.map(s => s.key)).toEqual(['access', 'cards', 'maintenance']);
    expect(dto.sections[0].toggles.map(t => t.key)).toEqual(['publicReadOnly']);
    expect(dto.sections[1].toggles.map(t => t.key)).toEqual(['openTerminalInFeishu']);
    expect(dto.sections[2].toggles.map(t => t.key)).toEqual(['autoUpdate', 'autoRestart']);
  });

  it('marks every toggle disabled when canWrite=false and surfaces readOnlyHintKey', () => {
    const dto = composeSections(makeSettings({ publicReadOnly: true }), { canWrite: false });
    const allToggleStates = dto.sections.flatMap(s => s.toggles.map(t => t.state.enabled));
    expect(allToggleStates.every(enabled => enabled === false)).toBe(true);
    expect(dto.readOnlyHintKey).toBe('settings.readOnlyVisitor');
    const autoUpdate = dto.sections[2].toggles[0];
    expect(autoUpdate.time?.state.enabled).toBe(false);
  });

  it('grays out autoUpdate toggle + its time input when localDevInstall=true and sets per-toggle reasonKey (localDev-specific)', () => {
    const dto = composeSections(makeSettings({ localDevInstall: true }));
    const maintenance = dto.sections[2];
    const autoUpdate = maintenance.toggles[0];
    expect(autoUpdate.state.enabled).toBe(false);
    expect(autoUpdate.time?.state.enabled).toBe(false);
    // Section hint stays for backwards compat
    expect(maintenance.hintKey).toBe('settings.autoUpdateLocalDev');
    // PR3 UI revision: per-toggle reasonKey MUST cite local-dev specifically
    expect(autoUpdate.state.reasonKey).toBe('settings.autoUpdate.disabled.localDev');
    expect(autoUpdate.time?.state.reasonKey).toBe('settings.autoUpdate.disabled.localDev');
  });

  it('grays out autoUpdate for an unsupported global install with a specific reason', () => {
    const dto = composeSections(makeSettings({ autoUpdateSupported: false }));
    const maintenance = dto.sections[2];
    const autoUpdate = maintenance.toggles[0];
    expect(autoUpdate.state.enabled).toBe(false);
    expect(autoUpdate.time?.state.enabled).toBe(false);
    expect(maintenance.hintKey).toBe('settings.autoUpdateUnsupportedInstall');
    expect(autoUpdate.state.reasonKey).toBe('settings.autoUpdate.disabled.unsupportedInstall');
  });

  it('grays out autoRestart whenever autoUpdate.enabled !== true (covers undefined, false, and true), with autoUpdate-dependency reason', () => {
    const cases: Array<{ enabled?: boolean; expectAutoRestartEnabled: boolean; expectReason: string | undefined }> = [
      { enabled: undefined, expectAutoRestartEnabled: false, expectReason: 'settings.autoRestart.disabled.needsAutoUpdate' },
      { enabled: false, expectAutoRestartEnabled: false, expectReason: 'settings.autoRestart.disabled.needsAutoUpdate' },
      { enabled: true, expectAutoRestartEnabled: true, expectReason: undefined },
    ];
    for (const c of cases) {
      const maintenance = c.enabled === undefined
        ? {}
        : { autoUpdate: { enabled: c.enabled } };
      const dto = composeSections(makeSettings({ maintenance }));
      const autoRestart = dto.sections[2].toggles[1];
      expect(autoRestart.state.enabled).toBe(c.expectAutoRestartEnabled);
      // PR3 UI revision: when disabled, the reason MUST cite the autoUpdate
      // dependency (not the generic "currently disabled").
      expect(autoRestart.state.reasonKey).toBe(c.expectReason);
    }
  });

  it("preserves valid maintenance.autoUpdate.time and falls back to '04:00' when missing", () => {
    const valid = composeSections(makeSettings({ maintenance: { autoUpdate: { enabled: true, time: '02:30' } } }));
    expect(valid.sections[2].toggles[0].time?.value).toBe('02:30');

    const missing = composeSections(makeSettings({ maintenance: { autoUpdate: { enabled: true } } }));
    expect(missing.sections[2].toggles[0].time?.value).toBe('04:00');
  });
});

describe('settings-card-model · helpers', () => {
  it('shouldDisableAutoRestart returns true for missing/false autoUpdate, false only for explicit true', () => {
    expect(shouldDisableAutoRestart(makeSettings())).toBe(true);
    expect(shouldDisableAutoRestart(makeSettings({ maintenance: { autoUpdate: { enabled: false } } }))).toBe(true);
    expect(shouldDisableAutoRestart(makeSettings({ maintenance: { autoUpdate: { enabled: true } } }))).toBe(false);
  });

  it('shouldDisableAutoUpdate covers local-dev and unsupported global installs', () => {
    expect(shouldDisableAutoUpdate(makeSettings({ localDevInstall: true }))).toBe(true);
    expect(shouldDisableAutoUpdate(makeSettings({ localDevInstall: false }))).toBe(false);
    expect(shouldDisableAutoUpdate(makeSettings({ autoUpdateSupported: false }))).toBe(true);
    expect(shouldDisableAutoUpdate(makeSettings({
      localDevInstall: true,
      publicReadOnly: true,
      maintenance: { autoUpdate: { enabled: true } },
    }))).toBe(true);
  });

  it("formatTimeForDisplay returns valid HH:MM unchanged and substitutes '04:00' for undefined / empty / invalid", () => {
    expect(formatTimeForDisplay('02:30')).toBe('02:30');
    expect(formatTimeForDisplay('00:00')).toBe('00:00');
    expect(formatTimeForDisplay('23:59')).toBe('23:59');

    expect(formatTimeForDisplay(undefined)).toBe('04:00');
    expect(formatTimeForDisplay('')).toBe('04:00');
    expect(formatTimeForDisplay('  ')).toBe('04:00');
    expect(formatTimeForDisplay('24:00')).toBe('04:00');
    expect(formatTimeForDisplay('12:60')).toBe('04:00');
    expect(formatTimeForDisplay('not-a-time')).toBe('04:00');
    expect(formatTimeForDisplay(null as unknown as undefined)).toBe('04:00');
  });
});

describe('settings-card-model · invariants', () => {
  it('does not mutate the input settings object (immutability)', () => {
    const original = makeSettings({
      publicReadOnly: true,
      maintenance: { autoUpdate: { enabled: true, time: '03:00' }, autoRestart: { enabled: true } },
    });
    const snapshot = JSON.parse(JSON.stringify(original));
    composeSections(Object.freeze({
      ...original,
      maintenance: Object.freeze({ ...original.maintenance }) as DashboardSettingsInput['maintenance'],
    }) as DashboardSettingsInput);
    expect(original).toEqual(snapshot);
  });

  it('returns a structurally valid DTO for an empty/default settings input', () => {
    const dto = composeSections(makeSettings());
    expect(dto.sections).toHaveLength(3);
    expect(dto.readOnlyHintKey).toBeUndefined();
    for (const section of dto.sections) {
      expect(typeof section.titleKey).toBe('string');
      expect(Array.isArray(section.toggles)).toBe(true);
      for (const toggle of section.toggles) {
        expect(typeof toggle.labelKey).toBe('string');
        expect(typeof toggle.hintKey).toBe('string');
        expect(typeof toggle.enabled).toBe('boolean');
        expect(typeof toggle.state.enabled).toBe('boolean');
      }
    }
  });

  it('DTO is JSON-serialisable: stringify+parse round-trips without Date instances or lost fields', () => {
    const dto = composeSections(makeSettings({
      publicReadOnly: true,
      openTerminalInFeishu: true,
      maintenance: { autoUpdate: { enabled: true, time: '05:15' }, autoRestart: { enabled: false } },
      localDevInstall: false,
    }));
    const round = JSON.parse(JSON.stringify(dto));
    expect(round).toEqual(dto);
  });

  it('canWrite defaults to true when ComposeOptions is omitted or undefined', () => {
    const explicit = composeSections(makeSettings(), { canWrite: true } as ComposeOptions);
    const omitted = composeSections(makeSettings());
    expect(omitted).toEqual(explicit);
  });
});
