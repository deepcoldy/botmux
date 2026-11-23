/**
 * 助理模式的群归属表：`<dataDir>/assistant-owners/<appId>.json`
 *   { version: 1, chats: { [chat_id]: { openId, since, how, left? } } }
 *
 * 只记 open_id 与来源，不存 token、不存聊天内容。目录 0700、文件 0600、
 * tmp+rename 原子写。daemon 是唯一写者（bot.added 事件 / 认领命令 / 管理员
 * 改绑 / owner 退群）；沙盒会话读不到它（在 botmux 数据根的 deny 里）。
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AssistantOwnerHow, AssistantOwnerRecord } from '../core/assistant-mode.js';
import { isValidAssistantOpenId } from '../core/assistant-mode.js';

interface StoreFile { version: 1; chats: Record<string, AssistantOwnerRecord> }

const CHAT_ID_RE = /^oc_[A-Za-z0-9_-]{1,128}$/;
const APP_ID_RE = /^[A-Za-z0-9_.-]+$/;

export function assistantOwnerStorePath(dataDir: string, appId: string): string {
  if (!APP_ID_RE.test(appId) || appId === '.' || appId === '..') throw new Error('assistant-owner-store: invalid appId');
  return join(dataDir, 'assistant-owners', `${appId}.json`);
}

function readStore(path: string): StoreFile {
  let raw: string;
  try { raw = readFileSync(path, 'utf-8'); } catch { return { version: 1, chats: {} }; }
  try {
    const v = JSON.parse(raw);
    if (v && typeof v === 'object' && v.chats && typeof v.chats === 'object') return { version: 1, chats: v.chats };
  } catch { /* corrupt → treat as empty; the next write replaces it */ }
  return { version: 1, chats: {} };
}

function writeStore(path: string, store: StoreFile): void {
  mkdirSync(join(path, '..'), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(store, null, 2), { mode: 0o600 });
  renameSync(tmp, path);
}

export function getAssistantOwner(dataDir: string, appId: string, chatId: string): AssistantOwnerRecord | undefined {
  if (!CHAT_ID_RE.test(chatId)) return undefined;
  return readStore(assistantOwnerStorePath(dataDir, appId)).chats[chatId];
}

export function setAssistantOwner(
  dataDir: string, appId: string, chatId: string, openId: string, how: AssistantOwnerHow, now: Date = new Date(),
): AssistantOwnerRecord {
  if (!CHAT_ID_RE.test(chatId)) throw new Error('assistant-owner-store: invalid chatId');
  if (!isValidAssistantOpenId(openId)) throw new Error('assistant-owner-store: invalid open_id');
  const path = assistantOwnerStorePath(dataDir, appId);
  const store = readStore(path);
  const rec: AssistantOwnerRecord = { openId, since: now.toISOString(), how };
  store.chats[chatId] = rec;
  writeStore(path, store);
  return rec;
}

/** owner 退群：保留记录但标 left，群进入待认领。没有记录时无操作。 */
export function markAssistantOwnerLeft(dataDir: string, appId: string, chatId: string, now: Date = new Date()): boolean {
  if (!CHAT_ID_RE.test(chatId)) return false;
  const path = assistantOwnerStorePath(dataDir, appId);
  const store = readStore(path);
  const rec = store.chats[chatId];
  if (!rec || rec.left) return false;
  store.chats[chatId] = { ...rec, left: now.toISOString() };
  writeStore(path, store);
  return true;
}

/** 列出某个 owner 名下的群（含已 left 的不算）。cli 侧 history/list 收窄用。 */
export function listAssistantOwnerChats(dataDir: string, appId: string, openId: string): string[] {
  const store = readStore(assistantOwnerStorePath(dataDir, appId));
  return Object.entries(store.chats).filter(([, r]) => r.openId === openId && !r.left).map(([c]) => c);
}
