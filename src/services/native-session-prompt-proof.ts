import {
  isMeaningfulQueuedCommand,
  isMeaningfulUserEvent,
  type TranscriptEvent,
} from './claude-transcript.js';
import type { CodexBridgeEvent } from './codex-transcript.js';
import { stripAnsiForLog } from '../utils/crash-log.js';

/** Conservative transcript proof used only for an adopted pane whose current
 * screen was baselined (and therefore cannot emit an initial idle signal).
 * Claude writes `system/turn_duration` after an end_turn. A later meaningful
 * user/queued-command event invalidates that proof until the next duration. */
export function claudeTranscriptEndsAtPrompt(events: readonly TranscriptEvent[]): boolean {
  let completedLatestTurn = false;
  let sawTurnBoundary = false;
  for (const event of events) {
    if ((event as { isSidechain?: boolean }).isSidechain === true) continue;
    if (isMeaningfulUserEvent(event) || isMeaningfulQueuedCommand(event)) {
      completedLatestTurn = false;
      sawTurnBoundary = true;
      continue;
    }
    if (event.type === 'system' && (event as { subtype?: string }).subtype === 'turn_duration') {
      completedLatestTurn = true;
      sawTurnBoundary = true;
    }
  }
  return sawTurnBoundary && completedLatestTurn;
}

/** Codex rollout bridge already normalizes each real turn to user →
 * assistant_final, so its final event is an authoritative idle proof. */
export function codexTranscriptEndsAtPrompt(events: readonly CodexBridgeEvent[]): boolean {
  return events.length > 0 && events[events.length - 1]?.kind === 'assistant_final';
}

/** Fast screen veto for a transcript that has not appended its new user event
 * yet. Both supported native-rename TUIs render this while a turn is active.
 * Only inspect the active footer/composer neighbourhood: an old assistant
 * answer or pasted source snippet can legitimately contain these words, and a
 * viewport-wide match would permanently veto an otherwise empty prompt. */
export function hasNativeSessionBusyMarker(screen: string): boolean {
  const meaningfulLines = stripAnsiForLog(screen)
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n')
    .map(line => line.trimEnd())
    .filter(line => line.trim().length > 0);
  if (meaningfulLines.length === 0) return false;

  let lastComposerIndex = -1;
  for (let index = meaningfulLines.length - 1; index >= 0; index -= 1) {
    if (/^[ \t\u00a0]*[❯›]/.test(meaningfulLines[index]!)) {
      lastComposerIndex = index;
      break;
    }
  }
  const footerStart = Math.max(0, meaningfulLines.length - 8);
  const activeRegionStart = lastComposerIndex >= 0
    ? Math.max(footerStart, lastComposerIndex - 3)
    : footerStart;
  return meaningfulLines.slice(activeRegionStart).some((line) => {
    // A title/draft is arbitrary user text and may itself contain the hint.
    if (/^[ \t\u00a0]*[❯›]/.test(line)) return false;
    const marker = /esc to interrupt|ctrl\+c:\s*cancel/i;
    if (!marker.test(line)) return false;
    const busyVerb = /working|thinking|processing|running|generating|executing|analy[sz]ing|searching|waiting/i;
    if (busyVerb.test(line)) return true;
    // Some versions render the cancellation hint as its own dim footer row.
    // Keep that exact status form, but reject prose such as "press esc to
    // interrupt if needed" from a final answer or source snippet.
    return /^[ \t·•✢✳✶✻✽⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏…]*(?:esc to interrupt|ctrl\+c:\s*cancel)[ \t·•…]*$/i.test(line);
  });
}

/** Codex renders its empty composer with a randomized dim placeholder, e.g.
 * `bold(›) reset dim(Write tests for @filename) reset`. User-entered draft
 * text and picker rows are not dim. Preserve and parse that SGR signal instead
 * of treating arbitrary text after `›` as empty input. */
function codexSuffixIsEntirelyDim(rawLine: string): boolean {
  let dim = false;
  let afterMarker = false;
  let dimEnabledAfterMarker = false;
  let sawPlaceholder = false;

  for (let i = 0; i < rawLine.length;) {
    if (rawLine[i] === '\x1b' && rawLine[i + 1] === '[') {
      let end = i + 2;
      while (end < rawLine.length && !/[@-~]/.test(rawLine[end]!)) end += 1;
      if (end >= rawLine.length) return false;
      if (rawLine[end] === 'm') {
        const body = rawLine.slice(i + 2, end);
        const params = body === '' ? [0] : body.split(';').map(value => Number(value || 0));
        for (let paramIndex = 0; paramIndex < params.length; paramIndex += 1) {
          const param = params[paramIndex];
          // 38/48/58 introduce extended foreground/background/underline
          // colours. Their payload may legitimately contain the number 2
          // (`38;5;2` palette index or `38;2;r;g;b` RGB mode); those values
          // are data, not the standalone faint-intensity SGR code.
          if (param === 38 || param === 48 || param === 58) {
            const colorMode = params[paramIndex + 1];
            if (colorMode === 5) paramIndex += 2;
            else if (colorMode === 2) paramIndex += 4;
            continue;
          }
          if (param === 0 || param === 22) {
            dim = false;
          } else if (param === 2) {
            dim = true;
            if (afterMarker) dimEnabledAfterMarker = true;
          }
        }
      }
      i = end + 1;
      continue;
    }

    const char = rawLine[i]!;
    i += 1;
    if (!afterMarker) {
      if (char === '›') {
        afterMarker = true;
      } else if (!isHorizontalPromptWhitespace(char)) {
        // The composer marker itself must be the line's first visible token.
        // A help/modal sentence containing `press › <dim hint>` is not an
        // input target even though its suffix happens to look placeholder-like.
        return false;
      }
      continue;
    }
    if (isHorizontalPromptWhitespace(char)) continue;
    sawPlaceholder = true;
    if (!dim || !dimEnabledAfterMarker) return false;
  }

  return sawPlaceholder;
}

/** Horizontal padding emitted by the supported native composers. Claude Code
 * 2.1.x uses NBSP after its prompt glyph; keep this explicit instead of `\s`
 * so a proof can never cross a line boundary into a picker or modal row. */
function isHorizontalPromptWhitespace(char: string): boolean {
  return char === ' ' || char === '\t' || char === '\u00a0';
}

/** Positive proof that the adopted TUI is showing its empty composer rather
 * than a slash-command picker/modal. A transcript terminal marker only proves
 * that the latest model turn ended; `/model` and similar pickers preserve that
 * old marker while changing the active keyboard target. Requiring the CLI's
 * bare prompt line keeps native administrative commands out of those UIs.
 *
 * `[ \t\u00a0]` is intentional: `\s` would cross newlines and could
 * accidentally join a picker row to an unrelated glyph on the next line. */
export function hasNativeSessionIdleComposer(
  screen: string,
  cliId: 'claude-code' | 'codex',
): boolean {
  const marker = cliId === 'claude-code' ? '❯' : '›';
  const rawLines = screen.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const markerLines = rawLines.filter(line => stripAnsiForLog(line).includes(marker));
  const activeRawMarkerLine = markerLines.at(-1);
  if (activeRawMarkerLine === undefined) return false;
  const activeMarkerLine = stripAnsiForLog(activeRawMarkerLine);
  const barePrompt = cliId === 'claude-code'
    ? /^[ \t\u00a0]*❯[ \t\u00a0]*$/
    : /^[ \t\u00a0]*›[ \t\u00a0]*$/;
  if (barePrompt.test(activeMarkerLine)) return true;
  return cliId === 'codex' && codexSuffixIsEntirelyDim(activeRawMarkerLine);
}
