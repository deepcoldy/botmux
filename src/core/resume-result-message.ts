import { t, type Locale } from '../i18n/index.js';
import { resumeStartsFresh } from '../services/resume-fresh-policy.js';

type ResumeSuccessResult = {
  recoveryPending?: true;
  ds: {
    session: Parameters<typeof resumeStartsFresh>[0];
  };
};

/** Render the user-facing receipt for a successful session resume. */
export function resumeSuccessMessage(
  result: ResumeSuccessResult,
  cliName: string,
  locale: Locale,
): string {
  if (result.recoveryPending) {
    return t('card.action.resume_started_remote', { cliName }, locale);
  }
  return resumeStartsFresh(result.ds.session)
    ? t('card.action.resume_success_fresh', { cliName }, locale)
    : t('card.action.resume_success', { cliName }, locale);
}
