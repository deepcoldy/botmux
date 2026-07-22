/** Linux integration fixture: reach an in-flight goal journal and then let the
 * parent SIGKILL this driver. The recovery invocation must reuse the immutable
 * request and dispatch attempt 002, never overwrite attempt 001. */

import { EventEmitter } from 'node:events';
import { writeFileSync } from 'node:fs';

import type { BotConfig } from '../../src/bot-registry.js';
import { cmdGoal, type GoalCliDependencies } from '../../src/workflows/v3/goal-cli.js';
import { readAndValidateManifest } from '../../src/workflows/v3/manifest.js';
import type { RunNode } from '../../src/workflows/v3/contract.js';

const [baseDir, runId, readyPath] = process.argv.slice(2);
if (!baseDir || !runId || !readyPath) throw new Error('expected baseDir runId readyPath');

const bot: BotConfig = {
  larkAppId: 'cli_goal_test',
  larkAppSecret: 'test-secret',
  name: 'goal-test',
  cliId: 'codex',
  workingDir: '/tmp',
};
const runNode: RunNode = async () => {
  writeFileSync(readyPath, 'ready\n');
  await new Promise(() => {});
  throw new Error('unreachable');
};
const signals = new EventEmitter();

await cmdGoal('run', [
  'write a report', '--run-id', runId, '--base-dir', baseDir, '--json',
], {
  loadBots: () => [bot],
  makeRunNode: () => runNode,
  validateManifest: async () => ({ ok: false, problems: ['not reached'] }),
  readValidatedManifest: readAndValidateManifest,
  signalEmitter: signals as unknown as GoalCliDependencies['signalEmitter'],
});
