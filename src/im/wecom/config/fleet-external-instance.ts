/**
 * Is a WeCom connection's bot already run by an instance the fleet does not
 * run? Then a gateway the fleet starts for it would only wait for the bot's
 * instance lock and stop itself as `instance_busy` (or, past the lock, push the
 * other instance off the BotID). `botmux wecom start|restart` asks this before
 * it records anything, and refuses.
 *
 * The facts, in the order the Dashboard weighs them too: an older Dashboard's
 * gateway still alive, this connection's own fleet member, another
 * configuration of the same bot running, a runtime record of this configuration
 * that is not the fleet member's, and the holder of the bot's instance lock.
 * Both read them through {@link gatherWecomInstanceFacts}: the Dashboard
 * (dashboard/wecom/manager.ts) turns them into the state it shows
 * (connection-state.ts), the CLI into {@link findExternalWecomInstance}'s
 * verdict. So the two cannot disagree about what is on disk and in the process
 * table.
 *
 * Reads files and inspects process birth identities (a `ps` per check on
 * macOS); starts and signals nothing.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  fleetProcessIdentityRuntime,
  type FleetProcessIdentityRuntime,
} from '../../../core/fleet-process-identity.js';
import type { FleetProcState } from '../../../core/fleet-supervisor-policy.js';
import { wecomFleetMemberName } from '../contract/fleet-member.js';
import { inspectWecomProcess, readWecomRuntime, wecomBotRoot, type WecomRuntimeRecord } from './runtime.js';

/** What a process inspection says about a recorded pid and birth identity. */
export type WecomProcessEvidence = 'exact' | 'stale' | 'unverifiable';

type MemberRow = Pick<FleetProcState, 'status' | 'pid' | 'processStart'>;

/** A fleet-state row of a WeCom member: only an online row is inspected; one
 *  without a recorded birth identity cannot be verified. */
export function wecomMemberEvidence(row: MemberRow, runtime: FleetProcessIdentityRuntime = fleetProcessIdentityRuntime): WecomProcessEvidence {
  if (row.status !== 'online') return 'stale';
  if (row.processStart) return inspectWecomProcess({ pid: row.pid, processStart: row.processStart }, runtime).status;
  return row.pid > 1 ? 'unverifiable' : 'stale';
}

/** An older Dashboard's job file for this connection and its gateway's evidence
 *  (undefined: no readable job). */
export function wecomLegacyJobEvidence(
  configId: string,
  root: string,
  runtime: FleetProcessIdentityRuntime = fleetProcessIdentityRuntime,
): WecomProcessEvidence | undefined {
  try {
    const job = JSON.parse(readFileSync(join(root, 'dashboard-jobs', `${configId}.json`), 'utf8'));
    if (job?.version !== 1 || job.configId !== configId || !Number.isSafeInteger(job.pid) || typeof job.processStart !== 'string') {
      return undefined;
    }
    const pidNamespace = typeof job.pidNamespace === 'string' ? job.pidNamespace : undefined;
    return inspectWecomProcess({ pid: job.pid, processStart: job.processStart, pidNamespace }, runtime).status;
  } catch {
    return undefined;
  }
}

/** The holder of the bot's instance lock. A record without a start time is
 *  unverifiable while its pid exists, and nobody once it does not. */
export function wecomInstanceLockEvidence(
  botId: string,
  root: string,
  runtime: FleetProcessIdentityRuntime = fleetProcessIdentityRuntime,
): { evidence: WecomProcessEvidence; pid?: number } {
  const path = join(wecomBotRoot(botId, root), 'instance.lock');
  if (!existsSync(path)) return { evidence: 'stale' };
  let holder: { pid?: unknown; procStart?: unknown; bootId?: unknown };
  try {
    holder = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return { evidence: 'unverifiable' };
  }
  if (typeof holder === 'number') holder = { pid: holder };
  if (!holder || !Number.isSafeInteger(holder.pid) || (holder.pid as number) <= 1) return { evidence: 'unverifiable' };
  const pid = holder.pid as number;
  if (typeof holder.procStart !== 'string' || !holder.procStart) {
    return { evidence: runtime.pidExists(pid) ? 'unverifiable' : 'stale', pid };
  }
  const processStart = typeof holder.bootId === 'string' && holder.bootId ? `${holder.bootId}:${holder.procStart}` : holder.procStart;
  return { evidence: inspectWecomProcess({ pid, processStart }, runtime).status, pid };
}

/** `Row`: what is known of a member row (gatherWecomInstanceFacts hands on the whole fleet-state row). */
export interface WecomInstanceFacts<Row extends MemberRow = MemberRow> {
  configId: string;
  /** This connection's fleet-state row, with its process evidence. */
  member?: { row: Row; process: WecomProcessEvidence };
  /** The bot's runtime record (whichever gateway holds the lock writes it). */
  runtime?: { record: WecomRuntimeRecord; process: WecomProcessEvidence };
  /** Another configuration of the same bot has a gateway running. */
  sameBot?: { evidence: 'running' | 'unverifiable'; configId?: string; pid?: number };
  legacyJob?: WecomProcessEvidence;
  /** Asked last, only when nothing else explains the state. */
  lock(): { evidence: WecomProcessEvidence; pid?: number };
}

export type WecomExternalInstanceSource = 'legacy_gateway' | 'same_bot' | 'terminal_gateway' | 'instance_lock';

export type WecomExternalInstance =
  | { kind: 'none' }
  | { kind: 'external' | 'unverifiable'; source: WecomExternalInstanceSource; pid?: number; configId?: string };

/**
 * The verdict, in the Dashboard's order. `none` as soon as this connection's
 * own fleet member is online: the supervisor knows its own child, so even a
 * member row whose identity this process cannot verify is the fleet's business,
 * not an external instance.
 */
export function findExternalWecomInstance(facts: WecomInstanceFacts): WecomExternalInstance {
  if (facts.legacyJob === 'exact' || facts.legacyJob === 'unverifiable') {
    return { kind: facts.legacyJob === 'exact' ? 'external' : 'unverifiable', source: 'legacy_gateway' };
  }
  if (facts.member && facts.member.row.status === 'online' && facts.member.process !== 'stale') {
    return { kind: 'none' };
  }
  if (facts.sameBot) {
    return {
      kind: facts.sameBot.evidence === 'running' ? 'external' : 'unverifiable',
      source: 'same_bot',
      ...(facts.sameBot.pid !== undefined ? { pid: facts.sameBot.pid } : {}),
      ...(facts.sameBot.configId ? { configId: facts.sameBot.configId } : {}),
    };
  }
  const runtime = facts.runtime;
  if (runtime && runtime.record.configId === facts.configId && runtime.record.phase !== 'stopped' && runtime.process !== 'stale') {
    return { kind: runtime.process === 'exact' ? 'external' : 'unverifiable', source: 'terminal_gateway', pid: runtime.record.pid };
  }
  const lock = facts.lock();
  if (lock.evidence !== 'stale') {
    return {
      kind: lock.evidence === 'exact' ? 'external' : 'unverifiable',
      source: 'instance_lock',
      ...(lock.pid !== undefined ? { pid: lock.pid } : {}),
    };
  }
  return { kind: 'none' };
}

/** The `botId` of a configuration file's text (undefined when it has none). */
export function wecomConfigBotId(configText: string): string | undefined {
  try {
    const botId = JSON.parse(configText)?.botId;
    return typeof botId === 'string' && botId ? botId : undefined;
  } catch {
    return undefined;
  }
}

export interface WecomInstanceFactsInput {
  root: string;
  configId: string;
  botId: string;
  /** Every registered connection whose configuration could be read. */
  connections: ReadonlyArray<{ configId: string; botId: string }>;
  /** The fleet-state rows by name. */
  rows: ReadonlyMap<string, FleetProcState>;
  runtime?: FleetProcessIdentityRuntime;
  /**
   * Member process evidence already inspected, by member name, and filled in as
   * members are inspected. A caller gathering the facts of several connections
   * at once (the Dashboard's list) passes one map, so each member's process is
   * inspected once however many connections share its bot.
   */
  memberEvidence?: Map<string, WecomProcessEvidence>;
}

/** Gather the facts for one connection (`botmux wecom start|restart` and the Dashboard's list). */
export function gatherWecomInstanceFacts(input: WecomInstanceFactsInput): WecomInstanceFacts<FleetProcState> {
  const identity = input.runtime ?? fleetProcessIdentityRuntime;
  const memberOf = (configId: string): WecomInstanceFacts<FleetProcState>['member'] => {
    const name = wecomFleetMemberName(configId);
    const row = input.rows.get(name);
    if (!row) return undefined;
    let process = input.memberEvidence?.get(name);
    if (!process) {
      process = wecomMemberEvidence(row, identity);
      input.memberEvidence?.set(name, process);
    }
    return { row, process };
  };
  const record = readWecomRuntime(input.botId, input.root);
  const runtime = record
    ? { record, process: record.phase === 'stopped' ? 'stale' as const : inspectWecomProcess(record, identity).status }
    : undefined;
  let sameBot: WecomInstanceFacts['sameBot'];
  for (const other of input.connections) {
    if (other.configId === input.configId || other.botId !== input.botId) continue;
    const member = memberOf(other.configId);
    if (member?.row.status === 'online' && member.process === 'exact') {
      sameBot = { evidence: 'running', configId: other.configId, pid: member.row.pid };
    } else if (member?.row.status === 'online' && member.process === 'unverifiable') {
      sameBot ??= { evidence: 'unverifiable', configId: other.configId, pid: member.row.pid };
    }
  }
  if (runtime && runtime.record.configId !== input.configId && runtime.process !== 'stale') {
    sameBot = runtime.process === 'exact'
      ? { evidence: 'running', configId: runtime.record.configId, pid: runtime.record.pid }
      : sameBot ?? { evidence: 'unverifiable', configId: runtime.record.configId, pid: runtime.record.pid };
  }
  const legacyJob = existsSync(join(input.root, 'dashboard-jobs'))
    ? wecomLegacyJobEvidence(input.configId, input.root, identity)
    : undefined;
  return {
    configId: input.configId,
    member: memberOf(input.configId),
    runtime,
    ...(sameBot ? { sameBot } : {}),
    ...(legacyJob ? { legacyJob } : {}),
    lock: () => wecomInstanceLockEvidence(input.botId, input.root, identity),
  };
}
