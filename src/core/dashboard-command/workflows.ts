/**
 * `/dashboard workflows` real sub-handler (PR3 slice 1).
 *
 * Mirrors `/dashboard sessions` slice 1: admin gate has ALREADY run in
 * `handleDashboardCommand`; this function only fetches the run list from
 * PR2 Route B (`GET /__daemon/workflows-runs-snapshot?all=1&scope=global`),
 * builds the card, and DMs the admin with the topic getting a short
 * `dm_sent` confirmation. `/dashboard` is the Bot admin's global tool panel,
 * not a per-bot view.
 *
 * No cancel / approve / reject / search / status filter in slice 1 —
 * read-only listing only.
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
    // codex 2026-06-09 blocker: listRuns default hides TERMINAL_RUN_STATUSES
    // (succeeded/failed/cancelled). Without `all=1` the "完成 M · 失败 K"
    // counts in the card would basically always be 0 — the user would see
    // "non-terminal list", not the runs history we advertise. The endpoint
    // already transparently forwards `?all`; only the consumer side needs to
    // ask for it.
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
