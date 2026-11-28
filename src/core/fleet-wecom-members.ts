/**
 * WeCom connections as fleet members. Each connection whose desired state is
 * `running` becomes one external member that runs `botmux wecom --config <file>`
 * (the gateway, which starts its own core). Without any WeCom configuration this
 * resolves to no members, so the fleet is exactly the Feishu bots + Dashboard.
 *
 * The command goes through resolveCliSpawn, so the gateway runs in the same
 * shape as the supervisor itself: `node|bun <dist>/cli.js`, the compiled binary
 * re-executing itself, or `bun <src>/cli.js` (Bun runs the sibling `cli.ts`)
 * when the supervisor runs from source.
 */
import { dirname, join } from 'node:path';
import type { FleetBotSpec, FleetGroupResolution, FleetMemberIntent } from './fleet-supervisor.js';
import type { ExternalRestartPolicy } from './fleet-supervisor-policy.js';
import { resolveCliSpawn } from './self-spawn.js';
import { WECOM_GATEWAY_KILL_TIMEOUT_MS } from '../im/wecom/config/gateway-budgets.js';
import { readWecomFleetDesiredState, type WecomDesiredRecord } from '../im/wecom/config/fleet-desired-state.js';
import {
  listWecomFleetConnections,
  wecomFleetConfigHash,
  wecomFleetMemberEnvFromDotEnv,
  type WecomFleetConnection,
} from '../im/wecom/config/fleet-members.js';
import { inspectWecomProcess, readWecomRuntime } from '../im/wecom/config/runtime.js';
import {
  WECOM_FLEET_MEMBER_ENV,
  WECOM_GATEWAY_NO_RESTART_EXIT_CODE,
} from '../im/wecom/contract/fleet-member.js';

/**
 * Restart policy of a gateway member: no restart after the gateway's
 * no-restart exit code (replaced by another instance, rejected credentials,
 * invalid configuration, instance lock held outside the fleet); every other exit
 * is retried from 2 s doubling up to 60 s, and an exit after 5 minutes of
 * service starts again at 2 s.
 *
 * Why these numbers: a gateway already rides out a network outage itself — it
 * reconnects internally and exits (retryably) only after about 3–5 minutes of
 * failing — so the supervisor's delay only spaces out those exits and never
 * needs to be long; one launch (gateway + core ready) costs about a second, so
 * 2 s does not thrash. The 200 ms fleet-wide delay and its 10-restart park
 * would instead give up on a connection for good after one long outage.
 */
export const WECOM_GATEWAY_RESTART_POLICY: ExternalRestartPolicy = {
  noRestartExitCodes: [WECOM_GATEWAY_NO_RESTART_EXIT_CODE],
  initialDelayMs: 2_000,
  maxDelayMs: 60_000,
  stableRunMs: 5 * 60_000,
};

export interface WecomFleetMemberOptions {
  /** dist/ (or src/) directory the supervisor itself runs from. */
  distDir: string;
  /** The base env every member gets from the supervisor. */
  baseEnv: NodeJS.ProcessEnv;
  /** Reads ~/.botmux/.env (undefined when absent / unreadable). Called only
   *  when there is a member to build, so a host without a running WeCom
   *  connection does not read the file at all. */
  readEnvFileText: () => string | undefined;
  /** WeCom root (~/.botmux/wecom); tests only. */
  wecomRoot?: string;
  /** The connections to resolve, instead of reading them from `wecomRoot`;
   *  tests only (shapes the registry cannot produce on demand). */
  connections?: readonly WecomFleetConnection[];
  /** The desired-state records that go with `connections`; tests only. */
  desiredRecords?: ReadonlyMap<string, WecomDesiredRecord>;
}

/**
 * The recorded intent of every connection, by member name (the first
 * connection that takes a name, as for membership). Read once more, after the
 * listing, so a command is checked against the newest record. Nothing is read
 * without connections; a record whose time cannot be read gives no intent.
 */
function connectionIntents(
  connections: readonly WecomFleetConnection[],
  options: WecomFleetMemberOptions,
): Map<string, FleetMemberIntent> {
  const intents = new Map<string, FleetMemberIntent>();
  if (connections.length === 0) return intents;
  let records = options.desiredRecords;
  if (!records && !options.connections) {
    const snapshot = readWecomFleetDesiredState(options.wecomRoot);
    records = snapshot.status === 'ok' ? snapshot.connections : undefined;
  }
  if (!records) return intents;
  for (const connection of connections) {
    if (intents.has(connection.memberName)) continue;
    const record = records.get(connection.configId);
    const recordedAt = record ? Date.parse(record.updatedAt) : Number.NaN;
    if (!record || !Number.isFinite(recordedAt)) continue;
    intents.set(connection.memberName, {
      desired: record.desired,
      recordedAt,
      automatic: record.reason !== undefined,
    });
  }
  return intents;
}

/**
 * The pid of a connection's gateway that reports, in its bot's runtime record,
 * that it is shutting down (phase `stopping`, or `stopped` while still alive).
 * Only a record of this very connection whose process identity verifies counts.
 */
function shuttingDownGatewayPid(configId: string, configText: string, wecomRoot?: string): number | undefined {
  let botId: unknown;
  try {
    botId = JSON.parse(configText)?.botId;
  } catch {
    return undefined;
  }
  if (typeof botId !== 'string' || !botId) return undefined;
  const record = readWecomRuntime(botId, wecomRoot);
  if (!record || record.configId !== configId) return undefined;
  if (record.phase !== 'stopping' && record.phase !== 'stopped') return undefined;
  return inspectWecomProcess(record).status === 'exact' ? record.pid : undefined;
}

/**
 * Resolve the WeCom member group:
 *  - desired `running` and the configuration file present → a member;
 *  - desired `running` but the file unreadable right now → indeterminate (a
 *    running gateway is left alone, a stopped one is not started);
 *  - desired `stopped`, `unrecorded`, or the file deleted → not a member.
 * Along with them: each connection's recorded intent, and the members whose
 * gateway is shutting itself down (see FleetGroupResolution).
 * Throws when the registry or the desired-state file cannot be trusted.
 */
export function resolveWecomFleetMembers(options: WecomFleetMemberOptions): FleetGroupResolution & { notes: string[] } {
  const connections = options.connections ?? listWecomFleetConnections(options.wecomRoot);
  let env: Record<string, string> | undefined;
  const members: FleetBotSpec[] = [];
  const indeterminate: string[] = [];
  const notes: string[] = [];
  const shuttingDown = new Map<string, number>();
  const taken = new Set<string>();
  for (const connection of connections) {
    if (connection.desired !== 'running') continue;
    if (connection.config.presence === 'missing') continue;
    if (taken.has(connection.memberName)) {
      // Two configuration paths whose ids share the 12 hex digits of the name.
      notes.push(`${connection.memberName}: skipped ${connection.file}, the name is already used by another connection`);
      continue;
    }
    taken.add(connection.memberName);
    if (connection.config.presence === 'unreadable') {
      indeterminate.push(connection.memberName);
      notes.push(`${connection.memberName}: ${connection.file} is unreadable (${connection.config.reason}); left as it is`);
      continue;
    }
    env ??= wecomFleetMemberEnvFromDotEnv(options.readEnvFileText(), options.baseEnv);
    const { command, args } = resolveCliSpawn(
      join(options.distDir, 'cli.js'),
      ['wecom', '--config', connection.file],
    );
    members.push({
      name: connection.memberName,
      appId: '',
      botIndex: -1,
      logBaseName: connection.memberName,
      group: 'wecom',
      external: {
        command,
        args,
        cwd: dirname(connection.file),
        env: { ...env, [WECOM_FLEET_MEMBER_ENV]: '1' },
        configHash: wecomFleetConfigHash(connection.config.text),
        killTimeoutMs: WECOM_GATEWAY_KILL_TIMEOUT_MS,
        restartPolicy: WECOM_GATEWAY_RESTART_POLICY,
      },
    });
    const stoppingPid = shuttingDownGatewayPid(connection.configId, connection.config.text, options.wecomRoot);
    if (stoppingPid !== undefined) shuttingDown.set(connection.memberName, stoppingPid);
  }
  return { members, indeterminate, notes, intents: connectionIntents(connections, options), shuttingDown };
}
