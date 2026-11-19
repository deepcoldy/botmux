import type { TraexModelLoadSnapshot } from './traex-model-load.js';

/** One flow, one in-flight read. No unbounded polling or background schedule.
 * The owning worker supplies its generation/input/cancellation fence. */
export async function readTraexCatalogWithRetry(input: {
  read: () => Promise<TraexModelLoadSnapshot | null>;
  isCurrent: () => boolean;
  wait?: (delayMs: number) => Promise<void>;
  /** The owner already performed (and failed) the first read. */
  firstReadFailed?: boolean;
}): Promise<TraexModelLoadSnapshot | null> {
  const wait = input.wait ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)));
  for (let attempt = 0; attempt < 3; attempt++) {
    if (!input.isCurrent()) return null;
    let snapshot: TraexModelLoadSnapshot | null = null;
    if (!(attempt === 0 && input.firstReadFailed)) {
      try { snapshot = await input.read(); } catch { /* query failure is inconclusive */ }
    }
    if (!input.isCurrent()) return null;
    if (snapshot) return snapshot;
    if (attempt < 2) await wait(30_000);
  }
  return null;
}
