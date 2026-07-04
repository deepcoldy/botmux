/**
 * 凭证 + 权限自检. 不阻塞 setup / daemon 启动, 任意失败都降级到"打印剩余步骤".
 *
 * 主路径只用:
 * - {@link validateCredentials} —— 取一次 `tenant_access_token`, 通过才认为
 *   AppID/Secret 有效. 没拿到才会让 setup 失败 (拒绝写 bots.json).
 *
 * 仅作为可选 helper, **未启用于 setup / start 主链路**:
 * - {@link checkRequiredScopes} —— 调 `application.v6.scope.list` 比对 botmux
 *   需要的 scope. 待 spike 用真实/可复现 mock 证明 grant_status 闭环后再启用.
 * - {@link applyScopesUnverified} —— 调 `application.v6.scope.apply` 触发管理
 *   员审批. Lark 文档表明它只能提交"已声明但未授权"的 scope, 不能给 manifest
 *   加新 scope, 所以无法绕开"用户去开放平台勾"这步; 同样待 spike 后启用.
 *
 * 安全约束:
 * - Secret 永远不进 console / 日志 / 错误链
 * - 网络/接口错误一律返回结构化结果, 不抛
 */
import * as Lark from '@larksuiteoapi/node-sdk';
import { type Brand, larkHosts } from '../im/lark/lark-hosts.js';
import { DOC_COMMENT_OAUTH_SCOPES } from '../utils/user-token.js';

// Brand 的单一事实源在 im/lark/lark-hosts.ts；这里 re-export 保持既有导入路径可用。
export type { Brand };

export interface RequiredScope {
  /** 飞书 scope 名 (`im:message` 等) */
  name: string;
  /** 给用户看的中文说明 */
  desc: string;
  /**
   * `critical` = 不开通 botmux 核心功能无法工作 (收发消息).
   * 非 critical 的 scope 缺失只 WARN, 不阻断启动.
   */
  critical: boolean;
}

/**
 * botmux 运行所需的 scope. 这里**只用于检测/提示**, 不用于自动申请——飞书
 * `scope.apply` 只能提交"已声明但未授权"的, 没法给应用 manifest 加新声明.
 * scope 选择必须用户去开放平台勾.
 *
 * **每个 name 必须是 lark-scopes.json manifest 里真实存在的 scope**, 否则
 * `application/v6/applications/{id}` 返回的授权列表里永远找不到, 会把
 * 已正确授权的用户误报"缺权限"。`test/setup-verify-permissions.test.ts` 里
 * 的 manifest 一致性测试用 lark-scopes.json 兜底防止这类裸名再溜进来。
 */
export const BOTMUX_REQUIRED_SCOPES: RequiredScope[] = [
  { name: 'im:message', desc: '收发消息', critical: true },
  { name: 'im:message.group_at_msg:readonly', desc: '群消息接收', critical: true },
  // 没有这个 scope，listChatMessages（container_id_type=chat）只能拿到 @bot 的
  // 消息，拉不到群里的全量历史，botmux history / 群上下文回溯失效。标 critical 是
  // 为了让启动自检在它缺失时也会 DM 管理员——非 critical 的缺失只在同时缺别的
  // critical 项时才会被提示。
  { name: 'im:message.group_msg', desc: '群组历史消息读取（botmux history、群上下文）', critical: true },
  { name: 'im:resource', desc: '消息附件下载', critical: true },
  { name: 'im:chat:read', desc: '群信息读取', critical: true },
  // /group 多 bot 建群解析靠 chatMembers.isInChat 判断每个 bot 是否在群。该 API
  // 接受 im:chat / im:chat:readonly / im:chat.members:read / im:chat.group_info:readonly
  // 任一即可（OR），但实际可申请的只有 im:chat.members:read，故只校验它。缺它时
  // isInChat 抛 Access denied 被吞，bot 静默掉出 roster，/group fail-closed 建不了群。
  { name: 'im:chat.members:read', desc: '群成员读取（/group 建群解析、判断 bot 是否在群）', critical: true },
  // 拉群把人/机器人加进群（chatMembers.create）需要写权限；缺它时建群能成、加成员
  // 报 code 99991672 Access denied → 跨部署拉群「机器人进了但人没进」。拉群是核心刚需
  // 功能，标 critical：缺它时启动自检直接 DM 管理员，不再静默报「all scopes granted」。
  { name: 'im:chat.members:write_only', desc: '群成员写入（/group、跨部署拉群把人和机器人加进群）', critical: true },
  // 除用户基本信息外，/grant 自动登记 & /introduce 用它查通讯录区分真人/机器人
  // （isHumanOpenId）：缺这权限时真人无法被剔除，会混进机器人协作名单 <available_bots>
  // 误导模型。已是 critical，启动自检（checkRequiredScopes）缺失即 DM 管理员。
  { name: 'contact:user.base:readonly', desc: '用户基本信息（也用于 /grant、/introduce 判定真人/机器人；缺失会让真人混入机器人协作名单）', critical: true },
  // event-dispatcher.checkRequiredScopes 历史上一直对这一项 DM 管理员（"多 bot
  // 协作收不到事件"），等价于 critical 处理；保留 critical 标记是为了让启动
  // 时的统一巡检循环也覆盖它。
  { name: 'im:message.group_at_msg.include_bot:readonly', desc: '跨 bot @ 事件', critical: true },
  { name: 'application:application:self_manage', desc: '应用自查 (免审批)', critical: false },
];

/** 文档评论入口（/subscribe-lark-doc）专用的 app 权限。**不在** BOTMUX_REQUIRED_SCOPES
 *  里——它是 opt-in 特性，只对「已订阅过文档」的 bot 启动自检（见
 *  event-dispatcher.checkRequiredScopes 的文档就绪分支），不给没用该特性的 bot 添噪。
 *  名字单一事实源 = utils/user-token.DOC_COMMENT_OAUTH_SCOPES（同名 OAuth user scope），
 *  这里补中文说明；test 兜底两者一致 + 都在 lark-scopes.json manifest 内。 */
const DOC_SCOPE_DESC: Record<string, string> = {
  'docs:document.subscription': '订阅云文档事件（评论新增）',
  'docs:event:subscribe': '云文档事件订阅',
  'docs:document.comment:read': '读取文档评论',
  'docs:document.comment:create': '回复 / 新建文档评论',
  'wiki:wiki:readonly': '解析 wiki 节点（订阅 wiki 文档时）',
};
export const DOC_FEATURE_SCOPES: RequiredScope[] = DOC_COMMENT_OAUTH_SCOPES.map((name) => ({
  name,
  desc: DOC_SCOPE_DESC[name] ?? name,
  critical: false,
}));

/** 文档评论入口需要订阅的事件——飞书无「列出已订阅事件」的 API，无法自检，仅在
 *  启动就绪检查里据此提醒管理员去开发者后台订阅。 */
export const DOC_COMMENT_EVENT = 'drive.notice.comment_add_v1';

export interface RemainingStep {
  title: string;
  /** 飞书开放平台深链, 用户点了直接到对应页 */
  url: string;
}

export function buildScopeDeepLink(appId: string, scopeName: string, brand: Brand = 'feishu'): string {
  return `${larkHosts(brand).openApi}/app/${appId}/auth?q=${encodeURIComponent(scopeName)}&op_from=openapi&token_type=tenant`;
}

export function buildEventSubDeepLink(appId: string, brand: Brand = 'feishu'): string {
  return `${larkHosts(brand).openApi}/app/${appId}/dev-config/event-sub`;
}

export function buildAppHomeDeepLink(appId: string, brand: Brand = 'feishu'): string {
  return `${larkHosts(brand).openApi}/app/${appId}`;
}

// ─── Credential validation ─────────────────────────────────────────────────

export type CredentialValidation =
  | { ok: true; tenantAccessToken: string; tokenExpiresIn: number }
  | { ok: false; error: 'invalid_credentials' | 'network' | 'unknown'; message: string };

/**
 * 用 AppID/Secret 取一次 tenant_access_token, 验证凭证可用.
 *
 * Secret 不进 error.message: 错误信息只来自飞书返回的 msg 字段或 axios 错误类型.
 *
 * Codex review #3: 加 AbortController + 总超时. 网络半挂时 `botmux setup` /
 * `botmux start` 不能无限卡住; 超时归类为 network, 这样 setup 走"凭证校验失败
 * 不写盘" 路径, start 走"network 只 WARN 继续"路径.
 */
export async function validateCredentials(
  appId: string,
  appSecret: string,
  brand: Brand = 'feishu',
  opts: { budgetMs?: number; signal?: AbortSignal } = {},
): Promise<CredentialValidation> {
  const budgetMs = opts.budgetMs ?? 10_000;
  const url = `${larkHosts(brand).openApi}/open-apis/auth/v3/tenant_access_token/internal`;

  // 自家 AbortController 控制总超时; 同时把上层传进来的 signal 也接上.
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), budgetMs);
  if (opts.signal) {
    if (opts.signal.aborted) ac.abort();
    else opts.signal.addEventListener('abort', () => ac.abort(), { once: true });
  }

  // Codex review v2 follow-up: timer 必须覆盖 res.json() 阶段, 否则飞书极端半挂
  // (body 半 chunk 后服务端不再发) 仍会卡住. clearTimeout 推迟到 JSON 解析之后.
  let res: Response;
  let body: any;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // 注意: 这是飞书唯一接受 appSecret 的端点; 其它端点全部用 token. 不要把
      // secret 拼到 query string 或日志里.
      body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
      signal: ac.signal,
    });
    body = await res.json();
  } catch (err: any) {
    clearTimeout(timer);
    // AbortError (fetch / json() 内部 / 我们自己 timeout) 全部归到 network
    const isAbort = err?.name === 'AbortError' || ac.signal.aborted;
    // JSON 解析错 (非 abort) 归 unknown, 保留旧行为
    if (!isAbort && err instanceof SyntaxError) {
      return { ok: false, error: 'unknown', message: `HTTP ${res!?.status ?? '?'} 响应非 JSON` };
    }
    return {
      ok: false,
      error: 'network',
      message: isAbort
        ? `请求超时 (> ${budgetMs}ms)`
        : `网络错误: ${err?.code ?? err?.message ?? 'unknown'}`,
    };
  }
  clearTimeout(timer);

  if (body?.code === 0 && typeof body.tenant_access_token === 'string') {
    return { ok: true, tenantAccessToken: body.tenant_access_token, tokenExpiresIn: body.expire ?? 7200 };
  }

  // 飞书常见错误码:
  // 10003 / 10012: app_id or app_secret invalid
  // 10014: 应用未发布
  // 99991663: app_secret invalid
  if (body?.code === 10003 || body?.code === 10012 || body?.code === 99991663) {
    return { ok: false, error: 'invalid_credentials', message: `凭证无效 (code=${body.code}): ${body.msg ?? ''}` };
  }

  return { ok: false, error: 'unknown', message: `code=${body?.code ?? '?'} msg=${body?.msg ?? ''}` };
}

// ─── Scope check (helper, not in main path) ──────────────────────────────

export type ScopeCheckResult =
  | {
      ok: true;
      granted: string[];
      missingCritical: RequiredScope[];
      missingOptional: RequiredScope[];
    }
  | {
      ok: false;
      /**
       * - `need_self_manage`: 调 scope.list 被拒, 应用缺 `application:application:self_manage`
       *   (鸡生蛋: 没这个 scope 就查不到 scope 列表)
       * - `network` / `unknown`: 其它失败
       */
      error: 'need_self_manage' | 'network' | 'unknown';
      message: string;
    };

/**
 * 列出应用的 scope grant 状态, 比对 BOTMUX_REQUIRED_SCOPES.
 *
 * **不在主路径使用** — 待 spike 用真实/可复现 mock 证明 grant_status 含义和
 * 状态闭环后再启用. 当前主路径只输出"剩余步骤 + 深链", 不做 grant_status 判定.
 *
 * scope.list 返回 shape (SDK type):
 *   `{ data: { scopes: [{ scope_name, grant_status, scope_type }] } }`
 * grant_status 含义未在官方文档明确, 但社区 SDK / 实测一般约定:
 *   1 = 已申请未生效, 2 = 已生效. 启用前 spike 务必确认这个映射.
 */
export async function checkRequiredScopes(
  appId: string,
  appSecret: string,
  brand: Brand = 'feishu',
): Promise<ScopeCheckResult> {
  const domain = brand === 'lark' ? Lark.Domain.Lark : Lark.Domain.Feishu;
  const client = new Lark.Client({ appId, appSecret, domain, loggerLevel: Lark.LoggerLevel.error });

  let resp: any;
  try {
    // Route through client.request() (GET empty-body guard) instead of the
    // generated application.scope.list, which sends `{}` as a GET body and
    // trips gateway 411s — same root cause as the IM read fixes. Inlined here
    // (rather than importing larkGet) to keep setup code decoupled from the
    // runtime IM client module. Resolves to { code, msg, data }, unchanged.
    resp = await (client as any).request({ method: 'GET', url: '/open-apis/application/v6/scopes' });
  } catch (err: any) {
    return { ok: false, error: 'network', message: `scope.list 调用失败: ${err?.code ?? err?.message ?? 'unknown'}` };
  }

  // SDK 失败时不抛, 返回 { code, msg }
  if (resp?.code === 99991672) {
    return {
      ok: false,
      error: 'need_self_manage',
      message: '应用缺少 application:application:self_manage 权限, 无法自查 scope 列表',
    };
  }
  if (resp?.code !== 0) {
    return { ok: false, error: 'unknown', message: `code=${resp?.code ?? '?'} msg=${resp?.msg ?? ''}` };
  }

  const scopes = resp?.data?.scopes ?? [];
  // grant_status === 2 → granted (待 spike 确认这是正确映射)
  const grantedNames: string[] = scopes
    .filter((s: any) => s?.grant_status === 2 && typeof s?.scope_name === 'string')
    .map((s: any) => s.scope_name);

  const missingCritical = BOTMUX_REQUIRED_SCOPES.filter(s => s.critical && !grantedNames.includes(s.name));
  const missingOptional = BOTMUX_REQUIRED_SCOPES.filter(s => !s.critical && !grantedNames.includes(s.name));

  return { ok: true, granted: grantedNames, missingCritical, missingOptional };
}

/**
 * 触发管理员审批 (把"已声明但未授权"的 scope 提交).
 *
 * **不在主路径使用** — 见模块顶部注释. 文档表明它无法添加新 scope 到 manifest,
 * 所以即使调成功也不能绕过"用户去开放平台勾 scope". 留作 spike 验证状态闭环
 * 后的可选自动触发能力.
 *
 * 文档/SDK 显示无请求体. 错误码:
 * - 212001: 剩余权限为高敏, 无法申请
 * - 212002: 无可申请的 scope (manifest 全部已授权或为空)
 * - 212003: 申请次数超限 (同租户同版本 > 10 次)
 * - 212004: 重复申请
 */
export interface ApplyScopesResult {
  /**
   * - `submitted`: 申请已提交 (code=0). 是否被管理员审批通过需另查 `scope.list`.
   * - `nothing_to_apply`: 212002, manifest 没有"已声明但未授权"的 scope.
   * - `already_applied`: 212004, 重复申请.
   * - `over_limit`: 212003, 同租户同版本 > 10 次申请.
   * - `super_scope_only`: 212001, 剩余为高敏权限不可申请.
   * - `timeout`: 调用本身没在 budgetMs 内返回.
   * - `error`: 其它失败.
   */
  status:
    | 'submitted'
    | 'nothing_to_apply'
    | 'already_applied'
    | 'over_limit'
    | 'super_scope_only'
    | 'timeout'
    | 'error';
  code?: number;
  msg?: string;
}

export async function applyScopesUnverified(
  appId: string,
  appSecret: string,
  opts: { brand?: Brand; budgetMs?: number; signal?: AbortSignal } = {},
): Promise<ApplyScopesResult> {
  const brand = opts.brand ?? 'feishu';
  const budgetMs = opts.budgetMs ?? 15_000;
  const domain = brand === 'lark' ? Lark.Domain.Lark : Lark.Domain.Feishu;
  const client = new Lark.Client({ appId, appSecret, domain, loggerLevel: Lark.LoggerLevel.error });

  const timeout = new Promise<ApplyScopesResult>((resolve) => {
    const timer = setTimeout(() => resolve({ status: 'timeout', msg: `> ${budgetMs}ms` }), budgetMs);
    opts.signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve({ status: 'timeout', msg: 'aborted' });
      },
      { once: true },
    );
  });

  const call = (async (): Promise<ApplyScopesResult> => {
    try {
      const resp: any = await client.application.scope.apply();
      const code = resp?.code;
      const msg = resp?.msg;
      if (code === 0) return { status: 'submitted', code, msg };
      if (code === 212001) return { status: 'super_scope_only', code, msg };
      if (code === 212002) return { status: 'nothing_to_apply', code, msg };
      if (code === 212003) return { status: 'over_limit', code, msg };
      if (code === 212004) return { status: 'already_applied', code, msg };
      return { status: 'error', code, msg };
    } catch (err: any) {
      return { status: 'error', msg: err?.code ?? err?.message ?? 'unknown' };
    }
  })();

  return Promise.race([call, timeout]);
}

// ─── Remaining-steps printer ──────────────────────────────────────────────

/**
 * setup 后 "还要手动点的步骤" 结构化数据. 跟 cli.ts 的 printRemainingSteps + README
 * "5 分钟快速接入" 一致: 主线就两步 (权限申请 + 按需重定向 URL); PersonalAgent
 * 应用默认订阅事件 + bot 能力, 不在主线提示, 收不到消息时见 README 的 fallback
 * 自查清单.
 */
export function buildRemainingSteps(appId: string, brand: Brand = 'feishu'): RemainingStep[] {
  return [
    {
      title:
        '申请权限 (一次性导入完整 JSON 提交审批) — 进入「权限管理」→「批量导入/导出权限」, 粘贴 ~/.botmux/lark-scopes.json',
      url: `${buildAppHomeDeepLink(appId, brand)}/auth`,
    },
    {
      title:
        '添加重定向 URL http://127.0.0.1:9768/callback (按需, 用于 botmux 内 /login 跨用户调 API)',
      url: `${buildAppHomeDeepLink(appId, brand)}/safe`,
    },
  ];
}
