/**
 * Read a `tmux capture-pane -e -p` viewport into cells, synchronously.
 *
 * capture-pane prints one line per screen row: the row's characters with SGR
 * sequences wherever an attribute changes, nothing else that moves the cursor.
 * That makes the rows directly readable without a terminal emulator — which
 * matters for a caller that must decide in the same tick it writes: xterm
 * parses asynchronously, and the long-lived renderer that is up to date
 * synchronously is not the pane (it keeps the size the worker spawned with,
 * while a web terminal resizes the real pane — see transient-snapshot.ts).
 *
 * Only what the recognizers read is kept: each character with its dim (SGR 2)
 * and inverse (SGR 7) state, attributes carrying over from row to row exactly
 * as a terminal fed the same bytes would. Any other escape is skipped. A row
 * holds the characters capture-pane printed (no padding to the pane width), a
 * wide character is one entry and combining marks join the character before
 * them, matching readViewportCells() for the same screen.
 */
import type { ScreenRow } from './terminal-cells.js';

const COMBINING = /^[\p{M}‍︀-️]$/u;

export function parseCapturedScreenRows(capture: string): ScreenRow[] {
  const lines = capture.split(/\r?\n/);
  // capture-pane ends every row with a newline, the last one included.
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  let dim = false;
  let inverse = false;
  const applySgr = (params: string): void => {
    const codes = params === '' ? [0] : params.split(/[;:]/).map(p => (p === '' ? 0 : Number(p)));
    for (let i = 0; i < codes.length; i++) {
      const code = codes[i];
      if (code === 0) { dim = false; inverse = false; }
      else if (code === 2) dim = true;
      else if (code === 22) dim = false;
      else if (code === 7) inverse = true;
      else if (code === 27) inverse = false;
      else if (code === 38 || code === 48 || code === 58) {
        // Extended colour: skip its arguments so they are not read as codes.
        if (codes[i + 1] === 5) i += 2;
        else if (codes[i + 1] === 2) i += 4;
      }
    }
  };
  const rows: ScreenRow[] = [];
  for (const line of lines) {
    const row: ScreenRow = [];
    const chars = Array.from(line);
    for (let i = 0; i < chars.length; i++) {
      const ch = chars[i];
      if (ch === '\x1b') {
        const next = chars[i + 1];
        if (next === '[') {
          let j = i + 2;
          let params = '';
          while (j < chars.length && /[0-9;:?<=>]/.test(chars[j])) params += chars[j++];
          while (j < chars.length && /[ -/]/.test(chars[j])) j++;
          if (chars[j] === 'm' && !/[?<=>]/.test(params)) applySgr(params);
          i = j;
        } else if (next === ']' || next === 'P' || next === '_' || next === '^') {
          // OSC / DCS / APC / PM: up to BEL or ST.
          let j = i + 2;
          while (j < chars.length && chars[j] !== '\x07' && !(chars[j] === '\x1b' && chars[j + 1] === '\\')) j++;
          i = chars[j] === '\x07' ? j : j + 1;
        } else {
          i += 1;
        }
        continue;
      }
      if (ch < ' ' || ch === '\x7f') continue;
      if (COMBINING.test(ch) && row.length > 0) {
        row[row.length - 1].ch += ch;
        continue;
      }
      row.push({ ch, dim, inverse });
    }
    rows.push(row);
  }
  return rows;
}
