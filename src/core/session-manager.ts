/**
 * Session manager — session helper functions extracted from daemon.ts.
 * Handles working directory resolution, attachment downloads, prompt building,
 * session restoration, and scheduled task execution.
 */
import { existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expandHome } from './working-dir.js';
import { config } from '../config.js';
import * as sessionStore from '../services/session-store.js';
import * as messageQueue from '../services/message-queue.js';
import { downloadMessageResource, listChatBotMembers, UserTokenMissingError } from '../im/lark/client.js';
import { logger } from '../utils/logger.js';
import { forkWorker, forkAdoptWorker, killStalePids, getCurrentCliVersion, restoreUsageLimitRuntimeState, setActiveSessionSafe, isRelayableRealSession, closeSession, getActiveSessionsRegistry } from './worker-pool.js';
import { createCliAdapterSync } from '../adapters/cli/registry.js';
import { buildBotmuxShellHints } from '../adapters/cli/shared-hints.js';
import {
  resolveSkillInjectionModeForApp,
  builtinSkillEntries,
  buildBuiltinSkillCatalogBlock,
  builtinSkillHelpPointer,
} from '../skills/injection-mode.js';
import { getSessionPersistentBackendType, persistentSessionName, probePersistentSession, probePersistentBackendServer, killPersistentSession, type PersistentBackendType } from './persistent-backend.js';
import { adoptTargetLabel, validateAdoptTargetState } from './session-discovery.js';
import { getBot, getAllBots, getOwnerOpenId, findOncallChat, effectiveDefaultWorkingDir } from '../bot-registry.js';
import type { CliId } from '../adapters/cli/types.js';
import { dashboardEventBus } from './dashboard-events.js';
import { composeRowFromActive } from './dashboard-rows.js';
import {
  composeSpawnUserContent,
  deriveSessionTitleFromContent,
  type CreateSessionColumn,
  type SpawnRole,
  type Coworker,
} from './session-create.js';
import { validateZellijAdoptTarget } from './zellij-adopt-discovery.js';
import type { BackendType } from '../adapters/backend/types.js';
import type { LarkAttachment, LarkMention, ScheduledTask } from '../types.js';
import type { MessageResource } from '../im/lark/message-parser.js';
import type { ResolvedSender } from '../im/lark/identity-cache.js';
import { sessionKey, sessionAnchorId } from './types.js';
import type { DaemonSession } from './types.js';
import { announceSessionRow, markSessionActivity, announcePendingRepoSession } from './session-activity.js';
import { scanMultipleProjects } from '../services/project-scanner.js';
import { buildRepoSelectCard } from '../im/lark/card-builder.js';
import { repoPickerScanOptions } from '../global-config.js';
import { usageLimitStateKey } from '../utils/cli-usage-limit.js';
import { t, localeForBot, type Locale } from '../i18n/index.js';
import { parseWorkingDirList } from '../utils/working-dir.js';
import { resolveRoleInjection } from './role-resolver.js';
import { ensureDefaultWhiteboard, getWhiteboard, whiteboardEnabled } from '../services/whiteboard-store.js';
import { botAutoWorktreeEnabled } from '../services/default-worktree.js';

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

function sessionBotCliMismatch(ds: DaemonSession): { sessionCli: string; botCli: string } | null {
  const sessionCliId = ds.session.cliId;
  if (!sessionCliId) return null;
  let botCfg: { cliId?: CliId; wrapperCli?: string };
  try { botCfg = getBot(ds.larkAppId).config; } catch { return null; }
  if (!botCfg.cliId) return null;
  const sessionWrapper = ds.session.wrapperCli?.trim() || undefined;
  const botWrapper = botCfg.wrapperCli?.trim() || undefined;
  const describe = (cliId: CliId, wrapper: string | undefined) => (wrapper ? `${wrapper} (${cliId})` : cliId);
  if (sessionCliId !== botCfg.cliId) {
    return { sessionCli: describe(sessionCliId, sessionWrapper), botCli: describe(botCfg.cliId, botWrapper) };
  }
  // wrapper 轴：'aiden x claude' 与裸 claude-code 共享同一个 cliId，但是两种不同的
  // 启动选择（selectionKeyForBot 以 cliId+wrapperCli 为键），wrapper 间切换同样不能
  // 复活旧会话。仅 agentFrozen 的会话有可靠的 wrapper 快照——legacy 未冻结会话下次
  // fork 会从 live bot 配置回填 wrapper，天然不会在这条轴上失配。
  if (ds.session.agentFrozen && sessionWrapper !== botWrapper) {
    return { sessionCli: describe(sessionCliId, sessionWrapper), botCli: describe(botCfg.cliId, botWrapper) };
  }
  return null;
}

async function closeActiveSessionIfCliMismatch(ds: DaemonSession): Promise<boolean> {
  const mismatch = sessionBotCliMismatch(ds);
  if (!mismatch) return false;

  const tag = ds.session.sessionId.substring(0, 8);
  const backendType = getSessionPersistentBackendType(ds);
  // 仅在没有活 worker 时预杀 backing pane：restore 守卫处 ds 尚未进 registry，
  // closeSession→killWorker 摸不到 pane，必须在这里亲手杀；而活 worker（运行时
  // 热切场景）走 closeSession 的 close IPC 由 worker 侧优雅拆除 backing——先硬杀
  // pane 会跟 worker 的退出处理赛跑。
  if (backendType && (!ds.worker || ds.worker.killed)) {
    const backendName = persistentSessionName(backendType, ds.session.sessionId);
    logger.warn(`[${tag}] CLI mismatch (session=${mismatch.sessionCli}, bot=${mismatch.botCli}), closing active session and killing ${backendType} ${backendName}`);
    killPersistentSession(backendType, backendName);
  } else {
    logger.warn(`[${tag}] CLI mismatch (session=${mismatch.sessionCli}, bot=${mismatch.botCli}), closing active session`);
  }
  await closeSession(ds.session.sessionId);
  return true;
}

/**
 * Runtime counterpart of the restore-time CLI-mismatch guard（#346 只堵了重启
 * 路径）：bot 的启动选择（cliId / wrapperCli）在 daemon 运行中被热切后，存量会话
 * 仍冻结着旧 CLI，下一条消息（或 terminal 唤醒）会把旧 CLI lazy resume 回来。
 * 热切端点在改完配置后调用本函数，把该 bot 名下失配的活跃会话连同 backing pane
 * 一起关掉。
 *
 * 豁免口径与 restoreActiveSessions 一致：queued（待办池）会话从没起过 CLI；
 * adopt 会话接管的是用户自己的外部 CLI，其 cliId 与 bot 配置不同是合法状态。
 */
export async function closeCliMismatchedSessionsForBot(larkAppId: string): Promise<number> {
  const registry = getActiveSessionsRegistry();
  if (!registry) return 0;
  let closed = 0;
  // 先快照再遍历：closeSession 会在迭代途中从 registry 删项。
  for (const ds of [...registry.values()]) {
    if (ds.larkAppId !== larkAppId) continue;
    if (ds.session.queued) continue;
    if (ds.adoptedFrom || ds.session.adoptedFrom || ds.session.title?.startsWith('Adopt:')) continue;
    if (await closeActiveSessionIfCliMismatch(ds)) closed++;
  }
  return closed;
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
      // Per-failure log stays at info to aid retries.
      logger.info(`Failed to download ${res.type} ${res.key}: ${err.message}`);
      // Only prompt /login when the token is genuinely missing or rejected
      // (UserTokenMissingError). A plain download failure — cross-tenant /
      // card-image / withdrawn resource that 4xx/5xx's even WITH a valid token
      // — must NOT be misreported as "missing User Token". (Previously this was
      // a substring match on the error message, which caught downloadWithUserToken's
      // own "User Token download failed" text and produced a false /login prompt.)
      if (err instanceof UserTokenMissingError) needLogin = true;
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

/**
 * cursor-agent's model tends to copy the inlined `<sender open_id="ou_xxx"
 * name="高鹏" />` verbatim into its reply — it reads `open_id:name` as the
 * `--mention <open_id:name>` form and leaks `ou_xxx:高鹏` into the `botmux
 * send` body / opening line. Other CLIs haven't shown this, so the guard is
 * scoped to cursor only (claude-code et al. that set injectsSessionContext
 * never see this inline tag anyway). Returns '' for every other CLI and when
 * there is no sender tag to misread.
 */
export function renderCursorSenderNote(cliId: CliId | undefined, hasSender: boolean, locale?: Locale): string {
  if (cliId !== 'cursor' || !hasSender) return '';
  return `<sender_note>${t('ai.cursor.sender_note', undefined, locale)}</sender_note>`;
}

/**
 * Render a buffered follow-up's sender attribution for daemon's pending-repo
 * branch (handleThreadReply), where a cross-user follow-up's `<sender>` tag is
 * prepended OUTSIDE the builder and later folds into the opening
 * `<user_message>`. Pair the tag with the cursor anti-echo note so a folded-in
 * foreign sender gets the same protection the builder gives its own top-level
 * `<sender>`; otherwise an inline `ou_xxx:name` reaches cursor with no adjacent
 * note (the builder's note only covers `ds.pendingSender`'s top-level tag, and
 * may be absent entirely when pendingSender is undefined). Returns '' when
 * there is no sender to attribute.
 */
export function renderBufferedSenderBlock(sender: ResolvedSender | undefined, cliId: CliId | undefined, locale?: Locale): string {
  const tag = renderSenderTag(sender);
  if (!tag) return '';
  const note = renderCursorSenderNote(cliId, true, locale);
  return note ? `${tag}\n${note}` : tag;
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

function renderRoleContextBlock(
  larkAppId: string | undefined,
  chatId: string | undefined,
  opts?: { followUp?: boolean },
): string {
  if (!larkAppId || !chatId) return '';

  const { content: roleContent, source: roleSource, injectMode } = resolveRoleInjection(larkAppId, chatId);
  if (!roleContent) return '';

  // "inject once" mode: emit the role only on the opening/refork turn (which
  // rebuilds the CLI's full context) and skip it on follow-up messages, so a
  // large persona isn't re-sent every round. Default 'every' keeps re-injecting.
  if (opts?.followUp && injectMode === 'once') return '';

  const ctx = roleSource === 'team' ? 'team' : 'group';
  return `<role context="${ctx}" chat_id="${xmlEscape(chatId)}">\n${roleContent}\n</role>`;
}

export function ensureSessionWhiteboard(ds: DaemonSession): void {
  if (!whiteboardEnabled()) return;
  // Whiteboard is an optional, best-effort context enhancement. A failure here
  // (file-lock timeout, disk error, corrupted index) must NOT propagate and
  // break session creation / forking at the ~11 call sites in daemon.ts — the
  // session is still fully usable without a board. Log and degrade gracefully.
  try {
    if (ds.session.whiteboardId && getWhiteboard(ds.session.whiteboardId)) return;
    const meta = ensureDefaultWhiteboard({
      larkAppId: ds.larkAppId,
      chatId: ds.session.chatId,
      workingDir: ds.session.workingDir ?? ds.workingDir,
      sessionId: ds.session.sessionId,
    });
    ds.session.whiteboardId = meta.id;
    sessionStore.updateSession(ds.session);
  } catch (e) {
    logger.warn(`[whiteboard] ensureSessionWhiteboard failed for session ${ds.session.sessionId}: ${(e as Error)?.message ?? e}`);
  }
}

function renderWhiteboardBlock(opts?: { whiteboardId?: string }): string {
  if (!whiteboardEnabled() || !opts?.whiteboardId) return '';
  const meta = getWhiteboard(opts.whiteboardId);
  if (!meta || meta.archived) return '';
  const id = xmlEscape(meta.id);
  return [
    `<whiteboard id="${id}">`,
    '本地项目上下文；读取：`botmux whiteboard read --id ' + id + ' --json`（拿到 content 与 updatedAt）。',
    '更新状态：`botmux whiteboard update --id ' + id + ' --expected-updated-at <上次 read 的 updatedAt> <内容>`。',
    '更新前先用 `read --json` 拿到当前内容与 updatedAt，融合新信息后整体重写为一份完整的当前状态（默认中文；代码标识/命令/错误信息可保留原文），并用 `--expected-updated-at` 回传 read 到的版本号做并发冲突检测。',
    '若更新报 `whiteboard_cas_mismatch`，说明期间有其它 agent 改过白板——重新 `read --json` 拿最新内容与 updatedAt，再次融合重写。',
    '不要直接读写本地文件；不要写密钥/隐私；用户可见结论仍必须 `botmux send`。',
    '</whiteboard>',
  ].join('\n');
}

function buildHermesBotmuxHints(locale?: Locale): string[] {
  if (locale === 'en') {
    return [
      'You are running in a Feishu/Lark chat through botmux. For ordinary text replies, write the user-facing answer as your final assistant message; botmux automatically forwards that final output to Feishu/Lark.',
      'Do not call `botmux send` for normal text answers. Use `botmux send` only for special delivery needs: files/images, voice, cross-chat/top-level sends, or explicit mention routing to another person/bot.',
      '`botmux send` / `botmux history` / `botmux quoted` / `botmux bots` are shell commands installed in $PATH; run them via Bash/terminal tools when needed.',
      'If you already used `botmux send` for special delivery in this turn, do not put a second copy of the answer, messageId, or send-success receipt in the final assistant message.',
    ];
  }
  return [
    '你运行在飞书（Lark）聊天中。普通文字回复请直接写在 assistant final 里，botmux 会自动把 final_output 转发到飞书。',
    '普通文本答案不要调用 `botmux send`。只有需要图片/文件/语音、跨群或顶层发送、显式 @ 某人/某 bot 等特殊投递能力时，才使用 `botmux send`。',
    '`botmux send` / `botmux history` / `botmux quoted` / `botmux bots` 是已安装在 $PATH 的 shell 命令；需要时通过 Bash/terminal 工具执行。',
    '如果本轮已经为了特殊投递调用过 `botmux send`，final 里不要再写第二份正文、messageId 或“发送成功/已处理”回执。',
  ];
}

function hermesFollowupReminder(locale?: Locale): string {
  if (locale === 'en') {
    return 'For ordinary text replies, do not call `botmux send`; put the user-facing answer in final and botmux will forward it to Feishu/Lark. Use `botmux send` only for special delivery such as files/images, voice, cross-chat/top-level sends, or explicit mention routing. If already used, do not add a second answer or send-success receipt in final.';
  }
  return '普通文字回复不要调用 `botmux send`；直接把给用户看的答案写在 final，botmux 会自动转发到飞书。只有图片/文件/语音、跨群/顶层发送、特殊 @ 路由等特殊投递才用 `botmux send`；如果本轮已经用过，不要在 final 里再写第二份答案或发送成功回执。';
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
  opts?: { larkAppId?: string; chatId?: string; whiteboardId?: string },
): string {
  const adapter = createCliAdapterSync(cliId, cliPathOverride);
  // Non-Claude CLIs receive the botmux routing hints inline via the prompt
  // (Claude Code builds its own via --append-system-prompt). Source hints
  // freshly from i18n so they respect the resolved locale instead of the
  // static `adapter.systemHints` array that was baked at module load.
  const hints = adapter.injectsSessionContext ? [] : (cliId === 'hermes' ? buildHermesBotmuxHints(locale) : buildBotmuxShellHints(locale));

  const routingBlock = hints.length > 0
    ? `<botmux_routing>\n${hints.join('\n')}\n</botmux_routing>`
    : '';

  // Built-in skill delivery for CLIs without a per-session skill channel
  // (codex/gemini/opencode/… — those with a global `skillsDir`). In `prompt`
  // mode we inline a compact skill catalog here instead of installing files
  // into the CLI's shared global dir; in `off` mode we only point at the CLI
  // help. `global` mode installs files (worker-pool ensureCliSkills) and adds
  // nothing to the prompt. Claude-family (injectsSessionContext) inject skills
  // via --plugin-dir, so they're excluded.
  let skillBlock = '';
  if (!adapter.injectsSessionContext && adapter.skillsDir) {
    const mode = resolveSkillInjectionModeForApp(opts?.larkAppId);
    if (mode === 'prompt') {
      // excludeRoutingCovered: send/history/quoted/bots live in <botmux_routing>
      // already, so the catalog carries only the additional task capabilities.
      const entries = builtinSkillEntries({ asksViaHook: adapter.asksViaHook, whiteboardEnabled: whiteboardEnabled(), excludeRoutingCovered: true });
      skillBlock = buildBuiltinSkillCatalogBlock(entries, locale);
    } else if (mode === 'off') {
      skillBlock = builtinSkillHelpPointer(locale);
    }
  }

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

  const roleBlock = renderRoleContextBlock(opts?.larkAppId, opts?.chatId);
  const whiteboardBlock = renderWhiteboardBlock({ whiteboardId: opts?.whiteboardId });

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
  const parts: string[] = [];

  // Put stable, instruction-like context before the user's first turn. This
  // improves salience without moving per-turn attribution (sender/mentions)
  // into the prompt-cache prefix. The whiteboard block is per-turn available
  // context (a tool/usage hint for this round), so it goes before the user's
  // message — same position as in follow-ups — not after it, where it could be
  // misread as part of the user's text.
  if (!adapter.injectsSessionContext) {
    if (routingBlock) parts.push(routingBlock);
    if (skillBlock) parts.push(skillBlock);
    if (identityBlock) parts.push(identityBlock);
    parts.push(`<session_id>${xmlEscape(sessionId)}</session_id>`);
  }
  if (roleBlock) parts.push(roleBlock);
  if (whiteboardBlock) parts.push(whiteboardBlock);

  parts.push(userBlock);

  const senderBlock = renderSenderTag(sender);
  if (senderBlock) parts.push(senderBlock);

  const senderNote = renderCursorSenderNote(cliId, !!senderBlock, locale);
  if (senderNote) parts.push(senderNote);

  const attachHint = formatAttachmentsHint(attachments, locale);
  if (attachHint) parts.push(attachHint);

  // CLIs with injectsSessionContext (Claude Code) get Lark routing/identity
  // and session ID via system prompt, so skip those blocks here.
  if (mentionBlock) parts.push(mentionBlock);
  if (botBlock) parts.push(botBlock);
  // The per-session skill catalog block is appended later in the worker-pool
  // fork path (prepareSessionSkillPrompt), which also writes the manifest and
  // resolves delivery — keeping a single injection site avoids double-rendering.

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
  opts?: { attachments?: LarkAttachment[]; mentions?: LarkMention[]; isAdoptMode?: boolean; cliId?: CliId; cliPathOverride?: string; locale?: Locale; sender?: ResolvedSender; larkAppId?: string; chatId?: string; whiteboardId?: string },
): string {
  const parts: string[] = [];
  const roleBlock = renderRoleContextBlock(opts?.larkAppId, opts?.chatId, { followUp: true });
  const whiteboardBlock = renderWhiteboardBlock({ whiteboardId: opts?.whiteboardId });
  const skipSessionId = opts?.isAdoptMode || (opts?.cliId
    ? createCliAdapterSync(opts.cliId, opts.cliPathOverride).injectsSessionContext
    : false);

  // Put stable context before the user's turn. Follow the new-topic order for
  // shared blocks: session id first, then role. The whiteboard block is
  // per-turn available context, so place it right after <botmux_reminder> and
  // before <user_message> — consistent with new-topic/refork — not after the
  // user's text. Per-turn attribution (sender/attachments/mentions) stays after.
  if (!skipSessionId) parts.push(`<session_id>${xmlEscape(sessionId)}</session_id>`);
  if (roleBlock) parts.push(roleBlock);
  if (opts?.cliId !== 'mira') {
    const reminder = opts?.cliId === 'hermes'
      ? hermesFollowupReminder(opts?.locale)
      : t('ai.followup.reminder', undefined, opts?.locale);
    parts.push(`<botmux_reminder>${reminder}</botmux_reminder>`);
  }
  if (whiteboardBlock) parts.push(whiteboardBlock);

  parts.push(`<user_message>\n${content}\n</user_message>`);

  const senderBlock = renderSenderTag(opts?.sender);
  if (senderBlock) parts.push(senderBlock);

  const senderNote = renderCursorSenderNote(opts?.cliId, !!senderBlock, opts?.locale);
  if (senderNote) parts.push(senderNote);

  const attachHint = opts?.attachments && opts.attachments.length > 0
    ? formatAttachmentsHint(opts.attachments, opts.locale)
    : '';
  if (attachHint) parts.push(attachHint);

  if (opts?.mentions && opts.mentions.length > 0) {
    const items = opts.mentions.map(m => {
      const oid = m.openId ? ` open_id="${xmlEscape(m.openId)}"` : '';
      return `  <mention name="${xmlEscape(m.name)}"${oid} />`;
    });
    parts.push(`<mentions>\n${items.join('\n')}\n</mentions>`);
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
    whiteboardId: ds.session.whiteboardId,
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
    s.lastCliInput === ds.lastCliInput &&
    JSON.stringify(s.replyThreadAliases ?? {}) === JSON.stringify(ds.replyThreadAliases ?? {}) &&
    JSON.stringify(s.currentReplyTarget ?? null) === JSON.stringify(ds.currentReplyTarget ?? null)
  ) return;
  s.streamCardId = cardId;
  s.streamCardNonce = ds.streamCardNonce;
  s.displayMode = ds.displayMode;
  s.currentImageKey = ds.currentImageKey;
  s.currentTurnTitle = ds.currentTurnTitle;
  s.usageLimit = ds.usageLimit;
  s.lastUserPrompt = ds.lastUserPrompt;
  s.lastCliInput = ds.lastCliInput;
  s.replyThreadAliases = ds.replyThreadAliases;
  s.currentReplyTarget = ds.currentReplyTarget;
  // Clear legacy field so it doesn't drift
  s.streamExpanded = undefined;
  sessionStore.updateSession(s);
}

export function rememberLastCliInput(ds: DaemonSession, userPrompt: string, cliInput: string): void {
  // A real CLI input means the post-restart silence is over — let the normal
  // card flow resume for this and subsequent turns.
  ds.suppressRecoveryCard = undefined;
  ds.lastUserPrompt = userPrompt;
  ds.lastCliInput = cliInput;
  ds.session.lastUserPrompt = userPrompt;
  ds.session.lastCliInput = cliInput;
  ds.session.replyThreadAliases = ds.replyThreadAliases;
  ds.session.currentReplyTarget = ds.currentReplyTarget;
  sessionStore.updateSession(ds.session);
}

// ─── Session restore ─────────────────────────────────────────────────────────

/**
 * Whether daemon restore should eagerly re-fork a worker to re-attach a
 * surviving backing pane. True for every persistent backend (tmux/herdr/zellij);
 * the pty backend has nothing to re-attach to, so it stays lazy.
 *
 * Eager re-attach is what makes a session actually come back after a restart —
 * otherwise a killed worker leaves the session dead until its next message, and
 * a pane whose CLI died in the meantime never gets healed, so the transcript
 * fallback can't fire. The old `BOTMUX_QUIET_RESTART` gate that suppressed this
 * (to avoid re-pushing cards on dev restarts) is gone: restored sessions now
 * carry `suppressRecoveryCard`, so the recovery re-fork stays silent in the
 * Lark thread without having to skip recovery altogether.
 */
export function shouldAutoForkOnRestore(backendType: BackendType): boolean {
  return backendType !== 'pty';
}

const RECOVERY_FORK_BATCH_SIZE = config.daemon.recoveryForkBatchSize ?? 5;
const RECOVERY_FORK_DELAY_MS = config.daemon.recoveryForkDelayMs ?? 250;

/**
 * Re-fork the given restored sessions to re-attach their surviving panes, but
 * staggered to avoid a thundering-herd CPU/IO spike when many sessions survive a
 * restart: spawn `batchSize` workers, wait `delayMs`, repeat.
 *
 * Sessions whose worker is already live are skipped — a real message can arrive
 * (the Lark dispatcher is up before restore finishes) and lazily fork the worker
 * during one of our `delayMs` pauses; re-forking it here would kill that live
 * worker mid-turn via `forkWorker`'s double-fork guard.
 */
export async function staggeredRecoveryFork(
  sessions: readonly DaemonSession[],
  fork: (ds: DaemonSession) => void,
  batchSize: number = RECOVERY_FORK_BATCH_SIZE,
  delayMs: number = RECOVERY_FORK_DELAY_MS,
): Promise<void> {
  let spawnedInBatch = 0;
  for (const ds of sessions) {
    if (ds.worker) continue; // already woken by a real message — don't clobber it
    fork(ds);
    if (++spawnedInBatch >= batchSize) {
      spawnedInBatch = 0;
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}

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
      const adopted = session.adoptedFrom as NonNullable<DaemonSession['adoptedFrom']>;
      const validation = adopted.zellijPaneId
        ? (typeof adopted.originalCliPid === 'number' && validateZellijAdoptTarget(adopted.zellijSession ?? '', adopted.zellijPaneId, adopted.originalCliPid, adopted.cliId) ? 'alive' : 'missing')
        : validateAdoptTargetState(adopted);
      if (validation === 'missing') {
        logger.info(`Closing adopt session ${session.sessionId} (adopted target exited: ${adoptTargetLabel(adopted)})`);
        sessionStore.closeSession(session.sessionId);
        continue;
      }
      if (validation === 'unknown') {
        logger.warn(`Keeping adopt session ${session.sessionId} closed until next resume (target validation failed: ${adoptTargetLabel(adopted)})`);
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
        adoptedFrom: adopted,
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
        replyThreadAliases: session.replyThreadAliases,
        currentReplyTarget: session.currentReplyTarget,
        // Restart stays silent for adopt sessions too: forkAdoptWorker shares
        // setupWorkerHandlers, so the recovery ready/screen_update would post a
        // card without this. Cleared on the first real CLI input.
        suppressRecoveryCard: true,
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
      announceSessionRow(ds);
      forkAdoptWorker(ds, { restoredFromMetadata: true });
      logger.info(`[${session.sessionId.substring(0, 8)}] Restored adopt session (target: ${adoptTargetLabel(adopted)}, scope: ${scope})`);
      continue;
    }
    // Adopt sessions without persisted metadata — close (legacy)
    if (session.title?.startsWith('Adopt:')) {
      logger.debug(`Closing adopt session ${session.sessionId} (no persisted metadata)`);
      sessionStore.closeSession(session.sessionId);
      continue;
    }

    // Queued（待办池）会话：CLI 从没起过，restore 必须保持 parked（hasHistory:false +
    // queued），绝不能走下面 hasHistory:true 的通用分支——否则下一条消息会 --resume 一个
    // 不存在的 CLI 会话。pendingPrompt 从持久化的 queuedPrompt 恢复，供激活时发首轮。
    if (session.queued) {
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
        workingDir: session.workingDir,
        ownerOpenId: session.ownerOpenId,
        pendingPrompt: session.queuedPrompt,
        currentTurnTitle: session.currentTurnTitle ?? session.title,
      };
      const anchor = sessionAnchorId(ds);
      messageQueue.ensureQueue(anchor);
      await setActiveSessionSafe(activeSessions, sessionKey(anchor, larkAppId), ds);
      // 重启后把待办池卡片重新广播给 dashboard，否则会从看板消失（#277 同款修复，
      // 我这条 queued 分支提前 continue 绕过了下面的 announceSessionRow，要自己补）。
      announceSessionRow(ds);
      logger.info(`[${session.sessionId.substring(0, 8)}] Restored queued (待办池) session (scope: ${scope})`);
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
      replyThreadAliases: session.replyThreadAliases,
      currentReplyTarget: session.currentReplyTarget,
      // Restart stays silent in the group: the recovery re-fork won't post or
      // patch a streaming card. Cleared on the first real CLI input.
      suppressRecoveryCard: true,
    };
    if (await closeActiveSessionIfCliMismatch(ds)) continue;
    const anchor = sessionAnchorId(ds);
    messageQueue.ensureQueue(anchor);
    if (ds.usageLimit) restoreUsageLimitRuntimeState(ds);
    // Same-key collision guard — see adopt-branch comment above.
    await setActiveSessionSafe(activeSessions, sessionKey(anchor, larkAppId), ds);
    announceSessionRow(ds);

    logger.debug(`Registered session ${session.sessionId} (scope: ${scope}, anchor: ${anchor})`);
  }

  // Persistent backends: auto-fork workers for sessions whose backing session
  // survived daemon restart. Probe + zombie-close runs synchronously here; the
  // actual re-fork is deferred into `toReattach` and staggered below so a box
  // with dozens of surviving sessions doesn't spike on restart.
  const toReattach: DaemonSession[] = [];
  // Server-liveness is sampled ONCE per backend type (cached): a single
  // `tmux list-sessions` answers for all of that backend's sessions, and a
  // consistent snapshot avoids a mid-loop race where an early lazy fork could
  // flip the answer partway through (the loop itself starts no workers).
  const serverStateCache = new Map<PersistentBackendType, 'running' | 'down' | 'unknown'>();
  const backendServerState = (bt: PersistentBackendType) => {
    let s = serverStateCache.get(bt);
    if (s === undefined) { s = probePersistentBackendServer(bt); serverStateCache.set(bt, s); }
    return s;
  };
  for (const [, ds] of activeSessions) {
    // Queued（待办池）会话从没起过 CLI，没有任何后端会话——别去探它，否则 tmux 后端
    // 会把「找不到 backing」误判成僵尸而关掉它。
    if (ds.session.queued) continue;
    const backendType = getSessionPersistentBackendType(ds);
    if (!backendType) continue;
    if (!shouldAutoForkOnRestore(backendType)) continue;

    const backendName = persistentSessionName(backendType, ds.session.sessionId);
    const probe = probePersistentSession(backendType, backendName);
    if (probe === 'missing') {
      const tag = ds.session.sessionId.substring(0, 8);
      // Intentionally cold-resume-suspended (idle-worker sweeper killed the
      // backing session + CLI to reclaim memory over the per-bot live cap). The
      // 'missing' backing is EXPECTED here, not a zombie — keep the worker-less
      // active record so the next message cold-resumes from the transcript
      // (forkWorker(resume=true) clears the marker once the worker is back).
      if (ds.session.suspendedColdResume) {
        logger.info(`[${tag}] ${backendType} session was cap-suspended — keeping active for lazy cold-resume`);
        continue;
      }
      // 'missing' is ambiguous: it means EITHER this one pane is gone while the
      // server runs (a true solo zombie) OR the whole multiplexer server is down
      // (e.g. machine reboot) and every pane vanished at once. Only the former is
      // a zombie to close. On a reboot the CLI transcript on disk is still
      // resumable, so keep the worker-less active record and let it lazily resume
      // on the next message (exactly like a pty session) instead of mass-closing
      // every session — the bug that wiped a full dashboard after a host reboot.
      if (backendServerState(backendType) === 'down') {
        logger.warn(`[${tag}] ${backendType} server is down (host reboot?) — keeping "${backendName}" active for lazy resume instead of closing`);
        continue;
      }
      // Server is up (or its state is inconclusive) and this specific pane is
      // gone — a true zombie. Close it (evicts the active record + marks the
      // store row closed) so the next message starts a clean session.
      logger.warn(`[${tag}] ${backendType} backing session "${backendName}" is gone — closing zombie active session`);
      await closeSession(ds.session.sessionId);
      continue;
    }
    if (probe === 'unknown') {
      // Probe FAILED (CLI error / timeout / unparseable output) — e.g. a herdr
      // server still warming up on restart. We can't tell whether the session
      // survived, so we must NOT close it: a transient failure would otherwise
      // permanently tear down a still-alive session (context lost, pane leaked,
      // store closed → no lazy recovery). Keep the worker-less active record and
      // let it re-attach on the next message, exactly like the old behaviour.
      const tag = ds.session.sessionId.substring(0, 8);
      logger.warn(`[${tag}] ${backendType} backing session "${backendName}" probe inconclusive — keeping active session for lazy recovery`);
      continue;
    }

    // Belt-and-suspenders: the early per-session guard above already closes
    // mismatched sessions before they are ever registered, but keep the same
    // check on the reattach path too — persistent-backend reattach ignores the
    // bin/args handed to backend.spawn(), so anything that slips through here
    // would silently resurrect the old frozen CLI.
    if (await closeActiveSessionIfCliMismatch(ds)) continue;

    const tag = ds.session.sessionId.substring(0, 8);
    logger.info(`[${tag}] ${backendType} session alive, queued for re-attach`);
    toReattach.push(ds);
  }

  // Staggered re-fork (see staggeredRecoveryFork): empty prompt = re-attach
  // only, no new turn — same as the old per-session eager fork.
  await staggeredRecoveryFork(toReattach, (ds) => forkWorker(ds, '', true));

  const hasPersistentBackend = [...activeSessions.values()].some(ds => !!getSessionPersistentBackendType(ds));
  logger.info(`Restored ${active.length} session(s)${hasPersistentBackend ? '' : ', waiting for messages to resume'}`);
}

/**
 * Resolve a session's live web-terminal worker port, WAKING the worker on demand
 * if needed.
 *
 * A session can be active with no live worker — a pty session that resumes
 * lazily, or a persistent-backend session whose staggered restart re-fork
 * hasn't reached it yet (or whose worker died since). The terminal
 * reverse-proxy, however, needs the worker's HTTP port to serve `/s/{id}`, so a
 * surviving-but-worker-less session would otherwise 502 ("session not running")
 * even though its tmux/zellij pane is alive. This bridges that gap: if the
 * session is active and its persistent backing pane still exists, re-fork the
 * worker to re-attach (empty prompt = no new turn, same as restart reattach) and
 * wait for it to report its port.
 *
 * Returns the port, or undefined when there's nothing serveable (no live worker
 * possible: not active, non-persistent backend, or the pane is gone). The
 * `forkWorker` double-fork guard plus its synchronous `ds.worker` assignment make
 * concurrent calls (the terminal's HTML GET + WS upgrade arrive together) safe —
 * only the first forks; the rest just await the same `ds.workerPort`.
 */
export async function ensureTerminalWorkerPort(ds: DaemonSession): Promise<number | undefined> {
  if (ds.workerPort) return ds.workerPort;
  if (ds.session.status !== 'active') return undefined;

  const backendType = getSessionPersistentBackendType(ds);
  if (!backendType) return undefined;
  // Non-destructive read path: only wake a worker when the backing pane is
  // CONFIRMED alive. 'missing' or 'unknown' both bail (a 502 the terminal
  // retries) — same conservative stance as the old boolean check, with no risk
  // of closing anything.
  if (probePersistentSession(backendType, persistentSessionName(backendType, ds.session.sessionId)) !== 'exists') {
    return undefined;
  }

  if (!ds.worker) {
    logger.info(`[${ds.session.sessionId.substring(0, 8)}] terminal accessed with no live worker — waking to re-attach`);
    forkWorker(ds, '', true);
  }

  // Wait (bounded) for the re-forked worker to report its HTTP port via `ready`.
  // Re-attach is fast (~1-2s in practice); 10s covers a slow CLI restart.
  const deadlineMs = Date.now() + 10_000;
  while (Date.now() < deadlineMs) {
    if (ds.workerPort) return ds.workerPort;
    await new Promise((r) => setTimeout(r, 100));
  }
  return ds.workerPort ?? undefined;
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
    replyThreadAliases: session.replyThreadAliases,
    currentReplyTarget: session.currentReplyTarget,
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

  if (task.deliver === 'new-topic') {
    // Every fire opens a brand-new topic and runs in a fresh session. A
    // top-level sendMessage in a topic group creates a new topic; in a plain
    // group it's just a new top-level message. Either way we never reply
    // in-thread and never reuse a prior session, so successive runs stay fully
    // isolated. The returned message_id becomes this run's thread anchor.
    anchor = await sendMessage(larkAppId, task.chatId, t('scheduler.task_started', { name: task.name }, localeForBot(larkAppId)));
    isContinuation = false;
  } else if (scope === 'chat') {
    // A group may have been converted from 普通群 to 话题群 after the schedule
    // was created. In topic mode, a top-level sendMessage creates a new topic;
    // keep scheduled continuations in the original thread when we have one.
    const chatMode = await getChatMode(larkAppId, task.chatId, { forceRefresh: true });
    if (chatMode === 'topic' && task.rootMessageId) {
      try {
        await replyMessage(larkAppId, task.rootMessageId, t('scheduler.task_started', { name: task.name }, localeForBot(larkAppId)), 'text', true);
        anchor = task.rootMessageId;
        isContinuation = true;
      } catch (err: any) {
        logger.warn(`[scheduler] Failed to reply in converted topic chat ${task.rootMessageId} (${err.message}); falling back to new thread`);
        anchor = await sendMessage(larkAppId, task.chatId, t('scheduler.task_started', { name: task.name }, localeForBot(larkAppId)));
      }
    } else if (task.creatorRootMessageId && task.creatorChatId !== task.chatId) {
      const creatorAppId = task.creatorLarkAppId ?? larkAppId;
      replyMessage(
        creatorAppId,
        task.creatorRootMessageId,
        t('scheduler.task_triggered_target_chat', { name: task.name }, localeForBot(creatorAppId)),
        'text',
        true,
      ).catch((err: any) => {
        logger.warn(`[scheduler] Failed to notify creator thread ${task.creatorRootMessageId} (${err.message})`);
      });
    } else {
      // Same-chat: post the start banner to the chat as a plain message.
      try {
        await sendMessage(larkAppId, task.chatId, t('scheduler.task_started', { name: task.name }, localeForBot(larkAppId)));
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
        t('scheduler.task_triggered_target_thread', { name: task.name }, localeForBot(creatorAppId)),
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
          t('scheduler.task_started', { name: task.name }, localeForBot(larkAppId)),
          'text',
          true,
        );
        anchor = task.rootMessageId;
        isContinuation = true;
      } catch (err: any) {
        logger.warn(`[scheduler] Failed to reply in original thread ${task.rootMessageId} (${err.message}); falling back to new thread`);
        anchor = await sendMessage(larkAppId, task.chatId, t('scheduler.task_started', { name: task.name }, localeForBot(larkAppId)));
      }
    } else {
      anchor = await sendMessage(larkAppId, task.chatId, t('scheduler.task_started', { name: task.name }, localeForBot(larkAppId)));
    }
  }

  refreshCliVersion(bot.config.cliId, bot.config.cliPathOverride);

  // Inject into a live session if one already exists at this anchor.
  const existing = activeSessions.get(sessionKey(anchor, larkAppId));
  if (isContinuation && existing?.worker && !existing.worker.killed) {
    markSessionActivity(existing);
    try {
      ensureSessionWhiteboard(existing);
      const content = buildFollowUpContent(task.prompt, existing.session.sessionId, {
        isAdoptMode: false,
        cliId: bot.config.cliId,
        cliPathOverride: bot.config.cliPathOverride,
        locale: localeForBot(larkAppId),
        larkAppId,
        chatId: task.chatId,
        whiteboardId: existing.session.whiteboardId,
      });
      rememberLastCliInput(existing, task.prompt, content);
      existing.worker.send({ type: 'message', content });
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
  const runtimeScope: 'thread' | 'chat' =
    task.deliver === 'new-topic' ? 'thread'
      : scope === 'chat' && anchor !== task.chatId ? 'thread'
        : scope;
  const session = sessionStore.createSession(task.chatId, anchor, `${t('schedule.title_prefix', undefined, localeForBot(larkAppId))} ${task.name}`);
  const now = Date.now();
  session.larkAppId = larkAppId;
  session.scope = runtimeScope;
  session.lastMessageAt = new Date(now).toISOString();
  sessionStore.updateSession(session);
  messageQueue.ensureQueue(anchor);

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
  ensureSessionWhiteboard(ds);
  const prompt = buildNewTopicPrompt(task.prompt, session.sessionId, bot.config.cliId, bot.config.cliPathOverride, undefined, undefined, undefined, undefined, { name: bot.botName, openId: bot.botOpenId }, localeForBot(larkAppId), undefined, { larkAppId, chatId: task.chatId, whiteboardId: ds.session.whiteboardId });
  activeSessions.set(sessionKey(anchor, larkAppId), ds);
  rememberLastCliInput(ds, task.prompt, prompt);
  forkWorker(ds, prompt);

  logger.info(`[scheduler] Task "${task.name}" spawned (session: ${session.sessionId}, scope: ${scope}, anchor: ${anchor}, continuation: ${isContinuation})`);
}

// ─── Dashboard「创建会话」spawn / activate ───────────────────────────────────

/** 解析 dashboard 创建会话的 pinned workingDir：本群 oncall 绑定优先（弹框填了工作目录会
 *  建群时绑 oncall），其次 bot 的 effectiveDefaultWorkingDir（defaultWorkingDir，或 Oncall
 *  模式下的 defaultOncall 目录；校验是真目录）。都没有 → undefined，表示「不钉目录」，交给
 *  forkOrShowRepoCard 弹 /repo 卡片让用户在群里选。与普通新话题的 resolvePinnedWorkingDir
 *  同口径（少了 sibling 继承那层，新群无 sibling 可继承）。*/
function resolveDashboardSpawnWorkingDir(larkAppId: string, chatId: string): string | undefined {
  const oncall = findOncallChat(larkAppId, chatId)?.workingDir;
  if (oncall) return oncall;
  const raw = effectiveDefaultWorkingDir(getBot(larkAppId).config);
  if (!raw) return undefined;
  const resolved = expandHome(raw);
  try {
    if (statSync(resolved).isDirectory()) return resolved;
  } catch { /* not a dir → 当作没配 */ }
  return undefined;
}

/** 起会话或弹 /repo 选择卡片——复用普通新话题那套仓库选择逻辑：
 *  - ds.workingDir 已钉（oncall / bot 默认）→ 直接 forkWorker。
 *  - 没钉但扫到可选项目 → 设 pendingRepo + 把 userContent 暂存进 pendingPrompt + 在群里发
 *    buildRepoSelectCard（含 worktree）。用户点卡片由 card-handler 的 pendingRepo 分支起 CLI。
 *  - 没钉也没项目 → 回退用 bot 默认 cwd 直接起。
 *  userContent 是已按角色包装好的首轮内容（lead 前言等），不论哪条路都原样带过去。 */
async function forkOrShowRepoCard(ds: DaemonSession, userContent: string): Promise<void> {
  const larkAppId = ds.larkAppId;
  const bot = getBot(larkAppId);
  const locale = localeForBot(larkAppId);

  // 仅默认目录 + auto-worktree：ds.workingDir 命中本 bot 自己的默认目录（且非本群 oncall 绑定）时，
  // 走 pendingRepo 挂起 + 异步提交：把会话置 pendingRepo（入站路由 buffer 并发消息、不抢 fork），
  // 在关键路径之外经 runAutoWorktreeCommit 建 worktree 并 commitRepoSelection 提交+fork（detach，
  // 立即返回，不阻塞 dashboard 建会话 IPC 响应）。dashboard「建会话」立即开跑 / 待办池激活都走这里。
  // 非 git 仓库 / 建失败 → 回退默认目录（提示经 notify 发）。registry 拿不到时兜底走原同步路径。
  const registry = getActiveSessionsRegistry();
  if (registry && ds.workingDir && !ds.worktreeCreating && botAutoWorktreeEnabled(larkAppId)) {
    const isBotDefaultDir = !findOncallChat(larkAppId, ds.chatId)?.workingDir
      && ds.workingDir === expandHome(effectiveDefaultWorkingDir(bot.config) ?? '');
    if (isBotDefaultDir) {
      const baseDir = ds.workingDir;
      ds.pendingRepo = true;         // router buffers concurrent msgs; commit clears it
      ds.pendingPrompt = userContent; // folded into the first turn by commitRepoSelection
      // (The pending dashboard row is announced inside runAutoWorktreeCommit so all
      // three spawn callers get it from one place — no publish needed here.)
      const { runAutoWorktreeCommit } = await import('../im/lark/card-handler.js');
      const { sendMessage } = await import('../im/lark/client.js');
      void runAutoWorktreeCommit({
        ds, anchor: ds.chatId, larkAppId, baseDir,
        title: ds.session.title, prompt: userContent,
        operatorOpenId: ds.session.ownerOpenId, activeSessions: registry,
        notify: (m) => sendMessage(larkAppId, ds.chatId, m),
      });
      logger.info(`[createSession] session ${ds.session.sessionId.substring(0, 8)} → pending, building worktree off ${baseDir}`);
      return;
    }
  }

  const buildPrompt = () => buildNewTopicPrompt(
    userContent, ds.session.sessionId, bot.config.cliId, bot.config.cliPathOverride,
    undefined, undefined, undefined, undefined,
    { name: bot.botName, openId: bot.botOpenId }, locale, undefined,
    { larkAppId, chatId: ds.chatId, whiteboardId: ds.session.whiteboardId },
  );

  if (!ds.workingDir) {
    // 没钉目录 → 复用 /repo 选择卡片让用户在群里选仓库。
    const scanDirs = getProjectScanDirs(ds).filter(d => existsSync(d));
    const projects = scanDirs.length > 0 ? scanMultipleProjects(scanDirs, 3, repoPickerScanOptions()) : [];
    if (projects.length > 0) {
      try {
        const card = buildRepoSelectCard(projects, getSessionWorkingDir(ds), ds.chatId, locale, bot.config.worktreeMultiPicker);
        const { sendMessage } = await import('../im/lark/client.js');
        ds.pendingRepo = true;
        ds.pendingPrompt = userContent;
        ds.repoCardMessageId = await sendMessage(larkAppId, ds.chatId, card, 'interactive');
        announcePendingRepoSession(ds);
        // 弹卡片这条路不经 forkWorker，session.spawned 不会自动发——手动 upsert 一条，
        // 让 dashboard 显示这条「待选仓库」会话（in_progress 首次 spawn 走这里才会出现）。
        dashboardEventBus.publish({ type: 'session.spawned', body: { session: composeRowFromActive(ds) } });
        logger.info(`[createSession] repo select card posted for session ${ds.session.sessionId.substring(0, 8)} (${projects.length} projects)`);
        return;
      } catch (err) {
        // 发卡失败：退回直接起，别把会话卡死在 pendingRepo。
        ds.pendingRepo = false;
        ds.pendingPrompt = undefined;
        ds.repoCardMessageId = undefined;
        logger.warn(`[createSession] repo card failed (${(err as Error)?.message ?? err}); forking with default cwd`);
      }
    }
  }

  ensureSessionWhiteboard(ds);
  const prompt = buildPrompt();
  rememberLastCliInput(ds, userContent, prompt);
  forkWorker(ds, prompt);
}

export interface SpawnDashboardSessionArgs {
  larkAppId: string;
  /** 新建的飞书群（chat-scope 锚点）。 */
  chatId: string;
  /** 用户在弹框里写的原始任务内容。 */
  content: string;
  /** in_progress=立即开跑；backlog=入待办池（parked，不起 CLI）。 */
  column: CreateSessionColumn;
  /** 本 bot 在群里的角色，决定首轮 prompt 怎么包（lead 编排 / collab 并列 / solo）。 */
  role: SpawnRole;
  /** 群里其它可协作的 bot（lead 用来列 sub bot、collab 用来提示同伴）。 */
  coworkers?: Coworker[];
  /** 会话标题，缺省取内容首行。 */
  title?: string;
  /** 是否在群里发一条可见的任务横幅（只由 creator/lead 那一次 spawn 发，避免 N 个 bot 重复刷屏）。 */
  postBanner?: boolean;
  /** 会话归属人 open_id（本 bot 作用域）；缺省回退本 bot 首个 allowedUser。 */
  ownerOpenId?: string;
  ownerUnionId?: string;
}

/** 在新建的飞书群里为某个 bot 拉起一条 chat-scope 会话（dashboard「创建会话」用）。
 *  column='in_progress' → 立即 forkWorker 把内容当首轮发给 CLI；
 *  column='backlog'     → 入待办池（parked：worker:null + session.queued + queuedPrompt），
 *                          等被激活（拖到进行中 / 点开始 / 群里来消息）再起 CLI。
 *  与调度器 new-topic spawn 同构，差别只在「可暂存不起」与角色包装。 */
export async function spawnDashboardSession(
  activeSessions: Map<string, DaemonSession>,
  refreshCliVersion: ((...args: any[]) => boolean) | undefined,
  args: SpawnDashboardSessionArgs,
): Promise<{ ok: true; sessionId: string } | { ok: false; error: string }> {
  const { larkAppId, chatId, content, column, role } = args;
  let bot: ReturnType<typeof getBot>;
  try { bot = getBot(larkAppId); } catch { return { ok: false, error: 'bot_not_found' }; }
  const locale = localeForBot(larkAppId);

  // chat-scope：锚点就是 chatId。先挡掉「同群同 bot 已有真会话」的撞键（会被
  // Map.set 覆盖而泄漏 worker）。queued 占位 / 纯 scratch 不算冲突。
  const anchor = chatId;
  const existing = activeSessions.get(sessionKey(anchor, larkAppId));
  if (existing && (existing.worker || existing.session.queued || isRelayableRealSession(existing))) {
    return { ok: false, error: 'session_exists' };
  }

  refreshCliVersion?.(bot.config.cliId, bot.config.cliPathOverride);

  // 可见任务横幅：只由 creator/lead 那次 spawn 发一条，给群成员交代这群是干嘛的。
  // 纯文本、不 @ 任何 bot，不会误触发其它 bot。rootMessageId 存它仅为留痕（chat-scope
  // 路由不看 rootMessageId）。失败不致命。横幅发完整内容——之前 slice(0,300) 会把超
  // 300 字的任务在群里截断（用户看着像"内容丢了"，其实会话拿到的是全文，只是横幅被切）。
  let bannerMessageId: string | undefined;
  if (args.postBanner) {
    try {
      const { sendMessage } = await import('../im/lark/client.js');
      bannerMessageId = await sendMessage(larkAppId, chatId, t('cmd.createSession.banner', { content }, locale));
    } catch (err: any) {
      logger.warn(`[createSession] banner send failed in ${chatId}: ${err?.message ?? err}`);
    }
  }

  // 按角色把原始 content 包成「首轮用户内容」（lead 前置编排前言 / collab 前置协作
  // 提示 / solo 原样）。park 与 in_progress 共用同一份——存进 queuedPrompt 的就是
  // 这份已包装内容，激活时直接喂给 buildNewTopicPrompt，保证待办池里起来的 lead
  // 也带编排上下文（coworkers 只有此刻可靠，激活时已无从重算）。
  const userContent = composeSpawnUserContent({ content, role, coworkers: args.coworkers, locale });

  const resolvedTitle = args.title || deriveSessionTitleFromContent(content);
  const session = sessionStore.createSession(chatId, bannerMessageId ?? chatId, resolvedTitle, 'group');
  const now = Date.now();
  session.larkAppId = larkAppId;
  session.scope = 'chat';
  session.ownerOpenId = args.ownerOpenId ?? getOwnerOpenId(larkAppId);
  session.creatorOpenId = session.ownerOpenId;
  if (args.ownerUnionId) session.ownerUnionId = args.ownerUnionId;
  session.lastMessageAt = new Date(now).toISOString();
  if (column === 'backlog') {
    session.queued = true;
    session.queuedPrompt = userContent;
    session.kanbanColumn = 'backlog';
  }

  // 钉 workingDir：oncall 绑定（弹框填了目录）/ bot 默认。都没有 → undefined，激活/开跑时
  // 会弹 /repo 卡片让用户在群里选仓库（复用普通新话题逻辑）。
  const workingDir = resolveDashboardSpawnWorkingDir(larkAppId, chatId);
  if (workingDir) session.workingDir = workingDir;
  sessionStore.updateSession(session);
  messageQueue.ensureQueue(anchor);

  const ds: DaemonSession = {
    session,
    worker: null,
    workerPort: null,
    workerToken: null,
    larkAppId,
    chatId,
    chatType: 'group',
    scope: 'chat',
    spawnedAt: sessionCreatedAtMs(session),
    cliVersion: getCurrentCliVersion(),
    lastMessageAt: now,
    hasHistory: false,
    workingDir,
    ownerOpenId: session.ownerOpenId,
    currentTurnTitle: resolvedTitle,
  };
  activeSessions.set(sessionKey(anchor, larkAppId), ds);

  if (column === 'backlog') {
    // Parked：不起 CLI。手动广播 session.spawned，让 dashboard 立刻显示待办池卡片
    // （forkWorker 才会自动发这个事件，parked 路径要自己发）。
    ds.pendingPrompt = userContent;
    dashboardEventBus.publish({ type: 'session.spawned', body: { session: composeRowFromActive(ds) } });
    logger.info(`[createSession] queued session ${session.sessionId.substring(0, 8)} (bot=${larkAppId}, chat=${chatId}, role=${role})`);
    return { ok: true, sessionId: session.sessionId };
  }

  // in_progress：立即开跑或弹 /repo 卡片（没钉目录时）。userContent 已按角色包装好。
  await forkOrShowRepoCard(ds, userContent);
  logger.info(`[createSession] spawned session ${session.sessionId.substring(0, 8)} (bot=${larkAppId}, chat=${chatId}, role=${role}, pendingRepo=${!!ds.pendingRepo})`);
  return { ok: true, sessionId: session.sessionId };
}

/** 激活一条 parked（待办池）会话：把暂存的 queuedPrompt 当首轮发给 CLI，清掉 queued
 *  标记。供「拖到进行中」「点开始」「群里来第一条消息」三个入口复用。已起过的会话
 *  （worker 在或 hasHistory）直接返回 already_active，幂等。 */
export async function activateQueuedSession(ds: DaemonSession): Promise<{ ok: boolean; error?: string }> {
  if (!ds.session.queued) {
    return (ds.worker && !ds.worker.killed) ? { ok: true } : { ok: false, error: 'not_queued' };
  }
  if (ds.worker && !ds.worker.killed) {
    // 不该发生（queued 一定 worker:null），但保险：清标记即可。
    ds.session.queued = false;
    ds.session.queuedPrompt = undefined;
    sessionStore.updateSession(ds.session);
    return { ok: true };
  }
  const content = ds.session.queuedPrompt ?? ds.pendingPrompt ?? '';
  ds.session.queued = false;
  ds.session.queuedPrompt = undefined;
  ds.pendingPrompt = undefined;
  // 激活即视为开始：从待办池挪到进行中，让卡片归位。
  if (ds.session.kanbanColumn === 'backlog') ds.session.kanbanColumn = 'in_progress';
  sessionStore.updateSession(ds.session);
  // 起会话或弹 /repo 卡片（没钉目录时）。content 已是包装好的首轮内容。
  await forkOrShowRepoCard(ds, content);
  logger.info(`[createSession] activated queued session ${ds.session.sessionId.substring(0, 8)} (bot=${ds.larkAppId}, pendingRepo=${!!ds.pendingRepo})`);
  return { ok: true };
}
