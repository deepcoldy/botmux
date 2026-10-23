/**
 * per-user talk 授权状态的纯逻辑层（零运行时依赖，bot-registry 也从这里取解析函数）。
 *
 * 授权状态 = 五个字段：chatGrants / globalGrants 两张成员表，加上按 scope key
 * （`chat:<chatId>:<openId>` | `global:<openId>`）记的额度、有效期，以及派发扣费回执。
 * 持久层有两种（见 grant-state-store.ts），业务逻辑（grant-store.ts）只通过 {@link GrantTx}
 * 这组原语读写，不关心落在 SQLite 还是 bots.json。
 */

/** 授权状态在 bots.json 条目 / BotConfig 上的字段名（迁移时据此识别与剥离）。 */
export const GRANT_STATE_KEYS = [
  'chatGrants',
  'globalGrants',
  'quotaState',
  'grantExpiryState',
  'dispatchLaunchQuotaReceipts',
] as const;

export type GrantStateKey = typeof GRANT_STATE_KEYS[number];

export type QuotaRec = { limit: number; used: number };
export type DispatchReceipt = { allow: boolean; chargedAt: string };

export interface GrantStateFields {
  chatGrants?: { [chatId: string]: string[] };
  globalGrants?: string[];
  quotaState?: { [grantKey: string]: QuotaRec };
  grantExpiryState?: { [grantKey: string]: { expiresAt: number } };
  dispatchLaunchQuotaReceipts?: { [receiptId: string]: DispatchReceipt };
}

const GRANT_KEY_RE = /^(chat:.+:.+|global:.+)$/;
const RECEIPT_ID_RE = /^quota_[0-9a-f]{32}$/;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/**
 * 把 bots.json 条目上的五个授权字段归一化（逐项校验，非法项丢弃，全空 → undefined）。
 * 加载配置与迁移导入共用这一份规则，保证导入授权库的数据与旧加载路径看到的完全一致。
 */
export function parseGrantStateFields(entry: any): GrantStateFields {
  const out: GrantStateFields = {};

  // chatGrants：只保留 { [chatId:string]: string[] }，逐项校验 typeof === 'string'，丢弃空列表。
  if (isPlainObject(entry?.chatGrants)) {
    const map: { [chatId: string]: string[] } = {};
    for (const [cid, arr] of Object.entries(entry.chatGrants)) {
      if (!Array.isArray(arr)) continue;
      const ids = (arr as unknown[]).filter((x): x is string => typeof x === 'string');
      if (ids.length > 0) map[cid] = ids;
    }
    if (Object.keys(map).length > 0) out.chatGrants = map;
  }

  // globalGrants：只保留非空 string[]（open_id 列表）。
  if (Array.isArray(entry?.globalGrants)) {
    const ids = (entry.globalGrants as unknown[])
      .filter((x): x is string => typeof x === 'string' && x.trim().length > 0);
    if (ids.length > 0) out.globalGrants = ids;
  }

  // quotaState：key 形如 `chat:*:*` / `global:*`，value 为 { limit 正整数, used 非负整数 }。
  if (isPlainObject(entry?.quotaState)) {
    const map: { [k: string]: QuotaRec } = {};
    for (const [k, v] of Object.entries(entry.quotaState)) {
      if (!GRANT_KEY_RE.test(k) || !isPlainObject(v)) continue;
      const { limit, used } = v as { limit?: unknown; used?: unknown };
      if (typeof limit !== 'number' || !Number.isInteger(limit) || limit <= 0) continue;
      if (typeof used !== 'number' || !Number.isInteger(used) || used < 0) continue;
      map[k] = { limit, used };
    }
    if (Object.keys(map).length > 0) out.quotaState = map;
  }

  if (isPlainObject(entry?.dispatchLaunchQuotaReceipts)) {
    const map: { [k: string]: DispatchReceipt } = {};
    for (const [k, v] of Object.entries(entry.dispatchLaunchQuotaReceipts)) {
      if (!RECEIPT_ID_RE.test(k) || !isPlainObject(v)) continue;
      const { allow, chargedAt } = v as { allow?: unknown; chargedAt?: unknown };
      if (typeof allow !== 'boolean' || typeof chargedAt !== 'string' || !Number.isFinite(Date.parse(chargedAt))) continue;
      map[k] = { allow, chargedAt };
    }
    if (Object.keys(map).length > 0) out.dispatchLaunchQuotaReceipts = map;
  }

  if (isPlainObject(entry?.grantExpiryState)) {
    const map: { [k: string]: { expiresAt: number } } = {};
    for (const [k, v] of Object.entries(entry.grantExpiryState)) {
      if (!GRANT_KEY_RE.test(k) || !isPlainObject(v)) continue;
      const expiresAt = (v as { expiresAt?: unknown }).expiresAt;
      if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt) || expiresAt <= 0) continue;
      map[k] = { expiresAt };
    }
    if (Object.keys(map).length > 0) out.grantExpiryState = map;
  }

  return out;
}

/** 反解 scope key；格式不合法返回 undefined。chatId / openId 本身不含冒号。 */
export function parseGrantKey(
  key: string,
): { scope: 'chat'; chatId: string; openId: string } | { scope: 'global'; openId: string } | undefined {
  if (key.startsWith('global:')) {
    const openId = key.slice('global:'.length);
    return openId ? { scope: 'global', openId } : undefined;
  }
  if (!key.startsWith('chat:')) return undefined;
  const rest = key.slice('chat:'.length);
  const sep = rest.lastIndexOf(':');
  if (sep <= 0 || sep === rest.length - 1) return undefined;
  return { scope: 'chat', chatId: rest.slice(0, sep), openId: rest.slice(sep + 1) };
}

/**
 * 授权状态的读写原语。所有写操作都是幂等的集合语义（加已存在 / 删不存在 = 无改动），
 * 因此同一份操作日志可以安全地回放到内存缓存上（见 {@link replayGrantOps}）。
 */
export interface GrantTx {
  chatHas(chatId: string, openId: string): boolean;
  /** 返回是否新建。 */
  chatAdd(chatId: string, openId: string): boolean;
  /** 返回是否实际删除；该群最后一人删掉后整个群键一并删除。 */
  chatRemove(chatId: string, openId: string): boolean;
  globalHas(openId: string): boolean;
  globalAdd(openId: string): boolean;
  globalRemove(openId: string): boolean;
  quotaGet(key: string): QuotaRec | undefined;
  /** rec=null 删除。写入恒视为改动，删除仅在记录存在时算改动。 */
  quotaSet(key: string, rec: QuotaRec | null): boolean;
  expiryGet(key: string): number | undefined;
  /** expiresAt=null 删除（= 永久授权）。改动语义同 quotaSet。 */
  expirySet(key: string, expiresAt: number | null): boolean;
  receiptGet(id: string): DispatchReceipt | undefined;
  receiptSet(id: string, rec: DispatchReceipt): void;
}

export type GrantOp =
  | { op: 'chatAdd' | 'chatRemove'; chatId: string; openId: string }
  | { op: 'globalAdd' | 'globalRemove'; openId: string }
  | { op: 'quotaSet'; key: string; rec: QuotaRec | null }
  | { op: 'expirySet'; key: string; expiresAt: number | null }
  | { op: 'receiptSet'; id: string; rec: DispatchReceipt };

/**
 * 以普通对象（bots.json 条目或内存 bot.config）承载授权状态的 GrantTx。
 * 空表一律删键，不在 bots.json 里留下 `"chatGrants": {}` 这类空壳。
 */
export function objectGrantTx(o: any): GrantTx {
  const chatMap = (): { [chatId: string]: string[] } | undefined =>
    (isPlainObject(o.chatGrants) ? o.chatGrants : undefined) as { [chatId: string]: string[] } | undefined;
  const globalList = (): string[] => (Array.isArray(o.globalGrants) ? o.globalGrants : []);
  const keyedMap = <V>(field: 'quotaState' | 'grantExpiryState' | 'dispatchLaunchQuotaReceipts') =>
    (isPlainObject(o[field]) ? o[field] : undefined) as { [k: string]: V } | undefined;
  const setKeyed = <V>(
    field: 'quotaState' | 'grantExpiryState' | 'dispatchLaunchQuotaReceipts',
    key: string,
    value: V | null,
  ): boolean => {
    const cur = keyedMap<V>(field);
    if (value !== null) { o[field] = { ...(cur ?? {}), [key]: value }; return true; }
    if (!cur || !(key in cur)) return false;
    const next = { ...cur };
    delete next[key];
    if (Object.keys(next).length > 0) o[field] = next; else delete o[field];
    return true;
  };

  return {
    chatHas: (chatId, openId) => {
      const list = chatMap()?.[chatId];
      return Array.isArray(list) && list.includes(openId);
    },
    // 群表可能有上千个群：原地改表、只替换被改的那个列表，不整表复制。
    chatAdd: (chatId, openId) => {
      const map = chatMap() ?? {};
      const cur = Array.isArray(map[chatId]) ? map[chatId] : [];
      if (cur.includes(openId)) return false;
      map[chatId] = [...cur, openId];
      o.chatGrants = map;
      return true;
    },
    chatRemove: (chatId, openId) => {
      const map = chatMap();
      const cur = map?.[chatId];
      if (!map || !Array.isArray(cur) || !cur.includes(openId)) return false;
      const remaining = cur.filter(id => id !== openId);
      if (remaining.length > 0) map[chatId] = remaining; else delete map[chatId];
      if (Object.keys(map).length === 0) delete o.chatGrants;
      return true;
    },
    globalHas: openId => globalList().includes(openId),
    globalAdd: openId => {
      const cur = globalList();
      if (cur.includes(openId)) return false;
      o.globalGrants = [...cur, openId];
      return true;
    },
    globalRemove: openId => {
      const cur = globalList();
      if (!cur.includes(openId)) return false;
      const next = cur.filter(id => id !== openId);
      if (next.length > 0) o.globalGrants = next; else delete o.globalGrants;
      return true;
    },
    quotaGet: key => keyedMap<QuotaRec>('quotaState')?.[key],
    quotaSet: (key, rec) => setKeyed('quotaState', key, rec),
    expiryGet: key => {
      const expiresAt = keyedMap<{ expiresAt: number }>('grantExpiryState')?.[key]?.expiresAt;
      return typeof expiresAt === 'number' ? expiresAt : undefined;
    },
    expirySet: (key, expiresAt) => setKeyed('grantExpiryState', key, expiresAt === null ? null : { expiresAt }),
    receiptGet: id => keyedMap<DispatchReceipt>('dispatchLaunchQuotaReceipts')?.[id],
    receiptSet: (id, rec) => { setKeyed('dispatchLaunchQuotaReceipts', id, rec); },
  };
}

/** 包一层 GrantTx：所有写调用原样转发，同时按调用顺序记进 ops，供提交后回放。 */
export function journalGrantTx(tx: GrantTx, ops: GrantOp[]): GrantTx {
  return {
    chatHas: (chatId, openId) => tx.chatHas(chatId, openId),
    chatAdd: (chatId, openId) => { ops.push({ op: 'chatAdd', chatId, openId }); return tx.chatAdd(chatId, openId); },
    chatRemove: (chatId, openId) => { ops.push({ op: 'chatRemove', chatId, openId }); return tx.chatRemove(chatId, openId); },
    globalHas: openId => tx.globalHas(openId),
    globalAdd: openId => { ops.push({ op: 'globalAdd', openId }); return tx.globalAdd(openId); },
    globalRemove: openId => { ops.push({ op: 'globalRemove', openId }); return tx.globalRemove(openId); },
    quotaGet: key => tx.quotaGet(key),
    quotaSet: (key, rec) => { ops.push({ op: 'quotaSet', key, rec }); return tx.quotaSet(key, rec); },
    expiryGet: key => tx.expiryGet(key),
    expirySet: (key, expiresAt) => { ops.push({ op: 'expirySet', key, expiresAt }); return tx.expirySet(key, expiresAt); },
    receiptGet: id => tx.receiptGet(id),
    receiptSet: (id, rec) => { ops.push({ op: 'receiptSet', id, rec }); tx.receiptSet(id, rec); },
  };
}

export function replayGrantOps(target: GrantTx, ops: readonly GrantOp[]): void {
  for (const op of ops) {
    switch (op.op) {
      case 'chatAdd': target.chatAdd(op.chatId, op.openId); break;
      case 'chatRemove': target.chatRemove(op.chatId, op.openId); break;
      case 'globalAdd': target.globalAdd(op.openId); break;
      case 'globalRemove': target.globalRemove(op.openId); break;
      case 'quotaSet': target.quotaSet(op.key, op.rec); break;
      case 'expirySet': target.expirySet(op.key, op.expiresAt); break;
      case 'receiptSet': target.receiptSet(op.id, op.rec); break;
    }
  }
}
