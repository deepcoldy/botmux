import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CLI_PATH = join(__dirname, '..', 'dist', 'cli.js');

beforeAll(() => {
  if (!existsSync(CLI_PATH)) {
    throw new Error(`dist/cli.js missing — run bun run build first`);
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
    ['grant', 'chat', '--bot', 'receiver', '--chat-id', 'oc_chat', '--subject-open-id', 'ou_peer'],
    ['restart'],
    ['setup', 'list'],
    ['preset', 'export'],
    ['whiteboard', 'status'],
    ['vc-agent', 'join'],
    ['actor', 'current', '--json'],
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

  it('allows the botmux-owned Plugin MCP gateway bootstrap in workflow mode', async () => {
    const home = mkdtempSync(join(tmpdir(), 'workflow-c0-mcp-'));
    const child = spawn('node', [CLI_PATH, 'mcp', 'serve'], {
      env: { ...process.env, HOME: home, SESSION_DATA_DIR: join(home, 'data'),
        BOTMUX_WORKFLOW: '1', BOTMUX_MCP_GATEWAY: '1',
        BOTMUX_SESSION_ID: undefined, BOTMUX_MCP_GATEWAY_SOCKET: undefined,
        BOTMUX_MCP_GATEWAY_REQUIRED: undefined },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    const exited = new Promise<number | null>((resolveExit, reject) => {
      child.once('error', reject);
      child.once('close', resolveExit);
    });
    // A launch error can precede initialization; keep its exit rejection owned
    // while the handshake is the active wait.
    void exited.catch(() => undefined);
    const initialized = new Promise<any>((resolveInit, reject) => {
      let pending = '';
      child.stdout.on('data', chunk => {
        pending += chunk;
        let end: number;
        while ((end = pending.indexOf('\n')) >= 0) {
          const line = pending.slice(0, end); pending = pending.slice(end + 1);
          if (!line.trim()) continue;
          try {
            const response = JSON.parse(line);
            if (response.id === 1) resolveInit(response);
          } catch (error) { reject(error); }
        }
      });
      child.once('error', reject);
      child.once('close', () => reject(new Error(`gateway exited before initialize: ${stderr}`)));
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`gateway bootstrap/EOF timed out: ${stderr}`)), 25_000);
    });
    try {
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
        protocolVersion: '2024-11-05', capabilities: {},
        clientInfo: { name: 'workflow-isolation-test', version: '1' },
      } }) + '\n');
      // Readiness is a real protocol response. The old 3s wall included the
      // complete CLI import and occasionally cut it off on a busy runner.
      const response = await Promise.race([initialized, deadline]);
      expect(response.error).toBeUndefined();
      expect(response.result.protocolVersion).toBe('2024-11-05');
      expect(response.result.capabilities).toBeDefined();
      child.stdin.end(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
      expect(await Promise.race([exited, deadline])).toBe(0);
      expect(stderr).not.toMatch(/refused inside workflow/);
    } finally {
      if (timer) clearTimeout(timer);
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await exited.catch(() => undefined);
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

  // botmux installs local Claude-family hook clients into
  // ~/.claude/settings.json — session-ready (SessionStart), hook (generic),
  // user-prompt-hook (UserPromptSubmit) and __claude-compaction-v1 (PreCompact).
  // They fire from inside a workflow subagent's own CLI, so all must be on the
  // read-only allowlist; user-prompt-hook in particular fires on EVERY prompt,
  // and if the fence rejects it Claude reports the whole prompt "blocked by
  // hook" and `/goal` never lands (Bug 4). A refused PreCompact hook exits 2,
  // which blocks compaction.
  it.each([
    ['session-ready'],
    ['hook'],
    ['user-prompt-hook'],
    ['__claude-compaction-v1'],
  ])('botmux %s (botmux-installed hook client) is allowed in workflow mode', (cmd) => {
    const out = runCli([cmd], { BOTMUX_WORKFLOW: '1' });
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
