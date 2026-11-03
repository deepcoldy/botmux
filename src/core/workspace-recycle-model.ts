import { createHash } from 'node:crypto';
import type { Session } from '../types.js';
import { canonicalWorkspacePath, pathInside, type WorkspaceIdentity } from './workspace-recycle-path.js';

export const WORKSPACE_RECYCLE_PROTOCOL = 'botmux.workspace-recycle.v1';

/** Only identity/ownership fields. No prompts, credentials, or transcript. */
export interface WorkspaceSessionTarget {
  sessionId: string;
  larkAppId: string;
  chatId: string;
  rootMessageId: string;
  scope: 'chat' | 'thread';
  createdAt: string;
  workingDir: string;
  canonicalWorkingDir: string;
  backendType?: Session['backendType'];
  persistentBackendTarget?: Session['persistentBackendTarget'];
  cliSessionId?: string;
  fingerprint: string;
  evidence: 'session.workingDir';
}

export function targetFingerprint(session: Session): string {
  return createHash('sha256').update(JSON.stringify([
    session.sessionId, session.larkAppId, session.chatId, session.rootMessageId,
    session.scope ?? 'thread', session.createdAt, session.workingDir,
    session.backendType ?? null, session.persistentBackendTarget ?? null,
    session.cliSessionId ?? null, session.adoptedFrom ?? null,
    session.existingAppServerEndpoint ?? null,
  ])).digest('hex');
}

export function workspaceTarget(session: Session, workspace: Pick<WorkspaceIdentity, 'canonicalPath'>): WorkspaceSessionTarget | undefined {
  if (!session.workingDir) return undefined;
  const canonicalWorkingDir = canonicalWorkspacePath(session.workingDir);
  if (!pathInside(workspace.canonicalPath, canonicalWorkingDir)) return undefined;
  if (!session.larkAppId || !session.sessionId || !session.chatId || !session.createdAt) {
    throw new Error('session_owner_or_identity_missing');
  }
  return {
    sessionId: session.sessionId, larkAppId: session.larkAppId,
    chatId: session.chatId, rootMessageId: session.rootMessageId,
    scope: session.scope ?? 'thread', createdAt: session.createdAt,
    workingDir: session.workingDir, canonicalWorkingDir,
    backendType: session.backendType,
    persistentBackendTarget: session.persistentBackendTarget,
    cliSessionId: session.cliSessionId,
    fingerprint: targetFingerprint(session), evidence: 'session.workingDir',
  };
}

export interface WorkspaceDiscovery {
  protocol: typeof WORKSPACE_RECYCLE_PROTOCOL;
  workspace: { path: string; canonicalPath: string };
  targets: WorkspaceSessionTarget[];
  excluded: Array<{ sessionId: string; larkAppId?: string; reason: string }>;
  errors: Array<{ sessionId: string; error: string }>;
}

export function discoverWorkspaceSessions(sessions: Session[], path: string): WorkspaceDiscovery {
  const workspace = { path, canonicalPath: canonicalWorkspacePath(path) };
  const result: WorkspaceDiscovery = { protocol: WORKSPACE_RECYCLE_PROTOCOL, workspace, targets: [], excluded: [], errors: [] };
  const counts = new Map<string, number>();
  for (const session of sessions) counts.set(session.sessionId, (counts.get(session.sessionId) ?? 0) + 1);
  for (const session of sessions) {
    try {
      const target = workspaceTarget(session, workspace);
      if (!target) continue;
      if (counts.get(session.sessionId)! > 1) {
        result.errors.push({ sessionId: session.sessionId, error: 'ambiguous_session_owner' });
      } else if (session.adoptedFrom || session.existingAppServerEndpoint) {
        result.excluded.push({ sessionId: session.sessionId, larkAppId: session.larkAppId, reason: 'external_or_shared_session' });
      } else if (session.status === 'closed') {
        result.excluded.push({ sessionId: session.sessionId, larkAppId: session.larkAppId, reason: 'already_closed' });
      } else {
        result.targets.push(target);
      }
    } catch (error) {
      // A failed ownership read is a coverage gap, even if the row would have
      // turned out unrelated. Never turn an unreadable path into an empty set.
      result.errors.push({ sessionId: session.sessionId, error: String(error) });
    }
  }
  result.targets.sort((a, b) => a.larkAppId.localeCompare(b.larkAppId) || a.sessionId.localeCompare(b.sessionId));
  return result;
}
