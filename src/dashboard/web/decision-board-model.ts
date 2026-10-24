// 决策看板页面（#/board）的纯逻辑：路由、草稿比较、提交确认框的条目、批次状态、
// 管家配置的保存载荷。不碰 DOM、不发请求，页面和测试都直接 import。
//
// 类型只从 core 模型 type-import：那个模块会连带拉进 lark-hosts 等服务端代码，
// 值导入会把它们打进浏览器 bundle。
import type {
  BoardBatch,
  BoardDecision,
  BoardDraft,
  BoardEvent,
  BoardFile,
  BoardItem,
  BoardLinkKind,
  BoardState,
  BoardView,
  StewardConfig,
  StewardGuideMode,
} from '../../core/decision-board/model.js';

export type {
  BoardBatch,
  BoardDecision,
  BoardDraft,
  BoardEvent,
  BoardFile,
  BoardItem,
  BoardState,
  BoardView,
  StewardConfig,
  StewardGuideMode,
};

export type Translate = (key: string, params?: Record<string, string | number>) => string;

/** 服务端渲染好的关联对象：text 是展示文字，url 缺省表示没法点开（如没有对外基址的会话）。 */
export interface RenderedLink {
  kind: BoardLinkKind;
  ref: string;
  label?: string;
  text: string;
  url?: string;
}

export interface StewardStatus {
  enabled: boolean;
  /** 开关开 + 选了管家群；没选群时批次送不出去。 */
  ready: boolean;
  chatId?: string;
}

export interface BoardCounts {
  decide: number;
  active: number;
  all: number;
}

export interface DraftStamp {
  seq: number;
  updatedAt: number;
}

export interface BoardItemSummary extends BoardItem {
  links: RenderedLink[];
  hasDraft: boolean;
  pendingDecisions: number;
  unseen: boolean;
  url?: string;
  appLink?: string;
}

export interface BoardListResponse {
  view: BoardView;
  steward: StewardStatus;
  counts: BoardCounts;
  items: BoardItemSummary[];
  drafts: DraftStamp[];
  batches: BoardBatch[];
}

export interface BoardDetailResponse {
  item: BoardItem;
  links: RenderedLink[];
  events: BoardEvent[];
  files: BoardFile[];
  draft?: BoardDraft;
  pendingDecisions: BoardDecision[];
  url?: string;
  appLink?: string;
  steward: StewardStatus;
  drafts: DraftStamp[];
}

export interface BoardSummary {
  larkAppId: string;
  botName: string;
  online: boolean;
  steward: StewardStatus;
  counts?: BoardCounts;
}

export const BOARD_VIEW_ORDER: readonly BoardView[] = ['decide', 'active', 'all'];

/** 管家配置保存后发出：侧边栏据此重新判断要不要显示「决策看板」。 */
export const DECISION_BOARD_CHANGED_EVENT = 'botmux:decision-board-changed';

// ─── 路由 ───────────────────────────────────────────────────────────────────

export interface BoardRoute {
  appId?: string;
  seq?: number;
  view?: BoardView;
  q?: string;
}

function isView(value: string | null | undefined): value is BoardView {
  return value === 'decide' || value === 'active' || value === 'all';
}

function safeDecode(raw: string): string | null {
  try { return decodeURIComponent(raw); } catch { return null; }
}

/**
 * `#/board`（汇总，`?bot=&view=&q=`）、`#/board/<app>`（该看板的汇总）、`#/board/<app>/<seq>`（详情）。
 * 不是看板地址返回 null。
 */
export function parseBoardHash(hash: string): BoardRoute | null {
  const queryIndex = hash.indexOf('?');
  const path = queryIndex < 0 ? hash : hash.slice(0, queryIndex);
  const params = new URLSearchParams(queryIndex < 0 ? '' : hash.slice(queryIndex + 1));
  const m = /^#\/board(?:\/([^/]+)(?:\/(\d{1,9}))?)?\/?$/.exec(path);
  if (!m) return null;
  const route: BoardRoute = {};
  const appId = m[1] !== undefined ? safeDecode(m[1]) : params.get('bot');
  if (appId) route.appId = appId;
  if (m[2] !== undefined && route.appId) route.seq = Number(m[2]);
  const view = params.get('view');
  if (isView(view)) route.view = view;
  const q = params.get('q')?.trim();
  if (q) route.q = q;
  return route;
}

export function boardSummaryHash(route: { appId?: string; view?: BoardView; q?: string } = {}): string {
  const params = new URLSearchParams();
  if (route.appId) params.set('bot', route.appId);
  if (route.view && route.view !== 'decide') params.set('view', route.view);
  const q = route.q?.trim();
  if (q) params.set('q', q);
  const query = params.toString();
  return `#/board${query ? `?${query}` : ''}`;
}

export function boardItemHash(appId: string, seq: number): string {
  return `#/board/${encodeURIComponent(appId)}/${seq}`;
}

/** 要打开哪张看板：地址里点名且存在的那张，否则第一张。 */
export function pickBoard<T extends { larkAppId: string }>(boards: readonly T[], requested?: string): T | undefined {
  return (requested ? boards.find(b => b.larkAppId === requested) : undefined) ?? boards[0];
}

export function boardsFromResponse(body: unknown): BoardSummary[] {
  const boards = (body as { boards?: unknown } | null)?.boards;
  if (!Array.isArray(boards)) return [];
  return boards.filter((b): b is BoardSummary => !!b && typeof (b as BoardSummary).larkAppId === 'string');
}

// ─── 状态与时间 ─────────────────────────────────────────────────────────────

export const BOARD_STATE_LABEL_KEYS: Readonly<Record<BoardState, string>> = {
  decide: 'decisionBoard.stateDecide',
  accept: 'decisionBoard.stateAccept',
  active: 'decisionBoard.stateActive',
  waiting: 'decisionBoard.stateWaiting',
  done: 'decisionBoard.stateDone',
  closed: 'decisionBoard.stateClosed',
};

export const BOARD_VIEW_LABEL_KEYS: Readonly<Record<BoardView, string>> = {
  decide: 'decisionBoard.tabDecide',
  active: 'decisionBoard.tabActive',
  all: 'decisionBoard.tabAll',
};

export const BOARD_EMPTY_VIEW_KEYS: Readonly<Record<BoardView, string>> = {
  decide: 'decisionBoard.emptyListDecide',
  active: 'decisionBoard.emptyListActive',
  all: 'decisionBoard.emptyListAll',
};

export const BOARD_ACTOR_LABEL_KEYS: Readonly<Record<BoardEvent['actor'], string>> = {
  steward: 'decisionBoard.actorSteward',
  owner: 'decisionBoard.actorOwner',
  system: 'decisionBoard.actorSystem',
};

export const BOARD_EVENT_KIND_KEYS: Readonly<Record<BoardEvent['kind'], string>> = {
  create: 'decisionBoard.eventCreate',
  note: 'decisionBoard.eventNote',
  state: 'decisionBoard.eventState',
  edit: 'decisionBoard.eventEdit',
  decision: 'decisionBoard.eventDecision',
  reply: 'decisionBoard.eventReply',
  attach: 'decisionBoard.eventAttach',
  link: 'decisionBoard.eventLink',
};

/** 「待拍板·在审」：状态 + 自由文本阶段。 */
export function stateChipText(state: BoardState, stage: string | undefined, tr: Translate): string {
  const label = tr(BOARD_STATE_LABEL_KEYS[state] ?? BOARD_STATE_LABEL_KEYS.active);
  const s = stage?.trim();
  return s ? `${label}·${s}` : label;
}

export function boardRelativeTime(ms: number | undefined, now: number, tr: Translate): string {
  if (!ms) return '-';
  const diff = Math.max(0, now - ms);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diff < minute) return tr('decisionBoard.timeJustNow');
  if (diff < hour) return tr('decisionBoard.timeMinutes', { n: Math.floor(diff / minute) });
  if (diff < day) return tr('decisionBoard.timeHours', { n: Math.floor(diff / hour) });
  if (diff < 2 * day) return tr('decisionBoard.timeYesterday');
  if (diff < 30 * day) return tr('decisionBoard.timeDays', { n: Math.floor(diff / day) });
  return boardClock(ms).slice(0, 5);
}

/** 时间线用的 `MM-DD HH:mm`（本地时区）。 */
export function boardClock(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// ─── 草稿 ───────────────────────────────────────────────────────────────────

export interface DraftInput {
  choice?: string;
  text: string;
  fileIds: string[];
}

export const EMPTY_DRAFT: DraftInput = { text: '', fileIds: [] };

export function draftFromServer(draft: BoardDraft | null | undefined): DraftInput {
  if (!draft) return { text: '', fileIds: [] };
  return { ...(draft.choice ? { choice: draft.choice } : {}), text: draft.text ?? '', fileIds: [...(draft.fileIds ?? [])] };
}

/** 与服务端同一口径：没选项、没文字（空白不算）、没图 = 空草稿，保存即删除。 */
export function isDraftEmpty(draft: DraftInput): boolean {
  return !draft.choice?.trim() && !draft.text.trim() && draft.fileIds.length === 0;
}

/** 两份草稿内容是否相同（决定要不要再存一次）。 */
export function sameDraftContent(a: DraftInput, b: DraftInput): boolean {
  if (isDraftEmpty(a) && isDraftEmpty(b)) return true;
  if ((a.choice?.trim() || '') !== (b.choice?.trim() || '')) return false;
  if (a.text.replace(/\r\n/g, '\n') !== b.text.replace(/\r\n/g, '\n')) return false;
  return a.fileIds.length === b.fileIds.length && a.fileIds.every((id, i) => id === b.fileIds[i]);
}

/** 草稿写下时看的是旧版本（管家之后又改过这一项）。 */
export function draftNeedsReview(draft: Pick<BoardDraft, 'baseRev'> | null | undefined, item: Pick<BoardItem, 'rev'>): boolean {
  return !!draft && draft.baseRev < item.rev;
}

export type DraftSaveState = 'idle' | 'pending' | 'saving' | 'saved' | 'error';

/**
 * 详情页提交按钮的口径：本项有没有已保存的草稿，另外还有几项草稿。
 * `boardDrafts` 是服务端给的整张看板的草稿列表（可能还没包含本项刚存的那份）。
 */
export function submitScope(boardDrafts: readonly DraftStamp[], seq: number, ownDraft: boolean): { own: boolean; others: number; total: number } {
  const others = new Set(boardDrafts.filter(d => d.seq !== seq).map(d => d.seq)).size;
  return { own: ownDraft, others, total: others + (ownDraft ? 1 : 0) };
}

// ─── 图片 ───────────────────────────────────────────────────────────────────

export const BOARD_IMAGE_TYPES: readonly string[] = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
export const BOARD_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
export const BOARD_FILES_PER_DRAFT = 8;

export type ImageCheck = { ok: true } | { ok: false; reason: 'type' | 'size' | 'count' };

/** 贴进 / 拖入 / 选择的图片：先在浏览器里挡掉服务端一定会拒的（类型、大小、张数）。 */
export function checkBoardImages(files: ReadonlyArray<{ type: string; size: number }>, existing: number): ImageCheck {
  if (files.some(f => !BOARD_IMAGE_TYPES.includes(f.type.toLowerCase()))) return { ok: false, reason: 'type' };
  if (files.some(f => f.size > BOARD_IMAGE_MAX_BYTES)) return { ok: false, reason: 'size' };
  if (existing + files.length > BOARD_FILES_PER_DRAFT) return { ok: false, reason: 'count' };
  return { ok: true };
}

// ─── 提交 ───────────────────────────────────────────────────────────────────

export interface SubmitCandidate {
  seq: number;
  title: string;
  state: BoardState;
  stage?: string;
  choice?: string;
  choiceLabel?: string;
  recommended: boolean;
  text: string;
  imageCount: number;
  draftUpdatedAt: number;
  /** 草稿写下后管家又改过这一项。 */
  stale: boolean;
}

/** 确认框里的一行；这一项已经没有草稿时返回 null（在别处提交或清空了）。 */
export function submitCandidateFromDetail(detail: Pick<BoardDetailResponse, 'item' | 'draft'>): SubmitCandidate | null {
  const { item, draft } = detail;
  if (!draft || isDraftEmpty(draftFromServer(draft))) return null;
  const option = draft.choice ? item.options.find(o => o.key === draft.choice) : undefined;
  return {
    seq: item.seq,
    title: item.title,
    state: item.state,
    ...(item.stage ? { stage: item.stage } : {}),
    ...(draft.choice ? { choice: draft.choice } : {}),
    ...(option ? { choiceLabel: option.label } : {}),
    recommended: !!draft.choice && item.recommend === draft.choice,
    text: draft.text,
    imageCount: draft.fileIds.length,
    draftUpdatedAt: draft.updatedAt,
    stale: draftNeedsReview(draft, item),
  };
}

/** 确认框的顺序：当前详情页那一项排第一，其余按编号。 */
export function orderSubmitCandidates(candidates: readonly SubmitCandidate[], firstSeq?: number): SubmitCandidate[] {
  return [...candidates].sort((a, b) => {
    if (a.seq === firstSeq) return -1;
    if (b.seq === firstSeq) return 1;
    return a.seq - b.seq;
  });
}

/** 提交请求的 items：去掉取消勾选（继续留作草稿）的项，每项带确认框看到的草稿版本。 */
export function submitPayloadItems(candidates: readonly SubmitCandidate[], excluded: ReadonlySet<number>): Array<{ seq: number; draftUpdatedAt: number }> {
  return candidates.filter(c => !excluded.has(c.seq)).map(c => ({ seq: c.seq, draftUpdatedAt: c.draftUpdatedAt }));
}

export function textPreview(text: string, max = 80): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** 汇总页一行里的「要你定：…」：问题（markdown）的第一行，去掉标记符号。 */
export function questionOneLine(markdown: string, max = 80): string {
  const line = markdown.split('\n').map(l => l.trim()).find(Boolean) ?? '';
  const plain = line
    .replace(/^(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)+/, '')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__|`)/g, '');
  return textPreview(plain, max);
}

export function newSubmitNonce(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

// ─── 批次 ───────────────────────────────────────────────────────────────────

const BATCH_STUCK_MS = 2 * 60_000;

export interface BatchView {
  labelKey: string;
  tone: 'ok' | 'warn' | 'error';
  /** 失败原因（已翻译）；没有就是 undefined。 */
  reason?: string;
  /** 管家没选群：给一个去 Bot 配置的入口。 */
  needsChat: boolean;
  canRedeliver: boolean;
}

/** 服务端记在批次上的失败原因 → 给人看的话。不认识的原样显示。 */
export function batchErrorText(error: string | undefined, tr: Translate): string | undefined {
  if (!error) return undefined;
  if (error === 'steward_chat_missing') return tr('decisionBoard.errStewardChatMissing');
  if (error === 'steward_disabled') return tr('decisionBoard.errStewardDisabled');
  if (error === 'delivery_interrupted') return tr('decisionBoard.errDeliveryInterrupted');
  return error;
}

export function batchView(batch: BoardBatch, now: number, tr: Translate): BatchView {
  if (batch.delivery === 'delivered') {
    return { labelKey: 'decisionBoard.batchDelivered', tone: 'ok', needsChat: false, canRedeliver: false };
  }
  if (batch.delivery === 'dispatched') {
    // In-flight：投递已经开始、正在 deliver() 里（发横幅/会话锁/worker IPC）。显示「投递中」，
    // 不给重投（服务端也会挡住对 in-flight 批次的 settle/重投）。跨重启残留的 dispatched 由
    // daemon 启动补投收敛成 failed/interrupted，页面几乎不会停在这个状态。
    return { labelKey: 'decisionBoard.batchPending', tone: 'warn', needsChat: false, canRedeliver: false };
  }
  if (batch.delivery === 'pending') {
    // 投递一启动就进入 dispatched，所以真正 pending 卡住基本只剩「进程死在 dispatched
    // 落盘前」这一毫秒级窗口；挂很久时给一个手动重投入口。
    return { labelKey: 'decisionBoard.batchPending', tone: 'warn', needsChat: false, canRedeliver: now - batch.createdAt > BATCH_STUCK_MS };
  }
  return {
    labelKey: 'decisionBoard.batchFailed',
    tone: 'error',
    reason: batchErrorText(batch.error, tr),
    needsChat: batch.error === 'steward_chat_missing',
    canRedeliver: true,
  };
}

/** 接口失败时给人看的话：中文界面优先用服务端的 message（带编号等细节），其余按错误码翻译。 */
export function boardErrorText(body: unknown, status: number, tr: Translate, locale: 'zh' | 'en'): string {
  const b = (body && typeof body === 'object' ? body : {}) as { error?: unknown; message?: unknown };
  const code = typeof b.error === 'string' ? b.error : '';
  const message = typeof b.message === 'string' ? b.message.trim() : '';
  if (message && locale === 'zh') return message;
  const known: Record<string, string> = {
    daemon_offline: 'decisionBoard.errDaemonOffline',
    not_steward: 'decisionBoard.errNotSteward',
    unauthorized: 'decisionBoard.errUnauthorized',
    draft_changed: 'decisionBoard.errDraftChanged',
    draft_missing: 'decisionBoard.errDraftMissing',
    nothing_to_submit: 'decisionBoard.errNothingToSubmit',
    item_not_found: 'decisionBoard.notFound',
    bot_not_found: 'decisionBoard.errBotNotFound',
  };
  if (known[code]) return tr(known[code]);
  return tr('decisionBoard.errGeneric', { error: message || code || `HTTP ${status}` });
}

// ─── 管家配置（Bot 配置页）──────────────────────────────────────────────────

export interface StewardForm {
  enabled: boolean;
  chatId: string;
  guideMode: StewardGuideMode;
  guideText: string;
}

export function stewardFormFrom(cfg: StewardConfig | null | undefined): StewardForm {
  return {
    enabled: cfg?.enabled === true,
    chatId: cfg?.chatId ?? '',
    guideMode: cfg?.guideMode === 'replace' ? 'replace' : 'append',
    guideText: cfg?.guideText ?? '',
  };
}

/**
 * PUT /api/bots/:app/steward 的 `steward` 字段。等于默认（关、无群、无自定义）时给 null，
 * 与服务端「等于默认不写盘」一致；追加是默认方式，不写 guideMode。
 */
export function stewardPayload(form: StewardForm): StewardConfig | null {
  const chatId = form.chatId.trim();
  const guideText = form.guideText.replace(/\r\n/g, '\n').trim();
  const value: StewardConfig = {
    enabled: form.enabled,
    ...(chatId ? { chatId } : {}),
    ...(form.guideMode === 'replace' ? { guideMode: 'replace' as const } : {}),
    ...(guideText ? { guideText } : {}),
  };
  if (!value.enabled && !value.chatId && !value.guideMode && !value.guideText) return null;
  return value;
}

/** 选了「替换预置」却没写内容：服务端会拒，先在页面上拦下。 */
export function stewardGuideProblem(form: StewardForm): 'replace_empty' | null {
  return form.guideMode === 'replace' && !form.guideText.trim() ? 'replace_empty' : null;
}

/** 服务端校验错误形如 `invalid_steward: 选了「替换预置」就要填写自定义提示词`，去掉机器前缀。 */
export function stewardErrorText(error: unknown, tr: Translate): string {
  const raw = typeof error === 'string' ? error : String(error ?? '');
  if (raw === 'daemon_offline') return tr('decisionBoard.errDaemonOffline');
  return raw.replace(/^invalid_steward:\s*/, '') || tr('decisionBoard.errGeneric', { error: raw });
}
