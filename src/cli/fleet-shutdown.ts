import { parsePm2Integer } from './pm2-jlist.js';

export type FleetProcessEntry = {
  name: string;
  /** Stable PM2 registry identity. Required for generation-safe compensation. */
  pmId?: number;
  pid: number;
  online: boolean;
  status?: string;
  autorestart?: boolean | string;
  stopExitCodes?: unknown[];
  exitCode?: number;
};

export interface FleetShutdownRuntime {
  signal(pid: number): void;
  /** Optional one-shot initial dispatch. Used when each daemon owns an exact
   * authenticated IPC endpoint: all requests are delivered concurrently inside
   * one bounded helper. Individual refusals must return normally and remain
   * live so the standard fresh compensation path can restore exited peers. */
  signalInitial?(entries: FleetProcessEntry[]): void;
  /** Checked before declaring the quiet fleet successful. A missing exact IPC
   * ACK remains a transaction failure even if that process later crashes; the
   * helper then enters the same fresh compensation path as a live refuser. */
  assertSignalAuthorityComplete?(): void;
  isAlive(pid: number): boolean;
  now(): number;
  sleep(ms: number): void;
  /** Under the caller's cross-process fleet lock, conditionally start only the
   * exact PM2 rows confirmed offline, within the remaining `timeoutMs`. */
  startOffline(entries: FleetProcessEntry[], timeoutMs: number): void;
  /** Return a fresh PM2 projection, completing or failing within `timeoutMs`. */
  list(timeoutMs: number): FleetProcessEntry[];
  /** Must cover PM2 restart_delay so an old autorestart policy cannot publish
   * a successor immediately after the original PID disappears. */
  successorSettleMs?: number;
  pollMs?: number;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function rowsForName(
  entries: FleetProcessEntry[],
  name: string,
): FleetProcessEntry[] {
  return entries.filter(entry => entry.name === name);
}

function isLiveGeneration(
  entry: FleetProcessEntry,
  runtime: FleetShutdownRuntime,
): boolean {
  // OS liveness is authority. PM2 can expose a real launching/stopping PID
  // while its status is not yet `online`; such a generation is never quiet.
  return entry.pid > 0 && runtime.isAlive(entry.pid);
}

export function isFleetEntryProvenFreeOfAutorestartTimer(entry: FleetProcessEntry): boolean {
  if (entry.status === 'errored') return true;
  // PM2 handleExit labels delayed post-exit rows `waiting restart` even when
  // stop_exit_codes/autorestart suppresses creation of restart_task. A bare
  // `stopped` status is not enough: handleExit can publish STOPPED before a
  // zero-delay restart task is installed. Policy fields still do not make
  // launching/stopping/online-dead rows quiescent.
  if (entry.status !== 'waiting restart' && entry.status !== 'stopped') return false;
  if (entry.autorestart === false || entry.autorestart === 'false') return true;
  if (!Number.isFinite(entry.exitCode) || !Array.isArray(entry.stopExitCodes)) return false;
  return entry.stopExitCodes.some(code => parsePm2Integer(code) === entry.exitCode);
}

function rawStopCodeMatchesExitCode(code: unknown, exitCode: number): boolean {
  return (typeof code === 'number' && Number.isSafeInteger(code) && code === exitCode)
    || (typeof code === 'string' && code === String(exitCode));
}

/** Being timer-free is sufficient for initial admission and compensation, but
 * not proof that a signalled generation completed its shutdown transaction.
 * PM2 can mark an abrupt exit `errored` after max_restarts and suppress a
 * successor even though exit_code=0 is not the daemon's graceful sentinel. */
export function isFleetEntryProvenTerminalAfterSignal(entry: FleetProcessEntry): boolean {
  if (entry.status !== 'errored'
      && entry.status !== 'waiting restart'
      && entry.status !== 'stopped') return false;
  if (!Number.isSafeInteger(entry.exitCode) || !Array.isArray(entry.stopExitCodes)) return false;
  return entry.stopExitCodes.some(code => rawStopCodeMatchesExitCode(code, entry.exitCode!));
}

function isProvenInitiallyQuiescent(
  entry: FleetProcessEntry,
  runtime: FleetShutdownRuntime,
): boolean {
  if (isLiveGeneration(entry, runtime)) return false;
  return isFleetEntryProvenFreeOfAutorestartTimer(entry);
}

/** Signal every observed generation in parallel. Success requires a bounded
 * quiet window with no online successor for any target name. If one generation
 * refuses, restore only names proven truly offline and never touch a live
 * refuser or an already-auto-restarted healthy successor. */
export function signalAndAwaitFleet(
  entries: FleetProcessEntry[],
  operation: 'restart' | 'stop',
  timeoutMs: number,
  runtime: FleetShutdownRuntime,
): void {
  const duplicateNames = [...new Set(entries.map(entry => entry.name))]
    .filter(name => entries.filter(entry => entry.name === name).length > 1);
  if (duplicateNames.length > 0) {
    throw new Error(
      `[${operation}] refusing PM2 mutation: duplicate registry row(s) for singleton botmux name(s): `
      + duplicateNames.join(', '),
    );
  }
  const uncertainLive = entries.filter(entry =>
    !entry.online && entry.pid > 0 && runtime.isAlive(entry.pid));
  if (uncertainLive.length > 0) {
    throw new Error(
      `[${operation}] refusing PM2 mutation: non-online registry rows still have live PID(s): `
      + uncertainLive.map(entry => `${entry.name}:${entry.pid}`).join(', '),
    );
  }
  const unverifiedDormant = entries.filter(entry =>
    !isLiveGeneration(entry, runtime) && !isProvenInitiallyQuiescent(entry, runtime));
  if (unverifiedDormant.length > 0) {
    throw new Error(
      `[${operation}] refusing PM2 mutation: dormant registry row(s) may still restart: `
      + unverifiedDormant.map(entry => `${entry.name}:${entry.status ?? 'unknown'}`).join(', '),
    );
  }
  const targets = entries.filter(entry => entry.online && entry.pid > 0);

  const deadline = runtime.now() + Math.max(0, timeoutMs);
  const remainingMs = (): number => Math.max(0, Math.floor(deadline - runtime.now()));
  const listWithinDeadline = (
    purpose: string,
    capMs: number = Number.POSITIVE_INFINITY,
  ): FleetProcessEntry[] => {
    let lastError: unknown;
    for (let attempt = 1; attempt <= 2; attempt++) {
      const budgetMs = remainingMs();
      if (budgetMs <= 0) {
        throw new Error(`fleet deadline exhausted before ${purpose}`);
      }
      try {
        const projection = runtime.list(Math.max(1, Math.min(budgetMs, Math.floor(capMs))));
        if (remainingMs() <= 0) {
          throw new Error(`fleet deadline exhausted during ${purpose}`);
        }
        return projection;
      } catch (error) {
        lastError = error;
        if (remainingMs() <= 0 || attempt === 2) throw error;
      }
    }
    throw lastError;
  };

  // Later PM2 stop/delete mutates every supplied registry name, including
  // initially stopped rows. Every one must remain live-PID-free for the same
  // successor settle window before that name mutation is safe.
  const targetNames = new Set(entries.map(entry => entry.name));
  const signalledPids = new Set<number>();
  const provenTerminalPids = new Set<number>();
  const latestTrackedPidByName = new Map<string, number>();
  const tracked = new Map<number, FleetProcessEntry>();
  const signalGeneration = (entry: FleetProcessEntry): void => {
    if (signalledPids.has(entry.pid)) return;
    signalledPids.add(entry.pid);
    tracked.set(entry.pid, entry);
    latestTrackedPidByName.set(entry.name, entry.pid);
    // The concrete runtime handles a proven ESRCH. Capability/generation
    // authorization failures must escape; swallowing them here could turn a
    // rollout fence into a partially signalled fleet.
    runtime.signal(entry.pid);
  };
  if (runtime.signalInitial) {
    for (const target of targets) {
      signalledPids.add(target.pid);
      tracked.set(target.pid, target);
      latestTrackedPidByName.set(target.name, target.pid);
    }
    runtime.signalInitial(targets);
    if (remainingMs() <= 0) {
      throw new Error(
        `[${operation}] fleet deadline exhausted during bounded initial daemon dispatch; `
        + 'no later fleet action was attempted',
      );
    }
  } else {
    for (const target of targets) {
      if (remainingMs() <= 0) {
        throw new Error(
          `[${operation}] fleet deadline exhausted while signalling initial daemon generations; `
          + 'no later fleet action was attempted',
        );
      }
      signalGeneration(target);
      // A runtime signal implementation is synchronous and may itself consume
      // the remaining budget. Never signal the next target or begin polling
      // after such a late return.
      if (remainingMs() <= 0) {
        throw new Error(
          `[${operation}] fleet deadline exhausted during initial daemon signalling; `
          + 'no later fleet action was attempted',
        );
      }
    }
  }

  const pollMs = Math.max(1, runtime.pollMs ?? 50);
  const successorSettleMs = Math.max(0, runtime.successorSettleMs ?? 3_500);
  // A live refuser is decided early enough to leave one explicitly partitioned
  // compensation tail. All-dead fleets may continue their normal successor
  // settle beyond this point; they need no compensation subprocesses.
  const productionBudget = timeoutMs >= 10_000;
  const compensationReserveMs = productionBudget
    ? Math.min(25_000, Math.max(10_000, Math.floor(timeoutMs / 3)))
    : Math.min(6_000, Math.max(5, Math.floor(timeoutMs / 5)));
  const liveRefusalDeadline = Math.max(runtime.now(), deadline - compensationReserveMs);
  const preProjectionCapMs = productionBudget
    ? Math.max(5_000, Math.floor(compensationReserveMs / 4))
    : Math.max(1, Math.floor(compensationReserveMs / 5));
  const exactStartCapMs = productionBudget
    ? Math.max(10_000, Math.floor(compensationReserveMs / 2))
    : Math.max(1, Math.floor(compensationReserveMs / 2));
  const postProjectionCapMs = preProjectionCapMs;
  const successorProjectionCapMs = preProjectionCapMs;
  let quietSince: number | null = null;
  let verificationFailure: string | null = null;
  let signalAuthorityFailure: string | null = null;
  let terminalOutcomeFailure: string | null = null;

  while (runtime.now() < deadline) {
    const aliveTracked = [...tracked.values()].filter(entry => runtime.isAlive(entry.pid));
    if (aliveTracked.length > 0) {
      quietSince = null;
      if (runtime.now() >= liveRefusalDeadline) break;
      runtime.sleep(Math.min(pollMs, Math.max(1, liveRefusalDeadline - runtime.now())));
      continue;
    }

    let projection: FleetProcessEntry[];
    try {
      projection = listWithinDeadline(
        'PM2 successor verification',
        successorProjectionCapMs,
      );
    } catch (err) {
      verificationFailure = `PM2 successor verification failed: ${errorText(err)}`;
      break;
    }
    const successors = projection.filter(entry =>
      targetNames.has(entry.name)
      && isLiveGeneration(entry, runtime)
      && !signalledPids.has(entry.pid));

    // PM2 restart overlimit is timer-free but not necessarily graceful. Before
    // following a successor or starting the quiet window, prove the terminal
    // outcome of every dead generation that this transaction signalled. A
    // live replacement still carries the prior generation's exit_code, so it
    // may prove that outcome before receiving its own shutdown request.
    let terminalOutcomePending = false;
    for (const [pid, trackedEntry] of tracked) {
      const isLatestTrackedGeneration = latestTrackedPidByName.get(trackedEntry.name) === pid;
      // A predecessor may be cached only after a fresh successor carrying its
      // accepted exit_code was observed and then became the newly signalled
      // generation. The latest generation must re-prove its terminal row on
      // every quiet-window projection; a later missing row is never success.
      if (runtime.isAlive(pid)
          || (provenTerminalPids.has(pid) && !isLatestTrackedGeneration)) continue;
      const sameNameRows = rowsForName(projection, trackedEntry.name);
      const exactRows = Number.isInteger(trackedEntry.pmId)
        ? sameNameRows.filter(row => row.pmId === trackedEntry.pmId)
        : sameNameRows;
      if (exactRows.length !== 1) {
        terminalOutcomePending = true;
        continue;
      }
      const exactState = exactRows[0]!;
      const replacementPublished = exactState.pid > 0 && exactState.pid !== pid;
      const liveReplacementPublished = replacementPublished
        && isLiveGeneration(exactState, runtime);
      const liveReplacementCarriesAcceptedExit = liveReplacementPublished
        && Number.isSafeInteger(exactState.exitCode)
        && Array.isArray(exactState.stopExitCodes)
        && exactState.stopExitCodes.some(code =>
          rawStopCodeMatchesExitCode(code, exactState.exitCode!));
      if (liveReplacementCarriesAcceptedExit) {
        // This cache becomes usable only after signalGeneration records the
        // replacement as this name's latest tracked generation.
        provenTerminalPids.add(pid);
        continue;
      }
      // A dead different-PID row may already contain that replacement's own
      // exit_code, so it can never prove the predecessor's terminal outcome.
      if (!replacementPublished && isFleetEntryProvenTerminalAfterSignal(exactState)) continue;
      const terminalStatus = exactState.status === 'errored'
        || exactState.status === 'waiting restart'
        || exactState.status === 'stopped';
      if (terminalStatus || replacementPublished) {
        terminalOutcomeFailure = `${trackedEntry.name}/${pid} exited without an accepted `
          + `stop_exit_codes terminal (status=${exactState.status ?? 'unknown'}, `
          + `exit_code=${exactState.exitCode ?? 'missing'})`;
        break;
      }
      terminalOutcomePending = true;
    }
    if (terminalOutcomeFailure) break;
    if (terminalOutcomePending) {
      quietSince = null;
      if (runtime.now() >= liveRefusalDeadline) break;
      runtime.sleep(Math.min(pollMs, Math.max(1, liveRefusalDeadline - runtime.now())));
      continue;
    }

    if (successors.length > 0) {
      quietSince = null;
      if (runtime.now() >= liveRefusalDeadline) {
        // This is a positively verified live refuser, not an unreadable fleet.
        // Leave the late generation untouched, but retain it in the refusal
        // accounting and compensate unrelated exact offline originals.
        for (const successor of successors) tracked.set(successor.pid, successor);
        break;
      }
      // A projection can consume its entire subprocess timeout. Never act on
      // an observation returned at or beyond the absolute fleet deadline.
      if (remainingMs() <= 0) {
        verificationFailure = 'fleet deadline exhausted before signalling a PM2 successor';
        break;
      }
      for (const successor of successors) {
        if (remainingMs() <= 0) {
          verificationFailure = 'fleet deadline exhausted while signalling PM2 successors';
          break;
        }
        signalGeneration(successor);
      }
      if (verificationFailure) break;
      continue;
    }

    // No live PID is not enough: PM2 may still own a delayed restart_task or a
    // launching/stopping transition. Do not begin the quiet window until every
    // visible target row proves that no successor timer exists.
    const unprovenDormant = projection.filter(entry =>
      targetNames.has(entry.name)
      && !isLiveGeneration(entry, runtime)
      && !isFleetEntryProvenFreeOfAutorestartTimer(entry));
    if (unprovenDormant.length > 0) {
      quietSince = null;
      if (runtime.now() >= liveRefusalDeadline) break;
      runtime.sleep(Math.min(pollMs, Math.max(1, liveRefusalDeadline - runtime.now())));
      continue;
    }

    const now = runtime.now();
    quietSince ??= now;
    if (now - quietSince >= successorSettleMs) {
      try { runtime.assertSignalAuthorityComplete?.(); }
      catch (error) {
        signalAuthorityFailure = errorText(error);
        break;
      }
      return;
    }
    runtime.sleep(Math.min(pollMs, Math.max(1, deadline - now)));
  }

  const liveSignalled = [...tracked.values()].filter(entry => runtime.isAlive(entry.pid));
  const refusal = `[${operation}] ${liveSignalled.length}/${targetNames.size} daemon generation(s) `
    + `refused or could not be verified within ${timeoutMs}ms`
    + (signalAuthorityFailure ? ` (signal authority: ${signalAuthorityFailure})` : '')
    + (terminalOutcomeFailure
      ? ` (post-signal terminal proof: ${terminalOutcomeFailure})`
      : '');
  if (verificationFailure) {
    throw new Error(
      `${refusal}; fleet state is unverified and no compensation was attempted `
      + `(${verificationFailure})`,
    );
  }

  // A refusal path must fresh-read BEFORE any mutation. The old original-PID
  // projection is not authority: PM2 may already have published a healthy
  // successor for a peer that exited.
  let beforeCompensation: FleetProcessEntry[];
  try {
    beforeCompensation = listWithinDeadline(
      'PM2 verification before compensation',
      preProjectionCapMs,
    );
  } catch (err) {
    throw new Error(
      `${refusal}; fleet state is unverified and no compensation was attempted `
      + `(PM2 verification before compensation failed: ${errorText(err)})`,
    );
  }
  const offlineEntries = targets
    .map(target => {
      if (runtime.isAlive(target.pid)) return false;
      const sameNameRows = rowsForName(beforeCompensation, target.name);
      if (sameNameRows.some(state => isLiveGeneration(state, runtime))) return false;
      // Compensation is allowed only against the exact original PM2 row.
      // If it was deleted/recreated (or the projection omitted pm_id), there
      // is no race-free way to recreate it by name.
      if (!Number.isInteger(target.pmId)) return false;
      if (sameNameRows.length !== 1 || sameNameRows[0]!.pmId !== target.pmId) return false;
      const exactState = sameNameRows[0]!;
      if (!exactState || !isFleetEntryProvenFreeOfAutorestartTimer(exactState)) return false;
      // God.startProcessId does not clear restart_task. Restrict compensation
      // to rows whose exit policy proves PM2 could not have scheduled one.
      return exactState;
    })
    .filter((entry): entry is FleetProcessEntry => !!entry);
  const offlineNames = offlineEntries.map(entry => entry.name);

  const compensationErrors: string[] = [];
  if (offlineEntries.length > 0) {
    try {
      const compensationBudgetMs = remainingMs();
      if (compensationBudgetMs <= 0) {
        throw new Error('fleet deadline exhausted before compensation');
      }
      runtime.startOffline(
        offlineEntries,
        Math.min(compensationBudgetMs, exactStartCapMs),
      );
      if (remainingMs() <= 0) {
        throw new Error('fleet deadline exhausted during compensation');
      }
    }
    catch (err) { compensationErrors.push(errorText(err)); }
  }

  let afterCompensation: FleetProcessEntry[] = [];
  try {
    afterCompensation = listWithinDeadline(
      'PM2 verification after compensation',
      postProjectionCapMs,
    );
  }
  catch (err) {
    compensationErrors.push(`PM2 verification after compensation failed: ${errorText(err)}`);
  }
  const unavailable = targets
    .filter(target => {
      if (runtime.isAlive(target.pid)) return false;
      return !rowsForName(afterCompensation, target.name)
        .some(state => isLiveGeneration(state, runtime));
    })
    .map(target => target.name);

  if (unavailable.length > 0 || compensationErrors.length > 0) {
    throw new Error(
      `${refusal}; fleet is partially stopped`
      + (unavailable.length > 0 ? ` (offline: ${unavailable.join(', ')})` : '')
      + (compensationErrors.length > 0
        ? ` (restore errors: ${compensationErrors.join('; ')})`
        : ''),
    );
  }
  throw new Error(
    `${refusal}; restored ${offlineNames.length} offline PM2 `
    + `entr${offlineNames.length === 1 ? 'y' : 'ies'} and left every live generation untouched`,
  );
}
