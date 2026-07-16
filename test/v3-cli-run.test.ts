import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';

import { authorizeManualCliRun } from '../src/workflows/v3/cli-run.js';
import type { BotConfig } from '../src/bot-registry.js';
import type { V3Dag } from '../src/workflows/v3/dag.js';
import { loadAuthorizedV3Run } from '../src/workflows/v3/run-envelope.js';

const BOT: BotConfig = {
  larkAppId: 'cli_manual',
  larkAppSecret: 'not-persisted',
  cliId: 'claude-code',
  workingDir: '/tmp',
};

function dag(runId: string, goal: string): V3Dag {
  return {
    runId,
    nodes: [{ id: 'work', type: 'goal', goal, depends: [], inputs: [] }],
  };
}

async function waitUntil(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for child-process test condition');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function runTsChild(script: string): {
  exited: () => boolean;
  result: Promise<{ created: boolean; goal: string; authorizedAt: string }>;
} {
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  let didExit = false;
  child.stdout.setEncoding('utf-8');
  child.stderr.setEncoding('utf-8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const result = new Promise<{ created: boolean; goal: string; authorizedAt: string }>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => {
      didExit = true;
      if (code !== 0) {
        reject(new Error(`manual authorization child exited ${code}: ${stderr || stdout}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout.trim()) as { created: boolean; goal: string; authorizedAt: string });
      } catch (err) {
        reject(new Error(`manual authorization child returned invalid JSON: ${stdout}\n${stderr}\n${String(err)}`));
      }
    });
  });
  return { exited: () => didExit, result };
}

describe('v3 manual CLI authorization', () => {
  it('重复启动复用已冻结的 manual_cli envelope，不受新 DAG / bot 配置漂移影响', () => {
    const baseDir = mkdtempSync(join(tmpdir(), 'v3-cli-run-'));
    const runDir = join(baseDir, 'manual-idempotent');
    try {
      const first = authorizeManualCliRun({
        runDir,
        dag: dag('manual-idempotent', 'first approved goal'),
        bots: [BOT],
        now: new Date('2026-07-10T08:00:00.000Z'),
      });
      const second = authorizeManualCliRun({
        runDir,
        dag: dag('manual-idempotent', 'must not replace approved goal'),
        bots: [],
        now: new Date('2026-07-10T09:00:00.000Z'),
      });

      expect(first.publication.created).toBe(true);
      expect(second.publication.created).toBe(false);
      expect(second.envelope).toEqual(first.envelope);
      expect(second.dag.nodes[0]).toMatchObject({ goal: 'first approved goal' });
      expect(loadAuthorizedV3Run(runDir, { allowedSources: ['manual_cli'] }).dag.nodes[0])
        .toMatchObject({ goal: 'first approved goal' });
      expect(readFileSync(join(runDir, 'bots.snapshot.json'), 'utf-8')).not.toContain('not-persisted');
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it('并发 manual_cli 物化由 run.json 锁串行，输家复用赢家 artifact', { timeout: 20_000 }, async () => {
    const baseDir = mkdtempSync(join(tmpdir(), 'v3-cli-run-race-'));
    const runDir = join(baseDir, 'manual-race');
    try {
      // authorizeManualCliRun creates runDir before locking; create it once so
      // we can hold the same cross-process lock before either child enters.
      mkdirSync(runDir, { recursive: true });
      const lockPath = join(runDir, 'run.json.lock');
      writeFileSync(lockPath, String(process.pid));

      const cliRunUrl = pathToFileURL(join(process.cwd(), 'src/workflows/v3/cli-run.ts')).href;
      const goals = ['winner candidate A', 'winner candidate B'];
      const children = goals.map((goal, i) => {
        const readyPath = join(baseDir, `child-${i}.ready`);
        const inputDag = dag('manual-race', goal);
        return {
          readyPath,
          child: runTsChild(`
            import { writeFileSync } from 'node:fs';
            import { authorizeManualCliRun } from ${JSON.stringify(cliRunUrl)};
            writeFileSync(${JSON.stringify(readyPath)}, 'ready');
            const result = authorizeManualCliRun({
              runDir: ${JSON.stringify(runDir)},
              dag: ${JSON.stringify(inputDag)},
              bots: ${JSON.stringify([BOT])},
              now: new Date(${JSON.stringify(`2026-07-10T0${i + 8}:00:00.000Z`)}),
            });
            process.stdout.write(JSON.stringify({
              created: result.publication.created,
              goal: result.dag.nodes[0].goal,
              authorizedAt: result.envelope.authorization.authorizedAt,
            }));
          `),
        };
      });

      await waitUntil(() => children.every(({ readyPath }) => existsSync(readyPath)));
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(children.every(({ child }) => !child.exited())).toBe(true);
      expect(existsSync(join(runDir, 'run.json'))).toBe(false);

      unlinkSync(lockPath);
      const results = await Promise.all(children.map(({ child }) => child.result));
      expect(results.map((result) => result.created).sort()).toEqual([false, true]);
      expect(new Set(results.map((result) => result.goal)).size).toBe(1);
      expect(new Set(results.map((result) => result.authorizedAt)).size).toBe(1);

      const loaded = loadAuthorizedV3Run(runDir, { allowedSources: ['manual_cli'] });
      expect(loaded.dag.nodes[0]).toMatchObject({ goal: results[0]!.goal });
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });
});
