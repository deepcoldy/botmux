import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
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

  it.each([
    ['dispatch', '--bot', 'peer', 'task'],
    ['report', 'done'],
    ['restart'],
    ['setup', 'list'],
    ['preset', 'export'],
    ['whiteboard', 'status'],
    ['vc-agent', 'join'],
  ])('botmux %s is denied by the workflow root-command allowlist', (...args) => {
    const out = runCli(args, { BOTMUX_WORKFLOW: '1' });
    expect(out.status).toBe(2);
    expect(out.stderr).toMatch(/refused inside workflow/);
    expect(out.stderr).toMatch(/read-only allowlist/);
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

  it('allows the botmux-owned Plugin MCP gateway bootstrap in workflow mode', () => {
    const home = mkdtempSync(join(tmpdir(), 'workflow-c0-mcp-'));
    try {
      const out = spawnSync('node', [CLI_PATH, 'mcp', 'serve'], {
        env: {
          ...process.env,
          HOME: home,
          SESSION_DATA_DIR: join(home, 'data'),
          BOTMUX_WORKFLOW: '1',
          BOTMUX_MCP_GATEWAY: '1',
        },
        input: '',
        encoding: 'utf-8',
        timeout: 3_000,
      });
      expect(out.error).toBeUndefined();
      expect(out.status).toBe(0);
      expect(out.stderr).not.toMatch(/refused inside workflow/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('keeps every other or future mcp subcommand default-denied in workflow mode', () => {
    const out = runCli(['mcp', 'future-command'], { BOTMUX_WORKFLOW: '1' });
    expect(out.status).toBe(2);
    expect(out.stderr).toContain('botmux mcp future-command refused inside workflow');
    expect(out.stderr).toContain('Only the botmux-owned Plugin MCP gateway bootstrap');
  });

  it.each([
    'new',
    'spec-finalize',
    'approve-spec',
    'revise-spec',
    'architect',
    'revise-dag',
    'approve-dag',
    'save',
    'run',
    'start',
    'retry',
    'grant',
    'cancel',
  ])('botmux workflow %s refuses workflow mutations from a subagent', (sub) => {
    const out = runCli(['workflow', sub, 'target'], {
      BOTMUX_WORKFLOW: '1',
      BOTMUX_WORKFLOW_RUN_ID: 'run-parent',
      BOTMUX_WORKFLOW_NODE_ID: 'node-child',
    });
    expect(out.status).toBe(2);
    expect(out.stderr).toContain(`botmux workflow ${sub} refused inside workflow`);
    expect(out.stderr).toContain('host/user');
  });

  it.each([
    ['template', 'migrate-v3'],
    ['template', 'archive-runs'],
    ['v3', 'run'],
  ])('botmux %s %s refuses recursive/legacy workflow execution', (root, sub) => {
    const out = runCli([root, sub, 'target'], { BOTMUX_WORKFLOW: '1' });
    expect(out.status).toBe(2);
    expect(out.stderr).toContain(`botmux ${root} ${sub} refused inside workflow`);
  });

  it.each([
    ['workflow', 'resume'],
    ['template', 'run'],
    ['template', 'resume'],
    ['template', 'cancel'],
  ])('botmux %s %s stays a zero-I/O retirement tombstone inside workflow mode', (root, sub) => {
    const out = runCli([root, sub, 'target'], { BOTMUX_WORKFLOW: '1' });
    expect(out.status).toBe(1);
    expect(out.stderr).toContain('v2 workflow runtime 已下线');
    expect(out.stderr).not.toContain('refused inside workflow');
  });

  it.each([
    ['workflow', 'list'],
    ['workflow', 'show'],
    ['workflow', 'tail'],
    ['workflow', 'validate'],
  ])('botmux %s %s remains outside the mutation fence', (root, sub) => {
    const out = runCli([root, sub, 'target'], { BOTMUX_WORKFLOW: '1' });
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
