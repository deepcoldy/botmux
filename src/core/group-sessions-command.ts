/** `/sessions` command entry: current bot + current group, safe public card. */

import type { DaemonClient } from '../dashboard/daemon-internal-client.js';
import { config } from '../config.js';
import { isDashboardAdmin, type DashboardAdminLookupDeps } from '../dashboard/dashboard-admins.js';
import { createDaemonClientFor } from '../daemon-internal-client-wrapper.js';
import { buildGroupSessionsCard } from '../im/lark/group-sessions-card.js';
import { deleteMessage as defaultDeleteMessage, getChatModeStrict as defaultGetChatModeStrict } from '../im/lark/client.js';
import { localeForBot, t, type Locale } from '../i18n/index.js';
import type { LarkMessage } from '../types.js';
import type { CommandHandlerDeps } from './command-handler.js';
import type { SessionRow } from './dashboard-rows.js';
import { replaceLatestGroupSessionsCard as defaultReplaceLatestGroupSessionsCard } from '../services/group-sessions-card-store.js';
import { logger } from '../utils/logger.js';

export interface GroupSessionsCommandDeps extends DashboardAdminLookupDeps {
  createClient?: (larkAppId: string) => DaemonClient;
  getChatModeStrict?: (larkAppId: string, chatId: string) => Promise<'group' | 'topic' | 'p2p' | 'unknown'>;
  locale?: Locale;
  nowMs?: () => number;
  dataDir?: string;
  deleteMessage?: (larkAppId: string, messageId: string) => Promise<boolean>;
  replaceLatestGroupSessionsCard?: typeof defaultReplaceLatestGroupSessionsCard;
}

export async function handleGroupSessionsCommand(
  message: LarkMessage,
  rootId: string,
  chatId: string,
  deps: CommandHandlerDeps,
  larkAppId: string | undefined,
  testDeps: GroupSessionsCommandDeps = {},
): Promise<void> {
  const locale = testDeps.locale ?? localeForBot(larkAppId);
  if (!larkAppId || !chatId || !message.senderId) {
    await deps.sessionReply(rootId, t('card.group_sessions.unavailable', undefined, locale), undefined, larkAppId);
    return;
  }

  const getChatModeStrict = testDeps.getChatModeStrict ?? defaultGetChatModeStrict;
  const chatMode = await getChatModeStrict(larkAppId, chatId);
  if (chatMode !== 'group' && chatMode !== 'topic') {
    await deps.sessionReply(rootId, t('card.group_sessions.group_only', undefined, locale), undefined, larkAppId);
    return;
  }

  const client = (testDeps.createClient ?? createDaemonClientFor)(larkAppId);
  let response: Awaited<ReturnType<DaemonClient['request']>>;
  try {
    response = await client.request({ method: 'GET', path: '/__daemon/sessions-list?fresh=1' });
  } catch (cause) {
    await deps.sessionReply(
      rootId,
      t('card.group_sessions.list_failed', { reason: (cause as Error).message }, locale),
      undefined,
      larkAppId,
    );
    return;
  }
  if (response.status !== 200) {
    const reason = String((response.body as Record<string, unknown> | undefined)?.error ?? `http_${response.status}`);
    await deps.sessionReply(rootId, t('card.group_sessions.list_failed', { reason }, locale), undefined, larkAppId);
    return;
  }

  const rows = ((response.body as { sessions?: ReadonlyArray<SessionRow> })?.sessions) ?? [];
  const cardJson = buildGroupSessionsCard(rows, {
    larkAppId,
    chatId,
    invokerOpenId: message.senderId,
    canResume: isDashboardAdmin(larkAppId, message.senderId, testDeps),
    locale,
    page: 1,
  }, testDeps.nowMs ? testDeps.nowMs() : Date.now());
  const messageId = await deps.sessionReply(rootId, cardJson, 'interactive', larkAppId);
  try {
    const previousMessageId = (testDeps.replaceLatestGroupSessionsCard ?? defaultReplaceLatestGroupSessionsCard)(
      testDeps.dataDir ?? config.session.dataDir,
      larkAppId,
      chatId,
      message.senderId,
      messageId,
      testDeps.nowMs ? testDeps.nowMs() : Date.now(),
    );
    if (previousMessageId && previousMessageId !== messageId) {
      const deleted = await (testDeps.deleteMessage ?? defaultDeleteMessage)(larkAppId, previousMessageId);
      if (!deleted) logger.warn(`[/sessions] failed to withdraw predecessor card ${previousMessageId.substring(0, 12)}`);
    }
  } catch (err) {
    // The new card is already visible. Persistence/withdrawal is hygiene and
    // must never turn a successful `/sessions` query into a second error reply.
    logger.warn(`[/sessions] predecessor-card cleanup failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
