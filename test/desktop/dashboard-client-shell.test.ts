import { describe, expect, it } from 'vitest';

import {
  WORKBENCH_DOCK_IMMERSIVE_ENTRY,
  WORKBENCH_IMMERSIVE_ENTRY,
  WORKBENCH_IMMERSIVE_HASH,
  immersiveWorkbenchHash,
} from '../../src/core/workbench-shell.js';
import {
  canonicalDashboardClientShellUrl,
  dashboardClientShellRedirect,
  dashboardShellAllowsWebTerminal,
  isWebTerminalDashboardHash,
  isWorkflowDashboardHash,
  readDashboardClientShell,
  readDashboardWorkbenchShell,
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

describe('immersive workbench shell marker', () => {
  it('pins the shared entry constants the server redirects to', () => {
    expect(WORKBENCH_IMMERSIVE_HASH).toBe('#/agent-workbench?botmuxWorkbenchShell=immersive');
    expect(WORKBENCH_IMMERSIVE_ENTRY).toBe('/#/agent-workbench?botmuxWorkbenchShell=immersive');
    expect(WORKBENCH_DOCK_IMMERSIVE_ENTRY).toBe('/#/agent-workbench-dock?botmuxWorkbenchShell=immersive');
    expect(immersiveWorkbenchHash('#/agent-workbench/s%2F1'))
      .toBe('#/agent-workbench/s%2F1?botmuxWorkbenchShell=immersive');
  });

  it('reads the marker from the durable query and from the entry-time hash', () => {
    expect(readDashboardWorkbenchShell('?botmuxWorkbenchShell=immersive', '#/agent-workbench'))
      .toBe('immersive');
    expect(readDashboardWorkbenchShell('', '#/agent-workbench?botmuxWorkbenchShell=immersive'))
      .toBe('immersive');
    expect(readDashboardWorkbenchShell('', '#/agent-workbench')).toBeNull();
    expect(readDashboardWorkbenchShell('?botmuxWorkbenchShell=full', '#/agent-workbench')).toBeNull();
  });

  it('is not a client shell: navigation, terminals and redirects stay unrestricted', () => {
    expect(readDashboardClientShell('?botmuxWorkbenchShell=immersive', '#/agent-workbench')).toBeNull();
    expect(dashboardShellAllowsWebTerminal('?botmuxWorkbenchShell=immersive', '#/sessions')).toBe(true);
    expect(dashboardClientShellRedirect('#/workflows/run-1', '?botmuxWorkbenchShell=immersive')).toBeNull();
  });

  it('canonicalizes the hash marker into the durable query, alone or beside the client shell', () => {
    expect(canonicalDashboardClientShellUrl(
      'https://botmux.example.test/#/agent-workbench?botmuxWorkbenchShell=immersive',
    )).toBe(
      'https://botmux.example.test/?botmuxWorkbenchShell=immersive#/agent-workbench',
    );
    expect(canonicalDashboardClientShellUrl(
      'https://botmux.example.test/#/agent-workbench-dock?botmuxClientShell=desktop&botmuxWorkbenchShell=immersive',
    )).toBe(
      'https://botmux.example.test/?botmuxClientShell=desktop&botmuxWorkbenchShell=immersive#/agent-workbench-dock',
    );
    // 已经在查询串里的标记不重复搬运；hash 里没有任何可搬的标记时不改写。
    expect(canonicalDashboardClientShellUrl(
      'https://botmux.example.test/?botmuxWorkbenchShell=immersive#/agent-workbench/s%2F1',
    )).toBeNull();
    expect(canonicalDashboardClientShellUrl(
      'https://botmux.example.test/#/agent-workbench?botmuxWorkbenchShell=full',
    )).toBeNull();
  });
});
