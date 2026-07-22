import type { PtyHandle } from './types.js';

const cachedHandles = new WeakMap<object, PtyHandle>();

/**
 * Turn boolean write rejection into an exception at the submit boundary.
 *
 * Several established CLI adapters intentionally ignore the optional boolean
 * returned by sendText/sendSpecialKeys because PTY/tmux historically either
 * wrote or threw. Snapshot transports can return false for an ambiguous,
 * non-retriable send. Wrapping only adapter submission keeps those failures on
 * worker's existing notification path without making best-effort navigation
 * and startup-control keystrokes throw from unrelated event callbacks.
 */
export function strictInputHandle<T extends PtyHandle>(pty: T): T {
  const cached = cachedHandles.get(pty as object);
  if (cached) return cached as T;

  const proxy = new Proxy(pty as T & object, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (property === 'sendText' || property === 'sendSpecialKeys') {
        if (typeof value !== 'function') return value;
        return (...args: unknown[]) => {
          const result = Reflect.apply(value, target, args);
          if (result === false) {
            throw new Error(`backend rejected ${String(property)} during prompt submission`);
          }
          return result;
        };
      }
      return typeof value === 'function' ? value.bind(target) : value;
    },
    set(target, property, value) {
      return Reflect.set(target, property, value, target);
    },
  }) as T;

  cachedHandles.set(pty as object, proxy);
  return proxy;
}
