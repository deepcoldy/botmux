/**
 * Format rules for the BotID / Secret an onboarding job in manual mode is
 * started with (`POST /api/bot-onboarding/start`, `platform: 'wecom'`,
 * `mode: 'manual'`). The Dashboard checks them before it accepts the job
 * (dashboard/wecom/onboarding.ts); the terminal wizard checks the same rules
 * before it sends anything (cli/wecom/setup-wizard.ts), so a typo is asked again
 * instead of turning into a failed request. Both sides trim the values they keep.
 */

/** Non-empty after trimming, at most 200 characters, no whitespace or control characters inside. */
export function isWecomManualBotId(value: unknown): value is string {
  return typeof value === 'string'
    && Boolean(value.trim())
    && value.length <= 200
    && !/[\x00-\x20]/.test(value.trim());
}

/** Non-empty after trimming, no line breaks, at most 8 KiB of UTF-8. */
export function isWecomManualSecret(value: unknown): value is string {
  return typeof value === 'string'
    && Boolean(value.trim())
    && !/[\r\n]/.test(value)
    && Buffer.byteLength(value) <= 8192;
}
