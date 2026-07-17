import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listOnlineDaemons } from '../src/utils/daemon-discovery.js';

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
