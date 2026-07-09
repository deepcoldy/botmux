import { describe, expect, it } from 'vitest';
import {
  addMonitorRoomSessionIds,
  clearMonitorRoomSessionIds,
  MONITOR_ROOM_AUTO_ACTIVE_STORAGE_KEY,
  MONITOR_ROOM_STORAGE_KEY,
  readMonitorRoomAutoActive,
  readMonitorRoomSessionIds,
  removeMonitorRoomSessionId,
  type StorageLike,
  writeMonitorRoomAutoActive,
} from '../src/dashboard/web/monitor-room-store.js';
import { monitorRoomFrameGeometry, monitorRoomGridGeometry, monitorRoomPanelBodyKey } from '../src/dashboard/web/monitor-room.js';
import { sessionTerminalHref, type SessionTerminalLocation } from '../src/dashboard/web/session-terminal.js';

function makeStorage(): StorageLike & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: key => data.get(key) ?? null,
    setItem: (key, value) => { data.set(key, value); },
    removeItem: key => { data.delete(key); },
  };
}

describe('monitor room local session set', () => {
  it('stores unique non-empty session ids in insertion order', () => {
    const storage = makeStorage();

    const first = addMonitorRoomSessionIds(['s1', 's2', 's1', '', '  '], storage);
    expect(first).toEqual({ ids: ['s1', 's2'], added: 2, total: 2 });

    const second = addMonitorRoomSessionIds(['s2', 's3'], storage);
    expect(second).toEqual({ ids: ['s1', 's2', 's3'], added: 1, total: 3 });
    expect(readMonitorRoomSessionIds(storage)).toEqual(['s1', 's2', 's3']);
  });

  it('removes and clears the persisted session list', () => {
    const storage = makeStorage();
    addMonitorRoomSessionIds(['s1', 's2'], storage);

    expect(removeMonitorRoomSessionId('s1', storage)).toEqual(['s2']);
    clearMonitorRoomSessionIds(storage);

    expect(readMonitorRoomSessionIds(storage)).toEqual([]);
    expect(storage.data.has(MONITOR_ROOM_STORAGE_KEY)).toBe(false);
  });

  it('keeps the auto-active fallback off by default and persists it separately', () => {
    const storage = makeStorage();

    expect(readMonitorRoomAutoActive(storage)).toBe(false);

    writeMonitorRoomAutoActive(true, storage);
    expect(readMonitorRoomAutoActive(storage)).toBe(true);
    expect(storage.data.get(MONITOR_ROOM_AUTO_ACTIVE_STORAGE_KEY)).toBe('1');
    expect(readMonitorRoomSessionIds(storage)).toEqual([]);

    writeMonitorRoomAutoActive(false, storage);
    expect(readMonitorRoomAutoActive(storage)).toBe(false);
    expect(storage.data.has(MONITOR_ROOM_AUTO_ACTIVE_STORAGE_KEY)).toBe(false);
  });
});

describe('session terminal href', () => {
  const local: SessionTerminalLocation = { protocol: 'http:', origin: 'http://localhost:8801', hostname: 'localhost' };
  const platform: SessionTerminalLocation = { protocol: 'https:', origin: 'https://m-1.example.test', hostname: 'm-1.example.test' };

  it('builds local direct and proxy terminal urls', () => {
    expect(sessionTerminalHref({ sessionId: 'abc', webPort: 3001 }, local)).toBe('http://localhost:3001');
    expect(sessionTerminalHref({ sessionId: 'abc', webPort: 3001, proxyPort: 8801 }, local)).toBe('http://localhost:8801/s/abc');
  });

  it('uses same-origin proxy urls on https platform pages', () => {
    expect(sessionTerminalHref({ sessionId: 'a b', webPort: 3001, proxyPort: 8801 }, platform)).toBe('https://m-1.example.test/s/a%20b');
    expect(sessionTerminalHref({ sessionId: 'abc', webPort: 3001 }, platform)).toBeNull();
  });
});

describe('monitor room frame geometry', () => {
  it('renders the terminal at the full viewport and scales it down into the card', () => {
    expect(monitorRoomFrameGeometry(
      { width: 2000, height: 1300 },
      { width: 600, height: 390 },
    )).toEqual({ width: 2000, height: 1300, scale: 0.3 });
  });

  it('does not upscale when a card is larger than the terminal viewport', () => {
    expect(monitorRoomFrameGeometry(
      { width: 1000, height: 700 },
      { width: 1200, height: 900 },
    )).toEqual({ width: 1000, height: 700, scale: 1 });
  });
});

describe('monitor room grid geometry', () => {
  it('keeps card frames at the current viewport ratio without using a fixed terminal size', () => {
    const layout = monitorRoomGridGeometry(
      { width: 1200, height: 1800 },
      { width: 900, top: 260 },
      6,
    );

    expect(layout.columns).toBeGreaterThan(1);
    expect(layout.frameWidth / layout.frameHeight).toBeCloseTo(1200 / 1800, 2);
  });

  it('recomputes wider landscape cards from the same session count', () => {
    const portrait = monitorRoomGridGeometry(
      { width: 1200, height: 1800 },
      { width: 900, top: 260 },
      6,
    );
    const landscape = monitorRoomGridGeometry(
      { width: 1800, height: 1200 },
      { width: 1500, top: 260 },
      6,
    );

    expect(landscape.frameWidth / landscape.frameHeight).toBeCloseTo(1800 / 1200, 2);
    expect(landscape.frameWidth).toBeGreaterThan(portrait.frameWidth);
  });
});

describe('monitor room panel body key', () => {
  const local: SessionTerminalLocation = { protocol: 'http:', origin: 'http://localhost:8801', hostname: 'localhost' };

  it('returns "missing" for null or undefined session', () => {
    expect(monitorRoomPanelBodyKey(null)).toBe('missing');
    expect(monitorRoomPanelBodyKey(undefined)).toBe('missing');
  });

  it('embeds the terminal URL so iframe rebuilds when URL changes', () => {
    const direct = monitorRoomPanelBodyKey({ sessionId: 'a', webPort: 3001 }, local);
    const proxied = monitorRoomPanelBodyKey({ sessionId: 'a', webPort: 3001, proxyPort: 8801 }, local);
    expect(direct).toBe('frame:http://localhost:3001');
    expect(proxied).toBe('frame:http://localhost:8801/s/a');
    expect(direct).not.toBe(proxied);
  });

  it('status-only change does not change bodyKey — iframe survives SSE updates', () => {
    const running = monitorRoomPanelBodyKey({ sessionId: 'a', webPort: 3001, status: 'running', lastMessageAt: 1 }, local);
    const idle = monitorRoomPanelBodyKey({ sessionId: 'a', webPort: 3001, status: 'idle', lastMessageAt: 2 }, local);
    expect(running).toBe(idle);
  });

  it('does not include removable — removable is a header-only concern', () => {
    const key = monitorRoomPanelBodyKey({ sessionId: 'x', webPort: 1 }, local);
    expect(key).not.toContain('removable');
  });

  it('falls back to the live window.location when no loc is passed (production render path)', () => {
    // render() calls monitorRoomPanelBodyKey(session) with NO loc. It must still
    // reflect the real terminal URL so the iframe rebuilds when the URL changes
    // (e.g. proxyPort comes up). A previous `loc ?? null` coercion pinned the key
    // to a constant `frame:none`, defeating URL-change detection in the browser.
    const prev = (globalThis as any).window;
    (globalThis as any).window = { location: local };
    try {
      const before = monitorRoomPanelBodyKey({ sessionId: 'a', webPort: 3001 });
      const after = monitorRoomPanelBodyKey({ sessionId: 'a', webPort: 3001, proxyPort: 8801 });
      expect(before).toBe('frame:http://localhost:3001');
      expect(after).toBe('frame:http://localhost:8801/s/a');
      expect(before).not.toBe(after);
    } finally {
      if (prev === undefined) delete (globalThis as any).window;
      else (globalThis as any).window = prev;
    }
  });
});
