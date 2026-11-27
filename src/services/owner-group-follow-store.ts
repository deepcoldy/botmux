import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { withFileLockSync } from '../utils/file-lock.js';

const MISSING_SCANS_TO_FORGET = 2;

export interface FollowEntry {
  status: 'pending' | 'inviting' | 'joined' | 'approval' | 'failed' | 'removed';
  attempts: number;
  retryAt?: number;
  attemptId?: string;
  startedAt?: number;
  /** Scan-inferred removals can be corrected by later membership evidence. */
  removalSource?: 'snapshot';
}
export interface OwnerGroupFollowState {
  version: 1;
  scope: string;
  active: boolean;
  epoch: string;
  revision: number;
  initialized: boolean;
  knownChatIds: string[];
  /** Consecutive complete snapshots missing a baseline chat; absent in older v1 journals. */
  missingChatScans?: Record<string, number>;
  /** Consecutive membership snapshots missing a joined bot; absent in older v1 journals. */
  missingBotChatScans?: Record<string, number>;
  entries: Record<string, FollowEntry>;
  authNoticeAt?: number;
}

/** One journal per bot; no credentials or message contents are persisted. */
export class OwnerGroupFollowStore {
  readonly path: string;
  constructor(dataDir: string, appId: string) {
    const key = createHash('sha256').update(appId).digest('hex');
    this.path = join(dataDir, 'owner-group-follow', `${key}.json`);
  }
  read(): OwnerGroupFollowState | undefined {
    if (!existsSync(this.path)) return undefined;
    const state = JSON.parse(readFileSync(this.path, 'utf8')) as OwnerGroupFollowState;
    // Older journals can safely start at zero; subsequent writes advance it.
    state.revision ??= 0;
    if (state.version !== 1 || typeof state.scope !== 'string' || typeof state.epoch !== 'string'
        || typeof state.active !== 'boolean' || typeof state.initialized !== 'boolean'
        || !Number.isSafeInteger(state.revision) || state.revision < 0
        || !Array.isArray(state.knownChatIds) || state.knownChatIds.some(id => !validChatId(id))
        || !validMissingScans(state.missingChatScans) || !validMissingScans(state.missingBotChatScans)
        || !state.entries || typeof state.entries !== 'object' || Array.isArray(state.entries)
        || Object.entries(state.entries).some(([id, entry]) => !validChatId(id) || !entry
          || !['pending', 'inviting', 'joined', 'approval', 'failed', 'removed'].includes(entry.status)
          || (entry.removalSource !== undefined && (entry.status !== 'removed' || entry.removalSource !== 'snapshot'))
          || !Number.isInteger(entry.attempts) || entry.attempts < 0)) {
      throw new Error('invalid owner group follow journal');
    }
    return state;
  }
  private write(state: OwnerGroupFollowState): void {
    state.revision++;
    atomicWriteFileSync(this.path, JSON.stringify(state), { mode: 0o600, durable: true, followTargetSymlink: false });
  }
  private locked<T>(operation: () => T): T {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    return withFileLockSync(this.path, operation);
  }
  /** Invalidating an epoch fences responses from a previous configuration. */
  configure(scope: string, enabled: boolean, invalidate = false): OwnerGroupFollowState | undefined {
    if (!enabled && !existsSync(this.path)) return undefined;
    return this.locked(() => {
      const previous = this.read();
      const sameOwner = previous?.scope === scope;
      if (sameOwner && previous.active === enabled && !invalidate) return previous;
      const keepBaseline = sameOwner && previous.active && enabled;
      const state: OwnerGroupFollowState = {
        version: 1, scope, active: enabled, epoch: randomUUID(), revision: previous?.revision ?? 0,
        initialized: keepBaseline ? previous.initialized : false,
        knownChatIds: keepBaseline ? previous.knownChatIds : [],
        ...(keepBaseline && previous.missingChatScans ? { missingChatScans: previous.missingChatScans } : {}),
        ...(keepBaseline && previous.missingBotChatScans ? { missingBotChatScans: previous.missingBotChatScans } : {}),
        entries: sameOwner ? Object.fromEntries(Object.entries(previous.entries)
          .filter(([, entry]) => keepBaseline || entry.status === 'removed' || entry.status === 'joined')) : {},
        ...(keepBaseline && previous.authNoticeAt !== undefined ? { authNoticeAt: previous.authNoticeAt } : {}),
      };
      this.write(state);
      return state;
    });
  }
  update(epoch: string, mutate: (state: OwnerGroupFollowState) => void | false): boolean {
    return this.locked(() => {
      const state = this.read();
      if (!state?.active || state.epoch !== epoch) return false;
      if (mutate(state) === false) return false;
      this.write(state);
      return true;
    });
  }
  observe(epoch: string, chats: readonly string[], botChats: ReadonlySet<string>, ineligible: ReadonlySet<string>, snapshotRevision?: number): number | undefined {
    let revision: number | undefined;
    const updated = this.update(epoch, state => {
      // A second daemon can settle an invitation while these snapshots await.
      // Its newer state wins; an old absence must not manufacture a removal.
      if (snapshotRevision !== undefined && state.revision !== snapshotRevision) return false;
      const known = new Set(state.knownChatIds);
      const current = new Set(chats);
      const previousMissing = state.missingChatScans ?? {};
      const missing = new Map<string, number>();
      const botMissing = new Map(Object.entries(state.missingBotChatScans ?? {}));
      // Positive bot membership is authoritative even when the owner listing
      // omits the chat: it breaks consecutive absence and corrects only
      // scan-inferred removals, never event or legacy tombstones.
      for (const chatId of botChats) {
        botMissing.delete(chatId);
        const entry = state.entries[chatId];
        if (entry?.status === 'removed' && entry.removalSource === 'snapshot') {
          state.entries[chatId] = { status: 'joined', attempts: entry.attempts };
        }
      }
      const retainedMissing: string[] = [];
      for (const chatId of known) {
        if (current.has(chatId)) continue;
        const count = (previousMissing[chatId] ?? 0) + 1;
        if (count >= MISSING_SCANS_TO_FORGET) {
          botMissing.delete(chatId);
          continue;
        }
        missing.set(chatId, count);
        retainedMissing.push(chatId);
      }
      for (const chatId of chats) {
        const entry = state.entries[chatId];
        // Event removals and legacy removed entries are permanent tombstones.
        if (entry?.status === 'removed' && entry.removalSource !== 'snapshot') {
          botMissing.delete(chatId);
          continue;
        }
        if (botChats.has(chatId)) {
          botMissing.delete(chatId);
          state.entries[chatId] = { status: 'joined', attempts: entry?.attempts ?? 0 };
          continue;
        }
        if (entry?.status === 'joined') {
          const count = (botMissing.get(chatId) ?? 0) + 1;
          if (count >= MISSING_SCANS_TO_FORGET) {
            state.entries[chatId] = { ...entry, status: 'removed', removalSource: 'snapshot' };
            botMissing.delete(chatId);
          } else {
            botMissing.set(chatId, count);
          }
          continue;
        }
        botMissing.delete(chatId);
        if (ineligible.has(chatId)) {
          if (entry?.status === 'pending' || entry?.status === 'inviting') delete state.entries[chatId];
          continue;
        }
        if (state.initialized && !known.has(chatId) && !entry) {
          state.entries[chatId] = { status: 'pending', attempts: 0 };
        }
      }
      // Only a complete successful listing reaches this point, but even one
      // can transiently omit an existing chat. Forget it only after consecutive
      // snapshots confirm absence; intervening presence resets its count.
      state.knownChatIds = [...chats, ...retainedMissing];
      state.missingChatScans = Object.fromEntries(missing);
      state.missingBotChatScans = Object.fromEntries(botMissing);
      state.initialized = true;
      revision = state.revision + 1;
    });
    return updated ? revision : undefined;
  }
  claim(epoch: string, chatId: string, now: number, expectedRevision?: number): { attemptId: string; revision: number } | undefined {
    let result: { attemptId: string; revision: number } | undefined;
    const updated = this.update(epoch, state => {
      if (expectedRevision !== undefined && state.revision !== expectedRevision) return false;
      const entry = state.entries[chatId];
      if (!entry || entry.attempts >= 3) return false;
      const ready = entry.status === 'pending' && (entry.retryAt ?? 0) <= now;
      const stale = entry.status === 'inviting' && now - (entry.startedAt ?? now) >= 120_000;
      if (!ready && !stale) return false;
      const attemptId = randomUUID();
      state.entries[chatId] = { status: 'inviting', attempts: entry.attempts + 1, attemptId, startedAt: now };
      result = { attemptId, revision: state.revision + 1 };
    });
    return updated ? result : undefined;
  }
  finish(epoch: string, chatId: string, attemptId: string, result: 'joined' | 'approval' | 'failed' | 'retry' | 'authorization', now: number): number | undefined {
    let revision: number | undefined;
    const updated = this.update(epoch, state => {
      const entry = state.entries[chatId];
      // A removal event or config edit while the request was in flight wins.
      if (entry?.status !== 'inviting' || entry.attemptId !== attemptId) return false;
      state.entries[chatId] = {
        status: result === 'authorization' || result === 'retry' && entry.attempts < 3 ? 'pending' : result === 'joined' || result === 'approval' ? result : 'failed',
        attempts: result === 'authorization' ? entry.attempts - 1 : entry.attempts,
        ...(result === 'authorization' ? { retryAt: now + 300_000 } : {}),
        ...(result === 'retry' && entry.attempts < 3 ? { retryAt: now + 60_000 * 2 ** (entry.attempts - 1) } : {}),
      };
      revision = state.revision + 1;
    });
    return updated ? revision : undefined;
  }
  removed(chatId: string): void {
    if (!validChatId(chatId) || !existsSync(this.path)) return;
    this.locked(() => {
      const state = this.read();
      if (!state?.active) return;
      state.entries[chatId] = { status: 'removed', attempts: state.entries[chatId]?.attempts ?? 0 };
      delete state.missingBotChatScans?.[chatId];
      this.write(state);
    });
  }
}

function validMissingScans(value: unknown): boolean {
  return value === undefined || (value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.entries(value).every(([id, count]) => validChatId(id) && Number.isSafeInteger(count) && count >= 1));
}

function validChatId(id: unknown): id is string { return typeof id === 'string' && /^oc_[A-Za-z0-9_-]+$/.test(id); }
