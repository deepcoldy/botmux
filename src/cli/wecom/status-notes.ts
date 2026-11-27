/**
 * The lines `botmux status` adds under its table for WeCom members that are
 * down because their gateway stopped the connection itself (a recorded reason
 * such as `credential_env_missing` after a boot whose environment lacks the
 * credential variable). The table shows such a member as `errored` with exit
 * code 78; this says why, in the words the Dashboard uses.
 *
 * Only rows of WeCom members that are not running are looked up, so a status
 * without such a row reads no WeCom file at all.
 */
import { wecomRoot } from '../../im/wecom/config/discovery.js';
import { isWecomFleetMemberName } from '../../im/wecom/config/fleet-member-name.js';
import { listWecomFleetConnections, type WecomFleetConnection } from '../../im/wecom/config/fleet-members.js';
import { readWecomFleetDesiredState, type WecomDesiredRecord } from '../../im/wecom/config/fleet-desired-state.js';
import { describeWecomStopReason } from '../../im/wecom/contract/stop-reason.js';

export interface WecomStatusNoteDeps {
  listConnections(): WecomFleetConnection[];
  readDesired(): ReadonlyMap<string, WecomDesiredRecord> | undefined;
}

export function wecomStatusNotes(
  rows: ReadonlyArray<{ name: string; status: string }>,
  deps: WecomStatusNoteDeps,
): string[] {
  const down = rows.filter(row => isWecomFleetMemberName(row.name) && (row.status === 'errored' || row.status === 'stopped'));
  if (down.length === 0) return [];
  let connections: WecomFleetConnection[];
  let records: ReadonlyMap<string, WecomDesiredRecord> | undefined;
  try {
    connections = deps.listConnections();
    records = deps.readDesired();
  } catch {
    return [];
  }
  if (!records) return [];
  const notes: string[] = [];
  for (const row of down) {
    const connection = connections.find(candidate => candidate.memberName === row.name);
    const record = connection ? records.get(connection.configId) : undefined;
    if (!connection || record?.desired !== 'stopped' || !record.reason) continue;
    let credentialEnv: string | undefined;
    if (connection.config.presence === 'present') {
      try {
        const name = JSON.parse(connection.config.text)?.secretEnv;
        credentialEnv = typeof name === 'string' && name ? name : undefined;
      } catch {
        credentialEnv = undefined;
      }
    }
    notes.push(`  ${row.name} 已自行停止：${describeWecomStopReason(record.reason, credentialEnv ? { credentialEnv } : {})}`);
  }
  return notes;
}

export function productionWecomStatusNoteDeps(): WecomStatusNoteDeps {
  const root = wecomRoot();
  return {
    listConnections: () => listWecomFleetConnections(root),
    readDesired: () => {
      const snapshot = readWecomFleetDesiredState(root);
      return snapshot.status === 'ok' ? snapshot.connections : undefined;
    },
  };
}
