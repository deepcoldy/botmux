/**
 * `/dashboard overview` real sub-handler.
 *
 * Pipeline (mirrors `/dashboard sessions` / `/dashboard schedules`):
 *   1. Admin gate has ALREADY run in `handleDashboardCommand`; this function
 *      is called with `adminOpenId` already resolved.
 *   2. Fetch the live overview snapshot via Route B
 *      (`GET /__daemon/overview-snapshot?scope=global`). `/dashboard` is
 *      a Bot admin tool panel — list modules surface cross-bot under
 *      `?scope=global` so the first-open view matches refresh/drilldown.
 *   3. Project through `buildOverviewCard` (counts + settings summary line)
 *      with section buttons routed to the goto handlers (which also send
 *      `?scope=global`).
 *   4. DM the card to the admin; topic only gets a short `dm_sent` line.
 *
 * Read-only — no buttons mutate state from the overview surface itself.
 */

import type { LarkMessage } from '../../types.js';
import { localeForBot, t, type Locale } from '../../i18n/index.js';
import { buildOverviewCard } from '../../im/lark/overview-card.js';
import { createDaemonClientFor } from '../../daemon-internal-client-wrapper.js';
import { sendUserMessage as defaultSendUserMessage } from '../../im/lark/client.js';
import type { DaemonClient } from '../../dashboard/daemon-internal-client.js';
import type { DashboardSettingsInput } from '../../dashboard/settings-card-model.js';
import type { ScheduleCardTaskInput } from '../../dashboard/schedule-card-model.js';
import type { SessionRow } from '../dashboard-rows.js';
import type { CommandHandlerDeps } from '../command-handler.js';

/** Optional injection seam for tests. */
export interface DashboardOverviewCommandDeps {
  createClient?: (larkAppId: string) => DaemonClient;
  sendUserMessage?: (larkAppId: string, openId: string, content: string, msgType?: string) => Promise<string>;
  locale?: Locale;
}

interface OverviewSnapshotBody {
  sessions?: ReadonlyArray<SessionRow>;
  schedules?: ReadonlyArray<ScheduleCardTaskInput>;
  settings?: DashboardSettingsInput;
}

export async function handleDashboardOverview(
  _message: LarkMessage,
  _args: string,
  rootId: string,
  _chatId: string,
  deps: CommandHandlerDeps,
  larkAppId: string | undefined,
  adminOpenId: string,
  testDeps: DashboardOverviewCommandDeps = {},
): Promise<void> {
  if (!larkAppId) return;
  const locale: Locale = testDeps.locale ?? localeForBot(larkAppId);

  const client = (testDeps.createClient ?? createDaemonClientFor)(larkAppId);
  let snap;
  try {
    // `/dashboard` first-open MUST match the refresh-callback view:
    // list modules are global under `?scope=global`.
    snap = await client.request({ method: 'GET', path: '/__daemon/overview-snapshot?scope=global' });
  } catch (e: any) {
    await deps.sessionReply(
      rootId,
      t('card.dashboard.overview.overview_failed', { reason: e?.message ?? String(e) }, locale),
      undefined, larkAppId,
    );
    return;
  }

  if (snap.status !== 200) {
    const reason = String((snap.body as any)?.error ?? `http_${snap.status}`);
    await deps.sessionReply(
      rootId,
      t('card.dashboard.overview.overview_failed', { reason }, locale),
      undefined, larkAppId,
    );
    return;
  }

  const body = snap.body as OverviewSnapshotBody | undefined;
  if (!body || typeof body !== 'object' || !body.settings) {
    await deps.sessionReply(
      rootId,
      t('card.dashboard.overview.overview_failed', { reason: 'malformed_body' }, locale),
      undefined, larkAppId,
    );
    return;
  }

  const cardJson = buildOverviewCard(
    {
      sessions: body.sessions ?? [],
      schedules: body.schedules ?? [],
      settings: body.settings,
    },
    { invokerOpenId: adminOpenId, locale },
  );

  const sendUserMessage = testDeps.sendUserMessage ?? defaultSendUserMessage;
  try {
    await sendUserMessage(larkAppId, adminOpenId, cardJson, 'interactive');
    await deps.sessionReply(
      rootId,
      t('card.dashboard.overview.dm_sent', undefined, locale),
      undefined, larkAppId,
    );
  } catch (e: any) {
    await deps.sessionReply(
      rootId,
      t('card.dashboard.overview.dm_failed', { reason: e?.message ?? String(e) }, locale),
      undefined, larkAppId,
    );
  }
}
