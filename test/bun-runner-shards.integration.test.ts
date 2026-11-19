import { afterEach, describe, expect, it } from 'vitest';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnTsScript } from './helpers/ts-runner.js';
import { mergeBunShardReports } from '../scripts/merge-bun-test-timings.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const temporary: string[] = [];
afterEach(() => { for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function fixture(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), 'bun-shard-fixture-'));
  temporary.push(dir);
  mkdirSync(join(dir, 'scripts'));
  mkdirSync(join(dir, 'test/helpers'), { recursive: true });
  for (const file of ['run-bun-tests.mjs', 'bun-test-shards.mjs', 'duration-shards.mjs', 'test-concurrency.mjs', 'merge-bun-test-timings.mjs']) {
    copyFileSync(join(ROOT, 'scripts', file), join(dir, 'scripts', file));
  }
  copyFileSync(join(ROOT, 'test/helpers/bun-leg-selectors.ts'), join(dir, 'test/helpers/bun-leg-selectors.ts'));
  symlinkSync(join(ROOT, 'node_modules'), join(dir, 'node_modules'), 'junction');
  writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
  for (const [file, source] of Object.entries(files)) {
    mkdirSync(join(dir, file, '..'), { recursive: true });
    writeFileSync(join(dir, file), source);
  }
  return dir;
}

const passing = `import { test, expect } from 'bun:test'; test('passes', () => expect(1).toBe(1));`;

function launch(dir: string, args: string[], script = 'run-bun-tests.mjs') {
  const child = spawnTsScript(join(dir, 'scripts', script), args, {
    cwd: dir, stdio: ['ignore', 'pipe', 'pipe'],
    // This fixture has a handful of pure files. CI avoids nesting the local
    // whole-machine test slot while exercising the runner inside a unit test.
    env: {
      ...process.env, CI: 'true', BOTMUX_BUN_TEST_CONCURRENCY: '2',
      GITHUB_SHA: 'fixture-revision', GITHUB_RUN_ID: dir,
    },
  });
  let output = '';
  child.stdout!.on('data', data => { output += data.toString(); });
  child.stderr!.on('data', data => { output += data.toString(); });
  const completed = new Promise<{ code: number | null; output: string }>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', code => resolve({ code, output }));
  });
  return { child, completed };
}

describe('real Bun runner shard execution', () => {
  it('runs every eligible file once and writes real per-process durations', async () => {
    const files = Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`test/pass-${i}.test.ts`, passing]));
    files['test/nested/example.spec.ts'] = passing;
    files['test/ignored.e2e.ts'] = 'throw new Error("e2e must not run")';
    files['test/e2e-browser/ignored.test.ts'] = 'throw new Error("browser must not run")';
    files['test/deferred.test.ts'] = "import { vi } from 'vitest'; vi." + "resetModules(); throw new Error('deferred must not run');";
    const dir = fixture(files);
    const reports = [];
    for (const index of [1, 2, 3, 4]) {
      const output = join(dir, `bun-shard-${index}.json`);
      const result = await launch(dir, [`--shard=${index}/4`, `--timings-output=${output}`]).completed;
      expect(result.code, result.output).toBe(0);
      reports.push(JSON.parse(readFileSync(output, 'utf8')));
    }
    const table = mergeBunShardReports(reports, 4);
    expect(Object.keys(table.files).sort()).toEqual(Object.keys(files).filter(file => file.includes('pass-') || file.includes('nested')).sort());
    expect(Object.values(table.files).every(seconds => seconds > 0)).toBe(true);
    const mergedOutput = join(dir, 'merged.json');
    const merged = await launch(dir, [dir, '--shards=4', `--output=${mergedOutput}`], 'merge-bun-test-timings.mjs').completed;
    expect(merged.code, merged.output).toBe(0);
    expect(JSON.parse(readFileSync(mergedOutput, 'utf8'))).toEqual(table);
    symlinkSync(join(dir, 'scripts/merge-bun-test-timings.mjs'), join(dir, 'scripts/merge-link.mjs'));
    const linkedOutput = join(dir, 'merged-link.json');
    const viaLink = await launch(dir, [dir, '--shards=4', `--output=${linkedOutput}`], 'merge-link.mjs').completed;
    expect(viaLink.code, viaLink.output).toBe(0);
    expect(JSON.parse(readFileSync(linkedOutput, 'utf8'))).toEqual(table);
  });

  it('records failing and zero-test files without turning them into green evidence', async () => {
    const dir = fixture({
      'test/pass.test.ts': passing,
      'test/fail.test.ts': `import { test, expect } from 'bun:test'; test('fails', () => expect(1).toBe(2));`,
      'test/empty.test.ts': 'export {};',
    });
    const output = join(dir, 'bun-shard-1.json');
    const result = await launch(dir, [`--timings-output=${output}`]).completed;
    expect(result.code).toBe(1);
    const report = JSON.parse(readFileSync(output, 'utf8'));
    expect(report.complete).toBe(true);
    expect(report.files).toHaveLength(3);
    expect(report.files.filter((file: { ok: boolean }) => !file.ok)).toHaveLength(2);
    expect(() => mergeBunShardReports([report], 1)).toThrow(/failing/);
    const mergedOutput = join(dir, 'previous.json');
    writeFileSync(mergedOutput, '{"previous":"timings"}');
    symlinkSync(join(dir, 'scripts/merge-bun-test-timings.mjs'), join(dir, 'scripts/merge-link.mjs'));
    const merged = await launch(dir, [dir, '--shards=1', `--output=${mergedOutput}`], 'merge-link.mjs').completed;
    expect(merged.code).toBe(1);
    expect(JSON.parse(readFileSync(mergedOutput, 'utf8'))).toEqual({ previous: 'timings' });
  });

  it('keeps completed-file timings after cancellation and leaves the report incomplete', async () => {
    const dir = fixture({
      'test/a.test.ts': passing,
      'test/b.test.ts': `import { test } from 'bun:test'; test('waiting', async () => { await new Promise(r => setTimeout(r, 30000)); });`,
    });
    const output = join(dir, 'bun-shard-1.json');
    const running = launch(dir, [`--timings-output=${output}`]);
    try {
      const deadline = Date.now() + 10_000;
      while (!existsSync(output) || JSON.parse(readFileSync(output, 'utf8')).files.length === 0) {
        if (Date.now() > deadline) throw new Error('first file did not finish before cancellation');
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      running.child.kill('SIGTERM');
      const result = await running.completed;
      expect(result.code).not.toBe(0);
      const report = JSON.parse(readFileSync(output, 'utf8'));
      expect(report.complete).toBe(false);
      expect(report.files.some((file: { file: string }) => file.file === 'test/a.test.ts')).toBe(true);
      expect(() => mergeBunShardReports([report], 1)).toThrow(/incomplete/);
    } finally {
      running.child.kill('SIGTERM');
      await running.completed;
    }
  });

  it('refuses to call an empty shard a green run and leaves its report incomplete', async () => {
    const dir = fixture({
      'test/a.test.ts': passing,
      'test/b.test.ts': passing,
    });
    const output = join(dir, 'bun-shard-3.json');
    const result = await launch(dir, ['--shard=3/4', `--timings-output=${output}`]).completed;
    expect(result.code, result.output).toBe(1);
    expect(result.output).toContain('contains no runnable files');
    const report = JSON.parse(readFileSync(output, 'utf8'));
    expect(report.complete).toBe(false);
    expect(report.plannedCount).toBe(0);
    expect(report.files).toEqual([]);
  });

  it('fails closed on a truncated timing report without writing merge output', async () => {
    const dir = fixture({ 'test/pass.test.ts': passing });
    const artifactDir = join(dir, 'artifacts');
    mkdirSync(artifactDir, { recursive: true });
    writeFileSync(join(artifactDir, 'bun-shard-1.json'), '{"complete": true, "files": [');
    const output = join(artifactDir, 'merged.json');
    const result = await launch(dir, [artifactDir, '--shards=1', `--output=${output}`], 'merge-bun-test-timings.mjs').completed;
    expect(result.code, result.output).toBe(1);
    expect(existsSync(output)).toBe(false);
  });

  it('invalidates old successful evidence before selector startup can fail', async () => {
    const dir = fixture({ 'test/pass.test.ts': passing });
    const output = join(dir, 'bun-shard-1.json');
    const passed = await launch(dir, [`--timings-output=${output}`]).completed;
    expect(passed.code, passed.output).toBe(0);
    expect(JSON.parse(readFileSync(output, 'utf8')).complete).toBe(true);
    writeFileSync(join(dir, 'test/helpers/bun-leg-selectors.ts'), 'throw new Error("selector startup failed");');
    const failed = await launch(dir, [`--timings-output=${output}`]).completed;
    expect(failed.code).toBe(1);
    const report = JSON.parse(readFileSync(output, 'utf8'));
    expect(report.complete).toBe(false);
    expect(report.files).toEqual([]);
    expect(() => mergeBunShardReports([report], 1)).toThrow(/incomplete/);
  });
});
