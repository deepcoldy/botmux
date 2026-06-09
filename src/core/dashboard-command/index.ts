/**
 * `/dashboard <module>` command-group entry (PR3 C1).
 *
 * Pipeline:
 *  1. Owner gate: the entire `/dashboard *` group is owner-only. Any sub
 *     (help / unknown / overview / sessions / workflows / groups / schedules
 *     / settings) that bypasses the gate is a security regression — see the
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

import { ensureDashboardOwner, type EnsureDashboardOwnerDeps } from './owner-gate.js';
import {
  DASHBOARD_MODULES,
  buildHelpText,
  buildStubText,
  type DashboardModule,
} from './stub.js';
import { handleDashboardSettings, type DashboardSettingsCommandDeps } from './settings.js';

/** Optional test seam — production omits and uses the real PR2 helper. */
export interface DashboardCommandDeps extends EnsureDashboardOwnerDeps {
  settings?: DashboardSettingsCommandDeps;
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
  const reply = async (text: string): Promise<void> => {
    await deps.sessionReply(rootId, text, undefined, larkAppId);
  };

  // ─── B1 (v2): integral owner gate — applies to ALL subcommands ───
  const gate = await ensureDashboardOwner(message, testDeps);
  if (!gate.ok) {
    await reply(t('card.dashboard.owner_only', undefined, loc));
    return;
  }

  // ─── Dispatch (owner-only zone) ───
  const sub = args.trim().split(/\s+/)[0] || 'overview';

  if (sub === 'help') {
    await reply(buildHelpText(loc));
    return;
  }

  // PR3 C4: settings dispatched to the real handler; the other 5 modules
  // remain stubs until their own PR.
  if (sub === 'settings') {
    const settingsArgs = args.replace(/^settings\s*/, '');
    return handleDashboardSettings(message, settingsArgs, rootId, _chatId, deps, larkAppId, testDeps.settings);
  }

  if (DASHBOARD_MODULES.includes(sub as DashboardModule)) {
    await reply(buildStubText(sub as DashboardModule, loc));
    return;
  }

  // Unknown module — show help with an "unknown module" preface.
  await reply(buildHelpText(loc, { unknownModule: sub }));
}
