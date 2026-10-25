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
import {
  BOARD_STATE_LABELS,
  boardItemPath,
  composeStewardGuide,
  formatBatchMessage,
  formatBoardTurnId,
  isBoardState,
  isBoardView,
  linkDefaultLabel,
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
    banner: string;
    attachments: LarkAttachment[];
    ownerOpenId?: string;
    ownerName?: string;
    chatId: string;
    sessionTitle: string;
  }): Promise<{ sessionId: string }>;
  log(level: 'info' | 'warn', message: string): void;
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
}

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

  renderLinks(links: BoardLink[]): Array<BoardLink & { url?: string; text: string }> {
    const ctx = { brand: this.deps.brand(), dashboardBase: this.deps.dashboardOrigin() };
    return links.map(l => ({ ...l, text: l.label ?? linkDefaultLabel(l), ...(linkUrl(l, ctx) ? { url: linkUrl(l, ctx) } : {}) }));
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

  private resolveRef(raw: unknown): number {
    const ref = parseItemRef(raw);
    if (!ref) throw new BoardError('invalid_ref', '要给出事项编号（如 12 或 #12）或 key');
    const seq = this.store().resolveSeq(this.appId, ref);
    if (seq === undefined) throw new BoardError('item_not_found', `没有找到 ${String(raw)}`);
    return seq;
  }

  private itemOut(seq: number) {
    const item = this.store().getItem(this.appId, seq)!;
    return { ...item, stateLabel: BOARD_STATE_LABELS[this.deps.locale()][item.state], ...this.itemLinks(seq) };
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
        }));
        return { view, counts: store.counts(app), items };
      }
      case 'show': {
        const seq = this.resolveRef(req.ref);
        const detail = store.detail(app, seq)!;
        return {
          item: this.itemOut(seq),
          links: this.renderLinks(detail.links),
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
        const { item, created } = store.addItem(app, { ...patch, title }, ctx.sessionId, undefined, this.deps.locale());
        return { created, item: this.itemOut(item.seq) };
      }
      case 'set': {
        const seq = this.resolveRef(req.ref);
        const patch = this.parsePatch(req);
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
        ...i, links: this.renderLinks(i.links), ...this.itemLinks(i.seq),
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
      links: this.renderLinks(detail.links),
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
        banner: this.deps.banner({ batchId, count: decisions.length, locale }),
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
