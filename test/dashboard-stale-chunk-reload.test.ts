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
