// test/terminal-write-auth.test.ts
//
// Security regression guard for the terminal write-permission gate.
//
// The `X-Botmux-Role` header is only trustworthy when a central platform fronts
// `/s` and authoritatively injects it (after stripping any client copy). A
// self-hosted deployment (NOT bound to a platform) has no such boundary, so a
// client can forge `X-Botmux-Role: owner` and bypass the `?token=` gate =
// unauthenticated terminal write = RCE. The gate must therefore honor the role
// header ONLY when this machine is platform-bound.
import { describe, it, expect } from 'vitest';
import { resolveTerminalWrite, resolveTerminalWriteForRequest } from '../src/core/terminal-write-auth.js';

describe('resolveTerminalWrite', () => {
  describe('self-hosted (not platform-bound): role header must NOT be trusted', () => {
    it('ignores a forged owner role with no token → no write (the RCE fix)', () => {
      expect(resolveTerminalWrite({ role: 'owner', tokenMatches: false, platformBound: false }))
        .toEqual({ hasWrite: false, platformReadonly: false });
    });

    it('still grants write via a matching ?token= even with a forged role present', () => {
      expect(resolveTerminalWrite({ role: 'owner', tokenMatches: true, platformBound: false }))
        .toEqual({ hasWrite: true, platformReadonly: false });
    });

    it('grants write via matching token when no role header is present', () => {
      expect(resolveTerminalWrite({ role: undefined, tokenMatches: true, platformBound: false }))
        .toEqual({ hasWrite: true, platformReadonly: false });
    });

    it('denies write when neither role trust nor token applies', () => {
      expect(resolveTerminalWrite({ role: undefined, tokenMatches: false, platformBound: false }))
        .toEqual({ hasWrite: false, platformReadonly: false });
    });
  });

  describe('platform-bound: trust the platform-injected role', () => {
    it('grants write for role owner (token irrelevant)', () => {
      expect(resolveTerminalWrite({ role: 'owner', tokenMatches: false, platformBound: true }))
        .toEqual({ hasWrite: true, platformReadonly: false });
    });

    it('forces read-only for a non-owner role (guest), overriding a matching token', () => {
      expect(resolveTerminalWrite({ role: 'guest', tokenMatches: true, platformBound: true }))
        .toEqual({ hasWrite: false, platformReadonly: true });
    });

    it('forces read-only for role teammate', () => {
      expect(resolveTerminalWrite({ role: 'teammate', tokenMatches: false, platformBound: true }))
        .toEqual({ hasWrite: false, platformReadonly: true });
    });

    it('falls back to token when no role header is present (local direct hit on a bound box)', () => {
      expect(resolveTerminalWrite({ role: undefined, tokenMatches: true, platformBound: true }))
        .toEqual({ hasWrite: true, platformReadonly: false });
      expect(resolveTerminalWrite({ role: '', tokenMatches: false, platformBound: true }))
        .toEqual({ hasWrite: false, platformReadonly: false });
    });
  });
});

describe('resolveTerminalWriteForRequest', () => {
  const bound = () => true;
  const unbound = () => false;

  it('extracts a string role header and honors it when bound', () => {
    expect(resolveTerminalWriteForRequest({ 'x-botmux-role': 'owner' }, false, bound))
      .toEqual({ hasWrite: true, platformReadonly: false });
  });

  it('ignores a forged role when unbound → token fallback (the RCE fix)', () => {
    expect(resolveTerminalWriteForRequest({ 'x-botmux-role': 'owner' }, false, unbound))
      .toEqual({ hasWrite: false, platformReadonly: false });
  });

  it('treats a duplicated (array) role header as absent → token fallback', () => {
    expect(resolveTerminalWriteForRequest({ 'x-botmux-role': ['owner', 'guest'] }, false, bound))
      .toEqual({ hasWrite: false, platformReadonly: false });
    expect(resolveTerminalWriteForRequest({ 'x-botmux-role': ['owner', 'guest'] }, true, bound))
      .toEqual({ hasWrite: true, platformReadonly: false });
  });

  it('falls back to token when no role header is present', () => {
    expect(resolveTerminalWriteForRequest({}, true, bound))
      .toEqual({ hasWrite: true, platformReadonly: false });
  });

  // Regression guard for the codex finding: binding must be evaluated per request,
  // not snapshotted. `botmux bind`/unbind hot-reloads binding without restarting
  // live workers — a snapshot would keep trusting forged headers after an unbind.
  it('evaluates the binding check on every call (not cached)', () => {
    let boundNow = false;
    const isBound = () => boundNow;
    const forgedNoToken = { 'x-botmux-role': 'owner' };

    // Unbound: forged owner is ignored.
    expect(resolveTerminalWriteForRequest(forgedNoToken, false, isBound))
      .toEqual({ hasWrite: false, platformReadonly: false });

    // Machine gets bound — the very next request must reflect it.
    boundNow = true;
    expect(resolveTerminalWriteForRequest(forgedNoToken, false, isBound))
      .toEqual({ hasWrite: true, platformReadonly: false });

    // And after an unbind, trust must drop again (no stale RCE window).
    boundNow = false;
    expect(resolveTerminalWriteForRequest(forgedNoToken, false, isBound))
      .toEqual({ hasWrite: false, platformReadonly: false });
  });
});
