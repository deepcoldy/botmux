import { HerdrBackend } from './herdr-backend.js';
import { PtyBackend } from './pty-backend.js';
import { RiffBackend, type RiffBackendConfig } from './riff-backend.js';
import { TmuxBackend } from './tmux-backend.js';
import { TmuxPipeBackend } from './tmux-pipe-backend.js';
import { ZellijBackend } from './zellij-backend.js';
import type { BackendType, SessionBackend } from './types.js';

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
}

export function selectSessionBackend(opts: { sessionId: string; backendType: BackendType; backendConfig?: RiffBackendConfig }): SelectedSessionBackend {
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
    const sessionName = HerdrBackend.sessionName(opts.sessionId);
    if (HerdrBackend.hasSession(sessionName)) {
      return {
        backend: new HerdrBackend(sessionName, { isReattach: true }),
        isTmuxMode: false,
        isPipeMode: true,
        isZellijMode: false,
      };
    }

    return {
      backend: new HerdrBackend(sessionName, { createSession: true }),
      isTmuxMode: false,
      isPipeMode: true,
      isZellijMode: false,
    };
  }

  const sessionName = TmuxBackend.sessionName(opts.sessionId);
  if (TmuxBackend.hasSession(sessionName)) {
    return {
      backend: new TmuxPipeBackend(sessionName, { ownsSession: true, isReattach: true }),
      isTmuxMode: true,
      isPipeMode: true,
      isZellijMode: false,
    };
  }

  return {
    backend: new TmuxPipeBackend(sessionName, { createSession: true, ownsSession: true }),
    isTmuxMode: true,
    isPipeMode: true,
    isZellijMode: false,
  };
}
