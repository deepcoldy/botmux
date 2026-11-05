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
  // replyDelivery=transcript × scratch × 无宿主侧转写采集的 CLI：scratch 全根 COW 把
  // CLI 写的转写（cursor 的 agent-transcript mirror、doubao 的 agent_mode 会话树）
  // 留在 merged overlay，host 侧桥读不到，开 transcript 信封会让模型不调 send 而整轮
  // 静默。放全局不变量（而非只在 replyDelivery 写入门禁）是因为这条边还能从另外两个
  // 写者进入：cliId 切换（codex+transcript+scratch 合法 → 切到 cursor/doubao）与
  // sandbox 切换（cursor/doubao+transcript → scratch），两者都经 rmwBotEntry 落盘，
  // 在此一处判死。
  // 只判 scratch：非 scratch 下不支持 transcript 的 CLI（opencode / codex-app /
  // antigravity…）若已带着显式 transcript 落盘（如从 claude-code 切 cliId 到达），
  // 运行时会回落 send，不静默——master 历来放行这类 entry，这里扩大到「任何不支持的
  // CLI」会把该 bot 的任何字段编辑全部锁死在看不懂的 reply_delivery_unsupported 上。
  // 判据复用 core/reply-delivery 的能力闸，scratch 拒绝名单只有那一份。
  // 注意：未配置的缺省值（如 doubao 缺省 transcript）不在 entry.replyDelivery 里，
  // 缺省组合由运行时回落 send 处理；机器级 BOTMUX_SANDBOX 不 materialize 进 entry，
  // 那条边由运行时回落与 worker spawnCli 的 resolved-mode 复核负责。
  if (entry.replyDelivery === 'transcript'
      && entry.sandbox === 'scratch'
      && !supportsTranscriptReplyDeliveryForBot(entry.cliId, { sandbox: 'scratch' })) {
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
