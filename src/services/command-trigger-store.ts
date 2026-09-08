/**
 * 免@ 斜杠命令（commandTriggers）的写入路径 —— dashboard PUT 的落盘层。
 *
 * 与运行期判定（command-trigger.ts）共用同一份保留命令表：写时拒绝 + 运行期
 * fail-closed 两道锁必须同源，否则手改 bots.json 与 dashboard 保存会给出不同答案。
 */
import { getBot, type CommandTriggerConfig } from '../bot-registry.js';
import { rmwBotEntry } from './config-store.js';
import { normalizeCommandTriggers, normalizeTriggerEntry, MAX_COMMAND_TRIGGER_PROMPT_BYTES } from './command-trigger-normalize.js';
import { reservedCommandKind, type ReservedCommandKind } from './command-trigger.js';

export interface CommandTriggerConflict {
  cmd: string;
  kind: ReservedCommandKind;
}

export type CommandTriggerValidation =
  | { ok: true }
  | { ok: false; reason: 'invalid_command'; invalid: string[] }
  | { ok: false; reason: 'reserved_command'; conflicts: CommandTriggerConflict[] }
  | { ok: false; reason: 'prompt_too_large'; oversized: string[] }
  | { ok: false; reason: 'commands_required' };

/**
 * 校验一份待保存的命令表。
 *
 * @param extraPassthrough  `resolvePassthroughCommands(larkAppId)` —— 按该 bot 的
 *   实际 CLI 求值的透传集。前端不能自带命令表（adapter 会追加、无裸输入面的 CLI
 *   会清空，复制一份必然过期），所以冲突判定只在服务端做。
 */
export function validateCommandTriggerUpdate(
  raw: { enabled?: boolean; commands?: unknown },
  extraPassthrough?: ReadonlySet<string>,
): CommandTriggerValidation {
  const items = Array.isArray(raw.commands) ? raw.commands : [];
  const invalid: string[] = [];
  const oversized: string[] = [];
  const commands: string[] = [];
  for (const item of items) {
    const entry = normalizeTriggerEntry(item);
    if (!entry) {
      const label = typeof item === 'string'
        ? item.trim()
        : typeof (item as any)?.cmd === 'string' ? String((item as any).cmd).trim() : '';
      if (label) invalid.push(label);
      continue;
    }
    // normalizeTriggerEntry 会把超长模板截断落盘；写入路径不该悄悄截，直接拒，
    // 让人知道模板没存全。
    const rawPrompt = typeof (item as any)?.prompt === 'string' ? (item as any).prompt.trim() : '';
    if (rawPrompt && Buffer.byteLength(rawPrompt, 'utf-8') > MAX_COMMAND_TRIGGER_PROMPT_BYTES) {
      oversized.push(entry.cmd);
    }
    if (!commands.includes(entry.cmd)) commands.push(entry.cmd);
  }
  if (invalid.length > 0) return { ok: false, reason: 'invalid_command', invalid };
  if (oversized.length > 0) return { ok: false, reason: 'prompt_too_large', oversized };
  const conflicts = commands
    .map(cmd => ({ cmd, kind: reservedCommandKind(cmd, extraPassthrough) }))
    .filter((c): c is CommandTriggerConflict => c.kind !== null);
  if (conflicts.length > 0) return { ok: false, reason: 'reserved_command', conflicts };
  // 开启但一条命令都没有是死的 ON 态（normalizeCommandTriggers 会归一成 undefined，
  // 保存后开关会自己弹回去）——直接拒，别让人以为存上了。
  if (raw.enabled === true && commands.length === 0) return { ok: false, reason: 'commands_required' };
  return { ok: true };
}

export function getCommandTriggerConfig(larkAppId: string): CommandTriggerConfig | null {
  try {
    return getBot(larkAppId).config.commandTriggers ?? null;
  } catch {
    return null;
  }
}

/**
 * 落盘。命令表为空 → 删除整个条目（bots.json 保持干净）；关闭但仍有命令 → 作为
 * 草稿保留（与 messageListener / substituteMode 同款，开关能来回扳而不用重敲）。
 */
export async function updateCommandTriggerConfig(
  larkAppId: string,
  patch: { enabled?: boolean; commands?: unknown; chats?: unknown; excludedChats?: unknown },
  extraPassthrough?: ReadonlySet<string>,
): Promise<{ ok: true; config: CommandTriggerConfig | null } | { ok: false; reason: string; detail?: unknown }> {
  let bot;
  try { bot = getBot(larkAppId); } catch { return { ok: false, reason: 'bot_not_registered' }; }

  const validation = validateCommandTriggerUpdate(patch, extraPassthrough);
  if (!validation.ok) {
    return {
      ok: false,
      reason: validation.reason,
      detail: validation.reason === 'reserved_command' ? validation.conflicts
        : validation.reason === 'invalid_command' ? validation.invalid
        : validation.reason === 'prompt_too_large' ? validation.oversized
        : undefined,
    };
  }

  const normalized = normalizeCommandTriggers(patch);

  const result = await rmwBotEntry<CommandTriggerConfig | null>(larkAppId, (entry) => {
    if (!normalized) {
      delete entry.commandTriggers;
      return { write: true, result: null };
    }
    entry.commandTriggers = normalized;
    return { write: true, result: normalized };
  });
  if (!result.ok) return { ok: false, reason: result.reason };

  bot.config.commandTriggers = normalized;
  return { ok: true, config: result.result };
}

/** 单个群的开/关：写进 chats 白名单 / excludedChats 黑名单。
 *
 *  语义与「所有群」模式共存：
 *   • 白名单模式（chats 非空）—— 开=加进 chats，关=从 chats 移除。
 *   • 所有群模式（chats 为空）—— 开=从 excludedChats 移除，关=加进 excludedChats。
 *  这样群页的开关在两种模式下都是「所见即所得」，不会悄悄把全局范围改掉。 */
export async function setCommandTriggerChatEnabled(
  larkAppId: string,
  chatId: string,
  enabled: boolean,
): Promise<{ ok: true; config: CommandTriggerConfig | null } | { ok: false; reason: string }> {
  let bot;
  try { bot = getBot(larkAppId); } catch { return { ok: false, reason: 'bot_not_registered' }; }
  const current = bot.config.commandTriggers;
  if (!current) return { ok: false, reason: 'not_configured' };

  const next: CommandTriggerConfig = {
    ...current,
    chats: current.chats ? [...current.chats] : undefined,
    excludedChats: current.excludedChats ? [...current.excludedChats] : undefined,
  };
  const scopeIsAllowList = !!next.chats?.length;
  if (scopeIsAllowList) {
    const set = new Set(next.chats);
    if (enabled) set.add(chatId); else set.delete(chatId);
    next.chats = [...set].sort();
    // 白名单被清空会静默变成「所有群」——语义反转，必须挡住。
    if (next.chats.length === 0) return { ok: false, reason: 'last_chat_in_scope' };
  } else {
    const set = new Set(next.excludedChats ?? []);
    if (enabled) set.delete(chatId); else set.add(chatId);
    next.excludedChats = set.size > 0 ? [...set].sort() : undefined;
  }

  const normalized = normalizeCommandTriggers(next);
  const result = await rmwBotEntry<CommandTriggerConfig | null>(larkAppId, (entry) => {
    if (!normalized) {
      delete entry.commandTriggers;
      return { write: true, result: null };
    }
    entry.commandTriggers = normalized;
    return { write: true, result: normalized };
  });
  if (!result.ok) return { ok: false, reason: result.reason };
  bot.config.commandTriggers = normalized;
  return { ok: true, config: result.result };
}
