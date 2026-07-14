import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const CLI_PATH = join(__dirname, '..', 'dist', 'cli.js');

beforeAll(() => {
  if (!existsSync(CLI_PATH)) {
    throw new Error(`dist/cli.js missing — run pnpm build first`);
  }
});

function runCli(
  args: string[],
  env: Record<string, string | undefined> = {},
): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync('node', [CLI_PATH, ...args], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf-8',
    });
    return { status: 0, stdout, stderr: '' };
  } catch (err) {
    return {
      status: (err as { status?: number }).status ?? 1,
      stdout: (err as { stdout?: string }).stdout ?? '',
      stderr: (err as { stderr?: string }).stderr ?? '',
    };
  }
}

describe('Slice C0 — chat side-effect isolation', () => {
  it('botmux send refuses when BOTMUX_WORKFLOW=1', () => {
    const out = runCli(['send', 'hello'], {
      BOTMUX_WORKFLOW: '1',
      BOTMUX_WORKFLOW_RUN_ID: 'run-x',
      BOTMUX_WORKFLOW_NODE_ID: 'step-1',
    });
    expect(out.status).toBe(2);
    expect(out.stderr).toContain('refused inside workflow');
    expect(out.stderr).toContain('run-x');
    expect(out.stderr).toContain('step-1');
    expect(out.stderr).toMatch(/hostExecutor/);
  });

  it('botmux create-group refuses when BOTMUX_WORKFLOW=1', () => {
    const out = runCli(['create-group', '--name', 'x'], {
      BOTMUX_WORKFLOW: '1',
    });
    expect(out.status).toBe(2);
    expect(out.stderr).toMatch(/refused inside workflow/);
  });

  it('botmux goal start refuses when BOTMUX_WORKFLOW=1', () => {
    const out = runCli(['goal', 'start', '--title', 'x', '--worker', 'bot'], {
      BOTMUX_WORKFLOW: '1',
    });
    expect(out.status).toBe(2);
    expect(out.stderr).toMatch(/botmux goal start refused inside workflow/);
  });

  it('botmux schedule add refuses when BOTMUX_WORKFLOW=1', () => {
    const out = runCli(['schedule', 'add', '@every', '1h', 'task'], {
      BOTMUX_WORKFLOW: '1',
    });
    expect(out.status).toBe(2);
    expect(out.stderr).toMatch(/refused inside workflow/);
  });

  it('botmux schedule list (read-only) is allowed in workflow mode', () => {
    const out = runCli(['schedule', 'list'], {
      BOTMUX_WORKFLOW: '1',
      BOTMUX_BIN: '0', // not started; expect graceful behavior, NOT the workflow refusal
    });
    // exit code may be non-zero (no schedules / no daemon), but should NOT
    // be the workflow-refusal sentinel error.
    expect(out.stderr).not.toMatch(/refused inside workflow/);
  });

  it('botmux history (read-only) is allowed in workflow mode', () => {
    const out = runCli(['history', '--limit', '5'], {
      BOTMUX_WORKFLOW: '1',
    });
    expect(out.stderr).not.toMatch(/refused inside workflow/);
  });

  it('outside workflow mode (BOTMUX_WORKFLOW unset), send proceeds to its own logic', () => {
    // Without BOTMUX_WORKFLOW=1 the gate doesn't trigger.  The command
    // will still fail (no session in this test env) but with the normal
    // session-lookup error, not the workflow refusal.
    const out = runCli(['send', 'hello'], { BOTMUX_WORKFLOW: undefined });
    expect(out.stderr).not.toMatch(/refused inside workflow/);
  });
});
