/**
 * `/dashboard schedules` real sub-handler (PR3 slice 1).
 *
 * Mirrors `/dashboard sessions` slice 1: admin gate has ALREADY run in
 * `handleDashboardCommand`; this function only fetches the list from PR2
 * Route B (`GET /__daemon/schedules-list`), builds the card, and DMs the
 * admin with the topic getting a short `dm_sent` confirmation.
 *
 * No CRUD / no run-now / no pause / no resume in slice 1.
 */

import type { LarkMessage } from '../../types.js';
import { localeForBot, t, type Locale } from '../../i18n/index.js';
import { buildSchedulesCard } from '../../im/lark/schedules-card.js';
import { createDaemonClientFor } from '../../daemon-internal-client-wrapper.js';
import { sendUserMessage as defaultSendUserMessage } from '../../im/lark/client.js';
import type { DaemonClient } from '../../dashboard/daemon-internal-client.js';
import type { ScheduleCardTaskInput } from '../../dashboard/schedule-card-model.js';
import type { CommandHandlerDeps } from '../command-handler.js';

export interface DashboardSchedulesCommandDeps {
  createClient?: (larkAppId: string) => DaemonClient;
  sendUserMessage?: (larkAppId: string, openId: string, content: string, msgType?: string) => Promise<string>;
  locale?: Locale;
  nowMs?: () => number;
}

export async function handleDashboardSchedules(
  _message: LarkMessage,
  _args: string,
  rootId: string,
  _chatId: string,
  deps: CommandHandlerDeps,
  larkAppId: string | undefined,
  adminOpenId: string,
  testDeps: DashboardSchedulesCommandDeps = {},
): Promise<void> {
  if (!larkAppId) return;
  const locale: Locale = testDeps.locale ?? localeForBot(larkAppId);

  const client = (testDeps.createClient ?? createDaemonClientFor)(larkAppId);
  let snap;
  try {
    // global-schedules slice (2026-06-11): `/dashboard schedules` is part
    // of the global tool-panel — surface schedules owned by any bot, not
    // just the caller. `?scope=global` makes the Route B handler skip
    // `scopeByCaller`; write actions (pause/resume) route to row owner.
    snap = await client.request({ method: 'GET', path: '/__daemon/schedules-list?scope=global' });
  } catch (e: any) {
    await deps.sessionReply(
      rootId,
      t('card.dashboard.schedules.list_failed', { reason: e?.message ?? String(e) }, locale),
      undefined, larkAppId,
    );
    return;
  }

  if (snap.status !== 200) {
    const reason = String((snap.body as any)?.error ?? `http_${snap.status}`);
    await deps.sessionReply(
      rootId,
      t('card.dashboard.schedules.list_failed', { reason }, locale),
      undefined, larkAppId,
    );
    return;
  }

  const tasks = ((snap.body as { schedules?: ReadonlyArray<ScheduleCardTaskInput> })?.schedules) ?? [];
  const nowMs = testDeps.nowMs ? testDeps.nowMs() : Date.now();
  // Standalone `/dashboard schedules` is the global tool-panel surface
  // (2026-06-11): `scope: 'global'` threads `dashboard_scope=global` onto
  // every callback so refresh/page/detail/back/pause/resume keep the
  // global view and route writes to the row's true owner.
  const cardJson = buildSchedulesCard(
    tasks,
    { invokerOpenId: adminOpenId, locale, page: 1, scope: 'global' },
    nowMs,
  );

  const sendUserMessage = testDeps.sendUserMessage ?? defaultSendUserMessage;
  try {
    await sendUserMessage(larkAppId, adminOpenId, cardJson, 'interactive');
    await deps.sessionReply(
      rootId,
      t('card.dashboard.schedules.dm_sent', undefined, locale),
      undefined, larkAppId,
    );
  } catch (e: any) {
    await deps.sessionReply(
      rootId,
      t('card.dashboard.schedules.dm_failed', { reason: e?.message ?? String(e) }, locale),
      undefined, larkAppId,
    );
  }
}
