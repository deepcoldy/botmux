/**
 * Shape normalization for `commandTriggers` — the per-bot "免@ 斜杠命令" config.
 *
 * Shared by the config loader (bot-registry) and the dashboard write path
 * (command-trigger-store), so a hand-edited bots.json and a dashboard PUT land
 * on byte-identical shapes. Type-only import from bot-registry keeps this a
 * leaf at runtime (same reason as substitute-mode-normalize).
 *
 * This layer is deliberately SHAPE-ONLY: it does not know which commands
 * botmux itself reserves (/close, /clear, …). That check needs the bot's
 * effective CLI and lives in command-trigger.ts, which both the dashboard
 * (write-time, with a human-readable reason) and the routing gate
 * (runtime, fail-closed) call.
 */
import type { CommandTriggerCommand, CommandTriggerConfig } from '../bot-registry.js';

/** Cap for one command's prompt template (same order as the listener prompt). */
export const MAX_COMMAND_TRIGGER_PROMPT_BYTES = 8 * 1024;

/**
 * Normalize one command token. A trigger entry is the BARE command word —
 * `/solve`, not `/solve <arg>`: arguments come from the message at runtime and
 * are never stored. Lowercased because Lark users type `/Solve` and the
 * daemon's own parser lowercases too (parseSlashCommandInvocation).
 *
 * `:` is allowed for plugin-scoped skills (`/myplugin:review`).
 */
export function normalizeTriggerCommand(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const v = raw.trim().toLowerCase();
  return /^\/[a-z0-9][a-z0-9_:-]*$/.test(v) ? v : undefined;
}

/**
 * One entry: a bare command plus the OPTIONAL prompt template that defines what
 * the agent should do when it fires. Accepts the shorthand string form so a
 * hand-written `"commands": ["/solve"]` still parses; storage is always the
 * object form, so downstream code has exactly one shape to handle.
 */
export function normalizeTriggerEntry(raw: unknown): CommandTriggerCommand | undefined {
  if (typeof raw === 'string') {
    const cmd = normalizeTriggerCommand(raw);
    return cmd ? { cmd } : undefined;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const rec = raw as Record<string, unknown>;
  const cmd = normalizeTriggerCommand(rec.cmd);
  if (!cmd) return undefined;
  const prompt = typeof rec.prompt === 'string' ? rec.prompt.trim() : '';
  if (!prompt) return { cmd };
  return {
    cmd,
    prompt: Buffer.byteLength(prompt, 'utf-8') > MAX_COMMAND_TRIGGER_PROMPT_BYTES
      ? truncateUtf8(prompt, MAX_COMMAND_TRIGGER_PROMPT_BYTES)
      : prompt,
  };
}

export function normalizeTriggerCommands(raw: unknown): CommandTriggerCommand[] {
  if (!Array.isArray(raw)) return [];
  const out: CommandTriggerCommand[] = [];
  for (const item of raw) {
    const entry = normalizeTriggerEntry(item);
    // First definition of a command wins; a duplicate cannot silently replace
    // an earlier template.
    if (entry && !out.some(e => e.cmd === entry.cmd)) out.push(entry);
  }
  return out;
}

function truncateUtf8(s: string, maxBytes: number): string {
  let used = 0;
  let out = '';
  for (const ch of s) {
    const n = Buffer.byteLength(ch, 'utf-8');
    if (used + n > maxBytes) break;
    out += ch;
    used += n;
  }
  return out;
}

function normalizeChatIdList(raw: unknown): string[] {
  return Array.isArray(raw)
    ? [...new Set(raw.map(String).map(s => s.trim()).filter(Boolean))]
    : [];
}

/**
 * Normalize the whole config, or undefined when there is nothing worth keeping.
 *
 * A DISABLED config with commands is a valid draft (kept so the dashboard
 * toggle can flip without retyping the list) — mirrors substituteMode and
 * messageListener drafts. An ENABLED config with no command is a dead ON state
 * and collapses to undefined.
 */
export function normalizeCommandTriggers(raw: unknown): CommandTriggerConfig | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const rec = raw as Record<string, unknown>;
  const commands = normalizeTriggerCommands(rec.commands);
  if (commands.length === 0) return undefined;
  const out: CommandTriggerConfig = { enabled: rec.enabled === true, commands };
  const chats = normalizeChatIdList(rec.chats);
  const excludedChats = normalizeChatIdList(rec.excludedChats);
  if (chats.length) out.chats = chats;
  if (excludedChats.length) out.excludedChats = excludedChats;
  return out;
}
