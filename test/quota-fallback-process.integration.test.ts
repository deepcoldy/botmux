import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { FleetSupervisor, type FleetBotSpec } from '../src/core/fleet-supervisor.js';
import { readFleetState } from '../src/core/fleet-state-store.js';
import { resolveFleetBotsFromEntries } from '../src/core/fleet-runtime.js';
import { spawnTsScript, tsRunnerPrefix } from './helpers/ts-runner.js';

const SUPERVISOR_PATH = fileURLToPath(new URL('../src/index-supervisor.ts', import.meta.url));
const DAEMON_HOST = fileURLToPath(new URL('./fixtures/quota-fallback-daemon-host.ts', import.meta.url));
const dirs: string[] = [];

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'quota-fallback-process-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(fn: () => boolean, timeoutMs = 8_000): Promise<boolean> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (fn()) return true;
    await delay(50);
  }
  return fn();
}

function cyclicBots() {
  return [
    {
      larkAppId: 'cli_cyclea',
      larkAppSecret: 'secret-a',
      quotaFallbackBot: { enabled: true, targetAppId: 'cli_cycleb' },
    },
    {
      larkAppId: 'cli_cycleb',
      larkAppSecret: 'secret-b',
      quotaFallbackBot: { enabled: true, targetAppId: 'cli_cyclea' },
    },
    {
      larkAppId: 'cli_safebot',
      larkAppSecret: 'secret-safe',
      quotaFallbackBot: { enabled: true, targetAppId: 'cli_cyclea' },
    },
  ];
}

describe('quota fallback process boundaries', () => {
  it('projects only non-cyclic bot daemons into the startup fleet', () => {
    expect(resolveFleetBotsFromEntries(cyclicBots()).map(bot => bot.appId)).toEqual(['cli_safebot']);
  });

  it('supervisor cold boot brings up the dashboard while skipping cyclic bot daemons', async () => {
    const home = tmp();
    const configDir = join(home, '.botmux');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, 'bots.json'), JSON.stringify(cyclicBots().slice(0, 2)));

    const child = spawnTsScript(SUPERVISOR_PATH, [], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: home,
        SESSION_DATA_DIR: join(configDir, 'data'),
        BOTS_CONFIG: join(configDir, 'bots.json'),
        BOTMUX_WORKFLOW: '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    try {
      const statePath = join(configDir, 'fleet-state.json');
      const dashboardOnline = await waitFor(() => {
        if (!existsSync(statePath)) return false;
        const state = JSON.parse(readFileSync(statePath, 'utf8'));
        return state.procs.length === 1
          && state.procs[0].name === 'botmux-dashboard'
          && state.procs[0].status === 'online';
      });
      expect(dashboardOnline).toBe(true);
      const state = JSON.parse(readFileSync(statePath, 'utf8'));
      expect(state.procs.map((proc: any) => proc.name)).toEqual(['botmux-dashboard']);
      expect(state.procs[0].status).toBe('online');
    } finally {
      child.kill('SIGTERM');
      await new Promise<void>(resolve => child.once('close', () => resolve()));
    }
  });

  it('supervisor respawn reloads the same soft-degraded daemon config while unrelated bots stay online', async () => {
    const root = tmp();
    const configPath = join(root, 'bots.json');
    const observationDir = join(root, 'observations');
    const logDir = join(root, 'logs');
    const statePath = join(root, 'fleet.json');
    mkdirSync(observationDir);
    writeFileSync(configPath, JSON.stringify(cyclicBots()));

    const { command, prefixArgs } = tsRunnerPrefix();
    const specs: FleetBotSpec[] = cyclicBots().map((bot, index) => ({
      name: `botmux-${index}`,
      appId: bot.larkAppId,
      botIndex: index,
      logBaseName: `daemon-${index}`,
      external: {
        command,
        args: [...prefixArgs, DAEMON_HOST, String(index), observationDir, ...(index === 0 ? ['crash-once'] : [])],
      },
    }));
    const supervisor = new FleetSupervisor({
      statePath,
      distDir: join(root, 'unused-dist'),
      daemonEnv: { ...process.env, BOTS_CONFIG: configPath },
      cwd: process.cwd(),
      logDir,
      policy: { maxRestarts: 5, restartDelayMs: 50 },
      killTimeoutMs: 500,
      log: () => {},
    });

    try {
      supervisor.start(specs);
      const recovered = await waitFor(() => {
        const state = readFleetState(statePath);
        const observations = join(observationDir, 'bot-0.ndjson');
        return state?.procs.every(proc => proc.status === 'online') === true
          && (state.procs.find(proc => proc.name === 'botmux-0')?.restarts ?? 0) >= 1
          && existsSync(observations)
          && readFileSync(observations, 'utf8').trim().split('\n').length >= 2;
      });
      expect(recovered).toBe(true);

      const observed = [0, 1, 2].map(index => readFileSync(join(observationDir, `bot-${index}.ndjson`), 'utf8')
        .trim().split('\n').map(line => JSON.parse(line)));
      expect(observed[0]).toHaveLength(2);
      expect(observed[0].every(row => row.appId === 'cli_cyclea' && row.quotaFallbackBot === null)).toBe(true);
      expect(observed[1][0]).toMatchObject({ appId: 'cli_cycleb', quotaFallbackBot: null });
      expect(observed[2][0]).toMatchObject({
        appId: 'cli_safebot',
        quotaFallbackBot: { enabled: true, targetAppId: 'cli_cyclea' },
      });
      expect(readFileSync(join(logDir, 'daemon-0-err.log'), 'utf8'))
        .toContain('quotaFallbackBot cycle disabled for affected bots');
    } finally {
      await supervisor.stopAll();
    }
  });
});
