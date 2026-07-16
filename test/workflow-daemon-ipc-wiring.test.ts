import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  WORKFLOW_DAEMON_IPC_HEADERS,
  workflowDaemonIpcHeaders,
} from '../src/workflows/v3/daemon-ipc-auth.js';

const daemonSource = readFileSync(new URL('../src/daemon.ts', import.meta.url), 'utf8');
const dashboardSource = readFileSync(new URL('../src/dashboard.ts', import.meta.url), 'utf8');

function sourceBetween(source: string, begin: string, end: string): string {
  const start = source.indexOf(begin);
  const finish = source.indexOf(end, start + begin.length);
  if (start < 0 || finish < 0) {
    throw new Error(`source boundary not found: ${begin} .. ${end}`);
  }
  return source.slice(start, finish);
}

describe('Workflow v3 daemon IPC wiring', () => {
  it('registers all four mutations only through the authenticated route seam', () => {
    expect(daemonSource).toContain('`${WORKFLOW_DAEMON_IPC_ROUTE_PREFIX}/:runId/${mutation}`');
    for (const mutation of ['start', 'cancel', 'retry', 'grant'] as const) {
      expect(daemonSource.match(new RegExp(`workflowDaemonMutationRoute\\('${mutation}'`, 'g')))
        .toHaveLength(1);

      // A literal ipcRoute for one of these paths would bypass the shared
      // authenticate-before-runId seam. The generic route inside
      // workflowDaemonMutationRoute uses a template expression and is allowed.
      expect(daemonSource).not.toMatch(new RegExp(
        `ipcRoute\\(\\s*['\"]POST['\"]\\s*,\\s*['\"]\\/api\\/v3\\/runs\\/:runId\\/${mutation}['\"]`,
      ));
    }
  });

  it('dashboard v3 cancel proxy selects the full-envelope Workflow protocol', () => {
    const proxySource = sourceBetween(
      dashboardSource,
      'async function proxyToDaemon(',
      '/** Create a Feishu group',
    );

    // Keep cancel in the authenticated mutation classifier and bind the
    // signature to the exact request bytes plus the target daemon boot.
    expect(proxySource).toContain('WORKFLOW_DAEMON_IPC_ROUTE_PREFIX');
    expect(proxySource).toContain('(?:start|cancel|retry|grant)');
    expect(proxySource).toContain('workflowDaemonIpcHeaders({');
    expect(proxySource).toContain("d.workflowIpcProtocol !== 'v1'");
    expect(proxySource).toContain('pathWithQuery: daemonPath');
    expect(proxySource).toContain('bodyRaw,');
    expect(proxySource).toContain('larkAppId: d.larkAppId');
    expect(proxySource).toContain('ipcPort: d.ipcPort');
    expect(proxySource).toContain('bootInstanceId: d.bootInstanceId');

    const headers = workflowDaemonIpcHeaders({
      secret: 'test-only-dashboard-secret',
      method: 'POST',
      pathWithQuery: '/__workflow-ipc/v1/runs/run-1/cancel',
      bodyRaw: '{"reason":"dashboard"}',
      target: {
        larkAppId: 'cli_owner',
        ipcPort: 7892,
        bootInstanceId: 'C'.repeat(43),
      },
      timestamp: '1783728000000',
      nonce: 'D'.repeat(43),
    });
    expect(Object.keys(headers).map((key) => key.toLowerCase()).sort()).toEqual([
      WORKFLOW_DAEMON_IPC_HEADERS.nonce,
      WORKFLOW_DAEMON_IPC_HEADERS.signature,
      WORKFLOW_DAEMON_IPC_HEADERS.timestamp,
    ].sort());
    expect(headers).not.toHaveProperty('X-Botmux-Cli-Auth');
  });

  it('resolves the daemon descriptor directory from the shared data-dir seam', () => {
    expect(daemonSource).toContain("join(resolveBotmuxDataDir(), 'dashboard-daemons')");
    expect(dashboardSource).toContain("join(resolveBotmuxDataDir(), 'dashboard-daemons')");
  });
});
