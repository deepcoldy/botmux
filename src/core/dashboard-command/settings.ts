/**
 * `/dashboard settings` sub-handler.
 *
 * The command-level admin gate has already passed. This handler fetches the
 * live settings snapshot, projects it into a Feishu card, and DMs the invoking
 * admin. The topic receives only a confirmation line. The card builder never
 * receives sender union identity; `invokerOpenId` is the admin open_id used by
 * callback invoker-lock.
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
  adminOpenId: string,
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
  // invokerOpenId doubles as the callback invoker-lock anchor.
  const cardJson = buildSettingsCard(dto, {
    invokerOpenId: adminOpenId,
    locale,
    canWrite: true,
  });

  // DM the card to the bot admin; the topic gets only a
  // short confirmation. Matches `/card` (cmd.config.card_dmd) idiom.
  const sendUserMessage = testDeps.sendUserMessage ?? defaultSendUserMessage;
  try {
    await sendUserMessage(larkAppId, adminOpenId, cardJson, 'interactive');
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
