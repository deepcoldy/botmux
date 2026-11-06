/**
 * Team invite store: single-use, short-TTL admission codes.
 * Run: pnpm vitest run test/invite-store.test.ts
 */
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { logger } from '../src/utils/logger.js';
import { createInvite, consumeInvite, deleteInvitesForTeam } from '../src/services/invite-store.js';

let dataDir: string;
beforeEach(() => { dataDir = mkdtempSync(join(tmpdir(), 'botmux-invite-')); });

describe('invite-store', () => {
  it('creates a high-entropy code and consumes once', () => {
    const { code } = createInvite(dataDir, 'default', 'ou_admin');
    expect(code.length).toBeGreaterThan(8);
    expect(consumeInvite(dataDir, code)).toEqual({ ok: true, teamId: 'default' });
    // single-use
    expect(consumeInvite(dataDir, code)).toEqual({ ok: false, reason: 'used' });
  });

  it('rejects unknown codes', () => {
    expect(consumeInvite(dataDir, 'nope')).toEqual({ ok: false, reason: 'not_found' });
  });

  it('reports a stable reason for expired vs used vs not_found', () => {
    const { code } = createInvite(dataDir, 'default', 'ou_admin', 1000, 1_000_000);
    // expired (looked up before prune) → 'expired', not 'not_found'
    expect(consumeInvite(dataDir, code, 1_002_000)).toEqual({ ok: false, reason: 'expired' });
    // used
    const a = createInvite(dataDir, 'default', 'ou_admin');
    expect(consumeInvite(dataDir, a.code).ok).toBe(true);
    expect(consumeInvite(dataDir, a.code)).toEqual({ ok: false, reason: 'used' });
    // not found
    expect(consumeInvite(dataDir, 'zzz')).toEqual({ ok: false, reason: 'not_found' });
  });

  it('codes are unique', () => {
    const codes = new Set(Array.from({ length: 30 }, () => createInvite(dataDir, 'default', 'ou').code));
    expect(codes.size).toBe(30);
  });

  it('deleteInvitesForTeam drops only that team\'s invites, making them unusable', () => {
    const a = createInvite(dataDir, 'team_a', 'ou');
    const a2 = createInvite(dataDir, 'team_a', 'ou');
    const b = createInvite(dataDir, 'team_b', 'ou');
    expect(deleteInvitesForTeam(dataDir, 'team_a')).toBe(2);
    expect(consumeInvite(dataDir, a.code)).toEqual({ ok: false, reason: 'not_found' });
    expect(consumeInvite(dataDir, a2.code)).toEqual({ ok: false, reason: 'not_found' });
    // other teams untouched
    expect(consumeInvite(dataDir, b.code)).toEqual({ ok: true, teamId: 'team_b' });
    expect(deleteInvitesForTeam(dataDir, 'team_none')).toBe(0);
  });
});

describe('invite-store: corrupt file is quarantined, not overwritten', () => {
  beforeEach(() => { vi.spyOn(logger, 'warn').mockImplementation(() => {}); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('keeps the corrupt bytes as team-invites.json.corrupt-* after the next write', () => {
    const corrupt = '{"oldcode":{"code":"oldcode","teamId":"team_a"';
    writeFileSync(join(dataDir, 'team-invites.json'), corrupt);

    const inv = createInvite(dataDir, 'team_b', 'on_1');
    expect(consumeInvite(dataDir, inv.code)).toEqual({ ok: true, teamId: 'team_b' });

    const quarantined = readdirSync(dataDir).filter(f => f.startsWith('team-invites.json.corrupt-'));
    expect(quarantined).toHaveLength(1);
    expect(readFileSync(join(dataDir, quarantined[0]), 'utf-8')).toBe(corrupt);
  });
});
