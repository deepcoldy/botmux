/**
 * What the fleet supervisor needs to know about the WeCom connections, derived
 * from files alone (nothing here starts a process): which registered
 * connections exist, their desired state, the hash of the configuration a
 * gateway would start from, and the `.env` keys a gateway receives on top of the
 * fleet's base environment.
 *
 * A connection's configuration is NOT validated here. Membership only needs the
 * file to exist; the gateway is the authority on whether it is usable and exits
 * with the no-restart code when it is not, so a broken configuration shows up as
 * an `errored` member instead of silently not running. (Validating would also
 * pull the whole configuration parser — bot registry included — into the
 * supervisor process.)
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parse as parseDotEnv } from 'dotenv';
import { isDashboardEnvKey } from '../../../utils/dashboard-env.js';
import { stripDashboardH5Env } from '../../../utils/child-env.js';
import { readWecomConfigPaths, wecomConfigId, wecomRoot } from './discovery.js';
import {
  readWecomFleetDesiredState,
  wecomDesiredStateOf,
  wecomFleetDesiredStatePath,
  WecomFleetDesiredStateUnavailableError,
  type WecomDesiredState,
} from './fleet-desired-state.js';
import { wecomFleetMemberName } from '../contract/fleet-member.js';

export { isWecomFleetMemberName } from './fleet-member-name.js';

export type WecomConnectionFile =
  | { presence: 'present'; text: string }
  | { presence: 'missing' }
  | { presence: 'unreadable'; reason: string };

export interface WecomFleetConnection {
  configId: string;
  /** Absolute, resolved configuration path from the registry. */
  file: string;
  memberName: string;
  desired: WecomDesiredState | 'unrecorded';
  config: WecomConnectionFile;
}

/** The WeCom connection set could not be read as a whole (registry or
 *  desired-state file unreadable/corrupt). Callers must change nothing. */
export class WecomFleetUnavailableError extends Error {
  readonly code = 'WECOM_FLEET_UNAVAILABLE';

  constructor(message: string) {
    super(message);
    this.name = 'WecomFleetUnavailableError';
  }
}

function readConnectionFile(file: string): WecomConnectionFile {
  try {
    return { presence: 'present', text: readFileSync(file, 'utf8') };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return { presence: 'missing' };
    return { presence: 'unreadable', reason: code ?? 'error' };
  }
}

/**
 * Every registered connection with its desired state. Throws
 * {@link WecomFleetUnavailableError} when the registry or the desired-state file
 * exists but cannot be trusted: reading either as empty would tell the caller
 * that every connection is gone or stopped.
 */
export function listWecomFleetConnections(root = wecomRoot()): WecomFleetConnection[] {
  let paths: string[];
  try {
    paths = readWecomConfigPaths(root, true);
  } catch (err) {
    throw new WecomFleetUnavailableError(`wecom_registry_unavailable: ${err instanceof Error ? err.message : String(err)}`);
  }
  const desired = readWecomFleetDesiredState(root);
  if (desired.status !== 'ok') {
    throw new WecomFleetUnavailableError(
      new WecomFleetDesiredStateUnavailableError(wecomFleetDesiredStatePath(root), desired.reason).message,
    );
  }
  return paths.map(file => {
    const configId = wecomConfigId(file);
    return {
      configId,
      file,
      memberName: wecomFleetMemberName(configId),
      desired: wecomDesiredStateOf(desired, configId),
      config: readConnectionFile(file),
    };
  });
}

/** Hash of the configuration a gateway starts from; persisted as the member's
 *  configHash so "running from a stale configuration" can be detected. */
export function wecomFleetConfigHash(configText: string): string {
  return createHash('sha256').update(configText).digest('hex');
}

/**
 * The keys of `~/.botmux/.env` a WeCom gateway receives on top of the fleet's
 * base environment: the Dashboard's `.env` allowlist (proxies, CLI_ID,
 * BACKEND_TYPE, …), because a gateway used to inherit the Dashboard's
 * environment and its core and CLI sessions must keep seeing the same values.
 * A key the base environment already has is not overridden (dotenv semantics,
 * as in the Dashboard), and the Dashboard-only H5 login family is left out.
 */
export function wecomFleetMemberEnvFromDotEnv(
  envFileText: string | undefined,
  baseEnv: NodeJS.ProcessEnv,
): Record<string, string> {
  if (envFileText === undefined) return {};
  const parsed = parseDotEnv(envFileText);
  const extras: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (!isDashboardEnvKey(key)) continue;
    if (baseEnv[key] !== undefined) continue;
    extras[key] = value;
  }
  stripDashboardH5Env(extras);
  return extras as Record<string, string>;
}
