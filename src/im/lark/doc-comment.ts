/**
 * 飞书云文档「评论」桥接 —— 把一个 docx 文档变成会话的输入/输出通道。
 *
 * 这一层封装四件事：
 *   1. 把用户贴的文档链接 / token 解析成 { fileToken, fileType }（含 wiki 节点解析）
 *   2. 订阅 / 退订文档事件（评论新增等靠此推送）
 *   3. 读评论（取上下文 / 解析 @bot）
 *   4. 回评论（bot 的回复落点 —— 注意飞书无「往已有评论追加回复」的公开 API，
 *      只能新建一条全文评论，见 {@link createDocComment}）
 *
 * 身份：评论 / 订阅事件官方推荐 user_access_token（文档可见性跟着授权用户走）。
 * 因此所有调用 **优先 user token**（裸 fetch + Bearer），失败再回退 tenant（SDK
 * client.request，自动带 tenant_access_token）。和 client.ts 的资源下载同套路，
 * 只是 app/user 的优先级反过来。
 */
import { getBotClient, getBot } from '../../bot-registry.js';
import { resolveUserToken } from '../../utils/user-token.js';
import { logger } from '../../utils/logger.js';
import { UserTokenMissingError, assertLarkTransport } from './client.js';
import { type Brand, larkHosts, normalizeBrand } from './lark-hosts.js';
import { getDocSubscription, type CommentTriggerMode } from '../../services/doc-subs-store.js';
import { compareReplyIds } from '../../core/doc-comment-poller.js';
import { config } from '../../config.js';

/**
 * bot 回复的隐形哨兵：追加在 bot 发表的评论末尾（零宽字符，用户不可见）。
 *
 * 为什么需要：bot 用 **user_access_token** 发评论 → 评论作者 = 授权用户本人，
 * 无法靠「作者是不是 bot」区分「bot 的回复」和「用户自己的评论」。若不区分，
 * bot 发评论 → 触发 comment_add 事件 → 又喂给 bot → 死循环。
 *
 * 双保险：① 记录 bot 创建过的 reply_id（{@link isBotAuthoredReply}，同一 daemon
 * 生命周期内权威）② 文本末尾哨兵（跨重启 / reply_id 拿不到时的兜底）。
 */
export const BOT_REPLY_SENTINEL = '​⁣​';

/** 记录 / 查询 bot 自己创建的评论回复 id（防自触发死循环）。环形上限防泄漏。 */
const botAuthoredReplyIds: string[] = [];
const BOT_AUTHORED_MAX = 2000;
export function markBotAuthoredReply(id: string): void {
  if (!id) return;
  botAuthoredReplyIds.push(id);
  if (botAuthoredReplyIds.length > BOT_AUTHORED_MAX) botAuthoredReplyIds.splice(0, botAuthoredReplyIds.length - BOT_AUTHORED_MAX);
}
export function isBotAuthoredReply(id: string | undefined): boolean {
  return !!id && botAuthoredReplyIds.includes(id);
}
export function hasBotSentinel(text: string | undefined): boolean {
  return !!text && text.includes(BOT_REPLY_SENTINEL);
}

/**
 * 触发范围闸：给定订阅的 `commentTriggerMode` + 触发评论正文 @ 到的 open_id 列表
 * + 本 bot 自己的 open_id，判定这条评论是否应触发会话。
 *
 *   • 'all'          —— 该文档所有新评论都触发。
 *   • 'mention-only' —— 仅当评论正文真的 @ 了「本 bot」才触发。
 *
 * ⚠️ 这里是用户报的 bug 的根因所在：mention-only **绝不能**用飞书评论事件里的
 *   `is_mentioned` 字段判定。实测该字段含义是「这条评论里存在任意 @」——@ 了
 *   别人（同事）时它同样为 true。早先用 `is_mentioned === true || …` 短路放行，
 *   导致「只 @ 同事、没 @bot」的评论也被误触发，mention-only 形同虚设
 *   （现象：「只有 @ 别人时才被触发」）。唯一可靠依据是拉到的评论正文
 *   @person(open_id) 列表里是否含本 bot 自己的 open_id。
 *
 * `selfBotOpenId` 缺失（daemon 启动期 open_id 尚未探到）时一律判否：mention-only
 *   宁可漏触发也不误触发。调用方应在此之前 `await ensureBotOpenId` 关掉该启动
 *   竞态，避免把合法的 @bot 评论误丢（事件已被 ACK，飞书不会重投）。
 */
export function commentTriggerAllowed(
  mode: CommentTriggerMode,
  triggerMentions: string[],
  selfBotOpenId: string | undefined,
): boolean {
  if (mode === 'all') return true;
  return !!selfBotOpenId && triggerMentions.includes(selfBotOpenId);
}

/** 飞书云文档评论里富文本元素的最小子集（够 bot 发纯文本 + @人）。 */
export interface CommentElement {
  type: 'text_run' | 'person' | 'docs_link';
  text_run?: { text: string };
  person?: { user_id: string };
  docs_link?: { url: string };
}

/** 一条评论（含其下回复）的归一化形态，listDocComments 返回。 */
export interface DocComment {
  commentId: string;
  /** 评论是否已解决。 */
  isSolved: boolean;
  /** 局部评论选中的文档原文；全文评论通常为空。 */
  quote?: string;
  /** 是否为整篇文档的全文评论。 */
  isWhole?: boolean;
  /**
   * `replies` 是否被飞书分页截断（评论对象顶层 `has_more`）。
   * true 表示这里拿到的只是**前几条**回复，不能当作完整 thread 用。
   */
  hasMoreReplies?: boolean;
  /** 该评论 thread 下所有回复（飞书把评论建模成 reply_list）。 */
  replies: Array<{
    replyId: string;
    /** 发表者 open_id（user_id_type=open_id 时）。 */
    userId?: string;
    /** 纯文本内容（拼接所有 text_run）。 */
    text: string;
    /** 该回复 @ 到的 open_id 列表（从 person 元素提取）。 */
    mentions: string[];
    createdAt?: number;
  }>;
}

export interface ResolvedDocFile {
  fileToken: string;
  /** 飞书 file_type：docx / doc / sheet / bitable / file / slides。本特性主攻 docx。 */
  fileType: string;
}

// ─── URL / token 解析 ──────────────────────────────────────────────────────────

const URL_TYPE_RE = /\/(docx|docs|wiki|sheets|base|bitable|file|slides|mindnote)\/([A-Za-z0-9]+)/;
const RAW_TOKEN_RE = /^[A-Za-z0-9]{20,}$/;

/** URL path 段的类型 → 飞书 file_type。 */
function pathKindToFileType(kind: string): string {
  switch (kind) {
    case 'docx': return 'docx';
    case 'docs': return 'doc';
    case 'sheets': return 'sheet';
    case 'base':
    case 'bitable': return 'bitable';
    case 'slides': return 'slides';
    case 'mindnote': return 'mindnote';
    case 'file': return 'file';
    default: return kind;
  }
}

/**
 * 把用户输入解析成 { kind, token }。支持完整飞书链接、`/docx/<token>` 片段、
 * 或裸 token（裸 token 当 docx 处理）。`wiki` 类型需要再过一次节点解析（见
 * {@link resolveDocFile}）。无法识别返回 null。
 */
export function parseDocRef(input: string): { kind: string; token: string } | null {
  const s = input.trim();
  const m = s.match(URL_TYPE_RE);
  if (m) return { kind: m[1], token: m[2] };
  if (RAW_TOKEN_RE.test(s)) return { kind: 'docx', token: s };
  return null;
}

/**
 * 解析成可直接调评论 / 订阅 API 的 { fileToken, fileType }。wiki 节点先调
 * get_node 换出底层 obj_token + obj_type；其余类型直接映射。
 */
export async function resolveDocFile(larkAppId: string, input: string): Promise<ResolvedDocFile> {
  const ref = parseDocRef(input);
  if (!ref) throw new Error(`无法从「${input.slice(0, 40)}」识别出飞书文档链接或 token`);

  if (ref.kind === 'wiki') {
    const res = await driveApiCall(larkAppId, {
      method: 'GET',
      path: '/open-apis/wiki/v2/spaces/get_node',
      params: { token: ref.token, obj_type: 'wiki' },
    });
    const node = res?.data?.node;
    if (!node?.obj_token || !node?.obj_type) {
      throw new Error(`wiki 节点 ${ref.token} 解析失败（缺 obj_token/obj_type）`);
    }
    return { fileToken: node.obj_token, fileType: node.obj_type };
  }

  return { fileToken: ref.token, fileType: pathKindToFileType(ref.kind) };
}

// ─── 通用调用：优先 user token，回退 tenant ─────────────────────────────────────

interface DriveCallOpts {
  method: 'GET' | 'POST' | 'DELETE' | 'PATCH';
  path: string;
  params?: Record<string, string | number | boolean | undefined>;
  data?: unknown;
  /** true 时禁用 tenant 回退（评论事件订阅必须 user 身份才收得到推送时用）。 */
  userOnly?: boolean;
  /**
   * true 时**禁用 user 回退**：只用 tenant（应用身份）写，失败即失败。
   *
   * 与 `preferTenant` 的区别是「回退可不可接受」。`preferTenant` 用于**必须落地**
   * 的写入（发评论），宁可显示成授权用户也要发出去。而有些写入是**持久且带主体
   * 归属**的 —— 以错误的主体落地比不落地更糟，因为它会以用户自己的名义在文档里
   * 留下不是用户做的动作。这类调用用 `tenantOnly`。
   *
   * 现用于「事件被丢弃」的 ❌ 标记（见 event-dispatcher.ts:markCommentEventDropped）：
   * 它是**终态**标记、故意不清理，一旦回退 user 就等于在用户自己的评论上以用户
   * 自己的名义永久挂一个叉。对比 Typing 指示器 —— 那个是成对的、几秒后必被
   * removeCommentReaction 清掉，所以回退 user 只是短暂误导，可以接受。
   */
  tenantOnly?: boolean;
  /** true 时**优先 tenant（应用身份）**，失败再回退 user。用于发评论——这样 bot 的
   *  回复显示为机器人本身，而非授权用户。bot 对该文档无访问权时回退 user 身份保证落地。 */
  preferTenant?: boolean;
  /** 订阅 API 专用：把 1069603 连同实际失败身份归一化为结构化异常。 */
  classifySubscriptionPermission?: boolean;
  /** Managed-origin fence invoked immediately before every actual tenant/user
   * provider request. It deliberately sits outside fallback catch blocks so a
   * revoked origin aborts instead of being mistaken for an identity failure. */
  beforeProviderEffect?: () => void | Promise<void>;
  /**
   * The document this call acts on, when known. Used ONLY to look up which
   * person owns the subscription (see `userOpenId`); it is not sent upstream.
   *
   * Resolving the owner centrally here — rather than threading `userOpenId`
   * through all nine exported helpers and their ~20 call sites — means a missed
   * call site cannot silently revert to the bot-level token lookup.
   */
  fileTokenForIdentity?: string;
  /**
   * Whose user token to use — the person who created this subscription
   * (`DocSubscription.ownerOpenId`).
   *
   * A document subscription is a long-lived task with no "current sender": the
   * comment that triggers a turn may come from anyone, including people who
   * never authorized this bot. So the identity is fixed at subscribe time rather
   * than taken from whoever commented. Omitted → resolved from the subscription
   * store via `fileTokenForIdentity`, and failing that the historical bot-level
   * lookup, which is what pre-existing subscriptions rely on.
   */
  userOpenId?: string;
}

export interface DocProviderEffectOptions {
  beforeProviderEffect?: () => void | Promise<void>;
}

const DOC_SUBSCRIPTION_PERMISSION_CODE = 1069603;

/**
 * User Token 有效但没有目标文档权限。它必须与 UserTokenMissingError 分开：
 * 403 重新 OAuth 不会增加文档角色，但仍可回退 tenant（应用可能已被加为文档应用）。
 */
class UserTokenForbiddenError extends Error {
  readonly httpStatus = 403;

  constructor(
    readonly larkCode?: number,
    readonly larkMessage?: string,
  ) {
    super(`User Token 无权访问该文档（HTTP 403${larkCode !== undefined ? `, code: ${larkCode}` : ''}）。`);
    this.name = 'UserTokenForbiddenError';
  }
}

export type DocSubscriptionPermissionSource = 'user' | 'tenant' | 'both' | 'unknown';

export interface DocSubscriptionPermissionDetails {
  source: DocSubscriptionPermissionSource;
  userLarkMessage?: string;
  tenantLarkMessage?: string;
  tenantHttpStatus?: number;
}

/**
 * 飞书订阅接口返回 1069603。保留实际返回该业务码的身份，避免 tenant-only
 * 失败被错误归因成“当前用户无权限”；只保留业务字段，不把可能含 token/header
 * 的 AxiosError 挂进 cause。
 */
export class DocSubscriptionPermissionError extends Error {
  readonly larkCode = DOC_SUBSCRIPTION_PERMISSION_CODE;

  constructor(readonly details: DocSubscriptionPermissionDetails) {
    super(`订阅文档被飞书拒绝（code: ${DOC_SUBSCRIPTION_PERMISSION_CODE}, source: ${details.source}）。`);
    this.name = 'DocSubscriptionPermissionError';
  }

  get source(): DocSubscriptionPermissionSource {
    return this.details.source;
  }
}

function getLarkErrorCode(err: unknown): number | undefined {
  if (err instanceof UserTokenForbiddenError) return err.larkCode;
  const code = (err as any)?.response?.data?.code ?? (err as any)?.code;
  return typeof code === 'number' ? code : undefined;
}

function getLarkErrorMessage(err: unknown): string | undefined {
  if (err instanceof UserTokenForbiddenError) return err.larkMessage;
  const msg = (err as any)?.response?.data?.msg ?? (err as any)?.msg;
  return typeof msg === 'string' ? msg : undefined;
}

function subscriptionPermissionSource(
  userForbidden: UserTokenForbiddenError | undefined,
  tenantHasPermissionCode: boolean,
): DocSubscriptionPermissionSource {
  const userHasPermissionCode = userForbidden?.larkCode === DOC_SUBSCRIPTION_PERMISSION_CODE;
  if (userHasPermissionCode && tenantHasPermissionCode) return 'both';
  if (tenantHasPermissionCode) return 'tenant';
  if (userHasPermissionCode) return 'user';
  return 'unknown';
}

function subscriptionPermissionError(
  userForbidden: UserTokenForbiddenError | undefined,
  tenantErrorOrResponse?: unknown,
  tenantHttpStatus?: number,
): DocSubscriptionPermissionError {
  const tenantHasPermissionCode = getLarkErrorCode(tenantErrorOrResponse) === DOC_SUBSCRIPTION_PERMISSION_CODE;
  return new DocSubscriptionPermissionError({
    source: subscriptionPermissionSource(userForbidden, tenantHasPermissionCode),
    ...(userForbidden?.larkMessage ? { userLarkMessage: userForbidden.larkMessage } : {}),
    ...(tenantHasPermissionCode && getLarkErrorMessage(tenantErrorOrResponse)
      ? { tenantLarkMessage: getLarkErrorMessage(tenantErrorOrResponse) }
      : {}),
    ...(tenantHttpStatus !== undefined ? { tenantHttpStatus } : {}),
  });
}

function buildQuery(params?: DriveCallOpts['params']): string {
  if (!params) return '';
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) usp.set(k, String(v));
  }
  const q = usp.toString();
  return q ? `?${q}` : '';
}

/**
 * Which person owns the subscription for this document.
 *
 * Read from the on-disk subscription record rather than passed down the call
 * chain: a document subscription outlives any one turn, so the acting identity
 * has to come from durable state, not from whoever happens to be talking.
 *
 * Returns undefined for an unknown document or a pre-existing record with no
 * recorded owner — the caller then falls back to the bot-level token lookup, so
 * subscriptions created before this field keep working.
 */
function subscriptionOwnerOpenId(larkAppId: string, fileToken: string | undefined): string | undefined {
  if (!fileToken) return undefined;
  try {
    return getDocSubscription(config.session.dataDir, larkAppId, fileToken)?.ownerOpenId;
  } catch {
    return undefined;
  }
}

/**
 * 调一个 drive/wiki OpenAPI。优先 user token（裸 fetch），拿不到 token 或遇
 * 401/403 时回退 tenant（SDK client.request 自带 tenant_access_token + GET
 * 空 body 守卫）。返回飞书统一响应体 `{ code, msg, data }`。
 */
async function driveApiCall(larkAppId: string, opts: DriveCallOpts): Promise<any> {
  // Bot-level transport boundary: doc-comment has its OWN direct-Feishu drive
  // API (subscribe/reply/comment/reaction) that bypasses im/lark/client.ts, so
  // enforce the same apiOnly gate here. A core-only bot has no Feishu tenant
  // token and no doc surface, so every drive call — read or write — is refused.
  assertLarkTransport(larkAppId, `driveApiCall ${opts.method} ${opts.path}`);
  const bot = getBot(larkAppId);
  const brand = normalizeBrand(bot.config.brand);
  // Under trigger-user auth, act as the person who created this subscription.
  // Resolved once, here, so every helper below inherits it — a per-call-site
  // opt-in would silently fall back to the bot-level token wherever it was
  // forgotten. An explicit `userOpenId` wins; otherwise it comes from the
  // subscription record for this document.
  const actingUserOpenId = bot.config.triggerUserAuth?.enabled
    ? (opts.userOpenId ?? subscriptionOwnerOpenId(larkAppId, opts.fileTokenForIdentity))
    : undefined;
  const resolveActingUserToken = () => bot.config.triggerUserAuth?.enabled
    ? resolveUserToken(bot.config.larkAppId, bot.config.larkAppSecret, brand, actingUserOpenId)
    : resolveUserToken(bot.config.larkAppId, bot.config.larkAppSecret, brand);

  // tenant（应用身份）：走 SDK client.request（带 token/缓存/GET 空 body 守卫）。
  const callTenant = async () => {
    const c = getBotClient(larkAppId);
    return c.request({
      method: opts.method,
      url: opts.path,
      params: opts.params,
      ...(opts.data !== undefined ? { data: opts.data } : {}),
    });
  };
  const callUser = async () => {
    // Token resolution may refresh an expired user token over the network.
    // Fence both that refresh and the actual Drive request: revocation in
    // either interval must stop before the next provider-visible effect.
    await opts.beforeProviderEffect?.();
    const userToken = await resolveActingUserToken();
    if (!userToken) throw new UserTokenMissingError('该操作需要 User Token（请在话题中 /login 授权）。');
    await opts.beforeProviderEffect?.();
    return fetchWithUserToken(brand, userToken, opts);
  };

  // ⚠️ userOnly 与 tenantOnly 是互斥的硬约束，同时传是调用方的逻辑错误。
  // 不能让它静默走 userOnly —— tenantOnly 的**全部意义**就是禁止 user 身份写入，
  // 静默降级成 user-only 恰好是它要防的那件事（错误主体的持久写入）。宁可炸。
  if (opts.userOnly && opts.tenantOnly) {
    throw new Error(`driveApiCall: userOnly 与 tenantOnly 互斥，不能同时指定 (${opts.path})`);
  }

  if (opts.userOnly) return callUser();

  // 只用应用身份写，绝不回退 user —— 见 tenantOnly 的注释：这类写入是持久且带
  // 主体归属的，以错误主体落地比不落地更糟。tenant 失败就让它失败，调用方决定
  // 怎么降级（当前唯一调用方 markCommentEventDropped 是 best-effort 放弃 + 日志）。
  if (opts.tenantOnly) {
    await opts.beforeProviderEffect?.();
    const res = await callTenant();
    if (res?.code !== 0) {
      throw new Error(`tenant-only drive call 失败 (${opts.path}): ${res?.msg ?? 'unknown'} (code: ${res?.code})`);
    }
    return res;
  }

  // 发评论：优先应用身份（回复显示为 bot），bot 无访问权（抛错或 code!=0）时回退用户身份。
  if (opts.preferTenant) {
    await opts.beforeProviderEffect?.();
    try {
      const res = await callTenant();
      if (res?.code === 0) return res;
      logger.debug(`[doc-comment] tenant call code=${res?.code} (${opts.path})；回退 user 身份`);
    } catch (err) {
      logger.debug(`[doc-comment] tenant call threw (${opts.path})；回退 user 身份：${err instanceof Error ? err.message : err}`);
    }
    return callUser();
  }

  // 默认：优先 user（有 token），401/403 回退 tenant。
  let userForbidden: UserTokenForbiddenError | undefined;
  await opts.beforeProviderEffect?.();
  const userToken = await resolveActingUserToken();
  if (userToken) {
    try {
      await opts.beforeProviderEffect?.();
      const userResult = await fetchWithUserToken(brand, userToken, opts);
      if (
        opts.classifySubscriptionPermission
        && userResult?.code === DOC_SUBSCRIPTION_PERMISSION_CODE
      ) {
        userForbidden = new UserTokenForbiddenError(
          DOC_SUBSCRIPTION_PERMISSION_CODE,
          typeof userResult?.msg === 'string' ? userResult.msg : undefined,
        );
      } else {
        return userResult;
      }
    } catch (err) {
      if (err instanceof UserTokenForbiddenError) {
        userForbidden = err;
      } else if (!(err instanceof UserTokenMissingError)) {
        throw err;
      }
      logger.debug(`[doc-comment] user token rejected (${opts.path}); falling back to tenant`);
    }
  }

  let tenantResult: any;
  await opts.beforeProviderEffect?.();
  try {
    tenantResult = await callTenant();
  } catch (tenantError) {
    const tenantStatus = (tenantError as any)?.response?.status ?? (tenantError as any)?.status;
    if (
      opts.classifySubscriptionPermission
      && getLarkErrorCode(tenantError) === DOC_SUBSCRIPTION_PERMISSION_CODE
    ) {
      throw subscriptionPermissionError(userForbidden, tenantError, tenantStatus);
    }
    // 订阅 API 的 owner/manager 错误来自首选 user 身份时，不能让 tenant 的
    // generic Axios 403（无飞书业务码）覆盖掉飞书业务码，否则上层只能看到
    // “status code 403”。tenant 明确返回其他 HTTP 状态或业务码时必须保留，
    // 避免把凭证、限流或服务故障误报成文档 owner/manager 权限不足。
    if (
      userForbidden?.larkCode === DOC_SUBSCRIPTION_PERMISSION_CODE
      && tenantStatus === 403
      && getLarkErrorCode(tenantError) === undefined
    ) {
      logger.debug(`[doc-comment] tenant fallback also failed (${opts.path}); preserving user code=${userForbidden.larkCode}`);
      if (opts.classifySubscriptionPermission) {
        throw subscriptionPermissionError(userForbidden, undefined, tenantStatus);
      }
      throw userForbidden;
    }
    throw tenantError;
  }
  if (
    opts.classifySubscriptionPermission
    && tenantResult?.code === DOC_SUBSCRIPTION_PERMISSION_CODE
  ) {
    throw subscriptionPermissionError(userForbidden, tenantResult);
  }
  return tenantResult;
}

/** 仅供测试：直接驱动身份选择逻辑，验证互斥约束等不经由具体端点的行为。 */
export const __testOnly_driveApiCall = driveApiCall;

async function fetchWithUserToken(brand: Brand, userToken: string, opts: DriveCallOpts): Promise<any> {
  const url = `${larkHosts(brand).openApi}${opts.path}${buildQuery(opts.params)}`;
  const res = await fetch(url, {
    method: opts.method,
    headers: {
      Authorization: `Bearer ${userToken}`,
      ...(opts.data !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(opts.data !== undefined ? { body: JSON.stringify(opts.data) } : {}),
  });
  const body = await res.json().catch(() => ({})) as any;
  if (res.status === 401) {
    throw new UserTokenMissingError('User Token 已失效（HTTP 401）。请在话题中 /login 重新授权。');
  }
  if (res.status === 403) {
    // token 有效但无权访问该文档 —— 视作可回退（也许 tenant 有权）
    throw new UserTokenForbiddenError(
      typeof body?.code === 'number' ? body.code : undefined,
      typeof body?.msg === 'string' ? body.msg : undefined,
    );
  }
  if (!res.ok) {
    throw new Error(`drive API ${opts.path} HTTP ${res.status}: ${body?.msg ?? ''}`);
  }
  return body;
}

function ensureOk(res: any, what: string): any {
  if (res?.code !== 0) {
    throw new Error(`${what} 失败: ${res?.msg ?? 'unknown'} (code: ${res?.code})`);
  }
  return res.data;
}

// ─── 订阅 / 退订 ────────────────────────────────────────────────────────────────

/** 订阅文档事件（评论新增等靠此推送）。幂等：重复订阅飞书返回成功。 */
export async function subscribeDocFile(larkAppId: string, file: ResolvedDocFile): Promise<void> {
  const res = await driveApiCall(larkAppId, {
    method: 'POST',
    path: `/open-apis/drive/v1/files/${encodeURIComponent(file.fileToken)}/subscribe`,
    fileTokenForIdentity: file.fileToken,
    params: { file_type: file.fileType },
    classifySubscriptionPermission: true,
  });
  if (res?.code === DOC_SUBSCRIPTION_PERMISSION_CODE) {
    throw new DocSubscriptionPermissionError({
      source: 'unknown',
      ...(typeof res?.msg === 'string' ? { tenantLarkMessage: res.msg } : {}),
    });
  }
  ensureOk(res, '订阅文档');
  logger.info(`[doc-comment] subscribed file=${file.fileToken.slice(0, 12)} type=${file.fileType}`);
}

/** 退订文档事件。best-effort：失败只告警不抛。 */
export async function unsubscribeDocFile(larkAppId: string, file: ResolvedDocFile): Promise<void> {
  try {
    // 飞书取消订阅是 DELETE .../delete_subscribe（不是 DELETE .../subscribe，后者 404）。
    const res = await driveApiCall(larkAppId, {
      method: 'DELETE',
      path: `/open-apis/drive/v1/files/${encodeURIComponent(file.fileToken)}/delete_subscribe`,
      fileTokenForIdentity: file.fileToken,
      params: { file_type: file.fileType },
    });
    ensureOk(res, '退订文档');
    logger.info(`[doc-comment] unsubscribed file=${file.fileToken.slice(0, 12)}`);
  } catch (err) {
    logger.warn(`[doc-comment] unsubscribe failed for ${file.fileToken.slice(0, 12)}: ${err instanceof Error ? err.message : err}`);
  }
}

// ─── 读评论 ─────────────────────────────────────────────────────────────────────

/** 拼接评论内容元素为纯文本。 */
function elementsToText(elements: any[] | undefined): string {
  if (!Array.isArray(elements)) return '';
  return elements.map((el) => el?.text_run?.text ?? '').join('');
}

/** 从评论内容元素提取 @ 到的 open_id。 */
function elementsMentions(elements: any[] | undefined): string[] {
  if (!Array.isArray(elements)) return [];
  return elements.map((el) => el?.person?.user_id).filter((x: unknown): x is string => typeof x === 'string');
}

/**
 * 读某条评论（含其下所有回复）。用于事件来后取 thread 上下文 + 判断是否 @bot。
 * 拿不到返回 null。
 */
export async function getDocComment(
  larkAppId: string,
  file: ResolvedDocFile,
  commentId: string,
): Promise<DocComment | null> {
  try {
    // 用 batch_query 而非 GET /comments/{id}——后者只认「全文评论」，对**局部/锚定
    // 评论**(is_whole:false，真实用户在 UI 选中文字评论就是这种)返回 1069307 not exist。
    // batch_query 两种都支持。
    const res = await driveApiCall(larkAppId, {
      method: 'POST',
      path: `/open-apis/drive/v1/files/${encodeURIComponent(file.fileToken)}/comments/batch_query`,
      fileTokenForIdentity: file.fileToken,
      params: { file_type: file.fileType, user_id_type: 'open_id' },
      data: { comment_ids: [commentId] },
    });
    const data = ensureOk(res, '获取评论');
    const raw = Array.isArray(data?.items) ? data.items[0] : undefined;
    if (!raw) return null;
    // 事件链路：与本函数的 batch_query 主请求保持同一身份优先级（user-first），
    // 不要一半 user-first 一半 tenant-first。补全失败降级，下游有 `!trigger` 兜底。
    return await hydrateTruncatedReplies(larkAppId, file, normalizeComment(raw), {
      onTruncated: 'degrade',
      preferTenant: false,
    });
  } catch (err) {
    logger.warn(`[doc-comment] getDocComment ${commentId.slice(0, 12)} failed: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

/**
 * 补全被截断的回复串。
 *
 * ⚠️ 飞书**对每条评论的 `reply_list.replies` 分页**，`has_more` 挂在评论对象
 * 顶层（不是 reply_list 里），没有参数可以调大，也不能靠 page_size 绕过。
 *
 * 实测（33 条评论、单串最长 11 条回复的真实文档）两个端点表现**并不一样**：
 *   • `POST .../comments/batch_query` —— 截断，一页只给 5 条并置 has_more=true
 *   • `GET  .../comments`            —— 未见截断，11 条的串也完整返回
 * 事件链路走 batch_query，所以是它踩了这个坑。`listDocComments` 走 GET，目前
 * 观察不到截断，但 `has_more` 是文档化字段、飞书随时可能对它也生效，故两条
 * 链路都接上补全（GET 那条实际是防御性的，正常不会真的发请求）。
 *
 * 吃下这个截断的后果是**长评论串会永久静默失联**：事件带着第 6 条以后的
 * reply_id 打进来，在只有 5 条的 replies 里 find 不到，触发回复解析出错的那条
 * → @ 判定、自触发过滤、turnId 去重全部基于错误的回复，最终每一条新评论都被
 * 当成重复回合丢弃。
 *
 * 因此 `has_more` 为真时改用专用端点 `GET /comments/{id}/replies` 翻全量。
 * 实测确认该端点与 `reply_list.replies` **同序（create_time 升序）**、跨页拼接
 * 后仍升序、前 N 条与截断结果逐字节一致 —— 上层 priorReplies / trigger 依赖
 * 这个顺序，换端点不能破坏它。
 *
 * `onTruncated` 决定**补全没能拿到完整回复串**时的行为（包括请求失败、分页
 * 超上限，以及 `/replies` 返回空数组这种「合法但用不了」的应答 —— 三者对调用
 * 方是同一件事：手上仍是截断结果）。**两条链路语义不同，必须由调用方选**：
 * - 事件链路（getDocComment）传 'degrade'：退回截断结果。下游 `!trigger` 有
 *   兜底告警，且事件链路本来就没有游标可污染。
 * - 轮询链路（listDocComments）传 'throw'：**绝不能**降级。游标是按拿到的
 *   回复算的，降级会让 `latestDocCommentPollCursor` 用截断的 5 条推游标；一旦
 *   某轮补全成功把游标推到第 11 条、下一轮补全失败只看到 5 条，
 *   `docCommentRepliesAfterCursor` 返回空，这轮新来的第 12 条就永久不投了
 *   （游标已在 11，而截断响应里永远看不到 12）。抛错让 daemon 的 per-sub
 *   try/catch 跳过这一轮、游标不动、下轮重试，才是正确语义。
 */
/** 单条评论回复串的翻页上限。纯粹是死循环保险，正常 thread 远够用。 */
const MAX_REPLY_PAGES = 50;

async function hydrateTruncatedReplies(
  larkAppId: string,
  file: ResolvedDocFile,
  comment: DocComment,
  opts: { onTruncated: 'degrade' | 'throw'; preferTenant: boolean },
): Promise<DocComment> {
  if (!comment.hasMoreReplies || !comment.commentId) return comment;
  try {
    const replies: DocComment['replies'] = [];
    let pageToken: string | undefined;
    let pages = 0;
    do {
      const res = await driveApiCall(larkAppId, {
        method: 'GET',
        path: `/open-apis/drive/v1/files/${encodeURIComponent(file.fileToken)}/comments/${encodeURIComponent(comment.commentId)}/replies`,
        params: {
          file_type: file.fileType,
          user_id_type: 'open_id',
          page_size: 50,
          page_token: pageToken,
        },
        preferTenant: opts.preferTenant,
      });
      const data = ensureOk(res, '拉取评论回复');
      if (Array.isArray(data?.items)) replies.push(...data.items.map(normalizeReply));
      pageToken = data?.has_more === true && typeof data?.page_token === 'string' && data.page_token
        ? data.page_token
        : undefined;
      // 服务端若返回恒定 page_token 会把这里变成死循环，而且是嵌在
      // 「每条评论 × 每个订阅」的两层循环里，足以把整个 poller 卡死。
      // ⚠️ 只在「确认还有下一页」时计数，否则正常拉完的第 51 页也会被判成异常。
      if (pageToken && ++pages >= MAX_REPLY_PAGES) {
        throw new Error(`回复分页超过 ${MAX_REPLY_PAGES} 页上限（comment=${comment.commentId.slice(0, 12)}），疑似游标未推进`);
      }
    } while (pageToken);
    // 空数组是**合法应答**（整串回复都被删了），不能和「没拉到」混为一谈；
    // 但也不敢直接拿它覆盖已有的 N 条，只能保留截断结果。
    //
    // ⚠️ 保留截断结果 == 补全没成功，所以**必须和补全失败走同一条路**。这里曾经
    // 无条件 `return comment`，绕过了下面的 catch，等于给 'throw' 契约开了条边路：
    // 轮询链路拿到截断的回复 + hasMoreReplies:true，游标照样按截断的条数推进，
    // 正是 onTruncated:'throw' 要堵的永久漏投。
    // 故这里只管抛，由 catch 里那**唯一一处** onTruncated 分派决定抛还是降级 ——
    // 别在这儿再判一次 opts.onTruncated，两处分派迟早会走岔。
    if (replies.length === 0) {
      throw new Error(`hydrate returned 0 replies for ${comment.commentId.slice(0, 12)}（截断结果有 ${comment.replies.length} 条）`);
    }
    // 按 createdAt 升序稳定排一次。实测 `/replies` 与 `reply_list.replies` 同序
    // （均为 create_time 升序，跨页拼接后仍升序），但飞书**既没声明排序也没给
    // 排序参数** —— 这是未承诺行为。上层 `priorReplies`
    // （event-dispatcher 的 `replies.slice(0, triggerIndex)`）直接吃这个顺序且
    // 不自己排，一旦飞书改成降序，症状是模型把「后面的回复」当历史上下文喂进去，
    // 且没有任何日志会报。与其把这个假设只写在注释里，不如让代码自己守住。
    // create_time 是秒级、同秒并列真实存在，故用 replyId 做次级比较（复用
    // poller 的 compareReplyIds，别重写一套）。
    replies.sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0) || compareReplyIds(a.replyId, b.replyId));
    logger.info(`[doc-comment] hydrated truncated thread comment=${comment.commentId.slice(0, 12)} ${comment.replies.length} → ${replies.length} replies`);
    return { ...comment, replies, hasMoreReplies: false };
  } catch (err) {
    if (opts.onTruncated === 'throw') throw err;
    // 事件链路降级：返回截断结果，下游 `!trigger` 的告警会暴露问题。
    logger.warn(`[doc-comment] hydrate replies for ${comment.commentId.slice(0, 12)} failed: ${err instanceof Error ? err.message : err}`);
    return comment;
  }
}

function normalizeReply(r: any): DocComment['replies'][number] {
  return {
    replyId: r?.reply_id ?? '',
    userId: r?.user_id,
    text: elementsToText(r?.content?.elements),
    mentions: elementsMentions(r?.content?.elements),
    createdAt: Number.isFinite(Number(r?.create_time)) ? Number(r.create_time) : undefined,
  };
}

function normalizeComment(raw: any): DocComment {
  const replies = Array.isArray(raw?.reply_list?.replies) ? raw.reply_list.replies : [];
  const quote = typeof raw?.quote === 'string'
    ? raw.quote.trim()
    : elementsToText(raw?.quote?.content?.elements ?? raw?.quote?.elements).trim();
  return {
    commentId: raw?.comment_id ?? '',
    isSolved: raw?.is_solved === true,
    quote: quote || undefined,
    isWhole: raw?.is_whole === true,
    // 顶层 has_more 表示**回复串**还有下一页（不是评论列表还有下一页）。
    hasMoreReplies: raw?.has_more === true,
    replies: replies.map(normalizeReply),
  };
}

/**
 * 列出文档当前可见的全部评论。`/watch-comment --all` 用它做增量轮询：
 * 评论读取优先应用身份，因此不需要 User Token；只有应用身份无权访问文档时才
 * 回退已有的用户授权。
 *
 * ⚠️ 两层分页别混淆：外层 `data.has_more` 是**评论列表**还有下一页，每个 item
 * 自己的 `has_more` 是**该评论的回复串**被截断（见 hydrateTruncatedReplies）。
 * 只翻外层会让轮询永远看不到长 thread 第 6 条以后的回复。
 */
export async function listDocComments(
  larkAppId: string,
  file: ResolvedDocFile,
): Promise<DocComment[]> {
  const comments: DocComment[] = [];
  let pageToken: string | undefined;
  do {
    const res = await driveApiCall(larkAppId, {
      method: 'GET',
      path: `/open-apis/drive/v1/files/${encodeURIComponent(file.fileToken)}/comments`,
      fileTokenForIdentity: file.fileToken,
      params: {
        file_type: file.fileType,
        user_id_type: 'open_id',
        page_size: 50,
        page_token: pageToken,
      },
      preferTenant: true,
    });
    const data = ensureOk(res, '列出评论');
    if (Array.isArray(data?.items)) comments.push(...data.items.map(normalizeComment));
    pageToken = data?.has_more === true && typeof data?.page_token === 'string' && data.page_token
      ? data.page_token
      : undefined;
  } while (pageToken);
  // 串行补全，且只在 has_more 的评论上真正发请求。GET /comments 实测不截断，
  // 所以这里通常一个补全请求都不会发；Promise.all 只会在真出现批量截断时把
  // 补全请求一次性打出去撞飞书限流（具体额度未核实，别在别处引用一个拍脑袋的
  // 数字当依据），得不偿失。
  // 注：真出现「一篇文档几十条串都被截断」时，本轮 poll 会明显变慢（有
  // docCommentPollRunning 互斥，不会重入，但会拖慢游标推进）。届时应改成只补全
  // 游标之后可能有新回复的评论 —— 留待后续 PR。
  const hydrated: DocComment[] = [];
  for (const comment of comments) {
    // 轮询链路：与本函数的列表主请求同为 tenant-first；补全失败必须抛错，
    // 降级会让游标按截断的回复数推进并永久漏投后续回复（见 hydrateTruncatedReplies）。
    hydrated.push(await hydrateTruncatedReplies(larkAppId, file, comment, {
      onTruncated: 'throw',
      preferTenant: true,
    }));
  }
  return hydrated;
}

// ─── 回评论 ─────────────────────────────────────────────────────────────────────

/**
 * 往**已有评论 thread 里追加一条回复**（真正的嵌套回复，用户看到 bot 的回复
 * 就挂在自己那条评论下面）。
 *
 * 端点 `POST .../comments/{comment_id}/replies` 是飞书 drive-v1 的公开 API
 * （file.comment.reply.create）—— 我们装的 node-sdk 1.64.0 恰好没暴露 create，
 * 但裸 endpoint 存在，故这里直接打。返回新回复的 reply_id（已登记防自触发）。
 */
export async function replyToDocComment(
  larkAppId: string,
  file: ResolvedDocFile,
  commentId: string,
  text: string,
  mentionOpenId?: string,
  options: DocProviderEffectOptions = {},
): Promise<{ replyId?: string; commentId?: string }> {
  const elements = buildCommentElements(text, mentionOpenId);
  let res: any;
  try {
    res = await driveApiCall(larkAppId, {
      method: 'POST',
      path: `/open-apis/drive/v1/files/${encodeURIComponent(file.fileToken)}/comments/${encodeURIComponent(commentId)}/replies`,
      fileTokenForIdentity: file.fileToken,
      params: { file_type: file.fileType, user_id_type: 'open_id' },
      data: { content: { elements } },
      preferTenant: true, // 回复显示为 bot 本身（应用身份）；bot 无访问权时回退 user
      beforeProviderEffect: options.beforeProviderEffect,
    });
  } catch (err) {
    // 有的评论不允许被回复（飞书 1069302：全文评论 / 已解决 / 文档评论设置受限）。
    // 退回新建一条全文评论，保证 bot 的答复总能落到文档（不嵌套但仍在评论区）。
    if (isReplyNotAllowed(err)) {
      logger.warn(`[doc-comment] comment=${commentId.slice(0, 12)} 不允许回复，退回新建全文评论`);
      const c = await createDocComment(larkAppId, file, text, mentionOpenId, options);
      return { replyId: c.replyId, commentId: c.commentId };
    }
    throw err;
  }
  // ensureOk 对 code!==0 抛错；同样要识别"不允许回复"并退回新建。
  if (res?.code !== 0) {
    if (isReplyNotAllowed(res)) {
      logger.warn(`[doc-comment] comment=${commentId.slice(0, 12)} 不允许回复(code=${res?.code})，退回新建全文评论`);
      const c = await createDocComment(larkAppId, file, text, mentionOpenId, options);
      return { replyId: c.replyId, commentId: c.commentId };
    }
    throw new Error(`回复评论 失败: ${res?.msg ?? 'unknown'} (code: ${res?.code})`);
  }
  const replyId: string | undefined = res.data?.reply_id;
  if (replyId) markBotAuthoredReply(replyId);
  logger.info(`[doc-comment] replied to comment=${commentId.slice(0, 12)} reply=${String(replyId ?? '').slice(0, 12)} on file=${file.fileToken.slice(0, 12)} (${text.length} chars)`);
  return { replyId };
}

/** 构造评论内容元素：可选在开头 @ 某人（person 元素，user_id=open_id），末尾追加
 *  隐形哨兵供事件侧自触发兜底识别。 */
function buildCommentElements(text: string, mentionOpenId?: string): CommentElement[] {
  const els: CommentElement[] = [];
  if (mentionOpenId) {
    els.push({ type: 'person', person: { user_id: mentionOpenId } });
    els.push({ type: 'text_run', text_run: { text: ' ' } });
  }
  els.push({ type: 'text_run', text_run: { text: text + BOT_REPLY_SENTINEL } });
  return els;
}

/** 识别飞书"该评论不允许回复"的错误（code 1069302 或消息含 does not allow replies）。 */
function isReplyNotAllowed(errOrRes: unknown): boolean {
  const s = errOrRes instanceof Error ? errOrRes.message : JSON.stringify(errOrRes ?? '');
  return s.includes('1069302') || /does not allow replies|不允许回复/.test(s);
}

/**
 * 新建一条**全文评论**（独立的新评论，非嵌套）。用于没有可挂靠 comment_id 的
 * 场景（如主动向文档发评论）。返回 comment_id。
 */
export async function createDocComment(
  larkAppId: string,
  file: ResolvedDocFile,
  text: string,
  mentionOpenId?: string,
  options: DocProviderEffectOptions = {},
): Promise<{ commentId: string; replyId?: string }> {
  const elements = buildCommentElements(text, mentionOpenId);
  const res = await driveApiCall(larkAppId, {
    method: 'POST',
    path: `/open-apis/drive/v1/files/${encodeURIComponent(file.fileToken)}/comments`,
    fileTokenForIdentity: file.fileToken,
    params: { file_type: file.fileType, user_id_type: 'open_id' },
    data: { reply_list: { replies: [{ content: { elements } }] } },
    preferTenant: true, // 评论显示为 bot 本身（应用身份）；bot 无访问权时回退 user
    beforeProviderEffect: options.beforeProviderEffect,
  });
  const data = ensureOk(res, '发表评论');
  const commentId: string = data?.comment_id ?? '';
  const replyId: string | undefined = data?.reply_list?.replies?.[0]?.reply_id;
  if (replyId) markBotAuthoredReply(replyId);
  logger.info(`[doc-comment] created comment=${String(commentId).slice(0, 12)} reply=${String(replyId ?? '').slice(0, 12)} on file=${file.fileToken.slice(0, 12)} (${text.length} chars)`);
  return { commentId, replyId };
}

/** 飞书文档评论内容长度上限的保守值，超长 bot 回复按此分块发多条评论。 */
export const DOC_COMMENT_MAX_CHARS = 3000;

/** 把长文本按 {@link DOC_COMMENT_MAX_CHARS} 切块（尽量按段落/换行边界）。 */
export function chunkCommentText(text: string, max = DOC_COMMENT_MAX_CHARS): string[] {
  if (text.length <= max) return [text];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n', max);
    if (cut < max * 0.5) cut = max; // 没有靠后的换行就硬切
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n+/, '');
  }
  if (rest) chunks.push(rest);
  return chunks;
}

// ─── Reaction（"Typing" 指示器）────────────────────────────────────────────

/**
 * 给评论回复加 reaction（"Typing" 处理中指示器）。
 *
 * 用户在文档评论里 @bot 后，bot 立即给那条回复加一个 "Typing" emoji，让用户
 * 知道 bot 收到了、正在处理。bot 回复发出后再删掉。
 *
 * 端点：`POST drive/v2/files/{token}/comments/reaction`（v2，评论 reaction 专用）。
 * 默认优先应用身份、失败回退 user（reaction 尽量显示为 bot 加的，但保证落地）。
 * `options.tenantOnly` 关掉这个回退 —— 用于**不会被清理的终态标记**，那种场景下
 * 以授权用户名义永久落一个 reaction 比不落更糟（见 DriveCallOpts.tenantOnly）。
 *
 * @returns 新创建的 reaction_id（删除时要用）；失败返回 undefined（不阻塞主流程）。
 */
export async function addCommentReaction(
  larkAppId: string,
  file: ResolvedDocFile,
  commentId: string,
  replyId: string,
  reactionType: string,
  options: DocProviderEffectOptions & { tenantOnly?: boolean } = {},
): Promise<string | undefined> {
  return (await addCommentReactionChecked(larkAppId, file, commentId, replyId, reactionType, options)).reactionId;
}

/**
 * 同 {@link addCommentReaction}，但**如实回报服务端结果**。
 *
 * 为什么需要：上面那个签名把失败投影成 `undefined`，而飞书官方
 * `update_reaction` 的响应体是**空对象、不承诺 `reaction_id`** —— 所以
 * `reactionId ? 成功 : 失败` 会把「code=0 但没带 id」误记成失败。要在日志里
 * 写真实 outcome，必须在投影掉之前把 `res.code === 0` 留住。
 *
 * `ok` 只表示**这次请求本身**成功（HTTP 通了且 code=0），不代表 reaction 一定
 * 在 UI 上可见（重复 add 的服务端语义未实测）。
 */
export async function addCommentReactionChecked(
  larkAppId: string,
  file: ResolvedDocFile,
  commentId: string,
  replyId: string,
  reactionType: string,
  options: DocProviderEffectOptions & { tenantOnly?: boolean } = {},
): Promise<{ ok: boolean; reactionId?: string }> {
  try {
    const res = await driveApiCall(larkAppId, {
      method: 'POST',
      path: `/open-apis/drive/v2/files/${encodeURIComponent(file.fileToken)}/comments/reaction`,
      fileTokenForIdentity: file.fileToken,
      params: { file_type: file.fileType },
      data: { action: 'add', comment_id: commentId, reply_id: replyId, reaction_type: reactionType },
      // tenantOnly 与 preferTenant 互斥：前者禁用 user 回退，后者允许。
      ...(options.tenantOnly ? { tenantOnly: true } : { preferTenant: true }),
      beforeProviderEffect: options.beforeProviderEffect,
    });
    const reactionId: string | undefined = res?.data?.reaction_id;
    if (reactionId) {
      logger.info(`[doc-comment] added reaction=${reactionId} type=${reactionType} on reply=${replyId.slice(0, 12)}`);
    }
    // 走到这里说明 driveApiCall 没抛（tenantOnly 路径 code!=0 会抛；其余路径
    // 返回体自带 code）。id 可能为空 —— 官方 schema 不承诺，不能据此判失败。
    return { ok: res?.code === undefined || res.code === 0, reactionId };
  } catch (err) {
    logger.warn(`[doc-comment] addCommentReaction failed for reply=${replyId.slice(0, 12)}: ${err instanceof Error ? err.message : err}`);
    return { ok: false };
  }
}

/**
 * 删除评论回复的 reaction（bot 回复发出后清理 "Typing" 指示器）。
 *
 * 端点：`DELETE drive/v2/files/{token}/comments/reaction`，参数全走 query string。
 * best-effort：失败只告警不抛（bot 已经成功回复了，reaction 留着也不影响）。
 */
export async function removeCommentReaction(
  larkAppId: string,
  file: ResolvedDocFile,
  commentId: string,
  replyId: string,
  reactionId: string,
  options: DocProviderEffectOptions = {},
): Promise<void> {
  if (!reactionId) return;
  try {
    await driveApiCall(larkAppId, {
      method: 'DELETE',
      path: `/open-apis/drive/v2/files/${encodeURIComponent(file.fileToken)}/comments/reaction`,
      fileTokenForIdentity: file.fileToken,
      params: {
        file_type: file.fileType,
        comment_id: commentId,
        reply_id: replyId,
        reaction_id: reactionId,
      },
      preferTenant: true,
      beforeProviderEffect: options.beforeProviderEffect,
    });
    logger.info(`[doc-comment] removed reaction=${reactionId.slice(0, 12)} on reply=${replyId.slice(0, 12)}`);
  } catch (err) {
    logger.warn(`[doc-comment] removeCommentReaction failed for reaction=${reactionId.slice(0, 12)}: ${err instanceof Error ? err.message : err}`);
  }
}
