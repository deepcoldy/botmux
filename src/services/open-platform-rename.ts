/**
 * 飞书应用真·改名 / 真·改头像 —— 复用 `botmux setup` 的开放平台自动化机制
 * （缓存的飞书 Web 登录态 + console 内部 `/developers/v1/*` 接口），把 dashboard
 * 的「机器人改名 / 改头像」落到飞书应用本身，而不只是 botmux 侧展示。
 *
 * 实测链路（2026-07-04 在测试 app 上打通；先读后写，读取/解析失败零副作用）：
 *   1. `app/:clientId`            — 读当前基础信息（langs / primaryLang / i18n / desc）
 *   2. `visible/online/:clientId` — 读**线上版本**的可见范围（白/黑名单）并
 *      fail-closed 解析；`app_version/list` 算下一个版本号
 *   3. `base_info/:clientId`      — 写新名字（所有已配语言的 name 都改，desc 保留）
 *   4. `app_version/create`（可见范围原样镜像线上版本，绝不收窄/放宽）
 *      → `publish/commit`
 * 关键事实：只改基础信息时，群里 bot 显示名**不会**变——它跟随已发布版本；
 * 必须建新版本并发布（自建应用租户内秒过审）后 `/bot/v3/info` 才返回新名。
 *
 * 失败面（全部结构化返回，调用方降级为仅改 botmux 展示名）：
 *   • unsupported_brand — console 自动化只支持 feishu.cn 租户
 *   • no_session        — 服务器上没有可用的飞书 Web 登录态（要跑 botmux setup 扫码）
 *   • session_expired   — 登录态失效 / 开放平台页面拿不到 csrfToken
 *   • no_access         — 当前登录账号不是该应用的协作者（console code=10003）
 *   • api_error         — 其余 console API 失败（含审核中无法建版等）
 */
import {
  botmuxFeishuSessionFilePath,
  buildAppVersionCreatePayload,
  bytedcliFeishuSessionFilePath,
  createOpenPlatformApiClient,
  extractVersionId,
  nextAppVersion,
  OpenPlatformApiError,
  readStoredCookiesFromSessionFile,
  type OpenPlatformApiClient,
  type OpenPlatformClientResult,
  type StoredCookie,
} from '../setup/open-platform-automation.js';
import { normalizeBrand, type Brand } from '../im/lark/lark-hosts.js';
import { logger } from '../utils/logger.js';

export type OpenPlatformRenameFailureReason =
  | 'unsupported_brand'
  | 'no_session'
  | 'session_expired'
  | 'no_access'
  | 'api_error';

export type OpenPlatformRenameResult =
  | { ok: true; name: string; versionId?: string }
  | { ok: false; reason: OpenPlatformRenameFailureReason; message: string };

/** 测试注入缝：cookie 加载与 console client 构造都可替换。 */
export interface OpenPlatformRenameDeps {
  loadCookies?: () => StoredCookie[] | null;
  clientFactory?: (cookies: StoredCookie[]) => Promise<OpenPlatformClientResult>;
}

function defaultLoadCookies(): StoredCookie[] | null {
  const own = readStoredCookiesFromSessionFile(botmuxFeishuSessionFilePath());
  if (own && own.length > 0) return own;
  // setup 同款兜底：本机 bytedcli 缓存的飞书 Web session。
  const fallback = readStoredCookiesFromSessionFile(bytedcliFeishuSessionFilePath());
  return fallback && fallback.length > 0 ? fallback : null;
}

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
class VisibilityParseError extends Error {
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

type VisibilitySuggest = { departments: string[]; members: string[]; groups: string[]; isAll: number };

const EMPTY_VISIBILITY: VisibilitySuggest = { departments: [], members: [], groups: [], isAll: 0 };

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
function parseOnlineVisibility(payload: unknown): { visibleSuggest: VisibilitySuggest; blackVisibleSuggest: VisibilitySuggest } {
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

function failureFromError(err: unknown, fallbackReason: OpenPlatformRenameFailureReason = 'api_error'): { reason: OpenPlatformRenameFailureReason; message: string } {
  if (err instanceof OpenPlatformApiError) {
    const code = asRecord(err.payload).code;
    if (code === 10003) {
      return { reason: 'no_access', message: '当前缓存的飞书账号不是该应用的协作者，开放平台拒绝访问（code=10003）' };
    }
    return { reason: fallbackReason, message: err.message };
  }
  return { reason: fallbackReason, message: err instanceof Error ? err.message : String(err) };
}

// ── 共用链路：改基础信息 + 镜像线上可见范围建版发布 ─────────────────────────
//
// 改名 / 改头像都是「改 base_info 的某个字段，再建新版本发布让群内生效」，只有
// base_info payload 的构造不同。顺序（先读后写、fail-closed）：读基础信息 →
// 读线上可见范围（解析失败零副作用中止）→ 算下一版本号 → buildBaseInfoPayload
// （rename：全语言写新名；avatar：上传图片拿 url）→ 写 base_info → 建版（可见
// 范围原样镜像，绝不收窄/放宽）→ publish/commit。

interface BaseInfoChangeSpec {
  /** 建版 changeLog / remark（开放平台后台版本记录里可见）。 */
  changeLog: string;
  remark: string;
  /** 日志标签（rename / avatar）与成功日志摘要。 */
  logLabel: string;
  logSummary: string;
  /**
   * 构造 base_info 写 payload（不含 clientId，由链路补上）。在所有读操作之后、
   * 第一笔写之前调用——这里抛错（含图片上传失败）时应用还没有任何改动。
   * ctx 里的 desc / i18nBlocks 已由链路 fail-closed 校验（读不到即中止），
   * 构造方必须原样回写它们，不得用空值顶替。
   */
  buildBaseInfoPayload(ctx: {
    client: OpenPlatformApiClient;
    base: Record<string, unknown>;
    langs: string[];
    desc: string;
    i18nBlocks: Record<string, Record<string, unknown>>;
  }): Promise<Record<string, unknown>>;
}

type BaseInfoChangeResult =
  | { ok: true; versionId: string }
  | { ok: false; reason: OpenPlatformRenameFailureReason; message: string };

// 同一 app 的「读快照 → 写 base_info → 建版发布」必须串行：rename 与 avatar 都是
// 先读 base_info 快照再全量回写，并发交错会用旧快照把对方刚写的字段覆盖回去
// （TOCTOU）。dashboard/IM 对某个 app 的写都经由该 app 的 daemon 单进程到达
// 这里（一个 bot 一个 daemon），进程内按 appId 排队即可闭环。
const appChangeQueues = new Map<string, Promise<void>>();

async function withAppQueue<T>(appId: string, fn: () => Promise<T>): Promise<T> {
  const prev = appChangeQueues.get(appId) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.then(() => undefined, () => undefined);
  appChangeQueues.set(appId, tail);
  try {
    return await run;
  } finally {
    if (appChangeQueues.get(appId) === tail) appChangeQueues.delete(appId);
  }
}

async function applyBaseInfoChangeAndRepublish(
  appId: string,
  brand: Brand | undefined,
  deps: OpenPlatformRenameDeps,
  spec: BaseInfoChangeSpec,
): Promise<BaseInfoChangeResult> {
  return withAppQueue(appId, () => applyBaseInfoChangeAndRepublishSerialized(appId, brand, deps, spec));
}

async function applyBaseInfoChangeAndRepublishSerialized(
  appId: string,
  brand: Brand | undefined,
  deps: OpenPlatformRenameDeps,
  spec: BaseInfoChangeSpec,
): Promise<BaseInfoChangeResult> {
  if (normalizeBrand(brand) !== 'feishu') {
    return { ok: false, reason: 'unsupported_brand', message: '开放平台自动化当前只支持 feishu.cn 租户；国际版请到开放平台后台手动修改' };
  }

  const cookies = (deps.loadCookies ?? defaultLoadCookies)();
  if (!cookies || cookies.length === 0) {
    return { ok: false, reason: 'no_session', message: '服务器上没有可用的飞书 Web 登录态；在服务器运行 botmux setup 重新扫码后重试' };
  }

  let clientResult: OpenPlatformClientResult;
  try {
    clientResult = await (deps.clientFactory ?? createOpenPlatformApiClient)(cookies);
  } catch (err) {
    return { ok: false, ...failureFromError(err) };
  }
  if (!clientResult.ok) {
    return {
      ok: false,
      reason: clientResult.reason === 'missing_csrf' ? 'session_expired' : 'api_error',
      message: clientResult.message,
    };
  }
  const client: OpenPlatformApiClient = clientResult.client;

  // 1) 读当前基础信息 —— 403/10003 在这一步暴露「不是协作者」。
  let base: Record<string, unknown>;
  try {
    const payload = await client.postJson(`/developers/v1/app/${appId}`, {});
    base = asRecord(asRecord(payload).data);
  } catch (err) {
    return { ok: false, ...failureFromError(err) };
  }

  const primaryLang = typeof base.primaryLang === 'string' && base.primaryLang ? base.primaryLang : 'zh_cn';
  const i18nCurrent = asRecord(base.i18n);

  try {
    // base_info 是全量写接口：languages 列表同样必须可靠读到。langs 缺失时若
    // 直接回退主语言，回写会把其它已配语言的 i18n 块整体删掉——只有 i18n 里
    // 确实没有其它语言时才允许该回退。
    const rawLangs = base.langs;
    let langs: string[];
    if (Array.isArray(rawLangs) && rawLangs.length > 0) {
      if (!rawLangs.every((l): l is string => typeof l === 'string' && l !== '')) {
        throw new Error('开放平台返回的 langs 形态未识别，已中止（全量回写可能删除语言配置）');
      }
      langs = rawLangs;
    } else {
      const extraLangs = Object.keys(i18nCurrent).filter(k => k !== primaryLang);
      if (extraLangs.length > 0) {
        throw new Error(`开放平台没有返回 langs 而 i18n 含多语言（${extraLangs.join(', ')}），已中止（全量回写会删除这些语言）`);
      }
      langs = [primaryLang];
    }

    // desc 与每个已配语言的 i18n 块必须能原样读到才允许回写——读不到时中止
    // （api_error），绝不用 '' / 仅含 name 的空块顶替，否则会把线上已有的描述
    // 与本地化字段清掉。
    const desc = base.desc;
    if (typeof desc !== 'string') {
      throw new Error('开放平台没有返回应用描述（desc），已中止（全量回写会清空描述）');
    }
    const i18nBlocks: Record<string, Record<string, unknown>> = {};
    for (const lang of langs) {
      const block = i18nCurrent[lang];
      if (!isPlainRecord(block)) {
        throw new Error(`开放平台没有返回 ${lang} 的 i18n 信息，已中止（全量回写会清空该语言的本地化字段）`);
      }
      i18nBlocks[lang] = block;
    }

    // 2) 预读并解析所有后续要用的数据 —— 在第一笔写操作之前完成。可见范围
    //    形态未识别（data 非对象 / 块缺键 / 集合非数组 / 条目解析不出 id）会在
    //    这里 fail closed（VisibilityParseError），此时基础信息还没写，零副作用
    //    地返回失败。
    //    群内显示名/头像跟随已发布版本 → 必须建新版本并发布；可见范围原样
    //    镜像线上版本（白/黑名单都带上），本链路绝不改变谁能看到这个应用。
    const { visibleSuggest, blackVisibleSuggest } = parseOnlineVisibility(
      await client.postJson(`/developers/v1/visible/online/${appId}`, {}),
    );
    const versionList = await client.postJson(`/developers/v1/app_version/list/${appId}`, {});
    const appVersion = nextAppVersion(versionList);

    // 3) 构造并写基础信息。
    const baseInfoPayload = await spec.buildBaseInfoPayload({ client, base, langs, desc, i18nBlocks });
    await client.postJson(`/developers/v1/base_info/${appId}`, { clientId: appId, ...baseInfoPayload });

    // 4) 建版发布。
    const payload = buildAppVersionCreatePayload(appVersion, []) as unknown as Record<string, unknown>;
    payload.visibleSuggest = visibleSuggest;
    payload.blackVisibleSuggest = blackVisibleSuggest;
    payload.changeLog = spec.changeLog;
    payload.remark = spec.remark;
    const created = await client.postJson(`/developers/v1/app_version/create/${appId}`, payload);
    const versionId = extractVersionId(created);
    if (!versionId) {
      return { ok: false, reason: 'api_error', message: '开放平台没有返回新版本 versionId，无法发布新版本' };
    }
    await client.postJson(`/developers/v1/publish/commit/${appId}/${versionId}`, { clientId: appId });
    logger.info(`[${spec.logLabel}:${appId}] ${spec.logSummary} (version ${appVersion} / ${versionId})`);
    return { ok: true, versionId };
  } catch (err) {
    return { ok: false, ...failureFromError(err) };
  }
}

/**
 * 把飞书应用改名并发布新版本让群内显示名生效。名字会写到应用已配置的**每种
 * 语言**（用户输入什么就统一显示什么），描述等其余基础信息保持不变。
 */
export async function renameBotOnOpenPlatform(
  appId: string,
  newName: string,
  brand: Brand | undefined,
  deps: OpenPlatformRenameDeps = {},
): Promise<OpenPlatformRenameResult> {
  const r = await applyBaseInfoChangeAndRepublish(appId, brand, deps, {
    changeLog: `Rename to ${newName}`,
    remark: 'Rename bot via botmux dashboard',
    logLabel: 'rename',
    logSummary: `Open Platform rename → "${newName}"`,
    async buildBaseInfoPayload({ langs, desc, i18nBlocks }) {
      const i18n: Record<string, unknown> = {};
      for (const lang of langs) {
        i18n[lang] = { ...i18nBlocks[lang], name: newName };
      }
      return { name: newName, desc, languages: langs, i18n };
    },
  });
  return r.ok ? { ok: true, name: newName, versionId: r.versionId } : r;
}

// ── 改头像 ───────────────────────────────────────────────────────────────────

export type OpenPlatformAvatarResult =
  | { ok: true; avatarUrl: string; versionId?: string }
  | { ok: false; reason: OpenPlatformRenameFailureReason | 'invalid_image'; message: string };

/** console 图片上传链路只实测过 512×512 PNG（上传表单的 scale 也如此声明），
 *  收紧到这一种形态——前端上传前会用 canvas 归一化，非法输入在这里兜底拒绝。 */
export const AVATAR_IMAGE_SIZE = 512;
export const AVATAR_IMAGE_MAX_BYTES = 2 * 1024 * 1024;

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
// PNG 规范：魔数(8) 后必须紧跟 IHDR chunk —— 长度(4，恒为 13) + 类型 'IHDR'(4)
// + 数据 13（宽 4 + 高 4 + 位深等 5）+ CRC(4)，合计头部至少 33 字节。
const PNG_MIN_HEADER_BYTES = 8 + 4 + 4 + 13 + 4;
const PNG_IHDR_DATA_LENGTH = 13;

/** CRC-32（IEEE 802.3 反射多项式 0xEDB88320，即 PNG 规范用的那个）。
 *  node:zlib 的 crc32 到 v22.2.0 才加入，而仓库 engines 只要求 >=22——为兼容
 *  22.0/22.1 内置实现；只算 IHDR 的 17 字节，无查表的逐位实现开销可忽略。
 *  测试侧用 node:zlib.crc32 生成样本 CRC，与本实现互为交叉验证。 */
function crc32Ieee(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i];
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** PNG 魔数 + IHDR chunk 结构（长度/类型/CRC）+ 尺寸校验。只认魔数会把
 *  offset 16/20 上伪造尺寸、实际没有 IHDR 的字节流放进 console 上传；CRC
 *  校验（覆盖 chunk 类型+数据，PNG 规范）把手工拼接的伪头也挡在本地 400。 */
export function validateAvatarPng(data: Buffer): { ok: true } | { ok: false; message: string } {
  if (data.length > AVATAR_IMAGE_MAX_BYTES) {
    return { ok: false, message: `头像图片过大（上限 ${AVATAR_IMAGE_MAX_BYTES / 1024 / 1024}MB）` };
  }
  if (data.length < PNG_MIN_HEADER_BYTES || !data.subarray(0, 8).equals(PNG_MAGIC)) {
    return { ok: false, message: '头像图片必须是 PNG 格式' };
  }
  if (data.readUInt32BE(8) !== PNG_IHDR_DATA_LENGTH || data.subarray(12, 16).toString('latin1') !== 'IHDR') {
    return { ok: false, message: '头像图片必须是 PNG 格式（缺少合法的 IHDR 头）' };
  }
  const storedCrc = data.readUInt32BE(12 + 4 + PNG_IHDR_DATA_LENGTH);
  const actualCrc = crc32Ieee(data.subarray(12, 12 + 4 + PNG_IHDR_DATA_LENGTH));
  if (storedCrc !== actualCrc) {
    return { ok: false, message: '头像图片必须是 PNG 格式（IHDR CRC 校验失败）' };
  }
  const width = data.readUInt32BE(16);
  const height = data.readUInt32BE(20);
  if (width !== AVATAR_IMAGE_SIZE || height !== AVATAR_IMAGE_SIZE) {
    return { ok: false, message: `头像图片必须是 ${AVATAR_IMAGE_SIZE}×${AVATAR_IMAGE_SIZE}（收到 ${width}×${height}）` };
  }
  return { ok: true };
}

function pickUploadedUrl(payload: unknown): string {
  const rec = asRecord(payload);
  if (typeof rec.url === 'string' && rec.url) return rec.url;
  const nested = asRecord(rec.data).url;
  return typeof nested === 'string' && nested ? nested : '';
}

/**
 * 把飞书应用头像换成给定图片并发布新版本让群内头像生效。链路与改名同款：
 * 先上传图片到 console 拿 url（对应用本身无副作用），再全量回写 base_info
 * （名字/描述/i18n 原样保留 + 新 avatar），最后镜像线上可见范围建版发布。
 */
export async function changeBotAvatarOnOpenPlatform(
  appId: string,
  image: Buffer,
  brand: Brand | undefined,
  deps: OpenPlatformRenameDeps = {},
): Promise<OpenPlatformAvatarResult> {
  const valid = validateAvatarPng(image);
  if (!valid.ok) return { ok: false, reason: 'invalid_image', message: valid.message };

  let avatarUrl = '';
  const r = await applyBaseInfoChangeAndRepublish(appId, brand, deps, {
    changeLog: 'Update bot avatar',
    remark: 'Update bot avatar via botmux dashboard',
    logLabel: 'avatar',
    logSummary: 'Open Platform avatar updated',
    async buildBaseInfoPayload({ client, base, langs, desc, i18nBlocks }) {
      // base_info 是全量写接口，名字必须原样回写；当前名字读不到时宁可中止，
      // 也不发布一个可能清空名字的版本（desc / i18n 块已由链路 fail-closed 校验）。
      const currentName = typeof base.name === 'string' && base.name ? base.name : '';
      if (!currentName) throw new Error('开放平台没有返回应用当前名称，已中止改头像（避免覆盖名字）');

      const form = new FormData();
      // 拷贝成独立 ArrayBuffer 的视图：入参 Buffer 可能是池化切片（byteOffset≠0），
      // 类型上也进不了 BlobPart（ArrayBufferLike vs ArrayBuffer）。
      form.append('file', new Blob([new Uint8Array(image)], { type: 'image/png' }), 'avatar.png');
      form.append('uploadType', '4'); // Open Platform console enum: Icon
      form.append('isIsv', 'false'); // 企业自建应用
      form.append('scale', JSON.stringify({ width: AVATAR_IMAGE_SIZE, height: AVATAR_IMAGE_SIZE }));
      const uploaded = await client.postForm('/developers/v1/app/upload/image', form);
      const url = pickUploadedUrl(uploaded);
      if (!url) throw new Error('开放平台上传头像后没有返回 url');
      avatarUrl = url;

      const i18n: Record<string, unknown> = {};
      for (const lang of langs) {
        const cur = i18nBlocks[lang];
        i18n[lang] = { ...cur, name: typeof cur.name === 'string' && cur.name ? cur.name : currentName };
      }
      return { name: currentName, desc, languages: langs, i18n, avatar: url };
    },
  });
  return r.ok ? { ok: true, avatarUrl, versionId: r.versionId } : r;
}
