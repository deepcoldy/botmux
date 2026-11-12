import type { Session } from '../types.js';
import { config } from '../config.js';
import { readGroupCollaborationMode, type GroupCollaborationModeConfig } from '../services/group-collaboration-mode-store.js';
import { readProjectGroup, type ProjectGroupState } from '../services/project-group-store.js';

/**
 * Effective import notification policy for a chat:
 * - Initialized project (`project` exists and matches `mode.coordinatorAppId`):
 *   respects `mode.importedSessionPolicy` (`'notify'` vs `'ignore'`).
 * - Uninitialized project group (`mode.mode === 'project'` with no `project` yet):
 *   defaults to `'notify'` so `/relay` or `/adopt` wakes the coordinator to initialize
 *   the project just like a human's first message in the group.
 */
export function effectiveProjectImportPolicy(
  mode: GroupCollaborationModeConfig | undefined,
  project: ProjectGroupState | undefined,
): 'ignore' | 'notify' {
  if (mode?.mode !== 'project' || !mode.coordinatorAppId) return 'ignore';
  if (project) {
    return project.larkAppId === mode.coordinatorAppId && mode.importedSessionPolicy === 'notify'
      ? 'notify'
      : 'ignore';
  }
  return 'notify';
}

/** Called inside an explicit import's session commit. It does not wake models,
 * write the outbox or infer that plain new sessions are project tasks. */
export function markProjectImportPending(session: Session): void {
  session.projectImportPending = false;
  if (session.chatType !== 'group' || session.scope !== 'thread'
    || !session.larkAppId || !session.projectImportSource
    || session.workflowNode || session.vcMeetingReceiver || session.messageListenerRun
    || session.deferredScheduleRun) return;
  try {
    const mode = readGroupCollaborationMode(config.session.dataDir, session.chatId);
    const project = readProjectGroup(config.session.dataDir, session.chatId);
    session.projectImportPending = effectiveProjectImportPolicy(mode, project) === 'notify'
      && mode?.coordinatorAppId !== session.larkAppId
      && !!mode?.workerAppIds?.includes(session.larkAppId);
  } catch { /* Default off on an unavailable policy, never block the import. */ }
}

/** Internal post-commit signal. Consumers cannot mint or move a conversation.
 * Runtime/profile changes are not new business tasks. */
export type ProjectAssociationEvent = {
  sessionId: string; larkAppId: string; chatId: string; rootMessageId: string;
  status: string; scope: 'chat' | 'thread';
};
let consumer: ((event: ProjectAssociationEvent) => void) | undefined;
export function setProjectAssociationConsumer(value: typeof consumer): void { consumer = value; }
export function noteProjectAssociationChanged(session: Session): void {
  if (!session.larkAppId) return;
  try {
    consumer?.({
      sessionId: session.sessionId, larkAppId: session.larkAppId,
      chatId: session.chatId, rootMessageId: session.rootMessageId,
      status: session.status, scope: session.scope ?? 'thread',
    });
  } catch { /* A projection fault must not roll back an already committed route. */ }
}
