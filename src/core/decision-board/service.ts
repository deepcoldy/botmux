/**
 * 决策看板的 daemon 侧服务：管家 bot 的 daemon 是看板唯一的写入方。
 *
 *   - CLI（`botmux board …`，会话鉴权 IPC）→ {@link DecisionBoardService.cli}
 *   - Dashboard（host HMAC IPC）→ list / detail / 草稿 / 附图 / 提交 / 重投
 *   - 提交 = 一个事务里落库；落库后投递成管家群会话的一个回合。批次表就是发件箱：
 *     投递失败留在 failed，页面可重投，daemon 起来后自动补投。
 *
 * 存储懒打开：第一次真的用到看板时才建 `decision-board.sqlite`。
 */
import { randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Locale } from '../../i18n/types.js';
import type { Brand } from '../../im/lark/lark-hosts.js';
import type { LarkAttachment } from '../../types.js';
import { parseDashboardImageUploads } from '../dashboard-images.js';
import {
  BoardError,
  DecisionBoardStore,
  decisionBoardDbPath,
  type ItemPatch,
  type StagedFileInput,
} from '../../services/decision-board-store.js';
import { discardStagedExplainer, readStagedExplainer, stageBoardExplainer } from '../../services/decision-board-staging.js';
import { BOARD_EXPLAINERS_PER_ATTACH, normalizeBoardFileName } from './files.js';
import {
  formatHintNotice,
  formatHintPrompt,
  formatHintTurnId,
  parseCloseWhenSpec,
  parseDependsOnSpec,
  parseHintTurnId,
  parseNextCheckSpec,
  type HintNoticeEntry,
  type PrMergeState,
} from './hints.js';
import { formatChatLookupFailures, lookupProvesChatNotFound, type ChatLookupResult } from './chat-lookup.js';
import { ChatTaskReader, type ChatTaskReaderDeps } from './chat-task-reader.js';
import {
  formatTaskNotice,
  formatTaskPrompt,
  itemChatIds,
  itemTaskHint,
  stewardUpdatedAt,
  taskHintForChat,
  type ChatTaskState,
  type TaskHint,
  type TaskNoticeEntry,
} from './chat-task.js';
import {
  DECISION_CARD_ACTION_NOTE,
  DECISION_CARD_ACTION_PICK,
  DecisionCards,
  cardNoteText,
  decisionAskKey,
} from './card.js';
import {
  BOARD_STATE_LABELS,
  CHAT_REF_PATTERN,
  boardItemPath,
  cleanChatName,
  composeStewardGuide,
  effectivePrimaryChat,
  formatBatchEcho,
  formatBatchMessage,
  splitEchoText,
  formatBoardTurnId,
  isBoardState,
  isBoardView,
  itemMissingChat,
  linkText,
  linkUrl,
  parseBoardTurnId,
  parseItemRef,
  parseLinkSpec,
  parseOptionSpec,
  parseUnlinkSpec,
  sidebarAppLink,
  stewardGuidePreset,
  stewardCloseHintsOn,
  stewardReady,
  stewardTaskHintsOn,
  type BoardBatch,
  type BoardFile,
  type BoardHint,
  type BoardItem,
  type BoardLink,
  type BoardOption,
  type BoardUnlink,
  type BoardView,
  type StewardConfig,
} from './model.js';

export interface DecisionBoardServiceDeps {
  dataDir: string;
  larkAppId(): string;
  steward(): StewardConfig | undefined;
  locale(): Locale;
  brand(): Brand;
  /** Dashboard 对外 origin（不含尾斜杠）；拿不到时链接不渲染。 */
  dashboardOrigin(): string | undefined;
  ownerOpenId(): string | undefined;
  ownerName(): Promise<string | undefined>;
  timeZone(): string | undefined;
  /** 批次附图拷到这里再随回合送出（沙箱会话能读的 attachments/<app>/ 下）。 */
  batchAttachmentsDir(batchId: number): string;
  banner(input: { batchId: number; count: number; locale: Locale }): string;
  deliver(input: {
    turnId: string;
    prompt: string;
    /** 管家群里的回显：逐项内容的文本（已按单条上限拆好）与附图，按顺序发。 */
    announcement: { texts: string[]; images: LarkAttachment[] };
    attachments: LarkAttachment[];
    ownerOpenId?: string;
    ownerName?: string;
    chatId: string;
    sessionTitle: string;
  }): Promise<{ sessionId: string }>;
  log(level: 'info' | 'warn', message: string): void;
  /**
   * 核实一个群：先用管家 bot 的凭据查，查不到再依次试本机其他 bot（见 chat-lookup.ts）。
   * 只在写 chat 关联时调用；凭据只留在 daemon 进程内。`deadline` 是这条命令共用的截止时间。
   */
  lookupChat(chatId: string, opts: { deadline: number }): Promise<ChatLookupResult>;
  /**
   * 管家群里的拍板卡片（见 card.ts）。不接线时不发卡，其余行为不变。
   */
  cards?: {
    /** uuid：飞书发送去重键（补发同一张卡时不变，上次其实已发出时不会出第二张）。 */
    sendCard(chatId: string, cardJson: string, uuid: string): Promise<string>;
    updateCard(messageId: string, cardJson: string): Promise<void>;
    isCardGone(error: unknown): boolean;
  };
  /**
   * 后台巡检查 PR 合没合（`owner/repo#12`）。查不到（网络、频控、没权限、不是 GitHub 上的仓库）返回
   * undefined，巡检这轮不据此下结论。缓存与限流由实现负责（见 github-pr-state.ts）。
   */
  prState?(ref: string): Promise<PrMergeState | undefined>;
  /**
   * 读关联群里的会话（本机所有 bot），算群状态与子任务提醒。不接线时看板不带群状态、不提醒。
   */
  chatTasks?: ChatTaskReaderDeps;
}

/** 卡片按钮回调交给 {@link DecisionBoardService.cardClick} 的内容（身份取自飞书事件，不取 value）。 */
export interface BoardCardClick {
  operatorOpenId?: string;
  operatorUnionId?: string;
  value: Record<string, unknown>;
  formValue?: unknown;
  messageId?: string;
}

/** 卡片回调的结果：toast 和 / 或换上的卡片；deliver 在回调应答之后执行（投递可能要几秒）。 */
export interface BoardCardClickResult {
  toast?: { type: 'success' | 'info' | 'warning' | 'error'; content: string };
  card?: Record<string, unknown>;
  deliver?: () => Promise<void>;
}

const CARD_TOASTS = {
  zh: {
    unavailable: '这张卡片已失效，去看板上处理',
    disabled: '这个管家没开「飞书卡片拍板」，去看板上处理',
    noPermission: '只有看板 owner 能在卡片上拍板',
    gone: '这一项已经不在看板上了',
    notDeciding: '这一项已经不在待拍板了，卡片已刷新',
    stale: '选项刚改过，卡片已刷新，请按最新选项再点',
    noteRequired: '先在说明框里写点什么',
    replaced: '这张卡片已过期，请用管家群里这一项最新的卡片，或去看板上处理',
    duplicate: '这个决定已经交给管家了',
    accepted: (label: string) => `已选 ${label}，正在交给管家`,
    acceptedNote: '已提交说明，正在交给管家',
  },
  en: {
    unavailable: 'This card has expired; use the board instead',
    disabled: 'Decision cards are off for this steward; use the board instead',
    noPermission: 'Only the board owner can decide on this card',
    gone: 'This item is no longer on the board',
    notDeciding: 'This item no longer awaits a decision; card refreshed',
    stale: 'The options just changed; card refreshed, please pick again',
    noteRequired: 'Write something in the note box first',
    replaced: 'This card is outdated; use the latest card for this item in the steward chat, or the board',
    duplicate: 'This decision was already sent to the steward',
    accepted: (label: string) => `Picked ${label}; sending to the steward`,
    acceptedNote: 'Note submitted; sending to the steward',
  },
} as const;

/** CLI 发来的请求体：选项和关联都传原始 spec 字符串，由这里统一解析。 */
export interface BoardCliRequest {
  action?: unknown;
  ref?: unknown;
  view?: unknown;
  title?: unknown;
  fields?: unknown;
  options?: unknown;
  links?: unknown;
  unlinks?: unknown;
  clearAsk?: unknown;
  text?: unknown;
  handled?: unknown;
  files?: unknown;
  /** attach：先经上传接口写进暂存区的说明页 / 视频（id 列表）。 */
  staged?: unknown;
  note?: unknown;
  /** `--primary-chat oc_…` */
  primaryChat?: unknown;
  /** `--no-chat "<原因>"` */
  noChat?: unknown;
  /** `--allow-unverified-chat`：查不到的群也写，标「未核实」。 */
  allowUnverifiedChat?: unknown;
  /** `--close-when "pr:owner/repo#12 merged" | "item:66 done" | manual | auto` */
  closeWhen?: unknown;
  /** `--depends-on 66,70 | none` */
  dependsOn?: unknown;
  /** `--next-check +2d | 2026-11-10T09:30+08:00 | none` */
  nextCheck?: unknown;
  /** `--dismiss-hint`：收起当前提示。 */
  dismissHint?: unknown;
}

/** 建项缺群时的报错：写清楚三种写法（管家照着改命令即可）。 */
export const ADD_CHAT_REQUIRED_MESSAGE = 'board add 要关联这件事所在的飞书群：--link chat=oc_…'
  + '（可带标签 --link "chat=oc_…|评审群"，不带标签就用查到的群名）。'
  + '挂多个群时第一个是主群，或用 --primary-chat oc_… 指定。'
  + '确实没有群（只有 issue、还没开工、管家自己处理）：--no-chat "<原因>"，看板上显示「无群：<原因>」。';

/**
 * 一次请求里同时核实几个群。每个群的查群本身是「管家 1 + 其他 bot 每批 6」的并发，再按群数放大会
 * 对同一个 app 突发几十个请求、自己撞上飞书频控；限成 2，对任一 app 的瞬时并发不超过 2。常见的一项
 * 一到三个群，多等的时间可以忽略。
 */
const CHAT_VERIFY_CONCURRENCY = 2;

/**
 * 一条命令核实群的总时长，几个群共用这一份（不是每个群各 20 秒）：CLI 在等结果，挂再多群也不能等上几分钟。
 * 预算用完时还没轮到的群按超时处理（已核实的群保持原状，新群要 --allow-unverified-chat）。
 */
const CHAT_VERIFY_BUDGET_MS = 20_000;

const PATCH_TEXT_FIELDS = ['key', 'stage', 'kind', 'repo', 'summary', 'progress', 'question', 'recommend', 'recommendReason', 'note', 'title'] as const;

/**
 * 一轮巡检里最多问这么多个 PR（多数命中查询模块的缓存，不发请求）。超出时按轮转着查：每轮从上一轮停下的
 * 位置接着往后，几轮就覆盖全部；没轮到的 PR 用上次查到的状态。
 */
const HINT_PR_LOOKUPS_PER_ROUND = 40;

/**
 * 同一条提示的通知最多自动投这么多次（投递抛错时重试）。deliver() 可能已经在群里发出横幅才失败，
 * 无上限重试会每 5 分钟往管家群刷一条；超过就不再自动发，提示仍留在看板上。
 */
const HINT_NOTICE_MAX_ATTEMPTS = 3;

/**
 * 子任务提醒的防抖：收到第一个事件后等这么久再统一核对，期间的事件合成一条。一轮刚结束时常常紧跟着
 * 群里的新消息又开一轮，等一下也能让「又开始跑了」的群不提醒。
 */
export const TASK_ALERT_DEBOUNCE_MS = 2 * 60_000;

type NoticeChannel = 'hint' | 'task';

/** Dashboard 上一项的子任务视图：各关联群的状态、是否有管家还没处理的新结果、提示。 */
export interface ItemTaskView {
  taskChats?: ChatTaskState[];
  taskFresh?: boolean;
  taskHint?: TaskHint;
}

export class DecisionBoardService {
  private storeRef?: DecisionBoardStore;
  private readonly delivering = new Map<number, Promise<BoardBatch>>();
  readonly cards?: DecisionCards;
  /** 批次按编号顺序逐个投递：较早的一批先进管家会话，覆盖标记在投递那一刻读，先后才对得上。 */
  private deliveryChain: Promise<unknown> = Promise.resolve();
  private sweeping = false;
  /** 正在投的提示通知（与 sweeping 分开：投递卡住时巡检照常给看板标提示，只是这期间不再发新通知）。 */
  private noticeInFlight = false;
  /** 已送进 worker、还没确认的提示回合 → 这一轮通知的 key。送达失败回执到了按它撤销「已通知」。 */
  private readonly hintRounds = new Map<string, { channel: NoticeChannel; keys: Array<{ seq: number; key: string }>; chats: string[] }>();
  /** `<seq>:<key>` → 已经自动投过几次（只在内存里：重启后从头算，最多再多发几次）。 */
  private readonly hintAttempts = new Map<string, number>();
  /** 上次查到的 PR 状态：这一轮没轮到、或这轮查不到的 PR 用它。 */
  private readonly prKnown = new Map<string, PrMergeState>();
  private prCursor = 0;
  private readonly chatTaskReader?: ChatTaskReader;
  /** 等防抖结束后核对的群。 */
  private readonly taskPending = new Set<string>();
  private taskTimer?: ReturnType<typeof setTimeout>;
  private taskFlushing = false;

  constructor(private readonly deps: DecisionBoardServiceDeps) {
    if (deps.chatTasks) this.chatTaskReader = new ChatTaskReader(deps.chatTasks);
    const sink = deps.cards;
    if (sink) {
      this.cards = new DecisionCards({
        store: () => this.store(),
        appId: () => this.appId,
        locale: () => this.deps.locale(),
        steward: () => this.deps.steward(),
        links: seq => this.itemLinks(seq),
        hasOwner: () => !!this.deps.ownerOpenId(),
        sendCard: (chatId, card, uuid) => sink.sendCard(chatId, card, uuid),
        updateCard: (messageId, card) => sink.updateCard(messageId, card),
        isCardGone: error => sink.isCardGone(error),
        log: (level, message) => this.deps.log(level, message),
      });
    }
  }

  /** 卡片同步不挡看板写入：失败只记日志（DecisionCards 内部已兜住）。 */
  private syncCard(seq: number, create = false): void {
    if (!this.cards) return;
    void this.cards.sync(seq, { create });
  }

  /** 等卡片同步跑完（测试用）。 */
  async cardsIdle(): Promise<void> {
    await this.cards?.idle();
  }

  /** daemon 起来后对一遍卡片：补发上次没发出去的、刷新内容过期的（含批次在重启前后变了状态）。 */
  async reconcileCards(): Promise<void> {
    if (!this.cards || !this.isSteward()) return;
    await this.cards.reconcile();
  }

  private get appId(): string { return this.deps.larkAppId(); }

  store(): DecisionBoardStore {
    if (!this.storeRef) {
      try {
        this.storeRef = DecisionBoardStore.open(this.deps.dataDir);
      } catch (error) {
        throw new BoardError('storage_unavailable', `看板存储打不开：${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return this.storeRef;
  }

  close(): void {
    if (this.taskTimer) clearTimeout(this.taskTimer);
    this.taskTimer = undefined;
    this.taskPending.clear();
    this.cards?.stop();
    this.storeRef?.close();
    this.storeRef = undefined;
  }

  isSteward(): boolean {
    return this.deps.steward()?.enabled === true;
  }

  requireSteward(): void {
    if (!this.isSteward()) throw new BoardError('not_steward', '本 Bot 未开启管家（Dashboard → Bot 配置 → 管家）');
  }

  itemLinks(seq: number): { url?: string; appLink?: string } {
    const origin = this.deps.dashboardOrigin();
    if (!origin) return {};
    const url = `${origin}${boardItemPath(this.appId, seq)}`;
    return { url, appLink: sidebarAppLink(url, this.deps.brand()) };
  }

  /** 关联 → 带展示文字和链接；chat 关联里的主群标 `primary: true`（主群按 effectivePrimaryChat 推导）。 */
  renderLinks(links: BoardLink[], primaryChat?: string): Array<BoardLink & { url?: string; text: string; primary?: true }> {
    const ctx = { brand: this.deps.brand(), dashboardBase: this.deps.dashboardOrigin() };
    const locale = this.deps.locale();
    const primary = effectivePrimaryChat(links, primaryChat);
    return links.map(l => {
      const url = linkUrl(l, ctx);
      return { ...l, text: linkText(l, locale), ...(url ? { url } : {}), ...(l === primary ? { primary: true as const } : {}) };
    });
  }

  /**
   * 原始的无群原因只在没有群时有意义：已经有群时不把库里残留的值带出去（CLI 和 Dashboard 同一口径）。
   */
  private withoutStaleReason<T extends Pick<BoardItem, 'noChatReason'>>(item: T, links: readonly BoardLink[]): T {
    if (!item.noChatReason || !links.some(l => l.kind === 'chat')) return item;
    const { noChatReason: _stale, ...rest } = item;
    return rest as T;
  }

  /** 一项的群状态：实际主群（展示文字 + 链接）、群的个数、无群原因、是否缺群。list / show / 批次共用。 */
  chatState(item: Pick<BoardItem, 'primaryChat' | 'noChatReason'>, links: BoardLink[]) {
    const primary = effectivePrimaryChat(links, item.primaryChat);
    const rendered = primary ? this.renderLinks([primary], primary.ref)[0] : undefined;
    return {
      // 叫 mainChat 而不是 primaryChat：事项本身的 primaryChat 是存下来的指定（可能为空或已失效），
      // 这里是按规则推导出的实际主群，两者并存时不互相覆盖。
      ...(rendered ? { mainChat: { ref: rendered.ref, text: rendered.text, ...(rendered.url ? { url: rendered.url } : {}),
        ...(rendered.chatCheck ? { chatCheck: rendered.chatCheck } : {}) } } : {}),
      chatCount: links.filter(l => l.kind === 'chat').length,
      ...(item.noChatReason && !primary ? { noChatReason: item.noChatReason } : {}),
      missingChat: itemMissingChat(item, links),
    };
  }

  guide(): { effective: string; preset: string } {
    const locale = this.deps.locale();
    const steward = this.deps.steward();
    return { effective: composeStewardGuide(steward, locale), preset: stewardGuidePreset(locale, steward) };
  }

  // ─── CLI ─────────────────────────────────────────────────────────────────

  private parsePatch(req: BoardCliRequest): ItemPatch {
    const patch: ItemPatch = {};
    const fields = (req.fields && typeof req.fields === 'object' && !Array.isArray(req.fields) ? req.fields : {}) as Record<string, unknown>;
    for (const name of PATCH_TEXT_FIELDS) {
      const v = fields[name];
      if (v === undefined) continue;
      if (typeof v !== 'string') throw new BoardError('invalid_field', `${name} 必须是字符串`);
      (patch as Record<string, unknown>)[name] = v;
    }
    if (fields.state !== undefined) {
      if (!isBoardState(fields.state)) throw new BoardError('invalid_state', `状态只能是 decide / accept / active / waiting / done / closed`);
      patch.state = fields.state;
    }
    if (req.options !== undefined) {
      if (!Array.isArray(req.options)) throw new BoardError('invalid_options');
      const options: BoardOption[] = [];
      for (const spec of req.options) {
        if (typeof spec !== 'string') throw new BoardError('invalid_options');
        const parsed = parseOptionSpec(spec);
        if ('error' in parsed) throw new BoardError('invalid_option', parsed.error);
        options.push(parsed);
      }
      if (options.length) patch.options = options;
    }
    if (req.links !== undefined) {
      if (!Array.isArray(req.links)) throw new BoardError('invalid_links');
      const links: BoardLink[] = [];
      for (const spec of req.links) {
        if (typeof spec !== 'string') throw new BoardError('invalid_links');
        const parsed = parseLinkSpec(spec);
        if ('error' in parsed) throw new BoardError('invalid_link', parsed.error);
        links.push(parsed);
      }
      if (links.length) patch.links = links;
    }
    if (req.unlinks !== undefined) {
      if (!Array.isArray(req.unlinks)) throw new BoardError('invalid_links');
      const unlinks: BoardUnlink[] = [];
      for (const spec of req.unlinks) {
        if (typeof spec !== 'string') throw new BoardError('invalid_links');
        const parsed = parseUnlinkSpec(spec);
        if ('error' in parsed) throw new BoardError('invalid_link', parsed.error);
        unlinks.push(parsed);
      }
      if (unlinks.length) patch.unlinks = unlinks;
    }
    if (req.primaryChat !== undefined) {
      if (typeof req.primaryChat !== 'string' || !CHAT_REF_PATTERN.test(req.primaryChat.trim())) {
        throw new BoardError('invalid_primary_chat', '--primary-chat 要写 oc_ 开头的群 ID');
      }
      patch.primaryChat = req.primaryChat.trim();
    }
    if (req.noChat !== undefined) {
      if (typeof req.noChat !== 'string' || !req.noChat.trim()) throw new BoardError('no_chat_reason_required', '--no-chat 要写明为什么没有群');
      patch.noChatReason = req.noChat.trim();
      // 不联网就能判的冲突在查群之前拒，免得先等一轮查群、再报一个误导人的「查不到群」。
      if (patch.links?.some(l => l.kind === 'chat')) {
        throw new BoardError('no_chat_conflict', '同时给了群（--link chat=）和无群原因（--no-chat），只能二选一');
      }
    }
    if (req.closeWhen !== undefined) {
      if (typeof req.closeWhen !== 'string') throw new BoardError('invalid_close_when', '--close-when 必须是字符串');
      const parsed = parseCloseWhenSpec(req.closeWhen);
      if (typeof parsed === 'object' && 'error' in parsed) throw new BoardError('invalid_close_when', parsed.error);
      patch.closeWhen = parsed === 'auto' ? null : parsed;
    }
    if (req.dependsOn !== undefined) {
      if (typeof req.dependsOn !== 'string') throw new BoardError('invalid_depends_on', '--depends-on 必须是字符串');
      const parsed = parseDependsOnSpec(req.dependsOn);
      if (!Array.isArray(parsed)) throw new BoardError('invalid_depends_on', parsed.error);
      patch.dependsOn = parsed;
    }
    if (req.nextCheck !== undefined) {
      if (typeof req.nextCheck !== 'string') throw new BoardError('invalid_next_check', '--next-check 必须是字符串');
      const parsed = parseNextCheckSpec(req.nextCheck, Date.now());
      if (parsed !== null && typeof parsed === 'object') throw new BoardError('invalid_next_check', parsed.error);
      patch.nextCheckAt = parsed;
    }
    if (req.dismissHint === true) patch.dismissHint = true;
    if (req.clearAsk === true) {
      patch.question = null;
      patch.options = [];
      patch.recommend = null;
      patch.recommendReason = null;
    }
    if (patch.recommend && patch.options && !patch.options.some(o => o.key === patch.recommend!.toUpperCase())) {
      throw new BoardError('unknown_recommend', `推荐项 ${patch.recommend} 不在选项里`);
    }
    if (patch.recommend) patch.recommend = patch.recommend.toUpperCase();
    return patch;
  }

  /**
   * 主群必须是这一项写完之后的群之一。查群前按「已有的群 − 本次删的 + 本次加的」先判一次，
   * 指错了不必先等查群；最终仍以 store 在事务里按写完的关联核对为准。
   */
  private precheckPrimaryChat(patch: ItemPatch, existing: readonly BoardLink[]): void {
    if (patch.primaryChat === undefined) return;
    const refs = new Set(existing.filter(l => l.kind === 'chat').map(l => l.ref));
    for (const u of patch.unlinks ?? []) {
      if (u.kind !== 'chat') continue;
      refs.delete(u.raw);
      if (u.ref) refs.delete(u.ref);
    }
    for (const l of patch.links ?? []) if (l.kind === 'chat') refs.add(l.ref);
    if (!refs.has(patch.primaryChat)) {
      throw new BoardError('primary_chat_not_linked', `主群 ${patch.primaryChat} 不在这一项的群关联里，先 --link chat=${patch.primaryChat}`);
    }
  }

  /**
   * 写 chat 关联前逐个核实：查到了记 verified 和群名（群名单独存，不顶替管家的标签）；查不到时整次
   * 写入拒绝，除非显式 --allow-unverified-chat（记 unverified）。同一个群在一次请求里只查一次，几个群
   * 之间限并发（{@link CHAT_VERIFY_CONCURRENCY}），共用一份总时长（{@link CHAT_VERIFY_BUDGET_MS}）。
   *
   * 已核实过的群，只有拿到「群确实不存在」的证据（{@link lookupProvesChatNotFound}）才按查不到处理
   *（带 --allow-unverified-chat 降成 unverified，不带就拒绝）。其余情况——bot 不在群（232011 / 230002）、
   * 频控等暂态码、超时、网络错误，单独或混合——都只是「这次没核实成」，保持原状、照常放行这次写入：
   * 不降级就不需要「允许未核实」的授权，同一条命令里的其他字段更新也不会被连带丢掉。
   * 没核实过的新群行为不变：查不到就要 --allow-unverified-chat。
   */
  private async verifyChatLinks(patch: ItemPatch, allowUnverified: boolean, existing: readonly BoardLink[]): Promise<void> {
    const chats = patch.links?.filter(l => l.kind === 'chat') ?? [];
    if (!chats.length) return;
    const refs = [...new Set(chats.map(l => l.ref))];
    const results = new Map<string, ChatLookupResult>();
    const queue = [...refs];
    const deadline = Date.now() + CHAT_VERIFY_BUDGET_MS;
    await Promise.all(Array.from({ length: Math.min(CHAT_VERIFY_CONCURRENCY, refs.length) }, async () => {
      for (let ref = queue.shift(); ref !== undefined; ref = queue.shift()) {
        let result: ChatLookupResult;
        try {
          result = await this.deps.lookupChat(ref, { deadline });
        } catch (error) {
          result = { ok: false, chatId: ref, timedOut: false,
            failures: [{ appId: this.appId, reason: error instanceof Error ? error.message.split('\n')[0]!.slice(0, 200) : String(error) }] };
        }
        results.set(ref, result);
      }
    }));
    const failed = new Set<Extract<ChatLookupResult, { ok: false }>>();
    patch.links = patch.links!.map(link => {
      if (link.kind !== 'chat') return link;
      const result = results.get(link.ref)!;
      if (result.ok) {
        const name = result.name ? cleanChatName(result.name) : '';
        return { ...link, ...(name ? { chatName: name } : {}), chatCheck: 'verified' as const };
      }
      const wasVerified = existing.some(l => l.kind === 'chat' && l.ref === link.ref && l.chatCheck === 'verified');
      if (wasVerified && !lookupProvesChatNotFound(result)) return link;
      if (allowUnverified) return { ...link, chatCheck: 'unverified' as const };
      failed.add(result);
      return link;
    });
    if (failed.size) throw new BoardError('chat_unverified', formatChatLookupFailures([...failed], this.appId));
  }

  private resolveRef(raw: unknown): number {
    const ref = parseItemRef(raw);
    if (!ref) throw new BoardError('invalid_ref', '要给出事项编号（如 12 或 #12）或 key');
    const seq = this.store().resolveSeq(this.appId, ref);
    if (seq === undefined) throw new BoardError('item_not_found', `没有找到 ${String(raw)}`);
    return seq;
  }

  /**
   * 提示只在开着「自动发现可以关的项」时给出：关掉后巡检不再刷新，库里留下的提示会过时，不往外带。
   */
  private withVisibleHint<T extends Pick<BoardItem, 'hint'>>(item: T): T {
    if (!item.hint || stewardCloseHintsOn(this.deps.steward())) return item;
    const { hint: _hidden, ...rest } = item;
    return rest as T;
  }

  private itemOut(seq: number) {
    const item = this.withVisibleHint(this.store().getItem(this.appId, seq)!);
    const rest = this.withoutStaleReason(item, this.store().links(this.appId, seq));
    return { ...rest, stateLabel: BOARD_STATE_LABELS[this.deps.locale()][item.state], ...this.itemLinks(seq),
      ...this.chatState(item, this.store().links(this.appId, seq)) };
  }

  async cli(req: BoardCliRequest, ctx: { sessionId: string }): Promise<Record<string, unknown>> {
    const action = typeof req.action === 'string' ? req.action : '';
    if (action === 'guide') {
      this.requireSteward();
      return { guide: this.guide().effective };
    }
    this.requireSteward();
    const store = this.store();
    const app = this.appId;
    switch (action) {
      case 'list': {
        const view: BoardView = isBoardView(req.view) ? req.view : 'all';
        const items = store.listItems(app, view).map(i => ({
          seq: i.seq, title: i.title, state: i.state, stateLabel: BOARD_STATE_LABELS[this.deps.locale()][i.state],
          ...(i.stage ? { stage: i.stage } : {}), ...(i.key ? { key: i.key } : {}), ...(i.repo ? { repo: i.repo } : {}),
          pendingDecisions: i.pendingDecisions, updatedAt: i.updatedAt, ...this.itemLinks(i.seq),
          ...this.chatState(i, i.links),
          ...(this.withVisibleHint(i).hint ? { hint: i.hint } : {}),
        }));
        return { view, counts: store.counts(app), missingChat: items.filter(i => i.missingChat).length, items };
      }
      case 'show': {
        const seq = this.resolveRef(req.ref);
        const detail = store.detail(app, seq)!;
        return {
          item: this.itemOut(seq),
          links: this.renderLinks(detail.links, detail.item.primaryChat),
          events: detail.events.slice(0, 30).map(e => ({ at: e.at, actor: e.actor, kind: e.kind, text: e.text,
            ...(e.batchId ? { batchId: e.batchId } : {}), ...(e.fileIds.length ? { files: e.fileIds.length } : {}) })),
          pendingDecisions: detail.pendingDecisions,
        };
      }
      case 'add': {
        const patch = this.parsePatch(req);
        if (patch.unlinks) throw new BoardError('invalid_link', 'add 不删关联，改用 set <编号> --unlink');
        const title = typeof req.title === 'string' ? req.title : patch.title;
        if (!title?.trim()) throw new BoardError('title_required', '缺少标题');
        // 只在真正新建时强制带群：带已有 key 的 add 等于 set，存量事项不强制。
        const existingSeq = patch.key ? store.resolveSeq(app, { key: patch.key }) : undefined;
        if (existingSeq === undefined && !patch.links?.some(l => l.kind === 'chat') && patch.noChatReason === undefined) {
          throw new BoardError('chat_required', ADD_CHAT_REQUIRED_MESSAGE);
        }
        const existing = existingSeq !== undefined ? store.links(app, existingSeq) : [];
        this.precheckPrimaryChat(patch, existing);
        await this.verifyChatLinks(patch, req.allowUnverifiedChat === true, existing);
        // 查群可能要等十几秒：期间管家被关掉了就不再写。
        this.requireSteward();
        const before = existingSeq !== undefined ? store.getItem(app, existingSeq) : undefined;
        const { item, created } = store.addItem(app, { ...patch, title }, ctx.sessionId, undefined, this.deps.locale());
        this.syncCard(item.seq, askChanged(before, item));
        return { created, item: this.itemOut(item.seq) };
      }
      case 'set': {
        const seq = this.resolveRef(req.ref);
        const patch = this.parsePatch(req);
        const existing = store.links(app, seq);
        this.precheckPrimaryChat(patch, existing);
        await this.verifyChatLinks(patch, req.allowUnverifiedChat === true, existing);
        this.requireSteward();
        if (patch.recommend && !patch.options) {
          const item = store.getItem(app, seq)!;
          if (!item.options.some(o => o.key === patch.recommend)) throw new BoardError('unknown_recommend', `推荐项 ${patch.recommend} 不在选项里`);
        }
        const before = store.getItem(app, seq);
        const after = store.updateItem(app, seq, patch, ctx.sessionId, undefined, this.deps.locale());
        this.syncCard(seq, askChanged(before, after));
        return { item: this.itemOut(seq) };
      }
      case 'history': {
        const seq = this.resolveRef(req.ref);
        if (typeof req.text !== 'string') throw new BoardError('text_required', '历史内容不能为空');
        const res = store.appendHistory(app, seq, req.text, { handled: req.handled === true, actorRef: ctx.sessionId });
        if (res.handled) this.syncCard(seq);
        return { seq, eventId: res.eventId, handledDecisions: res.handled, ...this.itemLinks(seq) };
      }
      case 'attach': {
        if (req.staged !== undefined) return this.attachWithExplainers(req, ctx);
        const seq = this.resolveRef(req.ref);
        const parsed = parseDashboardImageUploads(req.files);
        if (!parsed.ok) throw new BoardError('invalid_files', `截图不合规：${parsed.error}`);
        if (!parsed.images.length) throw new BoardError('files_required', '至少附一张图');
        const saved = store.attachFiles(app, seq, parsed.images.map(img => ({
          bytes: Buffer.from(img.dataBase64, 'base64'), mime: img.mimeType, name: img.name,
        })), typeof req.note === 'string' ? req.note : undefined, ctx.sessionId);
        return { seq, files: saved.map(f => ({ id: f.id, name: f.name, bytes: f.bytes })), ...this.itemLinks(seq) };
      }
      case 'pending': {
        const decisions = store.pendingDecisions(app).map(d => {
          const item = store.getItem(app, d.seq);
          const option = item?.options.find(o => o.key === d.choice);
          return { batchId: d.batchId, seq: d.seq, title: item?.title ?? '', ...(d.choice ? { choice: d.choice } : {}),
            ...(option ? { choiceLabel: option.label } : {}), text: d.text, images: d.fileIds.length,
            itemChangedSinceDecision: !!item && item.rev !== d.itemRev };
        });
        return { decisions };
      }
      default:
        throw new BoardError('unknown_action', `不认识的子命令：${action || '(空)'}`);
    }
  }

  /**
   * `botmux board attach` 带了说明页 / 视频：它们已经由 stageExplainer 写进暂存区，这里和同一条命令里的
   * 截图一起挂到事项上，只记一条历史。暂存必须是同一事项、同一会话上传的；读到的暂存不管
   * attach 成败都丢掉。
   */
  private attachWithExplainers(req: BoardCliRequest, ctx: { sessionId: string }) {
    const seq = this.resolveRef(req.ref);
    const ids = Array.isArray(req.staged) ? [...new Set(req.staged)] : null;
    if (!ids || ids.length === 0) throw new BoardError('files_required', '至少附一个文件');
    if (ids.length > BOARD_EXPLAINERS_PER_ATTACH) {
      throw new BoardError('too_many_files', `一次最多附 ${BOARD_EXPLAINERS_PER_ATTACH} 个说明页 / 视频`);
    }
    const staged: Array<StagedFileInput & { id: string }> = [];
    let saved: BoardFile[];
    try {
      for (const id of ids) staged.push(readStagedExplainer(this.deps.dataDir, this.appId, id, { seq, sessionId: ctx.sessionId }));
      const parsed = parseDashboardImageUploads(req.files);
      if (!parsed.ok) throw new BoardError('invalid_files', `截图不合规：${parsed.error}`);
      saved = this.store().attachExplainers(this.appId, seq, {
        staged,
        images: parsed.images.map(img => ({ bytes: Buffer.from(img.dataBase64, 'base64'), mime: img.mimeType, name: img.name })),
      }, typeof req.note === 'string' ? req.note : undefined, ctx.sessionId);
    } finally {
      for (const s of staged) discardStagedExplainer(this.deps.dataDir, this.appId, s.id);
    }
    this.syncCard(seq);
    return { seq, files: saved.map(f => ({ id: f.id, name: f.name, bytes: f.bytes, mime: f.mime })), ...this.itemLinks(seq) };
  }

  /**
   * 上传一个说明页 / 视频到暂存区（正文是文件原始字节，流式写盘）。返回的 id 由同一会话的 attach 引用。
   * 先确认管家开着、事项存在，再读正文。
   */
  async stageExplainer(input: { ref: unknown; name: string; mime: string; body: AsyncIterable<Uint8Array | string> }, ctx: { sessionId: string }) {
    this.requireSteward();
    const seq = this.resolveRef(input.ref);
    const name = normalizeBoardFileName(input.name, input.mime, 'explainer');
    const { staged, warnings } = await stageBoardExplainer(this.deps.dataDir, this.appId, {
      seq, sessionId: ctx.sessionId, name, mime: input.mime, body: input.body,
    });
    return { id: staged.id, seq, name: staged.name, mime: staged.mime, bytes: staged.bytes, warnings };
  }

  // ─── Dashboard ───────────────────────────────────────────────────────────

  meta() {
    const steward = this.deps.steward();
    return {
      steward: { enabled: steward?.enabled === true, ready: stewardReady(steward), ...(steward?.chatId ? { chatId: steward.chatId } : {}) },
      // 没开过看板（库从未打开）时计数给零，不为一次侧栏探测建 decision-board.sqlite；
      // 真正打开看板（list/detail/写草稿/提交）才懒建库。
      counts: this.storeRef ? this.store().counts(this.appId) : { decide: 0, active: 0, all: 0 },
    };
  }

  list(view: BoardView, author: string, query?: string) {
    const store = this.store();
    return {
      ...this.meta(),
      items: store.listItems(this.appId, view, { author, query }).map(i => ({
        ...this.withVisibleHint(this.withoutStaleReason(i, i.links)), links: this.renderLinks(i.links, i.primaryChat), ...this.itemLinks(i.seq),
        missingChat: itemMissingChat(i, i.links),
      })),
      drafts: store.listDrafts(this.appId, author).map(d => ({ seq: d.seq, updatedAt: d.updatedAt })),
      batches: store.listBatches(this.appId, 10),
    };
  }

  detail(seq: number, author: string) {
    const store = this.store();
    const detail = store.detail(this.appId, seq, author);
    if (!detail) throw new BoardError('item_not_found', `没有 #${seq}`);
    return {
      ...detail,
      item: this.withVisibleHint(this.withoutStaleReason(detail.item, detail.links)),
      links: this.renderLinks(detail.links, detail.item.primaryChat),
      missingChat: itemMissingChat(detail.item, detail.links),
      ...this.itemLinks(seq),
      steward: this.meta().steward,
      drafts: store.listDrafts(this.appId, author).map(d => ({ seq: d.seq, updatedAt: d.updatedAt })),
    };
  }

  /** 各项关联群的状态（排除管家群）。读不到会话 inventory 时各群都是「读不到」。 */
  private async chatStatesFor(lists: ReadonlyArray<readonly string[]>, fresh = false): Promise<Map<string, ChatTaskState>> {
    if (!this.chatTaskReader) return new Map();
    return this.chatTaskReader.read(lists.flat(), { fresh });
  }

  private taskView(item: Pick<BoardItem, 'primaryChat' | 'state' | 'updatedAt' | 'stewardEventAt' | 'createdAt'>, links: readonly BoardLink[],
    states: Map<string, ChatTaskState>): ItemTaskView {
    if (!this.chatTaskReader) return {};
    const chats = itemChatIds(item, links, this.deps.steward()?.chatId).map(id => states.get(id) ?? { chatId: id, kind: 'unreadable' as const });
    if (chats.length === 0) return {};
    const hint = itemTaskHint(item, chats);
    return {
      taskChats: chats,
      taskFresh: !!hint,
      ...(hint && stewardTaskHintsOn(this.deps.steward()) ? { taskHint: hint } : {}),
    };
  }

  /** Dashboard 列表：{@link list} + 各项关联群的状态；「进行中」视图里群里有新结果的排在前面。 */
  async listView(view: BoardView, author: string, query?: string) {
    const base = this.list(view, author, query);
    const stewardChat = this.deps.steward()?.chatId;
    const states = await this.chatStatesFor(base.items.map(i => itemChatIds(i, i.links, stewardChat)));
    const items = base.items.map(i => ({ ...i, ...this.taskView(i, i.links, states) }));
    if (view === 'active') {
      const order = new Map(items.map((i, n) => [i.seq, n]));
      items.sort((a, b) => Number(!!b.taskFresh) - Number(!!a.taskFresh) || order.get(a.seq)! - order.get(b.seq)!);
    }
    return { ...base, items };
  }

  /** Dashboard 详情：{@link detail} + 每个关联群的状态。 */
  async detailView(seq: number, author: string) {
    const base = this.detail(seq, author);
    const stewardChat = this.deps.steward()?.chatId;
    const states = await this.chatStatesFor([itemChatIds(base.item, base.links, stewardChat)]);
    return { ...base, ...this.taskView(base.item, base.links, states) };
  }

  /**
   * 任一 daemon 记下本轮结果或举手时按群转到这里。只记下群、排一次防抖核对，不信任事件内容。
   */
  noteTaskEvent(chatId: string): void {
    const steward = this.deps.steward();
    if (!this.chatTaskReader || !stewardTaskHintsOn(steward) || chatId === steward.chatId) return;
    if (!this.storeRef && !existsSync(decisionBoardDbPath(this.deps.dataDir))) return;
    this.taskPending.add(chatId);
    this.scheduleTaskFlush();
  }

  private scheduleTaskFlush(): void {
    if (this.taskTimer || this.taskPending.size === 0) return;
    this.taskTimer = setTimeout(() => {
      this.taskTimer = undefined;
      void this.flushTaskAlerts().catch(err => this.deps.log('warn', `[decision-board] task alert failed: ${err instanceof Error ? err.message : String(err)}`));
    }, TASK_ALERT_DEBOUNCE_MS);
    this.taskTimer.unref?.();
  }

  /**
   * 防抖到点：重新读这些群的状态，对关联了它们、没结束的事项算提醒：只有已交付 / 等人处理 / 中断，
   * 且晚于管家最后一次更新这一项、这个结果还没提醒过。全部合成一条发给管家会话。
   * 返回这轮提醒了几条。
   */
  async flushTaskAlerts(): Promise<number> {
    if (this.taskFlushing) {
      this.scheduleTaskFlush();
      return 0;
    }
    const chats = [...this.taskPending];
    this.taskPending.clear();
    const steward = this.deps.steward();
    if (!chats.length || !this.chatTaskReader || !stewardTaskHintsOn(steward)) return 0;
    this.taskFlushing = true;
    let entries: TaskNoticeEntry[] = [];
    try {
      const watched = chats.filter(c => c !== steward.chatId);
      if (!this.store().itemsForChats(this.appId, watched).length) return 0;
      const states = await this.chatStatesFor([watched], true);
      const locale = this.deps.locale();
      // 读状态可能花了一阵：按此刻的事项判断（期间管家可能已经更新、关掉或改了关联）。
      for (const { item, links, taskNotified } of this.store().itemsForChats(this.appId, watched)) {
        const since = stewardUpdatedAt(item);
        const itemLinks = this.itemLinks(item.seq);
        const link = itemLinks.appLink ?? itemLinks.url;
        for (const chatId of itemChatIds(item, links, steward.chatId)) {
          const state = watched.includes(chatId) ? states.get(chatId) : undefined;
          const hint = state ? taskHintForChat(state, since) : undefined;
          if (!hint || taskNotified.includes(hint.key)) continue;
          const chatLink = links.find(l => l.kind === 'chat' && l.ref === chatId);
          entries.push({
            seq: item.seq, title: item.title, hint,
            ...(chatLink ? { chatText: linkText(chatLink, locale) } : {}),
            ...(link ? { link } : {}),
          });
        }
      }
    } finally {
      this.taskFlushing = false;
    }
    entries = entries.filter(e => (this.hintAttempts.get(`${e.seq}:${e.hint.key}`) ?? 0) < HINT_NOTICE_MAX_ATTEMPTS);
    if (!entries.length) return 0;
    const sent = await this.deliverHintNotice(entries.map(e => ({ seq: e.seq, key: e.hint.key, chat: e.hint.chatId })), Date.now(), this.deps.locale(), {
      channel: 'task',
      prompt: formatTaskPrompt(entries, this.deps.locale()),
      notice: formatTaskNotice(entries, this.deps.locale()),
    });
    if (!sent) this.retryTaskChats(entries.map(e => e.hint.chatId));
    else this.deps.log('info', `[decision-board] task alert: notified ${sent}`);
    return sent;
  }

  /** 没送出去的提醒稍后再核对一次（投递次数上限与巡检提示共用）。 */
  private retryTaskChats(chats: readonly string[]): void {
    for (const c of chats) this.taskPending.add(c);
    this.scheduleTaskFlush();
  }

  markSeen(seq: number): void {
    this.store().markSeen(this.appId, seq);
  }

  putDraft(seq: number, author: string, body: { choice?: unknown; text?: unknown; fileIds?: unknown; baseRev?: unknown }) {
    const fileIds = Array.isArray(body.fileIds) ? body.fileIds.filter((x): x is string => typeof x === 'string') : [];
    const baseRev = typeof body.baseRev === 'number' && Number.isSafeInteger(body.baseRev) ? body.baseRev : 0;
    const draft = this.store().putDraft(this.appId, seq, author, {
      choice: typeof body.choice === 'string' ? body.choice : undefined,
      text: typeof body.text === 'string' ? body.text : '',
      fileIds,
      baseRev,
    });
    return { draft: draft ?? null };
  }

  upload(image: unknown) {
    const parsed = parseDashboardImageUploads([image]);
    if (!parsed.ok) throw new BoardError('invalid_image', parsed.error);
    const img = parsed.images[0];
    const file = this.store().addFile(this.appId, {
      bytes: Buffer.from(img.dataBase64, 'base64'), mime: img.mimeType, name: img.name, by: 'owner',
    });
    return { file };
  }

  readFile(id: string) {
    return this.store().readFile(this.appId, id);
  }

  /** 只取元数据和磁盘路径：视频按 Range 分段读，不整个读进内存。 */
  fileInfo(id: string) {
    return this.store().getFile(this.appId, id);
  }

  async submit(input: { author: string; submitter?: string; authorName?: string; nonce: string; items: Array<{ seq: number; draftUpdatedAt: number }> }) {
    const res = this.store().submit(this.appId, input);
    if (!res.duplicate) for (const d of res.decisions) this.syncCard(d.seq);
    if (res.duplicate && (res.batch.delivery === 'delivered' || res.batch.delivery === 'dispatched')) {
      // 同 nonce 重试：
      //  - delivered：已送达，直接返回；
      //  - dispatched 且本进程正在投递：in-flight 行，返回当前批次（页面显示投递中），不重投；
      //  - dispatched 但本进程没有在途投递：跨重启残留的结果未知死行，先收敛成 failed，
      //    页面给出中断原因和重投按钮，而不是把死状态当成功。
      if (res.batch.delivery === 'dispatched' && !this.delivering.has(res.batch.id)) {
        return { batch: this.settleInterruptedBatch(this.store(), res.batch), decisions: res.decisions, duplicate: res.duplicate };
      }
      return { batch: res.batch, decisions: res.decisions, duplicate: res.duplicate };
    }
    const batch = await this.deliverBatch(res.batch.id);
    return { batch, decisions: res.decisions, duplicate: res.duplicate };
  }

  /**
   * 上一轮进程死在投递途中的批次（dispatched：横幅可能已发、worker 是否已收到无法确认）。
   * 结果未知，绝不能假设成功补登 delivered——那会变成「横幅说了收到、管家永远没拿到、
   * 看板还显示已送达」的静默丢消息。统一退回 failed（delivery_interrupted），由 owner
   * 在页面上看到并重投：同 turnId，worker 存活时内存去重挡住二次执行，worker 已换则
   * 由批次号与 pending/--handled 台账兜底重复。
   */
  private settleInterruptedBatch(store: DecisionBoardStore, batch: BoardBatch): BoardBatch {
    const turnId = batch.turnId ?? formatBoardTurnId(this.appId, batch.id);
    store.markBatchFailed(this.appId, batch.id, 'delivery_interrupted');
    this.deps.log('warn', `[decision-board] batch #${batch.id} (turn ${turnId}) was interrupted mid-delivery; marked failed for manual re-delivery`);
    this.syncBatchCards(batch.id);
    return store.getBatch(this.appId, batch.id)!;
  }

  async redeliver(batchId: number) {
    const batch = this.store().getBatch(this.appId, batchId);
    if (!batch) throw new BoardError('batch_not_found', `没有批次 #${batchId}`);
    if (batch.delivery === 'delivered') return { batch };
    if (batch.delivery === 'dispatched') {
      // 本进程正在投递这一批：dispatched 是 in-flight 标记，返回当前批次即可，绝不能判死。
      if (this.delivering.has(batchId)) return { batch };
      return { batch: this.settleInterruptedBatch(this.store(), batch) };
    }
    return { batch: await this.deliverBatch(batchId) };
  }

  /** daemon 起来后补投还没送达的批次。 */
  async redeliverUndelivered(): Promise<void> {
    if (!stewardReady(this.deps.steward())) return;
    let pending: BoardBatch[];
    try {
      pending = this.store().undeliveredBatches(this.appId);
    } catch (error) {
      this.deps.log('warn', `[decision-board] skip redelivery: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    for (const batch of pending) {
      // 本进程正在投递的批次（含 dispatched in-flight）交给它自己的 deliver() 收敛，不动。
      if (this.delivering.has(batch.id)) continue;
      const result = batch.delivery === 'dispatched'
        ? this.settleInterruptedBatch(this.store(), batch)
        : await this.deliverBatch(batch.id);
      this.deps.log(result.delivery === 'delivered' ? 'info' : 'warn',
        `[decision-board] redelivery of batch #${batch.id}: ${result.delivery}${result.error ? ` (${result.error})` : ''}`);
    }
  }

  /**
   * worker 的投递追踪异步判定本批次回合没进 CLI（收据超时 / 被 worker 拒绝）。daemon 通过
   * 回调转到这里：不往管家群发失败卡片（owner 在看板前，不是群里），把批次退回 failed，
   * 页面的「重新投递」用同一个稳定 turnId 再投。已 delivered 的不动。
   */
  noteDeliveryFailure(turnId: string, reason: string, messageKey?: string): void {
    const hintRound = parseHintTurnId(turnId);
    if (hintRound) {
      if (hintRound.appId !== this.appId) return;
      const round = this.hintRounds.get(turnId);
      this.hintRounds.delete(turnId);
      const entries = round?.keys;
      if (!round || !entries?.length) return;
      // 只有 worker 明确说没收下（入队前拒绝）才重发；收据超时之类是「结果未知」，CLI 可能已经拿到了，
      // 重发会在群里和会话里各多一份，就保持「已通知」（提示还留在看板上）。
      if (messageKey !== 'worker.input_rejected_before_admission') {
        this.deps.log('warn', `[decision-board] hint notice ${turnId} delivery unconfirmed (${reason}); not resending`);
        return;
      }
      this.deps.log('warn', `[decision-board] hint notice ${turnId} rejected by worker (${reason}); will retry`);
      if (round.channel === 'task') {
        this.store().unmarkTaskNotified(this.appId, this.retryable(entries));
        this.retryTaskChats(round.chats);
      } else {
        this.store().unmarkHintsNotified(this.appId, this.retryable(entries));
      }
      return;
    }
    const parsed = parseBoardTurnId(turnId);
    if (!parsed || parsed.appId !== this.appId) return;
    const batch = this.store().getBatch(this.appId, parsed.batchId);
    if (!batch || batch.delivery === 'delivered') return;
    this.deps.log('warn', `[decision-board] batch #${parsed.batchId} worker delivery failed (${reason})`);
    this.store().markBatchFailed(this.appId, parsed.batchId, reason.slice(0, 400));
    this.syncBatchCards(parsed.batchId);
  }

  /** 没送达的一批再投一次：上一轮进程死在投递途中的先收敛成 failed（与 redeliver 同口径），再按同一个回合 id 投。 */
  private async retryStuckBatch(batchId: number): Promise<void> {
    const batch = this.store().getBatch(this.appId, batchId);
    if (!batch || batch.delivery === 'delivered' || this.delivering.has(batchId)) return;
    if (batch.delivery === 'dispatched') this.settleInterruptedBatch(this.store(), batch);
    await this.deliverBatch(batchId);
  }

  /** 批次投递状态变了：这一批里每一项的卡片跟着刷新（已选 X → 已交给管家 / 投递失败）。 */
  private syncBatchCards(batchId: number): void {
    if (!this.cards) return;
    try {
      for (const d of this.store().batchDecisions(this.appId, batchId)) this.syncCard(d.seq);
    } catch (error) {
      this.deps.log('warn', `[decision-board] card refresh for batch #${batchId} skipped: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // ─── 飞书拍板卡片 ─────────────────────────────────────────────────────────

  /**
   * owner 在管家群的拍板卡片上点了选项（或只交说明）。只认管家 bot 的 owner；写进看板后
   * 和网页提交一样建批次、走 deliverBatch 投递（投递放在 deliver 里，回调应答之后再跑）。
   */
  cardClick(click: BoardCardClick): BoardCardClickResult {
    const T = CARD_TOASTS[this.deps.locale() === 'en' ? 'en' : 'zh'];
    const cards = this.cards;
    const v = click.value;
    if (!cards || v.app !== this.appId) return { toast: { type: 'warning', content: T.unavailable } };
    const owner = this.deps.ownerOpenId();
    if (!owner || !click.operatorOpenId || click.operatorOpenId !== owner) {
      this.deps.log('info', `[decision-board] card click by non-owner ${click.operatorOpenId ?? '?'} rejected`);
      return { toast: { type: 'error', content: T.noPermission } };
    }
    const seq = typeof v.seq === 'string' && /^\d{1,9}$/.test(v.seq) ? Number(v.seq) : NaN;
    const store = this.store();
    const item = Number.isSafeInteger(seq) ? store.getItem(this.appId, seq) : undefined;
    if (!item) return { toast: { type: 'warning', content: T.gone } };
    const refreshed = (content: string, type: 'info' | 'warning' = 'warning'): BoardCardClickResult => {
      const r = cards.render(seq);
      if (r && click.messageId) cards.noteRendered(seq, click.messageId, r.hash);
      return { toast: { type, content }, ...(r ? { card: r.card } : {}) };
    };
    // 关了开关：不写入，把这张卡收成只有链接的版本。
    if (!cards.enabled()) return refreshed(T.disabled);
    // 点的是被顶替的旧卡（卡片失效后另发过、或管家群换过）：不写入，也不把它换回能点的卡片，
    // 免得一项有两张能点的卡。
    if (click.messageId && !cards.isCurrentCard(seq, click.messageId)) {
      const r = cards.render(seq, 'replaced');
      return { toast: { type: 'warning', content: T.replaced }, ...(r ? { card: r.card } : {}) };
    }
    const choice = v.action === DECISION_CARD_ACTION_PICK && typeof v.key === 'string' && v.key ? v.key : undefined;
    if (v.action !== DECISION_CARD_ACTION_PICK && v.action !== DECISION_CARD_ACTION_NOTE) return { toast: { type: 'warning', content: T.unavailable } };
    if (v.action === DECISION_CARD_ACTION_PICK && !choice) return { toast: { type: 'warning', content: T.unavailable } };
    const text = cardNoteText(click.formValue);
    if (!choice && !text) return { toast: { type: 'warning', content: T.noteRequired } };
    if (item.state !== 'decide') return refreshed(T.notDeciding);
    if (v.ask !== decisionAskKey(item) || (choice && !item.options.some(o => o.key === choice))) return refreshed(T.stale);
    // 连点、或飞书没收到应答后的重试：最近一条还没被处理 / 覆盖的决定就是同一个选择和说明时不再建批次。
    // 那一批投递失败时顺带重投一次（同一个回合 id，管家那边不会重复执行）。
    // 只有在同一份选项下（指纹相同）才算重复：选项改过之后同一个选项键可能换了意思，那是新决定。
    const latest = store.latestDecision(this.appId, seq);
    const latestBatch = latest ? store.getBatch(this.appId, latest.batchId) : undefined;
    if (latest && latestBatch && !latest.handledAt && latest.supersededBy === undefined
      && latestBatch.createdAt >= item.stateAt && (latest.askKey ?? v.ask) === v.ask
      && (latest.choice ?? undefined) === choice && latest.text.trim() === text) {
      const res = refreshed(T.duplicate, 'info');
      // 那一批没送达（失败，或上一轮进程死在投递途中）：顺带重投一次，同一个回合 id。
      const stuck = latestBatch.delivery === 'failed'
        || (latestBatch.delivery === 'dispatched' && !this.delivering.has(latestBatch.id));
      return stuck ? { ...res, deliver: () => this.retryStuckBatch(latestBatch.id) } : res;
    }
    let submitted: ReturnType<DecisionBoardStore['submitCard']>;
    try {
      submitted = store.submitCard(this.appId, {
        seq, ...(choice ? { choice } : {}), text,
        submitter: click.operatorUnionId && /^[A-Za-z0-9_-]{1,128}$/.test(click.operatorUnionId) ? `u:${click.operatorUnionId}` : 'owner',
        nonce: `card:${seq}:${randomUUID()}`,
        // 校验与写入在同一把写锁里：两次检查之间管家刚好改了选项或关掉事项，也不会按旧卡片写进去。
        verify: current => {
          if (current.state !== 'decide') throw new BoardError('item_not_deciding');
          if (decisionAskKey(current) !== v.ask) throw new BoardError('card_stale');
        },
      });
    } catch (error) {
      if (error instanceof BoardError && error.code === 'item_not_deciding') return refreshed(T.notDeciding);
      if (error instanceof BoardError && (error.code === 'card_stale' || error.code === 'unknown_choice')) return refreshed(T.stale);
      throw error;
    }
    const batchId = submitted.batch.id;
    // 被覆盖的较早批次所在的卡片（同一项，就是这张）随下面的同步一起刷新。
    const res = refreshed(choice ? T.accepted(`${choice} ${item.options.find(o => o.key === choice)?.label ?? ''}`.trim()) : T.acceptedNote, 'info');
    return {
      ...res,
      toast: { type: 'success', content: res.toast!.content },
      deliver: async () => { await this.deliverBatch(batchId); },
    };
  }

  // ─── 自动发现可以关的项 ─────────────────────────────────────────────────

  /**
   * 后台巡检一轮（daemon 定时调用，不调模型）：查 PR 状态 → 在一个写事务里给每一项求提示（只标提示、
   * 记历史，不改状态）→ 有还没通知过的提示就合成一条通知送进管家会话（一轮最多一条）。
   *
   * 只在「自动发现可以关的项」开着、管家群选好、看板库已经存在时跑；同一时间只跑一轮。
   * 通知送不出去（管家会话在开场、投递抛错）时不记「已通知」，下一轮重试；送进 worker 之后
   * 异步失败的回执由 {@link noteDeliveryFailure} 撤销「已通知」。
   */
  async sweepHints(now = Date.now()): Promise<{ marked: number; cleared: number; notified: number } | undefined> {
    const steward = this.deps.steward();
    if (!stewardCloseHintsOn(steward)) return undefined;
    // 没用过看板的 bot 不为巡检建库。
    if (!this.storeRef && !existsSync(decisionBoardDbPath(this.deps.dataDir))) return undefined;
    if (this.sweeping) return undefined;
    this.sweeping = true;
    let pending: Array<{ seq: number; title: string; hint: BoardHint }> = [];
    let summary: { marked: number; cleared: number };
    let at: number;
    try {
      const store = this.store();
      const app = this.appId;
      const refs = store.hintPrRefs(app);
      const batch = refs.length > HINT_PR_LOOKUPS_PER_ROUND
        ? Array.from({ length: HINT_PR_LOOKUPS_PER_ROUND }, (_, i) => refs[(this.prCursor + i) % refs.length]!)
        : refs;
      if (refs.length > HINT_PR_LOOKUPS_PER_ROUND) {
        this.prCursor = (this.prCursor + HINT_PR_LOOKUPS_PER_ROUND) % refs.length;
        this.deps.log('info', `[decision-board] hint sweep: ${refs.length} PRs, checking ${HINT_PR_LOOKUPS_PER_ROUND} this round (rotating)`);
      }
      for (const ref of batch) {
        let state: PrMergeState | undefined;
        try {
          state = await this.deps.prState?.(ref);
        } catch (error) {
          this.deps.log('warn', `[decision-board] hint sweep: PR ${ref} lookup failed (${error instanceof Error ? error.message : String(error)})`);
        }
        if (state) this.prKnown.set(ref, state);
      }
      // 查 PR 期间开关可能被关掉：关了就不再写。
      if (!stewardCloseHintsOn(this.deps.steward())) return undefined;
      // 查 PR 可能花了一阵：提示时间和历史按查完的时间记，不早于期间管家的改动。
      at = Math.max(now, Date.now());
      const locale = this.deps.locale();
      const result = store.sweepHints(app, { now: at, locale, prState: ref => this.prKnown.get(ref) }, at);
      pending = result.pending;
      summary = { marked: result.marked, cleared: result.cleared };
    } finally {
      this.sweeping = false;
    }
    let notified = 0;
    if (pending.length) {
      const locale = this.deps.locale();
      const entries: HintNoticeEntry[] = pending.map(p => {
        const links = this.itemLinks(p.seq);
        const link = links.appLink ?? links.url;
        return { seq: p.seq, title: p.title, hint: p.hint, ...(link ? { link } : {}) };
      });
      notified = await this.deliverHintNotice(pending.map(p => ({ seq: p.seq, key: p.hint.key })), at, locale, {
        channel: 'hint',
        prompt: formatHintPrompt(entries, locale),
        notice: formatHintNotice(entries, locale),
      });
    }
    if (summary.marked || summary.cleared || notified) {
      this.deps.log('info', `[decision-board] hint sweep: marked ${summary.marked}, cleared ${summary.cleared}, notified ${notified}`);
    }
    return { ...summary, notified };
  }

  /** 还没到自动投递上限的那些 key（超过上限的保持「已通知」，不再自动发）。 */
  private retryable(entries: ReadonlyArray<{ seq: number; key: string }>): Array<{ seq: number; key: string }> {
    return entries.filter(e => (this.hintAttempts.get(`${e.seq}:${e.key}`) ?? 0) < HINT_NOTICE_MAX_ATTEMPTS);
  }

  /**
   * 把一轮提示（巡检的关闭 / 推进提示，或子任务提醒）合成一条送进管家会话。两类各记各的「已通知」。
   */
  private async deliverHintNotice(
    keys: Array<{ seq: number; key: string; chat?: string }>,
    round: number,
    locale: Locale,
    content: { channel: NoticeChannel; prompt: string; notice: string },
  ): Promise<number> {
    const steward = this.deps.steward();
    if (!stewardReady(steward)) return 0;
    // 上一条通知还在投（deliver 卡住）：这轮不再叠一条，留到下一轮。
    if (this.noticeInFlight) return 0;
    this.noticeInFlight = true;
    const store = this.store();
    const mark = (entries: Array<{ seq: number; key: string }>) => content.channel === 'task'
      ? store.markTaskNotified(this.appId, entries) : store.markHintsNotified(this.appId, entries);
    const unmark = (entries: Array<{ seq: number; key: string }>) => content.channel === 'task'
      ? store.unmarkTaskNotified(this.appId, entries) : store.unmarkHintsNotified(this.appId, entries);
    try {
      const plain = keys.map(k => ({ seq: k.seq, key: k.key }));
      for (const k of plain) this.hintAttempts.set(`${k.seq}:${k.key}`, (this.hintAttempts.get(`${k.seq}:${k.key}`) ?? 0) + 1);
      while (this.hintAttempts.size > 512) this.hintAttempts.delete(this.hintAttempts.keys().next().value!);
      const turnId = formatHintTurnId(this.appId, round);
      // 先记「已通知」再投：deliver() 里进程死掉时宁可漏一次（看板上的提示还在），也不重复刷屏；
      // deliver() 明确失败就撤销（没到次数上限的），下一轮重试。
      mark(plain);
      this.hintRounds.set(turnId, { channel: content.channel, keys: plain, chats: [...new Set(keys.flatMap(k => (k.chat ? [k.chat] : [])))] });
      while (this.hintRounds.size > 16) this.hintRounds.delete(this.hintRounds.keys().next().value!);
      try {
        await this.deps.deliver({
          turnId,
          prompt: content.prompt,
          announcement: { texts: splitEchoText(content.notice), images: [] },
          attachments: [],
          chatId: steward.chatId,
          sessionTitle: locale === 'en' ? 'Steward' : '管家',
        });
      } catch (error) {
        this.hintRounds.delete(turnId);
        const retry = this.retryable(plain);
        unmark(retry);
        this.deps.log('warn', `[decision-board] hint notice ${turnId} delivery failed: ${error instanceof Error ? error.message : String(error)}`
          + (retry.length < plain.length ? `; ${plain.length - retry.length} hint(s) reached ${HINT_NOTICE_MAX_ATTEMPTS} attempts, not retrying` : ''));
        return 0;
      }
      return plain.length;
    } finally {
      this.noticeInFlight = false;
    }
  }

  /** 同一批次同时只投一次；投完返回最新的批次状态（失败不抛，记在批次上）。 */
  deliverBatch(batchId: number): Promise<BoardBatch> {
    const inflight = this.delivering.get(batchId);
    if (inflight) return inflight;
    const run = this.deliveryChain.catch(() => undefined).then(() => this.deliverBatchOnce(batchId)).finally(() => {
      this.delivering.delete(batchId);
      this.syncBatchCards(batchId);
    });
    this.delivering.set(batchId, run);
    this.deliveryChain = run;
    return run;
  }

  private async deliverBatchOnce(batchId: number): Promise<BoardBatch> {
    const store = this.store();
    const app = this.appId;
    const batch = store.getBatch(app, batchId);
    if (!batch) throw new BoardError('batch_not_found', `没有批次 #${batchId}`);
    if (batch.delivery === 'delivered') return batch;
    if (batch.delivery === 'dispatched') return this.settleInterruptedBatch(store, batch);
    const steward = this.deps.steward();
    if (!steward?.enabled) {
      store.markBatchFailed(app, batchId, 'steward_disabled');
      return store.getBatch(app, batchId)!;
    }
    if (!steward.chatId) {
      store.markBatchFailed(app, batchId, 'steward_chat_missing');
      return store.getBatch(app, batchId)!;
    }
    // 提交人名字要查通讯录（可能要等）：放在落 dispatched、读覆盖标记之前，读完到交给 deliver 之间不再等别的。
    const ownerOpenId = this.deps.ownerOpenId();
    const ownerName = batch.authorName || await this.deps.ownerName().catch(() => undefined);
    store.markBatchAttempt(app, batchId);
    // 稳定回合 id + dispatched 在【调用 deliver 之前】落盘：deliver() 内部要发横幅、走
    // 会话锁、把输入交给 worker，其中任何一步后进程死亡，重启都只能看到「结果未知」的
    // dispatched，由 settleInterruptedBatch 退回 failed 让人重投（绝不假设成功静默丢消息）。
    const turnId = formatBoardTurnId(app, batchId);
    store.markBatchDispatched(app, batchId, turnId);
    const locale = this.deps.locale();
    const decisions = store.batchDecisions(app, batchId);
    const attachments: LarkAttachment[] = [];
    const dir = this.deps.batchAttachmentsDir(batchId);
    const entries = decisions.map(d => {
      const item = store.getItem(app, d.seq);
      const option = item?.options.find(o => o.key === d.choice);
      const chat = item ? this.chatState(item, store.links(app, d.seq)).mainChat : undefined;
      for (const fid of d.fileIds) {
        const found = store.getFile(app, fid);
        if (!found) continue;
        try {
          mkdirSync(dir, { recursive: true, mode: 0o700 });
          const name = `${String(d.seq).padStart(3, '0')}-${attachments.length + 1}-${found.file.name}`;
          const target = join(dir, name);
          copyFileSync(found.path, target);
          attachments.push({ type: 'image', path: target, name, mimeType: found.file.mime });
        } catch (error) {
          this.deps.log('warn', `[decision-board] batch #${batchId}: copy image ${fid} failed (${error instanceof Error ? error.message : String(error)})`);
        }
      }
      return {
        seq: d.seq,
        title: item?.title ?? `#${d.seq}`,
        state: item?.state ?? 'active',
        ...(item?.stage ? { stage: item.stage } : {}),
        ...(d.choice ? { choice: d.choice } : {}),
        ...(option ? { choiceLabel: option.label } : {}),
        recommended: !!d.choice && item?.recommend === d.choice,
        ...(batch.source === 'card' ? { source: 'card' as const } : {}),
        ...(() => {
          const detail = store.supersededDetail(app, batchId, d.seq);
          const settled = detail.filter(x => x.settled).map(x => x.batchId);
          const open = detail.filter(x => !x.settled).map(x => x.batchId);
          return { ...(settled.length ? { supersedes: settled } : {}), ...(open.length ? { supersedesPending: open } : {}) };
        })(),
        ...(d.supersededBy !== undefined ? { supersededBy: d.supersededBy } : {}),
        text: d.text,
        fileCount: d.fileIds.length,
        ...(chat?.url ? { primaryChat: { text: chat.text, url: chat.url } } : {}),
      };
    });
    const prompt = formatBatchMessage({
      batchId,
      authorName: ownerName || 'owner',
      createdAt: batch.createdAt,
      entries,
      locale,
      timeZone: this.deps.timeZone(),
    });
    let sessionId: string | undefined;
    try {
      const res = await this.deps.deliver({
        turnId,
        prompt,
        announcement: {
          // 群里看到的就是 owner 提交的内容：与批次消息同一份逐项文本，不带给管家的执行指令。
          texts: splitEchoText(formatBatchEcho({
            header: this.deps.banner({ batchId, count: decisions.length, locale }),
            entries,
            locale,
          })),
          images: attachments,
        },
        attachments,
        ...(ownerOpenId ? { ownerOpenId } : {}),
        ...(ownerName ? { ownerName } : {}),
        chatId: steward.chatId,
        sessionTitle: locale === 'en' ? 'Steward' : '管家',
      });
      sessionId = res.sessionId;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.deps.log('warn', `[decision-board] batch #${batchId} delivery failed: ${message}`);
      store.markBatchFailed(app, batchId, message);
      return store.getBatch(app, batchId)!;
    }
    // deliver() 成功返回才落终态。失败回执可能在 resolve 前先到（worker 权威判定），那时
    // 批次已是 failed，markBatchDelivered 返回 false 不覆盖；失败原因对 owner 可见、可重投。
    if (!store.markBatchDelivered(app, batchId, { sessionId, turnId })) {
      this.deps.log('warn', `[decision-board] batch #${batchId} deliver() resolved but a worker failure receipt marked it failed first; keeping failed`);
    }
    return store.getBatch(app, batchId)!;
  }
}

/**
 * 这次写入要不要（在还没有卡片时）发新卡：刚进入待拍板（含新建即待拍板），或待拍板的问题 / 选项 /
 * 推荐变了。只改进展、阶段这类字段不发新卡（已有卡片照样原地刷新）。
 */
function askChanged(before: BoardItem | undefined, after: BoardItem): boolean {
  if (after.state !== 'decide') return false;
  if (!before || before.state !== 'decide') return true;
  return decisionAskKey(before) !== decisionAskKey(after);
}

/** 统一把服务层错误映射成 IPC 响应。 */
export function boardErrorStatus(error: unknown): { status: number; error: string; message: string } {
  if (error instanceof BoardError) {
    const status = error.code === 'not_steward' ? 409
      : error.code === 'file_too_large' ? 413
      : error.code === 'staging_full' ? 507
      : error.code === 'item_not_found' || error.code === 'batch_not_found' ? 404
        : error.code === 'storage_unavailable' ? 503
          : error.code === 'draft_changed' || error.code === 'draft_missing' || error.code === 'key_conflict'
            || error.code === 'item_ended' ? 409
            : 400;
    return { status, error: error.code, message: error.message };
  }
  return { status: 500, error: 'internal', message: error instanceof Error ? error.message : String(error) };
}
