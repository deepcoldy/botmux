/**
 * `/dashboard settings` real sub-handler (PR3 C4 + revision).
 *
 * Pipeline:
 *   1. owner gate has ALREADY run in `handleDashboardCommand` — this function
 *      is called only when the caller IS the per-bot owner (ownerOpenId is
 *      passed in by the dispatch).
 *   2. fetch the live settings snapshot via PR2 Route B
 *      (`GET /__daemon/settings-snapshot`).
 *   3. project through PR1 `composeSections` and emit a Feishu card.
 *   4. PR3 revision: send the card to the OWNER'S DM (sendUserMessage), NOT
 *      the topic. Topic only receives a confirmation line (card_dmd idiom).
 *
 * The card builder NEVER receives `senderUnionId` — identity stays inside
 * this closure (plan v3 B5). `invokerOpenId` is the owner open_id itself,
 * which both binds the card to the operator and ensures invoker-lock holds.
 */

import type { LarkMessage } from '../../types.js';
import { localeForBot, t, type Locale } from '../../i18n/index.js';
import { composeSections } from '../../dashboard/settings-card-model.js';
import { buildSettingsCard } from '../../im/lark/settings-card.js';
import { createDaemonClientFor } from '../../daemon-internal-client-wrapper.js';
import { sendUserMessage as defaultSendUserMessage } from '../../im/lark/client.js';
import type { DaemonClient } from '../../dashboard/daemon-internal-client.js';
import type { CommandHandlerDeps } from '../command-handler.js';

/** Optional injection seam for tests. */
export interface DashboardSettingsCommandDeps {
  createClient?: (larkAppId: string) => DaemonClient;
  sendUserMessage?: (larkAppId: string, openId: string, content: string, msgType?: string) => Promise<string>;
  locale?: Locale;
}

export async function handleDashboardSettings(
  message: LarkMessage,
  _args: string,
  rootId: string,
  _chatId: string,
  deps: CommandHandlerDeps,
  larkAppId: string | undefined,
  ownerOpenId: string,
  testDeps: DashboardSettingsCommandDeps = {},
): Promise<void> {
  if (!larkAppId) return;
  const locale: Locale = testDeps.locale ?? localeForBot(larkAppId);

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
  // PR3 revision: invokerOpenId = ownerOpenId (NOT message.senderId). This
  // doubles as the invoker-lock anchor, so any future click MUST come from
  // the same owner open_id.
  const cardJson = buildSettingsCard(dto, {
    invokerOpenId: ownerOpenId,
    locale,
    canWrite: true,
  });

  // PR3 revision: DM the card to the bot owner; the topic gets only a
  // short confirmation. Matches `/card` (cmd.config.card_dmd) idiom.
  const sendUserMessage = testDeps.sendUserMessage ?? defaultSendUserMessage;
  try {
    await sendUserMessage(larkAppId, ownerOpenId, cardJson, 'interactive');
    await deps.sessionReply(
      rootId,
      t('card.dashboard.settings.dm_sent', undefined, locale),
      undefined, larkAppId,
    );
  } catch (e: any) {
    await deps.sessionReply(
      rootId,
      t('card.dashboard.settings.dm_failed', { reason: e?.message ?? String(e) }, locale),
      undefined, larkAppId,
    );
  }
}
