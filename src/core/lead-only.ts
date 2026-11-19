/**
 * Lead-only chat manager session policy (opt-in, default off).
 *
 * A session is lead-only when this bot is the chat manager of a regular group with
 * lead-only enabled on its claim, and the session is not an executor there (spawned
 * by `botmux dispatch` or a workflow node). DMs never qualify. The restriction is
 * enforced for claude-code only (adapter flags + plugin guard); other CLIs ignore it.
 */
import { isLeadOnlyManagerClaim } from '../services/chat-manager-state.js';
import { isWorkflowNodeSessionMarker } from './workflow-node-session.js';
import type { WorkflowNodeSessionMarker } from '../types.js';

export interface LeadOnlySessionLike {
  dispatchLaunchId?: string;
  workflowNode?: Pick<WorkflowNodeSessionMarker, 'placement'>;
}

/** Executor-ish sessions are exempt. A main-topic workflow handoff marker does not
 *  make the ordinary (manager) session an executor. */
export function isExecutorRoleSession(session: LeadOnlySessionLike): boolean {
  return !!session.dispatchLaunchId || isWorkflowNodeSessionMarker(session.workflowNode);
}

export function isLeadOnlySession(
  larkAppId: string,
  chatId: string,
  chatType: string | undefined,
  session: LeadOnlySessionLike,
): boolean {
  if (chatType === 'p2p') return false;
  if (!isLeadOnlyManagerClaim(larkAppId, chatId)) return false;
  return !isExecutorRoleSession(session);
}

export type ChatManagerMutationPlan =
  | { ok: true; action: 'set' | 'clear' | 'lead-only'; authAction: 'set' | 'clear' | 'lead-only-on' | 'lead-only-off'; leadOnly?: boolean }
  | { ok: false; status: 400 | 409; error: 'invalid_action' | 'chat_manager_disabled' };

/**
 * Validation + gating for POST /api/sessions/:id/chat-manager mutations (status is handled before this).
 * `set` and `lead-only on` require the per-bot manager switch. `clear` and `lead-only off` (both revocations)
 * are intentionally ungated: the claim file is read without consulting the bot switch, so a leadOnly claim
 * must stay removable after the switch is turned off without also dropping the manager (`clear`).
 */
export function planChatManagerMutation(body: { action?: unknown; leadOnly?: unknown }, chatManagerEnabled: boolean): ChatManagerMutationPlan {
  const { action } = body;
  if (action !== 'set' && action !== 'clear' && action !== 'lead-only') return { ok: false, status: 400, error: 'invalid_action' };
  if (action === 'lead-only' && typeof body.leadOnly !== 'boolean') return { ok: false, status: 400, error: 'invalid_action' };
  if ((action === 'set' || (action === 'lead-only' && body.leadOnly === true)) && !chatManagerEnabled) return { ok: false, status: 409, error: 'chat_manager_disabled' };
  if (action === 'lead-only') return { ok: true, action, authAction: body.leadOnly ? 'lead-only-on' : 'lead-only-off', leadOnly: body.leadOnly as boolean };
  return { ok: true, action, authAction: action };
}
