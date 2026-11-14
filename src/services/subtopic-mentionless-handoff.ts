/**
 * Managed subtopic mentionless handoff in regular groups (`chat_mode === 'group'`).
 *
 * In a project group (`group-collaboration-modes.json` `mode === 'project'` with
 * `coordinatorAppId`), an authorized human's mentionless message inside a managed
 * subtopic is routed to the group coordinator's chat-scope session (replying back
 * inside that subtopic via `replyRootId = rootId`), unless a worker bot in that
 * subtopic currently has免@ enabled (`topic` / `ambient` / `never`) AND its
 * thread-scope session at `(rootId, chatId)` is still alive (`status === 'active'`).
 *
 * Managed subtopics in a project group include:
 *   1. `'imported'` — migrated/adopted thread sessions (`projectImportSource` /
 *      workstream or dispatch `attachment` with `state !== 'moved'`);
 *   2. `'dispatch'` — subtopics registered in `orchestrate-dispatch.json` for this chat;
 *   3. `'workstream'` — subtask topics registered in `project-groups.json` for this chat.
 *
 * In non-project groups, only active `'imported'` thread sessions participate,
 * preserving existing behavior for ordinary groups and unmanaged topics.
 */
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { readBotsInfoJson } from './bots-info-cache.js';
import { normalizeBotsInfoRouteEntries } from './bots-info-shape.js';
import { readGroupCollaborationMode } from './group-collaboration-mode-store.js';
import { PROJECT_GROUP_STORE_FILE, type ProjectGroupState, type ProjectWorkstream } from './project-group-store.js';

export const ORCHESTRATE_DISPATCH_STORE_FILE = 'orchestrate-dispatch.json';

export type ManagedSubtopicKind = 'imported' | 'dispatch' | 'workstream';

export interface SubtopicMentionlessHandoff {
  kind: ManagedSubtopicKind;
  sourceLarkAppId: string;
  sourceAnswersWithoutMention: boolean | 'unknown';
  hasProjectCoordinator: boolean;
  isProjectCoordinator: boolean;
  coordinatorMayFold?: boolean;
}

export interface SubtopicSessionSnapshot {
  sessionId?: string;
  larkAppId?: string;
  chatId?: string;
  scope?: 'thread' | 'chat';
  rootMessageId?: string;
  status?: string;
  projectImportSource?: unknown;
  replyThreadAliases?: Record<string, unknown>;
}

export interface ConfiguredBotIdentity {
  larkAppId: string;
  cliId?: string;
  botName?: string;
  botOpenId?: string;
}

export interface ResolveSubtopicHandoffDeps {
  dataDir: string;
  getLiveThreadSessionsAtRoot?: (rootId: string, chatId: string) => SubtopicSessionSnapshot[];
  findActiveSessionsByRoot: (rootId: string) => SubtopicSessionSnapshot[];
  findActiveChatScopeSessionsByChat?: (chatId: string) => SubtopicSessionSnapshot[];
  readSessionsByRoots?: (roots: ReadonlySet<string>) => SubtopicSessionSnapshot[];
  doesBotAnswerTopicWithoutMention: (targetAppId: string, chatId: string, observerAppId?: string) => boolean | 'unknown';
  getConfiguredBots?: () => ReadonlyArray<ConfiguredBotIdentity>;
}

type JsonFileCacheEntry = { version: string; value: Record<string, unknown> | undefined };

const jsonFileCache = new Map<string, JsonFileCacheEntry>();

function fileVersion(fp: string): string {
  try {
    const stat = statSync(fp);
    return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
  } catch (err: any) {
    if (err?.code === 'ENOENT') return 'missing';
    return `unavailable:${err?.code ?? 'unknown'}`;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmpty(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    const s = nonEmpty(item);
    if (s) out.push(s);
  }
  return out;
}

/**
 * Stat-fingerprinted read of a shared JSON object file. Re-parses only when the
 * file's `(dev, ino, size, mtimeMs, ctimeMs)` changes, and degrades to `undefined`
 * on missing or malformed files so corrupt auxiliary state cannot crash inbound routing.
 */
function readCachedJsonObject(fp: string): Record<string, unknown> | undefined {
  for (let attempt = 0; attempt < 3; attempt++) {
    const before = fileVersion(fp);
    const cached = jsonFileCache.get(fp);
    if (cached && cached.version === before) {
      return cached.value;
    }
    if (before === 'missing' || before.startsWith('unavailable:')) {
      jsonFileCache.set(fp, { version: before, value: undefined });
      return undefined;
    }
    let raw: string;
    try {
      raw = readFileSync(fp, 'utf8');
    } catch (err: any) {
      if (err?.code === 'ENOENT') continue;
      return undefined;
    }
    if (fileVersion(fp) !== before) continue;
    try {
      const parsed: unknown = JSON.parse(raw);
      const value = isPlainObject(parsed) ? parsed : undefined;
      jsonFileCache.set(fp, { version: before, value });
      return value;
    } catch {
      jsonFileCache.set(fp, { version: before, value: undefined });
      return undefined;
    }
  }
  try {
    const parsed: unknown = JSON.parse(readFileSync(fp, 'utf8'));
    return isPlainObject(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function __resetSubtopicHandoffCacheForTest(): void {
  jsonFileCache.clear();
}

function readDispatchEntryCached(dataDir: string, rootId: string): Record<string, unknown> | undefined {
  const reg = readCachedJsonObject(join(dataDir, ORCHESTRATE_DISPATCH_STORE_FILE));
  if (!reg) return undefined;
  const entry = reg[rootId];
  return isPlainObject(entry) ? entry : undefined;
}

function readProjectWorkstreamCached(dataDir: string, chatId: string, rootId: string): ProjectWorkstream | undefined {
  const reg = readCachedJsonObject(join(dataDir, PROJECT_GROUP_STORE_FILE));
  if (!reg || reg.schemaVersion !== 1 || !isPlainObject(reg.projects)) return undefined;
  const project = reg.projects[chatId] as Partial<ProjectGroupState> | undefined;
  if (!isPlainObject(project) || !Array.isArray(project.workstreams)) return undefined;
  for (const item of project.workstreams) {
    if (isPlainObject(item) && item.dispatchRoot === rootId) {
      return item as unknown as ProjectWorkstream;
    }
  }
  return undefined;
}

function safeReadCoordinatorAppId(dataDir: string, chatId: string): string | undefined {
  try {
    const mode = readGroupCollaborationMode(dataDir, chatId);
    if (mode?.mode === 'project') {
      return nonEmpty(mode.coordinatorAppId);
    }
  } catch {
    /* ignore malformed collaboration-mode file */
  }
  return undefined;
}

function collectActiveThreadSessionsAtRoot(
  deps: ResolveSubtopicHandoffDeps,
  rootId: string,
  chatId: string,
): SubtopicSessionSnapshot[] {
  const out: SubtopicSessionSnapshot[] = [];
  const seen = new Set<string>();
  const pushIfMatch = (s: SubtopicSessionSnapshot) => {
    const appId = nonEmpty(s.larkAppId);
    if (!appId) return;
    if (s.status !== 'active') return;
    if (s.chatId !== chatId) return;
    if ((s.scope ?? 'thread') !== 'thread') return;
    if (s.rootMessageId !== rootId) return;
    const dedupKey = nonEmpty(s.sessionId) ? `sid:${s.sessionId}` : `app:${appId}:${rootId}`;
    if (seen.has(dedupKey)) return;
    seen.add(dedupKey);
    out.push({ ...s, larkAppId: appId });
  };

  for (const s of deps.getLiveThreadSessionsAtRoot?.(rootId, chatId) ?? []) {
    pushIfMatch(s);
  }
  for (const s of deps.findActiveSessionsByRoot(rootId)) {
    pushIfMatch(s);
  }
  return out;
}

function resolveIdentifierToAppIds(
  dataDir: string,
  identifiers: readonly string[],
  configuredBots?: ReadonlyArray<ConfiguredBotIdentity>,
): string[] {
  if (identifiers.length === 0) return [];
  const byToken = new Map<string, Set<string>>();
  const addMapping = (token: string | null | undefined, appId: string) => {
    const key = nonEmpty(token);
    if (!key) return;
    let set = byToken.get(key);
    if (!set) {
      set = new Set<string>();
      byToken.set(key, set);
    }
    set.add(appId);
  };

  try {
    const entries = normalizeBotsInfoRouteEntries(readBotsInfoJson(dataDir));
    for (const entry of entries) {
      const appId = nonEmpty(entry.larkAppId);
      if (!appId) continue;
      addMapping(appId, appId);
      addMapping(entry.botName, appId);
      addMapping(entry.cliId, appId);
      addMapping(entry.botOpenId, appId);
    }
  } catch {
    /* ignore corrupt bots-info.json */
  }

  for (const cfg of configuredBots ?? []) {
    const appId = nonEmpty(cfg.larkAppId);
    if (!appId) continue;
    addMapping(appId, appId);
    addMapping(cfg.botName, appId);
    addMapping(cfg.cliId, appId);
    addMapping(cfg.botOpenId, appId);
  }

  const resolved: string[] = [];
  for (const raw of identifiers) {
    const token = nonEmpty(raw);
    if (!token) continue;
    if (token.startsWith('cli_')) {
      resolved.push(token);
      continue;
    }
    const matches = byToken.get(token);
    if (matches && matches.size === 1) {
      resolved.push([...matches][0]!);
    }
  }
  return resolved;
}

/**
 * Resolve the `larkAppId` of another bot that currently owns a live免@
 * (`topic` / `ambient` / `never`) thread session in a managed subtopic at
 * `(rootId, chatId)`. Used by `findChatReplyAlias` so a coordinator's historical
 * `replyThreadAliases[rootId]` never steals replies from a live免@ worker.
 */
export function findLiveMentionlessSubtopicOwner(
  deps: ResolveSubtopicHandoffDeps,
  rootId: string,
  chatId: string,
  excludeAppId?: string,
): string | undefined {
  if (!rootId || !chatId) return undefined;
  const handoff = resolveManagedSubtopicMentionlessHandoff(
    deps,
    rootId,
    chatId,
    excludeAppId ?? '__probe__',
  );
  if (handoff?.sourceAnswersWithoutMention === true && handoff.sourceLarkAppId !== excludeAppId) {
    return handoff.sourceLarkAppId;
  }
  return undefined;
}

/**
 * Inspect `(rootId, chatId)` from `currentAppId`'s perspective to determine
 * whether mentionless human messages in this subtopic belong to a live免@
 * worker or should fall back to the group coordinator.
 */
export function resolveManagedSubtopicMentionlessHandoff(
  deps: ResolveSubtopicHandoffDeps,
  rootId: string,
  chatId: string,
  currentAppId: string,
): SubtopicMentionlessHandoff | null {
  if (!rootId || !chatId || !currentAppId) return null;

  const coordinatorAppId = safeReadCoordinatorAppId(deps.dataDir, chatId);
  const hasProjectCoordinator = !!coordinatorAppId;
  const activeThreadSessions = collectActiveThreadSessionsAtRoot(deps, rootId, chatId);

  // Non-project groups: preserve existing behavior strictly (only active imported
  // thread sessions owned by another bot participate).
  if (!hasProjectCoordinator) {
    const imported = activeThreadSessions.find(
      s => !!s.projectImportSource && s.larkAppId !== currentAppId,
    );
    if (!imported?.larkAppId) return null;
    return {
      kind: 'imported',
      sourceLarkAppId: imported.larkAppId,
      sourceAnswersWithoutMention: deps.doesBotAnswerTopicWithoutMention(imported.larkAppId, chatId, currentAppId),
      hasProjectCoordinator: false,
      isProjectCoordinator: false,
    };
  }

  // Project group (`mode === 'project'` with `coordinatorAppId`).
  // A coordinator that owns its own thread-scope session at this root (e.g. it
  // was @-ed inside the topic under `chat-topic` reply mode) is NOT exempted
  // here: a live免@ worker below still wins and the coordinator yields (no
  // double reply). Without such a worker the dispatcher's `continuesRoot`
  // (isSessionOwner) keeps the coordinator on its own thread session.
  let matchedImported = false;
  let matchedDispatch = false;
  let matchedWorkstream = false;

  const candidateWorkers: string[] = [];
  const seenCandidates = new Set<string>();
  const addCandidateWorker = (appId: string | undefined) => {
    const id = nonEmpty(appId);
    if (!id || id === coordinatorAppId || seenCandidates.has(id)) return;
    seenCandidates.add(id);
    candidateWorkers.push(id);
  };

  // 1. Active imported thread sessions at (rootId, chatId)
  for (const s of activeThreadSessions) {
    if (s.projectImportSource) {
      matchedImported = true;
      addCandidateWorker(s.larkAppId);
    }
  }

  // 2. Dispatch subtopics in orchestrate-dispatch.json
  const dispatchEntry = readDispatchEntryCached(deps.dataDir, rootId);
  if (dispatchEntry) {
    const entryChatId = nonEmpty(dispatchEntry.targetChatId) ?? nonEmpty(dispatchEntry.orchChatId);
    const dispatchAttachment = isPlainObject(dispatchEntry.projectAttachment)
      ? dispatchEntry.projectAttachment
      : undefined;
    const attachmentMoved = dispatchAttachment?.state === 'moved';
    if (entryChatId === chatId && !attachmentMoved) {
      if (dispatchAttachment) {
        matchedImported = true;
        addCandidateWorker(nonEmpty(dispatchAttachment.sourceLarkAppId));
      } else {
        matchedDispatch = true;
      }
      for (const id of stringList(dispatchEntry.acceptedBotAppIds)) addCandidateWorker(id);
      for (const id of stringList(dispatchEntry.targetAppIds)) addCandidateWorker(id);
      const rawBots = stringList(dispatchEntry.bots);
      if (rawBots.length > 0) {
        for (const id of resolveIdentifierToAppIds(deps.dataDir, rawBots, deps.getConfiguredBots?.())) {
          addCandidateWorker(id);
        }
      }
    }
  }

  // 3. Project card workstream topics in project-groups.json
  const workstream = readProjectWorkstreamCached(deps.dataDir, chatId, rootId);
  if (workstream) {
    const wsAttachment = isPlainObject(workstream.attachment) ? workstream.attachment : undefined;
    const attachmentMoved = wsAttachment?.state === 'moved';
    if (!attachmentMoved) {
      if (wsAttachment && nonEmpty(wsAttachment.sourceLarkAppId) && wsAttachment.source !== 'manual') {
        matchedImported = true;
        addCandidateWorker(nonEmpty(wsAttachment.sourceLarkAppId));
      } else {
        matchedWorkstream = true;
      }
      if (wsAttachment) {
        addCandidateWorker(nonEmpty(wsAttachment.sourceLarkAppId));
      }
      const owners = stringList(workstream.owners);
      if (owners.length > 0) {
        for (const id of resolveIdentifierToAppIds(deps.dataDir, owners, deps.getConfiguredBots?.())) {
          addCandidateWorker(id);
        }
      }
    }
  }

  // 4. Fallback check for closed legacy imported sessions (not yet projected into
  //    project-groups.json or orchestrate-dispatch.json) when no other source matched.
  if (!matchedImported && !matchedDispatch && !matchedWorkstream && deps.readSessionsByRoots) {
    for (const s of deps.readSessionsByRoots(new Set([rootId]))) {
      const appId = nonEmpty(s.larkAppId);
      if (!appId) continue;
      if (s.chatId === chatId
          && (s.scope ?? 'thread') === 'thread'
          && s.rootMessageId === rootId
          && !!s.projectImportSource) {
        matchedImported = true;
        addCandidateWorker(appId);
      }
    }
  }

  if (!matchedImported && !matchedDispatch && !matchedWorkstream) {
    return null;
  }

  // Also include any non-coordinator bot currently holding a live thread session
  // in this managed subtopic (e.g. a sibling worker that joined the thread).
  const activeWorkerAppIds = new Set<string>();
  for (const s of activeThreadSessions) {
    if (s.larkAppId && s.larkAppId !== coordinatorAppId) {
      activeWorkerAppIds.add(s.larkAppId);
      addCandidateWorker(s.larkAppId);
    }
  }

  const kind: ManagedSubtopicKind = matchedImported
    ? 'imported'
    : (matchedDispatch ? 'dispatch' : 'workstream');

  // If a worker in this managed subtopic has免@ enabled (`topic`/`ambient`/`never`)
  // AND its thread session at (rootId, chatId) is STILL ALIVE, keep routing to that
  // worker and make the coordinator + all other bots yield (no double-reply).
  const liveAnsweringWorker = candidateWorkers.find(
    appId => activeWorkerAppIds.has(appId) && deps.doesBotAnswerTopicWithoutMention(appId, chatId, currentAppId) === true,
  );
  if (liveAnsweringWorker) {
    if (currentAppId === liveAnsweringWorker) {
      return null;
    }
    return {
      kind,
      sourceLarkAppId: liveAnsweringWorker,
      sourceAnswersWithoutMention: true,
      hasProjectCoordinator: true,
      isProjectCoordinator: currentAppId === coordinatorAppId,
    };
  }

  const liveUnknownWorker = candidateWorkers.find(
    appId => activeWorkerAppIds.has(appId) && deps.doesBotAnswerTopicWithoutMention(appId, chatId, currentAppId) === 'unknown',
  );
  if (liveUnknownWorker) {
    if (currentAppId === liveUnknownWorker) {
      return null;
    }
    return {
      kind,
      sourceLarkAppId: liveUnknownWorker,
      sourceAnswersWithoutMention: 'unknown',
      hasProjectCoordinator: true,
      isProjectCoordinator: currentAppId === coordinatorAppId,
    };
  }

  const isCoord = currentAppId === coordinatorAppId;
  let thirdBotContinuesViaAlias = false;
  if (isCoord && deps.findActiveChatScopeSessionsByChat) {
    for (const s of deps.findActiveChatScopeSessionsByChat(chatId)) {
      const peerId = nonEmpty(s.larkAppId);
      if (!peerId || peerId === currentAppId) continue;
      if (s.status === 'active' && s.chatId === chatId && s.scope === 'chat' && s.replyThreadAliases?.[rootId]) {
        if (deps.doesBotAnswerTopicWithoutMention(peerId, chatId, currentAppId) !== false) {
          thirdBotContinuesViaAlias = true;
          break;
        }
      }
    }
  }

  return {
    kind,
    sourceLarkAppId: candidateWorkers[0] ?? coordinatorAppId!,
    sourceAnswersWithoutMention: false,
    hasProjectCoordinator: true,
    isProjectCoordinator: isCoord,
    ...(thirdBotContinuesViaAlias ? { coordinatorMayFold: false } : {}),
  };
}
