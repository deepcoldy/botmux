/**
 * Close-time teardown of a session's per-session sandbox tree
 * (`<data>/sandboxes/<sid>`) when no worker is left to run its own cleanup —
 * e.g. the worker crashed (its persistent pane outlived it, so it kept the tree
 * for a successor) and the session is closed before any successor attached.
 *
 * Each flavour gets its own teardown, never a blind recursive rm:
 *  - Linux scratch: unmount first (submount binds → sub-overlays → main overlay
 *    → tmpfs slot), then remove — a still-mounted merged root is the full-root
 *    COW view of the whole host;
 *  - macOS scratch: unlock the clone tree, then remove;
 *  - oncall / credential-only: reclaim the recorded deny-mask mountpoints, then
 *    remove (refused if anything is mounted below the tree).
 *
 * The caller must already have proven the session's pane gone.
 */
import { lstatSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { MASK_MANIFEST_NAME, mountsAtOrUnder, SCRATCH_TREE_MARKER, teardownDirectSandboxSession } from './sandbox.js';
import { teardownScratchSession } from './scratch-sandbox.js';
import { teardownMacScratchSession } from './scratch-sandbox-darwin.js';

function exists(path: string): boolean {
  try { lstatSync(path); return true; } catch { return false; }
}

function sessionTreeRoot(sessionId: string, dataDir: string): string | null {
  if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) return null;
  let canonicalDataDir = dataDir;
  try { canonicalDataDir = realpathSync(dataDir); } catch { /* keep lexical */ }
  return join(canonicalDataDir, 'sandboxes', sessionId);
}

/** A per-session tree's flavour (only flavours that own one). */
export type SandboxTreeFlavour = 'scratch' | 'oncall' | 'credential-only';

/** Flavour of the tree a spawn with this policy builds; null = it builds none
 *  (sandbox off without device enrollment; macOS oncall and credential-only
 *  are Seatbelt profiles, not trees). */
export function requestedSandboxTreeFlavour(input: {
  platform: NodeJS.Platform;
  scratchRequested: boolean;
  sandboxRequested: boolean;
  credentialOnlyBwrap: boolean;
}): SandboxTreeFlavour | null {
  if (input.scratchRequested) return 'scratch';
  if (input.sandboxRequested) return input.platform === 'linux' ? 'oncall' : null;
  return input.credentialOnlyBwrap ? 'credential-only' : null;
}

/** Flavour recorded by the tree already on disk, read from what each flavour's
 *  prepare leaves there: scratch writes its `scratch.json` marker (and is the
 *  only flavour with host-side mounts in the tree); oncall builds its shim /
 *  deny-mask scaffold (`shimbin`, `empties`, `empty`, the mask manifest); a
 *  credential-only tree is just the relay outbox. null = no tree. */
export function recordedSandboxTreeFlavour(sessionId: string, dataDir: string): SandboxTreeFlavour | null {
  const sessionRoot = sessionTreeRoot(sessionId, dataDir);
  if (!sessionRoot || !exists(sessionRoot)) return null;
  if (exists(join(sessionRoot, SCRATCH_TREE_MARKER))) return 'scratch';
  if (process.platform === 'linux' && mountsAtOrUnder(sessionRoot)?.length !== 0) return 'scratch';
  if (['shimbin', 'empties', 'empty', MASK_MANIFEST_NAME].some(name => exists(join(sessionRoot, name)))) return 'oncall';
  return 'credential-only';
}

/**
 * THE single place a spawn reconciles the tree it inherits with the flavour it
 * is about to build. A tree of the SAME flavour is the session's own state and
 * is reused (scratch re-adopts its overlay/upper on a cold resume, oncall
 * re-binds over its tree, credential-only re-serves its outbox). A tree of
 * ANOTHER flavour — a policy flip (sandbox on/off, oncall ↔ scratch) across a
 * restart — is torn down with ITS OWN teardown first (scratch: unmount, then
 * remove), and only once its pane is proven gone; otherwise the new flavour
 * would be prepared on top of it (e.g. a credential-only outbox inside a
 * still-mounted full-root COW view). Throws (fail closed) when the old pane may
 * still run, or the old tree cannot be taken down.
 */
export function reconcileSandboxTreeFlavour(input: {
  sessionId: string;
  dataDir: string;
  requested: SandboxTreeFlavour | null;
  /** A warm reattach keeps the live pane, and with it its tree. */
  reattach: boolean;
  /** Liveness of the session's pane; only an authoritative `missing` proves it gone. */
  probePane: () => string;
  log?: (message: string) => void;
}): 'none' | 'kept' | 'torn-down' {
  const recorded = recordedSandboxTreeFlavour(input.sessionId, input.dataDir);
  if (!recorded) return 'none';
  if (recorded === input.requested || input.reattach) return 'kept';
  const probe = input.probePane();
  if (probe !== 'missing') {
    throw new Error(
      `[sandbox] refusing to start session ${input.sessionId}: its previous ${recorded} sandbox tree `
      + `may still be in use by its pane (probe: ${probe})`,
    );
  }
  input.log?.(`[sandbox] sandbox flavour changed (${recorded} → ${input.requested ?? 'none'}): tearing down the previous tree first`);
  teardownSessionSandboxTree(input.sessionId, input.dataDir);
  if (recordedSandboxTreeFlavour(input.sessionId, input.dataDir) !== null) {
    throw new Error(
      `[sandbox] refusing to start session ${input.sessionId}: could not tear down its previous `
      + `${recorded} sandbox tree (still mounted?)`,
    );
  }
  return 'torn-down';
}

export function teardownSessionSandboxTree(sessionId: string, dataDir: string): void {
  const sessionRoot = sessionTreeRoot(sessionId, dataDir);
  if (!sessionRoot || !exists(sessionRoot)) return;
  if (exists(join(sessionRoot, SCRATCH_TREE_MARKER))) {
    if (process.platform === 'darwin') teardownMacScratchSession(sessionId, dataDir);
    else teardownScratchSession(sessionId, dataDir);
    return;
  }
  // A Linux tree with mounts but no marker can only be a scratch tree whose
  // meta write was lost: the scratch teardown still unmounts its default
  // layout first and refuses to remove anything that stays mounted.
  if (process.platform === 'linux' && mountsAtOrUnder(sessionRoot)?.length !== 0) {
    teardownScratchSession(sessionId, dataDir);
    return;
  }
  teardownDirectSandboxSession(sessionId, dataDir);
}
