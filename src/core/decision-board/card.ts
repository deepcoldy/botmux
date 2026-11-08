/**
 * 决策看板的飞书拍板卡片：事项进入待拍板（或改了选项）时，往管家群发一张能直接点选项的卡片；
 * 一项只留一张，之后的变化（选项改了、owner 选了、批次送达 / 失败、事项关闭）都原地更新。
 *
 *   - 卡片内容只由看板数据推导（{@link buildDecisionCard} 是纯函数），记录里只存消息 id 和内容指纹；
 *   - 点选项 = 一次只含这一项的批次，和网页提交走同一条投递路径（见 service.cardClick）；
 *   - 只对管家可用、且没关「飞书卡片拍板」的 bot 生效（{@link stewardDecisionCardsOn}）。
 *
 * 降级：事项不在待拍板（含已关闭 / 已完成）、选项超过 {@link DECISION_CARD_MAX_OPTIONS} 个、
 * 或卡片放不下时，只显示现状和「去看板细看」链接，不放按钮。
 */
import { createHash } from 'node:crypto';
import type { Locale } from '../../i18n/types.js';
import type { BoardCardRecord, DecisionBoardStore } from '../../services/decision-board-store.js';
import {
  BOARD_STATE_LABELS,
  DECISION_CARD_MAX_OPTIONS,
  stewardDecisionCardsOn,
  type BoardBatch,
  type BoardDecision,
  type BoardItem,
  type StewardConfig,
} from './model.js';
import { decisionAskKey } from './ask-key.js';

export { decisionAskKey };

export const DECISION_CARD_ACTION_PREFIX = 'board_card_';
/** 点选项（说明框里的内容一起提交）。 */
export const DECISION_CARD_ACTION_PICK = 'board_card_pick';
/** 只交说明，不选选项。 */
export const DECISION_CARD_ACTION_NOTE = 'board_card_note';
/** 卡片表单里说明输入框的字段名（回调的 form_value 里取）。 */
export const DECISION_CARD_NOTE_FIELD = 'board_note';

/** 卡片正文里长文本的截断长度（字符）：全文在看板上，卡片只要一屏能读完。 */
const QUESTION_CHARS = 600;
const SUMMARY_CHARS = 200;
const OPTION_TEXT_CHARS = 200;
const BUTTON_LABEL_CHARS = 36;
/** 说明框上限：飞书 input 的 max_length 只到 1000。 */
const NOTE_MAX_CHARS = 1_000;
/** 飞书卡片请求体上限 30KB；超过这个预算就降级成只给链接的卡片。 */
export const DECISION_CARD_MAX_BYTES = 24_000;

/** 卡片上展示的「这一项最近一次决定」。 */
export interface CardDecisionStatus {
  decision: BoardDecision;
  batch: BoardBatch;
  choiceLabel?: string;
  /** 这次决定覆盖了哪些较早批次（以及它们的来源）。 */
  supersedes: Array<{ id: number; source: 'web' | 'card' }>;
  /** 这次决定后来被哪个批次覆盖（以及来源）。 */
  supersededBy?: { id: number; source: 'web' | 'card' };
  /** 决定之后选项改过（同一个选项键可能换了意思）：不显示现在的选项原文。 */
  optionsChanged?: boolean;
}

export interface DecisionCardInput {
  appId: string;
  locale: Locale;
  item: BoardItem;
  links: { url?: string; appLink?: string };
  /** 当前状态下（进入待拍板之后）最近的一次决定；没有就不显示。 */
  status?: CardDecisionStatus;
  /** 这一项附了几个图文说明（说明页 / 视频）；卡片里放不下，只提示去看板上看。 */
  explainers?: number;
  /**
   * 卡片不再是入口时只给链接：'disabled' = 关了「飞书卡片拍板」或管家；'moved' = 管家群换了，
   * 新卡片在新群；'replaced' = 这张已被同一项更新的卡片顶替。
   */
  retired?: 'disabled' | 'moved' | 'replaced';
}

type Mode = 'open' | 'too_many' | 'not_deciding' | 'ended';

const TEXT = {
  zh: {
    decide: '待拍板',
    summary: '现状',
    question: '要你定',
    recommend: '推荐',
    reason: '理由',
    notePlaceholder: '写说明（可选）：随选项一起交给管家',
    noteOnly: '只交说明',
    open: '去看板细看',
    tooMany: (n: number) => `这一项有 ${n} 个选项，卡片放不下，去看板上拍板。`,
    tooBig: '内容太长，卡片放不下，去看板上拍板。',
    notDeciding: (state: string) => `这一项现在是「${state}」，不再待拍板。`,
    noLink: (seq: number) => `到 Dashboard 的决策看板 #${seq} 处理。`,
    explainers: (n: number) => `📎 附了 ${n} 个图文说明（说明页 / 视频），去看板上查看`,
    footer: '只有看板 owner 能点；同一项在卡片和网页上都提交时，以后提交的为准。',
    chose: (label: string, web: boolean) => web ? `网页上已选 **${label}**` : `已选 **${label}**`,
    noteSubmitted: (web: boolean) => web ? '网页上已提交说明' : '已提交说明',
    delivered: (id: number) => `已交给管家（批次 #${id}）`,
    delivering: (id: number) => `正在交给管家…（批次 #${id}）`,
    failed: (id: number, why: string) => `交给管家失败（批次 #${id}）：${why}。去看板「最近提交」里重新投递。`,
    handled: (id: number) => `管家已处理（批次 #${id}）`,
    supersedes: (ids: string) => `覆盖了${ids} 的决定，以这次为准。`,
    supersededBy: (id: number, web: boolean) => `${web ? '网页上' : '卡片上'}随后又提交了批次 #${id}，以后提交的为准。`,
    batchRef: (id: number, web: boolean) => `${web ? '网页' : '卡片'}批次 #${id}`,
    sep: '、',
    optionsChanged: '（之后选项改过）',
    disabled: '这个管家已关闭「飞书卡片拍板」，去看板上处理。',
    moved: '管家群换了，这一项的拍板卡片在新的管家群里。',
    replaced: '这张卡片已过期，这一项的最新卡片在管家群里。',
  },
  en: {
    decide: 'Decision needed',
    summary: 'Status',
    question: 'Question',
    recommend: 'recommended',
    reason: 'Why',
    notePlaceholder: 'Add a note (optional): sent with the option you pick',
    noteOnly: 'Send note only',
    open: 'Open in board',
    tooMany: (n: number) => `This item has ${n} options, too many for a card. Decide on the board.`,
    tooBig: 'Too long for a card. Decide on the board.',
    notDeciding: (state: string) => `This item is now "${state}" and no longer awaits a decision.`,
    noLink: (seq: number) => `Open item #${seq} in the Dashboard decision board.`,
    explainers: (n: number) => `📎 ${n} explainer${n === 1 ? '' : 's'} attached (page / video); view on the board`,
    footer: 'Only the board owner can click. If both the card and the web page submit, the later one wins.',
    chose: (label: string, web: boolean) => web ? `Picked **${label}** on the web` : `Picked **${label}**`,
    noteSubmitted: (web: boolean) => web ? 'Note submitted on the web' : 'Note submitted',
    delivered: (id: number) => `sent to the steward (batch #${id})`,
    delivering: (id: number) => `sending to the steward… (batch #${id})`,
    failed: (id: number, why: string) => `delivery failed (batch #${id}): ${why}. Re-deliver it under "Recent submissions" on the board.`,
    handled: (id: number) => `handled by the steward (batch #${id})`,
    supersedes: (ids: string) => `Supersedes the decision in ${ids}; this one counts.`,
    supersededBy: (id: number, web: boolean) => `Batch #${id} was submitted later ${web ? 'on the web' : 'from the card'}; the later one wins.`,
    batchRef: (id: number, web: boolean) => `${web ? 'web' : 'card'} batch #${id}`,
    sep: ', ',
    optionsChanged: ' (options changed since)',
    disabled: 'Decision cards are off for this steward; use the board.',
    moved: 'The steward chat changed; this item\'s decision card is in the new steward chat.',
    replaced: 'This card is outdated; the latest card for this item is in the steward chat.',
  },
} as const;

/** 卡片 markdown 转义（不吞换行：多行问题保留分行）。 */
function md(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/([\\*_~`[\]])/g, '\\$1');
}

/** 按字符截断，不切坏多字节字符。 */
function clip(text: string, max: number): string {
  const chars = Array.from(text.trim());
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : chars.join('');
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function cardMode(item: BoardItem): Mode {
  if (item.state === 'done' || item.state === 'closed') return 'ended';
  if (item.state !== 'decide') return 'not_deciding';
  if (item.options.length > DECISION_CARD_MAX_OPTIONS) return 'too_many';
  return 'open';
}

function statusLine(status: CardDecisionStatus, locale: Locale): string {
  const L = TEXT[locale === 'en' ? 'en' : 'zh'];
  const { decision, batch } = status;
  const web = batch.source !== 'card';
  // 选项后来改过时只写选项键：现在的原文可能已经不是 owner 当时选的意思。
  const head = decision.choice
    ? status.optionsChanged
      ? `${L.chose(md(decision.choice), web)}${L.optionsChanged}`
      : L.chose(md(oneLine(`${decision.choice}${status.choiceLabel ? ` ${clip(status.choiceLabel, 60)}` : ''}`)), web)
    : L.noteSubmitted(web);
  const state = decision.handledAt
    ? L.handled(batch.id)
    : batch.delivery === 'delivered'
      ? L.delivered(batch.id)
      : batch.delivery === 'failed'
        ? L.failed(batch.id, md(clip(oneLine(batch.error ?? '?'), 120)))
        : L.delivering(batch.id);
  const lines = [`${head}${locale === 'en' ? ', ' : '，'}${state}`];
  if (status.supersedes.length) {
    lines.push(L.supersedes(status.supersedes.map(s => L.batchRef(s.id, s.source !== 'card')).join(L.sep)));
  }
  if (status.supersededBy) lines.push(L.supersededBy(status.supersededBy.id, status.supersededBy.source !== 'card'));
  return lines.join('\n');
}

function linkButton(links: DecisionCardInput['links'], locale: Locale): Record<string, unknown> | undefined {
  if (!links.url) return undefined;
  return {
    tag: 'button',
    text: { tag: 'plain_text', content: TEXT[locale === 'en' ? 'en' : 'zh'].open },
    type: 'default',
    behaviors: [links.appLink
      ? { type: 'open_url', default_url: links.url, pc_url: links.appLink, android_url: links.url, ios_url: links.url }
      : { type: 'open_url', default_url: links.url }],
  };
}

function shell(title: string, template: string, elements: unknown[]): Record<string, unknown> {
  return {
    schema: '2.0',
    config: { update_multi: true, width_mode: 'fill' },
    header: { title: { tag: 'plain_text', content: title }, template },
    body: { direction: 'vertical', elements },
  };
}

/** 只有现状和链接的卡片：降级与「不再待拍板」都用它。 */
function linkOnlyCard(input: DecisionCardInput, template: string, notice: string): Record<string, unknown> {
  const L = TEXT[input.locale === 'en' ? 'en' : 'zh'];
  const { item } = input;
  const label = BOARD_STATE_LABELS[input.locale === 'en' ? 'en' : 'zh'][item.state];
  const body: string[] = [];
  if (item.summary) body.push(`**${L.summary}**：${md(clip(oneLine(item.summary), SUMMARY_CHARS))}`);
  if (input.explainers) body.push(L.explainers(input.explainers));
  if (input.status) body.push(statusLine(input.status, input.locale));
  body.push(notice);
  if (!input.links.url) body.push(L.noLink(item.seq));
  const elements: unknown[] = [{ tag: 'markdown', content: body.join('\n') }];
  const btn = linkButton(input.links, input.locale);
  if (btn) elements.push(btn);
  const suffix = input.locale === 'en' ? ` (${label})` : `（${label}）`;
  return shell(`#${item.seq} ${clip(oneLine(item.title), 80)}${suffix}`, template, elements);
}

function openCard(input: DecisionCardInput): Record<string, unknown> {
  const loc = input.locale === 'en' ? 'en' : 'zh';
  const L = TEXT[loc];
  const { item } = input;
  const ask = decisionAskKey(item);
  const top: string[] = [];
  if (item.summary) top.push(`**${L.summary}**：${md(clip(oneLine(item.summary), SUMMARY_CHARS))}`);
  if (input.explainers) top.push(L.explainers(input.explainers));
  if (item.question) top.push(`**${L.question}**：${md(clip(item.question, QUESTION_CHARS))}`);
  const optionLines = item.options.map(o => {
    const rec = o.key === item.recommend ? (loc === 'en' ? ` **(${L.recommend})**` : `**（${L.recommend}）**`) : '';
    const effect = o.effect ? ` → ${md(clip(oneLine(o.effect), OPTION_TEXT_CHARS))}` : '';
    return `- **${md(o.key)}** ${md(clip(oneLine(o.label), OPTION_TEXT_CHARS))}${effect}${rec}`;
  });
  if (optionLines.length) top.push(optionLines.join('\n'));
  if (item.recommend && item.recommendReason) {
    top.push(`<font color='grey'>${L.reason}：${md(clip(oneLine(item.recommendReason), OPTION_TEXT_CHARS))}</font>`);
  }
  const elements: unknown[] = [];
  if (top.length) elements.push({ tag: 'markdown', content: top.join('\n') });
  if (input.status) elements.push({ tag: 'markdown', content: statusLine(input.status, input.locale) });
  const value = (action: string, key: string) => ({
    action, app: input.appId, seq: String(item.seq), ask, key,
    // 卡片回调的兜底去重键会看 card_nonce：带上事项和指纹，快速连点两个不同选项不会被当成同一次。
    card_nonce: `${item.seq}:${ask}:${key || '-'}`,
  });
  const formElements: unknown[] = [
    {
      tag: 'input', name: DECISION_CARD_NOTE_FIELD, input_type: 'multiline_text', width: 'fill', required: false,
      max_length: NOTE_MAX_CHARS, placeholder: { tag: 'plain_text', content: L.notePlaceholder },
    },
    ...item.options.map(o => ({
      tag: 'button',
      name: `board_pick_${o.key}`,
      text: { tag: 'plain_text', content: clip(oneLine(`${o.key} · ${o.label}${o.key === item.recommend ? (loc === 'en' ? ' (recommended)' : '（推荐）') : ''}`), BUTTON_LABEL_CHARS) },
      type: o.key === item.recommend ? 'primary' : 'default',
      width: 'fill',
      form_action_type: 'submit',
      behaviors: [{ type: 'callback', value: value(DECISION_CARD_ACTION_PICK, o.key) }],
    })),
    {
      tag: 'button',
      name: 'board_note_only',
      text: { tag: 'plain_text', content: L.noteOnly },
      type: 'default',
      width: 'fill',
      form_action_type: 'submit',
      behaviors: [{ type: 'callback', value: value(DECISION_CARD_ACTION_NOTE, '') }],
    },
  ];
  elements.push({ tag: 'form', name: `board_form_${item.seq}`, elements: formElements });
  const btn = linkButton(input.links, input.locale);
  if (btn) elements.push(btn);
  else elements.push({ tag: 'markdown', content: L.noLink(item.seq) });
  elements.push({ tag: 'markdown', content: `<font color='grey'>${L.footer}</font>` });
  return shell(`${L.decide} · #${item.seq} ${clip(oneLine(item.title), 80)}`, 'orange', elements);
}

/** 由看板数据渲染一项的拍板卡片（纯函数）。 */
export function buildDecisionCard(input: DecisionCardInput): Record<string, unknown> {
  const L = TEXT[input.locale === 'en' ? 'en' : 'zh'];
  if (input.retired) return linkOnlyCard(input, 'grey', L[input.retired]);
  const mode = cardMode(input.item);
  const stateLabel = BOARD_STATE_LABELS[input.locale === 'en' ? 'en' : 'zh'][input.item.state];
  if (mode === 'ended') return linkOnlyCard(input, 'grey', L.notDeciding(stateLabel));
  if (mode === 'not_deciding') return linkOnlyCard(input, 'blue', L.notDeciding(stateLabel));
  if (mode === 'too_many') return linkOnlyCard(input, 'orange', L.tooMany(input.item.options.length));
  const card = openCard(input);
  if (Buffer.byteLength(JSON.stringify(card)) > DECISION_CARD_MAX_BYTES) return linkOnlyCard(input, 'orange', L.tooBig);
  return card;
}

/** 卡片内容指纹：没变就不 PATCH。 */
export function decisionCardHash(card: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify(card)).digest('hex').slice(0, 16);
}

// ─── 发卡与原地更新 ─────────────────────────────────────────────────────────

export interface DecisionCardDeps {
  store(): DecisionBoardStore;
  appId(): string;
  locale(): Locale;
  steward(): StewardConfig | undefined;
  links(seq: number): { url?: string; appLink?: string };
  /** 管家 bot 有没有能认出来的 owner：没有时谁点都会被拒，就不发新卡（与「拉新群带管家」同口径）。 */
  hasOwner(): boolean;
  /** 发到管家群，返回消息 id。uuid 是飞书的发送去重键（1 小时内同一个只发一条）。 */
  sendCard(chatId: string, cardJson: string, uuid: string): Promise<string>;
  updateCard(messageId: string, cardJson: string): Promise<void>;
  /** 卡片已经改不了（撤回、超过编辑期限）：这时才另发一张新卡顶替。 */
  isCardGone(error: unknown): boolean;
  log(level: 'info' | 'warn', message: string): void;
  /** 测试用：失败后重试的等待（毫秒）。 */
  retryDelays?: readonly number[];
}

/** 发卡 / 更新失败（且卡片没失效）后的重试间隔；用完就等下次写入或 daemon 重启时的对账。 */
const RETRY_DELAYS_MS = [30_000, 120_000, 600_000];

export class DecisionCards {
  private readonly chains = new Map<number, Promise<void>>();
  private readonly retries = new Map<number, { attempt: number; timer: ReturnType<typeof setTimeout> }>();

  constructor(private readonly deps: DecisionCardDeps) {}

  enabled(): boolean {
    return stewardDecisionCardsOn(this.deps.steward());
  }

  /** 这一项此刻该显示的卡片；事项不存在返回 undefined。开关关着时给只有链接的版本。 */
  render(seq: number, retired?: DecisionCardInput['retired']): { card: Record<string, unknown>; hash: string } | undefined {
    const store = this.deps.store();
    const app = this.deps.appId();
    const item = store.getItem(app, seq);
    if (!item) return undefined;
    const effectiveRetired = retired ?? (this.enabled() ? undefined : 'disabled' as const);
    const explainers = store.explainerCounts(app).get(seq);
    const card = buildDecisionCard({
      appId: app, locale: this.deps.locale(), item, links: this.deps.links(seq), status: this.status(item),
      ...(explainers ? { explainers } : {}),
      ...(effectiveRetired ? { retired: effectiveRetired } : {}),
    });
    return { card, hash: decisionCardHash(card) };
  }

  /**
   * 最近一次决定：只看进入当前状态之后提交的（事项重新进入待拍板时，上一轮的「已选 X」不再显示）；
   * 已不在待拍板的卡片照样显示最后一次决定，让人知道结果。
   */
  private status(item: BoardItem): CardDecisionStatus | undefined {
    const store = this.deps.store();
    const app = this.deps.appId();
    const decision = store.latestDecision(app, item.seq);
    if (!decision) return undefined;
    const batch = store.getBatch(app, decision.batchId);
    if (!batch) return undefined;
    if (item.state === 'decide' && batch.createdAt < item.stateAt) return undefined;
    const sourceOf = (id: number): 'web' | 'card' => (store.getBatch(app, id)?.source === 'card' ? 'card' : 'web');
    const option = item.options.find(o => o.key === decision.choice);
    // 没记指纹的旧决定按「没改过」处理（与之前的显示一致）。
    const optionsChanged = !!decision.askKey && decision.askKey !== decisionAskKey(item);
    return {
      decision,
      batch,
      ...(option && !optionsChanged ? { choiceLabel: option.label } : {}),
      ...(optionsChanged ? { optionsChanged: true } : {}),
      supersedes: store.supersededBy(app, decision.batchId, item.seq).map(id => ({ id, source: sourceOf(id) })),
      ...(decision.supersededBy !== undefined ? { supersededBy: { id: decision.supersededBy, source: sourceOf(decision.supersededBy) } } : {}),
    };
  }

  /** 卡片回调已经把这张卡换成了 hash 对应的内容：记下来，后面的同步据此判断要不要 PATCH。 */
  noteRendered(seq: number, messageId: string, hash: string): void {
    const rec = this.deps.store().getCard(this.deps.appId(), seq);
    if (rec && rec.messageId === messageId) this.deps.store().putCard(this.deps.appId(), { ...rec, hash });
  }

  /** 这张卡片是不是这一项当前那张（不是被顶替的旧卡、也不是别的群里的那张）。 */
  isCurrentCard(seq: number, messageId: string): boolean {
    const rec = this.deps.store().getCard(this.deps.appId(), seq);
    return !rec || !rec.messageId || rec.messageId === messageId;
  }

  /** daemon 起来后对一遍：补发上次没发出去的卡，刷新内容过期的卡。 */
  async reconcile(): Promise<void> {
    let records: BoardCardRecord[];
    try {
      records = this.deps.store().listCards(this.deps.appId());
    } catch (error) {
      this.deps.log('warn', `[decision-board] card reconcile skipped: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    for (const rec of records) await this.sync(rec.seq, { create: false });
  }

  /** 停掉还没到点的重试（关停 / 测试用）。 */
  stop(): void {
    for (const r of this.retries.values()) clearTimeout(r.timer);
    this.retries.clear();
  }

  private scheduleRetry(seq: number): void {
    const delays = this.deps.retryDelays ?? RETRY_DELAYS_MS;
    const prev = this.retries.get(seq);
    const attempt = prev ? prev.attempt + 1 : 0;
    if (prev) clearTimeout(prev.timer);
    if (attempt >= delays.length) { this.retries.delete(seq); return; }
    const timer = setTimeout(() => { void this.sync(seq, { create: false }, attempt); }, delays[attempt]);
    (timer as { unref?: () => void }).unref?.();
    this.retries.set(seq, { attempt, timer });
  }

  /**
   * 把这一项的卡片对齐到当前数据。同一项串行执行（连续 set 不会发出两张卡）。
   *   - 还没有卡：只在 create=true（刚进入待拍板 / 改了选项）且事项在待拍板时发新卡；
   *   - 已有卡：内容变了就原地更新；卡已失效（撤回 / 过期）且仍在待拍板时另发一张顶替。
   * 发卡失败只记日志：看板写入不因为卡片失败而失败。
   */
  sync(seq: number, opts: { create: boolean }, retryAttempt?: number): Promise<void> {
    const prev = this.chains.get(seq) ?? Promise.resolve();
    const run = prev.then(async () => {
      // 新的一次同步接管：之前排着的重试作废（重试本身进来时保留计数）。
      const pending = this.retries.get(seq);
      if (pending && pending.attempt !== retryAttempt) { clearTimeout(pending.timer); this.retries.delete(seq); }
      await this.syncOnce(seq, opts);
      if (this.retries.get(seq)?.attempt === retryAttempt) this.retries.delete(seq);
    }).catch(error => {
      this.deps.log('warn', `[decision-board] card sync for #${seq} failed: ${error instanceof Error ? error.message : String(error)}`);
      this.scheduleRetry(seq);
    });
    this.chains.set(seq, run);
    void run.finally(() => { if (this.chains.get(seq) === run) this.chains.delete(seq); });
    return run;
  }

  /** 等所有进行中的同步结束（测试与关停用）。 */
  async idle(): Promise<void> {
    while (this.chains.size) await Promise.all([...this.chains.values()]);
  }

  private async syncOnce(seq: number, opts: { create: boolean }): Promise<void> {
    const steward = this.deps.steward();
    const store = this.deps.store();
    const app = this.deps.appId();
    const item = store.getItem(app, seq);
    if (!item) return;
    const rec = store.getCard(app, seq);
    const on = stewardDecisionCardsOn(steward);
    if (!on) {
      // 关了开关（或管家）：不发新卡；已经发出去的卡改成只有链接，免得留着点不动的按钮。
      if (rec?.messageId) await this.patch(rec, this.render(seq, 'disabled'));
      return;
    }
    const wantsNew = opts.create && item.state === 'decide' && this.deps.hasOwner();
    if (!rec) {
      if (wantsNew) await this.post(seq, steward.chatId);
      return;
    }
    // 发卡前落的占位：上次没发出去（失败 / 进程死在中间），仍在待拍板就补发，否则丢掉。
    if (!rec.messageId) {
      // owner 暂时认不出来（启动时还没解析完、或解析瞬断）只是先不发，占位留着等下次同步；
      // 不在待拍板了才丢掉占位。
      if (item.state !== 'decide') store.deleteCard(app, seq);
      else if (this.deps.hasOwner()) await this.post(seq, steward.chatId, rec);
      return;
    }
    // 管家群换过：重新进入待拍板时在新群发，旧群那张收成「已移到新群」。
    if (rec.chatId !== steward.chatId) {
      if (!wantsNew) return;
      await this.patch(rec, this.render(seq, 'moved')).catch(() => undefined);
      await this.post(seq, steward.chatId);
      return;
    }
    const rendered = this.render(seq);
    if (!rendered || rendered.hash === rec.hash) return;
    try {
      await this.patch(rec, rendered);
    } catch (error) {
      if (!this.deps.isCardGone(error)) throw error;
      if (item.state !== 'decide') return;
      this.deps.log('info', `[decision-board] card for #${seq} (${rec.messageId}) is gone; posting a new one`);
      await this.post(seq, steward.chatId);
    }
  }

  private async patch(rec: BoardCardRecord, rendered: { card: Record<string, unknown>; hash: string } | undefined): Promise<void> {
    if (!rendered || rendered.hash === rec.hash) return;
    await this.deps.updateCard(rec.messageId, JSON.stringify(rendered.card));
    this.deps.store().putCard(this.deps.appId(), { ...rec, hash: rendered.hash });
  }

  /**
   * 发新卡：先落一行占位（messageId 为空）再发，发成功再写上消息 id。进程死在中间或发送失败时，
   * 占位留着，下次同步 / 启动对账补发；补发沿用同一个飞书去重键，上次其实已经发出去时不会出第二张。
   */
  private async post(seq: number, chatId: string, placeholder?: BoardCardRecord): Promise<void> {
    const store = this.deps.store();
    const app = this.deps.appId();
    const rendered = this.render(seq);
    if (!rendered) return;
    let slot = placeholder;
    if (!slot || slot.chatId !== chatId) {
      store.putCard(app, { seq, chatId, messageId: '', hash: '' });
      slot = store.getCard(app, seq)!;
    }
    const uuid = createHash('sha256').update(`${app}:${seq}:${chatId}:${slot.createdAt}`).digest('hex').slice(0, 40);
    const messageId = await this.deps.sendCard(chatId, JSON.stringify(rendered.card), uuid);
    store.putCard(app, { seq, chatId, messageId, hash: rendered.hash });
    this.deps.log('info', `[decision-board] posted decision card for #${seq} in ${chatId} (${messageId})`);
  }
}

/** 说明框里的文字（form_value 里取；没有就空串）。 */
export function cardNoteText(formValue: unknown): string {
  if (!formValue || typeof formValue !== 'object') return '';
  const raw = (formValue as Record<string, unknown>)[DECISION_CARD_NOTE_FIELD];
  return typeof raw === 'string' ? raw.replace(/\r\n/g, '\n').trim().slice(0, NOTE_MAX_CHARS) : '';
}
