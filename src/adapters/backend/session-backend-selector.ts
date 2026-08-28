import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';

import { HerdrBackend } from './herdr-backend.js';
import { PtyBackend } from './pty-backend.js';
import { MojoBackend } from './mojo-backend.js';
import { isMojoFullyRemote } from './sandbox.js';
import { mojoRemoteProofFailureReason } from './mojo-types.js';
import type { EffectiveMojoConfig } from './mojo-types.js';
import { RiffBackend, type RiffBackendConfig } from './riff-backend.js';
import { TmuxBackend } from './tmux-backend.js';
import { TmuxPipeBackend } from './tmux-pipe-backend.js';
import { ZellijBackend } from './zellij-backend.js';
import { ZmxBackend } from './zmx-backend.js';
import type { BackendType, PersistentBackendTarget, SessionBackend } from './types.js';

const MANAGED_HERDR_AGENT_PREFIX = 'botmux-';
const MANAGED_HERDR_AGENT_TOKEN_LENGTH = 25;
const UUID_SESSION_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STRONG_MANAGED_HERDR_AGENT_RE = /^botmux-[0-9a-z]{25}$/;

/**
 * Stable, collision-resistant Herdr agent identity for a Botmux session and
 * (in production) its canonical Botmux data root.
 *
 * Herdr 0.7.5 limits agent names to 32 lowercase ASCII characters. A UUID does
 * not fit beside the historical `botmux-` prefix verbatim, but its complete
 * 128-bit value fits in 25 base36 digits (36^25 > 2^128). Non-UUID imported
 * session ids and data-root-scoped identities use a deterministic 128-bit
 * SHA-256 prefix instead.
 */
export function managedHerdrAgentName(
  sessionId: string,
  ownershipScope?: string,
): string {
  let identityHex: string;
  if (ownershipScope) {
    let canonicalScope: string;
    try {
      canonicalScope = realpathSync(ownershipScope);
    } catch {
      canonicalScope = resolve(ownershipScope);
    }
    identityHex = createHash('sha256')
      .update(canonicalScope)
      .update('\0')
      .update(sessionId)
      .digest('hex')
      .slice(0, 32);
  } else if (UUID_SESSION_ID_RE.test(sessionId)) {
    identityHex = sessionId.replaceAll('-', '');
  } else {
    identityHex = createHash('sha256').update(sessionId).digest('hex').slice(0, 32);
  }
  const token = BigInt(`0x${identityHex}`).toString(36)
    .padStart(MANAGED_HERDR_AGENT_TOKEN_LENGTH, '0');
  return `${MANAGED_HERDR_AGENT_PREFIX}${token}`;
}

/** True only for the strong managed-agent format introduced after the legacy
 * `botmux-${sessionId.slice(0, 8)}` scheme. Persisted legacy names remain valid
 * exact targets for reattach/explicit close, but must not be inferred as safe
 * startup-orphan cleanup authority.
 */
export function isStrongManagedHerdrAgentName(agentName: string): boolean {
  return STRONG_MANAGED_HERDR_AGENT_RE.test(agentName);
}

/**
 * Retire an old shared-host Herdr agent before a sandbox/MCP incarnation moves
 * the logical session to its data-root-scoped managed target.
 *
 * The durable target stamp is also our cleanup authority. Only the current
 * strong identity proves that the exact pane belongs to this Botmux session;
 * persisted legacy short names are safe reattach coordinates, but not enough
 * authority for automatic destruction. Every close is followed by a probe so
 * Herdr command failures cannot silently turn into a duplicate CLI.
 */
export function retireSupersededRecordedHerdrTarget(opts: {
  sessionId: string;
  ownershipScope?: string;
  reuseRecordedHerdrTarget: boolean;
  persistentBackendTarget?: PersistentBackendTarget;
}): void {
  if (opts.reuseRecordedHerdrTarget) return;
  const recorded = opts.persistentBackendTarget;
  if (recorded?.backendType !== 'herdr' || !recorded.agentName) return;

  const replacementSessionName = HerdrBackend.managedSessionName();
  const replacementAgentName = managedHerdrAgentName(opts.sessionId, opts.ownershipScope);
  if (
    recorded.sessionName === replacementSessionName
    && recorded.agentName === replacementAgentName
  ) {
    return;
  }

  const exactTarget = `${recorded.sessionName}/${recorded.agentName}`;
  const initialProbe = HerdrBackend.probeAgent(recorded.sessionName, recorded.agentName);
  if (initialProbe === 'missing') return;
  if (initialProbe === 'unknown') {
    throw new Error(
      `[herdr migration] probe inconclusive for recorded target ${exactTarget}; `
      + 'refusing to start a replacement until the old agent can be verified',
    );
  }

  if (!isStrongManagedHerdrAgentName(recorded.agentName)) {
    throw new Error(
      `[herdr migration] legacy Herdr target ${exactTarget} is still live; `
      + 'close that old Botmux session/agent explicitly, then retry',
    );
  }
  if (recorded.agentName !== replacementAgentName) {
    throw new Error(
      `[herdr migration] recorded Herdr target ${exactTarget} does not match this `
      + 'Botmux data root; close the old Botmux session/agent explicitly, then retry',
    );
  }

  // Close only the exact pane. The surrounding host may be user-owned or may
  // contain agents belonging to other Botmux sessions.
  HerdrBackend.killAgent(recorded.sessionName, recorded.agentName);
  const postKillProbe = HerdrBackend.probeAgent(recorded.sessionName, recorded.agentName);
  if (postKillProbe !== 'missing') {
    throw new Error(
      `[herdr migration] could not verify removal of recorded target ${exactTarget} `
      + `(probe: ${postKillProbe}); refusing to start a duplicate`,
    );
  }
}

export type BackendGateDecision =
  | { action: 'spawn' }
  | { action: 'gate'; reason: string };

/**
 * Hard gate (PTY 退役): a requested *persistent* backend (tmux/herdr/zellij/zmx)
 * that isn't functional on this host no longer silently degrades to raw PTY.
 * That silent fallback was the root of the "secretly running on PTY, then
 * hitting all of PTY's problems (no survival across daemon restart, etc.)"
 * bug class. Instead the worker refuses to spawn and posts an actionable card.
 *
 * PTY stays reachable ONLY as an explicit opt-in — `BACKEND_TYPE=pty` or a
 * per-bot `backendType: 'pty'` — which arrives here as `requested === 'pty'`
 * and is always allowed straight through.
 *
 * `hasExistingSession` lets an already-running persistent session reattach
 * regardless of a transient functional-probe failure (the known live session
 * is more authoritative than a separate capability check — see PR#249):
 * abandoning it would spawn a duplicate CLI and orphan the real conversation.
 * tmux/zellij capability probes use disposable sessions; ZMX checks its
 * version and full-list control plane; Herdr uses `herdr --version`.
 *
 * `existingSessionUnknown` is the third state of that existence check: the
 * probe itself got no answer (a timeout under host load), which a
 * `hasSession()`-style boolean reports as "no session". Gating on that turns a
 * false negative on the CHEAP check into a hard refusal for a session whose
 * pane is alive. So an indeterminate existence answer spawns rather than gates
 * — the reverse asymmetry from a kill-verification, where an unanswered probe
 * must NOT be read as success. Callers that deliberately gate on an
 * indeterminate result (ZMX ownership / protocol version, where adopting
 * someone else's session is the worse outcome) simply leave this unset.
 */
export function decideBackendGate(opts: {
  requested: BackendType;
  available: boolean;
  hasExistingSession: boolean;
  existingSessionUnknown?: boolean;
}): BackendGateDecision {
  if (opts.requested === 'pty') return { action: 'spawn' };
  if (opts.hasExistingSession) return { action: 'spawn' };
  if (opts.existingSessionUnknown) return { action: 'spawn' };
  if (opts.available) return { action: 'spawn' };
  return { action: 'gate', reason: `${opts.requested} 后端在本机不可用` };
}

/** User-facing card shown when {@link decideBackendGate} gates a session. */
export function backendGateUserMessage(backend: BackendType, reason: string): string {
  const installHint =
    backend === 'tmux'
      ? 'macOS: brew install tmux ｜ Debian/Ubuntu: sudo apt-get install -y tmux ｜ 其它发行版用对应包管理器安装 tmux'
      : backend === 'zmx'
        ? '需要 zmx >= 0.7.0（send 不再抢占 client leadership）｜macOS: brew install neurosnap/tap/zmx ｜ Linux: 装官方 release binary ｜ mise: mise use -g github:neurosnap/zmx@latest'
      : `请确认 ${backend} 已正确安装并可用`;
  return [
    `⚠️ 本机 ${backend} 不可用，无法启动会话。`,
    `原因：${reason}`,
    `请安装/修复后重试 —— ${installHint}`,
    `（如确需在没有 ${backend} 的环境运行，可显式设置环境变量 BACKEND_TYPE=pty 用 PTY 后端兜底；` +
      `但 PTY 会话不跨 daemon 重启存活，仅作应急。）`,
  ].join('\n');
}

/**
 * File/read isolation is currently enforced only when Botmux owns the local
 * launch wrapper (PTY or tmux). Herdr, Zellij, and ZMX own/spawn the child
 * outside that bwrap/Seatbelt boundary, so they must fail before backend
 * selection or migration mutates any live resource. Riff is remote and applies
 * its own sandbox; local isolation is intentionally bypassed for it.
 */
export function backendSandboxCompatibilityError(opts: {
  backendType: BackendType;
  fileSandboxRequested: boolean;
  /** Compatibility input for callers that still model standalone read
   * isolation. The worker passes false because its unified sandbox request
   * already folds in the legacy readIsolation flag on every host. */
  effectiveReadIsolationRequested: boolean;
  /**
   * mojo only: proof-of-remote inputs. `env` / `jwtEnv` are part of the proof, not
   * decoration — the launcher env decides which binary actually runs (see
   * mojoUnprovableEnvKeys), so leaving them out let a redirected launcher pass.
   */
  mojoConfig?: {
    cloud?: boolean;
    localDaemon?: boolean;
    wrapperCli?: string;
    jwtEnv?: string;
    env?: Record<string, string>;
  };
}): string | undefined {
  const isolationRequested =
    opts.fileSandboxRequested || opts.effectiveReadIsolationRequested;
  if (!isolationRequested) return undefined;
  if (
    opts.backendType === 'pty'
    || opts.backendType === 'tmux'
    || opts.backendType === 'riff'
  ) return undefined;
  if (opts.backendType === 'mojo') {
    // A fully-remote mojo session (cloud on, localDaemon off) executes nothing
    // locally, so there is nothing for botmux's local sandbox to confine —
    // same rationale as riff, and blocking it would brick sandbox-enabled bots.
    //
    // But mojo spawns its binary locally every turn, so with cloud off (or
    // localDaemon on) the tools DO touch this host. MojoBackend does not launch
    // that child under the sandbox wrapper, so honouring `sandbox: true` here is
    // impossible — fail CLOSED with an actionable message rather than running
    // unisolated while the user believes they are sandboxed.
    if (isMojoFullyRemote(opts.mojoConfig)) return undefined;
    // Explanation comes from the shared helper, NOT from a copy local to this gate:
    // the mandatory device-isolation path refuses the same sessions and used to
    // give different (and, for an env blocker, unusable) advice. See
    // mojoRemoteProofFailureReason.
    return 'backend "mojo" cannot prove it runs nothing locally, so the local '
      + `sandbox must stay engaged: ${mojoRemoteProofFailureReason(opts.mojoConfig)} `
      + 'Otherwise disable sandbox for this bot';
  }
  return `backend "${opts.backendType}" does not support file/read isolation; `
    + 'use tmux/pty or disable sandbox for this bot';
}

/** Actionable card shown before an incompatible backend/isolation launch fails. */
export function backendSandboxCompatibilityUserMessage(reason: string): string {
  return [
    '⚠️ 当前后端无法执行 botmux 的文件沙盒或读隔离，已拒绝启动以避免未隔离运行。',
    `原因：${reason}`,
    '请将该 bot 的 backendType 改为 tmux / pty，或关闭 sandbox（含全局 BOTMUX_SANDBOX）及 legacy readIsolation 后重试。',
  ].join('\n');
}

export interface SelectedSessionBackend {
  backend: SessionBackend;
  isTmuxMode: boolean;
  isPipeMode: boolean;
  /** True for the pty-under-zellij backend. From the worker's POV it behaves
   *  like the non-tmux (pty) path — screenshots via the headless renderer, web
   *  terminal via relay — but it owns a persistent zellij session internally. */
  isZellijMode: boolean;
  persistentSessionName?: string;
  /** Exact resource owned by this Botmux session; persisted by the daemon. */
  persistentBackendTarget?: PersistentBackendTarget;
  isReattach?: boolean;
  /** Set when this spawn creates its deterministic Botmux-owned Herdr session. */
  createdHerdrSessionName?: string;
}

export function selectSessionBackend(opts: {
  sessionId: string;
  backendType: BackendType;
  backendConfig?: RiffBackendConfig | EffectiveMojoConfig;
  /** Canonical local ownership boundary used to keep machine-wide Herdr agent
   * names distinct across independent Botmux data roots/checkouts. */
  herdrOwnershipScope?: string;
  /** Migration compatibility for sessions previously placed in a shared user host. */
  reuseRecordedHerdrTarget?: boolean;
  persistentBackendTarget?: PersistentBackendTarget;
  hasExistingSession?: boolean;
  /** Host-persistent journal for fail-closed ZMX composer recovery. */
  zmxRecoveryStateDir?: string;
}): SelectedSessionBackend {
  if (opts.backendType === 'mojo') {
    // Unlike riff, an absent config is FINE: every mojo field is optional and
    // the bare `mojo` binary on PATH with an ambient login is a valid setup.
    return {
      backend: new MojoBackend(
        (opts.backendConfig ?? {}) as EffectiveMojoConfig,
        opts.sessionId,
      ),
      isTmuxMode: false,
      isPipeMode: false,
      isZellijMode: false,
    };
  }

  if (opts.backendType === 'riff') {
    if (!opts.backendConfig) {
      throw new Error('riff backend requires backendConfig (baseUrl, etc.)');
    }
    return {
      backend: new RiffBackend(opts.backendConfig as RiffBackendConfig, opts.sessionId),
      isTmuxMode: false,
      isPipeMode: false,
      isZellijMode: false,
    };
  }

  if (opts.backendType === 'zmx') {
    const sessionName = ZmxBackend.sessionName(opts.sessionId);
    const reattach = opts.hasExistingSession ?? ZmxBackend.hasSession(sessionName);
    return {
      backend: new ZmxBackend(sessionName, {
        ownsSession: true,
        isReattach: reattach,
        sessionId: opts.sessionId,
        recoveryStateDir: opts.zmxRecoveryStateDir,
      }),
      isTmuxMode: false,
      // ZMX is observed out-of-band (`zmx tail`) and driven independently
      // (`zmx send`), matching the worker's pipe-backend data path rather than
      // a bidirectional PTY attach client.
      isPipeMode: true,
      isZellijMode: false,
      persistentSessionName: sessionName,
      persistentBackendTarget: { backendType: 'zmx', sessionName },
      isReattach: reattach,
    };
  }

  if (opts.backendType === 'zellij') {
    const sessionName = ZellijBackend.sessionName(opts.sessionId);
    // Prefer the caller's frozen existence decision when supplied: the worker
    // resolves a tri-state probe once (biasing an indeterminate answer toward
    // "reattach", since a live pane is more authoritative than a load-timed-out
    // probe — the same asymmetry decideBackendGate uses) and refreshes it to
    // "gone" after any teardown, so a post-kill re-selection cold-spawns rather
    // than reattaching to what it just removed. A bare live `hasSession()`
    // cannot tell those two call sites apart, so only fall back to it when no
    // decision was threaded in (default callers / unit tests).
    const reattach = opts.hasExistingSession ?? ZellijBackend.hasSession(sessionName);
    // A threaded-in decision is authoritative — tell the backend to honour it
    // verbatim and skip spawn()'s `|| hasSession()` self-heal, which would
    // otherwise re-probe and could reattach to a pane a teardown gate just
    // removed. Default callers (no decision) keep the self-heal via 'auto'.
    const reattachDecision = opts.hasExistingSession === undefined ? 'auto' : 'frozen';
    return {
      backend: new ZellijBackend(sessionName, { ownsSession: true, isReattach: reattach, reattachDecision }),
      isTmuxMode: false,
      isPipeMode: false,
      isZellijMode: true,
      persistentSessionName: sessionName,
      persistentBackendTarget: { backendType: 'zellij', sessionName },
      isReattach: reattach,
    };
  }

  if (opts.backendType === 'pty') {
    return {
      backend: new PtyBackend(),
      isTmuxMode: false,
      isPipeMode: false,
      isZellijMode: false,
    };
  }

  if (opts.backendType === 'herdr') {
    const ownedSessionName = HerdrBackend.sessionName(opts.sessionId);
    // A restarted worker must reattach to the SAME shared host selected by the
    // prior generation. Re-selecting from UI current/default state could pick a
    // different workspace, start a duplicate CLI there, and orphan
    // the still-live managed agent in the recorded host. Isolation/MCP callers
    // explicitly disable shared reuse, so they intentionally ignore this stamp
    // and converge back to the machine-wide Botmux-managed session.
    const recorded = opts.reuseRecordedHerdrTarget === false
      ? undefined
      : opts.persistentBackendTarget?.backendType === 'herdr'
        && opts.persistentBackendTarget.agentName
        ? opts.persistentBackendTarget
        : undefined;
    if (recorded) {
      const hostProbe = HerdrBackend.probeSession(recorded.sessionName);
      if (hostProbe === 'unknown') {
        throw new Error(`recorded herdr session ${recorded.sessionName} probe inconclusive`);
      }
      if (hostProbe === 'exists') {
        const agentProbe = HerdrBackend.probeAgent(recorded.sessionName, recorded.agentName!);
        if (agentProbe === 'unknown') {
          throw new Error(`recorded herdr agent ${recorded.sessionName}/${recorded.agentName} probe inconclusive`);
        }
        const reattach = agentProbe === 'exists';
        return {
          backend: new HerdrBackend(recorded.sessionName, {
            agentName: recorded.agentName,
            isReattach: reattach,
            ownsSession: false,
            ownsAgent: true,
          }),
          isTmuxMode: false,
          isPipeMode: true,
          isZellijMode: false,
          persistentSessionName: recorded.sessionName,
          persistentBackendTarget: recorded,
          isReattach: reattach,
        };
      }
    }

    if (opts.reuseRecordedHerdrTarget === false) {
      // A legacy exclusive `bmx-<sid8>` host was created before sandbox/MCP
      // incarnation identity became part of Herdr placement. Reattaching it
      // would silently keep the old, differently-configured CLI alive. The
      // 8-character address is also too weak to authorize automatic teardown
      // across data roots, so require an explicit close when it still exists.
      const legacyProbe = HerdrBackend.probeSession(ownedSessionName);
      if (legacyProbe === 'unknown') {
        throw new Error(
          `legacy herdr session ${ownedSessionName} probe inconclusive; `
          + 'refusing isolation/MCP migration',
        );
      }
      if (legacyProbe === 'exists') {
        throw new Error(
          `legacy herdr session ${ownedSessionName} is still live; `
          + 'close it explicitly before enabling isolation or MCP',
        );
      }
    } else {
      // Owned isolation/MCP host. The reattach decision must be AGENT-precise, not
      // session-level: herdr can keep a live host session whose `botmux` agent row
      // has disappeared (killSession's own comment records that session dir, agent
      // metadata and process state diverge). Predicting reattach from the SESSION
      // alone would, when the agent is gone, make HerdrBackend.spawn's frozen
      // reattach guard throw every launch (kill-loop) — and the worker would have
      // skipped the cold-path setup (PENDING proof + credential-only wrapper, gated
      // on !willReattachPersistent), so a silent fresh-start would run UNWRAPPED.
      //
      // Use TRI-STATE probes (never `hasSession && hasAgent` — those collapse
      // `unknown` to false and re-introduce fail-open). Table:
      //   host unknown                     → refuse (no kill, no spawn)
      //   host missing                     → fall through to the shared-host cold path
      //   host exists, agent unknown       → refuse
      //   host exists, agent exists        → reattach the same owned host
      //   host exists, agent missing       → COLD start IN the same owned host
      //                                      (isReattach:false → worker writes
      //                                      PENDING + assembles the wrapper, then
      //                                      Herdr `agent start`s a new generation);
      //                                      no teardown of the still-live host.
      const ownedAgentName = HerdrBackend.defaultAgentName();
      const hostProbe = HerdrBackend.probeSession(ownedSessionName);
      if (hostProbe === 'unknown') {
        throw new Error(
          `owned herdr session ${ownedSessionName} probe inconclusive; `
          + 'refusing isolation/MCP reattach-vs-fresh decision',
        );
      }
      if (hostProbe === 'exists') {
        const agentProbe = HerdrBackend.probeAgent(ownedSessionName, ownedAgentName);
        if (agentProbe === 'unknown') {
          throw new Error(
            `owned herdr agent ${ownedAgentName} in ${ownedSessionName} probe inconclusive; `
            + 'refusing isolation/MCP reattach-vs-fresh decision',
          );
        }
        const agentLive = agentProbe === 'exists';
        return {
          backend: new HerdrBackend(ownedSessionName, {
            // agent missing on a live host → in-place cold start (create the agent,
            // NOT the session, which already exists).
            isReattach: agentLive,
          }),
          isTmuxMode: false,
          isPipeMode: true,
          isZellijMode: false,
          persistentSessionName: ownedSessionName,
          persistentBackendTarget: { backendType: 'herdr', sessionName: ownedSessionName },
          isReattach: agentLive,
        };
      }
      // host missing → fall through to the shared-host cold path below.
    }

    // Every fresh agent actively launched by this machine's Botmux shares the
    // reserved `botmux` Herdr host, regardless of which Lark bot, dashboard, or
    // other Botmux entry point requested it. Topics remain isolated as distinct
    // managed agents/panes. /adopt stays bound to its explicit user session.
    const hostSessionName = HerdrBackend.managedSessionName();
    const agentName = managedHerdrAgentName(opts.sessionId, opts.herdrOwnershipScope);
    const hostExists = HerdrBackend.hasSession(hostSessionName);
    const reattach = hostExists && HerdrBackend.hasAgent(hostSessionName, agentName);
    return {
      backend: new HerdrBackend(hostSessionName, {
        createSession: !hostExists,
        agentName,
        isReattach: reattach,
        ownsSession: false,
        ownsAgent: true,
      }),
      isTmuxMode: false,
      isPipeMode: true,
      isZellijMode: false,
      persistentSessionName: hostSessionName,
      persistentBackendTarget: { backendType: 'herdr', sessionName: hostSessionName, agentName },
      isReattach: reattach,
      createdHerdrSessionName: hostExists ? undefined : hostSessionName,
    };
  }

  const sessionName = TmuxBackend.sessionName(opts.sessionId);
  if (TmuxBackend.hasSession(sessionName)) {
    return {
      backend: new TmuxPipeBackend(sessionName, { ownsSession: true, isReattach: true }),
      isTmuxMode: true,
      isPipeMode: true,
      isZellijMode: false,
      persistentSessionName: sessionName,
      persistentBackendTarget: { backendType: 'tmux', sessionName },
      isReattach: true,
    };
  }

  return {
    backend: new TmuxPipeBackend(sessionName, { createSession: true, ownsSession: true }),
    isTmuxMode: true,
    isPipeMode: true,
    isZellijMode: false,
    persistentSessionName: sessionName,
    persistentBackendTarget: { backendType: 'tmux', sessionName },
    isReattach: false,
  };
}
