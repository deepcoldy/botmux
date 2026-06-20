/**
 * `/dashboard sessions` sub-handler.
 *
 * The command-level admin gate has already passed. This handler fetches the
 * global sessions list, builds the Feishu list card, and DMs the invoking
 * admin. Per-session actions are handled by card callbacks from the detail
 * view.
 */

import type { LarkMessage } from '../../types.js';
import { localeForBot, t, type Locale } from '../../i18n/index.js';
import { buildSessionsCard } from '../../im/lark/sessions-card.js';
import { createDaemonClientFor } from '../../daemon-internal-client-wrapper.js';
import { sendUserMessage as defaultSendUserMessage } from '../../im/lark/client.js';
import type { DaemonClient } from '../../dashboard/daemon-internal-client.js';
import type { SessionRow } from '../dashboard-rows.js';
import type { CommandHandlerDeps } from '../command-handler.js';

/** Optional injection seam for tests. */
export interface DashboardSessionsCommandDeps {
  createClient?: (larkAppId: string) => DaemonClient;
  sendUserMessage?: (larkAppId: string, openId: string, content: string, msgType?: string) => Promise<string>;
  locale?: Locale;
  /** Override `Date.now()` so tests are deterministic. */
  nowMs?: () => number;
}

export async function handleDashboardSessions(
  _message: LarkMessage,
  _args: string,
  rootId: string,
  _chatId: string,
  deps: CommandHandlerDeps,
  larkAppId: string | undefined,
  adminOpenId: string,
  testDeps: DashboardSessionsCommandDeps = {},
): Promise<void> {
  if (!larkAppId) return;
  const locale: Locale = testDeps.locale ?? localeForBot(larkAppId);

  const client = (testDeps.createClient ?? createDaemonClientFor)(larkAppId);
  let snap;
  try {
    snap = await client.request({ method: 'GET', path: '/__daemon/sessions-list?scope=global' });
  } catch (e: any) {
    await deps.sessionReply(
      rootId,
      t('card.dashboard.sessions.list_failed', { reason: e?.message ?? String(e) }, locale),
      undefined, larkAppId,
    );
    return;
  }

  if (snap.status !== 200) {
    await deps.sessionReply(
      rootId,
      t('card.dashboard.sessions.list_failed', { reason: `http_${snap.status}` }, locale),
      undefined, larkAppId,
    );
    return;
  }

  const rows = ((snap.body as { sessions?: ReadonlyArray<SessionRow> })?.sessions) ?? [];
  const nowMs = testDeps.nowMs ? testDeps.nowMs() : Date.now();
  // invokerOpenId = adminOpenId so subsequent clicks still pass the invoker lock.
  const cardJson = buildSessionsCard(
    rows,
    { invokerOpenId: adminOpenId, locale, page: 1, scope: 'global' },
    nowMs,
  );

  const sendUserMessage = testDeps.sendUserMessage ?? defaultSendUserMessage;
  try {
    await sendUserMessage(larkAppId, adminOpenId, cardJson, 'interactive');
    await deps.sessionReply(
      rootId,
      t('card.dashboard.sessions.dm_sent', undefined, locale),
      undefined, larkAppId,
    );
  } catch (e: any) {
    await deps.sessionReply(
      rootId,
      t('card.dashboard.sessions.dm_failed', { reason: e?.message ?? String(e) }, locale),
      undefined, larkAppId,
    );
  }
}
