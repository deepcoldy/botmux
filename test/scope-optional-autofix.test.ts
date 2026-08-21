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

describe('ensureVcMeetingEventsSubscribed — startup VC-event check-then-configure', () => {
  const region = fnRegion('export async function ensureVcMeetingEventsSubscribed(', 3200);

  it('skips non-feishu, apiOnly, and VC-inactive bots (active-config gate)', () => {
    expect(region).toContain("if (brand !== 'feishu') return;");
    // vcMeetingAgentConfigActive fail-closes apiOnly AND enabled:false, so this
    // one guard covers both "no Feishu VC" cases.
    expect(region).toContain('if (!vcMeetingAgentConfigActive(bot.config)) return;');
  });

  it('probes read-only FIRST, then only auto-subscribes when events are missing', () => {
    const probeIdx = region.indexOf('await probeVcMeetingEventSubscription(larkAppId)');
    const gateIdx = region.indexOf('probe.missingVcEvents.length === 0 && probe.eventModeReady');
    const automationIdx = region.indexOf('await automateOpenPlatformSetup(');
    expect(probeIdx).toBeGreaterThanOrEqual(0);
    // the "already subscribed → return" gate sits BETWEEN the probe and the
    // publishing automation, so a satisfied bot never republishes.
    expect(gateIdx).toBeGreaterThan(probeIdx);
    expect(automationIdx).toBeGreaterThan(gateIdx);
  });

  it('never pops a QR at boot (disableQrLogin into the publishing automation)', () => {
    expect(region).toContain('disableQrLogin: true,');
  });

  it('degrades gracefully when the probe fails (log, no throw, no QR)', () => {
    // probe.ok === false → info log + early return BEFORE any automation call
    const probeFailIdx = region.indexOf('if (!probe.ok) {');
    const automationIdx = region.indexOf('await automateOpenPlatformSetup(');
    expect(probeFailIdx).toBeGreaterThanOrEqual(0);
    expect(probeFailIdx).toBeLessThan(automationIdx);
    expect(region).toContain('botmux setup');
  });

  it('DMs the admin only when the auto-subscribe actually fails', () => {
    const failIdx = region.indexOf('VC event auto-subscribe failed');
    const dmIdx = region.indexOf('await dmAdmin(');
    expect(failIdx).toBeGreaterThanOrEqual(0);
    expect(dmIdx).toBeGreaterThan(failIdx);
  });
});

describe('daemon startup wires the VC-event check behind !cfg.apiOnly', () => {
  const daemonSrc = readFileSync(new URL('../src/daemon.ts', import.meta.url), 'utf-8');

  it('calls ensureVcMeetingEventsSubscribed non-blocking inside the !cfg.apiOnly block', () => {
    const guardIdx = daemonSrc.indexOf('checkRequiredScopes(cfg.larkAppId).catch');
    const vcIdx = daemonSrc.indexOf('ensureVcMeetingEventsSubscribed(cfg.larkAppId).catch');
    expect(guardIdx).toBeGreaterThanOrEqual(0);
    // sits right after the scope check, sharing the same !cfg.apiOnly gate
    expect(vcIdx).toBeGreaterThan(guardIdx);
  });
});
