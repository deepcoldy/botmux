import type { WecomNativeCoreConfig } from '../../im/wecom/config/native-core-config.js';
import type { WecomNativePlatformConfig } from '../../im/wecom/config/native-platform-config.js';
import { parseStartupCommandsInput } from '../../core/startup-commands.js';
import { parseCustomPassthroughInput } from '../../core/passthrough-commands.js';
import { createContext, useEffect, useRef, useState } from 'react';
import { jget, sendJson } from './dashboard-api.js';
import { controlCsrfHeaders } from './control-csrf.js';
import { t } from './ui.js';

export interface WecomBotConfiguration {
  native?: WecomNativeCoreConfig & WecomNativePlatformConfig;
  editable?: boolean;
  revision: string;
  replaceCliSelection?: boolean;
  displayName?: string;
  cli: string;
  backend: string;
  model?: string;
  workingDirectory: string;
  requiresRestart: true;
  sessionMode?: { p2pMode: 'chat'; regularGroupReplyMode: 'user' | 'chat'; regularGroupMentionMode: 'never' };
  commandTriggers?: Record<string, unknown> | null;
  botConfig?: Record<string, unknown>;
  runtime?: Record<string, unknown>;
  allowedUsers?: string[];
  blockedUsers?: string[];
  role?: { content: string; injectMode: 'every' | 'once' };
}

export type WecomBotConfigurationPatch = Partial<Pick<WecomBotConfiguration,
  | 'displayName'
  | 'cli'
  | 'replaceCliSelection'
  | 'backend'
  | 'model'
  | 'workingDirectory'
  | 'sessionMode'
  | 'commandTriggers'
  | 'botConfig'
  | 'allowedUsers'
  | 'blockedUsers'
  | 'role'
  | 'native'
>>;

/** Provider adapter only. Shared fields own their normal draft/save interaction.
 * Queue patches against the last committed revision, never a stale render's DTO. */
export function useWecomBotConfiguration(id: string, onSaved?: () => void) {
  const [config, setConfig] = useState<WecomBotConfiguration>();
  const [error, setError] = useState<string>();
  const current = useRef<WecomBotConfiguration | undefined>(undefined);
  const active = useRef(true);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const epoch = useRef(0);
  useEffect(() => {
    epoch.current++;
    active.current = true;
    current.current = undefined;
    setConfig(undefined);
    setError(undefined);
    let valid = true;
    void jget<WecomBotConfiguration>(`/api/wecom/connections/${encodeURIComponent(id)}/config`)
      .then(response => {
        if (!valid) return;
        const body = response.body;
        // 只读（外部 core）的配置标了 editable:false 就够；可编辑的必须带 cli 与 revision。
        const usable = response.status === 200
          && (body.editable === false || (typeof body.cli === 'string' && typeof body.revision === 'string'));
        if (!usable) throw new Error();
        current.current = body;
        setConfig(body);
      })
      .catch(() => {
        if (valid) setError(t('botDefaults.wecom.configLoadFailed'));
      });
    return () => {
      valid = false;
      active.current = false;
    };
  }, [id]);
  function save(patch: WecomBotConfigurationPatch): Promise<void> {
    const version = epoch.current;
    const run = queue.current.catch(() => {}).then(async () => {
      if (version !== epoch.current) throw new Error(t('botDefaults.wecom.configSwitched'));
      const snapshot = current.current;
      if (!snapshot || snapshot.editable === false) throw new Error(t('botDefaults.wecom.configReadOnly'));
      const response = await sendJson(
        'PATCH',
        `/api/wecom/connections/${encodeURIComponent(id)}/config`,
        {
          revision: snapshot.revision,
          ...patch,
          ...(patch.native ? { native: { ...snapshot.native, ...patch.native } } : {}),
        },
        controlCsrfHeaders(),
      );
      const saved = response.ok
        && response.body.savedRestartRequired
        && response.body.config
        && typeof response.body.config.revision === 'string';
      if (!saved) throw new Error(t('botDefaults.wecom.configSaveFailed'));
      if (version === epoch.current && active.current) {
        current.current = response.body.config;
        setConfig(response.body.config);
        setError(undefined);
        onSaved?.();
      }
    });
    queue.current = run;
    return run;
  }
  return { config, error, save, getSnapshot: () => current.current };
}

/** Each profile owns its request adapter, so selecting another provider cannot
 * redirect requests belonging to a mounted Lark profile. */
export const BotProfileRequestContext = createContext<typeof sendJson>(sendJson);

/** 共享区块写的 `/api/bots/:id/<operation>` 请求体 → 企业微信配置补丁（operation 取 URL 最后一段）。 */
export function wecomProfilePatch(operation: string, body: any, current?: WecomBotConfiguration): WecomBotConfigurationPatch {
  const b = body ?? {};
  if (operation === 'agent') {
    const { cliId, model, replaceCliSelection, ...botConfig } = b;
    for (const key of ['reasoningEffort', 'serviceTier', 'dshRuntime', 'turnTimeoutMs', 'modelBackendVariant']) {
      if (botConfig[key] === '') botConfig[key] = null;
    }
    return { cli: cliId, model, replaceCliSelection, botConfig };
  }
  if (operation === 'long-task-reminder') return { botConfig: { longTaskReminder: b } };
  if (operation === 'session-owner-reminder') return { botConfig: { sessionOwnerReminder: b } };
  if (operation === 'command-triggers') return { commandTriggers: b };
  if (operation === 'custom-passthrough') {
    return { botConfig: { customPassthroughCommands: parseCustomPassthroughInput(b.customPassthroughCommands ?? '') } };
  }
  if (operation === 'card-prefs') {
    const botConfig = { ...b };
    let sessionMode: WecomBotConfiguration['sessionMode'];
    // 会话模式的三项随卡片偏好一起提交，但在企业微信配置里单独存放。
    if (['p2pMode', 'regularGroupReplyMode', 'regularGroupMentionMode'].some(key => Object.hasOwn(botConfig, key))) {
      sessionMode = { p2pMode: 'chat', regularGroupReplyMode: 'user', regularGroupMentionMode: 'never', ...current?.sessionMode };
      for (const key of ['p2pMode', 'regularGroupReplyMode', 'regularGroupMentionMode'] as const) {
        if (Object.hasOwn(botConfig, key)) {
          (sessionMode as any)[key] = botConfig[key];
          delete botConfig[key];
        }
      }
    }
    const existing = current?.botConfig?.codexBrowser as Record<string, unknown> | undefined;
    if (b.codexBrowser !== undefined) {
      botConfig.codexBrowser = b.codexBrowser ? { ...existing, enabled: true, family: existing?.family ?? 'chrome' } : null;
    }
    if (b.codexBrowserAutoApproveOrigins !== undefined) {
      delete botConfig.codexBrowserAutoApproveOrigins;
      botConfig.codexBrowser = {
        ...existing,
        enabled: true,
        family: existing?.family ?? 'chrome',
        autoApproveOrigins: b.codexBrowserAutoApproveOrigins,
      };
    }
    return { botConfig, ...(sessionMode ? { sessionMode } : {}) };
  }
  if (operation === 'feedback') {
    return { botConfig: { feedback: typeof b.feedback === 'string' ? JSON.parse(b.feedback) : b.feedback } };
  }
  if (operation === 'brand-label') return { botConfig: { brandLabel: b.brandLabel } };
  if (operation === 'herdr' || operation === 'riff') {
    return { botConfig: { [operation]: b[operation] ? JSON.parse(b[operation]) : null } };
  }
  if (operation === 'backend-type') return { backend: b.backendType || 'tmux' };
  if (operation === 'working-dir-mode') {
    return {
      workingDirectory: b.workingDir,
      botConfig: { defaultWorkingDir: b.workingDir, defaultWorkingDirAutoWorktree: b.autoWorktree },
    };
  }
  if (operation === 'role') return { role: { content: b.role, injectMode: b.injectMode } };
  if (operation === 'sandbox') {
    return { botConfig: { sandbox: b.mode, ...(b.scratchStorage ? { scratchStorage: b.scratchStorage } : {}) } };
  }
  if (operation === 'sandbox-paths') return { botConfig: { sandboxPaths: b } };
  if (operation === 'sandbox-network-policy') return { botConfig: { sandboxNetworkPolicy: b.policy } };
  if (operation === 'read-isolation') return { botConfig: { readIsolation: b.enabled } };
  if (operation === 'startup-commands') {
    return { botConfig: { startupCommands: parseStartupCommandsInput(b.startupCommands ?? '') } };
  }
  // 其余区块各写 botConfig 里的一个同名字段。
  const fields: Record<string, string> = {
    'skill-injection': 'skillInjection',
    'archive-codex': 'archiveCodex',
    'codex-auth-sync': 'codexAuthSync',
    'max-live-workers': 'maxLiveWorkers',
    'idle-suspend-minutes': 'idleSuspendMinutes',
    'prompt-cache': 'promptCache',
    'startup-commands': 'startupCommands',
    'launch-shell': 'launchShell',
    'prompt-injection': 'promptInjection',
    'no-progress-notify': 'noProgressNotify',
  };
  const key = fields[operation];
  if (key) return { botConfig: { [key]: b[key] } };
  throw new Error(t('botDefaults.wecom.settingUnsupported'));
}
