/**
 * `/dashboard groups` sub-handler.
 *
 * The command-level admin gate has already passed. This handler fetches the
 * global groups matrix, builds the Feishu list card, and DMs the invoking
 * admin. Per-row detail cards carry add-bot, leave-bot, oncall, and role
 * actions through card callbacks.
 */

import type { LarkMessage } from '../../types.js';
import { localeForBot, t, type Locale } from '../../i18n/index.js';
import { buildGroupsCard, buildProjectGroupRolesCard } from '../../im/lark/groups-card.js';
import { createDaemonClientFor } from '../../daemon-internal-client-wrapper.js';
import { sendUserMessage as defaultSendUserMessage } from '../../im/lark/client.js';
import type { DaemonClient } from '../../dashboard/daemon-internal-client.js';
import type {
  GroupsBotInput,
  GroupsChatInput,
} from '../../dashboard/groups-card-model.js';
import type { CommandHandlerDeps } from '../command-handler.js';

/** Optional injection seam for tests. */
export interface DashboardGroupsCommandDeps {
  createClient?: (larkAppId: string) => DaemonClient;
  sendUserMessage?: (larkAppId: string, openId: string, content: string, msgType?: string) => Promise<string>;
  locale?: Locale;
}

type ProjectRolesConfig = {
  coordinatorAppId: string;
  workerAppIds: string[];
};

async function loadGlobalGroupsMatrix(
  rootId: string,
  deps: CommandHandlerDeps,
  larkAppId: string,
  locale: Locale,
  testDeps: DashboardGroupsCommandDeps,
): Promise<{ chats: ReadonlyArray<GroupsChatInput>; bots: ReadonlyArray<GroupsBotInput> } | undefined> {
  const client = (testDeps.createClient ?? createDaemonClientFor)(larkAppId);
  let snap;
  try {
    snap = await client.request({ method: 'GET', path: '/__daemon/groups-matrix?scope=global' });
  } catch (e: any) {
    await deps.sessionReply(rootId, t('card.dashboard.groups.list_failed', { reason: e?.message ?? String(e) }, locale), undefined, larkAppId);
    return undefined;
  }
  if (snap.status !== 200) {
    const reason = String((snap.body as any)?.error ?? `http_${snap.status}`);
    await deps.sessionReply(rootId, t('card.dashboard.groups.list_failed', { reason }, locale), undefined, larkAppId);
    return undefined;
  }
  const body = (snap.body as { chats?: ReadonlyArray<GroupsChatInput>; bots?: ReadonlyArray<GroupsBotInput> }) ?? {};
  return { chats: body.chats ?? [], bots: body.bots ?? [] };
}

export async function handleDashboardGroups(
  _message: LarkMessage,
  _args: string,
  rootId: string,
  _chatId: string,
  deps: CommandHandlerDeps,
  larkAppId: string | undefined,
  adminOpenId: string,
  testDeps: DashboardGroupsCommandDeps = {},
): Promise<void> {
  if (!larkAppId) return;
  const locale: Locale = testDeps.locale ?? localeForBot(larkAppId);

  const matrix = await loadGlobalGroupsMatrix(rootId, deps, larkAppId, locale, testDeps);
  if (!matrix) return;
  // invokerOpenId = adminOpenId so subsequent clicks still pass the invoker lock.
  const cardJson = buildGroupsCard(matrix, {
    invokerOpenId: adminOpenId,
    locale,
    page: 1,
    scope: 'global',
  });

  const sendUserMessage = testDeps.sendUserMessage ?? defaultSendUserMessage;
  try {
    await sendUserMessage(larkAppId, adminOpenId, cardJson, 'interactive');
    await deps.sessionReply(
      rootId,
      t('card.dashboard.groups.dm_sent', undefined, locale),
      undefined, larkAppId,
    );
  } catch (e: any) {
    await deps.sessionReply(
      rootId,
      t('card.dashboard.groups.dm_failed', { reason: e?.message ?? String(e) }, locale),
      undefined, larkAppId,
    );
  }
}

/** Reply with a focused role editor card in the current project group. The card writes through
 * the same per-chat role endpoints as `/role` and the Web Dashboard; this is
 * only a more convenient project-group entry point, not a second role store. */
export async function handleProjectGroupRoles(
  rootId: string,
  chatId: string,
  deps: CommandHandlerDeps,
  larkAppId: string,
  adminOpenId: string,
  project: ProjectRolesConfig,
  testDeps: DashboardGroupsCommandDeps = {},
): Promise<void> {
  const locale: Locale = testDeps.locale ?? localeForBot(larkAppId);
  const matrix = await loadGlobalGroupsMatrix(rootId, deps, larkAppId, locale, testDeps);
  if (!matrix) return;
  const chat = matrix.chats.find(item => item.chatId === chatId);
  if (!chat) {
    await deps.sessionReply(rootId, t('card.dashboard.groups.chat_not_found', undefined, locale), undefined, larkAppId);
    return;
  }
  const cardJson = buildProjectGroupRolesCard(matrix, chat, project, {
    invokerOpenId: adminOpenId,
    locale,
    scope: 'global',
  });
  await deps.sessionReply(rootId, cardJson, 'interactive', larkAppId);
}
