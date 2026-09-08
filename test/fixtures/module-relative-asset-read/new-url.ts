// FIXTURE — not real code. `new URL('./x', import.meta.url)` is the other common idiom
// for reading a sibling file, and it resolves to /$bunfs/root under --compile too.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export function readIconViaUrl(): Buffer {
  return readFileSync(fileURLToPath(new URL('./favicon.png', import.meta.url)));
}
