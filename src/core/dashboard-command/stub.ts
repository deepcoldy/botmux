/**
 * `/dashboard <module>` module registry, help text, and fallback replies.
 *
 * The concrete handlers live in sibling files. `buildStubText` remains as a
 * defensive fallback for future modules or partial refactors.
 */

import { t, type Locale } from '../../i18n/index.js';

export type DashboardModule =
  | 'overview'
  | 'sessions'
  | 'workflows'
  | 'groups'
  | 'schedules'
  | 'settings';

export const DASHBOARD_MODULES: ReadonlyArray<DashboardModule> = [
  'overview',
  'sessions',
  'workflows',
  'groups',
  'schedules',
  'settings',
];

/** Build the localised `not_implemented_yet` text for a given module. */
export function buildStubText(module: DashboardModule, locale: Locale): string {
  return t(`card.dashboard.${module}.not_implemented_yet`, undefined, locale);
}

/** Build the localised help text. */
export function buildHelpText(
  locale: Locale,
  opts: { unknownModule?: string } = {},
): string {
  if (opts.unknownModule) {
    return t('card.dashboard.help.unknown_module', { module: opts.unknownModule }, locale)
      + '\n\n' + t('card.dashboard.help.body', undefined, locale);
  }
  return t('card.dashboard.help.body', undefined, locale);
}
