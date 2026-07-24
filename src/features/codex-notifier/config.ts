import {
  readGlobalConfig,
  type CodexNotifierNotifyWhen,
} from '../../global-config.js';

export interface ResolvedCodexNotifierConfig {
  enabled: boolean;
  targetBotAppId?: string;
  notifyWhen: CodexNotifierNotifyWhen;
}

/** 读取机器级 Codex 完成通知配置；缺省严格关闭。 */
export function resolveCodexNotifierConfig(): ResolvedCodexNotifierConfig {
  const config = readGlobalConfig().codexNotifier;
  return {
    enabled: config?.enabled === true,
    ...(config?.targetBotAppId ? { targetBotAppId: config.targetBotAppId } : {}),
    notifyWhen: config?.notifyWhen === 'always' ? 'always' : 'locked_only',
  };
}
