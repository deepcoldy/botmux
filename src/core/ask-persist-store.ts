/**
 * ask-persist-store — file-backed pending `botmux ask` state (injectable).
 *
 * Why this exists: the ask broker's pending registry is an in-memory Map, so a
 * daemon restart between "card posted" and "user clicked" loses the ask. The
 * user's later click then hits `stale` ("此 ask 已失效"), and the CLI hook that
 * was blocking on `/api/asks` has meanwhile dropped its connection and fallen
 * back to passthrough → the CLI renders its native picker with no way to deliver
 * the answer. (See the AskUserQuestion picker-desync investigation.)
 *
 * This module owns the durable projection of each pending ask under
 * `<storeDir>/<askKey>.json`. The broker persists on create, updates on card /
 * selection / terminal-answer change, and removes once the answer is CLAIMED by
 * the reconnecting hook. On boot the broker re-hydrates them as "dormant" asks
 * (card still live in Feishu, no waiter yet).
 *
 * DEPENDENCY INJECTION (codex P1-4): the store is created with an explicit
 * directory rather than reading `config.session.dataDir` at call time. Tests
 * inject a temp dir and delete only their own sentinel-guarded directory; the
 * broker never bulk-cleans a shared/global dataDir (a test helper doing that
 * could delete a LIVE pending ask). Production wires the real dir once at
 * daemon bootstrap.
 *
 * Design mirrors `workflows/v3/gate-wait-store.ts` (also "survive restart"):
 * atomic writes, fsync durability, a `list()` restore scan.
 *
 * IDENTITY (codex影响面纠正): `askKey` is supplied by the caller and is derived
 * from a per-invocation `requestId` (generated once by the hook, reused across
 * retries) + an `originKind` (hook-ask vs explicit `botmux ask buttons`). This
 * is a true invocation identity — unlike a questions hash it distinguishes two
 * concurrent same-question asks and two same-question invocations 24h apart, and
 * prevents an explicit ask from re-claiming a hook ask's card.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { logger } from '../utils/logger.js';
import type { AskQuestion, AskResult } from './ask-types.js';

/** Sentinel file marking a directory as a botmux ask store. teardown/reset only
 *  ever touches a directory that contains this file — a guard against a missing
 *  temp override accidentally reaping a real data dir. */
export const ASK_STORE_SENTINEL = '.botmux-ask-store';

/** Persisted shape — everything needed to re-hydrate a dormant ask, re-render or
 *  re-send its card, and hand off an answer that arrived before the hook
 *  reconnected. Excludes runtime-only fields (resolve fn, timers). */
export interface PersistedAsk {
  /** Schema version so a future field change can migrate/skip cleanly. */
  v: 2;
  /** Stable cross-restart identity = `${originKind}.${requestId}` (see module doc). */
  askKey: string;
  /** Per-invocation id the hook generates once and reuses across retries. */
  requestId: string;
  /** Distinguishes a hook AskUserQuestion from an explicit `botmux ask buttons`
   *  so they can never re-claim each other's card. */
  originKind: string;
  /** Random per-process askId assigned at first register; kept stable across
   *  restore/re-attach for logging + card action values. */
  askId: string;
  nonce: string;
  larkAppId: string;
  chatId: string;
  rootMessageId: string | null;
  sessionId: string;
  chatType?: 'group' | 'p2p';
  questions: ReadonlyArray<AskQuestion>;
  createdAt: number;
  deadlineAt: number;
  /** Feishu message id of the posted card, once dispatch landed. Undefined means
   *  the card has NOT been confirmed sent — restore/re-attach must (idempotently,
   *  keyed by requestId) send it so the user always has exactly one live card. */
  cardMessageId?: string;
  /** Accumulated per-question selections (checkbox state), so a restart mid-
   *  multi-select keeps the boxes the user already ticked. */
  selections: ReadonlyArray<ReadonlyArray<string>>;
  /** Durable handoff (codex P1-1): a terminal answer that arrived while the ask
   *  was dormant (user clicked before the hook reconnected). The record is NOT
   *  deleted on settle in that case — it is retained here until the reconnecting
   *  hook CLAIMS it, then removed. Absent while still awaiting a click. */
  answeredResult?: AskResult;
  /** epoch ms the answer was stashed. Bounds handoff retention so an answer that
   *  is never claimed (e.g. the CLI is gone for good) is eventually reaped
   *  instead of accumulating forever (codex P1-4). */
  answeredAt?: number;
}

/** How long an unclaimed answered-handoff record is kept before `list()` reaps
 *  it. Generous (a reconnecting hook claims within seconds of a restart) but
 *  bounded so a dead CLI's stash can't live forever. */
export const HANDOFF_RETENTION_MS = 24 * 60 * 60 * 1000; // 24h

/**
 * Build the stable identity key. Scoped to `larkAppId + sessionId + originKind +
 * requestId` so the key is NOT a bearer secret: a different bot/session reusing
 * the same requestId lands on a DIFFERENT key and can never reclaim another
 * session's ask (codex P1-3). The reattach path additionally verifies the full
 * immutable identity (chat/root/questions) before delivering.
 *
 * Canonical + INJECTIVE (codex P1-1): each segment is length-prefixed
 * (`<len>:<raw>`) and joined with `|`. Length-prefixing means no separator can
 * be forged from segment content and no two distinct tuples can alias — unlike
 * the previous delimiter-join-then-truncate, which collapsed production-length
 * keys (a 36-char app id + uuid session pushed the requestId past the 80-char
 * cut, so two different requestIds sharing an 80-char prefix produced ONE key).
 * The full string is retained (never truncated); the filesystem-length problem
 * is solved separately by hashing for the filename, not by cutting the key.
 */
export function askKeyFor(
  larkAppId: string,
  sessionId: string,
  originKind: string,
  requestId: string,
): string {
  return [larkAppId, sessionId, originKind, requestId]
    .map((seg) => {
      const raw = String(seg);
      return `${raw.length}:${raw}`;
    })
    .join('|');
}

/** Feishu IM `uuid` dedupe token (≤50 chars) derived from the FULL scoped ask
 *  key — NOT the bare requestId (codex P1-1). Deriving from the scoped key means
 *  a re-send within the same invocation dedupes server-side (same key → same
 *  uuid → Feishu returns the original message_id), while a different session
 *  reusing the same requestId gets a DIFFERENT uuid and so cannot alias the
 *  first session's card. `ask-` + 40 hex = 44 chars, safely under the cap. */
export function dispatchUuidForKey(askKey: string): string {
  return `ask-${createHash('sha256').update(`uuid|${askKey}`).digest('hex').slice(0, 40)}`;
}

export interface AskPersistStore {
  /** Absolute directory this store owns. */
  readonly dir: string;
  /** Create-or-update a record. Best-effort durable (atomic rename + fsync). */
  put(ask: PersistedAsk): void;
  /** Remove a record by key. Idempotent (missing file is not an error). */
  remove(askKey: string): void;
  /** Load all valid, unexpired records (reaps corrupt / wrong-version / expired). */
  list(now?: number): PersistedAsk[];
}

/**
 * Create a store bound to an explicit directory. The directory is created (with
 * a sentinel) lazily on first write. Nothing here reads global config — the
 * caller decides the path, which is what makes the broker testable without
 * touching live data.
 */
export function createAskPersistStore(dir: string): AskPersistStore {
  // Filename = SHA-256 of the FULL canonical key (codex P1-1). Hashing (not
  // truncating) means two production-length keys that share a long prefix but
  // differ in the requestId tail land on DISTINCT files — the previous
  // `sanitize(key).slice(0,80)` collapsed them because a 36-char app id + uuid
  // session pushed the requestId past char 80. Fixed-length hex is also always a
  // valid path component, so no separate sanitize step is needed.
  const filePath = (askKey: string): string =>
    join(dir, `${createHash('sha256').update(askKey).digest('hex')}.json`);

  function ensureDir(): void {
    mkdirSync(dir, { recursive: true });
    const sentinel = join(dir, ASK_STORE_SENTINEL);
    if (!existsSync(sentinel)) {
      try { writeFileSync(sentinel, 'botmux ask persist store\n', { mode: 0o600 }); } catch { /* best effort */ }
    }
  }

  return {
    dir,
    put(ask: PersistedAsk): void {
      try {
        ensureDir();
        atomicWriteFileSync(filePath(ask.askKey), JSON.stringify(ask), { mode: 0o600, durable: true });
      } catch (e) {
        // Persistence is a resilience enhancement, never a correctness gate for
        // the live path: a failed write just means this ask won't survive a
        // restart.
        logger.warn?.(
          `ask-persist: failed to persist ${ask.askKey}: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    },
    remove(askKey: string): void {
      try {
        unlinkSync(filePath(askKey));
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') return;
        logger.warn?.(
          `ask-persist: failed to remove ${askKey}: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    },
    list(now: number = Date.now()): PersistedAsk[] {
      if (!existsSync(dir)) return [];
      let names: string[];
      try {
        names = readdirSync(dir).filter((n) => n.endsWith('.json'));
      } catch (e) {
        logger.warn?.(`ask-persist: cannot read ${dir}: ${e instanceof Error ? e.message : String(e)}`);
        return [];
      }
      const out: PersistedAsk[] = [];
      for (const name of names) {
        const fp = join(dir, name);
        let parsed: PersistedAsk | undefined;
        try {
          parsed = JSON.parse(readFileSync(fp, 'utf-8')) as PersistedAsk;
        } catch {
          try { unlinkSync(fp); } catch { /* ignore */ }
          continue;
        }
        if (!parsed || parsed.v !== 2 || !parsed.askKey || !parsed.requestId || !Array.isArray(parsed.questions)) {
          try { unlinkSync(fp); } catch { /* ignore */ }
          continue;
        }
        // Reap rules:
        //  - answered-handoff records are kept until CLAIMED, but bounded by
        //    HANDOFF_RETENTION_MS from answeredAt so an unclaimed stash (dead
        //    CLI) can't accumulate forever (codex P1-4).
        //  - never-answered records are dropped once past their deadline.
        if (parsed.answeredResult !== undefined) {
          const stashedAt = typeof parsed.answeredAt === 'number' ? parsed.answeredAt : parsed.createdAt;
          if (now - stashedAt > HANDOFF_RETENTION_MS) {
            try { unlinkSync(fp); } catch { /* ignore */ }
            continue;
          }
        } else if (typeof parsed.deadlineAt === 'number' && parsed.deadlineAt <= now) {
          try { unlinkSync(fp); } catch { /* ignore */ }
          continue;
        }
        out.push(parsed);
      }
      return out;
    },
  };
}
