import { PtyBackend } from './pty-backend.js';
import { TmuxBackend } from './tmux-backend.js';
import { TmuxPipeBackend } from './tmux-pipe-backend.js';
import type { SessionBackend } from './types.js';

export interface SelectedSessionBackend {
  backend: SessionBackend;
  isTmuxMode: boolean;
  isPipeMode: boolean;
}

export function selectSessionBackend(opts: { sessionId: string; useTmux: boolean }): SelectedSessionBackend {
  if (!opts.useTmux) {
    return {
      backend: new PtyBackend(),
      isTmuxMode: false,
      isPipeMode: false,
    };
  }

  const sessionName = TmuxBackend.sessionName(opts.sessionId);
  if (TmuxBackend.hasSession(sessionName)) {
    return {
      backend: new TmuxPipeBackend(sessionName, { ownsSession: true, isReattach: true }),
      isTmuxMode: true,
      isPipeMode: true,
    };
  }

  return {
    backend: new TmuxPipeBackend(sessionName, { createSession: true, ownsSession: true }),
    isTmuxMode: true,
    isPipeMode: true,
  };
}
