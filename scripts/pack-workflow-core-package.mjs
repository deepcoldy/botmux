#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packageDir = join(repoRoot, 'packages', 'workflow-core');
const outputDir = join(packageDir, '.packs');

await rm(outputDir, { recursive: true, force: true });
await mkdir(outputDir, { recursive: true });

const result = spawnSync(
  'npm',
  ['pack', packageDir, '--pack-destination', outputDir, '--ignore-scripts', '--json'],
  { cwd: repoRoot, encoding: 'utf-8' },
);
if (result.status !== 0) {
  process.stderr.write(result.stdout);
  process.stderr.write(result.stderr);
  process.exit(result.status ?? 1);
}
const jsonStart = result.stdout.search(/^\[\s*$/m);
if (jsonStart < 0) throw new Error(`npm pack returned no JSON:\n${result.stdout}`);
const packed = JSON.parse(result.stdout.slice(jsonStart));
const filename = packed[0]?.filename;
if (!filename) throw new Error(`npm pack returned no filename: ${result.stdout}`);
console.log(resolve(outputDir, filename));
