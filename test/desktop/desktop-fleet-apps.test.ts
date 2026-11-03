import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { listFleetApps } from '../../src/desktop/main/fleet-apps.js';

const homes: string[] = [];

function pathsWithHome() {
  const botmuxHome = mkdtempSync(join(tmpdir(), 'desktop-fleet-apps-'));
  homes.push(botmuxHome);
  return { botmuxHome, dataDir: join(botmuxHome, 'data'), logsDir: join(botmuxHome, 'logs') };
}

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

describe('desktop fleet app listing', () => {
  it('lists nothing before any fleet has been started', async () => {
    await expect(listFleetApps(pathsWithHome())).resolves.toEqual([]);
  });

  it('reads the supervisor record and marks dead pids stopped', async () => {
    const paths = pathsWithHome();
    writeFileSync(join(paths.botmuxHome, 'fleet-state.json'), JSON.stringify({
      supervisorEntry: '/runtime/dist/index-supervisor.js',
      procs: [
        { name: 'botmux-dashboard', appId: '', pid: process.pid, status: 'online' },
        { name: 'botmux-0', appId: 'cli_a', pid: 0, status: 'online' },
      ],
    }));
    expect(await listFleetApps(paths)).toEqual([
      { name: 'botmux-dashboard', status: 'online', script: '/runtime/dist/index-supervisor.js' },
      { name: 'botmux-0', status: 'stopped', script: '/runtime/dist/index-supervisor.js' },
    ]);
  });

  it('rejects a corrupt record so runtime state can degrade', async () => {
    const paths = pathsWithHome();
    writeFileSync(join(paths.botmuxHome, 'fleet-state.json'), '{}');
    await expect(listFleetApps(paths)).rejects.toThrow('Invalid fleet state');
  });
});
