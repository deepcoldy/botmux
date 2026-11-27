import { isAbsolute, relative } from 'node:path';

/**
 * Whether `target` is `base` itself or lies under it, judged on the paths as
 * given (callers pass real paths when a symlink must not lead out). A name that
 * only starts with two dots (`..foo`) is inside.
 */
export function wecomPathInside(base: string, target: string): boolean {
  const r = relative(base, target);
  return r !== '..' && !r.startsWith('../') && !isAbsolute(r);
}
