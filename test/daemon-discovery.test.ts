import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { config } from '../src/config.js';
import { listOnlineDaemons } from '../src/utils/daemon-discovery.js';

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

  it('keeps friendly bot labels from daemon descriptors', () => {
    writeFileSync(join(dir, 'dashboard-daemons', 'cli_agent.json'), JSON.stringify({
      larkAppId: 'cli_agent',
      ipcPort: 7956,
      botName: 'codex-loopy',
      cliId: 'codex',
      pid: 123,
      lastHeartbeat: Date.now(),
    }));

    expect(listOnlineDaemons()).toEqual([expect.objectContaining({
      larkAppId: 'cli_agent',
      ipcPort: 7956,
      botName: 'codex-loopy',
      cliId: 'codex',
    })]);
  });
});
