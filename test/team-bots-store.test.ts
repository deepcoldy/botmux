/**
 * Team-bot identity store: union_id-keyed trust set learned from team groups.
 * Run: pnpm vitest run test/team-bots-store.test.ts
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach } from 'vitest';
import {
  recordTeamBot, isTeamBot, listTeamBots, removeTeamBot, DEFAULT_EXPIRY_MS,
} from '../src/services/team-bots-store.js';

let dataDir: string;
beforeEach(() => { dataDir = mkdtempSync(join(tmpdir(), 'botmux-teambots-')); });

describe('team-bots-store', () => {
  it('records a teammate by union_id and recognises it', () => {
    expect(isTeamBot(dataDir, 'on_b')).toBe(false);
    expect(recordTeamBot(dataDir, { unionId: 'on_b', name: 'Codex' })).toBe(true);
    expect(isTeamBot(dataDir, 'on_b')).toBe(true);
    expect(listTeamBots(dataDir)).toMatchObject([{ unionId: 'on_b', name: 'Codex' }]);
  });

  it('ignores empty/undefined union_id (no keyless entry) — falls back to /grant', () => {
    expect(recordTeamBot(dataDir, { unionId: undefined, name: 'x' })).toBe(false);
    expect(recordTeamBot(dataDir, { unionId: '   ', name: 'x' })).toBe(false);
    expect(listTeamBots(dataDir)).toEqual([]);
    expect(isTeamBot(dataDir, undefined)).toBe(false);
    expect(isTeamBot(dataDir, '')).toBe(false);
  });

  it('upsert keeps firstSeenAt, bumps lastSeenAt, refreshes name', () => {
    recordTeamBot(dataDir, { unionId: 'on_b', name: 'Codex' }, 1_000);
    recordTeamBot(dataDir, { unionId: 'on_b', name: 'Codex v2' }, 5_000);
    const [e] = listTeamBots(dataDir, DEFAULT_EXPIRY_MS, 5_000);
    expect(e).toMatchObject({ unionId: 'on_b', name: 'Codex v2', firstSeenAt: 1_000, lastSeenAt: 5_000 });
  });

  it('keeps the prior name when a later sighting carries no name', () => {
    recordTeamBot(dataDir, { unionId: 'on_b', name: 'Codex' }, 1_000);
    recordTeamBot(dataDir, { unionId: 'on_b' }, 2_000); // union_id only (typical event)
    expect(listTeamBots(dataDir, DEFAULT_EXPIRY_MS, 2_000)[0]).toMatchObject({ name: 'Codex', lastSeenAt: 2_000 });
  });

  it('expires entries not seen within maxAge (self-healing revocation)', () => {
    const t0 = 1_000_000;
    recordTeamBot(dataDir, { unionId: 'on_b', name: 'Codex' }, t0);
    const later = t0 + DEFAULT_EXPIRY_MS + 1;
    expect(isTeamBot(dataDir, 'on_b', DEFAULT_EXPIRY_MS, later)).toBe(false);
    expect(listTeamBots(dataDir, DEFAULT_EXPIRY_MS, later)).toEqual([]);
    // still trusted just within the window
    expect(isTeamBot(dataDir, 'on_b', DEFAULT_EXPIRY_MS, t0 + DEFAULT_EXPIRY_MS)).toBe(true);
  });

  it('removeTeamBot forgets a teammate (explicit revoke)', () => {
    recordTeamBot(dataDir, { unionId: 'on_b' });
    expect(removeTeamBot(dataDir, 'on_b')).toBe(true);
    expect(isTeamBot(dataDir, 'on_b')).toBe(false);
    expect(removeTeamBot(dataDir, 'on_b')).toBe(false);
    expect(removeTeamBot(dataDir, undefined)).toBe(false);
  });
});
