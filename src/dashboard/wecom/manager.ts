/**
 * The Dashboard's view of the WeCom connections, and its start / stop / restart.
 *
 * A connection's gateway is a member of the fleet (`wecom-<id12>`): the
 * supervisor runs it while the connection's desired state is `running`. This
 * module is a client of that arrangement — it never spawns a gateway, never
 * signals a process, and never writes the desired state itself:
 *
 *  - state: read from the desired-state record, the member's fleet-state row
 *    and the bot's runtime record, and decided in connection-state.ts. What
 *    runs the bot (this connection's member, another configuration of the same
 *    bot, a terminal gateway, an older Dashboard's gateway, the instance lock's
 *    holder) is gathered by the same code `botmux wecom start|restart` refuses
 *    on (config/fleet-external-instance.ts);
 *  - actions: `botmux wecom <action> <configId> --json` (lifecycle-cli.ts),
 *    which records the desired state and asks the supervisor under the fleet
 *    mutation lock. The HTTP request does not wait for it: the action shows as
 *    in progress, and its result appears in later lists. One action per
 *    connection at a time; a failed action's reason stays visible until the
 *    next action or until the connection's state changes.
 *
 * Actions in progress and failures live in this process only. If the Dashboard
 * goes away mid-action, the command it started keeps running (see
 * lifecycle-cli.ts); a restarted Dashboard shows the state the command leaves
 * behind, without the "in progress" marker.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fleetStatePath } from '../../core/fleet-runtime.js';
import { readFleetState } from '../../core/fleet-state-store.js';
import {
  fleetProcessIdentityRuntime,
  inspectSupervisorState,
  type FleetProcessIdentityRuntime,
} from '../../core/fleet-process-identity.js';
import type { FleetProcState, FleetState } from '../../core/fleet-supervisor-policy.js';
import { parseWecomConfig, type WecomConfig } from '../../im/wecom/config/config.js';
import { readWecomConfigPaths, wecomConfigId, wecomRoot } from '../../im/wecom/config/discovery.js';
import { readWecomFleetDesiredState, type WecomDesiredStateSnapshot } from '../../im/wecom/config/fleet-desired-state.js';
import { gatherWecomInstanceFacts, type WecomProcessEvidence } from '../../im/wecom/config/fleet-external-instance.js';
import { wecomFleetConfigHash } from '../../im/wecom/config/fleet-members.js';
import type { WecomConnectionAction, WecomConnectionDto } from '../../im/wecom/contract/dashboard-dto.js';
import {
  deriveWecomConnectionState,
  wecomStateFingerprint,
  withWecomOperation,
  type WecomConnectionFacts,
  type WecomConnectionState,
} from './connection-state.js';
import { runWecomLifecycleCli, type WecomLifecycleHooks, type WecomLifecycleOutcome } from './lifecycle-cli.js';

interface Loaded {
  id: string;
  file: string;
  text: string;
  config: WecomConfig;
}

interface Operation {
  action: WecomConnectionAction;
  startedAt: number;
  settled?: Promise<WecomLifecycleOutcome>;
  onSpawn?: (pid: number) => void;
}

interface Failure {
  action: WecomConnectionAction;
  reason: string;
  message: string;
  at: number;
  /** The connection's state right after the action ended; any other state ends the display. */
  fingerprint?: string;
}

/** Everything read once per list, shared by every connection. */
interface FleetView {
  registry: 'ok' | 'unavailable';
  desired: WecomDesiredStateSnapshot;
  supervisor: WecomConnectionFacts['supervisor'];
  rows: ReadonlyMap<string, FleetProcState>;
  /** Member process evidence, inspected at most once per list. */
  evidence: Map<string, WecomProcessEvidence>;
  /** The process table as this list sees it (see {@link settledProcessRuntime}). */
  processes: FleetProcessIdentityRuntime;
  now: number;
}

/**
 * One list's view of the gateway processes, over `runtime`. The usual running
 * connection names one gateway twice — its runtime record and its fleet member
 * row carry the same pid and birth identity — and each was inspected on its own.
 *
 * An inspection reads a pid's birth identity, then its pid namespace, then the
 * birth identity again, and believes only what both identity reads agree on, so
 * a pid recycled between them is caught. Here, once two consecutive identity
 * reads of a pid agree with a namespace read between them, that pid is settled
 * for the rest of the list: later inspections of it are answered from those
 * reads instead of reading again. What they conclude is exactly what the
 * settling inspection's own reads support — a birth identity and a namespace
 * that belong to one process — so the recycle check is not weakened: reads that
 * disagree settle nothing, and every later inspection of that pid reads afresh.
 * Command lines and pid existence are always read. Nothing outlives the list,
 * so a start or stop shows in the next list as before.
 */
function settledProcessRuntime(runtime: FleetProcessIdentityRuntime): FleetProcessIdentityRuntime {
  const settled = new Map<number, { identity: string; namespace: string | undefined }>();
  /** The last identity read of a pid not yet settled, and the namespace read after it, if any. */
  const open = new Map<number, { identity: string; namespace?: { value: string | undefined } }>();
  return {
    readIdentity(pid) {
      const known = settled.get(pid);
      if (known) {
        return known.identity;
      }
      const identity = runtime.readIdentity(pid);
      const previous = open.get(pid);
      if (identity && previous?.namespace && previous.identity === identity) {
        settled.set(pid, { identity, namespace: previous.namespace.value });
        open.delete(pid);
      } else if (identity) {
        open.set(pid, { identity });
      } else {
        open.delete(pid);
      }
      return identity;
    },
    readPidNamespace(pid) {
      const known = settled.get(pid);
      if (known) {
        return known.namespace;
      }
      const value = runtime.readPidNamespace(pid);
      const previous = open.get(pid);
      if (previous) {
        previous.namespace = { value };
      }
      return value;
    },
    readCommandLine: pid => runtime.readCommandLine(pid),
    pidExists: pid => runtime.pidExists(pid),
  };
}

/** The bot of every connection whose configuration could be read (same-bot detection). */
type BotOfConnection = { configId: string; botId: string };

export interface WecomDashboardManagerOptions {
  root?: string;
  runtime?: FleetProcessIdentityRuntime;
  now?: () => number;
  /** Reads the fleet's state file; tests inject their own. */
  readFleetState?: () => FleetState | null;
  /** Runs one action; production spawns `botmux wecom <action> <id> --json`. */
  runLifecycle?: (action: WecomConnectionAction, configId: string, hooks?: WecomLifecycleHooks) => Promise<WecomLifecycleOutcome>;
}

export class WecomDashboardManager {
  private readonly root: string;
  private readonly runtime: FleetProcessIdentityRuntime;
  private readonly now: () => number;
  private readonly operations = new Map<string, Operation>();
  private readonly failures = new Map<string, Failure>();

  constructor(private readonly options: WecomDashboardManagerOptions = {}) {
    this.root = options.root ?? wecomRoot();
    this.runtime = options.runtime ?? fleetProcessIdentityRuntime;
    this.now = options.now ?? Date.now;
  }

  private load(file: string): Loaded | undefined {
    try {
      const text = readFileSync(file, 'utf8');
      return { id: wecomConfigId(file), file, text, config: parseWecomConfig(JSON.parse(text)) };
    } catch {
      return undefined;
    }
  }

  private fleetView(): FleetView {
    let registry: FleetView['registry'] = 'ok';
    try {
      readWecomConfigPaths(this.root, true);
    } catch {
      registry = 'unavailable';
    }
    const state = (this.options.readFleetState ?? (() => readFleetState(fleetStatePath())))();
    let supervisor: FleetView['supervisor'] = 'down';
    if (state && state.supervisorPid > 1) {
      const inspection = inspectSupervisorState(state, this.runtime).status;
      supervisor = inspection === 'exact' ? 'live' : inspection === 'unverifiable' ? 'unverifiable' : 'down';
    }
    return {
      registry,
      desired: readWecomFleetDesiredState(this.root),
      supervisor,
      rows: new Map((state?.procs ?? []).map(row => [row.name, row])),
      evidence: new Map(),
      processes: settledProcessRuntime(this.runtime),
      now: this.now(),
    };
  }

  private facts(loaded: Loaded, bots: readonly BotOfConnection[], view: FleetView): WecomConnectionFacts {
    const instance = gatherWecomInstanceFacts({
      root: this.root,
      configId: loaded.id,
      botId: loaded.config.botId,
      connections: bots,
      rows: view.rows,
      runtime: view.processes,
      memberEvidence: view.evidence,
    });
    const desired = view.desired;
    const desiredRecord = desired.status === 'ok' ? desired.connections.get(loaded.id) : undefined;
    return {
      id: loaded.id,
      configHash: wecomFleetConfigHash(loaded.text),
      registry: view.registry,
      desired: desired.status === 'ok'
        ? { status: 'ok', ...(desiredRecord ? { record: desiredRecord } : {}) }
        : { status: 'unavailable' },
      supervisor: view.supervisor,
      member: instance.member,
      runtime: instance.runtime,
      sameBot: instance.sameBot?.evidence,
      legacyJob: instance.legacyJob,
      lock: () => instance.lock().evidence,
      ...(loaded.config.secretEnv ? { credentialEnv: loaded.config.secretEnv } : {}),
      now: view.now,
    };
  }

  private render(loaded: Loaded, state: WecomConnectionState): WecomConnectionDto {
    const { config, id, file } = loaded;
    const failure = this.failures.get(id);
    if (failure?.fingerprint !== undefined && failure.fingerprint !== wecomStateFingerprint(state)) {
      this.failures.delete(id);
    }
    const shownFailure = this.failures.get(id);
    return {
      id,
      label: config.displayName || (file === join(this.root, 'config.json') ? '企业微信机器人' : '企业微信机器人（自定义配置）'),
      botIdHint: `…${config.botId.slice(-6)}`,
      allowedUserCount: config.allowedUsers.length,
      coreMode: config.managedCore ? 'managed' : 'external',
      configuration: 'ready',
      ...withWecomOperation(state, this.operations.get(id)),
      ...(shownFailure
        ? { lastFailure: { action: shownFailure.action, reason: shownFailure.reason, message: shownFailure.message, at: shownFailure.at } }
        : {}),
    };
  }

  private invalidRow(id: string): WecomConnectionDto {
    return {
      id,
      label: '企业微信配置不可读',
      botIdHint: '—',
      allowedUserCount: 0,
      coreMode: 'external',
      configuration: 'invalid',
      gateway: 'unknown',
      connection: 'unknown',
      ownership: 'unknown',
      canStart: false,
      canStop: false,
      canRestart: false,
      message: '请在本机检查并修复这个企业微信配置文件（JSON 格式与必填字段），修好后刷新本页。',
    };
  }

  /**
   * Every registered connection whose file exists, in registry order, or only
   * the one `only` names. With no such file nothing else is read: no desired
   * state, no fleet state. For one connection every configuration is still read
   * (another configuration of the same bot is part of its state), but only its
   * own processes and those of its bot's other configurations are inspected.
   */
  private rows(only?: string): { rows: WecomConnectionDto[]; states: Map<string, WecomConnectionState> } {
    const files = readWecomConfigPaths(this.root).filter(file => existsSync(file));
    const states = new Map<string, WecomConnectionState>();
    const entries = files.map(file => ({ id: wecomConfigId(file), loaded: this.load(file) }));
    const shown = only === undefined ? entries : entries.filter(entry => entry.id === only);
    if (shown.length === 0) {
      return { rows: [], states };
    }
    const bots = entries.flatMap(entry => entry.loaded ? [{ configId: entry.id, botId: entry.loaded.config.botId }] : []);
    const view = this.fleetView();
    const rows = shown.map(entry => {
      if (!entry.loaded) {
        return this.invalidRow(entry.id);
      }
      const state = deriveWecomConnectionState(this.facts(entry.loaded, bots, view));
      states.set(entry.id, state);
      return this.render(entry.loaded, state);
    });
    return { rows, states };
  }

  async list(): Promise<WecomConnectionDto[]> {
    return this.rows().rows;
  }

  /** One connection as the list shows it, gathering only what its row needs; undefined when it is not registered. */
  async connection(id: string): Promise<WecomConnectionDto | undefined> {
    return this.rows(id).rows[0];
  }

  private row(id: string): WecomConnectionDto {
    const row = this.rows(id).rows[0];
    if (!row) {
      throw new Error('wecom_connection_not_found');
    }
    return row;
  }

  /**
   * Start one action and return the connection as it shows now (in progress)
   * together with the action's outcome. Synchronous up to the spawn, so two
   * requests for one connection cannot both pass the "one at a time" check.
   * `force` skips the state's can-start/stop/restart verdict: the onboarding
   * wizard's rollback stops the connection it started whatever the state shows
   * (the command still validates the connection itself). `onSpawn` hears the
   * command's pid as soon as it runs.
   */
  begin(
    action: WecomConnectionAction,
    id: string,
    options: { beforeStart?: () => void; force?: boolean; onSpawn?: (pid: number) => void } = {},
  ): { view: WecomConnectionDto; settled: Promise<WecomLifecycleOutcome> } {
    if (this.operations.has(id)) {
      throw new Error('wecom_operation_in_progress');
    }
    const current = this.row(id);
    if (current.configuration !== 'ready') {
      throw new Error('wecom_configuration_invalid');
    }
    const allowed = action === 'start' ? current.canStart : action === 'stop' ? current.canStop : current.canRestart;
    if (!allowed && !options.force) {
      throw new Error('wecom_gateway_not_owned_or_unknown');
    }
    options.beforeStart?.();
    const operation: Operation = { action, startedAt: this.now(), ...(options.onSpawn ? { onSpawn: options.onSpawn } : {}) };
    this.operations.set(id, operation);
    this.failures.delete(id);
    const settled = this.execute(id, operation);
    operation.settled = settled;
    return { view: this.row(id), settled };
  }

  private async execute(id: string, operation: Operation): Promise<WecomLifecycleOutcome> {
    let outcome: WecomLifecycleOutcome;
    const run = this.options.runLifecycle ?? runWecomLifecycleCli;
    try {
      outcome = await (operation.onSpawn
        ? run(operation.action, id, { onSpawn: operation.onSpawn })
        : run(operation.action, id));
    } catch (error) {
      outcome = { ok: false, reason: 'cli_failed', message: error instanceof Error ? error.message : String(error) };
    }
    if (this.operations.get(id) === operation) {
      this.operations.delete(id);
    }
    // fleet_down is not a failure to show: the desired state is recorded and the
    // connection already shows "recorded as running, the fleet is not running".
    if (!outcome.ok && outcome.reason !== 'fleet_down') {
      let fingerprint: string | undefined;
      try {
        const state = this.rows(id).states.get(id);
        fingerprint = state ? wecomStateFingerprint(state) : undefined;
      } catch {
        // Unreadable now: the failure stays until the next action.
      }
      this.failures.set(id, {
        action: operation.action,
        reason: outcome.reason ?? 'cli_failed',
        message: outcome.message,
        at: this.now(),
        fingerprint,
      });
    }
    return outcome;
  }

  /**
   * Show a failure that no action of this manager produced (the wizard giving
   * up on a stop it owes): kept until the next action on the connection.
   */
  noteFailure(id: string, failure: { action: WecomConnectionAction; reason: string; message: string }): void {
    this.failures.set(id, { ...failure, at: this.now() });
  }

  /** Resolves once no action is in progress for the connection. */
  async idle(id: string): Promise<void> {
    for (let pending = this.operations.get(id); pending; pending = this.operations.get(id)) {
      await pending.settled?.catch(() => undefined);
    }
  }

  async start(id: string): Promise<WecomConnectionDto> {
    return this.begin('start', id).view;
  }

  async stop(id: string): Promise<WecomConnectionDto> {
    return this.begin('stop', id).view;
  }

  async restart(id: string): Promise<WecomConnectionDto> {
    return this.begin('restart', id).view;
  }
}
