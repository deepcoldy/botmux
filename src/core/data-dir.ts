/**
 * Resolve Botmux's durable data directory from one canonical precedence rule.
 *
 * The daemon writes `~/.botmux/.data-dir` on startup so bare-shell CLI
 * invocations can follow custom deployments. Every durable-state reader that
 * may run outside an injected session must use this helper; otherwise a
 * migration writer and an execution guard can silently consult different
 * stores.
 */

import { existsSync, lstatSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

export interface ResolveBotmuxDataDirOptions {
  env?: NodeJS.ProcessEnv;
  /** Test seam; defaults to HOME/USERPROFILE from env, then os.homedir(). */
  homeDir?: string;
}

function effectiveHome(env: NodeJS.ProcessEnv, explicit?: string): string {
  return explicit ?? env.HOME ?? env.USERPROFILE ?? homedir();
}

/**
 * Priority: SESSION_DATA_DIR > daemon breadcrumb > ~/.botmux/data.
 *
 * A breadcrumb is accepted only when it is a small regular file containing
 * an absolute path to an existing directory. It deliberately does not require
 * a sessions*.json file: a fresh daemon owns its dataDir before the first
 * conversation, and migration state must already follow that ownership.
 */
export function resolveBotmuxDataDir(
  options: ResolveBotmuxDataDirOptions = {},
): string {
  const env = options.env ?? process.env;
  const explicit = env.SESSION_DATA_DIR?.trim();
  if (explicit) return resolve(explicit);

  const configDir = join(effectiveHome(env, options.homeDir), '.botmux');
  const breadcrumb = join(configDir, '.data-dir');
  try {
    const stat = lstatSync(breadcrumb);
    if (stat.isFile() && !stat.isSymbolicLink() && stat.size <= 4096) {
      const candidate = readFileSync(breadcrumb, 'utf-8').trim();
      if (candidate && isAbsolute(candidate) && existsSync(candidate)) {
        const target = statSync(candidate);
        if (target.isDirectory()) return resolve(candidate);
      }
    }
  } catch {
    // Missing, stale, unreadable, or malformed breadcrumbs fall back to the
    // stable user data directory. They never redirect to a relative path.
  }

  return join(configDir, 'data');
}
