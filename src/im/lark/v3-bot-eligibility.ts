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
  isWorkflowOpenId,
  withinOperatorBudget,
  type WorkflowWorkingDirOperatorRequest,
} from '../../core/workflow-working-dir-operator.js';
import { config } from '../../config.js';
import { findOnlineDaemon } from '../../utils/daemon-discovery.js';
import { readBotsInfoJson } from '../../services/bots-info-cache.js';
import { normalizeBotsInfoRouteEntries } from '../../services/bots-info-shape.js';
import type { BotConfig } from '../../bot-registry.js';
import { isMultiTopicOrchestrationEnabled, workflowHandoffIdentityEnabled, workflowNodeExecutorMode } from '../../global-config.js';
import { readSessionRowCopiesAcrossStores } from '../../services/session-store.js';
import type { RunChatBinding } from '../../workflows/v3/grill-state.js';
import type { V3MainTopicAvailability } from '../../workflows/v3/placement.js';
import {
  v3MainTopicAvailability,
  v3OpensTopicSessions,
  type V3BotEligibilityProbe,
  type V3HandoffIdentityPolicy,
  type V3InitiatorUnionLookup,
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
 * bot's own daemon answers whether the run's initiator may operate it in the
 * run's chat ({@link WORKFLOW_WORKING_DIR_OPERATOR_ROUTE}), judged with its
 * own configuration and grants. The initiator's open_id goes only to the main
 * bot (whose app issued it); any other bot gets their union_id, looked up once
 * through the main bot's app, and converts it in its own app. No owner, no
 * union_id, an offline or older daemon (no such route), any failure → false.
 */
export interface LiveV3WorkingDirOperatorDeps {
  /** open_id → union_id through `larkAppId`'s app (default: Lark, strict). */
  lookupUnionId?(larkAppId: string, openId: string): Promise<V3InitiatorUnionLookup>;
  /** The bot's online daemon IPC port (default: the daemon registry). */
  daemonPort?(larkAppId: string): number | undefined;
  /** POST over trusted host IPC (default: {@link fetchDaemonIpc}). */
  post?(port: number, path: string, body: WorkflowWorkingDirOperatorRequest): Promise<{ status: number; body: unknown }>;
  dataDir?: string;
}

export function createLiveV3WorkingDirOperator(
  binding: RunChatBinding,
  deps: LiveV3WorkingDirOperatorDeps = {},
): (larkAppId: string) => Promise<boolean> {
  const dataDir = deps.dataDir ?? config.session.dataDir;
  const lookupUnionId = deps.lookupUnionId ?? resolveUnionIdFromOpenIdStrict;
  const daemonPort = deps.daemonPort ?? ((appId: string) => findOnlineDaemon(appId, dataDir)?.ipcPort);
  const post = deps.post ?? (async (port: number, path: string, body: WorkflowWorkingDirOperatorRequest) => {
    const response = await fetchDaemonIpc(port, path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }, loadDaemonIpcSecret());
    return { status: response.status, body: await response.json().catch(() => undefined) };
  });
  const owner = isWorkflowOpenId(binding.ownerOpenId) ? binding.ownerOpenId : undefined;
  let union: Promise<string | undefined> | undefined;
  const unionId = (): Promise<string | undefined> => {
    union ??= owner
      ? lookupUnionId(binding.larkAppId, owner)
        .then((lookup) => (lookup.status === 'resolved' ? lookup.unionId : undefined), () => undefined)
      : Promise.resolve(undefined);
    return union;
  };
  // The union lookup and the bot's own answer (itself bounded by the same
  // budget on its side) together; past that it counts as "no".
  return (larkAppId) => withinOperatorBudget(ask(larkAppId), 2 * WORKFLOW_OPERATOR_BUDGET_MS);
  async function ask(larkAppId: string): Promise<boolean> {
    if (!owner) return false;
    try {
      const port = daemonPort(larkAppId);
      if (!port) return false;
      let request: WorkflowWorkingDirOperatorRequest;
      if (larkAppId === binding.larkAppId) {
        request = { chatId: binding.chatId, initiator: { sourceLarkAppId: binding.larkAppId, openId: owner } };
      } else {
        // Never the main bot's open_id for another app: only the union_id.
        const resolved = await unionId();
        if (!resolved) return false;
        request = { chatId: binding.chatId, initiator: { sourceLarkAppId: binding.larkAppId, unionId: resolved } };
      }
      const response = await post(port, WORKFLOW_WORKING_DIR_OPERATOR_ROUTE, request);
      const body = response.body as { canOperate?: unknown } | undefined;
      return response.status === 200 && body?.canOperate === true;
    } catch {
      return false;
    }
  }
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
