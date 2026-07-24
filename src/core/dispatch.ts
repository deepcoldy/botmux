/**
 * Phase 0 keystone — `botmux dispatch` pure core.
 *
 * The orchestrator (主 bot) splits a big project into sub-projects and assigns
 * each to a small group of bots (often a coder + a reviewer). To open a
 * sub-project it seeds a fresh Lark thread and @-mentions the assigned bots so
 * each spawns its own thread-scoped session (botmux's existing one-thread-one-
 * session routing; bot→bot @ inside a thread is ungated — see
 * event-dispatcher.ts decideRouting + the chat-scope-only foreign-bot gate).
 *
 * This module is the pure, I/O-free core: parse the `--bot` specs and build the
 * two messages (a top-level seed = the thread root, and the threaded kickoff
 * that @-mentions the bots with their roles + the brief). The CLI shell
 * (cli.ts) performs the actual sendMessage + replyMessage.
 */

export { resolveSendTarget } from './reply-target.js';

export interface DispatchBot {
  /** open_id as seen by the orchestrator's app (from <available_bots>). */
  openId: string;
  /** Display name, for readable @ rendering / division-of-labor lines. */
  name?: string;
  /** Short role label, e.g. "coder" / "reviewer". */
  role?: string;
}

export type PostNode = { tag: 'text'; text: string } | { tag: 'at'; user_id: string };
export type PostParagraph = PostNode[];

export interface DispatchMessages {
  /** Plain-text seed (the thread root) — the human-visible "this sub-project exists" header. */
  seedText: string;
  /** Lark 'post' content (paragraphs of nodes) for the threaded kickoff. */
  threadContent: PostParagraph[];
  /** open_ids @-mentioned in the kickoff — the bots that will be triggered. */
  mentionedOpenIds: string[];
}

const DISPATCH_ROOT_ID_RE = /^om_[A-Za-z0-9_-]{1,128}$/;

/** Compatibility protocol for legacy/cross-machine `--bot` dispatches. */
export function appendLegacyDispatchReportProtocol(brief: string): string {
  return brief.trimEnd()
    + '\n\n— 完成回报 —\n'
    + '干完后在本话题运行 `botmux report "子项目完成 + 产出位置/摘要"` '
    + '把结果回报给主编排会话；不要在本话题 @ 主bot（那会另起一个没有上下文的新会话）。';
}

/**
 * Freeze the report destination into the exact dispatched turn.
 *
 * A regular-group resident can reuse one chat-scoped CLI session for several
 * dispatch topics. Session-level `currentReplyTarget` is therefore mutable and
 * cannot identify an older in-flight turn once a newer assignment arrives. The
 * kickoff itself is immutable, so embed the seed in the command the resident is
 * instructed to run; `botmux report` can then select the matching registry row
 * without guessing from the session's latest alias.
 */
export function appendDispatchReportProtocol(brief: string, dispatchRootId: string): string {
  const root = dispatchRootId.trim();
  if (!DISPATCH_ROOT_ID_RE.test(root)) throw new Error('dispatch report protocol requires a valid om_ root id');
  return brief.trimEnd()
    + '\n\n— 完成回报 —\n'
    + `干完后在本话题运行 \`botmux report --dispatch-root ${root} "子项目完成 + 产出位置/摘要"\` `
    + '把结果回报给原始主编排会话；不要在本话题 @ 主bot（那会另起一个没有上下文的新会话）。';
}

/**
 * Parse a `--bot` spec `openId[:name[:role]]` into a {@link DispatchBot}.
 * Mirrors the `--mention "open_id:Display Name"` convention, with an optional
 * trailing role segment.
 */
export function parseDispatchBotSpec(raw: string): DispatchBot {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error('empty --bot spec');
  const parts = trimmed.split(':');
  const openId = parts[0]?.trim();
  if (!openId) throw new Error(`invalid --bot spec: ${JSON.stringify(raw)}`);
  const bot: DispatchBot = { openId };
  const name = parts[1]?.trim();
  const role = parts[2]?.trim();
  if (name) bot.name = name;
  if (role) bot.role = role;
  return bot;
}

/**
 * Build the seed + threaded-kickoff messages for one sub-project dispatch.
 * Throws when there is no title or no bot to dispatch to.
 */
export function buildDispatchMessages(input: {
  title: string;
  brief: string;
  bots: DispatchBot[];
}): DispatchMessages {
  const title = input.title.trim();
  if (!title) throw new Error('dispatch requires a title');
  if (input.bots.length === 0) throw new Error('dispatch requires at least one bot');

  const seedText = `📋 子项目：${title}`;

  const content: PostParagraph[] = [];

  // Line 1: @ every assigned bot (role suffix inline) so each gets triggered.
  const atLine: PostNode[] = [];
  input.bots.forEach((b, i) => {
    if (i > 0) atLine.push({ tag: 'text', text: ' ' });
    atLine.push({ tag: 'at', user_id: b.openId });
    if (b.role) atLine.push({ tag: 'text', text: `（${b.role}）` });
  });
  content.push(atLine);

  content.push([{ tag: 'text', text: '' }]);

  // The brief, one paragraph per line.
  for (const line of input.brief.split('\n')) {
    content.push([{ tag: 'text', text: line }]);
  }

  // Division of labour, when any role was given.
  if (input.bots.some(b => b.role)) {
    content.push([{ tag: 'text', text: '' }]);
    content.push([{ tag: 'text', text: '分工：' }]);
    for (const b of input.bots) {
      const label = b.name || b.openId;
      content.push([{ tag: 'text', text: `· ${label}：${b.role ?? '执行'}` }]);
    }
  }

  return {
    seedText,
    threadContent: content,
    mentionedOpenIds: input.bots.map(b => b.openId),
  };
}

/**
 * Build the "repo prime" message: a `/repo <path>` command @-mentioning the
 * target bots, sent as a **plain text message** — exactly like a human typing
 * "@bot /repo <path>". Sent as the first message into a freshly-seeded thread,
 * it makes each sub-bot's daemon resolve the working dir and spawn its CLI
 * **idle** (no repo-selection card, no manual "直接开始" click) — i.e. standby.
 *
 * Why text (not a structured `post`): the receiving daemon parses a text
 * message's @ via `resolveMentions` (the same clean path a human @ goes
 * through), whereas a `post`'s at/text nodes go through `renderPostNode`, which
 * drops the `/repo` argument in the live event — see the dispatch debugging
 * notes. `/repo` is an existing botmux command, so this needs no receiving-side
 * change. The `<at>` tags come first so that, once the receiving daemon strips
 * leading mentions, it sees `/repo <path>` as the command.
 */
export function buildRepoPrimeText(input: {
  path: string;
  bots: DispatchBot[];
}): { text: string; mentionedOpenIds: string[] } {
  const path = input.path.trim();
  if (!path) throw new Error('repo prime requires a path');
  if (input.bots.length === 0) throw new Error('repo prime requires at least one bot');

  const ats = input.bots.map(b => `<at user_id="${b.openId}"></at>`).join(' ');
  return { text: `${ats} /repo ${path}`, mentionedOpenIds: input.bots.map(b => b.openId) };
}

/**
 * Build the report-back message a dispatched sub-bot sends to its orchestrator.
 *
 * In 多话题协作模式 a sub-bot must NOT @ the orchestrator in its own sub-topic —
 * that thread has no orchestrator session, so the orchestrator's daemon would
 * spawn a fresh, context-less one. Instead `botmux report` sends this content
 * **into the orchestrator's own thread** (recorded by `botmux dispatch`),
 * @-mentioning the orchestrator so its existing, context-rich session is the one
 * that wakes up. This is the pure content builder; cli.ts resolves the coords
 * and performs the reply.
 *
 * The @ stays on the first line so the mention renders next to the headline;
 * any further lines become their own paragraphs (Lark 'post' shape).
 */
export function buildReportContent(input: {
  orchOpenId: string;
  content: string;
}): PostParagraph[] {
  const openId = input.orchOpenId.trim();
  if (!openId) throw new Error('report requires the orchestrator open_id');
  const text = input.content.trim();
  if (!text) throw new Error('report requires content');

  const lines = text.split('\n');
  const paras: PostParagraph[] = [
    [{ tag: 'at', user_id: openId }, { tag: 'text', text: ' ' }, { tag: 'text', text: lines[0] }],
  ];
  for (let i = 1; i < lines.length; i++) {
    paras.push([{ tag: 'text', text: lines[i] }]);
  }
  return paras;
}

/**
 * Footgun guard for the orchestrator→sub-bot direction. A dispatched sub-bot's
 * session lives **inside its sub-topic**, so @-mentioning it from the main chat
 * (e.g. `botmux send --mention <sub-bot>`) doesn't reach that session — it
 * spawns a fresh, context-less one in the chat (the mirror of the report-back
 * problem). To talk to a sub-bot the orchestrator must send INTO its sub-topic
 * (`botmux dispatch --into <seed> --bot <sub-bot>`).
 *
 * Given the dispatch registry (seed → {orchChatId, bots}) and the set of seeds
 * whose sub-topic is still active, return the sub-topic seed to redirect to when
 * `mentionOpenId` is a sub-bot dispatched into an active topic of `chatId`;
 * otherwise null. Only fires for live topics so stale entries don't block sends.
 */
export function findSubBotTopic(input: {
  mentionOpenId: string;
  chatId: string;
  registry: Record<string, { orchChatId?: string; bots?: string[] }>;
  activeSeeds: Set<string>;
}): string | null {
  // Newest-first: a bot dispatched into several topics over time is, right now,
  // working in the most-recent one — point there, not at a stale earlier topic.
  for (const [seed, entry] of Object.entries(input.registry).reverse()) {
    if (entry.orchChatId && entry.orchChatId !== input.chatId) continue;
    if (!input.activeSeeds.has(seed)) continue;
    if ((entry.bots ?? []).includes(input.mentionOpenId)) return seed;
  }
  return null;
}

/**
 * Resolve where a `botmux report` should go + who to @, so report-back works
 * even when the orchestrator is on a DIFFERENT machine.
 *
 * Same-machine: the dispatch registry (orchestrate-dispatch.json) is local, so
 * `registryEntry` carries the orchestrator's exact coords (incl. orchRoot for a
 * thread-scope orchestrator). Cross-machine: the foreign sub-bot's daemon never
 * wrote that registry, so `registryEntry` is undefined — but everything needed
 * for the common case is on the sub-bot's OWN session: the report goes top-level
 * into the chat the sub-topic lives in (= the orchestrator's chat) and @-s the
 * orchestrator (creatorOpenId, captured from the dispatch @). So we fall back to
 * `{ orchChatId: sessionChatId, orchScope: 'chat', orchRoot: '' }`.
 *
 * orchOpenId prefers `creatorOpenId` (stable, set on every session-creation path
 * incl. foreign-bot auto-create), then `ownerOpenId`, then the drifting
 * `quoteTargetSenderOpenId` as a last resort.
 */
export function resolveReportTarget(input: {
  registryEntry?: { orchChatId?: string; orchScope?: string; orchRoot?: string };
  sessionChatId?: string;
  creatorOpenId?: string;
  ownerOpenId?: string;
  quoteTargetSenderOpenId?: string;
}): { orchChatId?: string; orchScope: string; orchRoot: string; orchOpenId?: string } {
  const e = input.registryEntry;
  return {
    orchChatId: e?.orchChatId ?? input.sessionChatId,
    orchScope: e?.orchScope ?? 'chat',
    orchRoot: e?.orchRoot ?? '',
    orchOpenId: input.creatorOpenId ?? input.ownerOpenId ?? input.quoteTargetSenderOpenId,
  };
}

export interface DispatchRegistryEntry {
  orchChatId?: string;
  orchScope?: string;
  orchRoot?: string;
  orchAppId?: string;
  orchSessionId?: string;
  createdAt?: string;
}

/**
 * Resolve the dispatch record for either a normal thread session or a
 * regular-group chat-scope session folded from a dispatch topic.
 *
 * Folded sessions are keyed by chatId, while the registry is keyed by the seed
 * message id. The seed is retained in currentReplyTarget/replyThreadAliases, so
 * report-back must consult those aliases instead of silently falling back to a
 * context-less top-level message.
 */
export function findDispatchRegistryEntry(input: {
  registry: Record<string, DispatchRegistryEntry>;
  dispatchRootId?: string;
  rootMessageId?: string;
  currentReplyTargetRootId?: string;
  replyThreadAliases?: Record<string, { createdAt: string; lastUsedAt: string }>;
}): { key: string; entry: DispatchRegistryEntry } | undefined {
  if (input.dispatchRootId) {
    const entry = input.registry[input.dispatchRootId];
    return entry ? { key: input.dispatchRootId, entry } : undefined;
  }
  const ordered: string[] = [];
  const add = (value: string | undefined) => {
    if (value && !ordered.includes(value)) ordered.push(value);
  };
  add(input.currentReplyTargetRootId);
  add(input.rootMessageId);
  const aliases = Object.entries(input.replyThreadAliases ?? {})
    .sort((a, b) => String(b[1]?.lastUsedAt ?? '').localeCompare(String(a[1]?.lastUsedAt ?? '')));
  for (const [rootId] of aliases) add(rootId);
  for (const key of ordered) {
    const entry = input.registry[key];
    if (entry) return { key, entry };
  }
  return undefined;
}

export interface DispatchAcceptanceSession {
  larkAppId?: string;
  chatId?: string;
  scope?: 'thread' | 'chat';
  pid?: number;
  workerGeneration?: number;
  rootMessageId?: string;
  status?: string;
  queued?: boolean;
  createdAt?: string;
  lastMessageAt?: string;
  lastCliInput?: string;
  currentReplyTarget?: { rootMessageId?: string; turnId?: string; updatedAt?: string };
  replyTargets?: Record<string, { rootMessageId?: string; updatedAt?: string }>;
  replyThreadAliases?: Record<string, { createdAt?: string; lastUsedAt?: string }>;
  dispatchInputReceipts?: Record<string, {
    rootMessageId?: string;
    committedAt?: string;
    workerGeneration?: number;
  }>;
}

const MAX_DISPATCH_INPUT_RECEIPTS = 64;

/**
 * Persist the worker's exact input-queue commit against the immutable inbound
 * turn and topic root. Returns false when the current session cannot prove the
 * turn→root relation; callers must then fail closed and leave no receipt.
 */
export function recordDispatchInputCommit(
  session: DispatchAcceptanceSession,
  turnId: string,
  workerGeneration: number,
  committedAt = new Date().toISOString(),
): boolean {
  const exactTurnId = turnId.trim();
  if (!exactTurnId) return false;
  if (
    !Number.isSafeInteger(workerGeneration)
    || workerGeneration <= 0
    || session.workerGeneration !== workerGeneration
  ) return false;
  const rootMessageId = session.replyTargets?.[exactTurnId]?.rootMessageId
    ?? (session.currentReplyTarget?.turnId === exactTurnId
      ? session.currentReplyTarget.rootMessageId
      : undefined)
    ?? (session.scope !== 'chat' ? session.rootMessageId : undefined);
  if (!rootMessageId) return false;
  const committedAtMs = Date.parse(committedAt);
  if (!Number.isFinite(committedAtMs)) return false;

  const receipts = { ...(session.dispatchInputReceipts ?? {}) };
  receipts[exactTurnId] = { rootMessageId, committedAt, workerGeneration };
  const ordered = Object.entries(receipts)
    .sort((a, b) => {
      const aMs = Date.parse(a[1].committedAt ?? '');
      const bMs = Date.parse(b[1].committedAt ?? '');
      return (Number.isFinite(bMs) ? bMs : Number.NEGATIVE_INFINITY)
        - (Number.isFinite(aMs) ? aMs : Number.NEGATIVE_INFINITY);
    })
    .slice(0, MAX_DISPATCH_INPUT_RECEIPTS);
  session.dispatchInputReceipts = Object.fromEntries(ordered);
  return true;
}

/**
 * Return the exact local Bot app identities whose persisted session state proves
 * that a dispatch message reached the intended chat/topic after it was sent.
 *
 * A Lark send acknowledgement only proves transport acceptance. This second
 * acknowledgement is deliberately based on the receiver daemon's own session
 * store, and supports both normal thread sessions and regular-group chat-scope
 * sessions that retain the dispatch root as a reply-thread alias.
 */
export function acceptedDispatchBotAppIds(input: {
  sessions: Iterable<DispatchAcceptanceSession>;
  targetAppIds: string[];
  chatId: string;
  threadRootId: string;
  turnId: string;
  notBeforeMs: number;
  isWorkerAlive: (pid: number) => boolean;
  clockSkewMs?: number;
}): string[] {
  const targets = [...new Set(input.targetAppIds.filter(Boolean))];
  const accepted = new Set<string>();
  const threshold = input.notBeforeMs - (input.clockSkewMs ?? 2_000);
  for (const session of input.sessions) {
    const appId = session.larkAppId;
    if (!appId || !targets.includes(appId) || accepted.has(appId)) continue;
    if (session.status === 'closed' || session.queued === true || session.chatId !== input.chatId) continue;
    const workerPid = session.pid;
    if (
      typeof workerPid !== 'number'
      || !Number.isSafeInteger(workerPid)
      || workerPid <= 0
      || !input.isWorkerAlive(workerPid)
    ) continue;
    const workerGeneration = session.workerGeneration;
    if (!Number.isSafeInteger(workerGeneration) || (workerGeneration ?? 0) <= 0) continue;
    const receipt = session.dispatchInputReceipts?.[input.turnId];
    if (!receipt || receipt.rootMessageId !== input.threadRootId) continue;
    if (receipt.workerGeneration !== workerGeneration) continue;
    const committedAtMs = Date.parse(receipt.committedAt ?? '');
    if (!Number.isFinite(committedAtMs) || committedAtMs < threshold) continue;
    accepted.add(appId);
  }
  return targets.filter(appId => accepted.has(appId));
}

/**
 * The footgun check shared by `botmux send`'s explicit-mention guard AND its
 * prose `@Name` auto-injection: returns the sub-topic seed if `mentionOpenId` is
 * a dispatched sub-bot in an active topic that is NOT reachable in the current
 * conversation (so @-ing it here would spawn a context-less session), else null.
 *
 * The bot I'm replying to (`quoteTargetSenderOpenId`) is reachable right here, so
 * it's never treated as off-topic — that's the boundary that stops the guard from
 * blocking a normal reply to a bot conversing with me. Callers block (explicit
 * --mention) or drop (prose injection) on a non-null result, and skip the whole
 * check under `--anyway`.
 */
export function offTopicSubBotTopic(input: {
  mentionOpenId: string;
  quoteTargetSenderOpenId?: string;
  chatId: string;
  registry: Record<string, { orchChatId?: string; bots?: string[] }>;
  activeSeeds: Set<string>;
}): string | null {
  if (!input.mentionOpenId || input.mentionOpenId === input.quoteTargetSenderOpenId) return null;
  return findSubBotTopic({
    mentionOpenId: input.mentionOpenId,
    chatId: input.chatId,
    registry: input.registry,
    activeSeeds: input.activeSeeds,
  });
}

/**
 * Decide which names of a candidate bot are eligible for prose `@Name`
 * auto-mention injection in `botmux send`.
 *
 * The fan-out bug: a bot writes "@Codex review" in its message; the injector
 * matches each bot by **botName OR cliId**, and the cliId ("codex") is a shared
 * *type* alias — so "@Codex" matches every codex-type bot (Codex分身, Codex二号分身,
 * ttadk(codex), aiden x codex…) and pulls them ALL into the topic, each spawning
 * a session and replying.
 *
 * Fix: the unique `botName` is always eligible (so first-time @-invites still
 * work), but the type-generic `cliId` alias is eligible **only when this bot is
 * actually in the current conversation** (`convoBotAppIds` = bots with an active
 * session in this thread / chat). So "@Codex" resolves to the one codex bot
 * collaborating here, not every same-type bot. `selfAliases` (the sender's own
 * name/cliId) are always excluded.
 */
export function eligibleAutoMentionAliases(input: {
  botName?: string;
  cliId?: string;
  larkAppId?: string;
  selfAliases: Set<string>;
  convoBotAppIds: Set<string>;
}): string[] {
  const out: string[] = [];
  const { botName, cliId, larkAppId, selfAliases, convoBotAppIds } = input;
  if (botName && !selfAliases.has(botName.toLowerCase())) out.push(botName);
  if (
    cliId &&
    !selfAliases.has(cliId.toLowerCase()) &&
    !!larkAppId &&
    convoBotAppIds.has(larkAppId)
  ) {
    out.push(cliId);
  }
  return out;
}
