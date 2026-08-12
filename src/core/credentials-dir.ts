/**
 * Resolve Botmux's credential root directory — the single source for paths
 * guarded by secure-host-file's strict ancestor-chain check.
 *
 * The default root is `~/.botmux`. On multi-tenant hosts the home chain may
 * cross a mount point owned by another user (e.g. `/data00` belonging to a
 * different account); the secure-host-file check then fails closed and every
 * credential write (`dashboard-token`, device credentials, platform binding,
 * isolation markers) errors out. `BOTMUX_CREDENTIALS_DIR` redirects the root
 * to a trusted location (e.g. `/tmp/botmux-<uid>`, whose root-owned sticky
 * chain passes the check). The daemon persists a breadcrumb so bare CLI
 * invocations follow the same deployment without sharing the env var.
 *
 * Priority: BOTMUX_CREDENTIALS_DIR > `~/.botmux/.credentials-dir` breadcrumb
 * > `~/.botmux`. A breadcrumb is accepted only when it is a small regular file
 * containing an absolute path to an existing directory.
 */

import { existsSync, lstatSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

export interface ResolveCredentialsDirOptions {
  env?: NodeJS.ProcessEnv;
  /** Test seam; defaults to HOME/USERPROFILE from env, then os.homedir(). */
  homeDir?: string;
}

function effectiveHome(env: NodeJS.ProcessEnv, explicit?: string): string {
  return explicit ?? env.HOME ?? env.USERPROFILE ?? homedir();
}

export function resolveCredentialsDir(
  options: ResolveCredentialsDirOptions = {},
): string {
  const env = options.env ?? process.env;
  const explicit = env.BOTMUX_CREDENTIALS_DIR?.trim();
  if (explicit) {
    // Fail closed on a non-absolute redirect: never guess where credentials live.
    if (!isAbsolute(explicit)) {
      throw new Error(
        `BOTMUX_CREDENTIALS_DIR 必须是绝对路径，收到 "${explicit}"`,
      );
    }
    return resolve(explicit);
  }

  const configDir = join(effectiveHome(env, options.homeDir), '.botmux');
  const breadcrumb = join(configDir, '.credentials-dir');
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
    // stable user credential directory. They never redirect to a relative path.
  }

  return configDir;
}

/** Persist the credential-root breadcrumb next to the daemon's data-dir one. */
export function persistCredentialsDirBreadcrumb(
  dir: string,
  options: ResolveCredentialsDirOptions = {},
): void {
  const env = options.env ?? process.env;
  const configDir = join(effectiveHome(env, options.homeDir), '.botmux');
  try {
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, '.credentials-dir'), dir, { encoding: 'utf8' });
  } catch {
    // Best effort — readers fall back to ~/.botmux when the breadcrumb is absent.
  }
}
