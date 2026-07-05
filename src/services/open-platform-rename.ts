/**
 * 飞书应用真·改名 —— 复用 `botmux setup` 的开放平台自动化机制（缓存的飞书 Web
 * 登录态 + console 内部 `/developers/v1/*` 接口），把 dashboard 的「机器人改名」
 * 落到飞书应用本身，而不只是 botmux 侧展示名。
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

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

// visible/online 各集合的 id 字段族：console 内部接口的条目形态没有公开契约，
// members 实测是 { id }，departments / groups 未实测——按开放平台常见命名把
// 候选 key 都列上，并配合下面的 fail-closed 兜底。
const MEMBER_ID_KEYS = ['id', 'openId', 'open_id', 'userId', 'user_id', 'memberId', 'member_id'];
const DEPARTMENT_ID_KEYS = ['id', 'departmentId', 'department_id', 'openDepartmentId', 'open_department_id'];
const GROUP_ID_KEYS = ['id', 'groupId', 'group_id', 'chatId', 'chat_id', 'openChatId', 'open_chat_id'];

/** 可见范围条目形态未识别 —— 绝不能发布可能改变可见性的版本，fail closed。 */
class VisibilityParseError extends Error {
  constructor(readonly collection: string) {
    super(`visible/online ${collection} 条目形态未识别，已中止改名（避免把非空可见范围发布成空）`);
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
 * {@link VisibilityParseError}——部分丢失同样会收窄可见范围，宁可中止改名
 * 走 displayName 降级，也不发布一个"看起来成功"但少了人的版本。
 */
function idList(value: unknown, keys: string[], collection: string): string[] {
  if (!Array.isArray(value)) return [];
  const ids = value.map((item) => pickIdByKeys(item, keys)).filter(Boolean);
  if (ids.length < value.length) throw new VisibilityParseError(collection);
  return ids;
}

/** visible/online 的白/黑名单块 → 版本 payload 的 visibleSuggest 形态。 */
function visibilityBlock(raw: unknown, label: string): { departments: string[]; members: string[]; groups: string[]; isAll: number } {
  const rec = asRecord(raw);
  return {
    departments: idList(rec.departments, DEPARTMENT_ID_KEYS, `${label}.departments`),
    members: idList(rec.members, MEMBER_ID_KEYS, `${label}.members`),
    groups: idList(rec.groups, GROUP_ID_KEYS, `${label}.groups`),
    isAll: rec.isAll === 1 || rec.isAll === true ? 1 : 0,
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
  if (normalizeBrand(brand) !== 'feishu') {
    return { ok: false, reason: 'unsupported_brand', message: '开放平台自动改名当前只支持 feishu.cn 租户；国际版请到开放平台后台手动修改' };
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
  const langs = Array.isArray(base.langs) && base.langs.length > 0
    ? base.langs.filter((l): l is string => typeof l === 'string')
    : [primaryLang];
  const i18nCurrent = asRecord(base.i18n);
  const i18n: Record<string, unknown> = {};
  for (const lang of langs) {
    i18n[lang] = { ...asRecord(i18nCurrent[lang]), name: newName };
  }

  try {
    // 2) 预读并解析所有后续要用的数据 —— 在第一笔写操作之前完成。可见范围
    //    条目形态未识别会在这里 fail closed（VisibilityParseError），此时
    //    连名字都还没写，零副作用地退回 displayName 降级。
    //    群内显示名跟随已发布版本 → 必须建新版本并发布；可见范围原样镜像
    //    线上版本（白/黑名单都带上），改名绝不改变谁能看到这个应用。
    const online = asRecord(asRecord(await client.postJson(`/developers/v1/visible/online/${appId}`, {})).data);
    const visibleSuggest = visibilityBlock(online.whiteList ?? online, 'whiteList');
    const blackVisibleSuggest = visibilityBlock(online.blackList, 'blackList');
    const versionList = await client.postJson(`/developers/v1/app_version/list/${appId}`, {});
    const appVersion = nextAppVersion(versionList);

    // 3) 写基础信息（名字）。
    await client.postJson(`/developers/v1/base_info/${appId}`, {
      clientId: appId,
      name: newName,
      desc: typeof base.desc === 'string' ? base.desc : '',
      languages: langs,
      i18n,
    });

    // 4) 建版发布。
    const payload = buildAppVersionCreatePayload(appVersion, []) as unknown as Record<string, unknown>;
    payload.visibleSuggest = visibleSuggest;
    payload.blackVisibleSuggest = blackVisibleSuggest;
    payload.changeLog = `Rename to ${newName}`;
    payload.remark = 'Rename bot via botmux dashboard';
    const created = await client.postJson(`/developers/v1/app_version/create/${appId}`, payload);
    const versionId = extractVersionId(created);
    if (!versionId) {
      return { ok: false, reason: 'api_error', message: '开放平台没有返回新版本 versionId，无法发布改名版本' };
    }
    await client.postJson(`/developers/v1/publish/commit/${appId}/${versionId}`, { clientId: appId });
    logger.info(`[rename:${appId}] Open Platform rename → "${newName}" (version ${appVersion} / ${versionId})`);
    return { ok: true, name: newName, versionId };
  } catch (err) {
    return { ok: false, ...failureFromError(err) };
  }
}
