import type { OnlineDaemonInfo } from '../utils/daemon-discovery.js';
import {
  fetchObserveSession as fetchObserveSessionPublic,
  fetchObserveSnapshot as fetchObserveSnapshotPublic,
  type ObserveFetchOptions,
} from './session-observe-fetch.js';
import type { ObserveSession, ObserveSnapshot } from './session-observe.js';

export type DaemonIpcFetch = (
  port: number,
  path: string,
  init?: RequestInit,
  secret?: string,
) => Promise<Response>;

interface ObserveFetchDependencies {
  now?: () => number;
  secret?: string;
  dataDir?: string;
  fetch?: DaemonIpcFetch;
  discover?: (dataDir?: string) => OnlineDaemonInfo[];
  timeoutMs?: number;
}

export type InternalObserveFetchOptions = ObserveFetchOptions & ObserveFetchDependencies;

export function fetchObserveSnapshot(
  options: InternalObserveFetchOptions = {},
): Promise<ObserveSnapshot> {
  const { larkAppId, sessionId, includeRaw, ...dependencies } = options;
  const implementation = fetchObserveSnapshotPublic as unknown as (
    options: ObserveFetchOptions,
    dependencies: ObserveFetchDependencies,
  ) => Promise<ObserveSnapshot>;
  return implementation({ larkAppId, sessionId, includeRaw }, dependencies);
}

export function fetchObserveSession(
  sessionId: string,
  options: InternalObserveFetchOptions = {},
): Promise<ObserveSession> {
  const { larkAppId, sessionId: _sessionId, includeRaw, ...dependencies } = options;
  const implementation = fetchObserveSessionPublic as unknown as (
    sessionId: string,
    options: ObserveFetchOptions,
    dependencies: ObserveFetchDependencies,
  ) => Promise<ObserveSession>;
  return implementation(sessionId, { larkAppId, includeRaw }, dependencies);
}
