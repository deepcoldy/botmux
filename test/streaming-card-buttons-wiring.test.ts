import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function buildStreamingCardCallSites(source: string): string[] {
  const sites: string[] = [];
  const marker = 'buildStreamingCard(';
  let idx = source.indexOf(marker);
  while (idx !== -1) {
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

describe('streaming-card button policy wiring', () => {
  for (const rel of [
    'src/core/worker-pool.ts',
    'src/im/lark/card-handler.ts',
    'src/daemon.ts',
  ]) {
    it(`every buildStreamingCard() call in ${rel} forwards the per-bot policy`, () => {
      const source = readFileSync(resolve(rel), 'utf8');
      const sites = buildStreamingCardCallSites(source);
      expect(sites.length).toBeGreaterThan(0);
      const missing = sites.filter(s => !s.includes('resolveHiddenStreamingCardButtons(getBot(ds.larkAppId).config)'));
      expect(missing).toEqual([]);
    });
  }
});
