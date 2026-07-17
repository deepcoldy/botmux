import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

describe('desktop dashboard shell mode', () => {
  it('keeps duplicate dashboard chrome suppression inside the desktop app', () => {
    const rendererSource = readFileSync(
      fileURLToPath(new URL('../../src/desktop/renderer/app.ts', import.meta.url)),
      'utf-8',
    );

    // The desktop shell should not force browser dashboard code to grow a
    // desktop-only branch. Hide embedded chrome at the webview boundary instead.
    expect(rendererSource).toContain('const desktopShellInjectedCss');
    expect(rendererSource).toContain('.sidebar,');
    expect(rendererSource).toContain('.topbar');
    expect(rendererSource).toContain('.chrome-body');
    expect(rendererSource).toContain('grid-template-columns: minmax(0, 1fr) !important;');
    expect(rendererSource).toContain('grid-column: 1 / -1 !important;');
    expect(rendererSource).toContain('dashboardFrame.insertCSS(desktopShellInjectedCss)');
  });

  it('uses the embedded dashboard webview as the only dashboard surface', () => {
    const html = readFileSync(
      fileURLToPath(new URL('../../src/desktop/renderer/index.html', import.meta.url)),
      'utf-8',
    );
    const rendererSource = readFileSync(
      fileURLToPath(new URL('../../src/desktop/renderer/app.ts', import.meta.url)),
      'utf-8',
    );

    expect(html).toMatch(/<webview\b[\s\S]*\bid="dashboard-frame"/);
    expect(rendererSource).toContain('dom-ready');
    expect(rendererSource).toContain('did-finish-load');
  });

  it('opens add bot through a dashboard route action without importing dashboard internals', () => {
    const rendererSource = readFileSync(
      fileURLToPath(new URL('../../src/desktop/renderer/app.ts', import.meta.url)),
      'utf-8',
    );
    const dashboardSource = readFileSync(
      fileURLToPath(new URL('../../src/dashboard/web/app.tsx', import.meta.url)),
      'utf-8',
    );
    const onboardingSource = readFileSync(
      fileURLToPath(new URL('../../src/dashboard/web/bot-onboarding.tsx', import.meta.url)),
      'utf-8',
    );

    expect(rendererSource).toContain("#/?open=bot-onboarding");
    expect(rendererSource).toContain('openBotOnboarding');
    expect(rendererSource).not.toContain('openBotOnboardingDialog');
    expect(dashboardSource).toContain('consumeDesktopShellRouteAction');
    expect(dashboardSource).toContain("open !== 'bot-onboarding'");
    expect(dashboardSource).toContain("action.params.delete('open')");
    expect(onboardingSource).toContain('OPEN_BOT_ONBOARDING_EVENT');
    expect(onboardingSource).toContain('window.dispatchEvent(new Event(OPEN_BOT_ONBOARDING_EVENT))');
  });

  it('mirrors dashboard topbar actions hidden by the desktop shell', () => {
    const html = readFileSync(
      fileURLToPath(new URL('../../src/desktop/renderer/index.html', import.meta.url)),
      'utf-8',
    );
    const rendererSource = readFileSync(
      fileURLToPath(new URL('../../src/desktop/renderer/app.ts', import.meta.url)),
      'utf-8',
    );
    const dashboardSource = readFileSync(
      fileURLToPath(new URL('../../src/dashboard/web/app.tsx', import.meta.url)),
      'utf-8',
    );
    const sessionsSource = readFileSync(
      fileURLToPath(new URL('../../src/dashboard/web/sessions-page.tsx', import.meta.url)),
      'utf-8',
    );
    const createSessionEntrySource = readFileSync(
      fileURLToPath(new URL('../../src/dashboard/web/create-session-entry.ts', import.meta.url)),
      'utf-8',
    );

    // Dashboard topbar is hidden in the Electron webview, so Desktop must keep
    // the user-visible entry points that master moved into that topbar.
    expect(html).toContain('id="create-session-btn"');
    expect(html).toContain('id="docs-link"');
    expect(rendererSource).toContain("#/sessions?open=create-session");
    expect(rendererSource).toContain('openCreateSession');
    expect(dashboardSource).toContain('requestOpenCreateSession');
    expect(dashboardSource).toContain("open !== 'create-session'");
    expect(createSessionEntrySource).toContain("OPEN_CREATE_SESSION_EVENT = 'botmux:open-create-session'");
    expect(createSessionEntrySource).toContain('consumePendingCreateSession');
    expect(sessionsSource).toContain("from './create-session-entry.js'");
    expect(sessionsSource).toContain('window.addEventListener(OPEN_CREATE_SESSION_EVENT');
    expect(sessionsSource).not.toContain("const OPEN_CREATE_SESSION_EVENT = 'botmux:open-create-session'");
  });

  it('lets the embedded dashboard honor the desktop locale from hash params', () => {
    const appSource = readFileSync(
      fileURLToPath(new URL('../../src/dashboard/web/app.tsx', import.meta.url)),
      'utf-8',
    );

    expect(appSource).toContain('function readShellLocale');
    expect(appSource).toContain('location.hash.slice(queryIndex + 1)');
    expect(appSource).toContain('function applyShellLocaleFromHash');
    expect(appSource).toContain('if (!shellLocale || shellLocale === ui.locale) return false');
    expect(appSource).toContain('readShellLocale() ?? normalizeDashboardLocale(j.lang)');
    expect(appSource).toContain('if (!applyShellLocaleFromHash()) void route()');
  });
});
