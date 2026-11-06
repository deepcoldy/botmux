/**
 * 拉新群时带上管家（决策看板）。管家默认用自己的 bot 身份到相关群里发消息推进，不在群里就
 * 发不进去，所以 botmux 建的每个新群（唯一入口 group-creator 的 createGroupWithBots）都在这里
 * 统一判断：本机有开着「拉新群时带上管家」的管家 bot，而且新群的成员或发起人里有这个管家的
 * owner，就由 creator 把管家加进群。
 *
 * - 认 owner：按 union_id 比。管家 owner 的 union_id 由管家自己的 daemon 用自己的凭证换出来，
 *   发布在 bot-admin-unions 快照的 `owner` 里；新群成员是 creator 应用域的 open_id，用 creator
 *   的凭证换 union_id。任何一边换不出来就不带（宁可少带，不把管家拉进别人的群）。
 * - 同一台机器上多个 owner 各有管家时，只带 owner 在新群里的那个。
 * - 只有一个人和一个 bot 的新群（私聊转出的会话群、私聊里 /group、/fork --create 建的群、会议监听群
 *   等）默认不带：这类群靠单人单 bot 免 @ 续话，带上管家就成了两个 bot，原 bot 要 @ 才回。管家
 *   打开 autoJoinSoloGroups 才带。是不是这种群由 group-creator 按实际进群的 bot 和人数判断。
 * - 加管家只是 best-effort：失败只记日志、写进建群结果，不影响建群、不进 invalidBotIds
 *   （CLI create-group 会因 invalidBotIds 判建群不完整）。
 * - 管家进群后不发言、不开会话：不参与 oncall 绑定、角色套装、kickoff、Bot 协作授权；
 *   加群前先写一条「静默加入」标记，管家 daemon 收到这次入群事件时看到标记就只记日志，
 *   不跑入群命令、入群钩子、自动拉 owner、被拉进新群自动开工（{@link isStewardSilentJoin}）。
 * - 没开管家的部署：找不到候选管家就直接返回，不查任何身份、不写任何文件。
 */
import { mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BotConfig } from '../bot-registry.js';
import { stewardJoinsNewGroups } from '../core/decision-board/model.js';
import type { BotAdminUnions } from './bot-admin-unions-store.js';

export interface StewardJoinResult {
  larkAppId: string;
  ok: boolean;
  error?: string;
}

export interface StewardJoinInput {
  creatorLarkAppId: string;
  /** 本次建群已经请求进群的 bot（含 creator）：它们已在成员里，不再按管家重复加。 */
  requestedBotAppIds: readonly string[];
  /** 新群只有一个人和一个 bot：只带打开了 autoJoinSoloGroups 的管家。 */
  soloGroup?: boolean;
  /** 群里的人（creator 应用域 open_id / union_id），飞书拒绝邀请的已去掉。 */
  memberOpenIds: readonly string[];
  memberUnionIds: readonly string[];
  /** 发起人（群主转让 / @通知对象等），不一定是成员；只用来认 owner。 */
  initiatorOpenIds: readonly string[];
  initiatorUnionIds: readonly string[];
}

export interface StewardJoinDeps {
  /** bots.json 里的全部 bot（本机）。 */
  loadConfigs: () => readonly BotConfig[];
  /** 读某个 bot 发布的管理员 / owner union_id 快照（按它此刻的 allowedUsers 核对指纹）。 */
  readAdminUnions: (larkAppId: string, allowedUsers: readonly string[] | undefined) => BotAdminUnions | undefined;
  /** 用 creator 的凭证把 creator 应用域的 open_id 换成 union_id；换不出来给 undefined。 */
  lookupUnion: (openId: string) => Promise<string | undefined>;
  /** 写「静默加入」标记 / 加群失败时撤掉。 */
  markSilentJoin: (stewardAppId: string) => void;
  clearSilentJoin: (stewardAppId: string) => void;
  /** creator 把管家 bot 加进新群。 */
  addBot: (stewardAppId: string) => Promise<{ ok: boolean; error?: string }>;
  log: (level: 'info' | 'warn', message: string) => void;
}

/** 换成员 union_id 时每批并发的个数：通讯录接口按应用限频，一次建群不宜打太多并发。 */
const UNION_LOOKUP_BATCH = 5;

function uniq(values: readonly (string | undefined)[]): string[] {
  return [...new Set(values.map(v => v?.trim()).filter((v): v is string => !!v))];
}

export async function joinStewardsToNewChat(input: StewardJoinInput, deps: StewardJoinDeps): Promise<StewardJoinResult[]> {
  let configs: readonly BotConfig[];
  try {
    configs = deps.loadConfigs();
  } catch (err) {
    deps.log('warn', `[steward-join] 读不到 bots.json，不带管家：${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
  const requested = new Set([input.creatorLarkAppId, ...input.requestedBotAppIds]);
  const candidates = configs.filter(cfg => !!cfg.larkAppId && !requested.has(cfg.larkAppId)
    && cfg.apiOnly !== true && stewardJoinsNewGroups(cfg.steward, { soloGroup: input.soloGroup }));
  if (candidates.length === 0) return [];

  const owners = new Map<string, string>();
  for (const cfg of candidates) {
    const owner = deps.readAdminUnions(cfg.larkAppId, cfg.allowedUsers)?.owner;
    if (owner) owners.set(cfg.larkAppId, owner);
    else deps.log('info', `[steward-join] 管家 ${cfg.larkAppId} 的 owner 还没换出 union_id，这次不带`);
  }

  // 只有某个管家的 owner 没按 union_id 直接对上时，才去换成员的 union_id：每批并发几个，
  // 要找的 owner 都找到就停——这一步在群主转让之前，群里人多时不能让串行的通讯录查询拖住它。
  const people = new Set(uniq([...input.memberUnionIds, ...input.initiatorUnionIds]));
  const pending = new Set([...owners.values()].filter(owner => !people.has(owner)));
  const openIds = uniq([...input.memberOpenIds, ...input.initiatorOpenIds]);
  for (let i = 0; i < openIds.length && pending.size > 0; i += UNION_LOOKUP_BATCH) {
    const found = await Promise.all(openIds.slice(i, i + UNION_LOOKUP_BATCH)
      .map(openId => deps.lookupUnion(openId).catch(() => undefined)));
    for (const union of found) {
      if (!union) continue; // 换不出来就认不出这个人，不带
      people.add(union);
      pending.delete(union);
    }
  }
  const matched = [...owners].filter(([, owner]) => people.has(owner)).map(([larkAppId]) => larkAppId);

  const results: StewardJoinResult[] = [];
  for (const larkAppId of matched) {
    let added: { ok: boolean; error?: string };
    try {
      deps.markSilentJoin(larkAppId);
      added = await deps.addBot(larkAppId);
    } catch (err) {
      added = { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    if (added.ok) {
      deps.log('info', `[steward-join] 已把管家 ${larkAppId} 带进新群`);
      results.push({ larkAppId, ok: true });
      continue;
    }
    try { deps.clearSilentJoin(larkAppId); } catch { /* 标记过期后自然失效 */ }
    const error = added.error || 'unknown';
    deps.log('warn', `[steward-join] 管家 ${larkAppId} 没加进新群（建群不受影响）：${error}`);
    results.push({ larkAppId, ok: false, error });
  }
  return results;
}

// ─── 「静默加入」标记 ────────────────────────────────────────────────────────
// creator 进程写、管家 daemon 读：`{dataDir}/steward-silent-joins/<管家 appId>/<chatId>`，内容是
// 写入时间。入群事件正常几秒内就到；10 分钟足够覆盖事件重推，又不会让之后有人手动把管家
// 移出再拉回的那次入群也被当成静默加入。写新标记时顺手清掉过期的。

export const STEWARD_SILENT_JOIN_TTL_MS = 10 * 60_000;

const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

function markerDir(dataDir: string, stewardAppId: string): string | undefined {
  return ID_RE.test(stewardAppId) ? join(dataDir, 'steward-silent-joins', stewardAppId) : undefined;
}

function markerPath(dataDir: string, stewardAppId: string, chatId: string): string | undefined {
  const dir = markerDir(dataDir, stewardAppId);
  return dir && ID_RE.test(chatId) ? join(dir, chatId) : undefined;
}

export function markStewardSilentJoin(dataDir: string, stewardAppId: string, chatId: string, now = Date.now()): void {
  const dir = markerDir(dataDir, stewardAppId);
  const file = markerPath(dataDir, stewardAppId, chatId);
  if (!dir || !file) throw new Error(`invalid steward/chat id: ${stewardAppId} ${chatId}`);
  mkdirSync(dir, { recursive: true });
  for (const name of readdirSync(dir)) {
    try {
      if (now - statSync(join(dir, name)).mtimeMs > STEWARD_SILENT_JOIN_TTL_MS) unlinkSync(join(dir, name));
    } catch { /* 别的进程刚清掉 */ }
  }
  writeFileSync(file, String(now));
}

export function clearStewardSilentJoin(dataDir: string, stewardAppId: string, chatId: string): void {
  const file = markerPath(dataDir, stewardAppId, chatId);
  if (!file) return;
  try { unlinkSync(file); } catch { /* 本来就没有 */ }
}

/** 管家 daemon 收到入群事件时调用：这次入群是不是 botmux 拉群时静默带进来的。 */
export function isStewardSilentJoin(dataDir: string, larkAppId: string, chatId: string, now = Date.now()): boolean {
  const file = markerPath(dataDir, larkAppId, chatId);
  if (!file) return false;
  let at: number;
  try {
    at = Number(readFileSync(file, 'utf-8').trim());
  } catch {
    return false;
  }
  return Number.isFinite(at) && at <= now && now - at <= STEWARD_SILENT_JOIN_TTL_MS;
}
