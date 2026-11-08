/**
 * Live §6.1 eligibility probe for "节点交给群里的 Bot 执行" (design
 * 2026-11-03 §6.3): membership is checked through the main bot's own Lark app
 * (the same strict resolver `botmux dispatch --bot-app` uses), liveness through
 * the local daemon registry, and the talk-only chat grant through the same
 * matrix call dispatch makes. Used at Gate-2 (`approve-dag`), Saved Workflow
 * materialization and before every handoff.
 */

import { ensureBotChatGrantMatrix } from '../../cli/exact-chat-grant-client.js';
import { fetchDaemonIpc, loadDaemonIpcSecret } from '../../core/daemon-ipc-auth.js';
import {
  WORKFLOW_OPERATOR_BUDGET_MS,
  WORKFLOW_WORKING_DIR_OPERATOR_ROUTE,
  withinOperatorBudget,
  type WorkflowOperateAnswer,
  type WorkflowWorkingDirOperatorRequest,
} from '../../core/workflow-working-dir-operator.js';
import { config } from '../../config.js';
import { findOnlineDaemon } from '../../utils/daemon-discovery.js';
import { readBotsInfoJson } from '../../services/bots-info-cache.js';
import { normalizeBotsInfoRouteEntries } from '../../services/bots-info-shape.js';
import type { BotConfig } from '../../bot-registry.js';
import { isMultiTopicOrchestrationEnabled, workflowHandoffIdentityEnabled, workflowNodeExecutorMode } from '../../global-config.js';
import { readSessionRowCopiesAcrossStores } from '../../services/session-store.js';
import { comparableSessionDir, unpinnedSessionWorkingDir } from '../../core/working-dir-range.js';
import type { RunChatBinding } from '../../workflows/v3/grill-state.js';
import type { V3MainTopicAvailability } from '../../workflows/v3/placement.js';
import {
  v3MainTopicAvailability,
  v3OpensTopicSessions,
  type V3BotEligibilityProbe,
  type V3HandoffIdentityPolicy,
  type V3NodeExecutorPolicy,
} from '../../workflows/v3/node-executor-mode.js';
import { getChatModeStrict, resolveCurrentChatBotOpenIdsByLarkAppIds, resolveUnionIdFromOpenIdStrict } from './client.js';

export interface LiveV3BotEligibilityInput {
  orchestratorAppId: string;
  chatId: string;
  /** The deployment's bots.json (membership + per-chat reply modes). */
  bots: readonly BotConfig[];
  dataDir?: string;
  /** Host secret for the chat-grant IPC; read lazily (default ~/.botmux). */
  secret?: () => string;
}

export function createLiveV3BotEligibilityProbe(input: LiveV3BotEligibilityInput): V3BotEligibilityProbe {
  const dataDir = input.dataDir ?? config.session.dataDir;
  const byAppId = new Map(input.bots.map((bot) => [bot.larkAppId, bot]));
  return {
    isConfigured: (appId) => byAppId.has(appId),
    opensTopicSessions: async (appId) => v3OpensTopicSessions(
      await getChatModeStrict(input.orchestratorAppId, input.chatId),
      byAppId.get(appId),
      input.chatId,
    ),
    isDaemonOnline: (appId) => {
      try {
        return findOnlineDaemon(appId, dataDir) !== null;
      } catch {
        return false;
      }
    },
    inChat: async (appId) => {
      const resolved = await resolveCurrentChatBotOpenIdsByLarkAppIds(input.orchestratorAppId, input.chatId, [appId]);
      if (resolved.ok) return 'yes';
      if (resolved.error === 'subject_lark_app_not_in_chat') return 'no';
      return { unknown: `${resolved.error}: ${resolved.message}` };
    },
    ensureGrant: async (appId) => {
      await ensureBotChatGrantMatrix(input.chatId, [input.orchestratorAppId, appId], {
        findDaemon: (larkAppId) => findOnlineDaemon(larkAppId, dataDir),
        secret: input.secret ?? (() => loadDaemonIpcSecret()),
      });
    },
  };
}

/**
 * §5.2 hard rule 3 from the persisted main session of the run (any process:
 * the CLI at Gate-2, the daemon at Saved Workflow materialization). A row
 * that cannot be read exactly once is "unknown" — the caller refuses `main`.
 */
export function liveV3MainTopicAvailability(binding: RunChatBinding, dataDir: string = config.session.dataDir): V3MainTopicAvailability {
  let session: { scope?: 'thread' | 'chat'; rootMessageId?: string | null } | undefined;
  try {
    const rows = binding.sessionId ? readSessionRowCopiesAcrossStores(binding.sessionId, dataDir).matches : [];
    session = rows.length === 1 ? rows[0] : undefined;
  } catch {
    session = undefined;
  }
  return v3MainTopicAvailability(binding, session);
}

/**
 * The directory the run's main session runs in, in comparison form
 * (`v3MainSessionDirProblem`), read from its persisted row like
 * {@link liveV3MainTopicAvailability}. A row that never pinned a directory
 * runs where the daemon's `getSessionWorkingDir` puts it — the main bot's
 * unpinned default (`unpinnedSessionWorkingDir`, from `bots`). Undefined =
 * unknown or no constraint: no single readable row, a closed session (the
 * node would start a new one), or an unpinned row whose bot is not in `bots`
 * — the runtime gate then stays the only check.
 */
export function liveV3MainSessionWorkingDir(
  binding: RunChatBinding,
  bots: readonly BotConfig[],
  dataDir: string = config.session.dataDir,
): string | undefined {
  try {
    const rows = binding.sessionId ? readSessionRowCopiesAcrossStores(binding.sessionId, dataDir).matches : [];
    const row = rows.length === 1 ? rows[0] : undefined;
    if (!row || row.status === 'closed') return undefined;
    if (typeof row.workingDir === 'string' && row.workingDir.trim()) return comparableSessionDir(row.workingDir);
    const bot = bots.find((candidate) => candidate.larkAppId === binding.larkAppId);
    return bot ? comparableSessionDir(unpinnedSessionWorkingDir(bot)) : undefined;
  } catch {
    return undefined;
  }
}

/** Display name from the shared bots-info.json, falling back to the app id. */
export function v3BotDisplayNameResolver(dataDir: string = config.session.dataDir): (larkAppId: string) => string {
  let names = new Map<string, string>();
  try {
    names = new Map(normalizeBotsInfoRouteEntries(readBotsInfoJson(dataDir))
      .filter((entry) => entry.botName)
      .map((entry) => [entry.larkAppId, entry.botName!]));
  } catch { /* unreadable → ids */ }
  return (larkAppId) => names.get(larkAppId) ?? larkAppId;
}

/**
 * 交接带发起人身份 seams (design §10.2): the initiator's union_id through the
 * main bot's own app (strict: a definitive miss and a transient failure stay
 * distinguishable), and the tools a sender runs as themselves on a bot — its
 * `triggerUserAuth.tools` while that policy is on.
 */
export function createLiveV3HandoffIdentityPolicy(bots: readonly BotConfig[]): V3HandoffIdentityPolicy {
  return {
    lookupUnionId: (larkAppId, openId) => resolveUnionIdFromOpenIdStrict(larkAppId, openId),
    botTools: (larkAppId) => {
      const policy = bots.find((bot) => bot.larkAppId === larkAppId)?.triggerUserAuth;
      return policy?.enabled ? [...policy.tools] : [];
    },
  };
}

/**
 * Gate-2's §15.4 operate check (approve-dag, a CLI process): each executing
 * bot's own daemon answers whether the pending run's initiator may operate it
 * ({@link WORKFLOW_WORKING_DIR_OPERATOR_ROUTE}). The question names only the
 * run and one node that bot executes; the daemon reads the initiator, the
 * chat and the node's bot from the run itself, gets the initiator's union_id
 * from the main bot's daemon when it is another bot (the same source it uses
 * when the node starts), and judges with its own configuration and grants.
 * An offline daemon, an older one without the route, or any failure is
 * `unknown`.
 */
export interface LiveV3WorkingDirOperatorDeps {
  /** The bot's online daemon IPC port (default: the daemon registry). */
  daemonPort?(larkAppId: string): number | undefined;
  /** POST over trusted host IPC (default: {@link fetchDaemonIpc}). */
  post?(port: number, path: string, body: WorkflowWorkingDirOperatorRequest): Promise<{ status: number; body: unknown }>;
  dataDir?: string;
}

export function createLiveV3WorkingDirOperator(
  run: { runId: string },
  deps: LiveV3WorkingDirOperatorDeps = {},
): (target: { nodeId: string; larkAppId: string }) => Promise<WorkflowOperateAnswer> {
  const dataDir = deps.dataDir ?? config.session.dataDir;
  const daemonPort = deps.daemonPort ?? ((appId: string) => findOnlineDaemon(appId, dataDir)?.ipcPort);
  const post = deps.post ?? (async (port: number, path: string, body: WorkflowWorkingDirOperatorRequest) => {
    const response = await fetchDaemonIpc(port, path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }, loadDaemonIpcSecret());
    return { status: response.status, body: await response.json().catch(() => undefined) };
  });
  async function ask(target: { nodeId: string; larkAppId: string }): Promise<WorkflowOperateAnswer> {
    const port = daemonPort(target.larkAppId);
    if (!port) return { unknown: '它的 daemon 不在线' };
    const response = await post(port, WORKFLOW_WORKING_DIR_OPERATOR_ROUTE, { runId: run.runId, nodeId: target.nodeId });
    // An older daemon has no such route: its generic 404 carries no `ok`.
    if (response.status === 404 && (response.body as { ok?: unknown } | undefined)?.ok === undefined) {
      return { unknown: '它的 daemon 版本过旧，无法确认' };
    }
    if (response.status === 404) return { unknown: '它的 daemon 认为这个节点不归它执行' };
    if (response.status !== 200) return { unknown: `它的 daemon 无法确认（HTTP ${response.status}）` };
    const answer = (response.body as { operate?: unknown } | undefined)?.operate;
    if (answer === 'yes' || answer === 'no') return answer;
    if (answer && typeof answer === 'object' && typeof (answer as { unknown?: unknown }).unknown === 'string') {
      return { unknown: (answer as { unknown: string }).unknown.slice(0, 200) };
    }
    return { unknown: '它的 daemon 回答无效' };
  }
  // The bot's own answer is bounded by the same budget on its side (plus a
  // union lookup at the main bot); past twice that it counts as unknown.
  return (target) => withinOperatorBudget(ask(target), 2 * WORKFLOW_OPERATOR_BUDGET_MS);
}

/**
 * The experimental executor policy for an authorization entry point, or
 * `undefined` while the switch is off — callers then take today's path
 * without consulting chats, daemons or Lark at all.
 */
export function liveV3NodeExecutorPolicy(bots: readonly BotConfig[], opts: { dataDir?: string } = {}): V3NodeExecutorPolicy | undefined {
  const switchMode = workflowNodeExecutorMode();
  if (switchMode !== 'bot') return undefined;
  return {
    switchMode,
    multiTopicEnabled: isMultiTopicOrchestrationEnabled(),
    probe: (binding) => createLiveV3BotEligibilityProbe({
      orchestratorAppId: binding.larkAppId,
      chatId: binding.chatId,
      bots,
      ...(opts.dataDir ? { dataDir: opts.dataDir } : {}),
    }),
    nameOf: v3BotDisplayNameResolver(opts.dataDir),
    mainTopic: (binding) => liveV3MainTopicAvailability(binding, opts.dataDir),
    ...(workflowHandoffIdentityEnabled() ? { handoffIdentity: createLiveV3HandoffIdentityPolicy(bots) } : {}),
  };
}
