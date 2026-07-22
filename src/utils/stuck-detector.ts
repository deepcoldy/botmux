/**
 * Lightweight, AI-free "stuck" detector — fires a callback when a written input
 * has not produced a completed turn within a timeout window.
 *
 * Scope (intentionally narrow): this PR targets the specific Codex PreToolUse
 * hook-review blocking state, where the CLI renders a review screen and waits
 * for t/Enter/Esc. Generic [Y/n]/permission/Press-to-continue prompts are NOT
 * handled here — they require semantic parsing that cannot be safely inferred
 * from a regex, and belong in a follow-up PR.
 *
 * The detector does NOT itself decide the CLI is stuck. It only tracks elapsed
 * time since the last write and asks the owner (worker) to confirm via the
 * `isActuallyStuck` callback — the worker knows whether inflight inputs exist,
 * whether a TUI prompt card is already posted, and whether the PTY has been
 * quiet. This avoids false positives from legitimately long turns.
 */

/** Codex hook-review screen whose documented controls are safe to expose. */
export type HookReviewScreenType = 'hooks overview' | 'pretooluse hooks detail';

export interface StuckWarningAction {
  keys: string[];
  text: string;
  isFinal: true;
  rearmStuckDetector: boolean;
}

const STUCK_WARNING_ACTIONS: Record<HookReviewScreenType, readonly StuckWarningAction[]> = {
  'hooks overview': [
    { keys: ['t'], text: '信任全部 (trust all)', isFinal: true, rearmStuckDetector: false },
    { keys: ['Enter'], text: '逐项审核 (review hooks)', isFinal: true, rearmStuckDetector: true },
    { keys: ['Escape'], text: '关闭 (close)', isFinal: true, rearmStuckDetector: false },
  ],
  'pretooluse hooks detail': [
    { keys: ['t'], text: '信任此 hook (trust)', isFinal: true, rearmStuckDetector: false },
    { keys: ['Escape'], text: '返回 (go back)', isFinal: true, rearmStuckDetector: false },
  ],
};

/** Resolve a stuck-card button by server-owned screen type and option index. */
export function resolveStuckWarningAction(
  screen: HookReviewScreenType,
  selectedIndex: number,
): StuckWarningAction | undefined {
  return STUCK_WARNING_ACTIONS[screen][selectedIndex];
}

/** Reclassify an authoritative fresh screen and write only a whitelisted action. */
export async function writeStuckWarningAction(
  expectedScreen: HookReviewScreenType,
  keys: readonly string[],
  capture: () => Promise<string | null>,
  write: (key: string) => void | Promise<void>,
  isCurrent: () => boolean = () => true,
): Promise<boolean> {
  if (keys.length !== 1 || !STUCK_WARNING_ACTIONS[expectedScreen].some(action => action.keys[0] === keys[0])) return false;
  const snapshot = await capture();
  if (!snapshot || classifyHookReviewScreen(snapshot) !== expectedScreen || !isCurrent()) return false;
  try {
    await write(keys[0]);
    return true;
  } catch {
    return false;
  }
}

/** Classify the active Codex hook-review screen. Terminal snapshots may
 * contain retained scrollback or both an overview and a newly-opened detail
 * modal, so the control footer must be at the bottom and the active region
 * starts at the bottom-most matching title. Soft-wrapped rows within that
 * semantic region are normalized before matching. */
export function classifyHookReviewScreen(snapshot: string): HookReviewScreenType | undefined {
  const lines = snapshot
    .replace(/\x1b(?:\[[0-?]*[ -\/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/g, '')
    .replace(/\r/g, '')
    .split('\n')
    .map(line => line.trimEnd());
  while (lines.length > 0 && lines.at(-1)?.trim() === '') lines.pop();

  const footerIndex = lines.length - 1;
  if (footerIndex < 0) return undefined;
  const footer = lines[footerIndex].trim();
  const footerScreen: HookReviewScreenType | undefined = /^Press t to trust all; enter to review hooks; esc to close$/i.test(footer)
    ? 'hooks overview'
    : /^Press t to trust; esc to go back$/i.test(footer)
      ? 'pretooluse hooks detail'
      : undefined;
  if (!footerScreen) return undefined;

  let titleIndex = -1;
  let screen: HookReviewScreenType | undefined;
  for (let i = footerIndex - 1; i >= 0; i -= 1) {
    if (/^\s*PreToolUse hooks\s*$/i.test(lines[i])) {
      titleIndex = i;
      screen = 'pretooluse hooks detail';
      break;
    }
    if (/^\s*Hooks\s*$/i.test(lines[i])) {
      titleIndex = i;
      screen = 'hooks overview';
      break;
    }
  }
  if (titleIndex < 0 || !screen || screen !== footerScreen) return undefined;

  const regionLines = lines.slice(titleIndex, footerIndex + 1);
  const region = regionLines.join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  const hasPendingReview = /hooks? (?:needs?|need) review before (?:it|they) can run/i.test(region);

  if (screen === 'pretooluse hooks detail'
    && hasPendingReview
    && /\[!\]\s+Hook\s+\d+\s+·\s+new/i.test(region)
    && /Event\s+PreToolUse/i.test(region)
    && /Trust\s+New hook - review required/i.test(region)) {
    return screen;
  }

  if (screen === 'hooks overview'
    && hasPendingReview
    && /Event\s+Installed\s+Active\s+Review/i.test(region)
    && /PreToolUse\s+\d+\s+\d+\s+[1-9]\d*(?:\s+Before a tool\S*)?/i.test(region)) {
    return screen;
  }

  return undefined;
}

export interface StuckDetectorCallbacks {
  /** Called when the timeout elapses. Return true to fire the warning; false
   *  to silently re-arm (e.g. the CLI just finished a long turn). */
  isActuallyStuck: () => boolean;
  /** Called once per armed window when isActuallyStuck returns true.
   *  `matchedLabel` is set when the snapshot matches a known hook-review
   *  pattern; undefined means the turn is stalled but the cause is unknown. */
  onStuck: (elapsedMs: number, matchedLabel?: string) => void;
  /** Optional: return the current terminal snapshot for pattern matching. */
  getSnapshot?: () => string;
}

export class StuckDetector {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private armedAt = 0;
  private firedThisWindow = false;
  private disposed = false;

  constructor(
    private readonly timeoutMs: number,
    private readonly callbacks: StuckDetectorCallbacks,
  ) {}

  /** Arm the detector — call right after writing input to the PTY. */
  arm(): void {
    if (this.disposed) return;
    this.disarm();
    this.armedAt = Date.now();
    this.firedThisWindow = false;
    this.timer = setTimeout(() => this.tick(), this.timeoutMs);
  }

  /** Disarm — call when the turn completes (prompt ready) or the CLI exits. */
  disarm(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.armedAt = 0;
    this.firedThisWindow = false;
  }

  dispose(): void {
    this.disposed = true;
    this.disarm();
  }

  private tick(): void {
    this.timer = null;
    if (this.disposed) return;
    if (this.firedThisWindow) return;
    if (!this.callbacks.isActuallyStuck()) {
      // CLI may have just finished — re-arm for the next window in case it
      // immediately blocks again on a follow-up prompt.
      this.arm();
      return;
    }
    // Only fire when the snapshot matches a known hook-review pattern.
    // A 15s PTY silence alone does NOT prove the turn is stuck — long model
    // thinking or tool calls can be quiet. Without a pattern match we silently
    // re-arm and keep waiting, never posting a false "CLI stuck" warning.
    const matched = this.matchSnapshot();
    if (!matched) {
      this.arm();
      return;
    }
    this.firedThisWindow = true;
    const elapsed = Date.now() - this.armedAt;
    this.callbacks.onStuck(elapsed, matched);
  }

  private matchSnapshot(): string | undefined {
    const snap = this.callbacks.getSnapshot?.();
    return snap ? classifyHookReviewScreen(snap) : undefined;
  }
}
