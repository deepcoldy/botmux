/**
 * Pairing-login store: device-code style browser ↔ Feishu identity binding.
 * Run: pnpm vitest run test/pairing-store.test.ts
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach } from 'vitest';
import {
  createPairing, claimPairing, getPairingStatus, consumePairing,
} from '../src/services/pairing-store.js';

let dataDir: string;
beforeEach(() => { dataDir = mkdtempSync(join(tmpdir(), 'botmux-pairing-')); });

describe('pairing-store', () => {
  it('full happy path: start → claim → consume', () => {
    const p = createPairing(dataDir);
    expect(p.code).toMatch(/^[A-Z2-9]{8}$/);
    expect(p.browserToken.length).toBeGreaterThan(20);
    expect(getPairingStatus(dataDir, p.pairingId, p.browserToken)).toEqual({ status: 'pending' });

    const claim = claimPairing(dataDir, p.code, { openId: 'ou_1', unionId: 'on_1', name: '张三' });
    expect(claim).toEqual({ ok: true, pairingId: p.pairingId });

    expect(getPairingStatus(dataDir, p.pairingId, p.browserToken)).toEqual({ status: 'claimed', claimedBy: { openId: 'ou_1', unionId: 'on_1', name: '张三' } });

    const consumed = consumePairing(dataDir, p.pairingId, p.browserToken);
    expect(consumed).toEqual({ ok: true, claimedBy: { openId: 'ou_1', unionId: 'on_1', name: '张三' } });
    // single-use
    expect(consumePairing(dataDir, p.pairingId, p.browserToken)).toEqual({ ok: false, reason: 'already_consumed' });
  });

  it('code is case-insensitive and trimmed on claim', () => {
    const p = createPairing(dataDir);
    expect(claimPairing(dataDir, `  ${p.code.toLowerCase()}  `, { openId: 'ou_1' }).ok).toBe(true);
  });

  it('claim fails for unknown / already-claimed code', () => {
    expect(claimPairing(dataDir, 'NOTACODE', { openId: 'ou_1' })).toEqual({ ok: false, reason: 'not_found' });
    const p = createPairing(dataDir);
    expect(claimPairing(dataDir, p.code, { openId: 'ou_1' }).ok).toBe(true);
    expect(claimPairing(dataDir, p.code, { openId: 'ou_2' })).toEqual({ ok: false, reason: 'already_claimed' });
  });

  it('expired pairing cannot be claimed or seen', () => {
    const p = createPairing(dataDir, 1000, 1_000_000);
    // 2s later — past the 1s TTL
    expect(claimPairing(dataDir, p.code, { openId: 'ou_1' }, 1_002_000)).toEqual({ ok: false, reason: 'not_found' });
    expect(getPairingStatus(dataDir, p.pairingId, p.browserToken, 1_002_000)).toEqual({ status: 'not_found' });
  });

  it('browserToken gates status and consume', () => {
    const p = createPairing(dataDir);
    claimPairing(dataDir, p.code, { openId: 'ou_1' });
    expect(getPairingStatus(dataDir, p.pairingId, 'wrong-token')).toEqual({ status: 'not_found' });
    expect(consumePairing(dataDir, p.pairingId, 'wrong-token')).toEqual({ ok: false, reason: 'not_found' });
  });

  it('consume requires a claimed pairing', () => {
    const p = createPairing(dataDir);
    expect(consumePairing(dataDir, p.pairingId, p.browserToken)).toEqual({ ok: false, reason: 'not_claimed' });
  });

  it('codes are unique across concurrent pairings', () => {
    const codes = new Set(Array.from({ length: 50 }, () => createPairing(dataDir).code));
    expect(codes.size).toBe(50);
  });
});
