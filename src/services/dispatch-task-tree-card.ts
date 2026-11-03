/**
 * Keeps one task-tree card per orchestrating session up to date: the first
 * refresh after a dispatch posts it into the orchestrator's own topic; every
 * later refresh (acceptance, a child's report, a manual `botmux dispatch tree`)
 * patches that same message.
 *
 * Card ids, thread ids and the requirement link live in
 * `<dataDir>/dispatch-task-tree-cards.json`, keyed by the orchestrating session.
 * Refreshes for one session run one at a time so two concurrent first refreshes
 * cannot post two cards.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { updateDispatchRegistry, type DispatchRegistry } from '../core/dispatch-registry.js';
import {
  buildDispatchTaskTree, renderDispatchTaskTreeCard, renderDispatchTaskTreeText,
  type TaskTree, type TaskTreeSessionRow,
} from '../core/dispatch-task-tree.js';
import type { Brand } from '../im/lark/lark-hosts.js';
import { MessageUpdateExpiredError, MessageWithdrawnError } from '../im/lark/client.js';
import { TopicSendError } from '../cli/topic-send-guard.js';

export const DISPATCH_TASK_TREE_CARDS_FILE = 'dispatch-task-tree-cards.json';

export interface TaskTreeRequirement { id?: string; url?: string }

interface CardRecord {
  messageId?: string;
  larkAppId?: string;
  requirement?: TaskTreeRequirement;
  threadIds?: Record<string, string>;
  updatedAt?: string;
}

export interface TaskTreeOrchestrator {
  sessionId: string;
  larkAppId: string;
  chatId: string;
  /** Topic root for a thread-scope session; absent for a chat-scope one. */
  rootMessageId?: string;
  title: string;
}

export interface DispatchTaskTreeCardDeps {
  /** Accepted as a getter so daemon wiring is not forced to read config at
   *  module-load time just by constructing this service. */
  dataDir: string | (() => string);
  /** Rows for the given dispatch roots only — a narrow indexed read, never a
   *  full cross-store snapshot (a report-driven refresh is a hot path). */
  listSessions(roots: ReadonlySet<string>): Iterable<TaskTreeSessionRow>;
  localAppIds(): ReadonlySet<string>;
  resolveThreadId(larkAppId: string, messageId: string): Promise<string | null>;
  /** Post the card into the orchestrator's topic (or chat); returns the message id. */
  post(orch: TaskTreeOrchestrator, cardJson: string): Promise<string>;
  update(larkAppId: string, messageId: string, cardJson: string): Promise<void>;
  /** True for an error meaning the card message is gone (withdrawn/deleted). */
  isMessageGone(error: unknown): boolean;
  brand(larkAppId: string): Brand;
  log(message: string): void;
  now?(): Date;
}

export interface TaskTreeRefreshResult {
  tree: TaskTree;
  text: string;
  messageId?: string;
  posted: boolean;
}

/** Missing file reads as empty; an unreadable one throws, so a refresh never
 *  posts a card it could not remember (that would repeat on every refresh). */
function readJsonObject(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf-8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${path} is not a JSON object`);
  return parsed as Record<string, unknown>;
}

/** A topic whose thread id could not be resolved is retried after this long. */
export const THREAD_ID_RETRY_MS = 10 * 60_000;

/** The card can no longer be patched: withdrawn (a 'stop'-policy bot reports
 *  that as TOPIC_SEND_BLOCKED), or too old for Feishu to edit. Post a fresh one. */
export function isTaskTreeCardGone(error: unknown): boolean {
  return error instanceof MessageWithdrawnError || error instanceof MessageUpdateExpiredError
    || (error instanceof TopicSendError && error.code === 'TOPIC_SEND_BLOCKED');
}

export function createDispatchTaskTreeCards(deps: DispatchTaskTreeCardDeps) {
  const resolveDataDir = () => (typeof deps.dataDir === 'function' ? deps.dataDir() : deps.dataDir);
  const chains = new Map<string, Promise<unknown>>();
  const threadMisses = new Map<string, number>();

  const writeRecord = (sessionId: string, patch: Partial<CardRecord>) =>
    updateDispatchRegistry(join(resolveDataDir(), DISPATCH_TASK_TREE_CARDS_FILE), (store: DispatchRegistry) => {
      const current = (store[sessionId] && typeof store[sessionId] === 'object' ? store[sessionId] : {}) as CardRecord;
      store[sessionId] = { ...current, ...patch };
    });

  async function refreshNow(orch: TaskTreeOrchestrator, opts: {
    requirement?: TaskTreeRequirement;
    /** Post a card when none exists yet. Off for a report that arrives with no card. */
    allowPost?: boolean;
  }): Promise<TaskTreeRefreshResult> {
    const dataDir = resolveDataDir();
    const cardsPath = join(dataDir, DISPATCH_TASK_TREE_CARDS_FILE);
    const registryPath = join(dataDir, 'orchestrate-dispatch.json');
    const record = (readJsonObject(cardsPath)[orch.sessionId] ?? {}) as CardRecord;
    const requirement = opts.requirement && (opts.requirement.id || opts.requirement.url)
      ? opts.requirement : record.requirement;
    const registry = readJsonObject(registryPath) as DispatchRegistry;
    const threadIds = { ...(record.threadIds ?? {}) };
    let threadsChanged = false;
    const nowMs = (deps.now?.() ?? new Date()).getTime();
    // Every dispatch root owned by this orchestrating session. The session
    // lookup is narrowed to exactly these roots so a refresh never scans all
    // stores' full session tables on the report hot path.
    const orchRoots = new Set(Object.entries(registry)
      .filter(([, raw]) => !!raw && typeof raw === 'object' && !Array.isArray(raw)
        && (raw as Record<string, unknown>).orchSessionId === orch.sessionId)
      .map(([root]) => root));
    const unresolved = [...orchRoots].filter(root => {
      if (threadIds[root]) return false;
      const entry = registry[root] as Record<string, unknown> | null;
      // A seed that never went out has no topic to link to.
      if (entry?.transportState === 'failed') return false;
      const missedAt = threadMisses.get(root);
      return missedAt === undefined || nowMs - missedAt >= THREAD_ID_RETRY_MS;
    });
    // The seed is sent by the orchestrating bot, so its app can read it.
    const resolved = await Promise.all(unresolved.map(root => deps.resolveThreadId(orch.larkAppId, root).catch(() => null)));
    unresolved.forEach((root, i) => {
      const threadId = resolved[i];
      if (threadId) { threadIds[root] = threadId; threadMisses.delete(root); threadsChanged = true; }
      else threadMisses.set(root, nowMs);
    });
    const tree = buildDispatchTaskTree({
      registry, orchSessionId: orch.sessionId, title: orch.title,
      ...(requirement ? { requirement } : {}),
      sessions: deps.listSessions(orchRoots), localAppIds: deps.localAppIds(), threadIds,
    });
    const text = renderDispatchTaskTreeText(tree);
    const cardJson = JSON.stringify(renderDispatchTaskTreeCard(tree, {
      brand: deps.brand(orch.larkAppId), ...(deps.now ? { now: deps.now() } : {}),
    }));
    let messageId = record.larkAppId === orch.larkAppId ? record.messageId : undefined;
    let posted = false;
    if (messageId) {
      try {
        await deps.update(orch.larkAppId, messageId, cardJson);
      } catch (error) {
        if (!deps.isMessageGone(error)) throw error;
        deps.log(`[task-tree:${orch.sessionId.slice(0, 8)}] card ${messageId} is gone; posting a new one`);
        messageId = undefined;
      }
    }
    if (!messageId && tree.nodes.length > 0 && (opts.allowPost ?? true)) {
      messageId = await deps.post(orch, cardJson);
      posted = true;
    }
    if (posted || threadsChanged || requirement !== record.requirement) {
      const patch = {
        ...(messageId ? { messageId, larkAppId: orch.larkAppId } : {}),
        ...(requirement ? { requirement } : {}),
        threadIds,
        updatedAt: (deps.now?.() ?? new Date()).toISOString(),
      };
      // Losing a just-posted card id means the next refresh posts another card.
      await writeRecord(orch.sessionId, patch).catch(async (error) => {
        if (!posted) throw error;
        await writeRecord(orch.sessionId, patch).catch((retryError) => {
          deps.log(`[task-tree:${orch.sessionId.slice(0, 8)}] posted card ${messageId} but could not save it: ${retryError instanceof Error ? retryError.message : String(retryError)}`);
          throw retryError;
        });
      });
    }
    return { tree, text, ...(messageId ? { messageId } : {}), posted };
  }

  return {
    refresh(orch: TaskTreeOrchestrator, opts: { requirement?: TaskTreeRequirement; allowPost?: boolean } = {}) {
      const previous = chains.get(orch.sessionId) ?? Promise.resolve();
      const next = previous.catch(() => undefined).then(() => refreshNow(orch, opts));
      chains.set(orch.sessionId, next);
      void next.finally(() => { if (chains.get(orch.sessionId) === next) chains.delete(orch.sessionId); }).catch(() => undefined);
      return next;
    },
  };
}

export type DispatchTaskTreeCards = ReturnType<typeof createDispatchTaskTreeCards>;
