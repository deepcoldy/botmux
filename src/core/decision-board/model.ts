/**
 * 决策看板（管家 bot 名下的 owner 拍板队列）的纯模型：类型、取值校验、关联链接、
 * 批次消息与管家规则文本。不碰磁盘、不碰网络，daemon / CLI / Dashboard 共用。
 *
 * 设计见 docs/design/2026-10-24-decision-board-steward.md。要点：
 *   - 一个管家 bot 一张看板（按 app_id 分区），只有它的 daemon 写；
 *   - owner 在 Dashboard 写草稿，点一次「提交」= 一个批次 = 管家会话里的一个回合；
 *   - 状态只有 6 个，用于分组；各人的流程词（在审 / 可合 …）写在自由文本 stage 里。
 */
import type { Locale } from '../../i18n/types.js';
import { chatAppLink, larkHosts, type Brand } from '../../im/lark/lark-hosts.js';

export const BOARD_STATES = ['decide', 'accept', 'active', 'waiting', 'done', 'closed'] as const;
export type BoardState = typeof BOARD_STATES[number];

export const BOARD_VIEWS = ['decide', 'active', 'all'] as const;
export type BoardView = typeof BOARD_VIEWS[number];

/** 汇总页三个视图：待你拍板 = decide + accept；进行中 = active + waiting；全部。 */
export function stateInView(state: BoardState, view: BoardView): boolean {
  if (view === 'all') return true;
  if (view === 'decide') return state === 'decide' || state === 'accept';
  return state === 'active' || state === 'waiting';
}

export function isBoardState(value: unknown): value is BoardState {
  return typeof value === 'string' && (BOARD_STATES as readonly string[]).includes(value);
}

export function isBoardView(value: unknown): value is BoardView {
  return typeof value === 'string' && (BOARD_VIEWS as readonly string[]).includes(value);
}

export const BOARD_STATE_LABELS: Record<Locale, Record<BoardState, string>> = {
  zh: { decide: '待拍板', accept: '待验收', active: '进行中', waiting: '等待中', done: '已完成', closed: '已关闭' },
  en: { decide: 'Needs decision', accept: 'Needs review', active: 'In progress', waiting: 'Waiting', done: 'Done', closed: 'Closed' },
};

export const LINK_KINDS = ['pr', 'issue', 'chat', 'thread', 'session', 'commit', 'doc', 'url'] as const;
export type BoardLinkKind = typeof LINK_KINDS[number];

export interface BoardOption {
  key: string;
  label: string;
  effect?: string;
}

export interface BoardLink {
  kind: BoardLinkKind;
  ref: string;
  label?: string;
}

export type BoardActor = 'steward' | 'owner' | 'system';
export type BoardEventKind = 'create' | 'note' | 'state' | 'edit' | 'decision' | 'reply' | 'attach' | 'link';

export interface BoardItem {
  seq: number;
  key?: string;
  title: string;
  state: BoardState;
  stage?: string;
  kind?: string;
  repo?: string;
  summary?: string;
  progress?: string;
  question?: string;
  options: BoardOption[];
  recommend?: string;
  recommendReason?: string;
  rev: number;
  createdAt: number;
  updatedAt: number;
  stateAt: number;
  stewardEventAt?: number;
  ownerSeenAt?: number;
}

export interface BoardEvent {
  id: number;
  seq: number;
  at: number;
  actor: BoardActor;
  actorRef?: string;
  kind: BoardEventKind;
  text: string;
  fileIds: string[];
  batchId?: number;
}

export interface BoardFile {
  id: string;
  seq?: number;
  sha256: string;
  mime: string;
  bytes: number;
  name: string;
  by: 'owner' | 'steward';
  createdAt: number;
}

export interface BoardDraft {
  seq: number;
  author: string;
  choice?: string;
  text: string;
  fileIds: string[];
  baseRev: number;
  updatedAt: number;
}

export type BatchDelivery = 'pending' | 'dispatched' | 'delivered' | 'failed';

export interface BoardBatch {
  id: number;
  author: string;
  authorName?: string;
  createdAt: number;
  delivery: BatchDelivery;
  attempts: number;
  sessionId?: string;
  turnId?: string;
  deliveredAt?: number;
  error?: string;
}

export interface BoardDecision {
  batchId: number;
  seq: number;
  choice?: string;
  text: string;
  fileIds: string[];
  itemRev: number;
  handledAt?: number;
}

// ─── 字段上限 ───────────────────────────────────────────────────────────────
// 看板是给人读的台账，不是日志仓库：单项正文按「一屏读完」取上限，超了直接拒绝，
// 让管家改写得更短，而不是静默截断（截断会丢掉末尾的结论）。
export const BOARD_LIMITS = {
  title: 200,
  shortText: 200,
  longText: 20_000,
  note: 4_000,
  optionCount: 8,
  optionLabel: 500,
  linksPerItem: 32,
  filesPerDraft: 8,
  ref: 300,
} as const;

/** 事项引用：`12`、`#12`，或 add 时给的 key。返回 seq 或 key。 */
export function parseItemRef(raw: unknown): { seq: number } | { key: string } | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (!value) return null;
  const m = /^#?(\d{1,9})$/.exec(value);
  if (m) return { seq: Number(m[1]) };
  if (value.length > BOARD_LIMITS.ref) return null;
  return { key: value };
}

/**
 * `--option "A=做法 → 结果"`：`=` 前是选项键（1–8 个字母数字），后面是说明；说明里
 * 第一个 `→`（或 `->`）之后是结果和风险。
 */
export function parseOptionSpec(raw: string): BoardOption | { error: string } {
  const eq = raw.indexOf('=');
  if (eq <= 0) return { error: `选项格式应为 "A=做法 → 结果"：${raw}` };
  const key = raw.slice(0, eq).trim();
  if (!/^[A-Za-z0-9]{1,8}$/.test(key)) return { error: `选项键只能是 1–8 个字母或数字：${key}` };
  const body = raw.slice(eq + 1).trim();
  if (!body) return { error: `选项 ${key} 缺少说明` };
  const arrow = /\s*(?:→|->)\s*/.exec(body);
  const label = (arrow ? body.slice(0, arrow.index) : body).trim();
  const effect = arrow ? body.slice(arrow.index + arrow[0].length).trim() : '';
  if (!label) return { error: `选项 ${key} 缺少做法` };
  if (label.length + effect.length > BOARD_LIMITS.optionLabel) return { error: `选项 ${key} 太长（上限 ${BOARD_LIMITS.optionLabel} 字）` };
  return { key: key.toUpperCase(), label, ...(effect ? { effect } : {}) };
}

const LINK_REF_PATTERNS: Record<BoardLinkKind, RegExp> = {
  pr: /^[\w.-]+\/[\w.-]+#\d+$/,
  issue: /^[\w.-]+\/[\w.-]+#\d+$/,
  commit: /^[\w.-]+\/[\w.-]+@[0-9a-f]{7,40}$/i,
  chat: /^oc_[A-Za-z0-9_-]{1,128}$/,
  thread: /^oc_[A-Za-z0-9_-]{1,128}\/omt_[A-Za-z0-9_-]{1,128}$/,
  session: /^[A-Za-z0-9-]{8,64}$/,
  doc: /^https?:\/\/\S+$/,
  url: /^https?:\/\/\S+$/,
};

function splitLinkKind(raw: string): { kind: BoardLinkKind; rest: string } | { error: string } {
  const eq = raw.indexOf('=');
  if (eq <= 0) return { error: `关联格式应为 kind=ref：${raw}` };
  const kind = raw.slice(0, eq).trim() as BoardLinkKind;
  if (!(LINK_KINDS as readonly string[]).includes(kind)) {
    return { error: `不认识的关联类型 ${kind}（可用：${LINK_KINDS.join(' / ')}）` };
  }
  return { kind, rest: raw.slice(eq + 1).trim() };
}

/**
 * `--link pr=owner/repo#12`、`chat=oc_x`、`thread=oc_x/omt_y`、`session=<id>`、
 * `commit=owner/repo@sha`、`doc=https://…`、`url=https://…`。可选 `|标签` 后缀：
 * 最后一个 `|` 之后是标签，所有类型同一条规则（网址里本身的 `|` 要写成 `%7C`）。
 */
export function parseLinkSpec(raw: string): BoardLink | { error: string } {
  const split = splitLinkKind(raw);
  if ('error' in split) return split;
  const { kind } = split;
  let rest = split.rest;
  let label: string | undefined;
  const bar = rest.lastIndexOf('|');
  if (bar > 0) {
    label = rest.slice(bar + 1).trim() || undefined;
    rest = rest.slice(0, bar).trim();
  }
  if (!rest || rest.length > BOARD_LIMITS.ref || !LINK_REF_PATTERNS[kind].test(rest)) {
    return { error: `关联 ${kind} 的格式不对：${rest || '(空)'}` };
  }
  if (label && label.length > BOARD_LIMITS.shortText) return { error: '关联标签太长' };
  return { kind, ref: rest, ...(label ? { label } : {}) };
}

/** `--unlink kind=ref` 要删的关联：先按原文精确匹配，没有再按去掉 `|标签` 后的 ref 匹配。 */
export interface BoardUnlink {
  kind: BoardLinkKind;
  /** `kind=` 之后的原文。也用来删修复前存进去的、ref 里带着 `|标签` 的旧关联。 */
  raw: string;
  /** 去掉 `|标签` 后的 ref；与 raw 相同时省略。 */
  ref?: string;
}

/** 删除只认已存在的关联，不按类型校验 ref 格式（格式不对的旧关联也要删得掉）。 */
export function parseUnlinkSpec(raw: string): BoardUnlink | { error: string } {
  const split = splitLinkKind(raw);
  if ('error' in split) return split;
  const { kind, rest } = split;
  if (!rest || rest.length > BOARD_LIMITS.ref) return { error: `要删的关联 ${kind} 格式不对：${rest || '(空)'}` };
  const bar = rest.lastIndexOf('|');
  const ref = bar > 0 ? rest.slice(0, bar).trim() : rest;
  return { kind, raw: rest, ...(ref && ref !== rest ? { ref } : {}) };
}

export interface LinkRenderContext {
  brand: Brand;
  /** Dashboard 对外基址（不含尾斜杠）；没有时 session 链接不渲染。 */
  dashboardBase?: string;
}

/** 关联对象 → 可点击 URL。pr / issue / commit 只拼 GitHub 地址，不调 GitHub API。 */
export function linkUrl(link: BoardLink, ctx: LinkRenderContext): string | undefined {
  switch (link.kind) {
    case 'pr':
    case 'issue': {
      const [repo, num] = link.ref.split('#');
      return `https://github.com/${repo}/${link.kind === 'pr' ? 'pull' : 'issues'}/${num}`;
    }
    case 'commit': {
      const [repo, sha] = link.ref.split('@');
      return `https://github.com/${repo}/commit/${sha}`;
    }
    case 'chat':
      return chatAppLink(link.ref, ctx.brand);
    case 'thread': {
      const [chatId, threadId] = link.ref.split('/');
      const host = larkHosts(ctx.brand).applink;
      const chat = encodeURIComponent(chatId);
      const thread = encodeURIComponent(threadId);
      return `https://${host}/client/thread/open?open_chat_id=${chat}&open_thread_id=${thread}&openchatid=${chat}&openthreadid=${thread}&thread_position=-1`;
    }
    case 'session':
      return ctx.dashboardBase ? `${ctx.dashboardBase}/#/sessions?session=${encodeURIComponent(link.ref)}` : undefined;
    case 'doc':
    case 'url':
      return link.ref;
  }
}

export function linkDefaultLabel(link: BoardLink): string {
  switch (link.kind) {
    case 'pr': return `PR ${link.ref.slice(link.ref.indexOf('#'))}`;
    case 'issue': return `issue ${link.ref.slice(link.ref.indexOf('#'))}`;
    case 'commit': return link.ref.slice(link.ref.indexOf('@') + 1, link.ref.indexOf('@') + 8);
    case 'chat': return 'chat';
    case 'thread': return 'thread';
    case 'session': return `session ${link.ref.slice(0, 8)}`;
    case 'doc':
    case 'url': {
      try { return new URL(link.ref).host; } catch { return link.ref.slice(0, 40); }
    }
  }
}

/** 单项详情页的路径入口；Dashboard 收到后 302 到 `/#/board/<app>/<seq>`。 */
export function boardItemPath(larkAppId: string, seq: number): string {
  return `/board/${encodeURIComponent(larkAppId)}/${seq}`;
}

export function boardItemHash(larkAppId: string, seq: number): string {
  return `#/board/${encodeURIComponent(larkAppId)}/${seq}`;
}

/**
 * 飞书里点开就在会话右侧栏打开（PC）。手机端不认 mode，按钮的 multi_url 里给原链接；
 * 纯文本消息里只能放一个链接，用这个 AppLink（手机上同样能在客户端内打开）。
 */
export function sidebarAppLink(targetUrl: string, brand: Brand): string {
  const qs = new URLSearchParams({
    mode: 'sidebar-semi',
    min_width: '350',
    width: '800',
    max_width: '1200',
    reload: 'false',
    url: targetUrl,
  });
  return `https://${larkHosts(brand).applink}/client/web_url/open?${qs.toString()}`;
}

// ─── 管家配置（bots.json `steward`）──────────────────────────────────────────

export type StewardGuideMode = 'append' | 'replace';

export interface StewardConfig {
  enabled: boolean;
  /** 管家所在群：owner 在这里交代任务，批次也送进这个群的 chat 级会话。 */
  chatId?: string;
  guideMode?: StewardGuideMode;
  guideText?: string;
  /**
   * botmux 拉新群时，新群里有管家的 owner 就把管家一起拉进去（管家只是进群，不发言、不开会话），
   * 让它之后能用自己的 bot 身份在群里推进。默认开，只在关掉时写 `false`。
   */
  autoJoinNewGroups?: boolean;
  /**
   * 只有一个人和一个 bot 的新群（私聊转出的会话群、私聊里 /group、/fork --create 建的群等）也带上
   * 管家。默认关：带上后群里有两个 bot，原 bot 不再按单人单 bot 免 @ 续话。只在打开时写 `true`。
   */
  autoJoinSoloGroups?: boolean;
}

export const STEWARD_GUIDE_TEXT_MAX = 20_000;

/**
 * bots.json / Dashboard 写入的统一校验。等于默认（关、无群、无自定义、拉群带管家）时返回 null，
 * 调用方据此删除字段——等于默认值不写盘。
 */
export function normalizeStewardConfig(raw: unknown):
  | { ok: true; value: StewardConfig | null }
  | { ok: false; reason: string } {
  if (raw === null || raw === undefined) return { ok: true, value: null };
  if (typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, reason: 'steward 必须是对象' };
  const r = raw as Record<string, unknown>;
  const known = new Set(['enabled', 'chatId', 'guideMode', 'guideText', 'autoJoinNewGroups', 'autoJoinSoloGroups']);
  const unknown = Object.keys(r).filter(k => !known.has(k));
  if (unknown.length) return { ok: false, reason: `steward 有未知字段：${unknown.join(', ')}` };
  if (r.enabled !== undefined && typeof r.enabled !== 'boolean') return { ok: false, reason: 'steward.enabled 必须是布尔值' };
  if (r.autoJoinNewGroups !== undefined && r.autoJoinNewGroups !== null && typeof r.autoJoinNewGroups !== 'boolean') {
    return { ok: false, reason: 'steward.autoJoinNewGroups 必须是布尔值' };
  }
  if (r.autoJoinSoloGroups !== undefined && r.autoJoinSoloGroups !== null && typeof r.autoJoinSoloGroups !== 'boolean') {
    return { ok: false, reason: 'steward.autoJoinSoloGroups 必须是布尔值' };
  }
  let chatId: string | undefined;
  if (r.chatId !== undefined && r.chatId !== null && r.chatId !== '') {
    if (typeof r.chatId !== 'string' || !/^oc_[A-Za-z0-9_-]{1,128}$/.test(r.chatId)) {
      return { ok: false, reason: 'steward.chatId 必须是 oc_ 开头的群 ID' };
    }
    chatId = r.chatId;
  }
  let guideMode: StewardGuideMode | undefined;
  if (r.guideMode !== undefined && r.guideMode !== null) {
    if (r.guideMode !== 'append' && r.guideMode !== 'replace') return { ok: false, reason: 'steward.guideMode 只能是 append 或 replace' };
    guideMode = r.guideMode;
  }
  let guideText: string | undefined;
  if (r.guideText !== undefined && r.guideText !== null) {
    if (typeof r.guideText !== 'string') return { ok: false, reason: 'steward.guideText 必须是字符串' };
    const trimmed = r.guideText.replace(/\r\n/g, '\n').trim();
    if (trimmed.length > STEWARD_GUIDE_TEXT_MAX) return { ok: false, reason: `自定义提示词太长（上限 ${STEWARD_GUIDE_TEXT_MAX} 字）` };
    if (trimmed) guideText = trimmed;
  }
  const enabled = r.enabled === true;
  // 替换模式没有自定义正文等于没有规则：拒绝，而不是悄悄退回预置。
  if (guideMode === 'replace' && !guideText) return { ok: false, reason: '选了「替换预置」就要填写自定义提示词' };
  const value: StewardConfig = {
    enabled,
    ...(chatId ? { chatId } : {}),
    ...(guideMode && guideMode !== 'append' ? { guideMode } : {}),
    ...(guideText ? { guideText } : {}),
    ...(r.autoJoinNewGroups === false ? { autoJoinNewGroups: false } : {}),
    ...(r.autoJoinSoloGroups === true ? { autoJoinSoloGroups: true } : {}),
  };
  if (!value.enabled && !value.chatId && !value.guideMode && !value.guideText
    && value.autoJoinNewGroups !== false && value.autoJoinSoloGroups !== true) {
    return { ok: true, value: null };
  }
  return { ok: true, value };
}

/** 管家可用 = 开关开 + 选了管家群。只开开关没选群时，看板可读写，但批次无处投递。 */
export function stewardReady(cfg: StewardConfig | undefined): cfg is StewardConfig & { chatId: string } {
  return !!cfg?.enabled && !!cfg.chatId;
}

/**
 * 拉新群时要不要带上这个管家：管家开着、且没关「拉新群时带上管家」；只有一个人和一个 bot 的新群
 * 另外要打开 autoJoinSoloGroups。不要求选了管家群。
 */
export function stewardJoinsNewGroups(cfg: StewardConfig | undefined, chat: { soloGroup?: boolean } = {}): boolean {
  if (cfg?.enabled !== true || cfg.autoJoinNewGroups === false) return false;
  return chat.soloGroup ? cfg.autoJoinSoloGroups === true : true;
}

// ─── 管家规则（`botmux board guide`）────────────────────────────────────────
// 不常驻：管家群里只有一行提示（renderStewardHintBlock），正文按需由 guide 输出。
// 编进代码常量：编译版单文件二进制里没有 dist 目录，不能按 __dirname 读文件。

const GUIDE_PRESET_ZH = `你是 owner 的管家，帮 owner 推进他交代的开发任务。决策看板是你的台账：以看板为准，不靠对话记忆。

## 开工
- 每次开工先看 \`botmux board pending\`（owner 已提交、你还没标记执行的决定），再看 \`botmux board list\`。

## 接任务（owner 在管家群里交代事情时）
- 每件要跟的事建一项：\`botmux board add <标题> --key <去重键> --link pr=owner/repo#12 --link chat=oc_…\`。
  已经有的用 \`botmux board set\` 更新，不重复建。交代得不清楚的，先在群里问清楚。

## 推进
- 默认用你自己的 bot 身份到相关群发消息推进：\`botmux send --chat-id <群> --top-level --mention <open_id:名字> "…"\`。
  一条消息只 @ 一个 bot，@ 放在句首；对方正在工作就先不发，记进历史，下次再发；短时间内催过、对方没有新进展的，不重复催。
- 看现场：\`botmux history --session-id <会话> --scope chat\`，以及仓库自己的工具（如 gh）。
- 进展和卡点及时回写：\`botmux board set <编号> --state … --stage … --progress …\`，一句话用 \`--note\` 进历史。
- 按下方「推进标准」判断哪些事你能直接做。没写推进标准时只汇报和催办，不替 owner 合并、关闭、发版、部署、删除。

## 要 owner 拍板
- 不能自己定的、不可逆的、会推翻 owner 以前决定的事，写成待拍板：
  \`botmux board set <编号> --state decide --ask "要你定的问题" --option "A=做法 → 结果和风险" --option "B=…" --recommend A --reason "理由"\`。
  给两三个选项，写清后果和你的推荐。
- 写完在管家群里用 \`botmux send --attention=decision --mention-back "…"\` 说一声，附上 \`botmux board list\` 给出的链接。

## 执行一批决定（收到「决策看板 · 批次」消息时）
- 逐项处理：先 \`botmux board show <编号>\` 看最新内容，再按决定执行。
- 每项做完：\`botmux board history <编号> --handled "做了什么、结果"\`，需要时改状态。
- 决定看不懂，或者和现状冲突：不要猜，写 \`--handled "要你再确认：…"\`，并把状态设回 decide。
- 最后回一条汇总。

## 推进标准
（owner 没有写。只汇报和催办，不做不可逆操作。）`;

const GUIDE_PRESET_EN = `You are the owner's steward. You push forward the development tasks the owner hands you. The decision board is your ledger: trust the board, not conversation memory.

## Starting work
- Every time you start, check \`botmux board pending\` (decisions the owner submitted that you have not marked handled), then \`botmux board list\`.

## Taking a task (when the owner asks for something in the steward chat)
- Create one item per thing to track: \`botmux board add <title> --key <dedupe key> --link pr=owner/repo#12 --link chat=oc_…\`.
  Update existing items with \`botmux board set\` instead of creating duplicates. Ask in the chat first if the request is unclear.

## Pushing work forward
- By default, post as your own bot in the relevant chat: \`botmux send --chat-id <chat> --top-level --mention <open_id:name> "…"\`.
  Mention exactly one bot per message, at the start. If that bot is busy, do not post; note it in the history and retry later. Do not nag about the same thing again soon if nothing changed.
- Check the facts: \`botmux history --session-id <session> --scope chat\`, plus the repository's own tools (e.g. gh).
- Write progress and blockers back: \`botmux board set <n> --state … --stage … --progress …\`; add a one-line \`--note\` for the history.
- Use the "Standard" section below to decide what you may do on your own. Without a standard, only report and nudge; never merge, close, release, deploy or delete on the owner's behalf.

## Asking the owner to decide
- Anything you cannot decide, anything irreversible, or anything that would overturn an earlier owner decision becomes a decision item:
  \`botmux board set <n> --state decide --ask "question" --option "A=approach → outcome and risk" --option "B=…" --recommend A --reason "why"\`.
- Then tell the owner in the steward chat with \`botmux send --attention=decision --mention-back "…"\`, including the links from \`botmux board list\`.

## Executing a batch (when a "Decision board · batch" message arrives)
- Item by item: \`botmux board show <n>\` for the latest state, then act on the decision.
- After each one: \`botmux board history <n> --handled "what you did and the result"\`, and update the state if needed.
- If a decision is unclear or conflicts with reality, do not guess: \`--handled "Please confirm: …"\` and set the state back to decide.
- Finish with one summary reply.

## Standard
(The owner has not written one. Only report and nudge; take no irreversible action.)`;

const STANDARD_HEADING: Record<Locale, string> = { zh: '## 推进标准', en: '## Standard' };
const CUSTOM_HEADING: Record<Locale, string> = { zh: '## owner 的自定义规则（与上文冲突时以这里为准）', en: '## Owner custom rules (these win over anything above)' };

export function stewardGuidePreset(locale: Locale): string {
  return locale === 'en' ? GUIDE_PRESET_EN : GUIDE_PRESET_ZH;
}

/**
 * guide 输出 = 预置 +（追加 | 替换）。追加时去掉预置里「owner 没有写推进标准」那一节的
 * 占位正文，让自定义整段接在后面——通常自定义里写的就是推进标准。
 */
export function composeStewardGuide(cfg: StewardConfig | undefined, locale: Locale): string {
  const preset = stewardGuidePreset(locale);
  const custom = cfg?.guideText?.trim();
  if (!custom) return preset;
  if (cfg?.guideMode === 'replace') return custom;
  const cut = preset.lastIndexOf(STANDARD_HEADING[locale]);
  const head = (cut >= 0 ? preset.slice(0, cut) : preset).trimEnd();
  return `${head}\n\n${CUSTOM_HEADING[locale]}\n${custom}`;
}

/**
 * 管家群里唯一常驻的一行（照 `<project_group_mode>` 的做法：系统自带、只对指定群生效、
 * 与自定义角色并列）。只告诉它有看板、规则去哪读，正文不常驻。
 */
export function renderStewardHintBlock(chatId: string): string {
  const safeChat = chatId.replace(/[^A-Za-z0-9_-]/g, '');
  return `<botmux_steward chat_id="${safeChat}">You are the owner's steward in this chat and keep the decision board with \`botmux board\`. Before substantive work, run \`botmux board guide\` for the rules (built-in preset plus the owner's custom rules).</botmux_steward>`;
}

// ─── 批次消息 ───────────────────────────────────────────────────────────────

/**
 * 批次回合 id 的形状与解析：`board:<管家 appId>:<批次号>`，按批次稳定。
 * worker 的 ordinary-turn 投递协议（isOrdinaryImTurnId）认这个前缀；daemon 在
 * 投递失败回执里也靠它找回批次。appId 是 cli_ 形态、不含冒号。
 */
export function formatBoardTurnId(larkAppId: string, batchId: number): string {
  return `board:${larkAppId}:${batchId}`;
}

export function parseBoardTurnId(turnId: string): { appId: string; batchId: number } | null {
  const m = /^board:([^:]+):(\d{1,9})$/.exec(turnId);
  if (!m) return null;
  return { appId: m[1]!, batchId: Number(m[2]) };
}

export interface BatchMessageEntry {
  seq: number;
  title: string;
  state: BoardState;
  stage?: string;
  choice?: string;
  choiceLabel?: string;
  recommended?: boolean;
  text: string;
  fileCount: number;
}

export interface BatchMessageInput {
  batchId: number;
  authorName: string;
  createdAt: number;
  entries: BatchMessageEntry[];
  locale: Locale;
  /** 时间按这个时区渲染（与定时任务的显示时区一致）；缺省用进程时区。 */
  timeZone?: string;
}

function formatClock(ms: number, timeZone?: string): string {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(new Date(ms));
    const get = (type: string) => parts.find(p => p.type === type)?.value ?? '';
    return `${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`;
  } catch {
    return new Date(ms).toISOString().slice(5, 16).replace('T', ' ');
  }
}

/**
 * 送进管家会话的那一条消息。自带「先读 guide」的指引：零注入的管家看不到常驻提示，
 * 靠这条消息本身也能照规则执行。
 */
export function formatBatchMessage(input: BatchMessageInput): string {
  const zh = input.locale !== 'en';
  const when = formatClock(input.createdAt, input.timeZone);
  const lines: string[] = [];
  lines.push(zh
    ? `【决策看板 · 批次 #${input.batchId}】${input.authorName} ${when} 提交了 ${input.entries.length} 项决定。`
      + '按 `botmux board guide` 里「执行一批决定」一节逐项执行，每项做完运行 `botmux board history <编号> --handled "做了什么、结果"`。'
    : `[Decision board · batch #${input.batchId}] ${input.authorName} submitted ${input.entries.length} decision(s) at ${when}. `
      + 'Follow "Executing a batch" in `botmux board guide`; after each item run `botmux board history <n> --handled "what you did and the result"`.');
  for (const e of input.entries) {
    const stateLabel = BOARD_STATE_LABELS[zh ? 'zh' : 'en'][e.state];
    lines.push('');
    lines.push(`#${e.seq} ${e.title}（${stateLabel}${e.stage ? `·${e.stage}` : ''}）`);
    if (e.choice) {
      const tag = e.recommended ? (zh ? '（管家推荐）' : ' (recommended)') : '';
      lines.push(zh
        ? `  选：${e.choice}${e.choiceLabel ? ` ${e.choiceLabel}` : ''}${tag}`
        : `  Choice: ${e.choice}${e.choiceLabel ? ` ${e.choiceLabel}` : ''}${tag}`);
    } else {
      lines.push(zh ? '  选：未选' : '  Choice: none');
    }
    if (e.text.trim()) {
      const body = e.text.trim().split('\n').join('\n    ');
      lines.push(zh ? `  说明：${body}` : `  Note: ${body}`);
    }
    if (e.fileCount > 0) {
      lines.push(zh ? `  附图：${e.fileCount} 张（已随消息附上）` : `  Images: ${e.fileCount} (attached)`);
    }
  }
  return lines.join('\n');
}
