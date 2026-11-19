import type { CliAdapter } from '../adapters/cli/types.js';
import { busyProbeRegion } from './busy-probe.js';

/** True when runtime config disables approval bypass on a CLI whose blocking
 *  permission dialog uses Enter as the approve key (`antigravity`).
 *
 *  Known issue (unified screen-hold follow-up):
 *  (1) passthrough slash commands (`/effort`, `/compact`, `/model`, `/btw`,
 *      `/clear`) delivered via worker `raw_input` IPC bypass
 *      `resolvePtyInputPolicy` while busy; and
 *  (2) interactive TUI selection menus that still appear with bypass enabled
 *      (e.g. `ask_question`'s `AskQuestionModel`, Plan artifact review) also
 *      capture digit keys and Enter.
 *  Both should be resolved together by a single unified screen-based input hold
 *  (alongside `hookReviewInputHold`) that detects active confirmation/question
 *  menus, holds queued + raw input, notifies the user in Lark, and flushes once
 *  the menu clears. */
export function isTypeAheadBlockedByBypass(
  adapter: { readonly id?: string } | undefined,
  disableCliBypass: boolean | undefined,
): boolean {
  return adapter?.id === 'antigravity' && disableCliBypass === true;
}

/** Shared decisions for an incoming message and the active queue drain. */
export function resolvePtyInputPolicy(
  adapter: Pick<CliAdapter, 'supportsTypeAhead' | 'postTerminalPromptFence'> & { readonly id?: string },
  authoritativeScreen: boolean,
  runtimeTypeAheadReady = false,
  runtimeTypeAheadBlocked: boolean | { disableCliBypass?: boolean } = false,
): { supportsTypeAhead: boolean; allowBackToBackWrites: boolean } {
  // A viewport-fenced adapter may park input only where that fence can run.
  // ZMX history can contain stale scrollback, so retain serial delivery there.
  // Adapters without this opt-in preserve their existing backend behavior.
  // When runtimeTypeAheadBlocked is true (antigravity launched with
  // disableCliBypass: true, where Enter approves a permission dialog), force
  // supportsTypeAhead to false so flushPending, sendToPty, and
  // decideHardTimeoutAction all fall back to serial delivery.
  const blocked = typeof runtimeTypeAheadBlocked === 'boolean'
    ? runtimeTypeAheadBlocked
    : isTypeAheadBlockedByBypass(adapter, runtimeTypeAheadBlocked.disableCliBypass);
  const supportsTypeAhead = !blocked
    && (adapter.supportsTypeAhead === true || runtimeTypeAheadReady)
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
