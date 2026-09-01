#!/usr/bin/env node
/**
 * CLI entry point for botmux.
 *
 * Usage:
 *   botmux setup          — interactive first-time configuration
 *   botmux setup --no-open-platform-auto — skip Feishu Open Platform automation
 *   botmux setup list|add|configure|edit|remove — scripted (non-TUI) bot management, see `botmux setup help`
 *   botmux clone <bot> [--name <name>] — create a new app, then copy an existing bot's configuration
 *   botmux start          — start daemon and auto plugin services
 *   botmux stop [--with-plugin] — stop daemon (optionally stop auto plugin services)
 *   botmux restart [--with-plugin] — restart daemon, then ensure auto plugin services
 *   botmux logs [--lines] [--bot <i>] [--no-follow] — view/stream per-bot daemon logs
 *   botmux status         — show daemon status
 *   botmux upgrade|update — upgrade to latest version (本地 checkout 则 git pull --ff-only + rebuild + restart)
 *   botmux device enroll|status|logout — manage the host desktop device credential
 *   botmux list           — interactive session picker (TUI), attach to managed tmux/ZMX sessions
 *   botmux list --plain   — plain table output (for piping / scripts)
 *   botmux preview <port> — register this session's loopback Web preview
 *   botmux delete <id>    — close a session by ID prefix
 *   botmux delete all     — close all active sessions
 *   botmux autostart enable|disable|status — manage boot-time autostart (launchd / user systemd / Windows Task Scheduler)
 *   botmux whiteboard status|enable|disable|current|list|read|update|write — local project whiteboard
 */
import { execSync, execFileSync, spawnSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, copyFileSync, readFileSync, writeFileSync, renameSync, readdirSync, readlinkSync, symlinkSync, appendFileSync, statSync, unlinkSync, rmSync, realpathSync, chmodSync } from 'node:fs';
import { underReadIsolation, sendCredFilePath } from './adapters/cli/read-isolation.js';
import { atomicWriteFileSync } from './utils/atomic-write.js';
import { join, dirname, basename, resolve } from 'node:path';
import { homedir, userInfo } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { createRequire } from 'node:module';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { validateWorkingDir } from './core/working-dir.js';
import { closeResidualClause, describeCloseResidual, parseCloseResidual, type ParsedCloseResidual } from './core/close-residual.js';
import {
  findAncestorSessionContext as findLiveAncestorSessionContext,
  resolveSessionContext,
} from './core/session-marker.js';
import { resolveBotmuxDataDir } from './core/data-dir.js';
import { ENTRY_SUBCOMMANDS, entryForSubcommand, resolveEntrySpawn } from './core/self-spawn.js';
import { dashboardSecretPath } from './core/dashboard-secret.js';
import { acceptedDispatchBotAppIds, activeConversationBotOpenIds, buildDispatchCompletionBrief, parseDispatchBotSpec, buildDispatchMessages, buildRepoPrimeText, buildReportContent, buildReportText, eligibleAutoMentionAliases, foldableChatSessionAppIds, offTopicSubBotTopic, resolveReportPlacement, resolveReportRecipient, resolveReportTarget, resolveSendTarget, threadRootForReachability, type DispatchBot } from './core/dispatch.js';
import {
  persistDispatchLifecycle as persistDispatchLifecycleRecord,
  type DispatchAcceptanceState,
  type DispatchLifecycleStatus,
  type DispatchReceiptState,
  type DispatchTransportState,
} from './core/dispatch-lifecycle.js';
import { withBotSteerDirective } from './core/bot-steer-directive.js';
import { pickTurnReplyTarget, collectTurnWindowParticipants } from './core/reply-target.js';
import {
  consumeAutostartUnitMarker,
  enableAutostart,
  disableAutostart,
  autostartStatus,
  refreshAutostart,
} from './autostart.js';
import { AskArgsError, parseAskOptions } from './core/ask-args.js';
import { inspectLocalRepo, normalizeRepoRemote } from './core/repo-requirement.js';
import { normalizeDispatchBotsForSender, resolveDispatchWorkerBotUnionIds, resolveDispatchWorkerMetas } from './core/dispatch-worker-meta.js';
import {
  A2A_CAPABILITY_DELIVERY_V1,
  A2A_CAPABILITY_DISPATCH_REPO_V1,
  evaluateDispatchReadiness,
  isMentionableBotOpenId,
  resolveDispatchMentionIdentities,
  type A2APeerCapability,
} from './core/a2a-readiness.js';
import {
  appendVerifiedDeliveryInstructions,
  buildDeliveryListRows,
  buildRejectRetryContent,
  generateTaskId,
  parseDeliveryDuration,
} from './core/verified-delivery.js';
import { resolveTaskPlanTransition } from './verified-delivery/planning.js';
import {
  REJECT_REASON,
  type HelpKind,
  type RejectReason,
  type TaskDispatchWorkerSpec,
  type TaskStatus,
} from './verified-delivery/types.js';
import { tmuxEnv } from './setup/ensure-tmux.js';
import { writeBotsJsonAtomic as writeBotsAtomic } from './setup/bots-store.js';
import {
  applyBotConfigEdits,
  assertUniqueBotProcessNames,
  botProcessName,
  cloneBotConfig,
  cloneOwnerEntries,
  normalizeBotConfig,
  parseBotConfigsJson,
  parseBotSelection,
  removeBotConfig,
  resolveCliId,
  assertOwnerWhenChatGroups,
  findInvalidAllowedUserEntries,
  hasOwnerEntry,
  type BotConfigEditInput,
} from './setup/bot-config-editor.js';
import { resolveCliSelection, selectionKeyForBot } from './setup/cli-selection.js';
import { checkCliAvailability, hasAgentLaunchConfigChanged } from './setup/cli-availability.js';
import { resolveCloneAppName, resolveSetupAppName } from './setup/app-name.js';
import {
  blocksSetupBotStart,
  classifySetupOpenPlatformOutcome,
  scriptedSetupOpenPlatformReuseOnly,
  setupOpenPlatformOutcomeJson,
  setupOpenPlatformRetryCommand,
  type SetupOpenPlatformOutcome,
} from './setup/open-platform-outcome.js';
import {
  buildBotFromAddFlags,
  editInputFromFlags,
  isScriptedSetupInvocation,
  maskAppSecret,
  parseSetupCommand,
  SETUP_CLI_USAGE,
  type SetupCommand,
} from './setup/setup-args.js';
import {
  detectUnusableOwnerEntries,
  normalizeManagedOwnerEntries,
  resolveScannerAllowedUser,
} from './setup/owner-identity.js';
import { interactiveSelect, pickChoice, pickCliSelection } from './setup/interactive-select.js';
import { buildPreset, serializePreset, presetFilename } from './setup/agent-preset.js';
import bundledScopeManifest from './setup/lark-scopes.json' with { type: 'json' };
import type { CliId } from './adapters/cli/types.js';
import type { CodexAppDispatchLedgerEntry } from './types.js';
import {
  validateCodexAppManagedSendOrigin,
} from './utils/codex-app-dispatch-ledger.js';
import { hasProtectedSessionMutationOwnership } from './core/session-mutation-guard.js';
import type { BackendType, PersistentBackendTarget, SessionProbe } from './adapters/backend/types.js';
import { logger } from './utils/logger.js';
import { reapLegacyPm2, liveGodAt } from './core/legacy-pm2-reaper.js';
import { withFileLock, withFileLockSync, FileLockTimeoutError } from './utils/file-lock.js';
import { scheduleTimeZone } from './utils/timezone.js';
import { expandHomePath, invalidWorkingDirs } from './utils/working-dir.js';
import { firstPositional, hasFlagOrEq, unknownFlags } from './cli/arg-utils.js';
import { isColdResumeDormant, isRealManagedSession, sessionListDisposition } from './cli/session-list-liveness.js';
import {
  computeSessionPickerLayout,
  type SessionPickerColumnKey,
  type SessionPickerLayout,
} from './cli/session-picker-layout.js';
import { computeSessionPickerScrollWindow } from './cli/session-picker-viewport.js';
import {
  canWakeDormantBackendForAttach,
  type SessionListWakeRequestContext,
  wakeDormantBackendForAttach,
} from './cli/session-list-wake.js';
import { SESSION_WAKE_DEADLINE_HEADER } from './core/session-wake-deadline.js';
import { terminalCellWidth } from './cli/terminal-width.js';
import {
  attachFrozenManagedZmxSession,
  freezeManagedZmxAttachTarget,
} from './cli/zmx-managed-attach.js';
import { readSupervisorProcessStartIdentity } from './core/process-start-identity.js';
import {
  FLEET_DAEMON_EXIT_WAIT_MS,
  FLEET_SUCCESSOR_SETTLE_MS,
  PM2_DAEMON_KILL_TIMEOUT_MS,
  PM2_DAEMON_RESTART_DELAY_MS,
} from './core/shutdown-budgets.js';
import { describeSendFailure, dispatchPrimaryMessage, findStdinAliasAttachment, normalizeInteractiveCardInput, sendFileAttachments, sendVideoAttachments, shouldSendAsPureVideo, validateSlashSend, validateVideoAttachments } from './cli/send-dispatch.js';
import { buildCardPatchSuccessOutput, CARD_COMMAND_USAGE, CARD_PATCH_USAGE, cardPatchArgsWantHelp, executeCardPatch, parseCardPatchArgs, readCardPatchInput } from './cli/card-dispatch.js';
import { buildGoalStartBrief, buildGoalStartRetryCommand, resolveGoalStartInvitee, resolveGoalStartSelection, type GoalStartBot, type GoalStartTeam } from './cli/goal-start.js';
import { mergeBotOpenIdCrossRef, readBotOpenIdCrossRefRecord } from './services/bot-openid-crossref-store.js';
import { dispatchDeferredTopicSend, reusableDeferredTopicRoot, type DeferredScheduleRunData } from './cli/deferred-topic-send.js';
import { readDeferredTopicBinding } from './core/deferred-topic-binding.js';
import { resolveDaemonEnv } from './cli/daemon-lifecycle-env.js';
import { callDashboard, type DashboardEndpoint, type DashboardResult } from './cli/dashboard-endpoint.js';
import { ensureDevboxDashboardExport } from './platform/devbox-dashboard-export.js';
import { platformMachineBaseUrl, publicReverseProxyBaseUrl } from './platform/binding.js';
import { isRemoteAccessEnabled } from './global-config.js';
import {
  DASHBOARD_COMMAND_USAGE,
  dashboardComingUpFromState,
  dashboardFailureIsTerminal,
  executeDashboardCliCommand,
  formatDashboardFallbackFailure,
  formatDashboardSuccessLines,
  formatDashboardUnreachable,
  shouldKeepWaitingForDashboard,
} from './cli/dashboard-command.js';
import { globalInstallUpdateLockTarget, globalInstallUpdateLockTargetIn, installLatestBotmuxSync } from './core/maintenance.js';
import {
  formatGlobalInstallCommand,
  resolveGlobalInstallPlan,
  UnsupportedGlobalInstallError,
} from './utils/global-install.js';
import { isLocalDevInstall, botmuxCliEntryAt, bakedBinaryVersion, botmuxInstallRoot } from './utils/install-info.js';
import { currentUpdateStrategy, replaceStandaloneBinary } from './core/binary-self-update.js';
import { fetchLatestVersion, isNewerVersion } from './core/update-check.js';
import { resolveCurrentVersion } from './utils/install-diagnostics.js';
import {
  resolveLocalDevCheckoutDir,
  isGitWorktree,
  gitPorcelainStatus,
  localDevUpdateSteps,
  describeSpawnFailure,
} from './utils/local-dev-update.js';
import { cliAuthBind, loadDashboardSecret, signCliAuth } from './dashboard/auth.js';
import {
  postWorkflowDaemonMutation,
  type WorkflowDaemonMutation,
  type WorkflowDaemonMutationResponse,
} from './workflows/v3/daemon-ipc-client.js';
import {
  postWorkflowSessionRunMutation,
  readWorkflowSessionRelayContext,
} from './workflows/v3/session-relay-client.js';
import { fetchDaemonIpc, loadDaemonIpcSecret } from './core/daemon-ipc-auth.js';
import { REPORT_SESSION_RELAY_ROUTE } from './core/report-session-relay.js';
import { DISPATCH_REPORT_REGISTER_ROUTE } from './core/dispatch-report-binding.js';
import { isRetryableAskHttpStatus } from './core/ask-types.js';
import {
  hasManagedOriginIsolationMarker,
  managedOriginDataRootProbeAccess,
  managedOriginIsolationSentinelAccess,
  managedOriginLegacyIsolationProbeAccess,
  readManagedOriginRootLocator,
  readManagedOriginCapability,
} from './core/managed-origin-capability.js';
import {
  attestManagedOrigin,
  type ManagedOriginAttestation,
  type ManagedOriginAttestationContext,
} from './core/managed-origin-attestation.js';
import { rejectLikelyWindowsStdinMojibake, decodeStdinBytes } from './cli/stdin-encoding.js';
import {
  collaborationHelp,
  formatBotInfoEntriesForCli,
  formatChatBotsForCli,
  type BotCollaborationFactsByAppId,
} from './cli/bots-list-output.js';
import { ensureBotChatGrantMatrix, requestExactChatGrant } from './cli/exact-chat-grant-client.js';
import { loopbackFetch } from './core/loopback-fetch.js';
import {
  buildFooterAddressing,
  hasKnownBotMention,
  knownBotOpenIdsFromCrossRef,
  orderedFooterRecipients,
  stripCodeSpans,
  type BotMentionEntry,
} from './utils/bot-routing.js';
import { isLocale, localeForBot, setDefaultLocale, SUPPORTED_LOCALES, t, type Locale } from './i18n/index.js';
import { registerPromptOverrideResolver } from './skills/effective-builtins.js';
import { type Brand, chatAppLink, larkHosts, normalizeBrand, sdkDomain } from './im/lark/lark-hosts.js';
import type { GoalDecisionOption } from './services/goal-decision-options.js';
import { mergeDashboardConfig, mergeGlobalConfig, readGlobalConfig, setGlobalLocale, globalConfigPath } from './global-config.js';
import {
  createWhiteboard,
  ensureDefaultWhiteboard,
  getWhiteboard,
  listWhiteboards,
  readWhiteboard,
  whiteboardEnabled,
  whiteboardPath,
} from './services/whiteboard-store.js';
import {
  buildBridgeSendMarkerContent,
  buildBridgeSendPreviewText,
  stripTrailingOaiMemoryCitation,
} from './services/bridge-fallback-gate.js';
import {
  bindRestartLeaseTo,
  commitRestartIntentAttemptTo,
  consumeRestartIntentTo,
  removeRestartIntentAttemptTo,
  type RestartIntent,
  writeManualIntentIfAbsentTo,
  writeRestartAttemptIntentTo,
} from './services/restart-intent-store.js';
import { loadAllSessionsSnapshot, mutateSessionRowOffline } from './services/session-store.js';
import {
  evaluateVcMeetingManagedSend,
  isTrustedVcMeetingHostRelayParent,
  resolveVcMeetingImTurnOrigin,
  type VcMeetingManagedSendOrigin,
} from './services/vc-meeting-send-policy.js';
import {
  finishVcMeetingImReply,
  prepareVcMeetingDeliveryReply,
  prepareVcMeetingImReply,
} from './services/vc-meeting-im-reply.js';
import { recordVcMeetingListenerMessage } from './services/vc-meeting-listener-message-store.js';
import { isValidPluginId, normalizePluginIdList } from './core/plugins/ids.js';
import { resolveEffectivePluginIds, updateBotPluginOverride } from './core/plugins/effective.js';
import {
  assertPluginBindingTransition,
  describePluginDependencyError,
  enabledPluginDependents,
} from './core/plugins/dependencies.js';
import { authorizeV3DaemonCommand } from './workflows/v3/cli-daemon-command-authority.js';
import { resolveDaemonIpcPort } from './utils/daemon-discovery.js';
import {
  isSuspendableBackendType,
  killPersistentBackendTarget,
  probePersistentBackendTarget,
  probePersistentSessions,
  resolvePersistentBackendTarget,
  type PersistentBackendType,
} from './core/persistent-backend.js';

// Resolve the CLI's UI locale once from the global config file, so subsequent
// CLI output (and any t() callers that don't pass an explicit locale) honour
// the user's chosen language. Daemon entrypoint sets this separately for the
// daemon process.
{
  const cfg = readGlobalConfig();
  if (cfg.lang) setDefaultLocale(cfg.lang);
  // Wire user prompt-key overrides into t() so CLI-side prompt building (e.g.
  // `botmux skill show`, catalog rendering) honours customizations. Idempotent.
  registerPromptOverrideResolver();
}

// CLI subcommands (send/thread/bots/list/etc) print JSON to stdout for
// callers to parse. Transitive logger.info calls from shared modules would
// corrupt that stream, so the CLI process runs silent by default. DEBUG=1
// re-enables logging end-to-end for CLI troubleshooting.
logger.setSilent(true);

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const require = createRequire(import.meta.url);

// Package root is one level up from dist/
const PKG_ROOT = dirname(__dirname);
const CONFIG_DIR = join(homedir(), '.botmux');
const ENV_FILE = join(CONFIG_DIR, '.env');
const DATA_DIR = join(CONFIG_DIR, 'data');
const LOG_DIR = join(CONFIG_DIR, 'logs');
const HEAPSHOT_DIR = join(CONFIG_DIR, 'heapshots');
const BOTS_JSON_FILE = join(CONFIG_DIR, 'bots.json');
// Base process-name prefix for a bot's daemon (botmux / botmux-<name|index>).
// Retained from the pm2 era — still the canonical name base used across setup
// and fleet addressing (see botProcessName).
const PM2_NAME = 'botmux';
// Serializes every fleet mutation (start/stop/restart/start-bot/stop-bot) on one
// file lock. Named for the pm2 era but now guards the built-in supervisor's
// single-mutation-at-a-time invariant.
const PM2_FLEET_MUTATION_LOCK_TARGET = join(CONFIG_DIR, 'pm2-fleet-mutation');
const PM2_START_VERIFY_MIN_TIMEOUT_MS = 60_000;
const PM2_START_VERIFY_PER_PROCESS_MS = 2_000;

/** Bounded fleet-online wait budget: at least 60s, scaled by bot count. Feeds
 *  the supervisor restart health gate (waitFleetOnline). */
function pm2StartVerifyTimeoutMs(processCount: number): number {
  return Math.max(
    PM2_START_VERIFY_MIN_TIMEOUT_MS,
    Math.max(1, Math.floor(processCount)) * PM2_START_VERIFY_PER_PROCESS_MS,
  );
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function ensureConfigDir(): void {
  for (const dir of [CONFIG_DIR, DATA_DIR, LOG_DIR, HEAPSHOT_DIR]) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
}

function loadBotsJson(): any[] {
  // NOTE: this stays FATAL on a read error, deliberately. Several callers treat
  // an empty list as "nothing references this" and go on to delete things
  // (plugin dematerialize / uninstall dependency check) — degrading the read to
  // [] would turn a denied read into silent destructive action. Anything that
  // must survive an unreadable bots.json has to opt out explicitly, the way
  // allBotAppIds() and currentBotIsApiOnly() do.
  if (existsSync(BOTS_JSON_FILE)) {
    try {
      return parseBotConfigsJson(readFileSync(BOTS_JSON_FILE, 'utf-8'), BOTS_JSON_FILE);
    } catch (err: any) {
      console.error(`❌ ${err?.message ?? String(err)}`);
      process.exit(1);
    }
  }
  return [];
}

function ensureBotWorkingDirsExist(bot: Record<string, any>, context = 'workingDir'): boolean {
  const invalid = invalidWorkingDirs(bot);
  if (invalid.length === 0) return true;
  console.log(`\n❌ ${context} 指向的目录不存在或不是目录:`);
  for (const dir of invalid) console.log(`   - ${dir}`);
  console.log('   请先创建目录，或重新填写一个已存在的工作目录。');
  return false;
}

/**
 * 固定默认目录（defaultWorkingDir）写盘前的存在性校验。运行时 daemon 对无效
 * defaultWorkingDir 只是 WARN 后回退弹仓库选择卡，用户很难察觉配置根本没生效，
 * 所以 setup 侧必须在写盘前就挡下来。未配置视为通过。
 */
function ensureBotDefaultWorkingDirExists(bot: Record<string, any>): boolean {
  const raw = typeof bot.defaultWorkingDir === 'string' ? bot.defaultWorkingDir.trim() : '';
  if (!raw) return true;
  const missing = missingDirResolved(raw);
  if (!missing) return true;
  console.log(`\n❌ 固定默认目录不存在或不是目录: ${missing}`);
  console.log('   请先创建目录，或改用仓库选择卡片模式。');
  return false;
}

function ensureUniqueBotProcessNames(bots: any[]): void {
  try {
    assertUniqueBotProcessNames(bots, PM2_NAME);
  } catch (err: any) {
    console.error(`❌ ${err?.message ?? String(err)}`);
    console.error('   请修改 bots.json 中的 name，确保进程名唯一。');
    process.exit(1);
  }
  const pluginPrefix = `${PM2_NAME}-plugin-`;
  for (let i = 0; i < bots.length; i++) {
    const name = botProcessName(bots[i], i, PM2_NAME);
    if (name.startsWith(pluginPrefix)) {
      console.error(`❌ bot 进程名 ${name} 使用了插件 service 保留前缀 ${pluginPrefix}`);
      console.error('   请修改 bots.json 中的 name，避免以 plugin- 开头。');
      process.exit(1);
    }
  }
}

/**
 * `botmux serve --api-only` — run a single-process, headless core-only service
 * in the FOREGROUND (stdio inherited so a launcher can watch the ready line and
 * the process lifetime IS the service). No pm2, no dashboard, no bots.json, no
 * Feishu credentials. See src/index-core-only.ts for the full contract.
 */
async function cmdServe(args: string[]): Promise<void> {
  const apiOnly = args.includes('--api-only');
  if (!apiOnly) {
    console.error('Usage: botmux serve --api-only [--port <PORT>] [--bot <local_slug>] [--cli <cliId>] [--state-dir <DIR>]');
    console.error('  Only core-only (--api-only) serving is supported. It runs a headless HTTP');
    console.error('  control-API service with no Feishu credentials (for riff sandbox / embedding).');
    process.exit(2);
  }
  const getOpt = (flag: string): string | undefined => {
    const i = args.indexOf(flag);
    return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
  };
  const port = getOpt('--port') ?? process.env.BOTMUX_API_PORT;
  if (!port || !/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
    console.error(`botmux serve --api-only: --port (or BOTMUX_API_PORT) must be a valid port; got: ${port ?? '(unset)'}`);
    process.exit(2);
  }
  const bot = getOpt('--bot') ?? process.env.BOTMUX_API_ONLY_BOT;
  const cli = getOpt('--cli') ?? process.env.BOTMUX_CORE_CLI;
  const workingDir = getOpt('--working-dir') ?? process.env.BOTMUX_CORE_WORKING_DIR;
  const stateDir = getOpt('--state-dir') ?? process.env.BOTMUX_CORE_STATE_DIR;

  // Node: spawn `node dist/index-core-only.js`. Standalone binary: re-exec THIS
  // binary with the hidden `__core-only` subcommand (no dist/ on disk). Same env
  // contract either way (the entry reads BOTMUX_CORE_ONLY/API_PORT/… below).
  const coreSpawn = resolveEntrySpawn('core-only', join(PKG_ROOT, 'dist'));
  const child = spawn(coreSpawn.command, coreSpawn.args, {
    stdio: 'inherit',
    env: (() => {
      const e: NodeJS.ProcessEnv = {
        ...process.env,
        BOTMUX_CORE_ONLY: '1',
        BOTMUX_API_PORT: port,
        // Freeze worker HTTP to loopback here too (defense-in-depth with the
        // entrypoint) so a stray parent/dotenv 0.0.0.0 never reaches the child.
        BOTMUX_WORKER_HTTP_HOST: '127.0.0.1',
        ...(bot ? { BOTMUX_API_ONLY_BOT: bot } : {}),
        ...(cli ? { BOTMUX_CORE_CLI: cli } : {}),
        ...(workingDir ? { BOTMUX_CORE_WORKING_DIR: workingDir } : {}),
        ...(stateDir ? { BOTMUX_CORE_STATE_DIR: stateDir } : {}),
      };
      // Never hand an ambient BOTS_CONFIG / legacy worker-host alias / ambient
      // SESSION_DATA_DIR to the core-only child — the entrypoint freezes/strips
      // these too, but keep the spawn env clean from the start (codex P1: agent
      // could read $BOTS_CONFIG; ambient SESSION_DATA_DIR would point at a host
      // fleet's store). The entrypoint re-derives a dedicated core-only state root.
      delete e.BOTS_CONFIG;
      delete e.BOTMUX_WORKER_HOST;
      delete e.SESSION_DATA_DIR;
      return e;
    })(),
  });
  // Foreground lifetime tracks the child: forward termination signals and exit
  // with the child's code so a launcher/supervisor sees an honest status.
  const forward = (sig: NodeJS.Signals) => { try { child.kill(sig); } catch { /* */ } };
  process.on('SIGTERM', () => forward('SIGTERM'));
  process.on('SIGINT', () => forward('SIGINT'));
  await new Promise<void>((resolve) => {
    child.on('exit', (code, signal) => {
      if (signal) { process.exitCode = 1; } else { process.exitCode = code ?? 0; }
      resolve();
    });
    child.on('error', (err) => {
      console.error(`[core-only] failed to spawn service: ${err.message}`);
      process.exitCode = 1;
      resolve();
    });
  });
}

function hasConfig(): boolean {
  return existsSync(BOTS_JSON_FILE) || existsSync(ENV_FILE);
}

function ask(rl: ReturnType<typeof createInterface>, question: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const onError = (err: NodeJS.ErrnoException) => {
      rl.off("error", onError);
      if (err?.code === "EIO") {
        console.warn("\nWarning: interactive input stream closed (EIO); continuing with empty input.");
        resolve("");
        return;
      }
      reject(err);
    };
    rl.once("error", onError);
    rl.question(question, answer => {
      rl.off("error", onError);
      resolve(answer);
    });
  });
}

// ─── Setup helpers ──────────────────────────────────────────────────────────

function printInputHelp(title: string, lines: string[]): void {
  console.log(`\n${title}`);
  for (const line of lines) {
    console.log(`  ${line}`);
  }
}

// Thin wrapper around setup/bots-store.writeBotsJsonAtomic so call-sites keep
// the same name without passing BOTS_JSON_FILE explicitly each time.
function writeBotsJsonAtomic(bots: any[]): void {
  const normalized = bots.map(bot => normalizeBotConfig(bot));
  ensureUniqueBotProcessNames(normalized);
  writeBotsAtomic(BOTS_JSON_FILE, normalized);
}

/**
 * 从 bot 配置里取 brand. 旧的 bots.json (1.0 之前) 没这个字段, default 到 feishu
 * 保留向后兼容. cmdStart 凭证校验 + printRemainingSteps 深链都靠它选 host.
 * 归一逻辑收口到 lark-hosts 的 {@link normalizeBrand}（单一事实源）。
 */
function botBrand(b: any): Brand {
  return normalizeBrand(b?.brand);
}

/**
 * 把 botmux 推荐的完整 scope JSON (从 src/setup/lark-scopes.json) 写到
 * 用户配置目录, 同时给出跨平台一键复制命令. JSON 长 (293 项, 297 行),
 * terminal 直接打印用户也复制不了, 写文件 + pbcopy/xclip 才是顺手的姿势.
 *
 * Returns: 写出的 JSON 文件绝对路径.
 */
function writeScopesJsonToConfigDir(): string {
  const destPath = join(CONFIG_DIR, 'lark-scopes.json');
  writeFileSync(destPath, `${JSON.stringify(bundledScopeManifest, null, 2)}\n`);
  return destPath;
}

function printCopyHint(filePath: string): void {
  // 环境感知: SSH/headless 没有 X server, xclip 一定报 "Can't open display".
  // 这种场景下"剪贴板"在用户本地 (运行 SSH 客户端的那台机器), 远程机上能做的:
  //   - 直接 cat, 让用户在本地 terminal 鼠标选中 (SSH 选中即写本地剪贴板)
  //   - OSC 52: terminal app 代写本地剪贴板, iTerm2 / kitty / WezTerm /
  //     Alacritty / tmux 1.5+ 都支持, gnome-terminal / Terminal.app 不支持
  // 检测 DISPLAY (X11) 或 WAYLAND_DISPLAY 都没有, 或 SSH_* 环境变量存在
  // → 当作 SSH 场景, 不推荐 xclip / pbcopy.
  const isSsh = !!(process.env.SSH_CONNECTION || process.env.SSH_CLIENT || process.env.SSH_TTY);
  const hasLocalGui = !!(process.env.DISPLAY || process.env.WAYLAND_DISPLAY) && !isSsh;
  const isMacLocal = process.platform === 'darwin' && !isSsh;

  console.log('  把 JSON 内容拷到本地剪贴板, 然后到飞书"批量导入/导出权限"页粘贴:');
  if (isMacLocal) {
    console.log(`    macOS 本地:  cat ${filePath} | pbcopy`);
  } else if (hasLocalGui) {
    console.log(`    Linux 本地 (X 服务器):  cat ${filePath} | xclip -selection clipboard`);
  } else {
    // SSH / headless: 鼠标选中是最稳的, OSC 52 作为高级选项
    console.log(`    SSH 终端鼠标选中复制:  cat ${filePath}`);
    console.log('       (终端把选中的字符直接写到你本地剪贴板, 不依赖远端剪贴板工具)');
    console.log(`    或 OSC 52 (兼容 iTerm2 / kitty / WezTerm / Alacritty / tmux 1.5+):`);
    console.log(`       base64 -w0 < ${filePath} | awk 'BEGIN{printf "\\033]52;c;"}{printf "%s",$0}END{printf "\\a"}'`);
  }
  console.log('');
}

/**
 * 手动提示里要让用户填的重定向 URL 列表。
 *
 * 写死 `http://127.0.0.1:9768/callback` 是错的：配了 `oauthRedirectBase` / 接了中心
 * 平台 / 自建反代时，实际发起授权用的是 `<base>/oauth/callback`，只填 loopback 那条
 * 照样 20029。这里按当前配置实时算（与自动写白名单用的是同一个函数）。
 * `collectBotmuxRedirectUrls` 内部逐项 try/catch，理论上不抛；再兜一层是因为这段只是
 * 「打印提示」，任何意外都不该把 setup 本身弄挂。
 */
function safeCollectBotmuxRedirectUrls(collect: () => string[]): string[] {
  try {
    const urls = collect();
    if (urls.length > 0) return urls;
  } catch { /* 配置读不动：退回最核心的那一条 */ }
  return ['http://127.0.0.1:9768/callback'];
}

function printRemainingSteps(appId: string, brand: 'feishu' | 'lark', redirectUrls: string[]): void {
  // 同时覆盖 Web 企业自建应用与 SDK PersonalAgent fallback：后者的 bot / 事件
  // 步骤通常已完成，但重复核对无害；前者在自动化中途失败时必须补齐这些步骤。
  const home = `${larkHosts(brand).openApi}/app/${appId}`;
  let scopesJsonPath = '';
  try {
    scopesJsonPath = writeScopesJsonToConfigDir();
  } catch (err) {
    // 不应阻止 setup 完成, 只 WARN
    console.log(`\n⚠️  写权限 JSON 失败 (${(err as Error).message}), 请手动从仓库源码 src/setup/lark-scopes.json 拷.`);
  }

  console.log('\n请在开放平台核对并补齐以下配置:\n');

  console.log('  1. 开启「应用功能 → 机器人」能力');
  console.log(`     配置链接: ${home}/capability/bot`);
  console.log('');

  console.log('  2. 事件与回调切到「使用长连接接收事件」，并订阅 im.message.receive_v1 / card.action.trigger');
  console.log(`     配置链接: ${home}/dev-config/event-sub`);
  console.log('');

  console.log('  3. 申请权限 (一次性导入完整 JSON 提交审批)');
  console.log(`     申请链接: ${home}/auth → 进入「权限管理」→「批量导入/导出权限」→ 粘贴 → 提交`);
  if (scopesJsonPath) {
    console.log(`     权限 JSON: ${scopesJsonPath}`);
    printCopyHint(scopesJsonPath);
  }
  console.log('');

  console.log('  4. 添加重定向 URL (群聊模式 p2pMode=group / 会话群标签 feed-group / `/login` 必需)');
  console.log(`     申请链接: ${home}/safe → 进入「安全设置」→「重定向 URL」`);
  // 多条时逐行列出：配了 oauthRedirectBase / 平台绑定 / 反代的机器少填一条就还是 20029。
  console.log(redirectUrls.length === 1 ? `     填入: ${redirectUrls[0]}` : '     以下每一条都要填入:');
  if (redirectUrls.length > 1) for (const url of redirectUrls) console.log(`       - ${url}`);
  console.log('     用于 botmux 内 `/login` 拿用户 UAT 获取卡片消息; 白名单里没有它,');
  console.log('     这三种用法点授权会直接报 20029, 连飞书授权页都进不去.\n');

  console.log('  5. 在「版本管理与发布」创建版本并提交发布');
  console.log(`     配置链接: ${home}/version`);
  console.log('');

  console.log('  完成后 `botmux start` (或 `botmux restart`)，启动检查不会卡住，');
  console.log('  缺权限只 WARN，去开放平台补齐后 daemon 自动恢复。\n');
}

async function finishOpenPlatformSetup(
  appId: string,
  brand: 'feishu' | 'lark',
  options: {
    reuseOnly?: boolean;
    forceQrLogin?: boolean;
    quiet?: boolean;
    /** 本次 setup 刚创建出这个应用 —— 只有它允许 redirect 白名单在读失败时盲写覆盖。 */
    appJustCreated?: boolean;
  } = {},
): Promise<SetupOpenPlatformOutcome> {
  const say = (...args: unknown[]) => { if (!options.quiet) console.log(...args); };
  const {
    parseSetupOpenPlatformAutoFlag,
    automateOpenPlatformSetup,
    collectBotmuxRedirectUrls,
  } = await import('./setup/open-platform-automation.js');
  const redirectUrls = safeCollectBotmuxRedirectUrls(collectBotmuxRedirectUrls);
  if (!parseSetupOpenPlatformAutoFlag(process.argv.slice(3))) {
    say('\n已跳过开放平台自动配置 (--no-open-platform-auto)。');
    if (!options.quiet) printRemainingSteps(appId, brand, redirectUrls);
    return { status: 'skipped' };
  }

  say('\n── 开放平台自动配置 ──\n');
  say(options.forceQrLogin
    ? '将按 --switch-account 明确重新扫码，自动导入权限、配置 redirect URL 并创建/发布版本。'
    : options.reuseOnly
      ? '将复用创建应用时的 Feishu Web session，自动导入权限、配置 redirect URL 并创建/发布版本；本路径不会再显示二维码。'
      : '将获取或复用 Feishu Web session，自动导入权限、配置 redirect URL 并创建/发布版本。');
  say('如失败会自动回退到手动步骤提示，不影响已写入的 botmux 配置。\n');

  const result = await automateOpenPlatformSetup({
    appId,
    brand,
    forceQrLogin: options.forceQrLogin,
    disableQrLogin: options.reuseOnly,
    disableBytedcliFallback: options.reuseOnly || options.forceQrLogin,
    appJustCreated: options.appJustCreated,
  });
  const outcome = classifySetupOpenPlatformOutcome(result);
  if (result.ok) {
    say('✅ 开放平台自动配置完成');
    say(`   Session 来源: ${result.sessionSource}`);
    const skipped = result.skippedScopeCount ?? 0;
    say(`   已导入权限数: ${result.scopeCount}${skipped > 0 ? `（另有 ${skipped} 项当前租户目录中没有，已跳过）` : ''}`);
    if (result.scopeWarning) {
      say(`   ⚠️ 权限注册未全部成功（部分租户对个别权限有限制）：${result.scopeWarning}`);
      say('      可稍后到开放平台「权限管理」手动补齐缺失权限。');
    } else if (result.scopeCount === 0) {
      say('   ⚠️ 本次没有成功导入任何权限，请到开放平台「权限管理」手动导入 ~/.botmux/lark-scopes.json。');
    }
    // redirect 白名单是独立的一步，失败不阻断建 bot —— 但也绝不能无条件报「已配置」。
    // 白名单缺了这条，群聊模式 / 会话群标签 / `/login` 点授权直接 20029。
    if (result.redirectConfigured) {
      say(`   已配置 redirect URL: ${redirectUrls.join('、')}`);
    } else {
      say(`   ⚠️ redirect URL 未配置成功：${result.redirectWarning ?? '未知原因'}`);
      say(`      请到开放平台「安全设置」→「重定向 URL」手动添加: ${redirectUrls.join('、')}`);
      say('      缺了它，群聊模式 p2pMode=group / 会话群标签 / `/login` 点授权会直接报 20029。');
    }
    // 「已提交发布版本」不能无条件说：commit 回 code=0 而版本仍停在草稿态是实测发生过
    // 的（那个草稿正是卡死后续每一次权限自愈的元凶）。versionWarning 有值时权限**不会
    // 生效**，报「已提交」就是假绿灯，用户会干等。
    if (result.versionWarning) {
      say(`   ⚠️ 版本未确认提交发布：${result.versionWarning}`);
      say('      权限要等版本发布后才生效；请到开放平台「版本管理与发布」确认该版本状态。');
    } else if (result.versionId) say(`   已提交发布版本: ${result.versionId}`);
    else if (result.publishSkipped) say('   本次配置无变更，已跳过发版（未创建新版本）。');
    else say('   已创建版本；未从响应中解析到 versionId，请到开放平台确认是否需要手动发布。');
    say('');
    return outcome;
  }

  say(`${outcome.status === 'manual' ? 'ℹ️ ' : '⚠️ '} 开放平台自动配置${outcome.status === 'manual' ? '需要手动完成' : '失败'} (${result.reason}): ${result.message}`);
  if (result.sessionFile) say(`   botmux session 文件: ${result.sessionFile}`);
  say('   请按下面的手动步骤继续完成开放平台配置。');
  if (!options.quiet) printRemainingSteps(appId, brand, redirectUrls);
  return outcome;
}

/**
 * 「选择已有应用」路径：复用/扫码飞书 Web 登录态 → 拉当前账号可见的自建应用
 * 列表 → 交互选择 → 自动读取该应用的 AppSecret。仅支持飞书 (feishu.cn) 租户
 * （Web console 机制所限）。
 *
 * 失败返回区分两类，调用方据此导航：
 *   - back   — 用户主动退出（列表 Esc / 放弃手动粘 secret）→ 回「飞书应用来源」
 *   - failed — 技术性失败（登录 / 列表 / console 访问）→ 提示后回「飞书应用来源」
 */
async function pickExistingAppCredentials(
  rl: ReturnType<typeof createInterface>,
): Promise<
  | { ok: true; appId: string; appSecret: string; brand: Brand }
  | { ok: false; reason: 'back' | 'failed' }
> {
  const {
    prepareFeishuWebSession,
    createOpenPlatformApiClient,
    listOpenPlatformApps,
    fetchOpenPlatformAppSecret,
  } = await import('./setup/open-platform-automation.js');

  console.log('\n获取飞书 Web 登录态（复用上次登录，过期则需重新扫码）…');
  const prepared = await prepareFeishuWebSession({
    onQrCode: (info) => {
      process.stderr.write('\n请用飞书 App 扫码登录，以读取你创建过的应用列表：\n\n');
      process.stderr.write(`${info.qrText}\n`);
    },
    onStatus: (message) => { process.stderr.write(`${message}\n`); },
  });
  if (!prepared.ok) {
    console.log(`⚠️  飞书 Web 登录失败 (${prepared.reason}): ${prepared.message}`);
    return { ok: false, reason: 'failed' };
  }

  const clientRes = await createOpenPlatformApiClient(prepared.cookies);
  if (!clientRes.ok) {
    console.log(`⚠️  开放平台访问失败 (${clientRes.reason}): ${clientRes.message}`);
    return { ok: false, reason: 'failed' };
  }

  let apps;
  try {
    apps = await listOpenPlatformApps(clientRes.client);
  } catch (err: any) {
    console.log(`⚠️  拉取应用列表失败: ${err?.message ?? String(err)}`);
    return { ok: false, reason: 'failed' };
  }
  if (apps.length === 0) {
    console.log('⚠️  当前账号名下没有可选的自建应用。');
    return { ok: false, reason: 'failed' };
  }

  // 已在 bots.json 里的应用打标——可以重复选（比如换机器重配），但要让人知道。
  const configured = new Set(loadBotsJson().map(b => b?.larkAppId));
  const idx = await pickChoice(rl, {
    title: '选择已有应用',
    items: apps.map(a => ({
      label: a.name,
      hint: `${a.clientId}${configured.has(a.clientId) ? ' · 已在 bots.json' : ''}`,
    })),
    footer: 'Esc 返回上一步',
  });
  if (idx === null) return { ok: false, reason: 'back' };
  const app = apps[idx];

  try {
    const appSecret = await fetchOpenPlatformAppSecret(clientRes.client, app.clientId);
    console.log(`✅ 已选择 ${app.name} (${app.clientId})，AppSecret 已自动获取`);
    return { ok: true, appId: app.clientId, appSecret, brand: 'feishu' };
  } catch (err: any) {
    console.log(`⚠️  自动读取 AppSecret 失败: ${err?.message ?? String(err)}`);
    const manual = (await ask(rl, `请手动粘贴 ${app.clientId} 的 AppSecret（留空返回上一步）: `)).trim();
    if (!manual) return { ok: false, reason: 'back' };
    return { ok: true, appId: app.clientId, appSecret: manual, brand: 'feishu' };
  }
}

/**
 * 拿应用凭证：扫码创建新应用 / 选择已有应用 / 手动输入，三选一。
 *
 * 导航语义（TTY）：子界面 Esc / 主动放弃一律**返回「飞书应用来源」菜单**，
 * 只有在来源菜单本身 Esc（或扫码时 Ctrl-C）才取消整个 setup；技术性失败
 * 提示后同样回到来源菜单，让用户改走其他方式。非 TTY 没有 Esc，保持
 * 旧的「失败降级手动输入」直落语义，避免菜单循环在管道输入下打转。
 *
 * Codex review 边界:
 * - secret 不进 argv / 日志 / 错误链 (registerApp 内部 safeMsg 已做; 手动模式下
 *   AppSecret 通过 rl.question 异步读取, 不会出现在 process.argv)
 * - 任何失败都返回结构化对象, 不抛 (调用方根据 ok=false 回退)
 *
 * export 是给单测用的取值缝：`appJustCreated` 只在这里按来源分支置位，下游
 * (`promptBotConfig` → SETUP_APP_JUST_CREATED → finishOpenPlatformSetup) 只是原样透传，
 * 所以「哪条来源算刚创建」必须在这一层锁住。生产代码没有别的调用方。
 */
export async function obtainCredentials(rl: ReturnType<typeof createInterface>): Promise<
  | {
      ok: true;
      appId: string;
      appSecret: string;
      brand: Brand;
      userOpenId?: string;
      webSessionReady?: boolean;
      /** 这个应用是本次 setup 现场创建出来的（而不是「选择已有」/「手动输入」的存量应用）。 */
      appJustCreated?: boolean;
    }
  | { ok: false; reason: 'cancelled' }
> {
  const interactive = process.stdin.isTTY && process.stdout.isTTY;
  console.log('── 飞书应用 ──\n');
  for (;;) {
    const method = await pickChoice(rl, {
      title: '飞书应用来源',
      items: [
        { label: '一次扫码创建新应用（推荐）', hint: '飞书 Web 登录后自动命名、创建应用、取凭证并完成开放平台配置' },
        { label: '选择已有应用', hint: '飞书 Web 登录列出你创建过的应用，自动取 AppID/Secret（仅飞书租户）' },
        { label: '手动输入 AppID/Secret', hint: '已在开放平台创建好应用' },
      ],
      defaultIndex: 0,
      footer: 'Esc 取消 setup',
    });
    if (method === null) return { ok: false, reason: 'cancelled' };

    if (method === 0) {
      const suggestedName = resolveSetupAppName(undefined, loadBotsJson().length);
      const appName = (await ask(rl, `机器人名称 [${suggestedName}]: `)).trim() || suggestedName;
      const {
        createFeishuOpenPlatformApp,
        inspectCachedFeishuOpenPlatformSession,
        readStoredCookiesFromSessionFile,
        botmuxFeishuSessionFilePath,
      } = await import('./setup/open-platform-automation.js');
      const inspected = await inspectCachedFeishuOpenPlatformSession();
      let sessionMode: 'reuse' | 'qr' = 'qr';
      let expectedIdentity: { userId: string; tenantId: string } | undefined;
      if (inspected.ok) {
        const accountChoice = await pickChoice(rl, {
          title: `确认飞书账号：${inspected.identity.userName} · ${inspected.identity.tenantName}`,
          items: [
            { label: '确认并免扫码添加', hint: inspected.identity.email || '复用本机有效登录态' },
            { label: '更换账号', hint: '重新扫码并覆盖本机登录态' },
          ],
          defaultIndex: 0,
          footer: 'Esc 返回「飞书应用来源」',
        });
        if (accountChoice === null) continue;
        sessionMode = accountChoice === 0 ? 'reuse' : 'qr';
        if (sessionMode === 'reuse') {
          expectedIdentity = {
            userId: inspected.identity.userId,
            tenantId: inspected.identity.tenantId,
          };
        }
      } else if ((readStoredCookiesFromSessionFile(botmuxFeishuSessionFilePath())?.length ?? 0) > 0) {
        const relogin = await pickChoice(rl, {
          title: '上次飞书登录态已失效或无法确认账号',
          items: [
            { label: '重新扫码', hint: '确认后生成新二维码并覆盖旧登录态' },
          ],
          defaultIndex: 0,
          footer: 'Esc 返回「飞书应用来源」',
        });
        if (relogin === null) continue;
      }
      console.log(sessionMode === 'reuse'
        ? '\n正在复用已确认的飞书账号创建应用（无需扫码）…'
        : '\n正在准备安全登录，请确认要创建应用的飞书账号与企业…');
      const webResult = await createFeishuOpenPlatformApp({
        name: appName,
        ...(sessionMode === 'reuse'
          ? { disableQrLogin: true, expectedIdentity }
          : { forceQrLogin: true }),
        disableBytedcliFallback: true,
        onSessionReady: ({ identity, source }) => {
          process.stderr.write(`已确认飞书账号：${identity.userName} · ${identity.tenantName}${source === 'botmux_cache' ? '（免扫码）' : ''}\n`);
        },
        onQrCode: info => {
          process.stderr.write('\n请用飞书 App 扫码登录，botmux 将代你创建应用并完成配置：\n\n');
          process.stderr.write(`${info.qrText}\n`);
        },
        onStatus: message => { process.stderr.write(`${message}\n`); },
      });
      if (webResult.ok) {
        console.log('\n✅ 应用创建成功（登录态已缓存，后续添加可免扫码）');
        console.log(`   应用名称: ${appName}`);
        console.log(`   App ID: ${webResult.appId}`);
        console.log('   租户类型: 飞书 (feishu.cn)');
        return {
          ok: true,
          appId: webResult.appId,
          appSecret: webResult.appSecret,
          brand: 'feishu',
          webSessionReady: true,
          appJustCreated: true,
        };
      }

      console.log(`\n⚠️  Web 自动创建失败 (${webResult.reason}): ${webResult.message}`);
      if (webResult.appId) {
        console.log(`   应用 ${webResult.appId} 已经创建，为避免重复建应用，不自动回退。`);
        console.log('   请返回后选择「选择已有应用」重新读取凭证。\n');
        if (interactive) continue;
        return { ok: false, reason: 'cancelled' };
      }

      const compatibility = await pickChoice(rl, {
        title: '是否使用兼容模式？',
        items: [
          { label: '使用兼容模式', hint: '官方 SDK device flow；可能需要额外扫码，应用名称由平台决定' },
          { label: '返回应用来源', hint: '保留当前配置输入，不会创建新应用' },
        ],
        defaultIndex: 1,
        footer: '兼容模式不会应用刚才填写的自定义名称',
      });
      if (compatibility !== 0) {
        if (interactive) continue;
        return { ok: false, reason: 'cancelled' };
      }
      console.log('   已明确选择 SDK 兼容模式；应用名称由平台决定。\n');

      // Web console 不可用 / Lark 国际版时保留官方 SDK device flow 作为稳定回退。
      const { tryRegisterApp } = await import('./setup/register-app.js');
      const result = await tryRegisterApp();
      if (result.ok) {
        // brand 由扫码 device flow 的 tenant_brand 自动识别（registerApp 内部已
        // 切到对应域名轮询）。feishu / lark 都直接落盘——daemon 链路全程从
        // BotConfig.brand 派生 host（Client / WSClient domain、裸 fetch、深链）。
        console.log(`\n✅ 应用创建成功`);
        console.log(`   App ID: ${result.appId}`);
        console.log(`   租户类型: ${result.brand === 'lark' ? 'Lark 国际版 (larksuite.com)' : '飞书 (feishu.cn)'}`);
        if (result.userOpenId) {
          console.log(`   扫码人 open_id: ${result.userOpenId}（将默认作为 allowedUsers）`);
        }
        return {
          ok: true,
          appId: result.appId,
          appSecret: result.appSecret,
          brand: result.brand,
          userOpenId: result.userOpenId,
          // tryRegisterApp 只有「device flow 现场注册一个新应用」这一条语义（见
          // setup/register-app.ts：SDK 打 `app/registration` 的 begin/poll），没有
          // 「复用已有应用」的分支，所以这里恒为刚创建。漏了它，兼容模式建出的新应用
          // 在 finishOpenPlatformSetup 里拿不到 allowBlindWrite —— 读不到白名单时会
          // 按「保护存量用户条目」零写入，可新应用本来就没有任何条目可保护，结果就是
          // redirect 白名单一条都没写，authorize 直接 20029。
          appJustCreated: true,
        };
      }
      console.log(`\n⚠️  SDK 扫码失败 (${result.error}): ${result.message}`);
      if (result.error === 'aborted') {
        // 用户主动取消整个 setup, 不再问手动 fallback
        return { ok: false, reason: 'cancelled' };
      }
      if (interactive) {
        console.log('   已返回「飞书应用来源」，可重试或改走其他方式。\n');
        continue;
      }
      console.log('   降级到手动输入 AppID/Secret。\n');
    }

    if (method === 1) {
      const existing = await pickExistingAppCredentials(rl);
      if (existing.ok) return existing;
      if (interactive) {
        // back（Esc / 主动放弃）静默回菜单；failed 已打印过原因，补一句导航。
        if (existing.reason === 'failed') console.log('   已返回「飞书应用来源」，可重试或改走其他方式。\n');
        continue;
      }
      console.log('   降级到手动输入 AppID/Secret。\n');
    }

    // 手动输入（method 2；非 TTY 下也是 0/1 失败后的直落兜底）：扫码路径已用
    // tenant_brand 自动识别；手动路径没有这个信号，兜底让用户手选租户类型
    // （决定建应用 / 运行时的域名）。
    const brandIdx = await pickChoice(rl, {
      title: '租户类型',
      items: [
        { label: '飞书（中国版）', hint: 'open.feishu.cn' },
        { label: 'Lark（国际版）', hint: 'open.larksuite.com' },
      ],
      defaultIndex: 0,
      footer: 'Esc 返回上一步',
    });
    if (brandIdx === null && interactive) continue; // Esc → 回「飞书应用来源」
    const brand: Brand = brandIdx === 1 ? 'lark' : 'feishu';

    console.log(`\n请在浏览器打开 ${larkHosts(brand).openApi}/app 创建应用，然后回来粘 ID/Secret。\n`);
    const appId = (await ask(rl, 'AppID (cli_xxx): ')).trim();
    const appSecret = (await ask(rl, 'AppSecret: ')).trim();

    if (!appId || !appSecret) {
      console.log('\n❌ AppID/AppSecret 不能为空，setup 中止。');
      return { ok: false, reason: 'cancelled' };
    }
    return { ok: true, appId, appSecret, brand };
  }
}

/**
 * 手动建 bot 时（没有扫码人 open_id）必须指定至少一个 owner.
 * 循环追问直到给出合法条目（邮箱、union_id on_xxx 或 open_id ou_xxx），拒绝裸邮箱前缀与空输入.
 * setup 不允许没有 owner —— 没 owner 的配置一旦叠加 allowedChatGroups 即成权限黑洞.
 */
async function promptRequiredOwner(rl: ReturnType<typeof createInterface>): Promise<string[]> {
  printInputHelp('管理员 (owner)', [
    '必填。至少一个能操作机器人的管理员，多个值用逗号分隔。',
    '推荐格式（优先级高到低）：完整邮箱（alice@example.com）> union_id（on_xxx，跨应用稳定）> 手机号（大陆号直填 11 位，海外号带 + 区号）> open_id（ou_xxx，仅限同一应用）。',
    '注意：邮箱必须完整，邮箱前缀（如 alice）无法解析、不接受。没有企业邮箱可用手机号。',
  ]);
  for (;;) {
    const raw = (await ask(rl, '管理员 (owner): ')).trim();
    const entries = raw.split(',').map(s => s.trim()).filter(Boolean);
    if (entries.length === 0) {
      console.log('   ❌ 必须至少指定一个管理员（不能为空）。');
      continue;
    }
    const invalid = findInvalidAllowedUserEntries(entries);
    if (invalid.length > 0) {
      console.log(`   ❌ 以下不是完整邮箱、手机号（大陆 11 位 / 海外带 + 国家码）、union_id 或 open_id（邮箱前缀不接受）: ${invalid.join(', ')}`);
      continue;
    }
    if (!hasOwnerEntry(entries)) {
      console.log('   ❌ 至少需要一个完整邮箱、手机号、union_id 或 open_id 作为 owner。');
      continue;
    }
    return entries;
  }
}

/**
 * 收集一个机器人完整配置 (凭证 + CLI/工作目录/allowedUsers).
 *
 * 顺序: 拿凭证 → tenant_access_token 验证 → 通过才返回 bot 对象. 验证失败
 * 直接返回 null, 调用方负责"不写 bots.json". Codex review 边界 #2.
 */
async function promptBotConfig(rl: ReturnType<typeof createInterface>): Promise<Record<string, any> | null> {
  const creds = await obtainCredentials(rl);
  if (!creds.ok) return null;

  // 凭证立刻验证. 通不过不写 bots.json.
  console.log('\n校验凭证（取 tenant_access_token）…');
  const { validateCredentials } = await import('./setup/verify-permissions.js');
  const v = await validateCredentials(creds.appId, creds.appSecret, creds.brand);
  if (!v.ok) {
    console.log(`\n❌ 凭证校验失败 (${v.error}): ${v.message}`);
    console.log('   不写 bots.json。请重新运行 botmux setup。');
    return null;
  }
  console.log('✅ 凭证有效（tenant_access_token 已成功获取）\n');

  // CLI 适配器：可搜索的级联选择器（选 Aiden 可进 × Claude / × Codex，aiden 网关）。
  // 非交互终端自动回退为序号 / ID 文本输入。
  // Esc = 中止 setup（不写盘）。新建流程的必答题没有"上一步"可退，绝不静默
  // 替用户选默认——扫码建出的应用可事后用「选择已有应用」找回，不会丢。
  const selKey = await pickCliSelection(rl, { title: '选择 CLI 适配器' });
  if (selKey === null) {
    console.log('\n已取消（Esc），setup 中止，不写任何配置。');
    return null;
  }
  let cliId: CliId;
  let wrapperCli: string | undefined;
  try {
    const sel = resolveCliSelection(selKey);
    cliId = sel.cliId;
    wrapperCli = sel.wrapperCli;
  } catch (err: any) {
    console.log(`\n❌ ${err?.message ?? String(err)}`);
    console.log('   不写 bots.json。请重新运行 botmux setup。');
    return null;
  }
  const cliAvailability = checkCliAvailability({ cliId, wrapperCli });
  if (!cliAvailability.available) {
    console.log(`\n⚠️  所选 Agent 当前无法启动：${cliAvailability.reason ?? '本地启动依赖不可用'}`);
    console.log('   配置仍可继续；请在 daemon 所在机器安装或修正 PATH / CLI 路径后再启动 Bot。\n');
  }
  // 新话题工作目录：两种模式二选一。旧问法只问「默认工作目录」但写的是
  // workingDir——那只是仓库选择卡片的扫描根，新话题照样弹卡，误导性强；
  // 真正「直接进目录、不弹卡」的是 defaultWorkingDir，现在显式让用户选。
  // 「固定默认目录」放首位当推荐默认：大量用户的真实诉求是"新话题直接进目录"，
  // 弹卡模式作为多仓库场景的进阶选项。
  const dirMode = await pickChoice(rl, {
    title: '新话题工作目录',
    items: [
      { label: '固定默认目录（推荐）', hint: '新话题直接在指定目录启动、不弹卡片' },
      { label: '仓库选择卡片', hint: '新话题先弹卡片，从扫描到的 git 仓库中选一个再启动' },
    ],
    defaultIndex: 0,
    footer: 'Esc 取消 setup · 之后可用 /config 或 botmux setup edit 修改',
  });
  // Esc = 中止 setup，不静默套用推荐默认（非 TTY 留空走 defaultIndex，不受影响）。
  if (dirMode === null) {
    console.log('\n已取消（Esc），setup 中止，不写任何配置。');
    return null;
  }
  let workingDir: string | undefined;
  let defaultWorkingDir: string | undefined;
  if (dirMode === 1) {
    const raw = await ask(rl, '仓库扫描根目录（卡片会列出其下的 git 仓库，逗号分隔多个）[~]: ');
    workingDir = raw.trim() || '~';
  } else {
    // 存在性校验循环——运行时 daemon 对无效 defaultWorkingDir 只会静默回退
    // 弹卡，setup 阶段必须挡住。留空默认 ~（一定存在，回车即通过）。
    for (;;) {
      const dir = (await ask(rl, '默认工作目录（新话题直接在此目录启动）[~]: ')).trim() || '~';
      if (ensureBotDefaultWorkingDirExists({ defaultWorkingDir: dir })) {
        defaultWorkingDir = dir;
        break;
      }
    }
  }

  const bot: Record<string, any> = {
    larkAppId: creds.appId,
    larkAppSecret: creds.appSecret,
    cliId,
    // aiden × claude/codex 等启动前缀；普通 CLI 不写此字段。
    ...(wrapperCli ? { wrapperCli } : {}),
    // 仓库选择模式总是写 workingDir（留空用 '~'），用户手动编辑 bots.json 时
    // 一眼能看到字段在哪儿；固定默认目录模式只写 defaultWorkingDir，扫描根
    // 回退默认 ~，bots.json 不留多余字段。
    ...(workingDir ? { workingDir } : {}),
    ...(defaultWorkingDir ? { defaultWorkingDir } : {}),
  };
  // brand 落盘：只在国际版 (lark) 时写字段，feishu 留空——保持旧 bots.json 干净，
  // 且 botBrand()/normalizeBrand() 读不到时 default 到 feishu，向后兼容。
  // 下游 finishOpenPlatformSetup(bot, botBrand(bot)) 据此给出正确的 larksuite 深链。
  if (creds.brand === 'lark') {
    bot.brand = 'lark';
  }
  // setup 不再询问 model（用户常选到无权限的 model，setup 完一发消息就 spawn
  // 报错，排查成本高）。需要指定 model 走 /config 卡片或手动编辑 bots.json。
  // 扫码场景默认填扫码人自己，但 registerApp 返回的 open_id 不能直接信任：
  // 只有新 app 自身能验证时才写入 allowedUsers；验证失败则要求手动填写 owner。
  // 手动 fallback 场景没 open_id —— 必须显式指定 owner, 否则配置无 owner:
  // allowedUsers 为空时虽然"全开放", 但一旦后续加了 allowedChatGroups 就会变成
  // "群成员能对话却没人能做敏感操作 / 用 /grant". setup 阶段强制收口, 不允许没 owner.
  if (creds.userOpenId) {
    const owner = await resolveScannerAllowedUser(creds.appId, creds.appSecret, creds.userOpenId, creds.brand);
    if (owner) {
      bot.allowedUsers = [owner];
      // Persist the native ou_ too. allowedUsers may hold the cross-app-stable
      // on_ (union_id) form that needs a contact-API resolve every boot; this
      // raw open_id never does, so it stays a valid fail-safe DM recipient even
      // when that resolve is the very thing failing (cold-start race).
      bot.ownerOpenId = creds.userOpenId;
    } else {
      console.log('⚠️  无法确认扫码人的 open_id 属于当前新应用，请手动填写 owner。');
      bot.allowedUsers = await promptRequiredOwner(rl);
    }
  } else {
    bot.allowedUsers = await promptRequiredOwner(rl);
  }

  if (!ensureBotWorkingDirsExist(bot, '仓库扫描根目录')) return null;

  const normalized = normalizeBotConfig(bot);
  if (creds.webSessionReady) {
    Object.defineProperty(normalized, SETUP_WEB_SESSION_READY, { value: true, enumerable: false });
  }
  if (creds.appJustCreated) {
    Object.defineProperty(normalized, SETUP_APP_JUST_CREATED, { value: true, enumerable: false });
  }
  return normalized;
}

const SETUP_WEB_SESSION_READY = Symbol('setup-web-session-ready');
/**
 * 「这个应用是本次 setup 刚创建的」。与 {@link SETUP_WEB_SESSION_READY} 分开两个
 * 符号：后者只说明「本机有可复用的 Web 登录态」，把它当「刚建的应用」用会在
 * 「选择已有应用」路径上误判——那条路径同样有登录态，但应用是存量的。
 */
const SETUP_APP_JUST_CREATED = Symbol('setup-app-just-created');

function hasSetupWebSession(bot: Record<string, any>): boolean {
  return Boolean((bot as any)[SETUP_WEB_SESSION_READY]);
}

function wasAppJustCreatedBySetup(bot: Record<string, any>): boolean {
  return Boolean((bot as any)[SETUP_APP_JUST_CREATED]);
}

function formatOptionalValue(v: unknown): string {
  if (Array.isArray(v)) return v.join(',');
  if (typeof v === 'string' && v) return v;
  return '未设置';
}

/** Render a tri-state optional boolean for the edit prompt, showing the effective
 *  value: explicit true/false when set, else the field's documented default. */
function formatBooleanValue(v: unknown, defaultValue: boolean): string {
  if (typeof v === 'boolean') return String(v);
  return `${defaultValue}（默认）`;
}

/**
 * 把 bots.json 渲染成对齐的小表格. 不带行号——进程名 (botmux-N) 已经
 * 是唯一可寻址的标识, 行号 + 进程名后缀 1-based / 0-based 并列容易引
 * 起 off-by-one 误解 (用户曾踩过 "1. botmux-0" 这种排版).
 *
 * 选择机器人时直接输完整进程名 (botmux-N / botmux-custom) 或 AppID,
 * parseBotSelection 不再接受裸数字, 避免又冒出 "序号到底是几" 的歧义.
 */
function formatBotConfigTable(bots: any[]): string {
  if (bots.length === 0) return '';
  const headers = ['进程名', 'App ID', 'CLI'];
  const rows = bots.map((b, i) => [
    botProcessName(b, i, PM2_NAME),
    String(b?.larkAppId ?? ''),
    String(b?.cliId ?? 'claude-code'),
  ]);
  const widths = headers.map((h, c) =>
    Math.max(displayWidth(h), ...rows.map(r => displayWidth(r[c]))),
  );
  const render = (cells: string[]) =>
    '  ' + cells.map((cell, i) => padEndDisplay(cell, widths[i])).join('  ');
  return [render(headers), ...rows.map(render)].join('\n');
}

/**
 * 从 bots 列表交互选择一个机器人，返回下标；取消 / 找不到返回 undefined。
 * TTY 用可搜索选择器；非 TTY 保持旧文本语义（进程名 / AppID——见
 * parseBotSelection 上的注释，刻意不接受裸序号，避免 off-by-one 歧义）。
 */
async function pickBotSelection(
  rl: ReturnType<typeof createInterface>,
  bots: any[],
  title: string,
): Promise<number | undefined> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    const selected = await ask(rl, '选择机器人（进程名 或 AppID）: ');
    return parseBotSelection(selected, bots);
  }
  const idx = await interactiveSelect({
    title,
    items: bots.map((b, i) => ({
      label: botProcessName(b, i, PM2_NAME),
      hint: `${b?.larkAppId ?? ''} · ${b?.cliId ?? 'claude-code'}`,
    })),
    footer: 'Esc 返回操作菜单',
  });
  if (idx === null) return undefined;
  console.log(` ✔ ${title}: ${botProcessName(bots[idx], idx, PM2_NAME)}`);
  return idx;
}

async function promptEditBotConfig(
  rl: ReturnType<typeof createInterface>,
  bot: Record<string, any>,
): Promise<Record<string, any>> {
  console.log('\n字段留空表示保留当前值；可选字段输入 - 表示清空。\n');
  const input: BotConfigEditInput = {};

  printInputHelp('botmux status 显示名称', [
    '可选。用于本机进程名，方便在 botmux status / logs 中识别机器人。',
    '留空保留当前值；输入 - 清空自定义名称并恢复 botmux-<序号>。',
  ]);
  input.name = await ask(rl, `botmux status 显示名称 [${formatOptionalValue(bot.name)}]: `);

  printInputHelp('LARK_APP_ID', [
    '飞书开放平台应用的 App ID。修改后，这个配置项会切到另一个飞书应用。',
    '留空保留当前值；修改会二次确认，因为历史会话和群聊状态不会自动迁移。',
  ]);
  input.larkAppId = await ask(rl, `LARK_APP_ID [${bot.larkAppId}]: `);

  printInputHelp('LARK_APP_SECRET', [
    '当前 App ID 对应的 App Secret。只更新密钥时填写这一项即可。',
    '留空保留当前值。',
  ]);
  input.larkAppSecret = await ask(rl, `LARK_APP_SECRET [保留当前值]: `);

  // CLI 适配器：可搜索的级联选择器（选 Aiden 可进 × Claude / × Codex，aiden 网关）。
  printInputHelp('CLI 适配器', [
    '可搜索的交互式选择：输入关键字过滤、↑/↓ 选择、⏎ 确认、Esc 保留当前值。',
    '选 Aiden 进二级菜单：× Claude / × Codex（aiden 网关，无需 wrapper 脚本）。',
    '非交互终端下回退为「输入序号 / 适配器 ID」。',
  ]);
  const currentKey = selectionKeyForBot(bot.cliId ?? 'claude-code', bot.wrapperCli);
  const selKey = await pickCliSelection(rl, { title: 'CLI 适配器', currentKey });
  if (selKey) {
    try {
      const sel = resolveCliSelection(selKey);
      input.cliChoice = sel.cliId;
      input.wrapperCli = sel.wrapperCli ?? null; // 选普通 CLI 时清掉旧的 aiden×* 前缀
    } catch (err: any) {
      console.log(`\n❌ ${err?.message ?? String(err)}（保留当前 CLI）`);
    }
  }
  // selKey 为 null（Esc / 空）→ input.cliChoice 不设 → 保留当前 CLI。

  printInputHelp('CLI 可执行文件路径覆盖', [
    '可选。CLI 入口的绝对路径，用于在原 CLI 外面套一层 wrapper / router。',
    '典型场景：ccr / claude-w 等自定义入口（aiden × claude/codex 选上面那项即可，无需此项）。',
    '留空保留当前值；输入 - 清空覆盖，回到 PATH 查 cliId 对应的默认二进制。',
  ]);
  input.cliPathOverride = await ask(rl, `CLI 可执行文件路径覆盖 [${formatOptionalValue(bot.cliPathOverride)}]: `);

  // setup 不再询问 model（同 promptBotConfig 的理由）。但切换 CLI 时旧 model
  // 是上一个 CLI 的值，套到新 CLI 上没意义甚至直接 spawn 报错，必须强制清空；
  // 未换 CLI 时 input.model 留 undefined，applyBotConfigEdits 保持原值不动。
  const cliChanged = !!resolveCliId(input.cliChoice) && resolveCliId(input.cliChoice) !== bot.cliId;
  if (cliChanged && bot.model) {
    console.log('\n⚠️  已切换 CLI，原 model 字段已清空（如需指定 model 请用 /config 卡片或编辑 bots.json）。');
    input.model = null;
  }

  printInputHelp('会话后端 backendType', [
    '可选。pty 更轻量；tmux 支持 adopt 和 Web Terminal 附着；herdr 支持托管持久会话；zmx >= 0.7.0 提供纯文本持久会话 + 本机 attach（无 Web TUI）；zellij 为实验后端（需 zellij >= 0.44）。',
    '选择 traex + herdr 时，可在 Dashboard Settings 中开启 TraeX herdr plugin opt-in 并填写可信插件 spec；默认不会自动安装第三方插件。',
    '留空保留当前值；输入 - 回到全局默认（未设置 BACKEND_TYPE 时为 tmux）；接受 pty / tmux / herdr / zellij / zmx。',
  ]);
  input.backendType = await ask(rl, `会话后端 backendType [${formatOptionalValue(bot.backendType)}]: `);

  // 新话题工作目录：模式二选一（与 promptBotConfig 的新建流程同款问法）。
  const currentDirMode = bot.defaultWorkingDir
    ? `固定默认目录: ${bot.defaultWorkingDir}`
    : `仓库选择卡片，扫描根: ${bot.workingDir ?? '~'}`;
  const dirMode = await pickChoice(rl, {
    title: '新话题工作目录',
    items: [
      { label: '保留当前配置', hint: currentDirMode },
      { label: '固定默认目录', hint: '新话题直接在指定目录启动、不弹卡片' },
      { label: '仓库选择卡片', hint: '新话题先弹卡片选 git 仓库；下一问填卡片的扫描根目录' },
    ],
    defaultIndex: 0,
  });
  if (dirMode === 1) {
    printInputHelp('固定默认目录', [
      '新话题直接在此目录启动、不弹仓库选择卡片。',
      '留空保留当前值；输入 - 清空并回到仓库选择卡片模式。',
    ]);
    input.defaultWorkingDir = await ask(rl, `固定默认目录 [${formatOptionalValue(bot.defaultWorkingDir)}]: `);
  } else if (dirMode === 2) {
    printInputHelp('仓库扫描根目录', [
      '仓库选择卡片会列出这些目录下的 git 仓库，支持逗号分隔多个。',
      '留空保留当前值；输入 - 清空并回到默认 ~。',
    ]);
    input.workingDir = await ask(rl, `仓库扫描根目录 [${formatOptionalValue(bot.workingDir)}]: `);
    if (bot.defaultWorkingDir) {
      console.log('   已切回仓库选择卡片模式，原固定默认目录将被清空。');
      input.defaultWorkingDir = '-';
    }
  }

  printInputHelp('允许的用户', [
    '可选。限制哪些飞书用户可以操作机器人，支持完整邮箱（如 alice@example.com）、union_id（on_xxx）、手机号（大陆号直填，海外带 + 区号）或 open_id（ou_xxx），多个值用逗号分隔。',
    '注意：邮箱必须完整，邮箱前缀（如 alice）无法解析、会被丢弃。',
    '留空保留当前值；输入 - 清空限制。',
  ]);
  input.allowedUsers = await ask(rl, `允许的用户 [${formatOptionalValue(bot.allowedUsers)}]: `);

  printInputHelp('可对话群', [
    '可选。在这些群里任何成员都能与机器人对话（按消息所在群判断，新人进群即生效、退群即失权，无需重启）；多个 chat_id 用逗号分隔。',
    '值通常是 oc_xxx；留空保留当前值；输入 - 清空。等价于 owner 在该群发 /grant（不带 @）。',
    '仅授对话权，不授予 /restart、/close、终端写入等敏感操作（那些仍由 allowedUsers 控制）。',
  ]);
  input.allowedChatGroups = await ask(rl, `允许的群聊组 [${formatOptionalValue(bot.allowedChatGroups)}]: `);

  printInputHelp('平台团队页展示 showInTeam', [
    '可选。绑定中心化平台后，是否在团队页（人→机器→bot）展示这个机器人。',
    '默认 true（展示）；填 false 把内部/工具机器人从团队页隐藏。',
    '留空保留当前值；输入 - 恢复默认（展示）。',
  ]);
  input.showInTeam = await ask(rl, `平台团队页展示 showInTeam [${formatBooleanValue(bot.showInTeam, true)}]: `);

  const edited = applyBotConfigEdits(bot, input);
  // 配了 allowedChatGroups 就必须有 owner，否则敏感操作对所有人关闭。抛错由调用方捕获并中止写盘。
  assertOwnerWhenChatGroups(edited);
  if (edited.larkAppId !== bot.larkAppId) {
    console.log('\n⚠️  LARK_APP_ID 变更后，旧 appId 下的历史会话/群聊状态数据不会自动迁移。');
    const confirm = (await ask(rl, `确认将 LARK_APP_ID 从 ${bot.larkAppId} 改为 ${edited.larkAppId}? (y/N): `)).trim().toLowerCase();
    if (confirm !== 'y' && confirm !== 'yes') {
      edited.larkAppId = bot.larkAppId;
    }
  }
  return edited;
}

/** Parse .env file to extract bot config for migration to bots.json */
function parseDotEnvToBotConfig(): Record<string, any> {
  const content = readFileSync(ENV_FILE, 'utf-8');
  const vars: Record<string, string> = {};
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    vars[trimmed.substring(0, eqIdx)] = trimmed.substring(eqIdx + 1);
  }

  const bot: Record<string, any> = {
    larkAppId: vars.LARK_APP_ID || '',
    larkAppSecret: vars.LARK_APP_SECRET || '',
  };
  if (vars.CLI_ID) bot.cliId = vars.CLI_ID;
  if (vars.CLI_PATH?.trim()) bot.cliPathOverride = vars.CLI_PATH.trim();
  if (vars.BACKEND_TYPE) bot.backendType = vars.BACKEND_TYPE;
  if (vars.WORKING_DIR) bot.workingDir = vars.WORKING_DIR;
  if (vars.ALLOWED_USERS) bot.allowedUsers = vars.ALLOWED_USERS.split(',').map((s: string) => s.trim()).filter(Boolean);

  return bot;
}

/**
 * 收集一个机器人配置并写盘 (单机器人 fresh install / 重新配置).
 *
 * 失败路径 (扫码取消 / 凭证校验不通过): 不创建任何配置文件, 不动旧 .env.
 * Codex review 边界 #2: 中途失败一律不留半截 JSON.
 */
async function writeSingleBotConfig(): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const bot = await promptBotConfig(rl);
  rl.close();

  if (!bot) return false;

  writeBotsJsonAtomic([bot]);
  console.log(`\n✅ 配置已写入: ${BOTS_JSON_FILE}`);
  await finishOpenPlatformSetup(bot.larkAppId, botBrand(bot), { reuseOnly: hasSetupWebSession(bot), appJustCreated: wasAppJustCreatedBySetup(bot) });
  console.log(`下一步:`);
  console.log(`  1. botmux start              启动 daemon`);
  console.log(`  2. botmux autostart enable   注册开机自启（推荐：${process.platform === 'darwin' ? 'mac launchd' : process.platform === 'linux' ? 'linux user systemd' : process.platform === 'win32' ? 'Windows Task Scheduler' : '当前平台暂不支持'}，无需 sudo）`);
  return true;
}

// ─── Scripted (non-TUI) setup ────────────────────────────────────────────────

/** 脚本化 setup 统一失败出口：--json 输出结构化错误到 stdout，退出码 1。 */
function failSetupScripted(json: boolean, message: string, details: Record<string, unknown> = {}): void {
  if (json) console.log(JSON.stringify({ ok: false, error: message, ...details }));
  else console.error(`❌ ${message}`);
  process.exitCode = 1;
}

function setupAddContinuationCommand(
  appId: string,
  brand: Brand,
  ownerPlaceholder = '<OWNER_EMAIL>',
): string {
  return `botmux setup add --app-id ${appId} --app-secret <APP_SECRET> ` +
    `--allowed-users ${ownerPlaceholder}${brand === 'lark' ? ' --brand lark' : ''} --open-platform-auto`;
}

/** 某个（可能带 ~ 前缀的）路径若不存在/不是目录，返回展开后的绝对路径；合法返回 null。 */
function missingDirResolved(raw: string): string | null {
  const resolved = resolve(expandHomePath(raw));
  try {
    if (statSync(resolved).isDirectory()) return null;
  } catch { /* not a dir */ }
  return resolved;
}

/** workingDir / workingDirs / defaultWorkingDir 里所有无效目录（脚本化模式一次性报全）。 */
function invalidBotDirs(bot: Record<string, any>): string[] {
  const invalid = [...invalidWorkingDirs(bot)];
  const raw = typeof bot.defaultWorkingDir === 'string' ? bot.defaultWorkingDir.trim() : '';
  if (raw) {
    const missing = missingDirResolved(raw);
    if (missing) invalid.push(missing);
  }
  return invalid;
}

/** list/add/edit 的 JSON 输出视图：bot 条目 + 进程名，secret 脱敏（stdout 可能被贴进聊天/日志）。 */
function botJsonView(bot: Record<string, any>, index: number): Record<string, any> {
  return {
    processName: botProcessName(bot, index, PM2_NAME),
    ...bot,
    larkAppSecret: maskAppSecret(bot?.larkAppSecret),
  };
}

/**
 * `botmux setup list|add|configure|edit|remove` — 脚本化（非 TUI）bot 管理。
 * 给 coding agent / 脚本一个字段级稳定接口，不依赖交互问答顺序（管道喂数字
 * 的老姿势在问题序列变化时会静默错位）。校验口径与 TUI 一致：目录存在性、
 * owner 必填、凭证变更时的 tenant_access_token 校验，任一失败不写盘。
 */
async function cmdSetupScripted(
  argv: string[],
  cloneSource?: Record<string, any>,
): Promise<void> {
  const wantsJson = argv.includes('--json');
  let cmd: SetupCommand;
  try {
    cmd = parseSetupCommand(argv);
  } catch (err: any) {
    failSetupScripted(wantsJson, err?.message ?? String(err));
    return;
  }

  if (cmd.action === 'help') {
    console.log(SETUP_CLI_USAGE);
    return;
  }

  ensureConfigDir();
  const bots = loadBotsJson();

  if (cmd.action === 'list') {
    if (cmd.json) {
      console.log(JSON.stringify(bots.map((b, i) => botJsonView(b, i)), null, 2));
    } else if (bots.length === 0) {
      console.log('尚未配置机器人。运行 botmux setup（交互式）或 botmux setup add 添加。');
    } else {
      console.log(formatBotConfigTable(bots));
      console.log('\n完整字段用 --json 查看（secret 脱敏；明文只在 ~/.botmux/bots.json）。');
    }
    return;
  }

  if (cmd.action === 'configure') {
    const index = parseBotSelection(cmd.selector, bots);
    if (index === undefined) {
      failSetupScripted(cmd.json, `找不到机器人 "${cmd.selector}"（接受进程名 botmux-N 或 AppID，botmux setup list 可查）。`);
      return;
    }
    const bot = bots[index];
    const processName = botProcessName(bot, index, PM2_NAME);
    const openPlatform = await finishOpenPlatformSetup(bot.larkAppId, botBrand(bot), {
      // Machine-readable callers must never be surprised by an interactive QR.
      reuseOnly: cmd.json && !cmd.switchAccount,
      forceQrLogin: cmd.switchAccount,
      quiet: cmd.json,
    });
    if (openPlatform.status === 'failed' || openPlatform.status === 'manual') {
      const continueCommand = setupOpenPlatformRetryCommand(bot.larkAppId, openPlatform);
      const next = continueCommand ?? 'manual_open_platform_setup';
      failSetupScripted(
        cmd.json,
        openPlatform.status === 'manual'
          ? '该租户不支持自动配置，请按开放平台手动步骤完成。'
          : `开放平台自动配置未完成；机器人配置保留，未自动上线。请修复后重试 ${continueCommand}。`,
        {
          partial: true,
          action: 'configure',
          bot: botJsonView(bot, index),
          appId: bot.larkAppId,
          openPlatform: setupOpenPlatformOutcomeJson(openPlatform),
          ...(continueCommand ? { continueCommand } : {}),
          next,
        },
      );
      return;
    }
    const live = await ensureBotDaemonStarted(bot.larkAppId, { quiet: cmd.json });
    const next = live.ok ? 'live' : (live.reason === 'fleet_down' ? 'botmux start' : 'botmux restart');
    if (cmd.json) {
      console.log(JSON.stringify({
        ok: true,
        action: 'configure',
        bot: botJsonView(bot, index),
        appId: bot.larkAppId,
        openPlatform: setupOpenPlatformOutcomeJson(openPlatform),
        live,
        next,
      }, null, 2));
    } else {
      console.log(`✅ 已完成 ${processName} (${bot.larkAppId}) 的开放平台配置`);
      if (live.ok) console.log(`✅ 已自动上线（${live.processName}）`);
      else if (live.reason === 'fleet_down') console.log('下一步: botmux start（daemon 尚未运行）');
      else console.log(`⚠️  自动上线失败（${live.message}）。下一步: botmux restart`);
    }
    return;
  }

  if (cmd.action === 'add') {
    // 单机器人 .env 老配置：与 TUI「添加新机器人」一致，先迁移进 bots.json 再追加。
    let existing = bots;
    let migratedEnv = false;
    let createdAppId: string | undefined;
    let createdAppName: string | undefined;
    const requestedBrand = normalizeBrand(cmd.flags.brand);
    if (!existsSync(BOTS_JSON_FILE) && existsSync(ENV_FILE)) {
      const legacy = parseDotEnvToBotConfig();
      if (legacy.larkAppId && legacy.larkAppSecret) {
        existing = [legacy];
        migratedEnv = true;
      }
    }

    // A managed Agent sees the daemon-frozen session owner as
    // BOTMUX_OWNER_OPEN_ID in the source bot's app scope; it is not the
    // current-turn sender. Copying that ou_ into a newly created/different app
    // locks the owner out. Convert only that exact injected identity to on_
    // through the source app before any real app is created.
    try {
      cmd.flags.allowedUsers = await normalizeManagedOwnerEntries(
        cmd.flags.allowedUsers,
        {
          sourceAppId: process.env.BOTMUX_LARK_APP_ID,
          sourceOwnerOpenId: process.env.BOTMUX_OWNER_OPEN_ID ?? process.env.__OWNER_OPEN_ID,
          creatingApp: cmd.createApp,
          targetAppId: cmd.createApp ? undefined : cmd.flags.appId?.trim(),
        },
        async (sourceAppId, sourceOwnerOpenId) => {
          const sourceBot = existing.find(bot => bot?.larkAppId === sourceAppId);
          if (!sourceBot?.larkAppSecret) return undefined;
          // A deliberate account/platform switch may create under another
          // developer tenant, where the source app's union_id is not stable.
          // Require an explicit target-account identity before creating.
          if (cmd.switchAccount || cmd.compatibilityMode || botBrand(sourceBot) !== requestedBrand) {
            return undefined;
          }
          return resolveScannerAllowedUser(
            sourceAppId,
            sourceBot.larkAppSecret,
            sourceOwnerOpenId,
            botBrand(sourceBot),
          );
        },
      );
    } catch (err) {
      failSetupScripted(cmd.json, `${err instanceof Error ? err.message : String(err)} 未创建应用、未写入配置。`);
      return;
    }

    // --create-app 会产生真实开放平台应用；先用占位凭证完成纯本地字段、owner、
    // CLI 与目录预检，避免参数错误发生在扫码建应用之后而留下孤儿应用。
    if (cmd.createApp) {
      let preflight: Record<string, any>;
      try {
        preflight = buildBotFromAddFlags({
          ...cmd.flags,
          appId: 'cli_preflight',
          appSecret: 'preflight-only',
        });
      } catch (err: any) {
        failSetupScripted(cmd.json, err?.message ?? String(err));
        return;
      }
      const preflightBadDirs = invalidBotDirs(preflight);
      if (preflightBadDirs.length > 0) {
        failSetupScripted(cmd.json, `目录不存在或不是目录: ${preflightBadDirs.join(', ')}。请先创建，未创建应用。`);
        return;
      }
      const preflightCli = checkCliAvailability({
        cliId: preflight.cliId ?? 'claude-code',
        cliPathOverride: preflight.cliPathOverride,
        wrapperCli: preflight.wrapperCli,
      });
      if (!preflightCli.available) {
        failSetupScripted(
          cmd.json,
          `所选 Agent 当前无法启动：${preflightCli.reason ?? '本地启动依赖不可用'}。请先安装或修正 PATH / CLI 路径，未创建应用。`,
        );
        return;
      }

      const appName = resolveSetupAppName(cmd.flags.appName, existing.length);
      let credentials:
        | { ok: true; appId: string; appSecret: string; brand: Brand }
        | { ok: false; message: string; appId?: string };
      let appliedAppName = false;

      if ((requestedBrand === 'lark' || cmd.compatibilityMode) && cmd.flags.appName?.trim()) {
        failSetupScripted(cmd.json, 'Lark / SDK 兼容模式不支持 --app-name；请移除该参数，应用名称将由平台决定。');
        return;
      }
      if (requestedBrand === 'lark' && cmd.switchAccount) {
        failSetupScripted(cmd.json, '--switch-account 仅适用于 Feishu Web 创建路径，不适用于 Lark SDK 兼容模式。');
        return;
      }

      if (requestedBrand === 'lark' || cmd.compatibilityMode) {
        if (!cmd.json) console.log('⚠️  正在使用 SDK 兼容模式，可能需要额外扫码；应用名称由平台决定。');
        const { tryRegisterApp } = await import('./setup/register-app.js');
        const registered = await tryRegisterApp();
        credentials = registered.ok
          ? registered
          : { ok: false, message: `SDK 扫码失败 (${registered.error}): ${registered.message}` };
      } else {
        const {
          createFeishuOpenPlatformApp,
          inspectCachedFeishuOpenPlatformSession,
          readStoredCookiesFromSessionFile,
          botmuxFeishuSessionFilePath,
        } = await import('./setup/open-platform-automation.js');
        const inspected = cmd.switchAccount ? null : await inspectCachedFeishuOpenPlatformSession();
        const hadCachedSession = (readStoredCookiesFromSessionFile(botmuxFeishuSessionFilePath())?.length ?? 0) > 0;
        if (!cmd.switchAccount && inspected && !inspected.ok && (cmd.json || hadCachedSession)) {
          credentials = {
            ok: false,
            message: cmd.json && !hadCachedSession
              ? '没有可复用的飞书登录态；--json 模式不会弹出二维码。请显式加 --switch-account 扫码登录。'
              : `飞书登录态已失效或无法确认账号 (${inspected.reason})；未静默弹出二维码。请显式加 --switch-account 重新扫码。`,
          };
        } else {
          const sessionOptions = inspected?.ok
            ? {
                disableQrLogin: true as const,
                expectedIdentity: {
                  userId: inspected.identity.userId,
                  tenantId: inspected.identity.tenantId,
                },
              }
            : { forceQrLogin: true as const };
          const created = await createFeishuOpenPlatformApp({
            name: appName,
            ...sessionOptions,
            disableBytedcliFallback: true,
            onSessionReady: ({ identity, source }) => {
              process.stderr.write(`已确认飞书账号：${identity.userName} · ${identity.tenantName}${source === 'botmux_cache' ? '（免扫码）' : ''}\n`);
            },
          });
          if (created.ok) {
            credentials = created;
            appliedAppName = true;
          } else if (created.appId) {
            credentials = {
              ok: false,
              appId: created.appId,
              message: `应用已创建但后续步骤失败 (${created.reason}): ${created.message}`,
            };
          } else {
            credentials = {
              ok: false,
              message: `一次扫码创建失败 (${created.reason}): ${created.message}。可重试，或显式加 --compatibility-mode 使用可能需要额外扫码的兼容模式。`,
            };
          }
        }
      }

      if (!credentials.ok) {
        const continueCommand = credentials.appId
          ? setupAddContinuationCommand(credentials.appId, requestedBrand)
          : undefined;
        failSetupScripted(cmd.json,
          `${credentials.message}${credentials.appId ? `；已创建 AppID ${credentials.appId}，请从开放平台读取 App Secret 后运行 ${continueCommand} 继续，未重复创建。` : ''}`,
          credentials.appId ? { partial: true, appId: credentials.appId, appName, continueCommand } : {},
        );
        return;
      }
      cmd.flags.appId = credentials.appId;
      cmd.flags.appSecret = credentials.appSecret;
      cmd.flags.brand = credentials.brand;
      createdAppId = credentials.appId;
      createdAppName = appliedAppName ? appName : undefined;
      if (!cmd.json) {
        console.log(`✅ 已创建${credentials.brand === 'lark' ? ' Lark' : '飞书'}应用${appliedAppName ? ` ${appName}` : ''} (${credentials.appId})，继续校验并写入 bot 配置。`);
      }
    }

    let bot: Record<string, any>;
    try {
      bot = buildBotFromAddFlags(cmd.flags);
    } catch (err: any) {
      failSetupScripted(cmd.json, err?.message ?? String(err));
      return;
    }
    if (cloneSource) {
      bot = cloneBotConfig(cloneSource, bot);
    }

    if (existing.some(b => b?.larkAppId === bot.larkAppId)) {
      failSetupScripted(cmd.json, `AppID ${bot.larkAppId} 已存在，修改请用 botmux setup edit ${bot.larkAppId}。`);
      return;
    }
    const badDirs = invalidBotDirs(bot);
    if (badDirs.length > 0) {
      failSetupScripted(cmd.json, `目录不存在或不是目录: ${badDirs.join(', ')}。请先创建，未写入配置。`);
      return;
    }
    const cliAvailability = checkCliAvailability({
      cliId: bot.cliId ?? 'claude-code',
      cliPathOverride: bot.cliPathOverride,
      wrapperCli: bot.wrapperCli,
    });
    if (!cliAvailability.available) {
      failSetupScripted(
        cmd.json,
        `所选 Agent 当前无法启动：${cliAvailability.reason ?? '本地启动依赖不可用'}。请先安装或修正 PATH / CLI 路径，未写入配置。`,
      );
      return;
    }

    // 凭证校验与 TUI 同口径：换不到 tenant_access_token 一律不写盘。
    const { validateCredentials } = await import('./setup/verify-permissions.js');
    const v = await validateCredentials(bot.larkAppId, bot.larkAppSecret, botBrand(bot));
    if (!v.ok) {
      const continueCommand = createdAppId
        ? setupAddContinuationCommand(createdAppId, botBrand(bot))
        : undefined;
      failSetupScripted(
        cmd.json,
        `凭证校验失败 (${v.error}): ${v.message}${createdAppId ? `；应用 ${createdAppId} 已创建，未重复创建。请运行 ${continueCommand} 继续。` : ''}`,
        createdAppId ? { partial: true, appId: createdAppId, ...(createdAppName ? { appName: createdAppName } : {}), continueCommand } : {},
      );
      return;
    }

    // Scripted add historically accepted any syntactically valid ou_ and wrote
    // it verbatim. A source bot's open_id is syntactically valid but belongs to
    // the wrong app, so canTalk/canOperate can never match it in the new bot.
    // Match Dashboard onboarding: reject only identities the target app can
    // definitively prove unusable; transient/scope failures remain inconclusive.
    const unusableOwners = await detectUnusableOwnerEntries(
      bot.larkAppId,
      bot.larkAppSecret,
      botBrand(bot),
      bot.allowedUsers ?? [],
    );
    if (unusableOwners.length > 0) {
      const continueCommand = createdAppId
        ? setupAddContinuationCommand(createdAppId, botBrand(bot), '<OWNER_EMAIL_OR_UNION_ID>')
        : undefined;
      failSetupScripted(
        cmd.json,
        `--allowed-users 包含当前应用无法使用的 owner: ${unusableOwners.join(', ')}。` +
          `open_id 仅对签发它的 Bot 有效，请改用完整邮箱、手机号或 on_ union_id。` +
          (continueCommand ? ` 应用已创建但未写入配置；请运行 ${continueCommand} 继续。` : ' 未写入配置。'),
        createdAppId
          ? {
              partial: true,
              appId: createdAppId,
              ...(createdAppName ? { appName: createdAppName } : {}),
              continueCommand,
            }
          : {},
      );
      return;
    }

    try {
      writeBotsJsonAtomic([...existing, bot]);
    } catch (err) {
      const continueCommand = createdAppId
        ? setupAddContinuationCommand(createdAppId, botBrand(bot))
        : undefined;
      failSetupScripted(
        cmd.json,
        `写入 bot 配置失败: ${err instanceof Error ? err.message : String(err)}${createdAppId ? `；应用 ${createdAppId} 已创建，未重复创建。请运行 ${continueCommand} 继续。` : ''}`,
        createdAppId ? { partial: true, appId: createdAppId, ...(createdAppName ? { appName: createdAppName } : {}), continueCommand } : {},
      );
      return;
    }
    if (migratedEnv) {
      try {
        renameSync(ENV_FILE, ENV_FILE + '.bak');
      } catch (err) {
        // bots.json is already durable and takes precedence over legacy .env.
        // Do not report a partial app failure that would encourage a duplicate;
        // leave the old file in place and surface a cleanup warning only.
        if (!cmd.json) console.error(`⚠️  bots.json 已写入，但旧 .env 备份失败: ${err instanceof Error ? err.message : String(err)}`);
        migratedEnv = false;
      }
    }

    // 已有凭证模式默认跳过；--create-app 默认开启并复用刚才的 Web session。
    let openPlatform: SetupOpenPlatformOutcome = { status: 'skipped' };
    if (cmd.openPlatformAuto) {
      openPlatform = await finishOpenPlatformSetup(bot.larkAppId, botBrand(bot), {
        reuseOnly: scriptedSetupOpenPlatformReuseOnly({
          json: cmd.json,
          createApp: cmd.createApp,
          compatibilityMode: cmd.compatibilityMode,
          brand: botBrand(bot),
        }),
        quiet: cmd.json,
        // 只认「本次命令确实创建出了这个 appId」这一条硬证据：--app-id/--app-secret
        // 直接传进来的存量应用绝不能拿到盲写授权。
        appJustCreated: createdAppId !== undefined && createdAppId === bot.larkAppId,
      });
    }

    const index = existing.length;
    if (blocksSetupBotStart(openPlatform)) {
      const continueCommand = setupOpenPlatformRetryCommand(bot.larkAppId, openPlatform)!;
      failSetupScripted(
        cmd.json,
        `机器人配置已写入，但开放平台自动配置未完成，未自动上线。修复后运行 ${continueCommand}；不会重复创建应用。`,
        {
          partial: true,
          action: 'add',
          bot: botJsonView(bot, index),
          appId: bot.larkAppId,
          ...(createdAppName ? { appName: createdAppName } : {}),
          botsFile: BOTS_JSON_FILE,
          envMigrated: migratedEnv || undefined,
          openPlatform: setupOpenPlatformOutcomeJson(openPlatform),
          continueCommand,
          live: {
            ok: false,
            reason: 'open_platform_incomplete',
            message: '开放平台关键配置未完成，未启动新机器人',
          },
          next: continueCommand,
        },
      );
      return;
    }
    // daemon 在跑就直接把新 bot 那一个进程拉起来，免整组 botmux restart。
    const live = await ensureBotDaemonStarted(bot.larkAppId, { quiet: cmd.json });
    const next = live.ok ? 'live' : (live.reason === 'fleet_down' ? 'botmux start' : 'botmux restart');
    if (cmd.json) {
      console.log(JSON.stringify({
        ok: true,
        action: 'add',
        bot: botJsonView(bot, index),
        appId: bot.larkAppId,
        ...(cmd.createApp && botBrand(bot) === 'feishu' && !cmd.compatibilityMode ? { appName: resolveSetupAppName(cmd.flags.appName, index) } : {}),
        botsFile: BOTS_JSON_FILE,
        envMigrated: migratedEnv || undefined,
        openPlatform: setupOpenPlatformOutcomeJson(openPlatform),
        live,
        next,
      }, null, 2));
    } else {
      console.log(`✅ 已添加机器人 ${botProcessName(bot, index, PM2_NAME)} (${bot.larkAppId})，共 ${index + 1} 个`);
      console.log(`   配置文件: ${BOTS_JSON_FILE}`);
      if (migratedEnv) console.log(`   旧 .env 已迁移并备份: ${ENV_FILE}.bak`);
      if (!cmd.openPlatformAuto) {
        console.log('   已跳过开放平台自动配置（权限导入/发版）。需要时加 --open-platform-auto（要扫码），或运行交互式 botmux setup。');
      }
      if (live.ok) {
        console.log(`✅ 已自动上线（${live.processName}），无需重启其它机器人。`);
      } else if (live.reason === 'fleet_down') {
        console.log('下一步: botmux start（daemon 尚未运行）');
      } else {
        console.log(`⚠️  自动上线失败（${live.message}）。下一步: botmux restart`);
      }
    }
    return;
  }

  if (cmd.action === 'edit') {
    const index = parseBotSelection(cmd.selector, bots);
    if (index === undefined) {
      failSetupScripted(cmd.json, `找不到机器人 "${cmd.selector}"（接受进程名 botmux-N 或 AppID，botmux setup list 可查）。`);
      return;
    }
    const original = bots[index];

    let edited: Record<string, any>;
    let modelCleared = false;
    try {
      const input = editInputFromFlags(cmd.flags);
      if (Object.keys(input).length === 0) {
        throw new Error('edit 至少需要一个字段参数（如 --cli codex）。查看用法：botmux setup help');
      }
      // 切换 CLI 强制清空旧 model（与 TUI 同理：旧值属于上一个 CLI，套用会 spawn 报错）。
      const nextCliId = input.cliChoice ? resolveCliId(input.cliChoice) : undefined;
      if (nextCliId && nextCliId !== (original.cliId ?? 'claude-code') && original.model && input.model === undefined) {
        input.model = null;
        modelCleared = true;
      }
      edited = applyBotConfigEdits(original, input);
      assertOwnerWhenChatGroups(edited);
    } catch (err: any) {
      failSetupScripted(cmd.json, err?.message ?? String(err));
      return;
    }

    const badDirs = invalidBotDirs(edited);
    if (badDirs.length > 0) {
      failSetupScripted(cmd.json, `目录不存在或不是目录: ${badDirs.join(', ')}。配置未修改。`);
      return;
    }
    const agentLaunchChanged = hasAgentLaunchConfigChanged(
      {
        cliId: original.cliId ?? 'claude-code',
        cliPathOverride: original.cliPathOverride,
        wrapperCli: original.wrapperCli,
      },
      {
        cliId: edited.cliId ?? 'claude-code',
        cliPathOverride: edited.cliPathOverride,
        wrapperCli: edited.wrapperCli,
      },
    );
    // Missing Agent dependencies must block introducing a broken launch
    // configuration, but should not prevent an operator from rotating a secret
    // or repairing an unrelated directory on an already-misconfigured bot.
    if (agentLaunchChanged) {
      const cliAvailability = checkCliAvailability({
        cliId: edited.cliId ?? 'claude-code',
        cliPathOverride: edited.cliPathOverride,
        wrapperCli: edited.wrapperCli,
      });
      if (!cliAvailability.available) {
        failSetupScripted(
          cmd.json,
          `所选 Agent 当前无法启动：${cliAvailability.reason ?? '本地启动依赖不可用'}。请先安装或修正 PATH / CLI 路径，配置未修改。`,
        );
        return;
      }
    }

    const appIdChanged = edited.larkAppId !== original.larkAppId;
    if (appIdChanged && bots.some((b, i) => i !== index && b?.larkAppId === edited.larkAppId)) {
      failSetupScripted(cmd.json, `AppID ${edited.larkAppId} 已被另一个机器人使用，配置未修改。`);
      return;
    }
    if (appIdChanged || edited.larkAppSecret !== original.larkAppSecret) {
      const { validateCredentials } = await import('./setup/verify-permissions.js');
      const v = await validateCredentials(edited.larkAppId, edited.larkAppSecret, botBrand(edited));
      if (!v.ok) {
        failSetupScripted(cmd.json, `凭证校验失败 (${v.error}): ${v.message}。配置未修改。`);
        return;
      }
    }

    const nextBots = bots.slice();
    nextBots[index] = edited;
    copyFileSync(BOTS_JSON_FILE, BOTS_JSON_FILE + '.bak');
    writeBotsJsonAtomic(nextBots);

    const changed = [...new Set([...Object.keys(original), ...Object.keys(edited)])]
      .filter(k => JSON.stringify(original[k]) !== JSON.stringify(edited[k]));
    if (cmd.json) {
      console.log(JSON.stringify({
        ok: true,
        action: 'edit',
        bot: botJsonView(edited, index),
        changed,
        modelCleared: modelCleared || undefined,
        backup: BOTS_JSON_FILE + '.bak',
        next: 'botmux restart',
      }, null, 2));
    } else {
      console.log(`✅ 已更新机器人 ${botProcessName(edited, index, PM2_NAME)} (${edited.larkAppId})`);
      console.log(`   变更字段: ${changed.join(', ') || '（无实际变化）'}`);
      if (modelCleared) console.log('   ⚠️ 已切换 CLI，原 model 字段已清空（需要时用 --model 或 /config 重设）。');
      if (appIdChanged) console.log('   ⚠️ LARK_APP_ID 已变更：历史会话/群聊状态不迁移，新应用可能需重新配置开放平台权限。');
      console.log(`   旧配置已备份: ${BOTS_JSON_FILE}.bak`);
      console.log('下一步: botmux restart');
    }
    return;
  }

  // remove
  if (!cmd.yes) {
    failSetupScripted(cmd.json, '非交互删除需要显式 --yes 确认。');
    return;
  }
  const result = removeBotConfig(bots, cmd.selector);
  if (!result) {
    failSetupScripted(cmd.json, `找不到机器人 "${cmd.selector}"（接受进程名 botmux-N 或 AppID，botmux setup list 可查）。`);
    return;
  }
  copyFileSync(BOTS_JSON_FILE, BOTS_JSON_FILE + '.bak');
  writeBotsJsonAtomic(result.bots);
  if (cmd.json) {
    console.log(JSON.stringify({
      ok: true,
      action: 'remove',
      removed: botJsonView(result.removed, result.index),
      remaining: result.bots.length,
      backup: BOTS_JSON_FILE + '.bak',
      next: 'botmux restart',
    }, null, 2));
  } else {
    console.log(`✅ 已删除机器人 ${botProcessName(result.removed, result.index, PM2_NAME)} (${result.removed.larkAppId})，剩余 ${result.bots.length} 个`);
    console.log(`   旧配置已备份: ${BOTS_JSON_FILE}.bak`);
    console.log('下一步: botmux restart');
  }
}

async function cmdClone(argv: string[]): Promise<void> {
  const [sourceSelector, nameFlag, requestedName] = argv;
  if (
    !sourceSelector
    || (argv.length !== 1 && (argv.length !== 3 || nameFlag !== '--name' || !requestedName?.trim()))
  ) {
    console.error('用法: botmux clone <进程名|配置名|AppID> [--name <新名称>]');
    process.exitCode = 1;
    return;
  }
  const bots = loadBotsJson();
  const sourceIndex = parseBotSelection(sourceSelector, bots);
  if (sourceIndex === undefined) {
    console.error(`找不到机器人 "${sourceSelector}"。`);
    process.exitCode = 1;
    return;
  }
  const source = bots[sourceIndex];
  const owners = cloneOwnerEntries(
    source,
    process.env.BOTMUX_LARK_APP_ID,
    process.env.BOTMUX_OWNER_OPEN_ID ?? process.env.__OWNER_OPEN_ID,
  );
  if (!hasOwnerEntry(owners)) {
    console.error('源机器人没有可跨应用复用的 owner（邮箱、手机号、on_ union_id，或当前会话已认证的 owner）。');
    process.exitCode = 1;
    return;
  }
  const addArgs = ['add', '--create-app', '--allowed-users', owners.join(',')];
  if (botBrand(source) === 'lark') {
    if (requestedName) {
      console.error('Lark SDK 创建路径暂不支持自定义应用名称。');
      process.exitCode = 1;
      return;
    }
    addArgs.push('--brand', 'lark');
  } else {
    const sourceName = typeof source.displayName === 'string' && source.displayName.trim()
      ? source.displayName.trim()
      : botProcessName(source, sourceIndex);
    addArgs.push('--app-name', resolveCloneAppName(requestedName, sourceName));
  }
  await cmdSetupScripted(addArgs, source);
}

// ─── Commands ────────────────────────────────────────────────────────────────

async function cmdSetup(): Promise<void> {
  ensureConfigDir();

  const hasBots = existsSync(BOTS_JSON_FILE);
  const hasEnv = existsSync(ENV_FILE);

  console.log('\n🤖 botmux 配置向导\n');
  console.log(`配置目录: ${CONFIG_DIR}`);
  console.log(`数据目录: ${DATA_DIR}\n`);

  if (hasBots) {
    // --- Multi-bot mode (bots.json exists) ---
    const bots = loadBotsJson();
    console.log(`已配置 ${bots.length} 个机器人：\n`);
    console.log(formatBotConfigTable(bots));
    console.log('');

    const rl = createInterface({ input: process.stdin, output: process.stdout });
    // 交互模式下子界面（选机器人）Esc = 返回本操作菜单；非 TTY 无 Esc，保持
    // 「无效选择即报错退出」旧语义，避免管道输入在循环里打转。
    const interactiveMenus = process.stdin.isTTY && process.stdout.isTTY;
    for (;;) {
    const action = await pickChoice(rl, {
      title: '操作',
      items: [
        { label: '添加新机器人' },
        { label: '编辑现有机器人' },
        { label: '删除机器人' },
        // 「重新配置」= 丢弃全部现有配置重建，低频且有破坏性，压轴放最后。
        { label: '重新配置', hint: '丢弃现有配置，重建为单机器人配置' },
      ],
      defaultIndex: 0,
      footer: 'Esc 退出',
    });
    if (action === null) {
      rl.close();
      console.log('\n已取消。');
      return;
    }

    if (action === 3) {
      console.log('\n── 重新配置 ──\n');
      const newBot = await promptBotConfig(rl);
      rl.close();
      if (!newBot) {
        console.log('\n⚠️  setup 中止，旧配置保留不动。');
        return;
      }
      // Codex review #1: 先 copyFileSync 备份, 再原子写新文件. 之前先 rename
      // 旧文件再 write, 一旦 write 失败 (磁盘/权限/进程被 kill) 用户就丢了
      // bots.json. copy 之后写失败旧文件原地不动, .bak 是无害的同名副本.
      copyFileSync(BOTS_JSON_FILE, BOTS_JSON_FILE + '.bak');
      console.log(`旧配置已备份: ${BOTS_JSON_FILE}.bak`);
      writeBotsJsonAtomic([newBot]);
      console.log(`✅ 配置已写入: ${BOTS_JSON_FILE}`);
      await finishOpenPlatformSetup(newBot.larkAppId, botBrand(newBot), { reuseOnly: hasSetupWebSession(newBot), appJustCreated: wasAppJustCreatedBySetup(newBot) });
      console.log(`下一步: botmux restart\n`);
      return;
    }

    if (action === 1) {
      console.log('\n── 编辑现有机器人 ──\n');
      const index = await pickBotSelection(rl, bots, '选择要编辑的机器人');
      if (index === undefined) {
        if (interactiveMenus) {
          console.log('   已返回操作菜单。\n');
          continue;
        }
        rl.close();
        console.log('\n❌ 未选择机器人，配置未修改。');
        return;
      }

      const original = bots[index];
      let edited: Record<string, any>;
      try {
        edited = await promptEditBotConfig(rl, original);
      } catch (err: any) {
        rl.close();
        console.log(`\n❌ 编辑失败: ${err?.message ?? String(err)}`);
        return;
      }
      if (!ensureBotWorkingDirsExist(edited, '仓库扫描根目录') || !ensureBotDefaultWorkingDirExists(edited)) {
        rl.close();
        console.log('   配置未修改。');
        return;
      }
      const cliAvailability = checkCliAvailability({
        cliId: edited.cliId ?? 'claude-code',
        cliPathOverride: edited.cliPathOverride,
        wrapperCli: edited.wrapperCli,
      });
      if (!cliAvailability.available) {
        console.log(`\n⚠️  所选 Agent 当前无法启动：${cliAvailability.reason ?? '本地启动依赖不可用'}`);
        console.log('   配置仍会保存；请在 daemon 所在机器安装或修正 PATH / CLI 路径后再启动新会话。\n');
      }

      // 凭证字段有变化时, 像 promptBotConfig 一样跑一次 tenant_access_token
      // 校验. 失败不写盘——避免编辑后 typo 一个字符, daemon 重启时才发现.
      // (cmdRestart 不校验凭证, 只 cmdStart 校验, 所以编辑路径必须自己兜.)
      const appIdChanged = edited.larkAppId !== original.larkAppId;
      const appSecretChanged = edited.larkAppSecret !== original.larkAppSecret;
      if (appIdChanged || appSecretChanged) {
        console.log('\n校验新凭证（取 tenant_access_token）…');
        const { validateCredentials } = await import('./setup/verify-permissions.js');
        const v = await validateCredentials(edited.larkAppId, edited.larkAppSecret, botBrand(edited));
        if (!v.ok) {
          rl.close();
          console.log(`\n❌ 凭证校验失败 (${v.error}): ${v.message}`);
          console.log('   配置未修改。请重新运行 botmux setup → 编辑现有机器人。');
          return;
        }
        console.log('✅ 凭证有效\n');
      }
      rl.close();

      const nextBots = bots.slice();
      nextBots[index] = edited;
      copyFileSync(BOTS_JSON_FILE, BOTS_JSON_FILE + '.bak');
      console.log(`旧配置已备份: ${BOTS_JSON_FILE}.bak`);
      writeBotsJsonAtomic(nextBots);
      console.log(`✅ 已更新机器人 ${botProcessName(edited, index, PM2_NAME)} (${edited.larkAppId})`);
      // appId 切换 = 换了一个飞书应用, 新 appId 大概率需要重新申请权限 + 配重定向 URL.
      // 把 printRemainingSteps 的深链端给用户, 比 README 警告里那句"历史数据不迁移"更可操作.
      if (appIdChanged) {
        await finishOpenPlatformSetup(edited.larkAppId, botBrand(edited));
      }
      console.log(`下一步: botmux restart\n`);
      return;
    }

    if (action === 2) {
      console.log('\n── 删除机器人 ──\n');
      const delIndex = await pickBotSelection(rl, bots, '选择要删除的机器人');
      if (delIndex === undefined) {
        if (interactiveMenus) {
          console.log('   已返回操作菜单。\n');
          continue;
        }
        rl.close();
        console.log('\n❌ 未选择机器人，配置未修改。');
        return;
      }
      const nextBots = bots.slice();
      const [removed] = nextBots.splice(delIndex, 1);
      const confirm = (await ask(
        rl,
        `确认删除 ${botProcessName(removed, delIndex, PM2_NAME)} (${removed.larkAppId})? (y/N): `,
      )).trim().toLowerCase();
      rl.close();
      if (confirm !== 'y' && confirm !== 'yes') {
        console.log('\n已取消，配置未修改。');
        return;
      }

      copyFileSync(BOTS_JSON_FILE, BOTS_JSON_FILE + '.bak');
      console.log(`旧配置已备份: ${BOTS_JSON_FILE}.bak`);
      writeBotsJsonAtomic(nextBots);
      console.log(`✅ 已删除机器人 ${botProcessName(removed, delIndex, PM2_NAME)} (${removed.larkAppId})`);
      console.log(`下一步: botmux restart\n`);
      return;
    }

    console.log('\n── 添加新机器人 ──\n');
    const newBot = await promptBotConfig(rl);
    rl.close();
    if (!newBot) {
      console.log('\n⚠️  setup 中止，bots.json 不动。');
      return;
    }
    writeBotsJsonAtomic([...bots, newBot]);
    console.log(`\n✅ 已添加机器人 ${newBot.larkAppId}，共 ${bots.length + 1} 个`);
    console.log(`   配置文件: ${BOTS_JSON_FILE}`);
    await finishOpenPlatformSetup(newBot.larkAppId, botBrand(newBot), { reuseOnly: hasSetupWebSession(newBot), appJustCreated: wasAppJustCreatedBySetup(newBot) });
    await printAddBotLiveHint(newBot.larkAppId);
    return;
    }

  } else if (hasEnv) {
    // --- Single-bot mode (.env exists) ---
    console.log(`当前使用单机器人配置: ${ENV_FILE}`);
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const action = await pickChoice(rl, {
      title: '操作',
      items: [
        { label: '添加新机器人', hint: '迁移 .env 到 bots.json 多机器人配置' },
        { label: '覆盖当前配置' },
      ],
      defaultIndex: 0,
      footer: 'Esc 退出',
    });
    if (action === null) {
      rl.close();
      console.log('\n已取消。');
      return;
    }

    if (action === 1) {
      rl.close();
      const ok = await writeSingleBotConfig();
      if (ok) {
        renameSync(ENV_FILE, ENV_FILE + '.bak');
        console.log(`   旧 .env 已备份: ${ENV_FILE}.bak`);
      }
      return;
    }

    // Migrate .env → bots.json
    const existingBot = parseDotEnvToBotConfig();
    if (!existingBot.larkAppId || !existingBot.larkAppSecret) {
      console.log('\n⚠️  当前 .env 缺少 LARK_APP_ID 或 LARK_APP_SECRET，请先完成基础配置');
      rl.close();
      await writeSingleBotConfig();
      return;
    }
    console.log(`\n当前机器人: ${existingBot.larkAppId} (${existingBot.cliId ?? 'claude-code'})`);
    console.log('\n── 添加新机器人 ──\n');
    const newBot = await promptBotConfig(rl);
    rl.close();
    if (!newBot) {
      console.log('\n⚠️  setup 中止，.env 和 bots.json 都不动。');
      return;
    }

    // 写新文件成功后才备份 .env. 失败不动两边.
    writeBotsJsonAtomic([existingBot, newBot]);
    renameSync(ENV_FILE, ENV_FILE + '.bak');
    console.log(`\n✅ 已迁移到多机器人配置`);
    console.log(`   配置文件: ${BOTS_JSON_FILE}`);
    console.log(`   旧配置已备份: ${ENV_FILE}.bak`);
    await finishOpenPlatformSetup(newBot.larkAppId, botBrand(newBot), { reuseOnly: hasSetupWebSession(newBot), appJustCreated: wasAppJustCreatedBySetup(newBot) });
    await printAddBotLiveHint(newBot.larkAppId);

  } else {
    // --- Fresh install ---
    await writeSingleBotConfig();
  }
}

/**
 * Pre-flight check for stale Node interpreters.
 *
 * Failure mode: user installs botmux globally under nvm Node vX, later
 * uninstalls that version. The pm2 god daemon may still be alive with a
 * dead execPath (kept in-memory but removed from disk), and this package
 * lives under a node_modules dir whose Node binary no longer exists.
 * Both cases cause `spawn … node ENOENT` loops when pm2 tries to fork
 * the daemon, but the error gets buried in pm2 logs and the user sees
 * silence.
 *
 * Detects: this package is installed under an nvm Node version that no longer
 * exists on disk → abort with reinstall instructions (the supervisor forks
 * workers via process.execPath, which would ENOENT under a removed Node).
 */
function preflightNodeSanity(): void {
  // botmux installed under a dead nvm Node version → fork/spawn would ENOENT.
  const nvmMatch = PKG_ROOT.match(/\/\.nvm\/versions\/node\/([^/]+)\//);
  if (nvmMatch) {
    const installedVersion = nvmMatch[1];
    const installedNodeBin = PKG_ROOT.slice(0, PKG_ROOT.indexOf(installedVersion) + installedVersion.length) + '/bin/node';
    if (!existsSync(installedNodeBin)) {
      console.error(`❌ botmux 安装在 Node ${installedVersion}, 但该 Node 二进制已不存在:`);
      console.error(`     ${installedNodeBin}`);
      console.error(`   daemon 启动后 fork worker 时会报 ENOENT, 无法正常工作。`);
      console.error(``);
      console.error(`   请在当前可用的 Node 下重新全局安装 botmux:`);
      console.error(`     npm i -g botmux`);
      console.error(``);
      console.error(`   验证重装后路径不再指向 ${installedVersion}:`);
      console.error(`     readlink -f $(which botmux)`);
      process.exit(1);
    }
  }
}

async function cmdStart(): Promise<void> {
  // FIRST STATEMENT, before any await or dependency probe: those run as child
  // processes and would inherit the marker. See consumeAutostartUnitMarker.
  const bootHookStart = consumeAutostartUnitMarker();
  // `--systemd-service` and the PM2-God ownership gating that used to live here
  // are gone with pm2 itself: the built-in supervisor owns single-owner exclusion
  // via fleet-state (pid + kill-0 under the fleet mutation lock), so there is no
  // God process whose cgroup/generation has to be proven before starting.
  if (!hasConfig()) {
    console.error('❌ 未找到配置文件');
    console.error('   请先运行: botmux setup');
    process.exit(1);
  }
  ensureConfigDir();
  await ensureSystemDependencies();

  const botsForCheck = await preflightConfiguredBotCredentials();
  // The boot hook marks itself so purely presentational waiting can be skipped
  // there (see startConfiguredFleet).
  await startConfiguredFleet(botsForCheck, { bootHookStart });
}

/** Validate before systemd handoff so a predictable failure cannot stop the old fleet. */
async function preflightConfiguredBotCredentials() {
  const botsForCheck = loadBotsJson();
  if (botsForCheck.length > 0) {
    const { validateCredentials } = await import('./setup/verify-permissions.js');
    const invalid: Array<{ appId: string; reason: string }> = [];
    for (const b of botsForCheck) {
      if (!b.larkAppId || !b.larkAppSecret) {
        invalid.push({ appId: b.larkAppId || '(空 appId)', reason: 'larkAppId/larkAppSecret 缺失' });
        continue;
      }
      const v = await validateCredentials(b.larkAppId, b.larkAppSecret, botBrand(b));
      if (!v.ok) {
        if (v.error === 'invalid_credentials') {
          invalid.push({ appId: b.larkAppId, reason: v.message });
        } else {
          // network / unknown — 不应该拦下启动, 走 WARN
          console.warn(`⚠️  [${b.larkAppId}] 启动前凭证验证未成功（${v.error}）: ${v.message}`);
          console.warn(`   daemon 仍会启动；启动后 dispatcher 会自行重试。`);
        }
      }
    }
    if (invalid.length > 0) {
      console.error('\n❌ 以下机器人凭证无效，botmux start 中止：\n');
      for (const e of invalid) console.error(`   - ${e.appId}: ${e.reason}`);
      console.error('\n   修复方式: 运行 `botmux setup` 选 "重新配置" 重新走扫码/手动流程。');
      process.exit(1);
    }
  }
  return botsForCheck;
}

async function startConfiguredFleet(
  botsForCheck: ReturnType<typeof loadBotsJson>,
  options: { bootHookStart?: boolean } = {},
): Promise<void> {

  await withFileLock(PM2_FLEET_MUTATION_LOCK_TARGET, async () => {
    await withFileLock(BOTS_JSON_FILE, async () => {
      const lockedBots = loadBotsJson();
      if (JSON.stringify(lockedBots) !== JSON.stringify(botsForCheck)) {
        throw new Error('[start] bots.json changed during credential preflight; retry with the new configuration');
      }
      preflightNodeSanity();
      // Upgrading from a pm2-based botmux: auto-stop a lingering legacy pm2 God
      // before bringing up the supervisor, so a plain `botmux start` (the usual
      // first command) doesn't end up double-running the old pm2 daemons
      // alongside the new supervisor. Fail-safe no-op on fresh installs.
      cleanupLegacyPm2();
      // Fleet launch via the built-in supervisor (replaces pm2). The supervisor
      // owns the invariants pm2's guard layer used to enforce: single-supervisor
      // exclusion (fleet-state pid + kill-0, under this same mutation lock),
      // idempotent reconcile (planStart only (re)spawns missing/dead bots), and
      // projection identity (validated on every state write). So `start` while a
      // live supervisor already owns the fleet is a safe no-op — no pm2-style
      // "refuse partial live fleet" dance needed; the running supervisor keeps
      // the fleet reconciled itself.
      const { startFleetViaSupervisor } = await import('./core/fleet-runtime.js');
      const result = startFleetViaSupervisor();
      if (result.action === 'already-running') {
        console.log(`\n✅ fleet 已在运行 (supervisor pid ${result.supervisorPid}, ${result.botCount} 个机器人)`);
      }
    }, { maxWaitMs: 5_000 });
  }, { maxWaitMs: 5_000 });
  await reconcilePluginServicesForCli(undefined, {
    autoOnly: true,
  });
  const bots = loadBotsJson();
  const count = bots.length || 1;
  console.log(`\n✅ daemon 已启动${count > 1 ? ` (${count} 个机器人, 每个独立进程)` : ''}`);
  console.log(`   日志: botmux logs`);
  console.log(`   状态: botmux status`);
  // If the user previously enabled autostart, sync the unit file in case the
  // launch paths changed since (nvm switch, npm upgrade, a move between the Node
  // and compiled forms).
  // NOT UNDER THE BOOT HOOK ITSELF: the unit is `Type=oneshot` with
  // `RemainAfterExit=yes`, so this ExecStart child IS the start job — rewriting
  // and `daemon-reload`ing the very unit that is mid-transaction is at best
  // pointless and at worst makes the start fail.
  if (!options.bootHookStart
      && refreshAutostart({ pkgRoot: PKG_ROOT, configDir: CONFIG_DIR, logDir: LOG_DIR })) {
    console.log(`   autostart 主 unit 已同步到当前启动路径`);
  }
  // NOT UNDER systemd. Nobody reads a dashboard link at boot, and this poll waits
  // up to DASHBOARD_READY_WAIT_MS (90s) — exactly the DefaultTimeoutStartUSec on a
  // stock user manager (VERIFIED: `systemctl --user show -p
  // DefaultTimeoutStartUSec` → 1min 30s), with the credential preflight, legacy
  // reap and plugin reconcile already spent before we get here. A slow fleet would
  // push this Type=oneshot unit past that deadline; systemd would call the start a
  // failure and, under the default KillMode=control-group, take the freshly
  // started supervisor down with the unit — so fixing the unit's path would be
  // undone by waiting inside it. Purely presentational: skip it.
  if (!options.bootHookStart) await printDashboardHintWithRetry();
}

/**
 * Wipe stale dashboard-daemon descriptors (mtime older than 5 minutes).
 * Live daemons refresh their descriptor every 30s via heartbeat; anything
 * older is from a daemon that exited without cleaning up. Called as part of the
 * stop/restart cleanup flow so the dashboard registry stays consistent.
 */
function cleanupStaleDaemonDescriptors(): void {
  const regDir = join(resolveDataDir(), 'dashboard-daemons');
  if (!existsSync(regDir)) return;
  for (const f of readdirSync(regDir)) {
    if (!f.endsWith('.json')) continue;
    const fp = join(regDir, f);
    try {
      const stat = statSync(fp);
      if (Date.now() - stat.mtimeMs > 5 * 60_000) unlinkSync(fp);
    } catch { /* ignore */ }
  }
}

/** Block the current thread for `ms`. Safe here: the restart CLI is a one-shot
 *  process, so stalling its event loop during the shutdown poll is harmless. */
function sleepSyncMs(ms: number): void {
  if (ms <= 0) return;
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* SAB unavailable → no-op */ }
}

/**
 * One-time migration cleanup for hosts upgrading from a pm2-based botmux. The
 * fleet now runs under the built-in supervisor, not pm2, but an upgrading host
 * may still have a live pm2 God holding the OLD botmux daemons — which would
 * double-run alongside the supervisor. This detects that stale God and stops it
 * (delegated to the self-contained `reapLegacyPm2`), so the operator never has
 * to `pm2 kill` by hand. Fail-safe + no-op on fresh installs / when pm2 is
 * absent. The `_op` parameter is retained for call-site compatibility but no
 * longer changes behavior — the reaper is a single idempotent operation.
 *
 * A reap that finds a God but cannot confirm it is down is reported on STDERR,
 * not just through `logger`: CLI mode runs with `logger.setSilent(true)`, so the
 * reaper's own notes are invisible without DEBUG. That silence is how a
 * double-run started unnoticed — both fleets live, two processes consuming the
 * same Feishu events and the same session sqlite. The operator needs to see it.
 */
function cleanupLegacyPm2(_op?: 'stop' | 'restart'): boolean {
  const r = reapLegacyPm2(CONFIG_DIR, PKG_ROOT, (m) => logger.info(`[legacy-pm2] ${m}`));
  if (r.unresolved) {
    console.warn(`⚠️  检测到迁移前的 pm2 守护进程,但未能确认其已停止:${r.note}`);
    console.warn('   旧 fleet 可能仍在消费同一批飞书事件(消息重复、会话存储争用)。');
    console.warn('   请手动确认:ps -ef | grep index-daemon   然后停掉旧进程后重试。');
  }
  return r.found;
}


async function cmdStop(): Promise<void> {
  const includePluginServices = process.argv.includes('--with-plugin');
  ensureConfigDir();
  await withFileLock(PM2_FLEET_MUTATION_LOCK_TARGET, async () => {
    cleanupLegacyPm2('stop'); // reap any pre-migration pm2 God still holding botmux procs
    const { stopFleet } = await import('./core/fleet-runtime.js');
    const result = stopFleet();
    if (result.action === 'not-running') {
      cleanupStaleDaemonDescriptors();
      if (includePluginServices) await stopPluginServicesForCli(undefined, { autoOnly: true });
      console.log('daemon 未在运行。');
      return;
    }
    if (result.action === 'timeout') {
      throw new Error(
        `[stop] supervisor (pid ${result.supervisorPid}) 未在超时时间内退出；已发送 SIGKILL，`
        + `请用 \`botmux status\` 复核 fleet 状态。`,
      );
    }
    cleanupStaleDaemonDescriptors();
    if (includePluginServices) await stopPluginServicesForCli(undefined, { autoOnly: true });
    console.log(`✅ daemon 已停止 (supervisor pid ${result.supervisorPid})`);
  }, { maxWaitMs: 5_000 });
}

interface RestartLifecycleFlags {
  includePm2: boolean;
  includePluginServices: boolean;
  bootstrapShutdownProtocol: boolean;
  bootstrapConfirmed: boolean;
}


async function cmdRestart(): Promise<void> {
  const restartLeaseId = process.env.BOTMUX_RESTART_LEASE_ID;
  const restartLeaseDir = process.env.BOTMUX_RESTART_LEASE_DIR;
  delete process.env.BOTMUX_RESTART_LEASE_ID;
  delete process.env.BOTMUX_RESTART_LEASE_DIR;
  if (restartLeaseId) {
    if (!restartLeaseDir) throw new Error('restart driver lease directory is missing');
    let bound = false;
    withFileLockSync(globalInstallUpdateLockTargetIn(restartLeaseDir), () => {
      bound = bindRestartLeaseTo(restartLeaseDir, restartLeaseId, process.pid, Date.now());
    });
    if (!bound) throw new Error('failed to bind restart driver lease');
  }
  if (!hasConfig()) {
    console.error('❌ 未找到配置文件');
    console.error('   请先运行: botmux setup');
    process.exit(1);
  }
  ensureConfigDir();
  await withFileLock(PM2_FLEET_MUTATION_LOCK_TARGET, async () => {
    const includePluginServices = process.argv.includes('--with-plugin');

    const restartIntentDir = resolveDataDir();
    let stagedRestartIntent: RestartIntent | null = null;
    try {
      stagedRestartIntent = consumeRestartIntentTo(restartIntentDir, Date.now());
    } catch { /* intent reporting is best-effort */ }

    preflightNodeSanity();
    await ensureSystemDependencies();
    cleanupLegacyPm2('restart'); // reap any pre-migration pm2 God still holding botmux procs
    if (includePluginServices) await stopPluginServicesForCli(undefined, { autoOnly: true });
    cleanupStaleDaemonDescriptors();

    await withFileLock(BOTS_JSON_FILE, async () => {
      const restartBots = loadBotsJson();
      const restartAttemptId = randomBytes(16).toString('hex');
      let restartIntentPrepared = false;
      try {
        const now = Date.now();
        writeRestartAttemptIntentTo(
          restartIntentDir,
          stagedRestartIntent ?? { kind: 'manual', at: new Date(now).toISOString() },
          now,
          restartAttemptId,
        );
        restartIntentPrepared = true;
      } catch { /* breadcrumb is best-effort */ }

      // Stop the live supervisor (graceful, then killed if it overruns) and
      // start a fresh one, which re-reads bots.json and (re)spawns every bot.
      const { restartFleet, fleetMemberNames, waitFleetOnline } = await import('./core/fleet-runtime.js');
      let health: ReturnType<typeof waitFleetOnline>;
      try {
        const r = restartFleet();
        if (r.stop.action === 'timeout') {
          throw new Error(
            `[restart] 旧 supervisor (pid ${r.stop.supervisorPid}) 未在超时时间内退出；已 SIGKILL 后仍存活，中止重启。`,
          );
        }
        // Health-gate on every supervised member (bot daemons + dashboard), so a
        // restart that leaves the dashboard down is reported unhealthy, not "ok".
        const names = fleetMemberNames();
        health = waitFleetOnline(names, pm2StartVerifyTimeoutMs(names.length));
        if (!health.healthy) {
          throw new Error(
            `[restart] fleet 未在超时时间内全部上线 (${health.online}/${health.expected})；`
            + `未上线: ${health.pending.join(', ')}。用 \`botmux status\` / \`botmux logs\` 排查。`,
          );
        }
      } catch (err) {
        try { removeRestartIntentAttemptTo(restartIntentDir, restartAttemptId); } catch { /* best-effort */ }
        throw err;
      }

      if (restartIntentPrepared) {
        let committed = false;
        try {
          committed = commitRestartIntentAttemptTo(restartIntentDir, restartAttemptId);
        } catch { /* best-effort after verified healthy fleet */ }
        if (!committed) {
          try {
            removeRestartIntentAttemptTo(restartIntentDir, restartAttemptId);
          } catch { /* best-effort */ }
          console.warn('⚠️  daemon 已完整启动，但重启摘要凭据未能提交；本次不会发送重启摘要。');
        }
      }
    }, { maxWaitMs: 5_000 });

    await reconcilePluginServicesForCli(undefined, { autoOnly: true });
    if (refreshAutostart({ pkgRoot: PKG_ROOT, configDir: CONFIG_DIR, logDir: LOG_DIR })) {
      console.log(`autostart 主 unit 已同步到当前启动路径`);
    }
    console.log('✅ daemon 已重启');
  }, { maxWaitMs: 5_000 });
  // OUTSIDE THE FLEET MUTATION LOCK, deliberately. This poll waits up to
  // DASHBOARD_READY_WAIT_MS (90s) and reads nothing the lock protects — it only
  // asks the dashboard for a link. Holding the lock across it would block every
  // other fleet mutation (`start`, `stop`, `start-bot`, plugin reconcile) for that
  // whole time, and those callers give up after 5s with a lock timeout. The
  // restart itself, its health gate, the plugin reconcile and the autostart sync
  // all stay inside.
  await printDashboardHintWithRetry();
}


export type StartBotLiveResult =
  | { ok: true; state: 'started' | 'already-online'; processName: string }
  | { ok: false; reason: 'not_found' | 'not_ready' | 'fleet_down' | 'timeout' | 'supervisor_error'; message: string };

export type StopBotLiveResult =
  | { ok: true; state: 'stopped' | 'already-stopped'; processName: string }
  | { ok: false; reason: 'not_found' | 'fleet_down' | 'timeout' | 'supervisor_error'; message: string };


async function ensureBotDaemonStopped(
  appId: string,
  _opts: { quiet?: boolean } = {},
): Promise<StopBotLiveResult> {
  ensureConfigDir();
  try {
    return await withFileLock(PM2_FLEET_MUTATION_LOCK_TARGET, async () => {
      cleanupLegacyPm2(); // reap a pre-migration pm2 God if one is still around
      const { stopBotViaSupervisor } = await import('./core/fleet-runtime.js');
      const r = stopBotViaSupervisor(
        appId,
        () => randomBytes(8).toString('hex'),
        () => new Date().toISOString(),
      );
      if (r.ok) {
        return { ok: true, state: r.state, processName: r.name };
      }
      // fleet_down maps to already-stopped for a single bot: if no supervisor is
      // running, that bot isn't running either — the stop intent is satisfied.
      if (r.reason === 'fleet_down') {
        return { ok: true, state: 'already-stopped', processName: r.name ?? appId };
      }
      return {
        ok: false,
        reason: r.reason === 'not_found' ? 'not_found' : r.reason === 'timeout' ? 'timeout' : 'supervisor_error',
        message: r.message,
      };
    }, { maxWaitMs: 5_000 });
  } catch (err) {
    return {
      ok: false,
      reason: 'supervisor_error',
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Bring a SINGLE bot's daemon online without touching any other bot's process.
 * A new bot is always APPENDED to bots.json (stable index), so the existing
 * daemons keep running unchanged — we only need the supervisor to spawn the new
 * bot's own daemon.
 *
 * The live supervisor OWNS every daemon child, so we can't spawn one here (it
 * would be an orphan the supervisor never tracks). Instead startBotViaSupervisor
 * enqueues a start-bot command, SIGHUPs the supervisor, and waits for the bot to
 * come online. Idempotent: a no-op when already online. When the whole fleet is
 * down (no supervisor), we do NOT start a lone bot; that belongs to `botmux
 * start`, which brings up the entire fleet.
 *
 * The activation-readiness gate (activationPending/starting/committed/
 * deactivating) is orthogonal to how the daemon is launched and is preserved.
 */
async function ensureBotDaemonStarted(
  appId: string,
  opts: { quiet?: boolean } = {},
): Promise<StartBotLiveResult> {
  ensureConfigDir();
  try {
    return await withFileLock(PM2_FLEET_MUTATION_LOCK_TARGET, async () => {
      cleanupLegacyPm2(); // reap a pre-migration pm2 God if one is still around
      const bots = loadBotsJson();
      const index = bots.findIndex(b => b?.larkAppId === appId);
      if (index < 0) {
        return { ok: false, reason: 'not_found', message: `appId ${appId} 不在 bots.json 中` };
      }
      const bot = bots[index];
      // Activation-readiness gate (managed onboarding) — unchanged by the pm2→
      // supervisor migration; a not-yet-ready bot must not be launched.
      if (bot?.activationPending === true) {
        return { ok: false, reason: 'not_ready', message: `appId ${appId} is still activation pending` };
      }
      const activationStarting = bot?.activationStarting;
      const activationCommitted = bot?.activationCommitted;
      const activationDeactivating = bot?.activationDeactivating;
      if (activationDeactivating !== undefined) {
        return { ok: false, reason: 'not_ready', message: `appId ${appId} is still deactivating` };
      }
      if (activationStarting !== undefined && activationCommitted !== undefined) {
        return { ok: false, reason: 'not_ready', message: `appId ${appId} has conflicting activation markers` };
      }
      const activationMarker = activationStarting ?? activationCommitted;
      const activationJobId = (
        activationMarker
        && typeof activationMarker === 'object'
        && !Array.isArray(activationMarker)
        && activationMarker.appId === appId
        && typeof activationMarker.jobId === 'string'
        && activationMarker.jobId
      )
        ? String(activationMarker.jobId)
        : undefined;
      if (activationMarker !== undefined && !activationJobId) {
        return { ok: false, reason: 'not_ready', message: `appId ${appId} has an invalid activation marker` };
      }

      const { startBotViaSupervisor } = await import('./core/fleet-runtime.js');
      const r = startBotViaSupervisor(
        appId,
        () => randomBytes(8).toString('hex'),
        () => new Date().toISOString(),
      );
      if (r.ok) {
        return { ok: true, state: r.state, processName: r.name };
      }
      return {
        ok: false,
        reason: r.reason === 'not_found' ? 'not_found'
          : r.reason === 'fleet_down' ? 'fleet_down'
          : r.reason === 'timeout' ? 'timeout' : 'supervisor_error',
        message: r.message,
      };
    }, { maxWaitMs: 5_000 });
  } catch (err) {
    return {
      ok: false,
      reason: 'supervisor_error',
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * `botmux start-bot <larkAppId>` — bring one freshly-added bot online without a
 * fleet-wide restart. Invoked by `botmux setup add` (inline) and by the
 * dashboard onboarding flow (spawned as a subprocess). `--json` for scripted
 * callers.
 */
async function cmdStartBot(argv: string[]): Promise<void> {
  const wantsJson = argv.includes('--json');
  const appId = argv.find(a => !a.startsWith('-'));
  if (!appId) {
    const msg = '用法: botmux start-bot <larkAppId> —— 拉起单个新机器人的 daemon（不重启其它 bot）';
    if (wantsJson) console.log(JSON.stringify({ ok: false, reason: 'missing_app_id', message: msg }));
    else console.error(`❌ ${msg}`);
    process.exit(1);
  }
  ensureConfigDir();
  const r = await ensureBotDaemonStarted(appId, { quiet: wantsJson });
  if (wantsJson) {
    console.log(JSON.stringify(r, null, 2));
    if (!r.ok) process.exitCode = 1;
    return;
  }
  if (r.ok) {
    if (r.state === 'already-online') console.log(`✅ ${r.processName} 已在运行，无需操作`);
    else console.log(`✅ 已拉起 ${r.processName}（未重启其它机器人）`);
    return;
  }
  if (r.reason === 'fleet_down') {
    console.error('ℹ️  daemon 未在运行。请用 `botmux start` 启动整个进程组。');
  } else {
    console.error(`❌ 拉起失败 (${r.reason}): ${r.message}`);
  }
  process.exit(1);
}

/** `botmux stop-bot <larkAppId>` — stop only one exact bot for managed recovery. */
async function cmdStopBot(argv: string[]): Promise<void> {
  const wantsJson = argv.includes('--json');
  const appId = argv.find(a => !a.startsWith('-'));
  if (!appId) {
    const msg = '用法: botmux stop-bot <larkAppId> —— 停止单个机器人的 daemon（不影响其它 bot）';
    if (wantsJson) console.log(JSON.stringify({ ok: false, reason: 'missing_app_id', message: msg }));
    else console.error(`❌ ${msg}`);
    process.exit(1);
  }
  ensureConfigDir();
  const r = await ensureBotDaemonStopped(appId, { quiet: wantsJson });
  if (wantsJson) {
    console.log(JSON.stringify(r, null, 2));
    if (!r.ok) process.exitCode = 1;
    return;
  }
  if (r.ok) {
    console.log(r.state === 'already-stopped'
      ? `✅ ${r.processName} 已停止`
      : `✅ 已停止 ${r.processName}（其它机器人未受影响）`);
    return;
  }
  console.error(`❌ 停止失败 (${r.reason}): ${r.message}`);
  process.exit(1);
}

/** Print the post-add "next step" line for interactive setup: auto-start the new
 *  bot's own daemon when the fleet is up (no fleet-wide restart), else fall back
 *  to the botmux start / restart hint. */
async function printAddBotLiveHint(appId: string): Promise<void> {
  const live = await ensureBotDaemonStarted(appId);
  if (live.ok) {
    console.log(`✅ 已自动上线（${live.processName}），无需重启其它机器人。\n`);
  } else if (live.reason === 'fleet_down') {
    console.log('下一步: botmux start（daemon 尚未运行）\n');
  } else {
    console.log(`⚠️  自动上线失败（${live.message}）。下一步: botmux restart\n`);
  }
}

/** Wraps `ensureDependencies()`. Fonts are nice-to-have (warn only). tmux is
 *  required since PTY 退役: if it's GENUINELY ABSENT and a bot wants the tmux
 *  backend (and the operator hasn't opted into BACKEND_TYPE=pty), we hard-fail
 *  here — non-zero exit, no pm2 spawn — so an unattended `start`/`restart`
 *  surfaces the failure instead of bringing up a daemon whose every session
 *  would gate at first message. A present-but-broken tmux (functional probe
 *  flaked) is NOT fatal: the daemon still starts and degrades per-session, so a
 *  transient probe failure can't block reattaching live sessions (PR#249). An
 *  unexpected exception in the probe itself is non-fatal for the same reason. */
async function ensureSystemDependencies(): Promise<void> {
  const { ensureDependencies, shouldHardFailStartupForMissingTmux } = await import('./setup/index.js');
  let report: Awaited<ReturnType<typeof ensureDependencies>>;
  try {
    report = await ensureDependencies();
  } catch (err: any) {
    console.error('');
    console.error(`依赖检测内部错误: ${err?.message ?? String(err)}`);
    // Don't exit — a probe-internal error is not a confirmed "tmux missing".
    return;
  }

  // loadBotsJson() returns [] when bots.json is absent (→ no bot wants tmux) and
  // hard-exits on a malformed file (existing fast-fail) — it never throws here.
  const anyBotWantsTmux = loadBotsJson().some(b => (b?.backendType ?? config.daemon.backendType) === 'tmux');
  const ptyOptIn = (process.env.BACKEND_TYPE ?? '').toLowerCase() === 'pty';

  if (shouldHardFailStartupForMissingTmux({
    tmuxInstalled: report.tmux.installed,
    tmuxBinaryPresent: report.tmux.binaryPresent === true,
    anyBotWantsTmux,
    ptyOptIn,
  })) {
    console.error('');
    console.error('❌ tmux 未安装，已中止 daemon 启动 —— 默认走 tmux 后端的会话将全部无法运行。');
    console.error('   请按上方指引安装 tmux 后重试。');
    console.error('   如确需在没有 tmux 的环境运行，可显式用 PTY 兜底：BACKEND_TYPE=pty botmux start');
    console.error('   （注意：PTY 会话不跨 daemon 重启存活，仅作应急。）');
    console.error('');
    process.exit(1);
  }
}

/**
 * If a legacy pm2 God (from a pre-supervisor botmux) is still alive, warn the
 * operator so read-only commands (status/logs) don't silently show an empty
 * supervisor view while old pm2-managed daemons keep running. Self-contained:
 * no pm2 CLI call. `botmux start`/`restart` will reap it (reapLegacyPm2).
 *
 * TWO SIGNALS, deliberately different per home. Both go through the reaper's own
 * `liveGodAt` so the warning and the reaper cannot disagree — this used to be a
 * second, hand-kept copy of that logic, and it drifted: it trusted a bare
 * `kill(pid, 0)` (true for the ZOMBIE a fresh reap leaves behind) and a bare
 * `existsSync(rpc.sock)` (which outlives `pm2 kill`), so the warning survived a
 * SUCCESSFUL migration and no amount of re-running `restart` could clear it.
 *
 *  • The botmux-dedicated home (~/.botmux/pm2) is exclusively ours, so ANY live
 *    God there is a migration leftover. `liveGodAt` detects it by pm2.pid OR a
 *    held rpc.sock: a real God was observed supervising 50 daemons with NO
 *    pm2.pid at all, and a pid-file-only probe stayed silent through exactly the
 *    situation this warning exists for.
 *
 *  • The shared default (~/.pm2) may be the user's own pm2 running unrelated
 *    apps. A live God there means nothing by itself — MEASURED on this box: the
 *    shared God was alive with ZERO botmux rows, and the pid-file-only check
 *    warned anyway, telling the operator to run a migration that was already
 *    done. So there we require actual evidence of botmux rows, which pm2 records
 *    as per-app pid files under `pids/` (checked without spawning pm2).
 */
function legacyBotmuxGodAlive(): boolean {
  const dedicated = join(CONFIG_DIR, 'pm2');
  if (liveGodAt(dedicated) !== null) return true;
  const shared = join(homedir(), '.pm2');
  return liveGodAt(shared) !== null && sharedHomeHasBotmuxRows(shared);
}

/** Does the SHARED pm2 home actually hold botmux apps? pm2 writes one pid file
 *  per app as `pids/<name>-<id>.pid`, so this answers it without running pm2.
 *
 *  BEST-EFFORT BY DESIGN, and deliberately not on any correctness path: this
 *  only decides whether to PRINT a migration hint. If pm2 ever changes the
 *  `pids/` layout this goes false-negative (the hint stays silent) — it can
 *  never cause a wrong action. The authoritative detection is reapLegacyPm2's
 *  `pm2 jlist`, which asks pm2 itself and is unaffected by this assumption.
 *  Name matching is kept in step with that function's `isBotmuxPm2Name`. */
function sharedHomeHasBotmuxRows(home: string): boolean {
  try {
    return readdirSync(join(home, 'pids')).some((f) =>
      (f === 'botmux.pid' || f.startsWith('botmux-')) && !f.startsWith('botmux-plugin-'));
  } catch {
    return false; // no pids/ dir → no apps we care about
  }
}

function warnIfLegacyBotmuxAlive(): void {
  if (!legacyBotmuxGodAlive()) return;
  console.warn('⚠️  检测到旧版 pm2 守护进程仍在运行,运行 `botmux restart` 完成到内置 supervisor 的迁移(会自动停掉旧 pm2)。\n');
}

// #877 的纯文件 tail：fleet 停止时也能看日志，且永不创建 God。
// #919 的 external-God fail-closed 检查随 pm2 一起移除：没有 God 进程可归属，
// 也就没有「外部 God 抢占」这个状态需要拒绝；「fleet 停了也能看历史」不变。
async function cmdLogs(): Promise<void> {
  warnIfLegacyBotmuxAlive();
  const lines = process.argv.includes('--lines')
    ? process.argv[process.argv.indexOf('--lines') + 1] || '50'
    : '50';
  const follow = !process.argv.includes('--no-follow'); // default: stream like pm2 logs

  const bots = loadBotsJson();
  // Support --bot <0-based-index|name|appId> to filter one bot's logs; otherwise
  // tail every bot's files. The supervisor writes daemon-<index>-out/err.log
  // (see fleet-supervisor spawnBot), replacing pm2's out_file/error_file.
  const botArg = process.argv.includes('--bot')
    ? process.argv[process.argv.indexOf('--bot') + 1]
    : undefined;

  const { fleetLogDir } = await import('./core/fleet-runtime.js');
  const logDir = fleetLogDir();

  let indices: number[];
  if (botArg !== undefined) {
    const numericIdx = /^\d+$/.test(botArg) ? Number(botArg) : undefined;
    const selectedIdx = numericIdx === undefined
      ? parseBotSelection(botArg, bots)
      : (numericIdx >= 0 && numericIdx < bots.length ? numericIdx : undefined);
    if (selectedIdx === undefined) {
      console.error(`❌ 未识别的 --bot 选择: ${botArg}`);
      process.exit(1);
    }
    indices = [selectedIdx];
  } else {
    indices = bots.length > 0 ? bots.map((_, i) => i) : [0];
  }

  const files: string[] = [];
  for (const i of indices) {
    for (const kind of ['out', 'err'] as const) {
      const fp = join(logDir, `daemon-${i}-${kind}.log`);
      if (existsSync(fp)) files.push(fp);
    }
  }
  if (files.length === 0) {
    console.error(`ℹ️  暂无日志文件（${logDir}/daemon-*-{out,err}.log）。daemon 可能尚未启动或还没有输出。`);
    process.exit(0);
  }

  // Stream with `tail`: `-n <lines>` for the backlog, `-F` to follow across the
  // supervisor's log rotation/reopen on restart. Multiple files get `==> file`
  // banners from tail itself. `--no-follow` prints the backlog and exits.
  const tailArgs = follow ? ['-n', lines, '-F', ...files] : ['-n', lines, ...files];
  const child = spawn('tail', tailArgs, { stdio: 'inherit' });
  child.on('error', (err) => {
    console.error(`❌ 无法运行 tail：${err instanceof Error ? err.message : err}`);
    process.exit(1);
  });
  child.on('exit', code => process.exit(code ?? 0));
}

async function cmdStatus(): Promise<void> {
  warnIfLegacyBotmuxAlive();
  const { readFleetStatus } = await import('./core/fleet-runtime.js');
  const status = readFleetStatus();
  if (!status.supervisorAlive && status.rows.length === 0) {
    console.log('daemon 未在运行。（用 `botmux start` 启动）');
    return;
  }
  const sup = status.supervisorAlive
    ? `supervisor 在线 (pid ${status.supervisorPid}${status.supervisorStartedAt ? `, 自 ${status.supervisorStartedAt}` : ''})`
    : 'supervisor 未在运行（下方为上次记录的状态）';
  console.log(sup);
  if (status.rows.length === 0) {
    console.log('  （无已配置机器人）');
    return;
  }
  // Fixed-width table: name | pid | status | ↺restarts | exit.
  const nameW = Math.max(4, ...status.rows.map(r => r.name.length));
  const header = `  ${'NAME'.padEnd(nameW)}  ${'PID'.padStart(7)}  ${'STATUS'.padEnd(9)}  ${'↺'.padStart(4)}  EXIT`;
  console.log(header);
  for (const r of status.rows) {
    // A row recorded 'online' whose pid is actually dead is shown as such so
    // status never lies while the supervisor is between reconcile ticks.
    const shown = r.status === 'online' && !r.alive ? 'dead?' : r.status;
    const pidCol = r.pid > 0 ? String(r.pid) : '-';
    const exitCol = r.lastExitCode === null ? '-' : String(r.lastExitCode);
    console.log(`  ${r.name.padEnd(nameW)}  ${pidCol.padStart(7)}  ${shown.padEnd(9)}  ${String(r.restarts).padStart(4)}  ${exitCol}`);
  }
  warnIfLegacyBotmuxAlive();
  // The pm2 read-only projection print is gone: the fleet-state table above IS
  // the authoritative status now (supervisor-owned), so there is no second
  // registry to reconcile against. Legacy pm2 still gets surfaced by
  // warnIfLegacyBotmuxAlive above, which is what a pre-migration host needs.
}

async function cmdUpgrade(): Promise<void> {
  // 本地 checkout（有 .git/src）：走 git pull --ff-only → 重新 build → 从本
  // checkout 重启，而不是拿全局包管理器去升级（那对 dev 部署无效，见
  // install-info.ts 的 isLocalDevInstall 说明）。
  if (isLocalDevInstall()) {
    cmdUpgradeLocalDev();
    return;
  }
  // 编译版单文件二进制没有 package.json 落盘 ⟹ resolveGlobalInstallPlan 恒抛
  // Unsupported（实测真实 v3.18.4 二进制就是这条）。改为先按「二进制装在哪」
  // 判形态：npm 子包形态交回 npm/pnpm/bun，install.sh 形态自己换二进制。
  const strategy = currentUpdateStrategy(botmuxInstallRoot());
  if (strategy.kind === 'self-replace') {
    try {
      const latest = await fetchLatestVersion();
      if (!latest) {
        console.error('❌ 无法获取最新版本号（网络不可达或 registry 异常）。');
        process.exit(1);
      }
      const current = resolveCurrentVersion();
      if (!isNewerVersion(latest, current)) {
        console.log(`✅ 已是最新版本（${current}）。`);
        return;
      }
      console.log(`🔄 升级中：下载 v${latest} 二进制并替换 ${strategy.target}`);
      // 握与 dashboard / maintenance 同一把跨进程锁：这条路径是**写同一个文件**，
      // 两个 update 并发跑会互相盖掉临时文件与 rename。锁文件父目录可能还不存在
      // （daemon 从未在本机起过就先跑 update），先建再握，否则 ENOENT 会盖掉真实错误。
      const lockTarget = globalInstallUpdateLockTarget();
      mkdirSync(dirname(lockTarget), { recursive: true });
      let acquired = false;
      try {
        await withFileLock(lockTarget, async () => {
          acquired = true;
          const r = await replaceStandaloneBinary(latest, strategy.target);
          console.log(`✅ 升级完成：${r.asset} → ${r.target}（${current} → ${latest}）。运行 botmux restart 以应用更新。`);
        }, { maxWaitMs: 2_000 });
      } catch (error) {
        // ⚠️ 三态，不是二态。`withFileLock` 拿不到锁时是**抛异常**不是安静返回，
        // 但 `acquired === false` 只证明「回调没执行」，**不等于「别人持锁」**：
        // 回调之前还可能因 `open` 的 EACCES/ENOSPC、holder 写入失败、holder 元数据
        // 不可读、stale-claim `link` 失败而抛错。只看 `acquired` 会把这些**真实故障
        // 全部误报成「另一个更新正在进行」**——磁盘满被说成并发冲突，是最坏的那种
        // 误导。所以必须同时要求它是 timeout 类型：
        //   ① 超时且回调未进入        → 友好并发提示（正常互斥结果，不是故障）
        //   ② 回调已进入后失败        → 透出真实错误（下载/校验/替换）
        //   ③ 回调前的基础设施失败    → 同样透出真实错误
        // 判类型而不是匹文案：file-lock 的文案被多处按字符串匹配，不能动，但新代码
        // 应该用 FileLockTimeoutError（async/sync 两处语义一致）。
        if (!acquired && error instanceof FileLockTimeoutError) {
          console.error('❌ 另一个更新正在进行中（dashboard 或定时任务），请稍后重试。');
          process.exit(1);
        }
        throw error; // ②③ 交给外层统一报错，不被友好文案吞掉
      }
    } catch (error) {
      console.error(`❌ 升级失败：${error instanceof Error ? error.message : error}`);
      process.exit(1);
    }
    return;
  }
  try {
    if (strategy.kind === 'unsupported') {
      throw new UnsupportedGlobalInstallError('unknown', process.execPath);
    }
    const plan = resolveGlobalInstallPlan(strategy.packageRoot);
    console.log(`🔄 升级中：${formatGlobalInstallCommand(plan)}`);
    installLatestBotmuxSync(plan);
    console.log('\n✅ 升级完成。运行 botmux restart 以应用更新。');
  } catch (error) {
    if (error instanceof UnsupportedGlobalInstallError) {
      console.error(`❌ 无法安全识别当前安装方式（${error.manager}），请使用原包管理器手动更新 botmux。`);
    } else {
      console.error(`❌ 升级失败：${error instanceof Error ? error.message : error}`);
    }
    process.exit(1);
  }
}

/** 在 checkout 目录里同步跑一条命令，stdio 直通；失败抛错。 */
function runInCheckout(cwd: string, command: string, args: string[]): void {
  const result = spawnSync(command, args, {
    cwd,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (result.error || result.status !== 0) {
    throw new Error(describeSpawnFailure(command, args, result));
  }
}

/**
 * 本地 checkout 的更新流程：git 干净检查 → git pull --ff-only → pnpm build →
 * 从本 checkout 的 dist/cli.js restart。dist/ 被 gitignore，只 pull 不 build
 * 重启后跑的还是旧代码，故 build 步不可省。定位/干净检查/命令定义与 dashboard
 * 共用 src/utils/local-dev-update.ts，避免两边逻辑漂移。
 */
function cmdUpgradeLocalDev(): void {
  const dir = resolveLocalDevCheckoutDir();
  if (!isGitWorktree(dir)) {
    console.error(`❌ ${dir} 不是 git 工作树，无法用 git pull 更新。请手动更新或改用全局安装。`);
    process.exit(1);
  }
  console.log(`🔄 本地 checkout 更新：${dir}`);

  // git 干净检查 + pull + build 全程握同一把跨进程 update 锁（与 dashboard 的
  // /api/update/run 用的是同一个 target），避免 CLI 与 dashboard 同时对同一
  // checkout 交错跑 pnpm build 而互相清理/覆盖 dist。restart 不在锁内——它有
  // 自己的 restart lease。
  try {
    const lockTarget = globalInstallUpdateLockTarget();
    // daemon 正常会建好 dataDir；但 CLI 可能在 daemon 尚未起过的机器上先跑
    // update，锁文件父目录不存在会让 withFileLockSync 报 ENOENT 而盖掉真实错误。
    mkdirSync(dirname(lockTarget), { recursive: true });
    withFileLockSync(lockTarget, () => {
      // 1) fail closed：有未提交改动就中止（不偷偷 stash），让用户自己决定。
      let status: string;
      try {
        status = gitPorcelainStatus(dir);
      } catch (error) {
        throw new Error(`读取 git 状态失败：${error instanceof Error ? error.message : error}`);
      }
      if (status) {
        const err = new Error('dirty') as Error & { dirtyStatus?: string };
        err.dirtyStatus = status;
        throw err;
      }
      // 2~3) git pull --ff-only（分叉/冲突直接报错停下，不自动 merge）+ pnpm build。
      for (const { command, args } of localDevUpdateSteps()) {
        console.log(`→ ${command} ${args.join(' ')}`);
        runInCheckout(dir, command, args);
      }
    }, { maxWaitMs: 2_000 });
  } catch (error) {
    const dirty = (error as { dirtyStatus?: string }).dirtyStatus;
    if (dirty) {
      console.error('❌ 工作区有未提交改动，已中止更新（不会自动 stash）。请先提交或清理：');
      console.error(dirty);
    } else {
      console.error(`❌ 更新失败：${error instanceof Error ? error.message : error}`);
    }
    process.exit(1);
  }

  // 4) 用本 checkout 的 cli.js 重启 daemon（不走 PATH，避免被更靠前的全局 botmux 抢先）。
  try {
    console.log('→ restart daemon');
    runInCheckout(dir, process.execPath, [botmuxCliEntryAt(dir), 'restart']);
    console.log('\n✅ 本地更新完成，daemon 已从最新代码重启。');
  } catch (error) {
    console.error(`❌ 重启失败：${error instanceof Error ? error.message : error}`);
    process.exit(1);
  }
}

/**
 * Call one of the dashboard's loopback HMAC `/__cli/*` endpoints. Thin wrapper
 * over {@link callDashboard}, which handles 404 disambiguation and self-heals a
 * stale `.dashboard-port` that points at the wrong service (e.g. daemon IPC).
 * See `src/cli/dashboard-endpoint.ts` for the why.
 *
 * `rescanWhenUnreachable` extends that self-heal to a recorded port with NOTHING
 * listening on it. It must stay opt-in: during boot `unreachable` is the normal
 * state and is resolved by retrying the same port, so scanning the range on every
 * poll tick would be pure waste. `executeDashboardCliCommand` passes it for the
 * one-shot `botmux dashboard`; the readiness poll below must NOT.
 */
async function callDashboardEndpoint(
  path: DashboardEndpoint,
  opts: { rescanWhenUnreachable?: boolean; requestTimeoutMs?: number } = {},
): Promise<DashboardResult> {
  return callDashboard({
    configDir: CONFIG_DIR,
    defaultPort: 7891,
    envPort: process.env.BOTMUX_DASHBOARD_PORT,
    path,
    rescanWhenUnreachable: opts.rescanWhenUnreachable,
    requestTimeoutMs: opts.requestTimeoutMs,
  });
}

/**
 * Merlin Devbox 上为当前 dashboard 端口创建（或复用）私有短链。
 *
 * 端口取 dashboard 落盘的 `.dashboard-port`（端口探测可能落在 7891 之外），与
 * `devboxDashboardBaseUrl()` 读侧用的是同一份判据，避免写 9002、读 9001。
 * 非 Devbox / 已配置中心平台或自建反代 / `merlin-cli` 不可用时全部静默 no-op。
 */
async function ensureDevboxDashboardExportForCurrentPort(): Promise<void> {
  const portFile = join(CONFIG_DIR, '.dashboard-port');
  const port = Number((existsSync(portFile) ? readFileSync(portFile, 'utf8').trim() : '')
    || process.env.BOTMUX_DASHBOARD_PORT || '7891');
  await ensureDevboxDashboardExport({
    port,
    remoteBaseConfigured: Boolean(
      (isRemoteAccessEnabled() && platformMachineBaseUrl()) || publicReverseProxyBaseUrl(),
    ),
  });
}

/**
 * Is the supervisor going to have a dashboard answering shortly — i.e. is one
 * running, or scheduled to be? Answers "is it worth waiting", so the question is
 * about the SUPERVISOR'S INTENT, not about a pid existing at this instant.
 *
 * A pid-only check was wrong in a way that reproduced the very bug this helps fix:
 * after a crash the supervisor records `status='launching', pid=0` and holds a
 * restart timer (fleet-supervisor.ts, handleExit), so during that backoff a
 * pid-based check says "not live", the poll stops, and `botmux dashboard` advises a
 * restart — while the supervisor was about to bring it back on its own.
 *
 *  • No live supervisor → nothing will start anything. false.
 *  • `launching` → true even with pid 0: that IS the supervisor saying "coming up".
 *  • `online` → the recorded pid must really be alive; an `online` row can outlive
 *    the process it names (a crash between state writes, or a stale state file).
 *  • `stopped` / `errored` → the supervisor has given up. false.
 *  • No row yet → `null`, meaning "cannot tell yet": a just-started supervisor has
 *    not written the dashboard row, which must not be read as "never will".
 *
 * `fleet-runtime` is imported dynamically to match every other use of it in this
 * file — it pulls in the supervisor machinery, which the CLI deliberately keeps
 * off its startup path.
 */
async function dashboardMemberComingUp(): Promise<boolean | null> {
  try {
    const { fleetStatePath, DASHBOARD_PROCESS_NAME } = await import('./core/fleet-runtime.js');
    const { readFleetState } = await import('./core/fleet-state-store.js');
    // The mapping itself lives in dashboard-command.ts as a pure function so it is
    // unit testable; this wrapper only supplies the I/O (state file + pid probe).
    return dashboardComingUpFromState(
      readFleetState(fleetStatePath()),
      DASHBOARD_PROCESS_NAME,
      (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } },
    );
  } catch {
    return null;                                   // unreadable → cannot tell
  }
}

/**
 * Best-effort dashboard hint printed after start/restart. Reads the LIVE link
 * via /__cli/current (non-rotating) so an already-shared URL is preserved.
 * Retries since the dashboard process boots after the daemon; if it still isn't
 * ready, prints a soft fallback so the user isn't blocked.
 *
 * BUDGET AND STOP CONDITIONS live in `cli/dashboard-command.ts`
 * (`DASHBOARD_READY_WAIT_MS`, `shouldKeepWaitingForDashboard`) so they are unit
 * testable and shared with the `botmux dashboard` message below — the two used to
 * disagree, which is how an operator got told to restart a healthy, still-booting
 * dashboard. The wait is bounded by LIVENESS as well as by the clock, so a fleet
 * with the dashboard disabled or already crashed falls through in one tick instead
 * of hanging for the whole budget. A fast boot is unaffected — the loop returns the
 * moment the dashboard answers.
 */
async function printDashboardHintWithRetry(): Promise<void> {
  const stepMs = 500;
  const started = Date.now();
  let last: Awaited<ReturnType<typeof callDashboardEndpoint>> | null = null;
  // 只在轮询之前做一次：导出结果与「dashboard 起没起来」无关，放在循环体里每轮都会
  // 重新 spawn 一次 merlin-cli，而失败路径最坏每轮付满 5s 超时——本函数自己的预算
  // 撑不住，实测会把 start/restart 的这段拖到近两倍。
  await ensureDevboxDashboardExportForCurrentPort();
  for (;;) {
    // Bounded per request (NOT opted into rescanning): this loop's own budget is
    // only consulted below, after the await returns, so a recorded port that
    // accepts the connection and never answers would hang here forever and never
    // reach that check. See requestTimeoutMs in dashboard-endpoint.ts.
    last = await callDashboardEndpoint('/__cli/current', { requestTimeoutMs: stepMs * 4 });
    if (last.ok) {
      console.log(`   面板: botmux dashboard (${last.url})`);
      // 走中心化平台链接时，附带本地直连兜底，平台异常也能直接 ip:port 访问。
      if (last.localUrl) console.log(`   本地直连(平台异常时可用): ${last.localUrl}`);
      return;
    }
    const keepWaiting = shouldKeepWaitingForDashboard({
      elapsedMs: Date.now() - started,
      failure: last,
      // Only asked when a retry is otherwise possible, so a fast boot never pays
      // for reading the fleet state.
      comingUp: dashboardFailureIsTerminal(last) ? false : await dashboardMemberComingUp(),
    });
    if (!keepWaiting) break;
    await new Promise(r => setTimeout(r, stepMs));
  }
  // Soft fallback
  if (last?.reason === 'no-active-token') {
    console.log('   面板: 运行 `botmux dashboard` 创建登录链接');
  } else if (last?.reason === 'no-secret') {
    console.log('   面板: dashboard 凭证未就绪，启动后可用 `botmux dashboard` 获取链接');
  } else if (last?.reason === 'wrong-service') {
    console.log('   面板: `botmux dashboard`（端口文件可能已失效，必要时 `botmux restart` 刷新）');
  } else {
    console.log('   面板: `botmux dashboard`（daemon 启动中，稍后可获取链接）');
  }
}

/** Get or create the current dashboard URL, or explicitly rotate it. Bare
 * `dashboard` is the non-rotating get-or-create form; help and invalid
 * subcommands never call either credential endpoint. */
async function cmdDashboard(args: string[]): Promise<void> {
  const rawAction = args[0]?.toLowerCase();
  const resolvesEndpoint = args.length <= 1
    && !args.some(arg => ['--help', '-h', 'help'].includes(arg.toLowerCase()))
    && (rawAction === undefined || rawAction === 'current' || rawAction === 'rotate');
  if (resolvesEndpoint) await ensureDevboxDashboardExportForCurrentPort();
  // The opt-in for a dead recorded port lives INSIDE executeDashboardCliCommand
  // so it is directly testable (see its doc comment for why source-regex guards
  // were not). `printDashboardHintWithRetry()` deliberately does not use this
  // wrapper — a 500ms poll must never scan the probe range per tick.
  const execution = await executeDashboardCliCommand(args, callDashboardEndpoint);
  if (execution.kind === 'help') {
    console.log(DASHBOARD_COMMAND_USAGE);
    return;
  }
  if (execution.kind === 'invalid') {
    console.error(`未知 dashboard 子命令: ${execution.argument}`);
    console.error(DASHBOARD_COMMAND_USAGE);
    process.exitCode = 2;
    return;
  }

  const { action, result: r } = execution;
  if (r.ok) {
    // 首行保持纯 URL（脚本/复制取第一行即可）；随后依次是工作台直达入口、以及走
    // 中心化平台时的本地直连兜底。行顺序与首行契约见 formatDashboardSuccessLines。
    for (const line of formatDashboardSuccessLines(r)) console.log(line);
    return;
  }
  const portFile = join(CONFIG_DIR, '.dashboard-port');
  const recordedPort = (existsSync(portFile) ? readFileSync(portFile, 'utf8').trim() : '')
    || process.env.BOTMUX_DASHBOARD_PORT
    || '7891';
  // Every non-terminal failure shape is reachable while the dashboard is still
  // booting, so ask ONCE whether a dashboard member is actually live and let that
  // decide the advice. Telling the operator to restart a healthy, still-booting
  // dashboard throws away the boot that was about to succeed — see
  // dashboardFailureIsTerminal for why `no-secret`/`wrong-service` are transient.
  const stillComingUp = dashboardFailureIsTerminal(r) ? false : await dashboardMemberComingUp();
  if (stillComingUp !== false) {
    console.error(formatDashboardUnreachable(recordedPort, stillComingUp));
    if (r.reason === 'wrong-service' && r.detail) console.error(`  详情: ${r.detail}`);
  } else if (r.reason === 'no-secret') {
    console.error('Dashboard not initialised. Run `botmux restart` first.');
  } else if (r.reason === 'unreachable') {
    console.error(formatDashboardUnreachable(recordedPort, false));
  } else if (r.reason === 'wrong-service') {
    // 127.0.0.1:<port> answered, but it isn't the dashboard (typically the
    // daemon IPC server holding a port the stale .dashboard-port points at),
    // and rediscovery across the probe range found no dashboard either.
    console.error(
      `127.0.0.1:${recordedPort} 上的服务不是 dashboard（端口文件 ~/.botmux/.dashboard-port 已失效，可能指向了 daemon IPC）。` +
      '运行 `botmux restart` 重启 dashboard 并刷新端口文件。',
    );
    if (r.detail) console.error(`  详情: ${r.detail}`);
  } else {
    console.error(formatDashboardFallbackFailure(action, r));
  }
  process.exit(1);
}

// ─── Session helpers ──────────────────────────────────────────────────────────

interface AdoptedFromData {
  source?: 'tmux' | 'herdr' | 'zellij';
  tmuxTarget?: string;
  zellijSession?: string;
  zellijPaneId?: string;
  herdrSessionName?: string;
  herdrTarget?: string;
  herdrPaneId?: string;
  originalCliPid?: number;
  sessionId?: string;
  cwd?: string;
  cliId?: string;
}

interface SessionData {
  sessionId: string;
  chatId: string;
  chatType?: 'group' | 'p2p';
  rootMessageId: string;
  /** 'thread' (legacy default) → cmdSend uses reply_in_thread to rootMessageId.
   *  'chat' → cmdSend posts a plain message to chatId (普通群整群一个会话). */
  scope?: 'thread' | 'chat';
  deferredScheduleRun?: DeferredScheduleRunData;
  vcMeetingReceiver?: {
    listenerAppId: string;
    meetingId: string;
    memberId: string;
    memberEpoch: number;
  };
  title: string;
  status: 'active' | 'closed';
  createdAt: string;
  lastMessageAt?: string;
  closedAt?: string;
  pid?: number;
  workingDir?: string;
  webPort?: number;
  larkAppId?: string;
  ownerOpenId?: string;
  ownerUnionId?: string;
  creatorOpenId?: string;
  lastCallerOpenId?: string;
  /** Chat-scope quote chain — see Session.quoteTargetId in types.ts. */
  quoteTargetId?: string;
  currentReplyTarget?: { rootMessageId: string; turnId: string; updatedAt: string; quoteOnly?: boolean; substitute?: boolean };
  /** Per-turn reply targets（见 Session.replyTargets in types.ts）——排队/并发轮次各自的回复锚点。 */
  replyTargets?: Record<string, { rootMessageId?: string; updatedAt: string; quoteOnly?: boolean; substitute?: boolean; senderOpenId?: string }>;
  /** Frozen per-turn reply contexts（见 Session.turnReplyContexts in types.ts）。
   *  `botmux send` 只读其中的 `inThread`：判断本轮 quote 目标当初是否从**顶层**
   *  进来，据此拦住「顶层 @ 之后那条消息才被开成话题」时 quote 把回复带进话题。 */
  turnReplyContexts?: Record<string, {
    target?: { mode?: string; chatId?: string; rootMessageId?: string };
    inThread?: boolean;
  }>;
  codexAppDispatchLedger?: CodexAppDispatchLedgerEntry[];
  codexAppGenerationCommits?: unknown;
  queued?: boolean;
  queuedActivationPending?: boolean;
  queuedActivationTail?: import('./types.js').QueuedActivationTailEntry[];
  pendingRepoSetup?: import('./types.js').PendingRepoSetup;
  /** Current persisted worker lifetime and its exact input-queue receipts. */
  workerGeneration?: number;
  dispatchInputReceipts?: Record<string, {
    rootMessageId: string;
    committedAt: string;
    workerGeneration: number;
  }>;
  replyThreadAliases?: { [rootMessageId: string]: { createdAt: string; lastUsedAt: string } };
  /** 文档评论入口 per-turn 回复落点（见 Session.docCommentTargets in types.ts）。 */
  docCommentTargets?: Record<string, { fileToken: string; fileType: string; commentId: string; replyToName?: string; replyToOpenId?: string; turnId: string; replyId?: string; reactionId?: string }>;
  quoteTargetSenderOpenId?: string;
  quoteTargetSenderIsBot?: boolean;
  whiteboardId?: string;
  goalSupervisor?: {
    goalChatId: string;
    title: string;
    parentChatId: string;
    parentRoot?: string;
    parentSessionId?: string;
    createdAt: string;
  };
  // Markers that a real CLI ever ran in this session (vs a daemon-command
  // scratch placeholder). Persisted by the daemon; only presence is checked
  // here, so they're typed loosely. Used by cmdList to avoid reporting an
  // unconfirmed /adopt scratch as a crashed CLI session.
  cliId?: string;
  /** CLI-native resume id when it differs from botmux's Session id. */
  cliSessionId?: string;
  backendType?: BackendType;
  /** Exact persistent host/agent selected by the worker. In particular, Herdr
   * may own one agent inside a shared host session rather than the host itself. */
  persistentBackendTarget?: PersistentBackendTarget;
  /** Live loopback (host, port) registered via `botmux preview <port>` for the
   * CURRENT worker generation — routing state, not conversation data. Offline
   * close must drop it like services/session-store.ts closeSession() does:
   * a closed session owns no port, and a retained value could proxy a later
   * reader into an unrelated local server that re-acquired the port. */
  previewTarget?: import('./core/session-preview.js').SessionPreviewTarget;
  lastCliInput?: string;
  adoptedFrom?: AdoptedFromData;
  /** Deliberately suspended by the resident-session cap. No process/backing
   * session is expected until the next message cold-resumes the CLI. */
  suspendedColdResume?: boolean;
}

/**
 * Resolve the session data directory.
 * Priority: SESSION_DATA_DIR env > daemon breadcrumb (~/.botmux/.data-dir) > default (~/.botmux/data)
 */
function resolveDataDir(): string {
  return resolveBotmuxDataDir();
}

/** Load sessions from all session files (legacy + per-bot). Snapshot mechanics
 * live in session-store; the CLI only supplies its own data-dir resolution and
 * the sandbox fallback appId (the file sandbox exposes sessions-<self>.json
 * but not a listing of data/). */
function loadSessions(): Map<string, SessionData> {
  return loadAllSessionsSnapshot({
    dataDir: resolveDataDir(),
    fallbackAppId: process.env.BOTMUX_LARK_APP_ID,
  }) as unknown as Map<string, SessionData>;
}

/** Offline-only narrow session mutation. Callers must prefer the owning daemon
 * while it is available; session-store rereads the exact row under the shared
 * session-file lock so stale CLI snapshots can never be written back. The
 * daemon-liveness probe runs under that same lock (entry + pre-publication) so
 * two CLIs cannot race each other and an already-published daemon cannot be
 * bypassed by the offline fallback. */
function mutateSessionOffline(
  session: SessionData,
  mutate: (current: SessionData) => boolean,
): SessionData | undefined {
  const larkAppId = session.larkAppId;
  return mutateSessionRowOffline(
    { sessionId: session.sessionId, ...(larkAppId ? { larkAppId } : {}) },
    current => mutate(current as unknown as SessionData),
    {
      dataDir: resolveDataDir(),
      ...(larkAppId
        ? {
            abortIf: () => {
              try { return !!findDaemon(larkAppId); } catch { return false; /* offline */ }
            },
          }
        : {}),
    },
  ) as unknown as SessionData | undefined;
}

type OfflineAbandonResult =
  | { ok: true; current: SessionData; cleanedBacking?: string }
  | { ok: false; error: string };

/** Offline explicit abandon stops the exact Botmux-owned worker, then closes
 * the newest durable row under the shared session-file lock. Provider-specific
 * backing cleanup remains owned by the dedicated backend lifecycle changes. */
async function abandonSessionOffline(session: SessionData): Promise<OfflineAbandonResult> {
  let current = mutateSessionOffline(session, () => false);
  if (!current) return { ok: false, error: 'owning_daemon_became_available' };

  const originalPid = adoptedCliPid(current);
  const ownedWorkerPid = current.pid && current.pid !== originalPid ? current.pid : undefined;
  if (ownedWorkerPid) {
    // Narrow the unavoidable descriptor race: do not signal a worker after an
    // owning daemon has become visible. The locked write below repeats this.
    if (current.larkAppId) {
      try {
        if (findDaemon(current.larkAppId)) {
          return { ok: false, error: 'owning_daemon_became_available' };
        }
      } catch { /* still offline */ }
    }
    if (isProcessAlive(ownedWorkerPid)) {
      const signalled = killProcess(ownedWorkerPid);
      if ((!signalled && isProcessAlive(ownedWorkerPid))
        || !(await waitForProcessExit(ownedWorkerPid))) {
        return { ok: false, error: `worker_pid_kill_failed:${ownedWorkerPid}` };
      }
    }

    // Persist worker-less state without touching FIFO authority. If a new
    // daemon/generation changed the row while SIGTERM settled, fail closed.
    let workerCleared = false;
    const afterStop = mutateSessionOffline(current, latest => {
      if (latest.pid !== ownedWorkerPid
        || isAdoptedSession(latest) !== isAdoptedSession(current!)) return false;
      delete latest.pid;
      workerCleared = true;
      return true;
    });
    if (!afterStop || !workerCleared) {
      return { ok: false, error: 'session_changed_while_stopping_worker' };
    }
    current = afterStop;
  } else {
    // Even without a Botmux worker pid, re-read after the first authority check
    // so the cleanup inputs are the newest locked backend/task lineage.
    const refreshed = mutateSessionOffline(current, () => false);
    if (!refreshed) return { ok: false, error: 'owning_daemon_became_available' };
    current = refreshed;
  }

  // Provider-specific backing teardown (no daemon to run killWorker()). Adopted
  // panes belong to the user and are never touched. This runs BEFORE the durable
  // close so a ZMX ownership-tag mismatch fails closed: refusing to hide the sole
  // control row while its CLI is still alive under a different owner.
  let cleanedBacking: string | undefined;
  if (!isAdoptedSession(current)) {
    if (isSuspendableBackendType(current.backendType)) {
      const target = resolvePersistentBackendTarget(
        current.backendType,
        current.sessionId,
        current.persistentBackendTarget,
      );
      try {
        killPersistentBackendTarget(target, current.sessionId);
        cleanedBacking = `${target.backendType}:${target.sessionName}`;
      } catch (err) {
        // ZMX destruction is identity-verified against the complete botmux
        // session UUID and waits for confirmed disappearance. Swallowing an
        // inconclusive/mismatched kill would hide the sole control row while
        // its CLI remains alive. Older mux backends keep their historical
        // best-effort offline-close compatibility.
        if (target.backendType === 'zmx') {
          return {
            ok: false,
            error: `ZMX 离线删除未完成：${err instanceof Error ? err.message : String(err)}`,
          };
        }
      }
    } else {
      // Legacy rows without backendType were historically tmux-backed.
      const tmuxName = `bmx-${current.sessionId.substring(0, 8)}`;
      try {
        execSync(`tmux kill-session -t '${tmuxName}' 2>/dev/null`, {
          stdio: 'ignore',
          env: tmuxEnv(),
        });
      } catch { /* no tmux session */ }
    }
  }

  let applied = false;
  const published = mutateSessionOffline(current, latest => {
    if (isAdoptedSession(latest) !== isAdoptedSession(current)) return false;
    if (latest.status === 'closed') {
      applied = true;
      return false;
    }
    latest.status = 'closed';
    latest.closedAt = new Date().toISOString();
    delete latest.codexAppDispatchLedger;
    delete latest.codexAppGenerationCommits;
    delete latest.queuedActivationPending;
    delete latest.queuedActivationTail;
    delete latest.pendingRepoSetup;
    delete latest.previewTarget;
    applied = true;
    return true;
  });
  if (!published || !applied) {
    return { ok: false, error: 'session_changed_during_offline_cleanup' };
  }

  return { ok: true, current: published, ...(cleanedBacking ? { cleanedBacking } : {}) };
}

function pruneSessionOfflineIfLedgerEmpty(session: SessionData): boolean {
  let pruned = false;
  mutateSessionOffline(session, current => {
    if (hasProtectedSessionMutationOwnership(current)) return false;
    current.status = 'closed';
    current.closedAt = new Date().toISOString();
    delete current.codexAppDispatchLedger;
    delete current.codexAppGenerationCommits;
    delete current.previewTarget;
    pruned = true;
    return true;
  });
  return pruned;
}

function patchSessionWhiteboardOffline(session: SessionData, whiteboardId: string): boolean {
  return !!mutateSessionOffline(session, current => {
    current.whiteboardId = whiteboardId;
    return true;
  });
}

async function postOwningDaemonSessionMutation(
  session: SessionData,
  suffix: 'close' | 'prune' | 'whiteboard',
  body?: Record<string, unknown>,
): Promise<'applied' | 'refused' | 'unavailable'> {
  if (!session.larkAppId) return 'unavailable';
  let daemon: ReturnType<typeof findDaemon>;
  try { daemon = findDaemon(session.larkAppId); } catch { return 'unavailable'; }
  if (!daemon) return 'unavailable';
  let secret: string;
  try { secret = loadDaemonIpcSecret(); } catch { return 'unavailable'; }
  const res = await fetchDaemonIpc(
    daemon.ipcPort,
    `/api/sessions/${encodeURIComponent(session.sessionId)}/${suffix}`,
    {
      method: 'POST',
      ...(body
        ? {
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          }
        : {}),
    },
    secret,
  );
  if (suffix === 'prune' && res.status === 409) return 'refused';
  if (!res.ok) {
    throw new Error(`owning daemon ${suffix} mutation failed: HTTP ${res.status}`);
  }
  return 'applied';
}

/**
 * A remote session the daemon closed LOCALLY but could not cancel.
 *
 * Carried all the way to the CLI/TUI: collapsing it into a plain success is the
 * same lie the daemon-side result matrix exists to prevent, just one process
 * boundary further out. JSON is `any` at this seam, so nothing but an explicit
 * read keeps it — the discriminant cannot help here.
 */
type AuthoritativeAbandonResult =
  | { ok: true; mode: 'daemon'; residual?: ParsedCloseResidual }
  | { ok: true; mode: 'offline'; current: SessionData; cleanedBacking?: string }
  | { ok: false; error?: string };

async function abandonSessionAuthoritatively(
  session: SessionData,
  online: DaemonDescriptorLite[] = listOnlineDaemons(),
): Promise<AuthoritativeAbandonResult> {
  // Legacy larkAppId-less rows live in sessions.json; a per-bot daemon writes
  // only its own sessions-<appId>.json and silently no-ops on close, so keep
  // them on the offline path (which persists to the legacy file correctly).
  if (session.larkAppId) {
    const daemon = online.find(d => d.larkAppId === session.larkAppId);
    const isCurrentSession = process.env.BOTMUX_SESSION_ID === session.sessionId;
    const injectedPort = isCurrentSession
      ? resolveDaemonIpcPort(undefined, process.env.BOTMUX_DAEMON_IPC_PORT)
      : undefined;
    const ipcPort = daemon?.ipcPort ?? injectedPort;
    if (ipcPort) {
      try {
        // Explicit abandon boundary: route through the owning daemon so the
        // ledger FIFO is cleared atomically with close. postSessionCliIpc carries
        // the trusted-host HMAC (non-isolated) OR this session's rotating origin
        // capability (sandboxed/read-isolated) so a sandboxed `delete <other-id>`
        // stays fail-closed at the daemon's sessionCliIpcAuth check.
        const res = await postSessionCliIpc(ipcPort, session.sessionId, 'close', {});
        const body = await res.json().catch(() => ({} as Record<string, unknown>));
        if (res.ok && (body as { ok?: unknown }).ok) {
          // Shared parser: a body that DECLARES a residual must warn even when the
          // `residual` object is missing/malformed, or a bad payload silently
          // becomes an ordinary success again.
          const residual = parseCloseResidual(body);
          return residual
            ? { ok: true, mode: 'daemon', residual }
            : { ok: true, mode: 'daemon' };
        }
        // Surface the daemon's own rejection reason (e.g. origin_unproven) and
        // never fall back to a partial local kill: a fresh descriptor means the
        // daemon may still hold authoritative in-memory state.
        return { ok: false, error: (body as { error?: string }).error ?? `HTTP ${res.status}` };
      } catch (err) {
        return { ok: false, error: `连接 daemon 失败: ${err instanceof Error ? err.message : String(err)}` };
      }
    }
  }
  const offline = await abandonSessionOffline(session);
  return offline.ok
    ? {
        ok: true,
        mode: 'offline',
        current: offline.current,
        ...(offline.cleanedBacking ? { cleanedBacking: offline.cleanedBacking } : {}),
      }
    : { ok: false, error: offline.error };
}

async function pruneSessionAuthoritatively(session: SessionData): Promise<boolean> {
  const result = await postOwningDaemonSessionMutation(session, 'prune');
  if (result === 'applied') return true;
  if (result === 'refused') return false;
  return pruneSessionOfflineIfLedgerEmpty(session);
}

async function patchSessionWhiteboardAuthoritatively(
  session: SessionData,
  whiteboardId: string,
): Promise<boolean> {
  const result = await postOwningDaemonSessionMutation(session, 'whiteboard', { whiteboardId });
  if (result === 'applied') return true;
  if (result === 'refused') return false;
  return patchSessionWhiteboardOffline(session, whiteboardId);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function killProcess(pid: number): boolean {
  try {
    process.kill(pid, 'SIGTERM');
    return true;
  } catch {
    return false;
  }
}

async function waitForProcessExit(pid: number, timeoutMs = 2_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return true;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  return !isProcessAlive(pid);
}

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h${minutes % 60}m`;
  const days = Math.floor(hours / 24);
  return `${days}d${hours % 24}h`;
}

/**
 * Get display width of a string in terminal cells.
 *
 * Delegates to a cross-terminal conservative width table (see terminal-width.ts):
 * for any real terminal the width returned is >= what it paints, so the picker's
 * `layoutWidth <= termWidth` genuinely implies rows never wrap. The previous
 * inline table only covered CJK/Hangul and under-counted emoji (🤖/🫠 as 1),
 * letting emoji session titles overflow a row, wrap onto a second physical line,
 * and push the pinned title off the alt-screen.
 *
 * NOTE: cursor-moving control chars (Tab/ESC/C0/C1) are NOT sized here — width
 * can't express a tab stop. Run text through `sanitizeCellText` first.
 */
function displayWidth(str: string): number {
  return terminalCellWidth(str);
}

/**
 * Strip everything that would move the cursor or otherwise desync column math
 * from dynamic text (session titles, working dirs, flash messages) before it is
 * measured or printed. A raw Tab jumps to the next tab stop and a raw ESC starts
 * a control sequence — both make a "one physical line" cell silently span more
 * columns (or lines) than displayWidth accounts for, wrapping the row and
 * pushing the pinned title off screen. Collapse them all to a single space:
 *   - C0 controls incl. Tab/CR/LF (U+0000–U+001F) and DEL (U+007F);
 *   - C1 controls (U+0080–U+009F);
 *   - stray ESC (U+001B) is covered by the C0 range.
 * (ANSI colour sequences the picker itself emits are added AFTER sanitizing, so
 * they are never fed through here.)
 */
function sanitizeCellText(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/[\x00-\x1F\x7F-\x9F]+/g, " ");
}

/** Truncate string to fit within maxWidth display columns, append '…' if truncated. */
function truncate(str: string, maxWidth: number): string {
  let width = 0;
  let i = 0;
  const chars = [...str];
  for (; i < chars.length; i++) {
    const cw = displayWidth(chars[i]);
    if (width + cw > maxWidth - 1) {  // reserve 1 col for '…'
      return chars.slice(0, i).join('') + '…';
    }
    width += cw;
  }
  return str;
}

/** Pad string to exact display width with trailing spaces. */
function padEndDisplay(str: string, targetWidth: number): string {
  const w = displayWidth(str);
  return w >= targetWidth ? str : str + ' '.repeat(targetWidth - w);
}

/** Load bot configs for display (best effort — returns empty array on failure) */
function loadBotConfigsForDisplay(): Array<{ larkAppId: string; cliId?: string }> {
  if (existsSync(BOTS_JSON_FILE)) {
    try { return JSON.parse(readFileSync(BOTS_JSON_FILE, 'utf-8')); } catch { /* ignore */ }
  }
  return [];
}


/** Format a single session row for display (used by both plain table and TUI). */
function formatSessionRow(
  s: SessionData,
  multiBot: boolean,
  botLabels: Map<string, string>,
  cols: { id: number; bot?: number; title: number; dir: number; pid: number; uptime: number; status: number; target: number },
  probeSnapshot: BackingProbeSnapshot,
): { text: string; alive: boolean } {
  const id = padEndDisplay(s.sessionId.substring(0, 8), cols.id);
  const parts = [id];
  if (multiBot) {
    const label = s.larkAppId ? (botLabels.get(s.larkAppId) ?? s.larkAppId.substring(0, 18)) : '-';
    parts.push(padEndDisplay(truncate(label, cols.bot!), cols.bot!));
  }
  const title = padEndDisplay(truncate((s.title || '(untitled)').replace(/[\r\n]+/g, ' '), cols.title), cols.title);
  const dir = padEndDisplay(truncate(s.workingDir || '-', cols.dir), cols.dir);
  const displayPid = sessionDisplayPid(s);
  const pid = displayPid ? String(displayPid).padEnd(cols.pid) : '-'.padEnd(cols.pid);
  const uptime = formatDuration(Date.now() - new Date(s.createdAt).getTime()).padEnd(cols.uptime);
  const alive = isSessionAliveForList(s);
  const status = padEndDisplay(sessionStatusLabel(s), cols.status);
  const target = padEndDisplay(truncate(sessionTargetLabel(s, probeSnapshot), cols.target), cols.target);
  parts.push(title, dir, pid, uptime, status, target);
  return { text: parts.join(' │ '), alive };
}

/** Print plain session table (non-interactive). */
function printSessionTable(active: SessionData[], probeSnapshot: BackingProbeSnapshot): void {
  const botConfigs = loadBotConfigsForDisplay();
  const multiBot = botConfigs.length > 1 || new Set(active.map(s => s.larkAppId).filter(Boolean)).size > 1;
  const botLabels = new Map<string, string>();
  for (let i = 0; i < botConfigs.length; i++) {
    const b = botConfigs[i];
    botLabels.set(b.larkAppId, `bot${i + 1} (${b.cliId ?? 'claude-code'})`);
  }

  const cols = { id: 10, ...(multiBot ? { bot: 22 } : {}), title: 28, dir: 28, pid: 8, uptime: 8, status: 8, target: 26 };

  const headerParts = ['id'.padEnd(cols.id)];
  if (multiBot) headerParts.push('bot'.padEnd(cols.bot!));
  headerParts.push(
    'title'.padEnd(cols.title),
    'working dir'.padEnd(cols.dir),
    'pid'.padEnd(cols.pid),
    'uptime'.padEnd(cols.uptime),
    'status'.padEnd(cols.status),
    'target'.padEnd(cols.target),
  );
  const header = headerParts.join(' │ ');
  const separator = '─'.repeat(displayWidth(header));

  console.log(separator);
  console.log(header);
  console.log(separator);

  for (const s of active) {
    const { text } = formatSessionRow(s, multiBot, botLabels, cols, probeSnapshot);
    console.log(text);
  }

  console.log(separator);
  console.log(`共 ${active.length} 个活跃会话`);
}

function applyTmuxWindowSizeLargest(sessionName: string): void {
  try {
    execFileSync('tmux', ['set-option', '-t', sessionName, 'window-size', 'largest'], {
      stdio: 'ignore',
      timeout: 3000,
      env: tmuxEnv(),
    });
  } catch { /* best-effort: attach can still proceed */ }
}

function isAdoptedSession(s: SessionData): s is SessionData & { adoptedFrom: AdoptedFromData } {
  return !!s.adoptedFrom && typeof s.adoptedFrom === 'object';
}

function adoptedCliPid(s: SessionData): number | undefined {
  const pid = isAdoptedSession(s) ? s.adoptedFrom.originalCliPid : undefined;
  return typeof pid === 'number' && pid > 0 ? pid : undefined;
}

function adoptTargetLabel(s: SessionData): string {
  if (!isAdoptedSession(s)) return '';
  const a = s.adoptedFrom;
  if (a.source === 'zellij' || a.zellijPaneId) {
    const target = a.zellijSession && a.zellijPaneId
      ? `${a.zellijSession}/${a.zellijPaneId}`
      : a.zellijPaneId || a.zellijSession || '?';
    return `adopt: zellij ${target}`;
  }
  if (a.source === 'herdr' || a.herdrSessionName || a.herdrPaneId || a.herdrTarget) {
    const pane = a.herdrTarget ?? a.herdrPaneId ?? '?';
    const target = a.herdrSessionName ? `${a.herdrSessionName}:${pane}` : pane;
    return `adopt: herdr ${target}`;
  }
  return `adopt: tmux ${a.tmuxTarget ?? '?'}`;
}

function sessionDisplayPid(s: SessionData): number | undefined {
  return adoptedCliPid(s) ?? s.pid;
}

function isSessionAliveForList(s: SessionData): boolean {
  const pid = sessionDisplayPid(s);
  return !!(pid && isProcessAlive(pid));
}

function sessionStatusLabel(s: SessionData): string {
  if (isAdoptedSession(s)) {
    const pid = adoptedCliPid(s);
    if (pid) return isProcessAlive(pid) ? 'adopt' : 'stopped';
    return s.pid && isProcessAlive(s.pid) ? 'adopt' : 'idle';
  }
  if (isColdResumeDormant(s) && !(s.pid && isProcessAlive(s.pid))) return 'dormant';
  return s.pid && isProcessAlive(s.pid) ? 'online' : s.pid ? 'stopped' : 'idle';
}

type BackingProbeSnapshot = ReadonlyMap<string, SessionProbe>;

function backingProbeKey(target: PersistentBackendTarget): string {
  const agentName = target.backendType === 'herdr' ? target.agentName ?? '' : '';
  return `${target.backendType}\0${target.sessionName}\0${agentName}`;
}

function sessionPersistentTarget(s: SessionData): PersistentBackendTarget | undefined {
  if (isSuspendableBackendType(s.backendType)) {
    return resolvePersistentBackendTarget(
      s.backendType,
      s.sessionId,
      s.persistentBackendTarget,
    );
  }
  if (s.backendType === undefined) {
    // Legacy rows predate backend stamping. Only tmux was externally
    // attachable, and its deterministic target remains the compatibility path.
    return {
      backendType: 'tmux',
      sessionName: `bmx-${s.sessionId.substring(0, 8)}`,
    };
  }
  return undefined;
}

function persistentTargetDisplay(target: PersistentBackendTarget): string {
  return target.backendType === 'herdr' && target.agentName
    ? `${target.sessionName}/${target.agentName}`
    : target.sessionName;
}

function buildBackingProbeSnapshot(sessions: readonly SessionData[]): BackingProbeSnapshot {
  const namesByBackend = new Map<PersistentBackendType, Set<string>>();
  const directTargets = new Map<string, PersistentBackendTarget>();
  const add = (target: PersistentBackendTarget) => {
    if (target.backendType === 'herdr' && target.agentName) {
      directTargets.set(backingProbeKey(target), target);
      return;
    }
    const backendType = target.backendType;
    const name = target.sessionName;
    const names = namesByBackend.get(backendType) ?? new Set<string>();
    names.add(name);
    namesByBackend.set(backendType, names);
  };

  for (const session of sessions) {
    if (isAdoptedSession(session) || session.backendType === 'pty') continue;
    const target = sessionPersistentTarget(session);
    if (target) add(target);
  }

  const snapshot = new Map<string, SessionProbe>();
  // Agent-scoped Herdr targets cannot be collapsed into a host-session probe:
  // the shared host may be healthy after this exact Botmux agent exited.
  for (const [key, target] of directTargets) {
    snapshot.set(key, probePersistentBackendTarget(target));
  }
  for (const [backendType, names] of namesByBackend) {
    for (const [name, probe] of probePersistentSessions(backendType, names)) {
      snapshot.set(backingProbeKey({ backendType, sessionName: name } as PersistentBackendTarget), probe);
    }
  }
  return snapshot;
}

function backingProbe(
  snapshot: BackingProbeSnapshot | undefined,
  target: PersistentBackendTarget,
): SessionProbe {
  return snapshot?.get(backingProbeKey(target))
    ?? probePersistentBackendTarget(target);
}

function sessionBackingInfo(s: SessionData, snapshot?: BackingProbeSnapshot): {
  backendType?: BackendType;
  target?: PersistentBackendTarget;
  probe: 'exists' | 'missing' | 'unknown';
  label: string;
  attachBackend?: 'tmux' | 'zmx';
} {
  if (isSuspendableBackendType(s.backendType)) {
    const target = sessionPersistentTarget(s)!;
    const probe = backingProbe(snapshot, target);
    const suffix = probe === 'exists' ? '' : ` (${probe})`;
    return {
      backendType: s.backendType,
      target,
      probe,
      label: `${s.backendType}: ${persistentTargetDisplay(target)}${suffix}`,
      attachBackend: s.backendType === 'tmux' || s.backendType === 'zmx'
        ? s.backendType
        : undefined,
    };
  }
  if (s.backendType === 'pty') {
    return { backendType: 'pty', probe: 'missing', label: 'pty' };
  }
  if (s.backendType === 'riff' || s.backendType === 'mojo') {
    // A remote backend (riff / mojo) runs its agent off-box, not in a local
    // multiplexer pane: there is nothing to probe, attach to, or name as a
    // PersistentBackendTarget (sessionPersistentTarget returns undefined for it, by
    // design). Surface a stable label and report the nonexistent local backing as
    // missing — exactly like pty — so it never slips into the legacy tmux branch
    // and dereferences an undefined target.
    //
    // Listed literally, not via isRemoteBackendType(): a boolean helper does not
    // narrow the union, and the exhaustiveness guard at the end of this function
    // depends on that narrowing. Adding a remote backend therefore fails to
    // compile here until it is listed — which is how mojo was caught.
    return { backendType: s.backendType, probe: 'missing', label: s.backendType };
  }
  if (s.backendType === undefined) {
    // Legacy rows predate backend stamping. Only tmux was externally attachable,
    // so its deterministic target remains the compatibility path.
    const target = sessionPersistentTarget(s)!;
    const probe = backingProbe(snapshot, target);
    return {
      backendType: 'tmux',
      target,
      probe,
      label: probe === 'exists' ? `tmux: ${target.sessionName}` : '-',
      attachBackend: 'tmux',
    };
  }
  // Exhaustiveness guard: every BackendType must be classified above. A future
  // non-suspendable backend added to BackendType will fail to compile here rather
  // than silently inheriting the legacy tmux target (the Riff crash's root cause).
  const _exhaustive: never = s.backendType;
  void _exhaustive;
  return { probe: 'missing', label: '-' };
}

function sessionTargetLabel(s: SessionData, snapshot?: BackingProbeSnapshot): string {
  if (isAdoptedSession(s)) return adoptTargetLabel(s);
  return sessionBackingInfo(s, snapshot).label;
}

function hasRecoverableBackingSession(s: SessionData, snapshot?: BackingProbeSnapshot): boolean {
  if (isSuspendableBackendType(s.backendType)) {
    // Unknown means the backend probe itself was inconclusive; keep the session
    // rather than closing a potentially recoverable conversation from `list`.
    // ZMX has one daemon per session. A clean "missing" result cannot
    // distinguish a host reboot from an individual CLI exit, so keep the
    // transcript-backed row for lazy resume instead of auto-pruning it.
    if (s.backendType === 'zmx') return true;
    const target = sessionPersistentTarget(s)!;
    const probe = backingProbe(snapshot, target);
    return probe === 'exists' || probe === 'unknown';
  }
  // Legacy sessions created before backendType stamping only had tmux recovery.
  const target = sessionPersistentTarget(s);
  return !!target && backingProbe(snapshot, target) === 'exists';
}

async function requestDormantSessionWake(
  session: SessionData,
  context: SessionListWakeRequestContext,
): Promise<
  | { ok: true }
  | { ok: false; error: string }
> {
  const online = listOnlineDaemons();
  const daemon = session.larkAppId
    ? online.find(d => d.larkAppId === session.larkAppId)
    : online.length === 1 ? online[0] : undefined;
  if (!daemon) {
    return {
      ok: false,
      error: session.larkAppId || online.length === 0
        ? '所属 daemon 不在线，请先运行 botmux status'
        : '历史会话缺少 bot 归属，多 daemon 环境下无法安全唤醒',
    };
  }

  try {
    const path = `/api/sessions/${encodeURIComponent(session.sessionId)}/wake`;
    const response = await fetchDaemonIpc(daemon.ipcPort, path, {
      method: 'POST',
      signal: context.signal,
      headers: { [SESSION_WAKE_DEADLINE_HEADER]: String(context.deadlineMs) },
    });
    const body: any = await response.json().catch(() => ({}));
    if (response.ok && body?.ok) return { ok: true };
    return { ok: false, error: body?.error ?? `HTTP ${response.status}` };
  } catch (err: any) {
    return { ok: false, error: err?.message ?? String(err) };
  }
}

/** Shorten path for display: replace $HOME with ~. */
function shortenPath(p: string): string {
  const home = homedir();
  return p.startsWith(home) ? '~' + p.slice(home.length) : p;
}

/** Interactive TUI session picker — returns a promise that resolves when done. */
function interactiveSessionPicker(active: SessionData[], probeSnapshot: BackingProbeSnapshot): Promise<void> {
  const botConfigs = loadBotConfigsForDisplay();
  const multiBot = botConfigs.length > 1 || new Set(active.map(s => s.larkAppId).filter(Boolean)).size > 1;
  const botLabels = new Map<string, string>();
  for (let i = 0; i < botConfigs.length; i++) {
    const b = botConfigs[i];
    botLabels.set(b.larkAppId, `bot${i + 1} (${b.cliId ?? 'claude-code'})`);
  }

  let layout: SessionPickerLayout = computeSessionPickerLayout(process.stdout.columns || 100, multiBot);

  // Build row data — use shortened paths for TUI
  function buildRows(): Array<{
    session: SessionData;
    text: string;
    alive: boolean;
    backendTarget?: PersistentBackendTarget;
    backingProbe: 'exists' | 'missing' | 'unknown';
    attachBackend?: 'tmux' | 'zmx';
    isAdopt: boolean;
    targetLabel: string;
    canAttach: boolean;
    canWake: boolean;
  }> {
    return active.map(s => {
      const isAdopt = isAdoptedSession(s);
      const backing = isAdopt
        ? { probe: 'missing' as const, label: adoptTargetLabel(s) }
        : sessionBackingInfo(s, probeSnapshot);
      const targetLabel = backing.label;
      const displayPid = sessionDisplayPid(s);
      const alive = isSessionAliveForList(s);
      const botLabel = s.larkAppId ? (botLabels.get(s.larkAppId) ?? s.larkAppId.substring(0, 16)) : '-';
      const cells: Record<SessionPickerColumnKey, string> = {
        id: s.sessionId.substring(0, 8),
        bot: botLabel,
        title: s.title || '(untitled)',
        dir: shortenPath(s.workingDir || '-'),
        pid: displayPid ? String(displayPid) : '-',
        uptime: formatDuration(Date.now() - new Date(s.createdAt).getTime()),
        status: sessionStatusLabel(s),
        target: targetLabel,
      };
      const text = layout.columns
        .map(column => {
          // Sanitize every cell (not just title): a Tab/ESC/control char in any
          // dynamic field would move the cursor and desync the one-line-per-row math.
          const value = sanitizeCellText(cells[column.key]);
          return padEndDisplay(truncate(value, column.width), column.width);
        })
        .join(' │ ');

      return {
        session: s,
        text,
        alive,
        backendTarget: 'target' in backing ? backing.target : undefined,
        backingProbe: backing.probe,
        attachBackend: 'attachBackend' in backing ? backing.attachBackend : undefined,
        isAdopt,
        targetLabel,
        canAttach: !isAdopt
          && backing.probe === 'exists'
          && !!('attachBackend' in backing && backing.attachBackend)
          && !!('target' in backing && backing.target),
        canWake: canWakeDormantBackendForAttach({
          isAdopt,
          probe: backing.probe,
          realManagedSession: isRealManagedSession(s),
          attachBackend: 'attachBackend' in backing ? backing.attachBackend : undefined,
          target: 'target' in backing ? backing.target : undefined,
        }),
      };
    });
  }

  let rows = buildRows();

  // Build header (same column layout as rows, no extra prefix in join)
  function buildHeader(): string {
    const labels: Record<SessionPickerColumnKey, string> = {
      id: 'id',
      bot: 'bot',
      title: 'title',
      dir: 'working dir',
      pid: 'pid',
      uptime: 'uptime',
      status: 'status',
      target: 'target',
    };
    return layout.columns
      .map(column => padEndDisplay(truncate(labels[column.key], column.width), column.width))
      .join(' │ ');
  }

  let header = buildHeader();
  let separator = '─'.repeat(displayWidth(header));

  let cursor = 0;
  let scrollTop = 0;              // index of the first visible row (vertical scroll)
  let confirmDelete = false;  // true when waiting for y/n confirmation
  // Transient status line. Stored as {style, text} where text is UNSTYLED and may
  // contain untrusted session metadata — it is sanitized + SGR-wrapped only at
  // render time, so a control char in `text` can never reach the terminal raw.
  type FooterStyle = 'error' | 'success' | 'warn' | 'dim';
  let flash: { style: FooterStyle; text: string } | null = null;

  // Fixed chrome around the scrolling row window: title(2) + header block(3) +
  // bottom separator(1) + target hint(2) + flash/confirm(2) + hints(2) + a
  // one-line safety margin so the final newline never scrolls the pinned title
  // off the alt-screen. Everything else is the row viewport.
  const CHROME_ROWS = 13;
  let sepWidth = displayWidth(separator);

  function rebuildLayout(): void {
    layout = computeSessionPickerLayout(process.stdout.columns || 100, multiBot);
    rows = buildRows();
    header = buildHeader();
    separator = '─'.repeat(displayWidth(header));
    sepWidth = displayWidth(separator);
  }
  // Overlay a "N 更多" marker onto a separator line without changing its display
  // width, so the up/down hidden-row counters cost no extra vertical lines.
  const sepWithMarker = (marker: string): string => {
    const label = ` ${marker} `;
    const lw = displayWidth(label);
    if (lw + 4 > sepWidth) return separator;
    return `──${label}${'─'.repeat(sepWidth - 2 - lw)}`;
  };

  const fitLine = (text: string, width: number): string => {
    if (width <= 0) return '';
    const singleLine = sanitizeCellText(text);
    return displayWidth(singleLine) <= width ? singleLine : truncate(singleLine, width);
  };
  // The ONLY place footer SGR colour is applied. `text` is treated as untrusted:
  // it is sanitized (control chars stripped) and width-fitted first, then wrapped
  // in a fixed whitelist SGR from `style`. No caller-supplied escape can survive,
  // and there is no fast path that returns a raw/mixed string — closing the two
  // bypasses where a session's target label / flash message could inject e.g.
  // `\x1b[2J` (clear screen) into the footer and scroll the pinned title away.
  const SGR: Record<FooterStyle, string> = {
    error: '\x1b[31m',
    success: '\x1b[32m',
    warn: '\x1b[33m',
    dim: '\x1b[2m',
  };
  const styledFooter = (style: FooterStyle, text: string, width: number): string =>
    `${SGR[style]}${fitLine(text, width)}\x1b[0m`;
  const blankRowPrefix = (): string => ' '.repeat(layout.prefixWidth);
  const rowPrefix = (selected: boolean): string => {
    if (!selected) return blankRowPrefix();
    const pointer = '\x1b[36m❯\x1b[0m';
    if (layout.prefixWidth >= 4) return `  ${pointer} `;
    if (layout.prefixWidth === 3) return ` ${pointer} `;
    if (layout.prefixWidth === 2) return `${pointer} `;
    return layout.prefixWidth === 1 ? pointer : '';
  };
  const footerPrefixWidth = (): number => Math.min(2, layout.termWidth);
  const footerContentWidth = (): number => Math.max(0, layout.termWidth - footerPrefixWidth());
  const footerPrefix = (): string => ' '.repeat(footerPrefixWidth());

  function render(): void {
    process.stdout.write('\x1b[H\x1b[J');

    const posLabel = rows.length > 0 ? `${cursor + 1}/${rows.length}` : '0';
    const titleText = ` botmux sessions  (${posLabel})`;
    if (displayWidth(titleText) <= layout.termWidth) {
      process.stdout.write(`\x1b[1m botmux sessions\x1b[0m  \x1b[2m(${posLabel})\x1b[0m\n\n`);
    } else {
      process.stdout.write(`\x1b[1m${fitLine(titleText, layout.termWidth)}\x1b[0m\n\n`);
    }

    if (rows.length === 0) {
      process.stdout.write(`${blankRowPrefix()}${separator}\n`);
      process.stdout.write(`${blankRowPrefix()}\x1b[2m${header}\x1b[0m\n`);
      process.stdout.write(`${blankRowPrefix()}${separator}\n`);
      process.stdout.write(`\n${blankRowPrefix()}\x1b[2m${fitLine('没有活跃会话', Math.max(0, layout.termWidth - layout.prefixWidth))}\x1b[0m\n`);
      process.stdout.write(`${blankRowPrefix()}${separator}\n`);
      process.stdout.write(`\n${footerPrefix()}\x1b[2m${fitLine('q 退出', footerContentWidth())}\x1b[0m\n`);
      return;
    }

    // Vertical viewport: render only the window of rows that fits the terminal
    // height, scrolling to keep the cursor visible. Without this a long session
    // list overflows the alt-screen and pushes the title/header/top rows off it.
    const win = computeSessionPickerScrollWindow({
      cursor,
      scrollTop,
      rowCount: rows.length,
      termRows: process.stdout.rows || 24,
      chromeRows: CHROME_ROWS,
    });
    scrollTop = win.scrollTop;
    const { viewEnd, hiddenAbove, hiddenBelow } = win;

    // Header + separator — use the same responsive prefix as rows.
    process.stdout.write(`${blankRowPrefix()}${separator}\n`);
    process.stdout.write(`${blankRowPrefix()}\x1b[2m${header}\x1b[0m\n`);
    process.stdout.write(hiddenAbove > 0
      ? `${blankRowPrefix()}\x1b[36m${sepWithMarker(`↑ ${hiddenAbove} 更多`)}\x1b[0m\n`
      : `${blankRowPrefix()}${separator}\n`);

    for (let i = scrollTop; i < viewEnd; i++) {
      const r = rows[i];
      if (i === cursor) {
        process.stdout.write(`${rowPrefix(true)}\x1b[7m${r.text}\x1b[0m\n`);
      } else {
        process.stdout.write(`${rowPrefix(false)}${r.text}\n`);
      }
    }

    process.stdout.write(hiddenBelow > 0
      ? `${blankRowPrefix()}\x1b[36m${sepWithMarker(`↓ ${hiddenBelow} 更多`)}\x1b[0m\n`
      : `${blankRowPrefix()}${separator}\n`);

    // Footer info. Every dynamic field (targetLabel, backend session name) is
    // untrusted session metadata, so it only ever reaches the terminal via
    // styledFooter (sanitize → fit → whitelist SGR). The adopt hint's fixed
    // suffix is trusted static text, appended after the fitted label.
    const selected = rows[cursor];
    const width = footerContentWidth();
    let footerLine: string;
    if (selected.isAdopt) {
      const suffix = '  Enter 已禁用；请直接使用原 tmux/zellij/herdr 客户端。';
      const labelWidth = Math.max(0, width - displayWidth(suffix));
      footerLine = `${styledFooter('warn', selected.targetLabel, labelWidth)}\x1b[2m${fitLine(suffix, width)}\x1b[0m`;
    } else if (selected.canAttach) {
      footerLine = styledFooter('success', `${selected.attachBackend}: ${selected.backendTarget?.sessionName}`, width);
    } else if (selected.canWake) {
      footerLine = styledFooter('warn', `${selected.targetLabel}（Enter 恢复并连接）`, width);
    } else {
      footerLine = styledFooter('dim', `${selected.targetLabel}（不可连接）`, width);
    }
    process.stdout.write(`\n${footerPrefix()}${footerLine}\n`);

    // Flash message or confirmation prompt
    if (confirmDelete) {
      const s = selected.session;
      const confirmation = `确认删除 ${s.sessionId.substring(0, 8)} "${truncate(s.title || '', 20)}"? (y/n)`;
      process.stdout.write(`\n${footerPrefix()}${styledFooter('warn', confirmation, width)}\n`);
    } else if (flash) {
      process.stdout.write(`\n${footerPrefix()}${styledFooter(flash.style, flash.text, width)}\n`);
    } else {
      process.stdout.write('\n');
    }

    // Keybinding hints
    const enterAction = selected?.canAttach ? '连接' : selected?.canWake ? '恢复' : '不可连接';
    const fullHints = `↑/↓ 选择  ⏎ ${enterAction}  d 删除  q 退出`;
    const compactHints = '↑/↓ 选择  ⏎  d  q';
    const hints = displayWidth(fullHints) <= width ? fullHints : compactHints;
    process.stdout.write(`\n${footerPrefix()}${styledFooter('dim', hints, width)}\n`);
  }

  return new Promise<void>((resolve) => {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf-8');

    process.stdout.write('\x1b[?25l');   // hide cursor
    process.stdout.write('\x1b[?1049h'); // alt screen

    render();

    // Rebuild both axes on resize: rows/header must use the current columns or
    // stale wide lines wrap and invalidate the vertical one-row-per-session math.
    const onResize = (): void => {
      rebuildLayout();
      render();
    };
    process.stdout.on('resize', onResize);

    let deleteInFlight = false;
    let wakeInFlight = false;
    let wakeAbortController: AbortController | null = null;
    let pickerClosed = false;

    function cleanup(): void {
      if (pickerClosed) return;
      pickerClosed = true;
      wakeAbortController?.abort();
      wakeAbortController = null;
      process.stdin.off('data', onInput);
      process.stdout.off('resize', onResize);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write('\x1b[?25h');   // show cursor
      process.stdout.write('\x1b[?1049l'); // leave alt screen
    }

    async function deleteSession(idx: number): Promise<void> {
      const r = rows[idx];
      const s = r.session;

      // Explicit delete is the abandon boundary. Prefer the owning daemon so
      // its current in-memory FIFO is cleared atomically with close; offline
      // fallback rereads the exact row and clears the latest ledger/commits.
      const result = await abandonSessionAuthoritatively(s);
      if (!result.ok) {
        flash = { style: 'error', text: `✗ 删除失败: ${result.error}` };
        return;
      }
      // A live daemon owns process/pane teardown and has re-resolved the latest
      // generation. Only the locked offline path may clean up resources, using
      // the freshly-read row rather than this TUI's stale snapshot.

      // Remove from active list and TUI rows
      const activeIdx = active.indexOf(s);
      if (activeIdx >= 0) active.splice(activeIdx, 1);
      rows.splice(idx, 1);

      if (cursor >= rows.length) cursor = Math.max(0, rows.length - 1);
      // master's flash-object footer; the daemon/offline discriminant on
      // abandonSessionAuthoritatively is `mode` (see its return type ~3573),
      // NOT master's `via` — that belongs to a different helper.
      flash = result.mode === 'daemon'
        ? (result.residual
          // Local row closed, remote session still running: never the green
          // "deleted" text, or the operator walks away from a live agent that
          // still holds the injected credential.
          ? {
            style: 'warn',
            text: `⚠ 本地已删除 ${s.sessionId.substring(0, 8)}，但${closeResidualClause(result.residual)}`,
          }
          : { style: 'success', text: `✓ 已删除 ${s.sessionId.substring(0, 8)}` })
        : { style: 'warn', text: `✓ 已离线删除 ${s.sessionId.substring(0, 8)}` };
    }

    async function onInput(key: string): Promise<void> {
      // Exit always wins, including while the wake HTTP or backend probe is
      // pending. cleanup aborts the shared deadline signal before restoring
      // the terminal, so Ctrl-C/q/Esc can never be swallowed by in-flight work.
      if (key === '\x03' || key === 'q' || key === '\x1b') {
        cleanup();
        resolve();
        return;
      }
      if (deleteInFlight || wakeInFlight) return;
      // Delete confirmation mode
      if (confirmDelete) {
        confirmDelete = false;
        if (key === 'y' || key === 'Y') {
          deleteInFlight = true;
          try { await deleteSession(cursor); }
          finally { deleteInFlight = false; }
        } else {
          flash = { style: 'dim', text: '取消删除' };
        }
        if (!pickerClosed) render();
        return;
      }

      flash = null;

      if (rows.length === 0) {
        // No sessions left, only q works
        render();
        return;
      }

      // Arrow up or k
      if (key === '\x1b[A' || key === 'k') {
        cursor = (cursor - 1 + rows.length) % rows.length;
        render();
        return;
      }

      // Arrow down or j
      if (key === '\x1b[B' || key === 'j') {
        cursor = (cursor + 1) % rows.length;
        render();
        return;
      }

      // d or x — delete session
      if (key === 'd' || key === 'x') {
        confirmDelete = true;
        render();
        return;
      }

      // Enter — attach to a managed persistent backend.
      if (key === '\r' || key === '\n') {
        const selected = rows[cursor];
        if (selected.isAdopt) {
          flash = { style: 'warn', text: `这是 adopt 会话；botmux 不 attach 用户 pane。目标: ${selected.targetLabel}` };
          render();
          return;
        }
        if (!selected.canAttach && !selected.canWake) {
          flash = { style: 'warn', text: '该会话没有可连接的持久后端' };
          render();
          return;
        }
        if (selected.canWake) {
          const target = selected.backendTarget;
          if (!target) {
            flash = { style: 'error', text: '恢复目标缺失' };
            render();
            return;
          }
          wakeInFlight = true;
          const wakeController = new AbortController();
          wakeAbortController = wakeController;
          flash = { style: 'warn', text: `正在恢复 ${target.backendType}: ${persistentTargetDisplay(target)}…` };
          render();
          const recovered = await wakeDormantBackendForAttach({
            target,
            wake: context => requestDormantSessionWake(selected.session, context),
            probe: probePersistentBackendTarget,
            signal: wakeController.signal,
          });
          if (wakeAbortController === wakeController) wakeAbortController = null;
          wakeInFlight = false;
          if (pickerClosed) return;
          if (!recovered.ok) {
            flash = { style: 'error', text: `恢复失败: ${recovered.error}` };
            render();
            return;
          }
        }
        if (selected.attachBackend === 'zmx') {
          const target = selected.backendTarget;
          if (!target || target.backendType !== 'zmx') {
            flash = { style: 'error', text: 'ZMX attach target is missing or inconsistent' };
            render();
            return;
          }
          // First prove both complete Botmux labels while the picker is still
          // active, then freeze the PTY root generation across terminal
          // cleanup and re-prove it immediately before attach.
          const frozen = freezeManagedZmxAttachTarget(
            target.sessionName,
            selected.session.sessionId,
          );
          if (!frozen.ok) {
            flash = { style: 'error', text: frozen.message };
            render();
            return;
          }
          cleanup();
          const attached = attachFrozenManagedZmxSession(
            target.sessionName,
            selected.session.sessionId,
            frozen.pid,
          );
          if (!attached.ok) console.error(attached.message);
        } else {
          const target = selected.backendTarget;
          if (!target || target.backendType !== 'tmux') {
            flash = { style: 'error', text: 'tmux attach target is missing or inconsistent' };
            render();
            return;
          }
          cleanup();
          applyTmuxWindowSizeLargest(target.sessionName);
          spawnSync('tmux', ['attach-session', '-t', `=${target.sessionName}`], {
            stdio: 'inherit',
            env: tmuxEnv(),
          });
        }
        resolve();
        return;
      }
    }

    process.stdin.on('data', onInput);
  });
}

/**
 * Internal host-only bridge used by Dashboard "Open CLI" commands. The
 * generated terminal shell executes this exact checkout's cli.js, keeping all
 * ZMX ownership checks in TypeScript instead of approximating them with
 * name-only shell pipelines.
 */
function cmdManagedZmxAttach(args: string[]): void {
  const [name, sessionId, ...extra] = args;
  if (!name?.trim() || !sessionId?.trim() || extra.length > 0) {
    console.error('internal usage: __zmx-attach-managed <session-name> <complete-session-id>');
    process.exitCode = 2;
    return;
  }
  const frozen = freezeManagedZmxAttachTarget(name, sessionId);
  if (!frozen.ok) {
    console.error(frozen.message);
    process.exitCode = 1;
    return;
  }
  const attached = attachFrozenManagedZmxSession(name, sessionId, frozen.pid);
  if (!attached.ok) {
    console.error(attached.message);
    process.exitCode = 1;
  }
}

async function cmdList(): Promise<void> {
  const sessions = loadSessions();
  const active = [...sessions.values()].filter(s => s.status === 'active');
  // One immutable control-plane snapshot per invocation. In particular, ZMX's
  // full-list probe walks every per-session daemon, so running it once per row
  // would make a large session list quadratic and amplify socket timeouts.
  const probeSnapshot = buildBackingProbeSnapshot(active);

  // Auto-prune unrecoverable sessions: process dead and no recoverable backing
  // session (tmux/herdr/zellij/zmx).
  // Split into two buckets so a never-activated daemon-command scratch (e.g. an
  // unconfirmed /adopt that only posted a picker card, /help, an abandoned
  // /relay picker) isn't reported as a crashed CLI. Such a scratch never forked
  // a worker, so it has no cliId / lastCliInput / adoptedFrom — the same "was it
  // ever a real CLI session" markers isRelayableRealSession uses. Closing it is
  // fine, but the "进程已死且无 tmux session" notice wrongly implies a CLI ran
  // and crashed, which is exactly the confusing output users hit after /adopt.
  const pruned: SessionData[] = [];
  const prunedScratch: SessionData[] = [];
  const live: SessionData[] = [];
  for (const s of active) {
    if (isAdoptedSession(s)) {
      const pid = adoptedCliPid(s);
      if (pid && isProcessAlive(pid)) {
        live.push(s);
      } else if (pid) {
        pruned.push(s);
      } else {
        const hasPid = !!(s.pid && isProcessAlive(s.pid));
        hasPid ? live.push(s) : pruned.push(s);
      }
      continue;
    }

    const hasPid = !!(s.pid && isProcessAlive(s.pid));
    const hasBackingSession = hasRecoverableBackingSession(s, probeSnapshot);
    const disposition = sessionListDisposition(s, { hasPid, hasBackingSession });
    // Non-adopt sessions are only ever kept or pruned-as-scratch now: a real
    // managed session with a missing backing is dormant-recoverable, never
    // auto-closed by this read command (see sessionListDisposition). Adopt
    // zombies still reach the `pruned` bucket via the branch above.
    if (disposition === 'prune_scratch') prunedScratch.push(s);
    else live.push(s);
  }
  const closeNow = async (arr: SessionData[], kind: 'scratch' | 'real'): Promise<number> => {
    let closed = 0;
    for (const s of arr) {
      if (await pruneSessionAuthoritatively(s)) {
        closed++;
      } else {
        // The owning daemon observed a newly unsettled FIFO after this CLI's
        // liveness snapshot, or still has the row in memory. Keep it visible
        // instead of abandoning it: mutating only the store here would let the
        // next message resurrect exactly the session auto-prune claimed to close.
        live.push(s);
        console.warn(
          `⚠️ 未自动清理 ${kind === 'scratch' ? '占位' : '会话'} ${s.sessionId.substring(0, 8)}：owner 仍持有该会话或存在未结算派发`,
        );
      }
    }
    return closed;
  };
  // Scratches: close silently — they were placeholders, not dead sessions.
  await closeNow(prunedScratch, 'scratch');
  if (pruned.length > 0) {
    const prunedCount = await closeNow(pruned, 'real');
    if (prunedCount > 0) {
      console.log(`已自动清理 ${prunedCount} 个不可恢复的会话（进程已退出或无可恢复后端）`);
    }
  }

  // Sort by creation time, newest first
  live.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  if (live.length === 0) {
    console.log('没有活跃会话。');
    return;
  }

  // Non-TTY (piped output) or explicit --plain flag: plain table
  if (!process.stdout.isTTY || process.argv.includes('--plain')) {
    printSessionTable(live, probeSnapshot);
    return;
  }

  // Interactive TUI
  await interactiveSessionPicker(live, probeSnapshot);
}

async function cmdDelete(): Promise<void> {
  const target = process.argv[3];
  if (!target) {
    console.error('用法: botmux delete <session-id|all>');
    process.exit(1);
  }

  const sessions = loadSessions();
  const active = [...sessions.values()].filter(s => s.status === 'active');

  if (active.length === 0) {
    console.log('没有活跃会话。');
    return;
  }

  let toDelete: SessionData[];

  if (target === 'all') {
    toDelete = active;
  } else if (target === 'stopped') {
    toDelete = active.filter(s => {
      // "stopped" = a true zombie the sweep may auto-close. A real managed
      // session with no live pid is dormant-recoverable, NOT stopped: whether
      // the CLI merely exited, botmux cap-suspended it, or a host reboot wiped
      // its backing pane, the on-disk transcript still cold-resumes on the next
      // message. So a missing backing is NOT a close trigger here — only an
      // adopted session with a dead external pid, or a disposable scratch that
      // never became a real CLI session, counts as stopped. Reuses the exact
      // real-vs-scratch discriminator the server-side isSessionStopped and
      // `botmux list` prune both use, so the three entry points can't drift.
      if (isColdResumeDormant(s)) return false;
      if (isAdoptedSession(s)) {
        const pid = adoptedCliPid(s);
        return pid ? !isProcessAlive(pid) : !(s.pid && isProcessAlive(s.pid));
      }
      const hasPid = !!(s.pid && isProcessAlive(s.pid));
      return !hasPid && !isRealManagedSession(s);
    });
    if (toDelete.length === 0) {
      console.log('没有 stopped 状态的会话。');
      return;
    }
  } else {
    // Match by session ID prefix
    toDelete = active.filter(s => s.sessionId.startsWith(target));
    if (toDelete.length === 0) {
      console.error(`❌ 未找到匹配 "${target}" 的活跃会话`);
      console.error('   使用 botmux list 查看所有会话');
      process.exit(1);
    }
    if (toDelete.length > 1) {
      console.error(`❌ "${target}" 匹配了 ${toDelete.length} 个会话，请提供更长的 ID 前缀：`);
      for (const s of toDelete) {
        console.error(`   ${s.sessionId.substring(0, 8)}  ${s.title}`);
      }
      process.exit(1);
    }
  }

  // A self-delete may tear down the process running this loop. Put it last so
  // `delete all` still closes every other target before the current session.
  const currentSessionId = process.env.BOTMUX_SESSION_ID;
  if (currentSessionId && toDelete.length > 1) {
    toDelete.sort((a, b) => Number(a.sessionId === currentSessionId) - Number(b.sessionId === currentSessionId));
  }

  let closed = 0;
  let offline = 0;
  let failed = 0;
  let residual = 0;
  for (const s of toDelete) {
    // Explicit abandon boundary: route through the owning daemon so the ledger
    // FIFO is cleared atomically with close; offline fallback rereads the row
    // and clears the latest ledger/commits.
    const result = await abandonSessionAuthoritatively(s);
    if (!result.ok) {
      console.error(`✗ ${s.sessionId.substring(0, 8)} ${s.title}${result.error ? `: ${result.error}` : ''}`);
      failed++;
      continue;
    }
    closed++;
    if (result.mode === 'offline') {
      offline++;
      if (result.cleanedBacking) console.log(`  killed ${result.cleanedBacking}`);
    }
    if (result.mode === 'daemon' && result.residual) {
      // Local row closed, remote session NOT cancelled. Reported per session AND
      // counted in the summary, so a bulk delete cannot bury it.
      residual++;
      console.warn(
        `⚠ ${s.sessionId.substring(0, 8)} ${s.title}：本地已关闭，但${closeResidualClause(result.residual)}`,
      );
      continue;
    }
    console.log(`✓ ${s.sessionId.substring(0, 8)} ${s.title}${result.mode === 'offline' ? '（daemon 离线，本地收口）' : ''}`);
  }
  console.log(`\n已关闭 ${closed} 个会话${offline ? `（${offline} 个离线收口）` : ''}${failed ? `，${failed} 个失败` : ''}${residual ? `，${residual} 个有残留需人工清理` : ''}`);
  if (failed > 0) process.exitCode = 1;
}

/**
 * `botmux suspend` — 手动挂起活跃会话：杀掉 worker + CLI/pane，但会话保持
 * active，下条消息从 transcript 冷恢复（--resume 续上下文）。与 idle-worker
 * sweeper 超额挂起是同一语义（daemon 侧 /api/sessions/:id/suspend 复用
 * suspendWorker）。主要用途：`botmux suspend --isolated` —— 凭证轮换
 * （如 `claude /login`）后冷重启全部读隔离 bot，让下次 spawn 的 provisioning
 * 自动同步最新凭证。
 */
async function cmdSuspend(): Promise<void> {
  const argv = process.argv.slice(3);
  const dryRun = argv.includes('--dry-run');
  const isolated = argv.includes('--isolated');
  const botIdx = argv.indexOf('--bot');
  const botAppId = botIdx >= 0 ? argv[botIdx + 1] : undefined;
  // Exclude the --bot VALUE only when --bot is actually present; otherwise botIdx=-1
  // makes botIdx+1=0 and wrongly drops the first positional (the session-id / `all`).
  const positional = argv.filter((a, i) => !a.startsWith('--') && !(botIdx >= 0 && i === botIdx + 1));
  const target = positional[0];

  if (!target && !botAppId && !isolated) {
    console.error('用法: botmux suspend <session-id|all> | --bot <appId> | --isolated  [--dry-run]');
    console.error('  挂起后会话保持 active，下条消息冷启动（--resume 续上下文）');
    console.error('  --isolated  挂起所有 readIsolation=true bot 的活跃会话（凭证轮换后用，');
    console.error('              下次冷启动由 provisioning 自动同步最新登录凭证）');
    process.exit(1);
  }

  const sessions = loadSessions();
  let matched = [...sessions.values()].filter(s => s.status === 'active');

  if (isolated) {
    const bots = loadBotConfigsForDisplay() as Array<{ larkAppId: string; readIsolation?: boolean }>;
    const isoIds = new Set((Array.isArray(bots) ? bots : []).filter(b => b?.readIsolation === true).map(b => b.larkAppId));
    if (isoIds.size === 0) {
      console.log('没有 readIsolation=true 的 bot，无事可做。');
      return;
    }
    matched = matched.filter(s => s.larkAppId && isoIds.has(s.larkAppId));
  } else if (botAppId) {
    matched = matched.filter(s => s.larkAppId === botAppId);
  } else if (target !== 'all') {
    matched = matched.filter(s => s.sessionId.startsWith(target!));
    if (matched.length === 0) {
      console.error(`❌ 未找到匹配 "${target}" 的活跃会话（botmux list 查看）`);
      process.exit(1);
    }
    if (matched.length > 1) {
      console.error(`❌ "${target}" 匹配了 ${matched.length} 个会话，请提供更长的 ID 前缀：`);
      for (const s of matched) console.error(`   ${s.sessionId.substring(0, 12)}  ${s.title}`);
      process.exit(1);
    }
  }

  if (matched.length === 0) {
    console.log('没有匹配的活跃会话。');
    return;
  }

  const online = listOnlineDaemons();
  let suspended = 0, deferred = 0, skipped = 0, failed = 0;

  // dry-run 的预告要复刻 suspend 路由的分类，而这些判据（实时屏幕状态、是否还有
  // 存活 worker、backend、adopt）本地 session store 全都没有。每个 daemon 只拉一次
  // /api/sessions 拿 dashboard 行；拉不到就退回不带判据的旧预告，dry-run 不该因为
  // 一个 daemon 抽风而失败。
  const daemonRows = new Map<number, Map<string, any> | null>();
  let dryRunDegraded = false;
  // daemon 不在线是**确定可知**的结果，不是未知：真实循环在发请求之前就会因
  // findDaemon() 为空而跳过。只有「daemon 在线但 /api/sessions 读不到」才是真未知。
  // 早期版本把这两种混成一个 undefined，于是 listener 那类伪 app id（无对应 daemon）
  // 的会话被报成「未知」——实测 20/516 条这样的信息损失，而它们的真实结果是"跳过"。
  type Lookup =
    | { kind: 'row'; row: any | undefined }
    | { kind: 'no_daemon'; larkAppId?: string }
    | { kind: 'unreadable' };
  const lookupRow = async (sessionId: string, larkAppId?: string): Promise<Lookup> => {
    const daemon = findDaemon(larkAppId);
    if (!daemon) return { kind: 'no_daemon', larkAppId };
    if (!daemonRows.has(daemon.ipcPort)) {
      try {
        const res = await fetchDaemonIpc(daemon.ipcPort, '/api/sessions', { method: 'GET' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body: any = await res.json();
        const rows: any[] = Array.isArray(body?.sessions) ? body.sessions : [];
        daemonRows.set(daemon.ipcPort, new Map(rows.filter(r => r?.sessionId).map(r => [r.sessionId, r])));
      } catch { daemonRows.set(daemon.ipcPort, null); }
    }
    const map = daemonRows.get(daemon.ipcPort);
    if (!map) { dryRunDegraded = true; return { kind: 'unreadable' }; }
    return { kind: 'row', row: map.get(sessionId) };
  };
  // 复刻 dashboard-ipc-server 的 suspend 路由分支顺序。行拿不到时返回 undefined
  // （预告降级为"未知"），绝不猜一个确定的结论。
  //
  // ⚠️ 一个分支复刻不了：路由的第一道守卫是 `isSessionTransferring` → 409，而
  // /api/sessions 的行不暴露 transfer 状态。正在 routing transfer 中的会话会被这里
  // 预告成 排队/挂起，实际执行拿到 `session_transferring`。transfer 是短暂窗口，
  // 为一个 dry-run 预告给 SessionRow 加字段不成比例；如果以后行里有了该状态，
  // 在 adopt 之前补一条分支即可。
  const SUSPENDABLE_BACKENDS = new Set(['tmux', 'herdr', 'zellij', 'zmx']);
  type Prediction = 'defer' | 'suspend' | 'no_worker' | 'refuse' | 'skip_no_daemon' | 'unknown';
  const predictSuspend = (lk: Lookup): Prediction => {
    if (lk.kind === 'no_daemon') return 'skip_no_daemon';
    if (lk.kind === 'unreadable') return 'unknown';
    const row = lk.row;
    // 会话在本地 store 里是 active，但 daemon 的行里没有它——判不出走哪条分支。
    if (!row) return 'unknown';
    if (row.adopt) return 'refuse';                          // adopt_suspend_unsupported
    if (row.status === 'dormant' || row.status === 'closed') return 'no_worker';
    if (!SUSPENDABLE_BACKENDS.has(row.backendType)) return 'refuse';  // backend_not_suspendable
    if (row.status === 'working' || row.status === 'analyzing') return 'defer';
    return 'suspend';
  };

  for (const s of matched) {
    const label = `${s.sessionId.substring(0, 8)}  ${s.title ?? ''}`.trimEnd();
    if (dryRun) {
      // 真实循环的第一道跳过在发请求之前，dry-run 也要照抄，否则这类会被误报。
      if (!s.larkAppId && online.length > 1) {
        console.log(`· 将跳过（缺 larkAppId，多 daemon 无法判定归属）: ${label}`);
        skipped++;
        continue;
      }
      const predicted = predictSuspend(await lookupRow(s.sessionId, s.larkAppId));
      switch (predicted) {
        case 'defer': console.log(`· 将排队（正在回复，完成后自动挂起）: ${label}`); deferred++; break;
        case 'suspend': console.log(`· 将挂起: ${label}`); break;
        case 'no_worker': console.log(`· 将跳过（本就无存活 CLI）: ${label}`); skipped++; break;
        case 'refuse': console.log(`· 将拒绝（adopt / 不可挂起 backend）: ${label}`); failed++; break;
        case 'skip_no_daemon':
          console.log(`· 将跳过（daemon 不在线${s.larkAppId ? `: ${s.larkAppId}` : ''}）: ${label}`);
          skipped++;
          break;
        default: console.log(`? 未知（daemon 在线但状态读不到，无法预告）: ${label}`); break;
      }
      continue;
    }
    // 旧会话缺 larkAppId 时多 daemon 下无法判定归属，跳过而不是误路由。
    if (!s.larkAppId && online.length > 1) {
      console.log(`- 跳过（缺 larkAppId，多 daemon 无法判定归属）: ${label}`);
      skipped++;
      continue;
    }
    const daemon = findDaemon(s.larkAppId);
    if (!daemon) {
      console.log(`- 跳过（daemon 不在线${s.larkAppId ? `: ${s.larkAppId}` : ''}）: ${label}`);
      skipped++;
      continue;
    }
    try {
      const res = await fetchDaemonIpc(
        daemon.ipcPort,
        `/api/sessions/${encodeURIComponent(s.sessionId)}/suspend`,
        { method: 'POST' },
      );
      const body: any = await res.json().catch(() => ({}));
      if (res.ok && body?.ok) {
        if (body.suspended) { console.log(`✓ 已挂起: ${label}`); suspended++; }
        else if (body.reason === 'deferred') {
          console.log(`⏳ 已排队（正在回复，完成后自动挂起）: ${label}`);
          deferred++;
        }
        else { console.log(`· 本就无存活 CLI（目标态已达成）: ${label}`); skipped++; }
      } else {
        console.log(`✗ 失败（${body?.error ?? `HTTP ${res.status}`}）: ${label}`);
        failed++;
      }
    } catch (err: any) {
      console.log(`✗ 连接 daemon 失败（${err?.message ?? err}）: ${label}`);
      failed++;
    }
  }

  if (dryRun) {
    if (dryRunDegraded) {
      console.log('\n⚠️  部分会话所属 daemon 在线但 /api/sessions 读失败，这些预告标为「未知」而非猜测。');
    }
    console.log(`DRY-RUN：共 ${matched.length} 个目标${deferred ? `（其中 ${deferred} 个正在回复，会排队）` : ''}，未执行。`);
    return;
  }
  // 排队数必须单列：不设兑现上限的安全阀是可见性——这个数持续不降就是会话卡住的信号。
  console.log(`\n完成：挂起 ${suspended} 个，排队 ${deferred} 个，跳过 ${skipped} 个${failed ? `，失败 ${failed} 个` : ''}。`);
  console.log('下条消息会冷启动并 --resume 续上下文；读隔离 bot 冷启动时自动同步最新登录凭证。');
  if (failed > 0) process.exitCode = 1;
}

/** 会话级 CLI IPC 的 POST：能读 host secret 时走 trusted-host HMAC；读不到
 * 时带本会话当前轮换的 origin capability，由目标 handler 绑定活跃会话身份。 */
async function postSessionScopedDaemonIpc(
  ipcPort: number,
  sessionId: string,
  path: string,
  payload: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<Response> {
  const requestBody: Record<string, unknown> = { ...payload };
  let hostSecret: string | undefined;
  if (!process.env.BOTMUX_SEND_RELAY) {
    try { hostSecret = loadDaemonIpcSecret(); } catch { /* sandboxed/read-isolated: capability fallback below */ }
  }
  if (!hostSecret) {
    const claim = readManagedOriginCapability(
      resolveDataDir(),
      sessionId,
      process.env.BOTMUX_SEND_RELAY,
      process.env.BOTMUX_ORIGIN_CHANNEL_ID,
    );
    if (claim) {
      requestBody.originCapability = claim.capability;
      if (claim.turnId) requestBody.originTurnId = claim.turnId;
      if (claim.dispatchAttempt !== undefined) requestBody.originDispatchAttempt = claim.dispatchAttempt;
    }
  }
  const init = {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(requestBody),
    ...(signal ? { signal } : {}),
  } satisfies RequestInit;
  return hostSecret
    ? fetchDaemonIpc(ipcPort, path, init, hostSecret)
    : loopbackFetch(`http://127.0.0.1:${ipcPort}${path}`, init);
}

/** `botmux preview <port>` registers a reachable loopback Web service for the
 * exact current session. There is intentionally no `--session` escape hatch:
 * ancestry/env resolution plus the rotating session capability prove which
 * agent is volunteering the port. The daemon performs the authoritative port
 * validation/probe and persists the result. */
async function cmdPreview(rest: string[]): Promise<void> {
  if (rest.length !== 1 || !/^\d+$/.test(rest[0])) {
    console.error('用法: botmux preview <port>');
    process.exit(1);
  }
  const port = Number(rest[0]);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    console.error('✗ 端口必须是 1-65535 的整数');
    process.exit(1);
  }
  const ctx = findAncestorSessionContext();
  if (!ctx?.sessionId) {
    console.error('✗ 无法定位当前会话；preview 只能在 botmux 会话内注册');
    process.exit(1);
  }

  let discoveredPort: number | undefined;
  try {
    discoveredPort = findDaemon(process.env.BOTMUX_LARK_APP_ID)?.ipcPort;
  } catch {
    // Sandboxed/read-isolated sessions cannot enumerate daemon descriptors.
  }
  const ipcPort = resolveDaemonIpcPort(discoveredPort, process.env.BOTMUX_DAEMON_IPC_PORT);
  if (!ipcPort) {
    console.error('✗ 无法定位当前会话的 daemon；请确认 daemon 正在运行');
    process.exit(1);
  }

  let response: Response;
  try {
    response = await postSessionCliIpc(ipcPort, ctx.sessionId, 'preview', { port });
  } catch {
    console.error('✗ 无法连接当前会话的 daemon');
    process.exit(1);
  }
  const body = await response.json().catch(() => ({})) as {
    ok?: boolean;
    error?: string;
    preview?: { path?: string };
  };
  if (response.ok && body.ok && typeof body.preview?.path === 'string') {
    console.log(`✓ Web 预览已注册: ${body.preview.path}`);
    return;
  }
  const error = body.error ?? `HTTP ${response.status}`;
  if (error === 'preview_unreachable') {
    console.error('✗ 端口不可达；请先让 Web 服务监听本机 loopback/0.0.0.0 后再注册');
  } else if (error === 'preview_owner_unverified') {
    // P1-12：端口上确实有人在监听，但证明不了那是本会话起的进程。宁可没有预览，
    // 也不把 Dashboard 用户代理进一个来路不明的本机服务。
    console.error(
      '✗ 无法确认该端口由本会话的进程持有；请在会话内直接启动 Web 服务后再注册'
      + '（不要用 setsid/nohup 脱离进程树，也不要注册别的程序占用的端口）',
    );
  } else if (error === 'preview_unsupported') {
    console.error('✗ 当前会话后端（远端 sandbox）的 Web 服务不在本机，Dashboard 预览不支持');
  } else if (error === 'preview_generation_changed') {
    console.error('✗ 注册期间会话已换代或已关闭；请在新一轮里重新注册');
  } else if (error === 'preview_target_changed') {
    // P1-3：并发注册（例如同时注册两个端口）时，后到的一方不再无声覆盖先落地的那个。
    console.error('✗ 注册期间本会话的预览目标已被另一次注册改写；同一时刻只能有一个预览目标，请确认后重试');
  } else if (error === 'remote_host_forbidden') {
    console.error('✗ 只允许注册本机 loopback 服务');
  } else if (error === 'origin_unproven' || error === 'managed_action_required') {
    console.error('✗ 当前会话归属校验失败');
  } else {
    console.error(`✗ 预览注册失败: ${error}`);
  }
  process.exit(1);
}

async function cmdChat(argv: string[]): Promise<void> {
  const sub = argv[0] ?? '';
  if (sub !== 'rename') {
    console.error('用法: botmux chat rename <新群名称> [--proactive]');
    process.exitCode = 2;
    return;
  }
  const proactive = argv.includes('--proactive');
  const name = argv.slice(1).filter(arg => arg !== '--proactive').join(' ').trim();
  if (!name) {
    console.error('用法: botmux chat rename <新群名称> [--proactive]');
    process.exitCode = 2;
    return;
  }
  const ctx = findAncestorSessionContext();
  const sid = ctx?.sessionId;
  if (!sid) {
    console.error(JSON.stringify({ ok: false, error: 'missing_session_context' }));
    process.exitCode = 1;
    return;
  }
  const sessions = loadSessions();
  const session = [...sessions.values()].find(x => x.sessionId === sid || x.sessionId.startsWith(sid));
  if (!session) {
    console.error(JSON.stringify({ ok: false, error: 'missing_session_context' }));
    process.exitCode = 1;
    return;
  }
  const daemon = findDaemon(session.larkAppId);
  if (!daemon) {
    console.error(JSON.stringify({ ok: false, error: 'daemon_offline' }));
    process.exitCode = 1;
    return;
  }
  const response = await postSessionCliIpc(
    daemon.ipcPort,
    session.sessionId,
    'chat-rename',
    { name, proactive },
  );
  const body: any = await response.json().catch(() => ({ ok: false, error: `HTTP ${response.status}` }));
  const out = JSON.stringify(body, null, 2);
  if (response.ok && body?.ok) {
    console.log(out);
    return;
  }
  console.error(out);
  process.exitCode = 1;
}

/** slash/cd/close/chat-rename 复用同一套 host-secret / session-capability 双路径。 */
async function postSessionCliIpc(
  ipcPort: number,
  sessionId: string,
  route: 'slash' | 'cd' | 'close' | 'preview' | 'chat-rename',
  payload: Record<string, unknown>,
): Promise<Response> {
  return postSessionScopedDaemonIpc(
    ipcPort,
    sessionId,
    `/api/sessions/${encodeURIComponent(sessionId)}/${route}`,
    payload,
  );
}

/** botmux slash "<斜杠命令>"：请求 daemon 在本会话 idle 后把命令敲入自己的 CLI。
 *  自识别当前会话（pid marker → BOTMUX_SESSION_ID env），allowlist 由 daemon 侧校验。 */
async function cmdSlash(): Promise<void> {
  const argv = process.argv.slice(3);
  const sIdx = argv.indexOf('--session');
  const explicitSid = sIdx >= 0 ? argv[sIdx + 1] : undefined;
  // 所有非 flag 位置参数 join(' ')，而不是只取第一个——未加引号的命令若含空格
  // （如 `botmux slash /model opus`）此前会被截断成 `/model`。
  const command = argv.filter((a, i) => !a.startsWith('--') && !(sIdx >= 0 && i === sIdx + 1)).join(' ');
  if (!command) { console.error('用法: botmux slash "/compact" [--session <id>]'); process.exit(1); }

  const ctx = explicitSid ? null : findAncestorSessionContext();
  const sid = explicitSid ?? ctx?.sessionId;
  if (!sid) { console.error('❌ 无法定位当前会话（需在 bot 会话内执行，或用 --session 指定）'); process.exit(1); }
  const sessions = loadSessions();
  const s = [...sessions.values()].find(x => x.sessionId === sid || x.sessionId.startsWith(sid));
  if (!s) { console.error(`❌ 未找到 session ${sid}`); process.exit(1); }
  const daemon = findDaemon(s.larkAppId);
  if (!daemon) { console.error('❌ daemon 不在线'); process.exit(1); }
  const res = await postSessionCliIpc(daemon.ipcPort, s.sessionId, 'slash', { command });
  const body: any = await res.json().catch(() => ({}));
  if (res.ok && body?.ok) { console.log(`✓ 已排队注入: ${body.queued}（会话空闲时执行；CLI 进程若在执行前重启则丢弃）`); return; }
  console.error(`✗ 被拒绝: ${body?.error ?? `HTTP ${res.status}`}`);
  process.exit(1);
}

/** 角色切换（`botmux role switch <角色目录>`，唯一入口）。daemon 侧硬校验目录必须在
 *  ~/botmux-roles 下。名字→目录的解析由调用方（模型读 _role-protocol.md）完成，本命令
 *  只透传解析出的目标目录。argv 由 dispatch 传入 `process.argv.slice(4)`（跳过 `switch`
 *  子命令词）。 */
async function cmdRoleSwitch(argv: string[]): Promise<void> {
  const sIdx = argv.indexOf('--session');
  const explicitSid = sIdx >= 0 ? argv[sIdx + 1] : undefined;
  // 所有非 flag 位置参数 join(' ')，而不是只取第一个——路径含空格且未加引号时
  // （如 `botmux role switch ~/botmux-roles/我的 角色`）此前会被截断。
  const dir = argv.filter((a, i) => !a.startsWith('--') && !(sIdx >= 0 && i === sIdx + 1)).join(' ');
  if (!dir) { console.error(`用法: botmux role switch <目标角色目录（含空格建议加引号）> [--session <id>]`); process.exit(1); }

  const ctx = explicitSid ? null : findAncestorSessionContext();
  const sid = explicitSid ?? ctx?.sessionId;
  if (!sid) { console.error('❌ 无法定位当前会话（需在 bot 会话内执行，或用 --session 指定）'); process.exit(1); }
  const sessions = loadSessions();
  const s = [...sessions.values()].find(x => x.sessionId === sid || x.sessionId.startsWith(sid));
  if (!s) { console.error(`❌ 未找到 session ${sid}`); process.exit(1); }
  const daemon = findDaemon(s.larkAppId);
  if (!daemon) { console.error('❌ daemon 不在线'); process.exit(1); }
  const res = await postSessionCliIpc(daemon.ipcPort, s.sessionId, 'cd', { dir });
  const body: any = await res.json().catch(() => ({}));
  if (res.ok && body?.ok) {
    console.log(body.mode === 'respawn-resume'
      ? `✓ 已切换到 ${body.dir}（进程即将在新目录重启并续回上下文）`
      : body.mode === 'inject'  // 兼容旧 daemon 的注入模式
        ? `✓ 已切换到 ${body.dir}（会话空闲时生效，进程不重启）`
        : `✓ 已切换到 ${body.dir}（下条消息在新目录冷启动）`);
    return;
  }
  console.error(`✗ 切换被拒绝: ${body?.error ?? `HTTP ${res.status}`}`);
  process.exit(1);
}

/**
 * Discover online daemons. Mirrors the staleness rule used by
 * dashboard/registry.ts (90s heartbeat) so we don't try to talk to a daemon
 * that's been dead but left a stale descriptor behind. Uses resolveDataDir()
 * so SESSION_DATA_DIR / breadcrumb-overridden deployments find the right
 * descriptor directory.
 */
interface DaemonDescriptorLite {
  ipcPort: number;
  larkAppId: string;
  pid?: number;
  bootInstanceId?: string;
  workflowIpcProtocol?: string;
  lastHeartbeat?: number;
}

function listDaemonDescriptors(): DaemonDescriptorLite[] {
  const regDir = join(resolveDataDir(), 'dashboard-daemons');
  if (!existsSync(regDir)) return [];
  const all: DaemonDescriptorLite[] = [];
  let names: string[] = [];
  try { names = readdirSync(regDir); } catch { return []; }
  for (const f of names) {
    if (!f.endsWith('.json')) continue;
    try {
      const d = JSON.parse(readFileSync(join(regDir, f), 'utf-8'));
      if (typeof d?.ipcPort !== 'number' || typeof d?.larkAppId !== 'string') continue;
      all.push({
        ipcPort: d.ipcPort,
        larkAppId: d.larkAppId,
        ...(typeof d.pid === 'number' ? { pid: d.pid } : {}),
        ...(typeof d.bootInstanceId === 'string' && d.bootInstanceId
          ? { bootInstanceId: d.bootInstanceId }
          : {}),
        ...(typeof d.workflowIpcProtocol === 'string' && d.workflowIpcProtocol
          ? { workflowIpcProtocol: d.workflowIpcProtocol }
          : {}),
        ...(typeof d.lastHeartbeat === 'number' ? { lastHeartbeat: d.lastHeartbeat } : {}),
      });
    } catch { /* skip malformed */ }
  }
  return all;
}

function listOnlineDaemons(): DaemonDescriptorLite[] {
  const STALE_MS = 90_000;
  const now = Date.now();
  return listDaemonDescriptors().filter(d => now - (d.lastHeartbeat ?? 0) <= STALE_MS);
}

function findDaemon(larkAppId?: string): DaemonDescriptorLite | null {
  const all = listOnlineDaemons();
  if (larkAppId) return all.find(d => d.larkAppId === larkAppId) ?? null;
  return all[0] ?? null;
}

function normalizeCardUsageSnapshot(value: unknown): CardUsageSnapshot | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const rawContext = raw.context;
  const rawTokens = raw.tokens;

  let context: CardUsageSnapshot['context'] = null;
  if (rawContext && typeof rawContext === 'object' && !Array.isArray(rawContext)) {
    const c = rawContext as Record<string, unknown>;
    if (typeof c.usedTokens === 'number'
      && Number.isFinite(c.usedTokens)
      && c.usedTokens >= 0) {
      context = {
        usedTokens: c.usedTokens,
        ...(typeof c.windowTokens === 'number'
          && Number.isFinite(c.windowTokens)
          && c.windowTokens > 0
          ? { windowTokens: c.windowTokens }
          : {}),
        ...(typeof c.percentUsed === 'number'
          && Number.isFinite(c.percentUsed)
          && c.percentUsed >= 0
          ? { percentUsed: c.percentUsed }
          : {}),
      };
    }
  }

  let tokens: CardUsageSnapshot['tokens'] = null;
  if (rawTokens && typeof rawTokens === 'object' && !Array.isArray(rawTokens)) {
    const u = rawTokens as Record<string, unknown>;
    if (typeof u.in === 'number'
      && Number.isFinite(u.in)
      && u.in >= 0
      && typeof u.out === 'number'
      && Number.isFinite(u.out)
      && u.out >= 0) {
      tokens = { in: u.in, out: u.out };
    }
  }

  return { context, tokens };
}

/** Prefer the resident daemon's incremental transcript cache. Older/offline
 * daemons and isolated environments fall back to the local reader; either path
 * degrades to explicit unavailable facts without blocking the reply. */
async function readCardUsageSnapshotForSend(
  session: SessionData,
  larkAppId: string,
): Promise<CardUsageSnapshot> {
  let daemonPort: number | undefined;
  try {
    daemonPort =
      findDaemon(larkAppId)?.ipcPort
      ?? resolveDaemonIpcPort(undefined, process.env.BOTMUX_DAEMON_IPC_PORT);
  } catch {
    // A stale/unreadable daemon registry must not prevent the reply.
  }
  if (daemonPort) {
    try {
      const path = `/api/sessions/${encodeURIComponent(session.sessionId)}/usage`;
      const response = await fetchDaemonIpc(daemonPort, path, {
        method: 'GET',
        signal: AbortSignal.timeout(1_500),
      });
      if (response.ok) {
        const body = await response.json() as { usage?: unknown };
        const normalized = normalizeCardUsageSnapshot(body.usage);
        if (normalized) return normalized;
      }
    } catch {
      // No host secret, old daemon, timeout, or transient IPC failure: use the
      // same bounded local parser below.
    }
  }

  // Old/offline daemon fallback. Sandboxed panes receive this per-bot value
  // explicitly from the worker because bots.json is intentionally unreadable.
  // This send path renders into the reply-card FOOTER, so only the 'footer'
  // display mode surfaces usage here; 'streaming' shows it on the daemon's live
  // card (absent on this offline fallback) and 'off' shows nothing.
  if (resolveUsageDisplay(larkAppId) !== 'footer') {
    return { context: null, tokens: null };
  }

  try {
    return getSessionUsageSnapshot({
      cliId: (session.cliId ?? session.adoptedFrom?.cliId ?? 'unknown') as CliId | 'unknown',
      sessionId: session.sessionId,
      cliSessionId: session.cliSessionId ?? session.adoptedFrom?.sessionId,
      cwd: session.workingDir ?? session.adoptedFrom?.cwd,
      // BOT_HOME transcript fallback for CLI-data-redirected / sandboxed bots
      // (parity with the daemon reader and the ledger/dashboard consumers).
      larkAppId: larkAppId ?? session.larkAppId,
      fresh: true,
      // 定价覆盖：从 bot 配置解析，未配置时 undefined（costCny 缺省）。
      pricing: larkAppId ? resolvePricingForCli(larkAppId) : undefined,
    });
  } catch {
    return { context: null, tokens: null };
  }
}

/**
 * Authenticate the human who opened this exact turn against the target run,
 * then return the only daemon app that may receive the mutation. Inherited
 * BOTMUX_LARK_APP_ID is deliberately not an authority (long-lived sessions
 * keep it even when a different human opens a later turn).
 */
function authorizeWorkflowDaemonCommand(runId: string, rest: string[]): string {
  return authorizeV3DaemonCommand({
    runId,
    dataDir: resolveDataDir(),
    envSessionId: process.env.BOTMUX_SESSION_ID,
    requestedLarkAppId: argValue(rest, '--bot'),
  }).larkAppId;
}

/**
 * Isolated-session fallback for workflow daemon mutations. Inside a Linux
 * bwrap sandbox or a macOS read-isolated session every leg of the host path
 * above is masked by design (process-tree marker, run directory,
 * `.dashboard-secret`), so the CLI instead presents its per-turn rotating
 * capability and lets the daemon re-derive the caller/chat/bot tuple from its
 * own live session record (workflows/v3/session-relay.ts). Detection is
 * marker-first (a visible live process marker → host path, so a stale
 * capability file can never hijack a healthy host session), then falls back
 * to the worker-published capability file that only isolated sessions have.
 * `--bot` is meaningless here — the run must be bound to this very session's
 * chat tuple, which pins the daemon.
 */
async function tryWorkflowSessionRelayMutation(
  runId: string,
  mutation: WorkflowDaemonMutation,
  body?: Record<string, unknown>,
): Promise<WorkflowDaemonMutationResponse | null> {
  const context = readWorkflowSessionRelayContext({
    env: process.env,
    dataDir: resolveDataDir(),
  });
  if (!context) return null;
  try {
    return await postWorkflowSessionRunMutation({
      context,
      runId,
      mutation,
      ...(body ? { body } : {}),
      resolveIpcPort: (larkAppId) => {
        // Daemon discovery is host state — masked in-sandbox, best-effort under
        // read isolation. The BOTMUX_DAEMON_IPC_PORT fallback inside the client
        // covers the masked case.
        try {
          return larkAppId ? findDaemon(larkAppId)?.ipcPort : undefined;
        } catch {
          return undefined;
        }
      },
    });
  } catch (err) {
    console.error(`❌ ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

/** `botmux workflow cancel <runId>` — authenticate the exact current caller
 * against the immutable run binding, then ask the owning daemon to durably
 * record cancellation before interrupting workers. */
async function cmdWorkflowCancelV3(runId: string | undefined, rest: string[]): Promise<void> {
  if (!runId) {
    console.error('用法: botmux workflow cancel <runId> [--reason <text>] [--bot <larkAppId>]');
    process.exit(1);
  }
  const {
    formatV3RunCancelCliSuccess,
    parseV3RunCancelCliOptions,
    parseV3RunCancelDaemonResponse,
  } = await import('./cli/v3-run-cancel.js');
  const parsed = parseV3RunCancelCliOptions(rest);
  if (!parsed.ok) {
    console.error(`❌ ${parsed.error}`);
    console.error('用法: botmux workflow cancel <runId> [--reason <text>] [--bot <larkAppId>]');
    process.exit(1);
  }
  const reason = parsed.reason;
  // An isolated session can only cancel a daemon-bound chat run (a standalone
  // manual_cli run lives on masked host disk anyway), so relay short-circuits
  // ahead of the host authority/standalone branching.
  const relayed = await tryWorkflowSessionRelayMutation(
    runId, 'cancel', reason ? { reason } : {},
  );
  if (relayed) {
    try {
      console.log(formatV3RunCancelCliSuccess(parseV3RunCancelDaemonResponse(relayed)));
    } catch (err) {
      console.error(`❌ ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
    return;
  }
  const authority = authorizeV3DaemonCommand({
    runId,
    dataDir: resolveDataDir(),
    envSessionId: process.env.BOTMUX_SESSION_ID,
    requestedLarkAppId: parsed.larkAppId,
    allowStandaloneLocal: true,
  });
  if (authority.mode === 'standalone') {
    // A manual_cli run is owned by its foreground/local runtime, not a daemon.
    // Persisting the shared journal intent is sufficient: runWorkflow polls the
    // durable cut while a worker is active and aborts it within one tick.
    const { requestV3RunCancel } = await import('./workflows/v3/daemon-run.js');
    let outcome;
    try {
      outcome = requestV3RunCancel(dirname(authority.runDir), runId, {
        by: 'standalone-cli',
        ...(reason ? { reason } : {}),
      });
    } catch (err) {
      console.error(`❌ ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
    if (outcome.kind === 'stale-run') throw new Error(`找不到 v3 run ${runId}`);
    if (outcome.kind === 'already-terminal') {
      console.log(formatV3RunCancelCliSuccess({
        ok: true, runId, status: outcome.status, alreadyTerminal: true,
      }));
      return;
    }
    if (outcome.kind === 'already-cancelled') {
      console.log(formatV3RunCancelCliSuccess({
        ok: true, runId, status: 'cancelled', alreadyTerminal: true,
        ...(outcome.cancelRequestId ? { cancelRequestId: outcome.cancelRequestId } : {}),
      }));
      return;
    }
    console.log(formatV3RunCancelCliSuccess({
      ok: true,
      runId,
      status: 'cancelling',
      cancelRequestId: outcome.cancelRequestId,
      alreadyRequested: outcome.kind === 'already-requested',
    }));
    return;
  }

  const daemon = findDaemon(authority.larkAppId);
  if (!daemon) {
    console.error('❌ 没有在线的目标 daemon；v3 run 取消需要由所属 daemon 持久化并中断节点。');
    process.exit(1);
  }
  let secret: string | null = null;
  try {
    secret = loadDashboardSecret(dashboardSecretPath());
  } catch (err) {
    console.error(`❌ 无法读取 .dashboard-secret：${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
  if (!secret) {
    console.error('❌ 缺少 .dashboard-secret，无法认证 v3 cancel daemon 请求；请先重启 botmux 初始化。');
    process.exit(1);
  }
  try {
    const { postV3RunCancel } = await import('./cli/v3-run-cancel.js');
    const result = await postV3RunCancel({
      daemon,
      runId,
      secret,
      ...(reason ? { reason } : {}),
    });
    console.log(formatV3RunCancelCliSuccess(result));
  } catch (err) {
    console.error(`❌ ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

function requireDashboardSecret(): string {
  let secret: string | null;
  try {
    secret = loadDashboardSecret(join(CONFIG_DIR, '.dashboard-secret'));
  } catch (err: any) {
    throw new Error(`无法读取 .dashboard-secret: ${err?.message ?? err}`);
  }
  if (!secret) throw new Error('缺少或为空 .dashboard-secret；请先启动或重启 botmux daemon。');
  return secret;
}

async function ensureLocalBotCollaboration(
  chatId: string,
  participantAppIds: string[],
): Promise<Awaited<ReturnType<typeof ensureBotChatGrantMatrix>>> {
  return ensureBotChatGrantMatrix(chatId, participantAppIds, {
    findDaemon,
    secret: requireDashboardSecret(),
  });
}

async function waitForExactDispatchAcceptance(input: {
  targetAppIds: string[];
  chatId: string;
  threadRootId: string;
  turnId: string;
  sentAtMs: number;
  timeoutMs?: number;
}): Promise<{ acceptedBotAppIds: string[]; missingBotAppIds: string[] }> {
  const targets = [...new Set(input.targetAppIds)];
  const configuredTimeout = Number(process.env.BOTMUX_DISPATCH_ACCEPT_TIMEOUT_MS);
  const timeoutMs = input.timeoutMs
    ?? (Number.isFinite(configuredTimeout) && configuredTimeout >= 0 ? configuredTimeout : 15_000);
  const deadline = Date.now() + timeoutMs;
  let acceptedBotAppIds: string[] = [];
  do {
    acceptedBotAppIds = acceptedDispatchBotAppIds({
      sessions: loadSessions().values(),
      targetAppIds: targets,
      chatId: input.chatId,
      threadRootId: input.threadRootId,
      turnId: input.turnId,
      notBeforeMs: input.sentAtMs,
      isWorkerAlive: isProcessAlive,
    });
    if (acceptedBotAppIds.length === targets.length) break;
    if (Date.now() >= deadline) break;
    await new Promise<void>(resolve => setTimeout(resolve, 250));
  } while (true);
  const accepted = new Set(acceptedBotAppIds);
  return {
    acceptedBotAppIds,
    missingBotAppIds: targets.filter(appId => !accepted.has(appId)),
  };
}

/** `botmux workflow start <runId>` — POST the daemon's v3 start IPC so the run
 *  is daemon-driven (humanGate → 飞书审批卡).  The grill skill calls this after
 *  approve-dag instead of the standalone `botmux v3 run` (which has no card
 *  layer).  The daemon is selected from the authenticated run/current-turn
 *  binding, never from the worker's static BOTMUX_LARK_APP_ID env. */
async function cmdWorkflowStart(runId: string | undefined, rest: string[]): Promise<void> {
  if (!runId) {
    console.error('用法: botmux workflow start <runId> [--bot <larkAppId>]');
    process.exit(1);
  }
  let response = await tryWorkflowSessionRelayMutation(runId, 'start');
  if (!response) {
    const larkAppId = authorizeWorkflowDaemonCommand(runId, rest);
    const daemon = findDaemon(larkAppId);
    if (!daemon) {
      console.error('❌ 没有在线 daemon；v3 humanGate run 需要 daemon 驱动（审批卡是 daemon 的活）。');
      process.exit(1);
    }
    try {
      response = await postWorkflowDaemonMutation({
        daemon,
        runId,
        mutation: 'start',
      });
    } catch (err: any) {
      console.error(`❌ ${err?.message ?? err}`);
      process.exit(1);
    }
  }
  if (!response.ok) {
    console.error(`❌ start 失败 (HTTP ${response.status}): ${response.bodyRaw}`);
    process.exit(1);
  }
  console.log(`✅ v3 run "${runId}" 已交 daemon 驱动；humanGate 会在话题里弹审批卡，点了才继续。`);
}

/** `botmux workflow retry <runId> [--node <id>]` — blocked 节点重试入口（CLI 侧）。
 *  走 daemon 的 retry IPC（journal 写入留在 daemon 进程内，单写者），daemon append
 *  `nodeRetryRequested` 后以新 attempt 重驱动；已退休的 v2 `resume` 不再参与分发。 */
async function cmdWorkflowRetry(runId: string | undefined, rest: string[]): Promise<void> {
  if (!runId) {
    console.error('用法: botmux workflow retry <runId> [--node <nodeId>] [--bot <larkAppId>]');
    process.exit(1);
  }
  const nodeId = argValue(rest, '--node');
  let response = await tryWorkflowSessionRelayMutation(runId, 'retry', nodeId ? { nodeId } : {});
  if (!response) {
    const larkAppId = authorizeWorkflowDaemonCommand(runId, rest);
    const daemon = findDaemon(larkAppId);
    if (!daemon) {
      console.error('❌ 没有在线 daemon；blocked 重试需要 daemon 驱动。');
      process.exit(1);
    }
    try {
      response = await postWorkflowDaemonMutation({
        daemon,
        runId,
        mutation: 'retry',
        body: nodeId ? { nodeId } : {},
      });
    } catch (err: any) {
      console.error(`❌ ${err?.message ?? err}`);
      process.exit(1);
    }
  }
  if (!response.ok) {
    if (response.bodyRaw.includes('loop_node_use_grant')) {
      console.error(`❌ 该受阻的是一个 loop（轮数耗尽），不是节点 attempt——用 \`botmux workflow grant ${runId}\` 追加一轮。`);
    } else {
      console.error(`❌ retry 失败 (HTTP ${response.status}): ${response.bodyRaw}`);
    }
    process.exit(1);
  }
  console.log(`🔄 v3 run "${runId}" 重试已受理，节点将以新 attempt 重跑。`);
}

/** `botmux workflow grant <runId> [--loop <id>]` — 耗尽 loop 追加一轮入口（CLI 侧）。
 *  与 retry 同构：走 daemon 的 grant IPC（单写者），daemon append
 *  `loopIterationGranted` 后重驱动，loop 带上一轮反馈再跑一轮。 */
async function cmdWorkflowGrant(runId: string | undefined, rest: string[]): Promise<void> {
  if (!runId) {
    console.error('用法: botmux workflow grant <runId> [--loop <loopId>] [--bot <larkAppId>]');
    process.exit(1);
  }
  const loopId = argValue(rest, '--loop');
  let response = await tryWorkflowSessionRelayMutation(runId, 'grant', loopId ? { loopId } : {});
  if (!response) {
    const larkAppId = authorizeWorkflowDaemonCommand(runId, rest);
    const daemon = findDaemon(larkAppId);
    if (!daemon) {
      console.error('❌ 没有在线 daemon；loop 追加需要 daemon 驱动。');
      process.exit(1);
    }
    try {
      response = await postWorkflowDaemonMutation({
        daemon,
        runId,
        mutation: 'grant',
        body: loopId ? { loopId } : {},
      });
    } catch (err: any) {
      console.error(`❌ ${err?.message ?? err}`);
      process.exit(1);
    }
  }
  if (!response.ok) {
    console.error(`❌ grant 失败 (HTTP ${response.status}): ${response.bodyRaw}`);
    process.exit(1);
  }
  console.log(`➕ v3 run "${runId}" 已追加一轮，loop 将带上一轮反馈重跑。`);
}

async function triggerGoalWatchdogFromCli(
  goalChatId: string,
  reason: string,
  sessionId?: string,
  larkAppId?: string,
): Promise<{ contacted: number; injected: number; reconciled: number; busy: number; rateLimited: number }> {
  if (sessionId && larkAppId) {
    const daemon = findDaemon(larkAppId);
    if (daemon) {
      const ctrl = new AbortController();
      const tt = setTimeout(() => ctrl.abort(), 3_000);
      try {
        const res = await postSessionScopedDaemonIpc(
          daemon.ipcPort,
          sessionId,
          '/api/goal/watchdog',
          { goalChatId, reason, broadcast: true, callerSessionId: sessionId },
          ctrl.signal,
        );
        if (res.ok) {
          const body = await res.json().catch(() => null) as {
            contacted?: number;
            injected?: number;
            reconciled?: number;
            busy?: number;
            rateLimited?: number;
          } | null;
          return {
            contacted: body?.contacted ?? 0,
            injected: body?.injected ?? 0,
            reconciled: body?.reconciled ?? 0,
            busy: body?.busy ?? 0,
            rateLimited: body?.rateLimited ?? 0,
          };
        }
      } catch {
        // Fall through to the trusted-host fan-out. In a read-isolated session
        // this may also fail; the periodic watchdog remains the final fallback.
      } finally {
        clearTimeout(tt);
      }
    }
  }
  const daemons = listOnlineDaemons();
  let contacted = 0;
  let injected = 0;
  let reconciled = 0;
  let busy = 0;
  let rateLimited = 0;
  await Promise.all(daemons.map(async (daemon) => {
    const ctrl = new AbortController();
    const tt = setTimeout(() => ctrl.abort(), 3_000);
    try {
      const res = await fetchDaemonIpc(daemon.ipcPort, '/api/goal/watchdog', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ goalChatId, reason }),
        signal: ctrl.signal,
      });
      contacted++;
      if (!res.ok) return;
      const body = await res.json().catch(() => null) as { results?: Array<{ status?: string }> } | null;
      const results = body?.results ?? [];
      injected += results.filter((r) => r.status === 'injected').length;
      reconciled += results.filter((r) => r.status === 'reconciled').length;
      busy += results.filter((r) => r.status === 'busy').length;
      rateLimited += results.filter((r) => r.status === 'rate-limited').length;
    } catch {
      // Best effort. Periodic goal-watchdog still picks the task up.
    } finally {
      clearTimeout(tt);
    }
  }));
  return { contacted, injected, reconciled, busy, rateLimited };
}

/** Fast-path dependency release check after an accept. Failure is deliberately
 * ignored: the daemon's periodic scan is the correctness fallback. */
async function triggerGoalReleaseCheckFromCli(
  goalChatId: string,
  sessionId?: string,
  larkAppId?: string,
): Promise<boolean> {
  if (sessionId && larkAppId) {
    const daemon = findDaemon(larkAppId);
    if (daemon) {
      const ctrl = new AbortController();
      const tt = setTimeout(() => ctrl.abort(), 3_000);
      try {
        const res = await postSessionScopedDaemonIpc(
          daemon.ipcPort,
          sessionId,
          '/api/goal/release-check',
          { goalChatId, reason: 'task-accepted', broadcast: true, callerSessionId: sessionId },
          ctrl.signal,
        );
        if (res.ok) return true;
      } catch {
        // Fall through to trusted-host fan-out.
      } finally {
        clearTimeout(tt);
      }
    }
  }
  const results = await Promise.all(listOnlineDaemons().map(async (daemon) => {
    const ctrl = new AbortController();
    const tt = setTimeout(() => ctrl.abort(), 3_000);
    try {
      const res = await fetchDaemonIpc(daemon.ipcPort, '/api/goal/release-check', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ goalChatId, reason: 'task-accepted' }),
        signal: ctrl.signal,
      });
      return res.ok;
    } catch {
      return false;
    } finally {
      clearTimeout(tt);
    }
  }));
  return results.some(Boolean);
}

async function requestGoalReleaseActionFromCli(input: {
  taskId: string;
  action: 'confirm' | 'retry';
  by: string;
  sessionId: string;
  larkAppId: string;
}): Promise<unknown> {
  const daemon = findDaemon(input.larkAppId);
  if (!daemon) throw new Error(`未找到在线监管者 daemon (larkAppId=${input.larkAppId})`);
  const response = await postSessionScopedDaemonIpc(
    daemon.ipcPort,
    input.sessionId,
    '/api/goal/release-action',
    { ...input, callerSessionId: input.sessionId },
  );
  const body = await response.json().catch(() => null) as { ok?: boolean; error?: string; result?: unknown } | null;
  if (!response.ok || !body?.ok) throw new Error(body?.error ?? `daemon HTTP ${response.status}`);
  return body.result;
}

async function cmdResume(): Promise<void> {
  const target = process.argv[3];
  if (!target) {
    console.error('用法: botmux resume <session-id|prefix>');
    console.error('  通过 botmux list 查看活跃会话；resume 仅适用于 status=closed 的会话');
    process.exit(1);
  }

  const sessions = loadSessions();
  const closed = [...sessions.values()].filter(s => s.status === 'closed');
  if (closed.length === 0) {
    console.error('没有已关闭的会话可恢复。');
    process.exit(1);
  }
  const matches = closed.filter(s => s.sessionId.startsWith(target));
  if (matches.length === 0) {
    console.error(`❌ 未找到匹配 "${target}" 的已关闭会话`);
    process.exit(1);
  }
  if (matches.length > 1) {
    console.error(`❌ "${target}" 匹配了 ${matches.length} 个会话，请提供更长的 ID 前缀：`);
    for (const s of matches) {
      console.error(`   ${s.sessionId.substring(0, 12)}  ${s.title}`);
    }
    process.exit(1);
  }
  const session = matches[0];

  // Legacy sessions persisted before per-bot files lack larkAppId. Rather
  // than silently routing to "the first online daemon" — which can land on
  // the wrong bot in multi-bot setups and corrupt state — refuse and tell
  // the user what's missing. Single-bot setups still work (we resolve to
  // that lone daemon below).
  if (!session.larkAppId) {
    const online = listOnlineDaemons();
    if (online.length > 1) {
      console.error(`❌ 会话 ${session.sessionId.substring(0, 12)} 缺少 larkAppId，多 bot 部署下无法判定归属。`);
      console.error('   解决办法：手动给该 session 补 larkAppId 后重试，或使用对应 bot 的话题里 ▶️ 恢复会话 按钮。');
      console.error(`   在线 daemon (${online.length}): ${online.map(d => d.larkAppId).join(', ')}`);
      process.exit(1);
    }
    if (online.length === 0) {
      console.error('❌ 没有在线 daemon。请先：botmux start');
      process.exit(1);
    }
    // Single online daemon — safe to use
  }

  const daemon = findDaemon(session.larkAppId);
  if (!daemon) {
    const hint = session.larkAppId
      ? `未找到 daemon (larkAppId=${session.larkAppId})`
      : '未找到任何在线 daemon';
    console.error(`❌ ${hint}。请确认 daemon 正在运行：botmux status`);
    process.exit(1);
  }

  let res: Response;
  try {
    res = await fetchDaemonIpc(
      daemon.ipcPort,
      `/api/sessions/${encodeURIComponent(session.sessionId)}/resume`,
      { method: 'POST' },
    );
  } catch (err: any) {
    console.error(`❌ 无法连接到 daemon (port=${daemon.ipcPort}): ${err?.message ?? err}`);
    process.exit(1);
  }
  let body: any = {};
  try { body = await res.json(); } catch { /* */ }
  if (res.ok && body?.ok) {
    console.log(`✅ 会话已恢复: ${session.sessionId.substring(0, 12)}  ${session.title}`);
    if (body.workingDir) console.log(`   工作目录: ${body.workingDir}`);
    console.log('   下一条消息会以 --resume 拉起 CLI；已在原话题留通知。');
    return;
  }
  const errCode = body?.error ?? `HTTP ${res.status}`;
  if (errCode === 'anchor_occupied') {
    const occ = body?.activeSessionId ? ` (占用者: ${body.activeSessionId.substring(0, 12)})` : '';
    console.error(`❌ 当前话题已有新的活跃会话${occ}，无法 resume 旧会话。`);
  } else if (errCode === 'not_closed') {
    console.error('❌ 会话当前不是 closed 状态，无需 resume。');
  } else if (errCode === 'not_found') {
    console.error('❌ daemon 中找不到该会话（可能已被清理）。');
  } else if (errCode === 'adopt_unsupported') {
    console.error('❌ adopt 接管会话不支持 resume。');
  } else if (errCode === 'deferred_unmaterialized') {
    console.error('❌ 该静默定时轮次未创建话题，隐藏会话只保留审计记录，不能 resume。');
  } else if (errCode === 'resume_cancelled') {
    console.error('❌ 恢复过程中会话被关闭，本次 resume 已取消。');
  } else {
    console.error(`❌ 恢复失败: ${errCode}`);
  }
  process.exit(1);
}

/**
 * `botmux term-link [session-id|prefix]` — get the writable ("可操作") terminal
 * for an active session. The link carries a write token, so rather than print it
 * (where it could land in logs / shell history), the daemon delivers it as a
 * private card to the bot owner(s): an in-chat visible-to-you ephemeral card,
 * auto-falling back to a DM in topic / p2p chats. The CLI only ever sees delivery
 * counts — never the token. The daemon route is loopback-HMAC gated, signed here
 * with .dashboard-secret (same scheme as `botmux dashboard`).
 */
async function cmdTermLink(rest: string[]): Promise<void> {
  const target = rest[0];
  const active = [...loadSessions().values()].filter(s => s.status === 'active');
  if (active.length === 0) {
    console.error('没有活跃会话。可操作终端只能对 status=active 的会话获取（botmux list 查看）。');
    process.exit(1);
  }

  let session: SessionData;
  if (!target) {
    if (active.length === 1) {
      session = active[0];
    } else {
      console.error('用法: botmux term-link <session-id|prefix>');
      console.error(`  当前有 ${active.length} 个活跃会话，请指定其一：`);
      for (const s of active) console.error(`   ${s.sessionId.substring(0, 12)}  ${s.title}`);
      process.exit(1);
    }
  } else {
    const matches = active.filter(s => s.sessionId.startsWith(target));
    if (matches.length === 0) {
      console.error(`❌ 未找到匹配 "${target}" 的活跃会话（resume 已关闭的会话后再试）`);
      process.exit(1);
    }
    if (matches.length > 1) {
      console.error(`❌ "${target}" 匹配了 ${matches.length} 个活跃会话，请提供更长的 ID 前缀：`);
      for (const s of matches) console.error(`   ${s.sessionId.substring(0, 12)}  ${s.title}`);
      process.exit(1);
    }
    session = matches[0];
  }

  // Multi-bot larkAppId guard (mirror of cmdResume): a legacy session without
  // larkAppId can't be routed deterministically when >1 daemon is online.
  if (!session.larkAppId) {
    const online = listOnlineDaemons();
    if (online.length > 1) {
      console.error(`❌ 会话 ${session.sessionId.substring(0, 12)} 缺少 larkAppId，多 bot 部署下无法判定归属。`);
      console.error(`   在线 daemon (${online.length}): ${online.map(d => d.larkAppId).join(', ')}`);
      process.exit(1);
    }
    if (online.length === 0) {
      console.error('❌ 没有在线 daemon。请先：botmux start');
      process.exit(1);
    }
  }

  const daemon = findDaemon(session.larkAppId);
  if (!daemon) {
    console.error('❌ 未找到在线 daemon。请确认 daemon 正在运行：botmux status');
    process.exit(1);
  }

  let res: Response;
  try {
    res = await fetchDaemonIpc(
      daemon.ipcPort,
      `/api/sessions/${encodeURIComponent(session.sessionId)}/write-link-card`,
      { method: 'POST' },
    );
  } catch (err: any) {
    console.error(`❌ 无法连接到 daemon (port=${daemon.ipcPort}): ${err?.message ?? err}`);
    process.exit(1);
  }

  let body: any = {};
  try { body = await res.json(); } catch { /* */ }
  if (res.ok && body?.ok) {
    const chans: string[] = body.channels ?? [];
    const eph = chans.filter(c => c === 'ephemeral').length;
    const dm = chans.filter(c => c === 'dm').length;
    const via = [eph ? `${eph} 条群内私密卡` : '', dm ? `${dm} 条私聊 DM` : ''].filter(Boolean).join(' + ');
    console.log(`✅ 可操作终端卡片已私密发给 owner（${body.delivered}/${body.total}${via ? '：' + via : ''}）`);
    console.log(`   会话: ${session.sessionId.substring(0, 12)}  ${session.title}`);
    console.log('   卡片里「打开终端」即带写 token 进入；链接只走私密通道，不进群、不回显到这里。');
    return;
  }

  const errCode = body?.error ?? `HTTP ${res.status}`;
  if (errCode === 'unauthorized') {
    console.error('❌ 鉴权失败（loopback HMAC）。确认 .dashboard-secret 未变、daemon 已用同一份重启。');
  } else if (errCode === 'session_not_active') {
    console.error('❌ daemon 中该会话非活跃，无法获取可操作终端。');
  } else if (errCode === 'terminal_unavailable') {
    console.error('❌ 该会话终端尚未就绪（worker 未起或缺 token）。等会话起来再试。');
  } else if (errCode === 'terminal_unsupported') {
    console.error('❌ 该会话后端不提供 Web 终端；ZMX 会话请在本机运行 botmux list 或 zmx attach。');
  } else if (errCode === 'no_owner') {
    console.error('❌ 该 bot 未配置 owner（allowedUsers 为空 / 全开放模式），没有可私密投递的对象。');
  } else if (errCode === 'delivery_failed') {
    console.error('❌ 卡片投递失败（ephemeral 与 DM 均失败）。查看 daemon 日志：botmux logs。');
  } else {
    console.error(`❌ 获取失败: ${errCode}`);
  }
  process.exit(1);
}

function showHelp(): void {
  console.log(`
botmux v${getVersion()} — IM ↔ AI 编程 CLI 桥接

命令:
  setup       交互式配置（首次使用 / 添加机器人）
              默认使用 botmux 内置 Feishu Web QR 登录尝试自动导入权限/redirect/发布版本；可加 --no-open-platform-auto 跳过
  clone <机器人名> [--name <新名称>]
              创建新应用并复制该机器人的行为配置；留空名称自动使用 源名称-copy-时间戳
  start       启动 daemon，并启动 mode=auto 的插件 service
  stop        停止 daemon（默认不停止插件 service；--with-plugin 显式停止 mode=auto 的插件 service）
  restart     重启 daemon（默认不停止插件 service，core 启动后确保 mode=auto 正在运行；--with-plugin 显式先停再启动 auto service）
  logs        查看/跟随 daemon 日志（--lines N, --bot <0-based-index|name|appId>, --no-follow 只打印不跟随）
  status      查看 daemon 状态
  upgrade     升级到最新版本（别名：update）
  dashboard current
              获取当前 Web Dashboard 登录 URL（裸 \`dashboard\` 同义；没有则创建）
  dashboard rotate
              显式轮换 token，并打印新的登录 URL
  device enroll|status|logout
              在宿主终端注册、查看或清除 desktop device 凭证（AI CLI 会话内拒绝）
  actor current --json
              返回当前 BotMux turn 的已验证企业用户名，不暴露 open_id/邮箱；脱离当前进程树时拒绝
  mojo-containment list|revoke
              查看 / 显式撤销无法自证静止的 mojo containment handle（设备隔离
              blocker 的可审计操作员出口；revoke 需 --yes，存活证据需 --force）
  list        列出活跃会话（交互式选择并连接 tmux）
              --plain  纯文本表格输出（管道/脚本场景）
  delete <id>      关闭指定会话（支持 ID 前缀匹配）
  delete all       关闭所有活跃会话
  delete stopped   清理所有进程已退出的僵尸会话
  resume <id>      恢复一个已关闭的会话（支持 ID 前缀匹配）— 会话标记回 active，
                   下条消息会以 --resume 重新拉起 CLI 进程
  suspend <id|all>     挂起活跃会话：杀 CLI/pane 但会话保持 active，下条消息冷启动续上下文
       --bot <appId>   挂起该 bot 的全部活跃会话
       --isolated      挂起所有读隔离 bot（凭证轮换后用；下次冷启动自动同步最新凭证）
       --dry-run       只列出目标，不执行
  slash "<斜杠命令>"   会话空闲后向本会话 CLI 注入一条原生斜杠命令（需 bots.json 配 tuiSlashAllow；/cd 恒被拒）
  role switch <目录>  （会话内）切换本话题到角色库内的角色目录——角色切换用；
                   目录必须位于 ~/botmux-roles 之下
  term-link [id]   获取活跃会话的「可操作终端」（带写 token）。不回显链接，改由
                   daemon 把可操作卡片私密发给 owner（群内仅你可见，话题/单聊回退 DM）。
                   单个活跃会话可省略 id
  preview <port>   （会话内）注册当前会话已启动的本机 Web 服务；Dashboard 登录后通过
                   同源 /preview/<sessionId>/ 访问，不暴露本机地址或任何 token。
                   端口必须由本会话的进程持有（在会话内直接启动，别 setsid/nohup
                   脱离进程树）；换代/关闭后需重新注册，远端 sandbox 后端不支持
  autostart enable     注册开机自启（macOS launchd / Linux user systemd / Windows Task Scheduler，无需 sudo）
  autostart disable    注销开机自启
  autostart status     查看自启状态
       unset             清除 worker 预算覆盖，恢复按机器 CPU/内存自动推导
  lang [zh|en]         切换 UI 语言（无参 = 查看当前设置）
       --bot N         仅改 bots.json 中第 N 个 bot 的 lang
       --unset         清除（global 或 --bot N 配合）
  voice                配置语音总结（高级功能，独立于 setup）— 交互式填 TTS 引擎+凭证
       voice status    查看当前语音配置（凭证打码）
       voice disable   关闭语音功能（移除配置）
       voice asr       配置语音识别（飞书语音消息→文字驱动会话）
       voice asr status|disable   查看 / 关闭 ASR
  vc-agent tat-gate|poll
                       飞书会议智能体 P0：校验 TAT 会中事件读取、轮询会议事件并触发 workflow
  plugin              管理 botmux 插件
       plugin init <id>
                       基于官方模板创建 botmux 插件仓库
       plugin install <npm-package|local-dir>
                       安装并校验 botmux 插件；不执行插件代码、不启动 service
       plugin enable <id>
                       启用插件给指定 bot 或全局默认；不影响 host service
       plugin disable <id>
                       禁用插件引用；不影响 host service
       插件 CLI 命令使用一级命令形式：botmux <command> [args...]
                       只从全局 enabled 插件中查找
       plugin service status|start|stop [id|--all]
                       查看/管理插件 host service
  whiteboard status|enable|disable
                       本地项目白板（默认关闭；enable 只打开能力，不创建白板）
       current --create / list / read / update / write --yes
  goal start           选择团队/执行者/项目，创建或复用真实群并启动监管者
  goal supervise       在 goal 群启动 L2 监管会话（daemon-native，不依赖自 @ 路由）

定时任务（可在 CLI 会话内自动推断 chat）:
  schedule list                        列出所有任务
  schedule add <schedule> <prompt>     添加任务（ex: "30m" / "every 2h" / "每日9:00" / "0 9 * * *"）
       --top-level                     在群消息顶层执行（后续会话形态跟随普通群会话模式）
       --topic --root-msg-id <om_...>  固定在指定话题下执行
       --new-topic [--topic-title ...] 每次创建新话题和独立会话
       --silent                        静默执行：不发「执行中」提示，模型判断是否 botmux send 报警
  schedule remove <id>                 删除任务
  schedule pause|resume <id>           暂停/恢复
  schedule run <id>                    标记立即执行

飞书消息（在 CLI 会话内自动推断 session）:
  chat rename <新群名称>               修改当前会话所在群的名称
       --proactive                    标记为 AI 主动改名（应用 10 分钟防抖）
  send [content]                       发消息到当前话题（支持 stdin / --content-file）
       --images <path>                 内联图片（可重复）
       --files <path>                  附件（可重复）
       --videos <path>                 视频预览 MP4（可重复，需配套 --video-covers）
       --video-covers <path>           视频封面图片（可重复，按顺序对应 --videos）
       --card-file <path>              直接发送飞书/Lark interactive 卡片 JSON
       --card-json <json>              直接发送飞书/Lark interactive 卡片 JSON 字符串
       --layout result|progress|risk|blocked|handoff
                                       可选回复卡卡头薄壳；只在关键结果/进度/风险/阻塞/交接节点显式使用
       --response-kind progress|final|auxiliary  可选；未声明按 progress/非 final，只有 final 挂反馈
       --mention <id:name>             @提及（可重复）。id 默认是 open_id；bot 配置开启
                                       allowArbitraryMention 后也可传完整邮箱/手机号/union_id，
                                       自动解析并校验其为目标群成员，否则拒发
       --mention-back                  @回本轮触发消息的发送者（open_id 自动取自会话）
       --no-mention                    明确声明本条不@任何人
       --quote <message_id>            指定引用某条消息（普通群，默认引用本轮触发消息）
       --no-quote                      不引用，发独立消息（普通群）
       --voice "<口语文字>"            合成语音气泡发出（需先 botmux voice 配置 TTS）
       --top-level                     发顶层消息（不回复进当前话题）
       --chat-id <oc_xxx>              指定目标群（默认当前话题所在群）
       --attention[=kind]              举手：发消息的同时把本会话标进 dashboard
                                       「需要你」列并通知你——撞到只有你能解的硬阻碍
                                       （授权/拍板/缺权限）无法继续时用。消息正文即看板
                                       原因。kind=authz|decision|blocked(默认)|help。
                                       仅限回复当前会话，不能与 --top-level/--chat-id/--into
                                       /--voice 混用；用户回复后自动撤下。
       --anyway                        跳过「@ 到活跃子 bot」护栏强发（见下）
    @ 硬门：每条回复须三选一 --mention/--mention-back/--no-mention，否则报错不发。
    按内容价值选：有实质结论要对方看/确认/决策→--mention-back(或--mention点名)；
    纯记录/低优先级进度/简短确认→--no-mention；没信息量的"收到"不如不发。
    Bot→Bot 默认进入 Queue；要显式调整对方活跃的 Codex App turn，把 @steer 写成
    正文首个语义行（可放在收件人 @ 行之后）。接收端会消费该指令，不交给模型。
    （可设 BOTMUX_REQUIRE_MENTION_DECISION=false 关闭硬门）
  card patch --message-id <om_xxx> (--card-file <path> | --card-json <json>)
                       原地更新之前用 send --card-file/--card-json 发出的自定义卡片
                       （不发新消息、不换群/话题）；messageId 取自 send 成功输出的 .messageId，
                       卡片安全校验与 send 相同；[--session-id <sid>] 可手动指定会话
  bots list                            列出当前群聊中的机器人（含 open_id）
  bots invite --chat <chatId> --team <id> --agent <appId>...
                                       往「已存在的团队群」补人：把同团队、已 opt-in 的 agent + 各自 owner 一起拉进；
                                       详见 \`botmux bots invite --help\`
  history [--limit N] [--scope session|thread|chat|ambient] [--with-card-json]
                                       拉取当前会话的消息历史 (JSON)。默认按 session scope：话题/话题群 → 话题内，普通群 → 整群；
                                       thread 会话里可用 --scope ambient 读取 thread 外的群聊上下文；
                                       --with-card-json 为每张卡片附原始结构化 JSON（消息均带 resources 附件 key）
  quoted <message_id> [--raw]          按消息 id 拉取单条消息 (JSON) 并下载附件到本地；id 取自引用提示行或 history 输出，
                                       --raw 附原始内容（卡片 → cardJson，其它 → rawContent）
  ask buttons [--multi] --options "a,b" "<问题>"
                                       把选择题做成按钮卡片抛给飞书；--multi 返回逗号分隔的多个 key
                                       （无 hook 的 CLI 用它把决策引到人；也可省略 buttons 走裸别名）
  skill list                           列出本会话可用的技能（用户自定义 + botmux 内置）及其描述
  skill show <name>                    读取某技能的完整 SKILL.md 说明（prompt 注入模式下按需拉取内置技能全文）

编排 / workflow（v3）:
  goal run <goal> [--run-id <id>] [--bot <id|name>] [--working-dir <dir>]
                  [--timeout <seconds>] [--json]
                                       在现有 v3 沙箱/worker 路径运行一个 headless goal；
                                       同一 run-id 可安全重放终态或接续崩溃运行
  workflow save [last|runId] [名称]
                                       把成功 run 固化为 chat scope Saved Workflow；
                                       发布当前 Bot 全局版本 / 确认 unsafe lint 请由用户在飞书显式发送 /workflow save ...
  workflow run <名称|workflowId> [--param key=value ...]
  workflow list [--json] | show <名称|workflowId>
                                       运行 / 查看 Saved Workflow
  workflow new|spec-finalize|approve-spec|revise-spec|architect|revise-dag [...]
  workflow approve-dag|start [...]     创建、修订并运行一次性即兴 Workflow
  workflow cancel <runId> [--reason <text>] [--bot <larkAppId>]
                                       持久化取消 v3 run 并中断活动节点
  workflow retry|grant [...]           处理受阻节点 / loop
  template migrate-v3 [id|path ...] [--all] [--commit ...]
                                       v2 定义迁移：默认 dry-run，写入需显式 owner/app/scope
  template archive-runs [--commit|--verify <archive>|--retire <archive> --ack-daemon-stopped]
                                       v2 历史 run 私有静态归档；retire 在维护窗双验后原子迁入 quarantine
  （完整参数见 \`botmux workflow help\` / \`botmux template help\`）
  dispatch --bot <name> [...]          多话题编排：开子话题并把 bot 派进去（详见 \`botmux dispatch --help\`）
  report [...]                         交接 Review / 进展 / 结果并继承会话位置（详见 \`botmux report --help\`）

新建飞书群:
  create-group --bot <name> [--bot ...] [--name "群名"]
                                       用指定 bot 起新群；详见 \`botmux create-group --help\`

精确群对话授权（talk-only）:
  grant chat --bot <receiver> --chat-id <oc_...> --subject-bot <larkAppId>
                                       授权群内 Bot 与 receiver 对话，不授管理命令权；
                                       revoke/readback 详见 \`botmux grant chat --help\`

预设分享（导出某 bot 的可分享配置给同事，绝不含密钥）:
  preset export <bot> [--from-chat <chatId>] [--out <file>] [--yes]
                                       导出 cliId/model/角色/能力标签 + 接入指引；
                                       默认 team 级角色，--from-chat 取某群角色内容；
                                       缺省写 ./<name或appid>.botmux-preset.json，--out - 走 stdout

botmux skills 注入方式（仅影响 codex/gemini/opencode 等只支持全局 skills 目录的 CLI）:
  skills injection [global|prompt|off]  查看/设置机器级默认（无参=查看）
       prompt（默认）  不落全局盘，把技能目录注入进会话 prompt，按需 \`botmux skill show\`——
                       不会泄漏到你手动跑的 codex/gemini
       global          装进 CLI 全局 skills 目录（体验原生，但独立 CLI 也会看到）
       off             只留路由提示 + \`botmux --help\`，让模型自行摸索
  （per-bot 可在 bots.json 用 "skillInjection" 字段覆盖机器级默认）

提示: 多数子命令支持 \`botmux <子命令> --help\` 查看完整参数。

配置目录: ~/.botmux/
文档: https://github.com/deepcoldy/botmux
`);
}

// ─── Schedule subcommands ────────────────────────────────────────────────────

/**
 * Resolve which botmux session this subcommand belongs to. Prefers the
 * process-tree CLI-pid marker (carries the fresh turnId); falls back to the
 * inherited BOTMUX_SESSION_ID env when the ancestry is broken (detached/
 * backgrounded/deeply-nested invocations). See resolveSessionContext for why
 * the env fallback is safe.
 */
function findAncestorSessionContext(): { sessionId: string; turnId?: string; dispatchAttempt?: number } | null {
  const resolved = resolveSessionContext(resolveDataDir(), process.env.BOTMUX_SESSION_ID);
  if (!resolved) return null;
  const envAttempt = Number(process.env.BOTMUX_DISPATCH_ATTEMPT);
  const dispatchAttempt = resolved.dispatchAttempt
    ?? (Number.isSafeInteger(envAttempt) && envAttempt > 0 ? envAttempt : undefined);
  return {
    ...resolved,
    turnId: resolved.turnId ?? process.env.BOTMUX_TURN_ID,
    ...(dispatchAttempt !== undefined ? { dispatchAttempt } : {}),
  };
}

function findAncestorSessionId(): string | null {
  return findAncestorSessionContext()?.sessionId ?? null;
}

interface CurrentSession {
  sessionId: string;
  chatId: string;
  rootMessageId: string;
  workingDir?: string;
  larkAppId?: string;
  chatType?: 'group' | 'p2p';
  scope?: 'thread' | 'chat';
  ownerOpenId?: string;
}

/** Detect current session info from ancestor marker + session files. */
function detectCurrentSession(): CurrentSession | null {
  const sid = findAncestorSessionId();
  if (!sid) return null;
  const sessions = loadSessions();
  const s = sessions.get(sid);
  if (!s) return null;
  return {
    sessionId: s.sessionId,
    chatId: s.chatId,
    rootMessageId: s.rootMessageId,
    workingDir: s.workingDir,
    larkAppId: s.larkAppId,
    chatType: s.chatType,
    scope: s.scope,
    ownerOpenId: s.ownerOpenId,
  };
}

/** Pick a value from --flag <value> or --flag=value style args. */
function argValue(args: string[], ...flags: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    for (const f of flags) {
      if (a === f && i + 1 < args.length) return args[i + 1];
      if (a.startsWith(f + '=')) return a.slice(f.length + 1);
    }
  }
  return undefined;
}

function argFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

/**
 * True when `flag` is present but lacks a usable value — i.e. it's the last
 * token, is followed by another flag, or was given as `--flag=` (empty). Lets
 * callers surface a friendly error instead of silently falling back to a
 * default (e.g. treating a value-less `--from-chat` as "no chat"). `allowDash`
 * permits a bare `-` value (used by `--out -` to mean stdout).
 */
function flagPresentButValueMissing(args: string[], flag: string, allowDash = false): boolean {
  const i = args.findIndex(a => a === flag || a.startsWith(flag + '='));
  if (i < 0) return false; // absent entirely — not "missing a value"
  if (args[i].startsWith(flag + '=')) return args[i].slice(flag.length + 1) === '';
  const next = args[i + 1];
  if (next === undefined) return true;
  if (next.startsWith('-')) return !(allowDash && next === '-');
  return false;
}

/** Extract positional args, skipping --flag and the value that follows it
 *  (for --flag <value> style).  --flag=value style is self-contained.
 *  `booleanFlags` lists flags that take no value — without this hint the
 *  parser swallows the *next* arg as the flag's value, which silently eats
 *  positional content (or, worse, a following --flag's value). */
function positionals(args: string[], booleanFlags: string[] = []): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      const flagName = a.includes('=') ? a.slice(0, a.indexOf('=')) : a;
      const isBoolean = booleanFlags.includes(flagName);
      if (!a.includes('=') && !isBoolean && i + 1 < args.length) i++; // skip value
      continue;
    }
    out.push(a);
  }
  return out;
}

function readStdinUtf8(): string {
  // On a TTY, readFileSync(0) blocks waiting for terminal EOF (Ctrl+D) with no
  // prompt — `whiteboard update` with no text and no pipe looked frozen. Treat
  // a TTY as "no stdin input" so the caller's empty-content guard surfaces a
  // real error instead of an indefinite hang.
  if (process.stdin.isTTY) return '';
  try { return decodeStdinBytes(readFileSync(0)); } catch { return ''; }
}

function currentWhiteboardContext(args: string[]): { session?: SessionData; larkAppId?: string; chatId?: string; workingDir?: string; sessionId?: string } {
  const sessionIdArg = argValue(args, '--session-id');
  const sessions = loadSessions();
  const sid = sessionIdArg || findAncestorSessionId() || undefined;
  const session = sid ? sessions.get(sid) : undefined;
  return {
    session,
    sessionId: session?.sessionId ?? sid,
    larkAppId: argValue(args, '--lark-app-id', '--app-id') ?? session?.larkAppId ?? process.env.LARK_APP_ID,
    chatId: argValue(args, '--chat-id') ?? session?.chatId,
    workingDir: argValue(args, '--working-dir', '--repo') ?? session?.workingDir ?? process.cwd(),
  };
}

function requireWhiteboardEnabled(): void {
  if (whiteboardEnabled()) return;
  console.error('Whiteboard is disabled. Enable it with `botmux whiteboard enable` or the dashboard Settings page.');
  process.exit(2);
}

// Boolean flags valid on `read`/`update`/`write` that must NOT be parsed as
// value-taking. Without this hint, `positionals()` treats e.g. a bare `--yes`
// as a value flag and swallows the *following* positional arg as its "value" —
// the content ends up empty and the board is silently blanked (a shared
// current-state snapshot lost with no history). `--create` belongs to
// `current`, `--yes` to `write`, `--json` to `read`; all harmless to declare
// together so content parsing never mis-eats a flag's neighbor.
const WHITEBOARD_BOOLEAN_FLAGS = ['--create', '--yes', '--json'];

function whiteboardContentFromArgs(args: string[], booleanFlags: string[] = []): string {
  const file = argValue(args, '--content-file', '--file');
  if (file) return readFileSync(file, 'utf-8');
  const pos = positionals(args, booleanFlags);
  return pos.length > 0 ? pos.join(' ') : readStdinUtf8();
}

/** Translate store-level whiteboard write errors into friendly CLI exits. The
 *  store throws stable machine codes (whiteboard_cas_mismatch /
 *  whiteboard_empty_content / whiteboard_not_found); map each to a clear,
 *  actionable message so an agent or human reading stderr knows what to do
 *  next instead of seeing a bare code. Always exits. */
function handleWhiteboardWriteError(e: unknown, id: string, opts?: { rereadCommand?: string }): never {
  const msg = (e as Error)?.message ?? String(e);
  if (msg === 'whiteboard_cas_mismatch') {
    const reread = opts?.rereadCommand ?? `botmux whiteboard read --id ${id} --json`;
    console.error(
      `Whiteboard was modified since you last read it (CAS mismatch). Re-run ` +
      `\`${reread}\` to get the latest content ` +
      `+ updatedAt, re-merge your changes against it, then update again with ` +
      `--expected-updated-at <new updatedAt>.`,
    );
    process.exit(2);
  }
  if (msg === 'whiteboard_empty_content') {
    console.error('Refusing to write empty whiteboard content. Pass text as args, pipe stdin, or use --content-file <path>. (The board is a shared current-state snapshot and cannot be blanked.)');
    process.exit(2);
  }
  if (msg === 'whiteboard_not_found') {
    console.error(`Whiteboard not found: ${id}`);
    process.exit(1);
  }
  console.error(`Whiteboard write failed: ${msg}`);
  process.exit(1);
}

async function cmdWhiteboard(sub: string, rest: string[]): Promise<void> {
  process.env.SESSION_DATA_DIR ??= resolveDataDir();
  const action = sub || 'status';
  if (action === 'help' || action === '--help' || action === '-h') {
    console.log(`botmux whiteboard <command>

Commands:
  status                       Show whether whiteboard is enabled
  enable | disable             Toggle optional whiteboard feature (does not create boards)
  list                         List local whiteboards (read-only, even when disabled)
  current [--create]           Show current default board; --create ensures it when enabled
  create [--id ID] [--title T] Create a board for current/bound context
  read [--id ID] [--json]      Read board.md (requires enabled). --json emits
                               { id, updatedAt, content } so a caller can CAS on update
  path [--id ID]               Print board/meta/log paths
  update [--id ID] [text...]   Replace board.md current state (or stdin / --content-file).
                               --expected-updated-at <ts> refuses the write if the board
                               changed since that version (CAS); exit 2 with a re-read hint
  write --yes [--id ID] ...    Force-overwrite board.md; --yes required. Also honors
                               --expected-updated-at when supplied

Context flags: --session-id, --lark-app-id, --chat-id, --working-dir/--repo`);
    return;
  }

  if (action === 'status') {
    console.log(JSON.stringify({ enabled: whiteboardEnabled(), count: listWhiteboards().length }, null, 2));
    return;
  }
  if (action === 'enable' || action === 'on') {
    mergeGlobalConfig({ whiteboard: { enabled: true } as any });
    console.log('Whiteboard enabled. No board was created; a board is ensured only when first needed.');
    return;
  }
  if (action === 'disable' || action === 'off') {
    mergeGlobalConfig({ whiteboard: { enabled: false } as any });
    console.log('Whiteboard disabled. Existing boards remain on disk and dashboard can show history read-only.');
    return;
  }
  if (action === 'list' || action === 'ls') {
    const boards = listWhiteboards().map(b => ({ id: b.id, title: b.title, scope: b.scope, larkAppId: b.larkAppId, chatId: b.chatId, workingDir: b.workingDir, updatedAt: b.updatedAt, path: b.path }));
    console.log(JSON.stringify({ enabled: whiteboardEnabled(), boards }, null, 2));
    return;
  }

  if (action === 'current') {
    requireWhiteboardEnabled();
    const id = argValue(rest, '--id');
    if (id) {
      const meta = getWhiteboard(id);
      if (!meta) { console.error(`Whiteboard not found: ${id}`); process.exit(1); }
      console.log(JSON.stringify({ enabled: true, current: meta, path: whiteboardPath(id) }, null, 2));
      return;
    }
    const ctx = currentWhiteboardContext(rest);
    let meta = ctx.session?.whiteboardId ? getWhiteboard(ctx.session.whiteboardId) : undefined;
    if (!meta && argFlag(rest, '--create')) {
      meta = ensureDefaultWhiteboard({ larkAppId: ctx.larkAppId, chatId: ctx.chatId, workingDir: ctx.workingDir, sessionId: ctx.sessionId });
      if (ctx.session) {
        await patchSessionWhiteboardAuthoritatively(ctx.session, meta.id);
        ctx.session.whiteboardId = meta.id;
      }
    }
    if (!meta) {
      console.log(JSON.stringify({ enabled: true, current: null, hint: 'Run `botmux whiteboard current --create` to ensure the default board.' }, null, 2));
      return;
    }
    console.log(JSON.stringify({ enabled: true, current: meta, path: whiteboardPath(meta.id) }, null, 2));
    return;
  }

  if (action === 'create') {
    requireWhiteboardEnabled();
    const ctx = currentWhiteboardContext(rest);
    const meta = createWhiteboard({ id: argValue(rest, '--id'), title: argValue(rest, '--title'), larkAppId: ctx.larkAppId, chatId: ctx.chatId, workingDir: ctx.workingDir, sessionId: ctx.sessionId });
    if (ctx.session && !ctx.session.whiteboardId) {
      await patchSessionWhiteboardAuthoritatively(ctx.session, meta.id);
      ctx.session.whiteboardId = meta.id;
    }
    console.log(JSON.stringify({ board: meta, path: whiteboardPath(meta.id) }, null, 2));
    return;
  }

  // Anything reaching here must be one of the file-operating subcommands; the
  // earlier branches (help/status/enable/disable/list/current/create) already
  // returned. Reject unknown actions BEFORE computing an id — otherwise a typo
  // like `post` fell through to the misleading "No whiteboard id" error.
  if (!['read', 'path', 'update', 'write'].includes(action)) {
    console.error(`Unknown whiteboard command: ${action}`);
    process.exit(1);
  }
  if (['read', 'update', 'write'].includes(action)) requireWhiteboardEnabled();

  const explicitId = argValue(rest, '--id');
  const ctx = currentWhiteboardContext(rest);
  let id = explicitId ?? ctx.session?.whiteboardId;
  if (!id && whiteboardEnabled() && action === 'update') {
    const meta = ensureDefaultWhiteboard({ larkAppId: ctx.larkAppId, chatId: ctx.chatId, workingDir: ctx.workingDir, sessionId: ctx.sessionId });
    id = meta.id;
    if (ctx.session) {
      await patchSessionWhiteboardAuthoritatively(ctx.session, id);
      ctx.session.whiteboardId = id;
    }
  }
  if (!id) { console.error('No whiteboard id. Pass --id or run `botmux whiteboard current --create`.'); process.exit(1); }

  if (action === 'read') {
    requireWhiteboardEnabled();
    // Default: stream raw board.md to stdout (back-compat for agents/skills
    // that treat stdout as the board content). `--json` returns
    // { id, updatedAt, content } so an agent can capture the version it read
    // and pass it back as --expected-updated-at on update — the compare-and-set
    // that turns the read→merge→update flow from blind last-writer-wins into a
    // conflict-detecting update.
    if (argFlag(rest, '--json')) {
      const meta = getWhiteboard(id);
      if (!meta) { console.error(`Whiteboard not found: ${id}`); process.exit(1); }
      console.log(JSON.stringify({ id: meta.id, updatedAt: meta.updatedAt, content: readWhiteboard(id) }));
    } else {
      process.stdout.write(readWhiteboard(id));
    }
    return;
  }
  if (action === 'path') {
    const meta = getWhiteboard(id);
    if (!meta) { console.error(`Whiteboard not found: ${id}`); process.exit(1); }
    console.log(JSON.stringify({ board: meta, path: whiteboardPath(id) }, null, 2));
    return;
  }
  if (action === 'update') {
    requireWhiteboardEnabled();
    const content = whiteboardContentFromArgs(rest, WHITEBOARD_BOOLEAN_FLAGS);
    if (!content.trim()) {
      console.error('Refusing to write empty whiteboard content. Pass text as args, pipe stdin, or use --content-file <path>. (The board is a shared current-state snapshot and cannot be blanked.)');
      process.exit(2);
    }
    // Optional CAS: the agent passes the updatedAt it observed at read time.
    // If the board changed in between, the store refuses with
    // whiteboard_cas_mismatch → friendly exit 2 so the agent re-reads/merges
    // instead of silently clobbering the other writer's update.
    const expectedUpdatedAt = argValue(rest, '--expected-updated-at');
    const { writeWhiteboard } = await import('./services/whiteboard-store.js');
    try {
      const meta = writeWhiteboard(id, content, { actor: ctx.sessionId, kind: 'update', expectedUpdatedAt });
      console.log(JSON.stringify({ ok: true, board: meta }, null, 2));
    } catch (e) {
      handleWhiteboardWriteError(e, id);
    }
    return;
  }
  if (action === 'write') {
    requireWhiteboardEnabled();
    if (!argFlag(rest, '--yes')) {
      console.error('Refusing to overwrite whiteboard without --yes. Prefer `botmux whiteboard update` for current-state updates.');
      process.exit(2);
    }
    const content = whiteboardContentFromArgs(rest, WHITEBOARD_BOOLEAN_FLAGS);
    if (!content.trim()) {
      console.error('Refusing to write empty whiteboard content. Pass text as args, pipe stdin, or use --content-file <path>. (The board is a shared current-state snapshot and cannot be blanked.)');
      process.exit(2);
    }
    // `write --yes` is the human force-overwrite escape hatch, but if a CAS
    // version is supplied we still honor it — a conscious writer that knows
    // the base version should still get a conflict signal rather than clobber.
    const expectedUpdatedAt = argValue(rest, '--expected-updated-at');
    const { writeWhiteboard } = await import('./services/whiteboard-store.js');
    try {
      const meta = writeWhiteboard(id, content, { actor: ctx.sessionId, expectedUpdatedAt });
      console.log(JSON.stringify({ ok: true, board: meta }, null, 2));
    } catch (e) {
      handleWhiteboardWriteError(e, id);
    }
    return;
  }

  console.error(`Unknown whiteboard command: ${action}`);
  process.exit(1);
}

async function cmdSchedule(sub: string, rest: string[]): Promise<void> {
  // Ensure SESSION_DATA_DIR points at the daemon's data dir so schedule-store
  // writes to the right file even when invoked outside the daemon env.
  process.env.SESSION_DATA_DIR ??= resolveDataDir();

  const scheduler = await import('./core/scheduler.js');
  const scheduleStore = await import('./services/schedule-store.js');

  // Per-bot stores: bind this invocation to one bot's store — explicit
  // --lark-app-id wins, else the surrounding session's bot (env/marker-derived;
  // always present inside sandboxed sessions). A bare terminal without either
  // binds to the primary bot (bots.json[0]) so mutations keep the legacy
  // "ownerless task runs on bot-0" semantics; `list` without a bound bot
  // aggregates every readable store instead.
  const cliScopeAppId = argValue(rest, '--lark-app-id')
    ?? detectCurrentSession()?.larkAppId
    ?? process.env.BOTMUX_LARK_APP_ID;
  // LAZY + sandbox-safe bots.json read: sandboxed sessions always carry a
  // scope (env-injected appId) and must never touch bots.json — it is denied
  // and `loadBotsJson()` process.exit(1)s on the read error. Only the bare
  // unsandboxed terminal (aggregate list / cross-store id lookup) reads it,
  // and even then failure degrades to "no other stores visible".
  const allBotAppIds = (): string[] => {
    try {
      return parseBotConfigsJson(readFileSync(BOTS_JSON_FILE, 'utf-8'), BOTS_JSON_FILE)
        .map((b: { larkAppId?: unknown }) => b?.larkAppId)
        .filter((x: unknown): x is string => typeof x === 'string');
    } catch { return []; } // absent OR sandbox-denied → own scope only
  };
  if (cliScopeAppId) scheduleStore.setScheduleScope(cliScopeAppId);
  else {
    const first = allBotAppIds()[0];
    if (first) scheduleStore.setScheduleScope(first);
  }

  if (!sub || sub === 'list' || sub === 'ls') {
    const tasks = cliScopeAppId
      ? scheduleStore.listTasks()
      : scheduleStore.listTasksForBots(allBotAppIds());
    if (tasks.length === 0) {
      console.log('暂无定时任务。\n\n用法:\n  botmux schedule add "每日17:50" "帮我看AI新闻"\n  botmux schedule add "every 2h" "检查构建"\n  botmux schedule add "0 9 * * *" "每天早安"');
      return;
    }
    const filter = argValue(rest, '--chat-id');
    const filtered = filter ? tasks.filter(t => t.chatId === filter) : tasks;
    console.log(`定时任务 (${filtered.length}${filter ? '/' + tasks.length : ''}):\n`);
    for (const t of filtered) {
      const status = t.enabled ? '✅' : '⏸️';
      const next = t.nextRunAt ? new Date(t.nextRunAt).toLocaleString('zh-CN', { timeZone: scheduleTimeZone() }) : '—';
      const last = t.lastRunAt ? new Date(t.lastRunAt).toLocaleString('zh-CN', { timeZone: scheduleTimeZone() }) : '—';
      const display = t.parsed?.display ?? t.schedule;
      const prompt = t.prompt ?? '';
      const chatId = t.chatId ?? '—';
      const rootId = t.rootMessageId ?? '—';
      console.log(`${status} [${t.id}] ${display} | ${t.name}${t.silent ? ' 🔇静默' : ''}`);
      console.log(`   prompt: ${prompt.length > 60 ? prompt.slice(0, 60) + '…' : prompt}`);
      console.log(`   chat: ${chatId.slice(0, 12)}…   thread: ${rootId.slice(0, 16)}…`);
      console.log(`   next: ${next}   last: ${last}${t.lastStatus === 'error' ? ' ❌' : ''}`);
      console.log('');
    }
    return;
  }

  if (sub === 'add') {
    const [rawSchedule, ...promptParts] = positionals(rest, ['--new-topic', '--top-level', '--topic', '--silent']);
    if (!rawSchedule) {
      console.error('用法: botmux schedule add <schedule> <prompt> [--name NAME] [--chat-id CHAT] [--top-level | --topic --root-msg-id ROOT | --new-topic [--topic-title TITLE]] [--lark-app-id APP] [--workdir DIR] [--silent]');
      process.exit(1);
    }
    // prompt may come from positional or --prompt flag
    const promptArg = argValue(rest, '--prompt') ?? promptParts.join(' ');
    if (!promptArg) {
      console.error('缺少 prompt。用法: botmux schedule add <schedule> <prompt>');
      process.exit(1);
    }

    const cur = detectCurrentSession();
    const chatId = argValue(rest, '--chat-id') ?? cur?.chatId;
    const explicitRootMessageId = argValue(rest, '--root-msg-id');
    const rootMessageId = explicitRootMessageId
      ?? (chatId && chatId === cur?.chatId ? cur.rootMessageId : undefined);
    // Owner resolution mirrors the store-scope resolution above (flag →
    // session marker → daemon-injected env): a sandboxed session without a
    // readable marker must still stamp its own bot as owner, or the task
    // would land in this bot's store as OWNERLESS — which only the primary
    // daemon executes — and never fire (codex review P1).
    const larkAppId = cliScopeAppId;
    const workingDir = argValue(rest, '--workdir') ?? cur?.workingDir ?? process.cwd();
    const name = argValue(rest, '--name') ?? (promptArg.length > 20 ? promptArg.slice(0, 20) + '…' : promptArg);
    const legacyDeliver = argValue(rest, '--deliver') as 'origin' | 'local' | 'new-topic' | undefined;
    const wantsNewTopic = rest.includes('--new-topic') || legacyDeliver === 'new-topic';
    const wantsTopLevel = rest.includes('--top-level');
    const wantsTopic = rest.includes('--topic');
    if ([wantsNewTopic, wantsTopLevel, wantsTopic].filter(Boolean).length > 1) {
      console.error('--top-level、--topic 与 --new-topic 只能选择一个。');
      process.exit(1);
    }
    const requestedDeliver = legacyDeliver;
    const deliver: 'origin' | 'local' = requestedDeliver === 'local' ? 'local' : 'origin';
    // --silent: fires post no "执行中" banner; the spawned turn stays quiet and
    // the model only `botmux send`s when the alert condition in the prompt is met.
    const silent = rest.includes('--silent');
    if (!chatId) {
      console.error('无法推断 chat-id。请加上 --chat-id <CHAT_ID>，或从 Lark 话题内的 CLI 会话中运行本命令。');
      process.exit(1);
    }
    // Default to group top-level: a schedule created inside a topic session
    // (including an adopted one) must not pin its results to that topic.
    // --topic opts in explicitly; p2p sessions keep the legacy inference.
    const executionPosition: 'top-level' | 'topic' | 'new-topic' = wantsNewTopic
      ? 'new-topic'
      : wantsTopLevel
        ? 'top-level'
        : wantsTopic
          ? 'topic'
          : cur?.chatType === 'p2p'
            ? (cur?.scope === 'chat' ? 'top-level' : rootMessageId ? 'topic' : 'top-level')
            : 'top-level';
    const scope: 'thread' | 'chat' = executionPosition === 'topic' ? 'thread' : 'chat';
    if (scope === 'thread' && !rootMessageId) {
      console.error('话题下执行需要 --root-msg-id <ROOT_MESSAGE_ID>，或从 Lark 话题会话中运行。');
      process.exit(1);
    }
    const topicTitle = argValue(rest, '--topic-title');
    if (topicTitle && executionPosition !== 'new-topic') {
      console.error('--topic-title 仅可与 --new-topic 一起使用。');
      process.exit(1);
    }
    if (topicTitle && Array.from(topicTitle.trim()).length > 200) {
      console.error('--topic-title 最多 200 个字符。');
      process.exit(1);
    }

    let parsed;
    try { parsed = scheduler.parseSchedule(rawSchedule); }
    catch (err: any) {
      console.error(`无法解析 schedule "${rawSchedule}": ${err.message}`);
      process.exit(1);
    }

    let task;
    try {
      task = scheduler.addTask({
        name,
        schedule: rawSchedule,
        parsed,
        prompt: promptArg,
        workingDir,
        chatId,
        // Only topic execution keeps the captured root; at top-level the root
        // is dropped so toggles can never pull execution back into the
        // originating (e.g. adopted) topic.
        rootMessageId: executionPosition === 'topic' ? rootMessageId : undefined,
        larkAppId,
        creatorChatId: cur?.chatId,
        creatorRootMessageId: cur?.rootMessageId,
        creatorLarkAppId: cur?.larkAppId,
        // Stamp the creator (sandboxed session owner) so the task's scheduled
        // turns can authenticate workflow commands as them. The daemon
        // re-checks the owner is still allowed at every run mutation.
        ownerOpenId: process.env.BOTMUX_OWNER_OPEN_ID ?? cur?.ownerOpenId,
        chatType: cur?.chatType === 'p2p' ? 'p2p' : 'topic_group',
        scope,
        executionPosition,
        topicTitle,
        deliver,
        silent,
      });
    } catch (err) {
      // Sandboxed sessions can only write their OWN bot's store — a cross-bot
      // `--lark-app-id` (or a scope pointing at another bot) fails closed here.
      if (/EPERM|EACCES|not permitted/i.test(String(err))) {
        console.error(`无法写入目标 bot 的定时任务存储（${larkAppId ?? '未指定'}）：沙盒会话只能管理自己 bot 的任务。`);
        process.exit(1);
      }
      throw err;
    }

    const next = task.nextRunAt ? new Date(task.nextRunAt).toLocaleString('zh-CN', { timeZone: scheduleTimeZone() }) : '—';
    console.log(`✅ 已创建定时任务 [${task.id}] ${task.name}`);
    console.log(`   规则: ${parsed.display}`);
    console.log(`   下次执行: ${next}`);
    console.log(`   工作目录: ${workingDir}`);
    console.log(`   执行位置: ${executionPosition === 'new-topic' ? '每次新话题' : executionPosition === 'top-level' ? '群消息顶层' : '话题下'}`);
    if (executionPosition === 'new-topic' && topicTitle?.trim()) console.log(`   新话题标题: ${topicTitle.trim()}`);
    if (silent) console.log('   静默: 触发时不发「执行中」提示，由模型判断是否需要 botmux send 报警');
    return;
  }

  const id = positionals(rest)[0];
  if (!id) {
    console.error(`用法: botmux schedule ${sub} <id>`);
    process.exit(1);
  }

  // Id-addressed op missed the bound store: locate the id across every
  // READABLE bot store (bare-terminal admin usage) and rebind the scope to the
  // owning bot for this one-shot process. Sandboxed callers cannot read
  // sibling stores, so they stay confined to their own tasks by construction.
  const retargetIfElsewhere = (): boolean => {
    const hit = scheduleStore.findTaskAcrossBots(id, allBotAppIds());
    if (!hit || hit.appId === scheduleStore.getScheduleScope()) return false;
    scheduleStore.setScheduleScope(hit.appId);
    console.log(`（任务属于 bot ${hit.appId} 的存储）`);
    return true;
  };

  switch (sub) {
    case 'remove':
    case 'rm':
    case 'delete':
    case 'del': {
      let ok = scheduler.removeTask(id);
      if (!ok && retargetIfElsewhere()) ok = scheduler.removeTask(id);
      if (ok) console.log(`已删除任务 ${id}`);
      else { console.error(`未找到任务 ${id}`); process.exit(1); }
      break;
    }
    case 'pause':
    case 'disable': {
      let ok = scheduler.disableTask(id);
      if (!ok && retargetIfElsewhere()) ok = scheduler.disableTask(id);
      if (ok) console.log(`已暂停任务 ${id}`);
      else { console.error(`未找到任务 ${id}`); process.exit(1); }
      break;
    }
    case 'resume':
    case 'enable': {
      let ok = scheduler.enableTask(id);
      if (!ok && retargetIfElsewhere()) ok = scheduler.enableTask(id);
      if (ok) console.log(`已恢复任务 ${id}`);
      else { console.error(`未找到任务 ${id}`); process.exit(1); }
      break;
    }
    case 'run':
      // Running requires the daemon (executeCallback is daemon-side).
      // CLI can only mark a task to run ASAP; daemon's next tick picks it up.
      {
        let task = scheduleStore.getTask(id);
        if (!task && retargetIfElsewhere()) task = scheduleStore.getTask(id);
        if (!task) { console.error(`未找到任务 ${id}`); process.exit(1); }
        scheduleStore.updateTask(id, { nextRunAt: new Date().toISOString() });
        console.log(`已标记任务 ${id} 下次 tick 立即执行（< 30s）`);
      }
      break;
    default:
      console.error(`未知子命令: ${sub}\n可用: list | add | remove | pause | resume | run`);
      process.exit(1);
  }
}

/** Resolve a CLI subcommand's larkAppId by walking the session marker. Common
 *  prelude for `history` / `quoted` / similar commands that need to talk to
 *  Lark on behalf of the session that spawned them. Exits with stderr on
 *  failure so callers can stay focused on the happy path. */
async function resolveSessionAppId(sessionIdArg: string | undefined): Promise<{ sid: string; larkAppId: string; session: SessionData }> {
  process.env.SESSION_DATA_DIR ??= resolveDataDir();
  const sid = sessionIdArg ?? findAncestorSessionId() ?? process.env.BOTMUX_SESSION_ID;
  if (!sid) {
    console.error('无法推断 session-id。请在 Lark 话题/群里的 CLI 会话中运行，或传 --session-id <id>。');
    process.exit(1);
  }
  // riff sandbox env-mode：与 cmdSend 同一权威规则（仅覆盖 env 注入的 sid）。
  // 远端沙箱没有 sessions.json / bots.json，history/quoted/bots 走同一合成会话，
  // 且跳过本地 bots 重载（沙箱残留的 stale bots.json 不得覆盖 env 凭证）。
  {
    const riff = riffModeSession({ evenWithLocalSessions: sid === process.env.BOTMUX_SESSION_ID });
    if (riff && riff.session.sessionId === sid) {
      const { registerBot } = await import('./bot-registry.js');
      try { registerBot(riff.botConfig); } catch { /* already registered */ }
      envPinnedRiffBot = riff.botConfig;
      return { sid, larkAppId: riff.session.larkAppId!, session: riff.session };
    }
  }
  const sessions = loadSessions();
  const s = sessions.get(sid);
  if (!s) {
    console.error(`未找到 session ${sid}`);
    process.exit(1);
  }
  if (!s.larkAppId) {
    console.error(`session ${sid} 缺少 larkAppId，无法获取消息`);
    process.exit(1);
  }
  // Ensure bot is registered so getBotClient works
  const { registerBot, loadBotConfigs } = await import('./bot-registry.js');
  try {
    for (const cfg of loadBotConfigs()) registerBot(cfg);
  } catch { /* ignore */ }
  return { sid, larkAppId: s.larkAppId, session: s };
}

async function cmdHistory(rest: string[]): Promise<void> {
  // Reject unrecognized flags BEFORE anything else. Every flag below is pulled
  // out of argv by name; a flag that is not pulled is simply not there, so a
  // typo or an invented flag used to be answered with the default behaviour and
  // no diagnostic at all. `--thread` (there is no such flag; the spelling is
  // `--scope thread`) came back as session scope, which for a thread-scope
  // session is the same window — so the mistake was invisible in the output too.
  const unknown = unknownFlags(rest, {
    valueFlags: ['--limit', '--scope', '--session-id'],
    boolFlags: ['--with-card-json'],
  });
  if (unknown.length > 0) {
    console.error(`未知参数: ${unknown.join(' ')}`);
    console.error('  botmux history [--limit <n>] [--scope session|thread|chat|ambient] [--session-id <id>] [--with-card-json]');
    process.exit(2);
  }
  // No-transport turn has no Feishu chat history to read — central hard gate.
  assertTurnTransportOrExit('history');
  // Read isolation: register this bot from its cred file so the Lark client is
  // available without reading the denied bots.json (same as cmdSend).
  await registerSelfFromCredFile();
  // Clamp to a positive count: the underlying list helpers treat pageSize <= 0
  // (and non-finite) as "unlimited / read the whole chat", which is reserved for
  // internal callers. A stray `--limit 0` or a typo like `--limit abc` (→ NaN)
  // must NOT silently dump the entire history.
  const parsedLimit = parseInt(argValue(rest, '--limit') ?? '50', 10);
  const limit = Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : 50;
  const scopeArg = argValue(rest, '--scope') ?? 'session';
  const sessionIdArg = argValue(rest, '--session-id');
  const { sid, larkAppId: appId, session: s } = await resolveSessionAppId(sessionIdArg);
  // Target-aware gate: a --session-id pointing at a virtual/apiOnly session must
  // be refused even from a normal turn (env gate above can't see the argument).
  assertSessionTransportOrExit({ chatId: s.chatId, larkAppId: appId }, 'history');

  const validScopes = new Set(['session', 'thread', 'chat', 'ambient']);
  if (!validScopes.has(scopeArg)) {
    console.error(`无效 --scope: ${scopeArg}。可用: session | thread | chat | ambient`);
    process.exit(1);
  }

  const withCardJson = rest.includes('--with-card-json');
  const { getMessageDetail, listAmbientChatMessages, listThreadMessages, listChatMessages } = await import('./im/lark/client.js');
  const { parseApiMessage, cardContentHasUpgradeFallback, resolveMergedCardContent, extractResources, createImgNumberer } = await import('./im/lark/message-parser.js');
  const { expandMergeForward } = await import('./im/lark/merge-forward.js');
  try {
    // Chat-scope sessions (普通群整群一会话) have no thread to walk — list the
    // chat container directly and let the caller cap with --limit. Thread-scope
    // sessions walk the thread container by root_id. `--scope chat|ambient`
    // lets a thread-scope session intentionally read outside its thread when
    // it needs the surrounding group conversation (for example `/t` spawned
    // from an ongoing 普通群 discussion).
    const isChatScope = s.scope === 'chat';
    const effectiveScope = scopeArg === 'session'
      ? (isChatScope ? 'chat' : 'thread')
      : scopeArg;

    if (effectiveScope === 'thread' && isChatScope) {
      console.error('当前 session 是 chat-scope，没有 thread 历史可读取。请使用 --scope chat。');
      process.exit(1);
    }

    if (effectiveScope === 'ambient' && isChatScope) {
      console.error('当前 session 是 chat-scope，没有 thread root 可作为 ambient 边界。请使用 --scope chat。');
      process.exit(1);
    }

    let ambientBeforeCreateTime: string | undefined;
    if (effectiveScope === 'ambient') {
      try {
        const detail = await getMessageDetail(appId, s.rootMessageId, { userCardContent: false });
        ambientBeforeCreateTime = detail?.items?.[0]?.create_time;
      } catch {
        // Best-effort only: ambient history should still work if the root
        // message was withdrawn or is otherwise unavailable; it will then fall
        // back to the chat tail with current-thread messages filtered out.
      }
    }

    const raw = effectiveScope === 'chat'
      ? await listChatMessages(appId, s.chatId, limit)
      : effectiveScope === 'ambient'
        ? await listAmbientChatMessages(appId, s.chatId, limit, {
            beforeCreateTime: ambientBeforeCreateTime,
            excludeRootMessageId: s.rootMessageId,
          })
        : await listThreadMessages(appId, s.chatId, s.rootMessageId, limit);
    // Expand merge_forward to <forwarded_messages> XML, mirroring the live event
    // path in daemon.ts. Each message gets its own numberer with resources
    // assigned BEFORE text extraction, so in-body [图片 N] placeholders match
    // the surfaced `resources` order (same contract as parseEventMessage).
    // Resources carry key+name only — no download here; `botmux quoted <om_id>`
    // fetches any message's full text AND downloads its attachments locally.
    const messages = await Promise.all(raw.map(async (m: any) => {
      const numberer = createImgNumberer();
      let resources = extractResources(m.msg_type ?? 'text', m.body?.content ?? '', numberer);
      const parsed = parseApiMessage(m, numberer);
      let cardJson: unknown;
      // `im.v1.message.list` returns Lark's simplified "请升级客户端" fallback for
      // complex cards — the whole body (user-forwarded) or nested sub-cards
      // buried mid-body (Argos alarms). Those are the cards where the list view
      // alone is incomplete, so resolve them by unioning both `im.message.get`
      // representations (server-rendered + full structured). Failures keep the
      // list text. Simple cards (no fallback) already render fully here —
      // --with-card-json resolves ALL cards since the structured JSON only
      // exists on the `im.message.get` representation.
      if (parsed.msgType === 'interactive' && (withCardJson || cardContentHasUpgradeFallback(parsed.content))) {
        // Fresh numberer: the resolve REPLACES both content and resources, so
        // its [图片 N] numbering must restart at 1 alongside merged.resources.
        // Keeping the list-view resources would leak the upgrade-fallback
        // shell's phantom image (a "请升级" placeholder, absent from the real
        // card) into every complex card's resource list.
        const cardNumberer = createImgNumberer();
        const merged = await resolveMergedCardContent(appId, parsed.messageId, cardNumberer).catch(() => null);
        if (merged) {
          parsed.content = merged.text;
          resources = merged.resources;
          if (withCardJson) {
            try { cardJson = JSON.parse(merged.structuredContent); }
            catch { cardJson = merged.structuredContent; }
          }
        }
      }
      if (parsed.msgType === 'merge_forward') {
        const { extraResources } = await expandMergeForward(appId, parsed.messageId, parsed, numberer);
        if (extraResources.length) resources = [...resources, ...extraResources];
      }
      return {
        ...parsed,
        ...(resources.length ? { resources } : {}),
        ...(cardJson !== undefined ? { cardJson } : {}),
      };
    }));
    // Range guidance, emitted at the moment the model is actually reading
    // history. The decisive fact is `sessionScope` (this session's own scope),
    // NOT the chat's `chat_mode`: a thread opened inside a 普通群 keeps
    // chat_mode='group' while its session is thread-scope, so reasoning from the
    // group type would wrongly conclude "I may search the whole chat". Both
    // `--scope` gates above key on isChatScope for exactly that reason.
    //
    // Wording note: describe only what the model can OBSERVE. Daemon-side
    // invocations (`/t` and friends) are stripped before the prompt is built, so
    // the model never sees them — naming them here would be an instruction it
    // cannot act on. Describe the symptom instead: the topic starts mid-discussion
    // and its own history looks too short to explain the task.
    const rangeHint = isChatScope
      ? '范围：本次返回当前群整群最近 N 条（不限于 session 创建之后）。需要更早的消息就把 `--limit` 调大。当前是 chat-scope 会话，没有话题边界，`--scope thread` / `--scope ambient` 在此不适用。'
      : effectiveScope === 'thread'
        ? '范围：本次只返回当前话题内的消息。如果话题内的内容不足以说明任务背景（例如任务像是延续话题之外的讨论、出现没有出处的指代或结论），说明上下文在话题外的群聊里：用 `botmux history --scope ambient --limit 20` 读取本话题之外、话题根之前的群聊消息（自动排除本话题）。注意隐私边界：ambient 会读到话题外的群聊内容，仅在确实需要群聊背景时使用，并优先用较小的 limit。'
        : effectiveScope === 'ambient'
          ? '范围：本次返回的是话题之外的群聊消息（话题根之前，已排除本话题）。要回到本话题内的消息用 `botmux history`（默认即本话题）。'
          : '范围：本次按 `--scope chat` 返回整群最近 N 条（含本话题内的消息）。只要本话题内的用 `botmux history`（默认即本话题）。';
    console.log(JSON.stringify({
      sessionId: sid,
      chatId: s.chatId,
      scope: effectiveScope,
      sessionScope: isChatScope ? 'chat' : 'thread',
      ...(isChatScope ? {} : { rootMessageId: s.rootMessageId }),
      ...(effectiveScope === 'ambient' ? {
        ambient: {
          source: 'chat',
          beforeCreateTime: ambientBeforeCreateTime,
          excludeRootMessageId: s.rootMessageId,
        },
      } : {}),
      messages,
      total: messages.length,
      rangeHint,
      // Discoverability: agents reading history often need the actual image
      // bytes (alert charts) or the raw card JSON — both live one command away.
      ...(messages.some(m => (m as any).resources?.length || m.msgType === 'interactive') ? {
        hint: '查看某条消息的附件图片/文件或卡片全文：botmux quoted <messageId>（任意消息 id 均可，附件会下载到本地）；需要原始卡片 JSON：botmux quoted <messageId> --raw 或本命令加 --with-card-json',
      } : {}),
    }, null, 2));
  } catch (err: any) {
    console.error(`获取消息失败: ${err.message}`);
    process.exit(1);
  }
}


async function cmdQuoted(rest: string[]): Promise<void> {
  // No-transport turn cannot fetch a quoted Feishu message — central hard gate.
  assertTurnTransportOrExit('quoted');
  const sessionIdArg = argValue(rest, '--session-id');
  // Positional message_id is required. The id comes verbatim from the
  // `[用户引用了消息 用 botmux quoted om_xxx 查看]` prompt prefix the daemon
  // injects when the user used the Lark quote-reply UI. Skip --session-id and
  // its value so `botmux quoted --session-id <uuid> om_xxx` doesn't pick up
  // the uuid as the message id.
  const messageId = firstPositional(rest, ['--session-id']);
  const rawFlag = rest.includes('--raw');
  if (!messageId) {
    console.error('用法: botmux quoted <message_id> [--raw] [--session-id <id>]');
    process.exit(1);
  }

  // Read isolation: register this bot from its own send-cred file so the Lark
  // client (getMessageDetail below) is available WITHOUT reading the denied
  // bots.json — same as cmdHistory / cmdSend. Missing this was why a sandboxed
  // isolated bot's `botmux quoted` failed "Bot not registered".
  await registerSelfFromCredFile();
  const { larkAppId: appId, session: quotedSession } = await resolveSessionAppId(sessionIdArg);
  // Target-aware gate (see cmdHistory).
  assertSessionTransportOrExit({ chatId: quotedSession.chatId, larkAppId: appId }, 'quoted');

  const { getMessageDetail } = await import('./im/lark/client.js');
  const { expandMergeForward } = await import('./im/lark/merge-forward.js');
  const { renderQuotedMessage } = await import('./cli/quoted-render.js');
  const { resolveMergedCardContent } = await import('./im/lark/message-parser.js');
  try {
    const detail = await getMessageDetail(appId, messageId);
    const msg = detail?.items?.[0];
    if (!msg) {
      console.error(`未找到消息 ${messageId}`);
      process.exit(1);
    }
    // Interactive cards are re-resolved inside the render pipeline (both
    // im.message.get representations unioned, content + resources replaced
    // wholesale with fresh [图片 N] numbering — see renderQuotedMessage).
    const rendered = await renderQuotedMessage(appId, msg, expandMergeForward, resolveMergedCardContent);
    if (rawFlag) {
      if (rendered.mergedStructuredContent !== undefined) {
        // --raw: surface the full structured card JSON (v2 body/elements) so
        // automation can read exact field values, button URLs and image keys
        // instead of re-parsing the rendered text (告警自动化场景).
        try { (rendered as { cardJson?: unknown }).cardJson = JSON.parse(rendered.mergedStructuredContent); }
        catch { (rendered as { cardJson?: unknown }).cardJson = rendered.mergedStructuredContent; }
      } else {
        // Non-card messages (and cards whose merge failed): expose the
        // original body content verbatim for the same automation use case.
        (rendered as { rawContent?: string }).rawContent = msg.body?.content ?? '';
      }
    }
    delete rendered.mergedStructuredContent;
    // The referenced message's file/media resources arrive as key+name only. A
    // read-isolated agent can't call the Lark resource API itself (bots.json
    // creds are deny-read), so download the bytes HERE — via the bot client
    // registered above — into this bot's OWN attachment bucket
    // (attachments/<appId>/<messageId>/, read-allowed by its carve-out; sandbox
    // denies file *reads*, not writes). Surface the local paths so the agent can
    // actually open the file instead of only seeing its key.
    if (rendered.resources?.length) {
      const { downloadResources } = await import('./core/session-manager.js');
      const { attachments, needLogin } = await downloadResources(appId, messageId, rendered.resources);
      (rendered as { attachments?: unknown }).attachments = attachments;
      if (needLogin) (rendered as { needLogin?: boolean }).needLogin = true;
    }
    console.log(JSON.stringify(rendered, null, 2));
  } catch (err: any) {
    console.error(`获取被引用消息失败: ${err.message}`);
    process.exit(1);
  }
}

// ─── Send subcommand ─────────────────────────────────────────────────────────

/** Read all of stdin until EOF. Returns '' if stdin is a TTY (no piped data). */
function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) { resolve(''); return; }
    const chunks: Buffer[] = [];
    process.stdin.on('data', (c) => chunks.push(c));
    process.stdin.on('end', () => {
      const raw = Buffer.concat(chunks);
      resolve(decodeStdinBytes(raw));
    });
    process.stdin.on('error', () => resolve(''));
  });
}

/** Extract text from the legacy post-JSON shape some CLIs emit by accident. */
function extractCardText(content: string): string {
  try {
    const parsed = JSON.parse(content);
    const inner = parsed.zh_cn ?? parsed.en_us ?? parsed;
    if (!Array.isArray(inner?.content)) return content;
    const lines: string[] = [];
    for (const para of inner.content) {
      if (!Array.isArray(para)) continue;
      lines.push(para.filter((node: any) => node.tag === 'text').map((node: any) => node.text).join(''));
    }
    return lines.join('\n').trim();
  } catch {
    return content;
  }
}

// decodeStdinBytes lives in ./cli/stdin-encoding.ts (imported above) so it
// can be unit-tested with an explicit platform argument.

/** Collect all values for a repeatable flag: --flag v1 --flag v2 */
function argValues(args: string[], ...flags: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    for (const f of flags) {
      if (args[i] === f && i + 1 < args.length) { out.push(args[++i]); break; }
      if (args[i].startsWith(f + '=')) { out.push(args[i].slice(f.length + 1)); break; }
    }
  }
  return out;
}

function withCustomCardMentionFooter(
  card: Record<string, unknown>,
  mentionOpenIds: readonly string[],
  locale?: Locale,
): { ok: true; card: Record<string, unknown> } | { ok: false; error: string } {
  if (mentionOpenIds.length === 0) return { ok: true, card };
  const deduped = [...new Set(mentionOpenIds.filter(Boolean))];
  const cloned = appendReplyCardFooterToV2Card(card, {
    brand: '',
    recipientOpenIds: deduped,
    locale,
  });
  if (!cloned) {
    return {
      ok: false,
      error: '自定义卡片带 --mention/--mention-back 时必须是 schema 2.0、包含 body.elements，且未占用 botmux_reply_footer 元素 ID；或改用 --no-mention 并在卡片 JSON 内自行处理展示',
    };
  }
  return { ok: true, card: cloned };
}

function parseGoalDecisionOptionsOrExit(args: string[], context: string): GoalDecisionOption[] | undefined {
  const optionsRaw = argValue(args, '--options');
  const recommendedRaw = argValue(args, '--recommended', '--selected');
  if (!optionsRaw) {
    if (recommendedRaw) {
      console.error(`${context}: --recommended 只能和 --options 一起使用`);
      process.exit(1);
    }
    return undefined;
  }
  let parsed;
  try {
    parsed = parseAskOptions(optionsRaw);
  } catch (err) {
    if (err instanceof AskArgsError) {
      console.error(`${context}: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }
  const recommended = recommendedRaw?.trim();
  if (recommended && !parsed.some((opt) => opt.key === recommended)) {
    console.error(`${context}: --recommended 必须匹配 --options 里的 key（收到 ${recommended}）`);
    process.exit(1);
  }
  return parsed.map((opt) => ({
    ...opt,
    recommended: recommended ? opt.key === recommended : undefined,
  }));
}

// Card v2 body builder helpers — extracted to im/lark/md-card.ts so the
// daemon's bridge fallback path can produce identical cards. cmdSend
// keeps using `buildImageCardElements` from there.
import {
  appendReplyCardFooterToV2Card,
  buildImageCardElements,
  buildReplyCardFooter,
  createReplyCard,
  extractFirstReplyCardHeading,
  prepareCardMarkdown,
  type CardUsageSnapshot,
  type LocalHomeLinkMode,
} from './im/lark/md-card.js';
import {
  buildReplyLayoutHeader,
  parseReplyLayoutRequest,
  resolveReplyStyle,
  type ReplyLayout,
} from './im/lark/reply-card-style.js';
import { buildFeedbackElement } from './im/lark/skill-feedback-card.js';
import { resolveFeedbackPolicyForDelivery, resolveFeedbackTeamId } from './services/feedback-policy-resolver.js';
import { normalizeFeedbackPolicy } from './services/feedback-policy.js';
import { applyInlineMentions } from './im/lark/inline-mentions.js';
import { renderBrandTemplate } from './im/lark/brand-template.js';
import {
  effectiveDefaultWorkingDir,
  getBot,
  loadBotConfigs,
  resolveBrandLabel,
  resolveReplyStyleConfig,
  resolveUsageDisplay,
} from './bot-registry.js';
import { resolvePricingConfig, type ResolvedModelPricing } from './services/model-pricing.js';
import { config } from './config.js';
import { getSessionUsageSnapshot } from './core/cost-calculator.js';
import { openLedger } from './verified-delivery/ledger.js';
import { buildReport, parseArtifactText } from './verified-delivery/report.js';
import { formatHelpEnvelope, formatReportEnvelope, type EnvelopeEvidence } from './verified-delivery/envelope.js';
import { parseAcceptanceCriteria } from './verified-delivery/acceptance.js';
import { emitGoalNarration } from './verified-delivery/narration.js';
import {
  resolveQuoteTarget,
  shouldDropAfterTheFactTopicQuote,
  validateMentionDecision,
  classifyMentionIdentifiers,
  outsidersForMembership,
  mentionBackAmbiguity,
  mentionBackAmbiguityError,
  parseAttentionFlag,
  attentionUsageError,
  managedVcQuoteError,
  managedVcCustomCardError,
  managedVcSendControlError,
  managedVcSendPayloadError,
  containsLarkAtTag,
} from './services/send-policy.js';

/**
 * Sandbox relay mode for `botmux send`. Inside a file-sandbox the CLI cannot
 * read bots.json or reach Lark directly (creds are deliberately absent), so we
 * hand the send to the daemon-side outbox watcher (adapters/backend/sandbox.ts
 * startOutboxWatcher), which re-runs `send` OUTSIDE the sandbox with the
 * worker's creds. Forward the argv verbatim (content via a file in the shared
 * outbox), then block on the response file and mirror its result.
 */
async function relaySend(
  rest: string[],
  relayDir: string,
  replyLayout?: ReplyLayout,
): Promise<void> {
  const unsupportedRouting = ['--chat-id', '--into', '--top-level']
    .filter(flag => rest.some(token => token === flag || token.startsWith(`${flag}=`)));
  if (unsupportedRouting.length > 0) {
    console.error(JSON.stringify({
      success: false,
      transportState: 'failed',
      acceptanceState: 'not_requested',
      errorCode: 'ROUTING_NOT_SUPPORTED',
      detail: `sandbox send does not support routing flags: ${unsupportedRouting.join(', ')}; use botmux dispatch --bot-app for cross-bot delivery`,
    }));
    process.exit(2);
  }
  const sid = argValue(rest, '--session-id') ?? process.env.BOTMUX_SESSION_ID;
  if (!sid) { console.error('relay: 无法确定 session-id'); process.exit(1); }
  const cardJsonArg = argValue(rest, '--card-json');
  const cardFile = argValue(rest, '--card-file');
  let cardContent = '';
  if (cardJsonArg !== undefined && cardFile !== undefined) {
    console.error('relay: --card-json 与 --card-file 不能同时使用');
    process.exit(2);
  }
  if (cardJsonArg !== undefined) {
    cardContent = cardJsonArg;
  } else if (cardFile !== undefined) {
    if (!existsSync(cardFile)) { console.error(`relay: 文件不存在: ${cardFile}`); process.exit(1); }
    cardContent = readFileSync(cardFile, 'utf-8');
  }
  // Resolve content with the same precedence as cmdSend (content-file > positional > stdin)
  const contentFile = argValue(rest, '--content-file');
  let content = '';
  if (cardJsonArg !== undefined || cardFile !== undefined) {
    content = '';
  } else if (contentFile) {
    content = existsSync(contentFile) ? readFileSync(contentFile, 'utf-8') : '';
  } else {
    // NOTE: `--attention` is deliberately NOT excluded here. The relay flag
    // allowlist (below) doesn't forward it, so sandbox `--attention` can't raise
    // the dashboard hand anyway; excluding it would silently send the reason as a
    // bare message instead of the original loud "no content" failure. Plumbing
    // `--attention` through the relay is a separate change, out of this scope.
    const pos = positionals(rest, ['--card', '--text', '--top-level', '--no-quote', '--mention-back', '--no-mention', '--anyway', '--voice', '--slash']);
    content = pos.length > 0 ? pos.join(' ') : await readStdin();
  }
  content = stripTrailingOaiMemoryCitation(content);
  const preparedCardContent = cardJsonArg === undefined && cardFile === undefined && !rest.includes('--voice')
    ? prepareCardMarkdown(extractCardText(content), process.cwd(), 'filesystem')
    : undefined;
  const id = randomBytes(8).toString('hex');
  const originCapability = readManagedOriginCapability(
    resolveDataDir(),
    sid,
    relayDir,
    process.env.BOTMUX_ORIGIN_CHANNEL_ID,
  )?.capability;
  // Structured request: the daemon-side watcher rebuilds the argv from these
  // validated fields (it NEVER executes raw argv — see buildRelayHostArgs).
  // Content + attachments are written into the shared outbox as plain
  // basenames; the watcher validates they stay inside the outbox, allowlists
  // the flags, and forces the session-id. This is what keeps creds out of the
  // sandbox: the sandbox can't make the host read an arbitrary path.
  const contentBase = `${id}.content`;
  const cfile = join(relayDir, contentBase);
  writeFileSync(cfile, content);
  let preparedContentBase: string | undefined;
  let preparedContentOutfile: string | undefined;
  if (preparedCardContent !== undefined) {
    preparedContentBase = `${id}.card-content`;
    preparedContentOutfile = join(relayDir, preparedContentBase);
    writeFileSync(preparedContentOutfile, preparedCardContent);
  }
  let cardBase: string | undefined;
  let cardOutfile: string | undefined;
  if (cardJsonArg !== undefined || cardFile !== undefined) {
    cardBase = `${id}.card.json`;
    cardOutfile = join(relayDir, cardBase);
    writeFileSync(cardOutfile, cardContent);
  }

  // Copy attachments into the outbox; carry only basenames.
  const copyOutboxAttachment = (p: string, out: string[]): void => {
    if (!p || !existsSync(p)) return;
    const base = `${id}-${randomBytes(4).toString('hex')}-${basename(p)}`;
    try { writeFileSync(join(relayDir, base), readFileSync(p)); out.push(base); } catch { /* skip unreadable */ }
  };
  const attachments: string[] = [];
  for (const p of argValues(rest, '--image', '--images', '--file', '--files')) {
    copyOutboxAttachment(p, attachments);
  }
  const videos: string[] = [];
  for (const p of argValues(rest, '--video', '--videos')) {
    copyOutboxAttachment(p, videos);
  }
  const videoCovers: string[] = [];
  for (const p of argValues(rest, '--video-cover', '--video-covers')) {
    copyOutboxAttachment(p, videoCovers);
  }

  // Forward only presentation flags (must match the watcher's allowlist); path,
  // routing (--chat-id/--into/--top-level) and --session-id flags are dropped —
  // content/attachments come from the outbox and session-id is forced host-side.
  const FLAGS_NOVAL = new Set(['--mention-back', '--no-mention', '--no-quote', '--voice', '--slash']);
  const FLAGS_VAL = new Set(['--mention', '--quote', '--response-kind']);
  const flags: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const tok = rest[i];
    if (FLAGS_NOVAL.has(tok)) flags.push(tok);
    else if (FLAGS_VAL.has(tok) && i + 1 < rest.length) flags.push(tok, rest[++i]);
    else {
      const equals = tok.indexOf('=');
      const flag = equals > 0 ? tok.slice(0, equals) : tok;
      if (FLAGS_VAL.has(flag)) flags.push(flag, tok.slice(equals + 1));
    }
    // else dropped
  }
  // `--layout` is parsed before entering the sandbox relay. Forward only the
  // canonical five-name form; malformed requests already warned and fell back
  // in the child, while the host validator still rejects forged outbox input.
  if (replyLayout) flags.push('--layout', replyLayout);
  // 原子写：req.json 是 host watcher 的触发文件，rename 让它「完整出现」，
  // watcher 永远不会读到半截 JSON（tmp 后缀不匹配 .req.json 过滤）。
  atomicWriteFileSync(join(relayDir, `${id}.req.json`), JSON.stringify({
    contentFile: contentBase,
    preparedContentFile: preparedContentBase,
    cardFile: cardBase,
    attachments,
    videos,
    videoCovers,
    flags,
    ...(originCapability ? { originCapability } : {}),
  }));

  const resPath = join(relayDir, `${id}.res.json`);
  const deadlineMs = Date.now() + 120_000;
  while (Date.now() < deadlineMs) {
    if (existsSync(resPath)) {
      try {
        const res = JSON.parse(readFileSync(resPath, 'utf-8')) as { code?: number; stdout?: string; stderr?: string };
        try { unlinkSync(resPath); } catch { /* */ }
        try { unlinkSync(cfile); } catch { /* */ }
        if (preparedContentOutfile) { try { unlinkSync(preparedContentOutfile); } catch { /* */ } }
        if (cardOutfile) { try { unlinkSync(cardOutfile); } catch { /* */ } }
        if (res.stdout) process.stdout.write(res.stdout);
        if (res.stderr) process.stderr.write(res.stderr);
        process.exit(res.code ?? 0);
      } catch { /* partial write — retry next tick */ }
    }
    await new Promise(r => setTimeout(r, 150));
  }
  console.error('relay: 等待 daemon 投递超时（120s）');
  process.exit(1);
}

/**
 * Relay a sandboxed cross-bot dispatch to the owning worker. The sandbox only
 * contributes a bounded target app/chat plus task text; the watcher forces the
 * live source session id and re-runs this exact build outside bwrap. This avoids
 * reading a file bind that can become stale after the session store's atomic
 * rename, without exposing the store or any bot credentials to the sandbox.
 */
async function relayDispatch(rest: string[], relayDir: string): Promise<void> {
  const requestedSid = argValue(rest, '--session-id');
  const sid = process.env.BOTMUX_SESSION_ID;
  if (!sid) {
    console.error(JSON.stringify({ success: false, errorCode: 'SOURCE_SESSION_NOT_FOUND' }));
    process.exit(1);
  }
  if (requestedSid && requestedSid !== sid) {
    console.error(JSON.stringify({
      success: false,
      sourceSessionId: sid,
      transportState: 'failed',
      acceptanceState: 'not_requested',
      errorCode: 'SOURCE_SESSION_NOT_AUTHORIZED',
      detail: 'sandbox dispatch can only use the worker-bound source session',
    }));
    process.exit(2);
  }
  const allowedFlags = new Set([
    '--title', '--bot-app', '--chat-id', '--steer',
    '--brief', '--brief-file', '--session-id',
  ]);
  const unsupportedFlags = [...new Set(rest
    .filter(token => token.startsWith('--'))
    .map(token => token.split('=', 1)[0]!)
    .filter(flag => !allowedFlags.has(flag)))];
  if (unsupportedFlags.length > 0) {
    console.error(JSON.stringify({
      success: false,
      sourceSessionId: sid,
      transportState: 'failed',
      acceptanceState: 'not_requested',
      errorCode: 'ROUTING_NOT_SUPPORTED',
      detail: `sandbox dispatch does not support: ${unsupportedFlags.join(', ')}; use --bot-app with a stable Lark App ID`,
    }));
    process.exit(2);
  }
  const briefFile = argValue(rest, '--brief-file');
  let brief = argValue(rest, '--brief') ?? '';
  if (briefFile) {
    if (!existsSync(briefFile)) {
      console.error(JSON.stringify({ success: false, sourceSessionId: sid, errorCode: 'BRIEF_FILE_NOT_FOUND', detail: `brief file not found: ${briefFile}` }));
      process.exit(1);
    }
    brief = readFileSync(briefFile, 'utf8');
  }
  const flags: string[] = [];
  for (const flag of ['--title', '--bot-app', '--chat-id'] as const) {
    for (const value of argValues(rest, flag)) flags.push(flag, value);
  }
  if (rest.includes('--steer')) flags.push('--steer');
  const id = randomBytes(8).toString('hex');
  const contentBase = `${id}.content`;
  const contentPath = join(relayDir, contentBase);
  writeFileSync(contentPath, brief);
  const originCapability = readManagedOriginCapability(
    resolveDataDir(), sid, relayDir, process.env.BOTMUX_ORIGIN_CHANNEL_ID,
  )?.capability;
  atomicWriteFileSync(join(relayDir, `${id}.req.json`), JSON.stringify({
    command: 'dispatch',
    contentFile: contentBase,
    flags,
    ...(originCapability ? { originCapability } : {}),
  }));
  const resPath = join(relayDir, `${id}.res.json`);
  const deadlineMs = Date.now() + 120_000;
  while (Date.now() < deadlineMs) {
    if (existsSync(resPath)) {
      try {
        const res = JSON.parse(readFileSync(resPath, 'utf8')) as { code?: number; stdout?: string; stderr?: string };
        try { unlinkSync(resPath); } catch { /* */ }
        try { unlinkSync(contentPath); } catch { /* */ }
        if (res.stdout) process.stdout.write(res.stdout);
        if (res.stderr) process.stderr.write(res.stderr);
        process.exit(res.code ?? 1);
      } catch { /* atomic response should be complete; retry defensively */ }
    }
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  console.error(JSON.stringify({
    success: false,
    sourceSessionId: sid,
    transportState: 'failed',
    acceptanceState: 'not_requested',
    errorCode: 'TRANSPORT_FAILED',
    detail: 'daemon relay response timed out after 120s',
  }));
  process.exit(1);
}

async function persistDispatchLifecycle(input: {
  dispatchRoot: string;
  sourceSessionId: string;
  status: DispatchLifecycleStatus;
  transportState: DispatchTransportState;
  acceptanceState: DispatchAcceptanceState;
  errorCode?: string | null;
  acceptedBotAppIds?: readonly string[];
  missingBotAppIds?: readonly string[];
}): Promise<DispatchReceiptState> {
  try {
    return await persistDispatchLifecycleRecord({ dataDir: resolveDataDir(), ...input });
  } catch (error) {
    console.error(`dispatch lifecycle persistence failed: ${error instanceof Error ? error.message : String(error)}`);
    return {
      transportState: input.transportState,
      acceptanceState: input.acceptanceState,
      errorCode: input.errorCode ?? null,
    };
  }
}

/** True if the running bot (by daemon-injected larkAppId) is core-only
 *  (apiOnly). Read-only + never throws: used by `botmux send` to refuse early
 *  with a clear message. Reads bots.json best-effort; an apiOnly bot runs
 *  non-isolated (no Feishu secret to protect), so bots.json is readable here. */
function currentBotIsApiOnly(larkAppId: string): boolean {
  // Under read isolation bots.json is denied ON PURPOSE, so loadBotsJson() below
  // can only ever answer "no bots at all". Letting that stand would silently turn
  // this check into a no-op for EVERY sandboxed bot — including the apiOnly ones
  // it exists to catch — and managedOriginHasNoTransport() (which advertises
  // itself as tamper-resistant) delegates its verdict here.
  //
  // The worker already hands this bot its OWN config through the designed private
  // channel: <BOT_HOME>/send-cred.json, written host-side, carrying apiOnly. Take
  // the verdict from there instead of degrading it away. Only valid for our own
  // appId — a sandboxed bot cannot see (and must not answer for) its siblings.
  // Absent key = not apiOnly: JSON.stringify drops `apiOnly: undefined`, which is
  // exactly what the worker writes for a normal transport-enabled bot.
  if (underReadIsolation()) {
    // bots.json is denied in here and loadBotsJson() is FATAL on that — never
    // reach it from the root dispatch gate. This bot's own apiOnly comes from the
    // designed private channel instead: <BOT_HOME>/send-cred.json, written
    // host-side by the worker, carrying apiOnly (worker.ts). Absent key = not
    // apiOnly (JSON.stringify drops `apiOnly: undefined`, which is exactly what
    // the worker writes for a normal transport-enabled bot).
    if (process.env.BOTMUX_LARK_APP_ID !== larkAppId) return false; // can't see siblings
    // Host-owned verdict first: a no-transport bot's own send-cred.json is denied
    // by fs-policy (`!larkTransport` branch denies <BOT_HOME>/send-cred.json), so
    // for exactly the bots this gate exists to catch the file read below cannot
    // succeed. The worker therefore also states it in the env.
    if (process.env.BOTMUX_API_ONLY === '1') return true;
    try {
      const credPath = sendCredFilePath(process.env.SESSION_DATA_DIR as string, larkAppId);
      return JSON.parse(readFileSync(credPath, 'utf-8'))?.apiOnly === true;
    } catch {
      // No readable cred file: we cannot tell. Say "not apiOnly" rather than
      // crash — the transport boundary still fail-closes downstream
      // (getBotClient throws for apiOnly, and an apiOnly bot has no secret to
      // talk to Feishu with in the first place).
      return false;
    }
  }
  try {
    return loadBotsJson().some((b: any) => b?.larkAppId === larkAppId && b?.apiOnly === true);
  } catch {
    return false;
  }
}

/** Central CLI session-transport capability check. A turn has NO Feishu
 *  transport when either the running bot is core-only (apiOnly) OR the turn runs
 *  in an HTTP virtual session (BOTMUX_CHAT_ID starts with http_async_ or
 *  http_wait_). This is the single source of truth every Feishu-touching CLI
 *  command consults — send/dispatch (writes) AND history/quoted/bots (reads) —
 *  so a normal bot in a virtual session can't reach Feishu by reloading
 *  bots.json for a real client (the daemon side is already gated by
 *  larkTransportEnabled; this closes the non-sandbox local-CLI path). Kept
 *  read-only and total (never throws). */
function currentTurnHasNoTransport(): boolean {
  const chatId = process.env.BOTMUX_CHAT_ID ?? '';
  if (chatId.startsWith('http_async_') || chatId.startsWith('http_wait_')) return true;
  const appId = process.env.BOTMUX_LARK_APP_ID;
  return !!appId && currentBotIsApiOnly(appId);
}

/** Tamper-resistant managed-origin transport check for the root-dispatch gate.
 *  Resolves the origin session via the pid-marker ANCESTRY (process.ppid walk),
 *  NOT the mutable BOTMUX_SESSION_ID env, then loads that session's record and
 *  judges transport from its chatId + its bot's apiOnly config. So `env -u
 *  BOTMUX_SESSION_ID -u BOTMUX_CHAT_ID -u BOTMUX_LARK_APP_ID` cannot shed the
 *  managed no-transport identity. Returns false (not gated) when no managed
 *  origin resolves — a bare host-operator shell keeps full access. Total; on any
 *  resolution error falls back to the env-based check (never throws). */
function managedOriginHasNoTransport(): boolean {
  try {
    const ctx = resolveSessionContext(resolveDataDir(), process.env.BOTMUX_SESSION_ID);
    if (!ctx?.sessionId) {
      // No managed origin at all (bare operator). Still honor an explicit env
      // signal if present (daemon-spawned turn whose marker was pruned), but a
      // truly bare shell has neither → not gated.
      return !!process.env.BOTMUX_SESSION_ID && currentTurnHasNoTransport();
    }
    const s = loadSessions().get(ctx.sessionId);
    if (!s) {
      // Marker resolved a session id but no record on disk (riff sandbox etc.) —
      // fall back to the env view for that same managed turn.
      return currentTurnHasNoTransport();
    }
    const chatId = s.chatId ?? '';
    if (chatId.startsWith('http_async_') || chatId.startsWith('http_wait_')) return true;
    return !!s.larkAppId && currentBotIsApiOnly(s.larkAppId);
  } catch {
    return !!process.env.BOTMUX_SESSION_ID && currentTurnHasNoTransport();
  }
}

/** Refuse a Feishu-touching CLI command for a no-transport turn with a clear,
 *  actionable message (not a deep client error), then exit. `op` names the
 *  command for the message. Returns true if it refused+exited is imminent — but
 *  it calls process.exit(2), so callers just `if (assertTurnTransportOrExit(...)) return;`
 *  for type-flow clarity; execution never continues past the exit. */
function assertTurnTransportOrExit(op: string): void {
  if (!currentTurnHasNoTransport()) return;
  const chatId = process.env.BOTMUX_CHAT_ID ?? '';
  const why = chatId.startsWith('http_async_') || chatId.startsWith('http_wait_')
    ? 'this turn runs in an HTTP control-API session (no Feishu chat)'
    : 'this is a core-only (apiOnly) bot with no Feishu connection';
  console.error(
    `botmux ${op} is unavailable: ${why}.\n` +
    `Feishu read/write is not possible here — the turn communicates only over the HTTP\n` +
    `control API (input via trigger, output via trigger-result). Produce your normal answer.`,
  );
  process.exit(2);
}

/** Target-aware variant: gate on the RESOLVED session (its chatId + owning bot's
 *  apiOnly), not just the calling process env. The env gate can't see a
 *  `--session-id <other>` argument that targets a different (virtual) session, so
 *  commands that accept --session-id must call this AFTER resolving the target to
 *  close the cross-session bypass. Read-only + total (never throws besides exit). */
function assertSessionTransportOrExit(session: { chatId?: string; larkAppId?: string }, op: string): void {
  const chatId = session.chatId ?? '';
  const virtual = chatId.startsWith('http_async_') || chatId.startsWith('http_wait_');
  const apiOnly = !!session.larkAppId && currentBotIsApiOnly(session.larkAppId);
  if (!virtual && !apiOnly) return;
  console.error(
    `botmux ${op} is unavailable for the target session: ${virtual ? 'it is an HTTP control-API session (no Feishu chat)' : 'its bot is core-only (apiOnly)'}.\n` +
    `Feishu read/write is not possible for that session.`,
  );
  process.exit(2);
}

/** Under read isolation the CLI is denied bots.json, so `loadBotConfigs()` reads
 *  nothing. The worker instead wrote THIS bot's own secret to a per-bot cred file
 *  (its own is readable; siblings' are denied). Register just this bot from that
 *  file so send/history find the Lark client WITHOUT reading bots.json and WITHOUT
 *  the secret ever crossing env/argv (no cross-bot `ps aux` leak). No file /
 *  non-isolated session → no-op, falls through to bots.json unchanged. */
async function registerSelfFromCredFile(): Promise<void> {
  const appId = process.env.BOTMUX_LARK_APP_ID;
  const sd = process.env.SESSION_DATA_DIR;
  if (!appId || !sd) return;
  const { sendCredFilePath } = await import('./adapters/cli/read-isolation.js');
  let cred: { larkAppSecret?: string; brand?: string; apiOnly?: boolean; feedback?: import('./services/feedback-policy.js').FeedbackPolicyInput };
  try {
    // send-cred lives in the bot's BOT_HOME (<BOTMUX_HOME>/bots/<appId>/send-cred.json);
    // sendCredFilePath takes SESSION_DATA_DIR and derives BOTMUX_HOME (its parent).
    cred = JSON.parse(readFileSync(sendCredFilePath(sd, appId), 'utf-8'));
  } catch {
    return; // no cred file → not isolated (or first layer supplies creds elsewhere)
  }
  // apiOnly bots legitimately have an empty secret — don't bail on that, but DO
  // carry the apiOnly flag through so the reconstructed config keeps the
  // transport boundary (getBotClient throws for apiOnly). A non-apiOnly bot with
  // no secret is still a no-op (nothing to register).
  if (!cred.larkAppSecret && cred.apiOnly !== true) return;
  const { registerBot } = await import('./bot-registry.js');
  registerBot({
    larkAppId: appId,
    larkAppSecret: cred.larkAppSecret ?? '',
    apiOnly: cred.apiOnly === true || undefined,
    cliId: 'claude-code',
    brand: cred.brand as 'feishu' | 'lark' | undefined,
    feedback: cred.feedback,
    replyStyle: resolveReplyStyleConfig(appId),
    usageDisplay:
      process.env.BOTMUX_USAGE_DISPLAY === 'streaming' ||
      process.env.BOTMUX_USAGE_DISPLAY === 'footer' ||
      process.env.BOTMUX_USAGE_DISPLAY === 'off'
        ? (process.env.BOTMUX_USAGE_DISPLAY as import('./bot-registry.js').UsageDisplayMode)
        : undefined,
  } as import('./bot-registry.js').BotConfig);
}

/**
 * Detect if `botmux send` is running inside a riff (or other remote backend)
 * sandbox where there is NO local daemon, no sessions.json, and no bots.json —
 * only BOTMUX_* env vars injected by the daemon into the sandbox environment.
 *
 * In this mode the normal cmdSend flow breaks (loadSessions() finds nothing,
 * registerSelfFromCredFile() has no cred file). Instead we construct a synthetic
 * session + bot config from the env vars so cmdSend can deliver directly via
 * the Lark API — exactly like the normal flow does, just without local state.
 *
 * Returns null when not in riff mode (env vars missing or local session data
 * exists), so the normal flow takes over.
 */
/** J（二审）：riff env 模式选定的 bot。cmdSend/history 等后续路径里的
 *  `loadBotConfigs()` 重载会把沙箱残留的 stale bots.json（可能是同 appId 的旧
 *  secret）覆盖到注册表上——每次本地重载后必须把 env bot 重新注册回去压轴。 */
let envPinnedRiffBot: import('./bot-registry.js').BotConfig | null = null;

/** 从 bot 配置解析定价（bots.json pricing 块 → 内置表）。未配置时返回 undefined。 */
function resolvePricingForCli(larkAppId: string): ResolvedModelPricing | undefined {
  return resolvePricingConfig(getBot(larkAppId)?.config?.pricing);
}

function riffModeSession(opts: { evenWithLocalSessions?: boolean } = {}): { session: SessionData; botConfig: import('./bot-registry.js').BotConfig } | null {
  const appId = process.env.BOTMUX_LARK_APP_ID;
  const appSecret = process.env.BOTMUX_LARK_APP_SECRET;
  if (!appId || !appSecret) return null;

  const sessionId = process.env.BOTMUX_SESSION_ID;
  const chatId = process.env.BOTMUX_CHAT_ID;
  if (!sessionId || !chatId) return null;

  // If local session data exists, we're normally NOT in riff mode — a real
  // daemon session takes precedence over env-only mode. Exception: when the
  // caller targets exactly the env-injected session id (evenWithLocalSessions),
  // the env identity is authoritative — warm riff sandboxes can carry stale
  // hand-crafted session files that must not shadow the daemon-injected creds.
  // (On daemon hosts BOTMUX_LARK_APP_SECRET is never in process env — PTY
  // sessions get credentials via worker cred files — so this path cannot
  // hijack a genuine local session.)
  if (!opts.evenWithLocalSessions) {
    try {
      if (loadSessions().size > 0) return null;
    } catch { /* no data dir → riff mode */ }
  }

  const brand = process.env.BOTMUX_LARK_BRAND as 'feishu' | 'lark' | undefined;
  // Only trust a real message id as the thread anchor — chat-scope sessions
  // anchor on the chat id (oc_…), which must NOT be used as a reply target.
  const rootEnv = process.env.BOTMUX_ROOT_MESSAGE_ID;
  const rootMessageId = rootEnv?.startsWith('om_') ? rootEnv : '';
  const scopeEnv = process.env.BOTMUX_SESSION_SCOPE;
  const scope: 'thread' | 'chat' =
    scopeEnv === 'chat' || scopeEnv === 'thread' ? scopeEnv : (rootMessageId ? 'thread' : 'chat');
  const ownerOpenId = process.env.BOTMUX_OWNER_OPEN_ID;
  const deferredTaskId = process.env.BOTMUX_DEFERRED_SCHEDULE_TASK_ID;
  const deferredTurnId = process.env.BOTMUX_DEFERRED_SCHEDULE_TURN_ID;
  const deferredRoutingAnchor = process.env.BOTMUX_DEFERRED_SCHEDULE_ROUTING_ANCHOR;
  const deferredCreatedAt = process.env.BOTMUX_DEFERRED_SCHEDULE_CREATED_AT;
  let feedback: import('./services/feedback-policy.js').FeedbackPolicy | undefined;
  try {
    const rawFeedback = process.env.BOTMUX_FEEDBACK_POLICY;
    if (rawFeedback) feedback = normalizeFeedbackPolicy(JSON.parse(rawFeedback));
  } catch {
    // A malformed/missing remote env snapshot must not accidentally enable UI.
    feedback = undefined;
  }

  const botConfig = {
    larkAppId: appId,
    larkAppSecret: appSecret,
    apiOnly: process.env.BOTMUX_API_ONLY === '1' || undefined,
    brand,
    cliId: 'riff',
    allowedUsers: [],
    feedback,
    replyStyle: resolveReplyStyleConfig(appId),
    usageDisplay:
      process.env.BOTMUX_USAGE_DISPLAY === 'streaming' ||
      process.env.BOTMUX_USAGE_DISPLAY === 'footer' ||
      process.env.BOTMUX_USAGE_DISPLAY === 'off'
        ? (process.env.BOTMUX_USAGE_DISPLAY as import('./bot-registry.js').UsageDisplayMode)
        : undefined,
  } as unknown as import('./bot-registry.js').BotConfig;

  const session: SessionData = {
    sessionId,
    chatId,
    rootMessageId,
    title: 'riff',
    status: 'active',
    createdAt: new Date().toISOString(),
    larkAppId: appId,
    scope,
    ownerOpenId,
    ...(deferredTaskId && deferredTurnId && deferredRoutingAnchor && deferredCreatedAt
      ? {
          deferredScheduleRun: {
            taskId: deferredTaskId,
            turnId: deferredTurnId,
            routingAnchor: deferredRoutingAnchor,
            ...(process.env.BOTMUX_DEFERRED_SCHEDULE_TOPIC_TITLE
              ? { topicTitle: process.env.BOTMUX_DEFERRED_SCHEDULE_TOPIC_TITLE }
              : {}),
            createdAt: deferredCreatedAt,
          },
        }
      : {}),
    // 刻意不设 quoteTargetSenderOpenId：env 是任务创建时冻结的，follow-up 轮
    // 换了触发人后 --mention-back 会错误 @ 最初 owner。riff routing 明确禁用
    // mention-back（@ 硬门会拒绝并提示 agent 改用 --mention <本轮 sender>）。
  };

  return { session, botConfig };
}

async function cmdSend(rest: string[]): Promise<void> {
  const ancestorCtx = findAncestorSessionContext();
  // Workflow subagents cannot own chat-facing effects: those belong to a
  // hostExecutor so retries/resumes can reconcile them. Keep this gate ahead
  // of both the sandbox relay and VC-origin store reads; neither path may turn
  // a forbidden workflow send into an observable side effect.
  if (process.env.BOTMUX_WORKFLOW === '1') {
    const runId = process.env.BOTMUX_WORKFLOW_RUN_ID ?? '?';
    const nodeId = process.env.BOTMUX_WORKFLOW_NODE_ID ?? '?';
    console.error(
      `botmux send refused inside workflow subagent (run=${runId} node=${nodeId}).\n` +
      `Workflow subagents must return structured output via the WORKFLOW_OUTPUT marker;\n` +
      `chat-facing side effects belong in a hostExecutor activity, not a subagent.`,
    );
    process.exit(2);
  }
  // No-transport turn (apiOnly bot OR HTTP virtual session): refuse via the
  // central session-capability gate — same hard door every Feishu-touching CLI
  // command consults.
  assertTurnTransportOrExit('send');
  const replyLayoutRequest = parseReplyLayoutRequest(rest);
  if (replyLayoutRequest.warning) console.error(replyLayoutRequest.warning);
  let replyLayout = replyLayoutRequest.layout;
  // Resolve isolation marker-first. A visible host marker always wins over a
  // leftover capability. Linux bwrap keeps its host-execution outbox; macOS
  // read isolation instead challenges the owning daemon and trusts only the
  // matching host-written read-only proof sidecar. The capability file itself
  // may survive worker SIGKILL and is never direct-send authority.
  let sendDataDir = resolveDataDir();
  let liveMarkerCtx = findLiveAncestorSessionContext(sendDataDir);
  const relayDir = process.env.BOTMUX_SEND_RELAY;
  const sessionIdArg = argValue(rest, '--session-id');
  const inheritedSessionId = process.env.BOTMUX_SESSION_ID?.trim();
  const inheritedOriginChannelId = process.env.BOTMUX_ORIGIN_CHANNEL_ID?.trim();
  const isolationSessionCandidates = [...new Set([
    inheritedSessionId,
    ancestorCtx?.sessionId,
    sessionIdArg,
  ].filter((value): value is string => !!value))];
  const isolationMarkerPresent = isolationSessionCandidates
    .some(sessionId => !!inheritedOriginChannelId
      && hasManagedOriginIsolationMarker(
        sendDataDir,
        sessionId,
        inheritedOriginChannelId,
      ));
  let osUserHomeDir: string;
  try { osUserHomeDir = userInfo().homedir; }
  catch {
    console.error('botmux send refused: OS account home unavailable for isolation classification');
    process.exit(2);
  }
  if (!osUserHomeDir) {
    console.error('botmux send refused: OS account home unavailable for isolation classification');
    process.exit(2);
  }
  const kernelReadIsolationDetected = managedOriginLegacyIsolationProbeAccess(osUserHomeDir)
    === 'sandbox_denied'
    || managedOriginIsolationSentinelAccess(osUserHomeDir) === 'sandbox_denied';
  const isolatedSendRequired = !relayDir
    && (kernelReadIsolationDetected
      || process.env.BOTMUX_READ_ISOLATED === '1'
      || (!liveMarkerCtx?.sessionId && isolationMarkerPresent));
  let isolatedBoundSessionId: string | undefined;
  if (isolatedSendRequired) {
    if (!inheritedOriginChannelId || !/^[a-f0-9]{64}$/.test(inheritedOriginChannelId)) {
      console.error('botmux send refused: read-isolated pane authority channel is missing or invalid');
      process.exit(2);
    }
    const locators = isolationSessionCandidates.flatMap(sessionId => {
      const locator = readManagedOriginRootLocator(osUserHomeDir, sessionId);
      return locator ? [locator] : [];
    });
    if (locators.length !== 1) {
      console.error('botmux send refused: read-isolated owning data-root locator is missing or ambiguous');
      process.exit(2);
    }
    const locator = locators[0]!;
    if ((sessionIdArg && sessionIdArg !== locator.sessionId)
      || (inheritedSessionId && inheritedSessionId !== locator.sessionId)) {
      console.error('botmux send refused: read-isolated session does not match the owning data-root locator');
      process.exit(2);
    }
    isolatedBoundSessionId = locator.sessionId;
    sendDataDir = locator.dataDir;
    // A locator is data, not authority. Require the kernel to deny the probe
    // under the locator-selected *actual* Botmux root. Legacy Seatbelt profiles
    // already denied this dashboard-secret basename class at their real root;
    // a child-forged fake root remains readable and is therefore rejected.
    if (managedOriginDataRootProbeAccess(sendDataDir, locator.sessionId)
      !== 'sandbox_denied') {
      console.error('botmux send refused: locator-selected data root is not protected by the active sandbox');
      process.exit(2);
    }
    // All later session/credential/marker reads in this short-lived command
    // must use the host-bound root, never the child's mutable inherited value.
    process.env.SESSION_DATA_DIR = sendDataDir;
    liveMarkerCtx = findLiveAncestorSessionContext(sendDataDir);
  }
  const isolatedCapabilityCtx = !isolatedSendRequired && liveMarkerCtx?.sessionId
    ? null
    : readWorkflowSessionRelayContext({
        env: process.env,
        dataDir: sendDataDir,
        // Keep one marker snapshot for the whole decision. In particular, do
        // not let resolveSessionContext's protected-capability fallback get
        // mislabeled as a live process marker.
        findMarker: () => isolatedSendRequired ? null : liveMarkerCtx,
      });
  if (isolatedSendRequired
    && (isolatedCapabilityCtx?.sessionId !== isolatedBoundSessionId
      || isolatedCapabilityCtx?.originChannelId !== inheritedOriginChannelId)) {
    console.error('botmux send refused: read-isolated capability is not bound to this session');
    process.exit(2);
  }
  let isolatedAttestationContext: ManagedOriginAttestationContext | undefined;
  let isolatedManagedOriginCtx: ManagedOriginAttestation | undefined;
  const trustedHostRelay = process.env.BOTMUX_HOST_RELAY_AUTHORIZED === '1';
  const trustedRelayAttemptRaw = Number(process.env.BOTMUX_DISPATCH_ATTEMPT);
  const trustedRelayCandidate = trustedHostRelay && process.env.BOTMUX_SESSION_ID
    ? {
        sessionId: process.env.BOTMUX_SESSION_ID,
        turnId: process.env.BOTMUX_TURN_ID,
        dispatchAttempt: Number.isSafeInteger(trustedRelayAttemptRaw) && trustedRelayAttemptRaw > 0
          ? trustedRelayAttemptRaw
          : undefined,
      }
    : undefined;
  // Inside bwrap the PID namespace makes host marker traversal impossible.
  // The relay watcher therefore binds a short-lived host-issued capability to
  // the worker's live turn and performs the authoritative policy check.
  if (relayDir && isolatedCapabilityCtx) {
    if (replyLayout) {
      const ownAppId = process.env.BOTMUX_LARK_APP_ID?.trim();
      const style = resolveReplyStyle(ownAppId ? resolveReplyStyleConfig(ownAppId) : undefined);
      if (!style.layout) {
        console.error('botmux send: 当前 Bot 已关闭 layout，本次按普通回复卡发送');
        replyLayout = undefined;
      }
    }
    await relaySend(rest, relayDir, replyLayout);
    return;
  }
  if (relayDir && !liveMarkerCtx?.sessionId) {
    // The child may delete or replace its writable outbox capability, while
    // the immutable default snapshot remains visible. That snapshot is only a
    // routing hint and can survive worker death; never fall through to direct
    // Lark send when the live relay token is absent.
    console.error('botmux send refused: managed host relay capability is stale or missing');
    process.exit(2);
  }
  if (!relayDir && isolatedSendRequired && !isolatedCapabilityCtx) {
    // Isolation classification must not depend on successfully parsing the
    // rotating token. A missing/corrupt/revoked capability is an authorization
    // failure, never permission to downgrade into the ordinary direct path.
    console.error('botmux send refused: read-isolated managed origin capability is stale, corrupt, or missing');
    process.exit(2);
  }
  if (!relayDir && isolatedCapabilityCtx) {
    isolatedAttestationContext = {
      sessionId: isolatedCapabilityCtx.sessionId,
      channelId: isolatedCapabilityCtx.originChannelId!,
      capability: isolatedCapabilityCtx.capability,
      dataDir: sendDataDir,
      ...(isolatedCapabilityCtx.larkAppId
        ? { larkAppId: isolatedCapabilityCtx.larkAppId }
        : {}),
      ...(isolatedCapabilityCtx.ipcPortFallback !== undefined
        ? { ipcPortFallback: isolatedCapabilityCtx.ipcPortFallback }
        : {}),
    };
    try {
      isolatedManagedOriginCtx = await attestManagedOrigin({
        context: isolatedAttestationContext,
        resolveIpcPort: (larkAppId) => {
          try { return larkAppId ? findDaemon(larkAppId)?.ipcPort : undefined; }
          catch { return undefined; }
        },
      });
    } catch (err) {
      console.error(`botmux send refused: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(2);
    }
  }
  // Silent is an execution policy, not a prompt suggestion. During a durable
  // meeting turn, refuse botmux-mediated sends before either the direct-Lark or
  // sandbox-relay path can run. Explicit human IM turns have no dispatchAttempt
  // and therefore retain the normal reply path in the same receiver session.
  const sessionsForOrigin = loadSessions();
  const trustedRelaySession = trustedRelayCandidate
    ? sessionsForOrigin.get(trustedRelayCandidate.sessionId)
    : undefined;
  // The env marker is not authority by itself. A genuine host relay CLI is a
  // direct child of the session's durably recorded worker pid; sandboxed or
  // semi-trusted descendants cannot satisfy that parent binding.
  const trustedRelayCtx = trustedRelayCandidate && isTrustedVcMeetingHostRelayParent(
    trustedHostRelay,
    trustedRelaySession?.pid,
    process.ppid,
  )
    ? trustedRelayCandidate
    : undefined;
  // Keep origin authority independent from the requested destination.  In
  // particular, `--session-id <other>` may select where an ordinary Lark turn
  // is sent, but it must never replace the session whose durable delivery sink
  // governs this process.  Session identity may fall back to the inherited env
  // for detached commands; the turn tuple may not. `ancestorCtx` deliberately
  // adds spawn-time BOTMUX_TURN_ID/ATTEMPT compatibility fallbacks, which can be
  // stale after a later turn, so only a parent-bound host relay or a fresh
  // marker/protected-capability tuple can authorize a durable dispatch.
  const originSessionId = trustedRelayCtx?.sessionId
    ?? liveMarkerCtx?.sessionId
    ?? isolatedManagedOriginCtx?.sessionId
    ?? ancestorCtx?.sessionId
    ?? process.env.BOTMUX_SESSION_ID;
  const authoritativeOriginTurnCtx = trustedRelayCtx
    ? (trustedRelayCtx.turnId ? trustedRelayCtx : undefined)
    : (liveMarkerCtx?.turnId
        ? liveMarkerCtx
        : isolatedManagedOriginCtx?.turnId
          ? isolatedManagedOriginCtx
          : undefined);
  const originTurnId = authoritativeOriginTurnCtx?.turnId;
  const originDispatchAttempt = authoritativeOriginTurnCtx?.dispatchAttempt;
  const originSession = originSessionId
    ? sessionsForOrigin.get(originSessionId)
    : undefined;
  const hostRelayRequiresCodexAppLedger = !!trustedRelayCtx
    && process.env.BOTMUX_HOST_RELAY_REQUIRES_CODEX_APP_LEDGER === '1';
  // The live worker authorizes a Codex App relay only while an exact durable
  // dispatch remains unsettled. Recheck that prerequisite before any other
  // managed-output policy or provider setup: terminal settlement can win the
  // race between watcher authorization and this host child loading the store,
  // and must never downgrade the send into an ordinary Lark message.
  if ((hostRelayRequiresCodexAppLedger || isolatedManagedOriginCtx?.requiresCodexAppLedger)
    && (originSession?.codexAppDispatchLedger?.length ?? 0) === 0) {
    console.error(
      `botmux send refused: authorized Codex App origin ${originSessionId}/${originTurnId} is no longer unsettled`,
    );
    process.exit(2);
  }
  let explicitVcMeetingImOrigin: ReturnType<typeof resolveVcMeetingImTurnOrigin>;
  let vcMeetingListenerOutputOwner: { listenerAppId: string; meetingId: string } | undefined;
  let vcMeetingManagedSendOrigin: VcMeetingManagedSendOrigin | undefined;
  let vcMeetingDeliveryReplyOrigin: {
    receiverSessionId: string;
    stableTurnId: string;
    dispatchAttempt: number;
  } | undefined;
  if (originSessionId) {
    const imOrigin = resolveVcMeetingImTurnOrigin(originSession, originTurnId);
    const managedOrigin: VcMeetingManagedSendOrigin = {
      receiverSessionId: originSessionId,
      receiverSession: !!originSession?.vcMeetingReceiver,
      turnId: originTurnId,
      dispatchAttempt: originDispatchAttempt,
      currentImTurnOrigin: imOrigin,
    };
    const decision = evaluateVcMeetingManagedSend(resolveDataDir(), managedOrigin);
    if (!decision.ok) {
      console.error(
        `botmux send refused by VC managed-output policy (${decision.errorCode}): ${decision.error}`,
      );
      process.exit(2);
    }
    if (decision.kind === 'listener_thread') {
      vcMeetingListenerOutputOwner = decision.meetingOwner;
      vcMeetingManagedSendOrigin = managedOrigin;
      if (managedOrigin.turnId && managedOrigin.dispatchAttempt !== undefined) {
        vcMeetingDeliveryReplyOrigin = {
          receiverSessionId: originSessionId,
          stableTurnId: managedOrigin.turnId,
          dispatchAttempt: managedOrigin.dispatchAttempt,
        };
      }
    }
    if (decision.kind === 'listener_thread'
      && originDispatchAttempt === undefined) {
      explicitVcMeetingImOrigin = imOrigin;
    }
  }
  const revalidateVcMeetingManagedSend = (): void => {
    if (!vcMeetingManagedSendOrigin) return;
    const decision = evaluateVcMeetingManagedSend(resolveDataDir(), vcMeetingManagedSendOrigin);
    if (!decision.ok) {
      throw new Error(
        `VC managed-output authority expired (${decision.errorCode}): ${decision.error}`,
      );
    }
    if (decision.kind !== 'listener_thread') {
      throw new Error('VC managed-output authority no longer targets the listener thread');
    }
    vcMeetingListenerOutputOwner = decision.meetingOwner;
  };
  const prepareVcMeetingListenerReply = (
    proposedOutput: {
      targetChatId: string;
      quoteTargetId?: string;
      msgType: string;
      content: string;
    },
  ) => explicitVcMeetingImOrigin
    ? prepareVcMeetingImReply(resolveDataDir(), explicitVcMeetingImOrigin, proposedOutput)
    : vcMeetingDeliveryReplyOrigin
      ? prepareVcMeetingDeliveryReply(
          resolveDataDir(),
          vcMeetingDeliveryReplyOrigin,
          proposedOutput,
        )
      : undefined;
  process.env.SESSION_DATA_DIR ??= resolveDataDir();
  // Read isolation: the sandboxed CLI is denied bots.json → register this bot
  // from its own worker-written cred file instead (see registerSelfFromCredFile).
  await registerSelfFromCredFile();
  for (const flag of ['--video', '--videos', '--video-cover', '--video-covers']) {
    if (flagPresentButValueMissing(rest, flag, true)) {
      console.error(`botmux send: ${flag} 需要路径参数`);
      process.exit(2);
    }
  }
  if (flagPresentButValueMissing(rest, '--card-file', true)) {
    console.error('botmux send: --card-file 需要路径参数');
    process.exit(2);
  }
  if (flagPresentButValueMissing(rest, '--card-json', true)) {
    console.error('botmux send: --card-json 需要 JSON 字符串参数');
    process.exit(2);
  }
  const cardJsonArg = argValue(rest, '--card-json');
  const cardFile = argValue(rest, '--card-file');
  const customCardRequested = cardJsonArg !== undefined || cardFile !== undefined;
  const responseKindOccurrences = rest.filter(token => token === '--response-kind' || token.startsWith('--response-kind=')).length;
  if (responseKindOccurrences > 1) {
    console.error('botmux send: --response-kind 只能指定一次');
    process.exit(2);
  }
  if (flagPresentButValueMissing(rest, '--response-kind')) {
    console.error('botmux send: --response-kind 仅支持 progress|final|auxiliary');
    process.exit(2);
  }
  const responseKind = argValue(rest, '--response-kind');
  if (responseKind !== undefined && responseKind !== 'progress' && responseKind !== 'final' && responseKind !== 'auxiliary') {
    console.error('botmux send: --response-kind 仅支持 progress|final|auxiliary');
    process.exit(2);
  }
  // Backward-compatible default: an unclassified proactive send is non-final.
  // Only an explicit `final` may opt into feedback controls and indexing;
  // `progress` and `auxiliary` (interim / supplementary output) both deliver
  // normally without a feedback region, matching the requirement's three roles.
  const effectiveResponseKind = responseKind ?? 'progress';
  const managedCustomCardError = managedVcCustomCardError(
    !!vcMeetingManagedSendOrigin,
    customCardRequested,
  );
  if (managedCustomCardError) {
    console.error(`botmux send refused for a managed VC turn: ${managedCustomCardError}`);
    process.exit(2);
  }
  if (cardJsonArg !== undefined && cardFile !== undefined) {
    console.error('botmux send: --card-json 与 --card-file 不能同时使用');
    process.exit(2);
  }
  const images = argValues(rest, '--image', '--images');
  const files = argValues(rest, '--file', '--files');
  const videos = argValues(rest, '--video', '--videos');
  const videoCovers = argValues(rest, '--video-cover', '--video-covers');
  if (customCardRequested && (images.length > 0 || files.length > 0 || videos.length > 0 || videoCovers.length > 0)) {
    console.error('botmux send: --card-file/--card-json 暂不与 --images/--files/--videos 混用；请把素材先上传为飞书资源并写入卡片 JSON');
    process.exit(2);
  }
  const videoValidation = validateVideoAttachments(videos, videoCovers);
  if (!videoValidation.ok) {
    console.error(`botmux send: ${videoValidation.error}`);
    process.exit(2);
  }
  const videoAttachments = videoValidation.videos;
  // stdin can't be both the message body (which `botmux send` reads from it) and
  // a `--file`/`--image`/`--video` attachment — the second read sees EOF and the upload
  // fails *after* the message is already sent, leaving the caller to resend.
  // Reject up front so exit≠0 reliably means "nothing was sent".
  const stdinAlias = findStdinAliasAttachment([...images, ...files, ...videos, ...videoCovers]);
  if (stdinAlias) {
    console.error(
      `不能把 stdin（${stdinAlias}）当作 --file/--image/--video 附件：botmux send 已从 stdin 读取消息正文，\n` +
      `同一个 stdin 没法既当正文又当附件（第二次读到的是 EOF）。\n` +
      `要发送管道内容，先落到临时文件：  数据来源 > /tmp/x && botmux send --files /tmp/x …`,
    );
    process.exit(1);
  }
  const mentionArgs = argValues(rest, '--mention');  // "open_id:Display Name"
  const contentFile = argValue(rest, '--content-file');
  if (customCardRequested && contentFile) {
    console.error('botmux send: --card-file/--card-json 不能与 --content-file 混用');
    process.exit(2);
  }
  // 回复一律走交互卡片。`--card` / `--text` 是隐藏的旧脚本兼容 no-op：纯文本
  // post 路径已删除，只有卡片能承载「🔊 语音总结」按钮，且守护进程兜底也一直只发卡片。
  // Publish-mode flags: post a fresh top-level message in a chat instead of
  // replying into the bound thread. Lets a session "publish" to a different
  // chat (e.g. a public release-notes group) while keeping its own thread
  // for streaming-card / progress UI.
  const sendTopLevel = rest.includes('--top-level');
  const overrideChatId = argValue(rest, '--chat-id');
  // --into <话题根id>: reply this send into a specific topic (a sub-bot's topic,
  // another thread, etc.) instead of the session's own location. Wins over the
  // auto/scope default; `dispatch` opens topics, `send --into` posts into them.
  const sendInto = argValue(rest, '--into');
  // --voice: synthesize the content into a Feishu voice bubble instead of a
  // text/card message. The content should be spoken-style prose (the 🔊 button
  // injects a condense-first instruction before the model calls this).
  const asVoice = rest.includes('--voice');
  // Quote chain (chat scope): --quote <message_id> overrides the auto target,
  // --no-quote forces a plain (un-quoted) send.
  const explicitQuote = argValue(rest, '--quote');
  const managedQuoteError = managedVcQuoteError({
    managed: !!vcMeetingManagedSendOrigin,
    durableDelivery: !!vcMeetingDeliveryReplyOrigin,
    explicitImMessageId: explicitVcMeetingImOrigin?.larkMessageId,
    explicitQuote,
  });
  if (managedQuoteError) {
    console.error(`botmux send refused for a managed VC turn: ${managedQuoteError}`);
    process.exit(2);
  }
  const noQuote = rest.includes('--no-quote');
  // @ hard-gate: every reply must explicitly choose one of these.
  const mentionBack = rest.includes('--mention-back');
  const noMention = rest.includes('--no-mention');
  // --attention[=kind]: raise a hand — post this message AND light the dashboard
  // needs-you column for this session. Parsed specially (not argValue) so a bare
  // `--attention "我卡住了"` doesn't eat the message as the flag value.
  const attention = parseAttentionFlag(rest);
  const managedControlError = managedVcSendControlError({
    managed: !!vcMeetingManagedSendOrigin,
    sendTopLevel,
    overrideChatId,
    sendInto,
    attentionRequested: attention.requested,
    explicitMentionCount: mentionArgs.length,
    mentionBack,
    noMention,
  });
  if (managedControlError) {
    console.error(`botmux send refused for a managed VC turn: ${managedControlError}`);
    process.exit(2);
  }
  if (customCardRequested && asVoice) {
    console.error('botmux send: --card-file/--card-json 不能与 --voice 混用');
    process.exit(2);
  }
  // --slash: send a NATIVE slash command (e.g. /clear /model /close) as a
  // single-line plain-`text` message instead of the usual interactive card.
  // The card path appends a `[🔊 语音总结]` footer, turning the body multi-line
  // so the receiving daemon's parseSlashCommandInvocation drops it to an
  // ordinary prompt (never reaching the passthrough / daemon-command router).
  // A --slash send skips the card so a peer bot (or self) can consume it. It is
  // deliberately exclusive with every richer payload — a slash command is one
  // line of text, nothing else.
  const isSlashSend = rest.includes('--slash');
  if (isSlashSend) {
    if (customCardRequested || asVoice) {
      console.error('botmux send: --slash 不能与 --card-file/--card-json/--voice 混用（斜杠命令只发单行纯文本）');
      process.exit(2);
    }
    if (images.length > 0 || files.length > 0 || videos.length > 0 || videoCovers.length > 0) {
      console.error('botmux send: --slash 不能带附件（--images/--files/--videos）；斜杠命令只发单行纯文本');
      process.exit(2);
    }
    if (attention.requested) {
      console.error('botmux send: --slash 不能与 --attention 混用');
      process.exit(2);
    }
  }
  if (replyLayout && (customCardRequested || asVoice || isSlashSend)) {
    const mode = customCardRequested ? '自定义卡片' : asVoice ? '语音气泡' : '原生斜杠命令';
    console.error(`botmux send: --layout 不作用于${mode}，本次已忽略`);
    replyLayout = undefined;
  }

  const sid = sessionIdArg ?? ancestorCtx?.sessionId ?? process.env.BOTMUX_SESSION_ID ?? null;
  if (!sid) {
    console.error('无法推断 session-id。请在 Lark 话题内的 CLI 会话中运行，或传 --session-id <id>。');
    process.exit(1);
  }

  const sessions = loadSessions();
  const currentTurnId = originTurnId;
  let s = sessions.get(sid);

  // Riff (remote backend) sandbox: no local daemon/sessions.json/bots.json.
  // Fall back to env-var-only mode so `botmux send` works without a daemon.
  // The daemon injects BOTMUX_LARK_APP_ID/SECRET/CHAT_ID/SESSION_ID into
  // the sandbox env; riffModeSession() builds a synthetic session + bot from
  // them and registers the bot so the Lark client works.
  //
  // The env-injected identity is AUTHORITATIVE for its own session id: a warm
  // riff sandbox may carry stale local session data (hand-crafted by an agent
  // in an earlier task, or baked into the image) that would otherwise shadow
  // the daemon-injected identity and deliver through the wrong bot.
  {
    const riff = riffModeSession({ evenWithLocalSessions: sid === process.env.BOTMUX_SESSION_ID });
    // Strictly scoped to the env-injected session id: an explicit
    // `--session-id <other>` in a sandbox must fail with "session not found",
    // not silently deliver into the env session.
    if (riff && riff.session.sessionId === sid) {
      s = riff.session;
      const { registerBot } = await import('./bot-registry.js');
      try { registerBot(riff.botConfig); } catch { /* already registered */ }
      envPinnedRiffBot = riff.botConfig;
    }
  }

  if (!s) { console.error(`未找到 session ${sid}`); process.exit(1); }
  if (!s.larkAppId) { console.error(`session ${sid} 缺少 larkAppId`); process.exit(1); }
  const replyStyle = resolveReplyStyle(resolveReplyStyleConfig(s.larkAppId));
  if (replyLayout && !replyStyle.layout) {
    console.error('botmux send: 当前 Bot 已关闭 layout，本次按普通回复卡发送');
    replyLayout = undefined;
  }
  // Target-aware gate on the RESOLVED source session: `send --session-id <virtual>`
  // (or an apiOnly bot's session) must be refused even if the ambient env looks
  // transport-capable, and regardless of any `--chat-id` override — a no-transport
  // turn may not originate ANY Feishu write. Closes the env-only gap for send.
  assertSessionTransportOrExit({ chatId: s.chatId, larkAppId: s.larkAppId }, 'send');
  let deferredMaterializedByThisCommand = false;
  let deferredTopicRootMessageIdForOutput: string | undefined;

  // Prefer the exact per-turn reply anchor; the latest single slot is only a
  // compatibility fallback for sessions persisted before replyTargets.
  const turnReplyTarget = pickTurnReplyTarget(s, currentTurnId);

  const exactOriginDispatch = (() => {
    const unsettledOriginDispatches = originSession?.codexAppDispatchLedger ?? [];
    // The live worker authorized this host re-exec against an exact unsettled
    // Codex App entry. If terminal settlement/revocation won the race before
    // this child reloaded the store, never degrade into an ordinary Lark send
    // against mutable session state.
    if (unsettledOriginDispatches.length === 0) {
      return undefined;
    }
    // A detached/backgrounded command can still inherit the correct session id
    // but only a spawn-time (and now stale) turn env.  If this session has any
    // unsettled durable output, absence of a fresh marker/capability tuple must
    // fail closed rather than silently falling through to ordinary Lark IM.
    if (!originTurnId) {
      console.error(
        `botmux send refused: origin session ${originSessionId} has unsettled durable output but no fresh authoritative dispatch identity`,
      );
      process.exit(2);
    }
    const turnMatches = unsettledOriginDispatches
      .filter(entry => entry.turnId === originTurnId);
    const exactMatches = originDispatchAttempt === undefined
      ? turnMatches
      : turnMatches.filter(entry => entry.dispatchAttempt === originDispatchAttempt);
    // Once a durable turn exists, a supplied attempt must match it exactly.
    // Falling back to another attempt would let a stale/replayed process select
    // the wrong sink.  With no attempt, multiple entries are equally unsafe.
    if (exactMatches.length !== 1) {
      const detail = originDispatchAttempt === undefined
        ? `${turnMatches.length} ledger entries share the turn id`
        : `${exactMatches.length} ledger entries match attempt ${originDispatchAttempt}`;
      console.error(
        `botmux send refused: origin dispatch ${originSessionId}/${originTurnId} is ambiguous (${detail})`,
      );
      process.exit(2);
    }
    return exactMatches[0];
  })();

  // Frozen reply routing applies only when the selected destination is the
  // trusted origin session.  A cross-session publish must not accidentally
  // reuse a coincidentally-equal turn id from the destination ledger.
  const frozenTurnDispatch = originSessionId === sid
    ? exactOriginDispatch
    : undefined;
  const frozenTurnReplyTarget = frozenTurnDispatch?.replyTarget;
  if (exactOriginDispatch?.deliverySink === 'http_wait'
    || exactOriginDispatch?.deliverySink === 'http_async'
    || exactOriginDispatch?.deliverySink === 'suppressed') {
    console.error(
      `botmux send refused: origin turn ${originTurnId} is bound to the `
      + `${exactOriginDispatch.deliverySink} host sink`,
    );
    process.exit(2);
  }

  // A proof is a point-in-time liveness check, not a five-second send lease.
  // Re-challenge immediately before observable provider effects so lengthy
  // local parsing/card preparation cannot carry an old capability across a
  // worker restart, turn rotation, or Codex ledger settlement.
  const revalidateIsolatedOriginBeforeEffect = async (): Promise<ManagedOriginAttestation | undefined> => {
    if (!isolatedAttestationContext || !isolatedManagedOriginCtx) return undefined;
    const fresh = await attestManagedOrigin({
      context: isolatedAttestationContext,
      resolveIpcPort: (larkAppId) => {
        try { return larkAppId ? findDaemon(larkAppId)?.ipcPort : undefined; }
        catch { return undefined; }
      },
    });
    if (fresh.sessionId !== isolatedManagedOriginCtx.sessionId
      || fresh.turnId !== isolatedManagedOriginCtx.turnId
      || fresh.dispatchAttempt !== isolatedManagedOriginCtx.dispatchAttempt
      || fresh.requiresCodexAppLedger !== isolatedManagedOriginCtx.requiresCodexAppLedger) {
      throw new Error('managed origin changed before provider effect');
    }
    const currentOriginSession = loadSessions().get(fresh.sessionId);
    const ledgerDecision = validateCodexAppManagedSendOrigin(
      currentOriginSession?.codexAppDispatchLedger,
      fresh,
      fresh.requiresCodexAppLedger,
    );
    if (!ledgerDecision.ok
      || ledgerDecision.requiresLedger !== fresh.requiresCodexAppLedger) {
      throw new Error(
        `managed origin ledger changed before provider effect${ledgerDecision.ok ? '' : `: ${ledgerDecision.error}`}`,
      );
    }
    return fresh;
  };
  const fenceIsolatedOriginBeforeEffect = async (): Promise<void> => {
    await revalidateIsolatedOriginBeforeEffect();
  };
  const isolatedHookOrigin = isolatedAttestationContext?.ipcPortFallback
    && isolatedManagedOriginCtx
    ? {
        ipcPort: isolatedAttestationContext.ipcPortFallback,
        sessionId: isolatedManagedOriginCtx.sessionId,
        capability: isolatedAttestationContext.capability,
        turnId: isolatedManagedOriginCtx.turnId,
        ...(isolatedManagedOriginCtx.dispatchAttempt !== undefined
          ? { dispatchAttempt: isolatedManagedOriginCtx.dispatchAttempt }
          : {}),
      }
    : undefined;
  // Outbound hooks are a distinct post-provider effect. Preserve normal hook
  // behavior, but bind it to a fresh challenge of this command's original
  // protected claim. The Lark client treats fence failure as hook-only loss so
  // an already-delivered primary is never reported failed and duplicated.
  const outboundMessageOptions = (suppressHook = false) =>
    suppressHook
      ? { suppressHook: true as const }
      : isolatedAttestationContext
        ? isolatedHookOrigin
          ? {
              beforeHook: fenceIsolatedOriginBeforeEffect,
              hookOrigin: isolatedHookOrigin,
            }
          : { suppressHook: true as const }
        : undefined;

  // A document-comment turn has exactly one supported observable effect: a
  // plain text reply to its frozen origin target.  Validate the complete shape
  // before reading stdin/content/card files and before any TTS, upload, or Lark
  // provider call.  In particular, an explicit destination session is not an
  // escape hatch from the origin sink.
  const docTarget = originTurnId
    ? originSession?.docCommentTargets?.[originTurnId]
    : undefined;
  // Codex App turns are governed exclusively by their exact dispatch ledger:
  // a settled/missing ledger entry must never fall back to mutable session
  // state. Other CLI adapters predate that ledger, so their frozen per-turn
  // docCommentTargets entry remains the authoritative origin sink.
  const isOriginDocCommentTurn = exactOriginDispatch?.deliverySink === 'doc_comment'
    || (!exactOriginDispatch && originSession?.cliId !== 'codex-app' && !!docTarget);
  if (isOriginDocCommentTurn) {
    if (replyLayout) {
      console.error('botmux send: --layout 不作用于文档评论回复，本次已忽略');
      replyLayout = undefined;
    }
    if (!docTarget || !originSession?.larkAppId) {
      console.error('botmux send refused: this turn is bound to a document comment, but its exact origin target is no longer available');
      process.exit(2);
    }
    if (sid !== originSessionId
      || sendTopLevel
      || !!overrideChatId
      || !!sendInto
      || asVoice
      || images.length > 0
      || files.length > 0
      || videoAttachments.length > 0
      || videoCovers.length > 0
      || customCardRequested
      || attention.requested
      || explicitQuote !== undefined
      || noQuote) {
      console.error('botmux send refused: a document-comment turn supports only its exact plain-text comment reply');
      process.exit(2);
    }
  }

  // Read content from: --content-file > positional arg > stdin
  let content = '';
  let customCard: Record<string, unknown> | undefined;
  if (customCardRequested) {
    const unexpectedText = positionals(rest, ['--card', '--text', '--top-level', '--no-quote', '--mention-back', '--no-mention', '--anyway', '--voice', '--attention']);
    if (unexpectedText.length > 0) {
      console.error('botmux send: --card-file/--card-json 发送自定义卡片时不接受正文参数；卡片内容请写入 JSON');
      process.exit(2);
    }
    let rawCard = cardJsonArg ?? '';
    if (cardFile !== undefined) {
      if (!existsSync(cardFile)) { console.error(`文件不存在: ${cardFile}`); process.exit(1); }
      rawCard = readFileSync(cardFile, 'utf-8');
    }
    const normalizedCard = normalizeInteractiveCardInput(rawCard);
    if (!normalizedCard.ok) { console.error(`botmux send: ${normalizedCard.error}`); process.exit(2); }
    customCard = normalizedCard.card;
  } else if (contentFile) {
    if (!existsSync(contentFile)) { console.error(`文件不存在: ${contentFile}`); process.exit(1); }
    content = readFileSync(contentFile, 'utf-8');
  } else {
    const pos = positionals(rest, ['--card', '--text', '--top-level', '--no-quote', '--mention-back', '--no-mention', '--anyway', '--voice', '--attention', '--slash']);
    if (pos.length > 0) {
      content = pos.join(' ');
    } else {
      content = await readStdin();
    }
  }
  // Keep memory attribution in the model's rollout, but never render the
  // complete internal suffix into Lark or count it in send markers.
  content = stripTrailingOaiMemoryCitation(content);
  if (!contentFile && !customCardRequested) rejectLikelyWindowsStdinMojibake(content);

  const managedPayloadError = managedVcSendPayloadError({
    managed: !!vcMeetingManagedSendOrigin,
    asVoice,
    hasBodyText: !!content.trim(),
    imageCount: images.length,
    fileCount: files.length,
    videoCount: videoAttachments.length,
    containsNativeAtTag: containsLarkAtTag(content),
  });
  if (managedPayloadError) {
    console.error(`botmux send refused for a managed VC turn: ${managedPayloadError}`);
    process.exit(2);
  }

  if (!customCard && !content.trim() && images.length === 0 && files.length === 0 && videoAttachments.length === 0) {
    console.error('没有内容可发送。用法:\n  echo "消息" | botmux send\n  botmux send "消息"\n  botmux send --content-file /tmp/msg.md --images /tmp/chart.png\n  botmux send --videos /tmp/replay.mp4 --video-covers /tmp/cover.png --no-mention "视频预览"');
    process.exit(1);
  }

  // --attention guard: only valid replying into the current session with a text
  // reason (clear-on-reply binds to this anchor; dashboard needs a reason).
  const attentionErr = attentionUsageError({
    requested: attention.requested,
    sendTopLevel,
    overrideChatId,
    sendInto,
    asVoice,
    hasText: !!content.trim(),
  });
  if (attentionErr) { console.error(`botmux send: ${attentionErr}`); process.exit(2); }

  const recordVcMeetingPrimaryOutput = (
    messageId: string,
    outputChatId: string,
  ): void => {
    if (!vcMeetingListenerOutputOwner || sendInto) return;
    try {
      const recorded = recordVcMeetingListenerMessage(resolveDataDir(), {
        ...vcMeetingListenerOutputOwner,
        targetChatId: outputChatId,
        messageId,
      });
      if (!recorded.ok) {
        console.error(`⚠️ VC 监听消息索引拒绝记录 ${messageId}（${recorded.reason}）`);
      }
    } catch (error) {
      // The primary message already exists at Lark. Index failure must never
      // turn a successful send into exit!=0 (which would invite a duplicate).
      console.error(
        `⚠️ 消息已发送，但 VC 监听消息索引写入失败：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };

  // ── Voice mode ──────────────────────────────────────────────────────────
  // Synthesize the (already-condensed, colloquial) content into a Feishu voice
  // bubble and return. Deliberately bypasses the text/card path's mentions,
  // footer, and @-hard-gate — a voice bubble addresses nobody. Lands in the
  // same thread/chat the session would normally reply to.
  if (asVoice) {
    if (!content.trim()) { console.error('--voice 需要要朗读的文字'); process.exit(1); }
    const { registerBot, loadBotConfigs } = await import('./bot-registry.js');
    try { for (const cfg of loadBotConfigs()) registerBot(cfg); } catch { /* */ }
  if (envPinnedRiffBot) { try { registerBot(envPinnedRiffBot); } catch { /* */ } }
    const { uploadFile, sendMessage, replyMessage } = await import('./im/lark/client.js');
    const { synthesizeVoiceOpus } = await import('./services/voice/index.js');
    const { rmSync } = await import('node:fs');
    const appId = s.larkAppId!;
    const targetChatId = overrideChatId ?? s.chatId;
    let dir: string | undefined;
    try {
      await revalidateIsolatedOriginBeforeEffect();
      const out = await synthesizeVoiceOpus(appId, content, {
        beforeProviderEffect: fenceIsolatedOriginBeforeEffect,
      });
      dir = out.dir;
      await revalidateIsolatedOriginBeforeEffect();
      const fileKey = await uploadFile(appId, out.path, { duration: out.durationMs });
      const sentAtMs = Date.now();
      const proposedOutput = {
        targetChatId,
        msgType: 'audio',
        content: JSON.stringify({ file_key: fileKey }),
      };
      const prepared = prepareVcMeetingListenerReply(proposedOutput);
      if (prepared?.kind === 'conflict') {
        throw new Error(`VC listener assistant reply refused (${prepared.reason}): ${prepared.detail}`);
      }
      const canonicalOutput = prepared?.canonicalOutput ?? proposedOutput;
      if (prepared?.outputMismatch) {
        console.error(
          `⚠️ VC listener voice reply output_mismatch action=${prepared.ref.actionId}; `
          + 'reusing first canonical output',
        );
      }
      let messageId: string;
      if (prepared?.kind === 'succeeded' && prepared.messageId) {
        messageId = prepared.messageId;
      } else {
        revalidateVcMeetingManagedSend();
        const managedProviderOptions = outboundMessageOptions(!!prepared);
        const deferred = !sendInto && (!overrideChatId || overrideChatId === s.chatId)
          ? await dispatchDeferredTopicSend({
              dataDir: resolveDataDir(),
              session: s as SessionData & { larkAppId: string },
              currentTurnId,
              explicitTopLevel: sendTopLevel,
              reuseBoundRootWhenTopLevel: deferredMaterializedByThisCommand,
              content: canonicalOutput.content,
              msgType: canonicalOutput.msgType,
              uuid: prepared?.providerKey,
              sendRoot: async (body, type, uuid) => {
                await revalidateIsolatedOriginBeforeEffect();
                return sendMessage(appId, targetChatId, body, type, uuid, undefined, managedProviderOptions);
              },
              sendTitleSeed: async (title, uuid) => {
                await revalidateIsolatedOriginBeforeEffect();
                return sendMessage(appId, targetChatId, title, 'text', uuid);
              },
              replyRoot: async (root, body, type, uuid) => {
                await revalidateIsolatedOriginBeforeEffect();
                return replyMessage(appId, root, body, type, true, uuid, undefined, managedProviderOptions);
              },
            })
          : { handled: false };
        if (deferred.handled && deferred.messageId) {
          deferredMaterializedByThisCommand ||= deferred.materializedNow === true;
          deferredTopicRootMessageIdForOutput = deferred.rootMessageId;
          messageId = deferred.messageId;
        } else {
          const canonicalTarget = !sendInto && !sendTopLevel && !overrideChatId && frozenTurnReplyTarget
            ? frozenTurnReplyTarget
            : resolveSendTarget({
                into: sendInto,
                topLevel: sendTopLevel,
                chatScope: s.scope === 'chat',
                chatId: canonicalOutput.targetChatId,
                rootMessageId: s.rootMessageId,
                replyTargetRootId: turnReplyTarget?.rootMessageId,
                replyTargetTurnId: turnReplyTarget?.turnId,
                replyTargetQuoteOnly: turnReplyTarget?.quoteOnly,
                currentTurnId,
              });
          await revalidateIsolatedOriginBeforeEffect();
          messageId = canonicalTarget.mode === 'plain'
            ? await sendMessage(
                appId,
                canonicalTarget.chatId,
                canonicalOutput.content,
                canonicalOutput.msgType,
                prepared?.providerKey,
                undefined,
                managedProviderOptions,
              )
            : await replyMessage(
                appId,
                canonicalTarget.rootMessageId,
                canonicalOutput.content,
                canonicalOutput.msgType,
                canonicalTarget.mode === 'thread',
                prepared?.providerKey,
                undefined,
                managedProviderOptions,
              );
        }
        if (prepared?.kind === 'send' || prepared?.kind === 'succeeded') {
          finishVcMeetingImReply(resolveDataDir(), prepared.ref, messageId);
        }
      }
      recordVcMeetingPrimaryOutput(messageId, canonicalOutput.targetChatId);
      // 语音也是一次回复：写 bridge fallback marker，否则本轮会被判为"没发 botmux send"
      // 而触发兜底，多补一张文本卡。与文本/卡片路径同口径：仅同话题回复才记。
      if ((!sendTopLevel || !!deferredTopicRootMessageIdForOutput)
        && (!overrideChatId || overrideChatId === s.chatId)
        && !sendInto) {
        try {
          const markerDir = join(resolveDataDir(), 'turn-sends');
          if (!existsSync(markerDir)) mkdirSync(markerDir, { recursive: true });
          const marker: Record<string, unknown> = {
            sentAtMs,
            messageId,
            ...(originTurnId ? { turnId: originTurnId } : {}),
            ...(originDispatchAttempt !== undefined ? { dispatchAttempt: originDispatchAttempt } : {}),
          };
          const previewText = buildBridgeSendPreviewText(content);
          if (previewText) marker.previewText = previewText;
          appendFileSync(join(markerDir, `${sid}.jsonl`), JSON.stringify(marker) + '\n');
        } catch { /* best-effort：漏记只多一条兜底，不致命 */ }
      }
      console.error(`✓ 已发送语音 ${messageId} ｜ ${Math.round(out.durationMs / 1000)}s`);
      console.log(JSON.stringify({
        success: true,
        messageId,
        sessionId: sid,
        kind: 'voice',
        durationMs: out.durationMs,
        ...(deferredTopicRootMessageIdForOutput
          ? { deferredTopicRootMessageId: deferredTopicRootMessageIdForOutput, turnId: currentTurnId }
          : {}),
      }));
    } catch (e: any) {
      console.error(`语音发送失败：${describeSendFailure(e)}`);
      if (dir) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* */ } }
      process.exit(1);
    }
    if (dir) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* */ } }
    return;
  }

  // ── 文档评论入口分流（/watch-comment / /subscribe-lark-doc）─────────────────
  // The authority and payload-shape checks ran before content/provider work.
  // Use only the trusted origin session here; `--session-id` is a destination
  // selector for ordinary Lark turns and cannot retarget a document turn.
  if (isOriginDocCommentTurn) {
    const exactDocTarget = docTarget!;
    const exactDocSession = originSession!;
    const { registerBot, loadBotConfigs } = await import('./bot-registry.js');
    try { for (const cfg of loadBotConfigs()) registerBot(cfg); } catch { /* */ }
  if (envPinnedRiffBot) { try { registerBot(envPinnedRiffBot); } catch { /* */ } }
    const { replyToDocComment, chunkCommentText, removeCommentReaction } = await import('./im/lark/doc-comment.js');
    const appId = exactDocSession.larkAppId!;
    try {
      // @ 落点：--mention-back → 回 @ 原评论人；--mention <open_id[:name]> → @ 指定人；
      // 否则（--no-mention / 无）不 @。文档评论里靠 person 元素渲染 @，仅首块加。
      //
      // 注意：这条文档评论路径在 allowArbitraryMention 闸之外（闸在下方 group
      // 发送分支里）。这里直接取 mentionArgs[0] 冒号前的原文当 open_id 用，不做
      // 解析/群成员校验。风险较低：文档评论的权限模型是文档权限而非群成员，且
      // 传非 open_id（邮箱等）进去会被飞书侧拒绝渲染 person 元素（fail-closed）。
      // 但「默认关」这个开关在此路径上不生效，若将来放开需一并过 gate。
      let docMentionOpenId: string | undefined;
      if (mentionBack) docMentionOpenId = exactDocTarget.replyToOpenId;
      else if (mentionArgs.length > 0) {
        const first = mentionArgs[0];
        const idx = first.indexOf(':');
        docMentionOpenId = (idx > 0 ? first.slice(0, idx) : first).trim() || undefined;
      }
      // 嵌套回复到用户那条评论 thread（已挂其下，无需 ↪ 前缀）。
      const chunks = chunkCommentText(content);
      for (let i = 0; i < chunks.length; i++) {
        await replyToDocComment(
          appId,
          { fileToken: exactDocTarget.fileToken, fileType: exactDocTarget.fileType },
          exactDocTarget.commentId,
          chunks[i],
          i === 0 ? docMentionOpenId : undefined,
          { beforeProviderEffect: fenceIsolatedOriginBeforeEffect },
        );
      }
      // 清理 "Typing" reaction（bot 已回复完毕）。
      if (exactDocTarget.reactionId && exactDocTarget.replyId) {
        await removeCommentReaction(appId,
          { fileToken: exactDocTarget.fileToken, fileType: exactDocTarget.fileType },
          exactDocTarget.commentId, exactDocTarget.replyId, exactDocTarget.reactionId,
          { beforeProviderEffect: fenceIsolatedOriginBeforeEffect });
      }
      // 写 bridge send marker → 抑制 worker 的 final_output 兜底（否则会再补一条评论）。
      try {
        const markerDir = join(resolveDataDir(), 'turn-sends');
        if (!existsSync(markerDir)) mkdirSync(markerDir, { recursive: true });
        const marker: Record<string, unknown> = {
          sentAtMs: Date.now(),
          messageId: `doc:${exactDocTarget.commentId}`,
          ...(originTurnId ? { turnId: originTurnId } : {}),
          ...(originDispatchAttempt !== undefined ? { dispatchAttempt: originDispatchAttempt } : {}),
          contentLength: content.length,
        };
        const previewText = buildBridgeSendPreviewText(content);
        if (previewText) marker.previewText = previewText;
        appendFileSync(join(markerDir, `${originSessionId}.jsonl`), JSON.stringify(marker) + '\n');
      } catch { /* best-effort：漏记只多一条兜底 */ }
      // Do not write this startup snapshot back after the async provider calls:
      // the daemon may have advanced the dispatch ledger or accepted another
      // turn in the meantime.  Daemon settlement owns exact target retirement.
      console.error(`✓ 已回复文档评论 ${exactDocTarget.commentId.slice(0, 12)}（${chunks.length} 条）`);
      console.log(JSON.stringify({ success: true, commentId: exactDocTarget.commentId, sessionId: originSessionId, kind: 'doc-comment', chunks: chunks.length }));
    } catch (e: any) {
      console.error(`文档评论发送失败：${describeSendFailure(e)}`);
      process.exit(1);
    }
    return;
  }

  // Parse mentions: "identifier:Display Name" or bare "identifier".
  // `identifier` is a literal open_id (ou_…) by default. When the bot config
  // enables `allowArbitraryMention`, it may also be a full email / union_id
  // (on_…) / mobile — those are resolved to this app's open_id after bot
  // registration (see the resolve block below), then gated against the target
  // chat's membership so an agent can only @ people who are actually in the
  // group. With the switch off, non-open_id identifiers are rejected
  // (default-deny: the model can't @ arbitrary people).
  // Splitting on the FIRST ':' is safe: open_id / union_id / email / mobile
  // never contain ':', only the optional trailing Display Name might.
  const mentions: Array<{ open_id: string; name: string }> = [];
  const rawMentions: Array<{ identifier: string; name: string }> = [];
  for (const m of mentionArgs) {
    const idx = m.indexOf(':');
    if (idx > 0) {
      rawMentions.push({ identifier: m.slice(0, idx).trim(), name: m.slice(idx + 1) });
    } else if (m.trim()) {
      rawMentions.push({ identifier: m.trim(), name: '' });
    }
  }
  const replyTargetSenderOpenId = explicitVcMeetingImOrigin?.replyTargetSenderOpenId
    ?? frozenTurnDispatch?.replyTargetSenderOpenId
    ?? turnReplyTarget?.senderOpenId
    // #750 exact-turn contract: the global latest-slot quote sender may ONLY be
    // borrowed as a legacy fallback when there is NO currentTurnId (true
    // legacy/no-turn send). With a turnId, an exact-turn map miss/eviction must
    // resolve to NO sender — never the global slot, which may have advanced to a
    // DIFFERENT turn B and would mis-@ B as A's --mention-back (the cross-turn
    // bug #750 fixed). pickTurnReplyTarget already enforces
    // quoteTargetId===currentTurnId for its own hit.
    ?? (currentTurnId ? undefined : s.quoteTargetSenderOpenId);

  // @ hard-gate (config.send.requireMentionDecision, default on): force the
  // model to make an explicit @ decision before sending. --top-level publish
  // is exempt. The error text adapts to who is being replied to (人 / bot).
  const mentionGate = validateMentionDecision({
    enabled: config.send.requireMentionDecision,
    sendTopLevel,
    hasMentionArgs: mentionArgs.length > 0,
    mentionBack,
    noMention,
    hasQuoteTargetSender: !!replyTargetSenderOpenId,
  });
  if (!mentionGate.ok) { console.error(mentionGate.error); process.exit(2); }

  // Register bots so the downstream Lark client works. registerBot is
  // idempotent, so all send paths reuse these same clients.
  // envPinnedRiffBot is re-registered LAST so a remote env credential is never
  // clobbered by a stale bots.json entry for the same app.
  const { registerBot, loadBotConfigs, findOncallChatForAnyBot, getBot } = await import('./bot-registry.js');
  const { resolveRegularGroupMode } = await import('./services/chat-reply-mode-store.js');
  try { for (const cfg of loadBotConfigs()) registerBot(cfg); } catch { /* */ }
  if (envPinnedRiffBot) { try { registerBot(envPinnedRiffBot); } catch { /* */ } }

  // ── --mention resolution + group-membership gate ──────────────────────────
  // Turn each raw --mention identifier into a { open_id, name } entry.
  //   • Literal open_id (ou_…): kept as-is, always allowed (pre-existing
  //     behavior — an agent that already has an app-scoped open_id is trusted).
  //   • Anything else (email / union_id / mobile): only when the bot config
  //     sets `allowArbitraryMention: true`. Resolve via the existing
  //     resolveAllowedUsersWithMap (email→open_id etc.), then require the
  //     resolved open_id to be a member of the destination chat. This is the
  //     safety gate: default-deny, and even when opened, an agent can only @
  //     people who are actually in the group.
  {
    const mentionChatId = overrideChatId ?? s.chatId;
    const arbitraryAllowed = (() => {
      try { return getBot(s.larkAppId).config.allowArbitraryMention === true; }
      catch { return false; }
    })();
    const classified = classifyMentionIdentifiers(rawMentions, arbitraryAllowed);
    if (!classified.ok) { console.error(classified.error); process.exit(2); }

    // Resolved open_id per non-open_id identifier, filled by the block below.
    // Kept separate from the push loop so we can emit `mentions` in the ORIGINAL
    // command-line order (rawMentions) rather than "open_ids first, resolved
    // second" — that order leaks into atPrefix / atSummary / mentioned[] / the
    // footer, so a mixed `--mention email:A --mention ou_b --mention email:C`
    // must stay A, b, C.
    const resolvedOpenId = new Map<string, string>();

    const nonOpenId = classified.toResolve;
    if (nonOpenId.length > 0) {
      const { resolveAllowedUsersWithMap, listChatMemberOpenIds } = await import('./im/lark/client.js');
      const { map, errored } = await resolveAllowedUsersWithMap(
        s.larkAppId, nonOpenId.map(r => r.identifier),
      );
      const unresolved = nonOpenId.filter(r => !map.get(r.identifier));
      if (unresolved.length > 0) {
        console.error(
          `--mention 无法解析这些标识为群内 open_id：${unresolved.map(r => r.identifier).join(', ')}` +
          (errored ? `（部分为临时失败，可稍后重试）` : `（不存在或本 bot 不可见）`),
        );
        process.exit(2);
      }
      // Membership gate: only @ people actually in the destination chat.
      let memberIds: Set<string>;
      try {
        memberIds = new Set(await listChatMemberOpenIds(s.larkAppId, mentionChatId));
      } catch (err: any) {
        console.error(
          `--mention 群成员校验失败（无法读取群 ${mentionChatId} 成员，可能缺 im:chat 成员读取权限）：` +
          `${err?.message ?? err}`,
        );
        process.exit(2);
      }
      const outsiders = outsidersForMembership(
        nonOpenId.map(r => ({ identifier: r.identifier, openId: map.get(r.identifier)! })),
        memberIds,
      );
      if (outsiders.length > 0) {
        console.error(
          `--mention 拒绝：以下用户不在目标群里，不能 @：` +
          outsiders.map(o => `${o.identifier}→${o.openId}`).join(', '),
        );
        process.exit(2);
      }
      for (const r of nonOpenId) resolvedOpenId.set(r.identifier, map.get(r.identifier)!);
    }

    // Emit in original command-line order: literal open_ids pass through, the
    // rest use their resolved open_id.
    for (const r of rawMentions) {
      const openId = r.identifier.startsWith('ou_') ? r.identifier : resolvedOpenId.get(r.identifier);
      if (openId) mentions.push({ open_id: openId, name: r.name });
    }
  }
  // ───────────────────────────────────────────────────────────────────────────
  let feedbackPolicy: ReturnType<typeof resolveFeedbackPolicyForDelivery>;
  let feedbackWebhookDestinations: import('./services/feedback-outbox.js').FeedbackWebhookDestination[] | undefined;
  try {
    const botConfig = getBot(s.larkAppId).config;
    feedbackWebhookDestinations = botConfig.feedbackWebhooks?.destinations;
    feedbackPolicy = resolveFeedbackPolicyForDelivery({
      dataDir: config.session.dataDir,
      larkAppId: s.larkAppId,
      chatId: s.chatId,
      bot: botConfig,
    });
  } catch {
    feedbackPolicy = undefined;
  }
  const feedbackRequesterSubjectId = replyTargetSenderOpenId ?? s.ownerOpenId;
  if (feedbackPolicy && effectiveResponseKind === 'final' && !feedbackRequesterSubjectId) {
    console.error('botmux send: 无法确认本次提问者身份，不能发送带反馈控件的最终回答');
    process.exit(2);
  }
  if (feedbackPolicy && effectiveResponseKind === 'final' && (customCardRequested || asVoice || sendTopLevel || !!overrideChatId || !!sendInto || !!vcMeetingManagedSendOrigin)) {
    console.error('botmux send: --response-kind final 仅支持当前会话内的普通最终答案卡片');
    process.exit(2);
  }

  // Ambiguity gate for --mention-back. --mention-back means "@ back the one
  // counterpart who triggered this turn"; that is only unambiguous when this
  // turn's window had a single counterpart. Once 2+ distinct people/bots took
  // part (a human + a peer bot, two humans, the triggerer plus someone they
  // @-ed, a type-ahead follow-up from a third party, …), block --mention-back
  // and hand the model the exact candidates so it can --mention <open_id> the
  // right one instead of guessing (or mis-@-ing the lone human). Reads the
  // persisted per-turn participant window — no group-stats round-trip. Explicit
  // VC turns carry their own single-target origin, so they skip this gate.
  if (mentionBack && !explicitVcMeetingImOrigin && !sendTopLevel) {
    const window = collectTurnWindowParticipants(s, currentTurnId);
    const ambiguity = mentionBackAmbiguity({ chatType: s.chatType, participants: window.participants, incomplete: window.incomplete });
    if (ambiguity.ambiguous) {
      console.error(mentionBackAmbiguityError(ambiguity.candidates, ambiguity.incomplete));
      process.exit(2);
    }
  }

  // --mention-back: @ the sender of the message this turn is replying to
  // (open_id from the session — model needn't know it). Bare-name form so it
  // renders as a trailing <at>.
  if (mentionBack && replyTargetSenderOpenId
      && !mentions.some(m => m.open_id === replyTargetSenderOpenId)) {
    mentions.push({ open_id: replyTargetSenderOpenId, name: '' });
  }

  // Validate file paths
  for (const p of [...images, ...files, ...videos, ...videoCovers]) {
    if (!existsSync(p)) { console.error(`文件不存在: ${p}`); process.exit(1); }
  }
  for (const p of [...videos, ...videoCovers]) {
    if (!statSync(p).isFile()) { console.error(`不是普通文件: ${p}`); process.exit(1); }
  }

  const { sendMessage, replyMessage, uploadImage, uploadFile, MessageWithdrawnError, getChatModeStrict, getMessageThreadId } = await import('./im/lark/client.js');
  const appId = s.larkAppId!;
  // Effective target chat for top-level mode (defaults to session's chat)
  const targetChatId = overrideChatId ?? s.chatId;
  // Chat-scope sessions (普通群整群一会话) post to chatId without
  // reply_in_thread, otherwise Lark would force every reply into a fresh
  // topic — defeating the whole point of chat-scope routing.
  const isChatScope = s.scope === 'chat';
  // Compute the actual outbound anchor before the advisory guard. A chat-scope
  // sender can still reply into a per-turn topic, so sender scope alone does
  // not describe which peer sessions are reachable.
  // #597: a frozen per-turn reply target (from a Codex App dispatch) overrides
  // the nominal resolveSendTarget in chat scope so a steered/dispatched turn
  // replies to its own origin, not the session's latest human quote target.
  const sendTarget = !sendInto && !sendTopLevel && !overrideChatId && frozenTurnReplyTarget
    ? frozenTurnReplyTarget
    : resolveSendTarget({ into: sendInto, topLevel: sendTopLevel, chatScope: isChatScope, chatId: targetChatId, rootMessageId: s.rootMessageId, replyTargetRootId: turnReplyTarget?.rootMessageId, replyTargetTurnId: turnReplyTarget?.turnId, replyTargetQuoteOnly: turnReplyTarget?.quoteOnly, currentTurnId });
  const dataDir = resolveDataDir();
  const deferredBinding = !sendInto && (!overrideChatId || overrideChatId === s.chatId)
    ? readDeferredTopicBinding(dataDir, s.sessionId)
    : undefined;
  const deferredRoot = reusableDeferredTopicRoot({
    session: s as SessionData & { larkAppId: string },
    binding: deferredBinding,
    explicitTopLevel: sendTopLevel,
    reuseBoundRootWhenTopLevel: deferredMaterializedByThisCommand,
  });
  const reachabilityTarget = deferredRoot
    ? { mode: 'thread' as const, rootMessageId: deferredRoot }
    : sendTarget;

  // Load the sender-scoped bot identity map once. Besides prose @Name
  // injection below, it lets the sub-bot hint recognize peers that already
  // have an active session in THIS conversation.
  let botEntries: BotMentionEntry[] = [];
  let crossRef: Record<string, string> = {};
  try {
    const botInfoPath = join(dataDir, 'bots-info.json');
    const parsedBotEntries = existsSync(botInfoPath)
      ? JSON.parse(readFileSync(botInfoPath, 'utf-8'))
      : [];
    botEntries = Array.isArray(parsedBotEntries)
      ? parsedBotEntries.filter((entry): entry is BotMentionEntry =>
          !!entry
          && typeof entry === 'object'
          && typeof entry.larkAppId === 'string'
          && (entry.botName === null || typeof entry.botName === 'string'))
      : [];
    const crossRefPath = join(dataDir, `bot-openids-${appId}.json`);
    const parsedCrossRef = existsSync(crossRefPath)
      ? JSON.parse(readFileSync(crossRefPath, 'utf-8'))
      : {};
    crossRef = parsedCrossRef && typeof parsedCrossRef === 'object' && !Array.isArray(parsedCrossRef)
      ? parsedCrossRef
      : {};
  } catch { /* best-effort identity map */ }

  // ── Footgun guard: orchestrator → sub-bot ──
  // A dispatched sub-bot's session lives in its sub-topic; @-ing it from the main
  // chat spawns a fresh, context-less one. The check is computed ONCE and applied
  // at BOTH mention sources: explicit --mention/--mention-back (blocked here) AND
  // the prose @Name auto-injection further down (dropped there) — so a prose
  // `@OtherSubBot` can't slip past after this explicit guard already ran.
  let dispatchReg: Record<string, { orchChatId?: string; bots?: string[] }> = {};
  try {
    const regPath = join(dataDir, 'orchestrate-dispatch.json');
    if (existsSync(regPath)) dispatchReg = JSON.parse(readFileSync(regPath, 'utf-8'));
  } catch { /* no/!corrupt registry → no guard */ }
  const dispatchActiveSeeds = new Set<string>();
  let allSessions: SessionData[] = [];
  if (Object.keys(dispatchReg).length > 0) {
    allSessions = [...loadSessions().values()];
    for (const sess of allSessions) {
      if (sess.status !== 'active') continue;
      if (sess.scope !== 'chat' && sess.rootMessageId) {
        dispatchActiveSeeds.add(sess.rootMessageId);
      }
    }
  }
  // An active chat-scope session can outlive a /reply-mode switch. Verify the
  // target bot's current effective mode before assuming mentions still fold
  // back into that old session.
  const foldableChatAppIds = await foldableChatSessionAppIds({
    sessions: allSessions,
    targetChatId,
    outboundMode: reachabilityTarget.mode,
    resolveMode: (larkAppId, chatId) => {
      getBot(larkAppId); // unknown target bot must fail closed
      return resolveRegularGroupMode(larkAppId, chatId);
    },
    resolveChatMode: chatId => getChatModeStrict(appId, chatId),
  });
  const reachableOpenIds = activeConversationBotOpenIds({
    sessions: allSessions,
    targetChatId,
    outboundRootMessageId: threadRootForReachability(reachabilityTarget),
    foldableChatAppIds,
    botEntries,
    crossRef,
  });
  // Sub-topic seed if `openId` is a dispatched sub-bot in an active topic that is
  // NOT reachable in the current conversation; else null. Both the bot I'm
  // replying to and any peer with an active session at this conversation anchor
  // are reachable, so an unrelated old dispatch topic must not be recommended.
  const offTopicSubBotSeed = (openId: string): string | null =>
    offTopicSubBotTopic({ mentionOpenId: openId, quoteTargetSenderOpenId: replyTargetSenderOpenId, reachableOpenIds, chatId: targetChatId, registry: dispatchReg, activeSeeds: dispatchActiveSeeds });
  // Explicit --mention / --mention-back of an off-topic sub-bot → block + point to
  // the right command (--anyway overrides). Prose @Name injection is filtered
  // (dropped, not blocked) at its own site below.
  // Inform, don't block: if @-ing a bot whose session lives in a sub-topic, this
  // send lands a NEW conversation at the current location. To reply into that
  // topic instead, use `--into <seed>`. The model picks the destination — no hard
  // block (that was too aggressive; @-ing a bot in the group to start a fresh
  // conversation is a legitimate, common intent).
  for (const m of mentions) {
    const seed = offTopicSubBotSeed(m.open_id);
    if (seed) {
      console.error(`ℹ️ ${m.open_id}${m.name ? `（${m.name}）` : ''} 在子话题 ${seed} 里也有会话；本条发到当前位置（新对话）。要发进那个话题改用 --into ${seed}。`);
    }
  }

  // Oncall addressing only meaningful for replies inside the session's own
  // chat — skip when publishing top-level or to a different chat. Treat
  // oncall as chat-level: in multi-daemon setups this session's bot may not
  // be the one that persisted the binding, but users still expect footer
  // addressing to go to the last caller in the shared oncall workspace.
  const oncallEntry = !sendTopLevel && !overrideChatId && !sendInto && s.chatId
    ? findOncallChatForAnyBot(s.chatId) : undefined;

  const hookContext = {
    sessionId: sid,
    chatId: s.chatId,
    rootMessageId: s.rootMessageId,
    title: s.title,
  };
  // Ordinary delivery uses the nominal target. Deferred delivery gets first
  // refusal below; the advisory mirrors its existing binding in
  // `reachabilityTarget` above so both paths agree about the effective root.
  // (sendTarget itself is defined once above, carrying #597's frozen per-turn
  // reply-target override.)
  const dispatchAfterOriginGate = async (
    content: string,
    msgType: string,
    uuid?: string,
    suppressHook?: boolean,
  ): Promise<string> => {
    // This closure also carries attachments, so every Lark call re-checks the
    // exact durable attempt/member instead of inheriting the early cmd gate.
    revalidateVcMeetingManagedSend();
    if (!sendInto && (!overrideChatId || overrideChatId === s.chatId)) {
      const deferred = await dispatchDeferredTopicSend({
        dataDir: resolveDataDir(),
        session: s as SessionData & { larkAppId: string },
        currentTurnId,
        explicitTopLevel: sendTopLevel,
        reuseBoundRootWhenTopLevel: deferredMaterializedByThisCommand,
        content,
        msgType,
        uuid,
        sendRoot: async (body, type, rootUuid) => {
          await revalidateIsolatedOriginBeforeEffect();
          return sendMessage(
            appId,
            targetChatId,
            body,
            type,
            rootUuid,
            hookContext,
            outboundMessageOptions(!!suppressHook),
          );
        },
        // The optional title is the root seed and the actual alert follows as
        // its first reply. Do not emit a user outbound hook for presentation-
        // only seed text; the alert itself still goes through the hook path.
        sendTitleSeed: async (title, rootUuid) => {
          await revalidateIsolatedOriginBeforeEffect();
          return sendMessage(appId, targetChatId, title, 'text', rootUuid);
        },
        replyRoot: async (root, body, type, replyUuid) => {
          await revalidateIsolatedOriginBeforeEffect();
          return replyMessage(
            appId,
            root,
            body,
            type,
            true,
            replyUuid,
            hookContext,
            outboundMessageOptions(!!suppressHook),
          );
        },
      });
      if (deferred.handled && deferred.messageId) {
        deferredMaterializedByThisCommand ||= deferred.materializedNow === true;
        deferredTopicRootMessageIdForOutput = deferred.rootMessageId;
        return deferred.messageId;
      }
    }
    await revalidateIsolatedOriginBeforeEffect();
    return sendTarget.mode === 'plain'
      ? await sendMessage(
          appId,
          sendTarget.chatId,
          content,
          msgType,
          uuid,
          hookContext,
          outboundMessageOptions(!!suppressHook),
        )
      : await replyMessage(
          appId,
          sendTarget.rootMessageId,
          content,
          msgType,
          sendTarget.mode === 'thread',
          uuid,
          hookContext,
          outboundMessageOptions(!!suppressHook),
        );
  };
  const dispatch = async (
    content: string,
    msgType: string,
    uuid?: string,
    suppressHook?: boolean,
  ): Promise<string> => {
    await revalidateIsolatedOriginBeforeEffect();
    return dispatchAfterOriginGate(content, msgType, uuid, suppressHook);
  };
  const recordBridgeSendMarker = (sentAtMs: number, messageId: string, sentContent: string): void => {
    try {
      const markerDir = join(resolveDataDir(), 'turn-sends');
      if (!existsSync(markerDir)) mkdirSync(markerDir, { recursive: true });
      const marker: Record<string, unknown> = {
        sentAtMs,
        messageId,
        ...(originTurnId ? { turnId: originTurnId } : {}),
        ...(originDispatchAttempt !== undefined ? { dispatchAttempt: originDispatchAttempt } : {}),
      };
      Object.assign(marker, buildBridgeSendMarkerContent(sentContent));
      const line = JSON.stringify(marker) + '\n';
      appendFileSync(join(markerDir, `${sid}.jsonl`), line);
    } catch { /* best-effort: marker miss only causes a redundant fallback message */ }
  };

  const shouldRecordBridgeMarker = !sendTopLevel && !overrideChatId && !sendInto;

  // Quote chain (普通群): the primary message replies to the turn's target so
  // Lark renders a 引用 chain. --quote overrides, --no-quote opts out. Thread
  // scope and --top-level never quote. Withdrawn target → fall back to plain.
  const quoteTargetId = sendInto || sendTarget.mode === 'thread' || sendTarget.mode === 'quote' ? undefined : resolveQuoteTarget({
    isChatScope, sendTopLevel, noQuote, explicitQuote,
    // A durable meeting delivery has no Lark-authored trigger message. Never
    // inherit the receiver session's latest human quote target: that state can
    // belong to another queued IM turn and is not part of the delivery action.
    sessionQuoteTargetId: vcMeetingDeliveryReplyOrigin
      ? undefined
      : explicitVcMeetingImOrigin?.larkMessageId
        ?? frozenTurnDispatch?.quoteTargetId
        ?? s.quoteTargetId,
  });
  // 「顶层 @ 之后那条消息才被开成话题」的发送侧半边。飞书的 reply 接口让回复继承
  // 被引用消息**此刻**的话题归属（`reply_in_thread:false` 只是不新开话题，逃不出
  // 已有话题），所以引用一条事后被开成话题的顶层消息，会把回复带进用户根本没在
  // 其中 @ 过 bot 的话题里 —— dispatcher 侧的 fold 只管住了卡片，正文由这里决定。
  //
  // 只在「该轮确证从顶层进来（inThread === false）且本次真要 quote」时才探测一次
  // 飞书；话题内轮次、`--top-level`、`--no-quote`、`--quote`、thread-scope 全部在
  // 上面或 `shouldDropAfterTheFactTopicQuote` 里短路，普通热路径不多付这次调用。
  // 探测失败一律保持 quote（既有默认行为），绝不因为不确定就改变所有正常回复的落点。
  const quotedTurnInThread = quoteTargetId
    ? (s.turnReplyContexts?.[currentTurnId ?? '']?.inThread
      ?? s.turnReplyContexts?.[quoteTargetId]?.inThread)
    : undefined;
  let effectiveQuoteTargetId = quoteTargetId;
  if (quoteTargetId && !explicitQuote && quotedTurnInThread === false) {
    const probedThreadId = await getMessageThreadId(appId, quoteTargetId).catch(() => undefined);
    if (shouldDropAfterTheFactTopicQuote({
      quoteTargetId,
      quotedTurnInThread,
      currentThreadId: probedThreadId,
      explicitQuote,
    })) {
      effectiveQuoteTargetId = undefined;
    }
  }
  let primaryQuotedId: string | null = null;
  let vcMeetingListenerReplyReplay = false;
  const dispatchPrimary = async (
    content: string,
    msgType: string,
    originAlreadyRevalidated = false,
  ): Promise<string> => {
    // `dispatchPrimaryMessage` may call replyMessage directly for a quote, so
    // fence immediately before preparing/performing that primary effect too.
    revalidateVcMeetingManagedSend();
    const proposedOutput = {
      targetChatId,
      ...(effectiveQuoteTargetId ? { quoteTargetId: effectiveQuoteTargetId } : {}),
      msgType,
      content,
    };
    const prepared = prepareVcMeetingListenerReply(proposedOutput);
    if (prepared?.kind === 'conflict') {
      throw new Error(`VC listener assistant reply refused (${prepared.reason}): ${prepared.detail}`);
    }
    const canonicalOutput = prepared?.canonicalOutput ?? proposedOutput;
    if (prepared?.outputMismatch) {
      console.error(
        `⚠️ VC listener reply output_mismatch action=${prepared.ref.actionId} `
        + `turn=${explicitVcMeetingImOrigin?.larkMessageId ?? vcMeetingDeliveryReplyOrigin?.stableTurnId}; `
        + 'reusing first canonical output',
      );
    }
    if (prepared?.kind === 'succeeded' && prepared.messageId) {
      vcMeetingListenerReplyReplay = true;
      primaryQuotedId = canonicalOutput.quoteTargetId ?? null;
      recordVcMeetingPrimaryOutput(prepared.messageId, canonicalOutput.targetChatId);
      return prepared.messageId;
    }
    if (prepared?.kind === 'succeeded') {
      // A legacy/incomplete terminal record without the provider message id is
      // still safe to reconcile through the same stable UUID.
      vcMeetingListenerReplyReplay = true;
    } else if (prepared?.kind === 'send') {
      vcMeetingListenerReplyReplay = prepared.replay;
    }
    const result = await dispatchPrimaryMessage(
      { sendMessage, replyMessage },
      {
        appId,
        targetChatId: canonicalOutput.targetChatId,
        quoteTargetId: canonicalOutput.quoteTargetId,
        content: canonicalOutput.content,
        msgType: canonicalOutput.msgType,
        ...(prepared ? { uuid: prepared.providerKey } : {}),
        // Managed meeting output must never fan out through user-configured
        // outbound hooks, including its first provider attempt.
        ...(prepared ? { suppressHook: true } : {}),
        hookContext,
        MessageWithdrawnError,
        ...(isolatedHookOrigin
          ? {
              beforeHook: fenceIsolatedOriginBeforeEffect,
              hookOrigin: isolatedHookOrigin,
            }
          : {}),
        // Explicit VC IM --into is rejected above, so an unquoted first send
        // retains the normal chat-scope dispatch semantics. On a mismatch the
        // frozen canonical target remains authoritative.
        dispatch: prepared?.outputMismatch
          ? async (body, type, uuid, suppressHook) => {
              revalidateVcMeetingManagedSend();
              return sendMessage(
                appId,
                canonicalOutput.targetChatId,
                body,
                type,
                uuid,
                hookContext,
                outboundMessageOptions(!!suppressHook),
              );
            }
          : dispatchAfterOriginGate,
        beforeEffect: originAlreadyRevalidated
          ? undefined
          : fenceIsolatedOriginBeforeEffect,
        beforeQuoteFallback: async () => {
          revalidateVcMeetingManagedSend();
          await revalidateIsolatedOriginBeforeEffect();
        },
        onQuoteWithdrawn: (id) => {
          console.error(`引用目标 ${id} 已撤回，改为普通发送`);
        },
      },
    );
    primaryQuotedId = result.primaryQuotedId;
    if (prepared?.kind === 'send' || prepared?.kind === 'succeeded') {
      finishVcMeetingImReply(resolveDataDir(), prepared.ref, result.messageId);
    }
    recordVcMeetingPrimaryOutput(result.messageId, canonicalOutput.targetChatId);
    return result.messageId;
  };

  try {
    // A file-sandbox relay supplies a host-private copy normalized inside the
    // sandbox namespace. Voice/doc-comment paths returned above use the same
    // already-sanitized outbound content, without card-markdown preparation.
    let text = extractCardText(content);
    const preparedContentFile = process.env.BOTMUX_CARD_PREPARED_CONTENT_FILE;
    if (preparedContentFile) {
      try { text = readFileSync(preparedContentFile, 'utf-8'); } catch { /* fall back safely below */ }
    }

    // `preparedContentFile` is presentation data produced inside an untrusted
    // sandbox and only TOCTOU-materialized by the host watcher. It is not an
    // authorization proof. Re-check the exact body/attachment shape that will
    // reach Lark after JSON extraction and prepared-content substitution, and
    // do so before even an image upload creates a provider-side effect.
    const managedRenderedPayloadError = managedVcSendPayloadError({
      managed: !!vcMeetingManagedSendOrigin,
      asVoice: false,
      hasBodyText: !!text.trim(),
      imageCount: images.length,
      fileCount: files.length,
      videoCount: videoAttachments.length,
      containsNativeAtTag: containsLarkAtTag(text),
    });
    if (managedRenderedPayloadError) {
      console.error(`botmux send refused for a managed VC turn: ${managedRenderedPayloadError}`);
      process.exit(2);
    }

    // Upload images only after the final rendered payload has passed the
    // managed side-effect gate above.
    const imageKeys: string[] = [];
    if (images.length > 0) {
      for (const imagePath of images) {
        await revalidateIsolatedOriginBeforeEffect();
        imageKeys.push(await uploadImage(appId, imagePath));
      }
    }

    // Auto-detect @BotName in text and inject as mentions, using the sender
    // app's cross-ref file for per-app-scoped open_ids. Without this, a plain
    // "@Claude" in text only triggers IPC routing but Lark UI shows it as
    // plain text — confusing the user who thinks the @ didn't fire.
    //
    // bot-to-bot @mention 两条触发入口（显式 --mention / 正文 `@BotName`）都
    // 落到下方的 mentions 数组，单 source of truth：让 Lark 在消息里渲染
    // 真正的 @at 元素。对方 bot 的 daemon 通过 WSClient 原生事件接到（依赖
    // "获取群组中其他机器人和用户@当前机器人的消息"权限），不再走任何本地
    // 转发——botmux 历史上为绕过 Lark 不投递跨 bot 事件搞过 signal-file，
    // 那套已经在该权限上线后整体下线。
    try {
      // --no-mention 显式不 @ 任何人：跳过正文 @BotName 的自动注入，否则正文里
      // 出现的 @名字 仍会被注入成 <at>，破坏 --no-mention 语义、还可能误触发对方
      // bot（正是要避免的循环 @）。botEntries/crossRef 仍需加载供 footer 寻址用。
      // --slash 同理跳过：斜杠命令正文（如 `/clear`）不该被扫成 @，收件人只认
      // 显式 --mention（下面的 slash 分支只用 explicit mentions 拼 <at> 前缀）。
      if (!noMention && !isSlashSend && !vcMeetingManagedSendOrigin) {
      const alreadyMentioned = new Set(mentions.map(m => m.open_id));
      // Scan a code-span-stripped copy so a bot name quoted inside backticks or a
      // fenced block (e.g. an example `botmux send --mention @Bot …` or an
      // explanatory `@Bot`) is not auto-injected as a real handoff — that spurious
      // <at> would wake a bot the model never meant to @. Explicit --mention still
      // works (it doesn't go through this prose scan).
      const textForBotScan = stripCodeSpans(text);
      // Sort by name length desc so longer names ("Claude分身") win over their
      // prefix ("Claude") when both could match — break-on-first-hit otherwise
      // routes "@Claude分身" to Claude.
      const sortedEntries = [...botEntries].sort(
        (a, b) => (b.botName?.length ?? 0) - (a.botName?.length ?? 0),
      );
      const selfAliases = new Set(
        botEntries
          .filter(entry => entry.larkAppId === appId)
          .flatMap(entry => [entry.botName, entry.cliId])
          .filter((name): name is string => !!name)
          .map(name => name.toLowerCase()),
      );
      // Bots actively in THIS conversation (thread root for thread-scope, chat for
      // chat-scope). Used to gate the type-generic `cliId` alias so prose "@codex"
      // resolves to the codex bot collaborating HERE, not every same-type bot
      // (the fan-out that pulled all Codex-named bots into a topic). See
      // eligibleAutoMentionAliases.
      const convoBotAppIds = new Set<string>();
      for (const sess of loadSessions().values()) {
        if (sess.status !== 'active' || !sess.larkAppId) continue;
        const here = isChatScope
          ? sess.chatId === s.chatId
          : (!!s.rootMessageId && sess.rootMessageId === s.rootMessageId);
        if (here) convoBotAppIds.add(sess.larkAppId);
      }
      for (const entry of sortedEntries) {
        if (!entry.botName || entry.larkAppId === appId) continue;
        const names = eligibleAutoMentionAliases({
          botName: entry.botName,
          cliId: entry.cliId ?? undefined,
          larkAppId: entry.larkAppId ?? undefined,
          selfAliases,
          convoBotAppIds,
        });
        for (const name of names) {
          const escName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          // Boundary: lookbehind blocks only ASCII word chars (so `user@Claude`
          // is rejected but `看看@CoCo` is accepted — CJK prefix is normal in
          // Chinese text). Lookahead blocks any Unicode letter/digit so
          // `@Claude2` doesn't match name "Claude" and `@Claude分身好的` doesn't
          // either-half-match.
          const re = new RegExp(`(?<![A-Za-z0-9_])@${escName}(?![\\p{L}\\p{N}_])`, 'iu');
          if (!re.test(textForBotScan)) continue;
          // Lark open_id is per-app scoped. Use sender-scoped id from cross-ref
          // only — falling back to entry.botOpenId would feed Lark a wrong-scope
          // id (target's self-scoped) and the API would reject it. Skip + warn
          // so the missing cross-ref is observable instead of silently dropped.
          const senderScopedId = crossRef[entry.botName];
          if (!senderScopedId) {
            console.error(`[botmux send] no cross-ref entry for "${entry.botName}" in app ${appId}, skipping auto-mention (cross-ref populates after the sender app first sees the target bot)`);
            break;
          }
          if (alreadyMentioned.has(senderScopedId)) break;
          // Prose `@OtherBot` auto-injection: inject normally. (The off-topic
          // sub-bot guard used to DROP this; we now let the model @ freely and
          // pick the destination with --into instead of being silently dropped.)
          mentions.push({ open_id: senderScopedId, name: entry.botName });
          alreadyMentioned.add(senderScopedId);
          break;
        }
      }
      }
    } catch { /* best-effort */ }

    const explicitKnownBotMention = hasKnownBotMention(text, mentions, botEntries, crossRef, appId);
    const knownBotOpenIds = knownBotOpenIdsFromCrossRef(crossRef, botEntries, appId);
    // --no-mention 显式不 @ 任何人 → 连 footer 的"发送给/cc"寻址 <at> 也清空，
    // 否则 footer 仍会 @ 人，与 --no-mention 语义和"未@任何人"输出自相矛盾
    // （Codex review P2）。--top-level 同样无特定收件人。
    const frozenFooterAddressingSource = explicitVcMeetingImOrigin?.replyTargetSenderOpenId
      ? { ...s, lastCallerOpenId: explicitVcMeetingImOrigin.replyTargetSenderOpenId }
      : frozenTurnDispatch?.replyTargetSenderOpenId
        ? {
            ...s,
            lastCallerOpenId: frozenTurnDispatch.replyTargetSenderOpenId,
            lastCallerIsBot: frozenTurnDispatch.replyTargetSenderIsBot,
          }
        : s;
    const footerAddressing = (sendTopLevel || noMention)
      ? { sendTo: undefined as string | undefined, cc: [] as string[] }
      : buildFooterAddressing(frozenFooterAddressingSource, {
          isOncall: !!oncallEntry,
          isSubstitute: isChatScope && turnReplyTarget?.turnId === currentTurnId && turnReplyTarget?.substitute === true,
          hasExplicitBotMention: explicitKnownBotMention,
          knownBotOpenIds,
        });
    if (customCard) {
      const mentionFooter = orderedFooterRecipients({
        sendTo: footerAddressing.sendTo,
        mentionIds: mentions.map(m => m.open_id),
        cc: footerAddressing.cc,
        inlinedIds: [],
      });
      const withFooter = withCustomCardMentionFooter(
        customCard,
        mentionFooter,
        localeForBot(appId),
      );
      if (!withFooter.ok) { console.error(`botmux send: ${withFooter.error}`); process.exit(2); }
      customCard = withFooter.card;
    }

    // Capture sentAtMs BEFORE dispatch — the worker's bridge fallback gates
    // on `sentAtMs ∈ [turn.markTimeMs, nextTurn.markTimeMs)`. If we recorded
    // it after dispatch (which can take seconds), a slow Lark RTT could push
    // this send's timestamp past the next turn's mark and falsely suppress
    // that turn's fallback emit. Pre-dispatch timestamp captures the moment
    // we committed to sending — that's the boundary the gate cares about.
    const sentAtMs = Date.now();
    let messageId: string;
    let feedbackBaseCard: Record<string, unknown> | undefined;
    let failedAttachments: { path: string; error: string }[] = [];
    let failedVideoAttachments: { path: string; coverPath: string; error: string }[] = [];
    const pureVideoSend = customCard
      ? false
      : shouldSendAsPureVideo({
          hasBodyText: !!text.trim(),
          imageCount: imageKeys.length,
          fileCount: files.length,
          videoCount: videoAttachments.length,
          mentionCount: mentions.length,
        });
    if (pureVideoSend && replyLayout) {
      console.error('botmux send: --layout 不作用于纯视频消息，本次已忽略');
      replyLayout = undefined;
    }
    if (customCard) {
      messageId = await dispatchPrimary(JSON.stringify(customCard), 'interactive');
    } else if (isSlashSend) {
      // --slash: deliver the command as a single-line plain-`text` message so the
      // receiving daemon's parseSlashCommandInvocation sees a bare `/cmd` (the
      // card path's `[🔊 语音总结]` footer would make it multi-line and demote it
      // to an ordinary prompt). Inline an `<at>` for each --mention so a peer
      // bot in a group is actually triggered AND the receiver can strip the
      // mention back to a clean command (Feishu keys the <at>, the receiver's
      // resolveMentions→stripLeadingMentions removes the leading `@Name`).
      const slash = validateSlashSend(content);
      if (!slash.ok) { console.error(`botmux send: ${slash.error}`); process.exit(2); }
      const atPrefix = mentions.map(m => `<at user_id="${m.open_id}"></at>`).join(' ');
      const slashText = atPrefix ? `${atPrefix} ${slash.command}` : slash.command;
      messageId = await dispatchPrimary(slashText, 'text');
    } else if (pureVideoSend) {
      // Pure-video fast path: send the preview as a standalone media message.
      // A send that also carries mentions is deliberately excluded (media messages
      // can't embed `<at>`), so it falls through to the card branch which renders
      // the @ on the footer and sends the video as a follow-up attachment — same
      // shape as an attachment-only `--files … --mention …` send, whose card body
      // is likewise empty. See shouldSendAsPureVideo.
      // No card/text primary here, so the FIRST media message must carry the
      // quote chain itself (dispatchPrimary applies the chat-scope quoteTargetId
      // and updates primaryQuotedId). Otherwise a bare `--videos … --no-mention`
      // reply in a 普通群 lands as a standalone message that doesn't quote the
      // trigger — unlike file-only/image-only sends whose primary card quotes.
      const videoResult = await sendVideoAttachments(
        {
          uploadFile,
          uploadImage,
          dispatch: dispatchAfterOriginGate,
          primaryDispatch: (body, type) => dispatchPrimary(body, type, true),
          beforeEffect: fenceIsolatedOriginBeforeEffect,
          ...(vcMeetingManagedSendOrigin ? { maxMessages: 1 } : {}),
        },
        appId,
        videoAttachments,
      );
      failedVideoAttachments = videoResult.failed;
      if (videoResult.sent.length === 0) {
        const first = failedVideoAttachments[0]?.error ?? 'unknown error';
        throw new Error(`视频发送失败: ${first}`);
      }
      messageId = videoResult.sent[0];
    } else {
      // 回复一律卡片（纯文本 post 路径已删）。
      // Inline `@Name` → `<at id=…>` at the exact spot it's written (CJK-name
      // aware, see applyInlineMentions); any --mention not inlined here is
      // rendered on the footer `发送给：` line below, not the body.
      const layoutBody = replyLayout
        ? extractFirstReplyCardHeading(text)
        : { markdown: text, heading: undefined };
      const layoutHeader = replyLayout
        ? buildReplyLayoutHeader(replyLayout, layoutBody.heading, replyStyle)
        : undefined;
      const { text: md, usedIds } = applyInlineMentions(layoutBody.markdown, mentions);
      // Non-inlined mentions are no longer dangled as a trailing @ block at the
      // body bottom — they're consolidated onto the footer `发送给：` line below
      // (human addressee first, then explicit targets). See orderedFooterRecipients.

      // Resolve image placeholders into card elements. A single-index
      // `![alt](img:N)` inlines a full-width image; a grouped `![](img:0,1[,2…])`
      // renders one row of images side by side (2/row, 3/row …); any image not
      // referenced by a placeholder is appended full-width at the end.
      // A normal sandbox relay supplies content already normalized inside its
      // own namespace and disables host probing. An incomplete/manual relay
      // falls back to probe-free lexical repair; direct sends use filesystem
      // disambiguation in their own process namespace.
      const configuredLinkMode = process.env.BOTMUX_CARD_LOCAL_LINK_MODE;
      const localHomeLinkMode: LocalHomeLinkMode = configuredLinkMode === 'disabled'
        ? 'disabled'
        : configuredLinkMode === 'lexical'
          ? 'lexical'
          : 'filesystem';
      const elements = (md || imageKeys.length > 0)
        ? buildImageCardElements(md, imageKeys, process.cwd(), localHomeLinkMode)
        : [];

      // Footer: de-emphasized markdown (v2 dropped the `note` tag). Use small
      // text size + grey font tag so it reads like a footnote below the hr.
      // Oncall groups usually address whoever triggered this turn (may not be
      // the session owner). Bot recipients are filtered out so footer chrome
      // cannot accidentally wake a sibling bot.
      // Brand segment honours this bot's configured brandLabel (unset →
      // default botmux, '' → suppressed, else custom). Same resolver/rule as
      // the daemon's card builders so both send paths render identically.
      // All real mentions land on one footer line: human addressee first, then
      // explicit @ targets (incl. handoff bots), then cc. Ids already inlined in
      // the body prose are skipped. Top-level publish keeps sendTo empty.
      const footerRecipients = orderedFooterRecipients({
        sendTo: footerAddressing.sendTo,
        mentionIds: mentions.map(m => m.open_id),
        cc: footerAddressing.cc,
        inlinedIds: usedIds,
      });
      const usageSnapshot = await readCardUsageSnapshotForSend(s, appId);
      const footer = buildReplyCardFooter({
        brand: renderBrandTemplate(resolveBrandLabel(appId), s.workingDir),
        recipientOpenIds: footerRecipients,
        usage: usageSnapshot,
        locale: localeForBot(appId),
      });
      // Footer line (brand 个性签名 + 发送给) and the optional 🔊 语音总结 button
      // share ONE row: footer text on the left (weighted, fills), button pinned
      // to the far right (auto width). When voice isn't configured the footer
      // renders alone, as before. Button only on a reply (not --top-level).
      // v2 cards put buttons inside column_set/column — never the 1.x
      // `tag:'action'` container (Feishu rejects it, error 200861).
      let voiceOn = false;
      // A managed receiver card has no callback controls: a voice-summary
      // button would open a second, unledgered model/output action when clicked.
      if (!sendTopLevel && !vcMeetingManagedSendOrigin) {
        try {
          const { isVoiceConfigured } = await import('./services/voice/index.js');
          voiceOn = isVoiceConfigured(appId);
        } catch { /* voice module/config unavailable → no button */ }
      }
      const footerContent = footer?.content ?? '';
      if (footerContent || voiceOn) {
        elements.push({ tag: 'hr' });
        if (voiceOn) {
          const anchorId = (isChatScope ? s.chatId : s.rootMessageId) ?? s.chatId;
          elements.push({
            tag: 'column_set',
            flex_mode: 'none',
            horizontal_spacing: 'default',
            columns: [
              {
                tag: 'column', width: 'weighted', weight: 1, vertical_align: 'center',
                elements: [footer?.element ?? {
                  tag: 'markdown',
                  text_size: 'notation',
                  content: ' ',
                }],
              },
              {
                tag: 'column', width: 'auto', vertical_align: 'center',
                elements: [{
                  tag: 'button',
                  text: { tag: 'plain_text', content: '🔊 语音总结' },
                  type: 'default',
                  behaviors: [{
                    type: 'callback',
                    value: { action: 'voice_summary', session_id: sid, root_id: anchorId, lark_app_id: appId, chat_id: targetChatId },
                  }],
                }],
              },
            ],
          });
        } else {
          if (footer) elements.push(footer.element);
        }
      }

      if (feedbackPolicy && effectiveResponseKind === 'final') {
        const canonicalCard = createReplyCard([...elements], layoutHeader);
        const feedbackElement = buildFeedbackElement(feedbackPolicy);
        const footerIndex = canonicalCard.body.elements.findIndex((element: any) => element?.element_id === 'botmux_reply_footer');
        canonicalCard.body.elements.splice(footerIndex >= 0 ? footerIndex : canonicalCard.body.elements.length, 0, feedbackElement);
        feedbackBaseCard = canonicalCard as unknown as Record<string, unknown>;
        messageId = await dispatchPrimary(JSON.stringify(feedbackBaseCard), 'interactive');
      } else {
        messageId = await dispatchPrimary(JSON.stringify(createReplyCard(elements, layoutHeader)), 'interactive');
      }
    }

    if (feedbackPolicy && effectiveResponseKind === 'final' && !customCard && !pureVideoSend && !vcMeetingManagedSendOrigin && messageId) {
      const deliveryTurnId = currentTurnId ?? `send:${messageId}`;
      const correlationDiscriminator = currentTurnId ? messageId : undefined;
      try {
        const { getSkillFeedbackStore } = await import('./services/skill-feedback-store.js');
        const feedbackStore = await getSkillFeedbackStore(resolveDataDir());
        feedbackStore.recordTurnDelivery({
          botAppId: appId,
          sessionId: sid,
          turnId: deliveryTurnId,
          correlationDiscriminator,
          nativeSessionId: s.cliSessionId,
          platform: 'lark',
          platformAppId: appId,
          platformMessageId: messageId,
          chatId: targetChatId,
          topicRootId: sendTarget.mode === 'thread' ? sendTarget.rootMessageId : s.rootMessageId,
          dispatchAttempt: originDispatchAttempt,
          content: text,
          cliId: s.cliId,
          cardMode: 'feedback',
          status: 'delivered',
          policy: feedbackPolicy,
          baseCard: feedbackBaseCard,
          requesterSubjectId: feedbackRequesterSubjectId,
          webhookDestinations: feedbackWebhookDestinations,
          context: { ...(resolveFeedbackTeamId({ dataDir: resolveDataDir(), chatId: targetChatId }) ? { teamId: resolveFeedbackTeamId({ dataDir: resolveDataDir(), chatId: targetChatId }) } : {}) },
        });
      } catch (error) {
        console.error(
          `botmux send: feedback indexing failed after delivery: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    // Bridge fallback marker — append-only jsonl per session. Same-thread
    // sends can suppress transcript fallback when their content appears to
    // cover the same final answer; detoured sends suppress only when they
    // closed a pending response card for this turn.
    if (shouldRecordBridgeMarker || deferredTopicRootMessageIdForOutput) {
      recordBridgeSendMarker(sentAtMs, messageId, text);
    }

    // Send attachments as separate messages — best-effort. The primary message
    // is already delivered above; a failing attachment must not throw out to the
    // catch below (which would report total failure / exit 1 for an already-sent
    // message and make the caller resend). Warn instead, and list failures in
    // the success JSON. Pure-video sends have no text/card primary, so the media
    // message above is the primary and failures before any media is sent still
    // surface as command failure.
    if (!pureVideoSend && !vcMeetingListenerReplyReplay) {
      ({ failed: failedAttachments } = await sendFileAttachments(
        { uploadFile, dispatch: dispatchAfterOriginGate, beforeEffect: fenceIsolatedOriginBeforeEffect }, appId, files,
      ));
      const videoResult = await sendVideoAttachments(
        { uploadFile, uploadImage, dispatch: dispatchAfterOriginGate, beforeEffect: fenceIsolatedOriginBeforeEffect }, appId, videoAttachments,
      );
      failedVideoAttachments = videoResult.failed;
    }
    for (const f of failedAttachments) {
      console.error(`⚠️ 附件未发送（主消息已送达 ${messageId}，请勿重发）: ${f.path} — ${f.error}`);
    }
    for (const f of failedVideoAttachments) {
      console.error(`⚠️ 视频未发送（主消息已送达 ${messageId}，请勿重发）: ${f.path} / cover ${f.coverPath} — ${f.error}`);
    }

    // Bot-to-bot 转发依赖飞书"获取群组中其他机器人和用户@当前机器人的消息"权限：
    // 目标 bot 的 daemon 现在能从 WSClient 原生收到 sender_type='app' 的事件，
    // 不需要 botmux 自己再写本地 signal 文件做转发。outgoing 消息里 @BotName /
    // --mention 的 open_id 解析（在上方 mentions 数组里完成）仍然必要，它让
    // Lark 在消息里渲染真正的 @at 元素，从而触发对方 bot 的 WS 事件投递。

    const atSummary = mentions.length > 0
      ? `@${mentions.map(m => m.name || m.open_id).join(',')}`
      : '未@任何人';
    console.error(`✓ 已发送 ${messageId} ｜ ${primaryQuotedId ? `引用 ${primaryQuotedId}` : '未引用'} ｜ ${atSummary}`);
    // Sentinel guidance is surfaced HERE — in the send-success output the model
    // reads back — rather than only in the injected system prompt. A model only
    // learns about BOTMUX_NOTHING_TO_SEND after it has actually sent, so it
    // cannot use the sentinel to end a turn where it did work but forgot to send
    // (the ghosting shape). The injected prompt keeps a one-line sentinel note
    // only for the genuine never-send silence case (message addressed to another
    // bot). See services/bridge-fallback-gate.ts for the matching strip-and-forward gate.
    console.error(t('ai.send.after_success_hint', undefined, localeForBot(appId)));

    // --attention: message is already delivered above; now flip the dashboard
    // needs-you state via the daemon (botmux send is direct-to-Lark, so the
    // daemon-held ds.agentAttention must be set out-of-band). Best-effort: a
    // failure here must NOT fail the send (else the agent retries → duplicate
    // messages) — warn on stderr and surface in the JSON for log observability.
    let attentionRaised: boolean | undefined;
    let attentionError: string | undefined;
    if (attention.requested) {
      try {
        // Raising attention is a second externally visible effect after the
        // awaited Lark send.  Bind it to a fresh proof of the same original
        // turn instead of re-reading a stable path that may now belong to a
        // successor worker generation.
        const freshIsolatedOrigin = await revalidateIsolatedOriginBeforeEffect();
        const attentionOrigin = freshIsolatedOrigin ?? liveMarkerCtx;
        const daemon = freshIsolatedOrigin ? undefined : findDaemon(appId);
        const attentionPort = freshIsolatedOrigin
          ? isolatedAttestationContext?.ipcPortFallback
          : daemon?.ipcPort;
        if (!attentionPort) {
          throw new Error(freshIsolatedOrigin
            ? '受保护的 managed-origin claim 未提供 owning daemon 端口'
            : `找不到 daemon (larkAppId=${appId})`);
        }
        const originCapability = freshIsolatedOrigin
          ? isolatedAttestationContext?.capability
          : readManagedOriginCapability(
              resolveDataDir(),
              sid,
              process.env.BOTMUX_SEND_RELAY,
              process.env.BOTMUX_ORIGIN_CHANNEL_ID,
            )?.capability;
        const request = {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            sessionId: sid,
            larkAppId: appId,
            action: 'raise',
            kind: attention.kind,
            reason: text.trim(),
            originCapability,
            originTurnId: attentionOrigin?.turnId,
            originDispatchAttempt: attentionOrigin?.dispatchAttempt,
          }),
        } satisfies RequestInit;
        let secret: string | undefined;
        try { secret = loadDaemonIpcSecret(); } catch { /* Seatbelt/read-isolated CLI */ }
        const res = secret
          ? await fetchDaemonIpc(attentionPort, '/api/attention', request, secret)
          : await loopbackFetch(`http://127.0.0.1:${attentionPort}/api/attention`, request);
        if (!res.ok) throw new Error(`daemon HTTP ${res.status}`);
        attentionRaised = true;
        console.error(`🙋 已举手：本会话已进 dashboard「需要你」列（用户回复后自动撤下）`);
      } catch (err) {
        attentionRaised = false;
        attentionError = err instanceof Error ? err.message : String(err);
        console.error(`⚠️ 消息已发送，但举手(needs-you)置位失败（不影响消息）：${attentionError}`);
      }
    }
    console.log(JSON.stringify({
      success: true,
      messageId,
      sessionId: sid,
      quotedMessageId: primaryQuotedId,
      mentioned: mentions.map(m => ({ open_id: m.open_id, name: m.name })),
      ...(deferredTopicRootMessageIdForOutput
        ? { deferredTopicRootMessageId: deferredTopicRootMessageIdForOutput, turnId: currentTurnId }
        : {}),
      ...(attention.requested ? { attentionRaised, attentionError } : {}),
      ...(failedAttachments.length > 0
        ? { failedAttachments: failedAttachments.map(f => f.path) }
        : {}),
      ...(failedVideoAttachments.length > 0
        ? { failedVideoAttachments: failedVideoAttachments.map(f => f.path) }
        : {}),
    }));
  } catch (err: any) {
    console.error(`发送失败: ${describeSendFailure(err)}`);
    process.exit(1);
  }
}

// ─── Card subcommand (patch a previously-sent custom card in place) ───

async function cmdCard(rest: string[]): Promise<void> {
  const sub = rest[0] ?? '';
  if (sub === '' || sub === '--help' || sub === '-h') {
    console.log(CARD_COMMAND_USAGE);
    return;
  }
  if (sub !== 'patch') {
    console.error(
      `未知 card 子命令: ${sub}\n` +
      `用法: botmux card patch --message-id <om_xxx> (--card-file <path> | --card-json <json>) [--session-id <sid>]`,
    );
    process.exit(2);
  }
  const args = rest.slice(1);
  // Help wins over the missing-arg validation and the transport gates below.
  if (cardPatchArgsWantHelp(args)) {
    console.log(CARD_PATCH_USAGE);
    return;
  }
  // Same two transport doors as `botmux send`: a no-transport turn (apiOnly bot
  // or HTTP virtual session) may not originate ANY Feishu write — including a
  // card patch.
  assertTurnTransportOrExit('card patch');
  // Read isolation: register this bot from its own worker-written cred file so
  // the Lark client resolves without reading the denied bots.json (same as
  // cmdSend/cmdHistory).
  await registerSelfFromCredFile();

  const parsed = parseCardPatchArgs(args);
  if (!parsed.ok) {
    console.error(`botmux card patch: ${parsed.error}`);
    process.exit(2);
  }
  const input = readCardPatchInput(parsed.cardFile, parsed.cardJson);
  if (!input.ok) {
    console.error(`botmux card patch: ${input.error}`);
    process.exit(input.exitCode);
  }
  // Bot identity comes from the session context only (same as send): no
  // --bot-style explicit selector. Resolves --session-id / ancestor pid marker
  // / BOTMUX_SESSION_ID / riff sandbox, and registers the bot so getBotClient
  // works. Exits 1 on failure (session not found / no larkAppId), same as send.
  const { sid, larkAppId, session } = await resolveSessionAppId(parsed.sessionId);
  // Target-aware door: a --session-id pointing at a virtual/apiOnly session is
  // refused even from a transport-capable turn.
  assertSessionTransportOrExit({ chatId: session.chatId, larkAppId }, 'card patch');

  const { updateMessage } = await import('./im/lark/client.js');
  const outcome = await executeCardPatch(
    { updateMessage },
    { larkAppId, messageId: parsed.messageId, rawCard: input.rawCard },
  );
  if (!outcome.ok) {
    console.error(`botmux card patch: ${outcome.error}`);
    process.exit(outcome.exitCode);
  }
  console.log(buildCardPatchSuccessOutput(outcome.messageId, sid));
}

// ─── Dispatch subcommand (Phase 0: assign bots in a goal chat / optional topic) ───

async function postCurrentSessionDaemonRoute(input: {
  path: string;
  sessionId: string;
  larkAppId: string;
  body: Record<string, unknown>;
}): Promise<Response> {
  const relayDir = process.env.BOTMUX_SEND_RELAY;
  let hostSecret: string | undefined;
  if (!relayDir) {
    try { hostSecret = loadDaemonIpcSecret(); } catch { /* isolated CLI */ }
  }
  let discoveredPort: number | undefined;
  try { discoveredPort = findDaemon(input.larkAppId)?.ipcPort; } catch { /* masked registry */ }
  const port = resolveDaemonIpcPort(discoveredPort, process.env.BOTMUX_DAEMON_IPC_PORT);
  if (!port) throw new Error('当前 Bot daemon 不在线');
  if (hostSecret) {
    return fetchDaemonIpc(port, input.path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: input.sessionId, ...input.body }),
    }, hostSecret);
  }
  const originClaim = readManagedOriginCapability(
    resolveDataDir(),
    input.sessionId,
    relayDir,
    process.env.BOTMUX_ORIGIN_CHANNEL_ID,
  );
  return loopbackFetch(`http://127.0.0.1:${port}${input.path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      sessionId: input.sessionId,
      ...input.body,
      originCapability: originClaim?.capability,
      originTurnId: originClaim?.turnId,
      originDispatchAttempt: originClaim?.dispatchAttempt,
    }),
  });
}

async function cmdDispatch(rest: string[]): Promise<void> {
  if (rest.includes('--help') || rest.includes('-h')) {
    console.log(`botmux dispatch — 在 goal 群派活、把 bot 拉进去协作（含 repo 预设 / 待命 / 追加）

用法:
  新开话题派活:
    botmux dispatch --title "子项目标题" --bot-app <larkAppId[:角色]> [--bot-app ...] \\
        [--brief "简报" | --brief-file <path>] [--repo <工作目录>] [--standby]
  群级派活（默认，不开话题）:
    botmux dispatch --title "子项目标题" --bot <open_id[:名字[:角色]]> [--bot ...] \\
        [--brief "简报" | --brief-file <path>] [--repo <工作目录> | --needs-repo <远端URL或别名>] [--standby] \\
        [--task-id <id>] [--acceptance-hint <text>] [--after <上游taskId>]... [--new-topic]
  往已有话题追加（激活待命 bot / 追加协调）:
    botmux dispatch --into <话题根消息id> --bot-app <larkAppId[:角色]> (--brief ... | --brief-file ...)

说明:
  默认群级派活: 在目标群直接 @ 执行者，适合单执行者 / 顺序 / 轻量子任务。
  --new-topic: 显式开隔离话题，适合多执行者并行、深度协作或防刷屏。
  --repo:   先用 /repo 给每个子 bot 定好工作目录——spawn 时不弹「选仓库」卡、不用手点。
  --needs-repo: 跨设备派活时声明所需项目；接收端用自己的本地目录自检，缺少时立即求助。
  --after: 只登记依赖关系，不立即联系执行者；所有上游任务验收通过后自动派发。可重复。
  --standby: 配合 --repo——只把 bot 拉起来定好目录待命（不派简报），之后用 --into 或群级消息派具体任务。
  --into:   不建种子，直接回到已有话题线程 @ bot 追加一条。
  返回 JSON（含 delivery=chat|thread），供主控/监管者登记派活位置。

选项:
  --title <t>           子项目标题（新开话题时必填）
  --bot-app <spec>      推荐；稳定 App 身份，可重复；spec = larkAppId[:角色]。
                        派单前按双方 receiver 视角建立并回读 talk-only exact chatGrant，
                        发送后等待目标 session 接单确认；不支持 --repo 管理命令
  --bot <spec>          兼容外部/旧链路；spec = open_id[:名字[:角色]]，不保证本机双向授权
  --brief <text>        子项目简报 / 追加内容；首个语义行写 @steer 可显式调整活跃 Codex App turn
  --brief-file <path>   从文件读取简报
  --steer               在简报前注入通用 @steer 指令；普通 dispatch 默认仍进入 Queue
  --repo <path>         预设子 bot 工作目录（绝对路径，需在子 bot 所在机器上存在）
  --needs-repo <id>     所需 git 项目（推荐 remote URL，也可用接收端已登记的别名）
  --standby             仅 --repo 待命，不派简报
  --new-topic           显式为本次派活开独立话题（默认不开）
  --task-id <id>        覆盖可信交付任务号（默认自动生成 task-<slug>-<hash8>）
  --acceptance-hint <t> 监管者打算如何验收，随任务简报和交付记录一起传给执行者
  --after <taskId>      等该上游任务验收通过后再自动派发，可重复
  --into <root_id>      回到已有话题线程追加（与 --title/种子互斥）
  --chat-id <id>        覆盖目标群（默认当前会话所在群）
  --skip-readiness-check 跳过已确认的群成员/版本不兼容错误（仍打印诊断）
  --session-id <id>     指定来源会话（默认自动推断）`);
    return;
  }
  const dispatchRelayDir = process.env.BOTMUX_SEND_RELAY;
  if (dispatchRelayDir) {
    await relayDispatch(rest, dispatchRelayDir);
    return;
  }
  // dispatch opens a real Feishu topic + pulls bots into a chat (a write). A
  // no-transport turn has no Feishu chat to dispatch into — central hard gate.
  assertTurnTransportOrExit('dispatch');

  process.env.SESSION_DATA_DIR ??= resolveDataDir();
  const sessionIdArg = argValue(rest, '--session-id');
  const title = argValue(rest, '--title') ?? '';
  const briefFile = argValue(rest, '--brief-file');
  const overrideChatId = argValue(rest, '--chat-id');
  const repo = argValue(rest, '--repo');
  const needsRepoRaw = argValue(rest, '--needs-repo')?.trim();
  // Put a credential-free canonical identity on the wire/ledger when the input
  // is a remote URL; aliases pass through unchanged for receiver-local lookup.
  const needsRepo = needsRepoRaw ? (normalizeRepoRemote(needsRepoRaw) ?? needsRepoRaw) : undefined;
  const intoRoot = argValue(rest, '--into');
  const explicitTaskId = argValue(rest, '--task-id');
  const acceptanceHint = argValue(rest, '--acceptance-hint');
  const standby = rest.includes('--standby');
  const steer = rest.includes('--steer');
  const newTopic = rest.includes('--new-topic');
  const skipReadinessCheck = rest.includes('--skip-readiness-check');
  const botSpecs = argValues(rest, '--bot');
  const botAppSpecs = argValues(rest, '--bot-app');
  const hasAfter = rest.some((value) => value === '--after' || value.startsWith('--after='));
  const afterTaskIds = argValues(rest, '--after');

  let brief = argValue(rest, '--brief') ?? '';
  if (briefFile) {
    if (!existsSync(briefFile)) { console.error(`文件不存在: ${briefFile}`); process.exit(1); }
    brief = readFileSync(briefFile, 'utf-8');
  }
  const briefBase = brief;

  const taskId = (!intoRoot && !standby)
    ? (explicitTaskId?.trim() || generateTaskId({ title: title.trim() || '子项目', brief }))
    : undefined;
  const parsedAcceptance = taskId ? parseAcceptanceCriteria(acceptanceHint) : { structured: false };
  if (parsedAcceptance.error) {
    console.error(`验收标准非法: ${parsedAcceptance.error}`);
    process.exit(1);
  }

  // Append the verified-delivery protocol so the dispatched sub-bot reports via
  // `botmux report --task <id>` with evidence the orchestrator can verify. This
  // still routes to the orchestrator's OWN session rather than @-ing the
  // orchestrator in the sub-topic. Skipped for --standby / --into follow-ups.
  if (brief.trim()) {
    if (taskId) {
      brief = appendVerifiedDeliveryInstructions({ brief, taskId, acceptanceHint });
    } else {
      brief = brief.trimEnd() +
        '\n\n— 完成回报 —\n' +
        '干完后在本话题运行 `botmux report "子项目完成 + 产出位置/摘要"` 把结果回报给主编排会话；' +
        '不要在本话题 @ 主bot（那会另起一个没有上下文的新会话）。';
    }
  }

  // ── Flag validation ──
  if (botSpecs.length === 0 && botAppSpecs.length === 0) {
    console.error('至少要用 --bot-app（推荐）或 --bot 指派一个 bot。用法见 botmux dispatch --help');
    process.exit(1);
  }
  if (rest.includes('--needs-repo') && !needsRepo) {
    console.error('--needs-repo 需要一个 git remote URL 或项目别名。');
    process.exit(1);
  }
  if (standby && !repo) {
    console.error('--standby 需要配合 --repo（先定好工作目录把 bot 拉起待命）。');
    process.exit(1);
  }
  if (repo && needsRepo) {
    console.error('--repo 与 --needs-repo 不能同用：前者共享路径，后者让每台机器自行解析项目。');
    process.exit(1);
  }
  if (hasAfter && afterTaskIds.length === 0) {
    console.error('--after 需要一个上游任务号，可重复传入。');
    process.exit(1);
  }
  if (hasAfter && (repo || standby || intoRoot || newTopic || skipReadinessCheck)) {
    console.error('--after 只支持群级单消息派发，不能与 --repo / --standby / --into / --new-topic / --skip-readiness-check 同用。');
    process.exit(1);
  }
  if (needsRepo && (standby || intoRoot)) {
    console.error('--needs-repo 只用于新任务派发，不能与 --standby 或 --into 同用。');
    process.exit(1);
  }
  if (standby && intoRoot) {
    console.error('--standby 与 --into 不能同用。');
    process.exit(1);
  }
  if (standby && steer) {
    console.error('--standby 与 --steer 不能同用（待命模式没有简报可调整当前 turn）。');
    process.exit(1);
  }
  if (botAppSpecs.length > 0 && repo) {
    console.error('--bot-app 仅自动建立 talk-only chatGrant，不能授权 /repo 管理命令；请使用驻守 Bot 的默认工作目录，或另走显式 operate 信任链路。');
    process.exit(1);
  }
  if (newTopic && intoRoot) {
    console.error('--new-topic 与 --into 不能同用。');
    process.exit(1);
  }
  if (!standby && !brief.trim()) {
    console.error('缺少简报。用 --brief 或 --brief-file 指定（仅 --standby 模式可省略）。');
    process.exit(1);
  }
  if (steer) brief = withBotSteerDirective(brief);
  if (!intoRoot && !title.trim()) {
    console.error('新开话题需要 --title。往已有话题追加请用 --into <root_id>。');
    process.exit(1);
  }

  let legacyBots: DispatchBot[];
  try {
    legacyBots = botSpecs.map(parseDispatchBotSpec);
  } catch (err: any) {
    console.error(`--bot 解析失败: ${err.message}`);
    process.exit(1);
  }

  const sid = sessionIdArg ?? findAncestorSessionId();
  if (!sid) {
    console.error('无法推断 session-id。请在 Lark 话题内的 CLI 会话中运行，或传 --session-id <id>。');
    process.exit(1);
  }
  const sessions = loadSessions();
  const s = sessions.get(sid);
  if (!s) { console.error(`未找到 session ${sid}`); process.exit(1); }
  if (!s.larkAppId) { console.error(`session ${sid} 缺少 larkAppId`); process.exit(1); }
  // Target-aware gate on the RESOLVED source session: dispatch from a virtual /
  // apiOnly source turn is refused even with a real --chat-id override (a
  // no-transport turn may not originate a Feishu topic/write). Closes the
  // `dispatch --session-id <virtual> --chat-id oc_real` env-only gap.
  assertSessionTransportOrExit({ chatId: s.chatId, larkAppId: s.larkAppId }, 'dispatch');

  const targetChatId = overrideChatId ?? s.chatId;
  if (!targetChatId) { console.error(`session ${sid} 缺少 chatId，且未提供 --chat-id`); process.exit(1); }
  const deliveryLedger = openLedger();
  if (taskId && !hasAfter) {
    const current = deliveryLedger.task(taskId);
    if (current?.plan && current.status === 'cancelled') {
      console.error(`任务 ${taskId} 是已取消的依赖任务；如需重开，请重复原来的 --after 声明。`);
      process.exit(1);
    }
  }

  const { registerBot, loadBotConfigs } = await import('./bot-registry.js');
  let botConfigs;
  try {
    botConfigs = loadBotConfigs();
    for (const cfg of botConfigs) registerBot(cfg);
    if (envPinnedRiffBot) registerBot(envPinnedRiffBot);
  } catch (err: any) {
    console.error(`加载 bot 配置失败: ${err?.message ?? err}`);
    process.exit(1);
  }
  const { resolveCurrentChatBotOpenIdsByLarkAppIds } = await import('./im/lark/client.js');
  const appId = s.larkAppId!;

  const parsedBotApps: Array<{ appId: string; role?: string }> = [];
  for (const raw of botAppSpecs) {
    const [targetAppIdRaw, roleRaw] = raw.split(':', 2);
    const targetAppId = targetAppIdRaw?.trim();
    const role = roleRaw?.trim() || undefined;
    if (!targetAppId || !targetAppId.startsWith('cli_')) {
      console.error(`--bot-app 必须是稳定 larkAppId[:角色]: ${raw}`);
      process.exit(1);
    }
    if (targetAppId === appId) {
      console.error('--bot-app 不能指向当前编排 Bot 自己。');
      process.exit(1);
    }
    if (!botConfigs.some(cfg => cfg.larkAppId === targetAppId)) {
      console.error(`--bot-app 不是本机已配置 Bot: ${targetAppId}`);
      process.exit(1);
    }
    if (!parsedBotApps.some(item => item.appId === targetAppId)) parsedBotApps.push({ appId: targetAppId, role });
  }

  let appBots: Array<{ openId: string; name?: string; role?: string }> = [];
  if (parsedBotApps.length > 0) {
    const appIds = parsedBotApps.map(item => item.appId);
    const resolved = await resolveCurrentChatBotOpenIdsByLarkAppIds(appId, targetChatId, appIds);
    if (!resolved.ok) {
      console.error(`dispatch 协作身份解析失败: ${resolved.error}: ${resolved.message}`);
      process.exit(1);
    }
    let botInfo: Array<{ larkAppId: string; botName: string | null }> = [];
    try {
      const raw = JSON.parse(readFileSync(join(resolveDataDir(), 'bots-info.json'), 'utf-8'));
      if (Array.isArray(raw)) botInfo = raw;
    } catch { /* strict resolver already validated names; display can fall back to app id */ }
    const byAppId = new Map(resolved.mappings.map(mapping => [mapping.larkAppId, mapping.subjectOpenId]));
    appBots = parsedBotApps.map(item => ({
      openId: byAppId.get(item.appId)!,
      name: botInfo.find(info => info.larkAppId === item.appId)?.botName ?? item.appId,
      role: item.role,
    }));
    try {
      await ensureLocalBotCollaboration(targetChatId, [appId, ...appIds]);
    } catch (err: any) {
      console.error(`dispatch 协作授权未就绪，未发送任务: ${err?.message ?? err}`);
      process.exit(1);
    }
  }

  let bots = [...legacyBots, ...appBots]
    .filter((bot, index, all) => all.findIndex(candidate => candidate.openId === bot.openId) === index);
  const { readRoleDispatchCompletionEnabled } = await import('./core/role-resolver.js');
  const sameTopicSendEnabled = readRoleDispatchCompletionEnabled(appId, targetChatId);
  const exactReportRootEnabled = parsedBotApps.length > 0 && legacyBots.length === 0;
  const briefWithCompletionProtocol = (dispatchRootId: string): string => buildDispatchCompletionBrief({
    brief,
    dispatchRootId,
    exactReportRootEnabled,
    sameTopicSendEnabled,
  });
  type BotInfoEntry = { larkAppId: string; botOpenId: string | null; botName: string | null; cliId: string };
  let botInfoEntries: BotInfoEntry[] = [];
  try {
    const botInfoPath = join(resolveDataDir(), 'bots-info.json');
    if (existsSync(botInfoPath)) botInfoEntries = JSON.parse(readFileSync(botInfoPath, 'utf-8'));
  } catch { /* best effort */ }
  const senderScopedBotOpenIds = readBotOpenIdCrossRefRecord(resolveDataDir(), appId);
  bots = normalizeDispatchBotsForSender({
    bots,
    botInfoEntries,
    senderScopedBotOpenIds,
  });
  let built;
  try {
    built = buildDispatchMessages({
      title: title.trim() || '子项目',
      brief: intoRoot ? briefWithCompletionProtocol(intoRoot) : brief,
      bots,
      repoRequirement: needsRepo && taskId ? { taskId, repo: needsRepo } : undefined,
    });
  } catch (err: any) {
    console.error(`dispatch 构建失败: ${err.message}`);
    process.exit(1);
  }
  const workerNameByOpenId = new Map(bots.map(b => [b.openId, b.name?.trim() || b.openId]));
  const workerNames = built.mentionedOpenIds.map(openId => workerNameByOpenId.get(openId) ?? openId);
  const workerMetas = resolveDispatchWorkerMetas({
    openIds: built.mentionedOpenIds,
    bots,
    workerNames,
    botConfigs,
    botInfoEntries,
    senderScopedBotOpenIds,
  });
  const workerLarkAppIds = workerMetas.map((meta) => meta.larkAppId);
  const workerCliIds = workerMetas.map((meta) => meta.cliId);
  const hasWorkerMeta = workerLarkAppIds.some(Boolean) || workerCliIds.some(Boolean);
  let workerBotUnionIds: string[] = [];
  let platformTeamBots: Array<{
    larkAppId: string;
    cliId: string;
    name: string;
    botUnionId?: string;
    botmuxVersion?: string;
    a2aCapabilities?: string[];
  }> = [];
  let federationBots: typeof platformTeamBots = [];
  try {
    const { buildFederatedRoster } = await import('./services/federation-roster.js');
    const { listBotUnionIds } = await import('./services/observed-bot-union-ids-store.js');
    const { listPlatformTeams } = await import('./services/platform-team-store.js');
    const dataDir = resolveDataDir();
    const roster = buildFederatedRoster(dataDir);
    federationBots = roster.bots.map((bot) => ({
      larkAppId: bot.larkAppId,
      cliId: bot.cliId,
      name: bot.name,
      botUnionId: bot.botUnionId,
      botmuxVersion: bot.botmuxVersion,
      a2aCapabilities: bot.a2aCapabilities,
    }));
    const botConfigByAppId = new Map(botConfigs.map((cfg) => [cfg.larkAppId, cfg]));
    const botInfoByAppId = new Map(botInfoEntries.map((entry) => [entry.larkAppId, entry]));
    platformTeamBots = listPlatformTeams(dataDir).flatMap((team) =>
      team.bots.map((bot) => {
        const info = botInfoByAppId.get(bot.appId);
        const cfg = botConfigByAppId.get(bot.appId);
        const cliId = info?.cliId || cfg?.cliId || '';
        return {
          larkAppId: bot.appId,
          cliId,
          name: bot.name?.trim() || info?.botName?.trim() || cliId || bot.appId,
          botUnionId: bot.unionId,
          botmuxVersion: bot.botmuxVersion,
          a2aCapabilities: bot.a2aCapabilities,
        };
      }),
    );
    workerBotUnionIds = resolveDispatchWorkerBotUnionIds({
      openIds: built.mentionedOpenIds,
      bots,
      workerNames,
      workerMetas,
      platformTeamBots,
      learnedBotUnionIdsByName: listBotUnionIds(dataDir),
      federationBots,
      senderScopedBotOpenIds,
    });
  } catch { /* best effort: workers without botUnionId fall back to open_id auth */ }
  const hasWorkerBotUnionIds = workerBotUnionIds.some(Boolean);
  if (hasAfter) {
    const unresolvedWorkers = built.mentionedOpenIds
      .map((openId, index) => ({ openId, name: workerNames[index] ?? openId }))
      .filter((worker) => !isMentionableBotOpenId(worker.openId));
    if (unresolvedWorkers.length > 0) {
      console.error(
        `依赖任务登记失败: ${unresolvedWorkers.map((worker) => worker.name).join('、')} ` +
        '还没有群内可 @ 的身份。请先用 botmux goal start 创建/核验目标群，或先直接派发一次完成身份同步。',
      );
      process.exit(1);
    }
    if (!taskId) {
      console.error('--after 需要一个新任务号；请勿与 --standby 或 --into 同用。');
      process.exit(1);
    }
    let transition;
    try {
      transition = resolveTaskPlanTransition({
        taskId,
        dependsOnTaskIds: afterTaskIds,
        current: deliveryLedger.task(taskId),
      });
    } catch (err: any) {
      console.error(`依赖任务登记失败: ${err.message}`);
      process.exit(1);
    }
    for (const dependencyId of transition.dependsOnTaskIds) {
      const dependency = deliveryLedger.task(dependencyId);
      if (!dependency) {
        console.error(`依赖任务登记失败: 未找到上游任务 ${dependencyId}`);
        process.exit(1);
      }
      if (dependency.chatId !== targetChatId) {
        console.error(`依赖任务登记失败: 上游任务 ${dependencyId} 不属于当前目标群`);
        process.exit(1);
      }
    }
    const frozenWorkerSpecs: TaskDispatchWorkerSpec[] = built.mentionedOpenIds.map((openId, index) => ({
      openId,
      name: workerNames[index] || undefined,
      role: bots[index]?.role?.trim() || undefined,
      larkAppId: workerLarkAppIds[index] || undefined,
      cliId: workerCliIds[index] || undefined,
      unionId: workerBotUnionIds[index] || undefined,
    }));
    try {
      const planned = deliveryLedger.append({
        type: 'TaskPlanned',
        actor: 'orchestrator',
        taskId,
        chatId: targetChatId,
        ts: Date.now(),
        idempotencyKey: transition.idempotencyKey,
        payload: {
          taskId,
          chatId: targetChatId,
          title: title.trim(),
          dependsOnTaskIds: transition.dependsOnTaskIds,
          planGeneration: transition.planGeneration,
          reopenOfCancelEventId: transition.reopenOfCancelEventId,
          plannedBy: s.ownerOpenId?.trim() || sid,
          dispatchSpec: {
            title: title.trim(),
            briefBase,
            workers: frozenWorkerSpecs,
            senderLarkAppId: appId,
            requiredRepo: needsRepo || undefined,
            acceptanceHint: acceptanceHint?.trim() || undefined,
            acceptanceCriteria: parsedAcceptance.criteria,
          },
        },
      });
      console.log(JSON.stringify({
        success: true,
        mode: 'planned',
        taskId,
        chatId: targetChatId,
        dependsOnTaskIds: transition.dependsOnTaskIds,
        planGeneration: transition.planGeneration,
        released: false,
        contactedWorkers: false,
        deduped: planned.deduped,
      }, null, 2));
      return;
    } catch (err: any) {
      console.error(`依赖任务登记失败: ${err.message}`);
      process.exit(1);
    }
  }
  const { sendMessage, replyMessage, probeChatBotMembership } = await import('./im/lark/client.js');

  let dispatchRootForLifecycle = intoRoot;
  let membership;
  try {
    membership = await probeChatBotMembership(appId, targetChatId);
  } catch (err: any) {
    membership = { known: false as const, members: [] as [], reason: err?.message ?? String(err) };
  }
  const localAppIds = new Set(botConfigs.map((cfg) => cfg.larkAppId));
  const peers: A2APeerCapability[] = [...platformTeamBots, ...federationBots].map((bot) => ({
    larkAppId: bot.larkAppId,
    unionId: bot.botUnionId,
    name: bot.name,
    cliId: bot.cliId,
    botmuxVersion: bot.botmuxVersion,
    a2aCapabilities: bot.a2aCapabilities,
  }));
  const requiredCapabilities = taskId ? [A2A_CAPABILITY_DELIVERY_V1] : [];
  if (needsRepo) requiredCapabilities.push(A2A_CAPABILITY_DISPATCH_REPO_V1);
  const dispatchWorkers = built.mentionedOpenIds.map((openId, index) => ({
    openId,
    name: workerNames[index] ?? openId,
    larkAppId: workerLarkAppIds[index] || undefined,
    cliId: workerCliIds[index] || undefined,
    unionId: workerBotUnionIds[index] || undefined,
    local: !!workerLarkAppIds[index] && localAppIds.has(workerLarkAppIds[index]),
  }));
  const mentionResolution = resolveDispatchMentionIdentities({
    workers: dispatchWorkers,
    membership,
    peers,
  });
  const readiness = evaluateDispatchReadiness({
    workers: dispatchWorkers,
    membership,
    peers,
    requiredCapabilities,
  });
  for (const issue of readiness.issues) {
    const prefix = issue.severity === 'error' ? '❌' : '⚠️';
    console.error(`${prefix} ${issue.detail}`);
  }
  const identityBlocked = readiness.issues.some((issue) => (
    issue.code === 'mention_identity_unavailable'
    || issue.code === 'mention_identity_ambiguous'
    || issue.code === 'mention_identity_mismatch'
  ));
  if (identityBlocked) {
    console.error('派活已停止：无法构造有效的机器人 @。请重新运行 goal start 核验群成员，不能用 --skip-readiness-check 绕过。');
    process.exit(1);
  }
  if (!readiness.ok && !skipReadinessCheck) {
    console.error('派活前检查未通过。请先把执行者加入目标群或升级对端；确认要绕过时使用 --skip-readiness-check。');
    process.exit(1);
  }
  if (!readiness.ok && skipReadinessCheck) {
    console.error('⚠️ 已按 --skip-readiness-check 继续派活；接收端仍会执行协议校验。');
  }
  bots = bots.map((bot, index) => ({ ...bot, openId: mentionResolution.workers[index]!.openId }));
  built = buildDispatchMessages({
    title: title.trim() || '子项目',
    brief,
    bots,
    repoRequirement: needsRepo && taskId ? { taskId, repo: needsRepo } : undefined,
  });
  try {
    mergeBotOpenIdCrossRef(resolveDataDir(), appId, mentionResolution.matches.flatMap((match, index) => {
      if (!match.memberName || !isMentionableBotOpenId(match.openId)) return [];
      const names = new Set([match.memberName, workerNames[index]].map((name) => name?.trim()).filter(Boolean));
      return [...names].map((name) => ({ name: name!, openId: match.openId }));
    }));
  } catch (err: any) {
    console.error(`⚠️ 已解析执行者身份，但本地身份缓存写入失败：${err?.message ?? err}`);
  }
  try {
    // --into: append into an existing thread (activate standby bots / coordinate).
    if (intoRoot) {
      const sentAtMs = Date.now();
      const kickoffId = await replyMessage(appId, intoRoot, built.kickoffText, 'text', true);
      const acceptance = parsedBotApps.length > 0
        ? await waitForExactDispatchAcceptance({
            targetAppIds: parsedBotApps.map(item => item.appId),
            chatId: targetChatId,
            threadRootId: intoRoot,
            turnId: kickoffId,
            sentAtMs,
          })
        : undefined;
      const accepted = !acceptance || acceptance.missingBotAppIds.length === 0;
      const acceptanceState: DispatchAcceptanceState = !acceptance
        ? 'not_requested'
        : accepted ? 'accepted' : 'timed_out';
      const lifecycleStatus: DispatchLifecycleStatus = !acceptance
        ? 'dispatched'
        : accepted ? 'accepted' : 'timed_out';
      const errorCode = !acceptance || accepted ? null : 'ACCEPTANCE_TIMEOUT';
      const receiptState = await persistDispatchLifecycle({
        dispatchRoot: intoRoot,
        sourceSessionId: sid,
        status: lifecycleStatus,
        transportState: 'dispatched',
        acceptanceState,
        errorCode,
        acceptedBotAppIds: acceptance?.acceptedBotAppIds,
        missingBotAppIds: acceptance?.missingBotAppIds,
      });
      console.log(JSON.stringify({
        success: accepted, taskSent: true, mode: 'into', sourceSessionId: sid,
        targetAppIds: parsedBotApps.map(item => item.appId),
        ...receiptState, threadRootId: intoRoot,
        kickoffMessageId: kickoffId, chatId: targetChatId, bots: built.mentionedOpenIds,
        collaborationReady: parsedBotApps.length > 0,
        ...(acceptance ? {
          accepted,
          acceptedBotAppIds: acceptance.acceptedBotAppIds,
          missingBotAppIds: acceptance.missingBotAppIds,
        } : {}),
        readiness: { ok: readiness.ok, issues: readiness.issues },
      }));
      if (!accepted) process.exitCode = 1;
      return;
    }

    // Default chat-scope mode posts directly into the goal group. Explicit
    // --new-topic asks the owning daemon to create the seed and persist the
    // HMAC-bound report target as one trusted host-side action.
    let seedId: string | undefined;
    let primeId: string | undefined;
    let kickoffId: string | undefined;
    if (newTopic) {
      const registration = await postCurrentSessionDaemonRoute({
        path: DISPATCH_REPORT_REGISTER_ROUTE,
        sessionId: sid,
        larkAppId: s.larkAppId,
        body: {
          seedText: built.seedText,
          targetChatId,
          targetAppIds: parsedBotApps.map(item => item.appId),
          acceptanceRequested: !standby && parsedBotApps.length > 0,
          title: title.trim(),
          bots: built.mentionedOpenIds,
        },
      });
      const registrationBody: any = await registration.json().catch(() => ({}));
      if (!registration.ok || registrationBody?.ok !== true) {
        throw new Error(
          `dispatch report binding registration failed: ${registrationBody?.error ?? `HTTP ${registration.status}`}`,
        );
      }
      seedId = registrationBody?.dispatchRoot;
      if (typeof seedId !== 'string' || !seedId) {
        throw new Error('dispatch report binding registration did not return a seed id');
      }
    }

    if (taskId) {
      deliveryLedger.append({
        type: 'TaskDispatched',
        actor: 'orchestrator',
        taskId,
        chatId: targetChatId,
        ts: Date.now(),
        idempotencyKey: `dispatched:${taskId}`,
        payload: {
          taskId,
          title: title.trim(),
          workerTopicRoot: seedId,
          workerOpenIds: built.mentionedOpenIds,
          workerNames,
          workerLarkAppIds: hasWorkerMeta ? workerLarkAppIds : undefined,
          workerCliIds: hasWorkerMeta ? workerCliIds : undefined,
          workerBotUnionIds: hasWorkerBotUnionIds ? workerBotUnionIds : undefined,
          requiredRepo: needsRepo || undefined,
          brief,
          acceptanceHint: acceptanceHint?.trim() || undefined,
          acceptanceCriteria: parsedAcceptance.criteria,
        },
      });
    }
    dispatchRootForLifecycle = seedId;

    // 2. Optional repo prime — a plain TEXT message "@bot /repo <path>" (like a
    //    human types) so each sub-bot spawns idle in that dir (no repo-select
    //    card). Text goes through resolveMentions cleanly; a structured post
    //    drops the /repo arg in the live event. `/repo` is an existing command,
    //    so this needs no change on the receiving bot's daemon.
    if (repo) {
      const prime = buildRepoPrimeText({ path: repo, bots });
      primeId = seedId
        ? await replyMessage(appId, seedId, prime.text, 'text', true)
        : await sendMessage(appId, targetChatId, prime.text, 'text');
    }

    // 3. Brief kickoff — native text mentions work both locally and across
    // deployments. Skipped in --standby (bots wait for a later --into).
    let acceptance: Awaited<ReturnType<typeof waitForExactDispatchAcceptance>> | undefined;
    if (!standby) {
      const kickoffBuilt = buildDispatchMessages({
        title: title.trim() || '子项目',
        brief: seedId ? briefWithCompletionProtocol(seedId) : brief,
        bots,
        repoRequirement: needsRepo && taskId ? { taskId, repo: needsRepo } : undefined,
      });
      const sentAtMs = Date.now();
      kickoffId = seedId
        ? await replyMessage(appId, seedId, kickoffBuilt.kickoffText, 'text', true)
        : await sendMessage(appId, targetChatId, kickoffBuilt.kickoffText, 'text');
      if (parsedBotApps.length > 0 && seedId) {
        acceptance = await waitForExactDispatchAcceptance({
          targetAppIds: parsedBotApps.map(item => item.appId),
          chatId: targetChatId,
          threadRootId: seedId,
          turnId: kickoffId,
          sentAtMs,
        });
      }
    }

    const accepted = !acceptance || acceptance.missingBotAppIds.length === 0;
    const acceptanceState: DispatchAcceptanceState = standby || !acceptance
      ? 'not_requested'
      : accepted ? 'accepted' : 'timed_out';
    const lifecycleStatus: DispatchLifecycleStatus = standby || !acceptance
      ? 'dispatched'
      : accepted ? 'accepted' : 'timed_out';
    const errorCode = !acceptance || accepted ? null : 'ACCEPTANCE_TIMEOUT';
    const receiptState: DispatchReceiptState = seedId
      ? await persistDispatchLifecycle({
          dispatchRoot: seedId,
          sourceSessionId: sid,
          status: lifecycleStatus,
          transportState: 'dispatched',
          acceptanceState,
          errorCode,
          acceptedBotAppIds: acceptance?.acceptedBotAppIds,
          missingBotAppIds: acceptance?.missingBotAppIds,
        })
      : { transportState: 'dispatched', acceptanceState, errorCode };
    console.log(JSON.stringify({
      success: accepted,
      sourceSessionId: sid,
      targetAppIds: parsedBotApps.map(item => item.appId),
      ...receiptState,
      taskSent: !standby,
      mode: standby ? 'standby' : 'dispatch',
      delivery: seedId ? 'thread' : 'chat',
      taskId: taskId ?? null,
      seedMessageId: seedId ?? null,
      threadRootId: seedId ?? null,
      primeMessageId: primeId,
      kickoffMessageId: kickoffId,
      repo: repo ?? null,
      requiredRepo: needsRepo ?? null,
      chatId: targetChatId,
      bots: built.mentionedOpenIds,
      collaborationReady: parsedBotApps.length > 0,
      ...(acceptance ? {
        accepted,
        acceptedBotAppIds: acceptance.acceptedBotAppIds,
        missingBotAppIds: acceptance.missingBotAppIds,
      } : {}),
      readiness: { ok: readiness.ok, issues: readiness.issues },
    }));
    if (!accepted) process.exitCode = 1;
  } catch (err: any) {
    let receiptState: DispatchReceiptState = {
      transportState: 'failed',
      acceptanceState: 'failed',
      errorCode: 'TRANSPORT_FAILED',
    };
    if (dispatchRootForLifecycle) {
      receiptState = await persistDispatchLifecycle({
        dispatchRoot: dispatchRootForLifecycle,
        sourceSessionId: sid,
        status: 'failed',
        transportState: 'failed',
        acceptanceState: 'failed',
        errorCode: 'TRANSPORT_FAILED',
      });
    }
    console.error(JSON.stringify({
      success: false,
      sourceSessionId: sid,
      targetAppIds: parsedBotApps.map(item => item.appId),
      chatId: targetChatId,
      threadRootId: dispatchRootForLifecycle ?? null,
      ...receiptState,
      detail: err?.message ?? String(err),
    }));
    process.exit(1);
  }
}

/**
 * `botmux report` — delivery / progress report, then hand Review/progress/results
 * back to the stable recipient.
 *
 * Two paths:
 * 1) Platform Issue 领取群：session 有活跃 issue binding → enqueue+write `in_review`
 *    (待验收). This is what kickoff means by 「完成后执行 botmux report」.
 * 2) 交接回报：recipient and placement are separate decisions. Registry-backed
 *    multi-topic dispatches keep their exact orchestrator-session route. Ordinary
 *    development handoffs inherit the executing turn's visible position with the
 *    same turn-id gate as `botmux send`, so a later turn cannot reuse a stale
 *    topic anchor.
 */
async function cmdReport(rest: string[]): Promise<void> {
  if (rest.includes('--help') || rest.includes('-h')) {
    console.log(`botmux report — 交付回报（issue 待验收 / 交接 Review·进展·结果并保持自然会话位置）

用法:
  botmux report --content-file <path>
  botmux report --into <om_root> --content-file <path>
  botmux report --top-level "子项目X 完成，产出在 …"
  botmux report --dispatch-root <om_seed> "子项目X 完成，产出在 …"
  botmux report "子项目X 完成，产出在 …" --legacy-dispatch
  botmux report --task <taskId> "完成说明" --artifact <产物路径> [--artifact ...]

说明:
  1) 平台 Issue 领取群：本会话绑定了平台 issue 时，把 issue 推到「待验收」(in_review)。
     kickoff 里「完成后执行 botmux report」指的就是这条路径。
  2) 交接 / 协作回报：接收者与消息落点独立解析——接收者仍是原 Reviewer / orchestrator；
     消息默认依次采用显式 --into / --top-level、dispatch 注册表、legacy dispatch 兼容回退、
     当前轮次位置，最后才回退到会话默认位置。
     当前轮次在群顶层就留在群顶层，在话题里就留在原话题；过期轮次的话题目标会被忽略。
     dispatch 注册表命中时仍回到原主编排会话，并唤醒其已有上下文。
     legacy / 跨机器 dispatch 没有本机注册表时仍回退群顶层，避免在子话题唤醒无上下文会话。

  代码 Review 交接建议明确写出：首次 Review / 复审、MR、本轮改动、验证、风险，
  以及希望 Reviewer 采取的动作。

选项:
  --content-file <path>  从文件读取回报内容
  --into <root_id>       显式发进指定话题（覆盖默认落点）
  --top-level            显式发到当前群顶层（覆盖默认落点）
  --dispatch-root <id>   dispatch 注入的精确 seed；优先且不命中时 fail closed
  --legacy-dispatch      legacy / 跨机器 dispatch 自动注入的兼容标记
  --session-id <id>      指定来源会话（默认自动推断）
  --task <taskId>             被派任务时简报里给你的任务号；带上即走可信交付
  --artifact <path>           产物路径证据（监管者必须读得到），可重复
  --artifact-text <name=内容>  自包含内容证据（测试输出/文件片段/diff），可重复
  --id <reportId>             显式提交 ID（崩溃重试严格幂等；默认按内容派生）`);
    return;
  }

  process.env.SESSION_DATA_DIR ??= resolveDataDir();
  const sessionIdArg = argValue(rest, '--session-id');
  if (flagPresentButValueMissing(rest, '--into')) {
    console.error('--into 需要一个 om_ 话题根消息 id。');
    process.exit(1);
  }
  const explicitInto = argValue(rest, '--into')?.trim();
  if (explicitInto && !/^om_[A-Za-z0-9_-]{1,128}$/.test(explicitInto)) {
    console.error('--into 必须是有效的 om_ 话题根消息 id。');
    process.exit(1);
  }
  const explicitTopLevel = rest.includes('--top-level');
  const legacyDispatch = rest.includes('--legacy-dispatch');
  if (explicitInto && explicitTopLevel) {
    console.error('--into 与 --top-level 不能同时使用。');
    process.exit(1);
  }
  if (flagPresentButValueMissing(rest, '--dispatch-root')) {
    console.error('--dispatch-root 需要一个 om_ 消息 id。');
    process.exit(1);
  }
  const explicitDispatchRoot = argValue(rest, '--dispatch-root')?.trim();
  if (explicitDispatchRoot && !/^om_[A-Za-z0-9_-]{1,128}$/.test(explicitDispatchRoot)) {
    console.error('--dispatch-root 必须是有效的 om_ 消息 id。');
    process.exit(1);
  }

  let content = '';
  const contentFile = argValue(rest, '--content-file');
  if (contentFile) {
    if (!existsSync(contentFile)) { console.error(`文件不存在: ${contentFile}`); process.exit(1); }
    content = readFileSync(contentFile, 'utf-8');
  } else {
    const pos = positionals(rest, ['--top-level', '--legacy-dispatch']);
    content = pos.length ? pos.join(' ') : await readStdin();
  }
  content = stripTrailingOaiMemoryCitation(content);
  if (!contentFile) rejectLikelyWindowsStdinMojibake(content);
  if (!content.trim()) {
    console.error('没有提交内容。用法: botmux report "子项目X 完成 + 产出位置"');
    process.exit(1);
  }

  // The process-tree marker carries the executing turn. Do not revive the
  // spawn-time BOTMUX_TURN_ID here: it is stale in a long-lived or detached
  // CLI and could make an old topic target look current.
  const reportContext = resolveSessionContext(
    resolveDataDir(),
    process.env.BOTMUX_SESSION_ID,
  );
  const sid = sessionIdArg ?? reportContext?.sessionId;
  if (!sid) {
    console.error('无法推断 session-id。请在当前 Botmux 会话（issue 领取群 / 被 dispatch 派活的会话）里运行，或传 --session-id <id>。');
    process.exit(1);
  }
  const currentTurnId = reportContext?.sessionId === sid
    ? reportContext.turnId
    : undefined;
  const sessions = loadSessions();
  const s = sessions.get(sid);
  if (!s) { console.error(`未找到 session ${sid}`); process.exit(1); }
  if (!s.larkAppId) { console.error(`session ${sid} 缺少 larkAppId`); process.exit(1); }

  // ── Issue Board 交付：绑定了平台 issue 的领取群 → 推 in_review（待验收）────────
  // 优先于 dispatch 路径：领取群没有 creatorOpenId，走 dispatch 会硬失败。
  // 显式 --dispatch-root 时仍走协作回报（避免 issue 群里误 dispatch 被静默改道）。
  if (!explicitDispatchRoot) {
    try {
      const dataDir = resolveDataDir();
      const { findActiveBindingForSession, reportIssueInReview } = await import('./services/issue-report.js');
      const binding = findActiveBindingForSession(dataDir, {
        chatId: s.chatId,
        rootMessageId: s.rootMessageId,
      });
      if (binding) {
        const { writeIssueStatus, findIssueById } = await import('./platform/issue-client.js');
        const result = await reportIssueInReview(
          {
            dataDir,
            writeStatus: (issueId, args) => writeIssueStatus(issueId, args) as any,
            fetchIssue: (teamId, issueId) => findIssueById(teamId, issueId),
          },
          binding.anchorId,
        );
        if (!result.ok) {
          if (result.reason === 'platform') {
            console.error(
              result.permanent
                ? `issue 交付失败（${result.detail}）。平台明确拒绝，重试不会好转——去平台看看这条任务还在不在、领取有没有被收回。`
                : `issue 交付失败（${result.detail}）。可稍后重试同一 botmux report。`,
            );
          } else if (result.reason === 'detached') {
            // 重试没有意义：平台上这条 claim 已经不是本机的了。
            console.error(
              `issue 交付失败：平台上这个任务的领取已不属于本机（被回收、租约过期或已被别人领走），`
              + `交付没有落地。去平台看看任务 ${binding.issueId} 的状态。`,
            );
          } else {
            console.error(`issue 交付失败：${result.reason}`);
          }
          process.exit(1);
        }
        // 交付说明必须发回群里：平台的 /status 只收状态、不收正文（没有 note 字段），
        // 这段文字在平台上无处可放。不发的话验收的人只看到状态变成「待验收」，完全不知道
        // 交付了什么，而 stdout 只有 agent 自己看得到。
        let delivered = false;
        try {
          const { registerBot, loadBotConfigs } = await import('./bot-registry.js');
          await registerSelfFromCredFile();
          try { for (const cfg of loadBotConfigs()) registerBot(cfg); } catch { /* 已注册/读不到 */ }
          const { buildIssueDeliveryCard } = await import('./im/lark/issue-card.js');
          const { issueDetailUrl } = await import('./services/issue-claim-flow.js');
          const { sendMessage: larkSend } = await import('./im/lark/client.js');
          const url = issueDetailUrl(binding.platformBaseUrl, result.issueId);
          await larkSend(
            s.larkAppId!,
            binding.chatId ?? binding.anchorId,
            buildIssueDeliveryCard({
              issueId: result.issueId,
              report: content,
              alreadyInReview: result.alreadyInReview,
              ...(url ? { issueUrl: url } : {}),
            }),
            'interactive',
          );
          delivered = true;
        } catch (e: any) {
          // 状态已经写成功了，播报失败不该让整条命令失败——但要如实说出来，
          // 否则 agent 以为交付说明已经送达。
          console.error(`交付说明未能发回群里（状态已是待验收）：${e?.message ?? e}`);
        }
        console.log(JSON.stringify({
          success: true,
          delivery: 'issue-in-review',
          issueId: result.issueId,
          anchorId: binding.anchorId,
          alreadyInReview: result.alreadyInReview,
          reportPostedToChat: delivered,
          reportPreview: content.trim().slice(0, 200),
        }));
        return;
      }
    } catch (err: any) {
      console.error(`issue 交付异常: ${err?.message ?? err}`);
      process.exit(1);
    }
  }

  // Recipient and visible placement are independent. creatorOpenId remains the
  // stable Reviewer/orchestrator identity; current-turn routing controls where
  // an ordinary report appears.
  const reportRecipient = resolveReportRecipient({
    creatorOpenId: s.creatorOpenId,
    ownerOpenId: s.ownerOpenId,
    quoteTargetSenderOpenId: s.quoteTargetSenderOpenId,
  });
  const turnReplyTarget = pickTurnReplyTarget(s, currentTurnId);
  const validatedTurnReplyTarget = currentTurnId
    && turnReplyTarget?.turnId === currentTurnId
    ? turnReplyTarget
    : undefined;

  // Build the verified-delivery event and wire envelope together, but append
  // only after the daemon relay or Lark API accepts the report. This prevents
  // a failed send from leaving a misleading local TaskReported event.
  const taskId = argValue(rest, '--task');
  let pendingLedger: {
    handle: ReturnType<typeof openLedger>;
    draft: ReturnType<typeof buildReport>['draft'];
    reportId: string;
  } | undefined;
  let deliveryEnvelope: string | undefined;
  if (taskId) {
    const artifacts = argValues(rest, '--artifact');
    const inline = parseArtifactText(argValues(rest, '--artifact-text'));
    if (artifacts.length === 0 && inline.length === 0) {
      console.error(
        'verified report 需要至少一项证据:\n' +
        '  --artifact <path>            主 agent 读得到的产物路径\n' +
        '  --artifact-text <name=内容>   自包含内容(测试输出/文件片段/diff)');
      process.exit(1);
    }
    try {
      const handle = openLedger();
      const { draft, reportId } = buildReport({
        taskId,
        summary: content.trim(),
        ts: Date.now(),
        chatId: s.chatId,
        reportId: argValue(rest, '--id'),
        artifacts,
        inline,
      }, handle);
      pendingLedger = { handle, draft, reportId };
      const evidence: EnvelopeEvidence[] = [
        ...artifacts.map((path): EnvelopeEvidence => ({ kind: 'path', path })),
        ...inline.map((item): EnvelopeEvidence => ({ kind: 'inline', name: item.name, text: item.content })),
      ];
      deliveryEnvelope = formatReportEnvelope({
        taskId,
        reportId,
        summary: content.trim(),
        evidence,
      });
    } catch (err: any) {
      console.error(`ledger 写入失败: ${err.message}`);
      process.exit(1);
    }
  }

  const hasExplicitPlacement = !!explicitInto || explicitTopLevel;
  const dispatchRootCandidate = explicitDispatchRoot
    ?? ((s.scope ?? 'thread') === 'chat'
      ? validatedTurnReplyTarget?.rootMessageId
      : s.rootMessageId?.startsWith('om_') ? s.rootMessageId : undefined);

  // Resolve the registry and its target only inside the source daemon. Full fs
  // isolation may hide the registry entirely, while credential-only bwrap used
  // to let the CLI rewrite it. The daemon verifies the host-signed binding and
  // exact live-turn route before forwarding. A 404 for an implicit candidate
  // means this is an ordinary report and falls through to normal placement;
  // an explicit root, invalid signature, or any other failure stays fail-closed.
  if (!hasExplicitPlacement && dispatchRootCandidate) {
    let response: Response;
    try {
      response = await postCurrentSessionDaemonRoute({
        path: REPORT_SESSION_RELAY_ROUTE,
        sessionId: sid,
        larkAppId: s.larkAppId,
        body: { dispatchRoot: dispatchRootCandidate, content },
      });
    } catch (err: any) {
      console.error(`无法完成主编排会话回注: ${err?.message ?? err}`);
      process.exit(1);
    }
    const triggerBody: any = await response.json().catch(() => ({}));
    if (response.status === 404
      && triggerBody?.error === 'dispatch_target_unavailable'
      && !explicitDispatchRoot) {
      // Ordinary topic/chat turn, not a registered dispatch.
    } else if (!response.ok || triggerBody?.ok !== true) {
      console.error(`主编排会话回注失败: ${triggerBody?.error ?? `HTTP ${response.status}`}`);
      process.exit(1);
    } else {
      const target = triggerBody.reportTarget;
      let reportedLedger: { reportId: string; deduped: boolean } | undefined;
      if (pendingLedger) {
        try {
          const appended = pendingLedger.handle.append(pendingLedger.draft);
          reportedLedger = { reportId: pendingLedger.reportId, deduped: appended.deduped };
        } catch (err: any) {
          console.error(JSON.stringify({
            success: false,
            delivered: true,
            localRecorded: false,
            retryable: true,
            task: taskId,
            reportId: pendingLedger.reportId,
            error: err.message,
          }));
          process.exit(1);
        }
      }
      console.log(JSON.stringify({
        success: true,
        delivery: 'orchestrator-session',
        reportedTo: target?.sessionId,
        viaRegistry: true,
        recipient: {
          kind: 'orchestrator-session',
          botAppId: target?.larkAppId,
          sessionId: target?.sessionId,
          ...(reportRecipient ? { openId: reportRecipient } : {}),
        },
        placementSource: 'dispatch-registry',
        messageTarget: {
          mode: 'orchestrator-session',
          sessionId: target?.sessionId,
          botAppId: target?.larkAppId,
        },
        triggerId: triggerBody.triggerId,
        ...(reportedLedger
          ? { task: taskId, reportId: reportedLedger.reportId, ledgerDeduped: reportedLedger.deduped }
          : {}),
      }));
      return;
    }
  }

  if (!reportRecipient) {
    console.error(
      '找不到 Review / 回报接收者：本会话没有 creatorOpenId、ownerOpenId 或可用的历史发送者。\n' +
      '未写入交付记录。若确需交接，请改用 `botmux send --mention <open_id:名字>` 明确指定接收者。');
    process.exit(1);
  }
  const placement = resolveReportPlacement({
    into: explicitInto,
    topLevel: explicitTopLevel,
    registryTarget: undefined,
    legacyDispatch,
    chatScope: (s.scope ?? 'thread') === 'chat',
    chatId: s.chatId,
    rootMessageId: s.rootMessageId,
    replyTargetRootId: validatedTurnReplyTarget?.rootMessageId,
    replyTargetTurnId: validatedTurnReplyTarget?.turnId,
    replyTargetQuoteOnly: validatedTurnReplyTarget?.quoteOnly,
    currentTurnId,
  });

  const { registerBot, loadBotConfigs } = await import('./bot-registry.js');
  try { for (const cfg of loadBotConfigs()) registerBot(cfg); } catch { /* */ }
  if (envPinnedRiffBot) { try { registerBot(envPinnedRiffBot); } catch { /* */ } }
  const { sendMessage, replyMessage } = await import('./im/lark/client.js');
  const appId = s.larkAppId!;

  const paras = buildReportContent({
    orchOpenId: reportRecipient,
    content,
    deliveryEnvelope,
  });
  const postJson = JSON.stringify({ zh_cn: { title: '', content: paras } });

  let msgId: string;
  try {
    if (placement.target.mode === 'plain') {
      msgId = await sendMessage(appId, placement.target.chatId, postJson, 'post');
    } else {
      msgId = await replyMessage(
        appId,
        placement.target.rootMessageId,
        postJson,
        'post',
        placement.target.mode === 'thread',
      );
    }
  } catch (err: any) {
    if (pendingLedger) {
      console.error(JSON.stringify({
        success: false,
        delivered: false,
        localRecorded: false,
        retryable: true,
        task: taskId,
        reportId: pendingLedger.reportId,
        error: err.message,
      }));
    } else {
      console.error(`report 失败: ${err.message}`);
    }
    process.exit(1);
  }

  let reportedLedger: { reportId: string; deduped: boolean } | undefined;
  if (pendingLedger) {
    try {
      const res = pendingLedger.handle.append(pendingLedger.draft);
      reportedLedger = { reportId: pendingLedger.reportId, deduped: res.deduped };
    } catch (err: any) {
      console.error(JSON.stringify({
        success: false,
        delivered: true,
        localRecorded: false,
        retryable: true,
        messageId: msgId,
        task: taskId,
        reportId: pendingLedger.reportId,
        error: err.message,
      }));
      process.exit(1);
    }
  }

  const messageTarget = placement.target.mode === 'plain'
    ? { mode: 'top-level', chatId: placement.target.chatId }
    : { mode: placement.target.mode, rootMessageId: placement.target.rootMessageId };
  console.log(JSON.stringify({
    success: true,
    delivery: 'lark-message',
    reportedTo: placement.target.mode === 'plain'
      ? placement.target.chatId
      : placement.target.rootMessageId,
    orchestrator: reportRecipient,
    recipient: { kind: 'mention', openId: reportRecipient },
    viaRegistry: false,
    placementSource: placement.source,
    messageTarget,
    messageId: msgId,
    ...(reportedLedger ? { task: taskId, reportId: reportedLedger.reportId, ledgerDeduped: reportedLedger.deduped } : {}),
  }));
}

// ─── Verified delivery help (worker hand-raise) ─────────────────────────────

const VERIFIED_DELIVERY_HELP_KINDS = new Set<HelpKind>(['access', 'ambiguous', 'impossible', 'repeated_failure', 'other']);

async function cmdHelp(rest: string[]): Promise<void> {
  if (rest.includes('--help') || rest.includes('-h')) {
    console.log(`botmux help — 工人显式求助，写入可信交付账本并唤醒 goal 监管者

用法:
  botmux help --task <taskId> --blocker "卡在哪" [--kind access|ambiguous|impossible|repeated_failure|other]

说明:
  这不是完成回报，也不会把任务判失败。它把任务置为 blocked，
  由 L2 监管者先自救；只有监管者也定不了时才 delivery escalate 升级给人。`);
    return;
  }

  process.env.SESSION_DATA_DIR ??= resolveDataDir();
  const taskId = argValue(rest, '--task');
  const blocker = argValue(rest, '--blocker');
  if (!taskId) { console.error('botmux help 需要 --task <taskId>'); process.exit(1); }
  if (!blocker?.trim()) { console.error('botmux help 需要 --blocker "卡在哪"'); process.exit(1); }

  const rawKind = argValue(rest, '--kind');
  const kind = rawKind ? rawKind.trim() as HelpKind : undefined;
  if (kind && !VERIFIED_DELIVERY_HELP_KINDS.has(kind)) {
    console.error('botmux help: --kind 必须是 access / ambiguous / impossible / repeated_failure / other');
    process.exit(1);
  }

  const sessionIdArg = argValue(rest, '--session-id');
  const sid = sessionIdArg ?? findAncestorSessionId();
  const sessions = loadSessions();
  const s = sid ? sessions.get(sid) : undefined;
  const ledger = openLedger();
  const task = ledger.task(taskId);
  if (!task) {
    console.error(`未找到任务: ${taskId}`);
    process.exit(1);
  }
  const goalChatId = task.chatId ?? s?.chatId;
  if (!goalChatId) {
    console.error(`任务 ${taskId} 缺少 goal chatId，无法唤醒监管者。`);
    process.exit(1);
  }

  const workerOpenId = argValue(rest, '--worker-open-id') ??
    task.workerOpenIds?.[0] ??
    s?.creatorOpenId ??
    s?.ownerOpenId ??
    s?.quoteTargetSenderOpenId;
  const blockerText = blocker.trim();
  const keyHash = createHash('sha256').update(`${taskId}\n${kind ?? ''}\n${blockerText}`).digest('hex').slice(0, 10);
  const result = ledger.append({
    type: 'TaskHelpRequested',
    actor: 'worker',
    taskId,
    chatId: goalChatId,
    ts: Date.now(),
    idempotencyKey: `help:${taskId}:${keyHash}`,
    payload: {
      taskId,
      workerOpenId: workerOpenId?.trim() || undefined,
      blocker: blockerText,
      kind,
    },
  });

  const watchdog = await triggerGoalWatchdogFromCli(goalChatId, `help:${taskId}`, sid ?? undefined, s?.larkAppId);
  let envelopeMessageId: string | undefined;
  if (s?.larkAppId) {
    try {
      const { registerBot, loadBotConfigs } = await import('./bot-registry.js');
      try { for (const cfg of loadBotConfigs()) registerBot(cfg); } catch { /* */ }
      const { sendMessage } = await import('./im/lark/client.js');
      const regPath = join(resolveDataDir(), 'orchestrate-dispatch.json');
      let reg: Record<string, any> = {};
      try { if (existsSync(regPath)) reg = JSON.parse(readFileSync(regPath, 'utf-8')); } catch { /* */ }
      const entry = s.rootMessageId ? reg[s.rootMessageId] : undefined;
      const tgt = resolveReportTarget({
        registryEntry: entry,
        sessionChatId: s.chatId,
        creatorOpenId: s.creatorOpenId,
        ownerOpenId: s.ownerOpenId,
        quoteTargetSenderOpenId: s.quoteTargetSenderOpenId,
      });
      const helpEnvelope = formatHelpEnvelope({ taskId, blocker: blockerText, helpKind: kind });
      const supervisorOpenId = tgt.orchOpenId?.trim();
      envelopeMessageId = await sendMessage(
        s.larkAppId,
        goalChatId,
        supervisorOpenId
          ? buildReportText({ orchOpenId: supervisorOpenId, content: helpEnvelope })
          : helpEnvelope,
        'text',
      );
    } catch (err) {
      console.error(`⚠️ 已写入 help 账本，但 goal 群求助信封发送失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (!result.deduped && s?.larkAppId) {
    await emitDeliveryNarrationFromCli({
      larkAppId: s.larkAppId,
      goalChatId,
      event: {
        type: 'help',
        key: `narr:help:${taskId}:${result.event.eventId}`,
        taskId,
        detail: blockerText,
      },
    });
  }
  console.log(JSON.stringify({
    success: true,
    taskId,
    blocked: true,
    deduped: result.deduped,
    goalChatId,
    envelopeMessageId,
    watchdog,
  }, null, 2));
}

async function emitDeliveryNarrationFromCli(input: Parameters<typeof emitGoalNarration>[0]): Promise<void> {
  try {
    const { registerBot, loadBotConfigs } = await import('./bot-registry.js');
    for (const cfg of loadBotConfigs()) registerBot(cfg);
    await emitGoalNarration(input);
  } catch (err) {
    console.error(`⚠️ 已写入账本，但 goal 群播报失败：${err instanceof Error ? err.message : String(err)}`);
  }
}

// ─── Verified delivery accept/reject (orchestrator-as-judge) ────────────────

async function cmdDelivery(sub: string, rest: string[]): Promise<void> {
  if (!sub || sub === '--help' || sub === '-h' || rest.includes('--help') || rest.includes('-h')) {
    console.log(`botmux delivery — 可信交付账本的主 agent 验收/打回

用法:
  查看任务:
    botmux delivery show --task <taskId>
  列出任务:
    botmux delivery list [--goal <chatId>] [--status planned|dispatched|reported|accepted|rejected|blocked|escalated|cancelled] [--older-than 2h]
  验收通过:
    botmux delivery accept --task <taskId> [--report <reportId>] \\
        [--checked-by <id>] [--note <text>] [--evidence-checked <ref>]... [--ran-command <cmd>]...
  打回重做:
    botmux delivery reject --task <taskId> [--report <reportId>] --reason <code> \\
        [--retry-brief <text>] [--expected-evidence <text>] [--checked-by <id>] [--no-push]
  升级给人:
    botmux delivery escalate --task <taskId> --reason <text> \\
        [--retry-brief <text>] [--by <id>] [--session-id <L2会话id>] [--no-notify-parent] \\
        [--options "a=方案A,b=方案B"] [--recommended a]
  取消任务:
    botmux delivery cancel --task <taskId> --reason <text> [--by <id>]
  处理自动派发的不确定结果:
    botmux delivery release-confirm --task <taskId> [--by <id>] [--session-id <监管者会话id>]
    botmux delivery release-retry --task <taskId> [--by <id>] [--session-id <监管者会话id>]

说明:
  --report 省略时默认使用该任务 latestReportId。
  --goal 按 goal 群 chatId 过滤；--older-than 按任务最后一条账本事件时间计算。
  常用 reason: ${Object.values(REJECT_REASON).join(' / ')}
  reject 默认会把 retryBrief/expectedEvidence 回推到派活 worker 话题；--no-push 仅写账本。`);
    return;
  }

  process.env.SESSION_DATA_DIR ??= resolveDataDir();
  const ledger = openLedger();
  if (sub === 'list') {
    const goal = argValue(rest, '--goal', '--chat-id');
    const status = argValue(rest, '--status');
    const validStatuses = new Set<TaskStatus>(['planned', 'dispatched', 'reported', 'accepted', 'rejected', 'blocked', 'escalated', 'cancelled']);
    if (status && !validStatuses.has(status as TaskStatus)) {
      console.error('delivery list: --status 必须是 planned / dispatched / reported / accepted / rejected / blocked / escalated / cancelled');
      process.exit(1);
    }
    const taskStatus = status as TaskStatus | undefined;
    const olderThanRaw = argValue(rest, '--older-than');
    let olderThanMs: number | undefined;
    if (olderThanRaw) {
      try {
        olderThanMs = parseDeliveryDuration(olderThanRaw);
      } catch (err: any) {
        console.error(`delivery list: ${err.message}`);
        process.exit(1);
      }
    }
    const rows = buildDeliveryListRows({
      events: ledger.read(),
      tasks: ledger.tasks(goal),
      status: taskStatus,
      olderThanMs,
    });
    console.log(JSON.stringify({
      success: true,
      goal,
      status,
      olderThan: olderThanRaw,
      count: rows.length,
      tasks: rows,
    }, null, 2));
    return;
  }

  const taskId = argValue(rest, '--task');
  if (!taskId) {
    console.error('缺少 --task <taskId>');
    process.exit(1);
  }

  const task = ledger.task(taskId);
  if (!task) {
    console.error(`未找到任务: ${taskId}`);
    process.exit(1);
  }
  if (sub === 'show') {
    console.log(JSON.stringify({ success: true, task }, null, 2));
    return;
  }

  if (
    sub !== 'accept' && sub !== 'reject' && sub !== 'escalate' && sub !== 'cancel' &&
    sub !== 'release-confirm' && sub !== 'release-retry'
  ) {
    console.error(`delivery: 未知子命令 ${sub}`);
    process.exit(1);
  }

  const sessionIdArg = argValue(rest, '--session-id');
  const sid = sessionIdArg ?? findAncestorSessionId();
  const sessions = loadSessions();
  const s = sid ? sessions.get(sid) : undefined;
  const checkedBy = argValue(rest, '--checked-by') ?? s?.larkAppId ?? s?.ownerOpenId ?? 'orchestrator';

  if (sub === 'release-confirm' || sub === 'release-retry') {
    if (!sid || !s?.larkAppId) {
      console.error(`${sub} 必须在该目标的在线监管者会话中运行，或传 --session-id。`);
      process.exit(1);
    }
    const by = argValue(rest, '--by')?.trim() || s.ownerOpenId?.trim() || s.larkAppId;
    try {
      const result = await requestGoalReleaseActionFromCli({
        taskId,
        action: sub === 'release-confirm' ? 'confirm' : 'retry',
        by,
        sessionId: sid,
        larkAppId: s.larkAppId,
      });
      console.log(JSON.stringify({ success: true, taskId, action: sub, result }, null, 2));
      return;
    } catch (err) {
      console.error(`${sub} 失败：${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  }

  if (sub === 'cancel') {
    const reason = argValue(rest, '--reason')?.trim();
    if (!reason) {
      console.error('delivery cancel 需要 --reason <取消原因>');
      process.exit(1);
    }
    if (task.status === 'accepted') {
      console.error(`任务 ${taskId} 已验收，不能取消。`);
      process.exit(1);
    }
    const by = argValue(rest, '--by')?.trim() || checkedBy;
    const pendingReports = task.reports.filter((report) => !report.verdict).length;
    const activationEventId = task.activationEventId ?? 'unknown';
    const result = ledger.append({
      type: 'TaskCancelled',
      actor: 'orchestrator',
      taskId,
      chatId: task.chatId,
      ts: Date.now(),
      // One cancellation per activation: ordinary tasks bind to their latest
      // dispatch; dependency-gated tasks bind to their latest plan generation.
      idempotencyKey: `cancelled:${taskId}:${activationEventId}`,
      payload: { taskId, reason, by },
    });
    if (!result.deduped && s?.larkAppId) {
      await emitDeliveryNarrationFromCli({
        larkAppId: s.larkAppId,
        goalChatId: task.chatId,
        event: {
          type: 'cancelled',
          key: `narr:cancelled:${taskId}:${result.event.eventId}`,
          taskId,
          title: task.title,
          reason,
          by,
          pendingReports: pendingReports || undefined,
        },
      });
    }
    console.log(JSON.stringify({
      success: true,
      taskId,
      cancelled: true,
      deduped: result.deduped,
      pendingReports,
    }, null, 2));
    return;
  }

  if (sub === 'escalate') {
    if (task.status === 'cancelled') {
      console.error(`任务 ${taskId} 已取消；如需继续，请先重新派发。`);
      process.exit(1);
    }
    const reason = argValue(rest, '--reason')?.trim();
    if (!reason) {
      console.error('delivery escalate 需要 --reason <为什么需要人拍>');
      process.exit(1);
    }
    const retryBrief = argValue(rest, '--retry-brief')?.trim();
    const by = argValue(rest, '--by')?.trim() || checkedBy;
    const decisionOptions = parseGoalDecisionOptionsOrExit(rest, 'delivery escalate');
    const result = ledger.append({
      type: 'TaskEscalated',
      actor: 'orchestrator',
      taskId,
      chatId: task.chatId,
      ts: Date.now(),
      idempotencyKey: `escalated:${taskId}`,
      payload: {
        taskId,
        reason,
        by,
        retryBrief: retryBrief || undefined,
      },
    });
    if (!result.deduped && s?.larkAppId) {
      await emitDeliveryNarrationFromCli({
        larkAppId: s.larkAppId,
        goalChatId: task.chatId,
        event: {
          type: 'escalated',
          key: `narr:escalated:${taskId}:${result.event.eventId}`,
          taskId,
          reason,
        },
      });
    }

    let parentNotified: boolean | undefined;
    let attentionRaised: boolean | undefined;
    let notifyError: string | undefined;
    if (!argFlag(rest, '--no-notify-parent')) {
      try {
        if (!s?.larkAppId) throw new Error('无法推断当前 L2 session/larkAppId；可传 --session-id 或 --no-notify-parent。');
        if (!sid) throw new Error('无法推断当前 L2 session；可传 --session-id 或 --no-notify-parent。');
        const daemon = findDaemon(s.larkAppId);
        if (!daemon) throw new Error(`未找到在线 daemon (larkAppId=${s.larkAppId})`);
        const summary = [
          `Goal 任务需要人工决策: ${taskId}`,
          `原因: ${reason}`,
          retryBrief ? `建议/待确认: ${retryBrief}` : undefined,
          task.chatId ? `goal: ${task.chatId}` : undefined,
        ].filter(Boolean).join('\n');
        const res = await postSessionScopedDaemonIpc(
          daemon.ipcPort,
          sid,
          '/api/goal/notify-parent',
          {
            supervisorSessionId: sid,
            goalChatId: task.chatId,
            taskId,
            summary,
            attentionKind: 'help',
            attentionReason: reason,
            decisionOptions,
          },
        );
        const body = await res.json().catch(() => null) as { ok?: boolean; error?: string; attentionRaised?: boolean } | null;
        if (!res.ok || !body?.ok) throw new Error(body?.error ?? `daemon HTTP ${res.status}`);
        parentNotified = true;
        attentionRaised = !!body.attentionRaised;
      } catch (err) {
        parentNotified = false;
        attentionRaised = false;
        notifyError = err instanceof Error ? err.message : String(err);
        console.error(`⚠️ 已写入 escalated 账本，但通知 L1/点亮看板失败：${notifyError}`);
      }
    }

    console.log(JSON.stringify({
      success: true,
      taskId,
      escalated: true,
      deduped: result.deduped,
      parentNotified,
      attentionRaised,
      notifyError,
    }, null, 2));
    return;
  }

  if (task.status === 'cancelled') {
    console.error(`任务 ${taskId} 已取消；如需继续，请先重新派发。`);
    process.exit(1);
  }

  const reportId = argValue(rest, '--report') ?? task.latestReportId;
  if (!reportId) {
    console.error(`任务 ${taskId} 还没有 report，无法 ${sub}`);
    process.exit(1);
  }
  const report = task.reports.find((r) => r.reportId === reportId);
  if (!report) {
    console.error(`任务 ${taskId} 找不到 report: ${reportId}`);
    process.exit(1);
  }

  if (sub === 'accept') {
    const note = argValue(rest, '--note');
    const evidenceChecked = argValues(rest, '--evidence-checked');
    const ranCommands = argValues(rest, '--ran-command');
    const result = ledger.append({
      type: 'TaskAccepted',
      actor: 'orchestrator',
      taskId,
      chatId: task.chatId,
      ts: Date.now(),
      idempotencyKey: `accepted:${taskId}:${reportId}`,
      payload: {
        taskId,
        reportId,
        checkedBy,
        note: note?.trim() || undefined,
        evidenceChecked: evidenceChecked.length ? evidenceChecked : undefined,
        ranCommands: ranCommands.length ? ranCommands : undefined,
      },
    });
    if (!result.deduped && s?.larkAppId) {
      const mode = note && /代办|supervisor/i.test(note)
        ? '监管者代办'
        : '监管者验收';
      await emitDeliveryNarrationFromCli({
        larkAppId: s.larkAppId,
        goalChatId: task.chatId,
        event: {
          type: 'accepted',
          key: `narr:accepted:${taskId}:${result.event.eventId}`,
          taskId,
          title: task.title,
          mode,
        },
      });
    }
    const hasPlannedDependent = !result.deduped && !!task.chatId && ledger.tasks(task.chatId).some((candidate) =>
      candidate.status === 'planned' && candidate.plan?.dependsOnTaskIds.includes(taskId));
    const releaseCheckTriggered = hasPlannedDependent && task.chatId
      ? await triggerGoalReleaseCheckFromCli(task.chatId, sid ?? undefined, s?.larkAppId)
      : false;
    console.log(JSON.stringify({
      success: true,
      taskId,
      reportId,
      accepted: true,
      deduped: result.deduped,
      releaseCheckTriggered,
    }));
    return;
  }

  const reason = argValue(rest, '--reason') as RejectReason | undefined;
  if (!reason) {
    console.error(`缺少 --reason <code>。常用: ${Object.values(REJECT_REASON).join(' / ')}`);
    process.exit(1);
  }
  const retryBrief = argValue(rest, '--retry-brief');
  const expectedEvidence = argValue(rest, '--expected-evidence');
  const result = ledger.append({
    type: 'TaskRejected',
    actor: 'orchestrator',
    taskId,
    chatId: task.chatId,
    ts: Date.now(),
    idempotencyKey: `rejected:${taskId}:${reportId}`,
    payload: {
      taskId,
      reportId,
      checkedBy,
      reason,
      retryBrief: retryBrief?.trim() || undefined,
      expectedEvidence: expectedEvidence?.trim() || undefined,
    },
  });
  if (!result.deduped && s?.larkAppId) {
    await emitDeliveryNarrationFromCli({
      larkAppId: s.larkAppId,
      goalChatId: task.chatId,
      event: {
        type: 'rejected',
        key: `narr:rejected:${taskId}:${result.event.eventId}`,
        taskId,
        reason,
      },
    });
  }

  let retryMessageId: string | undefined;
  if (!argFlag(rest, '--no-push')) {
    if (!task.workerTopicRoot && !task.chatId) {
      console.error(`任务 ${taskId} 没有 workerTopicRoot/chatId，已写入 rejected 账本，但无法回推重做要求。`);
      console.log(JSON.stringify({ success: true, taskId, reportId, rejected: true, deduped: result.deduped, pushed: false }));
      return;
    }
    if (!s?.larkAppId) {
      console.error(`无法推断当前主 agent session/larkAppId，已写入 rejected 账本，但无法回推。可在 Lark 会话内运行或传 --no-push。`);
      console.log(JSON.stringify({ success: true, taskId, reportId, rejected: true, deduped: result.deduped, pushed: false }));
      return;
    }
    const { registerBot, loadBotConfigs } = await import('./bot-registry.js');
    try { for (const cfg of loadBotConfigs()) registerBot(cfg); } catch { /* */ }
    const { replyMessage, sendMessage } = await import('./im/lark/client.js');
    const content = buildRejectRetryContent({ task, reportId, reason, retryBrief, expectedEvidence });
    const postJson = JSON.stringify({ zh_cn: { title: '', content } });
    retryMessageId = task.workerTopicRoot
      ? await replyMessage(s.larkAppId, task.workerTopicRoot, postJson, 'post', true)
      : await sendMessage(s.larkAppId, task.chatId!, postJson, 'post');
  }
  console.log(JSON.stringify({
    success: true,
    taskId,
    reportId,
    rejected: true,
    deduped: result.deduped,
    pushed: !!retryMessageId,
    retryMessageId,
  }));
}

interface GoalSuperviseCliRequest {
  larkAppId: string;
  chatId: string;
  parentChatId: string;
  parentRoot?: string;
  title: string;
  brief?: string;
  workingDir?: string;
  parentSessionId?: string;
}

async function requestGoalSupervisor(input: GoalSuperviseCliRequest): Promise<any> {
  const daemon = findDaemon(input.larkAppId);
  if (!daemon) throw new Error(`未找到在线监管者 daemon (larkAppId=${input.larkAppId})`);

  let res: Response;
  try {
    res = input.parentSessionId
      ? await postSessionScopedDaemonIpc(
          daemon.ipcPort,
          input.parentSessionId,
          '/api/goal/supervise',
          input as unknown as Record<string, unknown>,
        )
      : await fetchDaemonIpc(daemon.ipcPort, '/api/goal/supervise', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(input),
        });
  } catch (err: any) {
    throw new Error(`无法连接监管者 daemon (port=${daemon.ipcPort}): ${err?.message ?? err}`);
  }
  let body: any = {};
  try { body = await res.json(); } catch { /* */ }
  if (!res.ok || !body?.ok) throw new Error(body?.error ?? res.statusText);
  return body;
}

async function cmdGoalStart(rest: string[]): Promise<void> {
  process.env.SESSION_DATA_DIR ??= resolveDataDir();
  const title = argValue(rest, '--title')?.trim() ?? '';
  const workerRefs = argValues(rest, '--worker');
  const teamRef = argValue(rest, '--team');
  const supervisorRef = argValue(rest, '--supervisor');
  const existingChatId = argValue(rest, '--chat-id')?.trim();
  const groupName = argValue(rest, '--group-name', '--name')?.trim();
  const projectArg = argValue(rest, '--project')?.trim();
  const workingDirArg = argValue(rest, '--working-dir')?.trim();
  const sessionIdArg = argValue(rest, '--session-id');
  const briefFile = argValue(rest, '--brief-file');
  const skipReadinessCheck = rest.includes('--skip-readiness-check');
  let brief = argValue(rest, '--brief') ?? '';
  if (briefFile) {
    if (!existsSync(briefFile)) { console.error(`文件不存在: ${briefFile}`); process.exit(1); }
    brief = readFileSync(briefFile, 'utf-8');
  }
  if (!title) { console.error('goal start 需要 --title <目标标题>'); process.exit(1); }
  if (workerRefs.length === 0) { console.error('goal start 至少需要一个 --worker <执行者>'); process.exit(1); }

  const sid = sessionIdArg ?? findAncestorSessionId();
  if (!sid) {
    console.error('无法推断主控会话。请在主控 CLI 会话里运行，或传 --session-id <id>。');
    process.exit(1);
  }
  const parent = loadSessions().get(sid);
  if (!parent?.larkAppId) {
    console.error(`主控会话 ${sid} 不存在或缺少 larkAppId。`);
    process.exit(1);
  }
  if (!parent.chatId) {
    console.error(`主控会话 ${sid} 缺少 chatId。`);
    process.exit(1);
  }

  const dataDir = resolveDataDir();
  const { registerBot, loadBotConfigs } = await import('./bot-registry.js');
  const fullConfigs = loadBotConfigs();
  type BotInfoEntry = { larkAppId: string; botOpenId: string | null; botName: string | null; cliId: string };
  let botInfoEntries: BotInfoEntry[] = [];
  try {
    const path = join(dataDir, 'bots-info.json');
    if (existsSync(path)) botInfoEntries = JSON.parse(readFileSync(path, 'utf-8'));
  } catch { /* best effort */ }
  const infoByAppId = new Map(botInfoEntries.map((entry) => [entry.larkAppId, entry]));
  const localAppIds = new Set(fullConfigs.map((config) => config.larkAppId));
  const localBots: GoalStartBot[] = fullConfigs.map((config) => ({
    larkAppId: config.larkAppId,
    cliId: config.cliId,
    name: infoByAppId.get(config.larkAppId)?.botName?.trim() || config.cliId || config.larkAppId,
    openId: infoByAppId.get(config.larkAppId)?.botOpenId?.trim() || undefined,
    local: true,
  }));

  const { listPlatformTeams, isPlatformHallChat } = await import('./services/platform-team-store.js');
  const teams: GoalStartTeam[] = listPlatformTeams(dataDir).map((team) => ({
    teamId: team.teamId,
    teamName: team.teamName,
    memberUnionIds: team.memberUnionIds,
    bots: team.bots.map((bot) => ({
      larkAppId: bot.appId,
      name: bot.name?.trim() || infoByAppId.get(bot.appId)?.botName?.trim() || bot.appId,
      cliId: infoByAppId.get(bot.appId)?.cliId,
      openId: infoByAppId.get(bot.appId)?.botOpenId?.trim() || undefined,
      unionId: bot.unionId,
      botmuxVersion: bot.botmuxVersion,
      a2aCapabilities: bot.a2aCapabilities,
      local: localAppIds.has(bot.appId),
    })),
  }));

  const selectionResult = resolveGoalStartSelection({
    parentLarkAppId: parent.larkAppId,
    supervisorRef,
    workerRefs,
    teamRef,
    localBots,
    teams,
  });
  if (!selectionResult.ok) {
    console.error(`goal start 配置无效：${selectionResult.error}`);
    if (teams.length > 0) console.error(`可用平台团队：${teams.map((team) => `${team.teamName} (${team.teamId})`).join('；')}`);
    console.error(`本机可选监管者：${localBots.map((bot) => `${bot.name} (${bot.larkAppId})`).join('；')}`);
    process.exit(1);
  }
  const selection = selectionResult.value;
  const hasRemoteWorker = selection.workers.some((worker) => !worker.local);
  for (const warning of selectionResult.warnings) console.error(`⚠️ ${warning}`);
  if (!findDaemon(selection.supervisor.larkAppId)) {
    console.error(`监管者 ${selection.supervisor.name} 的 daemon 不在线。`);
    process.exit(1);
  }
  const supervisorConfig = fullConfigs.find((config) => config.larkAppId === selection.supervisor.larkAppId);
  if (!supervisorConfig) {
    console.error(`监管者 ${selection.supervisor.name} 没有本机配置。`);
    process.exit(1);
  }
  registerBot(supervisorConfig);

  if (projectArg && workingDirArg) {
    console.error('--project 和 --working-dir 不要同时传；--project 已能接受本地目录或 Git remote。');
    process.exit(1);
  }
  let localWorkingDir: string | undefined;
  let requiredRepo: string | undefined;
  if (projectArg) {
    const dir = validateWorkingDir(projectArg);
    if (dir.ok) {
      localWorkingDir = dir.resolvedPath;
      const inspected = inspectLocalRepo(localWorkingDir);
      if (inspected.ok) {
        localWorkingDir = inspected.path;
        requiredRepo = inspected.remoteIdentity;
      } else if (hasRemoteWorker) {
        console.error(`本地项目没有可供远端机器识别的 origin：${inspected.detail}。请配置 origin，或把 --project 改为 Git remote。`);
        process.exit(1);
      }
    } else {
      const remote = normalizeRepoRemote(projectArg);
      if (!remote) {
        console.error(`--project 既不是可用本地目录，也不是可识别的 Git remote：${projectArg}`);
        process.exit(1);
      }
      requiredRepo = remote;
    }
  } else if (workingDirArg) {
    const dir = validateWorkingDir(workingDirArg);
    if (!dir.ok) { console.error(`--working-dir ${dir.error}`); process.exit(1); }
    localWorkingDir = dir.resolvedPath;
    const inspected = inspectLocalRepo(localWorkingDir);
    if (inspected.ok) {
      localWorkingDir = inspected.path;
      requiredRepo = inspected.remoteIdentity;
    } else if (hasRemoteWorker) {
      console.error(`--working-dir 指向的项目没有可供远端机器识别的 origin：${inspected.detail}。请配置 origin，或改用 --project <Git remote>。`);
      process.exit(1);
    }
  } else if (parent.workingDir) {
    const dir = validateWorkingDir(parent.workingDir);
    if (dir.ok) {
      localWorkingDir = dir.resolvedPath;
      const inspected = inspectLocalRepo(localWorkingDir);
      if (inspected.ok) {
        localWorkingDir = inspected.path;
        requiredRepo = inspected.remoteIdentity;
      }
    }
  }
  const retryProject = projectArg ?? workingDirArg;
  if (hasRemoteWorker && !requiredRepo && !projectArg && !workingDirArg) {
    console.error('⚠️ 当前目标包含远端执行者，但没有项目仓库要求。如果这是代码任务，请传 --project <本地目录|Git remote>；非代码任务可继续。');
  }

  let chatId = existingChatId;
  let groupCreated = false;
  let groupResult: any;
  if (chatId && isPlatformHallChat(dataDir, chatId)) {
    console.error('平台机器人大厅不能作为目标群。请新建目标群，或传另一个真实协作群的 --chat-id。');
    process.exit(1);
  }

  if (!chatId) {
    const { getDeploymentIdentity } = await import('./services/deployment-identity.js');
    const invitee = resolveGoalStartInvitee({
      lastCallerOpenId: parent.lastCallerOpenId,
      ownerOpenId: parent.ownerOpenId,
      ownerUnionId: parent.ownerUnionId,
      deploymentOwnerUnionId: getDeploymentIdentity(dataDir).ownerUnionId,
      callerIsBot: parent.quoteTargetSenderIsBot,
    });
    let callerOpenId = invitee.openId;
    const callerUnionId = invitee.unionId;
    if (!callerOpenId && !callerUnionId) {
      const { resolveAllowedUsers } = await import('./im/lark/client.js');
      try {
        callerOpenId = (await resolveAllowedUsers(selection.supervisor.larkAppId, supervisorConfig.allowedUsers ?? []))[0];
      } catch { /* handled by the identity check below */ }
    }
    if (!callerOpenId && !callerUnionId) {
      console.error('无法识别目标发起人，未创建目标群。请从飞书主控会话重试，或先配置 deployment owner。');
      process.exit(1);
    }
    const { createGroupWithBots } = await import('./services/group-creator.js');
    try {
      groupResult = await createGroupWithBots({
        creatorLarkAppId: selection.supervisor.larkAppId,
        larkAppIds: [selection.supervisor.larkAppId, ...selection.workers.map((worker) => worker.larkAppId)],
        name: groupName || title,
        userOpenIds: callerOpenId ? [callerOpenId] : [],
        ownerUnionIds: callerUnionId ? [callerUnionId] : [],
        transferOwnerTo: callerOpenId,
        notifyOwnerOpenId: callerOpenId,
      });
    } catch (err: any) {
      console.error(`目标群创建失败：${err?.message ?? err}`);
      process.exit(1);
    }
    chatId = groupResult.chatId;
    groupCreated = true;
    const callerInvited = Boolean(
      (callerOpenId && !groupResult.invalidUserIds.includes(callerOpenId))
      || (callerUnionId && !groupResult.invalidOwnerUnionIds.includes(callerUnionId)),
    );
    if (groupResult.invalidBotIds.length > 0 || !callerInvited) {
      const retryCommand = buildGoalStartRetryCommand({
        chatId: chatId!, title, teamId: selection.team?.teamId, workers: selection.workers,
        project: retryProject, brief, sessionId: sid, skipReadinessCheck,
      });
      if (groupResult.invalidBotIds.length > 0) {
        console.error(`目标群已创建，但这些执行者未能入群：${groupResult.invalidBotIds.join(', ')}`);
      }
      if (!callerInvited) console.error('目标群已创建，但发起人未能入群。');
      console.error(`群已保留，补齐成员后续跑：${retryCommand}`);
      console.log(JSON.stringify({
        success: false,
        stage: 'group_members',
        chatId,
        shareLink: groupResult.shareLink,
        invalidBotIds: groupResult.invalidBotIds,
        invalidUserIds: groupResult.invalidUserIds,
        invalidOwnerUnionIds: groupResult.invalidOwnerUnionIds,
        retryCommand,
      }, null, 2));
      process.exitCode = 1;
      return;
    }
  }

  const { probeChatBotMembership } = await import('./im/lark/client.js');
  const goalBots = [selection.supervisor, ...selection.workers];
  const knownGoalBotOpenIds = readBotOpenIdCrossRefRecord(dataDir, selection.supervisor.larkAppId);
  const knownGoalBotOpenIdByName = new Map(
    Object.entries(knownGoalBotOpenIds).map(([name, openId]) => [name.trim().toLowerCase(), openId]),
  );
  const goalReadinessWorkers = goalBots.map((bot) => ({
    // app_id is stable identity metadata, not a mention handle. The roster
    // probe below must resolve every row into this supervisor app's ou_* scope.
    openId: knownGoalBotOpenIdByName.get(bot.name.trim().toLowerCase())
      ?? (bot.larkAppId === selection.supervisor.larkAppId ? bot.openId : undefined)
      ?? bot.larkAppId,
    name: bot.name,
    larkAppId: bot.larkAppId,
    cliId: bot.cliId,
    unionId: bot.unionId,
    local: bot.local,
  }));
  let membership;
  let mentionResolution;
  const probeAttempts = groupCreated ? 4 : 1;
  for (let attempt = 0; attempt < probeAttempts; attempt++) {
    try {
      membership = await probeChatBotMembership(selection.supervisor.larkAppId, chatId!);
    } catch (err: any) {
      membership = { known: false as const, members: [] as [], reason: err?.message ?? String(err) };
    }
    mentionResolution = resolveDispatchMentionIdentities({
      workers: goalReadinessWorkers,
      membership,
      peers: selection.team?.bots,
    });
    if (mentionResolution.issues.length === 0 || attempt === probeAttempts - 1) break;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
  }
  const readiness = evaluateDispatchReadiness({
    workers: goalReadinessWorkers,
    membership: membership!,
    peers: selection.team?.bots,
  });
  for (const issue of readiness.issues) console.error(`${issue.severity === 'error' ? '❌' : '⚠️'} ${issue.detail}`);
  const identityBlocked = readiness.issues.some((issue) => (
    issue.code === 'mention_identity_unavailable'
    || issue.code === 'mention_identity_ambiguous'
    || issue.code === 'mention_identity_mismatch'
  ));
  if (identityBlocked || (!readiness.ok && !skipReadinessCheck)) {
    const retryCommand = buildGoalStartRetryCommand({
      chatId: chatId!, title, teamId: selection.team?.teamId, workers: selection.workers,
      project: retryProject, brief, sessionId: sid, skipReadinessCheck,
    });
    console.error(identityBlocked
      ? '目标群里无法解析出可用的机器人 @ 身份，未启动监管者；这个错误不能跳过。'
      : '目标群成员不完整，未启动监管者。请先把缺少的机器人加入群；确认要绕过时使用 --skip-readiness-check。');
    if (groupCreated) {
      console.error(`群已保留，身份同步后续跑：${retryCommand}`);
      console.log(JSON.stringify({
        success: false,
        stage: 'group_readiness',
        chatId,
        shareLink: groupResult?.shareLink,
        readiness,
        retryCommand,
      }, null, 2));
      process.exitCode = 1;
      return;
    }
    process.exit(1);
  }
  if (!readiness.ok && skipReadinessCheck) {
    console.error('⚠️ 已按 --skip-readiness-check 继续启动；后续派活和接收端仍会独立校验。');
  }
  try {
    mergeBotOpenIdCrossRef(dataDir, selection.supervisor.larkAppId, mentionResolution!.matches.flatMap((match, index) => {
      if (!match.memberName || !isMentionableBotOpenId(match.openId)) return [];
      return [
        { name: goalBots[index]!.name, openId: match.openId },
        { name: match.memberName, openId: match.openId },
      ];
    }));
  } catch (err: any) {
    console.error(`⚠️ 群成员已核验，但本地身份缓存写入失败：${err?.message ?? err}`);
  }
  const effectiveBrief = buildGoalStartBrief({
    brief,
    teamName: selection.team?.teamName,
    supervisorName: selection.supervisor.name,
    workers: selection.workers.map((worker, index) => ({
      name: worker.name,
      larkAppId: worker.larkAppId,
      mentionOpenId: mentionResolution!.workers[index + 1]!.openId,
      local: worker.local,
    })),
    localWorkingDir,
    requiredRepo,
  });

  if (selection.team) {
    const { recordTeamGroup } = await import('./services/team-groups-store.js');
    recordTeamGroup(dataDir, selection.team.teamId, chatId!);
  }

  let supervised: any;
  try {
    supervised = await requestGoalSupervisor({
      larkAppId: selection.supervisor.larkAppId,
      chatId: chatId!,
      parentChatId: parent.chatId,
      parentRoot: parent.rootMessageId,
      title,
      brief: effectiveBrief,
      workingDir: localWorkingDir,
      parentSessionId: sid,
    });
  } catch (err: any) {
    const retryCommand = buildGoalStartRetryCommand({
      chatId: chatId!, title, teamId: selection.team?.teamId, workers: selection.workers,
      project: retryProject, brief, sessionId: sid, skipReadinessCheck,
    });
    console.error(`${groupCreated ? '目标群已创建，但' : ''}监管者启动失败：${err?.message ?? err}`);
    console.error(`群不会删除。修复后续跑：${retryCommand}`);
    console.log(JSON.stringify({ success: false, stage: 'supervise', chatId, shareLink: groupResult?.shareLink, retryCommand }, null, 2));
    process.exitCode = 1;
    return;
  }

  const link = groupResult?.shareLink ?? chatAppLink(chatId!, botBrand(supervisorConfig));
  console.error(`✅ 目标已启动：${title}`);
  console.error(`✅ 目标群：${link}`);
  console.error(`✅ 监管者：${selection.supervisor.name}；执行者：${selection.workers.map((worker) => worker.name).join('、')}`);
  console.log(JSON.stringify({
    success: true,
    createdGroup: groupCreated,
    chatId,
    chatLink: link,
    team: selection.team ? { id: selection.team.teamId, name: selection.team.teamName } : undefined,
    supervisor: { name: selection.supervisor.name, larkAppId: selection.supervisor.larkAppId, sessionId: supervised.sessionId ?? supervised.supervisorSessionId },
    workers: selection.workers.map((worker) => ({ name: worker.name, larkAppId: worker.larkAppId, local: worker.local })),
    project: { workingDir: localWorkingDir, repo: requiredRepo },
  }, null, 2));
}

async function cmdGoal(sub: string, rest: string[]): Promise<void> {
  if (!sub || sub === '--help' || sub === '-h' || rest.includes('--help') || rest.includes('-h')) {
    console.log(`botmux goal — goal 群监管会话工具

用法:
  botmux goal start --title <目标标题> --worker <执行者> [--worker ...] \\
      [--team <平台团队名称|id>] [--supervisor <本机监管者>] \\
      [--chat-id <已有目标群> | --group-name <新群名>] \\
      [--project <本地目录|Git remote>] [--brief <text> | --brief-file <path>] \\
      [--skip-readiness-check] [--session-id <主控会话id>]
  botmux goal supervise --chat-id <goal群chatId> --title <goal标题> \\
      [--parent-chat-id <主群chatId>] [--parent-root <主话题rootMessageId>] \\
      [--brief <text> | --brief-file <path>] [--working-dir <path>] [--session-id <L1会话id>]
  botmux goal notify-parent (--summary <text> | --summary-file <path>) [--session-id <L2会话id>] [--goal <goal群chatId>] [--task <taskId>] [--attention[=help]] [--done] [--options "a=方案A,b=方案B"] [--recommended a]
  botmux goal charter current --goal <goal群chatId> [--create] [--title <标题>]
  botmux goal charter read --goal <goal群chatId> [--json]
  botmux goal charter update --goal <goal群chatId> --expected-updated-at <ts> <完整内容>
  botmux goal charter path --goal <goal群chatId>

说明:
  goal start 是推荐入口：解析平台团队和执行者，创建或核验真实目标群，并立即启动监管者。
  当前监管者必须是主控会话所属的本机在线 bot；这是为了保证完成/求助能可靠回报主控。
  daemon-native 地在 goal 群起一个 chat-scope L2 supervisor 会话，绕开 Lark 自消息不会路由的限制。
  默认从当前 L1 会话推断 parent-chat-id / parent-root / working-dir / bot daemon。
  goal charter 复用 whiteboard 存储/CAS，但不受全局 whiteboard enable 开关控制，也不会自动注入任何会话。`);
    return;
  }
  if (sub === 'charter') {
    await cmdGoalCharter(rest[0] ?? 'current', rest.slice(1));
    return;
  }
  if (sub === 'notify-parent') {
    await cmdGoalNotifyParent(rest);
    return;
  }
  if (sub === 'start') {
    await cmdGoalStart(rest);
    return;
  }
  if (sub !== 'supervise') {
    console.error('未知 goal 子命令。用法见 botmux goal --help');
    process.exit(1);
  }

  process.env.SESSION_DATA_DIR ??= resolveDataDir();
  const chatId = argValue(rest, '--chat-id');
  const title = argValue(rest, '--title') ?? '';
  const sessionIdArg = argValue(rest, '--session-id');
  const parentChatIdArg = argValue(rest, '--parent-chat-id');
  const parentRootArg = argValue(rest, '--parent-root');
  const workingDir = argValue(rest, '--working-dir');
  const briefFile = argValue(rest, '--brief-file');
  let brief = argValue(rest, '--brief') ?? '';
  if (briefFile) {
    if (!existsSync(briefFile)) { console.error(`文件不存在: ${briefFile}`); process.exit(1); }
    brief = readFileSync(briefFile, 'utf-8');
  }

  if (!chatId) { console.error('goal supervise 需要 --chat-id <goal群chatId>'); process.exit(1); }
  if (!title.trim()) { console.error('goal supervise 需要 --title <goal标题>'); process.exit(1); }

  const sid = sessionIdArg ?? findAncestorSessionId();
  let parentChatId = parentChatIdArg;
  let parentRoot = parentRootArg;
  let larkAppId: string | undefined;
  if (sid) {
    const sessions = loadSessions();
    const s = sessions.get(sid);
    if (s) {
      larkAppId = s.larkAppId;
      parentChatId ??= s.chatId;
      parentRoot ??= s.rootMessageId;
    }
  }
  if (!larkAppId) {
    console.error('无法推断 L1 会话所属 bot。请在 L1 CLI 会话里运行，或传 --session-id <id>。');
    process.exit(1);
  }
  if (!parentChatId) {
    console.error('无法推断 parent-chat-id，请传 --parent-chat-id <主群chatId>。');
    process.exit(1);
  }

  try {
    const body = await requestGoalSupervisor({
      larkAppId,
      chatId,
      parentChatId,
      parentRoot,
      title: title.trim(),
      brief,
      workingDir,
      parentSessionId: sid ?? undefined,
    });
    console.log(JSON.stringify({ success: true, ...body }, null, 2));
  } catch (err: any) {
    console.error(`goal supervise 失败: ${err?.message ?? err}`);
    process.exit(1);
  }
}

async function cmdGoalNotifyParent(rest: string[]): Promise<void> {
  process.env.SESSION_DATA_DIR ??= resolveDataDir();
  const sessionIdArg = argValue(rest, '--session-id');
  const goalArg = argValue(rest, '--goal');
  const taskId = argValue(rest, '--task');
  const done = argFlag(rest, '--done') || argFlag(rest, '--complete');
  const summaryFile = argValue(rest, '--summary-file');
  const attention = parseAttentionFlag(rest);
  const decisionOptions = parseGoalDecisionOptionsOrExit(rest, 'goal notify-parent');
  let summary = argValue(rest, '--summary') ?? '';
  if (summaryFile) {
    if (!existsSync(summaryFile)) { console.error(`文件不存在: ${summaryFile}`); process.exit(1); }
    summary = readFileSync(summaryFile, 'utf-8');
  }
  if (!summary.trim()) {
    console.error('goal notify-parent 需要 --summary <text> 或 --summary-file <path>');
    process.exit(1);
  }

  const sid = sessionIdArg ?? findAncestorSessionId();
  if (!sid) {
    console.error('无法推断 L2 会话。请在 L2 CLI 会话里运行，或传 --session-id <id>。');
    process.exit(1);
  }
  const sessions = loadSessions();
  const supervisor = sessions.get(sid);
  if (!supervisor) {
    console.error(`未找到会话: ${sid}`);
    process.exit(1);
  }
  const larkAppId = supervisor.larkAppId;
  if (!larkAppId) {
    console.error('无法推断 L2 会话所属 bot。');
    process.exit(1);
  }
  const goalChatId = goalArg ?? supervisor.goalSupervisor?.goalChatId ?? supervisor.chatId;
  const daemon = findDaemon(larkAppId);
  if (!daemon) {
    console.error(`未找到在线 daemon (larkAppId=${larkAppId})。`);
    process.exit(1);
  }

  let res: Response;
  try {
    res = await postSessionScopedDaemonIpc(
      daemon.ipcPort,
      sid,
      '/api/goal/notify-parent',
      {
        supervisorSessionId: sid,
        goalChatId,
        taskId,
        summary: summary.trim(),
        attentionKind: attention.requested ? attention.kind : undefined,
        attentionReason: attention.requested ? summary.trim() : undefined,
        decisionOptions,
        done,
      },
    );
  } catch (err: any) {
    console.error(`无法连接 daemon (port=${daemon.ipcPort}): ${err?.message ?? err}`);
    process.exit(1);
  }
  let body: any = {};
  try { body = await res.json(); } catch { /* */ }
  if (!res.ok || !body?.ok) {
    console.error(`goal notify-parent 失败: ${body?.error ?? res.statusText}`);
    process.exit(1);
  }
  console.log(JSON.stringify({ success: true, ...body }, null, 2));
}

function goalCharterId(goal: string): string {
  const hash = createHash('sha256').update(goal).digest('hex').slice(0, 16);
  return `goal_${hash}`;
}

function goalCharterTitle(goal: string, title?: string): string {
  return title?.trim() || `Goal charter: ${goal.slice(0, 12)}`;
}

function ensureGoalCharter(goal: string, title?: string) {
  const id = goalCharterId(goal);
  const existing = getWhiteboard(id);
  if (existing && !existing.archived) return existing;
  return createWhiteboard({
    id,
    title: goalCharterTitle(goal, title),
    scope: 'custom',
    chatId: goal,
  }, { allowDisabled: true });
}

async function cmdGoalCharter(action: string, rest: string[]): Promise<void> {
  if (!action || action === '--help' || action === '-h' || rest.includes('--help') || rest.includes('-h')) {
    console.log(`botmux goal charter <command>

Commands:
  current --goal <chatId> [--create] [--title <t>]
      Show the deterministic charter board for a goal group; --create ensures it.
  read --goal <chatId> [--json]
      Read the goal charter board. --json emits { id, updatedAt, content } for CAS.
  update --goal <chatId> --expected-updated-at <ts> <content>
      Replace the goal charter current-state snapshot using CAS.
  path --goal <chatId>
      Print the underlying board/meta/log paths.

This command intentionally bypasses the global whiteboard feature flag and never
attaches the board to a session, so it cannot trigger <whiteboard> prompt injection.`);
    return;
  }

  process.env.SESSION_DATA_DIR ??= resolveDataDir();
  const goal = argValue(rest, '--goal', '--chat-id');
  if (!goal) {
    console.error('goal charter 需要 --goal <goal群chatId>');
    process.exit(1);
  }
  const id = goalCharterId(goal);

  if (action === 'current') {
    let meta = getWhiteboard(id);
    if (!meta && argFlag(rest, '--create')) {
      meta = ensureGoalCharter(goal, argValue(rest, '--title'));
    }
    console.log(JSON.stringify({
      enabled: whiteboardEnabled(),
      goal,
      current: meta ?? null,
      path: meta ? whiteboardPath(id) : undefined,
      hint: meta ? undefined : 'Run `botmux goal charter current --goal <chatId> --create` to ensure the goal charter.',
    }, null, 2));
    return;
  }

  if (action === 'read') {
    const meta = getWhiteboard(id);
    if (!meta) { console.error(`Goal charter not found for ${goal}. Run \`botmux goal charter current --goal ${goal} --create\`.`); process.exit(1); }
    if (argFlag(rest, '--json')) {
      console.log(JSON.stringify({ id: meta.id, updatedAt: meta.updatedAt, content: readWhiteboard(id, { allowDisabled: true }) }));
    } else {
      process.stdout.write(readWhiteboard(id, { allowDisabled: true }));
    }
    return;
  }

  if (action === 'path') {
    const meta = getWhiteboard(id);
    if (!meta) { console.error(`Goal charter not found for ${goal}. Run \`botmux goal charter current --goal ${goal} --create\`.`); process.exit(1); }
    console.log(JSON.stringify({ goal, board: meta, path: whiteboardPath(id) }, null, 2));
    return;
  }

  if (action === 'update' || action === 'write') {
    const meta = getWhiteboard(id) ?? ensureGoalCharter(goal, argValue(rest, '--title'));
    if (action === 'write' && !argFlag(rest, '--yes')) {
      console.error('Refusing to overwrite goal charter without --yes. Prefer `botmux goal charter update` with --expected-updated-at.');
      process.exit(2);
    }
    const content = whiteboardContentFromArgs(rest, [...WHITEBOARD_BOOLEAN_FLAGS, '--yes']);
    if (!content.trim()) {
      console.error('Refusing to write empty goal charter content. Pass text as args, pipe stdin, or use --content-file <path>.');
      process.exit(2);
    }
    const expectedUpdatedAt = argValue(rest, '--expected-updated-at');
    const { writeWhiteboard } = await import('./services/whiteboard-store.js');
    try {
      const updated = writeWhiteboard(meta.id, content, {
        actor: 'goal-charter',
        kind: action === 'update' ? 'goal-charter-update' : 'goal-charter-write',
        expectedUpdatedAt,
        allowDisabled: true,
      });
      console.log(JSON.stringify({ ok: true, goal, board: updated }, null, 2));
    } catch (e) {
      handleWhiteboardWriteError(e, meta.id, { rereadCommand: `botmux goal charter read --goal ${goal} --json` });
    }
    return;
  }

  console.error(`Unknown goal charter command: ${action}`);
  process.exit(1);
}

// ─── Exact chat-grant subcommand ─────────────────────────────────────────────

async function cmdExactChatGrant(rest: string[]): Promise<void> {
  if (rest.includes('--help') || rest.includes('-h')) {
    console.log(`
botmux grant chat — 给目标 Bot 增删/查询精确群对话授权（不授管理命令权）

用法:
  botmux grant chat --bot <receiver-ref> --chat-id <oc_...>
                    --subject-open-id <ou_...> [--subject-open-id <ou_...> ...]
  botmux grant chat --bot <receiver-ref> --chat-id <oc_...>
                    --subject-bot <larkAppId> [--subject-bot <larkAppId> ...]
  botmux grant chat revoke --bot <receiver-ref> --chat-id <oc_...>
                    --subject-open-id <ou_...> [--subject-open-id <ou_...> ...]
  botmux grant chat readback --bot <receiver-ref> --chat-id <oc_...>
                    --subject-open-id <ou_...> [--subject-open-id <ou_...> ...]

说明:
  - receiver-ref 支持完整 larkAppId、Bot 显示名或唯一 cliId；歧义引用会拒绝。
  - --subject-open-id 与 --subject-bot 严格二选一，均可重复传入。
  - --subject-bot 是推荐的稳定 App 身份入口，由 receiver daemon 在自己视角解析 open_id；
    它仅支持 grant，revoke/readback 仍必须显式传 --subject-open-id。
  - grant 只接受 receiver 视角下 Feishu /members/bots 实时返回的群内 Bot open_id；
    接口失败时 fail-closed，不使用 observed/cross-ref 历史回退。
  - revoke 不依赖实时成员查询，Bot 已退群后仍可清理旧授权。
  - readback 只返回显式请求的 subject，不枚举整个授权表。
  - 只写 chatGrant（talk-only）；不改 allowedUsers / allowedChatGroups / team trust，
    不授 /repo、/cd、/restart 等管理命令权。
  - 成功 stdout 输出单行 JSON；失败 stderr 输出错误并返回非零。
`);
    return;
  }

  const { parseExactChatGrantCliArgs } = await import('./cli/exact-chat-grant.js');
  const parsed = parseExactChatGrantCliArgs(rest);
  if (!parsed.ok) {
    console.error(parsed.error);
    process.exit(1);
  }
  const input = parsed.value;
  process.env.SESSION_DATA_DIR ??= resolveDataDir();

  const online = listOnlineDaemons();
  let receiverLarkAppId = online.find(daemon => daemon.larkAppId === input.receiverRef)?.larkAppId;
  if (!receiverLarkAppId) {
    const { loadBotConfigs } = await import('./bot-registry.js');
    let botConfigs: Array<{ larkAppId: string; cliId: string }>;
    try {
      botConfigs = loadBotConfigs().map(cfg => ({ larkAppId: cfg.larkAppId, cliId: cfg.cliId }));
    } catch (err: any) {
      console.error(`加载 bots.json 失败: ${err?.message ?? err}`);
      process.exit(1);
    }

    const botInfoPath = join(resolveDataDir(), 'bots-info.json');
    let botInfo: Array<{ larkAppId: string; botName: string | null }> = [];
    try {
      if (existsSync(botInfoPath)) {
        const raw = JSON.parse(readFileSync(botInfoPath, 'utf8'));
        if (Array.isArray(raw)) botInfo = raw;
      }
    } catch { /* invalid bots-info is equivalent to no display-name hints */ }

    const { resolveBotRefs } = await import('./cli/create-group-resolver.js');
    const resolved = resolveBotRefs([input.receiverRef], botConfigs, botInfo);
    if (resolved.ambiguousWarnings.length > 0) {
      console.error(`--bot 引用有歧义: ${resolved.ambiguousWarnings.join(' ')}`);
      process.exit(1);
    }
    if (resolved.invalid.length > 0 || resolved.larkAppIds.length !== 1) {
      console.error(`无法解析 --bot ${input.receiverRef}`);
      process.exit(1);
    }
    receiverLarkAppId = resolved.larkAppIds[0];
  }

  const daemon = findDaemon(receiverLarkAppId);
  if (!daemon) {
    console.error(`目标 Bot daemon 不在线: ${receiverLarkAppId}`);
    process.exit(1);
  }

  try {
    const body = await requestExactChatGrant({
      daemon,
      secret: requireDashboardSecret(),
      operation: input.operation,
      receiverLarkAppId,
      chatId: input.chatId,
      ...(input.subjectOpenIds.length > 0
        ? { subjectOpenIds: input.subjectOpenIds }
        : { subjectLarkAppIds: input.subjectLarkAppIds }),
    });
    console.log(JSON.stringify(body));
  } catch (err: any) {
    console.error(JSON.stringify(err?.body ?? { ok: false, error: err?.message ?? String(err) }));
    process.exit(1);
  }
}

// ─── Create-group subcommand ─────────────────────────────────────────────────

async function cmdCreateGroup(rest: string[]): Promise<void> {
  if (rest.includes('--help') || rest.includes('-h')) {
    console.log(`
botmux create-group — 用一组机器人新建飞书群

用法:
  botmux create-group --bot <name|larkAppId> [--bot ...] [--name "群名"]
                      [--working-dir <path>]
                      [--kickoff-bot <open_id> --kickoff-prompt "文本"]
                      [--json-status]

参数:
  --bot <ref>     至少一个，可多次。ref 推荐用 bot 显示名（同 botmux send 的 @<name>）或完整 larkAppId；
                  cliId（如 claude-code）仅作 fallback —— 多个 bot 常共用同一个 cliId，重名命中只能取
                  bots.json 中第一个。重名 → 取 bots.json 中第一个匹配，stderr 打 warning。
                  重复 ref → 自动去重保留首次顺序。
  --name <群名>   可选；不传则用飞书默认无名群。
  --working-dir <path>
                 可选；创建成功后，把新群为所有成功入群的 bot 绑定到该目录（等价于逐个 /oncall bind），
                 下次在群里开新话题时直接使用该目录，跳过仓库选择卡片。也可写作 --cwd / --dir。
  --kickoff-bot <open_id>  可选；建群成功后由 creator @ 该 bot 并发送 --kickoff-prompt，
                 触发该 bot 自动开始工作（如 PR review）。需配合 --kickoff-prompt 使用。
                 该 bot 必须已在 --bot 列表中（即已是群成员）。
  --kickoff-prompt "文本"  可选；与 --kickoff-bot 配合使用，@ bot 后发送的 prompt 文本。
  --json-status    可选；在 chatId 后追加一行结构化完成状态。默认 stdout 无论完整成功或
                   部分失败都保持历史兼容，只输出单行 chatId；部分失败仍以非零退出表示。

团队模式（跨机建聚焦新群，走中心化平台）:
  botmux create-group --team <teamId> --agent <appId> [--agent ...] [--name "群名"]

  用途：把「同团队、已 opt-in」的**别人机器上的** agent（用 bots list --scope team 发现到的 appId）
  和它们各自的 owner 一起拉进一个平台代建的聚焦新群，全程 machine-auth。
  正因为发起人在别人 bot 进群前 @不到它，这条只认 appId、不依赖任何飞书 @，天然绕开视角问题。
  --agent 至少一个、可多次、按 appId 去重。团队模式忽略 --bot/--kickoff/--working-dir（那些是本机建群用的）。
  未传 --team：本机唯一团队则自动用它，多个要求显式指定。
  （往**已存在**的团队群补人是独立命令：botmux bots invite --chat <chatId> --team X --agent ...）

行为:
  - 第一个解析到的 bot 作为 creator（决定建群身份 + 初始群主 + open_id app scope）。
  - 邀请用户 / 转让群主 / @通知 对象都从 creator 的 resolvedAllowedUsers 取首个 open_id（email 自动转换；
    转不出来或为空则跳过对应步骤，stderr warning）。
  - 不依赖 botmux 会话，任何环境都能跑。
  - --working-dir 会先校验路径存在且是目录；绑定失败不会重复建群，会在 stderr 给出逐 bot 结果。
  - --kickoff-bot/--kickoff-prompt：creator 建群后 @ 指定 bot 并发 prompt；该 bot 收到 @ 会自动起会话。
    注意：creator 不能 @ 自己（自消息被忽略），故 --kickoff-bot 应选 creator 之外的 bot。

输出协议（skill 友好）:
  - chat.create 成功拿到 chatId 后立即向 stdout 写单行 chatId，不等待后续 bot 邀请、grant、
    群主转让或通知。默认任何已创建结果都只有这一行；--json-status 才追加 JSON。
    collaboration 或显式 kickoff 未完成时 exit 非零。
  - 只有缺 --bot / 解析失败 / chat.create 未成功时 stdout 才为空。只要 stdout 已有 chatId，
    即使超时或 exit 非零也必须先检查并复用该群，不得重建。
`);
    return;
  }

  // Deprecation 闸：--chat 曾经是 create-group 的「往已有群补人」模式，现已拆成独立命令
  // `bots invite`。若仍传 --chat，必须**报错早退**而不是静默忽略——否则用户本意补人、
  // 却因 --chat 被丢弃照常建了个新群（真实副作用，多一个群）。放在 team 分流之前拦。
  if (hasFlagOrEq(rest, '--chat')) {
    console.error('create-group 不再支持 --chat（往已有群补人已拆成独立命令）。请改用：');
    console.error('  botmux bots invite --chat <chatId> --team <id> --agent <appId>...');
    process.exit(1);
  }

  // 团队模式：走平台端点3 建新群，与本机飞书建群是两条完全不同的路径。必须在 transport
  // 闸门之前分流——平台代建群，本机 bot 不需要飞书传输身份（沙盒/apiOnly 也能发起）。
  // 「往已有群补人」是独立的 `bots invite`，不在这里。
  if (hasFlagOrEq(rest, '--team') || hasFlagOrEq(rest, '--agent')) {
    await cmdCreateGroupTeam(rest);
    return;
  }

  // create-group builds a real Feishu group (cross-bot). A no-transport turn
  // (apiOnly bot or HTTP virtual session) may not originate one — central gate.
  assertTurnTransportOrExit('create-group');

  process.env.SESSION_DATA_DIR ??= resolveDataDir();

  const botRefs = argValues(rest, '--bot');
  const name = argValue(rest, '--name');
  const workingDirArg = argValue(rest, '--working-dir', '--cwd', '--dir');
  const kickoffBot = argValue(rest, '--kickoff-bot');
  const kickoffPrompt = argValue(rest, '--kickoff-prompt');
  const jsonStatus = rest.includes('--json-status');

  let bindWorkingDir: string | undefined;
  let bindWorkingDirResolved: string | undefined;
  if (workingDirArg !== undefined) {
    const trimmed = workingDirArg.trim();
    if (!trimmed) {
      console.error('--working-dir 不能为空。');
      process.exit(1);
    }
    const validation = validateWorkingDir(trimmed);
    if (!validation.ok) {
      console.error(`--working-dir ${validation.error}`);
      process.exit(1);
    }
    // Keep the user's spelling in bots.json, matching `/oncall bind`, while
    // still showing the resolved path in CLI output for typo diagnostics.
    bindWorkingDir = trimmed;
    bindWorkingDirResolved = validation.resolvedPath;
  }

  if (botRefs.length === 0) {
    console.error('用法: botmux create-group --bot <name|larkAppId> [--bot ...] [--name "群名"]');
    console.error('至少传一个 --bot。');
    process.exit(1);
  }

  // Load bot configs (bots.json order) and bots-info.json (for botName)
  const { registerBot, loadBotConfigs } = await import('./bot-registry.js');
  let botConfigs: Array<{ larkAppId: string; cliId: string }>;
  try {
    botConfigs = loadBotConfigs().map(c => ({ larkAppId: c.larkAppId, cliId: c.cliId }));
  } catch (err: any) {
    console.error(`加载 bots.json 失败: ${err?.message ?? err}`);
    process.exit(1);
  }
  const dataDir = resolveDataDir();
  const botInfoPath = join(dataDir, 'bots-info.json');
  type BotInfoEntry = { larkAppId: string; botOpenId: string | null; botName: string | null; cliId: string };
  let botInfoEntries: BotInfoEntry[] = [];
  try { if (existsSync(botInfoPath)) botInfoEntries = JSON.parse(readFileSync(botInfoPath, 'utf-8')); } catch { /* */ }

  const {
    resolveBotRefs,
    resolveKickoff,
    createGroupCompletionStatus,
    shouldWriteCreateGroupCompletionStatus,
  } = await import('./cli/create-group-resolver.js');
  const resolved = resolveBotRefs(
    botRefs,
    botConfigs,
    botInfoEntries.map(b => ({ larkAppId: b.larkAppId, botName: b.botName })),
  );

  for (const w of resolved.ambiguousWarnings) console.error(`⚠️  ${w}`);
  if (resolved.invalid.length > 0) {
    console.error(`无法解析的 --bot 引用: ${resolved.invalid.join(', ')}`);
    console.error('可用 bot：');
    for (const cfg of botConfigs) {
      const info = botInfoEntries.find(b => b.larkAppId === cfg.larkAppId);
      console.error(`  - ${info?.botName ?? '(unnamed)'}  cliId=${cfg.cliId}  ${cfg.larkAppId}`);
    }
    process.exit(1);
  }
  if (resolved.larkAppIds.length === 0) {
    console.error('未解析到任何 bot，请检查 --bot 引用。');
    process.exit(1);
  }

  const creatorLarkAppId = resolved.larkAppIds[0];
  const kickoff = resolveKickoff(
    kickoffBot,
    kickoffPrompt,
    resolved.larkAppIds,
    botInfoEntries.map(b => ({ larkAppId: b.larkAppId, botOpenId: b.botOpenId })),
  );
  if (!kickoff.ok) {
    console.error(kickoff.error);
    process.exit(1);
  }

  // Register bots so getBotClient works inside service
  const fullConfigs = loadBotConfigs();
  const needed = new Set(resolved.larkAppIds);
  try {
    for (const cfg of fullConfigs) if (needed.has(cfg.larkAppId)) registerBot(cfg);
  } catch (err: any) {
    console.error(`注册 bot 失败: ${err?.message ?? err}`);
    process.exit(1);
  }

  // Derive user_open_id from creator's allowedUsers (creator app scope only).
  // resolveAllowedUsers converts emails → open_ids via creator's Lark client.
  const creatorCfg = fullConfigs.find(c => c.larkAppId === creatorLarkAppId);
  const allowedRaw = creatorCfg?.allowedUsers ?? [];
  const { resolveAllowedUsers } = await import('./im/lark/client.js');
  let creatorAllowedOpenIds: string[] = [];
  try {
    creatorAllowedOpenIds = await resolveAllowedUsers(creatorLarkAppId, allowedRaw);
  } catch (err: any) {
    console.error(`⚠️  解析 creator allowedUsers 失败: ${err?.message ?? err}（继续创建空群）`);
  }
  const targetOpenId = creatorAllowedOpenIds[0];
  if (!targetOpenId) {
    console.error('⚠️  creator bot 的 allowedUsers 没有可用 open_id — 将创建仅含 bot 的群（跳过邀请/转让/@通知）。');
  }

  const { createGroupWithBots } = await import('./services/group-creator.js');
  let result;
  let createdChatId: string | undefined;
  try {
    result = await createGroupWithBots({
      creatorLarkAppId,
      larkAppIds: resolved.larkAppIds,
      name: name?.trim() || undefined,
      userOpenIds: targetOpenId ? [targetOpenId] : [],
      transferOwnerTo: targetOpenId,
      notifyOwnerOpenId: targetOpenId,
      bindWorkingDir,
      kickoffBotLarkAppId: kickoff.targetLarkAppId,
      kickoffPrompt: kickoff.prompt,
      ensureBotCollaboration: async (chatId, joinedBotAppIds, rejectedBotAppIds) => {
        if (rejectedBotAppIds.length > 0) {
          throw new Error(`bot_invites_incomplete:${rejectedBotAppIds.join(',')}`);
        }
        if (joinedBotAppIds.length >= 2) {
          await ensureLocalBotCollaboration(chatId, joinedBotAppIds);
        }
      },
      onChatCreated: (chatId) => {
        createdChatId = chatId;
        // This is the create side-effect commit point. Flush it before any
        // follow-up invite/grant/transfer work so wrappers can recover the
        // existing group from partial stdout on timeout.
        writeFileSync(1, `${chatId}\n`);
      },
    });
  } catch (err: any) {
    if (createdChatId) {
      console.error(`⚠️  群 ${createdChatId} 已创建，但后续初始化失败: ${err?.message ?? err}；请勿重建，先检查并复用该群。`);
      if (jsonStatus) {
        writeFileSync(1, `${JSON.stringify({
          success: false,
          chatCreated: true,
          chatId: createdChatId,
          collaborationReady: false,
          kickoffAccepted: false,
          error: err?.message ?? String(err),
        })}\n`);
      }
    } else {
      console.error(`建群失败: ${err?.message ?? err}`);
    }
    process.exit(1);
  }

  const invalidBots = new Set(result.invalidBotIds);
  const joinedBotAppIds = [...new Set(resolved.larkAppIds)].filter(appId => !invalidBots.has(appId));
  // createGroupWithBots runs the exact grant preflight after invitations and
  // before any role/kickoff message. Returning here therefore proves the cold
  // group's collaboration boundary completed (or there was only one bot).
  const collaborationReady = true;
  const kickoffRequested = !!kickoff.targetLarkAppId && !!kickoff.prompt;

  // Human-readable summary + warnings → stderr.
  const link = chatAppLink(result.chatId, botBrand(creatorCfg));
  console.error(`✅ 群已创建：${link}`);
  if (collaborationReady) {
    console.error(`✅ Bot 对话授权已就绪（talk-only，${joinedBotAppIds.length} 个 Bot）`);
  }
  if (result.invalidBotIds.length > 0) {
    console.error(`⚠️  飞书拒绝邀请的 bot: ${result.invalidBotIds.join(', ')}`);
  }
  if (result.invalidUserIds.length > 0) {
    console.error(`⚠️  飞书拒绝邀请的 user: ${result.invalidUserIds.join(', ')}`);
  }
  if (result.transferError) {
    console.error(`⚠️  群主转让失败 (${result.transferError}) — 当前群主仍为 creator bot`);
  } else if (result.ownerTransferredTo) {
    console.error(`✅ 群主已转让给 ${result.ownerTransferredTo}`);
  }
  if (result.notifyError) {
    console.error(`⚠️  @通知发送失败: ${result.notifyError}`);
  } else if (result.notifyMessageId) {
    console.error(`✅ @通知已发送 (msg ${result.notifyMessageId})`);
  }
  if (result.kickoffError) {
    console.error(`⚠️  kickoff 消息发送失败: ${result.kickoffError}`);
  } else if (result.kickoffMessageId) {
    console.error(`✅ kickoff 消息已发送 (msg ${result.kickoffMessageId})`);
  }
  if (bindWorkingDir) {
    const ok = result.oncallBindings.filter(b => b.ok).length;
    const failed = result.oncallBindings.filter(b => !b.ok);
    console.error(`✅ oncall 绑定目录：${bindWorkingDir} → ${bindWorkingDirResolved}（成功 ${ok}/${result.oncallBindings.length}）`);
    for (const b of failed) {
      console.error(`⚠️  ${b.larkAppId} 绑定失败: ${b.error ?? 'unknown'}`);
    }
  }
  const completion = createGroupCompletionStatus({
    chatId: result.chatId,
    collaborationReady,
    kickoffRequested,
    kickoffMessageId: result.kickoffMessageId,
    kickoffError: result.kickoffError,
  });
  if (shouldWriteCreateGroupCompletionStatus(completion, jsonStatus)) {
    console.log(JSON.stringify(completion));
  }
  if (!completion.success) process.exitCode = 1;
}

/**
 * `botmux create-group --team <teamId> --agent <appId>...` — 跨机拉群（走中心化平台端点3）。
 *
 * 与本机飞书建群（cmdCreateGroup 主体）是两条不同路径：这里把「同团队、已 opt-in」的、
 * **别人机器上的** agent（appId 从 bots list --scope team 发现而来）+ 各自 owner + 本机 owner
 * 一起拉进一个平台代建的聚焦新群。全程 machine-auth、只认 appId、不依赖任何飞书 @。
 *
 * 硬约束：CLI 零授权判断（团队成员校验 + opt-in 闸 team.bots 全在平台）；平台把未 opt-in /
 * 拉不动的对象放进 invalidBotIds / invalidOwnerUnionIds 原样带回，这里只如实展示、不解释成
 * "失败"（未 opt-in 是对方 owner 没加进团队，不是本次调用错）。
 *
 * 输出协议对齐主命令：成功拿到 chatId → stdout 写单行 chatId（skill 友好）；--json-status
 * 追加一行结构化 JSON（含 shareLink / invalid* / 部分失败标记）。有 invalid* 时 exit 非零，
 * 但 stdout 的 chatId 已经可用（群已建，别重建）。
 */
/**
 * 解析团队维度命令的目标 teamId：显式 --team 优先；否则打端点1，唯一即用、多个要求指定、
 * 零个报错。用于「必须落到一个具体 team」的动作（建群 / 补人）——list 侧的空 team 是正常态、
 * 输出空列表，不走这里。`action` 只用于文案（"拉群"/"补人"）。
 */
async function resolveSingleTeamIdOrExit(
  fetchTeams: typeof import('./platform/team-agents-client.js').fetchTeams,
  describeTeamAgentsFailure: typeof import('./platform/team-agents-client.js').describeTeamAgentsFailure,
  teamArg: string | undefined,
  action: string,
): Promise<string> {
  if (teamArg) return teamArg;
  const teamsRes = await fetchTeams();
  if (!teamsRes.ok) {
    if (teamsRes.reason === 'unbound') console.error(`本机未绑定平台。${action}需要先 botmux bind。`);
    else if (teamsRes.reason === 'not_deployed') console.error('平台尚未部署团队端点，等上线后重试。');
    else console.error(`拉取团队列表失败：${describeTeamAgentsFailure(teamsRes)}`);
    process.exit(1);
  }
  const teams = teamsRes.value;
  if (teams.length === 0) { console.error(`本机未加入任何平台团队，无法${action}。`); process.exit(1); }
  if (teams.length > 1) {
    console.error('本机属于多个平台团队，请用 --team <id> 指定其一：');
    for (const t of teams) console.error(`  ${t.teamId}  ${t.teamName}`);
    process.exit(1);
  }
  return teams[0].teamId;
}

async function cmdCreateGroupTeam(rest: string[]): Promise<void> {
  const { fetchTeams, createTeamGroup, describeTeamAgentsFailure, rateLimitRetryHint } =
    await import('./platform/team-agents-client.js');
  const jsonStatus = rest.includes('--json-status');
  const name = argValue(rest, '--name');
  const appIds = [...new Set(argValues(rest, '--agent').map(s => s.trim()).filter(Boolean))];

  if (appIds.length === 0) {
    console.error('团队模式需要至少一个 --agent <appId>（用 botmux bots list --scope team 发现 appId）。');
    process.exit(1);
  }

  const teamId = await resolveSingleTeamIdOrExit(fetchTeams, describeTeamAgentsFailure, argValue(rest, '--team'), '拉群');

  const res = await createTeamGroup({ teamId, appIds, ...(name !== undefined ? { name } : {}) });
  if (!res.ok) {
    if (res.reason === 'unbound') console.error('本机未绑定平台。拉群需要先 botmux bind。');
    else if (res.reason === 'not_deployed') console.error('平台尚未部署拉群端点（/v1/machine/groups）。等平台上线后重试。');
    else if (res.reason === 'rate_limited') console.error(`拉群被限流，${rateLimitRetryHint(res)}。`);
    else if (res.reason === 'client' && res.status === 403) {
      // 403 not_in_team_bots：所选 agent（或本机 bot）没 opt-in 进团队。平台可能带回具体 appIds。
      const which = res.appIds && res.appIds.length ? `：${res.appIds.join('、')}` : '';
      console.error(`拉群被拒（403 ${res.error}）：请确认相关 bot 已由其 owner 在平台「管理机器人」加入该团队${which}。`);
    } else if (res.reason === 'client' && res.status === 404) {
      console.error(`团队不存在或本机 owner 不是其成员：teamId=${teamId}`);
    } else {
      console.error(`拉群失败：${describeTeamAgentsFailure(res)}`);
    }
    process.exit(1);
  }

  const { chatId, shareLink, invalidBotIds, invalidOwnerUnionIds } = res.value;
  if (!chatId) {
    // 平台回 ok 但没给 chatId：异常，别静默成功。
    console.error(`平台未返回 chatId（ok=${res.value.ok}）。`);
    if (jsonStatus) console.log(JSON.stringify({ ...res.value, ok: false }));
    process.exit(1);
  }

  // stdout 单行 chatId（skill 友好，主命令同款协议）。
  console.log(chatId);
  const hasInvalid = invalidBotIds.length > 0 || invalidOwnerUnionIds.length > 0;
  if (jsonStatus) {
    console.log(JSON.stringify({ ok: true, chatId, shareLink, invalidBotIds, invalidOwnerUnionIds, teamId }));
  }
  // 未 opt-in / 拉不动的对象走 stderr 提示（不污染 stdout 的 chatId 契约）。
  if (invalidBotIds.length > 0) {
    console.error(`⚠️ 以下 agent 未加入团队或拉取失败，未入群：${invalidBotIds.join('、')}`);
  }
  if (invalidOwnerUnionIds.length > 0) {
    console.error(`⚠️ 以下 owner 未能拉入：${invalidOwnerUnionIds.join('、')}`);
  }
  if (shareLink) console.error(`群分享链接：${shareLink}`);
  // 部分失败 → 非零退出（但群已建、chatId 已在 stdout，调用方应复用不重建）。
  if (hasInvalid) process.exitCode = 1;
}

// ─── Bots subcommand ─────────────────────────────────────────────────────────

// ─── botmux ask v0.1.7 ───────────────────────────────────────────────────────
//
// CLI agent inside a botmux-spawned session calls `botmux ask buttons
// --options "..." "<prompt>"`. Daemon sends a Lark card; user clicks; CLI
// process unblocks with the selected key (or exit 124 on timeout, exit 3 if
// the daemon dies). See /tmp/botmux-ask.md (or design memory).

/**
 * postAsk: 找到 daemon → POST /api/asks → 返回 AskResult。
 * 连接失败 / HTTP 错误时抛出带 `exitCode` + `retryable` 属性的 Error：
 *   - exitCode=3：daemon 不可达或 HTTP 错误（保持向后兼容）
 *   - retryable=true：仅当 daemon 不可达 / 网络失败 / 明确的 transient HTTP
 *     (502/503/504，含 daemon 启动尚未就绪) 时。这些正是"daemon 重启中"的信号,
 *     runHook 会重连重试。确定性 4xx（bad body / capability 拒绝 / unsupported)
 *     与非 JSON 是 retryable=false —— 重试 24h 也不会变,应立即 passthrough。
 */
async function postAsk(body: Record<string, unknown>): Promise<import('./core/ask-types.js').AskResult> {
  type AskResult = import('./core/ask-types.js').AskResult;
  type AskError = Error & { exitCode: number; retryable: boolean };
  const mkErr = (message: string, retryable: boolean): AskError =>
    Object.assign(new Error(message), { exitCode: 3, retryable });

  const larkAppId = body.larkAppId as string;
  const daemon = findDaemon(larkAppId);
  if (!daemon) {
    // No daemon record → it's (re)starting or momentarily gone → retryable.
    throw mkErr(`botmux ask: 找不到 daemon (larkAppId=${larkAppId})。daemon 已停？exit 3.`, true);
  }

  let res: Response;
  try {
    const requestBody = { ...body };
    if (typeof requestBody.originCapability !== 'string') {
      const sessionId = typeof requestBody.sessionId === 'string'
        ? requestBody.sessionId
        : undefined;
      const claim = readManagedOriginCapability(
        resolveDataDir(),
        sessionId,
        process.env.BOTMUX_SEND_RELAY,
        process.env.BOTMUX_ORIGIN_CHANNEL_ID,
      );
      if (claim) requestBody.originCapability = claim.capability;
    }
    const init = {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(requestBody),
      // No client-side timeout — broker enforces `timeoutMs` and will respond
      // with `kind:'timedOut'` so this fetch always settles.
    } satisfies RequestInit;
    let hostSecret: string | undefined;
    if (!process.env.BOTMUX_SEND_RELAY) {
      try { hostSecret = loadDaemonIpcSecret(); } catch { /* read-isolated CLI uses live marker auth */ }
    }
    res = hostSecret
      ? await fetchDaemonIpc(daemon.ipcPort, '/api/asks', init, hostSecret)
      : await loopbackFetch(`http://127.0.0.1:${daemon.ipcPort}/api/asks`, init);
  } catch (fetchErr) {
    // Socket refused / reset / timeout → daemon is down or restarting → retryable.
    const msg = fetchErr instanceof Error ? fetchErr.message : String(fetchErr);
    throw mkErr(`botmux ask: 无法连接 daemon (port=${daemon.ipcPort}): ${msg}`, true);
  }

  if (!res.ok) {
    let errBody = '';
    try { errBody = (await res.text()).slice(0, 200); } catch { /* */ }
    // Only transient server states are retryable. A deterministic 4xx (bad
    // body, capability denied, unsupported chat) will fail identically forever;
    // 502/503/504 mean the daemon is up but not ready (startup window) → retry.
    // Shared pure classifier (unit-tested directly — codex P1-3 seam).
    const retryable = isRetryableAskHttpStatus(res.status);
    throw mkErr(`botmux ask: daemon HTTP ${res.status}: ${errBody}`, retryable);
  }

  try {
    return (await res.json()) as AskResult;
  } catch (jsonErr) {
    // A malformed body is not something a retry fixes.
    throw mkErr(`botmux ask: daemon 返回非 JSON: ${jsonErr}`, false);
  }
}

async function cmdAsk(sub: string, rest: string[]): Promise<void> {
  // Workflow-subagent safety gate (same posture as cmdSend): a CLI running
  // inside a workflow subagent (Slice F) must not surface chat UI. Workflow
  // approvals belong in humanGate / decision nodes so the choice is part of
  // the run's event log; an ad-hoc `botmux ask` would bypass that audit
  // trail entirely.
  if (process.env.BOTMUX_WORKFLOW === '1') {
    const runId = process.env.BOTMUX_WORKFLOW_RUN_ID ?? '?';
    const nodeId = process.env.BOTMUX_WORKFLOW_NODE_ID ?? '?';
    console.error(
      `botmux ask refused inside workflow subagent (run=${runId} node=${nodeId}).\n` +
        `Workflow subagents must surface approvals via humanGate / decision nodes\n` +
        `so the resolution is recorded in the run's event log; ask would bypass it.`,
    );
    process.exit(2);
  }

  // Only `buttons` shipped in v0.1.7. The bare alias (`botmux ask --options`)
  // routes here with sub='' — accept it and behave identically. `ask text` /
  // `ask confirm` are reserved for later versions.
  if (sub && sub !== 'buttons') {
    console.error(
      `botmux ask: 未知 subcommand "${sub}"（v0.1.7 仅支持 \`buttons\` 或省略）`,
    );
    process.exit(2);
  }

  const { findMissingAskEnv, parseAskOptions, parseAskTimeoutSeconds, AskArgsError } =
    await import('./core/ask-args.js');
  type AskJsonOutput = import('./core/ask-types.js').AskJsonOutput;
  const { toLegacySelected, isCustomReply } = await import('./core/ask-types.js');

  const missing = findMissingAskEnv(process.env);
  if (missing) {
    console.error(
      `botmux ask: 缺少必需环境变量 ${missing}。` +
        ` 请在 botmux daemon spawn 的 CLI 会话内运行。`,
    );
    process.exit(2);
  }

  const optionsRaw = argValue(rest, '--options');
  const timeoutRaw = argValue(rest, '--timeout');
  const useJson = rest.includes('--json');
  const multiSelect = rest.includes('--multi');
  const positionalArgs = positionals(rest, ['--json', '--multi']);

  let options;
  let timeoutMs;
  try {
    options = parseAskOptions(optionsRaw);
    timeoutMs = parseAskTimeoutSeconds(timeoutRaw);
  } catch (err) {
    if (err instanceof AskArgsError) {
      console.error(`botmux ask: ${err.message}`);
      process.exit(2);
    }
    throw err;
  }

  const prompt = positionalArgs.join(' ').trim();
  if (!prompt) {
    console.error(
      'botmux ask: 缺少 prompt。用法: botmux ask buttons --options "yes,no" "继续发版吗？"',
    );
    process.exit(2);
  }

  const larkAppId = process.env.BOTMUX_LARK_APP_ID!;
  const askSessionId = process.env.BOTMUX_SESSION_ID!;
  const liveAskOrigin = resolveSessionContext(resolveDataDir(), askSessionId);
  const askRelayDir = process.env.BOTMUX_SEND_RELAY;
  const askOriginCapability = readManagedOriginCapability(
    resolveDataDir(),
    askSessionId,
    askRelayDir,
    process.env.BOTMUX_ORIGIN_CHANNEL_ID,
  )?.capability;
  const body = {
    sessionId: askSessionId,
    chatId: process.env.BOTMUX_CHAT_ID!,
    larkAppId,
    rootMessageId: process.env.BOTMUX_ROOT_MESSAGE_ID || null,
    ...(multiSelect
      ? { questions: [{ prompt, options, multiSelect: true }] }
      : { options, prompt }),
    timeoutMs,
    // Explicit `botmux ask buttons` has no reconnecting claimant (the CLI exits
    // on daemon restart), so mark it non-hook: the broker won't persist/handoff
    // it and can never confuse it with a hook ask's card (codex P1-4/P1-3).
    originKind: 'explicit',
    ...(liveAskOrigin?.turnId ? { originTurnId: liveAskOrigin.turnId } : {}),
    ...(liveAskOrigin?.dispatchAttempt !== undefined
      ? { originDispatchAttempt: liveAskOrigin.dispatchAttempt }
      : {}),
    ...(askOriginCapability ? { originCapability: askOriginCapability } : {}),
  };

  let result;
  try {
    result = await postAsk(body);
  } catch (err) {
    const code = (err as any).exitCode ?? 3;
    console.error((err as Error).message);
    process.exit(code);
  }

  // result.kind==='answered' 时用 toLegacySelected 取回旧的 string（单问单选）
  const selected = toLegacySelected(result);

  if (useJson) {
    const out: AskJsonOutput = {
      // `selected` 是「单问单选」的向后兼容值（= toLegacySelected 的形状判据：
      // 恰好 1 问且恰好 1 个 key）。`--multi` 下调用方明确按多选语义读 `answers[0]`，
      // 此时 `selected` 必须恒为 null——否则「多选恰好 1 项」会因形状巧合退化出一个
      // key，令 `selected` 的含义随选中数量漂移（违反公开契约）。
      selected: multiSelect ? null : selected,
      answers: result.kind === 'answered' ? (result.answers as string[][]) : null,
      by: result.kind === 'answered' ? result.by : null,
      comment: result.kind === 'answered' ? result.comment : null,
      timedOut: result.kind === 'timedOut',
    };
    process.stdout.write(JSON.stringify(out) + '\n');
  } else if (result.kind === 'answered') {
    // 非 JSON 模式：单选输出 key，多选输出逗号分隔的 keys。
    //
    // 用户以文字作答时落到空字符串；comment 可能含换行，塞进「一行一个 key」的
    // stdout 契约并不安全，因此 stdout 保持不变，改由 stderr 指明答案去向。
    if (isCustomReply(result)) {
      console.error(
        'botmux ask: 用户以文字作答，未点选任何选项；stdout 留空（stdout 只承载 option key）。' +
          ' 用 `--json` 读 comment 字段取回原文。',
      );
    }
    // 单选走 `selected`（单问单选的 key，与旧行为字节一致）；多选直接拼 `answers[0]`
    // 的完整 key 数组，与 selected 的单选语义解耦——多选 0 项→空行、1 项→单 key、
    // N 项→逗号分隔，全程 exit 0。文字作答时 answers[0] 为空数组同样落空行（上面已在
    // stderr 提示改读 --json 的 comment）。
    const value = multiSelect ? (result.answers[0]?.join(',') ?? '') : (selected ?? '');
    process.stdout.write(value + '\n');
  }

  switch (result.kind) {
    case 'answered':
      process.exit(0);
    case 'timedOut':
      console.error(`botmux ask: 超时（${timeoutMs / 1000}s），无回复`);
      process.exit(124);
    case 'invalidated':
      console.error(`botmux ask: 已失效 (${result.reason})`);
      process.exit(3);
  }
}

// ─── botmux hook <cliId> ──────────────────────────────────────────────────────
//
// hook 模式：各 CLI hook 配置调用 `botmux hook <cliId>`，stdin 注入 hook payload，
// 本命令解析问题 → POST /api/asks → 等结果 → 写 directive 到 stdout。
// 任何失败（daemon 不可达、env 缺失、解析错误）均输出 passthrough directive 并 exit 0，
// 绝不挂死，保证 CLI 可以继续原生终端提问。

/**
 * runHook: hook 命令的纯业务逻辑，接受已解析的 payload/env/postAskFn，
 * 返回应写到 stdout 的字符串。通过依赖注入使单元测试无需真实 daemon/env。
 *
 * @param payload              已经 JSON.parse 的 hook payload 对象
 * @param env                  包含 BOTMUX_* 环境变量的字典
 * @param postAskFn            替代真实 postAsk 的可注入函数（测试用）
 * @param cliId                CLI 适配器 ID
 * @param resolveAdoptRouteFn  可选：替代真实 adopt 路由解析的注入函数（测试用）；
 *                             缺省时使用真实 resolveAdoptRoute（查祖先 PID → daemon）
 * @returns                    { stdout: string } 应写到 stdout 的内容
 */
export async function runHook(
  payload: unknown,
  env: Record<string, string | undefined>,
  postAskFn: (body: Record<string, unknown>) => Promise<import('./core/ask-types.js').AskResult>,
  cliId: string,
  resolveAdoptRouteFn?: () => Promise<import('./adapters/adopt-route.js').AdoptRoute | null>,
  /** 按 OpenCode 原生会话 id（payload.session_id，ses_*）反查所属 botmux 会话；
   *  缺省用真实实现（在线 daemon 并发查询 + budget 封顶）。测试注入 stub。 */
  resolveCliSessionRouteFn?: (cliSessionId: string) => Promise<import('./adapters/adopt-route.js').AdoptRoute | null>,
): Promise<{ stdout: string }> {
  const { getHookAdapter } = await import('./core/ask-hook/registry.js');

  // 未知 cliId → 无 adapter，输出空字符串静默放行
  const adapter = getHookAdapter(cliId);
  if (!adapter) {
    return { stdout: '' };
  }

  // Workflow-subagent 安全门：workflow 子 agent 内直接 passthrough
  if (env.BOTMUX_WORKFLOW === '1') {
    return { stdout: adapter.passthrough(payload) };
  }

  // 解析问题：非 askUserQuestion 类事件 → passthrough 放行
  const parsed = adapter.parseQuestions(payload);
  if (!parsed) {
    return { stdout: adapter.passthrough(payload) };
  }

  // 检查必需的 BOTMUX_* env
  const sessionId = env.BOTMUX_SESSION_ID;
  const chatId = env.BOTMUX_CHAT_ID;
  const larkAppId = env.BOTMUX_LARK_APP_ID;

  // 路由变量：优先用 payload 携带的 OpenCode 原生会话 id 反查所属 botmux 会话；
  // 未命中：共享 service hook（opencode2）直接 passthrough（fail closed），
  // 进程私有 hook 回落 env，env 缺失时再尝试 adopt 路由。
  let routeSessionId = sessionId;
  let routeChatId = chatId;
  let routeLarkAppId = larkAppId;
  let routeRoot: string | null = env.BOTMUX_ROOT_MESSAGE_ID || null;
  let explicitRoute: import('./adapters/adopt-route.js').AdoptRoute | null = null;

  // 共享 service 场景（opencode2）：ask 插件运行在所有客户端共用的托管 service 里，
  // hook 子进程继承的是「启动该 service 的会话」的 ambient env，与当前会话无关，
  // 直接拿来路由会跨会话错投。payload.session_id 是 OpenCode 原生 id（ses_*），
  // 整段反查只对共享 service hook 启用：进程私有 hook（opencode 等）的 ambient
  // env 是当前进程的可信归属，让反查覆盖反而可能被另一重复绑定的命中错投。
  // 共享 service 的 env 永远不可信：session_id 缺失或非 ses_* 形状时无法验证
  // native identity，同样 fail closed（passthrough），绝不落 env 路由。
  const isSharedServiceHook = cliId === 'opencode2';
  const rawPayload = payload as Record<string, unknown> | undefined;
  const nativeSessionId = typeof rawPayload?.session_id === 'string'
    ? rawPayload.session_id.trim()
    : '';
  if (isSharedServiceHook && !/^ses_[0-9A-Za-z]+$/.test(nativeSessionId)) {
    return { stdout: adapter.passthrough(payload) };
  }
  if (isSharedServiceHook) {
    const { resolveCliSessionRoute, queryCliSession } = await import('./adapters/adopt-route.js');
    const resolver = resolveCliSessionRouteFn ?? ((cliSessionId: string) =>
      resolveCliSessionRoute({
        cliSessionId,
        listDaemons: listOnlineDaemons,
        queryDaemon: queryCliSession,
      }));
    try {
      explicitRoute = await resolver(nativeSessionId);
    } catch {
      // 反查异常 → 视同未命中（无法证明唯一），fail closed
      explicitRoute = null;
    }
    if (explicitRoute) {
      routeSessionId = explicitRoute.sessionId;
      routeChatId = explicitRoute.chatId;
      routeLarkAppId = explicitRoute.larkAppId;
      routeRoot = explicitRoute.rootMessageId;
    } else {
      // fail closed：反查未能证明「恰好一个完整命中」（未命中 / 双命中歧义 /
      // 查询超时 / daemon 不可达 / cliSessionId 尚未上报）→ 直接 passthrough
      // 把问题留给原生终端，绝不回落 ambient env / PID adopt，避免跨会话错投。
      return { stdout: adapter.passthrough(payload) };
    }
  }

  if (!explicitRoute && (!sessionId || !chatId || !larkAppId)) {
    // env 缺失 → 尝试通过祖先 PID 匹配在线 adopt 会话
    const resolver = resolveAdoptRouteFn ?? (() => {
      // 延迟 import 避免冷启动开销
      return import('./adapters/adopt-route.js').then(({ resolveAdoptRoute, queryAdoptSession }) =>
        resolveAdoptRoute({
          startPid: process.pid,
          listDaemons: listOnlineDaemons,
          queryDaemon: queryAdoptSession,
        }),
      );
    });
    let adopt: import('./adapters/adopt-route.js').AdoptRoute | null = null;
    try {
      adopt = await resolver();
    } catch {
      // 解析失败 → 视作真非 botmux 会话，passthrough 放行
    }
    if (!adopt) {
      // 真非 botmux 会话 → passthrough 放行
      return { stdout: adapter.passthrough(payload) };
    }
    // adopt 命中 → 使用 adopt 路由信息
    routeSessionId = adopt.sessionId;
    routeChatId = adopt.chatId;
    routeLarkAppId = adopt.larkAppId;
    routeRoot = adopt.rootMessageId;
  }

  // 解析 timeoutMs：默认 ~24h，可由 BOTMUX_ASK_TIMEOUT_MS 覆盖。
  // 为什么这么长：ask 超时不是良性兜底——broker settle 成 `timedOut` 会让 hook
  // 落到 passthrough，Claude 转而渲染原生 picker，而此后飞书回调已无通道把答案
  // 送回（picker 挂死、答案不生效）。所以默认值对齐 hook 安装侧的进程超时上限
  // （settings.json 里的 86400s），让 broker 不会 *早于* hook 进程本身超时；
  // 既避免"人回复慢→picker 卡死"，又保留一个有限的进程级兜底（永不超时会让一次
  // CLI turn 无限阻塞，是更糟的失败）。
  const DEFAULT_TIMEOUT_MS = 86_400_000; // 24h — 对齐 hook 安装侧 timeout:86400s
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  const timeoutEnv = env.BOTMUX_ASK_TIMEOUT_MS;
  if (timeoutEnv) {
    const parsed_timeout = parseInt(timeoutEnv, 10);
    if (Number.isInteger(parsed_timeout) && parsed_timeout > 0) {
      timeoutMs = parsed_timeout;
    }
  }

  // Per-invocation identity: generated ONCE here (outside the retry loop) and
  // reused across every reconnect POST, so a re-POST after a daemon restart
  // re-attaches to the same restored ask instead of posting a duplicate card.
  // originKind='hook' namespaces it away from an explicit `botmux ask buttons`.
  const requestId = randomUUID();

  const body: Record<string, unknown> = {
    sessionId: routeSessionId,
    chatId: routeChatId,
    larkAppId: routeLarkAppId,
    rootMessageId: routeRoot,
    questions: parsed.questions,
    timeoutMs,
    requestId,
    originKind: 'hook',
  };

  // Post the ask, RETRYING across a daemon restart. The daemon holds pending
  // asks in memory only, so a restart between "card posted" and "user clicked"
  // drops the ask; historically postAskFn then threw (daemon unreachable) and
  // we fell straight to passthrough → the CLI rendered its native picker with no
  // way to receive the answer. Instead: while the daemon is unreachable (and
  // only then — an answered/timedOut/invalidated result returns normally), keep
  // reconnecting until the ask's own deadline. The daemon restores the pending
  // ask from disk on boot and re-attaches this reconnecting request to it by a
  // stable key, so the SAME card resolves through the normal hook directive.
  // Blocking here keeps Claude spinning; the native picker never renders.
  const deadline = Date.now() + timeoutMs;
  let result: import('./core/ask-types.js').AskResult | undefined;
  let attempt = 0;
  while (true) {
    try {
      result = await postAskFn(body);
      break;
    } catch (err) {
      // Retry ONLY genuinely transient failures (daemon unreachable / network /
      // 502-503-504 startup-not-ready — see postAsk's `retryable`). That is the
      // restart-in-progress case. A deterministic error (4xx bad body /
      // capability / unsupported, non-JSON) has retryable=false → passthrough
      // immediately rather than spin for 24h. A non-coded throw is also treated
      // as non-retryable.
      const retryable = (err as { retryable?: boolean } | undefined)?.retryable === true;
      if (!retryable || Date.now() >= deadline) {
        return { stdout: adapter.passthrough(payload) };
      }
      attempt++;
      // Backoff: quick first reconnects (daemon usually returns in a few
      // seconds), capped at 5s. Never sleep past the deadline.
      const backoff = Math.min(5_000, 500 * attempt);
      const remaining = deadline - Date.now();
      if (remaining <= 0) return { stdout: adapter.passthrough(payload) };
      await new Promise((r) => setTimeout(r, Math.min(backoff, remaining)));
    }
  }

  if (result.kind === 'answered') {
    return { stdout: adapter.formatAnswer(result.answers, parsed, result.comment) };
  }

  // timedOut / invalidated → passthrough 放行
  return { stdout: adapter.passthrough(payload) };
}

/**
 * cmdHook: `botmux hook <cliId>` 入口。
 * 读取 stdin 全文 → JSON.parse → runHook → 写 stdout，exit 0。
 */
async function cmdHook(cliId: string): Promise<void> {
  // 读取 stdin 全文
  let stdinText = '';
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    stdinText = Buffer.concat(chunks).toString('utf-8');
  } catch {
    // stdin 读取失败 → 无法处理，静默退出
    process.exit(0);
  }

  // JSON.parse 失败 → 输出空并退出（不挂死）
  let payload: unknown;
  try {
    payload = JSON.parse(stdinText);
  } catch {
    process.exit(0);
  }

  const { getHookAdapter } = await import('./core/ask-hook/registry.js');
  const adapter = getHookAdapter(cliId);
  // 未知 cliId → 静默放行
  if (!adapter) {
    process.exit(0);
  }

  const env = process.env as Record<string, string | undefined>;
  const result = await runHook(payload, env, postAsk, cliId);
  if (result.stdout) {
    console.log(result.stdout);
  }
  process.exit(0);
}

// ─── botmux session-ready ─────────────────────────────────────────────────────
//
// Claude 家族（claude/seed）的 SessionStart hook 客户端。它通知 daemon 已越过
// 外层 startup selector；worker 随即清除 selector 留下的旧 ❯ 证据，再等待所有
// 并行 hook 完成后新渲染的输入框，避免 cjadk 选择器误吞首条消息。
//
// 会话归属只靠 hook 子进程继承的 env（worker spawn 时设的 BOTMUX_SESSION_ID /
// BOTMUX_LARK_APP_ID）。任何失败（env 缺失=adopt/非 botmux 会话、daemon 不可达）
// 都静默 exit 0：绝不挂死 CLI 启动；信号丢了 worker 有超时兜底。
async function cmdSessionReady(): Promise<void> {
  // 排空 stdin：Claude 把 SessionStart payload 写到这里。我们只取 source 字段
  // （诊断用），但务必消费掉，避免 CLI 端写满管道阻塞。best-effort。
  let payloadText = '';
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    payloadText = Buffer.concat(chunks).toString('utf-8');
  } catch { /* stdin 读不到也无所谓 */ }
  let source: string | undefined;
  try {
    const p = JSON.parse(payloadText);
    if (p && typeof p.source === 'string') source = p.source;
  } catch { /* 非 JSON / 空 → 不带 source */ }

  const sessionId = process.env.BOTMUX_SESSION_ID;
  const larkAppId = process.env.BOTMUX_LARK_APP_ID;
  // env 缺失 → adopt / 非 botmux 会话；就绪门控对它们不适用，静默放行。
  if (!sessionId || !larkAppId) process.exit(0);

  // Host sessions discover the owning daemon through its descriptor. Linux
  // bwrap / read-isolated sessions deliberately cannot read that directory,
  // so use the worker-injected loopback port as a fallback. The port is not a
  // credential: /api/session-ready still verifies the rotating per-turn
  // capability carried below.
  let discoveredPort: number | undefined;
  try { discoveredPort = findDaemon(larkAppId)?.ipcPort; } catch { /* masked/unreadable registry */ }
  const ipcPort = resolveDaemonIpcPort(
    discoveredPort,
    process.env.BOTMUX_DAEMON_IPC_PORT,
  );
  if (ipcPort) {
    try {
      const relayDir = process.env.BOTMUX_SEND_RELAY;
      const originCapability = readManagedOriginCapability(
        resolveDataDir(),
        sessionId,
        relayDir,
        process.env.BOTMUX_ORIGIN_CHANNEL_ID,
      )?.capability;
      const liveOrigin = resolveSessionContext(resolveDataDir(), sessionId);
      const envAttempt = Number(process.env.BOTMUX_DISPATCH_ATTEMPT);
      const originTurnId = liveOrigin?.turnId ?? process.env.BOTMUX_TURN_ID;
      const originDispatchAttempt = liveOrigin?.dispatchAttempt
        ?? (Number.isSafeInteger(envAttempt) && envAttempt > 0 ? envAttempt : undefined);
      const init = {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          sessionId,
          source,
          originCapability,
          originTurnId,
          originDispatchAttempt,
        }),
      } satisfies RequestInit;
      let hostSecret: string | undefined;
      if (!relayDir) {
        try { hostSecret = loadDaemonIpcSecret(); } catch { /* Seatbelt/read-isolated CLI */ }
      }
      if (!hostSecret) {
        await loopbackFetch(`http://127.0.0.1:${ipcPort}/api/session-ready`, init);
      } else {
        await fetchDaemonIpc(ipcPort, '/api/session-ready', init, hostSecret);
      }
    } catch { /* daemon 不可达 → 放弃，worker 走超时兜底 */ }
  }
  process.exit(0);
}

// ─── botmux user-prompt-hook ─────────────────────────────────────────────────
//
// Claude 家族 UserPromptSubmit hook 客户端（#794 P1 方向 B）。按 stdin 里
// `prompt` 的内容指纹，经 daemon IPC 向宿主 claim/pop 该轮的 per-turn envelope
// （reminder/whiteboard），以 additionalContext 注入为该轮 system-reminder。
//
// 为什么走 IPC 而不是直接读文件（review HIGH-1/HIGH-2）：
// - HIGH-2：`prompt-ctx/<sid>` 在沙箱里是 read-only bind，hook 子进程在沙箱内
//   unlink 必失败，「读后消费」形同虚设。消费（pop）改到宿主 daemon 执行。
// - HIGH-1：宿主按 managedTurnOrigin.turnId 权威 turn 绑定精确取，不用 FIFO 猜。
//   某轮漏 claim 只孤儿化自己那条，不串轮到后续轮；上一轮的 stale sidecar 永远
//   不会被返回，因此也不需要 inline 文本启发式防双注入。
//
// 鉴权双路径（与 /close、/slash 同构）：能读 host secret（非沙箱）走 HMAC；
// 读不到（沙箱/read-isolation）带本会话 rotating per-turn capability。
//
// fail-open 铁律：任何失败（env 缺失 = 非 botmux 会话、daemon 不可达、未命中 =
// 用户手输或 inline 模式、403/404）都空输出 + exit 0。绝不 exit 2（会阻塞该轮
// prompt），绝不抛错（Claude 对 hook 失败的兜底是放弃注入，正合预期）。
async function cmdUserPromptHook(): Promise<void> {
  // 5s 自限时读 stdin：Claude 写完 payload 会关 stdin，正常情况下立即结束；
  // 万一上游不关管道，也不能挂住 hook（settings.json 里的 10s timeout 是第二道）。
  let payloadText = '';
  try {
    const chunks: Buffer[] = [];
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; try { process.stdin.destroy(); } catch { /* */ } }, 5000);
    if (typeof timer.unref === 'function') timer.unref();
    for await (const chunk of process.stdin) {
      if (timedOut) break;
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    clearTimeout(timer);
    payloadText = Buffer.concat(chunks).toString('utf-8');
  } catch { /* stdin 读不到 → no-op */ }

  const sessionId = process.env.BOTMUX_SESSION_ID;
  // env 缺失 → adopt / 非 botmux 会话 / 用户手输，静默放行。
  if (!sessionId) process.exit(0);

  let prompt: string | undefined;
  try {
    const p = JSON.parse(payloadText) as { prompt?: unknown };
    if (typeof p?.prompt === 'string') prompt = p.prompt;
  } catch { /* 非 JSON → no-op */ }
  if (!prompt) process.exit(0);

  // 经 daemon IPC claim/pop。沙箱内不能直接 unlink read-only 的 sidecar，
  // 也不能把目录改可写（会给沙箱里的模型伪造 sidecar 的能力）。
  // 不需要 inline 检测：daemon 按权威 turnId 取，上一轮的 stale sidecar 不会被返回。
  try {
    const [{ fingerprintPromptText, prefixOf }] = await Promise.all([
      import('./services/prompt-context-store.js'),
    ]);
    const larkAppId = process.env.BOTMUX_LARK_APP_ID;
    let discoveredPort: number | undefined;
    try { discoveredPort = findDaemon(larkAppId)?.ipcPort; } catch { /* masked/unreadable registry */ }
    const ipcPort = resolveDaemonIpcPort(
      discoveredPort,
      process.env.BOTMUX_DAEMON_IPC_PORT,
    );
    if (!ipcPort) process.exit(0);

    const body: Record<string, unknown> = {
      fingerprint: fingerprintPromptText(prompt),
      prefix: prefixOf(prompt),
    };
    let hostSecret: string | undefined;
    if (!process.env.BOTMUX_SEND_RELAY) {
      try { hostSecret = loadDaemonIpcSecret(); } catch { /* Seatbelt/read-isolated CLI */ }
    }
    if (!hostSecret) {
      const claim = readManagedOriginCapability(
        resolveDataDir(),
        sessionId,
        process.env.BOTMUX_SEND_RELAY,
        process.env.BOTMUX_ORIGIN_CHANNEL_ID,
      );
      if (claim) {
        body.originCapability = claim.capability;
        if (claim.turnId) body.originTurnId = claim.turnId;
        if (claim.dispatchAttempt !== undefined) body.originDispatchAttempt = claim.dispatchAttempt;
      }
    }
    const init = {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    } satisfies RequestInit;
    const path = `/api/sessions/${encodeURIComponent(sessionId)}/prompt-ctx/claim`;
    const res = hostSecret
      ? await fetchDaemonIpc(ipcPort, path, init, hostSecret)
      : await loopbackFetch(`http://127.0.0.1:${ipcPort}${path}`, init);
    if (res.status !== 200) process.exit(0);
    const data = await res.json() as { envelope?: unknown };
    const envelope = typeof data?.envelope === 'string' ? data.envelope : undefined;
    if (envelope) {
      const payload = JSON.stringify({
        hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: envelope },
      });
      // stdout.write 对 pipe 是异步的：直接 process.exit 可能截断（8k 远小于
      // 64k pipe buffer，几乎不会中，但中了就是 reminder 丢失）。写完再退出，
      // 并留 1s 兜底防 callback 不触发。
      process.stdout.write(payload, () => process.exit(0));
      const timer = setTimeout(() => process.exit(0), 1000);
      if (typeof timer.unref === 'function') timer.unref();
      return;
    }
  } catch { /* daemon 不可达 / claim 失败 → no-op */ }
  process.exit(0);
}

async function cmdBots(sub: string, rest: string[]): Promise<void> {
  process.env.SESSION_DATA_DIR ??= resolveDataDir();

  if (sub === '--help' || sub === '-h' || sub === 'help') {
    console.log(`
botmux bots — 机器人协作花名册 / 团队补人

子命令:
  bots list [--scope chat|team] [--team <id>] [--session-id ID]
             列出机器人。默认 chat scope：当前飞书群内的 bot（含 open_id、能力标签、能否可靠 @到）；
             --scope team：跨机列出同团队、已 opt-in 的 agent（按专长发现，供拉群 / 补人）。
  bots invite --chat <chatId> --team <id> --agent <appId>...
             往「已存在的团队群」补人：把同团队、已 opt-in 的 agent + 各自 owner 一起拉进。

补人（invite）的完整参数与 403 前置条件见 \`botmux bots invite --help\`。
`);
    return;
  }

  // `bots invite`：往**已存在的团队群**补人（同 team、已 opt-in 的 agent + 各自 owner），
  // 打平台端点4（machine-auth）。独立子命令——与「建新群」的 create-group 语义分开，
  // 不再靠 create-group --chat 区分（那个入口易被误读成"建群"）。在会话/transport 闸门前分流。
  if (sub === 'invite') {
    await cmdBotsInvite(rest);
    return;
  }

  if (sub !== 'list' && sub !== 'ls' && sub !== '') {
    console.error('用法: botmux bots list [--scope chat|team] [--team <id>] [--session-id ID]');
    console.error('      botmux bots invite --chat <chatId> --team <id> --agent <appId>...');
    console.error('（完整说明见 botmux bots --help）');
    process.exit(1);
  }

  // `--scope team`：跨机发现同团队、已 opt-in 的 agent（打平台端点2，machine-auth）。
  // 与默认的 chat scope 完全不同——它不读飞书群花名册、不需要会话/传输身份，
  // 所以在会话解析 / transport 闸门之前分流。空 team 列表是正常态（没别人 opt-in）。
  const scope = (argValue(rest, '--scope') ?? 'chat').toLowerCase();
  if (scope === 'team') {
    await cmdBotsListTeam(rest);
    return;
  }
  if (scope !== 'chat') {
    console.error(`未知 --scope "${scope}"（仅支持 chat | team）`);
    process.exit(1);
  }

  // `bots list` reads the Feishu chat roster (listChatBotMembers). A no-transport
  // turn has no chat roster — central hard gate (also stops the routing prompt
  // from advertising a Feishu-dependent helper in this context).
  assertTurnTransportOrExit('bots list');

  const sessionIdArg = argValue(rest, '--session-id');
  // 与 history/quoted 同一前奏：先从本 bot 自己的 send-cred 文件注册，让 Lark client
  // 在**不读被 deny 的 bots.json** 的前提下可用，再做会话解析 + riff sandbox env
  // 合成会话兜底。漏掉 registerSelfFromCredFile() 时读隔离 bot 的
  // `botmux bots list` 会在 getBotClient() 上抛 "Bot not registered"，
  // listChatBotMembers() 把它降级成 legacy discovery（configured 行同样来自
  // bots.json）→ 返回 `total: 0`。**失败形态是静默的**：沙盒 bot 拿到空花名册会
  // 按"只 @ mentionable 的"判定群里没人可 @，多 bot 协作直接不发生且不报错。
  await registerSelfFromCredFile();
  const { sid, larkAppId: resolvedAppId, session: s } = await resolveSessionAppId(sessionIdArg);
  // Target-aware gate (see cmdHistory).
  assertSessionTransportOrExit({ chatId: s.chatId, larkAppId: resolvedAppId }, 'bots list');

  const appId = resolvedAppId;
  const dataDir = resolveDataDir();
  const botInfoPath = join(dataDir, 'bots-info.json');

  type BotInfoEntry = { larkAppId: string; botOpenId: string | null; botName: string | null; cliId: string };
  let botEntries: BotInfoEntry[] = [];
  try { if (existsSync(botInfoPath)) botEntries = JSON.parse(readFileSync(botInfoPath, 'utf-8')); } catch { /* */ }

  const collaborationFactsFor = (appIds: string[]): BotCollaborationFactsByAppId => {
    const facts: Record<string, BotCollaborationFactsByAppId[string]> = Object.create(null);
    const wanted = new Set(appIds.filter(Boolean));
    try {
      for (const cfg of loadBotConfigs()) {
        if (!wanted.has(cfg.larkAppId)) continue;
        facts[cfg.larkAppId] = {
          workspaceSource: cfg.oncallChats?.some(c => c.chatId === s.chatId)
            ? 'oncall'
            : effectiveDefaultWorkingDir(cfg) ? 'default' : 'unknown',
          mentionMode: cfg.regularGroupMentionMode ?? 'always',
          replyMode: cfg.chatReplyModes?.[s.chatId] ?? cfg.regularGroupReplyMode ?? 'chat-topic',
          transport: cfg.apiOnly !== true,
        };
      }
    } catch { /* config unreadable under isolation: all facts stay unknown */ }
    return facts;
  };

  try {
    const { listChatBotMembers } = await import('./im/lark/client.js');
    const chatBots = await listChatBotMembers(appId, s.chatId);
    // source: 'configured' = registered in local bots.json (managed by some
    // botmux daemon on this host). 'introduce' = discovered via /introduce
    // collaboration command (external bot, possibly other-tenant). isSelf is
    // retained (not filtered) so the model can still identify itself when needed.
    const result = formatChatBotsForCli(chatBots, appId, collaborationFactsFor(chatBots.map(bot => bot.larkAppId)));
    console.log(JSON.stringify({ sessionId: sid, chatId: s.chatId, bots: result, total: result.length, collaborationHelp }, null, 2));
  } catch (err: any) {
    // Fallback to bots-info.json
    const result = formatBotInfoEntriesForCli(botEntries, appId, collaborationFactsFor(botEntries.map(bot => bot.larkAppId)));
    console.log(JSON.stringify({ sessionId: sid, bots: result, total: result.length, collaborationHelp, note: `chat query failed: ${err.message}` }, null, 2));
  }
}

/**
 * `botmux bots list --scope team [--team <id>]` — 跨机发现同团队、已 opt-in（owner
 * 加进 team.bots）的 agent，打平台端点2（machine-auth，Bearer=machineToken）。
 *
 * 与 chat scope 的关键区别 + 硬约束：
 *  - 走 machine-auth，不读飞书群花名册、不需要传输身份 → 沙盒/apiOnly bot 也能查。
 *  - **CLI 不做任何授权判断**：团队成员校验 + opt-in 闸全在平台，这里只透传、只展示。
 *  - specialties / mentionable 是 agent 自报 → 仅展示，不当可信凭据。
 *  - 未传 --team：先打端点1 拉本机 owner 的团队；唯一就用它，多个要求显式 --team
 *    （不猜），零个则提示本机没加入任何平台团队。
 */
async function cmdBotsListTeam(rest: string[]): Promise<void> {
  const { fetchTeamAgents, fetchTeams, describeTeamAgentsFailure } = await import('./platform/team-agents-client.js');
  const jsonOut = argFlag(rest, '--json');

  let teamId = argValue(rest, '--team');
  let teamNameHint: string | undefined;
  if (!teamId) {
    const teamsRes = await fetchTeams();
    if (!teamsRes.ok) {
      if (teamsRes.reason === 'unbound') {
        console.error('本机未绑定平台（~/.botmux/platform.json 缺失）。团队发现需要先 botmux bind。');
      } else if (teamsRes.reason === 'not_deployed') {
        console.error('平台尚未部署团队端点（/v1/machine/teams）。等平台上线后重试。');
      } else {
        console.error(`拉取团队列表失败：${describeTeamAgentsFailure(teamsRes)}`);
      }
      process.exit(1);
    }
    const teams = teamsRes.value;
    if (teams.length === 0) {
      // 空不是错误：本机 owner 还没加入任何平台团队。
      console.log(JSON.stringify({ scope: 'team', teams: [], agents: [], total: 0, note: '本机未加入任何平台团队' }, null, 2));
      return;
    }
    if (teams.length > 1) {
      console.error('本机属于多个平台团队，请用 --team <id> 指定其一：');
      for (const t of teams) console.error(`  ${t.teamId}  ${t.teamName}`);
      process.exit(1);
    }
    teamId = teams[0].teamId;
    teamNameHint = teams[0].teamName;
  }

  const res = await fetchTeamAgents(teamId);
  if (!res.ok) {
    if (res.reason === 'unbound') {
      console.error('本机未绑定平台（~/.botmux/platform.json 缺失）。团队发现需要先 botmux bind。');
    } else if (res.reason === 'not_deployed') {
      console.error('平台尚未部署团队 agent 发现端点（/v1/machine/agents）。等平台上线后重试。');
    } else if (res.reason === 'client' && res.status === 404) {
      console.error(`团队不存在或本机 owner 不是其成员：teamId=${teamId}`);
    } else {
      console.error(`拉取团队 agent 失败：${describeTeamAgentsFailure(res)}`);
    }
    process.exit(1);
  }

  const { teamName, agents } = res.value;
  // 输出对齐 chat scope 的 JSON 形状（scope 标注 + total），字段是平台端点2 的原样透传。
  // 提醒：发现列表只含**已加入 team.bots** 的 agent（owner 在平台「管理机器人」显式加入）。
  console.log(JSON.stringify({
    scope: 'team',
    teamId,
    teamName: teamName || teamNameHint || teamId,
    agents,
    total: agents.length,
    note: '发现列表只含已加入团队（owner 在平台「管理机器人」opt-in）的 agent；specialties/mentionable 为 agent 自报，仅供参考不可信。',
  }, null, jsonOut ? 0 : 2));
}

/**
 * (a) 自动化辅助：把平台后端 app（platformAppId）拉进目标群 `chatId`。
 *
 * 飞书约束：加应用的 app 自己得在群里。所以找一个**已在该群、且本机可用凭据**的 bot 当代理
 * （addBotToChat proxy）。优先用本会话 bot（它天然在本群且已注册），否则遍历 bots.json 里其它
 * 非 apiOnly bot、逐个 isInChat 命中即用。全都不在群/加失败（无 scope、群需群主审批）→ 返回失败，
 * 由调用方回退到手动引导。
 */
async function tryAutoAddPlatformBot(
  chatId: string, platformAppId: string,
): Promise<{ ok: true; proxyName: string } | { ok: false; reason: string }> {
  try {
    const { findLocalBotInChat } = await import('./im/lark/client.js');
    const { addBotToChat } = await import('./services/groups-store.js');
    // 用安静探测客户端找一个「已在目标群」的本机 bot 当代理（本会话 bot 优先）。
    // 不在群的 bot 探测 miss 被静音，不刷 axios 400 噪音（见 client.findLocalBotInChat）。
    const proxy = await findLocalBotInChat(chatId, process.env.BOTMUX_LARK_APP_ID);
    if (!proxy) return { ok: false, reason: '本机没有已在该群的 bot 可当代理' };
    // 代理 bot 需已在注册表（getBotClient 可用）——从 bots.json 注册一次（幂等）。
    try {
      const { loadBotConfigs, registerBot } = await import('./bot-registry.js');
      const cfg = loadBotConfigs().find((c: any) => c.larkAppId === proxy.larkAppId);
      if (cfg) registerBot(cfg);
    } catch { /* 已注册或读配置失败 → addBotToChat 若拿不到 client 会报错并回退 */ }
    const r = await addBotToChat(proxy.larkAppId, chatId, [platformAppId]);
    const one = r[0];
    if (one?.ok) return { ok: true, proxyName: proxy.cliId ? `${proxy.cliId}/${proxy.larkAppId}` : proxy.larkAppId };
    // 加失败（无 scope / 群需群主审批 / invalid）→ 回退手动引导。
    return { ok: false, reason: `代理 ${proxy.larkAppId} 添加失败：${one?.error ?? 'unknown'}` };
  } catch (e: any) {
    return { ok: false, reason: String(e?.message ?? e) };
  }
}

/**
 * `botmux bots invite --chat <chatId> --team <id> --agent <appId>...`
 * —— 往**已存在的团队群**补人（同 team、已 opt-in 的 agent + 各自 owner），打平台端点4。
 *
 * 独立于 create-group（建新群）：语义是「群已经在了，往里加人」，不该跟建群混在一个命令里。
 * 全程 machine-auth、只认 appId（发起人在别人 bot 进群前 @不到它，靠 appId 绕开视角问题）。
 * 授权/opt-in 闸/大厅排除全在平台，CLI 零判断、只如实展示平台判定。
 * 若平台回 platform_bot_not_in_chat 且带 platformAppId → 自动用群内本机 bot 把平台 app 拉进群、重试。
 *
 * 输出：stdout 单行 chatId（skill 友好，与 create-group 一致）；--json-status 追加
 * {ok, chatId, invalidBotIds, invalidOwnerUnionIds, teamId}；invalid* 非空 → 非零退出。
 */
async function cmdBotsInvite(rest: string[]): Promise<void> {
  if (rest.includes('--help') || rest.includes('-h')) {
    console.log(`
botmux bots invite — 往「已存在的团队群」补人（同团队、已 opt-in 的 agent + 各自 owner）

用法:
  botmux bots invite --chat <chatId> --team <teamId> --agent <appId> [--agent ...]
                     [--json-status]

参数:
  --chat <chatId>  必填。目标群 chatId（oc_...）。须满足下列前置条件（否则平台按 403 拒绝，见下）。
  --team <teamId>  团队 id。省略时：本机唯一团队自动用它，多个团队要求显式指定（不猜）。
  --agent <appId>  至少一个、可多次、按 appId 去重。appId 从 \`botmux bots list --scope team\` 发现。
  --json-status    可选；在 stdout 单行 chatId 后追加一行 {ok, chatId, invalidBotIds,
                   invalidOwnerUnionIds, teamId}；invalid* 非空 → 非零退出。

行为:
  - 全程 machine-auth，只认 appId、不需要 @（发起人在别人 bot 进群前根本 @不到它）。
  - 补人恒把 agent + 各自 owner 一起拉进群；已在群内视作成功（幂等）。
  - 授权 / opt-in 闸 / 大厅排除全在平台，CLI 零判断、只如实展示平台判定。
  - 平台机器人（BotmuxPlatform）不在目标群时，会自动用群内本机 bot 当代理把它拉进群再重试；
    自动添加失败（需群主审批 / 代理 bot 无成员管理 scope）时给出手动添加引导。

前置条件（不满足平台按 403 拒绝，平台按 error code 分型）:
  - 平台机器人（BotmuxPlatform）已在群里     → 否则 platform_bot_not_in_chat（先把它拉进群）
  - 你本人已在该群                          → 否则 requester_not_in_chat（只能往你自己在场的群补人）
  - 非机器人大厅                            → 否则 chat_is_hall（大厅是 bot-only 身份登记群）
  - 每个 --agent 都已 opt-in 进该团队        → 否则 not_in_team_bots（其 owner 需在平台「管理机器人」把它加进团队；
                                              提示会点出具体被拒的 agent，部分失败也会在 invalidBotIds 里列出）

与相邻命令的区别（别混）:
  - create-group --team：把同团队、已 opt-in 的别人机器上的 agent + 各自 owner 新建成一个聚焦新群。
  - bots invite --chat：群已经在了、且平台机器人也在，往里补同团队的人（含各自 owner）。
  - /invite（飞书群内 slash）：把 bot 加进当前群，走飞书原生加成员，限同租户；命令本身只拉 bot，
    owner 由被拉 bot 的 daemon 在入群事件里补拉（默认开启，可 per-bot 关，且需其 daemon 在线）——
    区别于本命令/create-group 由平台原子带上 owner（不依赖对方 daemon 在线）。

输出:
  - 成功 stdout 输出单行 chatId（与 create-group 一致）；失败 / 部分失败 stderr 打提示并非零退出。
`);
    return;
  }

  const { addTeamGroupMembers, fetchTeams, describeTeamAgentsFailure, rateLimitRetryHint, shouldTryAutoAddPlatformBot } =
    await import('./platform/team-agents-client.js');
  const jsonStatus = rest.includes('--json-status');
  const chatArg = (argValue(rest, '--chat') ?? '').trim();
  const appIds = [...new Set(argValues(rest, '--agent').map(s => s.trim()).filter(Boolean))];

  if (!chatArg) {
    console.error('用法: botmux bots invite --chat <chatId> --team <id> --agent <appId>...');
    console.error('--chat 必填：目标群 chatId（须已有平台机器人 BotmuxPlatform 在场，且你本人已在该群，非机器人大厅）。');
    console.error('补人恒把 agent + 各自 owner 一起拉进群。');
    process.exit(1);
  }
  if (appIds.length === 0) {
    console.error('至少一个 --agent <appId>（用 botmux bots list --scope team 发现 appId）。');
    process.exit(1);
  }

  const teamId = await resolveSingleTeamIdOrExit(fetchTeams, describeTeamAgentsFailure, argValue(rest, '--team'), '补人');

  let res = await addTeamGroupMembers({ chatId: chatArg, teamId, appIds });

  // (a) 自动化：撞 platform_bot_not_in_chat 且平台回传了 platformAppId → 用群里已有的本机 bot
  // 当代理，把平台后端 app 拉进目标群，再自动重试一次补人。让「往任意我在的群补人」尽量无感；
  // 碰到「加 bot 需群主审批 / 代理 bot 无成员管理 scope」时 addBotToChat 会失败，落回下面的手动提示。
  let autoAddAttempted = false;
  if (shouldTryAutoAddPlatformBot(res)) {
    const added = await tryAutoAddPlatformBot(chatArg, res.platformAppId);
    if (added.ok) {
      autoAddAttempted = true;
      console.error(`（已用群内 bot「${added.proxyName}」把平台应用拉进群，重试补人…）`);
      res = await addTeamGroupMembers({ chatId: chatArg, teamId, appIds });
    } else {
      // 自动拉失败：给可操作的手动引导（用平台回传的 app 名/id），不静默。
      const appLabel = res.platformAppName ? `${res.platformAppName}（${res.platformAppId}）` : res.platformAppId;
      console.error(`补人前置：平台应用不在目标群，且自动添加未成功（${added.reason}）。`);
      console.error(`请在群设置里手动添加应用：${appLabel}，然后重试 botmux bots invite。`);
      process.exit(1);
    }
  }

  if (!res.ok) {
    if (res.reason === 'unbound') console.error('本机未绑定平台。补人需要先 botmux bind。');
    else if (res.reason === 'not_deployed') console.error('平台尚未部署补人端点（/v1/machine/groups/:chatId/members）。等平台上线后重试。');
    else if (res.reason === 'rate_limited') console.error(`补人被限流，${rateLimitRetryHint(res)}。`);
    else if (res.reason === 'client' && res.status === 403) {
      // 403 分支（平台按 error code 返回）：可行性/归属/opt-in/大厅，各给可操作的提示。
      const which = res.appIds && res.appIds.length ? `（${res.appIds.join('、')}）` : '';
      const appLabel = res.platformAppName ? `${res.platformAppName}（${res.platformAppId ?? ''}）` : (res.platformAppId ?? '平台应用');
      const hint =
          res.error === 'platform_bot_not_in_chat'
            // 已自动拉过还撞它：飞书加 app 通常同步生效，多半是刚加完成员表还没刷新——提示稍等重试，
            // 别让用户对着刚拉进去的 app 再手动加一遍（pi review nit）。没自动拉过才引导手动添加。
            ? (autoAddAttempted
                ? `平台应用已自动拉进群、但补人仍报它不在——飞书成员同步通常几秒内完成，请稍等片刻重试 botmux bots invite`
                : `平台应用还不在目标群里——请在群设置添加应用：${appLabel}，再补人`)
        : res.error === 'requester_not_in_chat' ? '你本人还不在目标群里——只能往「你自己已在场」的群补人（先加入该群）'
        : res.error === 'requester_bot_not_in_chat' ? '你本人还不在目标群里——只能往「你自己已在场」的群补人（先加入该群）'
        : res.error === 'chat_is_hall' ? '目标群是机器人大厅，不允许往里补人（大厅是 bot-only 身份登记群）'
        : res.error === 'chat_not_in_team' ? '目标群不是本团队的协作群'
        : `相关 bot${which} 未由其 owner 在平台「管理机器人」加入该团队`;
      console.error(`补人被拒（403 ${res.error}）：${hint}。`);
    } else if (res.reason === 'client' && res.status === 404) {
      console.error(`团队不存在或本机 owner 不是其成员：teamId=${teamId}`);
    } else {
      console.error(`补人失败：${describeTeamAgentsFailure(res)}`);
    }
    process.exit(1);
  }

  const { invalidBotIds, invalidOwnerUnionIds } = res.value;
  console.log(chatArg); // stdout 单行 chatId（与 create-group 一致）
  const hasInvalid = invalidBotIds.length > 0 || invalidOwnerUnionIds.length > 0;
  if (jsonStatus) {
    console.log(JSON.stringify({ ok: true, chatId: chatArg, invalidBotIds, invalidOwnerUnionIds, teamId }));
  }
  // 补人幂等（已在群内视作成功）；平台 200 不列「实际加了谁」，成功即 invalid* 为空。
  if (!hasInvalid) console.error('✅ 补人成功（选中的 agent 及其 owner 均已在群内或已加入）。');
  if (invalidBotIds.length > 0) console.error(`⚠️ 以下 agent 未加入团队或补入失败：${invalidBotIds.join('、')}`);
  if (invalidOwnerUnionIds.length > 0) console.error(`⚠️ 以下 owner 未能补入：${invalidOwnerUnionIds.join('、')}`);
  if (hasInvalid) process.exitCode = 1;
}

// ─── botmux lang ─────────────────────────────────────────────────────────────

/** Notify every online daemon to hot-reload its UI locale from disk, so a
 *  `botmux lang` change takes effect on live cards without a restart. Best
 *  effort: unreachable daemons pick up the new value when they next restart. */
async function notifyDaemonsReloadLocale(): Promise<{ notified: number; failed: number }> {
  const daemons = listOnlineDaemons();
  let notified = 0;
  let failed = 0;
  await Promise.all(daemons.map(async (d) => {
    try {
      const r = await fetchDaemonIpc(d.ipcPort, '/api/locale/reload', { method: 'POST' });
      if (r.ok) notified++;
      else failed++;
    } catch { failed++; }
  }));
  return { notified, failed };
}

/** Fan the locale change out to live daemons and tell the user whether it took
 *  effect immediately or will apply on next daemon start. */
async function reportLocaleApplied(): Promise<void> {
  const { notified, failed } = await notifyDaemonsReloadLocale();
  if (notified > 0) {
    console.log(`✅ Applied live to ${notified} running daemon(s) — no restart needed.`);
  } else {
    console.log(`No running daemon to notify; the change applies when daemons next start.`);
  }
  if (failed > 0) {
    console.log(`(${failed} daemon(s) did not acknowledge; they'll pick it up on restart.)`);
  }
}

/**
 * `botmux lang [zh|en] [--bot N] [--unset]`
 *
 * No arg → print effective locale + per-bot overrides.
 * `zh|en` → write global `~/.botmux/config.json` (or, with `--bot N`, write
 *   the per-bot `lang` field in `bots.json`).
 * `--unset` → clear the global config's `lang` (or, with `--bot N`, drop
 *   the per-bot override).
 *
 * On any write, notify online daemons to hot-reload the locale (no restart) —
 * cards switch language on the next message; the change still persists for
 * future restarts.
 */
async function cmdLang(args: string[]): Promise<void> {
  ensureConfigDir();
  const cfg = readGlobalConfig();
  const globalLang: Locale | undefined = cfg.lang;

  const botFlagIdx = args.indexOf('--bot');
  const botFlag = botFlagIdx >= 0 ? parseInt(args[botFlagIdx + 1] ?? '', 10) : NaN;
  const unset = args.includes('--unset');
  const positional = args.filter((a, i) => {
    if (a === '--bot') return false;
    if (i > 0 && args[i - 1] === '--bot') return false;
    if (a === '--unset') return false;
    return true;
  });
  const target = positional[0]?.toLowerCase();

  // No-arg → status
  if (!target && !unset) {
    const bots = loadBotsJson();
    const effective = globalLang ?? 'zh';
    console.log(`Global lang: ${globalLang ?? '(unset, defaults to zh)'}`);
    console.log(`Effective for CLI:    ${effective}`);
    console.log(`Config file:          ${globalConfigPath()}`);
    if (bots.length > 0) {
      console.log('\nPer-bot:');
      bots.forEach((b: any, i: number) => {
        const explicit: string | undefined = isLocale(b.lang) ? b.lang : undefined;
        const eff = explicit ?? effective;
        const tag = explicit ? `${explicit} (explicit override)` : `${eff} (inherits global)`;
        console.log(`  ${i}. ${b.larkAppId} → ${tag}`);
      });
    }
    return;
  }

  // Per-bot operations require an existing bots.json index.
  if (!isNaN(botFlag)) {
    const bots = loadBotsJson();
    if (botFlag < 0 || botFlag >= bots.length) {
      console.error(`--bot index out of range; bots.json has ${bots.length} entry(ies). Use \`botmux lang\` to see indices.`);
      process.exit(1);
    }
    if (unset) {
      delete bots[botFlag].lang;
      writeBotsJsonAtomic(bots);
      console.log(`✅ Cleared per-bot lang for bot ${botFlag} (${bots[botFlag].larkAppId}).`);
    } else {
      if (!isLocale(target)) {
        console.error(`Unknown locale "${target}". Supported: ${SUPPORTED_LOCALES.join(', ')}.`);
        process.exit(1);
      }
      bots[botFlag].lang = target;
      writeBotsJsonAtomic(bots);
      console.log(`✅ Set bot ${botFlag} (${bots[botFlag].larkAppId}) lang → ${target}.`);
    }
    await reportLocaleApplied();
    return;
  }

  // Global operations
  if (unset) {
    setGlobalLocale(null);
    console.log(`✅ Cleared global lang (will default to zh).`);
    await reportLocaleApplied();
    return;
  }

  if (!isLocale(target)) {
    console.error(`Unknown locale "${target}". Supported: ${SUPPORTED_LOCALES.join(', ')}.`);
    console.error(`Usage: botmux lang [zh|en] [--bot N] [--unset]`);
    process.exit(1);
  }
  setGlobalLocale(target);
  console.log(`✅ Set global lang → ${target}.`);
  await reportLocaleApplied();
}

// ─── botmux preset ────────────────────────────────────────────────────────────

/**
 * `botmux preset <sub>` dispatcher. Currently only `export`.
 */
async function cmdPreset(sub: string, rest: string[]): Promise<void> {
  switch (sub) {
    case 'export':
      await cmdPresetExport(rest);
      break;
    default:
      console.error('用法: botmux preset export <bot> [--from-chat <chatId>] [--out <file>] [--yes]');
      process.exit(1);
  }
}

/**
 * `botmux preset export <bot> [--from-chat <chatId>] [--out <file>] [--yes]`
 *
 * Export a bot's **shareable, secret-free** preset (cliId / model / team role /
 * capability + an embedded guide) so a teammate's agent can self-configure a
 * matching bot. Never emits credentials or deployment fields — see
 * agent-preset.ts:buildPreset for the allow-list guarantee.
 *
 * Role source: team-level by default; `--from-chat <chatId>` exports that
 * group's role content instead (the chatId itself is dropped). Both role and
 * capability resolve under the effective data dir: this fn sets
 * `SESSION_DATA_DIR ??= resolveDataDir()` (SESSION_DATA_DIR → ~/.botmux
 * breadcrumb → default), and reads it via config.session.dataDir's lazy getter —
 * correct in agent sessions and bare-shell runs alike.
 */
async function cmdPresetExport(rest: string[]): Promise<void> {
  process.env.SESSION_DATA_DIR ??= resolveDataDir();

  const USAGE = '用法: botmux preset export <bot> [--from-chat <chatId>] [--out <file>] [--yes]';
  const selection = firstPositional(rest, ['--from-chat', '--out']);
  if (!selection) {
    console.error(USAGE);
    console.error('  <bot>  进程名 (botmux-xxx) 或 larkAppId');
    process.exit(1);
    return;
  }

  const bots = loadBotsJson();
  if (bots.length === 0) {
    console.error('❌ 没有可用的 bot：未找到 bots.json 或其中为空。先跑 `botmux setup`。');
    process.exit(1);
    return;
  }

  const idx = parseBotSelection(selection, bots);
  if (idx === undefined) {
    console.error(`❌ 找不到 bot "${selection}"。可选：`);
    bots.forEach((b: any, i: number) => {
      const appId = typeof b.larkAppId === 'string' ? b.larkAppId : '(无 larkAppId)';
      console.error(`   - ${botProcessName(b, i)}  (${appId})`);
    });
    process.exit(1);
    return;
  }

  const bot: any = bots[idx];
  const appId: string = typeof bot.larkAppId === 'string' ? bot.larkAppId : '';
  if (!appId) {
    console.error(`❌ bot "${selection}" 缺少 larkAppId，无法解析角色/能力。`);
    process.exit(1);
    return;
  }
  if (!bot.cliId || typeof bot.cliId !== 'string') {
    console.error(`❌ bot "${selection}" 缺少 cliId，无法导出预设。`);
    process.exit(1);
    return;
  }

  // Fail loudly when a flag was given without a value, instead of silently
  // exporting as if it weren't passed (e.g. a value-less `--from-chat` would
  // otherwise quietly fall back to the team role).
  if (flagPresentButValueMissing(rest, '--from-chat')) {
    console.error('❌ --from-chat 需要一个 chatId（如 oc_xxx）。');
    console.error(USAGE);
    process.exit(1);
    return;
  }
  if (flagPresentButValueMissing(rest, '--out', true)) {
    console.error('❌ --out 需要一个文件路径，或用 `--out -` 输出到 stdout。');
    console.error(USAGE);
    process.exit(1);
    return;
  }

  const fromChat = argValue(rest, '--from-chat');
  const out = argValue(rest, '--out');
  const skipConfirm = argFlag(rest, '--yes') || argFlag(rest, '-y');

  // capability + role read the SAME data dir. config.session.dataDir is a lazy
  // getter, so the SESSION_DATA_DIR set at the top of this fn (= resolveDataDir())
  // is honored — correct for both agent sessions AND bare-shell runs (no longer
  // the frozen packaged default).
  const dataDir = config.session.dataDir;
  const { resolveTeamRoleFile, resolveRoleFile } = await import('./core/role-resolver.js');
  const { getBotCapability } = await import('./services/bot-profile-store.js');

  let teamRole: string | null;
  if (fromChat) {
    teamRole = resolveRoleFile(appId, fromChat);
    if (teamRole === null) {
      console.error(`⚠️  群 ${fromChat} 下没有为该 bot 配置角色；导出将不含 teamRole（仍含 cliId/model/capability）。`);
    }
  } else {
    teamRole = resolveTeamRoleFile(appId);
    if (teamRole === null) {
      console.error('⚠️  该 bot 没有 team 级角色；导出将不含 teamRole。可加 `--from-chat <chatId>` 导出某群的角色内容。');
    }
  }

  const capability = getBotCapability(dataDir, appId);
  const sourceName = typeof bot.name === 'string' && bot.name.trim() ? bot.name.trim() : undefined;

  const preset = buildPreset({
    cliId: bot.cliId,
    model: typeof bot.model === 'string' ? bot.model : undefined,
    teamRole,
    capability,
    sourceName,
  });
  const json = serializePreset(preset);

  // Confirm before writing — the role may carry internal info. --yes skips.
  if (!skipConfirm) {
    if (!process.stdin.isTTY) {
      console.error('❌ 角色内容可能含内部信息，导出前需确认；非交互环境（如 agent 调用）请加 `--yes` 跳过确认。');
      process.exit(1);
      return;
    }
    if (teamRole || capability) {
      console.error('\n即将导出以下内容，请确认不含敏感/内部信息：');
      console.error('────────────────────────────────────────');
      if (teamRole) console.error(`[角色 teamRole]\n${teamRole}`);
      if (capability) console.error(`[能力标签 capability] ${capability}`);
      console.error('────────────────────────────────────────');
    } else {
      console.error('\n（无角色 / 能力标签内容，仅导出 cliId/model）');
    }
    // Prompt on stderr so a piped stdout (--out -) stays clean.
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    const answer = (await ask(rl, '确认导出？输入 y 继续，其它取消: ')).trim().toLowerCase();
    rl.close();
    if (answer !== 'y' && answer !== 'yes') {
      console.error('已取消，未写入任何文件。');
      process.exit(1);
      return;
    }
  }

  // stdout mode: the JSON must own stdout; all chatter goes to stderr.
  if (out === '-') {
    process.stdout.write(json);
    console.error('✅ 已输出到 stdout。本文件不含任何密钥（larkAppId/secret/allowedUsers 等均未包含）。');
    return;
  }

  const outPath = out ?? `./${presetFilename(sourceName, appId)}`;
  try {
    writeFileSync(outPath, json, 'utf-8');
  } catch (err: any) {
    console.error(`❌ 写入 ${outPath} 失败: ${err?.message ?? String(err)}`);
    process.exit(1);
    return;
  }
  console.error(`✅ 已导出预设到 ${outPath}`);
  console.error('   本文件不含任何密钥（larkAppId/secret/allowedUsers/workingDir 等均未包含），可安全分享。');
}

// ─── Main ────────────────────────────────────────────────────────────────────

function getVersion(): string {
  // The compiled single-file executable has no package.json on disk (the module
  // graph is in the virtual read-only /$bunfs), so this read always failed there
  // and `--version` printed `unknown`. The build bakes the version in instead.
  const baked = bakedBinaryVersion();
  if (baked) return baked;
  const pkgPath = join(PKG_ROOT, 'package.json');
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    return pkg.version || 'unknown';
  } catch {
    return 'unknown';
  }
}

const command = process.argv[2];

// Single-file-executable self-hosting: when botmux is a `bun build --compile`
// binary, it cannot spawn `node dist/index-*.js` (no dist/ on disk). Instead the
// daemon/core-only/worker/supervisor/dashboard spawners re-exec THIS binary with
// a hidden subcommand (see src/core/self-spawn.ts). Handle those tokens FIRST —
// gate and normal dispatch — by importing the corresponding entry module (each
// bootstraps on import and then owns the process lifecycle) and then AWAITING a
// never-resolving promise so control never reaches normal dispatch. Under Node
// these tokens are never used (spawners pass the real dist/*.js path).
const __entrySubcommand = command && ENTRY_SUBCOMMANDS.has(command) ? entryForSubcommand(command) : null;
if (__entrySubcommand) {
  // Bun's --compile can't bundle a fully-dynamic import specifier, so switch on
  // a static import per entry — the same modules the Node path spawns as files.
  if (__entrySubcommand === 'core-only') await import('./index-core-only.js');
  else if (__entrySubcommand === 'daemon') await import('./index-daemon.js');
  else if (__entrySubcommand === 'worker') await import('./worker.js');
  else if (__entrySubcommand === 'supervisor') await import('./index-supervisor.js');
  else if (__entrySubcommand === 'dashboard') await import('./index-dashboard.js');
  // CLI-adapter runners. Same mechanism, different role: these ARE the CLI session
  // process an adapter launches, not a fleet member. Without these branches the
  // compiled binary re-execed itself with a `/$bunfs/…-runner.js` argv[0] that
  // dispatch did not recognise, so it printed help and exited 0 — the user saw a
  // help dump instead of a session, and nothing reported an error.
  else if (__entrySubcommand === 'codex-app-runner') await import('./codex-app-runner.js');
  else if (__entrySubcommand === 'dsh-runner') await import('./dsh-runner.js');
  else if (__entrySubcommand === 'mira-runner') await import('./mira-runner.js');
  else if (__entrySubcommand === 'mir-runner') await import('./mir-runner.js');
  // The entry module now drives the process (top-level main() keeps the event
  // loop alive for the daemon; the worker's IPC listener does the same; a
  // core-only bind failure exits from within). Park here so the normal dispatch
  // below never runs. This awaits forever; the imported module owns exit().
  await new Promise<never>(() => {});
}

// Hidden: perform a compiled-binary self-replace and exit. Invoked by
// `runSelfReplaceBlocking` (src/core/maintenance.ts) so the synchronous
// maintenance tick / dashboard handler can wait on one child instead of
// restructuring around an await. Not a user-facing command; it only ever makes
// sense for the standalone binary, which owns its own file.
if (command === '__self-update') {
  const requested = process.argv[3] || 'latest';
  try {
    const { replaceStandaloneBinary, currentBinaryInstallShape } = await import('./core/binary-self-update.js');
    if (currentBinaryInstallShape() !== 'curl-binary') {
      // Fail closed rather than write into a tree a package manager owns.
      console.error('__self-update: 当前不是独立二进制安装（install.sh 形态），拒绝自替换');
      process.exit(1);
    }
    const { fetchLatestVersion } = await import('./core/update-check.js');
    const version = requested === 'latest' ? await fetchLatestVersion() : requested;
    if (!version) {
      console.error('__self-update: 无法解析最新版本（网络不可达或 registry 异常）');
      process.exit(1);
    }
    const r = await replaceStandaloneBinary(version);
    // The caller parses this line: after a self-replace the running process still
    // reports its OWN baked version, so it cannot discover the new one by re-reading.
    console.log(`BOTMUX_SELF_UPDATE_VERSION=${version}`);
    console.log(`__self-update: ${r.asset} → ${r.target} (${r.bytes} bytes)`);
    process.exit(0);
  } catch (error) {
    console.error(`__self-update: ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  }
}


const ROOT_FLEET_MUTATION_COMMANDS = new Set(['start', 'stop', 'restart', 'upgrade', 'update']);
// Flags each fleet command legitimately accepts, on top of --help/-h.
// This has to be an explicit table and cannot be inferred from the handler
// signature: `cmdStart` / `cmdStop` / `cmdRestart` / `cmdUpgrade` are all
// declared with zero parameters and still read `process.argv` directly.
// `cmdStop` and `cmdRestart` pull `--with-plugin` out of it, and the same shape
// exists elsewhere in this file — `cmdLogs` (`--lines` / `--no-follow` /
// `--bot`), `cmdList` (`--plain`), `cmdSuspend`, `cmdSlash`. A zero-parameter
// handler therefore says nothing about which flags a command accepts; the only
// thing that does is this table, so a new flag must be added here as well.
// `start` is deliberately empty: `startConfiguredFleet` unconditionally calls
// `reconcilePluginServicesForCli(undefined, { autoOnly: true })`, so start
// already brings auto plugin services up and `--with-plugin` would be a no-op
// there — its meaning on stop/restart is "also tear the plugin service down",
// and start has no tear-down phase.
const FLEET_KNOWN_FLAGS: Record<string, readonly string[]> = {
  start: [],
  stop: ['--with-plugin'],
  restart: ['--with-plugin'],
  upgrade: [],
  update: [],
};
if (ROOT_FLEET_MUTATION_COMMANDS.has(command ?? '')) {
  const fleetArgs = process.argv.slice(3);
  if (fleetArgs.some(arg => arg === '--help' || arg === '-h')) {
    showHelp();
    process.exit(0);
  }
  // Fail closed on anything else. Without this branch an unrecognized flag
  // falls through and the command runs at FULL effect — `botmux update --check`
  // and `botmux update --dry-run` read like probes and upgrade the whole fleet.
  // The failure is silent and one-directional: the user who typed a guess gets
  // the most destructive interpretation of it, and the flags most likely to be
  // guessed are exactly the read-only ones.
  // Exact set difference rather than `unknownFlags()`: that helper only reports
  // tokens starting with `-`, so `botmux stop foo` would be waved through. None
  // of these commands takes a positional argument either, so anything outside
  // the table above is unknown, flag-shaped or not.
  const knownFleetFlags = FLEET_KNOWN_FLAGS[command ?? ''] ?? [];
  const unknownFleetArgs = fleetArgs.filter(arg => !knownFleetFlags.includes(arg));
  if (unknownFleetArgs.length > 0) {
    console.error(`未知参数: ${unknownFleetArgs.join(' ')}`);
    console.error(`  \`botmux ${command}\` 只接受: ${['--help', ...knownFleetFlags].join(' ')}。`);
    console.error('  为避免把一个看起来像「只检查」的参数当成「执行」，这里直接中止，不做任何改动。');
    process.exit(2);
  }
}

// Workflow safety gate (Slice C0): a CLI invoked inside a workflow
// subagent worker (BOTMUX_WORKFLOW=1, set by v3/ephemeral-pool) must not
// trigger chat-facing effects, schedule mutations, or recursively authorize /
// mutate workflows.  Side effects belong in `hostExecutor` activities so they
// get `effectAttempted` tracking + reconcile; workflow authorization belongs
// to the host/user. Read-only commands stay allowed for introspection.
if (process.env.BOTMUX_WORKFLOW === '1') {
  // Default-deny the root command surface. New botmux commands otherwise
  // silently become available to a bypass-permission workflow worker until
  // someone remembers to extend a blacklist. Keep only explicit read-only
  // introspection plus CLI startup plumbing; mutating subcommands under
  // schedule/workflow/template/v3 are filtered again below. `mcp serve` is
  // the stable, botmux-owned Plugin gateway configured for the parent CLI —
  // it must start inside workflow workers, while every other/future `mcp`
  // subcommand remains default-denied here.
  const allowedRoot = new Set([
    undefined,
    '--help',
    '-h',
    'help',
    '--version',
    '-v',
    'capabilities',
    'status',
    'history',
    'quoted',
    'bots',
    'skill',
    'hook',
    // Local-only, session-capability-bound preview registration. It has no chat,
    // workflow, deployment, or external messaging effect.
    'preview',
    'session-ready',
    'mcp',
    'ask', // dedicated cmdAsk guard emits the humanGate-specific guidance
    'schedule',
    'workflow',
    'template',
    'v3',
  ]);
  const rootDenied = !allowedRoot.has(command);
  const mcpSub = command === 'mcp' ? (process.argv[3] ?? '') : '';
  const mcpDenied = command === 'mcp' && mcpSub !== 'serve';
  const isSchedule = command === 'schedule';
  const scheduleSub = isSchedule ? (process.argv[3] ?? '') : '';
  const blockedScheduleSub = new Set([
    'add',
    'rm',
    'remove',
    'del',
    'delete',
    'pause',
    'disable',
    'resume',
    'enable',
    'run',
  ]);
  const workflowSub = command === 'workflow' ? (process.argv[3] ?? '') : '';
  const blockedWorkflowSub = new Set([
    // v3 grill / authorization state changes.
    'new',
    'spec-finalize',
    'approve-spec',
    'revise-spec',
    'architect',
    'revise-dag',
    'approve-dag',
    // Saved Workflow creation / execution and live-run mutations.
    'save',
    'run',
    'start',
    'retry',
    'grant',
    'cancel',
  ]);
  const templateSub = command === 'template' ? (process.argv[3] ?? '') : '';
  const blockedTemplateSub = new Set(['migrate-v3', 'archive-runs']);
  const v3Sub = command === 'v3' ? (process.argv[3] ?? '') : '';
  const workflowMutation =
    (command === 'workflow' && blockedWorkflowSub.has(workflowSub)) ||
    (command === 'template' && blockedTemplateSub.has(templateSub)) ||
    (command === 'v3' && v3Sub === 'run');
  if (
    rootDenied ||
    mcpDenied ||
    (isSchedule && blockedScheduleSub.has(scheduleSub)) ||
    workflowMutation
  ) {
    const runId = process.env.BOTMUX_WORKFLOW_RUN_ID ?? '?';
    const nodeId = process.env.BOTMUX_WORKFLOW_NODE_ID ?? '?';
    const sub = isSchedule
      ? scheduleSub
      : command === 'mcp'
        ? mcpSub
        : command === 'workflow'
          ? workflowSub
          : command === 'template'
            ? templateSub
            : command === 'v3'
              ? v3Sub
              : '';
    const guidance = mcpDenied
      ? 'Only the botmux-owned Plugin MCP gateway bootstrap (`mcp serve`) is available inside a workflow subagent.'
      : workflowMutation
        ? 'Workflow authorization and run mutations must be initiated by the host/user, not a subagent.'
        : rootDenied
          ? 'This root command is not in the workflow read-only allowlist; chat-facing effects belong in a hostExecutor activity.'
          : 'Chat-facing or schedule-mutating effects belong in a hostExecutor activity, not a subagent.';
    console.error(
      `botmux ${command}${sub ? ` ${sub}` : ''} refused inside workflow ` +
      `subagent (run=${runId} node=${nodeId}).  ${guidance}`,
    );
    process.exit(2);
  }
}

/**
 * `botmux voice` — standalone voice-summary configuration (advanced feature,
 * intentionally NOT folded into `botmux setup`). Writes the global `voice`
 * block to ~/.botmux/config.json. Subcommands: (none)=interactive setup,
 * `status`=show masked config, `disable`=remove.
 */
async function cmdVoiceSetup(args: string[]): Promise<void> {
  const sub = (args[0] ?? '').toLowerCase();
  const { readGlobalConfig, mergeGlobalConfig } = await import('./global-config.js');
  const { DEFAULT_SAMI_SPEAKER, DEFAULT_OPENAI_SPEAKER } = await import('./services/voice/index.js');
  const mask = (s?: string) => (s ? `${s.slice(0, 4)}***` : '(未设)');

  if (sub === 'status') {
    const v = readGlobalConfig().voice;
    if (!v) { console.log('语音功能未配置。运行 `botmux voice` 配置。'); return; }
    console.log('当前语音配置（全局 ~/.botmux/config.json）:');
    console.log(`  引擎: ${v.engine ?? '(自动)'}`);
    console.log(`  音色: ${v.speaker ?? '(默认)'}`);
    if (typeof v.rate === 'number') console.log(`  语速: ${v.rate}`);
    if (v.sami) console.log(`  SAMI: accessKey=${mask(v.sami.accessKey)} secretKey=${mask(v.sami.secretKey)} appkey=${v.sami.appkey ?? '(未设)'}${v.sami.tokenUrl ? ` tokenUrl=${v.sami.tokenUrl}` : ''}`);
    if (v.openai) console.log(`  OpenAI: baseUrl=${v.openai.baseUrl ?? '(未设)'} model=${v.openai.model ?? '(未设)'} apiKey=${mask(v.openai.apiKey)}`);
    return;
  }
  if (sub === 'disable' || sub === 'off') {
    mergeGlobalConfig({ voice: null });
    console.log('✅ 已移除全局语音配置（回复卡片不再显示「🔊 语音总结」按钮）。重启 daemon 生效。');
    return;
  }
  if (sub === 'asr') {
    const asrSub = (args[1] ?? '').toLowerCase();
    const maskAsr = (s?: string) => (s ? `${s.slice(0, 4)}***` : '(未设)');
    if (asrSub === 'status') {
      const asr = readGlobalConfig().voice?.asr;
      if (!asr) { console.log('语音识别（ASR）未配置。运行 `botmux voice asr` 配置。'); return; }
      console.log('当前 ASR 配置（全局 ~/.botmux/config.json）:');
      console.log(`  启用: ${asr.enabled ? '是' : '否'}`);
      console.log(`  baseUrl: ${asr.baseUrl ?? '(未设)'}`);
      console.log(`  model: ${asr.model ?? '(未设)'}`);
      console.log(`  apiKey: ${maskAsr(asr.apiKey)}`);
      if (asr.language) console.log(`  语言: ${asr.language}`);
      if (typeof asr.timeoutMs === 'number') console.log(`  超时: ${asr.timeoutMs}ms`);
      return;
    }
    if (asrSub === 'disable' || asrSub === 'off') {
      const curVoice = readGlobalConfig().voice ?? {};
      mergeGlobalConfig({ voice: { ...curVoice, asr: { ...(curVoice.asr ?? {}), enabled: false } } as any });
      console.log('✅ 已关闭语音识别（ASR）。重启 daemon 生效。');
      return;
    }
    if (asrSub && asrSub !== 'setup') {
      console.error('用法: botmux voice asr [status|disable]（无参 = 交互式配置）');
      process.exit(1);
    }
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      console.log('🎤 配置语音识别（ASR）。飞书语音消息将转写为文本驱动会话。写入全局 ~/.botmux/config.json，重启后生效。\n');
      const baseUrl = (await ask(rl, 'baseUrl（OpenAI 兼容，如 https://api.openai.com/v1）: ')).trim();
      const apiKey = (await ask(rl, 'apiKey（无则留空）: ')).trim();
      const model = (await ask(rl, 'model（如 whisper-1）: ')).trim();
      if (!baseUrl || !model) { console.error('❌ baseUrl 和 model 必填，未写入。'); return; }
      const language = (await ask(rl, '语言提示（可选，如 zh，留空跳过）: ')).trim();
      const curVoice = readGlobalConfig().voice ?? {};
      const asr: Record<string, any> = {
        enabled: true,
        baseUrl,
        model,
        ...(apiKey ? { apiKey } : {}),
        ...(language ? { language } : {}),
      };
      mergeGlobalConfig({ voice: { ...curVoice, asr } as any });
      console.log('\n✅ 已写入 voice.asr 配置。`botmux restart` 后，发给机器人的语音消息会自动转写。');
      console.log('   查看：`botmux voice asr status`  关闭：`botmux voice asr disable`');
    } finally {
      rl.close();
    }
    return;
  }
  if (sub && sub !== 'setup') {
    console.error('用法: botmux voice [status|disable]（无参 = 交互式配置）');
    process.exit(1);
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log('🔊 配置语音总结（高级功能）。写入全局 ~/.botmux/config.json，重启后生效。\n');
    const eng = (await ask(rl, '选择 TTS 引擎  [1] SAMI（需 AK/SK/appkey）  [2] OpenAI 兼容（自带 baseUrl/key）: ')).trim();
    const voice: Record<string, any> = {};
    if (eng === '2' || /openai/i.test(eng)) {
      voice.engine = 'openai';
      const baseUrl = (await ask(rl, 'baseUrl（如 https://api.openai.com/v1，自托管如 http://127.0.0.1:8880/v1）: ')).trim();
      const apiKey = (await ask(rl, 'apiKey（无则留空）: ')).trim();
      const model = (await ask(rl, 'model（如 tts-1 / kokoro）: ')).trim();
      if (!baseUrl || !model) { console.error('❌ baseUrl 和 model 必填，未写入。'); return; }
      voice.openai = { baseUrl, apiKey, model };
      const sp = (await ask(rl, `音色 voice（留空=默认 ${DEFAULT_OPENAI_SPEAKER}）: `)).trim();
      if (sp) voice.speaker = sp;
    } else {
      voice.engine = 'sami';
      const accessKey = (await ask(rl, 'SAMI accessKey: ')).trim();
      const secretKey = (await ask(rl, 'SAMI secretKey: ')).trim();
      const appkey = (await ask(rl, 'SAMI appkey: ')).trim();
      if (!accessKey || !secretKey || !appkey) { console.error('❌ accessKey/secretKey/appkey 都必填，未写入。'); return; }
      voice.sami = { accessKey, secretKey, appkey };
      const sp = (await ask(rl, `音色 speaker（留空=默认灿灿 ${DEFAULT_SAMI_SPEAKER}）: `)).trim();
      if (sp) voice.speaker = sp;
      const adv = (await ask(rl, '自定义 SAMI 端点？一般不用，回车跳过 (y/N): ')).trim().toLowerCase();
      if (adv === 'y') {
        const tokenUrl = (await ask(rl, 'tokenUrl（留空用默认）: ')).trim();
        const wsUrl = (await ask(rl, 'wsUrl（留空用默认）: ')).trim();
        if (tokenUrl) voice.sami.tokenUrl = tokenUrl;
        if (wsUrl) voice.sami.wsUrl = wsUrl;
      }
    }
    const rate = (await ask(rl, '语速倍率（留空=1.1）: ')).trim();
    if (rate && !Number.isNaN(Number(rate))) voice.rate = Number(rate);

    mergeGlobalConfig({ voice: voice as any });
    console.log('\n✅ 已写入 voice 配置。`botmux restart` 后，配了语音的机器人回复卡片底部会出现「🔊 语音总结」按钮。');
    console.log('   查看：`botmux voice status`  关闭：`botmux voice disable`');

    // 语音合成产物要编码成飞书语音气泡用的 opus，依赖系统的 opusenc(opus-tools)。
    // 缺了就当场帮用户装（沿用 ensure-tmux 的包管理器/sudo 机制）。
    const { ensureOpusTools, probeOpusenc } = await import('./setup/ensure-opus.js');
    if (!probeOpusenc()) {
      console.log('\n⚠️  未检测到 opus 编码器（opus-tools）——语音合成需要它把音频转成飞书语音格式。');
      const yes = (await ask(rl, '现在自动安装 opus-tools？(Y/n): ')).trim().toLowerCase();
      if (yes === '' || yes === 'y' || yes === 'yes') {
        const r = await ensureOpusTools();
        if (r.installed) console.log(`✅ opus-tools 就绪${r.version ? `（${r.version}）` : ''}`);
        else {
          console.log(`未能自动安装：${r.reason ?? ''}`);
          console.log(`请手动安装后再用语音：${r.manualCommand ?? 'apt-get install -y opus-tools / brew install opus-tools'}`);
        }
      } else {
        console.log('已跳过。记得手动安装：Debian/Ubuntu `sudo apt-get install -y opus-tools`，macOS `brew install opus-tools`。');
      }
    }
  } finally {
    rl.close();
  }
}

function formatPluginServiceReports(reports: Array<{ pluginId: string; action: string; status?: string; mode?: string; openUrl?: string; warning?: string }>): string {
  if (reports.length === 0) return '无插件 host service。';
  return reports.map(r => {
    const status = r.status ? r.action === 'stopped' ? ` (was ${r.status})` : ` (${r.status})` : '';
    const mode = r.mode ? ` mode=${r.mode}` : '';
    const openUrl = r.openUrl ? ` url=${r.openUrl}` : '';
    const warning = r.warning ? ` ⚠ ${r.warning}` : '';
    return `- ${r.pluginId}: ${r.action}${status}${mode}${openUrl}${warning}`;
  }).join('\n');
}

async function reconcilePluginServicesForCli(
  pluginIds?: string[],
  options: { autoOnly?: boolean } = {},
): Promise<void> {
  const { startPluginServices } = await import('./core/plugins/service-manager.js');
  const reports = await startPluginServices(pluginIds, { autoOnly: options.autoOnly });
  if (reports.length > 0) {
    console.log('\n插件 host service:');
    console.log(formatPluginServiceReports(reports));
  }
}

async function stopPluginServicesForCli(
  pluginIds?: string[],
  options: { autoOnly?: boolean } = {},
): Promise<import('./core/plugins/service-manager.js').PluginServiceReport[]> {
  const { stopPluginServices } = await import('./core/plugins/service-manager.js');
  const reports = await stopPluginServices(pluginIds, { autoOnly: options.autoOnly });
  if (reports.length > 0) {
    console.log('\n插件 host service:');
    console.log(formatPluginServiceReports(reports));
  }
  return reports;
}

function requirePluginId(raw: string | undefined): string {
  const id = raw?.trim();
  if (!id || !isValidPluginId(id)) {
    console.error('❌ 插件 id 非法。要求: 小写字母开头，只能包含小写字母/数字/._-，长度 1-64。');
    process.exit(1);
  }
  return id;
}

function findArgValue(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx >= 0 ? args[idx + 1] : undefined;
}

function addPluginId(list: unknown, pluginId: string): string[] {
  const current = normalizePluginIdList(list) ?? [];
  return current.includes(pluginId) ? current : [...current, pluginId];
}

function removePluginId(list: unknown, pluginId: string): string[] {
  return (normalizePluginIdList(list) ?? []).filter(id => id !== pluginId);
}

function updateGlobalPluginBinding(pluginId: string, enable: boolean): void {
  const current = readGlobalConfig().plugins ?? [];
  const next = enable ? addPluginId(current, pluginId) : removePluginId(current, pluginId);
  mergeGlobalConfig({ plugins: next.length > 0 ? next : null });
}

function failPluginDependency(error: unknown): never {
  const message = describePluginDependencyError(error);
  if (!message) throw error;
  console.error(`❌ ${message}`);
  process.exit(1);
}

function assertPluginBindingTransitionForCli(pluginId: string, enable: boolean, enabledPluginIds: readonly string[]): void {
  try {
    assertPluginBindingTransition(pluginId, enable, enabledPluginIds, readPluginRegistryCached());
  } catch (error) {
    failPluginDependency(error);
  }
}

function updateBotPluginBinding(
  pluginId: string,
  botSelector: string,
  enable: boolean,
  beforeWrite?: () => void,
): number {
  const bots = loadBotsJson();
  if (bots.length === 0) {
    console.error('❌ 未找到 bots.json 或没有 bot 配置。');
    process.exit(1);
  }
  const indexes = botSelector === 'all'
    ? bots.map((_, index) => index)
    : (() => {
        const idx = parseBotSelection(botSelector, bots);
        if (idx === undefined) {
          console.error(`❌ 找不到 bot: ${botSelector}`);
          process.exit(1);
        }
        return [idx];
      })();
  const machineDefaults = normalizePluginIdList(readGlobalConfig().plugins) ?? [];
  if (machineDefaults.includes(pluginId)) {
    console.error(`❌ 插件 ${pluginId} 已全局启用；请先关闭全局启用，再按 Bot 配置。`);
    process.exit(1);
  }
  for (const idx of indexes) {
    const current = Object.prototype.hasOwnProperty.call(bots[idx], 'plugins') ? bots[idx].plugins : undefined;
    const effective = resolveEffectivePluginIds(
      { plugins: normalizePluginIdList(current) ?? [] },
      { plugins: machineDefaults },
    );
    assertPluginBindingTransitionForCli(pluginId, enable, effective);
  }
  beforeWrite?.();
  for (const idx of indexes) {
    const current = Object.prototype.hasOwnProperty.call(bots[idx], 'plugins') ? bots[idx].plugins : undefined;
    const next = updateBotPluginOverride(current, pluginId, enable);
    if (next.length > 0) bots[idx].plugins = next;
    else delete bots[idx].plugins;
  }
  writeBotsAtomic(BOTS_JSON_FILE, bots);
  return indexes.length;
}

function removePluginBindingsEverywhere(pluginId: string): void {
  updateGlobalPluginBinding(pluginId, false);
  const bots = loadBotsJson();
  let changed = false;
  for (const bot of bots) {
    if (!Object.prototype.hasOwnProperty.call(bot, 'plugins')) continue;
    const next = removePluginId(bot.plugins, pluginId);
    const before = normalizePluginIdList(bot.plugins) ?? [];
    if (before.length !== next.length) changed = true;
    if (next.length > 0) bot.plugins = next;
    else delete bot.plugins;
  }
  if (changed) writeBotsAtomic(BOTS_JSON_FILE, bots);
  const pinnedPlugins = normalizePluginIdList(readGlobalConfig().dashboard?.pinnedPlugins) ?? [];
  if (pinnedPlugins.includes(pluginId)) {
    mergeDashboardConfig({ pinnedPlugins: pinnedPlugins.filter(id => id !== pluginId) });
  }
}

async function removePluginSkillRegistryEntries(pluginId: string): Promise<void> {
  const { readSkillRegistry, removeInstalledSkill } = await import('./services/skill-registry-store.js');
  const { pluginRuntimeDir, pluginHome, resolvePluginPath } = await import('./core/plugins/paths.js');
  const { getInstalledPlugin } = await import('./services/plugin-registry-store.js');
  const roots = new Set<string>([pluginHome(pluginId)]);
  const record = getInstalledPlugin(pluginId);
  const skillEntries = record?.contributions?.skills ?? (record?.manifest as any)?.skills ?? [];
  for (const entry of skillEntries) {
    try {
      const skillDir = resolvePluginPath(pluginRuntimeDir(pluginId), entry.path, 'skill_path');
      roots.add(skillDir);
      if (existsSync(skillDir)) roots.add(realpathSync(skillDir));
    } catch {
      /* best effort cleanup */
    }
  }
  const isWithinPluginSkill = (value: string | undefined): boolean => {
    if (!value) return false;
    const candidates = [value];
    try { if (existsSync(value)) candidates.push(realpathSync(value)); } catch { /* ignore */ }
    return candidates.some(candidate => [...roots].some(root => candidate === root || candidate.startsWith(`${root}/`)));
  };
  const registry = readSkillRegistry();
  for (const skill of Object.values(registry.skills)) {
    const sourcePath = skill.source.type === 'local-link' ? skill.source.path : undefined;
    if (isWithinPluginSkill(skill.rootDir) || isWithinPluginSkill(sourcePath)) {
      removeInstalledSkill(skill.name);
    }
  }
}

function assertPluginInstalled(pluginId: string): void {
  const { plugins } = readPluginRegistryCached();
  if (!plugins[pluginId]) {
    console.error(`❌ 插件未安装: ${pluginId}`);
    console.error(`   先运行: botmux plugin install ${pluginId}`);
    process.exit(1);
  }
}

let pluginRegistryCache: import('./core/plugins/types.js').PluginRegistryFile | null = null;
function readPluginRegistryCached(): import('./core/plugins/types.js').PluginRegistryFile {
  if (pluginRegistryCache) return pluginRegistryCache;
  // Synchronous top-level dynamic import is not available; this function is
  // only used after cmdPlugin has loaded the registry into the cache.
  throw new Error('plugin_registry_cache_not_loaded');
}

async function loadPluginRegistryForCommand(): Promise<import('./core/plugins/types.js').PluginRegistryFile> {
  const { readPluginRegistry } = await import('./services/plugin-registry-store.js');
  pluginRegistryCache = readPluginRegistry();
  return pluginRegistryCache;
}

function printPluginUsage(): void {
  console.log(`用法:
  botmux plugin list
  botmux plugin init <plugin-id|botmux-plugin-id|@botmux-ai/plugin-id>
  botmux plugin install <npm-package|local-dir> [--link]
  botmux plugin uninstall <plugin-id> [--force]
  botmux plugin enable <plugin-id> [--bot <name|index|all>]
  botmux plugin disable <plugin-id> [--bot <name|index|all>]
  botmux plugin emit <plugin-id> --bot <process-name|app-id>  # JSON 从 stdin 读取
  botmux <plugin-command> [args...]
  botmux plugin service status
  botmux plugin service start [plugin-id|--all]
  botmux plugin service stop [plugin-id|--all]
  botmux plugin service restart [plugin-id|--all]
`);
}

function printPluginServiceRunningError(err: unknown): boolean {
  if (!err || typeof err !== 'object' || (err as any).code !== 'plugin_service_running') return false;
  const pluginId = String((err as any).pluginId ?? 'unknown');
  const operation = String((err as any).operation ?? 'update');
  const status = String((err as any).serviceStatus ?? 'unknown');
  const pid = typeof (err as any).pid === 'number' ? `, PID ${(err as any).pid}` : '';
  const operationLabel = operation === 'uninstall' ? '卸载' : operation === 'install' ? '安装' : '更新';
  console.error(`❌ 无法${operationLabel}插件 ${pluginId}：插件服务仍在运行（${status}${pid}）。`);
  console.error(`   请先运行: botmux plugin service stop ${pluginId}`);
  console.error('   Botmux 不会在安装、更新或卸载时隐式停止插件服务。');
  return true;
}

function printPluginServiceDeleteError(err: unknown): boolean {
  if (!err || typeof err !== 'object' || (err as any).code !== 'plugin_service_delete_failed') return false;
  const failures = Array.isArray((err as any).failures) ? (err as any).failures : [];
  const details = failures
    .map((failure: any) => `${String(failure.pluginId ?? 'unknown')}: ${String(failure.warning ?? 'PM2 删除失败')}`)
    .join('; ');
  console.error('❌ 插件服务的 PM2 记录删除失败，插件未卸载。');
  if (details) console.error(`   ${details}`);
  console.error('   请确认 PM2 可用后重新执行卸载；Botmux 未清理插件文件、配置或绑定。');
  return true;
}

async function cmdPlugin(args: string[]): Promise<void> {
  const sub = (args[0] ?? 'list').toLowerCase();
  if (sub === 'help' || sub === '--help' || sub === '-h') {
    printPluginUsage();
    return;
  }

  if (sub === 'install') {
    const spec = args[1];
    if (!spec) { printPluginUsage(); process.exit(1); }
    const { installPlugin } = await import('./core/plugins/install.js');
    const { resolveOfficialPluginPackageSpec } = await import('./core/plugins/init.js');
    const resolvedSpec = resolveOfficialPluginPackageSpec(spec);
    let result;
    try {
      result = installPlugin(resolvedSpec, { link: args.includes('--link') });
    } catch (err) {
      if (printPluginServiceRunningError(err)) {
        process.exitCode = 1;
        return;
      }
      throw err;
    }
    const enabledPlugins = normalizePluginIdList(readGlobalConfig().plugins) ?? [];
    if (enabledPlugins.includes(result.record.id)) {
      const { materializePlugin } = await import('./core/plugins/materializer.js');
      materializePlugin(result.record.id);
    }
    console.log(`✅ 已安装插件 ${result.record.id} (${result.record.packageName}@${result.record.version})`);
    return;
  }

  if (sub === 'init') {
    const rawName = args[1];
    if (!rawName) { printPluginUsage(); process.exit(1); }
    const { initPlugin } = await import('./core/plugins/init.js');
    try {
      const result = initPlugin(rawName);
      console.log(`✅ 已创建插件: ${result.displayName}`);
      console.log(`   目录: ${result.targetDir}`);
      console.log(`   npm 包名: ${result.packageName}`);
      console.log(`   插件 id: ${result.pluginId}`);
      console.log(`   默认命令: botmux ${result.commandPrefix}hello`);
      console.log('');
      console.log('下一步:');
      console.log(`   cd ${result.repoName}`);
      console.log('   botmux plugin install . --link');
      console.log(`   botmux plugin enable ${result.pluginId}`);
      console.log(`   botmux ${result.commandPrefix}hello`);
    } catch (err: any) {
      console.error(`❌ 创建插件失败: ${err?.message ?? String(err)}`);
      process.exit(1);
    }
    return;
  }

  const registry = await loadPluginRegistryForCommand();

  if (sub === 'emit') {
    const pluginId = requirePluginId(args[1]);
    assertPluginInstalled(pluginId);
    const botSelector = findArgValue(args, '--bot');
    if (!botSelector) {
      console.error('❌ plugin emit 需要 --bot <process-name|app-id>。');
      process.exitCode = 1;
      return;
    }

    const bots = loadBotsJson();
    const botIndex = parseBotSelection(botSelector, bots);
    if (botIndex === undefined || typeof bots[botIndex]?.larkAppId !== 'string') {
      console.error(`❌ 找不到 bot: ${botSelector}`);
      process.exitCode = 1;
      return;
    }
    const bot = bots[botIndex];
    const enabledPluginIds = resolveEffectivePluginIds(bot, readGlobalConfig());
    if (!enabledPluginIds.includes(pluginId)) {
      console.error(`❌ 插件 ${pluginId} 未对 Bot(${botSelector}) 启用。`);
      process.exitCode = 1;
      return;
    }

    const input = await readStdin();
    if (!input.trim()) {
      console.error('❌ plugin emit 需要从 stdin 读取 JSON 事件。');
      process.exitCode = 1;
      return;
    }
    if (Buffer.byteLength(input, 'utf8') > 64 * 1024) {
      console.error('❌ plugin emit 事件超过 64 KiB。');
      process.exitCode = 1;
      return;
    }
    let event: unknown;
    try {
      event = JSON.parse(input);
    } catch {
      console.error('❌ plugin emit 收到的 stdin 不是合法 JSON。');
      process.exitCode = 1;
      return;
    }

    const daemon = findDaemon(bot.larkAppId);
    if (!daemon) {
      console.error(`❌ Bot(${botSelector}) daemon 未运行。`);
      process.exitCode = 1;
      return;
    }
    const response = await fetchDaemonIpc(daemon.ipcPort, '/api/plugin-events', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pluginId, targetBotAppId: bot.larkAppId, event }),
    });
    const responseText = await response.text();
    if (!response.ok) {
      console.error(`❌ 插件事件投递失败 (${response.status}): ${responseText || response.statusText}`);
      process.exitCode = 1;
      return;
    }
    console.log(responseText || JSON.stringify({ ok: true, status: 'accepted' }));
    return;
  }

  if (sub === 'list' || sub === 'ls') {
    const plugins = Object.values(registry.plugins).sort((a, b) => a.id.localeCompare(b.id));
    if (plugins.length === 0) {
      console.log('暂无已安装插件。');
      return;
    }
    const globalPlugins = new Set(readGlobalConfig().plugins ?? []);
    for (const plugin of plugins) {
      const flags = [
        globalPlugins.has(plugin.id) ? 'enabled' : '',
      ].filter(Boolean).join(' ');
      console.log(`${plugin.id}\t${plugin.packageName}@${plugin.version}${flags ? `\t${flags}` : ''}`);
    }
    return;
  }

  if (sub === 'enable' || sub === 'disable') {
    const pluginId = requirePluginId(args[1]);
    assertPluginInstalled(pluginId);
    const enable = sub === 'enable';
    if (args.includes('--global')) {
      console.error('❌ 机器默认是默认作用域，不需要 --global。');
      console.error(`   用法: botmux plugin ${sub} ${pluginId} [--bot <name|index|all>]`);
      process.exit(1);
    }
    const botSelector = findArgValue(args, '--bot');
    if (args.includes('--bot') && !botSelector) {
      console.error('❌ --bot 后需要 bot 名称、序号或 all。');
      process.exit(1);
    }
    const { materializePlugin, dematerializePlugin } = await import('./core/plugins/materializer.js');
    if (enable) {
      if (botSelector) {
        updateBotPluginBinding(pluginId, botSelector, true, () => materializePlugin(pluginId));
      } else {
        const current = normalizePluginIdList(readGlobalConfig().plugins) ?? [];
        assertPluginBindingTransitionForCli(pluginId, true, current);
        materializePlugin(pluginId);
        updateGlobalPluginBinding(pluginId, true);
      }
    } else {
      if (botSelector) {
        updateBotPluginBinding(pluginId, botSelector, false);
      } else {
        const current = normalizePluginIdList(readGlobalConfig().plugins) ?? [];
        assertPluginBindingTransitionForCli(pluginId, false, current);
        updateGlobalPluginBinding(pluginId, false);
      }
      const stillReferenced = (normalizePluginIdList(readGlobalConfig().plugins) ?? []).includes(pluginId)
        || loadBotsJson().some(bot => (normalizePluginIdList(bot.plugins) ?? []).includes(pluginId));
      if (!stillReferenced) dematerializePlugin(pluginId);
    }
    console.log(`✅ 已${enable ? '启用' : '禁用'}${botSelector ? ` Bot(${botSelector})` : '机器默认'}插件: ${pluginId}`);
    return;
  }

  if (sub === 'uninstall' || sub === 'remove' || sub === 'rm') {
    const pluginId = requirePluginId(args[1]);
    assertPluginInstalled(pluginId);
    const {
      assertPluginServiceStopped,
      deletePluginServicesOrThrowUnlocked,
      withPluginServiceLock,
    } = await import('./core/plugins/service-manager.js');
    const { dematerializePlugin } = await import('./core/plugins/materializer.js');
    const { readPluginRegistry, removeInstalledPlugin } = await import('./services/plugin-registry-store.js');
    const { pluginHome } = await import('./core/plugins/paths.js');
    try {
      await withPluginServiceLock(async () => {
        const lockedRegistry = readPluginRegistry();
        const installed = lockedRegistry.plugins[pluginId];
        if (!installed) throw new Error(`plugin_not_installed:${pluginId}`);

        const enabledEverywhere = new Set(normalizePluginIdList(readGlobalConfig().plugins) ?? []);
        for (const bot of loadBotsJson()) {
          for (const id of normalizePluginIdList(bot.plugins) ?? []) enabledEverywhere.add(id);
        }
        const dependents = enabledPluginDependents(pluginId, [...enabledEverywhere], lockedRegistry);
        if (dependents.length > 0) {
          throw new Error(`plugin_has_enabled_dependents:${pluginId}:${dependents.join(',')}`);
        }
        if (installed.manifest.service) {
          assertPluginServiceStopped(pluginId, 'uninstall');
        }

        await deletePluginServicesOrThrowUnlocked([pluginId]);
        dematerializePlugin(pluginId);
        await removePluginSkillRegistryEntries(pluginId);
        removeInstalledPlugin(pluginId);
        removePluginBindingsEverywhere(pluginId);
        rmSync(pluginHome(pluginId), { recursive: true, force: true });
      });
    } catch (err) {
      if (err instanceof Error && err.message.startsWith(`plugin_has_enabled_dependents:${pluginId}:`)) {
        const dependents = err.message.slice(`plugin_has_enabled_dependents:${pluginId}:`.length).split(',').filter(Boolean);
        console.error(`❌ 不能卸载 ${pluginId}，以下已启用插件依赖它: ${dependents.join(', ')}`);
        console.error('   请先在对应作用域显式禁用这些插件。');
        process.exitCode = 1;
        return;
      }
      if (printPluginServiceRunningError(err)) {
        process.exitCode = 1;
        return;
      }
      if (printPluginServiceDeleteError(err)) {
        process.exitCode = 1;
        return;
      }
      throw err;
    }
    console.log(`✅ 已卸载插件: ${pluginId}`);
    return;
  }

  if (sub === 'service' || sub === 'services') {
    const action = (args[1] ?? 'status').toLowerCase();
    const rawId = args[2];
    const pluginIds = !rawId || rawId === '--all' ? undefined : [requirePluginId(rawId)];
    if (action === 'status' || action === 'list') {
      const { listPluginServiceStatus } = await import('./core/plugins/service-manager.js');
      console.log(formatPluginServiceReports(await listPluginServiceStatus()));
      return;
    }
    if (action === 'start') {
      await reconcilePluginServicesForCli(pluginIds);
      return;
    }
    if (action === 'stop') {
      await stopPluginServicesForCli(pluginIds);
      return;
    }
    if (action === 'restart') {
      await stopPluginServicesForCli(pluginIds);
      await reconcilePluginServicesForCli(pluginIds);
      return;
    }
    printPluginUsage();
    process.exit(1);
  }

  printPluginUsage();
  process.exit(1);
}

async function runPluginCommandByName(rawCommand: string, commandArgs: string[]): Promise<boolean> {
  const sessionId = process.env.BOTMUX_SESSION_ID?.trim();
  const { readSessionPluginManifest } = await import('./core/plugins/session-manifest.js');
  const pluginIds = sessionId
    ? readSessionPluginManifest(sessionId)?.pluginIds ?? []
    : normalizePluginIdList(readGlobalConfig().plugins) ?? [];
  if (pluginIds.length === 0) return false;
  const { collectPluginCliCommands } = await import('./core/plugins/runtime.js');
  const commands = await collectPluginCliCommands(pluginIds);
  const matches = commands.filter(command => command.name === rawCommand);
  if (matches.length === 0) return false;
  if (matches.length > 1) {
    console.error(`❌ 插件 CLI 命令冲突: ${rawCommand}`);
    console.error(`   冲突插件: ${matches.map(command => command.pluginId).join(', ')}`);
    console.error('   请禁用其中一个插件，或让插件作者改用唯一 command 名称。');
    process.exit(1);
  }
  const command = matches[0];
  const registry = await loadPluginRegistryForCommand();
  const record = registry.plugins[command.pluginId];
  const { pluginRuntimeDir } = await import('./core/plugins/paths.js');
  const result = await command.run({
    runtime: 'cli',
    pluginId: command.pluginId,
    pluginDir: pluginRuntimeDir(command.pluginId),
    packageName: record?.packageName ?? command.pluginId,
    version: record?.version ?? '0.0.0',
    manifest: record?.manifest ?? { schemaVersion: 1, id: command.pluginId },
    args: commandArgs,
  });
  if (typeof result === 'string') console.log(result);
  if (typeof result === 'number') process.exitCode = result;
  return true;
}

// ─── Central root-dispatch transport gate ──────────────────────────────────
// A MANAGED no-transport turn (a CLI turn the daemon spawned for an apiOnly bot
// or an HTTP virtual session) must not run ANY Lark-facing command. The managed
// origin is resolved via the pid-marker ANCESTRY (resolveSessionContext walks
// process.ppid to a worker-written marker) — NOT the mutable BOTMUX_SESSION_ID
// env — so `env -u BOTMUX_SESSION_ID … botmux create-group` cannot shed the
// managed identity. We then load THAT session's record and gate on its chatId +
// its bot's apiOnly (config, not env), so unsetting BOTMUX_CHAT_ID/LARK_APP_ID
// also can't flip the verdict. Covers every Feishu-facing verb by construction.
// A BARE host-operator shell (no ancestry marker, no env session) resolves no
// managed origin → NOT gated: the operator keeps full access. per-command +
// daemon-side getBotClient/larkTransportEnabled gates remain authoritative.
const LARK_FACING_COMMANDS = new Set([
  'send', 'dispatch', 'card', 'create-group', 'history', 'quoted', 'bots', 'grant', 'react', 'thread',
  'vc-agent', 'report', 'actor',
]);
if (LARK_FACING_COMMANDS.has(command) && managedOriginHasNoTransport()) {
  console.error(
    `botmux ${command} is unavailable: this managed turn has no Feishu transport ` +
    `(core-only apiOnly bot or HTTP control-API session).\n` +
    `Feishu read/write is not possible for this turn — it communicates only over the HTTP\n` +
    `control API (input via trigger, output via trigger-result). Produce your normal answer.`,
  );
  process.exit(2);
}

switch (command) {
  case '--version':
  case '-v':      console.log(getVersion()); break;
  case 'capabilities': {
    const { botmuxCapabilities, parseCapabilitiesArgs } = await import('./cli/capabilities.js');
    const parsed = parseCapabilitiesArgs(process.argv.slice(3));
    if (!parsed.ok) {
      console.error(parsed.error);
      process.exitCode = 2;
      break;
    }
    process.stdout.write(`${JSON.stringify(botmuxCapabilities())}\n`);
    break;
  }
  case 'actor': {
    const { parseCurrentActorArgs, resolveBotmuxAncestorContext, resolveCurrentActor } = await import('./cli/current-actor.js');
    const parsed = parseCurrentActorArgs(process.argv.slice(3));
    if (!parsed.ok) {
      console.error(parsed.error);
      process.exitCode = 2;
      break;
    }
    try {
      const { ipcPort, sessionId } = resolveBotmuxAncestorContext();
      const actor = await resolveCurrentActor({
        ipcPort,
        sessionId,
      });
      process.stdout.write(`${JSON.stringify(actor)}\n`);
    } catch {
      process.stdout.write(`${JSON.stringify({
        schema: 'botmux.current-actor.v2',
        status: 'blocked',
        error: 'current_actor_unverified',
      })}\n`);
      process.exitCode = 2;
    }
    break;
  }
  case 'setup': {
    // 带子命令（list/add/configure/edit/remove/help）走脚本化非 TUI 模式；空参数 / 纯
    // flag（如 --no-open-platform-auto）保持原交互 TUI，向后兼容。
    const setupArgs = process.argv.slice(3);
    if (isScriptedSetupInvocation(setupArgs)) await cmdSetupScripted(setupArgs);
    else await cmdSetup();
    break;
  }
  case 'clone': await cmdClone(process.argv.slice(3)); break;
  case 'start':   await cmdStart(); break;
  case 'serve':   await cmdServe(process.argv.slice(3)); break;
  case 'start-bot': await cmdStartBot(process.argv.slice(3)); break;
  case 'stop-bot': await cmdStopBot(process.argv.slice(3)); break;
  case 'stop':    await cmdStop(); break;
  case 'restart': await cmdRestart(); break;
  case 'logs':    await cmdLogs(); break;
  case 'status':  await cmdStatus(); break;
  case 'upgrade':
  case 'update':  await cmdUpgrade(); break;
  case 'dashboard': await cmdDashboard(process.argv.slice(3)); break;
  case 'bind': {
    // `botmux bind <code>` — 把本机绑定到中心化平台
    const { cmdBind } = await import('./platform/bind.js');
    await cmdBind(process.argv.slice(3));
    break;
  }
  case 'device': {
    const { runDeviceCommand } = await import('./platform/device-command.js');
    process.exitCode = await runDeviceCommand(process.argv.slice(3));
    break;
  }
  case 'mojo-containment': {
    // The auditable operator exit for fail-closed containment blockers that can
    // never self-release (weak handles on non-cgroup hosts, unprovable handles).
    const { runMojoContainmentCommand } = await import('./core/mojo-containment-command.js');
    process.exitCode = await runMojoContainmentCommand(process.argv.slice(3));
    break;
  }
  case 'list':
  case 'ls':      await cmdList(); break;
  case '__zmx-attach-managed': cmdManagedZmxAttach(process.argv.slice(3)); break;
  // Hidden self-check for the compiled single-file binary: exercise the two
  // setup-time code paths that load lark-scopes.json off a module-relative path —
  // readDefaultScopeManifest() (real Open Platform setup) and
  // writeScopesJsonToConfigDir() (writes ~/.botmux/lark-scopes.json). In compiled
  // mode the module graph lives in the read-only virtual /$bunfs, so the old
  // readFileSync/copyFileSync of a __dirname-derived path threw
  // "找不到 botmux lark-scopes.json". The npm/Node unit tests can't catch that —
  // dist/ physically exists there — so smoke-bun-binary.mjs drives THIS against
  // the actual binary. Prints a one-line JSON summary and exits 0; any throw
  // (missing/empty manifest, unwritable path) exits non-zero and fails the smoke.
  case '__selfcheck': {
    const { readDefaultScopeManifest } = await import('./setup/open-platform-automation.js');
    const manifest = readDefaultScopeManifest();
    const tenant = manifest.scopes?.tenant?.length ?? 0;
    const user = manifest.scopes?.user?.length ?? 0;
    if (tenant <= 0 || user <= 0) {
      console.error(`__selfcheck: lark-scopes manifest empty (tenant=${tenant}, user=${user})`);
      process.exit(1);
    }
    const written = writeScopesJsonToConfigDir();
    const onDisk = JSON.parse(readFileSync(written, 'utf-8'));
    const wroteTenant = onDisk?.scopes?.tenant?.length ?? 0;
    const wroteUser = onDisk?.scopes?.user?.length ?? 0;
    if (wroteTenant !== tenant || wroteUser !== user) {
      console.error(`__selfcheck: written manifest mismatch (${wroteTenant}/${wroteUser} vs ${tenant}/${user})`);
      process.exit(1);
    }
    console.log(JSON.stringify({ ok: true, tenant, user, written }));
    process.exit(0);
  }
  case 'delete':
  case 'del':
  case 'rm':      await cmdDelete(); break;
  case 'resume':  await cmdResume(); break;
  case 'suspend': await cmdSuspend(); break;
  case 'slash':   await cmdSlash(); break;
  case 'cd': {
    // Tombstone for the removed `botmux cd`（改名为 `botmux role switch`）。**必须
    // fail-loud**：存量部署里 _role-protocol.md 若还没刷新、模型仍发 `botmux cd`，
    // 静默 exit 0 会让它以为切换成功（实际什么都没做）——「假切换成功」比明确报错
    // 危险得多。所以这里打印迁移提示、退 1、绝不执行任何切换。
    console.error('✗ `botmux cd` 已移除，改用 `botmux role switch <角色目录>`（同一切换语义）。');
    console.error('  本次未执行任何切换。若你是角色协议（_role-protocol.md）触发的，请把命令刷新为 `botmux role switch`。');
    process.exit(1);
    break;
  }
  case 'role': {
    // `botmux role switch <角色目录>` — 角色切换（唯一入口）。名字→目录的解析由
    // 调用方（模型读 _role-protocol.md）完成，本命令只透传解析出的目标目录，daemon
    // 侧硬校验目录必须在 ~/botmux-roles 下。
    const sub = process.argv[3] ?? '';
    if (sub === 'switch') { await cmdRoleSwitch(process.argv.slice(4)); break; }
    console.error(`用法: botmux role switch <目标角色目录（含空格建议加引号）> [--session <id>]`);
    process.exit(1);
    break;
  }
  case 'term-link': await cmdTermLink(process.argv.slice(3)); break;
  case 'preview': await cmdPreview(process.argv.slice(3)); break;
  case 'schedule': await cmdSchedule(process.argv[3] ?? '', process.argv.slice(4)); break;
  case 'ask': {
    // `botmux ask buttons --options ...` → sub='buttons', rest=['--options', ...]
    // `botmux ask --options ...`         → sub='',        rest=['--options', ...]  (bare alias)
    const { normalizeAskDispatch } = await import('./core/ask-args.js');
    const { sub, rest } = normalizeAskDispatch(process.argv.slice(3));
    await cmdAsk(sub, rest);
    break;
  }
  case 'skill': {
    const { runSkillSessionCommand } = await import('./core/skills/cli-session-command.js');
    const result = runSkillSessionCommand(process.argv.slice(3));
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    process.exitCode = result.code;
    break;
  }
  case 'skills': {
    const { runSkillsAdminCommand } = await import('./core/skills/cli-admin-command.js');
    const result = runSkillsAdminCommand(process.argv.slice(3));
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    process.exitCode = result.code;
    break;
  }
  case 'customize': {
    const { runCustomizeCommand } = await import('./core/skills/customize-command.js');
    const result = runCustomizeCommand(process.argv.slice(3));
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    process.exitCode = result.code;
    break;
  }
  case 'mcp': {
    const sub = process.argv[3] ?? '';
    if (sub !== 'serve') {
      console.error('用法: botmux mcp serve');
      process.exitCode = 2;
      break;
    }
    if (!process.env.SESSION_DATA_DIR?.trim()) {
      process.env.SESSION_DATA_DIR = resolveDataDir();
    }
    const { runMcpGateway } = await import('./core/plugins/mcp/gateway.js');
    await runMcpGateway();
    break;
  }
  case 'hook': {
    // `botmux hook <cliId>` — hook 客户端，stdin 读 payload，stdout 写 directive
    const cliId = process.argv[3] ?? '';
    await cmdHook(cliId);
    break;
  }
  case 'codex-watch-hook': {
    // 稳定兼容命令：现有 Codex Hook 已信任该字符串，迁入 core 后不改名。
    // 尚未写入内建配置时继续交给已启用的旧插件，避免升级瞬间静默停采集。
    if (
      readGlobalConfig().codexNotifier === undefined
      && await runPluginCommandByName('codex-watch-hook', process.argv.slice(3))
    ) {
      break;
    }
    const { runCodexNotifierHookCli } = await import('./features/codex-notifier/index.js');
    await runCodexNotifierHookCli();
    break;
  }
  case 'codex-watch-install-hook': {
    const { installCodexNotifierHook } = await import('./features/codex-notifier/index.js');
    const legacyStopOnly = readGlobalConfig().codexNotifier === undefined;
    const result = installCodexNotifierHook({
      mode: legacyStopOnly ? 'legacy-stop' : 'full',
    });
    const label = legacyStopOnly ? 'Codex 通知兼容 Stop Hook' : 'Codex 通知 Hook';
    console.log(result.changed
      ? `已安装 ${label}：${result.path}`
      : `${label} 已存在：${result.path}`);
    break;
  }
  case 'codex-watch-status': {
    const {
      isCodexNotifierHookInstalled,
      isCodexNotifierWorkerStateFresh,
      listCodexNotifierOutbox,
      readCodexNotifierWorkerState,
      resolveCodexNotifierConfig,
    } = await import('./features/codex-notifier/index.js');
    const dataDir = resolveDataDir();
    const resolved = resolveCodexNotifierConfig();
    const worker = readCodexNotifierWorkerState(dataDir);
    console.log(JSON.stringify({
      ...resolved,
      hookInstalled: isCodexNotifierHookInstalled(),
      pendingCount: listCodexNotifierOutbox(dataDir).length,
      targetDaemonOnline: resolved.targetBotAppId
        ? findDaemon(resolved.targetBotAppId) !== null
        : false,
      workerOnline: isCodexNotifierWorkerStateFresh(worker),
      worker,
    }, null, 2));
    break;
  }
  case 'session-ready': {
    // `botmux session-ready` — Claude 家族 SessionStart hook 客户端，通知 daemon
    // 已越过外层 selector；worker 再等待 hook 后的新 prompt 证据。
    await cmdSessionReady();
    break;
  }
  case 'user-prompt-hook': {
    // `botmux user-prompt-hook` — Claude 家族 UserPromptSubmit hook 客户端，
    // 按内容指纹读回 per-turn sidecar 并注入为该轮 system-reminder（#794）。
    await cmdUserPromptHook();
    break;
  }
  case 'workflow': {
    const wfSub = process.argv[3] ?? '';
    if (wfSub === 'cancel') {
      // Durable v3 run cancellation. The v2 runtime is retired.
      await cmdWorkflowCancelV3(process.argv[4], process.argv.slice(5));
      break;
    }
    if (wfSub === 'start') {
      // `botmux workflow start <runId>` — kick a daemon-driven v3 run (so
      // humanGate posts approval cards).  Needs a live daemon; findDaemon is
      // cli.ts-local so this case handles it instead of cmdWorkflow.
      await cmdWorkflowStart(process.argv[4], process.argv.slice(5));
      break;
    }
    if (wfSub === 'retry') {
      // v3 blocked-node retry; the former v2 `resume` verb is retired.
      await cmdWorkflowRetry(process.argv[4], process.argv.slice(5));
      break;
    }
    if (wfSub === 'grant') {
      // v3 exhausted-loop grant (+1 iteration).
      await cmdWorkflowGrant(process.argv[4], process.argv.slice(5));
      break;
    }
    const { cmdWorkflow } = await import('./cli/workflow.js');
    await cmdWorkflow(wfSub, process.argv.slice(4));
    break;
  }
  case 'template': {
    const { cmdTemplate } = await import('./cli/workflow.js');
    await cmdTemplate(process.argv[3] ?? '', process.argv.slice(4));
    break;
  }
  case 'v3': {
    // `botmux v3 run <dag.json>` — run a hand-written next-gen (v3) DAG on the
    // real ephemeral worker pool, daemon-independent (dogfood path).
    const { cmdV3 } = await import('./workflows/v3/cli-run.js');
    await cmdV3(process.argv[3] ?? '', process.argv.slice(4));
    break;
  }
  case 'goal': {
    const goalSub = process.argv[3] ?? '';
    if (['start', 'supervise', 'notify-parent', 'charter'].includes(goalSub)) {
      await cmdGoal(goalSub, process.argv.slice(4));
    } else {
      const { cmdGoal: cmdWorkflowGoal } = await import('./workflows/v3/goal-cli.js');
      process.exitCode = await cmdWorkflowGoal(goalSub, process.argv.slice(4));
    }
    break;
  }
  case 'send':     await cmdSend(process.argv.slice(3)); break;
  case 'card':     await cmdCard(process.argv.slice(3)); break;
  case 'chat':     await cmdChat(process.argv.slice(3)); break;
  case 'dispatch': await cmdDispatch(process.argv.slice(3)); break;
  case 'report': await cmdReport(process.argv.slice(3)); break;
  case 'grant': await cmdExactChatGrant(process.argv.slice(3)); break;
  case 'help': await cmdHelp(process.argv.slice(3)); break;
  case 'delivery': await cmdDelivery(process.argv[3] ?? '', process.argv.slice(4)); break;
  case 'create-group': await cmdCreateGroup(process.argv.slice(3)); break;
  case 'bots':     await cmdBots(process.argv[3] ?? 'list', process.argv.slice(4)); break;
  case 'preset':   await cmdPreset(process.argv[3] ?? '', process.argv.slice(4)); break;
  case 'history':  await cmdHistory(process.argv.slice(3)); break;
  case 'quoted':   await cmdQuoted(process.argv.slice(3)); break;
  case 'lang':     await cmdLang(process.argv.slice(3)); break;
  case 'voice':    await cmdVoiceSetup(process.argv.slice(3)); break;
  case 'vc-agent': {
    const { cmdVcAgent } = await import('./cli/vc-agent.js');
    await cmdVcAgent(process.argv[3] ?? '', process.argv.slice(4));
    break;
  }
  case 'plugin':
  case 'plugins':  await cmdPlugin(process.argv.slice(3)); break;
  case 'whiteboard':
  case 'wb':       await cmdWhiteboard(process.argv[3] ?? 'status', process.argv.slice(4)); break;
  case 'thread':   {
    // Removed in favor of `botmux history` (普通群也兼容). Friendly stderr so
    // pre-rename scripts/skills surface the rename instead of "unknown command".
    const sub = process.argv[3] ?? '';
    console.error(
      sub === 'messages' || sub === 'msgs'
        ? `\`botmux thread ${sub}\` 已重命名为 \`botmux history\` (跑普通群和话题群都用它)。`
        : `\`botmux thread\` 已下线，请用 \`botmux history\``,
    );
    process.exit(1);
    break;
  }
  case 'autostart': {
    ensureConfigDir();
    const sub = process.argv[3] ?? 'status';
    const opts = { pkgRoot: PKG_ROOT, configDir: CONFIG_DIR, logDir: LOG_DIR };
    if (sub === 'enable' || sub === 'install') enableAutostart(opts);
    else if (sub === 'disable' || sub === 'uninstall') disableAutostart(opts);
    else if (sub === 'status') autostartStatus(opts);
    else { console.error(`用法: botmux autostart <enable|disable|status>`); process.exit(1); }
    break;
  }
  default:
    if (!await runPluginCommandByName(command, process.argv.slice(3))) showHelp();
    break;
}
