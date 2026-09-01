// src/core/dashboard-ipc-server.ts
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { execFileSync } from 'node:child_process';
import { readFileSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { logger } from '../utils/logger.js';
import { cliAuthBind, loadDashboardSecret, verifyHmac } from '../dashboard/auth.js';
import { UnsafeHostAuthorityFileError } from '../platform/secure-host-file.js';
import { WORKFLOW_DAEMON_IPC_ROUTE_PREFIX } from '../workflows/v3/daemon-ipc-auth.js';
import { V3_SESSION_RUN_MUTATION_ROUTE_PREFIX } from '../workflows/v3/session-relay.js';
import { REPORT_SESSION_RELAY_ROUTE } from './report-session-relay.js';
import { DISPATCH_REPORT_REGISTER_ROUTE } from './dispatch-report-binding.js';
import { listenWithProbe } from '../utils/listen-with-probe.js';
import { dashboardSecretPath } from './dashboard-secret.js';
import {
  MANAGED_ORIGIN_ATTEST_ROUTE,
  MANAGED_ORIGIN_PROOF_DOMAIN,
  MANAGED_ORIGIN_PROOF_TTL_MS,
  writeManagedOriginAttestationProof,
} from './managed-origin-attestation.js';
import * as sessionStore from '../services/session-store.js';
import { cliSupportsNativeUsage } from '../services/transcript-resolver.js';
import {
  cliModelSupportsReasoningEffort,
  isConfigurableReasoningCliId,
  isCodexReasoningEffort,
} from '../services/codex-reasoning-effort.js';
import * as asyncTriggerStore from '../services/async-trigger-store.js';
import { resolveAsyncTriggerState, decideAsyncOwnership } from '../services/async-trigger-state.js';
import * as scheduleStore from '../services/schedule-store.js';
import * as groupsStore from '../services/groups-store.js';
import { createGroupWithBots, transferGroupOwner } from '../services/group-creator.js';
import * as oncallStore from '../services/oncall-store.js';
import * as brandStore from '../services/brand-store.js';
import * as sandboxStore from '../services/sandbox-store.js';
import * as backendTypeStore from '../services/backend-type-store.js';
import { isValidRiffBaseUrl, isValidRiffSandboxCluster } from '../adapters/backend/riff-backend.js';
import { ensureBackendAvailable } from '../services/backend-availability.js';
import type { BackendType } from '../adapters/backend/types.js';
import * as persistentBackend from './persistent-backend.js';
import * as cardPrefsStore from '../services/card-prefs-store.js';
import * as substituteModeStore from '../services/substitute-mode-store.js';
import { claimPromptContext } from '../services/prompt-context-store.js';
import { createCliAdapterSync } from '../adapters/cli/registry.js';
import { normalizeCliRuntimeConfig, type CliRuntimeConfig } from '../adapters/cli/runtime.js';
import { evaluateReadIsolationGate } from '../adapters/cli/read-isolation.js';
import {
  CURRENT_ACTOR_ROUTE,
} from '../cli/current-actor.js';
import {
  resolveDaemonCurrentActor,
  resolveLoopbackPeerProcesses,
} from './current-actor-attestation.js';

/** Whether read isolation can actually be ENFORCED for this bot right now — the
 *  SAME gate the worker fail-closes on (adapter support + no wrapperCli + macOS).
 *  The dashboard uses it to disable the toggle and to reject persisting an
 *  unenforceable flag, so flipping it on can never brick the bot's next session
 *  (the worker would otherwise refuse to start). Turning it OFF is always allowed. */
function readIsolationEnforceableFor(cfg: { cliId?: string; cliPathOverride?: string; wrapperCli?: string }): boolean {
  let adapterSupports = false;
  try {
    adapterSupports = createCliAdapterSync(cfg.cliId as never, cfg.cliPathOverride).supportsReadIsolation === true;
  } catch { /* CLI missing / unknown adapter → treat as unenforceable */ }
  return evaluateReadIsolationGate({
    configured: true,
    adapterSupports,
    wrapperCliSet: !!cfg.wrapperCli,
    platform: process.platform,
    sessionDataDirSet: true,
  }).enabled;
}
function readIsolationEnforceable(larkAppId: string): boolean {
  try { return readIsolationEnforceableFor(getBot(larkAppId).config); } catch { return false; }
}
import * as observedBotsStore from '../services/observed-bots-store.js';
import { getDeploymentIdentity } from '../services/deployment-identity.js';
import { getBotUnionId } from '../services/bot-union-ids-store.js';
import * as grantPrefsStore from '../services/grant-prefs-store.js';
import { applyExactChatGrantRequest } from '../services/exact-chat-grant.js';
import { normalizeBotDescriptions } from '../services/bot-description-schema.js';
import type {
  OpenPlatformDescriptionReadResult,
  OpenPlatformDescriptionUpdateResult,
} from '../services/open-platform-rename.js';
import { findConfigField, applyConfigField, coerceConfigValue, setChatFeedbackPolicy } from '../services/bot-config-store.js';
import { traceFeedbackPolicyForDelivery } from '../services/feedback-policy-resolver.js';
import { globalBuiltinSkillInjectionDefault, resolveSkillInjectionSupport } from '../skills/injection-mode.js';
import { summaryRangeFromBotConfig, updateDashboardSummaryRange } from '../services/summary-range-store.js';
import { config } from '../config.js';
import { buildSafeInsightConversation, buildSafeInsightOverview, buildSafeInsightReport, buildSafeInsightTurnDetail } from '../services/insight/report.js';
import type { InsightConversationRole, InsightDetail, InsightSeverity, SafeSpanTag } from '../services/insight/types.js';
import { readRawConfig, findEntryIndex, requireConfigPath, rmwBotEntry } from '../services/config-store.js';
import { setDefaultLocale, localeForBot, t } from '../i18n/index.js';
import { isLocale, type Locale } from '../i18n/types.js';
import { readGlobalConfig } from '../global-config.js';
import { normalizeChatReplyMode, setChatReplyMode, type ChatReplyMode } from '../services/chat-reply-mode-store.js';
import * as chatFirstSeenStore from '../services/chat-first-seen-store.js';
import * as scheduler from './scheduler.js';
import { listActiveSessions, findActiveBySessionId, closeSession, getActiveSessionsRegistry, transferSession, deliverWriteLinkCardToOwners, forkWorker, suspendWorker, killWorker, latestPerBotEnvForRestart, latestModelForRespawn, getDaemonReplyCardUsageSnapshot, sessionSupportsWebTerminal, sendWorkerSessionInput, isSessionTransferring, mojoCloseResidualForRow } from './worker-pool.js';
import { listOnlineDaemons } from '../utils/daemon-discovery.js';
import { isSessionStopped } from './session-liveness.js';
import { isRemoteBackendType, isRemoteCliId, isSuspendableBackendType } from './persistent-backend.js';
import { getChatMode, replyMessage, sendMessage, resolveUnionIdFromOpenId, listThreadMessages, listChatMessages, listChatMessagesUntil, listChatBotMembers, getUserProfile, getUserProfileStrict, resolveAllowedUsersWithMap, type ChatBotMember } from '../im/lark/client.js';
import { parseApiMessage, cardContentHasUpgradeFallback, resolveMergedCardContent, messageMentionsBot } from '../im/lark/message-parser.js';
import { resumeSession, spawnDashboardSession, activateQueuedSession, closeCliMismatchedSessionsForBot } from './session-manager.js';

import { parseSpawnRequest } from './session-create.js';
import { cleanupMaterializedDashboardImages, materializeDashboardImages } from './dashboard-images.js';
import { getCliDisplayName } from '../im/lark/card-builder.js';
import { sessionConfiguredRuntimeDisplayName } from './cli-runtime-display.js';
import { locateLimiter } from './dashboard-locate.js';
import { DEFAULT_SESSION_OWNER_REMINDER } from './session-owner-reminder.js';
import { updateSessionOwnerReminderConfig } from '../services/session-owner-reminder-config-store.js';
import { sendSessionOwnerThreadNotification } from '../services/session-owner-notification.js';
import { buildTerminalUrl } from './terminal-url.js';
import { dashboardEventBus } from './dashboard-events.js';
import { validateWorkingDir } from './working-dir.js';
import { isValidRoleChatId, resolveRole, resolveRoleFile, writeRoleFile, deleteRoleFile, readRoleInjectMode, writeRoleInjectMode, deleteRoleMeta, readRoleDispatchCompletionEnabled, writeRoleDispatchCompletionEnabled, type RoleInjectMode } from './role-resolver.js';
import {
  deleteRoleProfileEntry,
  deleteRoleProfileIfEmpty,
  isValidRoleProfileId,
  listRoleProfileEntries,
  listRoleProfiles,
  MAX_ROLE_PROFILE_ENTRY_BYTES,
  readRoleProfileEntry,
  writeRoleProfileEntry,
} from '../services/role-profile-store.js';
import { triggerSessionTurn } from './trigger-session.js';
import { validateTriggerRequest, type TriggerResponse } from '../services/trigger-types.js';
import { resolveCliSelection, selectionKeyForBot } from '../setup/cli-selection.js';
import { checkCliAvailability } from '../setup/cli-availability.js';
import { enrichHistorySenders, type HistoryBotInfo } from '../dashboard/history-senders.js';
import {
  validateCodexAppManagedSendOrigin,
} from '../utils/codex-app-dispatch-ledger.js';
import { tryWithBotTurnMutation, withBotTurnAdmission, withBotTurnMutation } from './bot-turn-mutation-gate.js';
import {
  SESSION_WAKE_DEADLINE_HEADER,
  sessionWakeAcquireTimeoutMs,
} from './session-wake-deadline.js';
import {
  protectedSessionMutationReasons,
} from './session-mutation-guard.js';
import { listPendingAsks, submitAskFromDesktop } from './ask-broker.js';
import { getMessageListenerConfig, sanitizeMessageListenerUpdate, updateMessageListenerConfig, validateMessageListenerUpdate } from '../services/message-listener-store.js';
import {
  MAX_MESSAGE_LISTENER_PROMPT_BYTES,
  normalizeMessageListenerPreviewLimit,
  previewMessageListenerMatches,
  buildListenerBotAppIdToOpenId,
  collectListenerBotAppIds,
  renderMessageListenerInstruction,
  type MessageListenerPreviewMatch,
} from '../services/message-listener.js';
import {
  createMessageListenerRunPreview,
  createMessageListenerRunPreviewTurnId,
  getMessageListenerRunPreview,
  markMessageListenerRunPreviewFailed,
  markMessageListenerRunPreviewTriggered,
} from '../services/message-listener-run-preview-store.js';
import { listChatMemberDisplays } from '../services/groups-store.js';

const MESSAGE_LISTENER_PREVIEW_WINDOW_MS = 24 * 60 * 60 * 1000;
import {
  SUPERVISOR_SHUTDOWN_ROUTE,
  isExactSupervisorShutdownRequest,
  type SupervisorShutdownIdentity,
} from './supervisor-shutdown-ipc.js';

let exactChatGrantHandler: typeof applyExactChatGrantRequest = applyExactChatGrantRequest;
/** Test seam: replace the exact-grant service without touching live Feishu/config state. */
export function setExactChatGrantHandler(handler: typeof applyExactChatGrantRequest | null): void {
  exactChatGrantHandler = handler ?? applyExactChatGrantRequest;
}
import { buildGoalBoard } from '../verified-delivery/goal-board.js';
import {
  buildGoalAttentionBoardWithContext,
  buildLocalGoalAttentionLiveRisks,
  withGoalAttentionLiveRisks,
} from './goal-attention.js';

// 机器人真·改名 renamer，由 daemon 启动时注册（开放平台自动化 + daemon 侧
// botName/descriptor/bots-info 同步都在 daemon 的闭包里做）。未注册（测试环境）
// 时 PUT /api/bot-rename 降级为仅改 displayName。
export type BotRenameOutcome =
  | { ok: true; name: string }
  | { ok: false; reason: string; message: string };
let botRenamer: ((newName: string) => Promise<BotRenameOutcome>) | null = null;
export function setBotRenamer(fn: ((newName: string) => Promise<BotRenameOutcome>) | null): void {
  botRenamer = fn;
}
// 机器人真·改头像，注册方式同 renamer（开放平台自动化 + daemon 侧
// botAvatarUrl/descriptor/bots-info 同步在 daemon 闭包里做）。头像没有
// botmux 侧的本地等价物，失败不降级，把结构化原因原样返回给前端。
export type BotAvatarOutcome =
  | { ok: true; avatarUrl: string; versionId?: string }
  | { ok: false; reason: string; message: string };
let botAvatarChanger: ((image: Buffer) => Promise<BotAvatarOutcome>) | null = null;
export function setBotAvatarChanger(fn: ((image: Buffer) => Promise<BotAvatarOutcome>) | null): void {
  botAvatarChanger = fn;
}
// 机器人多语言名片描述读/写，注册方式同 renamer / avatar（开放平台自动化在
// daemon 闭包里做）。描述没有 botmux 侧的本地等价物，失败不降级，把结构化原因
// 原样返回给前端。API-only bot 不注册该 manager（无飞书应用可改）。
export type BotDescriptionManager = {
  read: () => Promise<OpenPlatformDescriptionReadResult>;
  update: (descriptions: Record<string, string>) => Promise<OpenPlatformDescriptionUpdateResult>;
};
let botDescriptionManager: BotDescriptionManager | null = null;
export function setBotDescriptionManager(manager: BotDescriptionManager | null): void {
  botDescriptionManager = manager;
}

type SupervisorShutdownRegistration = SupervisorShutdownIdentity & {
  shutdown: () => Promise<void>;
};
let supervisorShutdownRegistration: SupervisorShutdownRegistration | null = null;
export function setSupervisorShutdownHandler(
  registration: SupervisorShutdownRegistration | null,
): void {
  supervisorShutdownRegistration = registration;
}
import {
  composeRowFromActive,
  composeRowFromClosed,
  composeRowFromPersistedActive,
  feishuChatLink,
  setBotName as setRowsBotName,
  getBotName,
  type SessionRow,
} from './dashboard-rows.js';
import { getBotBrand, getBot, getBotOpenId, getOwnerOpenId, loadBotConfigs, readBotSkillPolicy, getBotTuiSlashAllow, MAX_TURN_TIMEOUT_MS, type UsageDisplayMode, type MessageListenerConfig } from '../bot-registry.js';
import { generateAuthUrl, tryHandleCallbackUrl, getFeedGroupAuthStatus, FEED_GROUP_OAUTH_SCOPES } from '../utils/user-token.js';
import { clampSessionTagName, defaultSessionTagName } from '../services/feed-group-tagger.js';
import { normalizeBrand } from '../im/lark/lark-hosts.js';
import type { ReplyStyleConfig } from '../im/lark/reply-card-style.js';
import {
  normalizeSparseReplyStyleConfig,
  REPLY_STYLE_REQUEST_MAX_BYTES,
} from '../dashboard/reply-style.js';
import { normalizeKanbanColumn, normalizeKanbanPosition, normalizeSessionTitle } from './session-board.js';
import { validateSlashInjection } from './slash-inject.js';
import { validateRoleLibraryPath } from './role-library.js';
import { repinSessionWorkingDir } from './session-cwd.js';
import { authorizeSessionScopedIpc } from './daemon-ipc-session-auth.js';
import { normalizeSessionTitleSource, updateSessionTitle } from './session-title.js';
import { requestAgentSessionRename } from './session-rename.js';
import {
  isPreviewLoopbackHost,
  isPreviewPort,
  previewBackendSupported,
  probeSessionPreviewTarget,
  sessionPreviewDescriptor,
} from './session-preview.js';
import { clearSessionPreviewTarget } from './session-preview-registry.js';
import { ChatRenameCooldown, ChatRenameSerialQueue, normalizeLarkChatName } from './chat-rename.js';
import type { DaemonToWorker, ScheduledTask, ParsedSchedule, ScheduleExecutionPosition, Session } from '../types.js';
import { sessionAnchorId, larkTransportEnabled, type DaemonSession } from './types.js';
import { isRemoteBackendSession } from './persistent-backend.js';
import { attachSkillPolicy, detachSkillPolicy } from './skills/im-command.js';
import { readSkillRegistry } from '../services/skill-registry-store.js';
import { isSessionGroup } from '../services/session-groups-store.js';
import {
  commitDeviceIsolationActivation,
  DEVICE_ISOLATION_COMMIT_PATH,
  DEVICE_ISOLATION_PREPARE_PATH,
  DEVICE_ISOLATION_RELEASE_PATH,
  logDeviceIsolationActivationError,
  prepareDeviceIsolationActivation,
  releaseDeviceIsolationActivation,
  type DeviceIsolationDaemonResult,
} from './device-isolation-daemon.js';

// Daemon process start (module load ≈ daemon boot). Used by the SSE snapshot
// replay to bound the "recently closed" set to sessions that flipped
// active→closed during THIS run — i.e. restore-time zombies — without replaying
// the entire closed-session history on every connect.
const PROCESS_START_MS = Date.now();

export interface IpcServerHandle {
  port: number;
  close: () => Promise<void>;
}

export type Handler = (
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
) => Promise<void> | void;

interface Route {
  method: string;
  pattern: RegExp;
  keys: string[];
  handler: Handler;
}

const routes: Route[] = [];

/** Requests that crossed the server-wide trusted-host gate. The legacy
 * write-link handlers consult this marker so they do not verify (and consume)
 * the same one-shot nonce twice. */
const trustedHostRequests = new WeakSet<IncomingMessage>();
export function isTrustedHostIpcRequest(req: IncomingMessage): boolean {
  return trustedHostRequests.has(req);
}

/** Register a handler. Path supports `:name` segments captured into the params object. */
export function ipcRoute(method: string, path: string, handler: Handler): void {
  const keys: string[] = [];
  const pattern = new RegExp(
    '^' + path.replace(/:([a-zA-Z]+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$',
  );
  routes.push({ method: method.toUpperCase(), pattern, keys, handler });
}

export function jsonRes(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function rejectProtectedSessionMutation(
  res: ServerResponse,
  values: readonly (DaemonSession | Session)[],
): boolean {
  const bySessionId = new Map<string, {
    sessionId: string;
    cliId?: string;
    reasons: ReturnType<typeof protectedSessionMutationReasons>;
  }>();
  for (const value of values) {
    const session = 'session' in value ? value.session : value;
    const reasons = protectedSessionMutationReasons(value);
    if (reasons.length === 0) continue;
    const existing = bySessionId.get(session.sessionId);
    if (existing) {
      existing.reasons = [...new Set([...existing.reasons, ...reasons])];
      continue;
    }
    bySessionId.set(session.sessionId, {
      sessionId: session.sessionId,
      ...(session.cliId ? { cliId: session.cliId } : {}),
      reasons,
    });
  }
  const blockingSessions = [...bySessionId.values()];
  if (blockingSessions.length === 0) return false;
  const codexDispatchOnly = blockingSessions.every(blocker =>
    blocker.reasons.every(reason => reason === 'codex_app_dispatch'));
  jsonRes(res, 409, {
    ok: false,
    error: codexDispatchOnly
      ? 'codex_app_dispatch_pending'
      : 'session_mutation_pending',
    blockingSessions,
  });
  return true;
}

ipcRoute('POST', SUPERVISOR_SHUTDOWN_ROUTE, async (req, res) => {
  // The production server-wide HMAC gate records trusted requests here. Keep
  // an explicit route-local check: shutdown is never a bare loopback API.
  if (!isTrustedHostIpcRequest(req)) {
    return jsonRes(res, 403, { ok: false, error: 'supervisor_shutdown_unauthorized' });
  }
  const registration = supervisorShutdownRegistration;
  if (!registration) {
    return jsonRes(res, 503, { ok: false, error: 'supervisor_shutdown_not_ready' });
  }
  let body: unknown;
  try { body = await readJsonBody(req); }
  catch { return jsonRes(res, 400, { ok: false, error: 'invalid_json' }); }
  if (!isExactSupervisorShutdownRequest(registration, body)) {
    return jsonRes(res, 409, { ok: false, error: 'supervisor_shutdown_generation_mismatch' });
  }
  // ACK means this exact in-memory generation accepted the request; the CLI
  // still proves OS/PM2 quiescence. Start after flushing the ACK so a long Riff
  // drain cannot turn a valid request into an ambiguous transport timeout.
  jsonRes(res, 202, {
    ok: true,
    accepted: true,
    larkAppId: registration.larkAppId,
    bootInstanceId: registration.bootInstanceId,
    processStartIdentity: registration.processStartIdentity,
  });
  setImmediate(() => {
    void registration.shutdown().catch(error => {
      logger.error(`supervisor shutdown failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  });
});
export class JsonBodyTooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super(`JSON request body exceeds ${maxBytes} bytes`);
    this.name = 'JsonBodyTooLargeError';
  }
}

export class AbortDeadlineError extends Error {
  constructor(
    readonly label: string,
    readonly timeoutMs: number,
  ) {
    super(`${label} timed out after ${timeoutMs}ms`);
    this.name = 'AbortDeadlineError';
  }
}

/** 校验跨进程 JSON envelope，只接受普通对象和完整、精确的自有字段集合。 */
export function hasExactSafeJsonKeys(
  value: unknown,
  expectedKeys: readonly string[],
): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const keys = Object.keys(value);
  if (keys.length !== expectedKeys.length) return false;
  if (['__proto__', 'prototype', 'constructor'].some(key => Object.hasOwn(value, key))) {
    return false;
  }
  const expected = new Set(expectedKeys);
  return keys.every(key => expected.has(key));
}

/**
 * 为支持 AbortSignal 的底层操作设置硬截止时间。Promise.race 保证调用方按时释放
 * in-flight 状态，AbortController 同时取消仍在执行的网络或子进程操作。
 */
export async function runWithAbortDeadline<T>(
  label: string,
  timeoutMs: number,
  task: (signal: AbortSignal, deadlineAt: number) => Promise<T>,
): Promise<T> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError('timeoutMs must be a positive safe integer');
  }
  const controller = new AbortController();
  const deadlineAt = Date.now() + timeoutMs;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new AbortDeadlineError(label, timeoutMs);
      controller.abort(error);
      reject(error);
    }, timeoutMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([task(controller.signal, deadlineAt), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function readJsonBody<T = unknown>(
  req: IncomingMessage,
  maxBytes?: number,
): Promise<T> {
  if (maxBytes !== undefined && (!Number.isSafeInteger(maxBytes) || maxBytes <= 0)) {
    throw new RangeError('maxBytes must be a positive safe integer');
  }
  if (maxBytes !== undefined) {
    const declared = req.headers?.['content-length'];
    const declaredBytes = typeof declared === 'string' && /^\d+$/.test(declared)
      ? Number(declared)
      : undefined;
    if (declaredBytes !== undefined && declaredBytes > maxBytes) {
      req.once('error', () => {});
      req.resume();
      throw new JsonBodyTooLargeError(maxBytes);
    }

    const body = await new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = [];
      let totalBytes = 0;
      let settled = false;
      const cleanup = () => {
        req.off('data', onData);
        req.off('end', onEnd);
        req.off('error', onError);
        req.off('aborted', onAborted);
      };
      const rejectOnce = (error: Error, drain = false) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (drain) {
          // 不销毁 keep-alive socket，只丢弃剩余正文，让调用方仍能返回 413。
          req.once('error', () => {});
          req.resume();
        }
        reject(error);
      };
      const onData = (raw: Buffer | string) => {
        if (settled) return;
        const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
        totalBytes += chunk.byteLength;
        if (totalBytes > maxBytes) {
          chunks.length = 0;
          rejectOnce(new JsonBodyTooLargeError(maxBytes), true);
          return;
        }
        chunks.push(chunk);
      };
      const onEnd = () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(Buffer.concat(chunks, totalBytes));
      };
      const onError = (error: Error) => rejectOnce(error);
      const onAborted = () => rejectOnce(new Error('request aborted'));
      req.on('data', onData);
      req.once('end', onEnd);
      req.once('error', onError);
      req.once('aborted', onAborted);
    });
    if (body.byteLength === 0) return {} as T;
    return JSON.parse(body.toString('utf8'));
  }

  const chunks: Buffer[] = [];
  for await (const c of req) {
    const chunk = Buffer.isBuffer(c) ? c : Buffer.from(c);
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {} as T;
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

class IpcBodyTooLargeError extends Error {}
class IpcBodyTimeoutError extends Error {}

/** Strict reader for the one unauthenticated capability challenge route. The
 * generic IPC reader intentionally has no cap for trusted-host endpoints; a
 * loopback-confined process must not be able to buffer arbitrary chunked input
 * before its capability is checked. */
async function readBoundedJsonBody<T = unknown>(
  req: IncomingMessage,
  maxBytes: number,
  timeoutMs: number,
): Promise<T> {
  const contentLength = req.headers['content-length'];
  if (typeof contentLength === 'string') {
    if (!/^\d+$/.test(contentLength) || Number(contentLength) > maxBytes) {
      throw new IpcBodyTooLargeError('request body too large');
    }
  }
  return await new Promise<T>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
      req.off('aborted', onAborted);
    };
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      req.pause();
      cleanup();
      reject(err);
    };
    const onData = (raw: Buffer | string) => {
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
      total += chunk.length;
      if (total > maxBytes) {
        fail(new IpcBodyTooLargeError('request body too large'));
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => {
      if (settled) return;
      settled = true;
      cleanup();
      try {
        resolve(chunks.length === 0
          ? {} as T
          : JSON.parse(Buffer.concat(chunks, total).toString('utf8')) as T);
      } catch (err) {
        reject(err);
      }
    };
    const onError = (err: Error) => fail(err);
    const onAborted = () => fail(new Error('request aborted'));
    const timer = setTimeout(
      () => fail(new IpcBodyTimeoutError('request body timed out')),
      timeoutMs,
    );
    timer.unref?.();
    req.on('data', onData);
    req.once('end', onEnd);
    req.once('error', onError);
    req.once('aborted', onAborted);
  });
}

function closeUntrustedRequestAfterResponse(req: IncomingMessage, res: ServerResponse): void {
  res.setHeader('connection', 'close');
  res.once('finish', () => req.destroy());
  // Drain whatever is already buffered until the response has been flushed;
  // the finish hook then closes a partial/slow body instead of reusing it as a
  // keep-alive request.
  req.resume();
}

// ─── Trusted-host auth (loopback + route-bound HMAC) ────────────────────────
//
// Production start enables a server-wide gate: loopback is connectivity, not
// identity, because a Linux bwrap CLI keeps host networking for model egress.
// Every data/read or mutation route therefore requires proof that the caller
// can read ~/.botmux/.dashboard-secret. Only health and a tiny set of handlers
// with their own exact live-worker capability checks are admitted without it.
// The two write-link handlers retain their historical local check for unit-test
// compatibility; production requests arrive pre-authorized and are marked in
// trustedHostRequests so the one-shot nonce is not consumed twice.
let injectedIpcSecret: string | null = null;
/** Test seam: override the secret used to verify token-route HMAC. */
export function setIpcAuthSecret(secret: string | null): void { injectedIpcSecret = secret; }
let loggedUnsafeIpcSecretAt = 0;
/**
 * Load the machine-local dashboard secret used to verify token-route HMAC.
 *
 * Goes through {@link loadDashboardSecret} — the same strict host-authority
 * reader the dashboard and daemon startup use — instead of a bare
 * `readFileSync`: the leaf must be a regular 0600 file owned by the current
 * user and must NOT be a symlink, and `~/.botmux` must not be
 * group/other-writable. This is a per-request verifier on ~96 daemon IPC routes,
 * so an attacker who can plant a symlink or loose-perms `.dashboard-secret` after
 * boot must not have that content trusted as the HMAC key here (the dashboard
 * caches its secret once at startup; this path re-reads every request, so it is
 * the more exposed reader).
 *
 * Fail-closed either way: an unsafe shape returns `null` (→ nobody can sign →
 * 401) rather than being followed. We log it — throttled, since this runs per
 * request — so a planted/misconfigured credential is diagnosable instead of
 * looking identical to "no secret on disk".
 */
function ipcAuthSecret(): string | null {
  if (injectedIpcSecret) return injectedIpcSecret;
  try {
    return loadDashboardSecret(dashboardSecretPath());
  } catch (err) {
    if (err instanceof UnsafeHostAuthorityFileError) {
      const now = Date.now();
      if (now - loggedUnsafeIpcSecretAt > 60_000) {
        loggedUnsafeIpcSecretAt = now;
        logger.error(`[dashboard-ipc] 拒绝使用不安全的 .dashboard-secret：${err.message}（IPC 鉴权 fail-closed）`);
      }
      return null;
    }
    return null;
  }
}
/** Authenticate legacy terminal-token routes with the machine-local dashboard
 * secret. Workflow v3 mutations intentionally use their separate, full-request
 * protocol (`workflows/v3/daemon-ipc-auth`) and must never call this bare
 * ts:nonce verifier. */
export function ipcHmacAuthorized(req: IncomingMessage, bind?: string): boolean {
  if (trustedHostRequests.has(req)) return true;
  const secret = ipcAuthSecret();
  if (!secret) return false; // fail-closed: no secret on disk → nobody can sign
  const ts = req.headers['x-botmux-cli-ts'];
  const nonce = req.headers['x-botmux-cli-nonce'];
  const sig = req.headers['x-botmux-cli-auth'];
  if (typeof ts !== 'string' || typeof nonce !== 'string' || typeof sig !== 'string') return false;
  return verifyHmac(secret, { ts, nonce, sig }, req.socket.remoteAddress ?? '', bind).ok;
}

function tokenRouteAuthorized(req: IncomingMessage, bind?: string): boolean {
  return ipcHmacAuthorized(req, bind);
}

function routeHasPublicAccess(method: string, pathname: string): boolean {
  // Liveness contains no data and performs no mutation. /healthz is the
  // core-only public alias of /__health (riff's sandbox launcher polls it).
  return method === 'GET' && (pathname === '/__health' || pathname === '/healthz');
}

/**
 * Core-only ONLY: the exact riff-facing routes that bypass the trusted-host HMAC
 * when the daemon runs headless in riff's sandbox. Everything else STILL requires
 * the HMAC (codex P1: authRequired:false opened all 96 IPC routes — a co-resident
 * model turn could read/perturb sessions, scheduler, mutations). This is a tight
 * allowlist of drive-my-own-turn + poll-my-own-output surfaces:
 *   POST /api/trigger                              (start a turn)
 *   GET  /api/sessions/:id/trigger-result          (poll final)
 *   GET  /api/sessions/:id/insight                 (poll conversation/progress)
 * `/api/asks/answer` is deliberately EXCLUDED — it is askId-keyed with no
 * session/turn binding, so exposing it would let any co-resident turn hijack
 * another pending ask (codex). riff's async main-link needs no awaiting_input;
 * a future clarify path must be a sessionId+interaction-bound endpoint.
 */
function routeIsCoreOnlyPublic(method: string, pathname: string): boolean {
  if (method === 'POST' && pathname === '/api/trigger') return true;
  if (method === 'GET') {
    return /^\/api\/sessions\/[^/]+\/trigger-result$/.test(pathname)
      || /^\/api\/sessions\/[^/]+\/insight$/.test(pathname);
  }
  return false;
}

function routeHasNarrowUntrustedAuth(method: string, pathname: string): boolean {
  // The receiver action endpoint performs its own rotating worker-capability
  // verification and then enters the durable action ledger. Keeping this one
  // aperture is what preserves managed meeting actions from inside bwrap.
  if (method === 'POST' && pathname === '/api/vc-meetings/action-request') return true;
  // These two CLI-in-sandbox endpoints verify the same rotating capability in
  // their handlers and bind it to body.sessionId. They cannot be bare loopback
  // exceptions: a receiver that learned another session id could otherwise
  // forge readiness or an ask for that session.
  if (method === 'POST' && pathname === '/api/session-ready') return true;
  if (method === 'POST' && pathname === '/api/asks') return true;
  // botmux slash / botmux role switch（角色切换）/ botmux delete（关闭自身）：合法调用方
  // 是会话内的 CLI 自身，沙箱 / 读隔离下读不到 host secret。handler 内验证
  // 该会话的 rotating per-turn
  // capability 并绑定到 URL 里的 sessionId（同 /api/asks 姿势）——capability 只
  // 证明「我是这个会话当前这一轮的 CLI」，选不了别的会话。
  if (method === 'POST' && /^\/api\/sessions\/[^/]+\/(?:slash|cd|close|preview|chat-rename)$/.test(pathname)) return true;
  // UserPromptSubmit hook 的 envelope claim：沙箱内 hook 读不到 host secret，
  // 走 body 里的 per-turn capability；handler 内 sessionCliIpcAuth 绑定到 URL 的
  // sessionId + 按 managedTurnOrigin.turnId 权威取（同 /close 姿势）。
  if (method === 'POST' && /^\/api\/sessions\/[^/]+\/prompt-ctx\/claim$/.test(pathname)) return true;
  if (method === 'POST' && pathname === '/api/hooks/emit') return true;
  if (method === 'POST' && pathname === '/api/attention') return true;
  // A sandboxed report cannot read the host HMAC secret. This narrow route
  // validates the current session's rotating capability, binds the dispatch
  // root server-side, then lets the trusted daemon relay to the orchestrator.
  if (method === 'POST' && pathname === REPORT_SESSION_RELAY_ROUTE) return true;
  if (method === 'POST' && pathname === DISPATCH_REPORT_REGISTER_ROUTE) return true;
  // macOS read-isolated `botmux send` presents a rotating worker capability;
  // the handler writes the authoritative tuple into a host-owned read-only
  // proof sidecar, so loopback response spoofing cannot confer authority.
  if (method === 'POST' && pathname === MANAGED_ORIGIN_ATTEST_ROUTE) return true;
  // The daemon authenticates this route from the live loopback peer process
  // and its private worker IPC state. It intentionally accepts no file/env
  // capability because those are writable by an unconfined same-UID Agent.
  if (method === 'POST' && pathname === CURRENT_ACTOR_ROUTE) return true;
  // Goal commands are issued by the active L1/L2/worker CLI itself. Their
  // handlers bind the request to that exact live session via the rotating
  // origin capability before accepting any caller-selectable coordinates.
  if (method === 'POST' && pathname === '/api/goal/supervise') return true;
  if (method === 'POST' && pathname === '/api/goal/notify-parent') return true;
  if (method === 'POST' && pathname === '/api/goal/watchdog') return true;
  if (method === 'POST' && pathname === '/api/goal/release-check') return true;
  if (method === 'POST' && pathname === '/api/goal/release-action') return true;
  // Workflow v3 mutations carry their own domain-separated full-envelope
  // protocol (request signature over method/path/exact body with nonce
  // anti-replay + boot audience, signed response), keyed on the same host
  // secret as the outer gate. The handler fail-closes on that envelope, which
  // is strictly stronger binding than the outer ts:nonce HMAC, so the prefix
  // is admitted here instead of being double-signed with the same secret.
  if (method === 'POST' && pathname.startsWith(`${WORKFLOW_DAEMON_IPC_ROUTE_PREFIX}/`)) return true;
  // Workflow v3 session relay: sandboxed / read-isolated chat CLIs cannot read
  // the host secret, so these handlers verify the session's rotating per-turn
  // capability and re-derive the caller tuple from the daemon's own live
  // session record (same posture as /api/asks above).
  if (method === 'POST' && pathname.startsWith(`${V3_SESSION_RUN_MUTATION_ROUTE_PREFIX}/`)) return true;
  return false;
}

function trustedHostAuthorized(
  req: IncomingMessage,
  pathname: string,
  port: number,
  secret: string,
): { ok: true } | { ok: false; reason: string } {
  const ts = req.headers['x-botmux-cli-ts'];
  const nonce = req.headers['x-botmux-cli-nonce'];
  const sig = req.headers['x-botmux-cli-auth'];
  if (typeof ts !== 'string' || typeof nonce !== 'string' || typeof sig !== 'string') {
    return { ok: false, reason: 'missing_headers' };
  }
  const bind = cliAuthBind(req.method ?? 'GET', pathname, port);
  const verified = verifyHmac(
    secret,
    { ts, nonce, sig },
    req.socket.remoteAddress ?? '',
    bind,
  );
  return verified.ok
    ? { ok: true }
    : { ok: false, reason: verified.reason ?? 'unauthorized' };
}

ipcRoute('GET', '/__health', (_req, res) => {
  jsonRes(res, 200, { ok: true });
});
// Core-only readiness barrier (codex P1-3): the daemon binds its HTTP port BEFORE
// restoreActiveSessions / v3 cold-attach / scheduler finish, so a launcher that
// triggers the instant the port answers would race durable restore (transient
// not_found / re-fire). /healthz returns 503 until the daemon marks itself ready
// (setCoreOnlyReady, called AFTER restore in daemon.ts). Non-core-only daemons
// never set this gate, so /healthz stays an unconditional 200 there.
let coreOnlyReadinessGate = false; // true only in core-only, until ready
let coreOnlyReady = false;
export function armCoreOnlyReadinessGate(): void { coreOnlyReadinessGate = true; }
export function setCoreOnlyReady(): void { coreOnlyReady = true; }
/** @internal test-only: reset the core-only readiness gate between cases. */
export function __testOnly_resetCoreOnlyReadiness(): void { coreOnlyReadinessGate = false; coreOnlyReady = false; }
/** True when the readiness gate is armed (core-only) but restore hasn't finished.
 *  The server-level gate returns 503 for the public control routes in this state,
 *  and /healthz reports 'starting' — a barrier so riff can't trigger into a racing
 *  durable restore even if it skips the healthz probe (codex P1). */
function coreOnlyNotReady(): boolean { return coreOnlyReadinessGate && !coreOnlyReady; }
// Public alias for core-only: riff's sandbox launcher polls GET /healthz to know
// the service is FULLY up (bound AND restore-complete). 200 {ok:true} once ready;
// 503 {ok:false,status:'starting'} while the readiness gate is armed but not ready.
ipcRoute('GET', '/healthz', (_req, res) => {
  if (coreOnlyNotReady()) {
    return jsonRes(res, 503, { ok: false, status: 'starting' });
  }
  jsonRes(res, 200, { ok: true });
});

const MANAGED_ORIGIN_ATTEST_BODY_MAX_BYTES = 2 * 1024;
const MANAGED_ORIGIN_ATTEST_BODY_TIMEOUT_MS = 1_000;
const MANAGED_ORIGIN_ATTEST_MAX_PREAUTH_IN_FLIGHT = 128;
const MANAGED_ORIGIN_ATTEST_MAX_OUTSTANDING_PER_SESSION = 64;
const managedOriginOutstandingProofs = new Map<string, number>();
let managedOriginPreauthInFlight = 0;

async function handleManagedOriginAttestation(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  let body: {
    sessionId?: unknown;
    originChannelId?: unknown;
    channelId?: unknown;
    originCapability?: unknown;
    nonce?: unknown;
  };
  try {
    body = await readBoundedJsonBody(
      req,
      MANAGED_ORIGIN_ATTEST_BODY_MAX_BYTES,
      MANAGED_ORIGIN_ATTEST_BODY_TIMEOUT_MS,
    );
  }
  catch (err) {
    if (err instanceof IpcBodyTooLargeError || err instanceof IpcBodyTimeoutError) {
      closeUntrustedRequestAfterResponse(req, res);
    }
    return jsonRes(
      res,
      err instanceof IpcBodyTooLargeError
        ? 413
        : err instanceof IpcBodyTimeoutError
          ? 408
          : 400,
      {
        ok: false,
        error: err instanceof IpcBodyTooLargeError
          ? 'body_too_large'
          : err instanceof IpcBodyTimeoutError
            ? 'body_timeout'
            : 'bad_json',
      },
    );
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return jsonRes(res, 400, { ok: false, error: 'bad_attestation_request' });
  }
  const sessionId = typeof body.sessionId === 'string' && body.sessionId.length <= 256
    ? body.sessionId
    : '';
  const capability = typeof body.originCapability === 'string'
    && /^[a-f0-9]{32,128}$/i.test(body.originCapability)
    ? body.originCapability
    : '';
  const channelId = typeof (body.originChannelId ?? body.channelId) === 'string'
    && /^[a-f0-9]{64}$/.test((body.originChannelId ?? body.channelId) as string)
    ? (body.originChannelId ?? body.channelId) as string
    : '';
  const nonce = typeof body.nonce === 'string' && /^[a-f0-9]{64}$/.test(body.nonce)
    ? body.nonce
    : '';
  if (!sessionId || !channelId || !capability || !nonce) {
    return jsonRes(res, 400, { ok: false, error: 'bad_attestation_request' });
  }
  const ds = findActiveBySessionId(sessionId);
  const worker = ds?.worker;
  let workerPidLive = false;
  if (worker && Number.isSafeInteger(worker.pid) && (worker.pid ?? 0) > 0) {
    try {
      process.kill(worker.pid!, 0);
      workerPidLive = true;
    } catch { /* ESRCH/EPERM/invalid pid all fail closed */ }
  }
  const workerLive = !!worker
    && worker.connected === true
    && !worker.killed
    && worker.exitCode === null
    && worker.signalCode === null
    && workerPidLive;
  const liveTurnId = ds?.managedTurnOrigin?.turnId;
  const verified = authorizeSessionScopedIpc({
    trustedHost: false,
    sessionExists: !!ds,
    receiverSession: !!ds?.session.vcMeetingReceiver,
    allowReceiver: true,
    sessionId,
    liveOrigin: ds?.managedTurnOrigin,
    claimedCapability: capability,
  });
  if (!verified.ok || !ds?.managedTurnOrigin || !liveTurnId || !workerLive) {
    return jsonRes(res, 403, { ok: false, error: 'origin_unproven' });
  }
  const origin = ds.managedTurnOrigin;
  if (!origin.originChannelId || !/^[a-f0-9]{64}$/.test(origin.originChannelId)) {
    return jsonRes(res, 403, { ok: false, error: 'origin_channel_unproven' });
  }
  if (channelId !== origin.originChannelId) {
    return jsonRes(res, 403, { ok: false, error: 'origin_channel_unproven' });
  }
  const codexDecision = validateCodexAppManagedSendOrigin(
    ds.session.codexAppDispatchLedger,
    origin,
    ds.initConfig?.cliId === 'codex-app' || ds.session.cliId === 'codex-app',
  );
  if (!codexDecision.ok) {
    return jsonRes(res, 409, { ok: false, error: 'origin_not_sendable' });
  }
  const outstanding = managedOriginOutstandingProofs.get(sessionId) ?? 0;
  if (outstanding >= MANAGED_ORIGIN_ATTEST_MAX_OUTSTANDING_PER_SESSION) {
    return jsonRes(res, 429, { ok: false, error: 'too_many_attestations' });
  }
  let proofPath: string;
  try {
    proofPath = writeManagedOriginAttestationProof({
      dataDir: config.session.dataDir,
      proof: {
        domain: MANAGED_ORIGIN_PROOF_DOMAIN,
        version: 1,
        nonce,
        channelId: origin.originChannelId,
        sessionId,
        turnId: liveTurnId,
        ...(origin.dispatchAttempt !== undefined
          ? { dispatchAttempt: origin.dispatchAttempt }
          : {}),
        requiresCodexAppLedger: codexDecision.requiresLedger,
        issuedAtMs: Date.now(),
      },
    });
  } catch (err) {
    logger.warn(`[managed-origin] could not write attestation proof: ${err}`);
    return jsonRes(res, 409, { ok: false, error: 'proof_unavailable' });
  }
  managedOriginOutstandingProofs.set(sessionId, outstanding + 1);
  const cleanupTimer = setTimeout(() => {
    try { unlinkSync(proofPath); } catch { /* expired/already gone */ }
    const remaining = (managedOriginOutstandingProofs.get(sessionId) ?? 1) - 1;
    if (remaining > 0) managedOriginOutstandingProofs.set(sessionId, remaining);
    else managedOriginOutstandingProofs.delete(sessionId);
  }, MANAGED_ORIGIN_PROOF_TTL_MS + 1_000);
  cleanupTimer.unref?.();
  return jsonRes(res, 200, { ok: true });
}

ipcRoute('POST', MANAGED_ORIGIN_ATTEST_ROUTE, async (req, res) => {
  // This counter is acquired before parsing or capability lookup.  Per-session
  // proof quotas cannot protect the unauthenticated slow-body phase because a
  // session id is not trustworthy until the complete request has been read.
  if (managedOriginPreauthInFlight >= MANAGED_ORIGIN_ATTEST_MAX_PREAUTH_IN_FLIGHT) {
    closeUntrustedRequestAfterResponse(req, res);
    return jsonRes(res, 429, { ok: false, error: 'too_many_attestation_requests' });
  }
  managedOriginPreauthInFlight += 1;
  try {
    await handleManagedOriginAttestation(req, res);
  } finally {
    managedOriginPreauthInFlight -= 1;
  }
});

ipcRoute('POST', CURRENT_ACTOR_ROUTE, async (req, res) => {
  let body: { sessionId?: unknown };
  try {
    body = await readBoundedJsonBody(req, 1_024, 1_000);
  } catch (err) {
    if (err instanceof IpcBodyTooLargeError || err instanceof IpcBodyTimeoutError) {
      closeUntrustedRequestAfterResponse(req, res);
    }
    return jsonRes(res, err instanceof IpcBodyTooLargeError ? 413 : 400, {
      schema: 'botmux.current-actor.v2',
      status: 'blocked',
      error: 'current_actor_unverified',
    });
  }
  const sessionId = typeof body.sessionId === 'string' && body.sessionId.length <= 256
    ? body.sessionId
    : '';
  const peer = resolveLoopbackPeerProcesses({
    remoteAddress: req.socket.remoteAddress,
    remotePort: req.socket.remotePort,
    localPort: req.socket.localPort,
  });
  if (!sessionId || !peer.ok) {
    return jsonRes(res, 403, {
      schema: 'botmux.current-actor.v2',
      status: 'blocked',
      error: 'current_actor_unverified',
    });
  }
  const result = await resolveDaemonCurrentActor({
    sessionId,
    peer: peer.peer,
    findSession: findActiveBySessionId,
  });
  return result.ok
    ? jsonRes(res, 200, result.document)
    : jsonRes(res, 403, {
        schema: 'botmux.current-actor.v2',
        status: 'blocked',
        error: result.error,
      });
});

// ─── Session list / detail ─────────────────────────────────────────────────
// Row shape + composers live in dashboard-rows.ts so worker-pool can publish
// SessionRow events without importing this module (which would create a cycle:
// worker-pool → dashboard-ipc-server → worker-pool).

export type { SessionRow };
export { composeRowFromActive, composeRowFromClosed, composeRowFromPersistedActive };

// Re-export setBotName for backwards-compatible imports (daemon.ts).  Both
// callers (this module's cachedBotName + dashboard-rows' cachedBotName) need
// to be primed; here we forward to the rows module which is the canonical
// holder.
export function setBotName(name: string): void { setRowsBotName(name); }

function composeDashboardSessionRows(): SessionRow[] {
  const active = listActiveSessions().map((ds) => composeRowFromActive(ds));
  const activeIds = new Set(active.map(row => row.sessionId));
  const persisted = sessionStore.listSessions();
  const unregisteredActive = persisted
    .filter(session => session.status === 'active' && !activeIds.has(session.sessionId))
    .map(composeRowFromPersistedActive);
  const closed = persisted
    .filter(session => session.status === 'closed' && !activeIds.has(session.sessionId))
    .map(composeRowFromClosed);
  return [...active, ...unregisteredActive, ...closed];
}

// The daemon's own larkAppId, primed at startup. Required for the groups
// endpoints below which proxy calls into groups-store on this bot's behalf.
let cachedLarkAppId = '';
export function setLarkAppId(id: string): void { cachedLarkAppId = id; }

async function handleDeviceIsolationActivationRoute(
  req: IncomingMessage,
  res: ServerResponse,
  handler: (body: unknown) => DeviceIsolationDaemonResult | Promise<DeviceIsolationDaemonResult>,
): Promise<void> {
  // Keep this explicit even though production enables the server-wide gate:
  // unit-test/dev servers must not accidentally turn this authority-bearing
  // transition into a bare-loopback endpoint.
  if (!ipcHmacAuthorized(req)) {
    return jsonRes(res, 401, { ok: false, error: 'unauthorized' });
  }
  try {
    const body = await readJsonBody(req);
    const result = await handler(body);
    jsonRes(res, result.status, result.body);
  } catch (error) {
    logDeviceIsolationActivationError(error);
    jsonRes(res, 503, { ok: false, error: 'activation_unavailable' });
  }
}

ipcRoute('POST', DEVICE_ISOLATION_PREPARE_PATH, (req, res) =>
  handleDeviceIsolationActivationRoute(req, res, prepareDeviceIsolationActivation));
ipcRoute('POST', DEVICE_ISOLATION_COMMIT_PATH, (req, res) =>
  handleDeviceIsolationActivationRoute(req, res, commitDeviceIsolationActivation));
ipcRoute('POST', DEVICE_ISOLATION_RELEASE_PATH, (req, res) =>
  handleDeviceIsolationActivationRoute(req, res, releaseDeviceIsolationActivation));

// ─── Pending asks (trusted Desktop/dashboard operator only) ─────────────────

ipcRoute('GET', '/api/asks/pending', (req, res) => {
  if (!isTrustedHostIpcRequest(req)) {
    return jsonRes(res, 403, { ok: false, error: 'trusted_host_required' });
  }
  const asks = listPendingAsks().map((ask) => ({
    askId: ask.askId,
    sessionId: ask.sessionId,
    larkAppId: ask.larkAppId,
    chatId: ask.chatId,
    rootMessageId: ask.rootMessageId,
    questions: ask.questions,
    deadlineAt: ask.deadlineAt,
    createdAt: ask.createdAt,
  }));
  return jsonRes(res, 200, { asks });
});

ipcRoute('POST', '/api/asks/answer', async (req, res) => {
  if (!isTrustedHostIpcRequest(req)) {
    return jsonRes(res, 403, { ok: false, error: 'trusted_host_required' });
  }
  let body: { askId?: string; selections?: string[][]; by?: string };
  try {
    body = await readJsonBody(req);
  } catch {
    return jsonRes(res, 400, { ok: false, error: 'bad_json' });
  }
  if (!body.askId || !Array.isArray(body.selections)) {
    return jsonRes(res, 400, { ok: false, error: 'askId_and_selections_required' });
  }
  const outcome = submitAskFromDesktop({
    askId: body.askId,
    selections: body.selections,
    by: typeof body.by === 'string' ? body.by : 'desktop',
  });
  if (outcome !== 'accepted') {
    return jsonRes(res, 409, { ok: false, error: outcome });
  }
  return jsonRes(res, 200, { ok: true, outcome });
});

ipcRoute('GET', '/api/sessions', (_req, res) => {
  // Runtime active first, then persisted active rows that restore deliberately
  // left detached, then closed history. Persisted-active must never be projected
  // through composeRowFromClosed: teardown uncertainty is not a close.
  jsonRes(res, 200, { sessions: composeDashboardSessionRows() });
});

ipcRoute('GET', '/api/sessions/:sessionId', (_req, res, params) => {
  const ds = findActiveBySessionId(params.sessionId);
  if (ds) return jsonRes(res, 200, { session: composeRowFromActive(ds) });
  const persisted = sessionStore.listSessions().find(s => s.sessionId === params.sessionId);
  if (persisted) {
    return jsonRes(res, 200, {
      session: persisted.status === 'active'
        ? composeRowFromPersistedActive(persisted)
        : composeRowFromClosed(persisted),
    });
  }
  jsonRes(res, 404, { error: 'not_found' });
});

/** Low-frequency card-display read used by `botmux send`. Keeping the
 * transcript reader and per-bot visibility decision in the resident daemon
 * preserves its incremental cache and live config instead of making every
 * short-lived CLI process rescan the Session or guess from sandboxed files. */
ipcRoute('GET', '/api/sessions/:sessionId/usage', (_req, res, params) => {
  const ds = findActiveBySessionId(params.sessionId);
  if (!ds) return jsonRes(res, 404, { error: 'not_found' });
  jsonRes(res, 200, { usage: getDaemonReplyCardUsageSnapshot(ds) });
});

/** Canonical daemon-side close used by the dashboard and `botmux delete`.
 *  Host callers authenticate with HMAC; a read-isolated CLI may close only its
 *  exact live session with the rotating per-turn capability. */
ipcRoute('POST', '/api/sessions/:sessionId/close', async (req, res, params) => {
  const body = await readJsonBody<Record<string, unknown>>(req)
    .catch(() => ({} as Record<string, unknown>));
  const ds = findActiveBySessionId(params.sessionId);
  const auth = sessionCliIpcAuth(req, ds, params.sessionId, body);
  if (!auth.ok) return jsonRes(res, 403, { ok: false, error: auth.error });
  const initial = findSessionRecord(params.sessionId);
  // Resolve the owning bot for the FIFO-drain gate from the live DaemonSession
  // first (it carries larkAppId even before a persisted record exists), then the
  // stored row, then this daemon's own identity. A trusted-host close of an
  // already-missing session has no owner to key the gate on, so close directly:
  // closeSession is idempotent and reports alreadyClosed.
  const larkAppId = ds?.larkAppId || initial?.larkAppId || cachedLarkAppId;
  if (!larkAppId) {
    const r = await closeSession(params.sessionId);
    return jsonRes(res, r.ok ? 200 : 502, r);
  }
  return withBotTurnMutation(larkAppId, async () => {
    // Re-resolve only after every earlier admitted turn has drained. Explicit
    // close is the abandon boundary and may clear accepted FIFO, but it must
    // never clear a stale pre-drain snapshot while a turn is still preparing.
    const current = findSessionRecord(params.sessionId);
    if (current && current.status === 'closed') {
      // A closed row can still carry an UNCANCELLED remote session (a quarantined
      // lineage is parked, not cancelled). Short-circuiting to a bare success here
      // meant a retry — or any client that lost the first response — could never
      // learn about it, so replay the same outcome the close itself would report.
      const residual = mojoCloseResidualForRow(current);
      return jsonRes(res, 200, residual
        ? { ok: true, outcome: 'closed_with_residual', residual, alreadyClosed: true }
        : { ok: true, outcome: 'closed', alreadyClosed: true });
    }
    const r = await closeSession(params.sessionId);
    jsonRes(res, r.ok ? 200 : 502, r);
  });
});

/**
 * Host-side atomic claim/pop for the UserPromptSubmit hook（#794 方向 B）。
 *
 * 沙箱内的 `botmux user-prompt-hook` 不能在 read-only 的 `prompt-ctx/<sid>` 里
 * unlink（HIGH-2），同正文多轮也不能靠 FIFO 猜（HIGH-1：某轮漏 claim 会串轮到
 * 后续轮）。hook 把 (session 凭据 + fingerprint) 提交到这里，宿主按
 * **managedTurnOrigin.turnId 权威 turn 绑定**精确取该轮的 envelope，先删再返回。
 * 漏 claim 只孤儿化自己那条，不污染后续轮；上一轮的 stale sidecar 永远不会被返回。
 *
 * 鉴权与 /close、/slash 同构：trusted-host HMAC，或本会话 rotating per-turn
 * capability（沙箱内读 host secret 失败时的回退）。任何未命中/失败 → 404/403，
 * hook 端空输出 exit 0（fail-open：reminder 丢失 < 卡住 prompt）。
 */
ipcRoute('POST', '/api/sessions/:sessionId/prompt-ctx/claim', async (req, res, params) => {
  const body = await readJsonBody<{
    fingerprint?: unknown;
    prefix?: unknown;
  } & Record<string, unknown>>(req).catch(() => ({}) as {
    fingerprint?: unknown;
    prefix?: unknown;
  } & Record<string, unknown>);
  const ds = findActiveBySessionId(params.sessionId);
  // claim 只读 daemon 自有本轮非凭证上下文（reminder/whiteboard），receiver 会话
  // 也允许（allowReceiver: true）；close/slash/cd 等 managed action 仍默认拒绝。
  const auth = sessionCliIpcAuth(req, ds, params.sessionId, body, { allowReceiver: true });
  if (!auth.ok) return jsonRes(res, 403, { ok: false, error: auth.error });
  const fingerprint = typeof body?.fingerprint === 'string' ? body.fingerprint : '';
  if (!/^[a-f0-9]{64}$/.test(fingerprint)) {
    return jsonRes(res, 400, { ok: false, error: 'invalid_fingerprint' });
  }
  // 权威 turnId：daemon 当前这轮的 turnId（worker 发布的 managed_turn_origin）。
  // hook 不需要、也不应自己提供 turnId——daemon 只认自己的权威值，避免 FIFO 串轮。
  const turnId = ds?.managedTurnOrigin?.turnId;
  if (!turnId) return jsonRes(res, 404, { ok: false, error: 'no_active_turn' });
  const prefix = typeof body?.prefix === 'string' && body.prefix.length > 0
    ? body.prefix.slice(0, 64)
    : undefined;
  const envelope = claimPromptContext(params.sessionId, turnId, fingerprint, prefix);
  if (!envelope) return jsonRes(res, 404, { ok: false, error: 'not_found' });
  jsonRes(res, 200, { ok: true, envelope });
});

// `botmux list` zombie pruning is maintenance, not explicit abandon. Serialize
// against inbound admission and refuse if any backend-neutral durable owner
// became unsettled after the CLI took its liveness snapshot.
ipcRoute('POST', '/api/sessions/:sessionId/prune', async (_req, res, params) => {
  const initial = findSessionRecord(params.sessionId);
  if (!initial) return jsonRes(res, 404, { ok: false, error: 'session_not_found' });
  const larkAppId = initial.larkAppId || cachedLarkAppId;
  if (!larkAppId) return jsonRes(res, 503, { ok: false, error: 'bot_not_found' });
  return withBotTurnMutation(larkAppId, async () => {
    const current = findSessionRecord(params.sessionId);
    if (!current) return jsonRes(res, 404, { ok: false, error: 'session_not_found' });
    if (rejectProtectedSessionMutation(res, [current])) return;
    const r = await closeSession(params.sessionId);
    jsonRes(res, r.ok ? 200 : 502, r);
  });
});

// Close THIS daemon's chat-scope sessions bound to a goal chat. The goal-cleanup
// card button fans this out to every online daemon, because each bot's workers
// live in their own daemon process — a card-owner-local loop (the old behavior)
// left cross-bot workers orphaned. Idempotent: re-running just closes nothing.
ipcRoute('POST', '/api/goal/:goalChatId/cleanup-local', async (_req, res, params) => {
  const goalChatId = params.goalChatId;
  if (!goalChatId) return jsonRes(res, 400, {
    closed: 0,
    residual: 0,
    failed: 0,
    error: 'missing_goal_chat',
  });
  const targets = listActiveSessions().filter(s => s.chatId === goalChatId && s.scope === 'chat');
  let closed = 0;
  let residual = 0;
  let failed = 0;
  for (const ds of targets) {
    try {
      const result = await closeSession(ds.session.sessionId);
      if (!result.ok) {
        failed++;
        logger.warn(
          `[goal-cleanup-local] close ${ds.session.sessionId} refused: ${result.error}`
          + (result.taskId ? ` (remote ${result.taskId})` : ''),
        );
        continue;
      }
      closed++;
      if (result.outcome === 'closed_with_residual') {
        residual++;
        logger.warn(
          `[goal-cleanup-local] close ${ds.session.sessionId} left residual: ${result.residual.reason}`
          + (result.residual.taskId ? ` (remote ${result.residual.taskId})` : ''),
        );
      }
    } catch (err) {
      failed++;
      logger.warn(`[goal-cleanup-local] close ${ds.session.sessionId} failed: ${err}`);
    }
  }
  if (closed > 0 || failed > 0) {
    logger.info(
      `[goal-cleanup-local] closed ${closed} chat-scope sessions for goal=${goalChatId}; `
      + `residual=${residual}; failed=${failed}`,
    );
  }
  jsonRes(res, failed > 0 ? 502 : 200, { closed, residual, failed });
});

/** Post a scope-aware "restarting" notice into the session's Lark thread/chat,
 *  mirroring the /resume route — so a Feishu-side observer sees why the CLI just
 *  restarted under them (the IM `/restart` command and the card button notify
 *  too; the dashboard was the lone silent path). `fresh` = the worker was gone
 *  and we re-forked it (revive) rather than doing an in-place CLI restart.
 *  Best-effort and fire-and-forget; never blocks the HTTP response. */
function postRestartNotice(ds: DaemonSession, fresh: boolean): void {
  if (!ds.larkAppId) return;
  // No-transport session (apiOnly bot or HTTP virtual chat) has no Feishu chat
  // to post a restart notice into — skip (the raw sendMessage/replyMessage below
  // bypass sessionReply's gate). Best-effort path; a silent skip is correct.
  if (!larkTransportEnabled({ chatId: ds.chatId, apiOnly: getBot(ds.larkAppId).config.apiOnly })) return;
  const loc = localeForBot(ds.larkAppId);
  const botCfg = getBot(ds.larkAppId).config;
  const cliName = sessionConfiguredRuntimeDisplayName(ds.session, botCfg.cliRuntime)
    ?? getCliDisplayName(ds.session.cliId ?? botCfg.cliId ?? 'claude-code');
  const text = fresh
    ? t('card.action.restarted_fresh', { cliName }, loc)
    : t('cmd.restart.in_progress', { cliName }, loc);
  const notice = JSON.stringify({ text });
  if (ds.scope === 'chat' && ds.chatId) {
    getChatMode(ds.larkAppId, ds.chatId, { forceRefresh: true })
      .then((mode) => mode === 'topic' && ds.session.rootMessageId
        ? replyMessage(ds.larkAppId, ds.session.rootMessageId, notice, 'text', true)
        : sendMessage(ds.larkAppId, ds.chatId, notice, 'text'))
      .catch(err => logger.debug(`[restart] failed to post chat-scope restart notice: ${err}`));
  } else if (ds.session.rootMessageId) {
    replyMessage(ds.larkAppId, ds.session.rootMessageId, notice, 'text', true)
      .catch(err => logger.debug(`[restart] failed to post thread-scope restart notice: ${err}`));
  }
}

ipcRoute('POST', '/api/sessions/:sessionId/restart', async (_req, res, params) => {
  const initial = findActiveBySessionId(params.sessionId);
  if (!initial) return jsonRes(res, 404, { ok: false, error: 'session_not_active' });
  return withBotTurnMutation(initial.larkAppId, () => {
  const ds = findActiveBySessionId(params.sessionId);
  if (!ds) return jsonRes(res, 404, { ok: false, error: 'session_not_active' });
  if (isSessionTransferring(ds)) {
    return jsonRes(res, 409, { ok: false, error: 'session_transferring' });
  }
  // Adopt/observed sessions: botmux never owned the CLI — restarting would kill
  // the user's real tmux/zellij pane. Hard-reject (the worker self-guards too).
  if (ds.adoptedFrom || ds.initConfig?.adoptMode) {
    return jsonRes(res, 409, { ok: false, error: 'adopt_restart_unsupported' });
  }
  // Every REMOTE backend owns a remote lineage that destroy + respawn would
  // sever or replace (for mojo the worker restart actively cancels the remote
  // session and cold-boots a context-less replacement). Reject at the daemon
  // boundary so the dashboard never reports HTTP 200 for a lineage-destroying
  // restart.
  if (isRemoteBackendSession(ds)) {
    return jsonRes(res, 409, {
      ok: false,
      error: 'remote_restart_unsupported',
      message: t('cmd.restart.remote_unsupported', undefined, localeForBot(ds.larkAppId)),
    });
  }
  if (rejectProtectedSessionMutation(res, [ds])) return;
  const cliId = ds.session.cliId ?? 'unknown';
  if (ds.worker && !ds.worker.killed) {
    // Live worker → in-place CLI restart (kills the CLI, respawns with --resume).
    // 捎带最新 per-bot env：dashboard 改完 env 后重启才真正生效（与 /restart 同逻辑）。
    try {
      ds.workerReady = false;
      ds.worker.send({ type: 'restart', reason: 'operator', env: latestPerBotEnvForRestart(ds), model: latestModelForRespawn(ds) } as DaemonToWorker);
    } catch (err) {
      return jsonRes(res, 502, { ok: false, error: String(err) });
    }
    postRestartNotice(ds, false);
    return jsonRes(res, 200, { ok: true, sessionId: params.sessionId, cliId, revived: false });
  }
  // Worker is gone but the session is still active — idle-suspended (over the
  // per-bot cap), lazy-restored after a daemon restart, or crash-loop-stopped.
  // Revive it the same way the Feishu card restart does (forkWorker), so the
  // dashboard isn't a dead-end: a 409 here would leave NO working control to
  // bring the CLI back (the resume button only shows for closed sessions).
  forkWorker(ds, '', ds.hasHistory);
  postRestartNotice(ds, true);
  jsonRes(res, 200, { ok: true, sessionId: params.sessionId, cliId, revived: true });
  });
});

/** Materialize a dormant active session for a local `botmux list` attach.
 * Unlike restart, this is idempotent when a live worker already exists: a Lark
 * message may race the local picker, and that race must never restart an active
 * turn. Empty input re-attaches/cold-resumes without creating a model turn. */
ipcRoute('POST', '/api/sessions/:sessionId/wake', async (req, res, params) => {
  const initial = findActiveBySessionId(params.sessionId);
  if (!initial) return jsonRes(res, 404, { ok: false, error: 'session_not_active' });
  const acquireTimeoutMs = sessionWakeAcquireTimeoutMs(
    req.headers[SESSION_WAKE_DEADLINE_HEADER],
  );
  const mutation = await tryWithBotTurnMutation(initial.larkAppId, acquireTimeoutMs, () => {
    // A picker that exits aborts its fetch. If the request was queued behind an
    // admitted turn, never materialize the session after that caller is gone.
    if (req.aborted || res.destroyed) return;
    const ds = findActiveBySessionId(params.sessionId);
    if (!ds) return jsonRes(res, 404, { ok: false, error: 'session_not_active' });
    if (isSessionTransferring(ds)) {
      return jsonRes(res, 409, { ok: false, error: 'session_transferring' });
    }
    if (ds.adoptedFrom || ds.initConfig?.adoptMode) {
      return jsonRes(res, 409, { ok: false, error: 'adopt_wake_unsupported' });
    }
    // Every REMOTE backend (riff / mojo) owns a remote lineage that a local
    // forkWorker cold-boot would sever or replace — the same reason /restart
    // rejects them. A dormant remote session cold-resumes from its own lineage
    // on the next message, never from a picker-driven local wake.
    if (isRemoteBackendSession(ds)) {
      return jsonRes(res, 409, { ok: false, error: 'remote_wake_unsupported' });
    }
    if (rejectProtectedSessionMutation(res, [ds])) return;

    const cliId = ds.session.cliId ?? 'unknown';
    if (ds.worker && !ds.worker.killed) {
      return jsonRes(res, 200, {
        ok: true,
        sessionId: params.sessionId,
        cliId,
        woke: false,
        reason: 'already_running',
      });
    }
    if (!forkWorker(ds, '', ds.hasHistory)) {
      return jsonRes(res, 409, { ok: false, error: 'wake_refused' });
    }
    jsonRes(res, 200, { ok: true, sessionId: params.sessionId, cliId, woke: true });
  });
  if (!mutation.acquired && !res.destroyed) {
    jsonRes(res, 409, { ok: false, error: 'wake_mutation_timeout' });
  }
});

/** Manually suspend one active session: kill the worker + CLI/pane, session
 *  stays active and cold-resumes from its transcript on the next message —
 *  the same semantics the idle-worker sweeper applies over the live cap.
 *  Primary use: `botmux suspend --isolated` after a credential rotation, so
 *  isolated bots' next cold spawn re-provisions the freshest creds. */
ipcRoute('POST', '/api/sessions/:sessionId/suspend', async (_req, res, params) => {
  const initial = findActiveBySessionId(params.sessionId);
  if (!initial) return jsonRes(res, 404, { ok: false, error: 'session_not_active' });
  return withBotTurnMutation(initial.larkAppId, () => {
  const ds = findActiveBySessionId(params.sessionId);
  if (!ds) return jsonRes(res, 404, { ok: false, error: 'session_not_active' });
  if (isSessionTransferring(ds)) {
    return jsonRes(res, 409, { ok: false, error: 'session_transferring' });
  }
  // Adopt/observed sessions: botmux never owned the CLI — suspending would kill
  // the user's real tmux/zellij pane. Same guard as /restart.
  if (ds.adoptedFrom || ds.initConfig?.adoptMode) {
    return jsonRes(res, 409, { ok: false, error: 'adopt_suspend_unsupported' });
  }
  if (rejectProtectedSessionMutation(res, [ds])) return;
  if (!ds.worker || ds.worker.killed) {
    // Worker already gone (idle-suspended / crash-stopped) — the goal state is
    // already reached, so report idempotent success without a live kill.
    return jsonRes(res, 200, { ok: true, sessionId: params.sessionId, suspended: false, reason: 'no_live_worker' });
  }
  // Producing a reply — killing the worker now would drop this turn. Queue
  // instead; worker-pool's runPendingSuspendIfSettled cashes it in on the
  // idle/limited edge. Ordering matters: the idempotent no-worker branch above
  // must win, so "worker was already gone" never reports as deferred.
  //
  // The suspendability check is part of the queueing condition, not a new guard
  // ahead of it: a non-suspendable (pty) backend must keep falling through to
  // suspendWorker's existing 409 rather than get a `deferred` that could only
  // fail silently at fulfillment time.
  if (
    (ds.lastScreenStatus === 'working' || ds.lastScreenStatus === 'analyzing')
    && isSuspendableBackendType(ds.initConfig?.backendType)
  ) {
    ds.pendingSuspendReason = 'manual_suspend';
    // Bind the claim to the generation that is producing right now: it must not
    // outlive that worker (see clearPendingSuspendClaim).
    ds.pendingSuspendGeneration = ds.workerGeneration;
    return jsonRes(res, 200, {
      ok: true, sessionId: params.sessionId, suspended: false, reason: 'deferred',
    });
  }
  if (!suspendWorker(ds, 'manual_suspend')) {
    // Live worker but a non-suspendable (pty) backend: killing it would drop the
    // in-memory conversation with no persistent pane to resume from lazily.
    return jsonRes(res, 409, { ok: false, error: 'backend_not_suspendable' });
  }
  jsonRes(res, 200, { ok: true, sessionId: params.sessionId, suspended: true });
  });
});

/**
 * Count host-overload降压 candidates for THIS daemon's scope, so the alert card
 * can show "僵尸 N / 闲置 M" before the owner clicks. Both counts are local to
 * THIS daemon: its session store is bot-scoped, and live workers only exist in
 * their owning process. The card handler sums every daemon's response. Mirrors
 * the exact classification the sweep uses so the preview matches a click.
 */
ipcRoute('GET', '/api/host-overload/counts', (_req, res) => {
  const stopped = sessionStore.listSessions().filter(s => s.status === 'active' && isSessionStopped(s)).length;
  let idle = 0;
  for (const ds of listActiveSessions()) {
    if (!ds.worker || ds.worker.killed) continue;
    if (ds.adoptedFrom || ds.initConfig?.adoptMode) continue;
    if (!isSuspendableBackendType(ds.initConfig?.backendType)) continue;
    if (ds.lastScreenStatus !== 'idle') continue;
    idle++;
  }
  jsonRes(res, 200, { ok: true, stopped, idle });
});

/**
 * Bulk host-overload降压 sweep, driven by the overload-alert card buttons.
 * `mode`:
 *   - `clean_stopped`: close stopped zombie sessions (dead CLI + no exact
 *     persistent backing) from THIS daemon's bot-scoped session store. The
 *     card handler fans this mode out to every online daemon.
 *   - `suspend_idle`: suspend THIS daemon's own idle (non-busy, suspendable,
 *     non-adopt) live workers. Live workers only exist in their owning daemon's
 *     process, so the card handler fans this mode out to every online daemon.
 * Returns `{ ok, mode, affected }` — `affected` counts sessions acted on here.
 */
ipcRoute('POST', '/api/host-overload/sweep', async (req, res) => {
  let body: { mode?: unknown };
  try { body = await readJsonBody(req); }
  catch { return jsonRes(res, 400, { ok: false, error: 'bad_json' }); }
  const mode = body?.mode;

  if (mode === 'clean_stopped') {
    const stopped = sessionStore.listSessions().filter(s => s.status === 'active' && isSessionStopped(s));
    let affected = 0;
    for (const s of stopped) {
      try {
        const r = await closeSession(s.sessionId);
        // Only count sessions this call actually closed. A concurrent action in
        // this daemon may already have closed the same record.
        if (r.ok && !r.alreadyClosed) affected++;
      } catch (err) {
        logger.warn(`[overload-sweep] close failed for ${s.sessionId.slice(0, 8)}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    logger.info(`[overload-sweep] clean_stopped: closed ${affected}/${stopped.length} zombie session(s)`);
    return jsonRes(res, 200, { ok: true, mode, affected });
  }

  if (mode === 'suspend_idle') {
    // This daemon's own idle live workers only. Correctness guards mirror the
    // idle-worker sweeper: never touch adopt sessions or mid-turn (busy) ones.
    let affected = 0;
    for (const ds of listActiveSessions()) {
      if (!ds.worker || ds.worker.killed) continue;             // no live worker
      if (ds.adoptedFrom || ds.initConfig?.adoptMode) continue;  // never suspend adopt
      if (!isSuspendableBackendType(ds.initConfig?.backendType)) continue;
      if (ds.lastScreenStatus !== 'idle') continue;              // never cut an in-flight reply
      try {
        if (suspendWorker(ds, 'host_overload_suspend')) affected++;
      } catch (err) {
        logger.warn(`[overload-sweep] suspend failed for ${ds.session.sessionId.slice(0, 8)}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    logger.info(`[overload-sweep] suspend_idle: suspended ${affected} idle worker(s)`);
    return jsonRes(res, 200, { ok: true, mode, affected });
  }

  return jsonRes(res, 400, { ok: false, error: 'bad_mode' });
});

/** 会话级 CLI IPC（slash/cd）的调用方证明：trusted-host（.dashboard-secret HMAC，
 *  外层 gate 已验）直接放行；否则（沙箱/读隔离 CLI 读不到 secret，走
 *  routeHasNarrowUntrustedAuth 窄孔进来）必须出示该会话当前轮换的 capability，
 *  与 daemon 活跃记录里的 managedTurnOrigin 比对（/api/asks 同款姿势）。
 *  capability 只证明「我是这个会话当前这一轮的 CLI」——绑定 URL sessionId，
 *  拿到别的 sessionId 也伪造不了它的 capability。会话不存在时对未签名调用方
 *  同样回 origin_unproven，不提供「哪些 sessionId 活跃」的探针。 */
function sessionCliIpcAuth(
  req: IncomingMessage,
  ds: DaemonSession | undefined,
  sessionId: string,
  body: Record<string, unknown> | undefined,
  opts: { allowReceiver?: boolean } = {},
): { ok: true } | { ok: false; error: string } {
  const claimedAttempt = typeof body?.originDispatchAttempt === 'number'
    && Number.isSafeInteger(body.originDispatchAttempt)
    && body.originDispatchAttempt > 0
    ? body.originDispatchAttempt
    : undefined;
  const decision = authorizeSessionScopedIpc({
    trustedHost: isTrustedHostIpcRequest(req),
    sessionExists: !!ds,
    receiverSession: !!ds?.session.vcMeetingReceiver,
    // close/slash/cd 是 managed action，默认拒绝 receiver；claim 只读 daemon 自有
    // 本轮非凭证上下文（reminder/whiteboard），读自己本轮 reminder 非提权，单独放开。
    allowReceiver: opts.allowReceiver === true,
    sessionId,
    liveOrigin: ds?.managedTurnOrigin,
    claimedCapability: typeof body?.originCapability === 'string' ? body.originCapability : undefined,
    claimedTurnId: typeof body?.originTurnId === 'string' ? body.originTurnId : undefined,
    claimedDispatchAttempt: claimedAttempt,
  });
  return decision.ok ? { ok: true } : { ok: false, error: decision.error };
}

/**
 * P1-12：会话血缘的根 pid——「谁有资格持有预览端口」的起点。
 *
 * worker fork 出来的进程树覆盖 pty 后端；tmux / zellij / herdr 这类后端的 CLI 是复用
 * 器服务端的子进程、不在 worker 树下，所以 worker 通过私有 IPC 上报的 cliPid（以及
 * adopt 会话接管的那个 CLI pid）必须单独作根，否则这些后端会被误判成「来路不明」。
 */
function previewOwnerPids(ds: DaemonSession): Array<number | undefined> {
  return [
    ds.worker?.pid,
    ds.localProcessAttestation?.cliPid,
    ds.session.pid,
    ds.adoptedFrom?.originalCliPid,
  ];
}

/** 当前权威代次。CAS 与 target 落盘都以它为准。 */
function previewWorkerGeneration(ds: DaemonSession): number {
  return ds.workerGeneration ?? ds.session.workerGeneration ?? 0;
}

/** Register one reachable loopback Web service for the exact calling session.
 * This is the only route that can create preview routing state. An isolated CLI
 * enters through the narrow capability aperture; a trusted host call is still
 * path/port-bound by the outer daemon HMAC. The requested host is never DNS —
 * only literal IPv4/IPv6 loopback is accepted, and the daemon connects before
 * persisting the target. */
ipcRoute('POST', '/api/sessions/:sessionId/preview', async (req, res, params) => {
  let body: Record<string, unknown>;
  try {
    body = await readJsonBody<Record<string, unknown>>(req, 4_096);
  } catch (error) {
    return jsonRes(
      res,
      error instanceof JsonBodyTooLargeError ? 413 : 400,
      { ok: false, error: error instanceof JsonBodyTooLargeError ? 'body_too_large' : 'bad_json' },
    );
  }
  const ds = findActiveBySessionId(params.sessionId);
  const auth = sessionCliIpcAuth(req, ds, params.sessionId, body);
  if (!auth.ok) return jsonRes(res, 403, { ok: false, error: auth.error });
  if (!ds) return jsonRes(res, 404, { ok: false, error: 'session_not_active' });
  // Riff 矩阵：远端 sandbox 的 Web 服务跑在远程主机上，daemon 这侧的 loopback 上
  // 永远不会有它的监听。明确回 `preview_unsupported`，不要让它落进
  // `preview_unreachable` 冒充「偶发故障」让 agent 反复重试。
  if (!previewBackendSupported(ds.initConfig?.backendType ?? ds.session.backendType)) {
    return jsonRes(res, 501, { ok: false, error: 'preview_unsupported' });
  }
  if (!isPreviewPort(body.port)) {
    return jsonRes(res, 400, { ok: false, error: 'invalid_port' });
  }
  if (body.host !== undefined && !isPreviewLoopbackHost(body.host)) {
    return jsonRes(res, 403, { ok: false, error: 'remote_host_forbidden' });
  }
  // P1-13：probe 是一次 await。鉴权发生在 await **之前**，而 await 期间这个会话可能
  // 已经被 close、被 refork、切了 CLI——那些路径都会推进代次并清掉 previewTarget。
  // 捕获本次请求看到的对象与代次，回填前做 CAS 复核，不一致就整条丢弃：否则一个属于
  // 上一代 CLI 的注册会被写进新一代（甚至已关闭）的会话里。
  const generationAtEntry = previewWorkerGeneration(ds);
  const workerAtEntry = ds.worker;
  // P1-3：previewTarget 自己也得进 CAS 锚点。上面那四件只覆盖「跨代次/跨生命周期」，
  // **同代次内的并发注册**不在它们的射程里：这条路由没有 per-session 串行化，agent
  // 完全可以 `botmux preview 3000 & botmux preview 4000 &`，或者在 stale 清理在途时
  // 重注册。而谁先落地由 probe 耗时决定，不是由请求先后决定——单 host 超时 750ms，
  // 不带 host 时 127.0.0.1 与 ::1 串行试，「A 慢一秒、B 快一毫秒」是常规而非极端。
  // 没有这一条，后 settle 的旧请求会无条件盖掉先落地的新值，两条 CLI 都打印
  // 「✓ Web 预览已注册」，实际生效的却是哪一个不确定。
  const previewAtEntry = ds.session.previewTarget;
  const probe = await probeSessionPreviewTarget({
    port: body.port,
    ...(isPreviewLoopbackHost(body.host) ? { host: body.host } : {}),
    ownerPids: previewOwnerPids(ds),
    workerGeneration: generationAtEntry,
  });
  if (!probe.ok) {
    if (probe.error === 'invalid_port') {
      return jsonRes(res, 400, { ok: false, error: 'invalid_port' });
    }
    if (probe.error === 'preview_owner_unverified') {
      // fail closed：有人在监听，但证明不了是本会话的进程（血缘外、procfs 不可读、
      // 非 Linux 平台）。宁可没有预览，也不给出一条指向不明进程的代理路由。
      return jsonRes(res, 422, {
        ok: false,
        error: 'preview_owner_unverified',
        ...(probe.reason ? { reason: probe.reason } : {}),
      });
    }
    return jsonRes(res, 422, { ok: false, error: 'preview_unreachable' });
  }
  const target = probe.target;
  const current = findActiveBySessionId(params.sessionId);
  const recheck = sessionCliIpcAuth(req, current, params.sessionId, body);
  if (
    current !== ds
    || ds.session.status === 'closed'
    || previewWorkerGeneration(ds) !== generationAtEntry
    || ds.worker !== workerAtEntry
    || !recheck.ok
  ) {
    return jsonRes(res, 409, { ok: false, error: 'preview_generation_changed' });
  }
  // 引用比较即「我 await 期间有没有别人写过这个字段」：注册整体替换对象，清理写
  // undefined，两者都会改变引用。
  if (ds.session.previewTarget !== previewAtEntry) {
    return jsonRes(res, 409, { ok: false, error: 'preview_target_changed' });
  }

  const previous = ds.session.previewTarget;
  ds.session.previewTarget = target;
  try {
    sessionStore.updateSession(ds.session);
  } catch {
    ds.session.previewTarget = previous;
    return jsonRes(res, 500, { ok: false, error: 'preview_persist_failed' });
  }
  dashboardEventBus.publish({
    type: 'session.update',
    body: { sessionId: params.sessionId, patch: { previewTarget: target } },
  });
  return jsonRes(res, 200, {
    ok: true,
    preview: sessionPreviewDescriptor(params.sessionId, target),
  });
});

/**
 * P1-12/P1-13：作废一个会话的预览目标。
 *
 * 由中央 Dashboard 在**代理落地前**发现归属已变（端口换了进程持有）时调用：代理侧
 * 只有本机 procfs 的只读视角，改不了会话行，必须由持有会话的 daemon 来清字段 + 落盘
 * + 广播 `preview: null`。仅 trusted host / HMAC 可用；幂等——本来就没有目标时回 200。
 *
 * P1-3：`?expectedRegisteredAt=` 指名要作废的是哪一次注册。判定失效发生在代理进程，
 * 这条 DELETE 落地在 daemon 进程，中间隔着一次跨进程往返；那段窗口里会话完全可以合法
 * 地重注册一个新目标，无条件清空会把它一起抹掉（fail-closed 方向没错，但 agent 刚拿到
 * 的「✓ 已注册」会莫名其妙失效）。revision 不匹配时整条 no-op，回 `cleared: false`，
 * 幂等语义不变。不带参数时保持原来的无条件语义。
 */
ipcRoute('DELETE', '/api/sessions/:sessionId/preview', (req, res, params) => {
  if (!isTrustedHostIpcRequest(req) && !ipcHmacAuthorized(req)) {
    return jsonRes(res, 401, { ok: false, error: 'unauthorized' });
  }
  const ds = findActiveBySessionId(params.sessionId);
  if (!ds) return jsonRes(res, 404, { ok: false, error: 'session_not_active' });
  const expectedRegisteredAt = new URL(req.url ?? '/', 'http://localhost')
    .searchParams.get('expectedRegisteredAt') ?? undefined;
  const cleared = clearSessionPreviewTarget(
    ds.session,
    'listener ownership changed',
    expectedRegisteredAt,
  );
  return jsonRes(res, 200, { ok: true, cleared });
});

/** Host-only daemon read API. It intentionally returns the browser-safe
 * descriptor, not the literal loopback host/port used inside daemon SSE. */
ipcRoute('GET', '/api/sessions/:sessionId/preview', (req, res, params) => {
  if (!isTrustedHostIpcRequest(req) && !ipcHmacAuthorized(req)) {
    return jsonRes(res, 401, { ok: false, error: 'unauthorized' });
  }
  const ds = findActiveBySessionId(params.sessionId);
  if (!ds) return jsonRes(res, 404, { ok: false, error: 'session_not_active' });
  const preview = sessionPreviewDescriptor(params.sessionId, ds.session.previewTarget);
  if (!preview) return jsonRes(res, 404, { ok: false, error: 'preview_not_registered' });
  return jsonRes(res, 200, { ok: true, preview });
});

/** 向本会话 CLI 注入一条 allowlist 内的原生斜杠命令（idle 后生效）。
 *  鉴权双路径（见 sessionCliIpcAuth）：trusted-host 签名或本会话 rotating
 *  capability；命令面由 allowlist（默认空=全拒）承担。 */
ipcRoute('POST', '/api/sessions/:sessionId/slash', async (req, res, params) => {
  const body = await readJsonBody<{ command?: string } & Record<string, unknown>>(req)
    .catch(() => ({} as { command?: string } & Record<string, unknown>));
  const ds = findActiveBySessionId(params.sessionId);
  const auth = sessionCliIpcAuth(req, ds, params.sessionId, body);
  if (!auth.ok) return jsonRes(res, 403, { ok: false, error: auth.error });
  if (!ds) return jsonRes(res, 404, { ok: false, error: 'session_not_active' });
  // Adopt/observed 会话是收编的用户自有 pane，用户可能正在里面打字——机器注入
  // 会与人的输入交错。与 /suspend、/restart 同款排除。
  if (ds.adoptedFrom || ds.initConfig?.adoptMode) {
    return jsonRes(res, 409, { ok: false, error: 'adopt_inject_unsupported' });
  }
  // Remote backends (riff / mojo) have no TUI to inject a slash line into. For mojo
  // the injection does not no-op either: MojoBackend.write() starts a REAL remote
  // turn, and this IPC carries no credential snapshot (unlike message / raw_input),
  // so an allowlisted slash sent after a JWT rotation or clear would run the turn
  // on the worker's stale token. Refused rather than wired up: this is a TUI-only
  // channel, and the same reasoning already hides the PTY quick-action keys for
  // these backends.
  const injectFrozenType = ds.initConfig?.backendType ?? ds.session.backendType;
  if (injectFrozenType && isRemoteBackendType(injectFrozenType)) {
    return jsonRes(res, 409, { ok: false, error: 'remote_backend_inject_unsupported' });
  }
  if ((!ds.worker || ds.worker.killed) && !isSessionTransferring(ds)) {
    return jsonRes(res, 409, { ok: false, error: 'no_live_worker' });
  }
  const allow = getBotTuiSlashAllow(ds.larkAppId);
  const v = validateSlashInjection(body?.command ?? '', allow);
  if (!v.ok) return jsonRes(res, 403, { ok: false, error: v.error });
  try {
    if (!sendWorkerSessionInput(ds, { type: 'inject_command', command: v.command })) {
      return jsonRes(res, 409, { ok: false, error: 'no_live_worker' });
    }
  } catch {
    // slash 注入无状态（不像 /cd 那样已 repin 记录），send 失败不需要杀进程
    // 冷启动——直接把失败面报给调用方即可。
    return jsonRes(res, 502, { ok: false, error: 'worker_send_failed' });
  }
  jsonRes(res, 200, { ok: true, sessionId: params.sessionId, queued: v.command });
});

const proactiveChatRenameCooldown = new ChatRenameCooldown();
const chatRenameSerialQueue = new ChatRenameSerialQueue();

/** Session-scoped external mutation used by the botmux-chat-rename Skill. */
ipcRoute('POST', '/api/sessions/:sessionId/chat-rename', async (req, res, params) => {
  const body = await readJsonBody<{ name?: unknown; proactive?: unknown } & Record<string, unknown>>(req)
    .catch(() => ({} as { name?: unknown; proactive?: unknown } & Record<string, unknown>));
  const ds = findActiveBySessionId(params.sessionId);
  const auth = sessionCliIpcAuth(req, ds, params.sessionId, body);
  if (!auth.ok) return jsonRes(res, 403, { ok: false, error: auth.error });
  if (!ds) return jsonRes(res, 404, { ok: false, error: 'session_not_active' });
  if (sessionTransportDisabled(ds)) return jsonRes(res, 200, { ok: false, error: 'no_feishu_transport' });
  if (ds.chatType !== 'group') return jsonRes(res, 400, { ok: false, error: 'not_group_chat' });
  const normalized = normalizeLarkChatName(body.name);
  if (!normalized.ok) return jsonRes(res, 400, normalized);

  const proactive = body.proactive === true;
  const trigger = proactive ? 'ai_proactive' : 'user_explicit';
  const cooldownKey = `${ds.larkAppId}:${ds.chatId}`;
  await chatRenameSerialQueue.run(cooldownKey, async () => {
    const result = await groupsStore.renameChat(ds.larkAppId, ds.chatId, normalized.name, {
      beforeUpdate: proactive
        ? () => {
            const cooldown = proactiveChatRenameCooldown.check(cooldownKey);
            return cooldown.ok
              ? cooldown
              : { ...cooldown, error: 'rate_limited' as const };
          }
        : undefined,
    });
    const botOpenId = getBotOpenId(ds.larkAppId) ?? '-';
    if (!result.ok) {
      const status = result.error === 'bot_not_in_chat' ? 403
        : result.error === 'permission_denied' ? 403
          : result.error === 'rate_limited' ? 429
            : 502;
      logger.warn(
        `[chat-rename:audit] result=failed session=${ds.session.sessionId} chat=${ds.chatId} `
        + `app=${ds.larkAppId} botOpenId=${botOpenId} trigger=${trigger} `
        + `old=${JSON.stringify(result.oldName ?? null)} new=${JSON.stringify(result.newName ?? normalized.name)} `
        + `error=${result.error} larkCode=${result.larkCode ?? '-'} detail=${result.detail ?? '-'}`,
      );
      return jsonRes(res, status, result);
    }
    if (result.changed) {
      if (proactive) proactiveChatRenameCooldown.record(cooldownKey);
      // FR-7: the Lark write already succeeded, so a local cache-refresh
      // failure (ENOSPC/EACCES on the session store) must NOT reverse the
      // outcome into an HTTP 500 — best-effort per session, warn and keep the
      // rename a success. Catch per-session so one bad write can't skip the rest.
      for (const active of getActiveSessionsRegistry()?.values() ?? []) {
        if (active.chatId !== ds.chatId) continue;
        active.session.chatDisplayName = result.newName;
        try {
          sessionStore.updateSession(active.session);
        } catch (e) {
          logger.warn(`[chat-rename:audit] cache_refresh_failed session=${active.session.sessionId} chat=${ds.chatId} app=${ds.larkAppId} detail=${e instanceof Error ? e.message : String(e)}`);
        }
      }
      logger.info(
        `[chat-rename:audit] result=success session=${ds.session.sessionId} chat=${ds.chatId} `
        + `app=${ds.larkAppId} botOpenId=${botOpenId} trigger=${trigger} `
        + `old=${JSON.stringify(result.oldName)} new=${JSON.stringify(result.newName)} larkCode=0`,
      );
    }
    return jsonRes(res, 200, { ...result, chatId: ds.chatId });
  });
});

/** 会话内切换工作目录（角色切换专用）：硬校验角色库根 → 更新记录落盘（唯一事实源）
 *  → 活 worker 走「带 --resume 的进程重启、respawn 在新 cwd」，无活 worker 杀残留
 *  pane 让下条消息冷启动。
 *
 *  为什么是 respawn 而不是向活进程注入 /cd（旧实现）：CLI 的系统上下文（CLAUDE.md、
 *  记忆路径/索引）是开场按启动 cwd 注入一次的静态快照，/cd 只改 cwd 不重刷——注入
 *  切换后模型仍拿着旧角色的记忆索引读写（读旧索引、写错桶）。respawn 让「开场」在
 *  新 cwd 重新发生：新角色的 CLAUDE.md/记忆索引开场即注入，--resume 回放对话历史
 *  保留上下文（“换角色外壳、留对话内核”）。旧桶 transcript 由 claude-code 适配器的
 *  resume 预检 syncClaudeResumeTargetToCwd（worker.ts 每次 resume respawn、probe 之前
 *  把最新 <sid>.jsonl COPY 进新 cwd 的 project 目录，已在 master）接住，不会探空丢
 *  上下文。故本改动可独立部署，不硬依赖任何跨桶迁移专项 PR。
 *
 *  鉴权双路径（见 sessionCliIpcAuth）：trusted-host 签名或本会话 rotating
 *  capability；目录面由 validateRoleLibraryPath 硬校验承担（realpath 归一 +
 *  dev/ino 包含判断，角色库根之外一律拒）。
 *  不发话题消息（AI 自己发角色化确认）。 */
ipcRoute('POST', '/api/sessions/:sessionId/cd', async (req, res, params) => {
  const body = await readJsonBody<{ dir?: string } & Record<string, unknown>>(req)
    .catch(() => ({} as { dir?: string } & Record<string, unknown>));
  const ds = findActiveBySessionId(params.sessionId);
  const auth = sessionCliIpcAuth(req, ds, params.sessionId, body);
  if (!auth.ok) return jsonRes(res, 403, { ok: false, error: auth.error });
  if (!ds) return jsonRes(res, 404, { ok: false, error: 'session_not_active' });
  if (isSessionTransferring(ds)) {
    return jsonRes(res, 409, { ok: false, error: 'session_transferring' });
  }
  // Adopt/observed 会话是收编的用户自有 pane——注入或冷重启都会打断用户自己的
  // 终端会话。与 /suspend、/restart、/slash 同款排除。
  if (ds.adoptedFrom || ds.initConfig?.adoptMode) {
    return jsonRes(res, 409, { ok: false, error: 'adopt_cd_unsupported' });
  }
  // Remote retirement (Riff AND Mojo) is intentionally refused without
  // prepare/commit, so a cold restart cannot follow a repin here. Reject
  // before validation/repin so the persisted cwd cannot drift from the
  // still-running remote lineage — mojo used to slip past the riff-only
  // guard, repin, and then killWorker's refusal left the live worker on the
  // old cwd while the route reported cold-restart (P1-a split brain).
  if (isRemoteBackendSession(ds)) {
    return jsonRes(res, 409, {
      ok: false,
      error: 'remote_cd_unsupported',
      message: t('cmd.cd.remote_unsupported', undefined, localeForBot(ds.larkAppId)),
    });
  }
  // ownAppId 收窄到本 bot 自己的角色库子树：不收窄就能切进别的 bot 的角色目录，
  // 下面 repinSessionWorkingDir 把 ds.workingDir 钉过去之后，那个 bot 的沙盒会话
  // 就拿到了对方整棵角色库的 readWrite（打穿 fs-policy 的跨 bot 隔离）。
  const v = validateRoleLibraryPath(body?.dir ?? '', undefined, ds.larkAppId);
  if (!v.ok) {
    const forbidden = v.error === 'outside_role_library' || v.error === 'outside_own_role_library';
    // own_role_library_missing：本 bot 的 `<角色库根>/<appId>` 不是真目录（存量用
    // 人类 slug 命名这一层，未按 deploy-runbook §8 迁移）。FAIL-CLOSED——不回落全局
    // 根（回落是 fail-open，会让存量部署继续能跨 bot 切并经 workingDir 拿 rw）。回
    // 409 + 迁移指引，让运营看得见查得到，而不是静默放行或静默拒绝。
    if (v.error === 'own_role_library_missing') {
      logger.warn(`[role] 角色库每-bot 目录名不是 appId（期望 ~/botmux-roles/${ds.larkAppId}）——`
        + 'role switch 已 fail-closed 拒绝，避免跨 bot 越权。按 docs/roles/deploy-runbook.md '
        + '§8「迁移：每-bot 目录名改为 appId」重命名该目录即恢复。');
      return jsonRes(res, 409, { ok: false, error: v.error });
    }
    return jsonRes(res, forbidden ? 403 : 400, { ok: false, error: v.error });
  }
  repinSessionWorkingDir(ds, v.resolvedPath);
  // ds.initConfig 与 repin 同步，且**无条件**（不只在 live-worker 分支里）：下次
  // forkWorker 用 initConfig 重建 init 消息，只在有活 worker 时更新的话，no-worker /
  // worker.killed 两条分支会留下「记录新、initConfig 旧」的分裂状态，冷启动把会话
  // 带回旧 cwd（= 旧角色，连记忆桶都是旧的）。codex review 抓出的既有 bug，与本 PR
  // 的收窄同一处理，顺手修掉。
  if (ds.initConfig) ds.initConfig.workingDir = v.resolvedPath;
  if (ds.worker && !ds.worker.killed) {
    // updateWorkingDir 随 restart 带给 worker：respawn 必须收敛到新目录，而不是
    // 陈旧的 lastInitConfig.workingDir（daemon 侧 initConfig 已在上面同步）。
    try {
      ds.workerReady = false;
      ds.worker.send({ type: 'restart', updateWorkingDir: v.resolvedPath, env: latestPerBotEnvForRestart(ds), model: latestModelForRespawn(ds) } as DaemonToWorker);
    } catch {
      // send() 抛异常：worker 进程实际上已经不可达（管道已断），但 above 的
      // repinSessionWorkingDir 已经把记录改成了新目录——绝不能留下「记录新、
      // 进程仍在旧目录」的分裂状态。杀掉 worker 让下一条消息冷启动进新目录。
      killWorker(ds);
      return jsonRes(res, 200, { ok: true, mode: 'cold-restart', dir: v.resolvedPath });
    }
    return jsonRes(res, 200, { ok: true, mode: 'respawn-resume', dir: v.resolvedPath });
  }
  // Unconditional (no `ds.worker` guard), matching the IM `/cd` command handler
  // (src/core/command-handler.ts) — killWorker() already no-ops safely when there
  // is no live worker. That "no worker" branch is exactly what must run here for a
  // lazy-restored-after-daemon-restart or crash-stopped TmuxBackend/HerdrBackend/
  // ZellijBackend session: the persistent backing pane survives the worker's death
  // and still binds the OLD cwd, so it must be torn down via
  // destroyOrphanedBackingSession (called from inside killWorker) or the next
  // resume would silently reattach to it and ignore the just-repinned workingDir.
  killWorker(ds);
  jsonRes(res, 200, { ok: true, mode: 'cold-restart', dir: v.resolvedPath });
});

/** 解析 session（活跃优先，已关闭兜底）。活跃会话取 ds.session —— registry 与
 *  store 持有同一对象，改字段后 updateSession 即落盘。 */
function findSessionRecord(sessionId: string): Session | undefined {
  return findActiveBySessionId(sessionId)?.session ?? sessionStore.getSession(sessionId);
}

/** True when a session-bound IPC route must NOT touch Feishu: the owning bot is
 *  core-only (apiOnly) OR the session is an HTTP virtual chat. Central guard for
 *  every session-write route (chat-rename / write-link-card / resume-notice /
 *  locate / restart-notice …) — the daemon owns the authoritative bot config,
 *  so gating here catches the normal-bot-in-virtual-session case that
 *  getBotClient (which only throws for apiOnly) cannot. Accepts a live
 *  DaemonSession or a stored Session record. Never throws. */
function sessionTransportDisabled(s: { chatId?: string; larkAppId?: string }): boolean {
  const appId = s.larkAppId;
  let apiOnly = false;
  if (appId) { try { apiOnly = getBot(appId).config.apiOnly === true; } catch { /* unknown bot → not apiOnly */ } }
  return !larkTransportEnabled({ chatId: s.chatId ?? '', apiOnly });
}

/** Mutating IPC routes may only touch this daemon's own bot-partitioned store. */
function findOwnedSessionRecord(sessionId: string): Session | undefined {
  return findActiveBySessionId(sessionId)?.session ?? sessionStore.getOwnedSession(sessionId);
}

/** Four-state async lookup with durable fallback (design A).
 *
 *  In-memory `asyncTriggerResults` lives only on the active DaemonSession and is
 *  lost on daemon restart / idle-suspend. To keep a poller from misreading an
 *  already-completed turn as `not_found`, this resolves against BOTH the live
 *  session and the on-disk stores:
 *   - completed (mem or disk)          → completed + output.content + finishedAt
 *   - pending in mem / session active  → running
 *   - session record closed, no output → failed (no_output; soft terminal —
 *                                         may be a real failure OR a caller close)
 *   - no session record AND no result  → not_found (never existed / invalid id)
 *
 *  Legacy `action`/`async` fields are still populated so existing webhook
 *  consumers keep working; new callers branch on `state`. */
function buildAsyncTriggerLookupResponse(sessionId: string, triggerId?: string): TriggerResponse {
  const ds = findActiveBySessionId(sessionId);
  const storedRaw = ds?.session ?? sessionStore.getSession(sessionId);
  const persistedRaw = asyncTriggerStore.lookup(sessionId, triggerId);

  // Cross-bot isolation (fail-closed / positive-proof) — see decideAsyncOwnership.
  // Both sessionStore.getSession() (cross-scans every bot's sessions-*.json) and
  // the async store (machine-wide shared dir) can surface another bot's data for
  // a sessionId routed to THIS daemon; keep only sources positively proven ours.
  const decision = decideAsyncOwnership({
    owner: cachedLarkAppId,
    liveDs: !!ds,
    storedOwner: storedRaw?.larkAppId,
    storedExists: !!storedRaw,
    persistedOwner: persistedRaw?.ownerLarkAppId,
    persistedExists: !!persistedRaw,
  });
  const stored = decision.keepStored ? storedRaw : undefined;
  const persisted = decision.keepPersisted ? persistedRaw : undefined;

  if (decision.foreignLeak) {
    return {
      ok: true,
      state: 'not_found',
      triggerId,
      errorCode: 'session_not_found',
      error: `no session record for: ${sessionId}`,
      message: 'no session found',
    };
  }

  const memTriggerId = triggerId || ds?.latestAsyncTriggerId;
  const memResult = ds && memTriggerId ? ds.asyncTriggerResults?.get(memTriggerId) : undefined;

  // Best-effort poll-side convergence for the double-fault turn (codex #818 P1-8):
  // the CONTRACT is that a double-fault returns 5xx and the caller retries with the
  // same key (that retry path is the authoritative recovery). This block is only a
  // bonus for a client that happens to poll first — if this turn is flagged
  // postBarrierFault (post-barrier throw AND the durable terminalize then threw),
  // nothing dispatched and no durable result exists, yet a live shared worker keeps
  // `liveActive` true so resolveAsyncTriggerState would otherwise report `running`.
  // Re-attempt the strict terminalize opportunistically; a persistent EIO simply
  // falls through to `running` and is converged by a same-key retry or boot reconcile.
  if (ds && memTriggerId) {
    const faultEntry = ds.idempotentAsyncTurns?.get(memTriggerId);
    if (faultEntry?.postBarrierFault) {
      // COMPLETED-WINS (codex #818 P1-8 race): the AUTHORITATIVE decision is
      // recordFailedStrict's IN-LOCK outcome (no TOCTOU). A pre-read fast-path
      // avoids the write when already visibly completed; else the in-lock return
      // (`already_completed` vs `written_failed`) decides. Never terminalize over a
      // completion that landed after the pre-read.
      const durable = asyncTriggerStore.lookup(sessionId, memTriggerId);
      const ownedCompleted = durable?.result.status === 'completed'
        && durable.ownerLarkAppId === faultEntry.ownerLarkAppId;
      if (ownedCompleted) {
        ds.idempotentAsyncTurns?.delete(memTriggerId);
        // fall through to normal resolution → reports completed.
      } else {
        try {
          const outcome = asyncTriggerStore.recordFailedStrict(sessionId, memTriggerId, Date.now(), faultEntry.ownerLarkAppId, 'dispatch_unknown');
          ds.idempotentAsyncTurns?.delete(memTriggerId);
          if (outcome === 'written_failed') {
            ds.asyncTriggerResults?.delete(memTriggerId);
            return {
              ok: true, state: 'failed', triggerId: memTriggerId,
              target: { kind: 'turn', sessionId, chatId: ds.chatId ?? stored?.chatId },
              errorCode: 'no_output',
              error: 'previous dispatch was interrupted with unknown outcome; not re-run (at-most-once)',
              message: 'async trigger terminated without output',
            };
          }
          // outcome === 'already_completed': a completion was seen under the lock —
          // fall through to normal resolution (which reports the completed result).
        } catch {
          // Genuine I/O failure — leave the flag for the next poll / retry / boot
          // reconcile; fall through to `running` rather than a phantom terminal.
        }
      }
    }
  }

  const resolved = resolveAsyncTriggerState({
    sessionId,
    liveActive: !!ds,
    chatId: ds?.chatId ?? stored?.chatId,
    memResult: memResult ? {
      status: memResult.status,
      content: memResult.content,
      completedAt: memResult.completedAt,
      failedAt: memResult.failedAt,
      errorCode: memResult.errorCode,
      terminalErrorCode: memResult.terminalErrorCode,
      usage: memResult.usage,
    } : undefined,
    memTriggerId: memResult ? memTriggerId : undefined,
    persisted,
    storedStatus: stored ? (stored.status === 'closed' ? 'closed' : 'open') : undefined,
    closedAt: stored?.closedAt,
    requestedTriggerId: triggerId,
  });

  // Form C: attach the read-only web-terminal URL ONLY in core-only mode, and
  // only when a LIVE worker terminal exists (workerPort bound + view capability
  // minted). Core-only is the single-tenant loopback path where trigger-result
  // is a public (no-HMAC) route and riff's in-sandbox runner polls it to open
  // the visible CLI TUI. Gating on BOTMUX_CORE_ONLY keeps this OFF the normal/
  // mixed fleet: there trigger-result is HMAC-gated, but we still must not widen
  // the token surface by minting a terminal read-capability into a poll response
  // that historically carried none (the dashboard mints view/write tokens only
  // on explicit /write-link request). buildTerminalUrl carries ?viewToken=
  // inline; the write token is never included. Closed/restored sessions have no
  // live worker terminal, so no stale URL is ever advertised.
  if (process.env.BOTMUX_CORE_ONLY === '1' && ds && ds.workerPort && ds.workerViewToken) {
    resolved.readOnlyUrl = buildTerminalUrl(ds);
    resolved.viewToken = ds.workerViewToken;
  }
  return resolved;
}

// 看板放置：dashboard 看板视图拖拽卡片后持久化列 + 列内排序位置。
// 改完广播 session.update，所有打开的 dashboard 实时同步。
ipcRoute('POST', '/api/sessions/:sessionId/board', async (req, res, params) => {
  let body: { column?: unknown; position?: unknown };
  try { body = await readJsonBody(req); } catch { return jsonRes(res, 400, { ok: false, error: 'bad_json' }); }
  const column = normalizeKanbanColumn(body.column);
  const position = normalizeKanbanPosition(body.position);
  if (!column && position === null) return jsonRes(res, 400, { ok: false, error: 'bad_request' });
  const session = findOwnedSessionRecord(params.sessionId);
  if (!session) return jsonRes(res, 404, { ok: false, error: 'session_not_found' });
  const larkAppId = session.larkAppId || cachedLarkAppId;
  if (!larkAppId) return jsonRes(res, 503, { ok: false, error: 'bot_not_found' });
  return withBotTurnAdmission(larkAppId, async () => {
  const currentSession = findSessionRecord(params.sessionId);
  if (!currentSession) return jsonRes(res, 404, { ok: false, error: 'session_not_found' });
  // 待办池(queued)会话被拖到「进行中」= 激活：把暂存内容当首轮发给 CLI 开跑。
  // activateQueuedSession 内部会清 queued + 把列设成 in_progress + forkWorker。
  const activeDs = findActiveBySessionId(params.sessionId);
  let activationTransferred = false;
  if (column === 'in_progress' && activeDs?.session.queued) {
    const activated = await activateQueuedSession(activeDs);
    if (!activated.ok) return jsonRes(res, 500, activated);
    activationTransferred = true;
  } else if (column) {
    currentSession.kanbanColumn = column;
  }
  if (position !== null) currentSession.kanbanPosition = position;
  try {
    sessionStore.updateSession(currentSession);
  } catch (err) {
    if (!activationTransferred) throw err;
    logger.error(
      `[dashboard] board metadata persistence failed after queued activation ownership transferred: `
      + `${err instanceof Error ? err.message : String(err)}`,
    );
  }
  dashboardEventBus.publish({
    type: 'session.update',
    body: {
      sessionId: params.sessionId,
      // queued 一并下发：激活后 session.queued 已为 false，前端浅合并若不带这个字段
      // 会残留 queued=true（卡片仍显示「开始」、再点 409）。!!session.queued 始终反映现态。
      patch: { kanbanColumn: currentSession.kanbanColumn, kanbanPosition: currentSession.kanbanPosition, queued: !!currentSession.queued },
    },
  });
  jsonRes(res, 200, { ok: true });
  });
});

// Narrow CLI whiteboard binding mutation. Keeping this daemon-side avoids a
// short-lived `botmux whiteboard` process rewriting a stale whole Session row
// over a concurrent Codex App FIFO transition.
ipcRoute('POST', '/api/sessions/:sessionId/whiteboard', async (req, res, params) => {
  let body: { whiteboardId?: unknown };
  try { body = await readJsonBody(req); }
  catch { return jsonRes(res, 400, { ok: false, error: 'bad_json' }); }
  if (typeof body.whiteboardId !== 'string'
    || body.whiteboardId.length === 0
    || body.whiteboardId.length > 256) {
    return jsonRes(res, 400, { ok: false, error: 'bad_whiteboard_id' });
  }
  const session = findSessionRecord(params.sessionId);
  if (!session) return jsonRes(res, 404, { ok: false, error: 'session_not_found' });
  const larkAppId = session.larkAppId || cachedLarkAppId;
  if (!larkAppId) return jsonRes(res, 503, { ok: false, error: 'bot_not_found' });
  return withBotTurnAdmission(larkAppId, async () => {
    const current = findSessionRecord(params.sessionId);
    if (!current) return jsonRes(res, 404, { ok: false, error: 'session_not_found' });
    current.whiteboardId = body.whiteboardId as string;
    sessionStore.updateSession(current);
    jsonRes(res, 200, { ok: true, whiteboardId: current.whiteboardId });
  });
});

// 待办池会话「开始」：把 parked 会话激活（发首轮、起 CLI），与拖到「进行中」同义。
ipcRoute('POST', '/api/sessions/:sessionId/start', async (_req, res, params) => {
  const initial = findActiveBySessionId(params.sessionId);
  if (!initial) return jsonRes(res, 404, { ok: false, error: 'session_not_found' });
  return withBotTurnAdmission(initial.larkAppId, async () => {
  const ds = findActiveBySessionId(params.sessionId);
  if (!ds) return jsonRes(res, 404, { ok: false, error: 'session_not_found' });
  if (!ds.session.queued) return jsonRes(res, 409, { ok: false, error: 'not_queued' });
  const r = await activateQueuedSession(ds);
  if (!r.ok) return jsonRes(res, 500, r);
  dashboardEventBus.publish({
    type: 'session.update',
    body: {
      sessionId: params.sessionId,
      patch: { kanbanColumn: ds.session.kanbanColumn, queued: !!ds.session.queued },
    },
  });
  jsonRes(res, 200, { ok: true });
  });
});

// Dashboard「创建会话」spawn：在新建的群里为本 daemon 的 bot 拉起/暂存一条 chat-scope
// 会话。aggregator 建完群后按模式(一起开工/lead 分配)对每个目标 bot 的 daemon 调一次。
ipcRoute('POST', '/api/sessions/spawn', async (req, res) => {
  if (!cachedLarkAppId) return jsonRes(res, 503, { ok: false, error: 'bot_not_found' });
  const activeSessions = getActiveSessionsRegistry();
  if (!activeSessions) return jsonRes(res, 503, { ok: false, error: 'registry_unavailable' });
  let body: unknown;
  try { body = await readJsonBody(req); } catch { return jsonRes(res, 400, { ok: false, error: 'invalid_json' }); }
  const parsed = parseSpawnRequest(body);
  if (!parsed.ok) return jsonRes(res, 400, { ok: false, error: parsed.error });
  const postBanner = !!(body as any).postBanner;
  return withBotTurnAdmission(cachedLarkAppId, async () => {
  let attachments;
  try {
    attachments = materializeDashboardImages(cachedLarkAppId, parsed.value.images);
  } catch (err: any) {
    logger.error(`[createSession] failed to persist Dashboard images: ${err?.message ?? err}`);
    return jsonRes(res, 500, { ok: false, error: 'image_store_failed' });
  }
  const r = await spawnDashboardSession(activeSessions, undefined, {
    larkAppId: cachedLarkAppId,
    chatId: parsed.value.chatId,
    content: parsed.value.content,
    column: parsed.value.column,
    role: parsed.value.role,
    coworkers: parsed.value.coworkers,
    attachments,
    title: parsed.value.title,
    postBanner,
    ownerOpenId: parsed.value.ownerOpenId,
    ownerUnionId: parsed.value.ownerUnionId,
  });
  if (!r.ok) {
    cleanupMaterializedDashboardImages(cachedLarkAppId, attachments);
    return jsonRes(res, r.error === 'session_exists' ? 409 : 500, r);
  }
  jsonRes(res, 200, r);
  });
});

ipcRoute('POST', '/api/chat-reply-mode', async (req, res) => {
  if (!cachedLarkAppId) return jsonRes(res, 503, { ok: false, reason: 'larkAppId_not_set' });
  let body: unknown;
  try { body = await readJsonBody(req); } catch { return jsonRes(res, 400, { ok: false, reason: 'invalid_json' }); }
  const chatId = typeof (body as any)?.chatId === 'string' ? (body as any).chatId.trim() : '';
  const mode = normalizeChatReplyMode(typeof (body as any)?.mode === 'string' ? (body as any).mode : undefined);
  if (!chatId) return jsonRes(res, 400, { ok: false, reason: 'chatId_required' });
  if (!mode) return jsonRes(res, 400, { ok: false, reason: 'invalid_mode' });
  const result = await setChatReplyMode(cachedLarkAppId, chatId, mode);
  if (!result.ok) return jsonRes(res, 500, { ok: false, reason: result.reason });
  jsonRes(res, 200, { ok: true, mode: result.mode });
});

// 会话历史：实时拉取该会话所在话题/群的飞书消息（与 botmux history 同链路，
// 消息体不落盘），给 dashboard 的会话历史弹窗。复杂卡片的「请升级」兜底文本
// 用 message.get 的完整表示补齐；merge_forward 保持占位符（原型不展开）。
ipcRoute('GET', '/api/sessions/:sessionId/history', async (req, res, params) => {
  const session = findSessionRecord(params.sessionId);
  if (!session) return jsonRes(res, 404, { ok: false, error: 'session_not_found' });
  const appId = session.larkAppId || cachedLarkAppId;
  if (!appId) return jsonRes(res, 422, { ok: false, error: 'no_lark_app' });
  // No-transport session (apiOnly bot or HTTP virtual chat) has no Feishu chat
  // history — listChatMessages/listThreadMessages would dial Feishu with a
  // synthetic chatId. Return empty history instead of making the network call.
  if (!larkTransportEnabled({ chatId: session.chatId, apiOnly: getBot(appId).config.apiOnly })) {
    return jsonRes(res, 200, { ok: true, messages: [], hint: 'no_feishu_transport' });
  }
  const url = new URL(req.url ?? '/', 'http://localhost');
  const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') ?? '80', 10) || 80, 1), 200);
  try {
    const raw = session.scope === 'chat'
      ? await listChatMessages(appId, session.chatId, limit)
      : await listThreadMessages(appId, session.chatId, session.rootMessageId, limit);
    const messages = await Promise.all(raw.map(async (m: any) => {
      const parsed = parseApiMessage(m);
      if (parsed.msgType === 'interactive' && cardContentHasUpgradeFallback(parsed.content)) {
        const merged = await resolveMergedCardContent(appId, parsed.messageId).catch(() => null);
        if (merged) parsed.content = merged.text;
      }
      return {
        messageId: parsed.messageId,
        senderId: parsed.senderId,
        senderType: parsed.senderType,
        // 服务端返回的发送者名（with_sender_name=true，bot 也有）。enrich 阶段
        // 本地花名册/contact 解析不到时兜底用它——第三方 bot 不再是一串 open_id。
        ...(parsed.senderName ? { senderName: parsed.senderName } : {}),
        msgType: parsed.msgType,
        content: parsed.content,
        // Lark create_time 是毫秒 epoch 字符串——规范成数字，前端 new Date 直接用
        createTime: Number(parsed.createTime) || undefined,
      };
    }));
    // 真人发送者补名字+头像（contact API，带缓存；不在可见范围的回退占位）
    const senders = new Map<string, { name: string; avatarUrl?: string } | null>();
    await Promise.all(
      [...new Set(messages.filter(m => m.senderType === 'user' && m.senderId).map(m => m.senderId))]
        .map(async id => { senders.set(id, await getUserProfile(appId, id)); }),
    );
    // Bot sender ids are scoped to the observing app. Reuse the chat-member
    // resolver (cross-ref + observed bot roster) instead of assuming every
    // non-user message came from the bot that owns this dashboard session.
    const botMembers: ChatBotMember[] = await listChatBotMembers(appId, session.chatId).catch(() => [] as ChatBotMember[]);
    let botInfos: HistoryBotInfo[] = [];
    try {
      const parsed = JSON.parse(readFileSync(join(config.session.dataDir, 'bots-info.json'), 'utf8'));
      if (Array.isArray(parsed)) botInfos = parsed;
    } catch { /* missing/corrupt cache degrades to name/open_id placeholders */ }
    // listChatBotMembers can be temporarily unavailable during startup. Always
    // retain a local self-bot fallback so its own messages still have identity.
    try {
      const self = getBot(appId);
      if (self.botOpenId && !botMembers.some(member => member.openId === self.botOpenId)) {
        const selfName = self.botName || appId;
        botMembers.push({
          openId: self.botOpenId,
          displayName: selfName,
          name: selfName,
          larkAppId: appId,
          source: 'configured',
          mentionable: true,
          mentionSource: 'self',
          hasTeamRole: false,
        });
      }
      if (!botInfos.some(info => info.larkAppId === appId)) {
        botInfos.push({ larkAppId: appId, botOpenId: self.botOpenId, botName: self.botName, botAvatarUrl: self.botAvatarUrl });
      }
    } catch { /* session record may outlive a removed bot config */ }

    jsonRes(res, 200, {
      ok: true,
      scope: session.scope ?? 'thread',
      ownerOpenId: session.ownerOpenId,
      messages: enrichHistorySenders(messages, senders, botMembers, botInfos),
    });
  } catch (err: any) {
    jsonRes(res, 502, { ok: false, error: String(err?.message ?? err) });
  }
});

ipcRoute('GET', '/api/sessions/:sessionId/trigger-result', (req, res, params) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const triggerId = url.searchParams.get('triggerId') ?? undefined;
  const result = buildAsyncTriggerLookupResponse(params.sessionId, triggerId);
  // Four-state semantics: the query itself succeeds (HTTP 200) for every
  // resolved state including not_found — task state lives in `result.state`,
  // not the HTTP status. Only a malformed lookup (ok:false) maps to non-200.
  jsonRes(res, result.ok ? 200 : 400, result);
});

// 会话 insight：只读解析本会话的 transcript，产出动作 span / 失败聚合 / 规则建议
// （SafeInsightReport）。底层 services/insight 已做 fail-closed 脱敏投影——raw 命令
// 与输出永不进结构。detail=summary 只返聚合+建议（/insight 卡片、抽屉概览用）；
// detail=spans 才带脱敏 span（详情 tab 用）。owner-only 由 dashboard 外层 authed-only
// 路由 + /insight 命令层把关，IPC 自身 loopback-trusted。
ipcRoute('GET', '/api/sessions/:sessionId/insight', (req, res, params) => {
  const session = findSessionRecord(params.sessionId);
  if (!session) return jsonRes(res, 404, { ok: false, error: 'session_not_found' });
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (url.searchParams.get('detail') === 'conversation') {
    const offset = parseInt(url.searchParams.get('offset') ?? '0', 10) || 0;
    const limit = parseInt(url.searchParams.get('limit') ?? '50', 10) || 50;
    const role = url.searchParams.get('role') as InsightConversationRole | null;
    const severity = url.searchParams.get('severity') as InsightSeverity | null;
    const tag = url.searchParams.get('tag') as SafeSpanTag | null;
    const turnIndexes = url.searchParams.getAll('turnIndexes')
      .flatMap(v => v.split(','))
      .map(v => parseInt(v, 10))
      .filter(Number.isFinite);
    const conversation = buildSafeInsightConversation({
      cliId: session.cliId ?? 'unknown',
      sessionId: session.sessionId,
      cliSessionId: session.cliSessionId,
      cwd: session.workingDir,
      larkAppId: session.larkAppId,
    }, {
      offset,
      limit,
      q: url.searchParams.get('q') ?? undefined,
      role: role && ['user', 'a2a_agent', 'system', 'agent'].includes(role) ? role : undefined,
      severity: severity && ['bad', 'warn', 'info'].includes(severity) ? severity : undefined,
      tag: tag && ['failure', 'slow', 'retry', 'read_write_imbalance', 'diagnostic', 'normal'].includes(tag) ? tag : undefined,
      turnIndexes: turnIndexes.length ? turnIndexes : undefined,
    });
    return jsonRes(res, 200, { ok: true, conversation });
  }
  const detail: InsightDetail = url.searchParams.get('detail') === 'spans' ? 'spans' : 'summary';
  try {
    const report = buildSafeInsightReport({
      cliId: session.cliId ?? 'unknown',
      sessionId: session.sessionId,
      cliSessionId: session.cliSessionId,
      cwd: session.workingDir,
      larkAppId: session.larkAppId,
    }, { detail });
    jsonRes(res, 200, { ok: true, report });
  } catch (err: any) {
    jsonRes(res, 500, { ok: false, error: String(err?.message ?? err) });
  }
});

ipcRoute('GET', '/api/sessions/:sessionId/insight/turn/:turnIndex', (req, res, params) => {
  const session = findSessionRecord(params.sessionId);
  if (!session) return jsonRes(res, 404, { ok: false, error: 'session_not_found' });
  const url = new URL(req.url ?? '/', 'http://localhost');
  const offset = parseInt(url.searchParams.get('offset') ?? '0', 10) || 0;
  const limit = parseInt(url.searchParams.get('limit') ?? '4000', 10) || 4000;
  try {
    const turn = buildSafeInsightTurnDetail({
      cliId: session.cliId ?? 'unknown',
      sessionId: session.sessionId,
      cliSessionId: session.cliSessionId,
      cwd: session.workingDir,
      larkAppId: session.larkAppId,
    }, parseInt(params.turnIndex, 10) || 0, { offset, limit });
    jsonRes(res, 200, { ok: true, turn });
  } catch (err: any) {
    jsonRes(res, 500, { ok: false, error: String(err?.message ?? err) });
  }
});

// 跨会话 insight 总览：仍然只读、按需、owner-only（外层 dashboard route
// 不在 public-read 白名单）。只聚合本 daemon registry 里的 botmux 会话；
// 不扫整机 transcript，不返回 raw span/input/output。
ipcRoute('GET', '/api/insights/summary', async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') ?? '200', 10) || 200, 1), 500);
  const rows = composeDashboardSessionRows();
  const overview = await buildSafeInsightOverview(rows.map(row => {
    const session = findSessionRecord(row.sessionId);
    return {
      cliId: row.cliId,
      sessionId: row.sessionId,
      cliSessionId: session?.cliSessionId,
      cwd: row.workingDir,
      workingDir: row.workingDir,
      title: row.title,
      botName: row.botName,
      larkAppId: row.larkAppId,
      status: row.status,
      lastMessageAt: row.lastMessageAt,
    };
  }), { limit });
  jsonRes(res, 200, { ok: true, overview });
});

// 部署 owner 的资料（名字 + 头像）——dashboard 左上角和历史弹窗展示「我」。
// owner 身份来自 deployment identity（ownerUnionId），头像经 contact API 查询
// （带缓存）；未绑定 owner 或查不到时回退名字/null。
ipcRoute('GET', '/api/owner-profile', async (_req, res) => {
  if (!cachedLarkAppId) return jsonRes(res, 503, { ok: false, error: 'larkAppId_not_set' });
  const me = getDeploymentIdentity(config.session.dataDir);
  if (!me.ownerUnionId) return jsonRes(res, 200, { ok: false, error: 'owner_unbound', name: me.ownerName ?? null });
  const p = await getUserProfile(cachedLarkAppId, me.ownerUnionId, 'union_id');
  jsonRes(res, 200, { ok: true, name: p?.name ?? me.ownerName ?? null, avatarUrl: p?.avatarUrl ?? null });
});

// 会话重命名：dashboard 看板卡片就地编辑 Botmux 的 canonical title；运行中的
// Codex/Claude Code 再收到一条 best-effort 原生 /rename，同步其 resume picker。
// 飞书话题标题不受影响。全视图（看板/状态板/表格/抽屉）读同一字段。
ipcRoute('POST', '/api/sessions/:sessionId/rename', async (req, res, params) => {
  let body: { title?: unknown; source?: unknown } & Record<string, unknown>;
  try { body = await readJsonBody(req); } catch { return jsonRes(res, 400, { ok: false, error: 'bad_json' }); }
  const active = findActiveBySessionId(params.sessionId);
  const auth = sessionCliIpcAuth(req, active, params.sessionId, body);
  if (!auth.ok) return jsonRes(res, 403, { ok: false, error: auth.error });
  const title = normalizeSessionTitle(body.title);
  if (!title) return jsonRes(res, 400, { ok: false, error: 'bad_title' });
  const session = active?.session ?? sessionStore.getOwnedSession(params.sessionId);
  if (!session) return jsonRes(res, 404, { ok: false, error: 'session_not_found' });
  const source = normalizeSessionTitleSource(body.source, 'dashboard');
  const updated = updateSessionTitle(session, title, source);
  if (!updated.ok) return jsonRes(res, 400, { ok: false, error: updated.error });
  const agentSync = active
    ? requestAgentSessionRename(active, updated.title)
    : { status: 'not_running' as const };
  jsonRes(res, 200, {
    ok: true,
    title: updated.title,
    titleUpdatedAt: updated.updatedAt,
    titleSource: updated.source,
    agentSync: agentSync.status,
  });
});

// 会话锁定：保护被锁定会话不被 dashboard「清理空闲」批量关闭。锁定是会话元数据，
// 不影响用户显式点击关闭/批量关闭，避免把会话变成不可管理状态。
ipcRoute('POST', '/api/sessions/:sessionId/lock', async (req, res, params) => {
  let body: { locked?: unknown };
  try { body = await readJsonBody(req); } catch { return jsonRes(res, 400, { ok: false, error: 'bad_json' }); }
  if (typeof body.locked !== 'boolean') return jsonRes(res, 400, { ok: false, error: 'bad_locked' });
  const session = findOwnedSessionRecord(params.sessionId);
  if (!session) return jsonRes(res, 404, { ok: false, error: 'session_not_found' });
  if (body.locked) session.locked = true;
  else delete session.locked;
  sessionStore.updateSession(session);
  const locked = !!session.locked;
  dashboardEventBus.publish({
    type: 'session.update',
    body: { sessionId: params.sessionId, patch: { locked } },
  });
  jsonRes(res, 200, { ok: true, locked });
});

/**
 * Mint the WRITABLE web-terminal link for a live session — the dashboard
 * counterpart to the Lark card's "🔑 获取操作链接" button. Returns the URL with
 * the worker's write `?token=` appended, built daemon-side via buildTerminalUrl
 * so it picks up this process's live terminal-proxy state (the dashboard
 * aggregator can't see it). The token is returned ONLY here, on demand —
 * deliberately never embedded in /api/sessions rows or the SSE stream.
 *
 * Two gates protect it: at the dashboard's HTTP boundary this path is absent
 * from the public allow-list, so an anonymous browser 401s; and here on the
 * daemon IPC, ipcHmacAuthorized requires a loopback-HMAC signed with
 * .dashboard-secret, so a local process that merely knows the ipcPort still
 * can't pull a write token.
 */
ipcRoute('GET', '/api/sessions/:sessionId/write-link', (req, res, params) => {
  if (!ipcHmacAuthorized(req)) return jsonRes(res, 401, { ok: false, error: 'unauthorized' });
  const ds = findActiveBySessionId(params.sessionId);
  if (!ds) return jsonRes(res, 404, { ok: false, error: 'session_not_active' });
  if (!sessionSupportsWebTerminal(ds)) {
    return jsonRes(res, 409, { ok: false, error: 'terminal_unsupported' });
  }
  // Riff backend: the sandbox URL is the writable link — no local worker needed.
  if (ds.riffAccessUrl) {
    jsonRes(res, 200, { ok: true, url: ds.riffAccessUrl });
    return;
  }
  const port = ds.workerPort ?? ds.session.webPort;
  if (!port || !ds.workerToken) return jsonRes(res, 409, { ok: false, error: 'terminal_unavailable' });
  jsonRes(res, 200, { ok: true, url: buildTerminalUrl(ds, { write: true }) });
});

/**
 * Read-only twin of write-link: the base capability URL the Feishu card's
 * 「打开 Web 终端」button also hands out (viewToken, never the write token).
 * The viewToken here is the worker's PER-BOOT card token — it dies with the
 * worker generation and is deliberately not bound to any dashboard auth
 * session. The central dashboard therefore REPLACES it with a short-lived
 * signed read grant bound to the requesting identity before answering its own
 * /api/sessions/:id/view-link (P1-5); this loopback-HMAC route never reaches a
 * browser directly. That grant is also PINNED to the boot generation derived
 * from this very token, so the value must be present and current — a live port
 * left over from a previous boot (persisted `session.webPort` outliving the
 * worker) is not enough. Same guard shape as write-link.
 *
 * Knowing any view capability never grants terminal input, so the link stays
 * read-only by construction rather than by UI convention.
 */
ipcRoute('GET', '/api/sessions/:sessionId/view-link', (req, res, params) => {
  if (!ipcHmacAuthorized(req)) return jsonRes(res, 401, { ok: false, error: 'unauthorized' });
  const ds = findActiveBySessionId(params.sessionId);
  if (!ds) return jsonRes(res, 404, { ok: false, error: 'session_not_active' });
  const port = ds.workerPort ?? ds.session.webPort;
  if (!port || !ds.workerViewToken) return jsonRes(res, 409, { ok: false, error: 'terminal_unavailable' });
  jsonRes(res, 200, { ok: true, url: buildTerminalUrl(ds) });
});

/**
 * Dashboard「复现命令」：返回该 active session 本次冷启的**近似**可复现 CLI 调用
 * （bin + argv + cwd + 权威注入 env），供用户粘到调试终端改参数复现。命令原样保留
 * （含 write token / --append-system-prompt / 凭证 env），与 write-link 同一把
 * loopback-HMAC 锁：匿名浏览器在 dashboard HTTP 边界就 401（该路径不在 allow-list），
 * 本机知道 ipcPort 的进程也过不了 ipcHmacAuthorized。仅持管理 cookie 的写权限视图能取。
 *
 * 只读 active session 的**内存**字段（DaemonSession.spawnCommand）：命令含凭证，
 * 绝不落盘，也绝不从 closed/持久化 session 取（那既无值也避免误暴露）。daemon 重启后
 * 到 worker 再次 ready 之前返回 unavailable——可接受。warm reattach 不重算命令，此时
 * 亦为空。riff 后端无本地 bin/args，worker 侧不产出命令，这里同样 unavailable。
 */
ipcRoute('GET', '/api/sessions/:sessionId/spawn-command', (req, res, params) => {
  if (!ipcHmacAuthorized(req)) return jsonRes(res, 401, { ok: false, error: 'unauthorized' });
  const ds = findActiveBySessionId(params.sessionId);
  if (!ds) return jsonRes(res, 404, { ok: false, error: 'session_not_active' });
  const cmd = ds.spawnCommand;
  if (!cmd) return jsonRes(res, 404, { ok: false, error: 'spawn_command_unavailable' });
  jsonRes(res, 200, { ok: true, command: cmd });
});

/**
 * Deliver the writable-terminal card privately to the bot's owner(s) — the
 * `botmux term-link <id>` CLI command's backend. Unlike the GET route above
 * (which returns the URL to its single authenticated caller), this POSTs the
 * card into the owners' private Lark channels (ephemeral → DM fallback) and
 * returns ONLY delivery counts: the write token never crosses back to the CLI /
 * stdout. Same loopback-HMAC gate as write-link — it still hands out a control
 * credential, just into Lark rather than into the HTTP response.
 */
ipcRoute('POST', '/api/sessions/:sessionId/write-link-card', async (req, res, params) => {
  if (!ipcHmacAuthorized(req)) return jsonRes(res, 401, { ok: false, error: 'unauthorized' });
  const ds = findActiveBySessionId(params.sessionId);
  if (!ds) return jsonRes(res, 404, { ok: false, error: 'session_not_active' });
  if (sessionTransportDisabled(ds)) return jsonRes(res, 200, { ok: false, error: 'no_feishu_transport' });
  const r = await deliverWriteLinkCardToOwners(ds);
  const status = r.ok ? 200
    : r.error === 'terminal_unavailable' || r.error === 'terminal_unsupported' ? 409
    : r.error === 'no_owner' ? 422
    : 502;
  jsonRes(res, status, r);
});

// ─── Sandbox landing (owner reviews the clone's diff then applies it back) ───
function workingDirForSession(sessionId: string): string | undefined {
  const ds = findActiveBySessionId(sessionId);
  if (ds) return ds.session.workingDir;
  return sessionStore.listSessions().find(s => s.sessionId === sessionId)?.workingDir;
}

/**
 * Reactivate a closed session — counterpart to `/close`. Used by both the
 * "▶️ 恢复会话" card button (via card-handler) and the `botmux resume <id>`
 * CLI command (via this HTTP route). The CLI route also drops a notice into
 * the original Lark thread so users see why the session is alive again.
 */
ipcRoute('POST', '/api/sessions/:sessionId/resume', async (req, res, params) => {
  const sessionId = params.sessionId;
  const sourceSession = findSessionRecord(sessionId);
  if (!sourceSession) return jsonRes(res, 404, { ok: false, error: 'not_found' });
  // Legacy persisted sessions may carry an empty larkAppId and are hydrated
  // with this daemon's identity by resumeSession. Use the same fallback for
  // admission instead of rejecting an otherwise valid recovery record.
  const larkAppId = sourceSession.larkAppId || cachedLarkAppId || '__legacy_unbound__';
  return withBotTurnAdmission(larkAppId, async () => {
  const reg = getActiveSessionsRegistry();
  if (!reg) return jsonRes(res, 503, { ok: false, error: 'registry_unavailable' });
  const result = await resumeSession(sessionId, reg);
  if (!result.ok) {
    const status = result.error === 'not_found' ? 404 : 409;
    return jsonRes(res, status, { ok: false, error: result.error, activeSessionId: result.activeSessionId });
  }

  const ds = result.ds;
  // `?wake=1` is an opt-in operational hook (no UI/CLI caller wires it today —
  // it's meant for direct `curl` recovery): instead of the default lazy
  // cold-resume on the next inbound message, fork the worker immediately so the
  // session is usable right away. Off by default keeps every existing caller's
  // behaviour unchanged.
  const wake = new URL(req.url ?? '/', 'http://localhost').searchParams.get('wake') === '1';
  // Tell the dashboard the row flipped back to active (mirror of session.update
  // emitted by closeSession). Use `null` for closedAt — `undefined` would be
  // dropped by JSON.stringify on the SSE wire and the aggregator's spread
  // (`{...cur, ...patch}`) would leave the stale closedAt in place.
  dashboardEventBus.publish({
    type: 'session.update',
    body: {
      sessionId,
      patch: { status: 'active', closedAt: null },
    },
  });

  // Notify the original chat so humans see why the session is alive again.
  // Routing follows session.scope — thread-scope replies into the thread root
  // (reply_in_thread=true), chat-scope posts a plain message to the chat (any
  // reply_in_thread call would silently get rejected or land on a stale root).
  const cliId = ds.session.cliId;
  const botCfg = ds.larkAppId ? getBot(ds.larkAppId).config : undefined;
  const cliName = sessionConfiguredRuntimeDisplayName(ds.session, botCfg?.cliRuntime)
    ?? getCliDisplayName(cliId ?? botCfg?.cliId ?? 'claude-code');
  const notice = JSON.stringify({ text: `🔄 会话已通过命令行恢复，发条消息继续与 ${cliName} 对话。` });
  if (ds.larkAppId && !sessionTransportDisabled(ds)) {
    if (ds.scope === 'chat' && ds.chatId) {
      getChatMode(ds.larkAppId, ds.chatId, { forceRefresh: true })
        .then((mode) => mode === 'topic' && ds.session.rootMessageId
          ? replyMessage(ds.larkAppId, ds.session.rootMessageId, notice, 'text', true)
          : sendMessage(ds.larkAppId, ds.chatId, notice, 'text'))
        .catch(err => logger.debug(`[resume] failed to post chat-scope resume notice: ${err}`));
    } else if (ds.session.rootMessageId) {
      replyMessage(ds.larkAppId, ds.session.rootMessageId, notice, 'text', true)
        .catch(err => logger.debug(`[resume] failed to post thread-scope resume notice: ${err}`));
    }
  }

  // Report the EFFECTIVE action, not the raw request flag: only fork when wake
  // was asked AND there's no live worker to clobber. (resumeSession always hands
  // back a worker:null ds today, so this matches `wake` in practice — but
  // reporting the action keeps the response honest if the guard ever broadens.)
  const woke = wake && (!ds.worker || ds.worker.killed);
  if (woke) {
    forkWorker(ds, '', true);
  }

  jsonRes(res, 200, {
    ok: true,
    sessionId,
    wake: woke,
    title: ds.session.title,
    chatId: ds.chatId,
    rootMessageId: ds.session.rootMessageId,
    workingDir: ds.session.workingDir,
    cliId,
  });
  });
});

/**
 * Cross-daemon session transfer endpoint.
 *
 * Called by a *leader* daemon during `/relay --create` to instruct *peer*
 * daemons to migrate their own session (located by `sourceAnchor`) into a
 * newly-created chat. The peer daemon authenticates the request and runs its
 * own `transferSession()` internally — the leader never touches another
 * daemon's process / tmux / jsonl directly.
 *
 * Security:
 *   - Only accepts requests from 127.0.0.1 (no remote daemon coordination).
 *   - `requesterLarkAppId` must be a known bot in this machine's bots
 *     registry. The threat model assumes a malicious bot daemon process is
 *     already root-equivalent on the box; this check just prevents random
 *     other 127.0.0.1 processes from forging migrations.
 *   - `sourceAnchor` must match a session currently owned by *this* daemon
 *     (peer can only move its own sessions — never anybody else's).
 *   - Owner-only: only the original session owner may relocate the session.
 *
 * The leader passes `targetRootMessageId` — typically the leader's M1
 * notification message — so the peer's session lands anchored on a real
 * message in the new chat. Since the new chat is always chat-scope, the
 * rootMessageId is only used for audit / display, not routing.
 */
ipcRoute('POST', '/api/sessions/migrate-to-chat', async (req, res) => {
  const remote = req.socket.remoteAddress;
  // node may report '127.0.0.1' or '::ffff:127.0.0.1' (IPv4 mapped) or '::1'.
  const localish = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
  if (!localish) return jsonRes(res, 403, { ok: false, error: 'not_local' });

  let body: {
    sourceAnchor?: string;
    targetChatId?: string;
    targetRootMessageId?: string;
    requesterLarkAppId?: string;
    requestingUserOpenId?: string;
    requestingUserUnionId?: string;
  };
  try {
    body = await readJsonBody(req);
  } catch {
    return jsonRes(res, 400, { ok: false, error: 'invalid_json' });
  }
  const { sourceAnchor, targetChatId, targetRootMessageId, requesterLarkAppId, requestingUserOpenId, requestingUserUnionId } = body;
  if (!sourceAnchor || !targetChatId || !targetRootMessageId || !requesterLarkAppId || !requestingUserOpenId) {
    return jsonRes(res, 400, { ok: false, error: 'missing_field' });
  }

  // Requester must be a live botmux daemon — not a random localhost process
  // pretending to be one. We check the cross-process daemon registry
  // (~/.botmux/data/dashboard-daemons/<larkAppId>.json + heartbeat) rather
  // than this process's local bot list: in production each bot has its own
  // daemon process, and a per-process `getAllBots()` only sees its OWN bot
  // (botmux is one-daemon-per-bot at boot, daemon.ts:2367). Using the
  // registry lets the peer recognise the leader bot.
  const requesterKnown = listOnlineDaemons().some(d => d.larkAppId === requesterLarkAppId);
  if (!requesterKnown) return jsonRes(res, 403, { ok: false, error: 'unknown_requester' });

  // Locate this daemon's own session at the given source anchor. We match
  // by anchor (rootMessageId for thread-scope, chatId for chat-scope) AND
  // larkAppId — multi-bot threads share a rootMessageId but each bot's
  // session is uniquely keyed by (anchor, larkAppId).
  const reg = getActiveSessionsRegistry();
  if (!reg) return jsonRes(res, 503, { ok: false, error: 'registry_unavailable' });

  let ds: ReturnType<typeof findActiveBySessionId> = undefined;
  for (const candidate of reg.values()) {
    const candAnchor = sessionAnchorId(candidate);
    if (candAnchor === sourceAnchor && candidate.larkAppId === cachedLarkAppId) {
      ds = candidate;
      break;
    }
  }
  if (!ds) return jsonRes(res, 404, { ok: false, error: 'no_session_at_anchor' });

  // Owner-only: the user who triggered /relay --create must own this peer's
  // session too. If a peer's session is owned by someone else, we refuse —
  // the leader summarises this as "skipped: not your session" rather than
  // forcing a transfer of someone else's work.
  //
  // Cross-app identity: Lark `open_id` is app-scoped — the same user has a
  // different open_id in each bot's namespace, so leader's senderOpenId
  // and peer's stored ownerOpenId cannot be compared directly. Prefer
  // `union_id` (stable across apps within a tenant) when both sides have
  // it. Sessions persisted before ownerUnionId existed fall through to a
  // lazy backfill: resolve peer's stored open_id → union_id via Lark API
  // (using PEER's bot client, so the open_id is in the right namespace),
  // persist for next time, and compare.
  if (ds.session.ownerOpenId) {
    let peerOwnerUnionId = ds.session.ownerUnionId;
    if (!peerOwnerUnionId && requestingUserUnionId) {
      // Backfill: legacy session, look up the union_id via Lark API once
      // and persist it so subsequent comparisons (and any other code path
      // that grows to read it) are fast.
      const looked = await resolveUnionIdFromOpenId(ds.larkAppId, ds.session.ownerOpenId);
      if (looked) {
        peerOwnerUnionId = looked;
        ds.session.ownerUnionId = looked;
        sessionStore.updateSession(ds.session);
      }
    }
    const ownerMatch = (peerOwnerUnionId && requestingUserUnionId)
      ? peerOwnerUnionId === requestingUserUnionId
      // Same-bot fallback (no union_id on either side): open_id namespaces
      // match, so direct compare works.
      : ds.session.ownerOpenId === requestingUserOpenId;
    if (!ownerMatch) {
      return jsonRes(res, 403, { ok: false, error: 'not_session_owner' });
    }
  }

  // Target chat was built by the leader's /relay --create — by
  // construction a regular group, chat-scope (M1 is the audit anchor).
  const result = await transferSession(ds.session.sessionId, targetChatId, targetRootMessageId, 'group', 'chat');
  if (!result.ok) {
    return jsonRes(res, 500, { ok: false, error: result.error });
  }
  jsonRes(res, 200, { ok: true, sessionId: ds.session.sessionId });
});

ipcRoute('POST', '/api/sessions/:sessionId/locate', async (_req, res, params) => {
  const sid = params.sessionId;
  const acq = locateLimiter.tryAcquire(sid);
  if (!acq.ok) {
    res.writeHead(429, {
      'content-type': 'application/json',
      'retry-after': String(Math.ceil(acq.retryAfterMs / 1000)),
    });
    res.end(JSON.stringify({ ok: false, error: 'rate_limited', retryAfterMs: acq.retryAfterMs }));
    return;
  }
  // Resolve owning session (active first, then closed-store fallback). The
  // locate marker is a bare @-mention of the session's owner — no other text,
  // no AppLink redirect on the frontend. The notification on the user's
  // device is enough to navigate them back to the topic.
  const ds = findActiveBySessionId(sid);
  const closed = ds ? null : sessionStore.getSession(sid);
  const ctx = ds
    ? {
        larkAppId: ds.larkAppId,
        rootMessageId: ds.session.rootMessageId,
        ownerOpenId: ds.session.ownerOpenId,
      }
    : closed
      ? {
          larkAppId: closed.larkAppId ?? '',
          rootMessageId: closed.rootMessageId,
          ownerOpenId: closed.ownerOpenId,
        }
      : null;
  if (!ctx || !ctx.larkAppId) {
    return jsonRes(res, 404, { ok: false, error: 'session_not_found' });
  }
  if (!ctx.ownerOpenId) {
    return jsonRes(res, 422, { ok: false, error: 'no_owner' });
  }
  // No-transport session (apiOnly bot or HTTP virtual chat) has no Feishu thread
  // to @-locate the owner in — the replyMessage below would dial Feishu.
  if (sessionTransportDisabled({ chatId: ds?.chatId ?? closed?.chatId, larkAppId: ctx.larkAppId })) {
    return jsonRes(res, 200, { ok: false, error: 'no_feishu_transport' });
  }
  try {
    const messageId = await sendSessionOwnerThreadNotification({
      larkAppId: ctx.larkAppId,
      rootMessageId: ctx.rootMessageId,
      ownerOpenId: ctx.ownerOpenId,
    });
    jsonRes(res, 200, { ok: true, messageId });
  } catch (err) {
    jsonRes(res, 502, { ok: false, error: String(err) });
  }
});

// ─── Schedules ─────────────────────────────────────────────────────────────

export interface ScheduleRow {
  id: string;
  name: string;
  schedule: string;
  parsed: ParsedSchedule;
  prompt: string;
  workingDir: string;
  chatId: string;
  rootMessageId?: string;
  scope?: 'thread' | 'chat';
  executionPosition?: ScheduleExecutionPosition;
  topicTitle?: string;
  larkAppId?: string;
  botName?: string;
  enabled: boolean;
  createdAt: string;
  lastRunAt?: string;
  nextRunAt?: string;
  lastStatus?: 'ok' | 'error';
  lastError?: string;
  repeat?: { times: number | null; completed: number };
  deliver?: 'origin' | 'local' | 'new-topic';
  silent?: boolean;
  feishuChatLink: string;
}

function composeScheduleRow(t: ScheduledTask): ScheduleRow {
  return {
    id: t.id,
    name: t.name,
    schedule: t.schedule,
    parsed: t.parsed,
    prompt: t.prompt,
    workingDir: t.workingDir,
    chatId: t.chatId,
    rootMessageId: t.rootMessageId,
    scope: t.scope,
    executionPosition: scheduler.resolveTaskExecutionPosition(t),
    topicTitle: t.topicTitle,
    larkAppId: t.larkAppId,
    botName: getBotName(),
    enabled: t.enabled,
    createdAt: t.createdAt,
    lastRunAt: t.lastRunAt,
    nextRunAt: t.nextRunAt,
    lastStatus: t.lastStatus,
    lastError: t.lastError,
    repeat: t.repeat,
    deliver: t.deliver ?? 'origin',
    silent: t.silent,
    feishuChatLink: feishuChatLink(t.chatId, getBotBrand(t.larkAppId)),
  };
}

ipcRoute('GET', '/api/schedules', (_req, res) => {
  // Filter to tasks owned by this daemon's bot (multi-bot setups run one
  // daemon per bot — each only manages its own schedules).  belongsToOwner
  // falls through to "all tasks" when no owner filter is configured (tests).
  const all = scheduleStore.listTasks().filter(t => scheduler.belongsToOwner(t));
  jsonRes(res, 200, { schedules: all.map(composeScheduleRow) });
});

ipcRoute('POST', '/api/schedules/:id/run',    (_req, res, p) => jsonRes(res, 200, scheduler.runNow(p.id)));
ipcRoute('POST', '/api/schedules/:id/pause',  (_req, res, p) => jsonRes(res, 200, scheduler.setEnabled(p.id, false)));
ipcRoute('POST', '/api/schedules/:id/resume', (_req, res, p) => jsonRes(res, 200, scheduler.setEnabled(p.id, true)));
// Backward-compatible route used by Lark cards and cached dashboard clients.
// Modern callers send an exact target; body-less legacy callers keep the
// historical toggle behavior, now cycling topic → top-level → fresh topic.
ipcRoute('POST', '/api/schedules/:id/delivery', async (req, res, p) => {
  let body: unknown;
  try { body = await readJsonBody(req); } catch { return jsonRes(res, 400, { ok: false, error: 'invalid_json' }); }
  const requested = body && typeof body === 'object'
    ? (body as Record<string, unknown>).executionPosition
    : undefined;
  if (requested !== undefined) {
    if (requested !== 'top-level' && requested !== 'topic' && requested !== 'new-topic') {
      return jsonRes(res, 400, { ok: false, error: 'invalid_execution_position', field: 'executionPosition' });
    }
    const result = scheduler.updateTask(p.id, { executionPosition: requested });
    return jsonRes(res, 200, result.ok ? { ...result, executionPosition: requested } : result);
  }
  return jsonRes(res, 200, scheduler.toggleDelivery(p.id));
});

// Create a new scheduled task from the dashboard. chatId selects which chat
// the task fires into; workingDir defaults to the daemon's cwd.
ipcRoute('POST', '/api/schedules', async (req, res) => {
  if (!cachedLarkAppId) return jsonRes(res, 503, { ok: false, error: 'larkAppId_not_set' });
  let body: unknown;
  try { body = await readJsonBody(req); } catch { return jsonRes(res, 400, { ok: false, error: 'invalid_json' }); }
  if (body === null || typeof body !== 'object') {
    return jsonRes(res, 400, { ok: false, error: 'body_must_be_object' });
  }
  const b = body as Record<string, unknown>;
  // Runtime validation — never trust the TS cast alone.
  const name = typeof b.name === 'string' ? b.name.trim() : '';
  const schedule = typeof b.schedule === 'string' ? b.schedule.trim() : '';
  const prompt = typeof b.prompt === 'string' ? b.prompt : '';
  const chatId = typeof b.chatId === 'string' ? b.chatId.trim() : '';
  const rootMessageId = typeof b.rootMessageId === 'string' ? b.rootMessageId.trim() : '';
  // Validate silent type — if present, must be boolean (no silent degradation).
  let silent = false;
  if (b.silent !== undefined) {
    if (typeof b.silent !== 'boolean') {
      return jsonRes(res, 400, { ok: false, error: 'invalid_field', field: 'silent' });
    }
    silent = b.silent;
  }
  let executionPosition: ScheduleExecutionPosition = 'top-level';
  if (b.executionPosition !== undefined) {
    if (b.executionPosition !== 'top-level' && b.executionPosition !== 'topic' && b.executionPosition !== 'new-topic') {
      return jsonRes(res, 400, { ok: false, error: 'invalid_execution_position', field: 'executionPosition' });
    }
    executionPosition = b.executionPosition;
  }
  const topicTitle = typeof b.topicTitle === 'string' ? b.topicTitle.trim() : '';
  if (b.topicTitle !== undefined && typeof b.topicTitle !== 'string') {
    return jsonRes(res, 400, { ok: false, error: 'invalid_field', field: 'topicTitle' });
  }
  if (Array.from(topicTitle).length > 200) {
    return jsonRes(res, 400, { ok: false, error: 'topic_title_too_long', field: 'topicTitle' });
  }
  // Legacy clients sending deliver:new-topic retain the historical meaning:
  // open a fresh topic/session on every run.
  let deliver: 'origin' | 'new-topic' = 'origin';
  if (b.deliver !== undefined) {
    if (b.deliver !== 'origin' && b.deliver !== 'new-topic') {
      return jsonRes(res, 400, { ok: false, error: 'invalid_deliver', field: 'deliver' });
    }
    deliver = b.deliver;
    if (b.executionPosition === undefined && deliver === 'new-topic') executionPosition = 'new-topic';
  }
  // Validate required fields are present AND non-empty after trim.
  if (!name) return jsonRes(res, 400, { ok: false, error: 'invalid_field', field: 'name' });
  if (!schedule) return jsonRes(res, 400, { ok: false, error: 'invalid_field', field: 'schedule' });
  if (!prompt.trim()) return jsonRes(res, 400, { ok: false, error: 'invalid_field', field: 'prompt' });
  if (!chatId) return jsonRes(res, 400, { ok: false, error: 'invalid_field', field: 'chatId' });
  if (executionPosition === 'topic' && !rootMessageId) {
    return jsonRes(res, 400, { ok: false, error: 'topic_root_required', field: 'rootMessageId' });
  }
  // Note: bot↔chat membership is intentionally NOT validated here.
  // listChatBotMembers returns [] both when the API is unavailable and when
  // no bot has been observed in the chat yet, so we cannot reliably tell
  // "bot not in chat" (should 400) from "unknown" (should fail-open).
  // A task whose bot is not in the target chat will fail at fire time with
  // a clear lastError, which is the pre-existing behavior for CLI-created
  // tasks. Adding a flaky gate here would block valid creates.
  try {
    const task = scheduler.addTask({
      name,
      schedule,
      prompt,
      workingDir: typeof b.workingDir === 'string' ? b.workingDir : process.cwd(),
      chatId,
      // Only topic execution retains a root anchor; at top-level/new-topic the
      // root is dropped so it can never pull execution back into the topic the
      // schedule was created from (e.g. an adopted one).
      rootMessageId: executionPosition === 'topic' ? (rootMessageId || undefined) : undefined,
      scope: executionPosition === 'topic' ? 'thread' : 'chat',
      executionPosition,
      topicTitle: topicTitle || undefined,
      chatType: 'group',
      larkAppId: cachedLarkAppId,
      // Stamp the bot owner as creator: dashboard is local + token-protected,
      // and the daemon re-checks the owner is still allowed at every run
      // mutation (scheduled-turn-provenance).
      ownerOpenId: getOwnerOpenId(cachedLarkAppId),
      deliver,
      silent,
    });
    dashboardEventBus.publish({ type: 'schedule.created', body: { schedule: composeScheduleRow(task) } });
    jsonRes(res, 200, { ok: true, task: composeScheduleRow(task) });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    jsonRes(res, 400, { ok: false, error: msg });
  }
});

// Update editable fields of an existing task. Execution position is explicit;
// topic execution requires a retained/provided topic root message id.
ipcRoute('PATCH', '/api/schedules/:id', async (req, res, p) => {
  let body: unknown;
  try { body = await readJsonBody(req); } catch { return jsonRes(res, 400, { ok: false, error: 'invalid_json' }); }
  if (body === null || typeof body !== 'object') {
    return jsonRes(res, 400, { ok: false, error: 'body_must_be_object' });
  }
  const b = body as Record<string, unknown>;
  const updates: {
    name?: string; prompt?: string; schedule?: string;
    deliver?: 'origin' | 'new-topic'; silent?: boolean;
    executionPosition?: ScheduleExecutionPosition; rootMessageId?: string; topicTitle?: string;
  } = {};
  // If a field is present, it must be the correct type and (for strings)
  // non-empty after trim — otherwise 400, never silently ignore.
  if (b.name !== undefined) {
    if (typeof b.name !== 'string' || !b.name.trim()) {
      return jsonRes(res, 400, { ok: false, error: 'invalid_field', field: 'name' });
    }
    updates.name = b.name.trim();
  }
  if (b.prompt !== undefined) {
    if (typeof b.prompt !== 'string' || !b.prompt.trim()) {
      return jsonRes(res, 400, { ok: false, error: 'invalid_field', field: 'prompt' });
    }
    updates.prompt = b.prompt;
  }
  if (b.schedule !== undefined) {
    if (typeof b.schedule !== 'string' || !b.schedule.trim()) {
      return jsonRes(res, 400, { ok: false, error: 'invalid_field', field: 'schedule' });
    }
    updates.schedule = b.schedule.trim();
  }
  if (b.deliver !== undefined) {
    if (b.deliver !== 'origin' && b.deliver !== 'new-topic') {
      return jsonRes(res, 400, { ok: false, error: 'invalid_deliver', field: 'deliver' });
    }
    updates.deliver = b.deliver;
  }
  if (b.executionPosition !== undefined) {
    if (b.executionPosition !== 'top-level' && b.executionPosition !== 'topic' && b.executionPosition !== 'new-topic') {
      return jsonRes(res, 400, { ok: false, error: 'invalid_execution_position', field: 'executionPosition' });
    }
    updates.executionPosition = b.executionPosition;
  }
  if (b.rootMessageId !== undefined) {
    if (typeof b.rootMessageId !== 'string') {
      return jsonRes(res, 400, { ok: false, error: 'invalid_field', field: 'rootMessageId' });
    }
    updates.rootMessageId = b.rootMessageId.trim();
  }
  if (b.topicTitle !== undefined) {
    if (typeof b.topicTitle !== 'string') {
      return jsonRes(res, 400, { ok: false, error: 'invalid_field', field: 'topicTitle' });
    }
    const topicTitle = b.topicTitle.trim();
    if (Array.from(topicTitle).length > 200) {
      return jsonRes(res, 400, { ok: false, error: 'topic_title_too_long', field: 'topicTitle' });
    }
    updates.topicTitle = topicTitle;
  }
  if (b.silent !== undefined) {
    if (typeof b.silent !== 'boolean') {
      return jsonRes(res, 400, { ok: false, error: 'invalid_field', field: 'silent' });
    }
    updates.silent = b.silent;
  }
  const result = scheduler.updateTask(p.id, updates);
  if (!result.ok) return jsonRes(res, 400, result);
  const task = scheduleStore.getTask(p.id);
  jsonRes(res, 200, { ok: true, task: task ? composeScheduleRow(task) : undefined });
});

// Delete a scheduled task.
ipcRoute('DELETE', '/api/schedules/:id', (_req, res, p) => {
  jsonRes(res, 200, scheduler.removeTaskForDashboard(p.id));
});
ipcRoute('GET', '/api/goals', (_req, res) => {
  jsonRes(res, 200, buildGoalBoard());
});

ipcRoute('GET', '/api/goals/attention', (req, res) => {
  const url = new URL(req.url ?? '/api/goals/attention', 'http://127.0.0.1');
  const chatId = url.searchParams.get('chatId')?.trim() || undefined;
  const board = buildGoalAttentionBoardWithContext({ chatId });
  const liveRisks = buildLocalGoalAttentionLiveRisks({
    board,
    activeSessions: getActiveSessionsRegistry(),
    larkAppId: cachedLarkAppId,
  });
  jsonRes(res, 200, withGoalAttentionLiveRisks(board, liveRisks));
});

ipcRoute('GET', '/api/goals/attention/live', (req, res) => {
  const url = new URL(req.url ?? '/api/goals/attention/live', 'http://127.0.0.1');
  const chatId = url.searchParams.get('chatId')?.trim() || undefined;
  const board = buildGoalAttentionBoardWithContext({ chatId });
  const liveRisks = buildLocalGoalAttentionLiveRisks({
    board,
    activeSessions: getActiveSessionsRegistry(),
    larkAppId: cachedLarkAppId,
  });
  jsonRes(res, 200, { systemRisk: liveRisks });
});

ipcRoute('POST', '/api/schedules/:id/run',    (_req, res, p) => jsonRes(res, 200, scheduler.runNow(p.id)));
ipcRoute('POST', '/api/schedules/:id/pause',  (_req, res, p) => jsonRes(res, 200, scheduler.setEnabled(p.id, false)));
ipcRoute('POST', '/api/schedules/:id/resume', (_req, res, p) => jsonRes(res, 200, scheduler.setEnabled(p.id, true)));
// Toggle delivery mode between 'origin' (reply in original thread) and
// 'new-topic' (open a brand-new topic + fresh session on every fire).
ipcRoute('POST', '/api/schedules/:id/delivery', (_req, res, p) => jsonRes(res, 200, scheduler.toggleDelivery(p.id)));

ipcRoute('POST', '/api/trigger', async (req, res) => {
  if (!cachedLarkAppId) return jsonRes(res, 503, { ok: false, errorCode: 'bot_not_found', error: 'larkAppId_not_set' });
  const activeSessions = getActiveSessionsRegistry();
  if (!activeSessions) return jsonRes(res, 503, { ok: false, errorCode: 'trigger_failed', error: 'active session registry unavailable' });
  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch {
    return jsonRes(res, 400, { ok: false, errorCode: 'bad_json', error: 'invalid JSON body' });
  }
  const valid = validateTriggerRequest(body);
  if (!valid.ok) return jsonRes(res, valid.status, valid.body);
  if (valid.request.target.botId && valid.request.target.botId !== cachedLarkAppId) {
    return jsonRes(res, 400, {
      ok: false,
      errorCode: 'bot_not_found',
      error: `request target botId ${valid.request.target.botId} does not match daemon ${cachedLarkAppId}`,
    });
  }
  // Plan B: a VC meeting agent is an ordinary chat-scope session, so the generic
  // trigger endpoint may address it like any session (botmux send / dashboard).
  // Meeting transcript deliveries still flow through their own fenced delivery
  // path — this endpoint only ever carries ordinary user-initiated turns.
  try {
    if (valid.request.target.kind === 'workflow') {
      return jsonRes(res, 410, {
        ok: false,
        errorCode: 'legacy_workflow_retired',
        error: 'v2 workflow trigger targets are retired; migrate the definition and run it through /workflow',
      });
    }
    const activeSessions = getActiveSessionsRegistry();
    if (!activeSessions) {
      return jsonRes(res, 503, {
        ok: false,
        errorCode: 'trigger_failed',
        error: 'active session registry unavailable',
      });
    }
    const result = await triggerSessionTurn(valid.request, { larkAppId: cachedLarkAppId, activeSessions });
    const status = result.ok
      ? 200
      // An idempotent retry that resolves to a durable `failed` async state is a
      // successful HTTP call reporting a terminal outcome (like a 200 completed/
      // queued), not a request error — surface it 200 so the caller reads `state`.
      : result.state === 'failed'
        ? 200
      : result.errorCode === 'idempotency_conflict'
        ? 409
      : result.errorCode === 'bot_not_in_chat'
        ? 403
        : result.errorCode === 'session_not_found'
          ? 404
        : result.errorCode === 'wait_timeout'
          ? 504
        : result.errorCode === 'target_required' || result.errorCode === 'bad_request'
          ? 400
          : 500;
    return jsonRes(res, status, result);
  } catch (e: any) {
    return jsonRes(res, 500, { ok: false, errorCode: 'trigger_failed', error: e?.message ?? String(e) });
  }
});

// ─── Exact chat grants (talk-only) ─────────────────────────────────────────

/**
 * Apply/read/revoke a receiver-scoped chatGrant. The receiver identity comes
 * from this daemon's cached larkAppId, never from the caller. The body repeats
 * it only as an anti-misrouting assertion (e.g. a stale daemon descriptor).
 *
 * This permission write is loopback-HMAC protected: a sandboxed worker that
 * merely discovers an ipcPort must not be able to grant itself access.
 */
ipcRoute('POST', '/api/grants/chat', async (req, res) => {
  const localPort = req.socket.localPort;
  const authBind = localPort ? cliAuthBind('POST', '/api/grants/chat', localPort) : undefined;
  if (!authBind || !tokenRouteAuthorized(req, authBind)) {
    return jsonRes(res, 401, { ok: false, error: 'unauthorized' });
  }
  if (!cachedLarkAppId) {
    return jsonRes(res, 503, { ok: false, error: 'larkAppId_not_set' });
  }
  let body: {
    operation?: unknown;
    receiverLarkAppId?: unknown;
    chatId?: unknown;
    subjectOpenIds?: unknown;
    subjectLarkAppIds?: unknown;
  };
  try {
    body = await readJsonBody(req);
  } catch {
    return jsonRes(res, 400, { ok: false, error: 'bad_json' });
  }
  if (body.receiverLarkAppId !== cachedLarkAppId) {
    return jsonRes(res, 409, {
      ok: false,
      error: 'receiver_mismatch',
      receiverLarkAppId: cachedLarkAppId,
    });
  }
  const hasSubjectOpenIds = Object.prototype.hasOwnProperty.call(body, 'subjectOpenIds');
  const hasSubjectLarkAppIds = Object.prototype.hasOwnProperty.call(body, 'subjectLarkAppIds');
  if (hasSubjectOpenIds === hasSubjectLarkAppIds) {
    return jsonRes(res, 400, {
      ok: false,
      error: 'exactly_one_subject_identity_required',
      message: 'Provide exactly one of subjectOpenIds or subjectLarkAppIds',
    });
  }
  if (hasSubjectLarkAppIds && body.operation !== 'grant') {
    return jsonRes(res, 400, {
      ok: false,
      error: 'subject_lark_app_ids_grant_only',
      message: 'subjectLarkAppIds may only be used with operation=grant',
    });
  }
  const result = hasSubjectLarkAppIds
    ? await exactChatGrantHandler({
        operation: body.operation,
        receiverLarkAppId: cachedLarkAppId,
        chatId: body.chatId,
        subjectLarkAppIds: body.subjectLarkAppIds,
      })
    : await exactChatGrantHandler({
        operation: body.operation,
        receiverLarkAppId: cachedLarkAppId,
        chatId: body.chatId,
        subjectOpenIds: body.subjectOpenIds,
      });
  if (!result.ok) {
    const { status, ...responseBody } = result;
    return jsonRes(res, status, responseBody);
  }
  return jsonRes(res, 200, result);
});

// ─── Groups (Phase B) ──────────────────────────────────────────────────────

function currentBotForGroups() {
  if (!cachedLarkAppId) return null;
  let bot: ReturnType<typeof getBot> | null = null;
  try {
    bot = getBot(cachedLarkAppId);
  } catch {
    // Tests and older daemon startup windows can have larkAppId before the
    // registry entry is hydrated. Keep /api/groups best-effort.
  }
  return {
    larkAppId: cachedLarkAppId,
    botOpenId: getBotOpenId(cachedLarkAppId),
    botName: getBotName() || bot?.botName || cachedLarkAppId,
    cliId: bot?.config?.cliId,
    defaultOncall: bot?.config?.defaultOncall,
  };
}

ipcRoute('GET', '/api/groups', async (_req, res) => {
  if (!cachedLarkAppId) return jsonRes(res, 503, { error: 'larkAppId_not_set' });
  try {
    const chats = await groupsStore.listChats(cachedLarkAppId);
    // Stamp a firstSeenAt timestamp for every chat (preserve existing values,
    // backfill new ones with Date.now()). Lark doesn't expose chat create_time
    // anywhere, so the dashboard sorts by this client-side proxy instead.
    const seenMap = chatFirstSeenStore.markSeenBulk(chats.map(c => c.chatId));
    // Annotate each chat with its oncall binding (if any) so the dashboard
    // matrix can show toggle state without a second round-trip.
    const enriched = chats.map(c => {
      const oncall = oncallStore.getOncallStatus(cachedLarkAppId, c.chatId);
      const hasRole = resolveRoleFile(cachedLarkAppId, c.chatId) !== null;
      const hasMessageListener = getMessageListenerConfig(cachedLarkAppId, c.chatId)?.enabled === true;
      // /introduce 记录的外部 botmux 机器人（按名字）——dashboard 团队看板用
      // 它识别「介绍过同团队机器人的协作群」。
      const observedBotNames = observedBotsStore
        .listObservedBots(config.session.dataDir, cachedLarkAppId, c.chatId)
        .map(b => b.name);
      return {
        ...c,
        oncallChat: oncall ?? null,
        firstSeenAt: seenMap.get(c.chatId) ?? null,
        hasRole,
        hasMessageListener,
        observedBotNames,
        // 会话群分型（p2pMode=group 自动创建）：dashboard 群面板据此把它们
        // 收进独立折叠区，避免淹没需要人工管理的常驻群。
        ...(isSessionGroup(c.chatId) ? { sessionGroup: true } : {}),
      };
    });
    const selfBot = currentBotForGroups();
    jsonRes(res, 200, { chats: enriched, bots: selfBot ? [selfBot] : [] });
  } catch (e) {
    jsonRes(res, 502, { error: String(e) });
  }
});

ipcRoute('GET', '/api/groups/:chatId/membership', async (_req, res, p) => {
  if (!cachedLarkAppId) return jsonRes(res, 503, { error: 'larkAppId_not_set' });
  try {
    const inChat = await groupsStore.isInChat(cachedLarkAppId, p.chatId);
    jsonRes(res, 200, { inChat });
  } catch (e) {
    jsonRes(res, 502, { error: String(e) });
  }
});

ipcRoute('POST', '/api/groups/:chatId/add-bots', async (req, res, p) => {
  if (!cachedLarkAppId) return jsonRes(res, 503, { error: 'larkAppId_not_set' });
  let body: { larkAppIds?: unknown };
  try {
    body = await readJsonBody<{ larkAppIds?: string[] }>(req);
  } catch {
    return jsonRes(res, 400, { error: 'bad_json' });
  }
  if (!Array.isArray(body.larkAppIds) || !body.larkAppIds.every(x => typeof x === 'string')) {
    return jsonRes(res, 400, { error: 'larkAppIds_required' });
  }
  try {
    const result = await groupsStore.addBotToChat(cachedLarkAppId, p.chatId, body.larkAppIds as string[]);
    jsonRes(res, 200, { result });
  } catch (e) {
    jsonRes(res, 502, { error: String(e) });
  }
});

// Disband (delete) a chat from this bot's identity. Public route picks an
// in-chat bot as the executor; this just performs the call.
ipcRoute('POST', '/api/groups/:chatId/disband', async (_req, res, p) => {
  if (!cachedLarkAppId) return jsonRes(res, 503, { error: 'larkAppId_not_set' });
  const r = await groupsStore.disbandChat(cachedLarkAppId, p.chatId);
  jsonRes(res, 200, r);
});

// Make this bot leave the chat. Always works on a member bot per Lark docs.
ipcRoute('POST', '/api/groups/:chatId/leave', async (_req, res, p) => {
  if (!cachedLarkAppId) return jsonRes(res, 503, { error: 'larkAppId_not_set' });
  const r = await groupsStore.leaveChat(cachedLarkAppId, p.chatId);
  jsonRes(res, 200, r);
});

// 平台团队大厅打卡：dashboard 在 team-sync 后编排本机 bot 往大厅（bot-only 群）
// 发登记消息。实测大厅只有「直接点名 @」会投递（普通消息/自 @/@all 全部静默），
// 所以打卡消息点名 @ 本机其他未入册 bot（mentionNames，open_id 由本 app 的
// cross-ref 解析——open_id 是 per-app 的，只有发送方自己能解析），被点到的 bot
// 从 mentions 学到自己的 union_id。回声路径保留（有 receive-all scope 的应用仍可
// 从自家消息学）。已入册且无人可教时幂等跳过。
ipcRoute('POST', '/api/platform/hall-announce', async (req, res) => {
  if (!cachedLarkAppId) return jsonRes(res, 503, { ok: false, error: 'larkAppId_not_set' });
  let body: { chatId?: unknown; mentionNames?: unknown };
  try { body = await readJsonBody(req); } catch { return jsonRes(res, 400, { ok: false, error: 'bad_json' }); }
  const chatId = typeof body.chatId === 'string' ? body.chatId.trim() : '';
  if (!/^oc_[0-9a-f]+$/i.test(chatId)) return jsonRes(res, 400, { ok: false, error: 'bad_chat_id' });
  const mentionNames = Array.isArray(body.mentionNames)
    ? body.mentionNames.filter((x): x is string => typeof x === 'string' && !!x.trim())
    : [];
  // 解析点名目标：name → 本 app 视角的 open_id（cross-ref，来自历史 @ 事件）。解析不到的跳过。
  const resolved: Array<{ name: string; openId: string }> = [];
  if (mentionNames.length) {
    try {
      const map: Record<string, string> = JSON.parse(
        readFileSync(join(config.session.dataDir, `bot-openids-${cachedLarkAppId}.json`), 'utf-8'),
      );
      for (const name of mentionNames) {
        const openId = map[name];
        if (typeof openId === 'string' && openId.startsWith('ou_')) resolved.push({ name, openId });
      }
    } catch { /* 无 cross-ref → 全部解析失败，退化为普通打卡 */ }
  }
  if (getBotUnionId(config.session.dataDir, cachedLarkAppId) && resolved.length === 0) {
    return jsonRes(res, 200, { ok: true, skipped: 'already_learned' });
  }
  try {
    const atPrefix = resolved.map((r) => `<at user_id="${r.openId}">${r.name}</at> `).join('');
    // 自己还没入册 → 带 #hall-echo 请求回执：被点到的 bot 会 @ 回我们一次，
    // 我们从回执的 mentions[] 学到自己的 union_id（见 event-dispatcher hall 分支）。
    const echoTag = getBotUnionId(config.session.dataDir, cachedLarkAppId) ? '' : ' #hall-echo';
    await sendMessage(cachedLarkAppId, chatId, atPrefix + t('platform.hall_announce', undefined, localeForBot(cachedLarkAppId)) + echoTag, 'text');
    jsonRes(res, 200, { ok: true, mentioned: resolved.map((r) => r.name), unresolved: mentionNames.filter((n) => !resolved.some((r) => r.name === n)) });
  } catch (e) {
    jsonRes(res, 502, { ok: false, error: `send_failed: ${(e as Error).message}` });
  }
});

// ─── Oncall bindings (dashboard) ───────────────────────────────────────────
// PUT  /api/oncall/:chatId  body: {workingDir} — bind or update workingDir
// DELETE /api/oncall/:chatId — unbind
//
// Auth: dashboard's loopback token is the gate. No per-chat owner concept —
// allowedUsers governs who can operate via Lark too (see canOperate).

ipcRoute('PUT', '/api/oncall/:chatId', async (req, res, p) => {
  if (!cachedLarkAppId) return jsonRes(res, 503, { error: 'larkAppId_not_set' });
  let body: { workingDir?: unknown };
  try { body = await readJsonBody<{ workingDir?: string }>(req); }
  catch { return jsonRes(res, 400, { ok: false, error: 'bad_json' }); }
  const workingDir = typeof body.workingDir === 'string' ? body.workingDir.trim() : '';
  if (!workingDir) return jsonRes(res, 400, { ok: false, error: 'workingDir_required' });

  // Same validation as /oncall bind in Lark — exists + is a directory.
  const v = validateWorkingDir(workingDir);
  if (!v.ok) return jsonRes(res, 400, { ok: false, error: v.error });
  const resolvedPath = v.resolvedPath;

  const r = await oncallStore.bindOncall(cachedLarkAppId, p.chatId, workingDir);
  if (!r.ok) return jsonRes(res, 400, r);
  jsonRes(res, 200, { ok: true, entry: r.entry, created: r.created, resolvedPath });
});

ipcRoute('DELETE', '/api/oncall/:chatId', async (_req, res, p) => {
  if (!cachedLarkAppId) return jsonRes(res, 503, { error: 'larkAppId_not_set' });
  // Idempotent: always succeeds. unbindOncall writes a tombstone into
  // defaultOncallAutoboundChats so the auto-bind judge won't reinstate this
  // chat on the next observation, even if it had no prior binding.
  const r = await oncallStore.unbindOncall(cachedLarkAppId, p.chatId);
  if (!r.ok) return jsonRes(res, 400, r);
  jsonRes(res, 200, { ok: true, wasBound: r.wasBound });
});

// ─── Role management (dashboard) ───────────────────────────────────────────
// POST   /api/roles/batch   body: {chatIds: string[]} → role snapshots
// GET    /api/roles/:chatId  → role, injection, and dispatch-completion settings
// PUT    /api/roles/:chatId  body: {content?, injectMode?, dispatchCompletionEnabled?}
// DELETE /api/roles/:chatId  → remove role file and metadata

const MAX_ROLE_BATCH_CHAT_IDS = 1_000;

function dashboardRolePayload(larkAppId: string, chatId: string): Record<string, unknown> {
  const content = resolveRoleFile(larkAppId, chatId);
  const effective = resolveRole(larkAppId, chatId);
  return {
    chatId,
    content,
    byteLength: content ? Buffer.byteLength(content, 'utf-8') : 0,
    hasRole: content !== null,
    injectMode: readRoleInjectMode(larkAppId, chatId),
    dispatchCompletionEnabled: readRoleDispatchCompletionEnabled(larkAppId, chatId),
    effectiveContent: effective.content,
    effectiveSource: effective.source,
    effectiveByteLength: effective.content ? Buffer.byteLength(effective.content, 'utf-8') : 0,
    hasEffectiveRole: effective.content !== null,
  };
}

ipcRoute('POST', '/api/roles/batch', async (req, res) => {
  if (!cachedLarkAppId) return jsonRes(res, 503, { error: 'larkAppId_not_set' });
  let body: { chatIds?: unknown };
  try { body = await readJsonBody<{ chatIds?: unknown }>(req); }
  catch { return jsonRes(res, 400, { ok: false, error: 'bad_json' }); }
  if (!Array.isArray(body.chatIds)) return jsonRes(res, 400, { ok: false, error: 'chat_ids_required' });
  if (body.chatIds.length > MAX_ROLE_BATCH_CHAT_IDS) {
    return jsonRes(res, 400, { ok: false, error: 'too_many_chat_ids' });
  }
  if (body.chatIds.some(chatId => typeof chatId !== 'string' || !isValidRoleChatId(chatId))) {
    return jsonRes(res, 400, { ok: false, error: 'invalid_chat_id' });
  }
  const chatIds = [...new Set(body.chatIds as string[])];
  jsonRes(res, 200, { roles: chatIds.map(chatId => dashboardRolePayload(cachedLarkAppId!, chatId)) });
});

ipcRoute('GET', '/api/roles/:chatId', async (_req, res, p) => {
  if (!cachedLarkAppId) return jsonRes(res, 503, { error: 'larkAppId_not_set' });
  if (!isValidRoleChatId(p.chatId)) return jsonRes(res, 400, { ok: false, error: 'invalid_chat_id' });
  jsonRes(res, 200, dashboardRolePayload(cachedLarkAppId, p.chatId));
});

ipcRoute('PUT', '/api/roles/:chatId', async (req, res, p) => {
  if (!cachedLarkAppId) return jsonRes(res, 503, { error: 'larkAppId_not_set' });
  if (!isValidRoleChatId(p.chatId)) return jsonRes(res, 400, { ok: false, error: 'invalid_chat_id' });
  let body: { content?: unknown; injectMode?: unknown; dispatchCompletionEnabled?: unknown };
  try { body = await readJsonBody<{ content?: string; injectMode?: string; dispatchCompletionEnabled?: boolean }>(req); }
  catch { return jsonRes(res, 400, { ok: false, error: 'bad_json' }); }
  // injectMode is a per-chat setting that can be updated on its own (no content)
  // — e.g. toggling "inject once" for a chat whose effective role is the team
  // default. Only 'every'/'once' are accepted; anything else is ignored.
  const injectMode: RoleInjectMode | undefined =
    body.injectMode === 'once' ? 'once' : body.injectMode === 'every' ? 'every' : undefined;
  const dispatchCompletionEnabled = typeof body.dispatchCompletionEnabled === 'boolean'
    ? body.dispatchCompletionEnabled
    : undefined;
  const hasContentField = typeof body.content === 'string';
  const content = hasContentField ? (body.content as string).trim() : '';
  if (!hasContentField && injectMode === undefined && dispatchCompletionEnabled === undefined) {
    return jsonRes(res, 400, { ok: false, error: 'role_setting_required' });
  }
  if (hasContentField && !content) return jsonRes(res, 400, { ok: false, error: 'content_required' });
  try {
    if (hasContentField) writeRoleFile(cachedLarkAppId, p.chatId, content);
    if (injectMode !== undefined) writeRoleInjectMode(cachedLarkAppId, p.chatId, injectMode);
    if (dispatchCompletionEnabled !== undefined) writeRoleDispatchCompletionEnabled(cachedLarkAppId, p.chatId, dispatchCompletionEnabled);
    // `changed` reflects whether the role FILE (→ hasRole in the groups matrix)
    // was written. A metadata-only PUT touches just the .meta.json sidecar and
    // leaves hasRole untouched, so it reports changed:false — the dashboard uses
    // this to avoid needlessly busting its 30s groups-matrix snapshot.
    jsonRes(res, 200, { ok: true, changed: hasContentField });
  } catch (e) {
    jsonRes(res, 500, { ok: false, error: String(e) });
  }
});

ipcRoute('DELETE', '/api/roles/:chatId', async (_req, res, p) => {
  if (!cachedLarkAppId) return jsonRes(res, 503, { error: 'larkAppId_not_set' });
  if (!isValidRoleChatId(p.chatId)) return jsonRes(res, 400, { ok: false, error: 'invalid_chat_id' });
  const existed = deleteRoleFile(cachedLarkAppId, p.chatId);
  deleteRoleMeta(cachedLarkAppId, p.chatId);
  // `changed` mirrors `existed`: a DELETE that removed nothing didn't flip
  // hasRole, so the dashboard skips invalidating its groups-matrix snapshot.
  jsonRes(res, 200, { ok: true, existed, changed: existed });
});

ipcRoute('GET', '/api/message-listeners/:chatId', async (_req, res, p) => {
  if (!cachedLarkAppId) return jsonRes(res, 503, { error: 'larkAppId_not_set' });
  if (!isValidRoleChatId(p.chatId)) return jsonRes(res, 400, { ok: false, error: 'invalid_chat_id' });
  jsonRes(res, 200, {
    chatId: p.chatId,
    listener: getMessageListenerConfig(cachedLarkAppId, p.chatId),
    maxPromptBytes: MAX_MESSAGE_LISTENER_PROMPT_BYTES,
  });
});

ipcRoute('PUT', '/api/message-listeners/:chatId', async (req, res, p) => {
  if (!cachedLarkAppId) return jsonRes(res, 503, { error: 'larkAppId_not_set' });
  if (!isValidRoleChatId(p.chatId)) return jsonRes(res, 400, { ok: false, error: 'invalid_chat_id' });
  let body: unknown;
  try { body = await readJsonBody(req); } catch { return jsonRes(res, 400, { ok: false, error: 'bad_json' }); }
  const update = sanitizeMessageListenerUpdate(body);
  if (!update) return jsonRes(res, 400, { ok: false, error: 'invalid_listener' });
  const validation = validateMessageListenerUpdate(update);
  if (!validation.ok) return jsonRes(res, 400, { ok: false, error: validation.reason });
  if (update.prompt && Buffer.byteLength(update.prompt, 'utf-8') > MAX_MESSAGE_LISTENER_PROMPT_BYTES) {
    return jsonRes(res, 400, { ok: false, error: 'prompt_too_large' });
  }
  const result = await updateMessageListenerConfig(cachedLarkAppId, p.chatId, update);
  if (!result.ok) return jsonRes(res, ['prompt_required', 'sender_required'].includes(result.reason) ? 400 : 500, { ok: false, error: result.reason });
  jsonRes(res, 200, { ok: true, listener: result.listener });
});

function dashboardHistoryMessageSender(message: any): { senderOpenId?: string; senderName?: string; senderTypeRaw?: string; senderIdType?: string } {
  const sender = message?.sender ?? {};
  // Prefer `open_bot_id` (present on bot senders when with_sender_name=true): it
  // is the bot's per-app open_id, matching /members/bots and the stored sender
  // filters. Mirrors historyMessageSender in event-dispatcher so preview and the
  // 30s poll resolve a third-party bot identically. See that fn for detail.
  const senderId = sender.open_bot_id ?? sender.id ?? sender.open_id ?? sender.user_id ?? sender.app_id
    ?? message?.sender_id?.open_id ?? message?.sender_id?.user_id ?? message?.sender_id?.app_id;
  const senderName = sender.sender_name ?? sender.name ?? sender.user_name ?? message?.sender_name;
  const rawIdType = sender.id_type ?? sender.sender_id_type;
  const senderIdType = sender.open_bot_id ? 'open_id' : rawIdType;
  const senderTypeRaw = sender.sender_type ?? message?.sender_type ?? (rawIdType === 'app_id' ? 'app' : undefined);
  return {
    senderOpenId: typeof senderId === 'string' ? senderId : undefined,
    senderName: typeof senderName === 'string' && senderName.trim() ? senderName.trim() : undefined,
    senderTypeRaw: typeof senderTypeRaw === 'string' ? senderTypeRaw : undefined,
    senderIdType: typeof senderIdType === 'string' ? senderIdType : undefined,
  };
}

function dashboardMessageCreateTimeMs(message: any): number | undefined {
  const value = Number(message?.create_time ?? message?.createTime);
  return Number.isFinite(value) ? value : undefined;
}

async function readMessageListenerPreviewRequest(req: IncomingMessage): Promise<
  | { ok: true; listener: NonNullable<ReturnType<typeof sanitizeMessageListenerUpdate>>; limit: number }
  | { ok: false; status: number; error: string }
> {
  let body: unknown;
  try { body = await readJsonBody(req); } catch { return { ok: false, status: 400, error: 'bad_json' }; }
  const raw = body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : {};
  const listener = sanitizeMessageListenerUpdate(raw.listener ?? raw);
  if (!listener) return { ok: false, status: 400, error: 'invalid_listener' };
  const validation = validateMessageListenerUpdate(listener);
  if (!validation.ok) return { ok: false, status: 400, error: validation.reason };
  if (listener.prompt && Buffer.byteLength(listener.prompt, 'utf-8') > MAX_MESSAGE_LISTENER_PROMPT_BYTES) {
    return { ok: false, status: 400, error: 'prompt_too_large' };
  }
  return { ok: true, listener, limit: normalizeMessageListenerPreviewLimit(raw.limit) };
}


async function collectMessageListenerPreviewMatches(
  larkAppId: string,
  chatId: string,
  listener: NonNullable<ReturnType<typeof sanitizeMessageListenerUpdate>>,
  limit: number,
): Promise<MessageListenerPreviewMatch[]> {
  const bot = getBot(larkAppId);
  const previewListener: MessageListenerConfig = {
    enabled: true,
    ...(listener.name ? { name: listener.name } : {}),
    ...(listener.replyCardTitle ? { replyCardTitle: listener.replyCardTitle } : {}),
    ...(listener.workingDir ? { workingDir: listener.workingDir } : {}),
    prompt: listener.prompt,
    ...(listener.senderPolicy && Object.keys(listener.senderPolicy).length > 0 ? { senderPolicy: listener.senderPolicy } : {}),
    ...(listener.messagePolicy ? { messagePolicy: { ...listener.messagePolicy, scope: 'top_level' } } : { messagePolicy: { scope: 'top_level' } }),
    replyPolicy: { mode: 'thread', sessionMode: 'per_message' },
  };
  const previewBot = {
    ...bot,
    config: {
      ...bot.config,
      messageListeners: {
        ...(bot.config.messageListeners ?? {}),
        [chatId]: previewListener,
      },
    },
  };
  const cutoff = Date.now() - MESSAGE_LISTENER_PREVIEW_WINDOW_MS;
  const messages = await listChatMessagesUntil(larkAppId, chatId, {
    pageSize: 50,
    stopAfter: (message, seenCount) => {
      const createdAt = dashboardMessageCreateTimeMs(message);
      return seenCount >= Math.max(100, limit * 5) ||
        (Number.isFinite(createdAt) && (createdAt as number) < cutoff);
    },
  });
  const candidateBotAppIds = collectListenerBotAppIds(messages, dashboardHistoryMessageSender);
  const appIdToOpenId = await buildListenerBotAppIdToOpenId(larkAppId, chatId, candidateBotAppIds);
  const matches = previewMessageListenerMatches({
    bot: previewBot,
    chatId,
    messages,
    limit,
    senderForMessage: dashboardHistoryMessageSender,
    appIdToOpenId,
    // Mirror realtime/poll routing: a message that explicitly @mentions this bot
    // hands off to normal @-routing, NOT the listener — so preview/run-preview
    // must apply the same gate (else preview over-counts and run-preview would
    // spawn a session for a message live routing never sends to the listener).
    explicitlyMentionedThisBot: (message) => messageMentionsBot(message, larkAppId, bot.botOpenId),
  });
  // The listener matcher extracts card text from the SIMPLIFIED history view,
  // which drops button jump URLs. The live delivery path (handleNewTopic) fixes
  // this by re-extracting after resolveNonsupportMessage merges the card's two
  // representations. Preview/run-preview do NOT go through handleNewTopic, so
  // apply the equivalent merge here: run-preview spawns REAL turns off
  // match.messageText, and preview display should show the same links the live
  // listener will. Only interactive cards need it; a resolver miss keeps the
  // match-time text. Resolve concurrently — each match is an independent fetch.
  await Promise.all(matches.map(async (match) => {
    if (match.msgType !== 'interactive') return;
    const merged = await resolveMergedCardContent(larkAppId, match.messageId).catch(() => null);
    if (merged?.text?.trim()) match.messageText = merged.text;
  }));
  return matches;
}

function publicMessageListenerMatch(match: MessageListenerPreviewMatch): Record<string, unknown> {
  return {
    messageId: match.messageId,
    createTime: match.createTime,
    messageText: match.messageText,
    messageTitle: match.messageTitle,
    msgType: match.msgType,
    senderOpenId: match.senderOpenId,
    senderName: match.senderName,
    senderType: match.senderType,
  };
}

ipcRoute('POST', '/api/message-listeners/:chatId/preview', async (req, res, p) => {
  if (!cachedLarkAppId) return jsonRes(res, 503, { ok: false, error: 'larkAppId_not_set' });
  if (!isValidRoleChatId(p.chatId)) return jsonRes(res, 400, { ok: false, error: 'invalid_chat_id' });
  const parsed = await readMessageListenerPreviewRequest(req);
  if (!parsed.ok) return jsonRes(res, parsed.status, { ok: false, error: parsed.error });
  try {
    const matches = await collectMessageListenerPreviewMatches(cachedLarkAppId, p.chatId, parsed.listener, parsed.limit);
    jsonRes(res, 200, {
      ok: true,
      requestedLimit: parsed.limit,
      matches: matches.map(publicMessageListenerMatch),
    });
  } catch (err) {
    jsonRes(res, 502, { ok: false, error: err instanceof Error ? err.message : String(err) });
  }
});

ipcRoute('POST', '/api/message-listeners/:chatId/run-preview', async (req, res, p) => {
  if (!cachedLarkAppId) return jsonRes(res, 503, { ok: false, error: 'larkAppId_not_set' });
  if (!isValidRoleChatId(p.chatId)) return jsonRes(res, 400, { ok: false, error: 'invalid_chat_id' });
  const activeSessions = getActiveSessionsRegistry();
  if (!activeSessions) return jsonRes(res, 503, { ok: false, error: 'active session registry unavailable' });
  const parsed = await readMessageListenerPreviewRequest(req);
  if (!parsed.ok) return jsonRes(res, parsed.status, { ok: false, error: parsed.error });
  try {
    const matches = await collectMessageListenerPreviewMatches(cachedLarkAppId, p.chatId, parsed.listener, parsed.limit);
    const run = createMessageListenerRunPreview(cachedLarkAppId, p.chatId, matches.map(match => match.messageId));
    const results = [];
    for (const match of matches) {
      const triggerId = createMessageListenerRunPreviewTurnId();
      try {
        const result = await triggerSessionTurn({
          source: {
            type: 'ui',
            connectorId: 'message-listener-preview',
            requestId: `listener-preview:${match.messageId}`,
            receivedAt: new Date().toISOString(),
          },
          target: {
            kind: 'turn',
            botId: cachedLarkAppId,
            chatId: p.chatId,
            rootMessageId: match.messageId,
          },
          envelope: {
            format: 'message_listener',
            sourceName: match.name || 'Message Listener Preview',
            trusted: false,
            payload: publicMessageListenerMatch(match),
            rawText: match.messageText,
          },
          instruction: renderMessageListenerInstruction(match),
          presentation: { topicMessage: null },
        }, { larkAppId: cachedLarkAppId, activeSessions }, { stableTurnId: triggerId });
        const tracked = result.ok
          ? markMessageListenerRunPreviewTriggered(run.runId, match.messageId, {
              action: result.action,
              sessionId: result.target?.sessionId,
              triggerId: result.triggerId ?? triggerId,
            })
          : markMessageListenerRunPreviewFailed(run.runId, {
              messageId: match.messageId,
              sessionId: result.target?.sessionId,
              error: result.error,
            });
        results.push(tracked ?? {
          runId: run.runId,
          messageId: match.messageId,
          ok: result.ok,
          state: result.ok ? 'triggered' : 'failed',
          action: result.action,
          sessionId: result.target?.sessionId,
          triggerId: result.triggerId ?? triggerId,
          error: result.error,
        });
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        const tracked = markMessageListenerRunPreviewFailed(run.runId, {
          messageId: match.messageId,
          error,
        });
        results.push(tracked ?? {
          runId: run.runId,
          messageId: match.messageId,
          ok: false,
          state: 'failed',
          error,
        });
      }
    }
    jsonRes(res, 200, {
      ok: results.every(result => result.ok),
      runId: run.runId,
      requestedLimit: parsed.limit,
      matches: matches.map(publicMessageListenerMatch),
      results,
    });
  } catch (err) {
    jsonRes(res, 502, { ok: false, error: err instanceof Error ? err.message : String(err) });
  }
});

ipcRoute('GET', '/api/message-listeners/:chatId/run-preview/:runId', async (_req, res, p) => {
  if (!cachedLarkAppId) return jsonRes(res, 503, { ok: false, error: 'larkAppId_not_set' });
  if (!isValidRoleChatId(p.chatId)) return jsonRes(res, 400, { ok: false, error: 'invalid_chat_id' });
  const run = getMessageListenerRunPreview(p.runId);
  if (!run || run.larkAppId !== cachedLarkAppId || run.chatId !== p.chatId) {
    return jsonRes(res, 404, { ok: false, error: 'not_found' });
  }
  jsonRes(res, 200, {
    ok: true,
    runId: run.runId,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    results: run.results,
  });
});

ipcRoute('DELETE', '/api/message-listeners/:chatId', async (_req, res, p) => {
  if (!cachedLarkAppId) return jsonRes(res, 503, { error: 'larkAppId_not_set' });
  if (!isValidRoleChatId(p.chatId)) return jsonRes(res, 400, { ok: false, error: 'invalid_chat_id' });
  const result = await updateMessageListenerConfig(cachedLarkAppId, p.chatId, { enabled: false, prompt: '' });
  if (!result.ok) return jsonRes(res, 500, { ok: false, error: result.reason });
  jsonRes(res, 200, { ok: true });
});

ipcRoute('GET', '/api/groups/:chatId/members-display', async (_req, res, p) => {
  if (!cachedLarkAppId) return jsonRes(res, 503, { error: 'larkAppId_not_set' });
  if (!isValidRoleChatId(p.chatId)) return jsonRes(res, 400, { ok: false, error: 'invalid_chat_id' });
  try {
    const members = await listChatMemberDisplays(cachedLarkAppId, p.chatId);
    jsonRes(res, 200, { members });
  } catch (err) {
    jsonRes(res, 502, { ok: false, error: err instanceof Error ? err.message : String(err) });
  }
});

// ─── Role profile management (dashboard) ──────────────────────────────────
// Profiles are authoring/storage helpers only; applying one writes this bot's
// entry into the selected chat role and does not alter runtime role layering.

ipcRoute('GET', '/api/role-profiles', async (_req, res) => {
  if (!cachedLarkAppId) return jsonRes(res, 503, { error: 'larkAppId_not_set' });
  const profiles = listRoleProfiles(config.session.dataDir).map(p => ({
    ...p,
    hasCurrentBotEntry: readRoleProfileEntry(config.session.dataDir, p.profileId, cachedLarkAppId) !== null,
  }));
  jsonRes(res, 200, { profiles, larkAppId: cachedLarkAppId });
});

ipcRoute('GET', '/api/role-profiles/:profileId', async (_req, res, p) => {
  if (!cachedLarkAppId) return jsonRes(res, 503, { error: 'larkAppId_not_set' });
  if (!isValidRoleProfileId(p.profileId)) return jsonRes(res, 400, { ok: false, error: 'invalid_role_profile_id' });
  const entries = listRoleProfileEntries(config.session.dataDir, p.profileId);
  jsonRes(res, 200, { profileId: p.profileId, entries });
});

ipcRoute('GET', '/api/role-profiles/:profileId/:larkAppId', async (_req, res, p) => {
  if (!cachedLarkAppId) return jsonRes(res, 503, { error: 'larkAppId_not_set' });
  if (p.larkAppId !== cachedLarkAppId) return jsonRes(res, 403, { ok: false, error: 'wrong_daemon' });
  if (!isValidRoleProfileId(p.profileId)) return jsonRes(res, 400, { ok: false, error: 'invalid_role_profile_id' });
  const content = readRoleProfileEntry(config.session.dataDir, p.profileId, cachedLarkAppId);
  jsonRes(res, 200, {
    profileId: p.profileId,
    larkAppId: cachedLarkAppId,
    content,
    byteLength: content ? Buffer.byteLength(content, 'utf-8') : 0,
    hasEntry: content !== null,
  });
});

ipcRoute('PUT', '/api/role-profiles/:profileId/:larkAppId', async (req, res, p) => {
  if (!cachedLarkAppId) return jsonRes(res, 503, { error: 'larkAppId_not_set' });
  if (p.larkAppId !== cachedLarkAppId) return jsonRes(res, 403, { ok: false, error: 'wrong_daemon' });
  if (!isValidRoleProfileId(p.profileId)) return jsonRes(res, 400, { ok: false, error: 'invalid_role_profile_id' });
  let body: { content?: unknown; allowEmpty?: unknown };
  try { body = await readJsonBody<{ content?: string; allowEmpty?: boolean }>(req); }
  catch { return jsonRes(res, 400, { ok: false, error: 'bad_json' }); }
  const content = typeof body.content === 'string' ? body.content.trim() : '';
  const allowEmpty = body.allowEmpty === true;
  if (!content && !allowEmpty) return jsonRes(res, 400, { ok: false, error: 'content_required' });
  try {
    writeRoleProfileEntry(config.session.dataDir, p.profileId, cachedLarkAppId, content, { allowEmpty });
    jsonRes(res, 200, { ok: true, byteLength: Math.min(Buffer.byteLength(content, 'utf-8'), MAX_ROLE_PROFILE_ENTRY_BYTES) });
  } catch (e) {
    jsonRes(res, 500, { ok: false, error: String(e) });
  }
});

ipcRoute('DELETE', '/api/role-profiles/:profileId/:larkAppId', async (_req, res, p) => {
  if (!cachedLarkAppId) return jsonRes(res, 503, { error: 'larkAppId_not_set' });
  if (p.larkAppId !== cachedLarkAppId) return jsonRes(res, 403, { ok: false, error: 'wrong_daemon' });
  if (!isValidRoleProfileId(p.profileId)) return jsonRes(res, 400, { ok: false, error: 'invalid_role_profile_id' });
  const existed = deleteRoleProfileEntry(config.session.dataDir, p.profileId, cachedLarkAppId);
  deleteRoleProfileIfEmpty(config.session.dataDir, p.profileId);
  jsonRes(res, 200, { ok: true, existed });
});

ipcRoute('POST', '/api/role-profiles/:profileId/apply', async (req, res, p) => {
  if (!cachedLarkAppId) return jsonRes(res, 503, { error: 'larkAppId_not_set' });
  if (!isValidRoleProfileId(p.profileId)) return jsonRes(res, 400, { ok: false, error: 'invalid_role_profile_id' });
  let body: { chatId?: unknown; larkAppId?: unknown; force?: unknown; preview?: unknown };
  try { body = await readJsonBody(req); }
  catch { return jsonRes(res, 400, { ok: false, error: 'bad_json' }); }
  const chatId = typeof body.chatId === 'string' && body.chatId.trim() ? body.chatId.trim() : '';
  const larkAppId = typeof body.larkAppId === 'string' && body.larkAppId.trim() ? body.larkAppId.trim() : '';
  if (!chatId || !larkAppId) return jsonRes(res, 400, { ok: false, error: 'chatId_and_larkAppId_required' });
  if (!isValidRoleChatId(chatId)) return jsonRes(res, 400, { ok: false, error: 'invalid_chat_id' });
  if (larkAppId !== cachedLarkAppId) return jsonRes(res, 403, { ok: false, error: 'wrong_daemon' });
  const content = readRoleProfileEntry(config.session.dataDir, p.profileId, cachedLarkAppId);
  if (content === null) return jsonRes(res, 200, { ok: false, error: 'missing_entry', changed: false });
  const existing = resolveRoleFile(cachedLarkAppId, chatId);
  const preview = body.preview === true;
  const force = body.force === true;
  if (preview) {
    return jsonRes(res, 200, {
      ok: true,
      preview: true,
      changed: false,
      wouldOverwrite: existing !== null,
      wouldRefuse: existing !== null && !force,
      content,
      byteLength: Buffer.byteLength(content, 'utf-8'),
    });
  }
  if (existing && !force) return jsonRes(res, 409, { ok: false, error: 'chat_role_exists', changed: false });
  if (!content) {
    const existed = deleteRoleFile(cachedLarkAppId, chatId);
    return jsonRes(res, 200, { ok: true, changed: existed, byteLength: 0, deleted: existed });
  }
  writeRoleFile(cachedLarkAppId, chatId, content);
  jsonRes(res, 200, { ok: true, changed: true, byteLength: Buffer.byteLength(content, 'utf-8') });
});

// ─── Per-bot defaultOncall (dashboard) ─────────────────────────────────────
// GET  /api/bot-default-oncall → returns this daemon's current config
// PUT  /api/bot-default-oncall  body: { enabled, workingDir }
//
// Forward-only policy: enabling does not backfill or distinguish "old vs new"
// chats. Any group the bot is in — present or future — auto-binds on its
// next observed topic if it has no existing oncall binding and is not in
// the tombstone list. `since` is stamped purely as informational metadata
// (UI shows "上次启用时间").

ipcRoute('GET', '/api/bot-default-oncall', async (_req, res) => {
  if (!cachedLarkAppId) return jsonRes(res, 503, { error: 'larkAppId_not_set' });
  const { defaultOncall, autoboundChats } = oncallStore.getBotDefaultOncall(cachedLarkAppId);
  const cardPrefs = cardPrefsStore.getBotCardPrefs(cachedLarkAppId);
  const grantPrefs = grantPrefsStore.getBotGrantPrefs(cachedLarkAppId);
  let replyStyle: ReplyStyleConfig | null = null;
  try {
    const normalized = normalizeSparseReplyStyleConfig((getBot(cachedLarkAppId).config as any).replyStyle);
    replyStyle = normalized.config ?? null;
    for (const warning of normalized.warnings) logger.warn(`[reply-style] ${warning}`);
  } catch { /* missing registry entry → built-in defaults */ }
  let p2pMode: 'thread' | 'chat' | 'group' = 'chat';
  try {
    const configured = getBot(cachedLarkAppId).config.p2pMode;
    if (configured === 'thread' || configured === 'group') p2pMode = configured;
  } catch { /* default chat */ }
  let envelopeInjection: 'auto' | 'off' = 'off';
  try { if (getBot(cachedLarkAppId).config.envelopeInjection === 'auto') envelopeInjection = 'auto'; } catch { /* default off */ }
  let codexAuthSync: 'shared' | 'isolated' = 'shared';
  try { if (getBot(cachedLarkAppId).config.codexAuthSync === 'isolated') codexAuthSync = 'isolated'; } catch { /* default shared */ }
  let skillInjection: 'global' | 'prompt' | 'off' | null = null;
  // How this bot's CLI delivers botmux skills, so the dashboard can render the
  // control correctly: 'dynamic' = per-session --plugin-dir (claude-family, not
  // configurable); 'global' = global skills dir (codex-family, prompt/global/off
  // selectable); 'none' = CLI has no skill dir at all (control hidden).
  let skillInjectionSupport: 'dynamic' | 'global' | 'none' = 'none';
  try {
    const cfg = getBot(cachedLarkAppId).config;
    const s = cfg.skillInjection;
    if (s === 'global' || s === 'prompt' || s === 'off') skillInjection = s;
    skillInjectionSupport = resolveSkillInjectionSupport(cfg.cliId, cfg.cliPathOverride);
  } catch { /* unset → machine default; support → none */ }
  let cliId = '';
  let cliRuntime: CliRuntimeConfig | null = null;
  let cliPathOverride: string | null = null;
  let wrapperCli: string | null = null;
  let model: string | null = null;
  let reasoningEffort: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra' | null = null;
  // dsh runner turn timeout (ms). Only meaningful for the dsh adapter; exposed
  // so the dashboard can render the dsh-only field with its current value.
  let turnTimeoutMs: number | null = null;
  // dsh runtime variant ('official' | 'tui'). Only meaningful for the dsh CLI;
  // exposed so the dashboard can render the dsh 运行时 toggle.
  let dshRuntime: 'official' | 'tui' | null = null;
  let agentSelectionKey = '';
  try {
    const cfg = getBot(cachedLarkAppId).config;
    cliId = cfg.cliId;
    cliRuntime = cfg.cliRuntime ?? null;
    // Parsed structured runtimes mirror their executable into cliPathOverride
    // for legacy adapter call sites. Expose only a genuine legacy path here so
    // the Dashboard can render an explicit migration state instead of
    // misclassifying every structured runtime as legacy.
    cliPathOverride = !cfg.cliRuntime && typeof cfg.cliPathOverride === 'string' && cfg.cliPathOverride.trim()
      ? cfg.cliPathOverride
      : null;
    wrapperCli = typeof cfg.wrapperCli === 'string' && cfg.wrapperCli.trim() ? cfg.wrapperCli : null;
    model = typeof cfg.model === 'string' && cfg.model.trim() ? cfg.model : null;
    reasoningEffort = cfg.reasoningEffort ?? null;
    turnTimeoutMs = typeof cfg.turnTimeoutMs === 'number'
      && Number.isInteger(cfg.turnTimeoutMs) && cfg.turnTimeoutMs > 0
      ? cfg.turnTimeoutMs
      : null;
    dshRuntime = cfg.dshRuntime === 'tui' ? 'tui' : null;
    agentSelectionKey = selectionKeyForBot(cliId, wrapperCli ?? undefined);
  } catch { /* no registered bot */ }
  let maxLiveWorkers: number | null = null;
  let sessionOwnerReminder = DEFAULT_SESSION_OWNER_REMINDER;
  try {
    const botConfig = getBot(cachedLarkAppId).config;
    const m = botConfig.maxLiveWorkers;
    if (typeof m === 'number' && Number.isInteger(m) && m > 0) maxLiveWorkers = m;
    sessionOwnerReminder = botConfig.sessionOwnerReminder ?? DEFAULT_SESSION_OWNER_REMINDER;
  } catch { /* default unlimited */ }
  let logicalSessionCount = 0;
  let residentSessionCount = 0;
  let dormantSessionCount = 0;
  const registry = getActiveSessionsRegistry();
  if (registry) {
    logicalSessionCount = registry.size;
    for (const ds of registry.values()) {
      if (ds.worker && !ds.worker.killed) residentSessionCount++;
      else if (!ds.session.queued) dormantSessionCount++;
    }
  }
  // startupCommands → newline-joined for the dashboard textarea (one per line).
  let startupCommands = '';
  try {
    const sc = getBot(cachedLarkAppId).config.startupCommands;
    if (Array.isArray(sc) && sc.length) startupCommands = sc.join('\n');
  } catch { /* none */ }
  // customPassthroughCommands / canTalkDaemonCommands → space-joined for the
  // dashboard slash-command editors. Empty string = not configured (回默认).
  let customPassthroughCommands = '';
  let canTalkDaemonCommands = '';
  try {
    const cfg = getBot(cachedLarkAppId).config;
    if (Array.isArray(cfg.customPassthroughCommands) && cfg.customPassthroughCommands.length) {
      customPassthroughCommands = cfg.customPassthroughCommands.join(' ');
    }
    if (Array.isArray(cfg.canTalkDaemonCommands) && cfg.canTalkDaemonCommands.length) {
      canTalkDaemonCommands = cfg.canTalkDaemonCommands.join(' ');
    }
  } catch { /* none */ }
  // Per-bot env → pretty JSON for the dashboard textarea. The dashboard is
  // owner-authenticated, so showing the real values here is acceptable (same
  // as editing bots.json directly); the chat-facing /config get masks them.
  let env = '';
  try {
    const e = getBot(cachedLarkAppId).config.env;
    if (e && typeof e === 'object' && Object.keys(e).length) env = JSON.stringify(e, null, 2);
  } catch { /* none */ }
  // defaultWorkingDir — the "仅默认目录" mode source. Mutually exclusive with
  // defaultOncall in the dashboard 3-way selector; the frontend derives the
  // current mode from (defaultOncall.enabled ? oncall : defaultWorkingDir ? default : off).
  let defaultWorkingDir: string | null = null;
  let defaultWorkingDirAutoWorktree = false;
  try {
    const cfg = getBot(cachedLarkAppId).config;
    if (typeof cfg.defaultWorkingDir === 'string' && cfg.defaultWorkingDir.trim()) defaultWorkingDir = cfg.defaultWorkingDir;
    defaultWorkingDirAutoWorktree = cfg.defaultWorkingDirAutoWorktree === true;
  } catch { /* none */ }
  // 展示名编辑框数据：displayName = 自定义备注名（null = 未设，跟随飞书名称）；
  // larkBotName = 飞书探测到的应用名（供 placeholder /「恢复默认」提示用）。
  let displayName: string | null = null;
  let larkBotName: string | null = null;
  try {
    const bot = getBot(cachedLarkAppId);
    displayName = bot.config.displayName ?? null;
    larkBotName = bot.botName ?? null;
  } catch { /* none */ }
  jsonRes(res, 200, {
    larkAppId: cachedLarkAppId,
    botName: getBotName(),
    displayName,
    larkBotName,
    cliId,
    cliRuntime,
    cliPathOverride,
    wrapperCli,
    model,
    reasoningEffort,
    turnTimeoutMs,
    dshRuntime,
    agentSelectionKey,
    defaultOncall: defaultOncall ?? { enabled: false, workingDir: '', since: 0 },
    defaultWorkingDir,
    defaultWorkingDirAutoWorktree,
    autoboundChatCount: autoboundChats.length,
    brandLabel: brandStore.getBotBrandLabel(cachedLarkAppId) ?? null,
    replyStyle,
    sandbox: sandboxStore.getBotSandbox(cachedLarkAppId),
    codexAuthSync,
    sandboxPaths: sandboxStore.getBotSandboxPaths(cachedLarkAppId) ?? null,
    readIsolation: sandboxStore.getBotReadIsolation(cachedLarkAppId),
    // Full enforceability (adapter support + no wrapperCli + macOS) — the UI
    // disables the toggle wherever the worker would fail-close on it.
    readIsolationSupported: readIsolationEnforceable(cachedLarkAppId),
    backendType: backendTypeStore.getBotBackendType(cachedLarkAppId) ?? null,
    usageDisplay: cardPrefs.usageDisplay,
    // Whether this bot's CLI can produce native usage at all. When false the
    // dashboard hides the usage-display control (offering it would be a knob
    // that is always empty — the CLI has no resolvable transcript).
    usageSupported: cliSupportsNativeUsage(cliId),
    disableStreamingCard: cardPrefs.disableStreamingCard,
    pinStreamingCard: cardPrefs.pinStreamingCard,
    silentTurnReactions: cardPrefs.silentTurnReactions,
    codexAppCleanInput: cardPrefs.codexAppCleanInput,
    writableTerminalLinkInCard: cardPrefs.writableTerminalLinkInCard,
    privateCard: cardPrefs.privateCard,
    thinkingCard: cardPrefs.thinkingCard,
    senderTag: cardPrefs.senderTag,
    overloadAlert: cardPrefs.overloadAlert,
    botToBotSameDir: cardPrefs.botToBotSameDir,
    autoStartOnGroupJoin: cardPrefs.autoStartOnGroupJoin,
    autoStartOnGroupJoinPrompt: cardPrefs.autoStartOnGroupJoinPrompt,
    autoStartOnGroupJoinSeed: cardPrefs.autoStartOnGroupJoinSeed,
    // 当前生效的内置默认 seed 文案（按 bot locale），供前端 placeholder 展示。
    autoStartOnGroupJoinSeedDefault: t('daemon.auto_start_join_seed', undefined, localeForBot(cachedLarkAppId)),
    autoStartOnNewTopic: cardPrefs.autoStartOnNewTopic,
    regularGroupReplyMode: cardPrefs.regularGroupReplyMode,
    regularGroupMentionMode: cardPrefs.regularGroupMentionMode,
    substituteMode: substituteModeStore.getBotSubstituteMode(cachedLarkAppId) ?? null,
    feedback: (() => { try { return getBot(cachedLarkAppId).config.feedback ?? null; } catch { return null; } })(),
    docSubscribeDefaultMode: cardPrefs.docSubscribeDefaultMode,
    summaryMemory: cardPrefs.summaryMemory,
    summaryMemoryPath: cardPrefs.summaryMemoryPath,
    restrictGrantCommands: grantPrefs.restrictGrantCommands,
    autoGrantRequestCards: grantPrefs.autoGrantRequestCards,
    p2pOpen: grantPrefs.p2pOpen,
    messageQuotaDefaultLimit: grantPrefs.messageQuotaDefaultLimit,
    grantDefaultDurationMs: grantPrefs.grantDefaultDurationMs,
    p2pMode,
    envelopeInjection,
    skillInjection,
    skillInjectionSupport,
    // Resolved machine-wide default → the dashboard shows it as the pre-selected
    // value when this bot has no explicit override (prompt/global/off).
    skillInjectionDefault: globalBuiltinSkillInjectionDefault(),
    maxLiveWorkers,
    sessionOwnerReminder,
    logicalSessionCount,
    residentSessionCount,
    dormantSessionCount,
    startupCommands,
    customPassthroughCommands,
    canTalkDaemonCommands,
    launchShell: getBot(cachedLarkAppId).config.launchShell ?? '',
    env,
    riff: redactRiffForClient(getBot(cachedLarkAppId).config.riff),
    summaryRange: summaryRangeFromBotConfig(getBot(cachedLarkAppId).config),
    skills: getBot(cachedLarkAppId).config.skills ?? null,
  });
});

// Per-bot card-behaviour toggles. Body may carry any subset of booleans; only
// present keys are applied.
ipcRoute('PUT', '/api/bot-card-prefs', async (req, res) => {
  if (!cachedLarkAppId) return jsonRes(res, 503, { error: 'larkAppId_not_set' });
  let body: {
    usageDisplay?: unknown;
    disableStreamingCard?: unknown; pinStreamingCard?: unknown; silentTurnReactions?: unknown; codexAppCleanInput?: unknown; writableTerminalLinkInCard?: unknown; privateCard?: unknown; thinkingCard?: unknown;
    botToBotSameDir?: unknown;
    autoStartOnGroupJoin?: unknown; autoStartOnGroupJoinPrompt?: unknown; autoStartOnGroupJoinSeed?: unknown; autoStartOnGroupJoinSeedDefault?: unknown; autoStartOnNewTopic?: unknown;
    regularGroupReplyMode?: unknown; regularGroupMentionMode?: unknown; docSubscribeDefaultMode?: unknown;
    overloadAlert?: unknown; summaryMemory?: unknown; summaryMemoryPath?: unknown;
    senderTag?: unknown;
  };
  try { body = await readJsonBody(req); }
  catch { return jsonRes(res, 400, { ok: false, error: 'bad_json' }); }

  const patch: {
    usageDisplay?: UsageDisplayMode;
    disableStreamingCard?: boolean; pinStreamingCard?: boolean; silentTurnReactions?: boolean; codexAppCleanInput?: boolean; writableTerminalLinkInCard?: boolean; privateCard?: boolean; thinkingCard?: boolean;
    botToBotSameDir?: boolean;
    autoStartOnGroupJoin?: boolean; autoStartOnGroupJoinPrompt?: string; autoStartOnGroupJoinSeed?: string; autoStartOnNewTopic?: boolean;
    regularGroupReplyMode?: ChatReplyMode; regularGroupMentionMode?: 'always' | 'topic' | 'never' | 'ambient';
    docSubscribeDefaultMode?: 'mention-only' | 'all';
    overloadAlert?: boolean; summaryMemory?: boolean; summaryMemoryPath?: string;
    senderTag?: boolean;
  } = {};
  if (body.usageDisplay === 'streaming' || body.usageDisplay === 'footer' || body.usageDisplay === 'off') patch.usageDisplay = body.usageDisplay;
  if (typeof body.disableStreamingCard === 'boolean') patch.disableStreamingCard = body.disableStreamingCard;
  if (typeof body.pinStreamingCard === 'boolean') patch.pinStreamingCard = body.pinStreamingCard;
  if (typeof body.botToBotSameDir === 'boolean') patch.botToBotSameDir = body.botToBotSameDir;
  if (typeof body.silentTurnReactions === 'boolean') patch.silentTurnReactions = body.silentTurnReactions;
  if (typeof body.codexAppCleanInput === 'boolean') patch.codexAppCleanInput = body.codexAppCleanInput;
  if (typeof body.writableTerminalLinkInCard === 'boolean') patch.writableTerminalLinkInCard = body.writableTerminalLinkInCard;
  if (typeof body.privateCard === 'boolean') patch.privateCard = body.privateCard;
  if (typeof body.thinkingCard === 'boolean') patch.thinkingCard = body.thinkingCard;
  if (typeof body.senderTag === 'boolean') patch.senderTag = body.senderTag;
  if (typeof body.overloadAlert === 'boolean') patch.overloadAlert = body.overloadAlert;
  if (typeof body.summaryMemory === 'boolean') patch.summaryMemory = body.summaryMemory;
  if (typeof body.summaryMemoryPath === 'string') patch.summaryMemoryPath = body.summaryMemoryPath;
  if (typeof body.autoStartOnGroupJoin === 'boolean') patch.autoStartOnGroupJoin = body.autoStartOnGroupJoin;
  if (typeof body.autoStartOnGroupJoinPrompt === 'string') patch.autoStartOnGroupJoinPrompt = body.autoStartOnGroupJoinPrompt;
  if (typeof body.autoStartOnGroupJoinSeed === 'string') {
    // 编辑态软预填会把「当前生效的内置默认文案」直接填进输入框，因此一次顺手的
    // 保存（用户其实只想改上面的 prompt）会落盘一个内容恰等于默认的「自定义值」，
    // 把这个 bot 从「跟随动态默认」钉死成「锁定这一版文案」——升级改了默认文案
    // 它不再跟上，且 locale 切换后仍发旧语言那句。二者在 UI 上难以区分。
    //
    // 判定基准优先取前端回传的 seedDefault，即「这个页面当时实际预填给用户看的
    // 那句默认」。不能只跟服务端当刻的默认比：页面拿到 GET 之后 bot locale 若被
    // 改掉（/config lang，effect=immediate 且不发 bots.changed，配置页不会重拉，
    // 独立 React 页面也不卸载），软预填仍是旧语言那句，跟新 locale 的默认自然不
    // 相等，于是又被当成自定义写进去——正是本段要消除的 accidental pin，只是收窄
    // 成了 locale 时序窗口。回传值缺失（旧前端 / 非浏览器调用）时退回服务端默认。
    const seed = body.autoStartOnGroupJoinSeed;
    const presentedDefault = typeof body.autoStartOnGroupJoinSeedDefault === 'string'
      ? body.autoStartOnGroupJoinSeedDefault
      : '';
    const serverDefault = t('daemon.auto_start_join_seed', undefined, localeForBot(cachedLarkAppId));
    const looksDefault = seed.trim() === serverDefault.trim()
      || (presentedDefault.trim() !== '' && seed.trim() === presentedDefault.trim());
    patch.autoStartOnGroupJoinSeed = looksDefault ? '' : seed;
  }
  if (typeof body.autoStartOnNewTopic === 'boolean') patch.autoStartOnNewTopic = body.autoStartOnNewTopic;
  if (typeof body.regularGroupReplyMode === 'string') {
    const m = normalizeChatReplyMode(body.regularGroupReplyMode);
    if (m) patch.regularGroupReplyMode = m;
  }
  if (body.regularGroupMentionMode === 'always' || body.regularGroupMentionMode === 'topic' || body.regularGroupMentionMode === 'never' || body.regularGroupMentionMode === 'ambient') {
    patch.regularGroupMentionMode = body.regularGroupMentionMode;
  }
  if (body.docSubscribeDefaultMode === 'mention-only' || body.docSubscribeDefaultMode === 'all') {
    patch.docSubscribeDefaultMode = body.docSubscribeDefaultMode;
  }
  if (Object.keys(patch).length === 0) return jsonRes(res, 400, { ok: false, error: 'no_valid_fields' });

  const r = await cardPrefsStore.updateBotCardPrefs(cachedLarkAppId, patch);
  if (!r.ok) return jsonRes(res, 400, { ok: false, error: r.reason });
  jsonRes(res, 200, { ok: true, ...r.prefs });
});

ipcRoute('PUT', '/api/bot-substitute-mode', async (req, res) => {
  if (!cachedLarkAppId) return jsonRes(res, 503, { error: 'larkAppId_not_set' });
  let body: unknown;
  try { body = await readJsonBody(req); }
  catch { return jsonRes(res, 400, { ok: false, error: 'bad_json' }); }
  const rec = body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : {};
  // Resolve the submitted email / union_id entries into runtime-matchable
  // open_ids (+ fresh display names) using this bot's own credentials before
  // persisting; unresolvable entries are dropped but reported back for the UI.
  const { targets, resolution } = await substituteModeStore.resolveSubstituteTargets(
    cachedLarkAppId,
    rec.targets,
    { resolveRaw: resolveAllowedUsersWithMap, getProfile: getUserProfileStrict },
  );
  const chats = Array.isArray(rec.chats)
    ? [...new Set(rec.chats.map(String).map(s => s.trim()).filter(Boolean))]
    : [];
  const excludedChats = Array.isArray(rec.excludedChats)
    ? [...new Set(rec.excludedChats.map(String).map(s => s.trim()).filter(Boolean))]
    : [];
  const r = await substituteModeStore.updateBotSubstituteMode(cachedLarkAppId, {
    enabled: rec.enabled === true,
    targets,
    disclosure: rec.disclosure === 'none' ? 'none' : 'prefix',
    replyMode: rec.replyMode === 'quote' ? 'quote' : 'thread',
    disableControlCard: rec.disableControlCard === true,
    ...(chats.length ? { chats } : {}),
    ...(excludedChats.length ? { excludedChats } : {}),
    // 话题群开关：显式 false 才关（旧客户端不带字段 → normalize 缺省开）。
    topicGroups: rec.topicGroups,
    topicActiveSessionTrigger: rec.topicActiveSessionTrigger,
  });
  if (!r.ok) return jsonRes(res, 400, { ok: false, error: r.reason, resolution });
  jsonRes(res, 200, { ok: true, substituteMode: r.substituteMode, resolution });
});

// Preview resolution for a single substitute target without persisting anything.
// Used by the dashboard to auto-fill name/avatar while the user is typing.
ipcRoute('POST', '/api/bot-substitute-targets/resolve', async (req, res) => {
  if (!cachedLarkAppId) return jsonRes(res, 503, { error: 'larkAppId_not_set' });
  let body: unknown;
  try { body = await readJsonBody(req); }
  catch { return jsonRes(res, 400, { ok: false, error: 'bad_json' }); }
  const rec = body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : {};
  const target = rec.target && typeof rec.target === 'object' && !Array.isArray(rec.target) ? rec.target : {};
  const { resolution } = await substituteModeStore.resolveSubstituteTargets(
    cachedLarkAppId,
    [target],
    { resolveRaw: resolveAllowedUsersWithMap, getProfile: getUserProfileStrict },
  );
  jsonRes(res, 200, { ok: true, resolution: resolution[0] ?? null });
});

// Per-bot explicit `/summary` history range. Body `{ limit, sinceHours }`.
ipcRoute('PUT', '/api/bot-summary-range', async (req, res) => {
  if (!cachedLarkAppId) return jsonRes(res, 503, { error: 'larkAppId_not_set' });
  let raw: unknown;
  try { raw = await readJsonBody(req); }
  catch { return jsonRes(res, 400, { ok: false, error: 'bad_json' }); }
  const r = await updateDashboardSummaryRange(cachedLarkAppId, raw);
  if (!r.ok) return jsonRes(res, 400, { ok: false, error: r.reason });
  jsonRes(res, 200, { ok: true, summaryRange: r.summaryRange });
});

// Backward-compatible dashboard endpoint from the short-lived keyword-trigger UI.
ipcRoute('PUT', '/api/bot-summary-trigger', async (req, res) => {
  if (!cachedLarkAppId) return jsonRes(res, 503, { error: 'larkAppId_not_set' });
  let raw: unknown;
  try { raw = await readJsonBody(req); }
  catch { return jsonRes(res, 400, { ok: false, error: 'bad_json' }); }
  const body = raw && typeof raw === 'object' && !Array.isArray(raw)
    ? { limit: (raw as Record<string, unknown>).limit, sinceHours: (raw as Record<string, unknown>).sinceHours }
    : raw;
  const r = await updateDashboardSummaryRange(cachedLarkAppId, body);
  if (!r.ok) return jsonRes(res, 400, { ok: false, error: r.reason });
  jsonRes(res, 200, { ok: true, summaryRange: r.summaryRange });
});

// Per-bot 授权偏好。Body 任意子集：
//   • restrictGrantCommands: boolean       — 限制被授权人只能纯对话
//   • autoGrantRequestCards: boolean       — 未授权 @ 被挡住时是否发 grant 申请卡
//   • p2pOpen: boolean                     — 私聊对话全开（talk-only；管理权仍只认 allowedUsers）
//   • messageQuotaDefaultLimit: number|null — 卡片/Oncall 额度覆盖（null = 卡片内置 3 条、Oncall 不限）
//   • grantDefaultDurationMs: number|null   — 新授权默认有限时长（null = 产品默认 1 小时）
ipcRoute('PUT', '/api/bot-grant-prefs', async (req, res) => {
  if (!cachedLarkAppId) return jsonRes(res, 503, { error: 'larkAppId_not_set' });
  let raw: unknown;
  try { raw = await readJsonBody(req); }
  catch { return jsonRes(res, 400, { ok: false, error: 'bad_json' }); }
  // 顶层必须是对象：JSON `null` / 数字 / 字符串等都拒（null 解引用会抛 → 500）。
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return jsonRes(res, 400, { ok: false, error: 'no_valid_fields' });
  }
  const body = raw as {
    restrictGrantCommands?: unknown;
    autoGrantRequestCards?: unknown;
    p2pOpen?: unknown;
    messageQuotaDefaultLimit?: unknown;
    grantDefaultDurationMs?: unknown;
  };

  const patch: {
    restrictGrantCommands?: boolean;
    autoGrantRequestCards?: boolean;
    p2pOpen?: boolean;
    messageQuotaDefaultLimit?: number | null;
    grantDefaultDurationMs?: number | null;
  } = {};
  if (typeof body.restrictGrantCommands === 'boolean') patch.restrictGrantCommands = body.restrictGrantCommands;
  if (typeof body.autoGrantRequestCards === 'boolean') patch.autoGrantRequestCards = body.autoGrantRequestCards;
  if (typeof body.p2pOpen === 'boolean') patch.p2pOpen = body.p2pOpen;
  // null（含 JSON null）= 恢复内置额度策略；number = 设定覆盖值（store 内校验 1–1000）。
  if (body.messageQuotaDefaultLimit === null) patch.messageQuotaDefaultLimit = null;
  else if (typeof body.messageQuotaDefaultLimit === 'number') patch.messageQuotaDefaultLimit = body.messageQuotaDefaultLimit;
  // null = 恢复产品默认 1 小时；number 由 store 按卡片有限选项白名单校验。
  if (body.grantDefaultDurationMs === null) patch.grantDefaultDurationMs = null;
  else if (typeof body.grantDefaultDurationMs === 'number') patch.grantDefaultDurationMs = body.grantDefaultDurationMs;
  if (Object.keys(patch).length === 0) return jsonRes(res, 400, { ok: false, error: 'no_valid_fields' });

  const r = await grantPrefsStore.updateBotGrantPrefs(cachedLarkAppId, patch);
  if (!r.ok) return jsonRes(res, 400, { ok: false, error: r.reason });
  jsonRes(res, 200, { ok: true, ...r.prefs });
});

// Per-bot card footer brand label. Body `{ brandLabel: string | null }`:
//   • string (incl. '')  → store verbatim ('' = brand off)
//   • null / absent      → clear the key (revert to default botmux brand)
ipcRoute('PUT', '/api/bot-brand-label', async (req, res) => {
  if (!cachedLarkAppId) return jsonRes(res, 503, { error: 'larkAppId_not_set' });
  let body: { brandLabel?: unknown };
  try { body = await readJsonBody<{ brandLabel?: unknown }>(req); }
  catch { return jsonRes(res, 400, { ok: false, error: 'bad_json' }); }

  const next: string | null = typeof body.brandLabel === 'string' ? body.brandLabel : null;
  const r = await brandStore.updateBotBrandLabel(cachedLarkAppId, next);
  if (!r.ok) return jsonRes(res, 400, { ok: false, error: r.reason });
  jsonRes(res, 200, { ok: true, brandLabel: r.brandLabel });
});

// Sparse per-bot reply-card style. Invalid hand edits are deliberately
// normalized field-by-field: cosmetic configuration must never make sends or
// the Dashboard fail. Missing/default fields are removed from bots.json.
ipcRoute('PUT', '/api/bot-reply-style', async (req, res) => {
  if (!cachedLarkAppId) return jsonRes(res, 503, { error: 'larkAppId_not_set' });
  let body: unknown;
  try { body = await readJsonBody<unknown>(req, REPLY_STYLE_REQUEST_MAX_BYTES); }
  catch (err) {
    if (err instanceof JsonBodyTooLargeError) {
      return jsonRes(res, 413, { ok: false, error: 'body_too_large' });
    }
    return jsonRes(res, 400, { ok: false, error: 'bad_json' });
  }
  if (!hasExactSafeJsonKeys(body, ['replyStyle'])) {
    return jsonRes(res, 400, { ok: false, error: 'invalid_body' });
  }
  if (
    body.replyStyle !== null
    && (typeof body.replyStyle !== 'object' || Array.isArray(body.replyStyle))
  ) {
    return jsonRes(res, 400, { ok: false, error: 'invalid_body' });
  }

  const normalized = normalizeSparseReplyStyleConfig(body.replyStyle);
  const next = normalized.config;
  try {
    const persisted = await rmwBotEntry(cachedLarkAppId, (entry: any) => {
      if (next) entry.replyStyle = next;
      else delete entry.replyStyle;
      return { write: true, result: next ?? null };
    });
    if (!persisted.ok) return jsonRes(res, 400, { ok: false, error: persisted.reason });
    // Keep the daemon registry aligned with disk so newly spawned or restarted
    // workers observe the change without requiring a daemon restart. Existing
    // workers intentionally retain their spawn-time BOTMUX_REPLY_STYLE snapshot.
    try {
      const liveConfig = getBot(cachedLarkAppId).config as any;
      if (next) liveConfig.replyStyle = next;
      else delete liveConfig.replyStyle;
    } catch { /* disk remains authoritative */ }
    for (const warning of normalized.warnings) logger.warn(`[reply-style] ${warning}`);
    jsonRes(res, 200, {
      ok: true,
      replyStyle: persisted.result,
      ...(normalized.warnings.length > 0 ? { warnings: normalized.warnings } : {}),
    });
  } catch (err: any) {
    jsonRes(res, 500, { ok: false, error: err?.message ?? String(err) });
  }
});

// 机器人改名（dashboard 档案头 ✎ 入口）。Body `{ name: string }`。
// 主路径：daemon 注册的 renamer 走开放平台自动化真改飞书应用名（改基础信息 +
// 建版发布，群内显示名生效）；失败（Web 登录态过期 / 非协作者 / lark 租户等）
// 自动降级为仅改 botmux 展示名 displayName，并把原因作为 warning 返回给前端。
// 响应：{ ok, mode: 'feishu'|'local', botName, warning?, message? }。
ipcRoute('PUT', '/api/bot-rename', async (req, res) => {
  if (!cachedLarkAppId) return jsonRes(res, 503, { error: 'larkAppId_not_set' });
  let body: { name?: unknown };
  try { body = await readJsonBody<{ name?: unknown }>(req); }
  catch { return jsonRes(res, 400, { ok: false, error: 'bad_json' }); }

  const spec = findConfigField('displayName');
  if (!spec) return jsonRes(res, 500, { ok: false, error: 'spec_missing' });
  const raw = typeof body.name === 'string' ? body.name.trim() : '';
  if (!raw) return jsonRes(res, 400, { ok: false, error: 'name_required' });
  // 长度等校验与 IM /config 入口共用（字段 spec 的 maxLen，coerceConfigValue 执行）。
  const c = coerceConfigValue(spec, raw);
  if (!c.ok) return jsonRes(res, 400, { ok: false, error: c.reason });
  const name = c.value as string;

  // 主路径：开放平台真改名（daemon 注册；成功时 daemon 侧已同步 botName /
  // descriptor / bots-info 并清掉冗余的 displayName）。
  if (botRenamer) {
    let renamed: BotRenameOutcome;
    try {
      renamed = await botRenamer(name);
    } catch (err) {
      renamed = { ok: false, reason: 'api_error', message: err instanceof Error ? err.message : String(err) };
    }
    if (renamed.ok) {
      return jsonRes(res, 200, { ok: true, mode: 'feishu', botName: getBotName() });
    }
    // 降级：仅改 botmux 展示名，带上飞书侧失败原因让前端明示。
    const fallback = await applyConfigField(cachedLarkAppId, spec, name);
    if (!fallback.ok) return jsonRes(res, 400, { ok: false, error: fallback.reason, warning: renamed.reason, message: renamed.message });
    return jsonRes(res, 200, { ok: true, mode: 'local', botName: getBotName(), warning: renamed.reason, message: renamed.message });
  }

  // 无 renamer（daemon 未注册，理论上只在测试环境出现）→ 直接走本地展示名。
  const r = await applyConfigField(cachedLarkAppId, spec, name);
  if (!r.ok) return jsonRes(res, 400, { ok: false, error: r.reason });
  jsonRes(res, 200, { ok: true, mode: 'local', botName: getBotName(), warning: 'renamer_not_wired' });
});

// 机器人改头像（dashboard 档案头头像入口）。Body `{ imageBase64: string }`——
// 512×512 PNG 的 base64（可带 data URL 前缀，前端 canvas 归一化产出）。走开放
// 平台自动化真改飞书应用头像（上传图片 + 改基础信息 + 建版发布，群内头像生效）。
// 头像没有本地降级等价物：失败直接把结构化原因返回（no_session / session_expired
// 时前端引导扫码重登）。响应：{ ok, avatarUrl?, versionId? } | { ok:false, error, message }。
ipcRoute('PUT', '/api/bot-avatar', async (req, res) => {
  if (!cachedLarkAppId) return jsonRes(res, 503, { error: 'larkAppId_not_set' });
  let body: { imageBase64?: unknown } | null;
  try { body = await readJsonBody<{ imageBase64?: unknown } | null>(req); }
  catch { return jsonRes(res, 400, { ok: false, error: 'bad_json' }); }

  // JSON 顶层可以是 null / 数组 / 标量——属性访问前先收窄成普通对象（400 而非 500）。
  const rawB64 = typeof body?.imageBase64 === 'string'
    ? body.imageBase64.replace(/^data:image\/[a-z+.-]+;base64,/i, '').trim()
    : '';
  if (!rawB64) return jsonRes(res, 400, { ok: false, error: 'image_required' });
  // 512×512 PNG 远小于此上限；超出即拒，避免把任意大 payload 灌进 console 上传。
  if (rawB64.length > 3_000_000) return jsonRes(res, 413, { ok: false, error: 'image_too_large' });
  const image = Buffer.from(rawB64, 'base64');

  if (!botAvatarChanger) return jsonRes(res, 501, { ok: false, error: 'avatar_not_wired' });
  let changed: BotAvatarOutcome;
  try {
    changed = await botAvatarChanger(image);
  } catch (err) {
    changed = { ok: false, reason: 'api_error', message: err instanceof Error ? err.message : String(err) };
  }
  if (changed.ok) {
    return jsonRes(res, 200, { ok: true, avatarUrl: changed.avatarUrl, versionId: changed.versionId });
  }
  // invalid_image 是调用方参数问题（4xx），其余是飞书侧/环境失败（502）。
  const status = changed.reason === 'invalid_image' ? 400 : 502;
  jsonRes(res, status, { ok: false, error: changed.reason, message: changed.message });
});

// 机器人多语言名片描述读/写（dashboard 档案头「飞书名片描述」入口）。
//   GET  /api/bot-description → { ok, primaryLang, languages:[{lang,description}] }
//   PUT  /api/bot-description  Body `{ descriptions: { zh_cn, en_us, ... } }`
// 走开放平台自动化真改飞书应用描述（全量回写 base_info + 建版发布，名片生效）。
// 描述没有本地降级等价物：失败把结构化原因返回（no_session / session_expired 时
// 前端引导扫码重登；languages_changed 时前端刷新重填）。manager 未注册（API-only
// bot / 测试环境）→ 501。
function descriptionFailureStatus(reason: string): number {
  switch (reason) {
    case 'languages_changed':
      return 409;
    case 'invalid_descriptions':
    case 'description_required':
    case 'description_too_long':
      return 400;
    default:
      // no_session / session_expired / no_access / unsupported_brand / api_error
      return 502;
  }
}

ipcRoute('GET', '/api/bot-description', async (_req, res) => {
  if (!cachedLarkAppId) return jsonRes(res, 503, { error: 'larkAppId_not_set' });
  if (!botDescriptionManager) return jsonRes(res, 501, { ok: false, error: 'description_not_wired' });
  const result = await botDescriptionManager.read();
  if (result.ok) {
    return jsonRes(res, 200, { ok: true, primaryLang: result.primaryLang, languages: result.languages });
  }
  jsonRes(res, descriptionFailureStatus(result.reason), { ok: false, error: result.reason, message: result.message });
});

ipcRoute('PUT', '/api/bot-description', async (req, res) => {
  if (!cachedLarkAppId) return jsonRes(res, 503, { error: 'larkAppId_not_set' });
  if (!botDescriptionManager) return jsonRes(res, 501, { ok: false, error: 'description_not_wired' });
  let body: unknown;
  try { body = await readJsonBody<unknown>(req, 64 * 1024); }
  catch (err) {
    if (err instanceof JsonBodyTooLargeError) return jsonRes(res, 413, { ok: false, error: 'body_too_large' });
    return jsonRes(res, 400, { ok: false, error: 'invalid_json' });
  }
  // 顶层只允许 { descriptions }，防原型污染与多余键。
  if (!hasExactSafeJsonKeys(body, ['descriptions'])) {
    return jsonRes(res, 400, { ok: false, error: 'invalid_body' });
  }
  const normalized = normalizeBotDescriptions((body as Record<string, unknown>).descriptions);
  if (!normalized.ok) {
    return jsonRes(res, 400, { ok: false, error: normalized.reason, lang: normalized.lang });
  }
  const result = await botDescriptionManager.update(normalized.descriptions);
  if (result.ok) {
    return jsonRes(res, 200, {
      ok: true,
      primaryLang: result.primaryLang,
      descriptions: result.descriptions,
      versionId: result.versionId,
    });
  }
  jsonRes(res, descriptionFailureStatus(result.reason), { ok: false, error: result.reason, message: result.message, lang: result.lang });
});

// Per-bot agent launch settings. Body `{ cliId, model, cliRuntime? }` where `cliId` is the
// dashboard selection key (plain adapter id or a wrapper option such as
// `ttadk-x-codex`). Changes affect the next spawned CLI session; existing
// sessions frozen on a different cliId/wrapperCli are closed immediately, so
// a later lazy resume can't resurrect the old CLI (#346 covered the restart
// path; this covers the hot-switch path).
ipcRoute('PUT', '/api/bot-agent', async (req, res) => {
  if (!cachedLarkAppId) return jsonRes(res, 503, { error: 'larkAppId_not_set' });
  const larkAppId = cachedLarkAppId;
  let body: { cliId?: unknown; model?: unknown; reasoningEffort?: unknown; turnTimeoutMs?: unknown; cliRuntime?: unknown; dshRuntime?: unknown };
  try { body = await readJsonBody<{ cliId?: unknown; model?: unknown; reasoningEffort?: unknown; turnTimeoutMs?: unknown; cliRuntime?: unknown; dshRuntime?: unknown }>(req); }
  catch { return jsonRes(res, 400, { ok: false, error: 'bad_json' }); }

  const key = typeof body.cliId === 'string' && body.cliId.trim() ? body.cliId.trim() : '';
  if (!key) return jsonRes(res, 400, { ok: false, error: 'cli_required' });
  let selected: ReturnType<typeof resolveCliSelection>;
  try {
    selected = resolveCliSelection(key);
  } catch (err: any) {
    return jsonRes(res, 400, { ok: false, error: 'invalid_cli', message: err?.message ?? String(err) });
  }
  const model = typeof body.model === 'string' ? body.model.trim() : '';
  const reasoningEffortFieldPresent = Object.prototype.hasOwnProperty.call(body, 'reasoningEffort');
  const reasoningEffort = isCodexReasoningEffort(body.reasoningEffort) ? body.reasoningEffort : null;
  if (body.reasoningEffort !== undefined && body.reasoningEffort !== '' && reasoningEffort === null) {
    return jsonRes(res, 400, { ok: false, error: 'invalid_reasoning_effort' });
  }
  const currentBotConfig = getBot(larkAppId).config;
  const supportsReasoningEffort = isConfigurableReasoningCliId(selected.cliId);
  // Per-bot dsh runner turn timeout. Only the dsh adapter forwards it
  // (`--turn-timeout-ms`); the dashboard exposes the field for dsh only. The
  // field is optional in the body, so distinguish absent (preserve) from
  // present-but-empty (clear → runner default) like reasoningEffort does.
  const supportsTurnTimeout = selected.cliId === 'dsh';
  const turnTimeoutFieldPresent = Object.prototype.hasOwnProperty.call(body, 'turnTimeoutMs');
  let nextTurnTimeoutMs: number | undefined;
  if (turnTimeoutFieldPresent && body.turnTimeoutMs !== null && body.turnTimeoutMs !== '') {
    const n = Number(body.turnTimeoutMs);
    // Positive integer within the arm-able bound; reject anything else so an
    // over-bound value can't wrap to ~1ms in the runner's setTimeout.
    if (!Number.isInteger(n) || n <= 0 || n > MAX_TURN_TIMEOUT_MS) {
      return jsonRes(res, 400, { ok: false, error: 'invalid_turn_timeout_ms' });
    }
    nextTurnTimeoutMs = n;
  }
  // dsh-only runtime variant (official JSON-RPC runner vs dsh-tui PTY TUI).
  // Same present/absent semantics as turnTimeoutMs: absent preserves, present
  // writes/clears, non-dsh always drops.
  const supportsDshRuntime = selected.cliId === 'dsh';
  const dshRuntimeFieldPresent = Object.prototype.hasOwnProperty.call(body, 'dshRuntime');
  let nextDshRuntime: 'official' | 'tui' | undefined;
  if (dshRuntimeFieldPresent && body.dshRuntime !== null && body.dshRuntime !== '') {
    if (body.dshRuntime !== 'official' && body.dshRuntime !== 'tui') {
      return jsonRes(res, 400, { ok: false, error: 'invalid_dsh_runtime' });
    }
    nextDshRuntime = body.dshRuntime;
  }
  const runtimeFieldPresent = Object.prototype.hasOwnProperty.call(body, 'cliRuntime');
  const currentSelectionKey = selectionKeyForBot(currentBotConfig.cliId, currentBotConfig.wrapperCli);
  const selectionChanged = key !== currentSelectionKey;
  let nextRuntime: CliRuntimeConfig | undefined;
  let nextLegacyPath: string | undefined;
  if (runtimeFieldPresent) {
    if (body.cliRuntime !== null) {
      if (selected.cliId !== 'codex') {
        return jsonRes(res, 400, { ok: false, error: 'runtime_requires_codex' });
      }
      if (selected.wrapperCli) {
        return jsonRes(res, 400, { ok: false, error: 'runtime_wrapper_conflict' });
      }
      try {
        nextRuntime = normalizeCliRuntimeConfig(body.cliRuntime, 'cliRuntime');
      } catch (err) {
        return jsonRes(res, 400, {
          ok: false,
          error: 'invalid_cli_runtime',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
    // null explicitly means built-in runtime; both structured and legacy
    // executable overrides are cleared.
  } else if (!selectionChanged) {
    // Old dashboard clients know only `{cliId, model}`. Preserve the runtime on
    // same-agent saves so editing a model cannot silently erase new config.
    nextRuntime = currentBotConfig.cliRuntime;
    nextLegacyPath = nextRuntime ? undefined : currentBotConfig.cliPathOverride;
  }
  const effectivePath = nextRuntime?.executable ?? nextLegacyPath;
  const availability = checkCliAvailability({
    cliId: selected.cliId,
    wrapperCli: selected.wrapperCli,
    cliPathOverride: effectivePath,
  });
  // dsh-tui mode spawns the dsh-tui binary instead of the dsh runner. Check it
  // separately so a missing dsh-tui install surfaces as a save-time warning
  // rather than a spawn-time ENOENT crash-loop.
  let dshTuiAvailability: { available: boolean; command?: string; reason?: string } | undefined;
  if (supportsDshRuntime && nextDshRuntime === 'tui') {
    dshTuiAvailability = checkCliAvailability({ cliId: 'dsh-tui' });
  }
  let runtimeProbe: { version: string; updateProvider: string } | undefined;
  if (runtimeFieldPresent && nextRuntime) {
    if (!availability.available) {
      return jsonRes(res, 400, {
        ok: false,
        error: 'runtime_unavailable',
        message: availability.reason ?? 'runtime executable is unavailable',
      });
    }
    try {
      const raw = execFileSync(availability.resolvedPath ?? nextRuntime.executable, ['--version'], {
        encoding: 'utf8',
        timeout: 5_000,
        stdio: ['ignore', 'pipe', 'pipe'],
        maxBuffer: 2 * 1024 * 1024,
      }).trim();
      const version = raw.match(/\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/)?.[0];
      if (!version) throw new Error(`无法识别 --version 输出：${raw.slice(0, 120)}`);
      runtimeProbe = { version, updateProvider: nextRuntime.update?.provider ?? 'auto' };
    } catch (err) {
      return jsonRes(res, 400, {
        ok: false,
        error: 'runtime_version_probe_failed',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
  // Existing Bot edits remain saveable (operators may intentionally configure
  // first and install second), but the response is explicit so Dashboard never
  // claims a missing Agent was saved successfully without qualification.
  let availabilityWarning = availability.available
    ? undefined
    : `配置已保存，但所选 Agent 当前无法启动：${availability.reason ?? '本地启动依赖不可用'}。请先在 daemon 所在机器安装或修正 PATH / CLI 路径。`;
  if (dshTuiAvailability && !dshTuiAvailability.available) {
    const tuiWarning = `配置已保存，但 dsh-tui 未安装（${dshTuiAvailability.reason ?? 'dsh-tui 二进制不在 PATH'}）。请在 daemon 所在机器安装 @deepseek-harness-tui/dsh-tui。`;
    availabilityWarning = availabilityWarning ? `${availabilityWarning} ${tuiWarning}` : tuiWarning;
  }

  return withBotTurnMutation(larkAppId, async () => {
    // Agent selection can replace every live worker generation and may also
    // auto-clear readIsolation. Close admission and drain in-flight acceptance
    // before inspecting both the registry and restart source of truth. A
    // settings mutation is not an explicit abandon boundary: an unsettled
    // Codex App FIFO must survive unchanged for recovery.
    const activeBotSessions = listActiveSessions().filter(ds => ds.larkAppId === larkAppId);
    const persistedActiveBotSessions = sessionStore.listSessions().filter(session =>
      session.status === 'active'
      && (session.larkAppId === larkAppId || !session.larkAppId),
    );
    if (rejectProtectedSessionMutation(res, [
      ...activeBotSessions,
      ...persistedActiveBotSessions,
    ])) return;

    // If the new CLI/wrapper can no longer enforce a currently-on read isolation,
    // auto-clear the flag here so the next session doesn't fail-close on it. (The
    // read-isolation toggle validates at enable time; changing the agent afterwards
    // is the other way a bot could end up configured-but-unenforceable.)
    let readIsolationCleared = false;
    const r = await rmwBotEntry<{
      error?: 'reasoning_effort_not_supported_by_model';
      nextReasoningEffort?: typeof reasoningEffort;
    }>(larkAppId, (entry) => {
    const nextReasoningEffort = supportsReasoningEffort
      ? (reasoningEffortFieldPresent ? reasoningEffort ?? undefined : entry.reasoningEffort)
      : undefined;
    if (nextReasoningEffort && !cliModelSupportsReasoningEffort(selected.cliId, model || undefined, nextReasoningEffort)) {
      return { write: false, result: { error: 'reasoning_effort_not_supported_by_model' } };
    }
    entry.cliId = selected.cliId;
    if (selected.wrapperCli) entry.wrapperCli = selected.wrapperCli;
    else delete entry.wrapperCli;
    if (nextRuntime) {
      entry.cliRuntime = nextRuntime;
      // Downgrade shadow: older BotMux versions ignore cliRuntime but retain
      // cliPathOverride, so a rollback still launches this distribution.
      entry.cliPathOverride = nextRuntime.executable;
    } else if (nextLegacyPath) {
      entry.cliPathOverride = nextLegacyPath;
      delete entry.cliRuntime;
    } else {
      delete entry.cliRuntime;
      delete entry.cliPathOverride;
    }
    if (model) entry.model = model;
    else delete entry.model;
    if (!supportsReasoningEffort) delete entry.reasoningEffort;
    else if (reasoningEffortFieldPresent) {
      if (reasoningEffort) entry.reasoningEffort = reasoningEffort;
      else delete entry.reasoningEffort;
    }
    // dsh-only turn timeout: non-dsh always drops it; on dsh, an explicit
    // field value writes/clears it, absence preserves the current value.
    if (!supportsTurnTimeout) delete entry.turnTimeoutMs;
    else if (turnTimeoutFieldPresent) {
      if (nextTurnTimeoutMs !== undefined) entry.turnTimeoutMs = nextTurnTimeoutMs;
      else delete entry.turnTimeoutMs;
    }
    // dsh-only runtime variant: same present/absent semantics as turnTimeoutMs.
    if (!supportsDshRuntime) delete entry.dshRuntime;
    else if (dshRuntimeFieldPresent) {
      if (nextDshRuntime !== undefined) entry.dshRuntime = nextDshRuntime;
      else delete entry.dshRuntime;
    }
    if (entry.readIsolation === true &&
        !readIsolationEnforceableFor({ cliId: selected.cliId, cliPathOverride: effectivePath, wrapperCli: selected.wrapperCli })) {
      delete entry.readIsolation;
      readIsolationCleared = true;
    }
    // 远端 CLI（riff / mojo）→ backendType 自动设为同名后端（否则 spawn 走 pty 后端，
    // 而它们的 resolvedBin 是空串）。mojo 加入后这里必须按「是否远端」判断，不能再
    // 硬编码 riff。
    if (isRemoteCliId(selected.cliId)) {
      entry.backendType = selected.cliId as typeof entry.backendType;
    } else if (entry.backendType && isRemoteBackendType(entry.backendType)) {
      // 从远端 CLI 切回其它 CLI：清掉这个自动配对的 backend override，回落 daemon
      // 默认后端——否则新 CLI 会跑在远端 Backend 上（PTY 分块输入被当成一串远端
      // turn）。手动的 pty/tmux/herdr/zellij override 不受影响（它们不是远端后端）。
      delete entry.backendType;
    }
    return { write: true, result: { nextReasoningEffort } };
    });
    if (!r.ok) return jsonRes(res, 400, { ok: false, error: r.reason });
    if (r.result.error) {
      return jsonRes(res, 400, {
        ok: false,
        error: r.result.error,
        message: `模型 ${model || '（Agent 默认模型）'} 不支持当前思考强度`,
      });
    }

    const bot = getBot(larkAppId);
    bot.config.cliId = selected.cliId;
    bot.config.cliRuntime = nextRuntime;
    bot.config.cliPathOverride = nextRuntime?.executable ?? nextLegacyPath;
    if (selected.wrapperCli) bot.config.wrapperCli = selected.wrapperCli;
    else bot.config.wrapperCli = undefined;
    bot.config.model = model || undefined;
    if (!supportsReasoningEffort) bot.config.reasoningEffort = undefined;
    else bot.config.reasoningEffort = r.result.nextReasoningEffort ?? undefined;
    // Mirror the entry write: non-dsh clears it, dsh with an explicit field
    // takes the parsed value, dsh without the field preserves the existing one.
    if (!supportsTurnTimeout) bot.config.turnTimeoutMs = undefined;
    else if (turnTimeoutFieldPresent) bot.config.turnTimeoutMs = nextTurnTimeoutMs;
    // dsh-only runtime variant: same mirror semantics as turnTimeoutMs.
    if (!supportsDshRuntime) bot.config.dshRuntime = undefined;
    else if (dshRuntimeFieldPresent) bot.config.dshRuntime = nextDshRuntime;
    if (readIsolationCleared) bot.config.readIsolation = false;
    if (isRemoteCliId(selected.cliId)) {
      bot.config.backendType = selected.cliId as typeof bot.config.backendType;
    } else if (bot.config.backendType && isRemoteBackendType(bot.config.backendType)) {
      bot.config.backendType = undefined;
    }

    // 热切后立刻清掉本 bot 名下失配的存量会话——否则它们冻结的旧 CLI 会被下一条
    // 消息 lazy resume 复活，要等下次 daemon 重启才被 restore 守卫清理。
    const closedMismatchedSessions = await closeCliMismatchedSessionsForBot(larkAppId);

    const selectionKey = selectionKeyForBot(selected.cliId, selected.wrapperCli);
    jsonRes(res, 200, {
      ok: true,
      cliId: selected.cliId,
      cliRuntime: nextRuntime ?? null,
      cliPathOverride: nextRuntime ? null : nextLegacyPath ?? null,
      wrapperCli: selected.wrapperCli ?? null,
      model: model || null,
      reasoningEffort: supportsReasoningEffort ? bot.config.reasoningEffort ?? null : null,
      turnTimeoutMs: supportsTurnTimeout ? bot.config.turnTimeoutMs ?? null : null,
      dshRuntime: supportsDshRuntime ? bot.config.dshRuntime ?? null : null,
      selectionKey,
      // Number kept for compatibility with an older dashboard bundle; the residual
      // count rides alongside so a hot CLI switch cannot silently strand a remote
      // session behind a plain "closed N". (mojo/riff sessions live off-box, so a
      // local row can close while the remote one survives.)
      closedMismatchedSessions: closedMismatchedSessions.closed,
      closedMismatchedResidual: closedMismatchedSessions.residual,
      closedMismatchedFailed: closedMismatchedSessions.failed,
      // Report the (possibly auto-cleared) read-isolation state + whether the new
      // agent can still enforce it, so the dashboard updates its toggle immediately
      // instead of showing a stale enabled/supported state until a full refetch.
      readIsolation: bot.config.readIsolation === true,
      readIsolationSupported: readIsolationEnforceableFor(bot.config),
      readIsolationCleared,
      agentAvailable: availability.available,
      availabilityWarning,
      requiredCommand: availability.command,
      runtimeProbe,
    });
  });
});

// ─── 会话群标签授权（feed-group OAuth，Dashboard 一站式流程）────────────────
// POST /api/oauth-callback {url} — dashboard 的 /oauth/callback 接收页把回调
// URL 广播给各 daemon；state 在本进程 pendingLogins 里的那个完成 code→token
// 交换，其它 daemon 返回 matched:false 让 dashboard 继续尝试下一个。
ipcRoute('POST', '/api/oauth-callback', async (req, res) => {
  let body: { url?: unknown };
  try { body = await readJsonBody<{ url?: unknown }>(req); }
  catch { return jsonRes(res, 400, { ok: false, error: 'bad_json' }); }
  if (typeof body.url !== 'string' || !body.url.trim()) {
    return jsonRes(res, 400, { ok: false, error: 'url_required' });
  }
  const result = await tryHandleCallbackUrl(body.url.trim());
  if (!result) return jsonRes(res, 200, { ok: false, matched: false, message: 'not a callback url' });
  jsonRes(res, 200, { ok: result.ok, matched: result.matched, message: result.message });
});

// POST /api/session-group-tag-auth — 生成带 feed-group scope 的授权链接。
// pending state 由 generateAuthUrl 落盘（~/.botmux/data/oauth-pending/），回调既可
// 经本进程 /api/oauth-callback、也可经 dashboard 的 /api/feed-groups/oauth-callback
// 跨进程完成换 token（远程浏览器粘贴兜底正依赖这条跨进程路径）。
ipcRoute('POST', '/api/session-group-tag-auth', async (_req, res) => {
  if (!cachedLarkAppId) return jsonRes(res, 503, { error: 'larkAppId_not_set' });
  try {
    const cfg = getBot(cachedLarkAppId).config;
    const { authUrl } = generateAuthUrl(
      cfg.larkAppId,
      cfg.larkAppSecret,
      normalizeBrand(cfg.brand),
      FEED_GROUP_OAUTH_SCOPES,
    );
    jsonRes(res, 200, { ok: true, authUrl });
  } catch (e: any) {
    jsonRes(res, 500, { ok: false, error: e?.message ?? String(e) });
  }
});

// GET /api/session-group-tag-status — 标签授权状态（Dashboard 徽标）+ 标签名。
// tagName = 用户配置的自定义名（没配就是空串）；defaultTagName = 留空时实际生效的
// 默认名「<bot 显示名>会话」，Dashboard 拿它做输入框 placeholder。
ipcRoute('GET', '/api/session-group-tag-status', async (_req, res) => {
  if (!cachedLarkAppId) return jsonRes(res, 503, { error: 'larkAppId_not_set' });
  try {
    const cfg = getBot(cachedLarkAppId).config;
    const status = getFeedGroupAuthStatus(cfg.larkAppId, normalizeBrand(cfg.brand));
    jsonRes(res, 200, {
      ok: true,
      ...status,
      tagMode: cfg.sessionGroup?.tag?.mode ?? 'feed-group',
      tagName: cfg.sessionGroup?.tag?.name ?? '',
      defaultTagName: defaultSessionTagName(cachedLarkAppId),
    });
  } catch (e: any) {
    jsonRes(res, 500, { ok: false, error: e?.message ?? String(e) });
  }
});

// PUT /api/session-group-tag-config — 会话群标签模式 + 标签名（Dashboard 的
// 「会话群标签」区块，PR review：授权行必须与实际 tagMode 一致）。
// Body `{ mode?, name? }`，两者都可单独提交（Dashboard 下拉只发 mode、输入框只发
// name），但至少要带一个：
//   mode: 'feed-group'（默认，个人侧边栏分组，需一次 OAuth，任何租户可用）|
//         'chat-tag'（应用租户身份，无需用户授权，但部分租户权限目录无该 scope）| 'off'
//   name: 自定义标签名；trim 后为空 = 删掉该字段回默认名「<bot 显示名>会话」。
//         超长按码点保守截断（clampSessionTagName），存进去的就是实际生效的。
// 写 bots.json 的 sessionGroup.tag 并热更内存注册表，与 /botconfig 同一持久化通道。
ipcRoute('PUT', '/api/session-group-tag-config', async (req, res) => {
  if (!cachedLarkAppId) return jsonRes(res, 503, { error: 'larkAppId_not_set' });
  let body: { mode?: unknown; name?: unknown };
  try { body = await readJsonBody<{ mode?: unknown; name?: unknown }>(req); }
  catch { return jsonRes(res, 400, { ok: false, error: 'bad_json' }); }
  const hasMode = body.mode !== undefined && body.mode !== null;
  const hasName = body.name !== undefined && body.name !== null;
  const mode = body.mode === 'chat-tag' || body.mode === 'feed-group' || body.mode === 'off'
    ? body.mode : undefined;
  if (hasMode && !mode) return jsonRes(res, 400, { ok: false, error: 'invalid_mode' });
  if (hasName && typeof body.name !== 'string') return jsonRes(res, 400, { ok: false, error: 'invalid_name' });
  // 一个字段都没带 → 沿用原来的 invalid_mode（老 dashboard 只发 mode，语义不变）。
  if (!hasMode && !hasName) return jsonRes(res, 400, { ok: false, error: 'invalid_mode' });
  const name = hasName ? clampSessionTagName(body.name as string) : undefined;
  try {
    const bot = getBot(cachedLarkAppId);
    const r = await rmwBotEntry(cachedLarkAppId, (entry: any) => {
      if (!entry.sessionGroup || typeof entry.sessionGroup !== 'object') entry.sessionGroup = {};
      if (!entry.sessionGroup.tag || typeof entry.sessionGroup.tag !== 'object') entry.sessionGroup.tag = {};
      if (mode) entry.sessionGroup.tag.mode = mode;
      if (hasName) {
        if (name) entry.sessionGroup.tag.name = name;
        else delete entry.sessionGroup.tag.name; // 留空 = 清配置回默认，bots.json 保持干净
      }
      return { write: true, result: mode };
    });
    if (!r.ok) return jsonRes(res, 400, { ok: false, error: r.reason });
    const tag = { ...(bot.config.sessionGroup?.tag ?? {}) };
    if (mode) tag.mode = mode;
    if (hasName) {
      if (name) tag.name = name;
      else delete tag.name;
    }
    bot.config.sessionGroup = { ...(bot.config.sessionGroup ?? {}), tag };
    jsonRes(res, 200, {
      ok: true,
      tagMode: tag.mode ?? 'feed-group',
      tagName: tag.name ?? '',
      defaultTagName: defaultSessionTagName(cachedLarkAppId),
    });
  } catch (e: any) {
    jsonRes(res, 500, { ok: false, error: e?.message ?? String(e) });
  }
});

// Per-bot 私聊单聊模式 p2pMode。Body `{ p2pMode: 'chat' | 'thread' | 'group' }`:
//   • 'chat'（默认）    → 私聊走扁平连续 chat-scope 会话
//   • 'thread'          → 显式回到每条 DM 独立 thread-scope 会话
//   • 'group'           → 每条顶层 DM 自动建专属会话群并把会话落进去
// 走 applyConfigField（与 /botconfig 同一写盘 + 热更新路径），保证一致。
ipcRoute('PUT', '/api/bot-p2p-mode', async (req, res) => {
  if (!cachedLarkAppId) return jsonRes(res, 503, { error: 'larkAppId_not_set' });
  let body: { p2pMode?: unknown };
  try { body = await readJsonBody<{ p2pMode?: unknown }>(req); }
  catch { return jsonRes(res, 400, { ok: false, error: 'bad_json' }); }

  const spec = findConfigField('p2pMode');
  if (!spec) return jsonRes(res, 500, { ok: false, error: 'spec_missing' });
  // 只有 'thread' / 'group' 有意义；其它（含 'chat'，新默认)一律清回默认，bots.json 保持干净。
  const value = body.p2pMode === 'thread' ? 'thread' : body.p2pMode === 'group' ? 'group' : null;
  const r = await applyConfigField(cachedLarkAppId, spec, value);
  if (!r.ok) return jsonRes(res, 400, { ok: false, error: r.reason });
  jsonRes(res, 200, { ok: true, p2pMode: value ?? 'chat' });
});

// Per-bot 每轮上下文注入方式 envelopeInjection（#794）。Body `{ envelopeInjection: 'auto'|'off'|'' }`:
//   • 'auto' → 支持的 CLI（claude-code）把 reminder/whiteboard 经 UserPromptSubmit
//     hook 注入为 system-reminder，user turn 只留消息本身；不支持的自动回退内联
//   • 'off'/其它 → 内联 envelope（历史行为，默认）
// 走 applyConfigField（与 /botconfig 同一写盘 + 热更新路径），下一个 follow-up turn 生效。
ipcRoute('PUT', '/api/bot-envelope-injection', async (req, res) => {
  if (!cachedLarkAppId) return jsonRes(res, 503, { error: 'larkAppId_not_set' });
  let body: { envelopeInjection?: unknown };
  try { body = await readJsonBody<{ envelopeInjection?: unknown }>(req); }
  catch { return jsonRes(res, 400, { ok: false, error: 'bad_json' }); }

  const spec = findConfigField('envelopeInjection');
  if (!spec) return jsonRes(res, 500, { ok: false, error: 'spec_missing' });
  const value = body.envelopeInjection === 'auto' ? 'auto' : null;
  const r = await applyConfigField(cachedLarkAppId, spec, value);
  if (!r.ok) return jsonRes(res, 400, { ok: false, error: r.reason });
  jsonRes(res, 200, { ok: true, envelopeInjection: value ?? 'off' });
});

// Per-bot 内置技能注入模式 skillInjection。Body `{ skillInjection: 'global'|'prompt'|'off'|'' }`:
//   • 'global'|'prompt'|'off' → 显式覆盖本 bot
//   • ''/其它                  → 清回机器级默认（config.json skills.builtinInjection）
// 走 applyConfigField（与 /config 同一写盘 + 热更新路径）。next-session 生效；
// 切到/离开 global 的全局盘安装受 once-cache 限，需重启 daemon 才完全生效。
ipcRoute('PUT', '/api/bot-skill-injection', async (req, res) => {
  if (!cachedLarkAppId) return jsonRes(res, 503, { error: 'larkAppId_not_set' });
  let body: { skillInjection?: unknown };
  try { body = await readJsonBody<{ skillInjection?: unknown }>(req); }
  catch { return jsonRes(res, 400, { ok: false, error: 'bad_json' }); }

  const spec = findConfigField('skillInjection');
  if (!spec) return jsonRes(res, 500, { ok: false, error: 'spec_missing' });
  const v = body.skillInjection;
  const value = v === 'global' || v === 'prompt' || v === 'off' ? v : null;
  const r = await applyConfigField(cachedLarkAppId, spec, value);
  if (!r.ok) return jsonRes(res, 400, { ok: false, error: r.reason });
  jsonRes(res, 200, { ok: true, skillInjection: value });
});

// Per-bot 启动命令 startupCommands。Body `{ startupCommands: string }`（原始文本，
// 逗号/换行分隔，每条可带参数如 `/effort ultracode`）：空白 → 清除（不发任何命令）。
// 走 applyConfigField（与 /botconfig 文本子卡同一写盘 + 内存热更新路径），next-session
// 生效（下个会话起按序自动发）。
ipcRoute('PUT', '/api/bot-startup-commands', async (req, res) => {
  if (!cachedLarkAppId) return jsonRes(res, 503, { error: 'larkAppId_not_set' });
  let body: { startupCommands?: unknown };
  try { body = await readJsonBody<{ startupCommands?: unknown }>(req); }
  catch { return jsonRes(res, 400, { ok: false, error: 'bad_json' }); }

  const spec = findConfigField('startupCommands');
  if (!spec) return jsonRes(res, 500, { ok: false, error: 'spec_missing' });
  const raw = typeof body.startupCommands === 'string' ? body.startupCommands : '';
  let value: string[] | null;
  if (!raw.trim()) {
    value = null;  // 清除
  } else {
    const coerced = coerceConfigValue(spec, raw);
    if (!coerced.ok) return jsonRes(res, 400, { ok: false, error: coerced.reason });
    value = coerced.value as string[];
  }
  const r = await applyConfigField(cachedLarkAppId, spec, value);
  if (!r.ok) return jsonRes(res, 400, { ok: false, error: r.reason });
  jsonRes(res, 200, { ok: true, startupCommands: (value ?? []).join('\n') });
});

// Per-bot 透传 slash 命令 customPassthroughCommands。Body `{ customPassthroughCommands: string }`
// （原始文本，逗号/空格分隔；空白＝清除→回仅内置白名单）。走 stringList 的
// coerceConfigValue（用字段自带 parseList，与 /botconfig 同口径）+ applyConfigField
// （写盘 + 内存热更新），immediate 生效。回包 space-joined 供输入框回填。
ipcRoute('PUT', '/api/bot-custom-passthrough', async (req, res) => {
  if (!cachedLarkAppId) return jsonRes(res, 503, { error: 'larkAppId_not_set' });
  let body: { customPassthroughCommands?: unknown };
  try { body = await readJsonBody<{ customPassthroughCommands?: unknown }>(req); }
  catch { return jsonRes(res, 400, { ok: false, error: 'bad_json' }); }

  const spec = findConfigField('customPassthroughCommands');
  if (!spec) return jsonRes(res, 500, { ok: false, error: 'spec_missing' });
  const raw = typeof body.customPassthroughCommands === 'string' ? body.customPassthroughCommands : '';
  let value: string[] | null;
  if (!raw.trim()) {
    value = null;  // 清除 → 回仅内置白名单
  } else {
    const coerced = coerceConfigValue(spec, raw);
    if (!coerced.ok) return jsonRes(res, 400, { ok: false, error: coerced.reason });
    value = coerced.value as string[];
  }
  const r = await applyConfigField(cachedLarkAppId, spec, value);
  if (!r.ok) return jsonRes(res, 400, { ok: false, error: r.reason });
  jsonRes(res, 200, { ok: true, customPassthroughCommands: (value ?? []).join(' ') });
});

// Per-bot daemon 命令降权名单 canTalkDaemonCommands。Body
// `{ canTalkDaemonCommands: string }`（原始文本，逗号/空格分隔；空白＝清除→回全部
// 仅管理员）。走 stringList 的 coerceConfigValue（字段自带 parseList 只认 daemon
// 命令，透传/拼错条目被滤掉）+ applyConfigField（写盘 + 内存热更新），immediate 生效。
ipcRoute('PUT', '/api/bot-cantalk-daemon-commands', async (req, res) => {
  if (!cachedLarkAppId) return jsonRes(res, 503, { error: 'larkAppId_not_set' });
  let body: { canTalkDaemonCommands?: unknown };
  try { body = await readJsonBody<{ canTalkDaemonCommands?: unknown }>(req); }
  catch { return jsonRes(res, 400, { ok: false, error: 'bad_json' }); }

  const spec = findConfigField('canTalkDaemonCommands');
  if (!spec) return jsonRes(res, 500, { ok: false, error: 'spec_missing' });
  const raw = typeof body.canTalkDaemonCommands === 'string' ? body.canTalkDaemonCommands : '';
  let value: string[] | null;
  if (!raw.trim()) {
    value = null;  // 清除 → 回全部仅管理员
  } else {
    const coerced = coerceConfigValue(spec, raw);
    if (!coerced.ok) return jsonRes(res, 400, { ok: false, error: coerced.reason });
    value = coerced.value as string[];
  }
  const r = await applyConfigField(cachedLarkAppId, spec, value);
  if (!r.ok) return jsonRes(res, 400, { ok: false, error: r.reason });
  jsonRes(res, 200, { ok: true, canTalkDaemonCommands: (value ?? []).join(' ') });
});

// Per-bot launch-shell override launchShell。Body `{ launchShell: string }`：
// 空字符串＝清除（回 $SHELL）。走 applyConfigField（与 /config launchShell 同一写盘
// + 内存热更新路径），next-session 生效（下个会话起用新 shell 启动 CLI）。
ipcRoute('PUT', '/api/bot-launch-shell', async (req, res) => {
  if (!cachedLarkAppId) return jsonRes(res, 503, { error: 'larkAppId_not_set' });
  let body: { launchShell?: unknown };
  try { body = await readJsonBody<{ launchShell?: unknown }>(req); }
  catch { return jsonRes(res, 400, { ok: false, error: 'bad_json' }); }

  const spec = findConfigField('launchShell');
  if (!spec) return jsonRes(res, 500, { ok: false, error: 'spec_missing' });
  const raw = typeof body.launchShell === 'string' ? body.launchShell : '';
  let value: string | null;
  if (!raw.trim()) {
    value = null;  // 清除 → 回 $SHELL
  } else {
    const coerced = coerceConfigValue(spec, raw);
    if (!coerced.ok) return jsonRes(res, 400, { ok: false, error: coerced.reason });
    value = coerced.value as string;
  }
  const r = await applyConfigField(cachedLarkAppId, spec, value);
  if (!r.ok) return jsonRes(res, 400, { ok: false, error: r.reason });
  jsonRes(res, 200, { ok: true, launchShell: value ?? '' });
});

ipcRoute('PUT', '/api/bot-feedback', async (req, res) => {
  if (!cachedLarkAppId) return jsonRes(res, 503, { error: 'larkAppId_not_set' });
  let body: { feedback?: unknown };
  try { body = await readJsonBody<{ feedback?: unknown }>(req); }
  catch { return jsonRes(res, 400, { ok: false, error: 'bad_json' }); }
  const spec = findConfigField('feedback');
  if (!spec) return jsonRes(res, 500, { ok: false, error: 'spec_missing' });
  const raw = typeof body.feedback === 'string' ? body.feedback : '';
  let value: unknown = null;
  if (raw.trim()) {
    const coerced = coerceConfigValue(spec, raw);
    if (!coerced.ok) return jsonRes(res, 400, { ok: false, error: coerced.reason });
    value = coerced.value;
  }
  const r = await applyConfigField(cachedLarkAppId, spec, value);
  if (!r.ok) return jsonRes(res, 400, { ok: false, error: r.reason });
  jsonRes(res, 200, { ok: true, feedback: value });
});

ipcRoute('PUT', '/api/chat-feedback/:chatId', async (req, res, params) => {
  if (!cachedLarkAppId) return jsonRes(res, 503, { ok: false, error: 'larkAppId_not_set' });
  let body: { feedback?: unknown };
  try { body = await readJsonBody<{ feedback?: unknown }>(req); }
  catch { return jsonRes(res, 400, { ok: false, error: 'bad_json' }); }
  const feedback = body.feedback === null || body.feedback === undefined ? null : body.feedback;
  const result = await setChatFeedbackPolicy(cachedLarkAppId, decodeURIComponent(params.chatId), feedback as any);
  if (!result.ok) return jsonRes(res, result.reason === 'bot_not_registered' ? 404 : 400, { ok: false, error: result.reason });
  jsonRes(res, 200, { ok: true, feedback });
});

ipcRoute('GET', '/api/feedback-effective', async (req, res) => {
  if (!cachedLarkAppId) return jsonRes(res, 503, { ok: false, error: 'larkAppId_not_set' });
  const chatId = new URL(req.url ?? '/', 'http://localhost').searchParams.get('chatId') || undefined;
  jsonRes(res, 200, { ok: true, trace: traceFeedbackPolicyForDelivery({
    dataDir: config.session.dataDir, larkAppId: cachedLarkAppId, chatId, bot: getBot(cachedLarkAppId).config,
  }) });
});

// Per-bot 环境变量 env。Body `{ env: string }`（原始 JSON 文本，如
// `{"ANTHROPIC_BASE_URL":"…","ANTHROPIC_AUTH_TOKEN":"…"}` 让本 bot 走 GLM/第三方
// 服务商）：空白 → 清除；否则按 json kind 解析 + sanitizePerBotEnv 过滤后落盘。
// 走 applyConfigField（与 /botconfig 同一写盘 + 内存热更新路径），next-session 生效
// （下个会话起注入到 CLI 进程）。回包返回脱敏后的 pretty JSON 供 textarea 回填。
ipcRoute('PUT', '/api/bot-env', async (req, res) => {
  if (!cachedLarkAppId) return jsonRes(res, 503, { error: 'larkAppId_not_set' });
  let body: { env?: unknown };
  try { body = await readJsonBody<{ env?: unknown }>(req); }
  catch { return jsonRes(res, 400, { ok: false, error: 'bad_json' }); }

  const spec = findConfigField('env');
  if (!spec) return jsonRes(res, 500, { ok: false, error: 'spec_missing' });
  const raw = typeof body.env === 'string' ? body.env : '';
  let value: Record<string, string> | null;
  if (!raw.trim()) {
    value = null;  // 清除
  } else {
    const coerced = coerceConfigValue(spec, raw);
    if (!coerced.ok) return jsonRes(res, 400, { ok: false, error: coerced.reason });
    value = coerced.value as Record<string, string>;
  }
  const r = await applyConfigField(cachedLarkAppId, spec, value);
  if (!r.ok) return jsonRes(res, 400, { ok: false, error: r.reason });
  jsonRes(res, 200, { ok: true, env: value ? JSON.stringify(value, null, 2) : '' });
});

// Codex credential policy: shared global login or an independent per-bot CODEX_HOME.
ipcRoute('PUT', '/api/bot-codex-auth-sync', async (req, res) => {
  if (!cachedLarkAppId) return jsonRes(res, 503, { error: 'larkAppId_not_set' });
  let body: { codexAuthSync?: unknown };
  try { body = await readJsonBody<{ codexAuthSync?: unknown }>(req); }
  catch { return jsonRes(res, 400, { error: 'invalid_json' }); }
  if (body.codexAuthSync !== 'shared' && body.codexAuthSync !== 'isolated') {
    return jsonRes(res, 400, { ok: false, error: 'invalid_codex_auth_sync' });
  }
  const spec = findConfigField('codexAuthSync');
  if (!spec) return jsonRes(res, 500, { ok: false, error: 'field_unavailable' });
  const r = await applyConfigField(cachedLarkAppId, spec, body.codexAuthSync);
  if (!r.ok) return jsonRes(res, 400, r);
  jsonRes(res, 200, { ok: true, codexAuthSync: body.codexAuthSync });
});

// Per-bot riff 后端配置。Body `{ riff: string }`（原始 JSON 文本，如
// `{"baseUrl":"https://...","model":"gpt-5.5","reasoningEffort":"high"}`）：
// 空白 → 清除；否则按 json kind 解析后落盘。走 applyConfigField（与 /botconfig
// 同一写盘 + 内存热更新路径），next-session 生效。仅 backendType=riff 时使用。
/** riff 配置里 dashboard 可编辑的字段——PUT /bot-riff 只覆盖这些，其余保留。 */
// injectStatusLines 已从 dashboard UI 移除（恒默认开启）——不在此集合中意味着
// 存量 bots.json 值按「隐藏字段」原样保留。
const RIFF_UI_EDITABLE_KEYS = new Set(['baseUrl', 'sandboxCluster', 'model', 'reasoningEffort', 'jwtEnv', 'systemPrompt', 'setupCommands']);

/** 发给浏览器前脱敏：明文 jwt / env（可能含各类密钥）绝不进 dashboard 响应。 */
function redactRiffForClient(riff: unknown): Record<string, unknown> | null {
  if (!riff || typeof riff !== 'object') return null;
  const { jwt: _jwt, env: _env, ...safe } = riff as Record<string, unknown>;
  return safe;
}

ipcRoute('PUT', '/api/bot-riff', async (req, res) => {
  if (!cachedLarkAppId) return jsonRes(res, 503, { error: 'larkAppId_not_set' });
  let body: { riff?: unknown };
  try { body = await readJsonBody<{ riff?: unknown }>(req); }
  catch { return jsonRes(res, 400, { ok: false, error: 'bad_json' }); }

  const spec = findConfigField('riff');
  if (!spec) return jsonRes(res, 500, { ok: false, error: 'spec_missing' });
  const raw = typeof body.riff === 'string' ? body.riff : '';
  let value: Record<string, unknown> | null;
  if (!raw.trim()) {
    value = null;  // 清除（显式清空整份 riff 配置，含隐藏字段）
  } else {
    const coerced = coerceConfigValue(spec, raw);
    if (!coerced.ok) return jsonRes(res, 400, { ok: false, error: coerced.reason });
    value = coerced.value as Record<string, unknown>;
    // 合并保存：dashboard 只回写 UI 展示的字段；接口支持但 UI 未展示的字段
    // （templateId / jwt / env / logLevel / repos…）必须原样保留，否则用户只改
    // 一个 model 就会静默删掉认证等隐藏配置。
    const prev = (getBot(cachedLarkAppId).config.riff ?? {}) as Record<string, unknown>;
    const preserved = Object.fromEntries(Object.entries(prev).filter(([k]) => !RIFF_UI_EDITABLE_KEYS.has(k)));
    // Older dashboard clients do not send sandboxCluster. Preserve a valid
    // existing selection for them; a brand-new config follows Riff's BOE
    // default. New clients always submit the explicit dropdown value.
    const sandboxCluster = value.sandboxCluster ?? prev.sandboxCluster ?? 'boe';
    if (!isValidRiffSandboxCluster(sandboxCluster)) {
      return jsonRes(res, 400, { ok: false, error: 'invalid_sandbox_cluster' });
    }
    value = { ...preserved, ...value, sandboxCluster };
    if (!isValidRiffBaseUrl(value.baseUrl)) {
      return jsonRes(res, 400, { ok: false, error: 'invalid_base_url' });
    }
  }
  const r = await applyConfigField(cachedLarkAppId, spec, value);
  if (!r.ok) return jsonRes(res, 400, { ok: false, error: r.reason });
  jsonRes(res, 200, { ok: true, riff: value ? JSON.stringify(redactRiffForClient(value), null, 2) : '' });
});

// Per-bot 最大同时活跃会话数 maxLiveWorkers。Body `{ maxLiveWorkers: number | null }`:
//   • 正整数  → 设上限；超过后 idle-worker sweeper 把最久未用的会话休眠到上限内
//   • null    → 清除（回落到内置默认 30）
// 走 applyConfigField（与 /config 同一写盘 + 内存热更新路径）：sweeper 每分钟读
// 实时 bot.config.maxLiveWorkers，免重启即生效。
ipcRoute('PUT', '/api/bot-max-live-workers', async (req, res) => {
  if (!cachedLarkAppId) return jsonRes(res, 503, { error: 'larkAppId_not_set' });
  let raw: unknown;
  try { raw = await readJsonBody(req); }
  catch { return jsonRes(res, 400, { ok: false, error: 'bad_json' }); }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return jsonRes(res, 400, { ok: false, error: 'no_valid_fields' });
  }
  const body = raw as { maxLiveWorkers?: unknown };
  const spec = findConfigField('maxLiveWorkers');
  if (!spec) return jsonRes(res, 500, { ok: false, error: 'spec_missing' });

  // null（含 JSON null）= 清除上限；number 走 coerce 校验正整数。
  let value: number | null;
  if (body.maxLiveWorkers === null || body.maxLiveWorkers === undefined) {
    value = null;
  } else {
    const c = coerceConfigValue(spec, body.maxLiveWorkers);
    if (!c.ok || typeof c.value !== 'number') return jsonRes(res, 400, { ok: false, error: 'invalid_number' });
    value = c.value;
  }
  const r = await applyConfigField(cachedLarkAppId, spec, value);
  if (!r.ok) return jsonRes(res, 400, { ok: false, error: r.reason });
  jsonRes(res, 200, { ok: true, maxLiveWorkers: value });
});

ipcRoute('PUT', '/api/bot-session-owner-reminder', async (req, res) => {
  if (!cachedLarkAppId) return jsonRes(res, 503, { error: 'larkAppId_not_set' });
  let raw: unknown;
  try { raw = await readJsonBody(req); }
  catch { return jsonRes(res, 400, { ok: false, error: 'bad_json' }); }
  const result = await updateSessionOwnerReminderConfig(cachedLarkAppId, raw);
  if (!result.ok) return jsonRes(res, 400, { ok: false, error: result.reason });
  return jsonRes(res, 200, { ok: true, sessionOwnerReminder: result.config });
});

// Per-bot skill policy. Dashboard uses this for attach/detach; JSON policy
// still shares the same applyConfigField path as /botconfig.
ipcRoute('PUT', '/api/bot-skills', async (req, res) => {
  if (!cachedLarkAppId) return jsonRes(res, 503, { error: 'larkAppId_not_set' });
  let raw: unknown;
  try { raw = await readJsonBody(req); }
  catch { return jsonRes(res, 400, { ok: false, error: 'bad_json' }); }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return jsonRes(res, 400, { ok: false, error: 'bad_json' });
  }
  const body = raw as { action?: unknown; name?: unknown; policy?: unknown };
  const spec = findConfigField('skills');
  if (!spec) return jsonRes(res, 500, { ok: false, error: 'spec_missing' });

  const current = getBot(cachedLarkAppId).config.skills;
  let next = current;
  if (body.action === 'attach') {
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) return jsonRes(res, 400, { ok: false, error: 'name_required' });
    if (!readSkillRegistry().skills[name]) return jsonRes(res, 400, { ok: false, error: 'skill_not_installed' });
    next = attachSkillPolicy(current, name);
  } else if (body.action === 'detach') {
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) return jsonRes(res, 400, { ok: false, error: 'name_required' });
    next = detachSkillPolicy(current, name);
  } else if (body.action === 'set') {
    if (body.policy === null) {
      next = undefined;
    } else {
      const parsed = readBotSkillPolicy(body.policy);
      if (!parsed) return jsonRes(res, 400, { ok: false, error: 'invalid_policy' });
      next = parsed;
    }
  } else {
    return jsonRes(res, 400, { ok: false, error: 'invalid_action' });
  }

  const r = await applyConfigField(cachedLarkAppId, spec, next ?? null);
  if (!r.ok) return jsonRes(res, 400, { ok: false, error: r.reason });
  jsonRes(res, 200, { ok: true, skills: getBot(cachedLarkAppId).config.skills ?? null });
});

// Per-bot file-sandbox toggle. Body `{ enabled: boolean }`. When on, this bot's
// CLI sessions run inside a per-session bwrap file sandbox (Linux). For oncall
// bots shared with semi-trusted users.
ipcRoute('PUT', '/api/bot-sandbox', async (req, res) => {
  if (!cachedLarkAppId) return jsonRes(res, 503, { error: 'larkAppId_not_set' });
  let body: { enabled?: unknown };
  try { body = await readJsonBody<{ enabled?: unknown }>(req); }
  catch { return jsonRes(res, 400, { ok: false, error: 'bad_json' }); }
  // File-sandbox policy is frozen onto each Session at creation and reused on
  // restore; this toggle is intentionally next-session-only and cannot mutate
  // a live pane's profile.
  const r = await sandboxStore.updateBotSandbox(cachedLarkAppId, body.enabled === true);
  if (!r.ok) return jsonRes(res, 400, { ok: false, error: r.reason });
  jsonRes(res, 200, { ok: true, sandbox: r.sandbox });
});

// Per-bot sandboxPaths (three-tier whitelist: readWrite / readOnly / deny).
// Body `{ readWrite?: string[]; readOnly?: string[]; deny?: string[] }`. Highest-
// precedence layer of the FsPolicy — an empty/absent tier falls back to the
// deny-by-default baseline. Passing all-empty CLEARS the field. next-session
// 生效：running sessions keep their spawn-time policy, only new spawns re-read it.
ipcRoute('PUT', '/api/bot-sandbox-paths', async (req, res) => {
  if (!cachedLarkAppId) return jsonRes(res, 503, { error: 'larkAppId_not_set' });
  let body: { readWrite?: unknown; readOnly?: unknown; deny?: unknown };
  try { body = await readJsonBody(req); }
  catch { return jsonRes(res, 400, { ok: false, error: 'bad_json' }); }
  const asList = (v: unknown): string[] | undefined =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : undefined;
  const r = await sandboxStore.updateBotSandboxPaths(cachedLarkAppId, {
    readWrite: asList(body.readWrite),
    readOnly: asList(body.readOnly),
    deny: asList(body.deny),
  });
  if (!r.ok) return jsonRes(res, 400, { ok: false, error: r.reason });
  jsonRes(res, 200, { ok: true, sandboxPaths: r.sandboxPaths ?? null });
});

// Per-bot read-isolation toggle. Body `{ enabled: boolean }`. When on, this bot's
// CLI sessions run under macOS Seatbelt read-deny (siblings' creds/sessions/content
// unreadable). The macOS counterpart of the file sandbox above.
ipcRoute('PUT', '/api/bot-read-isolation', async (req, res) => {
  if (!cachedLarkAppId) return jsonRes(res, 503, { error: 'larkAppId_not_set' });
  const larkAppId = cachedLarkAppId;
  let body: { enabled?: unknown };
  try { body = await readJsonBody<{ enabled?: unknown }>(req); }
  catch { return jsonRes(res, 400, { ok: false, error: 'bad_json' }); }
  const enable = body.enabled === true;
  return withBotTurnMutation(larkAppId, async () => {
    // An idempotent request changes neither the durable policy nor any pane.
    // Return before pending/active/teardown guards so a dashboard refresh that
    // repeats the authoritative value cannot be rejected merely because the
    // bot is doing work.
    if (sandboxStore.getBotReadIsolation(larkAppId) === enable) {
      return jsonRes(res, 200, {
        ok: true,
        readIsolation: enable,
        suspendedSessions: 0,
        changed: false,
      });
    }
    // Close admission first and drain handlers that may already be awaiting
    // downloads/noteTurnReceived. Ledger preflight alone cannot see those
    // pre-accept turns; draining prevents a post-sweep send into a killed ds.
    const activeBotSessions = listActiveSessions().filter(ds => ds.larkAppId === larkAppId);
    // Registry state alone is insufficient: partial restore, an anchor
    // collision, or a failed staggered reattach can omit a durable active row
    // while its persistent pane still survives. Consult the same persisted
    // session source a restart will hydrate. Legacy unscoped active rows are
    // conservatively treated as this daemon's until explicitly closed.
    const persistedBotSessions = sessionStore.listSessions().filter(session =>
      session.larkAppId === larkAppId || !session.larkAppId,
    );
    const persistedActiveBotSessions = persistedBotSessions.filter(session =>
      session.status === 'active',
    );
    if (rejectProtectedSessionMutation(res, [
      ...activeBotSessions,
      ...persistedActiveBotSessions,
    ])) return;
    // Crash-transactional safety boundary: bots.json is the restart source of
    // truth, while a live tmux/herdr/zellij pane retains its old in-memory
    // Seatbelt profile. Persisting the new flag before tearing those panes down
    // creates an unrecoverable crash window because the restart path cannot
    // prove which exact read/write isolation profile a surviving pane runs.
    // Require explicit close first; with no active logical session there is no
    // owned pane a restart can reattach under the newly persisted policy.
    if (activeBotSessions.length > 0 || persistedActiveBotSessions.length > 0) {
      return jsonRes(res, 409, {
        ok: false,
        error: 'read_isolation_active_sessions',
      });
    }
    // `/close` intentionally returns after sending worker close IPC and marking
    // the row closed; persistent-pane destruction can lag. A closed row's pid
    // is deliberately not probed: PID alone has no birth identity and may have
    // been reused by an unrelated process. closeSession clears it atomically.
    // For current rows, the stamped persistent backend is the teardown proof.
    // Pre-stamp closed rows are not synchronously probed across three CLIs here:
    // that legacy shell fan-out blocks the daemon event loop, while any active
    // legacy row has already failed the active-session guard above.
    for (const session of persistedBotSessions) {
      if (session.adoptedFrom || session.title?.startsWith('Adopt:')) continue;
      const backendTypes: persistentBackend.PersistentBackendType[] =
        persistentBackend.isSuspendableBackendType(session.backendType)
          ? [session.backendType]
          : [];
      for (const backendType of backendTypes) {
        const backingName = persistentBackend.persistentSessionName(
          backendType,
          session.sessionId,
        );
        if (persistentBackend.probePersistentSession(backendType, backingName) !== 'missing') {
          return jsonRes(res, 409, {
            ok: false,
            error: 'read_isolation_teardown_unverified',
          });
        }
      }
    }
    // The worker FAIL-CLOSES (refuses to start the session) for a configured
    // readIsolation that cannot be enforced. Check this after the active-session
    // safety boundary so even an unsupported enable cannot obscure a surviving
    // old-policy pane with a less important validation error.
    if (enable && !readIsolationEnforceable(larkAppId)) {
      return jsonRes(res, 400, { ok: false, error: 'read_isolation_unenforceable' });
    }
    // With the gate closed and no active logical session, persistence is the
    // only mutation. updateBotReadIsolation writes bots.json atomically and
    // then publishes the same value to the daemon runtime before resolving.
    // A crash at any point can only lead to a cold spawn under the old or new
    // durable policy; there is no owned pane to reattach.
    const r = await sandboxStore.updateBotReadIsolation(larkAppId, enable);
    if (!r.ok) return jsonRes(res, 400, { ok: false, error: r.reason });
    jsonRes(res, 200, {
      ok: true,
      readIsolation: r.readIsolation,
      suspendedSessions: 0,
      changed: true,
    });
  });
});

// Per-bot session backend override (pty | tmux | herdr | zellij | zmx), or clear it
// ('' / 'auto' / null → follow the daemon default). next-session 生效：running
// sessions keep their spawn-time backend (Session.backendType stamp), only new
// spawns read the new value — so switching here can't strand live sessions.
ipcRoute('PUT', '/api/bot-backend-type', async (req, res) => {
  if (!cachedLarkAppId) return jsonRes(res, 503, { error: 'larkAppId_not_set' });
  let body: { backendType?: unknown };
  try { body = await readJsonBody<{ backendType?: unknown }>(req); }
  catch { return jsonRes(res, 400, { ok: false, error: 'bad_json' }); }
  const raw = body.backendType;
  let next: BackendType | null;
  if (raw == null || raw === '' || raw === 'auto') next = null;
  else if (backendTypeStore.isEditableBackendType(raw)) next = raw;
  else return jsonRes(res, 400, { ok: false, error: 'invalid_backendType' });
  const effectiveBackendType = next ?? config.daemon.backendType;
  const availability = await ensureBackendAvailable(effectiveBackendType);
  if (!availability.ok) {
    return jsonRes(res, 409, {
      ok: false,
      error: 'backend_unavailable',
      backendType: effectiveBackendType,
      reason: availability.reason,
      manualCommand: availability.manualCommand,
    });
  }
  const r = await backendTypeStore.updateBotBackendType(cachedLarkAppId, next);
  if (!r.ok) return jsonRes(res, 400, { ok: false, error: r.reason });
  jsonRes(res, 200, { ok: true, backendType: r.backendType, effectiveBackendType, version: availability.version });
});

// 实时切换 UI 语言（locale），无需重启 daemon。`botmux lang` / Dashboard 语言开关
// 写盘后 POST 这个端点，让本 daemon 从磁盘重新读 locale 并热更新：
//   • 全局默认（~/.botmux/config.json 的 `lang`）→ setDefaultLocale（缺省回落 'zh'）；
//   • 本 bot 的 per-bot 覆盖（bots.json 的 `lang`）→ 同步进内存 bot.config.lang
//     （与 applyConfigField 同口径），让 `botmux lang --bot N` 跨进程写入也免重启。
// 卡片都在 daemon 端按消息实时渲染（localeForBot），所以下一条消息/卡片立即生效。
// 文件是单一事实源，本端点只是“立即重读”信号——不在此落盘（写入方已落盘）。
ipcRoute('POST', '/api/locale/reload', async (_req, res) => {
  const globalLang = readGlobalConfig().lang;
  const resolvedDefault: Locale = isLocale(globalLang) ? globalLang : 'zh';
  setDefaultLocale(resolvedDefault);

  let botLang: Locale | null = null;
  if (cachedLarkAppId) {
    try {
      const raw = await readRawConfig(requireConfigPath());
      const idx = findEntryIndex(raw, cachedLarkAppId);
      const entryLang = idx >= 0 ? raw[idx]?.lang : undefined;
      botLang = isLocale(entryLang) ? entryLang : null;
      getBot(cachedLarkAppId).config.lang = botLang ?? undefined;
    } catch { /* bot 未注册 / 读盘失败：全局已应用，per-bot 维持原值 */ }
  }

  // Push the resolved locale to this bot's live workers too. Cards render on the
  // daemon (already switched above), but a few user-facing strings originate in
  // the worker process (submit notices, CoCo adopt notes) — without this they'd
  // stay in the spawn-time language until the session restarts.
  const workerLocale: Locale = botLang ?? resolvedDefault;
  const reg = getActiveSessionsRegistry();
  if (cachedLarkAppId && reg) {
    for (const ds of reg.values()) {
      if (ds.larkAppId !== cachedLarkAppId || !ds.worker || ds.worker.killed) continue;
      try { ds.worker.send({ type: 'set_locale', locale: workerLocale }); } catch { /* worker gone */ }
    }
  }

  jsonRes(res, 200, { ok: true, defaultLocale: resolvedDefault, botLang });
});

// Hot-reload the current daemon's per-bot config from bots.json after another
// process edits the shared config file. Keep the live Lark client / resolved
// allowlist intact; VC listener routing only needs the vcMeetingAgent block.
ipcRoute('POST', '/api/bot-config/reload', async (_req, res) => {
  if (!cachedLarkAppId) return jsonRes(res, 503, { ok: false, error: 'larkAppId_not_set' });
  try {
    const latest = loadBotConfigs().find(bot => bot.larkAppId === cachedLarkAppId);
    if (!latest) return jsonRes(res, 404, { ok: false, error: 'bot_not_in_config' });
    getBot(cachedLarkAppId).config.vcMeetingAgent = latest.vcMeetingAgent;
    jsonRes(res, 200, { ok: true, larkAppId: cachedLarkAppId, vcMeetingAgentEnabled: latest.vcMeetingAgent?.enabled === true });
  } catch (err: any) {
    jsonRes(res, 500, { ok: false, error: err?.message ?? String(err) });
  }
});

ipcRoute('PUT', '/api/bot-default-oncall', async (req, res) => {
  if (!cachedLarkAppId) return jsonRes(res, 503, { error: 'larkAppId_not_set' });
  let body: { enabled?: unknown; workingDir?: unknown };
  try { body = await readJsonBody<{ enabled?: boolean; workingDir?: string }>(req); }
  catch { return jsonRes(res, 400, { ok: false, error: 'bad_json' }); }

  const enabled = body.enabled === true;
  const workingDir = typeof body.workingDir === 'string' ? body.workingDir.trim() : '';

  // Validate workingDir when enabling. Allow blank workingDir only when
  // disabling — the on-disk record keeps the last value so the UI can
  // round-trip after a disable.
  let resolvedPath = '';
  if (enabled) {
    if (!workingDir) return jsonRes(res, 400, { ok: false, error: 'workingDir_required' });
    const v = validateWorkingDir(workingDir);
    if (!v.ok) return jsonRes(res, 400, { ok: false, error: v.error });
    resolvedPath = v.resolvedPath;
  }

  const r = await oncallStore.updateBotDefaultOncall(cachedLarkAppId, { enabled, workingDir });
  if (!r.ok) return jsonRes(res, 400, r);
  jsonRes(res, 200, { ok: true, defaultOncall: r.defaultOncall, resolvedPath: resolvedPath || undefined });
});

// Per-bot「默认工作目录模式」三选一（dashboard 单选；两个底层字段互斥）：
//   • off     → 清 defaultWorkingDir + 关 defaultOncall（新会话弹「选仓库」卡）
//   • default → 写 defaultWorkingDir + 关 defaultOncall（钉目录、跳过选仓库、不改权限）
//   • oncall  → 开 defaultOncall(+dir) + 清 defaultWorkingDir（新群自动绑+开放对话；
//               该目录经 resolveBotDefaultWorkingDir 的 layer-4 兜底覆盖该 bot 所有会话）
// 两字段在 oncallStore.setWorkingDirMode 的**同一个 rmwBotEntry 锁内**一次性原子写盘 +
// 同步内存：否则两个并发请求分别加锁写各自字段会交错，最终留下 defaultOncall.enabled 与
// defaultWorkingDir 同时存在的不一致态（GET/前端按 enabled 显示 oncall，但 runtime 的
// effectiveDefaultWorkingDir 优先用 defaultWorkingDir → UI 与实际目录背离；PR #311 Codex 评审）。
// next-session 生效（运行中会话需 /restart）。
ipcRoute('PUT', '/api/bot-working-dir-mode', async (req, res) => {
  if (!cachedLarkAppId) return jsonRes(res, 503, { error: 'larkAppId_not_set' });
  let body: { mode?: unknown; workingDir?: unknown; autoWorktree?: unknown };
  try { body = await readJsonBody<{ mode?: unknown; workingDir?: unknown; autoWorktree?: unknown }>(req); }
  catch { return jsonRes(res, 400, { ok: false, error: 'bad_json' }); }

  const mode = body.mode;
  if (mode !== 'off' && mode !== 'default' && mode !== 'oncall') {
    return jsonRes(res, 400, { ok: false, error: 'invalid_mode' });
  }
  const workingDir = typeof body.workingDir === 'string' ? body.workingDir.trim() : '';
  // 「仅默认目录」模式下的「自动创建 worktree」开关；其余模式 setWorkingDirMode 会强制清掉。
  const autoWorktree = body.autoWorktree === true;

  // 非「关闭」模式必须给一个真实存在的目录。
  let resolvedPath = '';
  if (mode !== 'off') {
    if (!workingDir) return jsonRes(res, 400, { ok: false, error: 'workingDir_required' });
    const v = validateWorkingDir(workingDir);
    if (!v.ok) return jsonRes(res, 400, { ok: false, error: v.error });
    resolvedPath = v.resolvedPath;
  }

  const r = await oncallStore.setWorkingDirMode(cachedLarkAppId, mode, workingDir, autoWorktree);
  if (!r.ok) return jsonRes(res, 400, r);
  return jsonRes(res, 200, {
    ok: true, mode,
    defaultWorkingDir: r.defaultWorkingDir,
    defaultWorkingDirAutoWorktree: r.defaultWorkingDirAutoWorktree,
    defaultOncall: r.defaultOncall,
    resolvedPath: resolvedPath || undefined,
  });
});

// Create a brand-new chat with this bot as creator/owner and `larkAppIds` as
// initial bot members. The dashboard's public route picks any online daemon
// to act as creator, then forwards here.
ipcRoute('POST', '/api/groups/create', async (req, res) => {
  if (!cachedLarkAppId) return jsonRes(res, 503, { error: 'larkAppId_not_set' });
  let body: {
    name?: unknown;
    larkAppIds?: unknown;
    userOpenIds?: unknown;
    ownerUnionIds?: unknown;
    transferOwnerUnionId?: unknown;
    transferOwnerTo?: unknown;
    notifyOwnerOpenId?: unknown;
    bindWorkingDir?: unknown;
    roleProfileId?: unknown;
  };
  try {
    body = await readJsonBody<{
      name?: string;
      larkAppIds?: string[];
      userOpenIds?: string[];
      ownerUnionIds?: string[];
      transferOwnerUnionId?: string;
      transferOwnerTo?: string;
      notifyOwnerOpenId?: string;
      bindWorkingDir?: string;
      roleProfileId?: string;
    }>(req);
  } catch {
    return jsonRes(res, 400, { error: 'bad_json' });
  }
  const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim() : undefined;
  if (!Array.isArray(body.larkAppIds) || !body.larkAppIds.every(x => typeof x === 'string')) {
    return jsonRes(res, 400, { error: 'larkAppIds_required' });
  }
  // userOpenIds, transferOwnerTo, notifyOwnerOpenId are optional; pre-validated
  // upstream by the dashboard route. All open_ids MUST be in the calling bot's
  // app scope (caller is responsible — Lark open_ids are app-scoped, see
  // dashboard/operator-selector.ts).
  const userIds = Array.isArray(body.userOpenIds) && body.userOpenIds.every(x => typeof x === 'string')
    ? (body.userOpenIds as string[])
    : [];
  // Owner union_ids (tenant-stable) to pull bot owners into a federated group.
  const ownerUnionIds = Array.isArray(body.ownerUnionIds) && body.ownerUnionIds.every(x => typeof x === 'string')
    ? (body.ownerUnionIds as string[])
    : [];
  const transferOwnerUnionId = typeof body.transferOwnerUnionId === 'string' && body.transferOwnerUnionId.trim()
    ? body.transferOwnerUnionId.trim()
    : null;
  if (body.transferOwnerUnionId !== undefined
    && (!transferOwnerUnionId || !transferOwnerUnionId.startsWith('on_') || !ownerUnionIds.includes(transferOwnerUnionId))) {
    return jsonRes(res, 400, { ok: false, error: 'invalid_transfer_owner_union_id' });
  }
  const transferTo = typeof body.transferOwnerTo === 'string' && body.transferOwnerTo.trim()
    ? body.transferOwnerTo.trim()
    : null;
  const notifyTo = typeof body.notifyOwnerOpenId === 'string' && body.notifyOwnerOpenId.trim()
    ? body.notifyOwnerOpenId.trim()
    : null;
  const roleProfileId = typeof body.roleProfileId === 'string' && body.roleProfileId.trim()
    ? body.roleProfileId.trim()
    : null;
  if (roleProfileId && !isValidRoleProfileId(roleProfileId)) {
    return jsonRes(res, 400, { ok: false, error: 'invalid_role_profile_id' });
  }
  const bindWorkingDir = typeof body.bindWorkingDir === 'string' ? body.bindWorkingDir.trim() : '';
  let bindResolvedPath: string | undefined;
  if (bindWorkingDir) {
    const v = validateWorkingDir(bindWorkingDir);
    if (!v.ok) return jsonRes(res, 400, { ok: false, error: v.error });
    bindResolvedPath = v.resolvedPath;
  }
  try {
    const r = await createGroupWithBots({
      creatorLarkAppId: cachedLarkAppId,
      larkAppIds: body.larkAppIds as string[],
      name,
      userOpenIds: userIds,
      ownerUnionIds,
      transferOwnerUnionId: transferOwnerUnionId ?? undefined,
      transferOwnerTo: transferTo ?? undefined,
      notifyOwnerOpenId: notifyTo ?? undefined,
      bindWorkingDir: bindWorkingDir || undefined,
      roleProfileId: roleProfileId ?? undefined,
    });
    jsonRes(res, 200, bindResolvedPath ? { ...r, bindResolvedPath } : r);
  } catch (e) {
    jsonRes(res, 502, { ok: false, error: String((e as Error).message ?? e) });
  }
});

// Complete a deferred team-group owner transfer after another deployment has
// added the operator to the chat. The caller sends union_id so no app-scoped
// open_id crosses the dashboard/daemon or federation boundary.
ipcRoute('POST', '/api/groups/transfer-owner', async (req, res) => {
  if (!cachedLarkAppId) return jsonRes(res, 503, { error: 'larkAppId_not_set' });
  let body: { chatId?: unknown; ownerUnionId?: unknown };
  try {
    body = await readJsonBody<{ chatId?: string; ownerUnionId?: string }>(req);
  } catch {
    return jsonRes(res, 400, { ok: false, error: 'bad_json' });
  }
  const chatId = typeof body.chatId === 'string' ? body.chatId.trim() : '';
  const ownerUnionId = typeof body.ownerUnionId === 'string' ? body.ownerUnionId.trim() : '';
  if (!chatId.startsWith('oc_') || !ownerUnionId.startsWith('on_')) {
    return jsonRes(res, 400, { ok: false, error: 'invalid_owner_transfer' });
  }

  const transferred = await transferGroupOwner({
    creatorLarkAppId: cachedLarkAppId,
    chatId,
    ownerId: ownerUnionId,
    ownerIdType: 'union_id',
  });
  let notifyMessageId: string | null = null;
  let notifyError: string | null = null;
  if (transferred.ownerTransferredTo) {
    try {
      // Feishu accepts union_id in an @ tag; keeping it stable avoids a second
      // app-scope lookup after the owner was added by another deployment.
      notifyMessageId = await sendMessage(
        cachedLarkAppId,
        chatId,
        `<at user_id="${ownerUnionId}"></at>`,
        'text',
      );
    } catch (e: any) {
      notifyError = e?.message ?? String(e);
    }
  }
  return jsonRes(res, 200, {
    ok: true,
    ...transferred,
    notifyMessageId,
    notifyError,
  });
});

// ─── SSE event stream ──────────────────────────────────────────────────────

ipcRoute('GET', '/api/events', (_req, res) => {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache, no-transform',
    'connection': 'keep-alive',
  });
  // Initial flush so the client sees the connection alive immediately.
  res.write('retry: 5000\n\n');

  // Subscribe BEFORE snapshotting so no event published in the gap is missed.
  const off = dashboardEventBus.subscribe(ev => {
    res.write(`event: ${ev.type}\ndata: ${JSON.stringify(ev.body)}\n\n`);
  });

  // Replay the current active sessions as `session.spawned` right after
  // subscribing. `DashboardEventBus` has no buffer/replay, and the daemon
  // publishes its discovery descriptor BEFORE restoreActiveSessions() runs
  // (daemon.ts) — so a dashboard that hydrates (GET /api/sessions) during the
  // descriptor→restore window gets an EMPTY snapshot, and any restore-time
  // `announceSessionRow()` that fires before THIS subscription is established is
  // dropped. Without this replay the aggregator would then have neither a
  // snapshot row nor a spawned row, and later session.update/close patches would
  // be discarded as unknown-row. Replaying here makes SSE attach deterministic:
  // a row registered before subscribe arrives via this snapshot; one registered
  // after arrives via the live subscription above. Idempotent — both the
  // aggregator and the browser store upsert by sessionId, so any row also
  // delivered live just refreshes the same entry.
  try {
    const activeIds = new Set<string>();
    for (const ds of listActiveSessions()) {
      activeIds.add(ds.session.sessionId);
      res.write(`event: session.spawned\ndata: ${JSON.stringify({ session: composeRowFromActive(ds) })}\n\n`);
    }
    // Persisted active rows may be intentionally absent from the runtime Map
    // after an inconclusive exact-backend teardown. Replay them as dormant
    // upserts so SSE reconnects retain the same truthful state as GET
    // /api/sessions and never synthesize a closed row.
    for (const s of sessionStore.listSessions()) {
      if (s.status !== 'active' || activeIds.has(s.sessionId)) continue;
      res.write(`event: session.spawned\ndata: ${JSON.stringify({ session: composeRowFromPersistedActive(s) })}\n\n`);
    }
    // Also replay sessions CLOSED during this run as `session.spawned` carrying a
    // closed row. The active-only replay above can't cover a restore-time zombie:
    // restoreActiveSessions registers it, announces it, then immediately probes it
    // 'missing' and closeSession()s it (evicting it from the active Map) — all
    // before a racing dashboard's SSE subscription exists. By connect time it is
    // neither in the active Map nor was it a closed row at the dashboard's early
    // (pre-restore) hydrate, so without this it stays invisible (or, if the
    // dashboard cached it active from before the restart, lingers as a stale
    // active row — hydrateSessions only upserts, never deletes absent rows).
    // Bounded to closedAt >= PROCESS_START_MS so we replay only this run's
    // closures (the full closed history is already served by GET /api/sessions
    // on hydrate). `session.spawned` (not session.update) because the row may be
    // unknown to the client — both consumers upsert by sessionId, and the closed
    // row's status:'closed' overwrites any stale active entry.
    for (const s of sessionStore.listSessions()) {
      if (s.status !== 'closed' || activeIds.has(s.sessionId)) continue;
      const closedMs = s.closedAt ? Date.parse(s.closedAt) : NaN;
      if (!Number.isFinite(closedMs) || closedMs < PROCESS_START_MS) continue;
      res.write(`event: session.spawned\ndata: ${JSON.stringify({ session: composeRowFromClosed(s) })}\n\n`);
    }
  } catch (err) {
    logger.warn(`[dashboard-ipc] /api/events snapshot replay failed: ${err}`);
  }

  const hb = setInterval(() => {
    res.write(`event: heartbeat\ndata: ${JSON.stringify({ ts: Date.now() })}\n\n`);
  }, 15_000);

  res.on('close', () => { off(); clearInterval(hb); });
});

export function startIpcServer(opts: {
  port: number;
  host: string;
  /** Enable the production trusted-host boundary. The verifier reloads the
   * tiny secret file for each request so concurrent fleet bootstrap or a
   * deliberate secret repair cannot strand a daemon on a stale cached key.
   * Tests that omit this option retain the lightweight in-process server. */
  authRequired?: boolean;
  /** Daemon restore barrier.  The socket/health route may come up early so its
   * descriptor is discoverable, but every state-bearing route waits until all
   * durable session owners have been registered. */
  ready?: Promise<void>;
  /** Upward-probe span on EADDRINUSE. Default DEFAULT_PROBE_SPAN (fleet daemons
   * step to the next free port so a port race can't crash boot). Core-only
   * (single in-sandbox service) sets 0 to BIND-OR-FAIL on the exact requested
   * port — riff's task-runner is told a fixed port and must not have the service
   * silently drift to another one. */
  maxProbe?: number;
  /** Core-only: additionally treat the tight riff-facing route allowlist
   * (routeIsCoreOnlyPublic) as public (no HMAC). Every OTHER route still requires
   * the trusted-host HMAC — this does NOT disable auth wholesale (codex P1). */
  coreOnlyPublicRoutes?: boolean;
}): Promise<IpcServerHandle> {
  let boundPort = opts.port;
  const server: Server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      const method = req.method ?? 'GET';
      const coreOnlyPublic = opts.coreOnlyPublicRoutes === true && routeIsCoreOnlyPublic(method, url.pathname);
      const publicRoute = routeHasPublicAccess(method, url.pathname) || coreOnlyPublic;
      // Readiness barrier (codex P1): the core-only public control routes
      // (trigger / trigger-result / insight) must NOT enter their handlers until
      // restore completes — a trigger during 'starting' races durable restore.
      // Gate them at the server level so it doesn't depend on the caller probing
      // /healthz first. /healthz itself reports 503 via its own handler.
      if (coreOnlyPublic && coreOnlyNotReady()) {
        return jsonRes(res, 503, { ok: false, status: 'starting', error: 'core-only service is still restoring; retry after /healthz returns 200' });
      }
      const capabilityRoute = routeHasNarrowUntrustedAuth(method, url.pathname);
      if (opts.authRequired && !publicRoute) {
        const secret = ipcAuthSecret();
        const auth = secret
          ? trustedHostAuthorized(req, url.pathname, boundPort, secret)
          : { ok: false as const, reason: 'secret_unavailable' };
        if (auth.ok) {
          trustedHostRequests.add(req);
        } else if (!capabilityRoute) {
          return jsonRes(res, 401, { ok: false, error: 'unauthorized', reason: auth.reason });
        }
      }
      if (!publicRoute && opts.ready) await opts.ready;
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const m = r.pattern.exec(url.pathname);
        if (!m) continue;
        const params: Record<string, string> = {};
        r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
        await r.handler(req, res, params);
        return;
      }
      jsonRes(res, 404, { error: 'not_found', path: url.pathname });
    } catch (err) {
      logger.error('[dashboard-ipc] handler error', err);
      if (!res.headersSent) jsonRes(res, 500, { error: String(err) });
    }
  });
  // Probe upward on EADDRINUSE instead of a single fixed bind: a second botmux
  // instance resolving the same IPC port (BOTMUX_DAEMON_IPC_BASE_PORT + idx)
  // would otherwise reject and take the whole daemon down at startup (the caller
  // in daemon.ts awaits this unguarded). The daemon republishes the returned
  // (bound) port into its descriptor so the dashboard still discovers it.
  return listenWithProbe({
    server,
    port: opts.port,
    host: opts.host,
    maxProbe: opts.maxProbe,
    log: (m) => logger.warn(`[dashboard-ipc] ${m}`),
  }).then((port) => {
    boundPort = port;
    return {
    port,
    close: () => new Promise<void>(r => server.close(() => r())),
  };
  });
}
