#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { parseNpmPackJson } from './parse-npm-pack-json.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packageDir = join(repoRoot, 'packages', 'workflow-core');
const packageRequire = createRequire(join(packageDir, 'package.json'));
const scratch = await mkdtemp(join(tmpdir(), 'botmux-workflow-core-'));
const npmSmokeEnv = { ...process.env, npm_config_dry_run: 'false' };

try {
  const tarball = packInto(scratch);
  await writeFile(
    join(scratch, 'package.json'),
    JSON.stringify({ name: 'workflow-core-smoke', private: true, type: 'module' }),
  );
  run('npm', [
    'install',
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    '--package-lock=false',
    tarball,
  ], scratch, false, npmSmokeEnv);

  const installedPackage = JSON.parse(
    await readFile(join(scratch, 'node_modules', 'botmux-workflow-core', 'package.json'), 'utf-8'),
  );
  if (Object.keys(installedPackage.dependencies ?? {}).length > 0) {
    throw new Error('workflow-core published package must not have runtime dependencies');
  }

  await writeFile(join(scratch, 'smoke.mjs'), `
import { validateDag } from 'botmux-workflow-core/schema';
import { decideNext } from 'botmux-workflow-core/engine';
import { matchLoopExitWhen } from 'botmux-workflow-core/control';
import { normalizeGateWaitInput, selectedResolution } from 'botmux-workflow-core/gate-policy';
import {
  MANIFEST_SCHEMA_VERSION,
  createInProcessAttemptLeaseProvider,
  readPortableWorkflowFinalOutputs,
  runPortableWorkflow,
  runWorkflow
} from 'botmux-workflow-core/runtime';

const dag = validateDag({
  runId: 'package-smoke',
  nodes: [
    { id: 'research', type: 'goal', goal: 'research', depends: [], inputs: [] },
    { id: 'deliver', type: 'goal', goal: 'deliver', depends: ['research'], inputs: [{ from: 'research' }] }
  ]
});
const actions = decideNext(dag, new Map());
if (actions.length !== 1 || actions[0].kind !== 'dispatchWork' || actions[0].nodeId !== 'research') {
  throw new Error('unexpected ESM scheduler result: ' + JSON.stringify(actions));
}
if (!matchLoopExitWhen({ gte: 2 }, 2)) {
  throw new Error('unexpected loop predicate result');
}
const gate = normalizeGateWaitInput({ prompt: 'ship?' });
if (selectedResolution(gate, 'approve') !== 'approved') {
  throw new Error('unexpected gate policy result');
}
if (
  MANIFEST_SCHEMA_VERSION !== 1 ||
  runWorkflow !== runPortableWorkflow ||
  typeof readPortableWorkflowFinalOutputs !== 'function' ||
  typeof createInProcessAttemptLeaseProvider !== 'function'
) {
  throw new Error('unexpected portable runtime exports');
}
`);
  run(process.execPath, ['smoke.mjs'], scratch);

  await writeFile(join(scratch, 'smoke.cjs'), `
const { validateDag } = require('botmux-workflow-core/schema');
const { decideNext } = require('botmux-workflow-core/engine');
const {
  createInProcessAttemptLeaseProvider,
  readPortableWorkflowFinalOutputs,
  runPortableWorkflow,
  runWorkflow
} = require('botmux-workflow-core/runtime');
const dag = validateDag({
  runId: 'package-smoke-cjs',
  nodes: [{ id: 'only', type: 'goal', goal: 'run', depends: [], inputs: [] }]
});
const actions = decideNext(dag, new Map());
if (actions.length !== 1 || actions[0].kind !== 'dispatchWork') {
  throw new Error('unexpected CJS scheduler result: ' + JSON.stringify(actions));
}
if (
  runWorkflow !== runPortableWorkflow ||
  typeof readPortableWorkflowFinalOutputs !== 'function' ||
  typeof createInProcessAttemptLeaseProvider !== 'function'
) {
  throw new Error('unexpected CJS portable runtime exports');
}
`);
  run(process.execPath, ['smoke.cjs'], scratch);

  await writeFile(join(scratch, 'consumer.ts'), `
import { decideNext, type V3Dag, type V3RunState } from 'botmux-workflow-core';
import { validateDag } from 'botmux-workflow-core/schema';
import {
  readPortableWorkflowFinalOutputs,
  runWorkflow,
  type AgentExecutor,
  type PortableWorkflowFinalOutput,
  type PortableWorkflowRuntimeOptions
} from 'botmux-workflow-core/runtime';
const dag: V3Dag = validateDag({
  runId: 'types-smoke',
  nodes: [{ id: 'only', type: 'goal', goal: 'run', depends: [], inputs: [] }]
});
const state: V3RunState = new Map();
void decideNext(dag, state);
const executeAgent: AgentExecutor = async () => ({
  status: 'cancelled',
  manifestPath: '',
});
const options: PortableWorkflowRuntimeOptions = { baseDir: '/tmp/workflow-core-types' };
const outputs: Promise<PortableWorkflowFinalOutput[]> =
  readPortableWorkflowFinalOutputs(dag, '/tmp/workflow-core-types/types-smoke', async () => ({
    ok: false,
    problems: ['type smoke only'],
  }));
void executeAgent;
void options;
void outputs;
void runWorkflow;
`);
  const tscPath = packageRequire.resolve('typescript/bin/tsc');
  run(process.execPath, [
    tscPath,
    '--noEmit',
    '--strict',
    '--skipLibCheck',
    '--target',
    'ES2022',
    '--module',
    'Node16',
    '--moduleResolution',
    'Node16',
    'consumer.ts',
  ], scratch);

  console.log('[workflow-core] npm tarball ESM/CJS/types smoke passed');
} finally {
  await rm(scratch, { recursive: true, force: true });
}

function packInto(destination) {
  const result = run('npm', [
    'pack',
    packageDir,
    '--pack-destination',
    destination,
    '--ignore-scripts',
    '--json',
  ], repoRoot, true, npmSmokeEnv);
  const parsed = parseNpmPackJson(result.stdout);
  const filename = parsed[0]?.filename;
  if (!filename) throw new Error(`npm pack returned no filename: ${result.stdout}`);
  return join(destination, filename);
}

function run(command, args, cwd, capture = false, env = process.env) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf-8',
    env,
    stdio: capture ? 'pipe' : 'inherit',
  });
  if (result.status !== 0) {
    if (capture) {
      process.stderr.write(result.stdout);
      process.stderr.write(result.stderr);
    }
    throw new Error(`${command} ${args.join(' ')} failed with exit ${result.status}`);
  }
  return result;
}
