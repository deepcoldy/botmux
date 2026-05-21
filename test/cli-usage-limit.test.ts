import { describe, expect, it } from 'vitest';
import { detectCliUsageLimit } from '../src/utils/cli-usage-limit.js';

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
