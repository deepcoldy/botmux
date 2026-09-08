#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { parseNpmPackJson } from './parse-npm-pack-json.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packageArg = process.argv[2];
const distTag = process.argv[3];

if (!packageArg || !distTag) {
  throw new Error(
    'usage: node scripts/publish-npm-if-missing.mjs <package-directory> <dist-tag>',
  );
}
if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(distTag)) {
  throw new Error(`invalid npm dist-tag: ${distTag}`);
}

const packageDir = resolve(repoRoot, packageArg);
const packageJson = JSON.parse(
  await readFile(join(packageDir, 'package.json'), 'utf-8'),
);
if (
  typeof packageJson.name !== 'string'
  || packageJson.name.length === 0
  || typeof packageJson.version !== 'string'
  || packageJson.version.length === 0
) {
  throw new Error(`package name/version missing in ${packageDir}/package.json`);
}

const spec = `${packageJson.name}@${packageJson.version}`;
const registry = 'https://registry.npmjs.org/';
const scratch = await mkdtemp(join(tmpdir(), 'botmux-npm-publish-'));
const npmEnv = { ...process.env, npm_config_dry_run: 'false' };

try {
  const pack = runNpm([
    'pack',
    packageDir,
    '--pack-destination',
    scratch,
    '--json',
  ]);
  const packed = parseNpmPackJson(pack.stdout)[0];
  if (
    !packed
    || typeof packed.filename !== 'string'
    || typeof packed.integrity !== 'string'
  ) {
    throw new Error(`npm pack returned no filename/integrity:\n${pack.stdout}`);
  }
  const tarball = join(scratch, packed.filename);

  const lookup = runNpm([
    'view',
    spec,
    'dist.integrity',
    '--json',
    '--registry',
    registry,
  ], true);
  if (lookup.status === 0) {
    const publishedIntegrity = parseJsonValue(lookup.stdout, `npm view ${spec}`);
    if (publishedIntegrity !== packed.integrity) {
      throw new Error(
        `${spec} already exists with different content `
        + `(registry=${String(publishedIntegrity)}, local=${packed.integrity})`,
      );
    }
    console.log(`[release] ${spec} already published with matching integrity; skipping`);
    process.exitCode = 0;
  } else if (isNotFound(lookup)) {
    runNpm([
      'publish',
      tarball,
      '--tag',
      distTag,
      '--registry',
      registry,
    ]);
    console.log(`[release] published ${spec} with dist-tag ${distTag}`);
  } else {
    throw new Error(
      `unable to determine whether ${spec} exists:\n${lookup.stderr || lookup.stdout}`,
    );
  }
} finally {
  await rm(scratch, { recursive: true, force: true });
}

function runNpm(args, allowFailure = false) {
  const result = spawnSync('npm', args, {
    cwd: repoRoot,
    encoding: 'utf-8',
    env: npmEnv,
    stdio: 'pipe',
  });
  if (result.status !== 0 && !allowFailure) {
    process.stderr.write(result.stdout);
    process.stderr.write(result.stderr);
    throw new Error(`npm ${args.join(' ')} failed with exit ${String(result.status)}`);
  }
  return result;
}

function parseJsonValue(stdout, label) {
  try {
    return JSON.parse(stdout.trim());
  } catch (error) {
    throw new Error(
      `${label} returned invalid JSON: ${
        error instanceof Error ? error.message : String(error)
      }\n${stdout}`,
    );
  }
}

function isNotFound(result) {
  const output = `${result.stdout}\n${result.stderr}`;
  return /\bE404\b/.test(output) || /\b404 Not Found\b/i.test(output);
}
