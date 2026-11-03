/**
 * Parse a JSON Lines file that another process may still be appending to.
 *
 * Integration tests poll files a fake CLI or fixture server appends one line
 * per event to, while that process runs. An append is not atomic with respect
 * to a concurrent read: a poll can land between the bytes of one line, and
 * `JSON.parse` on that fragment throws — failing the test on a read that was
 * merely early (#2228). Only newline-terminated lines are complete; a trailing
 * fragment is an append still in progress and is left for the next read.
 *
 * A missing file reads as no lines. A complete line that is not JSON still
 * throws: that is a fixture bug, not a race.
 */
import { readFileSync } from 'node:fs';

export function readJsonLines<T = any>(path: string): T[] {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  return text.split('\n').slice(0, -1).filter(line => line.trim() !== '').map(line => JSON.parse(line) as T);
}
