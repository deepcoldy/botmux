/**
 * Synchronous hc operations for daemon-side code that has no worker to ask
 * (restore sweeps, /close of a worker-less session, orphan reaping).
 *
 * Each call spawns the discovered binary with the control env. A core that is
 * not running gets started by hc itself, from that clean env, so a missing
 * terminal is an authoritative answer; anything that yields no answer from hc
 * is unknown. A core with neither a socket nor a holder runs nothing, and hc
 * is not run for it at all: a core started from a CLI's or a stale target's
 * call would hand that env to every later program.
 */
import type { PersistentBackendTarget, SessionProbe } from '../types.js';
import { hcCoreAbsent, hcCoreAddress, hcCorePaths, type HcCoreAddress } from './core.js';
import { prepareHcSyncCore, runHcSync, type HcSyncCore } from './sync-rpc.js';
import { asHcTerminalRecord } from './types.js';

/** A terminal by name (`bmx-<sid8>`) on the core it was created on. */
export type HcTarget = Extract<PersistentBackendTarget, { backendType: 'hc' }>;

/** The terminal name of a session: unique among live terminals of a core, not an owner. */
export function hcTerminalName(sessionId: string): string {
  return `bmx-${sessionId.slice(0, 8)}`;
}

/** The session's parked crash-diagnostic shell: `bmx-diag-<sid8>` on its own core. */
export function hcDiagnosticTarget(target: HcTarget, sessionId: string): HcTarget {
  return { ...target, sessionName: `bmx-diag-${sessionId.slice(0, 8)}` };
}

export interface HcOpsOptions {
  /** The daemon's or worker's own env (never a CLI child env); defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

const HC_CLI_TIMEOUT_MS = 5_000;
/** hc's kill escalates HUP, TERM, KILL with 0.5 s, 0.5 s and 2 s waits. */
const HC_KILL_TIMEOUT_MS = 10_000;
/** `terminal.list --all` keeps up to 500 finished records of ~1 KiB each. */
const HC_CLI_MAX_BUFFER = 8 * 1024 * 1024;

/** Set on every botmux terminal at run; checked before kill, rm or reattach. */
export function hcOwnerLabels(sessionId: string): Record<string, string> {
  return { botmux: '1', botmux_sid: sessionId };
}

export function isHcTerminalOwnedBy(labels: Record<string, string> | undefined, sessionId: string): boolean {
  return Object.entries(hcOwnerLabels(sessionId)).every(([key, value]) => labels?.[key] === value);
}

/** `kind` is hc's error kind (not_found, live, unavailable, ...), null when hc gave no answer. */
type HcCliReply =
  | { ok: true; value: unknown }
  | { ok: false; kind: string | null; message: string };

/** hc was not run: {@link hcCoreAbsent}. */
const HC_NO_CORE = 'botmux_no_core';

function runHcCli(
  core: HcCoreAddress,
  args: string[],
  opts: HcOpsOptions,
  call: { timeoutMs: number; input?: string },
): HcCliReply {
  let prepared: HcSyncCore;
  try {
    prepared = prepareHcSyncCore(core, opts.env ?? process.env);
  } catch (err) {
    return { ok: false, kind: null, message: err instanceof Error ? err.message : String(err) };
  }
  if (hcCoreAbsent(prepared.socket)) {
    return { ok: false, kind: HC_NO_CORE, message: `hc core 未运行（${prepared.socket}）` };
  }
  const ran = runHcSync(prepared, args, call.input, opts.timeoutMs ?? call.timeoutMs, HC_CLI_MAX_BUFFER);
  if (!ran.ok) return ran;
  try {
    return { ok: true, value: JSON.parse(ran.stdout) };
  } catch {
    return { ok: false, kind: null, message: `hc ${args.filter(arg => arg !== '--json').join(' ')} 的输出无法解析` };
  }
}

/** live is exists; finished or no such name is missing; no answer from hc is unknown. */
export function probeHcTerminal(target: HcTarget, opts: HcOpsOptions = {}): SessionProbe {
  const reply = runHcCli(target, ['--json', 'get', target.sessionName], opts, { timeoutMs: HC_CLI_TIMEOUT_MS });
  if (!reply.ok) return reply.kind === 'not_found' || reply.kind === HC_NO_CORE ? 'missing' : 'unknown';
  const record = asHcTerminalRecord(reply.value);
  if (!record || record.name !== target.sessionName) return 'unknown';
  return record.state === 'live' ? 'exists' : 'missing';
}

/**
 * {@link probeHcTerminal} for many names on one core, from one `ls --all`.
 * Every name is unknown when the listing fails or has a row it cannot read:
 * that row could be the live holder of any of them.
 */
export function probeHcTerminals(
  core: HcCoreAddress,
  names: Iterable<string>,
  opts: HcOpsOptions = {},
): ReadonlyMap<string, SessionProbe> {
  const wanted = [...new Set(names)];
  const result = new Map<string, SessionProbe>();
  if (wanted.length === 0) return result;
  const reply = runHcCli(core, ['--json', 'ls', '--all'], opts, { timeoutMs: HC_CLI_TIMEOUT_MS });
  const rows = reply.ok
    ? (reply.value as { terminals?: unknown } | null)?.terminals
    : reply.kind === HC_NO_CORE ? [] : undefined;
  const live = new Set<string>();
  let readable = Array.isArray(rows);
  for (const row of Array.isArray(rows) ? rows : []) {
    const record = asHcTerminalRecord(row);
    if (!record) {
      readable = false;
      break;
    }
    // `machine/t7` rows are other machines' terminals; names resolve locally.
    if (record.state === 'live' && !record.address.includes('/') && typeof record.name === 'string') {
      live.add(record.name);
    }
  }
  for (const name of wanted) result.set(name, !readable ? 'unknown' : live.has(name) ? 'exists' : 'missing');
  return result;
}

export type HcKillOutcome =
  /** It was running: its program ended and its record is gone. */
  | { result: 'killed'; address: string }
  /** It had already finished: its record is gone. */
  | { result: 'removed'; address: string }
  | { result: 'missing' }
  /** Another session's terminal (or not botmux's) holds the name: left alone. */
  | { result: 'mismatch'; address: string; owner: string | null }
  | { result: 'unknown'; reason: string };

/**
 * End and remove the terminal named `target.sessionName`, only after its labels
 * prove it is `sessionId`'s: after hc loses its state, names (and ids) can be
 * taken again by other terminals. Works by address once resolved.
 */
export function killHcTerminal(target: HcTarget, sessionId: string, opts: HcOpsOptions = {}): HcKillOutcome {
  if (!sessionId) return { result: 'unknown', reason: 'hc 终端删除需要完整的会话 id' };
  const got = runHcCli(target, ['--json', 'get', target.sessionName], opts, { timeoutMs: HC_CLI_TIMEOUT_MS });
  if (!got.ok) {
    return got.kind === 'not_found' || got.kind === HC_NO_CORE ? { result: 'missing' } : { result: 'unknown', reason: got.message };
  }
  const record = asHcTerminalRecord(got.value);
  if (!record || record.name !== target.sessionName) {
    return { result: 'unknown', reason: `hc get ${target.sessionName} 返回了无法识别的记录` };
  }
  if (!isHcTerminalOwnedBy(record.labels, sessionId)) {
    return { result: 'mismatch', address: record.address, owner: record.labels?.botmux_sid ?? null };
  }

  const wasLive = record.state === 'live';
  if (wasLive) {
    const killed = runHcCli(target, ['--json', 'kill', record.address], opts, { timeoutMs: HC_KILL_TIMEOUT_MS });
    if (!killed.ok) return killed.kind === 'not_found' ? { result: 'missing' } : { result: 'unknown', reason: killed.message };
    const after = asHcTerminalRecord(killed.value);
    if (!after || !isHcTerminalOwnedBy(after.labels, sessionId)) {
      return { result: 'unknown', reason: `hc 终端 ${record.address} 在删除期间变成了别的终端` };
    }
  }
  const removed = runHcCli(target, ['--json', 'rm', record.address], opts, { timeoutMs: HC_CLI_TIMEOUT_MS });
  if (!removed.ok && removed.kind !== 'not_found') return { result: 'unknown', reason: removed.message };
  return { result: wasLive ? 'killed' : 'removed', address: record.address };
}

export interface HcTerminalEntry {
  address: string;
  name: string | null;
  /** `labels.botmux_sid`. */
  sessionId: string | null;
  state: 'live' | 'finished';
  pid: number | null;
  exitCode: number | null;
  signal: number | null;
  reason: string | null;
}

export type HcTerminalListing =
  | { ok: true; terminals: HcTerminalEntry[] }
  | { ok: false; reason: string };

/**
 * Every terminal labelled `botmux=1`, live or finished, on the given core
 * (default: this env's botmux core). This is `hc ls --all --label botmux=1`
 * through `hc connect`, because `ls --json` drops the labels that carry the
 * owning session id.
 */
export function listBotmuxHcTerminals(core?: HcCoreAddress, opts: HcOpsOptions = {}): HcTerminalListing {
  let address = core;
  if (!address) {
    try {
      address = hcCoreAddress(hcCorePaths(opts.env ?? process.env));
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
  }
  const request = {
    jsonrpc: '2.0',
    id: 1,
    method: 'terminal.list',
    params: { all: true, labels: { botmux: '1' } },
  };
  const reply = runHcCli(address, ['connect'], opts, {
    timeoutMs: HC_CLI_TIMEOUT_MS,
    input: `${JSON.stringify(request)}\n`,
  });
  if (!reply.ok) return reply.kind === HC_NO_CORE ? { ok: true, terminals: [] } : { ok: false, reason: reply.message };
  const rpc = reply.value as { result?: { terminals?: unknown }; error?: { message?: unknown } } | null;
  if (rpc?.error) {
    return { ok: false, reason: `hc terminal.list：${typeof rpc.error.message === 'string' ? rpc.error.message : 'refused'}` };
  }
  if (!Array.isArray(rpc?.result?.terminals)) return { ok: false, reason: 'hc terminal.list 的应答缺少 terminals' };
  const terminals: HcTerminalEntry[] = [];
  for (const item of rpc.result.terminals) {
    const record = asHcTerminalRecord(item);
    // `machine/t7` rows come from other machines' cores.
    if (!record || record.address.includes('/') || record.labels?.botmux !== '1') continue;
    terminals.push({
      address: record.address,
      name: record.name ?? null,
      sessionId: record.labels.botmux_sid ?? null,
      state: record.state,
      pid: record.pid ?? null,
      exitCode: record.exit_code ?? null,
      signal: record.signal ?? null,
      reason: record.reason ?? null,
    });
  }
  return { ok: true, terminals };
}

export interface HcBotmuxTerminal {
  /** `labels.botmux_sid`, the owner: a daemon may end it only for a session id of its own. */
  sessionId: string;
  /** For {@link killHcTerminal} with `sessionId`, which checks the labels again. */
  target: HcTarget;
  address: string;
  state: 'live' | 'finished';
}

export interface HcBotmuxTerminalSweep {
  terminals: HcBotmuxTerminal[];
  /** Cores that gave no listing: their terminals are unaccounted for, not absent. */
  failures: Array<{ core: HcCoreAddress; reason: string }>;
}

/**
 * Every named botmux terminal with an owning session id on each of `cores`
 * (one listing per core). Terminals without a name or `botmux_sid` are left
 * out: nothing could prove whose they are.
 */
export function collectBotmuxHcTerminals(
  cores: Iterable<HcCoreAddress>,
  opts: HcOpsOptions = {},
): HcBotmuxTerminalSweep {
  const unique = new Map<string, HcCoreAddress>();
  for (const core of cores) {
    const key = JSON.stringify([core.hcSession, core.socket]);
    if (!unique.has(key)) unique.set(key, { hcSession: core.hcSession, socket: core.socket });
  }
  const sweep: HcBotmuxTerminalSweep = { terminals: [], failures: [] };
  for (const core of unique.values()) {
    const listing = listBotmuxHcTerminals(core, opts);
    if (!listing.ok) {
      sweep.failures.push({ core, reason: listing.reason });
      continue;
    }
    for (const entry of listing.terminals) {
      if (!entry.name || !entry.sessionId) continue;
      sweep.terminals.push({
        sessionId: entry.sessionId,
        target: { backendType: 'hc', sessionName: entry.name, hcSession: core.hcSession, socket: core.socket },
        address: entry.address,
        state: entry.state,
      });
    }
  }
  return sweep;
}
