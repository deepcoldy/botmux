/**
 * Dashboard 请求身份解析与门禁选择。
 *
 * 从 dashboard.ts 抽出来的原因有两个：一是这段判定同时决定「你是谁」和「走哪套
 * 门禁」，是整个 Dashboard 最敏感的一段分支，必须能被真实请求直接测到；二是
 * P1-7 的错乱就发生在「身份已经解析成 legacy owner，门禁却另算一遍」的缝里。
 *
 * P1-7（双 Cookie 身份错乱）：浏览器同时握着 legacy 管理 cookie 与 H5 会话
 * cookie 时（先扫码进 H5 工作台、再点开管理链接，或反过来），身份解析
 * {@link resolveDashboardIdentity} 已经按「legacy 优先」给出 legacy owner，但旧
 * 代码的门禁选择读的是 **另算的** `h5Identity`：只要 H5 cookie 存在就一律走窄门
 * 禁 `decideWorkbenchH5Auth`，还顺手把 `presentedToken` 清成 undefined。后果是
 * 真 owner 拿不到 `/api/settings`、`/api/sessions/:id/view-link`（401），而且连
 * 正确的 `?t=` 也被清掉——没法通过重新点管理链接自救；卡片票据种完 cookie 之后
 * 同样还是 401，因为 H5 cookie 还在。
 *
 * 修法：门禁选择只看 **一个** 身份结论，并且取更高权限的那个——已经是有效 legacy
 * owner（或本请求带着与当前活跃 token 相符的凭据）就不因为存在 H5 cookie 而降级
 * 成 workbench-only。唯一继续压制 `presentedToken` 的是平台注入 cookie 的场景：
 * 那枚 cookie 只证明「机器跳板」，用户权限是 `X-Botmux-Role`，不能被重新解读成
 * 本机 owner。
 */
import type { IncomingMessage } from 'node:http';
import type { DashboardAuthIdentity } from './h5-auth.js';
import type { TerminalDashboardActor } from './terminal-control.js';
import { decideDashboardAuth, decideWorkbenchH5Auth, type AuthDecision } from './auth.js';

export interface DashboardRequestIdentity extends TerminalDashboardActor {
  kind: 'legacy-dashboard' | 'platform-dashboard' | DashboardAuthIdentity['kind'];
  previewCapability: 'operate' | 'readonly';
}

export interface DashboardIdentityInput {
  /** 请求里的 legacy Dashboard cookie（`parseCookie` 的结果）。 */
  legacyCookie: string | undefined;
  /** 落盘的当前活跃管理 token。 */
  activeToken: string | null;
  /** 中心化平台注入的 `X-Botmux-Role`（仅在已绑定平台时有意义）。 */
  roleHeader: string | string[] | undefined;
  /** 已绑定平台的 machineId；未绑定为 null。 */
  platformMachineId: string | null;
  /** machineId → 平台 actor 作用域（HMAC，调用方与 liveness 检查共用同一实现）。 */
  platformActorScope: (machineId: string) => string;
  /** 活跃 token → legacy authSessionId（HMAC）。 */
  legacyAuthSessionId: (token: string) => string;
  /** 已解析的 H5 会话身份（无则 null）。 */
  h5: DashboardAuthIdentity | null;
}

/**
 * 身份优先级：legacy 管理 cookie > 平台注入角色 > H5 会话。
 *
 * 中心化平台通过「剥掉浏览器 Cookie 头、注入本机活跃 cookie」证明自己的边界，
 * 所以带 `X-Botmux-Role` 的活跃 cookie 保留平台角色，而不是塌缩成一个 legacy
 * owner。本机直连的 owner 加这个头只会**降低**自己的权限（知道活跃 cookie 本身
 * 就已经是 owner 权限），因此不需要额外防护。
 */
export function resolveDashboardIdentity(input: DashboardIdentityInput): DashboardRequestIdentity | null {
  const { activeToken } = input;
  if (activeToken && input.legacyCookie === activeToken) {
    const rawRole = input.roleHeader;
    const platformRole = input.platformMachineId && typeof rawRole === 'string'
      && (rawRole === 'owner' || rawRole === 'teammate' || rawRole === 'guest')
      ? rawRole
      : undefined;
    if (platformRole && input.platformMachineId) {
      const machineScope = input.platformActorScope(input.platformMachineId);
      return {
        kind: 'platform-dashboard',
        userId: `platform:${machineScope}:${platformRole}`,
        authSessionId: `${machineScope}:${platformRole}`,
        expiresAt: Number.MAX_SAFE_INTEGER,
        terminalCapability: platformRole === 'owner' ? 'owner' : 'readonly',
        previewCapability: platformRole === 'owner' ? 'operate' : 'readonly',
      };
    }
    return {
      kind: 'legacy-dashboard',
      userId: 'legacy-owner',
      authSessionId: input.legacyAuthSessionId(activeToken),
      // Terminal leases are independently capped to fifteen minutes or less.
      expiresAt: Number.MAX_SAFE_INTEGER,
      terminalCapability: 'controlled',
      previewCapability: 'operate',
    };
  }
  return input.h5 ? {
    ...input.h5,
    terminalCapability: 'controlled',
    previewCapability: 'operate',
  } : null;
}

export interface DashboardRequestGate {
  /** 本机管理能力（settings / schedules / groups / debug shell 的唯一凭据）。 */
  legacyAuthed: boolean;
  /** 只有工作台能力：H5 会话或平台角色，且本请求没有管理凭据。 */
  workbenchOnlyIdentity: boolean;
  /** 交给 `decideDashboardAuth` 的凭据；平台注入 cookie 场景恒为 undefined。 */
  presentedToken: string | undefined;
  decision: AuthDecision;
}

export function resolveDashboardRequestGate(input: {
  method: string;
  pathname: string;
  hasTokenParam: boolean;
  identity: DashboardRequestIdentity | null;
  /** `authedToken(req, url, activeToken)`：优先正确的 `?t=`，否则 cookie。 */
  tokenFromRequest: string | undefined;
  activeToken: string | null;
  publicReadOnly: boolean;
}): DashboardRequestGate {
  const legacyAuthed = input.identity?.kind === 'legacy-dashboard';
  const platformIdentity = input.identity?.kind === 'platform-dashboard';
  // 只有平台跳板那枚注入 cookie 需要压制：它认证的是机器，不是用户权限。
  // H5 cookie 不该压制——压了就把「同时握有正确 ?t= / 管理 cookie」的浏览器
  // 降级成 workbench-only，正是 P1-7。
  const presentedToken = platformIdentity ? undefined : input.tokenFromRequest;
  const managementCredential = !!presentedToken && !!input.activeToken
    && presentedToken === input.activeToken;
  const workbenchOnlyIdentity = !legacyAuthed && !managementCredential
    && (platformIdentity || input.identity?.kind === 'feishu-h5');
  const decision = workbenchOnlyIdentity
    ? decideWorkbenchH5Auth({ method: input.method, pathname: input.pathname })
    : decideDashboardAuth({
      method: input.method,
      pathname: input.pathname,
      hasTokenParam: input.hasTokenParam,
      presentedToken,
      activeToken: input.activeToken ?? '',
      publicReadOnly: input.publicReadOnly,
    });
  return { legacyAuthed, workbenchOnlyIdentity, presentedToken, decision };
}

/** 便于把 `IncomingMessage` 直接喂给上面的纯函数（测试与真实服务共用一条路径）。 */
export function requestRoleHeader(req: IncomingMessage): string | string[] | undefined {
  return req.headers['x-botmux-role'];
}
