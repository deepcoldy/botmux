/**
 * Scratch host-view registry: where the daemon/worker reads files a
 * scratch-sandboxed CLI wrote.
 *
 * A scratch container mounts the host-side merged overlay at `/`, so a file
 * the CLI sees at `/abs/path` physically lands at `<mergedHostPath>/abs/path`
 * on the host. The merged root is fully derivable
 * (`<dataDir>/sandboxes/<sessionId>/root`), and when the overlay is NOT mounted
 * that directory is simply EMPTY — reads remapped into it return ENOENT, which
 * is the correct "session not resumed" signal. Readers must therefore remap
 * for any frozen scratch session and NEVER fall back to the real host path
 * (that would surface stale data or another session's files).
 */
import { isAbsolute, join } from 'node:path';

/** sessionId → host-side merged root (worker process registry). */
const liveViews = new Map<string, string>();

/** Record the live merged root for a scratch session (worker spawn/reattach). */
export function registerScratchView(sessionId: string, mergedHostPath: string | undefined): void {
  if (!mergedHostPath) return;
  liveViews.set(sessionId, mergedHostPath);
}

/** Drop the registry entry at teardown. Does NOT unmount (cleanup does that). */
export function clearScratchView(sessionId: string): void {
  liveViews.delete(sessionId);
}

/** The registered live merged root in THIS process, if any. */
export function registeredScratchView(sessionId: string): string | undefined {
  return liveViews.get(sessionId);
}

/** Deterministic merged root for a session given its data dir. */
export function scratchMergedRootFor(dataDir: string, sessionId: string): string {
  return join(dataDir, 'sandboxes', sessionId, 'root');
}

/**
 * Resolve a host absolute path through a scratch session's merged tree.
 * Returns the ORIGINAL path when mergedRoot is undefined, so callers that
 * don't know the session's mode can call this unconditionally.
 */
export function scratchViewPath(
  mergedRoot: string | undefined,
  hostAbsPath: string,
): string {
  if (!mergedRoot || !isAbsolute(hostAbsPath)) return hostAbsPath;
  return join(mergedRoot, hostAbsPath);
}
