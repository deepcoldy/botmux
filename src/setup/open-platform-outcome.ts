import type { OpenPlatformAutomationResult } from './open-platform-automation.js';

type OpenPlatformAutomationSuccess = Extract<OpenPlatformAutomationResult, { ok: true }>;
type OpenPlatformAutomationFailure = Extract<OpenPlatformAutomationResult, { ok: false }>;

export type SetupOpenPlatformOutcome =
  | { status: 'skipped' }
  | { status: 'ready'; result: OpenPlatformAutomationSuccess }
  | { status: 'ready_with_warnings'; result: OpenPlatformAutomationSuccess }
  | { status: 'manual'; result: OpenPlatformAutomationFailure }
  | { status: 'failed'; result: OpenPlatformAutomationFailure };

/**
 * Translate the low-level Open Platform response into setup completion
 * semantics. Lark's SDK compatibility path is intentionally manual because the
 * Feishu Web console automation does not apply there; it must not be reported
 * as a failed Feishu one-click setup.
 */
export function classifySetupOpenPlatformOutcome(
  result: OpenPlatformAutomationResult,
): Exclude<SetupOpenPlatformOutcome, { status: 'skipped' }> {
  if (!result.ok) {
    return result.reason === 'unsupported_brand'
      ? { status: 'manual', result }
      : { status: 'failed', result };
  }
  const hasWarnings = Boolean(
    result.scopeWarning
    || result.eventWarning
    || result.scopeCount === 0
    || result.skippedScopeCount > 0
    || !result.versionId
  );
  return { status: hasWarnings ? 'ready_with_warnings' : 'ready', result };
}

/** Critical Feishu automation failures leave a persisted but not-yet-ready bot. */
export function blocksSetupBotStart(outcome: SetupOpenPlatformOutcome): boolean {
  return outcome.status === 'failed';
}

const SESSION_RETRY_REASONS = new Set([
  'missing_session',
  'invalid_session',
  'login_failed',
  'qr_expired',
  'timeout',
  'missing_csrf',
]);

/** Build a retry command only when rerunning automation can make progress. */
export function setupOpenPlatformRetryCommand(
  appId: string,
  outcome: SetupOpenPlatformOutcome,
): string | undefined {
  if (outcome.status !== 'failed') return undefined;
  const switchAccount = SESSION_RETRY_REASONS.has(outcome.result.reason) ? ' --switch-account' : '';
  return `botmux setup configure ${appId}${switchAccount}`;
}

/**
 * Scripted JSON callers must never receive an unexpected QR, including BYO
 * credential mode. The one-scan create path also reuses the session it just
 * acquired so it never scans twice.
 */
export function scriptedSetupOpenPlatformReuseOnly(options: {
  json: boolean;
  createApp: boolean;
  compatibilityMode: boolean;
  brand: 'feishu' | 'lark';
}): boolean {
  if (options.brand !== 'feishu') return false;
  return options.json || (options.createApp && !options.compatibilityMode);
}

/** Secret-free JSON representation used by scripted setup output. */
export function setupOpenPlatformOutcomeJson(outcome: SetupOpenPlatformOutcome): Record<string, unknown> {
  if (outcome.status === 'skipped') return { status: outcome.status };
  const { ok: _ok, ...details } = outcome.result;
  return { status: outcome.status, ...details };
}
