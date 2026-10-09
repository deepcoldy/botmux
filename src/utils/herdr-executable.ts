import { locateExecutable } from './executable.js';

let resolved: string | undefined;

/** `herdr` resolved to an absolute path once per process.
 *
 * Spawning the bare name makes libuv try posix_spawn in every PATH entry
 * before the one holding herdr. On macOS each failed attempt is a short-lived
 * copy of this Node process, and macOS 26 has syspolicyd validate every copy;
 * at the backend's 0.5 s polls that is hundreds of validations per second.
 * The bare name stays the fallback so a missing herdr fails exactly as before.
 */
export function herdrExecutable(): string {
  return resolved ??= locateExecutable('herdr') ?? 'herdr';
}
