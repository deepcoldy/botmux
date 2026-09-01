// src/dashboard.ts
import { createServer, get as httpGet, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import type { Duplex } from 'node:stream';
import {
  readFileSync, existsSync, mkdirSync, readdirSync, statSync, createReadStream, realpathSync,
} from 'node:fs';
import { atomicWriteFileSync } from './utils/atomic-write.js';
import { join, dirname, extname, resolve, relative, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHmac, randomBytes } from 'node:crypto';
import { logger } from './utils/logger.js';
import { isStandaloneBinary } from './core/self-spawn.js';
import { currentUpdateStrategy, replaceStandaloneBinary } from './core/binary-self-update.js';
import { gracefulProcessExitCode } from './pm2-graceful-exit.js';
import { config, isWildcardBindHost } from './config.js';
import { listenWithProbe } from './utils/listen-with-probe.js';
import {
  parseCookie, buildSetCookie, verifyHmac, cliAuthBind,
  projectWorkbenchOperationCapabilities, previewInteractionWriteAllowed,
  loadPersistedToken, loadOrCreatePersistedToken, rotatePersistedToken,
  loadDashboardSecret, loadOrCreateDashboardSecret, describeDashboardTokenError,
} from './dashboard/auth.js';
import {
  resolveDashboardIdentity,
  resolveDashboardRequestGate,
  type DashboardRequestIdentity,
} from './dashboard/request-identity.js';
import { AuthSessionConnectionRegistry } from './dashboard/auth-session-connections.js';
import { createDashboardEventsStream, type DashboardEventAudience } from './dashboard/events-sse.js';
import {
  ControlCsrfTokens,
  classifyManagementUpgrade,
  guardControlRequest,
  injectControlCsrfMeta,
  managementUpgradeOrigin,
} from './dashboard/control-csrf.js';
import { DaemonRegistry, botsRosterSignature } from './dashboard/registry.js';
import { Aggregator, subscribeDaemon } from './dashboard/aggregator.js';
import { reconcileDaemonSnapshot } from './dashboard/daemon-reconcile.js';
import { createSessionPresentationCoordinator } from './dashboard/session-presentation.js';
import {
  compactGroupsMatrix,
  groupsNamesMatrix,
  createGroupsMatrixSnapshot,
  enrichSessionsWithGroupNames,
  roleWriteShouldInvalidate,
  type GroupsMatrix,
} from './dashboard/groups-matrix-snapshot.js';
import {
  parseDashboardAskAnswerRequest,
  proxyDashboardAskAnswer,
} from './dashboard/desktop-asks.js';
import { createDebugTerminalManager } from './dashboard/debug-terminal.js';
import { createSessionPreviewProxy, type PreviewProxyResolution } from './dashboard/preview-proxy.js';
import {
  mintPreviewContentCapability,
  verifyPreviewContentCapability,
} from './dashboard/preview-content-capability.js';
import {
  previewDescriptorFromRow,
  previewTeardownForDaemonEvent,
  projectSessionDetailForBrowser,
  projectSessionPreviewEventForBrowser,
  projectSessionPreviewsForBrowser,
  resolveSessionPreviewForProxy,
} from './dashboard/preview-contract.js';
import {
  sameSessionPreviewTarget,
  sessionPreviewTargetStillOwned,
  type SessionPreviewTarget,
} from './core/session-preview.js';
import { pickCreatorForGroup } from './dashboard/operator-selector.js';
import { buildTeamGroupCreatePayload, planGroupCreator } from './dashboard/team-group.js';
import { jsonRes } from './dashboard/http.js';
import { handleCustomizationApi } from './dashboard/customization-api.js';
import { handleV3RunsApi } from './dashboard/v3-runs-api.js';
import { defaultRunsDir as v3RunsDir } from './workflows/v3/ops-projection.js';
import {
  verifyWorkflowDaemonIpcResponse,
  workflowDaemonIpcHeaders,
  WORKFLOW_DAEMON_IPC_ROUTE_PREFIX,
  type WorkflowDaemonIpcTarget,
} from './workflows/v3/daemon-ipc-auth.js';
import { handleDashboardTriggerApi } from './dashboard/trigger-api.js';
import { REPLY_STYLE_REQUEST_MAX_BYTES } from './dashboard/reply-style.js';
import { handleConnectorApi } from './dashboard/connector-api.js';
import {
  projectSessionEventForAudience,
  projectSessionsForAudience,
  redactGroupsForPublic,
  redactSchedulesForPublic,
  redactSettingsForPublic,
  sessionBoardAudienceFor,
} from './dashboard/public-redact.js';
import { handleWebhookRoute } from './dashboard/webhook-routes.js';
import { handleFeedbackAnalyticsApi } from './dashboard/feedback-analytics-api.js';
import { FeedbackAnalyticsService } from './services/feedback-analytics.js';
import { handleFederationApi } from './dashboard/federation-api.js';
import { buildFederatedRoster } from './services/federation-roster.js';
import { resolveLiveBotTransport } from './services/team-roster.js';
import { handleFederationSpokeApi, syncAllMemberships, autoBindOwnerIfUnambiguous, type TeamSessionRowLike } from './dashboard/federation-spoke-api.js';
import type { TeamGroupCreateResult, TeamGroupOwnerTransferResult } from './dashboard/federated-group-core.js';
import { BotOnboardingManager } from './dashboard/bot-onboarding.js';
import { FeishuLoginManager } from './dashboard/feishu-login.js';
import {
  createDashboardH5AuthController,
  DashboardSessionStore,
  resolveDashboardH5AuthConfig,
} from './dashboard/h5-auth.js';
import { FileControlAuditSink } from './dashboard/control-audit.js';
import {
  TerminalControlManager,
  terminalControlTtlFromEnv,
} from './dashboard/terminal-control.js';
import {
  matchTerminalControlRoute,
  resolveTerminalControlAction,
} from './dashboard/terminal-control-route.js';
import { PreviewInteractionManager } from './dashboard/preview-interaction.js';
import { createPreviewGuardPage } from './dashboard/preview-guard-page.js';
import { handleWorkbenchDoctor } from './dashboard/workbench-doctor.js';
import {
  handleWorkbenchTicketRedemption,
  revokeWorkbenchTicketsOutsideGeneration,
  workbenchTicketGeneration,
} from './dashboard/workbench-ticket.js';
import { handleWorkbenchStandingLink } from './dashboard/standing-link.js';
import { createTerminalFrontProxy } from './dashboard/terminal-front-proxy.js';
import {
  centralViewLinkPath,
  mintTerminalViewCapability,
  terminalViewCapabilityAuthSession,
  terminalViewForwardProof,
  upstreamWorkerViewGeneration,
} from './dashboard/terminal-view-capability.js';
import {
  CLI_SELECT_OPTIONS,
  resolveCliSelection,
  isTtadkWrapper,
  ttadkAcceptsModel,
  TTADK_DEFAULT_MODEL,
  TTADK_MODEL_SUGGESTIONS,
} from './setup/cli-selection.js';
import {
  staticModelChoices,
  isKnownSelectionKey,
  buildModelChoicesResponse,
} from './services/model-catalog.js';
import { checkCliAvailability } from './setup/cli-availability.js';
import { invalidWorkingDirs } from './utils/working-dir.js';
import { invalidateGlobalConfigCache, mergeDashboardConfig, mergeGlobalConfig, readGlobalConfig, type MaintenanceConfig, type RepoPickerMode, type WhiteboardConfig } from './global-config.js';
import { hostLocalTimeZone, scheduleTimeZone } from './utils/timezone.js';
import {
  buildDashboardUrls,
  buildPlatformDashboardLoginUrl,
  workbenchEntryUrl,
  type DashboardUrls,
} from './core/dashboard-url.js';
import { resolveBotmuxDataDir } from './core/data-dir.js';
import { parseCloseResidual, type ParsedCloseResidual } from './core/close-residual.js';
import { dashboardSecretPath } from './core/dashboard-secret.js';
import { getGitRepoInfo } from './core/session-row-enrichment.js';
import { deleteWhiteboard, listWhiteboards, readWhiteboard, whiteboardEnabled } from './services/whiteboard-store.js';
import { isLocalDevInstall, botmuxVersion, botmuxVersionAt, diskVersionAt, botmuxCliEntry, botmuxCliEntryAt, botmuxInstallRoot, bakedBinaryVersion } from './utils/install-info.js';
import { checkNode, detectBotmuxInstalls, resolveCurrentVersion, resolveCurrentVersionAt } from './utils/install-diagnostics.js';
import {
  fetchLatestVersion,
  fetchReleasesSince,
  fetchRollbackVersions,
  compareVersions,
  isCanonicalStableVersion,
  isNewerVersion,
  type ChangelogResult,
  type RollbackVersionsResult,
} from './core/update-check.js';
import { GITHUB_REPO } from './core/restart-report.js';
import { DEFAULT_OVERLOAD_THRESHOLDS } from './core/host-overload-alert.js';
import { spawnDetachedRestart, globalInstallUpdateLockTarget } from './core/maintenance.js';
import {
  resolveLocalDevCheckoutDir,
  resolveLocalDevRestartTarget,
  isGitWorktree,
  gitPorcelainStatus,
  gitHeadSha,
  localDevUpdateSteps,
} from './utils/local-dev-update.js';
import {
  detectGlobalInstallManager,
  formatGlobalInstallCommand,
  resolveGlobalInstallPlan,
  tryResolveGlobalInstallPlan,
  isAutoUpdateSupportedInstall,
  withGlobalInstallRegistry,
  UnsupportedGlobalInstallError,
  type GlobalInstallPlan,
} from './utils/global-install.js';
import {
  filterCliRuntimeUpdateEntriesForTargets,
  listCliRuntimeUpdateEntries,
  selectCodexRuntimeUpdateTargets,
} from './core/cli-runtime-update.js';
import {
  claimRestartLease,
  clearRestartIntent,
  clearRestartLease,
  hasActiveRestartLease,
  writeManualIntentIfAbsent,
  writeRestartIntent,
} from './services/restart-intent-store.js';
import { withFileLock } from './utils/file-lock.js';
// Host children the dashboard forks (start/stop-bot, global install). They live
// in their own module because every one of them must run on a REDACTED env —
// see dashboard/managed-spawn.ts.
import { runGlobalInstall, runLocalDevStep, spawnStartBotLive, spawnStopBotLive } from './dashboard/managed-spawn.js';
import {
  applySettingsWrite,
  defaultSettingsWriteApplierDeps,
  hasResolvedCodexNotifierRecipient,
  resolveCodexNotifierRecipientView,
} from './dashboard/settings-write-applier.js';
import {
  addBotsToGroup,
  bindOncall,
  disbandGroup,
  leaveGroup,
  unbindOncall,
  type GroupsActionDeps,
  type HandlerResult as GroupsHandlerResult,
} from './dashboard/groups-action-helpers.js';
import { createDaemonInternalApi } from './dashboard/daemon-internal-api.js';
import { listTeamReports, readTeamBoard, setTeamBoardEntry } from './services/team-board-store.js';
import type { CliId } from './adapters/cli/types.js';
import { ALL_CLI_IDS, createCliAdapterSync } from './adapters/cli/registry.js';
import type { ConnectorDefinition } from './services/connector-store.js';
import { hd2dAssetPath, hd2dStatus, startHd2dDownload } from './dashboard/hd2d-assets.js';
import {
  buildSkillInstallAuditSummary,
  installLocalSkillLinks,
  readSkillRegistry,
  removeInstalledSkill,
  removeInstalledSkills,
  sweepStoreTrash,
  updateInstalledSkillAsync,
} from './services/skill-registry-store.js';
import { readSkillPackRegistry } from './services/skill-pack-store.js';
import { dashboardSessionActionTimeoutMs, type DashboardSessionAction } from './dashboard/session-action-timeout.js';
import { loopbackFetch } from './core/loopback-fetch.js';
import {
  cloneSkillPack,
  createSkillPack,
  deleteSkillPack,
  getSkillPack,
  listSkillPacks,
  updateSkillPack,
  SkillPackStoreError,
} from './services/skill-pack-store.js';
import { redactGitUrlCredentials } from './core/skills/sources.js';
import {
  enrichPackForDashboard,
  enrichPacksForDashboard,
  sanitizeSkillForDashboard,
} from './dashboard/skill-pack-response.js';
import { effectiveDefaultWorkingDir, getBot, loadBotConfigs, parseBotConfigsFromText, type BotConfig, type VcMeetingAgentConfig } from './bot-registry.js';
import { addChatToFeedGroup, createFeedGroup, FEED_GROUP_SCOPES, FeedGroupApiError, listFeedGroups } from './dashboard/feed-groups.js';
import { generateAuthUrl, handleCallbackUrl, isCallbackUrl } from './utils/user-token.js';
import { findEntryIndex, readRawConfig, requireConfigPath, rmwBotEntry, writeRawConfigAtomic } from './services/config-store.js';
import {
  emitCodexNotifierOutboxItem,
  installCodexNotifierHook,
  isCodexNotifierWorkerStateFresh,
  isCodexNotifierHookInstalled,
  listCodexNotifierOutbox,
  readCodexNotifierWorkerState,
  resolveCodexNotifierConfig,
  runCodexSideConversationMonitor,
  runCodexNotifierWorkerSupervisor,
} from './features/codex-notifier/index.js';
import type { BotSkillPolicy, SkillPack, SkillPackage, SkillSelector } from './core/skills/types.js';
import { discoverNativeCliSkillGroups } from './core/skills/discovery.js';
import { analyzeSkillReferences, packsContainingSkill, type SkillReferenceBot, type SkillReferenceSummary } from './core/skills/references.js';
import { discoverDashboardSkills, installDashboardSkill, parseDashboardSkillInstallRequest, parseInstallLocalLinksSources, MAX_LOCAL_LINK_SOURCES } from './dashboard/skill-install-request.js';
import { botDefaultsPayload, botSummaryPayload, brandMapByAppId } from './dashboard/bot-payload.js';
import {
  handleVcMeetingConsumerProfilesGet,
  handleVcMeetingConsumerProfilesPut,
  type VcMeetingConsumerProfilesApiDeps,
} from './dashboard/vc-consumer-profiles-api.js';
import { evaluateVcMeetingConsumerIsolation } from './services/vc-meeting-consumer-isolation.js';
import { resolvePairedSpawnBackendType } from './core/persistent-backend.js';
import {
  readVcMeetingSharedConsumerCatalogSnapshot,
  updateVcMeetingSharedConsumerCatalog,
} from './services/vc-meeting-shared-consumer-catalog-store.js';
import { isValidRoleProfileId } from './services/role-profile-store.js';
import { mergeSafeInsightOverviews } from './services/insight/report.js';
import type { SafeInsightOverview } from './services/insight/types.js';
import { readPlatformBinding } from './platform/binding.js';
import { startPlatformTunnelClient, type PlatformBotInfo, type PlatformTeamSyncMessage } from './platform/tunnel-client.js';
import { applyPlatformTeamSync, getPlatformTeamSyncRev, listPlatformTeams } from './services/platform-team-store.js';
import { CURRENT_A2A_CAPABILITIES } from './core/a2a-readiness.js';
import { getBotUnionId } from './services/bot-union-ids-store.js';
import { getBotSpecialties } from './services/bot-profile-store.js';
import { buildGoalAttentionBoardWithContext, withGoalAttentionLiveRisks } from './core/goal-attention.js';
import {
  listGoalNotificationRetries,
  removeGoalNotificationRetry,
  retryGoalNotification,
} from './services/goal-notification-retry-store.js';
import { cleanupIdleSessions, parseIdleCleanupHours } from './dashboard/session-cleanup.js';
import {
  compatMachineIdForAuthenticatedRequest,
  handleDesktopCompat,
} from './dashboard/compat.js';
import { isDashboardChunkJsPath, missingDashboardChunkModule } from './dashboard/stale-chunk-module.js';
import { aggregateRoleBatch, parseRoleBatchTargets } from './dashboard/roles-batch.js';
import { automateOpenPlatformSetup, vcListenerEventGateError } from './setup/open-platform-automation.js';
import { repairOpenPlatformRedirects } from './setup/open-platform-redirect-repair.js';
import { VC_MEETING_FEATURE_SCOPES, VC_MEETING_REALTIME_VOICE_SCOPES } from './setup/verify-permissions.js';
import { maybeInstallTraexPluginOnSettingsChange, TRAEX_RECOMMENDED_SOURCE, TRAEX_RECOMMENDED_REF } from './setup/ensure-herdr-integrations.js';
import { deriveCreateGroupName, selectCreateSessionTargets } from './core/session-create.js';
import { parseDashboardImageUploads } from './core/dashboard-images.js';
import { checkLarkCliVersion, MIN_LARK_CLI_VERSION_FOR_VC_BOT } from './vc-agent/polling-source.js';
import { larkHosts, normalizeBrand } from './im/lark/lark-hosts.js';
import { buildResourceMonitorDaemonSeeds, createResourceMonitorService, handleResourceMonitorApi, toResourceMonitorSessionSeed } from './dashboard/resource-monitor-service.js';
import { readPluginRegistry } from './services/plugin-registry-store.js';
import { pluginRuntimeDir, resolvePluginPath } from './core/plugins/paths.js';
import { isValidPluginId, normalizePluginIdList } from './core/plugins/ids.js';
import { listPluginServiceStatus, startPluginServices, stopPluginServices } from './core/plugins/service-manager.js';
import { materializePlugin } from './core/plugins/materializer.js';
import { resolveEffectivePluginIds, updateBotPluginOverride } from './core/plugins/effective.js';
import { assertPluginBindingTransition, describePluginDependencyError } from './core/plugins/dependencies.js';
import { inspectGatewayEntry } from './core/plugins/mcp/gateway-installer.js';
import type { InstalledPluginRecord, PluginDashboardEntry } from './core/plugins/types.js';
import { fetchDaemonIpc } from './core/daemon-ipc-auth.js';
import {
  buildDashboardSummary,
  parseDashboardSummaryRows,
} from './dashboard/dashboard-summary.js';
import { createDashboardSummaryEndpoint } from './dashboard/dashboard-summary-endpoint.js';
import {
  createDashboardAutostartController,
  DashboardAutostartError,
  dashboardAutostartErrorStatus,
  parseAutostartWrite,
} from './dashboard/autostart-api.js';
import { scrubWorkflowWorkerEnv } from './utils/child-env.js';

// The dashboard is an independent long-lived PM2 app and can be resurrected
// from a stale dump.pm2 without passing through cli.ts pm2Env(). Its start/stop
// and detached-restart children inherit process.env, so a leaked workflow
// marker would make those CLI commands fail at the workflow safety gate before
// they can reach their own cleanup boundary.
scrubWorkflowWorkerEnv(process.env);
import { buildGoalBoard } from './verified-delivery/goal-board.js';

const SECRET_PATH = dashboardSecretPath();
const TOKEN_PATH = join(homedir(), '.botmux', '.dashboard-token');
const AUTOSTART_CONFIG_DIR = join(homedir(), '.botmux');
const dashboardAutostart = createDashboardAutostartController({
  opts: {
    pkgRoot: botmuxInstallRoot(),
    configDir: AUTOSTART_CONFIG_DIR,
    logDir: join(AUTOSTART_CONFIG_DIR, 'logs'),
  },
});
/** Per-daemon budget for the cross-daemon insight overview fan-out — bounds
 *  aggregate latency when one daemon's insight parse is slow or hung. */
const INSIGHT_FANOUT_TIMEOUT_MS = 10_000;
const BOTS_JSON_PATH = join(homedir(), '.botmux', 'bots.json');
const REGISTRY_DIR = join(resolveBotmuxDataDir(), 'dashboard-daemons');
// The dashboard probes upward if its configured port is busy (e.g. a second
// botmux instance on this host). The actually-bound port is persisted here so
// the `botmux dashboard` CLI can reach /__cli/current, /__cli/ensure, and
// /__cli/rotate without guessing.
const PORT_PATH = join(homedir(), '.botmux', '.dashboard-port');

function loadOrCreateSecret(): string {
  let existing: string | null;
  try {
    existing = loadDashboardSecret(SECRET_PATH);
  } catch (e) {
    logger.error(`[dashboard] Failed to read dashboard secret at ${SECRET_PATH}: ${(e as Error).message}`);
    process.exit(1);
  }
  if (existing) return existing;

  const existed = existsSync(SECRET_PATH);
  try {
    const secret = loadOrCreateDashboardSecret(SECRET_PATH);
    logger.info(`[dashboard] ${existed ? 'Regenerated empty' : 'Generated'} dashboard secret at ${SECRET_PATH}`);
    return secret;
  } catch (e) {
    logger.error(`[dashboard] Failed to create dashboard secret at ${SECRET_PATH}: ${(e as Error).message}`);
    process.exit(1);
  }
}

// The persisted file is the active-token authority. Reading it at each use
// keeps multiple dashboard processes coherent: first creation converges under
// a file lock, and an explicit rotation is observed by every process without a
// restart. `/__cli/current` remains a strictly read-only probe.
function currentDashboardToken(): string | null {
  try {
    return loadPersistedToken(TOKEN_PATH);
  } catch (error) {
    logger.warn(`[dashboard] Failed to read token from ${TOKEN_PATH}: ${(error as Error).message}`);
    return null;
  }
}

// The port we actually bound (may differ from config.dashboard.port after an
// EADDRINUSE probe). Used for token-bearing URLs and persisted for the CLI.
let boundDashboardPort = config.dashboard.port;

const SECRET = loadOrCreateSecret();

const dashboardControlAudit = new FileControlAuditSink();
const dashboardH5AuthConfig = resolveDashboardH5AuthConfig();
const dashboardSessions = new DashboardSessionStore({ ttlMs: dashboardH5AuthConfig.sessionTtlMs });
const dashboardH5Auth = createDashboardH5AuthController({
  config: dashboardH5AuthConfig,
  sessions: dashboardSessions,
  audit: dashboardControlAudit,
});
const terminalControl = new TerminalControlManager({
  secret: SECRET,
  audit: dashboardControlAudit,
  ttlMs: terminalControlTtlFromEnv(),
});
const previewInteraction = new PreviewInteractionManager({ audit: dashboardControlAudit });

function legacyDashboardAuthSessionId(token: string): string {
  return createHmac('sha256', SECRET)
    .update('botmux-legacy-dashboard-session-id-v1\0')
    .update(token)
    .digest('base64url');
}

/** Stable per-machine scope for platform-dashboard actors. Shared between
 * identity resolution and the read-capability liveness check so the two can
 * never drift apart on the authSessionId format. */
function platformDashboardActorScope(machineId: string): string {
  return createHmac('sha256', SECRET)
    .update('botmux-platform-dashboard-actor-v1\0')
    .update(machineId)
    .digest('base64url');
}

/**
 * P1-5 liveness for a bound terminal read capability: `false` means the auth
 * session it was minted under is over (H5 logout/expiry, dashboard token
 * rotation, platform unbind), so the front proxy refuses the capability even
 * though its signature/expiry would still verify at the worker.
 */
function terminalAuthSessionLive(authSessionId: string): boolean {
  if (dashboardSessions.liveAuthSession(authSessionId)) return true;
  const activeToken = currentDashboardToken();
  if (activeToken && authSessionId === legacyDashboardAuthSessionId(activeToken)) return true;
  const binding = readPlatformBinding();
  if (binding) {
    const scope = platformDashboardActorScope(binding.machineId);
    if (authSessionId === `${scope}:owner`
      || authSessionId === `${scope}:teammate`
      || authSessionId === `${scope}:guest`) {
      return true;
    }
  }
  return false;
}

/** P1-8：预览内容凭据所属的认证会话（校验失败 → null，不予绑定）。 */
function previewContentCapabilityAuthSession(capability: string, sessionId: string): string | null {
  const verified = verifyPreviewContentCapability(SECRET, capability, sessionId);
  return verified.ok ? verified.claims.authSessionId : null;
}

/** P1-7：身份判定只此一处（legacy > 平台角色 > H5），门禁选择也只读它的结论。 */
function dashboardRequestIdentity(req: IncomingMessage): DashboardRequestIdentity | null {
  return resolveDashboardIdentity({
    legacyCookie: parseCookie(req.headers.cookie),
    // The persisted file is the active-token authority (currentDashboardToken);
    // there is no module-level mirror to compare against any more.
    activeToken: currentDashboardToken(),
    roleHeader: req.headers['x-botmux-role'],
    platformMachineId: readPlatformBinding()?.machineId ?? null,
    platformActorScope: platformDashboardActorScope,
    legacyAuthSessionId: legacyDashboardAuthSessionId,
    h5: dashboardH5Auth.resolve(req),
  });
}

/** P1-8：authSession → 已建立的长连接（/events SSE、Preview SSE/长响应、
 *  Preview WS）。身份一结束就遍历关闭，不等对端自己断。 */
const authSessionConnections = new AuthSessionConnectionRegistry();
/** P1-11：控制类端点的一次性 CSRF 票据（页面加载现签、绑定认证会话）。 */
const controlCsrfTokens = new ControlCsrfTokens();

/**
 * 身份结束的统一收口：H5 logout/到期、legacy token rotate、平台解绑三条来源都
 * 走这里，少走一条就等于留一扇后窗（P1-5 关写租约/读 socket，P1-8 关其余长连接，
 * P1-11 作废该会话签出的 CSRF 票据）。
 */
function endDashboardAuthSession(authSessionId: string): void {
  terminalControl.releaseByAuthSession(authSessionId);
  previewInteraction.relockAuthSession(authSessionId);
  authSessionConnections.closeAuthSession(authSessionId);
  controlCsrfTokens.revokeAuthSession(authSessionId);
}

/**
 * P1-8 平台解绑/改绑：`botmux bind|unbind` 先写 platform.json 再捅
 * `/__cli/reload-binding`，所以进入 handler 时磁盘上已经是**新**值——想知道刚
 * 才被吊销的是谁，只能由本进程自己记住上一次认可的 machineId。
 */
let observedPlatformMachineId: string | null = readPlatformBinding()?.machineId ?? null;

function syncPlatformBindingRevocation(): void {
  const current = readPlatformBinding()?.machineId ?? null;
  if (observedPlatformMachineId && observedPlatformMachineId !== current) {
    const scope = platformDashboardActorScope(observedPlatformMachineId);
    for (const role of ['owner', 'teammate', 'guest'] as const) {
      endDashboardAuthSession(`${scope}:${role}`);
    }
  }
  observedPlatformMachineId = current;
}

dashboardSessions.onEnd(identity => {
  // Ends BOTH capabilities of the authentication (P1-5): write leases AND every
  // read socket the auth session opened (bound view-link capabilities included,
  // via the front proxy's read-socket index). New connections with a capability
  // minted under this authSessionId are refused by terminalAuthSessionLive.
  endDashboardAuthSession(identity.authSessionId);
});

function tcpPortAvailable(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createTcpServer();
    probe.once('error', () => resolve(false));
    probe.listen(port, host, () => {
      probe.close(() => resolve(true));
    });
  });
}

function dashboardPortAvailable(port: number): Promise<boolean> {
  if (!isWildcardBindHost(config.dashboard.host)) return Promise.resolve(true);
  // `botmux dashboard` talks to loopback even when the browser-facing server
  // binds wildcard. On macOS another process can hold 127.0.0.1:port while a
  // wildcard bind still succeeds, causing CLI HMAC calls to hit that process.
  return tcpPortAvailable('127.0.0.1', port);
}

// Per-process random marker served at /__selfcheck. Lets verifyDashboardBinding
// confirm a loopback request to our just-bound wildcard port reaches THIS
// process and not a shadow holding 127.0.0.1:port. The value is meaningless to
// anyone else, so exposing it is safe.
const DASHBOARD_SELF_NONCE = randomBytes(16).toString('hex');

/**
 * Post-bind loopback identity check handed to listenWithProbe (verifyBound).
 * dashboardPortAvailable is a PRE-bind gate, but on macOS a loopback occupant
 * can appear in the race window between that check and the wildcard listen, and
 * a 0.0.0.0 bind succeeds anyway while loopback routing favours the occupant —
 * so the dashboard would advertise a port it doesn't actually own on loopback.
 * This runs AFTER listen: dial 127.0.0.1:port/__selfcheck and require OUR nonce
 * back. A shadow answers with its own body/404 → reject → listenWithProbe steps
 * up. Number-independent: it works no matter which port or who is shadowing.
 * Loopback-host binds can't be shadowed, so they short-circuit to true.
 */
function verifyDashboardBinding(port: number): Promise<boolean> {
  if (!isWildcardBindHost(config.dashboard.host)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const req = httpGet({ host: '127.0.0.1', port, path: '/__selfcheck', agent: false }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; if (body.length > 128) req.destroy(); });
      res.on('end', () => resolve(res.statusCode === 200 && body === DASHBOARD_SELF_NONCE));
    });
    req.setTimeout(2000, () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}

mkdirSync(REGISTRY_DIR, { recursive: true });
const registry = new DaemonRegistry(REGISTRY_DIR);
const aggregator = new Aggregator();
/**
 * P1-13：一个会话的预览目标失效时的收口动作（本进程侧）。
 *
 * 「失效」= 目标没了或换了主人：worker 换代 / 切 CLI / 会话关闭 / 端口被别的进程接管。
 * 这三件事必须一起做，少一件就留一扇后窗：
 *   1. 断掉该会话已经建立的预览 SSE / 长响应 / WebSocket——它们握手时是合法的，此刻
 *      仍在把一个**不再属于这个会话**的进程的内容送进浏览器；
 *   2. 收回该会话上的交互租约（resume 出来的新一代不得继承旧的「交互模式」授权）；
 *   3. 让持有会话的 daemon 清掉 previewTarget 并广播 `preview: null`——代理进程只有
 *      procfs 的只读视角，改不了会话行。
 */
const previewInvalidationsInFlight = new Set<string>();
function teardownSessionPreview(sessionId: string): void {
  authSessionConnections.closeSessionStreams(sessionId);
  previewInteraction.relockSession(sessionId);
}
function invalidateStalePreviewTarget(
  sessionId: string,
  ownerLarkAppId: string | undefined,
  staleTarget: SessionPreviewTarget,
): void {
  teardownSessionPreview(sessionId);
  if (!ownerLarkAppId || previewInvalidationsInFlight.has(sessionId)) return;
  // 每个会话同一时刻只发一次清理请求：刷新一次页面就是几十条子资源请求，逐条捅
  // daemon 会把一次失效放大成一场风暴。拒绝本身已经生效，这里只是让状态收敛。
  previewInvalidationsInFlight.add(sessionId);
  // P1-3：指名要作废的是判定失效的**那一次注册**。这条 DELETE 跨进程飞过去的途中，
  // 会话完全可以合法地重注册一个新目标；不带 revision 的清空会把它一起抹掉。
  const path = `/api/sessions/${encodeURIComponent(sessionId)}/preview`
    + `?expectedRegisteredAt=${encodeURIComponent(staleTarget.registeredAt)}`;
  void proxyToDaemon(ownerLarkAppId, path, { method: 'DELETE' })
    .catch(() => { /* 清理是收敛动作；失败时本次拒绝依旧成立 */ })
    .finally(() => previewInvalidationsInFlight.delete(sessionId));
}

/**
 * 每一跳预览请求的判定入口（HTTP、WebSocket 升级、guard 页面共用同一条）。
 *
 * P1-12：归属复核只读 /proc/net/tcp{,6} 与 /proc/<pid>/stat（全体可读），所以即便
 * 代理进程与 daemon 不是同一个用户也能在每次落地前重新核验。
 */
function resolveDashboardSessionPreview(sessionId: string): PreviewProxyResolution {
  const owner = aggregator.ownerOf(sessionId);
  return resolveSessionPreviewForProxy({
    row: aggregator.getSession(sessionId),
    sessionId,
    ownerLarkAppId: owner,
    daemonOnline: !!owner && !!registry.getByAppId(owner),
    isTargetOwned: target => sessionPreviewTargetStillOwned(target),
    onStaleTarget: (staleSessionId, staleTarget) =>
      invalidateStalePreviewTarget(staleSessionId, owner, staleTarget),
  });
}
const sessionPreviewProxy = createSessionPreviewProxy({
  // Preview HTTP/WS never accepts ?t=. The user must first establish either
  // the legacy management cookie or an allow-listed short H5 session.
  authenticated: req => dashboardRequestIdentity(req) !== null,
  resolve: resolveDashboardSessionPreview,
  // P0: the sandboxed content stream is an opaque origin, so it carries no
  // cookie of any kind. Its path-scoped capability is the only credential —
  // signature + session binding + expiry here, plus central revocation
  // (logout / token rotation / platform unbind) through the same auth-session
  // liveness the bound terminal read capability uses.
  verifyContentCapability: (capability, sessionId) => {
    const verified = verifyPreviewContentCapability(SECRET, capability, sessionId);
    return verified.ok && terminalAuthSessionLive(verified.claims.authSessionId);
  },
  // P1-8: preview SSE / long responses / WebSocket bridges outlive the handshake
  // that authorised them. Index each stream under its auth session so logout /
  // rotation / unbind tears it down immediately. The content path carries no
  // cookie, so its owner is the capability's own authSessionId.
  // P1-13：同一条流再按 sessionId 建第二个索引。预览目标失效（换代 / 关闭 / 端口易主）
  // 时身份仍然有效，只能靠这个索引定点断流。
  // P1-4：这里同时是「登记点」和「最后一次判定点」。授权发生在拨号之前，而 dev
  // server 的握手最长可以拖 45 秒；这段窗口里的登出/到期/rotate/解绑扫描不到一条
  // 还没入索引的流。所以登记前把身份重新解一遍并复核存活：解不出身份（cookie 那条
  // 路的会话已经没了）或已不存活，一律 fail closed，由代理销毁上游、不回 101/200。
  // P1-1：同一段窗口里换靶也要 fail closed。身份没变、目标却已经换代 / 切 CLI /
  // 端口易主时，旧流握完手照样能拿到 200/101，还会被**重新登记**进索引——换靶那一刻
  // 的 teardown 扫的是索引，扫不到一条还没入索引的流。所以登记前把目标重解一遍
  // （`resolveDashboardSessionPreview` 内含每跳的 owner 复核）并与拨号时那个比指纹：
  // 不是同一次注册就不登记、不回 101/200，由代理销毁上游。
  bindStream: (req, ctx, close) => {
    const authSessionId = ctx.contentCapability
      ? previewContentCapabilityAuthSession(ctx.contentCapability, ctx.sessionId)
      : dashboardRequestIdentity(req)?.authSessionId ?? null;
    if (!authSessionId || !terminalAuthSessionLive(authSessionId)) return false;
    const current = resolveDashboardSessionPreview(ctx.sessionId);
    if (!current.ok || !sameSessionPreviewTarget(current.target, ctx.target)) return false;
    return authSessionConnections.register(authSessionId, close, ctx.sessionId);
  },
});
/**
 * P1-13：daemon 侧生命周期事件 → 预览收口。
 *
 * daemon 在每个权威换代边界广播 `preview: null`（worker 换代 / suspend / exit /
 * close），会话彻底结束时广播 `session.exited`。中央 Dashboard 订阅这些事件，把本地
 * 还挂着的预览长连接断掉、交互租约收回——否则「服务端已经没有目标了，浏览器那条流
 * 还在流」，而且 resume 之后旧的交互授权会直接落到新一代 CLI 上。
 *
 * P1-1：`session.spawned` 也要认。daemon 重启期间广播的 `preview: null` 是丢的（事件
 * 总线没有 replay buffer），重连之后只以 spawned 重放形式补齐。判据与记忆都在
 * `previewTeardownForDaemonEvent` 里——只有目标指纹**确实变了**才收口，否则每次 SSE
 * 重连都会误杀全部预览长连接。
 */
const lastSeenPreviewFingerprints = new Map<string, string>();
aggregator.on(ev => {
  const sessionId = previewTeardownForDaemonEvent(ev, lastSeenPreviewFingerprints);
  if (sessionId) teardownSessionPreview(sessionId);
});
const previewGuardPage = createPreviewGuardPage({
  authenticated: req => dashboardRequestIdentity(req) !== null,
  resolve: resolveDashboardSessionPreview,
  mintContentCapability: (req, sessionId) => {
    const identity = dashboardRequestIdentity(req);
    return identity
      ? mintPreviewContentCapability(SECRET, sessionId, {
        userId: identity.userId,
        authSessionId: identity.authSessionId,
        expiresAt: identity.expiresAt,
      })
      : null;
  },
  // P1-11: the guard shell is same-origin with the dashboard and POSTs
  // unlock/activity/lock itself, so it needs its own control ticket.
  mintCsrfToken: req => {
    const identity = dashboardRequestIdentity(req);
    return identity ? controlCsrfTokens.mint(identity.authSessionId) : null;
  },
  // P2：解锁按钮按能力渲染，与工作台面板用同一份投影（canInteract）。平台
  // teammate/guest 这类 previewCapability=readonly 的身份，解锁 POST 本来就会被
  // 下面的 preview-interaction 路由 403；壳里不再画那个按钮，避免「点了才知道
  // 没权限」。这只是不渲染一个必然失败的入口，服务端门禁一分未松。
  canInteract: req => projectWorkbenchOperationCapabilities(dashboardRequestIdentity(req)).canInteract,
});
const terminalFrontProxy = createTerminalFrontProxy({
  resolvePort: sessionId => aggregator.terminalProxyPortOf(sessionId),
  resolveActor: dashboardRequestIdentity,
  control: terminalControl,
  // P1-5: bound `?viewToken=` capabilities are refused once the auth session
  // they were minted under ended, and their bridged sockets are indexed so
  // logout/expiry closes them immediately (see dashboardSessions.onEnd).
  viewCapabilityAuthSession: (sessionId, viewToken) =>
    terminalViewCapabilityAuthSession(SECRET, sessionId, viewToken),
  isAuthSessionLive: terminalAuthSessionLive,
  // P1-5: this proxy is the ONLY consumer allowed to spend a view capability.
  // The countersignature proves the loopback hop passed through here — and
  // therefore through the liveness check above — so a raw view URL aimed at the
  // worker port or the daemon's own `/s/` proxy is refused by the worker.
  viewCapabilityForwardProof: viewToken => terminalViewForwardProof(SECRET, viewToken),
});
const sessionPresentation = createSessionPresentationCoordinator(aggregator, getGitRepoInfo);
const groupsMatrixSnapshot = createGroupsMatrixSnapshot(buildGroupsMatrix, {
  onRefreshError: error => logger.warn(`[dashboard] groups matrix refresh failed: ${String(error)}`),
});
let groupsRosterSignature = botsRosterSignature(registry.list());
registry.on((online) => {
  const next = botsRosterSignature(online);
  if (next === groupsRosterSignature) return;
  groupsRosterSignature = next;
  groupsMatrixSnapshot.invalidate();
});

// Keep Git-derived fields in the central read-model so REST snapshots and SSE
// share one row shape. Idle/limited turn boundaries force a branch refresh
// after the CLI has had a chance to change repositories — that is one
// `git rev-parse` per session per turn, bounded by the resolver's concurrency
// cap, NOT a slow background poll.
aggregator.on(sessionPresentation.onEvent);

// 调试终端（owner-only 裸 bash）。默认工作目录取当前所有 session 的工作目录去重，
// 让 owner 从熟悉的目录起终端复现问题；都没有时模块内退回 homedir。
const debugTerminalManager = createDebugTerminalManager({
  getActiveToken: currentDashboardToken,
  // WS 升级不经 HTTP auth gate，所以在这里把 `/api/debug-terminal` 那条 `legacyAuthed`
  // 门禁原样喂进去：解析出的身份必须是本机 legacy 管理身份，平台隧道注入的角色
  // （X-Botmux-Role）不算——它带的也是本机活跃 cookie，只比 cookie 会把裸 shell
  // 开放给平台上的任何人。
  isLegacyManagementRequest: (req) => dashboardRequestIdentity(req)?.kind === 'legacy-dashboard',
  defaultWorkingDirs: () => {
    const dirs = new Set<string>();
    for (const s of aggregator.getSessions()) {
      const wd = (s as { workingDir?: unknown }).workingDir;
      if (typeof wd === 'string' && wd.trim()) dirs.add(wd.trim());
    }
    return [...dirs];
  },
});

/**
 * Resolve which daemon owns a schedule row. For rows with an explicit
 * `larkAppId`, returns that. For legacy rows (no owner stamp), falls back to
 * the primary daemon (botIndex === 0) — the only daemon that executes legacy
 * tasks (see scheduler.belongsToOwner). Returns undefined when the row is
 * genuinely unknown or no daemon is online.
 */
/**
 * Read-only directory listing for the dashboard sandbox-paths tree picker.
 * Served locally by the dashboard process (same host as the daemons). Returns
 * immediate CHILD DIRECTORIES only — never file contents. Trust model matches
 * validateWorkingDir: the caller is an authed admin and the daemon already runs
 * prompts with full FS access, so this is a convenience browser, not a security
 * boundary. Symlinks are realpath-resolved; a raw path is never echoed into an
 * error the browser renders verbatim.
 */
function listDirLocally(rawPath: string): {
  ok: boolean;
  path: string | null;
  parent: string | null;
  entries: { name: string; path: string; kind: 'dir' }[];
  home?: string;
  error?: string;
} {
  // Canonicalize $HOME so the root entry + the `~` the frontend expands both use
  // the SAME canonical form the child listings (realpathSync below) and the
  // worker's sandbox binds use. On a symlinked-$HOME host (/home/u →
  // /data00/home/u) the lexical homedir() would make `~/.claude` expand to
  // /home/u/.claude while the tree's child nodes come back as /data00/... — the
  // picker would then never match `~`-relative tier entries.
  let home = homedir();
  try { home = realpathSync(home); } catch { /* lexical fallback if unresolvable */ }
  if (!rawPath) {
    // Root view: HOME first (the common case), then filesystem root. `home` is
    // also returned explicitly so the frontend doesn't guess from entries[0].
    const roots = [...new Set([home, '/'])];
    return {
      ok: true, path: null, parent: null, home,
      entries: roots.map(p => ({ name: p, path: p, kind: 'dir' as const })),
    };
  }
  const expanded = rawPath.startsWith('~') ? join(home, rawPath.slice(1)) : rawPath;
  let resolved: string;
  try { resolved = realpathSync(expanded); }
  catch { return { ok: false, path: null, parent: null, entries: [], error: 'path_not_found' }; }
  let entries: { name: string; path: string; kind: 'dir' }[];
  try {
    entries = readdirSync(resolved, { withFileTypes: true })
      .filter(d => {
        try { return d.isDirectory() || (d.isSymbolicLink() && statSync(join(resolved, d.name)).isDirectory()); }
        catch { return false; }
      })
      .map(d => ({ name: d.name, path: join(resolved, d.name), kind: 'dir' as const }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch (e: any) {
    return { ok: false, path: resolved, parent: null, entries: [], error: e?.code === 'EACCES' ? 'permission_denied' : 'cannot_read_dir' };
  }
  const parent = resolved === '/' ? null : dirname(resolved);
  return { ok: true, path: resolved, parent, entries };
}

function resolveScheduleOwner(id: string): string | undefined {
  const explicit = aggregator.scheduleOwnerOf(id);
  if (explicit) return explicit;
  if (!aggregator.scheduleExists(id)) return undefined;
  const primary = registry.list().find(d => d.botIndex === 0);
  return primary?.larkAppId;
}
const botOnboarding = new BotOnboardingManager({
  botsJsonPath: BOTS_JSON_PATH,
  stopBotLive: spawnStopBotLive,
  startBotLive: spawnStartBotLive,
});
// 飞书 Web 登录态刷新（机器人改名缺登录态时的 dashboard 扫码入口）。机器级单例，
// 写 ~/.botmux/feishu-session.json，与 setup / onboarding 复用同一份登录态。
const feishuLogin = new FeishuLoginManager();
const subs = new Map<string, () => void>();
const attaching = new Set<string>();   // dedup concurrent attaches per appId

interface ResolvedDashboardSettings {
  /** Machine-wide prefix applied only by the `/group` and `/g` slash commands. */
  groupNamePrefix: string;
  publicReadOnly: boolean;
  openTerminalInFeishu: boolean;
  enableLocalCliOpen: boolean;
  localCliOpenMode: 'attach' | 'resume';
  /** Experimental current-chat bot discovery via Lark `/members/bots`. Default ON. */
  chatBotDiscovery: boolean;
  /** Machine-wide opt-in TraeX herdr plugin bootstrap. Default OFF.
   *  `recommendedSource`/`recommendedRef` are a non-default, author-recommended
   *  source the SPA can offer as a one-click fill; never persisted unless picked. */
  herdrTraexPlugin: { enabled: boolean; source: string; ref: string; recommendedSource: string; recommendedRef: string };
  codexRpcInput: boolean;
  /** Whether botmux auto-bypasses Codex's interactive hook-trust gate for
   *  Codex-family plain-TUI launches. Default ON (only an explicit false disables). */
  bypassCodexHookTrust: boolean;
  codexNotifier: {
    enabled: boolean;
    targetBotAppId: string | null;
    notifyWhen: 'locked_only' | 'always';
    platformSupported: boolean;
    hookInstalled: boolean;
    botOptions: Array<{
      larkAppId: string;
      botName: string | null;
      cliId: string;
      recipientConfigured: boolean;
      recipientVerified: boolean;
      recipientHint: string | null;
    }>;
    targetDaemonOnline: boolean;
    pendingCount: number;
    workerOnline: boolean;
    lastError: { at: string; message: string; retryAt: string } | null;
  };
  /** Machine-wide host-overload alert. Default OFF. Delivered by the selected
   *  notifier bot's daemon (any non-apiOnly bot with a resolvable admin). */
  hostOverloadAlert: {
    enabled: boolean;
    targetBotAppId: string | null;
    enterLoadRatio: number;
    enterMemUsedFrac: number;
    botOptions: Array<{
      larkAppId: string;
      botName: string | null;
      cliId: string;
      apiOnly: boolean;
      recipientConfigured: boolean;
      recipientVerified: boolean;
      recipientHint: string | null;
    }>;
    targetDaemonOnline: boolean;
  };
  /** Experimental anti-resend guidance in botmux routing hints. Default OFF. */
  noVisibleOutputHint: boolean;
  /** Machine-wide VC meeting listener kill-switch. Default ON. */
  vcMeetingAgent: {
    enabled: boolean;
    /** Detected lark-cli version, or null if not installed. */
    larkCliVersion?: string | null;
    /** True when the installed lark-cli meets the VC bot minimum version. */
    larkCliMeetsRequirement?: boolean;
    /** Minimum lark-cli version required for VC bot meeting commands. */
    larkCliMinVersion?: string;
  };
  repoPickerMode: RepoPickerMode;
  /** Auto-update / auto-restart schedule (off by default). */
  maintenance: MaintenanceConfig;
  /** True when running from a source checkout. */
  localDevInstall: boolean;
  /** False for package layouts whose owning updater is not supported. */
  autoUpdateSupported: boolean;
  /** Optional local project whiteboard. Disabled by default. */
  whiteboard: WhiteboardConfig;
  /** Machine-wide v3 Workflow feature switch. Default ON; set false to disable
   *  the `/workflow` grill, Saved-Workflow run/save, the botmux-workflow skill
   *  family, and the CLI authoring/run subcommands host-wide. */
  workflow: { enabled: boolean };
  /** 远程访问: emit central-platform URLs (terminals / cards / webhooks) instead
   *  of local host:port. Off by default; only meaningful when bound. */
  remoteAccess: boolean;
  /** OAuth 授权回跳基址（`<base>/oauth/callback`），null = 未配置 ⇒ 退回
   *  `http://127.0.0.1:9768/callback` 的手工粘贴流程。见 global-config 的
   *  `oauthRedirectBase`。 */
  oauthRedirectBase: string | null;
  /** Configured schedule-task timezone override (IANA), or null when unset
   *  ⇒ the scheduler follows `hostTimeZone`. */
  scheduleTimeZone: string | null;
  /** Host's auto-detected local zone (e.g. 'America/Los_Angeles'). */
  hostTimeZone: string;
  /** The TRUE effective zone the scheduler fires/displays in = scheduleTimeZone()
   *  (env `BOTMUX_SCHEDULE_TIMEZONE` → config → host). The UI must use THIS for
   *  "currently effective" — never reconstruct it from configured||host, which
   *  ignores the env override. */
  effectiveScheduleTimeZone: string;
}

async function validateCodexNotifierTargetBotAppId(
  appId: string,
  options: { requireReady?: boolean } = {},
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const bot = loadBotConfigs().find(candidate => candidate.larkAppId === appId);
    if (!bot) return { ok: false, error: 'codexNotifier_target_unknown' };
    if (bot.cliId !== 'codex' && bot.cliId !== 'codex-app') {
      return { ok: false, error: 'codexNotifier_target_cli_unsupported' };
    }
    if (!(bot.allowedUsers ?? []).some(user => typeof user === 'string' && user.trim())) {
      return { ok: false, error: 'codexNotifier_target_owner_missing' };
    }
    if (options.requireReady !== true) return { ok: true };
    const daemon = registry.list().find(candidate => candidate.larkAppId === appId);
    if (!daemon) return { ok: false, error: 'codexNotifier_target_daemon_offline' };
    const resolvedOwners = daemon.resolvedAllowedUsers ?? [];
    if (!hasResolvedCodexNotifierRecipient(resolvedOwners)) {
      return { ok: false, error: 'codexNotifier_target_owner_unverified' };
    }
    return { ok: true };
  } catch {
    return { ok: false, error: 'codexNotifier_target_unknown' };
  }
}

function codexNotifierBotOptions(): ResolvedDashboardSettings['codexNotifier']['botOptions'] {
  try {
    const onlineByAppId = new Map(registry.list().map(bot => [bot.larkAppId, bot] as const));
    return loadBotConfigs()
      .filter(bot => bot.cliId === 'codex' || bot.cliId === 'codex-app')
      .map(bot => {
        const resolvedOwners = onlineByAppId.get(bot.larkAppId)?.resolvedAllowedUsers ?? [];
        return {
          larkAppId: bot.larkAppId,
          botName: bot.displayName ?? onlineByAppId.get(bot.larkAppId)?.botName ?? bot.name ?? null,
          cliId: onlineByAppId.get(bot.larkAppId)?.cliId ?? bot.cliId,
          ...resolveCodexNotifierRecipientView(bot.allowedUsers, resolvedOwners),
        };
      });
  } catch {
    return [];
  }
}

/** Validate an overload-alert notifier bot. Unlike codexNotifier this is NOT
 *  codex-only — any non-apiOnly bot that can resolve an admin recipient works.
 *  On enable (requireReady) the target daemon must be online, else the alert
 *  can't be delivered (this feature is best-effort, no outbox). */
async function validateHostOverloadAlertTargetBotAppId(
  appId: string,
  options: { requireReady?: boolean } = {},
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const bot = loadBotConfigs().find(candidate => candidate.larkAppId === appId);
    if (!bot) return { ok: false, error: 'hostOverloadAlert_target_unknown' };
    if (bot.apiOnly === true) return { ok: false, error: 'hostOverloadAlert_target_apiOnly' };
    if (!(bot.allowedUsers ?? []).some(user => typeof user === 'string' && user.trim())) {
      return { ok: false, error: 'hostOverloadAlert_target_owner_missing' };
    }
    if (options.requireReady !== true) return { ok: true };
    const daemon = registry.list().find(candidate => candidate.larkAppId === appId);
    if (!daemon) return { ok: false, error: 'hostOverloadAlert_target_offline' };
    const resolvedOwners = daemon.resolvedAllowedUsers ?? [];
    if (!hasResolvedCodexNotifierRecipient(resolvedOwners)) {
      return { ok: false, error: 'hostOverloadAlert_target_owner_missing' };
    }
    return { ok: true };
  } catch {
    return { ok: false, error: 'hostOverloadAlert_target_unknown' };
  }
}

function hostOverloadAlertBotOptions(): ResolvedDashboardSettings['hostOverloadAlert']['botOptions'] {
  try {
    const onlineByAppId = new Map(registry.list().map(bot => [bot.larkAppId, bot] as const));
    return loadBotConfigs()
      .filter(bot => bot.apiOnly !== true) // apiOnly bots can't send Feishu messages
      .map(bot => {
        const resolvedOwners = onlineByAppId.get(bot.larkAppId)?.resolvedAllowedUsers ?? [];
        return {
          larkAppId: bot.larkAppId,
          botName: bot.displayName ?? onlineByAppId.get(bot.larkAppId)?.botName ?? bot.name ?? null,
          cliId: onlineByAppId.get(bot.larkAppId)?.cliId ?? bot.cliId,
          apiOnly: bot.apiOnly === true,
          ...resolveCodexNotifierRecipientView(bot.allowedUsers, resolvedOwners),
        };
      });
  } catch {
    return [];
  }
}

function normalizeVcMeetingAgentRecord(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === 'object' && !Array.isArray(raw)
    ? { ...(raw as Record<string, unknown>) }
    : {};
}

function compactVcMeetingAgentEntry(entry: Record<string, unknown>, next: Record<string, unknown>): void {
  if (Object.keys(next).length > 0) entry.vcMeetingAgent = next;
  else delete entry.vcMeetingAgent;
}

function refreshLocalVcMeetingAgentConfig(appId: string): void {
  try {
    const latest = loadBotConfigs().find(bot => bot.larkAppId === appId);
    const live = getBot(appId);
    live.config.vcMeetingAgent = latest?.vcMeetingAgent as VcMeetingAgentConfig | undefined;
  } catch {
    // This dashboard process may not host the target bot daemon.
  }
}

/** Map appId → persisted Feishu-probed botName from bots-info.json (offline
 *  bots keep a friendly name in the dashboard). Best-effort; empty on any error. */
function readPersistedBotNames(): Map<string, string> {
  const out = new Map<string, string>();
  try {
    const fp = join(config.session.dataDir, 'bots-info.json');
    if (!existsSync(fp)) return out;
    const entries = JSON.parse(readFileSync(fp, 'utf8')) as Array<{ larkAppId?: string; botName?: string | null }>;
    if (!Array.isArray(entries)) return out;
    for (const e of entries) {
      if (typeof e?.larkAppId === 'string' && typeof e?.botName === 'string' && e.botName.trim()) {
        out.set(e.larkAppId, e.botName.trim());
      }
    }
  } catch { /* best-effort */ }
  return out;
}

function vcMeetingConsumerProfilesApiDeps(): VcMeetingConsumerProfilesApiDeps {
  // Persisted Feishu-probed names, so an OFFLINE bot still shows its friendly
  // name in the agent dropdown instead of falling back to the raw appId. The
  // live registry only knows online bots; bots-info.json is written when a bot
  // is probed and survives across restarts. Built once per deps construction.
  const persistedBotNames = readPersistedBotNames();
  return {
    readCatalog: readVcMeetingSharedConsumerCatalogSnapshot,
    updateCatalog: updateVcMeetingSharedConsumerCatalog,
    loadBotConfigs,
    effectiveDefaultWorkingDir,
    onlineBotName: appId => registry.getByAppId(appId)?.botName ?? persistedBotNames.get(appId),
    isOnline: appId => !!registry.getByAppId(appId),
    adapterReliableTurnTerminal: (cliId, cliPathOverride) => {
      if (!cliId) return false;
      try {
        return createCliAdapterSync(cliId as CliId, cliPathOverride).reliableTurnTerminal === true;
      } catch {
        return false;
      }
    },
    managedSideEffectEligible: bot => evaluateVcMeetingConsumerIsolation({
      sandbox: bot.sandbox,
      platform: process.platform,
      backendType: resolvePairedSpawnBackendType(
        bot.cliId ?? config.daemon.cliId,
        undefined,
        bot.backendType,
        config.daemon.backendType,
      ),
    }).ok,
    sandboxIsolated: bot => {
      const decision = evaluateVcMeetingConsumerIsolation({
        sandbox: bot.sandbox,
        platform: process.platform,
        backendType: resolvePairedSpawnBackendType(
          bot.cliId ?? config.daemon.cliId,
          undefined,
          bot.backendType,
          config.daemon.backendType,
        ),
      });
      return decision.ok && decision.isolated;
    },
    reloadDaemons: reloadVcMeetingBotConfigOnDaemons,
    applyBotOutputPolicy: async (patch) => {
      const res = await rmwBotEntry(patch.appId, (entry) => {
        const vc = (entry.vcMeetingAgent && typeof entry.vcMeetingAgent === 'object' && !Array.isArray(entry.vcMeetingAgent))
          ? entry.vcMeetingAgent
          : {};
        // 「接收会议事件」开关。VC 对每个连着飞书的 bot 默认可用，`enabled: false`
        // 才是显式退出——所以打开时删掉这个 key 回到默认，而不是写 `enabled: true`。
        if (patch.vcEnabled) delete vc.enabled;
        else vc.enabled = false;
        const consumer = (vc.meetingConsumer && typeof vc.meetingConsumer === 'object' && !Array.isArray(vc.meetingConsumer))
          ? vc.meetingConsumer
          : {};
        if (patch.textOutputPolicy === null) delete consumer.textOutputPolicy;
        else consumer.textOutputPolicy = patch.textOutputPolicy;
        if (patch.voiceOutputPolicy === null) delete consumer.voiceOutputPolicy;
        else consumer.voiceOutputPolicy = patch.voiceOutputPolicy;
        // per-bot 默认角色:null/空 = 跟随全局默认(删 key);否则写 catalogDefaultConsumerId。
        if (patch.catalogDefaultConsumerId === null || patch.catalogDefaultConsumerId === '') {
          delete consumer.catalogDefaultConsumerId;
        } else {
          consumer.catalogDefaultConsumerId = patch.catalogDefaultConsumerId;
        }
        if (Object.keys(consumer).length > 0) vc.meetingConsumer = consumer;
        else delete vc.meetingConsumer;
        const rtv = (vc.realtimeVoice && typeof vc.realtimeVoice === 'object' && !Array.isArray(vc.realtimeVoice))
          ? vc.realtimeVoice
          : {};
        // 实时语音能力默认开启（未配 = 开）。所以「勾上」= 回到默认，删掉 enabled key
        // （避免写死 true，与其它默认字段的处理一致）；「取消勾选」= 必须写显式 false
        // 才能真正关掉（保留其它 realtimeVoice 设置如采样率）。
        if (patch.realtimeVoiceEnabled) {
          delete rtv.enabled;
        } else {
          rtv.enabled = false;
        }
        if (Object.keys(rtv).length > 0) vc.realtimeVoice = rtv;
        else delete vc.realtimeVoice;
        entry.vcMeetingAgent = vc;
        return { write: true, result: undefined };
      });
      return res.ok ? { ok: true } : { ok: false, reason: res.reason };
    },
  };
}

async function reloadVcMeetingBotConfigOnDaemons(appIds: string[]): Promise<void> {
  const unique = [...new Set(appIds.filter(Boolean))];
  for (const appId of unique) refreshLocalVcMeetingAgentConfig(appId);
  await Promise.all(unique.map(async appId => {
    const d = registry.getByAppId(appId);
    if (!d) return;
    await fetchDaemonIpc(d.ipcPort, '/api/bot-config/reload', {
      method: 'POST',
      signal: AbortSignal.timeout(10_000),
    }).catch(() => undefined);
  }));
}

/**
 * Fetch the set of actually granted scopes for a bot app via Feishu Open API.
 * Used after automateOpenPlatformSetup to verify that VC meeting scopes were
 * actually applied (not just "requested").
 */
async function fetchGrantedScopesForBot(bot: { larkAppId: string; larkAppSecret: string; brand?: string; apiOnly?: boolean }): Promise<{ ok: true; granted: Set<string> } | { ok: false; error: string }> {
  // Core-only (apiOnly) bots have no real Feishu credentials — refuse the raw
  // token/application fetch outright rather than dialing the open platform with
  // a synthetic/empty secret. (Belt-and-suspenders: apiOnly is already excluded
  // from listener options, but a pre-existing VC config could still reach here.)
  if (bot.apiOnly === true) {
    return { ok: false, error: 'api_only_bot_has_no_feishu_credentials' };
  }
  const brand = bot.brand === 'lark' ? 'lark' : 'feishu';
  const openApi = larkHosts(brand).openApi;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 10_000);
  try {
    const tokenRes = await fetch(`${openApi}/open-apis/auth/v3/tenant_access_token/internal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: bot.larkAppId, app_secret: bot.larkAppSecret }),
      signal: ac.signal,
    });
    const tokenData = await tokenRes.json() as any;
    if (tokenData?.code !== 0 || typeof tokenData?.tenant_access_token !== 'string') {
      return { ok: false, error: `invalid_credentials: code=${tokenData?.code ?? '?'} msg=${tokenData?.msg ?? ''}` };
    }
    const infoRes = await fetch(
      `${openApi}/open-apis/application/v6/applications/${bot.larkAppId}?lang=zh_cn`,
      { headers: { Authorization: `Bearer ${tokenData.tenant_access_token}` }, signal: ac.signal },
    );
    const infoData = await infoRes.json() as any;
    if (infoData?.code === 99991672) {
      return { ok: false, error: 'missing application:application:self_manage' };
    }
    if (infoData?.code !== 0) {
      return { ok: false, error: `scope_check_failed: code=${infoData?.code ?? '?'} msg=${infoData?.msg ?? ''}` };
    }
    const scopesRaw: any[] =
      infoData.data?.app?.scopes
      ?? infoData.data?.application?.scopes
      ?? infoData.data?.scopes
      ?? [];
    const granted = new Set(
      scopesRaw.map((s: any) => typeof s === 'string' ? s : s?.scope).filter(Boolean) as string[],
    );
    return { ok: true, granted };
  } catch (err: any) {
    return {
      ok: false,
      error: ac.signal.aborted ? 'timeout' : `${err?.message ?? err}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Validate that a bot has the required VC meeting scopes granted.
 * Checks both VC_MEETING_FEATURE_SCOPES and (if realtimeVoice is enabled)
 * VC_MEETING_REALTIME_VOICE_SCOPES.
 */
async function validateVcMeetingScopesForBot(bot: { larkAppId: string; larkAppSecret: string; brand?: string; vcMeetingAgent?: any }): Promise<{ ok: true } | { ok: false; error: string }> {
  const result = await fetchGrantedScopesForBot(bot);
  if (!result.ok) return { ok: false, error: result.error };
  const needsRealtime = bot.vcMeetingAgent?.realtimeVoice?.enabled === true;
  const required = needsRealtime
    ? [...VC_MEETING_FEATURE_SCOPES, ...VC_MEETING_REALTIME_VOICE_SCOPES]
    : VC_MEETING_FEATURE_SCOPES;
  const missing = required.filter(s => !result.granted.has(s.name));
  if (missing.length > 0) {
    return { ok: false, error: `缺少权限: ${missing.map(s => s.name).join(', ')}` };
  }
  return { ok: true };
}

/**
 * Wait for FeishuLoginManager to produce a QR code after start().
 * The start() method returns immediately with status='starting'; the QR code
 * is set asynchronously in the onQrCode callback. Poll until qrDataUrl appears
 * or we hit the timeout.
 */
async function waitForFeishuLoginQr(timeoutMs = 8_000, intervalMs = 200): Promise<string | null> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const snap = feishuLogin.get();
    if (snap?.qrDataUrl) return snap.qrDataUrl;
    // Also stop waiting if login already failed
    if (snap?.status === 'failed' || snap?.status === 'success') return null;
    await new Promise(r => setTimeout(r, intervalMs));
  }
  return null;
}

/**
 * 让某个 bot 具备「收会议事件 + 以 bot 身份入会」的开放平台前置条件。
 *
 * 这是全局「会议事件接收 Bot」下拉退役后留下的唯一实质工作：那个下拉真正干的事
 * 不是「选一个人来监听」（daemon 侧早已改成谁收到谁处理），而是顺手替被选中的 bot
 * 开权限、订事件、装 larkCliProfile。所以下拉删掉，这段保留，改成按 bot 手动触发
 * 的一次性动作（Dashboard 的「配置权限」按钮）——不能在勾选开关时自动跑：
 * 「接收会议事件」默认就是开的，压根没有 off→on 的跃迁可挂；也不能在页面加载时
 * 对整个 fleet 跑，47 个 bot 就是 94 次开放平台调用。
 *
 * 与旧实现的关键差异：这里**只做前置条件**，绝不再往 meetingConsumer 里塞默认角色。
 * 旧的 seedVcMeetingDefaultConsumerProfile 会把「另一个 bot」的 appId 焊进预设，
 * 正是「拉 A 进会却把 B 拉进群」的源头。
 */
async function preflightVcMeetingBot(appId: string): Promise<{ ok: true } | { ok: false; error: string; feishuLoginQr?: string }> {
  const targetAppId = appId?.trim() || null;
  if (!targetAppId) return { ok: false, error: 'vcMeetingBot_preflight_missing_appId' };

  let bots: BotConfig[];
  try {
    bots = loadBotConfigs();
  } catch (err: any) {
    return { ok: false, error: `vcMeetingBot_preflight_config_unavailable: ${err?.message ?? err}` };
  }
  const bot = bots.find(b => b.larkAppId === targetAppId);
  if (!bot) return { ok: false, error: 'vcMeetingBot_preflight_bot_not_found' };
  // apiOnly bot 结构上就收不到飞书事件，别让它把 automateOpenPlatformSetup /
  // 开放平台裸 fetch 跑起来（写边界拦住，手搓 POST 也进不去）。
  if (bot.apiOnly === true) return { ok: false, error: 'vcMeetingBot_preflight_api_only' };

  // VC bot 入会命令(vc +meeting-join/events/message-send --as bot)要求
  // lark-cli >= MIN_LARK_CLI_VERSION_FOR_VC_BOT；更老的版本会以
  // "this command only supports: user" 静默拒绝 `--as bot`。
  const larkCli = checkLarkCliVersion();
  if (!larkCli) {
    return { ok: false, error: 'vcMeetingBot_preflight_larkCli_not_found: 未检测到 lark-cli，请先安装 `npm i -g @larksuite/cli`' };
  }
  if (!larkCli.meetsVcBotRequirement) {
    return {
      ok: false,
      error: `vcMeetingBot_preflight_larkCli_too_old: 当前 lark-cli ${larkCli.version} 不支持 VC bot 入会，需要 >= ${MIN_LARK_CLI_VERSION_FOR_VC_BOT}。请运行 \`npm i -g @larksuite/cli@latest\` 升级`,
    };
  }

  // 开放平台自动化只支持 feishu.cn；`brand: 'lark'` 的 bot 跳过自动化，但仍然校验
  // 权限是否已具备，免得报「配置好了」其实收不到事件。
  const brand = bot.brand === 'lark' ? 'lark' : 'feishu';
  if (brand === 'lark') {
    logger.info(`[vc-agent] skipping open-platform automation for lark-brand bot ${targetAppId} (feishu.cn only)`);
    const scopeCheck = await validateVcMeetingScopesForBot(bot);
    if (!scopeCheck.ok) {
      return { ok: false, error: `vcMeetingBot_preflight_missing_scopes: ${scopeCheck.error}` };
    }
  } else {
    try {
      const result = await automateOpenPlatformSetup({
        appId: targetAppId,
        brand,
        maxWaitMs: 5_000,
        onStatus: (msg) => logger.info(`[vc-agent] scope auto-import: ${msg}`),
      });
      if (result.ok) {
        logger.info(`[vc-agent] auto-imported ${result.scopeCount} scopes, subscribed ${result.subscribedEventCount} events for bot ${targetAppId}`);
        if (result.scopeWarning) logger.warn(`[vc-agent] scope import warning: ${result.scopeWarning}`);
        if (result.eventWarning) logger.warn(`[vc-agent] event subscription warning: ${result.eventWarning}`);
        // 自动化「成功」不等于权限真开了：internal scope/update 可能静默跳过本租户
        // 不可用的 scope。必须回读一次，否则会给用户一个「已配置」的假绿灯。
        const scopeCheck = await validateVcMeetingScopesForBot(bot);
        if (!scopeCheck.ok) {
          return {
            ok: false,
            error: `vcMeetingBot_preflight_missing_scopes_after_auto: ${scopeCheck.error}。请到开放平台手动开通 VC 会议权限后重试。`,
          };
        }
        // 事件订阅同样关键：缺任一 VC 事件都收不到会议邀请(用 missingVcEvents 判定,
        // 总 count 无法区分缺的是不是 VC)。
        const eventGateError = vcListenerEventGateError(result);
        if (eventGateError) {
          return {
            ok: false,
            error: `vcMeetingBot_preflight_event_subscribe_failed: ${eventGateError}，bot 无法接收会议邀请事件。请到开放平台手动订阅 VC 会议事件后重试。`,
          };
        }
      } else {
        const reason = result.reason;
        // 登录/会话类失败是硬失败：没有有效的开放平台会话就无从自动配置，直接把
        // 扫码二维码回给前端。
        if (
          reason === 'missing_session'
          || reason === 'invalid_session'
          || reason === 'missing_csrf'
          || reason === 'qr_expired'
          || reason === 'timeout'
          || reason === 'login_failed'
        ) {
          feishuLogin.start();
          // start() 立刻返回 status='starting'，二维码是在 onQrCode 里异步塞进去的；
          // 稍等一下拿到再回，前端才能直接内联展示而不是只给一句错误。
          const qrDataUrl = await waitForFeishuLoginQr();
          const hint = '请用飞书扫码完成开放平台登录，登录后重新点「配置权限」即可自动开通';
          return {
            ok: false,
            error: `vcMeetingBot_preflight_scope_auto_import_failed: ${reason}: ${hint}`,
            feishuLoginQr: qrDataUrl ?? undefined,
          };
        }
        // 非登录类失败(网络、api_error 等)是 best-effort，不因此判死；但权限与事件
        // 订阅仍然要回读确认，否则等于谎报配置成功。
        logger.warn(`[vc-agent] open-platform automation failed for ${targetAppId}: ${reason}: ${result.message}`);
        const scopeCheck = await validateVcMeetingScopesForBot(bot);
        if (!scopeCheck.ok) {
          // 「应用正在审核中」时**手动也开不了**：审核期间开放平台锁定配置写入，连
          // scope/update 都拒（实测 code=10046）。给「请手动开通」这种做不到的建议
          // 比不给更糟，所以这条单独措辞成「等审批通过」。
          // ⚠️ 不说「等审批通过」：触发审批通常意味着有配置不合规，那一版不会自己通过。
          const advice = reason === 'app_under_review'
            ? '该应用有一个版本卡在飞书审核中，配置写入被锁（手动开通同样会被拒）。触发审批通常说明有配置不合规'
              + '（最常见：权限的数据范围默认成「全部/全员」）；需人工到开放平台看审批详情、修掉不合规项后撤回该版本重提，再重试。'
            : '请手动开通后重试。';
          return {
            ok: false,
            error: `vcMeetingBot_preflight_missing_scopes: ${scopeCheck.error}。自动化配置失败(${reason})且权限未满足，${advice}`,
          };
        }
        const eventGateError = vcListenerEventGateError(result);
        if (eventGateError) {
          return {
            ok: false,
            error: `vcMeetingBot_preflight_event_subscribe_failed: ${eventGateError}，bot 无法接收会议邀请事件。自动化配置失败(${reason})，请手动订阅 VC 会议事件后重试。`,
          };
        }
      }
    } catch (err: any) {
      logger.warn(`[vc-agent] open-platform automation error for ${targetAppId}: ${err?.message ?? err}`);
    }
  }

  // 唯一的落盘：补一个默认 larkCliProfile。既不写 enabled(默认就是接收)，也不碰
  // meetingConsumer——角色预设归 fleet 共享目录管，这里不产生任何 per-bot 预设。
  let changed = false;
  try {
    const path = requireConfigPath();
    await withFileLock(path, async () => {
      const raw = await readRawConfig(path);
      const idx = findEntryIndex(raw, targetAppId);
      if (idx < 0) throw new Error('bot_not_in_config');
      const entry = raw[idx] as Record<string, unknown>;
      const next = normalizeVcMeetingAgentRecord(entry.vcMeetingAgent);
      if (next.larkCliProfile) return;
      next.larkCliProfile = targetAppId;
      compactVcMeetingAgentEntry(entry, next);
      // 落盘前整份校验，和 daemon bootstrap 保持对称，避免 Dashboard 写出非法 registry。
      parseBotConfigsFromText(JSON.stringify(raw));
      await writeRawConfigAtomic(path, raw);
      changed = true;
    });
  } catch (err: any) {
    return { ok: false, error: `vcMeetingBot_preflight_config_write_failed: ${err?.message ?? err}` };
  }

  if (changed) await reloadVcMeetingBotConfigOnDaemons([targetAppId]);

  return { ok: true };
}

function resolveDashboardSettings(): ResolvedDashboardSettings {
  const global = readGlobalConfig();
  const dashboard = global.dashboard ?? {};
  const codexNotifier = resolveCodexNotifierConfig();
  const codexNotifierBots = codexNotifierBotOptions();
  const codexNotifierState = readCodexNotifierWorkerState(config.session.dataDir);
  const larkCli = checkLarkCliVersion();
  return {
    groupNamePrefix: global.groupNamePrefix ?? '',
    publicReadOnly: dashboard.publicReadOnly ?? config.dashboard.publicReadOnly,
    openTerminalInFeishu: dashboard.openTerminalInFeishu === true,
    enableLocalCliOpen: dashboard.enableLocalCliOpen === true,
    localCliOpenMode: dashboard.localCliOpenMode ?? 'attach',
    chatBotDiscovery: dashboard.chatBotDiscovery !== false, // default ON
    herdrTraexPlugin: {
      enabled: dashboard.herdrTraexPlugin?.enabled === true,
      source: dashboard.herdrTraexPlugin?.source ?? '',
      ref: dashboard.herdrTraexPlugin?.ref ?? '',
      recommendedSource: TRAEX_RECOMMENDED_SOURCE,
      recommendedRef: TRAEX_RECOMMENDED_REF,
    },
    codexRpcInput: dashboard.codexRpcInput === true, // default OFF until live-verified
    // default ON — only an explicit stored false disables (matches config.ts getter)
    bypassCodexHookTrust: dashboard.bypassCodexHookTrust !== false,
    codexNotifier: {
      enabled: codexNotifier.enabled,
      targetBotAppId: codexNotifier.targetBotAppId ?? null,
      notifyWhen: codexNotifier.notifyWhen,
      platformSupported: process.platform === 'darwin',
      hookInstalled: isCodexNotifierHookInstalled(),
      botOptions: codexNotifierBots,
      targetDaemonOnline: !!codexNotifier.targetBotAppId
        && registry.list().some(bot => bot.larkAppId === codexNotifier.targetBotAppId),
      pendingCount: listCodexNotifierOutbox(config.session.dataDir).length,
      workerOnline: isCodexNotifierWorkerStateFresh(codexNotifierState),
      lastError: codexNotifierState?.lastError ?? null,
    },
    hostOverloadAlert: {
      enabled: global.hostOverloadAlert?.enabled === true,
      targetBotAppId: global.hostOverloadAlert?.targetBotAppId ?? null,
      enterLoadRatio: global.hostOverloadAlert?.enterLoadRatio ?? DEFAULT_OVERLOAD_THRESHOLDS.enterLoadRatio,
      enterMemUsedFrac: global.hostOverloadAlert?.enterMemUsedFrac ?? DEFAULT_OVERLOAD_THRESHOLDS.enterMemUsedFrac,
      botOptions: hostOverloadAlertBotOptions(),
      targetDaemonOnline: !!global.hostOverloadAlert?.targetBotAppId
        && registry.list().some(bot => bot.larkAppId === global.hostOverloadAlert?.targetBotAppId),
    },
    noVisibleOutputHint: dashboard.noVisibleOutputHint === true, // default OFF; opt-in anti-resend guidance
    vcMeetingAgent: {
      enabled: global.vcMeetingAgent?.enabled !== false,
      larkCliVersion: larkCli?.version ?? null,
      larkCliMeetsRequirement: larkCli?.meetsVcBotRequirement ?? false,
      larkCliMinVersion: MIN_LARK_CLI_VERSION_FOR_VC_BOT,
    },
    repoPickerMode: global.repoPickerMode ?? 'all',
    maintenance: global.maintenance ?? {},
    localDevInstall: isLocalDevInstall(),
    // Same predicate the save-time validation uses (resolveAutoUpdateSupport), so
    // the UI can never render the toggle disabled while the backend would accept
    // it — or the reverse. A plain `tryResolveGlobalInstallPlan()` here reported
    // false for every compiled binary, because its package root is "/".
    autoUpdateSupported: lastSuccessfulUpdatePlan !== undefined || isAutoUpdateSupportedInstall(),
    whiteboard: { enabled: global.whiteboard?.enabled === true },
    workflow: { enabled: global.workflow?.enabled === true }, // default OFF
    remoteAccess: global.remoteAccess === true,
    oauthRedirectBase: global.oauthRedirectBase ?? null,
    scheduleTimeZone: global.scheduleTimeZone ?? null,
    hostTimeZone: hostLocalTimeZone(),
    effectiveScheduleTimeZone: scheduleTimeZone(),
  };
}

// Single shared deps object for `applySettingsWrite` — both the browser
// `PUT /api/settings` route and (PR2 C6) the HMAC-gated `PUT /__daemon/settings-write`
// route call through this so error codes / merge semantics stay identical.
async function reloadLocaleOnAllDaemons(): Promise<void> {
  await Promise.all(registry.list().map(d =>
    fetchDaemonIpc(d.ipcPort, '/api/locale/reload', { method: 'POST' }).catch(() => undefined),
  ));
}
const settingsWriteApplierDeps = defaultSettingsWriteApplierDeps(resolveDashboardSettings, reloadLocaleOnAllDaemons);
settingsWriteApplierDeps.validateCodexNotifierTargetBotAppId = validateCodexNotifierTargetBotAppId;
settingsWriteApplierDeps.validateHostOverloadAlertTargetBotAppId = validateHostOverloadAlertTargetBotAppId;

/** Helper to render a {status, body} HandlerResult through `res`. */
function writeHandlerResult(res: import('node:http').ServerResponse, result: GroupsHandlerResult): void {
  const headers = { 'content-type': 'application/json', ...(result.headers ?? {}) };
  res.writeHead(result.status, headers);
  res.end(typeof result.body === 'string' ? result.body : JSON.stringify(result.body));
}

// Shared deps for groups-action-helpers — both the browser
// `/api/groups/*` routes and (PR2 C6) the HMAC-gated `/__daemon/groups/*`
// routes use these helpers so response shapes / cascade-close semantics
// stay identical.
const groupsActionDeps: GroupsActionDeps = {
  registryList: () => registry.list(),
  registryGetByAppId: (id) => registry.getByAppId(id),
  proxyToDaemon,
  closeSessionsMatching,
  fetch: fetchDaemonUrl,
  invalidateGroups: () => groupsMatrixSnapshot.invalidate(),
};

// ─── PR2 C8: Route B internal API (`/__daemon/*`) ───────────────────────────
// HMAC + loopback + ts ±60s + nonce TTL, signed-request envelope = full
// (ts, nonce, method, pathWithQuery, sha256(body)). Reuses `.dashboard-secret`
// for the HMAC key — the same secret the `/__cli/*` protocol uses — but the
// signing material is wider so a CLI signature cannot be replayed here and
// vice versa (different protocols, same secret, no cross-replay).
//
// SECRET fail-closed: `loadOrCreateSecret()` returns a 32-byte base64url
// string and never empty; we still guard below at server-startup time.
if (!SECRET || SECRET.length === 0) {
  logger.error('[dashboard] SECRET is empty — refusing to mount /__daemon/* dispatcher');
  process.exit(1);
}

const daemonInternalApi = createDaemonInternalApi({
  secret: SECRET,
  getSessions: () => aggregator.getSessions(),
  getSchedules: () => aggregator.getSchedules(),
  resolveDashboardSettings,
  buildGroupsMatrix: () => groupsMatrixSnapshot.get(),
  settingsApplierDeps: settingsWriteApplierDeps,
  groupsActionDeps,
  proxyToDaemon,
  ownerOf: (sid) => aggregator.ownerOf(sid),
  scheduleOwnerOf: (id) => aggregator.scheduleOwnerOf(id),
  scheduleExists: (id) => aggregator.scheduleExists(id),
  sessionExists: (sessionId) => aggregator.sessionExists(sessionId),
});

class DashboardJsonBodyTooLargeError extends Error {}

async function readJsonBody(req: IncomingMessage, maxBytes?: number): Promise<unknown> {
  const declared = req.headers['content-length'];
  if (maxBytes !== undefined && typeof declared === 'string' && /^\d+$/.test(declared)
    && Number(declared) > maxBytes) {
    req.resume();
    throw new DashboardJsonBodyTooLargeError('request body too large');
  }
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const raw of req) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    totalBytes += chunk.byteLength;
    if (maxBytes !== undefined && totalBytes > maxBytes) {
      req.resume();
      throw new DashboardJsonBodyTooLargeError('request body too large');
    }
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  return raw ? JSON.parse(raw) : {};
}

/** Fast in-process guard against double-clicks within this dashboard process.
 *  Cross-process serialization against the maintenance auto-update (a different
 *  process) is handled separately by the shared file lock in the run route. */
let updateInFlight = false;
// The dashboard process survives while pnpm swaps its versioned realpath. Keep
// the successful plan (including its stable package root) so follow-up status,
// update, and restart requests do not reuse the removed old runtime realpath.
let lastSuccessfulUpdatePlan: GlobalInstallPlan | undefined;

// Local-dev counterpart: the checkout a successful /api/update/run built, and
// its post-build HEAD. Pinned so the follow-up /api/update/restart applies THIS
// build's target — not a wrapper that a concurrent `pnpm use:here` in another
// worktree may have re-pointed between the two requests (run builds B, wrapper
// flips to C, restart would otherwise restart C or fall back to A). Cleared
// once consumed by a restart. A plain "restart" (no preceding run) still
// resolves the wrapper live.
let pendingLocalDevRestart: { dir: string; head: string } | undefined;

// Cache the upstream version/changelog lookups so the nav-badge check + the
// Settings card don't hammer the npm registry / GitHub on every page load.
// GitHub's unauthenticated API is only 60 req/h per IP, so caching the changelog
// also keeps us from exhausting it. Failures cache briefly so they self-heal.
const LATEST_TTL_MS = 30 * 60_000;
const CHANGELOG_TTL_MS = 15 * 60_000;
const FAILURE_TTL_MS = 60_000;
type LatestVersionCache = { value: string | null; at: number; lookupOk: boolean };
let latestVersionCache: LatestVersionCache | null = null;
let latestVersionLookupInFlight: Promise<LatestVersionCache> | null = null;
let changelogCache: { key: string; value: ChangelogResult; at: number } | null = null;
let rollbackVersionCache: { current: string; value: RollbackVersionsResult; at: number } | null = null;
let rollbackVersionLookupInFlight: { current: string; value: Promise<RollbackVersionsResult> } | null = null;

async function cachedLatestVersion(force = false): Promise<LatestVersionCache> {
  const now = Date.now();
  const ttl = latestVersionCache?.lookupOk ? LATEST_TTL_MS : FAILURE_TTL_MS;
  if (!force && latestVersionCache && now - latestVersionCache.at < ttl) return latestVersionCache;
  // When forcing a refresh, don't piggy-back on an in-flight lookup that may
  // have started before the user asked for a refresh — start a fresh one so
  // the result reflects the current upstream state, not a stale query.
  if (!force && latestVersionLookupInFlight) return latestVersionLookupInFlight;

  const lookup = (async () => {
    const value = await fetchLatestVersion();
    latestVersionCache = {
      value: value ?? latestVersionCache?.value ?? null,
      at: Date.now(),
      lookupOk: value !== null,
    };
    return latestVersionCache;
  })();
  latestVersionLookupInFlight = lookup;
  try {
    return await lookup;
  } finally {
    if (latestVersionLookupInFlight === lookup) latestVersionLookupInFlight = null;
  }
}

async function cachedChangelog(current: string, now = Date.now()): Promise<ChangelogResult> {
  const ttl = changelogCache?.value.ok ? CHANGELOG_TTL_MS : FAILURE_TTL_MS;
  if (changelogCache && changelogCache.key === current && now - changelogCache.at < ttl) return changelogCache.value;
  const value = await fetchReleasesSince(current);
  changelogCache = { key: current, value, at: now };
  return value;
}

async function cachedRollbackVersions(current: string, force = false): Promise<RollbackVersionsResult> {
  const now = Date.now();
  const ttl = rollbackVersionCache?.value.ok ? LATEST_TTL_MS : FAILURE_TTL_MS;
  if (!force && rollbackVersionCache?.current === current && now - rollbackVersionCache.at < ttl) {
    return rollbackVersionCache.value;
  }
  if (rollbackVersionLookupInFlight?.current === current) return rollbackVersionLookupInFlight.value;

  const lookup = (async () => {
    const result = await fetchRollbackVersions(current);
    const previous = rollbackVersionCache?.current === current ? rollbackVersionCache.value.versions : [];
    const value = result.ok ? result : { ok: false, versions: previous };
    rollbackVersionCache = { current, value, at: Date.now() };
    return value;
  })();
  rollbackVersionLookupInFlight = { current, value: lookup };
  try {
    return await lookup;
  } finally {
    if (rollbackVersionLookupInFlight?.value === lookup) rollbackVersionLookupInFlight = null;
  }
}

function currentInstalledVersion(): string {
  if (!lastSuccessfulUpdatePlan) return resolveCurrentVersion();
  const version = botmuxVersionAt(lastSuccessfulUpdatePlan.activePackageRoot);
  return version === '0.0.0' ? resolveCurrentVersion() : version;
}

/**
 * Local-dev update: git-clean check (fail closed) → git pull --ff-only →
 * pnpm build, all in the checkout the global wrapper points at. Mirrors the CLI
 * `cmdUpgradeLocalDev` via the shared local-dev-update helpers. Returns the
 * checkout dir, its version before/after, and whether HEAD advanced; the caller
 * applies the restart through the existing lease/intent path. A successful
 * build always requires a restart to take effect (dist/ is regenerated), which
 * the caller signals independently of `changed`. Rejects with a stable `code`
 * on the recoverable, UI-actionable failures.
 */
async function runLocalDevUpdate(): Promise<{ dir: string; changed: boolean; oldVersion: string; newVersion: string; head: string }> {
  const dir = resolveLocalDevCheckoutDir();
  if (!isGitWorktree(dir)) {
    throw Object.assign(new Error(`${dir} is not a git worktree`), { code: 'not_a_worktree', dir });
  }
  let status: string;
  try {
    status = gitPorcelainStatus(dir);
  } catch (e) {
    throw Object.assign(new Error(e instanceof Error ? e.message : String(e)), { code: 'git_status_failed', dir });
  }
  if (status) {
    throw Object.assign(new Error('working tree has uncommitted changes'), {
      code: 'dirty_worktree', dir, status,
    });
  }
  const before = gitHeadSha(dir);
  const oldVersion = resolveCurrentVersionAt(dir);
  for (const { command, args } of localDevUpdateSteps()) {
    await runLocalDevStep(dir, command, args);
  }
  const after = gitHeadSha(dir);
  const newVersion = resolveCurrentVersionAt(dir);
  return { dir, changed: before === '' || after === '' ? true : before !== after, oldVersion, newVersion, head: after };
}

/**
 * Attach to one daemon: hydrate its sessions/schedules into the aggregator,
 * THEN open the SSE subscription.
 *
 * The subscription runs a snapshot barrier (subscribeDaemon's `onConnected`):
 * after every stream establishment — the first included — and BEFORE any
 * frame is read, we install a fresh authoritative snapshot while incoming
 * frames stay queued in the stream; frames then apply on top in order. This
 * gives two guarantees at once:
 *
 * 1. No reverse clobber: the barrier snapshot is installed before any frame
 *    is applied, so a slow snapshot response can never overwrite state that
 *    a faster SSE event already delivered (a naive post-subscribe hydrate
 *    would).
 * 2. No forward gap: events fired between step 1 below and the stream
 *    handshake are picked up by the barrier snapshot, and events missed
 *    during a drop are recovered by the barrier re-run on reconnect.
 *
 * The blocking hydrate in step 1 still matters: it populates the cache
 * before the dashboard starts serving, and keeps a daemon's last-known
 * state visible even if its SSE stream never connects.
 *
 * Idempotent: a second call for the same daemon while one is in flight is a
 * no-op; the subscription itself is installed once.
 */
async function attachDaemon(d: import('./dashboard/registry.js').DaemonInfo): Promise<void> {
  if (attaching.has(d.larkAppId)) return;
  attaching.add(d.larkAppId);
  try {
    // 1. Blocking snapshot (see above)
    try {
      const [sRes, schRes] = await Promise.all([
        fetchDaemonIpc(d.ipcPort, '/api/sessions'),
        fetchDaemonIpc(d.ipcPort, '/api/schedules'),
      ]);
      const s = await sRes.json() as { sessions: any[] };
      const sch = await schRes.json() as { schedules: any[] };
      const rows = (s.sessions ?? []).map((row) => (
        d.botAvatarUrl ? { ...row, botAvatarUrl: d.botAvatarUrl } : row
      ));
      aggregator.hydrateSessions(d.larkAppId, rows);
      for (const row of rows) sessionPresentation.schedule(d.larkAppId, row);
      aggregator.hydrateSchedules(d.larkAppId, sch.schedules ?? []);
    } catch (e: any) {
      logger.warn(`[dashboard] hydrate ${d.larkAppId}: ${e.message ?? e}`);
    }
    // 2. Open SSE subscription if not already (idempotent). The barrier
    //    below runs inside subscribeDaemon, after the stream is established.
    if (!subs.has(d.larkAppId)) {
      subs.set(
        d.larkAppId,
        subscribeDaemon(d, aggregator, e =>
          logger.warn(`[aggregator] ${d.larkAppId}: ${e.message}`),
          (_url, init) => fetchDaemonIpc(d.ipcPort, '/api/events', init),
          // Snapshot barrier: install an authoritative snapshot before any
          // frame is read. Frames arriving during this fetch stay queued in
          // the stream and apply afterwards, so the snapshot can never
          // clobber fresher SSE state; on reconnect it recovers missed
          // events. The subscription signal is the generation arbitration:
          // if aborted mid-flight (daemon offline, newer generation), the
          // snapshot is discarded instead of clobbering the new generation.
          signal => reconcileDaemon(d, signal),
        ),
      );
    }
  } finally {
    attaching.delete(d.larkAppId);
  }
}

/**
 * Reconcile one daemon's snapshot into the aggregator (subscribeDaemon
 * barrier). Thin wrapper over reconcileDaemonSnapshot that also schedules
 * presentation enrichment for the session rows.
 */
async function reconcileDaemon(
  d: import('./dashboard/registry.js').DaemonInfo,
  signal: AbortSignal,
): Promise<void> {
  const snapshot = await reconcileDaemonSnapshot(d, aggregator, signal);
  if (!snapshot) return;
  for (const row of snapshot.sessions) {
    sessionPresentation.schedule(d.larkAppId, row);
  }
}

function syncSubscriptions(): void {
  const daemons = registry.list();
  const online = new Set(daemons.map(d => d.larkAppId));
  // Attach (hydrate + subscribe) any newly-online daemon. Fire-and-forget
  // because the registry callback is sync and the attach is per-daemon
  // independent.
  for (const d of daemons) {
    if (!subs.has(d.larkAppId)) {
      void attachDaemon(d);
    }
    // Push avatar changes in BOTH directions: gating on `d.botAvatarUrl` would
    // leave the stale image on every row when a bot's avatar is cleared.
    const avatar = d.botAvatarUrl ?? null;
    for (const row of aggregator.getSessions()) {
      if (row.larkAppId !== d.larkAppId || (row.botAvatarUrl ?? null) === avatar) continue;
      aggregator.applyEvent(d.larkAppId, {
        type: 'session.update',
        body: { sessionId: row.sessionId, patch: { botAvatarUrl: avatar } },
      });
    }
  }
  // Close subscriptions for daemons that went offline. Cache entries are
  // intentionally retained — the user may still want to see the last-known
  // state of those sessions/schedules in the dashboard.
  for (const [id, off] of subs) {
    if (!online.has(id)) { off(); subs.delete(id); }
  }
}

await registry.start();
registry.on(syncSubscriptions);
// Initial attach for every daemon already known. Run in parallel so a slow
// daemon doesn't block the others.
await Promise.all(registry.list().map(attachDaemon));

const codexNotifierAbort = new AbortController();
if (resolveCodexNotifierConfig().enabled) {
  try {
    installCodexNotifierHook();
  } catch (error) {
    logger.warn(`[codex-notifier] Hook reconcile failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
void runCodexNotifierWorkerSupervisor({
  dataDir: config.session.dataDir,
  signal: codexNotifierAbort.signal,
  emit: item => emitCodexNotifierOutboxItem(item, { signal: codexNotifierAbort.signal }),
  runProducer: signal => runCodexSideConversationMonitor({
    dataDir: config.session.dataDir,
    signal,
    logger,
  }),
  logger,
  onLeaseUnavailable: path => {
    logger.warn(`[codex-notifier] outbox worker 已由另一 Dashboard 持有，等待接管：${path}`);
  },
});

const resourceMonitor = createResourceMonitorService({
  intervalMs: 10_000,
  topSessionLimit: 30,
  sessionHistoryMs: 3 * 60 * 60_000,
  aggregateHistoryMs: 24 * 60 * 60_000,
  listSessions: () => {
    const names = new Map(registry.list().map(d => [d.larkAppId, d.botName] as const));
    return aggregator.getSessions()
      .filter(s => s.status !== 'closed')
      .map(s => toResourceMonitorSessionSeed(s, names.get(String(s.larkAppId ?? ''))));
  },
  listDaemons: () => buildResourceMonitorDaemonSeeds(loadBotConfigs(), registry.list()),
});
resourceMonitor.start();

// ─── Static frontend ─────────────────────────────────────────────────────────

// Path to the bundled frontend (sibling of dist/dashboard.js)
const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB_DIR = join(__dirname, 'dashboard-web');
const DEV_RELOAD_MARKER = join(WEB_DIR, '.botmux-dashboard-dev');
const DEV_RELOAD_VERSION = join(WEB_DIR, '.botmux-dashboard-reload');

/**
 * Request-relative asset path → on-disk path to read, or null when we have no
 * such asset. The ONE place that knows whether the frontend lives on disk
 * (source/npm) or inside the compiled binary's virtual filesystem.
 *
 * WHY: `WEB_DIR` is derived from `__dirname`, which in the compiled single binary
 * is the virtual `/$bunfs/root` — a path that does not exist on disk (the
 * documented CLAUDE.md `__dirname` hazard). Every asset request therefore missed
 * and fell through to the catch-all 404: the login redirect landed on `/` and
 * returned `{"error":"not_found_yet","path":"/"}`, so the Dashboard was entirely
 * unreachable from a compiled binary while working fine from npm/source.
 *
 * In compiled mode the assets are embedded instead (see
 * scripts/generate-dashboard-embed.mjs) and Bun renames each one with a content
 * hash, so the request path cannot address them directly — the generated manifest
 * supplies the mapping. Extensions are preserved, so MIME lookup is unaffected.
 *
 * Path traversal is handled differently per mode, and both are closed:
 *  • Embedded: the manifest is a build-time allowlist, so a traversal string
 *    simply misses. The lookup still goes through `hasOwnProperty` and a string
 *    check — a plain `map[rel]` answers `__proto__`/`constructor`/`toString` with
 *    inherited objects and functions (MEASURED), and handing one of those onward
 *    would only be stopped by a downstream throw. A security property should not
 *    rest on that.
 *  • On disk: the resolved path must stay inside WEB_DIR.
 *
 * Returns null (→ caller 404s) rather than throwing: an asset genuinely absent
 * from the bundle must stay a 404, exactly as a missing file on disk does.
 */
function resolveWebAsset(rel: string): string | null {
  const embedded = embeddedDashboardAssets();
  if (embedded) {
    if (!Object.prototype.hasOwnProperty.call(embedded, rel)) return null;
    const fp = embedded[rel];
    return typeof fp === 'string' && fp.length > 0 ? fp : null;
  }
  // Source / npm install: real directory on disk. Keep the path-traversal guard
  // here — `rel` is derived from the request.
  const fp = resolve(WEB_DIR, rel);
  const relToRoot = relative(resolve(WEB_DIR), fp);
  if (relToRoot === '..' || relToRoot.startsWith('..\\') || relToRoot.startsWith('../') || isAbsolute(relToRoot)) return null;
  return fp;
}

/**
 * The compiled binary's embedded-asset manifest, or null when running from
 * source/npm (where the frontend is a real directory on disk). Resolved once and
 * cached — including the null.
 *
 * HOW IT GETS HERE: the compiled build's plugin (scripts/bun-native-embed-plugin.mjs)
 * prepends a generated block of `import … with { type: 'file' }` statements to
 * this module and assigns the map to `globalThis.__BOTMUX_DASHBOARD_ASSETS__`.
 *
 * It has to arrive by build-time injection rather than an ordinary import:
 *  • A static `import './dashboard-web-embedded.js'` would make `tsc` (and a
 *    plain source checkout) demand a generated artifact that only exists after
 *    `bun run dashboard:bundle`.
 *  • A runtime `require()` of it does NOT work: Bun only embeds what it can trace
 *    statically, and MEASURED, a `createRequire` require of the manifest bundled
 *    1 module and embedded zero assets — the binary would still 404 everything.
 */
let embeddedAssetsCache: Record<string, string> | null | undefined;
function embeddedDashboardAssets(): Record<string, string> | null {
  if (embeddedAssetsCache !== undefined) return embeddedAssetsCache;
  const injected = (globalThis as Record<string, unknown>).__BOTMUX_DASHBOARD_ASSETS__;
  if (injected && typeof injected === 'object') {
    embeddedAssetsCache = injected as Record<string, string>;
  } else {
    embeddedAssetsCache = null;
    // A compiled binary with no injected manifest is a BUILD regression, not a
    // runtime condition to paper over. Say it loudly: the symptom is a 404 on
    // every page, which otherwise reads as a routing or auth bug.
    if (isStandaloneBinary()) {
      logger.error('[dashboard] compiled binary has no embedded frontend — every asset will 404');
    }
  }
  return embeddedAssetsCache;
}

/** Cache-busting stamp for embedded assets, whose `mtimeMs` is 0 (MEASURED).
 *  The baked release version changes with every binary, so it invalidates a
 *  browser's cached copy exactly when the binary changes. */
function embeddedAssetStamp(): string {
  return (bakedBinaryVersion() ?? 'embedded').replace(/[^\w.-]/g, '');
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.wasm': 'application/wasm',
  '.pck': 'application/octet-stream',
};

/** Stream an absolute file (used for HD2D cache binaries that live outside
 *  WEB_DIR). Callers pass only vetted paths from `hd2dAssetPath`. */
function serveFileAbs(res: ServerResponse, fp: string): boolean {
  let st;
  try { st = statSync(fp); } catch { return false; }
  if (!st.isFile()) return false;
  res.writeHead(200, {
    'content-type': MIME[extname(fp)] ?? 'application/octet-stream',
    'content-length': String(st.size),
  });
  createReadStream(fp).pipe(res);
  return true;
}

function dashboardDevReloadEnabled(): boolean {
  return process.env.BOTMUX_DASHBOARD_DEV_RELOAD === '1' || existsSync(DEV_RELOAD_MARKER);
}

function dashboardDevReloadVersion(): string | null {
  try {
    const st = statSync(DEV_RELOAD_VERSION);
    if (!st.isFile()) return null;
    return `${st.size}:${Math.floor(st.mtimeMs)}`;
  } catch {
    return null;
  }
}

function devReloadSnippet(): string {
  return `
<script type="module">
(() => {
  if (!('__BOTMUX_DASHBOARD_DEV_RELOAD__' in window)) {
    Object.defineProperty(window, '__BOTMUX_DASHBOARD_DEV_RELOAD__', { value: true });
    const source = new EventSource('/__dev/reload');
    source.addEventListener('reload', () => location.reload());
  }
})();
</script>`;
}

function injectDevReload(html: string): string {
  const snippet = devReloadSnippet();
  return html.includes('</body>') ? html.replace('</body>', `${snippet}\n</body>`) : `${html}\n${snippet}`;
}

function serveStatic(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  options: { injectHtml?: (html: string) => string } = {},
): boolean {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const fp = resolveWebAsset(rel);
  if (!fp) return false;
  // Asset-identity decisions below key off the REQUEST path, not `fp`: in the
  // compiled binary `fp` is a content-hash-renamed file in the virtual fs
  // (`chunks/x.js` → `/$bunfs/root/x-<hash>.js`), so `relative(WEB_DIR, fp)`
  // would classify every embedded asset wrongly — no chunk would be immutable
  // and index.html would never get its CSRF shell injected.
  const relToRoot = rel;
  try {
    const st = statSync(fp);
    if (!st.isFile()) return false;
    // Fixed entry filenames (index.html/app.js/style.css) need revalidation so
    // a deploy never serves new JS with old CSS. Lazy chunks are content-hashed
    // and can be cached immutably once the current app.js points at them.
    const immutableChunk = relToRoot.startsWith('chunks/') || relToRoot.startsWith('chunks\\');
    // `mtimeMs` is 0 for an embedded file (MEASURED), so the ETag would collapse
    // to size alone across a whole compiled release. Fold in the baked build
    // identity so a new binary always invalidates the browser's cache.
    const etagStamp = st.mtimeMs > 0 ? Math.floor(st.mtimeMs).toString(16) : embeddedAssetStamp();
    const etag = `W/"${st.size.toString(16)}-${etagStamp}"`;
    const isIndex = relToRoot === 'index.html';
    const devIndex = isIndex && dashboardDevReloadEnabled();
    // 注入 CSRF 票据的壳是每次请求现生成的：ETag 只反映磁盘文件，走 304 会让浏览
    // 器复用上一次（可能已随认证结束作废）的票据，所以这条路径不缓存、不 304。
    const dynamicIndex = devIndex || (isIndex && !!options.injectHtml);
    const headers: Record<string, string> = {
      'content-type': MIME[extname(fp)] ?? 'application/octet-stream',
      'cache-control': dynamicIndex ? 'no-store' : immutableChunk ? 'public, max-age=31536000, immutable' : 'no-cache',
      etag,
    };
    if (!dynamicIndex && req.headers['if-none-match'] === etag) {
      res.writeHead(304, headers);
      res.end();
      return true;
    }
    res.writeHead(200, headers);
    if (req.method === 'HEAD') {
      res.end();
      return true;
    }
    if (dynamicIndex) {
      let html = readFileSync(fp, 'utf8');
      if (options.injectHtml) html = options.injectHtml(html);
      if (devIndex) html = injectDevReload(html);
      res.end(html);
    } else {
      res.end(readFileSync(fp));
    }
    return true;
  } catch {
    return false;
  }
}

function serveMissingDashboardChunkModule(req: IncomingMessage, res: ServerResponse, pathname: string): boolean {
  if (!isDashboardChunkJsPath(pathname)) return false;
  const body = missingDashboardChunkModule();
  res.writeHead(200, {
    'content-type': 'application/javascript',
    'cache-control': 'no-store',
    'content-length': String(Buffer.byteLength(body)),
  });
  if (req.method === 'HEAD') {
    res.end();
    return true;
  }
  res.end(body);
  return true;
}

function dashboardEntriesForRecord(record: InstalledPluginRecord): PluginDashboardEntry[] {
  return record.contributions?.dashboard ?? [];
}

function listDashboardPluginEntries(): Array<{ pluginId: string; id: string; route: string; entry: string; url: string; displayName?: string; pinned: boolean }> {
  const pinned = new Set(normalizePluginIdList(readGlobalConfig().dashboard?.pinnedPlugins) ?? []);
  const out: Array<{ pluginId: string; id: string; route: string; entry: string; url: string; displayName?: string; pinned: boolean }> = [];
  for (const record of Object.values(readPluginRegistry().plugins)) {
    const dashboardEntries = dashboardEntriesForRecord(record);
    for (const entry of dashboardEntries) {
      out.push({
        pluginId: record.id,
        id: entry.id,
        route: entry.route,
        entry: entry.entry,
        url: `/plugins/${encodeURIComponent(record.id)}/${entry.entry}`,
        pinned: pinned.has(record.id),
        ...(record.manifest.displayName ? { displayName: record.manifest.displayName } : {}),
      });
    }
  }
  return out.sort((a, b) => a.pluginId.localeCompare(b.pluginId) || a.id.localeCompare(b.id));
}

function servePluginStatic(res: ServerResponse, pathname: string): boolean {
  const match = pathname.match(/^\/plugins\/([^/]+)\/(.+)$/);
  if (!match) return false;
  const pluginId = decodeURIComponent(match[1]);
  const relPath = decodeURIComponent(match[2]);
  const record = readPluginRegistry().plugins[pluginId];
  if (!record) return false;
  const dashboardEntries = dashboardEntriesForRecord(record);
  const allowed = dashboardEntries.some((entry) => {
    const base = entry.entry.replace(/\/[^/]*$/, '/');
    return relPath === entry.entry || relPath.startsWith(base);
  });
  if (!allowed) return false;
  try {
    return serveFileAbs(res, resolvePluginPath(pluginRuntimeDir(pluginId), relPath, 'dashboard_asset'));
  } catch {
    return false;
  }
}

function addPluginId(list: unknown, pluginId: string): string[] {
  const current = normalizePluginIdList(list) ?? [];
  return current.includes(pluginId) ? current : [...current, pluginId];
}

function removePluginId(list: unknown, pluginId: string): string[] {
  return (normalizePluginIdList(list) ?? []).filter(id => id !== pluginId);
}

function pluginEnabledPatch(body: unknown): boolean | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const enabled = (body as { enabled?: unknown }).enabled;
  return typeof enabled === 'boolean' ? enabled : null;
}

function pluginPinnedPatch(body: unknown): boolean | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const pinned = (body as { pinned?: unknown }).pinned;
  return typeof pinned === 'boolean' ? pinned : null;
}

function writeDashboardPluginPin(pluginId: string, pinned: boolean): void {
  const current = normalizePluginIdList(readGlobalConfig().dashboard?.pinnedPlugins) ?? [];
  const next = pinned ? addPluginId(current, pluginId) : removePluginId(current, pluginId);
  mergeDashboardConfig({ pinnedPlugins: next });
}

function requireInstalledPlugin(pluginId: string): InstalledPluginRecord | null {
  if (!isValidPluginId(pluginId)) return null;
  return readPluginRegistry().plugins[pluginId] ?? null;
}

function cleanPluginListForInstalled(list: unknown, installed: Set<string>): string[] {
  return (normalizePluginIdList(list) ?? []).filter(id => installed.has(id));
}

function latestGatewayDiagnostics(): Map<string, unknown[]> {
  const root = join(config.session.dataDir, 'mcp-gateway');
  const byPlugin = new Map<string, unknown[]>();
  if (!existsSync(root)) return byPlugin;
  let files: string[] = [];
  try {
    files = readdirSync(root)
      .filter(file => file.endsWith('.json'))
      .sort((a, b) => statSync(join(root, b)).mtimeMs - statSync(join(root, a)).mtimeMs)
      .slice(0, 50);
  } catch { return byPlugin; }
  const seen = new Set<string>();
  for (const file of files) {
    try {
      const parsed = JSON.parse(readFileSync(join(root, file), 'utf-8'));
      for (const server of Array.isArray(parsed?.servers) ? parsed.servers : []) {
        const pluginId = typeof server?.pluginId === 'string' ? server.pluginId : '';
        const serverName = typeof server?.serverName === 'string' ? server.serverName : '';
        if (!pluginId || !serverName) continue;
        const key = `${pluginId}\0${serverName}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const bucket = byPlugin.get(pluginId) ?? [];
        bucket.push({ ...server, sessionId: parsed.sessionId, generatedAt: parsed.generatedAt });
        byPlugin.set(pluginId, bucket);
      }
    } catch { /* one corrupt diagnostic must not hide the plugin page */ }
  }
  return byPlugin;
}

async function listDashboardPluginsPayload(): Promise<Record<string, unknown>> {
  const registryFile = readPluginRegistry();
  const installed = new Set(Object.keys(registryFile.plugins));
  const globalPlugins = cleanPluginListForInstalled(readGlobalConfig().plugins, installed);
  const globalSet = new Set(globalPlugins);
  const pinnedSet = new Set(normalizePluginIdList(readGlobalConfig().dashboard?.pinnedPlugins) ?? []);
  let botConfigs: BotConfig[] = [];
  try { botConfigs = loadBotConfigs(); } catch { /* setup can render before bots.json exists */ }
  const onlineByAppId = new Map(registry.list().map(bot => [bot.larkAppId, bot] as const));
  const bots = botConfigs.map((bot, index) => {
    return {
      id: bot.larkAppId,
      name: bot.displayName || onlineByAppId.get(bot.larkAppId)?.botName || bot.name || `Bot ${index + 1}`,
      plugins: resolveEffectivePluginIds(bot, { plugins: globalPlugins }),
    };
  });
  const gatewayAdapters = [...new Map(botConfigs.map(bot => {
    const adapter = createCliAdapterSync(bot.cliId, bot.cliPathOverride);
    return [adapter.id, inspectGatewayEntry(adapter)] as const;
  })).values()];
  const gatewayDiagnostics = latestGatewayDiagnostics();
  const serviceReports = await listPluginServiceStatus();
  const serviceByPlugin = new Map<string, typeof serviceReports>();
  for (const report of serviceReports) {
    const bucket = serviceByPlugin.get(report.pluginId) ?? [];
    bucket.push(report);
    serviceByPlugin.set(report.pluginId, bucket);
  }
  const plugins = Object.values(registryFile.plugins)
    .sort((a, b) => a.id.localeCompare(b.id))
    .map(record => ({
      id: record.id,
      packageName: record.packageName,
      version: record.version,
      source: record.source,
      installedAt: record.installedAt,
      updatedAt: record.updatedAt,
      displayName: record.manifest.displayName,
      dependencies: record.manifest.dependencies?.plugins ?? [],
      contributions: record.contributions ?? {},
      skillsCount: record.contributions?.skills?.length ?? (record.manifest as any).skills?.length ?? 0,
      mcpCount: record.contributions?.mcp ? 1 : 0,
      dashboard: dashboardEntriesForRecord(record).map(entry => ({
        ...entry,
        url: `/plugins/${encodeURIComponent(record.id)}/${entry.entry}`,
      })),
      service: record.manifest.service,
      serviceReport: serviceByPlugin.get(record.id)?.[0],
      pinnedToSidebar: pinnedSet.has(record.id) && dashboardEntriesForRecord(record).length > 0,
      enabledGlobal: globalSet.has(record.id),
      enabledByBot: Object.fromEntries(bots.map(bot => [bot.id, bot.plugins.includes(record.id)])),
      gatewayAdapters,
      mcpDiagnostics: gatewayDiagnostics.get(record.id) ?? [],
    }));
  return { plugins, globalPlugins, bots, gatewayAdapters };
}

function writeGlobalPluginBinding(pluginId: string, enabled: boolean): void {
  const current = normalizePluginIdList(readGlobalConfig().plugins) ?? [];
  assertPluginBindingTransition(pluginId, enabled, current);
  if (enabled) materializePlugin(pluginId);
  const next = enabled ? addPluginId(current, pluginId) : removePluginId(current, pluginId);
  mergeGlobalConfig({ plugins: next.length > 0 ? next : null });
}

async function writeBotPluginBinding(pluginId: string, larkAppId: string, enabled: boolean): Promise<boolean> {
  try { loadBotConfigs(); } catch { return false; }
  const path = requireConfigPath();
  const defaults = normalizePluginIdList(readGlobalConfig().plugins) ?? [];
  return withFileLock(path, async () => {
    const raw = await readRawConfig(path);
    const index = findEntryIndex(raw, larkAppId);
    if (index < 0) return false;
    const entry = raw[index];
    const current = Object.prototype.hasOwnProperty.call(entry, 'plugins') ? entry.plugins : undefined;
    const effective = resolveEffectivePluginIds(
      { plugins: normalizePluginIdList(current) ?? [] },
      { plugins: defaults },
    );
    assertPluginBindingTransition(pluginId, enabled, effective);
    if (enabled) materializePlugin(pluginId);
    const next = updateBotPluginOverride(current, pluginId, enabled);
    if (next.length > 0) entry.plugins = next;
    else delete entry.plugins;
    await writeRawConfigAtomic(path, raw);
    return true;
  });
}

function pluginJson(res: ServerResponse, status: number, body: unknown): true {
  jsonRes(res, status, body);
  return true;
}

async function handlePluginManagementApi(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<boolean> {
  if (req.method === 'GET' && url.pathname === '/api/plugins') {
    return pluginJson(res, 200, await listDashboardPluginsPayload());
  }

  let match = url.pathname.match(/^\/api\/plugins\/([^/]+)\/pin$/);
  if (match) {
    if (req.method !== 'PUT') return pluginJson(res, 405, { ok: false, error: 'method_not_allowed' });
    const pluginId = decodeURIComponent(match[1]);
    const record = requireInstalledPlugin(pluginId);
    if (!record) return pluginJson(res, 404, { ok: false, error: 'plugin_not_found' });
    if (dashboardEntriesForRecord(record).length === 0) {
      return pluginJson(res, 409, { ok: false, error: 'plugin_dashboard_not_found' });
    }
    let body: unknown;
    try { body = await readJsonBody(req); } catch { return pluginJson(res, 400, { ok: false, error: 'bad_json' }); }
    const pinned = pluginPinnedPatch(body);
    if (pinned === null) return pluginJson(res, 400, { ok: false, error: 'invalid_pinned' });
    writeDashboardPluginPin(pluginId, pinned);
    return pluginJson(res, 200, { ok: true, ...(await listDashboardPluginsPayload()) });
  }

  match = url.pathname.match(/^\/api\/plugins\/([^/]+)\/global$/);
  if (match) {
    if (req.method !== 'PUT') return pluginJson(res, 405, { ok: false, error: 'method_not_allowed' });
    const pluginId = decodeURIComponent(match[1]);
    if (!requireInstalledPlugin(pluginId)) return pluginJson(res, 404, { ok: false, error: 'plugin_not_found' });
    let body: unknown;
    try { body = await readJsonBody(req); } catch { return pluginJson(res, 400, { ok: false, error: 'bad_json' }); }
    const enabled = pluginEnabledPatch(body);
    if (enabled === null) return pluginJson(res, 400, { ok: false, error: 'invalid_enabled' });
    try {
      writeGlobalPluginBinding(pluginId, enabled);
    } catch (error) {
      const message = describePluginDependencyError(error);
      if (message) return pluginJson(res, 409, { ok: false, error: message });
      throw error;
    }
    return pluginJson(res, 200, { ok: true, ...(await listDashboardPluginsPayload()) });
  }

  match = url.pathname.match(/^\/api\/plugins\/([^/]+)\/bots\/([^/]+)$/);
  if (match) {
    if (req.method !== 'PUT') return pluginJson(res, 405, { ok: false, error: 'method_not_allowed' });
    const pluginId = decodeURIComponent(match[1]);
    const larkAppId = decodeURIComponent(match[2]);
    if (!requireInstalledPlugin(pluginId)) return pluginJson(res, 404, { ok: false, error: 'plugin_not_found' });
    let body: unknown;
    try { body = await readJsonBody(req); } catch { return pluginJson(res, 400, { ok: false, error: 'bad_json' }); }
    const enabled = pluginEnabledPatch(body);
    if (enabled === null) return pluginJson(res, 400, { ok: false, error: 'invalid_enabled' });
    if ((normalizePluginIdList(readGlobalConfig().plugins) ?? []).includes(pluginId)) {
      return pluginJson(res, 409, {
        ok: false,
        error: `插件 ${pluginId} 已全局启用；请先关闭全局启用，再按 Bot 配置。`,
      });
    }
    try {
      if (!await writeBotPluginBinding(pluginId, larkAppId, enabled)) {
        return pluginJson(res, 404, { ok: false, error: 'bot_not_found' });
      }
    } catch (error) {
      const message = describePluginDependencyError(error);
      if (message) return pluginJson(res, 409, { ok: false, error: message });
      throw error;
    }
    return pluginJson(res, 200, { ok: true, ...(await listDashboardPluginsPayload()) });
  }

  match = url.pathname.match(/^\/api\/plugins\/([^/]+)\/services\/(start|stop|restart)$/);
  if (match) {
    if (req.method !== 'POST') return pluginJson(res, 405, { ok: false, error: 'method_not_allowed' });
    const pluginId = decodeURIComponent(match[1]);
    const action = match[2];
    if (!requireInstalledPlugin(pluginId)) return pluginJson(res, 404, { ok: false, error: 'plugin_not_found' });
    const reports = action === 'start'
      ? await startPluginServices([pluginId])
      : action === 'restart'
        ? [...await stopPluginServices([pluginId]), ...await startPluginServices([pluginId])]
        : await stopPluginServices([pluginId]);
    return pluginJson(res, 200, { ok: true, reports, ...(await listDashboardPluginsPayload()) });
  }

  return false;
}

// ─── HTTP routing ────────────────────────────────────────────────────────────

function authedToken(
  req: IncomingMessage,
  url: URL,
  activeToken: string | null,
): string | undefined {
  const q = url.searchParams.get('t');
  if (q && q === activeToken) return q;
  return parseCookie(req.headers.cookie);
}

async function proxyToDaemon(
  larkAppId: string, daemonPath: string, init: RequestInit,
): Promise<Response> {
  const d = registry.getByAppId(larkAppId);
  if (!d) {
    return new Response(JSON.stringify({ ok: false, error: 'daemon_offline', errorCode: 'daemon_offline' }), {
      status: 503,
      headers: { 'content-type': 'application/json' },
    });
  }
  const method = String(init.method ?? 'GET').toUpperCase();
  const workflowPathTail = daemonPath.startsWith(`${WORKFLOW_DAEMON_IPC_ROUTE_PREFIX}/`)
    ? daemonPath.slice(WORKFLOW_DAEMON_IPC_ROUTE_PREFIX.length + 1)
    : '';
  const isWorkflowMutation = method === 'POST' &&
    /^[^/]+\/(?:start|cancel|retry|grant)(?:\?.*)?$/.test(workflowPathTail);
  if (!isWorkflowMutation) {
    // Non-workflow routes ride the shared trusted-host wrapper (route-bound
    // X-Botmux-Cli-* HMAC). Workflow mutations keep the domain-separated
    // full-envelope protocol below; the daemon admits that prefix through its
    // narrow capability aperture and the handler fail-closes on the envelope.
    return fetchDaemonIpc(d.ipcPort, daemonPath, init);
  }
  if (d.workflowIpcProtocol !== 'v1' || !d.bootInstanceId) {
    return new Response(JSON.stringify({
      ok: false,
      error: 'daemon_upgrade_required',
      message: 'target daemon does not advertise Workflow IPC v1; upgrade and restart all botmux processes',
    }), { status: 503, headers: { 'content-type': 'application/json' } });
  }
  const bodyRaw = init.body === undefined || init.body === null
    ? ''
    : typeof init.body === 'string'
      ? init.body
      : (() => { throw new Error('Workflow daemon mutation body must be a pre-serialized string'); })();
  const target: WorkflowDaemonIpcTarget = {
    larkAppId: d.larkAppId,
    ipcPort: d.ipcPort,
    bootInstanceId: d.bootInstanceId,
  };
  const authHeaders = workflowDaemonIpcHeaders({
    secret: SECRET,
    method,
    pathWithQuery: daemonPath,
    bodyRaw,
    target,
  });
  const workflowResponseAuth = {
    nonce: authHeaders['X-Botmux-Workflow-Ipc-Nonce']!,
    target,
  };
  const headers = new Headers(init.headers);
  for (const [key, value] of Object.entries(authHeaders)) {
    headers.set(key, value);
  }
  const upstream = await loopbackFetch(
    `http://127.0.0.1:${d.ipcPort}${daemonPath}`,
    { ...init, headers },
  );
  const responseBody = await upstream.text();
  const authenticated = verifyWorkflowDaemonIpcResponse({
    secret: SECRET,
    requestNonce: workflowResponseAuth.nonce,
    method,
    pathWithQuery: daemonPath,
    status: upstream.status,
    body: responseBody,
    target: workflowResponseAuth.target,
    signature: upstream.headers.get('x-botmux-workflow-ipc-response-signature'),
  });
  if (!authenticated) {
    return new Response(JSON.stringify({
      ok: false,
      error: 'daemon_response_unauthenticated',
      message: 'target daemon response did not verify as Workflow IPC v1',
    }), { status: 502, headers: { 'content-type': 'application/json' } });
  }
  return new Response(responseBody, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: upstream.headers,
  });
}

/** Authenticated adapter for helpers that receive a discovered daemon URL. */
function fetchDaemonUrl(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const url = new URL(input instanceof Request ? input.url : String(input));
  const port = Number(url.port);
  if (url.hostname !== '127.0.0.1' || !Number.isSafeInteger(port) || port <= 0) {
    return Promise.reject(new Error('daemon helper attempted a non-loopback URL'));
  }
  return fetchDaemonIpc(port, `${url.pathname}${url.search}`, init);
}

async function collectGoalAttentionLiveRisks(chatId?: string): Promise<any[]> {
  const qs = chatId ? `?chatId=${encodeURIComponent(chatId)}` : '';
  const chunks = await Promise.all(registry.list().map(async d => {
    try {
      const path = `/api/goals/attention/live${qs}`;
      const upstream = await fetchDaemonIpc(d.ipcPort, path, {
        method: 'GET',
        signal: AbortSignal.timeout(2_000),
      });
      if (!upstream.ok) return [];
      const body = await upstream.json().catch(() => null) as { systemRisk?: any[] } | null;
      return Array.isArray(body?.systemRisk) ? body.systemRisk : [];
    } catch {
      return [];
    }
  }));
  return chunks.flat();
}

/** Create a Feishu group from the team UI: pick a creator daemon among the
 *  selected bots, proxy to its /api/groups/create, invite the requesting user.
 *  Surfaces invalidBotIds/invalidUserIds so the UI never implies a non-added
 *  bot/user joined. */
/** Live daemon-registry bots — authoritative source for THIS deployment's
 *  bots. cliId comes from the daemon descriptor, with bots.json as a
 *  compatibility fallback for descriptors written by older daemons. */
function configuredCliIds(): Map<string, string> {
  try {
    return new Map(loadBotConfigs().map(b => [b.larkAppId, b.cliId]));
  } catch {
    return new Map();
  }
}

/**
 * per-bot brand（feishu / lark）按 appId 的映射,供前端派生飞书后台深链 host。
 * 失败安全逻辑在 brandMapByAppId（返回空 Map,与 configuredCliIds /
 * configuredBotAgentFields 同款兜底,见其 doc）——冷缓存 /api/groups 与
 * /api/bots 仍走 DaemonRegistry 降级 roster,前端 normalizeBrand 兜底 feishu。
 */
function configuredBrands(): Map<string, string | undefined> {
  return brandMapByAppId(loadBotConfigs);
}

function configuredBotAgentFields(): Map<string, { cliId?: string; cliRuntime?: BotConfig['cliRuntime']; cliPathOverride?: string; wrapperCli?: string; model?: string; reasoningEffort?: BotConfig['reasoningEffort']; turnTimeoutMs?: number; dshRuntime?: BotConfig['dshRuntime'] }> {
  try {
    return new Map(loadBotConfigs().map(b => [b.larkAppId, {
      cliId: b.cliId,
      cliRuntime: b.cliRuntime,
      // loadBotConfigs mirrors structured runtime.executable into this legacy
      // field in memory. Only forward a genuine path-only config to the private
      // Bot Defaults endpoint.
      cliPathOverride: b.cliRuntime ? undefined : b.cliPathOverride,
      wrapperCli: b.wrapperCli,
      model: b.model,
      reasoningEffort: b.reasoningEffort,
      turnTimeoutMs: b.turnTimeoutMs,
      dshRuntime: b.dshRuntime,
    }]));
  } catch {
    return new Map();
  }
}

function withConfiguredCliId<T extends { larkAppId: string; cliId?: string; cliRuntime?: BotConfig['cliRuntime']; cliPathOverride?: string; wrapperCli?: string; model?: string; reasoningEffort?: BotConfig['reasoningEffort']; turnTimeoutMs?: number; dshRuntime?: BotConfig['dshRuntime'] }>(
  bot: T,
  ids: Map<string, string> | Map<string, { cliId?: string; cliRuntime?: BotConfig['cliRuntime']; cliPathOverride?: string; wrapperCli?: string; model?: string }>,
): T & { cliId?: string; cliRuntime?: BotConfig['cliRuntime']; cliPathOverride?: string; wrapperCli?: string; model?: string; reasoningEffort?: BotConfig['reasoningEffort']; turnTimeoutMs?: number; dshRuntime?: BotConfig['dshRuntime'] } {
  const raw = ids.get(bot.larkAppId);
  const fallback: { cliId?: string; cliRuntime?: BotConfig['cliRuntime']; cliPathOverride?: string; wrapperCli?: string; model?: string; reasoningEffort?: BotConfig['reasoningEffort']; turnTimeoutMs?: number; dshRuntime?: BotConfig['dshRuntime'] } | undefined = typeof raw === 'string' ? { cliId: raw } : raw;
  return {
    ...bot,
    cliId: bot.cliId || fallback?.cliId,
    cliRuntime: bot.cliRuntime || fallback?.cliRuntime,
    cliPathOverride: bot.cliPathOverride || fallback?.cliPathOverride,
    wrapperCli: bot.wrapperCli || fallback?.wrapperCli,
    model: bot.model || fallback?.model,
    reasoningEffort: bot.reasoningEffort || fallback?.reasoningEffort,
    turnTimeoutMs: bot.turnTimeoutMs ?? fallback?.turnTimeoutMs,
    dshRuntime: bot.dshRuntime ?? fallback?.dshRuntime,
  };
}

function liveBots(): { larkAppId: string; botName: string; botOpenId?: string; cliId?: string; larkTransportEnabled?: boolean }[] {
  const ids = configuredCliIds();
  // core-only (apiOnly) bots have no Feishu transport → flag them so the
  // aggregated roster (and any spoke pulling it) can exclude them from group
  // membership/creation (#668). Mirror federation-spoke-api's spoke-side advert.
  // FAIL-CLOSED: config unreadable → apiOnlyIds=null → resolveLiveBotTransport
  // marks every bot transport=false (a remote consumer then won't invite any),
  // because we cannot confirm transport for a roster federated off-box. (Do NOT
  // fail-open here like the local isNoTransportBot: that has a config backstop
  // beside it; a remote spoke consuming this roster has none.)
  let apiOnlyIds: Set<string> | null;
  try { apiOnlyIds = new Set(loadBotConfigs().filter(b => b.apiOnly === true).map(b => b.larkAppId)); }
  catch { apiOnlyIds = null; }
  const base = registry.list().map(d => {
    const b = withConfiguredCliId(d, ids);
    return { larkAppId: b.larkAppId, botName: b.botName, botOpenId: b.botOpenId, cliId: b.cliId };
  });
  return resolveLiveBotTransport(base, apiOnlyIds);
}

async function createTeamGroup(args: { name: string; larkAppIds: string[]; userOpenId?: string; preferredCreator?: string; ownerUnionIds?: string[]; transferOwnerUnionId?: string; roleProfileId?: string }): Promise<TeamGroupCreateResult & {
  autoInviteUnavailable?: boolean;
}> {
  const selectedIds = Array.from(new Set(args.larkAppIds.filter(Boolean)));
  if (selectedIds.length === 0) return { ok: false, error: 'no_bots_selected' };
  // Only auto-invite the web user when their paired bot is the creator (open_id
  // is scoped to that app); otherwise create the group but don't forward a
  // wrong-scope open_id — UI will flag autoInviteUnavailable.
  // Two DISTINCT predicates — conflating them regressed federation:
  //  • isNoTransportBot: a bot with no Feishu transport (core-only apiOnly).
  //    Checked from LOCAL config AND, for a remote federated bot, from the
  //    aggregated roster's `larkTransportEnabled === false` (propagated
  //    spoke→sync→store→roster). undefined/absent (legacy spoke) → normal.
  //    Does NOT require local-registry presence, so a remote normal bot stays.
  //  • canBeCreator: creator must be a locally-online daemon AND have transport
  //    (getBotClient throws for apiOnly). Remote bots can be members, not creator.
  let noTransportRosterIds = new Set<string>();
  try {
    noTransportRosterIds = new Set(
      buildFederatedRoster(config.session.dataDir, undefined, undefined, undefined, liveBots())
        .bots.filter(b => b.larkTransportEnabled === false).map(b => b.larkAppId),
    );
  } catch { /* roster unavailable → rely on local config only */ }
  const isNoTransportBot = (id: string): boolean => {
    if (noTransportRosterIds.has(id)) return true;
    try { return loadBotConfigs().find(b => b.larkAppId === id)?.apiOnly === true; }
    catch { return false; }
  };
  const canBeCreator = (id: string): boolean => !!registry.getByAppId(id) && !isNoTransportBot(id);
  const plan = planGroupCreator(
    selectedIds,
    args.preferredCreator,
    canBeCreator,
    (ids) => {
      const p = pickCreatorForGroup(ids.filter(canBeCreator), (id) => {
        const d = registry.getByAppId(id);
        return d ? { larkAppId: d.larkAppId, resolvedAllowedUsers: d.resolvedAllowedUsers ?? [] } : undefined;
      });
      return p ? p.creatorLarkAppId : null;
    },
  );
  if (!plan.creatorLarkAppId) return { ok: false, error: 'no_online_daemon' };
  const userOpenIds = plan.inviteUser && args.userOpenId ? [args.userOpenId] : [];
  try {
    // Exclude ONLY apiOnly bots from the member payload (they have no Feishu
    // identity to invite). Federation remote NORMAL bots stay — the fix for the
    // creator-predicate regression that also dropped them.
    const memberIds = selectedIds.filter(id => !isNoTransportBot(id));
    const upstream = await proxyToDaemon(plan.creatorLarkAppId, '/api/groups/create', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(buildTeamGroupCreatePayload({
        name: args.name,
        larkAppIds: memberIds,
        userOpenIds,
        ownerUnionIds: args.ownerUnionIds ?? [],
        transferOwnerUnionId: args.transferOwnerUnionId,
        roleProfileId: args.roleProfileId,
      })),
    });
    const text = await upstream.text();
    let parsed: any = null;
    try { parsed = JSON.parse(text); } catch { /* leave null */ }
    if (!upstream.ok || !parsed?.ok || typeof parsed.chatId !== 'string') {
      return { ok: false, error: parsed?.error ?? `group_create_http_${upstream.status}` };
    }
    groupsMatrixSnapshot.invalidate();
    return {
      ok: true,
      chatId: parsed.chatId,
      creator: plan.creatorLarkAppId,
      shareLink: typeof parsed.shareLink === 'string' ? parsed.shareLink : undefined,
      invalidBotIds: parsed.invalidBotIds ?? [],
      invalidUserIds: parsed.invalidUserIds ?? [],
      invalidOwnerUnionIds: parsed.invalidOwnerUnionIds ?? [],
      ownerTransferredTo: parsed.ownerTransferredTo ?? null,
      transferError: parsed.transferError ?? null,
      notifyMessageId: parsed.notifyMessageId ?? null,
      notifyError: parsed.notifyError ?? null,
      autoInviteUnavailable: !plan.inviteUser,
    };
  } catch {
    return { ok: false, error: 'group_create_proxy_failed' };
  }
}

async function transferTeamGroupOwner(args: {
  creatorLarkAppId: string;
  chatId: string;
  transferOwnerUnionId: string;
}): Promise<TeamGroupOwnerTransferResult> {
  try {
    const upstream = await proxyToDaemon(args.creatorLarkAppId, '/api/groups/transfer-owner', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chatId: args.chatId, ownerUnionId: args.transferOwnerUnionId }),
    });
    const parsed = await upstream.json().catch(() => null) as any;
    if (!upstream.ok || !parsed?.ok) {
      return {
        ownerTransferredTo: null,
        transferError: parsed?.error ?? `owner_transfer_http_${upstream.status}`,
      };
    }
    groupsMatrixSnapshot.invalidate();
    return {
      ownerTransferredTo: parsed.ownerTransferredTo ?? null,
      transferError: parsed.transferError ?? null,
      notifyMessageId: parsed.notifyMessageId ?? null,
      notifyError: parsed.notifyError ?? null,
    };
  } catch {
    return { ownerTransferredTo: null, transferError: 'owner_transfer_proxy_failed' };
  }
}

function lifecycleBotIds(connector: ConnectorDefinition): string[] {
  return Array.from(new Set([connector.target.botId, ...(connector.target.botIds ?? [])].filter(Boolean)));
}

function lifecycleGroupName(connector: ConnectorDefinition, dedupKey: string): string {
  const cleanKey = dedupKey.replace(/\s+/g, ' ').trim();
  const name = `${connector.name}: ${cleanKey}`;
  return name.length <= 58 ? name : `${name.slice(0, 55)}...`;
}

async function createLifecycleGroupForWebhook(
  connector: ConnectorDefinition,
  args: { dedupKey: string },
): Promise<{ chatId: string; creatorLarkAppId?: string }> {
  const selectedIds = lifecycleBotIds(connector);
  const pick = pickCreatorForGroup(selectedIds, (id) => {
    const d = registry.getByAppId(id);
    return d ? { larkAppId: d.larkAppId, resolvedAllowedUsers: d.resolvedAllowedUsers ?? [] } : undefined;
  });
  if (!pick) throw new Error('no_online_daemon');
  const creator = registry.getByAppId(pick.creatorLarkAppId);
  if (!creator) throw new Error('creator_daemon_offline');
  // Pull the creator bot's authorized humans (allowedUsers) into the auto-created
  // group so a person — not just bots — is in the room. allowedUsers stores both
  // union_ids (on_, tenant-stable) and legacy open_ids (ou_, creator-app-scoped);
  // route each to the matching invite channel. @-notify the first open_id if any.
  const allowed = creator.resolvedAllowedUsers ?? [];
  const ownerUnionIds = allowed.filter(u => u.startsWith('on_'));
  const userOpenIds = allowed.filter(u => u.startsWith('ou_'));
  const upstream = await fetchDaemonIpc(creator.ipcPort, '/api/groups/create', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: lifecycleGroupName(connector, args.dedupKey),
      larkAppIds: selectedIds,
      ...(ownerUnionIds.length > 0 ? { ownerUnionIds } : {}),
      ...(userOpenIds.length > 0 ? { userOpenIds } : {}),
      ...(userOpenIds[0] ? { notifyOwnerOpenId: userOpenIds[0] } : {}),
    }),
  });
  const text = await upstream.text();
  let parsed: any = null;
  try { parsed = JSON.parse(text); } catch { /* leave null */ }
  if (!upstream.ok || !parsed?.ok || typeof parsed.chatId !== 'string') {
    throw new Error(parsed?.error ?? `group_create_http_${upstream.status}`);
  }
  groupsMatrixSnapshot.invalidate();
  return { chatId: parsed.chatId, creatorLarkAppId: parsed.creator ?? pick.creatorLarkAppId };
}

/**
 * Build the per-(chat × bot) coverage matrix shared by `GET /api/groups`
 * (browser) and `GET /__daemon/groups-matrix` (Route B). Pure aggregation,
 * always returns the raw (unscrubbed) view — the browser route applies its
 * `redactGroupsForPublic` scrub on top when the caller is unauthed.
 */
async function buildGroupsMatrix(): Promise<GroupsMatrix> {
  const out = new Map<string, any>();
  const cliIds = configuredCliIds();
  const onlineBots = [...registry.list()]
    .map(b => withConfiguredCliId(b, cliIds))
    .sort((a, b) => a.botIndex - b.botIndex);
  await Promise.all(onlineBots.map(async d => {
    try {
      const r = await fetchDaemonIpc(d.ipcPort, '/api/groups');
      if (!r.ok) return;
      const j = await r.json() as { chats?: any[] };
      for (const c of j.chats ?? []) {
        const { oncallChat, firstSeenAt, hasRole, hasMessageListener, observedBotNames, ...chatBase } = c;
        const cur = out.get(c.chatId) ?? {
          ...chatBase,
          memberBots: [] as any[],
          _firstSeenAt: null as number | null,
          observedBotNames: [] as string[],
        };
        if (Array.isArray(observedBotNames) && observedBotNames.length > 0) {
          cur.observedBotNames = [...new Set([...(cur.observedBotNames ?? []), ...observedBotNames])];
        }
        cur.memberBots.push({
          larkAppId: d.larkAppId,
          botOpenId: d.botOpenId,
          botName: d.botName,
          cliId: d.cliId,
          inChat: true,
          oncallChat: oncallChat ?? null,
          hasRole: hasRole ?? false,
          hasMessageListener: hasMessageListener ?? false,
        });
        if (typeof firstSeenAt === 'number') {
          cur._firstSeenAt = cur._firstSeenAt === null
            ? firstSeenAt
            : Math.min(cur._firstSeenAt, firstSeenAt);
        }
        out.set(c.chatId, cur);
      }
    } catch { /* skip offline daemons silently — best-effort */ }
  }));
  for (const c of out.values()) {
    const present = new Set<string>(c.memberBots.map((mb: any) => mb.larkAppId));
    for (const b of onlineBots) {
      if (!present.has(b.larkAppId)) {
        c.memberBots.push({ larkAppId: b.larkAppId, botOpenId: b.botOpenId, botName: b.botName, cliId: b.cliId, inChat: false, oncallChat: null, hasRole: false, hasMessageListener: false });
      }
    }
  }
  const chats = [...out.values()]
    .sort((a, b) => {
      const ta = a._firstSeenAt ?? 0;
      const tb = b._firstSeenAt ?? 0;
      if (tb !== ta) return tb - ta;
      return (a.name ?? a.chatId).localeCompare(b.name ?? b.chatId);
    })
    .map(({ _firstSeenAt, ...rest }) => rest);
  // brand 是 bots.json 的 per-bot 字段（DaemonRegistry 的心跳态不带它），
  // 从 configuredBrands（失败安全,返空 Map）按 appId 补进 summary,供前端
  // 派生飞书后台深链 host；冷缓存 / 缺配置时前端 normalizeBrand 兜底 feishu。
  const brandByAppId = configuredBrands();
  const bots = onlineBots.map(d => botSummaryPayload({ ...d, brand: brandByAppId.get(d.larkAppId) }));
  return { chats, bots };
}

/**
 * Close every active session matching `pred` by routing to its owning daemon.
 * Used after disband (close all sessions in chat) and leave (close only the
 * leaving bot's sessions in chat) so the UI doesn't end up with zombie workers
 * pointing at a chat the bot can no longer post into.
 */
async function closeSessionsMatching(
  pred: (s: any) => boolean,
): Promise<{ sessionId: string; ok: boolean; error?: string; residual?: ParsedCloseResidual }[]> {
  const matching = aggregator.getSessions().filter(s => s.status !== 'closed' && pred(s));
  return Promise.all(matching.map(async s => {
    try {
      const upstream = await proxyToDaemon(
        s.larkAppId as string,
        `/api/sessions/${encodeURIComponent(s.sessionId)}/close`,
        { method: 'POST' },
      );
      const text = await upstream.text();
      let body: any = null;
      try { body = JSON.parse(text); } catch { /* tolerate */ }
      const residual = body?.ok ? parseCloseResidual(body) : undefined;
      return {
        sessionId: s.sessionId as string,
        ok: !!body?.ok,
        ...(residual ? { residual } : {}),
        error: body?.ok ? undefined : (body?.error ?? `http_${upstream.status}`),
      };
    } catch (e: any) {
      return { sessionId: s.sessionId as string, ok: false, error: e?.message ?? String(e) };
    }
  }));
}

/**
 * Shared loopback-HMAC gate for the `/__cli/*` endpoints. Returns `{ ok: true }`
 * on success, or a ready-to-send `{ status, body }` error otherwise.
 *
 * The HMAC is bound to `method + pathname + the port WE actually bound`
 * (`boundDashboardPort`, not the attacker-controllable Host header). That scopes
 * a captured credential to this exact route on this exact dashboard, so a
 * malicious local server handed a `botmux dashboard` discovery probe can't
 * forward those headers to a different `/__cli/*` route or to the real dashboard
 * on another port. See {@link cliAuthBind}.
 */
function verifyCliRequest(req: IncomingMessage, pathname: string):
  | { ok: true }
  | { ok: false; status: number; body: Record<string, unknown> } {
  const ts = req.headers['x-botmux-cli-ts'];
  const nonce = req.headers['x-botmux-cli-nonce'];
  const sig = req.headers['x-botmux-cli-auth'];
  if (typeof ts !== 'string' || typeof nonce !== 'string' || typeof sig !== 'string') {
    return { ok: false, status: 400, body: { error: 'missing_headers' } };
  }
  const remote = (req.socket.remoteAddress ?? '').replace(/^::ffff:/, '');
  const bind = cliAuthBind(req.method ?? 'POST', pathname, boundDashboardPort);
  const r = verifyHmac(SECRET, { ts, nonce, sig }, remote, bind);
  if (!r.ok) return { ok: false, status: 401, body: { error: 'unauthorized', reason: r.reason } };
  return { ok: true };
}

/** Build the dashboard URL(s) for a token, using the actually-bound port. The
 *  primary `url` routes through the central-platform machine subdomain when
 *  远程访问 is on and this host is bound (see buildDashboardUrls); `localUrl`
 *  carries the direct host:port fallback in that case (undefined otherwise). */
function dashboardUrlsFor(token: string): DashboardUrls {
  return buildDashboardUrls({ host: config.dashboard.externalHost, port: boundDashboardPort, token });
}

type SkillJobStatus = 'running' | 'succeeded' | 'failed';
interface SkillJob {
  id: string;
  type: 'install' | 'update';
  status: SkillJobStatus;
  createdAt: string;
  updatedAt: string;
  skill?: SkillPackage;
  skills?: SkillPackage[];
  error?: string;
}

const skillJobs = new Map<string, SkillJob>();
const MAX_SKILL_JOBS = 50;

function publicSkillJob(job: SkillJob): Record<string, unknown> {
  return {
    id: job.id,
    type: job.type,
    status: job.status,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    skill: job.skill ? sanitizeSkillForDashboard(job.skill) : undefined,
    skills: job.skills?.map(sanitizeSkillForDashboard),
    error: job.error,
  };
}

function trimSkillJobs(): void {
  const jobs = [...skillJobs.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  while (jobs.length > MAX_SKILL_JOBS) {
    const old = jobs.shift();
    if (old) skillJobs.delete(old.id);
  }
}

function startSkillJob(type: SkillJob['type'], run: () => Promise<SkillPackage | SkillPackage[]>): SkillJob {
  const now = new Date().toISOString();
  const job: SkillJob = {
    id: randomBytes(8).toString('hex'),
    type,
    status: 'running',
    createdAt: now,
    updatedAt: now,
  };
  skillJobs.set(job.id, job);
  trimSkillJobs();
  setImmediate(() => void (async () => {
    try {
      const result = await run();
      if (Array.isArray(result)) {
        job.skills = result;
        job.skill = result[0];
      } else {
        job.skill = result;
        job.skills = [result];
      }
      job.status = 'succeeded';
      const audits = (job.skills ?? []).map(skill => {
        try {
          return buildSkillInstallAuditSummary(skill);
        } catch {
          return {
            name: skill.name,
            sourceType: skill.source.type,
            auditError: 'static_scan_failed',
          };
        }
      });
      logger.info('[skills:audit] job succeeded', {
        jobId: job.id,
        operation: type,
        skills: audits,
      });
    } catch (err: any) {
      job.error = redactGitUrlCredentials(err?.message ?? String(err));
      job.status = 'failed';
      logger.warn('[skills:audit] job failed', {
        jobId: job.id,
        operation: type,
        error: job.error,
      });
    } finally {
      job.updatedAt = new Date().toISOString();
      trimSkillJobs();
    }
  })());
  return job;
}

function dashboardSkillCliIds(): CliId[] {
  const ids = new Set<CliId>();
  // Always scan all known CLI skill dirs, not just configured bots — users may
  // want to discover codex/trae/... skills even before creating a bot for them.
  // Derived from the closed Record<CliId,…> in the registry — a hand-typed
  // literal here silently omitted reasonix and mojo, hiding their skill dirs.
  for (const cliId of ALL_CLI_IDS) ids.add(cliId);
  try {
    for (const cliId of configuredCliIds().values()) ids.add(cliId as CliId);
  } catch {
    // Fall back to daemon descriptors below when persistent config is unavailable.
  }
  for (const bot of registry.list()) {
    if (bot.cliId) ids.add(bot.cliId as CliId);
  }
  return [...ids];
}

function dashboardSkillsPayload(): Record<string, unknown> {
  const globalSkills = readGlobalConfig().skills ?? {};
  const nativeSkillGroups = discoverNativeCliSkillGroups(dashboardSkillCliIds())
    .map(group => ({
      ...group,
      skills: group.skills.map(sanitizeSkillForDashboard),
    }));
  return {
    skills: Object.values(readSkillRegistry().skills)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(sanitizeSkillForDashboard),
    nativeSkillGroups,
    trustProjectSkills: globalSkills.trustProjectSkills ?? 'off',
    delivery: globalSkills.delivery ?? 'auto',
  };
}

// --- Skill pack dashboard helpers ------------------------------------------

function loadBotConfigsSafe(): BotConfig[] {
  try { return loadBotConfigs(); } catch { return []; }
}

function botsReferencingPack(packId: string, bots: BotConfig[]): Array<{ larkAppId: string; botName: string }> {
  const selector = `pack:${packId}`;
  return bots
    .filter((bot) => Array.isArray(bot.skills?.include) && bot.skills!.include!.includes(selector as SkillSelector))
    .map((bot) => ({ larkAppId: bot.larkAppId, botName: bot.name ?? bot.larkAppId }))
    .sort((a, b) => a.botName.localeCompare(b.botName));
}

function parsePackInput(body: unknown): { id: string; name: string; description?: string; tags?: string[]; include: Array<`skill:${string}`> } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new SkillPackStoreError({ code: 'SKILL_PACK_INVALID', reason: 'body must be an object' });
  const b = body as Record<string, unknown>;
  return {
    id: typeof b.id === 'string' ? b.id : '',
    name: typeof b.name === 'string' ? b.name : '',
    description: typeof b.description === 'string' ? b.description : undefined,
    tags: Array.isArray(b.tags) ? b.tags as string[] : undefined,
    include: Array.isArray(b.include) ? b.include as Array<`skill:${string}`> : [],
  };
}

function parsePackUpdate(body: unknown): { name?: string; description?: string | null; tags?: string[] | null; include?: Array<`skill:${string}`>; expectedRevision?: number } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new SkillPackStoreError({ code: 'SKILL_PACK_INVALID', reason: 'body must be an object' });
  const b = body as Record<string, unknown>;
  return {
    name: typeof b.name === 'string' ? b.name : undefined,
    description: b.description === null ? null : typeof b.description === 'string' ? b.description : undefined,
    tags: b.tags === null ? null : Array.isArray(b.tags) ? b.tags as string[] : undefined,
    include: Array.isArray(b.include) ? b.include as Array<`skill:${string}`> : undefined,
    expectedRevision: typeof b.expectedRevision === 'number' ? b.expectedRevision : undefined,
  };
}

function packErrorStatus(err: unknown): number {
  if (err instanceof SkillPackStoreError) {
    switch (err.detail.code) {
      case 'SKILL_PACK_NOT_FOUND': return 404;
      case 'SKILL_PACK_ID_CONFLICT': return 409;
      case 'SKILL_PACK_REVISION_CONFLICT': return 409;
      case 'SKILL_PACK_IN_USE': return 409;
      default: return 400;
    }
  }
  return 400;
}

function packErrorBody(err: unknown): { ok: false; error: string; [key: string]: unknown } {
  if (err instanceof SkillPackStoreError) {
    const d = err.detail;
    const body: { ok: false; error: string; [key: string]: unknown } = { ok: false, error: d.code };
    if (d.code === 'SKILL_PACK_REVISION_CONFLICT') body.current = d.current;
    if (d.code === 'SKILL_PACK_INVALID') body.reason = d.reason;
    if (d.code === 'SKILL_PACK_INVALID_SELECTOR') body.selector = d.selector;
    return body;
  }
  return {
    ok: false,
    error: 'internal_error',
    detail: redactGitUrlCredentials(err instanceof Error ? err.message : String(err)),
  };
}

function mergeSkillReferenceBot(refs: Map<string, SkillReferenceBot>, ref: SkillReferenceBot): void {
  const current = refs.get(ref.larkAppId);
  if (!current) {
    refs.set(ref.larkAppId, { ...ref });
    return;
  }
  current.direct ||= ref.direct;
}

async function dashboardSkillReferencesMany(skillNames: readonly string[]): Promise<Map<string, SkillReferenceSummary>> {
  const uniqueNames = [...new Set(skillNames)];
  const refsBySkill = new Map(uniqueNames.map(name => [name, new Map<string, SkillReferenceBot>()]));
  let packs: Record<string, SkillPack> | undefined;
  try {
    packs = readSkillPackRegistry().packs;
  } catch {
    // packs.json may be absent; fall back to direct-only analysis.
  }
  try {
    const configuredBots = loadBotConfigs();
    for (const name of uniqueNames) {
      const refs = refsBySkill.get(name)!;
      for (const ref of analyzeSkillReferences(name, { bots: configuredBots, packs }).bots) mergeSkillReferenceBot(refs, ref);
    }
  } catch {
    // Fall back to online daemon data below when the dashboard process cannot
    // read persistent bot config.
  }

  const onlineBots = [...registry.list()].sort((a, b) => a.botIndex - b.botIndex);
  const onlineConfigs = await Promise.all(onlineBots.map(async d => {
    try {
      const r = await fetchDaemonIpc(d.ipcPort, '/api/bot-default-oncall', {
        signal: AbortSignal.timeout(1_500),
      });
      if (!r.ok) return null;
      const j = await r.json() as any;
      return { larkAppId: d.larkAppId, botName: d.botName ?? j.botName ?? d.larkAppId, skills: j.skills as BotSkillPolicy | null | undefined };
    } catch {
      return null;
    }
  }));
  const availableOnlineConfigs = onlineConfigs.filter(config => config !== null);
  for (const name of uniqueNames) {
    const refs = refsBySkill.get(name)!;
    for (const ref of analyzeSkillReferences(name, { bots: availableOnlineConfigs, packs }).bots) mergeSkillReferenceBot(refs, ref);
  }
  return new Map([...refsBySkill].map(([name, refs]) => [name, {
    bots: [...refs.values()].sort((a, b) => a.botName.localeCompare(b.botName)),
    packs: packsContainingSkill(name, packs),
  }]));
}

async function dashboardSkillReferences(skillName: string): Promise<SkillReferenceSummary> {
  return (await dashboardSkillReferencesMany([skillName])).get(skillName) ?? { bots: [], packs: [] };
}

function dashboardControlJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
  });
  res.end(JSON.stringify(body));
}

/**
 * P1-11：控制类端点的跨站伪造门禁。返回 false 表示已经写完 403 响应，调用方直接
 * return。只作用于「有副作用且可被无 body 表单触发」的 POST：终端接管/释放、
 * 预览交互 unlock/activity/lock、话题定位。
 *
 * GET 不进门禁（读没有副作用，且壳/前端的状态轮询本身就是 GET）；Preview 自身的
 * 不透明来源请求走 preview 专用路径的路径内凭据，不经过这里。
 */
function enforceControlCsrf(
  req: IncomingMessage,
  res: ServerResponse,
  identity: DashboardRequestIdentity,
): boolean {
  if ((req.method ?? 'GET').toUpperCase() === 'GET') return true;
  const verdict = guardControlRequest({
    headers: req.headers,
    authSessionId: identity.authSessionId,
    tokens: controlCsrfTokens,
  });
  if (verdict.ok) return true;
  dashboardControlJson(res, verdict.status, { ok: false, error: verdict.error });
  return false;
}

function terminalControlAvailability(sessionId: string):
  | { ok: true }
  | { ok: false; status: number; error: string } {
  const row = aggregator.getSession(sessionId) as {
    status?: unknown;
    larkAppId?: unknown;
    webPort?: unknown;
    proxyPort?: unknown;
    riffAccessUrl?: unknown;
  } | undefined;
  if (!row || !aggregator.ownerOf(sessionId)) return { ok: false, status: 404, error: 'unknown_session' };
  if (row.status === 'closed') return { ok: false, status: 409, error: 'session_not_active' };
  if (typeof row.riffAccessUrl === 'string' && row.riffAccessUrl) {
    return { ok: false, status: 409, error: 'terminal_external_only' };
  }
  const owner = aggregator.ownerOf(sessionId);
  if (!owner || !registry.getByAppId(owner)) return { ok: false, status: 503, error: 'daemon_offline' };
  if (!aggregator.terminalProxyPortOf(sessionId) || typeof row.webPort !== 'number') {
    return { ok: false, status: 409, error: 'terminal_unavailable' };
  }
  return { ok: true };
}

/**
 * Read every currently-online daemon directly for the public dashboard
 * summary. The regular aggregator intentionally retains offline
 * rows for operator history, so using it here would make an offline bot's old
 * sessions or schedules look live. A failed or malformed daemon snapshot
 * rejects the whole projection instead of silently turning missing data into
 * zeroes.
 */
async function liveDashboardSummary(): Promise<ReturnType<typeof buildDashboardSummary>> {
  const daemons = registry.list();
  const configuredBots = loadBotConfigs();
  const snapshots = await Promise.all(daemons.map(async daemon => {
    const [sessionsResponse, schedulesResponse] = await Promise.all([
      fetchDaemonIpc(daemon.ipcPort, '/api/sessions', {
        signal: AbortSignal.timeout(2_000),
      }),
      fetchDaemonIpc(daemon.ipcPort, '/api/schedules', {
        signal: AbortSignal.timeout(2_000),
      }),
    ]);
    if (!sessionsResponse.ok || !schedulesResponse.ok) {
      throw new Error('daemon_snapshot_http_error');
    }
    const [sessionsBody, schedulesBody] = await Promise.all([
      sessionsResponse.json() as Promise<{ sessions?: unknown }>,
      schedulesResponse.json() as Promise<{ schedules?: unknown }>,
    ]);
    return parseDashboardSummaryRows({
      sessions: sessionsBody.sessions,
      schedules: schedulesBody.schedules,
    });
  }));

  return buildDashboardSummary({
    generatedAt: new Date(),
    configuredBotAppIds: configuredBots.map(bot => bot.larkAppId),
    onlineBotAppIds: daemons.map(daemon => daemon.larkAppId),
    sessions: snapshots.flatMap(snapshot => snapshot.sessions),
    schedules: snapshots.flatMap(snapshot => snapshot.schedules),
  });
}

const dashboardSummaryEndpoint = createDashboardSummaryEndpoint({
  load: liveDashboardSummary,
  onError: error => {
    logger.warn(`[dashboard-summary] live snapshot unavailable: ${error instanceof Error ? error.message : String(error)}`);
  },
});
let feedbackAnalyticsService: FeedbackAnalyticsService | undefined;
function analyticsService(): FeedbackAnalyticsService {
  return feedbackAnalyticsService ??= new FeedbackAnalyticsService(config.session.dataDir);
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

    // Health probe (no auth) — for pm2
    if (url.pathname === '/__health') {
      return jsonRes(res, 200, { ok: true });
    }

    // Loopback self-identification (no auth): echoes this process's nonce so the
    // post-bind shadow check (listen-with-probe verifyBound) can distinguish our
    // server from a process shadowing 127.0.0.1:port. Returns only the nonce.
    if (url.pathname === '/__selfcheck') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      return res.end(DASHBOARD_SELF_NONCE);
    }

    // Desktop shell compatibility probe (read-only, no token required). Keep it
    // outside the browser auth gate so packaged desktop apps can decide whether
    // this runtime speaks their dashboard protocol before loading the SPA.
    if (req.method === 'GET' && url.pathname === '/__desktop/compat') {
      const activeToken = currentDashboardToken();
      const presentedToken = authedToken(req, url, activeToken);
      const boundMachineId = activeToken && presentedToken === activeToken
        ? readPlatformBinding()?.machineId
        : null;
      const compatMachineId = compatMachineIdForAuthenticatedRequest(
        presentedToken,
        activeToken,
        boundMachineId,
      );
      handleDesktopCompat(req, res, url, { machineId: compatMachineId ?? undefined });
      return;
    }

    // Configurable Feishu/Lark H5 passwordless entry and code exchange. It is
    // self-authenticating and must run before the ordinary Dashboard cookie
    // gate; no authorization code or session capability is ever put in a URL.
    if (await dashboardH5Auth.handle(req, res, url)) return;

    // Session Web preview is an authenticated, same-origin reverse proxy to an
    // agent-registered literal loopback target. It owns its auth gate because
    // WebSocket upgrades do not pass through decideDashboardAuth; using one
    // manager for HTTP + WS keeps the cookie/ownership/SSRF contract identical.
    if (previewGuardPage.handle(req, res, url)) return;
    if (await sessionPreviewProxy.handleHttp(req, res, url)) return;

    // Web terminal reverse-proxy: `/s/<sessionId>/*` → the owning bot daemon's
    // terminal proxy. The central platform only tunnels the dashboard port, so
    // terminal links served under the machine subdomain
    // (`https://m-<id>.<host>/s/<sessionId>`) land here. The dashboard is the
    // aggregator process (it fronts many bot daemons, each with its own terminal
    // proxy on proxyBasePort+idx), so we resolve the session's owning daemon's
    // proxy port from the aggregator rows and forward there, streaming the
    // response straight back. Mounted before the dashboard auth gate because the
    // worker independently requires a view/write capability or authenticated
    // dashboard cookie before serving either HTTP or WebSocket terminal data.
    // Since P1-5 this hop is also LOAD-BEARING for revocation, not just
    // reachability: a signed view capability is checked here against live auth
    // sessions and countersigned for the worker, which refuses one that arrived
    // any other way. That is why the view-link API hands out a same-origin path
    // instead of the daemon/worker origin — this is the only door.
    if (terminalFrontProxy.handleHttp(req, res, url)) return;

    if (await handleWebhookRoute(req, res, url, {
      proxyToDaemon,
      createLifecycleGroup: createLifecycleGroupForWebhook,
    })) {
      return;
    }

    // (The legacy bmx_session /team page + pairing-login were removed; the team
    // platform now lives entirely in the SPA dashboard under the token gate —
    // see handleFederationSpokeApi below.)

    // Federation HUB endpoints — cross-deployment, self-authed by invite code /
    // syncToken, so mounted before the token gate (like webhook/team routes).
    // createTeamGroup injected for the delegate-group path (hub→spoke 拉群).
    if (await handleFederationApi(req, res, url, { createTeamGroup, transferTeamGroupOwner, liveBots })) {
      return;
    }

    // Route B: daemon internal API (`/__daemon/*`) — HMAC + loopback,
    // mounted BEFORE the browser cookie/token gate because this protocol is
    // entirely self-contained (the daemon caller has the shared secret and
    // the signing-envelope already binds method/path/body to the timestamp).
    // Letting the auth gate touch these paths would be wrong: there is no
    // cookie or token to set/check; the gate would either 401 the daemon
    // (false negative) or grant cross-protocol access (false positive).
    if (await daemonInternalApi.handle(req, res, url)) {
      return;
    }

    // OAuth 回调接收页（/oauth/callback）— 也在 cookie/token gate 之前：飞书
    // authorize 跳回来的浏览器请求不带 dashboard token（redirect_uri 固定），
    // 挡在门外用户就只能回到人肉贴 URL 的旧流程。安全面：URL 里只有一次性
    // code + 随机 state；处理方仍要求 state 命中某个 daemon 进程的 pending
    // 表（5 分钟过期、一次即焚）并用 app_secret 换 token——本页面自身不持有
    // 任何敏感能力，等价于把「用户手工回贴」自动化。
    if (req.method === 'GET' && url.pathname === '/oauth/callback') {
      const page = (title: string, body: string, ok: boolean) => {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><body style="font-family:system-ui;display:flex;align-items:center;justify-content:center;min-height:90vh;background:#f5f6f8"><div style="text-align:center;padding:32px 40px;background:#fff;border-radius:16px;box-shadow:0 4px 24px rgba(0,0,0,.08)"><div style="font-size:56px">${ok ? '✅' : '❌'}</div><h2 style="margin:12px 0 8px">${title}</h2><p style="color:#666;max-width:420px">${body}</p></div></body>`);
      };
      if (!url.searchParams.get('code') || !url.searchParams.get('state')) {
        page('回调参数缺失', '未收到授权码。请回到 Dashboard 重新发起授权。', false);
        return;
      }
      // state 只在生成链接的那个 daemon 进程内存里，逐个询问在线 daemon。
      let outcome: { ok: boolean; message: string } | null = null;
      for (const d of registry.list()) {
        try {
          const r = await fetchDaemonIpc(d.ipcPort, '/api/oauth-callback', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ url: url.toString() }),
          });
          const j: any = await r.json().catch(() => null);
          if (j?.matched) { outcome = { ok: !!j.ok, message: String(j.message ?? '') }; break; }
        } catch { /* daemon offline mid-iteration — try the next */ }
      }
      if (!outcome) {
        page('授权未完成', '没有找到等待中的授权请求（可能已超时，链接有效期 5 分钟）。请回到 Dashboard 重新点击授权。', false);
        return;
      }
      page(
        outcome.ok ? '授权完成' : '授权失败',
        outcome.ok ? '已完成授权，本页可以关闭。回到 Dashboard 即可看到状态更新。' : outcome.message,
        outcome.ok,
      );
      return;
    }

    // CLI rotate (HMAC + loopback only) — for `botmux dashboard rotate`.
    // Publish the new token only after a durable write succeeds.
    if (req.method === 'POST' && url.pathname === '/__cli/rotate') {
      const gate = verifyCliRequest(req, url.pathname);
      if (!gate.ok) return jsonRes(res, gate.status, gate.body);
      const previousToken = currentDashboardToken();
      try {
        const token = rotatePersistedToken(TOKEN_PATH);
        // The previous link is dead once the write lands: drop terminal control
        // leases, re-lock preview interaction, and (P1-8) close every long-lived
        // connection the old link opened — otherwise the old management SSE
        // keeps streaming rows minted AFTER the rotation, including freshly
        // issued `riffAccessUrl` write credentials.
        // Ordered after the durable write so a failed rotation keeps both the
        // old token and its live grants intact.
        if (previousToken && previousToken !== token) {
          endDashboardAuthSession(legacyDashboardAuthSessionId(previousToken));
        }
        // P1-6: the same reasoning covers the workbench entry tickets sitting in
        // Feishu card history. They redeem into "whatever token is active now",
        // so without this a ticket leaked BEFORE the rotation would hand out the
        // freshly minted management cookie — rotation would protect nothing in
        // exactly the case it is used for. Ticket verification independently
        // requires the bound generation to still be current, so this call is the
        // cleanup (drop dead rows from the shared file), not the guarantee.
        revokeWorkbenchTicketsOutsideGeneration(workbenchTicketGeneration(token));
        return jsonRes(res, 200, dashboardUrlsFor(token));
      } catch (e) {
        logger.warn(`[dashboard] Failed to persist token to ${TOKEN_PATH}: ${(e as Error).message}`);
        return jsonRes(res, 500, describeDashboardTokenError('token_persist_failed', e, TOKEN_PATH));
      }
    }

    // CLI get-or-create URL (HMAC + loopback only). Existing links survive
    // untouched; the first caller atomically creates and persists a token.
    if (req.method === 'POST' && url.pathname === '/__cli/ensure') {
      const gate = verifyCliRequest(req, url.pathname);
      if (!gate.ok) return jsonRes(res, gate.status, gate.body);
      try {
        const token = loadOrCreatePersistedToken(TOKEN_PATH);
        return jsonRes(res, 200, dashboardUrlsFor(token));
      } catch (e) {
        logger.warn(`[dashboard] Failed to ensure token at ${TOKEN_PATH}: ${(e as Error).message}`);
        return jsonRes(res, 500, describeDashboardTokenError('token_persist_failed', e, TOKEN_PATH));
      }
    }

    // CLI read current URL (HMAC + loopback only) — for start/restart hints and
    // safe port discovery. This never mints a token.
    if (req.method === 'POST' && url.pathname === '/__cli/current') {
      const gate = verifyCliRequest(req, url.pathname);
      if (!gate.ok) return jsonRes(res, gate.status, gate.body);
      let token: string | null;
      try {
        token = loadPersistedToken(TOKEN_PATH);
      } catch (e) {
        logger.warn(`[dashboard] Failed to read token from ${TOKEN_PATH}: ${(e as Error).message}`);
        return jsonRes(res, 500, describeDashboardTokenError('token_unavailable', e, TOKEN_PATH));
      }
      if (!token) return jsonRes(res, 404, { error: 'no_active_token' });
      return jsonRes(res, 200, dashboardUrlsFor(token));
    }

    // CLI 通知绑定变化（HMAC + loopback）——`botmux bind` 写完绑定后捅一下，立即重连平台，
    // 无需重启 daemon，也不依赖 fs.watch。
    if (req.method === 'POST' && url.pathname === '/__cli/reload-binding') {
      const gate = verifyCliRequest(req, url.pathname);
      if (!gate.ok) return jsonRes(res, gate.status, gate.body);
      // `botmux bind` wrote platform.json + (default-on) remoteAccess in the CLI
      // process; this dashboard process holds a short-TTL config cache that may
      // still read the pre-bind value. Drop it so the immediately-following
      // /__cli/current (and live card links) resolve the platform dashboard URL.
      invalidateGlobalConfigCache();
      try {
        platformTunnel?.stop();
      } catch {
        /* ignore */
      }
      platformTunnel = null;
      // P1-8：解绑/改绑之后旧平台身份的短请求立刻 401，但它建立的 SSE / Preview
      // 长连接不会自己断，三个角色作用域在这里一起收口。
      syncPlatformBindingRevocation();
      startPlatformTunnelIfBound();
      return jsonRes(res, 200, { ok: true });
    }

    const activeToken = currentDashboardToken();
    const requestIdentity = dashboardRequestIdentity(req);
    const globalDashboardConfig = readGlobalConfig().dashboard;
    const publicReadOnly = globalDashboardConfig?.publicReadOnly
      ?? config.dashboard.publicReadOnly;
    // P1-7：门禁选择与身份判定同源。旧代码在这里另算一遍 `h5Identity`，于是
    // 「legacy owner + H5 cookie 并存」的浏览器被判成 workbench-only，管理读写
    // 全 401，连正确的 `?t=` 也被一起清掉（详见 request-identity.ts 顶注）。
    // Only the local legacy Dashboard cookie is management authority. Platform
    // identities — owner included — retain terminal/preview capability through
    // signed proxy grants, but cannot cross into host administration APIs.
    const { legacyAuthed, workbenchOnlyIdentity, decision } = resolveDashboardRequestGate({
      method: req.method ?? 'GET',
      pathname: url.pathname,
      hasTokenParam: url.searchParams.has('t'),
      identity: requestIdentity,
      tokenFromRequest: authedToken(req, url, activeToken),
      activeToken,
      publicReadOnly,
    });
    // `authed` is deliberately the local management capability, not merely a
    // valid Workbench/platform identity. Privileged mutations and management
    // reads (settings, schedules, groups) therefore cannot be widened by H5
    // authentication.
    const authed = legacyAuthed;
    // The session board is the one surface where `!authed` must NOT mean
    // "anonymous". `/api/sessions` and `/events` are exactly the two paths
    // workbenchH5Capability grants as `workbench.view`, and the same identity
    // holds `preview.view`/`preview.operate`; reusing the anonymous projection
    // here deleted the `preview` descriptor those capabilities operate on, so
    // the mobile Workbench and the Dock showed 「无网页预览」 unconditionally.
    // The three-way audience keeps management/anonymous behavior byte-identical
    // and only restores display fields for an authenticated Workbench viewer —
    // the Riff sandbox bearer write URL stays stripped (see public-redact.ts).
    const sessionBoardAudience = sessionBoardAudienceFor({
      legacyAuthed,
      workbenchIdentity: workbenchOnlyIdentity,
    });

    if (decision.kind === 'deny401') {
      const loginUrl = buildPlatformDashboardLoginUrl();
      res.writeHead(401, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        // A valid H5/platform Workbench identity is expected to be denied by
        // management-only endpoints such as /api/settings. Let the SPA tell
        // that narrow denial from an expired identity, otherwise its global
        // fetch wrapper covers a healthy Workbench with the login overlay.
        ...(workbenchOnlyIdentity ? { 'x-botmux-auth-scope': 'workbench' } : {}),
        ...(loginUrl ? { 'x-botmux-login-url': loginUrl } : {}),
      });
      res.end('<h1>Token expired</h1><p>Run <code>botmux dashboard</code> to get a fresh URL.</p>');
      return;
    }

    if (decision.kind === 'allow+set-cookie') {
      res.writeHead(302, {
        'set-cookie': buildSetCookie(decision.token),
        'location': decision.redirectTo,
      });
      res.end();
      return;
    }

    // P2-1：飞书卡片「打开工作台」按钮的短时票据兑换，紧挨上面的 ?t= set-cookie
    // 流程——语义同款：验票通过就种同一个 legacy cookie，再 302 进工作台。票据由
    // /dashboard 卡片构建时现 mint（TTL 30 分钟、可多端重复打开，落盘只存 hash，
    // 见 dashboard/workbench-ticket.ts），长期管理 token 从此不再写进持久化卡片；
    // 无效/过期回一个无凭据中文提示页。该 GET 在 decideDashboardAuth 里与静态壳
    // 同级放行（票据本身就是凭证），其余方法不豁免。P1-10：正因为它在 auth gate
    // 之前放行，端点自带每 IP + 全局限流，IP 口径与 H5 兑换口共用同一份可信代理
    // 配置——否则两个公开面对同一个 `x-forwarded-for` 会得出不同结论。
    if (handleWorkbenchTicketRedemption(req, res, url, {
      activeToken: () => activeToken,
      trustedProxyHops: dashboardH5AuthConfig.trustedProxyHops,
    })) {
      return;
    }

    if (url.pathname === '/api/workflows' || url.pathname.startsWith('/api/workflows/')) {
      return jsonRes(res, 410, {
        ok: false,
        error: 'legacy_workflow_retired',
        message: 'v2 workflow dashboard APIs are retired; use /api/v3/runs for v3 run visibility',
      });
    }

    // Authenticated, non-secret metadata used only to build Feishu appCenter
    // and >=350px sidebar AppLinks. App secret and allowlist never cross this
    // projection; the route is intentionally absent from public-read allowlists.
    if (req.method === 'GET' && url.pathname === '/api/workbench/h5-context') {
      return jsonRes(res, 200, {
        ok: true,
        h5: {
          enabled: dashboardH5AuthConfig.enabled,
          appId: dashboardH5AuthConfig.appId,
          brand: dashboardH5AuthConfig.brand,
          entryPath: dashboardH5AuthConfig.entryPath,
        },
      });
    }

    // P1-4：最小操作能力集投影。前端只据此渲染操作入口（定位 / 接管输入 / 开启
    // 交互），投影函数复算的是本文件三条真实路由的同一套门禁（路由级 auth 决策 +
    // terminalCapability/previewCapability 角色检查），见 auth.ts 的函数注释。
    // 匿名请求到不了这里（该路径不在 publicReadOnly 白名单，decideDashboardAuth
    // 已 401）；前端把任何非 200/缺字段一律回落为全 false。注意 canControl 只描述
    // 无显式 token 的默认能力——显式 write token 走终端前置代理的独立授权（P1-6），
    // 与本投影无关。
    if (req.method === 'GET' && url.pathname === '/api/workbench/capabilities') {
      return jsonRes(res, 200, {
        ok: true,
        capabilities: projectWorkbenchOperationCapabilities(requestIdentity),
      });
    }

    // owner 在工作台内自取常驻链接（`<base>/workbench?t=<当前活跃 token>`）。
    // 只有本机完整管理身份能取：上面的门禁已经把 workbench-only / 平台角色 /
    // 匿名 deny401，处理器再自己判一次 kind === 'legacy-dashboard'（两层独立，
    // 见 dashboard/standing-link.ts 顶注）。同源校验 + no-store + 每次落一条
    // `auth.standing_link_issued` 审计；token 现读落盘的活跃值，所以
    // `dashboard rotate` 之后这里自然发新链接。
    if (handleWorkbenchStandingLink(req, res, url, {
      identity: requestIdentity,
      activeToken: () => activeToken,
      standingLinkUrl: token => workbenchEntryUrl(dashboardUrlsFor(token).url),
      audit: dashboardControlAudit,
    })) {
      return;
    }

    // Server-authoritative terminal control lease. The API returns only mode
    // and timestamps; its signed read/write grant stays inside the central
    // proxy and is never placed in a URL or response body.
    //
    // The dispatch itself lives in dashboard/terminal-control-route.ts — the ONE
    // implementation that the acceptance scripts drive as well. It used to be
    // inlined here, and the copy in the scripts drifted: they read the `?expect=`
    // compare-and-swap condition while this one did not, so conditional release
    // never actually applied in production.
    const terminalControlMatch = matchTerminalControlRoute(url.pathname);
    if (terminalControlMatch) {
      if (!requestIdentity) {
        return dashboardControlJson(res, 401, { ok: false, error: 'authentication_required' });
      }
      if (!enforceControlCsrf(req, res, requestIdentity)) return;
      if (!terminalControlMatch.ok) {
        return dashboardControlJson(res, 400, { ok: false, error: terminalControlMatch.error });
      }
      const sessionId = terminalControlMatch.sessionId;
      const availability = terminalControlAvailability(sessionId);
      if (!availability.ok) {
        return dashboardControlJson(res, availability.status, { ok: false, error: availability.error });
      }
      const answer = resolveTerminalControlAction({
        method: req.method ?? 'GET',
        action: terminalControlMatch.action,
        sessionId,
        search: url.searchParams,
        identity: requestIdentity,
        control: terminalControl,
      });
      return dashboardControlJson(res, answer.status, answer.body);
    }

    // Preview interaction is separately scoped per authenticated browser
    // session. Default is always the visibly labelled preview overlay; unlock
    // and activity are explicit, and the server hard-relocks after 15m idle.
    const controlMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/preview-interaction(?:\/(unlock|activity|lock))?$/);
    if (controlMatch) {
      if (!requestIdentity) {
        return dashboardControlJson(res, 401, { ok: false, error: 'authentication_required' });
      }
      if (!enforceControlCsrf(req, res, requestIdentity)) return;
      let sessionId: string;
      try { sessionId = decodeURIComponent(controlMatch[1]); }
      catch { return dashboardControlJson(res, 400, { ok: false, error: 'invalid_session_id' }); }
      const resolution = resolveDashboardSessionPreview(sessionId);
      if (!resolution.ok) {
        return dashboardControlJson(res, resolution.status, { ok: false, error: resolution.error });
      }
      const action = controlMatch[2];
      if (req.method === 'GET' && !action) {
        return dashboardControlJson(res, 200, { ok: true, ...previewInteraction.state(requestIdentity, sessionId) });
      }
      // 唯一权威的角色门禁。guard 壳与工作台是否渲染解锁按钮，走的是同一个
      // previewInteractionWriteAllowed（经 canInteract 投影），所以「按能力隐藏
      // 按钮」永远只是把一次必然 403 的点击省掉，不会替代这里的检查。
      if (!previewInteractionWriteAllowed(requestIdentity)) {
        return dashboardControlJson(res, 403, { ok: false, error: 'preview_operation_forbidden' });
      }
      if (req.method === 'POST' && action === 'unlock') {
        return dashboardControlJson(res, 200, { ok: true, ...previewInteraction.unlock(requestIdentity, sessionId) });
      }
      if (req.method === 'POST' && action === 'activity') {
        return dashboardControlJson(res, 200, { ok: true, ...previewInteraction.activity(requestIdentity, sessionId) });
      }
      if (req.method === 'POST' && action === 'lock') {
        return dashboardControlJson(res, 200, { ok: true, ...previewInteraction.lock(requestIdentity, sessionId) });
      }
      return dashboardControlJson(res, 405, { ok: false, error: 'method_not_allowed' });
    }

    if (url.pathname.startsWith('/api/feedback/analytics/')) {
      await handleFeedbackAnalyticsApi(req, res, url, { service: analyticsService() });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/__dev/reload') {
      if (!dashboardDevReloadEnabled()) return jsonRes(res, 404, { error: 'dev_reload_disabled' });
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
      });
      let last = dashboardDevReloadVersion();
      res.write(`event: ready\ndata: ${JSON.stringify({ version: last })}\n\n`);
      const timer = setInterval(() => {
        const next = dashboardDevReloadVersion();
        if (!next || next === last) return;
        last = next;
        res.write(`event: reload\ndata: ${JSON.stringify({ version: next })}\n\n`);
      }, 500);
      req.on('close', () => clearInterval(timer));
      return;
    }

    if ((url.pathname === '/api/plugins' || url.pathname.startsWith('/api/plugins/'))
      && await handlePluginManagementApi(req, res, url)) {
      return;
    }

    // 调试终端（owner-only）：HTTP 路由挂在 auth gate 之后 → 已确保是管理 token。
    // /api/debug-terminal（创建/关闭）+ /debug-terminal/<id>（xterm 页面）。
    // WS 升级 /debug-terminal/<id>/ws 在下方 server.on('upgrade') 里由本 manager
    // 自行校验 cookie（upgrade 不经这段 gate）。
    if (
      url.pathname === '/api/debug-terminal'
      || url.pathname.startsWith('/api/debug-terminal/')
      || url.pathname.startsWith('/debug-terminal/')
    ) {
      // H5 sessions are scoped to Dashboard/workbench control. They never
      // inherit the legacy owner's unrestricted debug shell.
      if (!legacyAuthed) return jsonRes(res, 403, { ok: false, error: 'legacy_owner_required' });
      if (debugTerminalManager.handleHttp(req, res, url)) return;
    }

    if (req.method === 'GET' && url.pathname === '/api/plugins/dashboard') {
      return jsonRes(res, 200, { plugins: listDashboardPluginEntries() });
    }

    if (req.method === 'GET' && url.pathname.startsWith('/plugins/')) {
      if (servePluginStatic(res, url.pathname)) return;
      res.writeHead(404); res.end(); return;
    }

    // Fragment-free entry points. The card's terminal AppLink works with a plain
    // `/s/<id>?token=` URL; ours carried `#/agent-workbench`, and a fragment is
    // the one structural difference between the two. Clients that re-encode or
    // truncate an AppLink's `url` lose it and land on the Dashboard home, so
    // offer a path that survives regardless.
    if ((req.method === 'GET' || req.method === 'HEAD')
      && (url.pathname === '/workbench' || url.pathname === '/workbench/dock')) {
      const target = url.pathname === '/workbench/dock' ? '#/agent-workbench-dock' : '#/agent-workbench';
      const token = url.searchParams.get('t');
      const query = token ? `?t=${encodeURIComponent(token)}` : '';
      res.writeHead(302, { location: `/${query}${target}`, 'cache-control': 'no-store' });
      res.end();
      return;
    }

    // Self-service diagnostics for the same phone that cannot render the
    // Workbench terminal. Desktop browsers and Chromium's mobile emulation both
    // succeed, so the failing device has to report its own conditions: which
    // build it cached, whether its cookie rides along, whether the terminal's
    // HTTP and WebSocket hops are reachable from its network. Zero external
    // resources and no SPA bundle — it must open precisely when the SPA cannot,
    // which is also why it is allow-listed beside the static shell in
    // `decideDashboardAuth`. It probes only the visitor's own reachability and
    // echoes no token or secret.
    if (handleWorkbenchDoctor(req, res, url)) return;

    // Installable Workbench: Feishu has no way to pin a custom app into its
    // mobile tab bar, so the closest thing to a permanent entry is the phone's
    // own home screen. A manifest makes "add to home screen" launch straight
    // into the session list, standalone and chrome-less.
    if ((req.method === 'GET' || req.method === 'HEAD') && url.pathname === '/workbench.webmanifest') {
      const manifest = {
        name: 'Botmux Workbench',
        short_name: 'Workbench',
        start_url: '/#/agent-workbench',
        scope: '/',
        display: 'standalone',
        orientation: 'any',
        background_color: '#080b10',
        theme_color: '#080b10',
        icons: [
          { src: '/apple-touch-icon.png', sizes: '180x180', type: 'image/png' },
          { src: '/favicon.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
        ],
      };
      res.writeHead(200, { 'content-type': 'application/manifest+json', 'cache-control': 'no-cache' });
      res.end(JSON.stringify(manifest));
      return;
    }

    // ─── Static frontend (index.html + /assets/* + /game/* + root icons) ───
    if (
      (req.method === 'GET' || req.method === 'HEAD') &&
      (
        url.pathname === '/' ||
        url.pathname === '/favicon.ico' ||
        url.pathname === '/favicon.png' ||
        url.pathname === '/apple-touch-icon.png' ||
        url.pathname.startsWith('/assets/') ||
        url.pathname.startsWith('/game/')
      )
    ) {
      // HD2D runtime binaries (index.wasm / index.pck) are NOT shipped — they
      // are downloaded on demand into the cache dir and served from there.
      // Everything else under /game/ is the small shell shipped in dist.
      if (url.pathname === '/game/index.wasm' || url.pathname === '/game/index.pck') {
        const fp = hd2dAssetPath(url.pathname.slice('/game/'.length));
        if (fp && serveFileAbs(res, fp)) return;
        res.writeHead(404); res.end(); return;
      }
      // Map /assets/foo.js → WEB_DIR/foo.js; /favicon.ico is an alias for the PNG favicon.
      const lookupPath = url.pathname.startsWith('/assets/')
        ? '/' + url.pathname.slice(8)
        : url.pathname === '/favicon.ico'
          ? '/favicon.png'
        : url.pathname;
      if (serveStatic(req, res, lookupPath, {
        // P1-11：只给已认证身份签票据；匿名 public-read 壳不含票据，控制类端点
        // 对它本来就 401/403。
        injectHtml: requestIdentity
          ? html => injectControlCsrfMeta(html, controlCsrfTokens.mint(requestIdentity.authSessionId))
          : undefined,
      })) return;
      if (serveMissingDashboardChunkModule(req, res, lookupPath)) return;
    }

    // ─── HD2D office assets (token-gated: download triggers a ~74MB fetch) ──
    if (req.method === 'GET' && url.pathname === '/api/game/status') {
      // `proxy` prefills the office tab's optional proxy input (config value
      // only; an env-var proxy still works as a silent fallback downstream).
      return jsonRes(res, 200, { ...hd2dStatus(), proxy: readGlobalConfig().httpProxy ?? '' });
    }
    if (req.method === 'POST' && url.pathname === '/api/game/download') {
      // Optional `proxy` in the body is persisted (so it survives restart) and
      // takes effect immediately for this download — Node's fetch ignores the
      // proxy env vars, so hosts behind a proxy set it here.
      let body: unknown;
      try { body = await readJsonBody(req); } catch { body = undefined; }
      if (body && typeof body === 'object' && 'proxy' in body) {
        const raw = (body as { proxy?: unknown }).proxy;
        const proxy = typeof raw === 'string' ? raw.trim() : '';
        mergeGlobalConfig({ httpProxy: proxy || null });
      }
      return jsonRes(res, 200, startHd2dDownload());
    }

    // ─── Public API (cookie/token already validated above) ──────────────────

    if (req.method === 'GET' && url.pathname === '/api/dashboard/v1/summary') {
      const result = await dashboardSummaryEndpoint.get({ authenticated: authed });
      for (const [name, value] of Object.entries(result.headers)) res.setHeader(name, value);
      return jsonRes(res, result.status, result.body);
    }

    if (await handleResourceMonitorApi(req, res, url, resourceMonitor)) {
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/sessions') {
      // Sessions spawned before a bot config carried a display name store the
      // raw appId as botName — resolve through the live registry so consumers
      // (dashboard, HD2D office tab) always see the human-facing name.
      const names = new Map([...registry.list()].map(d => [d.larkAppId, d.botName] as const));
      groupsMatrixSnapshot.warm();
      const sessions = enrichSessionsWithGroupNames(aggregator.getSessions().map(s => {
        const n = names.get(s.larkAppId);
        return n && n !== s.larkAppId && (!s.botName || s.botName === s.larkAppId)
          ? { ...s, botName: n }
          : s;
      }), groupsMatrixSnapshot.peekPresentation());
      const browserSessions = projectSessionPreviewsForBrowser(sessions);
      return jsonRes(res, 200, {
        sessions: projectSessionsForAudience(browserSessions, sessionBoardAudience),
      });
    }

    // Desktop / operator UI: aggregate pending ask-hooks across daemons.
    if (req.method === 'GET' && url.pathname === '/api/asks/pending') {
      const daemons = registry.list();
      const asks: unknown[] = [];
      await Promise.all(daemons.map(async (d) => {
        try {
          const upstream = await fetchDaemonIpc(d.ipcPort, '/api/asks/pending', {
            signal: AbortSignal.timeout(2_000),
          });
          if (!upstream.ok) return;
          const body = await upstream.json() as { asks?: unknown[] };
          for (const a of body.asks ?? []) {
            asks.push({
              ...(typeof a === 'object' && a ? a : {}),
              botName: d.botName,
              larkAppId: d.larkAppId,
            });
          }
        } catch {
          /* offline daemon */
        }
      }));
      return jsonRes(res, 200, { asks });
    }

    if (req.method === 'POST' && url.pathname === '/api/asks/answer') {
      let body: unknown;
      try {
        body = await readJsonBody(req);
      } catch {
        return jsonRes(res, 400, { ok: false, error: 'bad_json' });
      }
      const parsed = parseDashboardAskAnswerRequest(body);
      if (!parsed.ok) {
        return jsonRes(res, 400, { ok: false, error: parsed.error });
      }
      const upstream = await proxyDashboardAskAnswer(parsed.value, proxyToDaemon);
      res.writeHead(upstream.status, { 'content-type': upstream.contentType });
      res.end(upstream.body);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/sessions/cleanup-idle') {
      let body: { olderThanHours?: unknown; sessionIds?: unknown };
      try {
        body = await readJsonBody(req) as { olderThanHours?: unknown; sessionIds?: unknown };
      } catch {
        return jsonRes(res, 400, { ok: false, error: 'bad_json' });
      }
      const olderThanHours = parseIdleCleanupHours(body?.olderThanHours);
      if (!olderThanHours) return jsonRes(res, 400, { ok: false, error: 'invalid_threshold' });

      // WYSIWYG: the UI scopes cleanup to the rows currently visible under the
      // page filters and sends their sessionIds, so the closed set matches the
      // confirmed count. We still hand the scoped rows to cleanupIdleSessions,
      // which re-validates each is a genuine idle candidate — a stale/forged id
      // can never close a non-idle session. Omitting sessionIds (e.g. an older
      // client) falls back to a deployment-wide sweep. Cap the id set so a giant
      // body can't blow up the Set build.
      const idScope = Array.isArray(body?.sessionIds)
        ? new Set((body.sessionIds as unknown[]).slice(0, 10000).map(String))
        : null;
      const rows = aggregator.getSessions();
      const scoped = idScope ? rows.filter(s => idScope.has(s.sessionId)) : rows;

      const result = await cleanupIdleSessions(scoped, olderThanHours, async s => {
        try {
          const upstream = await proxyToDaemon(
            s.larkAppId as string,
            `/api/sessions/${encodeURIComponent(s.sessionId)}/close`,
            { method: 'POST' },
          );
          const text = await upstream.text();
          let parsed: any = null;
          try { parsed = JSON.parse(text); } catch { /* tolerate */ }
          // The daemon close route always replies 200 {ok:true}; treat anything
          // else (incl. an unparseable/missing body) as a failure rather than a
          // silent success.
          const ok = upstream.ok && parsed?.ok === true;
          // A residual is NOT a failure (the row closed) but must not be counted
          // as a clean close either: an idle/workerless mojo row can carry a
          // parked lineage, so this path really does produce them.
          const residual = ok ? parseCloseResidual(parsed) : undefined;
          return {
            sessionId: s.sessionId,
            ok,
            ...(residual ? { residual } : {}),
            error: ok ? undefined : (parsed?.error ?? `http_${upstream.status}`),
          };
        } catch (e: any) {
          return { sessionId: s.sessionId, ok: false, error: e?.message ?? String(e) };
        }
      });
      return jsonRes(res, 200, result);
    }
    if (req.method === 'GET' && url.pathname === '/api/insights/summary') {
      const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') ?? '200', 10) || 200, 1), 500);
      // Per-daemon timeout + isolate failures: an upstream insight parse can be
      // heavy, so a slow/hung daemon must not stall the aggregated summary. A
      // timed-out / errored chunk drops to null and is filtered out below.
      const chunks = await Promise.all(registry.list().map(async d => {
        try {
          const upstream = await proxyToDaemon(d.larkAppId, `/api/insights/summary?limit=${limit}`, {
            method: 'GET',
            signal: AbortSignal.timeout(INSIGHT_FANOUT_TIMEOUT_MS),
          });
          if (!upstream.ok) return null;
          const body = await upstream.json().catch(() => null) as { overview?: SafeInsightOverview } | null;
          return body?.overview ?? null;
        } catch {
          return null;
        }
      }));
      const overview = mergeSafeInsightOverviews(chunks.filter((x): x is SafeInsightOverview => !!x), { limit });
      return jsonRes(res, 200, { ok: true, overview });
    }
    if (req.method === 'GET' && url.pathname === '/api/schedules') {
      // Public-read carve-out: the row carries CONTENT (prompt = business
      // instructions) and a bound `workingDir` (repo/customer path) — strip
      // both for anonymous visitors. The schedules page only renders
      // name/timing/status, so nothing degrades.
      const schedules = authed
        ? aggregator.getSchedules()
        : redactSchedulesForPublic(aggregator.getSchedules());
      // Effective schedule timezone: nextRunAt/lastRunAt instants must be
      // rendered in the zone the scheduler fires in (not the viewer's browser
      // zone), so the web schedule/overview lists match cron/card/CLI displays.
      return jsonRes(res, 200, { schedules, timezone: scheduleTimeZone() });
    }
    if (req.method === 'GET' && url.pathname === '/api/settings') {
      const dashboardSettings = resolveDashboardSettings();
      // `authed` lets the Settings page disable toggles for read-only
      // visitors up front, instead of letting them flip a switch that
      // 401s + rolls back on save.
      // `lang` is the global UI locale (single source of truth shared with
      // `botmux lang` and the Feishu cards) — the web UI reads it as its
      // authoritative initial language when set.
      // `bound` reflects central-platform binding; the Settings UI only shows the
      // 远程访问 toggle when bound (the central URLs are meaningless otherwise).
      return jsonRes(res, 200, {
        settings: authed ? dashboardSettings : redactSettingsForPublic(dashboardSettings),
        lang: readGlobalConfig().lang ?? null,
        authed,
        bound: readPlatformBinding() !== null,
      });
    }
    if (req.method === 'PUT' && url.pathname === '/api/settings') {
      let parsed: unknown;
      try {
        parsed = await readJsonBody(req);
      } catch {
        return jsonRes(res, 400, { ok: false, error: 'bad_json' });
      }
      const result = await applySettingsWrite(parsed, settingsWriteApplierDeps);
      if (!result.ok) {
        const body: Record<string, unknown> = { ok: false, error: result.error };
        if ('feishuLoginQr' in result && result.feishuLoginQr) body.feishuLoginQr = result.feishuLoginQr;
        return jsonRes(res, 400, body);
      }
      // Opt-in TraeX herdr plugin: when this write enabled it (with a spec),
      // install right away instead of waiting for the next daemon restart, and
      // echo the outcome back so the SPA can toast success/failure. No-op for
      // any settings write that didn't touch herdrTraexPlugin (or left it off /
      // spec-less). Runs in-daemon (herdr on PATH here); never throws.
      const herdrTraexInstall = await maybeInstallTraexPluginOnSettingsChange(
        typeof parsed === 'object' && parsed !== null && 'herdrTraexPlugin' in parsed,
        result.settings.herdrTraexPlugin,
      );
      return jsonRes(res, 200, herdrTraexInstall
        ? { ok: true, settings: result.settings, herdrTraexInstall }
        : { ok: true, settings: result.settings });
    }

    if (req.method === 'GET' && url.pathname === '/api/autostart') {
      if (!authed) return jsonRes(res, 401, { ok: false, error: 'unauthorized' });
      res.setHeader('cache-control', 'no-store');
      return jsonRes(res, 200, { ok: true, state: await dashboardAutostart.getState() });
    }
    if (req.method === 'PUT' && url.pathname === '/api/autostart') {
      if (!authed) return jsonRes(res, 401, { ok: false, error: 'unauthorized' });
      res.setHeader('cache-control', 'no-store');
      let body: unknown;
      try {
        body = await readJsonBody(req);
      } catch {
        return jsonRes(res, 400, { ok: false, error: 'bad_json' });
      }
      const parsed = parseAutostartWrite(body);
      if (!parsed.ok) return jsonRes(res, 400, { ok: false, error: 'invalid_body' });
      try {
        const state = await dashboardAutostart.setEnabled(parsed.enabled);
        return jsonRes(res, 200, { ok: true, state });
      } catch (error) {
        if (error instanceof DashboardAutostartError) {
          logger.warn(`[dashboard-autostart] ${error.code}: ${error.message}`);
          return jsonRes(res, dashboardAutostartErrorStatus(error), {
            ok: false,
            error: error.code,
          });
        }
        throw error;
      }
    }

    // ─── Version & manual update ─────────────────────────────────────────────
    // Global package updates and a host restart are privileged: none of these paths
    // are on PUBLIC_READ_PATHS, so decideDashboardAuth already 401s an
    // unauthenticated caller (in both normal and public-read mode). The explicit
    // `authed` guards on the two mutations are defense-in-depth for host actions.
    if (req.method === 'GET' && url.pathname === '/api/update/status') {
      const current = currentInstalledVersion();
      // Display/classification only — deliberately NOT a plan root. It feeds
      // `currentUpdateStrategy` (which handles the compiled binary's "/" correctly)
      // and the manager label shown when nothing else resolves. Named distinctly from
      // the `packageRoot` variables that DO reach resolveGlobalInstallPlan, so the two
      // uses cannot be confused (and so the source guard in
      // test/binary-self-update.test.ts can tell them apart).
      const classifyRoot = lastSuccessfulUpdatePlan?.activePackageRoot ?? botmuxInstallRoot();
      const installManager = detectGlobalInstallManager(classifyRoot);
      // A compiled binary has no package.json, so `classifyRoot` is "/" and the
      // plan resolution always fails — which used to grey out the update button
      // and tell an npm user their install method is unsupported. Resolve the
      // strategy by BINARY LOCATION first; only fall back to the package-root
      // classification for the Node path (unchanged there).
      const updateStrategy = currentUpdateStrategy(classifyRoot);
      const installPlan = updateStrategy.kind === 'package-manager'
        ? tryResolveGlobalInstallPlan(updateStrategy.packageRoot)
        : null;
      const selfReplace = updateStrategy.kind === 'self-replace';
      // Compare against the npm `latest` dist-tag (always stable; the update
      // button installs `@latest`). isNewerVersion uses semver precedence, so a
      // canary running AHEAD of the latest stable (e.g. 2.87.0-canary.0 vs
      // 2.86.0) is NOT flagged behind — exactly the canary case we want.
      const latestResult = await cachedLatestVersion(url.searchParams.get('refresh') === '1');
      const latest = latestResult.value;
      let configuredUpdateTargets: ReturnType<typeof selectCodexRuntimeUpdateTargets> = [];
      try {
        configuredUpdateTargets = selectCodexRuntimeUpdateTargets(
          loadBotConfigs(),
          (cliPathOverride) => createCliAdapterSync('codex', cliPathOverride).resolvedBin,
        );
      } catch {
        // Config unreadable or an adapter unavailable: fail closed and hide
        // persisted badges whose continued relevance cannot be established.
      }
      const cliUpdates = filterCliRuntimeUpdateEntriesForTargets(
        listCliRuntimeUpdateEntries(config.session.dataDir),
        configuredUpdateTargets,
      ).map((entry) => ({
        cliId: entry.cliId,
        runtimeId: entry.runtimeId,
        displayName: entry.displayName,
        binPath: entry.binPath,
        provider: entry.provider,
        managed: entry.managed,
        current: entry.current,
        latest: entry.latest,
        updateAvailable: entry.updateAvailable,
        updateCommand: entry.updateCommand,
        ...(entry.installTarget ? { installTarget: entry.installTarget } : {}),
        lastCheckedAt: entry.lastCheckedAt,
      }));
      const localDev = isLocalDevInstall();
      return jsonRes(res, 200, {
        current,
        latest,
        versionLookupOk: latestResult.lookupOk,
        behind: !!latest && isNewerVersion(latest, current),
        cliBehind: cliUpdates.some((entry) => entry.updateAvailable),
        cliUpdates,
        localDevInstall: localDev,
        // Local-dev can self-update via git pull + build only when the checkout
        // the wrapper points at is a real git worktree; otherwise the button
        // stays disabled (there is nothing to pull).
        localDevUpdatable: localDev && isGitWorktree(resolveLocalDevCheckoutDir()),
        updateSupported: installPlan !== null || selfReplace,
        // Rollback is a SEPARATE capability from update. The web UI used to derive
        // it from `updateSupported`, which now includes the self-replacing binary —
        // but /api/update/rollback only knows how to drive a package manager, so a
        // curl-installed binary would be offered a button that always fails.
        // Report it explicitly instead of letting the UI infer it.
        rollbackSupported: installPlan !== null,
        // The standalone binary is not owned by a package manager; report it as
        // its own kind rather than letting the UI claim "npm/pnpm/Bun only".
        updateManager: selfReplace ? 'binary' : (installPlan?.manager ?? installManager),
        updateCommand: selfReplace
          ? `botmux update（下载并替换 ${updateStrategy.target}）`
          : installPlan ? formatGlobalInstallCommand(installPlan) : null,
        node: checkNode(),
        installs: detectBotmuxInstalls(),
      });
    }

    if (req.method === 'GET' && url.pathname === '/api/update/versions') {
      const current = currentInstalledVersion();
      const result = await cachedRollbackVersions(current, url.searchParams.get('refresh') === '1');
      return jsonRes(res, 200, { current, ok: result.ok, versions: result.versions });
    }

    if (req.method === 'GET' && url.pathname === '/api/update/changelog') {
      const current = currentInstalledVersion();
      const result = await cachedChangelog(current);
      return jsonRes(res, 200, {
        current,
        ok: result.ok,
        rateLimited: result.rateLimited === true,
        releases: result.releases,
        releasesUrl: `https://github.com/${GITHUB_REPO}/releases`,
      });
    }

    if (req.method === 'POST' && url.pathname === '/api/update/run') {
      if (!authed) return jsonRes(res, 401, { ok: false, error: 'unauthorized' });
      // 本地 checkout：走 git pull --ff-only + pnpm build（与 CLI cmdUpgradeLocalDev
      // 共用 local-dev-update 逻辑），而不是全局包管理器安装。重启仍走下方
      // /api/update/restart 的 lease/intent 路径。
      if (isLocalDevInstall()) {
        const node = checkNode();
        if (!node.ok) return jsonRes(res, 400, { ok: false, error: 'node_too_old', node });
        if (updateInFlight) return jsonRes(res, 409, { ok: false, error: 'update_in_flight' });
        updateInFlight = true;
        let acquired = false;
        let blockedByRestart = false;
        let result: { dir: string; changed: boolean; oldVersion: string; newVersion: string; head: string } | undefined;
        try {
          await withFileLock(globalInstallUpdateLockTarget(), async () => {
            acquired = true;
            if (hasActiveRestartLease()) { blockedByRestart = true; return; }
            result = await runLocalDevUpdate();
          }, { maxWaitMs: 2_000 });
        } catch (e) {
          if (!acquired) return jsonRes(res, 409, { ok: false, error: 'update_in_flight' });
          const code = (e as { code?: string }).code;
          if (code === 'dirty_worktree') {
            return jsonRes(res, 409, {
              ok: false, error: 'dirty_worktree',
              detail: (e as { status?: string }).status ?? '',
              dir: (e as { dir?: string }).dir ?? '',
            });
          }
          if (code === 'not_a_worktree') {
            return jsonRes(res, 400, { ok: false, error: 'not_a_worktree', dir: (e as { dir?: string }).dir ?? '' });
          }
          return jsonRes(res, 500, { ok: false, error: 'install_failed', detail: e instanceof Error ? e.message : String(e) });
        } finally {
          updateInFlight = false;
        }
        if (blockedByRestart) return jsonRes(res, 409, { ok: false, error: 'restart_in_flight' });
        // Pin THIS build's checkout + HEAD so the follow-up restart applies it,
        // even if the wrapper is re-pointed by a concurrent `use:here` before the
        // user confirms the restart. Consumed (and re-verified) in /api/update/restart.
        if (result) pendingLocalDevRestart = { dir: result.dir, head: result.head };
        return jsonRes(res, 200, {
          ok: true,
          // Versions of the checkout we actually updated (may differ from the
          // running process's install root when wrapper→B, dashboard runs A).
          oldVersion: result?.oldVersion ?? '',
          newVersion: result?.newVersion ?? '',
          // changed = HEAD advanced (or version string changed) — for display.
          changed: result?.changed === true || result?.oldVersion !== result?.newVersion,
          // A successful build regenerates dist/, so a restart is ALWAYS needed
          // to apply it — independent of whether HEAD moved (the checkout may
          // have been pulled already and only needed a build).
          restartRequired: true,
          localDev: true,
        });
      }
      // 编译版独立二进制（install.sh 形态）：没有包管理器拥有这个文件，改为下载
      // 对应平台的 release 资产、校验 SHA-256 后原子替换自身。npm 子包形态不走
      // 这里 —— 那棵树归 npm 所有，交回 npm 更新（见 binary-self-update.ts 头部）。
      const runStrategy = currentUpdateStrategy(botmuxInstallRoot());
      if (runStrategy.kind === 'self-replace') {
        if (updateInFlight) return jsonRes(res, 409, { ok: false, error: 'update_in_flight' });
        updateInFlight = true;
        let acquired = false;
        let blockedByRestart = false;
        let oldVersion = '';
        let newVersion = '';
        try {
          const latest = await cachedLatestVersion(false);
          if (!latest.value) {
            return jsonRes(res, 503, { ok: false, error: 'version_lookup_failed' });
          }
          oldVersion = currentInstalledVersion();
          newVersion = latest.value;
          await withFileLock(globalInstallUpdateLockTarget(), async () => {
            acquired = true;
            if (hasActiveRestartLease()) { blockedByRestart = true; return; }
            await replaceStandaloneBinary(newVersion, runStrategy.target);
          }, { maxWaitMs: 2_000 });
        } catch (e) {
          if (!acquired) return jsonRes(res, 409, { ok: false, error: 'update_in_flight' });
          return jsonRes(res, 500, { ok: false, error: 'install_failed', detail: e instanceof Error ? e.message : String(e) });
        } finally {
          updateInFlight = false;
        }
        if (blockedByRestart) return jsonRes(res, 409, { ok: false, error: 'restart_in_flight' });
        return jsonRes(res, 200, {
          ok: true,
          oldVersion,
          newVersion,
          // The swapped binary is on disk but THIS process still runs (and reports)
          // the old baked version, so `changed` cannot be derived by re-reading —
          // it is the version comparison that decided to update at all.
          changed: newVersion !== oldVersion,
          restartRequired: true,
          manager: 'binary',
        });
      }
      let installPlan: GlobalInstallPlan;
      try {
        // ⚠️ NOT `botmuxInstallRoot()`: for a compiled binary that is "/" and the
        // resolve below throws, which is the very defect this PR fixes. The
        // strategy resolved above already carries the right root (the sibling main
        // package for an npm/pnpm/Bun subpackage; the running install root under
        // Node). `lastSuccessfulUpdatePlan` still wins so a pnpm update keeps using
        // the stable symlink it resolved last time.
        const packageRoot = lastSuccessfulUpdatePlan?.activePackageRoot
          ?? (runStrategy.kind === 'package-manager' ? runStrategy.packageRoot : botmuxInstallRoot());
        installPlan = resolveGlobalInstallPlan(packageRoot);
      } catch (error) {
        if (error instanceof UnsupportedGlobalInstallError) {
          return jsonRes(res, 400, {
            ok: false,
            error: 'unsupported_install_method',
            manager: error.manager,
          });
        }
        throw error;
      }
      const node = checkNode();
      if (!node.ok) return jsonRes(res, 400, { ok: false, error: 'node_too_old', node });
      if (updateInFlight) return jsonRes(res, 409, { ok: false, error: 'update_in_flight' });
      updateInFlight = true;
      let oldVersion = '';
      // Acquire the shared cross-process lock so a scheduled maintenance
      // auto-update (running in the bot-0 daemon) can't update the same global
      // install concurrently. `acquired` distinguishes "lock held by
      // maintenance" (409) from "the package manager failed" (500). Short wait:
      // don't block the request on a full in-progress install — report busy fast.
      let acquired = false;
      let blockedByRestart = false;
      try {
        await withFileLock(globalInstallUpdateLockTarget(), async () => {
          acquired = true;
          if (hasActiveRestartLease()) {
            blockedByRestart = true;
            return;
          }
          oldVersion = botmuxVersionAt(installPlan.activePackageRoot);
          await runGlobalInstall(installPlan);
        }, { maxWaitMs: 2_000 });
      } catch (e) {
        if (!acquired) return jsonRes(res, 409, { ok: false, error: 'update_in_flight' });
        return jsonRes(res, 500, { ok: false, error: 'install_failed', detail: e instanceof Error ? e.message : String(e) });
      } finally {
        updateInFlight = false;
      }
      if (blockedByRestart) return jsonRes(res, 409, { ok: false, error: 'restart_in_flight' });
      // Read the DISK, not `botmuxVersionAt`: for a compiled binary the baked
      // version takes priority and would report this process's OLD version even
      // though npm just rewrote package.json (measured) — making `changed` always
      // false and the "restart to apply" prompt never appear.
      const newVersion = diskVersionAt(installPlan.activePackageRoot);
      lastSuccessfulUpdatePlan = installPlan;
      return jsonRes(res, 200, {
        ok: true,
        oldVersion,
        newVersion,
        changed: newVersion !== oldVersion,
        manager: installPlan.manager,
      });
    }

    if (req.method === 'POST' && url.pathname === '/api/update/rollback') {
      if (!authed) return jsonRes(res, 401, { ok: false, error: 'unauthorized' });
      if (isLocalDevInstall()) return jsonRes(res, 400, { ok: false, error: 'local_dev_no_update' });

      let targetVersion = '';
      try {
        const parsed = await readJsonBody(req);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          return jsonRes(res, 400, { ok: false, error: 'invalid_version' });
        }
        const body = parsed as Record<string, unknown>;
        if (Object.keys(body).length !== 1 || typeof body.version !== 'string' || !isCanonicalStableVersion(body.version)) {
          return jsonRes(res, 400, { ok: false, error: 'invalid_version' });
        }
        targetVersion = body.version;
      } catch {
        return jsonRes(res, 400, { ok: false, error: 'invalid_json' });
      }

      const rollback = await cachedRollbackVersions(currentInstalledVersion());
      if (!rollback.ok) return jsonRes(res, 503, { ok: false, error: 'versions_unavailable' });
      if (!rollback.versions.some(entry => entry.version === targetVersion)) {
        return jsonRes(res, 400, { ok: false, error: 'not_rollback_target' });
      }

      // Rollback only knows how to drive a package manager. Resolve the strategy
      // first so a compiled binary uses its MAPPED root: on a fresh process there
      // is no `lastSuccessfulUpdatePlan` yet and `botmuxInstallRoot()` is "/", which
      // made the very first rollback throw `unsupported_install_method` even though
      // /api/update/status had just reported `rollbackSupported: true`.
      const rollbackStrategy = currentUpdateStrategy(botmuxInstallRoot());
      if (rollbackStrategy.kind !== 'package-manager') {
        return jsonRes(res, 400, {
          ok: false,
          error: 'unsupported_install_method',
          manager: rollbackStrategy.kind === 'self-replace' ? 'binary' : 'unknown',
        });
      }
      let installPlan: GlobalInstallPlan;
      try {
        const packageRoot = lastSuccessfulUpdatePlan?.activePackageRoot ?? rollbackStrategy.packageRoot;
        installPlan = withGlobalInstallRegistry(
          resolveGlobalInstallPlan(packageRoot, process.platform, `botmux@${targetVersion}`),
        );
      } catch (error) {
        if (error instanceof UnsupportedGlobalInstallError) {
          return jsonRes(res, 400, {
            ok: false,
            error: 'unsupported_install_method',
            manager: error.manager,
          });
        }
        throw error;
      }

      const node = checkNode();
      if (!node.ok) return jsonRes(res, 400, { ok: false, error: 'node_too_old', node });
      if (updateInFlight) return jsonRes(res, 409, { ok: false, error: 'update_in_flight' });
      updateInFlight = true;

      let acquired = false;
      let blockedByRestart = false;
      let invalidRollbackTarget = false;
      let installedVersionMismatch = '';
      let restartIntentError = '';
      let leaseId: string | null = null;
      let oldVersion = '';
      try {
        await withFileLock(globalInstallUpdateLockTarget(), async () => {
          acquired = true;
          if (hasActiveRestartLease()) {
            blockedByRestart = true;
            return;
          }

          oldVersion = botmuxVersionAt(installPlan.activePackageRoot);
          if (compareVersions(targetVersion, oldVersion) >= 0) {
            invalidRollbackTarget = true;
            return;
          }

          await runGlobalInstall(installPlan);
          // diskVersionAt, not botmuxVersionAt: the baked version of a compiled
          // binary would never equal the rollback target, so this verification
          // would report a spurious `installed_version_mismatch` on every rollback.
          const newVersion = diskVersionAt(installPlan.activePackageRoot);
          lastSuccessfulUpdatePlan = installPlan;
          if (newVersion !== targetVersion) {
            installedVersionMismatch = newVersion;
            return;
          }

          leaseId = claimRestartLease();
          if (!leaseId) {
            blockedByRestart = true;
            return;
          }
          try {
            writeRestartIntent({
              kind: 'rollback',
              oldVersion,
              newVersion,
              at: new Date().toISOString(),
            });
          } catch (error) {
            restartIntentError = error instanceof Error ? error.message : String(error);
            clearRestartLease(leaseId);
            leaseId = null;
            return;
          }

          // Keep the install lock through restart handoff: maintenance cannot
          // race in between the downgrade and the detached restart driver.
          await new Promise<void>((resolveLaunch) => {
            let launched = false;
            const launch = () => {
              if (launched) return;
              launched = true;
              try {
                const child = spawnDetachedRestart('dashboard', installPlan.activePackageRoot, leaseId!);
                if (!child.pid) throw new Error('restart driver did not start');
              } catch (error) {
                clearRestartLease(leaseId!);
                clearRestartIntent();
                logger.error(`[dashboard] rollback restart launch failed: ${error instanceof Error ? error.message : error}`);
              } finally {
                resolveLaunch();
              }
            };
            res.once('finish', launch);
            res.once('close', launch);
            try {
              jsonRes(res, 202, {
                ok: true,
                oldVersion,
                newVersion,
                changed: true,
                manager: installPlan.manager,
                operation: 'rollback',
              });
            } finally {
              if (res.destroyed || res.writableFinished) launch();
            }
          });
        }, { maxWaitMs: 2_000 });

        if (blockedByRestart) return jsonRes(res, 409, { ok: false, error: 'restart_in_flight' });
        if (invalidRollbackTarget) return jsonRes(res, 409, { ok: false, error: 'not_rollback_target' });
        if (installedVersionMismatch) {
          return jsonRes(res, 500, {
            ok: false,
            error: 'install_version_mismatch',
            expectedVersion: targetVersion,
            actualVersion: installedVersionMismatch,
          });
        }
        if (restartIntentError) {
          return jsonRes(res, 500, { ok: false, error: 'restart_intent_failed', detail: restartIntentError });
        }
        return;
      } catch (error) {
        if (leaseId) clearRestartLease(leaseId);
        if (!acquired) return jsonRes(res, 409, { ok: false, error: 'update_in_flight' });
        if (!res.headersSent) {
          return jsonRes(res, 500, {
            ok: false,
            error: 'install_failed',
            detail: error instanceof Error ? error.message : String(error),
          });
        }
        logger.error(`[dashboard] rollback failed after response: ${error instanceof Error ? error.message : error}`);
        return;
      } finally {
        updateInFlight = false;
      }
    }

    if (req.method === 'POST' && url.pathname === '/api/update/restart') {
      if (!authed) return jsonRes(res, 401, { ok: false, error: 'unauthorized' });
      if (updateInFlight) return jsonRes(res, 409, { ok: false, error: 'update_in_flight' });
      // (pm2 shutdown-capability preflight removed with the fleet pm2→supervisor
      // migration: the supervisor has no "bootstrap-shutdown-protocol" policy to
      // probe. A restart failure surfaces through the detached child's own error
      // path.)
      let body: Record<string, unknown> = {};
      try {
        const parsed = await readJsonBody(req);
        if (parsed && typeof parsed === 'object') body = parsed as Record<string, unknown>;
      } catch { /* empty / bad body → plain restart */ }
      const upd = body.update && typeof body.update === 'object' ? body.update as Record<string, unknown> : null;
      // Resolve the local-dev restart target BEFORE claiming the lease so a
      // fail-closed drift check can't leave a dangling lease. Prefer the plan a
      // preceding /api/update/run pinned (dir + post-build HEAD); a plain manual
      // restart (no pending plan) resolves the wrapper live. Verify the target's
      // dist/cli.js exists and — for a pinned plan — that HEAD hasn't moved since
      // the build; on drift/absence fail closed rather than restart the wrong tree.
      let localDevRestartError: { status: number; body: Record<string, unknown> } | undefined;
      let localDevTarget: string | undefined;
      if (isLocalDevInstall()) {
        const pinned = pendingLocalDevRestart;
        pendingLocalDevRestart = undefined; // consume regardless of outcome
        const decision = resolveLocalDevRestartTarget(pinned, resolveLocalDevCheckoutDir(), {
          cliEntryExists: (dir) => existsSync(botmuxCliEntryAt(dir)),
          headOf: (dir) => gitHeadSha(dir),
        });
        if (decision.action === 'fail') {
          localDevRestartError = { status: 409, body: { ok: false, error: decision.reason, dir: decision.dir } };
        } else if (decision.action === 'restart') {
          localDevTarget = decision.dir;
        } else {
          localDevTarget = undefined; // fallback-running-root
        }
      }
      if (localDevRestartError) return jsonRes(res, localDevRestartError.status, localDevRestartError.body);
      let acquired = false;
      let leaseId: string | null = null;
      let activePackageRoot: string | undefined;
      let shouldLaunch = false;
      try {
        await withFileLock(globalInstallUpdateLockTarget(), async () => {
          acquired = true;
          const claimed = claimRestartLease();
          if (!claimed) {
            jsonRes(res, 202, { ok: true, alreadyScheduled: true });
            return;
          }
          leaseId = claimed;
          try {
            if (upd && typeof upd.oldVersion === 'string' && typeof upd.newVersion === 'string' && upd.oldVersion !== upd.newVersion) {
              writeRestartIntent({ kind: 'update', oldVersion: upd.oldVersion, newVersion: upd.newVersion, at: new Date().toISOString() });
            } else {
              writeManualIntentIfAbsent();
            }
          } catch (error) {
            clearRestartLease(leaseId);
            leaseId = null;
            jsonRes(res, 500, {
              ok: false,
              error: 'restart_intent_failed',
              detail: error instanceof Error ? error.message : String(error),
            });
            return;
          }
          // Local-dev restarts from the target resolved above (pinned build's
          // checkout, verified present + at the built HEAD); undefined falls back
          // to this dashboard process's own cli.js via spawnDetachedRestart.
          if (isLocalDevInstall()) {
            activePackageRoot = localDevTarget;
          } else {
            activePackageRoot = (lastSuccessfulUpdatePlan ?? tryResolveGlobalInstallPlan())?.activePackageRoot;
          }
          // Send acknowledgement while holding the lock, then release immediately.
          // The lease itself prevents concurrent restarts — no need to hold the
          // lock across the network round-trip waiting for res.finish.
          jsonRes(res, 202, { ok: true });
          shouldLaunch = true;
        }, { maxWaitMs: 2_000 });
      } catch (error) {
        if (!acquired) return jsonRes(res, 409, { ok: false, error: 'update_in_flight' });
        throw error;
      }
      // Spawn the detached driver after the lock is released. The lease guards
      // against double-restart; if launch fails we clear the lease so a retry
      // can succeed.
      if (shouldLaunch && leaseId) {
        const launch = () => {
          try {
            const child = spawnDetachedRestart('dashboard', activePackageRoot, leaseId!);
            if (!child.pid) throw new Error('restart driver did not start');
          } catch (error) {
            clearRestartLease(leaseId!);
            logger.error(`[dashboard] restart launch failed: ${error instanceof Error ? error.message : error}`);
          }
        };
        if (res.destroyed || res.writableFinished) {
          launch();
        } else {
          res.once('finish', launch);
          res.once('close', launch);
        }
      }
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/skills') {
      return jsonRes(res, 200, dashboardSkillsPayload());
    }

    // Batch skill removal. POST /api/skills/remove is the canonical route the
    // dashboard UI calls: the payload (names[], force) must travel in the body,
    // and DELETE bodies are dropped by the platform dashboard proxy (it assumes
    // DELETE carries no body, forwards content-length but never pipes the bytes,
    // so readJsonBody hangs until the outer gateway returns 504). DELETE
    // /api/skills stays as an alias for direct/scripted callers.
    if ((req.method === 'DELETE' && url.pathname === '/api/skills')
      || (req.method === 'POST' && url.pathname === '/api/skills/remove')) {
      let parsed: unknown;
      try {
        parsed = await readJsonBody(req);
      } catch {
        return jsonRes(res, 400, { ok: false, error: 'bad_json' });
      }
      const body = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
      const rawNames = Array.isArray(body.names) ? body.names : [];
      if (rawNames.some(name => typeof name !== 'string')) return jsonRes(res, 400, { ok: false, error: 'invalid_skill_names' });
      const names = [...new Set((rawNames as string[]).map(name => name.trim()).filter(Boolean))];
      if (names.length === 0) return jsonRes(res, 400, { ok: false, error: 'skills_required' });
      if (names.length > 500) return jsonRes(res, 400, { ok: false, error: 'too_many_skills' });
      const registrySkills = readSkillRegistry().skills;
      const missing = names.filter(name => !registrySkills[name]);
      if (missing.length > 0) return jsonRes(res, 400, { ok: false, error: 'skill_not_installed', missing });

      const referencesBySkill = await dashboardSkillReferencesMany(names);
      const references = names.map(name => ({ name, refs: referencesBySkill.get(name) ?? { bots: [], packs: [] } }));
      const affectedSkills = references
        .filter(item => item.refs.bots.length > 0 || item.refs.packs.length > 0)
        .map(item => ({
          name: item.name,
          affectedBots: item.refs.bots,
          affectedPacks: item.refs.packs,
        }));
      if (body.force !== true && affectedSkills.length > 0) {
        return jsonRes(res, 409, {
          ok: false,
          error: 'skills_in_use',
          affectedSkills,
        });
      }

      const result = removeInstalledSkills(names);
      if (!result.ok) return jsonRes(res, 400, { ok: false, error: result.reason, missing: result.missing });
      return jsonRes(res, 200, { ok: true, removed: result.removed, affectedSkills });
    }

    if (req.method === 'PUT' && url.pathname === '/api/skills/global') {
      let parsed: unknown;
      try {
        parsed = await readJsonBody(req);
      } catch {
        return jsonRes(res, 400, { ok: false, error: 'bad_json' });
      }
      const body = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
      if (!('trustProjectSkills' in body) && !('delivery' in body)) return jsonRes(res, 400, { ok: false, error: 'empty_patch' });
      const patch: NonNullable<ReturnType<typeof readGlobalConfig>['skills']> = {};
      if ('trustProjectSkills' in body) {
        const raw = body.trustProjectSkills;
        const trustProjectSkills = raw === 'trusted' ? 'all' : raw;
        if (trustProjectSkills !== 'off' && trustProjectSkills !== 'all') {
          return jsonRes(res, 400, { ok: false, error: 'invalid_trustProjectSkills' });
        }
        patch.trustProjectSkills = trustProjectSkills;
      }
      if ('delivery' in body) {
        const delivery = body.delivery;
        if (delivery !== 'auto' && delivery !== 'prompt' && delivery !== 'native') {
          return jsonRes(res, 400, { ok: false, error: 'invalid_delivery' });
        }
        patch.delivery = delivery;
      }
      const currentSkills = readGlobalConfig().skills ?? {};
      mergeGlobalConfig({ skills: { ...currentSkills, ...patch } });
      return jsonRes(res, 200, { ok: true, ...dashboardSkillsPayload() });
    }

    if (req.method === 'POST' && url.pathname === '/api/skills/discover') {
      let parsed: unknown;
      try {
        parsed = await readJsonBody(req);
      } catch {
        return jsonRes(res, 400, { ok: false, error: 'bad_json' });
      }
      const body = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
      try {
        const discoverRequest = parseDashboardSkillInstallRequest(body);
        const discovery = await discoverDashboardSkills(discoverRequest);
        return jsonRes(res, 200, { ok: true, discovery });
      } catch (err: any) {
        return jsonRes(res, 400, { ok: false, error: redactGitUrlCredentials(err?.message ?? String(err)) });
      }
    }

    if (req.method === 'POST' && url.pathname === '/api/skills/install') {
      let parsed: unknown;
      try {
        parsed = await readJsonBody(req);
      } catch {
        return jsonRes(res, 400, { ok: false, error: 'bad_json' });
      }
      const body = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
      try {
        const installRequest = parseDashboardSkillInstallRequest(body);
        const job = startSkillJob('install', () => installDashboardSkill(installRequest));
        return jsonRes(res, 202, { ok: true, job: publicSkillJob(job) });
      } catch (err: any) {
        return jsonRes(res, 400, { ok: false, error: redactGitUrlCredentials(err?.message ?? String(err)) });
      }
    }

    if (req.method === 'POST' && url.pathname === '/api/skills/install-local-links') {
      let parsed: unknown;
      try {
        parsed = await readJsonBody(req);
      } catch {
        return jsonRes(res, 400, { ok: false, error: 'bad_json' });
      }
      const sources = parseInstallLocalLinksSources(parsed);
      if (sources.length === 0) return jsonRes(res, 400, { ok: false, error: 'sources_required' });
      if (sources.length > MAX_LOCAL_LINK_SOURCES) return jsonRes(res, 400, { ok: false, error: 'too_many_sources' });
      try {
        const skills = installLocalSkillLinks(sources);
        // Frontend re-fetches /api/skills (refresh()) after success, so we keep
        // the response lean — no need to spread a full dashboardSkillsPayload()
        // (which would re-run the native-skill discovery scan a second time).
        return jsonRes(res, 200, { ok: true, installed: skills.map(sanitizeSkillForDashboard) });
      } catch (err: any) {
        return jsonRes(res, 400, { ok: false, error: redactGitUrlCredentials(err?.message ?? String(err)) });
      }
    }

    let mSkillJob: RegExpMatchArray | null;
    if (req.method === 'GET' && (mSkillJob = url.pathname.match(/^\/api\/skills\/jobs\/([^/]+)$/))) {
      const job = skillJobs.get(decodeURIComponent(mSkillJob[1]));
      if (!job) return jsonRes(res, 404, { ok: false, error: 'job_not_found' });
      return jsonRes(res, 200, { ok: true, job: publicSkillJob(job) });
    }

    let mSkillUpdate: RegExpMatchArray | null;
    if (req.method === 'POST' && (mSkillUpdate = url.pathname.match(/^\/api\/skills\/([^/]+)\/update$/))) {
      const name = decodeURIComponent(mSkillUpdate[1]);
      if (!readSkillRegistry().skills[name]) return jsonRes(res, 400, { ok: false, error: 'skill_not_installed' });
      const job = startSkillJob('update', async () => {
        const r = await updateInstalledSkillAsync(name);
        if (!r.ok) throw new Error(r.reason);
        return r.skill;
      });
      return jsonRes(res, 202, { ok: true, job: publicSkillJob(job) });
    }

    let mSkillDelete: RegExpMatchArray | null;
    if (req.method === 'DELETE' && (mSkillDelete = url.pathname.match(/^\/api\/skills\/([^/]+)$/))) {
      const name = decodeURIComponent(mSkillDelete[1]);
      const force = url.searchParams.get('force') === '1';
      if (!readSkillRegistry().skills[name]) return jsonRes(res, 400, { ok: false, error: 'skill_not_installed' });
      const refs = await dashboardSkillReferences(name);
      if (!force && (refs.bots.length > 0 || refs.packs.length > 0)) {
        return jsonRes(res, 409, {
          ok: false,
          error: 'skill_in_use',
          affectedBots: refs.bots,
          affectedPacks: refs.packs,
        });
      }
      const r = removeInstalledSkill(name);
      if (!r.ok) return jsonRes(res, 400, { ok: false, error: r.reason });
      return jsonRes(res, 200, {
        ok: true,
        affectedBots: refs.bots,
        affectedPacks: refs.packs,
        ...dashboardSkillsPayload(),
      });
    }

    // --- Skill pack CRUD ---------------------------------------------------

    if (req.method === 'GET' && url.pathname === '/api/skill-packs') {
      const registrySkills = readSkillRegistry().skills;
      const bots = loadBotConfigsSafe();
      const packs = enrichPacksForDashboard(
        listSkillPacks(),
        registrySkills,
        (packId) => botsReferencingPack(packId, bots),
      );
      return jsonRes(res, 200, { ok: true, packs });
    }

    if (req.method === 'POST' && url.pathname === '/api/skill-packs') {
      let body: unknown;
      try { body = await readJsonBody(req); } catch { return jsonRes(res, 400, { ok: false, error: 'bad_json' }); }
      try {
        const input = parsePackInput(body);
        const pack = createSkillPack(input);
        return jsonRes(res, 201, { ok: true, pack });
      } catch (err) {
        return jsonRes(res, packErrorStatus(err), packErrorBody(err));
      }
    }

    let mPack: RegExpMatchArray | null;
    if (req.method === 'GET' && (mPack = url.pathname.match(/^\/api\/skill-packs\/([^/]+)$/))) {
      const id = decodeURIComponent(mPack[1]);
      const pack = getSkillPack(id);
      if (!pack) return jsonRes(res, 404, { ok: false, error: 'SKILL_PACK_NOT_FOUND' });
      const registrySkills = readSkillRegistry().skills;
      const bots = loadBotConfigsSafe();
      return jsonRes(res, 200, {
        ok: true,
        pack: enrichPackForDashboard(pack, registrySkills, botsReferencingPack(pack.id, bots)),
      });
    }

    if (req.method === 'PUT' && (mPack = url.pathname.match(/^\/api\/skill-packs\/([^/]+)$/))) {
      const id = decodeURIComponent(mPack[1]);
      let body: unknown;
      try { body = await readJsonBody(req); } catch { return jsonRes(res, 400, { ok: false, error: 'bad_json' }); }
      try {
        const input = parsePackUpdate(body);
        const pack = updateSkillPack(id, input);
        return jsonRes(res, 200, { ok: true, pack });
      } catch (err) {
        return jsonRes(res, packErrorStatus(err), packErrorBody(err));
      }
    }

    if (req.method === 'DELETE' && (mPack = url.pathname.match(/^\/api\/skill-packs\/([^/]+)$/))) {
      const id = decodeURIComponent(mPack[1]);
      const force = url.searchParams.get('force') === '1';
      const pack = getSkillPack(id);
      if (!pack) return jsonRes(res, 404, { ok: false, error: 'SKILL_PACK_NOT_FOUND' });
      const refs = botsReferencingPack(id, loadBotConfigsSafe());
      if (!force && refs.length > 0) {
        return jsonRes(res, 409, { ok: false, error: 'SKILL_PACK_IN_USE', references: refs });
      }
      try {
        deleteSkillPack(id);
        return jsonRes(res, 200, { ok: true, references: refs });
      } catch (err) {
        return jsonRes(res, packErrorStatus(err), packErrorBody(err));
      }
    }

    if (req.method === 'POST' && (mPack = url.pathname.match(/^\/api\/skill-packs\/([^/]+)\/clone$/))) {
      const id = decodeURIComponent(mPack[1]);
      let body: unknown;
      try { body = await readJsonBody(req); } catch { return jsonRes(res, 400, { ok: false, error: 'bad_json' }); }
      const newId = typeof (body as any)?.id === 'string' ? (body as any).id.trim() : '';
      if (!newId) return jsonRes(res, 400, { ok: false, error: 'id_required' });
      try {
        const pack = cloneSkillPack(id, newId);
        return jsonRes(res, 201, { ok: true, pack });
      } catch (err) {
        return jsonRes(res, packErrorStatus(err), packErrorBody(err));
      }
    }

    if (req.method === 'GET' && url.pathname === '/api/whiteboards') {
      return jsonRes(res, 200, { enabled: whiteboardEnabled(), whiteboards: listWhiteboards() });
    }
    if (req.method === 'GET' && url.pathname === '/api/goals') {
      return jsonRes(res, 200, buildGoalBoard());
    }
    if (req.method === 'GET' && url.pathname === '/api/goals/attention') {
      const chatId = url.searchParams.get('chatId')?.trim() || undefined;
      const board = buildGoalAttentionBoardWithContext({ chatId });
      const liveRisks = await collectGoalAttentionLiveRisks(chatId);
      return jsonRes(res, 200, withGoalAttentionLiveRisks(board, liveRisks));
    }
    if (req.method === 'GET' && url.pathname === '/api/goal-notification-retries') {
      return jsonRes(res, 200, { records: listGoalNotificationRetries() });
    }
    const mGoalWatchdog = url.pathname.match(/^\/api\/goals\/([^/]+)\/watchdog$/);
    if (req.method === 'POST' && mGoalWatchdog) {
      const goalChatId = decodeURIComponent(mGoalWatchdog[1]);
      let parsed: any = {};
      try {
        parsed = await readJsonBody(req);
      } catch {
        parsed = {};
      }
      const taskId = typeof parsed?.taskId === 'string' && parsed.taskId.trim() ? parsed.taskId.trim() : undefined;
      const reason = `dashboard_attention${taskId ? `:${taskId}` : ''}`;
      let contacted = 0;
      let injected = 0;
      let reconciled = 0;
      let revived = 0;
      let reassigned = 0;
      let busy = 0;
      let rateLimited = 0;
      let lastError: any = null;
      await Promise.all(registry.list().map(async (d) => {
        try {
          const upstream = await fetchDaemonIpc(d.ipcPort, '/api/goal/watchdog', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ goalChatId, reason }),
            signal: AbortSignal.timeout(3_000),
          });
          contacted++;
          const txt = await upstream.text();
          let json: any = null;
          try { json = txt ? JSON.parse(txt) : null; } catch { /* keep null */ }
          if (!upstream.ok) {
            lastError = json ?? { status: upstream.status, body: txt };
            return;
          }
          const results = Array.isArray(json?.results) ? json.results : [];
          injected += results.filter((r: any) => r?.status === 'injected').length;
          reconciled += results.filter((r: any) => r?.status === 'reconciled').length;
          revived += results.filter((r: any) => r?.status === 'revived').length;
          reassigned += results.filter((r: any) => r?.status === 'reassigned').length;
          busy += results.filter((r: any) => r?.status === 'busy').length;
          rateLimited += results.filter((r: any) => r?.status === 'rate-limited').length;
        } catch (err: any) {
          logger.warn(`[dashboard] goal watchdog trigger failed: ${err?.message ?? String(err)}`);
          lastError = { error: 'goal_watchdog_request_failed' };
        }
      }));
      return jsonRes(res, 200, { ok: true, goalChatId, taskId, contacted, injected, reconciled, revived, reassigned, busy, rateLimited, lastError });
    }
    const mGoalNotificationRetry = url.pathname.match(/^\/api\/goal-notification-retries\/([^/]+)\/(retry|clear)$/);
    if (req.method === 'POST' && mGoalNotificationRetry) {
      const id = decodeURIComponent(mGoalNotificationRetry[1]);
      const action = mGoalNotificationRetry[2];
      if (action === 'retry') {
        const record = retryGoalNotification(id);
        if (!record) return jsonRes(res, 404, { ok: false, error: 'not_found' });
        const d = registry.getByAppId(record.ownerLarkAppId);
        let triggered = false;
        let triggerError: string | undefined;
        if (d) {
          try {
            const upstream = await fetchDaemonIpc(d.ipcPort, '/api/goal-notification-retries/process', {
              method: 'POST',
              signal: AbortSignal.timeout(3_000),
            });
            triggered = upstream.ok;
            if (!upstream.ok) triggerError = `HTTP ${upstream.status}`;
          } catch (err: any) {
            logger.warn(`[dashboard] goal notification retry trigger failed: ${err?.message ?? String(err)}`);
            triggerError = 'goal_notification_retry_request_failed';
          }
        } else {
          triggerError = 'owner_daemon_offline';
        }
        return jsonRes(res, 200, { ok: true, record, triggered, triggerError });
      }
      removeGoalNotificationRetry(id);
      return jsonRes(res, 200, { ok: true });
    }
    const mGoalDecision = url.pathname.match(/^\/api\/goals\/([^/]+)\/decision$/);
    if (req.method === 'POST' && mGoalDecision) {
      const goalChatId = decodeURIComponent(mGoalDecision[1]);
      let parsed: any;
      try {
        parsed = await readJsonBody(req);
      } catch {
        return jsonRes(res, 400, { ok: false, error: 'bad_json' });
      }
      const text = typeof parsed?.text === 'string' ? parsed.text.trim() : '';
      const taskId = typeof parsed?.taskId === 'string' && parsed.taskId.trim() ? parsed.taskId.trim() : undefined;
      if (!text) return jsonRes(res, 400, { ok: false, error: 'missing_text' });
      const body = JSON.stringify({ taskId, text });
      let contacted = 0;
      let lastError: any = null;
      for (const d of registry.list()) {
        try {
          const upstream = await fetchDaemonIpc(d.ipcPort, `/api/goals/${encodeURIComponent(goalChatId)}/decision`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body,
            signal: AbortSignal.timeout(3_000),
          });
          contacted++;
          const txt = await upstream.text();
          let json: any = null;
          try { json = txt ? JSON.parse(txt) : null; } catch { /* keep null */ }
          if (upstream.ok && json?.ok) return jsonRes(res, 200, json);
          if (json?.error !== 'no_supervisor') lastError = json ?? { status: upstream.status, body: txt };
        } catch (err: any) {
          logger.warn(`[dashboard] goal decision delivery failed: ${err?.message ?? String(err)}`);
          lastError = { error: 'goal_decision_request_failed' };
        }
      }
      return jsonRes(res, 404, {
        ok: false,
        error: 'no_supervisor',
        goalChatId,
        contacted,
        lastError,
      });
    }
    const mWhiteboard = url.pathname.match(/^\/api\/whiteboards\/([^/]+)$/);
    if (req.method === 'GET' && mWhiteboard) {
      try {
        const id = decodeURIComponent(mWhiteboard[1]);
        return jsonRes(res, 200, { enabled: whiteboardEnabled(), id, content: readWhiteboard(id, { allowDisabled: true }) });
      } catch (err: any) {
        return jsonRes(res, 404, { ok: false, error: err?.message ?? 'whiteboard_not_found' });
      }
    }
    if (req.method === 'DELETE' && mWhiteboard) {
      try {
        const id = decodeURIComponent(mWhiteboard[1]);
        return jsonRes(res, 200, deleteWhiteboard(id));
      } catch (err: any) {
        return jsonRes(res, 400, { ok: false, error: err?.message ?? 'whiteboard_delete_failed' });
      }
    }

    // ─── Customization center (built-in prompt/skill overrides) ──────────────
    // GET is a public read (overview only, no secrets); all mutations are
    // owner-gated (not on PUBLIC_READ_PATHS → decideDashboardAuth 401s guests).
    if (await handleCustomizationApi(req, res, url)) {
      return;
    }

    if (await handleConnectorApi(req, res, url)) {
      return;
    }

    // Federation SPOKE endpoints (owner actions) — token-gated above.
    if (await handleFederationSpokeApi(req, res, url, { createTeamGroup, transferTeamGroupOwner, liveBots })) {
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/trigger') {
      return handleDashboardTriggerApi(req, res, { proxyToDaemon });
    }

    // CLI 下拉选项 (id=选择键 + 展示名), 单一事实源在 cli-selection.CLI_SELECT_OPTIONS,
    // 含 aiden×claude / aiden×codex 网关项——前端打开"添加机器人"表单时拉取填充下拉.
    // id 既可能是普通 cliId, 也可能是 'aiden-x-claude' 这类选择键, 由 resolveCliSelection 解析.
    if (req.method === 'GET' && url.pathname === '/api/cli-options') {
      // `webSession` 是「开放平台登录态」实时探测: sessionStatus() 一路走到
      // inspectCachedFeishuOpenPlatformSession(), 对飞书做一次真实网络往返
      // (MEASURED: 1004 / 1091 / 2530ms; 端点 p50 1282ms / max 4402ms)。而同一
      // 个 handler 里真正要算的东西只要 13ms (39 个 CLI 的 checkCliAvailability
      // 12ms + staticModelChoices 1ms)——99% 的时间花在那一次外网调用上。
      //
      // 只有「添加机器人」弹窗消费它 (bot-onboarding.tsx 用来决定 reuse/qr 登录
      // 模式并展示"将使用 …"账号)。Bot 配置页的 CliOptionsState (bot-defaults.ts)
      // 类型里根本没有这个字段——付了 1-4s 的钱, 拿到就丢, 首屏白等。
      //
      // ⚠️ 兼容性决定了这里为什么是 opt-OUT 而不是 opt-IN:
      // 路由 chunk 带 `immutable` 长缓存, 而 stale-chunk 自愈只在**动态 import
      // 失败**时触发 —— dashboard 重启后, 已经加载好的旧 Bot 配置 chunk 会继续
      // 活着并请求**裸** `/api/cli-options`。若裸端点默认不再探测, 旧 chunk 会在
      // `body?.webSession?.status === 'ready'` 处把「字段缺席」判成 scan_required,
      // 把登录态明明正常的用户**推去扫码**。新增 `not_probed` 状态也救不了它
      // (旧代码不认识新状态)。
      // 所以: 裸端点**保留旧语义**(照旧探测), 新的 Bot 配置页显式带
      // `?probe=none` 走快路径。旧配置页最坏只是慢一次, 没有功能退化。
      const probe = url.searchParams.get('probe');
      const webSession = probe === 'none' ? undefined : await botOnboarding.sessionStatus();
      return jsonRes(res, 200, {
        options: CLI_SELECT_OPTIONS.map((o) => {
          // Keep the all-options scan shell-free so opening the form remains
          // instant even when most of the 20+ CLIs are absent. The selected
          // option is checked again with shell/rc resolution on submit/save.
          const availability = checkCliAvailability({
            cliId: o.cliId,
            wrapperCli: o.wrapperCli,
          }, { shellFallback: false });
          // 静态模型候选（shell-free）：模型下拉的初始选项；live 增量由
          // /api/cli-options/models 按需探测。staticModelChoices 自身 fail-soft，
          // 这里再包一层 try/catch 兜底，保证选项列表永不因模型目录异常而整包失败。
          let modelChoices: string[] = [];
          try {
            modelChoices = [...staticModelChoices(o.key)];
          } catch {
            modelChoices = [];
          }
          return {
            id: o.key,
            label: o.label,
            available: availability.available,
            command: availability.command,
            availabilityReason: availability.reason,
            modelChoices,
            // ttadk 网关项: 前端据此把模型框默认成 glm-5.1 并挂候选下拉; CoCo 不接受 -m.
            ...(isTtadkWrapper(o.wrapperCli)
              ? { gateway: 'ttadk' as const, acceptsModel: ttadkAcceptsModel(o.wrapperCli) }
              : {}),
          };
        }),
        // ttadk 模型默认值 + 候选 (单一事实源在 cli-selection), 供前端模型框使用.
        ttadkModelDefault: TTADK_DEFAULT_MODEL,
        ttadkModelSuggestions: TTADK_MODEL_SUGGESTIONS,
        suggestedAppName: botOnboarding.suggestedAppName(),
        // 未探测时整个字段缺席 (而不是 webSession: undefined)——JSON 里两者都不
        // 出现, 但显式写清意图: 调用方拿不到就该自己带 ?probe=session 再要一次,
        // 不会把「没探测」误读成「探测结果是未登录」而把用户推去扫码。
        ...(webSession ? { webSession } : {}),
      });
    }

    // On-demand 模型探测：只探测当前选中的单个 CLI（用户在模型下拉旁点「刷新」时），
    // 不做全量扫描——20+ CLI 各自 shell out 会让表单打开即卡。静态候选已随
    // /api/cli-options 的 modelChoices 字段下发，本端点只补 live 增量并合并去重。
    if (req.method === 'GET' && url.pathname === '/api/cli-options/models') {
      const key = (url.searchParams.get('key') ?? '').trim();
      if (!isKnownSelectionKey(key)) {
        return jsonRes(res, 400, { ok: false, error: 'unknown_selection_key' });
      }
      const body = await buildModelChoicesResponse(key);
      return jsonRes(res, 200, body);
    }

    if (req.method === 'POST' && url.pathname === '/api/bot-onboarding/start') {
      let parsed: {
        appName?: unknown;
        cloneSourceAppId?: unknown;
        registrationMode?: unknown;
        sessionMode?: unknown;
        expectedIdentity?: unknown;
        cliId?: unknown;
        workingDir?: unknown;
        dirMode?: unknown;
        model?: unknown;
        requireCriticalScopesBeforeActivation?: unknown;
      };
      try {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        const raw = Buffer.concat(chunks).toString('utf8');
        parsed = raw ? JSON.parse(raw) : {};
      } catch {
        return jsonRes(res, 400, { ok: false, error: 'bad_json' });
      }
      // CLI: 把下拉传来的选择键 (普通 cliId 或 aiden-x-claude/codex) 解析成
      // { cliId, wrapperCli }——空 → 默认 claude-code; 非法键 → 400.
      let cliId: CliId;
      let wrapperCli: string | undefined;
      try {
        const key = typeof parsed.cliId === 'string' && parsed.cliId.trim() ? parsed.cliId.trim() : 'claude-code';
        const sel = resolveCliSelection(key);
        cliId = sel.cliId;
        wrapperCli = sel.wrapperCli;
      } catch (err: any) {
        return jsonRes(res, 400, { ok: false, error: 'invalid_cli', message: err?.message ?? String(err) });
      }
      const availability = checkCliAvailability({ cliId, wrapperCli });
      if (!availability.available) {
        return jsonRes(res, 400, {
          ok: false,
          error: 'cli_not_found',
          command: availability.command,
          message: `所选 Agent 当前无法启动：${availability.reason ?? '本地启动依赖不可用'}。请先在 dashboard 所在机器安装后重试。`,
        });
      }
      // 工作目录: 留空 → '~'; 在 daemon 主机上校验目录确实存在 (对齐 setup 的
      // ensureBotWorkingDirsExist). 失败 fail-fast, 让用户在扫码前就改对.
      const workingDir = typeof parsed.workingDir === 'string' && parsed.workingDir.trim()
        ? parsed.workingDir.trim()
        : '~';
      const bad = invalidWorkingDirs({ workingDir });
      if (bad.length > 0) {
        return jsonRes(res, 400, { ok: false, error: 'invalid_working_dir', message: `目录不存在或不是目录: ${bad.join(', ')}` });
      }
      // 目录模式: 'fixed' → defaultWorkingDir（直接启动）；'card' → workingDir（弹卡）。
      // 缺省不传按 'card' 处理，兼容不带该字段的旧客户端。
      const dirModeRaw = typeof parsed.dirMode === 'string' ? parsed.dirMode.trim() : '';
      if (dirModeRaw && dirModeRaw !== 'fixed' && dirModeRaw !== 'card') {
        return jsonRes(res, 400, { ok: false, error: 'invalid_dir_mode', message: 'dirMode 必须是 fixed 或 card' });
      }
      const dirMode = dirModeRaw === 'fixed' ? 'fixed' as const : dirModeRaw === 'card' ? 'card' as const : undefined;
      const model = typeof parsed.model === 'string' && parsed.model.trim() ? parsed.model.trim() : undefined;
      const appName = typeof parsed.appName === 'string' && parsed.appName.trim() ? parsed.appName.trim() : undefined;
      if (appName && Array.from(appName).length > 64) {
        return jsonRes(res, 400, { ok: false, error: 'invalid_app_name', message: '应用名称不能超过 64 个字符' });
      }
      const registrationModeRaw = typeof parsed.registrationMode === 'string' ? parsed.registrationMode.trim() : '';
      if (registrationModeRaw && registrationModeRaw !== 'web' && registrationModeRaw !== 'compat') {
        return jsonRes(res, 400, { ok: false, error: 'invalid_registration_mode', message: 'registrationMode 必须是 web 或 compat' });
      }
      const registrationMode = registrationModeRaw === 'compat' ? 'compat' as const : 'web' as const;
      const sessionModeRaw = typeof parsed.sessionMode === 'string' ? parsed.sessionMode.trim() : '';
      if (registrationMode === 'web' && sessionModeRaw && sessionModeRaw !== 'reuse' && sessionModeRaw !== 'qr') {
        return jsonRes(res, 400, { ok: false, error: 'invalid_session_mode', message: 'sessionMode 必须是 reuse 或 qr' });
      }
      const identityRecord = parsed.expectedIdentity && typeof parsed.expectedIdentity === 'object' && !Array.isArray(parsed.expectedIdentity)
        ? parsed.expectedIdentity as Record<string, unknown>
        : {};
      const expectedIdentity = typeof identityRecord.userId === 'string' && identityRecord.userId
        && typeof identityRecord.tenantId === 'string' && identityRecord.tenantId
        ? { userId: identityRecord.userId, tenantId: identityRecord.tenantId }
        : undefined;
      if (registrationMode === 'web' && sessionModeRaw === 'reuse' && !expectedIdentity) {
        return jsonRes(res, 400, { ok: false, error: 'missing_expected_identity', message: '免扫码添加前必须确认当前账号与企业' });
      }
      const sessionMode = sessionModeRaw === 'reuse' ? 'reuse' as const : 'qr' as const;
      if (
        parsed.requireCriticalScopesBeforeActivation !== undefined
        && typeof parsed.requireCriticalScopesBeforeActivation !== 'boolean'
      ) {
        return jsonRes(res, 400, {
          ok: false,
          error: 'invalid_critical_scope_activation_gate',
          message: 'requireCriticalScopesBeforeActivation 必须是 boolean',
        });
      }
      const job = botOnboarding.start({
        appName,
        ...(typeof parsed.cloneSourceAppId === 'string' && parsed.cloneSourceAppId.trim()
          ? { cloneSourceAppId: parsed.cloneSourceAppId.trim() }
          : {}),
        registrationMode,
        ...(registrationMode === 'web' ? { sessionMode, expectedIdentity } : {}),
        cliId,
        wrapperCli,
        workingDir,
        dirMode,
        model,
        ...(parsed.requireCriticalScopesBeforeActivation === true
          ? { requireCriticalScopesBeforeActivation: true }
          : {}),
      });
      return jsonRes(res, 202, { job: botOnboarding.get(job.id) });
    }
    if (req.method === 'POST' && url.pathname === '/api/bot-onboarding/recover-permissions') {
      let parsed: {
        workingDir?: unknown;
        predecessorJobId?: unknown;
        expectedAppId?: unknown;
        priorRecoveryJobId?: unknown;
        requireCriticalScopesBeforeActivation?: unknown;
      };
      try {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        const raw = Buffer.concat(chunks).toString('utf8');
        parsed = raw ? JSON.parse(raw) : {};
      } catch {
        return jsonRes(res, 400, { ok: false, error: 'bad_json' });
      }
      const workingDir = typeof parsed.workingDir === 'string' ? parsed.workingDir.trim() : '';
      const predecessorJobId = typeof parsed.predecessorJobId === 'string' ? parsed.predecessorJobId.trim() : '';
      const expectedAppId = typeof parsed.expectedAppId === 'string' ? parsed.expectedAppId.trim() : '';
      const priorRecoveryJobId = typeof parsed.priorRecoveryJobId === 'string' ? parsed.priorRecoveryJobId.trim() : undefined;
      if (
        parsed.requireCriticalScopesBeforeActivation !== undefined
        && typeof parsed.requireCriticalScopesBeforeActivation !== 'boolean'
      ) {
        return jsonRes(res, 400, {
          ok: false,
          error: 'invalid_critical_scope_activation_gate',
          message: 'requireCriticalScopesBeforeActivation 必须是 boolean',
        });
      }
      if (!workingDir || !predecessorJobId || !expectedAppId || invalidWorkingDirs({ workingDir }).length > 0) {
        return jsonRes(res, 400, { ok: false, error: 'permission_recovery_target_invalid' });
      }
      const recovered = botOnboarding.startPermissionRecovery({
        workingDir,
        predecessorJobId,
        expectedAppId,
        priorRecoveryJobId,
        ...(parsed.requireCriticalScopesBeforeActivation === true
          ? { requireCriticalScopesBeforeActivation: true }
          : {}),
      });
      if (!recovered.ok) {
        const status = recovered.error === 'permission_recovery_target_missing' ? 404
          : recovered.error === 'permission_recovery_target_ambiguous' ? 409
            : recovered.error === 'permission_recovery_state_unavailable' ? 503
            : 400;
        return jsonRes(res, status, recovered);
      }
      return jsonRes(res, 202, { job: botOnboarding.get(recovered.job.id) });
    }
    let mScopePropagation: RegExpMatchArray | null;
    if (
      req.method === 'POST'
      && (mScopePropagation = url.pathname.match(
        /^\/api\/bot-onboarding\/([^/]+)\/complete-scope-propagation$/,
      ))
    ) {
      const onboardingId = decodeURIComponent(mScopePropagation[1]);
      let parsed: { workingDir?: unknown; expectedAppId?: unknown };
      try {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        const raw = Buffer.concat(chunks).toString('utf8');
        parsed = raw ? JSON.parse(raw) : {};
      } catch {
        return jsonRes(res, 400, { ok: false, error: 'bad_json' });
      }
      const workingDir = typeof parsed.workingDir === 'string' ? parsed.workingDir.trim() : '';
      const expectedAppId = typeof parsed.expectedAppId === 'string' ? parsed.expectedAppId.trim() : '';
      if (!workingDir || !expectedAppId || invalidWorkingDirs({ workingDir }).length > 0) {
        return jsonRes(res, 400, { ok: false, error: 'permission_recovery_target_invalid' });
      }
      const completed = await botOnboarding.completeScopePropagation({
        jobId: onboardingId,
        workingDir,
        expectedAppId,
      });
      if (!completed.ok) {
        const status = completed.error === 'permission_recovery_target_missing' ? 404
          : completed.error === 'permission_recovery_target_ambiguous' ? 409
            : completed.error === 'permission_recovery_scopes_pending' ? 425
              : (
                  completed.error === 'permission_recovery_state_unavailable'
                  || completed.error === 'permission_recovery_activation_failed'
                ) ? 503
                : 400;
        return jsonRes(res, status, completed);
      }
      return jsonRes(res, 200, { job: botOnboarding.get(onboardingId) });
    }
    let mOwner: RegExpMatchArray | null;
    if (req.method === 'POST' && (mOwner = url.pathname.match(/^\/api\/bot-onboarding\/([^/]+)\/owner$/))) {
      // needs_owner 状态下用户手动提交 owner：扫码人身份验证不了时的兜底入口。
      // submitOwner 内部做格式 + 可用性校验, 通过才落盘并转 completed。
      const onboardingId = decodeURIComponent(mOwner[1]);
      let parsedOwner: { owner?: unknown; allowedUsers?: unknown };
      try {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        const raw = Buffer.concat(chunks).toString('utf8');
        parsedOwner = raw ? JSON.parse(raw) : {};
      } catch {
        return jsonRes(res, 400, { ok: false, error: 'bad_json' });
      }
      // 接受 owner 字符串 (逗号/空白分隔) 或 allowedUsers 数组。
      const entries = Array.isArray(parsedOwner.allowedUsers)
        ? parsedOwner.allowedUsers.filter((v): v is string => typeof v === 'string')
        : typeof parsedOwner.owner === 'string'
          ? parsedOwner.owner.split(/[,\s]+/).map(s => s.trim()).filter(Boolean)
          : [];
      const r = await botOnboarding.submitOwner(onboardingId, entries);
      if (!r.ok) {
        const status = r.error === 'unknown_onboarding_job' ? 404 : 400;
        return jsonRes(res, status, r);
      }
      return jsonRes(res, 200, { job: botOnboarding.get(onboardingId) });
    }
    let mOnboard: RegExpMatchArray | null;
    if (req.method === 'GET' && (mOnboard = url.pathname.match(/^\/api\/bot-onboarding\/([^/]+)$/))) {
      const job = botOnboarding.get(decodeURIComponent(mOnboard[1]));
      if (!job) return jsonRes(res, 404, { ok: false, error: 'unknown_onboarding_job' });
      return jsonRes(res, 200, { job });
    }

    // 飞书 Web 登录态刷新（改名缺登录态 → dashboard 扫码）。POST 受 dashboard 的
    // 写操作 auth 闸保护（非 GET 需 owner cookie）；GET 仅暴露二维码+状态，扫码
    // 授权的是扫码人自己的账号，风险模型与 onboarding 第二个二维码一致。
    if (req.method === 'POST' && url.pathname === '/api/feishu-login/start') {
      return jsonRes(res, 202, { login: feishuLogin.start() });
    }
    if (req.method === 'GET' && url.pathname === '/api/feishu-login/status') {
      return jsonRes(res, 200, { login: feishuLogin.get() });
    }

    let m: RegExpMatchArray | null;
    if (req.method === 'POST' && (m = url.pathname.match(/^\/api\/sessions\/([^/]+)\/(close|locate|resume|restart|start)$/))) {
      const sid = decodeURIComponent(m[1]); const op = m[2] as DashboardSessionAction;
      // P1-11：locate 与接管/解锁同属工作台三项操作能力，同样是无 body POST。
      if (op === 'locate' && requestIdentity && !enforceControlCsrf(req, res, requestIdentity)) return;
      const owner = aggregator.ownerOf(sid);
      if (!owner) return jsonRes(res, 404, { ok: false, error: 'unknown_session' });
      // Defensive client-side deadline: the daemon side of every op here replies
      // promptly (close resolves its fence on the worker's flushed ACK; restart/
      // resume/start return after a fire-and-forget IPC). Close gets a separate
      // 60s budget because Riff's 23s remote-cancel prepare and 29s worker-kill
      // backstop are serialized; all other actions stay bounded at 15s.
      let upstream: Response;
      try {
        upstream = await proxyToDaemon(owner, `/api/sessions/${sid}/${op}`, {
          method: 'POST',
          signal: AbortSignal.timeout(dashboardSessionActionTimeoutMs(op)),
        });
      } catch (err: any) {
        const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
        return jsonRes(res, timedOut ? 504 : 502, {
          ok: false,
          error: timedOut ? 'daemon_timeout' : (err?.message ?? String(err)),
        });
      }
      res.writeHead(upstream.status, { 'content-type': 'application/json' });
      res.end(await upstream.text());
      return;
    }

    // 部署 owner 资料（左上角头像）。authed-only；代理到任一在线 daemon。
    if (req.method === 'GET' && url.pathname === '/api/owner-profile') {
      const d = [...registry.list()].sort((a, b) => a.botIndex - b.botIndex)[0];
      if (!d) return jsonRes(res, 503, { ok: false, error: 'no_daemon' });
      const upstream = await proxyToDaemon(d.larkAppId, '/api/owner-profile', { method: 'GET' });
      res.writeHead(upstream.status, { 'content-type': 'application/json' });
      res.end(await upstream.text());
      return;
    }

    // ── 团队看板（本地托管团队，host=本部署）：共享编排 + 成员上报快照 ──────
    // authed-only（不在公开读白名单）。远程团队走 /api/team/remote-board 代理。
    let mBoard: RegExpMatchArray | null;
    if (req.method === 'GET' && (mBoard = url.pathname.match(/^\/api\/team\/board\/local\/([^/]+)$/))) {
      const teamId = decodeURIComponent(mBoard[1]);
      return jsonRes(res, 200, {
        ok: true,
        board: readTeamBoard(config.session.dataDir, teamId),
        reports: listTeamReports(config.session.dataDir, teamId),
      });
    }
    if (req.method === 'POST' && (mBoard = url.pathname.match(/^\/api\/team\/board\/local\/([^/]+)\/move$/))) {
      const teamId = decodeURIComponent(mBoard[1]);
      const moveBody = await readJsonBody(req) as any;
      const entry = setTeamBoardEntry(config.session.dataDir, teamId, String(moveBody?.sessionId ?? ''), moveBody?.column, moveBody?.position);
      if (!entry) return jsonRes(res, 400, { ok: false, error: 'bad_request' });
      return jsonRes(res, 200, { ok: true, entry });
    }

    // 看板放置 / 重命名 / 锁定：带 JSON body 的会话写操作，原样转发给 owner daemon。
    // 不在公开读白名单内 → 只读访客在 decideDashboardAuth 已被 401。
    if (req.method === 'POST' && (m = url.pathname.match(/^\/api\/sessions\/([^/]+)\/(board|rename|lock)$/))) {
      const sid = decodeURIComponent(m[1]); const op = m[2];
      const owner = aggregator.ownerOf(sid);
      if (!owner) return jsonRes(res, 404, { ok: false, error: 'unknown_session' });
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const upstream = await proxyToDaemon(owner, `/api/sessions/${sid}/${op}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: Buffer.concat(chunks).toString('utf8'),
      });
      res.writeHead(upstream.status, { 'content-type': 'application/json' });
      res.end(await upstream.text());
      return;
    }

    // 会话历史（飞书消息实时拉取）。不在公开读白名单 → 只读访客 401。
    if (req.method === 'GET' && (m = url.pathname.match(/^\/api\/sessions\/([^/]+)\/history$/))) {
      const sid = decodeURIComponent(m[1]);
      const owner = aggregator.ownerOf(sid);
      if (!owner) return jsonRes(res, 404, { ok: false, error: 'unknown_session' });
      const upstream = await proxyToDaemon(owner, `/api/sessions/${sid}/history${url.search ?? ''}`, { method: 'GET' });
      res.writeHead(upstream.status, { 'content-type': 'application/json' });
      res.end(await upstream.text());
      return;
    }

    // 单会话元信息（状态/标题/cli/工作目录等）。dashboard 之前只代理了
    // GET /api/sessions（列表），没有单会话 :id 路由，编程式调用方（如任务
    // 编排器的「任务详情」面板）走 getMeta 会落到最底的 404 not_found_yet。
    // owner-only；ownerOf 对已关闭会话仍可解析。放在 trigger-result 之后，
    // 避免把 /trigger-result、/insight 等子路径吞进这个单段匹配。
    if (req.method === 'GET' && (m = url.pathname.match(/^\/api\/sessions\/([^/]+)$/))) {
      const sid = decodeURIComponent(m[1]);
      const owner = aggregator.ownerOf(sid);
      if (!owner) return jsonRes(res, 404, { ok: false, error: 'unknown_session' });
      const upstream = await proxyToDaemon(owner, `/api/sessions/${sid}`, { method: 'GET' });
      const raw = await upstream.text();
      if (!upstream.ok) {
        res.writeHead(upstream.status, { 'content-type': 'application/json' });
        res.end(raw);
        return;
      }
      let body: unknown;
      try { body = JSON.parse(raw); }
      catch { return jsonRes(res, 502, { ok: false, error: 'invalid_daemon_response' }); }
      return jsonRes(res, upstream.status, projectSessionDetailForBrowser(body));
    }

    // 异步 trigger 结果轮询（asyncReturnSessionId 模式的权威查询端点）。
    // 四态 running/completed/failed/not_found，daemon 重启后从持久化结果兜底
    // 重建 completed。owner-only（写权限 cookie），代理到 owner daemon 同名 IPC。
    // ownerOf 对已关闭会话仍可解析（aggregator 的 /api/sessions 含 closed）。
    if (req.method === 'GET' && (m = url.pathname.match(/^\/api\/sessions\/([^/]+)\/trigger-result$/))) {
      const sid = decodeURIComponent(m[1]);
      const owner = aggregator.ownerOf(sid);
      if (!owner) return jsonRes(res, 404, { ok: false, error: 'unknown_session' });
      const upstream = await proxyToDaemon(owner, `/api/sessions/${sid}/trigger-result${url.search ?? ''}`, { method: 'GET' });
      res.writeHead(upstream.status, { 'content-type': 'application/json' });
      res.end(await upstream.text());
      return;
    }

    // 会话 insight（只读 trace 分析：动作 span / 失败聚合 / 规则建议）。
    // owner-only：不在公开读白名单 → decideDashboardAuth 已对只读访客 401，
    // 公开/联邦访客看不到 tab 也拿不到 span。代理到 owner daemon 的同名 IPC。
    if (req.method === 'GET' && (m = url.pathname.match(/^\/api\/sessions\/([^/]+)\/insight$/))) {
      const sid = decodeURIComponent(m[1]);
      const owner = aggregator.ownerOf(sid);
      if (!owner) return jsonRes(res, 404, { ok: false, error: 'unknown_session' });
      const upstream = await proxyToDaemon(owner, `/api/sessions/${sid}/insight${url.search ?? ''}`, { method: 'GET' });
      res.writeHead(upstream.status, { 'content-type': 'application/json' });
      res.end(await upstream.text());
      return;
    }

    if (req.method === 'GET' && (m = url.pathname.match(/^\/api\/sessions\/([^/]+)\/insight\/turn\/([^/]+)$/))) {
      const sid = decodeURIComponent(m[1]);
      const turnIndex = decodeURIComponent(m[2]);
      const owner = aggregator.ownerOf(sid);
      if (!owner) return jsonRes(res, 404, { ok: false, error: 'unknown_session' });
      const upstream = await proxyToDaemon(owner, `/api/sessions/${sid}/insight/turn/${turnIndex}${url.search ?? ''}`, { method: 'GET' });
      res.writeHead(upstream.status, { 'content-type': 'application/json' });
      res.end(await upstream.text());
      return;
    }

    // Writable web-terminal link (token-bearing). Not in any public allow-list,
    // so decideDashboardAuth has already 401'd unauthenticated callers before we
    // get here — the token only reaches authenticated dashboard sessions.
    if (req.method === 'GET' && (m = url.pathname.match(/^\/api\/sessions\/([^/]+)\/write-link$/))) {
      // Short H5 sessions use the tokenless /control/takeover lease. Returning
      // the legacy stable capability here would bypass release/expiry/disconnect
      // enforcement and leak a token into browser-visible JSON.
      if (!legacyAuthed) return dashboardControlJson(res, 403, { ok: false, error: 'control_takeover_required' });
      const sid = decodeURIComponent(m[1]);
      const owner = aggregator.ownerOf(sid);
      if (!owner) return jsonRes(res, 404, { ok: false, error: 'unknown_session' });
      const upstream = await proxyToDaemon(owner, `/api/sessions/${sid}/write-link`, { method: 'GET' });
      res.writeHead(upstream.status, { 'content-type': 'application/json' });
      res.end(await upstream.text());
      return;
    }

    // Read-only web-terminal link. The Workbench terminal pane uses it so the
    // frame authenticates by capability instead of by Dashboard cookie, which
    // a Feishu WebView's WebSocket does not carry.
    //
    // Two things about the daemon's answer never reach the browser (P1-5):
    //   • its `?viewToken=` is the worker's per-boot card token, unbound to the
    //     requesting authentication. It is consumed here — converted to a
    //     one-way worker generation id — and REPLACED with a short-lived signed
    //     read grant bound to sessionId + authSessionId + expiresAt + that
    //     generation + `audience: central`;
    //   • its ORIGIN is the daemon terminal proxy / worker port, both network
    //     reachable and both blind to logout. We answer with a same-origin
    //     relative path instead, so the only entry point the browser ever learns
    //     is this dashboard's front proxy — the one place that checks auth
    //     session liveness and countersigns the hop for the worker.
    // A view capability can never send input, so this stays safe for any
    // identity allowed to observe the session; unauthenticated callers were
    // already rejected by the auth decision above (no public allow-list).
    if (req.method === 'GET' && (m = url.pathname.match(/^\/api\/sessions\/([^/]+)\/view-link$/))) {
      const sid = decodeURIComponent(m[1]);
      const owner = aggregator.ownerOf(sid);
      if (!owner) return jsonRes(res, 404, { ok: false, error: 'unknown_session' });
      const upstream = await proxyToDaemon(owner, `/api/sessions/${sid}/view-link`, { method: 'GET' });
      if (upstream.status !== 200) {
        res.writeHead(upstream.status, { 'content-type': 'application/json' });
        res.end(await upstream.text());
        return;
      }
      let upstreamUrl: unknown;
      try {
        upstreamUrl = (JSON.parse(await upstream.text()) as { url?: unknown }).url;
      } catch {
        upstreamUrl = undefined;
      }
      // No generation ⇒ no pinned capability. Fail closed rather than mint one
      // that would outlive the worker boot it was meant for.
      const generation = upstreamWorkerViewGeneration(SECRET, upstreamUrl);
      const minted = requestIdentity && generation
        ? mintTerminalViewCapability(SECRET, sid, requestIdentity, generation)
        : null;
      const rewritten = minted ? centralViewLinkPath(sid, minted.token) : null;
      // Fail closed rather than fall back to the unbound upstream token/origin.
      if (!minted || !rewritten) return jsonRes(res, 502, { ok: false, error: 'view_link_unavailable' });
      return jsonRes(res, 200, { ok: true, url: rewritten, expiresAt: minted.expiresAt });
    }

    // Browser-safe preview metadata. The literal loopback host/port remains in
    // the aggregator only; this authenticated API returns a same-origin path.
    if (req.method === 'GET' && (m = url.pathname.match(/^\/api\/sessions\/([^/]+)\/preview$/))) {
      const sid = decodeURIComponent(m[1]);
      const resolution = resolveDashboardSessionPreview(sid);
      if (!resolution.ok) return jsonRes(res, resolution.status, { ok: false, error: resolution.error });
      const preview = previewDescriptorFromRow(aggregator.getSession(sid));
      if (!preview) return jsonRes(res, 404, { ok: false, error: 'preview_not_registered' });
      return jsonRes(res, 200, { ok: true, preview });
    }


    // Dashboard「复现命令」：透传到 owning daemon 取该 session 的真实 CLI 调用。
    // 与 write-link 同样只在管理 cookie（写权限）下可达：命令含 token/凭证。
    if (req.method === 'GET' && (m = url.pathname.match(/^\/api\/sessions\/([^/]+)\/spawn-command$/))) {
      if (!legacyAuthed) return dashboardControlJson(res, 403, { ok: false, error: 'legacy_owner_required' });
      const sid = decodeURIComponent(m[1]);
      const owner = aggregator.ownerOf(sid);
      if (!owner) return jsonRes(res, 404, { ok: false, error: 'unknown_session' });
      const upstream = await proxyToDaemon(owner, `/api/sessions/${sid}/spawn-command`, { method: 'GET' });
      res.writeHead(upstream.status, { 'content-type': 'application/json' });
      res.end(await upstream.text());
      return;
    }

    if (req.method === 'POST' && (m = url.pathname.match(/^\/api\/schedules\/([^/]+)\/(run|pause|resume|delivery)$/))) {
      const id = decodeURIComponent(m[1]); const op = m[2];
      const owner = resolveScheduleOwner(id);
      if (!owner) return jsonRes(res, 404, { ok: false, error: 'unknown_schedule' });
      let init: RequestInit = { method: 'POST' };
      if (op === 'delivery') {
        let body: unknown;
        try { body = await readJsonBody(req); } catch { return jsonRes(res, 400, { ok: false, error: 'bad_json' }); }
        init = {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        };
      }
      const upstream = await proxyToDaemon(owner, `/api/schedules/${id}/${op}`, init);
      res.writeHead(upstream.status, { 'content-type': 'application/json' });
      res.end(await upstream.text());
      return;
    }

    // Create a new scheduled task. Body must include `larkAppId` to select
    // which bot/daemon owns the task (multi-bot dashboards cannot guess).
    if (req.method === 'POST' && url.pathname === '/api/schedules') {
      let body: unknown;
      try { body = await readJsonBody(req); } catch { return jsonRes(res, 400, { ok: false, error: 'bad_json' }); }
      if (body === null || typeof body !== 'object') {
        return jsonRes(res, 400, { ok: false, error: 'body_must_be_object' });
      }
      const b = body as Record<string, unknown>;
      const larkAppId = typeof b.larkAppId === 'string' ? b.larkAppId : '';
      if (!larkAppId) return jsonRes(res, 400, { ok: false, error: 'larkAppId_required' });
      const upstream = await proxyToDaemon(larkAppId, '/api/schedules', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      res.writeHead(upstream.status, { 'content-type': 'application/json' });
      res.end(await upstream.text());
      return;
    }

    // Update an existing task (PATCH) or delete it (DELETE). Both route to
    // the daemon that owns the task. Legacy rows (no larkAppId) fall back to
    // the primary daemon (botIndex === 0) so they remain editable.
    if (req.method === 'PATCH' && (m = url.pathname.match(/^\/api\/schedules\/([^/]+)$/))) {
      const id = decodeURIComponent(m[1]);
      const owner = resolveScheduleOwner(id);
      if (!owner) return jsonRes(res, 404, { ok: false, error: 'unknown_schedule' });
      let body: unknown;
      try { body = await readJsonBody(req); } catch { return jsonRes(res, 400, { ok: false, error: 'bad_json' }); }
      if (body === null || typeof body !== 'object') {
        return jsonRes(res, 400, { ok: false, error: 'body_must_be_object' });
      }
      const upstream = await proxyToDaemon(owner, `/api/schedules/${id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      res.writeHead(upstream.status, { 'content-type': 'application/json' });
      res.end(await upstream.text());
      return;
    }

    if (req.method === 'DELETE' && (m = url.pathname.match(/^\/api\/schedules\/([^/]+)$/))) {
      const id = decodeURIComponent(m[1]);
      const owner = resolveScheduleOwner(id);
      if (!owner) return jsonRes(res, 404, { ok: false, error: 'unknown_schedule' });
      const upstream = await proxyToDaemon(owner, `/api/schedules/${id}`, { method: 'DELETE' });
      res.writeHead(upstream.status, { 'content-type': 'application/json' });
      res.end(await upstream.text());
      return;
    }

    // v3 workflow runs. Reads project directly from disk; cancel resolves the
    // immutable run owner and proxies to that daemon (the dashboard never
    // writes the v3 journal itself).
    if (await handleV3RunsApi(req, res, url, {
      runsDir: v3RunsDir(),
      proxyToDaemon,
    }, authed)) {
      return;
    }

    // ─── Groups (Phase B) ────────────────────────────────────────────────────

    if (req.method === 'GET' && url.pathname === '/api/groups') {
      // Fan out via the shared `buildGroupsMatrix` helper so the browser
      // route and the Route B `/__daemon/groups-matrix` endpoint return the
      // same matrix shape. Public-read carve-out: oncall bindings carry
      // workingDir (repo/customer paths) so we scrub when unauthed.
      const matrix = await groupsMatrixSnapshot.get({
        force: authed && url.searchParams.get('refresh') === '1',
      });
      if (url.searchParams.get('view') === 'compact') {
        return jsonRes(res, 200, compactGroupsMatrix(matrix));
      }
      // `?view=names` — 名称/头像专用轻量视图。完整矩阵实测 12.59MB，其中
      // chats[].memberBots 独占 12341KB；而 loadNameMaps()（web/ui.ts）只用
      // bots 的名称/头像 + chats 的 chatId/name/avatar。摘掉 memberBots 后
      // 372KB 级别，同时省掉主线程 38-70ms 的 JSON.parse。
      //
      // 不复用 `?view=compact`：那个投影没有 `bots`，名称/头像会全丢（见
      // GroupsNamesSnapshot 的注释）。
      //
      // 公开只读边界：本投影的 chats 只有 chatId/name/avatar，比
      // redactGroupsForPublic 的输出更窄（它还会保留 chatMode/memberBots），
      // 且 `bots` 在下面的默认分支对未认证访客也是原样下发的——所以这里
      // 无需按 authed 分叉，不存在新增暴露面。
      if (url.searchParams.get('view') === 'names') {
        return jsonRes(res, 200, groupsNamesMatrix(matrix));
      }
      const publicBots = matrix.bots.map(({ botOpenId: _botOpenId, ...rest }) => rest);
      return jsonRes(res, 200, {
        chats: authed ? matrix.chats : redactGroupsForPublic(matrix.chats),
        bots: authed ? matrix.bots : publicBots,
      });
    }

    // ─── Roles (proxy to daemon) ────────────────────────────────────────────
    // POST   /api/roles/batch → collapse role reads to one request per daemon
    // GET    /api/roles/:larkAppId/:chatId → read role file
    // PUT    /api/roles/:larkAppId/:chatId → write role file
    // DELETE /api/roles/:larkAppId/:chatId → delete role file

    if (req.method === 'POST' && url.pathname === '/api/roles/batch') {
      let body: unknown;
      try { body = await readJsonBody(req); }
      catch { return jsonRes(res, 400, { ok: false, error: 'bad_json' }); }
      const parsed = parseRoleBatchTargets(body);
      if (!parsed.ok) return jsonRes(res, 400, { ok: false, error: parsed.error });
      const result = await aggregateRoleBatch(parsed.targets, proxyToDaemon);
      return jsonRes(res, 200, result);
    }

    let mRole: RegExpMatchArray | null;
    if ((mRole = url.pathname.match(/^\/api\/roles\/([^/]+)\/([^/]+)$/))) {
      const larkAppId = decodeURIComponent(mRole[1]);
      const chatId = decodeURIComponent(mRole[2]);
      if (req.method === 'GET') {
        const upstream = await proxyToDaemon(larkAppId, `/api/roles/${encodeURIComponent(chatId)}`, { method: 'GET' });
        res.writeHead(upstream.status, { 'content-type': 'application/json' });
        res.end(await upstream.text());
        return;
      }
      if (req.method === 'PUT') {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        const raw = Buffer.concat(chunks).toString('utf8') || '{}';
        const upstream = await proxyToDaemon(larkAppId, `/api/roles/${encodeURIComponent(chatId)}`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: raw,
        });
        const upstreamText = await upstream.text();
        let upstreamJson: any = null;
        try { upstreamJson = JSON.parse(upstreamText); } catch { /* leave null */ }
        // 写角色会翻转群矩阵里的 hasRole → 失效快照，避免 roles 页「已配置」
        // 徽标最多陈旧 30s（对齐 oncall bind/unbind、建群/加 bot 的失效）。
        if (roleWriteShouldInvalidate(upstream.ok, upstreamJson)) groupsMatrixSnapshot.invalidate();
        res.writeHead(upstream.status, { 'content-type': 'application/json' });
        res.end(upstreamText);
        return;
      }
      if (req.method === 'DELETE') {
        const upstream = await proxyToDaemon(larkAppId, `/api/roles/${encodeURIComponent(chatId)}`, { method: 'DELETE' });
        const upstreamText = await upstream.text();
        let upstreamJson: any = null;
        try { upstreamJson = JSON.parse(upstreamText); } catch { /* leave null */ }
        // 删角色会把 hasRole 翻回 false — 失效快照让徽标立即刷新，不等 30s TTL。
        if (roleWriteShouldInvalidate(upstream.ok, upstreamJson)) groupsMatrixSnapshot.invalidate();
        res.writeHead(upstream.status, { 'content-type': 'application/json' });
        res.end(upstreamText);
        return;
      }
    }

    // ─── Message listeners (proxy to daemon) ───────────────────────────────
    // GET    /api/message-listeners/:larkAppId/:chatId
    // PUT    /api/message-listeners/:larkAppId/:chatId
    // DELETE /api/message-listeners/:larkAppId/:chatId
    // POST   /api/message-listeners/:larkAppId/:chatId/(preview|run-preview)
    // GET    /api/message-listeners/:larkAppId/:chatId/run-preview/:runId
    let mMessageListener: RegExpMatchArray | null;
    if ((mMessageListener = url.pathname.match(/^\/api\/message-listeners\/([^/]+)\/([^/]+)\/run-preview\/([^/]+)$/))) {
      const larkAppId = decodeURIComponent(mMessageListener[1]);
      const chatId = decodeURIComponent(mMessageListener[2]);
      const runId = decodeURIComponent(mMessageListener[3]);
      if (req.method === 'GET') {
        const upstream = await proxyToDaemon(
          larkAppId,
          `/api/message-listeners/${encodeURIComponent(chatId)}/run-preview/${encodeURIComponent(runId)}`,
          { method: 'GET' },
        );
        res.writeHead(upstream.status, { 'content-type': 'application/json' });
        res.end(await upstream.text());
        return;
      }
    }
    if ((mMessageListener = url.pathname.match(/^\/api\/message-listeners\/([^/]+)\/([^/]+)\/(preview|run-preview)$/))) {
      const larkAppId = decodeURIComponent(mMessageListener[1]);
      const chatId = decodeURIComponent(mMessageListener[2]);
      const op = mMessageListener[3];
      if (req.method === 'POST') {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        const raw = Buffer.concat(chunks).toString('utf8') || '{}';
        const upstream = await proxyToDaemon(larkAppId, `/api/message-listeners/${encodeURIComponent(chatId)}/${op}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: raw,
        });
        res.writeHead(upstream.status, { 'content-type': 'application/json' });
        res.end(await upstream.text());
        return;
      }
    }
    if ((mMessageListener = url.pathname.match(/^\/api\/message-listeners\/([^/]+)\/([^/]+)$/))) {
      const larkAppId = decodeURIComponent(mMessageListener[1]);
      const chatId = decodeURIComponent(mMessageListener[2]);
      if (req.method === 'GET') {
        const upstream = await proxyToDaemon(larkAppId, `/api/message-listeners/${encodeURIComponent(chatId)}`, { method: 'GET' });
        res.writeHead(upstream.status, { 'content-type': 'application/json' });
        res.end(await upstream.text());
        return;
      }
      if (req.method === 'PUT') {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        const raw = Buffer.concat(chunks).toString('utf8') || '{}';
        const upstream = await proxyToDaemon(larkAppId, `/api/message-listeners/${encodeURIComponent(chatId)}`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: raw,
        });
        res.writeHead(upstream.status, { 'content-type': 'application/json' });
        res.end(await upstream.text());
        return;
      }
      if (req.method === 'DELETE') {
        const upstream = await proxyToDaemon(larkAppId, `/api/message-listeners/${encodeURIComponent(chatId)}`, { method: 'DELETE' });
        res.writeHead(upstream.status, { 'content-type': 'application/json' });
        res.end(await upstream.text());
        return;
      }
    }

    let mGroupMembersDisplay: RegExpMatchArray | null;
    if (req.method === 'GET' && (mGroupMembersDisplay = url.pathname.match(/^\/api\/groups\/([^/]+)\/([^/]+)\/members-display$/))) {
      const larkAppId = decodeURIComponent(mGroupMembersDisplay[1]);
      const chatId = decodeURIComponent(mGroupMembersDisplay[2]);
      const upstream = await proxyToDaemon(larkAppId, `/api/groups/${encodeURIComponent(chatId)}/members-display`, { method: 'GET' });
      res.writeHead(upstream.status, { 'content-type': 'application/json' });
      res.end(await upstream.text());
      return;
    }

    // ─── Profiles (aggregate/proxy to daemon) ─────────────────────────────
    // ─── 会议角色预设（私有 API：不在 PUBLIC_READ_PATHS，未认证已被 401） ───
    if (url.pathname === '/api/vc-meeting/consumer-profiles') {
      if (req.method === 'GET') {
        const out = await handleVcMeetingConsumerProfilesGet(vcMeetingConsumerProfilesApiDeps());
        return jsonRes(res, out.status, out.body);
      }
      if (req.method === 'PUT') {
        let parsed: unknown;
        try {
          parsed = await readJsonBody(req);
        } catch {
          return jsonRes(res, 400, { ok: false, error: 'bad_json' });
        }
        const out = await handleVcMeetingConsumerProfilesPut(parsed, vcMeetingConsumerProfilesApiDeps());
        return jsonRes(res, out.status, out.body);
      }
      return jsonRes(res, 405, { ok: false, error: 'method_not_allowed' });
    }

    // 按 bot 手动触发的开放平台前置配置（开权限 + 订 VC 事件 + 补 larkCliProfile）。
    // 私有 API，同样不在 PUBLIC_READ_PATHS。做成显式动作而不是随勾选自动跑：
    // 「接收会议事件」默认就是开的，没有 off→on 跃迁可挂；页面加载时对整个 fleet
    // 跑一遍则是几十上百次开放平台调用。
    if (url.pathname === '/api/vc-meeting/bot-preflight') {
      if (req.method !== 'POST') return jsonRes(res, 405, { ok: false, error: 'method_not_allowed' });
      let parsed: unknown;
      try {
        parsed = await readJsonBody(req);
      } catch {
        return jsonRes(res, 400, { ok: false, error: 'bad_json' });
      }
      const appId = (parsed as { appId?: unknown } | null)?.appId;
      if (typeof appId !== 'string' || !appId.trim()) {
        return jsonRes(res, 400, { ok: false, error: 'missing_appId' });
      }
      const out = await preflightVcMeetingBot(appId);
      if (out.ok) return jsonRes(res, 200, { ok: true });
      return jsonRes(res, 400, { ok: false, error: out.error, feishuLoginQr: out.feishuLoginQr });
    }

    // 「一键修复开放平台 redirect 白名单」批量入口：一次扫码，把全部（或 body 里
    // 点名的）存量 bot 的回调白名单补齐。白名单缺失是 authorize 的硬失败（20029），
    // 而存量 bot 今天没有任何自愈路径会去补它 —— 所以做成显式动作。
    // 私有 API，同样不在 PUBLIC_READ_PATHS，未认证已被 decideDashboardAuth 401。
    if (url.pathname === '/api/open-platform/repair-redirects') {
      if (req.method !== 'POST') return jsonRes(res, 405, { ok: false, error: 'method_not_allowed' });
      let parsed: unknown;
      try {
        parsed = await readJsonBody(req);
      } catch {
        return jsonRes(res, 400, { ok: false, error: 'bad_json' });
      }
      const rawAppIds = (parsed as { appIds?: unknown } | null)?.appIds;
      let appIds: string[] | undefined;
      if (rawAppIds !== undefined && rawAppIds !== null) {
        if (!Array.isArray(rawAppIds) || rawAppIds.some(id => typeof id !== 'string')) {
          return jsonRes(res, 400, { ok: false, error: 'invalid_appIds' });
        }
        appIds = rawAppIds as string[];
      }
      const out = await repairOpenPlatformRedirects({ appIds });
      if (out.ok) return jsonRes(res, 200, { ok: true, results: out.results, wanted: out.wanted });
      // 已有一批在跑 → 409（single-flight 在 service 侧，见 open-platform-redirect-repair.ts）：
      // 用户点两下不该排队等上一批跑完，也不该让两批抢同一份 session/csrf。
      if (out.reason === 'in_flight') {
        return jsonRes(res, 409, { ok: false, errorCode: 'repair_in_flight', message: out.message });
      }
      // 缺登录态不是错误，是「还差一步」：回 200 让前端走已有的扫码流程
      //（POST /api/feishu-login/start + GET /api/feishu-login/status）后重试，
      // 与 VC preflight 遇到同类失败时弹二维码是同一套登录态。
      if (out.reason === 'login_required') {
        return jsonRes(res, 200, { ok: false, errorCode: 'feishu_login_required', message: out.message });
      }
      return jsonRes(res, 502, { ok: false, errorCode: out.reason, message: out.message });
    }

    if (req.method === 'GET' && url.pathname === '/api/role-profiles') {
      type RoleProfileAggregate = {
        profileId: string;
        entryCount: number;
        updatedAt: number | null;
        botEntries: Array<{ larkAppId: string; hasEntry: boolean }>;
      };
      const merged = new Map<string, RoleProfileAggregate>();
      await Promise.all(registry.list().map(async d => {
        try {
          const r = await fetchDaemonIpc(d.ipcPort, '/api/role-profiles');
          if (!r.ok) return;
          const j = await r.json() as { profiles?: any[]; larkAppId?: string };
          for (const p of j.profiles ?? []) {
            if (typeof p.profileId !== 'string') continue;
            const cur: RoleProfileAggregate = merged.get(p.profileId) ?? { profileId: p.profileId, entryCount: 0, updatedAt: null, botEntries: [] };
            cur.entryCount = Math.max(cur.entryCount, typeof p.entryCount === 'number' ? p.entryCount : 0);
            if (typeof p.updatedAt === 'number') cur.updatedAt = cur.updatedAt === null ? p.updatedAt : Math.max(cur.updatedAt, p.updatedAt);
            const larkAppId = j.larkAppId ?? d.larkAppId;
            if (!cur.botEntries.some(entry => entry.larkAppId === larkAppId)) {
              cur.botEntries.push({ larkAppId, hasEntry: p.hasCurrentBotEntry === true });
            }
            merged.set(p.profileId, cur);
          }
        } catch { /* skip offline/bad daemon */ }
      }));
      return jsonRes(res, 200, {
        profiles: [...merged.values()]
          .map(p => ({
            ...p,
            entryCount: Math.max(p.entryCount, p.botEntries.filter(entry => entry.hasEntry).length),
          }))
          .sort((a, b) => a.profileId.localeCompare(b.profileId)),
      });
    }

    let mRoleProfileApply: RegExpMatchArray | null;
    if (req.method === 'POST' && (mRoleProfileApply = url.pathname.match(/^\/api\/role-profiles\/([^/]+)\/apply$/))) {
      const profileId = decodeURIComponent(mRoleProfileApply[1]);
      if (!isValidRoleProfileId(profileId)) return jsonRes(res, 400, { ok: false, error: 'invalid_role_profile_id' });
      let raw = '{}';
      let parsed: { larkAppId?: unknown };
      try {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        raw = Buffer.concat(chunks).toString('utf8') || '{}';
        parsed = JSON.parse(raw);
      } catch {
        return jsonRes(res, 400, { ok: false, error: 'bad_json' });
      }
      const larkAppId = typeof parsed.larkAppId === 'string' ? parsed.larkAppId : '';
      if (!larkAppId) return jsonRes(res, 400, { ok: false, error: 'larkAppId_required' });
      const upstream = await proxyToDaemon(larkAppId, `/api/role-profiles/${encodeURIComponent(profileId)}/apply`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: raw,
      });
      const upstreamText = await upstream.text();
      let upstreamJson: any = null;
      try { upstreamJson = JSON.parse(upstreamText); } catch { /* leave null */ }
      // 只有真正改写了角色文件（changed:true）才失效缓存：preview、被拒
      // （chat_role_exists）、missing_entry 都不动 hasRole，跟着失效只会白白
      // 打穿 30s 快照、把 PR 的 fan-out 优化抵消掉（判定在 roleWriteShouldInvalidate）。
      if (roleWriteShouldInvalidate(upstream.ok, upstreamJson)) groupsMatrixSnapshot.invalidate();
      res.writeHead(upstream.status, { 'content-type': 'application/json' });
      res.end(upstreamText);
      return;
    }

    let mRoleProfileEntry: RegExpMatchArray | null;
    if ((mRoleProfileEntry = url.pathname.match(/^\/api\/role-profiles\/([^/]+)\/([^/]+)$/))) {
      const profileId = decodeURIComponent(mRoleProfileEntry[1]);
      const larkAppId = decodeURIComponent(mRoleProfileEntry[2]);
      if (!isValidRoleProfileId(profileId)) return jsonRes(res, 400, { ok: false, error: 'invalid_role_profile_id' });
      if (req.method === 'GET') {
        const upstream = await proxyToDaemon(larkAppId, `/api/role-profiles/${encodeURIComponent(profileId)}/${encodeURIComponent(larkAppId)}`, { method: 'GET' });
        res.writeHead(upstream.status, { 'content-type': 'application/json' });
        res.end(await upstream.text());
        return;
      }
      if (req.method === 'PUT') {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        const raw = Buffer.concat(chunks).toString('utf8') || '{}';
        const upstream = await proxyToDaemon(larkAppId, `/api/role-profiles/${encodeURIComponent(profileId)}/${encodeURIComponent(larkAppId)}`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: raw,
        });
        res.writeHead(upstream.status, { 'content-type': 'application/json' });
        res.end(await upstream.text());
        return;
      }
      if (req.method === 'DELETE') {
        const upstream = await proxyToDaemon(larkAppId, `/api/role-profiles/${encodeURIComponent(profileId)}/${encodeURIComponent(larkAppId)}`, { method: 'DELETE' });
        res.writeHead(upstream.status, { 'content-type': 'application/json' });
        res.end(await upstream.text());
        return;
      }
    }

    let mRoleProfile: RegExpMatchArray | null;
    if (req.method === 'GET' && (mRoleProfile = url.pathname.match(/^\/api\/role-profiles\/([^/]+)$/))) {
      const profileId = decodeURIComponent(mRoleProfile[1]);
      if (!isValidRoleProfileId(profileId)) return jsonRes(res, 400, { ok: false, error: 'invalid_role_profile_id' });
      type RoleProfileEntryAggregate = {
        profileId: string;
        larkAppId: string;
        content: string;
        byteLength: number;
        updatedAt: number | null;
      };
      const byBot = new Map<string, RoleProfileEntryAggregate>();
      await Promise.all(registry.list().map(async d => {
        try {
          const r = await fetchDaemonIpc(
            d.ipcPort,
            `/api/role-profiles/${encodeURIComponent(profileId)}`,
          );
          if (!r.ok) return;
          const j = await r.json() as { entries?: any[] };
          for (const entry of j.entries ?? []) {
            if (typeof entry.larkAppId !== 'string' || typeof entry.content !== 'string') continue;
            const updatedAt = typeof entry.updatedAt === 'number' ? entry.updatedAt : null;
            const current = byBot.get(entry.larkAppId);
            if (current && (current.updatedAt ?? 0) > (updatedAt ?? 0)) continue;
            byBot.set(entry.larkAppId, {
              profileId,
              larkAppId: entry.larkAppId,
              content: entry.content,
              byteLength: typeof entry.byteLength === 'number' ? entry.byteLength : Buffer.byteLength(entry.content, 'utf-8'),
              updatedAt,
            });
          }
        } catch { /* skip */ }
      }));
      const entries = [...byBot.values()].sort((a, b) => a.larkAppId.localeCompare(b.larkAppId));
      return jsonRes(res, 200, { profileId, entries });
    }

    let m2: RegExpMatchArray | null;
    if (req.method === 'POST' && (m2 = url.pathname.match(/^\/api\/groups\/([^/]+)\/add-bots$/))) {
      const chatId = decodeURIComponent(m2[1]);
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const raw = Buffer.concat(chunks).toString('utf8') || '{}';
      const result = await addBotsToGroup(chatId, raw, groupsActionDeps);
      return writeHandlerResult(res, result);
    }

    // Disband a chat. Body: `{ larkAppId }` — the bot whose daemon should
    // perform the delete. See `dashboard/groups-action-helpers.ts:disbandGroup`.
    let mDisband: RegExpMatchArray | null;
    if (req.method === 'POST' && (mDisband = url.pathname.match(/^\/api\/groups\/([^/]+)\/disband$/))) {
      const chatId = decodeURIComponent(mDisband[1]);
      let parsed: unknown;
      try {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      } catch {
        return jsonRes(res, 400, { ok: false, error: 'bad_json' });
      }
      const result = await disbandGroup(chatId, parsed, groupsActionDeps);
      return writeHandlerResult(res, result);
    }

    // Make selected bots leave a chat. Body: `{ larkAppIds: string[] }`. See
    // `dashboard/groups-action-helpers.ts:leaveGroup` for membership probe +
    // cascade-close semantics.
    let mLeave: RegExpMatchArray | null;
    if (req.method === 'POST' && (mLeave = url.pathname.match(/^\/api\/groups\/([^/]+)\/leave$/))) {
      const chatId = decodeURIComponent(mLeave[1]);
      let parsed: unknown;
      try {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      } catch {
        return jsonRes(res, 400, { ok: false, error: 'bad_json' });
      }
      const result = await leaveGroup(chatId, parsed, groupsActionDeps);
      return writeHandlerResult(res, result);
    }

    // ─── Oncall bindings (per chat × bot) ────────────────────────────────────
    // External: PUT/DELETE /api/groups/:chatId/oncall/:larkAppId
    // Internal: PUT/DELETE /api/oncall/:chatId (on the named bot's daemon).
    let mOncall: RegExpMatchArray | null;
    if ((mOncall = url.pathname.match(/^\/api\/groups\/([^/]+)\/oncall\/([^/]+)$/))) {
      const chatId = decodeURIComponent(mOncall[1]);
      const appId = decodeURIComponent(mOncall[2]);
      if (req.method === 'PUT') {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        const raw = Buffer.concat(chunks).toString('utf8');
        const result = await bindOncall(chatId, appId, raw, groupsActionDeps);
        return writeHandlerResult(res, result);
      }
      if (req.method === 'DELETE') {
        const result = await unbindOncall(chatId, appId, groupsActionDeps);
        return writeHandlerResult(res, result);
      }
    }

    // ─── Per-bot defaults (Bot Defaults tab) ─────────────────────────────────
    // GET  /api/bots                         — fan out to each daemon, return
    //                                          [{larkAppId, botName, defaultOncall, ...}]
    // PUT  /api/bots/:appId/default-oncall   — proxy to that bot's daemon

    if (req.method === 'GET' && url.pathname === '/api/bots') {
      const agentFields = configuredBotAgentFields();
      // brand 是 bots.json 的 per-bot 字段（DaemonRegistry 心跳态不带它），
      // 从 configuredBrands（失败安全,返空 Map）按 appId 补进每个 descriptor,
      // 供前端派生飞书后台深链 host;缺配置时前端 normalizeBrand 兜底 feishu。
      const brandByAppId = configuredBrands();
      const onlineBots = [...registry.list()]
        .map(b => withConfiguredCliId(b, agentFields))
        .map(b => ({ ...b, brand: brandByAppId.get(b.larkAppId) }))
        .sort((a, b) => a.botIndex - b.botIndex);
      const out = await Promise.all(onlineBots.map(async d => {
        try {
          const r = await fetchDaemonIpc(d.ipcPort, '/api/bot-default-oncall');
          if (!r.ok) {
            return botDefaultsPayload(d, undefined, `http_${r.status}`);
          }
          const j = await r.json() as any;
          return botDefaultsPayload({
            ...d,
            botName: d.botName ?? j.botName,
            cliId: j.cliId || d.cliId,
            // New daemons return explicit null for Official/no legacy path.
            // Respect that instead of reviving a stale fallback descriptor;
            // older daemons omit the fields and still use bots.json fallback.
            cliRuntime: Object.prototype.hasOwnProperty.call(j, 'cliRuntime')
              ? j.cliRuntime ?? undefined
              : d.cliRuntime,
            cliPathOverride: Object.prototype.hasOwnProperty.call(j, 'cliPathOverride')
              ? j.cliPathOverride ?? undefined
              : d.cliPathOverride,
            wrapperCli: j.wrapperCli || d.wrapperCli,
            model: j.model || d.model,
            reasoningEffort: j.reasoningEffort || d.reasoningEffort,
            turnTimeoutMs: typeof j.turnTimeoutMs === 'number' ? j.turnTimeoutMs : d.turnTimeoutMs,
            dshRuntime: typeof j.dshRuntime === 'string' ? j.dshRuntime : d.dshRuntime,
          }, j);
        } catch (e: any) {
          return botDefaultsPayload(d, undefined, e?.message ?? String(e));
        }
      }));
      return jsonRes(res, 200, { bots: out });
    }

    let mBotDef: RegExpMatchArray | null;
    if (req.method === 'PUT' && (mBotDef = url.pathname.match(/^\/api\/bots\/([^/]+)\/default-oncall$/))) {
      const appId = decodeURIComponent(mBotDef[1]);
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const raw = Buffer.concat(chunks).toString('utf8') || '{}';
      const upstream = await proxyToDaemon(appId, `/api/bot-default-oncall`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: raw,
      });
      res.writeHead(upstream.status, { 'content-type': 'application/json' });
      res.end(await upstream.text());
      return;
    }

    // PUT /api/bots/:appId/working-dir-mode — proxy to that bot's daemon. Body
    // `{ mode: 'off'|'default'|'oncall', workingDir }` — sets the 3-way
    // mutually-exclusive default-dir mode (defaultWorkingDir vs defaultOncall).
    let mBotWdMode: RegExpMatchArray | null;
    if (req.method === 'PUT' && (mBotWdMode = url.pathname.match(/^\/api\/bots\/([^/]+)\/working-dir-mode$/))) {
      const appId = decodeURIComponent(mBotWdMode[1]);
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const raw = Buffer.concat(chunks).toString('utf8') || '{}';
      const upstream = await proxyToDaemon(appId, `/api/bot-working-dir-mode`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: raw,
      });
      res.writeHead(upstream.status, { 'content-type': 'application/json' });
      res.end(await upstream.text());
      return;
    }

    // PUT /api/bots/:appId/agent — proxy to that bot's daemon. Body
    // `{ cliId, model }`; cliId is the dashboard selection key.
    let mBotAgent: RegExpMatchArray | null;
    if (req.method === 'PUT' && (mBotAgent = url.pathname.match(/^\/api\/bots\/([^/]+)\/agent$/))) {
      const appId = decodeURIComponent(mBotAgent[1]);
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const raw = Buffer.concat(chunks).toString('utf8') || '{}';
      const upstream = await proxyToDaemon(appId, `/api/bot-agent`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: raw,
      });
      res.writeHead(upstream.status, { 'content-type': 'application/json' });
      res.end(await upstream.text());
      return;
    }

    // PUT /api/bots/:appId/skills — proxy to that bot's daemon. Body accepts
    // `{ action:'attach'|'detach', name }` or `{ action:'set', policy|null }`.
    let mBotSkills: RegExpMatchArray | null;
    if (req.method === 'PUT' && (mBotSkills = url.pathname.match(/^\/api\/bots\/([^/]+)\/skills$/))) {
      const appId = decodeURIComponent(mBotSkills[1]);
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const raw = Buffer.concat(chunks).toString('utf8') || '{}';
      const upstream = await proxyToDaemon(appId, `/api/bot-skills`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: raw,
      });
      res.writeHead(upstream.status, { 'content-type': 'application/json' });
      res.end(await upstream.text());
      return;
    }

    // PUT /api/bots/:appId/brand-label — proxy to that bot's daemon. Body
    // `{ brandLabel: string | null }` (string '' = off, null = default).
    let mBotBrand: RegExpMatchArray | null;
    if (req.method === 'PUT' && (mBotBrand = url.pathname.match(/^\/api\/bots\/([^/]+)\/brand-label$/))) {
      const appId = decodeURIComponent(mBotBrand[1]);
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const raw = Buffer.concat(chunks).toString('utf8') || '{}';
      const upstream = await proxyToDaemon(appId, `/api/bot-brand-label`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: raw,
      });
      res.writeHead(upstream.status, { 'content-type': 'application/json' });
      res.end(await upstream.text());
      return;
    }

    // PUT /api/bots/:appId/reply-style — proxy the sparse reply-card style
    // override to the target bot's daemon. The daemon owns validation, atomic
    // bots.json persistence, and its in-memory config update for future worker
    // spawns. Running workers intentionally retain their session snapshot.
    let mBotReplyStyle: RegExpMatchArray | null;
    if (req.method === 'PUT' && (mBotReplyStyle = url.pathname.match(/^\/api\/bots\/([^/]+)\/reply-style$/))) {
      const appId = decodeURIComponent(mBotReplyStyle[1]);
      let raw: string;
      try {
        raw = JSON.stringify(await readJsonBody(req, REPLY_STYLE_REQUEST_MAX_BYTES));
      } catch (err) {
        const status = err instanceof DashboardJsonBodyTooLargeError ? 413 : 400;
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: status === 413 ? 'body_too_large' : 'bad_json' }));
        return;
      }
      const upstream = await proxyToDaemon(appId, `/api/bot-reply-style`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: raw,
      });
      res.writeHead(upstream.status, { 'content-type': 'application/json' });
      res.end(await upstream.text());
      return;
    }

    // PUT /api/bots/:appId/startup-commands — proxy to that bot's daemon. Body
    // `{ startupCommands: string }` (raw text, comma/newline separated; '' = clear).
    let mBotStartup: RegExpMatchArray | null;
    if (req.method === 'PUT' && (mBotStartup = url.pathname.match(/^\/api\/bots\/([^/]+)\/startup-commands$/))) {
      const appId = decodeURIComponent(mBotStartup[1]);
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const raw = Buffer.concat(chunks).toString('utf8') || '{}';
      const upstream = await proxyToDaemon(appId, `/api/bot-startup-commands`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: raw,
      });
      res.writeHead(upstream.status, { 'content-type': 'application/json' });
      res.end(await upstream.text());
      return;
    }

    // PUT /api/bots/:appId/custom-passthrough — proxy to that bot's daemon. Body
    // `{ customPassthroughCommands: string }` (raw text, comma/space separated; '' = clear).
    let mBotPassthrough: RegExpMatchArray | null;
    if (req.method === 'PUT' && (mBotPassthrough = url.pathname.match(/^\/api\/bots\/([^/]+)\/custom-passthrough$/))) {
      const appId = decodeURIComponent(mBotPassthrough[1]);
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const raw = Buffer.concat(chunks).toString('utf8') || '{}';
      const upstream = await proxyToDaemon(appId, `/api/bot-custom-passthrough`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: raw,
      });
      res.writeHead(upstream.status, { 'content-type': 'application/json' });
      res.end(await upstream.text());
      return;
    }

    // PUT /api/bots/:appId/cantalk-daemon-commands — proxy to that bot's daemon. Body
    // `{ canTalkDaemonCommands: string }` (raw text, comma/space separated; '' = clear).
    let mBotCanTalk: RegExpMatchArray | null;
    if (req.method === 'PUT' && (mBotCanTalk = url.pathname.match(/^\/api\/bots\/([^/]+)\/cantalk-daemon-commands$/))) {
      const appId = decodeURIComponent(mBotCanTalk[1]);
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const raw = Buffer.concat(chunks).toString('utf8') || '{}';
      const upstream = await proxyToDaemon(appId, `/api/bot-cantalk-daemon-commands`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: raw,
      });
      res.writeHead(upstream.status, { 'content-type': 'application/json' });
      res.end(await upstream.text());
      return;
    }

    // PUT /api/bots/:appId/launch-shell — proxy to that bot's daemon. Body
    // `{ launchShell: string }` (shell name or absolute path; '' = clear → $SHELL).
    let mBotLaunchShell: RegExpMatchArray | null;
    if (req.method === 'PUT' && (mBotLaunchShell = url.pathname.match(/^\/api\/bots\/([^/]+)\/launch-shell$/))) {
      const appId = decodeURIComponent(mBotLaunchShell[1]);
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const raw = Buffer.concat(chunks).toString('utf8') || '{}';
      const upstream = await proxyToDaemon(appId, `/api/bot-launch-shell`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: raw,
      });
      res.writeHead(upstream.status, { 'content-type': 'application/json' });
      res.end(await upstream.text());
      return;
    }

    let mBotFeedback: RegExpMatchArray | null;
    if (req.method === 'PUT' && (mBotFeedback = url.pathname.match(/^\/api\/bots\/([^/]+)\/feedback$/))) {
      const appId = decodeURIComponent(mBotFeedback[1]);
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const raw = Buffer.concat(chunks).toString('utf8') || '{}';
      const upstream = await proxyToDaemon(appId, `/api/bot-feedback`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: raw });
      res.writeHead(upstream.status, { 'content-type': 'application/json' });
      res.end(await upstream.text());
      return;
    }

    const mChatFeedback = url.pathname.match(/^\/api\/bots\/([^/]+)\/chats\/([^/]+)\/feedback$/);
    if (req.method === 'PUT' && mChatFeedback) {
      const chunks: Buffer[] = []; for await (const c of req) chunks.push(c as Buffer);
      const upstream = await proxyToDaemon(decodeURIComponent(mChatFeedback[1]), `/api/chat-feedback/${encodeURIComponent(decodeURIComponent(mChatFeedback[2]))}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: Buffer.concat(chunks).toString('utf8') || '{}' });
      res.writeHead(upstream.status, { 'content-type': 'application/json' }); res.end(await upstream.text()); return;
    }
    const mEffectiveFeedback = url.pathname.match(/^\/api\/bots\/([^/]+)\/feedback\/effective$/);
    if (req.method === 'GET' && mEffectiveFeedback) {
      const upstream = await proxyToDaemon(decodeURIComponent(mEffectiveFeedback[1]), `/api/feedback-effective${url.search}`, { method: 'GET' });
      res.writeHead(upstream.status, { 'content-type': 'application/json' }); res.end(await upstream.text()); return;
    }

    // PUT /api/bots/:appId/env — proxy to that bot's daemon. Body
    // `{ env: string }` (raw JSON text; '' = clear).
    let mBotEnv: RegExpMatchArray | null;
    if (req.method === 'PUT' && (mBotEnv = url.pathname.match(/^\/api\/bots\/([^/]+)\/env$/))) {
      const appId = decodeURIComponent(mBotEnv[1]);
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const raw = Buffer.concat(chunks).toString('utf8') || '{}';
      const upstream = await proxyToDaemon(appId, `/api/bot-env`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: raw,
      });
      res.writeHead(upstream.status, { 'content-type': 'application/json' });
      res.end(await upstream.text());
      return;
    }

    // PUT /api/bots/:appId/codex-auth-sync — per-bot Codex credential policy.
    let mBotCodexAuthSync: RegExpMatchArray | null;
    if (req.method === 'PUT' && (mBotCodexAuthSync = url.pathname.match(/^\/api\/bots\/([^/]+)\/codex-auth-sync$/))) {
      const appId = decodeURIComponent(mBotCodexAuthSync[1]);
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const raw = Buffer.concat(chunks).toString('utf8') || '{}';
      const upstream = await proxyToDaemon(appId, `/api/bot-codex-auth-sync`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: raw,
      });
      res.writeHead(upstream.status, { 'content-type': 'application/json' });
      res.end(await upstream.text());
      return;
    }

    // PUT /api/bots/:appId/riff — proxy to that bot's daemon. Body
    // `{ riff: string }` (raw JSON text; '' = clear).
    let mBotRiff: RegExpMatchArray | null;
    if (req.method === 'PUT' && (mBotRiff = url.pathname.match(/^\/api\/bots\/([^/]+)\/riff$/))) {
      const appId = decodeURIComponent(mBotRiff[1]);
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const raw = Buffer.concat(chunks).toString('utf8') || '{}';
      const upstream = await proxyToDaemon(appId, `/api/bot-riff`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: raw,
      });
      res.writeHead(upstream.status, { 'content-type': 'application/json' });
      res.end(await upstream.text());
      return;
    }

    // PUT /api/bots/:appId/sandbox-paths — proxy to that bot's daemon.
    // Body `{ readWrite?: string[]; readOnly?: string[]; deny?: string[] }`.
    let mBotSandboxPaths: RegExpMatchArray | null;
    if (req.method === 'PUT' && (mBotSandboxPaths = url.pathname.match(/^\/api\/bots\/([^/]+)\/sandbox-paths$/))) {
      const appId = decodeURIComponent(mBotSandboxPaths[1]);
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const raw = Buffer.concat(chunks).toString('utf8') || '{}';
      const upstream = await proxyToDaemon(appId, `/api/bot-sandbox-paths`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: raw,
      });
      res.writeHead(upstream.status, { 'content-type': 'application/json' });
      res.end(await upstream.text());
      return;
    }

    // GET /api/fs/list?path=… — read-only directory listing for the sandbox-paths
    // tree picker. Not bot-specific (the filesystem is shared with this host's
    // daemons — the dashboard process runs on the SAME machine), so serve it
    // locally instead of proxying. Returns immediate child directories only.
    if (req.method === 'GET' && url.pathname === '/api/fs/list') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(listDirLocally(url.searchParams.get('path') ?? '')));
      return;
    }

    // PUT /api/bots/:appId/sandbox — proxy to that bot's daemon. Body `{ enabled: boolean }`.
    let mBotSandbox: RegExpMatchArray | null;
    if (req.method === 'PUT' && (mBotSandbox = url.pathname.match(/^\/api\/bots\/([^/]+)\/sandbox$/))) {
      const appId = decodeURIComponent(mBotSandbox[1]);
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const raw = Buffer.concat(chunks).toString('utf8') || '{}';
      const upstream = await proxyToDaemon(appId, `/api/bot-sandbox`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: raw,
      });
      res.writeHead(upstream.status, { 'content-type': 'application/json' });
      res.end(await upstream.text());
      return;
    }

    // PUT /api/bots/:appId/read-isolation — proxy to that bot's daemon. Body `{ enabled: boolean }`.
    let mBotReadIso: RegExpMatchArray | null;
    if (req.method === 'PUT' && (mBotReadIso = url.pathname.match(/^\/api\/bots\/([^/]+)\/read-isolation$/))) {
      const appId = decodeURIComponent(mBotReadIso[1]);
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const raw = Buffer.concat(chunks).toString('utf8') || '{}';
      const upstream = await proxyToDaemon(appId, `/api/bot-read-isolation`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: raw,
      });
      res.writeHead(upstream.status, { 'content-type': 'application/json' });
      res.end(await upstream.text());
      return;
    }

    // PUT /api/bots/:appId/backend-type — proxy to that bot's daemon. Body
    // `{ backendType: 'pty'|'tmux'|'herdr'|'zellij'|'zmx'|'' }` ('' / 'auto' clears the override).
    let mBotBackendType: RegExpMatchArray | null;
    if (req.method === 'PUT' && (mBotBackendType = url.pathname.match(/^\/api\/bots\/([^/]+)\/backend-type$/))) {
      const appId = decodeURIComponent(mBotBackendType[1]);
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const raw = Buffer.concat(chunks).toString('utf8') || '{}';
      const upstream = await proxyToDaemon(appId, `/api/bot-backend-type`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: raw,
      });
      res.writeHead(upstream.status, { 'content-type': 'application/json' });
      res.end(await upstream.text());
      return;
    }

    // PUT /api/bots/:appId/card-prefs — proxy to that bot's daemon. Body carries
    // any subset of per-bot behavior booleans / prompt strings.
    let mBotCardPrefs: RegExpMatchArray | null;
    if (req.method === 'PUT' && (mBotCardPrefs = url.pathname.match(/^\/api\/bots\/([^/]+)\/card-prefs$/))) {
      const appId = decodeURIComponent(mBotCardPrefs[1]);
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const raw = Buffer.concat(chunks).toString('utf8') || '{}';
      const upstream = await proxyToDaemon(appId, `/api/bot-card-prefs`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: raw,
      });
      res.writeHead(upstream.status, { 'content-type': 'application/json' });
      res.end(await upstream.text());
      return;
    }

    // PUT /api/bots/:appId/substitute-mode — proxy to that bot's daemon. Body
    // carries `{ enabled, targets, disclosure }`.
    let mBotSubstituteMode: RegExpMatchArray | null;
    if (req.method === 'PUT' && (mBotSubstituteMode = url.pathname.match(/^\/api\/bots\/([^/]+)\/substitute-mode$/))) {
      const appId = decodeURIComponent(mBotSubstituteMode[1]);
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const raw = Buffer.concat(chunks).toString('utf8') || '{}';
      const upstream = await proxyToDaemon(appId, `/api/bot-substitute-mode`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: raw,
      });
      res.writeHead(upstream.status, { 'content-type': 'application/json' });
      res.end(await upstream.text());
      return;
    }

    // POST /api/bots/:appId/substitute-targets/resolve — preview resolution for a
    // single target without persisting; used for dashboard auto-fill.
    let mBotSubstituteResolve: RegExpMatchArray | null;
    if (req.method === 'POST' && (mBotSubstituteResolve = url.pathname.match(/^\/api\/bots\/([^/]+)\/substitute-targets\/resolve$/))) {
      const appId = decodeURIComponent(mBotSubstituteResolve[1]);
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const raw = Buffer.concat(chunks).toString('utf8') || '{}';
      const upstream = await proxyToDaemon(appId, `/api/bot-substitute-targets/resolve`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: raw,
      });
      res.writeHead(upstream.status, { 'content-type': 'application/json' });
      res.end(await upstream.text());
      return;
    }

    // PUT /api/bots/:appId/summary-range — proxy to that bot's daemon. Body
    // `{ limit, sinceHours }`; daemon updates the explicit /summary range.
    let mBotSummaryRange: RegExpMatchArray | null;
    if (req.method === 'PUT' && (mBotSummaryRange = url.pathname.match(/^\/api\/bots\/([^/]+)\/summary-range$/))) {
      const appId = decodeURIComponent(mBotSummaryRange[1]);
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const raw = Buffer.concat(chunks).toString('utf8') || '{}';
      const upstream = await proxyToDaemon(appId, `/api/bot-summary-range`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: raw,
      });
      res.writeHead(upstream.status, { 'content-type': 'application/json' });
      res.end(await upstream.text());
      return;
    }

    // Backward-compatible alias from the short-lived keyword-trigger dashboard.
    let mBotSummaryTrigger: RegExpMatchArray | null;
    if (req.method === 'PUT' && (mBotSummaryTrigger = url.pathname.match(/^\/api\/bots\/([^/]+)\/summary-trigger$/))) {
      const appId = decodeURIComponent(mBotSummaryTrigger[1]);
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const raw = Buffer.concat(chunks).toString('utf8') || '{}';
      const upstream = await proxyToDaemon(appId, `/api/bot-summary-trigger`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: raw,
      });
      res.writeHead(upstream.status, { 'content-type': 'application/json' });
      res.end(await upstream.text());
      return;
    }

    // 会话群标签授权（Dashboard 一站式）：GET status / POST auth-link，
    // 均代理到对应 bot 的 daemon（state 必须驻留在生成链接的进程内）。
    let mBotTagAuth: RegExpMatchArray | null;
    if (mBotTagAuth = url.pathname.match(/^\/api\/bots\/([^/]+)\/session-group-tag-(status|auth|config)$/)) {
      const appId = decodeURIComponent(mBotTagAuth[1]);
      const kind = mBotTagAuth[2];
      const methodOk = (kind === 'status' && req.method === 'GET')
        || (kind === 'auth' && req.method === 'POST')
        || (kind === 'config' && req.method === 'PUT');
      if (methodOk) {
        let body: string | undefined;
        if (req.method !== 'GET') {
          const chunks: Buffer[] = [];
          for await (const c of req) chunks.push(c as Buffer);
          body = Buffer.concat(chunks).toString('utf8') || '{}';
        }
        const upstream = await proxyToDaemon(appId, `/api/session-group-tag-${kind}`, {
          method: req.method,
          headers: { 'content-type': 'application/json' },
          ...(body !== undefined ? { body } : {}),
        });
        res.writeHead(upstream.status, { 'content-type': 'application/json' });
        res.end(await upstream.text());
        return;
      }
    }

    // PUT /api/bots/:appId/p2p-mode — proxy to that bot's daemon. Body
    // `{ p2pMode: 'chat' | 'thread' | 'group' }` ('thread' = per-message DM
    // session; 'group' = per-message dedicated session group; anything else
    // clears back to the flat continuous chat default).
    let mBotP2pMode: RegExpMatchArray | null;
    if (req.method === 'PUT' && (mBotP2pMode = url.pathname.match(/^\/api\/bots\/([^/]+)\/p2p-mode$/))) {
      const appId = decodeURIComponent(mBotP2pMode[1]);
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const raw = Buffer.concat(chunks).toString('utf8') || '{}';
      const upstream = await proxyToDaemon(appId, `/api/bot-p2p-mode`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: raw,
      });
      res.writeHead(upstream.status, { 'content-type': 'application/json' });
      res.end(await upstream.text());
      return;
    }

    // PUT /api/bots/:appId/envelope-injection — proxy to that bot's daemon.
    // Body `{ envelopeInjection: 'auto'|'off'|'' }` (''/other clears back to
    // the inline default). #794: hook 注入 per-turn 上下文的 per-bot 开关。
    let mBotEnvelopeInjection: RegExpMatchArray | null;
    if (req.method === 'PUT' && (mBotEnvelopeInjection = url.pathname.match(/^\/api\/bots\/([^/]+)\/envelope-injection$/))) {
      const appId = decodeURIComponent(mBotEnvelopeInjection[1]);
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const raw = Buffer.concat(chunks).toString('utf8') || '{}';
      const upstream = await proxyToDaemon(appId, `/api/bot-envelope-injection`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: raw,
      });
      res.writeHead(upstream.status, { 'content-type': 'application/json' });
      res.end(await upstream.text());
      return;
    }

    // PUT /api/bots/:appId/skill-injection — proxy to that bot's daemon. Body
    // `{ skillInjection: 'global'|'prompt'|'off'|'' }` (''/other clears back to
    // the machine default). Governs how botmux built-in skills reach global-
    // skillsDir CLIs (codex/gemini/…).
    let mBotSkillInjection: RegExpMatchArray | null;
    if (req.method === 'PUT' && (mBotSkillInjection = url.pathname.match(/^\/api\/bots\/([^/]+)\/skill-injection$/))) {
      const appId = decodeURIComponent(mBotSkillInjection[1]);
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const raw = Buffer.concat(chunks).toString('utf8') || '{}';
      const upstream = await proxyToDaemon(appId, `/api/bot-skill-injection`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: raw,
      });
      res.writeHead(upstream.status, { 'content-type': 'application/json' });
      res.end(await upstream.text());
      return;
    }

    // PUT /api/bots/:appId/grant-prefs — proxy to that bot's daemon. Body carries
    // any subset of `{ restrictGrantCommands?: boolean, autoGrantRequestCards?: boolean,
    // p2pOpen?: boolean, messageQuotaDefaultLimit?: number|null,
    // grantDefaultDurationMs?: number|null }`.
    let mBotGrantPrefs: RegExpMatchArray | null;
    if (req.method === 'PUT' && (mBotGrantPrefs = url.pathname.match(/^\/api\/bots\/([^/]+)\/grant-prefs$/))) {
      const appId = decodeURIComponent(mBotGrantPrefs[1]);
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const raw = Buffer.concat(chunks).toString('utf8') || '{}';
      const upstream = await proxyToDaemon(appId, `/api/bot-grant-prefs`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: raw,
      });
      res.writeHead(upstream.status, { 'content-type': 'application/json' });
      res.end(await upstream.text());
      return;
    }

    // PUT /api/bots/:appId/rename — proxy to that bot's daemon. Body
    // `{ name: string }`. Daemon tries the Open Platform automation first
    // (really renames the Feishu app + publishes a version); on failure it
    // falls back to the botmux-side display name and reports `warning`.
    let mBotRename: RegExpMatchArray | null;
    if (req.method === 'PUT' && (mBotRename = url.pathname.match(/^\/api\/bots\/([^/]+)\/rename$/))) {
      const appId = decodeURIComponent(mBotRename[1]);
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const raw = Buffer.concat(chunks).toString('utf8') || '{}';
      const upstream = await proxyToDaemon(appId, `/api/bot-rename`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: raw,
      });
      res.writeHead(upstream.status, { 'content-type': 'application/json' });
      res.end(await upstream.text());
      return;
    }

    // GET/PUT /api/bots/:appId/description — proxy to that bot's daemon. GET
    // returns the localized descriptions read straight off the Open Platform;
    // PUT body `{ descriptions: Record<lang, string> }` republishes them. The
    // daemon owns all validation/publish/language-set semantics; this proxy only
    // forwards, bounding the PUT body so a malicious client can't buffer freely.
    let mBotDescription: RegExpMatchArray | null;
    if (
      (req.method === 'GET' || req.method === 'PUT') &&
      (mBotDescription = url.pathname.match(/^\/api\/bots\/([^/]+)\/description$/))
    ) {
      const appId = decodeURIComponent(mBotDescription[1]);
      if (req.method === 'GET') {
        const upstream = await proxyToDaemon(appId, `/api/bot-description`, { method: 'GET' });
        res.writeHead(upstream.status, { 'content-type': 'application/json' });
        res.end(await upstream.text());
        return;
      }
      const chunks: Buffer[] = [];
      let received = 0;
      for await (const c of req) {
        received += (c as Buffer).length;
        // Descriptions are tiny (≤20 langs × ≤120 chars); cap before buffering more.
        if (received > 64 * 1024) {
          res.writeHead(413, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'body_too_large' }));
          return;
        }
        chunks.push(c as Buffer);
      }
      const raw = Buffer.concat(chunks).toString('utf8') || '{}';
      const upstream = await proxyToDaemon(appId, `/api/bot-description`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: raw,
      });
      res.writeHead(upstream.status, { 'content-type': 'application/json' });
      res.end(await upstream.text());
      return;
    }

    // PUT /api/bots/:appId/avatar — proxy to that bot's daemon. Body
    // `{ imageBase64: string }` (512×512 PNG, canvas-normalized by the web UI).
    // The daemon runs the Open Platform automation (upload icon + base_info +
    // publish a version); there is no local fallback — failures return the
    // structured reason so the UI can prompt for a Feishu web login.
    let mBotAvatar: RegExpMatchArray | null;
    if (req.method === 'PUT' && (mBotAvatar = url.pathname.match(/^\/api\/bots\/([^/]+)\/avatar$/))) {
      const appId = decodeURIComponent(mBotAvatar[1]);
      const chunks: Buffer[] = [];
      let received = 0;
      for await (const c of req) {
        received += (c as Buffer).length;
        // base64 of a 512×512 PNG stays well under this; cap before buffering more.
        if (received > 4_000_000) {
          res.writeHead(413, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'image_too_large' }));
          return;
        }
        chunks.push(c as Buffer);
      }
      const raw = Buffer.concat(chunks).toString('utf8') || '{}';
      const upstream = await proxyToDaemon(appId, `/api/bot-avatar`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: raw,
      });
      res.writeHead(upstream.status, { 'content-type': 'application/json' });
      res.end(await upstream.text());
      return;
    }

    // PUT /api/bots/:appId/max-live-workers — proxy to that bot's daemon. Body
    // `{ maxLiveWorkers: number | null }` (null = clear → fall back to the
    // built-in default of 30; a positive integer overrides it).
    let mBotMaxLive: RegExpMatchArray | null;
    if (req.method === 'PUT' && (mBotMaxLive = url.pathname.match(/^\/api\/bots\/([^/]+)\/max-live-workers$/))) {
      const appId = decodeURIComponent(mBotMaxLive[1]);
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const raw = Buffer.concat(chunks).toString('utf8') || '{}';
      const upstream = await proxyToDaemon(appId, `/api/bot-max-live-workers`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: raw,
      });
      res.writeHead(upstream.status, { 'content-type': 'application/json' });
      res.end(await upstream.text());
      return;
    }

    // Native Feishu/Lark conversation labels (feed groups). These APIs are
    // user-token-only, so the frontend pins subsequent create/assign calls to
    // the same app whose OAuth token produced this list.
    if (req.method === 'GET' && url.pathname === '/api/feed-groups/auth-url') {
      const appId = url.searchParams.get('larkAppId') ?? '';
      let bot: BotConfig | undefined;
      try { bot = loadBotConfigs().find(item => !item.apiOnly && (!appId || item.larkAppId === appId)); }
      catch { /* handled below */ }
      if (!bot) return jsonRes(res, 404, { ok: false, error: 'bot_not_found' });
      const { authUrl } = generateAuthUrl(bot.larkAppId, bot.larkAppSecret, normalizeBrand(bot.brand), [...FEED_GROUP_SCOPES]);
      return jsonRes(res, 200, { ok: true, larkAppId: bot.larkAppId, authUrl });
    }

    if (req.method === 'POST' && url.pathname === '/api/feed-groups/oauth-callback') {
      let body: { callbackUrl?: unknown };
      try { body = await readJsonBody(req) as { callbackUrl?: unknown }; }
      catch { return jsonRes(res, 400, { ok: false, error: 'bad_json' }); }
      const callbackUrl = typeof body.callbackUrl === 'string' ? body.callbackUrl.trim() : '';
      if (!isCallbackUrl(callbackUrl)) {
        return jsonRes(res, 400, { ok: false, error: 'invalid_callback_url', message: '请粘贴完整的 127.0.0.1 OAuth 回调 URL。' });
      }
      const message = await handleCallbackUrl(callbackUrl);
      const ok = typeof message === 'string' && message.startsWith('✅');
      return jsonRes(res, ok ? 200 : 400, { ok, error: ok ? undefined : 'oauth_exchange_failed', message });
    }

    if (req.method === 'GET' && url.pathname === '/api/feed-groups') {
      const requestedAppId = url.searchParams.get('larkAppId') ?? '';
      let bots: BotConfig[];
      try { bots = loadBotConfigs().filter(bot => !bot.apiOnly); }
      catch { return jsonRes(res, 500, { ok: false, error: 'bot_config_unavailable' }); }
      const ordered = requestedAppId
        ? [...bots.filter(bot => bot.larkAppId === requestedAppId), ...bots.filter(bot => bot.larkAppId !== requestedAppId)]
        : bots;
      let loginRequired = false;
      for (const bot of ordered) {
        try {
          const groups = await listFeedGroups(bot);
          return jsonRes(res, 200, { ok: true, larkAppId: bot.larkAppId, groups });
        } catch (error) {
          if (error instanceof FeedGroupApiError && error.code === 'user_login_required') {
            loginRequired = true;
            continue;
          }
          if (requestedAppId && bot.larkAppId === requestedAppId) {
            const e = error as FeedGroupApiError;
            return jsonRes(res, e.status ?? 502, { ok: false, error: e.code ?? 'feed_group_list_failed', message: e.message });
          }
        }
      }
      return jsonRes(res, loginRequired ? 401 : 503, {
        ok: false,
        error: loginRequired ? 'user_login_required' : 'feed_group_api_unavailable',
        message: loginRequired ? '尚未获得飞书标签权限，请点击「立即授权」按钮进行授权。' : '没有可用于读取标签的飞书机器人。',
      });
    }

    // PUT /api/bots/:appId/session-owner-reminder — per-Bot periodic owner
    // reminder policy. The owning daemon validates, persists, and hot-applies.
    let mBotOwnerReminder: RegExpMatchArray | null;
    if (req.method === 'PUT' && (mBotOwnerReminder = url.pathname.match(/^\/api\/bots\/([^/]+)\/session-owner-reminder$/))) {
      const appId = decodeURIComponent(mBotOwnerReminder[1]);
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const raw = Buffer.concat(chunks).toString('utf8') || '{}';
      const upstream = await proxyToDaemon(appId, `/api/bot-session-owner-reminder`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: raw,
      });
      res.writeHead(upstream.status, { 'content-type': 'application/json' });
      res.end(await upstream.text());
      return;
    }

    // Create a new chat — pick a creator from the user-selected larkAppIds
    // (Feishu makes the calling bot the implicit first member, so picking
    // anything else would silently add an unwanted bot). Auto-invite the
    // operator using the creator bot's pre-resolved allowedUsers — open_ids
    // are app-scoped, so creator daemon and operator open_id come from the
    // SAME bot by construction. See dashboard/operator-selector.ts.
    if (req.method === 'POST' && url.pathname === '/api/groups/create') {
      let parsed: { name?: unknown; larkAppIds?: unknown; userOpenIds?: unknown; ownerUnionIds?: unknown; bindWorkingDir?: unknown; roleProfileId?: unknown; feedGroupId?: unknown; newFeedGroupName?: unknown; feedGroupAppId?: unknown };
      try {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        const raw = Buffer.concat(chunks).toString('utf8') || '{}';
        parsed = JSON.parse(raw);
      } catch {
        return jsonRes(res, 400, { ok: false, error: 'bad_json' });
      }
      const selectedIds = Array.isArray(parsed.larkAppIds)
        ? (parsed.larkAppIds as unknown[]).filter((x): x is string => typeof x === 'string')
        : [];
      if (selectedIds.length === 0) {
        return jsonRes(res, 400, { ok: false, error: 'larkAppIds_required' });
      }
      const roleProfileId = typeof parsed.roleProfileId === 'string' && parsed.roleProfileId.trim()
        ? parsed.roleProfileId.trim()
        : null;
      if (roleProfileId && !isValidRoleProfileId(roleProfileId)) {
        return jsonRes(res, 400, { ok: false, error: 'invalid_role_profile_id' });
      }

      const explicit = Array.isArray(parsed.userOpenIds)
        ? (parsed.userOpenIds as unknown[]).filter((x): x is string => typeof x === 'string')
        : [];

      const pick = pickCreatorForGroup(selectedIds, (id) => {
        const d = registry.getByAppId(id);
        return d ? { larkAppId: d.larkAppId, resolvedAllowedUsers: d.resolvedAllowedUsers ?? [] } : undefined;
      });
      if (!pick) {
        return jsonRes(res, 503, { ok: false, error: 'no_online_daemon' });
      }
      const creator = registry.getByAppId(pick.creatorLarkAppId)!;
      const merged = new Set<string>([...explicit, ...pick.userOpenIds]);
      // 跨 app 邀请通道：按 union_id 加人（open_id 是 app 作用域的，union_id 稳定，
      // 由 creator daemon 解析成本 app 的 open_id 再加）。平台「拉群」即走这条。
      const ownerUnionIds = Array.isArray(parsed.ownerUnionIds)
        ? (parsed.ownerUnionIds as unknown[]).filter((x): x is string => typeof x === 'string')
        : [];
      // Auto-invite/transfer/notify target: prefer the explicit open_id passed
      // by the caller (rare API consumer use), else the creator bot's first
      // resolved allowlist entry.
      const autoInvited: string | null = explicit[0] ?? pick.userOpenIds[0] ?? null;

      const forwardBody = {
        name: typeof parsed.name === 'string' ? parsed.name : undefined,
        larkAppIds: selectedIds,
        userOpenIds: [...merged],
        ownerUnionIds,
        // Auto-transfer ownership to the auto-invited operator. Scope-safe
        // because the open_id was sourced from the creator bot's own allowlist.
        transferOwnerTo: autoInvited ?? undefined,
        // Send an @-mention message into the new chat so the operator gets a
        // Feishu push notification — being a chat member alone doesn't always
        // surface the chat in their sidebar (esp. mobile).
        notifyOwnerOpenId: autoInvited ?? undefined,
        bindWorkingDir: typeof parsed.bindWorkingDir === 'string' && parsed.bindWorkingDir.trim()
          ? parsed.bindWorkingDir.trim()
          : undefined,
        roleProfileId: roleProfileId ?? undefined,
      };
      const upstream = await fetchDaemonIpc(
        creator.ipcPort,
        '/api/groups/create',
        { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(forwardBody) },
      );
      const upstreamText = await upstream.text();
      let upstreamJson: any = null;
      try { upstreamJson = JSON.parse(upstreamText); } catch { /* leave null */ }
      if (upstreamJson && typeof upstreamJson === 'object') {
        if (roleProfileId) upstreamJson.roleProfileId = roleProfileId;
        // If Lark rejected the invite (open_id wrong scope, banned user, etc.)
        // null out autoInvitedOpenId so the frontend doesn't falsely claim
        // success — the user actually isn't a member of the new chat.
        const invalidUsers: string[] = Array.isArray(upstreamJson.invalidUserIds)
          ? upstreamJson.invalidUserIds
          : [];
        if (autoInvited && invalidUsers.includes(autoInvited)) {
          upstreamJson.autoInvitedOpenId = null;
          upstreamJson.autoInviteRejected = true;
          // ownerTransferredTo is already null from daemon (it skips transfer
          // when invitee_rejected), so nothing more to do here.
        } else {
          upstreamJson.autoInvitedOpenId = autoInvited;
        }
        const existingFeedGroupId = typeof parsed.feedGroupId === 'string' ? parsed.feedGroupId.trim() : '';
        const newFeedGroupName = typeof parsed.newFeedGroupName === 'string' ? parsed.newFeedGroupName.trim() : '';
        const feedGroupAppId = typeof parsed.feedGroupAppId === 'string' ? parsed.feedGroupAppId.trim() : '';
        if (upstream.ok && upstreamJson.ok && typeof upstreamJson.chatId === 'string' && (existingFeedGroupId || newFeedGroupName)) {
          try {
            const feedBot = loadBotConfigs().find(bot => bot.larkAppId === feedGroupAppId && !bot.apiOnly);
            if (!feedBot) {
              upstreamJson.feedGroupError = '读取标签所用的机器人当前不可用。群聊已创建，但未加入标签。';
            } else {
              const targetId = existingFeedGroupId || await createFeedGroup(feedBot, newFeedGroupName);
              await addChatToFeedGroup(feedBot, targetId, upstreamJson.chatId);
              upstreamJson.feedGroupId = targetId;
              upstreamJson.feedGroupName = newFeedGroupName || undefined;
            }
          } catch (error) {
            upstreamJson.feedGroupError = error instanceof Error ? error.message : String(error);
          }
        }
      }
      if (upstream.ok && upstreamJson?.ok) groupsMatrixSnapshot.invalidate();
      res.writeHead(upstream.status, { 'content-type': 'application/json' });
      res.end(upstreamJson ? JSON.stringify(upstreamJson) : upstreamText);
      return;
    }

    // Dashboard「创建会话」：建飞书群 + 拉选中的 bot，然后按协作模式给各 bot 拉起/暂存
    // 一条 chat-scope 会话。一起开工=每个被选 bot 各起一条；lead 分配=只起 lead，由它
    // 在群里 @ 拉起 sub bot。in_progress=立即开跑；backlog=入待办池（parked，等激活）。
    if (req.method === 'POST' && url.pathname === '/api/sessions/create') {
      let parsed: {
        content?: unknown; larkAppIds?: unknown; mode?: unknown; column?: unknown;
        leadLarkAppId?: unknown; name?: unknown; bindWorkingDir?: unknown; images?: unknown;
        feedGroupId?: unknown; newFeedGroupName?: unknown; feedGroupAppId?: unknown;
      };
      try {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      } catch {
        return jsonRes(res, 400, { ok: false, error: 'bad_json' });
      }
      const content = typeof parsed.content === 'string' ? parsed.content.replace(/\s+$/u, '') : '';
      if (!content.trim()) return jsonRes(res, 400, { ok: false, error: 'empty_content' });
      const selectedIds = Array.isArray(parsed.larkAppIds)
        ? Array.from(new Set((parsed.larkAppIds as unknown[]).filter((x): x is string => typeof x === 'string')))
        : [];
      if (selectedIds.length === 0) return jsonRes(res, 400, { ok: false, error: 'larkAppIds_required' });
      const mode = parsed.mode === 'lead' ? 'lead' : parsed.mode === 'all' ? 'all' : null;
      if (!mode) return jsonRes(res, 400, { ok: false, error: 'bad_mode' });
      const column = parsed.column === 'backlog' ? 'backlog' : parsed.column === 'in_progress' ? 'in_progress' : null;
      if (!column) return jsonRes(res, 400, { ok: false, error: 'bad_column' });
      const bindWorkingDir = typeof parsed.bindWorkingDir === 'string' && parsed.bindWorkingDir.trim()
        ? parsed.bindWorkingDir.trim() : undefined;
      const name = deriveCreateGroupName(parsed.name, content);
      const parsedImages = parseDashboardImageUploads(parsed.images);
      if (!parsedImages.ok) return jsonRes(res, 400, { ok: false, error: parsedImages.error });

      // 解析 creator：lead 模式 = lead bot；一起开工 = pickCreatorForGroup 在选中里挑一个在线的。
      let creatorLarkAppId: string;
      if (mode === 'lead') {
        const leadLarkAppId = typeof parsed.leadLarkAppId === 'string' ? parsed.leadLarkAppId : '';
        if (!leadLarkAppId || !selectedIds.includes(leadLarkAppId)) {
          return jsonRes(res, 400, { ok: false, error: 'bad_lead' });
        }
        if (!registry.getByAppId(leadLarkAppId)) return jsonRes(res, 503, { ok: false, error: 'lead_offline' });
        creatorLarkAppId = leadLarkAppId;
      } else {
        const pick = pickCreatorForGroup(selectedIds, (id) => {
          const d = registry.getByAppId(id);
          return d ? { larkAppId: d.larkAppId, resolvedAllowedUsers: d.resolvedAllowedUsers ?? [] } : undefined;
        });
        if (!pick) return jsonRes(res, 503, { ok: false, error: 'no_online_daemon' });
        creatorLarkAppId = pick.creatorLarkAppId;
      }

      // creator 作用域里的操作者 open_id（首个 ou_ allowedUser）——用于邀请进群 + 转群主 + @通知。
      // 同时取 on_（union_id，租户内跨 app 稳定）做兜底邀请：lead 模式强制 creator=lead，
      // 万一 lead 的 allowlist 没有 ou_ 条目，open_id 解析不到、操作者就进不了群——union_id
      // 不受 app 作用域影响，仍能把人拉进来（createGroupWithBots 走 ownerUnionIds 通道）。
      const creatorDesc = registry.getByAppId(creatorLarkAppId)!;
      const allowed = creatorDesc.resolvedAllowedUsers ?? [];
      const userOpenId = allowed.find(u => u.startsWith('ou_'));
      const ownerUnionIds = allowed.filter(u => u.startsWith('on_'));

      // 建群（拉所有选中 bot + 邀请操作者 + 转群主 + @通知 + 可选绑 oncall 工作目录）。
      let groupResp: any = null;
      try {
        const groupUpstream = await proxyToDaemon(creatorLarkAppId, '/api/groups/create', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            name,
            larkAppIds: selectedIds,
            userOpenIds: userOpenId ? [userOpenId] : [],
            ownerUnionIds,
            transferOwnerTo: userOpenId,
            notifyOwnerOpenId: userOpenId,
            bindWorkingDir,
          }),
        });
        groupResp = await groupUpstream.json().catch(() => null);
        if (!groupUpstream.ok || !groupResp?.ok || typeof groupResp.chatId !== 'string') {
          return jsonRes(res, 502, { ok: false, error: groupResp?.error ?? `group_create_http_${groupUpstream.status}` });
        }
        groupsMatrixSnapshot.invalidate();
      } catch {
        return jsonRes(res, 502, { ok: false, error: 'group_create_proxy_failed' });
      }
      const chatId: string = groupResp.chatId;
      const invalidBotIds: string[] = Array.isArray(groupResp.invalidBotIds) ? groupResp.invalidBotIds : [];
      const existingFeedGroupId = typeof parsed.feedGroupId === 'string' ? parsed.feedGroupId.trim() : '';
      const newFeedGroupName = typeof parsed.newFeedGroupName === 'string' ? parsed.newFeedGroupName.trim() : '';
      let feedGroupId = '';
      let feedGroupError = '';
      if (existingFeedGroupId || newFeedGroupName) {
        const feedGroupAppId = typeof parsed.feedGroupAppId === 'string' ? parsed.feedGroupAppId.trim() : '';
        try {
          const feedBot = loadBotConfigs().find(bot => bot.larkAppId === feedGroupAppId && !bot.apiOnly);
          if (!feedBot) {
            feedGroupError = '读取标签所用的机器人当前不可用。';
          } else {
            feedGroupId = existingFeedGroupId || await createFeedGroup(feedBot, newFeedGroupName);
            await addChatToFeedGroup(feedBot, feedGroupId, chatId);
          }
        } catch (error) {
          feedGroupError = error instanceof Error ? error.message : String(error);
        }
      }

      // spawn 目标：lead 模式只有 lead；一起开工是所有成功入群的选中 bot。
      const joinedIds = selectedIds.filter(id => !invalidBotIds.includes(id) && !!registry.getByAppId(id));
      const targets = selectCreateSessionTargets(mode, joinedIds, creatorLarkAppId);
      if (targets.length === 0) {
        return jsonRes(res, 200, { ok: true, chatId, shareLink: groupResp.shareLink, spawned: [], failed: [], warning: 'no_spawn_target', feedGroupId, feedGroupError });
      }

      const bots = liveBots();
      const nameOf = (id: string) => bots.find(b => b.larkAppId === id)?.botName ?? id;
      const spawned: string[] = [];
      const failed: Array<{ larkAppId: string; error: string }> = [];
      await Promise.all(targets.map(async (appId) => {
        const role = mode === 'lead' ? 'lead' : (targets.length > 1 ? 'collab' : 'solo');
        // lead 的 coworker = 所有 sub（除自己）；collab 的 coworker = 其它并列 bot（除自己）。
        const coworkerIds = (mode === 'lead' ? joinedIds : targets).filter(id => id !== appId);
        const coworkers = coworkerIds.map(id => ({ name: nameOf(id) }));
        try {
          const up = await proxyToDaemon(appId, '/api/sessions/spawn', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              chatId, content, column, role, coworkers,
              images: parsedImages.images,
              postBanner: appId === creatorLarkAppId,
            }),
          });
          const b = await up.json().catch(() => null);
          if (up.ok && b?.ok) spawned.push(appId);
          else failed.push({ larkAppId: appId, error: b?.error ?? `http_${up.status}` });
        } catch (e: any) {
          failed.push({ larkAppId: appId, error: e?.message ?? String(e) });
        }
      }));

      return jsonRes(res, 200, {
        ok: true, chatId, shareLink: groupResp.shareLink, mode, column, spawned, failed, feedGroupId, feedGroupError,
      });
    }

    // Public SSE — relays aggregator's listener events
    if (req.method === 'GET' && url.pathname === '/events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache, no-transform',
        'connection': 'keep-alive',
      });
      res.write('retry: 5000\n\n');
      // P1-8：这条流的寿命必须等于建立它的那次认证的寿命。建流时登记进
      // authSession→长连接索引（logout/rotate/解绑时被主动 destroy），并在每帧
      // 推送前复核身份仍有效——否则 rotate 之后新签的 `riffAccessUrl`（Riff 沙箱
      // 写凭据）会顺着这条老连接送给上一任持有者。匿名 public-read 连接没有认证
      // 会话，行为不变。
      // P1-14 姊妹项：这条流的能力口径必须与 REST 同源。Workbench-only 身份对
      // `GET /api/schedules` 是明确的 401，`/events` 就不能把同一份排程（含
      // prompt / workingDir / fired 的 error 原文）换个管子送出去——过滤在
      // createDashboardEventsStream 内部按 audience 执行，见 events-sse.ts。
      const eventsAudience: DashboardEventAudience = authed
        ? 'management'
        : workbenchOnlyIdentity ? 'workbench' : 'anonymous';
      const stream = createDashboardEventsStream({
        res,
        authSessionId: requestIdentity?.authSessionId ?? null,
        audience: eventsAudience,
        isAuthSessionLive: terminalAuthSessionLive,
        bind: (authSessionId, close) => authSessionConnections.register(authSessionId, close),
      });
      const off = aggregator.on(ev => {
        // Session rows follow the same three-way audience as GET /api/sessions,
        // or a Workbench viewer would receive the preview descriptor on the
        // initial REST fetch and then lose it on the first live patch.
        const projectedBody = projectSessionPreviewEventForBrowser(ev.type, ev.body) as typeof ev.body;
        let body = projectSessionEventForAudience(
          ev.type,
          projectedBody,
          sessionBoardAudience,
        ) as typeof ev.body;
        // Schedules stay on the MANAGEMENT gate, mirroring the GET
        // /api/schedules carve-out: schedule events carry the full task object
        // (prompt = business instructions, workingDir = repo/customer path) and
        // `/api/schedules` is not a Workbench capability, so widening this to
        // `sessionBoardAudience` would let an H5 identity read over `/events`
        // what the REST route refuses it.
        // Workbench-only identities never reach this redaction at all — the
        // stream drops every `schedule.*` frame for them (P1-14 sibling); this
        // branch is the ANONYMOUS publicReadOnly path, which the REST route
        // does serve, redacted the same way.
        if (!authed && (ev.type === 'schedule.created' || ev.type === 'schedule.updated')) {
          const b = body as { schedule?: Record<string, unknown>; patch?: Record<string, unknown>; id?: string };
          body = {
            ...b,
            ...(b.schedule ? { schedule: { ...b.schedule, prompt: undefined, workingDir: undefined } } : {}),
            ...(b.patch ? { patch: { ...b.patch, prompt: undefined, workingDir: undefined } } : {}),
          } as typeof ev.body;
        }
        stream.write(ev.type, { larkAppId: ev.larkAppId, body });
      });
      const hb = setInterval(() => {
        stream.write('heartbeat', { ts: Date.now() });
      }, 15_000);
      // Push a bots.changed frame whenever the online bot roster actually
      // changes (bot added / removed / renamed / re-indexed) so the Bot 配置
      // page can auto-refresh without a manual reload. registry.on fires on
      // every 15s poll and 30s heartbeat rewrite, so gate on a roster signature
      // that ignores lastHeartbeat — otherwise we'd spam a frame every poll.
      let lastRoster = botsRosterSignature(registry.list());
      const offRoster = registry.on(online => {
        const sig = botsRosterSignature(online);
        if (sig === lastRoster) return;
        lastRoster = sig;
        stream.write('bots.changed', { body: { signature: sig } });
      });
      res.on('close', () => { off(); offRoster(); clearInterval(hb); stream.dispose(); });
      return;
    }

    // Public API + static frontend land in Task 17 / 18. For now: 404.
    jsonRes(res, 404, { error: 'not_found_yet', path: url.pathname });
  } catch (err) {
    logger.error('[dashboard] handler error', err);
    if (!res.headersSent) jsonRes(res, 500, { error: String(err) });
  }
});

// OAuth loopback callback for browsers running on the same machine as BotMux.
// Remote-browser deployments cannot reach this loopback listener; their
// Dashboard keeps the manual callback-URL paste flow as a fallback.
const oauthCallbackServer = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1:9768');
  if (req.method !== 'GET' || url.pathname !== '/callback') {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    return res.end('Not found');
  }
  let ok = false;
  try {
    const message = await handleCallbackUrl(url.toString());
    ok = typeof message === 'string' && message.startsWith('✅');
  } catch (error) {
    logger.warn(`[dashboard] OAuth loopback callback failed: ${(error as Error).message}`);
  }
  res.writeHead(ok ? 200 : 400, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
  });
  return res.end(`<!doctype html><meta charset="utf-8"><title>${ok ? '授权成功' : '授权失败'}</title><style>body{font-family:system-ui,sans-serif;max-width:560px;margin:80px auto;padding:24px;color:#111827}h1{font-size:28px}</style><h1>${ok ? '授权成功' : '授权失败'}</h1><p>${ok ? 'BotMux 已完成授权。你可以关闭此页面并返回 Dashboard。' : '授权链接无效或已过期。请返回 Dashboard 后重新发起授权。'}</p>`);
});

oauthCallbackServer.on('error', error => {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === 'EADDRINUSE') {
    logger.warn('[dashboard] OAuth loopback port 127.0.0.1:9768 is already in use; remote/manual callback fallback remains available');
  } else {
    logger.warn(`[dashboard] OAuth loopback server error: ${(error as Error).message}`);
  }
});
oauthCallbackServer.listen(9768, '127.0.0.1', () => {
  logger.info('[dashboard] OAuth loopback callback listening on 127.0.0.1:9768');
});

// Web terminal WebSocket reverse-proxy: bridge `/s/*` upgrade requests through to
// the local terminal proxy (which in turn bridges to the session worker). Raw
// socket-to-socket bridge: dial 127.0.0.1:<terminalProxyPort>, replay the upgrade
// request line + headers verbatim, then pipe both directions. Mirrors how
// terminal-proxy.ts bridges to the worker. Non-`/s/*` upgrades are dropped (the
// dashboard SPA uses SSE, not WebSocket).
server.on('upgrade', (req: IncomingMessage, clientSocket: Duplex, head: Buffer) => {
  try {
    const rawUrl = req.url ?? '/';
    // Preview 的 WS 必须第一个判：沙箱化之后它来自不透明来源（`Origin: null`），
    // 凭据是路径里的 content capability，绝不能被下面的管理类 Origin 校验误杀。
    if (sessionPreviewProxy.handleUpgrade(req, clientSocket, head)) return;
    // P1-11：管理类 WS（终端 / 调试终端）升级不经 HTTP 门禁，浏览器对 WS 握手
    // 一定带 Origin，所以「带了但对不上（含 null）」一律拒——同站兄弟子域和
    // localhost 其它端口正是 SameSite=Lax 挡不住的那一类。
    //
    // 判之前**先按 path 分流**可信来源档位：会话终端 `/s/*` 认平台 `m-`+`t-`（分享
    // 出去的终端页就住在 `t-`），而 `/debug-terminal/*` 的另一头是宿主裸 bash，只认
    // management 档。合在一起判的话，`t-` 就连带成了裸 bash 那条 WS 的可信 Origin。
    const upgradeRoute = classifyManagementUpgrade(rawUrl);
    const upgradeOrigin = managementUpgradeOrigin(req.headers, upgradeRoute.surface);
    if (!upgradeOrigin.ok) {
      const body = JSON.stringify({ ok: false, error: upgradeOrigin.error });
      clientSocket.end([
        'HTTP/1.1 403 Forbidden',
        'content-type: application/json; charset=utf-8',
        'cache-control: no-store',
        'connection: close',
        `content-length: ${Buffer.byteLength(body)}`,
        '',
        body,
      ].join('\r\n'));
      return;
    }
    // 调试终端 WS（owner-only）：manager 内部再自校验管理 cookie + legacy 管理身份。
    if (upgradeRoute.route === 'debug-terminal') {
      if (debugTerminalManager.handleUpgrade(req, clientSocket, head)) return;
    }
    if (terminalFrontProxy.handleUpgrade(req, clientSocket, head)) return;
    clientSocket.destroy();
  } catch {
    try { clientSocket.destroy(); } catch { /* ignore */ }
  }
});

// 拉长 keep-alive 空闲超时：中心化平台反代用 keep-alive 连接池复用隧道连接，但 Node 默认
// keepAliveTimeout 才 5s——空闲>5s 后 dashboard 把连接关了，而平台侧 Agent 可能还把它留在池里
// 复用 → 撞到刚关的连接、首批请求 502。把它拉到 75s（headersTimeout 需更大），让池里的连接在
// 正常使用间隔内不被这端提前关掉，平台复用稳、不再有 stale-reuse 的首批 502。本地直连无副作用。
server.keepAliveTimeout = 75_000;
server.headersTimeout = 80_000;

// Probe upward on EADDRINUSE rather than crashing with an unhandled 'error':
// a second botmux instance on this host (or a stray process) holding the
// configured port would otherwise tear the dashboard process down on bind.
// The bound port is persisted so `botmux dashboard` can still reach us.
listenWithProbe({
  server,
  port: config.dashboard.port,
  host: config.dashboard.host,
  portAvailable: dashboardPortAvailable,
  verifyBound: verifyDashboardBinding,
  log: (m) => logger.warn(`[dashboard] ${m}`),
}).then((port) => {
  boundDashboardPort = port;
  try { atomicWriteFileSync(PORT_PATH, String(port)); } catch (e) {
    logger.warn(`[dashboard] Failed to persist port to ${PORT_PATH}: ${(e as Error).message}`);
  }
  logger.info(`[dashboard] listening on ${config.dashboard.host}:${port}`);
  // Reclaim any `.trash-*` skill trees left by an interrupted background unlink
  // (crash/restart mid-delete). Best-effort and fire-and-forget.
  sweepStoreTrash();
  startPlatformTunnelIfBound();
}).catch((err) => {
  logger.error(`[dashboard] could not bind near ${config.dashboard.host}:${config.dashboard.port} after probing — set BOTMUX_DASHBOARD_PORT to a free port. ${(err as Error).message}`);
  process.exit(1);
});

// Federation: periodically push this deployment's bots + heartbeat to every hub
// it has joined (best-effort; no-op when not federated). Keeps remote rosters fresh.
const federationSync = setInterval(() => {
  // sessionsProvider：顺带把本部署在各团队协作群里的会话裁剪行上报给团队 host
  // （hub 在 sync 响应里下发协作群清单，详见 syncAllMemberships）。
  // aggregator Row 是宽松索引类型，实际为 SessionRow（含 chatId 等字段）
  syncAllMemberships(config.session.dataDir, fetch, liveBots(), () => aggregator.getSessions() as unknown as TeamSessionRowLike[])
    .catch(() => { /* best-effort */ });
}, 2 * 60 * 1000);
federationSync.unref();

// 单候选自动绑定：standalone（未入团队）部署不必手动点面板「绑定」——用各机器人自己的
// 凭证从 allowedUsers 解析出唯一负责人就自动认领，左上角飞书头像 / 拉群把发起人拉进群 /
// 机器人归属随即生效。多候选（部署里配了多个人）仍保留手动选择。幂等：绑定后即刻 no-op。
// 启动时按 0/5/15/60s 退避重试几次以覆盖 boot 时网络/凭证尚未就绪，之后交给手动按钮，
// 不挂进永久心跳（避免对真·多候选/无 allowedUsers 的部署每 2 分钟空打飞书）。
async function tryAutoBindOwner(): Promise<'done' | 'retry'> {
  try {
    const r = await autoBindOwnerIfUnambiguous(config.session.dataDir, { fetcher: fetch, live: liveBots() });
    if (r.status === 'bound') { logger.info(`[identity] 已自动绑定本部署负责人：${r.owner?.name || r.owner?.unionId}（头像/拉群/归属即时生效）`); return 'done'; }
    if (r.status === 'already_bound') return 'done';
    if (r.status === 'need_choice') { logger.info(`[identity] 检测到 ${r.candidates?.length ?? 0} 个候选负责人，请到面板「团队」手动选择绑定`); return 'done'; }
    return 'retry'; // no_candidates：可能是网络/凭证未就绪的瞬时失败，退避后重试
  } catch (e) {
    logger.debug(`[identity] 自动绑定尝试失败（将退避重试）：${(e as Error).message}`);
    return 'retry';
  }
}
void (async () => {
  for (const delayMs of [0, 5_000, 15_000, 60_000]) {
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    if ((await tryAutoBindOwner()) === 'done') return;
  }
})();

// 中心化平台隧道（已绑定才启动；每台机器一个，跑在 dashboard 进程里）
let platformTunnel: { stop(): void } | null = null;
function readBotmuxVersion(): string {
  // 与本地 dashboard「版本与更新」卡同源：源码 checkout 的 package.json 是占位的 0.0.0，
  // resolveCurrentVersion() 会用 git describe 推出真实版本（如 2.91.1），npm 安装则用 package.json。
  try {
    return resolveCurrentVersion();
  } catch {
    return 'unknown';
  }
}
/** 读本机 bots-info.json，转成上报给平台的 bot 概要（人→机器→bot + 拉群用）。 */
function readPlatformBotsInfo(version: string = readBotmuxVersion()): PlatformBotInfo[] {
  try {
    const fp = join(config.session.dataDir, 'bots-info.json');
    if (!existsSync(fp)) return [];
    const entries = JSON.parse(readFileSync(fp, 'utf8')) as Array<{
      larkAppId?: string;
      botOpenId?: string | null;
      botName?: string | null;
      botAvatarUrl?: string | null;
      cliId?: string;
    }>;
    if (!Array.isArray(entries)) return [];
    // Merge per-bot team-visibility config (showInTeam) from bots.json by
    // larkAppId so the platform team page can hide bots. Default: showInTeam =
    // true (shown). bots.json may be unreadable from the dashboard process →
    // fall back to the default. apiOnly is read from the same config to derive
    // `mentionable` (a core-only bot has no Feishu transport → can't be @-ed).
    const cfgByAppId = new Map<string, { showInTeam?: boolean; apiOnly?: boolean }>();
    try {
      for (const cfg of loadBotConfigs()) {
        cfgByAppId.set(cfg.larkAppId, { showInTeam: cfg.showInTeam, apiOnly: cfg.apiOnly });
      }
    } catch {
      /* defaults below */
    }
    return entries
      .map((e) => {
        const cfg = cfgByAppId.get(e.larkAppId || '');
        return {
          appId: e.larkAppId || '',
          openId: e.botOpenId ?? null,
          name: e.botName || e.larkAppId || 'bot',
          avatar: e.botAvatarUrl || undefined,
          cli: e.cliId,
          showInTeam: cfg?.showInTeam !== false, // default true
          // 自家消息回声学到的租户稳定 union_id（可能尚未学到 → undefined）。
          // 平台聚合团队 roster 用，见 bot-union-ids-store / platform-team-store。
          unionId: e.larkAppId ? getBotUnionId(config.session.dataDir, e.larkAppId) : undefined,
          // 团队维度 Agent 互查（additive，交接契约 §端点2 / register|heartbeat）：
          //  · specialties：owner 预配的专长标签（bot-profiles），发现/拉群匹配依据，仅展示不可信。
          //  · mentionable：是否有飞书传输身份能被 @（core-only/apiOnly → false）。cfg 读不到
          //    时保守按可传输(true)，与 team-bot-directory「undefined 按可传输」同源
          //    （fail-open 仅在本机自报、无跨部署放大风险；真正的 no-transport 由 apiOnly 明示）。
          specialties: e.larkAppId ? getBotSpecialties(config.session.dataDir, e.larkAppId) : [],
          mentionable: cfg?.apiOnly !== true,
          botmuxVersion: version,
          a2aCapabilities: [...CURRENT_A2A_CAPABILITIES],
        };
      })
      .filter((b) => b.appId);
  } catch {
    return [];
  }
}

function startPlatformTunnelIfBound(): void {
  try {
    const binding = readPlatformBinding();
    if (!binding) return;
    const existingToken = currentDashboardToken();
    // An already-materialized dashboard token is sufficient to start the
    // tunnel. Avoid re-validating its path via secureHostFilePath(): on Linux
    // the request-time read is descriptor-pinned, while deployments whose HOME
    // is a root-owned symlink (common on managed dev hosts) can make the
    // path-returning helper fail even though the 0600 file is safely readable.
    // Only the first token creation needs the path+lock helper.
    if (!existingToken) {
      loadOrCreatePersistedToken(TOKEN_PATH);
      logger.info('[platform-tunnel] 已初始化 dashboard token');
    }
    const version = readBotmuxVersion();
    platformTunnel = startPlatformTunnelClient({
      binding,
      getDashboardPort: () => boundDashboardPort,
      getDashboardToken: currentDashboardToken,
      getVersion: () => version,
      getA2ACapabilities: () => CURRENT_A2A_CAPABILITIES,
      getBots: () => readPlatformBotsInfo(version),
      getTeamSyncRev: () => getPlatformTeamSyncRev(config.session.dataDir),
      onTeamSync: handlePlatformTeamSync,
      log: (msg, extra) => logger.info(`[platform-tunnel] ${msg}${extra ? ' ' + JSON.stringify(extra) : ''}`),
    });
    logger.info(`[platform-tunnel] 绑定到 ${binding.platformUrl}，启动隧道`);
    // 大厅打卡自愈重试：team-sync 应用时会立即尝试一次；这里的低频周期兜住
    // "当时 daemon 离线 / bot 还没进大厅 / 发送失败"的漏拍。无平台绑定不启动。
    const hallTimer = setInterval(() => { void maybeAnnounceHallPresence(); }, 5 * 60 * 1000);
    hallTimer.unref();
  } catch (e) {
    logger.warn(`[platform-tunnel] 启动失败: ${(e as Error).message}`);
  }
}

/** 平台 team-sync 落盘（roster + 团队群镜像），随后触发一轮大厅打卡检查。 */
function handlePlatformTeamSync(payload: PlatformTeamSyncMessage): void {
  const applied = applyPlatformTeamSync(config.session.dataDir, payload);
  if (!applied) {
    logger.warn('[platform-tunnel] team-sync 负载无效，忽略');
    return;
  }
  logger.info(`[platform-tunnel] team-sync 已应用 rev=${applied.rev} teams=${applied.teams.length}`);
  void maybeAnnounceHallPresence();
}

// 大厅打卡节流：按「发送 bot ×大厅」记最小间隔与尝试上限——按 bot 记会让多团队
// bot 在第一个大厅烧光预算后，新加入的大厅永远轮空（实测踩过）。只有真正发出
// 消息才消耗次数；状态落盘，重启不重发（否则每次重启都往大厅刷一轮）。
const HALL_ANNOUNCE_MIN_INTERVAL_MS = 10 * 60 * 1000;
const HALL_ANNOUNCE_MAX_TRIES = 6;
const hallAnnounceStatePath = () => join(config.session.dataDir, 'hall-announce-state.json');
function readHallAnnounceState(): Record<string, { lastAt: number; tries: number }> {
  try { return JSON.parse(readFileSync(hallAnnounceStatePath(), 'utf-8')); } catch { return {}; }
}
/** 记录一次打卡尝试。consumeTry=false 只刷新 lastAt（发送失败：保住 10 分钟退避
 *  但不烧预算——否则 daemon 掉线期间就把 6 次上限烧光、恢复后永久跳过，Codex review）。 */
function bumpHallAnnounceState(key: string, consumeTry: boolean): void {
  const all = readHallAnnounceState();
  const cur = all[key];
  all[key] = { lastAt: Date.now(), tries: (cur?.tries ?? 0) + (consumeTry ? 1 : 0) };
  try { atomicWriteFileSync(hallAnnounceStatePath(), JSON.stringify(all, null, 2) + '\n'); } catch { /* 尽力而为 */ }
}
/** 发送方 daemon 的 mention cross-ref（name → 本 app 视角 open_id）。 */
function readBotCrossRef(appId: string): Record<string, string> {
  try { return JSON.parse(readFileSync(join(config.session.dataDir, `bot-openids-${appId}.json`), 'utf-8')); } catch { return {}; }
}

/**
 * 大厅打卡编排（union_id 自学）。实测大厅（bot-only 群）只有「直接点名 @」会
 * 投递事件——普通消息、自 @、@all 全部静默，自家回声在大多数应用上永远等不来。
 * 机制（与 event-dispatcher 的 hall 分支对偶）：
 * - 有未入册成员的大厅里，每个本机 bot 点名 @ 自己 cross-ref 能解析到的未入册
 *   成员（含别的机器的——mention 跨机器投递，对方跑新版即可学）；被点到的直接
 *   从 mentions[] 学到自己的 union_id。已入册 bot 也参与——纯教学。
 * - 自己未入册时消息带 #hall-echo，被点到的 bot 回 @ 一次（open_id 取事件
 *   sender_id，无需 cross-ref）→ 打卡者从回执学到自己。任一方向可解析即收敛。
 * 消息只在有意义时才发：解析不到任何目标时不发不计次（唯一例外：未入册 bot 的
 * 首次尝试发一条裸打卡，给有 receive-all scope 的应用留回声机会）。状态落盘，
 * 重启不重发——解析不到目标反复裸发刷屏这个坑踩过了（自动review 实测）。
 */
async function maybeAnnounceHallPresence(): Promise<void> {
  try {
    const dataDir = config.session.dataDir;
    const teams = listPlatformTeams(dataDir);
    if (teams.length === 0) return;
    const localBotIds = new Set(readPlatformBotsInfo().map(b => b.appId));
    const now = Date.now();
    const state = readHallAnnounceState();
    for (const team of teams) {
      const hallChatId = team.groupChatIds[0];
      if (!hallChatId) continue;
      // 未入册成员（全大厅，含别的机器）：本机的以本地 store 为准（比 roster 新鲜），
      // 远端的以 roster 的 unionId 为准。
      const isLearned = (b: { appId: string; unionId?: string }) =>
        localBotIds.has(b.appId) ? !!getBotUnionId(dataDir, b.appId) : !!b.unionId;
      const unlearned = team.bots.filter(b => !isLearned(b));
      if (unlearned.length === 0) continue;
      const unlearnedNames = new Set(unlearned.map(b => b.name).filter(Boolean) as string[]);
      for (const bot of team.bots) {
        if (!localBotIds.has(bot.appId)) continue;            // 只编排本机 bot
        const selfLearned = isLearned(bot);
        const throttleKey = `${bot.appId}::${hallChatId}`;
        const st = state[throttleKey];
        if (st && (now - st.lastAt < HALL_ANNOUNCE_MIN_INTERVAL_MS || st.tries >= HALL_ANNOUNCE_MAX_TRIES)) continue;
        // 点名目标 = 自己 cross-ref 能解析到的未入册成员（发不出 @ 的目标点了也白点）。
        const crossRef = readBotCrossRef(bot.appId);
        const targets = [...unlearnedNames].filter(n => n !== bot.name && typeof crossRef[n] === 'string').slice(0, 4);
        // 没有可教的目标：已入册 → 无事可做；未入册 → 仅首次发裸打卡碰回声运气，
        // 之后静默等别人教（不发不计次，cross-ref 或 roster 变化后自然恢复）。
        if (targets.length === 0 && (selfLearned || (st?.tries ?? 0) > 0)) continue;
        // 成功发出才消耗预算；失败只刷新 lastAt 保住退避间隔（见 bumpHallAnnounceState）。
        let sent = false;
        try {
          const r = await proxyToDaemon(bot.appId, '/api/platform/hall-announce', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ chatId: hallChatId, mentionNames: targets }),
          });
          const j = await r.json().catch(() => ({} as { ok?: boolean; error?: string; mentioned?: string[]; unresolved?: string[]; skipped?: string }));
          if (!r.ok || !(j as { ok?: boolean }).ok) {
            logger.warn(`[platform-tunnel] 大厅打卡失败 bot=${bot.appId} chat=${hallChatId.substring(0, 12)}: ${(j as { error?: string }).error ?? r.status}`);
          } else {
            sent = !(j as { skipped?: string }).skipped;
            const mentioned = (j as { mentioned?: string[] }).mentioned ?? [];
            const unresolved = (j as { unresolved?: string[] }).unresolved ?? [];
            if (sent) logger.info(`[platform-tunnel] 大厅打卡已发 bot=${bot.appId} chat=${hallChatId.substring(0, 12)}${mentioned.length ? ` 点名=[${mentioned.join(',')}]` : ''}${unresolved.length ? ` 未解析=[${unresolved.join(',')}]` : ''}`);
          }
        } catch (e) {
          logger.warn(`[platform-tunnel] 大厅打卡请求异常 bot=${bot.appId}: ${(e as Error).message}`);
        }
        bumpHallAnnounceState(throttleKey, sent);
        state[throttleKey] = { lastAt: now, tries: (st?.tries ?? 0) + (sent ? 1 : 0) };
      }
    }
  } catch (e) {
    logger.warn(`[platform-tunnel] 大厅打卡检查异常: ${(e as Error).message}`);
  }
}

// Graceful shutdown
function shutdown(suppressPm2Restart: boolean): void {
  codexNotifierAbort.abort();
  for (const off of subs.values()) off();
  subs.clear();
  registry.stop();
  resourceMonitor.stop();
  platformTunnel?.stop();
  debugTerminalManager.shutdown();
  feedbackAnalyticsService?.close();
  if (oauthCallbackServer.listening) oauthCallbackServer.close();
  server.close(() => process.exit(gracefulProcessExitCode(suppressPm2Restart)));
  // Hard-exit fallback after 5s
  setTimeout(() => process.exit(gracefulProcessExitCode(suppressPm2Restart)), 5_000).unref();
}
// Botmux's fleet orchestrator uses SIGTERM for the dashboard; PM2 uses SIGINT
// for rolling process management and must be allowed to autorestart it.
process.on('SIGTERM', () => shutdown(true));
process.on('SIGINT', () => shutdown(false));
