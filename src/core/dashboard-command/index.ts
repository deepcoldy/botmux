/**
 * `/dashboard <module>` command-group entry.
 *
 * The entire command group is restricted to the bot's resolved `allowedUsers`,
 * matching `/botconfig`. Any subcommand that bypasses this gate is a security
 * regression. Empty args default to `overview`; successful cards are DM'd to
 * the invoking admin and the topic receives only a short confirmation.
 */

import type { LarkMessage } from '../../types.js';
import { localeForBot, t } from '../../i18n/index.js';
import { logger } from '../../utils/logger.js';
import type { CommandHandlerDeps } from '../command-handler.js';

import { sendUserMessage as defaultSendUserMessage } from '../../im/lark/client.js';

import { ensureDashboardOwner, type EnsureDashboardOwnerDeps } from './owner-gate.js';
import { deliverDashboardAdminLink, type DashboardLinkSeams } from './link.js';
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
import { handleDashboardGroups, type DashboardGroupsCommandDeps } from './groups.js';

/** Optional test seam. Production omits these overrides. */
export interface DashboardCommandDeps extends EnsureDashboardOwnerDeps {
  /** Override for `sendUserMessage` (DM to invoking admin). Production omits. */
  sendUserMessage?: (larkAppId: string, openId: string, content: string, msgType?: string) => Promise<string>;
  settings?: DashboardSettingsCommandDeps;
  sessions?: DashboardSessionsCommandDeps;
  schedules?: DashboardSchedulesCommandDeps;
  overview?: DashboardOverviewCommandDeps;
  groups?: DashboardGroupsCommandDeps;
  /** Test seams for `/dashboard link` (and the `/dash` alias). */
  link?: DashboardLinkSeams;
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
  // Parse the subcommand ONCE, before the gate, so a denied `/dashboard link`
  // can be audited without a second argv split. rawSub keeps the original case
  // for arg slicing; sub is the lowercased dispatch token.
  const trimmedArgs = args.trim();
  const rawSub = trimmedArgs.split(/\s+/)[0] || 'overview';
  const sub = rawSub.toLowerCase();
  const subArgs = trimmedArgs ? trimmedArgs.slice(rawSub.length).trimStart() : '';
  // Integral admin gate — applies to ALL subcommands. It intentionally
  // matches `/botconfig`: any resolved allowedUsers entry can use dashboard,
  // but open-mode bots with no allowedUsers still fail closed.
  const gate = await ensureDashboardOwner(message, larkAppId, testDeps);
  if (!gate.ok) {
    // `/dashboard link` hands out the admin token, so denied attempts at that
    // subcommand get an explicit audit line; other subcommands keep their
    // historical silent refusal. No token exists on this path.
    if (sub === 'link') {
      logger.warn(`[dashboard-command] denied sub=link sender=${message.senderId ?? '?'} chat=${message.chatId ?? '?'} reason=${gate.reason}`);
    }
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
  // `/dashboard link` hands out a token-bearing admin URL, so it bypasses the
  // card DM idiom below and uses its own private-delivery flow (ephemeral card
  // in plain groups, DM otherwise, never a public group message). It inherits
  // the parent DM seam so tests overriding sendUserMessage at the command-group
  // level observe the same client on this path.
  if (sub === 'link') {
    const linkSeams: DashboardCommandDeps['link'] = {
      ...testDeps.link,
      sendUserMessage: testDeps.link?.sendUserMessage ?? testDeps.sendUserMessage,
    };
    await deliverDashboardAdminLink({
      larkAppId: larkAppId!,
      message,
      rootId,
      adminOpenId: gate.adminOpenId,
      reply: (content, msgType) => deps.sessionReply(rootId, content, msgType, larkAppId),
      seams: linkSeams,
    });
    return;
  }

  if (sub === 'help') {
    await reply(buildHelpText(loc));
    return;
  }

  if (sub === 'settings') {
    return handleDashboardSettings(message, subArgs, rootId, _chatId, deps, larkAppId, gate.adminOpenId, testDeps.settings);
  }

  if (sub === 'sessions') {
    return handleDashboardSessions(message, subArgs, rootId, _chatId, deps, larkAppId, gate.adminOpenId, testDeps.sessions);
  }

  if (sub === 'schedules') {
    return handleDashboardSchedules(message, subArgs, rootId, _chatId, deps, larkAppId, gate.adminOpenId, testDeps.schedules);
  }

  if (sub === 'workflows') {
    await reply('v2 workflow 面板已下线；请在 Web Dashboard 的 Workflows 页面查看 v3 运行。');
    return;
  }

  if (sub === 'groups') {
    return handleDashboardGroups(message, subArgs, rootId, _chatId, deps, larkAppId, gate.adminOpenId, testDeps.groups);
  }

  if (sub === 'overview') {
    return handleDashboardOverview(message, subArgs, rootId, _chatId, deps, larkAppId, gate.adminOpenId, testDeps.overview);
  }

  if (DASHBOARD_MODULES.includes(sub as DashboardModule)) {
    await reply(buildStubText(sub as DashboardModule, loc));
    return;
  }

  // Unknown module — show help with an "unknown module" preface.
  await reply(buildHelpText(loc, { unknownModule: sub }));
}
