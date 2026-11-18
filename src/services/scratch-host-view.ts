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
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { existsSync, lstatSync, readFileSync, readlinkSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';

export interface ScratchPathMapping {
  /** Host-side real prefix (absolute, canonical). */
  from: string;
  /** Clone/merged-tree prefix holding the sandboxed copy. */
  to: string;
}

/** sessionId → live mappings (worker process registry). */
const liveViews = new Map<string, ScratchPathMapping[]>();

/** Latched when the current worker process owns a `sandbox: 'scratch'` session.
 *  Once armed, isolated state resolvers MUST NOT fall back to host paths even if
 *  the sandbox tree is unmounted, deleted, or not yet registered. */
let workerScratchContext: { sessionId: string; dataDir: string } | null = null;

/** Mark this worker process as requiring isolated scratch state views. */
export function enableWorkerScratchIsolation(sessionId: string, dataDir: string): void {
  workerScratchContext = { sessionId, dataDir };
}

/** Whether this worker process is latched into fail-closed scratch isolation. */
export function isWorkerScratchIsolationActive(): boolean {
  return workerScratchContext !== null;
}

/** Active scratch mappings for this worker process (live registry first, then persisted meta). */
export function workerScratchMappings(): ScratchPathMapping[] | undefined {
  if (!workerScratchContext) return undefined;
  return liveViews.get(workerScratchContext.sessionId)
    ?? persistedScratchMappings(workerScratchContext.dataDir, workerScratchContext.sessionId);
}

/** Test-only reset for unit suites sharing one process. */
export function resetWorkerScratchIsolationForTests(): void {
  workerScratchContext = null;
  liveViews.clear();
}

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
 * Canonicalises ancestor symlinks ONLY up to the matched mapping root `m.from`
 * (e.g. `/tmp → /private/tmp` on macOS or `/home/u → /data00/home/u` on Linux),
 * even when the target below `m.from` does not yet exist on the host. Stops
 * host `realpathSync` as soon as the deepest covering `m.from` is reached so a
 * symlink *inside* `$HOME` on the host cannot redirect lookup outside `m.from`
 * and fall back to reading host files. */
export function scratchViewPath(
  mappings: ScratchPathMapping[] | undefined,
  hostAbsPath: string,
): string {
  if (!mappings || mappings.length === 0 || !isAbsolute(hostAbsPath)) return hostAbsPath;
  const sorted = [...mappings].sort((a, b) => b.from.length - a.from.length);
  const lexical = resolve(hostAbsPath);
  const segs = lexical.split('/').filter(Boolean);

  type BoundaryMatch = { mapping: ScratchPathMapping; nextIdx: number };
  let best = null as BoundaryMatch | null;
  const checkBoundary = (cur: string, nextIdx: number): boolean => {
    const exact = sorted.find(m => m.from === cur);
    if (exact) best = { mapping: exact, nextIdx };
    const hasDeeperCandidate = sorted.some(m => m.from !== cur && prefixMatch(cur, m.from));
    return Boolean(exact && !hasDeeperCandidate);
  };

  let cur = '/';
  if (checkBoundary(cur, 0)) {
    return join(best!.mapping.to, ...segs.slice(best!.nextIdx));
  }

  let ancestorMissing = false;
  for (let i = 0; i < segs.length; i++) {
    const nextLexical = join(cur, segs[i]!);
    if (ancestorMissing) {
      cur = nextLexical;
    } else {
      try {
        cur = realpathSync(nextLexical);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException | undefined)?.code;
        if (code === 'ENOENT') {
          ancestorMissing = true;
          cur = nextLexical;
        } else {
          break;
        }
      }
    }
    if (checkBoundary(cur, i + 1)) break;
  }

  if (best) {
    return join(best.mapping.to, ...segs.slice(best.nextIdx));
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

const MAX_SCRATCH_SYMLINK_HOPS = 40;

function isWithinOrEqual(root: string, candidate: string): boolean {
  if (root === '/') return isAbsolute(candidate);
  const normRoot = root.endsWith(sep) ? root.slice(0, -sep.length) : root;
  return candidate === normRoot || candidate.startsWith(`${normRoot}${sep}`);
}

function walkIsolatedSegments(
  isolatedRoot: string,
  isFullRootOverlay: boolean,
  segments: readonly string[],
  allowMissingTail: boolean,
  hopState: { count: number },
): { path: string; isDirectory: boolean; exists: boolean } | null {
  let cur = isolatedRoot;
  let curIsDir = true;
  const queue = [...segments];

  while (queue.length > 0) {
    const seg = queue.shift()!;
    if (seg === '' || seg === '.') continue;
    if (seg.includes('\0')) return null;
    if (seg === '..') {
      if (cur === isolatedRoot) return null;
      const parent = dirname(cur);
      if (!isWithinOrEqual(isolatedRoot, parent)) return null;
      cur = parent;
      curIsDir = true;
      continue;
    }
    if (!curIsDir) return null;

    const next = join(cur, seg);
    if (!isWithinOrEqual(isolatedRoot, next)) return null;

    let lst;
    try {
      lst = lstatSync(next);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | undefined)?.code;
      if (code === 'ENOENT' && allowMissingTail) {
        let prospective = next;
        for (const rem of queue) {
          if (rem === '' || rem === '.') continue;
          if (rem === '..' || rem.includes('\0')) return null;
          prospective = join(prospective, rem);
        }
        return isWithinOrEqual(isolatedRoot, prospective)
          ? { path: prospective, isDirectory: false, exists: false }
          : null;
      }
      // EACCES, EPERM, ELOOP, ENOTDIR, dangling symlink target, etc. → fail closed.
      return null;
    }

    if (lst.isSymbolicLink()) {
      if (++hopState.count > MAX_SCRATCH_SYMLINK_HOPS) return null;
      let linkTarget: string;
      try {
        linkTarget = readlinkSync(next);
      } catch {
        return null;
      }
      if (!linkTarget || linkTarget.includes('\0')) return null;

      let targetRelSegments: string[];
      if (isAbsolute(linkTarget)) {
        if (isFullRootOverlay) {
          // Inside Linux full-root bwrap, `/` is `isolatedRoot` (`<merged>`).
          // Resolve against `isolatedRoot` rather than handing an absolute
          // symlink back to the host kernel (which would open `/` on the host).
          targetRelSegments = linkTarget.split(/[\\/]+/).filter(Boolean);
        } else {
          const resolvedAbs = resolve(linkTarget);
          if (!isWithinOrEqual(isolatedRoot, resolvedAbs)) return null;
          const rel = relative(isolatedRoot, resolvedAbs);
          targetRelSegments = rel ? rel.split(/[\\/]+/).filter(Boolean) : [];
        }
      } else {
        const resolvedRel = resolve(cur, linkTarget);
        if (!isWithinOrEqual(isolatedRoot, resolvedRel)) return null;
        const rel = relative(isolatedRoot, resolvedRel);
        targetRelSegments = rel ? rel.split(/[\\/]+/).filter(Boolean) : [];
      }

      // Symlink target itself must exist inside isolatedRoot (reject dangling links).
      const resolvedLink = walkIsolatedSegments(
        isolatedRoot,
        isFullRootOverlay,
        targetRelSegments,
        false,
        hopState,
      );
      if (!resolvedLink || !resolvedLink.exists) return null;
      if (queue.length > 0 && !resolvedLink.isDirectory) return null;
      cur = resolvedLink.path;
      curIsDir = resolvedLink.isDirectory;
    } else {
      curIsDir = lst.isDirectory();
      if (queue.length > 0 && !curIsDir) return null;
      cur = next;
    }
  }

  return isWithinOrEqual(isolatedRoot, cur)
    ? { path: cur, isDirectory: curIsDir, exists: true }
    : null;
}

/**
 * Resolve a `$HOME`-relative subpath strictly within the session's isolated
 * scratch view. Returns `null` (fail closed — NEVER falls back to host paths)
 * when:
 *  - `mappings` is missing/empty, or no mapping covers canonical `$HOME`,
 *  - `$HOME` or the mapped `to` directory cannot be verified (`ENOENT` / `EACCES` / `ELOOP`),
 *  - `subpath` traverses above `$HOME` (`..`) or is absolute,
 *  - any existing component inside the isolated view is inaccessible (`EACCES` / `ELOOP` / `ENOTDIR`)
 *    or is a symlink escaping the isolated view (cross-HOME / host symlink escape).
 *
 * Non-existent tail segments (`ENOENT`) under a verified real directory inside
 * the isolated root are permitted so callers can resolve lazily-created files
 * (`history.jsonl`, `--log-file`, `transcript_full.jsonl`) even when `$HOME` on
 * the host is itself a symlink (e.g. `/home/u -> /data00/home/u`).
 */
export function resolveScratchHomeSubpathStrict(
  mappings: readonly ScratchPathMapping[] | undefined,
  subpath: string,
  opts?: { homeDir?: string },
): string | null {
  if (!mappings || mappings.length === 0) return null;
  if (isAbsolute(subpath) || subpath.includes('\0')) return null;

  const relParts: string[] = [];
  for (const part of subpath.split(/[\\/]+/)) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (relParts.length === 0) return null;
      relParts.pop();
      continue;
    }
    relParts.push(part);
  }

  const rawHome = opts?.homeDir ?? homedir();
  if (!rawHome || !isAbsolute(rawHome)) return null;
  let canonHome: string;
  try {
    canonHome = realpathSync(rawHome);
  } catch {
    return null;
  }

  const targetCanon = relParts.length > 0 ? join(canonHome, ...relParts) : canonHome;
  const sorted = [...mappings].sort((a, b) => b.from.length - a.from.length);
  const matched = sorted.find(m => prefixMatch(m.from, targetCanon));
  if (!matched) return null;

  let isolatedRoot: string;
  try {
    const rootStat = lstatSync(matched.to);
    if (!rootStat.isDirectory()) return null;
    isolatedRoot = realpathSync(matched.to);
  } catch {
    return null;
  }

  const isFullRootOverlay = matched.from === '/';
  const rest = isFullRootOverlay ? targetCanon : targetCanon.slice(matched.from.length);
  const walkSegments = rest.split(/[\\/]+/).filter(Boolean);
  if (walkSegments.some(s => s === '..' || s.includes('\0'))) return null;

  const walked = walkIsolatedSegments(
    isolatedRoot,
    isFullRootOverlay,
    walkSegments,
    true,
    { count: 0 },
  );
  return walked?.path ?? null;
}

/**
 * Worker-side helper for `$HOME`-relative CLI state paths:
 *  - When scratch isolation is NOT active for this worker, returns `join(homedir(), subpath)`.
 *  - When scratch isolation IS active, resolves strictly inside the session's
 *    scratch view and returns `null` (fail closed) if the view is missing or invalid.
 */
export function resolveWorkerHomeSubpath(
  subpath: string,
  opts?: { homeDir?: string },
): string | null {
  if (!workerScratchContext) {
    const base = opts?.homeDir ?? homedir();
    return subpath ? join(base, subpath) : base;
  }
  return resolveScratchHomeSubpathStrict(workerScratchMappings(), subpath, opts);
}
