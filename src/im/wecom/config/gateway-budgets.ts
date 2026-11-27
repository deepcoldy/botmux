/**
 * Shutdown and wait budgets of a WeCom gateway (`botmux wecom`) and the
 * dedicated core it manages. Constants only (one of them is the desired-state
 * file's lock wait, taken from that module): the fleet side may import them to
 * size the gateway member's kill timeout without loading gateway code.
 *
 * Parts of a gateway shutdown (gateway/command.ts), however it begins — SIGTERM,
 * a terminal disconnect, the fatal-error guard, the core exiting on its own, a
 * stop while the core is still starting:
 *   1. the core — told to stop the moment the shutdown begins (stopping aborts
 *      the core's start signal, which managed-core.ts keeps listening to): its
 *      own graceful shutdown, then SIGKILL and a short wait for it to go;
 *   2. only for a reason retrying cannot fix (replaced, authentication failed):
 *      recording the connection as `stopped` (gateway/desired-stop.ts), right
 *      after the core was told to stop; it may wait for the desired-state
 *      file's lock;
 *   3. the drain, after that — the in-flight dispatch tick (each core request
 *      times out at 15 s) and Dashboard session actions on the control server
 *      (25 s), cut off at its budget — and then the wait for the same core stop
 *      as in 1 (managed-core.ts hands every caller one stop);
 *   4. a small overhead for the transport, the runtime record and the exit.
 * 1 runs alongside 2 and 3, so the longest shutdown is the longer of the two
 * plus 4, not the sum of all. A shutdown that begins while the core is still
 * starting has nothing to drain yet and waits only for the core (a reclaim of
 * the previous generation's core is cut short by the same abort); one that
 * begins with the core gone only drains; the fatal-error guard waits only for
 * the core.
 */
import {
  DEFAULT_REMOTE_SHUTDOWN_DRAIN_TIMEOUT_MS,
  FLEET_DAEMON_KILL_SLACK_MS,
  deriveShutdownBudgets,
} from '../../../core/shutdown-budgets.js';
import { WECOM_FLEET_DESIRED_STATE_LOCK_WAIT_MS } from './fleet-desired-state.js';

/**
 * SIGTERM → SIGKILL window for the managed core: the same window the fleet
 * supervisor gives a bot daemon. The core is started with every `BOTMUX_*`
 * variable removed (managed-core-env.ts), so its remote-drain budget is always
 * the default one and is derived from that, not from the gateway's own env.
 */
export const WECOM_MANAGED_CORE_STOP_GRACE_MS =
  deriveShutdownBudgets(DEFAULT_REMOTE_SHUTDOWN_DRAIN_TIMEOUT_MS).fleetDaemonKillTimeoutMs;

/** How long a SIGKILLed core may take to disappear before the stop is reported failed. */
export const WECOM_MANAGED_CORE_KILL_WAIT_MS = 5_000;

/** Bound on step 3's drain; past it the gateway stops waiting for it. */
export const WECOM_GATEWAY_DRAIN_BUDGET_MS = 26_000;

export const WECOM_GATEWAY_SHUTDOWN_OVERHEAD_MS = 2_000;

/** Step 2: what the stop record may take — the desired-state writer's own
 *  wait for its file lock (config/fleet-desired-state.ts), after which it gives up. */
export const WECOM_GATEWAY_DESIRED_STOP_WRITE_MS = WECOM_FLEET_DESIRED_STATE_LOCK_WAIT_MS;

/**
 * Longest a gateway takes to exit once its shutdown begins (SIGTERM, a fatal
 * error, a terminal disconnect, …): the core's whole stop, or the stop record
 * followed by the whole drain, whichever is longer — they run at the same
 * time — plus the overhead.
 */
export const WECOM_GATEWAY_SHUTDOWN_MAX_MS =
  Math.max(
    WECOM_MANAGED_CORE_STOP_GRACE_MS + WECOM_MANAGED_CORE_KILL_WAIT_MS,
    WECOM_GATEWAY_DESIRED_STOP_WRITE_MS + WECOM_GATEWAY_DRAIN_BUDGET_MS,
  )
  + WECOM_GATEWAY_SHUTDOWN_OVERHEAD_MS;

/** SIGTERM → SIGKILL budget a supervisor must give a gateway member. */
export const WECOM_GATEWAY_KILL_TIMEOUT_MS = WECOM_GATEWAY_SHUTDOWN_MAX_MS + FLEET_DAEMON_KILL_SLACK_MS;

/**
 * How long a supervised gateway waits for its bot's instance lock. The
 * supervisor may start the next generation before the previous one has exited;
 * the previous one releases the lock at the latest when it finishes its
 * shutdown or is SIGKILLed at the kill timeout. A holder still there after
 * this is not a fleet generation.
 */
export const WECOM_GATEWAY_SUPERVISED_LOCK_WAIT_MS = WECOM_GATEWAY_KILL_TIMEOUT_MS + 1_000;
