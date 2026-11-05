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
