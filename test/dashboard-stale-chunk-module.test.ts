import { describe, expect, it } from 'vitest';
import { isDashboardChunkJsPath, missingDashboardChunkModule } from '../src/dashboard/stale-chunk-module.js';

describe('dashboard missing stale chunk module', () => {
  it('matches only dashboard chunk JavaScript paths', () => {
    expect(isDashboardChunkJsPath('/chunks/sessions-page-OAWWD743.js')).toBe(true);
    expect(isDashboardChunkJsPath('chunks/sessions-page-OAWWD743.js')).toBe(true);

    expect(isDashboardChunkJsPath('/app.js')).toBe(false);
    expect(isDashboardChunkJsPath('/chunks/sessions-page-OAWWD743.css')).toBe(false);
    expect(isDashboardChunkJsPath('/chunks/nested/sessions-page-OAWWD743.js')).toBe(false);
  });

  it('returns an ESM route shim that reloads once instead of rejecting dynamic import', () => {
    const source = missingDashboardChunkModule();

    expect(source).toContain("botmux.dashboard.missing-chunk-reload.v1:");
    expect(source).toContain('sessionStorage.getItem');
    expect(source).toContain('location.reload()');
    expect(source).toContain('export const renderSessionsPage = renderReloadingDashboard;');
    expect(source).toContain('export const renderOverviewPage = renderReloadingDashboard;');
  });
});
