import { HerdrBackend } from './herdr-backend.js';
import { PtyBackend } from './pty-backend.js';
import { RiffBackend, type RiffBackendConfig } from './riff-backend.js';
import { TmuxBackend } from './tmux-backend.js';
import { TmuxPipeBackend } from './tmux-pipe-backend.js';
import { ZellijBackend } from './zellij-backend.js';
import type { BackendType, PersistentBackendTarget, SessionBackend } from './types.js';

export type BackendGateDecision =
  | { action: 'spawn' }
  | { action: 'gate'; reason: string };

/**
 * Hard gate (PTY 退役): a requested *persistent* backend (tmux/herdr/zellij)
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
 * regardless of a transient probe failure (a disposable "can we start a new
 * server?" probe is far less authoritative than a live session — see PR#249):
 * abandoning it would spawn a duplicate CLI and orphan the real conversation.
 * The caller computes it only for backends whose probe is a disposable
 * session (tmux, zellij); herdr's probe is a cheap non-destructive
 * `herdr --version`, so it passes `hasExistingSession: false`.
 */
export function decideBackendGate(opts: {
  requested: BackendType;
  available: boolean;
  hasExistingSession: boolean;
}): BackendGateDecision {
  if (opts.requested === 'pty') return { action: 'spawn' };
  if (opts.hasExistingSession) return { action: 'spawn' };
  if (opts.available) return { action: 'spawn' };
  return { action: 'gate', reason: `${opts.requested} 后端在本机不可用` };
}

/** User-facing card shown when {@link decideBackendGate} gates a session. */
export function backendGateUserMessage(backend: BackendType, reason: string): string {
  const installHint =
    backend === 'tmux'
      ? 'macOS: brew install tmux ｜ Debian/Ubuntu: sudo apt-get install -y tmux ｜ 其它发行版用对应包管理器安装 tmux'
      : `请确认 ${backend} 已正确安装并可用`;
  return [
    `⚠️ 本机 ${backend} 不可用，无法启动会话。`,
    `原因：${reason}`,
    `请安装/修复后重试 —— ${installHint}`,
    `（如确需在没有 ${backend} 的环境运行，可显式设置环境变量 BACKEND_TYPE=pty 用 PTY 后端兜底；` +
      `但 PTY 会话不跨 daemon 重启存活，仅作应急。）`,
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
  backendConfig?: RiffBackendConfig;
  /** Migration compatibility for sessions previously placed in a shared user host. */
  reuseRecordedHerdrTarget?: boolean;
  persistentBackendTarget?: PersistentBackendTarget;
}): SelectedSessionBackend {
  if (opts.backendType === 'riff') {
    if (!opts.backendConfig) {
      throw new Error('riff backend requires backendConfig (baseUrl, etc.)');
    }
    return {
      backend: new RiffBackend(opts.backendConfig, opts.sessionId),
      isTmuxMode: false,
      isPipeMode: false,
      isZellijMode: false,
    };
  }

  if (opts.backendType === 'zellij') {
    const sessionName = ZellijBackend.sessionName(opts.sessionId);
    const reattach = ZellijBackend.hasSession(sessionName);
    return {
      backend: new ZellijBackend(sessionName, { ownsSession: true, isReattach: reattach }),
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
    // and converge back to a bot-owned bmx-* session.
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

    if (HerdrBackend.hasSession(ownedSessionName)) {
      return {
        backend: new HerdrBackend(ownedSessionName, { isReattach: true }),
        isTmuxMode: false,
        isPipeMode: true,
        isZellijMode: false,
        persistentSessionName: ownedSessionName,
        persistentBackendTarget: { backendType: 'herdr', sessionName: ownedSessionName },
        isReattach: true,
      };
    }

    // Fresh Botmux topics never guess among the user's running Herdr sessions.
    // Their ordering/default/focus is UI state, not durable routing intent.
    // Keep the same ownership boundary as tmux and zellij: one deterministic
    // bmx-<sid8> mux session per Botmux conversation. /adopt is the only path
    // that intentionally binds a new Botmux conversation to a user session.
    return {
      backend: new HerdrBackend(ownedSessionName, { createSession: true }),
      isTmuxMode: false,
      isPipeMode: true,
      isZellijMode: false,
      persistentSessionName: ownedSessionName,
      persistentBackendTarget: { backendType: 'herdr', sessionName: ownedSessionName },
      isReattach: false,
      createdHerdrSessionName: ownedSessionName,
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
