/**
 * Fleet supervisor — LIVE layer (owns spawn/kill/fs/timers). Replaces pm2's God
 * daemon for the multi-bot fleet. One `FleetSupervisor` process (the `__supervisor`
 * entry) spawns each bot's daemon as a `__daemon` child, monitors exits, and
 * applies the pure policy decisions (restart-with-backoff / stop / park). All
 * state goes through fleet-state-store (atomic + locked). Boot persistence stays
 * with systemd/launchd, which re-run `botmux start`.
 *
 * Safety decisions (graceful-exit, max_restarts, projection identity, idempotent
 * start, generation addressing) come from fleet-supervisor-policy — this layer
 * only does the I/O the policy tells it to.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { openSync, closeSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { resolveEntrySpawn, type BotmuxEntry } from './self-spawn.js';
import {
  decideOnExit,
  freshProc,
  planStart,
  DEFAULT_RESTART_POLICY,
  type FleetProcState,
  type RestartPolicy,
  type ChildExit,
} from './fleet-supervisor-policy.js';
import { mutateFleetState, readFleetState } from './fleet-state-store.js';
import type { FleetCommand } from './fleet-command-queue.js';

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
}

/** True if a pid is alive (kill -0). pid<=1 is never a real supervised child. */
export function pidAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 1) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export class FleetSupervisor {
  private readonly children = new Map<string, ChildProcess>();
  /** Per-name generation the live child was spawned with — guards stale exits. */
  private readonly liveGeneration = new Map<string, number>();
  private readonly restartTimers = new Map<string, ReturnType<typeof setTimeout>>();
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
    this.killTimeoutMs = opts.killTimeoutMs ?? 8000;
    this.log = opts.log ?? ((m) => console.error(`[fleet-supervisor] ${m}`));
  }

  /** Start (or reconcile) the fleet: spawn every configured bot not already
   *  alive. Idempotent — an already-live child (per state + kill -0) is left be.
   *  This is both the initial start and the resurrect path. */
  start(bots: readonly FleetBotSpec[]): void {
    const specByName = new Map(bots.map((b) => [b.name, b]));
    // Remember the spec set so queued start-bot/stop-bot can resolve name→spec.
    this.knownSpecs.clear();
    for (const b of bots) this.knownSpecs.set(b.name, b);
    // A full fleet start clears any explicit-stop marks — `botmux start` means
    // "bring everything up", overriding a prior single-bot stop.
    this.explicitStop.clear();
    // Record our supervisor identity + reconcile the persisted proc set against
    // reality before deciding what to (re)spawn.
    mutateFleetState(this.opts.statePath, (cur) => {
      // Refresh the start time whenever a NEW supervisor takes over (pid differs
      // from the one on record); a plain `||` would pin it to the first-ever
      // start forever, so status/uptime would misreport across restarts. Keep it
      // only when the SAME supervisor re-reconciles (idempotent re-start).
      const priorPid = cur.supervisorPid;
      if (priorPid !== process.pid || !cur.supervisorStartedAt) {
        cur.supervisorStartedAt = new Date().toISOString();
      }
      cur.supervisorPid = process.pid;
      // Drop procs no longer configured; mark dead 'online' procs as such so
      // planStart re-spawns them (reconcile after a supervisor restart).
      cur.procs = cur.procs.filter((p) => specByName.has(p.name));
      for (const p of cur.procs) {
        if (p.status === 'online' && !pidAlive(p.pid)) { p.pid = 0; p.status = 'stopped'; }
      }
      return cur;
    });

    const current = readFleetState(this.opts.statePath)?.procs ?? [];
    const toStart = planStart([...specByName.keys()], current, (p) => p.status === 'online' && pidAlive(p.pid));
    for (const name of toStart) {
      const spec = specByName.get(name);
      if (spec) this.spawnBot(spec, /* isRestart */ false);
    }
  }

  /** Start (or reconcile) ONE bot without touching the rest — the live side of
   *  `botmux start-bot`. Idempotent: a no-op if that bot is already online+alive.
   *  Registers the spec so a later exit is handled with the right identity, and
   *  clears any explicit-stop mark (an explicit start overrides a prior stop). */
  startOneBot(spec: FleetBotSpec): void {
    if (this.stopping) return;
    this.knownSpecs.set(spec.name, spec);
    this.explicitStop.delete(spec.name);
    const proc = readFleetState(this.opts.statePath)?.procs.find((p) => p.name === spec.name);
    if (proc && proc.status === 'online' && pidAlive(proc.pid) && this.children.has(spec.name)) {
      this.log(`start-bot ${spec.name}: already online (pid ${proc.pid})`);
      return;
    }
    this.spawnBot(spec, /* isRestart */ false);
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
      const spec: FleetBotSpec = { name: cmd.name, appId: cmd.appId, botIndex: cmd.botIndex };
      if (cmd.op === 'start-bot') {
        this.startOneBot(spec);
      } else {
        await this.stopOneBot(cmd.name);
      }
    }
  }

  private spawnBot(spec: FleetBotSpec, isRestart: boolean): void {
    if (this.stopping) return;
    const entry = spec.entry ?? 'daemon';
    const { command, args } = resolveEntrySpawn(entry, this.opts.distDir);
    // node_args (heap/diag) apply only to the Node path; a compiled binary has
    // no separate interpreter args. resolveEntrySpawn already picks the shape;
    // we prepend node_args only when the command is a node/JS invocation.
    const isStandalone = args.length > 0 && args[0].startsWith('__');
    const nodeArgs = isStandalone ? [] : (this.opts.daemonNodeArgs ?? []);
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
        outFd = openSync(join(this.opts.logDir, `${logBase}-out.log`), 'a');
        errFd = openSync(join(this.opts.logDir, `${logBase}-err.log`), 'a');
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
    const childEnv: NodeJS.ProcessEnv = entry === 'daemon'
      ? { ...this.opts.daemonEnv, BOTMUX_BOT_INDEX: String(spec.botIndex) }
      : { ...this.opts.daemonEnv };
    const child = spawn(command, [...nodeArgs, ...args], {
      cwd: this.opts.cwd,
      stdio,
      env: childEnv,
      windowsHide: true,
    });
    // The child dup'd the fds; close our copies so we don't leak one per respawn.
    if (outFd !== undefined) { try { closeSync(outFd); } catch { /* */ } }
    if (errFd !== undefined) { try { closeSync(errFd); } catch { /* */ } }
    const now = new Date().toISOString();

    // Persist the new generation + pid atomically, bumping generation on restart.
    const generation = mutateFleetState(this.opts.statePath, (cur) => {
      const existing = cur.procs.find((p) => p.name === spec.name);
      if (existing) {
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
        // count and be parked one crash later instead of getting a full budget.
        if (!isRestart) existing.restarts = 0;
      } else {
        cur.procs.push({ ...freshProc(spec.name, spec.appId, child.pid ?? 0, now) });
      }
      return cur;
    }).procs.find((p) => p.name === spec.name)!.generation;

    this.children.set(spec.name, child);
    this.liveGeneration.set(spec.name, generation);
    this.log(`${isRestart ? 'restarted' : 'started'} ${spec.name} (pid ${child.pid}, gen ${generation})`);

    child.on('exit', (code, signal) => this.onChildExit(spec, generation, { code, signal }));
    child.on('error', (err) => {
      this.log(`${spec.name} spawn error: ${err.message}`);
      this.onChildExit(spec, generation, { code: 1, signal: null });
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
    const decision = decideOnExit({ restarts: current?.restarts ?? 0 }, exit, this.policy);

    if (decision.action === 'stop') {
      this.log(`${spec.name} exited cleanly (graceful); not restarting`);
      this.markStopped(spec.name, exit, 'stopped');
      return;
    }
    if (decision.action === 'park') {
      this.log(`${spec.name} exceeded max_restarts (${decision.atRestarts}); parking errored`);
      this.markStopped(spec.name, exit, 'errored');
      return;
    }
    // restart: record the bump, then respawn after the backoff.
    mutateFleetState(this.opts.statePath, (cur) => {
      const p = cur.procs.find((x) => x.name === spec.name);
      if (p) { p.restarts = decision.nextRestarts; p.status = 'launching'; p.pid = 0; p.lastExitCode = exit.code; }
      return cur;
    });
    this.log(`${spec.name} crashed (code=${exit.code} signal=${exit.signal}); restart ${decision.nextRestarts}/${this.policy.maxRestarts} in ${this.policy.restartDelayMs}ms`);
    // The restart timer MUST keep the event loop alive: when the crashed child
    // was the supervisor's only live handle, an unref'd timer would let the loop
    // drain and the supervisor would exit mid-backoff — never respawning the bot
    // (observed under bun: single-bot fleet, child crashloops, supervisor dies
    // after scheduling the first restart). A ref'd timer holds the process until
    // the respawn fires. (stopOne's kill timer stays unref'd — it's a shutdown
    // safety net that must NOT keep the loop alive.)
    const timer = setTimeout(() => { this.restartTimers.delete(spec.name); this.spawnBot(spec, true); }, this.policy.restartDelayMs);
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
   *  Finalizes fleet-state (all procs stopped, supervisorPid cleared) so a later
   *  `status` reflects reality — onChildExit is short-circuited while stopping. */
  async stopAll(): Promise<void> {
    this.stopping = true;
    for (const t of this.restartTimers.values()) clearTimeout(t);
    this.restartTimers.clear();
    const pending = [...this.children.entries()];
    await Promise.all(pending.map(([name, child]) => this.stopOne(name, child)));
    // Reflect the stop in the durable record. onChildExit ignored these exits
    // (stopping=true), so without this the state file would keep the now-dead
    // pids as 'online'. Clear supervisorPid too: this supervisor is exiting.
    mutateFleetState(this.opts.statePath, (cur) => {
      for (const p of cur.procs) {
        if (p.status === 'online' || p.status === 'launching') { p.status = 'stopped'; p.pid = 0; }
      }
      cur.supervisorPid = 0;
      return cur;
    });
  }

  private stopOne(name: string, child: ChildProcess): Promise<void> {
    return new Promise((resolve) => {
      let done = false;
      const finish = () => { if (done) return; done = true; clearTimeout(killTimer); resolve(); };
      const killTimer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* already gone */ } }, this.killTimeoutMs);
      killTimer.unref?.();
      child.once('exit', finish);
      try { child.kill('SIGTERM'); } catch { finish(); }
    });
  }
}
