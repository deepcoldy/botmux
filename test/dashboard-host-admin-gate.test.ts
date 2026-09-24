import { describe, expect, it } from 'vitest';
import { resolveDashboardRequestGate } from '../src/dashboard/request-identity.js';

const TOK = 'active-management-token';

// The four new admin paths host dashboard.ts proxies to per-bot daemons. None
// may be reachable without a management credential; the daemon-side HMAC gate
// is a second, independent layer.
const ADMIN_PATHS: Array<{ method: string; pathname: string }> = [
  { method: 'GET', pathname: '/api/bots/cli_a/blocked-users' },
  { method: 'PUT', pathname: '/api/bots/cli_a/blocked-users' },
  { method: 'POST', pathname: '/api/bots/cli_a/grants/chat' },
  { method: 'PUT', pathname: '/api/bots/cli_a/chat-group-grant' },
];

function decideFor(path: { method: string; pathname: string }, token?: string) {
  return resolveDashboardRequestGate({
    method: path.method,
    pathname: path.pathname,
    hasTokenParam: false,
    identity: null,
    tokenFromRequest: token,
    activeToken: TOK,
    publicReadOnly: false,
  }).decision;
}

describe('host gate for new member-admin proxies', () => {
  for (const path of ADMIN_PATHS) {
    it(`${path.method} ${path.pathname} → deny401 without a management token`, () => {
      expect(decideFor(path).kind).toBe('deny401');
    });

    it(`${path.method} ${path.pathname} → allowed with the active management token`, () => {
      const decision = decideFor(path, TOK);
      expect(decision.kind).not.toBe('deny401');
    });
  }

  it('does not accidentally place the new paths on the public read allowlist', () => {
    // GET blocked-users in particular must not be world-readable even though
    // sibling /api/groups GETs are public read.
    const decision = resolveDashboardRequestGate({
      method: 'GET',
      pathname: '/api/bots/cli_a/blocked-users',
      hasTokenParam: false,
      identity: null,
      tokenFromRequest: undefined,
      activeToken: TOK,
      publicReadOnly: true,
    }).decision;
    expect(decision.kind).toBe('deny401');
  });
});
