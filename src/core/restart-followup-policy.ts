import { traexAutoModelPolicyKey, type TraexAutoModelConfig, type TraexAutoModelSettings } from '../services/traex-auto-model.js';

/**
 * Worker restart follow-up policy — pure decision for whether an in-flight
 * `restartCliProcess()` must chain one more restart when its continuation
 * completes.
 *
 * Two independent hazards make a single restart insufficient:
 *
 *  1. **cwd-move landed after the config snapshot.** A role-switch `restart`
 *     that arrives after `restartCfg` was snapshotted (but before spawn
 *     finished) updated `lastInitConfig.workingDir` while the CLI is coming up
 *     in the OLD cwd — daemon record and process diverge. Detect by comparing
 *     the workingDir we actually spawned with the current `lastInitConfig`.
 *
 *  2. **The replacement generation exited during the in-flight window.** The
 *     `cliRestartInProgress` gate covers spawnCli() AND the trailing
 *     `prepareCodexNativeTitleGeneration()` (Codex resume + native title ≈
 *     several seconds). If the freshly-spawned CLI dies inside it, its onExit
 *     nulls `backend` SYNCHRONOUSLY, so by continuation time `!backendAlive` is
 *     the ground truth that the replacement is gone. The daemon's auto-restart
 *     `restart` IPC (swallowed by the merge guard) is NOT needed as a signal —
 *     and must not be used: a `restart` message carries no trustworthy source,
 *     so a healthy duplicate `/restart` (double click, two `/restart`s) during
 *     the window is indistinguishable from a crash auto-restart. Treating a
 *     merged request as recovery would force a second restart on a HEALTHY
 *     generation, burn the tier-2 budget, and drop `--resume` → context lost —
 *     re-creating exactly what the merge guard exists to prevent. So recovery
 *     keys ONLY on `!backendAlive`.
 *
 * Extracted from worker.ts (a process entrypoint that can't be unit-tested
 * without installing IPC/signal handlers) so the branch order and the
 * budget-skip decision have an executable test surface — the same rationale
 * as inject-queue-policy.ts.
 */
export interface RestartFollowupInput {
  /** workingDir captured into `restartCfg` at spawn time (undefined if lastInitConfig was absent). */
  spawnedWorkingDir: string | undefined;
  /** current lastInitConfig.workingDir after the spawn (undefined if lastInitConfig absent). */
  currentWorkingDir: string | undefined;
  /** false once the replacement CLI's onExit ran during the in-flight window
   *  (onExit sets `backend = null` synchronously). The ONLY recovery signal. */
  backendAlive: boolean;
  /** Launch settings the in-flight replacement was built from (captured with
   *  `restartCfg`). */
  spawnedLaunch?: RestartLaunchSettings;
  /** Launch settings asked for by the latest correlated restart folded into
   *  this window AFTER `spawnedLaunch` was captured (see foldRestartIntoWindow).
   *  Captured when that request landed — never read live, so the per-message
   *  model refresh cannot keep re-triggering convergence. */
  requestedLaunch?: RestartLaunchSettings;
}

export type RestartFollowupDecision =
  | { kind: 'none' }
  /** A merged cwd-move diverged from the spawned cwd — respawn to converge.
   *  `skipRestartBudget` is true ONLY when the replacement is still alive (a
   *  pure user-initiated move). If the replacement also DIED, this is real
   *  crash recovery wearing a cwd-move hat: converge the cwd but still COUNT
   *  the budget so a crashing replacement can't hide behind a directory change. */
  | { kind: 'cwd-move'; skipRestartBudget: boolean }
  /** A restart folded in after the snapshot asked for different env / model /
   *  larkToolBinding — the same convergence respawn as cwd-move (same budget
   *  rule), so the replacement that settles the request runs what it asked for. */
  | { kind: 'launch-config'; skipRestartBudget: boolean }
  /** Replacement exited during the in-flight window — recover. Genuine crash
   *  recovery → COUNTS toward tier-2 FRESH (skipRestartBudget: false). */
  | { kind: 'replacement-recovery'; skipRestartBudget: false };

/**
 * Decide whether the just-finished in-flight restart must chain another.
 *
 * Order matters and is load-bearing:
 *  - cwd-move convergence is checked FIRST so the directory target stays
 *    authoritative. It re-spawns with the newest workingDir; a replacement
 *    that also died is re-evaluated by that new restart's own continuation.
 *    Budget is skipped only if the backend is alive (pure move); a dead
 *    backend means we must NOT lose the crash evidence, so count it.
 *  - Otherwise, a dead replacement recovers via a plain restart (which reuses
 *    `{...lastInitConfig}`, preserving any converged cwd), budgeted.
 *  - A healthy generation with no cwd move needs nothing — crucially, a merged
 *    duplicate restart is NOT a follow-up trigger (see the header note).
 */
export function decideRestartFollowup(input: RestartFollowupInput): RestartFollowupDecision {
  const cwdMoved =
    input.spawnedWorkingDir !== undefined &&
    input.currentWorkingDir !== undefined &&
    input.currentWorkingDir !== input.spawnedWorkingDir;
  if (cwdMoved) return { kind: 'cwd-move', skipRestartBudget: input.backendAlive };
  if (
    input.spawnedLaunch && input.requestedLaunch
    && !sameRestartLaunchSettings(input.spawnedLaunch, input.requestedLaunch)
  ) {
    return input.requestedLaunch.workingDir !== input.spawnedLaunch.workingDir
      ? { kind: 'cwd-move', skipRestartBudget: input.backendAlive }
      : { kind: 'launch-config', skipRestartBudget: input.backendAlive };
  }
  if (!input.backendAlive) return { kind: 'replacement-recovery', skipRestartBudget: false };
  return { kind: 'none' };
}

/** The launch settings a `restart` request can change (see the worker's
 *  `case 'restart'`): what a replacement must run to satisfy that request. */
export interface RestartLaunchSettings extends TraexAutoModelSettings {
  workingDir?: string;
  env?: Record<string, string>;
  envUnset?: string[];
  envFingerprint?: string;
  traexAutoModel?: TraexAutoModelConfig;
  model?: string;
  larkToolBinding?: boolean;
  codexRpcInput?: boolean;
}

export function restartLaunchSettings(cfg: RestartLaunchSettings | null | undefined): RestartLaunchSettings {
  return {
    workingDir: cfg?.workingDir,
    env: cfg?.env,
    envUnset: cfg?.envUnset,
    envFingerprint: cfg?.envFingerprint,
    traexAutoModel: cfg?.traexAutoModel,
    reasoningEffort: cfg?.reasoningEffort,
    modelBackendVariant: cfg?.modelBackendVariant,
    model: cfg?.model,
    larkToolBinding: cfg?.larkToolBinding,
    codexRpcInput: cfg?.codexRpcInput,
  };
}

/** Value equality for env maps (key order irrelevant; absent ≡ undefined). */
export function sameRestartEnv(a: Record<string, string> | undefined, b: Record<string, string> | undefined): boolean {
  if (!a || !b) return !a && !b;
  const keys = Object.keys(a).sort();
  const other = Object.keys(b).sort();
  return keys.length === other.length
    && keys.every((key, index) => key === other[index] && a[key] === b[key]);
}

/** Value equality of restart launch settings. */
export function sameRestartLaunchSettings(a: RestartLaunchSettings, b: RestartLaunchSettings): boolean {
  return (a.workingDir ?? undefined) === (b.workingDir ?? undefined)
    && sameRestartEnv(a.env, b.env)
    && sameRestartEnv(Object.fromEntries((a.envUnset ?? []).map(key => [key, ''])),
      Object.fromEntries((b.envUnset ?? []).map(key => [key, ''])))
    && a.envFingerprint === b.envFingerprint
    && (a.traexAutoModel ? traexAutoModelPolicyKey(a.traexAutoModel) : undefined)
      === (b.traexAutoModel ? traexAutoModelPolicyKey(b.traexAutoModel) : undefined)
    && a.reasoningEffort === b.reasoningEffort
    && a.modelBackendVariant === b.modelBackendVariant
    && (a.model ?? undefined) === (b.model ?? undefined)
    && (a.larkToolBinding ?? undefined) === (b.larkToolBinding ?? undefined)
    && a.codexRpcInput === b.codexRpcInput;
}

export type MergedRestartDisposition = 'adopt' | 'converge';

/**
 * A correlated restart landed while a restart window (owned restart, its
 * continuation, or a Codex auto-upgrade) is in flight and was folded into it.
 * Can the window's replacement settle it?
 *
 *  - `adopt`: the replacement is (or, before the window captured its launch
 *    snapshot, will be) built from exactly what the request asks for — settle
 *    it on that replacement's prompt, as before.
 *  - `converge`: the snapshot is already taken and differs by value, or an
 *    earlier folded request is already waiting to converge (later requests
 *    ride the same convergence so the newest attempt id and settings win).
 *    The window's replacement must NOT settle it: after the window, one more
 *    respawn from the latest settings runs, and only its replacement does.
 */
export function classifyMergedRestart(input: {
  windowLaunch: RestartLaunchSettings | undefined;
  requested: RestartLaunchSettings;
  convergencePending: boolean;
}): MergedRestartDisposition {
  if (input.convergencePending) return 'converge';
  if (input.windowLaunch && !sameRestartLaunchSettings(input.windowLaunch, input.requested)) return 'converge';
  return 'adopt';
}

/**
 * After a verified Codex auto-upgrade pass: must another restore pass follow
 * (same upgrade context: verified executable, exact thread, preserved queues,
 * verification) before a folded restart can be settled?
 *
 * The upgrade replacement runs its own snapshot (`upgradeLaunch`; model is
 * deliberately not passed). A restart folded into the upgrade window asked for
 * `restartRequested`; if that differs by value, converge — the upgrade's prompt
 * cannot vouch for it. Independently, a cwd / env change (by value) since the
 * snapshot always converges: it used to fail the upgrade and leave input closed.
 * Without a folded restart, model / tool-binding drift (the per-message model
 * refresh) keeps its "next spawn" semantics and does not trigger a respawn.
 */
export function decideUpgradeLaunchConvergence(input: {
  upgradeLaunch: RestartLaunchSettings;
  current: RestartLaunchSettings;
  restartRequested: RestartLaunchSettings | undefined;
}): boolean {
  if (input.restartRequested && !sameRestartLaunchSettings(input.upgradeLaunch, input.restartRequested)) return true;
  return (input.current.workingDir ?? undefined) !== (input.upgradeLaunch.workingDir ?? undefined)
    || !sameRestartEnv(input.current.env, input.upgradeLaunch.env);
}

/**
 * Settle an in-flight durable turn that a restart is about to interrupt —
 * the P1 ordering, made unit-testable via dependency injection.
 *
 * The restart `case` kills the CLI, so a durable turn (VC-meeting delivery /
 * silent-schedule) that was executing dies with it. We must emit a terminal
 * receipt or the daemon lease watchdog only settles it after a slow timeout.
 * But emitting a blind `ambiguous` is a correctness hazard: a `reliableTurnTerminal`
 * CLI may have durably written its `completed` line microseconds before the
 * kill, with the fs.watch/1s poller not yet having consumed it. So the ordering
 * is: drain first (publishing that `completed` claims the worker deduper) →
 * re-check whether the turn is still in flight → only then emit `ambiguous` →
 * always release the durable-turn latch so a respawn isn't stranded.
 *
 * Callbacks (all injected so tests need no real JSONL / IPC):
 *  - `drain`: run the reliable-terminal drain (publishes a persisted completed).
 *  - `isStillInFlight`: read `durableTurnInFlight` AFTER the drain.
 *  - `emitAmbiguous`: emit the fail-closed ambiguous terminal.
 *  - `release`: reset the latch + retire the inflight input (fallback path).
 *
 * Returns counts so callers/tests can assert exactly how many times each ran.
 */
export interface DurableTurnSettleDeps {
  hasInFlightTurn: boolean;
  hasCurrentTurnId: boolean;
  drain: () => void;
  isStillInFlight: () => boolean;
  emitAmbiguous: () => void;
  release: () => void;
}

export interface DurableTurnSettleResult {
  drained: boolean;
  ambiguousEmitted: boolean;
  released: boolean;
}

export function settleDurableTurnForRestart(deps: DurableTurnSettleDeps): DurableTurnSettleResult {
  const result: DurableTurnSettleResult = { drained: false, ambiguousEmitted: false, released: false };
  if (!deps.hasInFlightTurn) return result;
  if (deps.hasCurrentTurnId) {
    // Drain persisted completeds FIRST so a just-finished turn claims the
    // deduper; a blind ambiguous here would re-dispatch a completed delivery.
    deps.drain();
    result.drained = true;
    // Only emit ambiguous if the drain did NOT already settle this turn.
    if (deps.isStillInFlight()) {
      deps.emitAmbiguous();
      result.ambiguousEmitted = true;
    }
  }
  // Fallback: if nothing settled the latch (no matching turn to emit, or drain
  // published a completed for a different attempt), still release it so the
  // respawn isn't blocked by a stuck durableTurnInFlight flag.
  if (deps.isStillInFlight()) {
    deps.release();
    result.released = true;
  }
  return result;
}

export interface RestartReceiptInput {
  /** A replacement backend is installed (`backend` non-null). */
  backendInstalled: boolean;
  /** A Codex auto-upgrade owns the restart window (any stage, incl. failed). */
  upgradeInFlight: boolean;
}

export type RestartReceiptDecision = 'emit' | 'defer_no_backend' | 'defer_upgrade';

/**
 * May the current replacement settle the active correlated restart attempt?
 *
 *  - `defer_no_backend`: a stray late callback with no replacement installed
 *    must not claim success and consume the attempt id — leave it for the real
 *    replacement or the coordinator timeout.
 *  - `defer_upgrade`: a Codex auto-upgrade also holds the restart window
 *    (`cliRestartInProgress`), so a restart that lands during it is folded in
 *    and its attempt adopted. The upgrade verifies runtime version, resumed
 *    thread and launch settings only AFTER its replacement reaches the prompt,
 *    and may still fail with input left closed; the adopted attempt is settled
 *    (or failed) by that verification, never by the ready edge — otherwise the
 *    daemon would lift its lifecycle fence on a session whose input stays shut.
 */
export function decideRestartReceipt(input: RestartReceiptInput): RestartReceiptDecision {
  if (!input.backendInstalled) return 'defer_no_backend';
  if (input.upgradeInFlight) return 'defer_upgrade';
  return 'emit';
}
