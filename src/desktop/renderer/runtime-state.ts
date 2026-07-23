import type { DesktopRuntimeState, RuntimeSource, RuntimeStatus } from '../shared/types.js';

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
  if (state.status === 'not_configured') return state.message ?? t('empty.notConfigured');
  if (state.status === 'stopped') return t('empty.stopped');
  if (state.status === 'degraded') return state.message ?? t('empty.degraded');
  return t('empty.dashboardMissing');
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
    (candidate.message === undefined || typeof candidate.message === 'string')
  );
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}
