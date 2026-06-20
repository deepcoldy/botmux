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
import { UserTokenMissingError } from './client.js';
import { type Brand, larkHosts, normalizeBrand } from './lark-hosts.js';

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
  /** true 时**优先 tenant（应用身份）**，失败再回退 user。用于发评论——这样 bot 的
   *  回复显示为机器人本身，而非授权用户。bot 对该文档无访问权时回退 user 身份保证落地。 */
  preferTenant?: boolean;
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
 * 调一个 drive/wiki OpenAPI。优先 user token（裸 fetch），拿不到 token 或遇
 * 401/403 时回退 tenant（SDK client.request 自带 tenant_access_token + GET
 * 空 body 守卫）。返回飞书统一响应体 `{ code, msg, data }`。
 */
async function driveApiCall(larkAppId: string, opts: DriveCallOpts): Promise<any> {
  const bot = getBot(larkAppId);
  const brand = normalizeBrand(bot.config.brand);

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
    const userToken = await resolveUserToken(bot.config.larkAppId, bot.config.larkAppSecret, brand);
    if (!userToken) throw new UserTokenMissingError('该操作需要 User Token（请在话题中 /login 授权）。');
    return fetchWithUserToken(brand, userToken, opts);
  };

  if (opts.userOnly) return callUser();

  // 发评论：优先应用身份（回复显示为 bot），bot 无访问权（抛错或 code!=0）时回退用户身份。
  if (opts.preferTenant) {
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
  const userToken = await resolveUserToken(bot.config.larkAppId, bot.config.larkAppSecret, brand);
  if (userToken) {
    try {
      return await fetchWithUserToken(brand, userToken, opts);
    } catch (err) {
      if (!(err instanceof UserTokenMissingError)) throw err;
      logger.debug(`[doc-comment] user token rejected (${opts.path}); falling back to tenant`);
    }
  }
  return callTenant();
}

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
  if (res.status === 401) {
    throw new UserTokenMissingError('User Token 已失效（HTTP 401）。请在话题中 /login 重新授权。');
  }
  if (res.status === 403) {
    // token 有效但无权访问该文档 —— 视作可回退（也许 tenant 有权）
    throw new UserTokenMissingError(`User Token 无权访问该文档（HTTP 403）。`);
  }
  const body = await res.json().catch(() => ({})) as any;
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
    params: { file_type: file.fileType },
  });
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
      params: { file_type: file.fileType, user_id_type: 'open_id' },
      data: { comment_ids: [commentId] },
    });
    const data = ensureOk(res, '获取评论');
    const raw = Array.isArray(data?.items) ? data.items[0] : undefined;
    if (!raw) return null;
    return normalizeComment(raw);
  } catch (err) {
    logger.warn(`[doc-comment] getDocComment ${commentId.slice(0, 12)} failed: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

function normalizeComment(raw: any): DocComment {
  const replies = Array.isArray(raw?.reply_list?.replies) ? raw.reply_list.replies : [];
  return {
    commentId: raw?.comment_id ?? '',
    isSolved: raw?.is_solved === true,
    replies: replies.map((r: any) => ({
      replyId: r?.reply_id ?? '',
      userId: r?.user_id,
      text: elementsToText(r?.content?.elements),
      mentions: elementsMentions(r?.content?.elements),
      createdAt: typeof r?.create_time === 'number' ? r.create_time : undefined,
    })),
  };
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
): Promise<{ replyId?: string; commentId?: string }> {
  const elements = buildCommentElements(text, mentionOpenId);
  let res: any;
  try {
    res = await driveApiCall(larkAppId, {
      method: 'POST',
      path: `/open-apis/drive/v1/files/${encodeURIComponent(file.fileToken)}/comments/${encodeURIComponent(commentId)}/replies`,
      params: { file_type: file.fileType, user_id_type: 'open_id' },
      data: { content: { elements } },
      preferTenant: true, // 回复显示为 bot 本身（应用身份）；bot 无访问权时回退 user
    });
  } catch (err) {
    // 有的评论不允许被回复（飞书 1069302：全文评论 / 已解决 / 文档评论设置受限）。
    // 退回新建一条全文评论，保证 bot 的答复总能落到文档（不嵌套但仍在评论区）。
    if (isReplyNotAllowed(err)) {
      logger.warn(`[doc-comment] comment=${commentId.slice(0, 12)} 不允许回复，退回新建全文评论`);
      const c = await createDocComment(larkAppId, file, text, mentionOpenId);
      return { replyId: c.replyId, commentId: c.commentId };
    }
    throw err;
  }
  // ensureOk 对 code!==0 抛错；同样要识别"不允许回复"并退回新建。
  if (res?.code !== 0) {
    if (isReplyNotAllowed(res)) {
      logger.warn(`[doc-comment] comment=${commentId.slice(0, 12)} 不允许回复(code=${res?.code})，退回新建全文评论`);
      const c = await createDocComment(larkAppId, file, text, mentionOpenId);
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
): Promise<{ commentId: string; replyId?: string }> {
  const elements = buildCommentElements(text, mentionOpenId);
  const res = await driveApiCall(larkAppId, {
    method: 'POST',
    path: `/open-apis/drive/v1/files/${encodeURIComponent(file.fileToken)}/comments`,
    params: { file_type: file.fileType, user_id_type: 'open_id' },
    data: { reply_list: { replies: [{ content: { elements } }] } },
    preferTenant: true, // 评论显示为 bot 本身（应用身份）；bot 无访问权时回退 user
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
