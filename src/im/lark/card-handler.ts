/**
 * Lark card action handler — processes button clicks and dropdown selections
 * from Feishu interactive cards.
 * Extracted from daemon.ts for modularity.
 */
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { basename as pathBasename, dirname, join } from 'node:path';
import { closeResidualIsLocal, describeCloseResidual } from '../../core/close-residual.js';
import { config } from '../../config.js';
import { getBot, getAllBots, getOwnerOpenId, getBotBrand } from '../../bot-registry.js';
import { canOperate, canTalk } from './event-dispatcher.js';
import { updateMessage, deleteMessage, replyMessage, sendMessage, sendUserMessage, sendEphemeralCard, getMessageDetail, isHumanOpenId, resolveUserUnionId as defaultResolveUserUnionId } from './client.js';
import { buildSessionCard, buildStreamingCard, buildTuiPromptCard, buildTuiPromptProcessingCard, buildGrantResultCard, getCliDisplayName, truncateContent, buildConfigCard, buildConfigQuotaCard, buildConfigTextCard, CONFIG_UNSET, buildRepoSelectCard, buildGoalHumanAttentionResolvedCard } from './card-builder.js';
import { codexServiceTierBadge } from '../../services/codex-service-tier.js';
import {
  findConfigField,
  applyConfigField,
  coerceConfigValue,
  getConfigCardData,
} from '../../services/bot-config-store.js';
import { updateBotGrantPrefs } from '../../services/grant-prefs-store.js';
import { MAX_GRANT_QUOTA } from '../../services/grant-policy.js';
import { writeTeamRoleFile, deleteTeamRoleFile } from '../../core/role-resolver.js';
import { addChatGrant, addGlobalGrant } from '../../services/grant-store.js';
import {
  checkNonce,
  clearPending,
  getPendingGrantLimits,
  getPendingMessage,
  markDenied,
  updatePendingGrantLimits,
} from './grant-pending.js';
import { normalizeGrantDurationOption, normalizeGrantQuotaOption } from '../../services/grant-policy.js';
import { claimOverloadNonce, releaseOverloadNonce } from './overload-nonce.js';
import {
  buildOverloadAlertCard,
  buildOverloadExpiredCard,
  OVERLOAD_ACTION_CLEAN_STOPPED,
  OVERLOAD_ACTION_SUSPEND_IDLE,
  OVERLOAD_ACTION_RESTART_BROWSER,
  OVERLOAD_ACTION_NOOP,
  buildOverloadBrowserFailureCard,
  type OverloadCardState,
} from '../../core/host-overload-alert.js';
import { restartBrowser, resolveBrowserTargets } from '../../core/browser-restart.js';
import { readGlobalConfig } from '../../global-config.js';
import { listOnlineDaemons } from '../../utils/daemon-discovery.js';
import { fetchDaemonIpc } from '../../core/daemon-ipc-auth.js';
import { recordObservedBots } from '../../services/observed-bots-store.js';
import {
  handleV3GateAction,
  isV3GateAction,
  type V3GateCardHandlerDeps,
} from './v3-gate-card-handler.js';
import type { V3GateActionValue } from './v3-gate-card.js';
import {
  handleV3BlockedAction,
  isV3BlockedAction,
  type V3BlockedCardHandlerDeps,
} from './v3-blocked-card-handler.js';
import type { V3BlockedActionValue, V3AskAnswerActionValue } from './v3-blocked-card.js';
import {
  handleV3LoopGrantAction,
  isV3LoopGrantAction,
  type V3LoopGrantCardHandlerDeps,
} from './v3-loop-grant-card-handler.js';
import type { V3LoopGrantActionValue } from './v3-loop-grant-card.js';
import {
  handleV3RevisitGrantAction,
  isV3RevisitGrantAction,
  type V3RevisitGrantCardHandlerDeps,
} from './v3-revisit-grant-card-handler.js';
import type { V3RevisitGrantActionValue } from './v3-revisit-grant-card.js';
import {
  handleV3RunSaveAction,
  isV3RunSaveAction,
  type V3RunSaveCardHandlerDeps,
} from './v3-run-save-card-handler.js';
import type { V3RunSaveActionValue } from './v3-run-save-card.js';
import {
  handleV3DistillationAction,
  isV3DistillationAction,
  type V3DistillationCardHandlerDeps,
} from './v3-distillation-card-handler.js';
import { handleAskCardAction, isAskCardAction } from './ask-card.js';
import { createCliAdapterSync } from '../../adapters/cli/registry.js';
import { buildClosedSessionCard } from '../../core/closed-session-card.js';
import { ttadkConfigModelChoices } from '../../setup/cli-selection.js';
import { logger } from '../../utils/logger.js';
import * as sessionStore from '../../services/session-store.js';
import { retryCooldownRemaining, markRetryAttempt } from '../../services/failed-turn-retry.js';
import { buildTurnContinuePrompt } from '../../services/turn-failure-notice.js';
import { loadFrozenCards, saveFrozenCards } from '../../services/frozen-card-store.js';
import { resumeStartsFresh } from '../../services/resume-fresh-policy.js';
import { cliHasNoRawPassthroughSurface } from '../../core/passthrough-commands.js';
import { forkWorker, sendWorkerInput, sendWorkerSessionInput, killWorker, closeSession as closeWorkerPoolSession, teardownAuthoritativePersistentBackingBeforeClose, scheduleCardPatch, parkStreamCard, clearUsageLimitState, cardUsageLimit, writableTerminalLinkFor, workerHasInitialized, sessionSupportsWebTerminal, readableTerminalUrlFor, resolvePrivateCardAudience, deliverWriteLinkCard, deliverEphemeralOrReply, CARD_POSTING_SENTINEL, requestSessionRestart, isSessionTransferring, getDaemonStreamingCardUsageSnapshot, withActiveSessionKeyLock, buildStreamingCardJson, canCommitStreamingCardPublication, continuePublishedStreamingCardPinChain, silentIdleCardFlag, dshRuntimeForSession, type WorkerSessionReplyOptions } from '../../core/worker-pool.js';
import { getSessionWorkingDir, buildNewTopicCliInput, getAvailableBots, persistStreamCardState, resumeSession, rememberLastCliInput, ensureSessionWhiteboard } from '../../core/session-manager.js';
import { markInitialUserTurnPending } from '../../core/initial-user-turn.js';
import { publishAttentionPatch, publishClosedSessionPatch, announcePendingRepoSession } from '../../core/session-activity.js';
import { fallbackTurnId, rehomeReplyTargetState } from '../../core/reply-target.js';
import { sendWorkerIpc } from '../../core/worker-ipc.js';
import { validateWorkingDir } from '../../core/working-dir.js';
import type { DaemonToWorker, DisplayMode, TermActionKey } from '../../types.js';
import { activeSessionKey, sessionKey, sessionAnchorId, frozenDisplayMode, markRepoCardConsumed, isActiveRepoCard } from '../../core/types.js';
import type { DaemonSession } from '../../core/types.js';
import { buildTerminalUrl } from '../../core/terminal-url.js';
import { emitGoalNarration } from '../../verified-delivery/narration.js';
import { getGoalParentNotification, type GoalParentNotificationRecord } from '../../services/goal-parent-notification-store.js';
import { closeGoalChat } from '../../services/goal-chat-store.js';
import { chatAppLink } from './lark-hosts.js';
import type { ProjectInfo } from '../../services/project-scanner.js';
import { createRepoWorktree, removeRepoWorktree, dirSuffixForBranch, pushWorktreeBranch } from '../../services/git-worktree.js';
import { withCodexAppContext } from '../../utils/codex-app-context.js';
import { isRemoteBackendSession, resolvePairedSpawnBackendType } from '../../core/persistent-backend.js';
import { sessionConfiguredRuntimeDisplayName } from '../../core/cli-runtime-display.js';
import { worktreeSlugFromContextAI } from '../../services/worktree-slug-ai.js';
import { t, localeForBot, isLocale, type Locale } from '../../i18n/index.js';
import {
  isLocalCliOpenCapable,
  isLocalCliOpenConfigured,
  isLocalCliOpenReady,
  localCliOpenMode,
  openLocalCliInIterm,
  preflightLocalCliOpen,
} from '../../services/local-cli-opener.js';
import { hasProtectedSessionMutationOwnership } from '../../core/session-mutation-guard.js';
import { persistPendingRepoCardMessageId } from '../../core/pending-repo-journal.js';
import { runDetachedBotTurnAdmission, withBotTurnAdmission, withBotTurnMutation } from '../../core/bot-turn-mutation-gate.js';
import { isSharedAdoptSession } from '../../core/shared-adopt.js';

// ─── Types ────────────────────────────────────────────────────────────────

export interface CardHandlerDeps {
  activeSessions: Map<string, DaemonSession>;
  sessionReply: (rootId: string, content: string, msgType?: string, larkAppId?: string, turnId?: string, opts?: WorkerSessionReplyOptions) => Promise<string>;
  lastRepoScan: Map<string, ProjectInfo[]>;
  /** v3 humanGate 审批卡点击处理（driveRun 由 daemon 接的 v3 gate runner 提供）. */
  v3GateDeps?: V3GateCardHandlerDeps;
  /** v3 blocked 重试卡点击处理（同一个 runner 的 driveRun）. */
  v3BlockedDeps?: V3BlockedCardHandlerDeps;
  /** v3 loop 追加一轮卡点击处理（同一个 runner 的 driveRun）. */
  v3LoopGrantDeps?: V3LoopGrantCardHandlerDeps;
  /** v3 回溯预算准许卡点击处理（同一个 runner 的 driveRun）. */
  v3RevisitGrantDeps?: V3RevisitGrantCardHandlerDeps;
  /** v3 成功终态卡的「保存复用」动作。 */
  v3RunSaveDeps?: V3RunSaveCardHandlerDeps;
  /** v3 参数蒸馏提案的接受/拒绝动作。 */
  v3DistillationDeps?: V3DistillationCardHandlerDeps;
  /** VC meeting invite/consumer card actions. Implemented in daemon to
   *  keep meeting sessions, tombstones, and listener-group state single-owned. */
  vcMeetingCardAction?: (data: CardActionData, larkAppId: string) => Promise<any>;
  /** Codex 完成通知卡动作。事件存储、App 打开和会话接管由 daemon 单点持有。 */
  codexNotifierCardAction?: (data: CardActionData, larkAppId: string) => Promise<any>;
  /** 授权成功后重放之前被拦截的消息，让用户无需再 @ 一遍。 */
  replayGrantedMessage?: (data: any, larkAppId: string) => void;
  /** 把 passthrough 命令（如 /compact）透传到仍存活的会话。由 daemon 接线到
   *  deliverPassthroughToExistingSession（raw_input 透传，含完整 turn 绑定/卡片冻结/
   *  turn-starting 逻辑）。未接线时 compact_session 走 unsupported toast 兜底。 */
  deliverPassthroughCommand?: (
    ds: DaemonSession,
    cmd: string,
    opts: {
      anchor: string;
      senderOpenId?: string;
      senderIsBot: boolean;
      messageId: string;
      replyRootId?: string;
    },
  ) => void;
}

/**
 * Lark card action callback envelope.
 *
 * Exported so module-specific dashboard handlers can share the callback type
 * without redeclaring it.
 *
 * Trust model:
 *   - `operator.open_id` and `operator.union_id` are Lark-verified payload
 *     fields. Treat them as the only legitimate source of caller identity.
 *   - `action.value` is round-tripped from the card schema and IS NOT
 *     verified by Lark. NEVER read identity fields (`union_id`, `open_id`,
 *     `user_id`, …) from `action.value`.
 */
export interface CardActionData {
  operator?: {
    open_id?: string;
    /** Lark-verified union_id, present on card v2 callbacks where the tenant
     *  enables `with_union_id`. Absent when Lark doesn't carry it; callers
     *  fall back to `resolveUserUnionId` via `resolveCardOperatorUnionId`. */
    union_id?: string;
  };
  action?: {
    value?: Record<string, string>;
    option?: unknown;
    options?: unknown;
    form_value?: Record<string, unknown>;  // V2 form input values
  };
  context?: { open_message_id?: string };
  open_message_id?: string;
}

/** Resolved operator identity returned by `resolveCardOperatorUnionId`. */
export interface CardOperatorIdentity {
  /** Verified `on_`-prefixed union_id, or `undefined` when verification fails. */
  unionId?: string;
  /** The verified `operator.open_id` echoed back for audit/log purposes. Never
   *  used as an authn/authz proxy when `unionId` is absent. */
  openId?: string;
}

/** Optional deps for `resolveCardOperatorUnionId` — production omits, tests
 *  inject a fake `resolveUserUnionId` to avoid hitting the Lark contact API. */
export interface ResolveCardOperatorUnionIdDeps {
  resolveUserUnionId?: (larkAppId: string, openId: string) => Promise<{ unionId?: string; name?: string }>;
}

/**
 * Resolve the verified `union_id` of the operator who clicked a card button.
 *
 * Three-state semantics:
 *  1. `operator.union_id` starts with `on_` → trust it directly.
 *  2. `operator.union_id` is present but does NOT start with `on_` (e.g.
 *     `ou_xxx`, malformed) → reject; do NOT fallback. Trusting `open_id`
 *     after a malformed verified field would be a bypass.
 *  3. `operator.union_id` is absent → fall back to
 *     `resolveUserUnionId(larkAppId, openId)`, accepting only `on_`-prefixed
 *     results.
 *
 * In every failure mode (missing open_id, fallback returns no unionId,
 * fallback throws) the function returns `{ openId }` with `unionId` left
 * undefined, so callers fail closed.
 *
 * `action.value` is NEVER read here — see the unit tests that pin that
 * contract.
 */
export async function resolveCardOperatorUnionId(
  data: CardActionData,
  larkAppId: string,
  deps: ResolveCardOperatorUnionIdDeps = {},
): Promise<CardOperatorIdentity> {
  const openId = data.operator?.open_id;
  if (!openId) return {};
  const verified = data.operator?.union_id;
  if (typeof verified === 'string') {
    // Verified field present — must be on_ prefix or we reject. Fallback is
    // deliberately skipped: a malformed verified identity is a stronger
    // negative signal than its absence.
    if (verified.startsWith('on_')) return { unionId: verified, openId };
    return { openId };
  }
  // Verified field absent — fallback to the contact API. Wrapped in try/catch
  // so resolver errors don't bubble up and surprise card-callback paths.
  const resolver = deps.resolveUserUnionId ?? defaultResolveUserUnionId;
  try {
    const { unionId } = await resolver(larkAppId, openId);
    if (typeof unionId === 'string' && unionId.startsWith('on_')) {
      return { unionId, openId };
    }
    return { openId };
  } catch {
    return { openId };
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function tag(ds: DaemonSession): string {
  return ds.session.sessionId.substring(0, 8);
}

const LEGACY_SELF_HEAL_ACTIONS = new Set(['toggle_display', 'toggle_stream', 'refresh_screenshot']);

// 🔊 语音总结 once-only guard: card message ids that already triggered a voice
// summary. Keyed by the clicked card's message id so any number of users
// clicking the same reply only ever generates ONE voice bubble (防刷屏).
// In-memory (per daemon lifetime) — a restart resets it, which at worst allows
// one re-trigger on an old card; acceptable. Capped to avoid unbounded growth.
const voicedCardIds = new Set<string>();

// Instruction injected into the session when the voice button is clicked. The
// model (which still has its just-sent reply in context) condenses it into
// spoken prose and emits it via `botmux send --voice`. Kept terse and explicit
// so the model produces ONE voice bubble and no stray text card. Resolved per
// the bot's locale so an English-mode bot gets the English instruction.
function voiceSummaryInstruction(locale?: Locale): string {
  return t('card.voice.summary_instruction', undefined, locale);
}

function isLiveWorkerIdleOrLimited(ds: DaemonSession): boolean {
  if (!ds.worker || ds.worker.killed) return true;
  return ds.lastScreenStatus === 'idle' || ds.lastScreenStatus === 'limited';
}

function isLegacySelfHealAction(actionType?: string): boolean {
  return !!actionType && LEGACY_SELF_HEAL_ACTIONS.has(actionType);
}

function shortHash(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 12);
}

function goalDecisionText(data: CardActionData): string {
  const form = data.action?.form_value ?? {};
  const formValue = form.goal_parent_decision_text;
  if (typeof formValue === 'string') return formValue.trim();
  const inputValue = (data.action as any)?.input_value;
  if (typeof inputValue === 'string') return inputValue.trim();
  return '';
}

function goalNotificationRecordFromAction(
  value: Record<string, string>,
  cardMessageId: string | undefined,
  larkAppId: string | undefined,
): GoalParentNotificationRecord | undefined {
  const stored = getGoalParentNotification(cardMessageId) ?? getGoalParentNotification(value.parent_message_id);
  if (stored) return stored;
  const parentChatId = value.parent_chat_id;
  const goalChatId = value.goal_chat_id;
  if (!parentChatId || !goalChatId || !larkAppId) return undefined;
  return {
    messageId: cardMessageId ?? value.parent_message_id ?? `card:${goalChatId}`,
    larkAppId: value.notification_lark_app_id || larkAppId,
    parentChatId,
    parentRoot: value.parent_root || undefined,
    parentSessionId: value.parent_session_id || undefined,
    supervisorSessionId: value.supervisor_session_id || undefined,
    goalChatId,
    goalTitle: value.goal_title || undefined,
    taskId: value.task_id || undefined,
    taskTitle: value.task_title || undefined,
    summary: value.summary || value.attention_reason || '',
    attentionKind: value.attention_kind || undefined,
    attentionReason: value.attention_reason || undefined,
    done: false,
    createdAt: Date.now(),
  };
}

function goalResolvedCard(record: GoalParentNotificationRecord, decisionText: string, decisionMode?: 'option' | 'free-text'): string {
  return buildGoalHumanAttentionResolvedCard({
    goalTitle: record.goalTitle,
    goalChatId: record.goalChatId,
    goalLink: chatAppLink(record.goalChatId, getBotBrand(record.larkAppId)),
    taskId: record.taskId,
    taskTitle: record.taskTitle,
    attentionKind: record.attentionKind,
    attentionReason: record.attentionReason,
    summary: record.summary,
    notificationMessageId: record.messageId,
    notificationLarkAppId: record.larkAppId,
    parentChatId: record.parentChatId,
    parentRoot: record.parentRoot,
    parentSessionId: record.parentSessionId,
    supervisorSessionId: record.supervisorSessionId,
    decisionText,
    decisionMode,
  });
}

async function routeGoalParentCardDecisionAcrossDaemons(
  record: GoalParentNotificationRecord,
  input: { cardMessageId?: string; decisionText: string },
): Promise<{ contacted: number; routed: number; deduped: number }> {
  const daemons = listOnlineDaemons();
  let contacted = 0;
  let routed = 0;
  let deduped = 0;
  const decisionId = `card:${input.cardMessageId ?? record.messageId}:${shortHash(input.decisionText)}`;
  await Promise.all(daemons.map(async (daemon) => {
    const ctrl = new AbortController();
    const tt = setTimeout(() => ctrl.abort(), 3_000);
    try {
      const res = await fetch(`http://127.0.0.1:${daemon.ipcPort}/api/goal/route-parent-reply`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          record,
          reply: {
            messageId: decisionId,
            content: `[中控卡片下发决策]\n${input.decisionText}`,
          },
        }),
        signal: ctrl.signal,
      });
      contacted++;
      if (!res.ok) return;
      const body = await res.json().catch(() => null) as { routed?: boolean; deduped?: boolean } | null;
      if (body?.routed && body.deduped) deduped++;
      else if (body?.routed) routed++;
    } catch {
      // Best-effort fan-out; dead peers age out of daemon discovery.
    } finally {
      clearTimeout(tt);
    }
  }));
  return { contacted, routed, deduped };
}

function getSessionByActionValue(
  activeSessions: Map<string, DaemonSession>,
  rootId: string | undefined,
  larkAppId: string | undefined,
  sessionId: string | undefined,
  actionType: string | undefined,
): DaemonSession | undefined {
  const primary = rootId && larkAppId ? activeSessions.get(sessionKey(rootId, larkAppId)) : undefined;
  if (primary && (!sessionId || primary.session.sessionId === sessionId)) return primary;

  if (sessionId) {
    for (const ds of activeSessions.values()) {
      if (ds.larkAppId === larkAppId && ds.session.sessionId === sessionId) return ds;
    }
  }

  // Legacy visible cards may carry a stale/closed session_id.  Only redirect
  // self-healing display actions to the current root session; sensitive actions
  // (close/restart/disconnect/get_write_link/term_action/...) must not operate
  // on a different current session just because an old card shared the root.
  if (primary && isLegacySelfHealAction(actionType)) return primary;
  return undefined;
}

function sessionCliId(ds: DaemonSession) {
  return ds.session.cliLaunchSnapshot?.cliId ?? ds.session.cliId ?? getBot(ds.larkAppId).config.cliId;
}


/** A session's configured distribution name is frozen with its launch config.
 * Never borrow today's bot runtime for an already-frozen legacy/official
 * session: a hot switch must not relabel old cards or action feedback. */
function sessionRuntimeDisplayName(ds: DaemonSession): string | undefined {
  return sessionConfiguredRuntimeDisplayName(
    ds.session,
    getBot(ds.larkAppId).config.cliRuntime,
  );
}

function sessionCliDisplayName(ds: DaemonSession): string {
  return sessionRuntimeDisplayName(ds) ?? getCliDisplayName(sessionCliId(ds));
}

/** Worktree selection always creates or starts a fresh session. Decide whether
 * that next session will use Riff from the live bot pairing after applying the
 * same invalid-pair reconciliation as forkWorker, rather than from the old
 * session stamp or the raw backendType alone. */
function nextSessionUsesRiffBackend(ds: DaemonSession): boolean {
  const botCfg = getBot(ds.larkAppId).config;
  const pendingSession = ds.pendingRepo === true;
  return resolvePairedSpawnBackendType(
    pendingSession ? sessionCliId(ds) : botCfg.cliId,
    pendingSession ? ds.session.backendType : undefined,
    botCfg.backendType,
    config.daemon.backendType,
  ) === 'riff';
}

function validateCardCliBinding(ds: DaemonSession, value?: Record<string, string>): boolean {
  const expected = value?.cli_id;
  if (!expected) return true;
  const actual = sessionCliId(ds);
  if (actual === expected) return true;

  // Backward-compat migration path: some already-visible Worker(CoCo) cards
  // were rendered with cli_id=claude-code before the binding fix.  Let only
  // display self-healing actions through so the handler can PATCH the clicked
  // card into the current session/CLI.  Never allow stale mismatched cards to
  // trigger sensitive/session-mutating actions.
  if (expected === 'claude-code' && actual !== 'claude-code' && isLegacySelfHealAction(value?.action)) {
    logger.warn(
      `[${tag(ds)}] Accepting legacy mismatched CLI card for self-heal: ` +
      `action=${value?.action ?? '?'} expected=${expected} actual=${actual}`,
    );
    return true;
  }

  logger.warn(
    `[${tag(ds)}] Ignoring card action from mismatched CLI card: ` +
    `action=${value?.action ?? '?'} expected=${expected} actual=${actual}`,
  );
  return false;
}

function stringListFromLarkMultiSelect(raw: unknown): string[] {
  const tokens = Array.isArray(raw)
    ? raw.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const token of tokens) {
    if (seen.has(token)) continue;
    seen.add(token);
    result.push(token);
  }
  return result;
}

function multiWorktreeParentPath(repoPaths: string[], name: string): string {
  const first = repoPaths[0];
  const parentRoot = first ? dirname(first) : process.cwd();
  return join(parentRoot, dirSuffixForBranch(name));
}

function worktreeChildNameForRepo(repoPath: string, projects: ProjectInfo[] | undefined): string {
  return projects?.find(p => p.path === repoPath)?.name ?? pathBasename(repoPath);
}

function duplicateMultiWorktreeChildNames(repoPaths: string[], projects: ProjectInfo[] | undefined): string[] {
  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const repoPath of repoPaths) {
    const childName = worktreeChildNameForRepo(repoPath, projects);
    if (seen.has(childName)) dupes.add(childName);
    else seen.add(childName);
  }
  return [...dupes];
}

function deferRepoCardWithdraw(larkAppId: string | undefined, messageId: string | undefined): void {
  if (!larkAppId || !messageId) return;
  // Let the card-action promise resolve so the SDK can send its callback ACK
  // before the original card disappears. A microtask is too early here: it may
  // run before the SDK continuation that serializes and writes the ACK frame.
  setImmediate(() => {
    void deleteMessage(larkAppId, messageId)
      .catch(err => logger.debug(`Repo card withdraw (post-callback) failed: ${err}`));
  });
}

/**
 * Commit a resolved working directory onto a repo-select session: pin it, then
 * either fork the pending CLI (first selection) or close + recreate the session
 * (mid-session switch). Shared by the dropdown flow, the worktree flow (which
 * funnels back in with the freshly created worktree path) and the manual
 * directory-entry form. Extracted to module scope so the form-submit branch can
 * reuse the exact same spawn/switch path instead of duplicating it.
 */
export async function commitRepoSelection(
  ctx: {
    ds: DaemonSession;
    rootId: string;
    cardMessageId?: string;
    larkAppId?: string;
    operatorOpenId?: string;
    activeSessions: Map<string, DaemonSession>;
    sessionReply: (rid: string, content: string, msgType?: string, turnId?: string) => Promise<string>;
  },
  dirPath: string,
  dirLabel: string,
  // The worktree flow already posted a precise "worktree 已创建：path 分支 …"
  // line before funnelling in here — suppress the redundant "已选择/已切换"
  // confirmation so the user sees a single message, not two.
  opts?: {
    suppressConfirmReply?: boolean;
    confirmReplyText?: string;
    pinWorkingDir?: boolean;
    riffRepoDirs?: string[];
  },
): Promise<boolean> {
  const { ds, rootId, cardMessageId, larkAppId, operatorOpenId, activeSessions, sessionReply } = ctx;
  const locTarget = localeForBot(ds.larkAppId);
  // `/close` deletes the active-map entry without touching sessionId or
  // pendingRepo — identity against the map is the only tell that the session
  // this flow captured is gone. Checked alongside the generation snapshots.
  const repoSessionKey = activeSessionKey(ds);
  const sessionStillActive = () => activeSessions.get(repoSessionKey) === ds;
  const commitGenSessionId = ds.session.sessionId;
  const pinWorkingDir = opts?.pinWorkingDir !== false;

  // Card callbacks are replayable. Only the currently published picker may
  // mutate this session; a withdrawn/replaced card must stay stale even after
  // the activation FIFO eventually settles. Internal auto-worktree commits do
  // not originate from a card and deliberately omit cardMessageId.
  if (cardMessageId !== undefined
    && (!ds.repoCardMessageId || cardMessageId !== ds.repoCardMessageId)) {
    logger.warn(
      `[${tag(ds)}] Ignoring stale repo-card callback ${cardMessageId} `
      + `(current=${ds.repoCardMessageId ?? 'none'})`,
    );
    return false;
  }

  // A live REMOTE generation (Riff or Mojo) cannot use the generic
  // close-and-refork branch. Remote teardown is a prepare/commit protocol; a
  // failed cancellation followed by forkWorker would reach the double-fork
  // kill and orphan the still-live remote task. Require an explicit /close
  // before any card, worktree, or manual-directory selection can replace this
  // generation. (Fourth-round review: the riff-only predicate left the card
  // entry point open for mojo.)
  if (!ds.pendingRepo && isRemoteBackendSession(ds)) {
    await sessionReply(rootId, t('cmd.cd.remote_unsupported', undefined, locTarget));
    logger.warn(`[${tag(ds)}] Repo switch refused: remote session requires explicit close before replacement`);
    return false;
  }

  if (!ds.pendingRepo
    && hasProtectedSessionMutationOwnership(ds)) {
    await sessionReply(
      rootId,
      '当前会话仍有待提交消息，暂不能切换仓库；请等待提交完成或关闭会话。',
    );
    return false;
  }

  if (ds.pendingRepo) {
    const targetSessionId = ds.session.sessionId;
    ds.pendingRepoCommitInFlight = true;
    try {
      const started = await withBotTurnMutation(ds.larkAppId, async () => {
      const current = [...activeSessions.values()].find(
        candidate => candidate.session.sessionId === targetSessionId
          && candidate.session.status === 'active',
      );
      if (!current || current !== ds || !current.pendingRepo) return false;
      // "Start directly" launches in the resolved default cwd without pinning
      // HOME onto the session for sibling-bot inheritance.
      if (pinWorkingDir) {
        ds.workingDir = dirPath;
        ds.session.workingDir = dirPath;
      }
      // riff 多仓 stamp：只有多仓 worktree 流显式传入（保留用户选择顺序，首仓=primary）；
      // 其它选仓路径一律清除旧 stamp——workingDir 变了，旧的多仓组合不再成立。
      ds.session.riffRepoDirs = opts?.riffRepoDirs;
      sessionStore.updateSession(ds.session);
      const selfBot = getBot(ds.larkAppId);
      const botCfg = selfBot.config;
      const effectiveCliId = sessionCliId(ds);

      // Keep pendingRepo=true across this await. New topic messages therefore
      // remain buffered on this same session instead of racing a worker-null
      // safety-net fork. Snapshot every pending field only after it settles.
      const needsPromptContext = !ds.pendingRawInput ||
        (ds.pendingPrompt?.trim().length ?? 0) > 0 ||
        (ds.pendingAttachments?.length ?? 0) > 0 ||
        (ds.pendingFollowUps?.length ?? 0) > 0 ||
        ds.pendingChatContext !== undefined;
      const availableBots = needsPromptContext
        ? await getAvailableBots(ds.larkAppId, ds.chatId)
        : [];
      if (!sessionStillActive() || ds.session.sessionId !== commitGenSessionId ||
          !ds.pendingRepo || (ds.worker && !ds.worker.killed)) {
        logger.warn(`[${tag(ds)}] Session changed while preparing the pending-CLI prompt (${commitGenSessionId} → ${ds.session.sessionId}, active=${sessionStillActive()}, pending=${!!ds.pendingRepo}, worker=${!!ds.worker}) — aborting this fork`);
        return;
      }

      const pendingPrompt = ds.pendingPrompt ?? '';
      const pendingRawInput = ds.pendingRawInput;
      // Raw-input cold start still wraps any input buffered while the repo card
      // was pending — see the skip_repo branch for the rationale.
      const hasBufferedInput =
        pendingPrompt.trim().length > 0 ||
        ds.pendingCodexAppText !== undefined ||
        (ds.pendingAttachments?.length ?? 0) > 0 ||
        (ds.pendingFollowUps?.length ?? 0) > 0 ||
        ds.pendingChatContext !== undefined;
      // Nothing to submit at all (session created by a bare `/repo`, i.e. the
      // message IS the command). Boot the CLI idle instead of burning an empty
      // `<user_message>` opening on it, and mark the session so the user's NEXT
      // real message becomes the new-topic first turn. Mirrors the text
      // `/repo` path in command-handler's forkPendingCli.
      const emptyStart = !pendingRawInput && !hasBufferedInput;
      if (!pendingRawInput || hasBufferedInput) ensureSessionWhiteboard(ds);
      const wrappedInput = hasBufferedInput
        ? buildNewTopicCliInput(
            pendingPrompt,
            ds.session.sessionId,
            effectiveCliId,
            botCfg.cliPathOverride,
            ds.pendingAttachments,
            ds.pendingMentions,
            availableBots,
            ds.pendingFollowUps,
            { name: selfBot.botName, openId: selfBot.botOpenId },
            locTarget,
            ds.pendingSender,
            {
              larkAppId: ds.larkAppId,
              chatId: ds.chatId,
              whiteboardId: ds.session.whiteboardId,
              substituteTrigger: ds.pendingSubstituteTrigger,
              codexAppText: ds.pendingCodexAppText,
              codexAppApplicationContext: ds.pendingCodexAppApplicationContext,
              codexAppMessageContext: ds.pendingCodexAppMessageContext,
              codexAppFollowUps: ds.pendingCodexAppFollowUps,
              codexAppFollowUpContexts: ds.pendingCodexAppFollowUpContexts,
              chatContext: ds.pendingChatContext,
            },
          )
        : undefined;
      const prompt = pendingRawInput ? '' : (wrappedInput ?? '');
      // Last-line defence: prompt prep awaited above — if anything replaced
      // OR closed the session in that window, forking now would clobber it
      // (or resurrect a /close'd session).
      if (!sessionStillActive() || ds.session.sessionId !== commitGenSessionId) {
        logger.warn(`[${tag(ds)}] Session replaced or closed while preparing the pending-CLI prompt (${commitGenSessionId} → ${ds.session.sessionId}, active=${sessionStillActive()}) — aborting this fork`);
        return false;
      }
      if (pendingRawInput && hasBufferedInput && wrappedInput) {
        ds.pendingFollowUpInput = {
          userPrompt: ds.pendingCodexAppText !== undefined || ds.pendingCodexAppFollowUps
            ? [ds.pendingCodexAppText ?? '', ...(ds.pendingCodexAppFollowUps ?? [])].filter(Boolean).join('\n\n')
            : pendingPrompt || ds.pendingFollowUps?.join('\n\n') || '',
          cliInput: wrappedInput.content,
          ...((ds.pendingFollowUpTurnIds?.at(-1) ?? ds.pendingFollowUpTurnId)
            ? { turnId: ds.pendingFollowUpTurnIds?.at(-1) ?? ds.pendingFollowUpTurnId }
            : {}),
          ...(effectiveCliId === 'codex-app' && botCfg.codexAppCleanInput === true && wrappedInput.codexAppInput
            ? { codexAppInput: wrappedInput.codexAppInput }
            : {}),
          codexAppInputGateFrozen: true,
        };
      }
      if (pendingRawInput) rememberLastCliInput(ds, pendingRawInput, pendingRawInput);
      else if (hasBufferedInput && wrappedInput) rememberLastCliInput(ds, pendingPrompt, wrappedInput);
      // Keep the reservation and every buffered opening field intact through
      // forkWorker's synchronous pre-accept/write-ahead phase. If it throws,
      // the user can retry this exact selection without losing the first turn.
      const pendingTurnId = ds.pendingTurnId ?? ds.session.pendingRepoSetup?.turnId;
      forkWorker(
        ds,
        prompt,
        !pendingRawInput && pendingTurnId ? { turnId: pendingTurnId } : false,
      );
      ds.pendingRepo = false;
      // A queued activation owns the route through its adapter-level ACK. Every
      // buffer below was synchronously folded into prompt N and is safe to clear;
      // later inbounds observe this gate and enter the separate exact staged FIFO.
      ds.initialStartPending = ds.session.queuedActivationPending === true;
      publishAttentionPatch(ds);
      // Durable, one-shot: the CLI is up but has never received a real user turn.
      // Bare `/repo` idle-booted above (empty prompt, no turn); mark the session
      // so the user's NEXT real message becomes the new-topic first turn.
      if (emptyStart) markInitialUserTurnPending(ds);
      ds.pendingPrompt = undefined;
      ds.pendingCodexAppText = undefined;
      ds.pendingCodexAppApplicationContext = undefined;
      ds.pendingCodexAppMessageContext = undefined;
      ds.pendingChatContext = undefined;
      ds.pendingAttachments = undefined;
      ds.pendingMentions = undefined;
      ds.pendingSubstituteTrigger = undefined;
      ds.pendingSender = undefined;
      ds.pendingFollowUps = undefined;
      ds.pendingFollowUpTurnId = undefined;
      ds.pendingFollowUpTurnIds = undefined;
      ds.pendingCodexAppFollowUps = undefined;
      ds.pendingCodexAppFollowUpContexts = undefined;
      ds.pendingCodexAppFollowUpGateAccepted = undefined;
      ds.pendingTurnId = undefined;
      return true;
      });
      if (!started) return false;
      // Invalidate synchronously at the successful commit boundary. Card
      // withdrawal and confirmation are best effort and may await/fail;
      // neither may leave a replayable mutation capability behind.
      const cardToWithdraw = cardMessageId ?? ds.repoCardMessageId;
      markRepoCardConsumed(ds, cardToWithdraw);
      ds.repoCardMessageId = undefined;
      // Keep the pending-selection claim until the confirmation attempt
      // settles. This prevents a second picker action from reinterpreting the
      // freshly-started session as a mid-session repository switch.
      try {
        if (!opts?.suppressConfirmReply) {
          await sessionReply(
            rootId,
            t('cmd.repo.selected_in_pending', { name: dirLabel }, locTarget),
            undefined,
            fallbackTurnId(ds, undefined),
          );
        } else if (opts.confirmReplyText) {
          await sessionReply(
            rootId,
            opts.confirmReplyText,
            undefined,
            fallbackTurnId(ds, undefined),
          );
        }
      } catch (err) {
        logger.warn(
          `[${tag(ds)}] Confirm reply after pending repo commit failed: `
          + `${err instanceof Error ? err.message : String(err)}`,
        );
      }
      // Withdrawal is deliberately detached so the card callback can ACK
      // before Lark observes that the source message disappeared.
      deferRepoCardWithdraw(larkAppId, cardToWithdraw);
      logger.info(`[${tag(ds)}] Repo selected: ${dirPath}, spawning CLI`);
      return true;
    } finally {
      ds.pendingRepoCommitInFlight = false;
    }
  } else {
    // Mid-session repo switch — close old session, start fresh.
    // ZMX close is identity/generation verified and may refuse. Prove teardown
    // before mutating any old-session state; on refusal the current session and
    // card remain fully retryable. (The in-lock closeWorkerPoolSession below
    // repeats teardown close-wins; this pre-guard fail-closes on transfer.)
    try {
      teardownAuthoritativePersistentBackingBeforeClose(ds);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      logger.warn(`[${tag(ds)}] Repo switch refused because backing teardown was not proven: ${reason}`);
      try {
        await sessionReply(rootId, t('cmd.repo.switch_close_failed', { error: reason }, locTarget));
      } catch (replyErr) {
        logger.warn(`[${tag(ds)}] Repo-switch teardown failure reply failed: ${replyErr instanceof Error ? replyErr.message : replyErr}`);
      }
      return false;
    }

    // Safety net (mirrors the `/repo` text-command path): build the same
    // "session closed" card `/close` emits BEFORE displacing the old session
    // (it reads the live session's identity off `ds`). The new session reuses
    // this anchor, so the old context would otherwise vanish without a trace
    // (relay/adopt/resume all hit `anchor_occupied`). The card keeps it
    // visible and carries the terminal `claude --resume` command.
    //
    // The new cwd is NOT written onto the old session here — it would pollute
    // the displaced session's stored workingDir (and the closed card), so
    // `claude --resume` later would reopen the old context in the new repo's
    // cwd. The new repo is pinned onto the fresh session below instead.
    const targetSessionId = ds.session.sessionId;
    const switched = await withBotTurnMutation(ds.larkAppId, async () => {
      const candidate = [...activeSessions.values()].find(
        candidate => candidate.session.sessionId === targetSessionId,
      );
      if (!candidate || candidate !== ds || candidate.session.status !== 'active') {
        return { ok: false as const, error: 'session_replaced' as const };
      }
      const key = activeSessionKey(candidate);
      return withActiveSessionKeyLock(activeSessions, key, async () => {
        const current = [...activeSessions.values()].find(
          owner => owner.session.sessionId === targetSessionId,
        );
        if (!current || current !== candidate
          || activeSessions.get(key) !== current
          || current.session.status !== 'active') {
          return { ok: false as const, error: 'session_replaced' as const };
        }
        if (hasProtectedSessionMutationOwnership(current)) {
          return { ok: false as const, error: 'dispatch_pending' as const };
        }
        const closedCard = buildClosedSessionCard(current, locTarget);
        // Preserve the old card in memory before durable close clears its old
        // frozen-card file; it is re-keyed under the replacement session below.
        parkStreamCard(current);
        const oldSession = current.session;
        const closeResult = await closeWorkerPoolSession(targetSessionId);
        // A refused close (remote cancellation unproven) leaves the row ACTIVE on
        // purpose. Deleting the owner anyway would strand an active row with no
        // owner — a ghost — while the remote session keeps running and holding the
        // injected credential. Abort the switch instead. (Same guard as the text
        // /repo path in command-handler.)
        if (!closeResult.ok) {
          return { ok: false as const, error: 'close_refused' as const };
        }
        if (closeResult.outcome === 'closed_with_residual') {
          // Same rule as the text /repo path: picking a directory is not consent
          // to leave a remote session running, so stop instead of spawning a
          // replacement on top of it.
          return {
            ok: false as const,
            error: 'close_residual' as const,
            residual: closeResult.residual,
          };
        }
        if (activeSessions.get(key) === current) activeSessions.delete(key);
        if (activeSessions.has(key)) {
          return { ok: false as const, error: 'session_replaced' as const };
        }
        const cardToWithdraw = cardMessageId ?? current.repoCardMessageId;
        markRepoCardConsumed(current, cardToWithdraw);
        current.repoCardMessageId = undefined;

        const session = sessionStore.createSession(
          current.chatId,
          current.scope === 'chat' ? oldSession.rootMessageId : rootId,
          dirLabel,
          current.chatType,
          current.scope,
        );
        current.session = session;
        current.lastUserPrompt = undefined;
        current.lastCliInput = undefined;
        current.workingDir = dirPath;
        session.workingDir = dirPath;
        session.larkAppId = current.larkAppId;
        session.chatDisplayName = oldSession.chatDisplayName;
        session.ownerOpenId = oldSession.ownerOpenId;
        session.creatorOpenId = oldSession.creatorOpenId;
        session.lastCallerOpenId = oldSession.lastCallerOpenId;
        session.riffRepoDirs = opts?.riffRepoDirs;
        sessionStore.updateSession(session);
        current.hasHistory = false;
        if (current.frozenCards && current.frozenCards.size > 0) {
          saveFrozenCards(session.sessionId, current.frozenCards);
        }
        current.streamCardId = undefined;
        current.streamCardNonce = undefined;
        rehomeReplyTargetState(current);
        current.streamCardPending = undefined;
        current.lastScreenContent = undefined;
        current.lastScreenStatus = undefined;
        activeSessions.set(key, current);
        forkWorker(current, '', false);
        // Brand-new CLI in a brand-new session record: the next real business
        // message is its new-topic first turn (same invariant as the pending path).
        markInitialUserTurnPending(current);
        return { ok: true as const, current, closedCard, cardToWithdraw };
      });
    });
    if (!switched.ok) {
      if (switched.error === 'dispatch_pending') {
        await sessionReply(
          rootId,
          '当前 Codex App 仍有未结算消息，暂不能切换仓库；请等待本轮完成或关闭会话。',
        );
      } else if (switched.error === 'close_residual') {
        await sessionReply(
          rootId,
          closeResidualIsLocal(switched.residual)
            ? '⚠️ 原会话已在本地关闭、远端会话已取消，但**本机可能残留带凭证的子进程未确认终止**'
              + `（${describeCloseResidual(switched.residual)}），请人工核查该主机进程。\n`
              + '**未创建新会话** —— 请先确认该子进程已终止，再重新切换仓库。'
            : '⚠️ 原会话已在本地关闭，但它的远端会话未能取消（控制面无法验证），'
              + `需要人工清理：\`${switched.residual.taskId}\`。\n`
              + '**未创建新会话** —— 请先处理遗留的远端会话，再重新切换仓库。',
        );
      } else if (switched.error === 'close_refused') {
        // Without this the user taps the card and gets nothing back, while the old
        // session is still active and its remote session still running.
        await sessionReply(
          rootId,
          '⚠️ 无法切换仓库：原会话的远端会话未能确认取消，已保留原会话以便重试。请稍后重试。',
        );
      }
      return false;
    }
    await deliverEphemeralOrReply(
      switched.current,
      operatorOpenId,
      switched.closedCard,
      'interactive',
      () => sessionReply(rootId, switched.closedCard, 'interactive'),
    );
    if (!opts?.suppressConfirmReply) {
      try {
        await sessionReply(rootId, t('cmd.repo.switched_to', { name: dirLabel }, locTarget));
      } catch (e) {
        logger.warn(`[${tag(ds)}] Confirm reply after mid-session repo switch failed: ${e instanceof Error ? e.message : e}`);
      }
    }
    // Return the callback ACK before recalling the card. Lark can keep the
    // delete request pending; awaiting it here stalls the card action and lets
    // the client retry an otherwise successful repository switch.
    deferRepoCardWithdraw(larkAppId, switched.cardToWithdraw);
    logger.info(`[${tag(switched.current)}] Repo switched to ${dirPath}, new session created`);
  }

  return true;
}

/**
 * 仅默认目录 + auto-worktree 的**异步**提交：`ds` 必须已注册进 activeSessions 且处于
 * `pendingRepo` 挂起态（prompt 已 buffer，入站路由不会去抢 fork——见 daemon.ts pendingRepo
 * 分支），本函数在**关键路径之外**（调用方 `void` 掉、立即返回）跑：
 *   1) 在 `baseDir` 建独立 worktree（非 git / 失败 → 回退 baseDir，均经 `notify` 发提示）
 *   2) 用与「选仓库卡」完全相同的 {@link commitRepoSelection} 提交该目录并 fork——复用其
 *      prompt 重建（会 fold 进等待期间 buffer 的后续消息）、代际守卫、僵尸防护。
 *
 * 这样避免了把 git fetch（可长达 30s）同步塞进 spawn/fork 链路的三宗罪：放大重复 spawn
 * 竞态、worker=null 期间被路由在**基目录**抢 fork、阻塞 dashboard/webhook 响应。
 *
 * 永不抛出：worktree 失败已在内部回退；commitRepoSelection 异常被兜底 log（会话仍留在
 * pendingRepo，用户可 /repo 自救），绝不让 unhandled rejection 掀掉 daemon。
 */
export async function runAutoWorktreeCommit(deps: {
  ds: DaemonSession;
  anchor: string;
  larkAppId: string;
  baseDir: string;
  title?: string;
  prompt?: string;
  operatorOpenId?: string;
  activeSessions: Map<string, DaemonSession>;
  notify: (message: string) => Promise<unknown> | void;
}): Promise<void> {
  const { ds, anchor, larkAppId, baseDir, title, prompt, operatorOpenId, activeSessions, notify } = deps;
  ds.worktreeCreating = true;
  // Surface the pending row NOW (all three callers funnel through here, so this is
  // the single place that guarantees the session is visible on SSE-only dashboards
  // during the up-to-30s build) — commitRepoSelection's forkWorker is what would
  // otherwise emit session.spawned, far too late.
  announcePendingRepoSession(ds);
  try {
    const { maybeCreateDefaultWorktree } = await import('../../services/default-worktree.js');
    const wt = await maybeCreateDefaultWorktree(larkAppId, baseDir, {
      isBotDefaultDir: true, title, prompt, locale: localeForBot(larkAppId), notify,
    });
    // The pendingRepo placeholder can legitimately be consumed WHILE this
    // up-to-30s build runs — e.g. the Codex-notifier「继续处理」callback adopts
    // the same DM session and clears pendingRepo before we get here. If we now
    // funneled into commitRepoSelection, its mid-session branch would kill the
    // freshly-adopted worker and replace it with a botmux-owned worktree
    // session. Bail on the late result instead: the takeover already owns the
    // session. (commitRepoSelection also re-checks pendingRepo under its claim,
    // but that check runs after an await — fence here before any mutation.)
    if (!ds.pendingRepo) {
      logger.info(`[${tag(ds)}] auto-worktree completion ignored — pendingRepo already consumed (session taken over)`);
      return;
    }
    // Commit even on fallback (wt.dir === baseDir) — the session must still start.
    // commitRepoSelection has its own /close + generation guards and, for a
    // pendingRepo session, folds any messages buffered during creation (pendingPrompt
    // + pendingFollowUps) into the first turn. suppressConfirmReply: the worktree
    // helper already posted the '已创建/回退' line, so skip the '已选择' confirmation.
    // The worktree build is intentionally detached from its caller's inbound
    // admission. Re-enter with a fresh lease at the delayed commit/fork edge;
    // the outer lease may have ended minutes ago and must not authorize this
    // descendant across a bot-wide config mutation.
    await runDetachedBotTurnAdmission(larkAppId, () => commitRepoSelection(
      {
        ds, rootId: anchor, larkAppId, operatorOpenId, activeSessions,
        // Never reached under suppressConfirmReply for a pendingRepo session.
        sessionReply: async () => '',
      },
      wt.dir,
      pathBasename(wt.dir),
      { suppressConfirmReply: true },
    ));
  } catch (e) {
    // No recovery fork here: forking with an empty prompt would DROP the buffered
    // first turn (pendingPrompt lives only in-memory, not the message queue). Leave
    // the session as commitRepoSelection left it — the inbound router's worker=null
    // branch re-forks (with the pinned dir) on the user's next message, and a still-
    // pending session keeps buffering. Loud log so the rare mid-commit throw is seen.
    logger.error(`[${tag(ds)}] auto-worktree commit failed (session recoverable on next message): ${e instanceof Error ? e.message : e}`);
  } finally {
    ds.worktreeCreating = false;
  }
}

// ─── Main handler ─────────────────────────────────────────────────────────

/**
 * Drive a host-overload降压 sweep across daemons.
 *
 * Both modes fan out to EVERY online daemon and sum the affected counts. Each
 * daemon owns one bot-scoped session store and its own live workers, so neither
 * stopped sessions nor idle workers can be swept through a sibling daemon.
 *
 * Fail-closed on partial failure: if ANY discovered daemon doesn't ACK, throw —
 * the caller then rolls back the nonce (releaseOverloadNonce) so the owner can
 * retry, instead of burning the button on a card that reports「已清理 0」while
 * the daemon that actually held the zombies never ran. Both sweeps are
 * idempotent (an already-closed session leaves the stopped set; an already-
 * suspended worker leaves the idle set), so a retry only re-hits whatever
 * failed. Reporting a partial count as a completed action would resurrect the
 * exact "显示 0、实际没清" symptom this fix exists to kill — just triggered by
 * "the daemon holding the zombies failed" instead of "the first daemon had none".
 */
async function sweepHostOverload(mode: 'clean_stopped' | 'suspend_idle'): Promise<number> {
  const daemons = listOnlineDaemons();
  if (daemons.length === 0) throw new Error(`sweep ${mode}: no online daemon`);

  const postSweep = async (d: { ipcPort: number; larkAppId: string }): Promise<number | null> => {
    try {
      const res = await fetchDaemonIpc(d.ipcPort, '/api/host-overload/sweep', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mode }),
      });
      const body: any = await res.json().catch(() => ({}));
      if (res.ok && body?.ok && typeof body.affected === 'number') return body.affected;
      logger.warn(`[overload-sweep] daemon ${d.larkAppId} returned ${res.status} ${JSON.stringify(body)}`);
      return null;
    } catch (err) {
      logger.warn(`[overload-sweep] daemon ${d.larkAppId} unreachable: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  };

  // Fan out to all daemons and sum. Fail the whole action if ANY didn't ACK, so
  // the caller keeps the button retriable rather than reporting a partial sweep
  // as complete.
  const results = await Promise.all(daemons.map(postSweep));
  const failed = results.filter(n => n === null).length;
  if (failed > 0) {
    throw new Error(`sweep ${mode}: ${failed}/${daemons.length} daemon(s) did not ack — retriable`);
  }
  return results.reduce((sum: number, n) => sum + (n ?? 0), 0);
}

/**
 * Machine-wide counts for the overload alert preview. Each daemon reports its
 * bot-scoped stopped sessions and its own live workers, so both fields must be
 * summed. Best-effort: an unreachable daemon just contributes 0.
 */
export async function countHostOverload(): Promise<{ stopped: number; idle: number }> {
  const daemons = listOnlineDaemons();
  let stopped = 0;
  let idle = 0;
  await Promise.all(daemons.map(async (d) => {
    try {
      const res = await fetchDaemonIpc(d.ipcPort, '/api/host-overload/counts', { method: 'GET' });
      const body: any = await res.json().catch(() => ({}));
      if (res.ok && body?.ok) {
        if (typeof body.stopped === 'number') stopped += body.stopped;
        if (typeof body.idle === 'number') idle += body.idle;
      }
    } catch { /* unreachable daemon contributes 0 */ }
  }));
  return { stopped, idle };
}

/** Resolve a card's actual visible placement from Lark, not action.value
 * (which is round-tripped client data and therefore untrusted). */
async function cardReplyOptions(
  larkAppId: string | undefined,
  cardMessageId: string | undefined,
  expectedChatId: string,
): Promise<WorkerSessionReplyOptions | undefined> {
  if (!larkAppId || !cardMessageId) return undefined;
  try {
    const detail = await getMessageDetail(larkAppId, cardMessageId);
    const item = detail?.items?.[0];
    if (!item || item.chat_id !== expectedChatId) return undefined;
    return item.thread_id
      ? { replyTarget: { mode: 'thread', rootMessageId: cardMessageId } }
      : { replyTarget: { mode: 'plain', chatId: item.chat_id } };
  } catch (err) {
    logger.debug(`card reply-placement probe failed; preserving legacy route: ${err}`);
    return undefined;
  }
}

export async function handleCardAction(data: CardActionData, deps: CardHandlerDeps, larkAppId?: string): Promise<any> {
  const { activeSessions, lastRepoScan } = deps;
  // turnId is forwarded only when the caller actually has a turn anchor
  // (e.g. the pendingRepo confirmation) — most card actions have none.
  const sessionReply = (rid: string, content: string, msgType?: string, turnId?: string) =>
    turnId !== undefined
      ? deps.sessionReply(rid, content, msgType, larkAppId, turnId)
      : deps.sessionReply(rid, content, msgType, larkAppId);
  const action = data?.action;
  const value = action?.value;
  const cardMessageId = data?.context?.open_message_id ?? data?.open_message_id;

  if (logger.isDebug()) {
    logger.debug(
      `[card] app=${larkAppId ?? '?'} op=${data?.operator?.open_id ?? '?'} ` +
      `action=${value?.action ?? action?.option ?? '?'} root=${value?.root_id ?? '?'}`,
    );
  }

  // Check ALLOWED_USERS for sensitive actions.
  // Use the receiving bot's allowedUsers — the operator open_id in card actions
  // is scoped to the app that received the callback.
  const operatorOpenId = data?.operator?.open_id;
  // ─── 机器过载告警卡动作（overload_clean_stopped / overload_suspend_idle / noop）──
  // 不绑 session。owner 强闸门 + nonce 一次性核销（每按钮各一次，防重复点/超时重投/旧卡）。
  // 点完不替换成死卡：重建同一张卡，把点过的按钮标 done+数量并 disabled，另一个仍可点。
  if (value?.action === OVERLOAD_ACTION_NOOP) {
    // 已完成的按钮（disabled 兜底）——个别客户端仍会回调，给个 toast 不做任何事。
    return { toast: { type: 'info', content: '该操作已执行过' } };
  }
  if (value?.action === 'goal_parent_decision' || value?.action === 'goal_parent_decision_option') {
    const isOptionDecision = value.action === 'goal_parent_decision_option';
    const decisionText = isOptionDecision ? (value.decision_text ?? '').trim() : goalDecisionText(data);
    if (!decisionText) {
      return { toast: { type: 'error', content: isOptionDecision ? '选项内容为空，无法下发。' : '请先输入要下发给监管者的决策。' } };
    }
    const record = goalNotificationRecordFromAction(value, cardMessageId, larkAppId);
    if (!record) {
      return { toast: { type: 'error', content: '缺少 goal 通知上下文，无法下发。' } };
    }
    if (larkAppId && !canTalk(larkAppId, record.parentChatId, operatorOpenId)) {
      logger.info(`[goal-parent-decision] blocked card submit from non-authorized user: ${operatorOpenId ?? '?'} chat=${record.parentChatId}`);
      return { toast: { type: 'error', content: '你没有权限下发这个 goal 决策。' } };
    }
    const result = await routeGoalParentCardDecisionAcrossDaemons(record, { cardMessageId, decisionText });
    if (result.routed === 0 && result.deduped === 0) {
      logger.warn(`[goal-parent-decision] no active L2 for goal=${record.goalChatId} card=${cardMessageId ?? '?'} contacted=${result.contacted}`);
      return { toast: { type: 'error', content: '没有在线监管者，稍后可重试或直接在主群补充说明。' } };
    }
    logger.info(`[goal-parent-decision] routed card decision goal=${record.goalChatId} task=${record.taskId ?? '-'} routed=${result.routed} deduped=${result.deduped}`);
    return JSON.parse(goalResolvedCard(record, decisionText, isOptionDecision ? 'option' : 'free-text'));
  }

  if (value?.action && (value.action === OVERLOAD_ACTION_CLEAN_STOPPED || value.action === OVERLOAD_ACTION_SUSPEND_IDLE) && larkAppId) {
    const loc = localeForBot(larkAppId);
    const owner = getOwnerOpenId(larkAppId);
    if (!operatorOpenId || operatorOpenId !== owner) {
      logger.info(`Overload action "${value.action}" blocked for non-owner: ${operatorOpenId}`);
      return { toast: { type: 'error', content: '仅管理员可操作' } };
    }
    // Parse the card state carried on the button. Missing/corrupt → treat as a
    // stale card (daemon restart drops the nonce too).
    let st: OverloadCardState;
    try { st = JSON.parse(value.st ?? ''); } catch { return JSON.parse(buildOverloadExpiredCard()); }
    if (!st?.nonce) return JSON.parse(buildOverloadExpiredCard());
    // One-shot per (nonce, action): the OTHER button on the same card stays
    // clickable (different action), but this button can't re-fire.
    if (!claimOverloadNonce(st.nonce, value.action)) {
      return JSON.parse(buildOverloadExpiredCard('这个按钮已点过，或该告警卡已过期。'));
    }
    const mode = value.action === OVERLOAD_ACTION_CLEAN_STOPPED ? 'clean_stopped' : 'suspend_idle';
    let affected: number;
    try {
      affected = await sweepHostOverload(mode);
    } catch (err) {
      logger.warn(`[overload] ${value.action} failed: ${err instanceof Error ? err.message : String(err)}`);
      // Only the destructive sweep is guarded here: roll back the claim so a
      // transient sweep failure doesn't permanently burn the button — the owner
      // can click it again to retry. (The post-sweep count refresh below is
      // deliberately outside this try: once the sweep has run, its failure must
      // not re-open the button for a second destructive run.)
      releaseOverloadNonce(st.nonce, value.action);
      return { toast: { type: 'error', content: '执行失败，请稍后重试或用 CLI 手动处理' } };
    }
    if (mode === 'clean_stopped') st.cleanedN = affected; else st.suspendedN = affected;
    // Refresh the machine-wide candidate counts so the still-live button and
    // the header reflect what's left after this sweep. Best-effort: the sweep
    // already succeeded, so a count failure must not roll back the nonce.
    try {
      const counts = await countHostOverload();
      st.stopped = counts.stopped;
      st.idle = counts.idle;
    } catch (err) {
      logger.warn(`[overload] post-sweep count refresh failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    logger.info(`[overload] ${value.action} by owner ${operatorOpenId}: affected=${affected}, remaining stopped=${st.stopped} idle=${st.idle}`);
    // Rebuild the SAME card: clicked button → ✓done+disabled, other → still live.
    return JSON.parse(buildOverloadAlertCard(st));
  }
  // ─── 过载告警卡：重启浏览器（overload_restart_browser）────────────────────
  // owner 强闸门 + 按 bundleId 分开的一次性 nonce 核销（可分别重启 Arc/Chrome/Edge，
  // 各一次）。重启在本机 daemon 直接执行（浏览器就跑在本机），不跨 daemon 扇出。
  if (value?.action === OVERLOAD_ACTION_RESTART_BROWSER && larkAppId) {
    const owner = getOwnerOpenId(larkAppId);
    if (!operatorOpenId || operatorOpenId !== owner) {
      logger.info(`Overload browser-restart blocked for non-owner: ${operatorOpenId}`);
      return { toast: { type: 'error', content: '仅管理员可操作' } };
    }
    const bundleId = typeof value.bundleId === 'string' ? value.bundleId : '';
    if (!bundleId) return { toast: { type: 'error', content: '按钮缺少 bundleId' } };
    let st: OverloadCardState;
    try { st = JSON.parse(value.st ?? ''); } catch { return JSON.parse(buildOverloadExpiredCard()); }
    if (!st?.nonce) return JSON.parse(buildOverloadExpiredCard());
    // Fail-closed against config drift: the button lives
    // on a card that stays clickable for the nonce's 1h TTL, but the config's
    // enabled targets can change underneath it (a target disabled via
    // `enabled:false` or removed entirely). Before we quit a real host browser,
    // require the bundleId to be present BOTH on this card's `st.browsers` (it
    // was a rendered button, not a forged value) AND in the live resolved
    // enabled targets (it's still an allowed target right now). Either miss →
    // refuse without touching the browser, so a stale card can't kill a browser
    // the operator has since taken off the allow-list.
    const target = (st.browsers ?? []).find(b => b.bundleId === bundleId);
    let liveTargets: ReturnType<typeof resolveBrowserTargets> = [];
    try {
      const alertCfg = (readGlobalConfig().hostOverloadAlert ?? {}) as { browserRestartTargets?: unknown };
      liveTargets = resolveBrowserTargets(alertCfg.browserRestartTargets);
    } catch { /* resolver is pure over config; treat a throw as "no live targets" → fail-closed below */ }
    const liveTarget = liveTargets.find(t => t.bundleId === bundleId);
    if (!target || !liveTarget) {
      logger.info(`[overload] restart browser refused (config drift): bundleId=${bundleId} onCard=${!!target} liveEnabled=${!!liveTarget}`);
      return JSON.parse(buildOverloadExpiredCard('该浏览器的重启配置已变更或卡片已过期，未执行。'));
    }
    const label = target.label ?? liveTarget.label ?? bundleId;
    // One-shot per (nonce, bundleId): each browser button burns its own claim so
    // the owner can bounce several browsers on one card, but none twice.
    const claimKey = `${OVERLOAD_ACTION_RESTART_BROWSER}:${bundleId}`;
    if (!claimOverloadNonce(st.nonce, claimKey)) {
      return JSON.parse(buildOverloadExpiredCard('这个按钮已点过，或该告警卡已过期。'));
    }
    const openArgs = liveTarget.openArgs;
    let result;
    try {
      result = await restartBrowser({ bundleId, ...(openArgs ? { openArgs } : {}) });
    } catch (err) {
      logger.warn(`[overload] restart browser ${label} threw: ${err instanceof Error ? err.message : String(err)}`);
      releaseOverloadNonce(st.nonce, claimKey);
      // Return a VISIBLE card, not a toast: the handler can
      // run up to ~12s (quit-wait), which exceeds the 2.5s card-ACK window — a
      // toast-only result after that ACK is silently dropped by the dispatcher.
      // buildOverloadBrowserFailureCard renders a patchable card carrying the
      // rebuilt alert `st`, so the owner actually sees the failure + can retry.
      return JSON.parse(buildOverloadBrowserFailureCard(st, label, '重启失败，请稍后重试'));
    }
    if (!result.ok) {
      // Quit never happened (e.g. unsaved-changes dialog) — nothing was killed;
      // release the claim so the owner can retry after handling the dialog. Same
      // reasoning as above: deliver via a patchable card, never a toast.
      logger.warn(`[overload] restart browser ${label} not ok: ${result.error ?? 'unknown'}`);
      releaseOverloadNonce(st.nonce, claimKey);
      return JSON.parse(buildOverloadBrowserFailureCard(st, label, result.error ?? '重启失败'));
    }
    if (!result.relaunched) {
      // Quit succeeded but relaunch failed: the browser is
      // now DOWN, not restarted. Do NOT mark it「✓已重启」and do NOT burn the
      // claim — release it so the owner can retry the reopen. Report the true
      // state (已退出未重开) on a patchable card.
      logger.warn(`[overload] browser ${label} quit but relaunch failed: ${result.error ?? 'unknown'}`);
      releaseOverloadNonce(st.nonce, claimKey);
      return JSON.parse(buildOverloadBrowserFailureCard(st, label, `已退出但重开失败：${result.error ?? '未知错误'}。可再点一次重试重开`));
    }
    // Mark this browser done on the card (button → ✓已重启, disabled).
    st.restartedBrowsers = [...new Set([...(st.restartedBrowsers ?? []), bundleId])];
    logger.info(`[overload] browser ${label} restarted by owner ${operatorOpenId} (relaunched=${result.relaunched})`);
    return JSON.parse(buildOverloadAlertCard(st));
  }
  // ─── 群内授权卡片动作（限制提交 + grant/revoke，talk-only）──────────────────
  // 不绑定 session，必须在 session 解析之前处理。owner 强闸门 + nonce 校验。
  if (value?.action && (
    value.action === 'grant_chat'
    || value.action === 'grant_global'
    || value.action === 'grant_deny'
    || value.action === 'grant_set_duration'
    || value.action === 'grant_set_quota'
  ) && larkAppId) {
    const loc = localeForBot(larkAppId);
    const owner = getOwnerOpenId(larkAppId);
    // owner 强闸门：必须是当前 app 的 owner 本人（比 canOperate 更严）
    if (!operatorOpenId || operatorOpenId !== owner) {
      logger.info(`Grant action "${value.action}" blocked for non-owner: ${operatorOpenId}`);
      return { toast: { type: 'error', content: t('card.grant.toast_owner_only', undefined, loc) } };
    }
    // 一次 /grant 可带多个目标（多人/多 bot），共用一张卡 + 同一 nonce。
    // 兼容旧卡（重启前发出的单目标卡只带 target_open_id）：归一成数组。
    const targets: string[] = Array.isArray(value.target_open_ids)
      ? value.target_open_ids
      : (value.target_open_id ? [value.target_open_id] : []);
    const grantChatId = value.chat_id;
    const nonce = value.nonce;
    // 全部 target 都得仍 pending 且 nonce 匹配，否则视为整卡失效。
    if (!targets.length || !grantChatId || !nonce || !targets.every(tt => checkNonce(larkAppId, grantChatId, tt, nonce))) {
      return { toast: { type: 'error', content: t('card.grant.toast_expired', undefined, loc) } };
    }
    // 兼容已发出的旧卡：旧卡用下拉 callback 暂存限制，新卡在授权按钮的 form_submit
    // 中一次提交有效期和额度。两条路径都必须走服务端校验，不能信任卡片输入。
    if (value.action === 'grant_set_duration' || value.action === 'grant_set_quota') {
      const selected = action?.option;
      const parsed = value.action === 'grant_set_duration'
        ? normalizeGrantDurationOption(selected)
        : normalizeGrantQuotaOption(selected);
      if (parsed === null) {
        return { toast: { type: 'error', content: t('card.grant.toast_bad_limit', undefined, loc) } };
      }
      const updated = updatePendingGrantLimits(
        larkAppId,
        grantChatId,
        targets,
        nonce,
        value.action === 'grant_set_duration'
          ? { durationMs: parsed ?? null }
          : { quota: parsed ?? null },
      );
      return updated
        ? { toast: { type: 'success', content: t('card.grant.toast_limit_staged', undefined, loc) } }
        : { toast: { type: 'error', content: t('card.grant.toast_expired', undefined, loc) } };
    }
    // 拒绝：只把卡更新成「已拒绝」+ 全部目标进 deny 冷却，绝不触碰 grant-store。
    // 返回原始卡 body，由 dispatcher 包成 in-place patch（不再走 updateMessage 双写）。
    if (value.action === 'grant_deny') {
      for (const tt of targets) markDenied(larkAppId, grantChatId, tt);
      return JSON.parse(buildGrantResultCard('deny', loc));
    }
    const formValue = action?.form_value;
    if (formValue) {
      const duration = normalizeGrantDurationOption(formValue.grant_duration);
      const quota = normalizeGrantQuotaOption(
        typeof formValue.grant_quota === 'string' ? formValue.grant_quota.trim() : formValue.grant_quota,
      );
      if (quota === null) {
        return { toast: { type: 'error', content: t('card.grant.toast_bad_quota', undefined, loc) } };
      }
      if (duration === null) {
        return { toast: { type: 'error', content: t('card.grant.toast_bad_limit', undefined, loc) } };
      }
      if (!updatePendingGrantLimits(larkAppId, grantChatId, targets, nonce, {
        durationMs: duration ?? null,
        quota: quota ?? null,
      })) {
        return { toast: { type: 'error', content: t('card.grant.toast_expired', undefined, loc) } };
      }
    }
    // 授权（talk-only）：grant_chat 写本群 chatGrants，grant_global 写全局 globalGrants，
    // 两者都绝不碰 allowedUsers（operate 只由 bots.json 配）。逐个落库，统计成功/失败。
    const kind = value.action === 'grant_global' ? 'global' as const : 'chat' as const;
    const names: string[] = Array.isArray(value.target_names) ? value.target_names : [];
    const idToName = new Map<string, string>();
    targets.forEach((tt, i) => idToName.set(tt, names[i] ?? ''));
    // 限制挂在 pending 上；确认时生成绝对 expiresAt，多目标共享同一组限制。
    const limits = getPendingGrantLimits(larkAppId, grantChatId, targets[0]);
    if (!limits) {
      return { toast: { type: 'error', content: t('card.grant.toast_expired', undefined, loc) } };
    }
    const quota = limits.quota;
    const expiresAt = limits.durationMs === undefined ? undefined : Date.now() + limits.durationMs;
    // 触发本次授权申请的原始消息事件：授权成功后重放，用户无需再 @ 一遍。
    // 自助申请卡每次只对应一个 target，取第一个即可。
    const pendingMessage = getPendingMessage(larkAppId, grantChatId, targets[0]);
    const granted: string[] = [];
    const failed: Array<{ openId: string; reason: string }> = [];
    for (const tt of targets) {
      const res = kind === 'global'
        ? await addGlobalGrant(larkAppId, tt, quota, expiresAt)
        : await addChatGrant(larkAppId, grantChatId, tt, quota, expiresAt);
      if (res.ok) { clearPending(larkAppId, grantChatId, tt); granted.push(tt); }
      else { failed.push({ openId: tt, reason: res.reason }); logger.warn(`Grant action "${value.action}" store failed for ${tt}: ${res.reason}`); }
    }
    // 全部失败：保留 pending + 不撤卡（owner 可点原卡重试），toast 报错。
    if (granted.length === 0) {
      return { toast: { type: 'error', content: t('card.grant.toast_failed', { reason: failed[0]?.reason ?? 'unknown' }, loc) } };
    }
    // 部分成功：失败 target 的 pending 必须立刻清掉——卡马上要撤回（owner 无法再点原卡重试），
    // 而 pending 无 TTL，isThrottled 会永久挡住失败 target 后续的自助申请直到 daemon 重启。
    // 清掉后失败 target 可重新走 /grant 或自助申请；失败清单下面在原线程明确告知 owner，
    // 不做「撤卡 + 静默失败 + pending 永久卡住」。
    for (const f of failed) clearPending(larkAppId, grantChatId, f.openId);
    // 一次查通讯录判定哪些 grantee 是真人（vs bot），结果同时供下面两处复用：
    //   1. observed 花名册自动登记（只收 bot，剔真人）；
    //   2. 通知卡 @ 渲染（只 @ 真人，bot 用纯文本名字 —— 见下方注释）。
    // 缺 contact 读权限/查询瞬时失败 → 一律按 bot 处理（false）：登记侧沿用历史「全部登记」回退，
    // 通知侧则把对方当 bot 不 @（宁可少 @ 一次真人，也不误唤醒 bot 拉空会话）。
    const humanFlags = await Promise.all(granted.map(id => isHumanOpenId(larkAppId, id).catch(() => false)));
    // /grant @bot 成功后顺带把「bot」目标登记进 observed 花名册（等价内部跑一次 /introduce），
    // 授权 + 可点名一步到位。写的是 observed-bots-store（让本 daemon 能 @ 回对方），不影响
    // isKnownPeerBot 接收闸（那查的是 cross-ref，两套独立存储），零额外路由权。best-effort。
    // 真人**不**登记：查通讯录确认是真人就剔除，避免污染 <available_bots> 误导模型。
    try {
      const botEntries = granted
        .map((id, i) => ({ id, human: humanFlags[i] }))
        .filter(x => !x.human)
        .map(x => ({ openId: x.id, name: idToName.get(x.id) ?? '' }));
      const skipped = granted.length - botEntries.length;
      if (skipped > 0) logger.debug(`grant auto-introduce: skipped ${skipped} confirmed human target(s)`);
      if (botEntries.length > 0) {
        recordObservedBots(config.session.dataDir, larkAppId, grantChatId, botEntries, 'introduce');
      }
    } catch (err) {
      logger.warn(`grant auto-introduce (observed) failed (grant still applied): ${err}`);
    }
    // 通知卡的 grantee 渲染参数：bot 只用纯文本名字（不 <at>，否则唤醒对方 bot 误拉空会话），真人 @ 点名。
    const notifyTargets = granted.map((id, i) => ({ openId: id, name: idToName.get(id) || undefined, isBot: !humanFlags[i] }));
    // 授权成功后：**就地 patch 原卡**为终态（正文直接 @ 被授权人 + 额度/有效期），这一张卡既是
    // 「已授权」结果态、又 ping 到被授权人——无需再单独发通知卡、也无需撤回原卡（申晗 2026-07-31
    // 反馈：直接在原卡更新即可）。同步返回该 body 即完成 in-place patch，避免 deleteMessage 与
    // callback 响应竞态导致客户端 300000。仅「部分失败」仍走后台补一条文字告知。
    const resultCardBody = JSON.parse(buildGrantResultCard(kind, loc, quota, expiresAt, notifyTargets));
    if (cardMessageId && failed.length > 0) {
      let replyInThread = true;
      try {
        const detail = await getMessageDetail(larkAppId, cardMessageId);
        const item = detail?.items?.[0];
        if (!item) throw new Error('no message item in getMessageDetail response');
        replyInThread = Boolean(item.thread_id);
      } catch (err) {
        logger.debug(`grant partial-failure thread-mode probe failed, defaulting to thread reply: ${err}`);
      }
      // fire-and-forget: 仅在有部分目标失败时补一条文字告知（不阻塞 callback）。
      Promise.resolve()
        .then(async () => {
          const failNames = failed.map(f => idToName.get(f.openId) || f.openId).join('、');
          try {
            await replyMessage(larkAppId, cardMessageId, t('card.grant.partial_failed', { names: failNames }, loc), 'text', replyInThread);
          } catch (err) {
            logger.warn(`grant partial-failure notice failed: ${err}`);
          }
        })
        .catch(err => logger.error(`grant post-callback background tasks failed: ${err}`));
    }
    // 授权成功后重放触发本次申请的原始消息，用户无需再 @ 一遍。
    // replayGrantedMessage 内部异步执行（setImmediate），不阻塞 callback 响应。
    if (pendingMessage && deps.replayGrantedMessage) {
      try {
        deps.replayGrantedMessage(pendingMessage, larkAppId);
      } catch (err) {
        logger.warn(`replay granted message failed (grant still applied): ${err}`);
      }
    }
    return resultCardBody;
  }

  if (isAskCardAction(value?.action)) {
    return handleAskCardAction(data);
  }

  if (['feedback_submit', 'feedback_reason', 'feedback_comment', 'skill_feedback_submit'].includes(value?.action ?? '') && larkAppId) {
    const { handleSkillFeedbackCardAction } = await import('./skill-feedback-card.js');
    const { getSkillFeedbackStore } = await import('../../services/skill-feedback-store.js');
    const { config } = await import('../../config.js');
    return handleSkillFeedbackCardAction(data, larkAppId, {
      store: await getSkillFeedbackStore(config.session.dataDir),
      loadBaseCard: async (platformMessageId) => {
        const detail = await getMessageDetail(larkAppId, platformMessageId);
        const content = detail?.items?.[0]?.body?.content ?? detail?.body?.content;
        if (typeof content !== 'string') return undefined;
        try {
          const parsed = JSON.parse(content);
          return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : undefined;
        } catch {
          return undefined;
        }
      },
    });
  }

  if (
    (value?.action === 'codex_notifier_continue' || value?.action === 'codex_notifier_open_app')
    && larkAppId
  ) {
    if (!operatorOpenId) {
      logger.info(`${value.action} blocked because operator identity is missing`);
      return { toast: { type: 'error', content: '只有机器人管理员可以操作此 Codex 任务' } };
    }
    if (!deps.codexNotifierCardAction) {
      return { toast: { type: 'error', content: 'Codex 完成通知处理器未启用' } };
    }
    return deps.codexNotifierCardAction(data, larkAppId);
  }

  if (
    typeof value?.action === 'string' &&
    value.action.startsWith('vc_meeting_') &&
    larkAppId
  ) {
    if (!deps.vcMeetingCardAction) {
      return { toast: { type: 'error', content: '会议监听处理器未启用' } };
    }
    return deps.vcMeetingCardAction(data, larkAppId);
  }

  // Dashboard callbacks dispatch before session lookup. They do not require an
  // active DaemonSession and use dashboard-internal Route B endpoints.
  if (
    typeof value?.action === 'string' &&
    value.action.startsWith('dash_settings_') &&
    larkAppId
  ) {
    const { handleSettingsCardAction } = await import('./settings-card.js');
    const { createDaemonClientFor } = await import('../../daemon-internal-client-wrapper.js');
    const settingsLocale = localeForBot(larkAppId);
    // Success returns `{ card }` only so Lark replaces the card in the same
    // callback response. Slow fallback is handled by the event dispatcher.
    return handleSettingsCardAction(data, larkAppId, {
      createClient: (appId: string) => createDaemonClientFor(appId),
      locale: settingsLocale,
    });
  }

  // ─── `/dashboard sessions` callbacks ─────────────────────────────────
  // Same response shape as dash_settings_*: success returns `{ card }` only,
  // no toast, so Lark renders the new list in a single pass.
  if (
    typeof value?.action === 'string' &&
    value.action.startsWith('dash_sessions_') &&
    larkAppId
  ) {
    const { handleSessionsCardAction } = await import('./sessions-card.js');
    const { createDaemonClientFor } = await import('../../daemon-internal-client-wrapper.js');
    const sessionsLocale = localeForBot(larkAppId);
    return handleSessionsCardAction(data, larkAppId, {
      createClient: (appId: string) => createDaemonClientFor(appId),
      locale: sessionsLocale,
    });
  }

  // ─── `/dashboard schedules` callbacks ────────────────────────────────
  if (
    typeof value?.action === 'string' &&
    value.action.startsWith('dash_schedules_') &&
    larkAppId
  ) {
    const { handleSchedulesCardAction } = await import('./schedules-card.js');
    const { createDaemonClientFor } = await import('../../daemon-internal-client-wrapper.js');
    const schedulesLocale = localeForBot(larkAppId);
    return handleSchedulesCardAction(data, larkAppId, {
      createClient: (appId: string) => createDaemonClientFor(appId),
      locale: schedulesLocale,
    });
  }

  // ─── `/dashboard groups` callbacks ───────────────────────────────────
  if (
    typeof value?.action === 'string' &&
    value.action.startsWith('dash_groups_') &&
    larkAppId
  ) {
    const { handleGroupsCardAction } = await import('./groups-card.js');
    const { createDaemonClientFor } = await import('../../daemon-internal-client-wrapper.js');
    const groupsLocale = localeForBot(larkAppId);
    return handleGroupsCardAction(data, larkAppId, {
      createClient: (appId: string) => createDaemonClientFor(appId),
      locale: groupsLocale,
    });
  }

  // ─── `/issue` Issue Board callbacks ──────────────────────────────────
  // 权限门（allowedUsers + invoker lock）在 handleIssueCardAction 里，每次回调都重跑。
  if (
    typeof value?.action === 'string' &&
    value.action.startsWith('issue_') &&
    larkAppId
  ) {
    const { handleIssueCardAction } = await import('./issue-command.js');
    const { buildIssueCommandDeps } = await import('./issue-command-deps.js');
    return handleIssueCardAction(data, larkAppId, buildIssueCommandDeps());
  }

  // ─── `/dashboard overview` callbacks ─────────────────────────────────
  // Goto buttons rebuild the TARGET card by re-fetching the corresponding
  // dedicated Route B endpoint (sessions-list / schedules-list /
  // settings-snapshot). No new endpoints, no multi_url cross-card jumps.
  if (
    typeof value?.action === 'string' &&
    value.action.startsWith('dash_overview_') &&
    larkAppId
  ) {
    const { handleOverviewCardAction } = await import('./overview-card.js');
    const { createDaemonClientFor } = await import('../../daemon-internal-client-wrapper.js');
    const overviewLocale = localeForBot(larkAppId);
    return handleOverviewCardAction(data, larkAppId, {
      createClient: (appId: string) => createDaemonClientFor(appId),
      locale: overviewLocale,
    });
  }

  // ─── /relay picker: state-changing actions (select / page / search) ────
  // These three actions all re-render the picker card with updated state:
  //   • relay_select — user clicked a session card → set as selectedSessionId
  //   • relay_page   — user clicked prev/next page → bump page index
  //   • relay_search — user submitted the search form → apply new query (reset page)
  //
  // The card is stateless on the Lark side, so each callback value carries
  // the FULL state (search / page / selected / target_chat_id / root_id);
  // we just compute the new state from the action and re-render.
  if (value?.action && larkAppId && ['relay_select', 'relay_page', 'relay_search'].includes(value.action as string)) {
    const loc = localeForBot(larkAppId);
    const targetChatId = value.target_chat_id;
    const targetRootId = value.root_id;
    // root_id IS the relay target anchor (chatId for chat-scope, 话题 root for
    // thread-scope). target_scope tells the confirm/re-render which it is;
    // target_chat_type (group | p2p) rides along so confirm can flip the
    // session's chatType for DM targets. Default 'group' covers legacy cards.
    const targetScope = (value.target_scope as 'thread' | 'chat') ?? 'chat';
    const targetChatType = (value.target_chat_type as 'group' | 'p2p') ?? 'group';
    const cardVisibility = (value.visibility as 'private' | 'public') ?? 'public';
    const invokerOpenId = value.invoker_open_id as string | undefined;
    if (!targetChatId || !targetRootId || !operatorOpenId) {
      return { toast: { type: 'error', content: t('card.relay.toast_failed', { error: 'missing_value' }, loc) } };
    }
    // Picker is owner-only: only the user who summoned it may flip pages,
    // search, or select. Otherwise A's invocation in a shared chat could be
    // silently swapped to C's session list when C clicks a button. Cards
    // built before this guard was deployed lack invoker_open_id — we let
    // them through (legacy) rather than break in-flight pickers; new cards
    // are protected from the moment they're rendered.
    if (invokerOpenId && invokerOpenId !== operatorOpenId) {
      return { toast: { type: 'error', content: t('card.relay.toast_not_invoker', undefined, loc) } };
    }

    // Reconstruct the next state from the action.
    const carriedSearch = (value.search as string) ?? '';
    const carriedPage = Number(value.page ?? 0) || 0;
    const carriedSelected = (value.selected as string) ?? '';

    let nextSearch = carriedSearch;
    let nextPage = carriedPage;
    let nextSelected: string | undefined = carriedSelected || undefined;

    if (value.action === 'relay_search') {
      // v2 input fires `behaviors[].callback` directly — the typed text
      // arrives as action.input_value (NOT form_value), since we're no
      // longer wrapping the input in a form. Reset page on new search.
      nextSearch = String((action as any)?.input_value ?? '').trim();
      nextPage = 0;
      // Don't carry over the selection on a new search — the selected entry
      // may not match the new filter, and even if it does, "I just searched
      // for something else" implies the user is changing what they want.
      nextSelected = undefined;
    } else if (value.action === 'relay_page') {
      nextPage = Number(value.page ?? 0) || 0;
    } else if (value.action === 'relay_select') {
      nextSelected = value.session_id;
    }

    // Exclude by the target ANCHOR (root_id), not chatId — keeps 同群 other-
    // topic sessions in the candidate list on re-render, matching初次渲染.
    const { collectRelayPickerEntries } = await import('../../services/relay-picker.js');
    const entries = await collectRelayPickerEntries(activeSessions, larkAppId, targetRootId, operatorOpenId);
    const { buildRelayPickerCard } = await import('./card-builder.js');
    const cardJson = buildRelayPickerCard(
      entries,
      targetChatId,
      targetRootId,
      // Preserve the original invoker so the re-rendered card stays bound
      // to them. Fall back to operatorOpenId for legacy cards rendered
      // before invoker_open_id was added (shouldn't normally happen since
      // the check above already lets legacy through, but a render needs a
      // string regardless).
      invokerOpenId ?? operatorOpenId,
      loc,
      {
        selectedSessionId: nextSelected,
        searchQuery: nextSearch,
        page: nextPage,
      },
      targetScope,
      targetChatType,
      cardVisibility,
    );
    // ── Private (ephemeral) picker: delete-then-resend ────────────────────
    // Ephemeral cards CANNOT be PATCH-updated (Feishu legacy interface), so we
    // can't return a body for the dispatcher to patch in place. Instead delete
    // the clicked card and resend a fresh ephemeral one carrying the new state
    // — the same send→interact→delete→resend pattern Feishu documents for
    // ephemeral flows. Resend FIRST, then delete the old one, so a resend
    // failure doesn't leave the user with no card at all. The toast keeps the
    // callback response non-empty (returning {} would make Lark show nothing).
    if (cardVisibility === 'private') {
      const { sendEphemeralCard, deleteEphemeralCard } = await import('./client.js');
      try {
        await sendEphemeralCard(larkAppId, targetChatId, invokerOpenId ?? operatorOpenId, cardJson);
        if (cardMessageId) {
          await deleteEphemeralCard(larkAppId, cardMessageId).catch(() => { /* stale card lingering is cosmetic */ });
        }
        // No card body returned — the replacement is already sent. An empty
        // response is fine here (the new ephemeral card is the user-visible
        // result); a toast would double up with the freshly-rendered card.
        return;
      } catch (err) {
        logger.warn(`[card-action] relay private picker re-render failed (${err instanceof Error ? err.message : err}); leaving old card in place`);
        return { toast: { type: 'error', content: t('card.relay.toast_failed', { error: 'ephemeral_refresh_failed' }, loc) } };
      }
    }
    // Return an updated card body — event-dispatcher wraps this as
    // { card: { type: 'raw', data: <body> } } so Lark patches the picker
    // in place rather than appending a new message.
    return JSON.parse(cardJson);
  }

  // ─── /botconfig 交互卡片：切换布尔开关 / 选择 cli·model·lang / 编辑自由输入项 ──
  const CONFIG_CARD_ACTIONS = [
    'config_toggle', 'config_set', 'config_quota', 'config_quota_open',
    'config_quota_save', 'config_text_open', 'config_text_save',
  ];
  if (value?.action && larkAppId && CONFIG_CARD_ACTIONS.includes(value.action)) {
    // 卡片携带的渲染语言（`/botconfig en` 的覆盖）优先；缺省回落 bot 默认。
    const vLoc = (value as any)?.loc;
    const loc = isLocale(vLoc) ? vLoc : localeForBot(larkAppId);
    let cbot;
    try { cbot = getBot(larkAppId); } catch { return { toast: { type: 'error', content: t('cmd.config.no_bot', undefined, loc) } }; }
    // 严格 owner/allowlist 闸（与文字版 /botconfig 同口径）：拒开放模式 + 非 admin。
    const admins = cbot.resolvedAllowedUsers;
    if (admins.length === 0 || !operatorOpenId || !admins.includes(operatorOpenId)) {
      return { toast: { type: 'error', content: t('cmd.config.not_admin', undefined, loc) } };
    }
    // ttadk 网关 bot 用 ttadk 网关模型候选（glm-5.1…），非底层适配器的 opus/gpt-5
    // （否则被 worker 注入成 `ttadk -m opus` 用错模型启动失败）；CoCo 无候选。
    const modelChoices = (() => {
      const ttadkChoices = ttadkConfigModelChoices(cbot.config.wrapperCli);
      if (ttadkChoices !== null) return ttadkChoices;
      try { return createCliAdapterSync(cbot.config.cliId, cbot.config.cliPathOverride).modelChoices ?? []; } catch { return []; }
    })();
    const reRender = () => {
      const d = getConfigCardData(larkAppId, modelChoices);
      return d ? { card: { type: 'raw' as const, data: JSON.parse(buildConfigCard(d, loc)) } } : {};
    };
    // 「文本设置」子卡：点主卡按钮 → **私信新发**一张含输入框的子卡（v1 form 须新发、
    // 不能 patch，否则空卡）。子卡每个字段一个 form，保存即写、回 toast、卡片保持
    // （不回 card → 不 patch，避免 form 重渲染异常）。
    if (value.action === 'config_text_open') {
      const d = getConfigCardData(larkAppId, modelChoices);
      if (!d) return { toast: { type: 'error', content: t('cmd.config.no_bot', undefined, loc) } };
      try {
        await sendUserMessage(larkAppId, operatorOpenId!, buildConfigTextCard(d, loc), 'interactive');
        return { toast: { type: 'success', content: t('card.config.text_sent', undefined, loc) } };
      } catch {
        return { toast: { type: 'error', content: t('card.config.text_send_fail', undefined, loc) } };
      }
    }
    if (value.action === 'config_text_save') {
      const fk = (value as any)?.field as string | undefined;
      const fv: Record<string, string> = (action as any)?.form_value ?? {};
      const raw = String((fk ? fv[fk] : '') ?? '').trim();
      if (fk === 'teamRole') {
        // writeTeamRoleFile truncates by UTF-8 byte length (MAX_ROLE_BYTES); do
        // not pre-slice by JS char count here (would mis-cut CJK).
        if (raw) writeTeamRoleFile(larkAppId, raw); else deleteTeamRoleFile(larkAppId);
        logger.info(`[config:${larkAppId}] team role ${raw ? 'set' : 'cleared'} via card`);
        return { toast: { type: 'success', content: t('card.config.text_saved', undefined, loc) } };
      }
      const spec = fk ? findConfigField(fk) : undefined;
      if (!spec) return { toast: { type: 'error', content: t('cmd.config.unknown_field', { field: fk ?? '?', fields: '' }, loc) } };
      // 留空 = 清除；非空一律过 coerceConfigValue 按 kind 归一化/校验（stringList
      // 拆数组、string 执行 maxLen 等 spec 约束），与 /config 文字入口、dashboard
      // PUT 同一校验点，避免卡片入口绕过。
      let valueToApply: string | string[] | null;
      if (!raw) {
        valueToApply = null;
      } else {
        const coerced = coerceConfigValue(spec, raw);
        if (!coerced.ok) return { toast: { type: 'error', content: t('cmd.config.write_failed', { reason: coerced.reason }, loc) } };
        // 文本子卡只承载 string / stringList 字段；narrow 给 applyConfigField。
        valueToApply = coerced.value as string | string[];
      }
      const r = await applyConfigField(larkAppId, spec, valueToApply);
      if (!r.ok) return { toast: { type: 'error', content: t('cmd.config.write_failed', { reason: r.reason }, loc) } };
      logger.info(`[config:${larkAppId}] text field ${spec.key} saved via card`);
      return { toast: { type: 'success', content: `✓ ${spec.key} = ${r.newText}` } };
    }

    // 消息额度使用独立私信子卡自由输入，与 Dashboard 的 1–1000 语义一致。
    if (value.action === 'config_quota_open') {
      const d = getConfigCardData(larkAppId, modelChoices);
      if (!d) return { toast: { type: 'error', content: t('cmd.config.no_bot', undefined, loc) } };
      try {
        await sendUserMessage(larkAppId, operatorOpenId!, buildConfigQuotaCard(d, loc), 'interactive');
        return { toast: { type: 'success', content: t('card.config.quota_sent', undefined, loc) } };
      } catch {
        return { toast: { type: 'error', content: t('card.config.quota_send_fail', undefined, loc) } };
      }
    }
    if (value.action === 'config_quota_save') {
      const fv: Record<string, string> = (action as any)?.form_value ?? {};
      const raw = String(fv.messageQuota ?? '').trim();
      let limit: number | null = null;
      if (raw) {
        const n = Number(raw);
        if (!/^\d+$/.test(raw) || !Number.isSafeInteger(n) || n < 1 || n > MAX_GRANT_QUOTA) {
          return { toast: { type: 'error', content: t('card.config.quota_invalid', undefined, loc) } };
        }
        limit = n;
      }
      const qr = await updateBotGrantPrefs(larkAppId, { messageQuotaDefaultLimit: limit });
      if (!qr.ok) return { toast: { type: 'error', content: t('cmd.config.write_failed', { reason: qr.reason }, loc) } };
      return {
        toast: {
          type: 'success',
          content: limit == null
            ? t('card.config.quota_saved_default', undefined, loc)
            : t('card.config.quota_saved', { quota: limit }, loc),
        },
      };
    }

    // 兼容已发出的旧版下拉卡：'off' = 恢复内置策略，正整数 = 设定。
    if (value.action === 'config_quota') {
      const raw = (action as any)?.option ?? '';
      // legacy 是只读初始项，用来让历史 >1000 额度仍能生成合法下拉卡。
      if (raw === 'legacy') {
        return { toast: { type: 'info', content: t('card.config.quota_legacy_unchanged', undefined, loc) }, ...reRender() };
      }
      let limit: number | null = null;
      if (raw !== 'off') {
        const n = Number(raw);
        if (!/^\d+$/.test(raw) || !Number.isSafeInteger(n) || n < 1 || n > MAX_GRANT_QUOTA) {
          return { toast: { type: 'error', content: t('card.config.quota_invalid', undefined, loc) } };
        }
        limit = n;
      }
      const qr = await updateBotGrantPrefs(larkAppId, { messageQuotaDefaultLimit: limit });
      if (!qr.ok) return { toast: { type: 'error', content: t('cmd.config.write_failed', { reason: qr.reason }, loc) } };
      return { toast: { type: 'success', content: `✓ quota = ${limit ?? 'off'}` }, ...reRender() };
    }

    const field = value.field as string | undefined;
    const spec = field ? findConfigField(field) : undefined;
    if (!spec || spec.kind === 'allowedUsers') {
      return { toast: { type: 'error', content: t('cmd.config.unknown_field', { field: field ?? '?', fields: '' }, loc) } };
    }

    let r;
    if (value.action === 'config_toggle') {
      if (spec.kind !== 'boolean') return { toast: { type: 'error', content: t('cmd.config.invalid_bool', { field: spec.key, value: '' }, loc) } };
      const cur = (cbot.config as any)[spec.configKey] === true;
      r = await applyConfigField(larkAppId, spec, !cur);
    } else {
      const raw = (action as any)?.option ?? (action as any)?.input_value ?? '';
      if (raw === CONFIG_UNSET) {
        if (!spec.clearable) return { toast: { type: 'error', content: t('cmd.config.not_clearable', { field: spec.key }, loc) }, ...reRender() };
        r = await applyConfigField(larkAppId, spec, null);
      } else {
        const coerced = coerceConfigValue(spec, raw);
        if (!coerced.ok) return { toast: { type: 'error', content: t('cmd.config.write_failed', { reason: coerced.reason }, loc) }, ...reRender() };
        r = await applyConfigField(larkAppId, spec, coerced.value);
      }
    }
    if (!r.ok) return { toast: { type: 'error', content: t('cmd.config.write_failed', { reason: r.reason }, loc) } };
    return { toast: { type: 'success', content: `✓ ${spec.key} = ${r.newText}` }, ...reRender() };
  }

  // ─── /relay picker: confirm transfer (stage 2 → done) ──────────────────
  // The confirm button on the picker card fires this. Same logic as the
  // original (pre-two-stage) relay_pickup action: owner-check, pre-flight
  // conflict check, send M1, transferSession, delete picker card.
  if (value?.action === 'relay_confirm' && larkAppId) {
    const loc = localeForBot(larkAppId);
    const sourceSessionId = value.session_id;
    const targetChatId = value.target_chat_id;
    const targetRootId = value.root_id;
    // root_id IS the target anchor for thread-scope (the 话题 root); for chat-
    // scope the anchor is chatId and root_id is unused for routing.
    // target_chat_type tells transferSession whether the destination is a DM
    // (p2p) so the session's chatType flips with it; legacy cards lack the
    // field and default to 'group' (their pickers never offered DM targets).
    const targetScope = (value.target_scope as 'thread' | 'chat') ?? 'chat';
    const targetChatType = (value.target_chat_type as 'group' | 'p2p') ?? 'group';
    const cardVisibility = (value.visibility as 'private' | 'public') ?? 'public';
    const targetAnchor = targetScope === 'chat' ? targetChatId : targetRootId;
    const invokerOpenId = value.invoker_open_id as string | undefined;
    if (!sourceSessionId || !targetChatId || !targetRootId) {
      return { toast: { type: 'error', content: t('card.relay.toast_failed', { error: 'missing_value' }, loc) } };
    }
    // Invoker-only confirm: redundant with the ownerOpenId check below in
    // normal flow (invoker = session owner = picker invoker), but defends
    // against the edge case where the source session changed owners after
    // the picker was rendered, OR where the picker was shared/forwarded.
    // Legacy cards (no invoker_open_id) fall through to ownerOpenId only.
    if (invokerOpenId && operatorOpenId && invokerOpenId !== operatorOpenId) {
      return { toast: { type: 'error', content: t('card.relay.toast_not_invoker', undefined, loc) } };
    }
    // Locate the source session in the in-process registry. Since picker only
    // lists sessions of THIS bot in OTHER chats, the source must live in our
    // activeSessions — if it's gone, treat as not found rather than reaching
    // across daemons (cross-daemon pull is out of v1 scope).
    let sourceDs: DaemonSession | undefined;
    for (const cand of activeSessions.values()) {
      if (cand.larkAppId === larkAppId && cand.session.sessionId === sourceSessionId) {
        sourceDs = cand;
        break;
      }
    }
    if (!sourceDs) {
      return { toast: { type: 'error', content: t('card.relay.toast_not_found', undefined, loc) } };
    }
    if (sourceDs.session.ownerOpenId && sourceDs.session.ownerOpenId !== operatorOpenId) {
      return { toast: { type: 'error', content: t('card.relay.toast_not_owner', undefined, loc) } };
    }
    // Anchor-based self-relay guard: a thread-scope source in the SAME chat
    // (different 话题) is a legitimate cross-topic move, so refuse only when the
    // source and target anchors are identical.
    if (sessionAnchorId(sourceDs) === targetAnchor) {
      return { toast: { type: 'error', content: t('card.relay.toast_same_chat', undefined, loc) } };
    }
    // Real-session preflight — done BEFORE M1 send so a refusal doesn't
    // leave a misleading "已接力" announcement in the target chat.
    // collectRelayPickerEntries already filters scratches at render time,
    // but a stale picker (rendered before a scratch was created) could
    // still produce a confirm click; this is the depth defense.
    const { isDisposableCommandScratch, isRelayableRealSession } = await import('../../core/worker-pool.js');
    if (!isRelayableRealSession(sourceDs)) {
      return { toast: { type: 'error', content: t('card.relay.toast_not_started_yet', undefined, loc) } };
    }
    // Pre-flight target-chat conflict check — done BEFORE sendMessage M1 so
    // a refusal doesn't leave a misleading "已接力" announcement in the
    // target chat (王皓 caught this in testing). Mirror the same predicate
    // transferSession uses. Only a narrowly classified daemon-command scratch
    // may be ignored; worker-less queued/adopt/deferred/real sessions still own
    // the anchor and must block before a misleading M1 is sent.
    const targetConflict = [...activeSessions.values()].find(c =>
      c !== sourceDs
      && c.larkAppId === larkAppId
      && sessionAnchorId(c) === targetAnchor
      && !isDisposableCommandScratch(c)
    );
    if (targetConflict) {
      const conflictTitle = targetConflict.session.title || targetConflict.session.sessionId.substring(0, 8);
      // Send as a regular text message in the target chat instead of a
      // popup toast — per王皓's preference for visible/persistent error
      // ("不要用弹窗，就用消息形式"). No toast returned so the operator
      // sees the chat message land where the error actually applies.
      // Pass raw text — sendMessage wraps text-msgType bodies itself; the
      // earlier `JSON.stringify({text: ...})` caused double-wrapping and
      // Lark rendered the JSON literally (王皓 caught this in the M1).
      const errText = t('cmd.relay.target_has_session_msg', { title: conflictTitle }, loc);
      sendMessage(larkAppId, targetChatId, errText, 'text').catch(() => undefined);
      return;
    }
    // Resolve a friendly source chat label for the M1 announcement — falls
    // back to the raw chatId if Lark can't return a name. A p2p source has no
    // chat name (chat.get often fails or returns empty for DMs) — use the
    // locale-aware 单聊 label instead of leaking a raw oc_ id into the M1.
    const { getChatName } = await import('./client.js');
    const sourceLabel = sourceDs.chatType === 'p2p'
      ? t('card.relay.type_p2p', undefined, loc)
      : (await getChatName(larkAppId, sourceDs.chatId)) ?? sourceDs.chatId;
    // Send the M1 announcement.
    //   chat-scope: a plain top-level message; its id becomes the (audit-only)
    //               rootMessageId after the transfer (mirrors /relay --create).
    //   thread-scope: reply_in_thread INTO the target 话题 (anchor) so the
    //               announcement lands in the 话题; the session anchors on the
    //               话题 root (targetAnchor), NOT the M1 id.
    let m1MessageId: string;
    try {
      const m1Text = t(targetChatType === 'p2p' ? 'cmd.relay.m1_announce_dm' : 'cmd.relay.m1_announce', { sourceChat: sourceLabel, groupName: targetChatId }, loc);
      m1MessageId = targetScope === 'thread'
        ? await replyMessage(larkAppId, targetAnchor, m1Text, 'text', /*replyInThread*/ true)
        : await sendMessage(larkAppId, targetChatId, m1Text, 'text');
    } catch (err: any) {
      return { toast: { type: 'error', content: t('card.relay.toast_failed', { error: err?.message ?? 'send_m1_failed' }, loc) } };
    }
    const { transferSession, TRANSFER_DETACH_FENCE_PICKER_MS } = await import('../../core/worker-pool.js');
    // chat-scope → anchor on the M1 id (audit-only); thread-scope → anchor on
    // the 话题 root (targetAnchor) so future replies in the 话题 route here.
    // In-process picker relay has no HTTP abort above it (unlike the cross-daemon
    // /relay --create peer path), so give the observer-detach fence generous
    // headroom — a clean-but-slightly-slow worker teardown (~3.5s observed) must
    // not be misclassified as worker_detach_timeout.
    const r = targetScope === 'thread'
      ? await transferSession(sourceDs.session.sessionId, targetChatId, targetAnchor, targetChatType, 'thread', { detachTimeoutMs: TRANSFER_DETACH_FENCE_PICKER_MS })
      : await transferSession(sourceDs.session.sessionId, targetChatId, m1MessageId, targetChatType, 'chat', { detachTimeoutMs: TRANSFER_DETACH_FENCE_PICKER_MS });
    if (!r.ok) {
      // Best-effort: orphan M1 cleanup so a failed transfer doesn't leave a
      // misleading "已接力" message in the target chat (王皓's "明明失败了
      // 却返回成功了" complaint). Race-condition fallback only — the
      // pre-flight checks above should catch the common cases first.
      deleteMessage(larkAppId, m1MessageId).catch(() => { /* leave it */ });
      // Deliver the failure as a VISIBLE message, never a toast. The confirm
      // handler awaits the detach fence (up to TRANSFER_DETACH_FENCE_PICKER_MS
      // = 8s), which always exceeds the 2.5s card-ACK window — once the generic
      // "后台处理中" ACK has gone out, a toast can no longer be surfaced and is
      // silently dropped (only a `not shown to user` log line remained; this is
      // exactly the failure 申晗 hit — a false-timeout relay whose error the
      // user never saw). transferSession never commits the routing rewrite on
      // ANY !ok path, so the source session is always still intact; the copy
      // reassures the user it was not lost and points at a concrete retry (the
      // picker card + its 确认 button survive — we only delete them on success
      // below). Land the notice where the user is looking, mirroring the M1
      // delivery target: thread-scope → reply_in_thread into the 话题;
      // chat-scope → a top-level message in the target chat.
      const failText =
        r.error === 'worker_detach_timeout' ? t('card.relay.fail_timeout', undefined, loc)
        : r.error === 'worker_busy' ? t('card.relay.fail_worker_busy', undefined, loc)
        : r.error === 'target_chat_has_session' ? t('cmd.relay.target_has_session_msg', { title: '' }, loc)
        : r.error === 'adopt_not_relayable' ? t('card.relay.toast_adopt_not_relayable', undefined, loc)
        : r.error === 'not_started_yet' ? t('card.relay.toast_not_started_yet', undefined, loc)
        : t('card.relay.fail_generic', { error: r.error }, loc);
      try {
        if (targetScope === 'thread') {
          await replyMessage(larkAppId, targetAnchor, failText, 'text', /*replyInThread*/ true);
        } else {
          await sendMessage(larkAppId, targetChatId, failText, 'text');
        }
      } catch (e) {
        logger.warn(`[card-action] relay failure notice send failed (${e instanceof Error ? e.message : e}); relay error was: ${r.error}`);
      }
      return;
    }
    // Best-effort: remove the picker card now that the selection resolved.
    // Ephemeral (private) pickers need the ephemeral-delete endpoint —
    // deleteMessage (im/v1/messages) doesn't apply to ephemeral message ids.
    if (cardMessageId && larkAppId) {
      if (cardVisibility === 'private') {
        const { deleteEphemeralCard } = await import('./client.js');
        deleteEphemeralCard(larkAppId, cardMessageId).catch(() => { /* leave it */ });
      } else {
        deleteMessage(larkAppId, cardMessageId).catch(() => { /* leave it */ });
      }
    }
    return { toast: { type: 'success', content: t('card.relay.toast_success', undefined, loc) } };
  }

  // v3 humanGate 审批卡（独立 namespace，不混 v0.2 wait path）。**在通用 sensitive
  // 权限门之前**处理（codex medium）：v3 卡 value 没有 root_id/session_id，通用门只能
  // 用 chatId=undefined 做粗判，可能误拦；v3 自己的 `canResolve(binding, operator)`
  // 才有 run binding 的 chatId，是权威权限门。
  if (isV3GateAction(value?.action)) {
    if (!deps.v3GateDeps) return;
    return await handleV3GateAction(value as unknown as V3GateActionValue, operatorOpenId, deps.v3GateDeps);
  }
  if (isV3BlockedAction(value?.action)) {
    if (!deps.v3BlockedDeps) return;
    return await handleV3BlockedAction(
      value as unknown as V3BlockedActionValue | V3AskAnswerActionValue,
      operatorOpenId,
      deps.v3BlockedDeps,
      action?.form_value,
    );
  }
  if (isV3RevisitGrantAction(value?.action)) {
    if (!deps.v3RevisitGrantDeps) return;
    return await handleV3RevisitGrantAction(value as unknown as V3RevisitGrantActionValue, operatorOpenId, deps.v3RevisitGrantDeps);
  }
  if (isV3LoopGrantAction(value?.action)) {
    if (!deps.v3LoopGrantDeps) return;
    return await handleV3LoopGrantAction(value as unknown as V3LoopGrantActionValue, operatorOpenId, deps.v3LoopGrantDeps);
  }
  if (isV3RunSaveAction(value?.action)) {
    if (!deps.v3RunSaveDeps) return;
    return await handleV3RunSaveAction(
      value as unknown as V3RunSaveActionValue,
      operatorOpenId,
      larkAppId,
      deps.v3RunSaveDeps,
    );
  }
  if (isV3DistillationAction(value?.action)) {
    if (!deps.v3DistillationDeps) return;
    return await handleV3DistillationAction(
      value,
      operatorOpenId,
      larkAppId,
      cardMessageId,
      deps.v3DistillationDeps,
    );
  }

  const isSensitive = value?.action && ['restart', 'close', 'resume', 'skip_repo', 'repo_manual_submit', 'repo_worktree_submit', 'worktree_toggle_mode', 'retry_last_task', 'retry_turn', 'get_write_link', 'open_local_terminal', 'open_local_cli', 'toggle_stream', 'toggle_display', 'export_text', 'term_action', 'refresh_screenshot', 'takeover', 'disconnect', 'tui_keys', 'tui_text_input', 'wf_approve', 'wf_reject', 'wf_cancel', 'goal_cleanup_confirm', 'goal_cleanup_skip', 'stop_turn', 'compact_session'].includes(value.action);
  if (isSensitive) {
    const rootId = value?.root_id;
    // activeSessions is keyed by sessionKey(anchor, larkAppId) — `${anchor}::${larkAppId}`
    // (double colon). Earlier this was hand-spliced with a single colon and
    // always missed, falling through to the bare-rootId legacy lookup; that
    // worked for permission gating only because chatId came from elsewhere
    // most of the time. Use sessionKey() so the bot-scoped lookup actually
    // hits, and keep the bare-rootId fallback for legacy single-bot cards.
    const ds = rootId
      ? (larkAppId
          ? getSessionByActionValue(activeSessions, rootId, larkAppId, value?.session_id, value?.action)
          : activeSessions.get(rootId))
      : undefined;
    // Resume targets a closed session — fall back to the persistent store so
    // we can still pin chatId/larkAppId for the canOperate gate.
    const closedForCtx = !ds && value?.action === 'resume' && value?.session_id
      ? sessionStore.getSession(value.session_id)
      : undefined;
    const effectiveAppId = larkAppId ?? ds?.larkAppId ?? closedForCtx?.larkAppId;
    const chatId = ds?.chatId ?? closedForCtx?.chatId;
    // pendingRepo 阶段，会话发起人（含 chat-granted 用户）可以 skip_repo / 手动填目录
    // 起会话——与 repo 下拉选择同款例外，否则被授权人连自己的首次会话都启动不了。
    // 注意：worktree_toggle_mode 故意不在此列——它持久写 bot 级 worktreeMultiPicker
    // （影响该 bot 所有后续会话），属管理动作，必须走 canOperate，不能让 talk-only/
    // chat-granted 用户借「开自己的 pending 卡」绕过去改 bot 配置。
    const pendingRepoOwnerException =
      (value.action === 'skip_repo' || value.action === 'repo_manual_submit' || value.action === 'repo_worktree_submit') && !!ds?.pendingRepo &&
      !!operatorOpenId && operatorOpenId === ds.session.ownerOpenId;
    if (effectiveAppId) {
      if (!pendingRepoOwnerException && !canOperate(effectiveAppId, chatId, operatorOpenId)) {
        logger.info(`Card action "${value.action}" blocked for non-operator user: ${operatorOpenId} (chat=${chatId})`);
        // get_write_link 显式破例：其余敏感动作沿用「静默 block（仅日志）」的既有设计
        // （test/card-handler-repo-select.test.ts 把这点 pin 住了），但「获取操作链接」是
        // 用户主动点的取权动作，静默会让人以为按钮坏了——给一条明确的「无操作权限」toast。
        if (value.action === 'get_write_link' || value.action === 'open_local_terminal' || value.action === 'open_local_cli') {
          const key = value.action === 'open_local_terminal'
            ? 'card.action.local_terminal_no_permission'
            : value.action === 'open_local_cli'
              ? 'card.action.local_cli_no_permission'
              : 'card.action.write_link_no_permission';
          return { toast: { type: 'warning', content: t(key, undefined, localeForBot(effectiveAppId)) } };
        }
        return;
      }
    } else {
      const bots = getAllBots();
      const allowedUsers = bots.flatMap(b => b.resolvedAllowedUsers);
      // globalGrants 与 allowedChatGroups 同理计入 hasAllowlist：只配 globalGrants（talk-only）
      // 也算限制态，否则这条手写 fallback 会算成 false → 敏感动作 fall through 成全开放。
      // 注意只进 hasAllowlist 判定，命中仍只认 allowedUsers（与 canOperate 一致，不授 operate）。
      const hasAllowlist = allowedUsers.length > 0
        || bots.some(b => (b.config.allowedChatGroups?.length ?? 0) > 0)
        || bots.some(b => (b.config.globalGrants?.length ?? 0) > 0)
        // p2pOpen 同理（与 evaluateTalk 的 hasConfiguredAllowlist 保持一致）：它是一次显式的
        // 权限边界声明，不能让这条 fallback 把「只配 p2pOpen」的部署算成无白名单 → 敏感卡片
        // 动作 fall through 成全开放。
        || bots.some(b => b.config.p2pOpen === true);
      if (hasAllowlist && (!operatorOpenId || !allowedUsers.includes(operatorOpenId))) {
        logger.info(`Card action "${value.action}" blocked for non-allowed user: ${operatorOpenId}`);
        // 与上面 non-operator 分支同理：仅 get_write_link 破例给 toast，其余保持静默。
        if (value.action === 'get_write_link' || value.action === 'open_local_terminal' || value.action === 'open_local_cli') {
          const key = value.action === 'open_local_terminal'
            ? 'card.action.local_terminal_no_permission'
            : value.action === 'open_local_cli'
              ? 'card.action.local_cli_no_permission'
              : 'card.action.write_link_no_permission';
          return { toast: { type: 'warning', content: t(key, undefined, localeForBot(larkAppId)) } };
        }
        return;
      }
    }
  }

  // Historical v2 workflow cards remain in chat history after the runtime is
  // removed. Treat every legacy callback as a tombstone instead of allowing it
  // to fall through to an unrelated generic card action.
  if (
    typeof value?.action === 'string' &&
    (value.action.startsWith('wf_') || value.action.startsWith('dash_workflows_'))
  ) {
    return {
      toast: {
        type: 'warning',
        content: 'v2 workflow 已下线；旧卡片不再可操作，请迁移定义后使用 /workflow。',
      },
    };
  }

  if (value?.action === 'goal_cleanup_confirm') {
    const goalChatId = value.goal_chat_id;
    if (!goalChatId) {
      return { toast: { type: 'error', content: '缺少 goal_chat_id，无法清理。' } };
    }
    // Publish the durable tombstone BEFORE the async fanout. Otherwise the
    // watchdog can auto-revive a supervisor while cleanup is waiting on peer
    // daemons; if this daemon's cleanup-local call already ran, that new
    // session survives the fanout and keeps working after the UI says closed.
    const closedRegistry = closeGoalChat(goalChatId, { closedBy: operatorOpenId });
    // Fan out to EVERY online daemon (self included): each closes its own
    // chat-scope sessions bound to this goal. A goal group hosts workers from
    // several bots, and each bot's sessions live in its own daemon process —
    // so the old card-owner-local loop left the other bots' workers orphaned
    // (F5). Mirrors routeGoalParentReplyAcrossDaemons: all peers, concurrent,
    // per-call timeout, best-effort (a dead peer ages out of the registry).
    const perDaemon = await Promise.all(listOnlineDaemons().map(async (d) => {
      const ctrl = new AbortController();
      const tt = setTimeout(() => ctrl.abort(), 5_000);
      try {
        const r = await fetch(
          `http://127.0.0.1:${d.ipcPort}/api/goal/${encodeURIComponent(goalChatId)}/cleanup-local`,
          { method: 'POST', signal: ctrl.signal },
        );
        const body = await r.json().catch(() => null) as {
          closed?: number;
          residual?: number;
          failed?: number;
        } | null;
        if (!body || typeof body.closed !== 'number') {
          return { closed: 0, residual: 0, failed: 1 };
        }
        return {
          closed: body.closed,
          residual: typeof body.residual === 'number' ? body.residual : 0,
          failed: typeof body.failed === 'number' ? body.failed : (r.ok ? 0 : 1),
        };
      } catch (err) {
        logger.warn(`[goal-cleanup] fanout to ${d.larkAppId}@${d.ipcPort} failed: ${err}`);
        return { closed: 0, residual: 0, failed: 1 };
      } finally {
        clearTimeout(tt);
      }
    }));
    const closed = perDaemon.reduce((total, item) => total + item.closed, 0);
    const residual = perDaemon.reduce((total, item) => total + item.residual, 0);
    const failed = perDaemon.reduce((total, item) => total + item.failed, 0);
    logger.info(
      `[goal-cleanup] ${operatorOpenId ?? '?'} closed ${closed} chat-scope sessions across daemons `
      + `for goal=${goalChatId}; residual=${residual}; failed=${failed}; registryClosed=${Boolean(closedRegistry)}`,
    );
    // Narrate into the goal group so observers see the cleanup actually fired —
    // the sessions are gone, but the card is sent by the bot directly (not via a
    // session), so the goal group still gets a visible 🧹 marker.
    if (larkAppId) {
      await emitGoalNarration({
        larkAppId,
        goalChatId,
        event: { type: 'cleanup', key: `narr:cleanup:${goalChatId}:${cardMessageId ?? closed}`, closed },
      }).catch(err => logger.warn(`[goal-cleanup] narration failed: ${err}`));
    }
    const incomplete = residual > 0 || failed > 0;
    const followUp = incomplete
      ? `\n\n⚠️ 其中 **${residual}** 个会话仍有残留，**${failed}** 个会话关闭失败或 daemon 未响应，请继续人工处理。`
      : '';
    return {
      config: { wide_screen_mode: true },
      header: {
        template: incomplete ? 'orange' : 'green',
        title: { tag: 'plain_text', content: incomplete ? 'Goal 会话清理需跟进' : 'Goal 会话已清理' },
      },
      elements: [{
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: `已本地关闭 **${closed}** 个 goal 群 chat-scope 会话。${followUp}\n\n已停止该 goal 的自动恢复；Goal 群保留，不退群、不删群。`,
        },
      }],
    };
  }

  if (value?.action === 'goal_cleanup_skip') {
    return {
      config: { wide_screen_mode: true },
      header: { template: 'blue', title: { tag: 'plain_text', content: 'Goal 会话暂不清理' } },
      elements: [{
        tag: 'div',
        text: { tag: 'lark_md', content: '已保留 goal 群内会话。需要时可再次确认清理。' },
      }],
    };
  }

  // Handle session card button actions (restart/close)
  // ─── /adopt V2 picker: state-changing re-renders (pick / page / search) ─
  // Mirrors the /relay picker. Lark cards are stateless server-side, so every
  // callback value carries the full state (search / page / selected / root_id /
  // invoker). We reuse the candidates snapshot cached at first render so a page
  // flip or search doesn't re-shell-out to tmux; on a cache miss (TTL expiry /
  // daemon restart) we re-discover and re-cache.
  if (value?.action && larkAppId && ['adopt_pick', 'adopt_page', 'adopt_search'].includes(value.action as string)) {
    const rootId = value.root_id as string | undefined;
    if (!rootId) return { toast: { type: 'error', content: t('card.adopt.toast_missing_value', undefined, localeForBot(larkAppId)) } };
    const loc = localeForBot(larkAppId);
    const sKey = sessionKey(rootId, larkAppId);
    const ds = activeSessions.get(sKey);
    if (!ds) return { toast: { type: 'error', content: t('card.adopt.toast_no_session', undefined, loc) } };

    // Owner-only, same gate as the command path.
    if (!canOperate(ds.larkAppId, ds.chatId, operatorOpenId)) {
      return { toast: { type: 'error', content: t('card.adopt.toast_no_perm', undefined, loc) } };
    }
    // Pin the card to its summoner (legacy cards without the field pass through).
    const invokerOpenId = value.invoker_open_id as string | undefined;
    if (invokerOpenId && operatorOpenId && invokerOpenId !== operatorOpenId) {
      return { toast: { type: 'error', content: t('card.adopt.toast_not_invoker', undefined, loc) } };
    }

    // Reconstruct next state from the action.
    let nextSearch = (value.search as string) ?? '';
    let nextPage = Number(value.page ?? 0) || 0;
    let nextSelected: string | undefined = (value.selected as string) || undefined;
    if (value.action === 'adopt_search') {
      nextSearch = String((action as any)?.input_value ?? '').trim();
      nextPage = 0;
      nextSelected = undefined; // new filter → drop selection
    } else if (value.action === 'adopt_page') {
      nextPage = Number(value.page ?? 0) || 0;
    } else if (value.action === 'adopt_pick') {
      nextSelected = value.entry_key as string | undefined;
    }

    const botCfg = getBot(ds.larkAppId).config;
    const {
      collectAdoptCandidates,
      cacheAdoptCandidates,
      getCachedAdoptCandidates,
    } = await import('../../services/adopt-picker.js');
    let candidates = getCachedAdoptCandidates(rootId, Date.now());
    if (!candidates) {
      const { discoverResumableSessionsForBot, ADOPT_RESUME_LIMIT } = await import('../../core/command-handler.js');
      candidates = await collectAdoptCandidates(
        botCfg.cliId, botCfg.cliPathOverride, activeSessions,
        discoverResumableSessionsForBot, ADOPT_RESUME_LIMIT,
        botCfg.cliRuntime?.executable,
      );
      cacheAdoptCandidates(rootId, candidates, Date.now());
    }
    const { buildAdoptSelectCard } = await import('./card-builder.js');
    const cardJson = buildAdoptSelectCard(
      candidates.sessions, rootId, loc, candidates.resumable,
      { selectedKey: nextSelected, searchQuery: nextSearch, page: nextPage },
      invokerOpenId ?? operatorOpenId,
      candidates.resumeLimit,
      botCfg.cliId,
      sessionRuntimeDisplayName(ds),
    );
    // event-dispatcher wraps this as { card: { type: 'raw', data } } → in-place patch.
    return JSON.parse(cardJson);
  }

  // ─── /adopt V2 picker: confirm (dispatch to adopt or resume-import) ─────
  // Confirm does NOT trust the cached snapshot for liveness — a live pane may
  // have exited since render. Live targets re-discover (fast-path by tmux
  // target to stay inside Lark's 3s callback budget); resume targets re-scan
  // disk. The cached entry only tells us WHICH target the key refers to.
  if (value?.action === 'adopt_confirm' && larkAppId) {
    const rootId = value.root_id as string | undefined;
    const entryKey = value.entry_key as string | undefined;
    if (!rootId || !entryKey) return;
    const loc = localeForBot(larkAppId);
    const sKey = sessionKey(rootId, larkAppId);
    const ds = activeSessions.get(sKey);
    if (!ds) return { toast: { type: 'error', content: t('card.adopt.toast_no_session', undefined, loc) } };
    // The picker can live in a folded chat-scope topic while rootId remains the
    // chat session anchor. Freeze the trusted card placement before adoption
    // mutates the session, so its success/error replies stay beside the picker.
    const replyOptionsPromise = cardReplyOptions(larkAppId, cardMessageId, ds.chatId);
    const pickerSessionReply: CardHandlerDeps['sessionReply'] = async (
      rid,
      content,
      msgType,
      appId,
      turnId,
      opts,
    ) => {
      const placement = await replyOptionsPromise;
      return deps.sessionReply(
        rid,
        content,
        msgType,
        appId,
        turnId,
        opts?.replyTarget || !placement
          ? opts
          : { ...opts, replyTarget: placement.replyTarget },
      );
    };
    const pickerDeps: CardHandlerDeps = { ...deps, sessionReply: pickerSessionReply };
    const pickerReply = (content: string, msgType?: string) =>
      pickerSessionReply(rootId, content, msgType, larkAppId);
    const sourceSession = ds.session;
    if (isSessionTransferring(ds)) {
      return { toast: { type: 'warning', content: t('cmd.session.transfer_in_progress', undefined, localeForBot(ds.larkAppId)) } };
    }
    if (!canOperate(ds.larkAppId, ds.chatId, operatorOpenId)) {
      return { toast: { type: 'error', content: t('card.adopt.toast_no_perm', undefined, loc) } };
    }
    const invokerOpenId = value.invoker_open_id as string | undefined;
    if (invokerOpenId && operatorOpenId && invokerOpenId !== operatorOpenId) {
      return { toast: { type: 'error', content: t('card.adopt.toast_not_invoker', undefined, loc) } };
    }

    const botCfg = getBot(ds.larkAppId).config;
    const { clearAdoptCandidates } = await import('../../services/adopt-picker.js');

    // ── Resume-import path (key = "resume:<cliSessionId>") ──────────────
    if (entryKey.startsWith('resume:')) {
      const cliSessionId = entryKey.slice('resume:'.length);
      const { discoverResumableSessionsForBot, startResumeImportSession, ADOPT_RESUME_LIMIT } = await import('../../core/command-handler.js');
      const resumable = await discoverResumableSessionsForBot(botCfg.cliId, botCfg.cliPathOverride, activeSessions, ADOPT_RESUME_LIMIT);
      if (
        ds.session !== sourceSession || ds.session.status !== 'active'
        || activeSessions.get(sKey) !== ds || isSessionTransferring(ds)
      ) {
        return { toast: { type: 'warning', content: t('cmd.session.transfer_in_progress', undefined, localeForBot(ds.larkAppId)) } };
      }
      const target = resumable.find(r => r.cliSessionId === cliSessionId);
      if (!target) {
        await pickerReply(t('cmd.adopt.resume_not_found', undefined, localeForBot(ds.larkAppId)));
        clearAdoptCandidates(rootId);
        if (cardMessageId && larkAppId) deleteMessage(larkAppId, cardMessageId);
        return;
      }
      await startResumeImportSession(target, ds, { ...pickerDeps, getActiveCount: () => 0 }, larkAppId);
      clearAdoptCandidates(rootId);
      if (cardMessageId && larkAppId) deleteMessage(larkAppId, cardMessageId);
      return;
    }

    // ── Live-adopt path (key = "live:...") ──────────────────────────────
    // The cached snapshot only tells us WHICH pane the key referred to; we
    // re-discover fresh so startAdoptSession gets a live pid (a pane may have
    // exited since render). adoptLiveKey mirrors the builder's key format so
    // a freshly-discovered session maps back to the clicked entry_key.
    const { adoptLiveKey } = await import('./card-builder.js');
    const { discoverAdoptableSessions, discoverAdoptableSessionByTarget, excludeOwnedHerdrAdoptTargets } = await import('../../core/session-discovery.js');
    const { discoverAdoptableZellijSessions } = await import('../../core/zellij-adopt-discovery.js');
    async function resolveLive() {
      // Zellij keys carry "live:zellij:" — resolve from the zellij backend.
      if (entryKey!.startsWith('live:zellij:')) {
        return discoverAdoptableZellijSessions(botCfg.cliId, botCfg.cliRuntime?.executable)
          .find(s => adoptLiveKey(s) === entryKey);
      }
      // Fast path: the key IS "live:<adoptTargetKey>" = "live:tmux:<target>:<pid>".
      // Parse the tmux target for a cheap single-pane resolve, staying under
      // Lark's 3s callback budget (a full scan can take seconds on many panes).
      const inner = entryKey!.slice('live:'.length); // e.g. "tmux:0:2.0:12345"
      const parts = inner.split(':');
      if (parts[0] === 'tmux' && parts.length >= 3) {
        const tmuxTarget = parts.slice(1, -1).join(':'); // drop "tmux" + trailing pid
        const fast = discoverAdoptableSessionByTarget(
          tmuxTarget,
          botCfg.cliId,
          botCfg.cliRuntime?.executable,
        );
        if (fast && adoptLiveKey(fast) === entryKey) return fast;
      }
      const ownedHerdrTargets = [...activeSessions.values()].flatMap(active => {
        const t2 = active.session.persistentBackendTarget;
        return active.session.status === 'active' && !active.adoptedFrom && t2?.backendType === 'herdr' && !!t2.agentName
          ? [{ sessionName: t2.sessionName, agentName: t2.agentName }] : [];
      });
      return excludeOwnedHerdrAdoptTargets(
        discoverAdoptableSessions(botCfg.cliId, botCfg.cliRuntime?.executable),
        ownedHerdrTargets,
      )
        .find(s => adoptLiveKey(s) === entryKey);
    }
    let target = await resolveLive();
    for (let attempt = 0; !target && attempt < 3; attempt++) {
      await new Promise(r => setTimeout(r, 150));
      target = await resolveLive();
    }
    if (
      ds.session !== sourceSession || ds.session.status !== 'active'
      || activeSessions.get(sKey) !== ds || isSessionTransferring(ds)
    ) {
      return { toast: { type: 'warning', content: t('cmd.session.transfer_in_progress', undefined, localeForBot(ds.larkAppId)) } };
    }
    if (!target) {
      await pickerReply(t('cmd.adopt.target_exited', undefined, localeForBot(ds.larkAppId)));
      clearAdoptCandidates(rootId);
      if (cardMessageId && larkAppId) deleteMessage(larkAppId, cardMessageId);
      return;
    }
    const { startAdoptSession } = await import('../../core/command-handler.js');
    await startAdoptSession(target, ds, { ...pickerDeps, getActiveCount: () => 0 }, larkAppId);
    clearAdoptCandidates(rootId);
    if (cardMessageId && larkAppId) deleteMessage(larkAppId, cardMessageId);
    return;
  }

  if (value?.action) {
    const { action: actionType, root_id: rootId } = value;
    const sKey = larkAppId ? sessionKey(rootId, larkAppId) : rootId;
    const ds = larkAppId
      ? getSessionByActionValue(activeSessions, rootId, larkAppId, value.session_id, actionType)
      : activeSessions.get(rootId);

    const launchLocalCli = (target: DaemonSession, locDs: Locale) => {
      const cliId = sessionCliId(target);
      const mode = localCliOpenMode();
      const preflight = preflightLocalCliOpen(target, { cliId, mode });
      if (!preflight.ok) {
        logger.warn(`[${tag(target)}] Rejected ${actionType} preflight: ${preflight.error}: ${preflight.message}`);
        if (preflight.error === 'missing_resume_id') {
          return { toast: { type: 'warning', content: t('card.action.local_cli_not_ready', undefined, locDs) } };
        }
        if (preflight.error === 'unsupported_cli' || preflight.error === 'unsupported_backend' || preflight.error === 'missing_attach_target') {
          return { toast: { type: 'warning', content: t('card.action.local_terminal_unsupported', { cliName: sessionCliDisplayName(target) }, locDs) } };
        }
        return { toast: { type: 'error', content: t('card.action.local_cli_failed', { reason: preflight.message }, locDs) } };
      }
      const reportFailure = (reason: string) => {
        if (value.visibility === 'private') {
          logger.warn(`[${tag(target)}] ${actionType} failed for private card; suppressing public fallback: ${reason}`);
          return;
        }
        void sessionReply(rootId, t('card.action.local_cli_failed', { reason }, locDs))
          .catch((err) => logger.warn(`[${tag(target)}] ${actionType} failure reply failed: ${err instanceof Error ? err.message : String(err)}`));
      };
      void openLocalCliInIterm(target, { cliId, mode })
        .then((result) => {
          if (!result.ok) {
            logger.warn(`[${tag(target)}] ${actionType} failed: ${result.error}: ${result.message}`);
            reportFailure(result.message);
            return;
          }
          logger.info(`[${tag(target)}] ${actionType} launched local terminal for ${cliId} (${mode})`);
        })
        .catch((err) => {
          const reason = err instanceof Error ? err.message : String(err);
          logger.warn(`[${tag(target)}] ${actionType} crashed: ${reason}`);
          reportFailure(reason);
        });
      return {
        toast: {
          type: 'success',
          content: t('card.action.local_cli_opened', { cliName: sessionCliDisplayName(target) }, locDs),
        },
      };
    };

    const guardLocalCliOpen = (target: DaemonSession, locDs: Locale) => {
      if (!isLocalCliOpenConfigured()) {
        logger.info(`[${tag(target)}] Rejected ${actionType}: native CLI opening is disabled`);
        return { toast: { type: 'warning', content: t('card.action.local_cli_disabled', undefined, locDs) } };
      }
      if (!isLocalCliOpenCapable()) {
        logger.info(`[${tag(target)}] Rejected ${actionType}: daemon host cannot open the native CLI`);
        return {
          toast: {
            type: 'warning',
            content: t('card.action.local_terminal_unsupported', { cliName: sessionCliDisplayName(target) }, locDs),
          },
        };
      }
    };

    if (ds && actionType === 'open_local_cli') {
      const actualCliId = sessionCliId(ds);
      const locDs = localeForBot(ds.larkAppId);
      if (!value?.cli_id) {
        return { toast: { type: 'error', content: t('card.action.local_cli_missing_cli_id', undefined, locDs) } };
      }
      if (value.cli_id !== actualCliId) {
        logger.warn(
          `[${tag(ds)}] Rejected open_local_cli from mismatched CLI card: expected=${value.cli_id} actual=${actualCliId}`,
        );
        return { toast: { type: 'error', content: t('card.action.local_cli_cli_mismatch', undefined, locDs) } };
      }
    } else if (ds && !validateCardCliBinding(ds, value)) return;

    if (actionType === 'open_local_cli') {
      const locDs = localeForBot(ds?.larkAppId ?? larkAppId);
      if (!ds) {
        return { toast: { type: 'warning', content: t('card.action.session_gone', undefined, locDs) } };
      }
      const blocked = guardLocalCliOpen(ds, locDs);
      if (blocked) return blocked;
      return launchLocalCli(ds, locDs);
    }

    // 🔊 语音总结 — no permission gate (任意人可点). Inject a condense-and-speak
    // instruction into the session; the model emits the voice via
    // `botmux send --voice`. Dedup per card so only one voice is generated.
    if (actionType === 'voice_summary') {
      const locDs = localeForBot(ds?.larkAppId ?? larkAppId);
      if (!ds) {
        return { toast: { type: 'warning', content: t('card.voice.toast_session_gone', undefined, locDs) } };
      }
      // 权限：仅 canTalk / canOperate 用户可点；其他人提示需授权（无声门会让人以为按钮坏了）。
      // 传 ds.chatType：p2pOpen 的 bot 在私聊里，对方点自己会话的卡片按钮应与其 talk 权一致
      // （仍不给 canOperate —— 管理类按钮另有 canOperate 闸）。
      if (!canTalk(ds.larkAppId, ds.chatId, operatorOpenId, undefined, undefined, ds.chatType)
        && !canOperate(ds.larkAppId, ds.chatId, operatorOpenId)) {
        logger.info(`[${tag(ds)}] voice_summary blocked for unauthorized user: ${operatorOpenId ?? '?'}`);
        return { toast: { type: 'warning', content: t('card.voice.toast_need_auth', undefined, locDs) } };
      }
      // Dedupe read BEFORE the busy guard: a card whose voice is already being
      // generated will have its worker back in `working`, so the busy guard would
      // otherwise shadow the "already on the way" hint with a misleading
      // "wait for idle" toast. Read first (correct message), guard second, and
      // only `add` after the guard so a genuinely-busy first click still doesn't
      // burn the dedupe key.
      const dedupeKey = cardMessageId ?? `${sessionAnchorId(ds)}::voice`;
      if (voicedCardIds.has(dedupeKey)) {
        return { toast: { type: 'info', content: t('card.voice.toast_already', undefined, locDs) } };
      }
      if (!isLiveWorkerIdleOrLimited(ds)) {
        logger.info(`[${tag(ds)}] voice_summary blocked because worker is busy: ${ds.lastScreenStatus ?? 'unknown'}`);
        return { toast: { type: 'warning', content: t('card.voice.toast_worker_busy', undefined, locDs) } };
      }
      if ((!ds.worker || ds.worker.killed) && hasProtectedSessionMutationOwnership(ds)) {
        logger.info(`[${tag(ds)}] voice_summary deferred behind durable opening ownership`);
        return { toast: { type: 'warning', content: t('card.voice.toast_worker_busy', undefined, locDs) } };
      }
      const instruction = voiceSummaryInstruction(locDs);
      const voiceInput = {
        content: instruction,
        codexAppInput: withCodexAppContext(
          { text: t('card.voice.user_message', undefined, locDs) },
          'botmux_voice_summary_instruction',
          instruction,
          'application',
        ),
      };
      let accepted = false;
      try {
        if (ds.worker && !ds.worker.killed) accepted = sendWorkerInput(ds, voiceInput);
        else {
          forkWorker(ds, voiceInput, ds.hasHistory);
          accepted = true;
        }
      } catch (err) {
        logger.warn(
          `[${tag(ds)}] voice_summary failed before acceptance: `
          + `${err instanceof Error ? err.message : String(err)}`,
        );
      }
      if (!accepted) {
        return { toast: { type: 'warning', content: t('card.voice.toast_worker_busy', undefined, locDs) } };
      }
      // Burn the replay key only after live IPC or the durable activation tail
      // accepted the exact instruction.
      voicedCardIds.add(dedupeKey);
      if (voicedCardIds.size > 5000) { voicedCardIds.clear(); voicedCardIds.add(dedupeKey); }
      logger.info(`[${tag(ds)}] voice_summary triggered by ${operatorOpenId ?? '?'}`);
      return { toast: { type: 'success', content: t('card.voice.toast_wait', undefined, locDs) } };
    }

    if (actionType === 'restart' && ds) {
      // Adopt sessions: hard-reject. botmux never owned the user's CLI;
      // restarting would mean killing their tmux pane / Claude process,
      // which violates the bridge invariant. Defense in depth — buildSessionCard
      // already omits the restart button when adoptMode=true, but a stale
      // pre-fix card or a malformed action payload could still arrive.
      const locDs = localeForBot(ds.larkAppId);
      if (isSharedAdoptSession(ds)) {
        logger.warn(`[${tag(ds)}] Rejected restart on shared adopt — would replace the source conversation client`);
        await sessionReply(rootId, t('card.action.adopt_no_restart', undefined, locDs));
        return;
      }
      // New remote cards omit this button, but old/stale cards remain
      // clickable. Surface the same explicit close-and-recreate guidance as
      // /restart. This must cover EVERY remote backend: unlike riff (whose
      // worker refuses restart), a mojo worker EXECUTES restart — its teardown
      // cancels the remote session and cold-boots a context-less replacement —
      // so a riff-only guard here was a real user entry point into a silent
      // remote-session destruction (fourth-round review, gate 1).
      if (isRemoteBackendSession(ds)) {
        logger.warn(`[${tag(ds)}] Rejected restart on remote backend session`);
        const unsupported = t('cmd.restart.remote_unsupported', undefined, locDs);
        await deliverEphemeralOrReply(
          ds,
          operatorOpenId,
          unsupported,
          'text',
          () => sessionReply(rootId, unsupported),
        );
        return;
      }
      // Codex App: an accepted-but-unsettled dispatch still owns the turn route.
      // requestSessionRestart does not itself gate on dispatch ownership, so
      // reject here before the restart coordinator tears the worker down.
      if (hasProtectedSessionMutationOwnership(ds)) {
        await sessionReply(
          rootId,
          '当前 Codex App 仍有未结算消息，暂不能重启；请等待本轮完成或关闭会话。',
        );
        return;
      }
      if (isSessionTransferring(ds)) {
        return {
          toast: {
            type: 'warning',
            content: t('cmd.session.transfer_in_progress', undefined, locDs),
          },
        };
      }
      const effectiveCliId = sessionCliId(ds);
      const cliName = sessionCliDisplayName(ds);
      logger.info(`[${tag(ds)}] Correlated restart via card button`);
      requestSessionRestart(ds, {
        source: 'card',
        notify: status => {
          const content = t(`cmd.restart.${status}`, { cliName }, locDs);
          return deliverEphemeralOrReply(
            ds,
            operatorOpenId,
            content,
            'text',
            () => sessionReply(rootId, content),
          );
        },
      });
    }

    if (actionType === 'close') {
      if (!ds) {
        // 会话已不在 activeSessions（已关过 / 卡片过期 / daemon 重启丢失）——点「关闭
        // 会话」却静默无反应会让人以为按钮坏了，给一条失败 toast（成功路径不弹，已关卡即反馈）。
        return { toast: { type: 'warning', content: t('card.action.session_gone', undefined, localeForBot(larkAppId)) } };
      }
      // Historical cards can still carry the old `close` action. A shared
      // adopt must never interpret it as permission to terminate the source
      // conversation; treat it as "disconnect BotMux" just like /close does.
      if (isSharedAdoptSession(ds)) {
        const targetSessionId = ds.session.sessionId;
        const disconnected = await withBotTurnMutation(ds.larkAppId, async () => {
          const current = [...activeSessions.values()].find(
            candidate => candidate.session.sessionId === targetSessionId,
          );
          if (!current || !isSharedAdoptSession(current)) return 'missing' as const;
          try {
            const result = await closeWorkerPoolSession(targetSessionId, { awaitWorkerExit: false });
            if (!result.ok) return 'refused' as const;
            return result.outcome === 'closed' ? 'closed' as const : 'residual' as const;
          } catch {
            return 'refused' as const;
          }
        });
        const locDs = localeForBot(ds.larkAppId);
        if (disconnected === 'missing') {
          return { toast: { type: 'warning', content: t('card.action.session_gone', undefined, localeForBot(larkAppId)) } };
        }
        if (disconnected === 'refused') {
          await sessionReply(rootId, t('cmd.detach.failed', undefined, locDs));
          return;
        }
        if (disconnected === 'residual') {
          await sessionReply(rootId, t('cmd.detach.residual', undefined, locDs));
          return;
        }
        await sessionReply(
          rootId,
          t(
            ds.session.existingAppServerEndpoint
              ? 'cmd.detach.existing_app_server_success'
              : 'cmd.detach.success',
            undefined,
            locDs,
          ),
        );
        logger.info(`[${tag(ds)}] Historical close action treated as shared-adopt disconnect`);
        return;
      }
      const targetSessionId = ds.session.sessionId;
      const closed = await withBotTurnMutation(ds.larkAppId, async () => {
        // Card payload roots survive transfers. Re-resolve by immutable session
        // id after draining admissions, then let the pool remove the target's
        // CURRENT activeSessionKey. Never delete the stale payload root, which
        // may now belong to an unrelated pending FIFO owner.
        const current = [...activeSessions.values()].find(
          candidate => candidate.session.sessionId === targetSessionId,
        );
        if (!current) return undefined;
        const botCfg = getBot(current.larkAppId).config;
        // Build the closed card BEFORE closeWorkerPoolSession — it reads the
        // live session's identity off `current`.
        const card = buildClosedSessionCard(current, localeForBot(current.larkAppId));
        // The clicked card IS the live streaming card in the common in-thread
        // (non-private) case. When so, patch it in place via the callback return
        // below instead of sending a separate closed card — a stray extra card
        // (and its now-dead buttons) is what we're avoiding. Only when the
        // clicked message is that streaming card and we're not in private mode.
        const patchClickedCardInPlace = !!cardMessageId
          && cardMessageId === current.streamCardId
          && value?.visibility !== 'private'
          && !botCfg.privateCard;
        let closeResult;
        try {
          // Don't await the worker exiting — a busy CLI only dies at the ~7s
          // SIGKILL backstop, which blows past Lark's ~3s card-ACK window and
          // surfaces the client-side "code: 300000" toast. The logical close is
          // synchronous; the worker is killed in the background.
          closeResult = await closeWorkerPoolSession(targetSessionId, { awaitWorkerExit: false });
        } catch (err) {
          logger.error(`[${tag(current)}] Refused close because backing teardown was not verified: ${err}`);
          return { status: 'teardown_failed' as const, err };
        }
        // Returned (not thrown) refusal: the remote session could not be proven
        // cancelled, so the row stays active. Sending the closed card here would
        // tell the user it is gone while it keeps running.
        if (!closeResult.ok) {
          logger.error(
            `[${tag(current)}] Refused close: remote cancellation not proven (${closeResult.error})`,
          );
          return { status: 'close_refused' as const, result: closeResult };
        }
        if (closeResult.outcome === 'closed_with_residual') {
          return {
            status: 'closed_with_residual' as const,
            current,
            botCfg,
            card,
            residual: closeResult.residual,
          };
        }
        return { status: 'closed' as const, current, botCfg, card, patchClickedCardInPlace };
      });
      if (!closed) {
        return { toast: { type: 'warning', content: t('card.action.session_gone', undefined, localeForBot(larkAppId)) } };
      }
      if (closed.status === 'teardown_failed') {
        return {
          toast: {
            type: 'warning',
            content: `会话关闭失败：${closed.err instanceof Error ? closed.err.message : String(closed.err)}`,
          },
        };
      }
      if (closed.status === 'closed_with_residual') {
        // Closed locally, with a residual. A LOCAL-subtree residual has no taskId,
        // so the old wording rendered "远端会话 undefined 未被取消" and pointed the
        // operator at a nonexistent remote session (round-11 P1-2).
        return {
          toast: {
            type: 'warning',
            content: closeResidualIsLocal(closed.residual)
              ? `会话已在本地关闭、远端会话已取消，但本机可能残留带凭证子进程未确认终止`
                + `（${describeCloseResidual(closed.residual)}），请人工核查该主机进程。`
              : `会话已在本地关闭，但远端会话 ${closed.residual.taskId} 未被取消`
                + '（控制面无法验证），需要人工清理。',
          },
        };
      }
      if (closed.status === 'close_refused') {
        const locClose = localeForBot(larkAppId);
        return {
          toast: {
            type: 'warning',
            content: closed.result.taskId
              ? t('card.action.close_refused_with_task', {
                  error: closed.result.error,
                  taskId: closed.result.taskId,
                }, locClose)
              : t('card.action.close_refused', { error: closed.result.error }, locClose),
          },
        };
      }
      const { current, botCfg, card, patchClickedCardInPlace } = closed;
      // The closed card carries session title / CLI name / workingDir / resume
      // command. In private-card mode those must not leak to the group — send the
      // closed card ephemeral to the same owner audience instead. No group
      // fallback on failure (privacy wins; the session is already closed).
      // `value.visibility === 'private'` pins the decision to the card that was
      // clicked, so a card built in private mode stays ephemeral even if the
      // bot's `privateCard` config was turned off in the meantime.
      if (value?.visibility === 'private' || botCfg.privateCard) {
        const audience = resolvePrivateCardAudience(current);
        for (const openId of audience) {
          await sendEphemeralCard(current.larkAppId, current.chatId, openId, card).catch(err =>
            logger.warn(`[${tag(current)}] private close card ephemeral send to ${openId.substring(0, 8)}… failed: ${err}`));
        }
        logger.info(`[${tag(current)}] Closed via card button (private close card → ${audience.length} owner(s))`);
      } else {
        if (patchClickedCardInPlace) {
          // Return the closed card as the callback response → Lark patches the
          // just-clicked streaming card in place (no delete, no separate send,
          // no "code: 300000" race). The "等待输入" card becomes the closed card
          // with its now-dead buttons removed.
          logger.info(`[${tag(current)}] Closed via card button (in-place patch)`);
          return JSON.parse(card);
        }
        await deliverEphemeralOrReply(current, operatorOpenId, card, 'interactive', () => sessionReply(rootId, card, 'interactive'));
        logger.info(`[${tag(current)}] Closed via card button`);
      }
    }

    if (actionType === 'resume') {
      const targetSessionId = value?.session_id;
      const locDsResume = localeForBot(ds?.larkAppId ?? larkAppId);
      if (!targetSessionId) {
        await sessionReply(rootId, t('card.action.resume_missing_session_id', undefined, locDsResume));
      } else {
        const result = await resumeSession(targetSessionId, activeSessions);
        if (result.ok) {
          const cliName = sessionCliDisplayName(result.ds);
          // Distinguish "route reactivated" from "CLI history restored": when
          // the adapter can only resume a precise cliSessionId and none was
          // persisted, the next spawn starts a FRESH session — say so instead
          // of claiming history is back.
          const resumeMsg = resumeStartsFresh(result.ds.session)
            ? t('card.action.resume_success_fresh', { cliName }, localeForBot(result.ds.larkAppId))
            : t('card.action.resume_success', { cliName }, localeForBot(result.ds.larkAppId));
          // Restore the ORIGINAL live streaming card (🖥️ header + usage line +
          // 显示输出/终端/操作链接/关闭会话) as a WITHDRAW-then-REPOST when live
          // cards are enabled. Card-off bots only withdraw the stale closed card
          // and send the "✅ 会话已恢复…" text follow-up.
          // Ordering is load-bearing for two reasons:
          //   1) ACK the callback FIRST (bare `return` → empty ACK), THEN
          //      post/delete in the background — deleting the just-clicked card
          //      inside the callback response races it and triggers client
          //      "code: 300000".
          //   2) POST the fresh card BEFORE deleting the old one, so the thread
          //      never briefly shows zero cards (same invariant as park→recall).
          // Skip in private-card mode (clicked card may be an ephemeral snapshot).
          const botCfgResume = getBot(result.ds.larkAppId).config;
          const shouldRepostStreamingCard = botCfgResume.disableStreamingCard !== true
            && !botCfgResume.noCardChats?.includes(result.ds.chatId);
          if (cardMessageId && value?.visibility !== 'private' && !botCfgResume.privateCard) {
            const staleCardId = cardMessageId;
            const resumedDs = result.ds;
            const resumedSession = resumedDs.session;
            const resumedAppId = resumedDs.larkAppId;
            const priorCardId = resumedDs.streamCardId;
            const resumePostFence = {
              session: resumedSession,
              larkAppId: resumedAppId,
              anchorId: sessionAnchorId(resumedDs),
              expectedPriorCardId: priorCardId,
            };
            void (async () => {
              try {
                if (shouldRepostStreamingCard) {
                  const freshCardId = await sessionReply(rootId, buildStreamingCardJson(resumedDs), 'interactive');
                  if (!canCommitStreamingCardPublication(resumedDs, resumePostFence)) {
                    void deleteMessage(resumedAppId, freshCardId).catch(() => { /* stale repost */ });
                    return;
                  }
                  resumedDs.streamCardId = freshCardId;
                } else {
                  resumedDs.streamCardId = undefined;
                  resumedDs.streamCardNonce = undefined;
                  resumedDs.streamCardReplyTargetKey = undefined;
                }
                persistStreamCardState(resumedDs);
                if (shouldRepostStreamingCard) {
                  // Pin is a QoL side effect, never a resume-commit barrier. Its
                  // detached chain re-checks ownership and compensates a late
                  // Pin; the committed card may immediately withdraw its sole
                  // predecessor and emit the user receipt.
                  continuePublishedStreamingCardPinChain(resumedDs, resumedDs.streamCardId!, priorCardId ? [priorCardId] : []);
                }
                await deleteMessage(resumedDs.larkAppId, staleCardId).catch(() => { /* already withdrawn/expired */ });
                // Also send the "✅ 会话已恢复…" text follow-up (the original
                // resume behavior) telling the user to send a message to continue.
                await deliverEphemeralOrReply(resumedDs, operatorOpenId, resumeMsg, 'text', () => sessionReply(rootId, resumeMsg));
                logger.info(
                  `[${targetSessionId.substring(0, 8)}] Resumed via card button `
                  + (shouldRepostStreamingCard
                    ? '(withdraw + repost streaming card + text)'
                    : '(withdraw card + text; streaming card disabled)'),
                );
              } catch (err) {
                logger.warn(`[${targetSessionId.substring(0, 8)}] resume card repost failed: ${err instanceof Error ? err.message : String(err)}`);
              }
            })();
            // Bare `return` (→ undefined) so the dispatcher's shaper emits a
            // genuine empty ACK `{}`. Returning `{}` here would instead be
            // truthy and get wrapped as `{card:{type:raw,data:{}}}` — an
            // in-place patch with an empty card body (invalid), racing the
            // background deleteMessage above. Matches every other empty-ACK in
            // this handler.
            return; // fast empty ACK; card work happens in background
          }
          await deliverEphemeralOrReply(result.ds, operatorOpenId, resumeMsg, 'text', () => sessionReply(rootId, resumeMsg));
          logger.info(`[${targetSessionId.substring(0, 8)}] Resumed via card button`);
        } else if (result.error === 'not_found') {
          await sessionReply(rootId, t('card.action.resume_not_found', { short: targetSessionId.substring(0, 8) }, locDsResume));
        } else if (result.error === 'not_closed') {
          await sessionReply(rootId, t('card.action.resume_not_closed', undefined, locDsResume));
        } else if (result.error === 'anchor_occupied') {
          const detail = result.activeSessionId
            ? t('card.action.resume_anchor_holder', { short: result.activeSessionId.substring(0, 8) }, locDsResume)
            : '';
          await sessionReply(rootId, t('card.action.resume_anchor_occupied', { detail }, locDsResume));
        } else if (result.error === 'adopt_unsupported') {
          await sessionReply(rootId, t('card.action.resume_adopt_unsupported', undefined, locDsResume));
        } else if (result.error === 'deferred_unmaterialized') {
          await sessionReply(rootId, t('card.action.resume_deferred_unmaterialized', undefined, locDsResume));
        } else if (result.error === 'resume_cancelled') {
          await sessionReply(rootId, t('card.action.resume_cancelled', undefined, locDsResume));
        }
      }
    }

    if (actionType === 'disconnect' && ds) {
      const targetSessionId = ds.session.sessionId;
      const disconnected = await withBotTurnMutation(ds.larkAppId, async () => {
        const current = [...activeSessions.values()].find(
          candidate => candidate.session.sessionId === targetSessionId,
        );
        if (!current) return 'missing' as const;
        try {
          const result = await closeWorkerPoolSession(targetSessionId);
          if (!result.ok) return 'refused' as const;
          return result.outcome === 'closed' ? 'closed' as const : 'residual' as const;
        } catch {
          return 'refused' as const;
        }
      });
      const locDs = localeForBot(ds.larkAppId);
      if (disconnected === 'missing') {
        return { toast: { type: 'warning', content: t('card.action.session_gone', undefined, localeForBot(larkAppId)) } };
      }
      if (disconnected === 'refused') {
        await sessionReply(rootId, t('cmd.detach.failed', undefined, locDs));
        return;
      }
      if (disconnected === 'residual') {
        await sessionReply(rootId, t('cmd.detach.residual', undefined, locDs));
        return;
      }
      await sessionReply(rootId, t('card.action.disconnected', undefined, locDs));
      logger.info(`[${tag(ds)}] Disconnected (adopt) via card button`);
    }

    if (actionType === 'takeover' && ds && ds.adoptedFrom) {
      await sessionReply(rootId, t('card.action.takeover_retired', undefined, localeForBot(ds.larkAppId)));
      logger.info(`[${tag(ds)}] Legacy takeover action ignored (bridge era; historical card)`);
    }

    if (actionType === 'retry_last_task' && ds) {
      const locDs = localeForBot(ds.larkAppId);
      const cliInput = ds.lastCliInput;
      if (!cliInput) {
        await sessionReply(rootId, t('card.action.retry_last_task_missing', undefined, locDs));
        return;
      }
      if (!ds.usageLimit) {
        await sessionReply(rootId, t('card.action.retry_last_task_unavailable', undefined, locDs));
        return;
      }
      if (!ds.usageLimit.retryReady && ds.usageLimit.retryAtMs > Date.now()) {
        await sessionReply(rootId, t('card.action.retry_last_task_not_ready', { retryLabel: ds.usageLimit.retryLabel }, locDs));
        return;
      }

      const retryCodexAppInput = ds.lastCodexAppInput
        ? (({ clientUserMessageId: _priorMessageId, ...input }) => input)(ds.lastCodexAppInput)
        : undefined;
      const retryInput = {
        content: cliInput,
        ...(retryCodexAppInput ? { codexAppInput: retryCodexAppInput } : {}),
      };
      if ((!ds.worker || ds.worker.killed) && hasProtectedSessionMutationOwnership(ds)) {
        await sessionReply(rootId, t('card.action.retry_last_task_unavailable', undefined, locDs));
        return;
      }
      let accepted = false;
      try {
        if (ds.worker && !ds.worker.killed) accepted = sendWorkerInput(ds, retryInput);
        else {
          forkWorker(ds, retryInput, ds.hasHistory);
          accepted = true;
        }
      } catch (err) {
        logger.warn(
          `[${tag(ds)}] retry_last_task failed before acceptance: `
          + `${err instanceof Error ? err.message : String(err)}`,
        );
      }
      if (!accepted) {
        await sessionReply(rootId, t('card.action.retry_last_task_unavailable', undefined, locDs));
        return;
      }
      // Only now consume the one-shot retry state and advertise working: live
      // IPC or the durable activation tail already owns the exact retry input.
      clearUsageLimitState(ds);
      ds.lastScreenStatus = 'working';
      ds.streamCardPending = true;
      ds.currentTurnTitle = (ds.lastUserPrompt || ds.currentTurnTitle || ds.session.title || getCliDisplayName(sessionCliId(ds))).substring(0, 50);
      ds.currentImageKey = undefined;
      persistStreamCardState(ds);

      let cardJson: string | undefined;
      if (ds.streamCardId && ds.streamCardId !== CARD_POSTING_SENTINEL && workerHasInitialized(ds)) {
        const readUrl = readableTerminalUrlFor(ds);
        cardJson = buildStreamingCard(
          ds.session.sessionId,
          sessionAnchorId(ds),
          readUrl,
          ds.currentTurnTitle,
          '',
          'working',
          sessionCliId(ds),
          ds.displayMode ?? 'hidden',
          ds.streamCardNonce,
          ds.currentImageKey,
          isSharedAdoptSession(ds),
          false,
          locDs,
          undefined,
          writableTerminalLinkFor(ds),
          isLocalCliOpenReady(ds, { cliId: sessionCliId(ds) }),
          getDaemonStreamingCardUsageSnapshot(ds, sessionCliId(ds)),
          sessionRuntimeDisplayName(ds),
          codexServiceTierBadge(sessionCliId(ds), ds.codexServiceTier),
          silentIdleCardFlag(ds),
          dshRuntimeForSession(ds),
        );
        scheduleCardPatch(ds, cardJson);
      }
      logger.info(`[${tag(ds)}] Retrying last task after usage limit`);
      if (cardJson) {
        try { return JSON.parse(cardJson); } catch { /* fall through */ }
      }
      return;
    }

    // 失败卡的重试按钮。刻意不复用上面的 `retry_last_task`：那颗按钮的
    // `ds.usageLimit` 条件同时充当它的一次性安全阀（成功后 clearUsageLimitState
    // 消费掉，所以连点第二次自然失效）。失败场景没有那个状态，于是这里换成两道
    // 独立的门——注意**两道都不是一次性的**，`lastFailedTurn` 只写不删：
    //   - turnId pin：卡上的 turn_id 必须与当前记录的失败轮次逐字相同。它挡的是
    //     **历史卡片**——会话后来又失败过、记录被新的覆盖，旧卡就永久失效；同一
    //     张卡在记录没被覆盖前，pin 一直是满足的。
    //   - 10s cooldown（markRetryAttempt 盖 lastRetryAt）：挡的是**连点**。
    //     冷却过后同一张卡可以再次提交，这是刻意的（与 `/retry` 同款，
    //     failed-turn-retry.test 有用例钉住），因为一次重试也可能再失败。
    // 两道都 fail-closed：宁可让用户多发一条消息，也不重复提交可能带外部副作用
    // 的任务。
    if (actionType === 'retry_turn' && ds) {
      const locDs = localeForBot(ds.larkAppId);
      if (isSessionTransferring(ds)) {
        return {
          toast: {
            type: 'warning',
            content: t('cmd.session.transfer_in_progress', undefined, locDs),
          },
        };
      }
      const failedTurn = ds.session.lastFailedTurn;
      if (!failedTurn) {
        return { toast: { type: 'warning', content: t('card.action.retry_turn_missing', undefined, locDs) } };
      }
      // 轮次校验：卡片只对它自己那一轮有效。会话后来又失败过、记录被新的覆盖，
      // 这张旧卡就永久失效。（「刚点过」不在这里挡，由下面的 cooldown 负责。）
      const clickedTurnId = value?.turn_id;
      if (!clickedTurnId || clickedTurnId !== failedTurn.turnId) {
        logger.info(
          `[${tag(ds)}] retry_turn from stale card (clicked=${clickedTurnId?.slice(0, 8) ?? 'none'} `
          + `current=${failedTurn.turnId.slice(0, 8)}) — refused`,
        );
        return { toast: { type: 'warning', content: t('card.action.retry_turn_stale', undefined, locDs) } };
      }
      const cooldownMs = retryCooldownRemaining(failedTurn);
      if (cooldownMs > 0) {
        return {
          toast: {
            type: 'warning',
            content: t('card.action.retry_turn_cooldown', { seconds: Math.ceil(cooldownMs / 1000) }, locDs),
          },
        };
      }
      if ((!ds.worker || ds.worker.killed) && hasProtectedSessionMutationOwnership(ds)) {
        return { toast: { type: 'warning', content: t('card.action.retry_turn_submit_failed', undefined, locDs) } };
      }
      // Strip clientUserMessageId to avoid dedup conflicts (same as /retry).
      const retryCodexAppInput = failedTurn.codexAppInput
        ? (({ clientUserMessageId: _prior, ...input }) => input)(failedTurn.codexAppInput)
        : undefined;
      // 提交什么由卡上的 mode 决定，而 mode 由渲染时的 retryOffer 决定，所以
      // 「卡上写的语义」与「实际发生的事」永远一致：
      //   resend   —— 输入证明没送达 CLI，零副作用，重发原话最干净可靠；
      //   continue —— 可能已执行一部分，原样重发会重复副作用，改发续跑指令
      //               （读现场 → 从 checkpoint 接着做 → 判断不了就交回人工）。
      // 旧卡片没有 mode 字段：按 continue 处理（fail-safe —— 宁可让模型先看
      // 现场，也不要在可能已执行过的轮次上闷头重发一遍）。
      const continueMode = value?.mode !== 'resend';
      // 续跑不带原任务文本：这个 fork 走 resume（下面 ds.hasHistory），CLI 自己
      // 就能读到原任务和它已经做过的事，重复一遍纯属浪费 token。
      const submittedContent = continueMode
        ? buildTurnContinuePrompt()
        : failedTurn.cliInput;
      const retryInput = {
        content: submittedContent,
        // codexAppInput 描述的是「原样重发那条结构化输入」。续跑发的是一条新指令，
        // 带上旧 sidecar 会让 CLI 收到与正文不符的结构化载荷。
        ...(!continueMode && retryCodexAppInput ? { codexAppInput: retryCodexAppInput } : {}),
      };
      let accepted = false;
      try {
        if (ds.worker && !ds.worker.killed) accepted = sendWorkerInput(ds, retryInput);
        else {
          forkWorker(ds, retryInput, ds.hasHistory);
          accepted = true;
        }
      } catch (err) {
        logger.warn(
          `[${tag(ds)}] retry_turn failed before acceptance: `
          + `${err instanceof Error ? err.message : String(err)}`,
        );
      }
      if (!accepted) {
        return { toast: { type: 'warning', content: t('card.action.retry_turn_submit_failed', undefined, locDs) } };
      }
      // Start the cooldown only after acceptance: a rejected click must not
      // burn it (same post-acceptance ordering as /retry and retry_last_task).
      markRetryAttempt(ds.session);
      rememberLastCliInput(ds, failedTurn.userPrompt, retryInput);
      sessionStore.updateSession(ds.session);
      ds.lastScreenStatus = 'working';
      ds.streamCardPending = true;
      ds.currentTurnTitle = (failedTurn.userPrompt || ds.currentTurnTitle || ds.session.title
        || getCliDisplayName(sessionCliId(ds))).substring(0, 50);
      ds.currentImageKey = undefined;
      persistStreamCardState(ds);
      logger.info(
        `[${tag(ds)}] retry_turn re-injected turn ${failedTurn.turnId.slice(0, 8)} `
        + `mode=${continueMode ? 'continue' : 'resend'} `
        + `(attempt #${ds.session.lastFailedTurn?.retryCount ?? 1})`,
      );
      return {
        toast: {
          type: 'success',
          content: t(
            continueMode ? 'card.action.continue_turn_success' : 'card.action.retry_turn_success',
            undefined,
            locDs,
          ),
        },
      };
    }

    if (actionType === 'tui_keys' && ds) {
      if (isSessionTransferring(ds)) {
        return {
          toast: {
            type: 'warning',
            content: t('cmd.session.transfer_in_progress', undefined, localeForBot(ds.larkAppId)),
          },
        };
      }
      // Fail-closed: only act on a currently-active card (either the
      // ScreenAnalyzer TUI prompt card or our stuck-warning card). A stale
      // click from a resolved/replaced card must NOT send any IPC to the
      // worker — the CLI may have moved on or recovered. PATCH is UI only,
      // not an authorization check.
      const isActiveTuiCard = !!ds.tuiPromptCardId && cardMessageId === ds.tuiPromptCardId;
      const isActiveStuckCard = !!ds.stuckWarningCardId && cardMessageId === ds.stuckWarningCardId;
      if (!isActiveTuiCard && !isActiveStuckCard) {
        logger.info(`[${tag(ds)}] tui_keys from stale card ${cardMessageId} — ignored (active tui=${ds.tuiPromptCardId ?? 'none'} stuck=${ds.stuckWarningCardId ?? 'none'})`);
        return;
      }
      let keys: string[] = [];
      try { keys = JSON.parse(value?.keys ?? '[]'); } catch { /* bad json */ }
      const isFinal = value?.is_final === '1';
      const optionType = value?.option_type ?? 'select';
      const selectedIndex = Number(value?.selected_index ?? 0);
      const selectedText = value?.selected_text ?? `Option ${selectedIndex + 1}`;
      if (isActiveTuiCard && ds.tuiPromptProcessing) {
        logger.info(`[${tag(ds)}] Duplicate TUI prompt card click — dropped (processing already in flight)`);
        return;
      }

      if (optionType === 'toggle') {
        // Only a ScreenAnalyzer TUI card may own toggle state. A stuck-warning
        // card must never read or mutate the other card's global selections.
        if (!isActiveTuiCard) {
          logger.info(`[${tag(ds)}] Ignored toggle from non-TUI card ${cardMessageId}`);
          return;
        }
        // Toggle: only update card UI, do NOT send keys to terminal yet.
        // Keys will be sent in batch when confirm is clicked.
        if (!ds.tuiToggledIndices) ds.tuiToggledIndices = [];
        const idx = ds.tuiToggledIndices.indexOf(selectedIndex);
        if (idx >= 0) ds.tuiToggledIndices.splice(idx, 1);
        else ds.tuiToggledIndices.push(selectedIndex);
        logger.info(`[${tag(ds)}] TUI toggle (card only): option ${selectedIndex}, toggled: [${ds.tuiToggledIndices}]`);
        // PATCH card to update ☐/☑ state
        if (cardMessageId && ds.tuiPromptOptions) {
          const locDs = localeForBot(ds.larkAppId);
          const updatedCard = buildTuiPromptCard(
            sessionAnchorId(ds),
            ds.session.sessionId,
            ds.currentTurnTitle || t('card.action.tui_select_title', undefined, locDs),
            ds.tuiPromptOptions,
            true,
            ds.tuiToggledIndices,
            locDs,
          );
          updateMessage(ds.larkAppId, cardMessageId, updatedCard).catch(err =>
            logger.debug(`[${tag(ds)}] Failed to update TUI toggle card: ${err}`),
          );
          try { return JSON.parse(updatedCard); } catch { /* fall through */ }
        }
        return;
      }

      // For a normal TUI confirm: batch all toggled options' keys first.
      // For a stuck-warning card: derive the single allowed key from the
      // page type + selected index — NEVER trust value.keys from the card,
      // which could be tampered to inject arbitrary keys. The allowlist is
      // exactly the documented controls for each Codex hook-review screen.
      if (ds.worker) {
        let allKeys: string[] = [];
        let isFinalStuck = false;
        let dispatchedKeys = false;
        if (isActiveTuiCard && ds.tuiToggledIndices?.length && ds.tuiPromptOptions) {
          // Send each toggled option's keys in sequence
          for (const ti of ds.tuiToggledIndices.sort((a, b) => a - b)) {
            const opt = ds.tuiPromptOptions[ti];
            if (opt?.keys?.length) {
              allKeys.push(...opt.keys);
            }
          }
          // Then the action's own keys (confirm/select)
          allKeys.push(...keys);
        } else if (isActiveStuckCard) {
          // P1-4: do NOT trust the callback's selected_index. Require it to be
          // present and a safe integer, then range-check against the page type's
          // option count. A missing/malformed index must NOT default to 0 (trust),
          // which is the highest-risk action.
          const rawIdx = value?.selected_index;
          if (rawIdx === undefined || rawIdx === null || rawIdx === '') {
            logger.info(`[${tag(ds)}] Stuck-warning card click missing selected_index — dropped`);
            return;
          }
          const idx = Number(rawIdx);
          if (!Number.isSafeInteger(idx)) {
            logger.info(`[${tag(ds)}] Stuck-warning card click with non-integer selected_index=${rawIdx} — dropped`);
            return;
          }
          // Allowlist: map (pageType, idx) → the one safe key.
          // Level 1: 0=t, 1=Enter, 2=Esc ; Level 2: 0=t, 1=Esc
          const pt = ds.stuckWarningPageType;
          const allowlist = pt === 'hook review level 1'
            ? ['t', 'Enter', 'Escape']
            : pt === 'hook review level 2'
              ? ['t', 'Escape']
              : null;
          if (!allowlist || idx < 0 || idx >= allowlist.length) {
            logger.info(`[${tag(ds)}] Stuck-warning card click with out-of-range index ${idx} for pageType=${pt ?? 'none'} — dropped`);
            return;
          }
          allKeys = [allowlist[idx]];
          // Stuck-card actions are always final (they resolve the current
          // hook-review screen). Define this server-side — do NOT trust
          // value.is_final from the callback.
          isFinalStuck = true;
        } else {
          // Non-stuck, non-TUI card (shouldn't happen given the active-card
          // guard above, but fail-closed).
          allKeys.push(...keys);
        }

        if (allKeys.length > 0) {
          const effectiveFinal = isFinal || isFinalStuck;
          // Atomic processing claim: if a previous click is already in flight
          // (waiting for tui_keys_delivered / stuck_warning_expired ACK), drop
          // this duplicate. Without this, two rapid clicks could both pass the
          // fresh-capture guard and inject keys twice.
          if (isActiveStuckCard) {
            if (ds.stuckWarningProcessing) {
              logger.info(`[${tag(ds)}] Duplicate stuck-warning card click — dropped (processing already in flight)`);
              return;
            }
            ds.stuckWarningProcessing = true;
          }
          if (isActiveTuiCard && effectiveFinal) {
            ds.tuiPromptProcessing = true;
          }
          // Only the stuck-warning card's Enter action re-arms the detector
          // (Enter advances from the hook list to a per-hook review). Match by
          // the actual keys sent — NOT by optionType, since t is typed 'confirm'
          // in the card definition. t/Esc and all ScreenAnalyzer cards never
          // set this flag. Also require the source card to be our own.
          const isStuckWarningEnter = isActiveStuckCard
            && allKeys.length === 1
            && allKeys[0] === 'Enter';
          // If this click is from a stuck-warning card, forward the nonce,
          // cliLifetime, and page type so the worker can re-verify the current
          // screen still matches before injecting keys. A stale click (CLI
          // recovered) will be dropped at the worker boundary.
          const stuckNonce = isActiveStuckCard ? ds.stuckWarningNonce : undefined;
          const stuckCliLifetime = isActiveStuckCard ? ds.stuckWarningCliLifetime : undefined;
          const stuckPage = isActiveStuckCard ? ds.stuckWarningPageType : undefined;
          const resolveText = isActiveTuiCard && ds.tuiToggledIndices?.length
            ? ds.tuiToggledIndices.map(i => ds.tuiPromptOptions?.[i]?.text).filter(Boolean).join(', ')
            : selectedText;
          try {
            await sendWorkerIpc(ds.worker, {
              type: 'tui_keys',
              keys: allKeys,
              isFinal: effectiveFinal,
              rearmStuckDetector: isStuckWarningEnter,
              stuckNonce,
              stuckCliLifetime,
              stuckPageType: stuckPage,
              cardMessageId: isActiveTuiCard ? cardMessageId : undefined,
              selectedText: resolveText || selectedText,
            } as DaemonToWorker);
            dispatchedKeys = true;
          } catch (err) {
            if (isActiveStuckCard) ds.stuckWarningProcessing = false;
            if (isActiveTuiCard && effectiveFinal) ds.tuiPromptProcessing = false;
            logger.warn(`[${tag(ds)}] TUI key IPC delivery failed: ${err instanceof Error ? err.message : String(err)}`);
            return {
              toast: {
                type: 'warning',
                content: t('card.action.tui_ipc_failed', undefined, localeForBot(ds.larkAppId)),
              },
            };
          }
          logger.info(`[${tag(ds)}] TUI keys: [${allKeys.join(',')}] final=${effectiveFinal} rearmStuck=${isStuckWarningEnter} stuckNonce=${stuckNonce ?? 'none'} — "${selectedText}"`);
        }

        if ((isFinal || isFinalStuck) && dispatchedKeys) {
          const resolveText = isActiveTuiCard && ds.tuiToggledIndices?.length
            ? ds.tuiToggledIndices.map(i => ds.tuiPromptOptions?.[i]?.text).filter(Boolean).join(', ')
            : selectedText;
          const finalText = resolveText || selectedText;
          const locDs = localeForBot(ds.larkAppId);
          // For a stuck-warning card, do NOT clear authority or render success
          // here. The worker may still reject the keys (stale screen). We show a
          // "processing" state to block duplicate clicks, and wait for the
          // worker's tui_keys_delivered (success), stuck_warning_expired
          // ("page changed, not sent"), or tui_prompt_submit_failed ACK before
          // resolving the card.
          if (isActiveStuckCard) {
            if (cardMessageId) {
              const processingCard = buildTuiPromptProcessingCard('处理中…', locDs);
              updateMessage(ds.larkAppId, cardMessageId, processingCard).catch(err =>
                logger.debug(`[${tag(ds)}] Failed to set stuck-warning card to processing: ${err}`),
              );
            }
            publishAttentionPatch(ds);
            try { return JSON.parse(buildTuiPromptProcessingCard('处理中…', locDs)); } catch { /* fall through */ }
          }
          // Normal TUI prompt cards also remain in processing until the worker
          // confirms backend delivery via tui_prompt_resolved. A worker/backend
          // rejection produces tui_prompt_submit_failed instead.
          publishAttentionPatch(ds);
          try { return JSON.parse(buildTuiPromptProcessingCard(finalText, locDs)); } catch { /* fall through */ }
        }
      }
    }

    if (actionType === 'tui_text_input' && ds) {
      if (isSessionTransferring(ds)) {
        return {
          toast: {
            type: 'warning',
            content: t('cmd.session.transfer_in_progress', undefined, localeForBot(ds.larkAppId)),
          },
        };
      }
      const inputTextRaw = action?.form_value?.tui_custom_input;
      const inputText = typeof inputTextRaw === 'string' ? inputTextRaw : '';
      let inputKeys: string[] = [];
      try { inputKeys = JSON.parse(value?.input_keys ?? '[]'); } catch { /* bad json */ }
      const locDs = localeForBot(ds.larkAppId);
      const isActiveTuiCard = !!ds.tuiPromptCardId && cardMessageId === ds.tuiPromptCardId;
      if (!isActiveTuiCard) {
        logger.info(`[${tag(ds)}] tui_text_input from stale card ${cardMessageId} — ignored`);
        return;
      }
      if (ds.tuiPromptProcessing) {
        logger.info(`[${tag(ds)}] Duplicate TUI text input — dropped (processing already in flight)`);
        return;
      }
      if (!ds.worker || !inputText || inputKeys.length === 0) {
        logger.info(
          `[${tag(ds)}] TUI text input not dispatched ` +
          `(worker=${!!ds.worker}, text=${!!inputText}, keys=${inputKeys.length})`,
        );
        return {
          toast: {
            type: 'warning',
            content: t('card.action.tui_ipc_failed', undefined, locDs),
          },
        };
      }
      // Atomic IPC — worker handles keys + text in one flow to avoid race
      ds.tuiPromptProcessing = true;
      try {
        await sendWorkerIpc(ds.worker, {
          type: 'tui_text_input',
          keys: inputKeys,
          text: inputText,
          cardMessageId,
        } as DaemonToWorker);
      } catch (err) {
        ds.tuiPromptProcessing = false;
        logger.warn(`[${tag(ds)}] TUI text IPC delivery failed: ${err instanceof Error ? err.message : String(err)}`);
        return {
          toast: {
            type: 'warning',
            content: t('card.action.tui_ipc_failed', undefined, locDs),
          },
        };
      }
      logger.info(`[${tag(ds)}] TUI text input: "${inputText}" (keys: ${JSON.stringify(inputKeys)})`);
      publishAttentionPatch(ds);
      try { return JSON.parse(buildTuiPromptProcessingCard(inputText, locDs)); } catch { /* fall through */ }
    }

    // Compatibility path for cards emitted before open_local_cli was introduced.
    // The opt-in/capability guard still applies so old cards cannot bypass the
    // default-off continuity protection. Clicks read the current mode: attach
    // mode uses exact backend attach with no fallback; resume mode uses the same
    // precise resume preflight and also fails closed when unsupported.
    if (actionType === 'open_local_terminal') {
      const locDs = localeForBot(ds?.larkAppId ?? larkAppId);
      if (!ds) {
        return { toast: { type: 'warning', content: t('card.action.session_gone', undefined, locDs) } };
      }
      const blocked = guardLocalCliOpen(ds, locDs);
      if (blocked) return blocked;
      return launchLocalCli(ds, locDs);
    }

    if (actionType === 'get_write_link' && ds && operatorOpenId) {
      const effectiveCliId = sessionCliId(ds);
      const locDs = localeForBot(ds.larkAppId);
      if (!sessionSupportsWebTerminal(ds)) {
        // Old cards can retain a get_write_link callback and stale port/token
        // fields after the session is restored onto ZMX. This is a permanent
        // backend capability boundary, not a transient startup delay.
        const unsupportedCard = JSON.stringify({
          config: { wide_screen_mode: true },
          elements: [{ tag: 'markdown', content: t('card.action.terminal_unsupported', undefined, locDs) }],
        });
        await deliverEphemeralOrReply(ds, operatorOpenId, unsupportedCard, 'interactive', () => sessionReply(rootId, unsupportedCard, 'interactive'));
        return;
      }
      if (sessionSupportsWebTerminal(ds) && (ds.riffAccessUrl || (ds.workerPort && ds.workerToken))) {
        const writeUrl = buildTerminalUrl(ds, { write: true });
        const cardJson = buildSessionCard(
          ds.session.sessionId,
          sessionAnchorId(ds),
          writeUrl,
          ds.session.title || getCliDisplayName(effectiveCliId),
          effectiveCliId,
          true, // showManageButtons — write-link card includes restart & close
          isSharedAdoptSession(ds), // shared adopt — disconnect, never close the source conversation
          locDs,
          isLocalCliOpenReady(ds, { cliId: effectiveCliId }),
          sessionRuntimeDisplayName(ds),
        );
        // 普通群发「仅自己可见」私密卡，话题群 / 单聊自动回退私聊 DM（两条通道都私密，
        // 不泄露写入 token）。fire-and-forget，保持卡片回调快速返回。
        void deliverWriteLinkCard(ds, operatorOpenId, cardJson);
        // 乐观回执：投递是异步的（话题群要先 ephemeral 失败再 DM，两次往返 await 容易
        // 超过 2500ms 的 ACK 窗口而被丢弃），点完立即弹 toast，让用户知道链接已私密发出。
        return { toast: { type: 'success', content: t('card.action.write_link_sent', undefined, locDs) } };
      } else {
        // 普通群发「仅自己可见」私密卡；话题群 / 单聊不支持 ephemeral，回退为同样内容的
        // 卡片回复（而非纯文本），三种场景都渲染成卡片，行为不变。
        const notReadyCard = JSON.stringify({
          config: { wide_screen_mode: true },
          elements: [{ tag: 'markdown', content: t('card.action.terminal_not_ready', undefined, locDs) }],
        });
        await deliverEphemeralOrReply(ds, operatorOpenId, notReadyCard, 'interactive', () => sessionReply(rootId, notReadyCard, 'interactive'));
      }
    }

    // Display toggle: hidden ↔ screenshot. 'toggle_stream' is the legacy alias
    // from pre-screenshot cards and is mapped to toggle_display semantics.
    if (actionType === 'toggle_display' || actionType === 'toggle_stream') {
      if (!ds) {
        // 同 close：会话已不在线时「显示 / 隐藏输出」静默无反应 → 给失败 toast（成功不弹）。
        return { toast: { type: 'warning', content: t('card.action.session_gone', undefined, localeForBot(larkAppId)) } };
      }
      const clickedNonce: string | undefined = value?.card_nonce;
      const isFrozenClick = clickedNonce && ds.streamCardNonce && clickedNonce !== ds.streamCardNonce;

      const nextMode = (current: DisplayMode): DisplayMode =>
        current === 'hidden' ? 'screenshot' : 'hidden';

      if (isFrozenClick) {
        // Historical card — toggle using cached state
        if (!ds.frozenCards) ds.frozenCards = loadFrozenCards(ds.session.sessionId);
        const frozen = ds.frozenCards.get(clickedNonce!);
        if (!frozen) {
          // The clicked card can predate the frozen-card cache for the current
          // active session (e.g. a stale Worker card whose session_id/card_nonce
          // came from a now-closed session). Migrate the visible card to the
          // current root session/CLI instead of leaving stale terminal URL/chrome.
          const effectiveCliId = sessionCliId(ds);
          const cur: DisplayMode = ds.displayMode ?? 'hidden';
          const next = nextMode(cur);
          ds.displayMode = next;
          persistStreamCardState(ds);
          if (ds.worker || isSessionTransferring(ds)) {
            sendWorkerSessionInput(ds, { type: 'set_display_mode', mode: next });
          }
          if (cardMessageId && workerHasInitialized(ds)) {
            const readUrl = readableTerminalUrlFor(ds);
            const turnTitle = ds.currentTurnTitle || ds.session.title || getCliDisplayName(effectiveCliId);
            const cardJson = buildStreamingCard(
              ds.session.sessionId,
              sessionAnchorId(ds),
              readUrl,
              turnTitle,
              ds.lastScreenContent || '',
              ds.lastScreenStatus || 'working',
              effectiveCliId,
              next,
              ds.streamCardNonce,
              ds.currentImageKey,
              isSharedAdoptSession(ds),
              false,
              localeForBot(ds.larkAppId),
              cardUsageLimit(ds),
              writableTerminalLinkFor(ds),
              isLocalCliOpenReady(ds, { cliId: effectiveCliId }),
              getDaemonStreamingCardUsageSnapshot(ds, effectiveCliId),
              sessionRuntimeDisplayName(ds),
              codexServiceTierBadge(effectiveCliId, ds.codexServiceTier),
              silentIdleCardFlag(ds),
              dshRuntimeForSession(ds),
            );
            updateMessage(ds.larkAppId, cardMessageId, cardJson).catch(err =>
              logger.debug(`[${tag(ds)}] Failed to migrate unknown frozen card: ${err}`),
            );
            logger.info(`[${tag(ds)}] Migrated unknown frozen card to ${next} (legacy nonce=${clickedNonce})`);
            try { return JSON.parse(cardJson); } catch { /* fall through */ }
          }
          logger.debug(`[${tag(ds)}] Toggle on unknown frozen card could not migrate: nonce=${clickedNonce}`);
          return;
        }
        // Self-heal known historical cards by migrating the clicked card to the
        // current live session/CLI instead of rebuilding from cached frozen
        // title/content/imageKey. The cache may have been persisted while this
        // thread was bound to a different CLI (or before cli_id existed), and
        // reusing its imageKey is exactly what makes a second click snap back to
        // an old Claude Code screenshot.
        const cur: DisplayMode = ds.displayMode ?? frozenDisplayMode(frozen);
        const next = nextMode(cur);
        ds.displayMode = next;
        persistStreamCardState(ds);
        if (ds.worker || isSessionTransferring(ds)) {
          sendWorkerSessionInput(ds, { type: 'set_display_mode', mode: next });
        }
        const effectiveCliId = sessionCliId(ds);
        const readUrl = readableTerminalUrlFor(ds);
        const turnTitle = ds.currentTurnTitle || ds.session.title || getCliDisplayName(effectiveCliId);
        const cardJson = buildStreamingCard(
          ds.session.sessionId,
          sessionAnchorId(ds),
          readUrl,
          turnTitle,
          ds.lastScreenContent || '',
          ds.lastScreenStatus || 'working',
          effectiveCliId,
          next,
          ds.streamCardNonce,
          ds.currentImageKey,
          isSharedAdoptSession(ds),
          false,
          localeForBot(ds.larkAppId),
          cardUsageLimit(ds),
          writableTerminalLinkFor(ds),
          isLocalCliOpenReady(ds, { cliId: effectiveCliId }),
          getDaemonStreamingCardUsageSnapshot(ds, effectiveCliId),
          sessionRuntimeDisplayName(ds),
          effectiveCliId === 'codex' ? frozen.codexServiceTierBadge : undefined,
          frozen.silentIdle === true,
          dshRuntimeForSession(ds),
        );
        updateMessage(ds.larkAppId, frozen.messageId, cardJson).catch(err =>
          logger.debug(`[${tag(ds)}] Failed to migrate frozen card: ${err}`),
        );
        ds.frozenCards.delete(clickedNonce!);
        saveFrozenCards(ds.session.sessionId, ds.frozenCards);
        logger.info(`[${tag(ds)}] Migrated frozen card to current ${next} (legacy nonce=${clickedNonce})`);
        try { return JSON.parse(cardJson); } catch { /* fall through */ }
        return;
      }

      // Current (latest) card — change displayMode + tell worker
      const botCfg = getBot(ds.larkAppId).config;
      const effectiveCliId = sessionCliId(ds);
      const cur: DisplayMode = ds.displayMode ?? 'hidden';
      const next = nextMode(cur);
      ds.displayMode = next;
      persistStreamCardState(ds);
      if (ds.worker || isSessionTransferring(ds)) {
        sendWorkerSessionInput(ds, { type: 'set_display_mode', mode: next });
      }
      if (ds.streamCardId && workerHasInitialized(ds)) {
        const readUrl = readableTerminalUrlFor(ds);
        const turnTitle = ds.currentTurnTitle || ds.session.title || getCliDisplayName(effectiveCliId);
        const cardJson = buildStreamingCard(
          ds.session.sessionId,
          sessionAnchorId(ds),
          readUrl,
          turnTitle,
          ds.lastScreenContent || '',
          ds.lastScreenStatus || 'working',
          effectiveCliId,
          next,
          ds.streamCardNonce,
          ds.currentImageKey,
          isSharedAdoptSession(ds),
          false,
          localeForBot(ds.larkAppId),
          cardUsageLimit(ds),
          writableTerminalLinkFor(ds),
          isLocalCliOpenReady(ds, { cliId: effectiveCliId }),
          getDaemonStreamingCardUsageSnapshot(ds, effectiveCliId),
          sessionRuntimeDisplayName(ds),
          codexServiceTierBadge(effectiveCliId, ds.codexServiceTier),
          silentIdleCardFlag(ds),
          dshRuntimeForSession(ds),
        );
        if (cardMessageId && cardMessageId !== ds.streamCardId) {
          updateMessage(ds.larkAppId, cardMessageId, cardJson).catch(err =>
            logger.debug(`[${tag(ds)}] Failed to migrate clicked legacy card: ${err}`),
          );
        } else {
          scheduleCardPatch(ds, cardJson);
        }
        logger.info(`[${tag(ds)}] Display mode → ${next}`);
        try { return JSON.parse(cardJson); } catch { /* fall through */ }
      }
      logger.info(`[${tag(ds)}] Display mode → ${next}`);
      return;
    }

    // Export current terminal text as a thread reply. One-shot action — the
    // card body itself stays in screenshot mode. For frozen cards, export
    // from the cached frozen content; for the live card, use ds.lastScreenContent.
    if (actionType === 'export_text' && ds) {
      const clickedNonce: string | undefined = value?.card_nonce;
      const isFrozenClick = clickedNonce && ds.streamCardNonce && clickedNonce !== ds.streamCardNonce;
      let content = '';
      if (isFrozenClick) {
        if (!ds.frozenCards) ds.frozenCards = loadFrozenCards(ds.session.sessionId);
        content = ds.frozenCards.get(clickedNonce!)?.content ?? '';
      } else {
        content = ds.lastScreenContent ?? '';
      }
      const locDs = localeForBot(ds.larkAppId);
      const body = content.trim() ? truncateContent(content, locDs) : t('card.action.no_output', undefined, locDs);
      await sessionReply(sessionAnchorId(ds), body);
      logger.info(`[${tag(ds)}] Exported terminal text (${body.length} chars)`);
      return;
    }

    // Manual screenshot refresh — force immediate capture bypassing 10s interval + hash dedup.
    if (actionType === 'refresh_screenshot' && ds) {
      if (ds.worker || isSessionTransferring(ds)) {
        sendWorkerSessionInput(ds, { type: 'refresh_screen' });
        logger.info(`[${tag(ds)}] Manual screenshot refresh`);
      }
      // Return the current card JSON so Feishu doesn't revert the displayed
      // image to the originally-POSTed initial frame while waiting for the
      // fresh screenshot PATCH (~1s).
      if (ds.streamCardId && ds.streamCardId !== CARD_POSTING_SENTINEL && workerHasInitialized(ds)) {
        const botCfg = getBot(ds.larkAppId).config;
        const effectiveCliId = sessionCliId(ds);
        const readUrl = readableTerminalUrlFor(ds);
        const turnTitle = ds.currentTurnTitle || ds.session.title || getCliDisplayName(effectiveCliId);
        const cardJson = buildStreamingCard(
          ds.session.sessionId,
          sessionAnchorId(ds),
          readUrl,
          turnTitle,
          ds.lastScreenContent || '',
          ds.lastScreenStatus || 'working',
          effectiveCliId,
          ds.displayMode ?? 'screenshot',
          ds.streamCardNonce,
          ds.currentImageKey,
          isSharedAdoptSession(ds),
          false,
          localeForBot(ds.larkAppId),
          cardUsageLimit(ds),
          writableTerminalLinkFor(ds),
          isLocalCliOpenReady(ds, { cliId: effectiveCliId }),
          getDaemonStreamingCardUsageSnapshot(ds, effectiveCliId),
          sessionRuntimeDisplayName(ds),
          codexServiceTierBadge(effectiveCliId, ds.codexServiceTier),
          silentIdleCardFlag(ds),
          dshRuntimeForSession(ds),
        );
        if (cardMessageId && cardMessageId !== ds.streamCardId) {
          updateMessage(ds.larkAppId, cardMessageId, cardJson).catch(err =>
            logger.debug(`[${tag(ds)}] Failed to migrate clicked legacy card: ${err}`),
          );
        }
        try { return JSON.parse(cardJson); } catch { /* fall through */ }
      }
      return;
    }

    // 「⏹ 停止」：中断当前 turn 但保留会话（不是 /close——turn 跑飞时折叠态用户此前
    // 唯一手段是杀整个会话丢上下文）。走已有的 term_action ctrlc IPC 链路
    // （sendWorkerSessionInput → worker.handleTermAction → sendCriticalControlKey
    // 带重试注入 ^C），与展开态 ^C 快捷键完全同款。中断后把卡片重渲染为 transient
    // 'interrupted' 状态（橙色 header + 已中断文案），~2s 后被下一次 screen_update
    // patch 覆盖为真实 idle 态。
    if (actionType === 'stop_turn') {
      const locDs = localeForBot(ds?.larkAppId ?? larkAppId);
      if (!ds) {
        return { toast: { type: 'warning', content: t('card.action.session_gone', undefined, locDs) } };
      }
      if (isSessionTransferring(ds)) {
        return { toast: { type: 'warning', content: t('cmd.session.transfer_in_progress', undefined, locDs) } };
      }
      // RPC 输入模式下 ^C 到不了 app-server（pane 只是 viewer）；codex-app（App Runner）
      // 无 PTY 输入通道。两者都降级为明确拒绝，提示用 /close。
      if (ds.initConfig?.codexRpcInput === true || sessionCliId(ds) === 'codex-app') {
        return { toast: { type: 'warning', content: t('card.action.stop_unsupported', undefined, locDs) } };
      }
      if (!ds.worker || ds.worker.killed) {
        return { toast: { type: 'warning', content: t('card.action.stop_no_worker', undefined, locDs) } };
      }
      sendWorkerSessionInput(ds, { type: 'term_action', key: 'ctrlc' });
      logger.info(`[${tag(ds)}] stop_turn: ^C sent (session kept alive)`);
      // 重渲染为 'interrupted' transient 状态——与 term_action 重渲染完全同款模式，
      // 唯一差异是 status 参数传 'interrupted' 而非 ds.lastScreenStatus。
      if (ds.streamCardId && ds.streamCardId !== CARD_POSTING_SENTINEL && workerHasInitialized(ds)) {
        const effectiveCliId = sessionCliId(ds);
        const readUrl = readableTerminalUrlFor(ds);
        const turnTitle = ds.currentTurnTitle || ds.session.title || getCliDisplayName(effectiveCliId);
        const cardJson = buildStreamingCard(
          ds.session.sessionId,
          sessionAnchorId(ds),
          readUrl,
          turnTitle,
          ds.lastScreenContent || '',
          'interrupted',
          effectiveCliId,
          ds.displayMode ?? 'screenshot',
          ds.streamCardNonce,
          ds.currentImageKey,
          !!ds.adoptedFrom,
          false,
          localeForBot(ds.larkAppId),
          cardUsageLimit(ds),
          writableTerminalLinkFor(ds),
          isLocalCliOpenReady(ds, { cliId: effectiveCliId }),
          getDaemonStreamingCardUsageSnapshot(ds, effectiveCliId),
          sessionRuntimeDisplayName(ds),
          codexServiceTierBadge(effectiveCliId, ds.codexServiceTier),
          silentIdleCardFlag(ds),
          dshRuntimeForSession(ds),
        );
        return {
          toast: { type: 'success', content: t('card.action.stop_sent', { cliName: sessionCliDisplayName(ds) }, locDs) },
          card: { type: 'raw' as const, data: JSON.parse(cardJson) },
        };
      }
      return { toast: { type: 'success', content: t('card.action.stop_sent', { cliName: sessionCliDisplayName(ds) }, locDs) } };
    }

    // 「🗜️ 压缩」：等价于用户在话题里发 /compact——通过 deps.deliverPassthroughCommand
    // 复用 daemon 的 deliverPassthroughToExistingSession（raw_input 透传，含完整 turn
    // 绑定/卡片冻结/turn-starting 逻辑），不新造压缩逻辑。daemon 未接线时走 unsupported
    // toast 兜底。与 daemon passthrough 路径一致，不用 withBotTurnMutation
    // （deliverPassthroughToExistingSession 内部自己管 turn 绑定）。
    if (actionType === 'compact_session') {
      const locDs = localeForBot(ds?.larkAppId ?? larkAppId);
      if (!ds) {
        return { toast: { type: 'warning', content: t('card.action.session_gone', undefined, locDs) } };
      }
      if (isSessionTransferring(ds)) {
        return { toast: { type: 'warning', content: t('cmd.session.transfer_in_progress', undefined, locDs) } };
      }
      if (!ds.worker || ds.worker.killed) {
        return { toast: { type: 'warning', content: t('card.action.compact_no_worker', undefined, locDs) } };
      }
      // Defense-in-depth: the router already refuses raw passthrough for CLIs with
      // no raw input surface (resolvePassthroughCommands returns an empty set), but
      // this button path previously had NO cliId gate at all — which is exactly how a
      // builder-side gate that hand-wrote a single cliId let mira/mir/dsh/ebsd grow a
      // button whose /compact gets dropped as non-frame input or, worse, delivered to
      // the model as an ordinary user message. Refuse here too, so the button path can
      // never reopen a channel the router deliberately closed.
      if (cliHasNoRawPassthroughSurface(sessionCliId(ds), { dshRuntime: getBot(ds.larkAppId).config.dshRuntime })) {
        return { toast: { type: 'warning', content: t('card.action.compact_unsupported', undefined, locDs) } };
      }
      if (!deps.deliverPassthroughCommand) {
        return { toast: { type: 'warning', content: t('card.action.compact_unsupported', undefined, locDs) } };
      }
      deps.deliverPassthroughCommand(ds, '/compact', {
        anchor: sessionAnchorId(ds),
        senderOpenId: operatorOpenId,
        senderIsBot: false,
        messageId: cardMessageId ?? `compact-${Date.now()}`,
        replyRootId: rootId,
      });
      logger.info(`[${tag(ds)}] compact_session: /compact passthrough sent`);
      return { toast: { type: 'success', content: t('card.action.compact_sent', { cliName: sessionCliDisplayName(ds) }, locDs) } };
    }

    // Quick-action keys (Esc, ^C, Tab, Space, Enter, ←↑↓→, ½ page) — forward to worker.
    if (actionType === 'term_action' && ds) {
      if (isSessionTransferring(ds)) {
        return {
          toast: {
            type: 'warning',
            content: t('cmd.session.transfer_in_progress', undefined, localeForBot(ds.larkAppId)),
          },
        };
      }
      const key = value?.key as TermActionKey | undefined;
      if (!key) return;
      if (ds.worker) {
        sendWorkerSessionInput(ds, { type: 'term_action', key });
        logger.info(`[${tag(ds)}] term_action: ${key}`);
      }
      if (ds.streamCardId && ds.streamCardId !== CARD_POSTING_SENTINEL && workerHasInitialized(ds)) {
        const botCfg = getBot(ds.larkAppId).config;
        const effectiveCliId = sessionCliId(ds);
        const readUrl = readableTerminalUrlFor(ds);
        const turnTitle = ds.currentTurnTitle || ds.session.title || getCliDisplayName(effectiveCliId);
        const cardJson = buildStreamingCard(
          ds.session.sessionId,
          sessionAnchorId(ds),
          readUrl,
          turnTitle,
          ds.lastScreenContent || '',
          ds.lastScreenStatus || 'working',
          effectiveCliId,
          ds.displayMode ?? 'screenshot',
          ds.streamCardNonce,
          ds.currentImageKey,
          isSharedAdoptSession(ds),
          false,
          localeForBot(ds.larkAppId),
          cardUsageLimit(ds),
          writableTerminalLinkFor(ds),
          isLocalCliOpenReady(ds, { cliId: effectiveCliId }),
          getDaemonStreamingCardUsageSnapshot(ds, effectiveCliId),
          sessionRuntimeDisplayName(ds),
          codexServiceTierBadge(effectiveCliId, ds.codexServiceTier),
          silentIdleCardFlag(ds),
          dshRuntimeForSession(ds),
        );
        try { return JSON.parse(cardJson); } catch { /* fall through */ }
      }
      return;
    }

    if (actionType === 'skip_repo' && ds) {
      const locDs = localeForBot(ds.larkAppId);
      // Only the live posted card may act — covers consumed, wrong card, and
      // post-restart (repoCardMessageId is in-memory and empty after reboot).
      if (cardMessageId && !isActiveRepoCard(ds, cardMessageId)) {
        return { toast: { type: 'info', content: t('cmd.repo.card_already_consumed', undefined, locDs) } };
      }
      if (ds.pendingRepo) {
        if (ds.worktreeCreating || ds.pendingRepoCommitInFlight) {
          return {
            toast: {
              type: 'info',
              content: t('cmd.repo.worktree_in_progress', undefined, locDs),
            },
          };
        }
        const cwd = getSessionWorkingDir(ds);
        // "Start directly" is the same pending-start commit as choosing a
        // directory, just pinned to the current/default cwd. Reusing the shared
        // helper gives this card path the bot mutation, exact-owner recheck,
        // buffered-sidecar handling, and fork-before-release ordering.
        const started = await commitRepoSelection(
          { ds, rootId, cardMessageId, larkAppId: larkAppId ?? ds.larkAppId, operatorOpenId, activeSessions, sessionReply },
          cwd,
          cwd,
          {
            suppressConfirmReply: true,
            confirmReplyText: t('cmd.skip.opened', { cwd }, locDs),
            pinWorkingDir: false,
          },
        );
        if (started) {
          return { toast: { type: 'info', content: t('cmd.repo.worktree_in_progress', undefined, locDs) } };
        }
      } else {
        await sessionReply(rootId, t('card.action.continue_using_current_repo', { cwd: getSessionWorkingDir(ds) }, locDs));
        deferRepoCardWithdraw(larkAppId, cardMessageId);
        ds.repoCardMessageId = undefined;
      }
    }

    // Manual working-directory entry from the repo card form. The project scan
    // may not surface every useful directory; this mirrors `/repo <path>` from
    // the card. Permission is gated at the top (isSensitive + pendingRepoOwner
    // exception), same as skip_repo. Always a plain commit — worktree creation
    // needs a scanned git repo root, not an arbitrary path.
    if (actionType === 'repo_manual_submit' && ds) {
      const locDs = localeForBot(ds.larkAppId);
      if (cardMessageId && !isActiveRepoCard(ds, cardMessageId)) {
        return { toast: { type: 'info', content: t('cmd.repo.card_already_consumed', undefined, locDs) } };
      }
      const rawPath = String(action?.form_value?.repo_manual_path ?? '').trim();
      if (!rawPath) {
        return { toast: { type: 'error', content: t('card.repo.manual_empty', undefined, locDs) } };
      }
      const validation = validateWorkingDir(rawPath, locDs);
      if (!validation.ok) {
        return { toast: { type: 'error', content: validation.error } };
      }
      // A worktree creation in flight holds the commit lock — a manual switch
      // interleaving there would double-fork (same guard as the plain switch).
      if (ds.worktreeCreating || ds.pendingRepoCommitInFlight) {
        return { toast: { type: 'info', content: t('cmd.repo.worktree_in_progress', undefined, locDs) } };
      }
      const selectedPath = validation.resolvedPath;
      const displayName = pathBasename(selectedPath) || selectedPath;
      await commitRepoSelection(
        { ds, rootId, cardMessageId, larkAppId, operatorOpenId, activeSessions, sessionReply },
        selectedPath,
        displayName,
      );
    }

    if (actionType === 'worktree_toggle_mode' && ds) {
      // Flip the persisted per-bot worktree picker mode (single ⇄ multi), then
      // re-send a fresh repo card in the new mode — a form can't ride an
      // in-place patch, so the old card is withdrawn and a new one posted.
      const locDs = localeForBot(ds.larkAppId);
      if (!cardMessageId || !ds.repoCardMessageId || cardMessageId !== ds.repoCardMessageId) {
        logger.warn(
          `[${tag(ds)}] Ignoring stale worktree-toggle picker ${cardMessageId ?? 'none'} `
          + `(current=${ds.repoCardMessageId ?? 'none'})`,
        );
        return { toast: { type: 'warning', content: t('card.repo.toast_stale_picker', undefined, locDs) } };
      }
      const spec = findConfigField('worktreeMultiPicker');
      if (!spec) return;
      const next = getBot(ds.larkAppId).config.worktreeMultiPicker !== true;
      const r = await applyConfigField(ds.larkAppId, spec, next);
      if (!r.ok) return { toast: { type: 'error', content: t('cmd.config.write_failed', { reason: r.reason }, locDs) } };
      const projects = lastRepoScan.get(ds.chatId) ?? [];
      const newCard = buildRepoSelectCard(projects, getSessionWorkingDir(ds), rootId, locDs, next);
      const oldCardMessageId = ds.repoCardMessageId;
      let newCardMessageId: string;
      try {
        newCardMessageId = await sessionReply(rootId, newCard, 'interactive');
      } catch (err) {
        logger.warn(
          `[${tag(ds)}] Failed to publish replacement repo picker; old card remains authoritative: `
          + `${err instanceof Error ? err.message : String(err)}`,
        );
        return { toast: { type: 'error', content: t('cmd.config.write_failed', { reason: err instanceof Error ? err.message : String(err) }, locDs) } };
      }
      try {
        // Switch durable authority before changing runtime identity or
        // withdrawing the old card. A failed write leaves the old picker fully
        // usable and makes the newly-published card stale by exact-ID guard.
        persistPendingRepoCardMessageId(ds, newCardMessageId);
      } catch (err) {
        logger.error(
          `[${tag(ds)}] Failed to persist replacement repo picker ${newCardMessageId}; `
          + `old picker ${oldCardMessageId} retained: `
          + `${err instanceof Error ? err.message : String(err)}`,
        );
        return { toast: { type: 'error', content: t('cmd.config.write_failed', { reason: err instanceof Error ? err.message : String(err) }, locDs) } };
      }
      ds.repoCardMessageId = newCardMessageId;
      // The fresh ID is now durable. Withdrawal is best-effort and cannot
      // invalidate the new authority if Lark reports the old card missing.
      try { await deleteMessage(ds.larkAppId, oldCardMessageId); }
      catch { /* card already gone */ }
      return { toast: { type: 'info', content: t(next ? 'card.repo.toast_worktree_mode_switched' : 'card.repo.toast_worktree_mode_switched_back', undefined, locDs) } };
    }

    if (actionType === 'repo_worktree_submit' && ds) {
      const locDs = localeForBot(ds.larkAppId);
      if (!cardMessageId || !ds.repoCardMessageId || cardMessageId !== ds.repoCardMessageId) {
        logger.warn(
          `[${tag(ds)}] Ignoring stale worktree-submit picker ${cardMessageId ?? 'none'} `
          + `(current=${ds.repoCardMessageId ?? 'none'})`,
        );
        return { toast: { type: 'warning', content: t('card.repo.toast_stale_picker', undefined, locDs) } };
      }
      const selectedPaths = stringListFromLarkMultiSelect(action?.form_value?.repo_worktree_paths);
      if (selectedPaths.length === 0) {
        return { toast: { type: 'error', content: t('card.repo.worktree_empty', undefined, locDs) } };
      }
      if (ds.worktreeCreating || ds.pendingRepoCommitInFlight) {
        return { toast: { type: 'info', content: t('cmd.repo.worktree_in_progress', undefined, locDs) } };
      }
      const branch = String(action?.form_value?.repo_worktree_branch ?? '').trim() || undefined;
      const multiParent = selectedPaths.length > 1
        ? multiWorktreeParentPath(selectedPaths, branch ?? await worktreeSlugFromContextAI(ds.session.title, ds.pendingPrompt) ?? 'worktree')
        : undefined;
      if (multiParent) {
        const duplicateNames = duplicateMultiWorktreeChildNames(selectedPaths, lastRepoScan.get(ds.chatId));
        if (duplicateNames.length > 0) {
          return { toast: { type: 'error', content: t('card.repo.worktree_child_conflict', { names: duplicateNames.join(', ') }, locDs) } };
        }
      }
      const rootIdForAction = rootId;
      void handleCardAction({
        ...data,
        action: {
          value: { key: 'repo_worktree', root_id: rootIdForAction, repo_worktree_paths_json: JSON.stringify(selectedPaths), ...(branch ? { branch } : {}), ...(multiParent ? { parent_path: multiParent } : {}) },
          option: selectedPaths[0],
        },
      }, deps, larkAppId);
      return { toast: { type: 'info', content: t('card.repo.toast_worktree_creating', undefined, locDs) } };
    }
    return;
  }

  // Handle dropdown selections (option-based)
  const option = action?.option;
  if (!option) {
    logger.warn('Card action received but no option or action value');
    return;
  }
  if (Array.isArray(option)) {
    logger.warn('Card action received multi options for a single-select handler');
    return;
  }
  if (typeof option !== 'string') {
    logger.warn('Card action received non-string option for a single-select handler');
    return;
  }

  // Handle adopt session selection
  if (action?.value?.key === 'codex_app_thread_select' && option) {
    const rootId = action?.value?.root_id;
    if (!rootId) return;

    const sKey = larkAppId ? sessionKey(rootId, larkAppId) : rootId;
    const ds = activeSessions.get(sKey);
    if (!ds) return;
    const sourceSession = ds.session;
    if (isSessionTransferring(ds)) {
      return { toast: { type: 'warning', content: t('cmd.session.transfer_in_progress', undefined, localeForBot(ds.larkAppId)) } };
    }

    if (!canOperate(ds.larkAppId, ds.chatId, operatorOpenId)) {
      logger.info(`codex_app_thread_select blocked for non-operator user: ${operatorOpenId} (chat=${ds.chatId})`);
      return { toast: { type: 'error', content: t('card.grant.toast_no_repo_perm', undefined, localeForBot(ds.larkAppId)) } };
    }

    let selected: { threadId: string };
    try { selected = JSON.parse(option); } catch { return; }
    if (!selected.threadId) return;

    const botCfg = getBot(ds.larkAppId).config;
    if (botCfg.cliId !== 'codex-app' && !botCfg.existingAppServer) return;

    const { listCodexAppThreads } = await import('../../services/codex-app-threads.js');
    let threads: Awaited<ReturnType<typeof listCodexAppThreads>>;
    try {
      threads = await listCodexAppThreads({
        codexBin: botCfg.cliPathOverride,
        cwd: getSessionWorkingDir(ds),
        limit: 80,
      });
    } catch (err: any) {
      await sessionReply(rootId, t('cmd.codex_app_adopt.list_failed', { error: err?.message ?? String(err) }, localeForBot(ds.larkAppId)));
      return;
    }
    if (
      ds.session !== sourceSession
      || ds.session.status !== 'active'
      || activeSessions.get(sKey) !== ds
      || isSessionTransferring(ds)
    ) {
      return { toast: { type: 'warning', content: t('cmd.session.transfer_in_progress', undefined, localeForBot(ds.larkAppId)) } };
    }
    const target = threads.find(t => t.threadId === selected.threadId);
    if (!target) {
      await sessionReply(rootId, t('cmd.codex_app_adopt.thread_not_found', { threadId: selected.threadId }, localeForBot(ds.larkAppId)));
      if (cardMessageId && larkAppId) deleteMessage(larkAppId, cardMessageId);
      return;
    }

    const { startCodexAppThreadSession } = await import('../../core/command-handler.js');
    await startCodexAppThreadSession(target, ds, { activeSessions, sessionReply: deps.sessionReply, getActiveCount: () => 0, lastRepoScan }, larkAppId);
    if (cardMessageId && larkAppId) deleteMessage(larkAppId, cardMessageId);
    return;
  }


  // Handle repo select card (option-based dropdowns: plain switch, or
  // `repo_worktree` = create a worktree from the picked repo and open that).
  // Require an explicit, recognized key: botmux's own dropdowns always set
  // `repo_switch` / `repo_worktree` (card-builder.ts). Treating a keyless
  // `option + root_id` as a plain switch let a hand-crafted card drive the
  // session's working dir to an arbitrary path — reject anything unrecognized.
  const repoKey = action?.value?.key;
  if (repoKey !== 'repo_switch' && repoKey !== 'repo_worktree') {
    logger.warn(`Card action: unrecognized repo dropdown key ${repoKey ?? '(none)'} — ignoring`);
    return;
  }
  const isWorktreeOpen = repoKey === 'repo_worktree';
  const selectedPath = option;
  const rootId = action?.value?.root_id;
  logger.info(`Card action: repo ${isWorktreeOpen ? 'worktree-open' : 'switch'} to ${selectedPath} (root_id: ${rootId})`);

  if (!rootId) {
    logger.warn('Card action: no root_id in action value');
    return;
  }

  const targetDs = larkAppId ? activeSessions.get(sessionKey(rootId, larkAppId)) : undefined;
  if (!targetDs) {
    logger.warn(`Card action: no active session found for root ${rootId}`);
    return;
  }

  // The picker message id is the capability for every repo dropdown. Check it
  // before slug generation, worktreeCreating, git creation/push, or commit.
  // In particular the direct single-select `repo_worktree` callback does not
  // pass through the form-submit branch above, so relying on the later commit
  // check would allow a stale card to create an orphan worktree first.
  if (!cardMessageId || !targetDs.repoCardMessageId || cardMessageId !== targetDs.repoCardMessageId) {
    logger.warn(
      `[${tag(targetDs)}] Ignoring stale ${repoKey} picker ${cardMessageId ?? 'none'} `
      + `(current=${targetDs.repoCardMessageId ?? 'none'})`,
    );
    return {
      toast: {
        type: 'warning',
        content: t('card.repo.toast_stale_picker', undefined, localeForBot(targetDs.larkAppId)),
      },
    };
  }

  // 权限边界：pendingRepo（首次选 repo 才能 spawn）放行「会话发起人 或 canOperate」，
  // 让本群授权用户能完成自己的首次使用；非 pending 的 mid-session 切换是管理动作，要 canOperate。
  const isSessionOwnerOp = !!operatorOpenId && operatorOpenId === targetDs.session.ownerOpenId;
  const allowRepo = targetDs.pendingRepo
    ? (isSessionOwnerOp || canOperate(targetDs.larkAppId, targetDs.chatId, operatorOpenId))
    : canOperate(targetDs.larkAppId, targetDs.chatId, operatorOpenId);
  if (!allowRepo) {
    logger.info(`Repo card action blocked for ${operatorOpenId} (pending=${targetDs.pendingRepo})`);
    return { toast: { type: 'error', content: t('card.grant.toast_no_repo_perm', undefined, localeForBot(targetDs.larkAppId)) } };
  }

  // Reject a live REMOTE repo/worktree replacement before slug generation or
  // any local/remote Git side effect. First-spawn pendingRepo selections stay
  // recoverable when a synchronous fork failure has already stamped the
  // remote backend.
  if (!targetDs.pendingRepo && isRemoteBackendSession(targetDs)) {
    await sessionReply(rootId, t('cmd.cd.remote_unsupported', undefined, localeForBot(targetDs.larkAppId)));
    logger.warn(`[${tag(targetDs)}] Repo switch refused before Git work: remote session requires explicit close before replacement`);
    return;
  }

  // Resolve the project name from cached scan
  const cached = lastRepoScan.get(targetDs.chatId);
  const project = cached?.find(p => p.path === selectedPath);
  const displayName = project ? `${project.name} (${project.branch})` : selectedPath;
  let selectedWorktreePaths = [selectedPath];
  if (isWorktreeOpen && typeof action?.value?.repo_worktree_paths_json === 'string') {
    try {
      selectedWorktreePaths = stringListFromLarkMultiSelect(JSON.parse(action.value.repo_worktree_paths_json));
    } catch {
      selectedWorktreePaths = [];
    }
    if (selectedWorktreePaths.length === 0) {
      return { toast: { type: 'error', content: t('card.repo.worktree_empty', undefined, localeForBot(targetDs.larkAppId)) } };
    }
  }

  const locTarget = localeForBot(targetDs.larkAppId);

  // `/close` deletes the active-map entry without touching sessionId or
  // pendingRepo — identity against the map is the only tell that the session
  // this flow captured is gone. Checked alongside the generation snapshots.
  const repoSessionKey = sessionKey(rootId, larkAppId!);
  const sessionStillActive = () => activeSessions.get(repoSessionKey) === targetDs;

  // Shared commit context for a resolved directory — funnels the dropdown,
  // worktree and manual-entry flows through the same module-level
  // commitRepoSelection (pin dir, then fork pending CLI or close+recreate).
  const commitCtx = { ds: targetDs, rootId, cardMessageId, larkAppId, operatorOpenId, activeSessions, sessionReply };

  if (isWorktreeOpen) {
    // Worktree creation involves a `git fetch` that can take many seconds —
    // ack the card action immediately with a toast and finish asynchronously.
    // On failure the card (and pendingRepo state) stays put so the user can
    // pick again or fall back to a plain switch.
    if (targetDs.worktreeCreating || targetDs.pendingRepoCommitInFlight) {
      // The async path escapes the card-action in-flight dedup — gate repeats
      // here, or two creations would race and the loser's commitSelection
      // would yank the session the winner just spawned.
      return { toast: { type: 'info', content: t('cmd.repo.worktree_in_progress', undefined, locTarget) } };
    }
    const parentPath = action?.value?.parent_path;
    if (selectedWorktreePaths.length > 1 && parentPath) {
      const duplicateNames = duplicateMultiWorktreeChildNames(selectedWorktreePaths, cached);
      if (duplicateNames.length > 0) {
        return { toast: { type: 'error', content: t('card.repo.worktree_child_conflict', { names: duplicateNames.join(', ') }, locTarget) } };
      }
    }
    targetDs.worktreeCreating = true;
    // Session generation snapshot: if another selection lands while git runs
    // (pendingRepo consumed, or the session swapped), committing this worktree
    // afterwards would kill that fresh session — notify instead of switching.
    const startSessionId = targetDs.session.sessionId;
    const wasPending = !!targetDs.pendingRepo;
    const sessionChanged = () =>
      !sessionStillActive() ||
      targetDs.session.sessionId !== startSessionId ||
      !!targetDs.pendingRepo !== wasPending;
    const notSwitched = async (creation: { path: string; branch: string }, when: string) => {
      logger.info(`[${tag(targetDs)}] Worktree ${creation.path} created but session changed ${when} — not switching`);
      await sessionReply(rootId, t('cmd.repo.worktree_created_not_switched', { path: creation.path, branch: creation.branch }, locTarget));
    };
    void (async () => {
      try {
        let creation;
        // Track each successful (sourceRepo → created worktree) so a later repo's
        // failure in a multi-repo batch can roll the earlier ones back instead of
        // leaking orphaned worktree dirs/branches.
        const created: Array<{ repo: string; result: { path: string; branch: string; baseRef: string } }> = [];
        try {
          const branch = action?.value?.branch?.trim() || undefined;
          const slug = branch ? undefined : await worktreeSlugFromContextAI(targetDs.session.title, targetDs.pendingPrompt);
          for (const repoPath of selectedWorktreePaths) {
            const result = await createRepoWorktree(repoPath, {
              branch,
              slug,
              worktreePath: selectedWorktreePaths.length > 1 && parentPath
                ? join(parentPath, worktreeChildNameForRepo(repoPath, cached))
                : undefined,
            });
            created.push({ repo: repoPath, result });
          }
          creation = selectedWorktreePaths.length > 1 && parentPath
            ? {
                path: parentPath,
                branch: branch ?? created.map(c => c.result.branch).join(', '),
                baseRef: Array.from(new Set(created.map(c => c.result.baseRef))).join(', '),
              }
            : created[0]!.result;
        } catch (e) {
          // The repo that threw is the one right after the last success.
          const failedRepo = selectedWorktreePaths[created.length] ?? selectedPath;
          const errMsg = e instanceof Error ? e.message : String(e);
          logger.warn(`[${tag(targetDs)}] Worktree creation failed for ${failedRepo}: ${errMsg}`);
          let rolledBack = 0;
          for (const c of created) {
            try { await removeRepoWorktree(c.repo, c.result.path); rolledBack++; }
            catch (re) { logger.warn(`[${tag(targetDs)}] rollback of ${c.result.path} failed: ${re instanceof Error ? re.message : re}`); }
          }
          await sessionReply(rootId, rolledBack > 0
            ? t('card.repo.worktree_rolled_back', { repo: pathBasename(failedRepo), error: errMsg, count: rolledBack }, locTarget)
            : t('cmd.repo.worktree_failed', { error: errMsg }, locTarget));
          return;
        }
        if (sessionChanged()) return notSwitched(creation, 'mid-flight');
        // riff：新建的 worktree 分支只存在于本地，远程沙箱克隆不到 → 先推送
        // 分支指针到远端，riff 任务才能钉住这个新分支。推送失败不阻塞（worker
        // 推导会按现状回退默认分支并在卡片注入告警），只提示用户。
        if (nextSessionUsesRiffBackend(targetDs)) {
          for (const c of created) {
            try {
              await pushWorktreeBranch(c.result.path, c.result.branch);
            } catch (e) {
              const errMsg = e instanceof Error ? e.message : String(e);
              logger.warn(`[${tag(targetDs)}] riff worktree branch push failed (${c.result.branch}): ${errMsg}`);
              await sessionReply(rootId, t('card.repo.riff_worktree_push_failed', { branch: c.result.branch, error: errMsg }, locTarget));
            }
          }
        }
        await sessionReply(rootId, t('cmd.repo.worktree_created', {
          path: creation.path, branch: creation.branch, base: creation.baseRef,
        }, locTarget));
        // The reply above awaited a Lark round-trip — a plain switch (which is
        // NOT gated by worktreeCreating) can land in that window. Re-check
        // right before committing, or we'd kill the session it just spawned.
        if (sessionChanged()) return notSwitched(creation, 'during reply');
        try {
          // The "worktree 已创建：…" notice above already confirms the switch —
          // suppress commitRepoSelection's own "已选择/已切换" to avoid a dup.
          await commitRepoSelection(commitCtx, creation.path, `${pathBasename(creation.path)} (${creation.branch})`, {
            suppressConfirmReply: true,
            // 多仓：把按用户选择顺序创建的 worktree 目录 stamp 到 session，
            // riff 按此显式列表（而非目录扫描）推导 repos，首仓为 primary。
            riffRepoDirs: created.length > 1 ? created.map(c => c.result.path) : undefined,
          });
        } catch (e) {
          // The worktree DOES exist at this point — only the switch failed.
          // Don't report it as a creation failure, or the user retries and
          // trips over "worktree target already exists".
          logger.warn(`[${tag(targetDs)}] Worktree ${creation.path} created but switching failed: ${e instanceof Error ? e.message : e}`);
          await sessionReply(rootId, t('cmd.repo.worktree_switch_failed', { path: creation.path, error: e instanceof Error ? e.message : String(e) }, locTarget));
        }
      } finally {
        targetDs.worktreeCreating = false;
      }
    })();
    return { toast: { type: 'info', content: t('card.repo.toast_worktree_creating', undefined, locTarget) } };
  }

  // Plain switch — blocked while a worktree creation/commit is in flight. The
  // worktree commit awaits (Lark replies, prompt prep) after its generation
  // checks; a plain selection interleaving there would double-fork. One lock
  // gates both kinds until the commit settles.
  if (targetDs.worktreeCreating || targetDs.pendingRepoCommitInFlight) {
    return { toast: { type: 'info', content: t('cmd.repo.worktree_in_progress', undefined, locTarget) } };
  }
  await commitRepoSelection(commitCtx, selectedPath, displayName);
}
