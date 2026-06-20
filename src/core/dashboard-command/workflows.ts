/**
 * `/dashboard workflows` sub-handler.
 *
 * The command-level admin gate has already passed. This handler fetches the
 * global workflow run list, builds the Feishu list card, and DMs the invoking
 * admin. Per-run actions are handled by card callbacks from the detail view.
 */

import type { LarkMessage } from '../../types.js';
import { localeForBot, t, type Locale } from '../../i18n/index.js';
import { buildWorkflowsCard } from '../../im/lark/workflows-card.js';
import { createDaemonClientFor } from '../../daemon-internal-client-wrapper.js';
import { sendUserMessage as defaultSendUserMessage } from '../../im/lark/client.js';
import type { DaemonClient } from '../../dashboard/daemon-internal-client.js';
import type { WorkflowRunInput } from '../../dashboard/workflow-card-model.js';
import type { CommandHandlerDeps } from '../command-handler.js';

export interface DashboardWorkflowsCommandDeps {
  createClient?: (larkAppId: string) => DaemonClient;
  sendUserMessage?: (larkAppId: string, openId: string, content: string, msgType?: string) => Promise<string>;
  locale?: Locale;
  /** Override `Date.now()` so tests are deterministic. */
  nowMs?: () => number;
}

export async function handleDashboardWorkflows(
  _message: LarkMessage,
  _args: string,
  rootId: string,
  _chatId: string,
  deps: CommandHandlerDeps,
  larkAppId: string | undefined,
  adminOpenId: string,
  testDeps: DashboardWorkflowsCommandDeps = {},
): Promise<void> {
  if (!larkAppId) return;
  const locale: Locale = testDeps.locale ?? localeForBot(larkAppId);

  const client = (testDeps.createClient ?? createDaemonClientFor)(larkAppId);
  let snap;
  try {
    // listRuns defaults to non-terminal runs. `all=1` is required so the
    // completed/failed counters and history rows include terminal runs.
    snap = await client.request({ method: 'GET', path: '/__daemon/workflows-runs-snapshot?all=1&scope=global' });
  } catch (e: any) {
    await deps.sessionReply(
      rootId,
      t('card.dashboard.workflows.list_failed', { reason: e?.message ?? String(e) }, locale),
      undefined, larkAppId,
    );
    return;
  }

  if (snap.status !== 200) {
    const reason = String((snap.body as any)?.error ?? `http_${snap.status}`);
    await deps.sessionReply(
      rootId,
      t('card.dashboard.workflows.list_failed', { reason }, locale),
      undefined, larkAppId,
    );
    return;
  }

  const rows = ((snap.body as { runs?: ReadonlyArray<WorkflowRunInput> })?.runs) ?? [];
  const nowMs = testDeps.nowMs ? testDeps.nowMs() : Date.now();
  // invokerOpenId = adminOpenId so subsequent clicks still pass the invoker lock.
  const cardJson = buildWorkflowsCard(
    rows,
    { invokerOpenId: adminOpenId, locale, page: 1, scope: 'global' },
    nowMs,
  );

  const sendUserMessage = testDeps.sendUserMessage ?? defaultSendUserMessage;
  try {
    await sendUserMessage(larkAppId, adminOpenId, cardJson, 'interactive');
    await deps.sessionReply(
      rootId,
      t('card.dashboard.workflows.dm_sent', undefined, locale),
      undefined, larkAppId,
    );
  } catch (e: any) {
    await deps.sessionReply(
      rootId,
      t('card.dashboard.workflows.dm_failed', { reason: e?.message ?? String(e) }, locale),
      undefined, larkAppId,
    );
  }
}
