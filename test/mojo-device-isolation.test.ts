/**
 * Device-isolation classification for mojo sessions.
 *
 * Review found that the worker's sandbox gate was fixed while this classifier
 * still ignored `wrapperCli`, so a wrapped session — one that can re-enable host
 * execution via `env AGENT_LOCAL_DAEMON=1 mojo` — was still labelled `safe_remote`
 * and could have device credentials activated around a live local child.
 *
 * Run:  pnpm vitest run test/mojo-device-isolation.test.ts
 */
import { readFileSync } from 'node:fs';

import { beforeEach, describe, expect, it, vi } from 'bun:test';

vi.mock('../src/utils/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
// Controllable: the classifier now also reads the LIVE launcher env for a frozen
// session (env is deliberately not frozen, since the JWT must stay rotatable), so a
// permanently-throwing getBot would make every frozen case fail closed and hide
// what these tests are actually about.
let liveBotConfig: Record<string, unknown> | undefined = {};
vi.mock('../src/bot-registry.js', () => ({
  getBot: () => {
    if (!liveBotConfig) throw new Error('bot deregistered');
    return { config: liveBotConfig };
  },
}));

import { resolveRemoteExecutionProven } from '../src/core/device-isolation-daemon.js';
import { rememberAppliedUnprovableEnvKeys, startNewGenerationEnvLedger } from '../src/core/worker-pool.js';
import type { DaemonSession } from '../src/core/types.js';

/** Minimal DaemonSession shape the classifier reads. */
function ds(opts: {
  backendType?: string;
  backendConfig?: Record<string, unknown>;
  mojoIdentity?: Record<string, unknown>;
  wrapperCli?: string;
  initWrapperCli?: string;
  /**
   * TOP-LEVEL `initConfig.env` — the per-bot env, PEER to backendConfig rather
   * than nested inside the mojo block (see the `init` message in types.ts).
   *
   * This dimension was missing, and that is exactly why 44 green tests failed to
   * catch a live-worker credential leak: every env case could only be expressed
   * via backendConfig.env or mojoIdentity, so they all exercised the workerless
   * branch. A live worker ALWAYS has initConfig.backendConfig and therefore never
   * reaches it. The fixture was strictly more permissive than production.
   */
  initEnv?: Record<string, string>;
  /**
   * The generation's monotonic ledger of unprovable launcher-env keys actually
   * handed to the running child (DaemonSession.mojoAppliedUnprovableEnvKeys).
   *
   * The previous fixture had only "spawn snapshot" and "live config", which
   * cannot express an env that was applied to the child and then removed from
   * both — the three-phase hole. Modelling it here is what makes that testable.
   */
  appliedKeys?: string[];
  /**
   * Keys parked from a generation whose worker has NOT been observed to exit
   * (DaemonSession.mojoRetiringUnprovableEnvKeys).
   *
   * forkWorker's double-fork guard only SENDS close/kill and then spawns the
   * replacement synchronously, so "new generation" does not imply the old
   * (possibly injected) child is gone. Without this dimension the reset looked
   * safe in every test.
   */
  retiringKeys?: string[];
}): never {
  return {
    larkAppId: 'app_x',
    ...(opts.appliedKeys ? { mojoAppliedUnprovableEnvKeys: opts.appliedKeys } : {}),
    ...(opts.retiringKeys ? { mojoRetiringUnprovableEnvKeys: opts.retiringKeys } : {}),
    initConfig: opts.backendConfig || opts.initWrapperCli || opts.initEnv
      ? {
        backendType: opts.backendType ?? 'mojo',
        ...(opts.backendConfig ? { backendConfig: opts.backendConfig } : {}),
        ...(opts.initWrapperCli ? { wrapperCli: opts.initWrapperCli } : {}),
        ...(opts.initEnv ? { env: opts.initEnv } : {}),
      }
      : undefined,
    session: {
      sessionId: 'sid-x',
      backendType: opts.backendType ?? 'mojo',
      ...(opts.mojoIdentity ? { mojoIdentity: opts.mojoIdentity } : {}),
      ...(opts.wrapperCli ? { wrapperCli: opts.wrapperCli } : {}),
    },
  } as never;
}

beforeEach(() => { liveBotConfig = {}; });

describe('resolveRemoteExecutionProven', () => {
  it('riff is always remote', () => {
    expect(resolveRemoteExecutionProven(ds({ backendType: 'riff' }))).toBe(true);
  });

  it('non-remote backends are never remote', () => {
    expect(resolveRemoteExecutionProven(ds({ backendType: 'tmux' }))).toBe(false);
  });

  it('a cloud mojo session with no wrapper is remote', () => {
    expect(resolveRemoteExecutionProven(ds({ backendConfig: { cloud: true } }))).toBe(true);
    expect(resolveRemoteExecutionProven(ds({ mojoIdentity: { cloud: true } }))).toBe(true);
  });

  it('a frozen cloud session is NOT remote once the LIVE launcher env can redirect it', () => {
    // The cold-refork attack, at the layer review said mislabels it `safe_remote`:
    // `env` is not part of the frozen identity, so it is re-merged from live bot
    // config on refork. A redirected PATH must void the proof here too, or device
    // credentials get activated around a local child running unknown code.
    liveBotConfig = { mojo: { env: { PATH: '/tmp/fake-mojo' } } };
    expect(resolveRemoteExecutionProven(ds({ mojoIdentity: { cloud: true } }))).toBe(false);

    // Same through the TOP-LEVEL per-bot env, which lands in the same child env.
    liveBotConfig = { env: { LD_PRELOAD: '/tmp/x.so' } };
    expect(resolveRemoteExecutionProven(ds({ mojoIdentity: { cloud: true } }))).toBe(false);

    // The CANONICAL credential variable alone stays provable.
    liveBotConfig = { mojo: { env: { X_JWT_TOKEN: 'tok' } } };
    expect(resolveRemoteExecutionProven(ds({ mojoIdentity: { cloud: true } }))).toBe(true);

    // But a config-named credential key does NOT buy an exemption here either.
    // This is the alias bypass at the device-isolation layer: if `jwtEnv` widened
    // the allowlist, `jwtEnv: 'PATH'` would be classified safe_remote and activate
    // device credentials around a local child running an operator-chosen binary.
    liveBotConfig = { mojo: { jwtEnv: 'MY_JWT', env: { MY_JWT: 'tok' } } };
    expect(resolveRemoteExecutionProven(ds({ mojoIdentity: { cloud: true } }))).toBe(false);
    liveBotConfig = { mojo: { jwtEnv: 'PATH', env: { PATH: '/tmp/fake-mojo' } } };
    expect(resolveRemoteExecutionProven(ds({ mojoIdentity: { cloud: true } }))).toBe(false);
  });

  it('a frozen session whose bot is gone fails closed', () => {
    // No way to read the launcher env, so nothing can be proven.
    liveBotConfig = undefined;
    expect(resolveRemoteExecutionProven(ds({ mojoIdentity: { cloud: true } }))).toBe(false);
  });

  it('a WRAPPED cloud session is NOT remote — from initConfig', () => {
    expect(resolveRemoteExecutionProven(ds({
      backendConfig: { cloud: true, localDaemon: false },
      initWrapperCli: 'env AGENT_LOCAL_DAEMON=1 mojo',
    }))).toBe(false);
  });

  it('a WRAPPED cloud session is NOT remote — from the frozen session field', () => {
    // wrapperCli lives on the top-level session, not inside the mojo block or the
    // frozen identity, so it has to be folded in explicitly.
    expect(resolveRemoteExecutionProven(ds({
      mojoIdentity: { cloud: true, localDaemon: false },
      wrapperCli: 'env AGENT_LOCAL_DAEMON=1 mojo',
    }))).toBe(false);
  });

  it('any wrapper voids the proof, not just an obviously hostile one', () => {
    expect(resolveRemoteExecutionProven(ds({
      mojoIdentity: { cloud: true },
      wrapperCli: 'ttadk mojo',
    }))).toBe(false);
  });

  it('localDaemon still voids the proof', () => {
    expect(resolveRemoteExecutionProven(ds({
      mojoIdentity: { cloud: true, localDaemon: true },
    }))).toBe(false);
  });

  it('an unset cloud flag is not remote', () => {
    expect(resolveRemoteExecutionProven(ds({ mojoIdentity: {} }))).toBe(false);
  });

  it('fails closed when the bot is deregistered and nothing is frozen', () => {
    expect(resolveRemoteExecutionProven(ds({}))).toBe(false);
  });
});

/**
 * The launcher env must void the proof on EVERY branch, not just the workerless
 * one. A live worker always carries initConfig.backendConfig, so it can only ever
 * reach the fromInit branch — which read backendConfig alone and therefore never
 * saw the top-level per-bot env where PATH / LD_PRELOAD actually live.
 *
 * Why this matters: device-isolation is an independent credential boundary. For a
 * cloud bot with sandbox disabled it is the ONLY guard, so the worker's own
 * sandbox gate cannot be treated as a backstop. Misclassifying such a session as
 * safe_remote activates the credential while a hooked local mojo client holds it.
 */
describe('resolveRemoteExecutionProven — launcher env voids the proof on all branches', () => {
  beforeEach(() => { liveBotConfig = {}; });

  it('LIVE WORKER (fromInit): a top-level env preload voids the proof', () => {
    // The exact counter-example from review. Before the fix this returned true.
    expect(resolveRemoteExecutionProven(ds({
      backendConfig: { cloud: true },
      initEnv: { PATH: '/tmp/fake-mojo', LD_PRELOAD: '/tmp/hook.so' },
    }))).toBe(false);
  });

  it('LIVE WORKER (fromInit): a top-level PATH override alone voids it', () => {
    // PATH decides which binary runs, so it is sufficient on its own.
    expect(resolveRemoteExecutionProven(ds({
      backendConfig: { cloud: true },
      initEnv: { PATH: '/tmp/fake-mojo' },
    }))).toBe(false);
  });

  it('LIVE WORKER (fromInit): a clean cloud session is still proven remote', () => {
    // Guards against over-correcting into a proof nothing can satisfy.
    expect(resolveRemoteExecutionProven(ds({ backendConfig: { cloud: true } }))).toBe(true);
    // The canonical JWT name is the ONLY exemption in the allowlist, so a session
    // whose sole launcher var is the credential itself stays provable.
    expect(resolveRemoteExecutionProven(ds({
      backendConfig: { cloud: true },
      initEnv: { X_JWT_TOKEN: 'a.b.c' },
    }))).toBe(true);
  });

  it('LIVE WORKER (fromInit): even a benign-looking top-level var voids it', () => {
    // mojoUnprovableEnvKeys is an ALLOWLIST on purpose — execution-redirecting
    // variables cannot be enumerated — so anything not known-harmless must void
    // the proof. Asserted through the top-level field specifically, since that is
    // the layer the live-worker branch used to ignore entirely.
    expect(resolveRemoteExecutionProven(ds({
      backendConfig: { cloud: true },
      initEnv: { SOME_HARMLESS_FLAG: '1' },
    }))).toBe(false);
  });

  it('LIVE WORKER (fromInit): the mojo-block env still wins the merge', () => {
    expect(resolveRemoteExecutionProven(ds({
      backendConfig: { cloud: true, env: { LD_PRELOAD: '/tmp/hook.so' } },
      initEnv: { X_JWT_TOKEN: 'a.b.c' },
    }))).toBe(false);
  });

  it('LEGACY branch: a top-level botCfg.env preload voids the proof', () => {
    // Nothing frozen and no initConfig => legacy migration branch, which also
    // read only botCfg.mojo and skipped the peer botCfg.env.
    liveBotConfig = { mojo: { cloud: true }, env: { LD_PRELOAD: '/tmp/hook.so' } };
    expect(resolveRemoteExecutionProven(ds({}))).toBe(false);
  });

  it('LEGACY branch: a clean cloud bot is still proven remote', () => {
    liveBotConfig = { mojo: { cloud: true } };
    expect(resolveRemoteExecutionProven(ds({}))).toBe(true);
  });

  it('WORKERLESS branch: stays fixed (top-level env folded in)', () => {
    liveBotConfig = { mojo: {}, env: { LD_PRELOAD: '/tmp/hook.so' } };
    expect(resolveRemoteExecutionProven(ds({ mojoIdentity: { cloud: true } }))).toBe(false);
  });
});

/**
 * The RESTART timeline, which the static merge above does not cover.
 *
 * `ds.initConfig` is written only at spawn/refork, but a live-worker `/restart`
 * (operator, working-dir change, cli_crash auto-restart) ships
 * `latestPerBotEnvForRestart(ds)` — i.e. live `getBot().config.env` — and the
 * worker overwrites its own copy before respawning. So the child can be running
 * an env the daemon's snapshot has never seen.
 *
 * The classifier is recomputed on every device-isolation snapshot rather than
 * cached at init, so it must consult BOTH layers: whichever one is dangerous, the
 * credential boundary has to close.
 */
describe('resolveRemoteExecutionProven — live-worker restart timeline', () => {
  beforeEach(() => { liveBotConfig = {}; });

  it('a LIVE env preload voids the proof even though the snapshot is clean', () => {
    // The reported P1: start clean, add LD_PRELOAD to bots.json, /restart. The
    // respawned child carries it; the daemon snapshot still says `env:{}`.
    liveBotConfig = { env: { LD_PRELOAD: '/tmp/hook.so' } };
    expect(resolveRemoteExecutionProven(ds({
      backendConfig: { cloud: true },
      initEnv: {},
    }))).toBe(false);
  });

  it('a LIVE PATH override alone voids it', () => {
    liveBotConfig = { env: { PATH: '/tmp/fake-mojo' } };
    expect(resolveRemoteExecutionProven(ds({
      backendConfig: { cloud: true },
      initEnv: {},
    }))).toBe(false);
  });

  it('a STALE dangerous snapshot still voids it before any restart lands', () => {
    // Opposite direction: bots.json was cleaned up but no restart has happened,
    // so the running child is still hooked. Trusting live-only would flip this to
    // provable while the hooked client holds the credential.
    liveBotConfig = { env: {} };
    expect(resolveRemoteExecutionProven(ds({
      backendConfig: { cloud: true },
      initEnv: { LD_PRELOAD: '/tmp/hook.so' },
    }))).toBe(false);
  });

  it('stays provable when BOTH the snapshot and the live config are clean', () => {
    // Guards the union from collapsing into a proof nothing can satisfy.
    liveBotConfig = { env: {} };
    expect(resolveRemoteExecutionProven(ds({
      backendConfig: { cloud: true },
      initEnv: {},
    }))).toBe(true);
    liveBotConfig = { env: { X_JWT_TOKEN: 'a.b.c' } };
    expect(resolveRemoteExecutionProven(ds({
      backendConfig: { cloud: true },
      initEnv: { X_JWT_TOKEN: 'a.b.c' },
    }))).toBe(true);
  });

  it('fails closed when the bot is deregistered mid-session', () => {
    // No live launcher env to prove anything with; the stale snapshot alone is not
    // evidence about what the next restart will execute.
    liveBotConfig = undefined;
    expect(resolveRemoteExecutionProven(ds({
      backendConfig: { cloud: true },
      initEnv: {},
    }))).toBe(false);
  });
});

/**
 * The THREE-PHASE timeline, which neither the spawn snapshot nor the live config
 * can express on its own:
 *
 *   1. clean start                        → child is clean
 *   2. add LD_PRELOAD, then /restart      → child is now hooked
 *   3. clear the config, but DO NOT restart → child is STILL hooked
 *
 * At phase 3 both observable layers read clean, so the proof used to return
 * safe_remote while a hooked mojo client held the activated credential. The
 * generation's applied-env ledger is the third input that closes it.
 */
describe('resolveRemoteExecutionProven — applied-env ledger (three-phase)', () => {
  beforeEach(() => { liveBotConfig = {}; });

  it('a key applied earlier in this generation still voids the proof', () => {
    // Phase 3 exactly: snapshot clean, live clean, ledger remembers the restart.
    liveBotConfig = { env: {} };
    expect(resolveRemoteExecutionProven(ds({
      backendConfig: { cloud: true },
      initEnv: {},
      appliedKeys: ['LD_PRELOAD'],
    }))).toBe(false);
  });

  it('a failed or coalesced clean restart cannot clear the risk', () => {
    // A clean env being SENT is not proof it was applied — the restart may fail or
    // be merged away. The ledger is monotonic, so the risk persists.
    liveBotConfig = { env: {} };
    expect(resolveRemoteExecutionProven(ds({
      backendConfig: { cloud: true },
      initEnv: {},
      appliedKeys: ['PATH'],
    }))).toBe(false);
  });

  it('an empty ledger leaves a clean session provable', () => {
    // Guards the third input from collapsing the proof for everyone.
    liveBotConfig = { env: {} };
    expect(resolveRemoteExecutionProven(ds({
      backendConfig: { cloud: true },
      initEnv: {},
      appliedKeys: [],
    }))).toBe(true);
  });

  it('a ledger holding only the canonical JWT name stays provable', () => {
    // The credential itself is the one allowlisted name, on this path too.
    liveBotConfig = { env: {} };
    expect(resolveRemoteExecutionProven(ds({
      backendConfig: { cloud: true },
      initEnv: {},
      appliedKeys: ['X_JWT_TOKEN'],
    }))).toBe(true);
  });
});

/**
 * The DOUBLE-FORK window: a new generation does NOT prove the old child is gone.
 *
 * forkWorker's guard does `send({type:'close'})` + `kill()` + `ds.worker = null`
 * and then continues synchronously to spawn the replacement, clearing the ledger
 * at `ds.initConfig = initMsg`. `kill()` is a signal delivered, not an exit
 * observed, and for mojo a request-less close degrades to best-effort teardown —
 * so an LD_PRELOAD-injected child can still be alive, holding a credential, while
 * the new generation starts with an empty ledger and the proof flips to
 * safe_remote. This is reachable on the ordinary replacement path.
 */
describe('resolveRemoteExecutionProven — double-fork retiring generation', () => {
  beforeEach(() => { liveBotConfig = {}; });

  it('parked keys from a not-yet-exited generation still void the proof', () => {
    // The new generation's own ledger is clean (fresh reseed) — only the parked
    // layer knows the old child was handed LD_PRELOAD.
    liveBotConfig = { env: {} };
    expect(resolveRemoteExecutionProven(ds({
      backendConfig: { cloud: true },
      initEnv: {},
      appliedKeys: [],
      retiringKeys: ['LD_PRELOAD'],
    }))).toBe(false);
  });

  it('a parked PATH override alone voids it', () => {
    liveBotConfig = { env: {} };
    expect(resolveRemoteExecutionProven(ds({
      backendConfig: { cloud: true },
      initEnv: {},
      retiringKeys: ['PATH'],
    }))).toBe(false);
  });

  it('an empty parked layer leaves a clean new generation provable', () => {
    // After the retiring worker fires exit the parked layer is released, so a
    // genuinely clean replacement must not stay poisoned forever.
    liveBotConfig = { env: {} };
    expect(resolveRemoteExecutionProven(ds({
      backendConfig: { cloud: true },
      initEnv: {},
      appliedKeys: [],
      retiringKeys: [],
    }))).toBe(true);
  });
});

/**
 * Every worker-generation boundary must go through the ledger helper.
 *
 * Deleting the three call sites used to leave 109 tests across 4 files green:
 * the reset had no behavioural guard at all, and it was hand-written per site
 * (twice for normal fork, once for adopt) so it could silently drift.
 *
 * Exhaustive rather than a fixed count: a FOURTH generation boundary added later
 * without the ledger is exactly the regression this must catch.
 */
describe('worker-generation boundaries all maintain the env ledger', () => {
  const pool = readFileSync(
    new URL('../src/core/worker-pool.ts', import.meta.url),
    'utf8',
  );

  it('pairs every `ds.initConfig = initMsg` with a ledger handoff', () => {
    const lines = pool.split('\n');
    const boundaries = lines
      .map((line, i) => ({ line: line.trim(), i }))
      .filter(({ line }) => line === 'ds.initConfig = initMsg;');

    // Sentinel: the known generation boundaries (2 fork paths + adopt). If this
    // number changes, the new site must be reviewed, not silently accepted.
    expect(boundaries.length).toBeGreaterThanOrEqual(3);

    for (const { i } of boundaries) {
      // The handoff must sit in the same block, right after the assignment.
      const window = lines.slice(i, i + 8).join('\n');
      expect(window, `generation boundary at line ${i + 1} must hand off the env ledger`)
        .toContain('startNewGenerationEnvLedger(ds, initMsg.env)');
    }
  });

  it('keeps the ledger reset out of the call sites (single implementation)', () => {
    // A hand-written `= undefined` at a call site would bypass the parking rule
    // and reopen the double-fork window; only the helper may clear it.
    const resets = pool.split('\n')
      .filter((l) => l.includes('mojoAppliedUnprovableEnvKeys = undefined'));
    expect(resets).toHaveLength(1);
    const helperBody = pool.slice(pool.indexOf('export function startNewGenerationEnvLedger'));
    expect(helperBody).toContain('ds.mojoAppliedUnprovableEnvKeys = undefined;');
  });

  it('never releases parked keys from an exit signal', () => {
    // A worker exit does not prove the mojo CHILD died: kill() is a bare SIGTERM
    // (no escalation, no wait), the worker exits without awaiting it, and the
    // child may have detached descendants. Any exit-anchored release therefore
    // reopens the credential window, so there must be no release path at all.
    const clears = pool.split('\n')
      .filter((l) => l.includes('mojoRetiringUnprovableEnvKeys = undefined'));
    expect(clears).toHaveLength(0);
    expect(pool).not.toContain('releaseRetiringEnvLedgerIfSettled');

    // The only writer is the generation-boundary helper, and it assigns a parked
    // set rather than clearing.
    const helper = pool.slice(pool.indexOf('export function startNewGenerationEnvLedger'));
    expect(helper).toContain('ds.mojoRetiringUnprovableEnvKeys = parked.size > 0');
  });
});

/**
 * The layer the previous round did NOT test: emitting the old worker's `exit` was
 * treated as "settled", which released the parked ledger and flipped the proof
 * false -> true. But worker exit is the wrong anchor.
 *
 * Verified against the real teardown code, not comments:
 *   - MojoBackend.kill() -> `child.kill('SIGTERM'); child = null; exitCb(0)`.
 *     No SIGKILL escalation, no wait. `exitCb(0)` reports success for a signal
 *     that was merely SENT — a child trapping/ignoring TERM keeps running.
 *   - the worker's close case runs killCli() then process.exit(0) without
 *     awaiting the mojo child, so worker exit can precede child death.
 *   - the child can leave detached descendants, so even a per-PID exit proof
 *     would not cover the tree that holds the credential.
 */
describe('resolveRemoteExecutionProven — worker exit is not proof the mojo child died', () => {
  beforeEach(() => { liveBotConfig = {}; });

  it('stays unprovable after the retiring worker has exited', () => {
    // Simulates the post-exit state: retirement tracking is gone (no retiring
    // worker left), yet the parked keys must survive because the SIGTERM-ed mojo
    // child was never confirmed dead.
    liveBotConfig = { env: {} };
    expect(resolveRemoteExecutionProven(ds({
      backendConfig: { cloud: true },
      initEnv: {},
      appliedKeys: [],
      retiringKeys: ['LD_PRELOAD'],
    }))).toBe(false);
  });

  it('a generation boundary keeps the risk even with no retirement in flight', () => {
    // End-to-end at the boundary: the helper must park regardless of whether any
    // worker is still tracked as retiring — the previous version dropped the keys
    // in exactly this state.
    const s1 = {
      larkAppId: 'app_x',
      session: { sessionId: 'sid-boundary', backendType: 'mojo' },
      mojoAppliedUnprovableEnvKeys: ['LD_PRELOAD'],
    } as never as DaemonSession;
    startNewGenerationEnvLedger(s1, {});

    liveBotConfig = { env: {} };
    expect(resolveRemoteExecutionProven(ds({
      backendConfig: { cloud: true },
      initEnv: {},
      appliedKeys: s1.mojoAppliedUnprovableEnvKeys ?? [],
      retiringKeys: s1.mojoRetiringUnprovableEnvKeys ?? [],
    }))).toBe(false);
  });
});

describe('startNewGenerationEnvLedger — monotonic parking at a generation boundary', () => {
  function session(applied?: string[], retiring?: string[]): DaemonSession {
    return {
      larkAppId: 'app_x',
      // backendType is now load-bearing: the ledger is mojo-only, so a fixture
      // without it records nothing (which is the point of the gate).
      session: { sessionId: 'sid-generation', backendType: 'mojo' },
      ...(applied ? { mojoAppliedUnprovableEnvKeys: applied } : {}),
      ...(retiring ? { mojoRetiringUnprovableEnvKeys: retiring } : {}),
    } as never as DaemonSession;
  }

  it('PARKS the old ledger unconditionally, without consulting worker exit', () => {
    // No exit signal is trustworthy here: MojoBackend.kill() is a bare SIGTERM
    // with no escalation and no wait, and the worker exits without awaiting its
    // mojo child (which may also have detached descendants). So the parking rule
    // must not depend on retirement state at all.
    const s1 = session(['LD_PRELOAD']);
    startNewGenerationEnvLedger(s1, {});
    expect(s1.mojoAppliedUnprovableEnvKeys).toBeUndefined();   // fresh generation
    expect(s1.mojoRetiringUnprovableEnvKeys).toEqual(['LD_PRELOAD']); // remembered
  });

  it('keeps parked keys across repeated generation boundaries', () => {
    const s1 = session(['LD_PRELOAD'], ['PATH']);
    startNewGenerationEnvLedger(s1, {});
    expect([...(s1.mojoRetiringUnprovableEnvKeys ?? [])].sort())
      .toEqual(['LD_PRELOAD', 'PATH']);
    // A second boundary must not drop anything either.
    startNewGenerationEnvLedger(s1, {});
    expect([...(s1.mojoRetiringUnprovableEnvKeys ?? [])].sort())
      .toEqual(['LD_PRELOAD', 'PATH']);
  });

  it('reseeds the new generation from its own init env', () => {
    const s1 = session(['LD_PRELOAD']);
    startNewGenerationEnvLedger(s1, { NODE_OPTIONS: '--require /tmp/x.js' });
    expect(s1.mojoAppliedUnprovableEnvKeys).toEqual(['NODE_OPTIONS']);
    // …and the previous generation's key is still parked, not replaced.
    expect(s1.mojoRetiringUnprovableEnvKeys).toEqual(['LD_PRELOAD']);
  });

  it('stays empty for a session that never saw a dangerous env', () => {
    const s1 = session();
    startNewGenerationEnvLedger(s1, { X_JWT_TOKEN: 'a.b.c' });
    expect(s1.mojoAppliedUnprovableEnvKeys).toBeUndefined();
    expect(s1.mojoRetiringUnprovableEnvKeys).toBeUndefined();
  });
});

describe('rememberAppliedUnprovableEnvKeys — ledger bookkeeping', () => {
  it('accumulates across restarts instead of replacing', () => {
    const ds1 = { larkAppId: 'app_x', session: { sessionId: 'sid-ledger', backendType: 'mojo' } } as never as DaemonSession;
    rememberAppliedUnprovableEnvKeys(ds1, { LD_PRELOAD: '/tmp/a.so' });
    rememberAppliedUnprovableEnvKeys(ds1, { PATH: '/tmp/bin' });
    // A later clean payload must NOT erase what was already handed out.
    rememberAppliedUnprovableEnvKeys(ds1, {});
    expect([...(ds1.mojoAppliedUnprovableEnvKeys ?? [])].sort())
      .toEqual(['LD_PRELOAD', 'PATH']);
  });

  it('stores key NAMES only, never values', () => {
    const ds1 = { larkAppId: 'app_x', session: { sessionId: 'sid-ledger', backendType: 'mojo' } } as never as DaemonSession;
    rememberAppliedUnprovableEnvKeys(ds1, { LD_PRELOAD: '/tmp/secret-value.so' });
    expect(ds1.mojoAppliedUnprovableEnvKeys).toEqual(['LD_PRELOAD']);
    expect(JSON.stringify(ds1.mojoAppliedUnprovableEnvKeys))
      .not.toContain('secret-value');
  });

  it('ignores the allowlisted canonical JWT name', () => {
    const ds1 = { larkAppId: 'app_x', session: { sessionId: 'sid-ledger', backendType: 'mojo' } } as never as DaemonSession;
    rememberAppliedUnprovableEnvKeys(ds1, { X_JWT_TOKEN: 'a.b.c' });
    expect(ds1.mojoAppliedUnprovableEnvKeys).toBeUndefined();
  });

  it('deduplicates a key handed out repeatedly', () => {
    const ds1 = { larkAppId: 'app_x', session: { sessionId: 'sid-ledger', backendType: 'mojo' } } as never as DaemonSession;
    rememberAppliedUnprovableEnvKeys(ds1, { LD_PRELOAD: '/a' });
    rememberAppliedUnprovableEnvKeys(ds1, { LD_PRELOAD: '/b' });
    expect(ds1.mojoAppliedUnprovableEnvKeys).toEqual(['LD_PRELOAD']);
  });
});
