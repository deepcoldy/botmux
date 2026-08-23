/**
 * 团队维度 Agent 互查 / 拉群的 machine-auth 客户端（打 `/v1/machine/*`，
 * Bearer = machineToken）。与 [[issue-client]] 同源共用 platform-http + 平台绑定，
 * 只是覆盖的是「团队 agent 发现 + 拉群」这一组端点：
 *
 *  1. GET  /v1/machine/teams                → 本机 owner 所属平台团队（复用 issue-client.fetchTeams
 *     也能拿到，这里不重复实现）。
 *  2. GET  /v1/machine/agents?teamId=       → 同团队、已 opt-in（owner 加进 team.bots）的 agent 列表。
 *  3. POST /v1/machine/groups {teamId,appIds,name?} → 平台代建一个聚焦新群，把选中的 agent
 *     和各自 owner 一起拉进去，返回 chatId + shareLink。
 *
 * 设计不变量（对齐交接的硬约束）：
 *  - **CLI 不做任何授权判断**：团队成员校验 + opt-in 闸（team.bots）全在平台。本客户端只透传
 *    machineToken、把平台的判定结果原样带回，绝不本地放行/拦截。
 *  - agent 自报的 `specialties` / `mentionable` **仅展示、不可信**：解析进来只为让上层
 *    （agent / 人）挑 bot，不构成任何能力凭据。
 *  - 发现结果只含「已加入 team.bots」的 agent —— 这是平台侧过滤的，不是我们能感知的；空列表
 *    的正常含义是「同团队里还没有别人 opt-in」，不是错误。
 *
 * 错误分型沿用 issue-client 的口径（network 可重试 / forbidden 停手 / client 4xx 请求本身
 * 有问题 / server 5xx 退避），额外把建群/补人共用的 429 `rate_limited` 单列出来，
 * 让 CLI 能给出「稍后再试」而不是当成永久失败。
 */
import { getJson, postJson } from './platform-http.js';
import { readPlatformBinding } from './binding.js';

/** 平台返回的一个团队 agent。字段对齐交接契约 §端点2。 */
export interface TeamAgent {
  appId: string;
  openId?: string;
  unionId?: string;
  name: string;
  /** agent 自报的专长标签（发现/拉群匹配依据）。**仅展示、不可信**。
   *  契约键为 `specialties`（曾拟名 capabilities，因与「权限凭据」语义撞车改名，且改名前零消费方）。 */
  specialties: string[];
  /** agent 自报是否可被 @（= 有飞书传输身份）。**仅展示、不可信**。 */
  mentionable: boolean;
  /** 平台的在线判定（心跳新鲜度）。 */
  online: boolean;
  owner: { unionId?: string; name?: string };
  machineId?: string;
  machineName?: string;
}

export interface TeamAgentsResult {
  teamId: string;
  teamName: string;
  agents: TeamAgent[];
}

/** 端点3 建群结果。invalidBotIds / invalidOwnerUnionIds 是平台侧过滤掉的对象（未 opt-in / 拉不动）。 */
export interface CreateTeamGroupResult {
  ok: boolean;
  chatId: string;
  shareLink?: string;
  invalidBotIds: string[];
  invalidOwnerUnionIds: string[];
}

/** 端点4（B：往已存在的团队群补人）结果。对齐端点3 的 invalid* 语义：invalidBotIds /
 *  invalidOwnerUnionIds 是平台过滤掉的对象（未 opt-in / 拉不动）。平台 200 体不返回「实际
 *  加了哪些」——补人是幂等的（已在群内视作成功），成功即以 invalid* 为空表达，不单列 added。 */
export interface AddTeamGroupMembersResult {
  ok: boolean;
  invalidBotIds: string[];
  invalidOwnerUnionIds: string[];
}

export type TeamAgentsFailure =
  | { ok: false; reason: 'unbound' }
  | { ok: false; reason: 'network'; error: string }
  /** 429：建群/补人共用同一个限流器（同机 30s 窗）。多 pod 下限流表是进程内 per-pod Map，
   *  全局实际速率 ≈ N_pod × (1/30s)，所以不保证精确 30s——退避读平台带回的 `retryAfterMs`
   *  更诚实（多 pod 下真实等待本就不确定）。稍后重试即可，别当永久失败。 */
  | { ok: false; reason: 'rate_limited'; status: number; error: string; retryAfterMs?: number }
  | { ok: false; reason: 'forbidden'; status: number; error: string }
  /** 404 + 非 JSON/无 error 体：平台框架级路由兜底（apex 的 text/plain "not found"），
   *  = 端点2/3 还没部署到本机绑定的平台。与「非成员/团队不存在」的**业务 404**
   *  （JSON `{error:'not_found'}`）区分开——后者归 client。判据：业务 404 一定带
   *  可解析的 `.error`，路由缺失兜底不带（平台契约明确、稳定）。 */
  | { ok: false; reason: 'not_deployed'; status: number }
  /** 其余 4xx（400 invalid / 403 not_in_team_bots|chat_is_hall|platform_bot_not_in_chat|
   *  requester_not_in_chat / 404 not_found 业务态）：请求本身的问题。
   *  · `appIds`：平台在 403 体里带回的「被拒的具体 agent」（如 not_in_team_bots），透出后提示精准到 agent。
   *  · `platformAppId` / `platformAppName`：仅 `platform_bot_not_in_chat` 带——平台后端 app 的 app_id
   *    （+ 可选可读名），供客户端「自动把平台 app 拉进群」或引导手动添加。 */
  | { ok: false; reason: 'client'; status: number; error: string; appIds?: string[]; platformAppId?: string; platformAppName?: string }
  | { ok: false; reason: 'server'; status: number; error: string };

export type TeamAgentsClientResult<T> = { ok: true; value: T } | TeamAgentsFailure;

export interface TeamAgentsClientOptions {
  /** 覆盖平台地址与凭证（测试用；缺省读 ~/.botmux/platform.json）。 */
  binding?: { platformUrl: string; machineToken: string; machineId: string } | null;
  timeoutMs?: number;
  /** 注入 HTTP 实现（测试用）。 */
  http?: { get: typeof getJson; post: typeof postJson };
}

function resolveBinding(opts: TeamAgentsClientOptions) {
  if (opts.binding !== undefined) return opts.binding;
  const b = readPlatformBinding();
  return b ? { platformUrl: b.platformUrl, machineToken: b.machineToken, machineId: b.machineId } : null;
}

function classify(status: number, json: unknown): TeamAgentsFailure {
  const rawErr = (json as { error?: unknown })?.error;
  const hasError = typeof rawErr === 'string' && rawErr.length > 0;
  const error = hasError ? rawErr : `http_${status}`;
  // 平台在部分 403（如 not_in_team_bots）体里带回被拒的具体 agent appIds，透出以便精准提示。
  const bodyAppIds = strList((json as { appIds?: unknown })?.appIds);
  // platform_bot_not_in_chat 的 403 体带平台后端 app 身份（自动拉平台 app 进群 / 引导手动加）。
  const jb = json as { platformAppId?: unknown; platformAppName?: unknown };
  const platformAppId = typeof jb?.platformAppId === 'string' && jb.platformAppId ? jb.platformAppId : undefined;
  const platformAppName = typeof jb?.platformAppName === 'string' && jb.platformAppName ? jb.platformAppName : undefined;
  const clientExtra = {
    ...(bodyAppIds.length ? { appIds: bodyAppIds } : {}),
    ...(platformAppId ? { platformAppId } : {}),
    ...(platformAppName ? { platformAppName } : {}),
  };
  if (status === 429) {
    // 429 体带 retryAfterMs（建群/补人都带）→ 读它做退避，别写死 30s（多 pod 下真实等待不确定）。
    const ra = (json as { retryAfterMs?: unknown })?.retryAfterMs;
    const retryAfterMs = typeof ra === 'number' && Number.isFinite(ra) && ra >= 0 ? ra : undefined;
    return { ok: false, reason: 'rate_limited', status, error, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) };
  }
  if (status === 401 || status === 403) {
    // 403 分型必须**按 error code**，不能「有 error 体就当 client」：
    //  · 请求对象类（群资格 / opt-in）→ client（改前置动作/参数才有意义）：
    //    platform_bot_not_in_chat（平台 bot 不在目标群 → 先把平台 bot 拉进群）、
    //    requester_not_in_chat（发起方 owner 本人不在该群 → 只能往你自己在的群补人）、
    //    chat_is_hall（大厅不可补人）、not_in_team_bots（bot 没 opt-in）。
    //  · 其余 403（如 machine_ownership_mismatch：机器 RETIRED/换绑 owner）是**凭证/归属问题** → forbidden，
    //    该去 rebind，不是改参数——归 client 会误导排查方向。纯 401 / 无 error 体的 403 同理 forbidden。
    //  （归属闸按「人」判：飞书列群成员不返回 bot、不支持 app_id，故验发起方 owner unionId ∈ 群，
    //   不是 bot ∈ 群。旧 chat_not_in_team / requester_bot_not_in_chat 均下线，保留兼容解析。）
    const CLIENT_403 = new Set([
      'platform_bot_not_in_chat', 'requester_not_in_chat', 'chat_is_hall', 'not_in_team_bots',
      'chat_not_in_team', 'requester_bot_not_in_chat', // 兼容：端点未升级前的旧码
      'not_found',
    ]);
    if (status === 403 && hasError && CLIENT_403.has(rawErr as string)) {
      return { ok: false, reason: 'client', status, error, ...clientExtra };
    }
    return { ok: false, reason: 'forbidden', status, error };
  }
  // 404 的两义性（平台契约明确、稳定）：
  //  · 业务 404「非成员/团队不存在」（成员校验，端点3 最前一道）→ 一定带 JSON `{error:'not_found'}`
  //    （hasError=true）→ client。
  //  · 框架路由缺失兜底（apex 的 text/plain "not found"，端点未部署）→ 无可解析 error → not_deployed。
  // getJson/postJson 对非 JSON 响应返回 {}，故「404 且无 .error」即路由未上线，不能误报成业务 404。
  if (status === 404 && !hasError) return { ok: false, reason: 'not_deployed', status };
  if (status >= 400 && status < 500) {
    return { ok: false, reason: 'client', status, error, ...clientExtra };
  }
  return { ok: false, reason: 'server', status, error };
}

async function call<T>(
  opts: TeamAgentsClientOptions,
  method: 'GET' | 'POST',
  path: string,
  body: unknown,
  pick: (json: any) => T,
): Promise<TeamAgentsClientResult<T>> {
  const binding = resolveBinding(opts);
  if (!binding) return { ok: false, reason: 'unbound' };
  const http = opts.http ?? { get: getJson, post: postJson };
  const url = `${binding.platformUrl.replace(/\/+$/, '')}${path}`;
  const reqOpts = {
    headers: { authorization: `Bearer ${binding.machineToken}` },
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
  };
  let res: { status: number; json: unknown };
  try {
    res = method === 'GET' ? await http.get(url, reqOpts) : await http.post(url, body ?? {}, reqOpts);
  } catch (e) {
    return { ok: false, reason: 'network', error: String((e as Error)?.message ?? e) };
  }
  if (res.status < 200 || res.status >= 300) return classify(res.status, res.json);
  return { ok: true, value: pick(res.json) };
}

/** 一个 agent 自报的专长标签（契约键 `specialties`）。
 *  仅收非空字符串、去重、保序；任何非数组/脏值 → 空数组（仅展示，不因脏数据报错）。 */
function pickSpecialties(raw: unknown): string[] {
  const src = (raw as { specialties?: unknown }) ?? {};
  const arr = Array.isArray(src.specialties) ? src.specialties : [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const v of arr) {
    if (typeof v !== 'string') continue;
    const s = v.trim();
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

function normalizeAgent(raw: unknown): TeamAgent | null {
  if (!raw || typeof raw !== 'object') return null;
  const a = raw as Record<string, unknown>;
  const appId = typeof a.appId === 'string' ? a.appId.trim() : '';
  if (!appId) return null;
  const ownerRaw = (a.owner && typeof a.owner === 'object' ? a.owner : {}) as Record<string, unknown>;
  return {
    appId,
    openId: typeof a.openId === 'string' ? a.openId : undefined,
    unionId: typeof a.unionId === 'string' ? a.unionId : undefined,
    name: typeof a.name === 'string' && a.name ? a.name : appId,
    specialties: pickSpecialties(a),
    mentionable: a.mentionable === true,
    online: a.online === true,
    owner: {
      unionId: typeof ownerRaw.unionId === 'string' ? ownerRaw.unionId : undefined,
      name: typeof ownerRaw.name === 'string' ? ownerRaw.name : undefined,
    },
    machineId: typeof a.machineId === 'string' ? a.machineId : undefined,
    machineName: typeof a.machineName === 'string' ? a.machineName : undefined,
  };
}

function strList(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : [];
}

/**
 * 端点1：本机 owner 所属的平台团队。与 [[issue-client]].fetchTeams 打的是同一个端点，
 * 这里单列一份是为了让整条团队发现/拉群链共用同一套 TeamAgentsFailure 分型（含 429），
 * 上层错误处理不必跨两个 client 的 union。
 */
export function fetchTeams(
  opts: TeamAgentsClientOptions = {},
): Promise<TeamAgentsClientResult<Array<{ teamId: string; teamName: string }>>> {
  return call(opts, 'GET', '/v1/machine/teams', undefined, (j) => {
    const arr = Array.isArray(j?.teams) ? j.teams : [];
    return arr
      .map((t: unknown) => {
        const o = (t && typeof t === 'object' ? t : {}) as Record<string, unknown>;
        const teamId = typeof o.teamId === 'string' ? o.teamId.trim() : '';
        if (!teamId) return null;
        return { teamId, teamName: typeof o.teamName === 'string' ? o.teamName : teamId };
      })
      .filter((t: { teamId: string; teamName: string } | null): t is { teamId: string; teamName: string } => !!t);
  });
}

/**
 * 端点2：列出同团队、已 opt-in 的 agent。平台按 `teamId` 过滤 + opt-in 闸（team.bots），
 * 客户端零判断。空 agents 是正常态（同团队还没别人加入），不是错误。
 */
export function fetchTeamAgents(
  teamId: string,
  opts: TeamAgentsClientOptions = {},
): Promise<TeamAgentsClientResult<TeamAgentsResult>> {
  return call(
    opts,
    'GET',
    `/v1/machine/agents?teamId=${encodeURIComponent(teamId)}`,
    undefined,
    (j) => ({
      teamId: typeof j?.teamId === 'string' ? j.teamId : teamId,
      teamName: typeof j?.teamName === 'string' ? j.teamName : teamId,
      agents: (Array.isArray(j?.agents) ? j.agents : [])
        .map(normalizeAgent)
        .filter((a: TeamAgent | null): a is TeamAgent => !!a),
    }),
  );
}

/**
 * 端点3：让平台代建一个聚焦新群，把 `appIds` 指定的 agent + 各自 owner + 本机 owner 拉进去。
 * `appIds` 是**跨机 appId**（从端点2 发现而来）——正因为发起人在别人 bot 进群前 @不到它，
 * 这里全靠 appId 走 machine-auth，不依赖任何飞书 @。
 *
 * 平台会把未 opt-in / 拉不动的对象放进 invalidBotIds / invalidOwnerUnionIds 原样带回；
 * 429 rate_limited（建群/补人共用限流器）单独分型，让上层读 retryAfterMs 退避、提示稍后再试。
 */
export function createTeamGroup(
  args: { teamId: string; appIds: string[]; name?: string },
  opts: TeamAgentsClientOptions = {},
): Promise<TeamAgentsClientResult<CreateTeamGroupResult>> {
  const body: Record<string, unknown> = { teamId: args.teamId, appIds: args.appIds };
  if (args.name !== undefined) body.name = args.name;
  return call(opts, 'POST', '/v1/machine/groups', body, (j) => ({
    ok: j?.ok === true,
    chatId: typeof j?.chatId === 'string' ? j.chatId : '',
    shareLink: typeof j?.shareLink === 'string' ? j.shareLink : undefined,
    invalidBotIds: strList(j?.invalidBotIds),
    invalidOwnerUnionIds: strList(j?.invalidOwnerUnionIds),
  }));
}

/**
 * 端点4（B）：往一个**已存在的群** `chatId` 补人——把 `appIds` 指定的 agent **+ 各自 owner**
 * 一起加进去。与端点3（建新群）互补：这条服务「群已经在了、往里加同 team 别人的 agent」的场景。
 * 补人**恒带 owner**（agent 不进没主人的群），无「只补 bot」选项。
 *
 * 平台侧授权（客户端零判断，只透传）——判据按「人」判（飞书列群成员不返回 bot、不支持 app_id）：
 *  ① 可行性闸：平台 bot ∈ chat（tenant token is_in_chat）——它不在就根本加不进人，否则 403
 *     `platform_bot_not_in_chat`；② 归属闸：发起方 owner（machineToken 里的 unionId，不可伪造）
 *     ∈ chat——「你本人已在这群，只是把队友 bot+owner 拉进来」，否则 403 `requester_not_in_chat`；
 *  ③ opt-in 闸同 team.bots；④ 大厅排除。杜绝往「你不在的陌生群」塞人。
 */
export function addTeamGroupMembers(
  args: { chatId: string; teamId: string; appIds: string[] },
  opts: TeamAgentsClientOptions = {},
): Promise<TeamAgentsClientResult<AddTeamGroupMembersResult>> {
  const body: Record<string, unknown> = { teamId: args.teamId, appIds: args.appIds };
  return call(
    opts,
    'POST',
    `/v1/machine/groups/${encodeURIComponent(args.chatId)}/members`,
    body,
    (j) => ({
      ok: j?.ok === true,
      invalidBotIds: strList(j?.invalidBotIds),
      invalidOwnerUnionIds: strList(j?.invalidOwnerUnionIds),
    }),
  );
}

/** 该失败是否值得退避后重投（对齐 issue-client.isRetriable，额外含 429 限流）。 */
export function isRetriable(f: TeamAgentsFailure): boolean {
  return f.reason === 'network' || f.reason === 'rate_limited' || (f.reason === 'server' && f.status >= 500);
}

/**
 * 一次 addTeamGroupMembers 结果是否应触发「自动拉平台 app 进群 + 重试」。
 *
 * 仅当：失败 + 403 client + error==='platform_bot_not_in_chat' + 平台回传了 platformAppId。
 * 提出成纯函数是为了**锁死自动拉的触发条件与单次性**：调用方据它决定「拉一次+重试一次」，
 * 重试后的结果**不再**喂回本函数（调用方不递归），所以无论重试成功、仍撞 platform_bot_not_in_chat、
 * 还是穿透到 requester_not_in_chat，都不会二次触发自动拉——终止性由「调用一次、不回环」保证。
 * 缺 platformAppId（旧端点未回传）→ false，回退手动引导，不会尝试拉一个不知道 id 的 app。
 */
export function shouldTryAutoAddPlatformBot(
  res: TeamAgentsClientResult<unknown>,
): res is TeamAgentsFailure & { reason: 'client'; platformAppId: string } {
  return !res.ok
    && res.reason === 'client'
    && res.status === 403
    && res.error === 'platform_bot_not_in_chat'
    && typeof res.platformAppId === 'string'
    && res.platformAppId.length > 0;
}

/** 429 的重试提示：优先用平台带回的 retryAfterMs（多 pod 下比写死 30s 诚实），否则中性文案。 */
export function rateLimitRetryHint(f: Extract<TeamAgentsFailure, { reason: 'rate_limited' }>): string {
  if (f.retryAfterMs !== undefined) {
    const sec = Math.ceil(f.retryAfterMs / 1000);
    return `请约 ${sec} 秒后重试`;
  }
  return '请稍后重试';
}

/** 把一次失败转成给人看的一句话（CLI 直接打印）。unbound 由调用方单独提示（要引导 bind）。 */
export function describeTeamAgentsFailure(f: TeamAgentsFailure): string {
  switch (f.reason) {
    case 'unbound': return '本机未绑定平台';
    case 'network': return `网络错误：${f.error}（稍后重试）`;
    case 'rate_limited': return `被限流，${rateLimitRetryHint(f)}`;
    case 'forbidden': return `凭证失效或无权限（${f.status} ${f.error}），可能需要重新 botmux bind`;
    case 'not_deployed': return '平台尚未部署团队 agent 端点（/v1/machine/agents|groups），请等平台上线后重试';
    case 'client': return `请求被拒（${f.status} ${f.error}）`;
    case 'server': return `平台错误（${f.status} ${f.error}），稍后重试`;
  }
}
