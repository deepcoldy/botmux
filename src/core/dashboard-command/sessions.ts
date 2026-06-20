/**
 * `/dashboard sessions` real sub-handler (PR3 slice 1).
 *
 * Pipeline (mirrors `/dashboard settings`):
 *   1. owner gate ran in `handleDashboardCommand` — this function is only
 *      called when the caller IS the per-bot owner (ownerOpenId passed in).
 *   2. fetch the live sessions list via PR2 Route B
 *      (`GET /__daemon/sessions-list?scope=global`) — `/dashboard` is the
 *      Bot Owner's global tool panel, not a per-bot view.
 *   3. project through PR1 `composeEntries + sortByStatus + paginate` inside
 *      the card builder; emit a Feishu interactive card.
 *   4. send the card to the OWNER's DM (sendUserMessage), NOT the topic.
 *      Topic only receives a short confirmation line.
 *
 * Slice 1 is read-only: no close/restart/locate buttons. Those need
 * optimistic-state + rollback design which slice 2 will own.
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
  ownerOpenId: string,
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
  // invokerOpenId = ownerOpenId so subsequent clicks still pass the invoker lock.
  const cardJson = buildSessionsCard(
    rows,
    { invokerOpenId: ownerOpenId, locale, page: 1, scope: 'global' },
    nowMs,
  );

  const sendUserMessage = testDeps.sendUserMessage ?? defaultSendUserMessage;
  try {
    await sendUserMessage(larkAppId, ownerOpenId, cardJson, 'interactive');
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
