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

import { formatDispatchRepoRequirement, type DispatchRepoRequirement } from './repo-requirement.js';
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
  /** Plain-text kickoff with real <at> tags; cross-app bot delivery uses this. */
  kickoffText: string;
  /** open_ids @-mentioned in the kickoff — the bots that will be triggered. */
  mentionedOpenIds: string[];
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
  /** Machine-readable repo preflight, stripped by the receiver before CLI input. */
  repoRequirement?: DispatchRepoRequirement;
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
      content.push([{ tag: 'text', text: `· ${label}：${b.role ?? '执行者'}` }]);
    }
  }

  if (input.repoRequirement) {
    content.push([{ tag: 'text', text: '' }]);
    for (const line of formatDispatchRepoRequirement(input.repoRequirement).split('\n')) {
      content.push([{ tag: 'text', text: line }]);
    }
  }

  // Bot-authored rich posts can arrive at the receiving app with an unresolved
  // @_user_N placeholder and no usable mention identity. Plain text <at> tags
  // take Lark's native mention path and reliably populate the receiver event.
  const kickoffText = content.map(paragraph => paragraph.map((node) =>
    node.tag === 'at' ? `<at user_id="${node.user_id}"></at>` : node.text,
  ).join('')).join('\n');

  return {
    seedText,
    threadContent: content,
    kickoffText,
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
  deliveryEnvelope?: string;
}): PostParagraph[] {
  const openId = input.orchOpenId.trim();
  if (!openId) throw new Error('report requires the orchestrator open_id');
  // A verified-delivery envelope is a whole-message protocol. It already
  // carries the human summary, so prefixing `content` would move the header
  // away from the first meaningful line and make cross-device ingestion skip it.
  const text = (input.deliveryEnvelope ?? input.content).trim();
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
