/**
 * Live §6.1 eligibility probe for "节点交给群里的 Bot 执行" (design
 * 2026-11-03 §6.3): membership is checked through the main bot's own Lark app
 * (the same strict resolver `botmux dispatch --bot-app` uses), liveness through
 * the local daemon registry, and the talk-only chat grant through the same
 * matrix call dispatch makes. Used at Gate-2 (`approve-dag`), Saved Workflow
 * materialization and before every handoff.
 */

import { ensureBotChatGrantMatrix } from '../../cli/exact-chat-grant-client.js';
import { loadDaemonIpcSecret } from '../../core/daemon-ipc-auth.js';
import { config } from '../../config.js';
import { findOnlineDaemon } from '../../utils/daemon-discovery.js';
import { readBotsInfoJson } from '../../services/bots-info-cache.js';
import { normalizeBotsInfoRouteEntries } from '../../services/bots-info-shape.js';
import type { BotConfig } from '../../bot-registry.js';
import { isMultiTopicOrchestrationEnabled, workflowNodeExecutorMode } from '../../global-config.js';
import { v3OpensTopicSessions, type V3BotEligibilityProbe, type V3NodeExecutorPolicy } from '../../workflows/v3/node-executor-mode.js';
import { getChatModeStrict, resolveCurrentChatBotOpenIdsByLarkAppIds } from './client.js';

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
  };
}
