import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// The whole web terminal ships as ONE TypeScript template literal inside
// getTerminalHtml(). That means every backslash escape in the source gets one
// round of processing on the way out: `\\r` in worker.ts reaches the browser as
// the two characters `\r`, but a bare `\r` reaches it as an actual carriage
// return. Inside a `//` comment a real CR terminates the comment, and whatever
// followed it on that line is suddenly parsed as code — which throws a
// SyntaxError that kills the ENTIRE inline script, not just that line. The
// terminal then never boots: no xterm, no input bar handlers, nothing.
//
// This is invisible to the other web-terminal tests. They all read worker.ts as
// TEXT and either grep it or slice out a fragment and `replaceAll('\\\\','\\')`
// it — an approximation of template-literal processing applied to the source,
// which leaves a lone `\r` as the harmless two-character sequence it is in the
// source. Only the emitted HTML has the real control character, so only a test
// that looks at the emitted HTML can catch this.
//
// Rather than execute the page (it needs a DOM, a WebSocket and a live worker),
// this parses it: a SyntaxError anywhere in the script is exactly the failure
// mode, and `new Function` reports it without running a line.
//
// Known gap, deliberately not closed here: a bare `\n` (or the U+2028 / U+2029
// line separators, named here rather than written literally because they would
// terminate this very comment) in a `//` comment also becomes a real line break
// and truncates the comment. If what follows happens to be valid JS there is no
// SyntaxError, so the parse check passes -- and the CR fingerprint below cannot
// see it either, because real LFs are everywhere in the emitted document. The
// bug this file was written for was a `\r`, which both checks do catch.

const workerSource = readFileSync(join(process.cwd(), 'src/worker.ts'), 'utf8');

/**
 * Recover the served text of the getTerminalHtml template literal by applying
 * the one escape-processing pass the TypeScript compiler applies to it.
 * Deliberately does NOT interpolate `${...}` — those are runtime values, and
 * the parse check below tolerates them by blanking them out.
 */
function servedHtml(): string {
  const start = workerSource.indexOf('function getTerminalHtml(');
  expect(start, 'worker.ts 里找不到 getTerminalHtml').toBeGreaterThan(-1);
  const open = workerSource.indexOf('return `', start);
  expect(open, 'getTerminalHtml 里找不到模板字符串起点').toBeGreaterThan(-1);
  const bodyStart = open + 'return `'.length;

  // Walk to the closing backtick, honouring escapes and nested ${...} spans so
  // a backtick inside an interpolation does not read as the end of the literal.
  let i = bodyStart;
  let depth = 0;
  for (; i < workerSource.length; i++) {
    const ch = workerSource[i];
    if (ch === '\\') { i++; continue; }
    if (ch === '$' && workerSource[i + 1] === '{') { depth++; i++; continue; }
    if (ch === '}' && depth > 0) { depth--; continue; }
    if (ch === '`' && depth === 0) break;
  }
  expect(i, 'getTerminalHtml 的模板字符串没有闭合').toBeLessThan(workerSource.length);
  const raw = workerSource.slice(bodyStart, i);

  // One pass of escape processing, the same one the compiler performs.
  return raw.replace(/\\(u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|[\s\S])/g, (_m, esc: string) => {
    switch (esc[0]) {
      case 'n': return '\n';
      case 'r': return '\r';
      case 't': return '\t';
      case 'b': return '\b';
      case 'f': return '\f';
      case 'v': return '\v';
      case '0': return esc === '0' ? '\0' : esc;
      case 'x': return String.fromCharCode(parseInt(esc.slice(1), 16));
      case 'u': return esc[1] === '{'
        ? String.fromCodePoint(parseInt(esc.slice(2, -1), 16))
        : String.fromCharCode(parseInt(esc.slice(1), 16));
      default: return esc;
    }
  });
}

function inlineScripts(html: string): string[] {
  const out: string[] = [];
  const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    if (m[1].trim()) out.push(m[1]);
  }
  return out;
}

describe('getTerminalHtml 发出的内联脚本必须是合法 JS', () => {
  it('模板字符串里的转义不会在注释中变成真实控制字符', () => {
    const html = servedHtml();
    const scripts = inlineScripts(html);
    // If this drops to zero the test would pass vacuously — the exact failure
    // shape this file exists to prevent.
    expect(scripts.length, '没有解出任何内联脚本，说明提取逻辑坏了').toBeGreaterThan(0);

    for (const script of scripts) {
      // `${...}` spans are runtime interpolations; blank them to a literal so
      // the remainder parses as the shape it will have in the browser.
      const parseable = script.replace(/\$\{[\s\S]*?\}/g, '0');
      expect(() => new Function(parseable)).not.toThrow();
    }
  });

  it('任何 // 注释里都不含真实换行/回车（会截断注释并让整段脚本 SyntaxError）', () => {
    const html = servedHtml();
    const scripts = inlineScripts(html);
    // Same vacuous-pass guard as above: with zero scripts the loop below runs
    // zero assertions and this test goes green on a broken extractor.
    expect(scripts.length, '没有解出任何内联脚本，说明提取逻辑坏了').toBeGreaterThan(0);
    for (const script of scripts) {
      // A CR that is not part of a CRLF pair, anywhere in the emitted script,
      // is the fingerprint: worker.ts writes the whole document with \n.
      const strayCr = /\r(?!\n)/.exec(script);
      expect(
        strayCr,
        strayCr
          ? `发出的脚本里出现真实回车（源码里应写 \\\\r 而不是 \\r）：`
            + JSON.stringify(script.slice(Math.max(0, strayCr.index - 90), strayCr.index + 30))
          : '',
      ).toBeNull();
    }
  });
});
