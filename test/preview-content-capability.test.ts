import { describe, expect, it } from 'vitest';
import { issueTerminalControlGrant } from '../src/core/terminal-control-grant.js';
import {
  PREVIEW_CONTENT_CAPABILITY_PATTERN,
  PREVIEW_CONTENT_CAPABILITY_TTL_MS,
  mintPreviewContentCapability,
  verifyPreviewContentCapability,
} from '../src/dashboard/preview-content-capability.js';

const SECRET = 'dashboard-secret-not-a-real-credential';
const NOW = 1_760_000_000_000;

function identity(overrides: Partial<{ userId: string; authSessionId: string; expiresAt: number }> = {}) {
  return {
    userId: 'ou_owner',
    authSessionId: 'auth-session-a',
    expiresAt: NOW + 24 * 60 * 60_000,
    ...overrides,
  };
}

describe('preview content capability', () => {
  it('mints a path-safe capability bound to session, identity and expiry', () => {
    const minted = mintPreviewContentCapability(SECRET, 'sess-1', identity(), NOW);
    expect(minted).not.toBeNull();
    // Must survive a URL path segment untouched — no percent-encoding, which is
    // what lets relative subresources inherit it.
    expect(PREVIEW_CONTENT_CAPABILITY_PATTERN.test(minted!.token)).toBe(true);
    expect(encodeURIComponent(minted!.token)).toBe(minted!.token);
    expect(minted!.expiresAt).toBe(NOW + PREVIEW_CONTENT_CAPABILITY_TTL_MS);

    const verified = verifyPreviewContentCapability(SECRET, minted!.token, 'sess-1', NOW + 1_000);
    expect(verified.ok).toBe(true);
    expect(verified.ok && verified.claims).toMatchObject({
      purpose: 'preview-content',
      sessionId: 'sess-1',
      userId: 'ou_owner',
      authSessionId: 'auth-session-a',
    });
  });

  it('never outlives the authentication that minted it', () => {
    const shortLived = mintPreviewContentCapability(
      SECRET,
      'sess-1',
      identity({ expiresAt: NOW + 60_000 }),
      NOW,
    );
    expect(shortLived!.expiresAt).toBe(NOW + 60_000);
    expect(verifyPreviewContentCapability(SECRET, shortLived!.token, 'sess-1', NOW + 59_000).ok).toBe(true);
    expect(verifyPreviewContentCapability(SECRET, shortLived!.token, 'sess-1', NOW + 60_000)).toEqual({
      ok: false,
      reason: 'expired',
    });

    expect(mintPreviewContentCapability(SECRET, 'sess-1', identity({ expiresAt: NOW }), NOW)).toBeNull();
    expect(mintPreviewContentCapability('', 'sess-1', identity(), NOW)).toBeNull();
    expect(mintPreviewContentCapability(SECRET, '', identity(), NOW)).toBeNull();
    expect(mintPreviewContentCapability(SECRET, 'sess-1', identity({ authSessionId: '' }), NOW)).toBeNull();
  });

  it('refuses another session, another secret, and any tampering', () => {
    const minted = mintPreviewContentCapability(SECRET, 'sess-1', identity(), NOW)!;
    expect(verifyPreviewContentCapability(SECRET, minted.token, 'sess-2', NOW)).toEqual({
      ok: false,
      reason: 'session_mismatch',
    });
    expect(verifyPreviewContentCapability('other-secret', minted.token, 'sess-1', NOW)).toEqual({
      ok: false,
      reason: 'invalid',
    });
    const [prefix, payload, signature] = minted.token.split('.');
    const forgedClaims = Buffer.from(JSON.stringify({
      version: 1,
      purpose: 'preview-content',
      sessionId: 'sess-1',
      userId: 'ou_attacker',
      authSessionId: 'auth-session-a',
      capabilityId: 'aaaaaaaaaaaaaaaaaa',
      issuedAt: NOW,
      expiresAt: NOW + 60_000,
    }), 'utf8').toString('base64url');
    expect(verifyPreviewContentCapability(SECRET, `${prefix}.${forgedClaims}.${signature}`, 'sess-1', NOW)).toEqual({
      ok: false,
      reason: 'invalid',
    });
    expect(verifyPreviewContentCapability(SECRET, `${prefix}.${payload}.`, 'sess-1', NOW)).toEqual({
      ok: false,
      reason: 'malformed',
    });
    expect(verifyPreviewContentCapability(SECRET, undefined, 'sess-1', NOW)).toEqual({
      ok: false,
      reason: 'missing',
    });
  });

  it('is domain-separated from terminal control grants signed with the same secret', () => {
    // Same HMAC key, different capability class: a write grant for a session
    // must never open that session's preview stream, and vice versa.
    const writeGrant = issueTerminalControlGrant(SECRET, {
      scope: 'write',
      sessionId: 'sess-1',
      userId: 'ou_owner',
      authSessionId: 'auth-session-a',
      issuedAt: NOW,
      expiresAt: NOW + 60_000,
    });
    expect(verifyPreviewContentCapability(SECRET, writeGrant, 'sess-1', NOW).ok).toBe(false);

    const preview = mintPreviewContentCapability(SECRET, 'sess-1', identity(), NOW)!;
    // The preview capability does not even carry a terminal grant's prefix.
    expect(preview.token.startsWith('bmxg1.')).toBe(false);
  });
});
