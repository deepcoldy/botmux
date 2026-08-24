import { describe, expect, it, vi } from 'vitest';

import type {
  DashboardGlobalConfig,
  GlobalConfig,
  MaintenanceConfig,
} from '../src/global-config.js';
import { GROUP_NAME_PREFIX_MAX_LENGTH } from '../src/global-config.js';
import {
  applySettingsWrite,
  hasResolvedCodexNotifierRecipient,
  resolveCodexNotifierRecipientView,
  type ResolvedDashboardSettingsView,
  type SettingsWriteApplierDeps,
} from '../src/dashboard/settings-write-applier.js';

function makeDeps(overrides: Partial<SettingsWriteApplierDeps> = {}): SettingsWriteApplierDeps {
  const storedDashboard: DashboardGlobalConfig = {};
  const storedMaintenance: MaintenanceConfig = {};
  const storedGlobal: GlobalConfig = {};
  const settingsView: ResolvedDashboardSettingsView = {
    groupNamePrefix: '',
    publicReadOnly: false,
    openTerminalInFeishu: false,
    enableLocalCliOpen: false,
    localCliOpenMode: 'attach',
    chatBotDiscovery: true,
    herdrTraexPlugin: { enabled: false, source: '', ref: '', recommendedSource: '', recommendedRef: '' },
    codexRpcInput: false,
    codexNotifier: {
      enabled: false,
      targetBotAppId: null,
      notifyWhen: 'locked_only',
      platformSupported: true,
      hookInstalled: false,
    },
    hostOverloadAlert: {
      enabled: false,
      targetBotAppId: null,
      enterLoadRatio: 1.5,
      enterMemUsedFrac: 0.92,
    },
    vcMeetingAgent: { enabled: true },
    workflow: { enabled: true },
    maintenance: {},
    localDevInstall: false,
  };
  return {
    readGlobalConfig: vi.fn(() => storedGlobal),
    mergeDashboardConfig: vi.fn((patch) => {
      Object.assign(storedDashboard, patch);
      return storedDashboard;
    }),
    mergeGlobalConfig: vi.fn((patch) => {
      Object.assign(storedGlobal, patch);
    }),
    writeCodexNotifierConfig: vi.fn((config) => {
      storedGlobal.codexNotifier = config;
    }),
    writeHostOverloadAlertConfig: vi.fn((config) => {
      storedGlobal.hostOverloadAlert = config;
    }),
    mergeMaintenanceConfig: vi.fn((patch) => {
      Object.assign(storedMaintenance, patch);
      return storedMaintenance;
    }),
    setGlobalLocale: vi.fn(),
    parseMaintenancePatch: vi.fn((body: any) => {
      if (!body || typeof body !== 'object') return { ok: false, error: 'empty' } as const;
      return { ok: true, patch: body as MaintenanceConfig } as const;
    }),
    isLocalDevInstall: vi.fn(() => false),
    isAutoUpdateSupportedInstall: vi.fn(() => true),
    resolveDashboardSettings: vi.fn(() => settingsView),
    isLocale: ((v: unknown): v is 'zh' | 'en' => v === 'zh' || v === 'en'),
    validateCodexNotifierTargetBotAppId: vi.fn(async () => ({ ok: true as const })),
    validateHostOverloadAlertTargetBotAppId: vi.fn(async () => ({ ok: true as const })),
    installCodexNotifierHook: vi.fn(),
    isCodexNotifierPlatformSupported: vi.fn(() => true),
    ...overrides,
  };
}

describe('hasResolvedCodexNotifierRecipient', () => {
  it('accepts the first usable administrator without requiring every configured entry to resolve', () => {
    expect(hasResolvedCodexNotifierRecipient(['ou_owner'])).toBe(true);
    expect(hasResolvedCodexNotifierRecipient(['invalid', 'ou_owner', 'ou_owner'])).toBe(true);
  });

  it('rejects an offline or unresolved administrator list', () => {
    expect(hasResolvedCodexNotifierRecipient(undefined)).toBe(false);
    expect(hasResolvedCodexNotifierRecipient([])).toBe(false);
    expect(hasResolvedCodexNotifierRecipient(['on_owner', 'owner@example.com'])).toBe(false);
  });
});

describe('resolveCodexNotifierRecipientView', () => {
  it('shows the same resolved open_id that daemon will actually receive', () => {
    expect(resolveCodexNotifierRecipientView(
      ['unresolved@example.com', 'second@example.com'],
      ['ou_actual_recipient'],
    )).toEqual({
      recipientConfigured: true,
      recipientVerified: true,
      recipientHint: 'ou_actua…ient',
    });
  });

  it('does not present an unresolved configured account as the recipient', () => {
    expect(resolveCodexNotifierRecipientView(
      ['unresolved@example.com'],
      [],
    )).toEqual({
      recipientConfigured: true,
      recipientVerified: false,
      recipientHint: null,
    });
  });
});

describe('applySettingsWrite happy paths', () => {
  it('preserves separator whitespace in groupNamePrefix', async () => {
    const deps = makeDeps();
    const r = await applySettingsWrite({ groupNamePrefix: '[AI] ' }, deps);
    expect(r.ok).toBe(true);
    expect(deps.mergeGlobalConfig).toHaveBeenCalledWith({ groupNamePrefix: '[AI] ' });
  });

  it('clears groupNamePrefix when the dashboard saves an empty value', async () => {
    const deps = makeDeps();
    const r = await applySettingsWrite({ groupNamePrefix: '' }, deps);
    expect(r.ok).toBe(true);
    expect(deps.mergeGlobalConfig).toHaveBeenCalledWith({ groupNamePrefix: null });
  });

  it('writes publicReadOnly toggle and echoes the resolved snapshot', async () => {
    const deps = makeDeps();
    const r = await applySettingsWrite({ publicReadOnly: true }, deps);
    expect(r.ok).toBe(true);
    expect(deps.mergeDashboardConfig).toHaveBeenCalledWith({ publicReadOnly: true });
    expect(deps.mergeMaintenanceConfig).not.toHaveBeenCalled();
    expect(deps.resolveDashboardSettings).toHaveBeenCalledOnce();
  });

  it('writes openTerminalInFeishu toggle', async () => {
    const deps = makeDeps();
    const r = await applySettingsWrite({ openTerminalInFeishu: true }, deps);
    expect(r.ok).toBe(true);
    expect(deps.mergeDashboardConfig).toHaveBeenCalledWith({ openTerminalInFeishu: true });
  });

  it('writes enableLocalCliOpen toggle', async () => {
    const deps = makeDeps();
    const r = await applySettingsWrite({ enableLocalCliOpen: true }, deps);
    expect(r.ok).toBe(true);
    expect(deps.mergeDashboardConfig).toHaveBeenCalledWith({ enableLocalCliOpen: true });
  });

  it('writes localCliOpenMode enum', async () => {
    const deps = makeDeps();
    const r = await applySettingsWrite({ localCliOpenMode: 'resume' }, deps);
    expect(r.ok).toBe(true);
    expect(deps.mergeDashboardConfig).toHaveBeenCalledWith({ localCliOpenMode: 'resume' });
  });

  it('writes chatBotDiscovery toggle (off) through the dashboard segment', async () => {
    const deps = makeDeps();
    const r = await applySettingsWrite({ chatBotDiscovery: false }, deps);
    expect(r.ok).toBe(true);
    expect(deps.mergeDashboardConfig).toHaveBeenCalledWith({ chatBotDiscovery: false });
  });

  it('writes noVisibleOutputHint toggle (on) through the dashboard segment', async () => {
    const deps = makeDeps();
    const r = await applySettingsWrite({ noVisibleOutputHint: true }, deps);
    expect(r.ok).toBe(true);
    expect(deps.mergeDashboardConfig).toHaveBeenCalledWith({ noVisibleOutputHint: true });
  });

  it('writes bypassCodexHookTrust=false (the disable path — the whole point of a default-ON toggle)', async () => {
    const deps = makeDeps();
    const r = await applySettingsWrite({ bypassCodexHookTrust: false }, deps);
    expect(r.ok).toBe(true);
    // Must persist the explicit false so the default-ON getter (`!== false`) sees it.
    expect(deps.mergeDashboardConfig).toHaveBeenCalledWith({ bypassCodexHookTrust: false });
  });

  it('writes bypassCodexHookTrust=true (re-enable) through the dashboard segment', async () => {
    const deps = makeDeps();
    const r = await applySettingsWrite({ bypassCodexHookTrust: true }, deps);
    expect(r.ok).toBe(true);
    expect(deps.mergeDashboardConfig).toHaveBeenCalledWith({ bypassCodexHookTrust: true });
  });

  it('writes herdrTraexPlugin opt-in and trims source/ref through the dashboard segment', async () => {
    const deps = makeDeps();
    const r = await applySettingsWrite({
      herdrTraexPlugin: { enabled: true, source: ' owner/repo/subdir ', ref: ' reviewed-sha ' },
    }, deps);
    expect(r.ok).toBe(true);
    expect(deps.mergeDashboardConfig).toHaveBeenCalledWith({
      herdrTraexPlugin: { enabled: true, source: 'owner/repo/subdir', ref: 'reviewed-sha' },
    });
  });

  it('writes both dashboard fields in a single patch', async () => {
    const deps = makeDeps();
    const r = await applySettingsWrite({ publicReadOnly: true, openTerminalInFeishu: false }, deps);
    expect(r.ok).toBe(true);
    expect(deps.mergeDashboardConfig).toHaveBeenCalledWith({
      publicReadOnly: true,
      openTerminalInFeishu: false,
    });
  });

  it('writes maintenance autoUpdate with time when not on local-dev', async () => {
    const deps = makeDeps();
    const r = await applySettingsWrite({
      maintenance: { autoUpdate: { enabled: true, time: '04:00' } },
    }, deps);
    expect(r.ok).toBe(true);
    expect(deps.mergeMaintenanceConfig).toHaveBeenCalledWith({
      autoUpdate: { enabled: true, time: '04:00' },
    });
  });

  // Regression guard: the inline PUT /api/settings handler on master supported a
  // `whiteboard.enabled` toggle. When that handler was extracted into
  // applySettingsWrite, the field MUST be preserved or the master feature
  // silently regresses on merge (no test previously covered it).
  it('writes whiteboard.enabled toggle via mergeGlobalConfig', async () => {
    const deps = makeDeps();
    const r = await applySettingsWrite({ whiteboard: { enabled: true } }, deps);
    expect(r.ok).toBe(true);
    expect(deps.mergeGlobalConfig).toHaveBeenCalledWith({ whiteboard: { enabled: true } });
  });

  it('writes workflow.enabled toggle via mergeGlobalConfig, preserving sibling keys', async () => {
    const deps = makeDeps({
      readGlobalConfig: vi.fn(() => ({ workflow: { enabled: true, futureFlag: 1 } as any })),
    });
    const r = await applySettingsWrite({ workflow: { enabled: false } }, deps);
    expect(r.ok).toBe(true);
    expect(deps.mergeGlobalConfig).toHaveBeenCalledWith({ workflow: { enabled: false, futureFlag: 1 } });
  });

  it('rejects a non-object workflow patch', async () => {
    const deps = makeDeps();
    const r = await applySettingsWrite({ workflow: 'off' }, deps);
    expect(r).toEqual({ ok: false, error: 'invalid_workflow' });
    expect(deps.mergeGlobalConfig).not.toHaveBeenCalled();
  });

  it('rejects a non-boolean workflow.enabled', async () => {
    const deps = makeDeps();
    const r = await applySettingsWrite({ workflow: { enabled: 'yes' } }, deps);
    expect(r).toEqual({ ok: false, error: 'invalid_workflow_enabled' });
    expect(deps.mergeGlobalConfig).not.toHaveBeenCalled();
  });

  it('writes vcMeetingAgent.enabled toggle via mergeGlobalConfig', async () => {
    const deps = makeDeps();
    const r = await applySettingsWrite({ vcMeetingAgent: { enabled: false } }, deps);
    expect(r.ok).toBe(true);
    expect(deps.mergeGlobalConfig).toHaveBeenCalledWith({ vcMeetingAgent: { enabled: false } });
  });

  // 全局「会议事件接收 Bot」pin 已退役：daemon 侧每个 VC-active 的 bot 各自处理收到
  // 的会议事件，没人再读 listenerBotAppId。写路径必须把历史残留擦掉，别在配置里留一
  // 个谁都不读、看着却像还生效的字段。
  it('erases a stale vcMeetingAgent.listenerBotAppId on the next write', async () => {
    const deps = makeDeps({
      readGlobalConfig: vi.fn(() => ({ vcMeetingAgent: { enabled: true, listenerBotAppId: 'cli_old' } })),
    });
    const r = await applySettingsWrite({ vcMeetingAgent: { enabled: true } }, deps);
    expect(r.ok).toBe(true);
    expect(deps.mergeGlobalConfig).toHaveBeenCalledWith({ vcMeetingAgent: { enabled: true } });
  });

  it('never resurrects the retired listener pin from a client-supplied patch', async () => {
    const deps = makeDeps({
      readGlobalConfig: vi.fn(() => ({ vcMeetingAgent: { enabled: true } })),
    });
    // 老前端（或手搓 POST）还在提交这个字段时，也不能把 pin 写回去。
    const r = await applySettingsWrite(
      { vcMeetingAgent: { enabled: true, listenerBotAppId: 'cli_listener' } as any },
      deps,
    );
    expect(r.ok).toBe(true);
    expect(deps.mergeGlobalConfig).toHaveBeenCalledWith({ vcMeetingAgent: { enabled: true } });
  });

  it('merges a partial codexNotifier patch without revalidating an unchanged target', async () => {
    const deps = makeDeps({
      readGlobalConfig: vi.fn(() => ({
        codexNotifier: {
          enabled: false,
          targetBotAppId: 'cli_notify',
          notifyWhen: 'locked_only',
        },
      })),
    });

    const r = await applySettingsWrite({ codexNotifier: { notifyWhen: 'always' } }, deps);

    expect(r.ok).toBe(true);
    expect(deps.validateCodexNotifierTargetBotAppId).not.toHaveBeenCalled();
    expect(deps.installCodexNotifierHook).not.toHaveBeenCalled();
    expect(deps.writeCodexNotifierConfig).toHaveBeenCalledWith({
      enabled: false,
      targetBotAppId: 'cli_notify',
      notifyWhen: 'always',
    });
  });

  it('can disable codexNotifier while the persisted target daemon is offline', async () => {
    const validate = vi.fn(async () => ({
      ok: false as const,
      error: 'codexNotifier_target_daemon_offline',
    }));
    const deps = makeDeps({
      readGlobalConfig: vi.fn(() => ({
        codexNotifier: {
          enabled: true,
          targetBotAppId: 'cli_notify',
          notifyWhen: 'locked_only',
        },
      })),
      validateCodexNotifierTargetBotAppId: validate,
    });

    const r = await applySettingsWrite({ codexNotifier: { enabled: false } }, deps);

    expect(r.ok).toBe(true);
    expect(validate).not.toHaveBeenCalled();
    expect(deps.installCodexNotifierHook).not.toHaveBeenCalled();
    expect(deps.writeCodexNotifierConfig).toHaveBeenCalledWith({
      enabled: false,
      targetBotAppId: 'cli_notify',
      notifyWhen: 'locked_only',
    });
  });

  it('saves an offline target while notifications remain disabled', async () => {
    const validate = vi.fn(async (
      _appId: string,
      options?: { requireReady?: boolean },
    ) => options?.requireReady
      ? { ok: false as const, error: 'codexNotifier_target_daemon_offline' }
      : { ok: true as const });
    const deps = makeDeps({
      validateCodexNotifierTargetBotAppId: validate,
    });

    const r = await applySettingsWrite({
      codexNotifier: {
        targetBotAppId: 'cli_notify',
      },
    }, deps);

    expect(r.ok).toBe(true);
    expect(validate).toHaveBeenCalledWith('cli_notify', { requireReady: false });
    expect(deps.writeCodexNotifierConfig).toHaveBeenCalledWith({
      targetBotAppId: 'cli_notify',
    });
  });

  it('validates the target and installs the Hook before enabling codexNotifier', async () => {
    const deps = makeDeps();

    const r = await applySettingsWrite({
      codexNotifier: {
        enabled: true,
        targetBotAppId: ' cli_notify ',
        notifyWhen: 'locked_only',
      },
    }, deps);

    expect(r.ok).toBe(true);
    expect(deps.validateCodexNotifierTargetBotAppId).toHaveBeenCalledWith(
      'cli_notify',
      { requireReady: true },
    );
    expect(deps.installCodexNotifierHook).toHaveBeenCalledOnce();
    expect(vi.mocked(deps.validateCodexNotifierTargetBotAppId!).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(deps.installCodexNotifierHook!).mock.invocationCallOrder[0]);
    expect(vi.mocked(deps.installCodexNotifierHook!).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(deps.writeCodexNotifierConfig!).mock.invocationCallOrder[0]);
    expect(deps.writeCodexNotifierConfig).toHaveBeenCalledWith({
      enabled: true,
      targetBotAppId: 'cli_notify',
      notifyWhen: 'locked_only',
    });
  });
});

describe('applySettingsWrite — validation errors', () => {
  it('rejects invalid groupNamePrefix payloads without writing', async () => {
    for (const groupNamePrefix of [
      42,
      '   ',
      'AI\n讨论·',
      'AI\u0080讨论·',
      'AI\u0085讨论·',
      'AI\u009f讨论·',
      'x'.repeat(GROUP_NAME_PREFIX_MAX_LENGTH + 1),
    ]) {
      const deps = makeDeps();
      const r = await applySettingsWrite({ groupNamePrefix }, deps);
      expect(r.ok).toBe(false);
      if (r.ok) throw new Error('expected failure');
      expect(r.error).toBe('invalid_groupNamePrefix');
      expect(deps.mergeGlobalConfig).not.toHaveBeenCalled();
    }
  });

  it('does not persist a valid prefix when another dashboard field is invalid', async () => {
    const deps = makeDeps();
    const r = await applySettingsWrite({ groupNamePrefix: 'AI讨论·', publicReadOnly: 'yes' }, deps);
    expect(r.ok).toBe(false);
    expect(deps.mergeGlobalConfig).not.toHaveBeenCalled();
  });

  it('does not persist a valid prefix when a later global field is invalid', async () => {
    const deps = makeDeps();
    const r = await applySettingsWrite({ groupNamePrefix: '[AI] ', repoPickerMode: 'invalid' }, deps);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('expected failure');
    expect(r.error).toBe('invalid_repoPickerMode');
    expect(deps.mergeGlobalConfig).not.toHaveBeenCalled();
  });

  it('rejects non-boolean publicReadOnly → invalid_publicReadOnly', async () => {
    const deps = makeDeps();
    const r = await applySettingsWrite({ publicReadOnly: 'yes' }, deps);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.error).toBe('invalid_publicReadOnly');
    expect(deps.mergeDashboardConfig).not.toHaveBeenCalled();
  });

  it('rejects non-boolean chatBotDiscovery → invalid_chatBotDiscovery', async () => {
    const deps = makeDeps();
    const r = await applySettingsWrite({ chatBotDiscovery: 'no' }, deps);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('expected failure');
    expect(r.error).toBe('invalid_chatBotDiscovery');
  });

  it('rejects non-boolean noVisibleOutputHint → invalid_noVisibleOutputHint', async () => {
    const deps = makeDeps();
    const r = await applySettingsWrite({ noVisibleOutputHint: 'yes' }, deps);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('expected failure');
    expect(r.error).toBe('invalid_noVisibleOutputHint');
    expect(deps.mergeDashboardConfig).not.toHaveBeenCalled();
  });

  it('rejects non-boolean bypassCodexHookTrust → invalid_bypassCodexHookTrust', async () => {
    const deps = makeDeps();
    const r = await applySettingsWrite({ bypassCodexHookTrust: 'no' }, deps);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('expected failure');
    expect(r.error).toBe('invalid_bypassCodexHookTrust');
    expect(deps.mergeDashboardConfig).not.toHaveBeenCalled();
  });

  it('rejects invalid herdrTraexPlugin payloads', async () => {
    const deps = makeDeps();
    const r1 = await applySettingsWrite({ herdrTraexPlugin: 'on' }, deps);
    expect(r1.ok).toBe(false);
    if (r1.ok) throw new Error('expected failure');
    expect(r1.error).toBe('invalid_herdrTraexPlugin');

    const r2 = await applySettingsWrite({ herdrTraexPlugin: { enabled: 'yes' } }, deps);
    expect(r2.ok).toBe(false);
    if (r2.ok) throw new Error('expected failure');
    expect(r2.error).toBe('invalid_herdrTraexPlugin_enabled');

    const r3 = await applySettingsWrite({ herdrTraexPlugin: { source: 42 } }, deps);
    expect(r3.ok).toBe(false);
    if (r3.ok) throw new Error('expected failure');
    expect(r3.error).toBe('invalid_herdrTraexPlugin_source');

    const r4 = await applySettingsWrite({ herdrTraexPlugin: { ref: 42 } }, deps);
    expect(r4.ok).toBe(false);
    if (r4.ok) throw new Error('expected failure');
    expect(r4.error).toBe('invalid_herdrTraexPlugin_ref');

    const r5 = await applySettingsWrite({ herdrTraexPlugin: { source: '--ref evil' } }, deps);
    expect(r5.ok).toBe(false);
    if (r5.ok) throw new Error('expected failure');
    expect(r5.error).toBe('invalid_herdrTraexPlugin_source');

    const r6 = await applySettingsWrite({ herdrTraexPlugin: { ref: '--yes' } }, deps);
    expect(r6.ok).toBe(false);
    if (r6.ok) throw new Error('expected failure');
    expect(r6.error).toBe('invalid_herdrTraexPlugin_ref');
  });

  it('rejects non-boolean openTerminalInFeishu → invalid_openTerminalInFeishu', async () => {
    const deps = makeDeps();
    const r = await applySettingsWrite({ openTerminalInFeishu: 1 }, deps);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.error).toBe('invalid_openTerminalInFeishu');
  });

  it('rejects non-boolean enableLocalCliOpen → invalid_enableLocalCliOpen', async () => {
    const deps = makeDeps();
    const r = await applySettingsWrite({ enableLocalCliOpen: 'yes' }, deps);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.error).toBe('invalid_enableLocalCliOpen');
  });

  it('rejects invalid localCliOpenMode enum → invalid_localCliOpenMode', async () => {
    const deps = makeDeps();
    const r = await applySettingsWrite({ localCliOpenMode: 'tmux' }, deps);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.error).toBe('invalid_localCliOpenMode');
    expect(deps.mergeDashboardConfig).not.toHaveBeenCalled();
  });

  it('rejects non-object whiteboard → invalid_whiteboard', async () => {
    const deps = makeDeps();
    const r = await applySettingsWrite({ whiteboard: 'on' }, deps);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.error).toBe('invalid_whiteboard');
    expect(deps.mergeGlobalConfig).not.toHaveBeenCalled();
  });

  it('rejects non-object vcMeetingAgent → invalid_vcMeetingAgent', async () => {
    const deps = makeDeps();
    const r = await applySettingsWrite({ vcMeetingAgent: 'off' }, deps);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.error).toBe('invalid_vcMeetingAgent');
    expect(deps.mergeGlobalConfig).not.toHaveBeenCalled();
  });

  it('rejects non-boolean vcMeetingAgent.enabled → invalid_vcMeetingAgent_enabled', async () => {
    const deps = makeDeps();
    const r = await applySettingsWrite({ vcMeetingAgent: { enabled: 'no' } }, deps);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.error).toBe('invalid_vcMeetingAgent_enabled');
    expect(deps.mergeGlobalConfig).not.toHaveBeenCalled();
  });

  // listenerBotAppId 退役后不再是可写字段：只带它的 patch 等于什么都没改，必须被
  // 当作空 patch 拒绝，而不是靠它触发一次全局写。
  it('rejects a vcMeetingAgent patch that carries only the retired listener pin', async () => {
    const deps = makeDeps();
    const r = await applySettingsWrite({ vcMeetingAgent: { listenerBotAppId: 'cli_listener' } as any }, deps);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.error).toBe('invalid_vcMeetingAgent_enabled');
    expect(deps.mergeGlobalConfig).not.toHaveBeenCalled();
  });

  it('requires an explicit target before enabling codexNotifier', async () => {
    const deps = makeDeps();

    const r = await applySettingsWrite({ codexNotifier: { enabled: true } }, deps);

    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.error).toBe('codexNotifier_target_required');
    expect(deps.installCodexNotifierHook).not.toHaveBeenCalled();
    expect(deps.mergeGlobalConfig).not.toHaveBeenCalled();
  });

  it('rejects an unknown codexNotifier target before installing the Hook', async () => {
    const deps = makeDeps({
      validateCodexNotifierTargetBotAppId: vi.fn(async () => ({
        ok: false as const,
        error: 'codexNotifier_target_unknown',
      })),
    });

    const r = await applySettingsWrite({
      codexNotifier: {
        enabled: true,
        targetBotAppId: 'cli_missing',
        notifyWhen: 'always',
      },
    }, deps);

    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.error).toBe('codexNotifier_target_unknown');
    expect(deps.installCodexNotifierHook).not.toHaveBeenCalled();
    expect(deps.mergeGlobalConfig).not.toHaveBeenCalled();
  });

  it('rejects a target without an administrator before installing the Hook', async () => {
    const deps = makeDeps({
      validateCodexNotifierTargetBotAppId: vi.fn(async () => ({
        ok: false as const,
        error: 'codexNotifier_target_owner_missing',
      })),
    });

    const r = await applySettingsWrite({
      codexNotifier: {
        enabled: true,
        targetBotAppId: 'cli_without_owner',
        notifyWhen: 'always',
      },
    }, deps);

    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.error).toBe('codexNotifier_target_owner_missing');
    expect(deps.installCodexNotifierHook).not.toHaveBeenCalled();
    expect(deps.mergeGlobalConfig).not.toHaveBeenCalled();
  });

  it('rejects locked_only on a platform without reliable lock detection', async () => {
    const deps = makeDeps({
      isCodexNotifierPlatformSupported: vi.fn(() => false),
    });

    const r = await applySettingsWrite({
      codexNotifier: {
        enabled: true,
        targetBotAppId: 'cli_notify',
        notifyWhen: 'locked_only',
      },
    }, deps);

    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.error).toBe('codexNotifier_platform_unsupported');
    expect(deps.installCodexNotifierHook).not.toHaveBeenCalled();
    expect(deps.mergeGlobalConfig).not.toHaveBeenCalled();
  });

  it('allows always notifications on a platform without lock detection', async () => {
    const deps = makeDeps({
      isCodexNotifierPlatformSupported: vi.fn(() => false),
    });

    const r = await applySettingsWrite({
      codexNotifier: {
        enabled: true,
        targetBotAppId: 'cli_notify',
        notifyWhen: 'always',
      },
    }, deps);

    expect(r.ok).toBe(true);
    expect(deps.installCodexNotifierHook).toHaveBeenCalledOnce();
    expect(deps.writeCodexNotifierConfig).toHaveBeenCalledWith({
      enabled: true,
      targetBotAppId: 'cli_notify',
      notifyWhen: 'always',
    });
  });

  it('does not persist codexNotifier when Hook installation fails', async () => {
    const deps = makeDeps({
      installCodexNotifierHook: vi.fn(() => {
        throw new Error('write failed');
      }),
    });

    const r = await applySettingsWrite({
      codexNotifier: {
        enabled: true,
        targetBotAppId: 'cli_notify',
        notifyWhen: 'always',
      },
    }, deps);

    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.error).toBe('codexNotifier_hook_install_failed');
    expect(deps.writeCodexNotifierConfig).not.toHaveBeenCalled();
  });

  it('rejects mixed notifier writes before any partial persistence', async () => {
    const deps = makeDeps();

    const r = await applySettingsWrite({
      codexNotifier: {
        enabled: true,
        targetBotAppId: 'cli_notify',
        notifyWhen: 'always',
      },
      repoPickerMode: 'invalid',
    }, deps);

    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.error).toBe('codexNotifier_mixed_patch_unsupported');
    expect(deps.installCodexNotifierHook).not.toHaveBeenCalled();
    expect(deps.writeCodexNotifierConfig).not.toHaveBeenCalled();
    expect(deps.mergeGlobalConfig).not.toHaveBeenCalled();
    expect(deps.mergeDashboardConfig).not.toHaveBeenCalled();
  });

  it('rejects non-boolean whiteboard.enabled → invalid_whiteboard_enabled', async () => {
    const deps = makeDeps();
    const r = await applySettingsWrite({ whiteboard: { enabled: 'yes' } }, deps);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.error).toBe('invalid_whiteboard_enabled');
    expect(deps.mergeGlobalConfig).not.toHaveBeenCalled();
  });

  it('refuses enabling autoUpdate on a local-dev install → local_dev_no_autoupdate', async () => {
    const deps = makeDeps({ isLocalDevInstall: vi.fn(() => true) });
    const r = await applySettingsWrite({
      maintenance: { autoUpdate: { enabled: true } },
    }, deps);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.error).toBe('local_dev_no_autoupdate');
    expect(deps.mergeMaintenanceConfig).not.toHaveBeenCalled();
  });

  it('refuses enabling autoUpdate for an unsupported global install', async () => {
    const deps = makeDeps({ isAutoUpdateSupportedInstall: vi.fn(() => false) });
    const r = await applySettingsWrite({
      maintenance: { autoUpdate: { enabled: true } },
    }, deps);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.error).toBe('unsupported_install_no_autoupdate');
    expect(deps.mergeMaintenanceConfig).not.toHaveBeenCalled();
  });

  it('refuses enabling autoRestart when autoUpdate is not on → autoupdate_required', async () => {
    const deps = makeDeps({
      readGlobalConfig: vi.fn(() => ({ maintenance: { autoUpdate: { enabled: false } } })),
    });
    const r = await applySettingsWrite({
      maintenance: { autoRestart: { enabled: true } },
    }, deps);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.error).toBe('autoupdate_required');
    expect(deps.mergeMaintenanceConfig).not.toHaveBeenCalled();
  });

  it('accepts autoRestart=true when autoUpdate is being enabled in the same patch', async () => {
    const deps = makeDeps();
    const r = await applySettingsWrite({
      maintenance: { autoUpdate: { enabled: true }, autoRestart: { enabled: true } },
    }, deps);
    expect(r.ok).toBe(true);
    expect(deps.mergeMaintenanceConfig).toHaveBeenCalledWith({
      autoUpdate: { enabled: true },
      autoRestart: { enabled: true },
    });
  });

  it('accepts autoRestart=true when autoUpdate is already on in stored config', async () => {
    const deps = makeDeps({
      readGlobalConfig: vi.fn(() => ({ maintenance: { autoUpdate: { enabled: true } } })),
    });
    const r = await applySettingsWrite({
      maintenance: { autoRestart: { enabled: true } },
    }, deps);
    expect(r.ok).toBe(true);
  });

  it('returns parseMaintenancePatch error verbatim (e.g. invalid_time)', async () => {
    const deps = makeDeps({
      parseMaintenancePatch: vi.fn(() => ({ ok: false, error: 'invalid_time' })),
    });
    const r = await applySettingsWrite({ maintenance: { autoUpdate: { time: 'noon' } } }, deps);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.error).toBe('invalid_time');
  });

  it('returns empty_patch when neither dashboard nor maintenance fields appear', async () => {
    const deps = makeDeps();
    const r = await applySettingsWrite({}, deps);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.error).toBe('empty_patch');
    expect(deps.mergeDashboardConfig).not.toHaveBeenCalled();
    expect(deps.mergeMaintenanceConfig).not.toHaveBeenCalled();
  });

  it('treats non-object input as empty (returns empty_patch)', async () => {
    const deps = makeDeps();
    expect(await applySettingsWrite(null, deps)).toEqual({ ok: false, error: 'empty_patch' });
    expect(await applySettingsWrite(undefined, deps)).toEqual({ ok: false, error: 'empty_patch' });
    expect(await applySettingsWrite('string', deps)).toEqual({ ok: false, error: 'empty_patch' });
    expect(await applySettingsWrite([1, 2], deps)).toEqual({ ok: false, error: 'empty_patch' });
  });
});

describe('applySettingsWrite — scheduleTimeZone', () => {
  it('persists a valid IANA zone via mergeGlobalConfig', async () => {
    const deps = makeDeps();
    const r = await applySettingsWrite({ scheduleTimeZone: 'Asia/Shanghai' }, deps);
    expect(r.ok).toBe(true);
    expect(deps.mergeGlobalConfig).toHaveBeenCalledWith({ scheduleTimeZone: 'Asia/Shanghai' });
  });

  it('trims surrounding whitespace before persisting', async () => {
    const deps = makeDeps();
    const r = await applySettingsWrite({ scheduleTimeZone: '  America/New_York  ' }, deps);
    expect(r.ok).toBe(true);
    expect(deps.mergeGlobalConfig).toHaveBeenCalledWith({ scheduleTimeZone: 'America/New_York' });
  });

  it('rejects an invalid zone → invalid_scheduleTimeZone (no write)', async () => {
    const deps = makeDeps();
    const r = await applySettingsWrite({ scheduleTimeZone: 'Mars/Phobos' }, deps);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.error).toBe('invalid_scheduleTimeZone');
    expect(deps.mergeGlobalConfig).not.toHaveBeenCalled();
  });

  it('rejects a non-string zone → invalid_scheduleTimeZone', async () => {
    const deps = makeDeps();
    const r = await applySettingsWrite({ scheduleTimeZone: 42 }, deps);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.error).toBe('invalid_scheduleTimeZone');
  });

  it("clears the override on '' → mergeGlobalConfig({ scheduleTimeZone: null })", async () => {
    const deps = makeDeps();
    const r = await applySettingsWrite({ scheduleTimeZone: '' }, deps);
    expect(r.ok).toBe(true);
    expect(deps.mergeGlobalConfig).toHaveBeenCalledWith({ scheduleTimeZone: null });
  });

  it('clears the override on null → mergeGlobalConfig({ scheduleTimeZone: null })', async () => {
    const deps = makeDeps();
    const r = await applySettingsWrite({ scheduleTimeZone: null }, deps);
    expect(r.ok).toBe(true);
    expect(deps.mergeGlobalConfig).toHaveBeenCalledWith({ scheduleTimeZone: null });
  });
});

// oauthRedirectBase 是 OAuth 零粘贴授权的输入：授权链接回跳 `<base>/oauth/callback`，
// 而 dashboard 的接收器是 pathname 精确匹配。所以只收 http(s) 的 origin，路径 / query /
// fragment / 凭证一律拒——用户填错要在保存这一刻就知道，而不是等飞书跳回来才发现。
describe('applySettingsWrite — oauthRedirectBase', () => {
  it('persists a valid https origin', async () => {
    const deps = makeDeps();
    const r = await applySettingsWrite({ oauthRedirectBase: 'https://botmux.example.com' }, deps);
    expect(r.ok).toBe(true);
    expect(deps.mergeGlobalConfig).toHaveBeenCalledWith({ oauthRedirectBase: 'https://botmux.example.com' });
  });

  it('accepts plain http with an explicit port (LAN / 自建反代场景)', async () => {
    const deps = makeDeps();
    const r = await applySettingsWrite({ oauthRedirectBase: 'http://10.1.2.3:7891' }, deps);
    expect(r.ok).toBe(true);
    expect(deps.mergeGlobalConfig).toHaveBeenCalledWith({ oauthRedirectBase: 'http://10.1.2.3:7891' });
  });

  it('strips trailing slashes and surrounding whitespace', async () => {
    const deps = makeDeps();
    const r = await applySettingsWrite({ oauthRedirectBase: '  https://botmux.example.com///  ' }, deps);
    expect(r.ok).toBe(true);
    expect(deps.mergeGlobalConfig).toHaveBeenCalledWith({ oauthRedirectBase: 'https://botmux.example.com' });
  });

  it('normalizes scheme case and the default port away', async () => {
    const deps = makeDeps();
    const r = await applySettingsWrite({ oauthRedirectBase: 'HTTPS://Botmux.Example.COM:443' }, deps);
    expect(r.ok).toBe(true);
    expect(deps.mergeGlobalConfig).toHaveBeenCalledWith({ oauthRedirectBase: 'https://botmux.example.com' });
  });

  it("clears the setting on '' → mergeGlobalConfig({ oauthRedirectBase: null })", async () => {
    const deps = makeDeps();
    const r = await applySettingsWrite({ oauthRedirectBase: '' }, deps);
    expect(r.ok).toBe(true);
    expect(deps.mergeGlobalConfig).toHaveBeenCalledWith({ oauthRedirectBase: null });
  });

  it('clears the setting on a whitespace-only string', async () => {
    const deps = makeDeps();
    const r = await applySettingsWrite({ oauthRedirectBase: '   ' }, deps);
    expect(r.ok).toBe(true);
    expect(deps.mergeGlobalConfig).toHaveBeenCalledWith({ oauthRedirectBase: null });
  });

  it('clears the setting on null', async () => {
    const deps = makeDeps();
    const r = await applySettingsWrite({ oauthRedirectBase: null }, deps);
    expect(r.ok).toBe(true);
    expect(deps.mergeGlobalConfig).toHaveBeenCalledWith({ oauthRedirectBase: null });
  });

  for (const [label, value] of [
    ['a bare host without a scheme', 'botmux.example.com'],
    ['a non-http(s) scheme', 'ftp://botmux.example.com'],
    ['a path prefix (dashboard matches /oauth/callback exactly)', 'https://botmux.example.com/botmux'],
    ['a query string', 'https://botmux.example.com?token=x'],
    ['a fragment', 'https://botmux.example.com#x'],
    ['embedded credentials', 'https://user:pw@botmux.example.com'],
    ['a scheme with no host', 'http://'],
    ['a non-string value', 42],
  ] as Array<[string, unknown]>) {
    it(`rejects ${label} → invalid_oauthRedirectBase (no write)`, async () => {
      const deps = makeDeps();
      const r = await applySettingsWrite({ oauthRedirectBase: value }, deps);
      expect(r.ok).toBe(false);
      if (r.ok) throw new Error('unreachable');
      expect(r.error).toBe('invalid_oauthRedirectBase');
      expect(deps.mergeGlobalConfig).not.toHaveBeenCalled();
    });
  }
});

describe('applySettingsWrite — IO surface', () => {
  it('does not touch maintenance merge when only dashboard fields are present', async () => {
    const deps = makeDeps();
    await applySettingsWrite({ publicReadOnly: true }, deps);
    expect(deps.mergeMaintenanceConfig).not.toHaveBeenCalled();
  });

  it('calls both merges when both segments are present', async () => {
    const deps = makeDeps();
    const r = await applySettingsWrite({
      publicReadOnly: true,
      maintenance: { autoUpdate: { enabled: true, time: '05:00' } },
    }, deps);
    expect(r.ok).toBe(true);
    expect(deps.mergeDashboardConfig).toHaveBeenCalledOnce();
    expect(deps.mergeMaintenanceConfig).toHaveBeenCalledOnce();
  });

  it('never writes to disk when validation fails (every error path early-returns)', async () => {
    const deps = makeDeps();
    await applySettingsWrite({ publicReadOnly: 'no' }, deps);
    expect(deps.mergeDashboardConfig).not.toHaveBeenCalled();
    expect(deps.mergeMaintenanceConfig).not.toHaveBeenCalled();
    expect(deps.resolveDashboardSettings).not.toHaveBeenCalled();
  });

  it('isolates from real ~/.botmux — deps are mock and never reach the file system', async () => {
    // This test exists to encode the invariant that the helper is pure w.r.t.
    // its deps. No I/O assertions can fully prove it, but the lack of any
    // `fs`/`path` imports in the SUT plus mock deps achieves the contract.
    const deps = makeDeps();
    await applySettingsWrite({ publicReadOnly: true }, deps);
    expect(deps.readGlobalConfig).not.toHaveBeenCalled(); // only called for autoUpdate cross-check
  });
});

describe('applySettingsWrite — hostOverloadAlert', () => {
  it('validates the target (requireReady) and persists on enable', async () => {
    const deps = makeDeps();
    const r = await applySettingsWrite({
      hostOverloadAlert: { enabled: true, targetBotAppId: ' cli_notify ' },
    }, deps);

    expect(r.ok).toBe(true);
    // Trimmed + validated with requireReady=true (must be online to deliver).
    expect(deps.validateHostOverloadAlertTargetBotAppId).toHaveBeenCalledWith('cli_notify', { requireReady: true });
    expect(deps.writeHostOverloadAlertConfig).toHaveBeenCalledWith({
      enabled: true,
      targetBotAppId: 'cli_notify',
    });
  });

  it('validates a target-only change with requireReady=false (not enabling yet)', async () => {
    const deps = makeDeps();
    const r = await applySettingsWrite({
      hostOverloadAlert: { targetBotAppId: 'cli_notify' },
    }, deps);

    expect(r.ok).toBe(true);
    expect(deps.validateHostOverloadAlertTargetBotAppId).toHaveBeenCalledWith('cli_notify', { requireReady: false });
    expect(deps.writeHostOverloadAlertConfig).toHaveBeenCalledWith({ targetBotAppId: 'cli_notify' });
  });

  it('rejects enabling with no target selected', async () => {
    const deps = makeDeps();
    const r = await applySettingsWrite({ hostOverloadAlert: { enabled: true } }, deps);
    expect(r).toEqual({ ok: false, error: 'hostOverloadAlert_target_required' });
    expect(deps.writeHostOverloadAlertConfig).not.toHaveBeenCalled();
  });

  it('surfaces the validator error for an illegal target (apiOnly / unknown / offline)', async () => {
    const validate = vi.fn(async () => ({ ok: false as const, error: 'hostOverloadAlert_target_apiOnly' }));
    const deps = makeDeps({ validateHostOverloadAlertTargetBotAppId: validate });
    const r = await applySettingsWrite({
      hostOverloadAlert: { enabled: true, targetBotAppId: 'cli_api_only' },
    }, deps);
    expect(r).toEqual({ ok: false, error: 'hostOverloadAlert_target_apiOnly' });
    expect(deps.writeHostOverloadAlertConfig).not.toHaveBeenCalled();
  });

  it('rejects a non-boolean enabled', async () => {
    const deps = makeDeps();
    const r = await applySettingsWrite({ hostOverloadAlert: { enabled: 'yes' } } as any, deps);
    expect(r).toEqual({ ok: false, error: 'invalid_hostOverloadAlert_enabled' });
  });

  it('rejects a non-positive enterLoadRatio and out-of-range enterMemUsedFrac', async () => {
    const deps = makeDeps();
    expect(await applySettingsWrite({ hostOverloadAlert: { enterLoadRatio: 0 } }, deps))
      .toEqual({ ok: false, error: 'invalid_hostOverloadAlert_enterLoadRatio' });
    expect(await applySettingsWrite({ hostOverloadAlert: { enterMemUsedFrac: 1.5 } }, deps))
      .toEqual({ ok: false, error: 'invalid_hostOverloadAlert_enterMemUsedFrac' });
    expect(deps.writeHostOverloadAlertConfig).not.toHaveBeenCalled();
  });

  it('rejects a non-object / empty patch', async () => {
    const deps = makeDeps();
    expect(await applySettingsWrite({ hostOverloadAlert: null } as any, deps))
      .toEqual({ ok: false, error: 'invalid_hostOverloadAlert' });
    expect(await applySettingsWrite({ hostOverloadAlert: {} }, deps))
      .toEqual({ ok: false, error: 'invalid_hostOverloadAlert' });
  });

  it('merges a threshold-only change onto the persisted config without revalidating an unchanged target', async () => {
    const deps = makeDeps({
      readGlobalConfig: vi.fn(() => ({
        hostOverloadAlert: { enabled: true, targetBotAppId: 'cli_notify', enterLoadRatio: 1.5 },
      })) as any,
    });
    const r = await applySettingsWrite({ hostOverloadAlert: { enterLoadRatio: 2.0 } }, deps);
    expect(r.ok).toBe(true);
    // Neither enabling nor changing target → no target revalidation.
    expect(deps.validateHostOverloadAlertTargetBotAppId).not.toHaveBeenCalled();
    // The persisted enabled/target survive; only the threshold changes.
    expect(deps.writeHostOverloadAlertConfig).toHaveBeenCalledWith({
      enabled: true,
      targetBotAppId: 'cli_notify',
      enterLoadRatio: 2.0,
    });
  });

  it('can clear the target (null) and disable without requiring a target', async () => {
    const deps = makeDeps({
      readGlobalConfig: vi.fn(() => ({
        hostOverloadAlert: { enabled: false, targetBotAppId: 'cli_notify' },
      })) as any,
    });
    const r = await applySettingsWrite({
      hostOverloadAlert: { enabled: false, targetBotAppId: null },
    }, deps);
    expect(r.ok).toBe(true);
    expect(deps.writeHostOverloadAlertConfig).toHaveBeenCalledWith({ enabled: false });
  });
});
