// Pure, testable helpers for the hybrid codex-family RPC input lifecycle. Kept
// out of worker.ts (which auto-registers process handlers on import) so the gate
// and the pane-ownership detection can be unit-tested with injected probes.
import { execFileSync } from 'node:child_process';
import { readCmdline, readComm, getChildPids } from './core/session-discovery.js';
import type { DaemonToWorker } from './types.js';

type InitCfg = Extract<DaemonToWorker, { type: 'init' }>;

/** CLIs that expose the codex-family `app-server --listen` + `--remote resume`
 *  protocol the RPC engine drives. codex + traex are verified identical; coco
 *  diverges (--resume flag) and needs its own verification before inclusion. */
export const RPC_CAPABLE_CLIS = new Set(['codex', 'traex']);

/** Retry cadence for native turn/completed → rollout visibility hydration.
 *  Total window is 11.55s: bounded, but intentionally aligned with the 12s
 *  first-turn persistence probe so a fast terminal does not discard fallback
 *  output merely because the rollout filesystem is a few seconds behind. */
export const CODEX_RPC_TERMINAL_HYDRATION_DELAYS_MS = [
  50,
  100,
  200,
  400,
  800,
  1_600,
  2_400,
  3_000,
  3_000,
] as const;

/** Ordinary transcript ingest must not advance past a turn/start ACK that has
 *  not installed its exact bridge mark yet. Native-terminal hydration for an
 *  older owner is different: it must keep draining that owner's final output
 *  even while a successor waits for ACK. Any successor events reached by that
 *  drain stay in CodexBridgeQueue's unmatched replay buffer until activation.
 *
 *  A matching awaiting owner still blocks hydration, because consuming its
 *  transcript before the exact mark exists would retire the same logical
 *  delivery against incomplete local ownership. */
export function rpcTranscriptIngestBlockedByAwaitingActivation(
  awaitingOwnerKeys: Iterable<string>,
  hydrationOwnerKey?: string,
): boolean {
  for (const ownerKey of awaitingOwnerKeys) {
    if (hydrationOwnerKey === undefined || ownerKey === hydrationOwnerKey) {
      return true;
    }
  }
  return false;
}

/** Monotonic fence for async app-server engagement. Worker IPC handlers are not
 *  serialized, so restart/close can invalidate an engage while it is awaiting
 *  /readyz, thread creation, or first-turn rollout evidence. Only the lease
 *  returned by the latest begin() may publish process-global engine state. */
export class RpcEngagementFence {
  private epoch = 0;

  begin(): number {
    this.epoch += 1;
    return this.epoch;
  }

  invalidate(): void {
    this.epoch += 1;
  }

  isCurrent(lease: number): boolean {
    return lease === this.epoch;
  }
}

/** All fail-closed gates for codex-family RPC input in ONE place so the worker's
 *  pane-branching and engageCodexRpc agree. Every excluded case degrades to the
 *  normal paste path — never a silent capability/security change:
 *   - disableCliBypass: RPC hardcodes approvalPolicy=never + dangerFullAccess, so
 *     engaging it for an approval-gated bot would silently upgrade it to full
 *     access (P1-1).
 *   - startupCommands: /effort etc. must run in the TUI before the first turn,
 *     but the fresh first turn is sent pre-spawn to persist the rollout — RPC
 *     can't honor that ordering, so fail-closed (P1-4).
 *   - wrapperCli / cliPathOverride: the app-server is launched as `<bin>
 *     app-server`, which a wrapper/alternate launcher won't satisfy the same way
 *     the TUI's buildArgs does — two launchers would diverge, so fail-closed
 *     (P1-2).
 *   - backendType !== 'tmux': the pane-ownership detection + controlled respawn
 *     are only wired for tmux. On herdr/zellij a surviving dead `--remote` pane
 *     would be misjudged as native and reattached, and pty has no persistent
 *     pane at all — so restrict RPC to tmux until each backend's replace path is
 *     built + verified. */
export interface CodexRpcRuntimeGates {
  /** Process-wide BOTMUX_SANDBOX=1 force. It is not represented in InitCfg but
   *  must gate RPC too: the app-server owns model execution and otherwise runs
   *  outside the sandbox wrapped around the viewer pane. */
  sandboxForced?: boolean;
}

export function codexRpcEligible(cfg: InitCfg, runtime: CodexRpcRuntimeGates = {}): boolean {
  const wantResume = cfg.resume === true && !!cfg.cliSessionId;
  return (
    cfg.codexRpcInput === true && RPC_CAPABLE_CLIS.has(cfg.cliId) &&
    cfg.backendType === 'tmux' &&
    cfg.adoptMode !== true && cfg.readIsolation !== true && cfg.sandbox !== true && runtime.sandboxForced !== true &&
    cfg.disableCliBypass !== true &&
    !cfg.startupCommands?.length &&
    !cfg.wrapperCli && !cfg.cliPathOverride &&
    (!!cfg.prompt || wantResume)
  );
}

/** Positive rollout evidence that THIS turn's user message was persisted (P1-1).
 *  Given a thread's drained rollout events, is there a user turn matching the
 *  prompt? session_meta (written at thread/start) is not a `kind:'user'` event,
 *  so an empty thread yields false — filename existence alone would not. Match is
 *  normalized-equal OR contains (codex may prepend AGENTS.md context to the first
 *  turn); the fresh-thread scope makes a contains-match unambiguous. */
export function rolloutUserTurnMatches(events: ReadonlyArray<{ kind: string; text: string }>, promptText: string): boolean {
  const norm = (s: string) => s.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
  const needle = norm(promptText);
  if (!needle) return false;
  return events.some(e => e.kind === 'user' && (norm(e.text) === needle || norm(e.text).includes(needle)));
}

/** Decide what to do about a codex startup dialog on an RPC `--remote` pane
 *  (P1-3 / P2). An RPC pane has no terminal input path, so a blocking dialog
 *  freezes the viewer. The update menu is disabled at the source (-c
 *  check_for_update_on_startup=false); this is only a fail-safe:
 *   - 'warn-update'  — an update menu is present (default may be "Update now") →
 *                      NEVER auto-press; warn the user, they dismiss manually.
 *   - 'dismiss-safe' — a plain "press enter to continue" with no menu → safe Enter.
 *   - 'ready'        — composer reached, no blocking dialog → stop watching.
 *   - 'wait'         — nothing actionable yet.
 *  UPDATE_DIALOG takes precedence, so a screen with both an update menu AND a
 *  "press enter" line is warned, never pressed. */
export function decideStartupDialogAction(screen: string, readyPattern?: RegExp): 'warn-update' | 'dismiss-safe' | 'ready' | 'wait' {
  if (/Update available|Update now \(runs|Skip until next version/i.test(screen)) return 'warn-update';
  if (/Press enter to continue/i.test(screen)) return 'dismiss-safe';
  if (readyPattern?.test(screen) === true) return 'ready';
  return 'wait';
}

export interface PaneProbes {
  panePidOf?: (sessionName: string) => number | undefined;
  argvOf?: (pid: number) => string[];
  commOf?: (pid: number) => string | undefined;
  childrenOf?: (pid: number) => number[];
}

/** Outcome of an engage attempt (exactly-once-priority three-state for fresh +
 *  the resume/setup states):
 *   - 'accepted'    — fresh first turn confirmed (ack or rollout evidence), or a
 *                     resume that needs its waking prompt queued is 'resumed'.
 *   - 'ambiguous'   — fresh first turn dispatched but unconfirmed → engaged, but
 *                     the prompt must NOT be resent (P1-1); caller notifies.
 *   - 'resumed'     — resume path engaged (no turn sent) → the waking prompt must
 *                     be queued for post-ready flush.
 *   - 'not-engaged' — setup failed OR fresh frame never dispatched → paste. */
export type EngageOutcome = 'accepted' | 'ambiguous' | 'resumed' | 'not-engaged';

/** Whether the FRESH first turn should use the normal confirmed pre-mark path
 *  (so the reply is attributed even if the model skips `botmux send`). ONLY
 *  'accepted' — a confirmed turn whose prompt is not re-queued. The worker also
 *  gives 'ambiguous' its own attribution-only mark plus a fail-closed owner:
 *  structured terminal retires it when visible, while exact engine teardown is
 *  the intentional fallback when no native owner can ever be mapped. That
 *  separate path never resends the prompt and prevents a permanent queue head.
 *  'not-sent'/'resumed' never reach either pre-mark path; not-sent's paste flush
 *  marks once, and resume flushes its queued prompt. */
export function shouldPreMarkFirstTurn(outcome: EngageOutcome): boolean {
  return outcome === 'accepted';
}

/** Injected effects for the init-time RPC state machine (real ones wired by the
 *  worker; fakes by tests). */
export interface RpcInitEffects {
  paneInfo: (sessionId: string) => { name: string; live: boolean } | null;
  paneIsRemote: (sessionName: string) => boolean;
  /** Refresh the session-scoped Skill/MCP generation and start its trusted MCP
   *  host before the app-server starts. For fresh RPC, this also mutates the
   *  first prompt to include the current Skill catalog. */
  prepare: () => Promise<void>;
  engage: () => Promise<EngageOutcome>;    // engageCodexRpc(cfg) — sets the module engine on success
  killVerify: (sessionName: string) => Promise<boolean>; // kill stale pane, VERIFY gone
  teardownEngine: () => void;              // stop engine + clear remote vars
  log: (m: string) => void;
  notify: (m: string) => void;             // user-visible notice
}

/** Whether the initial prompt should be pushed to pendingMessages (the exact
 *  worker wiring, extracted so the P1-1 exactly-once guarantee is unit-testable):
 *   - paste (no RPC engine)            → queue as usual.
 *   - RPC RESUME (engine + queuePrompt) → queue the waking prompt for post-ready flush.
 *   - RPC FRESH accepted/ambiguous      → engine set + queuePrompt=false → NEVER
 *     queue (the turn was pre-sent or is ambiguous; re-queuing would double-execute).
 *  args-baked first prompts skip the queue unless deferred for startup commands. */
export function shouldQueueInitialPrompt(o: {
  hasPrompt: boolean;
  rpcEngineActive: boolean;
  queuePrompt: boolean;
  passesInitialPromptViaArgs: boolean;
  deferInitialPrompt: boolean;
}): boolean {
  if (!o.hasPrompt) return false;
  const wantsQueue = !o.rpcEngineActive || o.queuePrompt;
  if (!wantsQueue) return false;
  return !o.passesInitialPromptViaArgs || o.deferInitialPrompt;
}

export interface RpcInitDecision {
  /** RPC is active → spawnCli will launch the `--remote resume` TUI. */
  engaged: boolean;
  /** The init prompt must be QUEUED (resume path: delivered by flushPending →
   *  sendTurn once the TUI is ready) rather than pre-sent (fresh) or pasted. */
  queuePrompt: boolean;
  /** A stale `--remote` pane could not be replaced — the caller MUST NOT run
   *  spawnCli (it would reattach the dead pane against the fresh-port engine). */
  abortSpawn: boolean;
}

/** Pure init-time state machine for codex-family RPC, extracted so the
 *  fresh/resume/kill-failure ORDERING is unit-testable (the worker only wires
 *  real effects + acts on the decision). Mirrors the four cases:
 *   - not eligible                     → nothing (paste).
 *   - no live pane (fresh or resume-  → prepare Skill/MCP state, then engage;
 *     without a surviving pane)          fresh pre-sends the first turn inside
 *                                         engage, resume must queue it.
 *   - live RPC-owned pane              → prepare, engage, then kill+VERIFY the stale pane;
 *                                         on success respawn (queue the prompt),
 *                                         on failure tear the engine down + abort
 *                                         spawn (never attach a stale remote pane
 *                                         to a fresh-port engine — Codex P0-2).
 *   - live native paste pane           → leave it (fail-closed paste, boundary #3). */
export async function orchestrateCodexRpcInit(
  cfg: InitCfg,
  fx: RpcInitEffects,
  runtime: CodexRpcRuntimeGates = {},
): Promise<RpcInitDecision> {
  const NONE: RpcInitDecision = { engaged: false, queuePrompt: false, abortSpawn: false };
  if (!codexRpcEligible(cfg, runtime)) return NONE;
  const pane = fx.paneInfo(cfg.sessionId);
  if (!pane || !pane.live) {
    // Fresh session, or a resume whose pane didn't survive.
    await fx.prepare();
    const outcome = await fx.engage();
    switch (outcome) {
      case 'accepted':
        // Fresh first turn confirmed delivered → engaged, do NOT re-queue.
        return { engaged: true, queuePrompt: false, abortSpawn: false };
      case 'ambiguous':
        // Fresh first turn dispatched but unconfirmed → engaged, but NEVER resend
        // (exactly-once). The notify is the authoritative result; the viewer
        // resume recovers the turn if it actually landed. The prompt is NOT
        // queued (queuePrompt:false) and must never reach pending/inflight.
        fx.notify('⚠️ 首条消息已发出但未收到确认。为避免重复执行未自动重发；请查看终端结果，如未执行请手动重发。');
        return { engaged: true, queuePrompt: false, abortSpawn: false };
      case 'resumed':
        // Resume engaged (no pre-send) → queue the waking prompt for post-ready flush.
        return { engaged: true, queuePrompt: true, abortSpawn: false };
      case 'not-engaged':
        return NONE; // setup failed or frame never dispatched → safe paste fallback
    }
  }
  if (fx.paneIsRemote(pane.name)) {
    // Surviving RPC `--remote` pane on the now-dead prior app-server (always a
    // resume). Re-engage, then replace the stale pane.
    await fx.prepare();
    const outcome = await fx.engage();
    if (outcome === 'not-engaged') {
      // The pane is still a viewer for the prior incarnation's dead app-server;
      // merely returning to the paste path would reattach that pane and silently
      // drop input. Remove it first so spawnCli can create a native paste pane.
      const gone = await fx.killVerify(pane.name);
      if (gone) return NONE;
      fx.notify('Codex RPC 会话恢复失败：新引擎未启动，且无法替换旧 --remote 面板。请重试，或 /close 后重开会话。');
      fx.log(`Codex RPC resume: engine unavailable and FAILED to kill stale --remote pane ${pane.name}; aborting init`);
      return { engaged: false, queuePrompt: false, abortSpawn: true };
    }
    const gone = await fx.killVerify(pane.name);
    if (gone) return { engaged: true, queuePrompt: true, abortSpawn: false };
    fx.teardownEngine();
    fx.notify('Codex RPC 会话恢复失败：无法替换旧 --remote 面板。请重试，或 /close 后重开会话。');
    fx.log(`Codex RPC resume: FAILED to kill stale --remote pane ${pane.name}; aborting init (never attach a stale remote pane to a fresh-port engine)`);
    return { engaged: false, queuePrompt: false, abortSpawn: true };
  }
  fx.log('Codex RPC: surviving pane is native paste (not RPC-owned) — keeping paste for this restore');
  return NONE;
}

export interface PersistentPaneKillEffects {
  kill: (sessionName: string) => void;
  isLive: (sessionName: string) => boolean;
  wait: (ms: number) => Promise<void>;
}

/** Kill a resolved persistent-session name and verify that exact name is gone.
 *  Keeping the resolved name opaque avoids accidentally applying sessionName()
 *  twice (`bmx-1234` -> `bmx-bmx-`), which would turn every failed kill into a
 *  false success and reattach the stale RPC pane. */
export async function killAndVerifyPersistentPane(
  sessionName: string,
  fx: PersistentPaneKillEffects,
  attempts = 4,
  retryMs = 250,
): Promise<boolean> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    try { fx.kill(sessionName); } catch { /* verify below */ }
    if (!fx.isLive(sessionName)) return true;
    if (attempt + 1 < attempts) await fx.wait(retryMs);
  }
  return !fx.isLive(sessionName);
}

function tmuxPanePid(sessionName: string): number | undefined {
  try {
    const out = execFileSync('tmux', ['display', '-t', sessionName, '-p', '#{pane_pid}'],
      { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 }).trim();
    const n = Number(out);
    return Number.isInteger(n) && n > 0 ? n : undefined;
  } catch { return undefined; }
}

/** Does the surviving persistent pane run a botmux RPC `--remote` TUI (vs a
 *  native paste codex/traex)? Walks the pane's process tree and inspects the LEAF
 *  argv (Linux /proc + macOS ps, via readCmdline) — NOT tmux
 *  pane_current_command, which only returns `codex`/`node` without argv. Only a
 *  codex-family process carrying `--remote` in argv counts as RPC-owned; a native
 *  `codex resume`, a bare shell, or an unreadable tree fails-closed to false so a
 *  daemon-restart resume never force-respawns a possibly-mid-turn native pane.
 *  This is a live-argv check, not a persisted marker, so there is no stale-marker
 *  hazard. Probes are injectable for tests (defaults hit the real OS/tmux). */
export function paneRunsRemoteTui(persistentSessionName: string, probes: PaneProbes = {}): boolean {
  const panePidOf = probes.panePidOf ?? tmuxPanePid;
  const argvOf = probes.argvOf ?? readCmdline;
  const commOf = probes.commOf ?? readComm;
  const childrenOf = probes.childrenOf ?? getChildPids;
  const panePid = panePidOf(persistentSessionName);
  if (panePid === undefined || !Number.isInteger(panePid) || panePid <= 0) return false;
  let frontier = [panePid];
  const seen = new Set<number>();
  for (let depth = 0; depth <= 4 && frontier.length; depth++) {
    const next: number[] = [];
    for (const pid of frontier) {
      if (seen.has(pid)) continue;
      seen.add(pid);
      const argv = argvOf(pid);
      if (argv.length) {
        const comm = commOf(pid) ?? '';
        const isCodexFamily = /^(codex|traex)/i.test(comm) || argv.some(a => /(?:^|\/)(codex|traex)$/i.test(a));
        if (isCodexFamily && argv.includes('--remote')) return true;
      }
      next.push(...childrenOf(pid));
    }
    frontier = next;
  }
  return false;
}
