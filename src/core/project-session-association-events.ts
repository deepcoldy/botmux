import type { Session } from '../types.js';
import { config } from '../config.js';
import { readGroupCollaborationMode, type GroupCollaborationModeConfig } from '../services/group-collaboration-mode-store.js';
import { readProjectGroup, type ProjectGroupState } from '../services/project-group-store.js';

/**
 * Effective import notification policy for a chat. `importedSessionPolicy` is
 * the single group-level switch (default `'ignore'`, Dashboard → 群组 → 项目模式):
 * - Initialized project (`project` exists and matches `mode.coordinatorAppId`):
 *   `'notify'` wakes the coordinator with a metadata-only notice turn.
 * - Uninitialized project group (`mode.mode === 'project'` with no `project` yet):
 *   the same switch still governs. When on, the host only posts a waiting card in
 *   the imported topic and keeps the notification pending until a human
 *   initializes the project; no coordinator session is created for it.
 * - A project owned by another coordinator app never notifies.
 */
export function effectiveProjectImportPolicy(
  mode: GroupCollaborationModeConfig | undefined,
  project: ProjectGroupState | undefined,
): 'ignore' | 'notify' {
  if (mode?.mode !== 'project' || !mode.coordinatorAppId || mode.importedSessionPolicy !== 'notify') return 'ignore';
  if (project && project.larkAppId !== mode.coordinatorAppId) return 'ignore';
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
