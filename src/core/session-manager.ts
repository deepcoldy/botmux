/**
 * Session manager — session helper functions extracted from daemon.ts.
 * Handles working directory resolution, attachment downloads, prompt building,
 * session restoration, and scheduled task execution.
 */
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expandHome } from './working-dir.js';
import { config } from '../config.js';
import * as sessionStore from '../services/session-store.js';
import * as messageQueue from '../services/message-queue.js';
import { downloadMessageResource, listChatBotMembers } from '../im/lark/client.js';
import { logger } from '../utils/logger.js';
import { forkWorker, forkAdoptWorker, killStalePids, getCurrentCliVersion, restoreUsageLimitRuntimeState, setActiveSessionSafe, isRelayableRealSession, closeSession } from './worker-pool.js';
import { createCliAdapterSync } from '../adapters/cli/registry.js';
import { buildBotmuxShellHints } from '../adapters/cli/shared-hints.js';
import { TmuxBackend } from '../adapters/backend/tmux-backend.js';
import { getBot, getAllBots } from '../bot-registry.js';
import type { CliId } from '../adapters/cli/types.js';
import { validateAdoptTarget } from './session-discovery.js';
import type { LarkAttachment, LarkMention, ScheduledTask } from '../types.js';
import type { MessageResource } from '../im/lark/message-parser.js';
import type { ResolvedSender } from '../im/lark/identity-cache.js';
import { sessionKey, sessionAnchorId } from './types.js';
import type { DaemonSession } from './types.js';
import { markSessionActivity } from './session-activity.js';
import { usageLimitStateKey } from '../utils/cli-usage-limit.js';
import { t, localeForBot, type Locale } from '../i18n/index.js';
import { parseWorkingDirList } from '../utils/working-dir.js';
import { resolveRole } from './role-resolver.js';

function sessionCreatedAtMs(session: { createdAt?: string }): number {
  return session.createdAt ? (Date.parse(session.createdAt) || Date.now()) : Date.now();
}

function sessionLastMessageAtMs(session: { createdAt?: string; lastMessageAt?: string }): number {
  return session.lastMessageAt ? (Date.parse(session.lastMessageAt) || sessionCreatedAtMs(session)) : sessionCreatedAtMs(session);
}

function sameUsageLimit(a: DaemonSession['usageLimit'], b: DaemonSession['usageLimit']): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return usageLimitStateKey(a) === usageLimitStateKey(b) && a.retryReady === b.retryReady;
}

// ─── Path helpers ────────────────────────────────────────────────────────────

export { expandHome };

export function getSessionWorkingDir(ds?: DaemonSession): string {
  if (ds?.workingDir) return expandHome(ds.workingDir);
  if (ds?.larkAppId) {
    const bot = getBot(ds.larkAppId);
    return expandHome(bot.config.workingDir ?? '~');
  }
  // Fallback for calls without a session (e.g. during restore)
  return expandHome(config.daemon.workingDir);
}

export function getProjectScanDir(ds?: DaemonSession): string {
  // 从 workingDir 自身开始向下扫描 git 仓库 (scanProjects 会向下递归).
  // 早期版本扫的是 workingDir 的父目录, 会把无关的同级兄弟仓库一起列出来,
  // 语义反直觉; 现在把扫描根钉在 workingDir 本身: 指向仓库集合根目录
  // (如 ~/projects) 就列出其下所有仓库, 指向单个仓库就只列该仓库及其嵌套.
  // (PROJECT_SCAN_DIR / projectScanDir 显式覆盖字段早已在
  // PR feature/setup-bot-management 收尾时下线, 此处不再涉及.)
  return getSessionWorkingDir(ds);
}

/**
 * Return all directories to scan for projects (supports multi-dir WORKING_DIR).
 * Each configured workingDir is used as the scan root AS-IS — scanProjects
 * recurses downward from it. See getProjectScanDir for why we no longer climb
 * to the parent directory.
 */
export function getProjectScanDirs(ds?: DaemonSession): string[] {
  if (ds?.larkAppId) {
    const bot = getBot(ds.larkAppId);
    const dirs = new Set<string>();
    const workingDirs = bot.config.workingDirs?.length
      ? bot.config.workingDirs
      : parseWorkingDirList(bot.config.workingDir ?? '~');
    for (const wd of workingDirs) {
      dirs.add(expandHome(wd));
    }
    if (ds.workingDir) {
      dirs.add(expandHome(ds.workingDir));
    }
    return [...dirs];
  }
  // Fallback to global config
  const dirs = new Set<string>();
  for (const wd of config.daemon.workingDirs) {
    dirs.add(expandHome(wd));
  }
  if (ds?.workingDir) {
    dirs.add(expandHome(ds.workingDir));
  }
  return [...dirs];
}

// ─── Attachment download ─────────────────────────────────────────────────────

export function getAttachmentsDir(messageId: string): string {
  return join(resolve(config.session.dataDir), 'attachments', messageId);
}

export async function downloadResources(larkAppId: string, messageId: string, resources: MessageResource[]): Promise<{ attachments: LarkAttachment[]; needLogin: boolean }> {
  if (resources.length === 0) return { attachments: [], needLogin: false };

  const attachments: LarkAttachment[] = [];
  const dir = getAttachmentsDir(messageId);
  let needLogin = false;

  for (const res of resources) {
    const savePath = join(dir, res.name);
    try {
      const resMessageId = res.messageId ?? messageId;
      await downloadMessageResource(larkAppId, resMessageId, res.key, res.type, savePath);
      attachments.push({ type: res.type, path: savePath, name: res.name });
    } catch (err: any) {
      // Download failure usually means missing User Token scope or a
      // legitimately revoked attachment — the caller surfaces `needLogin`
      // to the user. Per-failure log stays at info to aid retries.
      logger.info(`Failed to download ${res.type} ${res.key}: ${err.message}`);
      if (err.message?.includes('User Token')) needLogin = true;
    }
  }

  return { attachments, needLogin };
}

// ─── Prompts ─────────────────────────────────────────────────────────────────

/** Get bots actually present in the chat (excludes current bot).
 *  Calls Lark OpenAPI to list chat members, then cross-references with
 *  registered bots to enrich with cliId. Falls back to empty on API error. */
export async function getAvailableBots(
  currentAppId: string,
  chatId: string,
): Promise<Array<{ name: string; displayName: string; openId: string }>> {
  try {
    const chatBots = await listChatBotMembers(currentAppId, chatId);

    return chatBots
      // Exclude self by larkAppId — NOT by cliId, since two bots can share a
      // cliId (e.g. both run "codex") and a name-based check would wrongly drop
      // a same-cliId peer. Only surface bots we can RELIABLY @-mention from
      // here: an unreliable open_id (peer self-view / appId fallback) would make
      // the model's `botmux send --mention <open_id>` miss its target.
      .filter(b => b.larkAppId !== currentAppId && b.mentionable)
      .map(b => ({
        name: b.name,
        displayName: b.displayName,
        openId: b.openId,
      }));
  } catch (err) {
    logger.warn(`Failed to list chat bot members, skipping bot section: ${err}`);
    return [];
  }
}

/** XML-escape a string for use as element text content or attribute value.
 *  Covers the five XML-mandated entities; sufficient for our use case
 *  (paths, names, open_ids, bot identifiers) since we never embed raw user
 *  input in attribute values. */
function xmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Render a `<sender>` tag for prompt injection. Caller resolves the sender
 * (open_id + type + optional name) via `resolveSender(...)` in identity-cache.
 * Returns empty string when no sender data is available so the prompt stays
 * clean for synthetic flows (scheduled tasks, no-op spawns).
 */
export function renderSenderTag(sender?: ResolvedSender): string {
  if (!sender || !sender.openId) return '';
  const attrs: string[] = [`type="${xmlEscape(sender.type)}"`, `open_id="${xmlEscape(sender.openId)}"`];
  if (sender.name) attrs.push(`name="${xmlEscape(sender.name)}"`);
  return `<sender ${attrs.join(' ')} />`;
}

export function formatAttachmentsHint(attachments?: LarkAttachment[], locale?: Locale): string {
  if (!attachments || attachments.length === 0) return '';
  let imgN = 0, fileN = 0;
  const items = attachments.map(a => {
    const tag = a.type === 'image' ? 'image' : 'file';
    const n = a.type === 'image' ? ++imgN : ++fileN;
    return `  <${tag} n="${n}" path="${xmlEscape(a.path)}" />`;
  });
  return `<attachments hint="${xmlEscape(t('ai.attach.hint', undefined, locale))}">\n${items.join('\n')}\n</attachments>`;
}

export function buildNewTopicPrompt(
  userMessage: string,
  sessionId: string,
  cliId: CliId,
  cliPathOverride?: string,
  attachments?: LarkAttachment[],
  mentions?: LarkMention[],
  availableBots?: Array<{ name: string; displayName: string; openId: string }>,
  followUps?: string[],
  botIdentity?: { name?: string; openId?: string },
  locale?: Locale,
  sender?: ResolvedSender,
  opts?: { larkAppId?: string; chatId?: string },
): string {
  const adapter = createCliAdapterSync(cliId, cliPathOverride);
  // Non-Claude CLIs receive the botmux routing hints inline via the prompt
  // (Claude Code builds its own via --append-system-prompt). Source hints
  // freshly from i18n so they respect the resolved locale instead of the
  // static `adapter.systemHints` array that was baked at module load.
  const hints = adapter.injectsSessionContext ? [] : buildBotmuxShellHints(locale);

  const routingBlock = hints.length > 0
    ? `<botmux_routing>\n${hints.join('\n')}\n</botmux_routing>`
    : '';

  const unknown = t('ai.identity.unknown', undefined, locale);
  let identityBlock = '';
  if (botIdentity && (botIdentity.name || botIdentity.openId)) {
    identityBlock = [
      '<identity>',
      `  <name>${xmlEscape(botIdentity.name ?? unknown)}</name>`,
      `  <open_id>${xmlEscape(botIdentity.openId ?? unknown)}</open_id>`,
      `  <routing_rules>${t('ai.identity.short_routing', undefined, locale)}</routing_rules>`,
      '</identity>',
    ].join('\n');
  }

  let roleBlock = '';
  if (opts?.larkAppId && opts?.chatId) {
    const { content: roleContent, source: roleSource } = resolveRole(opts.larkAppId, opts.chatId);
    if (roleContent) {
      const ctx = roleSource === 'team' ? 'team' : 'group';
      roleBlock = `<role context="${ctx}" chat_id="${xmlEscape(opts.chatId)}">\n${roleContent}\n</role>`;
    }
  }

  let mentionBlock = '';
  if (mentions && mentions.length > 0) {
    const items = mentions.map(m => {
      const oid = m.openId ? ` open_id="${xmlEscape(m.openId)}"` : '';
      return `  <mention name="${xmlEscape(m.name)}"${oid} />`;
    });
    mentionBlock = `<mentions>\n${items.join('\n')}\n</mentions>`;
  }

  let botBlock = '';
  if (availableBots && availableBots.length > 0) {
    const mentionedOpenIds = new Set(mentions?.map(m => m.openId).filter(Boolean));
    const unmentionedBots = availableBots.filter(b => !mentionedOpenIds.has(b.openId));
    if (unmentionedBots.length > 0) {
      const items = unmentionedBots.map(
        b => `  <bot name="${xmlEscape(b.displayName)}" open_id="${xmlEscape(b.openId)}" />`,
      );
      botBlock = `<available_bots hint="${xmlEscape(t('ai.available_bots.hint', undefined, locale))}">\n${items.join('\n')}\n</available_bots>`;
    }
  }

  // Messages the user sent while the repo-selection card was still pending are
  // buffered as followUps. Fold them into the single <user_message> body
  // (blank-line separated) rather than emitting a separate <follow_up_message>
  // block per message: the deferred spawn is conceptually one opening turn, so
  // one block reads cleanly and the surrounding metadata envelope
  // (sender/mention) isn't repeated for every buffered line.
  const mergedMessage = followUps && followUps.length > 0
    ? [userMessage, ...followUps].join('\n\n')
    : userMessage;
  const userBlock = `<user_message>\n${mergedMessage}\n</user_message>`;
  const parts: string[] = [userBlock];

  const senderBlock = renderSenderTag(sender);
  if (senderBlock) parts.push(senderBlock);

  const attachHint = formatAttachmentsHint(attachments, locale);
  if (attachHint) parts.push(attachHint);

  // CLIs with injectsSessionContext (Claude Code) get Lark routing/identity
  // and session ID via system prompt, so skip those blocks here.
  if (!adapter.injectsSessionContext) {
    parts.push(`<session_id>${xmlEscape(sessionId)}</session_id>`);
    if (routingBlock) parts.push(routingBlock);
    if (identityBlock) parts.push(identityBlock);
  }
  if (roleBlock) parts.push(roleBlock);
  if (mentionBlock) parts.push(mentionBlock);
  if (botBlock) parts.push(botBlock);

  return parts.join('\n\n');
}

/**
 * Build the content for a follow-up message (thread reply to an active session).
 * Mirrors buildNewTopicPrompt structure but for subsequent messages.
 * Session ID is omitted for adopt mode and CLIs with injectsSessionContext.
 */
export function buildFollowUpContent(
  content: string,
  sessionId: string,
  opts?: { attachments?: LarkAttachment[]; mentions?: LarkMention[]; isAdoptMode?: boolean; cliId?: CliId; cliPathOverride?: string; locale?: Locale; sender?: ResolvedSender; larkAppId?: string; chatId?: string },
): string {
  const parts: string[] = [`<user_message>\n${content}\n</user_message>`];

  const senderBlock = renderSenderTag(opts?.sender);
  if (senderBlock) parts.push(senderBlock);

  const attachHint = opts?.attachments && opts.attachments.length > 0
    ? formatAttachmentsHint(opts.attachments, opts.locale)
    : '';
  if (attachHint) parts.push(attachHint);

  // Inject role for follow-up messages: per-chat override ＞ team default (same as buildNewTopicPrompt)
  if (opts?.larkAppId && opts?.chatId) {
    const { content: roleContent, source: roleSource } = resolveRole(opts.larkAppId, opts.chatId);
    if (roleContent) {
      const ctx = roleSource === 'team' ? 'team' : 'group';
      parts.push(`<role context="${ctx}" chat_id="${xmlEscape(opts.chatId)}">\n${roleContent}\n</role>`);
    }
  }

  if (!opts?.isAdoptMode) {
    const skipSessionId = opts?.cliId
      ? createCliAdapterSync(opts.cliId, opts.cliPathOverride).injectsSessionContext
      : false;
    if (!skipSessionId) {
      parts.push(`<session_id>${xmlEscape(sessionId)}</session_id>`);
    }
  }

  if (opts?.mentions && opts.mentions.length > 0) {
    const items = opts.mentions.map(m => {
      const oid = m.openId ? ` open_id="${xmlEscape(m.openId)}"` : '';
      return `  <mention name="${xmlEscape(m.name)}"${oid} />`;
    });
    parts.push(`<mentions>\n${items.join('\n')}\n</mentions>`);
  }

  if (opts?.cliId !== 'mira') {
    parts.push(`<botmux_reminder>${t('ai.followup.reminder', undefined, opts?.locale)}</botmux_reminder>`);
  }

  return parts.join('\n\n');
}

/**
 * Build raw input content for adopt-bridge mode.
 *
 * Bridge mode injects the user's text into the existing CLI exactly as the
 * local user would type it: NO `<session_id>`, NO `<botmux_reminder>`, NO
 * Skills hint. The model is intentionally unaware of botmux — the daemon
 * harvests final output via the transcript watcher and forwards it to Lark
 * out-of-band.
 *
 * Attachments and @mentions are surfaced as plain prose so the user's intent
 * carries over, but the format avoids any wording that would prompt the
 * model to call `botmux send` / route through botmux tooling.
 */
export function buildBridgeInputContent(
  content: string,
  opts?: {
    attachments?: LarkAttachment[];
    mentions?: LarkMention[];
    selfMention?: { name?: string | null; openId?: string | null };
    locale?: Locale;
  },
): string {
  const selfMention = opts?.selfMention;
  const selfNames = new Set<string>();
  if (selfMention?.name) selfNames.add(selfMention.name);
  for (const m of opts?.mentions ?? []) {
    if (selfMention?.openId && m.openId === selfMention.openId) selfNames.add(m.name);
    if (selfMention?.name && m.name === selfMention.name) selfNames.add(m.name);
  }

  const isSelfMention = (m: LarkMention): boolean => {
    // openId is authoritative when both sides have it — avoids classifying
    // a different bot as self in the (theoretical) case where two bots in
    // the same chat share a display name.
    if (selfMention?.openId && m.openId) {
      return m.openId === selfMention.openId;
    }
    // At least one side is missing openId (cold-start window before
    // probeBotOpenId returns, or a mention without openId): fall back to
    // name match.
    return !!selfMention?.name && selfNames.has(m.name);
  };
  const stripLeadingSelfMentions = (s: string): string => {
    if (selfNames.size === 0) return s;
    let out = s.trimStart();
    const tags = [...selfNames]
      .sort((a, b) => b.length - a.length)
      .map(name => `@${name}`);
    let changed = true;
    while (changed) {
      changed = false;
      for (const tag of tags) {
        if (!out.startsWith(tag)) continue;
        const next = out.charAt(tag.length);
        // Avoid stripping prefixes like "@CodexFoo" when the bot name is
        // "Codex"; Lark-rendered mentions are followed by whitespace or EOL.
        if (next && !/\s/.test(next)) continue;
        out = out.slice(tag.length).trimStart();
        changed = true;
        break;
      }
    }
    return out;
  };

  const parts: string[] = [stripLeadingSelfMentions(content)];

  if (opts?.attachments && opts.attachments.length > 0) {
    const lines = opts.attachments.map(a => `- ${a.name} (${a.path})`);
    parts.push(`\n${t('ai.bridge.attachments_label', undefined, opts.locale)}\n${lines.join('\n')}`);
  }

  const mentions = opts?.mentions?.filter(m => !isSelfMention(m)) ?? [];
  if (mentions.length > 0) {
    const lines = mentions.map(m => `- @${m.name}`);
    parts.push(`\n${t('ai.bridge.mentions_label', undefined, opts?.locale)}\n${lines.join('\n')}`);
  }

  return parts.join('\n');
}

// ─── Stream-card state persistence ───────────────────────────────────────────

/** Sentinel value (CARD_POSTING_SENTINEL from worker-pool) we must skip — it marks an in-flight POST, not a real message_id. */
const STREAM_CARD_SENTINEL = '__posting__';

/**
 * Build the prompt that gets piped into a freshly-spawned CLI when an existing
 * (non-bridge) session re-forks its worker. Hits the `worker=null` re-fork
 * branch in handleThreadReply: resume after /close, daemon-restart + new
 * message, and any other path that lands a new turn without a live worker.
 *
 * Without wrapping, the worker would queue the user's raw text as the initial
 * prompt — the CLI sees no `<user_message>` / `<botmux_reminder>` envelope
 * and answers in its own terminal instead of calling `botmux send`.  This
 * helper centralises the wrap so both daemon.ts and tests agree on the shape.
 *
 * Adopt-bridge sessions go through `buildBridgeInputContent` instead — see
 * the buildBridgeInputContent docstring for why bridge prompts intentionally
 * skip botmux routing tags.
 */
export function buildReforkPrompt(
  ds: DaemonSession,
  content: string,
  opts?: {
    attachments?: LarkAttachment[];
    mentions?: LarkMention[];
    cliId?: CliId;
    cliPathOverride?: string;
    selfMention?: { name?: string | null; openId?: string | null };
    locale?: Locale;
    sender?: ResolvedSender;
  },
): string {
  const locale = opts?.locale ?? localeForBot(ds.larkAppId);
  if (ds.adoptedFrom) {
    return buildBridgeInputContent(content, {
      attachments: opts?.attachments,
      mentions: opts?.mentions,
      selfMention: opts?.selfMention,
      locale,
    });
  }
  return buildFollowUpContent(content, ds.session.sessionId, {
    attachments: opts?.attachments,
    mentions: opts?.mentions,
    isAdoptMode: false,
    cliId: opts?.cliId,
    cliPathOverride: opts?.cliPathOverride,
    locale,
    sender: opts?.sender,
    larkAppId: ds.larkAppId,
    chatId: ds.session.chatId,
  });
}

/**
 * Copy current streaming-card fields from `ds` into the persisted Session and save.
 * Lets the existing card be PATCHed on next screen_update after a daemon restart,
 * instead of a fresh card being POSTed.
 */
export function persistStreamCardState(ds: DaemonSession): void {
  const cardId = ds.streamCardId === STREAM_CARD_SENTINEL ? undefined : ds.streamCardId;
  const s = ds.session;
  // Skip write if nothing actually changed — avoids disk churn on every screen_update.
  if (
    s.streamCardId === cardId &&
    s.streamCardNonce === ds.streamCardNonce &&
    s.displayMode === ds.displayMode &&
    s.currentImageKey === ds.currentImageKey &&
    s.currentTurnTitle === ds.currentTurnTitle &&
    sameUsageLimit(s.usageLimit, ds.usageLimit) &&
    s.lastUserPrompt === ds.lastUserPrompt &&
    s.lastCliInput === ds.lastCliInput
  ) return;
  s.streamCardId = cardId;
  s.streamCardNonce = ds.streamCardNonce;
  s.displayMode = ds.displayMode;
  s.currentImageKey = ds.currentImageKey;
  s.currentTurnTitle = ds.currentTurnTitle;
  s.usageLimit = ds.usageLimit;
  s.lastUserPrompt = ds.lastUserPrompt;
  s.lastCliInput = ds.lastCliInput;
  // Clear legacy field so it doesn't drift
  s.streamExpanded = undefined;
  sessionStore.updateSession(s);
}

export function rememberLastCliInput(ds: DaemonSession, userPrompt: string, cliInput: string): void {
  ds.lastUserPrompt = userPrompt;
  ds.lastCliInput = cliInput;
  ds.session.lastUserPrompt = userPrompt;
  ds.session.lastCliInput = cliInput;
  sessionStore.updateSession(ds.session);
}

// ─── Session restore ─────────────────────────────────────────────────────────

export async function restoreActiveSessions(activeSessions: Map<string, DaemonSession>): Promise<void> {
  const sessions = sessionStore.listSessions();
  const active = sessions.filter(s => s.status === 'active');

  if (active.length === 0) {
    logger.info('No active sessions to restore');
    return;
  }

  // Kill any stale CLI processes from previous daemon run
  killStalePids(active);

  logger.info(`Registering ${active.length} active session(s) (no CLI spawn until new messages arrive)...`);

  for (const session of active) {
    // Restored sessions persisted before the scope field was added default to
    // 'thread' — that matches the legacy thread-only behaviour.
    const scope: 'thread' | 'chat' = session.scope === 'chat' ? 'chat' : 'thread';

    // Adopt sessions: restore if original CLI is still alive, otherwise close
    if (session.title?.startsWith('Adopt:') && session.adoptedFrom) {
      const adopted = session.adoptedFrom;
      if (!validateAdoptTarget(adopted.tmuxTarget, adopted.originalCliPid)) {
        logger.info(`Closing adopt session ${session.sessionId} (original CLI exited)`);
        sessionStore.closeSession(session.sessionId);
        continue;
      }
      // Original CLI still alive — re-register and fork adopt worker
      const larkAppId = session.larkAppId ?? getAllBots()[0]?.config.larkAppId ?? '';
      const ds: DaemonSession = {
        session,
        worker: null,
        workerPort: null,
        workerToken: null,
        larkAppId,
        chatId: session.chatId,
        chatType: session.chatType ?? 'group',
        scope,
        spawnedAt: sessionCreatedAtMs(session),
        cliVersion: getCurrentCliVersion(),
        lastMessageAt: sessionLastMessageAtMs(session),
        hasHistory: false,
        workingDir: adopted.cwd,
        adoptedFrom: adopted as DaemonSession['adoptedFrom'],
        streamCardId: session.streamCardId,
        streamCardNonce: session.streamCardNonce,
        displayMode: session.displayMode === 'screenshot' || session.displayMode === 'hidden'
          ? session.displayMode
          : (session.streamExpanded ? 'screenshot' : 'hidden'),
        currentImageKey: session.currentImageKey,
        currentTurnTitle: session.currentTurnTitle,
        usageLimit: session.usageLimit,
        lastUserPrompt: session.lastUserPrompt,
        lastCliInput: session.lastCliInput,
      };
      const anchor = sessionAnchorId(ds);
      messageQueue.ensureQueue(anchor);
      if (ds.usageLimit) restoreUsageLimitRuntimeState(ds);
      // Same-key collision guard: if a prior iteration already set an entry
      // at this key (legitimately possible if disk holds two active sessions
      // resolving to the same chat-scope key — e.g. a leaked scratch +
      // relayed real session from a prior buggy run), close the loser
      // rather than silently overwriting it.
      await setActiveSessionSafe(activeSessions, sessionKey(anchor, larkAppId), ds);
      forkAdoptWorker(ds, { restoredFromMetadata: true });
      logger.info(`[${session.sessionId.substring(0, 8)}] Restored adopt session (target: ${adopted.tmuxTarget}, scope: ${scope})`);
      continue;
    }
    // Adopt sessions without persisted metadata — close (legacy)
    if (session.title?.startsWith('Adopt:')) {
      logger.debug(`Closing adopt session ${session.sessionId} (no persisted metadata)`);
      sessionStore.closeSession(session.sessionId);
      continue;
    }

    const larkAppId = session.larkAppId ?? getAllBots()[0]?.config.larkAppId ?? '';
    const ds: DaemonSession = {
      session,
      worker: null,
      workerPort: null,
      workerToken: null,
      larkAppId,
      chatId: session.chatId,
      chatType: session.chatType ?? 'group',
      scope,
      spawnedAt: sessionCreatedAtMs(session),
      cliVersion: getCurrentCliVersion(),
      lastMessageAt: sessionLastMessageAtMs(session),
      hasHistory: true,  // restored sessions have prior CLI history
      workingDir: session.workingDir,
      // Restore persisted streaming-card state — next screen_update will PATCH
      // the existing card instead of POSTing a fresh one. If the card was
      // withdrawn while we were down, the PATCH fails with MessageWithdrawnError
      // and the existing handler (worker-pool flushCardPatch) clears streamCardId,
      // letting the next update create a new card.
      streamCardId: session.streamCardId,
      streamCardNonce: session.streamCardNonce,
      displayMode: session.displayMode ?? (session.streamExpanded ? 'screenshot' : 'hidden'),
      currentImageKey: session.currentImageKey,
      currentTurnTitle: session.currentTurnTitle,
      usageLimit: session.usageLimit,
      lastUserPrompt: session.lastUserPrompt,
      lastCliInput: session.lastCliInput,
    };
    const anchor = sessionAnchorId(ds);
    messageQueue.ensureQueue(anchor);
    if (ds.usageLimit) restoreUsageLimitRuntimeState(ds);
    // Same-key collision guard — see adopt-branch comment above.
    await setActiveSessionSafe(activeSessions, sessionKey(anchor, larkAppId), ds);

    logger.debug(`Registered session ${session.sessionId} (scope: ${scope}, anchor: ${anchor})`);
  }

  // Tmux mode: auto-fork workers for sessions with surviving tmux sessions
  if (config.daemon.backendType === 'tmux') {
    for (const [, ds] of activeSessions) {
      const tmuxName = TmuxBackend.sessionName(ds.session.sessionId);
      if (!TmuxBackend.hasSession(tmuxName)) continue;

      // Guard against re-attaching to a tmux session that was started with a
      // different CLI than the bot is currently configured for. tmux's
      // attach-session ignores the bin/args we hand to backend.spawn(), so
      // without this check, changing a bot's cliId in bots.json would silently
      // resurrect the OLD CLI on restart. Compare persisted session.cliId
      // (stamped at fork time in worker-pool.forkWorker) against the bot's
      // current config; mismatch ⇒ kill the stale tmux, let the next message
      // trigger a fresh spawn.
      const tag = ds.session.sessionId.substring(0, 8);
      const sessionCliId = ds.session.cliId;
      let botCliId: CliId | undefined;
      try { botCliId = getBot(ds.larkAppId).config.cliId; } catch { /* bot deregistered */ }
      if (sessionCliId && botCliId && sessionCliId !== botCliId) {
        logger.warn(`[${tag}] CLI mismatch (session=${sessionCliId}, bot=${botCliId}), killing stale tmux ${tmuxName}`);
        TmuxBackend.killSession(tmuxName);
        continue;
      }

      logger.info(`[${tag}] Tmux session alive, auto-forking worker to re-attach`);
      forkWorker(ds, '', true);
    }
  }

  logger.info(`Restored ${active.length} session(s)${config.daemon.backendType === 'tmux' ? '' : ', waiting for messages to resume'}`);
}

/**
 * Reactivate a single closed session — used by the "▶️ 恢复会话" card button
 * and the `botmux resume <id>` CLI command. Mirrors the per-session branch
 * of `restoreActiveSessions` but operates on one record by id and without
 * killing stale pids (the `/close` flow that produced this closed record
 * already killed them).
 *
 * Returns `{ ok: true, ds }` on success; structured error otherwise so callers
 * (HTTP IPC, card handler) can surface a precise message.
 *
 *   - 'not_found'        — sessionId doesn't exist in any session file
 *   - 'not_closed'       — session is still active or in some other state
 *   - 'anchor_occupied'  — another active session already owns this anchor
 *                          (e.g. user kept typing after /close, auto-creating
 *                          a fresh thread session); refuse rather than clobber
 *   - 'adopt_unsupported' — adopt sessions are torn down by /close and have
 *                          no resume semantics
 */
export async function resumeSession(
  sessionId: string,
  activeSessions: Map<string, DaemonSession>,
): Promise<{ ok: true; ds: DaemonSession }
| { ok: false; error: 'not_found' | 'not_closed' | 'anchor_occupied' | 'adopt_unsupported'; activeSessionId?: string }> {
  const session = sessionStore.getSession(sessionId);
  if (!session) return { ok: false, error: 'not_found' };
  if (session.status !== 'closed') return { ok: false, error: 'not_closed' };

  // Adopt sessions don't survive /close — the user's tmux pane and original
  // CLI pid have already moved on, and bringing the bridge back without a live
  // pane is meaningless.
  if (session.title?.startsWith('Adopt:') || session.adoptedFrom) {
    return { ok: false, error: 'adopt_unsupported' };
  }

  const scope: 'thread' | 'chat' = session.scope === 'chat' ? 'chat' : 'thread';
  const larkAppId = session.larkAppId ?? getAllBots()[0]?.config.larkAppId ?? '';
  const anchor = scope === 'thread' ? session.rootMessageId : session.chatId;
  const key = sessionKey(anchor, larkAppId);

  // In-memory occupant check. A daemon-command scratch (e.g. an unconfirmed
  // `/relay` picker, a bare `/help`) parks a worker:null placeholder at this
  // anchor; daemon.ts creates one for ANY DAEMON_COMMAND in a session-less
  // chat. It's not a real conversation, so it must NOT block resume — but it
  // also can't just be ignored: leaving it in the Map while we re-register
  // the resumed session at the same key would orphan its still-active store
  // row (the exact ghost-active bug we fixed elsewhere). So: close it (evicts
  // Map + marks store closed + dashboard event), then fall through to resume.
  //
  // We keep blocking on a real session (isRelayableRealSession) AND on a
  // pendingRepo session — the latter is a worker:null placeholder too, but it
  // represents deliberate in-progress setup (user is picking a repo), not a
  // throwaway command container, so clobbering it would lose real intent.
  const existing = activeSessions.get(key);
  if (existing) {
    if (isRelayableRealSession(existing) || existing.pendingRepo) {
      return { ok: false, error: 'anchor_occupied', activeSessionId: existing.session.sessionId };
    }
    await closeSession(existing.session.sessionId);
  }

  // Belt-and-suspenders: also scan persisted sessions for any *other* active
  // session pinned to the same (larkAppId, scope, anchor). The in-memory Map
  // is the authoritative routing source for a running daemon, but it's only
  // hydrated for sessions that survived restoreActiveSessions. Cross-process
  // and partial-load situations (e.g. another bot's daemon writes a session
  // file but our Map hasn't caught up, or a closed session was orphaned by a
  // crash that left a sibling session active in the same anchor) can leave a
  // store-level conflict invisible to the Map check above.
  //
  // Same scratch carve-out applies on disk: a persisted scratch has neither
  // `cliId` nor `lastCliInput` (those are only written once a real CLI ran).
  // A real conflict (either marker present) still blocks; scratch-only
  // conflicts get closed so they stop occupying the anchor on disk.
  //
  // CAVEAT — this path canNOT honor the pendingRepo carve-out the in-memory
  // branch above applies: `pendingRepo` is a runtime DaemonSession flag that
  // is never persisted to the store, so a pendingRepo session that's only
  // visible here as a disk row (not in our Map) looks identical to a scratch
  // and would be closed. Safe under the production topology (one daemon per
  // bot): this scan is larkAppId-scoped to OUR bot, and our bot's live
  // pendingRepo sessions are always in our Map (handled by the in-memory
  // branch first). A disk-only active row with no CLI markers for our own
  // bot is therefore a genuine scratch or a crash leftover — closing it is
  // correct either way. The two branches are intentionally NOT identical;
  // don't "unify" them by reading pendingRepo here (it isn't there to read).
  const conflicts = sessionStore.listSessions().filter(s =>
    s.sessionId !== sessionId
    && s.status === 'active'
    && (s.larkAppId ?? '') === larkAppId
    && (s.scope === 'chat' ? 'chat' : 'thread') === scope
    && (scope === 'thread' ? s.rootMessageId === anchor : s.chatId === anchor),
  );
  const realConflict = conflicts.find(s => !!s.cliId || !!s.lastCliInput);
  if (realConflict) {
    return { ok: false, error: 'anchor_occupied', activeSessionId: realConflict.sessionId };
  }
  for (const scratch of conflicts) {
    await closeSession(scratch.sessionId);
  }

  // Reactivate in store — clear closedAt so dashboard rows don't keep showing
  // the stale close timestamp on the now-active session.
  session.status = 'active';
  session.closedAt = undefined;
  session.lastMessageAt = new Date().toISOString();
  sessionStore.updateSession(session);

  const now = Date.now();
  const ds: DaemonSession = {
    session,
    worker: null,
    workerPort: null,
    workerToken: null,
    larkAppId,
    chatId: session.chatId,
    chatType: session.chatType ?? 'group',
    scope,
    spawnedAt: sessionCreatedAtMs(session),
    cliVersion: getCurrentCliVersion(),
    lastMessageAt: now,
    hasHistory: true,    // resumed sessions carry CLI history (--resume on next fork)
    workingDir: session.workingDir,
    ownerOpenId: session.ownerOpenId,
    streamCardId: session.streamCardId,
    streamCardNonce: session.streamCardNonce,
    displayMode: session.displayMode ?? (session.streamExpanded ? 'screenshot' : 'hidden'),
    currentImageKey: session.currentImageKey,
    currentTurnTitle: session.currentTurnTitle,
    usageLimit: session.usageLimit,
    lastUserPrompt: session.lastUserPrompt,
    lastCliInput: session.lastCliInput,
  };

  messageQueue.ensureQueue(anchor);
  // setActiveSessionSafe over a bare Map.set: the scratch-eviction above
  // should already have freed `key`, but if any occupant remains it closes
  // it rather than silently orphaning it (consistent with restore/transfer).
  await setActiveSessionSafe(activeSessions, key, ds);
  logger.info(`Resumed session ${sessionId.substring(0, 8)} (scope: ${scope}, anchor: ${anchor.substring(0, 12)})`);
  return { ok: true, ds };
}

// ─── Scheduled task execution ────────────────────────────────────────────────

export async function executeScheduledTask(
  task: ScheduledTask,
  activeSessions: Map<string, DaemonSession>,
  refreshCliVersion: (...args: any[]) => boolean,
): Promise<void> {
  // Resolve which bot to use — prefer the task's original bot so replies come from
  // the same account the user set up the schedule with.
  const allBots = getAllBots();
  if (allBots.length === 0) {
    // Expected at startup before bot configs finish loading; scheduler will
    // re-fire on the next cron tick. Not actionable.
    logger.debug('No bots configured, skipping scheduled task');
    return;
  }
  const bot =
    (task.larkAppId && allBots.find(b => b.config.larkAppId === task.larkAppId)) ||
    allBots[0];
  const larkAppId = bot.config.larkAppId;

  const { getChatMode, sendMessage, replyMessage } = await import('../im/lark/client.js');

  // Scope resolution — explicit task.scope wins; otherwise fall back to legacy
  // semantics (rootMessageId present → thread, absent → chat). Restoring an
  // older schedule without scope keeps current behaviour.
  const scope: 'thread' | 'chat' = task.scope === 'chat'
    ? 'chat'
    : task.scope === 'thread'
      ? 'thread'
      : (task.rootMessageId ? 'thread' : 'chat');

  // Decide where to route the "🕐 task started" notification and where the
  // session conversation lands.
  //
  // Thread-scope (legacy and current default):
  //   - cross-thread (creator != target): notify creator's thread; deliver
  //     execution into target rootMessageId
  //   - same-thread:                       notify into the bound thread,
  //     which doubles as the session anchor
  //   - missing rootMessageId:             fall back to a fresh top-level
  //     post in the chat (one-shot session)
  //
  // Chat-scope (auto-adopt / 普通群): post the start notification straight to
  // the chat without reply_in_thread; the chat IS the session anchor.
  let anchor: string;
  let isContinuation = false;

  if (scope === 'chat') {
    // A group may have been converted from 普通群 to 话题群 after the schedule
    // was created. In topic mode, a top-level sendMessage creates a new topic;
    // keep scheduled continuations in the original thread when we have one.
    const chatMode = await getChatMode(larkAppId, task.chatId, { forceRefresh: true });
    if (chatMode === 'topic' && task.rootMessageId) {
      try {
        await replyMessage(larkAppId, task.rootMessageId, `🕐 定时任务「${task.name}」开始执行`, 'text', true);
        anchor = task.rootMessageId;
        isContinuation = true;
      } catch (err: any) {
        logger.warn(`[scheduler] Failed to reply in converted topic chat ${task.rootMessageId} (${err.message}); falling back to new thread`);
        anchor = await sendMessage(larkAppId, task.chatId, `🕐 定时任务「${task.name}」开始执行`);
      }
    } else if (task.creatorRootMessageId && task.creatorChatId !== task.chatId) {
      const creatorAppId = task.creatorLarkAppId ?? larkAppId;
      replyMessage(
        creatorAppId,
        task.creatorRootMessageId,
        `🕐 定时任务「${task.name}」已在目标群聊触发`,
        'text',
        true,
      ).catch((err: any) => {
        logger.warn(`[scheduler] Failed to notify creator thread ${task.creatorRootMessageId} (${err.message})`);
      });
    } else {
      // Same-chat: post the start banner to the chat as a plain message.
      try {
        await sendMessage(larkAppId, task.chatId, `🕐 定时任务「${task.name}」开始执行`);
      } catch (err: any) {
        logger.warn(`[scheduler] Failed to post start banner in chat ${task.chatId} (${err.message})`);
      }
    }
    anchor = task.chatId;
    isContinuation = !!activeSessions.get(sessionKey(anchor, larkAppId));
  } else {
    // thread-scope path (existing logic)
    const isCrossThread =
      !!task.creatorRootMessageId &&
      !!task.rootMessageId &&
      task.creatorRootMessageId !== task.rootMessageId;

    if (isCrossThread) {
      const creatorAppId = task.creatorLarkAppId ?? larkAppId;
      replyMessage(
        creatorAppId,
        task.creatorRootMessageId!,
        `🕐 定时任务「${task.name}」已在目标话题触发`,
        'text',
        true,
      ).catch((err: any) => {
        logger.warn(`[scheduler] Failed to notify creator thread ${task.creatorRootMessageId} (${err.message})`);
      });
      anchor = task.rootMessageId!;
      isContinuation = true;
    } else if (task.rootMessageId) {
      try {
        await replyMessage(
          larkAppId,
          task.rootMessageId,
          `🕐 定时任务「${task.name}」开始执行`,
          'text',
          true,
        );
        anchor = task.rootMessageId;
        isContinuation = true;
      } catch (err: any) {
        logger.warn(`[scheduler] Failed to reply in original thread ${task.rootMessageId} (${err.message}); falling back to new thread`);
        anchor = await sendMessage(larkAppId, task.chatId, `🕐 定时任务「${task.name}」开始执行`);
      }
    } else {
      anchor = await sendMessage(larkAppId, task.chatId, `🕐 定时任务「${task.name}」开始执行`);
    }
  }

  refreshCliVersion(bot.config.cliId, bot.config.cliPathOverride);

  // Inject into a live session if one already exists at this anchor.
  const existing = activeSessions.get(sessionKey(anchor, larkAppId));
  if (isContinuation && existing?.worker && !existing.worker.killed) {
    markSessionActivity(existing);
    try {
      rememberLastCliInput(existing, task.prompt, task.prompt);
      existing.worker.send({ type: 'message', content: task.prompt });
      logger.info(`[scheduler] Task "${task.name}" injected into live session ${existing.session.sessionId}`);
      return;
    } catch (err: any) {
      logger.warn(`[scheduler] Failed to inject into live session (${err.message}); spawning fresh worker`);
    }
  }

  // Spawn a fresh session bound to the chosen anchor.
  // Thread-scope: rootMessageId = anchor. Chat-scope: rootMessageId stores the
  // chatId-as-seed for audit (sessionAnchorId() returns chatId via scope). If a
  // formerly chat-scope task was redirected into a converted topic chat, promote
  // the runtime session to thread-scope so follow-up replies stay in-thread.
  const runtimeScope: 'thread' | 'chat' = scope === 'chat' && anchor !== task.chatId ? 'thread' : scope;
  const session = sessionStore.createSession(task.chatId, anchor, `${t('schedule.title_prefix', undefined, localeForBot(larkAppId))} ${task.name}`);
  const now = Date.now();
  session.larkAppId = larkAppId;
  session.scope = runtimeScope;
  session.lastMessageAt = new Date(now).toISOString();
  sessionStore.updateSession(session);
  messageQueue.ensureQueue(anchor);

  const prompt = buildNewTopicPrompt(task.prompt, session.sessionId, bot.config.cliId, bot.config.cliPathOverride, undefined, undefined, undefined, undefined, { name: bot.botName, openId: bot.botOpenId }, localeForBot(larkAppId), undefined, { larkAppId, chatId: task.chatId });

  const ds: DaemonSession = {
    session,
    worker: null,
    workerPort: null,
    workerToken: null,
    larkAppId,
    chatId: task.chatId,
    chatType: task.chatType === 'p2p' ? 'p2p' : 'group',
    scope: runtimeScope,
    spawnedAt: sessionCreatedAtMs(session),
    cliVersion: getCurrentCliVersion(),
    lastMessageAt: now,
    hasHistory: isContinuation,
    workingDir: task.workingDir,
  };
  activeSessions.set(sessionKey(anchor, larkAppId), ds);
  rememberLastCliInput(ds, task.prompt, prompt);
  forkWorker(ds, prompt);

  logger.info(`[scheduler] Task "${task.name}" spawned (session: ${session.sessionId}, scope: ${scope}, anchor: ${anchor}, continuation: ${isContinuation})`);
}
