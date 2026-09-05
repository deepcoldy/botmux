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
  /**
   * 本机管理能力（settings / schedules / groups 的读写与不脱敏）。
   *
   * 与 `legacy-dashboard` 身份的区别刻意保留：本机管理 cookie 之外，**平台授予
   * `dashboard:manage` 的协管者**也拿到这一项，但**永远拿不到** debug shell /
   * write-link / spawn-command —— 那三个仍只认 legacy 身份（见 dashboard.ts 里
   * 直接引用 `legacyAuthed` 的三处）。
   *
   * 换句话说：这个布尔是「管理面能力」，`legacyAuthed` 是「本机 owner 身份」。
   * 二者原本是同一个变量，机器协管者要求把它们分开。
   */
  canManageHost: boolean;
}

export interface DashboardIdentityInput {
  /** 请求里的 legacy Dashboard cookie（`parseCookie` 的结果）。 */
  legacyCookie: string | undefined;
  /** 落盘的当前活跃管理 token。 */
  activeToken: string | null;
  /** 中心化平台注入的 `X-Botmux-Role`（仅在已绑定平台时有意义）。 */
  roleHeader: string | string[] | undefined;
  /**
   * 中心化平台注入的 `X-Botmux-Actor`：**操作者本人**的租户 union_id。
   *
   * 为什么必须有这一维：平台身份原本只由「机器 + 角色」构成，userId 长成
   * `platform:<machineScope>:owner`，**不含人**。单 owner 时代无所谓，但平台支持
   * 机器协管者后，同一台机器会有多个人以 owner 角色进来，于是：
   *   · 审计（control-audit 按 actor.userId 记）分不出谁接管了终端；
   *   · 终端租约互斥（terminal-control 用 userId + authSessionId 判「同一个登录」）
   *     会把不同的人误判成同一人，进而**静默复用**彼此的写租约 —— 两个人同时往
   *     一个终端打字而互不知情。
   * 把它拼进 userId / authSessionId 就同时修掉这两个问题。
   *
   * 信任前提与 roleHeader 完全一致（活跃 cookie 证明请求经过平台反代），因为它们
   * 由同一个反代注入、且平台在注入前会剥掉客户端伪造的同名头。
   */
  actorHeader: string | string[] | undefined;
  /**
   * 中心化平台注入的 `X-Botmux-Scopes`：这个访问者被授予的能力清单，逗号分隔。
   *
   * 为什么用独立的头、不新增角色值：角色（owner/guest）表达的是「能不能操作终端」，
   * 而「能不能改本机配置」是另一个维度 —— 一个人可以能接管终端但不能改 settings。
   * 塞进角色就得造 `manager` / `owner-no-config` 之类的组合值，数量随维度指数增长；
   * 平台侧那张表（machines:read / sessions:open / terminal:control / dashboard:manage）
   * 本来就是勾选式的，这里如实照搬即可。`teammate` 那档从未被平台发出、成了死代码，
   * 正是「把能力硬编码进角色枚举」的前车之鉴。
   *
   * 缺失 = 没有任何额外能力（老平台、免登录只读）→ 与本改动前行为完全一致。
   * 信任前提同 roleHeader / actorHeader：只有经平台反代的请求才作数。
   */
  scopesHeader: string | string[] | undefined;
  /** 已绑定平台的 machineId；未绑定为 null。 */
  platformMachineId: string | null;
  /** machineId → 平台 actor 作用域（HMAC，调用方与 liveness 检查共用同一实现）。 */
  platformActorScope: (machineId: string) => string;
  /** 活跃 token → legacy authSessionId（HMAC）。 */
  legacyAuthSessionId: (token: string) => string;
  /** 已解析的 H5 会话身份（无则 null）。 */
  h5: DashboardAuthIdentity | null;
}

/** 平台会注入的三种角色。平台实际只发 owner / guest，teammate 保留兼容。 */
export const PLATFORM_DASHBOARD_ROLES = ['owner', 'teammate', 'guest'] as const;
export type PlatformDashboardRole = typeof PLATFORM_DASHBOARD_ROLES[number];

/**
 * 操作者标识（union_id）的合法形状。**外部输入**，虽经平台注入仍要收敛：
 * 冒号会破坏 authSessionId 的 `scope:actor:role` 分段、空格与控制字符会污染
 * 审计行（它们会被写日志、做字符串比较）。
 */
const PLATFORM_ACTOR_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

function isPlatformDashboardRole(value: string): value is PlatformDashboardRole {
  return (PLATFORM_DASHBOARD_ROLES as ReadonlyArray<string>).includes(value);
}

/**
 * 平台身份的 authSessionId **唯一构造点**：`<machineScope>[:<actor>]:<role>`。
 *
 * ⚠️ 这个格式有两个消费方在 dashboard.ts —— 读能力存活判定
 * （`terminalAuthSessionLive`）与解绑吊销（`syncPlatformBindingRevocation`）。
 * 它们曾各自硬枚举 `${scope}:owner|teammate|guest` 三个字面量，于是 actor 段一
 * 加进来就**同时**漏判：协管者的终端只读链接被判成「认证已结束」而 403，解绑后
 * 协管者已建立的写连接又扫不到、不被断开。构造与识别都收在本模块，就是为了让
 * 格式只有一个定义点，不会再漂移。
 */
export function platformDashboardAuthSessionId(
  machineScope: string,
  actor: string | undefined,
  role: PlatformDashboardRole,
): string {
  return actor ? `${machineScope}:${actor}:${role}` : `${machineScope}:${role}`;
}

/**
 * 判断某个 authSessionId 是否由本机 `machineScope` 下的平台身份签出
 * （无论平台有没有注入 actor 段）。`machineScope` 是 base64url HMAC，不含冒号，
 * 所以按冒号分段是无歧义的。
 */
export function isPlatformDashboardAuthSessionId(authSessionId: string, machineScope: string): boolean {
  const prefix = `${machineScope}:`;
  if (!authSessionId.startsWith(prefix)) return false;
  const parts = authSessionId.slice(prefix.length).split(':');
  // 无 actor（老平台 / 免登录只读）：`<scope>:<role>`
  if (parts.length === 1) return isPlatformDashboardRole(parts[0]);
  // 带 actor（协管者）：`<scope>:<actor>:<role>`
  if (parts.length === 2) return PLATFORM_ACTOR_PATTERN.test(parts[0]) && isPlatformDashboardRole(parts[1]);
  return false;
}

/**
 * 解绑吊销要吊销的平台会话集合：四个注册表在册会话的并集，按本机 scope 筛出平台身份。
 *
 * 抽成纯函数是为了让**测试能调到生产实现本身**。此前测试自己复刻了一份「四表并集 +
 * 筛选」，于是把生产代码改回硬枚举时 5 个用例仍然全绿 —— 锁的是复刻品、不是生产逻辑
 *（复审实测证伪了我原先「改回硬枚举 → 5 个全红」的说法）。
 *
 * ⚠️ 取并集而非只看写租约：一个会话可能只在其中一个表里有状态（例如只开了 SSE、
 * 还没拿写租约），只看租约会漏。**新增任何持有 authSessionId 状态的注册表，
 * 必须把它的 `authSessionIds()` 也传进这里。**
 */
export function platformAuthSessionsToRevoke(
  machineScope: string,
  registries: ReadonlyArray<{ authSessionIds(): Iterable<string> }>,
): string[] {
  const observed = new Set<string>();
  for (const r of registries) for (const id of r.authSessionIds()) observed.add(id);
  return [...observed].filter(id => isPlatformDashboardAuthSessionId(id, machineScope));
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
    const platformRole = input.platformMachineId && typeof rawRole === 'string' && isPlatformDashboardRole(rawRole)
      ? rawRole
      : undefined;
    if (platformRole && input.platformMachineId) {
      const machineScope = input.platformActorScope(input.platformMachineId);
      // 操作者 union_id：数组头（重复注入）视为缺失，与 roleHeader 同一 fail-safe。
      // 平台未注入时（老版本平台、或免登录只读）退回 machine+role，保持原行为。
      const rawActor = input.actorHeader;
      const actor = typeof rawActor === 'string' && rawActor.trim() ? rawActor.trim() : undefined;
      const actorScope = actor && PLATFORM_ACTOR_PATTERN.test(actor) ? actor : undefined;
      const authSessionId = platformDashboardAuthSessionId(machineScope, actorScope, platformRole);
      // 平台授予的能力清单。只认 dashboard:manage 这一项（其余 scope 描述的是平台侧
      // 能力，机器端无对应闸）。数组头视为缺失，与 role / actor 同一 fail-safe。
      const rawScopes = input.scopesHeader;
      const scopes = typeof rawScopes === 'string'
        ? rawScopes.split(',').map(s => s.trim()).filter(Boolean)
        : [];
      // 只有能操作终端的身份才谈得上管理本机：guest 拿到 dashboard:manage 也不放行，
      // 避免平台侧一个组合失误就把只读访客提成配置管理员（fail-closed 的乘法而非加法）。
      const canManageHost = platformRole === 'owner' && scopes.includes('dashboard:manage');
      return {
        kind: 'platform-dashboard',
        // 带上人 → 同机多个协管者在审计里可区分、租约互斥不再误判为同一登录。
        userId: `platform:${authSessionId}`,
        authSessionId,
        expiresAt: Number.MAX_SAFE_INTEGER,
        terminalCapability: platformRole === 'owner' ? 'owner' : 'readonly',
        previewCapability: platformRole === 'owner' ? 'operate' : 'readonly',
        canManageHost,
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
      // 本机管理 cookie 恒有全部管理能力（它本身就是 owner 凭据）。
      canManageHost: true,
    };
  }
  return input.h5 ? {
    ...input.h5,
    terminalCapability: 'controlled',
    previewCapability: 'operate',
    // H5 会话是 workbench 身份，从不继承本机管理能力（P1-7 的既有口径）。
    canManageHost: false,
  } : null;
}

export interface DashboardRequestGate {
  /** 本机 owner 身份（debug shell / write-link / spawn-command 的唯一凭据）。 */
  legacyAuthed: boolean;
  /**
   * 管理面能力（settings / schedules / groups 的读写与不脱敏）。
   *
   * = 本机 owner **或** 平台授予 `dashboard:manage` 的协管者。与 `legacyAuthed`
   * 分开是机器协管者的核心诉求：协管者要能帮 owner 改配置，但**不能**拿到那三个
   * 「拿到就等于拿到整台机器」的面。调用方按语义二选一，别再图省事共用一个布尔。
   */
  canManageHost: boolean;
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
  // 平台授予 dashboard:manage 的协管者：管理面路由不在 workbenchH5Capability 白名单里，
  // 所以必须走宽门禁 decideDashboardAuth，否则 /api/settings 会被 401 挡死。
  // 这样放宽是安全的 —— debug shell / write-link / spawn-command 三处**直接查
  // legacyAuthed**（不经本函数的 decision），协管者仍拿不到，见 dashboard.ts 对应三处。
  const platformManages = platformIdentity && input.identity?.canManageHost === true;
  const canManageHost = legacyAuthed || managementCredential || platformManages;
  const workbenchOnlyIdentity = !legacyAuthed && !managementCredential && !platformManages
    && (platformIdentity || input.identity?.kind === 'feishu-h5');
  const decision = workbenchOnlyIdentity
    ? decideWorkbenchH5Auth({ method: input.method, pathname: input.pathname })
    : decideDashboardAuth({
      method: input.method,
      pathname: input.pathname,
      // 平台协管者没有、也不该有本机 token；把活跃 token 同时作为「出示的凭据」
      // 喂进去，等价于告诉门禁「这个请求持有管理凭据」——凭据的真正校验已经在
      // 上面的平台反代信任前提里做完（活跃 cookie 证明请求经过平台）。
      presentedToken: platformManages ? (input.activeToken ?? undefined) : presentedToken,
      // ⚠️ 但必须同时压掉 `hasTokenParam`：`decideDashboardAuth` 有一条
      // 「首次带正确 ?t= → allow+set-cookie，把 token 回写给浏览器」的分支
      // （见 auth.ts 的 `hasTokenParam && authed && presentedToken`）。协管者的
      // presentedToken 是我们**代填**的活跃 token、不是他自己出示的，若还让
      // hasTokenParam 为真，他只要在 URL 上随便带个 `?t=x` 就会被回吐**本机真实
      // 管理 token** —— 那是长期落盘凭证，撤销协管授权也不会失效，等于永久后门。
      // 协管者本就不需要这条 cookie 引导：他的身份来自平台反代注入的 cookie。
      hasTokenParam: platformManages ? false : input.hasTokenParam,
      activeToken: input.activeToken ?? '',
      publicReadOnly: input.publicReadOnly,
    });
  return { legacyAuthed, canManageHost, workbenchOnlyIdentity, presentedToken, decision };
}

/** 便于把 `IncomingMessage` 直接喂给上面的纯函数（测试与真实服务共用一条路径）。 */
export function requestRoleHeader(req: IncomingMessage): string | string[] | undefined {
  return req.headers['x-botmux-role'];
}
