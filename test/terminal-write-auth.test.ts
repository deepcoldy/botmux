// test/terminal-write-auth.test.ts
//
// Guard for the terminal write-permission gate.
//
// The `X-Botmux-Role` header is only trustworthy on a request that genuinely
// traversed the platform's authenticated reverse proxy. That proxy drops any
// client Cookie and injects this machine's real `botmux_dashboard_token`; the
// dashboard `/s` bridge / terminal-proxy then replay headers verbatim. A direct
// caller (front door binds all interfaces) can forge `X-Botmux-Role: owner` but
// cannot supply the secret dashboard token. The gate therefore honors the role
// header only when the machine is platform-bound AND the request carries the
// matching dashboard-token cookie; otherwise write falls back to `?token=`.
//
// Independently of the role, a matching private write-link `?token=` is a
// capability in its own right: the owner explicitly issued that link, so it
// grants write even when the platform authenticated the viewer as guest.
import { describe, it, expect } from 'vitest';
import {
  resolveTerminalWrite,
  resolveTerminalWriteForRequest,
  readDashboardCookie,
} from '../src/core/terminal-write-auth.js';

const TOK = 'dash-secret-token';

describe('resolveTerminalWrite (pure gate)', () => {
  describe('role header ignored unless BOTH platform-bound AND platform-proxied', () => {
    it('bound but not proxied: forged owner ignored → token fallback (no write)', () => {
      expect(resolveTerminalWrite({ role: 'owner', tokenMatches: false, platformBound: true, platformProxied: false }))
        .toEqual({ hasWrite: false, platformReadonly: false });
    });

    it('proxied but not bound: role ignored → token fallback (defense in depth)', () => {
      expect(resolveTerminalWrite({ role: 'owner', tokenMatches: false, platformBound: false, platformProxied: true }))
        .toEqual({ hasWrite: false, platformReadonly: false });
    });

    it('neither: forged owner ignored → token fallback', () => {
      expect(resolveTerminalWrite({ role: 'owner', tokenMatches: false, platformBound: false, platformProxied: false }))
        .toEqual({ hasWrite: false, platformReadonly: false });
    });

    it('bound but not proxied: a matching ?token= still grants write', () => {
      expect(resolveTerminalWrite({ role: 'owner', tokenMatches: true, platformBound: true, platformProxied: false }))
        .toEqual({ hasWrite: true, platformReadonly: false });
    });
  });

  describe('platform-bound AND platform-proxied: trust the injected role', () => {
    it('grants write for role owner (token irrelevant)', () => {
      expect(resolveTerminalWrite({ role: 'owner', tokenMatches: false, platformBound: true, platformProxied: true }))
        .toEqual({ hasWrite: true, platformReadonly: false });
    });

    it('a matching private write-link token grants write even for role guest (capability)', () => {
      expect(resolveTerminalWrite({ role: 'guest', tokenMatches: true, platformBound: true, platformProxied: true }))
        .toEqual({ hasWrite: true, platformReadonly: false });
    });

    it('forces read-only for a non-owner role (guest) without a token', () => {
      expect(resolveTerminalWrite({ role: 'guest', tokenMatches: false, platformBound: true, platformProxied: true }))
        .toEqual({ hasWrite: false, platformReadonly: true });
    });

    it('forces read-only for role teammate', () => {
      expect(resolveTerminalWrite({ role: 'teammate', tokenMatches: false, platformBound: true, platformProxied: true }))
        .toEqual({ hasWrite: false, platformReadonly: true });
    });

    it('no role header present → token fallback (local direct hit on a bound box)', () => {
      expect(resolveTerminalWrite({ role: undefined, tokenMatches: true, platformBound: true, platformProxied: true }))
        .toEqual({ hasWrite: true, platformReadonly: false });
      expect(resolveTerminalWrite({ role: '', tokenMatches: false, platformBound: true, platformProxied: true }))
        .toEqual({ hasWrite: false, platformReadonly: false });
    });
  });
});

describe('readDashboardCookie', () => {
  it('extracts the token from a Cookie header among others', () => {
    expect(readDashboardCookie('a=1; botmux_dashboard_token=xyz; b=2')).toBe('xyz');
  });
  it('joins an array Cookie header', () => {
    expect(readDashboardCookie(['a=1', 'botmux_dashboard_token=xyz'])).toBe('xyz');
  });
  it('returns null when absent / empty / undefined', () => {
    expect(readDashboardCookie('a=1; b=2')).toBeNull();
    expect(readDashboardCookie('botmux_dashboard_token=')).toBeNull();
    expect(readDashboardCookie(undefined)).toBeNull();
  });
});

describe('resolveTerminalWriteForRequest', () => {
  const bound = () => true;
  const unbound = () => false;
  const token = () => TOK;
  const noToken = () => null;
  const cookie = (v: string) => ({ cookie: `botmux_dashboard_token=${v}` });

  it('honors owner when bound AND the cookie matches the active dashboard token', () => {
    expect(resolveTerminalWriteForRequest({ 'x-botmux-role': 'owner', ...cookie(TOK) }, false, bound, token))
      .toEqual({ hasWrite: true, platformReadonly: false });
  });

  it('ignores a forged owner when the dashboard cookie is MISSING → token fallback (the fix)', () => {
    expect(resolveTerminalWriteForRequest({ 'x-botmux-role': 'owner' }, false, bound, token))
      .toEqual({ hasWrite: false, platformReadonly: false });
  });

  it('ignores a forged owner when the cookie value is WRONG → token fallback (the fix)', () => {
    expect(resolveTerminalWriteForRequest({ 'x-botmux-role': 'owner', ...cookie('attacker-guess') }, false, bound, token))
      .toEqual({ hasWrite: false, platformReadonly: false });
  });

  it('ignores the role when the machine has no active dashboard token', () => {
    expect(resolveTerminalWriteForRequest({ 'x-botmux-role': 'owner', ...cookie(TOK) }, false, bound, noToken))
      .toEqual({ hasWrite: false, platformReadonly: false });
  });

  it('ignores the role when unbound even with a matching cookie', () => {
    expect(resolveTerminalWriteForRequest({ 'x-botmux-role': 'owner', ...cookie(TOK) }, false, unbound, token))
      .toEqual({ hasWrite: false, platformReadonly: false });
  });

  it('treats a duplicated (array) role header as absent → token fallback', () => {
    expect(resolveTerminalWriteForRequest({ 'x-botmux-role': ['owner', 'guest'], ...cookie(TOK) }, false, bound, token))
      .toEqual({ hasWrite: false, platformReadonly: false });
    expect(resolveTerminalWriteForRequest({ 'x-botmux-role': ['owner', 'guest'], ...cookie(TOK) }, true, bound, token))
      .toEqual({ hasWrite: true, platformReadonly: false });
  });

  it('falls back to token when no role header is present', () => {
    expect(resolveTerminalWriteForRequest({ ...cookie(TOK) }, true, bound, token))
      .toEqual({ hasWrite: true, platformReadonly: false });
  });

  // Both thunks must be evaluated per request, never snapshotted: bind/unbind and
  // dashboard token rotation are hot-reloaded without restarting live workers.
  it('evaluates binding + token on every call (not cached)', () => {
    let boundNow = false;
    let activeTok: string | null = TOK;
    const isBound = () => boundNow;
    const getTok = () => activeTok;
    const req = { 'x-botmux-role': 'owner', ...cookie(TOK) };

    // Unbound: forged owner ignored.
    expect(resolveTerminalWriteForRequest(req, false, isBound, getTok))
      .toEqual({ hasWrite: false, platformReadonly: false });

    // Bound + cookie matches active token → trusted next request.
    boundNow = true;
    expect(resolveTerminalWriteForRequest(req, false, isBound, getTok))
      .toEqual({ hasWrite: true, platformReadonly: false });

    // Token rotates → the old cookie no longer matches → trust drops immediately.
    activeTok = 'rotated-token';
    expect(resolveTerminalWriteForRequest(req, false, isBound, getTok))
      .toEqual({ hasWrite: false, platformReadonly: false });
  });
});
