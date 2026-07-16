import { createCliAdapterSync } from '../adapters/cli/registry.js';
import type { CliId } from '../adapters/cli/types.js';
import type { DaemonToWorker } from '../types.js';
import type { DaemonSession } from './types.js';

export type AgentSessionRenameRequest =
  | { status: 'requested'; cliId: CliId }
  | { status: 'not_running'; cliId?: CliId }
  | { status: 'unsupported'; cliId?: CliId }
  | { status: 'failed'; cliId?: CliId; error: string };

/** Resolve the CLI actually owned/observed by this worker. initConfig is the
 *  live source of truth; adopted metadata and the persisted session are only
 *  fallbacks for older or workerless sessions. */
export function effectiveSessionCliId(ds: DaemonSession): CliId | undefined {
  return (
    ds.initConfig?.cliId
    ?? ds.adoptedFrom?.cliId
    ?? ds.session.adoptedFrom?.cliId
    ?? ds.session.cliId
  ) as CliId | undefined;
}

/** Best-effort request to keep the CLI-native resume-picker name aligned with
 *  Botmux's canonical session.title. Local persistence happens before this
 *  call, so a missing/unsupported worker never makes the visible rename fail. */
export function requestAgentSessionRename(
  ds: DaemonSession,
  title: string,
): AgentSessionRenameRequest {
  const cliId = effectiveSessionCliId(ds);
  const worker = ds.worker;
  if (!worker || worker.killed || worker.connected === false) {
    return { status: 'not_running', ...(cliId ? { cliId } : {}) };
  }

  // Riff's write() creates a remote task per call; a TUI command split into
  // text + Enter would create two unrelated tasks. It has no local TUI anyway.
  if ((ds.initConfig?.backendType ?? ds.session.backendType) === 'riff') {
    return { status: 'unsupported', ...(cliId ? { cliId } : {}) };
  }

  if (!cliId) return { status: 'unsupported' };
  try {
    const adapter = createCliAdapterSync(
      cliId,
      ds.initConfig?.cliPathOverride ?? ds.session.cliPathOverride,
    );
    if (!adapter.buildSessionRenameCommand) {
      return { status: 'unsupported', cliId };
    }
    worker.send({ type: 'rename_session', title } as DaemonToWorker);
    return { status: 'requested', cliId };
  } catch (err) {
    return {
      status: 'failed',
      cliId,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
