import { describe, expect, it } from 'vitest';
import {
  addMonitorRoomSessionIds,
  clearMonitorRoomSessionIds,
  MONITOR_ROOM_STORAGE_KEY,
  readMonitorRoomSessionIds,
  removeMonitorRoomSessionId,
  type StorageLike,
} from '../src/dashboard/web/monitor-room-store.js';
import { monitorRoomFrameGeometry } from '../src/dashboard/web/monitor-room.js';
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
