// FIXTURE — not real code. The MODERN idiom for the same hazard: `import.meta.dirname`
// is shorter than `dirname(fileURLToPath(import.meta.url))` and is what a Bun/Node
// developer reaches for first — and it resolves to the same virtual /$bunfs/root under
// --compile (MEASURED). The gate must know this syntax exists, or the next person who
// writes the obvious modern version of the exact bug ships it through a green gate.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export function readIconTheModernWay(): Buffer {
  const here = import.meta.dirname;
  return readFileSync(join(here, 'favicon.png'));
}
