import { readFileSync } from 'node:fs';

/**
 * The exit status of a pane process the tmux server has not reaped yet.
 *
 * tmux publishes `#{pane_dead_status}` only after it has `waitpid()`ed the
 * pane's process. Until then a dead pane reads `1:` — dead, no status — and
 * the process lingers as a zombie whose parent is the tmux server. Normally
 * that window lasts milliseconds. On CI it stayed open for the remaining ~18s
 * of a test (#2453): the pane process was still a zombie child of the server
 * and neither `pane_dead_status` nor `pane_dead_signal` was ever set, so a real
 * `exit 3` was reported as the sentinel 1. Asking tmux longer cannot help when
 * tmux has not looked.
 *
 * The kernel already holds the answer: a zombie keeps its wait status in
 * /proc/<pid>/stat field 52 (`exit_code`, Linux >= 3.5, waitpid() encoding),
 * the very value tmux would read. While the process is an unreaped zombie of
 * the tmux server its pid cannot have been handed to anyone else, so the value
 * is that pane's own. Anything else — not a zombie, another parent, no /proc
 * (macOS), unreadable — is "don't know", and the caller keeps asking tmux.
 */
export type UnreapedPaneExit =
  | { kind: 'exited'; code: number }
  | { kind: 'signaled'; signal: number };

/** Parse `/proc/<pid>/stat` text. Pure, for deterministic tests. */
export function parseUnreapedPaneExit(stat: string, serverPid: number): UnreapedPaneExit | null {
  // Field 2 (comm) is parenthesised and may itself contain spaces or ')', so
  // fields are counted from the LAST ')': fields[0] is field 3 (state).
  const close = stat.lastIndexOf(')');
  if (close < 0) return null;
  const fields = stat.slice(close + 1).trim().split(/\s+/);
  const raw = fields[52 - 3];
  if (fields[0] !== 'Z' || Number(fields[1]) !== serverPid || raw === undefined || !/^\d+$/.test(raw)) return null;
  const status = Number(raw);
  const signal = status & 0x7f;
  if (signal === 0) {
    const code = (status >> 8) & 0xff;
    // The kernel also prints 0 when this reader may not inspect the task, so a
    // clean exit stays tmux's to report rather than being guessed here.
    return code === 0 ? null : { kind: 'exited', code };
  }
  if (signal === 0x7f) return null; // stopped, not an exit
  return { kind: 'signaled', signal };
}

/** Read the kernel's record of an unreaped pane process; null when unknown. */
export function readUnreapedPaneExit(
  panePid: number,
  serverPid: number,
  readStat: (path: string) => string = path => readFileSync(path, 'utf8'),
): UnreapedPaneExit | null {
  // A missing pid (NaN) names no /proc entry, and the read below fails closed.
  try {
    return parseUnreapedPaneExit(readStat(`/proc/${panePid}/stat`), serverPid);
  } catch {
    return null;
  }
}
