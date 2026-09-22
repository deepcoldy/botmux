import {
  fetchObserveSessionImplementation,
  fetchObserveSnapshotImplementation,
} from './session-observe-fetch-implementation.js';
import type { ObserveSession, ObserveSnapshot } from './session-observe.js';

export interface ObserveFetchOptions {
  larkAppId?: string;
  includeRaw?: boolean;
}

export function fetchObserveSnapshot(
  options: ObserveFetchOptions = {},
): Promise<ObserveSnapshot> {
  return fetchObserveSnapshotImplementation(options);
}

export function fetchObserveSession(
  sessionId: string,
  options: ObserveFetchOptions = {},
): Promise<ObserveSession> {
  return fetchObserveSessionImplementation(sessionId, options);
}
