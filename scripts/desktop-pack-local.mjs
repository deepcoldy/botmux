#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function normalizeVersion(value) {
  const trimmed = String(value ?? '').trim().replace(/^v/, '');
  return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(trimmed) ? trimmed : null;
}

function resolveAppVersion() {
  const envVersion = normalizeVersion(process.env.BOTMUX_DESKTOP_VERSION);
  if (envVersion && envVersion !== '0.0.0') return envVersion;

  try {
    const pkg = JSON.parse(readFileSync(resolve(rootDir, 'package.json'), 'utf8'));
    const packageVersion = normalizeVersion(pkg.version);
    if (packageVersion && packageVersion !== '0.0.0') return packageVersion;
  } catch {
    // Fall through to git tags or the local fallback.
  }

  try {
    const tag = execFileSync('git', ['describe', '--tags', '--abbrev=0'], {
      cwd: rootDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const tagVersion = normalizeVersion(tag);
    if (tagVersion && tagVersion !== '0.0.0') return tagVersion;
  } catch {
    // Source archives without .git still need a concrete macOS bundle version.
  }

  return '0.0.1-local';
}

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: rootDir,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const appVersion = resolveAppVersion();

run('pnpm', ['build']);
run('pnpm', ['desktop:bundle']);
run('pnpm', [
  'exec',
  'electron-builder',
  '--mac',
  'dmg',
  'zip',
  '--config',
  'electron-builder.yml',
  `-c.extraMetadata.version=${appVersion}`,
]);
