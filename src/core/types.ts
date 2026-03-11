import type { ChildProcess } from 'node:child_process';
import type { Session, DaemonToWorker } from '../types.js';
import type { ImAttachment } from '../im/types.js';

/** Core session state — IM-agnostic.
 *  IM-specific rendering state (ImRenderState) is stored separately
 *  in the ImAdapter implementation (e.g. Map<string, ImRenderState>
 *  inside LarkImAdapter), NOT on this type. */
export interface DaemonSession {
  session: Session;
  worker: ChildProcess | null;
  workerPort: number | null;
  workerToken: string | null;
  chatId: string;
  chatType: 'group' | 'p2p';
  spawnedAt: number;
  claudeVersion: string;
  lastMessageAt: number;
  hasHistory: boolean;
  workingDir?: string;
  initConfig?: DaemonToWorker;
  pendingRepo?: boolean;
  pendingPrompt?: string;
  pendingAttachments?: ImAttachment[];
  ownerUserId?: string;
  currentTurnTitle?: string;
}
