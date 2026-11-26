import { config } from '../config.js';
import type { BotConfig } from '../bot-registry.js';
import type { CliId } from '../adapters/cli/types.js';
import type { BackendType } from '../adapters/backend/types.js';
import type { DaemonSession } from './types.js';
import { reconcilePairedBackendId } from './remote-cli-ids.js';

/**
 * Planned backend type for an opening prompt before `forkWorker` stamps
 * `ds.session.backendType`. Mirrors `resolvePairedSpawnBackendType` in
 * `persistent-backend.ts` while remaining a dependency-free leaf so callers
 * avoid adding new named imports onto heavily partial-mocked modules.
 *
 * A live worker's frozen `initConfig.backendType` always wins.
 */
export function plannedOpeningBackendType(
  ds: Pick<DaemonSession, 'initConfig'> & { session: Pick<DaemonSession['session'], 'backendType'> },
  cliId: CliId,
  botCfg?: Pick<BotConfig, 'backendType'>,
): BackendType {
  if (ds.initConfig?.backendType && (!ds.initConfig.cliId || ds.initConfig.cliId === cliId)) {
    return ds.initConfig.backendType;
  }
  const defaultType = config.daemon.backendType;
  const resolved = ds.session.backendType ?? botCfg?.backendType ?? defaultType;
  return reconcilePairedBackendId(cliId, resolved, defaultType) as BackendType;
}
