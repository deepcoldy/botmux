import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getBot, getBotBrand } from '../bot-registry.js';
import { fetchDaemonIpc } from '../core/daemon-ipc-auth.js';
import type { SessionTaskFacts } from '../core/session-task-status.js';
import {
  getMessageThreadId,
  pinMessage,
  sendMessage,
  unpinMessage,
  updateMessage,
} from '../im/lark/client.js';
import type { ProjectGroupCardRuntime } from '../im/lark/project-group-card.js';
import { findOnlineDaemon } from '../utils/daemon-discovery.js';
import { ProjectCoordinator } from './project-coordinator.js';
import { visibleProjectWorkstreams, type ProjectGroupState } from './project-group-store.js';

const APP_ID_TOKEN_RE = /^cli_[A-Za-z0-9_-]{1,128}$/u;

function resolveStoredDaemonBotName(appId: string, dataDir: string): string | undefined {
  let entries: string[] = [];
  try {
    entries = readdirSync(join(dataDir, 'dashboard-daemons'));
  } catch {
    return undefined;
  }
  for (const name of entries) {
    if (!name.endsWith('.json')) continue;
    try {
      const parsed = JSON.parse(readFileSync(join(dataDir, 'dashboard-daemons', name), 'utf8')) as {
        larkAppId?: unknown;
        botName?: unknown;
      };
      if (parsed.larkAppId === appId && typeof parsed.botName === 'string' && parsed.botName.trim()) {
        return parsed.botName.trim();
      }
    } catch { /* ignore malformed descriptor */ }
  }
  return undefined;
}

export function resolveBotDisplayNameForProjectCard(appId: string, dataDir: string): string {
  try {
    const local = getBot(appId)?.botName?.trim();
    if (local) return local;
  } catch { /* peer bot not registered in this daemon */ }
  const online = findOnlineDaemon(appId, dataDir)?.botName?.trim();
  if (online) return online;
  return resolveStoredDaemonBotName(appId, dataDir) || appId;
}

async function fetchAttachedSessionTaskFacts(
  appId: string,
  sessionId: string,
  dataDir: string,
): Promise<{ probed: boolean; facts?: SessionTaskFacts }> {
  const daemon = findOnlineDaemon(appId, dataDir);
  if (!daemon) return { probed: false };
  const response = await fetchDaemonIpc(
    daemon.ipcPort,
    `/api/sessions/${encodeURIComponent(sessionId)}`,
    { signal: AbortSignal.timeout(2_500) },
  ).catch(() => undefined);
  if (!response) return { probed: false };
  if (response.status === 404) {
    await response.body?.cancel().catch(() => undefined);
    return { probed: true, facts: undefined };
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    return { probed: false };
  }
  const body = await response.json().catch(() => undefined) as { session?: SessionTaskFacts } | undefined;
  if (!body?.session || typeof body.session !== 'object') return { probed: false };
  return { probed: true, facts: body.session };
}

export async function resolveProjectGroupCardRuntime(
  project: ProjectGroupState,
  dataDir: string,
): Promise<ProjectGroupCardRuntime> {
  const ownerDisplayNames: Record<string, string> = {};
  const visible = visibleProjectWorkstreams(project);
  for (const item of visible) {
    for (const token of item.owners) {
      const trimmed = token.trim();
      if (APP_ID_TOKEN_RE.test(trimmed) && !(trimmed in ownerDisplayNames)) {
        ownerDisplayNames[trimmed] = resolveBotDisplayNameForProjectCard(trimmed, dataDir);
      }
    }
    const sourceAppId = item.attachment?.sourceLarkAppId?.trim();
    if (sourceAppId && APP_ID_TOKEN_RE.test(sourceAppId) && !(sourceAppId in ownerDisplayNames)) {
      ownerDisplayNames[sourceAppId] = resolveBotDisplayNameForProjectCard(sourceAppId, dataDir);
    }
  }

  const sessionFactsByRoot: Record<string, SessionTaskFacts | undefined> = {};
  await Promise.all(visible.map(async item => {
    const att = item.attachment;
    if (!att) return;
    if (item.status === 'completed' || item.status === 'failed' || item.status === 'blocked') return;
    if (att.state === 'closed' || att.state === 'pending') return;
    const { probed, facts } = await fetchAttachedSessionTaskFacts(att.sourceLarkAppId, att.sourceSessionId, dataDir);
    if (probed) {
      sessionFactsByRoot[item.dispatchRoot] = facts;
    }
  }));

  return { ownerDisplayNames, sessionFactsByRoot };
}

/** One process-wide coordinator keeps projection updates serialized while the
 * durable ProjectStore remains the cross-restart source of truth. */
export const projectCoordinator = new ProjectCoordinator({
  sendCard: (larkAppId, chatId, cardJson) => sendMessage(larkAppId, chatId, cardJson, 'interactive'),
  updateCard: (larkAppId, messageId, cardJson) => updateMessage(larkAppId, messageId, cardJson),
  pinMessage: async (larkAppId, messageId) => !!(await pinMessage(larkAppId, messageId)),
  unpinMessage: async (larkAppId, messageId) => !!(await unpinMessage(larkAppId, messageId)),
  resolveThreadId: (larkAppId, dispatchRoot) => getMessageThreadId(larkAppId, dispatchRoot),
  isMessageWithdrawn: error => error instanceof Error && error.name === 'MessageWithdrawnError',
  isMessageUpdateExpired: error => error instanceof Error && error.name === 'MessageUpdateExpiredError',
  brand: larkAppId => getBotBrand(larkAppId),
  resolveCardRuntime: (project, dataDir) => resolveProjectGroupCardRuntime(project, dataDir),
});
