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

export type Brand = 'feishu' | 'lark';

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
 */
export const BOTMUX_REQUIRED_SCOPES: RequiredScope[] = [
  { name: 'im:message', desc: '收发消息', critical: true },
  { name: 'im:message.group_at_msg', desc: '群消息接收', critical: true },
  { name: 'im:resource', desc: '消息附件下载', critical: true },
  { name: 'im:chat', desc: '群信息读取', critical: true },
  { name: 'contact:user.base:readonly', desc: '用户基本信息', critical: true },
  { name: 'im:message.group_at_msg.include_bot:readonly', desc: '跨 bot @ 事件', critical: false },
  { name: 'application:application:self_manage', desc: '应用自查 (免审批)', critical: false },
];

export interface RemainingStep {
  title: string;
  /** 飞书开放平台深链, 用户点了直接到对应页 */
  url: string;
}

export function buildScopeDeepLink(appId: string, scopeName: string, brand: Brand = 'feishu'): string {
  const host = brand === 'lark' ? 'open.larksuite.com' : 'open.feishu.cn';
  return `https://${host}/app/${appId}/auth?q=${encodeURIComponent(scopeName)}&op_from=openapi&token_type=tenant`;
}

export function buildEventSubDeepLink(appId: string, brand: Brand = 'feishu'): string {
  const host = brand === 'lark' ? 'open.larksuite.com' : 'open.feishu.cn';
  return `https://${host}/app/${appId}/dev-config/event-sub`;
}

export function buildAppHomeDeepLink(appId: string, brand: Brand = 'feishu'): string {
  const host = brand === 'lark' ? 'open.larksuite.com' : 'open.feishu.cn';
  return `https://${host}/app/${appId}`;
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
  const host = brand === 'lark' ? 'open.larksuite.com' : 'open.feishu.cn';
  const url = `https://${host}/open-apis/auth/v3/tenant_access_token/internal`;

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
    resp = await client.application.scope.list();
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
