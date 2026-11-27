/**
 * Fleet supervisor — LIVE layer (owns spawn/kill/fs/timers). Replaces pm2's God
 * daemon for the multi-bot fleet. One `FleetSupervisor` process (the `__supervisor`
 * entry) spawns each bot's daemon as a `__daemon` child, monitors exits, and
 * applies the pure policy decisions (restart-with-backoff / stop). All
 * state goes through fleet-state-store (atomic + locked). Boot persistence stays
 * with systemd/launchd, which re-run `botmux start`.
 *
 * Safety decisions (graceful-exit, max_restarts, projection identity, idempotent
 * start, generation addressing) come from fleet-supervisor-policy — this layer
 * only does the I/O the policy tells it to.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { feedbackMaintenanceActive } from '../services/feedback-maintenance.js';
import { resolveBotmuxDataDir } from './data-dir.js';
import { closeSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { openRotatedAppendLog } from '../utils/log-rotate.js';
import { isStandaloneBinary, resolveEntrySpawn, type BotmuxEntry } from './self-spawn.js';
import { scrubExternalMemberEnv } from '../utils/child-env.js';
import { isLinuxZombie, isTimezoneStableProcessIdentity, readDurableProcessIdentity } from '../utils/process-identity.js';
import { pidNotProvablyGone } from '../utils/process-alive.js';
import {
  builtinFleetEntryMatches,
  inspectFleetProcess,
  inspectSupervisorState,
  fleetProcessIdentityRuntime,
  signalAttestedFleetProcess,
  type FleetProcessIdentityRuntime,
} from './fleet-process-identity.js';
import {
  decideCrashExit,
  freshProc,
  planStart,
  DEFAULT_RESTART_POLICY,
  FLEET_GRACEFUL_EXIT_CODE,
  type FleetProcState,
  type RestartPolicy,
  type ChildExit,
} from './fleet-supervisor-policy.js';
import { mutateFleetState, readFleetState } from './fleet-state-store.js';
import type { FleetCommand } from './fleet-command-queue.js';
import { FLEET_DAEMON_KILL_TIMEOUT_MS } from './shutdown-budgets.js';

export interface FleetBotSpec {
  /** botmux-<index> process name (or 'botmux-dashboard' for the dashboard). */
  name: string;
  appId: string;
  /** 0-based bot index passed to the daemon via BOTMUX_BOT_INDEX. Ignored for
   *  non-'daemon' members (the dashboard has no bot index). */
  botIndex: number;
  /** Which entry module to spawn. Defaults to 'daemon' — a normal bot. The
   *  dashboard is a fleet member too ('dashboard'), so the supervisor gives it
   *  the SAME crash-restart / graceful-exit / stop machinery as a bot daemon,
   *  which is why it isn't a bespoke spawn. */
  entry?: BotmuxEntry;
  /** Log file basename under logDir (default `daemon-<botIndex>`). The two
   *  streams become `<base>-out.log` / `<base>-err.log`. Lets the dashboard
   *  write `dashboard-out.log` / `dashboard-err.log` instead of a bot-indexed
   *  name. */
  logBaseName?: string;
  /**
   * A member that is NOT one of botmux's own entry modules — an arbitrary
   * long-lived command (today: a plugin service). Set this INSTEAD of `entry`.
   *
   * WHY THE SUPERVISOR AND NOT pm2: plugin services used to run under a pm2 God
   * at `PLUGIN_PM2_HOME`, which does not work in the shipped build at all —
   * MEASURED in a real compiled binary, `require.resolve('pm2/bin/pm2')` throws
   * (the module graph lives in the virtual `/$bunfs/`), so `pm2Bin()` fell back
   * to a bare `'pm2'` that is not on a user's PATH. The supervisor already gives
   * the dashboard — also not a bot — the same crash-restart / graceful-exit /
   * stop machinery a plugin service needs, and it re-execs `process.execPath`,
   * so it works in the compiled binary by construction.
   *
   * ENV IS SCRUBBED HARDER THAN FOR OUR OWN MEMBERS, deliberately. A bot daemon
   * and the dashboard scrub the full set of session-scoped keys in their OWN
   * boot (index-daemon.ts / index-dashboard.ts) — they are our code, so they can
   * be asked to. An external command will NOT do that for us, and the keys it
   * would inherit are exactly the ones that turn one session's private state
   * into fleet-wide state (a sibling bot's CLI home, the dashboard's H5 app
   * secret, one turn's session identity). So `spawnBot` runs the same scrub the
   * pm2 path used to run (`scrubExternalMemberEnv`) before handing env over.
   */
  external?: {
    /** Executable to run. Resolved by the OS (PATH) unless absolute. */
    command: string;
    args?: string[];
    /** Working directory for the child. Defaults to the supervisor's own cwd. */
    cwd?: string;
    /** Extra env merged UNDER the scrub: it is applied first and the scrub runs
     *  after it, so a manifest cannot revive a key we deliberately strip. Same
     *  order (and same reason) as the pm2 path it replaces — a service needing
     *  its own data root must resolve it internally, not via CLAUDE_CONFIG_DIR /
     *  CODEX_HOME. Anything outside the scrubbed families passes through. */
    env?: Record<string, string>;
    /** Hash of the definition this member is being started from; persisted into
     *  fleet-state so a later reconcile can detect "running from a stale config"
     *  and restart it. See FleetProcState.configHash. */
    configHash?: string;
    autorestart?: boolean;
    killTimeoutMs?: number;
  };
}

export interface FleetSupervisorOptions {
  statePath: string;
  distDir: string;
  /** Base env every daemon child inherits (already scrubbed by the caller). */
  daemonEnv: NodeJS.ProcessEnv;
  cwd: string;
  policy?: RestartPolicy;
  /** ms to wait after SIGTERM before SIGKILL on stop (pm2 kill_timeout). */
  killTimeoutMs?: number;
  /** Node interpreter args (heap/diag) — Node path only; ignored in standalone. */
  daemonNodeArgs?: string[];
  /** Directory for per-bot daemon logs (daemon-<index>-out/err.log). When set,
   *  each child's stdout/stderr is redirected there so `botmux logs --bot <i>`
   *  can tail a specific bot — mirrors pm2's out_file/error_file. When unset
   *  (tests), children inherit the supervisor's stdio. */
  logDir?: string;
  /** Injected for tests; defaults to console. */
  log?: (msg: string) => void;
  /** Injected for process-identity edge-case tests. */
  processIdentityRuntime?: FleetProcessIdentityRuntime;
}

/** True if a pid is alive (kill -0). pid<=1 is never a real supervised child. */
export function pidAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 1) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

// 仅当时区稳定的持久化 processStart 与同 PID 当前身份均有效且不等时，才判定原进程已死且 PID 被系统复用；
// 未带时区稳定格式的旧 lstart 字符串、缺失或不可读身份一律保持 fail-closed
function isRecycledPid(
  proc: Pick<FleetProcState, 'pid' | 'processStart'>,
  runtime: FleetProcessIdentityRuntime,
): boolean {
  if (!isTimezoneStableProcessIdentity(proc.processStart) || !Number.isSafeInteger(proc.pid) || proc.pid <= 1) {
    return false;
  }
  const current = runtime.readIdentity(proc.pid);
  return Boolean(isTimezoneStableProcessIdentity(current) && current !== proc.processStart);
}

export class FleetSupervisor {
  private readonly children = new Map<string, ChildProcess>();
  private readonly spawnReady = new WeakMap<ChildProcess, Promise<void>>();
  /** Per-name generation the live child was spawned with — guards stale exits. */
  private readonly liveGeneration = new Map<string, number>();
  private readonly restartTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Keep orphan rows addressable until their exact process generation exits. */
  private readonly orphanStops = new Map<string, Promise<void>>();
  /** Names an operator explicitly stopped (stop-bot). Their SIGTERM would look
   *  like a crash to onChildExit, so we suppress the restart for exactly one exit
   *  and mark them stopped. Cleared when the bot is explicitly started again. */
  private readonly explicitStop = new Set<string>();
  /** Bot specs known to this supervisor (from the last start() reconcile), so a
   *  queued start-bot/stop-bot can resolve a name→spec without re-reading config. */
  private readonly knownSpecs = new Map<string, FleetBotSpec>();
  private stopping = false;
  private readonly policy: RestartPolicy;
  private readonly killTimeoutMs: number;
  private readonly log: (msg: string) => void;

  constructor(private readonly opts: FleetSupervisorOptions) {
    this.policy = opts.policy ?? DEFAULT_RESTART_POLICY;
    this.killTimeoutMs = opts.killTimeoutMs ?? FLEET_DAEMON_KILL_TIMEOUT_MS;
    this.log = opts.log ?? ((m) => console.error(`[fleet-supervisor] ${m}`));
  }

  /** Process names can change after setup/clone. Keep an active daemon's name
   * as its handle until it stops; App ID owns identity, including crash backoff.
   * Dashboard/plugin members have separate identities and must not coalesce. */
  private resolveDaemonSpec(spec: FleetBotSpec): FleetBotSpec {
    if (spec.external || (spec.entry ?? 'daemon') !== 'daemon' || !spec.appId) return spec;
    // Maintenance admission can defer the very first spawn before any state
    // row exists. Its in-memory timer still owns this App ID.
    const pending = [...this.knownSpecs.values()].find(p => p.appId === spec.appId
      && !p.external && (p.entry ?? 'daemon') === 'daemon'
      && (this.children.has(p.name) || this.restartTimers.has(p.name)));
    if (pending) return { ...spec, name: pending.name };
    const active = (readFleetState(this.opts.statePath)?.procs ?? []).find(p =>
      p.appId === spec.appId && (p.status === 'online' || p.status === 'launching'));
    return active ? { ...spec, name: active.name } : spec;
  }

  /** Start (or reconcile) the fleet: spawn every configured bot not already
   *  alive. Idempotent — an already-live child (per state + kill -0) is left be.
   *  This is both the initial start and the resurrect path.
   *
   *  Returns false — having touched nothing — when fleet-state names ANOTHER
   *  live, identity-verified supervisor: that one owns the fleet. */
  start(bots: readonly FleetBotSpec[]): boolean {
    const identityRuntime = this.opts.processIdentityRuntime ?? fleetProcessIdentityRuntime;
    const owner = this.claimFleetOwnership(identityRuntime);
    if (owner !== undefined) {
      this.log(`fleet is owned by live supervisor pid ${owner}; not starting a second one`);
      return false;
    }
    const specByName = new Map<string, FleetBotSpec>();
    const daemonApps = new Set<string>();
    for (const input of bots) {
      const spec = this.resolveDaemonSpec(input);
      if (!spec.external && (spec.entry ?? 'daemon') === 'daemon' && spec.appId) {
        if (daemonApps.has(spec.appId)) continue;
        daemonApps.add(spec.appId);
      }
      specByName.set(spec.name, spec);
    }
    // Remember the spec set so queued start-bot/stop-bot can resolve name→spec.
    this.knownSpecs.clear();
    for (const b of specByName.values()) this.knownSpecs.set(b.name, b);
    // A full fleet start clears any explicit-stop marks — `botmux start` means
    // "bring everything up", overriding a prior single-bot stop.
    this.explicitStop.clear();
    // Record our supervisor identity + reconcile the persisted proc set against
    // reality before deciding what to (re)spawn.
    //
    // OWNERSHIP SAFETY: a proc that is 'online' with a live pid but which THIS
    // supervisor process did not spawn (not in `this.children`) is an orphan from
    // a previous supervisor generation that died hard (SIGKILL/OOM/panic) while
    // its daemon children kept running. If we left it 'online', planStart would
    // skip it and — when every member is such an orphan — we would spawn NOTHING,
    // hold no child handles or timers, and the event loop would drain: the new
    // supervisor exits immediately, leaving the whole fleet (bot daemons AND the
    // dashboard) running unsupervised, with `botmux start/restart` unable to bring
    // it back. A supervisor must OWN every live member it can safely identify,
    // so we kill verified orphans here and let planStart respawn them. An
    // unverifiable member is isolated in place: no signal and no duplicate
    // spawn, while the rest of the fleet still reconciles.
    //
    // The `!this.children.has` ownership check is the whole criterion — no pid /
    // generation comparison. On the SAME supervisor re-reconciling (idempotent
    // re-start), every child it spawned IS in `this.children`, so this loop and
    // the reconcile branch below are both natural no-ops; only genuinely unowned
    // live procs are reclaimed. (Relying on pid-inequality would miss the corner
    // where the OS recycles the dead supervisor's pid onto the new one.)
    for (const p of readFleetState(this.opts.statePath)?.procs ?? []) {
      const configured = this.specForProc(p);
      // A bot removed while its supervisor was down may still be online or
      // partway through retirement. With no configured member, allow only a fresh
      // built-in command match: the daemon's, or the topic indexer's for the
      // reserved topic-index row. Never infer plugin/dashboard ownership.
      const retireOnly = !configured && (p.status === 'online' || p.status === 'launching') && p.pid > 1;
      const spec = configured ?? (retireOnly
        ? { name: p.name, appId: p.appId, botIndex: -1, ...(p.name === 'topic-index' ? { entry: 'topic-indexer' as const } : {}) }
        : undefined);
      if (spec && (p.status === 'online' || (p.status === 'launching' && p.pid > 1)) && !this.children.has(p.name)) {
        // Include every alias of a configured App ID, not only its chosen name.
        // stopUnowned records failures; preserve the row and continue with peers.
        void this.stopUnowned(p, spec, retireOnly).catch(() => {});
      }
    }
    mutateFleetState(this.opts.statePath, (cur) => {
      // Live aliases remain durable while retirement is pending or unverifiable.
      // Sending SIGTERM alone does not prove that a daemon has stopped.
      cur.procs = cur.procs.filter(p => specByName.has(p.name)
        || (p.pid > 1 && identityRuntime.pidExists(p.pid) && !isRecycledPid(p, identityRuntime)
          && (this.specForProc(p) || p.status === 'launching' || this.children.has(p.name) || this.orphanStops.has(p.name))));
      for (const p of cur.procs) {
        if (p.status === 'online' && !identityRuntime.pidExists(p.pid)) {
          p.pid = 0;
          p.status = 'stopped';
        } else if (p.pid > 1 && !this.children.has(p.name) && (this.specForProc(p) || this.orphanStops.has(p.name))) {
          // Retirement admission may have failed its first write. A successful
          // reconcile still cannot publish an unowned PID as healthy.
          p.status = 'launching';
        }
      }
      return cur;
    });

    const current = readFleetState(this.opts.statePath)?.procs ?? [];
    const toStart = planStart([...specByName.keys()], current,
      p => p.status === 'online' && pidAlive(p.pid) && this.children.has(p.name));
    for (const name of toStart) {
      const spec = specByName.get(name);
      if (spec) this.startOneBot(spec);
    }
    return true;
  }

  private specForProc(proc: FleetProcState): FleetBotSpec | undefined {
    return (proc.appId && [...this.knownSpecs.values()].find(spec =>
      !spec.external && (spec.entry ?? 'daemon') === 'daemon' && spec.appId === proc.appId))
      || this.knownSpecs.get(proc.name);
  }

  private stopUnowned(proc: FleetProcState, spec: FleetBotSpec, retireOnly = false): Promise<void> {
    const pending = this.orphanStops.get(proc.name);
    if (pending) return pending;
    const stop = this.retireUnowned(proc, spec, retireOnly).catch(error => {
      this.log(`${error.message}; leaving this member untouched`);
      throw error;
    }).finally(() => this.orphanStops.delete(proc.name));
    this.orphanStops.set(proc.name, stop);
    return stop;
  }

  private async retireUnowned(proc: FleetProcState, spec: FleetBotSpec, retireOnly: boolean): Promise<void> {
    const runtime = this.opts.processIdentityRuntime ?? fleetProcessIdentityRuntime;
    // This PID is still addressable, but it is not an owned, healthy daemon.
    // Keep that distinction durable across a second supervisor crash.
    mutateFleetState(this.opts.statePath, cur => {
      const row = cur.procs.find(p => p.name === proc.name && p.pid === proc.pid && p.generation === proc.generation);
      if (row) row.status = 'launching';
      return cur;
    });
    const expected = spec.external;
    const inspection = inspectFleetProcess(proc.pid, proc.processStart, undefined,
      command => expected
        ? command.includes(expected.command) && (expected.args ?? []).every(arg => command.includes(arg))
        : builtinFleetEntryMatches(spec.entry ?? 'daemon', command),
      runtime, /* removed members must re-prove their built-in command */ retireOnly);
    if (inspection.status === 'unverifiable') throw new Error(`cannot verify unowned ${proc.name} (pid ${proc.pid})`);
    if (retireOnly && inspection.status === 'stale' && runtime.pidExists(proc.pid) && !isRecycledPid(proc, runtime)) {
      throw new Error(`cannot prove removed ${proc.name} (pid ${proc.pid}) is a botmux daemon`);
    }
    if (inspection.status === 'exact') {
      const target = inspection.attestation;
      signalAttestedFleetProcess(target, 'SIGTERM', runtime);
      const killAt = Date.now() + (spec.external?.killTimeoutMs ?? this.killTimeoutMs);
      let escalated = false;
      for (;;) {
        const current = inspectFleetProcess(proc.pid, target.processStart, target.pidNamespace,
          () => true, runtime, /* verifyPersistedCommand */ false);
        if (current.status === 'stale' || (current.status === 'exact' && isLinuxZombie(proc.pid))) break;
        if (current.status === 'unverifiable') throw new Error(`lost verification for unowned ${proc.name}`);
        if (Date.now() >= killAt + 5_000) throw new Error(`fleet: stop not confirmed for unowned ${proc.name}`);
        if (!escalated && Date.now() >= killAt) {
          signalAttestedFleetProcess(target, 'SIGKILL', runtime);
          escalated = true;
        }
        await new Promise<void>(resolve => setTimeout(resolve, 50));
      }
    }
    mutateFleetState(this.opts.statePath, cur => {
      const row = cur.procs.find(p => p.name === proc.name && p.pid === proc.pid && p.generation === proc.generation);
      if (row) {
        row.status = 'stopped'; row.pid = 0;
        if (!this.knownSpecs.has(row.name)) cur.procs = cur.procs.filter(p => p !== row);
      }
      return cur;
    });
  }

  /**
   * Atomically (under the fleet-state lock) either record THIS process as the
   * fleet's supervisor, or report the pid of another live supervisor that
   * already owns it.
   *
   * The CLI's `botmux start` checks for a live supervisor under the fleet
   * mutation lock, but the supervisor it spawns is detached and only records
   * itself here, after its own boot. The lock is released as soon as the spawn
   * returns, so a second `start` landing in that window — the autostart
   * watchdog firing while a slow first `start` is still booting, measured at
   * ~30s on a fresh host — sees no supervisor and spawns another. Without this
   * claim the second one would then treat the first one's live daemons as
   * orphans of a dead generation, SIGTERM them, and both supervisors would keep
   * resurrecting their own copy: two daemons per bot consuming the same Lark
   * events and session store.
   *
   * Only an 'exact' identity match counts as an owner. A stale record (dead
   * pid, recycled pid) is taken over as before, and an 'unverifiable' legacy
   * record keeps the existing takeover path so upgrades are not blocked.
   */
  private claimFleetOwnership(identityRuntime: FleetProcessIdentityRuntime): number | undefined {
    let owner: number | undefined;
    mutateFleetState(this.opts.statePath, (cur) => {
      const recordedPid = cur.supervisorPid;
      if (recordedPid > 1 && recordedPid !== process.pid
        && inspectSupervisorState(cur, identityRuntime).status === 'exact') {
        owner = recordedPid;
        return cur;
      }
      cur.supervisorEntry = isStandaloneBinary() ? process.execPath : process.argv[1];
      const supervisorProcessStart = identityRuntime.readIdentity(process.pid);
      if (!supervisorProcessStart) throw new Error('fleet: cannot determine supervisor process identity');
      cur.supervisorProcessStart = supervisorProcessStart;
      const supervisorPidNamespace = identityRuntime.readPidNamespace(process.pid);
      if (process.platform === 'linux' && !supervisorPidNamespace) {
        throw new Error('fleet: cannot determine supervisor PID namespace');
      }
      if (supervisorPidNamespace) cur.supervisorPidNamespace = supervisorPidNamespace;
      else delete cur.supervisorPidNamespace;
      const supervisorCommand = identityRuntime.readCommandLine(process.pid);
      if (!supervisorCommand) throw new Error('fleet: cannot determine supervisor command identity');
      cur.supervisorCommand = supervisorCommand;
      // Refresh the start time whenever a NEW supervisor takes over (pid differs
      // from the one on record); a plain `||` would pin it to the first-ever
      // start forever, so status/uptime would misreport across restarts. Keep it
      // only when the SAME supervisor re-reconciles (idempotent re-start).
      if (recordedPid !== process.pid || !cur.supervisorStartedAt) {
        cur.supervisorStartedAt = new Date().toISOString();
      }
      cur.supervisorPid = process.pid;
      return cur;
    });
    return owner;
  }

  /** Start (or reconcile) ONE bot without touching the rest — the live side of
   *  `botmux start-bot`. Idempotent: a no-op if that bot is already online+alive.
   *  Registers the spec so a later exit is handled with the right identity, and
   *  clears any explicit-stop mark (an explicit start overrides a prior stop). */
  startOneBot(spec: FleetBotSpec): void {
    if (this.stopping) return;
    spec = this.resolveDaemonSpec(spec);
    const occupant = this.knownSpecs.get(spec.name);
    if (occupant && occupant.appId !== spec.appId
      && (this.children.has(spec.name) || this.restartTimers.has(spec.name))) {
      this.log(`start-bot ${spec.name}: name belongs to another active App ID`);
      return;
    }
    this.knownSpecs.set(spec.name, spec);
    this.explicitStop.delete(spec.name);
    // Cancel any pending crash-restart timer FIRST (mirrors stopOneBot). A bot
    // that just crashed is mid-backoff: status 'launching', pid 0, not in
    // `children`, with a restart timer scheduled to respawn it. Without this
    // cancel, the guard below (which needs online+alive+children) does not match,
    // so we spawn a fresh child here — and then the stale timer ALSO fires and
    // spawns a SECOND one. The first becomes an orphan the supervisor no longer
    // tracks (not in `children`/state, its exit ignored by the generation guard),
    // never reaped by stopAll/stop-bot: two daemons for one bot. Cancelling the
    // timer makes this the single, owned (re)spawn.
    const pendingRestart = this.restartTimers.get(spec.name);
    if (pendingRestart) { clearTimeout(pendingRestart); this.restartTimers.delete(spec.name); }
    const proc = readFleetState(this.opts.statePath)?.procs.find((p) => p.name === spec.name);
    if (proc && proc.status === 'online' && pidAlive(proc.pid) && this.children.has(spec.name)) {
      this.log(`start-bot ${spec.name}: already online (pid ${proc.pid})`);
      return;
    }
    this.spawnBot(spec, /* isRestart */ false);
  }

  /** Replace one external definition only after its previous child has exited.
   * Callers serialize this with remove/stop; a matching live definition is a no-op. */
  async upsertExternal(spec: FleetBotSpec): Promise<void> {
    if (!spec.external) throw new Error('fleet: external spec required');
    const known = this.knownSpecs.get(spec.name);
    if (known && JSON.stringify(known.external) !== JSON.stringify(spec.external)) {
      await this.stopOneBot(spec.name);
    }
    this.startOneBot(spec);
    const child = this.children.get(spec.name);
    if (!child) throw new Error(`fleet: failed to start ${spec.name}`);
    // spawn() returns before exec succeeds. A command acknowledgement must not
    // turn ENOENT/EACCES into a successful plugin install/start.
    await this.spawnReady.get(child);
  }

  async removeExternal(name: string): Promise<void> {
    const spec = this.knownSpecs.get(name);
    if (spec && !spec.external) throw new Error(`fleet: not an external member: ${name}`);
    await this.stopOneBot(name);
    this.knownSpecs.delete(name);
    this.liveGeneration.delete(name);
    mutateFleetState(this.opts.statePath, (cur) => {
      cur.procs = cur.procs.filter(p => p.name !== name);
      return cur;
    });
  }

  /** Stop ONE bot without touching the rest — the live side of `botmux stop-bot`.
   *  Cancels a pending restart, marks it explicit-stop so the ensuing SIGTERM exit
   *  is not treated as a crash, then SIGTERM→(kill_timeout)→SIGKILL. Resolves when
   *  the child is gone. A no-op (marks stopped in state) if nothing is live. */
  async stopOneBot(name: string): Promise<void> {
    const timer = this.restartTimers.get(name);
    if (timer) { clearTimeout(timer); this.restartTimers.delete(name); }
    const child = this.children.get(name);
    if (!child) {
      const proc = readFleetState(this.opts.statePath)?.procs.find(p => p.name === name);
      if (proc && proc.pid > 1) {
        const spec = this.specForProc(proc);
        if (!spec) throw new Error(`fleet: unknown unowned member ${name}`);
        await this.stopUnowned(proc, spec);
      }
      // Nothing live to signal (already down, or mid-backoff we just cancelled).
      // Reflect stopped in state so status is truthful and no restart is pending.
      this.explicitStop.delete(name);
      mutateFleetState(this.opts.statePath, (cur) => {
        const p = cur.procs.find((x) => x.name === name);
        if (p && p.status !== 'errored') { p.status = 'stopped'; p.pid = 0; }
        return cur;
      });
      this.log(`stop-bot ${name}: not running (marked stopped)`);
      return;
    }
    this.explicitStop.add(name); // onChildExit will suppress the restart + mark stopped
    await this.stopOne(name, child);
  }

  /** Drain + execute queued single-bot commands (SIGHUP handler). Each command is
   *  resolved to a spec (queue carries name/appId/botIndex, so no config re-read
   *  is required) and applied via startOneBot/stopOneBot. */
  async drainCommands(commands: readonly FleetCommand[]): Promise<void> {
    for (const cmd of commands) {
      // PREFER THE KNOWN SPEC over the command payload. The queue carries only
      // (name, appId, botIndex) — enough to respawn a bot daemon, but it cannot
      // describe an EXTERNAL member, whose command/args/cwd/env live in the spec.
      // Rebuilding from the payload alone would spawn a plugin service as if it
      // were a bot daemon (resolveEntrySpawn + no scrub). start() records every
      // member in knownSpecs, so use that and fall back to the payload only for
      // a name we have never seen.
      const known = this.knownSpecs.get(cmd.name);
      const spec: FleetBotSpec = known?.appId === cmd.appId ? known : { name: cmd.name, appId: cmd.appId, botIndex: cmd.botIndex };
      if (cmd.op === 'start-bot') {
        try {
          this.startOneBot(spec);
        } catch (error) {
          this.log(`start-bot ${spec.name} failed: ${error instanceof Error ? error.message : error}`);
        }
      } else {
        // A renamed bot may still run under its previous handle. Include all
        // aliases so an operator can also retire duplicates from older builds.
        const aliases = !spec.external && (spec.entry ?? 'daemon') === 'daemon' && spec.appId
          ? [...(readFleetState(this.opts.statePath)?.procs ?? []), ...this.knownSpecs.values()]
            .filter(p => p.appId === spec.appId).map(p => p.name)
          : [cmd.name];
        for (const name of new Set(aliases)) {
          try {
            await this.stopOneBot(name);
          } catch (error) {
            // The durable row remains launching/online, so the CLI keeps waiting
            // instead of seeing a false stop. Do not reject the SIGHUP drain or
            // skip unrelated commands queued behind this failed alias.
            this.log(`stop-bot ${name} failed: ${error instanceof Error ? error.message : error}`);
          }
        }
      }
    }
  }

  private spawnBot(spec: FleetBotSpec, isRestart: boolean): void {
    if (this.stopping) return;
    // A full reconcile may remove/reassign this member while retirement waits.
    if (this.knownSpecs.get(spec.name)?.appId !== spec.appId) return;
    const runtime = this.opts.processIdentityRuntime ?? fleetProcessIdentityRuntime;
    const unowned = (readFleetState(this.opts.statePath)?.procs ?? []).filter(p =>
      (p.name === spec.name
        || (!spec.external && (spec.entry ?? 'daemon') === 'daemon' && spec.appId && p.appId === spec.appId))
      && p.pid > 1 && runtime.pidExists(p.pid) && !isRecycledPid(p, runtime) && !this.children.has(p.name));
    if (unowned.length > 0) {
      if (unowned.some(p => this.orphanStops.has(p.name))) {
        // The same cancellable start slot covers recovery and crash backoff.
        const timer = setTimeout(() => {
          this.restartTimers.delete(spec.name);
          this.spawnBot(spec, isRestart);
        }, 100);
        this.restartTimers.set(spec.name, timer);
      } else {
        this.log(`start-bot ${spec.name}: blocked by an unowned live process`);
      }
      return;
    }
    const entry = spec.entry ?? 'daemon';
    if (!spec.external && entry === 'daemon' && feedbackMaintenanceActive(resolveBotmuxDataDir({ env: this.opts.daemonEnv }))) {
      this.log(`feedback maintenance: deferred ${spec.name}`);
      // Publish admission before scheduling: stop-bot must see pending work
      // even when this daemon has never spawned. Preserve crash/generation
      // history when maintenance overlaps an existing restart.
      mutateFleetState(this.opts.statePath, cur => {
        let pending = cur.procs.find(p => p.name === spec.name);
        if (!pending) {
          pending = freshProc(spec.name, spec.appId, 0, new Date().toISOString());
          cur.procs.push(pending);
        }
        pending.appId = spec.appId;
        pending.status = 'launching';
        pending.pid = 0;
        return cur;
      });
      // Like crash backoff, this retry may be the supervisor's only pending
      // handle in a single-member fleet. Keep it ref'd so the event loop cannot
      // drain before admission is retried. stopAll/stopOneBot cancel it through
      // restartTimers, so a requested shutdown still drains normally.
      const timer = setTimeout(() => {
        this.restartTimers.delete(spec.name);
        this.spawnBot(spec, isRestart);
      }, 1000);
      this.restartTimers.set(spec.name, timer);
      return;
    }
    // An external member (a plugin service) runs an arbitrary command instead of
    // one of our entry modules. Everything BELOW this point — logs, state,
    // restart budget, graceful stop — is shared verbatim; only the command and
    // the env differ, which is the whole reason this is a spec variant rather
    // than a second spawn path.
    const { command, args } = spec.external
      ? { command: spec.external.command, args: spec.external.args ?? [] }
      : resolveEntrySpawn(entry, this.opts.distDir);
    // node_args (heap/diag) apply only to the Node path; a compiled binary has
    // no separate interpreter args. resolveEntrySpawn already picks the shape;
    // we prepend node_args only when the command is a node/JS invocation.
    // An external command is neither: its argv is the plugin's own, so our
    // interpreter flags would be nonsense (or worse, consumed as its args).
    const isStandalone = args.length > 0 && args[0].startsWith('__');
    const nodeArgs = (spec.external || isStandalone) ? [] : (this.opts.daemonNodeArgs ?? []);
    // Per-member log files (mirrors pm2 out_file/error_file → `botmux logs`).
    // Bot daemons write daemon-<index>-{out,err}.log; the dashboard writes
    // dashboard-{out,err}.log (spec.logBaseName). Opened in append mode so a
    // restart keeps history; fds are closed when the child exits (see
    // onChildExit). When no logDir is configured (tests), the child inherits
    // our stdio.
    const logBase = spec.logBaseName ?? `daemon-${spec.botIndex}`;
    let stdio: Array<'ignore' | 'inherit' | number> = ['ignore', 'inherit', 'inherit'];
    let outFd: number | undefined;
    let errFd: number | undefined;
    if (this.opts.logDir) {
      try {
        mkdirSync(this.opts.logDir, { recursive: true });
        // 打开前按大小轮转（默认 20MiB，保留 1 份 .1），防止单一日志无限增长吃满磁盘。
        outFd = openRotatedAppendLog(join(this.opts.logDir, `${logBase}-out.log`));
        errFd = openRotatedAppendLog(join(this.opts.logDir, `${logBase}-err.log`));
        stdio = ['ignore', outFd, errFd];
      } catch (err) {
        this.log(`${spec.name} log file open failed, inheriting stdio: ${err instanceof Error ? err.message : err}`);
        if (outFd !== undefined) { try { closeSync(outFd); } catch { /* */ } outFd = undefined; }
        if (errFd !== undefined) { try { closeSync(errFd); } catch { /* */ } errFd = undefined; }
      }
    }
    // Bot daemons need their 0-based index (BOTMUX_BOT_INDEX); the dashboard is
    // app-agnostic and takes only the shared base env (it loads its own
    // ~/.botmux/.env H5 family in index-dashboard.ts). Injecting a bot index
    // into the dashboard would be meaningless and misleading, so gate it on the
    // 'daemon' entry.
    //
    // An EXTERNAL member takes neither: it is not a bot (no index) and it is not
    // our code, so it gets the base env with the session-scoped families removed.
    // See scrubExternalMemberEnv for why our own members do not need this (they
    // scrub in their own boot) and why an external command does.
    //
    // ORDER IS LOAD-BEARING: the spec's own `env` is merged BEFORE the scrub, so
    // the scrub has the last word and a plugin manifest cannot revive a key we
    // deliberately strip. This is the order the pm2 path used and stated outright
    // ("applies it AFTER the manifest env merge, so a plugin manifest cannot
    // revive a scrubbed key"), with a test pinning it. Merging
    // after the scrub would silently undo it for exactly the keys that matter
    // (a sibling's CLI home, the dashboard app secret, the graceful sentinel).
    // A service needing its own data root must resolve it internally.
    let childEnv: NodeJS.ProcessEnv;
    if (spec.external) {
      childEnv = { ...this.opts.daemonEnv, ...(spec.external.env ?? {}) };
      scrubExternalMemberEnv(childEnv);
    } else if (entry === 'daemon') {
      childEnv = { ...this.opts.daemonEnv, BOTMUX_BOT_INDEX: String(spec.botIndex) };
    } else {
      childEnv = { ...this.opts.daemonEnv };
    }
    const child = spawn(command, [...nodeArgs, ...args], {
      cwd: spec.external?.cwd ?? this.opts.cwd,
      stdio,
      env: childEnv,
      windowsHide: true,
    });
    let spawned = false;
    const ready = new Promise<void>((resolve, reject) => {
      child.once('spawn', () => { spawned = true; resolve(); });
      child.once('error', reject);
    });
    // Automatic restarts have no awaiting caller; onChildExit still records
    // their failures. Explicit plugin starts await the same exec boundary.
    void ready.catch(() => {});
    this.spawnReady.set(child, ready);
    // The child dup'd the fds; close our copies so we don't leak one per respawn.
    if (outFd !== undefined) { try { closeSync(outFd); } catch { /* */ } }
    if (errFd !== undefined) { try { closeSync(errFd); } catch { /* */ } }
    const now = new Date().toISOString();

    // Persist the new generation + pid atomically, bumping generation on restart.
    const generation = mutateFleetState(this.opts.statePath, (cur) => {
      const existing = cur.procs.find((p) => p.name === spec.name);
      if (existing) {
        // Reusing an index/name for a different application must not leave the
        // previous identity attached to this newly spawned generation.
        existing.appId = spec.appId;
        existing.pid = child.pid ?? 0;
        existing.generation += 1;
        existing.status = 'online';
        existing.startedAt = now;
        existing.lastExitCode = null;
        // A crash-driven respawn (isRestart) must PRESERVE restarts — that's the
        // running tally the exit handler compares against maxRestarts. But a fresh
        // operator-initiated start (isRestart=false: `botmux start` reconcile or
        // start-bot) gives the bot a CLEAN restart budget; otherwise a proc that
        // crashlooped in a previous supervisor generation would carry its stale
        // count and enter the cooldown instead of getting a full fast budget.
        if (!isRestart) existing.restarts = 0;
        // Record which config this generation was actually started from, so the
        // caller can later tell "running, but from a stale definition" apart from
        // "running and current". Only external members have one.
        if (spec.external?.configHash !== undefined) existing.configHash = spec.external.configHash;
        else delete existing.configHash;
        if (child.pid) existing.processStart = readDurableProcessIdentity(child.pid);
      } else {
        cur.procs.push({ ...freshProc(spec.name, spec.appId, child.pid ?? 0, now, spec.external?.configHash) });
        if (child.pid) cur.procs[cur.procs.length - 1].processStart = readDurableProcessIdentity(child.pid);
      }
      return cur;
    }).procs.find((p) => p.name === spec.name)!.generation;

    this.children.set(spec.name, child);
    this.liveGeneration.set(spec.name, generation);
    this.log(`${isRestart ? 'restarted' : 'started'} ${spec.name} (pid ${child.pid}, gen ${generation})`);

    child.on('exit', (code, signal) => this.onChildExit(spec, generation, { code, signal }));
    child.on('error', (err) => {
      this.log(`${spec.name} child error: ${err.message}`);
      // A failed kill/send is not evidence of exit. Keep tracking a spawned
      // child until its exit event, especially when removal must fail closed.
      if (!spawned) this.onChildExit(spec, generation, { code: 1, signal: null });
    });
  }

  private onChildExit(spec: FleetBotSpec, generation: number, exit: ChildExit): void {
    // Generation guard: ignore an exit from a child we already replaced. A stale
    // exit must never mutate the newer generation's row or trigger a double spawn.
    if (this.liveGeneration.get(spec.name) !== generation) return;
    this.children.delete(spec.name);
    if (this.stopping) return;

    // Explicit stop-bot: this exit is operator-intended, not a crash. Suppress the
    // restart and mark it stopped, then clear the one-shot mark. (A SIGTERM exit
    // looks like a crash to decideOnExit, so this check must come first.)
    if (this.explicitStop.has(spec.name)) {
      this.explicitStop.delete(spec.name);
      this.log(`${spec.name} stopped by operator (stop-bot); not restarting`);
      this.markStopped(spec.name, exit, 'stopped'); // clears liveGeneration too
      return;
    }

    const current = readFleetState(this.opts.statePath)?.procs.find((p) => p.name === spec.name);
    if (spec.external?.autorestart === false) {
      this.markStopped(spec.name, exit, 'stopped');
      return;
    }
    // The 90 sentinel is honoured ONLY for stops this supervisor itself
    // requested — the two guards above (stopping / explicitStop) are the sole
    // record of that intent. A 90 reaching here is therefore an UNSOLICITED
    // graceful exit: a signal from outside the supervision tree (recorded
    // twice on this box: an unrelated shell ran `pkill -f index-daemon.js` as
    // probe cleanup and retired the entire 55-daemon fleet for hours, because
    // every daemon exited 90 and was trusted at its word), a hand-typed
    // `kill -TERM <pid>`, and so on. Refuse the sentinel in that case and
    // self-heal exactly like a crash; an operator who genuinely wants a daemon
    // to stay down uses `botmux stop-bot` (explicitStop). External members
    // already refused it for the same reason — 90 is our private handshake, not
    // proof that a stop was requested through the sanctioned channel.
    const unsolicited = exit.code === FLEET_GRACEFUL_EXIT_CODE && exit.signal === null;
    // Graceful ('stop') was already consumed by the stopping / explicitStop
    // guards above this point. Unexpected exits always retain a retry timer.
    const uptimeMs = current?.startedAt ? Date.now() - Date.parse(current.startedAt) : 0;
    const decision = decideCrashExit({ restarts: current?.restarts ?? 0 }, this.policy, uptimeMs);
    // restart: record the bump, then respawn after the backoff.
    mutateFleetState(this.opts.statePath, (cur) => {
      const p = cur.procs.find((x) => x.name === spec.name);
      if (p) { p.restarts = decision.nextRestarts; p.status = 'launching'; p.pid = 0; p.lastExitCode = exit.code; }
      return cur;
    });
    this.log(
      unsolicited
        ? `${spec.name} exited graceful sentinel (${FLEET_GRACEFUL_EXIT_CODE}) WITHOUT a supervisor-initiated stop `
          + `(likely an external signal, e.g. pkill/kill -TERM); restarting instead of retiring`
        : `${spec.name} crashed (code=${exit.code} signal=${exit.signal}); restart ${decision.nextRestarts}/${this.policy.maxRestarts} in ${decision.delayMs}ms`,
    );
    // The restart timer MUST keep the event loop alive: when the crashed child
    // was the supervisor's only live handle, an unref'd timer would let the loop
    // drain and the supervisor would exit mid-backoff — never respawning the bot
    // (observed under bun: single-bot fleet, child crashloops, supervisor dies
    // after scheduling the first restart). A ref'd timer holds the process until
    // the respawn fires. (stopOne's kill timer stays unref'd — it's a shutdown
    // safety net that must NOT keep the loop alive.)
    const timer = setTimeout(() => { this.restartTimers.delete(spec.name); this.spawnBot(spec, true); }, decision.delayMs);
    this.restartTimers.set(spec.name, timer);
  }

  private markStopped(name: string, exit: ChildExit, status: 'stopped' | 'errored'): void {
    mutateFleetState(this.opts.statePath, (cur) => {
      const p = cur.procs.find((x) => x.name === name);
      if (p) { p.status = status; p.pid = 0; p.lastExitCode = exit.code; }
      return cur;
    });
    this.liveGeneration.delete(name);
  }

  /** Graceful stop of the whole fleet: SIGTERM each child, then SIGKILL any that
   *  outlast kill_timeout. Cancels pending restart timers first so a mid-backoff
   *  crash can't respawn during shutdown. Resolves when all children are gone.
   *  Finalizes owned rows and clears supervisorPid, retaining unresolved orphan
   *  rows — onChildExit is short-circuited while stopping. */
  async stopAll(): Promise<void> {
    this.stopping = true;
    for (const t of this.restartTimers.values()) clearTimeout(t);
    this.restartTimers.clear();
    const pending = [...this.children.entries()];
    await Promise.all(pending.map(([name, child]) => this.stopOne(name, child)));
    await Promise.allSettled(this.orphanStops.values());
    // Reflect the stop in the durable record. onChildExit ignored these exits
    // (stopping=true), so without this the state file would keep the now-dead
    // pids as 'online'. Clear supervisorPid too: this supervisor is exiting.
    const identityRuntime = this.opts.processIdentityRuntime ?? fleetProcessIdentityRuntime;
    mutateFleetState(this.opts.statePath, (cur) => {
      for (const p of cur.procs) {
        // Unverifiable or failed orphan retirement must survive shutdown for the
        // next supervisor/operator; do not turn a live PID into a stopped row.
        // pid=0 is a pending retry, not an orphan; kill(0, 0) probes our group.
        if (p.pid > 1 && !pending.some(([name]) => name === p.name)
          && identityRuntime.pidExists(p.pid) && !isRecycledPid(p, identityRuntime)) continue;
        if (p.status === 'online' || p.status === 'launching') { p.status = 'stopped'; p.pid = 0; }
      }
      cur.supervisorPid = 0;
      delete cur.supervisorProcessStart;
      delete cur.supervisorPidNamespace;
      delete cur.supervisorCommand;
      return cur;
    });
  }

  private stopOne(name: string, child: ChildProcess): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
    return new Promise((resolve, reject) => {
      let done = false;
      const timeout = this.knownSpecs.get(name)?.external?.killTimeoutMs ?? this.killTimeoutMs;
      const childExited = () => child.exitCode !== null || child.signalCode !== null
        || (child.pid !== undefined && (isLinuxZombie(child.pid) || !pidNotProvablyGone(child.pid)));
      let deadline: ReturnType<typeof setTimeout> | undefined;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(killTimer);
        if (deadline) clearTimeout(deadline);
        resolve();
      };
      const failIfNotExited = () => {
        if (done) return;
        // A paused supervisor can resume after the child has exited but before
        // its exit listener ran. Terminal child/kernel state wins over the timer;
        // rejecting here would skip stopAll's durable state reconciliation.
        if (childExited()) { finish(); return; }
        done = true;
        child.removeListener('exit', finish);
        reject(new Error(`fleet: stop not confirmed for ${name}`));
      };
      const killTimer = setTimeout(() => {
        if (done) return;
        if (childExited()) { finish(); return; }
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
        if (childExited()) { finish(); return; }
        // Start the confirmation window only after escalation. If the host was
        // paused, the graceful and hard-stop timers must not expire back-to-back
        // before the child's exit can be observed.
        deadline = setTimeout(failIfNotExited, 5_000);
      }, timeout);
      killTimer.unref?.();
      child.once('exit', finish);
      try { child.kill('SIGTERM'); } catch { /* wait for exit or the deadline */ }
    });
  }
}
