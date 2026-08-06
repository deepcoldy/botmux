import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const script = join(repoRoot, 'scripts', 'publish-npm-if-missing.mjs');
const scratchDirectories: string[] = [];

afterEach(() => {
  for (const dir of scratchDirectories.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'publish-if-missing-test-'));
  scratchDirectories.push(root);
  const packageDir = join(root, 'package');
  const binDir = join(root, 'bin');
  const logPath = join(root, 'npm-calls.ndjson');
  mkdirSync(packageDir);
  mkdirSync(binDir);
  writeFileSync(join(packageDir, 'package.json'), JSON.stringify({
    name: 'test-idempotent-package',
    version: '1.2.3',
  }));
  const fakeNpm = join(binDir, 'npm');
  writeFileSync(fakeNpm, `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_NPM_LOG, JSON.stringify(args) + '\\n');
if (args[0] === 'pack') {
  const destination = args[args.indexOf('--pack-destination') + 1];
  const filename = 'test-idempotent-package-1.2.3.tgz';
  fs.writeFileSync(path.join(destination, filename), 'tarball');
  console.log(JSON.stringify([{
    filename,
    integrity: process.env.LOCAL_INTEGRITY
  }], null, 2));
} else if (args[0] === 'view') {
  if (process.env.LOOKUP_RESULT === '404') {
    console.error('npm error code E404');
    process.exit(1);
  }
  if (process.env.LOOKUP_RESULT === 'error') {
    console.error('npm error code E500');
    process.exit(1);
  }
  console.log(JSON.stringify(process.env.LOOKUP_RESULT));
} else if (args[0] === 'publish') {
  console.log('+ test-idempotent-package@1.2.3');
} else {
  console.error('unexpected npm command: ' + args.join(' '));
  process.exit(2);
}
`);
  chmodSync(fakeNpm, 0o755);
  return { binDir, logPath, packageDir };
}

function runFixture(lookupResult: string) {
  const test = fixture();
  const result = spawnSync(
    process.execPath,
    [script, test.packageDir, 'canary'],
    {
      cwd: repoRoot,
      encoding: 'utf-8',
      env: {
        ...process.env,
        PATH: `${test.binDir}:${process.env.PATH ?? ''}`,
        FAKE_NPM_LOG: test.logPath,
        LOCAL_INTEGRITY: 'sha512-local',
        LOOKUP_RESULT: lookupResult,
      },
    },
  );
  const calls = readFileSync(test.logPath, 'utf-8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as string[]);
  return { calls, result };
}

describe('publish-npm-if-missing', () => {
  it('publishes a missing version', () => {
    const { calls, result } = runFixture('404');
    expect(result.status).toBe(0);
    expect(calls.map((args) => args[0])).toEqual(['pack', 'view', 'publish']);
    expect(calls[2]).toContain('canary');
  });

  it('skips an existing version with identical integrity', () => {
    const { calls, result } = runFixture('sha512-local');
    expect(result.status).toBe(0);
    expect(calls.map((args) => args[0])).toEqual(['pack', 'view']);
    expect(result.stdout).toContain('already published with matching integrity');
  });

  it('fails closed when an existing version has different content', () => {
    const { calls, result } = runFixture('sha512-other');
    expect(result.status).not.toBe(0);
    expect(calls.map((args) => args[0])).toEqual(['pack', 'view']);
    expect(result.stderr).toContain('already exists with different content');
  });

  it('does not publish when the registry lookup fails unexpectedly', () => {
    const { calls, result } = runFixture('error');
    expect(result.status).not.toBe(0);
    expect(calls.map((args) => args[0])).toEqual(['pack', 'view']);
    expect(result.stderr).toContain('unable to determine whether');
  });
});
