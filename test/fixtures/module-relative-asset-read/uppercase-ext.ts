// FIXTURE — not real code. An UPPERCASE asset extension.
//
// WHY THIS EXISTS: the gate's `ASSET_EXT` carries an `i` flag so `ICON.PNG` is caught
// as well as `icon.png`. That flag genuinely changes behaviour (measured: without `i`,
// `join(here, 'ICON.PNG')` does not match), but no fixture exercised it — so removing
// the flag left the whole suite GREEN. A mutation that survives because no case covers
// that dimension is the same "no test subject" failure the two-pass lesson is about,
// one level down.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export function readUppercaseAsset(): Buffer {
  const here = import.meta.dirname;
  return readFileSync(join(here, 'BRAND.PNG'));
}
