import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The page script lives inside worker.ts's template string; cut out the real
// initial-follow block and run it against a stubbed xterm and DOM.
const workerSource = readFileSync(join(process.cwd(), 'src/worker.ts'), 'utf8');
const start = workerSource.indexOf('var _initialFollow=true');
const end = workerSource.indexOf('// ── OSC 52 clipboard ──', start);
if (start < 0 || end < 0) throw new Error('initial-follow page script not found');
const script = workerSource.slice(start, end);

type Handler = (event: Record<string, unknown>) => void;

function eventTarget() {
  const listeners = new Map<string, Handler[]>();
  return {
    addEventListener(type: string, fn: Handler) {
      listeners.set(type, [...(listeners.get(type) ?? []), fn]);
    },
    fire(type: string, event: Record<string, unknown> = {}) {
      for (const fn of listeners.get(type) ?? []) fn(event);
    },
  };
}

function boot() {
  const root = eventTarget();
  const viewport = eventTarget();
  const win = eventTarget();
  let bottoms = 0;
  const term = {
    element: { querySelector: (sel: string) => (sel === '.xterm-viewport' ? viewport : null) },
    scrollToBottom: () => { bottoms += 1; },
  };
  const settle = new Function(
    'term', 'document', 'window', '_followFixedGridBottom',
    `${script}\nreturn _settleInitialBottom;`,
  )(term, { getElementById: (id: string) => (id === 'terminal' ? root : null) }, win, () => {}) as () => void;
  return { settle, root, viewport, win, bottoms: () => bottoms };
}

describe('web terminal initial viewport follow', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('settles the first asynchronous xterm write burst at the bottom, then stops following', () => {
    const page = boot();
    page.settle();
    expect(page.bottoms()).toBe(1);
    vi.advanceTimersByTime(400);
    page.settle(); // a second write of the same burst re-arms the settle timer
    expect(page.bottoms()).toBe(2);
    vi.advanceTimersByTime(499);
    expect(page.bottoms()).toBe(2);
    vi.advanceTimersByTime(1);
    expect(page.bottoms()).toBe(3);
    // the burst is over: later output no longer drags the viewport down
    page.settle();
    vi.advanceTimersByTime(1000);
    expect(page.bottoms()).toBe(3);
  });

  it.each([
    ['wheel on the terminal', (p: ReturnType<typeof boot>) => p.root.fire('wheel')],
    ['touchstart on the terminal', (p: ReturnType<typeof boot>) => p.root.fire('touchstart')],
    ['a press on the native scrollbar', (p: ReturnType<typeof boot>) => p.viewport.fire('pointerdown', { target: p.viewport })],
    ...['PageUp', 'PageDown', 'Home', 'End'].map(key =>
      [`the ${key} key`, (p: ReturnType<typeof boot>) => p.win.fire('keydown', { key })] as const),
  ])('stops following as soon as the reader deliberately scrolls (%s)', (_label, gesture) => {
    const page = boot();
    page.settle();
    gesture(page);
    vi.advanceTimersByTime(1000);
    page.settle();
    vi.advanceTimersByTime(1000);
    expect(page.bottoms()).toBe(1);
  });

  it('keeps following through presses on terminal cells and ordinary keys', () => {
    const page = boot();
    page.viewport.fire('pointerdown', { target: {} });
    page.win.fire('keydown', { key: 'a' });
    page.settle();
    vi.advanceTimersByTime(500);
    expect(page.bottoms()).toBe(2);
  });
});
