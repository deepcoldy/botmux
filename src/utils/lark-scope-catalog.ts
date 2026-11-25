/**
 * The set of Lark USER scopes that actually exist.
 *
 * Worth validating against rather than trusting the caller: a misspelled scope
 * does not degrade gracefully. Feishu rejects the whole authorize URL with
 * 20043, so the person is handed a link that simply fails to open — with no
 * indication that one word in it was wrong. That has already happened here once
 * (commit 487e297d: a bare `docs:document.comment`, which is not a real scope).
 *
 * The generated `botmux setup` catalog supplies the default names. Additional
 * names below are accepted at runtime without adding them to app setup.
 */
// Import attribute rather than a runtime read: this is how cli.ts already
// bundles the same file, so the catalog travels with the build (including the
// compiled binary) instead of depending on a path that exists only in a source
// checkout.
import scopeManifest from '../setup/lark-scopes.json' with { type: 'json' };

const USER_SCOPES: ReadonlySet<string> = new Set(
  (scopeManifest as { scopes?: { user?: string[] } }).scopes?.user ?? [],
);

/** 用 User Token 下载消息里的图片/文件需要的权限。 */
export const RESOURCE_DOWNLOAD_OAUTH_SCOPES: readonly string[] = ['im:resource'];

/**
 * 按需授权的用户权限：不进 /login 默认集；旧 token 里随默认集带来的不随后续授权延续，
 * 只有本人显式申请并拿到过的才延续（见 user-token.ts 的 authorizationScopes）。
 *
 * 用户身份的 `im:resource` 要企业管理员审批。一次授权只要包含应用尚未开通的用户权限，
 * 飞书会在授权页自动生成「Scope Authorization」版本并把本次申请里的这类权限一起放进去，
 * 带上它整个版本就卡在企业管理员审核（实测取消这一项后版本随即通过）。botmux 的权限清单
 * 本来也只给它开应用身份（lark-scopes.json 的 user 桶里没有它）。
 */
export const ON_DEMAND_USER_SCOPES: readonly string[] = RESOURCE_DOWNLOAD_OAUTH_SCOPES;

/**
 * 飞书确有用户身份、但 botmux 的默认权限清单（user 桶）没有的 scope。
 * 清单里不放是为了建 bot 时不申请，但老应用、extra-scopes 或按需授权仍须通过名称校验。
 *
 * 这里只放行名称校验；是否影响旧 token 续权由 ON_DEMAND_USER_SCOPES 单独决定。
 * 从默认 user 清单移除的历史合法项可以留在这里，切勿因此加入 ON_DEMAND_USER_SCOPES。
 */
const EXTRA_USER_SCOPES: ReadonlySet<string> = new Set([
  'im:chat',
  'im:chat:readonly',
  'docs:document.comment:update',
  'docx:document.block:convert',
  'minutes:minutes.artifacts:read',
  'minutes:minutes.basic:read',
  'minutes:minutes.media:export',
  'minutes:minutes.search:read',
  'minutes:minutes.transcript:export',
  'minutes:minutes:readonly',
  'vc:meeting.search:read',
  'vc:note:read',
  'vc:record:readonly',
  ...ON_DEMAND_USER_SCOPES,
]);

export function isValidLarkScopeSyntax(scope: string): boolean {
  return /^[a-z0-9_]+(:[a-z0-9_.-]+)+$/i.test(scope) || scope === 'offline_access';
}

/** Whether `scope` is a real Lark user scope. An empty catalog accepts
 *  everything, so a packaging problem cannot lock people out of /login.
 *  When `options.allowUnknown` is true (or BOTMUX_ALLOW_UNKNOWN_SCOPES=1),
 *  syntactically valid Lark scopes are accepted as an escape hatch. */
export function isKnownLarkUserScope(
  scope: string,
  options?: { allowUnknown?: boolean },
): boolean {
  if (USER_SCOPES.size === 0) return true;
  if (USER_SCOPES.has(scope) || EXTRA_USER_SCOPES.has(scope)) return true;
  if (options?.allowUnknown || process.env.BOTMUX_ALLOW_UNKNOWN_SCOPES === '1') {
    return isValidLarkScopeSyntax(scope);
  }
  return false;
}
