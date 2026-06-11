import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CLI_PATH = join(__dirname, '..', 'dist', 'cli.js');

let home: string;

beforeAll(() => {
  if (!existsSync(CLI_PATH)) {
    throw new Error('dist/cli.js missing — run `pnpm build` first');
  }
  home = mkdtempSync(join(tmpdir(), 'botmux-worker-budget-cli-'));
  mkdirSync(join(home, '.botmux'), { recursive: true });
});

afterAll(() => {
  if (home) rmSync(home, { recursive: true, force: true });
});

function runCli(args: string[]): { status: number; stdout: string; stderr: string } {
  const r = spawnSync('node', [CLI_PATH, ...args], {
    cwd: home,
    env: { ...process.env, HOME: home, USERPROFILE: home },
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf-8',
  });
  return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function readConfig(): any {
  return JSON.parse(readFileSync(join(home, '.botmux', 'config.json'), 'utf-8'));
}

describe('botmux worker-budget CLI', () => {
  it('shows the auto-derived budget and the agent-safe edit command', () => {
    const out = runCli(['worker-budget', 'status']);

    expect(out.status).toBe(0);
    expect(out.stdout).toContain('Worker budget');
    expect(out.stdout).toContain('maxLiveWorkers');
    expect(out.stdout).toContain('botmux worker-budget set');
  });

  it('sets and unsets worker budget config without manual JSON editing', () => {
    const set = runCli(['worker-budget', 'set', '--max-live-workers', '12', '--idle-minutes', '45']);
    expect(set.status).toBe(0);
    expect(readConfig().worker).toEqual({
      maxLiveWorkers: 12,
      idleSuspendMs: 45 * 60_000,
    });

    const unset = runCli(['worker-budget', 'unset']);
    expect(unset.status).toBe(0);
    expect(readConfig().worker).toBeUndefined();
  });

  it('sets and validates idle suspend mode', () => {
    const set = runCli(['worker-budget', 'set', '--idle-suspend-mode', 'always']);
    expect(set.status).toBe(0);
    expect(readConfig().worker).toEqual({ idleSuspendMode: 'always' });
    expect(set.stdout).toContain('idleSuspendMode: always (config)');

    const status = runCli(['worker-budget', 'status']);
    expect(status.status).toBe(0);
    expect(status.stdout).toContain('idleSuspendMode: always (config)');

    const bad = runCli(['worker-budget', 'set', '--idle-suspend-mode', 'sometimes']);
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain('--idle-suspend-mode must be "budget" or "always"');

    const unset = runCli(['worker-budget', 'unset']);
    expect(unset.status).toBe(0);
    expect(readConfig().worker).toBeUndefined();
  });
});
