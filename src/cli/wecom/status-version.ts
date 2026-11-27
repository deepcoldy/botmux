/**
 * The VERSION cell `botmux status` shows for a WeCom member row: the botmux
 * version its gateway wrote into its runtime record (im/wecom/config/runtime.ts).
 *
 * Shown only when the record is evidently the row's own process: the row's pid
 * is alive, the record is this connection's, names the same pid, is fresh, does
 * not say the gateway stopped, and that pid is still the process born at the
 * record's processStart. Anything else — no record, a record from before the
 * version was recorded, a stale one, another pid — shows `-`: a version that may
 * belong to the previous generation would hide that the running one differs.
 *
 * These versions stay out of the hint under the table about daemons running
 * another version: that hint counts Feishu daemons. Only WeCom member rows are
 * looked up, so a status without one reads no WeCom file.
 */
import { wecomRoot } from '../../im/wecom/config/discovery.js';
import { wecomConfigBotId } from '../../im/wecom/config/fleet-external-instance.js';
import { isWecomFleetMemberName } from '../../im/wecom/config/fleet-member-name.js';
import { listWecomFleetConnections, type WecomFleetConnection } from '../../im/wecom/config/fleet-members.js';
import {
  inspectWecomProcess,
  isFreshWecomRuntime,
  readWecomRuntime,
  type WecomRuntimeRecord,
} from '../../im/wecom/config/runtime.js';

export interface WecomMemberVersionDeps {
  listConnections(): WecomFleetConnection[];
  readRuntime(botId: string): WecomRuntimeRecord | undefined;
  /** Whether the record's pid is still the process born at its processStart. */
  isSameProcess(record: WecomRuntimeRecord): boolean;
  now(): number;
}

/** Version per WeCom member row name, for the rows whose gateway shows one. */
export function wecomMemberVersions(
  rows: ReadonlyArray<{ name: string; pid: number; alive: boolean }>,
  deps: WecomMemberVersionDeps,
): Map<string, string> {
  const versions = new Map<string, string>();
  const live = rows.filter(row => isWecomFleetMemberName(row.name) && row.pid > 0 && row.alive);
  if (live.length === 0) return versions;
  let connections: WecomFleetConnection[];
  try {
    connections = deps.listConnections();
  } catch {
    return versions;
  }
  for (const row of live) {
    const connection = connections.find(candidate => candidate.memberName === row.name);
    if (!connection || connection.config.presence !== 'present') continue;
    const botId = wecomConfigBotId(connection.config.text);
    const record = botId ? deps.readRuntime(botId) : undefined;
    if (!record
      || typeof record.botmuxVersion !== 'string'
      || !record.botmuxVersion
      || record.configId !== connection.configId
      || record.pid !== row.pid
      || record.phase === 'stopped'
      || !isFreshWecomRuntime(record, deps.now())
      || !deps.isSameProcess(record)) {
      continue;
    }
    versions.set(row.name, record.botmuxVersion);
  }
  return versions;
}

export function productionWecomMemberVersionDeps(): WecomMemberVersionDeps {
  const root = wecomRoot();
  return {
    listConnections: () => listWecomFleetConnections(root),
    readRuntime: botId => readWecomRuntime(botId, root),
    isSameProcess: record => inspectWecomProcess(record).status === 'exact',
    now: Date.now,
  };
}
