import type { Session } from '../types.js';
import type { searchTopics, TopicSearchOptions } from '../services/topic-search/query.js';
import type { SessionBoardAudience } from './public-redact.js';

const SNAPSHOT_MAX_AGE_MS = 5_000;
const WARN_INTERVAL_MS = 10 * 60_000;
const READ_BUSY_TIMEOUT_MS = 250;

export interface ContentMatch {
  sessionId: string;
  snippet: string;
  time: number | null;
}
export interface ContentSearchResult<T> {
  sessions: T[];
  contentMatches: ContentMatch[];
  contentSearch: 'ok' | 'not_allowed' | 'too_short' | 'unavailable';
}
interface ContentSearchDependencies {
  search(request: Parameters<typeof searchTopics>[1], options: TopicSearchOptions): ReturnType<typeof searchTopics>;
  readSessions(): readonly Session[];
  now(): number;
  warn(reason: string): void;
}

/** All I/O is supplied by the caller; one Dashboard instance owns this cache. */
export function createSessionContentSearch(deps: ContentSearchDependencies) {
  let snapshot: { sessions: readonly Session[]; at: number } | undefined;
  const warned = new Map<string, number>();
  return function searchSessionContent<T extends { sessionId: string }>(
    query: string, audience: SessionBoardAudience, rows: readonly T[],
  ): ContentSearchResult<T> {
    const empty = (contentSearch: ContentSearchResult<T>['contentSearch']): ContentSearchResult<T> => ({
      sessions: [], contentMatches: [], contentSearch,
    });
    if (audience === 'anonymous') return empty('not_allowed');
    if (Array.from(query.replace(/\s/g, '')).length < 2) return empty('too_short');
    try {
      const now = deps.now();
      if (!snapshot || now - snapshot.at >= SNAPSHOT_MAX_AGE_MS) {
        snapshot = { sessions: deps.readSessions(), at: now };
      }
      const result = deps.search({ query, limit: 20, hits: 1 }, {
        sessions: snapshot.sessions, busyTimeoutMs: READ_BUSY_TIMEOUT_MS,
      });
      const byId = new Map(rows.map(row => [row.sessionId, row]));
      const sessions: T[] = [];
      const contentMatches: ContentMatch[] = [];
      const seen = new Set<string>();
      for (const topic of result.results) {
        const hit = topic.hits.items[0];
        if (!hit) continue;
        for (const session of topic.sessions) {
          const row = byId.get(session.sessionId);
          if (!row || seen.has(row.sessionId)) continue;
          seen.add(row.sessionId);
          sessions.push(row);
          contentMatches.push({ sessionId: row.sessionId, snippet: hit.snippet, time: hit.time });
        }
      }
      return { sessions, contentMatches, contentSearch: 'ok' };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const now = deps.now();
      const last = warned.get(reason);
      if (last === undefined || now - last >= WARN_INTERVAL_MS) {
        warned.set(reason, now);
        deps.warn(reason);
      }
      return empty('unavailable');
    }
  };
}
