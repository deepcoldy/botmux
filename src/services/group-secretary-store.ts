/**
 * 群秘书（/secretary）登记：哪个群由哪个 bot 当秘书。
 *
 * **本机唯一**：一台机器上所有 bot 的 daemon 共用同一个数据目录，这里只有一个文件
 * `${dataDir}/group-secretary.json`，按群记录唯一的秘书 bot。同一个群同一时间只会有
 * 一个秘书：别的 bot 想接手要显式 `/secretary takeover`，原秘书的 daemon 下一拍读到
 * 登记已换人就自动停手（isGroupSecretaryChat 每次都按文件 mtime 刷新）。
 *
 * 跨机器无法靠本文件互斥：另一台机器上的 bot 当不当秘书，这里看不见。
 *
 * tmp + rename 原子写；多个 daemon 并发改同一个群时后写者胜，命令层回执里会给出
 * 写入后的真实秘书，避免误以为自己开成功了。
 */
import { readFileSync, mkdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { config } from '../config.js';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { logger } from '../utils/logger.js';

export interface GroupSecretaryChatEntry {
  /** 担任秘书的 bot。 */
  larkAppId: string;
  /** 秘书 bot 的展示名（开启时记录，仅用于回执）。 */
  botName?: string;
  /** 开启人（秘书 bot 应用视角的 open_id）。秘书回合以此人的身份投递。 */
  enabledBy: string;
  /** 开启时间（epoch ms）。 */
  enabledAt: number;
  /**
   * 群描述标记最近一次确认指向本 bot 的时间。缺省 = 旧版本只在本机登记（迁移对象）；
   * 有值之后标记若消失 / 指向别人，说明被关闭或接管，本机登记随之清除，不会再「复活」。
   */
  markerConfirmedAt?: number;
}

interface GroupSecretaryFile {
  version: 2;
  chats: Record<string, GroupSecretaryChatEntry>;
}

let cache: { path: string; mtimeMs: number; size: number; data: GroupSecretaryFile; absentCheckedAt?: number } | undefined;
/** 文件不存在（没有任何群开秘书）时，这么久内不再 stat：每条群消息都会查一次登记，
 *  高消息量主机上省掉一次失败的系统调用。别的 daemon 新开的秘书最多晚这么久被本进程看到；
 *  本进程自己写入会立刻清掉缓存。 */
const ABSENT_RECHECK_MS = 2_000;

function filePath(): string {
  return join(config.session.dataDir, 'group-secretary.json');
}

function empty(): GroupSecretaryFile {
  return { version: 2, chats: {} };
}

function parse(raw: any): GroupSecretaryFile {
  const chats: Record<string, GroupSecretaryChatEntry> = {};
  if (raw && typeof raw === 'object' && raw.chats && typeof raw.chats === 'object') {
    for (const [chatId, entry] of Object.entries(raw.chats as Record<string, any>)) {
      if (!chatId.startsWith('oc_')) continue;
      if (!entry || typeof entry.larkAppId !== 'string' || !entry.larkAppId) continue;
      if (typeof entry.enabledBy !== 'string' || !entry.enabledBy) continue;
      chats[chatId] = {
        larkAppId: entry.larkAppId,
        ...(typeof entry.botName === 'string' && entry.botName ? { botName: entry.botName } : {}),
        enabledBy: entry.enabledBy,
        enabledAt: Number.isFinite(entry.enabledAt) ? entry.enabledAt : 0,
        ...(Number.isFinite(entry.markerConfirmedAt) ? { markerConfirmedAt: entry.markerConfirmedAt } : {}),
      };
    }
  }
  return { version: 2, chats };
}

/** 按 mtime/size 判断是否需要重读：别的 daemon 改了登记，本进程下一次查询就能看到。 */
function load(): GroupSecretaryFile {
  const path = filePath();
  const nowMs = Date.now();
  if (cache?.path === path && cache.absentCheckedAt !== undefined
      && nowMs - cache.absentCheckedAt >= 0 && nowMs - cache.absentCheckedAt < ABSENT_RECHECK_MS) {
    return cache.data;
  }
  let st: { mtimeMs: number; size: number };
  try {
    st = statSync(path);
  } catch {
    cache = { path, mtimeMs: -1, size: -1, data: empty(), absentCheckedAt: nowMs };
    return cache.data;
  }
  if (cache && cache.path === path && cache.mtimeMs === st.mtimeMs && cache.size === st.size) return cache.data;
  let data = empty();
  try {
    data = parse(JSON.parse(readFileSync(path, 'utf-8')));
  } catch (err) {
    logger.warn(`[group-secretary] failed to read ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
  cache = { path, mtimeMs: st.mtimeMs, size: st.size, data };
  return data;
}

/** 当前群的秘书（不论是哪个 bot）。 */
export function getGroupSecretaryOwner(chatId: string | undefined): GroupSecretaryChatEntry | undefined {
  return chatId ? load().chats[chatId] : undefined;
}

/** 本 bot 是否是该群的秘书。 */
export function getGroupSecretaryChat(larkAppId: string, chatId: string): GroupSecretaryChatEntry | undefined {
  const entry = load().chats[chatId];
  return entry?.larkAppId === larkAppId ? entry : undefined;
}

export function isGroupSecretaryChat(larkAppId: string, chatId: string | undefined): boolean {
  return !!chatId && load().chats[chatId]?.larkAppId === larkAppId;
}

export function listGroupSecretaryChats(larkAppId: string): Array<{ chatId: string } & GroupSecretaryChatEntry> {
  return Object.entries(load().chats)
    .filter(([, entry]) => entry.larkAppId === larkAppId)
    .map(([chatId, entry]) => ({ chatId, ...entry }));
}

/**
 * 写入 / 清除某群的秘书登记。写盘失败时返回原因，内存与磁盘都不变。
 * 写入前重读一次文件，只改这一个群，不覆盖别的 daemon 刚写的其它群。
 */
export function setGroupSecretaryChat(
  chatId: string,
  entry: GroupSecretaryChatEntry | null,
): { ok: true } | { ok: false; reason: string } {
  // 写之前必须真的回读一次磁盘：「文件不存在」的短缓存期间别的 daemon 可能刚建了文件，
  // 拿缓存的空登记写回会把对方的群抹掉。
  cache = undefined;
  const current = load();
  const next: GroupSecretaryFile = { version: 2, chats: { ...current.chats } };
  if (entry) next.chats[chatId] = entry;
  else delete next.chats[chatId];
  const path = filePath();
  try {
    mkdirSync(dirname(path), { recursive: true });
    atomicWriteFileSync(path, JSON.stringify(next, null, 2));
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
  cache = undefined;
  return { ok: true };
}

/** 测试隔离用。 */
export function resetGroupSecretaryStoreCache(): void {
  cache = undefined;
}
