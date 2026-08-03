/** Subprocess fixture for the `--json` stdout contract. */

import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { BotConfig } from '../../src/bot-registry.js';
import { cmdGoal } from '../../src/workflows/v3/goal-cli.js';
import {
  readAndValidateManifest,
  ManifestValidationError,
} from '../../src/workflows/v3/manifest.js';
import { GOAL_ENV, type RunNode, type ValidateManifest } from '../../src/workflows/v3/contract.js';

const [baseDir, runId] = process.argv.slice(2);
if (!baseDir || !runId) throw new Error('expected baseDir runId');

const bot: BotConfig = {
  larkAppId: 'cli_goal_test',
  larkAppSecret: 'test-secret',
  name: 'goal-test',
  cliId: 'codex',
  workingDir: '/tmp',
};
const runNode: RunNode = async (req) => {
  const content = 'wire product';
  writeFileSync(join(req.outputDir, 'result.txt'), content);
  const manifestPath = req.env[GOAL_ENV.MANIFEST_PATH]!;
  writeFileSync(manifestPath, `${JSON.stringify({
    schemaVersion: 1,
    status: 'ok',
    summary: 'wire complete',
    files: [{
      name: 'result',
      path: 'result.txt',
      kind: 'text',
      bytes: Buffer.byteLength(content),
      sha256: createHash('sha256').update(content).digest('hex'),
      mime: 'text/plain',
    }],
  })}\n`);
  return { status: 'ok', manifestPath };
};
const validateManifest: ValidateManifest = async (manifestPath, outputDir) => {
  try {
    return { ok: true, manifest: await readAndValidateManifest(manifestPath, outputDir) };
  } catch (error) {
    return {
      ok: false,
      problems: error instanceof ManifestValidationError ? error.problems : [String(error)],
    };
  }
};

process.exitCode = await cmdGoal('run', [
  'write a report', '--run-id', runId, '--base-dir', baseDir, '--json',
], {
  loadBots: () => [bot],
  makeRunNode: () => runNode,
  validateManifest,
  readValidatedManifest: readAndValidateManifest,
});
