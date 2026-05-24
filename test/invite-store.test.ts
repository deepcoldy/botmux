/**
 * Team invite store: single-use, short-TTL admission codes.
 * Run: pnpm vitest run test/invite-store.test.ts
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach } from 'vitest';
import { createInvite, consumeInvite } from '../src/services/invite-store.js';

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
});
