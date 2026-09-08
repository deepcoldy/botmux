import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

const source = readFileSync(join(process.cwd(), 'src/worker.ts'), 'utf8');
const start = source.indexOf('function _scrollFixedGrid(dx,dy){');
const end = source.indexOf('function sendResize(){', start);
if (start < 0 || end < 0) throw new Error('Fixed-grid event handlers not found');
const script = source.slice(start, end);

type Input = 'wheel' | 'touch';
interface Gesture {
  ctrlKey: boolean;
  deltaMode: number;
  deltaX: number;
  deltaY: number;
  touches: { clientX: number; clientY: number }[];
  preventDefault(): void;
  stopImmediatePropagation(): void;
}

function boot(input: Input, left = 100, top = 100, fixedSize = true) {
  const listeners = new Map<string, (event: Gesture) => void>();
  // Model browser scroll clamping: both axes have a 200px scroll range.
  const host = {
    clientHeight: 100,
    get scrollLeft() { return left; },
    set scrollLeft(value: number) { left = Math.max(0, Math.min(200, value)); },
    get scrollTop() { return top; },
    set scrollTop(value: number) { top = Math.max(0, Math.min(200, value)); },
    addEventListener(name: string, handler: (event: Gesture) => void) {
      listeners.set(name, handler);
    },
  };
  const context = { fixedSize, _tLastY: 300, document: { getElementById: () => host } };
  runInNewContext(script, context);
  let touchX = 300;
  let touchY = 300;
  function fire(name: string, dx = 0, dy = 0, ctrlKey = false, deltaMode = 0) {
    let prevented = false;
    let stopped = false;
    const handler = listeners.get(name);
    if (!handler) throw new Error(`Missing ${name} handler`);
    handler({
      ctrlKey, deltaMode, deltaX: dx, deltaY: dy,
      touches: [{ clientX: touchX, clientY: touchY }],
      preventDefault() { prevented = true; },
      stopImmediatePropagation() { stopped = true; },
    });
    return { prevented, stopped };
  }
  if (input === 'touch') fire('touchstart');
  return {
    host, context,
    move(dx: number, dy: number, ctrlKey = false, deltaMode = 0) {
      touchX -= dx;
      touchY -= dy;
      return fire(input === 'touch' ? 'touchmove' : 'wheel', dx, dy, ctrlKey, deltaMode);
    },
  };
}

describe.each<Input>(['wheel', 'touch'])('fixed-grid %s gestures', (input) => {
  it.each([0, 200])('passes vertical intent downstream at boundary %i despite horizontal jitter', (top) => {
    const page = boot(input, 100, top);
    const result = page.move(1, top === 0 ? -100 : 100);
    expect(result).toEqual({ prevented: false, stopped: false });
    expect(page.host.scrollLeft).toBe(100);
    expect(page.host.scrollTop).toBe(top);
  });

  it('scrolls only vertically for predominantly vertical input inside the canvas', () => {
    const page = boot(input);
    expect(page.move(1, 30)).toEqual({ prevented: true, stopped: true });
    expect(page.host.scrollTop).toBe(130);
    expect(page.host.scrollLeft).toBe(100);
  });

  it('scrolls only horizontally for predominantly horizontal input', () => {
    const page = boot(input);
    expect(page.move(30, 1)).toEqual({ prevented: true, stopped: true });
    expect(page.host.scrollLeft).toBe(130);
    expect(page.host.scrollTop).toBe(100);
  });

  it('passes a horizontal edge gesture downstream without consuming vertical jitter', () => {
    const page = boot(input, 200, 100);
    expect(page.move(30, 1)).toEqual({ prevented: false, stopped: false });
    expect(page.host.scrollTop).toBe(100);
  });

  it('reaches the canvas edge before yielding subsequent gestures to terminal history', () => {
    const page = boot(input, 100, 190);
    expect(page.move(1, 30).stopped).toBe(true);
    expect(page.host.scrollTop).toBe(200);
    expect(page.move(1, 30).stopped).toBe(false);
    expect(page.host.scrollLeft).toBe(100);
    if (input === 'touch') expect(page.context._tLastY).toBe(270);
  });

  it('leaves owned viewport gestures to the normal terminal handlers', () => {
    const page = boot(input, 100, 100, false);
    expect(page.move(1, 30)).toEqual({ prevented: false, stopped: false });
    expect(page.host.scrollTop).toBe(100);
    expect(page.host.scrollLeft).toBe(100);
  });
});

it('preserves Ctrl-wheel zoom gestures', () => {
  const page = boot('wheel');
  expect(page.move(1, 30, true)).toEqual({ prevented: false, stopped: false });
  expect(page.host.scrollTop).toBe(100);
});

it.each([1, 2])('passes diagonal wheel input at the bottom in delta mode %i', (mode) => {
  const page = boot('wheel', 100, 200);
  expect(page.move(0.1, 1, false, mode)).toEqual({ prevented: false, stopped: false });
  expect(page.host.scrollLeft).toBe(100);
});
