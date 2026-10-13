/**
 * A process that never called init(appId) — the workflow worker, which skips
 * store init because its session id is synthetic — must be able to read
 * without throwing. authorizeManagedSend calls getSessionFresh with no
 * try/catch on the sandbox relay path.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

let tempDir = '';

vi.mock('../src/config.js', () => ({
  config: { session: { get dataDir() { return tempDir; } } },
}));
vi.mock('../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));
vi.mock('../src/services/frozen-card-store.js', () => ({ deleteFrozenCards: vi.fn() }));
vi.mock('../src/core/cost-calculator.js', () => ({ getSessionTokenUsage: vi.fn(() => null) }));

import {
  getSession,
  getSessionFresh,
  init,
  listSessions,
  listSessionsStrict,
} from '../src/services/session-store.js';

afterEach(() => {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = '';
});

describe('session store before init(appId)', () => {
  it('rejects an empty appId and still reads as an empty store', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'session-store-uninit-'));
    expect(() => init('')).toThrow(/non-empty appId/);
    expect(() => getSessionFresh('wf-synthetic')).not.toThrow();
    expect(getSessionFresh('wf-synthetic')).toBeUndefined();
    expect(getSession('wf-synthetic')).toBeUndefined();
    expect(listSessions()).toEqual([]);
    expect(listSessionsStrict()).toEqual([]);
  });
});
