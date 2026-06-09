/**
 * `/dashboard settings` real sub-handler (PR3 C4).
 *
 * Pipeline:
 *   1. owner gate has ALREADY run in `handleDashboardCommand` — this function
 *      is called only when the caller is a verified `/dashboard` owner.
 *   2. fetch the live settings snapshot via PR2 Route B
 *      (`GET /__daemon/settings-snapshot`).
 *   3. project through PR1 `composeSections` and emit a Feishu card.
 *
 * The card builder NEVER receives `senderUnionId` — identity stays inside
 * this closure (plan v3 B5).
 */

import type { LarkMessage } from '../../types.js';
import { localeForBot, t, type Locale } from '../../i18n/index.js';
import { composeSections } from '../../dashboard/settings-card-model.js';
import { buildSettingsCard } from '../../im/lark/settings-card.js';
import { createDaemonClientFor } from '../../daemon-internal-client-wrapper.js';
import type { DaemonClient } from '../../dashboard/daemon-internal-client.js';
import type { CommandHandlerDeps } from '../command-handler.js';

/** Optional injection seam for tests (mock client + locale). */
export interface DashboardSettingsCommandDeps {
  createClient?: (larkAppId: string) => DaemonClient;
  locale?: Locale;
}

export async function handleDashboardSettings(
  message: LarkMessage,
  _args: string,
  rootId: string,
  _chatId: string,
  deps: CommandHandlerDeps,
  larkAppId?: string,
  testDeps: DashboardSettingsCommandDeps = {},
): Promise<void> {
  if (!larkAppId) return;
  const locale: Locale = testDeps.locale ?? localeForBot(larkAppId);

  // v4 B2: builder.invokerOpenId uses `message.senderId`, NOT `senderOpenId`
  // (LarkMessage has no `senderOpenId`).
  const invokerOpenId = message.senderId;

  const client = (testDeps.createClient ?? createDaemonClientFor)(larkAppId);
  let snap;
  try {
    snap = await client.request({ method: 'GET', path: '/__daemon/settings-snapshot' });
  } catch (e: any) {
    await deps.sessionReply(
      rootId,
      t('card.dashboard.settings.snapshot_failed', { reason: e?.message ?? String(e) }, locale),
      undefined, larkAppId,
    );
    return;
  }

  if (snap.status !== 200) {
    await deps.sessionReply(
      rootId,
      t('card.dashboard.settings.snapshot_failed', { reason: `http_${snap.status}` }, locale),
      undefined, larkAppId,
    );
    return;
  }

  const settings = (snap.body as { settings?: unknown })?.settings;
  if (!settings || typeof settings !== 'object') {
    await deps.sessionReply(
      rootId,
      t('card.dashboard.settings.snapshot_failed', { reason: 'malformed_body' }, locale),
      undefined, larkAppId,
    );
    return;
  }

  const dto = composeSections(settings as any, { canWrite: true });
  const cardJson = buildSettingsCard(dto, {
    invokerOpenId,
    locale,
    canWrite: true,
  });

  await deps.sessionReply(rootId, cardJson, 'interactive', larkAppId);
}
