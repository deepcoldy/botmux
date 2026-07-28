#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  collectCompiledRuntimeEntries,
  computeRuntimeBuildId,
} from '../dist/utils/runtime-build-id.js';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourceRoot = join(projectRoot, 'src');
const distRoot = join(projectRoot, 'dist');
const buildId = computeRuntimeBuildId(collectCompiledRuntimeEntries(sourceRoot, distRoot));
writeFileSync(join(distRoot, '.runtime-build-id'), `${buildId}\n`, 'utf8');
process.stdout.write(`runtime build id: ${buildId.slice(0, 12)}\n`);
