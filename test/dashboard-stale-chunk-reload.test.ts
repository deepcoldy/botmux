import { describe, expect, it, vi } from 'vitest';
import {
  isLikelyStaleRouteChunkError,
  maybeReloadBrowserForStaleRouteChunk,
  maybeReloadForStaleRouteChunk,
} from '../src/dashboard/web/stale-chunk-reload.js';

function memorySessionStorage(): Pick<Storage, 'getItem' | 'setItem'> {
  const values = new Map<string, string>();
  return {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
  };
}

describe('dashboard stale chunk reload', () => {
  it('reloads once when an upgraded dashboard removed a lazy route chunk', () => {
    const sessionStorage = memorySessionStorage();
    const reload = vi.fn();
    const err = new TypeError(
      'Failed to fetch dynamically imported module: http://127.0.0.1:7891/assets/chunks/sessions-page-old.js',
    );
    const env = {
      href: 'http://127.0.0.1:7891/#/sessions',
      hash: '#/sessions',
      sessionStorage,
      reload,
    };

    expect(isLikelyStaleRouteChunkError(err)).toBe(true);
    expect(maybeReloadForStaleRouteChunk(err, env)).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(maybeReloadForStaleRouteChunk(err, env)).toBe(false);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('does not reload for ordinary route errors', () => {
    const reload = vi.fn();

    expect(maybeReloadForStaleRouteChunk(new Error('render failed'), {
      href: 'http://127.0.0.1:7891/#/groups',
      hash: '#/groups',
      sessionStorage: memorySessionStorage(),
      reload,
    })).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });

  it.each([
    "The requested module './chunk-KXPFRRWM.js' does not provide an export named 'e'",
    "The requested module '/assets/chunks/chunk-KXPFRRWM.js' doesn't provide an export named: 'e'",
    "The requested module 'https://example.test/assets/chunks/page-ABCDEFGH.js' does not provide an export named 'render'",
  ])('reloads once for a chunk linking error: %s', (message) => {
    const reload = vi.fn();
    const env = {
      href: 'http://127.0.0.1:7891/',
      hash: '#/monitor-room',
      sessionStorage: memorySessionStorage(),
      reload,
    };
    const err = new SyntaxError(message);

    expect(maybeReloadBrowserForStaleRouteChunk(err, {
      ...env,
      getSessionStorage: () => env.sessionStorage,
    })).toBe(true);
    // The same broken shared chunk can affect several routes. Changing the
    // route must not reset the reload guard.
    expect(maybeReloadForStaleRouteChunk(err, { ...env, hash: '#/sessions' })).toBe(false);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it.each([
    new SyntaxError("The requested module './validator.js' does not provide an export named 'e'"),
    new SyntaxError('Unexpected token'),
    new Error("render failed: missing export named 'e'"),
  ])('does not treat an unrelated module or render bug as a stale chunk: %s', (err) => {
    const reload = vi.fn();
    expect(maybeReloadForStaleRouteChunk(err, {
      href: 'http://127.0.0.1:7891/',
      hash: '#/groups',
      sessionStorage: memorySessionStorage(),
      reload,
    })).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });

  it('does not reload when the guard cannot be persisted', () => {
    const reload = vi.fn();
    const sessionStorage: Pick<Storage, 'getItem' | 'setItem'> = {
      getItem: () => { throw new Error('blocked'); },
      setItem: () => { throw new Error('blocked'); },
    };

    expect(maybeReloadForStaleRouteChunk(
      new TypeError('error loading dynamically imported module'),
      {
        href: 'http://127.0.0.1:7891/#/roles',
        hash: '#/roles',
        sessionStorage,
        reload,
      },
    )).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });

  it('keeps the original route error when browser storage cannot be read', () => {
    const reload = vi.fn();

    expect(maybeReloadBrowserForStaleRouteChunk(
      new TypeError('Failed to fetch dynamically imported module: /assets/chunks/groups-page-old.js'),
      {
        href: 'http://127.0.0.1:7891/#/groups',
        hash: '#/groups',
        getSessionStorage: () => { throw new DOMException('blocked', 'SecurityError'); },
        reload,
      },
    )).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });

  it('does not read browser storage for ordinary route errors', () => {
    const getSessionStorage = vi.fn(() => memorySessionStorage());

    expect(maybeReloadBrowserForStaleRouteChunk(new Error('render failed'), {
      href: 'http://127.0.0.1:7891/#/roles',
      hash: '#/roles',
      getSessionStorage,
      reload: vi.fn(),
    })).toBe(false);
    expect(getSessionStorage).not.toHaveBeenCalled();
  });
});
