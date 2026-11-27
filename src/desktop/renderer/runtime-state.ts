import type {
  DesktopRuntimeState,
  RuntimeDegradedReason,
  RuntimeSource,
  RuntimeStatus,
} from '../shared/types.js';

export type RendererTranslator = (key: string, params?: Record<string, string | number>) => string;

const statusValues = new Set<RuntimeStatus>([
  'not_configured',
  'stopped',
  'starting',
  'running',
  'degraded',
]);

const runtimeSourceValues = new Set<RuntimeSource>([
  'bundled',
  'global-cli',
  'none',
]);

const degradedReasonValues = new Set<RuntimeDegradedReason>([
  'invalid_bots_json',
  'missing_runtime',
  'external_unmanaged',
  'fleet_discovery',
]);

export function buildRuntimeMeta(state: DesktopRuntimeState, t: RendererTranslator): string {
  // Routine CLI sources are already implied by the status and version line.
  // Keep this row available for exceptional sources that need explanation.
  switch (state.runtimeSource) {
    case 'bundled':
    case 'global-cli':
      return '';
    case 'none':
      return t('runtimeSource.none');
  }
}

export function buildVersionLine(state: DesktopRuntimeState): string {
  const runtimeVersion = state.runtimeVersion ?? 'unknown';
  return `App ${state.appVersion} / CLI ${runtimeVersion}`;
}

export function emptyDashboardMessage(state: DesktopRuntimeState, t: RendererTranslator): string {
  if (state.status === 'starting') return t('empty.starting');
  if (state.status === 'not_configured') return state.message ?? t('empty.notConfigured');
  if (state.status === 'stopped') return t('empty.stopped');
  if (state.status === 'degraded') return state.message ?? t('empty.degraded');
  return t('empty.dashboardMissing');
}

export interface ZeroBotOnboardingAutoOpenGate {
  alreadyOpened: boolean;
  userNavigated: boolean;
  hasLoadedDashboard: boolean;
}

/**
 * Auto-open `#/?open=bot-onboarding` at most once per 0-bot cold launch so a
 * brand-new user lands straight in the setup wizard, without hijacking navigation
 * if they close the dialog or click another page.
 */
export function shouldAutoOpenZeroBotOnboarding(
  state: DesktopRuntimeState,
  gate: ZeroBotOnboardingAutoOpenGate,
): boolean {
  return state.status === 'running'
    && state.botCount === 0
    && !gate.alreadyOpened
    && !gate.userNavigated
    && !gate.hasLoadedDashboard;
}

export type EmptyDashboardView =
  | { kind: 'bootstrapping'; titleKey: string; bodyKey: string }
  | { kind: 'onboarding_welcome'; titleKey: string; bodyKey: string; ctaKey: string }
  | { kind: 'config_error'; titleKey: string; bodyKey: string; detail: string; openFolderKey: string }
  | { kind: 'stopped'; titleKey: string; bodyKey: string; ctaKey: string }
  | { kind: 'degraded'; message: string }
  | { kind: 'unavailable'; message: string };

/** True when `state` represents a fail-closed invalid/corrupted `bots.json` file. */
export function isCorruptedBotConfigState(state: DesktopRuntimeState): boolean {
  return state.status === 'degraded' && state.degradedReason === 'invalid_bots_json';
}

export function classifyEmptyDashboardView(
  state: DesktopRuntimeState | null,
  opts: { bootstrappingZeroBot?: boolean; fallbackMessage?: string } = {},
): EmptyDashboardView {
  if (!state) {
    return { kind: 'unavailable', message: opts.fallbackMessage ?? '' };
  }
  if (isCorruptedBotConfigState(state)) {
    return {
      kind: 'config_error',
      titleKey: 'empty.configErrorTitle',
      bodyKey: 'empty.configErrorBody',
      detail: state.message ?? '',
      openFolderKey: 'action.openConfigDir',
    };
  }
  if (state.status === 'not_configured' && state.runtimeManaged) {
    if (opts.bootstrappingZeroBot) {
      return {
        kind: 'bootstrapping',
        titleKey: 'empty.bootstrappingTitle',
        bodyKey: 'empty.bootstrappingBody',
      };
    }
    return {
      kind: 'onboarding_welcome',
      titleKey: 'empty.welcomeTitle',
      bodyKey: 'empty.welcomeBody',
      ctaKey: 'action.startOnboarding',
    };
  }
  if (state.status === 'stopped' && state.runtimeManaged) {
    return {
      kind: 'stopped',
      titleKey: 'empty.stoppedTitle',
      bodyKey: 'empty.stopped',
      ctaKey: 'action.start',
    };
  }
  if (state.status === 'degraded') {
    return { kind: 'degraded', message: opts.fallbackMessage ?? state.message ?? '' };
  }
  return { kind: 'unavailable', message: opts.fallbackMessage ?? state.message ?? '' };
}

export function shouldKeepLoadedDashboardDuringDegradedState(state: DesktopRuntimeState): boolean {
  if (state.status !== 'degraded') return false;
  const message = (state.message ?? '').toLowerCase();
  // Incompatibility means the already-loaded dashboard may speak a different
  // shell protocol, so unload it. Transient PM2/discovery failures can keep the
  // visible webview while the sidebar explains the degraded state.
  return !message.includes('src/desktop/install-local.sh') && !message.includes('兼容') && !message.includes('protocol');
}

export function isRuntimeState(value: unknown): value is DesktopRuntimeState {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<DesktopRuntimeState>;
  // IPC payloads cross a trust boundary, so require the full shape before using
  // the object to drive controls or dashboard navigation.
  return (
    typeof candidate.status === 'string' &&
    statusValues.has(candidate.status as RuntimeStatus) &&
    typeof candidate.appVersion === 'string' &&
    isNullableString(candidate.runtimeVersion) &&
    typeof candidate.runtimeSource === 'string' &&
    runtimeSourceValues.has(candidate.runtimeSource as RuntimeSource) &&
    typeof candidate.runtimeManaged === 'boolean' &&
    isNullableString(candidate.runtimePath) &&
    typeof candidate.botCount === 'number' &&
    typeof candidate.onlineDaemonCount === 'number' &&
    typeof candidate.attentionCount === 'number' &&
    isNullableString(candidate.dashboardUrl) &&
    (candidate.degradedReason === undefined || (
      typeof candidate.degradedReason === 'string'
      && degradedReasonValues.has(candidate.degradedReason as RuntimeDegradedReason)
    )) &&
    (candidate.message === undefined || typeof candidate.message === 'string')
  );
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}
