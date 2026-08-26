/**
 * Passthrough / daemon command sets — extracted into a leaf module so both the
 * command router ({@link ../core/command-handler.js}) and the `/botconfig` config
 * store ({@link ../services/bot-config-store.js}) can share the normalization
 * without a circular import (command-handler already imports the config store).
 */

/**
 * Slash commands handled by the daemon itself (open a conversation / act on the
 * chat) rather than relayed to the CLI. Used both for routing and to reject
 * `customPassthroughCommands` entries that would shadow a daemon command.
 */
export const DAEMON_COMMANDS = new Set(['/close', '/restart', '/status', '/help', '/cd', '/repo', '/rename', '/schedule', '/role', '/botconfig', '/skills', '/pair', '/login', '/adopt', '/detach', '/disconnect', '/oncall', '/group', '/g', '/relay', '/fork', '/forklist', '/card', '/cot', '/term', '/list-slash-command', '/slash', '/subscribe-lark-doc', '/watch-comment', '/vc', '/insight', '/dashboard', '/vc-auth', '/issue']);

/**
 * Slash commands that are forwarded verbatim to the underlying CLI (e.g.
 * Claude Code's `/compact`, `/model`, `/usage`). The daemon does NOT handle
 * these — it just relays them to the worker via a raw_input IPC message,
 * bypassing the normal prompt-wrapping and bracketed-paste path so the CLI's
 * own slash-command parser sees them.
 */
export const PASSTHROUGH_COMMANDS = new Set([
  '/compact', '/model', '/clear', '/plugin', '/usage',
  '/new',
  // 只读 / 低副作用，飞书卡片里能直接吐文本：
  '/context', '/cost', '/mcp', '/diff',
  '/code-review', '/security-review', '/review',
  // Codex：/btw 向当前会话追加一条旁注/引导消息
  '/btw',
  // 推理强度调档。放全局（而非某个 adapter 的 defaultPassthroughCommands）是刻意的：
  //   ① 这里的命令本就是「尽力透传」——/plugin /mcp /btw 也并非所有 CLI 都支持，
  //      CLI 认得就生效、认不得顶多回一句 unknown-command（不崩溃 / 不损坏 / 不泄露）。
  //      Claude Code(2.1.220+) / Seed / Relay 原生支持 /effort。Codex 的 effort
  //      通过 model_reasoning_effort / 原生模型菜单设置，不依赖此命令；误透传只会
  //      得到 unknown-command，不会改写 Codex 配置。
  //   ② 全局集合刻意不带「空 topic 冷启动」能力（那只认 adapter 层的
  //      defaultPassthroughCommands，见 isInitialSessionPassthrough）——/effort 是
  //      「调档」而非「开一段工作」的命令，空话题里单发 /effort 不应凭空拉起会话。
  //      对照 /goal（开启目标工作）仍留在 adapter 层，保留其冷启动语义。
  '/effort',
  // Codex 原生 /fast 切换 service_tier。放全局 passthrough（同 /effort，非 adapter
  // 冷启动层）：botmux 不接管,只把命令透传给 Codex 让它自己切档,卡片只读展示当前
  // 档位徽标。刻意不进 adapter defaultPassthroughCommands —— owner 政策是空话题里
  // 单发 /fast 不该凭空拉起会话（它是「调档」非「开一段工作」）。别的 CLI 认不得
  // 顶多回 unknown-command,不崩溃 / 不泄露。
  //
  // ⚠️ 能力边界（只对原生 paste TUI 成立）：passthrough 是往 CLI 敲字（PTY write）。
  // Codex RPC 模式的 pane 是纯 viewer、无 terminal input（turn 走 JSON-RPC）,
  // /fast 敲进去到不了 app-server;codex+Riff 后端把文本+回车当两次远端 task。这两
  // 种形态下 /fast 不会真正切档,徽标也只反映 rollout 实际记录（RPC app-server 仍写
  // rollout;Riff 无 rollout/tier 概念,tracker 只在 structuredBridgeIsCodex 且有
  // rollout 时 bind,天然 fail-closed 不显示徽标）。此处仅登记 passthrough 语义,不
  // 声称在非 paste 形态下能切档。
  '/fast',
]);

/**
 * Shape of a slash-command token: leading `/`, an alphanumeric first char, then
 * `[a-z0-9:_-]`. Shared by passthrough normalization AND the grant-restriction
 * gate ({@link ../daemon.js}'s `grantRestrictedSlashCommandText`) so a custom
 * passthrough command can't slip past the restriction check via a shape one
 * recognizes but the other doesn't (e.g. `/foo:bar`, `/1cmd` — colon / leading
 * digit). Keep the two in lockstep: anything passthrough accepts must also be
 * recognized as a command by the restriction gate.
 */
export const SLASH_COMMAND_SHAPE = /^\/[a-z0-9][a-z0-9:_-]*$/;

/**
 * Normalize a single custom passthrough command: lowercase, must match the
 * slash-command shape, and must not shadow a daemon command (passthrough is
 * checked BEFORE DAEMON_COMMANDS in the router). Returns null for anything that
 * doesn't qualify. Does NOT prepend the leading `/` — callers that accept bare
 * user input should add it first (see {@link parseCustomPassthroughInput}).
 */
export function normalizePassthroughCommand(cmd: unknown): string | null {
  if (typeof cmd !== 'string') return null;
  const normalized = cmd.trim().toLowerCase();
  if (!SLASH_COMMAND_SHAPE.test(normalized)) return null;
  if (DAEMON_COMMANDS.has(normalized)) return null;
  return normalized;
}

/**
 * Parse free-text dashboard / `/botconfig` input (comma, space or newline
 * separated) into a normalized, deduped custom passthrough command list. The
 * leading `/` is optional per token (so users can type `goal export` or
 * `/goal, /export`); illegal and daemon-shadowing tokens are dropped. Mirrors
 * the normalization {@link ../bot-registry.js}'s parseBotConfigsFromText applies
 * when loading bots.json, so a round-trip through the card is stable.
 */
export function parseCustomPassthroughInput(raw: string): string[] {
  const out: string[] = [];
  for (const tok of String(raw ?? '').split(/[\s,]+/)) {
    const trimmed = tok.trim();
    if (!trimmed) continue;
    const withSlash = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
    const norm = normalizePassthroughCommand(withSlash);
    if (norm) out.push(norm);
  }
  return [...new Set(out)];
}

/**
 * Parse free-text input for `canTalkDaemonCommands` — the inverse filter of
 * {@link parseCustomPassthroughInput}: after the same normalization (lowercase,
 * auto `/`), keep ONLY entries that ARE daemon commands. The default stringList
 * parser (parseCustomPassthroughInput) rejects every daemon command, so wiring
 * it to this field would silently drop all valid input.
 */
export function parseCanTalkDaemonCommandsInput(raw: string): string[] {
  const out: string[] = [];
  for (const tok of String(raw ?? '').split(/[\s,]+/)) {
    const trimmed = tok.trim().toLowerCase();
    if (!trimmed) continue;
    const withSlash = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
    if (DAEMON_COMMANDS.has(withSlash)) out.push(withSlash);
  }
  return [...new Set(out)];
}
