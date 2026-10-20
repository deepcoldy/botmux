/**
 * Scratch host-view registry: where the daemon/worker reads files a
 * scratch-sandboxed CLI wrote.
 *
 * Two platform mechanisms, one mapping model:
 *  - Linux full-root overlay: ONE mapping `'/' → <sessionRoot>/root`; the
 *    container mounts the host-side merged tree at `/`, so `/x` maps to
 *    `<merged>/x`.
 *  - macOS APFS clonefile: the clone lives in normal host directories and the
 *    child's HOME (and chdir) are POINTED at the clone, so mappings are
 *    `$HOME → <clone>/home` and (when the project lies outside $HOME)
 *    `<cwd> → <clone>/work`.
 *
 * When no mapping covers a path the ORIGINAL path is returned — callers that
 * don't know the session's mode can call this unconditionally. Readers must
 * NEVER fall back to a real host path for a path a mapping covered but
 * currently absent (unmounted/deleted clone): that would surface stale data.
 */
import { isAbsolute, join, resolve } from 'node:path';
import { existsSync, readFileSync, realpathSync } from 'node:fs';

export interface ScratchPathMapping {
  /** Host-side real prefix (absolute, canonical). */
  from: string;
  /** Clone/merged-tree prefix holding the sandboxed copy. */
  to: string;
}

/** sessionId → live mappings (worker process registry). */
const liveViews = new Map<string, ScratchPathMapping[]>();

/** Record the live mappings for a scratch session (worker spawn/reattach). */
export function registerScratchView(sessionId: string, mappings: ScratchPathMapping[] | undefined): void {
  if (!mappings || mappings.length === 0) return;
  // Deepest `from` first so a nested project mapping wins over the HOME one.
  liveViews.set(sessionId, [...mappings].sort((a, b) => b.from.length - a.from.length));
}

/** Drop the registry entry at teardown. */
export function clearScratchView(sessionId: string): void {
  liveViews.delete(sessionId);
}

/** The registered live mappings in THIS process, if any. */
export function registeredScratchView(sessionId: string): ScratchPathMapping[] | undefined {
  return liveViews.get(sessionId);
}

/** Deterministic Linux merged root for a session given its data dir. */
export function scratchMergedRootFor(dataDir: string, sessionId: string): string {
  return join(dataDir, 'sandboxes', sessionId, 'root');
}

/** Linux convenience: the single full-root mapping. */
export function scratchLinuxMappings(mergedRoot: string): ScratchPathMapping[] {
  return [{ from: '/', to: mergedRoot }];
}

function prefixMatch(realPrefix: string, p: string): boolean {
  if (realPrefix === '/') return true;
  if (p === realPrefix) return true;
  return p.startsWith(realPrefix.endsWith('/') ? realPrefix : `${realPrefix}/`);
}

/** Resolve one host absolute path through the first mapping covering it.
 *  Returns the input unchanged when uncovered/relative.
 *
 * The lookup path is canonicalised with realpath before prefix matching when
 * it EXISTS: mapping `from`s are realpath-normalised, so a caller passing a
 * symlink alias (/var/... vs /private/var/..., /tmp vs /private/tmp) would
 * otherwise miss every mapping and fall back to the real host path (a macOS
 * scratch cost-card bug found on a real Mac: projects under /tmp). A
 * non-existent path can't be realpath'd, so it falls back to lexical resolve. */
export function scratchViewPath(
  mappings: ScratchPathMapping[] | undefined,
  hostAbsPath: string,
): string {
  if (!mappings || !isAbsolute(hostAbsPath)) return hostAbsPath;
  let canon = hostAbsPath;
  try { canon = realpathSync(hostAbsPath); } catch {
    try { canon = resolve(hostAbsPath); } catch { /* keep lexical */ }
  }
  for (const m of mappings) {
    if (prefixMatch(m.from, canon)) {
      const rest = m.from === '/' ? canon : canon.slice(m.from.length);
      return join(m.to, rest);
    }
  }
  return hostAbsPath;
}

/** Back-compat single-root helper (probe/early call sites). */
export function scratchViewPathSingle(mergedRoot: string | undefined, hostAbsPath: string): string {
  if (!mergedRoot) return hostAbsPath;
  return scratchViewPath(scratchLinuxMappings(mergedRoot), hostAbsPath);
}

/**
 * Load the persisted scratch mappings for a session from its per-session meta
 * (works in BOTH processes: worker and daemon). Returns undefined for a
 * non-scratch session or a missing/unreadable meta.
 *
 * The meta file lives at `<dataDir>/sandboxes/<sid>/scratch.json` (written by
 * the macOS/backend module; the Linux module writes the same shape with one
 * `'/'` mapping derived from `merged`).
 */
export function persistedScratchMappings(dataDir: string, sessionId: string): ScratchPathMapping[] | undefined {
  const metaPath = join(dataDir, 'sandboxes', sessionId, 'scratch.json');
  try {
    const m = JSON.parse(readFileSync(metaPath, 'utf8')) as { mappings?: unknown };
    if (Array.isArray(m.mappings)) {
      const out = m.mappings
        .filter((x): x is ScratchPathMapping => !!x && typeof x === 'object'
          && typeof (x as ScratchPathMapping).from === 'string'
          && typeof (x as ScratchPathMapping).to === 'string'
          && isAbsolute((x as ScratchPathMapping).from)
          && isAbsolute((x as ScratchPathMapping).to))
        .sort((a, b) => b.from.length - a.from.length);
      if (out.length) return out;
    }
  } catch { /* not a scratch session */ }
  return undefined;
}

/** Whether a scratch session's clone/merged tree currently exists on disk. */
export function scratchViewPresent(dataDir: string, sessionId: string): boolean {
  return existsSync(join(dataDir, 'sandboxes', sessionId));
}
