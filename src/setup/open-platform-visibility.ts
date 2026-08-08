/**
 * 应用可见范围（谁能看到 / 使用这个飞书应用）的读取与 fail-closed 解析。
 *
 * 为什么单独成模块：**每一次 `app_version/create` 都会整体覆写可见范围**——
 * payload 里的 `visibleSuggest` 就是新版本的可见范围，漏掉的集合不是"保持不变"
 * 而是"被清空"。因此任何要发版的链路都必须先把线上可见范围原样读回来再镜像
 * 过去，且读不准时宁可不发版。
 *
 * 这段解析原本只长在 `services/open-platform-rename.ts`（改名/改头像链路）里，
 * 而 `setup/open-platform-automation.ts` 的自动发版走的是另一套（读 `contact_range`
 * 只取 members，departments/groups/isAll 写死空值），把「全员可见 / 按部门授权 /
 * 按用户组授权」在每次自动发版时静默清成「仅少数个人可见」。抽到这里共用，
 * 保证所有发版链路只有一个可见范围来源。
 *
 * 正确的数据来源是 `/developers/v1/visible/online/{clientId}`（线上版本的可见
 * 范围），**不是** `/developers/v1/contact_range/{clientId}`——后者是「通讯录权限
 * 范围」（应用能读谁的通讯录），和「应用可见范围」是两个概念。
 */

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> {
  return isPlainRecord(value) ? value : {};
}

// visible/online 各集合的 id 字段族：console 内部接口的条目形态没有公开契约，
// members 实测是 { id }，departments / groups 未实测——按开放平台常见命名把
// 候选 key 都列上，并配合下面的 fail-closed 兜底。
const MEMBER_ID_KEYS = ['id', 'openId', 'open_id', 'userId', 'user_id', 'memberId', 'member_id'];
const DEPARTMENT_ID_KEYS = ['id', 'departmentId', 'department_id', 'openDepartmentId', 'open_department_id'];
const GROUP_ID_KEYS = ['id', 'groupId', 'group_id', 'chatId', 'chat_id', 'openChatId', 'open_chat_id'];

/** 可见范围形态未识别 —— 绝不能发布可能改变可见性的版本，fail closed。 */
export class VisibilityParseError extends Error {
  constructor(readonly collection: string) {
    super(`visible/online ${collection} 形态未识别，已中止（避免把线上可见范围发布成空/发漏）`);
  }
}

function pickIdByKeys(item: unknown, keys: string[]): string {
  if (typeof item === 'string') return item;
  if (typeof item === 'number' && Number.isFinite(item)) return String(item);
  const rec = asRecord(item);
  for (const key of keys) {
    const v = rec[key];
    if (typeof v === 'string' && v) return v;
    if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  }
  return '';
}

/**
 * 条目 → id 列表。fail closed：任何一个条目解析不出 id 就抛
 * {@link VisibilityParseError}——部分丢失同样会收窄可见范围，宁可中止
 * 走降级路径，也不发布一个"看起来成功"但少了人的版本。
 */
function idList(value: unknown, keys: string[], collection: string): string[] {
  if (!Array.isArray(value)) return [];
  const ids = value.map((item) => pickIdByKeys(item, keys)).filter(Boolean);
  if (ids.length < value.length) throw new VisibilityParseError(collection);
  return ids;
}

/** 集合键：只有「键不存在」允许当空（仅 legacy 顶层形态的可选 groups 会走到）；
 *  键存在则值必须是数组——null/字符串等一律 fail closed，不得静默变空集合。 */
function idListStrict(rec: Record<string, unknown>, key: string, keys: string[], label: string): string[] {
  if (!(key in rec)) return [];
  const value = rec[key];
  if (!Array.isArray(value)) throw new VisibilityParseError(`${label}.${key}`);
  return idList(value, keys, `${label}.${key}`);
}

export type VisibilitySuggest = { departments: string[]; members: string[]; groups: string[]; isAll: number };

export const EMPTY_VISIBILITY: VisibilitySuggest = { departments: [], members: [], groups: [], isAll: 0 };

/**
 * visible/online 的白/黑名单块 → 版本 payload 的 visibleSuggest 形态。
 * fail closed：块必须是对象且带齐 requiredKeys（实测线上契约 whiteList/blackList
 * 恒有 departments/groups/members/isAll 四键）——{}、null、缺键的残缺响应一律
 * 中止，绝不默认成「空可见范围」发布出去（那会把应用从所有人面前收走；黑名单
 * 丢失同理会把被拉黑的人放出来）。
 */
function visibilityBlock(raw: unknown, label: string, requiredKeys: readonly string[]): VisibilitySuggest {
  if (!isPlainRecord(raw)) throw new VisibilityParseError(label);
  for (const key of requiredKeys) {
    if (!(key in raw)) throw new VisibilityParseError(`${label}.${key}(缺失)`);
  }
  // isAll 只认 0/1/false/true：'1'、null 等异常值可能把「全员可见」误发布成
  // 不可见（或反之），一律 fail closed。
  const isAllRaw = raw.isAll;
  if (isAllRaw !== 0 && isAllRaw !== 1 && isAllRaw !== false && isAllRaw !== true) {
    throw new VisibilityParseError(`${label}.isAll`);
  }
  return {
    departments: idListStrict(raw, 'departments', DEPARTMENT_ID_KEYS, label),
    members: idListStrict(raw, 'members', MEMBER_ID_KEYS, label),
    groups: idListStrict(raw, 'groups', GROUP_ID_KEYS, label),
    isAll: isAllRaw === 1 || isAllRaw === true ? 1 : 0,
  };
}

/** 现行契约块的必备键（实测所有 app 的 whiteList/blackList 都带齐这四键）。 */
const BLOCK_REQUIRED_KEYS = ['departments', 'groups', 'members', 'isAll'] as const;
/** 旧形态（可见范围直接铺在 data 顶层）没有 groups 容器。 */
const LEGACY_TOP_REQUIRED_KEYS = ['departments', 'members', 'isAll'] as const;

/**
 * 解析 visible/online 响应为 白/黑名单 suggest 对。两种已知形态：
 *   • 现行：data.whiteList + data.blackList 成对出现（成对是契约的一部分——
 *     只认白名单会把 blackList 静默丢成空、把被拉黑的人放出来，fail closed）
 *   • 旧形态兜底：可见范围直接铺在 data 顶层（无 whiteList 容器）；此形态
 *     没有黑名单容器，blackList 缺失按空处理，出现则严格解析
 */
export function parseOnlineVisibility(payload: unknown): { visibleSuggest: VisibilitySuggest; blackVisibleSuggest: VisibilitySuggest } {
  const data = asRecord(payload).data;
  if (!isPlainRecord(data)) throw new VisibilityParseError('data');
  if ('whiteList' in data) {
    return {
      visibleSuggest: visibilityBlock(data.whiteList, 'whiteList', BLOCK_REQUIRED_KEYS),
      blackVisibleSuggest: visibilityBlock(data.blackList, 'blackList', BLOCK_REQUIRED_KEYS),
    };
  }
  return {
    visibleSuggest: visibilityBlock(data, 'whiteList', LEGACY_TOP_REQUIRED_KEYS),
    blackVisibleSuggest: data.blackList == null
      ? { ...EMPTY_VISIBILITY }
      : visibilityBlock(data.blackList, 'blackList', BLOCK_REQUIRED_KEYS),
  };
}
