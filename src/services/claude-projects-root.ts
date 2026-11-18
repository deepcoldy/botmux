/**
 * The `projects` directory of the Claude config dir a worker launched its CLI
 * with: the root a transcript has to sit in before the worker rewrites it in
 * place (the image purge; meant for every in-place transcript rewrite).
 *
 * The root comes from the config dir the worker itself set up for the CLI,
 * never from the transcript's own path, and where it really lives is resolved
 * when the CLI is launched. A link put at or above `projects` afterwards does
 * not move the root along with the transcript.
 */
import { lstatSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

export interface ClaudeProjectsRoot {
  /** `<config dir>/projects` as the worker names it. */
  lexical: string;
  /** Where that directory really was when the CLI was launched. */
  real: string;
}

/**
 * Resolve the projects root of `configDir`. `noFollow` is for a config dir
 * inside a sandbox's writable bot home: there the config dir and an existing
 * `projects` must be directories themselves, not links (the same rule the
 * transcript resolver applies to that tree). Undefined when it cannot be
 * resolved; callers then trust no transcript.
 */
export function pinClaudeProjectsRoot(configDir: string, opts: { noFollow?: boolean } = {}): ClaudeProjectsRoot | undefined {
  const lexical = join(resolve(configDir), 'projects');
  try {
    if (opts.noFollow) {
      if (!lstatSync(configDir).isDirectory()) return undefined;
      const projects = lstatOrUndefined(lexical);
      if (projects && !projects.isDirectory()) return undefined;
      return { lexical, real: join(realpathSync(configDir), 'projects') };
    }
    // `projects` may not exist yet: Claude creates it on its first write.
    let real: string;
    try { real = realpathSync(lexical); } catch { real = join(realpathSync(configDir), 'projects'); }
    return { lexical, real };
  } catch {
    return undefined;
  }
}

function lstatOrUndefined(path: string): ReturnType<typeof lstatSync> | undefined {
  try { return lstatSync(path); } catch { return undefined; }
}

/** The launch's pinned root, kept across this worker's CLI restarts: a later
 *  launch of the same config dir reuses `previous` instead of re-resolving a
 *  tree the CLI it replaces could write to. */
export function claudeProjectsRootForLaunch(
  configDir: string,
  previous: ClaudeProjectsRoot | undefined,
  opts: { noFollow?: boolean } = {},
): ClaudeProjectsRoot | undefined {
  if (previous && previous.lexical === join(resolve(configDir), 'projects')) return previous;
  return pinClaudeProjectsRoot(configDir, opts);
}

/** `path` names a file under the root, and really is one there. */
export function isInClaudeProjectsRoot(path: string, root: ClaudeProjectsRoot): boolean {
  const rel = relative(root.lexical, resolve(path));
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return false;
  try {
    return realpathSync(path).startsWith(`${root.real}${sep}`);
  } catch {
    return false;
  }
}
