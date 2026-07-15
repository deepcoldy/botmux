import { stripAnsiForLog } from '../utils/crash-log.js';
import {
  hasNativeSessionBusyMarker,
  hasNativeSessionIdleComposer,
} from './native-session-prompt-proof.js';

export type NativeSessionCommandCliId = 'claude-code' | 'codex';

const HORIZONTAL_PROMPT_PADDING = /^[ \t\u00a0]+|[ \t\u00a0]+$/g;

/**
 * Return true only when the screen contains the exact command in a supported
 * CLI composer. Slash-command picker rows may surround the composer; unlike an
 * idle proof, they are not themselves evidence that the command was submitted.
 */
interface ExactCommandDraftMatch {
  lines: string[];
  startLineIndex: number;
  endLineIndex: number;
}

function findExactCommandDraft(
  screen: string,
  command: string,
  cliId: NativeSessionCommandCliId,
): ExactCommandDraftMatch | null {
  const marker = cliId === 'claude-code' ? '❯' : '›';
  const lines = screen.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')
    .map(rawLine => stripAnsiForLog(rawLine));

  // Use only the latest composer-shaped marker. Older prompt lines remain in
  // scrollback, while picker selection rows can also start with ›/❯; neither is
  // the keyboard target whose draft this worker is about to submit.
  let composerLineIndex = -1;
  let draft = '';
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex]!.replace(/^[ \t\u00a0]+/, '');
    if (!line.startsWith(marker)) continue;
    const candidate = line.slice(marker.length).replace(HORIZONTAL_PROMPT_PADDING, '');
    if (/^(?:\d+[.)]|\[[ xX]\])(?:[ \t\u00a0]|$)/.test(candidate)) continue;
    composerLineIndex = lineIndex;
    draft = candidate;
  }
  if (composerLineIndex < 0) return null;
  if (draft === command) {
    return { lines, startLineIndex: composerLineIndex, endLineIndex: composerLineIndex };
  }
  if (!draft || !command.startsWith(draft)) return null;

  // Long titles wrap in narrow panes. Reconstruct the *entire* command from
  // physical composer rows before arming phase A. dump-screen can trim the
  // boundary space, so retain both hard-wrap and one-space-restored forms.
  // Checking equality before reading the next row keeps picker/help rows
  // below a fully reconstructed draft from invalidating valid evidence.
  let candidates = [draft];
  for (let nextIndex = composerLineIndex + 1; nextIndex < lines.length; nextIndex += 1) {
    const continuation = lines[nextIndex]!.replace(HORIZONTAL_PROMPT_PADDING, '');
    if (!continuation) return null;
    candidates = [...new Set(candidates.flatMap(value => [value + continuation, `${value} ${continuation}`]))];
    if (candidates.includes(command)) {
      return { lines, startLineIndex: composerLineIndex, endLineIndex: nextIndex };
    }
    // Picker/help rows are not composer continuation. Once no candidate can
    // still prefix-match the command, later rows cannot recover it.
    candidates = candidates.filter(value => command.startsWith(value));
    if (candidates.length === 0) return null;
  }
  return null;
}

/**
 * An exact draft can remain in scrollback after the keyboard target has moved
 * into a permission prompt or another modal. There is no new bare composer in
 * that state, so the "latest composer marker" rule alone cannot distinguish
 * the historical draft from the active UI. Reject positive modal evidence
 * below the matched draft while still allowing slash-picker/help rows and the
 * ordinary status chrome that supported composers render underneath.
 */
function hasBlockingUiBelowDraft(match: ExactCommandDraftMatch): boolean {
  const trailingLines = match.lines.slice(match.endLineIndex + 1)
    .map(line => line.trim())
    .filter(Boolean);
  if (trailingLines.length === 0) return false;

  const trailing = trailingLines.join('\n');
  const explicitModal = /\b(?:permission (?:request|required|needed)|requires? permission|requesting permission|tool (?:use )?(?:request|approval)|allow (?:this|the|tool|command|bash)|approve (?:this|the|tool|command)|confirm (?:this|the|action|command)|do you want to (?:proceed|continue|allow|run)|are you sure|select (?:a |an |the )?(?:model|option)|choose (?:a |an |the )?(?:model|option))\b/i;
  if (explicitModal.test(trailing)) return true;

  // Keep this structural fallback narrow: a question plus an explicit
  // yes/no/allow/deny choice is an interactive modal, whereas a slash-command
  // suggestion list (including a "Cancel" row) is valid draft-time chrome.
  const hasModalQuestion = trailingLines.some(line =>
    /[?？][ \t]*$/.test(line) && !/^\?[ \t]+for shortcuts\b/i.test(line),
  );
  const hasDecisionChoice = trailingLines.some(line =>
    /^(?:[❯›>][ \t]*)?(?:\d+[.)][ \t]*)?(?:yes|no|allow|deny|approve)\b/i.test(line),
  );
  return hasModalQuestion && hasDecisionChoice;
}

/**
 * Two-phase proof that a native slash command reached the active composer and
 * subsequently returned to an empty prompt. Screen hashes or an already-empty
 * prompt cannot complete the proof: the exact draft must be observed first.
 */
export class NativeSessionCommandProof {
  private capturedCliId: NativeSessionCommandCliId | null = null;
  private completed = false;

  constructor(private readonly command: string) {}

  get hasObservedDraft(): boolean {
    return this.capturedCliId !== null;
  }

  observe(screen: string, cliId: NativeSessionCommandCliId): boolean {
    if (this.completed) return true;
    if (screen.length === 0) return false;

    if (this.capturedCliId === null) {
      // An old draft can remain in scrollback above the current empty prompt.
      // Prefer the current keyboard-target proof and do not arm in that case.
      if (hasNativeSessionIdleComposer(screen, cliId)) return false;
      const match = findExactCommandDraft(screen, this.command, cliId);
      if (!match || hasBlockingUiBelowDraft(match)) return false;

      // Busy hints are arbitrary title text too. Remove the exact physical
      // composer rows before applying the footer veto so a wrapped title whose
      // continuation is exactly "esc to interrupt" / "ctrl+c: cancel" can
      // still arm phase A. A real busy footer below that draft remains visible
      // in the residual screen and is rejected.
      const residualScreen = match.lines
        .filter((_line, index) => index < match.startLineIndex || index > match.endLineIndex)
        .join('\n');
      if (hasNativeSessionBusyMarker(residualScreen)) return false;
      this.capturedCliId = cliId;
      return false;
    }

    if (hasNativeSessionBusyMarker(screen)) return false;
    if (cliId !== this.capturedCliId) return false;
    if (!hasNativeSessionIdleComposer(screen, cliId)) return false;
    this.completed = true;
    return true;
  }
}
