export interface RiffWorkerShutdownInputSnapshot {
  /** False while async init can still materialize an opening prompt later. */
  initPromptMaterialized: boolean;
  /** A normal prompt has been removed from pendingMessages but has not yet
   * crossed the adapter/backend write boundary. */
  isFlushing: boolean;
  pendingMessages: number;
  pendingRawInputs: number;
  pendingSessionRename: boolean;
  sessionRenameInFlight: boolean;
  /** Raw command text -> Enter sequences that can still append a backend
   * write after the shutdown fence is sampled. */
  commandLineWritesPending: number;
}

/** Describe worker-owned input not proven to be inside RiffBackend.writeChain. */
export function riffWorkerShutdownInputBlocker(
  snapshot: RiffWorkerShutdownInputSnapshot,
): string | null {
  const parts: string[] = [];
  if (!snapshot.initPromptMaterialized) parts.push('init=materializing');
  if (snapshot.isFlushing) parts.push('flushing=1');
  if (snapshot.pendingMessages > 0) parts.push(`messages=${snapshot.pendingMessages}`);
  if (snapshot.pendingRawInputs > 0) parts.push(`raw=${snapshot.pendingRawInputs}`);
  if (snapshot.pendingSessionRename) parts.push('rename=1');
  if (snapshot.sessionRenameInFlight) parts.push('rename_inflight=1');
  if (snapshot.commandLineWritesPending > 0) {
    parts.push(`command_writes=${snapshot.commandLineWritesPending}`);
  }
  return parts.length > 0 ? parts.join(',') : null;
}
