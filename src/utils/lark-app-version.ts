/**
 * 「应用最新版本是不是卡在企业审核」的只读查询，以及授权缺权限时给人看的说明。
 *
 * 为什么需要：用户授权（`/login`、`botmux auth request` 等）申请的用户权限如果还没在
 * 应用的**线上版本**里，飞书会在授权页自动生成一个「Scope Authorization」新版本并提交
 * 审核，然后照常发回 token —— 只是 token 里没有那些权限。审核要企业管理员处理，可能卡
 * 几个小时。此前 botmux 只回一个 `authorization_scope_missing`，用户和 agent 都只能
 * 猜原因（实测 agent 猜成「botmux 把应用身份专属权限拼进了默认 scope」，是错的）。
 *
 * 数据源是公开 API `GET /open-apis/application/v6/applications/:app_id/app_versions`
 * （tenant token 只能查本应用；按创建时间倒序取第一条就是最新版本）。⚠️ 它的 `status`
 * 枚举与开放平台 console 的 `app_version/list` **不同**（对照表见
 * `open-platform-automation.ts` 的 CONSOLE_VERSION_STATUS_*）：这里 3 = 审核中。
 *
 * 只读、不重试、不抛错：查不到（没权限 / 网络 / 结构不认识）一律返回 `unknown`，调用方
 * 退回「只列缺失权限」，绝不能因为这一步失败让授权结果变得更糟。
 */
import { t, type Locale } from '../i18n/index.js';
import { type Brand, larkHosts } from '../im/lark/lark-hosts.js';

/** 公开 API `app_versions[].status`：0 未知、1 审核通过（已上线）、2 审核拒绝、3 审核中、4 未提交审核。 */
export const APP_VERSION_STATUS_IN_REVIEW = 3;

export type AppVersionReviewLookup =
  /**
   * 最新版本正在审核中。`version` 是 x.y.z 版本号（接口没给时缺省）；`userScopes` 是这一版
   * 声明的用户身份权限（接口没给权限列表时缺省 = 无从核对）。
   */
  | { state: 'in_review'; version?: string; versionId?: string; userScopes?: readonly string[] }
  /** 查到了，最新版本不在审核中。 */
  | { state: 'not_in_review'; version?: string; status?: number }
  /** 查不到。`reason` 只进日志，不给用户看。 */
  | { state: 'unknown'; reason: string };

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/**
 * 解析 `app_versions?order=0`（按时间倒序）的响应，只看第一条（最新版本）。
 *
 * 只认最新那条：飞书审核期间整个应用配置写锁，不会出现「更新的版本已上线、旧版本还在审」
 * 的组合；最新一条是草稿（4）时也不往下找审核中的旧版本——那不是「新版本在审核」。
 */
export function parseLatestAppVersionReview(payload: unknown): AppVersionReviewLookup {
  const body = asRecord(payload);
  if (body.code !== 0) {
    return { state: 'unknown', reason: `app_versions code=${String(body.code ?? '?')}${body.msg ? ` msg=${String(body.msg)}` : ''}` };
  }
  const items = asRecord(body.data).items;
  if (!Array.isArray(items)) return { state: 'unknown', reason: 'app_versions items missing' };
  if (items.length === 0) return { state: 'not_in_review' };
  const latest = asRecord(items[0]);
  const status = typeof latest.status === 'number' ? latest.status : Number(latest.status);
  if (!Number.isFinite(status)) return { state: 'unknown', reason: 'app_versions status missing' };
  const version = nonEmptyString(latest.version);
  if (status === APP_VERSION_STATUS_IN_REVIEW) {
    const versionId = nonEmptyString(latest.version_id);
    const userScopes = Array.isArray(latest.scopes)
      ? latest.scopes.map(asRecord)
        // 没标 token_types 的条目按「两种身份都有」算，宁可多认也不漏认。
        .filter(entry => !Array.isArray(entry.token_types) || entry.token_types.includes('user'))
        .map(entry => nonEmptyString(entry.scope))
        .filter((scope): scope is string => !!scope)
      : undefined;
    return {
      state: 'in_review',
      ...(version ? { version } : {}),
      ...(versionId ? { versionId } : {}),
      ...(userScopes ? { userScopes } : {}),
    };
  }
  return { state: 'not_in_review', ...(version ? { version } : {}), status };
}

/**
 * 用应用自己的 tenant token 查最新版本是否在审核中。整体预算 `budgetMs`（默认 5s），
 * 外部 `signal` 先到也会中止。从不抛错。
 */
export async function lookupAppVersionReview(
  appId: string,
  appSecret: string,
  brand: Brand,
  opts: { signal?: AbortSignal; budgetMs?: number } = {},
): Promise<AppVersionReviewLookup> {
  const budget = AbortSignal.timeout(opts.budgetMs ?? 5_000);
  const signal = opts.signal ? AbortSignal.any([opts.signal, budget]) : budget;
  const openApi = larkHosts(brand).openApi;
  try {
    const tokenRes = await fetch(`${openApi}/open-apis/auth/v3/tenant_access_token/internal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
      signal,
    });
    const tokenBody = asRecord(await tokenRes.json());
    const tenantToken = nonEmptyString(tokenBody.tenant_access_token);
    if (tokenBody.code !== 0 || !tenantToken) {
      return { state: 'unknown', reason: `tenant_access_token code=${String(tokenBody.code ?? '?')}` };
    }
    const versionsRes = await fetch(
      `${openApi}/open-apis/application/v6/applications/${encodeURIComponent(appId)}/app_versions?lang=zh_cn&page_size=1&order=0`,
      { headers: { Authorization: `Bearer ${tenantToken}` }, signal },
    );
    return parseLatestAppVersionReview(await versionsRes.json());
  } catch (err) {
    return { state: 'unknown', reason: signal.aborted ? 'timeout' : (err instanceof Error ? err.message : String(err)) };
  }
}

/**
 * 缺的权限是不是（至少部分）卡在这个审核中的版本里。审核中的版本与本次缺的权限毫无关系时，
 * 「审核通过后再授权」是错误建议——通过了也拿不到。版本没给权限列表时无从核对，按相关处理。
 */
export function reviewHoldsScopes(
  review: AppVersionReviewLookup | undefined,
  missingScopes: readonly string[],
): review is Extract<AppVersionReviewLookup, { state: 'in_review' }> {
  if (review?.state !== 'in_review') return false;
  if (!review.userScopes) return true;
  return missingScopes.some(scope => review.userScopes!.includes(scope));
}

/**
 * device flow 授权回来的 token 缺权限时给人（和 agent）看的说明：先列缺了哪几项；查得到最新
 * 版本在审核中、且缺的权限就在那一版里时，再说明「审核通过后再授权/重试」，并点出不在那一版
 * 里的项。查不到版本状态时只列缺失权限，不猜原因。
 */
export function describeMissingUserScopes(
  missingScopes: readonly string[],
  review: AppVersionReviewLookup | undefined,
  locale?: Locale,
): string {
  const scopes = missingScopes.join(' ');
  if (!reviewHoldsScopes(review, missingScopes)) return t('auth_scope_missing.plain', { scopes }, locale);
  const text = review.version
    ? t('auth_scope_missing.in_review', { scopes, version: review.version }, locale)
    : t('auth_scope_missing.in_review_no_version', { scopes }, locale);
  const outside = review.userScopes ? missingScopes.filter(scope => !review.userScopes!.includes(scope)) : [];
  return outside.length
    ? `${text}${t('auth_scope_missing.not_in_review_version', { scopes: outside.join(' ') }, locale)}`
    : text;
}
