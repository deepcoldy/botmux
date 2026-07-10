import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config.js';
import { atomicWriteFileSync } from '../utils/atomic-write.js';

export interface SubstituteDirectChat {
  chatId: string;
  chatName?: string;
  targetName?: string;
  mode?: 'direct' | 'intervene';
  disclosure?: 'prefix' | 'none';
  interventionNotes?: string[];
  lastGroupMessageId?: string;
  dmToGroupMessageIds?: Record<string, string>;
  updatedAt: number;
}

export interface SubstituteDirectBinding {
  larkAppId: string;
  substituteOpenId: string;
  targetOpenId?: string;
  substituteUserId?: string;
  substituteUnionId?: string;
  targetName?: string;
  activeChatId?: string;
  chats: Record<string, SubstituteDirectChat>;
  updatedAt: number;
}

interface Store {
  bindings: Record<string, SubstituteDirectBinding>;
}

function filePath(): string {
  return join(config.session.dataDir, 'substitute-direct-bindings.json');
}

function key(larkAppId: string, substituteOpenId: string): string {
  return `${larkAppId}::${substituteOpenId}`;
}

function normalize(raw: unknown): Store {
  const bindings: Record<string, SubstituteDirectBinding> = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { bindings };
  const rec = raw as Record<string, unknown>;
  const rawBindings = rec.bindings;
  if (!rawBindings || typeof rawBindings !== 'object' || Array.isArray(rawBindings)) return { bindings };
  for (const [k, v] of Object.entries(rawBindings)) {
    if (!v || typeof v !== 'object' || Array.isArray(v)) continue;
    const b = v as Record<string, unknown>;
    if (typeof b.larkAppId !== 'string' || !b.larkAppId) continue;
    if (typeof b.substituteOpenId !== 'string' || !b.substituteOpenId) continue;
    const chats: Record<string, SubstituteDirectChat> = {};
    if (b.chats && typeof b.chats === 'object' && !Array.isArray(b.chats)) {
      for (const [chatId, rawChat] of Object.entries(b.chats)) {
        if (!rawChat || typeof rawChat !== 'object' || Array.isArray(rawChat)) continue;
        const c = rawChat as Record<string, unknown>;
        chats[chatId] = {
          chatId,
          chatName: typeof c.chatName === 'string' ? c.chatName : undefined,
          targetName: typeof c.targetName === 'string' ? c.targetName : undefined,
          mode: c.mode === 'intervene' ? 'intervene' : 'direct',
          disclosure: c.disclosure === 'none' ? 'none' : 'prefix',
          interventionNotes: Array.isArray(c.interventionNotes) ? c.interventionNotes.filter((x): x is string => typeof x === 'string') : undefined,
          lastGroupMessageId: typeof c.lastGroupMessageId === 'string' ? c.lastGroupMessageId : undefined,
          dmToGroupMessageIds: c.dmToGroupMessageIds && typeof c.dmToGroupMessageIds === 'object' && !Array.isArray(c.dmToGroupMessageIds)
            ? Object.fromEntries(Object.entries(c.dmToGroupMessageIds).filter((e): e is [string, string] => typeof e[0] === 'string' && typeof e[1] === 'string'))
            : undefined,
          updatedAt: typeof c.updatedAt === 'number' ? c.updatedAt : 0,
        };
      }
    } else if (typeof b.chatId === 'string' && b.chatId) {
      // Backward-compatible read of the short-lived single-binding shape.
      chats[b.chatId] = {
        chatId: b.chatId,
        chatName: typeof b.chatName === 'string' ? b.chatName : undefined,
        targetName: typeof b.targetName === 'string' ? b.targetName : undefined,
        mode: 'direct',
        disclosure: b.disclosure === 'none' ? 'none' : 'prefix',
        lastGroupMessageId: typeof b.lastGroupMessageId === 'string' ? b.lastGroupMessageId : undefined,
        updatedAt: typeof b.updatedAt === 'number' ? b.updatedAt : 0,
      };
    }
    if (Object.keys(chats).length === 0) continue;
    const activeChatId = typeof b.activeChatId === 'string' && chats[b.activeChatId]
      ? b.activeChatId
      : Object.values(chats).sort((a, b) => b.updatedAt - a.updatedAt)[0]?.chatId;
    bindings[k] = {
      larkAppId: b.larkAppId,
      substituteOpenId: b.substituteOpenId,
      targetOpenId: typeof b.targetOpenId === 'string' ? b.targetOpenId : b.substituteOpenId,
      substituteUserId: typeof b.substituteUserId === 'string' ? b.substituteUserId : undefined,
      substituteUnionId: typeof b.substituteUnionId === 'string' ? b.substituteUnionId : undefined,
      targetName: typeof b.targetName === 'string' ? b.targetName : undefined,
      activeChatId,
      chats,
      updatedAt: typeof b.updatedAt === 'number' ? b.updatedAt : 0,
    };
  }
  return { bindings };
}

function readStore(): Store {
  try {
    if (!existsSync(filePath())) return { bindings: {} };
    return normalize(JSON.parse(readFileSync(filePath(), 'utf-8')));
  } catch {
    return { bindings: {} };
  }
}

function writeStore(store: Store): void {
  atomicWriteFileSync(filePath(), JSON.stringify(store, null, 2) + '\n', { mode: 0o600 });
}

export function getSubstituteDirectBinding(
  larkAppId: string,
  substituteOpenId: string | undefined,
): SubstituteDirectBinding | undefined {
  if (!substituteOpenId) return undefined;
  return readStore().bindings[key(larkAppId, substituteOpenId)];
}

export function getActiveSubstituteDirectChat(
  larkAppId: string,
  substituteOpenId: string | undefined,
): SubstituteDirectChat | undefined {
  const binding = getSubstituteDirectBinding(larkAppId, substituteOpenId);
  if (!binding?.activeChatId) return undefined;
  return binding.chats[binding.activeChatId];
}

export function getSubstituteDirectChat(
  larkAppId: string,
  substituteOpenId: string | undefined,
  chatId: string | undefined,
): SubstituteDirectChat | undefined {
  if (!chatId) return undefined;
  return getSubstituteDirectBinding(larkAppId, substituteOpenId)?.chats[chatId];
}

export function getSubstituteDirectChatByTarget(
  larkAppId: string,
  target: { openId?: string; userId?: string; unionId?: string; name?: string } | undefined,
  chatId: string | undefined,
): { chat: SubstituteDirectChat; substituteOpenId: string } | undefined {
  if (!target || !chatId) return undefined;
  if (target.openId) {
    const chat = getSubstituteDirectChat(larkAppId, target.openId, chatId);
    if (chat) return { chat, substituteOpenId: target.openId };
  }
  const store = readStore();
  for (const binding of Object.values(store.bindings)) {
    if (binding.larkAppId !== larkAppId) continue;
    const bindingTargetOpenId = binding.targetOpenId ?? binding.substituteOpenId;
    const matched = (target.openId && binding.substituteOpenId === target.openId)
      || (target.openId && bindingTargetOpenId === target.openId)
      || (target.userId && binding.substituteUserId === target.userId)
      || (target.unionId && binding.substituteUnionId === target.unionId)
      || (!!target.name && (binding.targetName === target.name || binding.chats[chatId]?.targetName === target.name));
    if (!matched) continue;
    const chat = binding.chats[chatId];
    if (chat) return { chat, substituteOpenId: binding.substituteOpenId };
  }
  return undefined;
}

export function upsertSubstituteDirectChat(input: {
  larkAppId: string;
  substituteOpenId: string;
  targetOpenId?: string;
  substituteUserId?: string;
  substituteUnionId?: string;
  chatId: string;
  chatName?: string | null;
  targetName?: string;
  mode?: 'direct' | 'intervene';
  disclosure?: 'prefix' | 'none';
  lastGroupMessageId?: string;
}): SubstituteDirectBinding {
  const store = readStore();
  const k = key(input.larkAppId, input.substituteOpenId);
  const current = store.bindings[k] ?? {
    larkAppId: input.larkAppId,
    substituteOpenId: input.substituteOpenId,
    chats: {},
    updatedAt: 0,
  };
  current.targetOpenId = input.targetOpenId;
  current.substituteUserId = input.substituteUserId;
  current.substituteUnionId = input.substituteUnionId;
  current.targetName = input.targetName;
  current.chats = {};
  current.chats[input.chatId] = {
    chatId: input.chatId,
    chatName: input.chatName || undefined,
    targetName: input.targetName,
    mode: input.mode === 'intervene' ? 'intervene' : 'direct',
    disclosure: input.disclosure === 'none' ? 'none' : 'prefix',
    lastGroupMessageId: input.lastGroupMessageId,
    dmToGroupMessageIds: current.chats[input.chatId]?.dmToGroupMessageIds,
    updatedAt: Date.now(),
  };
  current.activeChatId = input.chatId;
  current.updatedAt = Date.now();
  store.bindings[k] = current;
  writeStore(store);
  return current;
}

export function appendSubstituteInterventionNote(
  larkAppId: string,
  substituteOpenId: string | undefined,
  note: string,
): SubstituteDirectChat | undefined {
  const active = getActiveSubstituteDirectChat(larkAppId, substituteOpenId);
  if (!active || active.mode !== 'intervene') return undefined;
  const store = readStore();
  const k = key(larkAppId, substituteOpenId!);
  const binding = store.bindings[k];
  const chat = binding?.activeChatId ? binding.chats[binding.activeChatId] : undefined;
  if (!chat) return undefined;
  const notes = [...(chat.interventionNotes ?? []), note].slice(-20);
  chat.interventionNotes = notes;
  chat.updatedAt = Date.now();
  binding.updatedAt = Date.now();
  writeStore(store);
  return chat;
}

export function consumeSubstituteInterventionNotes(
  larkAppId: string,
  substituteOpenId: string | undefined,
  chatId: string | undefined,
): string[] {
  const chat = getSubstituteDirectChat(larkAppId, substituteOpenId, chatId);
  if (!chat?.interventionNotes?.length) return [];
  const store = readStore();
  const binding = store.bindings[key(larkAppId, substituteOpenId!)];
  const stored = chatId ? binding?.chats?.[chatId] : undefined;
  const notes = [...(stored?.interventionNotes ?? [])];
  if (stored) {
    stored.interventionNotes = [];
    stored.updatedAt = Date.now();
    binding.updatedAt = Date.now();
    writeStore(store);
  }
  return notes;
}

export function recordSubstituteDirectForwardedMessage(input: {
  larkAppId: string;
  substituteOpenId: string | undefined;
  chatId: string | undefined;
  dmMessageId: string | undefined;
  groupMessageId: string | undefined;
}): void {
  if (!input.substituteOpenId || !input.chatId || !input.dmMessageId || !input.groupMessageId) return;
  const store = readStore();
  const binding = store.bindings[key(input.larkAppId, input.substituteOpenId)];
  const chat = binding?.chats?.[input.chatId];
  if (!binding || !chat) return;
  const pairs = Object.entries(chat.dmToGroupMessageIds ?? {});
  pairs.push([input.dmMessageId, input.groupMessageId]);
  chat.dmToGroupMessageIds = Object.fromEntries(pairs.slice(-50));
  chat.updatedAt = Date.now();
  binding.updatedAt = Date.now();
  writeStore(store);
}

export function getSubstituteDirectQuotedGroupMessageId(
  larkAppId: string,
  substituteOpenId: string | undefined,
  dmMessageId: string | undefined,
): string | undefined {
  if (!substituteOpenId || !dmMessageId) return undefined;
  const binding = getSubstituteDirectBinding(larkAppId, substituteOpenId);
  if (!binding) return undefined;
  for (const chat of Object.values(binding.chats)) {
    const hit = chat.dmToGroupMessageIds?.[dmMessageId];
    if (hit) return hit;
  }
  return undefined;
}

export function clearSubstituteDirectChat(larkAppId: string, substituteOpenId: string | undefined, chatId?: string): boolean {
  if (!substituteOpenId) return false;
  const store = readStore();
  const k = key(larkAppId, substituteOpenId);
  const binding = store.bindings[k];
  if (!binding) return false;
  if (!chatId) {
    const existed = Object.keys(binding.chats).length > 0;
    delete store.bindings[k];
    if (existed) writeStore(store);
    return existed;
  }
  const existed = !!binding.chats[chatId];
  delete binding.chats[chatId];
  if (binding.activeChatId === chatId) {
    binding.activeChatId = Object.values(binding.chats).sort((a, b) => b.updatedAt - a.updatedAt)[0]?.chatId;
  }
  binding.updatedAt = Date.now();
  if (Object.keys(binding.chats).length === 0) delete store.bindings[k];
  else store.bindings[k] = binding;
  if (existed) writeStore(store);
  return existed;
}
