export const MONITOR_ROOM_STORAGE_KEY = 'botmux.dashboard.monitorRoom.sessions.v1';

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function defaultStorage(): StorageLike | null {
  return typeof window === 'undefined' ? null : window.localStorage;
}

function normalizeSessionId(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function readMonitorRoomSessionIds(storage: StorageLike | null = defaultStorage()): string[] {
  if (!storage) return [];
  try {
    const raw = storage.getItem(MONITOR_ROOM_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    const ids = Array.isArray(parsed) ? parsed.map(normalizeSessionId).filter(Boolean) : [];
    return [...new Set(ids)];
  } catch {
    return [];
  }
}

export function writeMonitorRoomSessionIds(ids: string[], storage: StorageLike | null = defaultStorage()): string[] {
  const next = [...new Set(ids.map(normalizeSessionId).filter(Boolean))];
  if (!storage) return next;
  try {
    if (next.length) storage.setItem(MONITOR_ROOM_STORAGE_KEY, JSON.stringify(next));
    else storage.removeItem(MONITOR_ROOM_STORAGE_KEY);
  } catch {
    // Keep the in-memory result useful even when localStorage is unavailable.
  }
  return next;
}

export function addMonitorRoomSessionIds(ids: string[], storage: StorageLike | null = defaultStorage()): { ids: string[]; added: number; total: number } {
  const before = readMonitorRoomSessionIds(storage);
  const beforeSet = new Set(before);
  const next = writeMonitorRoomSessionIds([...before, ...ids], storage);
  const added = next.filter(id => !beforeSet.has(id)).length;
  return { ids: next, added, total: next.length };
}

export function removeMonitorRoomSessionId(id: string, storage: StorageLike | null = defaultStorage()): string[] {
  const target = normalizeSessionId(id);
  return writeMonitorRoomSessionIds(readMonitorRoomSessionIds(storage).filter(x => x !== target), storage);
}

export function clearMonitorRoomSessionIds(storage: StorageLike | null = defaultStorage()): void {
  writeMonitorRoomSessionIds([], storage);
}

export function monitorRoomUrl(loc: Location = window.location): string {
  const url = new URL(loc.href);
  url.hash = '#/monitor-room';
  return url.toString();
}
