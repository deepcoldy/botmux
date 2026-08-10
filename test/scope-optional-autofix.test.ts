/**
 * Source-level guard for the opt-in optional-scope auto-top-up in
 * checkRequiredScopes (src/im/lark/event-dispatcher.ts).
 *
 * checkRequiredScopes is a large network-driven function (real Lark app-info
 * fetch + Open Platform automation), so — mirroring listener-foreign-bot-owner
 * and initial-passthrough-ownership — we pin the behavior we care about on the
 * source region rather than standing up the whole HTTP/browser stack.
 *
 * What must hold (PR #715 — make `botmux restart` pick up a newly-declared
 * NON-critical scope without a trip to the Open Platform, without nagging bots
 * that don't need it):
 *  - When all critical scopes are granted but an optional one is missing, we try
 *    a top-up (missingOptional.length > 0 gate) BEFORE the "all critical granted"
 *    early return.
 *  - That top-up is SILENT (silent:true → no admin DM) and QR-safe
 *    (disableQrLogin:true → a missing/expired web session fails cleanly, no
 *    second QR, no prompt) so a bot with no cached session is unaffected.
 *  - A successful top-up returns; otherwise it falls through to the normal
 *    "all critical granted" return (no behavior change for the no-session case).
 *  - tryAutoFixScopes only pops a QR when NOT disableQrLogin, and skips the
 *    success DM when silent.
 *
 * Run: pnpm vitest run test/scope-optional-autofix.test.ts
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const src = readFileSync(new URL('../src/im/lark/event-dispatcher.ts', import.meta.url), 'utf-8');

function fnRegion(signature: string, span = 3200): string {
  const start = src.indexOf(signature);
  expect(start, `${signature} not found in event-dispatcher.ts`).toBeGreaterThanOrEqual(0);
  return src.slice(start, start + span);
}

describe('checkRequiredScopes — opt-in optional-scope auto-top-up', () => {
  // The all-critical-granted branch, up to (and including) its early return.
  const region = (() => {
    const anchor = 'if (missingCritical.length === 0) {';
    const start = src.indexOf(anchor);
    expect(start, 'missingCritical.length === 0 branch not found').toBeGreaterThanOrEqual(0);
    return src.slice(start, start + 1400);
  })();

  it('gates the top-up on a missing optional scope', () => {
    expect(region).toContain('if (missingOptional.length > 0 && brand === \'feishu\') {');
  });

  it('runs the top-up SILENTLY and WITHOUT a second QR (session-only)', () => {
    expect(region).toContain('{ disableQrLogin: true, silent: true }');
    // passes no critical scopes (optional-only top-up)
    expect(region).toMatch(/tryAutoFixScopes\(larkAppId, bot, brand, \[\], missingOptional,/);
  });

  it('returns on a successful top-up (before the all-critical-granted log)', () => {
    const topUpIdx = region.indexOf('const toppedUp = await tryAutoFixScopes');
    const returnIdx = region.indexOf('return;', topUpIdx);
    const allGrantedLogIdx = region.indexOf('all critical scopes granted');
    expect(topUpIdx).toBeGreaterThanOrEqual(0);
    expect(returnIdx).toBeGreaterThan(topUpIdx);
    // the success return sits before the terminal all-critical-granted log line
    expect(returnIdx).toBeLessThan(allGrantedLogIdx);
  });

  it('falls through to the normal early return when no session (no behavior change)', () => {
    // the terminal log + return are still present after the optional block
    expect(region).toContain('all critical scopes granted');
  });
});

describe('tryAutoFixScopes — silent / disableQrLogin plumbing', () => {
  const region = fnRegion('async function tryAutoFixScopes(', 4200);

  it('accepts the disableQrLogin + silent opts', () => {
    expect(region).toContain('opts?: { disableQrLogin?: boolean; silent?: boolean }');
  });

  it('threads disableQrLogin into the Open Platform automation', () => {
    expect(region).toContain('disableQrLogin: opts?.disableQrLogin,');
  });

  it('skips the admin success DM when silent', () => {
    // the silent early-return must sit before getAdminOpenId is read for the DM
    const silentIdx = region.indexOf('if (opts?.silent) return true;');
    const adminIdx = region.indexOf('const adminOpenId = getAdminOpenId(bot);');
    expect(silentIdx).toBeGreaterThanOrEqual(0);
    expect(adminIdx).toBeGreaterThan(silentIdx);
  });
});
