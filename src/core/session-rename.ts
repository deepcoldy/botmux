import { createCliAdapterSync } from '../adapters/cli/registry.js';
import type { CliId } from '../adapters/cli/types.js';
import type { DaemonToWorker } from '../types.js';
import type { DaemonSession } from './types.js';
import { isRemoteBackendId } from './remote-cli-ids.js';

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

export type AgentSessionAutoRename =
  | { status: 'available'; cliId: CliId; command: string }
  | { status: 'not_running'; cliId: CliId }
  | { status: 'unsupported'; cliId?: CliId }
  | { status: 'failed'; cliId: CliId; error: string };

/** The CLI-native command a bare `/rename` hands to the live CLI so it names
 *  the session itself. Capability is checked before liveness, so
 *  `not_running` means "supported, but the CLI is not up right now" while
 *  `unsupported` means a bare `/rename` has nothing to hand over. Botmux's own
 *  title is left alone — the CLI chooses the name. */
export function resolveAgentSessionAutoRename(ds: DaemonSession): AgentSessionAutoRename {
  const cliId = effectiveSessionCliId(ds);
  if (!cliId) return { status: 'unsupported' };
  // A remote backend's write() turns each call into a remote task, and there
  // is no local TUI to name (same exclusion as requestAgentSessionRename).
  const backend = ds.initConfig?.backendType ?? ds.session.backendType;
  if (backend && isRemoteBackendId(backend)) return { status: 'unsupported', cliId };
  let command: string | undefined;
  try {
    command = createCliAdapterSync(
      cliId,
      ds.initConfig?.cliPathOverride ?? ds.session.cliPathOverride,
    ).sessionAutoRenameCommand;
  } catch (err) {
    return { status: 'failed', cliId, error: err instanceof Error ? err.message : String(err) };
  }
  if (!command) return { status: 'unsupported', cliId };
  const worker = ds.worker;
  if (!worker || worker.killed || worker.connected === false) return { status: 'not_running', cliId };
  return { status: 'available', cliId, command };
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

  // A remote backend's write() creates one remote turn/task per call, so a TUI
  // command split into text + Enter would create two unrelated ones. Neither
  // remote backends have no local TUI to rename anyway.
  const renameBackend = ds.initConfig?.backendType ?? ds.session.backendType;
  if (renameBackend && isRemoteBackendId(renameBackend)) {
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
