import type { CliAdapter } from '../adapters/cli/types.js';
import { busyProbeRegion } from './busy-probe.js';

/** Shared decisions for an incoming message and the active queue drain. */
export function resolvePtyInputPolicy(
  adapter: Pick<CliAdapter, 'supportsTypeAhead' | 'postTerminalPromptFence'>,
  authoritativeScreen: boolean,
  runtimeTypeAheadReady = false,
): { supportsTypeAhead: boolean; allowBackToBackWrites: boolean } {
  // A viewport-fenced adapter may park input only where that fence can run.
  // ZMX history can contain stale scrollback, so retain serial delivery there.
  // Adapters without this opt-in preserve their existing backend behavior.
  const supportsTypeAhead = (adapter.supportsTypeAhead === true || runtimeTypeAheadReady)
    && (adapter.postTerminalPromptFence !== true || authoritativeScreen);
  return {
    supportsTypeAhead,
    allowBackToBackWrites: adapter.postTerminalPromptFence !== true || supportsTypeAhead,
  };
}

function lastPatternIndex(pattern: RegExp | undefined, text: string): number {
  if (!pattern || !text) return -1;
  const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
  const scan = new RegExp(pattern.source, flags);
  let last = -1;
  for (let match = scan.exec(text); match; match = scan.exec(text)) {
    last = match.index;
    if (match[0].length === 0) scan.lastIndex += 1;
  }
  return last;
}

/** Inspect current viewport content, excluding tmux's unused bottom rows. */
export function inspectPostTerminalComposer(
  capturedScreen: string,
  busyPattern: RegExp | undefined,
  composerPattern: RegExp,
): { ready: boolean; busyAt: number; composerAt: number } {
  const screen = busyProbeRegion(capturedScreen.trimEnd());
  const busyAt = lastPatternIndex(busyPattern, screen);
  const composerAt = lastPatternIndex(composerPattern, screen);
  return { ready: composerAt >= 0 && composerAt > busyAt, busyAt, composerAt };
}
