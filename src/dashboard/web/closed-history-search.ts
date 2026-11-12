// Keyword search over closed sessions the bounded first snapshot did not include.
import { useEffect } from 'react';
import { store } from './store.js';

/** Wait for a pause in typing before asking the server; one request per settled query. */
export const CLOSED_HISTORY_SEARCH_DEBOUNCE_MS = 250;

/**
 * ⌘K and the Workbench rail match against the shared store, which only holds the
 * newest closed sessions (`/api/sessions?view=board`). While a query is typed, ask
 * the server for older closed sessions matching it and merge them into the store,
 * where the caller's own matcher ranks them like any other row.
 *
 * Best effort on purpose: a failed lookup leaves the already-loaded results on
 * screen, and a toast per keystroke would be noise. Pass '' to disable.
 */
export function useClosedHistorySearch(query: string): void {
  useEffect(() => {
    if (!query.trim()) return undefined;
    const timer = setTimeout(() => {
      store.searchClosedSessions(query).catch(() => undefined);
    }, CLOSED_HISTORY_SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query]);
}
