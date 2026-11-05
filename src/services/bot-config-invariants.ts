import { parseSandboxNetworkPolicy } from '../core/sandbox-network-policy.js';
import { supportsTranscriptReplyDeliveryForBot } from '../core/reply-delivery.js';
export type BotConfigInvariantError =
  | 'codex_browser_requires_codex_app'
  | 'codex_browser_config_conflict'
  | 'existing_app_server_sandbox_conflict'
  | 'invalid_sandbox_network_policy'
  | 'reply_delivery_unsupported'
  | 'sandbox_network_policy_requires_local_pty_oncall';

function codexBrowserEnabled(entry: any): boolean {
  return entry?.codexBrowser === true
    || (entry?.codexBrowser && typeof entry.codexBrowser === 'object' && entry.codexBrowser.enabled === true);
}

/** Any local sandbox mode engaged (legacy boolean true or the tri-state
 *  oncall/scratch strings — a false/"off" string is not active). */
function sandboxEngaged(entry: any): boolean {
  return entry?.sandbox === true || entry?.sandbox === 'oncall' || entry?.sandbox === 'scratch';
}

/** Cross-field invariants shared by every bots.json writer. */
export function botConfigInvariantError(entry: any): BotConfigInvariantError | undefined {
  if (!entry || typeof entry !== 'object') return undefined;
  if (entry.sandboxNetworkPolicy !== undefined) {
    try { parseSandboxNetworkPolicy(entry.sandboxNetworkPolicy); } catch { return 'invalid_sandbox_network_policy'; }
    if ((entry.sandbox !== true && entry.sandbox !== 'oncall') || (entry.backendType ?? 'pty') !== 'pty' || entry.existingAppServer) return 'sandbox_network_policy_requires_local_pty_oncall';
  }
  if (codexBrowserEnabled(entry)) {
    if (entry.cliId !== 'codex-app') return 'codex_browser_requires_codex_app';
    if (entry.existingAppServer || sandboxEngaged(entry) || entry.readIsolation === true) {
      return 'codex_browser_config_conflict';
    }
  }
  if (entry.existingAppServer && (sandboxEngaged(entry) || entry.readIsolation === true)) {
    return 'existing_app_server_sandbox_conflict';
  }
  // replyDelivery=transcript × 无宿主侧转写采集的 CLI/沙箱组合：scratch 全根 COW 把
  // CLI 写的转写（cursor 的 agent-transcript mirror、doubao 的 agent_mode 会话树）
  // 留在 merged overlay，host 侧桥读不到，开 transcript 信封会让模型不调 send 而整轮
  // 静默。放全局不变量（而非只在 replyDelivery 写入门禁）是因为这条边还能从另外两个
  // 写者进入：cliId 切换（codex+transcript+scratch 合法 → 切到 cursor/doubao）与
  // sandbox 切换（cursor/doubao+transcript → scratch），两者都经 rmwBotEntry 落盘，
  // 在此一处判死。判据直接复用 core/reply-delivery 的能力闸，CLI 名单只有那一份。
  // 注意：这里只能看持久化字段——未配置的缺省值（如 doubao 缺省 transcript）不在
  // entry.replyDelivery 里，缺省组合由运行时回落 send 处理，不能在这里拒写；机器级
  // BOTMUX_SANDBOX 不 materialize 进 entry，那条边由运行时回落与 worker spawnCli 的
  // resolved-mode 复核负责。
  if (entry.replyDelivery === 'transcript'
      && !supportsTranscriptReplyDeliveryForBot(entry.cliId, { sandbox: entry.sandbox })) {
    return 'reply_delivery_unsupported';
  }
  return undefined;
}

/**
 * Validate only entries changed by this write. An unrelated invalid legacy
 * entry must not prevent an operator from repairing or editing another bot.
 */
export function assertChangedBotConfigInvariants(previous: any[], next: any[]): void {
  for (let index = 0; index < next.length; index++) {
    const entry = next[index];
    const previousEntry = entry?.larkAppId
      ? previous.find(candidate => candidate?.larkAppId === entry.larkAppId)
      : previous[index];
    if (previousEntry !== undefined && JSON.stringify(previousEntry) === JSON.stringify(entry)) continue;
    const error = botConfigInvariantError(entry);
    if (error) throw new Error(error);
  }
}
