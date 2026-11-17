import { t, type Locale } from '../i18n/index.js';
import { resumeStartsFresh } from '../services/resume-fresh-policy.js';

type ResumeSuccessResult = {
  recoveryPending?: true;
  ds: {
    session: Parameters<typeof resumeStartsFresh>[0];
  };
};

/** Render the user-facing receipt for a successful session resume.
 *
 *  `dshRuntime` is the LIVE bot toggle (see `dshRuntimeForSession`): a `dsh`
 *  session whose bot selected the TUI resumes through the dsh-tui adapter,
 *  which never records a native id. Callers must pass it or the receipt
 *  describes the headless dsh adapter and claims a restored history the TUI
 *  cannot deliver. */
export function resumeSuccessMessage(
  result: ResumeSuccessResult,
  cliName: string,
  locale: Locale,
  dshRuntime?: 'official' | 'tui',
): string {
  if (result.recoveryPending) {
    return t('card.action.resume_started_remote', { cliName }, locale);
  }
  return resumeStartsFresh({ ...result.ds.session, dshRuntime })
    ? t('card.action.resume_success_fresh', { cliName }, locale)
    : t('card.action.resume_success', { cliName }, locale);
}
