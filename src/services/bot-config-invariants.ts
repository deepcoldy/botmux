import { parseSandboxNetworkPolicy } from '../core/sandbox-network-policy.js';
// 直接依赖叶子模块，勿改从 core/reply-delivery 取：reply-delivery import
// bot-registry，而 bot-registry 经 turn-reply-card → card-handler →
// bot-config-store → config-store 回到本文件，取道 reply-delivery 会闭合环，
// bun 在模块链接期报 "Export named 'resolveReplyDelivery' not found"
// （CI bun-test test/summary-command-window.test.ts 实测）。
import { supportsTranscriptReplyDeliveryForBot, zeroPromptInjectionUnsupportedReason } from '../core/zero-prompt-support.js';
import { supportsTranscriptReplyDelivery } from '../services/structured-bridge-clis.js';
export type BotConfigInvariantError =
  | 'codex_browser_requires_codex_app'
  | 'codex_browser_config_conflict'
  | 'existing_app_server_sandbox_conflict'
  | 'invalid_sandbox_network_policy'
  | 'reply_delivery_unsupported'
  | 'sandbox_network_policy_requires_local_pty_oncall'
  | 'zero_prompt_unsupported';

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
  // replyDelivery=transcript × scratch × 「本来支持 transcript、scratch 使其失效」
  // 的 CLI：scratch 全根 COW 把 CLI 写的转写（cursor 的 agent-transcript mirror、
  // doubao 的 agent_mode 会话树）留在 merged overlay，host 侧桥读不到，开 transcript
  // 信封会让模型不调 send 而整轮静默。放全局不变量（而非只在 replyDelivery 写入门禁）
  // 是因为这条边还能从另外两个写者进入：cliId 切换（codex+transcript+scratch 合法 →
  // 切到 cursor/doubao）与 sandbox 切换（cursor/doubao+transcript → scratch），两者都
  // 经 rmwBotEntry 落盘，在此一处判死。
  // 两个收窄条件都必须留：
  // - sandbox === 'scratch'：非 scratch 下带着显式 transcript 落盘的无采集 CLI
  //  （如从 claude-code 切 cliId 到达）运行时回落 send，不静默，master 历来放行；
  // - supportsTranscriptReplyDelivery(cliId)：opencode/codex-app/antigravity 这类
  //  「从来没有」转写采集的 CLI，即使在 scratch 下也只是回落 send，不是 scratch 让它
  //  失效。master 上 {codex,scratch,transcript} 切 cliId 到它们不拦，存量 bots.json
  //  可能有此形状；把它们也算进来会让该 bot 的任何字段编辑都被
  //  reply_delivery_unsupported 锁死（与静默无关，无收益）。
  // 判据复用 core/reply-delivery 的两个谓词，CLI 名单只有那一份。
  // 注意：未配置的缺省值（如 doubao 缺省 transcript）不在 entry.replyDelivery 里，
  // 缺省组合由运行时回落 send 处理；机器级 BOTMUX_SANDBOX 不 materialize 进 entry，
  // 那条边由运行时回落与 worker spawnCli 的 resolved-mode 复核负责。
  if (entry.replyDelivery === 'transcript'
      && entry.sandbox === 'scratch'
      && supportsTranscriptReplyDelivery(entry.cliId)
      && !supportsTranscriptReplyDeliveryForBot(entry.cliId, { sandbox: 'scratch' })) {
    return 'reply_delivery_unsupported';
  }
  // promptInjection=none × scratch × 「scratch 使零注入失效」的 CLI（cursor/doubao/antigravity）：
  // worker spawnCli 会拒绝启动。同上，sandbox 切换与 cliId 切换经 rmwBotEntry 落盘、不过
  // applyConfigField 的零注入门禁。只拦 scratch 致因：切回非 scratch 或关掉零注入即可修复；
  // CLI 本身不支持零注入的存量 entry 不在此锁。
  // 后端维度同样有写盘缺口、不在此锁：PUT /api/bot-backend-type（zmx 在可编辑后端名单）
  // 与 PUT /api/bot-agent（entry 已带 backendType 覆盖时切到 antigravity）也直走
  // rmwBotEntry、不过 applyConfigField，可落盘 antigravity × zmx（远端后端同形）；单看
  // entry 解析不出生效后端（daemon 默认 + CLI 配对），由 worker spawnCli 权威闸
  // fail-closed 拒启动。跟踪 issue #3064。
  if (entry.promptInjection === 'none'
      && entry.sandbox === 'scratch'
      && zeroPromptInjectionUnsupportedReason(entry.cliId, { sandbox: 'scratch' }) === 'scratch_unsupported_for_cli') {
    return 'zero_prompt_unsupported';
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
