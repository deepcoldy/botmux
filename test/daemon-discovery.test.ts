import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { config } from '../src/config.js';
import {
  findOnlineDaemon,
  findOnlineDaemonByRef,
  listOnlineDaemons,
  listOnlinePlatformDaemons,
} from '../src/utils/daemon-discovery.js';

describe('daemon discovery', () => {
  let dir: string;
  let priorDataDir: string | undefined;

  beforeEach(() => {
    priorDataDir = process.env.SESSION_DATA_DIR;
    dir = join(tmpdir(), `botmux-daemon-discovery-${process.pid}-${Date.now()}`);
    mkdirSync(join(dir, 'dashboard-daemons'), { recursive: true });
    config.session.dataDir = dir;
  });

  afterEach(() => {
    if (priorDataDir === undefined) delete process.env.SESSION_DATA_DIR;
    else process.env.SESSION_DATA_DIR = priorDataDir;
    rmSync(dir, { recursive: true, force: true });
  });

  it('normalizes legacy descriptors as lark while keeping friendly bot labels', () => {
    writeFileSync(join(dir, 'dashboard-daemons', 'cli_agent.json'), JSON.stringify({
      larkAppId: 'cli_agent',
      ipcPort: 7956,
      botName: 'codex-loopy',
      cliId: 'codex',
      pid: 123,
      lastHeartbeat: Date.now(),
    }));

    expect(listOnlinePlatformDaemons()).toEqual([expect.objectContaining({
      platform: 'lark',
      instanceId: 'cli_agent',
      larkAppId: 'cli_agent',
      ipcPort: 7956,
      botName: 'codex-loopy',
      cliId: 'codex',
    })]);
    expect(listOnlineDaemons()).toEqual([expect.objectContaining({ larkAppId: 'cli_agent' })]);
    expect(findOnlineDaemon('cli_agent')?.ipcPort).toBe(7956);
  });

  it('prefers explicit generic identity fields and exposes capabilities', () => {
    writeFileSync(join(dir, 'dashboard-daemons', 'generic.json'), JSON.stringify({
      platform: 'discord',
      instanceId: 'workspace-bot',
      larkAppId: 'legacy-compat-id',
      capabilities: { cards: false, reactions: true },
      ipcPort: 7957,
      lastHeartbeat: Date.now(),
    }));

    expect(listOnlinePlatformDaemons()).toEqual([expect.objectContaining({
      platform: 'discord',
      instanceId: 'workspace-bot',
      larkAppId: 'legacy-compat-id',
      capabilities: { cards: false, reactions: true },
    })]);
    expect(listOnlineDaemons()).toEqual([]);
    expect(findOnlineDaemonByRef({ platform: 'discord', instanceId: 'workspace-bot' })?.ipcPort).toBe(7957);
    // The legacy lookup remains specifically Lark-scoped.
    expect(findOnlineDaemon('legacy-compat-id')).toBeNull();
  });

  it('keeps same-named instances on different platforms distinct', () => {
    const common = { instanceId: 'shared', lastHeartbeat: Date.now() };
    writeFileSync(join(dir, 'dashboard-daemons', 'lark.json'), JSON.stringify({
      ...common, platform: 'lark', larkAppId: 'shared', ipcPort: 7958,
    }));
    writeFileSync(join(dir, 'dashboard-daemons', 'discord.json'), JSON.stringify({
      ...common, platform: 'discord', larkAppId: 'discord-compat', ipcPort: 7959,
    }));

    expect(listOnlineDaemons()).toHaveLength(1);
    expect(listOnlinePlatformDaemons()).toHaveLength(2);
    expect(findOnlineDaemonByRef({ platform: 'lark', instanceId: 'shared' })?.ipcPort).toBe(7958);
    expect(findOnlineDaemonByRef({ platform: 'discord', instanceId: 'shared' })?.ipcPort).toBe(7959);
    expect(findOnlineDaemon('shared')?.ipcPort).toBe(7958);
  });

  it('skips malformed and incomplete descriptor records', () => {
    const descriptorDir = join(dir, 'dashboard-daemons');
    writeFileSync(join(descriptorDir, 'bad-json.json'), '{');
    writeFileSync(join(descriptorDir, 'bad-platform.json'), JSON.stringify({
      platform: ' ', instanceId: 'bot', ipcPort: 7960, lastHeartbeat: Date.now(),
    }));
    writeFileSync(join(descriptorDir, 'missing-identity.json'), JSON.stringify({
      ipcPort: 7961, lastHeartbeat: Date.now(),
    }));
    writeFileSync(join(descriptorDir, 'bad-capabilities.json'), JSON.stringify({
      platform: 'lark', instanceId: 'bot', capabilities: { cards: 'yes' },
      ipcPort: 7962, lastHeartbeat: Date.now(),
    }));
    writeFileSync(join(descriptorDir, 'bad-port.json'), JSON.stringify({
      larkAppId: 'bot', ipcPort: 0, lastHeartbeat: Date.now(),
    }));

    expect(listOnlineDaemons()).toEqual([]);
  });
});
