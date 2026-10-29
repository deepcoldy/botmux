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
import { copyFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Locale } from '../../i18n/types.js';
import type { Brand } from '../../im/lark/lark-hosts.js';
import type { LarkAttachment } from '../../types.js';
import { parseDashboardImageUploads } from '../dashboard-images.js';
import {
  BoardError,
  DecisionBoardStore,
  type ItemPatch,
} from '../../services/decision-board-store.js';
import { formatChatLookupFailures, lookupProvesChatNotFound, type ChatLookupResult } from './chat-lookup.js';
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
  stewardReady,
  type BoardBatch,
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
}

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
  note?: unknown;
  /** `--primary-chat oc_…` */
  primaryChat?: unknown;
  /** `--no-chat "<原因>"` */
  noChat?: unknown;
  /** `--allow-unverified-chat`：查不到的群也写，标「未核实」。 */
  allowUnverifiedChat?: unknown;
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

export class DecisionBoardService {
  private storeRef?: DecisionBoardStore;
  private readonly delivering = new Map<number, Promise<BoardBatch>>();

  constructor(private readonly deps: DecisionBoardServiceDeps) {}

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
    return { effective: composeStewardGuide(this.deps.steward(), locale), preset: stewardGuidePreset(locale) };
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

  private itemOut(seq: number) {
    const item = this.store().getItem(this.appId, seq)!;
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
        const { item, created } = store.addItem(app, { ...patch, title }, ctx.sessionId, undefined, this.deps.locale());
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
        store.updateItem(app, seq, patch, ctx.sessionId, undefined, this.deps.locale());
        return { item: this.itemOut(seq) };
      }
      case 'history': {
        const seq = this.resolveRef(req.ref);
        if (typeof req.text !== 'string') throw new BoardError('text_required', '历史内容不能为空');
        const res = store.appendHistory(app, seq, req.text, { handled: req.handled === true, actorRef: ctx.sessionId });
        return { seq, eventId: res.eventId, handledDecisions: res.handled, ...this.itemLinks(seq) };
      }
      case 'attach': {
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
        ...this.withoutStaleReason(i, i.links), links: this.renderLinks(i.links, i.primaryChat), ...this.itemLinks(i.seq),
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
      item: this.withoutStaleReason(detail.item, detail.links),
      links: this.renderLinks(detail.links, detail.item.primaryChat),
      missingChat: itemMissingChat(detail.item, detail.links),
      ...this.itemLinks(seq),
      steward: this.meta().steward,
      drafts: store.listDrafts(this.appId, author).map(d => ({ seq: d.seq, updatedAt: d.updatedAt })),
    };
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

  async submit(input: { author: string; submitter?: string; authorName?: string; nonce: string; items: Array<{ seq: number; draftUpdatedAt: number }> }) {
    const res = this.store().submit(this.appId, input);
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
  noteDeliveryFailure(turnId: string, reason: string): void {
    const parsed = parseBoardTurnId(turnId);
    if (!parsed || parsed.appId !== this.appId) return;
    const batch = this.store().getBatch(this.appId, parsed.batchId);
    if (!batch || batch.delivery === 'delivered') return;
    this.deps.log('warn', `[decision-board] batch #${parsed.batchId} worker delivery failed (${reason})`);
    this.store().markBatchFailed(this.appId, parsed.batchId, reason.slice(0, 400));
  }

  /** 同一批次同时只投一次；投完返回最新的批次状态（失败不抛，记在批次上）。 */
  deliverBatch(batchId: number): Promise<BoardBatch> {
    const inflight = this.delivering.get(batchId);
    if (inflight) return inflight;
    const run = this.deliverBatchOnce(batchId).finally(() => this.delivering.delete(batchId));
    this.delivering.set(batchId, run);
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
        text: d.text,
        fileCount: d.fileIds.length,
        ...(chat?.url ? { primaryChat: { text: chat.text, url: chat.url } } : {}),
      };
    });
    const ownerOpenId = this.deps.ownerOpenId();
    const ownerName = batch.authorName || await this.deps.ownerName().catch(() => undefined);
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

/** 统一把服务层错误映射成 IPC 响应。 */
export function boardErrorStatus(error: unknown): { status: number; error: string; message: string } {
  if (error instanceof BoardError) {
    const status = error.code === 'not_steward' ? 409
      : error.code === 'item_not_found' || error.code === 'batch_not_found' ? 404
        : error.code === 'storage_unavailable' ? 503
          : error.code === 'draft_changed' || error.code === 'draft_missing' || error.code === 'key_conflict' ? 409
            : 400;
    return { status, error: error.code, message: error.message };
  }
  return { status: 500, error: 'internal', message: error instanceof Error ? error.message : String(error) };
}
