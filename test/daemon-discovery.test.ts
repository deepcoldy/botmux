import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  getLarkConnectionHealth,
  registerLarkConnectionHealth,
  type LarkConnectionHealth,
} from '../src/im/lark/transport/connection-health.js';
import { formatLarkConnectionStatus } from '../src/cli/lark-connection-status.js';
import {
  findOnlineDaemon,
  listOnlineDaemons,
  parseDaemonIpcPort,
  resolveDaemonIpcPort,
} from '../src/utils/daemon-discovery.js';

describe('daemon IPC port fallback', () => {
  it('prefers a discovered port and otherwise accepts a valid injected port', () => {
    expect(resolveDaemonIpcPort(4310, '9999')).toBe(4310);
    expect(resolveDaemonIpcPort(undefined, '9999')).toBe(9999);
  });

  it.each([undefined, '', '0', '-1', '65536', '12.5', 'not-a-port'])(
    'rejects invalid injected port %s',
    (raw) => {
      expect(parseDaemonIpcPort(raw)).toBeUndefined();
    },
  );
});

describe('daemon discovery', () => {
  let dir: string;
  let priorDataDir: string | undefined;
  let priorHome: string | undefined;

  beforeEach(() => {
    priorDataDir = process.env.SESSION_DATA_DIR;
    priorHome = process.env.HOME;
    dir = join(tmpdir(), `botmux-daemon-discovery-${process.pid}-${Date.now()}`);
    mkdirSync(join(dir, 'dashboard-daemons'), { recursive: true });
    process.env.SESSION_DATA_DIR = dir;
  });

  afterEach(() => {
    if (priorDataDir === undefined) delete process.env.SESSION_DATA_DIR;
    else process.env.SESSION_DATA_DIR = priorDataDir;
    if (priorHome === undefined) delete process.env.HOME;
    else process.env.HOME = priorHome;
    rmSync(dir, { recursive: true, force: true });
  });

  it('keeps friendly bot labels from daemon descriptors', () => {
    const bootInstanceId = 'A'.repeat(43);
    writeFileSync(join(dir, 'dashboard-daemons', 'cli_agent.json'), JSON.stringify({
      larkAppId: 'cli_agent',
      ipcPort: 7956,
      bootInstanceId,
      workflowIpcProtocol: 'v1',
      dispatchLaunchIpcProtocol: 'v1',
      botName: 'codex-loopy',
      cliId: 'codex',
      pid: 123,
      lastHeartbeat: Date.now(),
    }));

    expect(listOnlineDaemons()).toEqual([expect.objectContaining({
      larkAppId: 'cli_agent',
      ipcPort: 7956,
      bootInstanceId,
      workflowIpcProtocol: 'v1',
      dispatchLaunchIpcProtocol: 'v1',
      botName: 'codex-loopy',
      cliId: 'codex',
    })]);
  });

  it('does not invent a Workflow IPC boot identity for an old descriptor', () => {
    writeFileSync(join(dir, 'dashboard-daemons', 'legacy.json'), JSON.stringify({
      larkAppId: 'legacy',
      ipcPort: 7957,
      lastHeartbeat: Date.now(),
    }));

    expect(listOnlineDaemons()).toEqual([expect.objectContaining({
      larkAppId: 'legacy',
      ipcPort: 7957,
    })]);
    expect(listOnlineDaemons()[0]).not.toHaveProperty('bootInstanceId');
    expect(listOnlineDaemons()[0]).not.toHaveProperty('workflowIpcProtocol');
    expect(listOnlineDaemons()[0]).not.toHaveProperty('sessionStoreProtocol');
    expect(listOnlineDaemons()[0]).not.toHaveProperty('botmuxVersion');
    // An older daemon never claims to apply a workflow run's working dir.
    expect(listOnlineDaemons()[0]).not.toHaveProperty('workflowNodeWorkingDir');
  });

  it('reports transport state from the live PID and does not retain a retired client', () => {
    const connected: LarkConnectionHealth = { state: 'connected', since: 1000, attempts: 1, lastInboundAt: 2000 };
    const reconnecting: LarkConnectionHealth = { state: 'reconnecting', since: 3000, attempts: 3, lastInboundAt: 2000 };
    const closeOld = registerLarkConnectionHealth('ws-bot', () => connected);
    const closeNew = registerLarkConnectionHealth('ws-bot', () => reconnecting);
    try {
      closeOld();
      writeFileSync(join(dir, 'dashboard-daemons', 'ws.json'), JSON.stringify({
        larkAppId: 'ws-bot', ipcPort: 7000, pid: 21, lastHeartbeat: Date.now(),
        larkConnection: getLarkConnectionHealth('ws-bot'),
      }));
      const descriptor = listOnlineDaemons(dir)[0];
      expect(descriptor.larkConnection).toEqual(reconnecting);
      expect(formatLarkConnectionStatus({ pid: 21, alive: true }, descriptor)).toBe(
        'reconnecting since 1970-01-01T00:00:03.000Z attempts=3 last-inbound=1970-01-01T00:00:02.000Z',
      );
      expect(formatLarkConnectionStatus({ pid: 22, alive: true }, descriptor)).toBe('unknown');
      expect(formatLarkConnectionStatus({ pid: 21, alive: false }, descriptor)).toBe('offline');
    } finally {
      closeNew();
    }
    expect(getLarkConnectionHealth('ws-bot')).toBeUndefined();
  });

  it('distinguishes disabled connections from older or invalid descriptors', () => {
    for (const [app, larkConnection] of [
      ['api', null], ['legacy', undefined],
      ['bad', { state: 'connected', since: -1, attempts: 1, lastInboundAt: null }],
    ] as const) {
      writeFileSync(join(dir, 'dashboard-daemons', app + '.json'), JSON.stringify({
        larkAppId: app, ipcPort: 7000, pid: 21, lastHeartbeat: Date.now(), larkConnection,
      }));
    }
    const statusOf = (app: string) => formatLarkConnectionStatus({ alive: true, pid: 21 }, findOnlineDaemon(app, dir) ?? undefined);
    expect(statusOf('api')).toBe('disabled');
    expect(statusOf('legacy')).toBe('unknown');
    expect(statusOf('bad')).toBe('unknown');
  });

  it('passes through the workflow node working-dir capability only in its known form', () => {
    writeFileSync(join(dir, 'dashboard-daemons', 'wd.json'), JSON.stringify({
      larkAppId: 'wd', ipcPort: 7960, workflowNodeWorkingDir: 'v1', lastHeartbeat: Date.now(),
    }));
    writeFileSync(join(dir, 'dashboard-daemons', 'wd-odd.json'), JSON.stringify({
      larkAppId: 'wd-odd', ipcPort: 7961, workflowNodeWorkingDir: 'v2', lastHeartbeat: Date.now(),
    }));
    expect(findOnlineDaemon('wd')).toMatchObject({ workflowNodeWorkingDir: 'v1' });
    expect(findOnlineDaemon('wd-odd')).not.toHaveProperty('workflowNodeWorkingDir');
  });

  it('passes through the workflow node project-dir capability only in its known form; an older descriptor has none', () => {
    for (const [appId, value] of [['pd', 'v1'], ['pd-odd', 'v2'], ['pd-old', undefined]] as const) {
      writeFileSync(join(dir, 'dashboard-daemons', `${appId}.json`), JSON.stringify({
        larkAppId: appId, ipcPort: 7970, workflowNodeWorkingDir: 'v1', ...(value ? { workflowNodeProjectDir: value } : {}), lastHeartbeat: Date.now(),
      }));
    }
    expect(findOnlineDaemon('pd')).toMatchObject({ workflowNodeProjectDir: 'v1' });
    expect(findOnlineDaemon('pd-odd')).not.toHaveProperty('workflowNodeProjectDir');
    expect(findOnlineDaemon('pd-old')).not.toHaveProperty('workflowNodeProjectDir');
  });

  it('passes through sessionStoreProtocol and botmuxVersion without inventing them', () => {
    writeFileSync(join(dir, 'dashboard-daemons', 'new.json'), JSON.stringify({
      larkAppId: 'new',
      ipcPort: 7959,
      sessionStoreProtocol: 'occupancy-v1',
      botmuxVersion: '3.20.0',
      lastHeartbeat: Date.now(),
    }));

    expect(listOnlineDaemons()).toEqual([expect.objectContaining({
      larkAppId: 'new',
      ipcPort: 7959,
      sessionStoreProtocol: 'occupancy-v1',
      botmuxVersion: '3.20.0',
    })]);
  });

  it('follows the canonical data-dir breadcrumb when SESSION_DATA_DIR is absent', () => {
    const home = join(dir, 'home');
    mkdirSync(join(home, '.botmux'), { recursive: true });
    writeFileSync(join(home, '.botmux', '.data-dir'), dir);
    process.env.HOME = home;
    delete process.env.SESSION_DATA_DIR;

    writeFileSync(join(dir, 'dashboard-daemons', 'breadcrumb.json'), JSON.stringify({
      larkAppId: 'breadcrumb',
      ipcPort: 7958,
      bootInstanceId: 'B'.repeat(43),
      workflowIpcProtocol: 'v1',
      lastHeartbeat: Date.now(),
    }));

    expect(listOnlineDaemons()).toEqual([expect.objectContaining({
      larkAppId: 'breadcrumb',
      ipcPort: 7958,
      workflowIpcProtocol: 'v1',
    })]);
  });
});
