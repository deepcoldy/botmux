/**
 * Pairing-login HTTP handlers: start → claim → consume, with team-membership
 * gate and first-login bootstrap.
 * Run: pnpm vitest run test/pairing-api.test.ts
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach } from 'vitest';
import { pairingStart, pairingStatusView, pairingConsume, PAIR_COOKIE, SESSION_COOKIE } from '../src/dashboard/pairing-api.js';
import { claimPairing } from '../src/services/pairing-store.js';
import { getWebSession } from '../src/services/web-session-store.js';
import { addMember, ensureDefaultTeam, DEFAULT_TEAM_ID, isMember } from '../src/services/team-store.js';
import { createInvite } from '../src/services/invite-store.js';

let dataDir: string;
beforeEach(() => { dataDir = mkdtempSync(join(tmpdir(), 'botmux-pairapi-')); });

function start() {
  const r = pairingStart(dataDir);
  return { pairingId: (r.body as any).pairingId as string, code: (r.body as any).code as string, browserToken: r.cookie!.value };
}

describe('pairing-api', () => {
  it('start returns a code and sets the pair cookie', () => {
    const r = pairingStart(dataDir);
    expect((r.body as any).code).toMatch(/^[A-Z2-9]{8}$/);
    expect(r.cookie?.name).toBe(PAIR_COOKIE);
  });

  it('status reflects pending → claimed', () => {
    const { pairingId, code, browserToken } = start();
    expect((pairingStatusView(dataDir, pairingId, browserToken).body as any).status).toBe('pending');
    claimPairing(dataDir, code, { openId: 'ou_1', unionId: 'on_1', name: '张三' });
    const v = pairingStatusView(dataDir, pairingId, browserToken).body as any;
    expect(v.status).toBe('claimed');
    expect(v.name).toBe('张三');
  });

  it('first login bootstraps the empty default team and issues a session', () => {
    const { pairingId, code, browserToken } = start();
    claimPairing(dataDir, code, { openId: 'ou_1', unionId: 'on_1', name: '张三' });
    const r = pairingConsume(dataDir, pairingId, browserToken);
    expect(r.status).toBe(200);
    expect(r.cookie?.name).toBe(SESSION_COOKIE);
    // session is valid
    expect(getWebSession(dataDir, r.cookie!.value)).not.toBeNull();
    //张三 is now a team member (bootstrapped)
    expect(isMember(dataDir, DEFAULT_TEAM_ID, { unionId: 'on_1' })).toBe(true);
  });

  it('non-member is rejected once the team has members', () => {
    ensureDefaultTeam(dataDir);
    addMember(dataDir, DEFAULT_TEAM_ID, { unionId: 'on_owner' }); // team already seeded
    const { pairingId, code, browserToken } = start();
    claimPairing(dataDir, code, { openId: 'ou_x', unionId: 'on_stranger', name: '陌生人' });
    const r = pairingConsume(dataDir, pairingId, browserToken);
    expect(r.status).toBe(403);
    expect((r.body as any).reason).toBe('not_a_member');
    expect(r.cookie).toBeUndefined();
  });

  it('non-member joins via a valid invite; rejected without one', () => {
    ensureDefaultTeam(dataDir);
    addMember(dataDir, DEFAULT_TEAM_ID, { unionId: 'on_owner' }); // team already seeded
    let p = start();
    claimPairing(dataDir, p.code, { openId: 'ou_s', unionId: 'on_s', name: '陌生人' });
    expect(pairingConsume(dataDir, p.pairingId, p.browserToken).status).toBe(403);
    const { code } = createInvite(dataDir, DEFAULT_TEAM_ID, 'on_owner');
    p = start();
    claimPairing(dataDir, p.code, { openId: 'ou_s', unionId: 'on_s', name: '陌生人' });
    const r = pairingConsume(dataDir, p.pairingId, p.browserToken, undefined, code);
    expect(r.status).toBe(200);
    expect(isMember(dataDir, DEFAULT_TEAM_ID, { unionId: 'on_s' })).toBe(true);
    const p2 = start();
    claimPairing(dataDir, p2.code, { openId: 'ou_t', unionId: 'on_t' });
    expect(pairingConsume(dataDir, p2.pairingId, p2.browserToken, undefined, code).status).toBe(403);
  });

  it('surfaces stable invite failure reasons (not_found / used)', () => {
    ensureDefaultTeam(dataDir);
    addMember(dataDir, DEFAULT_TEAM_ID, { unionId: 'on_owner' });
    // bogus invite → invite_not_found
    let p = start();
    claimPairing(dataDir, p.code, { openId: 'ou_s', unionId: 'on_s' });
    expect((pairingConsume(dataDir, p.pairingId, p.browserToken, undefined, 'BOGUS').body as any).reason).toBe('invite_not_found');
    // first use joins, second use of same code → invite_used
    const inv = createInvite(dataDir, DEFAULT_TEAM_ID, 'on_owner');
    let pa = start();
    claimPairing(dataDir, pa.code, { openId: 'ou_a', unionId: 'on_a' });
    expect(pairingConsume(dataDir, pa.pairingId, pa.browserToken, undefined, inv.code).status).toBe(200);
    let pb = start();
    claimPairing(dataDir, pb.code, { openId: 'ou_b', unionId: 'on_b' });
    expect((pairingConsume(dataDir, pb.pairingId, pb.browserToken, undefined, inv.code).body as any).reason).toBe('invite_used');
  });

  it('consume before claim fails (not_claimed)', () => {
    const { pairingId, browserToken } = start();
    const r = pairingConsume(dataDir, pairingId, browserToken);
    expect(r.status).toBe(409);
    expect((r.body as any).reason).toBe('not_claimed');
  });

  it('wrong browserToken cannot consume', () => {
    const { pairingId, code } = start();
    claimPairing(dataDir, code, { openId: 'ou_1', unionId: 'on_1' });
    const r = pairingConsume(dataDir, pairingId, 'forged-token');
    expect(r.status).toBe(409);
  });
});
