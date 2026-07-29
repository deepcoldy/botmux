/**
 * Per-bot, per-chat startup commands.
 *
 * `/group` is intentionally sessionless, so chat-scoped settings selected at
 * creation time cannot live on a (non-existent) Session record. Keep them in a
 * small durable store instead; worker-pool merges them after bot defaults when
 * the chat's first real session is spawned. Appending is deliberate: a
 * chat-specific `/effort max` must win over a bot-wide `/effort high`.
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config.js';
import { normalizeStartupCommandList } from '../core/startup-commands.js';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { withFileLockSync } from '../utils/file-lock.js';

interface ChatStartupCommandsStore {
  byBot: Record<string, Record<string, string[]>>;
}

const STORE_FILE = 'chat-startup-commands.json';

function storePath(): string {
  return join(config.session.dataDir, STORE_FILE);
}

function emptyStore(): ChatStartupCommandsStore {
  return { byBot: {} };
}

function normalizeStore(raw: unknown): ChatStartupCommandsStore {
  const normalized = emptyStore();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return normalized;
  const byBot = (raw as Record<string, unknown>).byBot;
  if (!byBot || typeof byBot !== 'object' || Array.isArray(byBot)) return normalized;

  for (const [appId, chats] of Object.entries(byBot)) {
    if (!appId.trim() || !chats || typeof chats !== 'object' || Array.isArray(chats)) continue;
    const normalizedChats: Record<string, string[]> = {};
    for (const [chatId, commands] of Object.entries(chats)) {
      if (!chatId.trim()) continue;
      const list = normalizeStartupCommandList(commands);
      if (list.length > 0) normalizedChats[chatId] = list;
    }
    if (Object.keys(normalizedChats).length > 0) normalized.byBot[appId] = normalizedChats;
  }
  return normalized;
}

function readStore(): ChatStartupCommandsStore {
  const fp = storePath();
  try {
    if (!existsSync(fp)) return emptyStore();
    return normalizeStore(JSON.parse(readFileSync(fp, 'utf-8')));
  } catch {
    return emptyStore();
  }
}

function writeStore(store: ChatStartupCommandsStore): void {
  atomicWriteFileSync(storePath(), `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
}

export function getChatStartupCommands(larkAppId: string, chatId: string | undefined): string[] {
  if (!larkAppId.trim() || !chatId?.trim()) return [];
  return readStore().byBot[larkAppId]?.[chatId] ?? [];
}

/** Replace (or clear) the startup commands for one bot in one chat. */
export function setChatStartupCommands(
  larkAppId: string,
  chatId: string,
  commands: unknown,
): string[] {
  if (!larkAppId.trim()) throw new Error('larkAppId is required');
  if (!chatId.trim()) throw new Error('chatId is required');
  const normalized = normalizeStartupCommandList(commands);
  mkdirSync(config.session.dataDir, { recursive: true, mode: 0o700 });

  return withFileLockSync(storePath(), () => {
    const store = readStore();
    if (normalized.length > 0) {
      store.byBot[larkAppId] ??= {};
      store.byBot[larkAppId][chatId] = normalized;
    } else {
      delete store.byBot[larkAppId]?.[chatId];
      if (store.byBot[larkAppId] && Object.keys(store.byBot[larkAppId]).length === 0) {
        delete store.byBot[larkAppId];
      }
    }
    writeStore(store);
    return normalized;
  });
}

/** Merge bot-wide defaults with chat-specific commands (chat commands last). */
export function resolveStartupCommands(
  larkAppId: string,
  chatId: string | undefined,
  botDefaults: unknown,
): string[] | undefined {
  const combined = normalizeStartupCommandList([
    ...normalizeStartupCommandList(botDefaults),
    ...getChatStartupCommands(larkAppId, chatId),
  ]);
  return combined.length > 0 ? combined : undefined;
}
