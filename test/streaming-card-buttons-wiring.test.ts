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

// 源码结构护栏(K4)：同上，每个 buildStreamingCard 调用点都必须传入按机器人解析的隐藏按钮策略，
// 否则重渲染会把机器人隐藏的按钮重新露出来。调用点在闭包里，只能逐个核对。
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
      // The per-chat substitute control must travel with every re-render too;
      // otherwise a later screen update silently drops the toggle button.
      const missingSubstitute = sites.filter(s => !s.includes('substituteCardControlFor(ds)'));
      expect(missingSubstitute).toEqual([]);
    });
  }

  it('the /card summon path (postFreshStreamingCard) forwards the substitute control', () => {
    const workerPool = readFileSync(resolve('src/core/worker-pool.ts'), 'utf8');
    const start = workerPool.indexOf('export async function postFreshStreamingCard');
    expect(start).toBeGreaterThan(-1);
    const next = workerPool.indexOf('\nexport ', start + 1);
    const fn = workerPool.slice(start, next === -1 ? undefined : next);
    expect(fn).toContain('substituteCardControlFor(ds)');

    const commandHandler = readFileSync(resolve('src/core/command-handler.ts'), 'utf8');
    expect(commandHandler).toContain('postFreshStreamingCard(ds, deps.sessionReply)');
  });
});
