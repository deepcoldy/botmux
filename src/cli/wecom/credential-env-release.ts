/**
 * A connection whose configuration takes its credential from an environment
 * variable (`secretEnv`) stops itself when the fleet's environment does not
 * have that variable, and records `stopped(credential_env_missing)` so the
 * fleet does not keep restarting it. The fleet's environment is the one the
 * supervisor was started from: `botmux start` / `botmux restart`, the boot hook
 * (which keeps PATH only), or a Dashboard-triggered restart.
 *
 * Right before `botmux start` / `botmux restart` start a NEW supervisor from
 * the current environment, each such record is looked at again:
 *  - the current environment has the variable (non-empty): the record goes back
 *    to `running`, so the new supervisor starts the connection;
 *  - it does not: the record stays, and the command says which variable is
 *    missing (its NAME — a value is never read out or printed).
 *
 * Nothing is read on a host without a WeCom desired-state file, and the file is
 * written only when a record is actually changed (under its lock, and only if
 * the record is still the gateway's `credential_env_missing` one).
 */
import { existsSync } from 'node:fs';
import { wecomRoot } from '../../im/wecom/config/discovery.js';
import {
  readWecomFleetDesiredState,
  updateWecomFleetDesiredState,
  wecomFleetDesiredStatePath,
  type WecomDesiredRecord,
} from '../../im/wecom/config/fleet-desired-state.js';
import { listWecomFleetConnections, type WecomFleetConnection } from '../../im/wecom/config/fleet-members.js';
import { describeWecomStopReason } from '../../im/wecom/contract/stop-reason.js';

export interface CredentialEnvReleaseDeps {
  /** The environment the new supervisor will be started with. */
  env: NodeJS.ProcessEnv;
  desiredStateExists(): boolean;
  readDesired(): ReadonlyMap<string, WecomDesiredRecord> | undefined;
  listConnections(): WecomFleetConnection[];
  /** Locked read-modify-write; `mutate` returning false writes nothing. */
  update(mutate: (records: Map<string, WecomDesiredRecord>) => void | false): void;
  now(): Date;
}

export interface CredentialEnvRelease {
  /** Recorded `running` again: this environment has the variable. */
  released: Array<{ configId: string; member: string; variable: string }>;
  /** Still stopped: the variable is missing here too, or the configuration no longer names one. */
  kept: Array<{ configId: string; member: string; variable?: string }>;
}

/** The `secretEnv` NAME a configuration names, if any. */
function credentialVariable(connection: WecomFleetConnection): string | undefined {
  if (connection.config.presence !== 'present') return undefined;
  try {
    const name = JSON.parse(connection.config.text)?.secretEnv;
    return typeof name === 'string' && name ? name : undefined;
  } catch {
    return undefined;
  }
}

export function releaseCredentialEnvStops(deps: CredentialEnvReleaseDeps): CredentialEnvRelease {
  const outcome: CredentialEnvRelease = { released: [], kept: [] };
  if (!deps.desiredStateExists()) return outcome;
  const records = deps.readDesired();
  if (!records) return outcome;
  const stoppedForIt = [...records].filter(([, record]) => record.desired === 'stopped' && record.reason === 'credential_env_missing');
  if (stoppedForIt.length === 0) return outcome;
  const connections = new Map(deps.listConnections().map(connection => [connection.configId, connection]));
  const toRelease = new Map<string, { member: string; variable: string }>();
  for (const [configId] of stoppedForIt) {
    const connection = connections.get(configId);
    if (!connection) continue;
    const variable = credentialVariable(connection);
    if (variable && deps.env[variable]) {
      toRelease.set(configId, { member: connection.memberName, variable });
    } else {
      outcome.kept.push({ configId, member: connection.memberName, ...(variable ? { variable } : {}) });
    }
  }
  if (toRelease.size === 0) return outcome;
  deps.update(current => {
    // Stamped inside the file's lock, like every other writer: record times follow write order.
    const updatedAt = deps.now().toISOString();
    for (const [configId, release] of toRelease) {
      const record = current.get(configId);
      // Someone changed it since it was read (a person's start or stop): theirs stands.
      if (record?.desired !== 'stopped' || record.reason !== 'credential_env_missing') continue;
      current.set(configId, { desired: 'running', updatedAt });
      outcome.released.push({ configId, ...release });
    }
    if (outcome.released.length === 0) return false;
  });
  return outcome;
}

/** The lines `botmux start` / `botmux restart` print about it (nothing when there is nothing to say). */
export function credentialEnvReleaseLines(outcome: CredentialEnvRelease): { info: string[]; warn: string[] } {
  const info = outcome.released.map(({ member, variable }) =>
    `企业微信连接 ${member}：当前环境里有凭据变量 ${variable}，已解除「凭据环境变量缺失」造成的停止，随 fleet 拉起。`);
  const warn = outcome.kept.map(({ member, variable }) =>
    `⚠️  企业微信连接 ${member} 保持停止：${describeWecomStopReason('credential_env_missing', variable ? { credentialEnv: variable } : {})}`
    + (variable ? '' : '（配置已不再引用环境变量时，执行 `botmux wecom start <configId>` 启动它）'));
  return { info, warn };
}

export function productionCredentialEnvReleaseDeps(env: NodeJS.ProcessEnv = process.env): CredentialEnvReleaseDeps {
  const root = wecomRoot();
  return {
    env,
    desiredStateExists: () => existsSync(wecomFleetDesiredStatePath(root)),
    readDesired: () => {
      const snapshot = readWecomFleetDesiredState(root);
      return snapshot.status === 'ok' ? snapshot.connections : undefined;
    },
    listConnections: () => listWecomFleetConnections(root),
    update: mutate => {
      updateWecomFleetDesiredState(mutate, { root });
    },
    now: () => new Date(),
  };
}
