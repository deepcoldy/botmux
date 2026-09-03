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

describe('workflow feature kill-switch (BOTMUX_WORKFLOW_ENABLED=false)', () => {
  function runCliWithWorkflow(args: string[], workflowEnabled: boolean): { output: string; status: number } {
    try {
      const stdout = execFileSync('node', [CLI_PATH, ...args], {
        cwd: tempDir,
        env: { ...process.env, BOTMUX_WORKFLOW_ENABLED: workflowEnabled ? 'true' : 'false' },
        stdio: ['ignore', 'pipe', 'pipe'],
        encoding: 'utf-8',
      });
      return { output: stdout, status: 0 };
    } catch (error) {
      const result = error as { stdout?: string; stderr?: string; status?: number };
      return { output: `${result.stdout ?? ''}${result.stderr ?? ''}`, status: result.status ?? 1 };
    }
  }

  const DISABLED = '已关闭「工作流(Workflow)」功能';

  it('refuses authoring host verbs when disabled', () => {
    const result = runCliWithWorkflow(['workflow', 'new', '调研三家竞品'], false);
    expect(result.status).toBe(2);
    expect(result.output).toContain(DISABLED);
  });

  it('refuses `v3 run` when disabled', () => {
    const result = runCliWithWorkflow(['v3', 'run', 'nonexistent-dag.json'], false);
    expect(result.status).toBe(2);
    expect(result.output).toContain(DISABLED);
  });

  it('refuses `goal run` when disabled (same v3 runtime as v3 run — P1)', () => {
    // `botmux goal run` reuses runWorkflow + ephemeral pool, so it is a real-run
    // launch and must be gated too. It emits a JSON/text result and exits with
    // the goal-run error code (14), not a silent pass-through.
    const result = runCliWithWorkflow(['goal', 'run', '调研三家竞品', '--json'], false);
    expect(result.status).toBe(14);
    expect(result.output).toContain('WORKFLOW_DISABLED');
    expect(result.output).toContain(DISABLED);
  });

  it('still allows read-only `workflow list` when disabled (not gated)', () => {
    const result = runCliWithWorkflow(['workflow', 'list'], false);
    // list must not be blocked by the kill-switch — it may fail for unrelated
    // reasons (no daemon/config) but must NEVER print the disabled notice.
    expect(result.output).not.toContain(DISABLED);
  });

  it('`workflow help` when disabled surfaces the kill-switch but still exits 0', () => {
    const result = runCliWithWorkflow(['workflow', 'help'], false);
    expect(result.status).toBe(0);
    // Help must not silently advertise a disabled feature (P2): it names the
    // switch and points at the still-available management verbs.
    expect(result.output).toContain(DISABLED);
    expect(result.output).toContain('cancel');
  });

  it('`workflow help` when enabled lists the full command surface (no notice)', () => {
    const result = runCliWithWorkflow(['workflow', 'help'], true);
    expect(result.status).toBe(0);
    expect(result.output).not.toContain(DISABLED);
    expect(result.output).toContain('Saved Workflow');
  });

  it('does NOT print the disabled notice for the same host verb when enabled', () => {
    // With the feature ON the gate is transparent; `new` proceeds past it (and
    // may fail later for other reasons) but never emits the kill-switch notice.
    const result = runCliWithWorkflow(['workflow', 'new', '调研三家竞品'], true);
    expect(result.output).not.toContain(DISABLED);
  });
});
