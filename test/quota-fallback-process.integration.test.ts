import { type ChildProcessWithoutNullStreams } from 'node:child_process';
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
import { spawnTsScript, tsRunnerPrefix } from './helpers/ts-runner.js';

const CLI_PATH = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
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

function runCli(args: string[], env: NodeJS.ProcessEnv): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawnTsScript(CLI_PATH, args, {
      cwd: process.cwd(),
      env: { ...process.env, ...env, BOTMUX_WORKFLOW: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    }) as ChildProcessWithoutNullStreams;
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', status => resolve({ status, stdout, stderr }));
  });
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
  it('start rejects a cyclic topology before creating fleet state or daemon processes', async () => {
    const home = tmp();
    const configDir = join(home, '.botmux');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, 'bots.json'), JSON.stringify(cyclicBots()));

    const result = await runCli(['start'], {
      HOME: home,
      SESSION_DATA_DIR: join(configDir, 'data'),
      BOTS_CONFIG: join(configDir, 'bots.json'),
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('daemon start 前自检失败');
    expect(result.stderr).toContain('cli_cyclea → cli_cycleb → cli_cyclea');
    expect(result.stderr).toContain('Dashboard → Bot 配置 → 高级 → 额度耗尽交接');
    expect(result.stderr).toContain('未创建新的 daemon 进程');
    expect(existsSync(join(configDir, 'fleet-state.json'))).toBe(false);
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
