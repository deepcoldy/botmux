import { t, type Locale } from '../../i18n/index.js';
import type { AskResult, PendingAsk } from '../../core/ask-types.js';
import { isHookPermissionAsk } from '../../core/ask-hook/types.js';

/** How a settled hook permission card ended, when that differs from the generic
 *  ask wording: botmux's own deadline denies (not just "no answer"), and the CLI
 *  may have ended the confirmation itself. Undefined for every other ask/result. */
export function permissionAskSettleStatus(
  ask: Pick<PendingAsk, 'originKind' | 'questions'>,
  result: AskResult,
  locale?: Locale,
): { headline: string; detail: string } | undefined {
  if (result.kind === 'invalidated' && result.failureCode === 'cli_resolved' && result.cliOutcome) {
    return {
      headline: t(`card.ask.cli_outcome.${result.cliOutcome}`, undefined, locale),
      detail: t(`card.ask.cli_outcome.${result.cliOutcome}.detail`, undefined, locale),
    };
  }
  if (result.kind === 'timedOut' && isHookPermissionAsk(ask)) {
    return {
      headline: t('card.ask.permission_timed_out', undefined, locale),
      detail: t('card.ask.permission_timed_out_detail', undefined, locale),
    };
  }
  return undefined;
}
