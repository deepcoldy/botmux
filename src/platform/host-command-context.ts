import { homedir } from 'node:os';
import { resolveBotmuxDataDir } from '../core/data-dir.js';
import { resolveSessionContext } from '../core/session-marker.js';

export interface ManagedAgentHostCommandContextOptions {
  env?: NodeJS.ProcessEnv;
  dataDir?: string;
  startPid?: number;
}

/**
 * Detect commands launched from a botmux-managed AI CLI rather than a trusted
 * host terminal. Environment hints cover detached/workflow launches; the
 * daemon-owned PID marker covers shells which scrub those hints. Child-provided
 * HOME/SESSION_DATA_DIR are deliberately ignored when resolving the authority
 * store. This is an early UX/consumption guard; OS credential isolation remains
 * the actual secret boundary.
 */
export function isManagedAgentHostCommandContext(
  options: ManagedAgentHostCommandContextOptions = {},
): boolean {
  const env = options.env ?? process.env;
  if (env.BOTMUX_WORKFLOW === '1' || !!env.BOTMUX_SESSION_ID?.trim()) return true;
  try {
    const dataDir = options.dataDir
      ?? resolveBotmuxDataDir({ env: {}, homeDir: homedir() });
    return resolveSessionContext(dataDir, undefined, options.startPid ?? process.ppid) !== null;
  } catch {
    // If the authority boundary cannot be evaluated, fail closed.
    return true;
  }
}
