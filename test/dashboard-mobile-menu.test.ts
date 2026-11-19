import { afterEach, describe, expect, it, vi } from 'vitest';
import { initThemeMenu } from '../src/dashboard/web/theme-menu.js';

type Handler = (event: Record<string, unknown>) => void;

function fakeElement() {
  const handlers: Record<string, Handler[]> = {};
  const attrs = new Map<string, string>();
  return {
    dataset: {} as Record<string, string>,
    hidden: true,
    innerHTML: '',
    offsetWidth: 216,
    style: { setProperty: () => {} },
    classList: { add: () => {}, remove: () => {}, toggle: () => {} },
    addEventListener(type: string, fn: Handler) { (handlers[type] ??= []).push(fn); },
    setAttribute(key: string, value: string) { attrs.set(key, value); },
    getAttribute(key: string) { return attrs.get(key) ?? null; },
    getBoundingClientRect: () => ({ left: 0, width: 40, bottom: 40 }),
    matches: () => false,
    contains: () => false,
    querySelectorAll: () => [],
    fire(type: string, event: Record<string, unknown> = {}) {
      for (const fn of handlers[type] ?? []) fn({ stopPropagation() {}, ...event });
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('dashboard mobile topbar menus', () => {
  it('lets a touch tap toggle the theme menu without hover open/close interfering', () => {
    vi.useFakeTimers();
    const root = fakeElement();
    const btn = fakeElement();
    const pop = fakeElement();
    const doc = fakeElement();
    const byId: Record<string, unknown> = { 'theme-menu': root, 'theme-menu-btn': btn, 'theme-menu-pop': pop };
    vi.stubGlobal('Node', class {});
    vi.stubGlobal('document', Object.assign(doc, { body: fakeElement(), getElementById: (id: string) => byId[id] ?? null }));
    vi.stubGlobal('window', {
      setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
      clearTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
      requestAnimationFrame: () => 0,
      addEventListener: () => {},
      innerWidth: 1024,
      innerHeight: 768,
    });
    initThemeMenu();
    const expanded = () => btn.getAttribute('aria-expanded');

    // A tap fires pointerenter(touch) right before click: hover must not pre-open
    // the menu, otherwise the click immediately toggles it closed again.
    root.fire('pointerenter', { pointerType: 'touch' });
    expect(expanded()).toBeNull();
    btn.fire('click');
    expect(expanded()).toBe('true');

    // Touch pointerleave / document pointermove must not schedule a close either.
    root.fire('pointerleave', { pointerType: 'touch' });
    doc.fire('pointermove', { pointerType: 'touch', target: {} });
    vi.advanceTimersByTime(500);
    expect(expanded()).toBe('true');
    btn.fire('click');
    expect(expanded()).toBe('false');

    // Mouse hover keeps its open-on-enter / close-on-leave behaviour.
    root.fire('pointerenter', { pointerType: 'mouse' });
    expect(expanded()).toBe('true');
    root.fire('pointerleave', { pointerType: 'mouse' });
    vi.advanceTimersByTime(500);
    expect(expanded()).toBe('false');
  });
});
