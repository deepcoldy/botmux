/**
 * Bounded anti-fork gate around tmux `new-session` boot sites.
 *
 * Measured (tmux 3.0a): remove a live server's socket file and the very next
 * `new-session` returns rc 0 having already forked a competing server — so the
 * gate runs BEFORE every new-session, including the first attempt. It also
 * closes the macOS (3.6a) client-internal ECONNREFUSED fork by prepending the
 * `-N` never-start flag to the spawn argv when a listener is present.
 *
 * Never kills a process (SIGUSR1 in the core is socket recovery) and never
 * unlinks a socket.
 */

import { resolveBootDirective } from '../../core/tmux-server-guard.js';
import type { BootDirective } from '../../core/tmux-server-guard.js';
import { logger } from '../../utils/logger.js';

/** Bound-but-silent owner never answered in time. Coded ETIMEDOUT so the
 *  worker/daemon startup classifiers treat it as transient and retry later. */
export class TmuxCompetingServerBlockedError extends Error {
  code = 'ETIMEDOUT' as const;
  constructor(socketLabel: string, reason: string) {
    super(`live tmux server still owns ${socketLabel} but is unreachable; refusing to boot a competing server: ${reason}`);
    this.name = 'TmuxCompetingServerBlockedError';
  }
}

function sleepSyncMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Inside the existing new-session envelope (3 × 5 s attempts + 1 s + 3 s). */
const BOOT_GATE_BUDGET_MS = 8_000;
const BOOT_GATE_POLL_MS = 500;

export interface TmuxBootGate {
  /**
   * Decide whether a booting new-session may run now. Returns the leading argv
   * to prepend: `[]` for a normal (possibly cold-boot) spawn, `['-N']` for an
   * attach-only spawn that must never fork. Blocks with bounded synchronous
   * waits while a live listener is unreachable; throws
   * {@link TmuxCompetingServerBlockedError} if it stays unreachable.
   */
  leadingArgs(): string[];
}

export interface CreateBootGateOptions {
  budgetMs?: number;
  pollMs?: number;
  platform?: NodeJS.Platform;
  /** The EXACT environment the new-session exec will use. The gate must probe
   *  the owner, resolve the -N capability and compute the socket path from the
   *  same PATH/TMUX_TMPDIR the spawn uses — the daemon ambient env can resolve
   *  a different tmux binary/socket than the pane launch. Defaults to
   *  process.env (the diagnostic/attach paths are ambient on both sides). */
  env?: NodeJS.ProcessEnv;
  resolve?: (socketName: string | undefined) => BootDirective;
  sleep?: (ms: number) => void;
  now?: () => number;
}

/** Re-probe cadence. The macOS census is a full bounded `lsof -U` spawn, so on
 *  darwin probes are spaced ≥2 s apart to avoid piling heavy lsof calls under
 *  load; Linux /proc reads are cheap and keep the short interval. */
const BOOT_GATE_POLL_MS_DARWIN = 2_000;

export function createTmuxBootGate(
  socketName: string | undefined,
  opts: CreateBootGateOptions = {},
): TmuxBootGate {
  const budgetMs = opts.budgetMs ?? BOOT_GATE_BUDGET_MS;
  const platform = opts.platform ?? process.platform;
  const pollMs = opts.pollMs ?? (platform === 'darwin' ? BOOT_GATE_POLL_MS_DARWIN : BOOT_GATE_POLL_MS);
  const sleep = opts.sleep ?? sleepSyncMs;
  const now = opts.now ?? (() => Date.now());
  // Resolve under the spawn env so owner probe / -N capability / socket path
  // all describe the same tmux the launch will actually exec.
  const gateEnv = opts.env ?? process.env;
  const resolve = opts.resolve ?? ((name) => resolveBootDirective(name, { env: gateEnv }));
  const label = socketName ? `-L ${socketName}` : 'default server';
  const deadline = now() + budgetMs;
  let loggedWaiting = false;

  return {
    leadingArgs(): string[] {
      for (;;) {
        const directive = resolve(socketName);

        if (directive.mode === 'spawn') return directive.noFork ? ['-N'] : [];

        // The deadline check MUST cover the recreate-socket arm too. A server
        // that ignores SIGUSR1 (wedged, or its socket directory was removed so
        // the re-bind can never succeed) keeps the census reporting the same
        // single bmx listener with the path still ENOENT, so the directive
        // repeats forever. Measured before this guard: an unbounded synchronous
        // loop that never returns — the worker hangs instead of failing into the
        // 15/60/180 s retry, and every cycle logs a SIGUSR1 warning.
        const remaining = deadline - now();
        if (remaining <= 0) {
          // Surface as a transient startup failure → the worker's retryable
          // card and the daemon's bounded auto-retry (visible to the operator).
          // Deliberately "fail rather than fork".
          const reason = directive.mode === 'wait'
            ? directive.reason
            : `sent SIGUSR1 to botmux server pid=${directive.pid} but its socket never became reachable`;
          logger.warn(`[tmux-anti-fork] ${label}: still bound-but-unreachable after ${budgetMs}ms; failing this attempt rather than forking`);
          throw new TmuxCompetingServerBlockedError(label, reason);
        }

        // The core just asked the orphaned botmux server to recreate its
        // socket (SIGUSR1); give it a beat and re-probe. No fork happened.
        if (directive.mode === 'recreate-socket') {
          logger.warn(`[tmux-anti-fork] ${label}: sent SIGUSR1 to orphaned server pid=${directive.pid} to recreate its socket; re-probing`);
          sleep(Math.min(pollMs, remaining));
          continue;
        }

        if (directive.mode === 'wait' && directive.unprotected) {
          // No -N and no SIGUSR1 recovery here (e.g. macOS tmux < 3.2): holding
          // avoids a deliberate cold boot but CANNOT stop the tmux client from
          // forking its own server on ECONNREFUSED. Warn every cycle so the
          // operator is not lulled into thinking the fork is prevented.
          logger.warn(`[tmux-anti-fork] ${label}: UNPROTECTED on this tmux/platform (no -N, no socket recovery); a busy-server client fork is possible. ${directive.reason}`);
        } else if (!loggedWaiting) {
          logger.warn(`[tmux-anti-fork] ${label}: ${directive.reason}; holding new-session (no competing server)`);
          loggedWaiting = true;
        }
        sleep(Math.min(pollMs, remaining));
      }
    },
  };
}
