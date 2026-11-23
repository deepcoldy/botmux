// 决策看板页面（#/board）的纯逻辑：路由、草稿比较、提交确认框的条目、批次状态、
// 管家配置的保存载荷。不碰 DOM、不发请求，页面和测试都直接 import。
//
// 类型只从 core 模型 type-import：那个模块会连带拉进 lark-hosts 等服务端代码，
// 值导入会把它们打进浏览器 bundle。files.js 不依赖任何模块，可以值导入。
import { boardFileKind, type BoardFileKind } from '../../core/decision-board/files.js';
// overview.js 同样只 type-import 模型、不引服务端代码，可以值导入。
import {
  boardCheckStatus,
  boardIdleTooLong,
  boardLastActivity,
  boardWaitingOn,
  type BoardWaitingOn,
  type ChildStats,
  type OverviewGroup,
} from '../../core/decision-board/overview.js';
import type {
  BoardBatch,
  BoardChatCheck,
  BoardDecision,
  BoardDraft,
  BoardEvent,
  BoardFile,
  BoardHint,
  BoardHintKind,
  BoardItem,
  BoardLinkKind,
  BoardState,
  BoardView,
  StewardConfig,
  StewardGuideMode,
} from '../../core/decision-board/model.js';
import type { ChatTaskKind, ChatTaskState, TaskHint, TaskHintKind } from '../../core/decision-board/chat-task.js';
import type { NeedsYouReason } from '../../core/session-task-status.js';

export type { ChatTaskKind, ChatTaskState, TaskHint, TaskHintKind };
export type { BoardWaitingOn, ChildStats, OverviewGroup };
export {
  buildBoardOverview,
  nestBoardList,
  overviewGroupCounts,
  readyToWrapUp,
} from '../../core/decision-board/overview.js';

export type {
  BoardBatch,
  BoardHint,
  BoardHintKind,
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
  /** 仅 chat：这一项的主群。旧 daemon 不给，按第一个群算（见 itemChatView）。 */
  primary?: boolean;
  /** 仅 chat：verified / unverified；缺省 = 核实功能上线前的旧关联，不打标。 */
  chatCheck?: BoardChatCheck;
  /** 仅 chat：查到的群名（text 已按「标签 > 群名」取好，这里只是原始值）。 */
  chatName?: string;
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

/** 关联群里的子任务：各群状态、是否有管家还没处理的新结果、子任务提示（旧 daemon 不带）。 */
export interface ItemTaskFields {
  taskChats?: ChatTaskState[];
  taskFresh?: boolean;
  taskHint?: TaskHint;
}

/** 引用另一项（上级、子任务）时的几个字段。 */
export interface BoardItemRef {
  seq: number;
  title: string;
  state: BoardState;
  stage?: string;
}

export interface BoardItemSummary extends BoardItem, ItemTaskFields {
  links: RenderedLink[];
  hasDraft: boolean;
  pendingDecisions: number;
  unseen: boolean;
  url?: string;
  appLink?: string;
  /** 图文说明（说明页 + 视频）个数；没有或旧 daemon 不带。 */
  explainers?: number;
  /** 最近一次有人动过这一项或它的子孙的时间；旧 daemon 不带（按更新时间算）。 */
  lastActivityAt?: number;
  /** 同上，只看这一项自己（复查时间之后有没有动过按它算）。 */
  ownActivityAt?: number;
  /** 上级事项（按整张看板算）；没有上级或旧 daemon 不带。 */
  parent?: BoardItemRef;
  /** 直接子任务的完成情况（按整张看板算）；没有子任务或旧 daemon 不带。 */
  childStats?: ChildStats;
}

// ─── 事项关联的群 ─────────────────────────────────────────────────────────────

export interface ItemChatView {
  /** 这一项的群，主群在最前，其余按管家写入的顺序。 */
  chats: RenderedLink[];
  primary?: RenderedLink;
  /** 只在没有群时生效（之后补了群，原因就不再成立）。 */
  noChatReason?: string;
  /** 没有群、也没写原因：页面标「缺群」，提醒管家补。 */
  missing: boolean;
}

/** 汇总行和详情页共用：从关联里挑出群、定主群（服务端标的 primary，没标就是第一个群）。 */
export function itemChatView(item: Pick<BoardItem, 'noChatReason'>, links: readonly RenderedLink[]): ItemChatView {
  const chats = links.filter(l => l.kind === 'chat');
  const primary = chats.find(l => l.primary) ?? chats[0];
  const reason = item.noChatReason?.trim();
  return {
    chats: primary ? [primary, ...chats.filter(l => l !== primary)] : [],
    ...(primary ? { primary } : {}),
    ...(!primary && reason ? { noChatReason: reason } : {}),
    missing: !primary && !reason,
  };
}

/** 详情页下方的关联对象里不再重复列群（群在标题下方单独一栏）。 */
export function nonChatLinks(links: readonly RenderedLink[]): RenderedLink[] {
  return links.filter(l => l.kind !== 'chat');
}

export interface BoardListResponse {
  view: BoardView;
  steward: StewardStatus;
  counts: BoardCounts;
  items: BoardItemSummary[];
  drafts: DraftStamp[];
  batches: BoardBatch[];
}

export interface BoardDetailResponse extends ItemTaskFields {
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
  /**
   * 这一项现在的这一轮拍板（存草稿时原样带回去）：管家之后改了状态、问题或选项，服务端拒绝迟到的保存
   *（draft_outdated），原来的草稿已收进历史。旧 daemon 不给。
   */
  draftAskKey?: string;
  /** 以下旧 daemon 不给。 */
  lastActivityAt?: number;
  ownActivityAt?: number;
  parent?: BoardItemRef;
  /** 直接子任务（全部状态），按编号。 */
  children?: BoardItemRef[];
  childStats?: ChildStats;
}

export interface BoardSummary {
  larkAppId: string;
  botName: string;
  online: boolean;
  steward: StewardStatus;
  counts?: BoardCounts;
}

/**
 * 汇总页的视图：服务端的三个视图，加上页面自己的「总览」（取全部事项，在页面上按树分组排序，见 overview.ts）。
 * 总览放在「进行中」和「全部」之间：前两个是子集，总览是所有没结束的，「全部」还带上已结束的。
 */
export type BoardPageView = BoardView | 'overview';

export const BOARD_VIEW_ORDER: readonly BoardPageView[] = ['decide', 'active', 'overview', 'all'];

/** 向服务端要哪个视图：总览要全部（已结束的上级要当层级显示，子任务完成情况也要算上已结束的）。 */
export function serverView(view: BoardPageView): BoardView {
  return view === 'overview' ? 'all' : view;
}

/** 标签上的数：总览 = 没结束的（待你拍板 + 进行中）。 */
export function pageViewCount(counts: BoardCounts, view: BoardPageView): number {
  return view === 'overview' ? counts.decide + counts.active : counts[view];
}

/** 管家配置保存后发出：侧边栏据此重新判断要不要显示「决策看板」。 */
export const DECISION_BOARD_CHANGED_EVENT = 'botmux:decision-board-changed';

// ─── 路由 ───────────────────────────────────────────────────────────────────

export interface BoardRoute {
  appId?: string;
  seq?: number;
  view?: BoardPageView;
  q?: string;
}

function isView(value: string | null | undefined): value is BoardPageView {
  return value === 'decide' || value === 'active' || value === 'all' || value === 'overview';
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

export function boardSummaryHash(route: { appId?: string; view?: BoardPageView; q?: string } = {}): string {
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

// ─── 详情页的上一项 / 下一项 ─────────────────────────────────────────────────

/**
 * owner 进详情页时看到的那份列表：哪张看板、哪个视图 / 搜索、按什么顺序。上一项 / 下一项
 * 只在这份列表里走，顺序就是 owner 刚才看到的顺序，切换途中不重新排。
 */
export interface BoardNavList {
  appId: string;
  view: BoardPageView;
  q?: string;
  seqs: number[];
}

export const BOARD_NAV_STORAGE_KEY = 'botmux.decisionBoard.nav';

export function navListFrom(appId: string, view: BoardPageView, q: string | undefined, items: readonly { seq: number }[]): BoardNavList {
  const query = q?.trim();
  return { appId, view, ...(query ? { q: query } : {}), seqs: items.map(i => i.seq) };
}

/** 从 sessionStorage 读回来的值不可信：形状不对就当没有。 */
export function parseNavList(raw: unknown): BoardNavList | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.appId !== 'string' || !r.appId || !isView(r.view as string)) return null;
  if (!Array.isArray(r.seqs) || !r.seqs.every(n => Number.isSafeInteger(n) && (n as number) > 0)) return null;
  return { appId: r.appId, view: r.view as BoardPageView, ...(typeof r.q === 'string' && r.q ? { q: r.q } : {}), seqs: [...r.seqs as number[]] };
}

export interface BoardNeighbors {
  prev?: number;
  next?: number;
  /** 从 1 起的位置。 */
  position: number;
  total: number;
  view: BoardPageView;
}

/** 当前项在列表里的前后项；列表不是这张看板的、或者当前项不在列表里，返回 null。 */
export function boardNeighbors(list: BoardNavList | null | undefined, appId: string, seq: number): BoardNeighbors | null {
  if (!list || list.appId !== appId) return null;
  const index = list.seqs.indexOf(seq);
  if (index < 0) return null;
  return {
    ...(index > 0 ? { prev: list.seqs[index - 1] } : {}),
    ...(index < list.seqs.length - 1 ? { next: list.seqs[index + 1] } : {}),
    position: index + 1,
    total: list.seqs.length,
    view: list.view,
  };
}

/** 直接从飞书链接打开详情页（没有经过列表）时，用这一项所在的视图当切换范围。 */
export function viewForItemState(state: BoardState): BoardView {
  if (state === 'decide' || state === 'accept') return 'decide';
  if (state === 'active' || state === 'waiting') return 'active';
  return 'all';
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

export const BOARD_VIEW_LABEL_KEYS: Readonly<Record<BoardPageView, string>> = {
  decide: 'decisionBoard.tabDecide',
  active: 'decisionBoard.tabActive',
  overview: 'decisionBoard.tabOverview',
  all: 'decisionBoard.tabAll',
};

export const BOARD_EMPTY_VIEW_KEYS: Readonly<Record<BoardPageView, string>> = {
  decide: 'decisionBoard.emptyListDecide',
  active: 'decisionBoard.emptyListActive',
  overview: 'decisionBoard.emptyListOverview',
  all: 'decisionBoard.emptyListAll',
};

// ─── 总览与父子任务 ───────────────────────────────────────────────────────────

/** 总览每一组的标题和一句说明。 */
export const OVERVIEW_GROUP_KEYS: Readonly<Record<OverviewGroup, { label: string; hint: string }>> = {
  needs_you: { label: 'decisionBoard.ovNeedsYou', hint: 'decisionBoard.ovNeedsYouHint' },
  overdue: { label: 'decisionBoard.ovOverdue', hint: 'decisionBoard.ovOverdueHint' },
  stalled: { label: 'decisionBoard.ovStalled', hint: 'decisionBoard.ovStalledHint' },
  active: { label: 'decisionBoard.ovActive', hint: 'decisionBoard.ovActiveHint' },
  waiting: { label: 'decisionBoard.ovWaiting', hint: 'decisionBoard.ovWaitingHint' },
  parked: { label: 'decisionBoard.ovParked', hint: 'decisionBoard.ovParkedHint' },
};

/** 「在等你拍板」「管家在推进」「在等：PR 作者」……；tone 给页面上色（等你的最显眼）。 */
function waitingOnText(w: BoardWaitingOn, tr: Translate): { text: string; tone: 'owner' | 'steward' | 'external' } {
  if (w.kind === 'owner') return { text: tr(w.what === 'accept' ? 'decisionBoard.waitOwnerAccept' : 'decisionBoard.waitOwnerDecide'), tone: 'owner' };
  if (w.kind === 'steward') return { text: tr(w.what === 'execute' ? 'decisionBoard.waitStewardExecute' : 'decisionBoard.waitStewardWork'), tone: 'steward' };
  return { text: w.who ? tr('decisionBoard.waitExternal', { who: w.who }) : tr('decisionBoard.waitExternalUnknown'), tone: 'external' };
}

/**
 * 一项的跟进情况（总览行、详情页共用）：在等谁、最近进展（很久没动时换成「N 天没动」）、复查时间（到点且之后没动 /
 * 约在以后；到点后有过进展的不再显示）。已结束的项只给最近进展。规则和总览分组同一套（overview.ts）。
 */
export function trackingView(item: Pick<BoardItem, 'state' | 'stage' | 'waitingOn' | 'nextCheckAt' | 'updatedAt' | 'createdAt'>
  & { lastActivityAt?: number; ownActivityAt?: number; pendingDecisions: number }, now: number, tr: Translate): {
  waiting?: { text: string; tone: 'owner' | 'steward' | 'external' };
  activity: { text: string; stale: boolean };
  check?: { text: string; due: boolean };
} {
  const last = boardLastActivity(item);
  const ended = isBoardItemEnded(item.state);
  const idle = now - last;
  const stale = boardIdleTooLong(item, now);
  const check = ended ? 'none' : boardCheckStatus(item, now);
  return {
    ...(ended ? {} : { waiting: waitingOnText(boardWaitingOn(item), tr) }),
    activity: {
      text: stale ? tr('decisionBoard.idleDays', { n: Math.floor(idle / 86_400_000) }) : tr('decisionBoard.lastActivity', { time: boardRelativeTime(last, now, tr) }),
      stale,
    },
    ...(item.nextCheckAt !== undefined && (check === 'due' || check === 'later') ? {
      check: check === 'due'
        ? { text: tr('decisionBoard.nextCheckDue', { time: boardClock(item.nextCheckAt) }), due: true }
        : { text: tr('decisionBoard.nextCheck', { time: boardClock(item.nextCheckAt) }), due: false },
    } : {}),
  };
}

/** 「子任务 3/5」，以及悬停时的细分「2 项完成 · 1 项关闭 · 2 项没结束」。 */
export function childProgressText(stats: ChildStats, tr: Translate): { text: string; title: string } {
  const finished = stats.done + stats.closed;
  return {
    text: tr('decisionBoard.childProgress', { done: finished, total: stats.total }),
    title: tr('decisionBoard.childProgressTitle', { done: stats.done, closed: stats.closed, open: stats.total - finished }),
  };
}

export const BOARD_ACTOR_LABEL_KEYS: Readonly<Record<BoardEvent['actor'], string>> = {
  steward: 'decisionBoard.actorSteward',
  owner: 'decisionBoard.actorOwner',
  system: 'decisionBoard.actorSystem',
};

/** 巡检提示的标签：建议关闭 / 建议推进 / 该看一眼。 */
export const BOARD_HINT_LABEL_KEYS: Readonly<Record<BoardHintKind, string>> = {
  close: 'decisionBoard.hintClose',
  advance: 'decisionBoard.hintAdvance',
  stale: 'decisionBoard.hintStale',
};

/** 认得的提示才显示（新 daemon 加了别的类型、旧页面不认时不显示半截标签）。 */
export function knownHint(hint: BoardHint | undefined): BoardHint | undefined {
  return hint && Object.prototype.hasOwnProperty.call(BOARD_HINT_LABEL_KEYS, hint.kind) ? hint : undefined;
}

/** 关联群状态的标签。 */
export const CHAT_TASK_LABEL_KEYS: Readonly<Record<ChatTaskKind, string>> = {
  needs_you: 'decisionBoard.taskNeedsYou',
  interrupted: 'decisionBoard.taskInterrupted',
  working: 'decisionBoard.taskWorking',
  unreadable: 'decisionBoard.taskUnreadable',
  delivered: 'decisionBoard.taskDelivered',
  idle: 'decisionBoard.taskIdle',
  closed: 'decisionBoard.taskClosed',
  no_session: 'decisionBoard.taskNoSession',
};

const CHAT_TASK_ORDER: readonly ChatTaskKind[] = ['needs_you', 'interrupted', 'working', 'unreadable', 'delivered', 'idle', 'closed', 'no_session'];

const NEEDS_YOU_REASON_KEYS: Readonly<Record<NeedsYouReason, string>> = {
  attention: 'sessions.task.reasonAttention',
  tui_prompt: 'sessions.task.reasonPrompt',
  pending_repo: 'sessions.board.signalRepo',
  limited: 'sessions.board.signalLimited',
  stalled: 'sessions.board.signalStalled',
  interrupted: 'sessions.task.reasonInterrupted',
};

export const TASK_HINT_LABEL_KEYS: Readonly<Record<TaskHintKind, string>> = {
  task_delivered: 'decisionBoard.taskHintDelivered',
  task_needs_you: 'decisionBoard.taskHintNeedsYou',
  task_interrupted: 'decisionBoard.taskHintInterrupted',
};

export function knownTaskHint(hint: TaskHint | undefined): TaskHint | undefined {
  return hint && Object.prototype.hasOwnProperty.call(TASK_HINT_LABEL_KEYS, hint.kind) ? hint : undefined;
}

function knownChatTask(state: ChatTaskState): boolean {
  return Object.prototype.hasOwnProperty.call(CHAT_TASK_LABEL_KEYS, state.kind);
}

/** 一个群的状态一行：标签（需要你带原因）、时间、一句话（最终回复第一行 / 举手原因 / 错误码）。 */
export function chatTaskLine(state: ChatTaskState, now: number, tr: Translate): { label: string; time?: string; text?: string } | null {
  if (!knownChatTask(state)) return null;
  const kind = tr(CHAT_TASK_LABEL_KEYS[state.kind]);
  const label = state.kind === 'needs_you' && state.reason && state.reason !== 'attention'
    ? `${kind} · ${tr(NEEDS_YOU_REASON_KEYS[state.reason])}`
    : kind;
  const showTime = state.at !== undefined && state.kind !== 'closed';
  const text = state.summary ?? state.detail;
  return { label, ...(showTime ? { time: boardRelativeTime(state.at, now, tr) } : {}), ...(text ? { text } : {}) };
}

/** 多群汇总：「3 个群：1 进行中 · 2 已交付」。按「需要你→…→没有会话」的顺序。 */
export function chatTaskSummaryText(states: readonly ChatTaskState[], tr: Translate): string {
  const known = states.filter(knownChatTask);
  const counts = new Map<ChatTaskKind, number>();
  for (const s of known) counts.set(s.kind, (counts.get(s.kind) ?? 0) + 1);
  const parts = CHAT_TASK_ORDER.filter(k => counts.has(k)).map(k => `${counts.get(k)} ${tr(CHAT_TASK_LABEL_KEYS[k])}`);
  return tr('decisionBoard.taskSummary', { n: known.length, parts: parts.join(' · ') });
}

export const BOARD_EVENT_KIND_KEYS: Readonly<Record<BoardEvent['kind'], string>> = {
  create: 'decisionBoard.eventCreate',
  note: 'decisionBoard.eventNote',
  state: 'decisionBoard.eventState',
  edit: 'decisionBoard.eventEdit',
  decision: 'decisionBoard.eventDecision',
  reply: 'decisionBoard.eventReply',
  attach: 'decisionBoard.eventAttach',
  link: 'decisionBoard.eventLink',
  hint: 'decisionBoard.eventHint',
  draft: 'decisionBoard.eventDraft',
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

// ─── 图文说明 ─────────────────────────────────────────────────────────────────────

export type { BoardFileKind };

export interface BoardExplainer {
  id: string;
  kind: 'html' | 'video';
  name: string;
  bytes: number;
  createdAt: number;
}

/**
 * 说明页嵌在页内时 iframe 的 sandbox：空串 = 全部限制（不跑脚本、不透明源、不能弹窗 / 提交表单 / 导航顶层）。
 * 和响应头里的 CSP sandbox 是两道闸，哪一道单独都够。
 */
export const BOARD_EXPLAINER_SANDBOX = '';

/** 事项的图文说明（说明页和视频），新附的在前；截图不算。 */
export function boardExplainers(files: readonly BoardFile[]): BoardExplainer[] {
  const out: BoardExplainer[] = [];
  for (const f of files) {
    const kind = boardFileKind(f.mime);
    if (kind === 'html' || kind === 'video') out.push({ id: f.id, kind, name: f.name, bytes: f.bytes, createdAt: f.createdAt });
  }
  return out.sort((a, b) => b.createdAt - a.createdAt);
}

/** 历史里一个附件怎么显示：不在文件列表里的按截图处理（和以前一样）。 */
export function eventFileKind(id: string, files: ReadonlyMap<string, BoardFile>): BoardFileKind {
  const file = files.get(id);
  return (file && boardFileKind(file.mime)) || 'image';
}

export function formatBoardBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
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

/**
 * 确认框里的一行；这一项已经没有草稿（在别处提交或清空了）、或已经结束时返回 null。结束的事项不再收决定：
 * 新 daemon 会把上面的草稿收进历史，旧 daemon 可能还给，也不列进确认框。
 */
export function submitCandidateFromDetail(detail: Pick<BoardDetailResponse, 'item' | 'draft'>): SubmitCandidate | null {
  const { item, draft } = detail;
  if (!draft || isDraftEmpty(draftFromServer(draft)) || isBoardItemEnded(item.state)) return null;
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

/**
 * 已完成 / 已关闭的事项不再收决定：服务端拒绝给它存草稿、拒绝提交它的草稿，事项结束时把草稿收进历史。
 * 旧 daemon 结束时不收草稿，这类事项上可能还留着一份——页面上只能清空，不能再提交。
 */
export function isBoardItemEnded(state: BoardState): boolean {
  return state === 'done' || state === 'closed';
}

/**
 * 提交请求的 items：去掉取消勾选（继续留作草稿）的项和已结束的项（带上它服务端会拒掉整批），
 * 每项带确认框看到的草稿版本。
 */
export function submitPayloadItems(candidates: readonly SubmitCandidate[], excluded: ReadonlySet<number>): Array<{ seq: number; draftUpdatedAt: number }> {
  return candidates.filter(c => !excluded.has(c.seq) && !isBoardItemEnded(c.state)).map(c => ({ seq: c.seq, draftUpdatedAt: c.draftUpdatedAt }));
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
    draft_outdated: 'decisionBoard.errDraftOutdated',
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
  /** 拉新群时带上管家；默认开。 */
  autoJoinNewGroups: boolean;
  /** 只有一个人和一个 bot 的新群也带上管家；默认关。 */
  autoJoinSoloGroups: boolean;
  /** 待拍板时往管家群发能直接点选项的卡片；默认开。 */
  decisionCards: boolean;
  /** 后台巡检找出可以关 / 可以推进 / 该看一眼的事项；默认关。 */
  closeHints: boolean;
  /** 关联群里一轮交付 / 举手 / 中断时提醒管家；默认关。 */
  taskHints: boolean;
}

export function stewardFormFrom(cfg: StewardConfig | null | undefined): StewardForm {
  return {
    enabled: cfg?.enabled === true,
    chatId: cfg?.chatId ?? '',
    guideMode: cfg?.guideMode === 'replace' ? 'replace' : 'append',
    guideText: cfg?.guideText ?? '',
    autoJoinNewGroups: cfg?.autoJoinNewGroups !== false,
    autoJoinSoloGroups: cfg?.autoJoinSoloGroups === true,
    decisionCards: cfg?.decisionCards !== false,
    closeHints: cfg?.closeHints === true,
    taskHints: cfg?.taskHints === true,
  };
}

/**
 * PUT /api/bots/:app/steward 的 `steward` 字段。等于默认（关、无群、无自定义、拉群带管家、单人群
 * 不带）时给 null，与服务端「等于默认不写盘」一致；追加是默认方式，不写 guideMode；两个拉群开关只在
 * 偏离默认时写。
 */
export function stewardPayload(form: StewardForm): StewardConfig | null {
  const chatId = form.chatId.trim();
  const guideText = form.guideText.replace(/\r\n/g, '\n').trim();
  const value: StewardConfig = {
    enabled: form.enabled,
    ...(chatId ? { chatId } : {}),
    ...(form.guideMode === 'replace' ? { guideMode: 'replace' as const } : {}),
    ...(guideText ? { guideText } : {}),
    ...(form.autoJoinNewGroups ? {} : { autoJoinNewGroups: false }),
    ...(form.autoJoinSoloGroups ? { autoJoinSoloGroups: true } : {}),
    ...(form.decisionCards ? {} : { decisionCards: false }),
    ...(form.closeHints ? { closeHints: true } : {}),
    ...(form.taskHints ? { taskHints: true } : {}),
  };
  if (!value.enabled && !value.chatId && !value.guideMode && !value.guideText
    && value.autoJoinNewGroups !== false && value.autoJoinSoloGroups !== true && value.closeHints !== true
    && value.decisionCards !== false && value.taskHints !== true) return null;
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
