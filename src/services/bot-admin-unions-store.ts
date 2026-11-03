/**
 * 每个本机 bot 管理员（allowedUsers）的 union_id 快照——同机兄弟 bot 判断「对方的管理员是不是
 * 都是我的管理员」的依据（见 event-dispatcher 的 isTrustedSameOwnerSiblingBot）；拉新群时认
 * 「新群属于哪个管家的 owner」也读这里的 owner（见 services/steward-auto-join.ts）。
 *
 * 为什么要单独存：allowedUsers 里同一个人可能写成邮箱、手机号、on_ 或 ou_，形态不同没法
 * 直接比；ou_ 还只对签发它的应用有效（见 setup/owner-identity.ts），跨应用只能比 union_id。
 * 把 ou_ 换成 union_id 必须用签发它的那个应用自己的凭证，所以由每个 daemon 用自己的凭证
 * 解析自己的管理员，写到 `{dataDir}/bot-admin-unions/<appId>.json`；兄弟 daemon 只读。
 *
 * 快照带 allowedUsers 原文的指纹：读方拿 bots.json 里的现值核对，对不上（刚改过 owner、
 * 还没重新发布）就当没有。文件缺失 / 损坏 / 指纹不符一律返回 undefined，调用方据此不授信
 * （fail closed）——只会退回「同机 bot 只能对话」的旧行为，不会多放行。
 */
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { isJsonObject, readJsonFileSoft } from '../utils/json-file.js';

export interface BotAdminUnionsSnapshot {
  /** allowedUsers 原文指纹（{@link adminListFingerprint}）。 */
  fingerprint: string;
  /** 换出了 union_id 的管理员。 */
  admins: string[];
  /**
   * 本 bot 的每个有效管理员（解析出了本 app 的 ou_）都换出了 union_id。为 false 时 admins
   * 少了人：作为接收方只会少信任，作为发送方则无法证明「对方的管理员都在我这儿」，不授信。
   */
  exact: boolean;
  /** 本 bot 当前 owner（getOwnerOpenId）的 union_id；没换出来就没有。管家拉群按它认 owner。 */
  owner?: string;
  updatedAt: number;
}

export interface BotAdminUnions {
  admins: Set<string>;
  exact: boolean;
  owner?: string;
}

function dirPath(dataDir: string): string {
  return join(dataDir, 'bot-admin-unions');
}

function filePath(dataDir: string, larkAppId: string): string | undefined {
  const app = (larkAppId ?? '').trim();
  // appId 进文件名，只收飞书 app_id 的字符集，防路径穿越。
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(app)) return undefined;
  return join(dirPath(dataDir), `${app}.json`);
}

/** allowedUsers 原文的指纹：逐项 trim 后按顺序哈希。 */
export function adminListFingerprint(rawAllowedUsers: readonly string[]): string {
  const normalized = rawAllowedUsers.map(e => (typeof e === 'string' ? e.trim() : '')).filter(Boolean);
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}

/**
 * 由本 bot 自己的解析结果算出管理员 union_id 快照。
 *
 * @param resolution  `raw 条目 → 本 app 的 ou_`（daemon 的 rawAllowedUserResolution）。
 *   没在里面的条目视为没解析成功（不是本 bot 的有效管理员），不进快照。字面 ou_ 条目
 *   即使不在映射里也按自身处理（解析器对字面 ou_ 恒原样保留）。
 * @param lookupUnion  用本 app 凭证把 ou_ 换成 union_id：string = 拿到；null = 确定拿不到
 *   （不可见 / 缺权限，不必重试）；undefined = 这次没拿到（网络等，稍后重试）。
 * @param ownerOpenId  本 bot 当前 owner 的 ou_（daemon 的 getOwnerOpenId，必然是某个有效管理员），
 *   它换出的 union_id 记进 `owner`。
 * @returns `complete=false` 表示有条目这次没拿到 union_id，值得稍后重试；快照里的 `exact`
 *   另算：确定拿不到（null）也会让 exact 为 false。
 */
export async function computeBotAdminUnions(
  rawAllowedUsers: readonly string[],
  resolution: ReadonlyMap<string, string>,
  lookupUnion: (openId: string) => Promise<string | null | undefined>,
  now: number = Date.now(),
  ownerOpenId?: string,
): Promise<{ snapshot: BotAdminUnionsSnapshot; complete: boolean }> {
  const admins: string[] = [];
  let owner: string | undefined;
  let complete = true;
  let exact = true;
  const entries = rawAllowedUsers.map(e => (typeof e === 'string' ? e.trim() : '')).filter(Boolean);
  for (const entry of entries) {
    const openId = resolution.get(entry) ?? (entry.startsWith('ou_') ? entry : undefined);
    if (!openId) continue;
    const union = entry.startsWith('on_') ? entry : await lookupUnion(openId);
    if (!union) {
      exact = false;
      if (union === undefined) complete = false;
      continue;
    }
    if (!owner && ownerOpenId && openId === ownerOpenId) owner = union;
    if (!admins.includes(union)) admins.push(union);
  }
  return {
    snapshot: { fingerprint: adminListFingerprint(entries), admins, exact, ...(owner ? { owner } : {}), updatedAt: now },
    complete,
  };
}

export function writeBotAdminUnions(dataDir: string, larkAppId: string, snapshot: BotAdminUnionsSnapshot): void {
  const fp = filePath(dataDir, larkAppId);
  if (!fp) return;
  mkdirSync(dirPath(dataDir), { recursive: true });
  atomicWriteFileSync(fp, JSON.stringify(snapshot, null, 2) + '\n');
}

/**
 * 读某个 bot 发布的管理员 union_id。`currentRawAllowedUsers` 是该 bot **此刻**在配置里的
 * allowedUsers 原文；与快照指纹不符时返回 undefined。
 */
export function readBotAdminUnions(
  dataDir: string,
  larkAppId: string,
  currentRawAllowedUsers: readonly string[] | undefined,
): BotAdminUnions | undefined {
  const fp = filePath(dataDir, larkAppId);
  if (!fp || !currentRawAllowedUsers?.length) return undefined;
  const snap = readJsonFileSoft<Record<string, any>>(fp, {
    fallback: () => ({}),
    validate: isJsonObject,
    label: 'bot-admin-unions',
  });
  if (snap.fingerprint !== adminListFingerprint(currentRawAllowedUsers)) return undefined;
  const admins = Array.isArray(snap.admins)
    ? snap.admins.filter((u: unknown): u is string => typeof u === 'string' && u.startsWith('on_'))
    : [];
  const exact = snap.exact === true && Array.isArray(snap.admins) && admins.length === snap.admins.length;
  // owner 必须是快照里的管理员之一：手改文件塞进一个别人的 union_id 不会被当成 owner。
  const owner = typeof snap.owner === 'string' && admins.includes(snap.owner) ? snap.owner : undefined;
  return { admins: new Set(admins), exact, ...(owner ? { owner } : {}) };
}

export interface BotAdminUnionsPublisherDeps {
  dataDir: string;
  larkAppId: string;
  /** 本 bot 此刻的 allowedUsers 原文、解析结果与当前 owner；拿不到（bot 不在了）返回 undefined。 */
  readState: () => { rawAllowedUsers: readonly string[]; resolution: ReadonlyMap<string, string>; ownerOpenId?: string } | undefined;
  /** 同 {@link computeBotAdminUnions} 的 lookupUnion。 */
  lookupUnion: (openId: string) => Promise<string | null | undefined>;
  onError?: (err: unknown) => void;
}

/**
 * daemon 侧的发布器：`publish()` 可以反复调用（启动解析完成后一次、之后每个心跳一次），
 * 只有 allowedUsers 原文、解析结果或 owner 变了才重算、写盘；上一轮有条目暂时没拿到 union_id 时
 * 下次再试。同一时刻只跑一轮。ou_ → union_id 的结果按 ou_ 缓存在进程内。
 */
export function createBotAdminUnionsPublisher(deps: BotAdminUnionsPublisherDeps): { publish: () => Promise<void> } {
  let publishedKey: string | undefined;
  let running = false;
  const unions = new Map<string, string | null>();
  const lookup = async (openId: string): Promise<string | null | undefined> => {
    if (unions.has(openId)) return unions.get(openId);
    const union = await deps.lookupUnion(openId);
    if (union !== undefined) unions.set(openId, union);
    return union;
  };
  return {
    async publish() {
      if (running) return;
      running = true;
      try {
        // 调用方都是 `void publish()`（启动一次 + 每个心跳），任何异常都必须在这里接住。
        const state = deps.readState();
        if (!state) return;
        const key = JSON.stringify([state.rawAllowedUsers, [...state.resolution], state.ownerOpenId ?? null]);
        if (key === publishedKey) return;
        const { snapshot, complete } = await computeBotAdminUnions(
          state.rawAllowedUsers, state.resolution, lookup, Date.now(), state.ownerOpenId);
        writeBotAdminUnions(deps.dataDir, deps.larkAppId, snapshot);
        if (complete) publishedKey = key;
      } catch (err) {
        deps.onError?.(err);
      } finally {
        running = false;
      }
    },
  };
}
