/**
 * The dashboard draws its own overlay scrollbars on a body-level layer
 * (.floating-scrollbar-layer, z-index 1500). A body-level overlay that makes the
 * page behind it `inert` — the Bot config example drawer — must not have that
 * page's bars painted over it.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';

const source = readFileSync(join(process.cwd(), 'src/dashboard/web/floating-scrollbars.ts'), 'utf8');
const css = readFileSync(join(process.cwd(), 'src/dashboard/web/style.css'), 'utf8');

function extractIsVisible(): (target: unknown) => boolean {
  const start = source.indexOf('function isVisible(');
  const end = source.indexOf('\n}', start);
  if (start < 0 || end < 0) throw new Error('isVisible not found');
  const js = ts.transpileModule(source.slice(start, end + 2), {
    compilerOptions: { module: ts.ModuleKind.None, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return new Function('window', `${js}\nreturn isVisible;`)({ innerWidth: 1280, innerHeight: 800 });
}

/** A scroller whose ancestors carry the given attributes. */
function scroller(ancestorAttrs: string[]) {
  return {
    isConnected: true,
    closest: (selector: string) => {
      const wanted = selector.split(',').map(s => s.trim().replace(/^\[|\]$/g, ''));
      return wanted.some(attr => ancestorAttrs.includes(attr)) ? {} : null;
    },
    getBoundingClientRect: () => ({ width: 600, height: 400, top: 10, left: 10, right: 610, bottom: 410 }),
  };
}

describe('floating scrollbars behind an inert overlay', () => {
  const isVisible = extractIsVisible();

  it('tracks an ordinary on-screen scroller', () => {
    expect(isVisible(scroller([]))).toBe(true);
  });

  it('drops scrollers inside an inert or hidden subtree', () => {
    expect(isVisible(scroller(['inert']))).toBe(false);
    expect(isVisible(scroller(['hidden']))).toBe(false);
  });

  afterEach(() => vi.unstubAllGlobals());

  it('rescans when an overlay toggles inert on the page', async () => {
    let observed: { callback: (records: unknown[]) => void; options: MutationObserverInit } | undefined;
    vi.stubGlobal('MutationObserver', class {
      constructor(private readonly callback: (records: unknown[]) => void) {}
      observe(_target: unknown, options: MutationObserverInit) { observed = { callback: this.callback, options }; }
    });
    vi.stubGlobal('Element', class {});
    vi.stubGlobal('document', { documentElement: { classList: { add: () => undefined } }, addEventListener: () => undefined });
    const setTimeout = vi.fn(() => 1);
    vi.stubGlobal('window', { addEventListener: () => undefined, requestAnimationFrame: () => 1, setTimeout });
    const { initFloatingScrollbars } = await import('../src/dashboard/web/floating-scrollbars.js');
    initFloatingScrollbars({} as HTMLElement);

    // Browser semantics: attribute mutations are delivered only for names in attributeFilter.
    const toggleAttribute = (attributeName: string) => {
      if (observed?.options.attributeFilter?.includes(attributeName)) {
        observed.callback([{ type: 'attributes', attributeName, target: {} }]);
      }
    };
    toggleAttribute('inert');
    expect(setTimeout).toHaveBeenCalledTimes(1);
  });
});

describe('Bot config example drawer stacking', () => {
  function zIndexOf(selector: RegExp): number {
    const match = selector.exec(css);
    if (!match) throw new Error(`rule not found: ${selector}`);
    const z = /z-index:\s*(\d+)/.exec(match[0]);
    if (!z) throw new Error(`no z-index in ${match[0]}`);
    return Number(z[1]);
  }

  // 源码结构护栏(K4)：示例侧栏与悬浮滚动条层是两条各自独立声明的 body 级规则，
  // 叠放次序只能从 style.css 里两个 z-index 的相对大小看出，无法 import 比较；
  // 只断言相对次序、不钉具体数值。对应 #1949（侧栏被背景页的悬浮滚动条盖住）。
  it('paints above the body-level floating scrollbar layer', () => {
    const layer = zIndexOf(/\.floating-scrollbar-layer\s*\{[^}]*\}/);
    const drawer = zIndexOf(/\.bot-defaults-page\.bd-example-layer\s*\{[^}]*\}/);
    expect(drawer).toBeGreaterThan(layer);
  });
});
