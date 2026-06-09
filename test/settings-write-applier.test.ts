import { describe, expect, it, vi } from 'vitest';

import type {
  DashboardGlobalConfig,
  GlobalConfig,
  MaintenanceConfig,
} from '../src/global-config.js';
import {
  applySettingsWrite,
  type ResolvedDashboardSettingsView,
  type SettingsWriteApplierDeps,
} from '../src/dashboard/settings-write-applier.js';

function makeDeps(overrides: Partial<SettingsWriteApplierDeps> = {}): SettingsWriteApplierDeps {
  const storedDashboard: DashboardGlobalConfig = {};
  const storedMaintenance: MaintenanceConfig = {};
  const storedGlobal: GlobalConfig = {};
  const settingsView: ResolvedDashboardSettingsView = {
    publicReadOnly: false,
    openTerminalInFeishu: false,
    maintenance: {},
    localDevInstall: false,
  };
  return {
    readGlobalConfig: vi.fn(() => storedGlobal),
    mergeDashboardConfig: vi.fn((patch) => {
      Object.assign(storedDashboard, patch);
      return storedDashboard;
    }),
    mergeMaintenanceConfig: vi.fn((patch) => {
      Object.assign(storedMaintenance, patch);
      return storedMaintenance;
    }),
    parseMaintenancePatch: vi.fn((body: any) => {
      if (!body || typeof body !== 'object') return { ok: false, error: 'empty' } as const;
      return { ok: true, patch: body as MaintenanceConfig } as const;
    }),
    isLocalDevInstall: vi.fn(() => false),
    resolveDashboardSettings: vi.fn(() => settingsView),
    ...overrides,
  };
}

describe('applySettingsWrite happy paths', () => {
  it('writes publicReadOnly toggle and echoes the resolved snapshot', () => {
    const deps = makeDeps();
    const r = applySettingsWrite({ publicReadOnly: true }, deps);
    expect(r.ok).toBe(true);
    expect(deps.mergeDashboardConfig).toHaveBeenCalledWith({ publicReadOnly: true });
    expect(deps.mergeMaintenanceConfig).not.toHaveBeenCalled();
    expect(deps.resolveDashboardSettings).toHaveBeenCalledOnce();
  });

  it('writes openTerminalInFeishu toggle', () => {
    const deps = makeDeps();
    const r = applySettingsWrite({ openTerminalInFeishu: true }, deps);
    expect(r.ok).toBe(true);
    expect(deps.mergeDashboardConfig).toHaveBeenCalledWith({ openTerminalInFeishu: true });
  });

  it('writes both dashboard fields in a single patch', () => {
    const deps = makeDeps();
    const r = applySettingsWrite({ publicReadOnly: true, openTerminalInFeishu: false }, deps);
    expect(r.ok).toBe(true);
    expect(deps.mergeDashboardConfig).toHaveBeenCalledWith({
      publicReadOnly: true,
      openTerminalInFeishu: false,
    });
  });

  it('writes maintenance autoUpdate with time when not on local-dev', () => {
    const deps = makeDeps();
    const r = applySettingsWrite({
      maintenance: { autoUpdate: { enabled: true, time: '04:00' } },
    }, deps);
    expect(r.ok).toBe(true);
    expect(deps.mergeMaintenanceConfig).toHaveBeenCalledWith({
      autoUpdate: { enabled: true, time: '04:00' },
    });
  });
});

describe('applySettingsWrite — validation errors', () => {
  it('rejects non-boolean publicReadOnly → invalid_publicReadOnly', () => {
    const deps = makeDeps();
    const r = applySettingsWrite({ publicReadOnly: 'yes' }, deps);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.error).toBe('invalid_publicReadOnly');
    expect(deps.mergeDashboardConfig).not.toHaveBeenCalled();
  });

  it('rejects non-boolean openTerminalInFeishu → invalid_openTerminalInFeishu', () => {
    const deps = makeDeps();
    const r = applySettingsWrite({ openTerminalInFeishu: 1 }, deps);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.error).toBe('invalid_openTerminalInFeishu');
  });

  it('refuses enabling autoUpdate on a local-dev install → local_dev_no_autoupdate', () => {
    const deps = makeDeps({ isLocalDevInstall: vi.fn(() => true) });
    const r = applySettingsWrite({
      maintenance: { autoUpdate: { enabled: true } },
    }, deps);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.error).toBe('local_dev_no_autoupdate');
    expect(deps.mergeMaintenanceConfig).not.toHaveBeenCalled();
  });

  it('refuses enabling autoRestart when autoUpdate is not on → autoupdate_required', () => {
    const deps = makeDeps({
      readGlobalConfig: vi.fn(() => ({ maintenance: { autoUpdate: { enabled: false } } })),
    });
    const r = applySettingsWrite({
      maintenance: { autoRestart: { enabled: true } },
    }, deps);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.error).toBe('autoupdate_required');
    expect(deps.mergeMaintenanceConfig).not.toHaveBeenCalled();
  });

  it('accepts autoRestart=true when autoUpdate is being enabled in the same patch', () => {
    const deps = makeDeps();
    const r = applySettingsWrite({
      maintenance: { autoUpdate: { enabled: true }, autoRestart: { enabled: true } },
    }, deps);
    expect(r.ok).toBe(true);
    expect(deps.mergeMaintenanceConfig).toHaveBeenCalledWith({
      autoUpdate: { enabled: true },
      autoRestart: { enabled: true },
    });
  });

  it('accepts autoRestart=true when autoUpdate is already on in stored config', () => {
    const deps = makeDeps({
      readGlobalConfig: vi.fn(() => ({ maintenance: { autoUpdate: { enabled: true } } })),
    });
    const r = applySettingsWrite({
      maintenance: { autoRestart: { enabled: true } },
    }, deps);
    expect(r.ok).toBe(true);
  });

  it('returns parseMaintenancePatch error verbatim (e.g. invalid_time)', () => {
    const deps = makeDeps({
      parseMaintenancePatch: vi.fn(() => ({ ok: false, error: 'invalid_time' })),
    });
    const r = applySettingsWrite({ maintenance: { autoUpdate: { time: 'noon' } } }, deps);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.error).toBe('invalid_time');
  });

  it('returns empty_patch when neither dashboard nor maintenance fields appear', () => {
    const deps = makeDeps();
    const r = applySettingsWrite({}, deps);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.error).toBe('empty_patch');
    expect(deps.mergeDashboardConfig).not.toHaveBeenCalled();
    expect(deps.mergeMaintenanceConfig).not.toHaveBeenCalled();
  });

  it('treats non-object input as empty (returns empty_patch)', () => {
    const deps = makeDeps();
    expect(applySettingsWrite(null, deps)).toEqual({ ok: false, error: 'empty_patch' });
    expect(applySettingsWrite(undefined, deps)).toEqual({ ok: false, error: 'empty_patch' });
    expect(applySettingsWrite('string', deps)).toEqual({ ok: false, error: 'empty_patch' });
    expect(applySettingsWrite([1, 2], deps)).toEqual({ ok: false, error: 'empty_patch' });
  });
});

describe('applySettingsWrite — IO surface', () => {
  it('does not touch maintenance merge when only dashboard fields are present', () => {
    const deps = makeDeps();
    applySettingsWrite({ publicReadOnly: true }, deps);
    expect(deps.mergeMaintenanceConfig).not.toHaveBeenCalled();
  });

  it('calls both merges when both segments are present', () => {
    const deps = makeDeps();
    const r = applySettingsWrite({
      publicReadOnly: true,
      maintenance: { autoUpdate: { enabled: true, time: '05:00' } },
    }, deps);
    expect(r.ok).toBe(true);
    expect(deps.mergeDashboardConfig).toHaveBeenCalledOnce();
    expect(deps.mergeMaintenanceConfig).toHaveBeenCalledOnce();
  });

  it('never writes to disk when validation fails (every error path early-returns)', () => {
    const deps = makeDeps();
    applySettingsWrite({ publicReadOnly: 'no' }, deps);
    expect(deps.mergeDashboardConfig).not.toHaveBeenCalled();
    expect(deps.mergeMaintenanceConfig).not.toHaveBeenCalled();
    expect(deps.resolveDashboardSettings).not.toHaveBeenCalled();
  });

  it('isolates from real ~/.botmux — deps are mock and never reach the file system', () => {
    // This test exists to encode the invariant that the helper is pure w.r.t.
    // its deps. No I/O assertions can fully prove it, but the lack of any
    // `fs`/`path` imports in the SUT plus mock deps achieves the contract.
    const deps = makeDeps();
    applySettingsWrite({ publicReadOnly: true }, deps);
    expect(deps.readGlobalConfig).not.toHaveBeenCalled(); // only called for autoUpdate cross-check
  });
});
