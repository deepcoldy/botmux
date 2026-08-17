// P1-5: the view-link URL capability is short-lived and identity-bound.
// These helpers are what the dashboard uses to REPLACE the worker's unbound
// per-boot token in /api/sessions/:id/view-link responses, and what the front
// proxy uses to map a presented capability back to its auth session.
import { describe, expect, it } from 'vitest';
import { verifyTerminalControlGrant } from '../src/core/terminal-control-grant.js';
import {
  TERMINAL_VIEW_CAPABILITY_TTL_MS,
  mintTerminalViewCapability,
  rewriteViewLinkCapability,
  terminalViewCapabilityAuthSession,
} from '../src/dashboard/terminal-view-capability.js';

const SECRET = 'view-capability-test-secret';
const NOW = 1_755_000_000_000;

const h5Identity = {
  userId: 'ou_h5_viewer',
  authSessionId: 'h5-auth-1',
  expiresAt: NOW + 30 * 60_000,
};

describe('mintTerminalViewCapability', () => {
  it('mints a READ grant bound to sessionId + authSessionId, capped at the short TTL', () => {
    const minted = mintTerminalViewCapability(SECRET, 's1', h5Identity, NOW);
    expect(minted).not.toBeNull();
    // 身份还有 30 分钟，但能力必须按短 TTL 截断——URL capability 只许短命。
    expect(minted!.expiresAt).toBe(NOW + TERMINAL_VIEW_CAPABILITY_TTL_MS);
    const verified = verifyTerminalControlGrant(SECRET, minted!.token, 's1', NOW);
    expect(verified).toEqual({
      ok: true,
      claims: expect.objectContaining({
        scope: 'read',
        sessionId: 's1',
        userId: 'ou_h5_viewer',
        authSessionId: 'h5-auth-1',
        expiresAt: minted!.expiresAt,
      }),
    });
    // 换个 session 立即失效：能力不能跨会话挪用。
    expect(verifyTerminalControlGrant(SECRET, minted!.token, 's2', NOW)).toEqual({
      ok: false, reason: 'session_mismatch',
    });
    // 到期即拒：过期重连拿同一条 URL 必然 403。
    expect(verifyTerminalControlGrant(SECRET, minted!.token, 's1', minted!.expiresAt)).toEqual({
      ok: false, reason: 'expired',
    });
  });

  it('never outlives the requesting authentication and fails closed on a dead identity', () => {
    const shortLived = { ...h5Identity, expiresAt: NOW + 90_000 };
    expect(mintTerminalViewCapability(SECRET, 's1', shortLived, NOW)!.expiresAt).toBe(NOW + 90_000);
    expect(mintTerminalViewCapability(SECRET, 's1', { ...h5Identity, expiresAt: NOW }, NOW)).toBeNull();
    expect(mintTerminalViewCapability(SECRET, 's1', { ...h5Identity, expiresAt: NOW - 1 }, NOW)).toBeNull();
    // 身份字段出界（空 userId）宁可失败也不回退到任何稳定 token。
    expect(mintTerminalViewCapability(SECRET, 's1', { ...h5Identity, userId: '' }, NOW)).toBeNull();
  });
});

describe('rewriteViewLinkCapability', () => {
  it('REPLACES the upstream per-boot token so the unbound value never reaches the browser', () => {
    const rewritten = rewriteViewLinkCapability(
      'http://10.0.0.7:8801/s/s1/?viewToken=worker-boot-token',
      'bound-capability',
    );
    const parsed = new URL(rewritten!);
    expect(parsed.searchParams.get('viewToken')).toBe('bound-capability');
    expect(rewritten).not.toContain('worker-boot-token');
    expect(parsed.pathname).toBe('/s/s1/');
  });

  it('adds the capability when upstream had none and fails closed on malformed upstream URLs', () => {
    const added = rewriteViewLinkCapability('https://m-abc.platform.example/s/s1', 'cap');
    expect(new URL(added!).searchParams.get('viewToken')).toBe('cap');
    expect(rewriteViewLinkCapability('not a url', 'cap')).toBeNull();
    expect(rewriteViewLinkCapability('javascript:alert(1)', 'cap')).toBeNull();
  });
});

describe('terminalViewCapabilityAuthSession', () => {
  it('resolves the auth session only for a valid bound READ capability of this session', () => {
    const minted = mintTerminalViewCapability(SECRET, 's1', h5Identity, NOW)!;
    expect(terminalViewCapabilityAuthSession(SECRET, 's1', minted.token, NOW)).toBe('h5-auth-1');
    // 过期、跨 session、随机字符串、worker 每 boot token 一律不算 bound capability。
    expect(terminalViewCapabilityAuthSession(SECRET, 's1', minted.token, minted.expiresAt)).toBeNull();
    expect(terminalViewCapabilityAuthSession(SECRET, 's2', minted.token, NOW)).toBeNull();
    expect(terminalViewCapabilityAuthSession(SECRET, 's1', 'random-per-boot-token', NOW)).toBeNull();
    expect(terminalViewCapabilityAuthSession(SECRET, 's1', null, NOW)).toBeNull();
  });
});
