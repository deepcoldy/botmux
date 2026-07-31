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
export const DAEMON_COMMANDS = new Set(['/close', '/restart', '/status', '/help', '/cd', '/repo', '/rename', '/schedule', '/role', '/botconfig', '/skills', '/pair', '/login', '/adopt', '/detach', '/disconnect', '/oncall', '/group', '/g', '/relay', '/card', '/term', '/list-slash-command', '/slash', '/subscribe-lark-doc', '/watch-comment', '/vc', '/insight', '/dashboard', '/vc-auth']);

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
  //      Claude Code(2.1.220+) / Seed / Relay 原生支持 /effort，Codex 亦有 reasoning
  //      effort；未来别的 CLI 补上后零改动自动生效，无需再逐个 adapter 加。
  //   ② 全局集合刻意不带「空 topic 冷启动」能力（那只认 adapter 层的
  //      defaultPassthroughCommands，见 isInitialSessionPassthrough）——/effort 是
  //      「调档」而非「开一段工作」的命令，空话题里单发 /effort 不应凭空拉起会话。
  //      对照 /goal（开启目标工作）仍留在 adapter 层，保留其冷启动语义。
  '/effort',
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
