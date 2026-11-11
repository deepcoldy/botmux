import type { ProjectImportSnapshot, ProjectImportSource } from './project-import-notifications.js';

/** Pure source projection shared by the sender and trusted receiver. Keeping
 * this module free of runtime imports avoids starting the worker-pool/IPC
 * dependency graph merely to validate an import notification. */
export interface ProjectImportSnapshotSource {
  sessionId: string;
  larkAppId: string;
  chatId: string;
  rootMessageId: string;
  chatType?: 'group' | 'p2p';
  scope: 'thread' | 'chat';
  status: string;
  routeRevision: number;
  ordinary: boolean;
  source: ProjectImportSource | 'manual';
}

const IMPORT_SOURCES = new Set<string>(['relay', 'bind', 'adopt', 'resume_import', 'fork']);

export function projectImportSnapshotFromSource(source: ProjectImportSnapshotSource | undefined): ProjectImportSnapshot | undefined {
  if (!source || !IMPORT_SOURCES.has(source.source)
    || (source.chatType !== 'group' && source.chatType !== 'p2p')) return;
  return {
    sessionId: source.sessionId, larkAppId: source.larkAppId,
    chatId: source.chatId, rootMessageId: source.rootMessageId,
    chatType: source.chatType, scope: source.scope, status: source.status,
    routeRevision: source.routeRevision, ordinary: source.ordinary,
    source: source.source as ProjectImportSource,
  };
}
