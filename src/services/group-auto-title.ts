/**
 * AI title for unnamed groups created by the /group (`/g`) command.
 *
 * Same two-phase naming as session groups (p2pMode='group'): the chat is
 * created with a placeholder name, then the first substantive human message
 * the creator bot handles in it is summarised by the bot's own CLI
 * (generateOneShotTitle) and the chat is renamed. With `--avatar name` the
 * avatar is re-rendered from the final name so it never shows the placeholder.
 *
 * Deliberately NOT the session-group registry: isSessionGroup() drives talk
 * provenance, quota and /dismiss semantics a /g group must not inherit. This
 * registry only answers "is an AI title still pending for this chat?", and an
 * entry is dropped once the title lands, a member renamed the chat first, the
 * bot may not edit it, or the bounded rounds run out.
 *
 * Only the creator bot holds the entry (one file per bot at
 * `${dataDir}/group-auto-title-${appId}.json`), so in a multi-bot group the
 * title comes from the first message the creator bot itself handles.
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { config } from '../config.js';
import { chatRenameSerialQueue } from '../core/chat-rename.js';
import { executeChatRename } from '../core/chat-rename-operation.js';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { logger } from '../utils/logger.js';
import { formatSlashGroupName } from './group-creation-options.js';
import { getChatName, renameChat } from './groups-store.js';
import { getBot } from '../bot-registry.js';
import { DEFAULT_TITLE_MAX_LEN, MAX_SESSION_GROUP_TITLE_ROUNDS, generateOneShotTitle, oneShotTitleAllowed } from './session-group-title.js';
import * as sessionStore from './session-store.js';

export interface GroupAutoTitleEntry {
  /** Name the chat was created with. A different live name means a member
   *  renamed it before the title landed — their choice wins. */
  placeholderName: string;
  /** `groupNamePrefix` in effect at creation, applied to the AI title. */
  namePrefix?: string;
  /** Re-render the name avatar (`--avatar name`) from the final title. */
  nameAvatar?: boolean;
  createdAt: number;
  /** Failed rounds so far; the entry is dropped at the session-group cap. */
  titleAttempts?: number;
  /** Earliest epoch-ms at which another round may start. */
  titleRetryAt?: number;
}

/** A chat that never saw a substantive message stops being worth tracking. */
const ENTRY_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const registries = new Map<string, Map<string, GroupAutoTitleEntry>>();
const inFlight = new Set<string>();
/** In-memory only: settles once /g finished its creation-time decorations. A
 *  restart cannot race them (the creating call is gone with the process). */
const decorationGates = new Map<string, Promise<unknown>>();

function filePath(larkAppId: string): string {
  return join(config.session.dataDir, `group-auto-title-${larkAppId}.json`);
}

function load(larkAppId: string): Map<string, GroupAutoTitleEntry> {
  const cached = registries.get(larkAppId);
  if (cached) return cached;
  const entries = new Map<string, GroupAutoTitleEntry>();
  const fp = filePath(larkAppId);
  if (existsSync(fp)) {
    try {
      const data = JSON.parse(readFileSync(fp, 'utf-8')) as Record<string, GroupAutoTitleEntry>;
      const cutoff = Date.now() - ENTRY_TTL_MS;
      for (const [chatId, v] of Object.entries(data)) {
        if (v && typeof v.placeholderName === 'string' && typeof v.createdAt === 'number' && v.createdAt > cutoff) {
          entries.set(chatId, v);
        }
      }
    } catch (err) {
      logger.error(`[group-auto-title] failed to load ${fp}: ${err}`);
    }
  }
  registries.set(larkAppId, entries);
  return entries;
}

function persist(larkAppId: string): void {
  const fp = filePath(larkAppId);
  try {
    mkdirSync(dirname(fp), { recursive: true });
    atomicWriteFileSync(fp, `${JSON.stringify(Object.fromEntries(load(larkAppId)), null, 2)}\n`, { mode: 0o600 });
  } catch (err) {
    logger.error(`[group-auto-title] failed to persist ${fp}: ${err}`);
  }
}

function drop(larkAppId: string, chatId: string): void {
  if (load(larkAppId).delete(chatId)) persist(larkAppId);
}

function markFailed(larkAppId: string, chatId: string, failedAt = Date.now()): void {
  const entry = load(larkAppId).get(chatId);
  if (!entry) return;
  const attempts = (entry.titleAttempts ?? 0) + 1;
  if (attempts >= MAX_SESSION_GROUP_TITLE_ROUNDS) {
    logger.info(`[group-auto-title] giving up on chat=${chatId.substring(0, 12)} after ${attempts} rounds; placeholder kept`);
    drop(larkAppId, chatId);
    return;
  }
  entry.titleAttempts = attempts;
  // Same spacing as session groups: 30s, then 2m.
  entry.titleRetryAt = failedAt + (attempts === 1 ? 30_000 : 120_000);
  persist(larkAppId);
}

/**
 * Remember that `chatId` (just created by this bot via /g) awaits an AI title.
 * Registration happens right after chat.create, while invites and the initial
 * avatar may still be running; `decorationsSettled` lets a fast title wait for
 * them so the placeholder name avatar can never be applied after the final one.
 */
export function registerGroupAutoTitle(
  larkAppId: string,
  chatId: string,
  entry: Omit<GroupAutoTitleEntry, 'createdAt' | 'titleAttempts' | 'titleRetryAt'>,
  decorationsSettled?: Promise<unknown>,
): void {
  load(larkAppId).set(chatId, { ...entry, createdAt: Date.now() });
  persist(larkAppId);
  if (decorationsSettled) {
    const key = `${larkAppId}:${chatId}`;
    const release = () => { if (decorationGates.get(key) === decorationsSettled) decorationGates.delete(key); };
    decorationGates.set(key, decorationsSettled);
    decorationsSettled.then(release, release);
  }
}

export function hasPendingGroupAutoTitle(larkAppId: string, chatId: string): boolean {
  return load(larkAppId).has(chatId);
}

/**
 * Fire-and-forget: title a pending /g chat from `userText` and rename it.
 * Callers gate the seed (no commands / placeholder-only text); this gates the
 * registry, in-flight dedupe and backoff. Every failure keeps the placeholder.
 */
export function scheduleGroupAutoTitle(opts: { larkAppId: string; chatId: string; userText: string }): void {
  const { larkAppId, chatId, userText } = opts;
  const key = `${larkAppId}:${chatId}`;
  if (inFlight.has(key) || !userText.trim()) return;
  const entry = load(larkAppId).get(chatId);
  if (!entry || (entry.titleRetryAt ?? 0) > Date.now()) return;
  inFlight.add(key);
  void (async () => {
    let failed = true;
    try {
      // Re-checked per round: the bot may have been sandboxed (or switched to
      // a CLI without a one-shot mode) since the group was created.
      if (!oneShotTitleAllowed(getBot(larkAppId).config)) {
        logger.info(`[group-auto-title] one-shot title not allowed for chat=${chatId.substring(0, 12)} now; placeholder kept`);
        failed = false;
        drop(larkAppId, chatId);
        return;
      }
      const title = await generateOneShotTitle({
        larkAppId, chatId, userText, maxLen: DEFAULT_TITLE_MAX_LEN, logTag: 'group-auto-title',
      });
      if (!title) return;

      const finalName = formatSlashGroupName(title, entry.namePrefix);
      // Lazy: worker-pool sits on the daemon's import graph; this service is
      // also imported by command-handler, so keep the edge out of load order.
      const { getActiveSessionsRegistry } = await import('../core/worker-pool.js');
      // Compare-and-set against the fresh read inside renameChat: a member's
      // manual name wins, and a failed read defers instead of overwriting.
      // The shared queue keeps that read → write from interleaving with an
      // explicit rename (session skill / host API) of the same chat.
      const response = await chatRenameSerialQueue.run(key, () => executeChatRename({
        larkAppId, chatId, name: finalName, trigger: 'auto_title', expectedOldName: entry.placeholderName,
      }, {
        renameChat,
        activeSessions: () => getActiveSessionsRegistry()?.values() ?? [],
        persistSession: sessionStore.updateSession,
        logger,
      }));
      if (!response.body.ok) {
        // executeChatRename already audited the failure. A member's manual
        // name and a role error will not heal on the next message — stop
        // retrying. Everything else is a bounded transient round, including
        // `bot_not_in_chat`: isInChat() reports false on rate limits and
        // network errors too, so it does not prove the bot actually left.
        const { error } = response.body;
        if (error === 'name_changed' || error === 'permission_denied') {
          if (error === 'name_changed') {
            logger.info(`[group-auto-title] chat=${chatId.substring(0, 12)} already renamed to "${response.body.oldName ?? ''}"; keeping it`);
          }
          failed = false;
          drop(larkAppId, chatId);
        }
        return;
      }
      failed = false;
      drop(larkAppId, chatId);

      if (entry.nameAvatar) {
        await decorationGates.get(key)?.catch(() => undefined);
        // An explicit rename may have landed while the creation-time avatar
        // settled: re-read under the shared queue and paint the name the chat
        // actually has, never a stale AI title. Unreadable → leave it.
        await chatRenameSerialQueue.run(key, async () => {
          const liveName = await getChatName(larkAppId, chatId);
          if (!liveName) {
            logger.info(`[group-auto-title] name avatar skipped for chat=${chatId.substring(0, 12)}: live name unreadable`);
            return;
          }
          try {
            const { applyGroupNameAvatar } = await import('./group-name-avatar.js');
            await applyGroupNameAvatar(larkAppId, chatId, liveName);
          } catch (err) {
            logger.warn(`[group-auto-title] name avatar refresh failed for chat=${chatId.substring(0, 12)}: ${err}`);
          }
        });
      }
      logger.info(`[group-auto-title] titled chat=${chatId.substring(0, 12)} "${finalName}"`);
    } catch (err) {
      logger.info(`[group-auto-title] AI title failed for chat=${chatId.substring(0, 12)} (placeholder kept): ${err}`);
    } finally {
      if (failed) markFailed(larkAppId, chatId);
      inFlight.delete(key);
    }
  })();
}
