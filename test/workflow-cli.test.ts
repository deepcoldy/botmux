import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  mkdirSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const CLI_PATH = join(__dirname, '..', 'dist', 'cli.js');
const HELLO_DEF = {
  workflowId: 'cli-hello',
  version: 1,
  params: { name: { type: 'string', required: true } },
  nodes: {
    greet: { type: 'subagent', bot: 'b', prompt: 'hi {{params.name}}' },
    confirm: {
      type: 'subagent',
      bot: 'b',
      prompt: 'echo it',
      depends: ['greet'],
      humanGate: { stage: 'before', prompt: 'ok?' },
    },
  },
};

let tempDir: string;
let runsDir: string;
let oldCwd: string;
const env = { ...process.env };

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'wf-cli-'));
  runsDir = join(tempDir, 'runs');
  // Repo-root style workflow lookup expects ./workflows/<id>.workflow.json
  const wfDir = join(tempDir, 'workflows');
  mkdirSync(wfDir, { recursive: true });
  writeFileSync(
    join(wfDir, 'cli-hello.workflow.json'),
    JSON.stringify(HELLO_DEF),
    'utf-8',
  );
  oldCwd = process.cwd();
  process.chdir(tempDir);
});

afterEach(() => {
  process.chdir(oldCwd);
  rmSync(tempDir, { recursive: true, force: true });
});

function runCli(args: string[]): { stdout: string; status: number } {
  try {
    const stdout = execFileSync('node', [CLI_PATH, ...args], {
      env: { ...env, BOTMUX_WORKFLOW_RUNS_DIR: runsDir },
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf-8',
    });
    return { stdout, status: 0 };
  } catch (err) {
    return {
      stdout: ((err as { stdout?: string; stderr?: string }).stdout ?? '') +
        ((err as { stderr?: string }).stderr ?? ''),
      status: (err as { status?: number }).status ?? 1,
    };
  }
}

describe('botmux workflow CLI', () => {
  it('run <id> drives loop to awaiting-wait and creates events/run dir', () => {
    const out = runCli(['workflow', 'run', 'cli-hello', '--param', 'name=Tester']);
    expect(out.status).toBe(0);
    expect(out.stdout).toContain('runCreated, runStarted');
    expect(out.stdout).toContain('loop stopped: awaiting-wait');
    expect(out.stdout).toMatch(/runId=cli-hello-/);
    // event log exists
    const lines = out.stdout.split('\n');
    const runIdLine = lines.find((l) => l.includes('runId='));
    const runId = runIdLine?.match(/runId=(\S+)/)?.[1];
    expect(runId).toBeDefined();
    expect(existsSync(join(runsDir, runId!, 'events.ndjson'))).toBe(true);
    expect(existsSync(join(runsDir, runId!, 'workflow.json'))).toBe(true);
  });

  it('run <id> with missing required param exits non-zero', () => {
    const out = runCli(['workflow', 'run', 'cli-hello']);
    expect(out.status).not.toBe(0);
    expect(out.stdout).toMatch(/缺少必填 param/);
  });

  it('run <unknown-id> exits non-zero with search-path hint', () => {
    const out = runCli(['workflow', 'run', 'does-not-exist', '--param', 'name=x']);
    expect(out.status).not.toBe(0);
    expect(out.stdout).toMatch(/not found/);
  });

  it('show <runId> prints replayed snapshot summary', () => {
    const runOut = runCli(['workflow', 'run', 'cli-hello', '--param', 'name=Show']);
    const runId = runOut.stdout.match(/runId=(\S+)/)?.[1];
    const showOut = runCli(['workflow', 'show', runId!]);
    expect(showOut.status).toBe(0);
    expect(showOut.stdout).toContain('"workflowId": "cli-hello"');
    expect(showOut.stdout).toContain('"status": "running"');
    expect(showOut.stdout).toContain('danglingWaits');
  });

  it('cancel <runId> cancels an awaiting humanGate run', () => {
    const runOut = runCli(['workflow', 'run', 'cli-hello', '--param', 'name=Cancel']);
    expect(runOut.status).toBe(0);
    const runId = runOut.stdout.match(/runId=(\S+)/)?.[1];
    expect(runId).toBeDefined();

    const cancelOut = runCli(['workflow', 'cancel', runId!, '--reason', 'stop-test']);
    expect(cancelOut.status).toBe(0);
    expect(cancelOut.stdout).toContain('run.status=cancelled');

    const raw = readFileSync(join(runsDir, runId!, 'events.ndjson'), 'utf-8');
    const types = raw
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line).type);
    expect(types).toContain('cancelRequested');
    expect(types).toContain('activityCanceled');
    expect(types).toContain('nodeCanceled');
    expect(types).toContain('runCanceled');

    const showOut = runCli(['workflow', 'show', runId!]);
    expect(showOut.status).toBe(0);
    expect(showOut.stdout).toContain('"status": "cancelled"');

    const cancelAgain = runCli(['workflow', 'cancel', runId!, '--reason', 'already-done']);
    expect(cancelAgain.status).toBe(0);
    expect(cancelAgain.stdout).toContain('terminal');
    expect(readFileSync(join(runsDir, runId!, 'events.ndjson'), 'utf-8')).toBe(raw);
  });

  it('validate <path> accepts workflow json files', () => {
    const out = runCli(['workflow', 'validate', join(tempDir, 'workflows', 'cli-hello.workflow.json')]);
    expect(out.status).toBe(0);
    expect(out.stdout).toContain('workflow valid: cli-hello');
    expect(out.stdout).toContain('nodes=2');
  });

  it('validate <path> reports zod issue paths', () => {
    const invalidPath = join(tempDir, 'workflows', 'invalid.workflow.json');
    writeFileSync(
      invalidPath,
      JSON.stringify({
        workflowId: 'invalid',
        version: 1,
        nodes: {
          only: { type: 'subagent', prompt: 'missing bot' },
        },
      }),
      'utf-8',
    );

    const out = runCli(['workflow', 'validate', invalidPath]);
    expect(out.status).not.toBe(0);
    expect(out.stdout).toContain('workflow invalid');
    expect(out.stdout).toContain('nodes.only.bot');
  });
});
