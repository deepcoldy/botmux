import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSyncTsEval } from './helpers/ts-runner';
import { bunVersionWarning } from '../scripts/check-bun-version.mjs';

const REPO = resolve(__dirname, '..');
const SCRIPT = join(REPO, 'scripts', 'check-bun-version.mjs');

describe('bunVersionWarning', () => {
  it('stays silent when the local bun matches the pin', () => {
    expect(bunVersionWarning('1.4.3', '1.4.3')).toBeUndefined();
  });

  it('names the direction and the exact version to install', () => {
    const older = bunVersionWarning('1.4.3', '1.4.2');
    expect(older).toContain('1.4.2 旧于项目钉的 1.4.3');
    expect(older).toContain('bash -s "bun-v1.4.3"');
    expect(bunVersionWarning('1.4.3', '1.5.0')).toContain('1.5.0 新于项目钉的 1.4.3');
    expect(bunVersionWarning('1.4.3', '1.4.3-canary.1+abc')).toContain('不同于');
  });

  it('stays silent when either side is unparseable', () => {
    expect(bunVersionWarning(undefined, '1.4.3')).toBeUndefined();
    expect(bunVersionWarning('latest', '1.4.3')).toBeUndefined();
    expect(bunVersionWarning('1.4.3', '')).toBeUndefined();
  });
});

describe('check-bun-version.mjs as a script', () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

  /** Run a copy of the script against a scratch package.json. */
  function runWith(packageJson: string) {
    const root = mkdtempSync(join(tmpdir(), 'check-bun-version-'));
    dirs.push(root);
    mkdirSync(join(root, 'scripts'));
    copyFileSync(SCRIPT, join(root, 'scripts', 'check-bun-version.mjs'));
    writeFileSync(join(root, 'package.json'), packageJson);
    return spawnSync(process.execPath, [join(root, 'scripts', 'check-bun-version.mjs')], { encoding: 'utf-8' });
  }

  it('warns on drift but still exits 0 (soft — must never fail the build)', () => {
    const r = runWith(JSON.stringify({ packageManager: 'bun@0.0.1' }));
    expect(r.status).toBe(0);
    expect(r.stderr).toContain('新于项目钉的 0.0.1');
  });

  it('exits 0 silently when package.json is unreadable', () => {
    const r = runWith('{ not json');
    expect(r.status).toBe(0);
    expect(r.stderr).toBe('');
  });

  it('exits 0 silently when argv[1] names a missing path (self-exec guard stays soft)', () => {
    // The guard calls realpathSync(argv[1]); a stale or bogus argv[1] must not
    // escape the "never fail the caller" boundary when the module is merely imported.
    const code = `process.argv[1]=${JSON.stringify(join(tmpdir(), `nonexistent-check-bun-version-${Date.now()}`))}; await import(${JSON.stringify(pathToFileURL(SCRIPT).href)});`;
    const r = spawnSyncTsEval(code, { encoding: 'utf-8' });
    expect(r.status).toBe(0);
    expect(r.stderr).toBe('');
  });
});

describe('wiring', () => {
  it('`bun run build` runs the check first', () => {
    const pkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf-8'));
    expect(pkg.scripts.build).toMatch(/^bun scripts\/check-bun-version\.mjs && /);
  });

  it('the compile script checks too (CI and docs call it directly, not via `bun run build:bun`)', () => {
    const src = readFileSync(join(REPO, 'scripts', 'build-bun-binary.mjs'), 'utf-8');
    expect(src).toContain("import { warnIfBunVersionDrifts } from './check-bun-version.mjs'");
    expect(src).toMatch(/async function main\(\) \{[\s\S]*?warnIfBunVersionDrifts\(\);[\s\S]*?parseArgs/);
  });
});
