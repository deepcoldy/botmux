/**
 * Parsing of `/proc/<pid>/stat` (Linux). One implementation of the comm hazard
 * and the starttime field so every identity / lock / owner check cuts the line
 * the same way.
 *
 * The line is `pid (comm) state ppid ...`. `comm` (field 2) is parenthesised and
 * may itself contain spaces, newlines or ')', so the only reliable cut is after
 * the LAST ')'. Everything after it is whitespace-separated; index 0 is field 3
 * (state), so field N lives at index N - 3.
 *
 * Process-start tokens built from these functions are stored in lock files and
 * compared across processes (`"<pid>:<starttime>"`, bootId-prefixed durable
 * identities), so the extraction rules below are load-bearing: change them and
 * a live lock / owner record stops matching.
 */

/** Index of field 22 (`starttime`, clock ticks since boot) in the array
 *  returned by {@link procStatFieldsAfterComm}. */
export const PROC_STAT_STARTTIME_INDEX = 19;

/** Fields after `(comm)`: index 0 = field 3 (state), 1 = ppid, 19 = starttime.
 *  `undefined` when the line has no ')' at all (not a stat line). */
export function procStatFieldsAfterComm(raw: string): string[] | undefined {
  const closeParen = raw.lastIndexOf(')');
  if (closeParen < 0) return undefined;
  return raw.slice(closeParen + 2).trim().split(/\s+/);
}

/** `starttime` exactly as the kernel printed it; `undefined` when absent or
 *  empty. No digit validation — use {@link procStatStartTimeDigits} when the
 *  caller must reject a garbled field. */
export function procStatStartTime(raw: string): string | undefined {
  return procStatFieldsAfterComm(raw)?.[PROC_STAT_STARTTIME_INDEX] || undefined;
}

/** `starttime` only when it is a non-empty run of ASCII digits. */
export function procStatStartTimeDigits(raw: string): string | undefined {
  const started = procStatFieldsAfterComm(raw)?.[PROC_STAT_STARTTIME_INDEX];
  return /^\d+$/.test(started ?? '') ? started : undefined;
}
