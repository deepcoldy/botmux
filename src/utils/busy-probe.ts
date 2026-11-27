import { stripAnsiScreenText } from './idle-detector.js';

/** Tail region of a screen snapshot scanned for a CLI busyPattern.
 *  Strips ANSI FIRST: captureViewport()/captureCurrentScreen() return tmux
 *  `capture-pane -e` output with SGR/control codes at line starts (e.g.
 *  `\x1b[39m  \x1b[38;5;211m⏵⏵ …`). Line-anchored busyPatterns (claude-code's
 *  `^\s*[⏵⏸]…`) never match through that lead-in, so the pre-idle veto
 *  silently never fires. Uses the SAME stripping as the IdleDetector PTY
 *  stream path so both probes see identical text. */
export function busyProbeRegion(content: string, cliId?: string): string {
  const lines = stripAnsiScreenText(content).split(/\r?\n/);
  const tailLineCount = Math.max(12, Math.ceil(lines.length / 3));
  let end = lines.length;
  // Cursor can draw its composer above blank viewport rows, especially in
  // tmux before the chat fills the pane. Keep the window based on pane height.
  if (cliId === 'cursor') {
    while (end > 0 && lines[end - 1]!.trim() === '') end--;
  }
  return lines.slice(Math.max(0, end - tailLineCount), end).join('\n');
}
