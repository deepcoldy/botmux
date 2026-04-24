/**
 * Oncall bindings — persist chat_id → default workingDir + owners into the
 * bot config JSON file, and keep the in-memory BotConfig in sync so events
 * pick up changes without a daemon restart.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { getBot, getLoadedConfigPath, type OncallChat } from '../bot-registry.js';
import { logger } from '../utils/logger.js';

function loadRawConfig(): { path: string; raw: any[] } {
  const path = getLoadedConfigPath();
  if (!path) throw new Error('Bot config path unknown — cannot persist oncall bindings');
  const raw = JSON.parse(readFileSync(path, 'utf-8'));
  if (!Array.isArray(raw)) throw new Error(`Config file is not a JSON array: ${path}`);
  return { path, raw };
}

function writeRawConfig(path: string, raw: any[]): void {
  writeFileSync(path, JSON.stringify(raw, null, 2) + '\n', 'utf-8');
}

function findEntryIndex(raw: any[], larkAppId: string): number {
  return raw.findIndex((e: any) => e?.larkAppId === larkAppId);
}

/**
 * Upsert an oncall binding. If the chat is already bound, only existing owners
 * can update the workingDir (ownerOpenId must be in owners). First-time bind
 * puts the caller into owners automatically.
 */
export function bindOncall(
  larkAppId: string,
  chatId: string,
  workingDir: string,
  ownerOpenId: string,
): { ok: true; entry: OncallChat; created: boolean } | { ok: false; reason: string } {
  const bot = getBot(larkAppId);
  const existingList = bot.config.oncallChats ?? [];
  const existing = existingList.find(c => c.chatId === chatId);
  if (existing && !existing.owners.includes(ownerOpenId)) {
    return { ok: false, reason: 'not_owner' };
  }

  const next: OncallChat = existing
    ? { ...existing, workingDir }
    : { chatId, workingDir, owners: [ownerOpenId] };

  const { path, raw } = loadRawConfig();
  const idx = findEntryIndex(raw, larkAppId);
  if (idx < 0) return { ok: false, reason: 'bot_not_in_config' };

  const cur: OncallChat[] = Array.isArray(raw[idx].oncallChats) ? raw[idx].oncallChats : [];
  const curIdx = cur.findIndex((c: OncallChat) => c.chatId === chatId);
  if (curIdx >= 0) cur[curIdx] = next; else cur.push(next);
  raw[idx].oncallChats = cur;
  writeRawConfig(path, raw);

  // Keep in-memory config in sync
  const inMem = (bot.config.oncallChats ??= []);
  const memIdx = inMem.findIndex(c => c.chatId === chatId);
  if (memIdx >= 0) inMem[memIdx] = next; else inMem.push(next);

  logger.info(`[oncall:${larkAppId}] bind chat=${chatId} dir=${workingDir} owner=${ownerOpenId}`);
  return { ok: true, entry: next, created: !existing };
}

export function unbindOncall(
  larkAppId: string,
  chatId: string,
  ownerOpenId: string,
): { ok: true } | { ok: false; reason: string } {
  const bot = getBot(larkAppId);
  const existing = bot.config.oncallChats?.find(c => c.chatId === chatId);
  if (!existing) return { ok: false, reason: 'not_bound' };
  if (!existing.owners.includes(ownerOpenId)) return { ok: false, reason: 'not_owner' };

  const { path, raw } = loadRawConfig();
  const idx = findEntryIndex(raw, larkAppId);
  if (idx < 0) return { ok: false, reason: 'bot_not_in_config' };
  const cur: OncallChat[] = Array.isArray(raw[idx].oncallChats) ? raw[idx].oncallChats : [];
  raw[idx].oncallChats = cur.filter((c: OncallChat) => c.chatId !== chatId);
  writeRawConfig(path, raw);

  if (bot.config.oncallChats) {
    bot.config.oncallChats = bot.config.oncallChats.filter(c => c.chatId !== chatId);
  }
  logger.info(`[oncall:${larkAppId}] unbind chat=${chatId} by=${ownerOpenId}`);
  return { ok: true };
}

export function getOncallStatus(larkAppId: string, chatId: string): OncallChat | undefined {
  return getBot(larkAppId).config.oncallChats?.find(c => c.chatId === chatId);
}
