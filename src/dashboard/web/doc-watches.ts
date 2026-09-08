/**
 * 文档评论监听（doc-watches）前端数据层。
 *
 * 后端是 per-bot 的（订阅表按 `larkAppId` 分文件存），所以列表是「逐 bot 拉、
 * 前端拼」——与 roles / message-listeners 同款。刻意**不做**跨 bot 的服务端聚合
 * 端点：那样就得在服务端再引一层 scoping，而这里每条请求本来就带着 bot id，
 * dashboard 侧的 `proxyToDaemon` 会把它路由到那个 bot 自己的 daemon。
 */

export type DocWatchMode = 'mention-only' | 'all';

/** 与后端 `DocWatchOutcome` 一一对应，见 doc-subs-store.ts。 */
export type DocWatchOutcome =
  | 'dispatched'
  | 'no-comment'
  | 'trigger-missing'
  | 'empty-text'
  | 'not-mentioned'
  | 'self-authored'
  | 'audit-rejected'
  | 'poll-failed';

export interface DocWatchRow {
  fileToken: string;
  fileType: string;
  docTitle?: string;
  commentTriggerMode: DocWatchMode;
  managedBy: 'watch-comment' | 'subscribe-lark-doc';
  workingDir?: string;
  chatId?: string;
  scope?: 'thread' | 'chat';
  sessionId?: string;
  ownerOpenId?: string;
  createdAt: number;
  // 运行态：**全部可能缺**（旧订阅记录没有这些字段），UI 必须能显示「—」。
  lastActivityAt?: number;
  lastOutcome?: DocWatchOutcome;
  lastError?: string;
  lastDispatchAt?: number;
  dispatchCount?: number;
  pollBaselineReady?: boolean;
  pollCursorAt?: number;
  autoCreated?: boolean;
  autoCreatedBy?: string;
  autoCreatedAt?: number;
  larkAppId?: string;
}

/** 一个 bot 的拉取结果。失败不抛：一个 bot 的 daemon 离线不该让整页空白。 */
export interface DocWatchBotResult {
  larkAppId: string;
  botName?: string;
  watches: DocWatchRow[];
  error?: string;
}

async function readJson(r: Response): Promise<any> {
  return r.json().catch(() => ({}));
}

export async function loadDocWatches(larkAppId: string): Promise<{ watches: DocWatchRow[]; error?: string }> {
  try {
    const r = await fetch(`/api/doc-watches/${encodeURIComponent(larkAppId)}`);
    const body = await readJson(r);
    if (!r.ok) {
      return { watches: [], error: body?.error ? `${body.error}` : `HTTP ${r.status}` };
    }
    return { watches: Array.isArray(body.watches) ? body.watches : [] };
  } catch (err) {
    return { watches: [], error: err instanceof Error ? err.message : String(err) };
  }
}

export async function setDocWatchMode(
  larkAppId: string,
  fileToken: string,
  commentTriggerMode: DocWatchMode,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const r = await fetch(`/api/doc-watches/${encodeURIComponent(larkAppId)}/${encodeURIComponent(fileToken)}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ commentTriggerMode }),
    });
    const body = await readJson(r);
    if (!r.ok || body?.ok === false) return { ok: false, error: body?.error ?? `HTTP ${r.status}` };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function deleteDocWatch(
  larkAppId: string,
  fileToken: string,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const r = await fetch(`/api/doc-watches/${encodeURIComponent(larkAppId)}/${encodeURIComponent(fileToken)}`, {
      method: 'DELETE',
    });
    const body = await readJson(r);
    if (!r.ok || body?.ok === false) return { ok: false, error: body?.error ?? `HTTP ${r.status}` };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function createDocWatch(
  larkAppId: string,
  input: { docRef: string; commentTriggerMode?: DocWatchMode; workingDir?: string },
): Promise<{ ok: boolean; error?: string; message?: string }> {
  try {
    const r = await fetch(`/api/doc-watches/${encodeURIComponent(larkAppId)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    });
    const body = await readJson(r);
    if (!r.ok || body?.ok === false) {
      return { ok: false, error: body?.error ?? `HTTP ${r.status}`, message: body?.message };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** 相对时间。`undefined`（旧记录没这个字段）显示 `—` 而不是 1970。 */
export function relTime(ms: number | undefined): string {
  if (!ms || !Number.isFinite(ms)) return '—';
  const sec = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (sec < 60) return `${sec}s 前`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m 前`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h 前`;
  return `${Math.floor(h / 24)}d 前`;
}

/** 结局 → 展示语义。`kind` 决定色带：并非所有「非 dispatched」都是错误 ——
 *  `not-mentioned` / `self-authored` 是**正常**丢弃（mention-only 下绝大多数事件
 *  都是它），把它们标红会让健康的看板一片红、真故障反而被淹掉。 */
export function outcomeMeta(o: DocWatchOutcome | undefined): {
  kind: 'ok' | 'normal' | 'warn' | 'error';
  label: string;
  hint: string;
} {
  switch (o) {
    case 'dispatched':
      return { kind: 'ok', label: '已投递', hint: '过了全部闸口，已喂给会话' };
    case 'not-mentioned':
      return { kind: 'normal', label: '未 @ 本 bot', hint: 'mention-only 下的正常丢弃：这条评论没 @ 本 bot' };
    case 'self-authored':
      return { kind: 'normal', label: 'bot 自己的回复', hint: '自触发拦截，正常' };
    case 'empty-text':
      return { kind: 'warn', label: '纯 @ 无正文', hint: '有人 @ 了 bot 但一个字都没打；文档里已留 ❌ 标记' };
    case 'no-comment':
      return { kind: 'warn', label: '读不到评论正文', hint: '拉取评论失败（权限/网络）；文档里已留 ❌ 标记' };
    case 'trigger-missing':
      return { kind: 'warn', label: '回复串未补全', hint: '飞书分页未补全，这条评论的正文读不到' };
    case 'audit-rejected':
      return { kind: 'error', label: '审计门拒绝', hint: '非 owner 触发且通知 owner 失败 —— 已拒绝回复' };
    case 'poll-failed':
      return { kind: 'error', label: '轮询失败', hint: '应用身份读该文档失败：功能配着但不会再触发，需要处理' };
    default:
      return { kind: 'normal', label: '尚无记录', hint: '自升级以来还没有评论事件命中这篇文档' };
  }
}
