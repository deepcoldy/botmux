import type { BackendType } from '../adapters/backend/types.js';
import type { RiffBackendConfig } from '../adapters/backend/riff-backend.js';
import { cancelRiffTaskById } from '../adapters/backend/riff-backend.js';
import {
  isSuspendableBackendType,
  killPersistentSession,
  persistentSessionName,
  probePersistentSession,
} from './persistent-backend.js';

export type ExplicitSessionBackingCleanupResult =
  | { ok: true; kind: 'skipped_adopted' | 'no_backing' }
  | { ok: true; kind: 'destroyed_persistent'; backendType: 'tmux' | 'herdr' | 'zellij'; name: string }
  | { ok: true; kind: 'cancelled_riff'; taskId: string }
  | {
      ok: false;
      kind: 'persistent_destroy_failed' | 'riff_config_missing' | 'riff_cancel_failed';
      backendType: BackendType;
      taskId?: string;
      error?: string;
    };

export interface ExplicitSessionBackingCleanupInput {
  sessionId: string;
  backendType?: BackendType;
  riffParentTaskId?: string;
  /** Adopted panes/agents are user-owned. Explicit Botmux close only detaches
   * its logical row and must never destroy the observed backing resource. */
  adopted?: boolean;
  /** Current authoritative config for the row's bot. Required only when the
   * row is frozen to Riff and still carries a remote task id. */
  riffConfig?: RiffBackendConfig;
}

export interface ExplicitSessionBackingCleanupDeps {
  cancelRiffTask?: typeof cancelRiffTaskById;
  killPersistent?: typeof killPersistentSession;
  probePersistent?: typeof probePersistentSession;
}

/**
 * Destroy the Botmux-owned backing resource before an offline/worker-less
 * explicit close is published.
 *
 * This helper never mutates the session record. In particular, callers may
 * erase `riffParentTaskId` only after `kind === 'cancelled_riff'`; a failed or
 * unconfigurable cancellation therefore retains the durable retry handle.
 */
export async function cleanupExplicitSessionBacking(
  input: ExplicitSessionBackingCleanupInput,
  deps: ExplicitSessionBackingCleanupDeps = {},
): Promise<ExplicitSessionBackingCleanupResult> {
  if (input.adopted) return { ok: true, kind: 'skipped_adopted' };

  if (input.backendType === 'riff') {
    const taskId = input.riffParentTaskId;
    if (!taskId) return { ok: true, kind: 'no_backing' };
    if (!input.riffConfig?.baseUrl) {
      return { ok: false, kind: 'riff_config_missing', backendType: 'riff', taskId };
    }
    const cancel = deps.cancelRiffTask ?? cancelRiffTaskById;
    try {
      const cancelled = await cancel(input.riffConfig, taskId);
      return cancelled
        ? { ok: true, kind: 'cancelled_riff', taskId }
        : { ok: false, kind: 'riff_cancel_failed', backendType: 'riff', taskId };
    } catch (err) {
      return {
        ok: false,
        kind: 'riff_cancel_failed',
        backendType: 'riff',
        taskId,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  if (!isSuspendableBackendType(input.backendType)) {
    // Explicit pty and legacy unstamped rows have no deterministic persistent
    // backing session to destroy. Never guess that an unstamped row was tmux.
    return { ok: true, kind: 'no_backing' };
  }

  const name = persistentSessionName(input.backendType, input.sessionId);
  const kill = deps.killPersistent ?? killPersistentSession;
  const probe = deps.probePersistent ?? probePersistentSession;
  try {
    kill(input.backendType, name);
    // Backend kill helpers are intentionally idempotent and historically
    // swallow command errors. Offline explicit abandon needs a stronger
    // contract: only publish closed after a post-kill probe confirms absence.
    const after = probe(input.backendType, name);
    if (after !== 'missing') {
      return {
        ok: false,
        kind: 'persistent_destroy_failed',
        backendType: input.backendType,
        error: after === 'exists' ? 'backing_session_still_exists' : 'backing_session_state_unknown',
      };
    }
    return { ok: true, kind: 'destroyed_persistent', backendType: input.backendType, name };
  } catch (err) {
    return {
      ok: false,
      kind: 'persistent_destroy_failed',
      backendType: input.backendType,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
