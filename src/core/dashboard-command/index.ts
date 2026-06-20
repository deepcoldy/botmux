/**
 * `/dashboard <module>` command-group entry (PR3 C1).
 *
 * Pipeline:
 *  1. Admin gate: the entire `/dashboard *` group is restricted to the
 *     bot's resolved `allowedUsers`, matching `/botconfig`. Any sub (help /
 *     unknown / overview / sessions / workflows / groups / schedules /
 *     settings) that bypasses the gate is a security regression — see the
 *     dispatch tests for the explicit guarantee.
 *  2. Subcommand dispatch by the first whitespace-delimited token; empty
 *     args default to `overview` to match v1.3 §0 routing rules.
 *  3. C1: every module subcommand replies with `not_implemented_yet`. C4
 *     replaces the `'settings'` arm with the real handler. C2 / C3 add no
 *     dispatch entries here; they only wire imports & infrastructure.
 */

import type { LarkMessage } from '../../types.js';
import { localeForBot, t } from '../../i18n/index.js';
import type { CommandHandlerDeps } from '../command-handler.js';

import { sendUserMessage as defaultSendUserMessage } from '../../im/lark/client.js';

import { ensureDashboardOwner, type EnsureDashboardOwnerDeps } from './owner-gate.js';
import {
  DASHBOARD_MODULES,
  buildHelpText,
  buildStubText,
  type DashboardModule,
} from './stub.js';
import { handleDashboardSettings, type DashboardSettingsCommandDeps } from './settings.js';
import { handleDashboardSessions, type DashboardSessionsCommandDeps } from './sessions.js';
import { handleDashboardSchedules, type DashboardSchedulesCommandDeps } from './schedules.js';
import { handleDashboardOverview, type DashboardOverviewCommandDeps } from './overview.js';
import { handleDashboardWorkflows, type DashboardWorkflowsCommandDeps } from './workflows.js';
import { handleDashboardGroups, type DashboardGroupsCommandDeps } from './groups.js';

/** Optional test seam — production omits and uses the real PR2 helper. */
export interface DashboardCommandDeps extends EnsureDashboardOwnerDeps {
  /** Override for `sendUserMessage` (DM to invoking admin). Production omits. */
  sendUserMessage?: (larkAppId: string, openId: string, content: string, msgType?: string) => Promise<string>;
  settings?: DashboardSettingsCommandDeps;
  sessions?: DashboardSessionsCommandDeps;
  schedules?: DashboardSchedulesCommandDeps;
  overview?: DashboardOverviewCommandDeps;
  workflows?: DashboardWorkflowsCommandDeps;
  groups?: DashboardGroupsCommandDeps;
}

export async function handleDashboardCommand(
  message: LarkMessage,
  args: string,
  rootId: string,
  _chatId: string,
  deps: CommandHandlerDeps,
  larkAppId?: string,
  testDeps: DashboardCommandDeps = {},
): Promise<void> {
  const loc = localeForBot(larkAppId);
  // Integral admin gate — applies to ALL subcommands. It intentionally
  // matches `/botconfig`: any resolved allowedUsers entry can use dashboard,
  // but open-mode bots with no allowedUsers still fail closed.
  const gate = await ensureDashboardOwner(message, larkAppId, testDeps);
  if (!gate.ok) {
    // Admin gate failure: reply in the topic (we don't have an admin DM target).
    await deps.sessionReply(rootId, t('card.dashboard.owner_only', undefined, loc), undefined, larkAppId);
    return;
  }

  // Every admin-gated response goes to the invoking admin's DM. The
  // topic receives only a short confirmation, sharing the `/card` idiom
  // (cmd.config.card_dmd: "configuration card sent to your DM").
  const sendUserMessage = testDeps.sendUserMessage ?? defaultSendUserMessage;
  const reply = async (text: string, msgType: 'text' | 'interactive' = 'text'): Promise<void> => {
    if (!larkAppId) {
      await deps.sessionReply(rootId, text, msgType === 'interactive' ? 'interactive' : undefined, larkAppId);
      return;
    }
    try {
      await sendUserMessage(larkAppId, gate.adminOpenId, text, msgType);
      await deps.sessionReply(rootId, t('card.dashboard.dm_sent', undefined, loc), undefined, larkAppId);
    } catch (e: any) {
      await deps.sessionReply(
        rootId,
        t('card.dashboard.dm_failed', { reason: e?.message ?? String(e) }, loc),
        undefined, larkAppId,
      );
    }
  };

  // ─── Dispatch (admin-only zone) ───
  const sub = args.trim().split(/\s+/)[0] || 'overview';

  if (sub === 'help') {
    await reply(buildHelpText(loc));
    return;
  }

  // PR3 C4: settings dispatched to the real handler.
  if (sub === 'settings') {
    const settingsArgs = args.replace(/^settings\s*/, '');
    return handleDashboardSettings(message, settingsArgs, rootId, _chatId, deps, larkAppId, gate.adminOpenId, testDeps.settings);
  }

  // PR3 sessions slice 1: read-only list + pagination + refresh.
  if (sub === 'sessions') {
    const sessionsArgs = args.replace(/^sessions\s*/, '');
    return handleDashboardSessions(message, sessionsArgs, rootId, _chatId, deps, larkAppId, gate.adminOpenId, testDeps.sessions);
  }

  // PR3 schedules slice 1: read-only list + pagination + refresh.
  if (sub === 'schedules') {
    const schedulesArgs = args.replace(/^schedules\s*/, '');
    return handleDashboardSchedules(message, schedulesArgs, rootId, _chatId, deps, larkAppId, gate.adminOpenId, testDeps.schedules);
  }

  // PR3 workflows slice 1: read-only list + pagination + refresh.
  if (sub === 'workflows') {
    const workflowsArgs = args.replace(/^workflows\s*/, '');
    return handleDashboardWorkflows(message, workflowsArgs, rootId, _chatId, deps, larkAppId, gate.adminOpenId, testDeps.workflows);
  }

  // PR3 groups: list + pagination + refresh + per-row management detail.
  if (sub === 'groups') {
    const groupsArgs = args.replace(/^groups\s*/, '');
    return handleDashboardGroups(message, groupsArgs, rootId, _chatId, deps, larkAppId, gate.adminOpenId, testDeps.groups);
  }

  // PR3 overview slice 1: read-only summary card + goto buttons.
  if (sub === 'overview') {
    const overviewArgs = args.replace(/^overview\s*/, '');
    return handleDashboardOverview(message, overviewArgs, rootId, _chatId, deps, larkAppId, gate.adminOpenId, testDeps.overview);
  }

  if (DASHBOARD_MODULES.includes(sub as DashboardModule)) {
    await reply(buildStubText(sub as DashboardModule, loc));
    return;
  }

  // Unknown module — show help with an "unknown module" preface.
  await reply(buildHelpText(loc, { unknownModule: sub }));
}
