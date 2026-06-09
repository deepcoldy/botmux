/**
 * `/dashboard <module>` stub replies (PR3 C1).
 *
 * The six visible modules (overview / sessions / workflows / groups /
 * schedules / settings) all return `not_implemented_yet` at C1; PR4-PR8
 * replace each in turn. `help` and `unknown_module` are handled by the
 * caller — this module only knows about the six concrete modules.
 *
 * v3 B7 / v4 B1: `settings` is also a stub here. C4 replaces the dispatch
 * arm for `settings` with the real `handleDashboardSettings`; the stub
 * implementation below stays available as a fallback during refactors.
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
