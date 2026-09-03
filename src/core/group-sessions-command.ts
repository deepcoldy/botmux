/** `/sessions` command entry: current bot + current group, safe public card. */

import type { DaemonClient } from '../dashboard/daemon-internal-client.js';
import { isDashboardAdmin, type DashboardAdminLookupDeps } from '../dashboard/dashboard-admins.js';
import { createDaemonClientFor } from '../daemon-internal-client-wrapper.js';
import { buildGroupSessionsCard } from '../im/lark/group-sessions-card.js';
import { getChatModeStrict as defaultGetChatModeStrict } from '../im/lark/client.js';
import { localeForBot, t, type Locale } from '../i18n/index.js';
import type { LarkMessage } from '../types.js';
import type { CommandHandlerDeps } from './command-handler.js';
import type { SessionRow } from './dashboard-rows.js';

export interface GroupSessionsCommandDeps extends DashboardAdminLookupDeps {
  createClient?: (larkAppId: string) => DaemonClient;
  getChatModeStrict?: (larkAppId: string, chatId: string) => Promise<'group' | 'topic' | 'p2p' | 'unknown'>;
  locale?: Locale;
  nowMs?: () => number;
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
    response = await client.request({ method: 'GET', path: '/__daemon/sessions-list' });
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
  await deps.sessionReply(rootId, cardJson, 'interactive', larkAppId);
}
