import {
  defaultWorkbenchLayout,
  normalizeWorkbenchLayout,
  type WorkbenchLayoutState,
} from './agent-workbench-model.js';

export interface WorkbenchStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
}

const STORAGE_PREFIX = 'botmux.agent-workbench.layout.v1:';

export function workbenchLayoutStorageKey(sessionId: string): string {
  return `${STORAGE_PREFIX}${encodeURIComponent(sessionId)}`;
}

export function loadWorkbenchLayout(
  sessionId: string,
  storage: WorkbenchStorage | null | undefined,
): WorkbenchLayoutState {
  if (!storage) return defaultWorkbenchLayout();
  try {
    const raw = storage.getItem(workbenchLayoutStorageKey(sessionId));
    return raw ? normalizeWorkbenchLayout(JSON.parse(raw)) : defaultWorkbenchLayout();
  } catch {
    return defaultWorkbenchLayout();
  }
}

/** Persists layout primitives only. URLs, grants, cookies and frame state are never serialised. */
export function saveWorkbenchLayout(
  sessionId: string,
  layout: WorkbenchLayoutState,
  storage: WorkbenchStorage | null | undefined,
): boolean {
  if (!storage) return false;
  try {
    storage.setItem(workbenchLayoutStorageKey(sessionId), JSON.stringify(normalizeWorkbenchLayout(layout)));
    return true;
  } catch {
    return false;
  }
}
