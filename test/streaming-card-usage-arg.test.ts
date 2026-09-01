import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'bun:test';

/**
 * Source-lock: every `buildStreamingCard(` call site that renders a live/frozen
 * streaming card must forward a usage snapshot (the 17th positional arg,
 * `getDaemonStreamingCardUsageSnapshot(...)`). Otherwise a re-render on any
 * auxiliary path (screenshot refresh, usage-limit patch, local-CLI readiness,
 * ready/reuse, claude_exit freeze, card-handler button re-renders) silently
 * wipes the usage line shown at the idle PATCH.
 *
 * This caught a real regression (codex review of PR #637): worker-pool had 9 of
 * 11 call sites and card-handler 0 of 6 missing the arg. A source invariant is
 * the right guard because the failure is "a NEW call site forgot the arg", which
 * a behavioral test on one path can't catch.
 */
function buildStreamingCardCallSites(source: string): string[] {
  const sites: string[] = [];
  const marker = 'buildStreamingCard(';
  let idx = source.indexOf(marker);
  while (idx !== -1) {
    // Walk to the matching close paren by depth from the '(' of the call.
    let depth = 0;
    let started = false;
    let end = idx + marker.length - 1;
    for (let i = idx + marker.length - 1; i < source.length; i++) {
      const ch = source[i];
      if (ch === '(') { depth++; started = true; }
      else if (ch === ')') { depth--; }
      if (started && depth === 0) { end = i; break; }
    }
    sites.push(source.slice(idx, end + 1));
    idx = source.indexOf(marker, end + 1);
  }
  return sites;
}

describe('streaming-card usage arg (source lock — PR #637 regression guard)', () => {
  for (const rel of [
    'src/core/worker-pool.ts',
    'src/im/lark/card-handler.ts',
    'src/daemon.ts',
  ]) {
    it(`every buildStreamingCard() call in ${rel} forwards a usage snapshot`, () => {
      const source = readFileSync(resolve(rel), 'utf8');
      const sites = buildStreamingCardCallSites(source);
      // Sanity: the finder actually located call sites.
      expect(sites.length).toBeGreaterThan(0);
      const missing = sites.filter(s => !s.includes('getDaemonStreamingCardUsageSnapshot'));
      expect(
        missing,
        `${missing.length} buildStreamingCard() call site(s) in ${rel} omit the usage `
        + `snapshot (17th arg). A re-render without it wipes the usage line. `
        + `First offender:\n${missing[0]?.slice(0, 200)}`,
      ).toEqual([]);
    });
  }
});
