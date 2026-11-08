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

/** Blank out `//` line comments and `/* *\/` block comments without touching
 *  string/template bodies, so an argument guard can neither be satisfied by a
 *  comment that merely names the argument nor broken by a URL literal. */
function stripComments(source: string): string {
  const QUOTES = new Set(["'", '"', '`']);
  let out = '';
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];
    if (ch === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    if (QUOTES.has(ch)) {
      const quote = ch;
      out += ch;
      i++;
      while (i < source.length) {
        out += source[i];
        if (source[i] === '\\') { out += source[i + 1] ?? ''; i += 2; continue; }
        if (source[i] === quote) { i++; break; }
        i++;
      }
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

// 源码结构护栏(K4)：每个 buildStreamingCard 调用点都必须传入按机器人解析的隐藏按钮策略，
// 否则重渲染会把机器人隐藏的按钮重新露出来。调用点在闭包里，只能逐个核对。
describe('streaming-card button policy wiring', () => {
  for (const rel of [
    'src/core/worker-pool.ts',
    'src/im/lark/card-handler.ts',
    'src/daemon.ts',
  ]) {
    it(`every buildStreamingCard() call in ${rel} forwards the per-bot policy`, () => {
      const source = readFileSync(resolve(rel), 'utf8');
      const sites = buildStreamingCardCallSites(stripComments(source));
      expect(sites.length).toBeGreaterThan(0);
      const missing = sites.filter(s => !s.includes('resolveHiddenStreamingCardButtons(getBot(ds.larkAppId).config)'));
      expect(missing).toEqual([]);
      // The per-chat substitute control must travel with every re-render too;
      // otherwise a later screen update silently drops the toggle button.
      const missingSubstitute = sites.filter(s => !s.includes('substituteCardControlFor(ds)'));
      expect(missingSubstitute).toEqual([]);
      // The terminal-key panel state travels the same way: a freeze / adopt-exit /
      // crash render that omits it repaints an open grid as collapsed, which makes
      // the first click look dead and a double tap close it. Comments were stripped
      // above — several call sites mention keysPanelOpen in prose, and a comment
      // must never satisfy an argument check. The expression is matched, not just
      // the identifier: `false` or a look-alike name must not pass.
      const missingKeysPanel = sites.filter(s => !/ds\.keysPanelOpen\s*===\s*true/.test(s));
      expect(missingKeysPanel).toEqual([]);
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

// 源码结构护栏(K4)：session-manager 的四条恢复路径（重启恢复 ×2、durable 接管、
// 显式 resume）各自手写 DaemonSession 字面量，把持久化的 streamKeysPanelOpen 重建到
// 运行态 keysPanelOpen。字面量埋在 restore 闭包里，没有可单独调用的 seam；漏一条的症状
// 是「重启 / 接管后已展开的按键区悄悄收起」，属 K3 级回归绊线，因此按调用点逐个核对。
describe('streaming-card keys-panel restore wiring', () => {
  it('every restore path copies the persisted streamKeysPanelOpen onto the runtime session', () => {
    const source = stripComments(readFileSync(resolve('src/core/session-manager.ts'), 'utf8'));
    // Each restore literal is anchored on its own `streamCardId: <x>.streamCardId`;
    // forward brace matching then recovers the whole object literal.
    const anchors: number[] = [];
    const re = /streamCardId:\s*\w+\.streamCardId/g;
    let match: RegExpExecArray | null;
    while ((match = re.exec(source))) anchors.push(match.index);
    expect(anchors.length).toBeGreaterThanOrEqual(4);
    const offenders: string[] = [];
    for (const at of anchors) {
      const start = source.lastIndexOf('= {', at);
      if (start < 0) { offenders.push(`anchor@${at}: no enclosing literal`); continue; }
      let depth = 0;
      let end = start;
      for (let i = start + 2; i < source.length; i++) {
        if (source[i] === '{') depth++;
        else if (source[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
      }
      const literal = source.slice(start, end + 1);
      const line = source.slice(0, at).split('\n').length;
      // Match the rebuilt expression, not just the key: `keysPanelOpen: false`
      // or a look-alike source would keep the key present while losing the state.
      if (!/keysPanelOpen:\s*\w+\.streamKeysPanelOpen\s*===\s*true/.test(literal)) {
        const why = /streamKeysPanelOpen/.test(literal)
          ? 'does not rebuild keysPanelOpen from streamKeysPanelOpen === true'
          : 'no keysPanelOpen at all';
        offenders.push(`session-manager.ts:${line} ${why}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
