/**
 * The settings of a WeCom configuration a running connection cannot take: a
 * change to any of them applies only once the connection is restarted.
 *
 * Everything else applies without a restart. The gateway reads its own settings
 * (role, user access, session mode, command templates, message display) from
 * the file for every message, and hands every change of the core settings —
 * Agent, model, backend, working directory and `managedCore.botConfig` — to its
 * running core for new sessions (gateway/core-profile-sync.ts).
 *
 * What is listed is fixed when the connection starts: who the gateway connects
 * as, which core (port, bot, state) it drives, and where both keep their state.
 * Every core setting was checked to be read when a new session needs it, not
 * once when the core starts; one found to be fixed at start belongs here, and
 * the gateway then reports the change as needing a restart instead of handing
 * it over.
 */
import type { WecomConfig } from './config.js';

export const WECOM_RESTART_ONLY_SETTINGS: ReadonlyArray<readonly [name: string, read: (config: WecomConfig) => unknown]> = [
  // The WeCom identity and credential the transport connected with.
  ['botId', config => config.botId],
  ['secretEnv', config => config.secretEnv],
  ['secretFile', config => config.secretFile],
  // Where the gateway keeps its state.
  ['stateDir', config => config.stateDir],
  // Which core the gateway drives, and whether it launches one at all.
  ['coreUrl', config => config.coreUrl],
  ['managedCore', config => config.managedCore !== undefined],
  ['managedCore.botId', config => config.managedCore?.botId],
  ['managedCore.port', config => config.managedCore?.port],
  ['managedCore.stateDir', config => config.managedCore?.stateDir],
];

/** The names of the restart-only settings `latest` changed against `started`. */
export function wecomRestartOnlyChanges(started: WecomConfig, latest: WecomConfig): string[] {
  return WECOM_RESTART_ONLY_SETTINGS
    .filter(([, read]) => read(started) !== read(latest))
    .map(([name]) => name);
}
