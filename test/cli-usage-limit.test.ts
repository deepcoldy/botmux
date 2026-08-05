import { describe, expect, it } from 'vitest';
import {
  detectCliUsageLimit,
  HARD_RATE_LIMIT_COOLDOWN_MS,
  usageLimitStateKey,
  structuredRateLimitState,
  isStructuredRateLimitAuthoritative,
} from '../src/utils/cli-usage-limit.js';
import { createClaudeCodeAdapter } from '../src/adapters/cli/claude-code.js';
import { createGeniusAdapter } from '../src/adapters/cli/genius.js';
import { createCodexAdapter } from '../src/adapters/cli/codex.js';
import { createGrokAdapter } from '../src/adapters/cli/grok.js';
import { createTraexAdapter } from '../src/adapters/cli/traex.js';
import { createPiAdapter } from '../src/adapters/cli/pi.js';

describe('detectCliUsageLimit', () => {
  it('detects Codex usage limit output with a concrete retry time', () => {
    const result = detectCliUsageLimit(
      "You've hit your usage limit. Upgrade to Pro, visit https://chatgpt.com/codex/settings/usage or try again at 10:36 PM.",
      new Date(2026, 4, 19, 22, 0),
    );

    expect(result.limited).toBe(true);
    if (!result.limited) return;
    expect(result.kind).toBe('usage');
    expect(result.retryLabel).toBe('10:36 PM');
    expect(new Date(result.retryAtMs).getHours()).toBe(22);
    expect(new Date(result.retryAtMs).getMinutes()).toBe(36);
    expect(result.retryReady).toBe(false);
  });

  it('detects Codex usage limit output when the TUI wraps the retry phrase', () => {
    const result = detectCliUsageLimit(
      "You've hit your usage limit. Upgrade to Pro, visit https://chatgpt.com/codex/settings/usage or try\nagain at 3:08 PM.",
      new Date(2026, 4, 19, 14, 56),
    );

    expect(result.limited).toBe(true);
    if (!result.limited) return;
    expect(result.kind).toBe('usage');
    expect(result.retryLabel).toBe('3:08 PM');
    expect(new Date(result.retryAtMs).getHours()).toBe(15);
    expect(new Date(result.retryAtMs).getMinutes()).toBe(8);
    expect(result.retryReady).toBe(false);
  });

  it('detects Claude limit output with a reset time', () => {
    const result = detectCliUsageLimit(
      "You've hit your limit · resets 6:20pm (Asia/Calcutta)",
      new Date(2026, 4, 19, 17, 30),
    );

    expect(result.limited).toBe(true);
    if (!result.limited) return;
    expect(result.kind).toBe('usage');
    expect(result.retryLabel).toBe('6:20pm');
    expect(new Date(result.retryAtMs).getHours()).toBe(18);
    expect(new Date(result.retryAtMs).getMinutes()).toBe(20);
    expect(result.retryReady).toBe(false);
  });

  it('detects blocking rate-limit output with a concrete retry time', () => {
    const result = detectCliUsageLimit(
      'Rate limit exceeded. Try again at 10:36 PM.',
      new Date(2026, 4, 19, 17, 30),
    );

    expect(result.limited).toBe(true);
    if (!result.limited) return;
    expect(result.kind).toBe('rate');
    expect(result.retryLabel).toBe('10:36 PM');
  });

  it('detects 429 Too Many Requests without a wall-clock retry time', () => {
    const now = new Date(2026, 4, 19, 17, 30, 12);
    const result = detectCliUsageLimit(
      'stream disconnected before completion: exceeded retry limit, last status: 429 Too Many Requests, request id: req_abc123',
      now,
    );

    expect(result.limited).toBe(true);
    if (!result.limited) return;
    expect(result.kind).toBe('rate');
    expect(result.retryLabel).toBe('5-10 min');
    expect(result.retryReady).toBe(false);
    const bucketStart = Math.floor(now.getTime() / HARD_RATE_LIMIT_COOLDOWN_MS) * HARD_RATE_LIMIT_COOLDOWN_MS;
    expect(result.retryAtMs).toBe(bucketStart + 2 * HARD_RATE_LIMIT_COOLDOWN_MS);
  });

  it('detects exceeded retry limit text without an explicit 429 token', () => {
    const now = new Date(2026, 4, 19, 17, 30, 12);
    const result = detectCliUsageLimit(
      'Error: exceeded retry limit while contacting the model API',
      now,
    );

    expect(result.limited).toBe(true);
    if (!result.limited) return;
    expect(result.kind).toBe('rate');
    expect(result.retryLabel).toBe('5-10 min');
    expect(result.retryReady).toBe(false);
  });

  it('keeps hard 429 fallback state key stable across screen ticks in the same bucket', () => {
    const text = 'exceeded retry limit, last status: 429 Too Many Requests, request id: req_stable';
    const a = detectCliUsageLimit(text, new Date(2026, 4, 19, 17, 30, 0));
    const b = detectCliUsageLimit(text, new Date(2026, 4, 19, 17, 32, 45));

    expect(a.limited).toBe(true);
    expect(b.limited).toBe(true);
    if (!a.limited || !b.limited) return;
    expect(usageLimitStateKey(a)).toBe(usageLimitStateKey(b));
  });

  it('does not flag a bare standalone 429 token without rate-limit context', () => {
    // 429 as a port number / log line / HTTP access line — the exact
    // false-positive the tightened patterns must reject. Passes the cheap
    // gate (which still contains bare 429) but matches no final pattern.
    for (const text of [
      'GET /api/users 429 in 12ms',
      'listening on port 4290',
      'req_id 429 completed',
    ]) {
      const result = detectCliUsageLimit(text, new Date(2026, 4, 19, 17, 30));
      expect(result.limited, `should not flag: ${text}`).toBe(false);
    }
  });

  it('does not flag documentation/code output that mentions "Too Many Requests"', () => {
    // Agent command output frequently prints this phrase as prose/code, e.g.
    // "return an alert like `Too Many Requests`". Without 429/status context
    // it must not be treated as a live rate limit.
    const result = detectCliUsageLimit(
      'the endpoint may return an alert like `Too Many Requests`; treat that as retryable',
      new Date(2026, 4, 19, 17, 30),
    );
    expect(result.limited).toBe(false);
  });

  describe('suppressRateKind (structured-authoritative CLIs)', () => {
    const now = new Date(2026, 4, 19, 17, 30);

    it('suppresses a screen-scan rate verdict when a real rate limit phrase is on screen', () => {
      // Claude family has an authoritative transcript rate_limit signal, so the
      // screen scanner must NOT also flag rate — otherwise a dev editing
      // rate-limit code / the model quoting an error produces a false limit.
      const text = 'stream disconnected: exceeded retry limit, last status: 429 Too Many Requests';
      expect(detectCliUsageLimit(text, now).limited).toBe(true); // default (Codex etc.) still flags
      expect(detectCliUsageLimit(text, now, { suppressRateKind: true }).limited).toBe(false);
    });

    it('suppresses the exact dev-screen false positive that produced a bogus card', () => {
      // Real reported FP: developer viewing rate-limit test fixtures on screen.
      const devScreen = [
        "  it('detects 429 Too Many Requests without a wall-clock retry time', () => {",
        "    'exceeded retry limit, last status: 429 Too Many Requests'",
        "  \"You've hit your session limit · resets 10:40pm\"",
      ].join('\n');
      expect(detectCliUsageLimit(devScreen, now, { suppressRateKind: true }).limited).toBe(false);
    });

    it('still detects a genuine usage/quota limit even when rate is suppressed', () => {
      // usage (quota) has no structured equivalent yet, so it must survive.
      const result = detectCliUsageLimit(
        "You've hit your usage limit. Try again at 10:36 PM.",
        now,
        { suppressRateKind: true },
      );
      expect(result.limited).toBe(true);
      if (!result.limited) return;
      expect(result.kind).toBe('usage');
    });
  });

  describe('structuredRateLimitState', () => {
    it('parses a wall-clock retry time from the record text when present', () => {
      // Claude Code rate_limit records usually carry a human clock, e.g.
      // "You've hit your session limit · resets 10:40pm".
      const now = new Date(2026, 4, 19, 21, 0, 0); // 9:00 PM
      const state = structuredRateLimitState(
        "You've hit your session limit · resets 10:40pm (America/Los_Angeles)",
        now,
      );
      expect(state.limited).toBe(true);
      expect(state.kind).toBe('rate');
      expect(state.retryLabel).toBe('10:40pm');
      expect(state.retryReady).toBe(false);
    });

    it('falls back to the bucketed cooldown when the text carries no time', () => {
      const now = new Date(2026, 4, 19, 17, 30, 12);
      const state = structuredRateLimitState(
        "You've reached your Fable 5 limit. Run /usage-credits to continue",
        now,
      );
      expect(state.limited).toBe(true);
      expect(state.kind).toBe('rate');
      expect(state.retryLabel).toBe('5-10 min');
      const bucketStart = Math.floor(now.getTime() / HARD_RATE_LIMIT_COOLDOWN_MS) * HARD_RATE_LIMIT_COOLDOWN_MS;
      expect(state.retryAtMs).toBe(bucketStart + 2 * HARD_RATE_LIMIT_COOLDOWN_MS);
    });

    it('produces a stable state key across ticks in the same cooldown bucket (no-time case)', () => {
      const a = structuredRateLimitState('', new Date(2026, 4, 19, 17, 30, 0));
      const b = structuredRateLimitState('', new Date(2026, 4, 19, 17, 32, 45));
      expect(a.limited && b.limited).toBe(true);
      if (!a.limited || !b.limited) return;
      expect(usageLimitStateKey(a)).toBe(usageLimitStateKey(b));
    });

    it('flips to retry-ready once the parsed retry time has passed', () => {
      const state = structuredRateLimitState(
        "You've hit your session limit · resets 10:40pm",
        new Date(2026, 4, 19, 23, 0, 0), // 11:00 PM, past 10:40pm
      );
      expect(state.limited).toBe(true);
      expect(state.retryReady).toBe(true);
    });
  });

  it('marks a detected limit as retry-ready once the retry time has passed', () => {
    const result = detectCliUsageLimit(
      "You've hit your usage limit. Try again at 10:36 PM.",
      new Date(2026, 4, 19, 22, 40),
    );

    expect(result.limited).toBe(true);
    if (!result.limited) return;
    expect(result.retryReady).toBe(true);
  });

  it('rolls AM retry times to the next day when current time is already afternoon', () => {
    const result = detectCliUsageLimit(
      "You've hit your usage limit. Try again at 12:11 AM.",
      new Date(2026, 4, 19, 23, 0),
    );

    expect(result.limited).toBe(true);
    if (!result.limited) return;
    const retryAt = new Date(result.retryAtMs);
    expect(retryAt.getDate()).toBe(20);
    expect(retryAt.getHours()).toBe(0);
    expect(retryAt.getMinutes()).toBe(11);
  });

  it('does not treat low-quota warnings as a blocking usage limit', () => {
    const result = detectCliUsageLimit(
      'Heads up, you have less than 5% of your 5h limit left. Run /status for a breakdown.',
      new Date(2026, 4, 19, 17, 30),
    );

    expect(result.limited).toBe(false);
  });

  it('does not treat approaching-rate-limit model suggestions as blocking', () => {
    const result = detectCliUsageLimit(
      'Approaching rate limits\nSwitch to gpt-5.4-mini for lower credit usage?',
      new Date(2026, 4, 19, 17, 30),
    );

    expect(result.limited).toBe(false);
  });

  it('does not treat approaching-rate-limit text as blocking even when a time is present', () => {
    const result = detectCliUsageLimit(
      'Approaching rate limits. Try again at 10:36 PM if needed.',
      new Date(2026, 4, 19, 17, 30),
    );

    expect(result.limited).toBe(false);
  });

  it('does not treat generic retry-later text as limited without a concrete time', () => {
    const result = detectCliUsageLimit(
      "You've hit your usage limit. Try again later.",
      new Date(2026, 4, 19, 17, 30),
    );

    expect(result.limited).toBe(false);
  });

  it('does not treat documentation-like usage-limit text as blocking', () => {
    const result = detectCliUsageLimit(
      'Document that usage limits reset at midnight in the README.',
      new Date(2026, 4, 19, 17, 30),
    );

    expect(result.limited).toBe(false);
  });
});

describe('isStructuredRateLimitAuthoritative — Claude-family only, not all reliableTurnTerminal', () => {
  // This is the predicate the worker's structuredRateLimitAuthoritative()
  // delegates to. Testing it directly (not the adapter.claudeDataDir field)
  // means a regression that re-broadens the gate to reliableTurnTerminal — which
  // would wrongly suppress screen-rate for codex/grok/traex/pi — turns this red.
  it('is true for the Claude family (they publish structured limited events)', () => {
    expect(isStructuredRateLimitAuthoritative(createClaudeCodeAdapter('/bin/claude'))).toBe(true);
    expect(isStructuredRateLimitAuthoritative(createGeniusAdapter('/bin/genius'))).toBe(true);
  });
  it('is false for codexBridgeQueue CLIs (no structured limited emit → keep screen scan)', () => {
    expect(isStructuredRateLimitAuthoritative(createCodexAdapter('/bin/codex'))).toBe(false);
    expect(isStructuredRateLimitAuthoritative(createGrokAdapter('/bin/grok'))).toBe(false);
    expect(isStructuredRateLimitAuthoritative(createTraexAdapter('/bin/traex'))).toBe(false);
    expect(isStructuredRateLimitAuthoritative(createPiAdapter('/bin/pi'))).toBe(false);
  });
  it('is false for null/undefined adapter', () => {
    expect(isStructuredRateLimitAuthoritative(null)).toBe(false);
    expect(isStructuredRateLimitAuthoritative(undefined)).toBe(false);
    expect(isStructuredRateLimitAuthoritative({})).toBe(false);
  });
});
