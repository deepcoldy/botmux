import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { EventLog } from '../src/workflows/events/append.js';
import { parseWorkflowDefinition, type WorkflowDefinition } from '../src/workflows/definition.js';
import {
  loadWorkflowDefinition,
  readWorkflowDefinitionFromRunDir,
  snapshotWorkflowDefinition,
} from '../src/workflows/loader.js';
import { logger } from '../src/utils/logger.js';
import { getRunsDir, runDir } from '../src/workflows/runs-dir.js';
import { createRun, type BotResolver } from '../src/workflows/run-init.js';

let tempDir: string;
let oldCwd: string;
let oldHome: string | undefined;
let oldRunsDir: string | undefined;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'wf-loader-'));
  oldCwd = process.cwd();
  oldHome = process.env.HOME;
  oldRunsDir = process.env.BOTMUX_WORKFLOW_RUNS_DIR;
  process.chdir(tempDir);
  process.env.HOME = join(tempDir, 'home');
  delete process.env.BOTMUX_WORKFLOW_RUNS_DIR;
});

afterEach(() => {
  process.chdir(oldCwd);
  if (oldHome === undefined) delete process.env.HOME;
  else process.env.HOME = oldHome;
  if (oldRunsDir === undefined) delete process.env.BOTMUX_WORKFLOW_RUNS_DIR;
  else process.env.BOTMUX_WORKFLOW_RUNS_DIR = oldRunsDir;
  rmSync(tempDir, { recursive: true, force: true });
});

function workflowRaw(workflowId = 'wf-demo'): unknown {
  return {
    workflowId,
    version: 1,
    nodes: {
      a: { type: 'subagent', bot: 'codex-loopy', prompt: 'do a' },
    },
  };
}

function writeWorkflow(path: string, workflowId = 'wf-demo'): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify(workflowRaw(workflowId)), 'utf-8');
}

const resolver: BotResolver = () => ({ cliId: 'codex' });

describe('workflow loader', () => {
  it('loads from repository workflows directory first', async () => {
    const repoPath = join(tempDir, 'workflows', 'wf-demo.workflow.json');
    writeWorkflow(repoPath);

    const def = await loadWorkflowDefinition('wf-demo');

    expect(def.workflowId).toBe('wf-demo');
    expect(def.nodes.a?.type).toBe('subagent');
  });

  it('loads from ~/.botmux/workflows when repo path is absent', async () => {
    const userPath = join(process.env.HOME!, '.botmux', 'workflows', 'wf-user.workflow.json');
    writeWorkflow(userPath, 'wf-user');

    const def = await loadWorkflowDefinition('wf-user');

    expect(def.workflowId).toBe('wf-user');
  });

  it('missing workflow error lists both lookup paths', async () => {
    await expect(loadWorkflowDefinition('missing')).rejects.toThrow(
      new RegExp(
        [
          'Workflow .missing. not found',
          'workflows/missing\\.workflow\\.json',
          '\\.botmux/workflows/missing\\.workflow\\.json',
        ].join('.*'),
        's',
      ),
    );
  });

  it('readWorkflowDefinitionFromRunDir: missing file returns null silently (ENOENT)', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    try {
      const runDir = join(tempDir, 'runs', 'nonexistent-run');
      mkdirSync(runDir, { recursive: true });
      const def = await readWorkflowDefinitionFromRunDir(runDir);
      expect(def).toBeNull();
      // Missing snapshot is a normal state for legacy v0.1 runs that
      // predate the per-run workflow.json file — must NOT warn.
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('readWorkflowDefinitionFromRunDir: corrupt JSON returns null AND warns', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    try {
      const runDir = join(tempDir, 'runs', 'corrupt-run');
      mkdirSync(runDir, { recursive: true });
      // Garbage that will blow up at JSON.parse — exactly the kind of
      // unexpected failure that used to go silently null pre-fix.
      writeFileSync(join(runDir, 'workflow.json'), '{not-json}', 'utf-8');
      const def = await readWorkflowDefinitionFromRunDir(runDir);
      expect(def).toBeNull();
      expect(warnSpy).toHaveBeenCalledTimes(1);
      const msg = String(warnSpy.mock.calls[0]![0]);
      expect(msg).toContain('readWorkflowDefinitionFromRunDir');
      expect(msg).toContain('workflow.json');
      expect(msg).toContain('v0.1 wait semantics');
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('createRun snapshots workflow.json into the actual run directory', async () => {
    const runsDir = join(tempDir, 'runs');
    const runId = 'run-loader-test-01';
    const log = new EventLog(runId, runsDir);
    const def = parseWorkflowDefinition(workflowRaw()) as WorkflowDefinition;

    await createRun(log, {
      def,
      params: {},
      initiator: 'ou_user',
      botResolver: resolver,
    });

    const snapshotPath = join(log.runDir, 'workflow.json');
    expect(existsSync(snapshotPath)).toBe(true);
    expect(JSON.parse(readFileSync(snapshotPath, 'utf-8'))).toEqual(def);
  });
});

describe('runs-dir helper', () => {
  it('uses BOTMUX_WORKFLOW_RUNS_DIR when set', async () => {
    process.env.BOTMUX_WORKFLOW_RUNS_DIR = join(tempDir, 'custom-runs');
    expect(getRunsDir()).toBe(process.env.BOTMUX_WORKFLOW_RUNS_DIR);
    expect(runDir('run-1')).toBe(join(process.env.BOTMUX_WORKFLOW_RUNS_DIR!, 'run-1'));
    await snapshotWorkflowDefinition('run-1', parseWorkflowDefinition(workflowRaw()));
    expect(existsSync(join(process.env.BOTMUX_WORKFLOW_RUNS_DIR!, 'run-1', 'workflow.json'))).toBe(true);
  });
});
