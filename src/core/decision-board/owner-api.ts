/**
 * 决策看板对本机外部客户端（`botmux owner-board`，host HMAC daemon IPC）给出的字段。
 * 这是对外契约：本机的其他工具（例如本地飞书客户端）照着这些字段名接，改名或改语义要兼容。
 *
 * 只读事项、提交一项决定；不碰草稿、附图、管家写入的字段。提交走和拍板卡片相同的一项一批路径
 *（store.submitLocal → DecisionBoardService.deliverBatch）。
 */
import { createHash } from 'node:crypto';
import { decisionAskKey } from './ask-key.js';
import {
  BOARD_STATES,
  isBoardState,
  type BatchDelivery,
  type BoardActor,
  type BoardItem,
  type BoardEventKind,
  type BoardLinkKind,
  type BoardOption,
  type BoardState,
  type BoardView,
} from './model.js';

/** 不指定状态时列出「待我拍板」：待拍板 + 待验收。 */
export const OWNER_BOARD_DEFAULT_STATES: readonly BoardState[] = ['decide', 'accept'];

/** 外部客户端能提交决定的状态（与「待我拍板」一致）。 */
export const OWNER_BOARD_DECIDABLE_STATES: readonly BoardState[] = ['decide', 'accept'];

/** 详情里带的历史条数（最新的在前）。 */
export const OWNER_BOARD_EVENT_LIMIT = 50;

export const OWNER_BOARD_REQUEST_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

export interface OwnerBoardSteward {
  enabled: boolean;
  /** 开了管家且选了管家群：提交的决定才投得出去。 */
  ready: boolean;
  chatId?: string;
}

export interface OwnerBoardLink {
  kind: BoardLinkKind;
  ref: string;
  text: string;
  url?: string;
  /** 只在 chat 关联里的实际主群上出现。 */
  primary?: true;
}

export interface OwnerBoardDecisionRef {
  batchId: number;
  choice?: string;
  text: string;
  submittedAt: number;
  delivery: BatchDelivery;
  /** 管家已经标了执行（或这条已被后来的决定作废）。 */
  handled: boolean;
}

export interface OwnerBoardItem {
  seq: number;
  key?: string;
  title: string;
  state: BoardState;
  stateLabel: string;
  stage?: string;
  kind?: string;
  repo?: string;
  summary?: string;
  question?: string;
  options: BoardOption[];
  recommend?: string;
  recommendReason?: string;
  /**
   * 这一轮拍板的指纹（问题 + 选项 + 推荐 + 状态 + 进入状态的时刻）；提交决定时原样带回，
   * 管家之后改过其中任何一项（含待拍板 / 待验收之间切换、重新进入待拍板）就拒绝（ask_changed）。
   */
  askKey: string;
  rev: number;
  /** 实际主群（指定的主群，否则第一条 chat 关联）。 */
  primaryChatId?: string;
  links: OwnerBoardLink[];
  createdAt: number;
  updatedAt: number;
  /** 进入当前状态的时刻。 */
  stateAt: number;
  /** 看板上这一项的网页链接；Dashboard 对外地址拿不到时没有。 */
  url?: string;
  /** 在飞书右侧栏打开这一项的 AppLink。 */
  appLink?: string;
  /** 已提交、管家还没标执行的决定条数。 */
  pendingDecisions: number;
  /** 进入当前状态之后提交的最近一条决定。 */
  lastDecision?: OwnerBoardDecisionRef;
}

export interface OwnerBoardEvent {
  at: number;
  actor: BoardActor;
  kind: BoardEventKind;
  text: string;
  batchId?: number;
}

export interface OwnerBoardItemDetail extends OwnerBoardItem {
  progress?: string;
  noChatReason?: string;
  events: OwnerBoardEvent[];
}

export interface OwnerBoardDecideInput {
  seq: number;
  askKey: unknown;
  choice?: unknown;
  text?: unknown;
  requestId: unknown;
}

export interface OwnerBoardDecideResult {
  duplicate: boolean;
  /**
   * handled：管家已标执行，或这条已被后来的决定作废（这时不再重投）；supersededBy：覆盖它的批次号。
   */
  decision: { seq: number; choice?: string; text: string; handled: boolean; supersededBy?: number };
  batch: { id: number; delivery: BatchDelivery; error?: string };
  /** 这次决定作废 / 覆盖了哪些较早批次里对同一项的决定。 */
  supersedes: number[];
}

/** 外部客户端看到的这一轮拍板的指纹，见 {@link OwnerBoardItem.askKey}。 */
export function ownerBoardAskKey(item: Pick<BoardItem, 'question' | 'options' | 'recommend' | 'state' | 'stateAt'>): string {
  return createHash('sha256')
    .update(JSON.stringify({ a: decisionAskKey(item), s: item.state, t: item.stateAt }))
    .digest('hex').slice(0, 12);
}

/** `decide,accept` → 状态列表；空串或缺省用默认；有不认识的状态返回 null。 */
export function parseOwnerBoardStates(raw: string | null | undefined): BoardState[] | null {
  if (raw === null || raw === undefined || !raw.trim()) return [...OWNER_BOARD_DEFAULT_STATES];
  if (raw.trim() === 'all') return [...BOARD_STATES];
  const parts = [...new Set(raw.split(',').map(s => s.trim()).filter(Boolean))];
  if (!parts.length || !parts.every(isBoardState)) return null;
  return parts;
}

/** 用哪个看板视图取数（决定排序）：全在待拍板里按进入状态的先后，全在进行中或混合时按最近更新。 */
export function ownerBoardView(states: readonly BoardState[]): BoardView {
  if (states.every(s => s === 'decide' || s === 'accept')) return 'decide';
  if (states.every(s => s === 'active' || s === 'waiting')) return 'active';
  return 'all';
}
