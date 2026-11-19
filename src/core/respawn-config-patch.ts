/**
 * Respawn config patch — the daemon's latest launch settings, folded into the
 * worker's `lastInitConfig` before an in-worker CLI respawn.
 *
 * An in-worker respawn (`/restart`, card / dashboard restart, CLI-crash
 * auto-restart, crash-park recovery on the next message) never re-forks the
 * worker, so no fresh `init` arrives: the replacement CLI is built from
 * `{...lastInitConfig}`, i.e. the fork-time snapshot. Every bot setting that is
 * meant to take effect on the next spawn therefore has to ride the IPC that
 * triggers the respawn and be patched in here — otherwise a dashboard edit is
 * silently ignored until the worker happens to be re-forked.
 *
 * Tri-state per field (same contract as the daemon carriers in worker-pool.ts):
 *  - `undefined` → not carried (older daemon / lookup failed): keep the snapshot;
 *  - `null`      → explicitly cleared: drop the snapshot value;
 *  - a value     → use it.
 *
 * Deliberately NOT patchable here: one-shot / user-owned state such as
 * `initialNativeRename`, `nativeSessionTitle(Prompt)` (a name the user changed
 * via `/rename` must survive a restart) and the per-session frozen launch
 * choices (cli / runtime / wrapper / config dir / effort / sandbox). The daemon
 * resolves frozen `/cli` selections to their own snapshot before sending.
 */
import type { TraexAutoModelConfig } from '../services/traex-auto-model.js';

export interface RespawnConfigPatch {
  /** Role-switch cwd move (restart IPC `updateWorkingDir`). Empty → ignored. */
  workingDir?: string;
  env?: Record<string, string> | null;
  envUnset?: string[] | null;
  envFingerprint?: string;
  model?: string | null;
  codexRpcInput?: boolean;
  traexAutoModel?: TraexAutoModelConfig | null;
  /** null = explicitly disabled (bots.json `larkToolBinding: false`). */
  larkToolBinding?: boolean | null;
  startupCommands?: string[] | null;
  launchShell?: string | null;
}

/** The `lastInitConfig` fields this patch may write. */
export interface RespawnPatchTarget {
  workingDir: string;
  env?: Record<string, string>;
  envUnset?: string[];
  envFingerprint?: string;
  model?: string;
  codexRpcInput?: boolean;
  traexAutoModel?: TraexAutoModelConfig;
  larkToolBinding?: boolean;
  startupCommands?: string[];
  launchShell?: string;
}

export interface RespawnPatchResult {
  /** traexAutoModel or codexRpcInput was carried: the worker must re-run
   *  configureTraexAutoModel (it derives runtime state from both). */
  traexReconfigure: boolean;
  /** startupCommands changed by value. */
  startupCommandsChanged: boolean;
}

function sameList(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
  const x = a ?? [];
  const y = b ?? [];
  return x.length === y.length && x.every((v, i) => v === y[i]);
}

/** Apply a respawn patch to `cfg` in place. Pure apart from mutating `cfg`. */
export function applyRespawnConfigPatch(cfg: RespawnPatchTarget, patch: RespawnConfigPatch): RespawnPatchResult {
  if (patch.workingDir) cfg.workingDir = patch.workingDir;
  if (patch.env !== undefined) cfg.env = patch.env === null ? undefined : patch.env;
  if (patch.envUnset !== undefined) cfg.envUnset = patch.envUnset === null ? undefined : patch.envUnset;
  if (patch.envFingerprint !== undefined) cfg.envFingerprint = patch.envFingerprint;
  if (patch.model !== undefined) cfg.model = patch.model === null ? undefined : patch.model;
  if (patch.codexRpcInput !== undefined) cfg.codexRpcInput = patch.codexRpcInput;
  if (patch.traexAutoModel !== undefined) cfg.traexAutoModel = patch.traexAutoModel ?? undefined;
  if (patch.larkToolBinding !== undefined) {
    cfg.larkToolBinding = patch.larkToolBinding === null ? false : patch.larkToolBinding;
  }
  let startupCommandsChanged = false;
  if (patch.startupCommands !== undefined) {
    const next = patch.startupCommands === null || patch.startupCommands.length === 0
      ? undefined
      : [...patch.startupCommands];
    startupCommandsChanged = !sameList(cfg.startupCommands, next);
    cfg.startupCommands = next;
  }
  if (patch.launchShell !== undefined) cfg.launchShell = patch.launchShell || undefined;
  return {
    traexReconfigure: patch.traexAutoModel !== undefined || patch.codexRpcInput !== undefined,
    startupCommandsChanged,
  };
}
