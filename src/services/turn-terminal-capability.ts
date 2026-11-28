import { isCodexAppCliId, type CliAdapter } from '../adapters/cli/types.js';
import type { BackendType } from '../adapters/backend/types.js';
import { isRemoteBackendId } from '../core/remote-cli-ids.js';
import { isStructuredBridgeFallbackActive } from './structured-bridge-clis.js';

export type TurnTerminalAdapter = Pick<CliAdapter, 'claudeDataDir' | 'runnerFramedInput'>;

export interface TurnTerminalCapabilityOptions {
  readonly cliId: string | undefined;
  readonly adapter?: TurnTerminalAdapter | null;
  readonly adoptMode?: boolean;
  readonly zeroPrompt?: boolean;
  readonly backendType?: BackendType;
  readonly dshRuntime?: 'official' | 'tui';
  /** Resolved full-root COW sandbox; adopted panes are never botmux-sandboxed. */
  readonly scratch?: boolean;
}

/** Mira/Mir/headless dsh/MiniMax emit runner control records through terminal OSC. */
export const APP_RUNNER_OSC_CLI_IDS: ReadonlySet<string> = new Set(['mira', 'mir', 'dsh', 'minimax']);

/** Exact worker OSC-decoder gate. Codex App is deliberately absent: its trusted
 * control records arrive over a signed Unix socket, not terminal output. */
export function hasAppRunnerOscControlChannel(cliId: string | undefined, adapter?: TurnTerminalAdapter | null): boolean {
  return APP_RUNNER_OSC_CLI_IDS.has(cliId ?? '')
    || (cliId === 'antigravity' && adapter?.runnerFramedInput === true);
}

/** Keep worker bridge activation and daemon idle-UI decisions in lockstep.
 * ACP frames provide their own terminal. A scratch COW sandbox hides local
 * transcript mirrors from the host reader. */
export function hasStructuredBridgeTurnTerminal(opts: TurnTerminalCapabilityOptions): boolean {
  if (opts.cliId === 'antigravity') {
    if (opts.adapter?.runnerFramedInput === true) return false;
    if (opts.adoptMode === true) return true;
    // Final records can arrive while agy is waiting on a background task. The
    // bridge confirms the local ready viewport before forwarding its answer.
    if (opts.scratch === true || opts.backendType === 'zmx' || opts.backendType === 'orca') return false;
    // Use the same transcript fallback as adopt and zero-prompt turns. The
    // bridge's send-marker gate still owns deduplication for explicit sends.
    if (opts.backendType !== undefined) return !isRemoteBackendId(opts.backendType);
  }
  if (opts.cliId === 'cursor' && opts.adoptMode !== true && opts.scratch === true) return false;
  return isStructuredBridgeFallbackActive(opts.cliId, opts.adoptMode, opts.zeroPrompt);
}

/** Whether this session has a worker channel that can emit turn_terminal for
 * the current turn. This is a UI finalization capability check, not a promise
 * that every turn succeeds or that a terminal has already been observed. */
export function hasTurnTerminalCapability(opts: TurnTerminalCapabilityOptions): boolean {
  // Claude adopt retains its dedicated bridge contract, including the daemon's
  // pre-resolved bridgeJsonlPath; the generic family check below is spawn-only.
  if (opts.cliId === 'claude-code') return true;
  // Other Claude-family forks start the same transcript bridge only for spawned
  // sessions. Their adopt lanes remain screen-driven.
  if (opts.adoptMode !== true && opts.adapter?.claudeDataDir) return true;
  if (opts.backendType === 'remote-runner') return true;
  // dsh-tui shares cliId='dsh' with the SDK runtime but has no trusted runner
  // final channel. Its CoT normalizer rejects runner records for the same reason.
  if (!(opts.cliId === 'dsh' && opts.dshRuntime === 'tui')
    && (isCodexAppCliId(opts.cliId)
      || hasAppRunnerOscControlChannel(opts.cliId, opts.adapter)
      || opts.adapter?.runnerFramedInput === true)) return true;
  return hasStructuredBridgeTurnTerminal(opts);
}
