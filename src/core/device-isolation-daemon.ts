/**
 * Daemon half of the one-way device-credential isolation transaction.
 *
 * The host coordinator writes the marker, but only the daemon can prove that
 * every CLI it owns has stopped.  A short spawn freeze closes the inventory
 * race; private worker IPC supplies process identities that the CLI cannot
 * forge; backend-native teardown handles detached multiplexer sessions.
 */
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import type {
  BackendType,
  PersistentBackendTarget,
  SessionProbe,
} from '../adapters/backend/types.js';
import { deviceCredentialIsolationMarkerPath } from '../adapters/cli/read-isolation.js';
import { getBot } from '../bot-registry.js';
import { quarantinedLauncherEnvKeys, quarantinedSessionIds } from './mojo-launcher-env-quarantine.js';
import { config } from '../config.js';
import { isMojoFullyRemote } from '../adapters/backend/sandbox.js';
import { readSecureHostFileSync } from '../platform/secure-host-file.js';
import * as sessionStore from '../services/session-store.js';
import type { Session } from '../types.js';
import { logger } from '../utils/logger.js';
import {
  acquireDeviceIsolationFreeze,
  bindDeviceIsolationFreezeInventoryGeneration,
  DEVICE_ISOLATION_ACTIVATION_VERSION,
  releaseDeviceIsolationFreeze,
  requireDeviceIsolationFreeze,
  type DeviceIsolationFreezeLease,
} from './device-isolation-activation.js';
import {
  killPersistentBackendTarget,
  probePersistentBackendTarget,
  resolvePersistentBackendTarget,
} from './persistent-backend.js';
import { readProcessStartIdentity } from './session-marker.js';
import type { DaemonSession } from './types.js';
import { killWorker, listActiveSessions } from './worker-pool.js';

export const DEVICE_ISOLATION_PREPARE_PATH = '/api/device-isolation/activation/prepare';
export const DEVICE_ISOLATION_COMMIT_PATH = '/api/device-isolation/activation/commit';
export const DEVICE_ISOLATION_RELEASE_PATH = '/api/device-isolation/activation/release';

type LocalPersistentBackend = 'tmux' | 'herdr' | 'zellij' | 'zmx';
type InventoryBackend = BackendType | 'unknown';
type ProcessIdentity = { pid: number; procStart: string };

export type DeviceIsolationBlocker =
  | 'adopted_session'
  | 'unknown_backend'
  | 'unattested_worker'
  | 'stale_attestation'
  | 'process_identity_unavailable'
  | 'backend_probe_unknown'
  | 'backend_inconsistent'
  /**
   * A durable mojo launcher-env quarantine record with no session row left.
   *
   * An explicit `/close` deletes the row, but the mojo child it SIGTERM-ed was
   * never proven dead (no escalation, no wait, possible detached descendants).
   * Without this the inventory silently loses the only evidence that a hooked
   * client may still hold an activated credential on this host.
   */
  | 'mojo_launcher_env_residual'
  /**
   * A mojo session, unconditionally.
   *
   * Unlike riff (pure HTTP, nothing executes here), MojoBackend.runTurn() calls
   * `spawnProcess(bin, args, { env: buildEnv() })` on THIS host for every single
   * turn, and that child receives the injected credential. So mojo is not an
   * off-box backend at all; it is a local CLI with a remote control plane.
   *
   * Nothing currently available can turn that into a safe_remote proof:
   *   - the attestation IPC carries `credentialIsolated: false` for a fully-remote
   *     mojo (the remote-bypass path applies no isolation) and no `cliPid` (it is
   *     sent right after spawn, when MojoBackend holds no persistent child), so it
   *     evidences neither confinement nor absence of a running child
   *   - a generation-matched attestation only vouches for the CURRENT worker; the
   *     previous generation's child was merely sent an unescalated SIGTERM that
   *     nothing awaited, and may have detached descendants
   *   - the durable ledger is a same-user file the hijacked child can delete
   *
   * Until there is per-turn confinement or whole-process-group quiescence proof,
   * the honest answer is "cannot prove", so mojo is always blocked — never
   * `quiescent`, and never `safe_remote`.
   */
  | 'mojo_local_turn_unconfined';

export interface DeviceIsolationRuntimeSession {
  sessionId: string;
  adopted: boolean;
  /** Present only for a session re-admitted from the durable quarantine record
   *  because no row survives (see appendResidualMojoLauncherEnvSessions). */
  mojoLauncherEnvResidual?: boolean;
  /** Backend stamped by daemon-owned state, if this session predates no stamp. */
  frozenBackend?: BackendType;
  /** Exact worker-selected persistent resource. Shared Herdr carries both the
   * host session and the one Botmux-owned agent inside it. */
  persistentBackendTarget?: PersistentBackendTarget;
  /** PID carried only by an unregistered persisted row. It has no process-start
   * identity or worker-generation attestation, so a still-live/reused PID must
   * block activation instead of being mistaken for a quiescent PTY session. */
  unregisteredPid?: number;
  workerPresent: boolean;
  workerGeneration?: number;
  worker?: ProcessIdentity;
  attestation?: {
    backendType: BackendType;
    credentialIsolated: boolean;
    cli?: ProcessIdentity;
    workerGeneration?: number;
  };
  /**
   * Remote backends only. True when this session provably executes NOTHING on
   * this host, so there is no local process identity to prove.
   *
   * riff is always true. mojo is NOT: it spawns its binary locally every turn,
   * and only `cloud: true` (without `localDaemon`) moves the agent's tools
   * off-box. Left undefined the session is treated as locally-executing, which
   * is the safe direction — an unproven claim must never authorize credential
   * activation around a possibly-live local child.
   */
  remoteExecutionProven?: boolean;
  /** Opaque production handle. It is deliberately excluded from generation. */
  source?: DaemonSession;
}

export interface DeviceIsolationInventoryEntry {
  sessionId: string;
  backendType: InventoryBackend;
  disposition: 'blocked' | 'owned_local' | 'safe_remote' | 'quiescent';
  credentialIsolated?: boolean;
  worker?: ProcessIdentity;
  cli?: ProcessIdentity;
  workerGeneration?: number;
  persistent?: {
    target: PersistentBackendTarget;
    probe: SessionProbe;
  };
  blocker?: DeviceIsolationBlocker;
}

export interface DeviceIsolationInventory {
  generation: string;
  entries: DeviceIsolationInventoryEntry[];
  blockers: Array<{ sessionId: string; blocker: DeviceIsolationBlocker }>;
}

export interface DeviceIsolationDaemonIdentity {
  larkAppId: string;
  bootInstanceId: string;
}

export interface DeviceIsolationDaemonDependencies {
  now: () => number;
  listSessions: () => DeviceIsolationRuntimeSession[];
  processStart: (pid: number) => string | undefined;
  processExists: (pid: number) => boolean;
  signalProcess: (pid: number, signal: NodeJS.Signals) => void;
  probePersistent: (target: PersistentBackendTarget) => SessionProbe;
  /** Full sessionId is mandatory so prefix-addressed backends such as ZMX can
   * re-verify ownership before destructive teardown. */
  killPersistent: (
    target: PersistentBackendTarget,
    sessionId: string,
  ) => void;
  closeWorker: (session: DeviceIsolationRuntimeSession) => void;
  readMarker: () => string | null;
  sleep: (ms: number) => Promise<void>;
  dataDir: () => string;
}

export type DeviceIsolationDaemonResult = {
  status: 200 | 409 | 423 | 503;
  body: Record<string, unknown>;
};

interface ActivationTransaction {
  lease: DeviceIsolationFreezeLease;
  inventory: DeviceIsolationInventory;
  phase: 'prepared' | 'committed';
  pendingMarkerSha256?: string;
}

let daemonIdentity: DeviceIsolationDaemonIdentity | null = null;
let transaction: ActivationTransaction | null = null;

/** Not a real env var: a name the allowlist can never accept, used to force the
 *  proof closed when the durable ledger cannot be read. */
const QUARANTINE_UNREADABLE_SENTINEL = 'BOTMUX_MOJO_QUARANTINE_UNREADABLE';

function isPersistentBackend(value: InventoryBackend): value is LocalPersistentBackend {
  return value === 'tmux' || value === 'herdr' || value === 'zellij' || value === 'zmx';
}

/**
 * Does this session provably execute nothing on this host?
 *
 * riff: always (pure HTTP). mojo: only with `cloud` on and `localDaemon` off —
 * it spawns the binary locally every turn otherwise. Reading the live bot config
 * is deliberate: the frozen backendType alone cannot answer this, and guessing
 * `true` would be the fail-open direction.
 */
export function resolveRemoteExecutionProven(ds: DaemonSession): boolean {
  const backendType = ds.initConfig?.backendType ?? ds.session.backendType;
  if (backendType === 'riff') return true;
  if (backendType !== 'mojo') return false;
  // Precedence, most to least authoritative:
  //   1. the config frozen onto the LIVE worker (what is actually executing)
  //   2. the session's frozen control-plane identity — the single source of truth
  //      for a workerless session. Reading live bot config here would misclassify
  //      a session frozen as local (but since switched to cloud) as safe_remote,
  //      and vice versa.
  //   3. live bot config, ONLY for a legacy row that was never frozen
  //
  // wrapperCli lives on the TOP-LEVEL session/init config, not inside the mojo
  // block or the frozen identity, so it has to be folded in explicitly: a launch
  // prefix runs before the binary and can re-enable host execution
  // (`env AGENT_LOCAL_DAEMON=1 mojo`), which is exactly what voids the proof.
  // Without this, a wrapped session was still classified safe_remote here even
  // after the worker's own sandbox gate had been fixed.
  //
  // The launcher ENV has to be folded in for the same reason, and it cannot come
  // from the frozen identity: env is deliberately live (a rotated JWT must apply
  // without a refork), so MOJO_IDENTITY_KEYS excludes it. Reading it live is not a
  // weakness here — it is precisely the live value that decides what the next turn
  // executes, and that is what the proof has to cover.
  //
  // CRITICAL: the per-bot env is a TOP-LEVEL field (initConfig.env /
  // botCfg.env, see the `init` message in types.ts), PEER to backendConfig — it is
  // NOT inside the mojo block. Feeding only `backendConfig` to the proof therefore
  // misses PATH / LD_PRELOAD entirely. All three branches must merge the same two
  // layers, mojo-block env winning, or a `{cloud:true}` session with a top-level
  // `env:{LD_PRELOAD}` is classified safe_remote while a hooked local mojo client
  // is holding the activated credential. This is an independent credential
  // boundary: for a cloud bot with sandbox off it is the ONLY guard, so the
  // worker's sandbox gate cannot be relied on as a backstop.
  const wrapperCli = ds.initConfig?.wrapperCli ?? ds.session.wrapperCli;
  // Every unprovable launcher-env key this SESSION is known to have been handed,
  // from all three sources that can each miss the others:
  //   - the current worker generation's in-memory ledger
  //   - generations parked by a double-fork whose child was never proven dead
  //   - the DURABLE record, which is the only one that survives a daemon restart
  //     or an explicit /close (both of which can outlive a hooked mojo child)
  // Shared by all three branches below: the workerless and legacy paths used to
  // ignore the ledger entirely, so a session reaching them was classified
  // safe_remote no matter what env its child had been given.
  //
  // A read failure must fail CLOSED: an unreadable ledger means the daemon cannot
  // rule out a hooked child, which is the opposite of "clean". Fabricating a
  // sentinel key is how that is expressed to isMojoFullyRemote, whose allowlist
  // rejects anything but the canonical JWT name.
  let durableKeys: string[];
  try {
    durableKeys = quarantinedLauncherEnvKeys(ds.session.sessionId);
  } catch {
    durableKeys = [QUARANTINE_UNREADABLE_SENTINEL];
  }
  const sessionUnprovableEnvKeys = [
    ...(ds.mojoAppliedUnprovableEnvKeys ?? []),
    ...(ds.mojoRetiringUnprovableEnvKeys ?? []),
    ...durableKeys,
  ];
  // Keys only, so a placeholder value is fine: the proof never reads values.
  const ledgerEnv = Object.fromEntries(sessionUnprovableEnvKeys.map((k) => [k, '1']));
  const fromInit = ds.initConfig?.backendConfig as
    { cloud?: boolean; localDaemon?: boolean; jwtEnv?: string; env?: Record<string, string> }
    | undefined;
  if (fromInit) {
    // The top-level per-bot env must be read LIVE, not from initConfig.
    //
    // `ds.initConfig` is only assigned at spawn/refork, but a live-worker
    // `/restart` (operator, working-dir change, or cli_crash auto-restart) sends
    // `{type:'restart', env: latestPerBotEnvForRestart(ds)}` — which reads
    // getBot().config.env — and the worker overwrites its own lastInitConfig.env
    // before respawning. So after a restart the CHILD runs with the live env while
    // `ds.initConfig.env` still holds the stale spawn-time snapshot. Reading the
    // snapshot here reopened exactly the hole this proof exists to close: start
    // clean, add `env:{LD_PRELOAD}` to bots.json, `/restart`, and the session was
    // still classified safe_remote while a hooked mojo client held the credential.
    //
    // The mojo-block env keeps coming from the frozen `fromInit`, and that is not
    // an oversight: it has no hot-update channel (MOJO_LIVE_PATCH_KEYS is `jwt`
    // only, and restart overwrites just the top-level env), so the frozen value IS
    // what the next turn executes.
    //
    // The two top-level layers are UNIONED rather than live-replacing the snapshot,
    // because the daemon cannot tell whether a restart has already happened:
    //   - stale clean + live dangerous  → a restart WOULD arm the hook
    //   - stale dangerous + live clean  → the child is STILL running the old env
    //     until a restart lands
    // Only a union is fail-closed for both. mojoUnprovableEnvKeys inspects key
    // names only, so merging the objects is exactly a key union. The cost is being
    // conservative for a session that already restarted away from a dangerous env,
    // which is an availability nit, not a credential leak.
    //
    // Those two layers are still not enough on their own: a value can have been
    // applied to the running child and then disappear from BOTH. Three-phase
    // counter-example — start clean, add `LD_PRELOAD` + `/restart` (child now
    // hooked), then clear the config without restarting. Snapshot and live both
    // read clean while the child stays hooked. Hence the third input:
    // `mojoAppliedUnprovableEnvKeys`, the monotonic ledger of what this worker
    // generation was actually handed (see latestPerBotEnvForRestart).
    let liveTopLevelEnv: Record<string, string>;
    try {
      liveTopLevelEnv = getBot(ds.larkAppId).config.env ?? {};
    } catch {
      // Bot deregistered — no live launcher env to prove anything with. Fail
      // closed rather than trust the stale snapshot alone (same rule as the
      // workerless branch below).
      return false;
    }
    return isMojoFullyRemote({
      ...fromInit,
      env: {
        ...liveTopLevelEnv,
        ...(ds.initConfig?.env ?? {}),
        ...ledgerEnv,
        ...(fromInit.env ?? {}),
      },
      wrapperCli,
    });
  }
  if (ds.session.mojoIdentity) {
    // initConfig is absent (worker-less / not yet forked), so the launcher env can
    // only come from live bot config. A missing bot means no proof at all.
    let liveLauncher: { jwtEnv?: string; env?: Record<string, string> } = {};
    try {
      const cfg = getBot(ds.larkAppId).config;
      liveLauncher = {
        jwtEnv: cfg.mojo?.jwtEnv,
        // The ledger is folded in here too. A workerless session still has a
        // remote session that /close must cancel, and the env its last child ran
        // with is exactly what decides whether a local hook could be holding the
        // credential right now.
        env: { ...(cfg.env ?? {}), ...(cfg.mojo?.env ?? {}), ...ledgerEnv },
      };
    } catch {
      return false;
    }
    return isMojoFullyRemote({ ...ds.session.mojoIdentity, ...liveLauncher, wrapperCli });
  }
  try {
    // Legacy migration branch only. Reached when the session predates
    // `mojoIdentity` AND has not been through migrateMojoSessionIdentities yet
    // (e.g. the bot was deregistered at restore time).
    const botCfg = getBot(ds.larkAppId).config;
    return isMojoFullyRemote({
      ...botCfg.mojo,
      // Same layering as the other branches — top-level botCfg.env is peer to the
      // mojo block (omitting it leaked PATH / LD_PRELOAD here too), and the
      // ledger covers what this session's child was actually handed.
      env: { ...(botCfg.env ?? {}), ...(botCfg.mojo?.env ?? {}), ...ledgerEnv },
      wrapperCli: wrapperCli ?? botCfg.wrapperCli,
    });
  } catch {
    // Bot deregistered — no proof available, so assume local (fail closed).
    return false;
  }
}

function isLocalBackend(value: InventoryBackend): value is Exclude<BackendType, 'riff' | 'mojo'> {
  return value === 'pty' || isPersistentBackend(value);
}

function safeProcessExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/**
 * Add durable, persisted local-resource rows that startup restore intentionally
 * kept active but could not safely register. Device isolation must see those
 * ownership records even when the routing registry cannot: otherwise an
 * inconclusive teardown could disappear from the activation inventory.
 *
 * Runtime state wins by complete session id because it carries the current
 * worker generation and attestation. Queued rows and command scratches have no
 * running local resource. Legacy rows with a CLI/PID/target marker are still
 * evidence of a possibly-live local resource even when backendType was never
 * stamped; include them as `unknown_backend` blockers instead of silently
 * excluding them from a credential-isolation transaction.
 */
export function mergePersistedDeviceIsolationSessions(
  runtimeSessions: readonly DeviceIsolationRuntimeSession[],
  persistedSessions: readonly Session[],
): DeviceIsolationRuntimeSession[] {
  const merged = [...runtimeSessions];
  const runtimeIds = new Set(runtimeSessions.map(session => session.sessionId));
  for (const session of persistedSessions) {
    if (
      runtimeIds.has(session.sessionId)
      || session.status !== 'active'
      || session.queued
    ) continue;
    const adopted = !!session.adoptedFrom;
    const frozenBackend =
      session.backendType ?? session.persistentBackendTarget?.backendType;
    const hasDurableLocalEvidence =
      adopted
      || !!session.persistentBackendTarget
      || isPersistentBackend(frozenBackend ?? 'unknown')
      || (typeof session.pid === 'number' && session.pid > 0)
      || !!session.cliSessionId;
    if (!hasDurableLocalEvidence) continue;
    merged.push({
      sessionId: session.sessionId,
      adopted,
      ...(frozenBackend ? { frozenBackend } : {}),
      ...(session.persistentBackendTarget
        ? { persistentBackendTarget: session.persistentBackendTarget }
        : {}),
      ...(typeof session.pid === 'number' && session.pid > 0
        ? { unregisteredPid: session.pid }
        : {}),
      workerPresent: false,
    });
    runtimeIds.add(session.sessionId);
  }
  return merged;
}

function defaultRuntimeSessions(): DeviceIsolationRuntimeSession[] {
  const runtime = listActiveSessions().map((ds) => {
    const workerPresent = !!ds.worker && !ds.worker.killed;
    const workerPid = workerPresent ? ds.worker?.pid : undefined;
    const workerStart = workerPid ? readProcessStartIdentity(workerPid) : undefined;
    const attestation = ds.localProcessAttestation;
    const cli = attestation?.cliPid && attestation.cliProcStart
      ? { pid: attestation.cliPid, procStart: attestation.cliProcStart }
      : undefined;
    const persistentBackendTarget =
      ds.session.persistentBackendTarget ?? ds.initConfig?.persistentBackendTarget;
    return {
      sessionId: ds.session.sessionId,
      adopted: !!(ds.adoptedFrom || ds.initConfig?.adoptMode || ds.session.adoptedFrom),
      frozenBackend: ds.initConfig?.backendType ?? ds.session.backendType,
      ...(persistentBackendTarget ? { persistentBackendTarget } : {}),
      remoteExecutionProven: resolveRemoteExecutionProven(ds),
      workerPresent,
      ...(ds.workerGeneration !== undefined ? { workerGeneration: ds.workerGeneration } : {}),
      ...(workerPid && workerStart ? { worker: { pid: workerPid, procStart: workerStart } } : {}),
      ...(attestation ? {
        attestation: {
          backendType: attestation.backendType,
          credentialIsolated: attestation.credentialIsolated,
          ...(cli ? { cli } : {}),
          ...(attestation.workerGeneration !== undefined
            ? { workerGeneration: attestation.workerGeneration }
            : {}),
        },
      } : {}),
      source: ds,
    };
  });
  // sessionStore is initialized for this daemon's own bot partition. Do not
  // scan sibling files: every daemon proves only the local resources it owns.
  const merged = mergePersistedDeviceIsolationSessions(runtime, sessionStore.listSessions());
  return appendResidualMojoLauncherEnvSessions(merged);
}

/**
 * Quarantined ids, or a hard failure. An unreadable ledger must not silently
 * become "no residual sessions"; the isolation transaction is refused instead.
 */
function safeQuarantinedSessionIds(): string[] {
  try {
    return quarantinedSessionIds();
  } catch (err) {
    throw new Error(
      'refusing device-isolation activation: mojo launcher-env quarantine is unreadable '
      + `(${err instanceof Error ? err.message : String(err)})`,
    );
  }
}

/**
 * Re-admit sessions that exist ONLY as a durable launcher-env quarantine record.
 *
 * Both other sources can lose them: an explicit `/close` deletes the row, and a
 * daemon restart drops the in-memory ledger — yet the mojo child that was handed
 * `LD_PRELOAD`/`PATH` may still be running, because its teardown is an
 * unescalated `SIGTERM` that nothing waits on. Such a session must keep blocking
 * credential activation instead of vanishing from the inventory.
 *
 * Exported for tests: the whole point is a session with no row anywhere.
 */
export function appendResidualMojoLauncherEnvSessions(
  sessions: readonly DeviceIsolationRuntimeSession[],
  quarantinedIds: readonly string[] = safeQuarantinedSessionIds(),
): DeviceIsolationRuntimeSession[] {
  const out = [...sessions];
  const known = new Set(sessions.map((session) => session.sessionId));
  for (const sessionId of quarantinedIds) {
    if (known.has(sessionId)) continue;   // already represented, keeps its own classification
    out.push({
      sessionId,
      adopted: false,
      frozenBackend: 'mojo',
      // Not provable by construction: there is a recorded dangerous env and no
      // termination proof for the child that received it.
      remoteExecutionProven: false,
      workerPresent: false,
      mojoLauncherEnvResidual: true,
    });
  }
  return out;
}

const defaultDependencies: DeviceIsolationDaemonDependencies = {
  now: () => Date.now(),
  listSessions: defaultRuntimeSessions,
  processStart: readProcessStartIdentity,
  processExists: safeProcessExists,
  signalProcess: (pid, signal) => { process.kill(pid, signal); },
  probePersistent: probePersistentBackendTarget,
  killPersistent: killPersistentBackendTarget,
  closeWorker: (session) => {
    if (!session.source) throw new Error('missing daemon session handle');
    killWorker(session.source);
  },
  readMarker: () => readSecureHostFileSync(
    deviceCredentialIsolationMarkerPath(homedir()),
    4 * 1024,
  ),
  sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
  dataDir: () => config.session.dataDir,
};

let dependencies: DeviceIsolationDaemonDependencies = defaultDependencies;

function resolvedBackend(session: DeviceIsolationRuntimeSession): InventoryBackend {
  return session.frozenBackend ?? session.attestation?.backendType ?? 'unknown';
}

function blockerEntry(
  session: DeviceIsolationRuntimeSession,
  backendType: InventoryBackend,
  blocker: DeviceIsolationBlocker,
): DeviceIsolationInventoryEntry {
  return {
    sessionId: session.sessionId,
    backendType,
    disposition: 'blocked',
    ...(session.worker ? { worker: session.worker } : {}),
    ...(session.attestation?.cli ? { cli: session.attestation.cli } : {}),
    ...(session.workerGeneration !== undefined
      ? { workerGeneration: session.workerGeneration }
      : {}),
    blocker,
  };
}

/**
 * Any durable quarantine record for this session?
 *
 * An unreadable ledger counts as quarantined: the daemon cannot prove the host is
 * clean, and treating the error as "no record" is the fail-open direction.
 */
function hasDurableMojoQuarantine(sessionId: string): boolean {
  try {
    return quarantinedLauncherEnvKeys(sessionId).length > 0;
  } catch {
    return true;
  }
}

function classifySession(session: DeviceIsolationRuntimeSession): DeviceIsolationInventoryEntry {
  const backendType = resolvedBackend(session);
  // Before anything else: a durable quarantine record means an unproven hooked
  // child may still be alive, so nothing below can clear it.
  //
  // Checked HERE rather than only on the synthesised no-row entries, because a
  // row that still exists takes the opposite path: mojo is not a persistent
  // backend, so a workerless mojo row has no persistent target and fell straight
  // through to `quiescent` — a known, quarantined session was therefore reported
  // as nothing-to-tear-down.
  if (session.mojoLauncherEnvResidual || hasDurableMojoQuarantine(session.sessionId)) {
    return blockerEntry(session, backendType, 'mojo_launcher_env_residual');
  }

  // mojo, unconditionally: every turn spawns a credentialed local CLI child and no
  // available evidence proves it is confined or gone. Placed before the adopted /
  // attestation branches so no later path can grant it safe_remote or quiescent.
  if (backendType === 'mojo') {
    return blockerEntry(session, backendType, 'mojo_local_turn_unconfined');
  }
  if (session.adopted) return blockerEntry(session, backendType, 'adopted_session');
  if (backendType === 'unknown') return blockerEntry(session, backendType, 'unknown_backend');
  if (
    session.frozenBackend
    && session.attestation
    && session.frozenBackend !== session.attestation.backendType
  ) {
    return blockerEntry(session, backendType, 'backend_inconsistent');
  }
  if (session.unregisteredPid !== undefined) {
    let processMayStillExist = true;
    try {
      processMayStillExist = dependencies.processExists(session.unregisteredPid);
    } catch {
      // Process inspection is itself part of the safety proof. An unavailable
      // probe cannot authorize activation around an unregistered local PID.
    }
    if (processMayStillExist) {
      return blockerEntry(session, backendType, 'process_identity_unavailable');
    }
  }
  // A remote backend owns no local PID, so there is no local process identity to
  // prove. riff always qualifies. mojo qualifies ONLY with proof that nothing
  // runs here (cloud on, localDaemon off) — otherwise it falls through to the
  // local path below, where a live worker must still supply process identity.
  // Treating an unproven mojo session as safe_remote would let credential
  // activation proceed while a local `mojo` child is mid-turn.
  // ONLY riff. riff runs the agent off-box over HTTP and owns no local process, so
  // there is genuinely nothing here to tear down. mojo looks similar in config but
  // spawns a credentialed local CLI every turn (see mojo_local_turn_unconfined),
  // so it must not share this exemption.
  if (backendType === 'riff') {
    return {
      sessionId: session.sessionId,
      backendType,
      disposition: 'safe_remote',
      ...(session.workerGeneration !== undefined
        ? { workerGeneration: session.workerGeneration }
        : {}),
    };
  }

  const persistentTarget = isPersistentBackend(backendType)
    ? resolvePersistentBackendTarget(
      backendType,
      session.sessionId,
      session.persistentBackendTarget,
    )
    : undefined;
  const persistent = persistentTarget
    ? {
      target: persistentTarget,
      probe: dependencies.probePersistent(persistentTarget),
    }
    : undefined;

  if (!session.workerPresent) {
    if (!persistent || persistent.probe === 'missing') {
      return {
        sessionId: session.sessionId,
        backendType,
        disposition: 'quiescent',
        ...(persistent ? { persistent } : {}),
      };
    }
    if (persistent.probe === 'unknown') {
      return { ...blockerEntry(session, backendType, 'backend_probe_unknown'), persistent };
    }
    // A persisted shared-Herdr agent is an exact Botmux-owned resource even
    // after its worker/viewer is gone. Keep it in the teardown inventory so
    // activation closes only that agent and verifies its disappearance; never
    // mistake a missing derived bmx-* host for quiescence while the real agent
    // is still running inside a shared host session.
    if (
      persistent.target.backendType === 'herdr'
      && persistent.target.agentName
    ) {
      return {
        sessionId: session.sessionId,
        backendType,
        disposition: 'owned_local',
        credentialIsolated: false,
        persistent,
      };
    }
    // A detached pane may still be executing a legacy unconfined CLI, but the
    // daemon no longer has a private-IPC attestation for its exact process.
    return { ...blockerEntry(session, backendType, 'unattested_worker'), persistent };
  }

  if (!session.attestation) {
    return {
      ...blockerEntry(session, backendType, 'unattested_worker'),
      ...(persistent ? { persistent } : {}),
    };
  }
  if (!session.worker || !session.attestation.cli) {
    return {
      ...blockerEntry(session, backendType, 'process_identity_unavailable'),
      ...(persistent ? { persistent } : {}),
    };
  }
  if (
    session.workerGeneration === undefined
    || session.attestation.workerGeneration !== session.workerGeneration
  ) {
    return {
      ...blockerEntry(session, backendType, 'stale_attestation'),
      ...(persistent ? { persistent } : {}),
    };
  }
  if (
    dependencies.processStart(session.worker.pid) !== session.worker.procStart
    || dependencies.processStart(session.attestation.cli.pid) !== session.attestation.cli.procStart
  ) {
    return {
      ...blockerEntry(session, backendType, 'stale_attestation'),
      ...(persistent ? { persistent } : {}),
    };
  }
  if (persistent?.probe === 'unknown') {
    return { ...blockerEntry(session, backendType, 'backend_probe_unknown'), persistent };
  }
  if (persistent?.probe === 'missing') {
    return { ...blockerEntry(session, backendType, 'backend_inconsistent'), persistent };
  }

  return {
    sessionId: session.sessionId,
    backendType,
    disposition: 'owned_local',
    credentialIsolated: session.attestation.credentialIsolated,
    worker: session.worker,
    cli: session.attestation.cli,
    workerGeneration: session.workerGeneration,
    ...(persistent ? { persistent } : {}),
  };
}

function generationFor(entries: readonly DeviceIsolationInventoryEntry[]): string {
  return createHash('sha256').update(JSON.stringify(entries), 'utf8').digest('hex');
}

export function buildDeviceIsolationInventory(): DeviceIsolationInventory {
  const entries = dependencies.listSessions()
    .map(classifySession)
    .sort((a, b) => a.sessionId.localeCompare(b.sessionId));
  return {
    generation: generationFor(entries),
    entries,
    blockers: entries.flatMap(entry => entry.blocker
      ? [{ sessionId: entry.sessionId, blocker: entry.blocker }]
      : []),
  };
}

function sha256(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex');
}

function validNonce(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{32,128}$/.test(value);
}

function validLeaseId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9-]{8,128}$/.test(value);
}

function validDigest(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

function validVersion(value: unknown): boolean {
  return value === DEVICE_ISOLATION_ACTIVATION_VERSION;
}

function stableError(status: 409 | 423 | 503, error: string): DeviceIsolationDaemonResult {
  return { status, body: { ok: false, error } };
}

function baseResponse(
  lease: DeviceIsolationFreezeLease,
  inventoryGeneration: string,
): DeviceIsolationDaemonResult {
  if (!daemonIdentity) return stableError(503, 'daemon_identity_unavailable');
  const procStart = dependencies.processStart(process.pid);
  const dataDir = dependencies.dataDir();
  if (!procStart || !dataDir) return stableError(503, 'daemon_identity_unavailable');
  return {
    status: 200,
    body: {
      ok: true,
      activationVersion: DEVICE_ISOLATION_ACTIVATION_VERSION,
      nonce: lease.nonce,
      leaseId: lease.leaseId,
      daemon: {
        larkAppId: daemonIdentity.larkAppId,
        bootInstanceId: daemonIdentity.bootInstanceId,
        pid: process.pid,
        procStart,
        dataDir,
      },
      inventoryGeneration,
      expiresAt: lease.expiresAt,
    },
  };
}

function markerState(raw: string): 'pending' | 'active' | 'invalid' {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (parsed.version !== 1 || typeof parsed.enabledAt !== 'string') return 'invalid';
    if (new Date(parsed.enabledAt).toISOString() !== parsed.enabledAt) return 'invalid';
    // Legacy v1 markers without state are deliberately pending: they enforce
    // isolation for new workers but cannot prove the daemon transaction ended.
    if (parsed.state === undefined || parsed.state === 'pending') return 'pending';
    if (
      parsed.state === 'active'
      && typeof parsed.activatedAt === 'string'
      && new Date(parsed.activatedAt).toISOString() === parsed.activatedAt
    ) return 'active';
    return 'invalid';
  } catch {
    return 'invalid';
  }
}

function readAndMatchMarker(
  expectedSha256: string,
  expectedState: 'pending' | 'active',
): DeviceIsolationDaemonResult | { raw: string } {
  try {
    const raw = dependencies.readMarker();
    if (raw === null || sha256(raw) !== expectedSha256 || markerState(raw) !== expectedState) {
      return stableError(409, 'marker_mismatch');
    }
    return { raw };
  } catch {
    return stableError(503, 'marker_unavailable');
  }
}

function currentTransaction(input: {
  nonce: string;
  leaseId: string;
}): ActivationTransaction | null {
  const lease = requireDeviceIsolationFreeze({
    nonce: input.nonce,
    leaseId: input.leaseId,
    now: dependencies.now(),
  });
  if (
    !lease
    || !transaction
    || transaction.lease.nonce !== input.nonce
    || transaction.lease.leaseId !== input.leaseId
  ) return null;
  transaction.lease = lease;
  return transaction;
}

function processIdentityGone(identity: ProcessIdentity): 'gone' | 'alive' | 'unknown' {
  const current = dependencies.processStart(identity.pid);
  if (current !== undefined) return current === identity.procStart ? 'alive' : 'gone';
  return dependencies.processExists(identity.pid) ? 'unknown' : 'gone';
}

function signalExact(identity: ProcessIdentity, signal: NodeJS.Signals): void {
  if (processIdentityGone(identity) !== 'alive') return;
  try { dependencies.signalProcess(identity.pid, signal); } catch { /* verified below */ }
}

async function quiesceOwnedSessions(
  prepared: DeviceIsolationInventory,
  lease: DeviceIsolationFreezeLease,
): Promise<'ok' | 'lease_expired' | 'teardown_failed'> {
  const sessions = new Map(dependencies.listSessions().map(session => [session.sessionId, session]));
  const targets = prepared.entries.filter(entry => entry.disposition === 'owned_local');
  try {
    for (const target of targets) {
      const session = sessions.get(target.sessionId);
      if (!session) return 'teardown_failed';
      if (session.workerPresent) dependencies.closeWorker(session);
      if (target.persistent) {
        dependencies.killPersistent(
          target.persistent.target,
          target.sessionId,
        );
      }
    }
  } catch {
    return 'teardown_failed';
  }

  const startedAt = dependencies.now();
  let escalatedTerm = false;
  let escalatedKill = false;
  while (dependencies.now() - startedAt <= 4_000) {
    if (!requireDeviceIsolationFreeze({ nonce: lease.nonce, leaseId: lease.leaseId, now: dependencies.now() })) {
      return 'lease_expired';
    }
    let clean = true;
    let unknown = false;
    for (const target of targets) {
      for (const identity of [target.cli, target.worker]) {
        if (!identity) continue;
        const state = processIdentityGone(identity);
        if (state === 'alive') clean = false;
        if (state === 'unknown') unknown = true;
      }
      if (target.persistent) {
        const probe = dependencies.probePersistent(target.persistent.target);
        if (probe === 'unknown') unknown = true;
        if (probe === 'exists') {
          clean = false;
          try {
            dependencies.killPersistent(
              target.persistent.target,
              target.sessionId,
            );
          } catch { /* verified by the next probe */ }
        }
      }
    }
    if (clean && !unknown) return 'ok';
    const elapsed = dependencies.now() - startedAt;
    if (!escalatedTerm && elapsed >= 250) {
      escalatedTerm = true;
      for (const target of targets) {
        if (target.cli) signalExact(target.cli, 'SIGTERM');
        if (target.worker) signalExact(target.worker, 'SIGTERM');
      }
    }
    if (!escalatedKill && elapsed >= 1_250) {
      escalatedKill = true;
      for (const target of targets) {
        if (target.cli) signalExact(target.cli, 'SIGKILL');
        if (target.worker) signalExact(target.worker, 'SIGKILL');
      }
    }
    await dependencies.sleep(50);
  }
  return 'teardown_failed';
}

export function setDeviceIsolationDaemonIdentity(
  identity: DeviceIsolationDaemonIdentity | null,
): void {
  daemonIdentity = identity && identity.larkAppId && identity.bootInstanceId
    ? { ...identity }
    : null;
}

export function prepareDeviceIsolationActivation(body: unknown): DeviceIsolationDaemonResult {
  const input = body as Record<string, unknown> | null;
  if (!input || !validVersion(input.activationVersion) || !validNonce(input.nonce)) {
    return stableError(409, 'invalid_request');
  }
  if (!daemonIdentity || !dependencies.processStart(process.pid) || !dependencies.dataDir()) {
    return stableError(503, 'daemon_identity_unavailable');
  }

  const acquired = acquireDeviceIsolationFreeze({
    nonce: input.nonce,
    inventoryGeneration: 'pending',
    now: dependencies.now(),
  });
  if (!acquired.ok) return stableError(423, 'activation_busy');

  if (
    acquired.reused
    && transaction
    && transaction.lease.leaseId === acquired.lease.leaseId
    && transaction.lease.nonce === input.nonce
  ) {
    const response = baseResponse(acquired.lease, transaction.inventory.generation);
    if (response.status === 200) {
      response.body.phase = transaction.phase;
      response.body.inventory = transaction.inventory.entries;
    }
    return response;
  }

  let inventory: DeviceIsolationInventory;
  try {
    inventory = buildDeviceIsolationInventory();
  } catch {
    releaseDeviceIsolationFreeze({
      nonce: input.nonce,
      leaseId: acquired.lease.leaseId,
      now: dependencies.now(),
    });
    return stableError(503, 'inventory_unavailable');
  }
  if (inventory.blockers.length > 0) {
    releaseDeviceIsolationFreeze({
      nonce: input.nonce,
      leaseId: acquired.lease.leaseId,
      now: dependencies.now(),
    });
    transaction = null;
    return {
      status: 409,
      body: { ok: false, error: 'activation_blocked', blockers: inventory.blockers },
    };
  }
  const bound = bindDeviceIsolationFreezeInventoryGeneration({
    nonce: input.nonce,
    leaseId: acquired.lease.leaseId,
    inventoryGeneration: inventory.generation,
    now: dependencies.now(),
  });
  if (!bound) return stableError(409, 'lease_expired');
  transaction = { lease: bound, inventory, phase: 'prepared' };
  const response = baseResponse(bound, inventory.generation);
  if (response.status === 200) {
    response.body.phase = 'prepared';
    response.body.inventory = inventory.entries;
  }
  return response;
}

export async function commitDeviceIsolationActivation(body: unknown): Promise<DeviceIsolationDaemonResult> {
  const input = body as Record<string, unknown> | null;
  if (
    !input
    || !validVersion(input.activationVersion)
    || !validNonce(input.nonce)
    || !validLeaseId(input.leaseId)
    || !validDigest(input.markerSha256)
  ) return stableError(409, 'invalid_request');
  const active = currentTransaction({ nonce: input.nonce, leaseId: input.leaseId });
  if (!active) return stableError(409, 'lease_mismatch');
  if (active.phase === 'committed') {
    if (active.pendingMarkerSha256 !== input.markerSha256) {
      return stableError(409, 'marker_mismatch');
    }
    const response = baseResponse(active.lease, active.inventory.generation);
    if (response.status === 200) response.body.phase = 'committed';
    return response;
  }
  const marker = readAndMatchMarker(input.markerSha256, 'pending');
  if ('status' in marker) return marker;

  let current: DeviceIsolationInventory;
  try { current = buildDeviceIsolationInventory(); }
  catch { return stableError(503, 'inventory_unavailable'); }
  if (current.generation !== active.inventory.generation) {
    return stableError(409, 'inventory_changed');
  }
  const quiesced = await quiesceOwnedSessions(active.inventory, active.lease);
  if (quiesced === 'lease_expired') return stableError(409, 'lease_expired');
  if (quiesced !== 'ok') return stableError(503, 'teardown_unverified');

  let after: DeviceIsolationInventory;
  try { after = buildDeviceIsolationInventory(); }
  catch { return stableError(503, 'inventory_unavailable'); }
  if (
    after.blockers.length > 0
    || after.entries.some(entry => entry.disposition === 'owned_local')
  ) return stableError(409, 'unsafe_local_process');

  active.phase = 'committed';
  active.pendingMarkerSha256 = input.markerSha256;
  active.inventory = after;
  const rebound = bindDeviceIsolationFreezeInventoryGeneration({
    nonce: input.nonce,
    leaseId: input.leaseId,
    inventoryGeneration: after.generation,
    now: dependencies.now(),
  });
  if (!rebound) return stableError(409, 'lease_expired');
  active.lease = rebound;
  const response = baseResponse(rebound, after.generation);
  if (response.status === 200) response.body.phase = 'committed';
  return response;
}

export function releaseDeviceIsolationActivation(body: unknown): DeviceIsolationDaemonResult {
  const input = body as Record<string, unknown> | null;
  if (
    !input
    || !validVersion(input.activationVersion)
    || !validNonce(input.nonce)
    || !validLeaseId(input.leaseId)
  ) return stableError(409, 'invalid_request');
  const active = currentTransaction({ nonce: input.nonce, leaseId: input.leaseId });
  if (!active) return stableError(409, 'lease_mismatch');

  if (input.abort === true) {
    if (active.phase === 'committed') return stableError(409, 'activation_committed');
    if (!releaseDeviceIsolationFreeze({
      nonce: input.nonce,
      leaseId: input.leaseId,
      now: dependencies.now(),
    })) {
      return stableError(409, 'lease_mismatch');
    }
    transaction = null;
    const response = baseResponse(active.lease, active.inventory.generation);
    if (response.status === 200) response.body.aborted = true;
    return response;
  }

  if (active.phase !== 'committed') return stableError(409, 'activation_not_committed');
  if (!validDigest(input.markerSha256)) return stableError(409, 'invalid_request');
  // Commit binds the PENDING marker. The host switches it to ACTIVE only after
  // every daemon committed, so release intentionally accepts a different hash
  // while requiring the exact bytes supplied here to parse as ACTIVE.
  const marker = readAndMatchMarker(input.markerSha256, 'active');
  if ('status' in marker) return marker;

  let current: DeviceIsolationInventory;
  try { current = buildDeviceIsolationInventory(); }
  catch { return stableError(503, 'inventory_unavailable'); }
  if (
    current.blockers.length > 0
    || current.entries.some(entry => entry.disposition === 'owned_local')
  ) return stableError(409, 'unsafe_local_process');
  if (!releaseDeviceIsolationFreeze({
    nonce: input.nonce,
    leaseId: input.leaseId,
    now: dependencies.now(),
  })) {
    return stableError(409, 'lease_mismatch');
  }
  transaction = null;
  const response = baseResponse(active.lease, current.generation);
  if (response.status === 200) response.body.released = true;
  return response;
}

/** Test seams keep process and backend destruction out of unit tests. */
export function setDeviceIsolationDaemonDependenciesForTest(
  overrides: Partial<DeviceIsolationDaemonDependencies> | null,
): void {
  dependencies = overrides ? { ...defaultDependencies, ...overrides } : defaultDependencies;
}

export function resetDeviceIsolationDaemonForTest(): void {
  transaction = null;
  daemonIdentity = null;
  dependencies = defaultDependencies;
}

export function logDeviceIsolationActivationError(error: unknown): void {
  logger.warn('[device-isolation] activation handler failed closed', error);
}
