import { describe, expect, it } from 'bun:test';

import {
  canonicalDashboardClientShellUrl,
  dashboardClientShellRedirect,
  dashboardShellAllowsWebTerminal,
  isWebTerminalDashboardHash,
  isWorkflowDashboardHash,
  readDashboardClientShell,
} from '../../src/dashboard/web/client-shell.js';

describe('dashboard client shell', () => {
  it('reads the durable query-string shell marker', () => {
    expect(readDashboardClientShell('?botmuxClientShell=desktop', '#/settings'))
      .toBe('desktop');
    expect(readDashboardClientShell('?botmuxClientShell=mobile', '#/sessions'))
      .toBe('mobile');
  });

  it('accepts the hash marker only as a compatibility fallback', () => {
    expect(readDashboardClientShell('', '#/sessions?botmuxClientShell=mobile'))
      .toBe('mobile');
    expect(readDashboardClientShell('?botmuxClientShell=unknown', '#/'))
      .toBeNull();
  });

  it('canonicalizes a legacy hash marker into the durable URL query', () => {
    expect(canonicalDashboardClientShellUrl(
      'https://botmux.example.test/#/sessions?botmuxClientShell=desktop&focus=ask-1',
    )).toBe(
      'https://botmux.example.test/?botmuxClientShell=desktop#/sessions?focus=ask-1',
    );
    expect(canonicalDashboardClientShellUrl(
      'https://botmux.example.test/?locale=zh#/sessions?botmuxClientShell=desktop&focus=ask-1',
    )).toBe(
      'https://botmux.example.test/?locale=zh&botmuxClientShell=desktop#/sessions?focus=ask-1',
    );
    expect(canonicalDashboardClientShellUrl(
      'https://botmux.example.test/?botmuxClientShell=mobile#/sessions',
    )).toBeNull();
    expect(canonicalDashboardClientShellUrl(
      'https://botmux.example.test/#/sessions?botmuxClientShell=unknown',
    )).toBeNull();
  });

  it('recognizes every legacy and current workflow route', () => {
    for (const hash of [
      '#/workflows',
      '#/workflows/run-1',
      '#/workflows-catalog',
      '#/v3',
      '#/v3/run-1',
      '#/legacy-workflow',
      '#/legacy-workflow/run-1',
    ]) {
      expect(isWorkflowDashboardHash(hash), hash).toBe(true);
    }
    expect(isWorkflowDashboardHash('#/sessions')).toBe(false);
    expect(isWorkflowDashboardHash('#/settings?tab=runtime')).toBe(false);
  });

  it('recognizes Monitor Room as a web-terminal surface', () => {
    expect(isWebTerminalDashboardHash('#/monitor-room')).toBe(true);
    expect(isWebTerminalDashboardHash('#/monitor-room/session-1?focus=1')).toBe(true);
    expect(isWebTerminalDashboardHash('#/sessions')).toBe(false);
  });

  it('disables web terminals for both embedded client shells', () => {
    expect(dashboardShellAllowsWebTerminal('', '#/sessions')).toBe(true);
    expect(dashboardShellAllowsWebTerminal('?botmuxClientShell=desktop', '#/sessions')).toBe(false);
    expect(dashboardShellAllowsWebTerminal('?botmuxClientShell=mobile', '#/sessions')).toBe(false);
    expect(dashboardShellAllowsWebTerminal('', '#/sessions?botmuxClientShell=desktop')).toBe(false);
  });

  it('redirects unsupported embedded routes before they can render', () => {
    expect(dashboardClientShellRedirect(
      '#/monitor-room',
      '?botmuxClientShell=desktop',
    )).toBe('#/sessions');
    expect(dashboardClientShellRedirect(
      '#/workflows/run-1',
      '?botmuxClientShell=mobile',
    )).toBe('#/');
    expect(dashboardClientShellRedirect(
      '#/sessions',
      '?botmuxClientShell=desktop',
    )).toBeNull();
    expect(dashboardClientShellRedirect('#/monitor-room', '')).toBeNull();
  });
});
