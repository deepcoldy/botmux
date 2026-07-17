const ROUTE_RENDER_EXPORTS = [
  'renderPluginPage',
  'renderV3RunsPage',
  'renderGroupsPage',
  'renderSettingsPage',
  'renderBotDefaultsPage',
  'renderSkillsPage',
  'renderConnectorsLogsPage',
  'renderConnectorsPage',
  'renderTeamManagePage',
  'renderTeamFederationPage',
  'renderRoleProfilesPage',
  'renderRolesPage',
  'renderSchedulesPage',
  'renderWhiteboardsPage',
  'renderMonitoringPage',
  'renderSessionsPage',
  'renderMonitorRoomPage',
  'renderOfficePage',
  'renderInsightsPage',
  'renderOverviewPage',
] as const;

export function isDashboardChunkJsPath(pathname: string): boolean {
  return /^\/?chunks\/[^/\\]+\.js$/.test(pathname);
}

export function missingDashboardChunkModule(): string {
  const exports = ROUTE_RENDER_EXPORTS
    .map(name => `export const ${name} = renderReloadingDashboard;`)
    .join('\n');
  return `
const reloadKeyPrefix = 'botmux.dashboard.missing-chunk-reload.v1:';
function reloadDashboardOnce() {
  let shouldReload = true;
  try {
    const key = reloadKeyPrefix + String(import.meta.url || location.href).slice(-240);
    shouldReload = sessionStorage.getItem(key) !== '1';
    if (shouldReload) sessionStorage.setItem(key, '1');
  } catch {
    shouldReload = false;
  }
  if (shouldReload) location.reload();
  return shouldReload;
}
function renderReloadingDashboard(root) {
  if (root) {
    root.innerHTML = '<section class="page"><div class="empty">Dashboard updated, reloading...</div></section>';
  }
  reloadDashboardOnce();
  return () => {};
}
reloadDashboardOnce();
${exports}
`;
}
