import type { ObserveFetchOptions } from './session-observe-fetch.js';
import {
  fetchObserveSessionImplementation,
  fetchObserveSnapshotImplementation,
  type ObserveFetchDependencies,
} from './session-observe-fetch-implementation.js';
import type { ObserveSession, ObserveSnapshot } from './session-observe.js';

export type DaemonIpcFetch = (
  port: number,
  path: string,
  init?: RequestInit,
  secret?: string,
) => Promise<Response>;

export type InternalObserveFetchOptions = ObserveFetchOptions & ObserveFetchDependencies;

export function fetchObserveSnapshot(
  options: InternalObserveFetchOptions = {},
): Promise<ObserveSnapshot> {
  const { larkAppId, includeRaw, ...dependencies } = options;
  return fetchObserveSnapshotImplementation({ larkAppId, includeRaw }, dependencies);
}

export function fetchObserveSession(
  sessionId: string,
  options: InternalObserveFetchOptions = {},
): Promise<ObserveSession> {
  const { larkAppId, includeRaw, ...dependencies } = options;
  return fetchObserveSessionImplementation(sessionId, { larkAppId, includeRaw }, dependencies);
}
