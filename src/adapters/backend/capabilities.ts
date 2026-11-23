import type { BackendType } from './types.js';
import type { CliId } from '../cli/types.js';
import { hasAppRunnerOscControlChannel, type TurnTerminalAdapter } from '../../services/turn-terminal-capability.js';

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
 * those events cannot be recovered through its screen-only transport. hc drops
 * output a viewer has not read (a backlog over 4 MiB, a scrolling `hc read`,
 * a core restart); the screen comes back as a repaint, the OSC never.
 */
export function backendCliCompatibilityError(
  backendType: BackendType,
  cliId: CliId,
  adapter?: TurnTerminalAdapter | null,
): string | undefined {
  if (backendType === 'zmx' && ['codex-app', 'mira', 'mir', 'dsh'].includes(cliId)) {
    return `backend "zmx" cannot carry ${cliId}'s hidden OSC final/thread events; use tmux/pty`;
  }
  if (backendType === 'hc' && hasAppRunnerOscControlChannel(cliId, adapter)) {
    return `backend "hc" drops output on viewer backlog overflow and across core restarts, losing ${cliId}'s hidden OSC final/thread events; use tmux/pty`;
  }
  return undefined;
}
