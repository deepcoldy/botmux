import { parseSandboxNetworkPolicy } from '../core/sandbox-network-policy.js';
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
  // replyDelivery=transcript × cursor × scratch：host 侧转写桥读不到 scratch 全根
  // COW 的 merged overlay mirror，开 transcript 信封会让模型不调 send 而整轮静默。
  // 放全局不变量（而非只在 replyDelivery 写入门禁）是因为这条边还能从另外两个写者
  // 进入：cliId 切换（codex+transcript+scratch 合法 → 切到 cursor）与 sandbox 切换
  // （cursor+transcript → scratch），两者都经 rmwBotEntry 落盘，在此一处判死。
  // 注意：这里只能看持久化字段——机器级 BOTMUX_SANDBOX 不 materialize 进 entry，
  // 那条边由 core/reply-delivery 的运行时回落与 worker spawnCli 的 resolved-mode
  // 复核负责。
  if (entry.replyDelivery === 'transcript'
      && entry.cliId === 'cursor'
      && entry.sandbox === 'scratch') {
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
