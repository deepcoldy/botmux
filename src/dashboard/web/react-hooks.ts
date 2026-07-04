import { useRef, useSyncExternalStore } from 'react';
import { store, type StoreSnapshot } from './store.js';
import { t, ui } from './ui.js';
import type { DashboardLocale } from './i18n.js';

function subscribeStore(listener: () => void): () => void {
  return store.on(listener);
}

function storeSnapshot(): StoreSnapshot {
  return store.getSnapshot();
}

export function useDashboardStore(): StoreSnapshot {
  return useSyncExternalStore(subscribeStore, storeSnapshot, storeSnapshot);
}

// Derive React state from the external store while keeping getSnapshot cached
// for each store version. Keep selectors dependent only on the store snapshot;
// combine component-local state with the selected value in useMemo.
export function useStoreSelector<T>(selector: (snapshot: StoreSnapshot) => T): T {
  const selectorRef = useRef(selector);
  const cacheRef = useRef<{ version: number; value: T } | null>(null);
  selectorRef.current = selector;
  const getSelectedSnapshot = (): T => {
    const snapshot = store.getSnapshot();
    if (cacheRef.current && cacheRef.current.version === snapshot.version) return cacheRef.current.value;
    const value = selectorRef.current(snapshot);
    cacheRef.current = { version: snapshot.version, value };
    return value;
  };
  return useSyncExternalStore(subscribeStore, getSelectedSnapshot, getSelectedSnapshot);
}

function subscribeUi(listener: () => void): () => void {
  return ui.on(listener);
}

function localeSnapshot(): DashboardLocale {
  return ui.locale;
}

export function useDashboardLocale(): DashboardLocale {
  return useSyncExternalStore(subscribeUi, localeSnapshot, localeSnapshot);
}

export function useT(): typeof t {
  useDashboardLocale();
  return t;
}
