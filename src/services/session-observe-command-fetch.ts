import {
  fetchObserveSessionImplementation,
  fetchObserveSnapshotImplementation,
  type ObserveFetchDependencies,
  type ObserveFetchQuery,
} from './session-observe-fetch-implementation.js';
import type { ObserveSession, ObserveSnapshot } from './session-observe.js';

export type DaemonIpcFetch = (
  port: number,
  path: string,
  init?: RequestInit,
  secret?: string,
) => Promise<Response>;

export type ObserveCommandFetchOptions = ObserveFetchQuery & ObserveFetchDependencies;

export function fetchObserveSnapshot(
  options: ObserveCommandFetchOptions = {},
): Promise<ObserveSnapshot> {
  const { larkAppId, includeRaw, ...dependencies } = options;
  return fetchObserveSnapshotImplementation({ larkAppId, includeRaw }, dependencies);
}

export function fetchObserveSession(
  sessionId: string,
  options: ObserveCommandFetchOptions = {},
): Promise<ObserveSession> {
  const { larkAppId, includeRaw, ...dependencies } = options;
  return fetchObserveSessionImplementation(sessionId, { larkAppId, includeRaw }, dependencies);
}
