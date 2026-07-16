import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const CLI_PATH = join(__dirname, '..', 'dist', 'cli.js');
let tempDir: string;
let runsDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'wf-cli-retired-'));
  runsDir = join(tempDir, 'workflow-runs');
});

afterEach(() => rmSync(tempDir, { recursive: true, force: true }));

function runCli(args: string[]): { output: string; status: number } {
  try {
    const stdout = execFileSync('node', [CLI_PATH, ...args], {
      cwd: tempDir,
      env: { ...process.env, BOTMUX_WORKFLOW_RUNS_DIR: runsDir },
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf-8',
    });
    return { output: stdout, status: 0 };
  } catch (error) {
    const result = error as { stdout?: string; stderr?: string; status?: number };
    return {
      output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
      status: result.status ?? 1,
    };
  }
}

describe('retired v2 workflow CLI tombstones', () => {
  for (const command of ['run', 'resume', 'cancel', 'ls', 'tail', 'validate', 'show']) {
    it(`template ${command} fails loud without touching run storage`, () => {
      const result = runCli(['template', command, 'legacy-id']);
      expect(result.status).not.toBe(0);
      expect(result.output).toContain('v2 workflow runtime 已下线');
      expect(result.output).toContain('botmux template migrate-v3');
      expect(existsSync(runsDir)).toBe(false);
    });
  }

  it('old workflow aliases fail through the same tombstone', () => {
    const result = runCli(['workflow', 'resume', 'legacy-run']);
    expect(result.status).not.toBe(0);
    expect(result.output).toContain('v2 workflow runtime 已下线');
    expect(existsSync(runsDir)).toBe(false);
  });

  it('template help exposes only offline migration/archive operations', () => {
    const result = runCli(['template', 'help']);
    expect(result.status).toBe(0);
    expect(result.output).toContain('migrate-v3');
    expect(result.output).toContain('archive-runs');
    expect(result.output).toContain('v2 run/resume/cancel/ls/tail/show/validate 已下线');
    expect(result.output).not.toContain('  run <id>');
  });
});
