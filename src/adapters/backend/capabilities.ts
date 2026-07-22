import type { BackendType } from './types.js';
import type { CliId } from '../cli/types.js';

/**
 * Whether botmux can expose its xterm.js Web Terminal for this backend.
 *
 * ZMX exposes only its authoritative plain-text `history` screen to botmux;
 * `tail` is merely a wakeup signal. That cannot reconstruct the raw ANSI TUI.
 * Native `zmx attach` remains available through the local-terminal entrypoint.
 */
export function backendSupportsWebTerminal(backendType: BackendType): boolean {
  return backendType !== 'zmx';
}

/**
 * Runner CLIs emit their authoritative final/thread events as hidden OSC.
 * ZMX history is plain terminal state after control-sequence consumption, so
 * those events cannot be recovered through its screen-only transport.
 */
export function backendCliCompatibilityError(
  backendType: BackendType,
  cliId: CliId,
): string | undefined {
  if (backendType === 'zmx' && ['codex-app', 'mira', 'mir'].includes(cliId)) {
    return `backend "zmx" cannot carry ${cliId}'s hidden OSC final/thread events; use tmux/pty`;
  }
  return undefined;
}
